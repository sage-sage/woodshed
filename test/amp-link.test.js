import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAudioFrame, JitterBuffer, AmpLink } from '../js/amp-link.js';

function buildWsa1Packet({ sampleRate = 48000, frameIndex = 1, samples }) {
  const buf = new ArrayBuffer(16 + samples.length * 2);
  const view = new DataView(buf);
  [0x57, 0x53, 0x41, 0x31].forEach((b, i) => view.setUint8(i, b)); // "WSA1"
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, frameIndex, true);
  view.setUint32(12, samples.length, true);
  samples.forEach((v, i) => view.setInt16(16 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true));
  return buf;
}

test('decodeAudioFrame decodes the Woodshed Amp WSA1 layout and rejects invalid frames', () => {
  const monoIn = [0.1, -0.25, 0.5, 0.75];
  const monoBuf = buildWsa1Packet({ sampleRate: 48000, frameIndex: 4800, samples: monoIn });
  const d = decodeAudioFrame(monoBuf);
  assert.ok(d);
  assert.equal(d.sampleRate, 48000);
  assert.equal(d.channels, 1);
  assert.equal(d.frames, 4);
  assert.equal(d.seq, 4800);
  monoIn.forEach((v, i) => assert.ok(Math.abs(d.mono[i] - v) < 1e-4, `sample ${i}: ${d.mono[i]}`));

  // A view into a larger buffer at an odd offset
  const padded = new Uint8Array(monoBuf.byteLength + 3);
  padded.set(new Uint8Array(monoBuf), 3);
  const u = decodeAudioFrame(padded.subarray(3));
  assert.ok(u);
  assert.ok(Math.abs(u.mono[2] - 0.5) < 1e-4);

  // Bad magic, truncated payload, zero count, silly rate
  const badMagic = new Uint8Array(monoBuf.slice(0));
  badMagic[0] = 0x58;
  assert.equal(decodeAudioFrame(badMagic.buffer), null);
  assert.equal(decodeAudioFrame(monoBuf.slice(0, 20)), null);
  assert.equal(decodeAudioFrame(buildWsa1Packet({ samples: [] })), null);
  assert.equal(decodeAudioFrame(buildWsa1Packet({ sampleRate: 100, samples: [0.1] })), null);
});

test('JitterBuffer primes to 25ms target and drops/inserts to stay within 10-60ms', () => {
  const jb = new JitterBuffer({ outputRate: 48000, targetMs: 25, minMs: 10, maxMs: 60 });

  // Push 15 ms (720 samples) - still priming, pull outputs silence
  jb.push(new Float32Array(720).fill(0.5), 48000);
  assert.equal(jb.primed, false);
  const out = new Float32Array(128);
  jb.pull(out);
  assert.equal(out[0], 0);

  // Push another 15 ms (total 30 ms = 1440 samples) -> primes!
  jb.push(new Float32Array(720).fill(0.5), 48000);
  assert.equal(jb.primed, true);
  assert.equal(jb.latencyMs, 30);

  // Overflow beyond 60 ms (push 2400 more samples = +50 ms -> 80 ms) -> drops back to 25 ms
  jb.push(new Float32Array(2400).fill(0.25), 48000);
  assert.ok(jb.droppedFrames > 0);
  assert.ok(jb.latencyMs >= 10 && jb.latencyMs <= 60);
  assert.equal(jb.latencyMs, 25);

  // Drain down below 10 ms (1200 frames -> pull 7 * 128 = 896 frames -> 304 frames = 6.33 ms < 10 ms)
  // The buffer tops itself up (faded hold samples) as soon as a pull would leave it under 10 ms.
  for (let i = 0; i < 8; i++) {
    jb.pull(out);
    // it may dip under 10 ms by less than one 128-frame pull (2.7 ms) before topping up
    assert.ok(jb.latencyMs >= 10 - 128 / 48 - 1e-9, `pull ${i}: ${jb.latencyMs} ms`);
  }
  assert.ok(jb.insertedFrames > 0);
  assert.ok(jb.latencyMs >= 10 && jb.latencyMs <= 60);
});

test('JitterBuffer linearly resamples when inputRate differs from outputRate', () => {
  const jb = new JitterBuffer({ outputRate: 48000, targetMs: 25, minMs: 10, maxMs: 60 });

  // Push 1323 samples at 44100 Hz (= 30 ms) -> should yield ~1440 samples at 48000 Hz (= 30 ms)
  const src = new Float32Array(1323);
  for (let i = 0; i < src.length; i++) {
    src[i] = i / src.length;
  }
  jb.push(src, 44100);

  assert.equal(jb.primed, true);
  assert.ok(Math.abs(jb.latencyMs - 30) < 0.2);

  const out = new Float32Array(128);
  jb.pull(out);
  assert.ok(out[0] >= 0 && out[127] > out[0]);
});

test('JitterBuffer holds its target when the interface clock runs 0.3% fast (no creeping delay)', () => {
  const jb = new JitterBuffer({ outputRate: 48000, targetMs: 12, minMs: 4, maxMs: 30 });
  const out = new Float32Array(128);
  let produced = 0;
  let consumed = 0;
  let worst = 0;
  // 60 s: the amp sends 64-sample blocks at 48144 Hz-equivalent pace; the browser pulls 128 at 48000.
  for (let block = 0; block < 60 * 375; block++) {
    const due = Math.floor((consumed + 128) * 1.003);
    while (produced < due) {
      jb.push(new Float32Array(64).fill(0.1));
      produced += 64;
    }
    jb.pull(out);
    consumed += 128;
    if (block > 2000) worst = Math.max(worst, Math.abs(jb.latencyMs - 12));
  }
  assert.ok(worst < 6, `buffer wandered ${worst.toFixed(1)} ms from its 12 ms target`);
});

test('AmpLink.setPreset skips the preset the amp already has, so a presets listener cannot loop', () => {
  const amp = new AmpLink();
  const sent = [];
  amp._ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  const presetsMsg = (current) => amp._handleTextMessage(JSON.stringify({ type: 'presets', current, list: [] }));
  presetsMsg('clean');

  // A listener that re-applies "clean" on every presets message (2.5.3's play screen) sends nothing.
  amp.addEventListener('presets', () => amp.setPreset('clean'));
  assert.equal(amp.setPreset('clean'), false);
  assert.equal(sent.length, 0);

  // A real change is sent; while it is on its way, asking for the old one again is sent too.
  assert.equal(amp.setPreset('crunch'), true);
  assert.equal(amp.setPreset('clean'), true);
  assert.deepEqual(sent.map((m) => m.id), ['crunch', 'clean']);

  // The amp answers: the listener's "clean" now matches and stays quiet.
  presetsMsg('clean');
  assert.equal(sent.length, 2);
});
