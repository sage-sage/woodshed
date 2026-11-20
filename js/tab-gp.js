/**
 * Guitar Pro (.gp3/.gp4/.gp5/.gpx/.gp) and MusicXML import.
 *
 * The files are parsed by alphaTab (vendored, MPL-2.0, https://alphatab.net); nothing is rendered with it.
 * alphaTab's MIDI generator is run once to get the bars in PLAYBACK order (repeats, alternate endings and
 * tempo changes unrolled), and every note is then placed on that timeline in seconds.
 */
import { makeSong, bendFromPoints } from './song.js';

export const TAB_FILE_EXTENSIONS = ['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.musicxml', '.xml', '.mxl'];

const TICKS_PER_QUARTER = 960;
let alphaTabPromise = null;

export function loadAlphaTab() {
  if (globalThis.alphaTab) return Promise.resolve(globalThis.alphaTab);
  if (!alphaTabPromise) {
    if (typeof document === 'undefined') {
      alphaTabPromise = import('node:module').then((m) =>
        m.createRequire(import.meta.url)('../vendor/alphaTab.min.js'));
    } else {
      alphaTabPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = new URL('../vendor/alphaTab.min.js', import.meta.url).href;
        s.onload = () => (globalThis.alphaTab
          ? resolve(globalThis.alphaTab)
          : reject(new Error('The tab file reader loaded but did not start.')));
        s.onerror = () => reject(new Error('Could not load the tab file reader (vendor/alphaTab.min.js).'));
        document.head.appendChild(s);
      });
    }
    alphaTabPromise.catch(() => { alphaTabPromise = null; });
  }
  return alphaTabPromise;
}

function staffOf(track) {
  return track.staves.find((s) => !s.isPercussion && s.tuning && s.tuning.length >= 4) || track.staves[0];
}

function countNotes(staff) {
  let n = 0;
  for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) n += beat.notes.length;
  return n;
}

function describeTracks(score) {
  return score.tracks.map((track, index) => {
    const staff = staffOf(track);
    const tuning = staff && staff.tuning ? [...staff.tuning].reverse() : [];
    return {
      index,
      name: track.name || `Track ${index + 1}`,
      strings: tuning.length,
      tuning,
      isPercussion: Boolean(staff && staff.isPercussion),
      noteCount: staff ? countNotes(staff) : 0,
    };
  });
}

/** Seconds from the start of a playback bar to `tick`, honouring tempo changes inside the bar. */
function secondsInto(tick, barStartTick, startTempo, changes) {
  let sec = 0;
  let at = barStartTick;
  let tempo = startTempo;
  for (const c of changes) {
    if (c.tick <= barStartTick) { tempo = c.tempo; continue; }
    if (c.tick >= tick) break;
    sec += ((c.tick - at) * 60) / (tempo * TICKS_PER_QUARTER);
    at = c.tick;
    tempo = c.tempo;
  }
  return sec + ((tick - at) * 60) / (tempo * TICKS_PER_QUARTER);
}

function technique(at, note) {
  const origin = note.hammerPullOrigin;
  if (origin) return note.realValue >= origin.realValue ? 'h' : 'p';
  const slid = note.slideOrigin;
  const S = at.model.SlideOutType;
  if (slid && (slid.slideOutType === S.Legato || slid.slideOutType === S.Shift)) return 'slide';
  if (note.hasBend) return 'bend';
  if (note.isHarmonic) return 'harm';
  if (note.vibrato) return 'vib';
  if (note.isPalmMute) return 'pm';
  return '';
}

/** Bend, slide-in/out and vibrato facts (see techniqueFields in song.js). */
function techniqueExtras(at, note, tech) {
  const out = {};
  if (note.hasBend && Array.isArray(note.bendPoints) && note.bendPoints.length) {
    // alphaTab: offset 0..60 across the note, value in quarter tones
    Object.assign(out, bendFromPoints(note.bendPoints.map((p) => ({ pos: (Number(p.offset) || 0) / 60, semis: (Number(p.value) || 0) / 2 }))));
    const B = at.model.BendType;
    if (note.bendType === B.Prebend || note.bendType === B.PrebendBend || note.bendType === B.PrebendRelease) out.prebend = true;
    if (note.bendType === B.Release || note.bendType === B.BendRelease || note.bendType === B.PrebendRelease) {
      if (out.bend) out.release = true;
    }
  }
  const SI = at.model.SlideInType;
  if (note.slideInType === SI.IntoFromBelow) out.slideIn = 'below';
  else if (note.slideInType === SI.IntoFromAbove) out.slideIn = 'above';
  const SO = at.model.SlideOutType;
  if (note.slideOutType === SO.OutUp || note.slideOutType === SO.PickSlideUp) out.slideOut = 'up';
  else if (note.slideOutType === SO.OutDown || note.slideOutType === SO.PickSlideDown) out.slideOut = 'down';
  if (note.vibrato && tech !== 'vib') out.vibrato = true;
  return out;
}

