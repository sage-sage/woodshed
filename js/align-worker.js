import { alignTab } from './align.js';

self.onmessage = (e) => {
  try {
    const { song, samples, startSec } = e.data || {};
    let lastReported = -1;
    const result = alignTab(song, samples, {
      startSec,
      onProgress(p) {
        const clamped = Math.max(0, Math.min(1, Number(p) || 0));
        if (clamped - lastReported >= 0.04 || clamped === 1) {
          lastReported = clamped;
          self.postMessage({ progress: clamped });
        }
      }
    });
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: err?.message || String(err) });
  }
};
