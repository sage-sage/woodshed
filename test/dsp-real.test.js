// Realistic end-to-end DSP checks: strummed Karplus-Strong chords, chord changes over a ringing chord,
// and frame-by-frame onset detection the way the browser feeds it (one read per animation frame).
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, notePresence, judgeNotes, OnsetDetector, midiToFreq } from '../js/dsp.js';

function pluck(out, sr, midi, startSec, gain = 0.3, seed = 1) {
  const f = midiToFreq(midi);
  const period = sr / f;
  const N = Math.floor(period - 0.5);
  const frac = period - 0.5 - N;
  const c = (1 - frac) / (1 + frac);
  const d = new Float64Array(N + 1);
  let s = (seed * 2654435761 + midi * 97) >>> 0;
  let mean = 0;
  for (let i = 0; i <= N; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s / 0xffffffff * 2 - 1; mean += d[i]; }
  mean /= N + 1;
  for (let i = 0; i <= N; i++) d[i] -= mean;
  for (let p = 0; p < 3; p++) for (let i = 0; i < N; i++) d[i] = 0.5 * (d[i] + d[i + 1]);
  let ptr = 0, pa = 0, po = 0;
  const i0 = Math.round(startSec * sr);
  for (let i = i0; i < out.length; i++) {
    const nx = (ptr + 1) % (N + 1);
    const avg = 0.9992 * 0.5 * (d[ptr] + d[nx]);
    const o = c * avg + pa - c * po;
    pa = avg; po = o; d[ptr] = o; ptr = nx;
    out[i] += o * gain;
  }
}
function strum(out, sr, midis, startSec, gain = 0.25, seed = 1) {
  midis.forEach((m, k) => pluck(out, sr, m, startSec + k * 0.012, gain, seed + k));
}
const tail = (buf, endSec, sr, len) => buf.subarray(Math.round(endSec * sr) - len, Math.round(endSec * sr));
const yes = (a) => a.filter((p) => p >= 0.5).length;

const CHORDS = {
  Em: [40, 47, 52, 55, 59, 64], E: [40, 47, 52, 56, 59, 64], Am: [45, 52, 57, 60, 64], A: [45, 52, 57, 61, 64],
  C: [48, 52, 55, 60, 64], G: [43, 47, 50, 55, 59, 67], D: [50, 57, 62, 66], Dm: [50, 57, 62, 65],
  F: [41, 48, 53, 57, 60, 65], A5: [45, 52, 57], E5: [40, 47, 52], G5: [43, 50, 55], 'F#5': [42, 49, 54],
};

