import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectKey,
  bestScales,
  nameChord,
  chordsByBar,
  romanNumeral,
  harmonicFunction,
  analyzeSong,
  scaleFretboard
} from '../js/theory.js';
import { parseAsciiTab } from '../js/tab-ascii.js';
import { DEMO_SONG_TAB, TUNINGS, makeSong, skeletonSong } from '../js/song.js';

test('detectKey: E minor riff does NOT come out as G major and exposes relative key', () => {
  const emTab = [
    'e|-----------------|-----------------|',
    'B|-----------------|-----------------|',
    'G|-----------------|-----------------|',
    'D|---------2-------|---------0-------|',
    'A|-----2-----2---2-|-----2-----2-----|',
    'E|-0-0---0-----0---|-3-3---3-----2-0-|'
  ].join('\n');
  const song = parseAsciiTab(emTab, { bpm: 120 });
  const key = detectKey(song.notes);
  assert.equal(key.tonic, 4); // E = 4
  assert.equal(key.mode, 'minor');
  assert.deepEqual(key.relative, { tonic: 7, mode: 'major' }); // G major
  assert.ok(key.confidence > 0 && key.confidence < 1);
});

test('detectKey: keeps A minor when major V chord (E with G#) appears', () => {
  // Am -> G -> F -> E (Andalusian cadence with G# leading tone)
  const song = makeSong({
    bpm: 110,
    notes: [
      // Bar 1: Am
      { t: 0.0, dur: 0.5, midi: 45 }, { t: 0.5, dur: 0.5, midi: 52 },
      { t: 1.0, dur: 0.5, midi: 57 }, { t: 1.5, dur: 0.5, midi: 60 },
      // Bar 2: G
      { t: 2.0, dur: 0.5, midi: 43 }, { t: 2.5, dur: 0.5, midi: 50 },
      { t: 3.0, dur: 0.5, midi: 55 }, { t: 3.5, dur: 0.5, midi: 59 },
      // Bar 3: F
      { t: 4.0, dur: 0.5, midi: 41 }, { t: 4.5, dur: 0.5, midi: 48 },
      { t: 5.0, dur: 0.5, midi: 53 }, { t: 5.5, dur: 0.5, midi: 57 },
      // Bar 4: E major (with G# = 56)
      { t: 6.0, dur: 0.5, midi: 40 }, { t: 6.5, dur: 0.5, midi: 47 },
      { t: 7.0, dur: 0.5, midi: 52 }, { t: 7.5, dur: 0.5, midi: 56 }
    ]
  });
  const key = detectKey(song.notes);
  assert.equal(key.tonic, 9); // A = 9
  assert.equal(key.mode, 'minor');
  assert.deepEqual(key.relative, { tonic: 0, mode: 'major' });
});

test('bestScales: pure minor pentatonic riff reports minor pentatonic first with notes and degrees', () => {
  // A minor pentatonic: A(57), C(60), D(62), E(64), G(67)
  const pcs = [57, 60, 62, 64, 67, 64, 62, 60, 57];
  const notes = pcs.map((midi, i) => ({
    t: i * 0.25,
    dur: 0.25,
    string: 0,
    fret: 0,
    midi,
    dead: false,
    tie: false
  }));
  const ranked = bestScales(notes, 9); // A = 9
  assert.equal(ranked[0].name, 'minor pentatonic');
  assert.equal(ranked[0].coverage, 1);
  assert.deepEqual(ranked[0].degrees, ['1', 'b3', '4', '5', 'b7']);
  assert.deepEqual(ranked[0].notes, [9, 0, 2, 4, 7]);
  assert.equal(ranked[0].adds.length, 0);
});

test('bestScales: minor-pentatonic riff with added F reports minor pentatonic + adds on natural minor', () => {
  // Mostly A minor pentatonic with one brief F(53)
  const midis = [45, 57, 60, 62, 64, 67, 64, 60, 53, 57];
  const notes = midis.map((midi, i) => ({
    t: i * 0.25,
    dur: i === 8 ? 0.125 : 0.35,
    string: 0,
    fret: 0,
    midi,
    dead: false,
    tie: false
  }));
  const ranked = bestScales(notes, 9); // A = 9
  assert.equal(ranked[0].name, 'minor pentatonic');
  const natMinor = ranked.find((s) => s.name === 'natural minor');
  assert.ok(natMinor);
  assert.ok(Math.abs(natMinor.coverage - 1) < 1e-9);
  assert.deepEqual(
    natMinor.adds.map((a) => ({ degree: a.degree, note: a.note })),
    [
      { degree: '2', note: 'B' },
      { degree: 'b6', note: 'F' }
    ]
  );
});

