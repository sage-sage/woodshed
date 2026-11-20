import { makeSong, bendFromPoints } from './song.js';

const MAX_EXPANDED_MEASURES = 2000;

function gmProgramFromInstrumentId(instrumentId) {
  if (typeof instrumentId !== 'number' || !Number.isFinite(instrumentId)) {
    return -1;
  }
  return Math.max(0, Math.min(127, Math.round(instrumentId)));
}

function harmonicMidiOffset(fret) {
  if (fret === 12) return 12;
  if (fret === 7) return 19;
  if (fret === 5) return 24;
  return fret;
}

function isNaturalHarmonic(harmonic) {
  return harmonic === true || harmonic === 'natural' || harmonic === 1;
}

function resolveTechnique(note, beat) {
  if (note.dead) return 'x';
  if (note.vibrato || note.leftHandVibrato || (beat && beat.vibrato)) return 'vib';
  return '';
}

/*
 * Songsterr note fields (checked on a real part JSON, Comfortably Numb lead):
 *   hp: true            hammer-on/pull-off FROM this note to the next one on the string
 *   slide: 'legato' | 'shift'      slide FROM this note to the next one
 *          'below' | 'above'       slide INTO this note from below/above
 *          'downwards' | 'upwards' slide OFF this note to nowhere
 *   bend: { tone, points: [{ position 0..60, tone }] }  tone 100 = whole step (2 semitones)
 *   leftHandVibrato: 'slight' | ..., ghost, staccato, harmonic: 'natural' | 'pinch' | ...
 * Woodshed puts h/p/slide on the DESTINATION note (see techniqueFields in song.js).
 */
function slideKind(slide) {
  if (!slide) return '';
  const s = String(slide).toLowerCase();
  if (s === 'legato' || s === 'shift' || s === 'true') return 'link';
  if (/below/.test(s)) return 'inBelow';
  if (/above/.test(s)) return 'inAbove';
  if (/down/.test(s)) return 'outDown';
  if (/up/.test(s)) return 'outUp';
  return 'link';
}

function songsterrBend(bend) {
  if (!bend || typeof bend !== 'object') return {};
  const pts = Array.isArray(bend.points) && bend.points.length
    ? bend.points.map((p) => ({ pos: (Number(p.position) || 0) / 60, semis: (Number(p.tone) || 0) / 50 }))
    : (Number(bend.tone) > 0 ? [{ pos: 0, semis: 0 }, { pos: 1, semis: Number(bend.tone) / 50 }] : []);
  return bendFromPoints(pts);
}