export function scoreToSong(at, score, trackIndex = 0) {
  const track = score.tracks[trackIndex];
  if (!track) throw new Error('That track does not exist in this file.');
  const staff = staffOf(track);
  if (!staff || staff.isPercussion) throw new Error(`"${track.name}" is a drum track. Pick a guitar or bass track.`);
  if (!staff.tuning || staff.tuning.length < 4 || staff.tuning.length > 8) {
    throw new Error(`"${track.name}" has no string tuning, so it cannot be shown as tab. Pick a guitar or bass track.`);
  }
  const tuning = [...staff.tuning].reverse(); // alphaTab lists the highest string first
  const strings = tuning.length;
  const capo = staff.capo || 0;

  const generator = new at.midi.MidiFileGenerator(score, new at.Settings(),
    new at.midi.AlphaSynthMidiFileHandler(new at.midi.MidiFile()));
  generator.generate();
  const lookup = generator.tickLookup.masterBars;

  const notes = [];
  const bars = [];
  let barSec = 0;
  let tempo = score.tempo || 120;
  for (const mbl of lookup) {
    const changes = [...(mbl.tempoChanges || [])].sort((a, b) => a.tick - b.tick);
    for (const c of changes) if (c.tick <= mbl.start) tempo = c.tempo;
    const startTempo = tempo;
    const toSec = (tick) => barSec + secondsInto(tick, mbl.start, startTempo, changes);
    const mb = mbl.masterBar;
    const barDur = secondsInto(mbl.end, mbl.start, startTempo, changes);
    bars.push({
      t: barSec, dur: barDur, num: mb.timeSignatureNumerator, den: mb.timeSignatureDenominator, bpm: startTempo,
      ...(mb.section && mb.section.text ? { label: mb.section.text } : {}),
    });

    const bar = staff.bars[mb.index];
    if (bar) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          if (beat.isRest || !beat.notes.length) continue;
          if (beat.graceType !== at.model.GraceType.None) continue; // ornaments are not scored
          const t = toSec(mbl.start + beat.playbackStart);
          const end = toSec(mbl.start + beat.playbackStart + beat.playbackDuration);
          for (const note of beat.notes) {
            const string = note.string - 1; // alphaTab: 1 = lowest string
            if (string < 0 || string >= strings) continue;
            const tech = technique(at, note);
            const extras = techniqueExtras(at, note, tech);
            notes.push({
              t,
              dur: Math.max(0.03, end - t),
              string,
              fret: note.fret,
              midi: tuning[string] + capo + note.fret + (note.isHarmonic ? harmonicOffset(note) : 0),
              tech,
              tie: Boolean(note.isTieDestination),
              dead: Boolean(note.isDead),
              ...extras,
            });
          }
        }
      }
    }
    for (const c of changes) tempo = c.tempo;
    barSec += barDur;
  }

  if (!notes.some((n) => !n.dead && !n.tie)) throw new Error(`"${track.name}" has no notes to play.`);
  return makeSong({
    title: score.title || track.name || 'Untitled',
    artist: score.artist || '',
    tuning, capo, bpm: score.tempo || 120, notes, bars, duration: barSec, source: 'gp', exactRhythm: true,
    // General MIDI program and track name: used to suggest an amp tone (js/tone-suggest.js)
    instrument: {
      program: track.playbackInfo && Number.isFinite(track.playbackInfo.program) ? track.playbackInfo.program : -1,
      name: track.name || '',
    },
  });
}

/**
 * Semitones a natural harmonic sounds above the fretted note at the same fret. Touching fret 7 gives an
 * octave plus a fifth above the open string (open + 19), which is 12 above the fretted fret 7.
 */
function harmonicOffset(note) {
  const table = { 12: 0, 7: 12, 19: 0, 5: 19, 24: 0, 4: 24, 9: 19, 16: 12, 3: 28 };
  if (note.harmonicType !== 1) return 0; // only natural harmonics are mapped; others are judged as fretted
  return table[note.fret] !== undefined ? table[note.fret] : 0;
}

/**
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<{title:string, artist:string, tracks:object[], toSong:(trackIndex:number)=>object}>}
 */
export async function loadTabFile(data) {
  const at = await loadAlphaTab();
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let score;
  try {
    score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, new at.Settings());
  } catch (e) {
    throw new Error('This file could not be read as Guitar Pro or MusicXML. Supported: '
      + TAB_FILE_EXTENSIONS.join(' ') + '. For plain-text tabs, paste the text instead.');
  }
  return {
    title: score.title || '',
    artist: score.artist || '',
    tracks: describeTracks(score),
    toSong: (trackIndex) => scoreToSong(at, score, trackIndex),
  };
}