for (const sr of [44100, 48000]) {
  test(`chords: every strummed chord is recognised 150 ms after the strum @${sr}`, () => {
    for (const [name, midis] of Object.entries(CHORDS)) {
      const out = new Float32Array(sr);
      strum(out, sr, midis, 0.2);
      const p = notePresence(tail(out, 0.2 + 0.15 + midis.length * 0.012, sr, 8192), sr, midis);
      assert.ok(yes(p) >= Math.ceil(midis.length * 0.8), `${name}: ${p.map((v) => v.toFixed(2))}`);
    }
  });

  test(`chords: a different chord is not mistaken for the target @${sr}`, () => {
    const pairs = [['Em', 'E'], ['Em', 'Am'], ['Em', 'G'], ['Am', 'A'], ['Am', 'C'], ['C', 'G'], ['D', 'Dm'], ['C', 'F'],
      ['A5', 'G5'], ['E5', 'F#5'], ['A5', 'E5'], ['G', 'D'], ['F', 'Em']];
    for (const [played, target] of pairs) for (const [a, b] of [[played, target], [target, played]]) {
      const out = new Float32Array(sr);
      strum(out, sr, CHORDS[a], 0.2);
      const unique = CHORDS[b].filter((m) => !CHORDS[a].some((x) => (x - m) % 12 === 0));
      const p = notePresence(tail(out, 0.45, sr, 8192), sr, unique);
      assert.ok(unique.length > 0 && yes(p) === 0, `played ${a}, asked ${b} tones ${unique}: ${p.map((v) => v.toFixed(2))}`);
    }
  });

  test(`chords: a chord change over a ringing chord shows up within 130 ms @${sr}`, () => {
    const out = new Float32Array(sr * 2);
    strum(out, sr, CHORDS.G, 0.1, 0.25, 3);
    // The fretting hand moves: the old chord is damped (not modelled as silence: it keeps ringing at 25%).
    const cut = Math.round(1.0 * sr);
    for (let i = cut; i < out.length; i++) out[i] *= 0.25;
    strum(out, sr, CHORDS.C, 1.0, 0.25, 9);
    const p = notePresence(tail(out, 1.0 + 0.13 + 0.06, sr, 8192), sr, CHORDS.C);
    assert.ok(yes(p) >= 4, `C after G: ${p.map((v) => v.toFixed(2))}`);
  });

  test(`onsets + pitch: frame-by-frame melody, repeated notes included @${sr}`, () => {
    const seq = [40, 40, 43, 45, 45, 45, 52, 55, 57, 57, 64, 67, 69, 69, 76];
    const step = 0.25;
    const out = new Float32Array(Math.round(sr * (seq.length * step + 1)));
    seq.forEach((m, i) => {
      const i0 = Math.round((0.5 + i * step) * sr);
      for (let j = i0; j < out.length; j++) out[j] *= 0.35; // re-picking a string stops what was ringing
      pluck(out, sr, m, 0.5 + i * step, 0.3, i + 1);
    });
    const det = new OnsetDetector();
    const onsets = [];
    const right = new Array(seq.length).fill(false);
    const wrong = new Array(seq.length).fill('');
    const streak = new Map();
    for (let t = 0.2; t < seq.length * step + 0.6; t += 1 / 60) {
      const end = Math.round(t * sr);
      if (end < 8192) continue;
      const buf = out.subarray(end - 8192, end);
      if (det.process(buf, t)) onsets.push(t);
      const r = detectPitch(buf.subarray(8192 - 2048), sr, { minHz: 70, maxHz: 1400 });
      const k = Math.floor((t - 0.5) / step);
      const since = t - (0.5 + k * step);
      if (k < 0 || k >= seq.length || since < 0.03 || since > 0.2) continue;
      // The game needs the same verdict on two frames in a row before it believes it.
      const twice = (key, ok) => { const was = streak.get(key) === true; streak.set(key, ok); return ok && was; };
      if (twice(`${k}`, judgeNotes(buf, sr, [seq[k]], r.freq).ok)) right[k] = true;
      // What the game must NOT accept while this note sounds: its neighbours and unrelated notes.
      for (const off of [-2, -1, 1, 2, 6]) {
        const m = seq[k] + off;
        // Notes that are still ringing, and their octave/twelfth overtones, are legitimately in the air.
        if ([seq[k - 1], seq[k - 2]].some((p) => p !== undefined && [0, 7, 12, 19, 24].includes(m - p))) continue;
        if (twice(`${k}:${off}`, judgeNotes(buf, sr, [m], r.freq).ok)) wrong[k] += ` ${off}`;
      }
    }
    assert.equal(onsets.length, seq.length, `onsets at ${onsets.map((o) => o.toFixed(2))}`);
    onsets.forEach((o, i) => assert.ok(o - (0.5 + i * step) >= 0 && o - (0.5 + i * step) < 0.045, `onset ${i} late by ${o - (0.5 + i * step)}`));
    right.forEach((ok, i) => assert.ok(ok, `note ${i} (${seq[i]}) was not heard`));
    wrong.forEach((w, i) => assert.equal(w, '', `note ${i} (${seq[i]}): also accepted offsets${w}`));
  });
}

test('detectPitch: 2048-sample window is accurate from D2 up, and mistuned strings read true', () => {
  for (const sr of [44100, 48000]) for (let midi = 38; midi <= 88; midi++) for (const cents of [-35, 0, 20]) {
    const out = new Float32Array(sr / 2);
    const f = midiToFreq(midi) * Math.pow(2, cents / 1200);
    // pluck() takes a MIDI number, so detune through a fractional one
    pluck(out, sr, 69 + 12 * Math.log2(f / 440), 0, 0.3, midi);
    const r = detectPitch(out.subarray(4096, 4096 + 2048), sr, { minHz: 65, maxHz: 1500 });
    const err = 1200 * Math.log2(r.freq / f);
    assert.ok(r.freq > 0 && Math.abs(err) < 6, `midi ${midi} ${cents}c @${sr}: got ${r.freq.toFixed(2)} wanted ${f.toFixed(2)} (${err.toFixed(1)}c)`);
  }
});

test('notePresence: silence and noise give nothing', () => {
  const sr = 48000;
  const noise = new Float32Array(8192);
  let s = 7;
  for (let i = 0; i < noise.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; noise[i] = (s / 0xffffffff * 2 - 1) * 0.2; }
  assert.equal(yes(notePresence(noise, sr, CHORDS.Em)), 0);
  assert.deepEqual(notePresence(new Float32Array(8192), sr, [40, 47]), [0, 0]);
});
