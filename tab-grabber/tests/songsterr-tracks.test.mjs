import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../lib/songsterr.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ URL });
ctx.globalThis = ctx;
vm.runInContext(code, ctx);
const T = ctx.WoodshedSongsterrTracks;

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const meta92 = fixture('songsterr-meta-92.json');
const staleState = fixture('songsterr-state-other-song.json');
const sparsePart = fixture('songsterr-part-sparse.json');
// What #state looks like when you opened song 92 directly.
const freshState = { meta: { songId: 92, partId: 1, current: { ...meta92, partId: 1 } } };
const plain = (v) => JSON.parse(JSON.stringify(v));

test('parseSongsterrUrl reads song, track and revision from every address form', () => {
  assert.deepEqual(plain(T.parseSongsterrUrl('https://www.songsterr.com/a/wsa/cure-boys-dont-cry-tab-s92')),
    { songId: '92', partId: null, revisionId: null });
  assert.deepEqual(plain(T.parseSongsterrUrl('https://www.songsterr.com/a/wsa/cure-boys-dont-cry-tab-s92t1/r10169787')),
    { songId: '92', partId: 1, revisionId: 10169787 });
  assert.deepEqual(plain(T.parseSongsterrUrl('https://www.songsterr.com/a/wsa/x-tab-s53923t2?x=1')),
    { songId: '53923', partId: 2, revisionId: null });
  assert.equal(T.parseSongsterrUrl('https://www.songsterr.com/').songId, null);
});

test('stale page state from another song is ignored (the "Clydie King | Backing Vocals" bug)', () => {
  const pick = T.resolveSongsterrTrack({
    url: 'https://www.songsterr.com/a/wsa/cure-boys-dont-cry-tab-s92',
    state: staleState,
    apiMeta: meta92,
    headerTexts: ['Overdriven GuitarRobert Smith | Woolworth Top 20 | Lead Guitar '],
    domPartIds: ['1', '1', '1']
  });
  assert.equal(pick.songId, '92');
  assert.equal(pick.stateFresh, false);
  assert.equal(pick.partId, 1);
  assert.equal(pick.partSource, 'header');
  assert.equal(pick.revisionId, 10169787);
  assert.equal(pick.image, 'v0-3-2-wHwG8E4LZGKBGYQW');
  assert.equal(pick.tracks[1].name, 'Robert Smith | Woolworth Top 20 | Lead Guitar');
  assert.ok(pick.notes.some((n) => /29672/.test(n)));
});

test('the track named in the header beats a stale address or data attribute', () => {
  const pick = T.resolveSongsterrTrack({
    url: 'https://www.songsterr.com/a/wsa/cure-boys-dont-cry-tab-s92t0',
    state: freshState,
    headerTexts: ['Electric Bass (pick)', 'Mike Dempsey | Fender Precision Bass'],
    domPartIds: ['2']
  });
  assert.equal(pick.partId, 3);
  assert.equal(pick.partSource, 'header');
  assert.ok(pick.notes.some((n) => /address says track 0/.test(n)));
});

test('a nested name picks the longest match, and the user pick wins over everything', () => {
  const tracks = [{ name: 'Lead', instrumentId: 29 }, { name: 'Lead 2', instrumentId: 29 }];
  const apiMeta = { songId: 7, revisionId: 1, tracks };
  const url = 'https://www.songsterr.com/a/wsa/x-tab-s7';
  assert.equal(T.resolveSongsterrTrack({ url, apiMeta, headerTexts: ['Overdriven GuitarLead 2'] }).partId, 1);
  assert.equal(T.resolveSongsterrTrack({ url, apiMeta, headerTexts: ['Overdriven GuitarLead'] }).partId, 0);
  const chosen = T.resolveSongsterrTrack({ url, apiMeta, headerTexts: ['Lead 2'], chosenPartId: 0 });
  assert.equal(chosen.partId, 0);
  assert.equal(chosen.partSource, 'chosen');
});

test('with no live signal and a stale state, no track is guessed', () => {
  const pick = T.resolveSongsterrTrack({
    url: 'https://www.songsterr.com/a/wsa/cure-boys-dont-cry-tab-s92',
    state: staleState,
    apiMeta: meta92,
    headerTexts: [],
    domPartIds: []
  });
  assert.equal(pick.partId, null);
  assert.equal(pick.tracks.length, 5);
});

test('fresh page state still works when the page shows nothing yet', () => {
  const pick = T.resolveSongsterrTrack({ url: 'https://www.songsterr.com/a/wsa/cure-boys-dont-cry-tab-s92', state: freshState });
  assert.equal(pick.partId, 1);
  assert.equal(pick.partSource, 'state');
  assert.equal(pick.stateFresh, true);
});

test('findPartJsonUrl only uses files of this song, prefers the revision, and builds missing parts', () => {
  const names = [
    'https://dqsljvtekg760.cloudfront.net/29672/555001/v0-3-2-OLDSONGxxxxxxxxx/1.json',
    'https://dqsljvtekg760.cloudfront.net/92/10169787/v0-3-2-wHwG8E4LZGKBGYQW/0.json',
    'https://dqsljvtekg760.cloudfront.net/92/10169787/v0-3-2-wHwG8E4LZGKBGYQW/1.json',
    'https://www.songsterr.com/api/meta/92'
  ];
  const base = { songId: '92', revisionId: 10169787, image: 'v0-3-2-wHwG8E4LZGKBGYQW' };
  assert.equal(T.findPartJsonUrl(names, { ...base, partId: 1 }).url, names[2]);
  assert.equal(T.findPartJsonUrl(names, { ...base, partId: 3 }).url,
    'https://dqsljvtekg760.cloudfront.net/92/10169787/v0-3-2-wHwG8E4LZGKBGYQW/3.json');
  assert.equal(T.findPartJsonUrl([names[0]], { ...base, partId: 1 }).url,
    'https://dqsljvtekg760.cloudfront.net/92/10169787/v0-3-2-wHwG8E4LZGKBGYQW/1.json');
  assert.equal(T.findPartJsonUrl([names[0]], { songId: '92', revisionId: null, image: null, partId: 1 }), null);
});

test('note counting skips rests and ties; sparse and non-guitar tracks are flagged', () => {
  assert.equal(T.countPlayedNotes(sparsePart), 3);
  assert.equal(T.isSparseTrack(21, 92), true);
  assert.equal(T.isSparseTrack(346, 105), false);
  assert.equal(T.isSparseTrack(30, 20), false);
  assert.equal(T.isPlayableTrack(sparsePart), false);
  assert.equal(T.isPlayableTrack(meta92.tracks[0]), false); // vocals drawn as a clarinet
  assert.equal(T.isPlayableTrack(meta92.tracks[1]), true);
  assert.equal(T.isPlayableTrack(meta92.tracks[3]), true);
  assert.equal(T.isPlayableTrack(meta92.tracks[4]), false);
});
