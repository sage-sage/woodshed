// Sanity checks around auto-sync: refuse to sync a near-empty track, and reject a result whose sync points
// bunch up instead of spreading over the recording. Pure functions (tested in test/autosync-check.test.js).

/** A track with almost nothing to play for its length (vocals, a fill-in part) can't be matched to audio. */
export function isSparseTrack(noteCount, barCount) {
  const n = Number(noteCount) || 0;
  const bars = Number(barCount) || 0;
  return n < Math.max(24, bars * 0.5);
}

/** '' when the song is fine to auto-sync, else the reason to warn instead. */
export function sparseSongWarning(song) {
  const n = Array.isArray(song?.notes) ? song.notes.length : 0;
  const bars = Array.isArray(song?.bars) ? song.bars.length : 0;
  if (!isSparseTrack(n, bars)) return '';
  return `This track has only ${n} notes${bars ? ` in ${bars} bars` : ''}, probably not the guitar part, so auto-sync would guess. ` +
    'Import the guitar track instead, or sync by tapping bars.';
}

/**
 * Checks that auto-sync points describe a believable mapping: tab time and audio time move together at a
 * tempo near the tab's own, and (for a song about as long as the recording) they cover most of it.
 * Returns { ok, reason, slope, coverage }.
 */
export function checkAutoSyncSpread(anchors, { songDuration = 0, audioDuration = 0 } = {}) {
  const pts = (Array.isArray(anchors) ? anchors : [])
    .filter((a) => a && Number.isFinite(a.tab) && Number.isFinite(a.audio))
    .sort((a, b) => a.tab - b.tab);
  if (pts.length < 2) return { ok: false, reason: 'it found fewer than two sync points', slope: NaN, coverage: 0 };

  const tabSpan = pts[pts.length - 1].tab - pts[0].tab;
  const audioSpan = pts[pts.length - 1].audio - pts[0].audio;
  const slope = tabSpan > 0 ? audioSpan / tabSpan : NaN;
  const coverage = audioDuration > 0 ? Math.max(0, audioSpan) / audioDuration : 1;
  if (!(slope >= 0.6 && slope <= 1.6)) {
    return { ok: false, reason: `its sync points run at ${Number.isFinite(slope) ? slope.toFixed(2) : '?'}x the tab's tempo`, slope, coverage };
  }

  // Tab time spent in stretches whose local tempo is wildly off (squeezed into a few seconds, or stretched).
  let badTab = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].tab - pts[i - 1].tab;
    if (dt <= 0) continue;
    const local = (pts[i].audio - pts[i - 1].audio) / dt;
    if (!(local >= 0.4 && local <= 2.5)) badTab += dt;
  }
  if (tabSpan > 0 && badTab / tabSpan > 0.25) {
    return { ok: false, reason: 'its sync points bunch up instead of following the music', slope, coverage };
  }

  if (audioDuration > 0 && songDuration >= 0.5 * audioDuration && coverage < 0.35) {
    return { ok: false, reason: `its sync points cover only ${Math.round(coverage * 100)}% of the recording`, slope, coverage };
  }
  return { ok: true, reason: '', slope, coverage };
}

/** Time (s) of the first clearly audible sound: the first 50 ms window louder than 10% of the loudest one. */
export function firstSoundTime(samples, sampleRate) {
  const sr = Number(sampleRate) || 0;
  if (!samples || !samples.length || sr <= 0) return 0;
  const win = Math.max(1, Math.round(sr * 0.05));
  const rms = [];
  let peak = 0;
  for (let start = 0; start < samples.length; start += win) {
    const end = Math.min(samples.length, start + win);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    const v = Math.sqrt(sum / (end - start));
    rms.push(v);
    if (v > peak) peak = v;
  }
  if (peak <= 0) return 0;
  const idx = rms.findIndex((v) => v >= 0.1 * peak);
  return idx < 0 ? 0 : (idx * win) / sr;
}
