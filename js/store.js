import { parseAsciiTab, detectTabFormat } from './tab-ascii.js';
import { makeSong } from './song.js';

const DB_NAME = 'woodshed';
const DB_VERSION = 1;

const memorySongs = new Map();
const memoryAudio = new Map();
let dbPromise = null;
let useMemoryFallback = false;

function openDb() {
  if (useMemoryFallback || typeof indexedDB === 'undefined') {
    useMemoryFallback = true;
    return Promise.resolve(null);
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('songs')) {
          db.createObjectStore('songs', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('audio')) {
          db.createObjectStore('audio');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        useMemoryFallback = true;
        resolve(null);
      };
    } catch (_) {
      useMemoryFallback = true;
      resolve(null);
    }
  });

  return dbPromise;
}

function normalizeRecord(partial) {
  const now = Date.now();
  const id = partial.id || partial.song?.id || `song-${Math.random().toString(36).slice(2, 10)}`;
  const song = partial.song ? makeSong({ ...partial.song, id }) : makeSong({ id });
  return {
    id,
    song,
    sync: partial.sync && Array.isArray(partial.sync.anchors) ? partial.sync : { anchors: [] },
    audio: partial.audio || { kind: 'none' },
    ...(partial.importText !== undefined ? { importText: partial.importText } : {}),
    ...(partial.importOpts !== undefined ? { importOpts: partial.importOpts } : {}),
    ...(partial.tone !== undefined ? { tone: partial.tone } : {}),
    best: partial.best || null,
    history: Array.isArray(partial.history) ? partial.history : [],
    level: Number.isInteger(partial.level) ? partial.level : 3,
    speed: Number.isFinite(partial.speed) ? partial.speed : 1.0,
    createdAt: partial.createdAt || now,
    updatedAt: now
  };
}

