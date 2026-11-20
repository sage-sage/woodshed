#!/usr/bin/env python3
"""Generate and inject pedal 16 (DYNAMITE) HTML and CSS into source.html."""

import math
import random
import re
from pathlib import Path

SOURCE_PATH = Path(__file__).resolve().parent / "source.html"

COMMENT_LINE = (
    "<!-- 16. DYNAMITE (metal): one big stick of dynamite in the middle, "
    "a dense tangle of burning fuse wire behind it -->"
)

DEPTH_LAYERS = (
    ("far", 10, 18, "url(#dyn-blur-far)"),
    ("mid", 7, 12, "url(#dyn-blur-mid)"),
    ("near", 5, 6, None),
)

KNOBS = (
    ("gain", "Gain", "90deg"),
    ("tight", "Tight", "-20deg"),
    ("low", "Low", "20deg"),
    ("mid", "Mid", "-40deg"),
    ("high", "High", "20deg"),
    ("level", "Level", "0deg"),
    ("gate", "Gate", "-60deg"),
)


def _walk_points(rng: random.Random) -> list[tuple[float, float]]:
    """Generate a spooled random walk with occasional tight coils."""
    n_pts = rng.randint(44, 60)
    x = rng.uniform(-30.0, 574.0)
    y = rng.uniform(-30.0, 290.0)
    theta = rng.uniform(0.0, 2.0 * math.pi)
    pts = [(x, y)]

    coil_steps = 0
    coil_turn = 0.0

    for _ in range(n_pts - 1):
        step = rng.uniform(14.0, 26.0)
        if coil_steps > 0:
            theta += coil_turn
            coil_steps -= 1
        else:
            theta += rng.uniform(-0.35, 0.35)
            if rng.random() < 0.26:
                coil_steps = rng.randint(5, 9)
                sign = -1.0 if rng.random() < 0.5 else 1.0
                coil_turn = sign * rng.uniform(0.75, 1.1)

        x += step * math.cos(theta)
        y += step * math.sin(theta)

        if x < -40.0 or x > 584.0 or y < -40.0 or y > 300.0:
            theta = math.atan2(130.0 - y, 272.0 - x) + rng.uniform(-0.3, 0.3)
            coil_steps = 0

        pts.append((x, y))

    return pts


def _catmull_rom_to_bezier(pts: list[tuple[float, float]]) -> str:
    """Convert a polyline into a smooth cubic Bezier SVG path string."""
    n = len(pts)
    segs = []
    for i in range(n - 1):
        p0 = pts[i - 1] if i > 0 else pts[0]
        p1 = pts[i]
        p2 = pts[i + 1]
        p3 = pts[i + 2] if i + 2 < n else pts[-1]

        c1x = p1[0] + (p2[0] - p0[0]) / 6.0
        c1y = p1[1] + (p2[1] - p0[1]) / 6.0
        c2x = p2[0] - (p3[0] - p1[0]) / 6.0
        c2y = p2[1] - (p3[1] - p1[1]) / 6.0
        segs.append(
            f"{c1x:.1f} {c1y:.1f} {c2x:.1f} {c2y:.1f} {p2[0]:.1f} {p2[1]:.1f}"
        )

    return f"M {pts[0][0]:.1f} {pts[0][1]:.1f} C " + " ".join(segs)


