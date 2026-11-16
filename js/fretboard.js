import { midiToName } from './song.js';

export const STRING_COLORS = [
  '#e5483e',
  '#f0962e',
  '#e2c94a',
  '#4fb36b',
  '#3fa3d6',
  '#9b7be0',
  '#e46fae',
  '#8f9bf0'
];

const NS = 'http://www.w3.org/2000/svg';
let fretboardInstanceSeq = 0;

// Colours come from the element the diagram is drawn in, so a dark "screen" panel keeps its own palette
// in light mode (css/theme.css scopes dark tokens to those panels).
function readTheme(el) {
  const readVar = (name, fallback) => {
    if (typeof document === 'undefined' || !document.documentElement) return fallback;
    const target = el && el.isConnected ? el : document.documentElement;
    const val = getComputedStyle(target).getPropertyValue(name).trim();
    return val || fallback;
  };

  return {
    dotFill: readVar('--fg', '#ece7df'),
    dotText: readVar('--bg', '#1c1916'),
    targetFill: readVar('--accent', '#d6a26c'),
    targetText: readVar('--accent-ink', '#1c1916'),
    stringLabel: readVar('--fg-faint', '#6f675d'),
    stringWound: readVar('--bronze', '#b08d57'),
    stringPlain: '#cfcac2',
    board: readVar('--rosewood', '#2e1f17'),
    fret: readVar('--nickel', '#b9b2a7'),
    fretCrownShadow: readVar('--fg-faint', '#6f675d'),
    nut: '#e9e1cf',
    inlay: readVar('--pearl', '#e9e3d6'),
    jewel: readVar('--bad', '#e6a092'),
    filament: readVar('--accent', '#d6a26c'),
    ink: readVar('--fg', '#ece7df'),
    inkMuted: readVar('--fg-muted', '#a8a097'),
    panelEdge: readVar('--line', '#3a342e'),
    cream: readVar('--fg', '#ece7df'),
    monoFont: readVar('--font-mono', '"JetBrains Mono", ui-monospace, monospace'),
    displayFont: readVar('--font-display', '"Space Grotesk", system-ui, sans-serif')
  };
}

function svgEl(tag, attrs = {}, text = '') {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) {
      el.setAttribute(k, String(v));
    }
  }
  if (text) el.textContent = text;
  return el;
}

