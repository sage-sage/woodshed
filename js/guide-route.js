const WSA1_MAGIC_0 = 0x57; // 'W'
const WSA1_MAGIC_1 = 0x53; // 'S'
const WSA1_MAGIC_2 = 0x41; // 'A'
const WSA1_MAGIC_3 = 0x31; // '1'
const WSA1_HEADER_BYTES = 16;

const CAPTURE_WORKLET_CODE = `
class WoodshedGuideCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.active === 'boolean') {
        this.active = e.data.active;
      }
    };
  }

  process(inputs) {
    if (!this.active) return true;
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return true;
    const block = new Float32Array(ch);
    this.port.postMessage(block, [block.buffer]);
    return true;
  }
}
registerProcessor('woodshed-guide-capture', WoodshedGuideCaptureProcessor);
`;

function computeLatencySec(amp) {
  const rawMs = Number(amp?.status?.guide?.latencyMs);
  const latencyMs = Number.isFinite(rawMs) && rawMs >= 0 ? rawMs : 40;
  return latencyMs / 1000 + 0.004;
}

export function startGuideRouting(ctx) {
  const { amp, synth, settings } = ctx || {};
  const audioCtx = synth?.ctx;

  let stopped = false;
  let active = false;
  let currentLatencySec = 0;
  let workletNode = null;
  let silentGain = null;
  let workletPromise = null;

  const sampleRate = Math.max(8000, Math.round(Number(audioCtx?.sampleRate) || 48000));
  const packetSamples = Math.max(128, Math.round(sampleRate * 0.01));
  let staging = new Float32Array(packetSamples + 4096);
  let stagedCount = 0;
  let frameIndex = 0;

  function shouldBeRouted() {
    return Boolean(
      !stopped &&
      amp &&
      synth &&
      audioCtx &&
      settings?.get('guideThroughAmp') !== false &&
      amp.state === 'online' &&
      amp.supportsGuide
    );
  }

  function flushPackets() {
    while (stagedCount >= packetSamples) {
      const packet = new ArrayBuffer(WSA1_HEADER_BYTES + packetSamples * 2);
      const view = new DataView(packet);
      view.setUint8(0, WSA1_MAGIC_0);
      view.setUint8(1, WSA1_MAGIC_1);
      view.setUint8(2, WSA1_MAGIC_2);
      view.setUint8(3, WSA1_MAGIC_3);
      view.setUint32(4, sampleRate, true);
      view.setUint32(8, frameIndex, true);
      view.setUint32(12, packetSamples, true);

      for (let i = 0; i < packetSamples; i++) {
        const s = staging[i];
        const clamped = s < -1 ? -1 : (s > 1 ? 1 : s);
        const pcm = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
        view.setInt16(WSA1_HEADER_BYTES + i * 2, pcm, true);
      }

      frameIndex = (frameIndex + packetSamples) >>> 0;
      const remaining = stagedCount - packetSamples;
      if (remaining > 0) {
        staging.copyWithin(0, packetSamples, stagedCount);
      }
      stagedCount = remaining;

      if (active && amp.state === 'online' && amp.supportsGuide) {
        amp.sendBinary(packet);
      }
    }
  }

  function onCaptureBlock(block) {
    if (!active || stopped || !(block instanceof Float32Array) || block.length === 0) return;
    if (stagedCount + block.length > staging.length) {
      const grown = new Float32Array(stagedCount + block.length + packetSamples);
      grown.set(staging.subarray(0, stagedCount), 0);
      staging = grown;
    }
    staging.set(block, stagedCount);
    stagedCount += block.length;
    flushPackets();
  }

  function ensureWorklet() {
    if (workletNode) return Promise.resolve(workletNode);
    if (workletPromise) return workletPromise;
    if (
      !audioCtx?.audioWorklet ||
      typeof AudioWorkletNode === 'undefined' ||
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return Promise.resolve(null);
    }

    workletPromise = (async () => {
      let blobUrl = null;
      try {
        const blob = new Blob([CAPTURE_WORKLET_CODE], { type: 'application/javascript' });
        blobUrl = URL.createObjectURL(blob);
        await audioCtx.audioWorklet.addModule(blobUrl);
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;

        if (stopped) return null;
        const node = new AudioWorkletNode(audioCtx, 'woodshed-guide-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit'
        });
        node.port.onmessage = (e) => onCaptureBlock(e.data);

        const sink = audioCtx.createGain();
        sink.gain.value = 0;
        node.connect(sink);
        sink.connect(audioCtx.destination);

        workletNode = node;
        silentGain = sink;
        return node;
      } catch (_) {
        if (blobUrl) {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch (__) {
            // Ignore
          }
        }
        return null;
      } finally {
        workletPromise = null;
      }
    })();

    return workletPromise;
  }

  function disengage(notifyAmp = true) {
    if (!active) return;
    active = false;
    stagedCount = 0;
    if (workletNode) {
      try {
        workletNode.port.postMessage({ type: 'active', active: false });
      } catch (_) {
        // Ignore
      }
    }
    synth?.setAmpRoute(null);
    if (notifyAmp) {
      amp?.stopGuide();
    }
  }

  async function evaluate() {
    if (!shouldBeRouted()) {
      disengage(true);
      return;
    }

    if (active && workletNode) {
      const nextLatency = computeLatencySec(amp);
      if (Math.abs(nextLatency - currentLatencySec) > 1e-6) {
        currentLatencySec = nextLatency;
        synth.setAmpRoute({ capture: workletNode, latencySec: currentLatencySec });
      }
      return;
    }

    const node = await ensureWorklet();
    if (!node || !shouldBeRouted()) {
      disengage(true);
      return;
    }
    if (active) return;

    stagedCount = 0;
    frameIndex = 0;
    active = true;
    currentLatencySec = computeLatencySec(amp);
    node.port.postMessage({ type: 'active', active: true });
    synth.setAmpRoute({ capture: node, latencySec: currentLatencySec });
    amp.startGuide(sampleRate);
  }

  const onReevaluate = () => {
    evaluate();
  };

  amp?.addEventListener('state', onReevaluate);
  amp?.addEventListener('status', onReevaluate);
  amp?.addEventListener('hello', onReevaluate);
  if (typeof window !== 'undefined') {
    window.addEventListener('woodshed:settings-changed', onReevaluate);
  }

  evaluate();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      amp?.removeEventListener('state', onReevaluate);
      amp?.removeEventListener('status', onReevaluate);
      amp?.removeEventListener('hello', onReevaluate);
      if (typeof window !== 'undefined') {
        window.removeEventListener('woodshed:settings-changed', onReevaluate);
      }
      disengage(true);
      if (workletNode) {
        try {
          workletNode.disconnect();
        } catch (_) {
          // Ignore
        }
        workletNode = null;
      }
      if (silentGain) {
        try {
          silentGain.disconnect();
        } catch (_) {
          // Ignore
        }
        silentGain = null;
      }
    }
  };
}
