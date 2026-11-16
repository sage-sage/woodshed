import { TONE_NAMES } from './tone-suggest.js';
import { DEMO_SONG_TAB, TUNINGS, midiToName } from './song.js';
import { parseAsciiTab } from './tab-ascii.js';
import { getAudioContext, resumeAudio } from './audio-context.js';
import { GuitarInput } from './audio-input.js';
import { AmpLink } from './amp-link.js';
import { GuitarSynth } from './synth.js';
import * as store from './store.js';
import { mount as mountGame } from './game.js';
import { mount as mountTuner } from './tuner.js';
import { mount as mountImport } from './import.js';
import { mount as mountLearn } from './learn.js';
import { mount as mountSync } from './sync-ui.js';
import { mount as mountSetup } from './setup.js';
import { runCalibration } from './calibrate.js';
import { fetchLatest, compareVersions } from './updates.js';
import { isDesktop, desktop, SETUP_URL, wireDesktopUpdates, mountTitleBar } from './desktop.js';
import {
  detectTabLibrary,
  getExtensionVersion,
  listSavedTabs,
  getSavedTab,
  deleteSavedTab,
  onSavedTabsChange
} from './tab-library.js';

const input = new GuitarInput();
const synth = new GuitarSynth();
const amp = new AmpLink();
const { settings } = store;

let currentViewInstance = null;
let currentRecord = null;
let pendingTabImport = null;

const MAX_IMPORT_STR_BYTES = 1024 * 1024; // long Songsterr reads can pass 200 KB

function isValidStr(val, maxLen = MAX_IMPORT_STR_BYTES) {
  return typeof val === 'string' && new TextEncoder().encode(val).length <= maxLen;
}

function acceptTabImport(p, { ack = false } = {}) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.ts !== 'number' || !Number.isFinite(p.ts)) return false;
  if (!isValidStr(p.text) || !p.text.trim()) return false;
  if (p.title !== undefined && !isValidStr(p.title)) return false;
  if (p.artist !== undefined && !isValidStr(p.artist)) return false;
  if (p.tuning !== undefined && !isValidStr(p.tuning)) return false;
  if (p.source !== undefined && !isValidStr(p.source)) return false;
  if (p.url !== undefined && !isValidStr(p.url)) return false;
  if (p.capo !== undefined && p.capo !== null && (typeof p.capo !== 'number' || !Number.isFinite(p.capo) || p.capo < 0 || p.capo > 24)) return false;
  if (p.bpm !== undefined && p.bpm !== null && (typeof p.bpm !== 'number' || !Number.isFinite(p.bpm) || p.bpm < 20 || p.bpm > 400)) return false;

  pendingTabImport = {
    v: p.v || 1,
    title: p.title || '',
    artist: p.artist || '',
    tuning: p.tuning || '',
    capo: p.capo ?? null,
    bpm: p.bpm ?? null,
    text: p.text,
    source: p.source || 'web',
    url: p.url || '',
    ts: p.ts
  };

  if (ack) {
    window.postMessage({ source: 'woodshed', type: 'import-tab-received', ts: p.ts }, window.location.origin);
  }

  if ((location.hash || '').startsWith('#/import')) {
    window.dispatchEvent(new CustomEvent('woodshed:tab-import'));
  } else {
    navigate('#/import');
  }
  return true;
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'woodshed-tab-grabber' || data.type !== 'import-tab') return;
  acceptTabImport(data.payload, { ack: true });
});

function toast(msg, kind = 'info', opts = {}) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;

  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);

  if (opts.actionLabel && typeof opts.onAction === 'function') {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => {
      opts.onAction();
      el.remove();
    });
    el.appendChild(btn);
  }

  region.appendChild(el);
  // Toasts with an action (like Undo) stay up longer so there is time to use it.
  setTimeout(() => {
    el.remove();
  }, opts.actionLabel ? 9000 : 4800);
}

function navigate(route) {
  if (location.hash === route) {
    handleRouteChange();
  } else {
    location.hash = route;
  }
}

async function saveRecord(record) {
  const saved = await store.saveSong(record);
  if (currentRecord && currentRecord.id === saved.id) {
    currentRecord = saved;
    ctx.record = saved;
  }
  return saved;
}

const ctx = {
  input,
  synth,
  amp,
  settings,
  store,
  navigate,
  toast,
  record: null,
  saveRecord,
  takePendingTabImport() {
    const data = pendingTabImport;
    pendingTabImport = null;
    return data;
  }
};

globalThis.window.woodshed = { ctx, game: null };

// Input state & rail meter loop
function syncInputSource() {
  const mode = settings.get('inputSource') || 'auto';
  // In auto mode the amp is only used while its audio is really running (interface plugged in and opened).
  const wantAmp = mode === 'amp' || (mode === 'auto' && ampRunning());
  if (wantAmp && amp.state === 'online') {
    const audioCtx = getAudioContext();
    amp.initAudio(audioCtx);
    input.useAmpSource(amp.ampSource);
    amp.setStreaming(true);
  } else if (input.sourceKind === 'amp') {
    input.useAmpSource(null);
  }
  updateRailStatus();
}

input.addEventListener('error', (e) => {
  toast(e.detail?.message || 'Guitar input error', 'error');
  updateRailStatus();
});
input.addEventListener('state', () => updateRailStatus());
amp.addEventListener('state', () => syncInputSource());
let lastAmpRunning = false;
amp.addEventListener('status', () => {
  if (ampRunning() !== lastAmpRunning) {
    lastAmpRunning = ampRunning();
    syncInputSource();
    return;
  }
  if (input.sourceKind === 'amp') updateRailStatus();
});
amp.addEventListener('error', (e) => {
  toast(e.detail?.message || 'Woodshed Amp error', 'error');
});
settings.onChange((key) => {
  if (key === 'inputSource') syncInputSource();
});

function ampRunning() {
  return amp.state === 'online' && amp.status?.running === true;
}

function updateRailStatus() {
  const dot = document.getElementById('rail-input-dot');
  const statusEl = document.getElementById('rail-input-status');
  const btn = document.getElementById('rail-connect-btn');
  if (!dot || !statusEl || !btn) return;

  if (input.sourceKind === 'amp' && amp.state === 'online') {
    if (!ampRunning()) {
      dot.className = 'status-dot error';
      statusEl.textContent = 'Woodshed Amp: no audio interface';
      btn.textContent = 'Disconnect';
      btn.classList.remove('btn-primary');
      return;
    }
    // What you HEAR: the interface's round trip, plus the speakers' delay when "Also play through" is on.
    // (The browser's scoring buffer is compensated automatically and isn't something you hear.)
    const st = amp.status || {};
    const rt = Number(st.roundTripMs);
    let heard = Number.isFinite(rt) && rt > 0 ? `${rt.toFixed(1)} ms` : '';
    if (st.monitorRunning && Number.isFinite(st.monitorLatencyMs) && st.monitorLatencyMs > 0) {
      heard += `${heard ? ' · ' : ''}speakers ${Math.round(st.monitorLatencyMs)} ms`;
    }
    dot.className = 'status-dot live';
    statusEl.textContent = heard ? `Guitar via Woodshed Amp - ${heard}` : 'Guitar via Woodshed Amp';
    statusEl.title = `You hear: interface ${Number.isFinite(rt) ? rt.toFixed(1) : '?'} ms`
      + (st.monitorRunning ? `, speakers ${Math.round(st.monitorLatencyMs || 0)} ms` : '')
      + ` · scoring buffer ${Math.round(amp.streamLatencyMs)} ms (compensated)`;
    btn.textContent = 'Disconnect';
    btn.classList.remove('btn-primary');
    return;
  }

  dot.className = `status-dot ${input.state === 'live' ? 'live' : input.state === 'error' ? 'error' : ''}`;
  if (input.state === 'live') {
    statusEl.textContent = 'Guitar Live';
    btn.textContent = 'Disconnect';
    btn.classList.remove('btn-primary');
  } else if (input.state === 'starting') {
    statusEl.textContent = 'Connecting...';
    btn.textContent = 'Starting...';
  } else {
    statusEl.textContent = 'Guitar Offline';
    btn.textContent = 'Connect Guitar';
    btn.classList.add('btn-primary');
  }
}

