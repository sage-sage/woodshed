import { getAudioContext, getMasterGain, resumeAudio } from './audio-context.js';
import { detectPitch, notePresence, OnsetDetector, midiToFreq, freqToMidi } from './dsp.js';

export class GuitarInput extends EventTarget {
  constructor() {
    super();
    this.state = 'idle';
    this.stream = null;
    this.mediaSource = null;
    this.splitter = null;
    this.channelGainLeft = null;
    this.channelGainRight = null;
    this.inputBus = null;
    this.analyser = null;
    this.monitorGainNode = null;
    this.externalSources = new Set();
    this.ampNode = null;

    this.channel = 'mix';
    this.deviceId = '';
    this.monitorOn = false;
    this.monitorGainVal = 0.75;
    this.a4 = 440;

    this.lowestMidi = 40;
    this.highestMidi = 88;
    this.minHz = midiToFreq(38, 440);
    this.maxHz = midiToFreq(90, 440);

    this.buf = new Float32Array(8192);
    this.onsetDetector = new OnsetDetector();
    this.smoothedLevel = 0;

    this._lastFrameTime = -1;
    this._cachedReading = null;
    this._onTrackEnded = this._handleTrackEnded.bind(this);
  }

  get sourceKind() {
    if (this.ampNode) return 'amp';
    if (this.stream) return 'browser';
    return 'none';
  }

  static async listDevices() {
    if (!globalThis.navigator?.mediaDevices?.enumerateDevices) {
      throw new Error('MediaDevices API is not available in this browser.');
    }
    let tempStream = null;
    try {
      const initial = await navigator.mediaDevices.enumerateDevices();
      const hasLabels = initial.some((d) => d.kind === 'audioinput' && d.label);
      if (!hasLabels) {
        tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        throw new Error('Microphone / audio interface permission was denied. Allow audio access in your browser address bar.');
      }
      if (err && err.name === 'NotFoundError') {
        throw new Error('No audio input devices were found. Connect an audio interface or microphone.');
      }
    } finally {
      if (tempStream) {
        for (const tr of tempStream.getTracks()) tr.stop();
      }
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, idx) => ({
        deviceId: d.deviceId,
        label: d.label || `Audio Input ${idx + 1}`
      }));

