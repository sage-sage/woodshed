const STORAGE_KEY = 'library';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function normalizeTags(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const tag = item.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function utf8ByteLength(str) {
  return new TextEncoder().encode(str).length;
}

function sanitizeNotation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.format !== 'songsterr') return null;
  if (!Array.isArray(raw.measures)) return null;
  return raw;
}

async function readLibrary() {
  const stored = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY].slice() : [];
}

async function writeLibrary(entries) {
  await chrome.storage.local.set({ [STORAGE_KEY]: entries });
}

export async function listEntries() {
  const entries = await readLibrary();
  return entries.map(({ notation, ...rest }) => ({
    ...rest,
    hasNotation: Boolean(sanitizeNotation(notation))
  }));
}

export async function getEntry(id) {
  if (typeof id !== 'string' || !id) return null;
  const entries = await readLibrary();
  return entries.find((entry) => entry && entry.id === id) || null;
}

export async function saveEntry(data) {
  const entries = await readLibrary();
  const now = Date.now();
  const url = typeof data?.url === 'string' ? data.url.trim() : '';
  const incomingNotation = sanitizeNotation(data?.notation);

  if (url) {
    const existingIndex = entries.findIndex((item) => item && item.url === url);
    if (existingIndex !== -1) {
      const prev = entries[existingIndex];
      const nextNotation = data.notation !== undefined
        ? incomingNotation
        : sanitizeNotation(prev.notation);
      const { notation: _dropped, ...prevRest } = prev;
      const updatedEntry = {
        ...prevRest,
        title: typeof data.title === 'string' ? data.title.trim() : prev.title,
        artist: typeof data.artist === 'string' ? data.artist.trim() : prev.artist,
        site: typeof data.site === 'string' ? data.site.trim() : prev.site,
        url,
        tuning: typeof data.tuning === 'string' ? data.tuning.trim() : prev.tuning,
        capo: data.capo !== undefined ? data.capo : prev.capo,
        bpm: data.bpm !== undefined ? data.bpm : prev.bpm,
        text: typeof data.text === 'string' ? data.text : prev.text,
        ...(nextNotation ? { notation: nextNotation } : {}),
        updatedAt: now
      };
      entries[existingIndex] = updatedEntry;
      await writeLibrary(entries);
      return { entry: updatedEntry, updated: true };
    }
  }

  const entry = {
    id: crypto.randomUUID(),
    title: typeof data?.title === 'string' ? data.title.trim() : '',
    artist: typeof data?.artist === 'string' ? data.artist.trim() : '',
    site: typeof data?.site === 'string' ? data.site.trim() : '',
    url,
    tuning: typeof data?.tuning === 'string' ? data.tuning.trim() : '',
    capo: data?.capo ?? null,
    bpm: data?.bpm ?? null,
    text: typeof data?.text === 'string' ? data.text : '',
    ...(incomingNotation ? { notation: incomingNotation } : {}),
    tags: normalizeTags(data?.tags),
    note: typeof data?.note === 'string' ? data.note : '',
    savedAt: now,
    updatedAt: now
  };

  entries.unshift(entry);
  await writeLibrary(entries);
  return { entry, updated: false };
}

export async function updateEntry(id, patch) {
  if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object') return null;
  const entries = await readLibrary();
  const idx = entries.findIndex((item) => item && item.id === id);
  if (idx === -1) return null;

  const current = entries[idx];
  const next = { ...current };

  if (Object.prototype.hasOwnProperty.call(patch, 'title') && typeof patch.title === 'string') {
    next.title = patch.title.trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'artist') && typeof patch.artist === 'string') {
    next.artist = patch.artist.trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'tags')) {
    next.tags = normalizeTags(patch.tags);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'note') && typeof patch.note === 'string') {
    next.note = patch.note;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notation')) {
    const cleanNotation = sanitizeNotation(patch.notation);
    if (cleanNotation) {
      next.notation = cleanNotation;
    } else {
      delete next.notation;
    }
  } else if (next.notation !== undefined && !sanitizeNotation(next.notation)) {
    delete next.notation;
  }

  next.updatedAt = Date.now();
  entries[idx] = next;
  await writeLibrary(entries);
  return next;
}

export async function deleteEntry(id) {
  if (typeof id !== 'string' || !id) return false;
  const entries = await readLibrary();
  const next = entries.filter((item) => item && item.id !== id);
  if (next.length === entries.length) return false;
  await writeLibrary(next);
  return true;
}

export async function exportLibrary() {
  const entries = await readLibrary();
  return JSON.stringify(
    {
      format: 'woodshed-tab-library',
      v: 1,
      entries
    },
    null,
    2
  );
}

function isValidImportedEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return false;
  if (typeof raw.text !== 'string') return false;
  if (utf8ByteLength(raw.text) > MAX_TEXT_BYTES) return false;
  if (raw.title !== undefined && typeof raw.title !== 'string') return false;
  if (raw.artist !== undefined && typeof raw.artist !== 'string') return false;
  if (raw.site !== undefined && typeof raw.site !== 'string') return false;
  if (raw.url !== undefined && typeof raw.url !== 'string') return false;
  if (raw.tuning !== undefined && typeof raw.tuning !== 'string') return false;
  if (raw.note !== undefined && typeof raw.note !== 'string') return false;
  if (raw.tags !== undefined && !Array.isArray(raw.tags)) return false;
  if (Array.isArray(raw.tags) && raw.tags.some((t) => typeof t !== 'string')) return false;
  if (raw.capo !== undefined && raw.capo !== null && typeof raw.capo !== 'number') return false;
  if (raw.bpm !== undefined && raw.bpm !== null && typeof raw.bpm !== 'number') return false;
  if (raw.savedAt !== undefined && typeof raw.savedAt !== 'number') return false;
  if (raw.updatedAt !== undefined && typeof raw.updatedAt !== 'number') return false;
  return true;
}

export async function importLibrary(jsonString) {
  if (typeof jsonString !== 'string') {
    throw new Error('Invalid library JSON input.');
  }
  const parsed = JSON.parse(jsonString);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.format !== 'woodshed-tab-library' ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error('File is not a valid Woodshed Tab Library export.');
  }

  const entries = await readLibrary();
  const indexById = new Map();
  entries.forEach((entry, idx) => {
    if (entry && typeof entry.id === 'string') {
      indexById.set(entry.id, idx);
    }
  });

  let added = 0;
  let updated = 0;
  const now = Date.now();

  for (const raw of parsed.entries) {
    if (!isValidImportedEntry(raw)) continue;
    const cleanNotation = sanitizeNotation(raw.notation);

    const cleanEntry = {
      id: raw.id.trim(),
      title: (raw.title || '').trim(),
      artist: (raw.artist || '').trim(),
      site: (raw.site || '').trim(),
      url: (raw.url || '').trim(),
      tuning: (raw.tuning || '').trim(),
      capo: raw.capo ?? null,
      bpm: raw.bpm ?? null,
      text: raw.text,
      ...(cleanNotation ? { notation: cleanNotation } : {}),
      tags: normalizeTags(raw.tags),
      note: raw.note || '',
      savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : now,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now
    };

    if (indexById.has(cleanEntry.id)) {
      entries[indexById.get(cleanEntry.id)] = cleanEntry;
      updated += 1;
    } else {
      indexById.set(cleanEntry.id, entries.length);
      entries.push(cleanEntry);
      added += 1;
    }
  }

  await writeLibrary(entries);
  return { added, updated };
}
