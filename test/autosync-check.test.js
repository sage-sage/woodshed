import test from 'node:test';
import assert from 'node:assert/strict';
import { isSparseTrack, sparseSongWarning, checkAutoSyncSpread, firstSoundTime } from '../js/autosync-check.js';
import { sparseTrackWarning } from '../js/import.js';

test('a 21-note track over 92 bars is flagged before auto-sync; a real guitar part is not', () => {
  const sparse = { notes: Array.from({ length: 21 }, (_, i) => ({ t: i * 7 })), bars: Array.from({ length: 92 }, (_, i) => ({ t: i * 2 })) };
  assert.match(sparseSongWarning(sparse), /only 21 notes in 92 bars, probably not the guitar part/);
  const full = { notes: Array.from({ length: 346 }, (_, i) => ({ t: i * 0.4 })), bars: Array.from({ length: 105 }, (_, i) => ({ t: i * 1.5 })) };
  assert.equal(sparseSongWarning(full), '');
  assert.equal(isSparseTrack(23, 10), true);
  assert.equal(isSparseTrack(24, 10), false);
  assert.match(sparseTrackWarning(21, 92), /only 21 notes in 92 bars/);
  assert.equal(sparseTrackWarning(346, 105), '');
});

test('a sync that follows the music passes', () => {
  const anchors = Array.from({ length: 60 }, (_, i) => ({ tab: i * 3, audio: 4 + i * 3 * 1.03 }));
  const r = checkAutoSyncSpread(anchors, { songDuration: 180, audioDuration: 190 });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.coverage > 0.9);
});

test('bar pins bunched into the last seconds (the empty-track failure) are rejected', () => {
  // 92 bars of 2 s: bars 1-88 squeezed into 150-152 s, the last few spread normally to the end.
  const anchors = [];
  for (let b = 0; b < 88; b++) anchors.push({ tab: b * 2, audio: 150 + b * (2 / 88) });
  for (let b = 88; b < 92; b++) anchors.push({ tab: b * 2, audio: 152 + (b - 88) * 2 });
  const r = checkAutoSyncSpread(anchors, { songDuration: 184, audioDuration: 160 });
  assert.equal(r.ok, false);
});

test('a short slice of the recording is rejected for a full-length tab, but allowed when searching on', () => {
  const anchors = Array.from({ length: 10 }, (_, i) => ({ tab: i * 2, audio: 100 + i * 2 }));
  assert.equal(checkAutoSyncSpread(anchors, { songDuration: 180, audioDuration: 190 }).ok, false);
  assert.equal(checkAutoSyncSpread(anchors, { songDuration: 180, audioDuration: 0 }).ok, true);
  assert.equal(checkAutoSyncSpread([{ tab: 0, audio: 1 }], {}).ok, false);
  assert.equal(checkAutoSyncSpread([{ tab: 0, audio: 1 }, { tab: 10, audio: 40 }], {}).ok, false);
});

test('firstSoundTime finds where the music starts', () => {
  const sr = 1000;
  const s = new Float32Array(5 * sr);
  for (let i = Math.round(1.2 * sr); i < s.length; i++) s[i] = 0.5 * Math.sin(i * 0.3);
  const t = firstSoundTime(s, sr);
  assert.ok(Math.abs(t - 1.2) <= 0.05, `got ${t}`);
  assert.equal(firstSoundTime(new Float32Array(100), sr), 0);
});