test('nameChord & chordsByBar: A minor arpeggio bar is "Am" and Bb spells with flat in D minor', () => {
  const demoSong = parseAsciiTab(DEMO_SONG_TAB, { bpm: 112 });
  const demoChords = chordsByBar(demoSong);
  assert.equal(demoChords[0].chord.name, 'Am');

  const am7 = nameChord([45, 52, 55, 60, 64]); // A, E, G, C, E
  assert.equal(am7.name, 'Am7');
  assert.equal(am7.root, 9);

  const e5 = nameChord([40, 47, 52]); // E2, B2, E3
  assert.equal(e5.name, 'E5');
  assert.equal(e5.type, '5');

  const cFirstInv = nameChord([40, 48, 55, 60]); // E in bass, C, G, C
  assert.equal(cFirstInv.root, 0);
  assert.equal(cFirstInv.inversion, 1);
  assert.equal(cFirstInv.name, 'C/E');

  // Bb major chord in D minor must spell Bb, not A#
  const dMinorKey = { tonic: 2, mode: 'minor' };
  const bbInDMinor = nameChord([46, 53, 58, 62], dMinorKey);
  assert.equal(bbInDMinor.name, 'Bb');

  const dmSong = makeSong({
    bpm: 100,
    notes: [
      // Bar 1: Dm (D3=50, A3=57, D4=62, F4=65)
      { t: 0.0, dur: 0.6, midi: 50 }, { t: 0.6, dur: 0.6, midi: 57 },
      { t: 1.2, dur: 0.6, midi: 62 }, { t: 1.8, dur: 0.6, midi: 65 },
      // Bar 2: Bb (Bb2=46, F3=53, Bb3=58, D4=62)
      { t: 2.4, dur: 0.6, midi: 46 }, { t: 3.0, dur: 0.6, midi: 53 },
      { t: 3.6, dur: 0.6, midi: 58 }, { t: 4.2, dur: 0.6, midi: 62 }
    ]
  });
  const dmChords = chordsByBar(dmSong);
  assert.equal(dmChords[0].chord.name, 'Dm');
  assert.equal(dmChords[1].chord.name, 'Bb');
});

