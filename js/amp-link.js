const WSA1_MAGIC_0 = 0x57; // 'W'
const WSA1_MAGIC_1 = 0x53; // 'S'
const WSA1_MAGIC_2 = 0x41; // 'A'
const WSA1_MAGIC_3 = 0x31; // '1'
const WSA1_HEADER_BYTES = 16;

/**
 * Decode a binary WSA1 audio packet from Woodshed Amp (the dry guitar signal, mono):
 *   0..3   : "WSA1"
 *   4..7   : uint32 LE sampleRate
 *   8..11  : uint32 LE frameIndex (running count of samples sent; gaps mean the app dropped audio)
 *   12..15 : uint32 LE count (number of samples that follow)
 *   16..   : int16 LE mono PCM samples
 * Returns { sampleRate, channels: 1, frames, seq: frameIndex, mono: Float32Array } or null when invalid.
 */
export function decodeAudioFrame(input) {
  if (!input) return null;
  let buffer;
  let byteOffset = 0;
  let byteLength = 0;
  if (input instanceof ArrayBuffer) {
    buffer = input;
    byteLength = input.byteLength;
  } else if (ArrayBuffer.isView(input)) {
    buffer = input.buffer;
    byteOffset = input.byteOffset;
    byteLength = input.byteLength;
  } else {
    return null;
  }
  if (byteLength < WSA1_HEADER_BYTES) return null;

  const view = new DataView(buffer, byteOffset, byteLength);
  if (
    view.getUint8(0) !== WSA1_MAGIC_0 ||
    view.getUint8(1) !== WSA1_MAGIC_1 ||
    view.getUint8(2) !== WSA1_MAGIC_2 ||
    view.getUint8(3) !== WSA1_MAGIC_3
  ) {
    return null;
  }
  const sampleRate = view.getUint32(4, true);
  const frameIndex = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  if (sampleRate < 8000 || sampleRate > 384000) return null;
  if (count === 0 || WSA1_HEADER_BYTES + count * 2 > byteLength) return null;

  const mono = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    mono[i] = view.getInt16(WSA1_HEADER_BYTES + i * 2, true) / 32768;
  }
  return { sampleRate, channels: 1, frames: count, seq: frameIndex, mono };
}

export class JitterBuffer {
  constructor({ outputRate = 48000, targetMs = 12, minMs = 4, maxMs = 30 } = {}) {
    this.outputRate = outputRate;
    this.targetMs = targetMs;
    this.minMs = minMs;
    this.maxMs = maxMs;

    this.capacity = Math.max(4096, Math.ceil(outputRate * 0.25));
    this.ring = new Float32Array(this.capacity);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.bufferedFrames = 0;
    this.primed = false;

    this._resamplePos = 0;
    this._hasLastSample = false;
    this._lastInputSample = 0;
    this._lastOutputSample = 0;

    this.droppedFrames = 0;
    this.insertedFrames = 0;
    this.underruns = 0;
  }

  get targetFrames() {
    return Math.max(1, Math.round((this.outputRate * this.targetMs) / 1000));
  }

  get minFrames() {
    return Math.max(1, Math.round((this.outputRate * this.minMs) / 1000));
  }

  get maxFrames() {
    return Math.max(this.targetFrames + 1, Math.round((this.outputRate * this.maxMs) / 1000));
  }

  get latencyMs() {
    return this.outputRate > 0 ? (this.bufferedFrames / this.outputRate) * 1000 : 0;
  }

  reset() {
    this.readIdx = 0;
    this.writeIdx = 0;
    this.bufferedFrames = 0;
    this.primed = false;
    this._resamplePos = 0;
    this._hasLastSample = false;
    this._lastInputSample = 0;
    this._lastOutputSample = 0;
    this._readFrac = 0;
    this._ratio = 1;
    this._integ = 0;
  }

  _writeSample(v) {
    if (this.bufferedFrames >= this.capacity) {
      this.readIdx = (this.readIdx + 1) % this.capacity;
      this.bufferedFrames--;
      this.droppedFrames++;
    }
    this.ring[this.writeIdx] = v;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    this.bufferedFrames++;
  }

  _dropOldest(count) {
    const n = Math.min(count, this.bufferedFrames);
    if (n <= 0) return;
    this.readIdx = (this.readIdx + n) % this.capacity;
    this.bufferedFrames -= n;
    this.droppedFrames += n;
  }

