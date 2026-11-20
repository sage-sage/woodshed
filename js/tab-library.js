const EXT_SOURCE = 'woodshed-tab-grabber';
const PAGE_SOURCE = 'woodshed';
const REQUEST_TIMEOUT_MS = 5000;

let libraryDetected = false;
let extensionVersion = '';

/** Version the Tab Grabber reported in its hello ('' until it has answered). */
export function getExtensionVersion() {
  return extensionVersion;
}
const pendingRequests = new Map();
const changeListeners = new Set();

function asString(val, fallback = '') {
  return typeof val === 'string' ? val : fallback;
}

function asFiniteNumber(val, fallback = null) {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

function asTags(val) {
  if (!Array.isArray(val)) return [];
  const out = [];
  for (const item of val) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function sanitizeEntry(raw, requireText = false) {
  if (!raw || typeof raw !== 'object') return null;
  const id = asString(raw.id).trim();
  if (!id) return null;

  const text = requireText ? asString(raw.text) : undefined;
  if (requireText && !text.trim()) return null;

  const entry = {
    id,
    title: asString(raw.title),
    artist: asString(raw.artist),
    site: asString(raw.site),
    url: asString(raw.url),
    tuning: asString(raw.tuning),
    capo: asFiniteNumber(raw.capo, null),
    bpm: asFiniteNumber(raw.bpm, null),
    tags: asTags(raw.tags),
    note: asString(raw.note),
    savedAt: asFiniteNumber(raw.savedAt, null),
    updatedAt: asFiniteNumber(raw.updatedAt, null),
    textLength: asFiniteNumber(raw.textLength, 0)
  };

  if (requireText) {
    entry.text = text;
    // A saved Songsterr tab keeps its exact-rhythm data (and video timings); without it the import fell back
    // to the plain text and lost the track info.
    const n = raw.notation;
    if (n && typeof n === 'object' && !Array.isArray(n) && n.format === 'songsterr' && Array.isArray(n.measures)) {
      entry.notation = n;
    }
  }
  return entry;
}

function notifyChange() {
  for (const cb of [...changeListeners]) {
    try {
      cb();
    } catch (_) {
      // Ignore listener errors so other subscribers still run
    }
  }
}

function makeRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sendLibraryRequest(op, entryId) {
  return new Promise((resolve, reject) => {
    const id = makeRequestId();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Woodshed Tab Grabber did not respond in time.'));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timer, op });

    const msg = { source: PAGE_SOURCE, type: 'library-request', id, op };
    if (entryId !== undefined) msg.entryId = entryId;
    window.postMessage(msg, window.location.origin);
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.source !== EXT_SOURCE) return;

  if (data.type === 'hello') {
    if (typeof data.version === 'string') extensionVersion = data.version.slice(0, 20);
    if (data.library === true && !libraryDetected) {
      libraryDetected = true;
      notifyChange();
    }
    return;
  }

  if (data.type === 'library-changed') {
    if (!libraryDetected) {
      libraryDetected = true;
    }
    notifyChange();
    return;
  }

  if (data.type === 'library-response') {
    const id = asString(data.id);
    if (!id || !pendingRequests.has(id)) return;
    const pending = pendingRequests.get(id);
    pendingRequests.delete(id);
    clearTimeout(pending.timer);

    if (data.ok !== true) {
      const errMsg = asString(data.error, 'Tab Grabber library request failed.');
      pending.reject(new Error(errMsg));
      return;
    }

    if (pending.op === 'list') {
      if (!Array.isArray(data.entries)) {
        pending.reject(new Error('Invalid library list returned by Tab Grabber.'));
        return;
      }
      const entries = [];
      for (const item of data.entries) {
        const clean = sanitizeEntry(item, false);
        if (clean) entries.push(clean);
      }
      pending.resolve(entries);
      return;
    }

    if (pending.op === 'get') {
      const entry = sanitizeEntry(data.entry, true);
      if (!entry) {
        pending.reject(new Error('Invalid or empty tab entry returned by Tab Grabber.'));
        return;
      }
      pending.resolve(entry);
      return;
    }

    pending.resolve(true);
  }
});

export function detectTabLibrary(timeoutMs = 900) {
  if (libraryDetected) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let unsub = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (unsub) unsub();
      resolve(result);
    };

    unsub = onSavedTabsChange(() => {
      if (libraryDetected) finish(true);
    });

    timer = setTimeout(() => {
      finish(libraryDetected);
    }, Math.max(0, Number(timeoutMs) || 900));

    window.postMessage({ source: PAGE_SOURCE, type: 'ping' }, window.location.origin);
  });
}

export function listSavedTabs() {
  return sendLibraryRequest('list');
}

export function getSavedTab(id) {
  const entryId = asString(id).trim();
  if (!entryId) {
    return Promise.reject(new Error('Missing saved tab ID.'));
  }
  return sendLibraryRequest('get', entryId);
}

export function deleteSavedTab(id) {
  const entryId = asString(id).trim();
  if (!entryId) {
    return Promise.reject(new Error('Missing saved tab ID.'));
  }
  return sendLibraryRequest('delete', entryId);
}

export function onSavedTabsChange(cb) {
  if (typeof cb !== 'function') return () => {};
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}
