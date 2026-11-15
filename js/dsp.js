/**
 * WOODSHED DSP (pure JS, Float32Array in, no browser APIs).
 *
 * detectPitch   McLeod Pitch Method: normalized square difference function (NSDF), key-maximum picking
 *               (first key maximum >= 0.9 x the highest one) and parabolic interpolation. Monophonic.
 * notePresence  Chord checking. For each target note, Goertzel probes on a Hann-windowed buffer at the
 *               target's harmonics, each compared with the two neighbouring semitones.
 * OnsetDetector Pick-attack detector on the short-term level.
 */

export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(freq, a4 = 440) {
  if (!Number.isFinite(freq) || freq <= 0) return 0;
  return 69 + 12 * Math.log2(freq / a4);
}

export function centsOff(freq, midi, a4 = 440) {
  if (!Number.isFinite(freq) || freq <= 0) return Infinity;
  return 1200 * Math.log2(freq / midiToFreq(midi, a4));
}

const RMS_FLOOR = 0.004;
const CLARITY_FLOOR = 0.6;
const KEY_MAX_K = 0.9;

let _x = new Float64Array(0);
let _nsdf = new Float64Array(0);

/**
 * @returns {{freq:number, clarity:number, rms:number}} freq = 0 when no clear pitch.
 */
export function detectPitch(buf, sampleRate, opts = {}) {
  const minHz = opts.minHz !== undefined ? opts.minHz : 55;
  const maxHz = opts.maxHz !== undefined ? opts.maxHz : 1400;
  const n = buf ? buf.length : 0;
  if (n < 64 || !Number.isFinite(sampleRate) || sampleRate <= 0) return { freq: 0, clarity: 0, rms: 0 };

  if (_x.length < n) _x = new Float64Array(n);
  const x = _x;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += buf[i];
  mean /= n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = buf[i] - mean;
    x[i] = v;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / n);
  if (!(rms >= RMS_FLOOR)) return { freq: 0, clarity: 0, rms: rms || 0 };

  // Lags are searched a little past the limits so a peak sitting on the edge can still be interpolated.
  const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxTau = Math.min(Math.floor(n / 2), Math.ceil(sampleRate / minHz));
  if (minTau >= maxTau) return { freq: 0, clarity: 0, rms };
  const top = maxTau + 1;

  if (_nsdf.length < top + 2) _nsdf = new Float64Array(top + 2);
  const nsdf = _nsdf;
  // m(tau) = sum x[i]^2 + x[i+tau]^2 is updated incrementally from m(0) = 2 * sumSq.
  let m = 2 * sumSq;
  nsdf[0] = 1;
  for (let tau = 1; tau <= top; tau++) {
    m -= x[tau - 1] * x[tau - 1] + x[n - tau] * x[n - tau];
    let acf = 0;
    const len = n - tau;
    for (let i = 0; i < len; i++) acf += x[i] * x[i + tau];
    nsdf[tau] = m > 1e-12 ? (2 * acf) / m : 0;
  }

  // Key maxima: the highest point of every positive lobe after the first negative-going zero crossing.
  let tau = 1;
  while (tau <= maxTau && nsdf[tau] > 0) tau++;
  const maxT = [];
  const maxV = [];
  let best = -1;
  let bestTau = 0;
  for (; tau <= maxTau; tau++) {
    const v = nsdf[tau];
    if (v > 0) {
      if (v > best && v >= nsdf[tau - 1] && v >= nsdf[tau + 1]) {
        best = v;
        bestTau = tau;
      }
    } else if (bestTau) {
      maxT.push(bestTau);
      maxV.push(best);
      best = -1;
      bestTau = 0;
    }
  }
  if (bestTau) {
    maxT.push(bestTau);
    maxV.push(best);
  }
  if (!maxT.length) return { freq: 0, clarity: 0, rms };

  let nmax = 0;
  for (let i = 0; i < maxV.length; i++) if (maxV[i] > nmax) nmax = maxV[i];
  if (nmax < CLARITY_FLOOR) return { freq: 0, clarity: Math.max(0, nmax), rms };

  let pick = -1;
  for (let i = 0; i < maxT.length; i++) {
    if (maxT[i] >= minTau && maxV[i] >= KEY_MAX_K * nmax) {
      pick = i;
      break;
    }
  }
  if (pick < 0) return { freq: 0, clarity: 0, rms };

  const t = maxT[pick];
  const y1 = nsdf[t - 1];
  const y2 = nsdf[t];
  const y3 = nsdf[t + 1];
  const denom = y1 - 2 * y2 + y3;
  let delta = 0;
  if (denom < -1e-12) {
    delta = (0.5 * (y1 - y3)) / denom;
    if (delta < -1 || delta > 1) delta = 0;
  }
  const clarity = Math.min(1, y2 - 0.25 * (y1 - y3) * delta);
  const freq = sampleRate / (t + delta);
  if (clarity < CLARITY_FLOOR || freq < minHz * 0.97 || freq > maxHz * 1.03) {
    return { freq: 0, clarity: Math.max(0, clarity), rms };
  }
  return { freq, clarity, rms };
}

