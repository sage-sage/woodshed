import { detectPitch, notePresence, judgeNotes, OnsetDetector, midiToFreq, freqToMidi } from '../js/dsp.js';
function pluck(out, sr, midi, startSec, gain = 0.3, seed = 1) {
  const f = midiToFreq(midi);
  const period = sr / f;
  const N = Math.floor(period - 0.5);
  const frac = period - 0.5 - N;
  const c = (1 - frac) / (1 + frac);
  const d = new Float64Array(N + 1);
  let s = (seed * 2654435761 + midi * 97) >>> 0;
  let mean = 0;
  for (let i = 0; i <= N; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s / 0xffffffff * 2 - 1; mean += d[i]; }
  mean /= N + 1;
  for (let i = 0; i <= N; i++) d[i] -= mean;
  for (let p = 0; p < 3; p++) for (let i = 0; i < N; i++) d[i] = 0.5 * (d[i] + d[i + 1]);
  let ptr = 0, pa = 0, po = 0;
  const i0 = Math.round(startSec * sr);
  for (let i = i0; i < out.length; i++) {
    const nx = (ptr + 1) % (N + 1);
    const avg = 0.9992 * 0.5 * (d[ptr] + d[nx]);
    const o = c * avg + pa - c * po;
    pa = avg; po = o; d[ptr] = o; ptr = nx;
    out[i] += o * gain;
  }
}
function strum(out, sr, midis, startSec, gain = 0.25, seed = 1) {
  midis.forEach((m, k) => pluck(out, sr, m, startSec + k * 0.012, gain, seed + k));
}

const sr=44100; const seq = [40, 40, 43, 45, 45, 45, 52, 55, 57, 57, 64, 67, 69, 69, 76]; const step=0.25;
const out = new Float32Array(Math.round(sr * (seq.length * step + 1)));
seq.forEach((m, i) => { const i0 = Math.round((0.5 + i * step) * sr); for (let j = i0; j < out.length; j++) out[j] *= 0.35; pluck(out, sr, m, 0.5 + i * step, 0.3, i + 1); });
for (let t = 0.2; t < 4.5; t += 1 / 60) { const end=Math.round(t*sr); if(end<8192) continue; const buf=out.subarray(end-8192,end); const k=Math.floor((t-0.5)/step); if(k!==4) continue;
 const r=detectPitch(buf.subarray(8192-2048), sr, {minHz:70,maxHz:1400}); console.log((t-(0.5+k*step)).toFixed(3), r.freq.toFixed(1), freqToMidi(r.freq).toFixed(2), r.clarity.toFixed(2), notePresence(buf,sr,[46,45,44]).map(v=>v.toFixed(2)).join(' ')); }
