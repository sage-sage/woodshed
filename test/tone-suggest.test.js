import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSong, TUNINGS } from '../js/song.js';
import { suggestTone } from '../js/tone-suggest.js';

function powerChordNotes(bars = 4, { pm = false, dropD = false } = {}) {
  // Standard tuning: E5 = low E open + A string fret 2. Drop D: D5 = the lowest two strings open (D2 + A2).
  const notes = [];
  for (let i = 0; i < bars; i++) {
    const t = i * 0.5;
    notes.push({ t, dur: 0.4, string: 0, fret: 0, tech: pm ? 'pm' : '' });
    notes.push({ t, dur: 0.4, string: 1, fret: dropD ? 0 : 2, tech: pm ? 'pm' : '' });
  }
  return notes;
}

function openTriadNotes(count = 4) {
  const notes = [];
  for (let i = 0; i < count; i++) {
    const t = i * 0.5;
    // C major triad: C3 (48), E3 (52), G3 (55)
    notes.push({ t, dur: 0.4, string: 1, fret: 3 });
    notes.push({ t, dur: 0.4, string: 2, fret: 2 });
    notes.push({ t, dur: 0.4, string: 3, fret: 0 });
  }
  return notes;
}

function leadNotes(count = 6) {
  const notes = [];
  for (let i = 0; i < count; i++) {
    notes.push({
      t: i * 0.4,
      dur: 0.35,
      string: 4,
      fret: 14,
      tech: i % 2 === 0 ? 'bend' : 'vib',
      bend: i % 2 === 0 ? 2 : 0
    });
  }
  return notes;
}

test('Rule 1: bass by 4-string bass tuning and by bass instrument program/name', () => {
  const byTuning = makeSong({
    tuning: TUNINGS['Bass Standard'],
    notes: [{ t: 0, dur: 0.5, string: 0, fret: 3 }]
  });
  const res1 = suggestTone(byTuning);
  assert.equal(res1.id, 'bass');
  assert.ok(res1.confidence > 0.7);
  assert.ok(res1.reasons.some((r) => /bass/i.test(r)));

  const byProgram = makeSong({
    instrument: { program: 34, name: 'Pick Bass' },
    notes: [{ t: 0, dur: 0.5, string: 0, fret: 3 }]
  });
  const res2 = suggestTone(byProgram);
  assert.equal(res2.id, 'bass');
  assert.ok(res2.reasons.some((r) => /bass/i.test(r)));
});

test('Rule 2: acoustic GM program 24/25 or acoustic name -> acoustic', () => {
  const song = makeSong({
    instrument: { program: 25, name: 'Steel Acoustic' },
    notes: openTriadNotes(4)
  });
  const res = suggestTone(song);
  assert.equal(res.id, 'acoustic');
  assert.ok(res.confidence >= 0.8);
  assert.ok(res.reasons.some((r) => /acoustic/i.test(r)));
});

test('Rule 3: jazz GM program 26 or jazz keyword -> jazz', () => {
  const song = makeSong({
    instrument: { program: 26, name: 'Hollowbody Jazz' },
    notes: openTriadNotes(4)
  });
  const res = suggestTone(song);
  assert.equal(res.id, 'jazz');
  assert.ok(res.reasons.some((r) => /jazz/i.test(r)));
});

test('Rule 4: distortion / metal -> high_gain vs metal based on low tuning or palm mutes + fast bpm', () => {
  const highGainSong = makeSong({
    instrument: { program: 30, name: 'Distortion Guitar' },
    tuning: TUNINGS['Standard'],
    bpm: 110,
    notes: openTriadNotes(4)
  });
  const resHighGain = suggestTone(highGainSong);
  assert.equal(resHighGain.id, 'high_gain');
  assert.ok(resHighGain.reasons.some((r) => /distortion/i.test(r)));

  const metalSong = makeSong({
    instrument: { program: 30, name: 'Metal Rhythm' },
    tuning: TUNINGS['Drop D'],
    bpm: 145,
    notes: powerChordNotes(6, { pm: true })
  });
  const resMetal = suggestTone(metalSong);
  assert.equal(resMetal.id, 'metal');
  assert.ok(resMetal.confidence > resHighGain.confidence);
  assert.ok(resMetal.reasons.some((r) => /drop-D/i.test(r)));
  assert.ok(resMetal.reasons.some((r) => /palm mutes/i.test(r)));
});

