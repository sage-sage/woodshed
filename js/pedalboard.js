import { isDesktop, desktop, postToHost } from './desktop.js';
import { hasPedalArt, pedalSize, pedalArtHtml, mountPedalArt } from './pedal-art.js';

const CELL_PX = 36;
const TILE_W = 140;
const TILE_H = 80;
const PEDAL_SCALE = 0.5;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;

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
  const boardArt = new Map();

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
    // Half size, but tall pedals shrink a little more so they fit between rows (the amp spaces rows 6 cells apart).
    const k = s ? Math.min(PEDAL_SCALE, 200 / s.h) : 1;
    return s
      ? { w: Math.round(s.w * k), h: Math.round(s.h * k), pedal: true }
      : { w: TILE_W, h: TILE_H, pedal: false };
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
      const py = pedal ? (Number(port) === 1 ? h * 0.65 : h * 0.35) : (Number(port) === 1 ? 56 : 24);
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
            <div class="pb-pedal-art">${pedalArtHtml(node.type)}</div>
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

    const inspectorHtml = renderInspector(preset, graph, nodes, blockTypeMap);
    const hasInspectorOpen = Boolean(selectedUid || selectedCable);

    container.innerHTML = `
      <div class="pb-shell${drawerOpen ? ' is-drawer-open' : ''}${hasInspectorOpen ? ' has-selection' : ''}">
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
            <button type="button" class="btn btn-sm pb-presets-toggle" id="pb-toggle-presets" aria-expanded="${drawerOpen ? 'true' : 'false'}">Presets</button>
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

        <div class="pb-viewport" id="pb-viewport"
          style="background-size:${CELL_PX * view.zoom}px ${CELL_PX * view.zoom}px;background-position:${view.panX}px ${view.panY}px;">
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
        </div>

        <aside class="pb-inspector" id="pb-inspector" aria-label="Tile inspector">
          ${inspectorHtml}
        </aside>
      </div>
    `;

    bindEvents(preset, graph, nodes, cables, blockTypeMap);
  }

  function renderInspector(preset, graph, nodes, blockTypeMap) {
    if (selectedCable) {
      const fromName = selectedCable.from === 'in'
        ? 'INPUT'
        : (blockTypeMap.get(nodes.find((n) => n.uid === selectedCable.from)?.type)?.name || selectedCable.from);
      const toNode = nodes.find((n) => n.uid === selectedCable.to);
      const toName = selectedCable.to === 'out'
        ? 'OUTPUT'
        : (blockTypeMap.get(toNode?.type)?.name || selectedCable.to);
      const toBt = toNode ? blockTypeMap.get(toNode.type) : null;
      const isMixer = toNode && (toNode.type === 'mixer' || toBt?.inputs === 2);
      const portLabel = isMixer ? ` (Input ${Number(selectedCable.port) === 1 ? 'B' : 'A'})` : '';

      return `
        <div class="pb-insp-head">
          <span class="pb-insp-title">Cable</span>
          <button type="button" class="btn btn-sm btn-ghost pb-insp-close" id="pb-insp-close" aria-label="Close inspector">×</button>
        </div>
        <div class="pb-insp-body">
          <p class="pb-insp-cable-route"><strong>${escapeHtml(fromName)}</strong> → <strong>${escapeHtml(toName)}${escapeHtml(portLabel)}</strong></p>
          <button type="button" class="btn btn-sm pb-btn-danger" id="pb-insp-remove-cable">Remove cable</button>
        </div>
      `;
    }

    if (selectedUid === 'in') {
      const trimVal = Number.isFinite(graph.inputTrimDb) ? graph.inputTrimDb : 0;
      const gateVal = Number.isFinite(graph.gateThresholdDb) ? graph.gateThresholdDb : -80;
      return `
        <div class="pb-insp-head">
          <span class="pb-insp-title">INPUT</span>
          <button type="button" class="btn btn-sm btn-ghost pb-insp-close" id="pb-insp-close" aria-label="Close inspector">×</button>
        </div>
        <div class="pb-insp-body">
          <div class="pedal-faders">
            <label class="fader">
              <span class="fader-val tabular" data-pb-global-val="inputTrimDb">${escapeHtml(formatBoardVal({ unit: 'dB' }, trimVal))}</span>
              <span class="fader-slot">
                <input type="range" class="fader-input pb-global-slider" data-global-key="inputTrimDb" data-is-gate="0"
                  min="-24" max="24" step="0.5" value="${trimVal}" aria-label="Trim" />
              </span>
              <span class="fader-label">Trim</span>
            </label>
            <label class="fader">
              <span class="fader-val tabular" data-pb-global-val="gateThresholdDb">${escapeHtml(formatBoardVal({ unit: 'dB', isGate: true }, gateVal))}</span>
              <span class="fader-slot">
                <input type="range" class="fader-input pb-global-slider" data-global-key="gateThresholdDb" data-is-gate="1"
                  min="-80" max="0" step="1" value="${gateVal}" aria-label="Gate" />
              </span>
              <span class="fader-label">Gate</span>
            </label>
          </div>
        </div>
      `;
    }

    if (selectedUid === 'out') {
      const outVal = Number.isFinite(graph.outputLevelDb) ? graph.outputLevelDb : 0;
      return `
        <div class="pb-insp-head">
          <span class="pb-insp-title">OUTPUT</span>
          <button type="button" class="btn btn-sm btn-ghost pb-insp-close" id="pb-insp-close" aria-label="Close inspector">×</button>
        </div>
        <div class="pb-insp-body">
          <div class="pedal-faders">
            <label class="fader">
              <span class="fader-val tabular" data-pb-global-val="outputLevelDb">${escapeHtml(formatBoardVal({ unit: 'dB' }, outVal))}</span>
              <span class="fader-slot">
                <input type="range" class="fader-input pb-global-slider" data-global-key="outputLevelDb" data-is-gate="0"
                  min="-60" max="24" step="0.5" value="${outVal}" aria-label="Level" />
              </span>
              <span class="fader-label">Level</span>
            </label>
          </div>
        </div>
      `;
    }

    const node = selectedUid ? nodes.find((n) => n.uid === selectedUid) : null;
    if (!node) {
      return `
        <div class="pb-insp-head">
          <span class="pb-insp-title">Inspector</span>
        </div>
        <div class="pb-insp-body">
          <p class="pb-insp-help">Drag from a tile's right jack to another tile's left jack to connect. Click a cable to select it, Delete removes it. Drop a tile on a cable to insert it.</p>
        </div>
      `;
    }

    const bt = blockTypeMap.get(node.type);
    const name = bt?.name || node.type;
    const catColor = PEDAL_CAT_COLORS[bt?.category] || '#8f8a80';
    const isEnabled = node.enabled !== false;
    const paramSpecs = Array.isArray(bt?.params) ? bt.params : [];
    const continuousSpecs = paramSpecs.filter((ps) => !(Array.isArray(ps.options) && ps.options.length > 0));
    const optionSpecs = paramSpecs.filter((ps) => Array.isArray(ps.options) && ps.options.length > 0);
    const fileKind = bt?.fileKind || (node.type === 'cab' ? 'ir' : 'nam');
    const isFileMissing = Boolean(node.file && (node.fileMissing || node.missing || node.fileFound === false));

    const fileRowHtml = (bt?.usesFile || node.file) ? `
      <div class="pb-insp-file">
        <div class="pb-insp-file-top">
          <span class="pb-insp-file-name" title="${escapeHtml(node.file || 'No file')}">${escapeHtml(node.file || 'No file')}</span>
          ${isFileMissing ? '<span class="chip pb-missing-badge">missing</span>' : ''}
        </div>
        <div class="pb-insp-file-btns">
          <button type="button" class="btn btn-sm" id="pb-insp-browse" data-kind="${escapeHtml(fileKind)}">Load</button>
          ${node.file ? `<button type="button" class="btn btn-sm btn-ghost" id="pb-insp-clear" data-kind="${escapeHtml(fileKind)}">Clear</button>` : ''}
        </div>
      </div>
    ` : '';

    const fadersHtml = continuousSpecs.length > 0 ? `
      <div class="pedal-faders">
        ${continuousSpecs.map((ps) => {
          const min = Number.isFinite(ps.min) ? ps.min : 0;
          const max = Number.isFinite(ps.max) ? ps.max : 10;
          const step = Number.isFinite(ps.step) && ps.step > 0 ? ps.step : 0.01;
          const cur = Number.isFinite(node.params?.[ps.key]) ? node.params[ps.key] : (Number.isFinite(ps.def) ? ps.def : min);
          return `
            <label class="fader">
              <span class="fader-val tabular" data-pb-param-val="${escapeHtml(ps.key)}">${escapeHtml(formatBoardVal(ps, cur))}</span>
              <span class="fader-slot">
                <input type="range" class="fader-input pb-param-slider"
                  data-param-key="${escapeHtml(ps.key)}" data-unit="${escapeHtml(ps.unit || '')}"
                  data-min="${min}" data-max="${max}" data-step="${step}"
                  min="${min}" max="${max}" step="${step}" value="${cur}" aria-label="${escapeHtml(ps.label || ps.key)}" />
              </span>
              <span class="fader-label">${escapeHtml(ps.label || ps.key)}</span>
            </label>
          `;
        }).join('')}
      </div>
    ` : '';

    const optionsHtml = optionSpecs.length > 0 ? `
      <div class="pedal-opts" style="--cat:${catColor};">
        ${optionSpecs.map((ps) => {
          const curIdx = Math.round(Number.isFinite(node.params?.[ps.key]) ? node.params[ps.key] : (Number.isFinite(ps.def) ? ps.def : 0));
          if (ps.options.length <= 3) {
            return `
              <div class="pedal-param-opt">
                <span class="fader-label">${escapeHtml(ps.label || ps.key)}</span>
                <div class="pedal-seg" role="group" aria-label="${escapeHtml(ps.label || ps.key)}">
                  ${ps.options.map((opt, optIdx) => `
                    <button type="button" class="pedal-seg-btn${curIdx === optIdx ? ' is-active' : ''}"
                      data-param-key="${escapeHtml(ps.key)}" data-opt-idx="${optIdx}">${escapeHtml(String(opt))}</button>
                  `).join('')}
                </div>
              </div>
            `;
          }
          return `
            <div class="pedal-param-opt">
              <label class="fader-label">${escapeHtml(ps.label || ps.key)}</label>
              <select class="select pedal-select pb-param-select" data-param-key="${escapeHtml(ps.key)}">
                ${ps.options.map((opt, optIdx) => `<option value="${optIdx}" ${curIdx === optIdx ? 'selected' : ''}>${escapeHtml(String(opt))}</option>`).join('')}
              </select>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    return `
      <div class="pb-insp-head" style="--cat:${catColor};">
        <button type="button" class="stomp pb-insp-stomp${isEnabled ? ' is-on' : ''}" id="pb-insp-toggle"
          aria-label="Toggle ${escapeHtml(name)}" aria-pressed="${isEnabled ? 'true' : 'false'}"></button>
        <span class="pb-insp-title">${escapeHtml(name)}</span>
        <button type="button" class="btn btn-sm btn-ghost pb-insp-close" id="pb-insp-close" aria-label="Close inspector">×</button>
      </div>
      <div class="pb-insp-body">
        ${fileRowHtml}
        ${fadersHtml}
        ${optionsHtml}
        <div class="pb-insp-footer">
          <button type="button" class="btn btn-sm pb-btn-danger" id="pb-insp-remove">Remove tile</button>
        </div>
      </div>
    `;
  }

  function bindEvents(preset, graph, nodes, cables, blockTypeMap) {
    const view = getViewState(preset.id);
    const viewport = container.querySelector('#pb-viewport');
    const world = container.querySelector('#pb-world');
    const cablesSvg = container.querySelector('#pb-cables-svg');
    const previewLayer = container.querySelector('#pb-preview-cable-layer');

    const applyTransform = () => {
      if (world) world.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
      if (viewport) {
        viewport.style.backgroundSize = `${CELL_PX * view.zoom}px ${CELL_PX * view.zoom}px`;
        viewport.style.backgroundPosition = `${view.panX}px ${view.panY}px`;
      }
      const zoomBtn = container.querySelector('#pb-zoom-reset');
      if (zoomBtn) zoomBtn.textContent = `${Math.round(view.zoom * 100)}%`;
    };

    // First time a preset is shown: zoom (never above 100%) and pan so every tile fits in the viewport.
    if (view.fitPending && viewport) {
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
      if (rect.width > 50 && rect.height > 50 && boxes.length) {
        view.fitPending = false;
        const minX = Math.min(...boxes.map((b) => b.x));
        const minY = Math.min(...boxes.map((b) => b.y));
        const maxX = Math.max(...boxes.map((b) => b.x + b.w));
        const maxY = Math.max(...boxes.map((b) => b.y + b.h));
        const pad = 40;
        const zoom = clamp(Math.min(1, (rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY)), ZOOM_MIN, ZOOM_MAX);
        view.zoom = Math.round(zoom * 100) / 100;
        view.panX = Math.round((rect.width - (maxX - minX) * view.zoom) / 2 - minX * view.zoom);
        view.panY = Math.round(Math.min(pad, (rect.height - (maxY - minY) * view.zoom) / 2) - minY * view.zoom);
        applyTransform();
      }
    }

    const zoomAtPoint = (clientX, clientY, nextZoom) => {
      if (!viewport) return;
      const clamped = clamp(Math.round(nextZoom * 100) / 100, ZOOM_MIN, ZOOM_MAX);
      if (clamped === view.zoom) return;
      const rect = viewport.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const wx = (px - view.panX) / view.zoom;
      const wy = (py - view.panY) / view.zoom;
      view.panX = px - wx * clamped;
      view.panY = py - wy * clamped;
      view.zoom = clamped;
      applyTransform();
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
      drawerOpen = !drawerOpen;
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

    // Tile dragging & click-select
    container.querySelectorAll('.pb-tile').forEach((tileEl) => {
      const uid = tileEl.dataset.uid;

      tileEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectedUid = uid;
          selectedCable = null;
          paletteOpen = false;
          render();
        }
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
          const dxCells = Math.round((ev.clientX - startX) / (CELL_PX * view.zoom));
          const dyCells = Math.round((ev.clientY - startY) / (CELL_PX * view.zoom));
          const nextX = origX + dxCells;
          const nextY = origY + dyCells;
          if (nextX !== curX || nextY !== curY) {
            moved = true;
            curX = nextX;
            curY = nextY;
            if (!rafId) rafId = requestAnimationFrame(applyPos);
          }
        };

        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          if (rafId) {
            cancelAnimationFrame(rafId);
            applyPos();
          }
          if (moved) {
            amp.moveNode(preset.id, uid, curX, curY);
          } else {
            selectedUid = uid;
            selectedCable = null;
            paletteOpen = false;
            render();
            container.querySelector(`.pb-tile[data-uid="${CSS.escape(uid)}"]`)?.focus();
          }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    });

    // Viewport pan & wheel zoom
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
      let rafId = 0;

      viewport.classList.add('is-panning');

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!panned && Math.hypot(dx, dy) > 3) panned = true;
        if (panned) {
          view.panX = origPanX + dx;
          view.panY = origPanY + dy;
          if (!rafId) {
            rafId = requestAnimationFrame(() => {
              rafId = 0;
              applyTransform();
            });
          }
        }
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (rafId) cancelAnimationFrame(rafId);
        viewport.classList.remove('is-panning');
        if (!panned && isEmptyLeft) {
          if (selectedUid || selectedCable || paletteOpen || confirmDeleteOpen) {
            selectedUid = null;
            selectedCable = null;
            paletteOpen = false;
            confirmDeleteOpen = false;
            render();
          }
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    viewport?.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAtPoint(e.clientX, e.clientY, view.zoom * factor);
    }, { passive: false });

    // Inspector controls
    container.querySelector('#pb-insp-close')?.addEventListener('click', () => {
      selectedUid = null;
      selectedCable = null;
      render();
    });

    container.querySelector('#pb-insp-remove-cable')?.addEventListener('click', () => {
      if (!selectedCable) return;
      const c = selectedCable;
      selectedCable = null;
      amp.removeCable(preset.id, c.from, c.to, c.port || 0);
      render();
    });

    container.querySelector('#pb-insp-toggle')?.addEventListener('click', () => {
      const node = nodes.find((n) => n.uid === selectedUid);
      if (!node) return;
      const nextOn = node.enabled === false;
      node.enabled = nextOn;
      amp.setBlockEnabled(preset.id, node.uid, nextOn);
      render();
    });

    container.querySelector('#pb-insp-browse')?.addEventListener('click', (e) => {
      if (!selectedUid) return;
      amp.browse(preset.id, e.currentTarget.dataset.kind, selectedUid);
    });

    container.querySelector('#pb-insp-clear')?.addEventListener('click', (e) => {
      if (!selectedUid) return;
      amp.clearFile(preset.id, e.currentTarget.dataset.kind, selectedUid);
    });

    container.querySelector('#pb-insp-remove')?.addEventListener('click', () => {
      if (!selectedUid || selectedUid === 'in' || selectedUid === 'out') return;
      const uid = selectedUid;
      selectedUid = null;
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

    container.querySelectorAll('.pb-param-slider').forEach((slider) => {
      const uid = selectedUid;
      const node = nodes.find((n) => n.uid === uid);
      if (!node) return;
      const bt = blockTypeMap.get(node.type);
      const key = slider.dataset.paramKey;
      const spec = {
        key,
        unit: slider.dataset.unit || '',
        min: parseFloat(slider.dataset.min),
        max: parseFloat(slider.dataset.max),
        step: parseFloat(slider.dataset.step)
      };
      const valEl = container.querySelector(`[data-pb-param-val="${CSS.escape(key)}"]`);
      const tileSumEl = container.querySelector(`[data-tile-summary="${CSS.escape(uid)}"]`);

      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        if (!node.params) node.params = {};
        node.params[key] = v;
        boardArt.get(uid)?.set(key, v);
        if (valEl) valEl.textContent = formatBoardVal(spec, v);
        if (tileSumEl) {
          const sum = getNodeSummary(node, bt);
          tileSumEl.textContent = sum;
          tileSumEl.title = sum;
        }
        scheduleFaderSend(`param:${preset.id}:${uid}:${key}`, () => amp.setBlockParam(preset.id, uid, key, v));
      });
    });

    container.querySelectorAll('.pb-inspector .pedal-seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const node = nodes.find((n) => n.uid === selectedUid);
        if (!node) return;
        const bt = blockTypeMap.get(node.type);
        const key = btn.dataset.paramKey;
        const val = Number(btn.dataset.optIdx);
        if (!node.params) node.params = {};
        node.params[key] = val;
        btn.closest('.pedal-seg')?.querySelectorAll('.pedal-seg-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const tileSumEl = container.querySelector(`[data-tile-summary="${CSS.escape(node.uid)}"]`);
        if (tileSumEl) {
          const sum = getNodeSummary(node, bt);
          tileSumEl.textContent = sum;
          tileSumEl.title = sum;
        }
        amp.setBlockParam(preset.id, node.uid, key, val);
      });
    });

    container.querySelectorAll('.pb-param-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        const node = nodes.find((n) => n.uid === selectedUid);
        if (!node) return;
        const bt = blockTypeMap.get(node.type);
        const key = sel.dataset.paramKey;
        const val = Number(sel.value);
        if (!node.params) node.params = {};
        node.params[key] = val;
        const tileSumEl = container.querySelector(`[data-tile-summary="${CSS.escape(node.uid)}"]`);
        if (tileSumEl) {
          const sum = getNodeSummary(node, bt);
          tileSumEl.textContent = sum;
          tileSumEl.title = sum;
        }
        amp.setBlockParam(preset.id, node.uid, key, val);
      });
    });

    boardArt.forEach((ctl) => ctl?.destroy?.());
    boardArt.clear();
    container.querySelectorAll('.pb-tile.is-pedal').forEach((tileEl) => {
      const uid = tileEl.dataset.uid;
      const node = nodes.find((n) => n.uid === uid);
      const root = tileEl.querySelector('.pa');
      if (!node || !root) return;
      const bt = blockTypeMap.get(node.type);
      boardArt.set(uid, mountPedalArt(root, {
        type: node.type,
        specs: bt?.params || [],
        params: node.params || {},
        enabled: node.enabled !== false,
        onParam(key, value) {
          if (!node.params) node.params = {};
          node.params[key] = value;
          if (selectedUid === uid) {
            const slider = container.querySelector(`.pb-param-slider[data-param-key="${CSS.escape(key)}"]`);
            if (slider) {
              slider.value = String(value);
              const valEl = container.querySelector(`[data-pb-param-val="${CSS.escape(key)}"]`);
              const spec = bt?.params?.find((p) => p.key === key);
              if (valEl && spec) valEl.textContent = formatBoardVal(spec, value);
            }
          }
          scheduleFaderSend(`param:${preset.id}:${uid}:${key}`, () => amp.setBlockParam(preset.id, uid, key, value));
        },
        onToggle() {
          const nextOn = node.enabled === false;
          node.enabled = nextOn;
          amp.setBlockEnabled(preset.id, uid, nextOn);
          render();
        }
      }));
    });
  }

  // Document-level click to close popovers
  const onDocClick = (e) => {
    if (paletteOpen && !e.target.closest('.pb-palette-wrap')) {
      paletteOpen = false;
      render();
    }
  };

  // Global keyboard shortcuts (ignored while typing in form controls)
  const onKeyDown = (e) => {
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
    }
  };
}
