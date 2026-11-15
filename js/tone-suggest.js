import { buildEvents } from './song.js';

/** Display names of Woodshed Amp's built-in presets (the amp's own list wins when it is connected). */
export const TONE_NAMES = {
  clean: 'Clean',
  jazz: 'Warm Jazz',
  breakup: 'Edge of Breakup',
  crunch: 'Crunch',
  rock_lead: 'Rock Lead',
  high_gain: 'High Gain',
  metal: 'Metal',
  fuzz: 'Fuzz',
  acoustic: 'Acoustic Sim',
  bass: 'Bass',
};

function classifyProgram(program) {
  if (!Number.isFinite(program)) return null;
  if (program === 24 || program === 25) return 'acoustic';
  if (program === 26) return 'jazz';
  if (program === 27 || program === 28) return 'clean';
  if (program === 29) return 'crunch';
  if (program === 30) return 'high_gain';
  if (program >= 32 && program <= 39) return 'bass';
  return null;
}

function classifyName(name) {
  const s = String(name || '').trim();
  if (!s) return { kind: null, metalKeyword: false };
  const metalKeyword = /\b(metal|djent)\b/i.test(s);
  if (/\bbass\b/i.test(s)) return { kind: 'bass', metalKeyword };
  if (/\bfuzz\b/i.test(s)) return { kind: 'fuzz', metalKeyword };
  if (metalKeyword) return { kind: 'metal', metalKeyword: true };
  if (/\b(dist|distortion)\b/i.test(s)) return { kind: 'high_gain', metalKeyword };
  if (/\b(crunch|drive|od|overdrive)\b/i.test(s)) return { kind: 'crunch', metalKeyword };
  if (/\bacoustic\b/i.test(s)) return { kind: 'acoustic', metalKeyword };
  if (/\bjazz\b/i.test(s)) return { kind: 'jazz', metalKeyword };
  if (/\bclean\b/i.test(s)) return { kind: 'clean', metalKeyword };
  return { kind: null, metalKeyword: false };
}

function isPowerChordEvent(ev) {
  if (ev.notes.length < 2 || ev.notes.length > 3) return false;
  const midis = ev.notes.map((n) => Math.round(n.midi));
  const distinct = new Set(midis);
  if (distinct.size < 2) return false;
  const root = Math.min(...midis);
  let hasFifth = false;
  for (const m of midis) {
    const interval = (((m - root) % 12) + 12) % 12;
    if (interval !== 0 && interval !== 7) return false;
    if (interval === 7) hasFifth = true;
  }
  return hasFifth;
}

function hasThirdInterval(ev) {
  if (ev.notes.length < 3) return false;
  const pcs = [...new Set(ev.notes.map((n) => ((Math.round(n.midi) % 12) + 12) % 12))];
  for (let i = 0; i < pcs.length; i++) {
    for (let j = i + 1; j < pcs.length; j++) {
      const diff = (((pcs[j] - pcs[i]) % 12) + 12) % 12;
      if (diff === 3 || diff === 4 || diff === 8 || diff === 9) {
        return true;
      }
    }
  }
  return false;
}

function isLeadSingleNote(n) {
  if ((Number(n.bend) || 0) > 0) return true;
  if ((Number(n.fret) || 0) >= 12) return true;
  const tech = String(n.tech || '').toLowerCase();
  return tech === 'bend' || tech === 'vib' || tech === 'vibrato' || tech === 'slide' || tech === 'sl';
}

