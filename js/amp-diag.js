/**
 * Audio glitch readout: a small corner panel with Woodshed Amp's glitch counters (interface over/underruns,
 * guide gaps, dropped stream audio) and what the page itself does with audio. Turned on in Settings > Woodshed
 * Amp ("Show glitch counters"), so a player who hears static can watch whether a counter moves when it happens.
 */

const COUNTERS = [
  // [key, label, read(status), meaning]
  ['xruns', 'Interface xruns', (st) => st.xruns, 'The interface ran out of time (ASIO over/underrun).'],
  ['guide', 'Guide gaps', (st) => st.guide?.underruns, 'The guide guitar ran dry at the amp (the page sent it too late).'],
  ['drops', 'Stream drops', (st) => st.streamDrops, 'Guitar audio the amp could not send to the page.'],
  ['monitor', 'Monitor gaps', (st) => st.monitorUnderruns, 'The "Also play through" output ran dry.']
];
const FLASH_MS = 4000;

export function startAmpDiag({ amp, settings, getRouteDiag, audioCtx }) {
  let el = null;
  let base = null;            // counter values when the panel was opened (shown as "+n since")
  const lastValue = {};
  const flashUntil = {};
  let presetMsgs = [];        // times of recent presets messages (a loop shows up as a high rate)

  const onPresets = () => {
    const now = performance.now();
    presetMsgs.push(now);
    presetMsgs = presetMsgs.filter((t) => now - t < 5000);
  };

  function ensureEl() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'amp-diag';
    el.setAttribute('role', 'status');
    el.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:9999', 'max-width:min(320px,calc(100vw - 24px))',
      'padding:8px 10px', 'border-radius:8px', 'font:12px/1.45 ui-monospace,Consolas,monospace',
      'background:var(--panel,#1d1f24)', 'color:var(--fg,#e8e6e3)', 'border:1px solid var(--line-strong,#3a3d44)',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)', 'pointer-events:auto'
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  function render() {
    if (!el) return;
    const st = amp.status;
    const now = performance.now();
    const rows = [];
    if (!st || amp.state !== 'online') {
      rows.push('<b>Woodshed Amp</b> not connected');
    } else {
      if (!base) {
        base = {};
        for (const [key, , read] of COUNTERS) base[key] = Number(read(st)) || 0;
      }
      rows.push(`<b>Amp</b> ${st.running ? `${st.sampleRate} Hz · ${st.bufferFrames} smp · CPU ${Math.round((st.cpu || 0) * 100)}%` : 'interface not running'}`);
      for (const [key, label, read, meaning] of COUNTERS) {
        const v = Number(read(st)) || 0;
        if (lastValue[key] !== undefined && v > lastValue[key]) flashUntil[key] = now + FLASH_MS;
        lastValue[key] = v;
        const hot = (flashUntil[key] || 0) > now;
        const since = v - (base[key] || 0);
        rows.push(`<span title="${meaning}" style="${hot ? 'color:var(--bad,#ff6b5e);font-weight:700' : ''}">${label}: ${v}${since > 0 ? ` (+${since} since opened)` : ''}</span>`);
      }
      const g = st.guide || {};
      rows.push(`Guide: ${g.active ? `on, ${Math.round(g.bufferedMs || 0)} ms buffered` : 'off'}`);
    }
    const rd = getRouteDiag?.() || {};
    const rate = presetMsgs.filter((t) => now - t < 5000).length / 5;
    rows.push(`Page audio: ${audioCtx?.state || '?'}${audioCtx?.sampleRate ? ` ${audioCtx.sampleRate} Hz` : ''} · computer output ${rd.systemOutput || 'on'}${rd.ctxRecoveries ? ` · restarted ${rd.ctxRecoveries}x` : ''}`);
    if (rate > 2) rows.push(`<span style="color:var(--bad,#ff6b5e)">Preset messages: ${rate.toFixed(0)}/s (a loop)</span>`);
    el.innerHTML = rows.join('<br>');
  }

  function sync() {
    const on = Boolean(settings.get('ampDiag'));
    if (on && !el) {
      ensureEl();
      base = null;
      render();
    } else if (!on && el) {
      el.remove();
      el = null;
    }
  }

  amp.addEventListener('status', render);
  amp.addEventListener('state', render);
  amp.addEventListener('presets', onPresets);
  window.addEventListener('woodshed:settings-changed', sync);
  settings.onChange?.((key) => { if (key === 'ampDiag') sync(); });
  sync();
}