function beatBaseWhole(beat) {
  if (!beat || !Array.isArray(beat.duration) || beat.duration.length < 2) return 0;
  const num = Number(beat.duration[0]);
  const den = Number(beat.duration[1]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return 0;
  return num / den;
}

function tupletRatio(tuplet) {
  if (!Number.isInteger(tuplet) || tuplet < 2) return 1;
  const p = 1 << Math.floor(Math.log2(tuplet - 1));
  return p / tuplet;
}

function computeVoiceBeatDurations(beats, measureWhole) {
  const raw = beats.map((b) => (b && !b.graceNote ? beatBaseWhole(b) : 0));
  const hasTuplet = beats.some((b) => b && !b.graceNote && Number.isInteger(b.tuplet) && b.tuplet >= 2);
  if (!hasTuplet) return raw;

  // Songsterr's durations already include the tuplet (an eighth-note triplet is [1,12]; verified on a real
  // song: every measure adds up with the raw values). Only if the raw values do NOT fill the measure and
  // the tuplet-scaled ones do, assume an older file with nominal durations.
  const rawSum = raw.reduce((sum, w) => sum + w, 0);
  if (Math.abs(rawSum - measureWhole) < 1e-6) return raw;
  const adjusted = beats.map((b, idx) => {
    if (!b || b.graceNote) return 0;
    return raw[idx] * tupletRatio(b.tuplet);
  });
  const adjustedSum = adjusted.reduce((sum, w) => sum + w, 0);
  if (Math.abs(adjustedSum - measureWhole) < 1e-6) {
    return adjusted;
  }
  return raw;
}

function hasUpcomingRepeatClose(measures, fromIdx) {
  for (let k = fromIdx; k < measures.length; k++) {
    if (k > fromIdx && measures[k] && measures[k].repeatStart) return false;
    const rc = measures[k] && measures[k].repeatClose;
    if (rc === true || (typeof rc === 'number' && Number.isFinite(rc) && rc >= 2)) {
      return true;
    }
  }
  return false;
}

function expandMeasures(measures) {
  const expanded = [];
  let lastRepeatStart = 0;
  let activeCloseIdx = -1;
  let pass = 1;
  let i = 0;

  while (i < measures.length && expanded.length < MAX_EXPANDED_MEASURES) {
    const m = measures[i] || {};
    if (m.repeatStart && activeCloseIdx === -1) {
      lastRepeatStart = i;
    }

    const alt = Array.isArray(m.alternateEnding)
      ? m.alternateEnding.filter((n) => Number.isInteger(n) && n >= 1)
      : [];

    if (alt.length > 0) {
      const matched = activeCloseIdx !== -1 || hasUpcomingRepeatClose(measures, i);
      if (matched && !alt.includes(pass)) {
        const rc = m.repeatClose;
        const totalPlays = typeof rc === 'number' && Number.isFinite(rc)
          ? Math.floor(rc)
          : (rc === true ? 2 : 0);
        if (!(pass === 1 && totalPlays >= 2 && !alt.includes(1))) {
          i += 1;
          continue;
        }
      }
    } else if (activeCloseIdx !== -1 && i > activeCloseIdx) {
      activeCloseIdx = -1;
      pass = 1;
    }

    expanded.push(i);

    const rc = m.repeatClose;
    const totalPlays = typeof rc === 'number' && Number.isFinite(rc)
      ? Math.floor(rc)
      : (rc === true ? 2 : 0);

    if (totalPlays >= 2) {
      if (activeCloseIdx !== i) {
        activeCloseIdx = i;
        pass = 1;
      }
      if (pass < totalPlays) {
        pass += 1;
        i = lastRepeatStart;
        continue;
      }
      activeCloseIdx = -1;
      pass = 1;
    }

    i += 1;
  }

  return expanded;
}

function tempoEventBpm(ev) {
  const raw = Number(ev.bpm);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const t = ev.type;
  if (t === 1 || t === 2 || t === 4 || t === 8 || t === 16) {
    return raw * (4 / t);
  }
  return raw;
}

function buildTempoMap(notation) {
  const rawList = Array.isArray(notation?.automations?.tempo) ? notation.automations.tempo : [];
  const events = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const bpm = tempoEventBpm(item);
    if (bpm === null) continue;
    events.push({
      measure: Number.isInteger(item.measure) ? item.measure : 0,
      position: Number.isFinite(item.position) ? Math.max(0, item.position) : 0,
      bpm
    });
  }
  events.sort((a, b) => (a.measure - b.measure) || (a.position - b.position));

  const byMeasure = new Map();
  for (const ev of events) {
    if (!byMeasure.has(ev.measure)) byMeasure.set(ev.measure, []);
    byMeasure.get(ev.measure).push(ev);
  }
  return { events, byMeasure };
}

function measureOffsetToSeconds(wOffset, barStartSec, barStartBpm, midEvents) {
  let sec = barStartSec;
  let pos = 0;
  let bpm = barStartBpm;
  for (const ev of midEvents) {
    if (ev.position <= pos) {
      bpm = ev.bpm;
      continue;
    }
    if (ev.position >= wOffset) break;
    sec += ((ev.position - pos) * 4 * 60) / bpm;
    pos = ev.position;
    bpm = ev.bpm;
  }
  sec += ((wOffset - pos) * 4 * 60) / bpm;
  return sec;
}

export function describeSongsterr(notation) {
  const rawTuning = Array.isArray(notation?.tuning) ? notation.tuning : [];
  const tuning = [...rawTuning].reverse();
  const strings = Number.isInteger(notation?.strings) ? notation.strings : tuning.length;
  let noteCount = 0;
  if (Array.isArray(notation?.measures)) {
    for (const m of notation.measures) {
      if (!m || !Array.isArray(m.voices)) continue;
      for (const v of m.voices) {
        if (!v || !Array.isArray(v.beats)) continue;
        for (const b of v.beats) {
          if (!b || b.graceNote || b.rest || !Array.isArray(b.notes)) continue;
          for (const n of b.notes) {
            if (n && !n.rest) noteCount += 1;
          }
        }
      }
    }
  }
  return {
    tracks: [
      {
        index: 0,
        name: (notation && notation.name) || 'Track 1',
        strings,
        tuning,
        isPercussion: false,
        noteCount
      }
    ]
  };
}

