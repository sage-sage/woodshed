const HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#039': "'",
  nbsp: ' ',
  '#160': ' '
};

const ROMAN_MAP = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12
};

const NAMED_TUNINGS = [
  [/\bdrop\s*d\b/i, 'D A D G B E'],
  [/\bdrop\s*(?:c#|db)\b/i, 'C# G# C# F# A# D#'],
  [/\bdrop\s*c\b/i, 'C G C F A D'],
  [/\bdrop\s*b\b/i, 'B F# B E G# C#'],
  [/\bdrop\s*a\b/i, 'A E A D G B E'],
  [/\b(?:half\s*step\s*down|eb\s*standard|d#\s*standard)\b/i, 'Eb Ab Db Gb Bb Eb'],
  [/\b(?:full\s*step\s*down|whole\s*step\s*down|d\s*standard)\b/i, 'D G C F A D'],
  [/\b(?:c#\s*standard|db\s*standard)\b/i, 'C# F# B E G# C#'],
  [/\b(?:c\s*standard)\b/i, 'C F Bb Eb G C'],
  [/\bdadgad\b/i, 'D A D G A D'],
  [/\bopen\s*g\b/i, 'D G D G B D'],
  [/\bopen\s*d\b/i, 'D A D F# A D'],
  [/\bopen\s*e\b/i, 'E B E G# B E'],
  [/\bopen\s*a\b/i, 'E A E A C# E'],
  [/\bstandard\b/i, 'E A D G B E']
];

const TAB_BODY_RE = /^[-0-9|hpbr/\\~x()<>.*sPHVvt^\s]+$/;
const RHYTHM_LINE_RE = /^\s*(?:[WHQEST]\.?|\d+\/\d+|♩|♪|♫|\|_+|\^)(?:\s+(?:[WHQEST]\.?|\d+\/\d+|♩|♪|♫|\|_+|\^))+\s*$/;

export function stripUgMarkup(s) {
  if (!s) return '';
  let out = String(s);
  out = out.replace(/\[\/?tab\]/gi, '');
  out = out.replace(/\[\/?ch\]/gi, '');
  out = out.replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#039|#160);/gi, (match, name) => {
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, key) ? HTML_ENTITIES[key] : match;
  });
  return out;
}

export function normalize(s) {
  if (!s) return '';
  let out = String(s).replace(/\r\n?/g, '\n');
  out = out.replace(/[\u2014\u2013\u2012\u2015\u2212]/g, '-');
  out = out.replace(/[\u2502\u2503\u00A6]/g, '|');
  out = out.replace(/\u00A0/g, ' ');
  out = out.replace(/[\u200B-\u200D\uFEFF]/g, '');

  const lines = out.split('\n').map((line) => {
    let expanded = '';
    let col = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\t') {
        const spaces = 8 - (col % 8);
        expanded += ' '.repeat(spaces);
        col += spaces;
      } else {
        expanded += ch;
        col += 1;
      }
    }
    return expanded.replace(/ +$/, '');
  });

  out = lines.join('\n');
  out = out.replace(/\n{4,}/g, '\n\n\n');
  return out;
}

export function isTabLine(line) {
  const s = String(line ?? '').trim();
  if (!s || /^[|\s]+$/.test(s)) return false;

  const mNamed = s.match(/^(?:[A-Ga-g][#b]?|[1-8])\s*([|:-])(.*)$/);
  const mUnnamed = !mNamed ? s.match(/^([|:-])(.*)$/) : null;
  const match = mNamed || mUnnamed;
  if (!match) return false;

  const delim = match[1];
  const body = match[2];
  if (!mNamed && delim === '-' && !/[|0-9]/.test(body)) return false;
  if (!TAB_BODY_RE.test(body)) return false;

  const nonSpace = body.replace(/\s+/g, '');
  if (nonSpace.length < 8) return false;

  const dashOrDigit = (nonSpace.match(/[-0-9]/g) || []).length;
  return dashOrDigit / nonSpace.length >= 0.6;
}

export function countTabLines(text) {
  const lines = String(text ?? '').split('\n');
  let maxRun = 0;
  let currentRun = 0;
  let total = 0;

  for (const line of lines) {
    if (isTabLine(line)) {
      currentRun += 1;
      total += 1;
      if (currentRun > maxRun) maxRun = currentRun;
    } else {
      currentRun = 0;
    }
  }

  return { maxRun, total };
}

function normalizeNoteName(token) {
  const m = String(token || '').trim().match(/^([A-Ga-g])([#b]?)/);
  if (!m) return '';
  return m[1].toUpperCase() + m[2];
}

function parseTuningValue(raw) {
  if (!raw) return '';
  const str = String(raw).trim();
  if (!str) return '';

  for (const [re, canonical] of NAMED_TUNINGS) {
    if (re.test(str)) return canonical;
  }

  const tokens = str.match(/\b[A-Ga-g][#b]?\d?\b/g);
  if (tokens && tokens.length >= 4 && tokens.length <= 8) {
    const cleaned = str.replace(/\b[A-Ga-g][#b]?\d?\b/g, '').replace(/[\s,\-–—|/()]+/g, '');
    if (cleaned.length === 0) {
      return tokens.map(normalizeNoteName).join(' ');
    }
  }

  const compact = str.replace(/[^A-Ga-g#b]/g, '');
  if (compact.length >= 4 && compact.length <= 12) {
    const compactNotes = compact.match(/[A-Ga-g][#b]?/g);
    if (compactNotes && compactNotes.join('') === compact && compactNotes.length >= 4 && compactNotes.length <= 8) {
      return compactNotes.map(normalizeNoteName).join(' ');
    }
  }

  return '';
}

export function detectTuning(text, hint) {
  const fromHint = parseTuningValue(hint);
  if (fromHint) return fromHint;

  const src = String(text ?? '');
  const lineMatch = src.match(/^\s*(?:guitar\s+)?tuning\s*[:=-]\s*(.+)$/im);
  if (lineMatch) {
    const fromLine = parseTuningValue(lineMatch[1]);
    if (fromLine) return fromLine;
  }

  const lines = src.split('\n');
  let run = [];
  for (let i = 0; i <= lines.length; i++) {
    const line = lines[i];
    if (i < lines.length && isTabLine(line)) {
      run.push(line.trim());
    } else {
      if (run.length >= 4 && run.length <= 8) {
        const notes = [];
        let allNamed = true;
        for (const rLine of run) {
          const m = rLine.match(/^([A-Ga-g][#b]?)\s*[|:-]/);
          if (!m) {
            allNamed = false;
            break;
          }
          notes.push(normalizeNoteName(m[1]));
        }
        if (allNamed) {
          return notes.reverse().join(' ');
        }
      }
      run = [];
    }
  }

  return '';
}

function parseCapoValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    const n = Math.round(raw);
    return n >= 0 && n <= 12 ? n : null;
  }
  const str = String(raw).trim();
  if (!str) return null;

  if (/^(?:none|no|off|0)$/i.test(str) || /\bno\s+capo\b/i.test(str) || /\bcapo\s*[:=-]?\s*(?:none|0|off)\b/i.test(str)) {
    return 0;
  }

  const pureNum = str.match(/^(\d{1,2})(?:st|nd|rd|th)?$/i);
  if (pureNum) {
    const n = parseInt(pureNum[1], 10);
    return n >= 0 && n <= 12 ? n : null;
  }

  const pureRoman = str.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(ROMAN_MAP, pureRoman)) {
    return ROMAN_MAP[pureRoman];
  }

  const numMatch = str.match(/\bcapo\b\s*(?:on\s*(?:the\s*)?)?(?:fret\s*)?[:=-]?\s*(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (n >= 0 && n <= 12) return n;
  }

  const romanMatch = str.match(/\bcapo\b\s*(?:on\s*(?:the\s*)?)?(?:fret\s*)?[:=-]?\s*(XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)\b/i);
  if (romanMatch) {
    return ROMAN_MAP[romanMatch[1].toUpperCase()] ?? null;
  }

  return null;
}

export function detectCapo(text, hint) {
  const fromHint = parseCapoValue(hint);
  if (fromHint !== null) return fromHint;
  return parseCapoValue(text);
}

function parseBpmValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    const n = Math.round(raw);
    return n >= 20 && n <= 350 ? n : null;
  }
  const str = String(raw).trim();
  if (!str) return null;

  if (/^\d{2,3}$/.test(str)) {
    const n = parseInt(str, 10);
    return n >= 20 && n <= 350 ? n : null;
  }

  const patterns = [
    /\b(?:bpm|tempo)\s*[:=-]\s*(\d{2,3})\b/i,
    /\b(\d{2,3})\s*bpm\b/i,
    /(?:♩|♪|q)\s*=\s*(\d{2,3})\b/i
  ];
  for (const re of patterns) {
    const m = str.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 20 && n <= 350) return n;
    }
  }

  return null;
}

export function detectBpm(text, hint) {
  const fromHint = parseBpmValue(hint);
  if (fromHint !== null) return fromHint;
  return parseBpmValue(text);
}

function isSectionHeaderLine(line) {
  const t = line.trim();
  if (!t || t.length > 48) return false;
  if (/^(?:title|artist|album|tuning|capo|tempo|bpm|difficulty|author|tabbed by|transcribed by|ultimate guitar|cifra club|e-chords)\b/i.test(t)) {
    return false;
  }
  if (/^\[[^\]]+\]$/.test(t)) return true;
  return /^(?:intro|verse|chorus|bridge|outro|solo|pre-?chorus|interlude|riff|part|hook|breakdown|theme|coda|main riff|fill)(?:\s+[a-z0-9#().-]+){0,4}:?$/i.test(t);
}

export function toWoodshedText({ title, artist, bpm, text }) {
  const cleaned = normalize(stripUgMarkup(text || ''));
  let lines = cleaned.split('\n').filter((line) => !(line.length > 140 && !line.includes('|')));

  let firstTab = -1;
  let lastTab = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTabLine(lines[i])) {
      if (firstTab === -1) firstTab = i;
      lastTab = i;
    }
  }

  if (firstTab !== -1) {
    let start = firstTab;
    for (let j = firstTab - 1; j >= Math.max(0, firstTab - 2); j--) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (isSectionHeaderLine(candidate)) {
        start = j;
      }
      break;
    }
    lines = lines.slice(start, lastTab + 1);
  }

  const body = lines.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/^\n+|\n+$/g, '');

  const headers = [];
  if (title && String(title).trim()) {
    headers.push(`# Title: ${String(title).trim()}`);
  }
  if (artist && String(artist).trim()) {
    headers.push(`# Artist: ${String(artist).trim()}`);
  }
  const parsedBpm = parseBpmValue(bpm);
  if (parsedBpm !== null) {
    headers.push(`# Tempo: ${parsedBpm}`);
  }

  if (headers.length === 0) return body;
  return `${headers.join('\n')}\n\n${body}`;
}

export function summarize(text) {
  const lines = String(text ?? '').split('\n');
  const systems = [];
  let run = [];
  let tabLines = 0;

  for (let i = 0; i <= lines.length; i++) {
    const line = lines[i];
    if (i < lines.length && isTabLine(line)) {
      run.push(i);
      tabLines += 1;
    } else {
      if (run.length >= 2) {
        systems.push(run);
      }
      run = [];
    }
  }

  const counts = new Map();
  for (const sys of systems) {
    counts.set(sys.length, (counts.get(sys.length) || 0) + 1);
  }

  let strings = 0;
  let bestFreq = 0;
  for (const [size, freq] of counts.entries()) {
    if (freq > bestFreq || (freq === bestFreq && (size === 6 || (strings !== 6 && size > strings)))) {
      bestFreq = freq;
      strings = size;
    }
  }

  let hasRhythmMarks = false;
  for (const sys of systems) {
    const above = sys[0] - 1;
    const below = sys[sys.length - 1] + 1;
    if ((above >= 0 && RHYTHM_LINE_RE.test(lines[above])) || (below < lines.length && RHYTHM_LINE_RE.test(lines[below]))) {
      hasRhythmMarks = true;
      break;
    }
  }

  return {
    systems: systems.length,
    tabLines,
    strings,
    hasRhythmMarks
  };
}
