import { tabToAudio } from './sync.js';
export const HOP = 1024;
export const WIN = 4096;
export const SR = 22050;

const HANN = (() => {
  const w = new Float32Array(WIN);
  const scale = (2 * Math.PI) / (WIN - 1);
  for (let n = 0; n < WIN; n++) {
    w[n] = 0.5 * (1 - Math.cos(scale * n));
  }
  return w;
})();

export function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;

  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wStepRe = Math.cos(ang);
    const wStepIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k++) {
        const evenIdx = i + k;
        const oddIdx = evenIdx + half;
        const oddRe = re[oddIdx] * wRe - im[oddIdx] * wIm;
        const oddIm = re[oddIdx] * wIm + im[oddIdx] * wRe;
        re[oddIdx] = re[evenIdx] - oddRe;
        im[oddIdx] = im[evenIdx] - oddIm;
        re[evenIdx] += oddRe;
        im[evenIdx] += oddIm;
        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        wIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
      }
    }
  }
}

function l2NormalizeChroma(chroma, frames) {
  for (let f = 0; f < frames; f++) {
    const base = f * 12;
    let sumSq = 0;
    for (let c = 0; c < 12; c++) {
      const v = chroma[base + c];
      sumSq += v * v;
    }
    if (sumSq > 1e-12) {
      const inv = 1 / Math.sqrt(sumSq);
      for (let c = 0; c < 12; c++) {
        chroma[base + c] *= inv;
      }
    } else {
      for (let c = 0; c < 12; c++) {
        chroma[base + c] = 0;
      }
    }
  }
}

function normalizeOnset(onset) {
  const n = onset.length;
  if (n === 0) return onset;
  const sorted = Float32Array.from(onset).sort();
  let p95 = sorted[Math.floor(0.95 * (n - 1))];
  if (p95 <= 1e-12) {
    p95 = sorted[n - 1];
  }
  if (p95 > 1e-12) {
    for (let i = 0; i < n; i++) {
      const v = onset[i] / p95;
      onset[i] = v < 0 ? 0 : v > 1.5 ? 1.5 : v;
    }
  }
  return onset;
}

export function audioFeatures(samples) {
  const len = samples ? samples.length : 0;
  const frames = Math.max(1, Math.ceil(len / HOP));
  const chroma = new Float32Array(frames * 12);
  const onset = new Float32Array(frames);

  const halfBins = (WIN >> 1) + 1;
  const binPc = new Int8Array(halfBins);
  binPc.fill(-1);
  for (let k = 1; k < halfBins; k++) {
    const f = (k * SR) / WIN;
    if (f >= 65 && f <= 2100) {
      const midi = Math.round(12 * Math.log2(f / 440) + 69);
      binPc[k] = ((midi % 12) + 12) % 12;
    }
  }

  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  const prevLogMag = new Float64Array(halfBins);
  const halfWin = WIN >> 1;

  for (let t = 0; t < frames; t++) {
    const start = t * HOP - halfWin;
    for (let n = 0; n < WIN; n++) {
      const idx = start + n;
      re[n] = idx >= 0 && idx < len ? samples[idx] * HANN[n] : 0;
      im[n] = 0;
    }

    fft(re, im);

    const base = t * 12;
    let flux = 0;
    for (let k = 0; k < halfBins; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const logMag = Math.log(1 + 100 * mag);
      if (t > 0) {
        const diff = logMag - prevLogMag[k];
        if (diff > 0) flux += diff;
      }
      prevLogMag[k] = logMag;

      const pc = binPc[k];
      if (pc >= 0) {
        chroma[base + pc] += logMag;
      }
    }
    onset[t] = flux;
  }

  // The 4096-sample window spots an attack up to ~90 ms early; a short window times attacks within ~20 ms,
  // which is what the final onset alignment (bestOnsetLag) relies on.
  shortWindowOnset(samples, onset);

  l2NormalizeChroma(chroma, frames);
  normalizeOnset(onset);

  return { chroma, onset, frames };
}

const ONSET_WIN = 1024;
const ONSET_HANN = (() => {
  const w = new Float64Array(ONSET_WIN);
  for (let n = 0; n < ONSET_WIN; n++) w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (ONSET_WIN - 1));
  return w;
})();

