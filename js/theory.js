import { midiToName } from './song.js';

export const NOTE_NAMES = {
  sharp: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
  flat:  ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'],
  forKey(tonic = 0, mode = 'major') {
    const flatMajorTonics = new Set([5, 10, 3, 8, 1, 6]);
    const flatMinorTonics = new Set([2, 7, 0, 5, 10, 3]);
    const t = ((tonic % 12) + 12) % 12;
    const useFlat = mode === 'minor' ? flatMinorTonics.has(t) : flatMajorTonics.has(t);
    return useFlat ? this.flat : this.sharp;
  }
};

export const SCALES = {
  'major':             [0, 2, 4, 5, 7, 9, 11],
  'natural minor':     [0, 2, 3, 5, 7, 8, 10],
  'harmonic minor':    [0, 2, 3, 5, 7, 8, 11],
  'melodic minor':     [0, 2, 3, 5, 7, 9, 11],
  'major pentatonic':  [0, 2, 4, 7, 9],
  'minor pentatonic':  [0, 3, 5, 7, 10],
  'blues':             [0, 3, 5, 6, 7, 10],
  'dorian':            [0, 2, 3, 5, 7, 9, 10],
  'phrygian':          [0, 1, 3, 5, 7, 8, 10],
  'lydian':            [0, 2, 4, 6, 7, 9, 11],
  'mixolydian':        [0, 2, 4, 5, 7, 9, 10],
  'locrian':           [0, 1, 3, 5, 6, 8, 10]
};

const INTERVAL_DEGREES = {
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

export const CHORD_TYPES = {
  'maj':  { intervals: [0, 4, 7],        suffix: '',      quality: 'major' },
  'min':  { intervals: [0, 3, 7],        suffix: 'm',     quality: 'minor' },
  '5':    { intervals: [0, 7],           suffix: '5',     quality: 'power' },
  'dim':  { intervals: [0, 3, 6],        suffix: 'dim',   quality: 'dim'   },
  'aug':  { intervals: [0, 4, 8],        suffix: 'aug',   quality: 'aug'   },
  'sus2': { intervals: [0, 2, 7],        suffix: 'sus2',  quality: 'sus'   },
  'sus4': { intervals: [0, 5, 7],        suffix: 'sus4',  quality: 'sus'   },
  '7':    { intervals: [0, 4, 7, 10],    suffix: '7',     quality: 'dom'   },
  'maj7': { intervals: [0, 4, 7, 11],    suffix: 'maj7',  quality: 'major' },
  'm7':   { intervals: [0, 3, 7, 10],    suffix: 'm7',    quality: 'minor' },
  'm7b5': { intervals: [0, 3, 6, 10],    suffix: 'm7b5',  quality: 'dim'   },
  'dim7': { intervals: [0, 3, 6, 9],     suffix: 'dim7',  quality: 'dim'   },
  '6':    { intervals: [0, 4, 7, 9],     suffix: '6',     quality: 'major' },
  'm6':   { intervals: [0, 3, 7, 9],     suffix: 'm6',    quality: 'minor' },
  'add9': { intervals: [0, 2, 4, 7],     suffix: 'add9',  quality: 'major' },
  '9':    { intervals: [0, 2, 4, 7, 10], suffix: '9',     quality: 'dom'   },
  'm9':   { intervals: [0, 2, 3, 7, 10], suffix: 'm9',    quality: 'minor' }
};

const INFERRED_CHORD_TYPES = ['maj', 'min', '5', 'dim', 'sus2', 'sus4', '7', 'maj7', 'm7'];

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearsonCorrelation(a, b) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 1e-12 ? num / den : 0;
}

function relativeKey(tonic, mode) {
  const t = ((tonic % 12) + 12) % 12;
  if (mode === 'minor') {
    return { tonic: (t + 3) % 12, mode: 'major' };
  }
  return { tonic: (t + 9) % 12, mode: 'minor' };
}

export function detectKey(notes) {
  const playable = (Array.isArray(notes) ? notes : []).filter((n) => !n.dead && !n.tie);
  if (playable.length === 0) {
    return {
      tonic: 0,
      mode: 'major',
      confidence: 0,
      relative: relativeKey(0, 'major'),
      alternatives: []
    };
  }

  const hist = new Float64Array(12);
  let totalWeight = 0;
  let minMidi = Infinity;

  for (const n of playable) {
    const dur = Math.max(0.05, Number(n.dur) || 0.25);
    const pc = ((n.midi % 12) + 12) % 12;
    hist[pc] += dur;
    totalWeight += dur;
    if (n.midi < minMidi) minMidi = n.midi;
  }

  const bassThreshold = minMidi + 7;
  const bassHist = new Float64Array(12);
  for (const n of playable) {
    if (n.midi <= bassThreshold) {
      const pc = ((n.midi % 12) + 12) % 12;
      bassHist[pc] += Math.max(0.05, Number(n.dur) || 0.25) * (1 + (bassThreshold - n.midi) * 0.15);
    }
  }

  let dominantBassPc = 0;
  let maxBassWeight = -1;
  for (let pc = 0; pc < 12; pc++) {
    if (bassHist[pc] > maxBassWeight) {
      maxBassWeight = bassHist[pc];
      dominantBassPc = pc;
    }
  }

  const sortedByTime = [...playable].sort((a, b) => a.t - b.t);
  const firstTime = sortedByTime[0].t;
  const lastTime = sortedByTime[sortedByTime.length - 1].t;

  const firstSlice = sortedByTime.filter((n) => n.t <= firstTime + 2.0);
  const lastSlice = sortedByTime.filter((n) => n.t >= lastTime - 2.0);

  const firstBassNote = firstSlice.reduce((low, n) => (n.midi < low.midi ? n : low), firstSlice[0]);
  const lastBassNote = lastSlice.reduce((low, n) => (n.midi < low.midi ? n : low), lastSlice[0]);
  const firstBassPc = ((firstBassNote.midi % 12) + 12) % 12;
  const lastBassPc = ((lastBassNote.midi % 12) + 12) % 12;

  const candidates = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotatedMajor = new Float64Array(12);
    const rotatedMinor = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      rotatedMajor[(tonic + i) % 12] = KS_MAJOR[i];
      rotatedMinor[(tonic + i) % 12] = KS_MINOR[i];
    }

    let majScore = pearsonCorrelation(hist, rotatedMajor);
    let minScore = pearsonCorrelation(hist, rotatedMinor);

    let tonicBonus = 0;
    if (tonic === dominantBassPc) tonicBonus += 0.20;
    if (tonic === firstBassPc) tonicBonus += 0.14;
    if (tonic === lastBassPc) tonicBonus += 0.12;

    const majThird = (tonic + 4) % 12;
    const minThird = (tonic + 3) % 12;
    const fifth = (tonic + 7) % 12;
    const raisedSeventh = (tonic + 11) % 12;
    const flatSeventh = (tonic + 10) % 12;

    const thirdBias = (hist[majThird] - hist[minThird]) / Math.max(totalWeight, 1e-6);
    const fifthShare = hist[fifth] / Math.max(totalWeight, 1e-6);

    majScore += tonicBonus + thirdBias * 0.25 + fifthShare * 0.08;
    minScore += tonicBonus - thirdBias * 0.25 + fifthShare * 0.08;

    // Harmonic minor signature: raised 7th (leading tone of V) with minor tonic anchor keeps minor key from flipping to relative major
    if (hist[raisedSeventh] > 0) {
      const leadingShare = hist[raisedSeventh] / Math.max(totalWeight, 1e-6);
      const hasMinorAnchor =
        hist[minThird] > 0 ||
        tonic === dominantBassPc ||
        tonic === firstBassPc ||
        tonic === lastBassPc;
      const hasDominantBass = bassHist[fifth] > 0;
      if (hasMinorAnchor) {
        minScore += Math.min(0.24, 0.10 + leadingShare * 0.9 + (hasDominantBass ? 0.08 : 0));
      }
    }

    // Penalize major candidate when chromatic #5 / b6 appears (often the leading tone of its relative minor)
    const sharpFive = (tonic + 8) % 12;
    const relMinorTonic = (tonic + 9) % 12;
    if (hist[sharpFive] > 0 && (hist[relMinorTonic] > 0 || bassHist[relMinorTonic] > 0)) {
      majScore -= 0.12;
    }

    // Blues/rock major with b7 stays major when major 3rd and tonic bass are strong
    if (hist[flatSeventh] > 0 && hist[majThird] > hist[minThird] && tonic === dominantBassPc) {
      majScore += 0.07;
    }

    if (hist[minThird] === 0 && hist[majThird] === 0 && tonic === dominantBassPc) {
      minScore += 0.06;
    }

    candidates.push({ tonic, mode: 'major', score: majScore });
    candidates.push({ tonic, mode: 'minor', score: minScore });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const second = candidates[1] || { score: 0 };
  const spread = Math.max(0, best.score - second.score);
  const calibrated = 0.18 + 0.78 * (spread / (spread + 0.22));
  const confidence = Number(Math.min(0.96, Math.max(0.15, calibrated)).toFixed(3));

  return {
    tonic: best.tonic,
    mode: best.mode,
    confidence,
    relative: relativeKey(best.tonic, best.mode),
    alternatives: candidates.slice(1, 5).map((c) => ({
      tonic: c.tonic,
      mode: c.mode,
      score: Number(c.score.toFixed(3))
    }))
  };
}

