"""Turn the pedal design board (source.html) into app assets.

Writes:
  img/pedals/*.webp|png      every embedded picture as its own file
  js/pedal-art.js            each pedal's markup, its knob wiring and its animated canvases
  css/pedal-art.css          the pedals' styles, scoped under .pa

Run from the repo root:  python tools/pedal-art/build_pedal_art.py
Thumbnails for the board tiles come from tools/pedal-art/thumbs.mjs (run after this).
"""
import base64, hashlib, json, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(os.path.dirname(__file__), 'source.html')
IMG = os.path.join(ROOT, 'img', 'pedals')
os.makedirs(IMG, exist_ok=True)
s = open(SRC, encoding='utf-8').read()

# design order -> amp block type
TYPES = {1: 'amp', 2: 'nam', 3: 'reverb', 4: 'mixer', 5: 'cab', 6: 'ir', 7: 'volume', 8: 'eq', 9: 'overdrive',
         10: 'chorus', 11: 'phaser', 12: 'tremolo', 13: 'flanger', 14: 'delay', 15: 'autowah'}
# pedal knob/slider name -> amp parameter key ('!' = the art runs the other way, e.g. a longer delay moves slower)
CONTROLS = {
    'amp': {'gain': 'gain', 'bass': 'bass', 'mid': 'mid', 'treble': 'treble', 'pres': 'presence'},
    'nam': {'level': 'level'}, 'reverb': {'size': 'size', 'tone': 'tone', 'mix': 'mix'},
    'mixer': {'ab': 'balance', 'level': 'level'}, 'cab': {'level': 'level'}, 'ir': {'lvl': 'level'},
    'volume': {'volume': 'level'}, 'eq': {'low': 'low', 'mid': 'mid', 'high': 'high'},
    'overdrive': {'bite': 'drive', 'level': 'level'}, 'chorus': {'rate': 'rate', 'depth': 'depth', 'mix': 'mix'},
    'phaser': {'rate': 'rate', 'depth': 'depth', 'fdbk': 'feedback'}, 'tremolo': {'speed': 'rate', 'depth': 'depth'},
    'flanger': {'rate': 'rate', 'depth': 'depth', 'swoosh': 'feedback'},
    'delay': {'time': '!time', 'repeats': 'feedback', 'tone': 'tone', 'mix': 'mix'},
    'autowah': {'wah': 'wah', 'level': 'level', 'mix': 'mix'},
}
THUMB_POS = {'nam': 'center 18%', 'overdrive': 'center 22%', 'reverb': 'center 45%', 'eq': 'center 40%'}

written = {}
def save_uri(m, tag):
    mime, b64 = m.group(1), m.group(2)
    raw = base64.b64decode(b64)
    h = hashlib.sha1(raw).hexdigest()[:10]
    ext = {'image/webp': 'webp', 'image/png': 'png'}[mime]
    name = f'{tag}-{h}.{ext}'
    if name not in written:
        open(os.path.join(IMG, name), 'wb').write(raw); written[name] = len(raw)
    return f'img/pedals/{name}'

pedals = {}
for n, typ in TYPES.items():
    i = s.index(f'<!-- {n}. '); a = s.index('<article', i); j = s.index('</article>', a) + len('</article>')
    html = s[a:j]
    # size from the old grid spans, then drop the grid placement
    st = re.search(r'<article style="([^"]*)"', html).group(1)
    gc = re.search(r'grid-column:\s*([^;]+);', st).group(1); gr = re.search(r'grid-row:\s*([^;]+);', st).group(1)
    w = 544 if 'span 2' in gc else 260; h = 544 if 'span 2' in gr else 260
    st2 = re.sub(r'grid-(column|row):\s*[^;]+;\s*', '', st)
    st2 = f'width: {w}px; height: {h}px; box-sizing: border-box; ' + ('' if 'position:' in st2 else 'position: relative; ') + st2
    html = html.replace(st, st2, 1)
    # pictures -> files
    html = re.sub(r'data:(image/(?:webp|png));base64,([A-Za-z0-9+/=]+)', lambda m: save_uri(m, typ), html)
    # inline scripts -> init functions that take the canvas they drive
    inits = []
    def grab(m):
        body = m.group(1)
        prev = html[:m.start()].rsplit('<canvas', 1)[1]
        cls = re.match(r'\s+class="([^"]+)"', prev).group(1).split()[0]
        body = body.replace('var cv=document.currentScript.previousElementSibling,', 'var ', 1)
        assert body.startswith('(function(){var ') and body.endswith('})();'), typ
        body = 'function(cv){' + body[len('(function(){'):-len('})();')] + '}'
        body = body.replace('function frame(now){raf=0;if(!on)return;', 'function frame(now){raf=0;if(!on||!cv.isConnected)return;')
        assert 'cv.isConnected' in body, typ
        inits.append((cls, body))
        return ''
    html = re.sub(r'<script>(.*?)</script>', grab, html, flags=re.S)
    pedals[typ] = dict(w=w, h=h, html=html, inits=inits)