    if (inputs.length === 0) {
      throw new Error('No audio input devices found. Plug in your audio interface and try again.');
    }
    return inputs;
  }

  _setState(nextState) {
    this.state = nextState;
    this.dispatchEvent(new CustomEvent('state', { detail: { state: nextState } }));
  }

  _emitError(message, originalError = null) {
    this._setState('error');
    const err = new Error(message);
    if (originalError) err.cause = originalError;
    this.dispatchEvent(new CustomEvent('error', { detail: { message, error: err } }));
    return err;
  }

  _ensureGraph() {
    const ctx = getAudioContext();
    if (!this.inputBus) {
      this.inputBus = ctx.createGain();
      this.inputBus.gain.value = 1.0;

      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 8192;
      this.analyser.smoothingTimeConstant = 0;

      this.monitorGainNode = ctx.createGain();
      this.monitorGainNode.gain.value = this.monitorOn ? this.monitorGainVal : 0;

      this.inputBus.connect(this.analyser);
      this.inputBus.connect(this.monitorGainNode);
      this.monitorGainNode.connect(getMasterGain());
    }
    return ctx;
  }

  setRange(lowestMidi = 40, highestMidi = 88) {
    this.lowestMidi = Number.isFinite(lowestMidi) ? lowestMidi : 40;
    this.highestMidi = Number.isFinite(highestMidi) ? Math.max(this.lowestMidi + 12, highestMidi) : 88;
    this.minHz = midiToFreq(this.lowestMidi - 2, this.a4);
    this.maxHz = midiToFreq(this.highestMidi + 2, this.a4);
  }

  setA4(a4 = 440) {
    if (Number.isFinite(a4) && a4 >= 415 && a4 <= 466) {
      this.a4 = a4;
      this.setRange(this.lowestMidi, this.highestMidi);
    }
  }

  setChannel(channel = 'mix') {
    this.channel = ['mix', 'left', 'right'].includes(channel) ? channel : 'mix';
    if (!this.channelGainLeft || !this.channelGainRight) return;
    if (this._monoInput) {
      // A one-channel device has nothing to choose from: pass it through at unity whatever is selected.
      this.channelGainLeft.gain.value = 1.0;
      this.channelGainRight.gain.value = 0.0;
      return;
    }
    if (this.channel === 'left') {
      this.channelGainLeft.gain.value = 1.0;
      this.channelGainRight.gain.value = 0.0;
    } else if (this.channel === 'right') {
      this.channelGainLeft.gain.value = 0.0;
      this.channelGainRight.gain.value = 1.0;
    } else {
      this.channelGainLeft.gain.value = 0.7071;
      this.channelGainRight.gain.value = 0.7071;
    }
  }

  setMonitor(on, gain = this.monitorGainVal) {
    this.monitorOn = this.sourceKind === 'amp' ? false : Boolean(on);
    if (Number.isFinite(gain)) {
      this.monitorGainVal = Math.max(0, Math.min(2, gain));
    }
    this._ensureGraph();
    const ctx = getAudioContext();
    this.monitorGainNode.gain.setTargetAtTime(
      this.monitorOn ? this.monitorGainVal : 0,
      ctx.currentTime,
      0.015
    );
  }

  useAmpSource(node) {
    if (node) {
      if (this.ampNode && this.ampNode !== node) {
        this.disconnectSource(this.ampNode);
      }
      this._stopMicNodes();
      this.ampNode = node;
      this.setMonitor(false);
      this.connectSource(node);
      this.onsetDetector.reset();
      this._lastFrameTime = -1;
      this._cachedReading = null;
      if (this.state !== 'live') {
        this._setState('live');
      } else {
        this._setState('live');
      }
      return;
    }

    if (this.ampNode) {
      const prev = this.ampNode;
      this.ampNode = null;
      this.disconnectSource(prev);
    }
    this._lastFrameTime = -1;
    this._cachedReading = null;
    if (!this.stream && this.externalSources.size === 0) {
      this._setState('idle');
    } else {
      this._setState(this.state);
    }
  }

  connectSource(audioNode) {
    if (!audioNode || typeof audioNode.connect !== 'function') return;
    this._ensureGraph();
    audioNode.connect(this.inputBus);
    this.externalSources.add(audioNode);
    if (this.state === 'idle') {
      this._setState('live');
    }
  }

  disconnectSource(audioNode = null) {
    if (!this.inputBus) return;
    if (audioNode) {
      try {
        audioNode.disconnect(this.inputBus);
      } catch (_) {
        // Ignore if already disconnected
      }
      this.externalSources.delete(audioNode);
    } else {
      for (const node of this.externalSources) {
        try {
          node.disconnect(this.inputBus);
        } catch (_) {
          // Ignore
        }
      }
      this.externalSources.clear();
    }
    if (!this.stream && this.externalSources.size === 0 && this.state === 'live') {
      this._setState('idle');
    }
  }

  async start({ deviceId = '', channel = 'mix' } = {}) {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
      throw this._emitError('WebRTC getUserMedia is not supported in this browser.');
    }

    if (this.ampNode) {
      const prev = this.ampNode;
      this.ampNode = null;
      this.disconnectSource(prev);
    }
    this._stopMicNodes();
    this._setState('starting');
    this.deviceId = deviceId || '';
    this.channel = ['mix', 'left', 'right'].includes(channel) ? channel : 'mix';

    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      latency: 0
    };
    if (this.deviceId) {
      audioConstraints.deviceId = { exact: this.deviceId };
    }

    let stream;
    try {
      await resumeAudio();
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (err) {
      if (this.deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        try {
          delete audioConstraints.deviceId;
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        } catch (fallbackErr) {
          throw this._mapMediaError(fallbackErr);
        }
      } else {
        throw this._mapMediaError(err);
      }
    }

    const ctx = this._ensureGraph();
    this.stream = stream;

    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) {
      throw this._emitError('Selected input device provided no audio tracks.');
    }
    for (const track of tracks) {
      track.addEventListener('ended', this._onTrackEnded);
    }

    this.mediaSource = ctx.createMediaStreamSource(stream);
    const detectedChannels = tracks[0].getSettings?.().channelCount || this.mediaSource.channelCount || 1;

    this.splitter = ctx.createChannelSplitter(2);
    this.channelGainLeft = ctx.createGain();
    this.channelGainRight = ctx.createGain();

    this.mediaSource.connect(this.splitter);
    this.splitter.connect(this.channelGainLeft, 0);
    this._monoInput = detectedChannels < 2;
    if (!this._monoInput) {
      this.splitter.connect(this.channelGainRight, 1);
    }

    this.channelGainLeft.connect(this.inputBus);
    this.channelGainRight.connect(this.inputBus);
    this.setChannel(this.channel);

    this.onsetDetector.reset();
    this._lastFrameTime = -1;
    this._cachedReading = null;
    this._setState('live');
    return this;
  }

  _mapMediaError(err) {
    if (!err) return this._emitError('Failed to start audio input.');
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      const pol = globalThis.document && (document.permissionsPolicy || document.featurePolicy);
      const blocked = pol && typeof pol.allowsFeature === 'function' && !pol.allowsFeature('microphone');
      if (blocked) {
        return this._emitError('This page is embedded somewhere that blocks microphone and audio-interface access. Open Woodshed directly at https://sage-sage.github.io/woodshed/ to play with your guitar.', err);
      }
      return this._emitError('Permission denied for audio input. Grant microphone access in your browser settings.', err);
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return this._emitError('No audio input devices found. Connect your guitar interface and try again.', err);
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      return this._emitError('Audio interface is busy or in exclusive use by another application.', err);
    }
    return this._emitError(`Audio input error: ${err.message || err.name}`, err);
  }

  _handleTrackEnded() {
    this._stopMicNodes();
    this._emitError('Audio input device was unplugged or disconnected.');
  }

  _stopMicNodes() {
    if (this.stream) {
      for (const track of this.stream.getAudioTracks()) {
        track.removeEventListener('ended', this._onTrackEnded);
        track.stop();
      }
      this.stream = null;
    }
    for (const node of [this.mediaSource, this.splitter, this.channelGainLeft, this.channelGainRight]) {
      if (node) {
        try {
          node.disconnect();
        } catch (_) {
          // Ignore
        }
      }
    }
    this.mediaSource = null;
    this.splitter = null;
    this.channelGainLeft = null;
    this.channelGainRight = null;
  }

  stop() {
    this._stopMicNodes();
    this._lastFrameTime = -1;
    this._cachedReading = null;
    if (this.externalSources.size === 0) {
      this._setState('idle');
    }
  }

  read() {
    const nowMs = globalThis.performance ? performance.now() : Date.now();
    const t = nowMs / 1000;

    if (this._cachedReading && Math.abs(nowMs - this._lastFrameTime) < 4) {
      return this._cachedReading;
    }

    this._ensureGraph();
    const ctx = getAudioContext();
    const sampleRate = ctx.sampleRate;

    if (this.state !== 'live' && this.externalSources.size === 0) {
      this.buf.fill(0);
      const idleResult = {
        t,
        sampleRate,
        buf: this.buf,
        freq: 0,
        midi: 0,
        clarity: 0,
        rms: 0,
        level: 0,
        onset: false
      };
      this._lastFrameTime = nowMs;
      this._cachedReading = idleResult;
      return idleResult;
    }

    this.analyser.getFloatTimeDomainData(this.buf);

    const pitchWinSize = this.lowestMidi >= 38 ? 2048 : 4096;
    const pitchSlice = this.buf.subarray(this.buf.length - pitchWinSize);
    const { freq, clarity, rms } = detectPitch(pitchSlice, sampleRate, {
      minHz: this.minHz,
      maxHz: this.maxHz
    });

    const midi = freq > 0 ? freqToMidi(freq, this.a4) : 0;

    const onsetSlice = this.buf.subarray(this.buf.length - 1024);
    const onset = this.onsetDetector.process(onsetSlice, t);

    const instLevel = Math.min(1, Math.sqrt(rms * 6.5));
    if (instLevel > this.smoothedLevel) {
      this.smoothedLevel = 0.35 * this.smoothedLevel + 0.65 * instLevel;
    } else {
      this.smoothedLevel = 0.85 * this.smoothedLevel + 0.15 * instLevel;
    }

    const reading = {
      t,
      sampleRate,
      buf: this.buf,
      freq,
      midi,
      clarity,
      rms,
      level: this.smoothedLevel,
      onset
    };

    this._lastFrameTime = nowMs;
    this._cachedReading = reading;
    return reading;
  }

  presence(midis) {
    if (!Array.isArray(midis) || midis.length === 0) return [];
    const reading = this.read();
    return notePresence(reading.buf, reading.sampleRate, midis, this.a4);
  }
}