export function bestScales(notes, tonic = 0) {
  const playable = (Array.isArray(notes) ? notes : []).filter((n) => !n.dead && !n.tie);
  const pcDur = new Float64Array(12);
  let totalDur = 0;
  const presentPcs = new Set();

  for (const n of playable) {
    const pc = ((n.midi % 12) + 12) % 12;
    const d = Math.max(0.05, Number(n.dur) || 0.25);
    pcDur[pc] += d;
    totalDur += d;
    presentPcs.add(pc);
  }

  const root = ((tonic % 12) + 12) % 12;
  const minorPentSet = new Set(SCALES['minor pentatonic']);
  const majorPentSet = new Set(SCALES['major pentatonic']);
  const results = [];

  for (const [name, intervals] of Object.entries(SCALES)) {
    const isMinorQuality = intervals.includes(3);
    const spell = NOTE_NAMES.forKey(root, isMinorQuality ? 'minor' : 'major');
    const basePent = isMinorQuality ? minorPentSet : majorPentSet;

    const scaleNotes = intervals.map((iv) => (root + iv) % 12);
    const scalePcs = new Set(scaleNotes);
    const degrees = intervals.map((iv) => (name === 'lydian' && iv === 6 ? '#4' : INTERVAL_DEGREES[iv]));

    const adds = [];
    for (let i = 0; i < intervals.length; i++) {
      const iv = intervals[i];
      if (!basePent.has(iv)) {
        const pc = (root + iv) % 12;
        adds.push({
          pc,
          degree: degrees[i],
          note: spell[pc]
        });
      }
    }

    let inScaleDur = 0;
    const extraNotes = [];
    for (let pc = 0; pc < 12; pc++) {
      if (pcDur[pc] > 0) {
        if (scalePcs.has(pc)) {
          inScaleDur += pcDur[pc];
        } else {
          extraNotes.push(pc);
        }
      }
    }
    const missing = [];
    for (const spc of scalePcs) {
      if (!presentPcs.has(spc)) missing.push(spc);
    }
    const coverage = totalDur > 0 ? inScaleDur / totalDur : 1;
    results.push({
      name,
      coverage,
      size: intervals.length,
      notes: scaleNotes,
      degrees,
      adds,
      pentatonicBase: isMinorQuality ? 'minor pentatonic' : 'major pentatonic',
      extraNotes,
      missing
    });
  }

  results.sort((a, b) => {
    const aHigh = a.coverage >= 0.95;
    const bHigh = b.coverage >= 0.95;
    if (aHigh && bHigh) {
      if (a.size !== b.size) return a.size - b.size;
      if (Math.abs(b.coverage - a.coverage) > 0.005) return b.coverage - a.coverage;
      return a.missing.length - b.missing.length;
    }
    if (aHigh !== bHigh) return aHigh ? -1 : 1;
    if (Math.abs(b.coverage - a.coverage) > 0.01) return b.coverage - a.coverage;
    return a.size - b.size;
  });

  return results.map(({ name, coverage, notes: scaleNotes, degrees, adds, pentatonicBase, extraNotes, missing }) => ({
    name,
    coverage,
    notes: scaleNotes,
    degrees,
    adds,
    pentatonicBase,
    extraNotes,
    missing
  }));
}

export function nameChord(midis, key = null) {
  if (!Array.isArray(midis) || midis.length === 0) return null;
  const valid = midis.filter((m) => Number.isFinite(m)).map((m) => Math.round(m));
  if (valid.length === 0) return null;

  const spell = key ? NOTE_NAMES.forKey(key.tonic, key.mode) : NOTE_NAMES.sharp;
  const sorted = [...valid].sort((a, b) => a - b);
  const bassMidi = sorted[0];
  const bassPc = ((bassMidi % 12) + 12) % 12;

  const uniquePcs = Array.from(new Set(sorted.map((m) => ((m % 12) + 12) % 12)));
  if (uniquePcs.length === 1) {
    const rootName = spell[uniquePcs[0]];
    return {
      root: uniquePcs[0],
      type: '5',
      name: `${rootName}5`,
      bass: bassPc,
      inversion: 0
    };
  }

  if (uniquePcs.length === 2) {
    const [p1, p2] = uniquePcs;
    const diff = (p2 - p1 + 12) % 12;
    if (diff === 7) {
      return {
        root: p1,
        type: '5',
        name: bassPc === p1 ? `${spell[p1]}5` : `${spell[p1]}5/${spell[bassPc]}`,
        bass: bassPc,
        inversion: bassPc === p1 ? 0 : 1
      };
    }
    if (diff === 5) {
      return {
        root: p2,
        type: '5',
        name: bassPc === p2 ? `${spell[p2]}5` : `${spell[p2]}5/${spell[bassPc]}`,
        bass: bassPc,
        inversion: bassPc === p2 ? 0 : 1
      };
    }
    if (diff === 4) {
      return {
        root: p1,
        type: 'maj',
        name: bassPc === p1 ? spell[p1] : `${spell[p1]}/${spell[bassPc]}`,
        bass: bassPc,
        inversion: bassPc === p1 ? 0 : 1
      };
    }
    if (diff === 3) {
      return {
        root: p1,
        type: 'min',
        name: bassPc === p1 ? `${spell[p1]}m` : `${spell[p1]}m/${spell[bassPc]}`,
        bass: bassPc,
        inversion: bassPc === p1 ? 0 : 1
      };
    }
  }

  let bestMatch = null;
  let bestScore = -Infinity;

  for (const rootCandidate of uniquePcs) {
    const relSet = new Set(uniquePcs.map((pc) => (pc - rootCandidate + 12) % 12));

    for (const [typeKey, def] of Object.entries(CHORD_TYPES)) {
      if (typeKey === '5' && uniquePcs.length >= 3) continue;

      let matched = 0;
      let missingRequired = 0;
      for (const iv of def.intervals) {
        if (relSet.has(iv)) {
          matched++;
        } else if (iv === 7 && def.intervals.length >= 4) {
          missingRequired += 0.35;
        } else {
          missingRequired += 1.2;
        }
      }

      let extraCount = 0;
      for (const r of relSet) {
        if (!def.intervals.includes(r)) extraCount++;
      }

      let score = matched * 2.0 - missingRequired * 2.5 - extraCount * 1.8;
      if (rootCandidate === bassPc) score += 1.5;
      if (typeKey === 'maj' || typeKey === 'min') score += 0.25;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = { root: rootCandidate, type: typeKey, def };
      }
    }
  }

  if (!bestMatch) return null;

  const root = bestMatch.root;
  const type = bestMatch.type;
  const suffix = bestMatch.def.suffix;
  const rootName = spell[root];
  const bassName = spell[bassPc];
  const relBass = (bassPc - root + 12) % 12;
  const invIdx = bestMatch.def.intervals.indexOf(relBass);
  const inversion = bassPc === root ? 0 : (invIdx > 0 ? invIdx : 1);

  const name = bassPc !== root
    ? `${rootName}${suffix}/${bassName}`
    : `${rootName}${suffix}`;

  return {
    root,
    type,
    name,
    bass: bassPc,
    inversion
  };
}

