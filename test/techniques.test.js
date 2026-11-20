// Slides, bends, hammer-ons/pull-offs and vibrato through every importer (ASCII, Songsterr, Guitar Pro).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAsciiTab } from '../js/tab-ascii.js';
import { songsterrToSong } from '../js/songsterr.js';
import { loadAlphaTab, scoreToSong } from '../js/tab-gp.js';
import { bendFromPoints, makeSong } from '../js/song.js';

/** Notes of a one-string ASCII tab on the high e string, in order. */
function hiE(line) {
  const tab = [
    `e|${line}|`,
    `B|${'-'.repeat(line.length)}|`,
    `G|${'-'.repeat(line.length)}|`,
    `D|${'-'.repeat(line.length)}|`,
    `A|${'-'.repeat(line.length)}|`,
    `E|${'-'.repeat(line.length)}|`
  ].join('\n');
  return parseAsciiTab(tab).notes;
}

test('bendFromPoints: peak, pre-bend and release', () => {
  assert.deepEqual(bendFromPoints([]), {});
  assert.deepEqual(bendFromPoints([{ pos: 0, semis: 0 }, { pos: 1, semis: 0 }]), {});
  const up = bendFromPoints([{ pos: 0, semis: 0 }, { pos: 1, semis: 2 }]);
  assert.equal(up.bend, 2); assert.equal(up.prebend, undefined); assert.equal(up.release, undefined);
  const br = bendFromPoints([{ pos: 0, semis: 0 }, { pos: 0.5, semis: 1 }, { pos: 1, semis: 0 }]);
  assert.equal(br.bend, 1); assert.equal(br.release, true);
  const pre = bendFromPoints([{ pos: 0, semis: 3 }, { pos: 1, semis: 0 }]);
  assert.equal(pre.bend, 3); assert.equal(pre.prebend, true); assert.equal(pre.release, true);
});

test('makeSong keeps technique fields and drops junk', () => {
  const s = makeSong({ notes: [{ t: 0, string: 5, fret: 7, bend: 2, bendCurve: [[0, 0], [1, 2]], release: true, slideIn: 'below', slideOut: 'sideways', vibrato: 1 }] });
  const n = s.notes[0];
  assert.equal(n.bend, 2); assert.deepEqual(n.bendCurve, [[0, 0], [1, 2]]); assert.equal(n.release, true);
  assert.equal(n.slideIn, 'below'); assert.equal(n.slideOut, undefined); assert.equal(n.vibrato, true);
  const plain = makeSong({ notes: [{ t: 0, string: 0, fret: 3, release: true }] }).notes[0];
  assert.equal(plain.release, undefined, 'a release without a bend is dropped');
});

test('ASCII slides: between notes, into a note and off a note', () => {
  let n = hiE('--5/7--7\\5--5s7--');
  assert.deepEqual(n.map((x) => x.fret), [5, 7, 7, 5, 5, 7]);
  assert.deepEqual(n.map((x) => x.tech), ['', 'slide', '', 'slide', '', 'slide']);

  n = hiE('--/7----\\9----');
  assert.equal(n[0].slideIn, 'below'); assert.equal(n[0].tech, '');
  assert.equal(n[1].slideIn, 'above');

  n = hiE('--7\\-----9/----');
  assert.equal(n.length, 2);
  assert.equal(n[0].slideOut, 'down');
  assert.equal(n[1].slideOut, 'up');

  n = hiE('--5-/-7--');
  assert.equal(n[1].tech, 'slide', 'dashes around the slash still connect the notes');
});

test('ASCII bends: target fret, bracketed target, fractions, release, pre-bend', () => {
  const cases = [
    ['--7b9---', 2, {}],
    ['--7b(9)-', 2, {}],
    ['--7b½---', 1, {}],
    ['--7b1/2-', 1, {}],
    ['--7b----', 2, {}],
    ['--5b6---', 1, {}],
    ['--7b10--', 3, {}],
    ['--7b1½--', 3, {}],
    ['--12b14r12--', 2, { release: true }],
    ['--7br---', 2, { release: true }],
    ['--7pb9--', 2, { prebend: true }],
    ['--7pb9r7--', 2, { prebend: true, release: true }]
  ];
  for (const [line, semis, flags] of cases) {
    const n = hiE(line);
    assert.equal(n.length, 1, `${line}: one note, the target is not another note`);
    assert.equal(n[0].tech, 'bend', line);
    assert.equal(n[0].bend, semis, `${line}: bend size`);
    assert.equal(Boolean(n[0].release), Boolean(flags.release), `${line}: release`);
    assert.equal(Boolean(n[0].prebend), Boolean(flags.prebend), `${line}: pre-bend`);
    assert.ok(Array.isArray(n[0].bendCurve), `${line}: has a curve`);
  }
  const bv = hiE('--7b9~--');
  assert.equal(bv[0].bend, 2); assert.equal(bv[0].vibrato, true);
});