/** Spectral flux with a short window centred on each hop; overwrites onset[]. */
function shortWindowOnset(samples, onset) {
  const len = samples ? samples.length : 0;
  const half = ONSET_WIN >> 1;
  const bins = half + 1;
  const re = new Float64Array(ONSET_WIN);
  const im = new Float64Array(ONSET_WIN);
  const prev = new Float64Array(bins);
  for (let t = 0; t < onset.length; t++) {
    const start = t * HOP - half;
    for (let n = 0; n < ONSET_WIN; n++) {
      const idx = start + n;
      re[n] = idx >= 0 && idx < len ? samples[idx] * ONSET_HANN[n] : 0;
      im[n] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      const logMag = Math.log(1 + 100 * Math.hypot(re[k], im[k]));
      if (t > 0 && logMag > prev[k]) flux += logMag - prev[k];
      prev[k] = logMag;
    }
    onset[t] = flux;
  }
}

export function tabFeatures(song) {
  const hopSec = HOP / SR;
  const notes = Array.isArray(song?.notes) ? song.notes : [];
  let duration = Number(song?.duration) || 0;
  if (duration <= 0 && notes.length > 0) {
    for (const n of notes) {
      const end = (Number(n.t) || 0) + (Number(n.dur) || 0);
      if (end > duration) duration = end;
    }
  }

  const frames = Math.max(1, Math.ceil((duration * SR) / HOP) + 1);
  const chroma = new Float32Array(frames * 12);
  const rawOnset = new Float32Array(frames);

  for (const note of notes) {
    const midi = Number(note.midi);
    const t = Number(note.t);
    const dur = Number(note.dur) || 0;
    if (!Number.isFinite(midi) || !Number.isFinite(t)) continue;

    const startFrame = Math.max(0, Math.round(t / hopSec));
    if (startFrame < frames) {
      rawOnset[startFrame] += 1;
    }

    const maxElapsed = Math.max(dur, 0.15) + 0.4;
    const mRound = Math.round(midi);
    const pcFund = ((mRound % 12) + 12) % 12;
    const pcFifth = (((mRound + 7) % 12) + 12) % 12;

    for (let f = startFrame; f < frames; f++) {
      const elapsed = Math.max(0, f * hopSec - t);
      if (elapsed >= maxElapsed) break;
      const w = Math.exp(-elapsed / 0.35);
      const base = f * 12;
      chroma[base + pcFund] += w;
      chroma[base + pcFifth] += 0.3 * w;
    }
  }

  const kernel = [0.25, 0.5, 1, 0.5, 0.25];
  const onset = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let k = -2; k <= 2; k++) {
      const idx = f + k;
      if (idx >= 0 && idx < frames) {
        acc += rawOnset[idx] * kernel[k + 2];
      }
    }
    onset[f] = acc;
  }

  normalizeOnset(onset);
  l2NormalizeChroma(chroma, frames);

  return { chroma, onset, frames };
}

function downsampleBy2(feat) {
  const newFrames = Math.max(1, Math.ceil(feat.frames / 2));
  const chroma = new Float32Array(newFrames * 12);
  const onset = new Float32Array(newFrames);
  for (let i = 0; i < newFrames; i++) {
    const f0 = i * 2;
    const f1 = Math.min(feat.frames - 1, f0 + 1);
    const count = f1 === f0 ? 1 : 2;
    onset[i] = (feat.onset[f0] + (count === 2 ? feat.onset[f1] : 0)) / count;
    const dstBase = i * 12;
    const src0 = f0 * 12;
    const src1 = f1 * 12;
    for (let c = 0; c < 12; c++) {
      chroma[dstBase + c] = (feat.chroma[src0 + c] + (count === 2 ? feat.chroma[src1 + c] : 0)) / count;
    }
  }
  l2NormalizeChroma(chroma, newFrames);
  return { chroma, onset, frames: newFrames };
}

// Off-diagonal steps (speeding up / slowing down) cost a little extra, so the path keeps a steady tempo
// through repeated riffs instead of wandering between look-alike bars.
const TEMPO_CHANGE_PENALTY = 0.15;

