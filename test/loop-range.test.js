import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBarInput, clampLoopRange, loopTimes, defaultLoopRange } from '../js/loop-range.js';
import { migrateSettings, DEFAULT_SETTINGS } from '../js/store.js';

test('parseBarInput: numbers are rounded and clamped to 1..total, junk is null', () => {
  assert.equal(parseBarInput('3', 8), 3);
  assert.equal(parseBarInput(' 5 ', 8), 5);
  assert.equal(parseBarInput('0', 8), 1);
  assert.equal(parseBarInput('-4', 8), 1);
  assert.equal(parseBarInput('99', 8), 8);
  assert.equal(parseBarInput('2.6', 8), 3);
  assert.equal(parseBarInput('', 8), null);
  assert.equal(parseBarInput('abc', 8), null);
  assert.equal(parseBarInput('3x', 8), null);
  assert.equal(parseBarInput('1e3', 8), null);
  assert.equal(parseBarInput(null, 8), null);
  assert.equal(parseBarInput('4', 0), 1, 'a song with no bars still clamps to bar 1');
});

test('clampLoopRange: the edited box wins when start passes end', () => {
  assert.deepEqual(clampLoopRange(2, 5, 8), { barStart: 2, barEnd: 5 });
  assert.deepEqual(clampLoopRange(6, 4, 8, 'start'), { barStart: 6, barEnd: 6 });
  assert.deepEqual(clampLoopRange(6, 4, 8, 'end'), { barStart: 4, barEnd: 4 });
  assert.deepEqual(clampLoopRange(0, 40, 8), { barStart: 1, barEnd: 8 });
  assert.deepEqual(clampLoopRange(3, 3, 8), { barStart: 3, barEnd: 3 });
});

test('clampLoopRange: missing values fall back to the previous range, then to start + 3 bars', () => {
  const prev = { barStart: 2, barEnd: 4 };
  assert.deepEqual(clampLoopRange(NaN, 7, 8, 'end', prev), { barStart: 2, barEnd: 7 });
  assert.deepEqual(clampLoopRange(3, NaN, 8, 'start', prev), { barStart: 3, barEnd: 4 });
  assert.deepEqual(clampLoopRange(3, NaN, 8, 'start'), { barStart: 3, barEnd: 6 });
  assert.deepEqual(clampLoopRange(7, NaN, 8, 'start'), { barStart: 7, barEnd: 8 });
  assert.deepEqual(clampLoopRange(NaN, NaN, 8, 'start'), { barStart: 1, barEnd: 4 });
});

test('loopTimes and defaultLoopRange', () => {
  const bars = [0, 1, 2, 3].map((i) => ({ t: i * 2, dur: 2 }));
  assert.deepEqual(loopTimes(bars, 2, 3), { barStart: 2, barEnd: 3, t0: 2, t1: 6 });
  assert.equal(loopTimes(bars, 2, 9), null);
  assert.deepEqual(defaultLoopRange(1, 8), { barStart: 1, barEnd: 4 });
  assert.deepEqual(defaultLoopRange(7, 8), { barStart: 7, barEnd: 8 });
});

test('settings: fingering is off by default for new users', () => {
  assert.equal(DEFAULT_SETTINGS.showFingering, false);
  assert.equal(DEFAULT_SETTINGS.fingeringOffMigrated, true);
});

test('settings migration: turns fingering off once for existing users, then respects their choice', () => {
  // Saved by an older version: fingering never chosen (absent) or left on.
  for (const old of [{ setupDone: true }, { setupDone: true, showFingering: true }]) {
    const { settings, changed } = migrateSettings(old);
    assert.equal(changed, true);
    assert.equal(settings.showFingering, false);
    assert.equal(settings.fingeringOffMigrated, true);
    assert.equal(settings.setupDone, true, 'other settings survive');
  }
  // Already migrated and the user turned it back on: leave it alone.
  const mine = { fingeringOffMigrated: true, showFingering: true };
  const again = migrateSettings(mine);
  assert.equal(again.changed, false);
  assert.equal(again.settings.showFingering, true);
  // Bad saved data does not throw.
  assert.equal(migrateSettings(null).settings.showFingering, false);
});