SPARK_SCRIPT = (
    "(function(){"
    "var cv=document.currentScript.previousElementSibling,W=544,H=260,AR=cv.closest(\"article\");"
    "cv.width=W;cv.height=H;"
    "var g=cv.getContext(\"2d\"),ID=g.createImageData(W,H),U=new Uint32Array(ID.data.buffer),VAL=new Float32Array(W*H);"
    "var BAY=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5],NZL=W*H,NZ=new Float32Array(NZL);for(var z=0;z<NZL;z++)NZ[z]=Math.random();"
    "var ws=[],hs=AR.querySelectorAll(\".a-dyn-hot\");"
    "for(var i=0;i<hs.length;i++){"
    "var p=hs[i],sc=p.closest(\".a-dyn-far\")?.45:p.closest(\".a-dyn-mid\")?.7:1,dim=sc<.5?.55:sc<.8?.8:1;"
    "ws.push({p:p,L:p.getTotalLength(),sc:sc,dim:dim,x:0,y:0,bx:-1,by:0,init:false});"
    "}"
    "var KG=null,KL=null,CR0=null,N=260,ps=[];"
    "function seed(){"
    "if(!ws.length)return null;"
    "var w=ws[Math.floor(Math.random()*ws.length)],a=Math.atan2(w.by,w.bx)+(Math.random()-.5)*2.4,sp=(8+Math.random()*22)*w.sc;"
    "return{x:w.x,y:w.y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-12,u:0,l:.5+Math.random()*.9,sc:w.sc};"
    "}"
    "var still=window.matchMedia&&matchMedia(\"(prefers-reduced-motion: reduce)\").matches,last=0,lastT=0,raf=0,on=true;"
    "function frame(now){"
    "raf=0;if(!on)return;if(!still)raf=requestAnimationFrame(frame);"
    "if(now-last<30&&last)return;"
    "var dt=Math.min(.05,(now-last)/1000||0);last=now;"
    "var raw=parseFloat(AR.style.getPropertyValue(\"--gain\")),kg=isNaN(raw)?.7:raw;"
    "KG=KG==null?kg:KG+(kg-KG)*Math.min(1,dt*4);var rl=parseFloat(AR.style.getPropertyValue(\"--level\")),kl=isNaN(rl)?.57:rl;KL=KL==null?kl:KL+(kl-KL)*Math.min(1,dt*4);"
    "var moved=false;"
    "for(var i=0;i<ws.length;i++){"
    "var w=ws[i],off=parseFloat(getComputedStyle(w.p).strokeDashoffset)||0;"
    "var s=(((12-off)/1000)%1+1)%1,pt=w.p.getPointAtLength(s*w.L);"
    "var s2=((s-.004)%1+1)%1,pt2=w.p.getPointAtLength(s2*w.L);"
    "var dx=pt2.x-pt.x,dy=pt2.y-pt.y,dL=Math.hypot(dx,dy);"
    "if(dL>20){var pt3=w.p.getPointAtLength(Math.min(1,s+.004)*w.L);dx=pt.x-pt3.x;dy=pt.y-pt3.y;dL=Math.hypot(dx,dy);}"
    "dL=dL||1;w.bx=dx/dL;w.by=dy/dL;"
    "if(!w.init||Math.abs(pt.x-w.x)>.01||Math.abs(pt.y-w.y)>.01)moved=true;"
    "w.x=pt.x;w.y=pt.y;w.init=true;"
    "}"
    "if(moved)lastT=now/1000;"
    "var T=lastT,sh=Math.floor(T*7),crs=cv.getBoundingClientRect().width*(window.devicePixelRatio||1)<W*1.9;if(crs!==CR0){CR0=crs;cv.style.imageRendering=crs?\"auto\":\"pixelated\";}"
    "U.fill(0);VAL.fill(0);"
    "for(var i=0;i<ws.length;i++){"
    "var w=ws[i],R=(10+14*KG)*(.7+.5*KL)*w.sc,fl=(.75+.25*Math.sin(T*23+i*1.7)*Math.sin(T*7.3+i))*w.dim*(.35+.75*KL);"
    "var x0=Math.max(0,Math.floor(w.x-R)),x1=Math.min(W-1,Math.ceil(w.x+R));"
    "var y0=Math.max(0,Math.floor(w.y-R)),y1=Math.min(H-1,Math.ceil(w.y+R));"
    "for(var y=y0;y<=y1;y++)for(var x=x0;x<=x1;x++){"
    "var r=Math.hypot(x-w.x,y-w.y);if(r>=R)continue;"
    "var v=Math.pow(1-r/R,1.6)*fl,ii=y*W+x;if(v<=VAL[ii])continue;"
    "var th=crs?NZ[(ii+sh*131)%NZL]:(BAY[((y+sh)&3)*4+((x+(sh>>2))&3)]+.5)/16;"
    "if(!crs)th=th*.75+.25*(.5+.5*Math.sin(y*.45-T*4+x*.15));"
    "if(v>th){VAL[ii]=v;U[ii]=v>.75?0xFFB8F2FF:v>.45?0xFF5ACFFF:v>.2?0xFF2A9AFF:0xFF1B38C2;}"
    "}"
    "}"
    "var n=Math.round(N*(.4+.6*KG)*(.2+.9*KL));"
    "for(var k=0;k<n;k++){"
    "var p=ps[k];if(!p){p=ps[k]=seed();if(!p)continue;p.u=Math.random();}"
    "if(!still&&moved){p.u+=dt/p.l;if(p.u>=1){p=ps[k]=seed();if(!p)continue;}p.x+=p.vx*dt;p.y+=p.vy*dt;}"
    "var xi=Math.round(p.x),yi=Math.round(p.y);"
    "if(xi<0||yi<0||xi>=W||yi>=H)continue;"
    "var th=crs?NZ[(yi*W+xi+sh*131)%NZL]:(BAY[((yi+sh)&3)*4+((xi+(sh>>2))&3)]+.5)/16;"
    "if(!crs)th=th*.75+.25*(.5+.5*Math.sin(yi*.45-T*4+xi*.15));"
    "if((1-p.u)>th){"
    "var col=p.u<.2?0xFFB8F2FF:p.u<.48?0xFF5ACFFF:p.u<.78?0xFF2A9AFF:0xFF143A8A;"
    "U[yi*W+xi]=col;"
    "if(p.sc>.9&&p.u<.35&&xi+1<W)U[yi*W+xi+1]=col;"
    "}"
    "}"
    "g.putImageData(ID,0,0);"
    "}"
    "function wake(){if(on&&!raf&&!still)raf=requestAnimationFrame(frame);}"
    "new IntersectionObserver(function(es){on=es[0].isIntersecting&&!document.hidden;wake();}).observe(AR);"
    "document.addEventListener(\"visibilitychange\",function(){on=!document.hidden;wake();});"
    "raf=requestAnimationFrame(frame);"
    "})();"
)


