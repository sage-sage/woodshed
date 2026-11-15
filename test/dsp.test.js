import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPitch,
  notePresence,
  OnsetDetector,
  freqToMidi,
  midiToFreq,
  centsOff
} from '../js/dsp.js';

function synthWeakFundamental(freq, sampleRate, length = 4096) {
  const amps = [0.2, 1.0, 0.8, 0.5, 0.3];
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let s = 0;
    for (let h = 1; h <= amps.length; h++) {
      const fh = freq * h;
      if (fh < sampleRate * 0.45) {
        s += amps[h - 1] * Math.sin(2 * Math.PI * fh * t + h * 0.3);
      }
    }
    buf[i] = s * 0.25;
  }
  return buf;
}

function synthKarplusStrong(freq, sampleRate, length = 4096, skipTransient = 1024) {
  const total = length + skipTransient;
  const exactPeriod = sampleRate / freq;
  const N = Math.max(2, Math.floor(exactPeriod - 0.5));
  const frac = exactPeriod - (N + 0.5);
  const c = (1 - frac) / (1 + frac);

  const delay = new Float64Array(N + 1);
  let seed = 1337 + Math.round(freq * 10);
  let mean = 0;
  for (let i = 0; i <= N; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const r = (seed / 0xffffffff) * 2 - 1;
    delay[i] = r;
    mean += r;
  }
  mean /= (N + 1);
  for (let i = 0; i <= N; i++) {
    delay[i] -= mean;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N; i++) {
      delay[i] = 0.5 * (delay[i] + delay[i + 1]);
    }
  }

  const full = new Float32Array(total);
  let ptr = 0;
  let prevAvg = 0;
  let prevOut = 0;

  for (let i = 0; i < total; i++) {
    const nextPtr = (ptr + 1) % (N + 1);
    const avg = 0.9985 * 0.5 * (delay[ptr] + delay[nextPtr]);
    const out = c * avg + prevAvg - c * prevOut;
    prevAvg = avg;
    prevOut = out;
    full[i] = out;
    delay[ptr] = out;
    ptr = nextPtr;
  }

  return full.subarray(skipTransient, skipTransient + length);
}

test('DSP helpers: midiToFreq, freqToMidi, centsOff', () => {
  assert.equal(midiToFreq(69, 440), 440);
  assert.ok(Math.abs(freqToMidi(440, 440) - 69) < 1e-9);
  assert.ok(Math.abs(centsOff(440 * Math.pow(2, 5 / 1200), 69, 440) - 5) < 1e-6);
});

test('detectPitch: additive tones with weak fundamental from B1 (35) to E6 (88) at 44.1k and 48k', () => {
  for (const sr of [44100, 48000]) {
    for (let midi = 35; midi <= 88; midi++) {
      const targetFreq = midiToFreq(midi);
      const buf = synthWeakFundamental(targetFreq, sr, 4096);
      const res = detectPitch(buf, sr);
      const errCents = Math.abs(centsOff(res.freq, midi));
      assert.ok(res.freq > 0, `Expected voiced pitch for MIDI ${midi} at ${sr}Hz`);
      assert.ok(res.clarity >= 0.6, `Expected high clarity for MIDI ${midi}, got ${res.clarity}`);
      assert.ok(
        errCents < 3,
        `Weak-fundamental MIDI ${midi} (${targetFreq.toFixed(2)}Hz @ ${sr}Hz): got ${res.freq.toFixed(2)}Hz (${errCents.toFixed(2)} cents off)`
      );
    }
  }
});

test('detectPitch: Karplus-Strong plucked strings from B1 (35) to E6 (88) at 44.1k and 48k', () => {
  for (const sr of [44100, 48000]) {
    for (let midi = 35; midi <= 88; midi++) {
      const targetFreq = midiToFreq(midi);
      const buf = synthKarplusStrong(targetFreq, sr, 4096);
      const res = detectPitch(buf, sr);
      const errCents = Math.abs(centsOff(res.freq, midi));
      assert.ok(res.freq > 0, `Expected voiced KS pitch for MIDI ${midi} at ${sr}Hz`);
      assert.ok(
        errCents < 10,
        `KS plucked MIDI ${midi} (${targetFreq.toFixed(2)}Hz @ ${sr}Hz): got ${res.freq.toFixed(2)}Hz (${errCents.toFixed(2)} cents off)`
      );
    }
  }
});