export function subsequenceDTW(tab, audio, { startFrame = 0, onProgress } = {}) {
  const origM = tab.frames;
  const origN = audio.frames;
  if (origM <= 0 || origN <= 0) {
    return { path: [], cost: 1, startAudio: 0, endAudio: 0 };
  }

  let curTab = tab;
  let curAudio = audio;
  let scale = 1;
  let sFrame = Math.max(0, Math.min(origN - 1, Math.floor(startFrame)));

  while (curTab.frames * curAudio.frames > 60e6) {
    curTab = downsampleBy2(curTab);
    curAudio = downsampleBy2(curAudio);
    scale *= 2;
    sFrame = Math.min(curAudio.frames - 1, Math.floor(sFrame / 2));
  }

  const M = curTab.frames;
  const N = curAudio.frames;
  const tChroma = curTab.chroma;
  const aChroma = curAudio.chroma;
  const tOnset = curTab.onset;
  const aOnset = curAudio.onset;

  const tZero = new Uint8Array(M);
  for (let j = 0; j < M; j++) {
    const base = j * 12;
    let sumSq = 0;
    for (let c = 0; c < 12; c++) sumSq += tChroma[base + c] * tChroma[base + c];
    if (sumSq <= 1e-12) tZero[j] = 1;
  }

  const aZero = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const base = i * 12;
    let sumSq = 0;
    for (let c = 0; c < 12; c++) sumSq += aChroma[base + c] * aChroma[base + c];
    if (sumSq <= 1e-12) aZero[i] = 1;
  }

  function cellCost(j, i) {
    let dot;
    if (tZero[j] || aZero[i]) {
      dot = 0.5;
    } else {
      const jb = j * 12;
      const ib = i * 12;
      dot =
        tChroma[jb] * aChroma[ib] +
        tChroma[jb + 1] * aChroma[ib + 1] +
        tChroma[jb + 2] * aChroma[ib + 2] +
        tChroma[jb + 3] * aChroma[ib + 3] +
        tChroma[jb + 4] * aChroma[ib + 4] +
        tChroma[jb + 5] * aChroma[ib + 5] +
        tChroma[jb + 6] * aChroma[ib + 6] +
        tChroma[jb + 7] * aChroma[ib + 7] +
        tChroma[jb + 8] * aChroma[ib + 8] +
        tChroma[jb + 9] * aChroma[ib + 9] +
        tChroma[jb + 10] * aChroma[ib + 10] +
        tChroma[jb + 11] * aChroma[ib + 11];
    }
    return (1 - dot) + 0.35 * Math.abs(tOnset[j] - aOnset[i]);
  }

  let rowPrev2 = new Float64Array(N);
  let rowPrev1 = new Float64Array(N);
  let rowCurr = new Float64Array(N);
  rowPrev2.fill(Infinity);
  rowPrev1.fill(Infinity);

  const steps = new Uint8Array(M * N);

  for (let i = sFrame; i < N; i++) {
    rowPrev1[i] = cellCost(0, i);
  }

  const reportStep = Math.max(1, Math.floor(M / 25));
  if (typeof onProgress === 'function') onProgress(0);

  for (let j = 1; j < M; j++) {
    rowCurr.fill(Infinity);
    const rowOffset = j * N;
    for (let i = sFrame; i < N; i++) {
      const c = cellCost(j, i);
      let best = Infinity;
      let step = 0;

      if (i - 1 >= sFrame) {
        const v1 = rowPrev1[i - 1] + c;
        if (v1 < best) {
          best = v1;
          step = 1;
        }
      }
      if (i - 2 >= sFrame) {
        const v2 = rowPrev1[i - 2] + c + TEMPO_CHANGE_PENALTY;
        if (v2 < best) {
          best = v2;
          step = 2;
        }
      }
      if (j >= 2 && i - 1 >= sFrame) {
        const v3 = rowPrev2[i - 1] + 2 * c + TEMPO_CHANGE_PENALTY;
        if (v3 < best) {
          best = v3;
          step = 3;
        }
      }

      rowCurr[i] = best;
      steps[rowOffset + i] = step;
    }

    if (typeof onProgress === 'function' && (j % reportStep === 0 || j === M - 1)) {
      onProgress(j / Math.max(1, M - 1));
    }

    const tmp = rowPrev2;
    rowPrev2 = rowPrev1;
    rowPrev1 = rowCurr;
    rowCurr = tmp;
  }

  let endI = sFrame;
  let bestEnd = Infinity;
  for (let i = sFrame; i < N; i++) {
    if (rowPrev1[i] < bestEnd) {
      bestEnd = rowPrev1[i];
      endI = i;
    }
  }

  if (!Number.isFinite(bestEnd)) {
    endI = sFrame;
    bestEnd = cellCost(M - 1, sFrame) * M;
  }

  const rawPath = [];
  let j = M - 1;
  let i = endI;
  rawPath.push([j, i]);
  while (j > 0) {
    const step = steps[j * N + i];
    if (step === 1) {
      j -= 1;
      i -= 1;
    } else if (step === 2) {
      j -= 1;
      i -= 2;
    } else if (step === 3) {
      j -= 2;
      i -= 1;
    } else {
      break;
    }
    rawPath.push([j, Math.max(sFrame, i)]);
  }
  rawPath.reverse();

  const path = scale === 1
    ? rawPath
    : rawPath.map(([tj, ai]) => [
      Math.min(origM - 1, tj * scale),
      Math.min(origN - 1, ai * scale)
    ]);

  const startAudio = path.length > 0 ? path[0][1] : sFrame * scale;
  const endAudio = path.length > 0 ? path[path.length - 1][1] : endI * scale;
  const cost = bestEnd / M;

  return { path, cost, startAudio, endAudio };
}