// ---------------------------------------------------------------------------------------------------------
// Chord checking
// ---------------------------------------------------------------------------------------------------------

function goertzelAmp(w, n, sampleRate, freq, wsum) {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = w[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const p = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * Math.sqrt(p > 0 ? p : 0)) / wsum; // = amplitude of a sinusoid at freq
}

const SEMI = Math.pow(2, 1 / 12);
const MAX_HARMONIC = 6;
const MIN_SEPARATION_BINS = 0.7; // a harmonic is only judged when its semitone neighbours are this far apart
const RESOLVED_BINS = 1.5; // from here on the neighbours sit outside the window's main lobe
const NEIGHBOUR_RATIO = 1.6; // the target must beat the louder neighbour semitone by this factor
// Closer than RESOLVED_BINS the neighbours read 60-70% of the target through the window's main lobe even
// when only the target sounds (and vice versa), so there the target only has to be the clear peak.
const NEIGHBOUR_RATIO_CLOSE = 1.15;
const PARTIAL_FLOOR = 0.02; // ... and be at least this share of the signal's amplitude
const PEAK_FLOOR = 0.08; // ... and this share of the loudest partial in the buffer (rejects leakage and splatter)
const FULL_SCORE_SHARE = 0.16; // amplitude share (of rms * sqrt2) that scores 1.0; half of it scores 0.5
const NO_ANCHOR_PENALTY = 0.2; // caps the score when the note's lowest judged harmonics are not there

let _re = new Float64Array(0);
let _im = new Float64Array(0);

/** In-place radix-2 FFT; n must be a power of two. */
function fft(re, im, n) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Amplitude of the loudest partial between 60 Hz and 5 kHz in the (already windowed) buffer. */
function loudestPartial(w, n, sampleRate, wsum) {
  if (n & (n - 1)) return 0;
  if (_re.length !== n) {
    _re = new Float64Array(n);
    _im = new Float64Array(n);
  }
  _re.set(w.subarray(0, n));
  _im.fill(0);
  fft(_re, _im, n);
  const lo = Math.max(1, Math.floor((60 * n) / sampleRate));
  const hi = Math.min(n >> 1, Math.ceil((5000 * n) / sampleRate));
  let best = 0;
  for (let k = lo; k < hi; k++) {
    const p = _re[k] * _re[k] + _im[k] * _im[k];
    if (p > best) best = p;
  }
  return (2 * Math.sqrt(best)) / wsum;
}

let _w = new Float64Array(0);
let _hann = new Float64Array(0);
let _hannSum = 0;

/**
 * How strongly each target MIDI note is sounding, 0..1; >= 0.5 means "yes, it is in there".
 *
 * Thresholds: a harmonic counts when it is NEIGHBOUR_RATIO times louder than both neighbouring semitones
 * (so a chord one fret off scores ~0), above PARTIAL_FLOOR of the signal level and above PEAK_FLOOR of
 * the loudest partial (so leakage from a loud string or a damping click is not taken for a note). The counted harmonics'
 * combined amplitude, as a share of the whole signal (rms * sqrt 2), is mapped so FULL_SCORE_SHARE -> 1.
 * Harmonics whose semitone neighbours cannot be told apart in this buffer length are skipped, so give it
 * a long buffer (8192 samples): that is what lets the fundamentals of the low strings be judged. A note is not told apart from another note's harmonic that
 * lands on the same frequencies (an octave or a twelfth above a sounding note): that is physically the same.
 */
