import test from 'node:test';
import assert from 'node:assert/strict';
import { createTunerSettler } from '../js/tuner-settle.js';

const cents = (f, ref) => 1200 * Math.log2(f / ref);

// 1.5 s of an in-tune A (110 Hz) decaying slowly, then a mute: pitch jumps +25 cents for `muteFrames` frames.
function run({ muteFrames = 6, muteLevelDrop = true, fps = 60 } = {}) {
  const s = createTunerSettler();
  let t = 0, out = null;
  const dt = 1 / fps;
  for (let i = 0; i < 1.5 * fps; i++, t += dt) {
    const r = s.push({ t, freq: 110 * (1 + (Math.random() - 0.5) * 0.001), clarity: 0.95, rms: 0.2 * Math.exp(-t * 0.8) });
    if (r) out = r;
  }
  const level = 0.2 * Math.exp(-t * 0.8);
  for (let i = 0; i < muteFrames; i++, t += dt) {
    const r = s.push({ t, freq: 110 * 2 ** (25 / 1200), clarity: 0.9, rms: muteLevelDrop ? level * 0.6 ** (i + 1) : level });
    if (r) out = r;
  }
  const end = s.push({ t, freq: 0, clarity: 0, rms: 0.0001 });
  return { live: out, end };
}

test('a mute with a pitch jump settles on the pre-mute pitch', () => {
  const { end } = run();
  assert.equal(end.final, true);
  assert.ok(Math.abs(cents(end.freq, 110)) < 2, `settled ${cents(end.freq, 110).toFixed(1)} c`);
});

test('the jump is rolled back even when the level does not drop', () => {
  const { end } = run({ muteLevelDrop: false });
  assert.ok(Math.abs(cents(end.freq, 110)) < 2);
});

test('a short note still settles', () => {
  const s = createTunerSettler();
  for (let i = 0; i < 6; i++) s.push({ t: i / 60, freq: 82.41, clarity: 0.9, rms: 0.1 });
  const end = s.push({ t: 0.1, freq: 0, clarity: 0, rms: 0 });
  assert.ok(Math.abs(cents(end.freq, 82.41)) < 1);
});

test('nothing is reported before any note, and live readings follow the string', () => {
  const s = createTunerSettler();
  assert.equal(s.push({ t: 0, freq: 0, clarity: 0, rms: 0 }), null);
  let r;
  for (let i = 0; i < 10; i++) r = s.push({ t: i / 60, freq: 196, clarity: 0.9, rms: 0.1 });
  assert.equal(r.final, false);
  assert.ok(Math.abs(r.freq - 196) < 0.01);
});
