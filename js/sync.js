function getAnchors(sync) {
  if (!sync || !Array.isArray(sync.anchors)) return [];
  return [...sync.anchors].sort((a, b) => a.tab - b.tab);
}

export function tabToAudio(sync, t) {
  const anchors = getAnchors(sync);
  const n = anchors.length;
  if (n === 0) return t;
  if (n === 1) return t + (anchors[0].audio - anchors[0].tab);

  if (t <= anchors[0].tab) {
    const a0 = anchors[0];
    const a1 = anchors[1];
    const slope = (a1.audio - a0.audio) / (a1.tab - a0.tab);
    return a0.audio + (t - a0.tab) * slope;
  }

  if (t >= anchors[n - 1].tab) {
    const a0 = anchors[n - 2];
    const a1 = anchors[n - 1];
    const slope = (a1.audio - a0.audio) / (a1.tab - a0.tab);
    return a1.audio + (t - a1.tab) * slope;
  }

  for (let i = 0; i < n - 1; i++) {
    const a0 = anchors[i];
    const a1 = anchors[i + 1];
    if (t >= a0.tab && t <= a1.tab) {
      const ratio = (t - a0.tab) / (a1.tab - a0.tab);
      return a0.audio + ratio * (a1.audio - a0.audio);
    }
  }
  return t;
}

export function audioToTab(sync, t) {
  const anchors = getAnchors(sync);
  const n = anchors.length;
  if (n === 0) return t;
  if (n === 1) return t - (anchors[0].audio - anchors[0].tab);

  if (t <= anchors[0].audio) {
    const a0 = anchors[0];
    const a1 = anchors[1];
    const invSlope = (a1.tab - a0.tab) / (a1.audio - a0.audio);
    return a0.tab + (t - a0.audio) * invSlope;
  }

  if (t >= anchors[n - 1].audio) {
    const a0 = anchors[n - 2];
    const a1 = anchors[n - 1];
    const invSlope = (a1.tab - a0.tab) / (a1.audio - a0.audio);
    return a1.tab + (t - a1.audio) * invSlope;
  }

  for (let i = 0; i < n - 1; i++) {
    const a0 = anchors[i];
    const a1 = anchors[i + 1];
    if (t >= a0.audio && t <= a1.audio) {
      const ratio = (t - a0.audio) / (a1.audio - a0.audio);
      return a0.tab + ratio * (a1.tab - a0.tab);
    }
  }
  return t;
}

export function addAnchor(sync, tab, audio) {
  if (!Number.isFinite(tab) || !Number.isFinite(audio)) {
    return { ok: false, reason: 'Anchor times must be finite numbers.' };
  }
  const existing = getAnchors(sync);
  const candidate = [];
  let replaced = false;

  for (const a of existing) {
    if (Math.abs(a.tab - tab) < 0.05) {
      if (!replaced) {
        candidate.push({ tab, audio });
        replaced = true;
      }
    } else {
      candidate.push({ tab: a.tab, audio: a.audio });
    }
  }
  if (!replaced) {
    candidate.push({ tab, audio });
  }

  candidate.sort((a, b) => a.tab - b.tab);

  for (let i = 1; i < candidate.length; i++) {
    if (candidate[i].tab <= candidate[i - 1].tab) {
      return { ok: false, reason: 'Tab times must be strictly increasing.' };
    }
    if (candidate[i].audio <= candidate[i - 1].audio) {
      return {
        ok: false,
        reason: 'Audio times must be strictly monotonic with tab time.'
      };
    }
  }

  if (sync && typeof sync === 'object') {
    sync.anchors = candidate;
  }
  return { ok: true, sync: { anchors: candidate } };
}

export function removeAnchor(sync, indexOrTab) {
  const existing = getAnchors(sync);
  let next;
  if (Number.isInteger(indexOrTab) && indexOrTab >= 0 && indexOrTab < existing.length) {
    next = existing.filter((_, idx) => idx !== indexOrTab);
  } else {
    next = existing.filter((a) => Math.abs(a.tab - indexOrTab) >= 0.05);
  }
  if (sync && typeof sync === 'object') {
    sync.anchors = next;
  }
  return { anchors: next };
}

export function shiftAll(sync, deltaSec) {
  const d = Number(deltaSec) || 0;
  const existing = getAnchors(sync);
  const next = existing.length === 0
    ? [{ tab: 0, audio: d }]
    : existing.map((a) => ({ tab: a.tab, audio: a.audio + d }));
  if (sync && typeof sync === 'object') {
    sync.anchors = next;
  }
  return { anchors: next };
}

export function fromOffsetAndScale(offsetSec = 0, tempoScale = 1, songDuration = 60) {
  const dur = Math.max(1, Number(songDuration) || 60);
  const scale = Math.max(0.1, Number(tempoScale) || 1);
  const off = Number(offsetSec) || 0;
  return {
    anchors: [
      { tab: 0, audio: off },
      { tab: dur, audio: off + dur / scale }
    ]
  };
}
