import test from 'node:test';
import assert from 'node:assert/strict';
import { pitchCurve } from '../js/synth.js';

test('pitchCurve: straight notes stay flat', () => {
  assert.deepEqual(pitchCurve({ midi: 60 }, 1), []);
});

test('pitchCurve: a bendCurve is laid over the note duration', () => {
  const c = pitchCurve({ bend: 2, bendCurve: [[0, 0], [0.5, 2], [1, 2]] }, 0.8);
  assert.deepEqual(c, [[0, 0], [0.4, 2], [0.8, 2]]);
});

test('pitchCurve: pre-bend starts at the peak; release comes back down', () => {
  const pre = pitchCurve({ bend: 1, prebend: true, release: true }, 1);
  assert.equal(pre[0][1], 1);
  assert.equal(pre[pre.length - 1][1], 0);
  const up = pitchCurve({ bend: 2 }, 1);
  assert.equal(up[0][1], 0);
  assert.equal(up[up.length - 1][1], 2);
});

test('pitchCurve: slides glide in from the previous note or a neighbour, and off the note', () => {
  assert.deepEqual(pitchCurve({ tech: 'slide' }, 1, -2), [[0, -2], [0.08, 0]]);
  assert.deepEqual(pitchCurve({ slideIn: 'above' }, 0.1), [[0, 3], [0.03, 0]].map(([t, s]) => [Math.round(t * 1000) / 1000, s]).map(([t, s]) => [t === 0.03 ? 0.1 * 0.3 : t, s]));
  const off = pitchCurve({ slideOut: 'down' }, 1);
  assert.deepEqual(off, [[0, 0], [0.85, 0], [1, -5]]);
  // Times never run backwards.
  const both = pitchCurve({ bend: 2, slideOut: 'up' }, 0.5);
  for (let i = 1; i < both.length; i++) assert.ok(both[i][0] >= both[i - 1][0]);
});
