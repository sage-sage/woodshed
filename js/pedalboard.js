import { isDesktop, desktop, postToHost } from './desktop.js';
import { makeWheelClassifier, wheelZoomFactor } from './board-input.js';
import { hasPedalArt, pedalSize, pedalArtHtml, mountPedalArt, setPedalArtPaused, artStats } from './pedal-art.js';

// World units: the amp stores tile positions in grid cells (blocks 9 cells apart, rows 6 apart).
const CELL_PX = 54;
const TILE_W = 180;
const TILE_H = 96;
const PEDAL_SCALE = 0.9;
const PEDAL_MAX_W = 408;   // wide pedals shrink so they fit between blocks (9 cells = 486 px) with room for cables
const PEDAL_MAX_H = 300;   // tall pedals shrink so they fit between rows (6 cells = 324 px)
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const FIT_MIN_ZOOM = 0.45;
const LONG_PRESS_MS = 550;

const PEDAL_CAT_COLORS = {
  amp: '#c08752',
  cab: '#8a6d4f',
  drive: '#c4583c',
  modulation: '#5b8fb0',
  time: '#7d6bb3',
  eq: '#6f9a5b',
  utility: '#8f8a80'
};

const PEDAL_CAT_GROUPS = [
  ['amp', 'Amp & captures'],
  ['cab', 'Cabinet'],
  ['drive', 'Drive'],
  ['modulation', 'Modulation'],
  ['time', 'Time'],
  ['eq', 'EQ'],
  ['utility', 'Utility']
];

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function formatBoardVal(spec, rawVal) {
  const v = Number(rawVal);
  if (!Number.isFinite(v)) return '—';
  if (spec?.isGate && v <= -80) return 'Off';
  const unit = String(spec?.unit || '').trim();
  const key = String(spec?.key || '').toLowerCase();
  const min = Number(spec?.min);
  const max = Number(spec?.max);
  const isZeroToOne = min === 0 && max === 1;
  const isPctKey = key === 'mix' || key === 'depth' || key === 'feedback' || key === 'wah' || (key === 'level' && max === 1);
  if ((unit === '%' && min >= 0 && max <= 1) || (isZeroToOne && isPctKey)) {
    return `${Math.round(v * 100)}%`;
  }
  if (unit === '%') return `${Math.round(v)}%`;
  if (unit.toLowerCase() === 'db') {
    const rounded = Math.round(v * 10) / 10;
    const clean = Math.abs(rounded) < 0.05 ? 0 : rounded;
    return `${clean > 0 ? '+' : ''}${clean.toFixed(1)} dB`;
  }
  if (unit.toLowerCase() === 'hz') {
    return Math.abs(v) < 100 ? `${v.toFixed(2)} Hz` : `${Math.round(v)} Hz`;
  }
  if (unit.toLowerCase() === 'ms') {
    return `${Math.round(v)} ms`;
  }
  const step = Number(spec?.step);
  if (Number.isFinite(step) && step >= 1 && Number.isInteger(v)) {
    return unit ? `${v} ${unit}` : String(v);
  }
  const formatted = Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}

function parsePresetFromHash() {
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) return '';
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return params.get('preset') || '';
}

function sameCable(a, b) {
  return Boolean(
    a && b &&
    a.from === b.from &&
    a.to === b.to &&
    (Number(a.port) || 0) === (Number(b.port) || 0)
  );
}

function bezierPathData(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return {
    d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
    midX: 0.125 * x1 + 0.375 * (x1 + dx) + 0.375 * (x2 - dx) + 0.125 * x2,
    midY: 0.5 * (y1 + y2),
    p0: { x: x1, y: y1 },
    p1: { x: x1 + dx, y: y1 },
    p2: { x: x2 - dx, y: y2 },
    p3: { x: x2, y: y2 }
  };
}

function distToBezierSq(px, py, bez, samples = 32) {
  const { p0, p1, p2, p3 } = bez;
  let minSq = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    const bx = mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x;
    const by = mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y;
    const dx = px - bx;
    const dy = py - by;
    const d2 = dx * dx + dy * dy;
    if (d2 < minSq) minSq = d2;
  }
  return minSq;
}

function computeConnectedSet(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const cables = Array.isArray(graph?.cables) ? graph.cables : [];
  const forward = new Map();
  const backward = new Map();

  for (const c of cables) {
    if (!forward.has(c.from)) forward.set(c.from, []);
    forward.get(c.from).push(c.to);
    if (!backward.has(c.to)) backward.set(c.to, []);
    backward.get(c.to).push(c.from);
  }

  const fromIn = new Set(['in']);
  const q1 = ['in'];
  while (q1.length > 0) {
    const cur = q1.shift();
    for (const nxt of forward.get(cur) || []) {
      if (!fromIn.has(nxt)) {
        fromIn.add(nxt);
        q1.push(nxt);
      }
    }
  }

  const toOut = new Set(['out']);
  const q2 = ['out'];
  while (q2.length > 0) {
    const cur = q2.shift();
    for (const prev of backward.get(cur) || []) {
      if (!toOut.has(prev)) {
        toOut.add(prev);
        q2.push(prev);
      }
    }
  }

  const active = new Set();
  for (const n of nodes) {
    if (fromIn.has(n.uid) && toOut.has(n.uid)) {
      active.add(n.uid);
    }
  }
  return active;
}

function wouldCreateCycle(cables, from, to) {
  if (from === to) return true;
  const adj = new Map();
  for (const c of cables) {
    if (!adj.has(c.from)) adj.set(c.from, []);
    adj.get(c.from).push(c.to);
  }
  const visited = new Set([to]);
  const stack = [to];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === from) return true;
    for (const nxt of adj.get(cur) || []) {
      if (!visited.has(nxt)) {
        visited.add(nxt);
        stack.push(nxt);
      }
    }
  }
  return false;
}