function median3(a, b, c) {
  if (a > b) {
    const t = a; a = b; b = t;
  }
  if (b > c) {
    const t = b; b = c; c = t;
  }
  if (a > b) {
    const t = a; a = b; b = t;
  }
  return b;
}

export function anchorsFromPath(path, song, hopSec = HOP / SR) {
  if (!Array.isArray(path) || path.length === 0) return [];

  const frameMap = new Map();
  for (const [tFrame, aFrame] of path) {
    let list = frameMap.get(tFrame);
    if (!list) {
      list = [];
      frameMap.set(tFrame, list);
    }
    list.push(aFrame);
  }

  const matchedFrames = Array.from(frameMap.keys()).sort((a, b) => a - b);
  const meanAudioForTabFrame = (targetFrame) => {
    let list = frameMap.get(targetFrame);
    if (!list) {
      let nearest = matchedFrames[0];
      let bestDist = Math.abs(nearest - targetFrame);
      for (let k = 1; k < matchedFrames.length; k++) {
        const d = Math.abs(matchedFrames[k] - targetFrame);
        if (d < bestDist) {
          bestDist = d;
          nearest = matchedFrames[k];
        }
      }
      list = frameMap.get(nearest);
    }
    let sum = 0;
    for (let k = 0; k < list.length; k++) sum += list[k];
    return (sum / list.length) * hopSec;
  };

  const rawTabTimes = [];
  if (Array.isArray(song?.bars)) {
    for (const bar of song.bars) {
      const b = typeof bar === 'number' ? bar : Number(bar?.t);
      if (Number.isFinite(b)) rawTabTimes.push(b);
    }
  }
  const songDur = Number(song?.duration);
  if (Number.isFinite(songDur) && songDur > 0) {
    rawTabTimes.push(songDur);
  }
  rawTabTimes.sort((a, b) => a - b);

  const tabTimes = [];
  for (const t of rawTabTimes) {
    if (tabTimes.length === 0 || t - tabTimes[tabTimes.length - 1] > 1e-4) {
      tabTimes.push(t);
    }
  }

  const candidates = tabTimes.map((tab) => {
    const tFrame = Math.round(tab / hopSec);
    return { tab, audio: meanAudioForTabFrame(tFrame) };
  });

  const monotonic = [];
  for (const item of candidates) {
    if (monotonic.length === 0) {
      monotonic.push(item);
    } else {
      const prev = monotonic[monotonic.length - 1];
      if (item.tab > prev.tab + 1e-4 && item.audio > prev.audio + 1e-4) {
        monotonic.push(item);
      }
    }
  }

  if (monotonic.length >= 3) {
    const origOffsets = monotonic.map((a) => a.audio - a.tab);
    for (let i = 1; i < monotonic.length - 1; i++) {
      const medOffset = median3(origOffsets[i - 1], origOffsets[i], origOffsets[i + 1]);
      const smoothedAudio = monotonic[i].tab + medOffset;
      if (smoothedAudio > monotonic[i - 1].audio + 1e-4 && smoothedAudio < monotonic[i + 1].audio - 1e-4) {
        monotonic[i] = { tab: monotonic[i].tab, audio: smoothedAudio };
      }
    }
  }

  // The free start/end of a subsequence path bunches up at its ends, so the first and last anchors are the
  // least reliable: if one strays from the line through its two neighbours by > 60 ms, put it on that line.
  const fixEnd = (i, j, k) => {
    const a = monotonic[j];
    const b = monotonic[k];
    const slope = (b.audio - a.audio) / (b.tab - a.tab);
    const predicted = a.audio + (monotonic[i].tab - a.tab) * slope;
    if (Number.isFinite(predicted) && Math.abs(predicted - monotonic[i].audio) > 0.06) {
      monotonic[i] = { tab: monotonic[i].tab, audio: predicted };
    }
  };
  // The bunching can span two bars, so work outwards from the trusted middle: bar 2 from bars 3-4, then
  // bar 1 from bars 2-3 (and the same at the end).
  const n = monotonic.length;
  if (n >= 6) {
    fixEnd(1, 2, 3);
    fixEnd(0, 1, 2);
    fixEnd(n - 2, n - 4, n - 3);
    fixEnd(n - 1, n - 3, n - 2);
  } else if (n >= 4) {
    fixEnd(0, 1, 2);
    fixEnd(n - 1, n - 3, n - 2);
  }

  return monotonic.sort((a, b) => a.tab - b.tab);
}