def build_wire_svg(rng: random.Random, cold_rng: random.Random) -> tuple[str, int]:
    """Build the background wire tangle SVG and return (markup, path_count)."""
    lines = [
        '<svg class="a-dyn-wires" viewBox="0 0 544 260" preserveAspectRatio="none" aria-hidden="true">',
        "  <defs>",
        '    <filter id="dyn-blur-far" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.8"/></filter>',
        '    <filter id="dyn-blur-mid" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.7"/></filter>',
        "  </defs>",
    ]

    total_paths = 0
    for depth_name, count, cold_count, blur_url in DEPTH_LAYERS:
        # Cold wires: cable only, never burn (a denser tangle without more sparks). Own RNG so the burning wires stay put.
        cold_wires = [_catmull_rom_to_bezier(_walk_points(cold_rng)) for _ in range(cold_count)]
        total_paths += cold_count
        wires = []
        for _ in range(count):
            d = _catmull_rom_to_bezier(_walk_points(rng))
            dur = round(rng.uniform(9.0, 17.0), 2)
            delay = -round(rng.uniform(0.0, dur), 2)
            if delay == 0.0:
                delay = 0.0
            wires.append((d, f"--d:{dur:.2f}s;--dl:{delay:.2f}s"))
            total_paths += 1

        lines.append(f'  <g class="a-dyn-{depth_name}">')
        if blur_url:
            lines.append(f'    <g filter="{blur_url}">')
        else:
            lines.append("    <g>")

        for d in cold_wires:
            lines.append(f'      <path class="a-dyn-c-out" d="{d}"/>')
            lines.append(f'      <path class="a-dyn-c-in" d="{d}"/>')
        for d, style in wires:
            lines.append(f'      <g style="{style}">')
            lines.append(f'        <path class="a-dyn-c-out" d="{d}" pathLength="1000"/>')
            lines.append(f'        <path class="a-dyn-c-in" d="{d}" pathLength="1000"/>')
            lines.append(f'        <path class="a-dyn-ember fx-anim" d="{d}" pathLength="1000"/>')
            lines.append(f'        <path class="a-dyn-brown fx-anim" d="{d}" pathLength="1000"/>')
            lines.append(f'        <path class="a-dyn-gold fx-anim" d="{d}" pathLength="1000"/>')
            lines.append(f'        <path class="a-dyn-hot fx-anim" d="{d}" pathLength="1000"/>')
            lines.append("      </g>")

        lines.append("    </g>")
        lines.append("  </g>")

    lines.append("</svg>")
    return "\n".join("      " + line for line in lines), total_paths


