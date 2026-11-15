import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAsciiTab, detectTabFormat } from '../js/tab-ascii.js';
import { buildEvents } from '../js/song.js';

test('parseAsciiTab: handles Drop D tuning detection, multi-digit frets, repeats, techniques, and lyrics', () => {
  const messyTab = String.raw`
# Title: Mountain Crusher
# Artist: Cascadia
Intro verse - palm muted heavy riff!
Am               G                F
e|-----------------|-----------------|
B|-----------------|-----------------|
G|-----------------|---------12b14---|
D|-0---2h3p2---0---|-----10----------|
A|-0---------------|-12--------------|
D|-0---------------|-x---------------| x2

Chorus lyrics here: "Ride the lightning down the ridge"
e||:-(5)---<12>----|---15\7---8~---:||
B||:---------------|---------------:||
G||:---------------|---------------:||
D||:--0------------|---0-----------:||
A||:--0------------|---0-----------:||
D||:--0------------|---0-----------:||
`;

  assert.equal(detectTabFormat(messyTab), 'ascii');
  assert.equal(detectTabFormat('Just some lyrics without any tab lines'), 'unknown');

  const song = parseAsciiTab(messyTab, { bpm: 120 });
  assert.equal(song.title, 'Mountain Crusher');
  assert.equal(song.artist, 'Cascadia');
  // Drop D lowest string is D2 = 38
  assert.deepEqual(song.tuning, [38, 45, 50, 55, 59, 64]);
  // System 1 has 2 bars repeated x2 (4 bars), System 2 has 2 bars in |: :| (4 bars) -> 8 bars total
  assert.equal(song.bars.length, 8);

  // Verify multi-digit frets 10, 12, 15 were parsed as single notes (not 1 and 0)
  const frets = new Set(song.notes.map((n) => n.fret));
  assert.ok(frets.has(10), 'Should contain fret 10');
  assert.ok(frets.has(12), 'Should contain fret 12');
  assert.ok(frets.has(15), 'Should contain fret 15');

  // Verify techniques: h, p, bend, harm, slide, vib, dead note
  const techs = new Set(song.notes.map((n) => n.tech).filter(Boolean));
  assert.ok(techs.has('h'));
  assert.ok(techs.has('p'));
  assert.ok(techs.has('bend'));
  assert.ok(techs.has('harm'));
  assert.ok(techs.has('slide'));
  assert.ok(techs.has('vib'));

  const deadCount = song.notes.filter((n) => n.dead).length;
  assert.equal(deadCount, 2); // 1 dead note repeated x2

  // buildEvents excludes dead notes and groups simultaneous chord notes
  const events = buildEvents(song);
  assert.ok(events.length > 0);
  assert.equal(events[0].notes.length, 3); // Initial Drop D power chord (0-0-0)
  for (const ev of events) {
    for (const n of ev.notes) {
      assert.equal(n.dead, false);
    }
  }
});

test('parseAsciiTab: throws helpful error on non-tab input', () => {
  assert.throws(
    () => parseAsciiTab('Hello world, no guitar tab here'),
    /No tab lines found/
  );
});

test('parseAsciiTab: a bend target is not a second note', () => {
  const song = parseAsciiTab(String.raw`
e|----------------|
B|----------------|
G|--12b14---7b----|
D|----------------|
A|-----------9b11r9-|
E|----------------|
`, { bpm: 120 });
  const played = song.notes.filter((n) => !n.dead);
  assert.equal(played.length, 3);
  assert.deepEqual(played.map((n) => [n.fret, n.tech, n.bend]), [[12, 'bend', 2], [7, 'bend', 2], [9, 'bend', 2]]);
});