export async function listSongs() {
  const db = await openDb();
  if (!db) {
    return Array.from(memorySongs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction('songs', 'readonly');
    const store = tx.objectStore('songs');
    const req = store.getAll();
    req.onsuccess = () => {
      const list = Array.isArray(req.result) ? req.result : [];
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getSong(id) {
  if (!id) return null;
  const db = await openDb();
  if (!db) {
    return memorySongs.get(id) || null;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction('songs', 'readonly');
    const store = tx.objectStore('songs');
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSong(record) {
  const existing = record.id ? await getSong(record.id) : null;
  const normalized = normalizeRecord({
    ...existing,
    ...record,
    createdAt: existing?.createdAt || record.createdAt || Date.now()
  });

  const db = await openDb();
  if (!db) {
    memorySongs.set(normalized.id, normalized);
    return normalized;
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction('songs', 'readwrite');
    const store = tx.objectStore('songs');
    const req = store.put(normalized);
    req.onsuccess = () => resolve(normalized);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSong(id) {
  const db = await openDb();
  if (!db) {
    memorySongs.delete(id);
    memoryAudio.delete(id);
    return true;
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['songs', 'audio'], 'readwrite');
    tx.objectStore('songs').delete(id);
    tx.objectStore('audio').delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveAudioBlob(id, blob) {
  const db = await openDb();
  if (!db) {
    memoryAudio.set(id, blob);
    return true;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readwrite');
    const store = tx.objectStore('audio');
    const req = store.put(blob, id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function getAudioBlob(id) {
  const db = await openDb();
  if (!db) {
    return memoryAudio.get(id) || null;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readonly');
    const store = tx.objectStore('audio');
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function exportSong(id) {
  const rec = await getSong(id);
  if (!rec) {
    throw new Error(`Song record "${id}" not found.`);
  }
  const exportPayload = {
    woodshedVersion: 1,
    exportedAt: new Date().toISOString(),
    record: {
      ...rec,
      audio: rec.audio?.kind === 'file' ? { kind: 'none', previousFileName: rec.audio.name } : rec.audio
    }
  };
  const json = JSON.stringify(exportPayload, null, 2);
  return new Blob([json], { type: 'application/json' });
}

export async function importSongFile(file) {
  if (!file) throw new Error('No file provided to import.');
  const text = await file.text();

  try {
    const parsed = JSON.parse(text);
    const rec = parsed.record || parsed;
    if (rec && rec.song && Array.isArray(rec.song.notes)) {
      const freshId = `song-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      return await saveSong({
        ...rec,
        id: freshId,
        song: { ...rec.song, id: freshId }
      });
    }
  } catch (_) {
    // If not JSON, check if it's an ASCII tab text file
  }

  if (detectTabFormat(text) === 'ascii') {
    const title = file.name ? file.name.replace(/\.[^.]+$/, '') : 'Imported Tab';
    const song = parseAsciiTab(text, { title });
    return await saveSong({
      id: song.id,
      song,
      importText: text,
      audio: { kind: 'none' }
    });
  }

  throw new Error('Unsupported song file format. Choose a WOODSHED .json export or an ASCII .txt/.tab file.');
}

const SETTINGS_KEY = 'woodshed_settings_v1';

export const DEFAULT_SETTINGS = {
  inputDeviceId: '',
  inputChannel: 'mix',
  inputSource: 'auto',
  latencyMs: 40,
  a4: 440,
  monitor: false,
  monitorGain: 0.75,
  hitWindowMs: 110,
  backingVolume: 0.85,
  guideVolume: 0.7,
  guideTone: 'match',
  metronome: false,
  countIn: true,
  showNoteNames: false,
  leftHanded: false,
  setupDone: false
};

class SettingsStore {
  constructor() {
    this._listeners = new Set();
    this._cache = { ...DEFAULT_SETTINGS };
    this._load();
  }

  _load() {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          this._cache = { ...DEFAULT_SETTINGS, ...parsed };
        }
      }
    } catch (_) {
      this._cache = { ...DEFAULT_SETTINGS };
    }
  }

  _save() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._cache));
      }
    } catch (_) {
      // Ignore storage quota / privacy errors
    }
  }

  get(key) {
    if (key === undefined) return { ...this._cache };
    return this._cache[key] !== undefined ? this._cache[key] : DEFAULT_SETTINGS[key];
  }

  set(key, value) {
    if (typeof key === 'object' && key !== null) {
      const changed = {};
      for (const [k, v] of Object.entries(key)) {
        if (this._cache[k] !== v) {
          this._cache[k] = v;
          changed[k] = v;
        }
      }
      this._save();
      for (const [k, v] of Object.entries(changed)) {
        this._notify(k, v);
      }
      return;
    }

    if (this._cache[key] === value) return;
    this._cache[key] = value;
    this._save();
    this._notify(key, value);
  }

  _notify(key, value) {
    for (const fn of this._listeners) {
      try {
        fn(key, value, { ...this._cache });
      } catch (err) {
        console.error('Settings listener error:', err);
      }
    }
  }

  onChange(fn) {
    if (typeof fn === 'function') {
      this._listeners.add(fn);
    }
    return () => this._listeners.delete(fn);
  }
}

export const settings = new SettingsStore();

const BACKUP_KEY = 'woodshed_last_backup';

export function getLastBackup() {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(BACKUP_KEY) || null;
    }
  } catch (_) {
    // Ignore storage errors
  }
  return null;
}

export function markBackedUp() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BACKUP_KEY, new Date().toISOString());
    }
  } catch (_) {
    // Ignore storage errors
  }
}

export async function exportLibrary() {
  const records = await listSongs();
  const songs = [];
  const CHUNK = 32768;

  for (const record of records) {
    let audio = null;
    const blob = await getAudioBlob(record.id);
    if (blob) {
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      audio = {
        type: blob.type || 'application/octet-stream',
        base64: btoa(binary)
      };
    }
    songs.push({ record, audio });
  }

  const { inputDeviceId: _omit, ...cleanSettings } = settings.get();
  const payload = {
    woodshedBackup: 1,
    exportedAt: new Date().toISOString(),
    settings: cleanSettings,
    songs
  };

  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

export async function importLibrary(file) {
  if (!file) throw new Error('This is not a Woodshed backup file.');
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (_) {
    throw new Error('This is not a Woodshed backup file.');
  }

  if (!parsed || parsed.woodshedBackup !== 1 || !Array.isArray(parsed.songs)) {
    throw new Error('This is not a Woodshed backup file.');
  }

  let songCount = 0;
  let audioCount = 0;

  for (const entry of parsed.songs) {
    const rec = entry && entry.record;
    if (!rec || !rec.song || !Array.isArray(rec.song.notes)) continue;
    const saved = await saveSong(rec);
    songCount++;

    if (entry.audio && typeof entry.audio.base64 === 'string') {
      const binary = atob(entry.audio.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: entry.audio.type || 'application/octet-stream' });
      await saveAudioBlob(saved.id, blob);
      audioCount++;
    }
  }

  if (parsed.settings && typeof parsed.settings === 'object') {
    const restored = {};
    for (const [k, v] of Object.entries(parsed.settings)) {
      if (k !== 'inputDeviceId' && Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) {
        restored[k] = v;
      }
    }
    if (Object.keys(restored).length > 0) {
      settings.set(restored);
    }
  }

  return { songs: songCount, audio: audioCount };
}