  push(samples, inputRate = this.outputRate) {
    if (!samples || samples.length === 0) return;
    const rate = inputRate > 0 ? inputRate : this.outputRate;

    if (rate === this.outputRate) {
      for (let i = 0; i < samples.length; i++) {
        this._writeSample(samples[i]);
      }
      this._lastInputSample = samples[samples.length - 1];
      this._hasLastSample = true;
      this._resamplePos = 0;
    } else {
      const step = rate / this.outputRate;
      const len = samples.length;
      let pos = this._hasLastSample ? this._resamplePos : 0;

      while (pos < len - 1) {
        let val;
        if (pos < 0) {
          const frac = pos + 1;
          val = this._lastInputSample * (1 - frac) + samples[0] * frac;
        } else {
          const idx = Math.floor(pos);
          const frac = pos - idx;
          val = samples[idx] * (1 - frac) + samples[idx + 1] * frac;
        }
        this._writeSample(val);
        pos += step;
      }

      this._lastInputSample = samples[len - 1];
      this._hasLastSample = true;
      this._resamplePos = pos - len;
    }

    if (!this.primed && this.bufferedFrames >= this.targetFrames) {
      this.primed = true;
    }

    if (this.bufferedFrames > this.maxFrames) {
      this._dropOldest(this.bufferedFrames - this.targetFrames);
    }
  }

  pull(out) {
    const needed = out.length;
    if (!this.primed) {
      out.fill(0);
      return 0;
    }

    // Proactive low-water insertion: keep buffer depth inside [minMs, maxMs]
    if (this.bufferedFrames > 0 && this.bufferedFrames < this.minFrames) {
      const padCount = Math.max(0, this.targetFrames - this.bufferedFrames);
      const hold = this._lastOutputSample;
      for (let i = 0; i < padCount; i++) {
        const fade = Math.max(0, 1 - (i + 1) / (padCount + 1));
        this._writeSample(hold * fade);
      }
      this.insertedFrames += padCount;
    }

    if (this.bufferedFrames === 0) {
      out.fill(0);
      this.underruns++;
      this.primed = false;
      return 0;
    }

    // Clock drift: the interface and this audio device each run on their own clock, so the buffer would
    // slowly fill (or drain) and the delay creep up. Read slightly faster or slower (at most +-0.5%,
    // inaudible) to hold the buffer at its target instead of letting it climb to maxMs and get trimmed.
    const err = (this.bufferedFrames - this.targetFrames) / this.targetFrames;
    // PI control: the slow integral learns the steady clock offset so the buffer settles ON its target
    // (a proportional term alone would sit several ms above it for a constant drift).
    this._integ = Math.max(-0.005, Math.min(0.005, (this._integ || 0) + 0.00002 * err));
    const wanted = 1 + Math.max(-0.005, Math.min(0.005, 0.004 * err + this._integ));
    this._ratio = (this._ratio || 1) + 0.05 * (wanted - (this._ratio || 1));
    const step = this._ratio;
    let frac = this._readFrac || 0;
    let avail = 0;
    for (let i = 0; i < needed; i++) {
      if (this.bufferedFrames < 2) break;
      const a = this.ring[this.readIdx];
      const b = this.ring[(this.readIdx + 1) % this.capacity];
      const s = a + (b - a) * frac;
      out[i] = s;
      this._lastOutputSample = s;
      avail++;
      frac += step;
      while (frac >= 1 && this.bufferedFrames > 1) {
        frac -= 1;
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.bufferedFrames--;
      }
    }
    this._readFrac = frac;

    if (avail < needed) {
      const missing = needed - avail;
      for (let i = avail; i < needed; i++) {
        out[i] = 0;
      }
      this.insertedFrames += missing;
      this.underruns++;
      this.primed = false;
    }

    return avail;
  }
}

const WORKLET_CODE = `
${JitterBuffer.toString()}
class WoodshedAmpWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.jb = new JitterBuffer({ outputRate: sampleRate, targetMs: 12, minMs: 4, maxMs: 30 });
    this.tick = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'push' && msg.samples) {
        this.jb.push(msg.samples, msg.sampleRate || sampleRate);
      } else if (msg.type === 'reset') {
        this.jb.reset();
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0]?.[0];
    if (out) {
      this.jb.pull(out);
    }
    this.tick++;
    if (this.tick % 8 === 0) {
      this.port.postMessage({
        type: 'metrics',
        bufferedFrames: this.jb.bufferedFrames,
        outputRate: sampleRate
      });
    }
    return true;
  }
}
registerProcessor('woodshed-amp-worklet', WoodshedAmpWorkletProcessor);
`;