function inferSegmentChord(notesInSeg, spell = NOTE_NAMES.sharp) {
  if (!notesInSeg || notesInSeg.length === 0) return null;
  const sortedByPitch = [...notesInSeg].sort((a, b) => a.midi - b.midi);
  const lowestNote = sortedByPitch[0];
  const bassPc = ((lowestNote.midi % 12) + 12) % 12;

  const rawWeights = new Float64Array(12);
  for (const n of notesInSeg) {
    const pc = ((n.midi % 12) + 12) % 12;
    const dur = Math.max(0.05, Number(n.dur) || 0.2);
    rawWeights[pc] += dur;
  }

  // Double the bass pitch class weight
  rawWeights[bassPc] *= 2.0;

  let totalW = 0;
  for (let i = 0; i < 12; i++) totalW += rawWeights[i];
  if (totalW <= 0) return null;

  const norm = new Float64Array(12);
  for (let i = 0; i < 12; i++) norm[i] = rawWeights[i] / totalW;

  let best = null;
  let bestScore = -Infinity;

  for (let root = 0; root < 12; root++) {
    const minThirdPc = (root + 3) % 12;
    const majThirdPc = (root + 4) % 12;

    for (const typeKey of INFERRED_CHORD_TYPES) {
      const def = CHORD_TYPES[typeKey];
      const intervals = def.intervals;

      if (typeKey === '5') {
        if (norm[minThirdPc] >= 0.04 || norm[majThirdPc] >= 0.04) continue;
      }

      let valid = true;
      const chordTonePcs = new Set();
      for (const iv of intervals) {
        const pc = (root + iv) % 12;
        chordTonePcs.add(pc);
        const isOptionalFifth = intervals.length >= 4 && iv === 7;
        if (!isOptionalFifth && norm[pc] < 0.04) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;

      let chordToneWeight = 0;
      for (const pc of chordTonePcs) {
        chordToneWeight += norm[pc];
      }
      const otherWeight = Math.max(0, 1 - chordToneWeight);
      const bassBonus = root === bassPc ? 0.25 : 0;
      const tonePenalty = 0.03 * Math.max(0, intervals.length - 3);
      const score = chordToneWeight - 0.7 * otherWeight + bassBonus - tonePenalty;

      if (
        score > bestScore + 1e-9 ||
        (Math.abs(score - bestScore) <= 1e-9 && best && root === bassPc && best.root !== bassPc)
      ) {
        bestScore = score;
        best = { root, type: typeKey, def, score };
      }
    }
  }

  if (!best || bestScore < 0.45) return null;

  const root = best.root;
  const type = best.type;
  const suffix = best.def.suffix;
  const rootName = spell[root];
  const bassName = spell[bassPc];
  const relBass = (bassPc - root + 12) % 12;
  const invIdx = best.def.intervals.indexOf(relBass);
  const inversion = bassPc === root ? 0 : (invIdx > 0 ? invIdx : 1);
  const name = bassPc !== root ? `${rootName}${suffix}/${bassName}` : `${rootName}${suffix}`;

  const rootNote = sortedByPitch.find((n) => ((n.midi % 12) + 12) % 12 === root) || lowestNote;

  return {
    chord: {
      root,
      type,
      name,
      bass: bassPc,
      inversion
    },
    rootMidi: rootNote.midi,
    score: bestScore
  };
}

export function chordsByBar(song, key = null) {
  if (!song || !Array.isArray(song.bars)) return [];
  const playable = (song.notes || []).filter((n) => !n.dead && !n.tie);
  if (playable.length === 0) return [];

  const resolvedKey = key || detectKey(playable);
  const spell = NOTE_NAMES.forKey(resolvedKey.tonic, resolvedKey.mode);
  const out = [];

  for (let bIdx = 0; bIdx < song.bars.length; bIdx++) {
    const bar = song.bars[bIdx];
    const bStart = bar.t;
    const bEnd = bar.t + bar.dur;
    const bMid = bStart + bar.dur * 0.5;

    const barNotes = playable.filter((n) => n.t >= bStart - 0.01 && n.t < bEnd - 0.01);
    if (barNotes.length === 0) continue;

    const firstHalf = barNotes.filter((n) => n.t < bMid - 0.01);
    const secondHalf = barNotes.filter((n) => n.t >= bMid - 0.01);

    if (firstHalf.length >= 2 && secondHalf.length >= 2) {
      const c1 = inferSegmentChord(firstHalf, spell);
      const c2 = inferSegmentChord(secondHalf, spell);
      if (c1 && c2 && c1.score >= 0.55 && c2.score >= 0.55 && c1.chord.root !== c2.chord.root) {
        out.push({
          bar: bIdx,
          t: bStart,
          dur: bar.dur * 0.5,
          chord: c1.chord,
          rootMidi: c1.rootMidi
        });
        out.push({
          bar: bIdx,
          t: bMid,
          dur: bar.dur * 0.5,
          chord: c2.chord,
          rootMidi: c2.rootMidi
        });
        continue;
      }
    }

    const wholeInfer = inferSegmentChord(barNotes, spell);
    if (wholeInfer) {
      out.push({
        bar: bIdx,
        t: bStart,
        dur: bar.dur,
        chord: wholeInfer.chord,
        rootMidi: wholeInfer.rootMidi
      });
    }
  }

  return out;
}

const ROMAN_UPPER = ['I', 'bII', 'II', 'bIII', 'III', 'IV', 'bV', 'V', 'bVI', 'VI', 'bVII', 'VII'];
const ROMAN_LOWER = ['i', 'bii', 'ii', 'biii', 'iii', 'iv', 'bv', 'v', 'bvi', 'vi', 'bvii', 'vii'];

export function romanNumeral(chord, key, nextChord = null) {
  if (!chord || !key) return '';
  const tonic = ((key.tonic % 12) + 12) % 12;
  const rel = ((chord.root - tonic) % 12 + 12) % 12;
  const def = CHORD_TYPES[chord.type] || CHORD_TYPES.maj;

  if (nextChord) {
    const secTarget = getSecondaryDominantTarget(chord, key, nextChord);
    if (secTarget) {
      const domTag = (chord.type === '7' || chord.type === '9') ? 'V7' : 'V';
      return `${domTag}/${secTarget.targetRoman}`;
    }
  }

  const isMinorLike = def.quality === 'minor' || def.quality === 'dim';
  const isPower = chord.type === '5';

  let useLower = isMinorLike;
  if (isPower) {
    if (key.mode === 'minor') {
      useLower = [0, 2, 5, 7].includes(rel);
    } else {
      useLower = [2, 4, 9, 11].includes(rel);
    }
  }

  let base = useLower ? ROMAN_LOWER[rel] : ROMAN_UPPER[rel];
  if (chord.type === 'dim') base += '°';
  else if (chord.type === 'dim7') base += '°7';
  else if (chord.type === 'm7b5') base += 'ø7';
  else if (chord.type === '7' || chord.type === '9') base += chord.type;
  else if (chord.type === 'maj7') base += 'maj7';
  else if (chord.type === 'm7') base += '7';

  return base;
}

function getSecondaryDominantTarget(chord, key, nextChord = null) {
  const tonic = ((key.tonic % 12) + 12) % 12;
  const rel = ((chord.root - tonic) % 12 + 12) % 12;
  const def = CHORD_TYPES[chord.type] || CHORD_TYPES.maj;
  const isMajOrDom = (def.quality === 'major' || def.quality === 'dom') && chord.type !== 'maj7';
  if (!isMajOrDom) return null;

  // Primary dominant V / V7 is not a secondary dominant
  if (rel === 7) return null;
  // Plain major I in major key is tonic, unless it is I7 pulling to IV
  if (key.mode === 'major' && rel === 0 && def.quality !== 'dom') return null;

  const targetPc = (chord.root + 5) % 12; // chord is a fifth above targetPc
  const targetRel = (targetPc - tonic + 12) % 12;
  const spell = NOTE_NAMES.forKey(tonic, key.mode);

  if (nextChord) {
    const nextRoot = ((nextChord.root % 12) + 12) % 12;
    if (nextRoot !== targetPc) return null;
    // In minor, plain diatonic bVII -> bIII or bIII -> bVI are natural diatonic motions unless dom7
    if (key.mode === 'minor' && def.quality !== 'dom' && ((rel === 10 && targetRel === 3) || (rel === 3 && targetRel === 8))) {
      return null;
    }
    const targetRoman = romanNumeral(nextChord, key, null);
    return {
      targetPc,
      targetName: nextChord.name || spell[targetPc],
      targetRoman
    };
  }

  // Without nextChord, infer secondary dominant only when chord is chromatic or dom7 targeting a diatonic non-diminished degree
  const diatonicTargets = key.mode === 'minor'
    ? new Map([[3, 'bIII'], [5, 'iv'], [7, 'V'], [8, 'bVI'], [10, 'bVII']])
    : new Map([[2, 'ii'], [4, 'iii'], [5, 'IV'], [7, 'V'], [9, 'vi']]);

  if (!diatonicTargets.has(targetRel)) return null;

  const inNaturalScale = (key.mode === 'minor' ? SCALES['natural minor'] : SCALES['major']).includes(rel);
  if (inNaturalScale && def.quality !== 'dom') return null;

  const targetRoman = diatonicTargets.get(targetRel);
  const isMinorTarget = targetRoman === targetRoman.toLowerCase() && !targetRoman.startsWith('b');
  return {
    targetPc,
    targetName: `${spell[targetPc]}${isMinorTarget ? 'm' : ''}`,
    targetRoman
  };
}

export function harmonicFunction(chord, key, nextChord = null) {
  if (!chord || !key) {
    return { role: 'tonic', function: 'tonic', reason: 'Establishes the home pitch center.' };
  }
  const tonic = ((key.tonic % 12) + 12) % 12;
  const rel = ((chord.root - tonic) % 12 + 12) % 12;
  const spell = NOTE_NAMES.forKey(tonic, key.mode);
  const def = CHORD_TYPES[chord.type] || CHORD_TYPES.maj;
  const rn = romanNumeral(chord, key, nextChord);
  const nextPhrase = nextChord ? ` before moving to ${nextChord.name}` : '';

  // 1. Secondary dominants (V/x)
  const secTarget = getSecondaryDominantTarget(chord, key, nextChord);
  if (secTarget) {
    const domLabel = (def.quality === 'dom') ? `V7/${secTarget.targetRoman}` : `V/${secTarget.targetRoman}`;
    const leadingTone = spell[(secTarget.targetPc + 11) % 12];
    return {
      role: 'secondary dominant',
      function: domLabel,
      roman: domLabel,
      reason: `${chord.name} (${domLabel}) acts as a secondary dominant a fifth above ${secTarget.targetName}, using ${leadingTone} to pull the ear strongly into ${secTarget.targetName}.`
    };
  }

  // 2. Major key harmonic functions
  if (key.mode === 'major') {
    if (rel === 0 && (def.quality === 'major' || chord.type === '5' || def.quality === 'sus')) {
      return {
        role: 'tonic',
        function: 'tonic',
        roman: rn,
        reason: `${chord.name} (${rn}) is the home tonic chord${nextPhrase}, giving the ear complete stability and a sense of arrival.`
      };
    }
    if (rel === 9 && def.quality === 'minor') {
      return {
        role: 'tonic',
        function: 'tonic (relative minor)',
        roman: rn,
        reason: `${chord.name} (${rn}) belongs to the tonic family as the relative minor${nextPhrase}, sharing two tones with ${spell[tonic]} while adding reflective warmth.`
      };
    }
    if (rel === 4 && def.quality === 'minor') {
      return {
        role: 'tonic',
        function: 'tonic (mediant)',
        roman: rn,
        reason: `${chord.name} (${rn}) sits in the tonic family as the mediant${nextPhrase}, bridging home stability into subdominant or relative-minor movement.`
      };
    }
    if (rel === 5 && (def.quality === 'major' || chord.type === '5' || def.quality === 'sus')) {
      return {
        role: 'subdominant',
        function: 'subdominant',
        roman: rn,
        reason: `${chord.name} (${rn}) provides classic subdominant lift away from ${spell[tonic]}${nextPhrase}, opening the harmony so the ear expects either dominant tension or a plagal return home.`
      };
    }
    if (rel === 2 && (def.quality === 'minor' || chord.type === '5')) {
      return {
        role: 'subdominant',
        function: 'subdominant (pre-dominant)',
        roman: rn,
        reason: `${chord.name} (${rn}) is the supertonic subdominant${nextPhrase}, building pre-dominant momentum that wants to fall by fifth into ${spell[(tonic + 7) % 12]}.`
      };
    }
    if (rel === 7 && (def.quality === 'major' || def.quality === 'dom' || chord.type === '5' || def.quality === 'sus')) {
      const leadingTone = spell[(tonic + 11) % 12];
      return {
        role: 'dominant',
        function: 'dominant',
        roman: rn,
        reason: `${chord.name} (${rn}) is the primary dominant${nextPhrase}, using the leading tone ${leadingTone} to create strong tension that the ear expects to resolve home to ${spell[tonic]}.`
      };
    }
    if (rel === 11 && def.quality === 'dim') {
      const leadingTone = spell[(tonic + 11) % 12];
      return {
        role: 'dominant',
        function: 'dominant (leading-tone)',
        roman: rn,
        reason: `${chord.name} (${rn}) functions as a rootless dominant built on ${leadingTone}${nextPhrase}, packing tight tritone tension that pulls upward by half step into ${spell[tonic]}.`
      };
    }

    // Borrowed from parallel minor in a major key: bVII, bVI, bIII, iv
    if (rel === 10 && (def.quality === 'major' || def.quality === 'dom' || chord.type === '5')) {
      return {
        role: 'borrowed',
        function: 'borrowed (parallel natural minor / Mixolydian)',
        roman: rn,
        reason: `${chord.name} (${rn}) is borrowed from the parallel natural minor (and Mixolydian) mode${nextPhrase}, replacing the sharp leading tone with a bold whole-step rock lift back toward ${spell[tonic]}.`
      };
    }
    if (rel === 8 && (def.quality === 'major' || chord.type === '5')) {
      return {
        role: 'borrowed',
        function: 'borrowed (parallel natural minor)',
        roman: rn,
        reason: `${chord.name} (${rn}) is borrowed from the parallel natural minor (Aeolian) mode${nextPhrase}, darkening the harmony with a dramatic, cinematic colour that pushes toward ${spell[(tonic + 10) % 12]} or ${spell[(tonic + 7) % 12]}.`
      };
    }
    if (rel === 3 && (def.quality === 'major' || chord.type === '5')) {
      return {
        role: 'borrowed',
        function: 'borrowed (parallel natural minor)',
        roman: rn,
        reason: `${chord.name} (${rn}) is borrowed from the parallel natural minor (Aeolian) mode${nextPhrase}, adding heavy blues-rock weight that likes to step into ${spell[(tonic + 5) % 12]} or drop back to ${spell[tonic]}.`
      };
    }
    if (rel === 5 && def.quality === 'minor') {
      return {
        role: 'borrowed',
        function: 'borrowed (parallel minor iv)',
        roman: rn,
        reason: `${chord.name} (${rn}) is the minor subdominant borrowed from the parallel minor mode${nextPhrase}, pulling downward by half step to the fifth of ${spell[tonic]} for a bittersweet, nostalgic ache.`
      };
    }
  }

  // 3. Minor key harmonic functions
  if (key.mode === 'minor') {
    if (rel === 0 && (def.quality === 'minor' || chord.type === '5' || def.quality === 'sus')) {
      return {
        role: 'tonic',
        function: 'tonic',
        roman: rn,
        reason: `${chord.name} (${rn}) is the minor tonic home base${nextPhrase}, grounding the progression where the ear feels settled.`
      };
    }
    if (rel === 0 && def.quality === 'major') {
      return {
        role: 'borrowed',
        function: 'borrowed (Picardy third)',
        roman: rn,
        reason: `${chord.name} (${rn}) raises the minor third to a major Picardy third${nextPhrase}, turning a dark minor home into an unexpectedly bright resolution.`
      };
    }
    if (rel === 3 && (def.quality === 'major' || chord.type === '5')) {
      return {
        role: 'tonic',
        function: 'tonic (relative major)',
        roman: rn,
        reason: `${chord.name} (${rn}) sits in the tonic family as the relative major${nextPhrase}, offering a bright, open lift without leaving the key's core notes.`
      };
    }
    if (rel === 5 && (def.quality === 'minor' || chord.type === '5')) {
      return {
        role: 'subdominant',
        function: 'subdominant',
        roman: rn,
        reason: `${chord.name} (${rn}) is the minor subdominant${nextPhrase}, deepening the minor mood and setting up forward motion into the dominant or back to ${spell[tonic]}m.`
      };
    }
    if (rel === 5 && (def.quality === 'major' || def.quality === 'dom')) {
      const dorianSixth = spell[(tonic + 9) % 12];
      return {
        role: 'borrowed',
        function: 'borrowed (Dorian IV)',
        roman: rn,
        reason: `${chord.name} (${rn}) brings Dorian colour by raising the sixth degree to ${dorianSixth}${nextPhrase}, injecting soulful, groovy brightness into the minor key.`
      };
    }
    if (rel === 2 && def.quality === 'dim') {
      return {
        role: 'subdominant',
        function: 'subdominant (pre-dominant)',
        roman: rn,
        reason: `${chord.name} (${rn}) is the diminished supertonic subdominant${nextPhrase}, packing tight tritone tension that prepares a strong cadence through ${spell[(tonic + 7) % 12]}.`
      };
    }
    if (rel === 8 && (def.quality === 'major' || chord.type === '5')) {
      const fifthNote = spell[(tonic + 7) % 12];
      return {
        role: 'subdominant',
        function: 'subdominant (submediant)',
        roman: rn,
        reason: `${chord.name} (${rn}) acts in the subdominant family a half step above ${fifthNote}${nextPhrase}, creating strong downward gravity toward ${spell[(tonic + 7) % 12]} or ${spell[(tonic + 10) % 12]}.`
      };
    }
    if (rel === 7 && (def.quality === 'major' || def.quality === 'dom')) {
      const leadingTone = spell[(tonic + 11) % 12];
      const flatSeven = spell[(tonic + 10) % 12];
      const keyLabel = `${spell[tonic]} minor`;
      return {
        role: 'dominant',
        function: 'dominant (harmonic minor)',
        roman: rn,
        reason: `${chord.name} (${rn}) is the true major dominant borrowed from harmonic minor${nextPhrase}, raising ${flatSeven} to the leading tone ${leadingTone} in ${keyLabel} so the ear expects a sharp half-step resolution into ${spell[tonic]}m.`
      };
    }
    if (rel === 7 && (def.quality === 'minor' || chord.type === '5')) {
      const leadingTone = spell[(tonic + 11) % 12];
      return {
        role: 'dominant',
        function: 'weak modal dominant (natural minor)',
        roman: rn,
        reason: `${chord.name} (${rn}) is a weak modal dominant from natural minor${nextPhrase}; without the raised leading tone ${leadingTone}, it pulls softly toward ${spell[tonic]}m rather than forcing a sharp classical cadence.`
      };
    }
    if (rel === 11 && def.quality === 'dim') {
      const leadingTone = spell[(tonic + 11) % 12];
      return {
        role: 'dominant',
        function: 'dominant (harmonic-minor leading tone)',
        roman: rn,
        reason: `${chord.name} (${rn}) is the harmonic-minor leading-tone diminished chord built on ${leadingTone}${nextPhrase}, pulling tightly by half step into ${spell[tonic]}m.`
      };
    }
    if (rel === 10 && (def.quality === 'major' || def.quality === 'dom' || chord.type === '5')) {
      return {
        role: 'dominant',
        function: 'subtonic (modal dominant)',
        roman: rn,
        reason: `${chord.name} (${rn}) is the natural-minor subtonic a whole step below ${spell[tonic]}${nextPhrase}, acting as a modal pivot that either falls back into ${spell[tonic]}m or lifts brightly into ${spell[(tonic + 3) % 12]}.`
      };
    }
  }

  return {
    role: 'chromatic',
    function: 'chromatic',
    roman: rn,
    reason: `${chord.name} (${rn}) adds chromatic voice-leading tension outside the diatonic triad set${nextPhrase}, creating colour before stepping back into the key.`
  };
}

const KNOWN_PROGRESSIONS = [
  {
    name: 'Pachelbel Canon Progression (I–V–vi–iii–IV–I–IV–V)',
    patterns: [['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V']],
    explanation: 'Walks smoothly down the bass from tonic through dominant and relative minor before climbing via IV–V back home.'
  },
  {
    name: 'Andalusian Cadence (i–bVII–bVI–V)',
    patterns: [['i', 'bVII', 'bVI', 'V']],
    explanation: 'Steps down from the minor tonic by whole step, whole step, then a half step into major V, where that final half-step drop and raised leading tone create unmistakable flamenco and rock pull back to i.'
  },
  {
    name: 'Aeolian Vamp (i–bVII–bVI–bVII)',
    patterns: [['i', 'bVII', 'bVI', 'bVII']],
    explanation: 'Descends from the minor tonic to bVI and rebounds through bVII, keeping natural-minor momentum rolling without a classical leading-tone cadence.'
  },
  {
    name: 'Minor Four-Chord Axis (i–bVI–bIII–bVII)',
    patterns: [['i', 'bVI', 'bIII', 'bVII']],
    explanation: 'Balances minor tonic gravity (i) and dark submediant weight (bVI) with the bright relative major (bIII) and subtonic lift (bVII).'
  },
  {
    name: 'Pop/Rock Axis Progression (I–V–vi–IV)',
    patterns: [['I', 'V', 'vi', 'IV']],
    explanation: 'Links tonic stability (I), dominant lift (V), relative minor emotion (vi), and plagal subdominant return (IV) in a seamless four-chord loop.'
  },
  {
    name: '50s Doo-Wop Turnaround (I–vi–IV–V)',
    patterns: [['I', 'vi', 'IV', 'V']],
    explanation: 'Drops from tonic to the relative minor before climbing through IV and V for a singing, nostalgic turnaround.'
  },
  {
    name: 'Mixolydian Rock Loop (I–bVII–IV)',
    patterns: [['I', 'bVII', 'IV']],
    explanation: 'Replaces the diatonic V chord with the borrowed flat-VII before moving to IV, giving classic rock a bold Mixolydian drive.'
  },
  {
    name: 'Aeolian Descent (i–bVII–bVI)',
    patterns: [['i', 'bVII', 'bVI']],
    explanation: 'Steps downward from the minor tonic across two whole steps to bVI, building dark natural-minor gravity.'
  },
  {
    name: 'Jazz / Pop Turnaround (ii–V–I)',
    patterns: [['ii', 'V', 'I']],
    explanation: 'Moves in falling fifths from supertonic subdominant (ii) through dominant (V) into tonic (I), the core cadential engine of jazz and pop.'
  },
  {
    name: 'Minor Turnaround (ii°–V–i)',
    patterns: [['ii', 'V', 'i'], ['ii', 'v', 'i']],
    explanation: 'Connects the half-diminished supertonic (ii°) through the minor-key dominant into the tonic (i).'
  },
  {
    name: 'Three-Chord Major Backbone (I–IV–V)',
    patterns: [['I', 'IV', 'V']],
    explanation: 'The foundational three-chord pillars of rock, folk, and blues built on tonic (I), subdominant (IV), and dominant (V).'
  },
  {
    name: 'Natural Minor Three-Chord (i–iv–v)',
    patterns: [['i', 'iv', 'v']],
    explanation: 'Uses purely diatonic natural-minor chords on degrees 1, 4, and 5 for a moody, modal progression without a raised leading tone.'
  },
  {
    name: 'Dorian Vamp (i–IV)',
    patterns: [['i', 'IV']],
    explanation: 'Alternates between the minor tonic (i) and a bright major IV chord borrowed from Dorian, highlighting the raised 6th for a soulful groove.'
  }
];

function stripRomanSuffix(rn) {
  return rn.replace(/(maj7|ø7|°7|°|sus2|sus4|add9|7|9|6)$/g, '');
}

function detectTwelveBarBlues(song, chords, key) {
  if (!song || !Array.isArray(song.bars) || song.bars.length < 12 || !chords || chords.length === 0) {
    return null;
  }

  const tonic = ((key.tonic % 12) + 12) % 12;
  const barChords = new Array(song.bars.length).fill(null);
  for (const c of chords) {
    if (c.bar >= 0 && c.bar < barChords.length && !barChords[c.bar]) {
      barChords[c.bar] = c.chord;
    }
  }

  for (let start = 0; start <= barChords.length - 12; start++) {
    const slice = barChords.slice(start, start + 12);
    if (slice.some((c) => !c)) continue;

    const rels = slice.map((c) => ((c.root - tonic) % 12 + 12) % 12);
    const qualities = slice.map((c) => (CHORD_TYPES[c.type] || CHORD_TYPES.maj).quality);
    if (qualities.some((q) => q === 'dim' || q === 'aug')) continue;

    // Bars 1-4: I I I I or quick-change I IV I I
    const bars1to4Ok =
      rels[0] === 0 &&
      (rels[1] === 0 || rels[1] === 5) &&
      rels[2] === 0 &&
      rels[3] === 0;

    // Bars 5-6: IV IV
    const bars5to6Ok = rels[4] === 5 && rels[5] === 5;

    // Bars 7-8: I I
    const bars7to8Ok = rels[6] === 0 && rels[7] === 0;

    // Bars 9-10: V IV (standard) or bVI V (minor blues variant)
    const bars9to10Ok =
      (rels[8] === 7 && rels[9] === 5) ||
      (rels[8] === 8 && rels[9] === 7);

    // Bars 11-12: I I or I V turnaround
    const bars11to12Ok = rels[10] === 0 && (rels[11] === 0 || rels[11] === 7);

    if (bars1to4Ok && bars5to6Ok && bars7to8Ok && bars9to10Ok && bars11to12Ok) {
      const isQuickChange = rels[1] === 5;
      const isMinorBlues = qualities[0] === 'minor' || (key.mode === 'minor' && qualities[0] === 'power');
      const variantNotes = [];
      if (isMinorBlues) variantNotes.push('Minor');
      if (isQuickChange) variantNotes.push('Quick-Change');
      const prefix = variantNotes.length > 0 ? `${variantNotes.join(' ')} ` : '';
      return {
        name: `${prefix}12-Bar Blues`,
        explanation: isMinorBlues
          ? 'Follows the classic 12-bar minor blues form across three 4-bar phrases: four bars of tonic i, two bars of iv returning to i, and a turnaround through the dominant before resolving home.'
          : 'Follows the classic 12-bar blues architecture across three 4-bar phrases: four bars anchoring on I, two bars shifting to IV and back to I, and a V–IV–I turnaround.'
      };
    }
  }

  return null;
}

function matchKnownProgression(progression) {
  if (!progression || progression.length < 2) return null;
  const clean = progression.map(stripRomanSuffix);
  const n = clean.length;

  // Build all rotations of the deduplicated loop
  const rotations = [];
  for (let r = 0; r < n; r++) {
    rotations.push([...clean.slice(r), ...clean.slice(0, r)]);
  }

  // Sort patterns longest-first so 8-chord and 4-chord matches beat 3-chord sub-patterns
  const candidates = [];
  for (const kp of KNOWN_PROGRESSIONS) {
    for (const pat of kp.patterns) {
      candidates.push({ kp, pat, len: pat.length });
    }
  }
  candidates.sort((a, b) => b.len - a.len);

  // Pass 1: exact match against the deduplicated loop or any rotation of it
  for (const { kp, pat, len } of candidates) {
    if (len !== n) continue;
    const target = pat.join('-');
    for (let r = 0; r < rotations.length; r++) {
      if (rotations[r].join('-') === target) {
        const rotNote = r > 0 ? ` (rotated as ${clean.join('–')})` : '';
        return {
          name: `${kp.name}${rotNote}`,
          explanation: kp.explanation
        };
      }
    }
  }

  // Pass 2: contiguous sub-pattern match within any rotation of the loop (longest-first)
  for (const { kp, pat, len } of candidates) {
    if (len > n) continue;
    const target = pat.join('-');
    for (const rot of rotations) {
      for (let i = 0; i <= rot.length - len; i++) {
        if (rot.slice(i, i + len).join('-') === target) {
          return {
            name: kp.name,
            explanation: kp.explanation
          };
        }
      }
    }
  }

  return null;
}

function classifyNoteValue(dt, beatDur) {
  if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(beatDur) || beatDur <= 0) {
    return 'eighth notes';
  }
  const ratio = dt / beatDur;
  if (ratio >= 3.5) return 'whole notes';
  if (ratio >= 1.75) return 'half notes';
  if (ratio >= 1.35) return 'dotted quarter notes';
  if (ratio >= 0.85) return 'quarter notes';
  if (ratio >= 0.65) return 'dotted eighth notes';
  if (ratio >= 0.42) return 'eighth notes';
  if (ratio >= 0.29) return 'eighth-note triplets';
  if (ratio >= 0.21) return 'sixteenth notes';
  if (ratio >= 0.14) return 'sixteenth-note triplets';
  return 'thirty-second notes';
}

