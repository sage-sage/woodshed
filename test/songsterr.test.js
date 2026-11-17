import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { songsterrToSong, describeSongsterr, songsterrVideoAnchors } from '../js/songsterr.js';

const STD_TUNING_HIGH_LOW = [64, 59, 55, 50, 45, 40];

function makeNotation(overrides = {}) {
  return {
    format: 'songsterr',
    version: 1,
    songId: 1001,
    revisionId: 1,
    partId: 0,
    name: 'Lead Guitar',
    instrument: 'Overdriven Guitar',
    instrumentId: 29,
    strings: 6,
    tuning: STD_TUNING_HIGH_LOW,
    automations: {
      tempo: [{ measure: 0, position: 0, bpm: 120, type: 4 }]
    },
    measures: [],
    ...overrides
  };
}

describe('songsterrVideoAnchors', () => {
  it('maps 3 bars + 5 points to 4 anchors including song duration end anchor', () => {
    const song = { bars: [{ t: 0 }, { t: 2 }, { t: 4 }], duration: 6 };
    const anchors = songsterrVideoAnchors(song, [1.5, 3.5, 5.5, 7.5, 9.0]);
    assert.deepEqual(anchors, [
      { tab: 0, audio: 1.5 },
      { tab: 2, audio: 3.5 },
      { tab: 4, audio: 5.5 },
      { tab: 6, audio: 7.5 }
    ]);
  });

  it('maps available points when fewer points than bars are provided', () => {
    const song = { bars: [{ t: 0 }, { t: 2 }, { t: 4 }, { t: 6 }], duration: 8 };
    const anchors = songsterrVideoAnchors(song, [0.5, 2.5]);
    assert.deepEqual(anchors, [
      { tab: 0, audio: 0.5 },
      { tab: 2, audio: 2.5 }
    ]);
  });

  it('drops non-increasing audio points to keep anchors strictly monotonic', () => {
    const song = { bars: [{ t: 0 }, { t: 2 }, { t: 4 }, { t: 6 }], duration: 8 };
    const anchors = songsterrVideoAnchors(song, [1.0, 3.0, 3.0, 2.5, 5.0]);
    assert.deepEqual(anchors, [
      { tab: 0, audio: 1.0 },
      { tab: 2, audio: 3.0 },
      { tab: 8, audio: 5.0 }
    ]);
  });

  it('returns an empty array when fewer than 2 anchors survive or input is invalid', () => {
    const song = { bars: [{ t: 0 }, { t: 2 }], duration: 4 };
    assert.deepEqual(songsterrVideoAnchors(song, [2.0, 2.0, 1.0]), []);
    assert.deepEqual(songsterrVideoAnchors(song, [1.0]), []);
    assert.deepEqual(songsterrVideoAnchors(null, [1.0, 2.0]), []);
    assert.deepEqual(songsterrVideoAnchors({ bars: [] }, [1.0, 2.0]), []);
    assert.deepEqual(songsterrVideoAnchors(song, null), []);
  });
});