export function renderFretboard(el, {
  tuning = [40, 45, 50, 55, 59, 64],
  capo = 0,
  frets = 15,
  marks = [],
  leftHanded = false
} = {}) {
  if (!el) return;
  el.innerHTML = '';

  const theme = readTheme(el);
  const numStrings = tuning.length;
  const maxFrets = Math.max(5, frets);
  const padL = 46;
  const padR = 24;
  const padT = 22;
  const padB = 26;
  const stringGap = 22;
  const fretWidth = 46;

  const boardW = maxFrets * fretWidth;
  const boardH = (numStrings - 1) * stringGap;
  const width = padL + boardW + padR;
  const height = padT + boardH + padB;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': 'Guitar Fretboard'
  });

  const uid = ++fretboardInstanceSeq;
  const grainFilterId = `ws-rosewood-grain-${uid}`;
  const pearlGradId = `ws-pearl-inlay-${uid}`;
  const defs = svgEl('defs');

  const grainFilter = svgEl('filter', {
    id: grainFilterId,
    x: '0%',
    y: '0%',
    width: '100%',
    height: '100%'
  });
  grainFilter.appendChild(svgEl('feTurbulence', {
    type: 'fractalNoise',
    baseFrequency: '0.006 0.18',
    numOctaves: '3',
    seed: '7'
  }));
  grainFilter.appendChild(svgEl('feColorMatrix', {
    type: 'matrix',
    values: '0 0 0 0 0.12 0 0 0 0 0.07 0 0 0 0 0.04 0 0 0 1 0'
  }));
  defs.appendChild(grainFilter);

  const pearlGrad = svgEl('radialGradient', {
    id: pearlGradId,
    cx: '40%',
    cy: '38%',
    r: '60%'
  });
  pearlGrad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#f4efe6' }));
  pearlGrad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#bdb5a8' }));
  defs.appendChild(pearlGrad);

  svg.appendChild(defs);

  const xForFretSpace = (f) => {
    if (f <= 0) {
      return leftHanded ? (padL + boardW + 14) : (padL - 14);
    }
    const rel = (f - 0.5) * fretWidth;
    return leftHanded ? (padL + boardW - rel) : (padL + rel);
  };

  const xForFretWire = (f) => {
    const rel = f * fretWidth;
    return leftHanded ? (padL + boardW - rel) : (padL + rel);
  };

  // String index 0 = lowest pitch = drawn at the bottom (highest y)
  const yForString = (s) => padT + (numStrings - 1 - s) * stringGap;

  // Rosewood fretboard background + subtle grain overlay
  svg.appendChild(svgEl('rect', {
    x: padL,
    y: padT - 6,
    width: boardW,
    height: boardH + 12,
    rx: 4,
    fill: theme.board,
    stroke: theme.panelEdge,
    'stroke-width': 1
  }));
  svg.appendChild(svgEl('rect', {
    x: padL,
    y: padT - 6,
    width: boardW,
    height: boardH + 12,
    rx: 4,
    filter: `url(#${grainFilterId})`,
    opacity: 0.16,
    'pointer-events': 'none'
  }));

  // Pearl inlay dots at 3, 5, 7, 9, 15 (+ higher) and double at 12
  const singleDots = [3, 5, 7, 9, 15, 17, 19, 21];
  const midY = padT + boardH / 2;
  const pearlFill = `url(#${pearlGradId})`;
  // A full scale map covers the inlays; dim them there so they don't peek out from behind the note dots.
  const inlayOpacity = marks.length > 12 ? 0.3 : 0.75;
  for (const df of singleDots) {
    if (df <= maxFrets) {
      svg.appendChild(svgEl('circle', {
        cx: xForFretSpace(df),
        cy: midY,
        r: 4.5,
        fill: pearlFill,
        'fill-opacity': inlayOpacity
      }));
    }
  }
  if (maxFrets >= 12) {
    svg.appendChild(svgEl('circle', {
      cx: xForFretSpace(12),
      cy: padT + boardH * 0.27,
      r: 4.5,
      fill: pearlFill,
      'fill-opacity': inlayOpacity
    }));
    svg.appendChild(svgEl('circle', {
      cx: xForFretSpace(12),
      cy: padT + boardH * 0.73,
      r: 4.5,
      fill: pearlFill,
      'fill-opacity': inlayOpacity
    }));
  }

  // Crowned nickel frets, bone nut, and fret numbers below
  for (let f = 0; f <= maxFrets; f++) {
    const x = xForFretWire(f);
    const isNut = f === 0;
    if (isNut) {
      svg.appendChild(svgEl('line', {
        x1: x,
        y1: padT - 5,
        x2: x,
        y2: padT + boardH + 5,
        stroke: theme.nut,
        'stroke-width': 4
      }));
    } else {
      const crownOffset = leftHanded ? -1.25 : 1.25;
      svg.appendChild(svgEl('line', {
        x1: x + crownOffset,
        y1: padT - 5,
        x2: x + crownOffset,
        y2: padT + boardH + 5,
        stroke: theme.fretCrownShadow,
        'stroke-opacity': 0.6,
        'stroke-width': 1
      }));
      svg.appendChild(svgEl('line', {
        x1: x,
        y1: padT - 5,
        x2: x,
        y2: padT + boardH + 5,
        stroke: theme.fret,
        'stroke-width': 1.5
      }));
    }

    if (f > 0 && ([1, 3, 5, 7, 9, 12, 15, 17, 19, 21, 24].includes(f))) {
      svg.appendChild(svgEl('text', {
        x: xForFretSpace(f),
        y: height - 6,
        fill: theme.inkMuted,
        'font-size': 11,
        'font-weight': '600',
        'text-anchor': 'middle',
        'font-family': theme.monoFont
      }, String(f)));
    }
  }

  // Capo bar if active
  if (capo > 0 && capo <= maxFrets) {
    const cx = xForFretSpace(capo);
    svg.appendChild(svgEl('rect', {
      x: cx - 5,
      y: padT - 7,
      width: 10,
      height: boardH + 14,
      rx: 4,
      fill: 'rgba(214, 162, 108, 0.22)',
      stroke: theme.filament,
      'stroke-width': 1.2
    }));
  }

  // Strings (high e 0.9px to low E 2.2px; three wound low strings bronze, plain upper strings)
  const woundCount = Math.max(0, numStrings - 3);
  for (let s = 0; s < numStrings; s++) {
    const y = yForString(s);
    const thickness = 0.9 + ((numStrings - 1 - s) / Math.max(1, numStrings - 1)) * 1.3;
    const isWound = s < woundCount;

    svg.appendChild(svgEl('line', {
      x1: padL,
      y1: y,
      x2: padL + boardW,
      y2: y,
      stroke: isWound ? theme.stringWound : theme.stringPlain,
      'stroke-width': thickness
    }));

    const labelX = leftHanded ? (padL + boardW + 28) : 14;
    const openName = midiToName(tuning[s] + capo).replace(/\d+$/, '');
    svg.appendChild(svgEl('text', {
      x: labelX,
      y: y + 4,
      fill: theme.stringLabel,
      'font-size': 12,
      'font-weight': '600',
      'font-family': theme.monoFont,
      'text-anchor': 'middle'
    }, openName));
  }

  // Target dot: amber (#d6a26c) with --accent-ink (#1c1916) number; other dots: #ece7df with #1c1916 text
  for (const m of marks) {
    if (m.string < 0 || m.string >= numStrings || m.fret < 0 || m.fret > maxFrets) continue;
    const cx = xForFretSpace(m.fret);
    const cy = yForString(m.string);
    const isTarget = m.kind === 'target' || Boolean(m.next);

    let fill = theme.dotFill;
    let stroke = theme.dotText;
    let strokeWidth = 1.2;
    let r = 8.5;
    let textFill = theme.dotText;

    if (isTarget) {
      fill = theme.targetFill;
      stroke = theme.targetText;
      strokeWidth = 1.5;
      textFill = theme.targetText;
      r = 9.5;
    } else if (m.kind === 'root') {
      fill = theme.targetFill;
      stroke = theme.targetText;
      textFill = theme.targetText;
      r = 9.5;
    } else if (m.kind === 'scale') {
      // In the scale but not played in the song: hollow, so the song's own notes stand out
      fill = 'rgba(15, 13, 11, 0.88)';
      stroke = 'rgba(236, 231, 223, 0.5)';
      textFill = theme.dotFill;
      r = 8;
    } else if (m.kind === 'heard') {
      fill = 'rgba(236, 231, 223, 0.16)';
      stroke = theme.dotFill;
      strokeWidth = 1.8;
      textFill = theme.dotFill;
      r = 10.5;
    }

    svg.appendChild(svgEl('circle', {
      cx,
      cy,
      r,
      fill,
      stroke,
      'stroke-width': strokeWidth
    }));

    const label = m.label !== undefined ? String(m.label) : String(m.fret);
    if (label) {
      svg.appendChild(svgEl('text', {
        x: cx,
        y: cy + 3.5,
        fill: textFill,
        'font-size': 10,
        'font-weight': '700',
        'font-family': theme.monoFont,
        'text-anchor': 'middle'
      }, label));
    }
  }

  el.appendChild(svg);
}