def build_article_html(rng: random.Random, cold_rng: random.Random) -> tuple[str, int]:
    """Build the full replacement block for pedal 16."""
    wire_svg, total_paths = build_wire_svg(rng, cold_rng)
    knob_html = "\n".join(
        f'        <div class="a-dyn-knob"><div class="k" data-k="{key}" style="--a:{angle}"><i></i></div>'
        f'<span class="lbl">{label}</span></div>'
        for key, label, angle in KNOBS
    )

    html = f"""{COMMENT_LINE}
    <article style="background: radial-gradient(ellipse at 50% 45%, #2a160a 0%, #120c08 65%), #120c08; color: #e9d9b8; user-select: none; box-sizing: border-box; --cap:#1a1410; --skirt:#c2381b; --tick:#e9d9b8; --ind:#f2e6c9; --fs:#b9b4ab; --fsb:#55504a; --fsz:34px; grid-column: 1 / span 2; grid-row: 5; position: relative; overflow: hidden;">
{wire_svg}
      <canvas class="a-dyn-sparks" width="544" height="260" aria-hidden="true"></canvas><script>{SPARK_SCRIPT}</script>
      <div class="a-dyn-stick">
        <div class="a-dyn-body">
          <span class="a-dyn-cap a-dyn-cap-l"></span>
          <span class="a-dyn-cap a-dyn-cap-r"></span>
          <span class="a-dyn-seam" style="left:28px"></span>
          <span class="a-dyn-seam" style="left:35px"></span>
          <span class="a-dyn-seam" style="right:35px"></span>
          <span class="a-dyn-seam" style="right:28px"></span>
          <div class="a-dyn-title">DYNAMITE</div>
          <div class="a-dyn-sub">HIGH GAIN &middot; HANDLE WITH CARE</div>
        </div>
        <svg class="a-dyn-stub" viewBox="0 0 56 54" aria-hidden="true">
          <path d="M 2 48 C 18 48, 22 31, 33 21 C 43 12, 46 4, 54 2" stroke="#0b0807" stroke-width="3" fill="none" stroke-linecap="round"/>
          <path d="M 2 48 C 18 48, 22 31, 33 21 C 43 12, 46 4, 54 2" stroke="#0a0807" stroke-width="1.65" fill="none" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="a-dyn-ctrl">
{knob_html}
        <span class="led"></span>
        <div class="fs"></div>
      </div>
    </article>"""
    return html, total_paths


def build_css() -> str:
    """Return the CSS block for pedal 16."""
    return """/* Dynamite: gain = burn flare intensity */
.a-dyn-wires {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
  pointer-events: none;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.a-dyn-sparks {
  position: absolute;
  inset: 0;
  width: 544px;
  height: 260px;
  pointer-events: none;
  z-index: 1;
  image-rendering: pixelated;
}
.a-dyn-far { --w: 1.3px; opacity: .5; }
.a-dyn-mid { --w: 2px; opacity: .8; }
.a-dyn-near { --w: 3px; opacity: 1; }
.a-dyn-c-out { stroke: #0b0807; stroke-width: var(--w); }
.a-dyn-c-in { stroke: #0a0807; stroke-width: calc(var(--w) * 0.55); }
@keyframes a-dyn-ember { from { stroke-dashoffset: 420; } to { stroke-dashoffset: -580; } }
@keyframes a-dyn-brown { from { stroke-dashoffset: 260; } to { stroke-dashoffset: -740; } }
@keyframes a-dyn-gold { from { stroke-dashoffset: 110; } to { stroke-dashoffset: -890; } }
@keyframes a-dyn-hot { from { stroke-dashoffset: 12; } to { stroke-dashoffset: -988; } }
.a-dyn-ember {
  stroke: #3b2415;
  stroke-width: calc(var(--w) * 0.8);
  stroke-dasharray: 420 580;
  animation: a-dyn-ember var(--d) linear var(--dl) infinite;
}
.a-dyn-brown {
  stroke: #7a4a22;
  stroke-width: calc(var(--w) * 0.8);
  stroke-dasharray: 260 740;
  animation: a-dyn-brown var(--d) linear var(--dl) infinite;
}
.a-dyn-gold {
  stroke: #e3a83a;
  stroke-width: calc(var(--w) * 0.85);
  stroke-dasharray: 110 890;
  animation: a-dyn-gold var(--d) linear var(--dl) infinite;
}
.a-dyn-hot, .a-dyn-gold { opacity: calc(.4 + .6 * var(--level, .57)); }
.a-dyn-hot {
  stroke: #fff2b8;
  stroke-width: calc(var(--w) * 1.05);
  stroke-dasharray: 12 988;
  animation: a-dyn-hot var(--d) linear var(--dl) infinite;
}
.a-dyn-stick {
  position: absolute;
  left: 50%;
  top: 112px;
  width: 300px;
  height: 64px;
  transform: translate(-50%, -50%);
  z-index: 2;
  filter: drop-shadow(0 10px 14px rgba(0, 0, 0, .65));
  pointer-events: none;
}
.a-dyn-body {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 32px;
  overflow: hidden;
  background: linear-gradient(180deg, #e2533a 0%, #c2381b 46%, #7e1f0e 100%);
  box-shadow: inset 0 1px 0 rgba(255, 210, 190, .28), inset 0 -2px 5px rgba(28, 5, 2, .45);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.a-dyn-cap {
  position: absolute;
  top: 4px;
  width: 16px;
  height: 56px;
  border-radius: 50%;
  background: radial-gradient(ellipse at 50% 50%, #6d1b0c 0%, #561307 78%, #420d04 100%);
  box-shadow: inset 0 0 0 1px rgba(255, 160, 130, .14);
}
.a-dyn-cap-l { left: 2px; }
.a-dyn-cap-r { right: 2px; }
.a-dyn-seam {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: linear-gradient(90deg, rgba(35, 8, 3, .48), rgba(255, 165, 135, .14));
}
.a-dyn-title {
  position: relative;
  z-index: 1;
  font-family: 'Ultra', serif;
  font-size: 34px;
  line-height: 1;
  letter-spacing: .06em;
  color: #1a1410;
}
.a-dyn-sub {
  position: relative;
  z-index: 1;
  margin-top: 3px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 7px;
  font-weight: 700;
  letter-spacing: .3em;
  color: #1a1410;
  opacity: .88;
}
.a-dyn-stub {
  position: absolute;
  right: -46px;
  top: -16px;
  width: 56px;
  height: 54px;
  overflow: visible;
  z-index: -1;
}
.a-dyn-ctrl {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 70px;
  z-index: 3;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 0 22px 8px;
  box-sizing: border-box;
  background: linear-gradient(to bottom, rgba(18, 12, 8, 0) 0, rgba(18, 12, 8, .85) 22px, #120c08 100%);
}
.a-dyn-knob {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.a-dyn-ctrl .lbl { color: #e9d9b8; }
.a-dyn-ctrl .led { margin-bottom: 24px; }
.a-dyn-ctrl .fs { margin-bottom: 12px; }"""


