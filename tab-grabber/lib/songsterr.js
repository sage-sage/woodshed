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

  const NOTATION_SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiToSharpNoteName(midi) {
    if (!Number.isFinite(midi)) return 'E';
    const m = Math.round(midi);
    return NOTATION_SHARP_NAMES[((m % 12) + 12) % 12];
  }

  function notationTupletRatio(tuplet) {
    if (!Number.isInteger(tuplet) || tuplet < 2) return 1;
    const p = 1 << Math.floor(Math.log2(tuplet - 1));
    return p / tuplet;
  }

  function notationBeatWhole(beat) {
    if (!beat || !Array.isArray(beat.duration) || beat.duration.length < 2) return 0;
    const n = Number(beat.duration[0]);
    const d = Number(beat.duration[1]);
    if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return 0;
    return n / d;
  }

  function notationToAscii(notation) {
    if (!notation || typeof notation !== 'object' || !Array.isArray(notation.measures)) {
      return '';
    }
    const rawTuning = Array.isArray(notation.tuning) && notation.tuning.length > 0
      ? notation.tuning
      : [64, 59, 55, 50, 45, 40];
    const stringCount = rawTuning.length;
    const labels = rawTuning.map((m) => midiToSharpNoteName(m));
    if (labels.length >= 2 && labels[0] === 'E' && labels[labels.length - 1] === 'E') {
      labels[0] = 'e';
    }
    const labelWidth = labels.reduce((max, lbl) => Math.max(max, lbl.length), 1);
    const paddedLabels = labels.map((lbl) => lbl.padEnd(labelWidth, ' '));

    let curNum = 4;
    let curDen = 4;
    const renderedMeasures = [];

    for (const measure of notation.measures) {
      const m = measure || {};
      if (
        Array.isArray(m.signature) &&
        m.signature.length >= 2 &&
        Number.isFinite(m.signature[0]) &&
        m.signature[0] > 0 &&
        Number.isFinite(m.signature[1]) &&
        m.signature[1] > 0
      ) {
        curNum = Math.round(m.signature[0]);
        curDen = Math.round(m.signature[1]);
      }
      const measureWhole = curNum / curDen;
      const voice = Array.isArray(m.voices) ? m.voices[0] : null;
      const beats = voice && Array.isArray(voice.beats)
        ? voice.beats.filter((b) => b && !b.graceNote)
        : [];

      const rows = Array.from({ length: stringCount }, () => '');

      if (beats.length === 0) {
        const cols = Math.max(2, Math.round(1 + 16 * measureWhole));
        for (let s = 0; s < stringCount; s++) {
          rows[s] = '-'.repeat(cols);
        }
        renderedMeasures.push(rows);
        continue;
      }

      const rawDurs = beats.map((b) => notationBeatWhole(b));
      const hasTuplet = beats.some((b) => Number.isInteger(b.tuplet) && b.tuplet >= 2);
      let effDurs = rawDurs;
      // Songsterr durations already include tuplets ([1,12] = triplet eighth); scale only when the raw
      // values do not fill the bar and the scaled ones do (older files).
      const rawSum = rawDurs.reduce((acc, v) => acc + v, 0);
      if (hasTuplet && Math.abs(rawSum - measureWhole) >= 1e-6) {
        const adj = beats.map((b, idx) => rawDurs[idx] * notationTupletRatio(b.tuplet));
        const adjSum = adj.reduce((acc, v) => acc + v, 0);
        if (Math.abs(adjSum - measureWhole) < 1e-6) {
          effDurs = adj;
        }
      }

      for (let bIdx = 0; bIdx < beats.length; bIdx++) {
        const beat = beats[bIdx];
        const w = effDurs[bIdx] > 0 ? effDurs[bIdx] : (measureWhole / beats.length);
        const propCols = Math.max(2, Math.round(1 + 16 * w));
        const tokensByString = Array(stringCount).fill('');
        let maxTokenLen = 0;

        if (!beat.rest && Array.isArray(beat.notes)) {
          for (const note of beat.notes) {
            if (!note || note.rest) continue;
            const s = note.string;
            if (!Number.isInteger(s) || s < 0 || s >= stringCount) continue;
            if (tokensByString[s]) continue;
            const base = note.dead
              ? 'x'
              : String(Number.isFinite(note.fret) ? Math.max(0, Math.round(note.fret)) : 0);
            const tok = note.tie ? `(${base})` : base;
            tokensByString[s] = tok;
            if (tok.length > maxTokenLen) maxTokenLen = tok.length;
          }
        }

        const groupWidth = Math.max(propCols, maxTokenLen > 0 ? maxTokenLen + 1 : 2);
        for (let s = 0; s < stringCount; s++) {
          const tok = tokensByString[s];
          rows[s] += tok ? tok.padEnd(groupWidth, '-') : '-'.repeat(groupWidth);
        }
      }

      renderedMeasures.push(rows);
    }

    const systems = [];
    for (let start = 0; start < renderedMeasures.length; start += 4) {
      const chunk = renderedMeasures.slice(start, start + 4);
      const sysRows = paddedLabels.map((lbl, s) => {
        const cells = chunk.map((mRows) => mRows[s]);
        return `${lbl}|${cells.join('|')}|`;
      });
      systems.push(sysRows.join('\n'));
    }

    return systems.join('\n\n');
  }

  // ---- Which Songsterr track is shown -------------------------------------------------------------
  // Songsterr is a single-page app: the <script id="state"> JSON is written once by the server and is NOT
  // updated when you move to another song inside the site, so it can describe a song you left minutes ago.
  // The address bar, the rendered tab and the track name in the header are live; the state only counts when
  // its song id matches the address.

  function parseSongsterrUrl(url) {
    const s = String(url || '');
    const m = s.match(/-s(\d+)(?:t(\d+))?(?:\/r(\d+))?(?=[/?#]|$)/);
    if (!m) return { songId: null, partId: null, revisionId: null };
    return {
      songId: m[1],
      partId: m[2] !== undefined ? parseInt(m[2], 10) : null,
      revisionId: m[3] !== undefined ? parseInt(m[3], 10) : null
    };
  }

  function normName(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function isPlayableTrack(t) {
    if (!t || typeof t !== 'object') return false;
    if (t.isVocalTrack || t.isDrums) return false;
    const id = Number(t.instrumentId);
    // General MIDI 24-31 are guitars, 32-39 basses; Songsterr drums are 1024.
    if (Number.isFinite(id) && id >= 24 && id <= 39) return true;
    return /guitar|bass/i.test(String(t.instrument || ''));
  }

  /** Notes you actually pick: rests and tied continuations don't count. */
  function countPlayedNotes(raw) {
    let n = 0;
    const measures = raw && Array.isArray(raw.measures) ? raw.measures : [];
    for (const m of measures) {
      for (const v of (m && Array.isArray(m.voices) ? m.voices : [])) {
        for (const b of (v && Array.isArray(v.beats) ? v.beats : [])) {
          if (!b || b.rest) continue;
          for (const note of (Array.isArray(b.notes) ? b.notes : [])) {
            if (note && !note.rest && !note.tie) n += 1;
          }
        }
      }
    }
    return n;
  }

  /** A track with almost nothing to play for its length is probably not the part you want. */
  function isSparseTrack(noteCount, measureCount) {
    const n = Number(noteCount) || 0;
    const bars = Number(measureCount) || 0;
    return n < Math.max(24, bars * 0.5);
  }

  /**
   * Decides which song, revision and track to read.
   * input: { url, state (parsed #state JSON or null), apiMeta (/api/meta/<song> JSON or null),
   *          headerTexts (texts of the header's track-name spans), domPartIds (data-part-id values in the
   *          rendered tab), chosenPartId (the user's pick in the popup, or null) }
   * Signals in order of trust: the user's pick, the track name in the header, the rendered tab's part id,
   * the address's "t<N>", then the page state (only if it is for this song).
   */
  function resolveSongsterrTrack(input = {}) {
    const notes = [];
    const u = parseSongsterrUrl(input.url);
    const meta = input.state && typeof input.state.meta === 'object' && input.state.meta ? input.state.meta : {};
    const cur = meta.current && typeof meta.current === 'object' ? meta.current : {};
    const rawStateSong = meta.songId ?? cur.songId ?? null;
    const stateSongId = rawStateSong !== null && rawStateSong !== undefined && rawStateSong !== '' ? String(rawStateSong) : null;
    const songId = u.songId ?? stateSongId;
    if (!songId) {
      return { songId: null, revisionId: null, image: null, partId: null, partSource: '', tracks: [], stateFresh: false, notes: ['no song id'] };
    }
    const stateFresh = stateSongId !== null && stateSongId === songId;
    if (stateSongId !== null && !stateFresh) notes.push(`page state is for song ${stateSongId}, not ${songId}: ignored`);
    const api = input.apiMeta && typeof input.apiMeta === 'object' && String(input.apiMeta.songId) === songId ? input.apiMeta : null;

    const rawTracks = stateFresh && Array.isArray(cur.tracks) && cur.tracks.length > 0
      ? cur.tracks
      : (api && Array.isArray(api.tracks) ? api.tracks : []);
    const tracks = rawTracks.map((t, i) => ({
      partId: Number.isInteger(t?.partId) ? t.partId : i,
      name: typeof t?.name === 'string' ? t.name : '',
      instrument: typeof t?.instrument === 'string' ? t.instrument : '',
      instrumentId: Number.isFinite(t?.instrumentId) ? t.instrumentId : null,
      playable: isPlayableTrack(t)
    }));

    let revisionId = u.revisionId;
    let image = null;
    const stateRev = stateFresh ? (cur.revisionId ?? meta.revisionId ?? null) : null;
    if (revisionId === null && Number.isFinite(Number(stateRev)) && stateRev !== null) revisionId = Number(stateRev);
    if (revisionId === null && api && Number.isFinite(Number(api.revisionId))) revisionId = Number(api.revisionId);
    // The data folder name ("v0-3-2-...") belongs to one revision.
    if (stateFresh && typeof cur.image === 'string' && Number(cur.revisionId) === revisionId) image = cur.image;
    else if (api && typeof api.image === 'string' && Number(api.revisionId) === revisionId) image = api.image;

    const known = (id) => tracks.length === 0 || tracks.some((t) => t.partId === id);
    const candidates = [];
    const chosen = Number.parseInt(input.chosenPartId, 10);
    if (Number.isInteger(chosen) && known(chosen)) candidates.push(['chosen', chosen]);

    // The header shows the instrument and the track name, sometimes in one element ("Overdriven GuitarRobert
    // Smith | ... | Lead Guitar"), so a track matches when its name is inside a header text. When names nest
    // ("Lead" and "Lead 2"), the longest match wins; equal names can't be told apart.
    const headers = (Array.isArray(input.headerTexts) ? input.headerTexts : []).map(normName).filter(Boolean);
    if (headers.length > 0 && tracks.length > 0) {
      const hits = tracks.filter((t) => normName(t.name) && headers.some((h) => h.includes(normName(t.name))));
      const longest = hits.reduce((m, t) => Math.max(m, normName(t.name).length), 0);
      const best = hits.filter((t) => normName(t.name).length === longest);
      if (best.length === 1) candidates.push(['header', best[0].partId]);
      else if (best.length > 1) notes.push('several tracks share the shown name');
    }
    const domIds = Array.from(new Set((Array.isArray(input.domPartIds) ? input.domPartIds : [])
      .map((v) => Number.parseInt(v, 10)).filter(Number.isInteger)));
    if (domIds.length === 1 && known(domIds[0])) candidates.push(['page', domIds[0]]);
    else if (domIds.length > 1) notes.push(`the page shows several parts (${domIds.join(', ')})`);
    if (u.partId !== null && known(u.partId)) candidates.push(['address', u.partId]);
    const statePart = stateFresh ? Number.parseInt(meta.partId ?? cur.partId, 10) : NaN;
    if (Number.isInteger(statePart) && known(statePart)) candidates.push(['state', statePart]);

    const [partSource, partId] = candidates[0] || ['', null];
    for (const [src, id] of candidates.slice(1)) {
      if (id !== partId) notes.push(`${src} says track ${id}, ${partSource} says ${partId}`);
    }
    return { songId, revisionId, image, partId, partSource, tracks, stateFresh, notes };
  }

  /** Picks the note-data URL for one part from the page's loaded resources (or builds it). */
  function findPartJsonUrl(resourceNames, { songId, revisionId, image, partId }) {
    const re = new RegExp(`^/${String(songId).replace(/\D/g, '')}/(\\d+)/([^/]+)/(\\d+)\\.json$`);
    const found = [];
    for (const name of Array.isArray(resourceNames) ? resourceNames : []) {
      try {
        const p = new URL(name);
        if (!p.hostname.toLowerCase().endsWith('cloudfront.net')) continue;
        const m = p.pathname.match(re);
        if (m) found.push({ url: name, origin: p.origin, rev: parseInt(m[1], 10), image: m[2], part: parseInt(m[3], 10) });
      } catch (_err) {
        // not a URL
      }
    }
    const pick = (pool) => {
      for (let i = pool.length - 1; i >= 0; i--) {
        if (pool[i].part === partId) return { url: pool[i].url, revisionId: pool[i].rev };
      }
      // The part wasn't downloaded yet: same folder, other file name.
      const ref = pool[pool.length - 1];
      return ref ? { url: `${ref.origin}/${songId}/${ref.rev}/${ref.image}/${partId}.json`, revisionId: ref.rev } : null;
    };
    const hasRev = revisionId !== null && revisionId !== undefined;
    const sameRev = hasRev ? found.filter((f) => f.rev === revisionId) : found;
    if (sameRev.length > 0) return pick(sameRev);
    if (hasRev && image) {
      const origin = found[0]?.origin || 'https://dqsljvtekg760.cloudfront.net';
      return { url: `${origin}/${songId}/${revisionId}/${image}/${partId}.json`, revisionId };
    }
    return pick(found);
  }

  globalThis.WoodshedSongsterrTracks = {
    parseSongsterrUrl,
    isPlayableTrack,
    countPlayedNotes,
    isSparseTrack,
    resolveSongsterrTrack,
    findPartJsonUrl
  };

  globalThis.WoodshedNotation = {
    notationToAscii
  };

  globalThis.WoodshedSongsterr = {
    DIGIT_TEMPLATES,
    classifyGlyph,
    beatDurations,
    buildAscii,
    notationToAscii
  };
})();
