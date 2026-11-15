import { TUNINGS, midiToName } from './song.js';
import { centsOff } from './dsp.js';
import { resumeAudio } from './audio-context.js';

export function mount(container, ctx) {
  const songTuning = ctx.record?.song?.tuning;
  const customPresets = { ...TUNINGS };
  let activePresetName = 'Standard';

  if (songTuning && Array.isArray(songTuning)) {
    const matched = Object.entries(TUNINGS).find(
      ([, arr]) => arr.length === songTuning.length && arr.every((v, i) => v === songTuning[i])
    );
    if (matched) {
      activePresetName = matched[0];
    } else {
      activePresetName = `Current Song (${ctx.record.song.title})`;
      customPresets[activePresetName] = [...songTuning];
    }
  }

  let currentTuning = [...customPresets[activePresetName]];
  let lockedStringIndex = null; // null = auto-select nearest string
  let perStringState = currentTuning.map(() => ({ cents: null, status: 'unmeasured' }));

  const recentFreqs = [];
  let heldReading = null;
  let heldUntilSec = 0;
  let needleAngleCents = 0;
  let needleVelocity = 0;
  let rafId = null;

  function applyTuningRange() {
    const lowest = Math.min(...currentTuning) - 3;
    const highest = Math.max(...currentTuning) + 12;
    ctx.input.setRange(lowest, highest);
    ctx.input.setA4(ctx.settings.get('a4') || 440);
  }

  applyTuningRange();

  const presetOptions = Object.keys(customPresets)
    .map((k) => `<option value="${k}" ${k === activePresetName ? 'selected' : ''}>${k}</option>`)
    .join('');

  container.innerHTML = `
    <div class="tuner-stage">
      <div class="page-title-row" style="margin-bottom:4px;">
        <h1 class="page-title">Chromatic & String Tuner</h1>
        <div style="display:flex;align-items:center;gap:12px;">
          <label style="font-size:0.82rem;color:var(--text-muted);display:flex;align-items:center;gap:6px;">
            Tuning
            <select class="select" id="tuner-preset-select">${presetOptions}</select>
          </label>
          <label style="font-size:0.82rem;color:var(--text-muted);display:flex;align-items:center;gap:6px;">
            A4 = <span id="tuner-a4-label" class="tabular">${ctx.settings.get('a4')}</span> Hz
            <input type="range" class="slider" id="tuner-a4-slider" min="430" max="450" step="1" value="${ctx.settings.get('a4')}" style="width:90px;" />
          </label>
        </div>
      </div>

      <div id="tuner-needs-input" class="card ${ctx.input.state === 'live' ? 'hidden' : ''}" style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <strong style="color:var(--accent);">Guitar Input Needed</strong>
          <p style="margin:4px 0 0;color:var(--text-muted);font-size:0.88rem;">Connect your audio interface or microphone so Woodshed can measure your strings.</p>
        </div>
        <button type="button" class="btn btn-primary" id="tuner-connect-btn">Connect Guitar</button>
      </div>

      <div class="card tuner-gauge-card">
        <svg viewBox="0 0 360 175" style="width:100%;max-width:min(380px, 27vh * 2.05);height:auto;margin:0 auto;display:block;">
          <path d="M 16 172 A 164 164 0 0 1 344 172 L 180 172 Z" fill="none" stroke="none" />
          <path d="M 30 155 A 150 150 0 0 1 330 155" fill="none" stroke="var(--line-strong)" stroke-width="4" stroke-linecap="round" />
          <path d="M 164 5.8 A 150 150 0 0 1 196 5.8" fill="none" stroke="var(--ok)" stroke-opacity="0.6" stroke-width="6" />
          <text x="26" y="172" fill="var(--ink-muted)" font-size="11" font-weight="700" text-anchor="middle">-50c</text>
          <text x="105" y="42" fill="var(--ink-muted)" font-size="10" font-weight="700" text-anchor="middle">-25c</text>
          <text x="180" y="18" fill="var(--ok)" font-size="11" font-weight="800" text-anchor="middle">0</text>
          <text x="255" y="42" fill="var(--ink-muted)" font-size="10" font-weight="700" text-anchor="middle">+25c</text>
          <text x="334" y="172" fill="var(--ink-muted)" font-size="11" font-weight="700" text-anchor="middle">+50c</text>
          <g id="tuner-needle-group" transform="translate(180, 155) rotate(0)">
            <line x1="0" y1="0" x2="0" y2="-132" stroke="var(--fg)" stroke-width="2.5" stroke-linecap="round" id="tuner-needle-line" />
            <circle cx="0" cy="0" r="6" fill="var(--fg)" />
          </g>
        </svg>

        <div class="tuner-note-big is-idle" id="tuner-note-name">&mdash;</div>
        <div class="tabular" id="tuner-hz-cents" style="font-family:var(--font-mono);color:var(--text-muted);font-size:1rem;">Play a string...</div>
        <div id="tuner-direction-hint" style="margin-top:10px;font-weight:700;font-size:0.95rem;min-height:1.4em;color:var(--accent);"></div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <span class="stat-label">Target Strings (Click a string to lock, or click speaker to hear reference tone)</span>
          <button type="button" class="btn btn-sm btn-ghost" id="tuner-auto-btn" disabled>Auto-select is on</button>
        </div>
        <div class="tuner-string-row" id="tuner-strings-container"></div>
      </div>
    </div>
  `;

  const needleGroup = container.querySelector('#tuner-needle-group');
  const needleLine = container.querySelector('#tuner-needle-line');
  const noteNameEl = container.querySelector('#tuner-note-name');
  const hzCentsEl = container.querySelector('#tuner-hz-cents');
  const dirHintEl = container.querySelector('#tuner-direction-hint');
  const stringsContainer = container.querySelector('#tuner-strings-container');
  const autoBtn = container.querySelector('#tuner-auto-btn');
  const needsInputCard = container.querySelector('#tuner-needs-input');

  function renderStringButtons(nearestIdx = null) {
    stringsContainer.innerHTML = currentTuning.map((midi, s) => {
      const name = midiToName(midi);
      const st = perStringState[s];
      const isLocked = lockedStringIndex === s;
      const isNearest = lockedStringIndex === null && nearestIdx === s;
      // Neutral labels (the app no longer colour-codes strings); the locked/nearest string uses the accent.
      const color = isLocked || isNearest ? 'var(--accent)' : 'var(--fg-muted)';

      let badgeText = 'Unchecked';
      let badgeColor = 'var(--text-dim)';
      if (st.cents !== null) {
        const c = Math.round(st.cents);
        if (Math.abs(c) <= 5) {
          badgeText = `In Tune (${c >= 0 ? '+' : ''}${c}c)`;
          badgeColor = 'var(--success)';
        } else if (c < 0) {
          badgeText = `Flat (${c}c)`;
          badgeColor = 'var(--accent)';
        } else {
          badgeText = `Sharp (+${c}c)`;
          badgeColor = 'var(--error)';
        }
      }

      return `
        <div class="string-pill-btn ${isLocked ? 'locked' : ''} ${isNearest ? 'active-nearest' : ''}" data-string-idx="${s}">
          <span style="font-size:0.74rem;color:${color};font-weight:700;">String ${currentTuning.length - s}</span>
          <span style="font-family:var(--font-serif);font-size:1.35rem;font-weight:700;">${name}</span>
          <span class="tabular" style="font-size:0.75rem;color:${badgeColor};">${badgeText}</span>
          <button type="button" class="btn btn-sm btn-ghost play-tone-btn" data-tone-midi="${midi}" style="padding:2px 8px;font-size:0.74rem;margin-top:4px;">
            &#9834; Tone
          </button>
        </div>
      `;
    }).join('');

    stringsContainer.querySelectorAll('.string-pill-btn').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.play-tone-btn')) return;
        const idx = parseInt(el.dataset.stringIdx, 10);
        lockedStringIndex = lockedStringIndex === idx ? null : idx;
        setAutoLabel();
        renderStringButtons();
      });
    });

    stringsContainer.querySelectorAll('.play-tone-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await resumeAudio();
        const midi = parseInt(btn.dataset.toneMidi, 10);
        ctx.synth.playNote(midi, 0, 1.8, 0.85);
      });
    });
  }

  // While auto-select is on the button is just a status; once a string is locked it becomes the way back.
  function setAutoLabel() {
    if (!autoBtn) return;
    const locked = lockedStringIndex !== null;
    autoBtn.textContent = locked ? 'Back to auto-select' : 'Auto-select is on';
    autoBtn.disabled = !locked;
  }

  renderStringButtons();

  autoBtn?.addEventListener('click', () => {
    lockedStringIndex = null;
    setAutoLabel();
    renderStringButtons();
  });

  container.querySelector('#tuner-preset-select')?.addEventListener('change', (e) => {
    const key = e.target.value;
    if (customPresets[key]) {
      currentTuning = [...customPresets[key]];
      lockedStringIndex = null;
      setAutoLabel();
      perStringState = currentTuning.map(() => ({ cents: null, status: 'unmeasured' }));
      applyTuningRange();
      renderStringButtons();
    }
  });

  container.querySelector('#tuner-a4-slider')?.addEventListener('input', (e) => {
    const a4 = parseInt(e.target.value, 10);
    ctx.settings.set('a4', a4);
    ctx.input.setA4(a4);
    container.querySelector('#tuner-a4-label').textContent = String(a4);
  });

  container.querySelector('#tuner-connect-btn')?.addEventListener('click', async () => {
    try {
      await ctx.input.start({
        deviceId: ctx.settings.get('inputDeviceId'),
        channel: ctx.settings.get('inputChannel')
      });
      needsInputCard.classList.add('hidden');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  });

  let lastRenderedNearest = -1;

  function stepTuner() {
    needsInputCard.classList.toggle('hidden', ctx.input.state === 'live');
    const frame = ctx.input.read();
    const a4 = ctx.settings.get('a4') || 440;
    const nowSec = frame.t;

    if (frame.freq > 0 && frame.clarity >= 0.8) {
      recentFreqs.push(frame.freq);
      if (recentFreqs.length > 5) recentFreqs.shift();
      const sorted = [...recentFreqs].sort((a, b) => a - b);
      const medianFreq = sorted[Math.floor(sorted.length / 2)];

      let targetStrIdx = lockedStringIndex;
      if (targetStrIdx === null) {
        let bestDist = Infinity;
        for (let s = 0; s < currentTuning.length; s++) {
          const d = Math.abs(centsOff(medianFreq, currentTuning[s], a4));
          if (d < bestDist) {
            bestDist = d;
            targetStrIdx = s;
          }
        }
      }

      const targetMidi = currentTuning[targetStrIdx];
      const rawCents = centsOff(medianFreq, targetMidi, a4);
      const clampedCents = Math.max(-50, Math.min(50, rawCents));

      perStringState[targetStrIdx] = { cents: rawCents, status: Math.abs(rawCents) <= 5 ? 'ok' : 'out' };

      heldReading = {
        freq: medianFreq,
        targetMidi,
        targetStrIdx,
        rawCents,
        clampedCents
      };
      heldUntilSec = nowSec + 1.2;
    }

    const active = heldReading && nowSec <= heldUntilSec ? heldReading : null;
    const targetCents = active ? active.clampedCents : 0;

    // Critically damped spring easing for needle (-50..+50 cents -> -75..+75 deg)
    const stiffness = 0.22;
    const damping = 0.68;
    const force = (targetCents - needleAngleCents) * stiffness;
    needleVelocity = (needleVelocity + force) * damping;
    needleAngleCents += needleVelocity;

    const angleDeg = (needleAngleCents / 50) * 75;
    needleGroup.setAttribute('transform', `translate(180, 155) rotate(${angleDeg.toFixed(2)})`);

    if (active) {
      const inTune = Math.abs(active.rawCents) <= 5;
      noteNameEl.textContent = midiToName(active.targetMidi);
      noteNameEl.classList.remove('is-idle');
      noteNameEl.classList.toggle('in-tune', inTune);
      needleLine.setAttribute('stroke', inTune ? 'var(--ok)' : 'var(--fg)');

      const cSign = active.rawCents >= 0 ? '+' : '';
      hzCentsEl.textContent = `${active.freq.toFixed(1)} Hz · ${cSign}${Math.round(active.rawCents)} cents`;

      if (inTune) {
        dirHintEl.textContent = '✓ Locked In Tune';
        dirHintEl.style.color = 'var(--success)';
      } else if (active.rawCents < 0) {
        dirHintEl.textContent = '↑ Tune Up (Flat)';
        dirHintEl.style.color = 'var(--accent)';
      } else {
        dirHintEl.textContent = '↓ Tune Down (Sharp)';
        dirHintEl.style.color = 'var(--error)';
      }

      if (lastRenderedNearest !== active.targetStrIdx || frame.clarity >= 0.8) {
        lastRenderedNearest = active.targetStrIdx;
        renderStringButtons(active.targetStrIdx);
      }
    } else {
      noteNameEl.textContent = '—';
      noteNameEl.classList.add('is-idle');
      noteNameEl.classList.remove('in-tune');
      hzCentsEl.textContent = 'Pluck any string...';
      dirHintEl.textContent = '';
    }

    rafId = requestAnimationFrame(stepTuner);
  }

  rafId = requestAnimationFrame(stepTuner);

  return {
    unmount() {
      if (rafId) cancelAnimationFrame(rafId);
    }
  };
}
