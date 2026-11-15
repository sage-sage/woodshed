import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseAsciiTab } from '../../woodshed/js/tab-ascii.js';

const songsterrCode = fs.readFileSync(new URL('../lib/songsterr.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
ctx.globalThis = ctx;
vm.runInContext(songsterrCode, ctx);

const { DIGIT_TEMPLATES, classifyGlyph, beatDurations, buildAscii } = ctx.WoodshedSongsterr;

test('DIGIT_TEMPLATES classify to themselves and 9 is reversed 6', () => {
  assert.equal(
    DIGIT_TEMPLATES['9'],
    DIGIT_TEMPLATES['6'].split('').reverse().join('')
  );

  for (const [digit, bitmap] of Object.entries(DIGIT_TEMPLATES)) {
    assert.equal(bitmap.length, 96);
    assert.equal(classifyGlyph(bitmap, 0.66), digit);
  }
});

test('classifyGlyph handles narrow aspect as 1 and rejects blank or random noise', () => {
  assert.equal(classifyGlyph('.'.repeat(96), 0.44), '1');
  assert.equal(classifyGlyph('.'.repeat(96), 0.66), null);

  // Checkerboard bitmap has ~48 Hamming distance from every digit template
  let noise = '';
  for (let i = 0; i < 96; i++) {
    noise += (i + Math.floor(i / 8)) % 2 === 0 ? '#' : '.';
  }
  assert.equal(classifyGlyph(noise, 0.66), null);
});

test('buildAscii produces equal-length rows and parses cleanly in Woodshed', () => {
  const ascii = buildAscii({
    stringNames: ['E', 'B', 'G', 'D', 'A', 'E'],
    lines: [
      {
        bars: [
          {
            x0: 0,
            x1: 100,
            notes: [
              { string: 0, fret: '12', x: 50 }
            ]
          },
          {
            x0: 100,
            x1: 200,
            notes: [
              { string: 2, fret: '5', x: 110 },
              { string: 5, fret: '0', x: 160 }
            ]
          }
        ]
      }
    ]
  });

  const rows = ascii.split('\n');
  assert.equal(rows.length, 6);
  assert.ok(rows[0].startsWith('e|'));
  assert.ok(rows[5].startsWith('E|'));
  const rowLen = rows[0].length;
  for (const row of rows) {
    assert.equal(row.length, rowLen);
  }

  const song = parseAsciiTab(ascii);
  assert.equal(song.notes.length, 3);
  assert.equal(song.bars.length, 2);

  const frets = song.notes.map((n) => n.fret);
  assert.ok(frets.includes(12));
  assert.ok(frets.includes(5));
  assert.ok(frets.includes(0));

  const note12 = song.notes.find((n) => n.fret === 12);
  const bar0 = song.bars[0];
  const bar0Dur = bar0.dur;
  const relPos = (note12.t - bar0.t) / bar0Dur;
  assert.ok(Math.abs(relPos - 0.5) < 0.15, `expected ~0.5 bar position, got ${relPos}`);
});

test('narrow glyphs are brackets, told apart by which side holds the ink', () => {
  const leftInk = Array.from({ length: 12 }, (_, r) => (r >= 3 && r <= 8 ? '##......' : '..##....')).join('');
  const rightInk = Array.from({ length: 12 }, (_, r) => (r >= 3 && r <= 8 ? '......##' : '....##..')).join('');
  assert.equal(classifyGlyph(leftInk, 0.3), '(');
  assert.equal(classifyGlyph(rightInk, 0.3), ')');
  assert.equal(classifyGlyph(leftInk, 0.44), '1');
});

test('the dead-note cross is read as x', () => {
  const cross = '###..###.##..##..###.##...####....####.....##......##.....####....####...##..##..##..##.##....##';
  assert.equal(classifyGlyph(cross, 0.93), 'x');
});

test('buildAscii renders pre and post techniques and Woodshed parseAsciiTab parses them', () => {
  const ascii = buildAscii({
    stringNames: ['E', 'B', 'G', 'D', 'A', 'E'],
    lines: [
      {
        bars: [
          {
            x0: 0,
            x1: 160,
            notes: [
              { string: 2, fret: '5', x: 20 },
              { string: 2, fret: '7', x: 35, pre: '/' },
              { string: 2, fret: '9', x: 75, pre: 'h' },
              { string: 1, fret: '7', x: 115, post: 'b9' },
              { string: 0, fret: '12', x: 140, post: '~' }
            ]
          }
        ]
      }
    ]
  });

  const rows = ascii.split('\n');
  assert.equal(rows.length, 6);
  const rowLen = rows[0].length;
  for (const row of rows) {
    assert.equal(row.length, rowLen);
  }
  assert.ok(rows[2].includes('/7'), `expected /7 in G row: ${rows[2]}`);
  assert.ok(rows[2].includes('h9'), `expected h9 in G row: ${rows[2]}`);
  assert.ok(rows[1].includes('7b9'), `expected 7b9 in B row: ${rows[1]}`);
  assert.ok(rows[0].includes('12~'), `expected 12~ in e row: ${rows[0]}`);

  const song = parseAsciiTab(ascii);
  // Woodshed numbers strings from the lowest (0) up; the model above numbers rows from the top (0 = high e).
  const slideNote = song.notes.find((n) => n.string === 3 && n.fret === 7);
  const hammerNote = song.notes.find((n) => n.string === 3 && n.fret === 9);
  const bendNote = song.notes.find((n) => n.string === 4 && n.fret === 7);
  assert.ok(slideNote, 'expected slide note');
  assert.equal(slideNote.tech, 'slide');
  assert.ok(hammerNote, 'expected hammer note');
  assert.equal(hammerNote.tech, 'h');
  assert.ok(bendNote, 'expected bend note');
  assert.ok(bendNote.bend > 0, `expected bend > 0, got ${bendNote.bend}`);
});

test('buildAscii drops pre on bar line and omits techniques on dead notes', () => {
  const ascii = buildAscii({
    stringNames: ['E', 'B', 'G', 'D', 'A', 'E'],
    lines: [
      {
        bars: [
          {
            x0: 0,
            x1: 100,
            notes: [
              { string: 0, fret: '5', x: 0, pre: '/' },
              { string: 1, fret: 'x', x: 50, pre: 'h', post: '~' }
            ]
          }
        ]
      }
    ]
  });

  const rows = ascii.split('\n');
  const rowLen = rows[0].length;
  for (const row of rows) {
    assert.equal(row.length, rowLen);
  }
  assert.ok(rows[0].startsWith('e|-5-'), `expected dropped pre at bar start: ${rows[0]}`);
  assert.ok(rows[1].includes('-x-'), `expected bare x without techniques: ${rows[1]}`);
});

test('extract.js reads Songsterr slides, hammer-ons, pull-offs, ties, vibrato, and bends', async () => {
  const extractCode = fs.readFileSync(new URL('../extract.js', import.meta.url), 'utf8');

  function makeEl(tag, attrs = {}, children = [], bbox = null, textContent = '') {
    const el = {
      tagName: tag.toUpperCase(),
      attrs: { ...attrs },
      children,
      parentNode: null,
      textContent,
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
      },
      setAttribute(name, val) {
        this.attrs[name] = String(val);
      },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      remove() {
        if (this.parentNode) {
          this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        }
      },
      getBBox() {
        if (bbox) return bbox;
        const d = this.attrs.d || '';
        const nums = (d.match(/-?(?:\d+\.?\d*|\.\d+)/g) || []).map(Number);
        if (nums.length >= 2) {
          const xs = nums.filter((_, i) => i % 2 === 0);
          const ys = nums.filter((_, i) => i % 2 === 1);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);
          return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
        }
        return { x: 0, y: 0, width: 0, height: 0 };
      },
      getScreenCTM() {
        return {
          inverse() { return this; },
          multiply(m) { return m; }
        };
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          for (const ch of node.children) {
            const cls = ch.attrs.class || '';
            let match = false;
            if (sel === 'path' && ch.tagName === 'PATH') match = true;
            else if (sel === 'text' && ch.tagName === 'TEXT') match = true;
            else if (sel === 'g[data-effect-run^="vibrato-"]' && ch.tagName === 'G' && (ch.attrs['data-effect-run'] || '').startsWith('vibrato-')) match = true;
            else if (sel === 'svg[data-testid^="multitrack-line-group-"]' && ch.tagName === 'SVG' && (ch.attrs['data-testid'] || '').startsWith('multitrack-line-group-')) match = true;
            else if (sel === 'g[data-track-index]' && ch.tagName === 'G' && 'data-track-index' in ch.attrs) match = true;
            else if (sel === 'path[class*="strings"]' && ch.tagName === 'PATH' && cls.includes('strings')) match = true;
            else if (sel === 'text[class*="tuning"]' && ch.tagName === 'TEXT' && cls.includes('tuning')) match = true;
            else if (sel === 'text[class*="tempoText"]' && ch.tagName === 'TEXT' && cls.includes('tempoText')) match = true;
            if (match) out.push(ch);
            walk(ch);
          }
        };
        walk(this);
        return out;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      }
    };
    for (const ch of children) ch.parentNode = el;
    return el;
  }

  const stringsPath = makeEl('path', {
    class: 'strings',
    d: 'M 0 12 H 320 M 0 24 H 320 M 0 36 H 320 M 0 48 H 320 M 0 60 H 320 M 0 72 H 320 M 0 12 V 72 M 320 12 V 72'
  });
  // Voice glyphs (6x10 boxes centered on string ys 12, 24, 36, 48):
  // string 2 (y=36): fret 5 at x=30, fret 7 at x=60 (slide /), fret 9 at x=90 (hammer h), fret 7 at x=120 (pull-off p)
  // string 3 (y=48): fret 5 at x=30, fret 5 at x=60 (tie arc -> removed)
  // string 1 (y=24): fret 7 at x=160 (bend 1 -> b9)
  // string 0 (y=12): fret 8 at x=210 (vibrato ~), fret 8 at x=240 (2nd beat under vibrato, no ~)
  const voicePath = makeEl('path', {
    class: 'voice',
    d: [
      'M 27 31 C 33 31 33 41 27 41 Z',
      'M 57 31 C 63 31 63 41 57 41 Z',
      'M 87 31 C 93 31 93 41 87 41 Z',
      'M 117 31 C 123 31 123 41 117 41 Z',
      'M 27 43 C 33 43 33 53 27 53 Z',
      'M 57 43 C 63 43 63 53 57 53 Z',
      'M 157 19 C 163 19 163 29 157 29 Z',
      'M 207 7 C 213 7 213 17 207 17 Z',
      'M 237 7 C 243 7 243 17 237 17 Z'
    ].join(' ')
  });
  const effectsPath = makeEl('path', {
    class: 'effects',
    d: [
      'M 34 38 Q 45 36 56 34 V 36 Q 45 38 34 40 Z',
      'M 60 28 c 10 -4 20 -4 30 0 L 90 29 c -10 -3 -20 -3 -30 0 Z',
      'M 90 28 c 10 -4 20 -4 30 0 L 120 29 c -10 -3 -20 -3 -30 0 Z',
      'M 30 40 c 10 -4 20 -4 30 0 L 60 41 c -10 -3 -20 -3 -30 0 Z'
    ].join(' ')
  });
  const vibratoGroup = makeEl('g', { 'data-effect-run': 'vibrato-1' }, [
    makeEl('path', { class: 'pathVibrato', d: 'M 208 4 L 245 4' })
  ]);
  const bendText = makeEl('text', { class: 'bend_up', x: '160', y: '8' }, [], { x: 156, y: 2, width: 8, height: 8 }, '1');

  const trackGroup = makeEl('g', { 'data-track-index': '0' }, [stringsPath, voicePath, effectsPath, vibratoGroup, bendText]);
  const lineSvg = makeEl('svg', { 'data-testid': 'multitrack-line-group-0' }, [trackGroup]);
  const rootDoc = makeEl('document', {}, [lineSvg]);

  const fretByX = new Map([
    [30, '5'],
    [60, '7'],
    [90, '9'],
    [120, '7'],
    [160, '7'],
    [210, '8'],
    [240, '8']
  ]);
  let lastFillX = 0;

  const extractCtx = vm.createContext({
    WoodshedSongsterr: {
      classifyGlyph() {
        return fretByX.get(lastFillX) || '5';
      },
      beatDurations,
      buildAscii
    },
    Path2D: class Path2D {
      constructor(d) {
        const m = String(d).match(/^M\s*(-?\d+\.?\d*)/);
        lastFillX = m ? parseFloat(m[1]) + 3 : 0;
      }
    },
    DOMPoint: class DOMPoint {
      constructor(x, y) { this.x = x; this.y = y; }
      matrixTransform() { return this; }
    },
    OffscreenCanvas: class OffscreenCanvas {
      getContext() {
        return {
          setTransform() {},
          clearRect() {},
          fill() {},
          getImageData() { return { data: new Uint8ClampedArray(96 * 4) }; }
        };
      }
    },
    location: { href: 'https://www.songsterr.com/a/wsa/test-tab-s1', hostname: 'www.songsterr.com', pathname: '/a/wsa/test-tab-s1' },
    document: {
      title: 'Test Song Tab by Test Artist | Songsterr',
      scrollingElement: { scrollTop: 0 },
      querySelector: (sel) => rootDoc.querySelector(sel),
      querySelectorAll: (sel) => rootDoc.querySelectorAll(sel),
      createElementNS: (_ns, tag) => makeEl(tag)
    },
    window: { innerHeight: 800, scrollTo() {}, scrollBy() {} },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    Array,
    Object,
    String,
    Map,
    Set,
    RegExp,
    Infinity,
    NaN,
    parseFloat,
    parseInt
  });
  extractCtx.globalThis = extractCtx;
  vm.runInContext(extractCode, extractCtx);

  const res = await extractCtx.__woodshedExtract();
  assert.equal(res.ok, true);
  const rows = res.text.split('\n');
  assert.ok(rows[2].includes('/7'), `expected slide /7 in G row: ${rows[2]}`);
  assert.ok(rows[2].includes('h9'), `expected hammer h9 in G row: ${rows[2]}`);
  assert.ok(rows[2].includes('p7'), `expected pull-off p7 in G row: ${rows[2]}`);
  assert.ok(rows[1].includes('7b9'), `expected bend 7b9 in B row: ${rows[1]}`);
  assert.ok(rows[0].includes('8~'), `expected vibrato 8~ in e row: ${rows[0]}`);
  assert.equal((rows[3].match(/5/g) || []).length, 1, `expected tied second 5 removed in D row: ${rows[3]}`);
});