document.getElementById('rail-connect-btn')?.addEventListener('click', async () => {
  try {
    await resumeAudio();
    if (input.sourceKind === 'amp') {
      input.useAmpSource(null);
      return;
    }
    if (input.state === 'live') {
      input.stop();
    } else {
      const mode = settings.get('inputSource') || 'auto';
      if ((mode === 'auto' && ampRunning()) || (mode === 'amp' && amp.state === 'online')) {
        syncInputSource();
        toast('Connected via Woodshed Amp.', 'success');
        return;
      }
      if (mode === 'amp') {
        amp.connect();
        toast('Waiting for Woodshed Amp tray app...', 'info');
        return;
      }
      await input.start({
        deviceId: settings.get('inputDeviceId'),
        channel: settings.get('inputChannel')
      });
      input.setMonitor(settings.get('monitor'), settings.get('monitorGain'));
      toast('Guitar input connected.', 'success');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

function updateRailMeterLoop() {
  const fill = document.getElementById('rail-meter-fill');
  const pitchEl = document.getElementById('rail-pitch-readout');
  if (fill && pitchEl) {
    const r = input.read();
    fill.style.width = `${Math.round(r.level * 100)}%`;
    if (r.midi > 0 && r.clarity >= 0.7) {
      pitchEl.textContent = `${midiToName(Math.round(r.midi))} · ${r.freq.toFixed(1)} Hz`;
    } else {
      pitchEl.textContent = input.state === 'live' ? 'Listening...' : '—';
    }
  }
  requestAnimationFrame(updateRailMeterLoop);
}

// Seed Demo Song on First Run
async function ensureDemoSong() {
  const songs = await store.listSongs();
  if (songs.length === 0) {
    const demoSong = parseAsciiTab(DEMO_SONG_TAB, {
      bpm: 112,
      title: 'Timberline Drive',
      artist: 'Woodshed House Band'
    });
    demoSong.id = 'demo';
    demoSong.source = 'demo';
    await store.saveSong({
      id: 'demo',
      song: demoSong,
      sync: { anchors: [] },
      audio: { kind: 'none' },
      importText: DEMO_SONG_TAB
    });
  }
}

function getTuningName(tuning) {
  if (!Array.isArray(tuning)) return 'Standard';
  for (const [name, arr] of Object.entries(TUNINGS)) {
    if (arr.length === tuning.length && arr.every((v, i) => v === tuning[i])) {
      return name;
    }
  }
  return tuning.map((m) => midiToName(m).replace(/\d+$/, '')).join(' ');
}

function formatDuration(sec) {
  const s = Math.max(1, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isStandardTuning(tuning) {
  if (typeof tuning !== 'string') return true;
  const t = tuning.trim().toLowerCase();
  if (!t) return true;
  if (t === 'standard' || t === 'e standard' || t === 'standard tuning') return true;
  const compact = t.replace(/[\s\-_]+/g, '');
  return compact === 'eadgbe' || compact === 'e2a2d3g3b3e4';
}

// Built-in Library View
function mountLibrary(container) {
  let active = true;
  let savedTabsState = 'checking'; // 'checking' | 'unavailable' | 'ready' | 'error'
  let savedTabsError = '';
  let savedEntries = [];
  let savedSearchQuery = '';
  let confirmRemoveId = null;
  let confirmRemoveTimer = null;

  function clearConfirmRemove() {
    if (confirmRemoveTimer) {
      clearTimeout(confirmRemoveTimer);
      confirmRemoveTimer = null;
    }
    confirmRemoveId = null;
  }

  function getFilteredSavedEntries() {
    const q = savedSearchQuery.trim().toLowerCase();
    if (!q) return savedEntries;
    return savedEntries.filter((entry) => {
      if (entry.title.toLowerCase().includes(q)) return true;
      if (entry.artist.toLowerCase().includes(q)) return true;
      if (entry.site.toLowerCase().includes(q)) return true;
      return entry.tags.some((tag) => tag.toLowerCase().includes(q));
    });
  }

  function renderSavedTabsList(listHost, countEl) {
    if (!listHost) return;
    const filtered = getFilteredSavedEntries();
    if (countEl) {
      countEl.textContent = `${filtered.length} saved`;
    }

    listHost.replaceChildren();

    if (savedEntries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'saved-tab-meta';
      empty.textContent = 'Nothing saved yet. On a tab page, click the Tab Grabber and choose Save to Library.';
      listHost.appendChild(empty);
      return;
    }

    if (filtered.length === 0) {
      const none = document.createElement('p');
      none.className = 'saved-tab-meta';
      none.textContent = 'No saved tabs match your search.';
      listHost.appendChild(none);
      return;
    }

    for (const entry of filtered) {
      const row = document.createElement('div');
      row.className = 'saved-tab-row';

      const main = document.createElement('div');
      main.className = 'saved-tab-main';

      const titleEl = document.createElement('strong');
      titleEl.className = 'saved-tab-title';
      titleEl.textContent = entry.title || 'Untitled Tab';
      main.appendChild(titleEl);

      if (entry.artist) {
        const artistEl = document.createElement('span');
        artistEl.className = 'saved-tab-meta';
        artistEl.textContent = entry.artist;
        main.appendChild(artistEl);
      }

      if (entry.site) {
        const siteChip = document.createElement('span');
        siteChip.className = 'chip';
        siteChip.textContent = entry.site;
        main.appendChild(siteChip);
      }

      if (!isStandardTuning(entry.tuning)) {
        const tuningChip = document.createElement('span');
        tuningChip.className = 'chip';
        tuningChip.textContent = entry.tuning.trim();
        main.appendChild(tuningChip);
      }

      for (const tag of entry.tags) {
        const tagChip = document.createElement('span');
        tagChip.className = 'chip';
        tagChip.textContent = tag;
        main.appendChild(tagChip);
      }

      if (typeof entry.savedAt === 'number' && Number.isFinite(entry.savedAt) && entry.savedAt > 0) {
        const dateEl = document.createElement('span');
        dateEl.className = 'saved-tab-meta';
        dateEl.textContent = new Date(entry.savedAt).toLocaleDateString();
        main.appendChild(dateEl);
      }

      const actions = document.createElement('div');
      actions.className = 'saved-tab-actions';

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-primary btn-sm';
      addBtn.textContent = 'Add to Woodshed';
      addBtn.addEventListener('click', async () => {
        addBtn.disabled = true;
        addBtn.textContent = 'Adding…';
        try {
          const full = await getSavedTab(entry.id);
          if (!active) return;
          const ok = acceptTabImport({
            v: 1,
            title: full.title,
            artist: full.artist,
            tuning: full.tuning,
            capo: typeof full.capo === 'number' && full.capo >= 0 && full.capo <= 24 ? full.capo : null,
            bpm: typeof full.bpm === 'number' && full.bpm >= 20 && full.bpm <= 400 ? full.bpm : null,
            text: full.text,
            source: full.site || 'web',
            url: full.url,
            ts: Date.now()
          }, { ack: false });
          if (!ok) {
            toast('Saved tab could not be imported.', 'error');
          }
        } catch (err) {
          if (active) {   
            toast(err && err.message ? err.message : 'Failed to load saved tab.', 'error');
          }
        } finally {
          if (active && addBtn.isConnected) {
            addBtn.disabled = false;
            addBtn.textContent = 'Add to Woodshed';
          }
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn-ghost btn-danger btn-sm';
      removeBtn.textContent = confirmRemoveId === entry.id ? 'Confirm' : 'Remove';
      removeBtn.addEventListener('click', async () => {
        if (confirmRemoveId !== entry.id) {
          clearConfirmRemove();
          confirmRemoveId = entry.id;
          removeBtn.textContent = 'Confirm';
          confirmRemoveTimer = setTimeout(() => {
            if (confirmRemoveId === entry.id) {
              confirmRemoveId = null;
              confirmRemoveTimer = null;
              if (removeBtn.isConnected) removeBtn.textContent = 'Remove';
            }
          }, 4000);
          return;
        }

        clearConfirmRemove();
        removeBtn.disabled = true;
        try {
          await deleteSavedTab(entry.id);
          if (!active) return;
          savedEntries = savedEntries.filter((item) => item.id !== entry.id);
          renderSavedTabsList(listHost, countEl);
        } catch (err) {
          if (active) {
            toast(err && err.message ? err.message : 'Failed to remove saved tab.', 'error');
            if (removeBtn.isConnected) {
              removeBtn.disabled = false;
              removeBtn.textContent = 'Remove';
            }
          }
        }
      });

      actions.appendChild(addBtn);
      actions.appendChild(removeBtn);

      row.appendChild(main);
      row.appendChild(actions);
      listHost.appendChild(row);
    }
  }

  function renderSavedTabsSection() {
    const section = container.querySelector('#saved-tabs-section');
    if (!section) return;

    section.classList.remove('hidden');
    section.replaceChildren();

    const header = document.createElement('div');
    const heading = document.createElement('h2');
    heading.className = 'serif-heading';
    heading.style.marginBottom = '4px';
    heading.textContent = 'Saved Tabs';

    const desc = document.createElement('p');
    desc.className = 'saved-tab-meta';
    desc.style.margin = '0';
    desc.textContent = 'Tabs you saved with the Woodshed Tab Grabber. Add one to turn it into a playable song.';

    header.appendChild(heading);
    header.appendChild(desc);
    section.appendChild(header);

    if (savedTabsState === 'checking') {
      const status = document.createElement('p');
      status.className = 'saved-tab-meta';
      status.style.margin = '0';
      status.textContent = 'Looking for the Tab Grabber…';
      section.appendChild(status);
      return;
    }

    if (savedTabsState === 'unavailable') {
      const installNote = document.createElement('p');
      installNote.className = 'saved-tab-meta';
      installNote.style.margin = '0';
      installNote.textContent = 'Install the Woodshed Tab Grabber extension (in the Woodshed folder) to save tabs from Ultimate Guitar, Songsterr and others into this library.';
      section.appendChild(installNote);
      return;
    }

    if (savedTabsState === 'error') {
      const errEl = document.createElement('p');
      errEl.className = 'saved-tab-meta';
      errEl.style.margin = '0';
      errEl.textContent = savedTabsError;
      section.appendChild(errEl);
      return;
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'saved-tabs-toolbar';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'input';
    searchInput.placeholder = 'Search saved tabs by title, artist, site, or tag…';
    searchInput.setAttribute('aria-label', 'Search saved tabs');
    searchInput.value = savedSearchQuery;

    const countEl = document.createElement('span');
    countEl.className = 'saved-tab-meta';

    toolbar.appendChild(searchInput);
    toolbar.appendChild(countEl);
    section.appendChild(toolbar);

    const listHost = document.createElement('div');
    section.appendChild(listHost);

    searchInput.addEventListener('input', () => {
      savedSearchQuery = searchInput.value;
      renderSavedTabsList(listHost, countEl);
    });

    renderSavedTabsList(listHost, countEl);
  }

  async function refreshSavedTabs() {
    try {
      const entries = await listSavedTabs();
      if (!active) return;
      savedEntries = entries;
      savedTabsState = 'ready';
      savedTabsError = '';
    } catch (err) {
      if (!active) return;
      savedTabsState = 'error';
      savedTabsError = err && err.message ? err.message : 'Failed to load saved tabs.';
    }
    renderSavedTabsSection();
  }

  const unsubscribeSavedTabs = onSavedTabsChange(() => {
    if (!active) return;
    refreshSavedTabs();
  });

  async function render() {
    const records = await store.listSongs();
    if (!active) return;

    const cardsHtml = records.map((rec) => {
      const s = rec.song;
      const tuningName = getTuningName(s.tuning);
      const stars = rec.best ? ('★'.repeat(rec.best.stars) + '☆'.repeat(5 - rec.best.stars)) : '☆☆☆☆☆';
      const accText = rec.best ? `${(rec.best.accuracy * 100).toFixed(0)}% best` : 'Not played yet';
      const badgeLabel = s.source === 'gp' ? 'Guitar Pro / XML' : s.source === 'demo' ? 'Built-in Demo' : 'ASCII Tab';
      const safeId = escapeHtml(rec.id);
      const safeTitle = escapeHtml(s.title);

      return `
        <article class="card song-card" data-song-id="${safeId}">
          <div>
            <h2 class="song-card-title" title="${safeTitle}">${safeTitle}</h2>
            <p class="song-card-artist">${escapeHtml(s.artist)}</p>
            <div class="song-card-badges">
              <span class="chip chip-accent">${escapeHtml(badgeLabel)}</span>
              <span class="chip">${escapeHtml(tuningName)}</span>
              <span class="chip">${Math.round(s.bpm)} BPM</span>
              <span class="chip">${escapeHtml(formatDuration(s.duration))}</span>
            </div>
          </div>

          <div class="song-card-footer">
            <div>
              <div class="stars-display">${escapeHtml(stars)}</div>
              <div style="font-size:0.76rem;color:var(--text-muted);">${escapeHtml(accText)}</div>
            </div>
            <div style="display:flex;gap:6px;">
              <button type="button" class="btn btn-sm btn-ghost export-song-btn" data-id="${safeId}" title="Export JSON">Export</button>
              <button type="button" class="btn btn-sm btn-ghost btn-danger delete-song-btn" data-id="${safeId}" data-title="${safeTitle}">Delete</button>
              <a href="#/song/${safeId}/play" class="btn btn-sm btn-primary">Play</a>
            </div>
          </div>
        </article>
      `;
    }).join('');

    container.innerHTML = `
      <div class="page-title-row">
        <div>
          <h1 class="page-title">Song Library</h1>
          <p style="margin:4px 0 0;color:var(--text-muted);">Choose a song to play, study its harmony in Learn mode, or align it to a backing recording.</p>
        </div>
        <div style="display:flex;gap:10px;">
          <label class="btn" style="cursor:pointer;">
            Import JSON / Tab File
            <input type="file" id="lib-quick-import" accept=".json,.txt,.tab" class="hidden" />
          </label>
          <a href="#/import" class="btn btn-primary">+ Add a Song</a>
        </div>
      </div>

      ${records.length === 0 ? `
        <div class="empty-state">
          <p>Your practice library is empty.</p>
          <a href="#/import" class="btn btn-primary">Add Your First Song</a>
        </div>
      ` : `
        <div class="song-grid">
          ${cardsHtml}
          <a href="#/import" class="card add-song-card">
            <span style="font-size:2.2rem;line-height:1;margin-bottom:8px;">+</span>
            <strong>Add a Song</strong>
            <span style="font-size:0.82rem;margin-top:4px;">Paste ASCII tab, drop Guitar Pro / MusicXML, or link YouTube</span>
          </a>
        </div>
      `}

      <section class="saved-tabs" id="saved-tabs-section"></section>
    `;

    renderSavedTabsSection();

    container.querySelector('#lib-quick-import')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const rec = await store.importSongFile(file);
        toast(`Imported "${rec.song.title}"`, 'success');
        render();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    container.querySelectorAll('.export-song-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const blob = await store.exportSong(btn.dataset.id);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `woodshed-${btn.dataset.id}.json`;
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('.delete-song-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        confirmDeleteModal(btn.dataset.id, btn.dataset.title, () => render());
      });
    });
  }

  render();

  detectTabLibrary().then((found) => {
    if (!active) return;
    if (!found) {
      savedTabsState = 'unavailable';
      renderSavedTabsSection();
      return;
    }
    refreshSavedTabs();
  });

  return {
    unmount() {
      active = false;
      clearConfirmRemove();
      unsubscribeSavedTabs();
    }
  };
}

function confirmDeleteModal(id, title, onDeleted) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal" style="max-width:440px;">
      <h3 style="font-family:var(--font-serif);font-size:1.4rem;margin:0 0 8px;">Delete "${escapeHtml(title)}"?</h3>
      <p style="color:var(--text-muted);margin:0 0 20px;">This removes the song, its sync anchors, and practice history from this browser.</p>
      <div style="display:flex;justify-content:flex-end;gap:10px;">
        <button type="button" class="btn btn-ghost" id="del-cancel-btn">Cancel</button>
        <button type="button" class="btn btn-danger" id="del-confirm-btn">Delete Song</button>
      </div>
    </div>
  `;
  modalRoot.classList.remove('hidden');

  modalRoot.querySelector('#del-cancel-btn')?.addEventListener('click', () => modalRoot.classList.add('hidden'));
  modalRoot.querySelector('#del-confirm-btn')?.addEventListener('click', async () => {
    await store.deleteSong(id);
    modalRoot.classList.add('hidden');
    toast(`Deleted "${title}"`, 'info');
    onDeleted();
  });
}

// Settings > Downloads: the zips come from downloads/ (built by tools/package.py).
async function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Built-in Settings View (with 8-click Latency Calibrator)
// Settings > Downloads: compare the running amp and the installed Tab Grabber with version.json.
function showVersions(container) {
  let alive = true;
  const line = (sel, html, kind) => {
    const el = container.querySelector(sel);
    if (!el) return;
    el.innerHTML = html;
    el.className = `dl-version${kind ? ` is-${kind}` : ''}`;
  };
  async function refresh() {
    const latest = await fetchLatest();
    if (!alive) return;
    const ampLatest = latest?.amp?.version || '';
    const ampHave = amp.state === 'online' ? (amp.serverInfo?.version || '') : '';
    const setupLatest = latest?.setup?.version || '';
    if (isDesktop) {
      const newer = setupLatest && compareVersions(setupLatest, desktop.version) > 0;
      line('#dl-amp-ver', newer
        ? `This is Woodshed ${escapeHtml(desktop.version)}; ${escapeHtml(setupLatest)} is available.`
        : `This is Woodshed ${escapeHtml(desktop.version)}${setupLatest ? ': up to date' : ''}.`, newer ? 'warn' : (setupLatest ? 'good' : ''));
    } else if (!ampHave) {
      line('#dl-amp-ver', setupLatest || ampLatest ? `Latest: ${escapeHtml(setupLatest || ampLatest)}` : '');
    } else if (ampLatest && compareVersions(ampLatest, ampHave) > 0) {
      const how = compareVersions(ampHave, '1.3.0') >= 0
        ? 'Right-click the amp’s tray icon and choose <b>Update</b>.'
        : 'This version can’t update itself: download Woodshed Setup once, after that it updates on its own.';
      line('#dl-amp-ver', `Running ${escapeHtml(ampHave)}, update ${escapeHtml(ampLatest)} available. ${how}`, 'warn');
    } else if (!ampLatest) {
      line('#dl-amp-ver', `Running ${escapeHtml(ampHave)}.`);
    } else {
      line('#dl-amp-ver', `Running ${escapeHtml(ampHave)}: up to date.`, 'good');
    }
    const found = await detectTabLibrary();
    if (!alive) return;
    const extHave = found ? getExtensionVersion() : '';
    const extLatest = latest?.extension?.version || '';
    if (!extHave) {
      line('#dl-ext-ver', extLatest ? `Latest: ${escapeHtml(extLatest)}` : '');
    } else if (extLatest && compareVersions(extLatest, extHave) > 0) {
      line('#dl-ext-ver', `Installed ${escapeHtml(extHave)}, update ${escapeHtml(extLatest)} available. Download it, unzip over the old folder, then press the reload arrow on the extension in <code>chrome://extensions</code>.`, 'warn');
    } else if (!extLatest) {
      line('#dl-ext-ver', `Installed ${escapeHtml(extHave)}.`);
    } else {
      line('#dl-ext-ver', `Installed ${escapeHtml(extHave)}: up to date.`, 'good');
    }
  }
  refresh();
  amp.addEventListener('state', refresh);
  return () => { alive = false; amp.removeEventListener('state', refresh); };
}

function mountSettings(container) {
  let rafId = null;

  container.innerHTML = `
    <div class="page-title-row">
      <h1 class="page-title">Studio Settings</h1>
    </div>

    <div class="settings-grid">
      <section class="card">
        <h2 style="font-family:var(--font-serif);margin:0 0 14px;">Audio Interface & Guitar Input</h2>

        <div class="field">
          <label for="set-device">Input Device</label>
          <div style="display:flex;gap:8px;">
            <select class="select" id="set-device" style="flex:1;">
              <option value="">System Default Input</option>
            </select>
            <button type="button" class="btn" id="set-refresh-devices">Refresh</button>
          </div>
        </div>

        <div class="field">
          <label for="set-channel">Interface Channel Selection</label>
          <select class="select" id="set-channel">
            <option value="mix">Stereo Mix (Input 1 + 2)</option>
            <option value="left">Input 1 Only (Left Channel)</option>
            <option value="right">Input 2 Only (Right Channel)</option>
          </select>
        </div>

        <div class="field">
          <label>Live Input Meter</label>
          <div class="meter-track" style="height:10px;">
            <div class="meter-fill" id="set-live-meter"></div>
          </div>
        </div>

        <div class="field" style="flex-direction:row;align-items:center;justify-content:space-between;margin-top:12px;">
          <label for="set-monitor" style="margin:0;">Direct Browser Monitor (Hear Guitar)</label>
          <input type="checkbox" id="set-monitor" ${settings.get('monitor') ? 'checked' : ''} />
        </div>

        <div class="field">
          <label for="set-monitor-gain">Monitor Gain (<span id="set-mon-gain-val">${Math.round(settings.get('monitorGain') * 100)}%</span>)</label>
          <input type="range" class="slider" id="set-monitor-gain" min="0" max="1.5" step="0.05" value="${settings.get('monitorGain')}" />
        </div>
      </section>

      <section class="card">
        <h2 style="font-family:var(--font-serif);margin:0 0 14px;">Timing, Calibration & Reference</h2>

        <div class="field">
          <label for="set-latency">Input Latency Compensation (<span id="set-lat-val" class="tabular">${settings.get('latencyMs')}</span> ms)</label>
          <input type="range" class="slider" id="set-latency" min="0" max="200" step="1" value="${settings.get('latencyMs')}" />
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">
            <span id="cal-status-text" style="font-size:0.8rem;color:var(--text-muted);">Pluck on each of 8 clicks to measure your interface delay.</span>
            <button type="button" class="btn btn-sm" id="btn-calibrate-latency">Calibrate (8 Clicks)</button>
          </div>
        </div>

        <div class="field">
          <label for="set-hit-window">Scoring Hit Window (±<span id="set-win-val" class="tabular">${settings.get('hitWindowMs')}</span> ms)</label>
          <input type="range" class="slider" id="set-hit-window" min="60" max="180" step="5" value="${settings.get('hitWindowMs')}" />
        </div>

        <div class="field">
          <label for="set-a4">A4 Reference Pitch (<span id="set-a4-val" class="tabular">${settings.get('a4')}</span> Hz)</label>
          <input type="range" class="slider" id="set-a4" min="430" max="450" step="1" value="${settings.get('a4')}" />
        </div>

        <div class="field" style="flex-direction:row;align-items:center;justify-content:space-between;">
          <label for="set-lefthanded" style="margin:0;">Left-Handed Fretboard Orientation</label>
          <input type="checkbox" id="set-lefthanded" ${settings.get('leftHanded') ? 'checked' : ''} />
        </div>

        <div class="field" style="flex-direction:row;align-items:center;justify-content:space-between;">
          <label for="set-notenames" style="margin:0;">Show Note Names Instead of Fret Numbers</label>
          <input type="checkbox" id="set-notenames" ${settings.get('showNoteNames') ? 'checked' : ''} />
        </div>

        <div class="field">
          <label for="set-guide-tone">Guide Sound (the synth that plays the tab)</label>
          <select class="select" id="set-guide-tone">
            <option value="match" ${(settings.get('guideTone') || 'match') === 'match' ? 'selected' : ''}>Match the song's tone</option>
            ${Object.entries(TONE_NAMES).map(([id, name]) => `<option value="${id}" ${settings.get('guideTone') === id ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
          </select>
        </div>
      </section>

      <section class="card" style="grid-column:1 / -1;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:10px;">
            <h2 style="font-family:var(--font-serif);margin:0;">Woodshed Amp</h2>
            <span class="chip" id="amp-conn-chip">Offline</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label for="set-input-source" style="font-size:0.84rem;color:var(--text-muted);">Input Source</label>
            <select class="select" id="set-input-source">
              <option value="auto">Auto (Amp when online)</option>
              <option value="amp">Woodshed Amp Only</option>
              <option value="browser">Browser Input Only</option>
            </select>
          </div>
        </div>
        <div id="amp-card-body"></div>
      </section>

      <section class="card" style="grid-column:1 / -1;">
        <h2 style="font-family:var(--font-serif);margin:0 0 14px;">Downloads</h2>
        <div class="dl-grid">
          <div class="dl-item">
            <div class="dl-head"><strong>Woodshed for Windows</strong><span class="chip">Windows</span></div>
            <p class="dl-desc">One installer for the Woodshed app (the game in its own window, works offline) and Woodshed Amp (plays your guitar through amp tones with almost no delay over ASIO, and feeds Woodshed for scoring). Pick what you want during setup.</p>
            ${isDesktop
              ? `<button type="button" class="btn btn-primary" id="dl-check-update">Check for updates</button>`
              : `<a class="btn btn-primary" id="dl-amp" href="${SETUP_URL}">Download Woodshed Setup</a>`}
            <p class="dl-version" id="dl-amp-ver"></p>
          </div>
          <div class="dl-item">
            <div class="dl-head"><strong>Tab Grabber</strong><span class="chip">Chrome extension</span></div>
            <p class="dl-desc">Saves tabs from Songsterr, Ultimate Guitar and other tab sites into your library. Unzip it, open <code>chrome://extensions</code>, turn on Developer mode, click Load unpacked and pick the unzipped folder.</p>
            <a class="btn btn-primary" id="dl-ext" href="downloads/woodshed-tab-grabber.zip" download="Woodshed Tab Grabber.zip">Download Extension</a>
            
            <p class="dl-version" id="dl-ext-ver"></p>
          </div>
        </div>
      </section>

      <section class="card bk-card">
        <div class="bk-head">
          <h2 class="bk-title">Library Backup</h2>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-run-setup">Run setup guide</button>
        </div>
        <p class="bk-desc">Your songs live only in this browser. Back up everything (songs, sync points, scores, attached audio and settings) to one file, and restore it here or on another computer.</p>
        <div class="bk-actions">
          <button type="button" class="btn btn-primary" id="bk-save">Back Up All</button>
          <button type="button" class="btn" id="bk-restore">Restore…</button>
          <input type="file" accept=".json,application/json" id="bk-file" class="bk-file-input" />
        </div>
        <p class="bk-status" id="bk-status"></p>
      </section>
    </div>
  `;

  const stopVersions = showVersions(container);
  container.querySelector('#dl-check-update')?.addEventListener('click', () => checkDesktopUpdate?.());

  const renderBackupStatus = () => {
    const el = container.querySelector('#bk-status');
    if (!el) return;
    const iso = store.getLastBackup();
    if (!iso) {
      el.textContent = 'Not backed up yet.';
      return;
    }
    const d = new Date(iso);
    el.textContent = Number.isNaN(d.getTime())
      ? 'Not backed up yet.'
      : `Last backup: ${d.toLocaleDateString()}`;
  };
  renderBackupStatus();

  const setBackupBusy = (busy) => {
    for (const id of ['#bk-save', '#bk-restore']) {
      const btn = container.querySelector(id);
      if (!btn) continue;
      btn.disabled = busy;
      if (busy) btn.setAttribute('aria-busy', 'true');
      else btn.removeAttribute('aria-busy');
    }
  };

  container.querySelector('#btn-run-setup')?.addEventListener('click', () => {
    navigate('#/setup');
  });

  container.querySelector('#bk-save')?.addEventListener('click', async () => {
    const saveBtn = container.querySelector('#bk-save');
    if (saveBtn?.getAttribute('aria-busy') === 'true') return;
    setBackupBusy(true);
    try {
      const blob = await store.exportLibrary();
      const dateStr = new Date().toISOString().slice(0, 10);
      await saveFile(blob, `woodshed-backup-${dateStr}.json`);
      store.markBackedUp();
      renderBackupStatus();
      toast('Library backup saved.', 'success');
    } catch (err) {
      if (!(err && err.code === 'declined')) {
        toast(err && err.message ? err.message : 'Backup failed.', 'error');
      }
    } finally {
      setBackupBusy(false);
    }
  });

  const bkFile = container.querySelector('#bk-file');
  container.querySelector('#bk-restore')?.addEventListener('click', () => {
    const restoreBtn = container.querySelector('#bk-restore');
    if (restoreBtn?.getAttribute('aria-busy') === 'true') return;
    if (bkFile) {
      bkFile.value = '';
      bkFile.click();
    }
  });

  bkFile?.addEventListener('change', async () => {
    const file = bkFile.files && bkFile.files[0];
    if (!file) return;
    setBackupBusy(true);
    try {
      const { songs, audio } = await store.importLibrary(file);
      toast(`Restored ${songs} songs (${audio} with audio)`, 'success');
    } catch (err) {
      toast(err && err.message ? err.message : 'Restore failed.', 'error');
    } finally {
      bkFile.value = '';
      setBackupBusy(false);
    }
  });

  const devSelect = container.querySelector('#set-device');
  const chanSelect = container.querySelector('#set-channel');
  chanSelect.value = settings.get('inputChannel');

  async function populateDevices() {
    try {
      const list = await GuitarInput.listDevices();
      const savedId = settings.get('inputDeviceId');
      devSelect.innerHTML = `<option value="">System Default Input</option>` +
        list.map((d) => `<option value="${d.deviceId}" ${d.deviceId === savedId ? 'selected' : ''}>${d.label}</option>`).join('');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  populateDevices();

  container.querySelector('#set-refresh-devices')?.addEventListener('click', populateDevices);

  devSelect?.addEventListener('change', async () => {
    settings.set('inputDeviceId', devSelect.value);
    if (input.state === 'live') {
      await input.start({ deviceId: devSelect.value, channel: settings.get('inputChannel') });
    }
  });

  chanSelect?.addEventListener('change', () => {
    settings.set('inputChannel', chanSelect.value);
    input.setChannel(chanSelect.value);
  });

  container.querySelector('#set-monitor')?.addEventListener('change', (e) => {
    settings.set('monitor', e.target.checked);
    input.setMonitor(e.target.checked, settings.get('monitorGain'));
  });

  container.querySelector('#set-monitor-gain')?.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    settings.set('monitorGain', v);
    container.querySelector('#set-mon-gain-val').textContent = `${Math.round(v * 100)}%`;
    input.setMonitor(settings.get('monitor'), v);
  });

  const latSlider = container.querySelector('#set-latency');
  const latVal = container.querySelector('#set-lat-val');
  latSlider?.addEventListener('input', () => {
    const v = parseInt(latSlider.value, 10);
    settings.set('latencyMs', v);
    latVal.textContent = String(v);
  });

  container.querySelector('#set-hit-window')?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    settings.set('hitWindowMs', v);
    container.querySelector('#set-win-val').textContent = String(v);
  });

  container.querySelector('#set-a4')?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    settings.set('a4', v);
    input.setA4(v);
    container.querySelector('#set-a4-val').textContent = String(v);
  });

  container.querySelector('#set-lefthanded')?.addEventListener('change', (e) => {
    settings.set('leftHanded', e.target.checked);
  });

  container.querySelector('#set-notenames')?.addEventListener('change', (e) => {
    settings.set('showNoteNames', e.target.checked);
  });

  container.querySelector('#set-guide-tone')?.addEventListener('change', (e) => {
    settings.set('guideTone', e.target.value);
  });

  const sourceSelect = container.querySelector('#set-input-source');
  if (sourceSelect) {
    sourceSelect.value = settings.get('inputSource') || 'auto';
    sourceSelect.addEventListener('change', () => {
      settings.set('inputSource', sourceSelect.value);
    });
  }

  function dbToPercent(db) {
    const val = Number(db);
    if (!Number.isFinite(val)) return 0;
    return Math.max(0, Math.min(100, Math.round(((val + 60) / 60) * 100)));
  }

  let renderedPresetId = null;
  function updateAmpStatusUI() {
    const st = amp.status;
    if (!st) return;
    if (st.preset && renderedPresetId !== null && st.preset !== renderedPresetId) {
      renderAmpCard(); // the active preset changed (from here, the tray menu, or a song's tone)
      return;
    }
    const devEl = container.querySelector('#amp-stat-device');
    const rateEl = container.querySelector('#amp-stat-rate');
    const bufEl = container.querySelector('#amp-stat-buffer');
    const rtEl = container.querySelector('#amp-stat-rt');
    const cpuEl = container.querySelector('#amp-stat-cpu');
    const inMeter = container.querySelector('#amp-in-meter');
    const outMeter = container.querySelector('#amp-out-meter');
    const chanSel = container.querySelector('#amp-input-channel');
    const bypassBtn = container.querySelector('#amp-btn-bypass');
    const muteBtn = container.querySelector('#amp-btn-mute');

    if (devEl) devEl.textContent = st.device || '—';
    if (rateEl) rateEl.textContent = st.sampleRate ? `${st.sampleRate} Hz` : '—';
    if (bufEl) bufEl.textContent = st.bufferFrames ? `${st.bufferFrames} smp` : '—';
    if (rtEl) rtEl.textContent = Number.isFinite(st.roundTripMs) ? `${st.roundTripMs.toFixed(1)} ms` : '—';
    if (cpuEl) cpuEl.textContent = Number.isFinite(st.cpu) ? `${Math.round(st.cpu * 100)}%` : '—';
    if (inMeter) inMeter.style.width = `${dbToPercent(st.inPeakDb)}%`;
    if (outMeter) outMeter.style.width = `${dbToPercent(st.outPeakDb)}%`;
    if (chanSel && Number.isInteger(st.inputChannel)) chanSel.value = String(st.inputChannel);
    if (bypassBtn) bypassBtn.classList.toggle('btn-primary', Boolean(st.bypass));
    if (muteBtn) muteBtn.classList.toggle('btn-primary', Boolean(st.mute));
  }

  // Presets are collapsed by default; remember which ones the player opened across re-renders.
  const openPresets = new Set();
  function renderAmpCard() {
    const chip = container.querySelector('#amp-conn-chip');
    const body = container.querySelector('#amp-card-body');
    if (!chip || !body) return;

    const stateLabel = amp.state === 'online' ? 'Online' : amp.state === 'connecting' ? 'Connecting...' : 'Offline';
    chip.textContent = stateLabel;
    chip.className = `chip ${amp.state === 'online' ? 'chip-success' : ''}`;

    if (amp.state !== 'online') {
      body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <p style="margin:0;color:var(--text-muted);">Woodshed Amp is the small companion app that plays your guitar through an amp tone with almost no delay (via your interface's ASIO driver) and sends the signal here for scoring. Start <code>woodshed-amp.exe</code> and this page connects by itself.</p>
          <button type="button" class="btn btn-sm" id="amp-btn-reconnect">Reconnect</button>
        </div>
      `;
      body.querySelector('#amp-btn-reconnect')?.addEventListener('click', () => amp.connect());
      return;
    }

    const st = amp.status || {};
    const deviceList = amp.devices?.list || [];
    const currentDevice = st.device || amp.devices?.current || '';
    const presetList = amp.presets?.list || [];
    // status.preset is the live one (the presets list is only re-sent when presets change).
    const currentPresetId = st.preset || amp.presets?.current || '';
    renderedPresetId = currentPresetId;
    // Non-ASIO "Also play through" output (laptop speakers etc.), mixed by Woodshed Amp 1.1+.
    const monitorOutputs = amp.devices?.outputs || [];
    const monitorOutput = amp.devices?.monitorOutput || '';
    let monitorNote;
    if (monitorOutput && st.monitorRunning) {
      const ms = Number.isFinite(st.monitorLatencyMs) ? Math.round(st.monitorLatencyMs) : null;
      monitorNote = `Playing through ${monitorOutput} too${ms ? `: about ${ms} ms delay` : ''}${st.monitorExclusive ? ' (exclusive)' : ''}. Headphones on your interface stay the tightest.`;
      if (st.monitorError) monitorNote += ` ${st.monitorError}`;
    } else if (monitorOutput && st.monitorError && !st.monitorRunning) {
      monitorNote = st.monitorError;
    } else if (monitorOutput) {
      monitorNote = `${monitorOutput} will start when the interface is running.`;
    } else if (monitorOutputs.length === 0) {
      monitorNote = 'Update Woodshed Amp to 1.1 to also hear your guitar on laptop speakers or another device.';
    } else {
      monitorNote = 'Use this to hear your guitar on laptop speakers or another device. It adds roughly 15–30 ms of delay.';
    }
    const sliderKeys = [
      ['gain', 'Gain'],
      ['bass', 'Bass'],
      ['mid', 'Mid'],
      ['treble', 'Treble'],
      ['presence', 'Presence']
    ];

    const presetsHtml = presetList.map((p) => {
      const isCurrent = p.id === currentPresetId;
      const params = p.params || {};
      const valOf = (key) => (Number.isFinite(params[key]) ? params[key] : 5);
      const fadersHtml = sliderKeys.map(([key, lbl]) => `
          <label class="fader">
            <span class="fader-val tabular" data-param-val="${p.id}:${key}">${valOf(key).toFixed(1)}</span>
            <span class="fader-slot">
              <input type="range" class="fader-input amp-param-slider" data-preset-id="${p.id}" data-param-key="${key}"
                min="0" max="10" step="0.1" value="${valOf(key)}" aria-label="${lbl}" />
            </span>
            <span class="fader-label">${lbl}</span>
          </label>`).join('');
      const summary = sliderKeys.map(([key, lbl]) =>
        `<span>${lbl} <b class="tabular" data-param-sum="${p.id}:${key}">${valOf(key).toFixed(1)}</b></span>`).join('');
      const files = [p.nam ? `Capture: ${escapeHtml(p.nam)}` : '', p.ir ? `IR: ${escapeHtml(p.ir)}` : ''].filter(Boolean).join(' · ');

      return `
        <details class="amp-preset${isCurrent ? ' is-active' : ''}" data-id="${p.id}" ${openPresets.has(p.id) ? 'open' : ''}>
          <summary class="amp-preset-head">
            <span class="amp-preset-chevron" aria-hidden="true"></span>
            <strong class="amp-preset-name">${escapeHtml(p.name || p.id)}</strong>
            ${isCurrent ? '<span class="chip chip-accent">Active</span>' : `<button type="button" class="btn btn-sm btn-ghost amp-select-preset" data-id="${p.id}">Select</button>`}
            <span class="amp-preset-summary">${summary}${files ? `<span class="amp-preset-files">${files}</span>` : ''}</span>
          </summary>
          <div class="amp-preset-deck">
            <div class="amp-preset-files-panel">
              <div class="amp-file-row">
                <span class="stat-label">Capture (.nam)</span>
                <strong class="amp-file-name">${escapeHtml(p.nam || 'None (built-in amp)')}</strong>
                <span class="amp-file-btns">
                  <button type="button" class="btn btn-sm amp-browse-btn" data-id="${p.id}" data-kind="nam">Load</button>
                  ${p.nam ? `<button type="button" class="btn btn-sm btn-ghost amp-clear-btn" data-id="${p.id}" data-kind="nam">Clear</button>` : ''}
                </span>
              </div>
              <div class="amp-file-row">
                <span class="stat-label">Cabinet IR (.wav)</span>
                <strong class="amp-file-name">${escapeHtml(p.ir || 'None (built-in cab)')}</strong>
                <span class="amp-file-btns">
                  <button type="button" class="btn btn-sm amp-browse-btn" data-id="${p.id}" data-kind="ir">Load</button>
                  ${p.ir ? `<button type="button" class="btn btn-sm btn-ghost amp-clear-btn" data-id="${p.id}" data-kind="ir">Clear</button>` : ''}
                </span>
              </div>
              <button type="button" class="btn btn-sm btn-ghost amp-reset-preset" data-id="${p.id}">Reset to default</button>
            </div>
            <div class="fader-bank">${fadersHtml}</div>
          </div>
        </details>
      `;
    }).join('');

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:12px;">
        <div class="stat">
          <span class="stat-label">Device</span>
          <span class="stat-value" id="amp-stat-device" style="font-size:0.95rem;">${currentDevice || '—'}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Sample Rate</span>
          <span class="stat-value tabular" id="amp-stat-rate" style="font-size:0.95rem;">${st.sampleRate ? `${st.sampleRate} Hz` : '—'}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Buffer</span>
          <span class="stat-value tabular" id="amp-stat-buffer" style="font-size:0.95rem;">${st.bufferFrames ? `${st.bufferFrames} smp` : '—'}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Round Trip</span>
          <span class="stat-value tabular" id="amp-stat-rt" style="font-size:0.95rem;">${Number.isFinite(st.roundTripMs) ? `${st.roundTripMs.toFixed(1)} ms` : '—'}</span>
        </div>
        <div class="stat">
          <span class="stat-label">CPU</span>
          <span class="stat-value tabular" id="amp-stat-cpu" style="font-size:0.95rem;">${Number.isFinite(st.cpu) ? `${Math.round(st.cpu * 100)}%` : '—'}</span>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div class="field" style="margin:0;">
          <label>Input Meter</label>
          <div class="meter-track" style="height:10px;">
            <div class="meter-fill" id="amp-in-meter" style="width:${dbToPercent(st.inPeakDb)}%;"></div>
          </div>
        </div>
        <div class="field" style="margin:0;">
          <label>Output Meter</label>
          <div class="meter-track" style="height:10px;">
            <div class="meter-fill" id="amp-out-meter" style="width:${dbToPercent(st.outPeakDb)}%;"></div>
          </div>
        </div>
      </div>

      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${deviceList.length > 0 ? `
            <div class="field" style="margin:0;">
              <label for="amp-device-select">ASIO / Audio Device</label>
              <select class="select" id="amp-device-select">
                ${deviceList.map((d) => `<option value="${escapeHtml(d)}" ${d === currentDevice ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}
              </select>
            </div>
          ` : ''}
          <div class="field" style="margin:0;">
            <label for="amp-input-channel">Input Channel</label>
            <select class="select" id="amp-input-channel">
              <option value="0" ${(st.inputChannel || 0) === 0 ? 'selected' : ''}>Input 1</option>
              <option value="1" ${st.inputChannel === 1 ? 'selected' : ''}>Input 2</option>
            </select>
          </div>
          <div class="field" style="margin:0;">
            <label for="amp-buffer-size">Buffer size</label>
            <select class="select" id="amp-buffer-size" title="Smaller = less delay. Go up a step if you hear crackles.">
              ${[...new Set([...(amp.devices?.bufferSizes || []), Number(st.requestedBufferFrames) || 0, Number(st.bufferFrames) || 0])]
                .filter((n) => n > 0).sort((a, b) => a - b)
                .map((n) => `<option value="${n}" ${n === (Number(st.requestedBufferFrames) || Number(st.bufferFrames)) ? 'selected' : ''}>${n} samples${st.sampleRate ? ` (${((n / st.sampleRate) * 1000).toFixed(1)} ms)` : ''}</option>`).join('')}
              <option value="0" ${Number(st.requestedBufferFrames) === 0 ? 'selected' : ''}>Interface default</option>
            </select>
          </div>
          <div class="field" style="margin:0;">
            <label for="amp-monitor-output">Also play through</label>
            <select class="select" id="amp-monitor-output">
              <option value="" ${monitorOutput ? '' : 'selected'}>Off (interface only)</option>
              ${monitorOutputs.map((d) => `<option value="${escapeHtml(d)}" ${d === monitorOutput ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}
            </select>
            <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;margin-top:6px;" title="Takes those speakers for Woodshed Amp alone: lowest delay, but other apps (including Woodshed's backing track, if it plays on the same speakers) go silent there.">
              <input type="checkbox" id="amp-monitor-exclusive" ${amp.devices?.monitorExclusive ? 'checked' : ''} ${monitorOutput ? '' : 'disabled'} />
              Exclusive (lowest delay)
            </label>
          </div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn ${st.bypass ? 'btn-primary' : ''}" id="amp-btn-bypass">Bypass</button>
          <button type="button" class="btn ${st.mute ? 'btn-primary' : ''}" id="amp-btn-mute">Mute</button>
          <button type="button" class="btn" id="amp-btn-asio">ASIO control panel</button>
        </div>
      </div>
      <p style="margin:-6px 0 14px;font-size:0.8rem;color:var(--text-muted);">${escapeHtml(monitorNote)}${st.bufferNote ? ` ${escapeHtml(st.bufferNote)}` : ''}</p>

      <div>
        <span class="stat-label">Presets</span>
        <div class="amp-preset-list">${presetsHtml || '<p class="empty-state">No presets reported by Woodshed Amp.</p>'}</div>
      </div>
    `;

    body.querySelector('#amp-device-select')?.addEventListener('change', (e) => {
      amp.setDevice({
        name: e.target.value,
        inputChannel: Number(body.querySelector('#amp-input-channel')?.value || 0),
        sampleRate: amp.status?.sampleRate || 48000
      });
    });

    body.querySelector('#amp-input-channel')?.addEventListener('change', (e) => {
      amp.setDevice({
        name: amp.status?.device || amp.devices?.current || '',
        inputChannel: Number(e.target.value),
        sampleRate: amp.status?.sampleRate || 48000
      });
    });

    body.querySelector('#amp-monitor-output')?.addEventListener('change', (e) => {
      amp.setMonitorOutput(e.target.value, body.querySelector('#amp-monitor-exclusive')?.checked);
    });

    body.querySelector('#amp-monitor-exclusive')?.addEventListener('change', (e) => {
      amp.setMonitorOutput(amp.devices?.monitorOutput || '', e.target.checked);
    });

    body.querySelector('#amp-buffer-size')?.addEventListener('change', (e) => {
      amp.setDevice({
        name: amp.status?.device || amp.devices?.current || '',
        inputChannel: Number(body.querySelector('#amp-input-channel')?.value || 0),
        sampleRate: amp.status?.sampleRate || 48000,
        bufferFrames: Number(e.target.value)
      });
    });

    body.querySelector('#amp-btn-bypass')?.addEventListener('click', () => {
      amp.setBypass(!amp.status?.bypass);
    });

    body.querySelector('#amp-btn-mute')?.addEventListener('click', () => {
      amp.setMute(!amp.status?.mute);
    });

    body.querySelector('#amp-btn-asio')?.addEventListener('click', () => {
      amp.openAsioPanel();
    });

    body.querySelectorAll('.amp-select-preset').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); // it sits in the <summary>: don't also open/close the preset
        amp.setPreset(btn.dataset.id);
      });
    });

    body.querySelectorAll('.amp-preset').forEach((el) => {
      el.addEventListener('toggle', () => {
        if (el.open) openPresets.add(el.dataset.id);
        else openPresets.delete(el.dataset.id);
      });
    });

    body.querySelectorAll('.amp-reset-preset').forEach((btn) => {
      btn.addEventListener('click', () => amp.resetPreset(btn.dataset.id));
    });

    body.querySelectorAll('.amp-browse-btn').forEach((btn) => {
      btn.addEventListener('click', () => amp.browse(btn.dataset.id, btn.dataset.kind));
    });

    body.querySelectorAll('.amp-clear-btn').forEach((btn) => {
      btn.addEventListener('click', () => amp.clearFile(btn.dataset.id, btn.dataset.kind));
    });

    body.querySelectorAll('.amp-param-slider').forEach((slider) => {
      slider.addEventListener('input', () => {
        const pid = slider.dataset.presetId;
        const key = slider.dataset.paramKey;
        const val = parseFloat(slider.value);
        const valEl = body.querySelector(`[data-param-val="${pid}:${key}"]`);
        if (valEl) valEl.textContent = val.toFixed(1);
        const sumEl = body.querySelector(`[data-param-sum="${pid}:${key}"]`);
        if (sumEl) sumEl.textContent = val.toFixed(1);
        amp.setParam(pid, key, val);
      });
    });
  }

  renderAmpCard();
  amp.addEventListener('state', renderAmpCard);
  amp.addEventListener('presets', renderAmpCard);
  amp.addEventListener('devices', renderAmpCard);
  amp.addEventListener('status', updateAmpStatusUI);

  // 8-click Calibrate routine
  container.querySelector('#btn-calibrate-latency')?.addEventListener('click', async () => {
    const statusText = container.querySelector('#cal-status-text');
    let res;
    try {
      res = await runCalibration({
        input,
        synth,
        settings,
        onStatus: (text) => {
          if (statusText) statusText.textContent = text;
        }
      });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (res.busy) return;
    if (res.ok) {
      latSlider.value = String(res.ms);
      latVal.textContent = String(res.ms);
      toast(`Latency calibrated to ${res.ms} ms`, 'success');
    } else {
      toast('Calibration needed at least 3 clear plucks.', 'error');
    }
  });

  function meterStep() {
    const m = container.querySelector('#set-live-meter');
    if (m) {
      m.style.width = `${Math.round(input.read().level * 100)}%`;
    }
    rafId = requestAnimationFrame(meterStep);
  }
  rafId = requestAnimationFrame(meterStep);

  return {
    unmount() {
      if (rafId) cancelAnimationFrame(rafId);
      amp.removeEventListener('state', renderAmpCard);
      amp.removeEventListener('presets', renderAmpCard);
      amp.removeEventListener('devices', renderAmpCard);
      amp.removeEventListener('status', updateAmpStatusUI);
      stopVersions();
    }
  };
}

function renderSongHeader(record, activeSubTab) {
  const headerEl = document.getElementById('song-header-root');
  if (!headerEl) return;
  if (!record) {
    headerEl.classList.add('hidden');
    headerEl.innerHTML = '';
    return;
  }

  headerEl.classList.remove('hidden');
  headerEl.innerHTML = `
    <div class="song-header-meta">
      <a href="#/library" class="btn btn-sm btn-ghost">&larr; Library</a>
      <h2 class="song-header-title">${record.song.title}</h2>
      <span class="song-header-artist">${record.song.artist}</span>
      <span class="chip">${getTuningName(record.song.tuning)}</span>
    </div>
    <nav class="tabs" aria-label="Song Modes">
      <a href="#/song/${record.id}/play" class="tab ${activeSubTab === 'play' ? 'active' : ''}">Play</a>
      <a href="#/song/${record.id}/learn" class="tab ${activeSubTab === 'learn' ? 'active' : ''}">Learn</a>
      <a href="#/song/${record.id}/sync" class="tab ${activeSubTab === 'sync' ? 'active' : ''}">Sync</a>
    </nav>
  `;
}

async function handleRouteChange() {
  const hash = location.hash || '#/library';
  const mainEl = document.getElementById('main-view');
  if (!mainEl) return;

  if (currentViewInstance && typeof currentViewInstance.unmount === 'function') {
    currentViewInstance.unmount();
    currentViewInstance = null;
  }

  mainEl.classList.remove('play-mode-view');
  document.getElementById('modal-root')?.classList.add('hidden');

  // Update active rail link
  document.querySelectorAll('.rail-link').forEach((link) => {
    const key = link.dataset.nav;
    link.classList.toggle('active', hash.startsWith(`#/${key}`));
  });

  const songMatch = hash.match(/^#\/song\/([^/]+)\/(play|learn|sync)$/);
  if (songMatch) {
    const [, songId, subTab] = songMatch;
    const rec = await store.getSong(songId);
    if (!rec) {
      toast('Song not found in library.', 'error');
      navigate('#/library');
      return;
    }
    currentRecord = rec;
    ctx.record = rec;
    renderSongHeader(rec, subTab);

    if (subTab === 'play') {
      mainEl.classList.add('play-mode-view');
      currentViewInstance = mountGame(mainEl, ctx);
    } else if (subTab === 'learn') {
      currentViewInstance = mountLearn(mainEl, ctx);
    } else if (subTab === 'sync') {
      currentViewInstance = mountSync(mainEl, ctx);
    }
    return;
  }

  renderSongHeader(null, '');

  if (hash.startsWith('#/tuner')) {
    currentViewInstance = mountTuner(mainEl, ctx);
  } else if (hash.startsWith('#/settings')) {
    currentViewInstance = mountSettings(mainEl, ctx);
  } else if (hash.startsWith('#/import')) {
    currentViewInstance = mountImport(mainEl, ctx);
  } else if (hash.startsWith('#/setup')) {
    currentViewInstance = mountSetup(mainEl, ctx);
  } else {
    currentViewInstance = mountLibrary(mainEl, ctx);
  }
}

// Any modal in #modal-root closes with Escape, a click on the dimmed backdrop, or leaving the page.
function closeModalRoot() {
  const root = document.getElementById('modal-root');
  if (!root || root.classList.contains('hidden')) return false;
  const cancel = root.querySelector('#res-close-btn, #del-cancel-btn, [data-modal-close]');
  if (cancel) cancel.click();
  else root.classList.add('hidden');
  return true;
}

function wireModalRoot() {
  const root = document.getElementById('modal-root');
  if (!root) return;
  root.addEventListener('click', (e) => {
    if (e.target === root) closeModalRoot();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closeModalRoot()) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
}

const checkDesktopUpdate = wireDesktopUpdates(toast);

async function boot() {
  mountTitleBar();
  wireModalRoot();
  await ensureDemoSong();
  amp.connect();
  updateRailStatus();
  updateRailMeterLoop();
  window.addEventListener('hashchange', handleRouteChange);
  if (!settings.get('setupDone') && (!location.hash || location.hash === '#/library')) {
    location.hash = '#/setup';
  } else if (!location.hash) {
    location.hash = '#/library';
  } else {
    handleRouteChange();
  }
}

boot();
