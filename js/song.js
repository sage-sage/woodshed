export const TUNINGS = {
  'Standard': [40, 45, 50, 55, 59, 64],
  'Drop D': [38, 45, 50, 55, 59, 64],
  'Eb Standard': [39, 44, 49, 54, 58, 63],
  'D Standard': [38, 43, 48, 53, 57, 62],
  'Drop C': [36, 43, 48, 53, 57, 62],
  'DADGAD': [38, 45, 50, 55, 57, 62],
  'Open G': [38, 43, 50, 55, 59, 62],
  'Open D': [38, 45, 50, 54, 57, 62],
  'Open E': [40, 47, 52, 56, 59, 64],
  '7-string Standard': [35, 40, 45, 50, 55, 59, 64],
  'Bass Standard': [28, 33, 38, 43]
};

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export function midiToName(midi, useFlats = false) {
  if (!Number.isFinite(midi)) return '';
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  const oct = Math.floor(m / 12) - 1;
  const table = useFlats ? FLAT_NAMES : SHARP_NAMES;
  return `${table[pc]}${oct}`;
}

export const DEMO_SONG_TAB = [
  '# Title: Timberline Drive',
  '# Artist: Woodshed House Band',
  '# Tempo: 112',
  'e|-----------------|-----------------|-----------------|-----------------|',
  'B|-------------1---|-------------0---|-------------1---|-----------------|',
  'G|---------2-----2-|---------0-----0-|---------2-----2-|-----0h2p0-------|',
  'D|-----2-----------|-----0-----------|-----3-----------|---2-------2-----|',
  'A|-0-----0---0-----|-------2---------|-3-----3---3-----|-------------3-2-|',
  'E|-----------------|-3---------3-----|-----------------|-0---------------|',
  '',
  'e|-----------------|-----------------|-----------------|-----0-----------|',
  'B|-----1-------1---|-----0-------0---|-----1-------0---|-----1-----------|',
  'G|-----2-------2---|-----0-------0---|-----2-------1---|-----2-----------|',
  'D|-----2---2h3---2-|-----0---0h2---0-|-----3-------2---|-----2-----------|',
  'A|-0---------------|-2---------------|-3-------2-------|-0---0-----------|',
  'E|-----------------|-3---------------|---------0-------|-----------------|',
].join('\n');

export function makeSong(partial = {}) {
  const tuning = Array.isArray(partial.tuning) && partial.tuning.length >= 4 && partial.tuning.length <= 8
    ? [...partial.tuning]
    : [...TUNINGS['Standard']];
  const capo = Number.isFinite(partial.capo) ? Math.max(0, Math.round(partial.capo)) : 0;
  const bpm = Number.isFinite(partial.bpm) && partial.bpm > 0 ? partial.bpm : 120;

  const rawNotes = Array.isArray(partial.notes) ? partial.notes : [];
  const notes = rawNotes.map((n) => {
    const string = Math.max(0, Math.min(tuning.length - 1, Number(n.string) || 0));
    const fret = Math.max(0, Number(n.fret) || 0);
    const midi = Number.isFinite(n.midi) ? n.midi : (tuning[string] + capo + fret);
    return {
      t: Math.max(0, Number(n.t) || 0),
      dur: Math.max(0.02, Number(n.dur) || (60 / bpm / 2)),
      string,
      fret,
      midi,
      tech: n.tech || '',
      tie: Boolean(n.tie),
      dead: Boolean(n.dead),
      ...(Number(n.bend) > 0 ? { bend: Number(n.bend) } : {})
    };
  }).sort((a, b) => (a.t - b.t) || (a.string - b.string));

  let bars = Array.isArray(partial.bars) ? partial.bars.map((b) => ({
    t: Number(b.t) || 0,
    dur: Number(b.dur) || (4 * 60 / bpm),
    num: Number(b.num) || 4,
    den: Number(b.den) || 4,
    bpm: Number(b.bpm) || bpm,
    ...(b.label ? { label: String(b.label) } : {})
  })) : [];

  const lastNoteEnd = notes.reduce((max, n) => Math.max(max, n.t + n.dur), 0);
  const lastBarEnd = bars.reduce((max, b) => Math.max(max, b.t + b.dur), 0);
  const duration = Number.isFinite(partial.duration) && partial.duration > 0
    ? partial.duration
    : Math.max(lastNoteEnd, lastBarEnd, 4 * 60 / bpm);

  if (bars.length === 0) {
    const barDur = 4 * (60 / bpm);
    const count = Math.max(1, Math.ceil(duration / barDur));
    for (let i = 0; i < count; i++) {
      bars.push({ t: i * barDur, dur: barDur, num: 4, den: 4, bpm });
    }
  }

  return {
    id: partial.id || `song-${Math.random().toString(36).slice(2, 10)}`,
    title: partial.title || 'Untitled Riff',
    artist: partial.artist || 'Unknown Artist',
    tuning,
    capo,
    bpm,
    notes,
    bars,
    duration,
    source: partial.source || 'ascii',
    exactRhythm: Boolean(partial.exactRhythm),
    ...(partial.instrument ? { instrument: { program: Number(partial.instrument.program), name: String(partial.instrument.name || '') } } : {})
  };
}