function groupAttackEvents(playable) {
  if (!playable || playable.length === 0) return [];
  const sorted = [...playable].sort((a, b) => (a.t - b.t) || (a.midi - b.midi));
  const events = [];
  let cur = null;
  for (const n of sorted) {
    if (!cur || Math.abs(n.t - cur.t) >= 0.005) {
      if (cur) events.push(cur);
      cur = { t: n.t, notes: [n] };
    } else {
      cur.notes.push(n);
    }
  }
  if (cur) events.push(cur);
  return events;
}

function detectRepeats(song, chords) {
  const bars = song && Array.isArray(song.bars) ? song.bars : [];
  const playable = (song && Array.isArray(song.notes) ? song.notes : []).filter((n) => !n.dead && !n.tie);
  if (bars.length < 4 || playable.length < 4) return [];

  const barSigs = bars.map((bar, idx) => {
    const bNotes = playable
      .filter((n) => n.t >= bar.t - 0.01 && n.t < bar.t + bar.dur - 0.01)
      .sort((a, b) => (a.t - b.t) || (a.midi - b.midi));
    const exactSig = bNotes
      .map((n) => `${Math.round(((n.t - bar.t) / Math.max(0.1, bar.dur)) * 16)}:${n.midi}`)
      .join('|');
    const pcSet = new Set(bNotes.map((n) => ((n.midi % 12) + 12) % 12));
    const lowest = bNotes.length > 0 ? bNotes.reduce((low, n) => (n.midi < low.midi ? n : low), bNotes[0]) : null;
    const bassPc = lowest ? ((lowest.midi % 12) + 12) % 12 : -1;
    const barChord = chords.find((c) => c.bar === idx);
    return {
      idx,
      noteCount: bNotes.length,
      exactSig,
      pcSet,
      bassPc,
      chordRoot: barChord ? barChord.chord.root : bassPc
    };
  });

  const repeats = [];
  const blockSizes = [4, 2].filter((sz) => sz * 2 <= bars.length);
  const coveredTargets = new Set();

  for (const sz of blockSizes) {
    for (let i = 0; i <= bars.length - sz * 2; i++) {
      for (let j = i + sz; j <= bars.length - sz; j++) {
        let alreadyCovered = false;
        for (let k = 0; k < sz; k++) {
          if (coveredTargets.has(j + k)) alreadyCovered = true;
        }
        if (alreadyCovered) continue;

        let exactMatches = 0;
        let similarMatches = 0;
        let nonEmpty = 0;

        for (let k = 0; k < sz; k++) {
          const s1 = barSigs[i + k];
          const s2 = barSigs[j + k];
          if (s1.noteCount === 0 && s2.noteCount === 0) continue;
          nonEmpty++;
          if (s1.exactSig === s2.exactSig && s1.exactSig.length > 0) {
            exactMatches++;
            similarMatches++;
          } else if (
            s1.noteCount > 0 &&
            s2.noteCount > 0 &&
            (s1.chordRoot === s2.chordRoot || s1.bassPc === s2.bassPc)
          ) {
            let shared = 0;
            for (const pc of s1.pcSet) {
              if (s2.pcSet.has(pc)) shared++;
            }
            const unionSize = new Set([...s1.pcSet, ...s2.pcSet]).size;
            if (unionSize > 0 && shared / unionSize >= 0.45) {
              similarMatches++;
            }
          }
        }

        if (nonEmpty >= Math.max(2, sz - 1) && similarMatches >= Math.max(2, sz - 1)) {
          const exact = exactMatches === nonEmpty && nonEmpty === sz;
          repeats.push({
            bars: [j + 1, j + sz],
            of: [i + 1, i + sz],
            exact
          });
          for (let k = 0; k < sz; k++) coveredTargets.add(j + k);
        }
      }
    }
  }

  return repeats;
}