export function renderChordDiagram(el, {
  name = '',
  notes = [],
  tuning = [40, 45, 50, 55, 59, 64]
} = {}) {
  if (!el) return;
  el.innerHTML = '';

  const theme = readTheme(el);
  const numStrings = tuning.length;
  const fretted = notes.map((n) => n.fret).filter((f) => f > 0);
  const minFret = fretted.length > 0 ? Math.min(...fretted) : 1;
  const maxFret = fretted.length > 0 ? Math.max(...fretted) : 4;
  const span = Math.max(4, maxFret - minFret + 1);
  const baseFret = maxFret <= 4 ? 1 : minFret;

  const strGap = 18;
  const fretGap = 20;
  const padL = 24;
  const padR = 16;
  const padT = 36;
  const padB = 16;

  const gridW = (numStrings - 1) * strGap;
  const gridH = span * fretGap;
  const width = padL + gridW + padR;
  const height = padT + gridH + padB;

  const svg = svgEl('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `Chord diagram for ${name}`
  });

  // Chord name above in Big Shoulders 800 ink
  if (name) {
    svg.appendChild(svgEl('text', {
      x: width / 2,
      y: 17,
      fill: theme.ink,
      'font-size': 15,
      'font-weight': '800',
      'font-family': theme.displayFont,
      'text-anchor': 'middle'
    }, name));
  }

  // Ink grid lines and thick ink nut
  for (let f = 0; f <= span; f++) {
    const y = padT + f * fretGap;
    const isNut = f === 0 && baseFret === 1;
    svg.appendChild(svgEl('line', {
      x1: padL,
      y1: y,
      x2: padL + gridW,
      y2: y,
      stroke: theme.ink,
      'stroke-width': isNut ? 4 : 1.2
    }));
  }

  if (baseFret > 1) {
    svg.appendChild(svgEl('text', {
      x: padL - 7,
      y: padT + fretGap * 0.7,
      fill: theme.inkMuted,
      'font-size': 10,
      'font-weight': '700',
      'font-family': theme.displayFont,
      'text-anchor': 'end'
    }, `${baseFret}fr`));
  }

  const byString = new Map();
  for (const n of notes) {
    const existing = byString.get(n.string);
    if (!existing || n.fret > existing.fret) {
      byString.set(n.string, n);
    }
  }

  for (let s = 0; s < numStrings; s++) {
    const x = padL + s * strGap;
    svg.appendChild(svgEl('line', {
      x1: x,
      y1: padT,
      x2: x,
      y2: padT + gridH,
      stroke: theme.ink,
      'stroke-width': 1.2
    }));

    const noteObj = byString.get(s);
    const fret = noteObj ? noteObj.fret : undefined;

    if (fret === undefined) {
      svg.appendChild(svgEl('text', {
        x,
        y: padT - 7,
        fill: theme.ink,
        'font-size': 12,
        'font-weight': '700',
        'text-anchor': 'middle'
      }, '×'));
    } else if (fret === 0) {
      svg.appendChild(svgEl('circle', {
        cx: x,
        cy: padT - 10,
        r: 4,
        fill: 'none',
        stroke: theme.ink,
        'stroke-width': 1.8
      }));
    } else {
      const relFret = fret - baseFret + 1;
      if (relFret >= 1 && relFret <= span) {
        const cy = padT + (relFret - 0.5) * fretGap;
        svg.appendChild(svgEl('circle', {
          cx: x,
          cy,
          r: 7,
          fill: theme.targetFill
        }));

        const finger = noteObj.finger !== undefined ? noteObj.finger : noteObj.label;
        if (finger !== undefined && finger !== null && String(finger) !== '') {
          svg.appendChild(svgEl('text', {
            x,
            y: cy + 3.2,
            fill: theme.targetText,
            'font-size': 9.5,
            'font-weight': '700',
            'font-family': theme.displayFont,
            'text-anchor': 'middle'
          }, String(finger)));
        }
      }
    }
  }

  el.appendChild(svg);
}
