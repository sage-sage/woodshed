(() => {
  const DIGIT_TEMPLATES = {
    '0': '..####...######.###..##.###..######..######..######..######..######..###.##..###.######...####..',
    '2': '..####...######.###..###.#....##.....###.....##.....###...####....###....###....################',
    '3': '..####...######.###..##......##.....###....###......###......###......#####..###.######...####..',
    '4': '....###.....###....####....####...#####..##.###..##.###.########################....###.....###.',
    '5': '.#######.#######.##......##......######.#######......###......##.....######..###.######...####..',
    '6': '..#####..######.###..######.....######..#######.###..######...#####..###.###.###.#######..####..',
    '7': '################.....###....###.....##.....###.....##.....###.....###.....##......##......##....',
    '8': '..####...######.###..######..###.######...####...######.###..#####....#####..###.######...####..',
    '9': '..####..#######.###.###.###..#####...######..###.#######..######.....######..###.######..#####..'
  };

  // Non-digit symbols matched the same way: 'x' is a dead (muted) note, ~9.3 x 10.
  const SYMBOL_TEMPLATES = {
    x: '###..###.##..##..###.##...####....####.....##......##.....####....####...##..##..##..##.##....##'
  };
  const ALL_TEMPLATES = { ...DIGIT_TEMPLATES, ...SYMBOL_TEMPLATES };
  const TEMPLATE_KEYS = Object.keys(ALL_TEMPLATES);

  function classifyGlyph(bitmap96, aspect) {
    if (typeof bitmap96 !== 'string' || bitmap96.length !== 96) {
      return null;
    }
    // Brackets around tied notes are ~3 x 10 (aspect ~0.3); a "1" is ~4.4 x 10 (aspect ~0.44).
    // A bracket's middle rows have their ink on the outer side: left for "(", right for ")".
    if (typeof aspect === 'number' && Number.isFinite(aspect) && aspect < 0.38) {
      let left = 0;
      let right = 0;
      for (let row = 4; row <= 7; row++) {
        for (let col = 0; col < 8; col++) {
          if (bitmap96[row * 8 + col] === '#') {
            if (col < 4) left += 1;
            else right += 1;
          }
        }
      }
      return left >= right ? '(' : ')';
    }
    if (typeof aspect === 'number' && Number.isFinite(aspect) && aspect < 0.52) {
      return '1';
    }

    let bestDigit = null;
    let bestDist = Infinity;

    for (let k = 0; k < TEMPLATE_KEYS.length; k++) {
      const digit = TEMPLATE_KEYS[k];
      const tpl = ALL_TEMPLATES[digit];
      let dist = 0;
      for (let i = 0; i < 96; i++) {
        if (bitmap96[i] !== tpl[i]) {
          dist += 1;
        }
      }
      if (dist < bestDist) {
        bestDist = dist;
        bestDigit = digit;
      }
    }

    return bestDist > 22 ? null : bestDigit;
  }

  const TUPLET_RATIOS = {
    2: 3 / 2,
    3: 2 / 3,
    4: 3 / 4,
    5: 4 / 5,
    6: 4 / 6,
    7: 4 / 7,
    9: 8 / 9
  };

  function beatDurations({ beats, barLen } = {}) {
    const list = Array.isArray(beats) ? beats : [];
    if (!Number.isFinite(barLen) || barLen <= 0) {
      return { durations: list.map(() => NaN), exact: false };
    }
    if (list.length === 0) {
      return { durations: [], exact: true };
    }

    const durations = Array(list.length).fill(0);
    const noteIndices = [];
    const restIndices = [];
    let known = 0;

    for (let i = 0; i < list.length; i++) {
      const b = list[i] || {};
      if (b.kind === 'rest') {
        restIndices.push(i);
        continue;
      }
      noteIndices.push(i);
      const stem = b.stem || 'none';
      let dur;
      if (stem === 'none') {
        dur = 1;
      } else if (stem === 'short') {
        dur = 0.5;
      } else {
        const beams = Number.isFinite(b.beams) && b.beams > 0 ? Math.floor(b.beams) : 0;
        dur = 0.25 / Math.pow(2, beams);
      }
      if (b.dotted) dur *= 1.5;
      if (Number.isFinite(b.tuplet) && b.tuplet > 1) {
        const ratio = Object.prototype.hasOwnProperty.call(TUPLET_RATIOS, b.tuplet)
          ? TUPLET_RATIOS[b.tuplet]
          : ((1 << Math.floor(Math.log2(b.tuplet))) / b.tuplet);
        dur *= ratio;
      }
      if (!Number.isFinite(dur) || dur <= 0) {
        return { durations: list.map(() => NaN), exact: false };
      }
      durations[i] = dur;
      known += dur;
    }

    let exact = true;
    if (restIndices.length > 0) {
      const remaining = barLen - known;
      if (remaining > 1e-6) {
        const gaps = restIndices.map((idx) => {
          const g = list[idx]?.gapPx;
          return Number.isFinite(g) && g > 0 ? g : 0;
        });
        const gapSum = gaps.reduce((sum, g) => sum + g, 0);
        for (let r = 0; r < restIndices.length; r++) {
          const weight = gapSum > 0 ? (gaps[r] / gapSum) : (1 / restIndices.length);
          durations[restIndices[r]] = remaining * weight;
        }
      } else {
        for (const idx of restIndices) durations[idx] = 0;
        if (remaining < -1e-6) exact = false;
      }
    } else if (barLen - known > 1e-6 && noteIndices.length > 0) {
      // Too short with no rest seen: a rest we couldn't detect (half rests are plain bars, for example).
      // Put the missing time after the beat with the widest gap to the next beat: notes keep their exact
      // starts when it's one rest, which is the common case.
      let widest = noteIndices[noteIndices.length - 1];
      let widestGap = -Infinity;
      for (const idx of noteIndices) {
        const g = Number.isFinite(list[idx]?.gapPx) ? list[idx].gapPx : 0;
        if (g > widestGap) {
          widestGap = g;
          widest = idx;
        }
      }
      durations[widest] += barLen - known;
      // A whole number of 32nds missing is a plausible rest; anything else means the reading was off.
      const missing32 = (barLen - known) * 32;
      exact = Math.abs(missing32 - Math.round(missing32)) < 1e-6;
    } else if (Math.abs(known - barLen) > 1e-6) {
      exact = false;
      if (known > 0) {
        const scale = barLen / known;
        for (const idx of noteIndices) {durations[idx] *= scale;}
      }
    }

    return { durations, exact };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function isFreeSpan(row, start, len) {
    if (start < 0 || start + len > row.length) return false;
    if (start > 0 && row[start - 1] !== '-') return false;
    if (start + len < row.length && row[start + len] !== '-') return false;
    for (let i = 0; i < len; i++) {
      if (row[start + i] !== '-') return false;
    }
    return true;
  }

  function buildAscii({ stringNames, lines } = {}) {
    const rawNames = Array.isArray(stringNames) && stringNames.length > 0
      ? stringNames.map((n) => String(n || '').trim() || ' ')
      : ['E', 'B', 'G', 'D', 'A', 'E'];

    const labels = rawNames.slice();
    if (labels.length >= 2 && labels[0] === 'E' && labels[labels.length - 1] === 'E') {
      labels[0] = 'e';
    }
    const labelWidth = labels.reduce((max, lbl) => Math.max(max, lbl.length), 1);
    const paddedLabels = labels.map((lbl) => lbl.padEnd(labelWidth, ' '));

    const lineList = Array.isArray(lines) ? lines : [];
    const systems = [];

    for (let l = 0; l < lineList.length; l++) {
      const line = lineList[l];
      const bars = Array.isArray(line?.bars) ? line.bars : [];
      if (bars.length === 0) continue;

      const stringBarCells = Array.from({ length: paddedLabels.length }, () => []);

      for (let b = 0; b < bars.length; b++) {
        const bar = bars[b] || {};
        const x0 = Number.isFinite(bar.x0) ? bar.x0 : 0;
        const x1 = Number.isFinite(bar.x1) ? bar.x1 : x0 + 40;
        const span = x1 - x0;
        const notes = Array.isArray(bar.notes) ? bar.notes.slice() : [];
        const hasBarLen = Number.isFinite(bar.barLen) && bar.barLen > 0;
        const useTimePos = hasBarLen && notes.every((note) => !note || Number.isFinite(note.pos));
        const cols = useTimePos
          ? Math.max(4, Math.round(bar.barLen * 64) + 2)
          : clamp(Math.round(span / 5), 8, 64);

        const barRows = Array.from({ length: paddedLabels.length }, () => Array(cols).fill('-'));
        if (useTimePos) {
          notes.sort((a, c) => ((a.pos ?? 0) - (c.pos ?? 0)) || ((a.x ?? 0) - (c.x ?? 0)));
        } else {
          notes.sort((a, c) => (a.x ?? 0) - (c.x ?? 0));
        }

        for (let n = 0; n < notes.length; n++) {
          const note = notes[n];
          if (!note) continue;
          const sIdx = note.string;
          if (!Number.isInteger(sIdx) || sIdx < 0 || sIdx >= paddedLabels.length) continue;

          const fretStr = String(note.fret ?? '').trim();
          if (!fretStr) continue;

          const isDead = fretStr === 'x';
          const preStr = !isDead && note.pre ? String(note.pre)[0] : '';
          const postStr = !isDead && note.post ? String(note.post) : '';
          const fretPostLen = fretStr.length + postStr.length;
          const fullLen = preStr.length + fretPostLen;

          const maxStart = Math.max(1, cols - fullLen - 1);
          const maxFretOnlyStart = Math.max(1, cols - fretPostLen - 1);
          if (1 + fretPostLen > cols) continue;

          let rawCol;
          if (useTimePos) {
            rawCol = 1 + Math.round((note.pos / bar.barLen) * (cols - 2));
          } else {
            const nx = Number.isFinite(note.x) ? note.x : x0;
            rawCol = span > 0 ? 1 + Math.floor(((nx - x0) / span) * (cols - 2)) : 1;
          }
          const targetCol = clamp(rawCol, 1, maxStart);
          const row = barRows[sIdx];

          const loopMax = Math.max(maxStart, maxFretOnlyStart);
          for (let c = targetCol; c <= loopMax; c++) {
            const usePre = preStr.length > 0 && c - preStr.length >= 1 && c <= maxStart;
            const startCol = usePre ? c - preStr.length : c;
            const token = usePre ? (preStr + fretStr + postStr) : (fretStr + postStr);
            if (isFreeSpan(row, startCol, token.length)) {
              for (let chIdx = 0; chIdx < token.length; chIdx++) {
                row[startCol + chIdx] = token[chIdx];
              }
              break;
            }
          }
        }

        for (let s = 0; s < paddedLabels.length; s++) {
          stringBarCells[s].push(barRows[s].join(''));
        }
      }

      const rows = paddedLabels.map((lbl, s) => `${lbl}|${stringBarCells[s].join('|')}|`);
      systems.push(rows.join('\n'));
    }

    return systems.join('\n\n');
  }

  globalThis.WoodshedSongsterr = {
    DIGIT_TEMPLATES,
    classifyGlyph,
    beatDurations,
    buildAscii
  };
})();
