import { tabToAudio, audioToTab, addAnchor, removeAnchor, shiftAll, fromOffsetAndScale } from './sync.js';
import { HOP, SR } from './align.js';
import { createBackend, parseYouTubeId } from './player.js';
import { GuideScheduler, resolveGuideTone } from './synth.js';
import { suggestTone, baseToneId } from './tone-suggest.js';
import { getAudioContext, resumeAudio } from './audio-context.js';

function formatTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const mins = Math.floor(s / 60);
  const rem = (s % 60).toFixed(2).padStart(5, '0');
  return `${mins}:${rem}`;
}

function formatShortTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const mins = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  return `${mins}:${rem}`;
}

export function mount(container, ctx) {
  if (!ctx.record) {
    ctx.navigate('#/library');
    return { unmount() {} };
  }

  const record = ctx.record;
  const song = record.song;
  if (!record.sync || !Array.isArray(record.sync.anchors)) {
    record.sync = { anchors: [] };
  }
  const sync = record.sync;

  let transport = null;
  let scheduler = null;
  let rafId = null;
  let saveTimer = null;
  let unmounted = false;

  // Waveform peaks & decoded buffer cache for file/url audio
  let waveformPeaks = null; // Float32Array of [min, max, min, max...]
  let waveformDuration = 0;
  let decodedAudioBuffer = null;
  let waveformDecodePromise = null;
  let alignWorker = null;
  let isAutoSyncing = false;
  let lastMatchedStartAudio = null;
  let autoSyncStatusText = '';

  // Timeline viewport state (in audio seconds)
  let viewStartSec = 0;
  let pxPerSec = 95;
  let draggingAnchorTab = null;
  let draggingPanStartX = null;
  let draggingPanStartSec = 0;

  // Tap tool state
  const firstBarWithNotes = Math.max(
    0,
    song.bars.findIndex((b) => song.notes.some((n) => n.t >= b.t - 0.01 && n.t < b.t + b.dur))
  );
  let tapBarIndex = firstBarWithNotes;
  const tapHistoryStack = []; // stack of tab times added by tapping

  // Check-it mode state
  let checkItEnabled = false;
  let balance = 0.5; // 0 = recording only, 0.5 = both, 1 = guide only

  function scheduleAutosave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!unmounted) {
        ctx.saveRecord(record);
      }
    }, 320);
  }

  function applyVolumes() {
    const baseBack = ctx.settings.get('backingVolume') ?? 0.85;
    const baseGuide = ctx.settings.get('guideVolume') ?? 0.7;
    if (!checkItEnabled) {
      transport?.setVolume(baseBack);
      ctx.synth.setVolume(0);
    } else {
      const recScale = balance <= 0.5 ? 1 : (1 - (balance - 0.5) * 2);
      const guideScale = balance >= 0.5 ? 1 : (balance * 2);
      transport?.setVolume(baseBack * recScale);
      ctx.synth.setVolume(baseGuide * guideScale);
    }
  }

  async function tryDecodeWaveform(blobOrUrl) {
    try {
      let arrayBuf = null;
      if (blobOrUrl instanceof Blob) {
        arrayBuf = await blobOrUrl.arrayBuffer();
      } else if (typeof blobOrUrl === 'string' && blobOrUrl) {
        const resp = await fetch(blobOrUrl);
        if (!resp.ok) return;
        arrayBuf = await resp.arrayBuffer();
      }
      if (!arrayBuf || unmounted) return;
      const audioCtx = getAudioContext();
      const decoded = await audioCtx.decodeAudioData(arrayBuf.slice(0));
      if (unmounted) return;

      const chan = decoded.getChannelData(0);
      const bucketCount = 1600;
      const samplesPerBucket = Math.max(1, Math.floor(chan.length / bucketCount));
      const peaks = new Float32Array(bucketCount * 2);

      for (let b = 0; b < bucketCount; b++) {
        const start = b * samplesPerBucket;
        const end = Math.min(chan.length, start + samplesPerBucket);
        let min = 1;
        let max = -1;
        for (let i = start; i < end; i++) {
          const v = chan[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        peaks[b * 2] = min;
        peaks[b * 2 + 1] = max;
      }
      waveformPeaks = peaks;
      waveformDuration = decoded.duration;
      decodedAudioBuffer = decoded;
    } catch (_) {
      // Quietly skip waveform if decode or CORS fails
    } finally {
      updateAutoSyncUI();
    }
  }

  function updateAutoSyncUI() {
    const autoBtn = container.querySelector('#sync-auto-btn');
    const nextBtn = container.querySelector('#sync-next-match-btn');
    const statusEl = container.querySelector('#sync-auto-status');
    if (!autoBtn || !nextBtn || !statusEl) return;

    const isYouTube = record.audio?.kind === 'youtube';
    const decodeFinished = !waveformDecodePromise;
    const unavailable = isYouTube || (decodeFinished && !decodedAudioBuffer);

    if (unavailable) {
      autoBtn.disabled = true;
      nextBtn.disabled = true;
      autoBtn.textContent = 'Auto-sync';
      statusEl.textContent = "Auto-sync needs the song as an audio file (MP3, WAV\u2026). YouTube audio can't be analysed in the browser.";
      return;
    }

    if (isAutoSyncing) {
      autoBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }

    autoBtn.disabled = !decodedAudioBuffer;
    autoBtn.textContent = 'Auto-sync';
    nextBtn.disabled = !decodedAudioBuffer || lastMatchedStartAudio === null;
    statusEl.textContent = autoSyncStatusText;
  }

  async function extractMonoSamples(audioBuffer) {
    const targetLen = Math.max(1, Math.ceil(audioBuffer.duration * SR));
    const offline = new OfflineAudioContext(1, targetLen, SR);
    const src = offline.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  }

  let preAutoSyncAnchors = null;

  function undoAutoSync() {
    if (!preAutoSyncAnchors) return;
    sync.anchors = preAutoSyncAnchors.map((a) => ({ ...a }));
    preAutoSyncAnchors = null;
    autoSyncStatusText = 'Auto-sync undone: your previous sync is back.';
    container.querySelector('#sync-undo-auto-btn')?.classList.add('hidden');
    const statusEl = container.querySelector('#sync-auto-status');
    if (statusEl) statusEl.textContent = autoSyncStatusText;
    scheduler?.reset();
    renderAnchorList();
    scheduleAutosave();
  }

  async function runAutoSync(startSec = 0) {
    if (isAutoSyncing) return;
    if (waveformDecodePromise) {
      await waveformDecodePromise;
    }
    if (!decodedAudioBuffer) {
      updateAutoSyncUI();
      return;
    }

    await resumeAudio();
    isAutoSyncing = true;
    const autoBtn = container.querySelector('#sync-auto-btn');
    const nextBtn = container.querySelector('#sync-next-match-btn');
    if (autoBtn) {
      autoBtn.disabled = true;
      autoBtn.textContent = 'Listening\u2026 0%';
    }
    if (nextBtn) nextBtn.disabled = true;

    try {
      const samples = await extractMonoSamples(decodedAudioBuffer);
      if (unmounted) return;

      if (alignWorker) {
        alignWorker.terminate();
        alignWorker = null;
      }

      const worker = new Worker(new URL('./align-worker.js', import.meta.url), { type: 'module' });
      alignWorker = worker;

      const result = await new Promise((resolve, reject) => {
        worker.onmessage = (ev) => {
          const data = ev.data || {};
          if (typeof data.progress === 'number') {
            const pct = Math.min(100, Math.max(0, Math.round(data.progress * 100)));
            if (autoBtn) autoBtn.textContent = `Listening\u2026 ${pct}%`;
          } else if (data.ok) {
            resolve(data.result);
          } else if (data.ok === false) {
            reject(new Error(data.error || 'Auto-sync failed.'));
          }
        };
        worker.onerror = (err) => {
          reject(new Error(err?.message || 'Auto-sync worker error.'));
        };
        worker.postMessage({ song, samples, startSec }, [samples.buffer]);
      });

      worker.terminate();
      if (alignWorker === worker) alignWorker = null;
      if (unmounted) return;

      // Auto-sync is a suggestion: keep what was there so "Undo auto-sync" can put it back.
      if (!preAutoSyncAnchors) preAutoSyncAnchors = sync.anchors.map((a) => ({ ...a }));
      const undoBtn = container.querySelector('#sync-undo-auto-btn');
      if (undoBtn) undoBtn.classList.remove('hidden');
      sync.anchors = result.anchors;
      tapHistoryStack.length = 0;
      lastMatchedStartAudio = result.startAudio;

      const qualityLabel = result.quality === 'good'
        ? 'Good match'
        : result.quality === 'check'
          ? 'Not sure: press Play and listen, then keep it or Undo'
          : 'Weak match: probably wrong. Undo, or try Find next match';
      autoSyncStatusText = `Matched ${formatShortTime(result.startAudio)}\u2013${formatShortTime(result.endAudio)} of the recording \u00b7 ${qualityLabel}`;

      scheduler?.reset();
      renderAnchorList();
      scheduleAutosave();

      const seekTarget = Math.max(0, result.startAudio - 2);
      transport?.seek(seekTarget);
      viewStartSec = seekTarget;
      scheduler?.reset();

      const checkToggle = container.querySelector('#sync-checkit-toggle');
      if (checkToggle) checkToggle.checked = true;
      checkItEnabled = true;
      scheduler?.setOptions({ guideEnabled: true, metronomeEnabled: true });
      applyVolumes();
      if (transport?.playing) {
        scheduler?.start();
      }
    } catch (err) {
      if (!unmounted) {
        ctx.toast(err.message || 'Auto-sync could not match the recording.', 'error');
      }
    } finally {
      isAutoSyncing = false;
      updateAutoSyncUI();
    }
  }

  function renderNoAudioState() {
    container.innerHTML = `
      <div class="view-container">
        <div class="card">
          <h2 class="serif-heading">No Backing Recording Attached</h2>
          <p style="color:var(--text-muted);margin:0 0 18px;">
            This song currently plays with the built-in guitar synth and internal clock, so there is no external recording to sync. Attach a YouTube video, local audio file, or direct URL below to unlock bar-by-bar synchronization.
          </p>

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;">
            <div class="card card-raised">
              <strong>Option 1: YouTube Link</strong>
              <div class="field" style="margin-top:10px;">
                <input type="text" class="input" id="sync-add-yt" placeholder="https://www.youtube.com/watch?v=..." />
              </div>
              <button type="button" class="btn btn-primary btn-sm" id="sync-save-yt">Attach YouTube Video</button>
            </div>

            <div class="card card-raised">
              <strong>Option 2: Audio File from Computer</strong>
              <p style="font-size:0.8rem;color:var(--text-muted);margin:6px 0 12px;">MP3, WAV, OGG, or M4A</p>
              <label class="btn btn-sm btn-primary" style="cursor:pointer;">
                Choose Audio File
                <input type="file" id="sync-add-file" accept="audio/*" class="hidden" />
              </label>
            </div>

            <div class="card card-raised">
              <strong>Option 3: Direct Audio URL</strong>
              <div class="field" style="margin-top:10px;">
                <input type="url" class="input" id="sync-add-url" placeholder="https://example.com/track.mp3" />
              </div>
              <button type="button" class="btn btn-primary btn-sm" id="sync-save-url">Test &amp; Attach URL</button>
            </div>
          </div>

          <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border-subtle);display:flex;justify-content:flex-end;">
            <a href="#/song/${record.id}/play" class="btn">Skip — Go Play with Synth</a>
          </div>
        </div>
      </div>
    `;

    container.querySelector('#sync-save-yt')?.addEventListener('click', async () => {
      const val = container.querySelector('#sync-add-yt').value.trim();
      const id = parseYouTubeId(val);
      if (!id) {
        ctx.toast('Invalid YouTube URL or Video ID.', 'error');
        return;
      }
      record.audio = { kind: 'youtube', videoId: id, url: val };
      await ctx.saveRecord(record);
      ctx.toast('YouTube video attached!', 'success');
      initSyncWorkspace();
    });

    container.querySelector('#sync-add-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await ctx.store.saveAudioBlob(record.id, file);
      record.audio = { kind: 'file', name: file.name };
      await ctx.saveRecord(record);
      ctx.toast(`Attached "${file.name}"`, 'success');
      initSyncWorkspace();
    });

    container.querySelector('#sync-save-url')?.addEventListener('click', async () => {
      const url = container.querySelector('#sync-add-url').value.trim();
      if (!url) return;
      try {
        const testBack = createBackend({ kind: 'url', url });
        await testBack.load();
        testBack.destroy();
        record.audio = { kind: 'url', url };
        await ctx.saveRecord(record);
        ctx.toast('Direct audio URL attached!', 'success');
        initSyncWorkspace();
      } catch (err) {
        ctx.toast(err.message || 'Could not load audio from URL.', 'error');
      }
    });
  }

  async function initSyncWorkspace() {
    if (!record.audio || record.audio.kind === 'none') {
      renderNoAudioState();
      return;
    }

    const barSelectOptions = song.bars.map((_, idx) =>
      `<option value="${idx}" ${idx === tapBarIndex ? 'selected' : ''}>Bar ${idx + 1}</option>`
    ).join('');

    const tapGuidance = song.exactRhythm
      ? 'This tab has exact rhythm: 2 or 3 taps (Bar 1 and a late bar) are normally enough to lock the whole song.'
      : 'ASCII text tabs have approximate rhythm: tap every bar or every other bar for the tightest sync.';

    container.innerHTML = `
      <div class="view-container">
        <div class="card sync-transport-bar">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" id="sync-play-btn">Play</button>
            <button type="button" class="btn btn-sm" id="sync-back-5">-5 s</button>
            <button type="button" class="btn btn-sm" id="sync-fwd-5">+5 s</button>
            <div class="tabs" style="margin-left:6px;">
              <button type="button" class="tab sync-rate-btn" data-rate="0.5">50%</button>
              <button type="button" class="tab sync-rate-btn" data-rate="0.75">75%</button>
              <button type="button" class="tab sync-rate-btn active" data-rate="1">100%</button>
            </div>
            <span class="tabular" id="sync-time-readout" style="font-family:var(--font-mono);font-size:0.88rem;margin-left:8px;">Audio 0:00.00 · Tab 0:00.00</span>
          </div>

          <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
            <label style="display:flex;align-items:center;gap:6px;font-size:0.84rem;cursor:pointer;color:var(--accent);font-weight:700;">
              <input type="checkbox" id="sync-checkit-toggle" />
              Check It (Hear Guide + Clicks)
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--text-muted);">
              Rec / Guide Balance
              <input type="range" class="slider" id="sync-balance-slider" min="0" max="1" step="0.05" value="0.5" style="width:90px;" />
            </label>
            <a href="#/song/${record.id}/play" class="btn btn-primary btn-sm">Done — Go Play &rarr;</a>
          </div>
        </div>

        <div id="sync-yt-row" class="${record.audio.kind === 'youtube' ? '' : 'hidden'}" style="display:flex;align-items:center;gap:16px;">
          <div id="sync-yt-dock" style="width:280px;height:158px;background:#000;border-radius:var(--radius-sm);overflow:hidden;border:1px solid var(--border);"></div>
          <div style="font-size:0.84rem;color:var(--text-muted);">
            <strong>YouTube Backing Track</strong>
            <p style="margin:4px 0 0;">Scroll or drag the timeline below to inspect bars. Drag any amber pin to move an anchor.</p>
          </div>
        </div>

        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span class="stat-label">Audio Timeline &amp; Mapped Tab Bars (Wheel to Zoom · Drag to Scroll · Drag Amber Pin to Adjust)</span>
            <span style="font-size:0.78rem;color:var(--text-muted);" id="sync-source-label"></span>
          </div>
          <div class="sync-timeline-wrap" id="sync-timeline-wrap">
            <canvas id="sync-timeline-canvas"></canvas>
          </div>
        </div>

        <div class="sync-tools-grid">
          <!-- Auto-sync -->
          <div class="card" style="grid-column:1 / -1;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
              <h3 class="serif-heading" style="font-size:1.2rem;margin:0;">1. Auto-sync</h3>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <button type="button" class="btn btn-primary" id="sync-auto-btn">Auto-sync</button>
                <button type="button" class="btn btn-ghost" id="sync-next-match-btn" disabled>Find next match</button>
                <button type="button" class="btn btn-ghost hidden" id="sync-undo-auto-btn">Undo auto-sync</button>
              </div>
            </div>
            <p id="sync-auto-status" style="font-size:0.84rem;color:var(--text-muted);margin:10px 0 0;"></p>
          </div>

          <!-- Tool 2: Tap the bars -->
          <div class="card">
            <h3 class="serif-heading" style="font-size:1.2rem;">2. Tap the Bars</h3>
            <p style="font-size:0.82rem;color:var(--text-muted);margin:0 0 10px;">${tapGuidance}</p>

            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <label style="font-size:0.8rem;color:var(--text-muted);">Next Bar to Tap:</label>
              <select class="select" id="sync-tap-bar-select" style="padding:5px 10px;">${barSelectOptions}</select>
            </div>

            <button type="button" class="btn btn-primary tap-hero-btn" id="sync-tap-btn">
              TAP BAR <span id="sync-tap-bar-num">${tapBarIndex + 1}</span> <span class="kbd" style="margin-left:6px;color:var(--filament);">T</span>
            </button>

            <div style="display:flex;justify-content:space-between;align-items:center;">
              <button type="button" class="btn btn-sm btn-ghost" id="sync-undo-tap-btn">Undo Last Tap <span class="kbd">⌫</span></button>
              <span style="font-size:0.78rem;color:var(--text-muted);" id="sync-anchor-count">${sync.anchors.length} anchors</span>
            </div>
          </div>

          <!-- Tool 3: First note + BPM scale -->
          <div class="card">
            <h3 class="serif-heading" style="font-size:1.2rem;">3. First Note &amp; Tempo</h3>
            <p style="font-size:0.82rem;color:var(--text-muted);margin:0 0 10px;">
              Mark where the first note starts, or enter the recording's real BPM to rescale the entire tab automatically.
            </p>

            <button type="button" class="btn" id="sync-first-note-btn" style="width:100%;margin-bottom:14px;">
              Mark First Note Now <span class="kbd">N</span>
            </button>

            <div class="field" style="margin-bottom:8px;">
              <label for="sync-real-bpm">The recording is at ___ BPM (Tab is ${Math.round(song.bpm)} BPM)</label>
              <div style="display:flex;gap:8px;">
                <input type="number" class="input" id="sync-real-bpm" min="30" max="300" step="0.5" value="${Math.round(song.bpm)}" style="flex:1;" />
                <button type="button" class="btn btn-primary" id="sync-apply-bpm-btn">Apply BPM</button>
              </div>
            </div>
          </div>

          <!-- Tool 4: Fine Tune & Anchor List -->
          <div class="card">
            <h3 class="serif-heading" style="font-size:1.2rem;">4. Fine Tune &amp; Anchors</h3>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
              <button type="button" class="btn btn-sm nudge-btn" data-ms="-50">-50 ms</button>
              <button type="button" class="btn btn-sm nudge-btn" data-ms="-10">-10 ms</button>
              <button type="button" class="btn btn-sm nudge-btn" data-ms="10">+10 ms</button>
              <button type="button" class="btn btn-sm nudge-btn" data-ms="50">+50 ms</button>
              <button type="button" class="btn btn-sm btn-danger" id="sync-clear-all-btn" style="margin-left:auto;">Clear All</button>
            </div>

            <div class="anchor-table-wrap" id="sync-anchor-list"></div>
          </div>
        </div>
      </div>
    `;

    const ytContainer = document.getElementById('yt-player-container');
    const ytDock = container.querySelector('#sync-yt-dock');
    if (record.audio.kind === 'youtube' && ytDock && ytContainer) {
      ytDock.appendChild(ytContainer);
    }

    decodedAudioBuffer = null;
    waveformDecodePromise = null;
    lastMatchedStartAudio = null;
    autoSyncStatusText = '';

    let blob = null;
    if (record.audio.kind === 'file') {
      blob = await ctx.store.getAudioBlob(record.id);
      container.querySelector('#sync-source-label').textContent = record.audio.name || 'Local Audio File';
      if (blob) {
        waveformDecodePromise = tryDecodeWaveform(blob).finally(() => {
          waveformDecodePromise = null;
          updateAutoSyncUI();
        });
      }
    } else if (record.audio.kind === 'url') {
      container.querySelector('#sync-source-label').textContent = record.audio.url;
      waveformDecodePromise = tryDecodeWaveform(record.audio.url).finally(() => {
        waveformDecodePromise = null;
        updateAutoSyncUI();
      });
    } else if (record.audio.kind === 'youtube') {
      container.querySelector('#sync-source-label').textContent = `YouTube (${record.audio.videoId})`;
    }
    updateAutoSyncUI();

    transport = createBackend(record.audio, {
      container: ytContainer,
      blob,
      duration: song.duration + 4
    });

    transport.on('state', () => updateTransportButtons());
    transport.on('error', (e) => ctx.toast(e.message || 'Audio playback error', 'error'));

    try {
      await transport.load();
    } catch (err) {
      ctx.toast(err.message || 'Could not load backing audio.', 'error');
    }

    // The guide plays with the same sound as the play screen: the song's tone, or the user's Guide sound.
    try {
      const songTone = baseToneId(record.tone || suggestTone(song)?.id, ctx.amp?.presets);
      ctx.synth.setTone?.(resolveGuideTone(ctx.settings.get('guideTone'), songTone));
    } catch (_) {
      // Keep whatever tone is set.
    }
    scheduler = new GuideScheduler(ctx.synth, {
      song,
      tabTimeNow: () => audioToTab(sync, transport ? transport.currentTime : 0),
      tabToAudio: (t) => tabToAudio(sync, t),
      getRate: () => transport ? transport.rate : 1.0,
      guideEnabled: false,
      metronomeEnabled: false
    });

    applyVolumes();
    renderAnchorList();
    setupSyncListeners();
    startTimelineLoop();
  }

  function updateTransportButtons() {
    const btn = container.querySelector('#sync-play-btn');
    if (btn && transport) {
      btn.textContent = transport.playing ? 'Pause' : 'Play';
    }
  }

  function renderAnchorList() {
    const listEl = container.querySelector('#sync-anchor-list');
    const countEl = container.querySelector('#sync-anchor-count');
    if (!listEl) return;
    if (countEl) countEl.textContent = `${sync.anchors.length} anchor${sync.anchors.length === 1 ? '' : 's'}`;

    if (sync.anchors.length === 0) {
      listEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-muted);font-size:0.82rem;">No anchors yet (1:1 default timing).</div>`;
      return;
    }

    listEl.innerHTML = sync.anchors.map((a, idx) => {
      let barNum = 1;
      let minDist = Infinity;
      for (let i = 0; i < song.bars.length; i++) {
        const d = Math.abs(song.bars[i].t - a.tab);
        if (d < minDist) {
          minDist = d;
          barNum = i + 1;
        }
      }
      return `
        <div class="anchor-row">
          <span class="anchor-text">Bar ${barNum} <span class="anchor-times">tab ${a.tab.toFixed(2)}s &rarr; ${a.audio.toFixed(2)}s</span></span>
          <button type="button" class="btn btn-sm btn-ghost btn-danger del-anchor-btn" data-idx="${idx}" aria-label="Remove this anchor">&times;</button>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.del-anchor-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        removeAnchor(sync, idx);
        renderAnchorList();
        scheduleAutosave();
      });
    });
  }

  function performBarTap() {
    if (!transport) return;
    if (tapBarIndex < 0 || tapBarIndex >= song.bars.length) return;
    const bar = song.bars[tapBarIndex];
    const tapLatency = 0.03;
    const audioT = Math.max(0, transport.currentTime - tapLatency);

    const res = addAnchor(sync, bar.t, audioT);
    if (!res.ok) {
      ctx.toast(res.reason, 'error');
      return;
    }

    tapHistoryStack.push(bar.t);
    if (tapBarIndex + 1 < song.bars.length) {
      tapBarIndex++;
    }
    const sel = container.querySelector('#sync-tap-bar-select');
    const numSpan = container.querySelector('#sync-tap-bar-num');
    if (sel) sel.value = String(tapBarIndex);
    if (numSpan) numSpan.textContent = String(tapBarIndex + 1);

    scheduler?.reset();
    renderAnchorList();
    scheduleAutosave();
  }

  function undoLastTap() {
    if (tapHistoryStack.length === 0) return;
    const lastTab = tapHistoryStack.pop();
    removeAnchor(sync, lastTab);
    const barIdx = song.bars.findIndex((b) => Math.abs(b.t - lastTab) < 0.05);
    if (barIdx >= 0) {
      tapBarIndex = barIdx;
      const sel = container.querySelector('#sync-tap-bar-select');
      const numSpan = container.querySelector('#sync-tap-bar-num');
      if (sel) sel.value = String(tapBarIndex);
      if (numSpan) numSpan.textContent = String(tapBarIndex + 1);
    }
    scheduler?.reset();
    renderAnchorList();
    scheduleAutosave();
  }

  // Mark First Note, Apply BPM and Clear All replace every sync point: keep a copy and offer Undo.
  function offerUndo(message, prevAnchors) {
    if (!prevAnchors || prevAnchors.length < 2) {
      ctx.toast(message, 'success');
      return;
    }
    ctx.toast(`${message} (replaced ${prevAnchors.length} sync points)`, 'success', {
      actionLabel: 'Undo',
      onAction: () => {
        sync.anchors = prevAnchors;
        scheduler?.reset();
        renderAnchorList();
        updateAutoSyncUI();
        scheduleAutosave();
      },
    });
  }

  function markFirstNote() {
    if (!transport) return;
    const prev = sync.anchors.map((a) => ({ ...a }));
    const firstNoteT = song.notes.length > 0 ? song.notes[0].t : 0;
    const audioT = Math.max(0, transport.currentTime - 0.03);
    sync.anchors = [{ tab: firstNoteT, audio: audioT }];
    scheduler?.reset();
    renderAnchorList();
    scheduleAutosave();
    offerUndo(`Marked first note at ${audioT.toFixed(2)}s`, prev);
  }

  function setupSyncListeners() {
    container.querySelector('#sync-play-btn')?.addEventListener('click', async () => {
      await resumeAudio();
      if (transport.playing) {
        transport.pause();
        scheduler.stop();
      } else {
        transport.play();
        if (checkItEnabled) scheduler.start();
      }
      updateTransportButtons();
    });

    container.querySelector('#sync-back-5')?.addEventListener('click', () => {
      transport?.seek(Math.max(0, transport.currentTime - 5));
      scheduler?.reset();
    });

    container.querySelector('#sync-fwd-5')?.addEventListener('click', () => {
      transport?.seek(transport.currentTime + 5);
      scheduler?.reset();
    });

    container.querySelectorAll('.sync-rate-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = parseFloat(btn.dataset.rate);
        const applied = transport ? transport.setRate(r) : r;
        container.querySelectorAll('.sync-rate-btn').forEach((b) => {
          b.classList.toggle('active', Math.abs(parseFloat(b.dataset.rate) - applied) < 0.05);
        });
      });
    });

    container.querySelector('#sync-checkit-toggle')?.addEventListener('change', async (e) => {
      await resumeAudio();
      checkItEnabled = e.target.checked;
      scheduler.setOptions({ guideEnabled: checkItEnabled, metronomeEnabled: checkItEnabled });
      applyVolumes();
      if (checkItEnabled && transport?.playing) {
        scheduler.start();
      } else {
        scheduler.stop();
      }
    });

    container.querySelector('#sync-balance-slider')?.addEventListener('input', (e) => {
      balance = parseFloat(e.target.value);
      applyVolumes();
    });

    container.querySelector('#sync-tap-bar-select')?.addEventListener('change', (e) => {
      tapBarIndex = parseInt(e.target.value, 10) || 0;
      const numSpan = container.querySelector('#sync-tap-bar-num');
      if (numSpan) numSpan.textContent = String(tapBarIndex + 1);
    });

    container.querySelector('#sync-auto-btn')?.addEventListener('click', () => runAutoSync(0));
    container.querySelector('#sync-undo-auto-btn')?.addEventListener('click', undoAutoSync);

    container.querySelector('#sync-next-match-btn')?.addEventListener('click', () => {
      const nextStart = lastMatchedStartAudio !== null ? lastMatchedStartAudio + 2 : 0;
      runAutoSync(nextStart);
    });
    container.querySelector('#sync-tap-btn')?.addEventListener('click', performBarTap);
    container.querySelector('#sync-undo-tap-btn')?.addEventListener('click', undoLastTap);
    container.querySelector('#sync-first-note-btn')?.addEventListener('click', markFirstNote);

    container.querySelector('#sync-apply-bpm-btn')?.addEventListener('click', () => {
      const realBpm = parseFloat(container.querySelector('#sync-real-bpm').value);
      if (!Number.isFinite(realBpm) || realBpm < 30 || realBpm > 300) {
        ctx.toast('Enter a valid BPM between 30 and 300.', 'error');
        return;
      }
      const firstNoteT = song.notes.length > 0 ? song.notes[0].t : 0;
      const currentFirstAudio = tabToAudio(sync, firstNoteT);
      const tempoScale = realBpm / (song.bpm || 120);
      const offsetAtZero = currentFirstAudio - (firstNoteT / tempoScale);
      const rebuilt = fromOffsetAndScale(offsetAtZero, tempoScale, song.duration);
      const prev = sync.anchors.map((a) => ({ ...a }));
      sync.anchors = rebuilt.anchors;
      scheduler?.reset();
      renderAnchorList();
      scheduleAutosave();
      offerUndo(`Applied ${realBpm} BPM tempo scale`, prev);
    });

    container.querySelectorAll('.nudge-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const deltaSec = parseInt(btn.dataset.ms, 10) / 1000;
        shiftAll(sync, deltaSec);
        scheduler?.reset();
        renderAnchorList();
        scheduleAutosave();
      });
    });

    container.querySelector('#sync-clear-all-btn')?.addEventListener('click', () => {
      const prev = sync.anchors.map((a) => ({ ...a }));
      sync.anchors = [];
      tapHistoryStack.length = 0;
      lastMatchedStartAudio = null;
      autoSyncStatusText = '';
      tapBarIndex = firstBarWithNotes;
      const sel = container.querySelector('#sync-tap-bar-select');
      const numSpan = container.querySelector('#sync-tap-bar-num');
      if (sel) sel.value = String(tapBarIndex);
      if (numSpan) numSpan.textContent = String(tapBarIndex + 1);
      scheduler?.reset();
      renderAnchorList();
      updateAutoSyncUI();
      scheduleAutosave();
      offerUndo('Cleared all sync points', prev);
    });

    // Timeline Canvas Pointer & Wheel Interactions
    const canvas = container.querySelector('#sync-timeline-canvas');
    if (canvas) {
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const focusSec = viewStartSec + mouseX / pxPerSec;

        if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          const factor = e.deltaY < 0 ? 1.15 : 0.87;
          pxPerSec = Math.max(25, Math.min(350, pxPerSec * factor));
          viewStartSec = Math.max(0, focusSec - mouseX / pxPerSec);
        } else {
          viewStartSec = Math.max(0, viewStartSec + (e.deltaX / pxPerSec));
        }
      }, { passive: false });

      canvas.addEventListener('pointerdown', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const clickedSec = viewStartSec + x / pxPerSec;

        // Check if clicking near an anchored pin (top 40px)
        if (y <= 44) {
          for (const a of sync.anchors) {
            const ax = (a.audio - viewStartSec) * pxPerSec;
            if (Math.abs(ax - x) <= 10) {
              draggingAnchorTab = a.tab;
              canvas.setPointerCapture(e.pointerId);
              return;
            }
          }
        }

        // If clicking in the top ruler (y < 24), seek directly
        if (y < 24 && transport) {
          transport.seek(Math.max(0, clickedSec));
          scheduler?.reset();
          return;
        }

        draggingPanStartX = e.clientX;
        draggingPanStartSec = viewStartSec;
        canvas.setPointerCapture(e.pointerId);
      });

      canvas.addEventListener('pointermove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;

        if (draggingAnchorTab !== null) {
          const targetAudio = Math.max(0, viewStartSec + x / pxPerSec);
          const res = addAnchor(sync, draggingAnchorTab, targetAudio);
          if (!res.ok) {
            ctx.toast(res.reason, 'error');
            draggingAnchorTab = null;
          } else {
            renderAnchorList();
            scheduleAutosave();
          }
          return;
        }

        if (draggingPanStartX !== null) {
          const dx = e.clientX - draggingPanStartX;
          if (Math.abs(dx) < 4) return;
          viewStartSec = Math.max(0, draggingPanStartSec - dx / pxPerSec);
        }
      });

      canvas.addEventListener('pointerup', (e) => {
        if (draggingPanStartX !== null && Math.abs(e.clientX - draggingPanStartX) < 4 && transport) {
          const rect = canvas.getBoundingClientRect();
          const clickedSec = Math.max(0, viewStartSec + (e.clientX - rect.left) / pxPerSec);
          transport.seek(clickedSec);
          scheduler?.reset();
        }
        draggingAnchorTab = null;
        draggingPanStartX = null;
      });
    }
  }

  function onKeyDown(e) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName)) return;
    if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      performBarTap();
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      markFirstNote();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      undoLastTap();
    } else if (e.code === 'Space' && transport) {
      e.preventDefault();
      container.querySelector('#sync-play-btn')?.click();
    }
  }

  window.addEventListener('keydown', onKeyDown);

  function startTimelineLoop() {
    const canvas = container.querySelector('#sync-timeline-canvas');
    const readout = container.querySelector('#sync-time-readout');
    if (!canvas) return;
    const c = canvas.getContext('2d');

    function draw() {
      if (unmounted) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = globalThis.devicePixelRatio || 1;
      const w = Math.max(300, Math.floor(rect.width || 800));
      const h = Math.max(220, Math.floor(rect.height || 270));
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }

      const audioNow = transport ? transport.currentTime : 0;
      const tabNow = audioToTab(sync, audioNow);
      if (readout) {
        readout.textContent = `Audio ${formatTime(audioNow)} · Tab ${formatTime(tabNow)}`;
      }

      // Auto-follow playhead when playing and not dragging
      const spanSec = w / pxPerSec;
      if (transport?.playing && draggingPanStartX === null && draggingAnchorTab === null) {
        if (audioNow > viewStartSec + spanSec * 0.82 || audioNow < viewStartSec) {
          viewStartSec = Math.max(0, audioNow - spanSec * 0.2);
        }
      }

      c.save();
      c.scale(dpr, dpr);
      c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--screen').trim() || '#101113';
      c.fillRect(0, 0, w, h);

      // 1. Audio Time Ruler (top 24px)
      c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--screen-2').trim() || '#17191c';
      c.fillRect(0, 0, w, 24);
      c.strokeStyle = 'rgba(241, 231, 208, 0.16)';
      c.beginPath();
      c.moveTo(0, 24);
      c.lineTo(w, 24);
      c.stroke();

      const firstSec = Math.floor(viewStartSec);
      const lastSec = Math.ceil(viewStartSec + spanSec);
      const stepSec = pxPerSec < 45 ? 5 : pxPerSec < 90 ? 2 : 1;
      c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--screen-cream-muted').trim() || '#a69a86';
      c.font = '600 10px ui-monospace, monospace';
      for (let s = firstSec - (firstSec % stepSec); s <= lastSec; s += stepSec) {
        if (s < 0) continue;
        const x = (s - viewStartSec) * pxPerSec;
        c.strokeStyle = 'rgba(241, 231, 208, 0.12)';
        c.beginPath();
        c.moveTo(x, 16);
        c.lineTo(x, 24);
        c.stroke();
        c.fillText(`${s}s`, x + 3, 13);
      }

      // Tab lane along the bottom: one line per string (highest on top), fret numbers where each note maps to now.
      const nStr = Array.isArray(song.tuning) && song.tuning.length ? song.tuning.length : 6;
      const rowH = 11;
      const tabH = nStr * rowH + 12;
      const tabTop = h - tabH;
      c.fillStyle = 'rgba(0, 0, 0, 0.22)';
      c.fillRect(0, tabTop, w, tabH);
      c.strokeStyle = 'rgba(241, 231, 208, 0.18)';
      c.lineWidth = 1;
      for (let si = 0; si < nStr; si++) {
        const y = Math.round(tabTop + 6 + si * rowH + rowH / 2) + 0.5;
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
      }
      const tabLo = audioToTab(sync, viewStartSec) - 0.5;
      const tabHi = audioToTab(sync, viewStartSec + spanSec) + 0.5;
      const cream = getComputedStyle(document.documentElement).getPropertyValue('--screen-cream').trim() || '#f1e7d0';
      const screenBg = getComputedStyle(document.documentElement).getPropertyValue('--screen').trim() || '#101113';
      c.font = '700 10px ui-monospace, monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      for (const n of song.notes) {
        if (n.t < tabLo || n.t > tabHi || n.tie) continue;
        const nx = (tabToAudio(sync, n.t) - viewStartSec) * pxPerSec;
        if (nx < -10 || nx > w + 10) continue;
        const row = nStr - 1 - n.string;
        if (row < 0 || row >= nStr) continue;
        const ny = tabTop + 6 + row * rowH + rowH / 2;
        const label = n.dead ? 'x' : String(n.fret);
        const tw = c.measureText(label).width + 4;
        c.fillStyle = screenBg;
        c.fillRect(nx - tw / 2, ny - 5, tw, 10);
        c.fillStyle = cream;
        c.fillText(label, nx, ny + 0.5);
      }
      c.textAlign = 'start';
      c.textBaseline = 'alphabetic';

      // 2. Waveform (if decoded), between the ruler and the tab lane
      if (waveformPeaks && waveformDuration > 0) {
        const numBuckets = waveformPeaks.length / 2;
        const midY = 24 + (tabTop - 24) * 0.55;
        const ampH = (tabTop - 36) * 0.42;
        c.strokeStyle = 'rgba(63, 163, 214, 0.32)';
        c.lineWidth = 1;
        c.beginPath();
        for (let px = 0; px < w; px += 2) {
          const sec = viewStartSec + px / pxPerSec;
          if (sec < 0 || sec > waveformDuration) continue;
          const bIdx = Math.min(numBuckets - 1, Math.floor((sec / waveformDuration) * numBuckets));
          const minV = waveformPeaks[bIdx * 2];
          const maxV = waveformPeaks[bIdx * 2 + 1];
          c.moveTo(px, midY + minV * ampH);
          c.lineTo(px, midY + maxV * ampH);
        }
        c.stroke();
      }

      // 3. Mapped Tab Bars & Amber Anchors
      for (let bIdx = 0; bIdx < song.bars.length; bIdx++) {
        const bar = song.bars[bIdx];
        const barAudioT = tabToAudio(sync, bar.t);
        const bx = (barAudioT - viewStartSec) * pxPerSec;
        if (bx < -30 || bx > w + 30) continue;

        const isAnchored = sync.anchors.some((a) => Math.abs(a.tab - bar.t) < 0.05);
        const isNextTap = bIdx === tapBarIndex;

        c.strokeStyle = isAnchored
          ? (getComputedStyle(document.documentElement).getPropertyValue('--jewel').trim() || '#e0352b')
          : isNextTap
            ? (getComputedStyle(document.documentElement).getPropertyValue('--ok').trim() || '#4fb36b')
            : 'rgba(241, 231, 208, 0.28)';
        c.lineWidth = isAnchored ? 2.2 : 1.2;
        c.beginPath();
        c.moveTo(bx, 24);
        c.lineTo(bx, h);
        c.stroke();

        // Pin head for anchored bar
        if (isAnchored) {
          c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--jewel').trim() || '#e0352b';
          c.beginPath();
          c.arc(bx, 32, 6, 0, Math.PI * 2);
          c.fill();
        }

        c.fillStyle = isAnchored ? (getComputedStyle(document.documentElement).getPropertyValue('--jewel').trim() || '#e0352b') : isNextTap ? (getComputedStyle(document.documentElement).getPropertyValue('--ok').trim() || '#4fb36b') : (getComputedStyle(document.documentElement).getPropertyValue('--screen-cream').trim() || '#f1e7d0');
        c.font = '700 11px sans-serif';
        c.fillText(`Bar ${bIdx + 1}`, bx + 5, 48);
      }

      // 4. Playhead
      const playX = (audioNow - viewStartSec) * pxPerSec;
      if (playX >= 0 && playX <= w) {
        c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--bad').trim() || '#d8452f';
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(playX, 0);
        c.lineTo(playX, h);
        c.stroke();
      }

      c.restore();
      rafId = requestAnimationFrame(draw);
    }

    rafId = requestAnimationFrame(draw);
  }

  initSyncWorkspace();

  return {
    unmount() {
      unmounted = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (saveTimer) clearTimeout(saveTimer);
      if (alignWorker) {
        alignWorker.terminate();
        alignWorker = null;
      }
      window.removeEventListener('keydown', onKeyDown);
      scheduler?.stop();
      ctx.synth.stopAll();
      transport?.destroy();

      const ytHolder = document.getElementById('yt-holder');
      const ytContainer = document.getElementById('yt-player-container');
      if (ytHolder && ytContainer && !ytHolder.contains(ytContainer)) {
        ytHolder.appendChild(ytContainer);
      }
    }
  };
}
