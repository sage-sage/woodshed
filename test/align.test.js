import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WIN, SR, fft, alignTab } from '../js/align.js';

describe('align module', () => {
  it('computes fft of a sine wave with peak at the expected bin', () => {
    const targetBin = 82; // ~441.4 Hz at SR=22050, WIN=4096
    const re = new Float64Array(WIN);
    const im = new Float64Array(WIN);
    for (let n = 0; n < WIN; n++) {
      re[n] = Math.sin((2 * Math.PI * targetBin * n) / WIN);
    }

    fft(re, im);

    let peakBin = 0;
    let peakMag = -1;
    for (let k = 0; k <= WIN / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      if (mag > peakMag) {
        peakMag = mag;
        peakBin = k;
      }
    }

    assert.equal(peakBin, targetBin);
  });

  it('aligns an 8-bar C major arpeggio embedded at 1.1x tempo after 6s silence', () => {
    const bpm = 100;
    const beatSec = 60 / bpm; // 0.6s
    const barSec = beatSec * 4; // 2.4s
    const numBars = 8;
    const songDuration = numBars * barSec; // 19.2s
    const arpMidi = [60, 64, 67, 72]; // C4, E4, G4, C5

    const bars = [];
    const notes = [];
    for (let b = 0; b < numBars; b++) {
      const barStart = b * barSec;
      bars.push({ t: barStart, dur: barSec });
      for (let beat = 0; beat < 4; beat++) {
        notes.push({
          midi: arpMidi[beat],
          t: barStart + beat * beatSec,
          dur: beatSec * 0.85
        });
      }
    }

    const song = {
      bpm,
      duration: songDuration,
      bars,
      notes
    };

    const leadSilenceSec = 6.0;
    const trailSilenceSec = 5.0;
    const tempoRatio = 1.1;
    const totalSec = leadSilenceSec + songDuration / tempoRatio + trailSilenceSec;
    const samples = new Float32Array(Math.ceil(totalSec * SR));

    for (const note of notes) {
      const freq = 440 * Math.pow(2, (note.midi - 69) / 12);
      const audioStart = leadSilenceSec + note.t / tempoRatio;
      const audioDur = (note.dur / tempoRatio) + 0.15;
      const startIdx = Math.floor(audioStart * SR);
      const endIdx = Math.min(samples.length, Math.floor((audioStart + audioDur) * SR));

      for (let idx = startIdx; idx < endIdx; idx++) {
        const elapsed = (idx - startIdx) / SR;
        const attack = Math.min(1, elapsed / 0.005);
        const env = attack * Math.exp(-elapsed / 0.25);
        const phase = 2 * Math.PI * freq * elapsed;
        samples[idx] += 0.4 * env * (Math.sin(phase) + 0.25 * Math.sin(2 * phase));
      }
    }

    const result = alignTab(song, samples);

    assert.ok(
      Math.abs(result.startAudio - 6.0) <= 0.15,
      `Expected startAudio within 0.15s of 6.0, got ${result.startAudio}`
    );

    const bar5Tab = bars[4].t; // 9.6s (Bar 5, 1-indexed)
    const expectedBar5Audio = 6.0 + bar5Tab / tempoRatio;
    const bar5Anchor = result.anchors.reduce((best, cur) =>
      Math.abs(cur.tab - bar5Tab) < Math.abs(best.tab - bar5Tab) ? cur : best
    );

    assert.ok(
      Math.abs(bar5Anchor.audio - expectedBar5Audio) <= 0.15,
      `Expected Bar 5 audio within 0.15s of ${expectedBar5Audio.toFixed(3)}, got ${bar5Anchor.audio.toFixed(3)}`
    );
    assert.equal(result.quality, 'good');
  });
});

describe('align: drifting tempo', () => {
  it('keeps every bar within 60 ms when the band speeds up gradually', () => {
    const beat = 0.6;
    const bar = beat * 4;
    const arp = [[60, 64, 67, 72], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67]];
    const bars = [];
    const notes = [];
    for (let b = 0; b < 16; b++) {
      bars.push({ t: b * bar, dur: bar });
      for (let k = 0; k < 4; k++) notes.push({ midi: arp[b % 4][k], t: b * bar + k * beat, dur: beat * 0.85 });
    }
    const song = { bpm: 100, duration: 16 * bar, bars, notes };
    // Recording: 4 s silence, then tempo rising from 1.0x to 1.08x across the song.
    const lead = 4;
    const audioTime = (t) => {
      // integrate speed s(u) = 1 + 0.08 * u / D over tab time: audio = integral of 1/s
      const D = song.duration;
      return lead + (D / 0.08) * Math.log(1 + (0.08 * t) / D);
    };
    const total = audioTime(song.duration) + 4;
    const samples = new Float32Array(Math.ceil(total * SR));
    for (const n of notes) {
      const f = 440 * 2 ** ((n.midi - 69) / 12);
      const a0 = audioTime(n.t);
      const i0 = Math.floor(a0 * SR);
      const i1 = Math.min(samples.length, Math.floor((a0 + 0.6) * SR));
      for (let i = i0; i < i1; i++) {
        const e = (i - i0) / SR;
        const env = Math.min(1, e / 0.005) * Math.exp(-e / 0.25);
        samples[i] += 0.4 * env * (Math.sin(2 * Math.PI * f * e) + 0.25 * Math.sin(4 * Math.PI * f * e));
      }
    }
    const result = alignTab(song, samples);
    let worst = 0;
    for (const a of result.anchors) worst = Math.max(worst, Math.abs(a.audio - audioTime(a.tab)));
    assert.ok(worst <= 0.06, `worst bar error ${(worst * 1000).toFixed(0)} ms`);
  });
});
