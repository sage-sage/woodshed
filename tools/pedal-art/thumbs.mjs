// Screenshots each pedal on the design board (served at the URL given) into tools/pedal-art/shots/<n>.png.
// Usage: node tools/pedal-art/thumbs.mjs http://127.0.0.1:8650/source.html
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'shots'); mkdirSync(out, { recursive: true });
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'pbthumb-'))}`,
  '--window-size=1900,1600', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 40; i++) { try { list = await (await fetch('http://127.0.0.1:9334/json')).json(); if (list.length) break; } catch {} await sleep(250); }
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1900, height: 1600, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: process.argv[2] });
await sleep(4000);
const rects = JSON.parse(await ev(`(async()=>{await document.fonts.ready;document.getElementById('board').style.zoom=1;await new Promise(r=>setTimeout(r,1500));
  return JSON.stringify([...document.querySelectorAll('article')].map(a=>{const r=a.getBoundingClientRect();return [r.x+scrollX,r.y+scrollY,r.width,r.height]}));})()`));
for (let k = 0; k < rects.length; k++) {
  const [x, y, w, h] = rects[k];
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x, y, width: w, height: h, scale: 1 } });
  writeFileSync(join(out, `${k + 1}.png`), Buffer.from(r.result.data, 'base64'));
}
console.log('shots', rects.length);
ws.close(); chrome.kill();