test('detectPitch: rejects silence and low-clarity noise', () => {
  const silence = new Float32Array(4096);
  assert.equal(detectPitch(silence, 44100).freq, 0);

  const noise = new Float32Array(4096);
  let s = 42;
  for (let i = 0; i < noise.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    noise[i] = ((s / 0xffffffff) * 2 - 1) * 0.1;
  }
  assert.equal(detectPitch(noise, 44100).freq, 0);
});

function synthChordBuffer(midis, sampleRate = 44100, length = 8192) {
  const out = new Float32Array(length);
  for (const m of midis) {
    const tone = synthWeakFundamental(midiToFreq(m), sampleRate, length);
    for (let i = 0; i < length; i++) {
      out[i] += tone[i] / midis.length;
    }
  }
  return out;
}

test('notePresence: distinguishes open E minor, A5 power chord, and C major from neighbour/wrong chords', () => {
  const sr = 44100;

  // Open E minor: E2 B2 E3 G3 B3 E4 -> [40, 47, 52, 55, 59, 64]
  const emMidis = [40, 47, 52, 55, 59, 64];
  const emBuf = synthChordBuffer(emMidis, sr);
  const emPres = notePresence(emBuf, sr, [40, 47, 55, 59]);
  for (const p of emPres) {
    assert.ok(p >= 0.5, `Expected E minor chord tones >= 0.5, got ${emPres}`);
  }
  // Neighbour semitone up (F minor: [41, 48, 56, 60]) and E major G#3 (56)
  const wrongEmPres = notePresence(emBuf, sr, [41, 48, 56, 60]);
  for (const p of wrongEmPres) {
    assert.ok(p < 0.25, `Expected wrong semitone neighbour tones < 0.25, got ${wrongEmPres}`);
  }

  // A5 power chord: A2 E3 A3 -> [45, 52, 57]
  const a5Midis = [45, 52, 57];
  const a5Buf = synthChordBuffer(a5Midis, sr);
  const a5Pres = notePresence(a5Buf, sr, a5Midis);
  for (const p of a5Pres) {
    assert.ok(p >= 0.5, `Expected A5 tones >= 0.5, got ${a5Pres}`);
  }
  const bb5Pres = notePresence(a5Buf, sr, [46, 53, 58]);
  for (const p of bb5Pres) {
    assert.ok(p < 0.25, `Expected Bb5 tones < 0.25 on A5 buffer, got ${bb5Pres}`);
  }

  // Open C major: C3 E3 G3 C4 E4 -> [48, 52, 55, 60, 64]
  const cMajMidis = [48, 52, 55, 60, 64];
  const cMajBuf = synthChordBuffer(cMajMidis, sr);
  const cMajPres = notePresence(cMajBuf, sr, [48, 52, 55, 60]);
  for (const p of cMajPres) {
    assert.ok(p >= 0.5, `Expected C major tones >= 0.5, got ${cMajPres}`);
  }
  // Wrong chord D minor [50, 53, 57]
  const dMinPres = notePresence(cMajBuf, sr, [50, 53, 57]);
  for (const p of dMinPres) {
    assert.ok(p < 0.25, `Expected D minor tones < 0.25 on C major buffer, got ${dMinPres}`);
  }
});

test('OnsetDetector: detects repeated plucks and respects 60ms refractory period', () => {
  const detector = new OnsetDetector();
  const silent = new Float32Array(1024);
  const loud = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) {
    loud[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / 44100);
  }

  assert.equal(detector.process(silent, 0.0), false);
  // First pluck at t = 0.10s
  assert.equal(detector.process(loud, 0.10), true);
  // Within 60ms refractory window (t = 0.13s) -> must not re-trigger
  assert.equal(detector.process(loud, 0.13), false);

  // Decay back to quiet
  for (let k = 1; k <= 6; k++) {
    detector.process(silent, 0.15 + k * 0.02);
  }

  // Second pluck at t = 0.35s
  assert.equal(detector.process(loud, 0.35), true);
});
