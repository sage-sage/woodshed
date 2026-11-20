import { getAudioContext, getMasterGain } from './audio-context.js';
import { midiToFreq } from './dsp.js';
import { buildEvents } from './song.js';

const TONE_PRESETS = {
  clean:     { k: 1,   preHP: 70,  preEQFreq: 800,  preEQGain: 0,  cabLP: 6500,  cabPeakFreq: 1800, cabPeakGain: 2, cabLowFreq: 110, cabLowGain: 2, rev: 0.14 },
  jazz:      { k: 1.2, preHP: 60,  preEQFreq: 700,  preEQGain: -2, cabLP: 3200,  cabPeakFreq: 1200, cabPeakGain: 1, cabLowFreq: 140, cabLowGain: 3, rev: 0.12 },
  breakup:   { k: 3,   preHP: 80,  preEQFreq: 900,  preEQGain: 2,  cabLP: 5500,  cabPeakFreq: 1800, cabPeakGain: 2, cabLowFreq: 110, cabLowGain: 2, rev: 0.10 },
  crunch:    { k: 7,   preHP: 90,  preEQFreq: 1000, preEQGain: 3,  cabLP: 5000,  cabPeakFreq: 2000, cabPeakGain: 2, cabLowFreq: 110, cabLowGain: 1, rev: 0.08 },
  rock_lead: { k: 14,  preHP: 100, preEQFreq: 900,  preEQGain: 4,  cabLP: 4800,  cabPeakFreq: 1800, cabPeakGain: 3, cabLowFreq: 110, cabLowGain: 1, rev: 0.16 },
  high_gain: { k: 24,  preHP: 110, preEQFreq: 800,  preEQGain: 3,  cabLP: 4600,  cabPeakFreq: 2200, cabPeakGain: 2, cabLowFreq: 100, cabLowGain: 2, rev: 0.07 },
  metal:     { k: 36,  preHP: 130, preEQFreq: 700,  preEQGain: -4, cabLP: 4800,  cabPeakFreq: 2400, cabPeakGain: 3, cabLowFreq: 90,  cabLowGain: 3, rev: 0.05 },
  fuzz:      { k: 30,  preHP: 70,  preEQFreq: 1000, preEQGain: 5,  cabLP: 3800,  cabPeakFreq: 1500, cabPeakGain: 2, cabLowFreq: 120, cabLowGain: 2, rev: 0.06 },
  acoustic:  { k: 1,   preHP: 90,  preEQFreq: 2500, preEQGain: 4,  cabLP: 11000, cabPeakFreq: 220,  cabPeakGain: 3, cabLowFreq: 100, cabLowGain: 1, rev: 0.18 },
  bass:      { k: 1.5, preHP: 35,  preEQFreq: 600,  preEQGain: -2, cabLP: 2500,  cabPeakFreq: 800,  cabPeakGain: 1, cabLowFreq: 80,  cabLowGain: 4, rev: 0.03 }
};

// Recorded guitar samples (FluidR3_GM, CC BY 3.0, see vendor/fluidr3) for each tone. `driven` samples are
// already distorted, so the tone chain's own drive is relaxed when they are in use.
const SAMPLE_SETS = {
  clean: 'electric_guitar_clean',
  jazz: 'electric_guitar_jazz',
  breakup: 'electric_guitar_clean',
  crunch: 'overdriven_guitar',
  rock_lead: 'overdriven_guitar',
  high_gain: 'distortion_guitar',
  metal: 'distortion_guitar',
  fuzz: 'distortion_guitar',
  acoustic: 'acoustic_guitar_steel',
  bass: 'electric_bass_finger',
};
const DRIVEN_SETS = new Set(['overdriven_guitar', 'distortion_guitar']);
// The samples are quieter than the plucked-string model; these match their loudness (RMS over the first
// half second, averaged across the range, measured 2026-11-15) so the guide keeps its old level.
const SAMPLE_GAIN = { electric_guitar_clean: 2.67, electric_guitar_jazz: 2.69, acoustic_guitar_steel: 3.02,
  overdriven_guitar: 2.3, distortion_guitar: 1.75, electric_bass_finger: 3.47 };