test('harmonicFunction: E major in A minor is V with harmonic-minor leading tone reason', () => {
  const aMinorKey = { tonic: 9, mode: 'minor' };
  const eMajor = { root: 4, type: 'maj', name: 'E', bass: 4, inversion: 0 };
  const amChord = { root: 9, type: 'min', name: 'Am', bass: 9, inversion: 0 };

  assert.equal(romanNumeral(eMajor, aMinorKey), 'V');
  const hf = harmonicFunction(eMajor, aMinorKey, amChord);
  assert.equal(hf.role, 'dominant');
  assert.match(hf.reason, /harmonic minor/i);
  assert.match(hf.reason, /G#/);
  assert.match(hf.reason, /Am/);

  // Secondary dominant V7/V (D7 -> G in C major)
  const cMajorKey = { tonic: 0, mode: 'major' };
  const d7 = { root: 2, type: '7', name: 'D7', bass: 2, inversion: 0 };
  const gMaj = { root: 7, type: 'maj', name: 'G', bass: 7, inversion: 0 };
  const secHf = harmonicFunction(d7, cMajorKey, gMaj);
  assert.equal(secHf.role, 'secondary dominant');
  assert.equal(secHf.function, 'V7/V');
  assert.match(secHf.reason, /D7/);
  assert.match(secHf.reason, /G/);
});

test('analyzeSong: Andalusian cadence Am-G-F-E is named accurately', () => {
  const barDur = 2.0; // 120 BPM 4/4
  const chordsSpec = [
    [45, 52, 57, 60], // Am
    [43, 50, 55, 59], // G
    [41, 48, 53, 57], // F
    [40, 47, 52, 56]  // E
  ];
  const notes = [];
  chordsSpec.forEach((voicing, b) => {
    voicing.forEach((midi, idx) => {
      notes.push({
        t: b * barDur + idx * 0.45,
        dur: 0.45,
        midi,
        string: idx,
        fret: 1
      });
    });
  });
  const song = makeSong({ bpm: 120, notes });
  const analysis = analyzeSong(song);
  assert.equal(analysis.key.tonic, 9);
  assert.equal(analysis.key.mode, 'minor');
  assert.deepEqual(analysis.progression, ['i', 'bVII', 'bVI', 'V']);
  assert.ok(analysis.knownProgression);
  assert.match(analysis.knownProgression.name, /Andalusian Cadence/i);
  assert.doesNotMatch(analysis.knownProgression.explanation, /by whole tones/i);
});

test('analyzeSong: 12-bar blues in A is detected on bar-by-bar roots', () => {
  const barDur = 2.0; // 120 BPM 4/4
  // Standard 12-bar blues in A: A7 x4, D7 x2, A7 x2, E7, D7, A7, E7
  const a7 = [45, 52, 55, 61];
  const d7 = [50, 57, 60, 66];
  const e7 = [40, 47, 50, 56];
  const twelveBars = [a7, a7, a7, a7, d7, d7, a7, a7, e7, d7, a7, e7];

  const notes = [];
  twelveBars.forEach((voicing, b) => {
    voicing.forEach((midi, idx) => {
      notes.push({
        t: b * barDur + idx * 0.45,
        dur: 0.45,
        midi,
        string: idx,
        fret: 2
      });
    });
  });
  const song = makeSong({ bpm: 120, notes });
  const analysis = analyzeSong(song);
  assert.ok(analysis.knownProgression);
  assert.match(analysis.knownProgression.name, /12-Bar Blues/i);
});

test('analyzeSong, romanNumeral, harmonicFunction, scaleFretboard, and skeletonSong on DEMO_SONG_TAB', () => {
  const song = parseAsciiTab(DEMO_SONG_TAB, { bpm: 112 });
  const analysis = analyzeSong(song);

  assert.equal(analysis.key.tonic, 9); // A
  assert.equal(analysis.key.mode, 'minor');
  assert.deepEqual(analysis.key.relative, { tonic: 0, mode: 'major' });
  assert.ok(analysis.chords.length >= 4);
  for (const c of analysis.chords) {
    assert.ok(typeof c.roman === 'string' && c.roman.length > 0);
    assert.ok(typeof c.function === 'string' && c.function.length > 0);
    assert.ok(typeof c.reason === 'string' && c.reason.length > 0);
  }

  assert.ok(analysis.stats);
  assert.ok(analysis.stats.pentatonicShare > 0 && analysis.stats.pentatonicShare <= 1);
  assert.ok(analysis.stats.tonicBassShare > 0);
  assert.ok(analysis.stats.hardestBar >= 1 && analysis.stats.hardestBar <= song.bars.length);
  assert.ok(Array.isArray(analysis.stats.repeats));
  assert.equal(analysis.stats.repeats[0].bars[0], 5);
  assert.equal(analysis.stats.repeats[0].of[0], 1);

  assert.ok(analysis.insights.length >= 6 && analysis.insights.length <= 10);
  for (const insight of analysis.insights) {
    assert.ok(insight.trim().length > 0);
    assert.match(insight, /^[A-Z][^:]+:\s+\S+/);
  }

  const amChord = { root: 9, type: 'min', name: 'Am' };
  const e7Chord = { root: 4, type: '7', name: 'E7' };
  assert.equal(romanNumeral(amChord, analysis.key), 'i');
  assert.equal(romanNumeral(e7Chord, analysis.key), 'V7');
  assert.equal(harmonicFunction(amChord, analysis.key).role, 'tonic');
  assert.equal(harmonicFunction(e7Chord, analysis.key).role, 'dominant');

  const fb = scaleFretboard(9, 'minor pentatonic', TUNINGS['Standard'], 0, 12);
  assert.ok(fb.length > 20);
  assert.ok(fb.some((cell) => cell.isRoot && cell.degree === 1));

  const lvl1 = skeletonSong(song, analysis, 1);
  const lvl2 = skeletonSong(song, analysis, 2);
  const lvl3 = skeletonSong(song, analysis, 3);
  assert.ok(lvl1.notes.length < lvl2.notes.length);
  assert.ok(lvl2.notes.length < lvl3.notes.length);
});