/** Seconds to add to every anchor so tab note starts best match audio onset peaks (parabolic sub-frame). */
export function bestOnsetLag(song, anchors, onset, hopSec, maxLagFrames = 8) {
  if (!anchors.length || !song?.notes?.length || !onset?.length) return 0;
  const sync = { anchors };
  const starts = [...new Set(song.notes.map((n) => Math.round(n.t * 1000)))].map((ms) => ms / 1000);
  const frames = starts.map((t) => tabToAudio(sync, t) / hopSec);
  const scoreAt = (lag) => {
    let s = 0;
    for (const f of frames) {
      const i = Math.round(f + lag);
      if (i >= 0 && i < onset.length) s += onset[i];
    }
    return s;
  };
  const scores = [];
  for (let lag = -maxLagFrames; lag <= maxLagFrames; lag++) scores.push(scoreAt(lag));
  let best = maxLagFrames; // index of lag 0
  for (let k = 0; k < scores.length; k++) if (scores[k] > scores[best] + 1e-9) best = k;
  let lag = best - maxLagFrames;
  if (best > 0 && best < scores.length - 1) {
    const a = scores[best - 1], b = scores[best], c = scores[best + 1];
    const denom = a - 2 * b + c;
    if (denom < 0) lag += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
  }
  return lag * hopSec;
}

/**
 * The part of the tab that has notes: empty bars before the first note (an intro the guitar sits out) or
 * after the last carry nothing to match, so the DTW could stretch them anywhere and drag the start along.
 * Returns the trimmed song (times shifted so the first note is at 0) and the shift.
 */
function playedSpan(song) {
  const notes = (song?.notes || []).filter((n) => Number.isFinite(Number(n.t)));
  if (notes.length === 0) return { sub: song, shift: 0 };
  let first = Infinity;
  let last = 0;
  for (const n of notes) {
    const t = Number(n.t);
    first = Math.min(first, t);
    last = Math.max(last, t + Math.max(Number(n.dur) || 0, 0.15));
  }
  const shift = Math.max(0, first - 0.05);
  const end = Math.min(Number(song.duration) || last, last + 0.5);
  const sub = {
    ...song,
    duration: end - shift,
    notes: notes.map((n) => ({ ...n, t: Number(n.t) - shift })),
    bars: (song.bars || [])
      .filter((b) => Number(b.t) >= shift - 1e-6 && Number(b.t) <= end)
      .map((b) => ({ ...b, t: Number(b.t) - shift }))
  };
  if (sub.bars.length === 0 || sub.bars[0].t > 1e-6) sub.bars.unshift({ t: 0 });
  return { sub, shift };
}

/**
 * Per-bar refinement: after the global match, nudge each bar's anchor (within +-maxLagFrames) so the notes
 * of that bar land on the recording's attacks. Bars with fewer than 3 note starts keep the neighbours'
 * nudge; nudges are median-smoothed over 3 bars so one noisy bar can't jump.
 */
