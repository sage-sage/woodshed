// Tuner reading settler.
// Muting a string makes its pitch jump (usually up) for the last few frames before the sound stops. A plain
// tuner then holds that jumped value, so a correctly tuned string reads sharp. This keeps a short history of
// pitched frames and, when the note ends, rolls the held reading back to before the mute:
// - frames during a fast level drop (a mute, not the slow natural decay) never update the reading;
// - when the signal stops, the final reading is the median of the frames from `windowSec` to `guardSec`
//   before the last pitched frame.

export function createTunerSettler({ minClarity = 0.8, guardSec = 0.15, windowSec = 0.7, liveFrames = 5, dropRatio = 0.5, dropSec = 0.08 } = {}) {
  let hist = []; // {t, freq, rms, decaying}
  let live = null;
  let wasActive = false;

  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  function rmsAt(t) {
    // Level of the newest frame at or before t.
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i].t <= t) return hist[i].rms;
    return null;
  }

  return {
    /** frame: {t (s), freq, clarity, rms}. Returns {freq, final} to show, or null when there is nothing new. */
    push(frame) {
      const pitched = frame.freq > 0 && frame.clarity >= minClarity;
      if (pitched) {
        const before = rmsAt(frame.t - dropSec);
        const rms = Number.isFinite(frame.rms) ? frame.rms : 0;
        const decaying = before != null && rms > 0 && rms < before * dropRatio;
        hist.push({ t: frame.t, freq: frame.freq, rms, decaying });
        while (hist.length && hist[0].t < frame.t - 2) hist.shift();
        wasActive = true;
        if (decaying) return live ? { freq: live, final: false } : null;
        const recent = hist.filter((h) => !h.decaying).slice(-liveFrames).map((h) => h.freq);
        live = median(recent);
        return { freq: live, final: false };
      }
      if (!wasActive) return null;
      // The note just ended: settle on what the string read before the mute.
      wasActive = false;
      const lastT = hist.length ? hist[hist.length - 1].t : frame.t;
      const steady = hist.filter((h) => !h.decaying && h.t >= lastT - windowSec && h.t <= lastT - guardSec).map((h) => h.freq);
      const settled = median(steady) ?? live;
      hist = [];
      live = null;
      return settled ? { freq: settled, final: true } : null;
    },
    reset() { hist = []; live = null; wasActive = false; }
  };
}