test('beatDurations computes exact and scaled durations for standard rhythms, dots, tuplets, and rests', () => {
  // Four quarter notes in 4/4 -> exact
  const quarters = beatDurations({
    barLen: 1,
    beats: [
      { kind: 'note', stem: 'full', beams: 0, dotted: false, tuplet: 1 },
      { kind: 'note', stem: 'full', beams: 0, dotted: false, tuplet: 1 },
      { kind: 'note', stem: 'full', beams: 0, dotted: false, tuplet: 1 },
      { kind: 'note', stem: 'full', beams: 0, dotted: false, tuplet: 1 }
    ]
  });
  assert.equal(quarters.exact, true);
  assert.deepEqual(Array.from(quarters.durations), [0.25, 0.25, 0.25, 0.25]);

  // 8 eighth notes in 4/4 -> exact
  const eighths = beatDurations({
    barLen: 1,
    beats: Array.from({ length: 8 }, () => ({ kind: 'note', stem: 'full', beams: 1, dotted: false, tuplet: 1 }))
  });
  assert.equal(eighths.exact, true);
  assert.deepEqual(Array.from(eighths.durations), Array(8).fill(0.125));

  // Dotted quarter + eighth + half in 4/4 -> exact
  const dottedMix = beatDurations({
    barLen: 1,
    beats: [
      { kind: 'note', stem: 'full', beams: 0, dotted: true, tuplet: 1 },
      { kind: 'note', stem: 'full', beams: 1, dotted: false, tuplet: 1 },
      { kind: 'note', stem: 'short', beams: 0, dotted: false, tuplet: 1 }
    ]
  });
  assert.equal(dottedMix.exact, true);
  assert.deepEqual(Array.from(dottedMix.durations), [0.375, 0.125, 0.5]);

  // Triplet of eighths + quarter + half in 4/4 -> exact
  const tripletMix = beatDurations({
    barLen: 1,
    beats: [
      { kind: 'note', stem: 'full', beams: 1, dotted: false, tuplet: 3 },
      { kind: 'note', stem: 'full', beams: 1, dotted: false, tuplet: 3 },
      { kind: 'note', stem: 'full', beams: 1, dotted: false, tuplet: 3 },
      { kind: 'note', stem: 'full', beams: 0, dotted: false, tuplet: 1 },
      { kind: 'note', stem: 'short', beams: 0, dotted: false, tuplet: 1 }
    ]
  });
  assert.equal(tripletMix.exact, true);
  assert.ok(Math.abs(tripletMix.durations[0] - 1 / 12) < 1e-9);
  assert.ok(Math.abs(tripletMix.durations[1] - 1 / 12) < 1e-9);
  assert.ok(Math.abs(tripletMix.durations[2] - 1 / 12) < 1e-9);
  assert.equal(tripletMix.durations[3], 0.25);
  assert.equal(tripletMix.durations[4], 0.5);

  // Rest filling remainder in 4/4 -> exact
  const withRest = beatDurations({
    barLen: 1,
    beats: [
      { kind: 'note', stem: 'short', beams: 0, dotted: false, tuplet: 1 },
      { kind: 'rest', gapPx: 40 },
      { kind: 'note', stem: 'full', beams: 0, dotted: false, tuplet: 1 }
    ]
  });
  assert.equal(withRest.exact, true);
  assert.deepEqual(Array.from(withRest.durations), [0.5, 0.25, 0.25]);

  // Too short with no rest seen: the missing half goes after the beat with the widest gap (an undetected
  // rest), so both notes keep their real start times.
  const missingRest = beatDurations({
    barLen: 1,
    beats: [
      { kind: 'note', stem: 'full', beams: 0, dotted: false, tuplet: 1, gapPx: 40 },
      { kind: 'note', stem: 'full', beams: 0, dotted: false, tuplet: 1, gapPx: 120 }
    ]
  });
  assert.equal(missingRest.exact, true);
  assert.deepEqual(Array.from(missingRest.durations), [0.25, 0.75]);

  // Too long (a misread): scaled to fit, exact false
  const scaled = beatDurations({
    barLen: 1,
    beats: [
      { kind: 'note', stem: 'short', beams: 0, dotted: false, tuplet: 1 },
      { kind: 'note', stem: 'short', beams: 0, dotted: false, tuplet: 1 },
      { kind: 'note', stem: 'short', beams: 0, dotted: false, tuplet: 1 }
    ]
  });
  assert.equal(scaled.exact, false);
  assert.ok(Math.abs(Array.from(scaled.durations).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('buildAscii places pos-based notes by time rather than x coordinate', () => {
  // Note at x=10 (near left edge) but pos=0.5 in a 4/4 bar should land in the middle column (col 33 of 66)
  const ascii = buildAscii({
    stringNames: ['E', 'B', 'G', 'D', 'A', 'E'],
    lines: [
      {
        bars: [
          {
            x0: 0,
            x1: 200,
            barLen: 1,
            notes: [
              { string: 0, fret: '7', x: 10, pos: 0.5 }
            ]
          }
        ]
      }
    ]
  });

  const rows = ascii.split('\n');
  const barBody = rows[0].slice(2, -1); // 66 chars
  assert.equal(barBody.length, 66);
  const idx = barBody.indexOf('7');
  assert.equal(idx, 33);
});