export function mount(container, ctx) {
  const { amp, toast, settings } = ctx;

  let selectedPresetId = '';
  let pendingOpenId = '';
  let pendingUrlPreset = parsePresetFromHash();
  let selectedUid = null;
  let selectedCable = null;
  let drawerOpen = false;
  let paletteOpen = false;
  let confirmDeleteOpen = false;
  let renaming = false;
  let activeInteraction = null;
  // The tile menu (right-click or long-press): { uid } for a tile, { cable } for a cable; x/y = where it opened.
  let menu = null;
  let presetsHidden = false;
  try { presetsHidden = settings?.get?.('pedalboardPresetsHidden') === true; } catch (_) { /* optional */ }
  // Mounted pedal art, kept across re-renders so the pedals don't reload and restart on every change.
  // key `${presetId}|${uid}` -> { type, el, ctl, node, last: {param: value} }
  const artCache = new Map();
  const artKey = (presetId, uid) => `${presetId}|${uid}`;
  let movingTimer = 0;

  const classifyWheel = makeWheelClassifier();

  const viewStateByPreset = new Map();
  const faderRafs = new Map();

  function getViewState(presetId) {
    if (!viewStateByPreset.has(presetId)) {
      viewStateByPreset.set(presetId, { panX: 32, panY: 32, zoom: 1, fitPending: true });
    }
    return viewStateByPreset.get(presetId);
  }

  function rememberPreset(id) {
    selectedPresetId = id;
    try { settings?.set?.('pedalboardPreset', id); } catch (_) { /* settings are optional */ }
  }

  function getBlockTypeMap() {
    const list = Array.isArray(amp.presets?.blockTypes) ? amp.presets.blockTypes : [];
    return new Map(list.map((bt) => [bt.id, bt]));
  }

  function getPresetList() {
    return Array.isArray(amp.presets?.list) ? amp.presets.list : [];
  }

  function getLivePresetId() {
    return amp.status?.preset || amp.presets?.current || '';
  }

  function resolveSelectedPreset(presetList) {
    const graphPresets = presetList.filter((p) => p && p.graph);
    if (graphPresets.length === 0) return null;

    if (pendingUrlPreset) {
      const fromUrl = graphPresets.find((p) => p.id === pendingUrlPreset);
      pendingUrlPreset = '';
      if (fromUrl) {
        rememberPreset(fromUrl.id);
        return fromUrl;
      }
    }

    if (pendingOpenId) {
      // Just created (New / Duplicate / Import): the amp's reply arrives before its updated preset list.
      const created = graphPresets.find((p) => p.id === pendingOpenId);
      if (!created) return graphPresets.find((p) => p.id === selectedPresetId) || graphPresets[0];
      pendingOpenId = '';
      rememberPreset(created.id);
      return created;
    }

    if (selectedPresetId) {
      const existing = graphPresets.find((p) => p.id === selectedPresetId);
      if (existing) return existing;
    }

    const savedId = settings?.get?.('pedalboardPreset');
    if (savedId) {
      const fromSettings = graphPresets.find((p) => p.id === savedId);
      if (fromSettings) {
        rememberPreset(fromSettings.id);
        return fromSettings;
      }
    }

    const liveId = getLivePresetId();
    const livePreset = graphPresets.find((p) => p.id === liveId) || graphPresets[0];
    rememberPreset(livePreset.id);
    return livePreset;
  }

  function getIoCoords(graph) {
    const io = graph?.io || {};
    return {
      inX: Number.isFinite(io.inX) ? io.inX : 2,
      inY: Number.isFinite(io.inY) ? io.inY : 8,
      outX: Number.isFinite(io.outX) ? io.outX : 38,
      outY: Number.isFinite(io.outY) ? io.outY : 8
    };
  }

  function getNodeSummary(node, bt) {
    if (bt?.usesFile || node.file) {
      return node.file || 'No file';
    }
    const specs = Array.isArray(bt?.params) ? bt.params : [];
    if (specs.length === 0) return '';

    const isMixer = node.type === 'mixer' || bt?.inputs === 2;
    if (isMixer) {
      const blendSpec = specs.find((s) => /blend|mix|balance/i.test(s.key)) || specs[0];
      const raw = Number.isFinite(node.params?.[blendSpec.key]) ? node.params[blendSpec.key] : blendSpec.def;
      return `A/B ${formatBoardVal(blendSpec, raw)}`;
    }

    const parts = [];
    for (const ps of specs.slice(0, 2)) {
      const raw = Number.isFinite(node.params?.[ps.key]) ? node.params[ps.key] : (Number.isFinite(ps.def) ? ps.def : ps.min ?? 0);
      if (Array.isArray(ps.options) && ps.options.length > 0) {
        const idx = Math.round(Number(raw) || 0);
        const opt = ps.options[idx] ?? ps.options[0] ?? '';
        parts.push(String(opt));
      } else {
        parts.push(`${ps.label || ps.key} ${formatBoardVal(ps, raw)}`);
      }
    }
    return parts.join(' · ');
  }

  function tileSizeFor(node) {
    const s = node && hasPedalArt(node.type) ? pedalSize(node.type) : null;
    const k = s ? Math.min(PEDAL_SCALE, PEDAL_MAX_W / s.w, PEDAL_MAX_H / s.h) : 1;
    return s
      ? { w: Math.round(s.w * k), h: Math.round(s.h * k), k: Math.round(s.w * k) / s.w, pedal: true }
      : { w: TILE_W, h: TILE_H, k: 1, pedal: false };
  }

  function getJackPos(graph, blockTypeMap, uid, kind, port = 0) {
    const io = getIoCoords(graph);
    if (uid === 'in') {
      if (kind !== 'out') return null;
      return { x: io.inX * CELL_PX + TILE_W, y: io.inY * CELL_PX + TILE_H / 2 };
    }
    if (uid === 'out') {
      if (kind !== 'in') return null;
      return { x: io.outX * CELL_PX, y: io.outY * CELL_PX + TILE_H / 2 };
    }
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const node = nodes.find((n) => n.uid === uid);
    if (!node) return null;
    const { w, h, pedal } = tileSizeFor(node);
    const x = node.x * CELL_PX;
    const y = node.y * CELL_PX;
    if (kind === 'out') {
      return { x: x + w, y: y + h / 2 };
    }
    const bt = blockTypeMap.get(node.type);
    const inputs = bt?.inputs || (node.type === 'mixer' ? 2 : 1);
    if (inputs >= 2) {
      const py = Number(port) === 1 ? h * 0.65 : h * 0.35;
      return { x, y: y + py };
    }
    return { x, y: y + h / 2 };
  }

  function renderOffline() {
    const canLaunch = isDesktop && desktop?.ampInstalled;
    container.innerHTML = `
      <div class="pb-empty-wrap">
        <div class="pb-empty-card">
          <h2 class="pb-empty-title">Woodshed Amp isn't running</h2>
          ${canLaunch
            ? '<button type="button" class="btn btn-primary" id="pb-launch-amp">Start Woodshed Amp</button>'
            : '<p class="pb-empty-sub">Start it from the Start menu, or install it with Woodshed Setup (Settings &gt; Downloads)</p>'}
        </div>
      </div>
    `;
    container.querySelector('#pb-launch-amp')?.addEventListener('click', (e) => {
      postToHost({ type: 'launch-amp' });
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = 'Starting…';
    });
  }

  function renderUnsupported() {
    container.innerHTML = `
      <div class="pb-empty-wrap">
        <div class="pb-empty-card">
          <h2 class="pb-empty-title">Update Woodshed Amp to 2.2 or newer to use the pedalboard</h2>
          <a href="#/settings" class="btn btn-sm btn-primary">Open Settings</a>
        </div>
      </div>
    `;
  }

  function render() {
    if (amp.state !== 'online') {
      activeInteraction = null;
      renderOffline();
      return;
    }

    const presetList = getPresetList();
    if (presetList.length === 0 && amp.presets?.current == null && !amp.serverInfo) {
      container.innerHTML = `
        <div class="pb-empty-wrap">
          <div class="pb-empty-card">
            <p class="pb-empty-sub">Connecting to Woodshed Amp…</p>
          </div>
        </div>
      `;
      return;
    }

    const preset = resolveSelectedPreset(presetList);
    if (!preset || !preset.graph) {
      activeInteraction = null;
      renderUnsupported();
      return;
    }

    const graph = preset.graph;
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const cables = Array.isArray(graph.cables) ? graph.cables : [];
    const blockTypes = Array.isArray(amp.presets?.blockTypes) ? amp.presets.blockTypes : [];
    const blockTypeMap = getBlockTypeMap();
    const limits = amp.presets?.limits || {};
    const livePresetId = getLivePresetId();
    const isLive = preset.id === livePresetId;
    const isCustom = preset.builtin === false;
    const view = getViewState(preset.id);

    if (selectedUid && selectedUid !== 'in' && selectedUid !== 'out' && !nodes.some((n) => n.uid === selectedUid)) {
      selectedUid = null;
    }
    if (selectedCable && !cables.some((c) => sameCable(c, selectedCable))) {
      selectedCable = null;
    }

    const builtins = presetList.filter((p) => p.builtin !== false);
    const customs = presetList.filter((p) => p.builtin === false);
    const maxCustom = Number.isFinite(limits.maxCustomPresets) ? limits.maxCustomPresets : Infinity;
    const atMaxCustom = customs.length >= maxCustom;

    const renderPresetRow = (p) => {
      const viewing = p.id === preset.id;
      const active = p.id === livePresetId;
      return `
        <button type="button" class="pb-preset-row${viewing ? ' is-viewing' : ''}${active ? ' is-live' : ''}" data-preset-id="${escapeHtml(p.id)}">
          <span class="pb-preset-row-name">${escapeHtml(p.name || p.id)}</span>
          ${active ? '<span class="chip chip-accent">Active</span>' : ''}
        </button>
      `;
    };

    const connectedSet = computeConnectedSet(graph);
    const nodeByUid = new Map(nodes.map((n) => [n.uid, n]));

    const cablesSvgHtml = cables.map((c, idx) => {
      const pStart = getJackPos(graph, blockTypeMap, c.from, 'out', 0);
      const pEnd = getJackPos(graph, blockTypeMap, c.to, 'in', c.port || 0);
      if (!pStart || !pEnd) return '';
      const bez = bezierPathData(pStart.x, pStart.y, pEnd.x, pEnd.y);
      const isSel = sameCable(c, selectedCable);
      const targetNode = nodeByUid.get(c.to);
      const isDim = targetNode && targetNode.enabled === false;
      const cKey = `${c.from}->${c.to}:${c.port || 0}`;
      return `
        <g class="pb-cable-group${isSel ? ' is-selected' : ''}${isDim ? ' is-dim' : ''}" data-cable-idx="${idx}" data-cable-key="${escapeHtml(cKey)}">
          <path class="pb-cable-hit" d="${bez.d}" />
          <path class="pb-cable-line" d="${bez.d}" />
          ${isSel ? `
            <g class="pb-cable-del" transform="translate(${bez.midX}, ${bez.midY})" role="button" tabindex="0" aria-label="Remove cable" title="Remove cable">
              <circle r="10" />
              <text y="0.5" text-anchor="middle" dominant-baseline="central">×</text>
            </g>
          ` : ''}
        </g>
      `;
    }).join('');

    const io = getIoCoords(graph);
    const inSelected = selectedUid === 'in';
    const outSelected = selectedUid === 'out';

    const ioTilesHtml = `
      <div class="pb-tile is-io${inSelected ? ' is-selected' : ''}" data-uid="in" tabindex="0" aria-label="INPUT tile"
        style="left:${io.inX * CELL_PX}px;top:${io.inY * CELL_PX}px;">
        <div class="pb-tile-head">
          <span class="pb-tile-title">INPUT</span>
        </div>
        <div class="pb-tile-summary tabular">Trim ${formatBoardVal({ unit: 'dB' }, graph.inputTrimDb ?? 0)}</div>
        <div class="pb-jack is-out" data-uid="in" data-dir="out" data-port="0" title="Input output jack"></div>
      </div>
      <div class="pb-tile is-io${outSelected ? ' is-selected' : ''}" data-uid="out" tabindex="0" aria-label="OUTPUT tile"
        style="left:${io.outX * CELL_PX}px;top:${io.outY * CELL_PX}px;">
        <div class="pb-tile-head">
          <span class="pb-tile-title">OUTPUT</span>
        </div>
        <div class="pb-tile-summary tabular">Level ${formatBoardVal({ unit: 'dB' }, graph.outputLevelDb ?? 0)}</div>
        <div class="pb-jack is-in" data-uid="out" data-dir="in" data-port="0" title="Output input jack"></div>
      </div>
    `;

    const effectTilesHtml = nodes.map((node) => {
      const bt = blockTypeMap.get(node.type);
      const name = bt?.name || node.type;
      const catColor = PEDAL_CAT_COLORS[bt?.category] || '#8f8a80';
      const isEnabled = node.enabled !== false;
      const isSelected = selectedUid === node.uid;
      const isDisconnected = !connectedSet.has(node.uid);
      const inputs = bt?.inputs || (node.type === 'mixer' ? 2 : 1);
      const size = tileSizeFor(node);

      if (size.pedal) {
        const inJacksHtml = inputs >= 2
          ? `
            <div class="pb-jack is-in is-port-a" style="top:35%" data-uid="${escapeHtml(node.uid)}" data-dir="in" data-port="0" title="Input A"><span class="pb-jack-lbl">A</span></div>
            <div class="pb-jack is-in is-port-b" style="top:65%" data-uid="${escapeHtml(node.uid)}" data-dir="in" data-port="1" title="Input B"><span class="pb-jack-lbl">B</span></div>
          `
          : `<div class="pb-jack is-in" data-uid="${escapeHtml(node.uid)}" data-dir="in" data-port="0" title="Input jack"></div>`;

        return `
          <div class="pb-tile is-pedal${isEnabled ? '' : ' is-off'}${isSelected ? ' is-selected' : ''}${isDisconnected ? ' is-disconnected' : ''}"
            data-uid="${escapeHtml(node.uid)}" tabindex="0" aria-label="${escapeHtml(name)} tile"
            ${isDisconnected ? 'title="Not connected"' : ''}
            style="left:${node.x * CELL_PX}px;top:${node.y * CELL_PX}px;width:${size.w}px;height:${size.h}px;--cat:${catColor};">
            <div class="pb-pedal-art"></div>
            ${inJacksHtml}
            <div class="pb-jack is-out" data-uid="${escapeHtml(node.uid)}" data-dir="out" data-port="0" title="Output jack"></div>
          </div>
        `;
      }

      const summary = getNodeSummary(node, bt);

      const inJacksHtml = inputs >= 2
        ? `
          <div class="pb-jack is-in is-port-a" data-uid="${escapeHtml(node.uid)}" data-dir="in" data-port="0" title="Input A"><span class="pb-jack-lbl">A</span></div>
          <div class="pb-jack is-in is-port-b" data-uid="${escapeHtml(node.uid)}" data-dir="in" data-port="1" title="Input B"><span class="pb-jack-lbl">B</span></div>
        `
        : `<div class="pb-jack is-in" data-uid="${escapeHtml(node.uid)}" data-dir="in" data-port="0" title="Input jack"></div>`;

      return `
        <div class="pb-tile${isEnabled ? '' : ' is-off'}${isSelected ? ' is-selected' : ''}${isDisconnected ? ' is-disconnected' : ''}"
          data-uid="${escapeHtml(node.uid)}" tabindex="0" aria-label="${escapeHtml(name)} tile"
          ${isDisconnected ? 'title="Not connected"' : ''}
          style="left:${node.x * CELL_PX}px;top:${node.y * CELL_PX}px;--cat:${catColor};">
          <div class="pb-tile-head">
            <button type="button" class="stomp pb-stomp${isEnabled ? ' is-on' : ''}" data-uid="${escapeHtml(node.uid)}"
              aria-label="Toggle ${escapeHtml(name)}" aria-pressed="${isEnabled ? 'true' : 'false'}" title="${isEnabled ? 'Bypass' : 'Enable'}"></button>
            <span class="pb-tile-title" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          </div>
          <div class="pb-tile-summary" data-tile-summary="${escapeHtml(node.uid)}" title="${escapeHtml(summary)}">${escapeHtml(summary)}</div>
          ${inJacksHtml}
          <div class="pb-jack is-out" data-uid="${escapeHtml(node.uid)}" data-dir="out" data-port="0" title="Output jack"></div>
        </div>
      `;
    }).join('');

    const maxBlocks = Number.isFinite(limits.maxBlocks) ? limits.maxBlocks : Infinity;
    const maxNam = Number.isFinite(limits.maxNam) ? limits.maxNam : Infinity;
    const atMaxBlocks = nodes.length >= maxBlocks;
    const namCount = nodes.filter((n) => {
      const t = blockTypeMap.get(n.type);
      return t?.fileKind === 'nam' || n.type === 'nam';
    }).length;
    const atMaxNam = namCount >= maxNam;

    const paletteGroupsHtml = (() => {
      const grouped = new Map();
      for (const [catId, catLabel] of PEDAL_CAT_GROUPS) grouped.set(catId, { label: catLabel, items: [] });
      for (const bt of blockTypes) {
        const catId = bt.category || 'utility';
        if (!grouped.has(catId)) grouped.set(catId, { label: catId.charAt(0).toUpperCase() + catId.slice(1), items: [] });
        grouped.get(catId).items.push(bt);
      }
      return Array.from(grouped.values())
        .filter((g) => g.items.length > 0)
        .map((g) => `
          <div class="pb-palette-group">
            <div class="pb-palette-group-title">${escapeHtml(g.label)}</div>
            ${g.items.map((bt) => {
              const isNam = bt.fileKind === 'nam' || bt.id === 'nam';
              const reason = atMaxBlocks
                ? `Maximum ${maxBlocks} tiles reached`
                : (isNam && atMaxNam ? `Maximum ${maxNam} NAM capture${maxNam === 1 ? '' : 's'} reached` : '');
              const catColor = PEDAL_CAT_COLORS[bt.category] || '#8f8a80';
              return `
                <button type="button" class="pb-palette-item" data-type-id="${escapeHtml(bt.id)}"
                  style="--cat:${catColor};" ${reason ? `disabled title="${escapeHtml(reason)}"` : ''}>
                  <span class="pb-palette-swatch"></span>
                  <span>${escapeHtml(bt.name || bt.id)}</span>
                </button>
              `;
            }).join('')}
          </div>
        `).join('');
    })();

    if (menu?.uid && menu.uid !== 'in' && menu.uid !== 'out' && !nodes.some((n) => n.uid === menu.uid)) menu = null;
    if (menu?.cable && !cables.some((c) => sameCable(c, menu.cable))) menu = null;
    const menuHtml = renderMenu(graph, nodes, blockTypeMap);

    container.innerHTML = `
      <div class="pb-shell${drawerOpen ? ' is-drawer-open' : ''}${presetsHidden ? ' is-presets-hidden' : ''}">
        <aside class="pb-presets" aria-label="Presets">
          <div class="pb-presets-scroll">
            <div class="pb-presets-heading">Presets</div>
            <div class="pb-presets-group">
              ${builtins.map(renderPresetRow).join('')}
            </div>
            <div class="pb-presets-heading pb-presets-subhead">
              <span>My presets</span>
              ${Number.isFinite(maxCustom) ? `<span class="tabular">${customs.length}/${maxCustom}</span>` : ''}
            </div>
            <div class="pb-presets-group">
              ${customs.length > 0 ? customs.map(renderPresetRow).join('') : '<div class="pb-presets-empty">No custom presets yet</div>'}
            </div>
          </div>
          <div class="pb-presets-actions">
            <button type="button" class="btn btn-sm" id="pb-btn-new" ${atMaxCustom ? `disabled title="Maximum ${maxCustom} custom presets reached"` : ''}>New</button>
            <button type="button" class="btn btn-sm" id="pb-btn-import" ${atMaxCustom ? `disabled title="Maximum ${maxCustom} custom presets reached"` : ''}>Import</button>
            <input type="file" id="pb-import-input" accept=".json,application/json" hidden />
          </div>
        </aside>

        <header class="pb-toolbar">
          <div class="pb-toolbar-left">
            <button type="button" class="btn btn-sm pb-presets-toggle" id="pb-toggle-presets" aria-expanded="${drawerOpen || !presetsHidden ? 'true' : 'false'}" title="Show or hide the preset list">Presets</button>
            ${renaming && isCustom ? `
              <input type="text" class="input pb-rename-input" id="pb-rename-input" maxlength="40" value="${escapeHtml(preset.name || '')}" aria-label="Preset name" />
            ` : `
              <h1 class="pb-preset-title">${escapeHtml(preset.name || preset.id)}</h1>
              ${isCustom ? '<button type="button" class="btn btn-sm btn-ghost pb-rename-btn" id="pb-btn-rename" title="Rename preset" aria-label="Rename preset">✎</button>' : ''}
            `}
            <button type="button" class="btn btn-sm btn-primary" id="pb-btn-use" ${isLive ? 'disabled title="Currently active preset"' : ''}>Use this preset</button>
            <button type="button" class="btn btn-sm" id="pb-btn-duplicate" ${atMaxCustom ? `disabled title="Maximum ${maxCustom} custom presets reached"` : ''}>Duplicate</button>
            <button type="button" class="btn btn-sm" id="pb-btn-export">Export</button>
            ${isCustom ? (confirmDeleteOpen ? `
              <span class="pb-confirm-del">
                <span>Delete?</span>
                <button type="button" class="btn btn-sm pb-btn-danger" id="pb-btn-del-confirm">Delete</button>
                <button type="button" class="btn btn-sm btn-ghost" id="pb-btn-del-cancel">Cancel</button>
              </span>
            ` : `
              <button type="button" class="btn btn-sm btn-ghost pb-btn-danger-text" id="pb-btn-delete">Delete</button>
            `) : `
              <button type="button" class="btn btn-sm btn-ghost" id="pb-btn-reset">Reset to default</button>
            `}
          </div>

          <div class="pb-toolbar-right">
            <div class="pb-zoom-group" role="group" aria-label="Board zoom">
              <button type="button" class="btn btn-sm btn-ghost" id="pb-zoom-out" aria-label="Zoom out">−</button>
              <button type="button" class="btn btn-sm btn-ghost tabular" id="pb-zoom-reset" title="Reset zoom to 100%">${Math.round(view.zoom * 100)}%</button>
              <button type="button" class="btn btn-sm btn-ghost" id="pb-zoom-in" aria-label="Zoom in">+</button>
              <button type="button" class="btn btn-sm btn-ghost" id="pb-zoom-fit" title="Show the whole board">Fit</button>
            </div>
            <div class="pb-palette-wrap">
              <button type="button" class="btn btn-sm btn-primary" id="pb-btn-add" aria-expanded="${paletteOpen ? 'true' : 'false'}" ${blockTypes.length === 0 ? 'disabled' : ''}>+ Add tile</button>
              ${paletteOpen ? `
                <div class="pb-palette" id="pb-palette" role="dialog" aria-label="Add tile">
                  <div class="pb-palette-hint">Click to add or drag onto a cable to insert</div>
                  ${paletteGroupsHtml}
                </div>
              ` : ''}
            </div>
          </div>
        </header>

        <div class="pb-viewport" id="pb-viewport">
          <div class="pb-grid" id="pb-grid" aria-hidden="true"></div>
          <div class="pb-world" id="pb-world" style="transform:translate(${view.panX}px, ${view.panY}px) scale(${view.zoom});">
            <svg class="pb-cables-svg" id="pb-cables-svg">
              ${cablesSvgHtml}
              <g id="pb-preview-cable-layer"></g>
            </svg>
            <div class="pb-tiles-layer" id="pb-tiles-layer">
              ${ioTilesHtml}
              ${effectTilesHtml}
            </div>
          </div>
          <div class="pb-hint" aria-hidden="true">Right-click a pedal for its controls · drag empty space or two-finger scroll to move · wheel or pinch to zoom</div>
        </div>

        ${menuHtml}
      </div>
    `;

    bindEvents(preset, graph, nodes, cables, blockTypeMap);
  }

  // Compact controls for one tile or cable, opened by right-click / long-press (replaces the docked inspector).
  function renderMenu(graph, nodes, blockTypeMap) {
    if (!menu) return '';
    const head = (title, extra = '') => `
      <div class="pb-menu-head">
        ${extra}
        <span class="pb-menu-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
        <button type="button" class="btn btn-sm btn-ghost pb-menu-close" id="pb-menu-close" aria-label="Close">×</button>
      </div>`;
    const rangeRow = ({ cls, dataAttrs, valAttr, label, min, max, step, value, shown }) => `
      <label class="pb-mrow">
        <span class="pb-mrow-label">${escapeHtml(label)}</span>
        <input type="range" class="slider pb-mrange ${cls}" ${dataAttrs} min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${escapeHtml(label)}" />
        <span class="pb-mrow-val tabular" ${valAttr}>${escapeHtml(shown)}</span>
      </label>`;
    const wrap = (inner, label, style = '') => `
      <div class="pb-menu" id="pb-menu" role="dialog" aria-label="${escapeHtml(label)}" style="${style}">${inner}</div>`;

    if (menu.cable) {
      const c = menu.cable;
      const nameOf = (uid) => (uid === 'in' ? 'INPUT' : uid === 'out' ? 'OUTPUT'
        : (blockTypeMap.get(nodes.find((n) => n.uid === uid)?.type)?.name || uid));
      const toNode = nodes.find((n) => n.uid === c.to);
      const toBt = toNode ? blockTypeMap.get(toNode.type) : null;
      const isMixer = toNode && (toNode.type === 'mixer' || toBt?.inputs === 2);
      const portLabel = isMixer ? ` (Input ${Number(c.port) === 1 ? 'B' : 'A'})` : '';
      return wrap(`
        ${head('Cable')}
        <div class="pb-menu-body">
          <p class="pb-menu-route"><strong>${escapeHtml(nameOf(c.from))}</strong> → <strong>${escapeHtml(nameOf(c.to) + portLabel)}</strong></p>
        </div>
        <div class="pb-menu-actions">
          <button type="button" class="btn btn-sm pb-btn-danger" id="pb-menu-remove-cable">Remove cable</button>
        </div>`, 'Cable');
    }

    const globalRow = (key, label, min, max, step, value, isGate) => rangeRow({
      cls: 'pb-global-slider',
      dataAttrs: `data-global-key="${key}" data-is-gate="${isGate ? 1 : 0}"`,
      valAttr: `data-pb-global-val="${key}"`,
      label, min, max, step, value,
      shown: formatBoardVal({ unit: 'dB', isGate }, value)
    });

    if (menu.uid === 'in') {
      const trimVal = Number.isFinite(graph.inputTrimDb) ? graph.inputTrimDb : 0;
      const gateVal = Number.isFinite(graph.gateThresholdDb) ? graph.gateThresholdDb : -80;
      return wrap(`
        ${head('INPUT')}
        <div class="pb-menu-body">
          ${globalRow('inputTrimDb', 'Trim', -24, 24, 0.5, trimVal, false)}
          ${globalRow('gateThresholdDb', 'Gate', -80, 0, 1, gateVal, true)}
        </div>`, 'Input');
    }

    if (menu.uid === 'out') {
      const outVal = Number.isFinite(graph.outputLevelDb) ? graph.outputLevelDb : 0;
      return wrap(`
        ${head('OUTPUT')}
        <div class="pb-menu-body">
          ${globalRow('outputLevelDb', 'Level', -60, 24, 0.5, outVal, false)}
        </div>`, 'Output');
    }

    const node = nodes.find((n) => n.uid === menu.uid);
    if (!node) return '';
    const bt = blockTypeMap.get(node.type);
    const name = bt?.name || node.type;
    const catColor = PEDAL_CAT_COLORS[bt?.category] || '#8f8a80';
    const isEnabled = node.enabled !== false;
    const paramSpecs = Array.isArray(bt?.params) ? bt.params : [];
    const fileKind = bt?.fileKind || (node.type === 'cab' ? 'ir' : 'nam');
    const isFileMissing = Boolean(node.file && (node.fileMissing || node.missing || node.fileFound === false));

    const fileRowHtml = (bt?.usesFile || node.file) ? `
      <div class="pb-menu-file">
        <span class="pb-menu-file-name" title="${escapeHtml(node.file || 'No file')}">${escapeHtml(node.file || 'No file')}</span>
        ${isFileMissing ? '<span class="chip pb-missing-badge">missing</span>' : ''}
        <button type="button" class="btn btn-sm" id="pb-menu-browse" data-kind="${escapeHtml(fileKind)}">Load</button>
        ${node.file ? `<button type="button" class="btn btn-sm btn-ghost" id="pb-menu-clear" data-kind="${escapeHtml(fileKind)}">Clear</button>` : ''}
      </div>
    ` : '';

    const paramRows = paramSpecs.map((ps) => {
      const label = ps.label || ps.key;
      if (Array.isArray(ps.options) && ps.options.length > 0) {
        const curIdx = Math.round(Number.isFinite(node.params?.[ps.key]) ? node.params[ps.key] : (Number.isFinite(ps.def) ? ps.def : 0));
        if (ps.options.length <= 3) {
          return `
            <div class="pb-mrow">
              <span class="pb-mrow-label">${escapeHtml(label)}</span>
              <div class="pedal-seg pb-mseg" role="group" aria-label="${escapeHtml(label)}">
                ${ps.options.map((opt, optIdx) => `
                  <button type="button" class="pedal-seg-btn${curIdx === optIdx ? ' is-active' : ''}"
                    data-param-key="${escapeHtml(ps.key)}" data-opt-idx="${optIdx}">${escapeHtml(String(opt))}</button>
                `).join('')}
              </div>
            </div>`;
        }
        return `
          <label class="pb-mrow">
            <span class="pb-mrow-label">${escapeHtml(label)}</span>
            <select class="select pedal-select pb-param-select" data-param-key="${escapeHtml(ps.key)}">
              ${ps.options.map((opt, optIdx) => `<option value="${optIdx}" ${curIdx === optIdx ? 'selected' : ''}>${escapeHtml(String(opt))}</option>`).join('')}
            </select>
          </label>`;
      }
      const min = Number.isFinite(ps.min) ? ps.min : 0;
      const max = Number.isFinite(ps.max) ? ps.max : 10;
      const step = Number.isFinite(ps.step) && ps.step > 0 ? ps.step : 0.01;
      const cur = Number.isFinite(node.params?.[ps.key]) ? node.params[ps.key] : (Number.isFinite(ps.def) ? ps.def : min);
      return rangeRow({
        cls: 'pb-param-slider',
        dataAttrs: `data-param-key="${escapeHtml(ps.key)}" data-unit="${escapeHtml(ps.unit || '')}" data-min="${min}" data-max="${max}" data-step="${step}"`,
        valAttr: `data-pb-param-val="${escapeHtml(ps.key)}"`,
        label, min, max, step, value: cur, shown: formatBoardVal(ps, cur)
      });
    }).join('');

    return wrap(`
      ${head(name, '<span class="pb-menu-swatch"></span>')}
      <div class="pb-menu-body">
        ${fileRowHtml}
        ${paramRows}
      </div>
      <div class="pb-menu-actions">
        <button type="button" class="btn btn-sm${isEnabled ? '' : ' btn-primary'}" id="pb-menu-toggle" aria-pressed="${isEnabled ? 'false' : 'true'}">${isEnabled ? 'Bypass' : 'Turn on'}</button>
        <button type="button" class="btn btn-sm pb-btn-danger" id="pb-menu-remove">Remove</button>
      </div>`, name, `--cat:${catColor};`);
  }

  function bindEvents(preset, graph, nodes, cables, blockTypeMap) {
    const view = getViewState(preset.id);
    const viewport = container.querySelector('#pb-viewport');
    const world = container.querySelector('#pb-world');
    const cablesSvg = container.querySelector('#pb-cables-svg');
    const previewLayer = container.querySelector('#pb-preview-cable-layer');

    const grid = container.querySelector('#pb-grid');
    const zoomBtn = container.querySelector('#pb-zoom-reset');
    let gridCell = 0;
    // Pan/zoom only ever change transforms: the world and the dot grid are their own compositor layers,
    // so moving the board doesn't repaint or re-lay-out anything.
    const applyTransform = () => {
      if (world) world.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
      // Pixel-art canvases only stay crisp when shown near full size; zoomed out they'd alias into moire.
      if (world) world.classList.toggle('pb-zoom-near', view.zoom >= 1.6);
      if (grid) {
        const cell = CELL_PX * view.zoom;
        if (cell !== gridCell) {
          gridCell = cell;
          grid.style.backgroundSize = `${cell}px ${cell}px`;
        }
        const ox = (((view.panX % cell) + cell) % cell) - cell;
        const oy = (((view.panY % cell) + cell) % cell) - cell;
        grid.style.transform = `translate(${ox}px, ${oy}px)`;
      }
      if (zoomBtn) zoomBtn.textContent = `${Math.round(view.zoom * 100)}%`;
    };
    let transformRaf = 0;
    const scheduleTransform = () => {
      if (!transformRaf) transformRaf = requestAnimationFrame(() => { transformRaf = 0; applyTransform(); });
    };
    applyTransform();

    // While the board moves, the pedals' animations hold still (they resume ~180 ms after it stops).
    const setMoving = (on) => {
      if (!viewport || viewport.classList.contains('is-moving') === on) return;
      viewport.classList.toggle('is-moving', on);
      setPedalArtPaused(on);
    };
    const nudgeMoving = () => {
      setMoving(true);
      clearTimeout(movingTimer);
      movingTimer = setTimeout(() => setMoving(false), 180);
    };
    setPedalArtPaused(false);
    const closeMenuQuiet = () => {
      if (!menu) return;
      menu = null;
      container.querySelector('#pb-menu')?.remove();
    };

    // Frame the board. 'all' fits every tile (never above 100%). The first view of a preset keeps pedals at a
    // playable size instead (at least FIT_MIN_ZOOM): a long chain then starts at the input and scrolls sideways.
    const fitView = (mode) => {
      if (!viewport) return false;
      const rect = viewport.getBoundingClientRect();
      const io = getIoCoords(graph);
      const boxes = [
        { x: io.inX * CELL_PX, y: io.inY * CELL_PX, w: TILE_W, h: TILE_H },
        { x: io.outX * CELL_PX, y: io.outY * CELL_PX, w: TILE_W, h: TILE_H },
        ...nodes.map((nd) => {
          const sz = tileSizeFor(nd);
          return { x: (Number(nd.x) || 0) * CELL_PX, y: (Number(nd.y) || 0) * CELL_PX, w: sz.w, h: sz.h };
        })
      ];
      if (!(rect.width > 50 && rect.height > 50)) return false;
      const minX = Math.min(...boxes.map((b) => b.x));
      const minY = Math.min(...boxes.map((b) => b.y));
      const maxX = Math.max(...boxes.map((b) => b.x + b.w));
      const maxY = Math.max(...boxes.map((b) => b.y + b.h));
      const pad = 40;
      const fitAll = Math.min(1, (rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY));
      const zoom = clamp(mode === 'all' ? fitAll : Math.max(fitAll, Math.min(1, FIT_MIN_ZOOM)), ZOOM_MIN, ZOOM_MAX);
      view.zoom = Math.round(zoom * 100) / 100;
      const w = (maxX - minX) * view.zoom;
      const h = (maxY - minY) * view.zoom;
      view.panX = Math.round((w <= rect.width - pad * 2 ? (rect.width - w) / 2 : pad) - minX * view.zoom);
      view.panY = Math.round((h <= rect.height - pad * 2 ? (rect.height - h) / 2 : pad) - minY * view.zoom);
      applyTransform();
      return true;
    };
    if (view.fitPending && fitView('first')) view.fitPending = false;

    const zoomAtPoint = (clientX, clientY, nextZoom) => {
      if (!viewport) return;
      const clamped = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
      if (clamped === view.zoom) return;
      const rect = viewport.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const wx = (px - view.panX) / view.zoom;
      const wy = (py - view.panY) / view.zoom;
      view.panX = px - wx * clamped;
      view.panY = py - wy * clamped;
      view.zoom = clamped;
      scheduleTransform();
    };

    // Sidebar preset switching
    container.querySelectorAll('.pb-preset-row').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.presetId;
        if (!pid) return;
        rememberPreset(pid);
        selectedUid = null;
        selectedCable = null;
        renaming = false;
        confirmDeleteOpen = false;
        paletteOpen = false;
        drawerOpen = false;
        render();
      });
    });

    container.querySelector('#pb-btn-new')?.addEventListener('click', async () => {
      const res = await amp.newPreset('My preset');
      if (res?.id) {
        pendingOpenId = res.id;
        rememberPreset(res.id);
        selectedUid = null;
        selectedCable = null;
        drawerOpen = false;
        render();
      }
    });

    const importInput = container.querySelector('#pb-import-input');
    container.querySelector('#pb-btn-import')?.addEventListener('click', () => {
      importInput?.click();
    });
    importInput?.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== 'object' || obj.format !== 'woodshed-preset' || !Array.isArray(obj.nodes) || !Array.isArray(obj.cables)) {
          toast?.('Invalid preset file (expected woodshed-preset format).', 'error');
          return;
        }
        const res = await amp.importPreset(obj);
        if (res?.id) {
          pendingOpenId = res.id;
          rememberPreset(res.id);
          selectedUid = null;
          selectedCable = null;
          drawerOpen = false;
          toast?.('Preset imported.', 'success');
          render();
        }
      } catch (_) {
        toast?.('Could not read preset JSON file.', 'error');
      }
    });

    // Toolbar actions
    container.querySelector('#pb-toggle-presets')?.addEventListener('click', () => {
      if (window.matchMedia?.('(max-width: 999px)').matches) {
        drawerOpen = !drawerOpen;
      } else {
        // Wide screens: hide the preset column so the board gets the whole width.
        presetsHidden = !presetsHidden;
        try { settings?.set?.('pedalboardPresetsHidden', presetsHidden); } catch (_) { /* optional */ }
      }
      render();
    });

    container.querySelector('#pb-btn-rename')?.addEventListener('click', () => {
      renaming = true;
      render();
      const inp = container.querySelector('#pb-rename-input');
      inp?.focus();
      inp?.select();
    });

    const renameInput = container.querySelector('#pb-rename-input');
    if (renameInput) {
      let committed = false;
      const commitRename = () => {
        if (committed) return;
        committed = true;
        const nextName = renameInput.value.trim().slice(0, 40);
        renaming = false;
        if (nextName && nextName !== preset.name) {
          preset.name = nextName;
          amp.renamePreset(preset.id, nextName);
        }
        render();
      };
      renameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committed = true;
          renaming = false;
          render();
        }
      });
      renameInput.addEventListener('blur', commitRename);
    }

    container.querySelector('#pb-btn-use')?.addEventListener('click', () => {
      amp.setPreset(preset.id);
    });

    container.querySelector('#pb-btn-duplicate')?.addEventListener('click', async () => {
      const res = await amp.duplicatePreset(preset.id);
      if (res?.id) {
        pendingOpenId = res.id;
        rememberPreset(res.id);
        selectedUid = null;
        selectedCable = null;
        render();
      }
    });

    container.querySelector('#pb-btn-export')?.addEventListener('click', async () => {
      const res = await amp.exportPreset(preset.id);
      if (!res?.data) {
        toast?.('Failed to export preset.', 'error');
        return;
      }
      const rawName = res.data.name || preset.name || preset.id;
      const safeName = String(rawName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'preset';
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}.woodshed-preset.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    container.querySelector('#pb-btn-delete')?.addEventListener('click', () => {
      confirmDeleteOpen = true;
      render();
    });
    container.querySelector('#pb-btn-del-cancel')?.addEventListener('click', () => {
      confirmDeleteOpen = false;
      render();
    });
    container.querySelector('#pb-btn-del-confirm')?.addEventListener('click', () => {
      const delId = preset.id;
      const fallbackId = preset.basedOn || getLivePresetId() || '';
      confirmDeleteOpen = false;
      selectedUid = null;
      selectedCable = null;
      amp.deletePreset(delId);
      if (fallbackId && fallbackId !== delId) {
        rememberPreset(fallbackId);
      } else {
        selectedPresetId = '';
      }
      render();
    });

    container.querySelector('#pb-btn-reset')?.addEventListener('click', () => {
      amp.resetPreset(preset.id);
    });

    container.querySelector('#pb-zoom-out')?.addEventListener('click', () => {
      if (!viewport) return;
      const r = viewport.getBoundingClientRect();
      zoomAtPoint(r.left + r.width / 2, r.top + r.height / 2, view.zoom - ZOOM_STEP);
    });
    container.querySelector('#pb-zoom-in')?.addEventListener('click', () => {
      if (!viewport) return;
      const r = viewport.getBoundingClientRect();
      zoomAtPoint(r.left + r.width / 2, r.top + r.height / 2, view.zoom + ZOOM_STEP);
    });
    container.querySelector('#pb-zoom-fit')?.addEventListener('click', () => fitView('all'));
    container.querySelector('#pb-zoom-reset')?.addEventListener('click', () => {
      if (!viewport) return;
      const r = viewport.getBoundingClientRect();
      zoomAtPoint(r.left + r.width / 2, r.top + r.height / 2, 1);
    });

    // Palette button + items (click to place at center, or drag onto board/cable to splice)
    container.querySelector('#pb-btn-add')?.addEventListener('click', (e) => {
      e.stopPropagation();
      paletteOpen = !paletteOpen;
      render();
    });

    const placeNodeAtCenter = async (typeId) => {
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      let gx = Math.round(((rect.width / 2 - view.panX) / view.zoom - TILE_W / 2) / CELL_PX);
      let gy = Math.round(((rect.height / 2 - view.panY) / view.zoom - TILE_H / 2) / CELL_PX);
      const occupied = new Set(nodes.map((n) => `${n.x},${n.y}`));
      while (occupied.has(`${gx},${gy}`)) {
        gx += 2;
        gy += 2;
      }
      paletteOpen = false;
      render();
      const res = await amp.addNode(preset.id, typeId, gx, gy);
      if (res?.uid) {
        selectedUid = res.uid;
        selectedCable = null;
        render();
      }
    };

    container.querySelectorAll('.pb-palette-item:not([disabled])').forEach((item) => {
      item.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const typeId = item.dataset.typeId;
        const bt = blockTypeMap.get(typeId);
        const catColor = PEDAL_CAT_COLORS[bt?.category] || '#8f8a80';
        const label = bt?.name || typeId;
        const startX = e.clientX;
        const startY = e.clientY;
        let dragging = false;
        let ghost = null;
        let spliceTarget = null;
        let rafId = 0;
        let lastX = startX;
        let lastY = startY;

        const clearSpliceHighlight = () => {
          cablesSvg?.querySelectorAll('.pb-cable-group.is-splice-target').forEach((g) => g.classList.remove('is-splice-target'));
        };

        const updateDrag = () => {
          rafId = 0;
          if (!dragging) return;
          if (ghost) {
            ghost.style.transform = `translate(${lastX - TILE_W / 2}px, ${lastY - TILE_H / 2}px)`;
          }
          clearSpliceHighlight();
          spliceTarget = null;
          if (!viewport) return;
          const rect = viewport.getBoundingClientRect();
          if (lastX < rect.left || lastX > rect.right || lastY < rect.top || lastY > rect.bottom) return;

          const wx = (lastX - rect.left - view.panX) / view.zoom;
          const wy = (lastY - rect.top - view.panY) / view.zoom;
          const gx = Math.round((wx - TILE_W / 2) / CELL_PX);
          const gy = Math.round((wy - TILE_H / 2) / CELL_PX);
          const cx = gx * CELL_PX + TILE_W / 2;
          const cy = gy * CELL_PX + TILE_H / 2;

          let bestDistSq = 12 * 12;
          let bestIdx = -1;
          cables.forEach((c, idx) => {
            const pStart = getJackPos(graph, blockTypeMap, c.from, 'out', 0);
            const pEnd = getJackPos(graph, blockTypeMap, c.to, 'in', c.port || 0);
            if (!pStart || !pEnd) return;
            const bez = bezierPathData(pStart.x, pStart.y, pEnd.x, pEnd.y);
            const d2 = Math.min(distToBezierSq(wx, wy, bez), distToBezierSq(cx, cy, bez));
            if (d2 <= bestDistSq) {
              bestDistSq = d2;
              bestIdx = idx;
              spliceTarget = c;
            }
          });
          if (bestIdx >= 0) {
            cablesSvg?.querySelector(`.pb-cable-group[data-cable-idx="${bestIdx}"]`)?.classList.add('is-splice-target');
          }
        };

        const onMove = (ev) => {
          lastX = ev.clientX;
          lastY = ev.clientY;
          if (!dragging && Math.hypot(lastX - startX, lastY - startY) > 5) {
            dragging = true;
            ghost = document.createElement('div');
            ghost.className = 'pb-drag-ghost';
            ghost.style.setProperty('--cat', catColor);
            ghost.textContent = label;
            document.body.appendChild(ghost);
          }
          if (dragging && !rafId) {
            rafId = requestAnimationFrame(updateDrag);
          }
        };

        const onUp = async (ev) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          if (rafId) cancelAnimationFrame(rafId);
          clearSpliceHighlight();
          if (ghost) ghost.remove();

          if (!dragging) {
            await placeNodeAtCenter(typeId);
            return;
          }

          paletteOpen = false;
          if (!viewport) {
            render();
            return;
          }
          const rect = viewport.getBoundingClientRect();
          if (ev.clientX < rect.left || ev.clientX > rect.right || ev.clientY < rect.top || ev.clientY > rect.bottom) {
            render();
            return;
          }
          const wx = (ev.clientX - rect.left - view.panX) / view.zoom;
          const wy = (ev.clientY - rect.top - view.panY) / view.zoom;
          const gx = Math.round((wx - TILE_W / 2) / CELL_PX);
          const gy = Math.round((wy - TILE_H / 2) / CELL_PX);
          const splice = spliceTarget
            ? { from: spliceTarget.from, to: spliceTarget.to, port: Number(spliceTarget.port) || 0 }
            : undefined;
          render();
          const res = await amp.addNode(preset.id, typeId, gx, gy, splice);
          if (res?.uid) {
            selectedUid = res.uid;
            selectedCable = null;
            render();
          }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    });

    // Cable click & delete
    cablesSvg?.querySelectorAll('.pb-cable-group').forEach((grp) => {
      const idx = Number(grp.dataset.cableIdx);
      const cable = cables[idx];
      if (!cable) return;

      grp.querySelector('.pb-cable-hit')?.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedCable = { from: cable.from, to: cable.to, port: Number(cable.port) || 0 };
        selectedUid = null;
        paletteOpen = false;
        menu = null;
        render();
      });

      grp.querySelector('.pb-cable-hit')?.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectedCable = { from: cable.from, to: cable.to, port: Number(cable.port) || 0 };
        selectedUid = null;
        paletteOpen = false;
        menu = { cable: selectedCable, x: e.clientX, y: e.clientY };
        render();
      });

      grp.querySelector('.pb-cable-del')?.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedCable = null;
        amp.removeCable(preset.id, cable.from, cable.to, Number(cable.port) || 0);
        render();
      });
    });

    // Stomp LED toggles on tiles
    container.querySelectorAll('.pb-stomp').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const uid = btn.dataset.uid;
        const node = nodes.find((n) => n.uid === uid);
        if (!node) return;
        const nextOn = node.enabled === false;
        node.enabled = nextOn;
        amp.setBlockEnabled(preset.id, uid, nextOn);
        render();
      });
    });

    // Jack cable dragging
    container.querySelectorAll('.pb-jack.is-out').forEach((jack) => {
      jack.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const fromUid = jack.dataset.uid;
        const limits = amp.presets?.limits || {};
        const maxCables = Number.isFinite(limits.maxCables) ? limits.maxCables : Infinity;

        // Highlight valid target input jacks
        const validJacks = [];
        container.querySelectorAll('.pb-jack.is-in').forEach((inJack) => {
          const toUid = inJack.dataset.uid;
          const port = Number(inJack.dataset.port) || 0;
          const isDup = cables.some((c) => c.from === fromUid && c.to === toUid && (Number(c.port) || 0) === port);
          if (fromUid !== toUid && toUid !== 'in' && !isDup && !wouldCreateCycle(cables, fromUid, toUid)) {
            inJack.classList.add('is-valid-target');
            validJacks.push(inJack);
          }
        });

        const pStart = getJackPos(graph, blockTypeMap, fromUid, 'out', 0);
        if (!pStart || !previewLayer || !viewport) return;

        let curClientX = e.clientX;
        let curClientY = e.clientY;
        let hoveredJack = null;
        let rafId = 0;

        const updatePreview = () => {
          rafId = 0;
          const rect = viewport.getBoundingClientRect();
          let endX = (curClientX - rect.left - view.panX) / view.zoom;
          let endY = (curClientY - rect.top - view.panY) / view.zoom;

          validJacks.forEach((j) => j.classList.remove('is-snap-target'));
          hoveredJack = null;

          const hitEl = document.elementFromPoint(curClientX, curClientY)?.closest('.pb-jack.is-in');
          if (hitEl) {
            hoveredJack = hitEl;
            if (hitEl.classList.contains('is-valid-target')) {
              hitEl.classList.add('is-snap-target');
              const snapPos = getJackPos(graph, blockTypeMap, hitEl.dataset.uid, 'in', Number(hitEl.dataset.port) || 0);
              if (snapPos) {
                endX = snapPos.x;
                endY = snapPos.y;
              }
            }
          }

          const bez = bezierPathData(pStart.x, pStart.y, endX, endY);
          previewLayer.innerHTML = `<path class="pb-cable-preview" d="${bez.d}" />`;
        };

        rafId = requestAnimationFrame(updatePreview);

        const onMove = (ev) => {
          curClientX = ev.clientX;
          curClientY = ev.clientY;
          if (!rafId) rafId = requestAnimationFrame(updatePreview);
        };

        const onUp = (ev) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          if (rafId) cancelAnimationFrame(rafId);
          validJacks.forEach((j) => j.classList.remove('is-valid-target', 'is-snap-target'));
          if (previewLayer) previewLayer.innerHTML = '';

          const dropJack = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.pb-jack');
          if (!dropJack) return;

          if (dropJack.dataset.dir === 'out') {
            toast?.('Connect an output jack (right) to an input jack (left).', 'info');
            return;
          }

          const toUid = dropJack.dataset.uid;
          const port = Number(dropJack.dataset.port) || 0;

          if (fromUid === toUid) {
            toast?.('Cannot connect a tile to itself.', 'error');
            return;
          }
          if (toUid === 'in') {
            toast?.('Cannot connect into the Input tile.', 'error');
            return;
          }
          if (fromUid === 'out') {
            toast?.('Cannot connect out of the Output tile.', 'error');
            return;
          }
          if (cables.some((c) => c.from === fromUid && c.to === toUid && (Number(c.port) || 0) === port)) {
            toast?.('Those jacks are already connected.', 'error');
            return;
          }
          if (wouldCreateCycle(cables, fromUid, toUid)) {
            toast?.('That connection would create a feedback loop.', 'error');
            return;
          }
          if (cables.length >= maxCables) {
            toast?.(`Maximum ${maxCables} cables reached.`, 'error');
            return;
          }

          amp.addCable(preset.id, fromUid, toUid, port);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    });

    // Opens the tile menu next to a point (or next to the tile when opened from the keyboard).
    const openTileMenu = (uid, clientX, clientY) => {
      const tileEl = container.querySelector(`.pb-tile[data-uid="${CSS.escape(uid)}"]`);
      if ((!clientX && !clientY) && tileEl) {
        const r = tileEl.getBoundingClientRect();
        clientX = r.right;
        clientY = r.top;
      }
      selectedUid = uid;
      selectedCable = null;
      paletteOpen = false;
      menu = { uid, x: clientX, y: clientY };
      render();
    };

    // Tile dragging, click-select, right-click / long-press menu
    container.querySelectorAll('.pb-tile').forEach((tileEl) => {
      const uid = tileEl.dataset.uid;

      tileEl.addEventListener('keydown', (e) => {
        if (e.target !== tileEl) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openTileMenu(uid, 0, 0);
        }
      });

      tileEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTileMenu(uid, e.clientX, e.clientY);
      });

      tileEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.pb-jack') || e.target.closest('.pb-stomp') || e.target.closest('.pa [role="slider"], .pa [role="button"]')) return;
        e.stopPropagation();

        const io = getIoCoords(graph);
        const node = uid !== 'in' && uid !== 'out' ? nodes.find((n) => n.uid === uid) : null;
        const origX = uid === 'in' ? io.inX : uid === 'out' ? io.outX : (node?.x ?? 0);
        const origY = uid === 'in' ? io.inY : uid === 'out' ? io.outY : (node?.y ?? 0);

        const startX = e.clientX;
        const startY = e.clientY;
        let curX = origX;
        let curY = origY;
        let moved = false;
        let rafId = 0;
        // Holding still on a tile opens its menu (touch screens have no right-click).
        let longPressTimer = setTimeout(() => {
          longPressTimer = 0;
          if (moved) return;
          stop();
          openTileMenu(uid, startX, startY);
        }, LONG_PRESS_MS);

        // Pre-bind attached cable DOM elements for direct RAF updates without re-rendering
        const attachedCables = [];
        cables.forEach((c, idx) => {
          if (c.from === uid || c.to === uid) {
            const grp = cablesSvg?.querySelector(`.pb-cable-group[data-cable-idx="${idx}"]`);
            if (grp) {
              attachedCables.push({
                cable: c,
                hit: grp.querySelector('.pb-cable-hit'),
                line: grp.querySelector('.pb-cable-line'),
                del: grp.querySelector('.pb-cable-del')
              });
            }
          }
        });

        const applyPos = () => {
          rafId = 0;
          tileEl.style.left = `${curX * CELL_PX}px`;
          tileEl.style.top = `${curY * CELL_PX}px`;
          if (uid === 'in') {
            graph.io = { ...io, inX: curX, inY: curY };
          } else if (uid === 'out') {
            graph.io = { ...io, outX: curX, outY: curY };
          } else if (node) {
            node.x = curX;
            node.y = curY;
          }
          for (const item of attachedCables) {
            const pStart = getJackPos(graph, blockTypeMap, item.cable.from, 'out', 0);
            const pEnd = getJackPos(graph, blockTypeMap, item.cable.to, 'in', item.cable.port || 0);
            if (!pStart || !pEnd) continue;
            const bez = bezierPathData(pStart.x, pStart.y, pEnd.x, pEnd.y);
            item.hit?.setAttribute('d', bez.d);
            item.line?.setAttribute('d', bez.d);
            item.del?.setAttribute('transform', `translate(${bez.midX}, ${bez.midY})`);
          }
        };

        const onMove = (ev) => {
          if (longPressTimer && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) {
            clearTimeout(longPressTimer);
            longPressTimer = 0;
          }
          const dxCells = Math.round((ev.clientX - startX) / (CELL_PX * view.zoom));
          const dyCells = Math.round((ev.clientY - startY) / (CELL_PX * view.zoom));
          const nextX = origX + dxCells;
          const nextY = origY + dyCells;
          if (nextX !== curX || nextY !== curY) {
            moved = true;
            if (menu) closeMenuQuiet();
            curX = nextX;
            curY = nextY;
            if (!rafId) rafId = requestAnimationFrame(applyPos);
          }
        };

        const stop = () => {
          clearTimeout(longPressTimer);
          longPressTimer = 0;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', stop);
        };

        const onUp = () => {
          stop();
          if (rafId) {
            cancelAnimationFrame(rafId);
            applyPos();
          }
          if (moved) {
            amp.moveNode(preset.id, uid, curX, curY);
          } else if (selectedUid !== uid || menu) {
            selectedUid = uid;
            selectedCable = null;
            paletteOpen = false;
            menu = null;
            render();
            container.querySelector(`.pb-tile[data-uid="${CSS.escape(uid)}"]`)?.focus({ preventScroll: true });
          }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', stop);
      });
    });

    // Right-click on empty board: no browser menu, just close ours.
    viewport?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (menu) {
        menu = null;
        render();
      }
    });

    // Pan: drag empty board (left button) or drag anywhere with the middle button.
    viewport?.addEventListener('pointerdown', (e) => {
      const isMiddle = e.button === 1;
      const isEmptyLeft = e.button === 0 && !e.target.closest('.pb-tile') && !e.target.closest('.pb-cable-group');
      if (!isMiddle && !isEmptyLeft) return;
      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const origPanX = view.panX;
      const origPanY = view.panY;
      let panned = false;

      viewport.classList.add('is-panning');

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!panned && Math.hypot(dx, dy) > 3) {
          panned = true;
          closeMenuQuiet();
          clearTimeout(movingTimer);
          setMoving(true);
        }
        if (panned) {
          view.panX = origPanX + dx;
          view.panY = origPanY + dy;
          scheduleTransform();
        }
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        viewport.classList.remove('is-panning');
        if (panned) nudgeMoving();
        if (!panned && isEmptyLeft) {
          if (selectedUid || selectedCable || paletteOpen || confirmDeleteOpen || menu) {
            selectedUid = null;
            selectedCable = null;
            paletteOpen = false;
            confirmDeleteOpen = false;
            menu = null;
            render();
          }
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });

    // Wheel anywhere over the board (pedals included; a focused knob takes plain wheel turns itself):
    //   ctrl/cmd + wheel, trackpad pinch  -> zoom at the pointer
    //   mouse wheel                        -> zoom at the pointer
    //   trackpad two-finger scroll         -> pan (shift + mouse wheel pans too)
    viewport?.addEventListener('wheel', (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (viewport.clientHeight || 600) : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (!dx && !dy) return;
      closeMenuQuiet();
      nudgeMoving();
      const zoomBy = (d) => zoomAtPoint(e.clientX, e.clientY, view.zoom * wheelZoomFactor(d));
      if (e.ctrlKey || e.metaKey) {
        zoomBy(dy);
        viewport.dataset.wheel = 'pinch';
        return;
      }
      const kind = classifyWheel(e, performance.now());
      viewport.dataset.wheel = kind;
      if (kind === 'trackpad' || e.shiftKey) {
        view.panX -= e.shiftKey && !dx ? dy : dx;
        view.panY -= e.shiftKey && !dx ? 0 : dy;
        scheduleTransform();
      } else {
        zoomBy(dy);
      }
    }, { passive: false });

    // Tile menu: place it next to where it was opened, kept inside the page.
    const menuEl = container.querySelector('#pb-menu');
    const shellEl = container.querySelector('.pb-shell');
    if (menuEl && shellEl && menu) {
      const sr = shellEl.getBoundingClientRect();
      const mw = menuEl.offsetWidth;
      const mh = menuEl.offsetHeight;
      let left = menu.x - sr.left + 10;
      let top = menu.y - sr.top - 12;
      if (left + mw > sr.width - 8) left = menu.x - sr.left - mw - 10;
      left = clamp(left, 8, Math.max(8, sr.width - mw - 8));
      top = clamp(top, 8, Math.max(8, sr.height - mh - 8));
      menuEl.style.left = `${Math.round(left)}px`;
      menuEl.style.top = `${Math.round(top)}px`;
    }
    const menuUid = menu?.uid || null;
    const menuNode = menuUid ? nodes.find((n) => n.uid === menuUid) : null;
    const artFor = (uid) => artCache.get(artKey(preset.id, uid));

    container.querySelector('#pb-menu-close')?.addEventListener('click', () => {
      menu = null;
      render();
    });

    container.querySelector('#pb-menu-remove-cable')?.addEventListener('click', () => {
      const c = menu?.cable;
      if (!c) return;
      menu = null;
      selectedCable = null;
      amp.removeCable(preset.id, c.from, c.to, c.port || 0);
      render();
    });

    container.querySelector('#pb-menu-toggle')?.addEventListener('click', () => {
      if (!menuNode) return;
      const nextOn = menuNode.enabled === false;
      menuNode.enabled = nextOn;
      amp.setBlockEnabled(preset.id, menuNode.uid, nextOn);
      render();
    });

    container.querySelector('#pb-menu-browse')?.addEventListener('click', (e) => {
      if (!menuNode) return;
      amp.browse(preset.id, e.currentTarget.dataset.kind, menuNode.uid);
    });

    container.querySelector('#pb-menu-clear')?.addEventListener('click', (e) => {
      if (!menuNode) return;
      amp.clearFile(preset.id, e.currentTarget.dataset.kind, menuNode.uid);
    });

    container.querySelector('#pb-menu-remove')?.addEventListener('click', () => {
      if (!menuNode) return;
      const uid = menuNode.uid;
      menu = null;
      if (selectedUid === uid) selectedUid = null;
      amp.removeNode(preset.id, uid, true);
      render();
    });

    const scheduleFaderSend = (key, fn) => {
      const existing = faderRafs.get(key);
      if (existing) {
        existing.fn = fn;
        return;
      }
      const entry = {
        fn,
        id: requestAnimationFrame(() => {
          faderRafs.delete(key);
          entry.fn();
        })
      };
      faderRafs.set(key, entry);
    };

    container.querySelectorAll('.pb-global-slider').forEach((slider) => {
      const key = slider.dataset.globalKey;
      const spec = { unit: 'dB', isGate: slider.dataset.isGate === '1' };
      const valEl = container.querySelector(`[data-pb-global-val="${key}"]`);
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        graph[key] = v;
        if (valEl) valEl.textContent = formatBoardVal(spec, v);
        // Update I/O tile summary live
        const tileUid = key === 'outputLevelDb' ? 'out' : 'in';
        const tileSumEl = container.querySelector(`.pb-tile[data-uid="${tileUid}"] .pb-tile-summary`);
        if (tileSumEl) {
          tileSumEl.textContent = key === 'outputLevelDb'
            ? `Level ${formatBoardVal({ unit: 'dB' }, graph.outputLevelDb ?? 0)}`
            : `Trim ${formatBoardVal({ unit: 'dB' }, graph.inputTrimDb ?? 0)}`;
        }
        scheduleFaderSend(`global:${preset.id}:${key}`, () => amp.setBoardGlobal(preset.id, key, v));
      });
    });

    const refreshSummary = (node) => {
      const tileSumEl = container.querySelector(`[data-tile-summary="${CSS.escape(node.uid)}"]`);
      if (!tileSumEl) return;
      const sum = getNodeSummary(node, blockTypeMap.get(node.type));
      tileSumEl.textContent = sum;
      tileSumEl.title = sum;
    };
    const setParamFromMenu = (node, key, v) => {
      if (!node.params) node.params = {};
      node.params[key] = v;
      const entry = artFor(node.uid);
      if (entry) {
        entry.last[key] = v;
        entry.ctl.set(key, v);
      }
      refreshSummary(node);
    };

    if (menuNode) {
      container.querySelectorAll('#pb-menu .pb-param-slider').forEach((slider) => {
        const key = slider.dataset.paramKey;
        const spec = {
          key,
          unit: slider.dataset.unit || '',
          min: parseFloat(slider.dataset.min),
          max: parseFloat(slider.dataset.max),
          step: parseFloat(slider.dataset.step)
        };
        const valEl = container.querySelector(`#pb-menu [data-pb-param-val="${CSS.escape(key)}"]`);
        slider.addEventListener('input', () => {
          const v = parseFloat(slider.value);
          setParamFromMenu(menuNode, key, v);
          if (valEl) valEl.textContent = formatBoardVal(spec, v);
          scheduleFaderSend(`param:${preset.id}:${menuNode.uid}:${key}`, () => amp.setBlockParam(preset.id, menuNode.uid, key, v));
        });
      });

      container.querySelectorAll('#pb-menu .pedal-seg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.paramKey;
          const val = Number(btn.dataset.optIdx);
          setParamFromMenu(menuNode, key, val);
          btn.closest('.pedal-seg')?.querySelectorAll('.pedal-seg-btn').forEach((b) => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          amp.setBlockParam(preset.id, menuNode.uid, key, val);
        });
      });

      container.querySelectorAll('#pb-menu .pb-param-select').forEach((sel) => {
        sel.addEventListener('change', () => {
          const key = sel.dataset.paramKey;
          const val = Number(sel.value);
          setParamFromMenu(menuNode, key, val);
          amp.setBlockParam(preset.id, menuNode.uid, key, val);
        });
      });
    }

    // Pedal art: reuse what's already mounted (same preset, tile and type), mount the rest, drop the leftovers.
    const seenArt = new Set();
    container.querySelectorAll('.pb-tile.is-pedal').forEach((tileEl) => {
      const uid = tileEl.dataset.uid;
      const node = nodes.find((n) => n.uid === uid);
      const slot = tileEl.querySelector('.pb-pedal-art');
      if (!node || !slot) return;
      const key = artKey(preset.id, uid);
      seenArt.add(key);
      const bt = blockTypeMap.get(node.type);
      const specs = bt?.params || [];
      let entry = artCache.get(key);
      if (entry && entry.type !== node.type) {
        entry.ctl.destroy();
        artCache.delete(key);
        entry = null;
      }
      if (entry) {
        slot.replaceWith(entry.el);
        entry.node = node;
        entry.ctl.setEnabled(node.enabled !== false);
        for (const ps of specs) {
          const v = node.params?.[ps.key];
          if (Number.isFinite(v) && v !== entry.last[ps.key]) {
            entry.last[ps.key] = v;
            entry.ctl.set(ps.key, v);
          }
        }
        return;
      }
      slot.innerHTML = pedalArtHtml(node.type);
      const root = slot.querySelector('.pa');
      if (!root) return;
      const created = { type: node.type, el: slot, node, last: { ...(node.params || {}) }, ctl: null };
      created.ctl = mountPedalArt(root, {
        type: node.type,
        specs,
        params: node.params || {},
        enabled: node.enabled !== false,
        scale: tileSizeFor(node).k,
        onParam(pkey, value) {
          const cur = created.node;
          if (!cur.params) cur.params = {};
          cur.params[pkey] = value;
          created.last[pkey] = value;
          if (menu?.uid === cur.uid) {
            const slider = container.querySelector(`#pb-menu .pb-param-slider[data-param-key="${CSS.escape(pkey)}"]`);
            if (slider) {
              slider.value = String(value);
              const valEl = container.querySelector(`#pb-menu [data-pb-param-val="${CSS.escape(pkey)}"]`);
              const spec = blockTypeMap.get(cur.type)?.params?.find((p) => p.key === pkey);
              if (valEl && spec) valEl.textContent = formatBoardVal(spec, value);
            }
          }
          scheduleFaderSend(`param:${preset.id}:${cur.uid}:${pkey}`, () => amp.setBlockParam(preset.id, cur.uid, pkey, value));
        },
        onToggle() {
          const cur = created.node;
          const nextOn = cur.enabled === false;
          cur.enabled = nextOn;
          amp.setBlockEnabled(preset.id, cur.uid, nextOn);
          render();
        }
      });
      artCache.set(key, created);
    });
    for (const [key, entry] of artCache) {
      if (!seenArt.has(key)) {
        entry.ctl.destroy();
        artCache.delete(key);
      }
    }
  }

  // Document-level click to close popovers
  const onDocClick = (e) => {
    let changed = false;
    if (paletteOpen && !e.target.closest('.pb-palette-wrap')) {
      paletteOpen = false;
      changed = true;
    }
    // Clicks on the board are handled by the board itself; anywhere else outside the menu closes it.
    if (menu && e.target.isConnected && !e.target.closest('.pb-menu') && !e.target.closest('.pb-viewport')) {
      menu = null;
      changed = true;
    }
    if (changed) render();
  };

  // Global keyboard shortcuts (ignored while typing in form controls)
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && menu) {
      menu = null;
      render();
      return;
    }
    if (e.defaultPrevented) return;   // a focused pedal knob already used the key
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (amp.state !== 'online') return;
    const presetList = getPresetList();
    const preset = resolveSelectedPreset(presetList);
    if (!preset || !preset.graph) return;

    if (e.key === 'Escape') {
      if (paletteOpen || confirmDeleteOpen || drawerOpen || selectedUid || selectedCable) {
        paletteOpen = false;
        confirmDeleteOpen = false;
        drawerOpen = false;
        selectedUid = null;
        selectedCable = null;
        render();
      }
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedCable) {
        e.preventDefault();
        const c = selectedCable;
        selectedCable = null;
        amp.removeCable(preset.id, c.from, c.to, c.port || 0);
        render();
      } else if (selectedUid && selectedUid !== 'in' && selectedUid !== 'out') {
        e.preventDefault();
        const uid = selectedUid;
        selectedUid = null;
        amp.removeNode(preset.id, uid, true);
        render();
      }
      return;
    }

    const arrowMap = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    };
    if (arrowMap[e.key] && selectedUid) {
      e.preventDefault();
      const [dx, dy] = arrowMap[e.key];
      const graph = preset.graph;
      const io = getIoCoords(graph);
      let nextX;
      let nextY;
      if (selectedUid === 'in') {
        nextX = io.inX + dx;
        nextY = io.inY + dy;
        graph.io = { ...io, inX: nextX, inY: nextY };
      } else if (selectedUid === 'out') {
        nextX = io.outX + dx;
        nextY = io.outY + dy;
        graph.io = { ...io, outX: nextX, outY: nextY };
      } else {
        const node = (graph.nodes || []).find((n) => n.uid === selectedUid);
        if (!node) return;
        nextX = node.x + dx;
        nextY = node.y + dy;
        node.x = nextX;
        node.y = nextY;
      }
      amp.moveNode(preset.id, selectedUid, nextX, nextY);
      render();
      container.querySelector(`.pb-tile[data-uid="${CSS.escape(selectedUid)}"]`)?.focus();
    }
  };

  const onHashChange = () => {
    const pid = parsePresetFromHash();
    if (pid) {
      pendingUrlPreset = pid;
      render();
    }
  };

  const onAmpError = (e) => {
    if (e.detail?.message) {
      toast?.(e.detail.message, 'error');
    }
  };

  let lastLiveId = null;
  const onStatus = () => { const id = getLivePresetId(); if (id !== lastLiveId) { lastLiveId = id; render(); } };

  document.addEventListener('click', onDocClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('hashchange', onHashChange);
  amp.addEventListener('state', render);
  amp.addEventListener('presets', render);
  amp.addEventListener('status', onStatus);
  amp.addEventListener('error', onAmpError);

  render();

  return {
    unmount() {
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('hashchange', onHashChange);
      amp.removeEventListener('state', render);
      amp.removeEventListener('presets', render);
      amp.removeEventListener('status', onStatus);
      amp.removeEventListener('error', onAmpError);
      for (const entry of faderRafs.values()) {
        cancelAnimationFrame(entry.id);
      }
      faderRafs.clear();
      clearTimeout(movingTimer);
      setPedalArtPaused(false);
      for (const entry of artCache.values()) entry.ctl.destroy();
      artCache.clear();
    }
  };
}
