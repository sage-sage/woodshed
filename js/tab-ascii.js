import { makeSong, TUNINGS } from './song.js';

const STRING_LINE_RE = /^\s*([A-Ga-g][#b]?\d?)?\s*(\|\||\|:|\||:)?([0-9hHpPsbBrvxX~\/\\\(\)<>|\-:\.\*\s]{5,})$/;

function isTabLine(rawLine) {
  const line = rawLine.trimEnd();
  if (!line || line.startsWith('#') || line.startsWith('//')) return false;
  if (/^\s*PM[\-\.|]+/i.test(line)) return false;

  const m = line.match(STRING_LINE_RE);
  if (!m) return false;
  const body = m[3];
  const dashCount = (body.match(/-/g) || []).length;
  const barCount = (body.match(/\|/g) || []).length;
  const digitCount = (body.match(/[0-9]/g) || []).length;
  const totalLen = body.trim().length;

  if (totalLen < 5) return false;
  if (dashCount < 3) return false;
  if ((dashCount + barCount + digitCount) / totalLen < 0.65) return false;
  return true;
}

export function detectTabFormat(text) {
  if (typeof text !== 'string' || !text.trim()) return 'unknown';
  const lines = text.split(/\r?\n/);
  let consecutive = 0;
  for (const line of lines) {
    if (isTabLine(line)) {
      consecutive++;
      if (consecutive >= 4) return 'ascii';
    } else {
      consecutive = 0;
    }
  }
  return 'unknown';
}

const NOTE_PC = {
  C: 0, 'C#': 1, DB: 1,
  D: 2, 'D#': 3, EB: 3,
  E: 4, FB: 4, 'E#': 5,
  F: 5, 'F#': 6, GB: 6,
  G: 7, 'G#': 8, AB: 8,
  A: 9, 'A#': 10, BB: 10,
  B: 11, CB: 11
};

function detectTuningFromLabels(labelsTopToBottom, fallbackTuning) {
  const n = labelsTopToBottom.length;
  if (fallbackTuning && fallbackTuning.length === n) {
    return [...fallbackTuning];
  }
  const bottomToTop = [...labelsTopToBottom].reverse();
  const parsedPcs = bottomToTop.map((lbl) => {
    if (!lbl) return null;
    const clean = lbl.trim().replace(/\d+$/, '').toUpperCase();
    return NOTE_PC[clean] !== undefined ? NOTE_PC[clean] : null;
  });

  if (parsedPcs.every((pc) => pc !== null)) {
    for (const preset of Object.values(TUNINGS)) {
      if (preset.length === n && preset.every((m, idx) => ((m % 12) + 12) % 12 === parsedPcs[idx])) {
        return [...preset];
      }
    }
    const basePreset = n === 4 ? TUNINGS['Bass Standard']
      : n === 7 ? TUNINGS['7-string Standard']
      : TUNINGS['Standard'];
    const custom = [];
    for (let i = 0; i < n; i++) {
      const ref = basePreset[i] !== undefined ? basePreset[i] : (40 + i * 5);
      const refPc = ((ref % 12) + 12) % 12;
      let diff = parsedPcs[i] - refPc;
      if (diff > 6) diff -= 12;
      if (diff < -6) diff += 12;
      custom.push(ref + diff);
    }
    return custom;
  }

  if (n === 4) return [...TUNINGS['Bass Standard']];
  if (n === 7) return [...TUNINGS['7-string Standard']];
  if (n === 6) return [...TUNINGS['Standard']];
  const generated = [];
  for (let i = 0; i < n; i++) generated.push(40 + i * 5);
  return generated;
}

function extractLineParts(rawLine) {
  let line = rawLine.trimEnd();
  let repeatEndCount = null;
  const repMatch = line.match(/\s+[xX](\d+)\s*$/);
  if (repMatch) {
    repeatEndCount = parseInt(repMatch[1], 10);
    line = line.slice(0, repMatch.index).trimEnd();
  }

  const labelMatch = line.match(/^\s*([A-Ga-g][#b]?\d?)?\s*(.*)$/);
  const label = labelMatch && labelMatch[1] ? labelMatch[1] : '';
  let body = labelMatch ? labelMatch[2] : line;

  return { label, body, repeatEndCount };
}

function splitSystemIntoBars(systemLines, pmLine) {
  const rawParts = systemLines.map(extractLineParts);
  let systemRepeat = 1;
  for (const p of rawParts) {
    if (p.repeatEndCount && p.repeatEndCount > 1) {
      systemRepeat = p.repeatEndCount;
    }
  }

  const maxLen = Math.max(...rawParts.map((p) => p.body.length));
  const padded = rawParts.map((p) => p.body.padEnd(maxLen, '-'));
  const pmPadded = pmLine ? pmLine.padEnd(maxLen, ' ') : ' '.repeat(maxLen);

  const barBoundaryCols = [];
  for (let c = 0; c < maxLen; c++) {
    let pipeCount = 0;
    for (let s = 0; s < padded.length; s++) {
      if (padded[s][c] === '|') pipeCount++;
    }
    if (pipeCount >= Math.ceil(padded.length / 2)) {
      barBoundaryCols.push(c);
    }
  }

  const segments = [];
  if (barBoundaryCols.length === 0) {
    for (let start = 0; start < maxLen; start += 16) {
      const end = Math.min(maxLen, start + 16);
      if (end - start >= 2) {
        segments.push({ start, end, repeatStart: false, repeatEnd: false, repeatCount: 2 });
      }
    }
  } else {
    const boundaries = [];
    let i = 0;
    while (i < barBoundaryCols.length) {
      let startCol = barBoundaryCols[i];
      let endCol = startCol;
      while (i + 1 < barBoundaryCols.length && barBoundaryCols[i + 1] === endCol + 1) {
        endCol = barBoundaryCols[++i];
      }
      boundaries.push({ startCol, endCol });
      i++;
    }

    if (boundaries[0].startCol >= 4) {
      const sliceCheck = padded[0].slice(0, boundaries[0].startCol);
      if (/[0-9xX]/.test(sliceCheck)) {
        boundaries.unshift({ startCol: -1, endCol: -1 });
      }
    }
    if (maxLen - 1 - boundaries[boundaries.length - 1].endCol >= 4) {
      const tailSlice = padded[0].slice(boundaries[boundaries.length - 1].endCol + 1);
      if (/[0-9xX]/.test(tailSlice)) {
        boundaries.push({ startCol: maxLen, endCol: maxLen });
      }
    }

    for (let b = 0; b < boundaries.length - 1; b++) {
      let segStart = boundaries[b].endCol + 1;
      let segEnd = boundaries[b + 1].startCol;
      if (segEnd - segStart < 1) continue;

      let repeatStart = false;
      let repeatEnd = false;

      const leftCol = segStart;
      let leftColons = 0;
      for (let s = 0; s < padded.length; s++) {
        if (padded[s][leftCol] === ':' || padded[s][leftCol] === '*') leftColons++;
      }
      if (leftColons >= 2) {
        repeatStart = true;
        segStart++;
      }

      const rightCol = segEnd - 1;
      let rightColons = 0;
      for (let s = 0; s < padded.length; s++) {
        if (padded[s][rightCol] === ':' || padded[s][rightCol] === '*') rightColons++;
      }
      if (rightColons >= 2) {
        repeatEnd = true;
        segEnd--;
      }

      if (segEnd > segStart) {
        segments.push({
          start: segStart,
          end: segEnd,
          repeatStart,
          repeatEnd,
          repeatCount: systemRepeat > 1 ? systemRepeat : 2
        });
      }
    }
  }

  const rawBars = segments.map((seg) => {
    const strings = padded.map((line) => line.slice(seg.start, seg.end));
    const pmSlice = pmPadded.slice(seg.start, seg.end);
    return {
      strings,
      pmSlice,
      width: seg.end - seg.start,
      repeatStart: seg.repeatStart,
      repeatEnd: seg.repeatEnd,
      repeatCount: seg.repeatCount
    };
  }).filter((bar) => bar.width >= 2 && bar.strings.some((s) => /[-0-9xX]/.test(s)));

  const expandedBars = [];
  let repeatMarkerIdx = 0;
  let hadInlineRepeat = false;

  for (let idx = 0; idx < rawBars.length; idx++) {
    const bar = rawBars[idx];
    if (bar.repeatStart) {
      repeatMarkerIdx = expandedBars.length;
    }
    expandedBars.push(bar);
    if (bar.repeatEnd) {
      hadInlineRepeat = true;
      const chunk = expandedBars.slice(repeatMarkerIdx);
      const extraPasses = Math.max(1, (bar.repeatCount || 2) - 1);
      for (let r = 0; r < extraPasses; r++) {
        for (const item of chunk) {
          expandedBars.push({ ...item });
        }
      }
      repeatMarkerIdx = expandedBars.length;
    }
  }

  if (!hadInlineRepeat && systemRepeat > 1 && expandedBars.length > 0) {
    const original = [...expandedBars];
    for (let r = 1; r < systemRepeat; r++) {
      for (const item of original) {
        expandedBars.push({ ...item });
      }
    }
  }

  return {
    labels: rawParts.map((p) => p.label),
    bars: expandedBars
  };
}

function mapTechChar(ch) {
  switch (ch) {
    case 'h':
    case 'H':
      return 'h';
    case 'p':
    case 'P':
      return 'p';
    case '/':
    case '\\':
    case 's':
    case 'S':
      return 'slide';
    case 'b':
    case 'B':
    case 'r':
    case 'R':
      return 'bend';
    case '~':
    case 'v':
      return 'vib';
    default:
      return '';
  }
}

function parseStringBarNotes(str, pmSlice, stringIndex, tuningMidi, capo, barStartSec, barDurSec) {
  const width = Math.max(1, str.length);
  const notes = [];
  let i = 0;
  let pendingTech = '';

  while (i < str.length) {
    const ch = str[i];

    if (/[hHpPsSbBrRv~\/\\]/.test(ch)) {
      const mapped = mapTechChar(ch);
      if (mapped) {
        pendingTech = mapped;
        if ((mapped === 'vib' || mapped === 'bend') && notes.length > 0 && !notes[notes.length - 1].tech) {
          notes[notes.length - 1].tech = mapped;
          pendingTech = '';
        }
      }
      i++;
      continue;
    }

    if (ch === 'x' || ch === 'X') {
      const t = barStartSec + (i / width) * barDurSec;
      notes.push({
        t,
        col: i,
        string: stringIndex,
        fret: 0,
        midi: tuningMidi + capo,
        tech: pendingTech || '',
        tie: false,
        dead: true
      });
      pendingTech = '';
      i++;
      continue;
    }

    if (ch === '(' || ch === '<') {
      const closeChar = ch === '(' ? ')' : '>';
      const closeIdx = str.indexOf(closeChar, i + 1);
      if (closeIdx > i + 1) {
        const inner = str.slice(i + 1, closeIdx);
        if (/^\d{1,2}$/.test(inner)) {
          const fret = parseInt(inner, 10);
          if (fret <= 24) {
            const col = i + 1;
            const t = barStartSec + (col / width) * barDurSec;
            const isHarm = ch === '<';
            const isPm = pmSlice && (pmSlice[col] === '-' || pmSlice[col] === '.' || /P|M/i.test(pmSlice[col]));
            notes.push({
              t,
              col,
              string: stringIndex,
              fret,
              midi: tuningMidi + capo + fret,
              tech: isHarm ? 'harm' : (pendingTech || (isPm ? 'pm' : '')),
              tie: false,
              dead: false
            });
            pendingTech = '';
            i = closeIdx + 1;
            continue;
          }
        }
      }
    }

    if (ch >= '0' && ch <= '9') {
      const col = i;
      let fret = parseInt(ch, 10);
      let consumed = 1;
      if (i + 1 < str.length && str[i + 1] >= '0' && str[i + 1] <= '9') {
        const twoDigit = parseInt(str.slice(i, i + 2), 10);
        if (twoDigit >= 10 && twoDigit <= 24) {
          fret = twoDigit;
          consumed = 2;
        }
      }

      let postTech = '';
      let bend = 0;
      const afterIdx = i + consumed;
      if (afterIdx < str.length && /[~v]/.test(str[afterIdx])) {
        postTech = 'vib';
      } else if (afterIdx < str.length && /[bB]/.test(str[afterIdx])) {
        postTech = 'bend';
        // "12b14" bends fret 12 up to the pitch of fret 14: the 14 is a target, not another note.
        // "7b" alone is taken as a whole-step bend; "7b9r7" (bend and release) is still one note.
        const m = /^[bB](\d{1,2})?(?:[rR](\d{1,2})?)?/.exec(str.slice(afterIdx));
        const target = m[1] !== undefined ? parseInt(m[1], 10) : fret + 2;
        bend = target > fret && target - fret <= 5 ? target - fret : 2;
        consumed += m[0].length;
      }

      const isPm = pmSlice && (pmSlice[col] === '-' || pmSlice[col] === '.' || /P|M/i.test(pmSlice[col]));
      const tech = pendingTech || postTech || (isPm ? 'pm' : '');
      const t = barStartSec + (col / width) * barDurSec;

      notes.push({
        t,
        col,
        string: stringIndex,
        fret,
        midi: tuningMidi + capo + fret,
        tech,
        tie: false,
        dead: false,
        ...(bend ? { bend } : {})
      });

      pendingTech = '';
      i += consumed;
      continue;
    }

    i++;
  }

  return notes;
}

export function parseAsciiTab(text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('No tab lines found. Paste lines that look like e|--0--2--|');
  }

  let bpm = Number(opts.bpm) || 120;
  const num = Number(opts.num) || 4;
  const den = Number(opts.den) || 4;
  const capo = Number(opts.capo) || 0;
  let title = opts.title || '';
  let artist = opts.artist || '';

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const tMatch = line.match(/^#?\s*Title\s*:\s*(.+)$/i);
    if (tMatch && !title) title = tMatch[1].trim();
    const aMatch = line.match(/^#?\s*Artist\s*:\s*(.+)$/i);
    if (aMatch && !artist) artist = aMatch[1].trim();
    const bMatch = line.match(/^#?\s*(?:Tempo|BPM)\s*:\s*(\d+(?:\.\d+)?)/i);
    if (bMatch && !opts.bpm) bpm = parseFloat(bMatch[1]);
  }

  const systems = [];
  let currentSystem = [];
  let pendingPmLine = null;

  for (const line of lines) {
    if (/^\s*PM[\-\.|]+/i.test(line)) {
      const m = line.match(/(PM[\-\.|]+)/i);
      if (m) pendingPmLine = line;
      continue;
    }
    if (isTabLine(line)) {
      currentSystem.push(line);
    } else {
      if (currentSystem.length >= 4 && currentSystem.length <= 8) {
        systems.push({ lines: currentSystem, pmLine: pendingPmLine });
      }
      currentSystem = [];
      pendingPmLine = null;
    }
  }
  if (currentSystem.length >= 4 && currentSystem.length <= 8) {
    systems.push({ lines: currentSystem, pmLine: pendingPmLine });
  }

  if (systems.length === 0) {
    throw new Error('No tab lines found. Paste lines that look like e|--0--2--| across 4 to 8 strings.');
  }

  const stringCount = systems[0].lines.length;
  const validSystems = systems.filter((sys) => sys.lines.length === stringCount);

  const firstSystemParsed = splitSystemIntoBars(validSystems[0].lines, validSystems[0].pmLine);
  const tuning = detectTuningFromLabels(firstSystemParsed.labels, opts.tuning);

  const beatDur = (60 / bpm) * (4 / den);
  const barDur = num * beatDur;
  const maxNoteDur = 2 * beatDur;

  const allBars = [];
  const notesByString = Array.from({ length: stringCount }, () => []);
  let currentTime = 0;

  for (let sIdx = 0; sIdx < validSystems.length; sIdx++) {
    const parsedSys = sIdx === 0
      ? firstSystemParsed
      : splitSystemIntoBars(validSystems[sIdx].lines, validSystems[sIdx].pmLine);

    for (const rawBar of parsedSys.bars) {
      const barStart = currentTime;
      const barEnd = barStart + barDur;
      allBars.push({
        t: barStart,
        dur: barDur,
        num,
        den,
        bpm
      });

      for (let lineIdx = 0; lineIdx < stringCount; lineIdx++) {
        const stringIndex = stringCount - 1 - lineIdx;
        const strText = rawBar.strings[lineIdx];
        const barNotes = parseStringBarNotes(
          strText,
          rawBar.pmSlice,
          stringIndex,
          tuning[stringIndex],
          capo,
          barStart,
          barDur
        );
        for (const n of barNotes) {
          n.barEnd = barEnd;
          notesByString[stringIndex].push(n);
        }
      }

      currentTime = barEnd;
    }
  }

  const allNotes = [];
  for (let s = 0; s < stringCount; s++) {
    const sNotes = notesByString[s].sort((a, b) => a.t - b.t);
    for (let i = 0; i < sNotes.length; i++) {
      const cur = sNotes[i];
      const nextT = i + 1 < sNotes.length ? sNotes[i + 1].t : cur.barEnd;
      const untilLimit = Math.min(nextT, cur.barEnd) - cur.t;
      const dur = Math.max(0.04, Math.min(maxNoteDur, untilLimit));
      allNotes.push({
        t: cur.t,
        dur,
        string: cur.string,
        fret: cur.fret,
        midi: cur.midi,
        tech: cur.tech,
        tie: cur.tie,
        dead: cur.dead,
        ...(cur.bend ? { bend: cur.bend } : {})
      });
    }
  }

  const quantStep = 0.005;
  allNotes.sort((a, b) => (a.t - b.t) || (a.string - b.string));
  let groupStart = 0;
  for (let i = 1; i < allNotes.length; i++) {
    if (allNotes[i].t - allNotes[groupStart].t < quantStep) {
      allNotes[i].t = allNotes[groupStart].t;
    } else {
      groupStart = i;
    }
  }

  return makeSong({
    title: title || 'Imported ASCII Tab',
    artist: artist || 'Unknown Artist',
    tuning,
    capo,
    bpm,
    notes: allNotes,
    bars: allBars,
    duration: currentTime,
    source: 'ascii',
    exactRhythm: false
  });
}