export function suggestTone(song) {
  const safeSong = song || {};
  const tuning = Array.isArray(safeSong.tuning) && safeSong.tuning.length > 0
    ? safeSong.tuning
    : [40, 45, 50, 55, 59, 64];
  const lowestOpen = Math.min(...tuning);
  const low = lowestOpen <= 38;
  const bpm = Number.isFinite(safeSong.bpm) && safeSong.bpm > 0 ? safeSong.bpm : 120;

  const inst = safeSong.instrument || null;
  const progKind = inst ? classifyProgram(Number(inst.program)) : null;
  const { kind: nameKind, metalKeyword } = inst ? classifyName(inst.name) : { kind: null, metalKeyword: false };
  // The General MIDI program is chosen from a fixed list, so it is trusted over the free-text track name; the
  // name only refines it (a "Fuzz" track inside a drive program) or fills in when there is no program.
  let instKind = progKind || nameKind;
  if ((progKind === 'high_gain' || progKind === 'crunch') && nameKind === 'fuzz') instKind = 'fuzz';
  // "Lead" / "Solo" in the name says how the part is played, not which amp: it counts as lead phrasing.
  const nameSaysLead = inst ? /\b(lead|solo)\b/i.test(String(inst.name || '')) : false;

  const allNotes = Array.isArray(safeSong.notes) ? safeSong.notes.filter((n) => !n.dead && !n.tie) : [];
  const pmNotes = allNotes.filter((n) => {
    const tech = String(n.tech || '').toLowerCase();
    return tech === 'pm' || tech === 'palm' || tech === 'palm-mute' || Boolean(n.pm);
  }).length;
  const pmShare = allNotes.length > 0 ? pmNotes / allNotes.length : 0;

  const events = buildEvents(safeSong);
  const chordEvents = events.filter((ev) => ev.notes.length >= 2);
  const powerChords = chordEvents.filter(isPowerChordEvent).length;
  const powerShare = chordEvents.length > 0 ? powerChords / chordEvents.length : 0;

  const threePlusEvents = events.filter((ev) => ev.notes.length >= 3);
  const openChords = threePlusEvents.filter(hasThirdInterval).length;
  const openChordShare = threePlusEvents.length > 0 ? openChords / threePlusEvents.length : 0;

  const singleEvents = events.filter((ev) => ev.notes.length === 1);
  const leadSingles = singleEvents.filter((ev) => isLeadSingleNote(ev.notes[0])).length;
  const leadShare = singleEvents.length > 0 ? leadSingles / singleEvents.length : 0;

  const isBassTuning = tuning.length >= 4 && tuning.length <= 5 && lowestOpen <= 33;
  const isBass = isBassTuning || instKind === 'bass';

  const reasons = [];
  const tuningReason = () => {
    if (lowestOpen === 38 && tuning.length >= 2 && tuning[1] === 45) return 'drop-D tuning';
    return 'downtuned strings';
  };

  let id = 'breakup';
  let confidence = 0.45;

  // Rule 1: bass -> bass
  if (isBass) {
    id = 'bass';
    confidence = 0.78;
    if (instKind === 'bass' && isBassTuning) {
      confidence = 0.95;
      reasons.push('Track is a bass guitar', `${tuning.length}-string bass tuning`);
    } else if (instKind === 'bass') {
      reasons.push('Track is a bass guitar');
    } else {
      reasons.push(`${tuning.length}-string bass tuning`);
    }
    if (pmShare > 0.25) {
      confidence += 0.04;
      reasons.push(`palm mutes on ${Math.round(pmShare * 100)}% of notes`);
    }
  }
  // Rule 2: acoustic -> acoustic
  else if (instKind === 'acoustic') {
    id = 'acoustic';
    confidence = progKind === 'acoustic' && nameKind === 'acoustic' ? 0.86 : 0.76;
    reasons.push('Track is an acoustic guitar');
    if (openChordShare > 0.35) {
      confidence += 0.08;
      reasons.push(`${Math.round(openChordShare * 100)}% open/triad chords`);
    }
  }
  // Rule 3: jazz -> jazz
  else if (instKind === 'jazz') {
    id = 'jazz';
    confidence = progKind === 'jazz' && nameKind === 'jazz' ? 0.86 : 0.76;
    reasons.push('Track is a jazz guitar');
    if (openChordShare > 0.35) {
      confidence += 0.08;
      reasons.push(`${Math.round(openChordShare * 100)}% chord voicings with thirds`);
    }
  }
  // Rule 4: distortion program/name or metal keyword -> metal or high_gain
  else if (instKind === 'high_gain' || instKind === 'metal' || metalKeyword) {
    const isMetal = low || (pmShare > 0.25 && bpm > 120);
    id = isMetal ? 'metal' : 'high_gain';
    confidence = 0.74;
    reasons.push(metalKeyword ? 'Track is a metal guitar' : 'Track is a distortion guitar');
    if (low) {
      confidence += 0.08;
      reasons.push(tuningReason());
    }
    if (pmShare > 0.25) {
      confidence += 0.08;
      reasons.push(`palm mutes on ${Math.round(pmShare * 100)}% of notes`);
    }
    if (powerShare > 0.3) {
      confidence += 0.06;
      reasons.push(`${Math.round(powerShare * 100)}% of chords are power chords`);
    }
    if (isMetal && bpm > 120) {
      confidence += 0.05;
      reasons.push(`fast ${Math.round(bpm)} BPM tempo`);
    }
  }
  // Rule 5: fuzz -> fuzz
  else if (instKind === 'fuzz') {
    id = 'fuzz';
    confidence = 0.76;
    reasons.push('Track is a fuzz guitar');
    if (powerShare > 0.3) {
      confidence += 0.08;
      reasons.push(`${Math.round(powerShare * 100)}% of chords are power chords`);
    }
    if (leadShare > 0.35) {
      confidence += 0.07;
      reasons.push(`${Math.round(leadShare * 100)}% lead phrasing`);
    }
  }
  // Rule 6: overdriven/crunch -> rock_lead or crunch
  else if (instKind === 'crunch') {
    if (leadShare > 0.4 || nameSaysLead) {
      id = 'rock_lead';
      confidence = 0.76;
      reasons.push('Track is an overdriven guitar',
        leadShare > 0.4 ? `${Math.round(leadShare * 100)}% lead phrasing` : 'the track is named as a lead part');
    } else {
      id = 'crunch';
      confidence = 0.74;
      reasons.push('Track is an overdriven guitar');
      if (powerShare > 0.3) {
        confidence += 0.09;
        reasons.push(`${Math.round(powerShare * 100)}% of chords are power chords`);
      }
      if (pmShare > 0.2) {
        confidence += 0.06;
        reasons.push(`palm mutes on ${Math.round(pmShare * 100)}% of notes`);
      }
    }
  }
  // Rule 7: clean program/name -> breakup or clean
  else if (instKind === 'clean') {
    if (powerShare > 0.3) {
      id = 'breakup';
      confidence = 0.74;
      reasons.push('Track is a clean guitar', `${Math.round(powerShare * 100)}% of chords are power chords`);
    } else {
      id = 'clean';
      confidence = 0.76;
      reasons.push('Track is a clean guitar');
      if (openChordShare > 0.35) {
        confidence += 0.09;
        reasons.push(`${Math.round(openChordShare * 100)}% open/triad chords`);
      }
    }
  }
  // Rule 8: no instrument info
  else {
    if (pmShare > 0.25 && powerShare > 0.3) {
      id = low ? 'metal' : 'high_gain';
      confidence = 0.68;
      reasons.push(
        `palm mutes on ${Math.round(pmShare * 100)}% of notes`,
        `${Math.round(powerShare * 100)}% of chords are power chords`
      );
      if (low) {
        confidence += 0.12;
        reasons.push(tuningReason());
      }
      if (bpm > 120) {
        confidence += 0.06;
        reasons.push(`fast ${Math.round(bpm)} BPM tempo`);
      }
    } else if (powerShare > 0.3) {
      id = 'crunch';
      confidence = 0.62;
      reasons.push(`${Math.round(powerShare * 100)}% of chords are power chords`);
      if (pmShare > 0.15) {
        confidence += 0.08;
        reasons.push(`palm mutes on ${Math.round(pmShare * 100)}% of notes`);
      }
      if (low) {
        confidence += 0.06;
        reasons.push(tuningReason());
      }
    } else if (leadShare > 0.45) {
      id = 'rock_lead';
      confidence = 0.64;
      reasons.push(`${Math.round(leadShare * 100)}% lead phrasing`);
      if (bpm > 110) {
        confidence += 0.06;
        reasons.push(`energetic ${Math.round(bpm)} BPM tempo`);
      }
    } else if (openChordShare > 0.35 && powerShare < 0.1) {
      id = 'clean';
      confidence = 0.62;
      reasons.push(`${Math.round(openChordShare * 100)}% open/triad chords`);
    } else {
      id = 'breakup';
      confidence = 0.42;
      reasons.push('mixed chord and single-note phrasing');
    }
  }

  return {
    id,
    confidence: Math.max(0, Math.min(1, Math.round(confidence * 100) / 100)),
    reasons: reasons.slice(0, 3)
  };
}