export function notePresence(buf, sampleRate, midis, a4 = 440) {
  if (!midis || !midis.length) return [];
  const n = buf ? buf.length : 0;
  const out = new Array(midis.length).fill(0);
  if (n < 256 || !Number.isFinite(sampleRate) || sampleRate <= 0) return out;

  if (_hann.length !== n) {
    _hann = new Float64Array(n);
    _hannSum = 0;
    for (let i = 0; i < n; i++) {
      _hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
      _hannSum += _hann[i];
    }
    _w = new Float64Array(n);
  }
  const w = _w;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += buf[i];
  mean /= n;
  // The level is measured under the same window as the partials so both follow a fresh attack together.
  let e = 0;
  let wsq = 0;
  for (let i = 0; i < n; i++) {
    const h = _hann[i];
    const v = (buf[i] - mean) * h;
    w[i] = v;
    e += v * v;
    wsq += h * h;
  }
  const rms = Math.sqrt(e / wsq);
  if (!(rms >= 0.003)) return out;
  const ref = rms * Math.SQRT2;
  const floor = Math.max(PARTIAL_FLOOR * ref, PEAK_FLOOR * loudestPartial(w, n, sampleRate, _hannSum));
  const binW = sampleRate / n;
  const fMax = Math.min(sampleRate * 0.45, 5000);
  const cache = new Map();
  const amp = (f) => {
    const key = Math.round(f * 100);
    let a = cache.get(key);
    if (a === undefined) {
      a = goertzelAmp(w, n, sampleRate, f, _hannSum);
      cache.set(key, a);
    }
    return a;
  };

  for (let k = 0; k < midis.length; k++) {
    const f0 = midiToFreq(midis[k], a4);
    let sum = 0;
    let judged = 0;
    const lowHz = [0, 0, 0, 0];
    let anchorClose = false;
    let low = 0; // bit k set = the (k+1)th judged harmonic is there
    for (let h = 1; h <= MAX_HARMONIC; h++) {
      const fh = f0 * h;
      if (fh > fMax) break;
      const sep = (fh * (SEMI - 1)) / binW;
      if (sep < MIN_SEPARATION_BINS) continue;
      judged++;
      if (judged <= 4) lowHz[judged - 1] = fh;
      let aT = amp(fh);
      // Strings are never perfectly in tune and upper partials run sharp: also probe +-12 cents when that
      // is a meaningful fraction of a bin.
      if ((fh * 0.007) / binW > 0.3) {
        aT = Math.max(aT, amp(fh * 1.00696), amp(fh / 1.00696));
      }
      const aN = Math.max(amp(fh * SEMI), amp(fh / SEMI));
      if (judged === 1) anchorClose = sep < RESOLVED_BINS;
      if (aT > (sep < RESOLVED_BINS ? NEIGHBOUR_RATIO_CLOSE : NEIGHBOUR_RATIO) * aN && aT > floor) {
        sum += aT * aT;
        if (judged <= 4) low |= 1 << (judged - 1);
      }
    }
    let score = Math.min(1, Math.sqrt(sum) / (ref * FULL_SCORE_SHARE));
    // The lowest judged harmonic must be there. Exception: when another note of the same chord has a
    // partial on that very frequency (octaves, fifths), the two can cancel each other for a moment, so
    // the next two harmonics together are accepted instead.
    // Anchoring: the lowest judged harmonic must be there. If it could only be judged at close range it is
    // not trusted alone (re-picking a ringing string splits its spectral peak for a moment), so the next
    // one must be there too. A missing harmonic is excused when another note of the same chord has a partial
    // on that very frequency (octaves, fifths: the two can cancel for a moment) and the one after it is there.
    const has = (i) => (low & (1 << i)) !== 0;
    const excused = (i) => {
      if (has(i)) return true;
      if (!has(i + 1) || !lowHz[i]) return false;
      for (let j = 0; j < midis.length; j++) {
        if (j === k) continue;
        const r = lowHz[i] / midiToFreq(midis[j], a4);
        const h = Math.round(r);
        if (h >= 1 && h <= MAX_HARMONIC && Math.abs(1200 * Math.log2(r / h)) < 30) return true;
      }
      return false;
    };
    const anchored = anchorClose
      ? (has(0) && excused(1)) || (excused(0) && has(1) && has(2))
      : has(0) || (excused(0) && has(2));
    if (!anchored) score *= NO_ANCHOR_PENALTY;
    out[k] = Math.min(1, score);
  }
  return out;
}