export class AmpLink extends EventTarget {
  constructor({ url = 'ws://127.0.0.1:47800/ws' } = {}) {
    super();
    this.url = url;
    this.state = 'offline';
    this.status = null;
    this.presets = { current: null, list: [] };
    this.devices = { current: null, list: [], outputs: [], monitorOutput: '' };
    this.serverInfo = null;

    this.ampSource = null;
    this.jitterBuffer = new JitterBuffer();

    this._ws = null;
    this._shouldReconnect = false;
    this._backoffMs = 1000;
    this._reconnectTimer = null;
    this._hiddenSince = null;
    this._pausedForHidden = false;
    this._visBound = false;

    this._audioCtx = null;
    this._audioInitPromise = null;
    this._workletNode = null;
    this._scriptNode = null;
    this._useWorklet = false;

    this._onVisibilityChange = this._handleVisibilityChange.bind(this);
  }

  get streamLatencyMs() {
    return this.state === 'online' ? this.jitterBuffer.latencyMs : 0;
  }

  _setState(nextState) {
    if (this.state === nextState) return;
    this.state = nextState;
    this.dispatchEvent(new CustomEvent('state', { detail: { state: nextState } }));
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  _bindVisibility() {
    if (this._visBound || typeof document === 'undefined') return;
    this._visBound = true;
    this._hiddenSince = document.hidden ? Date.now() : null;
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  _handleVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      if (!this._hiddenSince) this._hiddenSince = Date.now();
    } else {
      this._hiddenSince = null;
      if (this._pausedForHidden && this._shouldReconnect && this.state === 'offline') {
        this._pausedForHidden = false;
        this._openSocket();
      }
    }
  }