export function buildEvents(song) {
  if (!song || !Array.isArray(song.notes)) return [];
  const playable = song.notes.filter((n) => !n.dead && !n.tie);
  if (playable.length === 0) return [];

  const sorted = [...playable].sort((a, b) => (a.t - b.t) || (a.string - b.string));
  const events = [];
  let current = null;

  for (const n of sorted) {
    if (!current || Math.abs(n.t - current.t) >= 0.002) {
      if (current) events.push(current);
      current = {
        t: n.t,
        dur: n.dur,
        notes: [n],
        index: events.length
      };
    } else {
      current.notes.push(n);
      if (n.dur > current.dur) current.dur = n.dur;
    }
  }
  if (current) events.push(current);
  return events;
}

export function sliceSong(song, t0, t1) {
  const start = Math.max(0, Math.min(t0, t1));
  const end = Math.max(start, Math.max(t0, t1));
  const notes = song.notes
    .filter((n) => n.t >= start - 1e-6 && n.t < end + 1e-6)
    .map((n) => ({
      ...n,
      t: n.t,
      dur: Math.min(n.dur, Math.max(0.02, end - n.t))
    }));
  const bars = song.bars
    .filter((b) => b.t + b.dur > start + 1e-6 && b.t < end - 1e-6)
    .map((b) => ({ ...b }));
  return makeSong({
    ...song,
    id: `${song.id}-slice-${start.toFixed(2)}-${end.toFixed(2)}`,
    notes,
    bars,
    duration: end
  });
}

function findPlayablePosition(targetPc, tuning, capo, preferredMaxFret = 7) {
  let best = null;
  for (let s = 0; s < tuning.length; s++) {
    const openMidi = tuning[s] + capo;
    for (let fret = 0; fret <= preferredMaxFret; fret++) {
      const midi = openMidi + fret;
      if (((midi % 12) + 12) % 12 === ((targetPc % 12) + 12) % 12) {
        const score = s * 4 + fret;
        if (!best || score < best.score) {
          best = { string: s, fret, midi, score };
        }
      }
    }
  }
  if (best) return { string: best.string, fret: best.fret, midi: best.midi };
  const openMidi = tuning[0] + capo;
  const fret = (((targetPc - openMidi) % 12) + 12) % 12;
  return { string: 0, fret, midi: openMidi + fret };
}

export function skeletonSong(song, analysis, level = 3) {
  if (level >= 3 || !song) {
    return makeSong({ ...song });
  }

  if (level === 1) {
    const chords = (analysis && Array.isArray(analysis.chords) && analysis.chords.length > 0)
      ? analysis.chords
      : [];
    const skelNotes = [];

    if (chords.length > 0) {
      let lastChordName = null;
      for (const ch of chords) {
        if (!ch.chord) continue;
        if (ch.chord.name === lastChordName && skelNotes.length > 0) {
          skelNotes[skelNotes.length - 1].dur += ch.dur;
          continue;
        }
        lastChordName = ch.chord.name;
        const pos = findPlayablePosition(ch.chord.root, song.tuning, song.capo, 7);
        skelNotes.push({
          t: ch.t,
          dur: Math.max(0.25, ch.dur * 0.9),
          string: pos.string,
          fret: pos.fret,
          midi: pos.midi,
          tech: '',
          tie: false,
          dead: false
        });
      }
    }

    if (skelNotes.length === 0) {
      for (const bar of song.bars) {
        const barNotes = song.notes.filter((n) => !n.dead && !n.tie && n.t >= bar.t - 0.01 && n.t < bar.t + bar.dur);
        if (barNotes.length > 0) {
          const lowest = barNotes.reduce((a, b) => (a.midi <= b.midi ? a : b));
          skelNotes.push({
            ...lowest,
            t: bar.t,
            dur: Math.max(0.25, bar.dur * 0.9),
            tech: '',
            tie: false,
            dead: false
          });
        }
      }
    }

    return makeSong({
      ...song,
      id: `${song.id}-level1`,
      title: `${song.title} (Level 1: Roots)`,
      notes: skelNotes
    });
  }

  if (level === 2) {
    const skelNotes = [];
    const events = buildEvents(song);
    for (const bar of song.bars) {
      const beatDur = (60 / (bar.bpm || song.bpm)) * (4 / (bar.den || 4));
      const beats = Math.max(1, Math.round(bar.dur / beatDur));
      for (let b = 0; b < beats; b++) {
        const bStart = bar.t + b * beatDur;
        const bEnd = bStart + beatDur;
        const inBeat = events.filter((ev) => ev.t >= bStart - 0.03 && ev.t < bEnd - 0.03);
        if (inBeat.length === 0) continue;
        const firstEv = inBeat[0];
        const sortedByPitch = [...firstEv.notes].sort((a, bNote) => a.midi - bNote.midi);
        const bass = sortedByPitch[0];
        skelNotes.push({
          ...bass,
          dur: Math.min(beatDur * 0.95, Math.max(bass.dur, beatDur * 0.5)),
          tech: ''
        });
        const fifth = sortedByPitch.find((n) => n !== bass && ((n.midi - bass.midi) % 12 === 7));
        if (fifth) {
          skelNotes.push({
            ...fifth,
            dur: Math.min(beatDur * 0.95, Math.max(fifth.dur, beatDur * 0.5)),
            tech: ''
          });
        }
      }
    }

    return makeSong({
      ...song,
      id: `${song.id}-level2`,
      title: `${song.title} (Level 2: Backbone)`,
      notes: skelNotes.length > 0 ? skelNotes : song.notes
    });
  }

  return makeSong({ ...song });
}