# ---------- CSS, scoped under .pa
css_src = '\n'.join(re.findall(r'<style>(.*?)</style>', s, re.S))
css_src = re.sub(r'data:(image/(?:webp|png));base64,([A-Za-z0-9+/=]+)', lambda m: save_uri(m, 'css'), css_src)
blocks, depth, start = [], 0, 0
k = 0
while k < len(css_src):
    c = css_src[k]
    if c == '{': depth += 1
    elif c == '}':
        depth -= 1
        if depth == 0: blocks.append(css_src[start:k + 1].strip()); start = k + 1
    elif c == ';' and depth == 0: start = k + 1
    k += 1
DROP = (':root', 'html', 'body', '#board', '.pb-paused', '.does', '/*')
top, inner = [], []
for b in blocks:
    b = re.sub(r'^/\*.*?\*/\s*', '', b, flags=re.S).strip()
    head = b.split('{', 1)[0].strip()
    if not b or head.startswith(DROP): continue
    (top if head.startswith('@keyframes') else inner).append(b)
extra = '''
/* app additions */
.pa{position:relative;overflow:hidden;margin:0 auto}
.pa-scale{transform-origin:0 0;position:absolute;left:0;top:0}
.pa article{box-shadow:none!important;margin:0}
.pa.pa-off .led{background:#3a3430!important;box-shadow:none!important}
.pa.pa-off *{animation-play-state:paused!important}
.pa .fs{cursor:pointer}
'''
css = ('/* Generated by tools/pedal-art/build_pedal_art.py from the pedal design board. Edit the source, not this file. */\n'
       + '\n'.join(top) + '\n.pa{\n' + '\n'.join(inner) + '\n}\n' + extra)
open(os.path.join(ROOT, 'css', 'pedal-art.css'), 'w', encoding='utf-8').write(css)

