import { analyzeSong, scaleFretboard, NOTE_NAMES, SCALES, romanNumeral, harmonicFunction } from './theory.js';
import { skeletonSong, buildEvents, midiToName } from './song.js';
import { renderFretboard, renderChordDiagram } from './fretboard.js';
import { Highway } from './highway.js';
import { judgeNotes } from './dsp.js';
import { resumeAudio } from './audio-context.js';
import { suggestTone, TONE_NAMES } from './tone-suggest.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstHomeBaseSentence(insights) {
  if (!Array.isArray(insights) || insights.length === 0) return '';
  const raw = insights.find((p) => /^Home Base\s*:/i.test(p)) || insights[0] || '';
  const stripped = raw.replace(/^Home Base\s*:\s*/i, '').trim();
  if (!stripped) return '';
  const parts = stripped.split('. ');
  const first = parts[0].trim();
  if (!first) return '';
  return parts.length > 1 && !first.endsWith('.') ? `${first}.` : first;
}

function formatInsightBody(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/\b\d+(?:\.\d+)?%/g, (match) => `<b class="learn-num">${match}</b>`);
}

/** "Suggested tone: Crunch - 42% of chords are power chords, palm mutes on 30% of notes" */
function toneLine(song) {
  let t = null;
  try {
    t = suggestTone(song);
  } catch (_) {
    return '';
  }
  if (!t || !t.id) return '';
  const why = (t.reasons || []).slice(0, 2).join(', ');
  const toneName = escapeHtml(TONE_NAMES[t.id] || t.id);
  const whyHtml = why ? ` &mdash; ${escapeHtml(why)}` : '';
  return `<p class="tone-suggestion">Suggested tone: <span class="tone-name">${toneName}</span>${whyHtml}. Woodshed Amp switches to it when you open the song.</p>`;
}

const DEGREE_LABELS = {
  0: '1',
  1: 'b2',
  2: '2',
  3: 'b3',
  4: '3',
  5: '4',
  6: 'b5',
  7: '5',
  8: 'b6',
  9: '6',
  10: 'b7',
  11: '7'
};

function stepFormula(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return '';
  const steps = [];
  for (let i = 0; i < intervals.length; i++) {
    const cur = intervals[i];
    const next = i + 1 < intervals.length ? intervals[i + 1] : 12;
    const diff = next - cur;
    if (diff === 1) steps.push('H');
    else if (diff === 2) steps.push('W');
    else if (diff === 3) steps.push('W+H');
    else steps.push(`${diff}st`);
  }
  return steps.join(' – ');
}

function degreeFormula(intervals) {
  if (!Array.isArray(intervals)) return '';
  return intervals.map((iv) => DEGREE_LABELS[iv % 12] || String(iv)).join(' · ');
}

function confidencePhrase(conf) {
  if (conf >= 0.8) return 'High confidence';
  if (conf >= 0.6) return 'Moderate confidence';
  return 'Modal / ambiguous center';
}

function deriveStandardVoicing(chord, tuning, capo = 0) {
  const notes = [];
  const rootPc = ((chord.root % 12) + 12) % 12;
  const isMinor = chord.type === 'min' || chord.type === 'm7' || chord.type === 'm9';
  const isPower = chord.type === '5';
  const thirdIv = isMinor ? 3 : 4;
  const allowedPcs = isPower
    ? new Set([rootPc, (rootPc + 7) % 12])
    : new Set([rootPc, (rootPc + thirdIv) % 12, (rootPc + 7) % 12]);

  let foundRoot = false;
  for (let s = 0; s < tuning.length; s++) {
    const openMidi = tuning[s] + capo;
    for (let f = 0; f <= 4; f++) {
      const pc = ((openMidi + f) % 12 + 12) % 12;
      if (!foundRoot && pc === rootPc) {
        foundRoot = true;
        notes.push({ string: s, fret: f, midi: openMidi + f });
        break;
      } else if (foundRoot && allowedPcs.has(pc)) {
        notes.push({ string: s, fret: f, midi: openMidi + f });
        break;
      }
    }
  }
  return notes;
}

