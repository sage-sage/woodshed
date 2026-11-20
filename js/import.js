import { TUNINGS, DEMO_SONG_TAB, buildEvents, midiToName } from './song.js';
import { parseAsciiTab } from './tab-ascii.js';
import { loadTabFile, TAB_FILE_EXTENSIONS } from './tab-gp.js';
import { songsterrToSong, describeSongsterr, songsterrVideoAnchors } from './songsterr.js';
import { parseYouTubeId, createBackend, YOUTUBE_BLOCKED, YOUTUBE_BLOCKED_MSG } from './player.js';
import { Highway } from './highway.js';
import { isSparseTrack } from './autosync-check.js';

const NOTE_TO_PC = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11
};

const ytTitleCache = new Map();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ytSuggestKindLabel(kind) {
  if (kind === 'original') return 'Original recording';
  if (kind === 'backing') return 'Backing track';
  if (kind === 'solo') return 'Solo';
  return 'Other version';
}

function fillYtSuggestTitle(el, id) {
  if (!el) return;
  // Videos that are gone or can't be embedded fail this lookup (404/401); they wouldn't play here, so drop their card.
  const dropCard = () => { const card = el.closest('.yt-suggest-card'); if (card) card.remove(); };
  if (ytTitleCache.has(id)) {
    const cached = ytTitleCache.get(id);
    if (cached === null) dropCard(); else el.textContent = cached;
    return;
  }
  fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json`)
    .then((r) => {
      if (r.status === 401 || r.status === 403 || r.status === 404) { ytTitleCache.set(id, null); dropCard(); return null; }
      return r.ok ? r.json() : null;
    })
    .then((data) => {
      if (!data || typeof data !== 'object') return;
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      const author = typeof data.author_name === 'string' ? data.author_name.trim() : '';
      const label = title && author ? `${title} · ${author}` : (title || author);
      if (!label) return;
      ytTitleCache.set(id, label);
      if (el.isConnected) el.textContent = label;
    })
    .catch(() => {});
}

function matchTuningPreset(tuningStr) {
  if (!tuningStr || typeof tuningStr !== 'string') return 'auto';
  const tokens = tuningStr.trim().split(/\s+/).map((t) => {
    const m = t.match(/^([A-Ga-g])([#b]?)/);
    if (!m) return null;
    const key = m[1].toUpperCase() + m[2];
    return Object.prototype.hasOwnProperty.call(NOTE_TO_PC, key) ? NOTE_TO_PC[key] : null;
  });
  if (tokens.length < 4 || tokens.some((v) => v === null)) return 'auto';

  for (const [name, arr] of Object.entries(TUNINGS)) {
    if (arr.length === tokens.length && arr.every((m, i) => (((m % 12) + 12) % 12) === tokens[i])) {
      return name;
    }
  }
  return 'auto';
}

function getTuningLabel(tuning) {
  if (!Array.isArray(tuning)) return 'Standard';
  for (const [name, arr] of Object.entries(TUNINGS)) {
    if (arr.length === tuning.length && arr.every((v, i) => v === tuning[i])) {
      return name;
    }
  }
  return tuning.map((m) => midiToName(m).replace(/\d+$/, '')).join(' ');
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Songsterr tracks with almost nothing to play for their length are usually vocals or a fill-in part. */
export function sparseTrackWarning(noteCount, barCount) {
  const n = Number(noteCount) || 0;
  const bars = Number(barCount) || 0;
  if (!isSparseTrack(n, bars)) return '';
  return `This track has only ${n} notes${bars ? ` in ${bars} bars` : ''}, probably not the guitar part. ` +
    'On Songsterr, open the guitar track and send it again (or pick it in the Tab Grabber popup).';
}

export function mount(container, ctx) {
  // Everything one import holds. A new import (Tab Grabber send, library add) starts from a fresh copy so
  // nothing from the previous song (track list, suggested videos, chosen audio) carries over.
  const freshState = () => ({
    step: 1, // 1 = TAB, 2 = AUDIO, 3 = SAVE
    tabSourceMode: 'paste', // 'paste' | 'gp' | 'json'

    // Step 1a: Paste text tab state
    asciiText: '',
    title: '',
    artist: '',
    bpm: 120,
    timeSig: '4/4',
    tuningPreset: 'auto',
    capo: 0,
    asciiParsedSong: null,
    asciiError: '',

    // Step 1b: Guitar Pro / MusicXML state
    gpFileName: '',
    gpLoaded: null, // result of loadTabFile
    gpSelectedTrack: 0,
    gpTitle: '',
    gpArtist: '',
    gpError: '',

    // Step 2: Audio state
    audioKind: 'none', // 'youtube' | 'file' | 'url' | 'none'
    ytUrl: '',
    ytVideoId: null,
    ytError: '',
    ssVideos: [],
    ytPoints: null,
    ytPointsId: '',

    audioFileBlob: null,
    audioFileName: '',
    audioFileSize: 0,
    audioFileDuration: 0,
    audioFileError: '',

    audioDirectUrl: '',
    audioUrlDuration: 0,
    audioUrlValid: false,
    audioUrlStatus: ''
  });
  const state = freshState();

  function resetImportState() {
    destroyPreviewBackend();
    destroyPreviewHighway();
    if (debounceTimer) clearTimeout(debounceTimer);
    Object.assign(state, freshState());
  }

  let debounceTimer = null;
  let previewHighway = null;
  let previewBackend = null;

  function destroyPreviewBackend() {
    if (previewBackend) {
      previewBackend.destroy();
      previewBackend = null;
    }
  }

  function destroyPreviewHighway() {
    if (previewHighway) {
      previewHighway.destroy();
      previewHighway = null;
    }
  }

  function getActiveSong() {
    if (state.tabSourceMode === 'paste') {
      return state.asciiParsedSong;
    }
    if (state.tabSourceMode === 'gp' && state.gpLoaded) {
      const song = state.gpLoaded.toSong(state.gpSelectedTrack);
      if (state.gpTitle.trim()) song.title = state.gpTitle.trim();
      if (state.gpArtist.trim()) song.artist = state.gpArtist.trim();
      return song;
    }
    return null;
  }

  function runAsciiParse() {
    if (!state.asciiText.trim()) {
      state.asciiParsedSong = null;
      state.asciiError = 'Paste an ASCII tab into the box (or click "Load Example Tab") to preview it.';
      return;
    }
    const [numStr, denStr] = state.timeSig.split('/');
    const tuning = state.tuningPreset === 'auto' ? undefined : TUNINGS[state.tuningPreset];
    try {
      const song = parseAsciiTab(state.asciiText, {
        bpm: Number(state.bpm) || 120,
        num: parseInt(numStr, 10) || 4,
        den: parseInt(denStr, 10) || 4,
        tuning,
        capo: Number(state.capo) || 0,
        title: state.title.trim() || undefined,
        artist: state.artist.trim() || undefined
      });
      state.asciiParsedSong = song;
      state.asciiError = '';
    } catch (err) {
      state.asciiParsedSong = null;
      state.asciiError = err.message || 'Could not parse ASCII tab.';
    }
  }

  function render() {
    destroyPreviewHighway();
    if (state.step !== 2) {
      destroyPreviewBackend();
    }

    container.innerHTML = `
      <div class="view-container">
        <div class="page-title-row" style="margin-bottom:4px;">
          <div>
            <h1 class="page-title">Add a Song</h1>
            <p style="margin:4px 0 0;color:var(--text-muted);">Import tablature, attach a backing track or YouTube video, and start woodshedding.</p>
          </div>
          <a href="#/library" class="btn btn-ghost">&larr; Back to Library</a>
        </div>

        <div class="stepper wizard-stepper" role="navigation" aria-label="Import Steps">
          <div class="step-pill ${state.step === 1 ? 'active' : state.step > 1 ? 'done' : ''}">
            <span class="step-num">1</span>
            <span>1. Tablature</span>
          </div>
          <div class="step-connector"></div>
          <div class="step-pill ${state.step === 2 ? 'active' : state.step > 2 ? 'done' : ''}">
            <span class="step-num">2</span>
            <span>2. Backing Audio</span>
          </div>
          <div class="step-connector"></div>
          <div class="step-pill ${state.step === 3 ? 'active' : ''}">
            <span class="step-num">3</span>
            <span>3. Review &amp; Save</span>
          </div>
        </div>

        <div id="wizard-step-body"></div>
      </div>
    `;

    const bodyEl = container.querySelector('#wizard-step-body');
    if (state.step === 1) {
      renderStep1(bodyEl);
    } else if (state.step === 2) {
      renderStep2(bodyEl);
    } else {
      renderStep3(bodyEl);
    }
  }

  function renderStep1(bodyEl) {
    const tuningOptions = `<option value="auto" ${state.tuningPreset === 'auto' ? 'selected' : ''}>Auto from the tab</option>` +
      Object.keys(TUNINGS).map((name) => `<option value="${name}" ${state.tuningPreset === name ? 'selected' : ''}>${name}</option>`).join('');

    bodyEl.innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:18px;">
          <div class="tabs" role="tablist">
            <button type="button" class="tab ${state.tabSourceMode === 'paste' ? 'active' : ''}" data-tab-mode="paste">Paste Text Tab</button>
            <button type="button" class="tab ${state.tabSourceMode === 'gp' ? 'active' : ''}" data-tab-mode="gp">Guitar Pro / MusicXML</button>
            <button type="button" class="tab ${state.tabSourceMode === 'json' ? 'active' : ''}" data-tab-mode="json">Woodshed File (.json)</button>
          </div>
          ${state.tabSourceMode === 'paste' ? `<button type="button" class="btn btn-sm btn-ghost" id="btn-load-sample">Load Example Tab</button>` : ''}
        </div>

        <div id="step1-subview"></div>

        <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:22px;padding-top:16px;border-top:1px solid var(--border-subtle);">
          <span id="step1-inline-err" style="color:var(--error);font-size:0.86rem;align-self:center;margin-right:auto;"></span>
          <button type="button" class="btn btn-primary" id="step1-next-btn">Next: Choose Audio &rarr;</button>
        </div>
      </div>
    `;

    bodyEl.querySelectorAll('[data-tab-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.tabSourceMode = btn.dataset.tabMode;
        render();
      });
    });

    bodyEl.querySelector('#btn-load-sample')?.addEventListener('click', () => {
      state.asciiText = DEMO_SONG_TAB;
      state.title = 'Timberline Drive';
      state.artist = 'Woodshed House Band';
      state.bpm = 112;
      runAsciiParse();
      render();
    });

    const subEl = bodyEl.querySelector('#step1-subview');
    if (state.tabSourceMode === 'paste') {
      subEl.innerHTML = `
        <p style="margin:0 0 14px;font-size:0.86rem;color:var(--text-muted);">
          Text tabs carry no rhythm information, so notes are spaced evenly by their column position in each bar and the Sync step lines them up with your recording.
        </p>

        <div class="import-grid">
          <div>
            <textarea class="input tab-textarea" id="imp-ascii-text" placeholder="e|-----------------|&#10;B|-------------1---|&#10;G|---------2-----2-|&#10;D|-----2-----------|&#10;A|-0-----0---0-----|&#10;E|-----------------|"></textarea>
            <div id="imp-parse-status" style="margin-top:8px;font-size:0.86rem;font-weight:600;"></div>
          </div>

          <div style="display:flex;flex-direction:column;gap:10px;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div class="field" style="margin:0;">
                <label for="imp-title">Song Title</label>
                <input type="text" class="input" id="imp-title" placeholder="e.g. Midnight Riff" value="${state.title}" />
              </div>
              <div class="field" style="margin:0;">
                <label for="imp-artist">Artist</label>
                <input type="text" class="input" id="imp-artist" placeholder="Artist name" value="${state.artist}" />
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
              <div class="field" style="margin:0;">
                <label for="imp-bpm">BPM (30–300)</label>
                <input type="number" class="input" id="imp-bpm" min="30" max="300" value="${state.bpm}" />
              </div>
              <div class="field" style="margin:0;">
                <label for="imp-timesig">Time Sig</label>
                <select class="select" id="imp-timesig">
                  ${['4/4', '3/4', '6/8', '2/4', '5/4', '7/8'].map((ts) => `<option value="${ts}" ${state.timeSig === ts ? 'selected' : ''}>${ts}</option>`).join('')}
                </select>
              </div>
              <div class="field" style="margin:0;">
                <label for="imp-capo">Capo Fret</label>
                <input type="number" class="input" id="imp-capo" min="0" max="12" value="${state.capo}" />
              </div>
            </div>

            <div class="field" style="margin:0;">
              <label for="imp-tuning">Tuning</label>
              <select class="select" id="imp-tuning">${tuningOptions}</select>
            </div>

            <div>
              <span class="stat-label" style="display:block;margin-bottom:4px;">First Bars Preview</span>
              <div class="highway-preview-box">
                <canvas id="imp-preview-canvas"></canvas>
              </div>
            </div>
          </div>
        </div>
      `;

      const ta = subEl.querySelector('#imp-ascii-text');
      ta.value = state.asciiText;
      const titleInp = subEl.querySelector('#imp-title');
      if (titleInp) titleInp.value = state.title;
      const artistInp = subEl.querySelector('#imp-artist');
      if (artistInp) artistInp.value = state.artist;

      const updateAsciiPreviewUI = () => {
        const statusEl = subEl.querySelector('#imp-parse-status');
        const canvasEl = subEl.querySelector('#imp-preview-canvas');
        if (!statusEl || !canvasEl) return;

        if (state.asciiParsedSong) {
          const s = state.asciiParsedSong;
          const tName = getTuningLabel(s.tuning);
          statusEl.style.color = 'var(--success)';
          statusEl.textContent = `${s.bars.length} bars, ${s.notes.length} notes, tuning ${tName}, ${formatDuration(s.duration)}`;

          if (!previewHighway) {
            previewHighway = new Highway(canvasEl);
          }
          const evs = buildEvents(s);
          previewHighway.setSong(s, evs);
          previewHighway.setView({ pxPerSec: 170 });
          previewHighway.render({ tabNow: 0, states: new Uint8Array(evs.length) });
        } else {
          statusEl.style.color = state.asciiText.trim() ? 'var(--error)' : 'var(--text-muted)';
          statusEl.textContent = state.asciiError || 'Paste tab lines to see live preview.';
          if (previewHighway) {
            previewHighway.setSong(null, []);
            previewHighway.render({});
          }
        }
      };

      runAsciiParse();
      updateAsciiPreviewUI();

      const triggerDebouncedParse = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          runAsciiParse();
          updateAsciiPreviewUI();
        }, 300);
      };

      ta.addEventListener('input', () => {
        state.asciiText = ta.value;
        triggerDebouncedParse();
      });

      subEl.querySelector('#imp-title')?.addEventListener('input', (e) => {
        state.title = e.target.value;
        triggerDebouncedParse();
      });
      subEl.querySelector('#imp-artist')?.addEventListener('input', (e) => {
        state.artist = e.target.value;
        triggerDebouncedParse();
      });
      subEl.querySelector('#imp-bpm')?.addEventListener('input', (e) => {
        state.bpm = Math.max(30, Math.min(300, Number(e.target.value) || 120));
        triggerDebouncedParse();
      });
      subEl.querySelector('#imp-timesig')?.addEventListener('change', (e) => {
        state.timeSig = e.target.value;
        triggerDebouncedParse();
      });
      subEl.querySelector('#imp-capo')?.addEventListener('input', (e) => {
        state.capo = Math.max(0, Math.min(12, parseInt(e.target.value, 10) || 0));
        triggerDebouncedParse();
      });
      subEl.querySelector('#imp-tuning')?.addEventListener('change', (e) => {
        state.tuningPreset = e.target.value;
        triggerDebouncedParse();
      });
    } else if (state.tabSourceMode === 'gp') {
      const acceptExts = (TAB_FILE_EXTENSIONS || ['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.musicxml', '.xml', '.mxl']).join(',');
      subEl.innerHTML = `
        <p style="margin:0 0 14px;font-size:0.86rem;color:var(--text-muted);">
          Guitar Pro and MusicXML files include exact rhythm, note durations, and multi-track arrangements.
        </p>

        <div class="dropzone" id="gp-dropzone">
          <strong style="font-size:1.05rem;color:var(--text);">Drop a Guitar Pro or MusicXML file here, or click to browse</strong>
          <p style="margin:6px 0 0;font-size:0.82rem;color:var(--text-muted);">Supports ${acceptExts}</p>
          <input type="file" id="gp-file-input" accept="${acceptExts}" class="hidden" />
        </div>

        ${state.gpError ? `<p style="color:var(--error);margin-top:12px;">${state.gpError}</p>` : ''}

        ${state.gpLoaded ? `
          <div style="margin-top:18px;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
              <div class="field" style="margin:0;">
                <label>Title</label>
                <input type="text" class="input" id="gp-title-input" value="${state.gpTitle}" />
              </div>
              <div class="field" style="margin:0;">
                <label>Artist</label>
                <input type="text" class="input" id="gp-artist-input" value="${state.gpArtist}" />
              </div>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
              <span class="stat-label">Select Instrument Track (${escapeHtml(state.gpFileName)})</span>
              <button type="button" class="btn btn-sm btn-ghost" id="gp-clear-btn" title="Remove this tab and start over" aria-label="Remove this tab">&times; Remove</button>
            </div>
            ${state.gpLoaded.songsterr && sparseTrackWarning(state.gpLoaded.tracks[0]?.noteCount, state.gpLoaded.bars)
              ? `<div class="notice-box" role="alert" style="margin:8px 0;">${escapeHtml(sparseTrackWarning(state.gpLoaded.tracks[0]?.noteCount, state.gpLoaded.bars))}</div>`
              : ''}
            <div class="track-list">
              ${state.gpLoaded.tracks.map((tr) => {
                const disabled = Boolean(tr.isPercussion);
                const selected = !disabled && state.gpSelectedTrack === tr.index;
                const tName = getTuningLabel(tr.tuning);
                return `
                  <div class="track-item ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}" data-track-idx="${tr.index}" data-disabled="${disabled}">
                    <div>
                      <strong>${escapeHtml(tr.name || `Track ${tr.index + 1}`)}</strong>
                      <div style="font-size:0.8rem;color:var(--text-muted);">
                        ${disabled ? 'Percussion / Drum Track (Not Playable)' : `${tr.strings || tr.tuning?.length || 6} strings · ${tName}`}
                      </div>
                    </div>
                    <span class="chip ${selected ? 'chip-accent' : ''}">${tr.noteCount} notes</span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        ` : ''}
      `;

      const dz = subEl.querySelector('#gp-dropzone');
      const fileInp = subEl.querySelector('#gp-file-input');

      const handleGpFile = async (file) => {
        if (!file) return;
        state.gpError = '';
        state.gpFileName = file.name;
        try {
          const buf = await file.arrayBuffer();
          const loaded = await loadTabFile(buf);
          // A new file is a new song: drop the previous one's suggested videos and their timings.
          state.ssVideos = [];
          if (state.ytPointsId) {
            state.ytPoints = null;
            state.ytPointsId = '';
          }
          state.gpLoaded = loaded;
          state.gpTitle = loaded.title || file.name.replace(/\.[^.]+$/, '');
          state.gpArtist = loaded.artist || 'Unknown Artist';
          const firstPlayable = loaded.tracks.find((t) => !t.isPercussion);
          state.gpSelectedTrack = firstPlayable ? firstPlayable.index : 0;
          render();
        } catch (err) {
          state.gpLoaded = null;
          state.gpError = err.message || 'Could not load Guitar Pro / MusicXML file.';
          render();
        }
      };

      dz?.addEventListener('click', () => fileInp?.click());
      dz?.addEventListener('dragover', (e) => {
        e.preventDefault();
        dz.classList.add('dragover');
      });
      dz?.addEventListener('dragleave', () => dz.classList.remove('dragover'));
      dz?.addEventListener('drop', (e) => {
        e.preventDefault();
        dz.classList.remove('dragover');
        handleGpFile(e.dataTransfer?.files?.[0]);
      });
      fileInp?.addEventListener('change', (e) => handleGpFile(e.target.files?.[0]));

      subEl.querySelector('#gp-title-input')?.addEventListener('input', (e) => {
        state.gpTitle = e.target.value;
      });
      subEl.querySelector('#gp-artist-input')?.addEventListener('input', (e) => {
        state.gpArtist = e.target.value;
      });

      subEl.querySelector('#gp-clear-btn')?.addEventListener('click', () => {
        resetImportState();
        state.tabSourceMode = 'gp';
        render();
      });

      subEl.querySelectorAll('.track-item').forEach((item) => {
        item.addEventListener('click', () => {
          if (item.dataset.disabled === 'true') return;
          state.gpSelectedTrack = parseInt(item.dataset.trackIdx, 10);
          render();
        });
      });
    } else {
      subEl.innerHTML = `
        <div class="dropzone" id="json-dropzone">
          <strong style="font-size:1.05rem;color:var(--text);">Drop a Woodshed (.json) song export here, or click to choose</strong>
          <p style="margin:6px 0 0;font-size:0.82rem;color:var(--text-muted);">Restores a complete song record and its sync anchors directly to your Library.</p>
          <input type="file" id="json-file-input" accept=".json" class="hidden" />
        </div>
      `;

      const dz = subEl.querySelector('#json-dropzone');
      const inp = subEl.querySelector('#json-file-input');
      const handleJson = async (file) => {
        if (!file) return;
        try {
          const rec = await ctx.store.importSongFile(file);
          ctx.toast(`Imported "${rec.song.title}" into your Library.`, 'success');
          ctx.navigate('#/library');
        } catch (err) {
          ctx.toast(err.message || 'Failed to import Woodshed JSON file.', 'error');
        }
      };
      dz?.addEventListener('click', () => inp?.click());
      dz?.addEventListener('dragover', (e) => {
        e.preventDefault();
        dz.classList.add('dragover');
      });
      dz?.addEventListener('dragleave', () => dz.classList.remove('dragover'));
      dz?.addEventListener('drop', (e) => {
        e.preventDefault();
        dz.classList.remove('dragover');
        handleJson(e.dataTransfer?.files?.[0]);
      });
      inp?.addEventListener('change', (e) => handleJson(e.target.files?.[0]));
    }

    bodyEl.querySelector('#step1-next-btn')?.addEventListener('click', () => {
      if (state.tabSourceMode === 'paste') {
        runAsciiParse();
      }
      const song = getActiveSong();
      const errEl = bodyEl.querySelector('#step1-inline-err');
      if (!song || !song.notes || song.notes.length === 0) {
        if (errEl) {
          errEl.textContent = state.asciiError || state.gpError || 'Please provide a valid tab with playable notes before continuing.';
        }
        return;
      }
      state.step = 2;
      render();
    });
  }

  function renderStep2(bodyEl) {
    // Suggestions belong to the Songsterr tab they came with: hide them once another tab is the active one.
    const suggestionsForActiveTab = state.tabSourceMode === 'gp' && state.gpLoaded?.songsterr;
    const suggestHtml = state.ssVideos.length > 0 && suggestionsForActiveTab && !YOUTUBE_BLOCKED
      ? `<div class="yt-suggest">
          <div class="yt-suggest-head" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
            <span>Videos for this tab${state.gpLoaded.title ? `: ${escapeHtml(state.gpLoaded.title)}` : ''}</span>
            <button type="button" class="btn btn-sm btn-ghost" id="yt-suggest-close" title="Hide these suggestions" aria-label="Hide suggested videos">&times; Hide</button>
          </div>
          <div class="yt-suggest-grid">${state.ssVideos.map((v) => {
            const selected = state.ytPointsId === v.videoId && state.audioKind === 'youtube' ? ' is-selected' : '';
            return `<button type="button" class="yt-suggest-card${selected}" data-yt-suggest="${v.videoId}">
              <img src="https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg" alt="" loading="lazy" />
              <span class="yt-suggest-kind">${ytSuggestKindLabel(v.kind)}</span>
              <span class="yt-suggest-title" data-yt-title="${v.videoId}"></span>
            </button>`;
          }).join('')}</div>
        </div>`
      : '';

    bodyEl.innerHTML = `
      <div class="card">
        <h2 class="serif-heading">Choose Backing Audio</h2>
        <p style="margin:0 0 16px;color:var(--text-muted);font-size:0.88rem;">
          Play along with an official YouTube video, a local backing track on your computer, a direct audio link, or practice solo with the built-in guitar synth.
        </p>
        ${suggestHtml}

        <div class="audio-choice-grid">
          <button type="button" class="audio-choice-card ${state.audioKind === 'none' ? 'selected' : ''}" data-audio-kind="none">
            <strong>No Recording (Built-in Synth &amp; Metronome)</strong>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">Play along to the synthesized guitar guide and click track.</div>
          </button>

          <button type="button" class="audio-choice-card ${state.audioKind === 'youtube' ? 'selected' : ''}" data-audio-kind="youtube">
            <strong>YouTube Video Link</strong>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">${YOUTUBE_BLOCKED ? 'Only in the Windows download: the hosted copy can’t play YouTube.' : 'Streams inside the page via YouTube’s official player. Nothing is downloaded.'}</div>
          </button>

          <button type="button" class="audio-choice-card ${state.audioKind === 'file' ? 'selected' : ''}" data-audio-kind="file">
            <strong>Audio File from This Computer</strong>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">MP3, WAV, OGG, or M4A saved privately in your browser's IndexedDB.</div>
          </button>

          <button type="button" class="audio-choice-card ${state.audioKind === 'url' ? 'selected' : ''}" data-audio-kind="url">
            <strong>Direct Audio URL</strong>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">Link directly to a hosted .mp3, .ogg, .wav, or .m4a file.</div>
          </button>
        </div>

        <div id="step2-detail-box"></div>

        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:22px;padding-top:16px;border-top:1px solid var(--border-subtle);">
          <button type="button" class="btn" id="step2-back-btn">&larr; Back to Tab</button>
          <span id="step2-inline-err" style="color:var(--error);font-size:0.86rem;"></span>
          <button type="button" class="btn btn-primary" id="step2-next-btn">Next: Review &amp; Save &rarr;</button>
        </div>
      </div>
    `;

    bodyEl.querySelector('#yt-suggest-close')?.addEventListener('click', () => {
      state.ssVideos = [];
      render();
    });

    bodyEl.querySelectorAll('[data-yt-suggest]').forEach((btn) => {
      const id = btn.dataset.ytSuggest;
      const video = state.ssVideos.find((v) => v.videoId === id);
      btn.addEventListener('click', () => {
        if (!video) return;
        destroyPreviewBackend();
        state.audioKind = 'youtube';
        state.ytUrl = `https://www.youtube.com/watch?v=${id}`;
        state.ytVideoId = id;
        state.ytPoints = video.points;
        state.ytPointsId = id;
        render();
      });
      fillYtSuggestTitle(btn.querySelector('[data-yt-title]'), id);
    });

    bodyEl.querySelectorAll('[data-audio-kind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        destroyPreviewBackend();
        state.audioKind = btn.dataset.audioKind;
        render();
      });
    });

    const detailEl = bodyEl.querySelector('#step2-detail-box');

    if (state.audioKind === 'youtube' && YOUTUBE_BLOCKED) {
      detailEl.innerHTML = `<div class="notice-box" role="note">${YOUTUBE_BLOCKED_MSG}</div>`;
    } else if (state.audioKind === 'youtube') {
      detailEl.innerHTML = `
        <div class="field">
          <label for="imp-yt-url">YouTube URL or 11-Character Video ID</label>
          <input type="text" class="input" id="imp-yt-url" placeholder="https://www.youtube.com/watch?v=..." value="${state.ytUrl}" />
          <span style="font-size:0.78rem;color:var(--text-muted);">
            The video plays directly from YouTube inside the page and nothing is downloaded.
          </span>
        </div>
        <div id="imp-yt-status" style="font-size:0.85rem;font-weight:600;"></div>
        <div id="imp-yt-preview" class="yt-preview-frame ${state.ytVideoId ? '' : 'hidden'}"></div>
      `;

      const ytInput = detailEl.querySelector('#imp-yt-url');
      const ytStatus = detailEl.querySelector('#imp-yt-status');
      const ytPreview = detailEl.querySelector('#imp-yt-preview');

      const loadYtPreview = async (urlVal) => {
        state.ytUrl = urlVal;
        const id = parseYouTubeId(urlVal);
        state.ytVideoId = id;
        if (id !== state.ytPointsId) {
          state.ytPoints = null;
          state.ytPointsId = '';
        }
        destroyPreviewBackend();

        if (!urlVal.trim()) {
          ytStatus.textContent = '';
          ytPreview.classList.add('hidden');
          return;
        }
        if (!id) {
          ytStatus.style.color = 'var(--error)';
          ytStatus.textContent = 'Invalid YouTube link or video ID.';
          ytPreview.classList.add('hidden');
          return;
        }

        ytStatus.style.color = 'var(--success)';
        ytStatus.textContent = `Detected Video ID: ${id} — loading preview...`;
        ytPreview.classList.remove('hidden');

        try {
          previewBackend = createBackend({ kind: 'youtube', videoId: id, url: urlVal }, { container: ytPreview });
          await previewBackend.load();
          ytStatus.textContent = `Video ready (${formatDuration(previewBackend.duration)})`;
        } catch (err) {
          ytStatus.style.color = 'var(--error)';
          ytStatus.textContent = err.message || 'YouTube preview failed to load.';
        }
      };

      if (state.ytUrl) {
        loadYtPreview(state.ytUrl);
      }

      ytInput?.addEventListener('input', (e) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => loadYtPreview(e.target.value), 350);
      });
    } else if (state.audioKind === 'file') {
      detailEl.innerHTML = `
        <div class="dropzone" id="audio-file-dropzone">
          <strong style="font-size:1rem;color:var(--text);">Drop an audio file here (.mp3, .wav, .ogg, .m4a), or click to choose</strong>
          <input type="file" id="audio-file-input" accept="audio/*" class="hidden" />
        </div>
        <div id="audio-file-info" style="margin-top:10px;font-size:0.88rem;">
          ${state.audioFileBlob
            ? `<span style="color:var(--success);">✓ Loaded <strong>${state.audioFileName}</strong> (${formatBytes(state.audioFileSize)} · ${formatDuration(state.audioFileDuration)})</span>`
            : state.audioFileError
              ? `<span style="color:var(--error);">${state.audioFileError}</span>`
              : ''}
        </div>
      `;

      const dz = detailEl.querySelector('#audio-file-dropzone');
      const inp = detailEl.querySelector('#audio-file-input');

      const handleAudioFile = async (file) => {
        if (!file) return;
        destroyPreviewBackend();
        state.audioFileError = '';
        try {
          previewBackend = createBackend({ kind: 'file' }, { blob: file });
          await previewBackend.load();
          state.audioFileBlob = file;
          state.audioFileName = file.name;
          state.audioFileSize = file.size;
          state.audioFileDuration = previewBackend.duration;
          destroyPreviewBackend();
          render();
        } catch (err) {
          state.audioFileBlob = null;
          state.audioFileError = err.message || 'Could not decode that audio file.';
          destroyPreviewBackend();
          render();
        }
      };

      dz?.addEventListener('click', () => inp?.click());
      dz?.addEventListener('dragover', (e) => {
        e.preventDefault();
        dz.classList.add('dragover');
      });
      dz?.addEventListener('dragleave', () => dz.classList.remove('dragover'));
      dz?.addEventListener('drop', (e) => {
        e.preventDefault();
        dz.classList.remove('dragover');
        handleAudioFile(e.dataTransfer?.files?.[0]);
      });
      inp?.addEventListener('change', (e) => handleAudioFile(e.target.files?.[0]));
    } else if (state.audioKind === 'url') {
      detailEl.innerHTML = `
        <div class="field">
          <label for="imp-audio-url">Direct Link to Audio File (.mp3 / .ogg / .wav / .m4a)</label>
          <div style="display:flex;gap:10px;">
            <input type="url" class="input" id="imp-audio-url" style="flex:1;" placeholder="https://example.com/backing.mp3" value="${state.audioDirectUrl}" />
            <button type="button" class="btn" id="btn-test-audio-url">Test Link</button>
          </div>
        </div>
        <div id="audio-url-status" style="font-size:0.86rem;color:${state.audioUrlValid ? 'var(--success)' : 'var(--text-muted)'};">
          ${state.audioUrlStatus}
        </div>
      `;

      const urlInp = detailEl.querySelector('#imp-audio-url');
      const statusEl = detailEl.querySelector('#audio-url-status');

      const testUrl = async () => {
        const url = urlInp.value.trim();
        state.audioDirectUrl = url;
        state.audioUrlValid = false;
        if (!url) {
          statusEl.style.color = 'var(--error)';
          statusEl.textContent = 'Enter a direct audio URL first.';
          return;
        }
        statusEl.style.color = 'var(--text-muted)';
        statusEl.textContent = 'Testing audio stream...';
        destroyPreviewBackend();
        try {
          previewBackend = createBackend({ kind: 'url', url });
          await previewBackend.load();
          state.audioUrlDuration = previewBackend.duration;
          state.audioUrlValid = true;
          state.audioUrlStatus = `✓ Audio stream verified (${formatDuration(state.audioUrlDuration)})`;
          statusEl.style.color = 'var(--success)';
          statusEl.textContent = state.audioUrlStatus;
          destroyPreviewBackend();
        } catch (err) {
          state.audioUrlValid = false;
          state.audioUrlStatus = err.message || 'Could not load audio from that URL.';
          statusEl.style.color = 'var(--error)';
          statusEl.textContent = state.audioUrlStatus;
          destroyPreviewBackend();
        }
      };

      urlInp?.addEventListener('input', (e) => {
        state.audioDirectUrl = e.target.value.trim();
        state.audioUrlValid = false;
      });
      detailEl.querySelector('#btn-test-audio-url')?.addEventListener('click', testUrl);
    } else {
      detailEl.innerHTML = `
        <div class="card card-raised" style="padding:14px 18px;">
          <strong>Synthesized Guide Guitar + Metronome</strong>
          <p style="margin:4px 0 0;font-size:0.86rem;color:var(--text-muted);">
            Woodshed will play the tab through its Karplus-Strong guitar synth and click the bars so you can start practicing right away without needing an external recording.
          </p>
        </div>
      `;
    }

    bodyEl.querySelector('#step2-back-btn')?.addEventListener('click', () => {
      destroyPreviewBackend();
      state.step = 1;
      render();
    });

    bodyEl.querySelector('#step2-next-btn')?.addEventListener('click', async () => {
      const errEl = bodyEl.querySelector('#step2-inline-err');
      if (state.audioKind === 'youtube' && !state.ytVideoId) {
        errEl.textContent = 'Please enter a valid YouTube link or choose "No Recording".';
        return;
      }
      if (state.audioKind === 'file' && !state.audioFileBlob) {
        errEl.textContent = 'Please select an audio file from your computer or choose "No Recording".';
        return;
      }
      if (state.audioKind === 'url' && !state.audioUrlValid) {
        errEl.textContent = 'Please click "Test Link" to verify the audio URL loads before continuing.';
        return;
      }
      destroyPreviewBackend();
      state.step = 3;
      render();
    });
  }

  function renderStep3(bodyEl) {
    const song = getActiveSong();
    if (!song) {
      state.step = 1;
      render();
      return;
    }

    let audioSummary = 'No recording — Built-in guitar synth & metronome';
    if (state.audioKind === 'youtube') {
      audioSummary = `YouTube Video (${state.ytVideoId})`;
      if (state.ytPoints && state.ytPointsId === state.ytVideoId) {
        audioSummary += ' · lined up with the tab';
      }
    } else if (state.audioKind === 'file') {
      audioSummary = `Local Audio File: ${state.audioFileName} (${formatBytes(state.audioFileSize)})`;
    } else if (state.audioKind === 'url') {
      audioSummary = `Direct Audio URL: ${state.audioDirectUrl}`;
    }

    const hasRecording = state.audioKind !== 'none';

    bodyEl.innerHTML = `
      <div class="card">
        <h2 class="serif-heading">Review &amp; Save Song</h2>
        <div class="card card-raised" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:20px;">
          <div class="stat">
            <span class="stat-label">Title &amp; Artist</span>
            <span class="stat-value" style="font-size:1.15rem;">${song.title}</span>
            <span style="font-size:0.85rem;color:var(--text-muted);">${song.artist}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Tab Structure</span>
            <span class="stat-value" style="font-size:1.15rem;">${song.bars.length} Bars · ${song.notes.length} Notes</span>
            <span style="font-size:0.85rem;color:var(--text-muted);">${song.exactRhythm ? 'Exact Rhythm (Guitar Pro/XML)' : 'Proportional ASCII Timing'}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Tuning &amp; Tempo</span>
            <span class="stat-value" style="font-size:1.15rem;">${getTuningLabel(song.tuning)}</span>
            <span style="font-size:0.85rem;color:var(--text-muted);">${Math.round(song.bpm)} BPM · Capo ${song.capo || 0}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Backing Audio</span>
            <span class="stat-value" style="font-size:1.05rem;">${state.audioKind.toUpperCase()}</span>
            <span style="font-size:0.82rem;color:var(--text-muted);">${audioSummary}</span>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;">
          <button type="button" class="btn" id="step3-back-btn">&larr; Back to Audio</button>
          <button type="button" class="btn btn-primary btn-lg" id="step3-save-btn">
            ${hasRecording ? 'Save &amp; Sync to Recording &rarr;' : 'Save &amp; Start Playing &rarr;'}
          </button>
        </div>
      </div>
    `;

    bodyEl.querySelector('#step3-back-btn')?.addEventListener('click', () => {
      state.step = 2;
      render();
    });

    bodyEl.querySelector('#step3-save-btn')?.addEventListener('click', async () => {
      const now = Date.now();
      const id = `song-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      song.id = id;

      let audioDesc = { kind: 'none' };
      if (state.audioKind === 'youtube') {
        audioDesc = { kind: 'youtube', videoId: state.ytVideoId, url: state.ytUrl };
      } else if (state.audioKind === 'file') {
        audioDesc = { kind: 'file', name: state.audioFileName };
      } else if (state.audioKind === 'url') {
        audioDesc = { kind: 'url', url: state.audioDirectUrl };
      }

      const presetAnchors = (state.audioKind === 'youtube' && state.ytPoints && state.ytPointsId === state.ytVideoId &&
          state.tabSourceMode === 'gp' && state.gpLoaded?.songsterr)
        ? songsterrVideoAnchors(song, state.ytPoints)
        : [];

      const [numStr, denStr] = state.timeSig.split('/');
      const record = {
        id,
        song,
        sync: { anchors: presetAnchors },
        audio: audioDesc,
        importText: state.tabSourceMode === 'paste' ? state.asciiText : undefined,
        importOpts: state.tabSourceMode === 'paste'
          ? {
              bpm: Number(state.bpm) || 120,
              num: parseInt(numStr, 10) || 4,
              den: parseInt(denStr, 10) || 4,
              capo: Number(state.capo) || 0,
              title: song.title,
              artist: song.artist
            }
          : undefined,
        best: null,
        history: [],
        level: 3,
        speed: 1,
        createdAt: now,
        updatedAt: now
      };

      await ctx.saveRecord(record);
      if (state.audioKind === 'file' && state.audioFileBlob) {
        await ctx.store.saveAudioBlob(id, state.audioFileBlob);
      }

      ctx.toast(`Saved "${song.title}"`, 'success');
      if (presetAnchors.length > 0) {
        ctx.navigate(`#/song/${id}/play`);
      } else if (hasRecording) {
        ctx.navigate(`#/song/${id}/sync`);
      } else {
        ctx.navigate(`#/song/${id}/play`);
      }
    });
  }

  function applyPendingTabImport() {
    const payload = typeof ctx.takePendingTabImport === 'function' ? ctx.takePendingTabImport() : null;
    if (!payload) return false;

    resetImportState();

    if (payload.notation && typeof payload.notation === 'object') {
      const n = payload.notation;
      const title = payload.title || n.name || '';
      const artist = payload.artist || '';
      try {
        const described = describeSongsterr(n);
        songsterrToSong(n, { title, artist });
        state.tabSourceMode = 'gp';
        state.gpLoaded = {
          songsterr: true,
          title,
          artist,
          bars: Array.isArray(n.measures) ? n.measures.length : 0,
          tracks: described.tracks,
          toSong: () => songsterrToSong(n, { title, artist })
        };
        state.gpSelectedTrack = 0;
        state.gpTitle = title;
        state.gpArtist = artist;
        state.gpFileName = `Songsterr: ${n.name || 'track'}`;
        state.gpError = '';
        state.ssVideos = Array.isArray(n.videos) ? n.videos.filter((v) => v && typeof v.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v.videoId) && Array.isArray(v.points)) : [];
        const sparse = sparseTrackWarning(described.tracks[0]?.noteCount, state.gpLoaded.bars);
        if (sparse) ctx.toast(sparse, 'error');
        else ctx.toast('Tab from Songsterr loaded with exact rhythm — check it and press Next', 'success');
        return true;
      } catch (err) {
        const msg = err && err.message ? err.message : 'Could not read Songsterr rhythm data.';
        ctx.toast(msg, 'error');
        if (!payload.text || !payload.text.trim()) {
          state.tabSourceMode = 'gp';
          state.gpError = msg;
          return true;
        }
      }
    }

    state.tabSourceMode = 'paste';
    state.asciiText = payload.text || '';
    state.title = payload.title || '';
    state.artist = payload.artist || '';
    if (typeof payload.bpm === 'number' && Number.isFinite(payload.bpm) && payload.bpm > 0) {
      state.bpm = Math.max(30, Math.min(300, Math.round(payload.bpm)));
    }
    if (typeof payload.capo === 'number' && Number.isFinite(payload.capo) && payload.capo >= 0) {
      state.capo = Math.max(0, Math.min(12, Math.round(payload.capo)));
    }
    state.tuningPreset = matchTuningPreset(payload.tuning);
    runAsciiParse();
    if (!payload.notation) {
      ctx.toast(`Tab from ${payload.source || 'browser'} loaded — check it and press Next`, 'success');
    }
    return true;
  }

  const onTabImport = () => {
    if (applyPendingTabImport()) {
      render();
    }
  };
  window.addEventListener('woodshed:tab-import', onTabImport);

  applyPendingTabImport();
  render();

  return {
    unmount() {
      window.removeEventListener('woodshed:tab-import', onTabImport);
      if (debounceTimer) clearTimeout(debounceTimer);
      destroyPreviewHighway();
      destroyPreviewBackend();
    }
  };
}
