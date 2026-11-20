// Play-screen loop range helpers (pure, unit-tested in test/loop-range.test.js).
// Bars are 1-based, as the user sees them.

/** Parse what the user typed into a loop bar box. Returns an integer clamped to 1..totalBars, or null if it isn't a number. */
export function parseBarInput(text, totalBars) {
  const total = Math.max(1, Math.floor(Number(totalBars) || 1));
  const s = String(text ?? '').trim();
  if (!/^[+-]?\d+(\.\d*)?$|^[+-]?\.\d+$/.test(s)) return null;
  const n = Math.round(Number(s));
  if (!Number.isFinite(n)) return null;
  return Math.min(total, Math.max(1, n));
}

/**
 * Clamp a start/end pair into a valid range. The box the user just edited wins:
 * typing a start past the end pulls the end up to it, and typing an end before the start pulls the start down.
 * Missing values fall back to `prev` (or to the other end / the whole song).
 */
export function clampLoopRange(start, end, totalBars, edited = 'start', prev = null) {
  const total = Math.max(1, Math.floor(Number(totalBars) || 1));
  const fix = (v, fallback) => {
    const n = Number.isFinite(v) ? Math.round(v) : fallback;
    return Math.min(total, Math.max(1, n));
  };
  let a = fix(start, prev?.barStart ?? 1);
  let b = fix(end, prev?.barEnd ?? Math.max(a, Math.min(total, a + 3)));
  if (a > b) {
    if (edited === 'end') a = b;
    else b = a;
  }
  return { barStart: a, barEnd: b };
}

/** Loop times in tab seconds for a 1-based bar range, or null if the bars are missing. */
export function loopTimes(bars, barStart, barEnd) {
  const A = bars?.[barStart - 1];
  const B = bars?.[barEnd - 1];
  if (!A || !B) return null;
  return { barStart, barEnd, t0: A.t, t1: B.t + B.dur };
}

/** A sensible first range when the user turns the loop on without typing one: the current bar plus the next three. */
export function defaultLoopRange(currentBar, totalBars) {
  return clampLoopRange(currentBar, currentBar + 3, totalBars, 'start');
}
