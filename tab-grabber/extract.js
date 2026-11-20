(() => {
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
  const CHORD_TOKEN_RE = /^[A-G][#b]?(?:m|maj|min|dim|aug|sus|add)?\d*(?:\/[A-G][#b]?)?$/;

  function stripUgMarkup(s) {
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

  function normalize(s) {
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

  function isTabLine(line) {
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

  function countTabLines(text) {
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

  function detectTuning(text, hint) {
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

  function detectCapo(text, hint) {
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

  function detectBpm(text, hint) {
    const fromHint = parseBpmValue(hint);
    if (fromHint !== null) return fromHint;
    return parseBpmValue(text);
  }

  function parseTitleAndArtistFromDoc() {
    const h1 = document.querySelector('h1')?.textContent?.trim() || '';
    const docTitle = document.title || '';
    let title = '';
    let artist = '';

    const sources = [h1, docTitle];
    for (const src of sources) {
      if (!src) continue;
      let m = src.match(/^(.+?)\s+(?:tab|tabs|chords|bass tab)\s+by\s+(.+?)(?:\s*[|\-–—@].*)?$/i);
      if (m) {
        title = title || m[1].trim();
        artist = artist || m[2].trim();
        break;
      }
      m = src.match(/^(.+?)\s+[-–—]\s+(.+?)(?:\s*\([^)]*(?:tab|chords|ver|version)[^)]*\))?(?:\s*(?:tab|chords))?(?:\s*[|\-–—@].*)?$/i);
      if (m) {
        artist = artist || m[1].trim();
        title = title || m[2].trim();
        break;
      }
    }

    const h1Title = h1.replace(/\s*(?:tab|tabs|chords|bass tabs?|ukulele chords)\s*$/i, '').trim();
    if (!title && h1Title) title = h1Title;
    // Sites often SHOUT in <title> ("WONDERWALL TAB by Oasis"); prefer the heading's spelling of the same words,
    // otherwise turn all-capitals into title case.
    if (title && h1Title && h1Title.toLowerCase() === title.toLowerCase()) title = h1Title;
    const unshout = (s) => (s && s === s.toUpperCase() && /[A-Z]{3}/.test(s)
      ? s.toLowerCase().replace(/(^|[\s(\-"'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      : s);
    return { title: unshout(title), artist: unshout(artist) };
  }

  function identifySite(hostname) {
    const h = hostname.toLowerCase();
    if (h.endsWith('ultimate-guitar.com')) return 'Ultimate Guitar';
    if (h.endsWith('cifraclub.com') || h.endsWith('cifraclub.com.br')) return 'Cifra Club';
    if (h.endsWith('e-chords.com')) return 'E-Chords';
    if (h.endsWith('songsterr.com')) return 'Songsterr';
    if (h.endsWith('azchords.com')) return 'AZChords';
    if (h.endsWith('guitartabs.cc')) return 'GuitarTabs.cc';
    if (h.endsWith('guitaretab.com')) return 'GuitareTab';
    if (h.endsWith('bigbasstabs.com')) return 'BigBassTabs';
    if (h.endsWith('tabs4acoustic.com')) return 'Tabs4Acoustic';
    if (h.endsWith('911tabs.com')) return '911Tabs';
    if (h.endsWith('chordie.com')) return 'Chordie';
    if (h.endsWith('chordify.net')) return 'Chordify';
    return '';
  }

  function hasChordOverLyricLines(text) {
    const lines = String(text ?? '').split('\n');
    let chordLines = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const tokens = line.split(/\s+/);
      if (tokens.length >= 1 && tokens.every((tok) => CHORD_TOKEN_RE.test(tok))) {
        chordLines += 1;
        const nextLine = (lines[i + 1] || '').trim();
        if (nextLine && /[a-z]{2,}/.test(nextLine)) {
          return true;
        }
      }
    }
    return chordLines >= 2;
  }

  function collectGenericBlocks(extraSelectors = []) {
    const seen = new Set();
    const candidates = [];

    const addElement = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      const raw = el.tagName === 'TEXTAREA' ? el.value : (el.innerText || el.textContent || '');
      if (!raw || !raw.trim()) return;
      const cleaned = normalize(stripUgMarkup(raw));
      const counts = countTabLines(cleaned);
      candidates.push({
        text: cleaned,
        maxRun: counts.maxRun,
        total: counts.total,
        length: cleaned.length
      });
    };

    for (const sel of extraSelectors) {
      document.querySelectorAll(sel).forEach(addElement);
    }

    document.querySelectorAll('pre, code, textarea').forEach(addElement);

    const allEls = document.querySelectorAll('div, section, article, span, p');
    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      if (seen.has(el)) continue;
      const style = window.getComputedStyle(el);
      if (!style) continue;
      const ws = style.whiteSpace || '';
      const ff = (style.fontFamily || '').toLowerCase();
      const isPre = ws === 'pre' || ws === 'pre-wrap';
      const isMono = /mono|courier|consolas|menlo|monaco|lucida console|dejavu sans mono|liberation mono/.test(ff);
      if (isPre && isMono) {
        addElement(el);
      }
    }

    candidates.sort((a, b) => {
      const aValid = a.maxRun >= 4 ? 1 : 0;
      const bValid = b.maxRun >= 4 ? 1 : 0;
      if (bValid !== aValid) return bValid - aValid;
      if (b.total !== a.total) return b.total - a.total;
      if (b.maxRun !== a.maxRun) return b.maxRun - a.maxRun;
      return b.length - a.length;
    });

    return candidates;
  }

  const STANDARD_TUNINGS_TOP_DOWN = {
    4: ['G', 'D', 'A', 'E'],
    5: ['G', 'D', 'A', 'E', 'B'],
    6: ['E', 'B', 'G', 'D', 'A', 'E'],
    7: ['E', 'B', 'G', 'D', 'A', 'E', 'B'],
    8: ['E', 'B', 'G', 'D', 'A', 'E', 'B', 'F#']
  };

  function getToRootMatrix(svg, el) {
    const svgCtm = svg?.getScreenCTM?.();
    const elCtm = el?.getScreenCTM?.();
    if (!svgCtm || !elCtm) return null;
    try {
      return svgCtm.inverse().multiply(elCtm);
    } catch (_err) {
      return null;
    }
  }

  function transformPoint(matrix, x, y) {
    if (!matrix) return { x, y };
    const pt = new DOMPoint(x, y).matrixTransform(matrix);
    return { x: pt.x, y: pt.y };
  }

  function transformBoxToRoot(matrix, bbox) {
    const corners = [
      transformPoint(matrix, bbox.x, bbox.y),
      transformPoint(matrix, bbox.x + bbox.width, bbox.y),
      transformPoint(matrix, bbox.x, bbox.y + bbox.height),
      transformPoint(matrix, bbox.x + bbox.width, bbox.y + bbox.height)
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of corners) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.y > maxY) maxY = c.y;
    }
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
  }

  function mergeUniqueSorted(values, tolerance = 2) {
    if (!values.length) return [];
    const sorted = values.slice().sort((a, b) => a - b);
    const result = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - result[result.length - 1] > tolerance) {
        result.push(sorted[i]);
      }
    }
    return result;
  }

  function median(values) {
    if (!values.length) return 12;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function isBoxContained(inner, outer) {
    const eps = 0.2;
    return (
      inner.x >= outer.x - eps &&
      inner.y >= outer.y - eps &&
      inner.x + inner.width <= outer.x + outer.width + eps &&
      inner.y + inner.height <= outer.y + outer.height + eps &&
      outer.width * outer.height > inner.width * inner.height
    );
  }

  function parseBendSemis(rawText) {
    const s = String(rawText || '').trim().toLowerCase();
    if (!s) return 0;
    if (s === 'full') return 2;
    const fracMap = { '¼': 0.25, '½': 0.5, '¾': 0.75 };
    const m = s.match(/^(\d+)?\s*(?:([¼½¾])|(\d+)\s*\/\s*(\d+))?$/);
    if (m && (m[1] || m[2] || (m[3] && m[4]))) {
      const whole = m[1] ? parseFloat(m[1]) : 0;
      let frac = 0;
      if (m[2]) frac = fracMap[m[2]] || 0;
      else if (m[3] && m[4] && parseFloat(m[4]) !== 0) frac = parseFloat(m[3]) / parseFloat(m[4]);
      const steps = whole + frac;
      return steps > 0 ? Math.round(2 * steps) : 0;
    }
    const num = parseFloat(s);
    return Number.isFinite(num) && num > 0 ? Math.round(2 * num) : 0;
  }

  function rasterizeGlyphToBitmap(glyph, rasterCtx) {
    const { x, y, width: w, height: h } = glyph.bbox;
    if (!(w > 0 && h > 0)) return '';
    rasterCtx.setTransform(1, 0, 0, 1, 0, 0);
    rasterCtx.clearRect(0, 0, 8, 12);
    rasterCtx.fillStyle = '#000';
    rasterCtx.setTransform(8 / w, 0, 0, 12 / h, (-x * 8) / w, (-y * 12) / h);
    const fullD = glyph.holes && glyph.holes.length > 0 ? `${glyph.d} ${glyph.holes.join(' ')}` : glyph.d;
    rasterCtx.fill(new Path2D(fullD), 'evenodd');

    const pixels = rasterCtx.getImageData(0, 0, 8, 12).data;
    let bitmap = '';
    for (let p = 0; p < 96; p++) {
      bitmap += pixels[p * 4 + 3] > 110 ? '#' : '.';
    }
    return bitmap;
  }

  function splitSubpathsWithHoles(parent, pd) {
    const subDs = String(pd || '')
      .split(/(?=[Mm])/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('M') || s.startsWith('m'));
    if (subDs.length === 0) return [];

    const subItems = [];
    for (const subD of subDs) {
      const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      tmp.setAttribute('d', subD);
      parent.appendChild(tmp);
      let bbox = null;
      try {
        bbox = tmp.getBBox();
      } catch (_err) {
        bbox = null;
      }
      tmp.remove();
      if (bbox && bbox.width > 0 && bbox.height > 0) {
        subItems.push({ d: subD, bbox, holes: [] });
      }
    }

    subItems.sort((a, b) => (b.bbox.width * b.bbox.height) - (a.bbox.width * a.bbox.height));
    const outers = [];
    for (const item of subItems) {
      let container = null;
      for (let o = outers.length - 1; o >= 0; o--) {
        if (isBoxContained(item.bbox, outers[o].bbox)) {
          container = outers[o];
          break;
        }
      }
      if (container) {
        container.holes.push(item.d);
      } else {
        outers.push(item);
      }
    }
    return outers;
  }

  function parseRhythmCommands(dStr) {
    const tokens = String(dStr || '').match(/[MmVvHhLlZzCcQqSsTtAa]|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/g) || [];
    const subpaths = [];
    let current = null;
    let cmd = '';
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    let i = 0;

    while (i < tokens.length) {
      const tok = tokens[i];
      if (/^[A-Za-z]$/.test(tok)) {
        cmd = tok;
        i += 1;
        if (cmd === 'Z' || cmd === 'z') {
          if (current) {
            current.ops.push({ type: 'Z' });
            cx = sx;
            cy = sy;
          }
        }
        continue;
      }

      const num = parseFloat(tok);
      if (!Number.isFinite(num)) {
        i += 1;
        continue;
      }

      if (cmd === 'M' || cmd === 'm') {
        const yVal = parseFloat(tokens[i + 1]);
        if (!Number.isFinite(yVal)) break;
        if (cmd === 'M') {
          cx = num;
          cy = yVal;
        } else {
          cx += num;
          cy += yVal;
        }
        sx = cx;
        sy = cy;
        current = { x: cx, y: cy, ops: [] };
        subpaths.push(current);
        i += 2;
        cmd = cmd === 'M' ? 'L' : 'l';
      } else if (cmd === 'V' || cmd === 'v') {
        const ny = cmd === 'V' ? num : cy + num;
        if (current) current.ops.push({ type: 'V', x0: cx, y0: cy, x1: cx, y1: ny, dy: ny - cy });
        cy = ny;
        i += 1;
      } else if (cmd === 'H' || cmd === 'h') {
        const nx = cmd === 'H' ? num : cx + num;
        if (current) current.ops.push({ type: 'H', x0: cx, y0: cy, x1: nx, y1: cy, dx: nx - cx });
        cx = nx;
        i += 1;
      } else if (cmd === 'L' || cmd === 'l') {
        const yVal = parseFloat(tokens[i + 1]);
        if (!Number.isFinite(yVal)) break;
        const nx = cmd === 'L' ? num : cx + num;
        const ny = cmd === 'L' ? yVal : cy + yVal;
        if (current) current.ops.push({ type: 'L', x0: cx, y0: cy, x1: nx, y1: ny });
        cx = nx;
        cy = ny;
        i += 2;
      } else {
        i += 1;
      }
    }
    return subpaths;
  }

  function extractTimeSignatures(svg, rootGroup) {
    const sigEls = Array.from(rootGroup.querySelectorAll('text[class*="signature"]'));
    if (sigEls.length === 0) return [];
    const items = [];
    for (const el of sigEls) {
      const text = (el.textContent || '').trim();
      const val = parseInt(text, 10);
      if (!Number.isFinite(val) || val <= 0 || val > 32) continue;
      const mat = getToRootMatrix(svg, el);
      let x = NaN;
      let y = NaN;
      try {
        const bb = el.getBBox();
        if (bb && (bb.width > 0 || bb.height > 0)) {
          const pt = transformPoint(mat, bb.x + bb.width / 2, bb.y + bb.height / 2);
          x = pt.x;
          y = pt.y;
        }
      } catch (_err) {
        // fallback to attributes
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        const ax = parseFloat(el.getAttribute('x'));
        const ay = parseFloat(el.getAttribute('y'));
        if (Number.isFinite(ax) && Number.isFinite(ay)) {
          const pt = transformPoint(mat, ax, ay);
          x = pt.x;
          y = pt.y;
        }
      }
      if (Number.isFinite(x) && Number.isFinite(y)) {
        items.push({ x, y, val });
      }
    }
    items.sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const grouped = [];
    for (const item of items) {
      const last = grouped[grouped.length - 1];
      if (last && Math.abs(item.x - last.x) < 6) {last.entries.push(item);} else {grouped.push({ x: item.x, entries: [item] });}
    }
    const sigs = [];
    for (const g of grouped) {
      if (g.entries.length >= 2) {
        g.entries.sort((a, b) => a.y - b.y);
        const num = g.entries[0].val;
        const den = g.entries[1].val;
        if (num > 0 && den > 0) {
          sigs.push({ x: g.x, num, den });
        }
      }
    }
    return sigs;
  }

  function parseSongsterrLine(svg, rasterCtx) {
    const helper = globalThis.WoodshedSongsterr;
    if (!helper) return null;

    const rootGroup = svg.querySelector('g[data-track-index]') || svg;
    const stringsPath = rootGroup.querySelector('path[class*="strings"]') || svg.querySelector('path[class*="strings"]');
    if (!stringsPath) return null;

    const dStr = stringsPath.getAttribute('d') || '';
    const tokens = dStr.match(/[MmHhVv]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) || [];

    let cmd = '';
    let cx = 0;
    let cy = 0;
    let i = 0;

    const rawVerticalXs = [];
    const rawStringYs = [];
    let minStringX = Infinity;
    let maxStringX = -Infinity;

    while (i < tokens.length) {
      const tok = tokens[i];
      if (/^[MmHhVv]$/.test(tok)) {
        cmd = tok;
        i += 1;
        continue;
      }

      const num = parseFloat(tok);
      if (!Number.isFinite(num)) {
        i += 1;
        continue;
      }

      if (cmd === 'M' || cmd === 'm') {
        const yVal = parseFloat(tokens[i + 1]);
        if (!Number.isFinite(yVal)) break;
        if (cmd === 'M') {
          cx = num;
          cy = yVal;
        } else {
          cx += num;
          cy += yVal;
        }
        i += 2;
      } else if (cmd === 'H' || cmd === 'h') {
        const nx = cmd === 'H' ? num : cx + num;
        rawStringYs.push(cy);
        minStringX = Math.min(minStringX, cx, nx);
        maxStringX = Math.max(maxStringX, cx, nx);
        cx = nx;
        i += 1;
      } else if (cmd === 'V' || cmd === 'v') {
        const ny = cmd === 'V' ? num : cy + num;
        rawVerticalXs.push(cx);
        cy = ny;
        i += 1;
      } else {
        i += 1;
      }
    }

    const stringsMatrix = getToRootMatrix(svg, stringsPath);
    const rootStringYs = mergeUniqueSorted(
      rawStringYs.map((y) => transformPoint(stringsMatrix, 0, y).y),
      2
    );
    if (rootStringYs.length < 3) return null;

    const gaps = [];
    for (let s = 0; s < rootStringYs.length - 1; s++) {
      gaps.push(rootStringYs[s + 1] - rootStringYs[s]);
    }
    const spacing = median(gaps);

    const rootVerticalXs = mergeUniqueSorted(
      rawVerticalXs.map((x) => transformPoint(stringsMatrix, x, 0).x),
      2
    );
    const rootMinX = Number.isFinite(minStringX)
      ? transformPoint(stringsMatrix, minStringX, 0).x
      : (rootVerticalXs[0] ?? 0);
    const rootMaxX = Number.isFinite(maxStringX)
      ? transformPoint(stringsMatrix, maxStringX, 0).x
      : (rootVerticalXs[rootVerticalXs.length - 1] ?? rootMinX);

    const barEdges = rootVerticalXs.slice();
    if (barEdges.length === 0) {
      if (rootMaxX - rootMinX > 10) {
        barEdges.push(rootMinX, rootMaxX);
      }
    } else if (rootMaxX - barEdges[barEdges.length - 1] > 20) {
      barEdges.push(rootMaxX);
    }

    const bars = [];
    if (barEdges.length > 0 && barEdges[0] - rootMinX > 5) {
      bars.push({ x0: rootMinX, x1: barEdges[0], notes: [], isLeading: true });
    }
    for (let e = 0; e < barEdges.length - 1; e++) {
      bars.push({ x0: barEdges[e], x1: barEdges[e + 1], notes: [], isLeading: false });
    }
    if (bars.length === 0) return null;

    const allRootPaths = Array.from(rootGroup.querySelectorAll('path'));
    const voicePaths = allRootPaths.filter((p) => {
      const cls = p.getAttribute('class') || '';
      if (!cls.includes('voice')) return false;
      if (/flags|effects/i.test(cls)) return false;
      const pd = p.getAttribute('d') || '';
      return /[cC]/.test(pd);
    });
    const rhythmPaths = allRootPaths.filter((p) => {
      const cls = p.getAttribute('class') || '';
      if (!cls.includes('voice')) return false;
      if (/flags|effects/i.test(cls)) return false;
      const pd = p.getAttribute('d') || '';
      return !/[cC]/.test(pd);
    });

    let unknownGlyphs = 0;
    const glyphsByString = Array.from({ length: rootStringYs.length }, () => []);
    const restGlyphs = [];
    const dotGlyphs = [];
    const topStringY = rootStringYs[0];
    const botStringY = rootStringYs[rootStringYs.length - 1];

    for (const vPath of voicePaths) {
      const parent = vPath.parentNode;
      if (!parent) continue;
      const pd = vPath.getAttribute('d') || '';
      const outers = splitSubpathsWithHoles(parent, pd);
      if (outers.length === 0) continue;

      const pathMatrix = getToRootMatrix(svg, vPath);

      for (const glyph of outers) {
        const rootBox = transformBoxToRoot(pathMatrix, glyph.bbox);
        const cx = (rootBox.minX + rootBox.maxX) / 2;
        const cy = (rootBox.minY + rootBox.maxY) / 2;

        if (
          rootBox.width >= 1.5 && rootBox.width <= 4 &&
          rootBox.height >= 1.5 && rootBox.height <= 4 &&
          Math.abs(rootBox.width - rootBox.height) < 1
        ) {
          dotGlyphs.push({ x: cx, y: cy });
          continue;
        }

        // On 12-unit string spacing, digits are ~10 tall and tie brackets ~13 tall but only ~3 wide;
        // rests (~9 x 15) are taller than 1.1 * spacing.
        const isNarrow = rootBox.width < 0.38 * rootBox.height;
        const maxHeight = (isNarrow ? 1.2 : 1.05) * spacing;
        if (rootBox.height > 1.1 * spacing && !isNarrow) {
          if (cy >= topStringY - 2 * spacing && cy <= botStringY + 2 * spacing) {
            restGlyphs.push({ x: cx, y: cy });
          }
          continue;
        }
        if (rootBox.height < 0.6 * spacing || rootBox.height > maxHeight) {
          continue;
        }

        let bestString = -1;
        let bestDist = Infinity;
        for (let s = 0; s < rootStringYs.length; s++) {
          const dist = Math.abs(cy - rootStringYs[s]);
          if (dist < bestDist) {
            bestDist = dist;
            bestString = s;
          }
        }
        if (bestString === -1 || bestDist > 0.6 * spacing) {
          continue;
        }

        const { width: w, height: h } = glyph.bbox;
        const bitmap = rasterizeGlyphToBitmap(glyph, rasterCtx);
        const digit = helper.classifyGlyph(bitmap, w / h);
        if (digit === null) {
          unknownGlyphs += 1;
          continue;
        }

        glyphsByString[bestString].push({
          string: bestString,
          digit,
          left: rootBox.minX,
          right: rootBox.maxX,
          width: rootBox.width,
          x: cx
        });
      }
    }

    const stems = [];
    const beams = [];
    for (const rPath of rhythmPaths) {
      const mat = getToRootMatrix(svg, rPath);
      const subpaths = parseRhythmCommands(rPath.getAttribute('d') || '');
      for (const sp of subpaths) {
        const ops = sp.ops;
        if (ops.length === 1 && ops[0].type === 'V') {
          const p0 = transformPoint(mat, ops[0].x0, ops[0].y0);
          const p1 = transformPoint(mat, ops[0].x1, ops[0].y1);
          const len = Math.abs(p1.y - p0.y);
          if (len > 1) {
            stems.push({
              x: (p0.x + p1.x) / 2,
              topY: Math.min(p0.y, p1.y),
              botY: Math.max(p0.y, p1.y),
              len
            });
          }
        } else if (
          ops.length >= 4 &&
          ops[0].type === 'V' &&
          ops[1].type === 'H' &&
          ops[2].type === 'V' &&
          ops[3].type === 'Z'
        ) {
          const p0 = transformPoint(mat, ops[0].x0, ops[0].y0);
          const p1 = transformPoint(mat, ops[1].x1, ops[2].y1);
          beams.push({
            x0: Math.min(p0.x, p1.x),
            x1: Math.max(p0.x, p1.x),
            y: Math.min(p0.y, p1.y)
          });
        }
      }
    }

    const flagXs = [];
    const flagPaths = allRootPaths.filter((p) => (p.getAttribute('class') || '').includes('traditionalFlags'));
    for (const fPath of flagPaths) {
      const mat = getToRootMatrix(svg, fPath);
      const subpaths = parseRhythmCommands(fPath.getAttribute('d') || '');
      for (const sp of subpaths) {
        const pt = transformPoint(mat, sp.x, sp.y);
        if (Number.isFinite(pt.x)) flagXs.push(pt.x);
      }
    }

    const tuplets = [];
    const tupletPaths = allRootPaths.filter((p) => (p.getAttribute('class') || '').includes('tuplet'));
    for (const tPath of tupletPaths) {
      const parent = tPath.parentNode;
      if (!parent) continue;
      const outers = splitSubpathsWithHoles(parent, tPath.getAttribute('d') || '');
      const mat = getToRootMatrix(svg, tPath);
      for (const glyph of outers) {
        const rootBox = transformBoxToRoot(mat, glyph.bbox);
        const { width: w, height: h } = glyph.bbox;
        const bitmap = rasterizeGlyphToBitmap(glyph, rasterCtx);
        const ch = helper.classifyGlyph(bitmap, w / h);
        const num = ch && /^[2-9]$/.test(ch) ? parseInt(ch, 10) : NaN;
        if (Number.isFinite(num)) {
          tuplets.push({
            n: num,
            minX: rootBox.minX,
            maxX: rootBox.maxX,
            cx: (rootBox.minX + rootBox.maxX) / 2
          });
        }
      }
    }

    const timeSignatures = extractTimeSignatures(svg, rootGroup);

    const notesByString = Array.from({ length: rootStringYs.length }, () => []);
    for (let s = 0; s < glyphsByString.length; s++) {
      const list = glyphsByString[s];
      list.sort((a, b) => a.x - b.x);
      const joined = [];
      // "(5)" is a tied note: it continues the previous one and isn't played again, so it is dropped.
      let inBracket = false;
      for (const g of list) {
        if (g.digit === '(') {
          inBracket = true;
          continue;
        }
        if (g.digit === ')') {
          inBracket = false;
          continue;
        }
        if (inBracket) continue;
        const prev = joined[joined.length - 1];
        // Digits of one number sit 2-4 units apart (a "1" is drawn narrower than its slot, so its gap
        // looks bigger); separate notes on a string are much further apart. Dead notes ('x') never join.
        if (prev && g.digit !== 'x' && prev.fret !== 'x' && (g.left - prev.right) < 0.4 * spacing) {
          prev.fret += g.digit;
          prev.left = Math.min(prev.left, g.left);
          prev.right = Math.max(prev.right, g.right);
          prev.width = prev.right - prev.left;
          prev.x = (prev.left + prev.right) / 2;
        } else {
          joined.push({
            string: s,
            fret: g.digit,
            left: g.left,
            right: g.right,
            width: g.width,
            x: g.x
          });
        }
      }
      notesByString[s] = joined;
    }

    const slides = [];
    const arcs = [];
    const slideRe = /^M\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)[,\s]+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*Q\s*(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[,\s]+){2}([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)[,\s]+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*V\b/i;
    const arcRe = /^M\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)[,\s]+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*c\s*(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[,\s]+){4}([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)[,\s]+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*L\b/;

    const effectPaths = Array.from(rootGroup.querySelectorAll('path')).filter((p) => {
      const cls = p.getAttribute('class') || '';
      return cls.includes('effects') && !cls.includes('effectsStroke') && !cls.includes('effectNoFill');
    });

    for (const effPath of effectPaths) {
      const pd = effPath.getAttribute('d') || '';
      const subDs = pd
        .split(/(?=[Mm])/)
        .map((sub) => sub.trim())
        .filter((sub) => sub.startsWith('M') || sub.startsWith('m'));
      const mat = getToRootMatrix(svg, effPath);
      for (const subD of subDs) {
        const mSlide = subD.match(slideRe);
        if (mSlide) {
          const p0 = transformPoint(mat, parseFloat(mSlide[1]), parseFloat(mSlide[2]));
          const p1 = transformPoint(mat, parseFloat(mSlide[3]), parseFloat(mSlide[4]));
          slides.push({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y });
          continue;
        }
        const mArc = subD.match(arcRe);
        if (mArc) {
          const ax = parseFloat(mArc[1]);
          const ay = parseFloat(mArc[2]);
          const dx = parseFloat(mArc[3]);
          const dy = parseFloat(mArc[4]);
          const p0 = transformPoint(mat, ax, ay);
          const p1 = transformPoint(mat, ax + dx, ay + dy);
          arcs.push({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y });
        }
      }
    }

    for (const arc of arcs) {
      let bestCand = null;
      let bestYDist = Infinity;
      const targetY = arc.y0 + 0.5 * spacing;
      for (let s = 0; s < notesByString.length; s++) {
        const sNotes = notesByString[s];
        let startNote = null;
        let bestStartDist = Infinity;
        for (const note of sNotes) {
          const d = Math.abs(note.x - arc.x0);
          if (d <= 9 && d < bestStartDist) {
            bestStartDist = d;
            startNote = note;
          }
        }
        if (!startNote) continue;
        let endNote = null;
        let bestEndDist = Infinity;
        for (const note of sNotes) {
          if (note === startNote) continue;
          const d = Math.abs(note.x - arc.x1);
          if (d <= 9 && d < bestEndDist) {
            bestEndDist = d;
            endNote = note;
          }
        }
        if (!endNote) continue;
        const yDist = Math.abs(rootStringYs[s] - targetY);
        if (yDist < bestYDist) {
          bestYDist = yDist;
          bestCand = { s, startNote, endNote };
        }
      }
      if (bestCand && bestCand.startNote.fret !== 'x' && bestCand.endNote.fret !== 'x') {
        const startFret = parseInt(bestCand.startNote.fret, 10);
        const endFret = parseInt(bestCand.endNote.fret, 10);
        if (bestCand.startNote.fret === bestCand.endNote.fret || (Number.isFinite(startFret) && startFret === endFret)) {
          notesByString[bestCand.s] = notesByString[bestCand.s].filter((n) => n !== bestCand.endNote);
        } else if (Number.isFinite(startFret) && Number.isFinite(endFret)) {
          bestCand.endNote.pre = endFret > startFret ? 'h' : 'p';
        }
      }
    }

    for (const slide of slides) {
      const midY = (slide.y0 + slide.y1) / 2;
      let bestString = -1;
      let bestDist = Infinity;
      for (let s = 0; s < rootStringYs.length; s++) {
        const d = Math.abs(rootStringYs[s] - midY);
        if (d < bestDist) {
          bestDist = d;
          bestString = s;
        }
      }
      if (bestString === -1 || bestDist > 0.8 * spacing) continue;
      const sNotes = notesByString[bestString];
      let dest = null;
      for (const note of sNotes) {
        if (note.left >= slide.x1 - 3 && note.left <= slide.x1 + 12) {
          if (!dest || note.left < dest.left) dest = note;
        }
      }
      if (!dest || dest.fret === 'x') continue;
      let source = null;
      for (const note of sNotes) {
        if (note.right <= slide.x0 + 3) {
          if (!source || note.right > source.right) source = note;
        }
      }
      const destFret = parseInt(dest.fret, 10);
      const sourceFret = source && source.fret !== 'x' ? parseInt(source.fret, 10) : NaN;
      if (Number.isFinite(destFret)) {
        dest.pre = !Number.isFinite(sourceFret) || destFret >= sourceFret ? '/' : '\\';
      }
    }

    const allNotes = notesByString.flat();

    const vibratoGroups = Array.from(rootGroup.querySelectorAll('g[data-effect-run^="vibrato-"]'));
    for (const vGroup of vibratoGroups) {
      const vPath = Array.from(vGroup.querySelectorAll('path')).find((p) =>
        (p.getAttribute('class') || '').includes('pathVibrato')
      );
      if (!vPath) continue;
      const mat = getToRootMatrix(svg, vPath);
      const pd = vPath.getAttribute('d') || '';
      const mMove = pd.match(/[Mm]\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)[,\s]+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/);
      let bboxStart = NaN;
      if (mMove) {
        bboxStart = transformPoint(mat, parseFloat(mMove[1]), parseFloat(mMove[2])).x;
      } else {
        try {
          const bb = vPath.getBBox();
          if (bb) bboxStart = transformBoxToRoot(mat, bb).minX;
        } catch (_err) {
          bboxStart = NaN;
        }
      }
      if (!Number.isFinite(bboxStart)) continue;
      for (const note of allNotes) {
        if (note.fret === 'x') continue;
        if (note.x >= bboxStart - 4 && note.x <= bboxStart + 10) {
          note.post = '~';
        }
      }
    }

    const bendTexts = Array.from(rootGroup.querySelectorAll('text')).filter((el) =>
      (el.getAttribute('class') || '').includes('_up')
    );
    for (const textEl of bendTexts) {
      const semis = parseBendSemis(textEl.textContent);
      if (!semis) continue;
      const mat = getToRootMatrix(svg, textEl);
      let tx = NaN;
      try {
        const bb = textEl.getBBox();
        if (bb && bb.width > 0) {
          tx = transformPoint(mat, bb.x + bb.width / 2, bb.y + bb.height / 2).x;
        }
      } catch (_err) {
        // fallback to x attribute
      }
      if (!Number.isFinite(tx)) {
        const attrX = parseFloat(textEl.getAttribute('x'));
        const attrY = parseFloat(textEl.getAttribute('y')) || 0;
        if (Number.isFinite(attrX)) {
          tx = transformPoint(mat, attrX, attrY).x;
        }
      }
      if (!Number.isFinite(tx)) continue;

      let bestNote = null;
      let bestDist = Infinity;
      for (const note of allNotes) {
        if (note.fret === 'x') continue;
        const fretNum = parseInt(note.fret, 10);
        if (!Number.isFinite(fretNum)) continue;
        const dist = Math.abs(note.x - tx);
        if (dist > 12) continue;
        if (
          dist < bestDist - 1e-6 ||
          (Math.abs(dist - bestDist) <= 1e-6 && bestNote && note.string < bestNote.string)
        ) {
          bestDist = dist;
          bestNote = note;
        }
      }
      if (bestNote) {
        bestNote.post = 'b' + String(parseInt(bestNote.fret, 10) + semis);
      }
    }

    const lineNotes = [];
    for (const note of allNotes) {
      const out = { string: note.string, fret: note.fret, x: note.x };
      if (note.fret !== 'x') {
        if (note.pre) out.pre = note.pre;
        if (note.post) out.post = note.post;
      }
      lineNotes.push(out);
    }

    for (const note of lineNotes) {
      let placed = false;
      for (let b = 0; b < bars.length; b++) {
        if (note.x >= bars[b].x0 && note.x < bars[b].x1) {
          bars[b].notes.push(note);
          placed = true;
          break;
        }
      }
      if (!placed && bars.length > 0) {
        const lastBar = bars[bars.length - 1];
        if (Math.abs(note.x - lastBar.x1) <= 2) {
          lastBar.notes.push(note);
        } else if (note.x < bars[0].x0 && bars[0].x0 - note.x <= 2) {
          bars[0].notes.push(note);
        }
      }
    }

    const maxStemLen = stems.reduce((m, st) => Math.max(m, st.len), 0);
    const shortStemCutoff = 0.7 * maxStemLen;
    const keptBars = bars.filter((bar) => !bar.isLeading || bar.notes.length > 0);

    for (const bar of keptBars) {
      bar.restXs = [];
      for (const rg of restGlyphs) {
        if (rg.x >= bar.x0 && rg.x < bar.x1) {bar.restXs.push(rg.x);} else if (bar === keptBars[keptBars.length - 1] && Math.abs(rg.x - bar.x1) <= 2) {bar.restXs.push(rg.x);} else if (bar === keptBars[0] && rg.x < bar.x0 && bar.x0 - rg.x <= 2) {bar.restXs.push(rg.x);}
      }
    }

    const finalBars = keptBars.map(({ x0, x1, notes, restXs }) => ({
      x0,
      x1,
      notes,
      restXs,
      maxStemLen,
      shortStemCutoff
    }));

    return {
      stringCount: rootStringYs.length,
      bars: finalBars,
      noteCount: lineNotes.length,
      unknownGlyphs,
      stems,
      beams,
      flagXs,
      dotGlyphs,
      tuplets,
      timeSignatures
    };
  }

  function dotGlyphsInLine(line, stemX) {
    const dots = Array.isArray(line.dotGlyphs) ? line.dotGlyphs : [];
    for (const d of dots) {
      const dx = d.x - stemX;
      if (dx >= 3 && dx <= 14) return true;
    }
    return false;
  }

  function extractSongsterrTuning(svg) {
    const tuningEls = Array.from(svg.querySelectorAll('text[class*="tuning"]'));
    if (tuningEls.length === 0) return [];
    const items = tuningEls.map((el) => {
      const m = getToRootMatrix(svg, el);
      let y = 0;
      try {
        const bb = el.getBBox();
        y = transformPoint(m, bb.x, bb.y + bb.height / 2).y;
      } catch (_err) {
        y = 0;
      }
      const raw = (el.textContent || '').trim();
      const cleaned = raw.replace(/\d+$/, '');
      return { y, name: cleaned || raw };
    });
    items.sort((a, b) => a.y - b.y);
    return items.map((it) => it.name).filter(Boolean);
  }

  function extractSongsterrBpm(svg) {
    const tempoEl = svg.querySelector('text[class*="tempoText"]');
    if (!tempoEl) return null;
    const m = (tempoEl.textContent || '').match(/(\d{2,3})/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n >= 20 && n <= 350 ? n : null;
  }

  function getSongsterrLineSvgs() {
    const svgs = Array.from(document.querySelectorAll('svg[data-testid^="multitrack-line-group-"]'));
    const out = [];
    for (const svg of svgs) {
      const id = svg.getAttribute('data-testid') || '';
      const m = id.match(/^multitrack-line-group-(\d+)$/);
      if (m) {
        out.push({ svg, n: parseInt(m[1], 10) });
      }
    }
    return out;
  }

  function waitFramesAndDelay(ms) {
    // A frame never comes while the tab is hidden, so each frame wait gives up after 100 ms.
    const frame = () => new Promise((resolve) => {
      const timer = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return frame().then(frame).then(() => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  const NOTATION_SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiToSharpName(midi) {
    const m = Math.round(Number(midi));
    return NOTATION_SHARP_NAMES[((m % 12) + 12) % 12];
  }

  function escapeRegExpStr(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseSongsterrPageState() {
    try {
      const el = document.getElementById('state');
      if (!el || !el.textContent) return null;
      const parsed = JSON.parse(el.textContent);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_err) {
      return null;
    }
  }

  function compactSongsterrNotation(raw, songId, revisionId, partId) {
    const tuning = raw.tuning.map((n) => Number(n));
    const strings = Number.isInteger(raw.strings) ? raw.strings : tuning.length;
    const rawTempo = Array.isArray(raw.automations?.tempo) ? raw.automations.tempo : [];
    const tempo = rawTempo
      .filter((t) => t && typeof t === 'object' && Number.isFinite(t.bpm))
      .map((t) => ({
        measure: Number.isFinite(t.measure) ? t.measure : 0,
        position: Number.isFinite(t.position) ? t.position : 0,
        bpm: t.bpm,
        ...(t.type !== undefined ? { type: t.type } : {})
      }));

    const measures = raw.measures.map((m) => {
      const src = m && typeof m === 'object' ? m : {};
      const outM = {};
      if (Array.isArray(src.signature) && src.signature.length >= 2) {
        outM.signature = [Number(src.signature[0]), Number(src.signature[1])];
      }
      if (src.marker && typeof src.marker === 'object' && typeof src.marker.text === 'string') {
        outM.marker = { text: src.marker.text };
      }
      if (src.rest) outM.rest = true;
      if (src.repeatStart) outM.repeatStart = true;
      if (src.repeatClose) {
        outM.repeatClose = typeof src.repeatClose === 'number' ? src.repeatClose : true;
      }
      if (Array.isArray(src.alternateEnding) && src.alternateEnding.length > 0) {
        outM.alternateEnding = src.alternateEnding.filter((x) => Number.isInteger(x));
      }
      outM.voices = Array.isArray(src.voices)
        ? src.voices.map((v) => {
            const srcV = v && typeof v === 'object' ? v : {};
            const outV = {};
            if (srcV.rest) outV.rest = true;
            outV.beats = Array.isArray(srcV.beats)
              ? srcV.beats.map((b) => {
                  const srcB = b && typeof b === 'object' ? b : {};
                  const outB = {
                    duration: Array.isArray(srcB.duration) && srcB.duration.length >= 2
                      ? [Number(srcB.duration[0]), Number(srcB.duration[1])]
                      : [1, 4]
                  };
                  if (Number.isFinite(srcB.dots) && srcB.dots > 0) outB.dots = srcB.dots;
                  if (Number.isFinite(srcB.tuplet) && srcB.tuplet > 1) outB.tuplet = srcB.tuplet;
                  if (srcB.rest) outB.rest = true;
                  if (srcB.vibrato) outB.vibrato = true;
                  if (srcB.graceNote) outB.graceNote = true;
                  outB.notes = Array.isArray(srcB.notes)
                    ? srcB.notes.map((n) => {
                        const srcN = n && typeof n === 'object' ? n : {};
                        const outN = {
                          string: Number(srcN.string),
                          fret: Number.isFinite(srcN.fret) ? srcN.fret : 0
                        };
                        if (srcN.tie) outN.tie = true;
                        if (srcN.dead) outN.dead = true;
                        if (srcN.ghost) outN.ghost = true;
                        if (srcN.slide) outN.slide = srcN.slide;
                        if (srcN.vibrato) outN.vibrato = true;
                        if (srcN.hp) outN.hp = true;
                        if (srcN.bend) outN.bend = srcN.bend;
                        if (srcN.harmonic) outN.harmonic = srcN.harmonic;
                        if (srcN.rest) outN.rest = true;
                        return outN;
                      })
                    : [];
                  return outB;
                })
              : [];
            return outV;
          })
        : [];
      return outM;
    });

    return {
      format: 'songsterr',
      version: 1,
      songId: Number.isFinite(Number(songId)) ? Number(songId) : songId,
      revisionId,
      partId: Number.isFinite(Number(partId)) ? Number(partId) : partId,
      name: typeof raw.name === 'string' ? raw.name : '',
      instrument: typeof raw.instrument === 'string' ? raw.instrument : '',
      instrumentId: Number.isFinite(raw.instrumentId) ? raw.instrumentId : null,
      strings,
      tuning,
      automations: { tempo },
      measures
    };
  }

  function readShownSongsterrTrack() {
    return {
      headerTexts: Array.from(document.querySelectorAll('[data-testid="header-track-name"]'))
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean),
      domPartIds: Array.from(document.querySelectorAll('[data-part-id]'))
        .map((el) => el.getAttribute('data-part-id'))
    };
  }

  async function fetchSongsterrPart(partUrl, songId) {
    try {
      const resp = await fetch(partUrl, { credentials: 'omit', cache: 'force-cache' });
      if (!resp.ok) return null;
      const raw = await resp.json();
      if (!raw || typeof raw !== 'object') return null;
      if (!Array.isArray(raw.measures) || raw.measures.length === 0) return null;
      if (!Array.isArray(raw.tuning) || raw.tuning.length === 0) return null;
      // The data names its own song: never accept another song's track.
      if (raw.songId !== undefined && raw.songId !== null && String(raw.songId) !== String(songId)) return null;
      return raw;
    } catch (_err) {
      return null;
    }
  }

  async function readSongsterrNotation(url, title, artist) {
    try {
      const T = globalThis.WoodshedSongsterrTracks;
      if (!T) return null;
      const chosenPartId = globalThis.__woodshedSongsterrPart;
      delete globalThis.__woodshedSongsterrPart;
      const pageUrl = String(url || window.location.href || '');
      const pageState = parseSongsterrPageState();

      // The tab may still be drawing (or the page just switched song): give it up to 5 s to show a track name.
      let shown = readShownSongsterrTrack();
      for (let waited = 0; waited < 5000 && shown.headerTexts.length === 0 && shown.domPartIds.length === 0; waited += 250) {
        await new Promise((r) => setTimeout(r, 250));
        shown = readShownSongsterrTrack();
      }

      const urlSongId = T.parseSongsterrUrl(pageUrl).songId;
      const stateSongId = pageState?.meta?.songId ?? pageState?.meta?.current?.songId ?? null;
      const songIdGuess = urlSongId ?? (stateSongId !== null ? String(stateSongId) : null);
      if (!songIdGuess) return null;
      // The page's state is from the first page you opened on Songsterr; when it is for another song, ask
      // Songsterr for this song's track list (the same list the page loads).
      let apiMeta = null;
      if (String(stateSongId) !== songIdGuess) {
        try {
          const r = await fetch(`/api/meta/${encodeURIComponent(songIdGuess)}`, { credentials: 'omit' });
          if (r.ok) apiMeta = await r.json();
        } catch (_err) {
          apiMeta = null;
        }
      }

      const pick = T.resolveSongsterrTrack({
        url: pageUrl,
        state: pageState,
        apiMeta,
        headerTexts: shown.headerTexts,
        domPartIds: shown.domPartIds,
        chosenPartId
      });
      const songId = pick.songId;
      const resourceNames = (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
        ? performance.getEntriesByType('resource')
        : []).map((e) => e && e.name).filter((n) => typeof n === 'string');

      // Note counts for every track, so the popup can offer a choice and flag a near-empty track.
      const trackList = pick.tracks.map((t) => ({ ...t, notes: null }));
      await Promise.all(trackList.map(async (t) => {
        const loc = T.findPartJsonUrl(resourceNames, { songId, revisionId: pick.revisionId, image: pick.image, partId: t.partId });
        const raw = loc ? await fetchSongsterrPart(loc.url, songId) : null;
        if (raw) {
          t.notes = T.countPlayedNotes(raw);
          t.bars = raw.measures.length;
        }
      }));

      if (pick.partId === null) {
        if (trackList.length === 0) return null;
        return {
          ok: false,
          site: 'Songsterr',
          url,
          title,
          artist,
          kind: 'choose-track',
          tracks: trackList,
          text: '',
          message: "Couldn't tell which track this page shows. Pick the track to grab:"
        };
      }

      const loc = T.findPartJsonUrl(resourceNames, { songId, revisionId: pick.revisionId, image: pick.image, partId: pick.partId });
      if (!loc) return null;
      const raw = await fetchSongsterrPart(loc.url, songId);
      if (!raw) return null;
      const revisionId = loc.revisionId;
      const partId = pick.partId;

      async function readSongsterrVideos(songId, revisionId) {
        try {
          const r = await fetch(`/api/video-points/${encodeURIComponent(songId)}/${encodeURIComponent(revisionId)}/list`, { credentials: 'omit' });
          if (!r.ok) return [];
          const list = await r.json();
          if (!Array.isArray(list)) return [];
          const seen = new Set();
          const items = [];
          for (const entry of list) {
            if (!entry || typeof entry !== 'object') continue;
            if (entry.status !== 'done') continue;
            if (typeof entry.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(entry.videoId)) continue;
            if (!Array.isArray(entry.points) || entry.points.length < 2) continue;
            if (!entry.points.every((p) => typeof p === 'number' && Number.isFinite(p))) continue;
            if (seen.has(entry.videoId)) continue;
            seen.add(entry.videoId);
            const kind = entry.feature == null ? 'original' : String(entry.feature);
            const points = entry.points.map((p) => Math.round(p * 100) / 100);
            items.push({ videoId: entry.videoId, kind, points });
          }
          const rank = (k) => (k === 'original' ? 0 : k === 'backing' ? 1 : k === 'solo' ? 2 : k === 'alternative' ? 3 : 4);
          items.sort((a, b) => rank(a.kind) - rank(b.kind));
          return items.slice(0, 12);
        } catch {
          return [];
        }
      }

      const notation = compactSongsterrNotation(raw, songId, revisionId, partId);
      if (revisionId !== null) notation.videos = await readSongsterrVideos(songId, revisionId);
      const toAscii = globalThis.WoodshedNotation?.notationToAscii || globalThis.WoodshedSongsterr?.notationToAscii;
      const text = typeof toAscii === 'function' ? toAscii(notation) : '';
      if (!text || !text.trim()) return null;

      const firstTempo = notation.automations.tempo[0]?.bpm;
      const bpm = Number.isFinite(firstTempo) ? firstTempo : null;
      const tuning = notation.tuning.map((m) => midiToSharpName(m)).join(' ');
      const trackName = notation.name || 'Track 1';

      const noteCount = T.countPlayedNotes(raw);
      const listed = trackList.find((t) => t.partId === partId);
      const playable = listed ? listed.playable : T.isPlayableTrack(raw);
      const sourceLabel = {
        chosen: 'your pick',
        header: 'the track shown on the page',
        page: 'the track drawn on the page',
        address: 'the address bar',
        state: "the page's starting track"
      }[pick.partSource] || pick.partSource;
      const warnParts = [`Exact rhythm from Songsterr (track: ${trackName}, ${noteCount} notes; chosen from ${sourceLabel}).`];
      const better = trackList.filter((t) => t.partId !== partId && t.playable && Number.isFinite(t.notes) && !T.isSparseTrack(t.notes, t.bars));
      if (T.isSparseTrack(noteCount, raw.measures.length)) {
        warnParts.push(`This track has only ${noteCount} notes for ${raw.measures.length} bars, probably not the guitar part.`);
      } else if (!playable) {
        warnParts.push(`"${raw.instrument || trackName}" isn't a guitar or bass track.`);
      }
      if (warnParts.length > 1 && better.length > 0) warnParts.push('Pick another track below.');

      return {
        tracks: trackList,
        partId,
        trackWarning: warnParts.length > 1,
        diagnostics: pick.notes,
        ok: true,
        site: 'Songsterr',
        url,
        title,
        artist,
        tuning,
        capo: null,
        bpm,
        kind: 'tab',
        text,
        notation,
        warning: warnParts.join(' ')
      };
    } catch (_err) {
      return null;
    }
  }

  async function readSongsterr(defaultMeta, url) {
    let title = defaultMeta.title;
    let artist = defaultMeta.artist;
    const titleMatch = (document.title || '').match(/^(.*?)\s+(?:Bass |Drum )?(?:Tab|Chords)\s+by\s+(.*?)\s+\|/i);
    if (titleMatch) {
      if (titleMatch[1].trim()) title = titleMatch[1].trim();
      if (titleMatch[2].trim()) artist = titleMatch[2].trim();
    }

    const exactResult = await readSongsterrNotation(url, title, artist);
    if (exactResult) return exactResult;

    const svgResult = await readSongsterrSvg(defaultMeta, url, title, artist);
    if (svgResult && svgResult.ok) {
      const note = 'Exact rhythm unavailable; rhythm was estimated from the drawing.';
      svgResult.warning = svgResult.warning ? `${svgResult.warning} ${note}` : note;
    }
    return svgResult;
  }

  async function readSongsterrSvg(defaultMeta, url, title, artist) {

    if (getSongsterrLineSvgs().length === 0) {
      return {
        ok: false,
        site: 'Songsterr',
        url,
        title,
        artist,
        tuning: '',
        capo: null,
        bpm: null,
        kind: 'unsupported',
        text: '',
        message: "Couldn't find a tab on this Songsterr page. Open the song's tab and try again."
      };
    }

    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(8, 12)
      : Object.assign(document.createElement('canvas'), { width: 8, height: 12 });
    const rasterCtx = canvas.getContext('2d', { willReadFrequently: true });

    const scroller = document.scrollingElement || document.documentElement || document.body;
    const savedScrollTop = scroller ? scroller.scrollTop : (window.scrollY || 0);

    if (scroller) scroller.scrollTop = 0;
    window.scrollTo(0, 0);
    await waitFramesAndDelay(120);

    const parsedByN = new Map();
    let capturedTuning = [];
    let capturedTuningLine = Infinity;
    let capturedBpm = null;

    const startTime = Date.now();
    let stalledCount = 0;

    while (Date.now() - startTime < 45000) {
      const visible = getSongsterrLineSvgs();
      for (const { svg, n } of visible) {
        if (n < capturedTuningLine) {
          const lineTuning = extractSongsterrTuning(svg);
          if (lineTuning.length > 0) {
            capturedTuning = lineTuning;
            capturedTuningLine = n;
          }
        }
        if (capturedBpm === null) {
          capturedBpm = extractSongsterrBpm(svg);
        }
        if (!parsedByN.has(n)) {
          const parsed = parseSongsterrLine(svg, rasterCtx);
          if (parsed) {
            parsedByN.set(n, parsed);
          }
        }
      }

      const prevTop = scroller ? scroller.scrollTop : (window.scrollY || 0);
      const step = Math.max(100, Math.round((window.innerHeight || 800) * 0.8));
      if (scroller) scroller.scrollTop = prevTop + step;
      window.scrollBy(0, step);

      await waitFramesAndDelay(120);

      const nextTop = scroller ? scroller.scrollTop : (window.scrollY || 0);
      if (nextTop <= prevTop + 0.5) {
        stalledCount += 1;
      } else {
        stalledCount = 0;
      }
      if (stalledCount >= 2) break;
    }

    if (scroller) scroller.scrollTop = savedScrollTop;
    window.scrollTo(0, savedScrollTop);

    const sortedLines = Array.from(parsedByN.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, line]) => line);

    const totalNotes = sortedLines.reduce((sum, l) => sum + l.noteCount, 0);
    const totalUnknown = sortedLines.reduce((sum, l) => sum + l.unknownGlyphs, 0);
    const stringCount = sortedLines[0]?.stringCount || capturedTuning.length || 6;

    const stringNames = capturedTuning.length === stringCount
      ? capturedTuning
      : (STANDARD_TUNINGS_TOP_DOWN[stringCount] || STANDARD_TUNINGS_TOP_DOWN[6].slice(0, stringCount));

    const tuning = stringNames.slice().reverse().join(' ');

    if (totalNotes === 0) {
      return {
        ok: false,
        site: 'Songsterr',
        url,
        title,
        artist,
        tuning,
        capo: null,
        bpm: capturedBpm,
        kind: 'unsupported',
        text: '',
        message: "Couldn't read any notes from this Songsterr tab."
      };
    }

    const helper = globalThis.WoodshedSongsterr;
    let curNum = 4;
    let curDen = 4;
    let totalBars = 0;
    let exactBars = 0;

    for (const line of sortedLines) {
      const lineSigs = Array.isArray(line.timeSignatures) ? line.timeSignatures : [];
      const lineStems = Array.isArray(line.stems) ? line.stems : [];
      const lineBeams = Array.isArray(line.beams) ? line.beams : [];
      const lineFlagXs = Array.isArray(line.flagXs) ? line.flagXs : [];
      const lineTuplets = Array.isArray(line.tuplets) ? line.tuplets : [];

      for (const bar of line.bars) {
        totalBars += 1;
        for (const sig of lineSigs) {
          if (sig.x <= bar.x0 + 18) {
            curNum = sig.num;
            curDen = sig.den;
          }
        }
        const barLen = curNum / curDen;
        const sortedNotes = bar.notes.slice().sort((a, b) => a.x - b.x);
        // Beats come from the STEMS, not from the notes kept: a tied note "(5)" is dropped from the notes
        // but its stem still takes up time, and every stemmed beat must count for the bar to add up.
        const stemsHere = lineStems
          .filter((st) => st.x >= bar.x0 - 2 && st.x < bar.x1 - 2)
          .sort((a, b) => a.x - b.x);
        const noteBeats = [];
        for (const st of stemsHere) {
          const last = noteBeats[noteBeats.length - 1];
          if (last && Math.abs(st.x - last.x) < 2) continue; // one beat per stem position
          noteBeats.push({ kind: 'note', x: st.x, notes: [] });
        }
        const stemless = [];
        for (const note of sortedNotes) {
          let best = null;
          // With stems in the bar, every note joins the nearest stemmed beat: notes without their own stem
          // here belong to a second voice (e.g. a held bass note) and must not add beats. Only a bar with no
          // stems at all (whole notes) makes stemless beats.
          let bestDist = noteBeats.length > 0 ? Infinity : 6;
          for (const nb of noteBeats) {
            const d = Math.abs(nb.x - note.x);
            if (d < bestDist) {
              bestDist = d;
              best = nb;
            }
          }
          if (best) {
            best.notes.push(note);
            continue;
          }
          const last = stemless[stemless.length - 1];
          if (last && Math.abs(note.x - last.x) < 3) {
            last.notes.push(note);
          } else {
            stemless.push({ kind: 'note', x: note.x, notes: [note] });
          }
        }
        noteBeats.push(...stemless);
        noteBeats.sort((a, b) => a.x - b.x);

        const restBeats = (bar.restXs || []).map((rx) => ({ kind: 'rest', x: rx }));
        const allBeats = [...noteBeats, ...restBeats].sort((a, b) => a.x - b.x);

        if (allBeats.length === 0) {
          bar.barLen = barLen;
          bar.exact = true;
          exactBars += 1;
          continue;
        }

        const barStems = lineStems.filter((st) => st.x >= bar.x0 - 5 && st.x <= bar.x1 + 5);
        const barBeams = lineBeams.filter((bm) => bm.x1 >= bar.x0 - 5 && bm.x0 <= bar.x1 + 5);
        const barFlags = lineFlagXs.filter((fx) => fx >= bar.x0 - 5 && fx <= bar.x1 + 5);

        for (const nb of noteBeats) {
          let bestStem = null;
          let bestDist = Infinity;
          for (const st of barStems) {
            const d = Math.abs(st.x - nb.x);
            if (d < 5 && d < bestDist) {
              bestDist = d;
              bestStem = st;
            }
          }
          nb.stemObj = bestStem;
          if (!bestStem) {
            nb.stem = 'none';
            nb.beams = 0;
            nb.dotted = false;
            nb.tuplet = 1;
            continue;
          }
          nb.stem = (bar.maxStemLen > 0 && bestStem.len < bar.shortStemCutoff) ? 'short' : 'full';

          const beamLevels = new Set();
          for (const bm of barBeams) {
            if (bestStem.x >= bm.x0 - 0.6 && bestStem.x <= bm.x1 + 0.6) {
              beamLevels.add(Math.round(bm.y));
            }
          }
          let beamCount = beamLevels.size;
          if (beamCount === 0) {
            for (const fx of barFlags) {
              if (Math.abs(fx - bestStem.x) <= 2) beamCount += 1;
            }
          }
          nb.beams = beamCount;
          nb.dotted = dotGlyphsInLine(line, bestStem.x);
          nb.tuplet = 1;
        }

        const barTuplets = lineTuplets.filter((tp) => tp.maxX >= bar.x0 - 25 && tp.minX <= bar.x1 + 25);
        for (const tp of barTuplets) {
          // The tuplet number sits over the middle of its group, so its group is the N stems nearest to it
          // (the group can be wider than the number itself, so no fixed distance limit).
          const candidates = noteBeats
            .filter((nb) => nb.stemObj && nb.stemObj.x >= bar.x0 - 2 && nb.stemObj.x <= bar.x1 + 2)
            .map((nb) => ({ nb, dist: Math.abs(nb.stemObj.x - tp.cx) }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, tp.n);
          for (const c of candidates) {
            c.nb.tuplet = tp.n;
          }
        }

        for (let bIdx = 0; bIdx < allBeats.length; bIdx++) {
          const beat = allBeats[bIdx];
          // Every beat gets its gap to the next beat: rests share leftover time by it, and a missing rest
          // is placed after the note beat with the widest gap.
          const nextX = bIdx + 1 < allBeats.length ? allBeats[bIdx + 1].x : bar.x1;
          beat.gapPx = Math.max(0, nextX - beat.x);
        }

        const hasStemmedNote = noteBeats.some((nb) => nb.stem !== 'none');
        const needStemsButNone = noteBeats.length > 0 && barStems.length === 0 && noteBeats.length > 1;
        const { durations, exact } = (needStemsButNone || typeof helper.beatDurations !== 'function')
          ? { durations: [], exact: false }
          : helper.beatDurations({ beats: allBeats, barLen });

        // Test hook: set globalThis.__woodshedDebugBars = [] before extracting to get per-bar rhythm summaries.
        if (Array.isArray(globalThis.__woodshedDebugBars)) {
          globalThis.__woodshedDebugBars.push({
            barLen,
            beats: allBeats.map((b) => (b.kind === 'rest'
              ? 'R'
              : `${b.stem[0]}${b.beams}${b.dotted ? '.' : ''}${b.tuplet > 1 ? 't' + b.tuplet : ''}`)).join(' '),
            stems: barStems.length,
            sum: allBeats.reduce((s, b, i) => s + (b.kind === 'note' ? (durations[i] || 0) : 0), 0),
            exact
          });
        }
        const valid = durations.length === allBeats.length && durations.every((d) => Number.isFinite(d) && d >= 0) && (hasStemmedNote || barStems.length === 0);
        if (!valid) {
          bar.exact = false;
          continue;
        }

        let pos = 0;
        for (let bIdx = 0; bIdx < allBeats.length; bIdx++) {
          const beat = allBeats[bIdx];
          if (beat.kind === 'note') {
            for (const note of beat.notes) {
              note.pos = pos;
            }
          }
          pos += durations[bIdx];
        }
        bar.barLen = barLen;
        bar.exact = Boolean(exact);
        if (bar.exact) exactBars += 1;
      }
    }

    const text = helper.buildAscii({ stringNames, lines: sortedLines });

    const warningParts = [];
    if (totalUnknown > 0) {
      warningParts.push(`Some symbols couldn't be read (${totalUnknown}).`);
    }
    let rhythmMsg = `Rhythm read exactly in ${exactBars} of ${totalBars} bars.`;
    if (exactBars < totalBars) {
      rhythmMsg += ' Check the others by ear.';
    }
    warningParts.push(rhythmMsg);
    warningParts.push('Reads the track currently shown.');

    return {
      ok: true,
      kind: 'tab',
      site: 'Songsterr',
      url,
      title,
      artist,
      tuning,
      capo: null,
      bpm: capturedBpm,
      text,
      message: '',
      warning: warningParts.join(' ')
    };
  }

  globalThis.__woodshedExtract = async function __woodshedExtract() {
    const url = location.href;
    const hostname = location.hostname || '';
    const knownSite = identifySite(hostname);
    const defaultMeta = parseTitleAndArtistFromDoc();
    let title = defaultMeta.title;
    let artist = defaultMeta.artist;
    let tuningHint = '';
    let capoHint = null;
    let bpmHint = null;

    if (knownSite === 'Songsterr') {
      return await readSongsterr(defaultMeta, url);
    }

    if (knownSite === 'Ultimate Guitar') {
      const storeEl = document.querySelector('div.js-store[data-content]');
      if (storeEl) {
        try {
          const parsed = JSON.parse(storeEl.getAttribute('data-content') || '{}');
          const data = parsed?.page?.data || {};
          const tab = data.tab || {};
          const tabView = data.tab_view || {};
          const meta = tabView.meta || {};

          if (tab.song_name) title = String(tab.song_name).trim();
          if (tab.artist_name) artist = String(tab.artist_name).trim();
          if (meta.tuning?.value) tuningHint = String(meta.tuning.value);
          else if (meta.tuning?.name) tuningHint = String(meta.tuning.name);
          if (meta.capo !== undefined && meta.capo !== null) capoHint = meta.capo;
          if (meta.bpm !== undefined && meta.bpm !== null) bpmHint = meta.bpm;

          const tabType = String(tab.type || '').trim();
          if (/^(?:Guitar Pro|Pro|Official|Power)$/i.test(tabType)) {
            return {
              ok: false,
              site: 'Ultimate Guitar',
              url,
              title,
              artist,
              tuning: detectTuning('', tuningHint),
              capo: detectCapo('', capoHint),
              bpm: detectBpm('', bpmHint),
              kind: 'unsupported',
              text: '',
              message: 'This is an interactive tab on Ultimate Guitar. Open the plain "Tab" version of the song, or use the Guitar Pro file if you own it'
            };
          }

          const wikiContent = tabView?.wiki_tab?.content;
          if (typeof wikiContent === 'string' && wikiContent.trim()) {
            const cleanedWiki = normalize(stripUgMarkup(wikiContent));
            if (countTabLines(cleanedWiki).maxRun >= 4) {
              const pageBody = document.body?.innerText || '';
              return {
                ok: true,
                site: 'Ultimate Guitar',
                url,
                title,
                artist,
                tuning: detectTuning(cleanedWiki, tuningHint) || detectTuning(pageBody, ''),
                capo: detectCapo(cleanedWiki, capoHint) ?? detectCapo(pageBody, null),
                bpm: detectBpm(cleanedWiki, bpmHint) ?? detectBpm(pageBody, null),
                kind: 'tab',
                text: cleanedWiki,
                message: ''
              };
            }
          }
        } catch (_err) {
          // Fall through to rendered DOM fallback
        }
      }

      if (/\/(?:pro|official)\//i.test(location.pathname)) {
        return {
          ok: false,
          site: 'Ultimate Guitar',
          url,
          title,
          artist,
          tuning: detectTuning('', tuningHint),
          capo: detectCapo('', capoHint),
          bpm: detectBpm('', bpmHint),
          kind: 'unsupported',
          text: '',
          message: 'This is an interactive tab on Ultimate Guitar. Open the plain "Tab" version of the song, or use the Guitar Pro file if you own it'
        };
      }
    }

    if (knownSite === 'Cifra Club') {
      // Cifra Club's class names change; its page title is reliably "<Song> (acordes|cifra|tab...) - <Artist> - Cifra
      // Club", and the song's <h1> is followed by the artist as the first visible <h2>.
      const h1 = (document.querySelector('h1.t1') || document.querySelector('h1'))?.textContent?.trim();
      const h2 = (document.querySelector('h2.t3') || Array.from(document.querySelectorAll('h2')).find((el) =>
        !/srOnly|sr-only/i.test(el.className || '') && (el.textContent || '').trim()))?.textContent?.trim();
      const parts = (document.title || '').split(/\s+-\s+/);
      if (parts.length >= 3 && /cifra club/i.test(parts[parts.length - 1])) {
        title = parts[0].replace(/\s*\([^)]*\)\s*$/, '').trim();
        artist = parts[parts.length - 2].trim();
      }
      if (h1) title = h1;
      if (h2) artist = h2;
      const capoEl = Array.from(document.querySelectorAll('[class*="capo"], #cifra_capo, span, div')).find((el) =>
        /capotraste/i.test(el.textContent || '') && (el.textContent || '').length < 80
      );
      if (capoEl) {
        const m = capoEl.textContent.match(/capotraste\s*[:=-]?\s*(\d{1,2}|[IVX]+)/i);
        if (m) capoHint = m[1];
      }
    }

    if (knownSite === 'E-Chords') {
      const h1 = document.querySelector('h1')?.textContent?.trim();
      const h2 = document.querySelector('h2')?.textContent?.trim();
      if (h1) title = h1;
      if (h2) artist = h2;
    }

    const pageText = document.body?.innerText || '';

    // 1. Selection strategy (if >= 3 lines)
    const rawSelection = window.getSelection ? String(window.getSelection()) : '';
    if (rawSelection && rawSelection.split(/\r?\n/).length >= 3) {
      const cleanedSel = normalize(stripUgMarkup(rawSelection));
      if (countTabLines(cleanedSel).maxRun >= 4) {
        return {
          ok: true,
          site: 'selection',
          url,
          title,
          artist,
          tuning: detectTuning(cleanedSel, tuningHint) || detectTuning(pageText, ''),
          capo: detectCapo(cleanedSel, capoHint) ?? detectCapo(pageText, null),
          bpm: detectBpm(cleanedSel, bpmHint) ?? detectBpm(pageText, null),
          kind: 'tab',
          text: cleanedSel,
          message: ''
        };
      }
    }

    // 2 & 3. Site-specific containers + Generic blocks
    const extraSelectors = [];
    if (knownSite === 'Ultimate Guitar') extraSelectors.push('[class*="Tablature"]');
    if (knownSite === 'Cifra Club') extraSelectors.push('.cifra_cnt pre');
    if (knownSite === 'E-Chords') extraSelectors.push('pre#core');

    const blocks = collectGenericBlocks(extraSelectors);
    const best = blocks[0] || null;

    if (best && best.maxRun >= 4) {
      return {
        ok: true,
        site: knownSite || 'generic',
        url,
        title,
        artist,
        tuning: detectTuning(best.text, tuningHint) || detectTuning(pageText, ''),
        capo: detectCapo(best.text, capoHint) ?? detectCapo(pageText, null),
        bpm: detectBpm(best.text, bpmHint) ?? detectBpm(pageText, null),
        kind: 'tab',
        text: best.text,
        message: ''
      };
    }

    if (knownSite === '911Tabs') {
      return {
        ok: false,
        site: '911Tabs',
        url,
        title,
        artist,
        tuning: '',
        capo: null,
        bpm: null,
        kind: 'unsupported',
        text: '',
        message: '911Tabs links to other sites; open one of the results'
      };
    }

    if (knownSite === 'Chordify') {
      return {
        ok: false,
        site: 'Chordify',
        url,
        title,
        artist,
        tuning: '',
        capo: null,
        bpm: null,
        kind: 'chords',
        text: '',
        message: 'Chordify has chords only, no tab — Woodshed needs tab notation'
      };
    }

    const checkText = best ? best.text : normalize(pageText);
    if (hasChordOverLyricLines(checkText)) {
      return {
        ok: false,
        site: knownSite || 'generic',
        url,
        title,
        artist,
        tuning: detectTuning(checkText, tuningHint),
        capo: detectCapo(checkText, capoHint),
        bpm: detectBpm(checkText, bpmHint),
        kind: 'chords',
        text: checkText,
        message: 'This page has chords but no tab lines — Woodshed needs tab notation'
      };
    }

    return {
      ok: false,
      site: knownSite || 'generic',
      url,
      title,
      artist,
      tuning: '',
      capo: null,
      bpm: null,
      kind: 'unsupported',
      text: '',
      message: 'No ASCII guitar tab was found on this page.'
    };
  };
})();
globalThis.__woodshedExtract();