describe('songsterrToSong', () => {
  it('(a) converts 2 bars of 4/4 quarter notes at 120 bpm into 8 notes at 0.5s intervals', () => {
    const qBeat = (fret) => ({
      duration: [1, 4],
      notes: [{ string: 5, fret }]
    });
    const notation = makeNotation({
      measures: [
        { signature: [4, 4], marker: { text: 'Intro' }, voices: [{ beats: [qBeat(0), qBeat(2), qBeat(3), qBeat(5)] }] },
        { voices: [{ beats: [qBeat(7), qBeat(5), qBeat(3), qBeat(2)] }] }
      ]
    });

    const song = songsterrToSong(notation, { title: 'Test Riff', artist: 'Test Band' });
    assert.equal(song.title, 'Test Riff');
    assert.equal(song.artist, 'Test Band');
    assert.equal(song.source, 'songsterr');
    assert.equal(song.exactRhythm, true);
    assert.equal(song.bpm, 120);
    assert.equal(song.instrument.program, 29);
    assert.equal(song.notes.length, 8);

    song.notes.forEach((n, idx) => {
      assert.ok(Math.abs(n.t - idx * 0.5) < 1e-6, `note ${idx} time ${n.t}`);
      assert.ok(Math.abs(n.dur - 0.5) < 1e-6, `note ${idx} dur ${n.dur}`);
    });

    assert.equal(song.bars.length, 2);
    assert.ok(Math.abs(song.bars[0].t - 0) < 1e-6);
    assert.ok(Math.abs(song.bars[0].dur - 2.0) < 1e-6);
    assert.equal(song.bars[0].label, 'Intro');
    assert.ok(Math.abs(song.bars[1].t - 2.0) < 1e-6);
    assert.ok(Math.abs(song.bars[1].dur - 2.0) < 1e-6);
    assert.ok(Math.abs(song.duration - 4.0) < 1e-6);
  });

  it('(b) handles dotted durations and extends tied note duration while keeping tie:true note', () => {
    const notation = makeNotation({
      measures: [
        {
          signature: [4, 4],
          voices: [
            {
              beats: [
                { duration: [3, 8], dots: 1, notes: [{ string: 4, fret: 5 }] },
                { duration: [1, 8], notes: [{ string: 4, fret: 5, tie: true }] },
                { duration: [1, 2], notes: [{ string: 4, fret: 7 }] }
              ]
            }
          ]
        }
      ]
    });

    const song = songsterrToSong(notation);
    assert.equal(song.notes.length, 3);
    // Dotted quarter (0.75s) + tied eighth (0.25s) = 1.0s total duration on the first note
    assert.ok(Math.abs(song.notes[0].t - 0) < 1e-6);
    assert.ok(Math.abs(song.notes[0].dur - 1.0) < 1e-6);
    assert.equal(song.notes[0].tie, false);

    assert.ok(Math.abs(song.notes[1].t - 0.75) < 1e-6);
    assert.ok(Math.abs(song.notes[1].dur - 0.25) < 1e-6);
    assert.equal(song.notes[1].tie, true);

    assert.ok(Math.abs(song.notes[2].t - 1.0) < 1e-6);
    assert.ok(Math.abs(song.notes[2].dur - 1.0) < 1e-6);
  });

  it('(c) spaces eighth triplets at 1/3-beat steps and ignores mismatched tuplets', () => {
    const trip = (fret) => ({ duration: [1, 8], tuplet: 3, notes: [{ string: 3, fret }] });
    const q = (fret) => ({ duration: [1, 4], notes: [{ string: 3, fret }] });
    const notation = makeNotation({
      measures: [
        {
          signature: [4, 4],
          voices: [{ beats: [trip(0), trip(2), trip(4), q(5), q(7), q(9)] }]
        }
      ]
    });

    const song = songsterrToSong(notation);
    // At 120 bpm, 1 quarter beat = 0.5s, so each triplet eighth = 0.5 / 3 s
    assert.ok(Math.abs(song.notes[0].t - 0) < 1e-6);
    assert.ok(Math.abs(song.notes[1].t - (0.5 / 3)) < 1e-6);
    assert.ok(Math.abs(song.notes[2].t - (1.0 / 3)) < 1e-6);
    assert.ok(Math.abs(song.notes[3].t - 0.5) < 1e-6);
  });

  it('(c2) reads Songsterr triplets whose durations already include the tuplet ([1,12])', () => {
    const trip = (fret) => ({ duration: [1, 12], tuplet: 3, notes: [{ string: 3, fret }] });
    const q = (fret) => ({ duration: [1, 4], notes: [{ string: 3, fret }] });
    const notation = makeNotation({
      measures: [{ signature: [4, 4], voices: [{ beats: [trip(0), trip(2), trip(4), q(5), q(7), q(9)] }] }]
    });
    const song = songsterrToSong(notation);
    assert.ok(Math.abs(song.notes[1].t - (0.5 / 3)) < 1e-6);
    assert.ok(Math.abs(song.notes[3].t - 0.5) < 1e-6);
    assert.ok(Math.abs(song.notes[5].t - 1.5) < 1e-6);
  });

  it('(d) expands repeatStart/repeatClose with alternate endings in playback order', () => {
    const barNote = (fret) => ({
      voices: [{ beats: [{ duration: [1, 1], notes: [{ string: 5, fret }] }] }]
    });
    const notation = makeNotation({
      measures: [
        { signature: [4, 4], ...barNote(1) },
        { repeatStart: true, ...barNote(2) },
        { alternateEnding: [1], repeatClose: 2, ...barNote(3) },
        { alternateEnding: [2], ...barNote(4) },
        { ...barNote(5) }
      ]
    });

    const song = songsterrToSong(notation);
    // Expected bar order: m0(1), m1(2), m2(3), m1(2), m3(4), m4(5)
    assert.deepEqual(song.notes.map((n) => n.fret), [1, 2, 3, 2, 4, 5]);
    assert.equal(song.bars.length, 6);
  });

  it('(e) updates bar lengths on time signature changes (3/4 then 4/4)', () => {
    const notation = makeNotation({
      measures: [
        {
          signature: [3, 4],
          voices: [{ beats: [{ duration: [3, 4], notes: [{ string: 5, fret: 0 }] }] }]
        },
        {
          signature: [4, 4],
          voices: [{ beats: [{ duration: [1, 1], notes: [{ string: 5, fret: 2 }] }] }]
        }
      ]
    });

    const song = songsterrToSong(notation);
    assert.equal(song.bars[0].num, 3);
    assert.equal(song.bars[0].den, 4);
    assert.ok(Math.abs(song.bars[0].dur - 1.5) < 1e-6);
    assert.equal(song.bars[1].num, 4);
    assert.equal(song.bars[1].den, 4);
    assert.ok(Math.abs(song.bars[1].t - 1.5) < 1e-6);
    assert.ok(Math.abs(song.bars[1].dur - 2.0) < 1e-6);
  });

  it('(f) applies tempo changes at measure 2 and splits mid-measure tempo changes', () => {
    const notation = makeNotation({
      automations: {
        tempo: [
          { measure: 0, position: 0, bpm: 120, type: 4 },
          { measure: 1, position: 0, bpm: 60, type: 4 }
        ]
      },
      measures: [
        {
          signature: [4, 4],
          voices: [{ beats: [{ duration: [1, 2], notes: [{ string: 5, fret: 0 }] }, { duration: [1, 2], notes: [{ string: 5, fret: 2 }] }] }]
        },
        {
          voices: [{ beats: [{ duration: [1, 2], notes: [{ string: 5, fret: 3 }] }, { duration: [1, 2], notes: [{ string: 5, fret: 5 }] }] }]
        }
      ]
    });

    const song = songsterrToSong(notation);
    assert.equal(song.bars[0].bpm, 120);
    assert.ok(Math.abs(song.bars[0].dur - 2.0) < 1e-6);
    assert.equal(song.bars[1].bpm, 60);
    assert.ok(Math.abs(song.bars[1].dur - 4.0) < 1e-6);
    assert.ok(Math.abs(song.notes[2].t - 2.0) < 1e-6);
    assert.ok(Math.abs(song.notes[3].t - 4.0) < 1e-6);
  });

  it('(g) reverses high-to-low tuning to low-to-high strings and computes MIDI + natural harmonics', () => {
    const notation = makeNotation({
      measures: [
        {
          signature: [4, 4],
          voices: [
            {
              beats: [
                { duration: [1, 4], notes: [{ string: 5, fret: 0 }] },
                { duration: [1, 4], notes: [{ string: 0, fret: 3 }] },
                { duration: [1, 4], notes: [{ string: 5, fret: 7, harmonic: true }] },
                { duration: [1, 4], notes: [{ string: 5, fret: 5, harmonic: true }] }
              ]
            }
          ]
        }
      ]
    });

    const desc = describeSongsterr(notation);
    assert.deepEqual(desc.tracks[0].tuning, [40, 45, 50, 55, 59, 64]);
    assert.equal(desc.tracks[0].noteCount, 4);

    const song = songsterrToSong(notation);
    assert.deepEqual(song.tuning, [40, 45, 50, 55, 59, 64]);
    // string 5 in Songsterr = string 0 (low E2 = 40)
    assert.equal(song.notes[0].string, 0);
    assert.equal(song.notes[0].midi, 40);
    // string 0 in Songsterr = string 5 (high E4 = 64) + fret 3 = 67
    assert.equal(song.notes[1].string, 5);
    assert.equal(song.notes[1].midi, 67);
    // natural harmonic at fret 7 -> +19 (59), at fret 5 -> +24 (64)
    assert.equal(song.notes[2].midi, 59);
    assert.equal(song.notes[3].midi, 64);

    assert.throws(() => songsterrToSong(makeNotation({ strings: 3, tuning: [50, 45, 40] })), /4 to 8/);
    assert.throws(() => songsterrToSong(makeNotation({ measures: [] })), /no playable notes/i);
  });
});