test('ASCII hammer-on, pull-off, vibrato', () => {
  const n = hiE('--5h7p5--7~--');
  assert.deepEqual(n.map((x) => x.tech), ['', 'h', 'p', 'vib']);
});

function measure(beats) {
  return { signature: [4, 4], voices: [{ beats }] };
}
function beat(notes) {
  return { duration: [1, 4], notes };
}

test('Songsterr: hp and legato slides move to the destination note, slide in/out, bends', () => {
  const notation = {
    name: 'Lead', strings: 6, tuning: [64, 59, 55, 50, 45, 40], instrumentId: 29,
    automations: { tempo: [{ measure: 0, position: 0, bpm: 120 }] },
    measures: [
      measure([
        beat([{ string: 0, fret: 5, hp: true }]),
        beat([{ string: 0, fret: 7, hp: true }]),
        beat([{ string: 0, fret: 5, slide: 'legato' }]),
        beat([{ string: 0, fret: 9 }])
      ]),
      measure([
        beat([{ string: 1, fret: 7, slide: 'below' }]),
        beat([{ string: 1, fret: 9, slide: 'downwards' }]),
        beat([{ string: 2, fret: 7, bend: { tone: 100, points: [{ position: 0, tone: 0 }, { position: 30, tone: 100 }, { position: 60, tone: 0 }] } }]),
        beat([{ string: 2, fret: 9, bend: { tone: 50, points: [{ position: 0, tone: 50 }, { position: 60, tone: 50 }] }, leftHandVibrato: 'slight' }])
      ]),
      measure([
        { duration: [1, 2], notes: [{ string: 3, fret: 12, bend: { tone: 150, points: [{ position: 0, tone: 0 }, { position: 60, tone: 150 }] } }] },
        { duration: [1, 2], notes: [{ string: 3, fret: 12, tie: true, bend: { tone: 150, points: [{ position: 0, tone: 150 }, { position: 60, tone: 0 }] } }] }
      ])
    ]
  };
  const song = songsterrToSong(notation, { title: 'T' });
  const hi = song.notes.filter((n) => n.string === 5);
  assert.deepEqual(hi.map((n) => [n.fret, n.tech]), [[5, ''], [7, 'h'], [5, 'p'], [9, 'slide']]);

  const b = song.notes.filter((n) => n.string === 4);
  assert.equal(b[0].slideIn, 'below');
  assert.equal(b[1].slideOut, 'down');

  const g = song.notes.filter((n) => n.string === 3);
  assert.equal(g[0].tech, 'bend'); assert.equal(g[0].bend, 2); assert.equal(g[0].release, true);
  assert.equal(g[1].bend, 1); assert.equal(g[1].prebend, true); assert.equal(g[1].vibrato, true);

  const d = song.notes.filter((n) => n.string === 2);
  assert.equal(d[0].bend, 3, '1½-step bend');
  assert.equal(d[0].release, true, 'the release on the tied-over half belongs to the struck note');
  assert.equal(d[1].tie, true);
});

test('Guitar Pro (alphaTex): slides, slide in/out, bends with release and pre-bend', async () => {
  const at = await loadAlphaTab();
  const tex = '\\title "T" \\tempo 120 . :4 5.1{sl} 7.1 7.1{ss} 9.1 | 7.2{sib} 9.2{sod} 5.3{sia} 5.3{sou} | 7.3{b (0 4 0)} 7.3{b (4 4)} 7.3{b (0 2)} 7.3{b (0 6)}';
  const imp = new at.importer.AlphaTexImporter();
  imp.initFromString(tex, new at.Settings());
  const song = scoreToSong(at, imp.readScore(), 0);
  const e = song.notes.filter((n) => n.string === 5);
  assert.deepEqual(e.map((n) => [n.fret, n.tech]), [[5, ''], [7, 'slide'], [7, ''], [9, 'slide']]);
  const b = song.notes.filter((n) => n.string === 4);
  assert.equal(b[0].slideIn, 'below'); assert.equal(b[1].slideOut, 'down');
  const g = song.notes.filter((n) => n.string === 3);
  assert.equal(g[0].slideIn, 'above'); assert.equal(g[1].slideOut, 'up');
  const bends = g.slice(2);
  assert.deepEqual(bends.map((n) => n.bend), [2, 2, 1, 3]);
  assert.equal(bends[0].release, true);
  assert.equal(bends[1].prebend, true);
  assert.ok(!bends[2].release && !bends[2].prebend);
});
