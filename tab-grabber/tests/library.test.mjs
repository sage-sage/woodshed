import test from 'node:test';
import assert from 'node:assert/strict';

const store = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === 'string') {
          return { [keys]: store[keys] };
        }
        const out = {};
        for (const [k, defVal] of Object.entries(keys || {})) {
          out[k] = Object.prototype.hasOwnProperty.call(store, k) ? store[k] : defVal;
        }
        return out;
      },
      async set(obj) {
        Object.assign(store, obj);
      }
    }
  }
};

const {
  saveEntry,
  listEntries,
  getEntry,
  deleteEntry,
  updateEntry,
  exportLibrary,
  importLibrary
} = await import('../lib/library.js');

test('save, deduplicate by url, update metadata, and delete entries', async () => {
  delete store.library;

  const first = await saveEntry({
    title: 'Blackbird',
    artist: 'The Beatles',
    site: 'Ultimate Guitar',
    url: 'https://example.com/blackbird',
    tuning: 'E A D G B E',
    capo: 0,
    bpm: 94,
    text: 'e|--3--|'
  });
  assert.equal(first.updated, false);
  assert.ok(first.entry.id);

  const second = await saveEntry({
    title: 'Wish You Were Here',
    artist: 'Pink Floyd',
    site: 'Songsterr',
    url: 'https://example.com/wywh',
    tuning: 'E A D G B E',
    capo: 0,
    bpm: 60,
    text: 'e|--0--|'
  });
  assert.equal(second.updated, false);

  let list = await listEntries();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, second.entry.id);

  const patched = await updateEntry(first.entry.id, {
    title: 'Blackbird (Acoustic)',
    tags: ['fingerstyle', 'acoustic'],
    note: 'Thumb + index pinch',
    id: 'should-not-overwrite'
  });
  assert.equal(patched.id, first.entry.id);
  assert.equal(patched.title, 'Blackbird (Acoustic)');
  assert.deepEqual(patched.tags, ['fingerstyle', 'acoustic']);
  assert.equal(patched.note, 'Thumb + index pinch');

  // Saving again with the same URL updates fields in place and preserves tags/note/id
  const deduped = await saveEntry({
    title: 'Blackbird Updated',
    artist: 'The Beatles',
    site: 'Ultimate Guitar',
    url: 'https://example.com/blackbird',
    tuning: 'E A D G B E',
    capo: 0,
    bpm: 96,
    text: 'e|--3--5--|'
  });
  assert.equal(deduped.updated, true);
  assert.equal(deduped.entry.id, first.entry.id);
  assert.deepEqual(deduped.entry.tags, ['fingerstyle', 'acoustic']);
  assert.equal(deduped.entry.note, 'Thumb + index pinch');
  assert.equal(deduped.entry.text, 'e|--3--5--|');

  const fetched = await getEntry(first.entry.id);
  assert.equal(fetched.title, 'Blackbird Updated');

  const deleted = await deleteEntry(second.entry.id);
  assert.equal(deleted, true);
  list = await listEntries();
  assert.equal(list.length, 1);
});

test('exportLibrary and importLibrary validate entries and merge by id', async () => {
  const exported = await exportLibrary();
  const parsed = JSON.parse(exported);
  assert.equal(parsed.format, 'woodshed-tab-library');
  assert.equal(parsed.v, 1);
  assert.equal(parsed.entries.length, 1);

  const existing = parsed.entries[0];
  const payload = JSON.stringify({
    format: 'woodshed-tab-library',
    v: 1,
    entries: [
      { ...existing, title: 'Blackbird From Backup' },
      {
        id: 'new-entry-id',
        title: 'Everlong',
        artist: 'Foo Fighters',
        site: 'Songsterr',
        url: 'https://example.com/everlong',
        tuning: 'D A D G B E',
        capo: 0,
        bpm: 158,
        text: 'D|--0--|',
        tags: ['drop-d'],
        note: '',
        savedAt: 1700000000000,
        updatedAt: 1700000000000
      },
      // Oversized text > 2MB should be skipped
      {
        id: 'too-big',
        title: 'Huge',
        text: 'x'.repeat(2 * 1024 * 1024 + 10)
      },
      // Invalid entry shape should be skipped
      {
        id: '',
        text: 12345
      }
    ]
  });

  const res = await importLibrary(payload);
  assert.deepEqual(res, { added: 1, updated: 1 });

  const list = await listEntries();
  assert.equal(list.length, 2);
  assert.equal((await getEntry(existing.id)).title, 'Blackbird From Backup');
  assert.equal((await getEntry('new-entry-id')).title, 'Everlong');
  assert.equal(await getEntry('too-big'), null);
});
