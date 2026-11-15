// End to end: real tab text grabbed from a live tab site -> the extension's cleaning -> Woodshed's own parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalize, toWoodshedText, detectCapo, detectTuning } from '../lib/clean.js';
import { parseAsciiTab } from '../../woodshed/js/tab-ascii.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').replace(/^﻿/, '');

test('Ultimate Guitar (Wonderwall, grabbed 2026-11-13) parses in Woodshed with title, capo and notes', () => {
  const raw = fixture('ug-wonderwall.txt');
  const text = toWoodshedText({ title: 'Wonderwall', artist: 'Oasis', bpm: null, text: normalize(raw) });
  const song = parseAsciiTab(text, { capo: detectCapo(raw, 2) ?? 0 });
  assert.equal(song.title, 'Wonderwall');
  assert.equal(song.artist, 'Oasis');
  assert.deepEqual(song.tuning, [40, 45, 50, 55, 59, 64]);
  assert.ok(song.notes.length > 200, `only ${song.notes.length} notes`);
  assert.ok(song.bars.length >= 16, `only ${song.bars.length} bars`);
  assert.equal(detectCapo(raw), 2);
  assert.ok(['', 'E A D G B E'].includes(detectTuning(raw)));
  // the first riff: high E and B strings both on fret 3, G string open
  const first = song.notes.filter((n) => n.t === song.notes[0].t).map((n) => n.fret).sort();
  assert.ok(first.includes(3) && first.includes(0), `first chord frets ${first}`);
});
