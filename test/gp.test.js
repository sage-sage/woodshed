import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadAlphaTab, scoreToSong, loadTabFile } from '../js/tab-gp.js';
import { buildEvents } from '../js/song.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

async function fromTex(file) {
  const at = await loadAlphaTab();
  const imp = new at.importer.AlphaTexImporter();
  imp.initFromString(fs.readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'), new at.Settings());
  return { at, score: imp.readScore() };
}

test('tab-gp: repeats are unrolled, tempo changes and string mapping are right', async () => {
  const { at, score } = await fromTex('repeat.alphatex');
  const song = scoreToSong(at, score, 0);
  assert.deepEqual(song.tuning, [40, 45, 50, 55, 59, 64]);
  assert.equal(song.exactRhythm, true);
  // 2 bars at 120 bpm played twice (8 s) + one whole-note bar at 60 bpm (4 s)
  assert.equal(song.bars.length, 5);
  near(song.duration, 12, 'duration');
  near(song.bars[4].t, 8, 'last bar start');
  assert.equal(song.bars[4].bpm, 60);
  near(song.bars[4].dur, 4, 'last bar length');

  const ev = buildEvents(song);
  // bar 1: E2 open, B2 (A string fret 2), E minor-ish triad on the top three strings
  near(ev[0].t, 0, 'first note'); assert.equal(ev[0].notes[0].midi, 40); assert.equal(ev[0].notes[0].string, 0);
  near(ev[1].t, 0.5, 'second note'); assert.equal(ev[1].notes[0].midi, 47); assert.equal(ev[1].notes[0].string, 1);
  near(ev[2].t, 1.0, 'chord'); assert.deepEqual(ev[2].notes.map((n) => n.midi).sort((a, b) => a - b), [57, 60, 64]);
  // the same bar again after the repeat
  const again = ev.filter((e) => e.notes.length === 3);
  assert.equal(again.length, 2); near(again[1].t, 5.0, 'chord on the repeat');
  // bar 2: hammer-on 3 -> 5 on the low string, natural harmonic at 12, bend of a whole step
  const bar2 = song.notes.filter((n) => n.t >= 2 && n.t < 4);
  assert.equal(bar2[1].tech, 'h'); assert.equal(bar2[1].midi, 45);
  assert.equal(bar2[2].midi, 55 + 12);
  assert.equal(bar2[3].tech, 'bend'); assert.equal(bar2[3].bend, 2);
  // final long note: D string fret 7 = A3, 4 s long
  const last = song.notes[song.notes.length - 1];
  assert.equal(last.midi, 57); near(last.t, 8, 'last note'); near(last.dur, 4, 'last note length');
});

test('tab-gp: unreadable files give a human error', async () => {
  await assert.rejects(() => loadTabFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /could not be read/);
});

test('tab-gp: the track instrument is kept for tone suggestions', async () => {
  const { at, score } = await fromTex('repeat.alphatex');
  score.tracks[0].playbackInfo.program = 30;
  score.tracks[0].name = 'Rhythm Dist';
  const song = scoreToSong(at, score, 0);
  assert.deepEqual(song.instrument, { program: 30, name: 'Rhythm Dist' });
});
