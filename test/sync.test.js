import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tabToAudio,
  audioToTab,
  addAnchor,
  removeAnchor,
  shiftAll,
  fromOffsetAndScale
} from '../js/sync.js';

test('sync: 0 anchors is identity, 1 anchor is constant offset', () => {
  const empty = { anchors: [] };
  assert.equal(tabToAudio(empty, 5.25), 5.25);
  assert.equal(audioToTab(empty, 5.25), 5.25);

  const one = { anchors: [{ tab: 2.0, audio: 2.5 }] };
  assert.ok(Math.abs(tabToAudio(one, 10.0) - 10.5) < 1e-9);
  assert.ok(Math.abs(audioToTab(one, 10.5) - 10.0) < 1e-9);
});

test('sync: 2+ anchors piecewise linear interpolation & extrapolation, round-trip accuracy', () => {
  const sync = { anchors: [] };
  assert.equal(addAnchor(sync, 0, 1.0).ok, true);
  assert.equal(addAnchor(sync, 10, 11.0).ok, true); // slope 1.0
  assert.equal(addAnchor(sync, 20, 31.0).ok, true); // slope 2.0

  // Midpoint of first segment
  assert.ok(Math.abs(tabToAudio(sync, 5) - 6.0) < 1e-9);
  // Midpoint of second segment
  assert.ok(Math.abs(tabToAudio(sync, 15) - 21.0) < 1e-9);
  // Extrapolation past end (slope 2.0)
  assert.ok(Math.abs(tabToAudio(sync, 25) - 41.0) < 1e-9);
  // Extrapolation before start (slope 1.0)
  assert.ok(Math.abs(tabToAudio(sync, -2) - -1.0) < 1e-9);

  for (const t of [-2, 0, 3.3, 10, 14.7, 20, 28]) {
    const a = tabToAudio(sync, t);
    const back = audioToTab(sync, a);
    assert.ok(Math.abs(back - t) < 1e-9);
  }
});

test('sync: addAnchor replaces within 0.05s, rejects non-monotonic anchors, removeAnchor & shiftAll', () => {
  const sync = fromOffsetAndScale(0.5, 1.0, 20);
  // Replace anchor near tab=0 (0.02s < 0.05s)
  const rep = addAnchor(sync, 0.02, 0.6);
  assert.equal(rep.ok, true);
  assert.equal(sync.anchors.length, 2);

  // Reject non-monotonic audio time (audio=0.1 at tab=10 is <= 0.6 at tab=0.02)
  const bad = addAnchor(sync, 10, 0.1);
  assert.equal(bad.ok, false);
  assert.ok(bad.reason.length > 0);

  shiftAll(sync, 1.0);
  assert.ok(Math.abs(sync.anchors[0].audio - 1.6) < 1e-9);

  removeAnchor(sync, 0);
  assert.equal(sync.anchors.length, 1);
});