/** Loads and decodes one FluidR3 instrument (vendor/fluidr3/<name>.json) note by note, in the background. */
class SampleSet {
  constructor(ctx, name) {
    this.ctx = ctx;
    this.name = name;
    this.buffers = new Map();   // midi -> AudioBuffer
    this.failed = false;
    this.ready = this._load();
  }

  async _load() {
    try {
      const res = await fetch(`vendor/fluidr3/${this.name}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const entries = Object.entries(data.notes || {}).map(([m, b64]) => [Number(m), b64]);
      // Middle of the range first: the notes most songs use are ready soonest.
      entries.sort((a, b) => Math.abs(a[0] - 55) - Math.abs(b[0] - 55));
      for (const [midi, b64] of entries) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        try {
          this.buffers.set(midi, await this.ctx.decodeAudioData(bytes.buffer));
        } catch (_) {
          // One bad note is not fatal: neighbours are pitch-shifted to cover it.
        }
      }
      if (this.buffers.size === 0) throw new Error('no playable notes');
    } catch (err) {
      this.failed = true;
      console.warn(`[woodshed] guitar samples "${this.name}" unavailable, using the built-in synth:`, err?.message || err);
    }
  }

  /** The decoded sample nearest to `midi` and the playback rate that tunes it to `midi`, or null. */
  pick(midi) {
    if (this.buffers.has(midi)) return { buffer: this.buffers.get(midi), rate: 1 };
    let best = null;
    for (const m of this.buffers.keys()) {
      if (best === null || Math.abs(m - midi) < Math.abs(best - midi)) best = m;
    }
    if (best === null || Math.abs(best - midi) > 7) return null;
    return { buffer: this.buffers.get(best), rate: Math.pow(2, (midi - best) / 12) };
  }
}

/**
 * The pitch path of one note from its technique fields (see song.js techniqueFields), as automation points
 * [seconds from the note's start, semitones off its written pitch], or [] for a straight note.
 * `fromSemis` is where a legato slide ('slide' tech) starts, relative to this note (prev midi - this midi).
 */
export function pitchCurve(note, durSec, fromSemis = null) {
  const dur = Math.max(0.02, Number(durSec) || 0);
  const pts = [];
  const bend = Number(note?.bend) || 0;
  if (bend > 0) {
    let curve = Array.isArray(note.bendCurve) && note.bendCurve.length >= 2 ? note.bendCurve : null;
    if (!curve) {
      if (note.prebend) curve = note.release ? [[0, bend], [0.4, bend], [0.8, 0]] : [[0, bend], [1, bend]];
      else curve = note.release ? [[0, 0], [0.25, bend], [0.6, bend], [0.9, 0]] : [[0, 0], [0.3, bend], [1, bend]];
    }
    for (const [pos, semis] of curve) pts.push([Math.max(0, Math.min(1, Number(pos) || 0)) * dur, Number(semis) || 0]);
  }
  // Slides: a quick glide into the note (from a neighbouring fret, or the previous note) or off it.
  const glideIn = Math.min(0.08, dur * 0.3);
  let startSemis = null;
  if (note?.tech === 'slide' && Number.isFinite(fromSemis) && fromSemis !== 0) startSemis = Math.max(-12, Math.min(12, fromSemis));
  else if (note?.slideIn === 'below') startSemis = -3;
  else if (note?.slideIn === 'above') startSemis = 3;
  if (startSemis !== null && pts.length === 0) {
    pts.push([0, startSemis], [glideIn, 0]);
  }
  if (note?.slideOut === 'up' || note?.slideOut === 'down') {
    const glideOut = Math.min(0.15, dur * 0.4);
    const endSemis = note.slideOut === 'up' ? 5 : -5;
    const held = pts.length ? pts[pts.length - 1][1] : 0;
    if (pts.length === 0) pts.push([0, 0]);
    pts.push([dur - glideOut, held], [dur, held + endSemis]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  return pts;
}

function hasTechnique(n) {
  return Boolean(n && ((Number(n.bend) || 0) > 0 || n.slideIn || n.slideOut || n.vibrato || n.tech === 'vib' || n.tech === 'slide'));
}

export function resolveGuideTone(setting, songToneId) {
  if (!setting || setting === 'match') {
    return songToneId && TONE_PRESETS[songToneId] ? songToneId : 'clean';
  }
  return TONE_PRESETS[setting] ? setting : 'clean';
}

export class GuitarSynth {
  static TONES = Object.keys(TONE_PRESETS);

  constructor() {
    this.ctx = getAudioContext();
    this.output = this.ctx.createGain();
    this.output.gain.value = 0.7;

    this.preHP = this.ctx.createBiquadFilter();
    this.preHP.type = 'highpass';
    this.preHP.Q.value = 0.707;

    this.preEQ = this.ctx.createBiquadFilter();
    this.preEQ.type = 'peaking';
    this.preEQ.Q.value = 1.0;

    this.drive = this.ctx.createWaveShaper();
    this.drive.oversample = '4x';

    this.postGain = this.ctx.createGain();

    this.cabLP = this.ctx.createBiquadFilter();
    this.cabLP.type = 'lowpass';
    this.cabLP.Q.value = 0.7;

    this.cabPeak = this.ctx.createBiquadFilter();
    this.cabPeak.type = 'peaking';
    this.cabPeak.Q.value = 1.4;

    this.cabLow = this.ctx.createBiquadFilter();
    this.cabLow.type = 'peaking';
    this.cabLow.Q.value = 1.1;

    this.reverb = this.ctx.createConvolver();
    this.reverb.normalize = false;
    this.reverb.buffer = this._createReverbIR(1.2);

    this.dryGain = this.ctx.createGain();
    this.wetGain = this.ctx.createGain();

    const master = getMasterGain();
    this.output.connect(this.preHP);
    this.preHP.connect(this.preEQ);
    this.preEQ.connect(this.drive);
    this.drive.connect(this.postGain);
    this.postGain.connect(this.cabLP);
    this.cabLP.connect(this.cabPeak);
    this.cabPeak.connect(this.cabLow);
    this.cabLow.connect(this.dryGain);
    this.cabLow.connect(this.reverb);
    this.reverb.connect(this.wetGain);
    this.dryGain.connect(master);
    this.wetGain.connect(master);

    this.testOutput = this.ctx.createGain();
    this.testOutput.gain.value = 0.0;
    this.output.connect(this.testOutput);

    this.bufferCache = new Map();
    this.curveCache = new Map();
    this.sampleSets = new Map();   // FluidR3 instrument name -> SampleSet (loaded on first use)
    this.activeVoices = new Set();
    this.a4 = 440;
    this._ampCapture = null;
    this.routeLatency = 0;
    this._requestedToneId = 'clean';
    this.toneId = 'clean';
    this.setTone('clean');
  }

  _createReverbIR(duration = 1.2) {
    const sr = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(sr * duration));
    const ir = this.ctx.createBuffer(2, length, sr);
    let seed = 0x5eed1234;
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      let energy = 0;
      for (let i = 0; i < length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const white = (seed / 0xffffffff) * 2 - 1;
        const t = i / length;
        const env = Math.exp(-6.9 * t) * Math.min(1, i / (sr * 0.004));
        const s = white * env;
        data[i] = s;
        energy += s * s;
      }
      if (energy > 1e-12) {
        const norm = 1 / Math.sqrt(energy);
        for (let i = 0; i < length; i++) {
          data[i] *= norm;
        }
      }
    }
    return ir;
  }

  _getDriveCurve(id, k) {
    const isFuzz = id === 'fuzz';
    const cacheKey = `${isFuzz ? 'fuzz' : 'soft'}-${k}`;
    if (this.curveCache.has(cacheKey)) {
      return this.curveCache.get(cacheKey);
    }
    const n = 4096;
    const curve = new Float32Array(n);
    const softDenom = Math.tanh(k) || 1;
    const fuzzDenom = Math.tanh(1);
    for (let i = 0; i < n; i++) {
      const x = (2 * i) / (n - 1) - 1;
      if (isFuzz) {
        const clipped = Math.max(-1, Math.min(1, k * x));
        curve[i] = Math.tanh(clipped) / fuzzDenom;
      } else {
        curve[i] = Math.tanh(k * x) / softDenom;
      }
    }
    this.curveCache.set(cacheKey, curve);
    return curve;
  }

  setTone(id) {
    const requestedId = TONE_PRESETS[id] ? id : 'clean';
    this._requestedToneId = requestedId;
    // Routed through Woodshed Amp the guide is mixed in after the player's amp (clean), so it keeps the song's
    // own recorded tone; the page's simulated tone chain is skipped either way when routed.
    const resolvedId = requestedId;
    const cfg = TONE_PRESETS[resolvedId];
    this.toneId = resolvedId;

    // Start loading this tone's recorded samples; until they are decoded the plucked-string model plays.
    const setName = SAMPLE_SETS[resolvedId];
    if (setName && !this.sampleSets.has(setName) && typeof fetch === 'function') {
      this.sampleSets.set(setName, new SampleSet(this.ctx, setName));
    }
    // Already-distorted samples only need a touch of the shaper.
    const k = DRIVEN_SETS.has(setName) ? Math.min(cfg.k, 1.5) : cfg.k;

    const now = this.ctx.currentTime;
    const tc = 0.03;
    this.preHP.frequency.setTargetAtTime(cfg.preHP, now, tc);
    this.preEQ.frequency.setTargetAtTime(cfg.preEQFreq, now, tc);
    this.preEQ.gain.setTargetAtTime(cfg.preEQGain, now, tc);
    this.drive.curve = this._getDriveCurve(resolvedId, k);
    // A driven shaper sits near full scale whatever goes in (a guide note arrives around 0.3), so bring
    // saturated tones down to about the clean level: k 1 -> 1, k 3 -> 0.69, k 7 and up -> ~0.5.
    this.postGain.gain.setTargetAtTime(Math.min(1, 0.5 / Math.tanh(k * 0.3)), now, tc);
    this.cabLP.frequency.setTargetAtTime(cfg.cabLP, now, tc);
    this.cabPeak.frequency.setTargetAtTime(cfg.cabPeakFreq, now, tc);
    this.cabPeak.gain.setTargetAtTime(cfg.cabPeakGain, now, tc);
    this.cabLow.frequency.setTargetAtTime(cfg.cabLowFreq, now, tc);
    this.cabLow.gain.setTargetAtTime(cfg.cabLowGain, now, tc);
    this.wetGain.gain.setTargetAtTime(cfg.rev, now, tc);
    this.dryGain.gain.setTargetAtTime(1 - cfg.rev * 0.5, now, tc);
  }

  setVolume(vol) {
    const n = Number(vol);
    const v = Math.max(0, Math.min(1.5, Number.isFinite(n) ? n : 0.7));
    this.output.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  get isAmpRouted() {
    return this._ampCapture !== null;
  }

  setAmpRoute(route) {
    if (route && route.capture) {
      const nextLatency = Math.max(0, Number(route.latencySec) || 0);
      if (this._ampCapture === route.capture) {
        this.routeLatency = nextLatency;
        return;
      }
      if (this._ampCapture) {
        try {
          this.output.disconnect(this._ampCapture);
        } catch (_) {
          // Ignore
        }
      } else {
        try {
          this.output.disconnect(this.preHP);
        } catch (_) {
          // Ignore
        }
      }
      this._ampCapture = route.capture;
      this.routeLatency = nextLatency;
      this.output.connect(this._ampCapture);
      this.setTone(this._requestedToneId);
      return;
    }

    if (!this._ampCapture) {
      this.routeLatency = 0;
      return;
    }
    const prevCapture = this._ampCapture;
    this._ampCapture = null;
    this.routeLatency = 0;
    try {
      this.output.disconnect(prevCapture);
    } catch (_) {
      // Ignore
    }
    this.output.connect(this.preHP);
    this.setTone(this._requestedToneId);
  }

  setSelfTestRoute(guitarInput, enabled = false, gain = 0.85) {
    if (!guitarInput) return;
    if (enabled) {
      this.testOutput.gain.value = gain;
      guitarInput.connectSource(this.testOutput);
    } else {
      this.testOutput.gain.value = 0;
      guitarInput.disconnectSource(this.testOutput);
    }
  }

  _getPluckBuffer(midi) {
    const rounded = Math.max(24, Math.min(108, Math.round(midi)));
    const key = `${rounded}-${this.ctx.sampleRate}-${this.a4}`;
    if (this.bufferCache.has(key)) {
      return this.bufferCache.get(key);
    }

    const sr = this.ctx.sampleRate;
    const duration = 3.0;
    const totalSamples = Math.floor(sr * duration);
    const freq = midiToFreq(rounded, this.a4);

    const exactPeriod = sr / freq;
    const N = Math.max(2, Math.floor(exactPeriod - 0.5));
    const frac = exactPeriod - (N + 0.5);
    const allpassC = (1 - frac) / (1 + frac);

    const L = N + 1;
    const raw = new Float32Array(L);
    let seed = (rounded * 2654435761) >>> 0;
    const alpha = Math.max(0.35, Math.min(0.75, 0.35 + (rounded - 40) * 0.01));
    let lpState = 0;
    for (let i = 0; i < L; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = (seed / 0xffffffff) * 2 - 1;
      lpState += alpha * (noise - lpState);
      raw[i] = lpState;
    }

    const pickOffset = Math.max(1, Math.round(0.13 * N));
    const delay = new Float32Array(L);
    let mean = 0;
    for (let i = 0; i < L; i++) {
      delay[i] = raw[i] - raw[(i + pickOffset) % L];
      mean += delay[i];
    }
    mean /= L;
    for (let i = 0; i < L; i++) {
      delay[i] -= mean;
    }

    const audioBuf = this.ctx.createBuffer(1, totalSamples, sr);
    const data = audioBuf.getChannelData(0);

    const t60 = Math.max(1.2, Math.min(4.5, 4.5 - (rounded - 40) * 0.06));
    const g = Math.pow(10, -3 / (t60 * freq));
    const b = 0.5;
    const pickSamples = Math.max(1, Math.floor(sr * 0.003));

    let ptr = 0;
    let prevAvg = 0;
    let prevOut = 0;
    let peak = 0;

    for (let i = 0; i < totalSamples; i++) {
      const nextPtr = (ptr + 1) % L;
      const lp = (1 - b) * delay[ptr] + b * delay[nextPtr];
      const avg = g * lp;
      const out = allpassC * avg + prevAvg - allpassC * prevOut;
      prevAvg = avg;
      prevOut = out;
      delay[ptr] = out;
      ptr = nextPtr;

      let pick = 0;
      if (i < pickSamples) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const burst = (seed / 0xffffffff) * 2 - 1;
        pick = burst * (1 - i / pickSamples) * 0.25;
      }

      const sample = out + pick;
      data[i] = sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }

    if (peak > 1e-6) {
      const scale = 0.6 / peak;
      for (let i = 0; i < totalSamples; i++) {
        data[i] *= scale;
      }
    }

    this.bufferCache.set(key, audioBuf);
    return audioBuf;
  }

  /**
   * Stop what is ringing, the way a player's hands do: a string can only sound one note, and a chord change
   * lifts the fretting hand off everything. strings = null damps every voice that started before `when`.
   */
  damp(when, strings = null) {
    const shift = this.isAmpRouted ? this.routeLatency : 0;
    const t = Math.max(this.ctx.currentTime, (Number(when) || 0) - shift);
    for (const v of this.activeVoices) {
      if (v.startTime >= t - 0.001 || v.damped) continue;
      if (strings && !strings.includes(v.string)) continue;
      v.damped = true;
      try {
        v.env.gain.cancelAndHoldAtTime(t);
        v.env.gain.setTargetAtTime(0.0001, t, 0.012);
        v.src.stop(t + 0.1);
      } catch (_) {
        // Already stopped
      }
    }
  }

  /**
   * `tech` (optional): { note, fromSemis } — the song note carrying bend/slide/vibrato fields, and for a
   * legato slide where it comes from (previous midi - midi). Bends and slides move the voice's detune.
   */
  playNote(midi, when = 0, dur = 0.4, gain = 0.8, string = -1, tech = null) {
    const now = this.ctx.currentTime;
    const shift = this.isAmpRouted ? this.routeLatency : 0;
    const startTime = Math.max(now, (Number(when) || now) - shift);
    const noteDur = Math.max(0.05, Math.min(2.9, Number(dur) || 0.4));

    // A recorded sample when this tone's set is decoded, else the plucked-string model.
    const setName = SAMPLE_SETS[this.toneId];
    const set = setName ? this.sampleSets.get(setName) : null;
    const sample = set && !set.failed ? set.pick(Math.round(midi)) : null;

    const src = this.ctx.createBufferSource();
    let sampleGain = 1;
    if (sample) {
      src.buffer = sample.buffer;
      // Samples are tuned to A4 = 440 Hz; follow the player's reference pitch and any fractional midi.
      const a4Ratio = (Number(this.a4) || 440) / 440;
      src.playbackRate.value = sample.rate * a4Ratio * Math.pow(2, (midi - Math.round(midi)) / 12);
      sampleGain = SAMPLE_GAIN[setName] ?? 0.8;
    } else {
      src.buffer = this._getPluckBuffer(midi);
    }

    const env = this.ctx.createGain();
    const humanize = 1 + (Math.random() * 2 - 1) * 0.08;
    const baseGain = Math.max(0.01, Math.min(1.5, Number(gain) || 0.8));
    const peakGain = Math.max(0.01, Math.min(1.5, baseGain * humanize)) * sampleGain;
    const k = TONE_PRESETS[this.toneId]?.k ?? 1;
    // Recorded notes get a longer, natural-sounding release (fingers lifting off) instead of a click stop.
    const releaseSec = sample ? 0.12 : (k >= 7 ? 0.08 : 0.045);

    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(peakGain, startTime + 0.004);
    env.gain.setValueAtTime(peakGain, startTime + noteDur);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + noteDur + releaseSec);

    src.connect(env);
    env.connect(this.output);

    let lfo = null;
    if (tech?.note) {
      const curve = pitchCurve(tech.note, noteDur, tech.fromSemis);
      if (curve.length && src.detune) {
        src.detune.setValueAtTime(curve[0][1] * 100, startTime);
        for (let i = 1; i < curve.length; i++) {
          src.detune.linearRampToValueAtTime(curve[i][1] * 100, startTime + curve[i][0]);
        }
      }
      if ((tech.note.vibrato || tech.note.tech === 'vib') && src.detune) {
        lfo = this.ctx.createOscillator();
        lfo.frequency.value = 5.5;
        const depth = this.ctx.createGain();
        depth.gain.setValueAtTime(0, startTime);
        depth.gain.linearRampToValueAtTime(30, startTime + Math.min(0.25, noteDur * 0.5)); // cents, eases in
        lfo.connect(depth);
        depth.connect(src.detune);
        lfo.start(startTime);
        lfo.stop(startTime + noteDur + releaseSec + 0.005);
      }
    }

    const voice = { src, env, startTime, string, damped: false };
    this.activeVoices.add(voice);
    src.onended = () => {
      this.activeVoices.delete(voice);
      try {
        src.disconnect();
        env.disconnect();
        if (lfo) lfo.disconnect();
      } catch (_) {
        // Ignore
      }
    };

    src.start(startTime);
    src.stop(startTime + noteDur + releaseSec + 0.005);
    return voice;
  }

  /**
   * A metronome click, heard at `when`. Routed through Woodshed Amp it goes to the amp with the guide (and is
   * sent early by the route's delay, like the guide's notes), so nothing is left on the computer's own output.
   */
  playClick(when = 0, accented = false, gain = 0.45) {
    const now = this.ctx.currentTime;
    const shift = this.isAmpRouted ? this.routeLatency : 0;
    const startTime = Math.max(now, (Number(when) || now) - shift);
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(accented ? 1320 : 880, startTime);
    osc.frequency.exponentialRampToValueAtTime(accented ? 660 : 440, startTime + 0.035);

    const g = Math.max(0.01, Math.min(1.0, gain * (accented ? 1.25 : 0.85)));
    env.gain.setValueAtTime(0.001, startTime);
    env.gain.linearRampToValueAtTime(g, startTime + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.04);

    osc.connect(env);
    env.connect(this._ampCapture || getMasterGain());

    const voice = { src: osc, env };
    this.activeVoices.add(voice);
    osc.onended = () => {
      this.activeVoices.delete(voice);
      try {
        osc.disconnect();
        env.disconnect();
      } catch (_) {
        // Ignore
      }
    };

    osc.start(startTime);
    osc.stop(startTime + 0.045);
  }

  stopAll() {
    const now = this.ctx.currentTime;
    for (const v of this.activeVoices) {
      try {
        v.env.gain.cancelScheduledValues(now);
        v.env.gain.setValueAtTime(0.0001, now);
        v.src.stop(now + 0.01);
      } catch (_) {
        // Ignore
      }
    }
    this.activeVoices.clear();
  }
}

export class GuideScheduler {
  constructor(synth, {
    song = null,
    tabTimeNow = () => 0,
    getRate = () => 1.0,
    guideEnabled = true,
    metronomeEnabled = false,
    // Maps tab time to recording time (the sync). Notes are scheduled in recording time, so a sync that
    // stretches or squeezes the tempo doesn't make the guide drift from the recording.
    tabToAudio = (t) => t
  } = {}) {
    this.synth = synth;
    this.tabToAudio = tabToAudio;
    this.song = song;
    this.events = song ? buildEvents(song) : [];
    this.beats = song ? this._buildBeats(song) : [];
    this.tabTimeNow = tabTimeNow;
    this.getRate = getRate;
    this.guideEnabled = Boolean(guideEnabled);
    this.metronomeEnabled = Boolean(metronomeEnabled);

    this.lookaheadSec = 0.15;
    this.intervalMs = 25;
    this._timerId = null;
    this._running = false;
    this._lastTabTime = -Infinity;
    this._scheduledEvents = new Set();
    this._scheduledBeats = new Set();
    this._lastMidiByString = new Map(); // for legato slides: where the string's previous note was
  }

  _buildBeats(song) {
    const beats = [];
    if (!song || !Array.isArray(song.bars)) return beats;
    for (let bIdx = 0; bIdx < song.bars.length; bIdx++) {
      const bar = song.bars[bIdx];
      const num = bar.num || 4;
      const beatDur = bar.dur / num;
      for (let k = 0; k < num; k++) {
        beats.push({
          id: `${bIdx}:${k}`,
          t: bar.t + k * beatDur,
          accented: k === 0
        });
      }
    }
    return beats;
  }

  setSong(song) {
    this.song = song;
    this.events = song ? buildEvents(song) : [];
    this.beats = song ? this._buildBeats(song) : [];
    this.reset();
  }

  setOptions({ guideEnabled, metronomeEnabled } = {}) {
    if (guideEnabled !== undefined) this.guideEnabled = Boolean(guideEnabled);
    if (metronomeEnabled !== undefined) this.metronomeEnabled = Boolean(metronomeEnabled);
  }

  reset() {
    this._scheduledEvents.clear();
    this._scheduledBeats.clear();
    this._lastMidiByString.clear();
    this._lastTabTime = -Infinity;
    if (this.synth) this.synth.stopAll();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTabTime = this.tabTimeNow();
    this._tick();
    this._timerId = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    this._running = false;
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
    if (this.synth) this.synth.stopAll();
  }

  async playCountIn(rate = 1.0) {
    const firstBar = this.song?.bars?.[0] || { bpm: this.song?.bpm || 120, num: 4, den: 4 };
    const bpm = firstBar.bpm || this.song?.bpm || 120;
    const num = firstBar.num || 4;
    const den = firstBar.den || 4;
    const effectiveRate = Math.max(0.25, Number(rate) || 1.0);
    const beatSec = ((60 / bpm) * (4 / den)) / effectiveRate;

    // Through the amp the clicks are heard the route's delay later; start the song that much later too.
    const routeLat = this.synth.isAmpRouted ? (Number(this.synth.routeLatency) || 0) : 0;
    const now = this.synth.ctx.currentTime + 0.03 + routeLat;
    for (let i = 0; i < num; i++) {
      this.synth.playClick(now + i * beatSec, i === 0, 0.55);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, Math.round((num * beatSec + routeLat) * 1000));
    });
  }

  _tick() {
    if (!this._running || !this.synth) return;

    const curTab = this.tabTimeNow();
    const rate = Math.max(0.1, Number(this.getRate()) || 1.0);

    if (curTab < this._lastTabTime - 0.05 || curTab > this._lastTabTime + 0.6) {
      this._scheduledEvents.clear();
      this._scheduledBeats.clear();
      this.synth.stopAll();
    }
    this._lastTabTime = curTab;

    const routeLat = this.synth?.isAmpRouted ? (Number(this.synth.routeLatency) || 0) : 0;
    const effectiveLookahead = routeLat > 0.12 ? routeLat + 0.05 : this.lookaheadSec;
    const tabHorizon = curTab + effectiveLookahead * rate;
    const audioNow = this.synth.ctx.currentTime;

    if (this.guideEnabled) {
      for (const ev of this.events) {
        if (ev.t < curTab - 0.03) continue;
        if (ev.t > tabHorizon) break;
        if (this._scheduledEvents.has(ev.index)) continue;

        this._scheduledEvents.add(ev.index);
        const delayAudioSec = Math.max(0, (this.tabToAudio(ev.t) - this.tabToAudio(curTab)) / rate);
        const when = audioNow + delayAudioSec;
        const perNoteGain = Math.min(0.8, 0.95 / Math.sqrt(Math.max(1, ev.notes.length)));

        this.synth.damp(when, ev.notes.length >= 2 ? null : ev.notes.map((n) => n.string));
        for (const n of ev.notes) {
          const prev = this._lastMidiByString.get(n.string);
          const tech = hasTechnique(n) ? { note: n, fromSemis: Number.isFinite(prev) ? prev - n.midi : null } : null;
          this.synth.playNote(n.midi, when, Math.max(0.08, n.dur / rate), perNoteGain, n.string, tech);
          this._lastMidiByString.set(n.string, n.midi);
        }
      }
    }

    if (this.metronomeEnabled) {
      for (const beat of this.beats) {
        if (beat.t < curTab - 0.03) continue;
        if (beat.t > tabHorizon) break;
        if (this._scheduledBeats.has(beat.id)) continue;

        this._scheduledBeats.add(beat.id);
        const delayAudioSec = Math.max(0, (this.tabToAudio(beat.t) - this.tabToAudio(curTab)) / rate);
        this.synth.playClick(audioNow + delayAudioSec, beat.accented, 0.45);
      }
    }
  }
}