export function analyzeSong(song) {
  const playable = (song && Array.isArray(song.notes) ? song.notes : []).filter((n) => !n.dead && !n.tie);
  const key = detectKey(playable);
  const spell = NOTE_NAMES.forKey(key.tonic, key.mode);
  const useFlats = spell === NOTE_NAMES.flat;
  const keyName = `${spell[key.tonic]} ${key.mode}`;

  const scales = bestScales(playable, key.tonic);
  const topScale = scales[0] ? scales[0].name : (key.mode === 'minor' ? 'natural minor' : 'major');

  const rawChords = chordsByBar(song, key);
  const chords = rawChords.map((entry, idx) => {
    const nextEntry = rawChords[idx + 1] || null;
    const nextChord = nextEntry ? nextEntry.chord : null;
    const hf = harmonicFunction(entry.chord, key, nextChord);
    const rn = hf.roman || romanNumeral(entry.chord, key, nextChord);
    return {
      ...entry,
      roman: rn,
      role: hf.role,
      function: hf.function,
      reason: hf.reason
    };
  });

  const rawNumerals = chords.map((c) => c.roman).filter(Boolean);
  const deduped = [];
  for (const rn of rawNumerals) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== rn) {
      deduped.push(rn);
    }
  }

  let progression = deduped;
  if (deduped.length >= 4 && deduped.length % 2 === 0) {
    const half = deduped.length / 2;
    const firstH = deduped.slice(0, half).join(',');
    const secondH = deduped.slice(half).join(',');
    if (firstH === secondH) {
      progression = deduped.slice(0, half);
    }
  }

  const knownProgression =
    detectTwelveBarBlues(song, chords, key) ||
    matchKnownProgression(progression);

  const usedPitchClasses = Array.from(
    new Set(playable.map((n) => ((n.midi % 12) + 12) % 12))
  ).sort((a, b) => a - b);

  const scaleSet = new Set((SCALES[topScale] || SCALES['natural minor']).map((iv) => (key.tonic + iv) % 12));
  const outsideNotes = [];
  const seenOutside = new Set();

  for (const n of playable) {
    const pc = ((n.midi % 12) + 12) % 12;
    if (!scaleSet.has(pc) && !seenOutside.has(pc)) {
      seenOutside.add(pc);
      const rel = ((pc - key.tonic) % 12 + 12) % 12;
      let reason = 'Chromatic passing tone adding momentary tension between scale degrees.';
      if (rel === 6) {
        reason = 'The flat-5 "blue note", injecting bluesy grit between the 4th and 5th degrees.';
      } else if (rel === 11 && key.mode === 'minor') {
        reason = 'Raised 7th leading tone (harmonic minor pull) resolving strongly up by half-step into the tonic.';
      } else if (rel === 9 && key.mode === 'minor') {
        reason = 'Dorian major 6th degree brightening the minor tonality.';
      } else if (rel === 10 && key.mode === 'major') {
        reason = 'Flat-7th degree adding Mixolydian/blues warmth.';
      }
      outsideNotes.push({
        pc,
        note: spell[pc],
        intervalSemitones: rel,
        explanation: reason
      });
    }
  }

  const fretted = playable.filter((n) => n.fret > 0);
  let minFret = 0;
  let maxFret = 4;
  let avgFret = 2;
  if (fretted.length > 0) {
    minFret = Math.min(...fretted.map((n) => n.fret));
    maxFret = Math.max(...fretted.map((n) => n.fret));
    avgFret = fretted.reduce((s, n) => s + n.fret, 0) / fretted.length;
  }
  const positions = {
    minFret,
    maxFret,
    anchorFret: Math.max(1, Math.round(avgFret) - 1),
    label: maxFret <= 4
      ? 'Open / First Position (frets 0–4)'
      : `Position around Fret ${Math.max(1, Math.round(avgFret) - 1)} (frets ${minFret}–${maxFret})`
  };

  // --- Detailed Stats & Musical Facts ---
  const bars = song && Array.isArray(song.bars) ? song.bars : [];
  const defaultBpm = (song && song.bpm) || 120;
  const events = groupAttackEvents(playable);

  // 1. Pentatonic share & extra scale note durations
  const pentatonicName = key.mode === 'minor' ? 'minor pentatonic' : 'major pentatonic';
  const pentSet = new Set(SCALES[pentatonicName].map((iv) => (key.tonic + iv) % 12));
  let totalNoteDur = 0;
  let pentNoteDur = 0;
  const pcDurMap = new Float64Array(12);
  for (const n of playable) {
    const pc = ((n.midi % 12) + 12) % 12;
    const d = Math.max(0.05, Number(n.dur) || 0.25);
    totalNoteDur += d;
    pcDurMap[pc] += d;
    if (pentSet.has(pc)) pentNoteDur += d;
  }
  const pentatonicShare = totalNoteDur > 0 ? Number((pentNoteDur / totalNoteDur).toFixed(3)) : 1;

  // 2. Tonic bass share & start/end tonic bars
  let tonicBassEvents = 0;
  for (const ev of events) {
    const lowest = ev.notes.reduce((low, n) => (n.midi < low.midi ? n : low), ev.notes[0]);
    if (((lowest.midi % 12) + 12) % 12 === key.tonic) {
      tonicBassEvents++;
    }
  }
  const tonicBassShare = events.length > 0 ? Number((tonicBassEvents / events.length).toFixed(3)) : 0;

  const tonicStartBars = [];
  let endsOnTonic = false;
  let lastNonEmptyBar = -1;
  for (let bIdx = 0; bIdx < bars.length; bIdx++) {
    const bar = bars[bIdx];
    const bNotes = playable.filter((n) => n.t >= bar.t - 0.01 && n.t < bar.t + bar.dur - 0.01);
    if (bNotes.length === 0) continue;
    lastNonEmptyBar = bIdx;
    const firstT = Math.min(...bNotes.map((n) => n.t));
    const firstNotes = bNotes.filter((n) => Math.abs(n.t - firstT) < 0.01);
    const firstBass = firstNotes.reduce((low, n) => (n.midi < low.midi ? n : low), firstNotes[0]);
    if (((firstBass.midi % 12) + 12) % 12 === key.tonic) {
      tonicStartBars.push(bIdx + 1);
    }
    const lastT = Math.max(...bNotes.map((n) => n.t));
    const lastNotes = bNotes.filter((n) => Math.abs(n.t - lastT) < 0.01);
    const lastBass = lastNotes.reduce((low, n) => (n.midi < low.midi ? n : low), lastNotes[0]);
    endsOnTonic = (((lastBass.midi % 12) + 12) % 12 === key.tonic) ||
      lastNotes.some((n) => ((n.midi % 12) + 12) % 12 === key.tonic);
  }

  // 3. Chord tones vs passing tones on strong beats
  let strongBeatNotes = 0;
  let strongBeatChordTones = 0;
  const passingExamples = [];
  for (const n of playable) {
    const seg = chords.find((c) => n.t >= c.t - 0.01 && n.t < c.t + c.dur - 0.01);
    if (!seg || !seg.chord) continue;
    const bar = bars[seg.bar] || { t: 0, dur: 2, num: 4, den: 4, bpm: defaultBpm };
    const beatDur = (60 / (bar.bpm || defaultBpm)) * (4 / (bar.den || 4));
    const beatPos = (n.t - bar.t) / Math.max(0.05, beatDur);
    const nearestBeat = Math.round(beatPos);
    const isOnBeat = Math.abs(beatPos - nearestBeat) <= 0.12;
    const isStrongBeat = isOnBeat && ((bar.num || 4) === 4 ? (nearestBeat % 2 === 0) : (nearestBeat === 0));

    const def = CHORD_TYPES[seg.chord.type] || CHORD_TYPES.maj;
    const tonePcs = new Set(def.intervals.map((iv) => (seg.chord.root + iv) % 12));
    const pc = ((n.midi % 12) + 12) % 12;
    const isChordTone = tonePcs.has(pc);

    if (isStrongBeat) {
      strongBeatNotes++;
      if (isChordTone) strongBeatChordTones++;
    }
    if (!isChordTone && passingExamples.length < 3) {
      const label = `${spell[pc]} in bar ${seg.bar + 1}`;
      if (!passingExamples.includes(label)) passingExamples.push(label);
    }
  }
  const chordToneShare = strongBeatNotes > 0 ? Number((strongBeatChordTones / strongBeatNotes).toFixed(3)) : 0;

  // 4. Rhythm: modal note value, syncopation, densest/sparsest bars
  let offBeatEvents = 0;
  const spacingCounts = new Map();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const bIdx = bars.findIndex((b) => ev.t >= b.t - 0.01 && ev.t < b.t + b.dur - 0.01);
    const bar = bIdx >= 0 ? bars[bIdx] : (bars[0] || { t: 0, dur: 2, bpm: defaultBpm, den: 4 });
    const beatDur = (60 / (bar.bpm || defaultBpm)) * (4 / (bar.den || 4));
    const beatPos = (ev.t - bar.t) / Math.max(0.05, beatDur);
    if (Math.abs(beatPos - Math.round(beatPos)) > 0.12) {
      offBeatEvents++;
    }
    if (i + 1 < events.length) {
      const dt = events[i + 1].t - ev.t;
      if (dt > 0.015 && dt <= beatDur * 4.5) {
        const nv = classifyNoteValue(dt, beatDur);
        spacingCounts.set(nv, (spacingCounts.get(nv) || 0) + 1);
      }
    }
  }
  const syncopation = events.length > 0 ? Number((offBeatEvents / events.length).toFixed(3)) : 0;
  let noteValue = 'eighth notes';
  let maxSpacingCount = -1;
  for (const [nv, count] of spacingCounts.entries()) {
    if (count > maxSpacingCount) {
      maxSpacingCount = count;
      noteValue = nv;
    }
  }

  let densestBar = 1;
  let maxBarEvents = -1;
  let sparsestBar = 1;
  let minBarEvents = Infinity;
  const barDifficulties = [];

  for (let bIdx = 0; bIdx < bars.length; bIdx++) {
    const bar = bars[bIdx];
    const bNotes = playable.filter((n) => n.t >= bar.t - 0.01 && n.t < bar.t + bar.dur - 0.01);
    const bEvents = events.filter((ev) => ev.t >= bar.t - 0.01 && ev.t < bar.t + bar.dur - 0.01);
    if (bEvents.length > 0) {
      if (bEvents.length > maxBarEvents) {
        maxBarEvents = bEvents.length;
        densestBar = bIdx + 1;
      }
      if (bEvents.length < minBarEvents) {
        minBarEvents = bEvents.length;
        sparsestBar = bIdx + 1;
      }
    }

    // Difficulty score per bar
    let fretJumpCost = 0;
    const frettedInBar = bNotes.filter((n) => n.fret > 0);
    for (let k = 1; k < frettedInBar.length; k++) {
      const jump = Math.abs(frettedInBar[k].fret - frettedInBar[k - 1].fret);
      if (jump >= 2) fretJumpCost += jump * 0.7;
    }
    const techCount = bNotes.filter((n) => Boolean(n.tech) || Number(n.bend) > 0).length;
    const multiNoteEvents = bEvents.filter((ev) => ev.notes.length >= 2).length;
    const diffScore = bNotes.length + fretJumpCost + techCount * 1.5 + multiNoteEvents * 0.8;
    barDifficulties.push({
      barNum: bIdx + 1,
      score: diffScore,
      noteCount: bNotes.length,
      fretJumpCost,
      techCount
    });
  }

  barDifficulties.sort((a, b) => b.score - a.score);
  const hardestBarObj = barDifficulties[0] || { barNum: 1, score: 0, noteCount: 0, fretJumpCost: 0, techCount: 0 };
  const hardestBar = bars.length > 0 ? hardestBarObj.barNum : 0;

  // 5. Range & techniques
  let minMidi = Infinity;
  let maxMidi = -Infinity;
  const stringsUsedSet = new Set();
  const techniques = { h: 0, p: 0, slide: 0, bend: 0, vib: 0 };
  const techLocations = { h: [], p: [], slide: [], bend: [], vib: [] };
  const openStringCounts = new Map();

  for (const n of playable) {
    if (n.midi < minMidi) minMidi = n.midi;
    if (n.midi > maxMidi) maxMidi = n.midi;
    if (Number.isFinite(n.string)) stringsUsedSet.add(n.string);

    const bIdx = bars.findIndex((b) => n.t >= b.t - 0.01 && n.t < b.t + b.dur - 0.01);
    const barNum = bIdx >= 0 ? bIdx + 1 : 1;

    if (n.fret === 0) {
      const openName = spell[((n.midi % 12) + 12) % 12];
      openStringCounts.set(openName, (openStringCounts.get(openName) || 0) + 1);
    }

    const tech = String(n.tech || '').toLowerCase();
    if (tech === 'h' || tech === 'hammer') {
      techniques.h++;
      if (!techLocations.h.includes(barNum)) techLocations.h.push(barNum);
    } else if (tech === 'p' || tech === 'pull') {
      techniques.p++;
      if (!techLocations.p.includes(barNum)) techLocations.p.push(barNum);
    } else if (tech === '/' || tech === '\\' || tech === 's' || tech === 'slide') {
      techniques.slide++;
      if (!techLocations.slide.includes(barNum)) techLocations.slide.push(barNum);
    } else if (tech === '~' || tech === 'v' || tech === 'vib' || tech === 'vibrato') {
      techniques.vib++;
      if (!techLocations.vib.includes(barNum)) techLocations.vib.push(barNum);
    }
    if (tech === 'b' || tech === 'bend' || Number(n.bend) > 0) {
      techniques.bend++;
      if (!techLocations.bend.includes(barNum)) techLocations.bend.push(barNum);
    }
  }

  const range = playable.length > 0
    ? {
        low: midiToName(minMidi, useFlats),
        high: midiToName(maxMidi, useFlats),
        lowMidi: minMidi,
        highMidi: maxMidi,
        semitones: maxMidi - minMidi
      }
    : { low: '', high: '', lowMidi: 0, highMidi: 0, semitones: 0 };

  const repeats = detectRepeats(song, chords);

  const stats = {
    pentatonicShare,
    chordToneShare,
    tonicBassShare,
    syncopation,
    noteValue,
    range,
    techniques,
    hardestBar,
    repeats
  };

  // --- Build 6-10 Specific Teacher-Voice Insights ---
  const insights = [];
  const relSpell = NOTE_NAMES.forKey(key.relative.tonic, key.relative.mode);
  const relName = `${relSpell[key.relative.tonic]} ${key.relative.mode}`;

  // 1. Home base
  if (playable.length >= 2) {
    const startBarsDesc = tonicStartBars.length > 0
      ? `bars ${tonicStartBars.join(', ')} kick off with ${spell[key.tonic]} in the bass`
      : `the phrasing repeatedly gravitates back toward ${spell[key.tonic]}`;
    const endDesc = lastNonEmptyBar >= 0
      ? (endsOnTonic
          ? `and bar ${lastNonEmptyBar + 1} resolves cleanly onto ${spell[key.tonic]}.`
          : `while bar ${lastNonEmptyBar + 1} leaves the ending open rather than landing on ${spell[key.tonic]}.`)
      : '';
    insights.push(
      `Home Base: The piece centers on ${keyName} (${Math.round(key.confidence * 100)}% confidence, relative ${relName}), with ${spell[key.tonic]} anchoring ${Math.round(tonicBassShare * 100)}% of bass attacks. Specifically, ${startBarsDesc}, ${endDesc}`.trim()
    );
  }

  // 2. The skeleton
  if (playable.length >= 2) {
    const extraPentDetails = [];
    for (let pc = 0; pc < 12; pc++) {
      if (pcDurMap[pc] > 0 && !pentSet.has(pc)) {
        const rel = ((pc - key.tonic) % 12 + 12) % 12;
        const pct = Math.max(1, Math.round((pcDurMap[pc] / totalNoteDur) * 100));
        const nName = spell[pc];
        let roleDesc = 'adds passing colour outside the pentatonic box';
        if (rel === 2) roleDesc = 'the 2nd degree, adding stepwise melodic movement';
        else if (rel === 8 && key.mode === 'minor') roleDesc = `the flat-6th, creating a dark half-step pull down into the 5th (${spell[(key.tonic + 7) % 12]})`;
        else if (rel === 11 && key.mode === 'minor') roleDesc = `the raised 7th leading tone, pulling up by half step into ${spell[key.tonic]}`;
        else if (rel === 6) roleDesc = 'the flat-5th blue note, injecting gritty blues tension';
        else if (rel === 9 && key.mode === 'minor') roleDesc = 'the major 6th, adding Dorian brightness';
        else if (rel === 10 && key.mode === 'major') roleDesc = 'the flat-7th, adding Mixolydian/blues swagger';
        else if (rel === 5 && key.mode === 'major') roleDesc = 'the 4th degree, softening the pentatonic into full major lyricism';
        else if (rel === 1) roleDesc = 'the flat-2nd, adding Phrygian tension';
        extraPentDetails.push(`${nName} (${pct}% of note time — ${roleDesc})`);
      }
    }

    if (extraPentDetails.length > 0) {
      insights.push(
        `The Skeleton: ${Math.round(pentatonicShare * 100)}% of the note duration sits inside ${spell[key.tonic]} ${pentatonicName}, giving you a familiar five-note fretboard anchor. Beyond that skeleton, the riff brings in ${extraPentDetails.join('; ')}.`
      );
    } else {
      insights.push(
        `The Skeleton: 100% of the note duration stays inside ${spell[key.tonic]} ${pentatonicName}, keeping every phrase punchy and consonant. You can visualize the entire part inside one standard five-note box pattern without worrying about clash notes.`
      );
    }
  }

  // 3. Chord tones vs passing tones
  if (chords.length > 0 && strongBeatNotes >= 2) {
    const passingSentence = passingExamples.length > 0
      ? `Non-chord tones like ${passingExamples.join(' and ')} appear on weaker subdivisions to connect the chord shapes smoothly.`
      : `Every main rhythmic pulse locks directly onto a chord tone, making the harmony unmistakable even on single-note lines.`;
    insights.push(
      `Chord Tones vs. Passing Tones: ${Math.round(chordToneShare * 100)}% of notes on strong beats are chord tones of the underlying bar harmony. ${passingSentence}`
    );
  }

  // 4. Root movement
  const dedupedChordObjs = [];
  for (const c of chords) {
    if (dedupedChordObjs.length === 0 || dedupedChordObjs[dedupedChordObjs.length - 1].chord.name !== c.chord.name) {
      dedupedChordObjs.push(c);
    }
  }
  if (dedupedChordObjs.length >= 2) {
    const moves = [];
    for (let i = 0; i < dedupedChordObjs.length - 1; i++) {
      const a = dedupedChordObjs[i].chord;
      const b = dedupedChordObjs[i + 1].chord;
      const up = (b.root - a.root + 12) % 12;
      let intervalLabel = 'a chromatic step';
      if (up === 1 || up === 2) intervalLabel = `a step up (${up === 1 ? 'half' : 'whole'} step)`;
      else if (up === 11 || up === 10) intervalLabel = `a step down (${up === 11 ? 'half' : 'whole'} step)`;
      else if (up === 5 || up === 7) intervalLabel = 'a fourth/fifth leap';
      else if (up === 3 || up === 4 || up === 8 || up === 9) intervalLabel = 'a third shift';
      else if (up === 6) intervalLabel = 'a tritone leap';
      moves.push(`${a.name} to ${b.name} (${intervalLabel})`);
    }
    const progTail = knownProgression
      ? ` Together this forms ${knownProgression.name}: ${knownProgression.explanation}`
      : ` Stepwise shifts keep the bass singing smoothly, while fourth/fifth leaps give the harmony decisive forward pull.`;
    insights.push(
      `Root Movement: The harmony moves through ${moves.slice(0, 5).join(', ')}.${progTail}`
    );
  }

  // 5. Tension and release
  if (chords.length >= 2 || outsideNotes.length > 0) {
    let peakTensionBar = 1;
    let peakTensionScore = -Infinity;
    let peakReason = 'high melodic register';

    for (let bIdx = 0; bIdx < bars.length; bIdx++) {
      const bar = bars[bIdx];
      const barChordEntries = chords.filter((c) => c.bar === bIdx);
      const bNotes = playable.filter((n) => n.t >= bar.t - 0.01 && n.t < bar.t + bar.dur - 0.01);
      if (bNotes.length === 0 && barChordEntries.length === 0) continue;

      let tScore = 0;
      const reasons = [];
      for (const ce of barChordEntries) {
        if (ce.role === 'dominant' || ce.role === 'secondary dominant') {
          tScore += ce.function.includes('weak') ? 1.5 : 3.5;
          reasons.push(`${ce.chord.name} (${ce.roman}) dominant pull`);
        } else if (ce.role === 'borrowed') {
          tScore += 2.0;
          reasons.push(`borrowed ${ce.chord.name} (${ce.roman})`);
        }
      }
      const outsideInBar = bNotes.filter((n) => !scaleSet.has(((n.midi % 12) + 12) % 12));
      if (outsideInBar.length > 0) {
        tScore += outsideInBar.length * 1.2;
        const outName = spell[((outsideInBar[0].midi % 12) + 12) % 12];
        reasons.push(`outside note ${outName}`);
      }
      const barHigh = bNotes.reduce((hi, n) => Math.max(hi, n.midi), -Infinity);
      if (barHigh === maxMidi && maxMidi > -Infinity) {
        tScore += 1.0;
        reasons.push(`melodic peak (${range.high})`);
      }

      if (tScore > peakTensionScore) {
        peakTensionScore = tScore;
        peakTensionBar = bIdx + 1;
        peakReason = reasons.join(' and ') || 'away-from-tonic harmony';
      }
    }

    const resolveEntry = chords.find((c) => (c.bar + 1) > peakTensionBar && c.role === 'tonic');
    const resolveDesc = resolveEntry
      ? `before releasing into ${resolveEntry.chord.name} in bar ${resolveEntry.bar + 1}`
      : (endsOnTonic && lastNonEmptyBar >= 0
          ? `before resolving home onto ${spell[key.tonic]} in bar ${lastNonEmptyBar + 1}`
          : `carrying that unresolved edge into the loop repeat`);

    insights.push(
      `Tension and Release: Bar ${peakTensionBar} holds the peak harmonic tension via ${peakReason}, ${resolveDesc}. Lean slightly into that bar dynamically so the release feels earned.`
    );
  }

  // 6. Rhythm and feel
  if (events.length >= 4) {
    const densityNote = densestBar !== sparsestBar && minBarEvents < Infinity
      ? `Bar ${densestBar} is the busiest with ${maxBarEvents} attacks, while bar ${sparsestBar} opens up with just ${minBarEvents} attacks to give the groove breathing room.`
      : `The rhythmic density stays steady across bars at roughly ${maxBarEvents} attacks per bar.`;
    insights.push(
      `Rhythm and Feel: At ${defaultBpm} BPM, the primary rhythmic grid moves in ${noteValue}, with ${Math.round(syncopation * 100)}% of attacks landing off the beat. ${densityNote}`
    );
  }

  // 7. Shape and repetition
  if (bars.length >= 2 && playable.length >= 4) {
    let repeatSentence = '';
    if (repeats.length > 0) {
      const r = repeats[0];
      const targetRange = r.bars[0] === r.bars[1] ? `bar ${r.bars[0]}` : `bars ${r.bars[0]}–${r.bars[1]}`;
      const srcRange = r.of[0] === r.of[1] ? `bar ${r.of[0]}` : `bars ${r.of[0]}–${r.of[1]}`;
      const targetNotes = playable.filter((n) => {
        const bStart = bars[r.bars[0] - 1]?.t ?? 0;
        const bEnd = (bars[r.bars[1] - 1]?.t ?? 0) + (bars[r.bars[1] - 1]?.dur ?? 0);
        return n.t >= bStart - 0.01 && n.t < bEnd - 0.01;
      }).length;
      const srcNotes = playable.filter((n) => {
        const bStart = bars[r.of[0] - 1]?.t ?? 0;
        const bEnd = (bars[r.of[1] - 1]?.t ?? 0) + (bars[r.of[1] - 1]?.dur ?? 0);
        return n.t >= bStart - 0.01 && n.t < bEnd - 0.01;
      }).length;
      const variationKind = r.exact
        ? 'repeat'
        : (targetNotes > srcNotes ? 'restate' : 'vary');
      const suffix = r.exact
        ? 'verbatim'
        : (targetNotes > srcNotes ? 'with fuller chords and added articulation' : 'with rhythmic variation');
      repeatSentence = `Structurally, ${targetRange} ${variationKind} ${srcRange} ${suffix}. `;
    }
    insights.push(
      `Shape and Repetition: ${repeatSentence}The part spans ${range.semitones} semitones from ${range.low} up to ${range.high} across ${stringsUsedSet.size} of ${song.tuning.length} strings, sitting primarily in ${positions.label}.`
    );
  }

  // 8. Technique and open strings
  const totalTechs = techniques.h + techniques.p + techniques.slide + techniques.bend + techniques.vib;
  const pedalOpens = Array.from(openStringCounts.entries()).filter(([, cnt]) => cnt >= 3);
  if (totalTechs > 0 || pedalOpens.length > 0) {
    const parts = [];
    if (techniques.h > 0) parts.push(`${techniques.h} hammer-on${techniques.h > 1 ? 's' : ''} (bars ${techLocations.h.join(', ')})`);
    if (techniques.p > 0) parts.push(`${techniques.p} pull-off${techniques.p > 1 ? 's' : ''} (bars ${techLocations.p.join(', ')})`);
    if (techniques.slide > 0) parts.push(`${techniques.slide} slide${techniques.slide > 1 ? 's' : ''} (bars ${techLocations.slide.join(', ')})`);
    if (techniques.bend > 0) parts.push(`${techniques.bend} bend${techniques.bend > 1 ? 's' : ''} (bars ${techLocations.bend.join(', ')})`);
    if (techniques.vib > 0) parts.push(`${techniques.vib} vibrato note${techniques.vib > 1 ? 's' : ''} (bars ${techLocations.vib.join(', ')})`);

    const techSentence = parts.length > 0
      ? `Articulation relies on ${parts.join(', ')}—keep your fretting hand relaxed so slurs stay even in volume.`
      : `All notes are cleanly picked without slurs, putting the focus on crisp right-hand timing.`;
    const openSentence = pedalOpens.length > 0
      ? ` Open strings (${pedalOpens.map(([name, cnt]) => `${name} struck ${cnt}x`).join(', ')}) act as ringing pedal anchors while your fretting fingers move above them.`
      : '';
    insights.push(`Technique and Open Strings: ${techSentence}${openSentence}`);
  }

  // 9. What to practise first
  if (playable.length >= 3 && hardestBar > 0) {
    const startBpm = Math.max(40, Math.round(defaultBpm * 0.75));
    const whyHard = hardestBarObj.techCount > 0
      ? 'its slur articulation and chord voicings'
      : (hardestBarObj.fretJumpCost > 0
          ? 'its fretboard position shifts'
          : 'its higher note density');
    insights.push(
      `What to Practise First: Isolate bar ${hardestBar} first—it is the trickiest measure due to ${whyHard}—and loop it at ${startBpm} BPM (75% of ${defaultBpm} BPM). Build the full arrangement in three passes: start with Level 1 (Roots) to internalize the chord changes, step up to Level 2 (Bass Line) to lock in the downbeats, and then play Level 3 (Full Part) once the shifts feel automatic.`
    );
  }

  return {
    key,
    scale: topScale,
    scales,
    chords,
    progression,
    knownProgression,
    usedPitchClasses,
    outsideNotes,
    positions,
    stats,
    insights
  };
}

export function scaleFretboard(tonic, scaleName, tuning, capo = 0, maxFret = 15) {
  const intervals = SCALES[scaleName] || SCALES['major'];
  const root = ((tonic % 12) + 12) % 12;
  const degreeMap = new Map();
  intervals.forEach((iv, idx) => {
    degreeMap.set((root + iv) % 12, idx + 1);
  });

  const out = [];
  for (let s = 0; s < tuning.length; s++) {
    const openMidi = tuning[s] + capo;
    for (let fret = 0; fret <= maxFret; fret++) {
      const midi = openMidi + fret;
      const pc = ((midi % 12) + 12) % 12;
      if (degreeMap.has(pc)) {
        out.push({
          string: s,
          fret,
          midi,
          degree: degreeMap.get(pc),
          isRoot: pc === root
        });
      }
    }
  }
  return out;
}
