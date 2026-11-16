import { resumeAudio } from './audio-context.js';
import { GuitarInput } from './audio-input.js';
import { midiToName } from './song.js';
import { runCalibration } from './calibrate.js';
import { isDesktop, desktop, postToHost, SETUP_URL } from './desktop.js';

const STEPS = ['Connect', 'Level', 'Calibrate', 'Tune'];

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function mount(container, ctx) {
  const { input, synth, settings, navigate, toast } = ctx;
  let step = 0;
  let calibrated = false;
  let rafId = null;
  const timers = new Set();

  let peakHold = 0;
  let lastFrameTime = performance.now();
  const recentPeaks = [];

  container.innerHTML = `
    <div class="setup-shell">
      <div class="setup-head">
        <div>
          <h1 class="setup-title">Set up your guitar</h1>
          <p class="setup-subtitle">Four quick steps. You can redo this any time from Settings.</p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="setup-skip">Skip setup</button>
      </div>

      <div class="setup-pills" id="setup-pills"></div>

      <section class="setup-panel" id="setup-panel">
        <div class="setup-step" data-step="0">
          <div class="setup-amp" id="setup-amp">
            <div class="setup-amp-text">
              <strong class="setup-amp-title">Recommended: Woodshed Amp</strong>
              <p class="setup-amp-body">The partner app "Woodshed Amp" is highly recommended. It allows Woodshed to listen to your guitar with ultra-low latency, and lets you hear your own playing with preset or custom sounds.</p>
              <p class="setup-status" id="setup-amp-status"></p>
            </div>
            <a class="btn btn-primary" id="setup-amp-dl" href="${SETUP_URL}">Download Woodshed Setup</a>
            <button type="button" class="btn btn-primary" id="setup-amp-start" hidden>Start Woodshed Amp</button>
          </div>
          <p class="setup-body">Plug your guitar into input 1 of your audio interface (on a MOTU M2: input 1, with its gain at about noon). If Woodshed Amp is running, Woodshed uses it automatically.</p>
          <div class="setup-fields">
            <label class="setup-field">
              <span class="setup-label">Input device</span>
              <select class="select" id="setup-device"></select>
            </label>
            <label class="setup-field">
              <span class="setup-label">Channel</span>
              <select class="select" id="setup-channel">
                <option value="mix">Mix (L+R)</option>
                <option value="left">Left (Input 1)</option>
                <option value="right">Right (Input 2)</option>
              </select>
            </label>
          </div>
          <div class="setup-action-row">
            <button type="button" class="btn btn-primary" id="setup-connect-btn">Connect</button>
            <span class="setup-status" id="setup-connect-status"></span>
          </div>
        </div>

        <div class="setup-step" data-step="1" hidden>
          <p class="setup-body">Strum hard. The peak should land in the green zone. Turn the interface gain down if it reaches the end, up if it stays low.</p>
          <div class="setup-meter-wrap">
            <div class="meter-track setup-meter-track">
              <div class="setup-meter-zone"></div>
              <div class="meter-fill setup-meter-fill" id="setup-meter-fill"></div>
              <div class="setup-meter-peak" id="setup-meter-peak"></div>
            </div>
            <div class="setup-note-box">
              <span class="setup-label">Detected note</span>
              <strong class="setup-note-val" id="setup-note-val">—</strong>
            </div>
          </div>
          <p class="setup-status" id="setup-level-verdict">Too quiet</p>
        </div>

        <div class="setup-step" data-step="2" hidden>
          <p class="setup-body">Mute the strings with your fretting hand and pick once on each of 8 clicks.</p>
          <div class="setup-action-row">
            <button type="button" class="btn btn-primary" id="setup-cal-btn">Start calibration</button>
            <span class="setup-status" id="setup-cal-status"></span>
          </div>
        </div>

        <div class="setup-step" data-step="3" hidden>
          <p class="setup-body">Tune all six strings before you play.</p>
          <div class="setup-action-row">
            <button type="button" class="btn" id="setup-tuner-btn">Open Tuner</button>
          </div>
        </div>

        <div class="setup-footer">
          <button type="button" class="btn btn-ghost" id="setup-back-btn">Back</button>
          <button type="button" class="btn btn-primary" id="setup-next-btn">Next</button>
        </div>
      </section>
    </div>
  `;

  const pillsEl = container.querySelector('#setup-pills');
  const stepEls = Array.from(container.querySelectorAll('.setup-step'));
  const deviceSelect = container.querySelector('#setup-device');
  const channelSelect = container.querySelector('#setup-channel');
  const connectBtn = container.querySelector('#setup-connect-btn');
  const connectStatus = container.querySelector('#setup-connect-status');
  const meterFill = container.querySelector('#setup-meter-fill');
  const meterPeak = container.querySelector('#setup-meter-peak');
  const noteVal = container.querySelector('#setup-note-val');
  const levelVerdict = container.querySelector('#setup-level-verdict');
  const calBtn = container.querySelector('#setup-cal-btn');
  const calStatus = container.querySelector('#setup-cal-status');
  const backBtn = container.querySelector('#setup-back-btn');
  const nextBtn = container.querySelector('#setup-next-btn');

  function setStatus(el, text, kind = '') {
    if (!el) return;
    el.textContent = text;
    el.className = kind ? `setup-status is-${kind}` : 'setup-status';
  }

  async function refreshDevices() {
    try {
      const devices = await GuitarInput.listDevices();
      const savedId = settings.get('inputDeviceId') || '';
      const opts = ['<option value="">Default input device</option>'];
      for (const d of devices) {
        const id = d.deviceId || '';
        const label = d.label || id || 'Audio Input';
        opts.push(`<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`);
      }
      deviceSelect.innerHTML = opts.join('');
      deviceSelect.value = savedId;
    } catch (_) {
      deviceSelect.innerHTML = '<option value="">Default input device</option>';
    }
  }

  const ampBox = container.querySelector('#setup-amp');
  const ampStatus = container.querySelector('#setup-amp-status');
  const ampDl = container.querySelector('#setup-amp-dl');
  const ampStart = container.querySelector('#setup-amp-start');
  ampStart.addEventListener('click', () => {
    postToHost({ type: 'launch-amp' });
    setStatus(ampStatus, 'Starting Woodshed Amp...');
  });
  function syncAmpBox() {
    const online = ctx.amp?.state === 'online';
    const installedHere = isDesktop && desktop.ampInstalled;
    ampBox.classList.toggle('is-online', online);
    ampDl.hidden = online || installedHere;
    ampStart.hidden = online || !installedHere;
    let text;
    if (online) text = 'Woodshed Amp is running and connected.';
    else if (installedHere) text = 'Woodshed Amp is installed but not running.';
    else if (isDesktop) text = 'Run Woodshed Setup again and tick Woodshed Amp. This app connects to it by itself.';
    else text = 'Run Woodshed Setup and tick Woodshed Amp (you can skip the app). This page connects to it by itself, and it keeps itself up to date.';
    setStatus(ampStatus, text, online ? 'good' : '');
  }
  ctx.amp?.addEventListener('state', syncAmpBox);
  syncAmpBox();

  channelSelect.value = settings.get('inputChannel') || 'mix';
  refreshDevices();

  if (input.state === 'live') {
    setStatus(connectStatus, 'Connected', 'good');
  }

  function syncStepUI() {
    pillsEl.innerHTML = STEPS.map((label, idx) => {
      const cls = idx < step ? 'step-pill done' : idx === step ? 'step-pill active' : 'step-pill';
      return `<div class="${cls}"><span class="step-num">${idx + 1}</span> ${label}</div>`;
    }).join('');

    stepEls.forEach((el, idx) => {
      el.hidden = idx !== step;
    });

    backBtn.disabled = step === 0;

    if (step === 3) {
      nextBtn.hidden = false;
      nextBtn.textContent = 'Finish';
      nextBtn.disabled = false;
    } else {
      nextBtn.hidden = false;
      if (step === 0) {
        nextBtn.textContent = 'Next';
        nextBtn.disabled = input.state !== 'live';
      } else if (step === 2) {
        nextBtn.textContent = calibrated ? 'Next' : 'Skip';
        nextBtn.disabled = false;
      } else {
        nextBtn.textContent = 'Next';
        nextBtn.disabled = false;
      }
    }
  }

  syncStepUI();

  async function connectInput() {
    connectBtn.disabled = true;
    connectBtn.setAttribute('aria-busy', 'true');
    try {
      await resumeAudio();
      await input.start({
        deviceId: settings.get('inputDeviceId'),
        channel: settings.get('inputChannel')
      });
      await refreshDevices();
      setStatus(connectStatus, 'Connected', 'good');
    } catch (err) {
      setStatus(connectStatus, err && err.message ? err.message : 'Could not connect audio input.', 'bad');
    } finally {
      connectBtn.disabled = false;
      connectBtn.removeAttribute('aria-busy');
      syncStepUI();
    }
  }

  deviceSelect.addEventListener('change', async () => {
    settings.set('inputDeviceId', deviceSelect.value);
    if (input.state === 'live') {
      await connectInput();
    }
  });

  channelSelect.addEventListener('change', async () => {
    settings.set('inputChannel', channelSelect.value);
    if (input.state === 'live') {
      await connectInput();
    }
  });

  connectBtn.addEventListener('click', connectInput);

  calBtn.addEventListener('click', async () => {
    if (calBtn.getAttribute('aria-busy') === 'true') return;
    calBtn.disabled = true;
    calBtn.setAttribute('aria-busy', 'true');
    try {
      const res = await runCalibration({
        input,
        synth,
        settings,
        onStatus: (text) => setStatus(calStatus, text)
      });
      if (res.busy) return;
      if (res.ok) {
        calibrated = true;
        setStatus(calStatus, `Latency set to ${res.ms} ms`, 'good');
        calBtn.textContent = 'Start calibration';
      } else {
        setStatus(calStatus, 'Too few plucks detected. Pluck louder along with the 8 clicks.', 'bad');
        calBtn.textContent = 'Try again';
      }
    } catch (err) {
      setStatus(calStatus, err && err.message ? err.message : 'Could not start audio input.', 'bad');
      calBtn.textContent = 'Try again';
    } finally {
      calBtn.disabled = false;
      calBtn.removeAttribute('aria-busy');
      syncStepUI();
    }
  });

  container.querySelector('#setup-tuner-btn')?.addEventListener('click', () => {
    settings.set('setupDone', true);
    navigate('#/tuner');
  });

  function finishSetup() {
    settings.set('setupDone', true);
    toast('Setup done. Pick a song and press Play.', 'success');
    navigate('#/library');
  }

  container.querySelector('#setup-skip')?.addEventListener('click', () => {
    settings.set('setupDone', true);
    navigate('#/library');
  });

  backBtn.addEventListener('click', () => {
    if (step > 0) {
      step -= 1;
      syncStepUI();
    }
  });

  nextBtn.addEventListener('click', () => {
    if (step === 0 && input.state !== 'live') return;
    if (step < STEPS.length - 1) {
      step += 1;
      if (step === 1) {
        peakHold = 0;
        recentPeaks.length = 0;
        lastFrameTime = performance.now();
      }
      syncStepUI();
    } else {
      finishSetup();
    }
  });

  function tick(now) {
    const dtSec = Math.max(0, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    if (step === 1) {
      const r = input.read();
      const lvl = Math.max(0, Math.min(1, r.level || 0));

      if (lvl >= peakHold) {
        peakHold = lvl;
      } else {
        peakHold = Math.max(lvl, peakHold - dtSec / 1.5);
      }

      if (meterFill) meterFill.style.width = `${Math.round(lvl * 100)}%`;
      if (meterPeak) meterPeak.style.left = `${Math.round(peakHold * 100)}%`;

      if (noteVal) {
        noteVal.textContent = r.clarity >= 0.8 && Number.isFinite(r.midi) && r.midi > 0
          ? midiToName(Math.round(r.midi))
          : '—';
      }

      recentPeaks.push({ t: now, lvl });
      while (recentPeaks.length > 0 && now - recentPeaks[0].t > 3000) {
        recentPeaks.shift();
      }
      let max3s = 0;
      for (const p of recentPeaks) {
        if (p.lvl > max3s) max3s = p.lvl;
      }

      if (max3s < 0.25) {
        setStatus(levelVerdict, 'Too quiet');
      } else if (max3s < 0.55) {
        setStatus(levelVerdict, 'A bit low');
      } else if (max3s <= 0.9) {
        setStatus(levelVerdict, 'Good level', 'good');
      } else {
        setStatus(levelVerdict, 'Too hot', 'bad');
      }
    }

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  return {
    unmount() {
      ctx.amp?.removeEventListener('state', syncAmpBox);
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      for (const id of timers) {
        clearTimeout(id);
      }
      timers.clear();
    }
  };
}