export function refineAnchorsPerBar(song, anchors, onset, hopSec, maxLagFrames = 5) {
  if (anchors.length < 2 || !song?.notes?.length) return anchors;
  const sorted = [...anchors].sort((a, b) => a.tab - b.tab);
  const sync = { anchors: sorted };
  const lags = sorted.map((a, k) => {
    const t0 = a.tab;
    const t1 = k + 1 < sorted.length ? sorted[k + 1].tab : Infinity;
    const starts = [...new Set(song.notes.filter((n) => n.t >= t0 - 1e-6 && n.t < t1).map((n) => Math.round(n.t * 1000)))];
    if (starts.length < 3) return null;
    const frames = starts.map((ms) => tabToAudio(sync, ms / 1000) / hopSec);
    let best = 0;
    let bestScore = -Infinity;
    for (let lag = -maxLagFrames; lag <= maxLagFrames; lag++) {
      let s = 0;
      for (const f of frames) {
        const i = Math.round(f + lag);
        if (i >= 0 && i < onset.length) s += onset[i];
      }
      // A tiny pull toward 0 so ties keep the global match.
      s -= Math.abs(lag) * 1e-3;
      if (s > bestScore) {
        bestScore = s;
        best = lag;
      }
    }
    return best * hopSec;
  });
  // Fill bars without enough notes from the nearest known nudge, then smooth.
  const filled = lags.map((v, k) => {
    if (v !== null) return v;
    for (let d = 1; d < lags.length; d++) {
      if (k - d >= 0 && lags[k - d] !== null) return lags[k - d];
      if (k + d < lags.length && lags[k + d] !== null) return lags[k + d];
    }
    return 0;
  });
  const smooth = filled.map((v, k) => (k === 0 || k === filled.length - 1
    ? v
    : median3(filled[k - 1], v, filled[k + 1])));
  const out = sorted.map((a, k) => ({ tab: a.tab, audio: a.audio + smooth[k] }));
  // Keep time moving forward.
  for (let k = 1; k < out.length; k++) {
    if (out[k].audio <= out[k - 1].audio + 1e-3) out[k].audio = out[k - 1].audio + 1e-3;
  }
  return out;
}

export function alignTab(fullSong, audioSamples, opts = {}) {
  const hopSec = HOP / SR;
  const { sub: song, shift } = playedSpan(fullSong);
  const tab = tabFeatures(song);
  const audio = audioFeatures(audioSamples);
  const startFrame = Number.isFinite(opts?.startFrame)
    ? Math.max(0, Math.floor(opts.startFrame))
    : Number.isFinite(opts?.startSec)
      ? Math.max(0, Math.round(opts.startSec / hopSec))
      : 0;

  const dtw = subsequenceDTW(tab, audio, {
    startFrame,
    onProgress: opts?.onProgress
  });

  // Anchors back in the full tab's time (the empty lead-in is covered by tabToAudio's extrapolation).
  const anchors = anchorsFromPath(dtw.path, song, hopSec).map((a) => ({ tab: a.tab + shift, audio: a.audio }));

  // Chroma blurs attacks, so the path can sit a few frames late or early. Slide the whole result to where
  // the tab's note starts land on the recording's attacks (onset peaks), within +-8 frames (~0.37 s).
  const lagSec = bestOnsetLag(fullSong, anchors, audio.onset, hopSec, 8);
  for (const a of anchors) a.audio += lagSec;
  // Then let each bar settle onto its own attacks (follows small tempo drift the path smoothed over).
  const refined = refineAnchorsPerBar(fullSong, anchors, audio.onset, hopSec, 5);
  anchors.splice(0, anchors.length, ...refined);
  // Report the matched span (first to last note) from the corrected anchors.
  const startAudio = anchors.length >= 2 ? tabToAudio({ anchors }, shift) : dtw.startAudio * hopSec + lagSec;
  const endAudio = anchors.length >= 2
    ? tabToAudio({ anchors }, shift + (Number(song.duration) || 0))
    : dtw.endAudio * hopSec + lagSec;
  const quality = dtw.cost < 0.45 ? 'good' : dtw.cost < 0.6 ? 'check' : 'poor';

  return {
    anchors,
    cost: dtw.cost,
    startAudio,
    endAudio,
    quality
  };
}