export function songsterrToSong(notation, meta = {}) {
  if (!notation || typeof notation !== 'object') {
    throw new Error('Invalid Songsterr notation data.');
  }
  const rawTuning = Array.isArray(notation.tuning) ? notation.tuning : [];
  const strings = Number.isInteger(notation.strings) ? notation.strings : rawTuning.length;
  if (strings < 4 || strings > 8 || rawTuning.length !== strings || rawTuning.some((v) => !Number.isFinite(v))) {
    throw new Error(`Unsupported string count (${strings || rawTuning.length}). Woodshed supports 4 to 8 strings.`);
  }

  const tuning = [...rawTuning].reverse();
  const measures = Array.isArray(notation.measures) ? notation.measures : [];
  const playedIndices = expandMeasures(measures);
  const { events: tempoEvents, byMeasure: tempoByMeasure } = buildTempoMap(notation);

  let currentBpm = 120;
  const firstTempo = tempoEvents.length > 0 ? tempoEvents[0].bpm : 120;
  let curNum = 4;
  let curDen = 4;
  let barStartSec = 0;

  const notes = [];
  const bars = [];
  const lastNoteByVoiceAndString = new Map();
  const lastNoteByString = new Map();
  const pendingLink = new Map(); // voice:string -> { kind: 'hp' | 'slide', fret } from an h/p or slide origin

  for (const origIdx of playedIndices) {
    const m = measures[origIdx] || {};
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
    const mTempos = tempoByMeasure.get(origIdx) || [];
    for (const ev of mTempos) {
      if (ev.position <= 0) currentBpm = ev.bpm;
    }
    const barStartBpm = currentBpm;
    const midEvents = mTempos.filter((ev) => ev.position > 0 && ev.position < measureWhole);

    const barEndSec = measureOffsetToSeconds(measureWhole, barStartSec, barStartBpm, midEvents);
    const barDur = barEndSec - barStartSec;
    const markerText = m.marker && typeof m.marker === 'object'
      ? (m.marker.text || '')
      : (typeof m.marker === 'string' ? m.marker : '');

    bars.push({
      t: barStartSec,
      dur: barDur,
      num: curNum,
      den: curDen,
      bpm: barStartBpm,
      ...(markerText ? { label: String(markerText) } : {})
    });

    const voices = Array.isArray(m.voices) ? m.voices : [];
    for (let vIdx = 0; vIdx < voices.length; vIdx++) {
      const voice = voices[vIdx];
      if (!voice || !Array.isArray(voice.beats)) continue;
      const beatDurs = computeVoiceBeatDurations(voice.beats, measureWhole);
      let cursorW = 0;

      for (let bIdx = 0; bIdx < voice.beats.length; bIdx++) {
        const beat = voice.beats[bIdx];
        if (!beat || beat.graceNote) continue;
        const beatW = beatDurs[bIdx];
        const beatStartW = cursorW;
        const beatEndW = cursorW + beatW;
        cursorW = beatEndW;

        if (beat.rest || !Array.isArray(beat.notes) || beat.notes.length === 0) continue;

        const t = measureOffsetToSeconds(beatStartW, barStartSec, barStartBpm, midEvents);
        const end = measureOffsetToSeconds(beatEndW, barStartSec, barStartBpm, midEvents);
        const dur = Math.max(0.02, end - t);

        for (const rawNote of beat.notes) {
          if (!rawNote || rawNote.rest) continue;
          if (!Number.isInteger(rawNote.string) || rawNote.string < 0 || rawNote.string >= strings) continue;
          const string = strings - 1 - rawNote.string;
          const fret = Number.isFinite(rawNote.fret) ? Math.max(0, Math.round(rawNote.fret)) : 0;
          const effectiveFret = isNaturalHarmonic(rawNote.harmonic) ? harmonicMidiOffset(fret) : fret;
          const midi = tuning[string] + effectiveFret;
          const tie = Boolean(rawNote.tie);
          const dead = Boolean(rawNote.dead);
          const tech = resolveTechnique(rawNote, beat);

          const vsKey = `${vIdx}:${string}`;
          const bendInfo = songsterrBend(rawNote.bend);
          const slide = slideKind(rawNote.slide);
          if (tie) {
            const prev = lastNoteByVoiceAndString.get(vsKey) || lastNoteByString.get(string);
            if (prev) {
              prev.dur = Math.max(prev.dur, end - prev.t);
              // a bend that starts or comes back down on the tied-over part belongs to the struck note
              if (bendInfo.bend && !prev.bend) { const { prebend: _pb, ...rest } = bendInfo; Object.assign(prev, rest); if (!prev.tech) prev.tech = 'bend'; }
              if (bendInfo.release && prev.bend) prev.release = true;
              if (slide === 'outDown' || slide === 'outUp') prev.slideOut = slide === 'outDown' ? 'down' : 'up';
            }
          }

          let linkedTech = '';
          const link = pendingLink.get(vsKey);
          if (link && !tie) {
            pendingLink.delete(vsKey);
            if (link.kind === 'slide' && fret !== link.fret) linkedTech = 'slide';
            else if (link.kind === 'hp' && fret > link.fret) linkedTech = 'h';
            else if (link.kind === 'hp' && fret < link.fret) linkedTech = 'p';
          }
          if (rawNote.hp) pendingLink.set(vsKey, { kind: 'hp', fret });
          else if (slide === 'link') pendingLink.set(vsKey, { kind: 'slide', fret });

          const noteObj = {
            t,
            dur,
            string,
            fret,
            midi,
            tech: linkedTech || (bendInfo.bend && !tie ? 'bend' : '') || tech,
            tie,
            dead,
            ...(tie ? {} : bendInfo),
            ...(slide === 'inBelow' ? { slideIn: 'below' } : slide === 'inAbove' ? { slideIn: 'above' } : {}),
            ...(slide === 'outDown' ? { slideOut: 'down' } : slide === 'outUp' ? { slideOut: 'up' } : {}),
            ...(tech === 'vib' && (linkedTech || (bendInfo.bend && !tie)) ? { vibrato: true } : {})
          };
          for (const k of Object.keys(noteObj)) if (noteObj[k] === undefined) delete noteObj[k];
          notes.push(noteObj);

          if (!tie) {
            lastNoteByVoiceAndString.set(vsKey, noteObj);
            lastNoteByString.set(string, noteObj);
          } else if (!lastNoteByVoiceAndString.has(vsKey)) {
            lastNoteByVoiceAndString.set(vsKey, noteObj);
            lastNoteByString.set(string, noteObj);
          }
        }
      }
    }

    for (const ev of mTempos) {
      if (ev.position <= measureWhole) currentBpm = ev.bpm;
    }
    barStartSec = barEndSec;
  }

  if (!notes.some((n) => !n.dead && !n.tie)) {
    throw new Error(`"${meta.title || notation.name || 'This track'}" has no playable notes.`);
  }

  return makeSong({
    title: meta.title || notation.name || 'Untitled',
    artist: meta.artist || '',
    tuning,
    capo: 0,
    bpm: bars[0]?.bpm || firstTempo || 120,
    notes,
    bars,
    duration: barStartSec,
    source: 'songsterr',
    exactRhythm: true,
    instrument: {
      program: gmProgramFromInstrumentId(notation.instrumentId),
      name: notation.name || ''
    }
  });
}

export function songsterrVideoAnchors(song, points) {
  if (!song || typeof song !== 'object') return [];
  const bars = song.bars;
  if (!Array.isArray(bars) || bars.length === 0) return [];
  if (!Array.isArray(points) || points.length === 0) return [];

  const duration = song.duration;
  const raw = [];
  const count = Math.min(bars.length, points.length);
  for (let i = 0; i < count; i++) {
    const tab = bars[i]?.t;
    const audio = points[i];
    if (typeof tab === 'number' && Number.isFinite(tab) && typeof audio === 'number' && Number.isFinite(audio)) {
      raw.push({ tab, audio });
    }
  }

  if (points.length > bars.length && typeof duration === 'number' && Number.isFinite(duration)) {
    const endAudio = points[bars.length];
    if (typeof endAudio === 'number' && Number.isFinite(endAudio)) {
      raw.push({ tab: duration, audio: endAudio });
    }
  }

  const anchors = [];
  for (const anchor of raw) {
    if (anchors.length === 0 || anchor.audio > anchors[anchors.length - 1].audio) {
      anchors.push(anchor);
    }
  }

  return anchors.length >= 2 ? anchors : [];
}