/**
 * The game's single test for "is the player sounding these notes right now".
 * @param buf        newest samples (8192 recommended)
 * @param midis      the notes of one tab event (1 = single note, 2+ = chord)
 * @param pitchFreq  detectPitch's reading for the same moment (0 if none)
 * @returns {{ok:boolean, matched:boolean[], count:number, need:number}}
 * A note matches when the monophonic pitch is within half a semitone of it or its presence is >= 0.5.
 * Single notes and double stops need every note; bigger chords need 60% (rounded up) so one muted or
 * buzzing string does not fail a chord.
 */
export function judgeNotes(buf, sampleRate, midis, pitchFreq = 0, a4 = 440) {
  const n = midis.length;
  const pres = notePresence(buf, sampleRate, midis, a4);
  const heard = pitchFreq > 0 ? freqToMidi(pitchFreq, a4) : -100;
  const matched = new Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    matched[i] = pres[i] >= 0.5 || Math.abs(heard - midis[i]) < 0.5;
    if (matched[i]) count++;
  }
  const need = n <= 2 ? n : Math.ceil(n * 0.6);
  return { ok: n > 0 && count >= need, matched, count, need };
}

// ---------------------------------------------------------------------------------------------------------
// Onsets
// ---------------------------------------------------------------------------------------------------------

/**
 * Feed it the newest samples once per frame; process() returns true on the frame where a new pick attack
 * shows up. Two cues are watched over the newest ~17 ms: the level, and the level of the differenced
 * (treble-heavy) signal. A string's treble dies away quickly, so picking a string that is still ringing,
 * which barely moves the overall level, still gives a clear jump in the second cue.
 */
export class OnsetDetector {
  constructor(opts = {}) {
    this.floorRms = opts.floorRms !== undefined ? opts.floorRms : 0.008;
    this.ratio = opts.ratio !== undefined ? opts.ratio : 1.35;
    this.trebleRatio = opts.trebleRatio !== undefined ? opts.trebleRatio : 1.6;
    this.refractorySec = opts.refractorySec !== undefined ? opts.refractorySec : 0.06;
    this.reset();
  }

  reset() {
    this.env = 0;
    this.envD = 0;
    this.lastOnsetTime = -Infinity;
  }

  process(buf, timeSec = 0) {
    if (!buf || !buf.length) return false;
    const n = buf.length;
    const len = Math.min(768, n);
    let sumSq = 0;
    let sumD = 0;
    for (let i = n - len; i < n; i++) {
      const v = buf[i];
      sumSq += v * v;
      if (i > 0) {
        const d = v - buf[i - 1];
        sumD += d * d;
      }
    }
    const fast = Math.sqrt(sumSq / len);
    const fastD = Math.sqrt(sumD / len);

    const loud = fast >= this.floorRms;
    const rising = fast > this.ratio * this.env + this.floorRms * 0.25;
    const brighter = fastD > this.trebleRatio * this.envD + this.floorRms * 0.05;
    const refractory = timeSec - this.lastOnsetTime < this.refractorySec;
    let hit = false;
    if (loud && (rising || brighter) && !refractory) {
      hit = true;
      this.lastOnsetTime = timeSec;
      this.env = fast;
      this.envD = fastD;
    } else {
      // Inside the refractory window the attack is still growing: follow it fully so it cannot fire twice.
      const up = refractory ? 1 : 0.25;
      this.env += (fast > this.env ? up : 0.3) * (fast - this.env);
      this.envD += (fastD > this.envD ? up : 0.3) * (fastD - this.envD);
    }
    return hit;
  }
}