test('Rule 5: fuzz keyword -> fuzz', () => {
  const song = makeSong({
    instrument: { program: 29, name: 'Big Muff Fuzz' },
    notes: powerChordNotes(4)
  });
  const res = suggestTone(song);
  assert.equal(res.id, 'fuzz');
  assert.ok(res.reasons.some((r) => /fuzz/i.test(r)));
});

test('Rule 6: overdriven/crunch -> rock_lead when leadShare > 0.4, else crunch', () => {
  const crunchSong = makeSong({
    instrument: { program: 29, name: 'Overdrive Rhythm' },
    notes: powerChordNotes(4)
  });
  const resCrunch = suggestTone(crunchSong);
  assert.equal(resCrunch.id, 'crunch');
  assert.ok(resCrunch.reasons.some((r) => /overdriven/i.test(r)));

  const leadSong = makeSong({
    instrument: { program: 29, name: 'Crunch Solo' },
    notes: leadNotes(6)
  });
  const resLead = suggestTone(leadSong);
  assert.equal(resLead.id, 'rock_lead');
  assert.ok(resLead.reasons.some((r) => /lead/i.test(r)));
});

test('Rule 7: clean program/name -> breakup when powerShare > 0.3, else clean', () => {
  const cleanSong = makeSong({
    instrument: { program: 27, name: 'Clean Electric' },
    notes: openTriadNotes(4)
  });
  const resClean = suggestTone(cleanSong);
  assert.equal(resClean.id, 'clean');
  assert.ok(resClean.reasons.some((r) => /clean/i.test(r)));

  const breakupSong = makeSong({
    instrument: { program: 28, name: 'Clean' },
    notes: powerChordNotes(4)
  });
  const resBreakup = suggestTone(breakupSong);
  assert.equal(resBreakup.id, 'breakup');
  assert.ok(resBreakup.reasons.some((r) => /power chords/i.test(r)));
});

test('Rule 8: no instrument info falls back across all playing-style branches', () => {
  const noInstMetal = makeSong({
    tuning: TUNINGS['Drop D'],
    notes: powerChordNotes(4, { pm: true, dropD: true })
  });
  assert.equal(suggestTone(noInstMetal).id, 'metal');

  const noInstHighGain = makeSong({
    tuning: TUNINGS['Standard'],
    notes: powerChordNotes(4, { pm: true })
  });
  assert.equal(suggestTone(noInstHighGain).id, 'high_gain');

  const noInstCrunch = makeSong({
    tuning: TUNINGS['Standard'],
    notes: powerChordNotes(4, { pm: false })
  });
  const resCrunch = suggestTone(noInstCrunch);
  assert.equal(resCrunch.id, 'crunch');
  assert.ok(resCrunch.reasons.some((r) => /100% of chords are power chords/.test(r)));

  const noInstLead = makeSong({
    notes: leadNotes(6)
  });
  assert.equal(suggestTone(noInstLead).id, 'rock_lead');

  const noInstClean = makeSong({
    notes: openTriadNotes(4)
  });
  assert.equal(suggestTone(noInstClean).id, 'clean');

  const noInstBreakup = makeSong({
    notes: [
      { t: 0, dur: 0.5, string: 0, fret: 3 },
      { t: 0.5, dur: 0.5, string: 1, fret: 5 }
    ]
  });
  const resBreakup = suggestTone(noInstBreakup);
  assert.equal(resBreakup.id, 'breakup');
  assert.ok(resBreakup.reasons.length >= 1 && resBreakup.reasons.length <= 3);
});
