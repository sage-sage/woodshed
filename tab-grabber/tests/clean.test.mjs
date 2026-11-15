import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripUgMarkup,
  normalize,
  isTabLine,
  countTabLines,
  detectTuning,
  detectCapo,
  detectBpm,
  toWoodshedText,
  summarize
} from '../lib/clean.js';

describe('stripUgMarkup', () => {
  test('removes [tab] and [ch] tags without shifting column alignment while keeping section headers', () => {
    const raw = [
      '[Verse 1]',
      '[ch]Am[/ch]          [ch]G[/ch]',
      '[tab]e|---0-------3---|',
      'B|---1-------0---|[/tab]',
      'Rock &amp; Roll &lt;3 &quot;Live&quot; &#39;99&nbsp;!'
    ].join('\n');

    const cleaned = stripUgMarkup(raw);
    const lines = cleaned.split('\n');
    assert.equal(lines[0], '[Verse 1]');
    assert.equal(lines[1], 'Am          G');
    assert.equal(lines[2], 'e|---0-------3---|');
    assert.equal(lines[3], 'B|---1-------0---|');
    assert.equal(lines[4], 'Rock & Roll <3 "Live" \'99 !');
  });
});

describe('normalize', () => {
  test('normalizes line endings, tabs, unicode dashes/bars, trailing spaces, and excessive blank lines', () => {
    const raw = 'e│\t0—2–3‒5¦\r\nB┃---1---0---┃   \r\n\r\n\r\n\r\n\r\nG|---2---0---|';
    const out = normalize(raw);
    assert.equal(out, 'e|      0-2-3-5|\nB|---1---0---|\n\n\nG|---2---0---|');
  });
});

describe('isTabLine & countTabLines', () => {
  test('identifies valid tab lines and rejects non-tab lines', () => {
    assert.equal(isTabLine('e|---0---2---3---|'), true);
    assert.equal(isTabLine('Eb|--12b14r12~--10h12p10\\8/10--|'), true);
    assert.equal(isTabLine('7|---0---0---0---|'), true);
    assert.equal(isTabLine('e:---0---2---3---|'), true);
    assert.equal(isTabLine('|---0---2---3---|'), true);

    assert.equal(isTabLine('Am      G       C'), false);
    assert.equal(isTabLine('|   |   |   |   |'), false);
    assert.equal(isTabLine('----------------'), false);
    assert.equal(isTabLine('[Chorus]'), false);
  });

  test('counts largest consecutive run and total tab lines', () => {
    const tab = [
      'Intro',
      'e|---0---2---|',
      'B|---1---3---|',
      'G|---2---2---|',
      'D|---2---0---|',
      'A|---0-------|',
      'E|-----------|',
      '',
      'Am        G',
      'e|---3---0---|',
      'B|---0---1---|',
      'G|---0---2---|',
      'D|---0---2---|'
    ].join('\n');

    assert.deepEqual(countTabLines(tab), { maxRun: 6, total: 10 });
  });
});

describe('detectTuning', () => {
  test('detects from hint, Tuning line, or string-name column (lowest first)', () => {
    assert.equal(detectTuning('', 'Drop D'), 'D A D G B E');
    assert.equal(detectTuning('', 'Half step down'), 'Eb Ab Db Gb Bb Eb');
    assert.equal(detectTuning('Tuning: D A D G B E\ne|---0---|', ''), 'D A D G B E');

    const dropDSystem = [
      'e|---2---0---|',
      'B|---3---3---|',
      'G|---2---2---|',
      'D|---0---0---|',
      'A|---0---0---|',
      'D|---0---0---|'
    ].join('\n');
    assert.equal(detectTuning(dropDSystem, ''), 'D A D G B E');
  });
});

describe('detectCapo & detectBpm', () => {
  test('parses numeric, ordinal, roman numeral, and no-capo forms', () => {
    assert.equal(detectCapo('', 3), 3);
    assert.equal(detectCapo('Capo 2', null), 2);
    assert.equal(detectCapo('Capo on 4th fret', null), 4);
    assert.equal(detectCapo('capo: II', null), 2);
    assert.equal(detectCapo('No capo', null), 0);
    assert.equal(detectCapo('Standard tuning', null), null);
  });

  test('parses BPM from hint or text', () => {
    assert.equal(detectBpm('', 112), 112);
    assert.equal(detectBpm('BPM: 120', null), 120);
    assert.equal(detectBpm('Tempo: 96', null), 96);
    assert.equal(detectBpm('♩ = 100', null), 100);
    assert.equal(detectBpm('q=100', null), 100);
    assert.equal(detectBpm('No tempo here', null), null);
  });
});

describe('toWoodshedText & summarize', () => {
  test('builds Woodshed headers, keeps Intro, and strips site chrome and >140-char prose', () => {
    const longAd = 'A'.repeat(145);
    const raw = [
      'Ultimate Guitar Pro',
      'Difficulty: novice',
      'Intro',
      'e|---0---2---|',
      'B|---1---3---|',
      'G|---2---2---|',
      'D|---2---0---|',
      longAd,
      'A|---0-------|',
      'E|-----------|',
      'Rate this tab 5/5'
    ].join('\n');

    const formatted = toWoodshedText({
      title: 'Test Song',
      artist: 'Test Band',
      bpm: 128,
      text: raw
    });

    assert.equal(
      formatted,
      [
        '# Title: Test Song',
        '# Artist: Test Band',
        '# Tempo: 128',
        '',
        'Intro',
        'e|---0---2---|',
        'B|---1---3---|',
        'G|---2---2---|',
        'D|---2---0---|',
        'A|---0-------|',
        'E|-----------|'
      ].join('\n')
    );

    const summary = summarize(formatted);
    assert.equal(summary.systems, 1);
    assert.equal(summary.tabLines, 6);
    assert.equal(summary.strings, 6);
    assert.equal(summary.hasRhythmMarks, false);
  });

  test('detects rhythm marks when present above a system', () => {
    const withRhythm = [
      '  Q   Q   E E Q',
      'e|---0---2---3-2-0-|',
      'B|---1---3---3-3-1-|',
      'G|---2---2---2-2-2-|',
      'D|---2---0---0-0-2-|'
    ].join('\n');

    const summary = summarize(withRhythm);
    assert.equal(summary.systems, 1);
    assert.equal(summary.strings, 4);
    assert.equal(summary.hasRhythmMarks, true);
  });
});