# ---------- JS module
runtime = r'''
const MOTION = {"a-swing":["gain",17,12],"a-eyes":["level",11,8],"a-tw":["size",5.5,3.5],"a-xa":["level",2.3,1.5],"a-xb":["level",2.3,1.5],
  "a-cloud":["level",44,34],"a-cable":["lvl",15,10],"a-lift":["lvl",15,10],"a-sway":["volume",6,3.4],"a-water":["low",3.4,2.6],
  "a-fleck":["low",7,4],"a-rattle":["level",5.5,4],"a-chorus":["rate",6,4.5],"fx-spin":["rate",34,28],"a-hoof":["speed",3.6,2.6],
  "a-roll":["rate",4.2,3.2],"a-kick":["wah",5.2,3.6],"a-spur":["wah",5.2,3.6]};

export function hasPedalArt(type) { return Object.prototype.hasOwnProperty.call(PEDALS, type); }
export function pedalThumb(type) { return hasPedalArt(type) ? new URL('../' + PEDALS[type].thumb, import.meta.url).href : null; }

export function pedalArtHtml(type) {
  const p = PEDALS[type];
  if (!p) return '';
  return `<div class="pa" data-pa-type="${type}" style="width:${p.w}px;height:${p.h}px"><div class="pa-scale">${p.html}</div></div>`;
}

// Wires a rendered pedal to the amp. opts: { type, specs, params, enabled, onParam(key, value), onToggle() }
// Returns { set(key, value), setEnabled(on), destroy() }.
export function mountPedalArt(root, opts) {
  const p = PEDALS[opts.type];
  if (!root || !p) return { set() {}, setEnabled() {}, destroy() {} };
  const art = root.querySelector('article');
  const scaleEl = root.querySelector('.pa-scale');
  const specs = new Map((opts.specs || []).map((s) => [s.key, s]));
  const controls = CONTROLS[opts.type] || {};
  const byParam = new Map();      // amp key -> [{name, el, slider, invert}]

  function fit() {
    const avail = root.parentElement ? root.parentElement.clientWidth : p.w;
    const k = Math.min(1, avail / p.w);
    scaleEl.style.transform = `scale(${k})`;
    root.style.width = `${p.w * k}px`;
    root.style.height = `${p.h * k}px`;
  }
  fit();
  const ro = new ResizeObserver(() => requestAnimationFrame(fit));
  if (root.parentElement) ro.observe(root.parentElement);

  const norm = (spec, v, inv) => {
    const n = (v - spec.min) / ((spec.max - spec.min) || 1);
    return Math.max(0, Math.min(1, inv ? 1 - n : n));
  };
  const raw = (spec, n, inv) => {
    const t = inv ? 1 - n : n;
    let v = spec.min + t * (spec.max - spec.min);
    const step = spec.step > 0 ? spec.step : 0.01;
    v = Math.round(v / step) * step;
    return Math.max(spec.min, Math.min(spec.max, +v.toFixed(4)));
  };

  // smooth CSS values and speed changes without restarting animations
  let tweens = new Map(), tweenOn = false;
  function glide(name, v) {
    const cur = parseFloat(art.style.getPropertyValue('--' + name));
    if (isNaN(cur)) { art.style.setProperty('--' + name, v.toFixed(3)); return; }
    tweens.set(name, v);
    if (!tweenOn) { tweenOn = true; requestAnimationFrame(step); }
  }
  function step() {
    let live = false;
    for (const [n, goal] of tweens) {
      const c = parseFloat(art.style.getPropertyValue('--' + n)), d = goal - c;
      if (Math.abs(d) > 0.002) { art.style.setProperty('--' + n, (c + d * 0.18).toFixed(4)); live = true; }
      else { art.style.setProperty('--' + n, goal.toFixed(3)); tweens.delete(n); }
    }
    if (live && art.isConnected) requestAnimationFrame(step); else tweenOn = false;
  }
  function retime(name, n) {
    const n0 = parseFloat(art.style.getPropertyValue('--' + name + '0'));
    if (isNaN(n0)) return;
    art.getAnimations({ subtree: true }).forEach((an) => {
      const m = MOTION[an.animationName];
      if (!m || m[0] !== name) return;
      const r = (m[1] - m[2] * n0) / (m[1] - m[2] * n);
      if (an.updatePlaybackRate) an.updatePlaybackRate(r); else an.playbackRate = r;
    });
  }
  function show(c, n, init) {
    if (c.slider) c.el.style.top = `${((1 - n) * 90).toFixed(1)}%`;
    else c.el.style.setProperty('--a', `${(n * 270 - 135).toFixed(1)}deg`);
    c.el.dataset.v = n;
    c.el.setAttribute('aria-valuenow', String(raw(c.spec, n, c.invert)));
    if (init) { art.style.setProperty('--' + c.name + '0', n.toFixed(3)); art.style.setProperty('--' + c.name, n.toFixed(3)); }
    else { glide(c.name, n); retime(c.name, n); }
    art.classList.toggle('hot-' + c.name, n > 0.7);
  }
  function userSet(c, n) {
    n = Math.max(0, Math.min(1, n));
    show(c, n, false);
    if (opts.onParam) opts.onParam(c.spec.key, raw(c.spec, n, c.invert));
  }

  const els = [...art.querySelectorAll('.k[data-k]'), ...art.querySelectorAll('[data-s]')];
  for (const el of els) {
    const slider = el.hasAttribute('data-s');
    const name = slider ? el.dataset.s : el.dataset.k;
    const target = controls[name];
    if (!target) continue;
    const invert = target.startsWith('!');
    const spec = specs.get(invert ? target.slice(1) : target);
    if (!spec) continue;
    const c = { name, el, slider, invert, spec };
    if (!byParam.has(spec.key)) byParam.set(spec.key, []);
    byParam.get(spec.key).push(c);
    const handle = slider ? el.parentElement.parentElement : el;
    handle.tabIndex = 0;
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', spec.label || spec.key);
    handle.setAttribute('aria-valuemin', String(spec.min));
    handle.setAttribute('aria-valuemax', String(spec.max));
    handle.style.cursor = 'ns-resize';
    handle.style.touchAction = 'none';
    const cur = Number.isFinite(opts.params?.[spec.key]) ? opts.params[spec.key] : spec.def;
    show(c, norm(spec, cur, invert), true);
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); handle.focus(); handle.setPointerCapture(e.pointerId);
      const groove = slider ? el.parentElement : null;
      const y0 = e.clientY, n0 = +el.dataset.v;
      const move = (ev) => {
        if (groove) { const r = groove.getBoundingClientRect(); userSet(c, 1 - (ev.clientY - r.top) / (r.height * 0.9)); }
        else userSet(c, n0 + (y0 - ev.clientY) / 120);
      };
      if (groove) move(e);
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('wheel', (e) => { e.preventDefault(); userSet(c, +el.dataset.v - Math.sign(e.deltaY) * 0.05); }, { passive: false });
    handle.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key];
      if (d) { e.preventDefault(); userSet(c, +el.dataset.v + d); }
    });
  }

  const fs = art.querySelector('.fs');
  if (fs) {
    fs.setAttribute('role', 'button'); fs.tabIndex = 0;
    fs.setAttribute('aria-label', 'Bypass');
    const press = (e) => { e.preventDefault(); if (opts.onToggle) opts.onToggle(); };
    fs.addEventListener('click', press);
    fs.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') press(e); });
  }
  root.classList.toggle('pa-off', opts.enabled === false);

  for (const [sel, init] of p.inits) { const cv = art.querySelector('canvas.' + sel); if (cv) init(cv); }

  return {
    set(key, value) {
      for (const c of byParam.get(key) || []) show(c, norm(c.spec, value, c.invert), false);
    },
    setEnabled(on) { root.classList.toggle('pa-off', !on); },
    destroy() { ro.disconnect(); root.remove(); }
  };
}
'''
out = ['// Generated by tools/pedal-art/build_pedal_art.py from the pedal design board. Edit the source, not this file.',
       'const CONTROLS = ' + json.dumps(CONTROLS) + ';', 'const PEDALS = {']
for typ, p in pedals.items():
    inits = ','.join(f'[{json.dumps(cls)}, {body}]' for cls, body in p['inits'])
    out.append(f'  {json.dumps(typ)}: {{ w: {p["w"]}, h: {p["h"]}, thumb: "img/pedals/thumb-{typ}.webp", '
               f'thumbPos: {json.dumps(THUMB_POS.get(typ, "center"))}, html: {json.dumps(p["html"])}, inits: [{inits}] }},')
out.append('};')
out.append('export const PEDAL_THUMB_POS = Object.fromEntries(Object.entries(PEDALS).map(([k, v]) => [k, v.thumbPos]));')
open(os.path.join(ROOT, 'js', 'pedal-art.js'), 'w', encoding='utf-8').write('\n'.join(out) + runtime)
print('pedals', len(pedals), '| images', len(written), f'{sum(written.values()) // 1024} KB',
      '| css', os.path.getsize(os.path.join(ROOT, 'css', 'pedal-art.css')) // 1024, 'KB',
      '| js', os.path.getsize(os.path.join(ROOT, 'js', 'pedal-art.js')) // 1024, 'KB')