export function mount(container, ctx) {
  if (!ctx.record) {
    ctx.navigate('#/library');
    return { unmount() {} };
  }

  const record = ctx.record;
  const song = record.song;
  const analysis = analyzeSong(song);
  const spell = NOTE_NAMES.forKey(analysis.key.tonic, analysis.key.mode);
  const keyName = `${spell[analysis.key.tonic]} ${analysis.key.mode}`;
  const usedPcSet = new Set(analysis.usedPitchClasses);

  let selectedScaleName = analysis.scale;
  let onlySongNotes = false;
  let selectedChordIndex = 0;

  const miniHighways = [];
  const scheduledTimeouts = new Set();
  let drillRafId = null;

  // Ear Drill State
  const drillState = {
    active: false,
    round: 0,
    totalRounds: 5,
    score: 0,
    targetChord: null,
    waitingForPlayer: false,
    feedback: ''
  };

  function clearScheduledSounds() {
    for (const tid of scheduledTimeouts) clearTimeout(tid);
    scheduledTimeouts.clear();
    ctx.synth.stopAll();
  }

  function scheduleCallback(fn, delayMs) {
    const tid = setTimeout(() => {
      scheduledTimeouts.delete(tid);
      fn();
    }, delayMs);
    scheduledTimeouts.add(tid);
  }

  const playableNotes = song.notes.filter((n) => !n.dead && !n.tie);

  container.innerHTML = `
    <div class="view-container">
      <!-- 1. The Big Picture -->
      <section class="card">
        <h2 class="serif-heading">1. The Big Picture</h2>
        <div class="learn-stats-grid">
          <div class="stat card-raised learn-stat-card">
            <span class="stat-label">Key Center</span>
            <span class="stat-value">${escapeHtml(keyName)}</span>
            <span class="learn-stat-sub">${confidencePhrase(analysis.key.confidence)} (${Math.round(analysis.key.confidence * 100)}%)</span>
          </div>
          <div class="stat card-raised learn-stat-card">
            <span class="stat-label">Primary Scale</span>
            <span class="stat-value learn-stat-value-scale">${escapeHtml(spell[analysis.key.tonic])} ${escapeHtml(analysis.scale)}</span>
            <span class="learn-stat-sub">${Math.round((analysis.scales[0]?.coverage || 1) * 100)}% note coverage</span>
          </div>
          <div class="stat card-raised learn-stat-card">
            <span class="stat-label">Tempo &amp; Capo</span>
            <span class="stat-value">${Math.round(song.bpm)} BPM</span>
            <span class="learn-stat-sub">${song.capo ? `Capo Fret ${song.capo}` : 'No Capo (Open)'}</span>
          </div>
          <div class="stat card-raised learn-stat-card">
            <span class="stat-label">Neck Position</span>
            <span class="stat-value learn-stat-value-pos">Frets ${analysis.positions.minFret}–${analysis.positions.maxFret}</span>
            <span class="learn-stat-sub">${escapeHtml(analysis.positions.label)}</span>
          </div>
        </div>
        <p class="learn-summary-line">${escapeHtml(firstHomeBaseSentence(analysis.insights))}</p>
        ${toneLine(song)}
      </section>

      <!-- 2. The Scale Under It -->
      <section class="card">
        <div class="learn-section-header">
          <h2 class="serif-heading">2. The Scale Under It</h2>
          <div class="learn-toolbar-actions">
            <label class="learn-toggle-label">
              <input type="checkbox" id="learn-only-used-toggle" />
              Only notes the song uses
            </label>
            <button type="button" class="btn btn-sm btn-primary" id="learn-play-scale-btn">&#9835; Play Scale Up &amp; Down</button>
          </div>
        </div>

        <div id="learn-scale-chips" class="learn-scale-chips"></div>
        <div id="learn-scale-meta" class="learn-scale-meta"></div>

        <div id="learn-scale-fretboard" class="fretboard" title="Click any note dot to hear it"></div>
        <div class="learn-scale-legend">
          <span class="learn-legend-item"><span class="learn-legend-dot is-root"></span>Root</span>
          <span class="learn-legend-item"><span class="learn-legend-dot is-used"></span>In the song</span>
          <span class="learn-legend-item"><span class="learn-legend-dot is-scale"></span>In the scale only</span>
        </div>

        ${analysis.outsideNotes.length > 0 ? `
          <div class="learn-outside-notes">
            <span class="learn-meta-label learn-outside-heading">Outside / Color Notes</span>
            <div class="learn-outside-list">
              ${analysis.outsideNotes.map((o) => `<div class="learn-outside-item"><strong class="learn-outside-note">${escapeHtml(o.note)}:</strong> ${escapeHtml(o.explanation)}</div>`).join('')}
            </div>
          </div>
        ` : ''}
      </section>

      <!-- 3. The Chords -->
      <section class="card" id="learn-chords-section"></section>

      <!-- 4. Why It Works -->
      <section class="card">
        <h2 class="serif-heading">4. Why It Works</h2>
        <div class="insights-grid">
          ${analysis.insights.map((paragraph) => {
            const colonIdx = paragraph.indexOf(':');
            const heading = colonIdx > 0 ? paragraph.slice(0, colonIdx) : 'Musical Insight';
            const body = colonIdx > 0 ? paragraph.slice(colonIdx + 1).trim() : paragraph;
            return `
              <div class="insight-item">
                <h4>${escapeHtml(heading)}</h4>
                <p>${formatInsightBody(body)}</p>
              </div>
            `;
          }).join('')}
        </div>
      </section>

      <!-- 5. Learn It In Layers -->
      <section class="card">
        <div class="learn-section-header learn-layers-header">
          <h2 class="serif-heading">5. Learn It in Layers</h2>
          <span class="learn-help-line">
            Recommended path: lock in <strong>Level 1</strong> at 70% speed, add the <strong>Level 2</strong> bass line at 85%, then tackle <strong>Level 3</strong>.
          </span>
        </div>
        <div class="layers-grid" id="learn-layers-grid"></div>
      </section>

      <!-- 6. Ear and Theory Drills -->
      <section class="card" id="learn-drill-section"></section>
    </div>
  `;

  // --- Section 2 Logic: Scale Fretboard & Playback ---
  const scaleChipsEl = container.querySelector('#learn-scale-chips');
  const scaleMetaEl = container.querySelector('#learn-scale-meta');
  const scaleFbEl = container.querySelector('#learn-scale-fretboard');

  function updateScaleSection() {
    scaleChipsEl.innerHTML = analysis.scales.slice(0, 6).map((sc) => `
      <button type="button" class="chip learn-scale-chip ${sc.name === selectedScaleName ? 'chip-accent' : ''}" data-scale="${escapeHtml(sc.name)}">
        ${escapeHtml(spell[analysis.key.tonic])} ${escapeHtml(sc.name)} (${Math.round(sc.coverage * 100)}%)
      </button>
    `).join('');

    scaleChipsEl.querySelectorAll('[data-scale]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedScaleName = btn.dataset.scale;
        updateScaleSection();
      });
    });

    const intervals = SCALES[selectedScaleName] || SCALES['natural minor'];
    const noteNames = intervals.map((iv) => spell[(analysis.key.tonic + iv) % 12]).join(' – ');
    scaleMetaEl.innerHTML = `
      <div class="learn-meta-item"><span class="learn-meta-label">Notes:</span> <span class="learn-meta-value">${escapeHtml(noteNames)}</span></div>
      <div class="learn-meta-item"><span class="learn-meta-label">Degrees:</span> <span class="learn-meta-value">${escapeHtml(degreeFormula(intervals))}</span></div>
      <div class="learn-meta-item"><span class="learn-meta-label">Steps:</span> <span class="learn-meta-value">${escapeHtml(stepFormula(intervals))}</span></div>
    `;

    const rawCells = scaleFretboard(analysis.key.tonic, selectedScaleName, song.tuning, song.capo, 15);
    const filtered = onlySongNotes
      ? rawCells.filter((c) => usedPcSet.has(((c.midi % 12) + 12) % 12))
      : rawCells;

    const marks = filtered.map((c) => {
      const pc = ((c.midi % 12) + 12) % 12;
      const isUsed = usedPcSet.has(pc);
      return {
        string: c.string,
        fret: c.fret,
        midi: c.midi,
        label: spell[pc],
        kind: c.isRoot ? 'root' : isUsed ? 'used' : 'scale'
      };
    });

    renderFretboard(scaleFbEl, {
      tuning: song.tuning,
      capo: song.capo,
      frets: 15,
      marks,
      leftHanded: Boolean(ctx.settings.get('leftHanded'))
    });

    // Make each SVG circle clickable to play that note
    const circles = scaleFbEl.querySelectorAll('circle');
    circles.forEach((circle) => {
      const cx = parseFloat(circle.getAttribute('cx'));
      const cy = parseFloat(circle.getAttribute('cy'));
      circle.style.cursor = 'pointer';
      circle.addEventListener('click', async () => {
        await resumeAudio();
        // Find matching mark by string/fret
        const numStrings = song.tuning.length;
        const s = Math.round(numStrings - 1 - (cy - 22) / 22);
        const leftHanded = Boolean(ctx.settings.get('leftHanded'));
        const boardW = 15 * 46;
        let f = 0;
        if ((!leftHanded && cx >= 46) || (leftHanded && cx <= 46 + boardW)) {
          const rel = leftHanded ? (46 + boardW - cx) : (cx - 46);
          f = Math.round(rel / 46 + 0.5);
        }
        if (s >= 0 && s < numStrings && f >= 0 && f <= 15) {
          const midi = song.tuning[s] + (song.capo || 0) + f;
          ctx.synth.playNote(midi, 0, 0.75, 0.85);
        }
      });
    });
  }

  container.querySelector('#learn-only-used-toggle')?.addEventListener('change', (e) => {
    onlySongNotes = e.target.checked;
    updateScaleSection();
  });

  container.querySelector('#learn-play-scale-btn')?.addEventListener('click', async () => {
    await resumeAudio();
    clearScheduledSounds();
    const intervals = SCALES[selectedScaleName] || SCALES['natural minor'];
    const lowestOpen = Math.min(...song.tuning) + (song.capo || 0);
    let baseRoot = lowestOpen + (((analysis.key.tonic - lowestOpen) % 12 + 12) % 12);
    const asc = [...intervals.map((iv) => baseRoot + iv), baseRoot + 12];
    const seq = [...asc, ...asc.slice(0, -1).reverse()];
    const stepSec = 0.24;
    const now = ctx.synth.ctx.currentTime + 0.03;
    seq.forEach((midi, idx) => {
      ctx.synth.playNote(midi, now + idx * stepSec, 0.22, 0.8);
    });
  });

  updateScaleSection();

  // --- Section 3 Logic: The Chords ---
  const chordsSection = container.querySelector('#learn-chords-section');
  if (analysis.chords.length === 0 || playableNotes.length < 3) {
    chordsSection.innerHTML = `
      <h2 class="serif-heading">3. The Chords</h2>
      <p class="learn-help-line">This passage contains too few notes to infer distinct bar-by-bar chords — focus on the scale roadmap above.</p>
    `;
  } else {
    const loopStr = analysis.progression.join(' – ') || 'i';
    chordsSection.innerHTML = `
      <div class="learn-section-header learn-chords-header">
        <h2 class="serif-heading">3. The Chords</h2>
        <div class="learn-fn-legend">
          <span class="chip learn-fn-chip fn-tonic">Tonic</span>
          <span class="chip learn-fn-chip fn-subdominant">Subdominant</span>
          <span class="chip learn-fn-chip fn-dominant">Dominant</span>
          <span class="chip learn-fn-chip fn-borrowed">Borrowed</span>
          <span class="chip learn-fn-chip fn-chromatic">Chromatic</span>
        </div>
      </div>

      <div class="learn-prog-row">
        <div>
          <span class="stat-label">Core Harmonic Loop</span>
          <div class="learn-prog-loop">${escapeHtml(loopStr)}</div>
        </div>
        ${analysis.knownProgression ? `
          <div class="card card-raised learn-known-prog">
            <strong class="learn-known-prog-title">${escapeHtml(analysis.knownProgression.name)}</strong>
            <div class="learn-known-prog-desc">${escapeHtml(analysis.knownProgression.explanation)}</div>
          </div>
        ` : ''}
      </div>

      <div class="chord-timeline-strip" id="learn-chord-strip"></div>
      <div class="chord-inspector" id="learn-chord-inspector"></div>
    `;

    const stripEl = chordsSection.querySelector('#learn-chord-strip');
    const inspectorEl = chordsSection.querySelector('#learn-chord-inspector');

    function getChordVoicingForEntry(entry) {
      const inWindow = playableNotes.filter((n) => n.t >= entry.t - 0.02 && n.t < entry.t + entry.dur - 0.02);
      const byString = new Map();
      for (const n of inWindow) {
        if (!byString.has(n.string)) {
          byString.set(n.string, { string: n.string, fret: n.fret, midi: n.midi });
        }
      }
      if (byString.size >= 3) {
        return Array.from(byString.values()).sort((a, b) => a.string - b.string);
      }
      return deriveStandardVoicing(entry.chord, song.tuning, song.capo);
    }

    function playChordVoicing(voicing) {
      clearScheduledSounds();
      const now = ctx.synth.ctx.currentTime + 0.02;
      voicing.forEach((v, idx) => {
        const midi = v.midi !== undefined ? v.midi : (song.tuning[v.string] + (song.capo || 0) + v.fret);
        ctx.synth.playNote(midi, now + idx * 0.035, 1.3, 0.7);
      });
    }

    function renderChordStripAndInspector(playSound = false) {
      stripEl.innerHTML = analysis.chords.map((entry, idx) => {
        const rn = romanNumeral(entry.chord, analysis.key);
        const fn = harmonicFunction(entry.chord, analysis.key);
        const widthPx = Math.max(88, Math.round(entry.dur * 52));
        return `
          <button type="button" class="chord-block chord-fn-${escapeHtml(fn.role)} ${idx === selectedChordIndex ? 'active' : ''}" data-chord-idx="${idx}" style="width:${widthPx}px;">
            <span class="chord-block-bar">Bar ${entry.bar + 1}</span>
            <strong class="chord-block-name">${escapeHtml(entry.chord.name)}</strong>
            <span class="chord-block-rn">${escapeHtml(rn)}</span>
          </button>
        `;
      }).join('');

      stripEl.querySelectorAll('.chord-block').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await resumeAudio();
          selectedChordIndex = parseInt(btn.dataset.chordIdx, 10);
          renderChordStripAndInspector(true);
        });
      });

      const entry = analysis.chords[selectedChordIndex] || analysis.chords[0];
      const fn = harmonicFunction(entry.chord, analysis.key);
      const rn = romanNumeral(entry.chord, analysis.key);
      const voicing = getChordVoicingForEntry(entry);

      inspectorEl.innerHTML = `
        <div id="learn-chord-diagram-box" class="chord-diagram"></div>
        <div class="learn-inspector-body">
          <div class="learn-inspector-head">
            <h3 class="learn-inspector-title">${escapeHtml(entry.chord.name)} (${escapeHtml(rn)})</h3>
            <span class="chip learn-fn-chip fn-${escapeHtml(fn.role)}">${escapeHtml(fn.role)}</span>
            <button type="button" class="btn btn-sm" id="learn-strum-chord-btn">&#9835; Strum Chord</button>
          </div>
          <p class="learn-chord-desc">${escapeHtml(fn.reason)}</p>
        </div>
      `;

      renderChordDiagram(inspectorEl.querySelector('#learn-chord-diagram-box'), {
        name: entry.chord.name,
        notes: voicing,
        tuning: song.tuning
      });

      inspectorEl.querySelector('#learn-strum-chord-btn')?.addEventListener('click', async () => {
        await resumeAudio();
        playChordVoicing(voicing);
      });

      if (playSound) {
        playChordVoicing(voicing);
      }
    }

    renderChordStripAndInspector(false);
  }

  // --- Section 5 Logic: Learn It In Layers ---
  const layersGrid = container.querySelector('#learn-layers-grid');
  const layerDefs = [
    { level: 1, title: 'Level 1: Roots Only', desc: 'One anchor root note per chord change in a comfortable low position. Locks in harmonic timing.' },
    { level: 2, title: 'Level 2: Bass Line / Roots & 5ths', desc: 'The lowest backbone notes on each beat plus power-chord fifths.' },
    { level: 3, title: 'Level 3: The Full Part', desc: 'Every chord voicing, melody note, and articulation as written.' }
  ];

  layersGrid.innerHTML = layerDefs.map((ld) => {
    const skel = skeletonSong(song, analysis, ld.level);
    const evs = buildEvents(skel);
    return `
      <div class="layer-card">
        <div>
          <div class="learn-layer-head">
            <strong class="learn-layer-title">${escapeHtml(ld.title)}</strong>
            <span class="chip">${skel.notes.length} notes</span>
          </div>
          <p class="learn-layer-desc">${escapeHtml(ld.desc)}</p>
          <div class="layer-mini-highway">
            <canvas id="layer-canvas-${ld.level}"></canvas>
          </div>
        </div>
        <div class="learn-layer-actions">
          <button type="button" class="btn btn-sm listen-layer-btn" data-level="${ld.level}">&#9835; Listen</button>
          <button type="button" class="btn btn-sm btn-primary practise-layer-btn" data-level="${ld.level}">Practise This &rarr;</button>
        </div>
      </div>
    `;
  }).join('');

  layerDefs.forEach((ld) => {
    const skel = skeletonSong(song, analysis, ld.level);
    const evs = buildEvents(skel);
    const canvas = layersGrid.querySelector(`#layer-canvas-${ld.level}`);
    if (canvas) {
      const hw = new Highway(canvas);
      hw.setSong(skel, evs);
      hw.setView({ pxPerSec: 150 });
      hw.render({ tabNow: 0, states: new Uint8Array(evs.length) });
      miniHighways.push(hw);
    }
  });

  layersGrid.querySelectorAll('.listen-layer-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await resumeAudio();
      clearScheduledSounds();
      const lvl = parseInt(btn.dataset.level, 10);
      const skel = skeletonSong(song, analysis, lvl);
      const evs = buildEvents(skel);
      const maxPreviewSec = Math.min(skel.duration, 10);
      const now = ctx.synth.ctx.currentTime + 0.03;

      for (const ev of evs) {
        if (ev.t > maxPreviewSec) break;
        const gain = Math.min(0.8, 0.9 / Math.sqrt(Math.max(1, ev.notes.length)));
        for (const n of ev.notes) {
          ctx.synth.playNote(n.midi, now + ev.t, n.dur, gain);
        }
      }
    });
  });

  layersGrid.querySelectorAll('.practise-layer-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const lvl = parseInt(btn.dataset.level, 10);
      record.level = lvl;
      if (lvl === 1 && (!record.speed || record.speed === 1)) {
        record.speed = 0.7;
      }
      await ctx.saveRecord(record);
      ctx.navigate(`#/song/${record.id}/play`);
    });
  });

  // --- Section 6 Logic: Ear and Theory Drills ("Find the Root") ---
  const drillSection = container.querySelector('#learn-drill-section');

  function renderDrillSection() {
    if (analysis.chords.length === 0) {
      drillSection.innerHTML = `
        <h2 class="serif-heading">6. Ear &amp; Theory Drills</h2>
        <p class="learn-help-line">Ear drills unlock when a song has detectable chords.</p>
      `;
      return;
    }

    const inputLive = ctx.input.state === 'live';

    drillSection.innerHTML = `
      <div class="learn-section-header learn-drill-header">
        <div>
          <h2 class="serif-heading learn-drill-heading">6. Ear &amp; Theory Drill: Find the Root</h2>
          <p class="learn-help-line">
            Woodshed plays one of the song's chords on the synth — find and pluck its root note anywhere on your guitar neck (5 rounds).
          </p>
        </div>
        <div class="learn-toolbar-actions">
          ${!inputLive ? `<button type="button" class="btn btn-sm btn-primary" id="drill-connect-btn">Connect Guitar</button>` : ''}
          <button type="button" class="btn ${drillState.active ? '' : 'btn-primary'}" id="drill-start-btn">
            ${drillState.active ? 'Restart 5-Round Drill' : 'Start 5-Round Drill'}
          </button>
        </div>
      </div>

      ${drillState.active ? `
        <div class="card card-raised learn-drill-box">
          <div>
            <span class="stat-label">Round ${Math.min(drillState.round, drillState.totalRounds)} of ${drillState.totalRounds} · Score: ${drillState.score}/${drillState.totalRounds}</span>
            <div class="learn-drill-prompt" id="drill-prompt-text">
              ${escapeHtml(drillState.feedback || 'Listen to the chord and play its root note on your guitar...')}
            </div>
          </div>
          <div class="learn-toolbar-actions">
            <button type="button" class="btn btn-sm" id="drill-replay-chord-btn">&#9835; Replay Chord</button>
          </div>
        </div>
      ` : ''}
    `;

    drillSection.querySelector('#drill-connect-btn')?.addEventListener('click', async () => {
      try {
        await resumeAudio();
        await ctx.input.start({
          deviceId: ctx.settings.get('inputDeviceId'),
          channel: ctx.settings.get('inputChannel')
        });
        renderDrillSection();
      } catch (err) {
        ctx.toast(err.message, 'error');
      }
    });

    drillSection.querySelector('#drill-start-btn')?.addEventListener('click', async () => {
      await resumeAudio();
      drillState.active = true;
      drillState.round = 0;
      drillState.score = 0;
      nextDrillRound();
    });

    drillSection.querySelector('#drill-replay-chord-btn')?.addEventListener('click', async () => {
      await resumeAudio();
      if (drillState.targetChord) {
        playDrillChord(drillState.targetChord);
      }
    });
  }

  function playDrillChord(chordObj) {
    clearScheduledSounds();
    const voicing = deriveStandardVoicing(chordObj, song.tuning, song.capo);
    const now = ctx.synth.ctx.currentTime + 0.03;
    voicing.forEach((v, i) => {
      ctx.synth.playNote(v.midi, now + i * 0.04, 1.4, 0.75);
    });
  }

  function nextDrillRound() {
    drillState.round++;
    if (drillState.round > drillState.totalRounds) {
      drillState.waitingForPlayer = false;
      drillState.feedback = `Drill Complete! You scored ${drillState.score} / ${drillState.totalRounds}.`;
      renderDrillSection();
      return;
    }

    const uniqueChords = [];
    const seen = new Set();
    for (const c of analysis.chords) {
      if (!seen.has(c.chord.name)) {
        seen.add(c.chord.name);
        uniqueChords.push(c.chord);
      }
    }
    const pool = uniqueChords.length > 0 ? uniqueChords : [{ root: analysis.key.tonic, type: 'min', name: keyName }];
    drillState.targetChord = pool[Math.floor(Math.random() * pool.length)];
    drillState.waitingForPlayer = true;
    drillState.feedback = `Round ${drillState.round}: Mystery chord sounding — play its root note!`;
    renderDrillSection();
    playDrillChord(drillState.targetChord);
  }

  function stepEarDrill() {
    if (drillState.active && drillState.waitingForPlayer && drillState.targetChord) {
      const frame = ctx.input.read();
      if (frame.midi > 0 && frame.clarity >= 0.8) {
        const playedMidi = Math.round(frame.midi);
        const playedPc = ((playedMidi % 12) + 12) % 12;
        const targetPc = ((drillState.targetChord.root % 12) + 12) % 12;
        const judge = judgeNotes(frame.buf, frame.sampleRate, [playedMidi], frame.freq, ctx.settings.get('a4') || 440);

        if (judge.ok && playedPc === targetPc) {
          drillState.waitingForPlayer = false;
          drillState.score++;
          const rootName = spell[targetPc];
          drillState.feedback = `✓ Correct! ${midiToName(playedMidi)} is the root of ${drillState.targetChord.name} (${rootName}).`;
          renderDrillSection();
          scheduleCallback(() => nextDrillRound(), 1400);
        }
      }
    }
    drillRafId = requestAnimationFrame(stepEarDrill);
  }

  renderDrillSection();
  drillRafId = requestAnimationFrame(stepEarDrill);

  return {
    unmount() {
      if (drillRafId) cancelAnimationFrame(drillRafId);
      clearScheduledSounds();
      for (const hw of miniHighways) hw.destroy();
    }
  };
}
