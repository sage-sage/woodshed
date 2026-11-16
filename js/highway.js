import { midiToName } from './song.js';
import { nameChord } from './theory.js';
import { STRING_COLORS } from './fretboard.js';

export class Highway {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.song = null;
    this.events = [];
    this.chordLabels = new Map();
    this.nextNoteTime = new Map();
    this.prevSame = new Map();
    this.noteTime = new Map();
    this.pxPerSec = 250;
    this.seekCallbacks = new Set();

    this.width = 800;
    this.height = 360;
    this.dpr = globalThis.devicePixelRatio || 1;
    this.overviewHeight = 28;
    this._draggingOverview = false;
    this.theme = null;

    this._readTheme();

    this._resizeObserver = null;
    this._onWindowResize = () => this._updateSize();
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._updateSize());
      this._resizeObserver.observe(this.canvas);
      if (this.canvas.parentElement) {
        this._resizeObserver.observe(this.canvas.parentElement);
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._onWindowResize);
    }
    this._updateSize();

    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
  }

  _readTheme() {
    const readVar = (name, fallback) => {
      if (typeof document === 'undefined' || !document.documentElement) return fallback;
      // From the canvas, so the dark "screen" palette scoped around it applies in light mode too.
      const target = this.canvas && this.canvas.isConnected ? this.canvas : document.documentElement;
      const val = getComputedStyle(target).getPropertyValue(name).trim();
      return val || fallback;
    };

    const bg = readVar('--screen', '#0f0d0b');
    this.theme = {
      bg,
      staffLine: readVar('--line', '#3a342e'),
      barLine: '#5a5249',
      barNum: readVar('--fg-faint', '#6f675d'),
      fretNum: readVar('--fg', '#ece7df'),
      techMark: '#d6cfc4',
      hit: readVar('--good', '#a3d4a0'),
      miss: readVar('--bad', '#e6a092'),
      waiting: readVar('--warn', '#e9d29a'),
      stringLabel: readVar('--fg-faint', '#6f675d'),
      chordName: readVar('--fg-muted', '#a8a097'),
      playhead: readVar('--accent', '#d6a26c'),
      screen: bg,
      screen2: readVar('--panel-2', '#34302b'),
      cream: readVar('--fg', '#ece7df'),
      creamMuted: readVar('--fg-muted', '#a8a097'),
      ink: readVar('--bg', '#1c1916'),
      filament: readVar('--accent', '#d6a26c'),
      jewel: readVar('--bad', '#e6a092'),
      ok: readVar('--good', '#a3d4a0'),
      bad: readVar('--bad', '#e6a092'),
      lozenge: readVar('--panel', '#2b2723'),
      monoFont: readVar('--font-mono', '"JetBrains Mono", ui-monospace, monospace'),
      bodyFont: readVar('--font-body', '"Inter", system-ui, -apple-system, sans-serif'),
      displayFont: readVar('--font-display', '"Space Grotesk", system-ui, sans-serif'),
      strings: [
        readVar('--s0', STRING_COLORS[0]),
        readVar('--s1', STRING_COLORS[1]),
        readVar('--s2', STRING_COLORS[2]),
        readVar('--s3', STRING_COLORS[3]),
        readVar('--s4', STRING_COLORS[4]),
        readVar('--s5', STRING_COLORS[5]),
        readVar('--s6', STRING_COLORS[6]),
        readVar('--s7', STRING_COLORS[7])
      ]
    };
  }

  _rgba(color, alpha) {
    if (!color) return `rgba(229, 229, 229, ${alpha})`;
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      const full = hex.length === 3
        ? hex.split('').map((c) => c + c).join('')
        : hex.slice(0, 6);
      const num = parseInt(full, 16);
      if (Number.isFinite(num)) {
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
    return color;
  }

  _updateSize() {
    this._readTheme();
    const rect = this.canvas.getBoundingClientRect();
    const parentRect = this.canvas.parentElement?.getBoundingClientRect();
    const rawW = rect.width || parentRect?.width || 800;
    const rawH = rect.height || parentRect?.height || 360;
    const w = Math.max(300, Math.floor(rawW));
    const h = Math.max(120, Math.floor(rawH));
    const dpr = globalThis.devicePixelRatio || 1;
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (
      w === this.width &&
      h === this.height &&
      dpr === this.dpr &&
      this.canvas.width === targetW &&
      this.canvas.height === targetH &&
      this._sized
    ) {
      return;
    }
    this._sized = true;
    this.dpr = dpr;
    this.width = w;
    this.height = h;
    this.canvas.width = targetW;
    this.canvas.height = targetH;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Resizing wipes the canvas: redraw the last frame so static previews do not go blank.
    if (this._lastRender) this.render(this._lastRender);
  }

  setSong(song, events = []) {
    this._readTheme();
    this.song = song;
    this.events = Array.isArray(events) ? events : [];
    this.chordLabels.clear();
    this.nextNoteTime = new Map();
    this.prevSame = new Map();
    this.noteTime = new Map();

    const lastByString = new Map();
    const sortedEvents = [...this.events].sort((a, b) => a.t - b.t);
    for (const ev of sortedEvents) {
      for (const n of ev.notes) {
        this.noteTime.set(n, ev.t);
        const prev = lastByString.get(n.string);
        if (prev) {
          this.nextNoteTime.set(prev.note, ev.t);
          this.prevSame.set(n, ev.t - prev.t <= 2.0 ? prev.note : null);
        } else {
          this.prevSame.set(n, null);
        }
        lastByString.set(n.string, { note: n, t: ev.t });
      }
    }

    for (const ev of this.events) {
      if (ev.notes.length >= 2) {
        const ch = nameChord(ev.notes.map((n) => n.midi));
        if (ch && ch.name) {
          this.chordLabels.set(ev.index, ch.name);
        }
      }
    }
  }

  setView({ pxPerSec } = {}) {
    if (Number.isFinite(pxPerSec) && pxPerSec >= 100 && pxPerSec <= 600) {
      this.pxPerSec = pxPerSec;
    }
  }

  onSeek(fn) {
    if (typeof fn === 'function') this.seekCallbacks.add(fn);
    return () => this.seekCallbacks.delete(fn);
  }

  _seekFromClientX(clientX) {
    if (!this.song) return;
    const rect = this.canvas.getBoundingClientRect();
    const relX = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const targetTabTime = relX * (this.song.duration || 1);
    for (const fn of this.seekCallbacks) {
      fn(targetTabTime);
    }
  }

  _handlePointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y <= this.overviewHeight + 8) {
      this._draggingOverview = true;
      this._seekFromClientX(e.clientX);
    }
  }

  _handlePointerMove(e) {
    if (!this._draggingOverview) return;
    this._seekFromClientX(e.clientX);
  }

  _handlePointerUp() {
    this._draggingOverview = false;
  }

  render({
    tabNow = 0,
    states = new Uint8Array(0),
    heard = null,
    loop = null,
    fx = [],
    showNoteNames = false
  } = {}) {
    this._lastRender = { tabNow, states, heard, loop, fx, showNoteNames };
    const rect = this.canvas.getBoundingClientRect();
    const curDpr = globalThis.devicePixelRatio || 1;
    if (
      (rect.width > 0 && Math.floor(rect.width) !== this.width) ||
      (rect.height > 0 && Math.floor(rect.height) !== this.height) ||
      curDpr !== this.dpr
    ) {
      this._updateSize();
    }
    if (!this.theme) this._readTheme();
    const t = this.theme;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Background (current screen colour)
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, w, h);

    if (!this.song) {
      ctx.restore();
      return;
    }

    const ovH = this.overviewHeight;
    // Small canvases (Learn's layer previews) get tighter padding, and nothing forces the staff taller than the box.
    const compact = h < 200;
    const topPad = compact ? 16 : 24;
    const bottomPad = compact ? 8 : 16;
    const availTop = ovH + topPad;
    const availBottom = h - bottomPad;
    const availH = Math.max(30, availBottom - availTop);

    const numStrings = this.song.tuning.length;
    const laneGap = Math.max(12, Math.min(46, availH / 6.5)); // small previews shrink instead of cropping the staff
    const staffSpan = Math.max(0, numStrings - 1) * laneGap;
    const centerY = availTop + availH / 2;
    const topLineY = centerY - staffSpan / 2;
    const botLineY = centerY + staffSpan / 2;
    const yForString = (s) => botLineY - s * laneGap;

    const strikeX = Math.round(Math.max(120, Math.min(360, w * 0.22)));
    const xForTime = (time) => strikeX + (time - tabNow) * this.pxPerSec;
    const tMin = tabNow - (strikeX / this.pxPerSec) - 0.5;
    const tMax = tabNow + ((w - strikeX) / this.pxPerSec) + 0.5;

    // 1. Overview Strip (spans full canvas width)
    this._renderOverview(ctx, w, ovH, tabNow, states, loop);

    // 2. Loop Highlight on Highway
    if (loop && Number.isFinite(loop.t0) && Number.isFinite(loop.t1) && loop.t1 > loop.t0) {
      const lx0 = Math.max(0, xForTime(loop.t0));
      const lx1 = Math.min(w, xForTime(loop.t1));
      if (lx1 > lx0) {
        ctx.fillStyle = this._rgba(t.playhead, 0.08);
        ctx.fillRect(lx0, ovH, lx1 - lx0, h - ovH);
      }
    }

    // 3. Bar lines and bar numbers
    ctx.save();
    ctx.strokeStyle = t.barLine;
    ctx.lineWidth = 1.25;
    ctx.fillStyle = t.barNum;
    ctx.font = `600 11px ${t.monoFont}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const barNumY = topLineY - 7;
    for (let bIdx = 0; bIdx < this.song.bars.length; bIdx++) {
      const bar = this.song.bars[bIdx];
      if (bar.t + bar.dur < tMin || bar.t > tMax) continue;

      const bx = xForTime(bar.t);
      if (bx >= 0 && bx <= w) {
        ctx.beginPath();
        ctx.moveTo(bx, topLineY);
        ctx.lineTo(bx, botLineY);
        ctx.stroke();

        ctx.fillText(`${bIdx + 1}`, bx + 4, barNumY);
      }
    }
    ctx.restore();

    // 4. Horizontal String Lanes (index 0 at bottom)
    ctx.save();
    ctx.strokeStyle = t.staffLine;
    ctx.lineWidth = 1;
    ctx.fillStyle = t.stringLabel;
    ctx.font = `600 12px ${t.monoFont}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let s = 0; s < numStrings; s++) {
      const y = yForString(s);
      // Like real strings: thicker toward the low E, and the three wound ones carry a faint bronze tint.
      ctx.lineWidth = Math.max(0.8, 1.6 - s * 0.14);
      ctx.strokeStyle = s < 3 && numStrings >= 6 ? 'rgba(176, 141, 87, 0.38)' : t.staffLine;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();

      const openName = midiToName(this.song.tuning[s] + (this.song.capo || 0)).replace(/\d+$/, '');
      ctx.fillText(openName, 10, y);
    }
    ctx.restore();

    // 5. Strike Line (2px maple with a soft, low glow)
    ctx.save();
    ctx.strokeStyle = t.playhead;
    ctx.lineWidth = 2;
    ctx.shadowBlur = 9;
    ctx.shadowColor = 'rgba(214, 162, 108, 0.35)';
    ctx.beginPath();
    ctx.moveTo(strikeX, ovH + 4);
    ctx.lineTo(strikeX, h - 6);
    ctx.stroke();
    ctx.restore();

    // 6. Events & Notes (JetBrains Mono tab numbers)
    const fontSize = Math.round(Math.max(14, Math.min(24, laneGap * 0.62)));
    const noteFont = `700 ${fontSize}px ${t.monoFont}`;
    const noteLabel = (n) => (n.dead ? 'x' : (showNoteNames ? midiToName(n.midi).replace(/\d+$/, '') : String(n.fret)));

    // Slide & hammer/pull connectors (drawn before fret numbers)
    for (const ev of this.events) {
      const ex = xForTime(ev.t);
      const evOnScreen = ev.t >= tMin && ev.t <= tMax;
      for (const n of ev.notes) {
        if (n.tech !== 'slide' && n.tech !== 'h' && n.tech !== 'p') continue;
        const prevSame = this.prevSame.get(n) || null;
        const prevT = prevSame ? this.noteTime.get(prevSame) : null;
        const prevOnScreen = prevT !== null && prevT !== undefined && prevT >= tMin && prevT <= tMax;
        if (!evOnScreen && !prevOnScreen) continue;

        const ny = yForString(n.string);
        ctx.font = noteFont;
        const curW = ctx.measureText(noteLabel(n)).width;

        ctx.save();
        ctx.strokeStyle = t.techMark;
        ctx.fillStyle = t.techMark;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';

        if (n.tech === 'slide') {
          const x1 = ex - curW / 2 - 3;
          let x0;
          let rising;
          if (prevSame && prevT !== null && prevT !== undefined) {
            const prevW = ctx.measureText(noteLabel(prevSame)).width;
            x0 = xForTime(prevT) + prevW / 2 + 3;
            rising = n.fret > prevSame.fret;
          } else {
            x0 = x1 - 18;
            rising = true;
          }
          if (x1 <= x0 + 4) x0 = x1 - 14;
          const dy = 0.175 * laneGap;
          const y0 = rising ? ny + dy : ny - dy;
          const y1 = rising ? ny - dy : ny + dy;

          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        } else {
          const topY = ny - fontSize * 0.5 - 2;
          ctx.font = '700 11px system-ui, -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          if (prevSame && prevT !== null && prevT !== undefined) {
            const x0 = xForTime(prevT);
            const x1 = ex;
            const cpX = (x0 + x1) / 2;
            const cpY = topY - 16;
            const peakY = topY - 8;

            ctx.beginPath();
            ctx.moveTo(x0, topY);
            ctx.quadraticCurveTo(cpX, cpY, x1, topY);
            ctx.stroke();

            const techW = ctx.measureText(n.tech).width;
            ctx.fillStyle = t.bg;
            ctx.fillRect(cpX - techW / 2 - 2, peakY - 6, techW + 4, 12);
            ctx.fillStyle = t.techMark;
            ctx.fillText(n.tech, cpX, peakY);
          } else {
            ctx.fillText(n.tech, ex, topY - 6);
          }
        }
        ctx.restore();
      }
    }

    const chordY = topLineY - 18;
    for (const ev of this.events) {
      if (ev.t + ev.dur < tMin || ev.t > tMax) continue;
      const ex = xForTime(ev.t);
      const state = states[ev.index] || 0; // 0 pending, 1 hit, 2 miss, 3 waiting

      // Chord name above the staff (no bracket line)
      if (ev.notes.length >= 2) {
        const chordName = this.chordLabels.get(ev.index);
        if (chordName) {
          ctx.save();
          ctx.fillStyle = t.chordName;
          ctx.font = `600 12px ${t.bodyFont}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(chordName, ex, chordY);
          ctx.restore();
        }
      }

      for (const n of ev.notes) {
        const ny = yForString(n.string);
        const label = noteLabel(n);

        ctx.save();
        ctx.font = noteFont;
        const textW = ctx.measureText(label).width;
        const koW = textW + 4;
        const koH = fontSize + 2;

        // Knockout rect behind text so the staff line doesn't cross digits
        ctx.fillStyle = t.bg;
        ctx.fillRect(ex - koW / 2, ny - koH / 2, koW, koH);

        // State text colour
        const numColor = state === 1
          ? t.hit
          : state === 2
            ? t.miss
            : state === 3
              ? t.waiting
              : t.fretNum;

        ctx.fillStyle = numColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, ex, ny + 0.5);

        // Waiting: 1.5px yellow underline
        if (state === 3) {
          const ulY = ny + fontSize * 0.5 + 1.5;
          ctx.strokeStyle = t.waiting;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(ex - textW / 2 - 1, ulY);
          ctx.lineTo(ex + textW / 2 + 1, ulY);
          ctx.stroke();
        }

        // Technique marks (#d6d6d6, 1.5px)
        ctx.strokeStyle = t.techMark;
        ctx.fillStyle = t.techMark;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';

        if (n.tech === 'harm' || n.harmonic) {
          const rx = Math.max(textW / 2 + 5, fontSize * 0.55 + 2);
          const ry = fontSize * 0.55 + 3;
          ctx.beginPath();
          ctx.moveTo(ex, ny - ry);
          ctx.lineTo(ex + rx, ny);
          ctx.lineTo(ex, ny + ry);
          ctx.lineTo(ex - rx, ny);
          ctx.closePath();
          ctx.stroke();
        }

        if (n.bend || n.tech === 'bend') {
          const startX = ex + textW / 2 + 2;
          const startY = ny + 2;
          const endX = startX + 8;
          const endY = ny - fontSize * 0.5 - 5;
          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.quadraticCurveTo(endX, startY, endX, endY);
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(endX - 3, endY + 4);
          ctx.lineTo(endX, endY);
          ctx.lineTo(endX + 3, endY + 4);
          ctx.stroke();

          const bendText = this._bendLabel(n);
          ctx.font = '700 10px system-ui, -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(bendText, endX, endY - 1);
        } else if (n.tech === 'vib' || n.vibrato) {
          const vw = 18;
          const vy = ny - fontSize * 0.5 - 5;
          const amp = 2;
          ctx.beginPath();
          for (let i = 0; i <= 24; i++) {
            const u = i / 24;
            const px = ex - vw / 2 + u * vw;
            const py = vy - Math.sin(u * Math.PI * 6) * amp;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        } else if (n.tech === 'pm' || n.palmMute) {
          ctx.font = '700 10px system-ui, -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText('P.M.', ex, ny - fontSize * 0.5 - 3);
        }

        ctx.restore();
      }
    }

    // 7. Hit burst FX (neutral flash on strike line)
    const nowMs = performance.now();
    for (const item of fx) {
      const age = (nowMs - item.born) / 360;
      if (age < 0 || age >= 1) continue;
      const y = yForString(item.string);
      const radius = 10 + age * 20;
      ctx.save();
      ctx.globalAlpha = (1 - age) * 0.45;
      ctx.strokeStyle = t.playhead;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(strikeX, y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 8. Heard marker on strike line
    if (heard && heard.midi > 0) {
      const noteLabelStr = midiToName(Math.round(heard.midi));
      const centsStr = Number.isFinite(heard.cents)
        ? `${heard.cents >= 0 ? '+' : ''}${Math.round(heard.cents)}c`
        : '';
      const targetStr = heard.string !== undefined && heard.string >= 0
        ? heard.string
        : this._closestStringForMidi(heard.midi);
      const hy = yForString(targetStr);

      ctx.save();
      ctx.fillStyle = t.lozenge;
      this._roundRect(ctx, strikeX - 44, hy - 11, 88, 22, 11);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = heard.wrong ? t.miss : t.staffLine;
      ctx.stroke();

      ctx.fillStyle = heard.wrong ? t.miss : t.fretNum;
      ctx.font = '700 11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`heard ${noteLabelStr} ${centsStr}`.trim(), strikeX, hy);
      ctx.restore();
    }

    ctx.restore();
  }

  _renderOverview(ctx, w, ovH, tabNow, states, loop) {
    const t = this.theme;
    const dur = Math.max(1, this.song.duration || 1);
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, w, ovH);

    if (loop && Number.isFinite(loop.t0) && Number.isFinite(loop.t1) && loop.t1 > loop.t0) {
      const x0 = (loop.t0 / dur) * w;
      const x1 = (loop.t1 / dur) * w;
      ctx.fillStyle = this._rgba(t.playhead, 0.1);
      ctx.fillRect(x0, 0, x1 - x0, ovH);
    }

    for (const ev of this.events) {
      const x = (ev.t / dur) * w;
      const st = states[ev.index] || 0;
      ctx.fillStyle = st === 1 ? t.hit : st === 2 ? t.miss : t.staffLine;
      ctx.fillRect(x, 6, 2, ovH - 12);
    }

    const px = Math.max(0, Math.min(w, (tabNow / dur) * w));
    ctx.fillStyle = t.playhead;
    ctx.fillRect(px - 1.5, 0, 3, ovH);

    ctx.strokeStyle = t.staffLine;
    ctx.beginPath();
    ctx.moveTo(0, ovH);
    ctx.lineTo(w, ovH);
    ctx.stroke();
  }

  _closestStringForMidi(midi) {
    if (!this.song || !this.song.tuning) return 0;
    let best = 0;
    let bestDist = Infinity;
    for (let s = 0; s < this.song.tuning.length; s++) {
      const open = this.song.tuning[s] + (this.song.capo || 0);
      const diff = midi - open;
      if (diff >= -1 && diff <= 24 && diff < bestDist) {
        bestDist = diff;
        best = s;
      }
    }
    return best;
  }

  _bendLabel(n) {
    const b = n.bend;
    if (b === 2 || b === 'full') return 'full';
    if (b === 1 || b === 0.5 || b === '1/2' || b === '½') return '½';
    if (typeof b === 'number' && Number.isFinite(b) && b > 0) return `b+${b}`;
    if (typeof b === 'string' && b.trim()) return b.trim();
    return 'full';
  }

  _roundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (typeof window !== 'undefined' && this._onWindowResize) {
      window.removeEventListener('resize', this._onWindowResize);
    }
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this.seekCallbacks.clear();
  }
}
