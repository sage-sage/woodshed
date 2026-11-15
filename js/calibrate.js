import { resumeAudio } from './audio-context.js';

let calibrating = false;

export async function runCalibration({ input, synth, settings, onStatus }) {
  if (calibrating) {
    return { ok: false, count: 0, busy: true };
  }

  await resumeAudio();
  if (input.state !== 'live') {
    await input.start({
      deviceId: settings.get('inputDeviceId'),
      channel: settings.get('inputChannel')
    });
  }

  calibrating = true;
  const report = (text) => {
    if (typeof onStatus === 'function') onStatus(text);
  };

  const clickIntervalSec = 0.65;
  const baseNow = performance.now() / 1000 + 0.4;
  const clickTimes = [];

  for (let i = 0; i < 8; i++) {
    const clickWall = baseNow + i * clickIntervalSec;
    clickTimes.push(clickWall);
    synth.playClick(synth.ctx.currentTime + 0.4 + i * clickIntervalSec, i === 0, 0.65);
  }

  const offsetsMs = [];
  const matchedClicks = new Set();

  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const r = input.read();
      const idx = Math.min(8, Math.max(1, Math.ceil((r.t - baseNow) / clickIntervalSec) + 1));
      report(`Listening... Click ${idx} of 8 (Pluck muted string with each click)`);

      if (r.onset) {
        for (let c = 0; c < clickTimes.length; c++) {
          if (matchedClicks.has(c)) continue;
          const diffSec = r.t - clickTimes[c];
          if (diffSec >= -0.05 && diffSec <= 0.24) {
            matchedClicks.add(c);
            offsetsMs.push(Math.max(0, Math.round(diffSec * 1000)));
            break;
          }
        }
      }
    }, 12);

    setTimeout(() => {
      clearInterval(checkInterval);
      calibrating = false;
      if (offsetsMs.length >= 3) {
        offsetsMs.sort((a, b) => a - b);
        const median = offsetsMs[Math.floor(offsetsMs.length / 2)];
        const clamped = Math.max(0, Math.min(200, median));
        settings.set('latencyMs', clamped);
        report(`Calibrated! Median offset across ${offsetsMs.length} plucks: ${clamped} ms.`);
        resolve({ ok: true, ms: clamped, count: offsetsMs.length });
      } else {
        report('Too few plucks detected. Pluck louder along with the 8 clicks.');
        resolve({ ok: false, count: offsetsMs.length });
      }
    }, Math.round((0.4 + 8 * clickIntervalSec + 0.35) * 1000));
  });
}