def update_source(html: str, article_block: str, css_block: str) -> str:
    """Replace pedal 16 HTML and inject/update CSS in the second <style> block."""
    article_pat = re.compile(
        r"^[ \t]*<!-- 16\. DYNAMITE[^\n]*\n[\s\S]*?</article>",
        re.MULTILINE,
    )
    html, art_subs = article_pat.subn(article_block, html, count=1)
    if art_subs != 1:
        raise RuntimeError("Could not locate '<!-- 16. DYNAMITE ... </article>' in source.html")

    style_matches = list(
        re.finditer(r"<style\b[^>]*>.*?</style>", html, re.IGNORECASE | re.DOTALL)
    )
    if len(style_matches) < 2:
        raise RuntimeError("Expected at least two <style> blocks in source.html")

    second_style = style_matches[1]
    style_text = second_style.group(0)
    marked_css = f"/* dyn:start */\n{css_block}\n/* dyn:end */"

    marker_pat = re.compile(r"/\* dyn:start \*/[\s\S]*?/\* dyn:end \*/")
    if marker_pat.search(style_text):
        new_style = marker_pat.sub(marked_css, style_text, count=1)
    else:
        close_idx = style_text.lower().rfind("</style>")
        prefix = style_text[:close_idx]
        if not prefix.endswith("\n"):
            prefix += "\n"
        new_style = f"{prefix}{marked_css}\n{style_text[close_idx:]}"

    return html[: second_style.start()] + new_style + html[second_style.end() :]


def main() -> None:
    rng = random.Random(1606)
    raw_before = SOURCE_PATH.read_bytes()
    html_before = raw_before.decode("utf-8")

    article_block, total_paths = build_article_html(rng, random.Random(2077))
    css_block = build_css()
    html_after = update_source(html_before, article_block, css_block)

    raw_after = html_after.encode("utf-8")
    SOURCE_PATH.write_bytes(raw_after)
    bytes_added = len(raw_after) - len(raw_before)
    print(f"dynamite_art: {total_paths} wire paths, {bytes_added:+d} bytes added")


if __name__ == "__main__":
    main()