  connect() {
    this._shouldReconnect = true;
    this._bindVisibility();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) {
      return;
    }
    this._openSocket();
  }

  disconnect() {
    this._shouldReconnect = false;
    this._pausedForHidden = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch (_) {
        // Ignore
      }
      this._ws = null;
    }
    this.jitterBuffer.reset();
    this._setState('offline');
  }

  _openSocket() {
    if (typeof WebSocket === 'undefined') return;
    if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) return;

    this._setState('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._setState('offline');
      this._scheduleReconnect();
      return;
    }

    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      if (this._ws !== ws) return;
      this._backoffMs = 1000;
      this._pausedForHidden = false;
      this.jitterBuffer.reset();
      if (this._workletNode) {
        this._workletNode.port.postMessage({ type: 'reset' });
      }
      this._setState('online');
      this._send({ type: 'hello', client: 'woodshed', version: 1 });
      this._send({ type: 'stream', on: true });
    };

    ws.onmessage = (event) => {
      if (this._ws !== ws) return;
      if (typeof event.data === 'string') {
        this._handleTextMessage(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this._handleBinaryMessage(event.data);
      }
    };

    ws.onerror = () => {
      // Close event handles state transition and reconnect backoff
    };

    ws.onclose = () => {
      if (this._ws !== ws) return;
      this._ws = null;
      this.jitterBuffer.reset();
      this._setState('offline');
      if (this._shouldReconnect) {
        this._scheduleReconnect();
      }
    };
  }

  _scheduleReconnect() {
    if (!this._shouldReconnect || this._reconnectTimer) return;
    const delay = this._backoffMs;
    this._backoffMs = Math.min(10000, this._backoffMs * 2);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._shouldReconnect || this.state !== 'offline') return;
      if (
        typeof document !== 'undefined' &&
        document.hidden &&
        this._hiddenSince &&
        Date.now() - this._hiddenSince > 60000
      ) {
        this._pausedForHidden = true;
        return;
      }
      this._openSocket();
    }, delay);
  }

  _handleTextMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      this.serverInfo = msg;
    } else if (msg.type === 'status') {
      this.status = msg;
      this._emit('status', msg);
    } else if (msg.type === 'presets') {
      this.presets = {
        current: msg.current ?? null,
        list: Array.isArray(msg.list) ? msg.list : [],
        // Woodshed Amp 2.1+ pedalboard: the effect catalog and the board limits.
        blockTypes: Array.isArray(msg.blockTypes) ? msg.blockTypes : null,
        limits: msg.limits || null
      };
      this._emit('presets', this.presets);
    } else if (msg.type === 'nodeAdded' || msg.type === 'presetCreated' || msg.type === 'presetExportData') {
      // Replies to this page's own requests (Woodshed Amp 2.2+ pedalboard), matched by requestId.
      this._emit(msg.type, msg);
    } else if (msg.type === 'devices') {
      this.devices = {
        current: typeof msg.current === 'string' ? msg.current : (msg.current ?? null),
        list: Array.isArray(msg.list) ? msg.list.filter((d) => typeof d === 'string') : [],
        outputs: Array.isArray(msg.outputs) ? msg.outputs.filter((d) => typeof d === 'string') : [],
        monitorOutput: typeof msg.monitorOutput === 'string' ? msg.monitorOutput : '',
        monitorExclusive: msg.monitorExclusive === true,
        bufferSizes: Array.isArray(msg.bufferSizes)
          ? msg.bufferSizes.filter((n) => Number.isInteger(n) && n > 0 && n <= 4096)
          : []
      };
      this._emit('devices', this.devices);
    } else if (msg.type === 'error') {
      this._emit('error', { message: msg.message || 'Woodshed Amp error' });
    }
  }

  _handleBinaryMessage(arrayBuffer) {
    const frame = decodeAudioFrame(arrayBuffer);
    if (!frame) return;

    if (this._useWorklet && this._workletNode) {
      const copy = new Float32Array(frame.mono);
      this._workletNode.port.postMessage(
        { type: 'push', samples: copy, sampleRate: frame.sampleRate },
        [copy.buffer]
      );
    } else {
      this.jitterBuffer.push(frame.mono, frame.sampleRate);
    }
  }

  initAudio(audioContext) {
    if (!audioContext) return null;
    if (!this.ampSource || this._audioCtx !== audioContext) {
      this._audioCtx = audioContext;
      this.ampSource = audioContext.createGain();
      this.ampSource.gain.value = 1.0;
      this.jitterBuffer = new JitterBuffer({
        outputRate: audioContext.sampleRate,
        targetMs: 12,
        minMs: 4,
        maxMs: 30
      });
      this._audioInitPromise = this._setupOutputNode(audioContext);
    }
    return this.ampSource;
  }

  async _setupOutputNode(audioContext) {
    if (
      audioContext.audioWorklet &&
      typeof AudioWorkletNode !== 'undefined' &&
      typeof Blob !== 'undefined' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function'
    ) {
      let blobUrl = null;
      try {
        const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
        blobUrl = URL.createObjectURL(blob);
        await audioContext.audioWorklet.addModule(blobUrl);
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;

        if (this._audioCtx !== audioContext) return;
        const node = new AudioWorkletNode(audioContext, 'woodshed-amp-worklet', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1]
        });
        node.port.onmessage = (e) => {
          if (e.data?.type === 'metrics') {
            this.jitterBuffer.bufferedFrames = e.data.bufferedFrames;
            this.jitterBuffer.outputRate = e.data.outputRate;
          }
        };
        node.connect(this.ampSource);
        this._workletNode = node;
        this._useWorklet = true;
        return;
      } catch (_) {
        if (blobUrl) {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch (__) {
            // Ignore
          }
        }
      }
    }

    // Fallback: ScriptProcessorNode(1024) when AudioWorklet or Blob URLs are blocked
    if (typeof audioContext.createScriptProcessor === 'function') {
      const sp = audioContext.createScriptProcessor(1024, 0, 1);
      sp.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        this.jitterBuffer.pull(out);
      };
      sp.connect(this.ampSource);
      this._scriptNode = sp;
      this._useWorklet = false;
    }
  }

  _send(payload) {
    if (!this._ws || this._ws.readyState !== 1) return false;
    try {
      this._ws.send(JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }

  setPreset(id) {
    return this._send({ type: 'preset', id: String(id) });
  }

  setParam(id, key, value) {
    return this._send({ type: 'param', id: String(id), key: String(key), value: Number(value) });
  }

  resetPreset(id) {
    return this._send({ type: 'resetPreset', id: String(id) });
  }

  browse(id, kind, uid) {
    return this._send({ type: 'browse', id: String(id), kind: String(kind), ...(uid != null ? { uid: String(uid) } : {}) });
  }

  clearFile(id, kind, uid) {
    return this._send({ type: 'clearFile', id: String(id), kind: String(kind), ...(uid != null ? { uid: String(uid) } : {}) });
  }

  setBlockParam(id, uid, key, value) {
    return this._send({ type: 'blockParam', id: String(id), uid: String(uid), key: String(key), value: Number(value) });
  }

  setBlockEnabled(id, uid, on) {
    return this._send({ type: 'blockEnable', id: String(id), uid: String(uid), on: Boolean(on) });
  }

  addBlock(id, blockType, index) {
    const msg = { type: 'blockAdd', id: String(id), blockType: String(blockType) };
    if (Number.isFinite(index)) msg.index = Number(index);
    return this._send(msg);
  }

  removeBlock(id, uid) {
    return this._send({ type: 'blockRemove', id: String(id), uid: String(uid) });
  }

  moveBlock(id, uid, index) {
    return this._send({ type: 'blockMove', id: String(id), uid: String(uid), index: Number(index) });
  }

  // ---- Woodshed Amp 2.2+: 2D pedalboard graph and custom presets (see the protocol in woodshed-amp) ----
  _request(payload) {
    const requestId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    this._send({ ...payload, requestId });
    return requestId;
  }

  /** Resolves with the reply of `type` carrying our requestId, or null after `timeoutMs`. */
  request(payload, type, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const requestId = this._request(payload);
      const onReply = (e) => {
        if (e.detail?.requestId !== requestId) return;
        clearTimeout(timer);
        this.removeEventListener(type, onReply);
        resolve(e.detail);
      };
      const timer = setTimeout(() => { this.removeEventListener(type, onReply); resolve(null); }, timeoutMs);
      this.addEventListener(type, onReply);
    });
  }

  addNode(id, nodeType, x, y, splice) {
    return this.request({ type: 'nodeAdd', id: String(id), nodeType: String(nodeType), x: Number(x), y: Number(y), ...(splice ? { splice } : {}) }, 'nodeAdded');
  }

  moveNode(id, uid, x, y) {
    return this._send({ type: 'nodeMove', id: String(id), uid: String(uid), x: Number(x), y: Number(y) });
  }

  removeNode(id, uid, heal = true) {
    return this._send({ type: 'nodeRemove', id: String(id), uid: String(uid), heal: Boolean(heal) });
  }

  addCable(id, from, to, port = 0) {
    return this._send({ type: 'cableAdd', id: String(id), from: String(from), to: String(to), port: Number(port) });
  }

  removeCable(id, from, to, port = 0) {
    return this._send({ type: 'cableRemove', id: String(id), from: String(from), to: String(to), port: Number(port) });
  }

  newPreset(name) {
    return this.request({ type: 'presetNew', name: String(name || 'My preset') }, 'presetCreated');
  }

  duplicatePreset(id, name) {
    return this.request({ type: 'presetDuplicate', id: String(id), ...(name ? { name: String(name) } : {}) }, 'presetCreated');
  }

  renamePreset(id, name) {
    return this._send({ type: 'presetRename', id: String(id), name: String(name) });
  }

  deletePreset(id) {
    return this._send({ type: 'presetDelete', id: String(id) });
  }

  importPreset(preset) {
    return this.request({ type: 'presetImport', preset }, 'presetCreated');
  }

  exportPreset(id) {
    return this.request({ type: 'presetExport', id: String(id) }, 'presetExportData');
  }

  setBoardGlobal(id, key, value) {
    return this._send({ type: 'boardGlobal', id: String(id), key: String(key), value: Number(value) });
  }

  setBypass(on) {
    return this._send({ type: 'bypass', on: Boolean(on) });
  }

  setMute(on) {
    return this._send({ type: 'mute', on: Boolean(on) });
  }

  setDevice(obj = {}) {
    return this._send({ type: 'device', ...obj });
  }

  setMonitorOutput(name, exclusive = this.devices?.monitorExclusive === true) {
    return this._send({ type: 'monitorOutput', name: String(name || ''), exclusive: Boolean(exclusive) });
  }

  openAsioPanel() {
    return this._send({ type: 'asioPanel' });
  }

  setStreaming(on) {
    return this._send({ type: 'stream', on: Boolean(on) });
  }
}
