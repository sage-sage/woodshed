import { buildEvents, skeletonSong, midiToName } from './song.js';
import { audioToTab, tabToAudio } from './sync.js';
import { judgeNotes, centsOff } from './dsp.js';
import { analyzeSong } from './theory.js';
import { createBackend } from './player.js';
import { GuitarSynth, GuideScheduler, resolveGuideTone } from './synth.js';
import { Highway } from './highway.js';
import { renderFretboard, STRING_COLORS } from './fretboard.js';
import { resumeAudio } from './audio-context.js';
import { suggestTone, TONE_NAMES } from './tone-suggest.js';

export class Game {
  constructor(container, ctx, record) {
    this.container = container;
    this.ctx = ctx;
    this.record = record;
    this.baseSong = record.song;
    this.analysis = analyzeSong(this.baseSong);
    this.toneSuggestion = suggestTone(this.baseSong);
    this.sync = record.sync || { anchors: [] };

    this.level = record.level || 3;
    this.speed = record.speed || 1.0;
    this.mode = 'perform'; // 'perform' | 'wait'
    this.virtualGuitar = new URLSearchParams(globalThis.location?.search || '').get('virtual') === '1';

    this.song = skeletonSong(this.baseSong, this.analysis, this.level);
    this.events = buildEvents(this.song);
    this.eventStates = new Uint8Array(this.events.length);
    this.eventMeta = this.events.map(() => ({
      wasOkBeforeWindow: false,
      enteredWindow: false,
      firstOkTime: null,
      matchedOnsetTime: null,
      centsSamples: []
    }));

    this.state = 'idle'; // 'idle' | 'countin' | 'playing' | 'paused' | 'ended'
    this.stats = {
      score: 0,
      hits: 0,
      misses: 0,
      judged: 0,
      total: this.events.length,
      accuracy: 0,
      streak: 0,
      maxStreak: 0
    };

    this.timingErrorsMs = [];
    this.onsets = []; // [{ tHeard, used: false }]
    this.fx = [];
    this.heardDisplay = null;
    this.heardDisplayUntil = 0;
    this.lastJudgement = { text: 'Ready', kind: '', detail: '' };

    this.stringCentsHistory = Array.from({ length: this.song.tuning.length }, () => []);
    this.tuningToastShown = false;
    this._waitPausedAtEvent = -1;

    this.loop = null; // { barStart, barEnd, t0, t1 }
    this._userZoomed = false;
    this.pxPerSec = this._computeAutoZoom(this.events);

    this.transport = null;
    this.scheduler = null;
    this.highway = null;
    this._rafId = null;
    this._unmounted = false;

    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onVisChange = this._handleVisibilityChange.bind(this);
    this._onAmpChange = () => this._syncToneChip(true);
  }

  async mount() {
    this._renderUI();
    this._updateInputRange();

    const ytHolder = document.getElementById('yt-holder');
    const ytContainer = document.getElementById('yt-player-container');
    if (this.record.audio?.kind === 'youtube' && this.ytDockEl && ytContainer) {
      this.ytDockEl.classList.remove('hidden');
      this.ytDockEl.appendChild(ytContainer);
    }

    let blob = null;
    if (this.record.audio?.kind === 'file') {
      blob = await this.ctx.store.getAudioBlob(this.record.id);
    }

    const silentDur = Math.max(this.song.duration + 2, tabToAudio(this.sync, this.song.duration) + 1);
    this.transport = createBackend(this.record.audio || { kind: 'none' }, {
      container: ytContainer,
      blob,
      duration: silentDur
    });

    this.transport.on('ended', () => {
      if (this.state === 'playing') {
        this._finishRun();
      }
    });
    this.transport.on('error', (e) => {
      this.ctx.toast(e.message || 'Playback error', 'error');
    });

    try {
      await this.transport.load();
    } catch (err) {
      this.ctx.toast(err.message || 'Audio backend failed to load; falling back to internal clock.', 'error');
      this.transport = createBackend({ kind: 'none', duration: silentDur });
      await this.transport.load();
    }

    const appliedRate = this.transport.setRate(this.speed);
    this.speed = appliedRate;
    this.transport.setVolume(this.ctx.settings.get('backingVolume'));

    const hasBacking = this.record.audio && this.record.audio.kind !== 'none';
    const guideVol = this.ctx.settings.get('guideVolume');
    this.ctx.synth.setVolume(guideVol);

    this.scheduler = new GuideScheduler(this.ctx.synth, {
      song: this.song,
      tabTimeNow: () => this.getTabNow(),
      tabToAudio: (t) => tabToAudio(this.sync, t),
      getRate: () => this.transport.rate || 1.0,
      guideEnabled: !hasBacking || guideVol > 0.02 || this.virtualGuitar,
      metronomeEnabled: Boolean(this.ctx.settings.get('metronome'))
    });

    if (this.virtualGuitar) {
      this._setVirtualGuitar(true);
    }

    this.highway = new Highway(this.canvasEl);
    this.highway.setSong(this.song, this.events);
    this.highway.setView({ pxPerSec: this.pxPerSec });
    this.highway.onSeek((tabT) => this.seekTab(tabT));

    this.seekTab(hasBacking ? -this._getLeadIn() : 0);

    window.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('visibilitychange', this._onVisChange);
    this.ctx.amp?.addEventListener('state', this._onAmpChange);
    this.ctx.amp?.addEventListener('presets', this._onAmpChange);
    this._syncToneChip(true);
    this._applyGuideTone();
    this._unsubSettings = this.ctx.settings.onChange?.((key, value) => {
      if (key === 'guideTone') {
        this._applyGuideTone();
        const sel = this.container.querySelector('#ctrl-guide-tone');
        if (sel && sel.value !== value) sel.value = value;
      }
    });

    this._syncControlsUI();
    this._loopFrame();

    if (this.virtualGuitar) {
      this.start();
    }
  }

  _updateInputRange() {
    const lowest = Math.min(...this.song.tuning) + (this.song.capo || 0);
    const highest = Math.max(...this.song.tuning) + (this.song.capo || 0) + 24;
    this.ctx.input.setRange(lowest, highest);
    this.ctx.input.setA4(this.ctx.settings.get('a4'));
  }

  _setVirtualGuitar(on) {
    this.virtualGuitar = Boolean(on);
    this.ctx.synth.setSelfTestRoute(this.ctx.input, this.virtualGuitar, 0.9);
    if (this.scheduler) {
      const hasBacking = this.record.audio && this.record.audio.kind !== 'none';
      this.scheduler.setOptions({
        guideEnabled: this.virtualGuitar || !hasBacking || this.ctx.settings.get('guideVolume') > 0.02
      });
    }
    if (this.demoBtnEl) {
      this.demoBtnEl.classList.toggle('btn-primary', this.virtualGuitar);
      this.demoBtnEl.textContent = this.virtualGuitar ? 'Demo Autoplay: ON' : 'Demo: Watch It Play Itself';
    }
  }

  getTabNow() {
    if (!this.transport) return 0;
    return audioToTab(this.sync, this.transport.currentTime);
  }

  getTabHeard() {
    if (!this.transport) return 0;
    let latencyMs = Number(this.ctx.settings.get('latencyMs')) || 0;
    if (this.virtualGuitar) {
      latencyMs = 15;
    } else if (this.ctx.input?.sourceKind === 'amp') {
      const rt = Number(this.ctx.amp?.status?.roundTripMs) || 0;
      const streamMs = Number(this.ctx.amp?.streamLatencyMs) || 0;
      latencyMs = rt / 2 + streamMs + latencyMs;
    }
    const rate = this.transport.rate || 1.0;
    return audioToTab(this.sync, this.transport.currentTime - (latencyMs / 1000) * rate);
  }

  _computeAutoZoom(events) {
    const gaps = [];
    for (let i = 1; i < events.length; i++) {
      const gap = events[i].t - events[i - 1].t;
      if (gap >= 0.03) gaps.push(gap);
    }
    if (gaps.length === 0) return 240;
    gaps.sort((a, b) => a - b);
    const g = gaps[Math.floor(0.15 * (gaps.length - 1))];
    // ~60 px per closest-gap: room for a two-digit pill plus a slide/hammer connector between notes.
    const stepped = Math.round((60 / g) / 20) * 20;
    return Math.min(420, Math.max(160, stepped));
  }

  _getLeadIn() {
    const firstBarDur = this.song?.bars?.[0]?.dur || 2;
    return Math.min(4, Math.max(1.5, firstBarDur));
  }

  _hasBackingAudio() {
    return Boolean(this.record.audio && this.record.audio.kind !== 'none');
  }

  seekTab(tabTime) {
    const leadIn = this._getLeadIn();
    const clamped = Math.max(-leadIn, Math.min(this.song.duration, Number(tabTime) || 0));
    const audioT = Math.max(0, tabToAudio(this.sync, clamped));
    if (this.transport) {
      this.transport.seek(audioT);
    }
    if (this.scheduler) {
      this.scheduler.reset();
    }
    this._waitPausedAtEvent = -1;
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i].t >= clamped - 0.02) {
        if (this.eventStates[i] !== 1) {
          this.eventStates[i] = 0;
          this.eventMeta[i].enteredWindow = false;
          this.eventMeta[i].firstOkTime = null;
          this.eventMeta[i].okFrames = 0;
          this.eventMeta[i].okSince = null;
        }
      }
    }
  }

  async start() {
    await resumeAudio();
    if (this.state === 'ended' || this.getTabNow() >= this.song.duration - 0.05) {
      this.restart();
      return;
    }
    if (this.state === 'playing' || this.state === 'countin') return;

    const atBeginning = this.getTabNow() <= 0.15;
    if (atBeginning && !this._hasBackingAudio() && this.ctx.settings.get('countIn') && !this.virtualGuitar) {
      this.state = 'countin';
      this._updatePlayButtonUI();
      await this.scheduler.playCountIn(this.speed);
      if (this._unmounted || this.state !== 'countin') return;
    }

    this.state = 'playing';
    this.transport.play();
    this.scheduler.start();
    this._updatePlayButtonUI();
  }

  pause() {
    if (this.state !== 'playing' && this.state !== 'countin') return;
    this.state = 'paused';
    this.transport.pause();
    this.scheduler.stop();
    this._updatePlayButtonUI();
  }

  restart() {
    this.transport.pause();
    this.scheduler.stop();
    this.eventStates.fill(0);
    this.eventMeta.forEach((m) => {
      m.wasOkBeforeWindow = false;
      m.enteredWindow = false;
      m.firstOkTime = null;
      m.okFrames = 0;
      m.okSince = null;
      m.matchedOnsetTime = null;
      m.centsSamples = [];
    });
    this.onsets = [];
    this.fx = [];
    this.timingErrorsMs = [];
    this.stats = {
      score: 0,
      hits: 0,
      misses: 0,
      judged: 0,
      total: this.events.length,
      accuracy: 0,
      streak: 0,
      maxStreak: 0
    };
    this._waitPausedAtEvent = -1;
    this.lastJudgement = { text: 'Ready', kind: '', detail: '' };
    const leadIn = this._getLeadIn();
    const startTab = this.loop
      ? Math.max(-leadIn, this.loop.t0 - 1.0)
      : (this._hasBackingAudio() ? -leadIn : 0);
    this.seekTab(startTab);
    this.state = 'idle';
    this._updateHUD();
    this._updatePlayButtonUI();
    this.start();
  }

  setLevel(level) {
    const nextLvl = [1, 2, 3].includes(Number(level)) ? Number(level) : 3;
    const wasPlaying = this.state === 'playing';
    this.pause();
    this.level = nextLvl;
    this.song = skeletonSong(this.baseSong, this.analysis, this.level);
    this.events = buildEvents(this.song);
    this.eventStates = new Uint8Array(this.events.length);
    this.eventMeta = this.events.map(() => ({
      wasOkBeforeWindow: false,
      enteredWindow: false,
      firstOkTime: null,
      matchedOnsetTime: null,
      centsSamples: []
    }));
    this.stats.total = this.events.length;
    if (!this._userZoomed) {
      this.pxPerSec = this._computeAutoZoom(this.events);
      this.highway.setView({ pxPerSec: this.pxPerSec });
    }
    this.highway.setSong(this.song, this.events);
    this.scheduler.setSong(this.song);
    this.record.level = this.level;
    this.ctx.saveRecord(this.record);
    this._syncControlsUI();
    if (wasPlaying) this.start();
  }

  setSpeed(newSpeed) {
    const desired = Math.max(0.5, Math.min(1.25, Math.round(Number(newSpeed) * 20) / 20));
    const applied = this.transport ? this.transport.setRate(desired) : desired;
    this.speed = applied;
    this.record.speed = applied;
    this.ctx.saveRecord(this.record);
    this._syncControlsUI();
  }

  _loopFrame() {
    if (this._unmounted) return;
    this._stepFrame();
    this._rafId = requestAnimationFrame(() => this._loopFrame());
  }

  _stepFrame() {
    // If the browser stopped drawing for a while (window covered, machine stalled) the clock ran on without
    // anything being judged. Pause and go back to where the last frame was, so no notes are lost unseen.
    const frameMs = performance.now();
    if (this.state === 'playing' && this._lastFrameMs && frameMs - this._lastFrameMs > 400
      && this._waitPausedAtEvent === -1) {
      this.pause();
      this.seekTab(this._lastFrameTab || 0);
      this.ctx.toast('Paused: the page stopped updating for a moment. Press Space to carry on.', 'info');
    }
    this._lastFrameMs = frameMs;

    const frame = this.ctx.input.read();
    const a4 = this.ctx.settings.get('a4') || 440;
    const tabNow = this.getTabNow();
    const tHeard = this.getTabHeard();
    this._lastFrameTab = tabNow;
    const rate = this.transport?.rate || 1.0;

    if (frame.onset) {
      this.onsets.push({ tHeard, used: false, wallMs: performance.now() });
      if (this.onsets.length > 48) this.onsets.shift();
    }

    // Handle A-B bar loop wraparound
    if (this.state === 'playing' && this.loop && tabNow >= this.loop.t1) {
      this.transport.pause();
      this.scheduler.stop();
      for (let i = 0; i < this.events.length; i++) {
        if (this.events[i].t >= this.loop.t0 - 0.02 && this.events[i].t <= this.loop.t1 + 0.02) {
          this.eventStates[i] = 0;
          this.eventMeta[i].enteredWindow = false;
          this.eventMeta[i].firstOkTime = null;
          this.eventMeta[i].okFrames = 0;
          this.eventMeta[i].okSince = null;
        }
      }
      this.seekTab(this.loop.t0);
      const beatGapMs = Math.round(((60 / (this.song.bpm || 120)) / rate) * 1000);
      setTimeout(() => {
        if (!this._unmounted && this.state === 'playing') {
          this.transport.play();
          this.scheduler.start();
        }
      }, Math.min(600, beatGapMs));
      return;
    }

    // Check song completion
    if (this.state === 'playing' && tabNow >= this.song.duration + 0.5) {
      this._finishRun();
      return;
    }

    if (this.state === 'playing') {
      if (this.mode === 'wait') {
        this._stepWaitMode(frame, tabNow, a4);
      } else {
        this._stepPerformMode(frame, tHeard, rate, a4);
      }
    }

    // Sustain tuning watch on recently hit single notes
    this._sampleTuningWatch(frame, tHeard, a4);

    // Update live highway and mini fretboard
    const nowMs = performance.now();
    let activeHeard = null;
    if (frame.midi > 0 && frame.clarity >= 0.65) {
      const rounded = Math.round(frame.midi);
      const cents = centsOff(frame.freq, rounded, a4);
      activeHeard = { midi: rounded, cents, wrong: false };
    } else if (this.heardDisplay && nowMs < this.heardDisplayUntil) {
      activeHeard = this.heardDisplay;
    }

    this.highway.render({
      tabNow,
      states: this.eventStates,
      heard: activeHeard,
      loop: this.loop,
      fx: this.fx,
      showNoteNames: Boolean(this.ctx.settings.get('showNoteNames'))
    });

    this._renderNextEventFretboard(tabNow, activeHeard);
    this._updateTransportReadout(tabNow);
  }

  _evalEventNotes(frame, ev, a4) {
    const baseMidis = ev.notes.map((n) => n.midi);
    const res = judgeNotes(frame.buf, frame.sampleRate, baseMidis, frame.freq, a4);
    if (res.ok) return res;

    // Check optional n.bend (accept midi .. midi + bend)
    if (ev.notes.some((n) => n.bend && n.bend > 0)) {
      const bentMidis = ev.notes.map((n) => {
        if (!n.bend || frame.midi <= 0) return n.midi;
        const clamped = Math.max(n.midi, Math.min(n.midi + n.bend, Math.round(frame.midi)));
        return clamped;
      });
      return judgeNotes(frame.buf, frame.sampleRate, bentMidis, frame.freq, a4);
    }
    return res;
  }

  _stepWaitMode(frame, tabNow, a4) {
    const nextIdx = this.events.findIndex((ev, idx) => this.eventStates[idx] === 0 || this.eventStates[idx] === 3);
    if (nextIdx === -1) return;

    const ev = this.events[nextIdx];
    if (tabNow < ev.t - 0.02) return;

    const judge = this._evalEventNotes(frame, ev, a4);
    if (this._waitPausedAtEvent !== nextIdx) {
      this._waitPausedAtEvent = nextIdx;
      this.eventStates[nextIdx] = 3; // waiting pulse
      this.transport.pause();
      this.scheduler.stop();
      // If the wanted notes are already ringing (a repeated note), only a fresh attack counts.
      this._waitArmed = !judge.ok;
      this._waitOkFrames = 0;
    }
    if (!judge.ok) {
      this._waitArmed = true;
      this._waitOkFrames = 0;
      return;
    }
    if (frame.onset) this._waitArmed = true;
    this._waitOkFrames++;
    if (this._waitArmed && this._waitOkFrames >= 2) {
      this.eventStates[nextIdx] = 1;
      this._waitPausedAtEvent = -1;
      this._recordHit(ev, 0);
      this.transport.play();
      this.scheduler.start();
    }
  }

  /**
   * The stretch of (heard) tab time in which an attack counts for event i: +-hitWin around the event,
   * cut at the halfway point to its neighbours so that windows never overlap and every attack belongs to
   * exactly one event.
   */
  _eventWindow(i, hitWinSec) {
    const t = this.events[i].t;
    const prev = i > 0 ? this.events[i - 1].t : -Infinity;
    const next = i < this.events.length - 1 ? this.events[i + 1].t : Infinity;
    return [Math.max(t - hitWinSec, (prev + t) / 2), Math.min(t + hitWinSec, (t + next) / 2)];
  }

  _stepPerformMode(frame, tHeard, rate, a4) {
    const hitWinSec = ((Number(this.ctx.settings.get('hitWindowMs')) || 110) / 1000) * rate;
    const confirmSec = 0.16 * rate; // the right notes may be confirmed this long after the window closes
    const lagSec = 0.04 * rate; // typical delay between an attack and the detector agreeing on the notes
    const lookBackSec = 0.15 * rate;

    for (let i = 0; i < this.events.length; i++) {
      if (this.eventStates[i] !== 0) continue;
      const ev = this.events[i];
      const meta = this.eventMeta[i];
      const [winStart, winEnd] = this._eventWindow(i, hitWinSec);
      if (tHeard < winStart - lookBackSec) break;

      // Track how long this event's notes have been sounding without a break.
      const ok = this._evalEventNotes(frame, ev, a4).ok;
      if (ok) {
        if (!meta.okFrames) meta.okSince = tHeard;
        meta.okFrames = (meta.okFrames || 0) + 1;
      } else {
        meta.okFrames = 0;
        meta.okSince = null;
      }
      if (tHeard < winStart) continue;

      if (tHeard > winEnd + confirmSec) {
        this.eventStates[i] = 2;
        this._recordMiss(ev);
        continue;
      }

      // The attack nearest to the event inside its window, if any.
      let onset = null;
      for (const o of this.onsets) {
        if (o.used || o.tHeard < winStart || o.tHeard > winEnd) continue;
        if (!onset || Math.abs(o.tHeard - ev.t) < Math.abs(onset.tHeard - ev.t)) onset = o;
      }

      if (ok && meta.okFrames >= 2) {
        // Either a pick attack landed in the window, or (hammer-ons, slides, soft attacks) the notes
        // started sounding inside it. Notes that were already ringing before the window need an attack.
        const began = meta.okSince - lagSec;
        const beganInside = meta.okSince >= winStart && began <= winEnd;
        if (onset || beganInside) {
          if (onset) onset.used = true;
          this.eventStates[i] = 1;
          const errSec = onset ? onset.tHeard - ev.t : began - ev.t;
          this._recordHit(ev, errSec / rate);
          continue;
        }
      } else if (!ok && onset && frame.freq > 0 && frame.clarity >= 0.8) {
        const wrongMidi = Math.round(frame.midi);
        const cents = centsOff(frame.freq, wrongMidi, a4);
        this.heardDisplay = { midi: wrongMidi, cents, wrong: true };
        this.heardDisplayUntil = performance.now() + 550;
      }
    }
  }

  _recordHit(ev, errRealSec) {
    const absErrMs = Math.abs(errRealSec) * 1000;
    this.timingErrorsMs.push(errRealSec * 1000);

    this.stats.hits++;
    this.stats.judged++;
    this.stats.streak++;
    if (this.stats.streak > this.stats.maxStreak) {
      this.stats.maxStreak = this.stats.streak;
    }

    const mult = Math.min(4, 1 + Math.floor(this.stats.streak / 10));
    let basePts = 50;
    let label = 'OK';
    let kind = 'great';
    if (absErrMs <= 35) {
      basePts = 100;
      label = 'Perfect';
      kind = 'perfect';
    } else if (absErrMs <= 70) {
      basePts = 75;
      label = 'Great';
      kind = 'great';
    }

    this.stats.score += basePts * mult;
    this.stats.accuracy = this.stats.judged > 0 ? this.stats.hits / this.stats.judged : 0;

    const dir = Math.abs(errRealSec * 1000) < 10 ? '' : (errRealSec < 0 ? ' (early)' : ' (late)');
    this.lastJudgement = { text: `${label}${dir}`, kind };

    const nowMs = performance.now();
    for (const n of ev.notes) {
      this.fx.push({
        string: n.string,
        born: nowMs,
        color: STRING_COLORS[n.string % STRING_COLORS.length]
      });
    }
    if (this.fx.length > 30) this.fx.splice(0, this.fx.length - 30);

    this._updateHUD();
  }

  _recordMiss() {
    this.stats.misses++;
    this.stats.judged++;
    this.stats.streak = 0;
    this.stats.accuracy = this.stats.judged > 0 ? this.stats.hits / this.stats.judged : 0;
    this.lastJudgement = { text: 'Miss', kind: 'miss' };
    this._updateHUD();
  }

  _sampleTuningWatch(frame, tHeard, a4) {
    if (this.virtualGuitar || frame.freq <= 0 || frame.clarity < 0.8) return;
    for (let i = 0; i < this.events.length; i++) {
      if (this.eventStates[i] !== 1) continue;
      const ev = this.events[i];
      if (ev.notes.length !== 1) continue;
      const n = ev.notes[0];
      if (n.tech === 'bend' || n.tech === 'vib' || n.bend > 0) continue;

      if (tHeard >= ev.t && tHeard <= ev.t + Math.min(0.6, n.dur)) {
        const c = centsOff(frame.freq, n.midi, a4);
        if (Math.abs(c) <= 45) {
          const meta = this.eventMeta[i];
          meta.centsSamples.push(c);
          if (meta.centsSamples.length === 4) {
            const avg = meta.centsSamples.reduce((a, b) => a + b, 0) / meta.centsSamples.length;
            const hist = this.stringCentsHistory[n.string];
            hist.push(avg);
            if (hist.length > 8) hist.shift();
            this._checkStringOutOfTune(n.string);
          }
        }
      }
    }
  }

  _checkStringOutOfTune(stringIndex) {
    if (this.tuningToastShown) return;
    const hist = this.stringCentsHistory[stringIndex];
    if (hist.length < 4) return;
    const sorted = [...hist].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (Math.abs(median) > 15) {
      this.tuningToastShown = true;
      const strName = midiToName(this.song.tuning[stringIndex] + (this.song.capo || 0)).replace(/\d+$/, '');
      const dir = median < 0 ? 'flat' : 'sharp';
      this.ctx.toast(
        `Your ${strName} string sounds about ${Math.round(Math.abs(median))} cents ${dir} — open the tuner`,
        'info',
        { actionLabel: 'Open Tuner', onAction: () => this.ctx.navigate('#/tuner') }
      );
    }
  }

  _computeStars(acc) {
    if (acc >= 0.97) return 5;
    if (acc >= 0.90) return 4;
    if (acc >= 0.80) return 3;
    if (acc >= 0.65) return 2;
    if (acc >= 0.50) return 1;
    return 0;
  }

  async _finishRun() {
    this.state = 'ended';
    this.transport.pause();
    this.scheduler.stop();
    this._updatePlayButtonUI();

    for (let i = 0; i < this.events.length; i++) {
      if (this.eventStates[i] === 0) {
        this._recordMiss(this.events[i]);
        this.eventStates[i] = 2;
      }
    }

    const perBar = (this.song.bars || []).map((b) => {
      let hits = 0;
      let total = 0;
      const bEnd = b.t + b.dur;
      for (let i = 0; i < this.events.length; i++) {
        const st = this.eventStates[i];
        if (st !== 1 && st !== 2) continue;
        const ev = this.events[i];
        if (ev.t >= b.t && ev.t < bEnd) {
          total++;
          if (st === 1) hits++;
        }
      }
      return { hits, total };
    });

    const acc = this.stats.accuracy;
    const stars = this._computeStars(acc);
    const prevBest = this.record.best;
    const isNewBest = this.mode === 'perform' && !this.virtualGuitar && (!prevBest || this.stats.score > prevBest.score);

    if (this.mode === 'perform' && !this.virtualGuitar) {
      const entry = {
        date: new Date().toISOString(),
        score: this.stats.score,
        accuracy: Number(acc.toFixed(4)),
        level: this.level,
        speed: this.speed
      };
      this.record.history = [...(this.record.history || []), entry].slice(-30);
      if (isNewBest) {
        this.record.best = {
          score: this.stats.score,
          accuracy: Number(acc.toFixed(4)),
          stars,
          date: entry.date
        };
      }
      await this.ctx.saveRecord(this.record);
    }

    this._showResultsModal(stars, prevBest, perBar);
  }

  _loopBars(a, b) {
    const bars = this.song.bars || [];
    if (!bars[a - 1] || !bars[b - 1]) return;
    this.loop = {
      barStart: a,
      barEnd: b,
      t0: bars[a - 1].t,
      t1: bars[b - 1].t + bars[b - 1].dur
    };
    const inputA = document.getElementById('loop-bar-a');
    const inputB = document.getElementById('loop-bar-b');
    if (inputA) inputA.value = String(a);
    if (inputB) inputB.value = String(b);
    const modalRoot = document.getElementById('modal-root');
    if (modalRoot) modalRoot.classList.add('hidden');
    this.restart();
  }

  _showResultsModal(stars, prevBest, perBar = []) {
    const modalRoot = document.getElementById('modal-root');
    if (!modalRoot) return;

    const isNewBest = this.mode === 'perform' && !this.virtualGuitar && (!prevBest || this.stats.score > prevBest.score);
    const starStr = '★'.repeat(stars) + '☆'.repeat(5 - stars);
    const avgErr = this.timingErrorsMs.length > 0
      ? Math.round(this.timingErrorsMs.reduce((a, b) => a + b, 0) / this.timingErrorsMs.length)
      : 0;

    // Bar-by-bar strip cells
    const barCellsHtml = perBar.map((b, idx) => {
      const barNum = idx + 1;
      let cls = 'res-bar-empty';
      let label = `Bar ${barNum}: no notes`;
      if (b.total > 0) {
        const bAcc = b.hits / b.total;
        const pct = Math.round(bAcc * 100);
        cls = bAcc >= 0.9 ? 'res-bar-good' : bAcc >= 0.7 ? 'res-bar-warn' : 'res-bar-bad';
        label = `Bar ${barNum}: ${pct}% (${b.hits}/${b.total})`;
      }
      return `<button type="button" class="res-bar-cell ${cls}" data-bar="${barNum}" title="${label}" aria-label="${label}"></button>`;
    }).join('');

    // Weakest stretch window
    let weakHtml = '<p class="res-weak-line">Clean run: no weak spots.</p>';
    let weakRange = null;
    if (perBar.length > 0) {
      const winLen = Math.min(4, perBar.length);
      let maxMisses = 0;
      let bestStart = 0;
      for (let start = 0; start <= perBar.length - winLen; start++) {
        let misses = 0;
        for (let j = start; j < start + winLen; j++) {
          misses += (perBar[j].total - perBar[j].hits);
        }
        if (misses > maxMisses) {
          maxMisses = misses;
          bestStart = start;
        }
      }
      if (maxMisses > 0) {
        const a = bestStart + 1;
        const b = bestStart + winLen;
        weakRange = [a, b];
        weakHtml = `
          <div class="res-weak-row">
            <p class="res-weak-line">Bars ${a}–${b}: ${maxMisses} missed note${maxMisses === 1 ? "" : "s"}</p>
            <button type="button" class="btn btn-primary btn-sm" id="res-loop-weak-btn">Loop bars ${a}–${b}</button>
          </div>
        `;
      }
    }

    // Progress sparkline
    let progressHtml = '';
    if (this.mode !== 'perform' || this.virtualGuitar) {
      progressHtml = '<p class="res-progress-msg">Progress is tracked in Perform mode with a real guitar.</p>';
    } else {
      const hist = Array.isArray(this.record.history) ? this.record.history : [];
      if (hist.length < 2) {
        progressHtml = '<p class="res-progress-msg">Play again to start a progress line.</p>';
      } else {
        const scores = hist.map((h) => h.score || 0);
        const minS = Math.min(...scores);
        const maxS = Math.max(...scores);
        const span = maxS - minS;
        const padX = 6;
        const padY = 6;
        const pts = scores.map((s, idx) => {
          const x = padX + (idx / (scores.length - 1)) * (300 - 2 * padX);
          const y = span === 0 ? 24 : (48 - padY) - ((s - minS) / span) * (48 - 2 * padY);
          return { x, y };
        });
        const pointsAttr = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        const lastPt = pts[pts.length - 1];
        progressHtml = `
          <div class="res-spark-box">
            <svg class="res-sparkline" viewBox="0 0 300 48" preserveAspectRatio="none">
              <polyline fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${pointsAttr}" />
              <path d="M${lastPt.x.toFixed(1)} ${lastPt.y.toFixed(1)}h0" stroke="var(--accent)" stroke-width="7" stroke-linecap="round" vector-effect="non-scaling-stroke" />
            </svg>
          </div>
          <p class="res-progress-cap">${hist.length} runs · best ${maxS} pts</p>
        `;
      }
    }

    // Build 5-bucket timing histogram (-100..-50, -50..-15, -15..15, 15..50, 50..100)
    const buckets = [0, 0, 0, 0, 0];
    for (const e of this.timingErrorsMs) {
      if (e < -45) buckets[0]++;
      else if (e < -15) buckets[1]++;
      else if (e <= 15) buckets[2]++;
      else if (e <= 45) buckets[3]++;
      else buckets[4]++;
    }
    const maxB = Math.max(1, ...buckets);

    const stringReports = this.song.tuning.map((openMidi, s) => {
      const name = midiToName(openMidi + (this.song.capo || 0));
      const hist = this.stringCentsHistory[s];
      if (hist.length === 0) return `<span class="chip">${name}: —</span>`;
      const avg = Math.round(hist.reduce((a, b) => a + b, 0) / hist.length);
      const cls = Math.abs(avg) <= 10 ? 'chip-success' : 'chip-accent';
      return `<span class="chip ${cls}">${name}: ${avg >= 0 ? '+' : ''}${avg}c</span>`;
    }).join(' ');

    modalRoot.innerHTML = `
      <div class="modal res-modal">
        <div class="res-header">
          <div class="res-title-row">
            <h2 class="res-title">Run complete</h2>
            ${isNewBest ? '<span class="chip res-new-best">New best</span>' : ''}
          </div>
          <div class="stars-display res-stars">${starStr}</div>
        </div>

        <div class="res-stats-grid">
          <div class="stat card-raised res-stat-tile">
            <span class="stat-label">Score</span>
            <span class="stat-value">${this.stats.score}</span>
          </div>
          <div class="stat card-raised res-stat-tile">
            <span class="stat-label">Accuracy</span>
            <span class="stat-value">${(this.stats.accuracy * 100).toFixed(1)}%</span>
          </div>
          <div class="stat card-raised res-stat-tile">
            <span class="stat-label">Max Streak</span>
            <span class="stat-value">${this.stats.maxStreak}</span>
          </div>
          <div class="stat card-raised res-stat-tile">
            <span class="stat-label">Avg Timing</span>
            <span class="stat-value">${avgErr >= 0 ? '+' : ''}${avgErr} ms</span>
          </div>
        </div>

        <p class="res-prev-best">
          ${prevBest ? `Previous Best: ${prevBest.score} pts (${(prevBest.accuracy * 100).toFixed(1)}%)` : 'First recorded run on this track!'}
        </p>

        ${perBar.length > 0 ? `
          <div class="res-section">
            <div class="res-section-label">Bar by bar</div>
            <div class="res-bar-strip">${barCellsHtml}</div>
            <div class="res-bar-axis"><span>1</span><span>${perBar.length}</span></div>
          </div>
        ` : ''}

        <div class="res-section">
          <div class="res-section-label">Weakest stretch</div>
          ${weakHtml}
        </div>

        <div class="res-section">
          <div class="res-section-label">Progress</div>
          ${progressHtml}
        </div>

        <div class="res-section">
          <div class="res-section-label">Timing Distribution (Early vs On-Time vs Late)</div>
          <div class="res-hist">
            ${['Early', 'Slight Early', 'Center', 'Slight Late', 'Late'].map((lbl, idx) => {
              const step = Math.round((buckets[idx] / maxB) * 10);
              return `
                <div class="res-hist-col">
                  <div class="res-hist-bar res-hist-h-${step}${idx === 2 ? ' is-center' : ''}"></div>
                  <span class="res-hist-lbl">${lbl}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <div class="res-section">
          <div class="res-section-label">Per-String Intonation Report</div>
          <div class="res-chips">${stringReports}</div>
        </div>

        <div class="res-actions">
          <button type="button" class="btn btn-ghost" id="res-close-btn">Close</button>
          <button type="button" class="btn" id="res-learn-btn">Open Learn View</button>
          <button type="button" class="btn" id="res-slower-btn">Try at ${Math.max(50, Math.round((this.speed - 0.1) * 100))}% Speed</button>
          <button type="button" class="btn btn-primary" id="res-retry-btn">Play Again</button>
        </div>
      </div>
    `;
    modalRoot.classList.remove('hidden');

    modalRoot.querySelectorAll('.res-bar-cell').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = Number(btn.dataset.bar);
        if (n >= 1) this._loopBars(n, n);
      });
    });

    if (weakRange) {
      modalRoot.querySelector('#res-loop-weak-btn')?.addEventListener('click', () => {
        this._loopBars(weakRange[0], weakRange[1]);
      });
    }

    const closeModal = () => modalRoot.classList.add('hidden');
    modalRoot.querySelector('#res-close-btn')?.addEventListener('click', closeModal);
    modalRoot.querySelector('#res-retry-btn')?.addEventListener('click', () => {
      closeModal();
      this.restart();
    });
    modalRoot.querySelector('#res-slower-btn')?.addEventListener('click', () => {
      closeModal();
      this.setSpeed(Math.max(0.5, this.speed - 0.1));
      this.restart();
    });
    modalRoot.querySelector('#res-learn-btn')?.addEventListener('click', () => {
      closeModal();
      this.ctx.navigate(`#/song/${this.record.id}/learn`);
    });
  }

  _renderUI() {
    const barOptions = this.song.bars.map((_, idx) => `<option value="${idx + 1}">Bar ${idx + 1}</option>`).join('');
    const inputLive = this.ctx.input.state === 'live';
    const showFingering = this.ctx.settings.get('showFingering') !== false;
    const guideVolInit = Number(this.ctx.settings.get('guideVolume') ?? 0.7);
    const backingVolInit = Number(this.ctx.settings.get('backingVolume') ?? 0.85);
    const totalBars = Math.max(1, this.song.bars.length);
    const padLen = Math.max(2, String(totalBars).length);
    const guideToneOptions = GuitarSynth.TONES
      .filter((id) => id !== 'clean')
      .map((id) => `<option value="${id}">${TONE_NAMES[id] || id}</option>`)
      .join('');

    this.container.innerHTML = `
      <div class="play-layout">
        <header class="play-hud-bar">
          <div class="hud-metrics">
            <div class="hud-stat">
              <span class="hud-stat-label">Score</span>
              <span class="hud-stat-value tabular" id="hud-score">0</span>
            </div>
            <div class="hud-stat">
              <span class="hud-stat-label">Streak</span>
              <span class="hud-stat-value tabular" id="hud-streak">0 <small class="hud-streak-mult">x1</small></span>
            </div>
            <div class="hud-stat">
              <span class="hud-stat-label">Accuracy</span>
              <span class="hud-stat-value tabular" id="hud-accuracy">100%</span>
            </div>
          </div>

          <div class="judgement-pill" id="hud-judgement" role="status" aria-live="polite">Ready</div>

          <div class="hud-actions">
            ${!inputLive ? `<button type="button" class="btn btn-sm btn-primary" id="play-connect-btn">Connect Guitar</button>` : ''}
            <button type="button" class="btn btn-sm" id="play-demo-btn">Demo: Watch It Play Itself</button>
          </div>
        </header>

        <section class="play-screen" aria-label="Tab Highway Screen">
          <div class="play-screen-top">
            <span id="play-bar-readout">BAR ${String(1).padStart(padLen, '0')} / ${String(totalBars).padStart(padLen, '0')}</span>
            <span id="transport-time">0:00 / 0:00</span>
          </div>
          <div class="highway-stage">
            <canvas id="highway-canvas"></canvas>
            <div id="yt-pip-dock" class="yt-pip-dock hidden"></div>
          </div>
          <div class="play-fretboard-strip${showFingering ? '' : ' hidden'}" id="play-fretboard-wrap">
            <div id="play-mini-fretboard" class="fretboard"></div>
          </div>
        </section>

        <section class="play-deck" aria-label="Amp Control Deck">
          <div class="deck-transport">
            <button type="button" class="play-btn-main" id="btn-play-toggle" aria-label="Play" title="Play / Pause (Space)">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true"><polygon points="7,5 20,12 7,19"></polygon></svg>
            </button>
            <button type="button" class="btn deck-restart-btn" id="btn-restart" aria-label="Restart" title="Restart (R)">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path></svg>
              <span>Restart</span>
            </button>
            <div class="deck-loop">
              <span class="deck-loop-label">Loop</span>
              <select class="select deck-loop-select" id="loop-bar-a" aria-label="Loop start bar">
                <option value="">Off</option>
                ${barOptions}
              </select>
              <span class="deck-loop-sep" aria-hidden="true">-</span>
              <select class="select deck-loop-select" id="loop-bar-b" aria-label="Loop end bar">
                <option value="">Off</option>
                ${barOptions}
              </select>
              <button type="button" class="btn btn-sm btn-ghost deck-loop-clear" id="btn-clear-loop" aria-label="Clear loop">Clear</button>
            </div>
          </div>

          <div class="deck-knobs">
            <div class="amp-knob">
              <div class="amp-knob-dial">
                <span class="amp-knob-pointer" aria-hidden="true"></span>
                <input type="range" id="ctrl-speed" min="0.5" max="1.25" step="0.05" value="${this.speed}" aria-label="Speed" />
              </div>
              <label class="amp-knob-label" for="ctrl-speed">Speed</label>
              <span class="amp-knob-val tabular" id="ctrl-speed-val">${Math.round(this.speed * 100)}%</span>
            </div>

            <div class="amp-knob">
              <div class="amp-knob-dial">
                <span class="amp-knob-pointer" aria-hidden="true"></span>
                <input type="range" id="ctrl-guide-vol" min="0" max="1" step="0.05" value="${guideVolInit}" aria-label="Guide Volume" />
              </div>
              <label class="amp-knob-label" for="ctrl-guide-vol">Guide Vol</label>
              <span class="amp-knob-val tabular" id="ctrl-guide-vol-val">${Math.round(guideVolInit * 100)}%</span>
            </div>

            <div class="amp-knob">
              <div class="amp-knob-dial">
                <span class="amp-knob-pointer" aria-hidden="true"></span>
                <input type="range" id="ctrl-backing-vol" min="0" max="1" step="0.05" value="${backingVolInit}" aria-label="Backing Volume" />
              </div>
              <label class="amp-knob-label" for="ctrl-backing-vol">Backing Vol</label>
              <span class="amp-knob-val tabular" id="ctrl-backing-vol-val">${Math.round(backingVolInit * 100)}%</span>
            </div>

            <div class="amp-knob">
              <div class="amp-knob-dial">
                <span class="amp-knob-pointer" aria-hidden="true"></span>
                <input type="range" id="ctrl-zoom" min="140" max="420" step="20" value="${this.pxPerSec}" aria-label="Highway Zoom" />
              </div>
              <label class="amp-knob-label" for="ctrl-zoom">Zoom</label>
              <span class="amp-knob-val tabular" id="ctrl-zoom-val">${Math.round(this.pxPerSec)}px</span>
            </div>
          </div>

          <div class="deck-settings">
            <div class="deck-mode-group" role="group" aria-label="Practice Mode">
              <button type="button" class="seg-btn active" data-mode="perform">Perform</button>
              <button type="button" class="seg-btn" data-mode="wait">Wait for Note</button>
            </div>

            <div class="deck-selects">
              <label class="deck-field">
                <span class="deck-field-label">Difficulty</span>
                <select class="select" id="ctrl-level">
                  <option value="1">Level 1: Roots</option>
                  <option value="2">Level 2: Backbone</option>
                  <option value="3">Level 3: Full Song</option>
                </select>
              </label>

              <label class="deck-field">
                <span class="deck-field-label">Guide Sound</span>
                <select class="select" id="ctrl-guide-tone">
                  <option value="match">Match song tone</option>
                  <option value="clean">${TONE_NAMES.clean || 'Clean'}</option>
                  ${guideToneOptions}
                </select>
              </label>

              <span class="chip play-tone-chip ${this.ctx.amp?.state === 'online' ? '' : 'hidden'}" id="play-tone-chip" title="">
                <span id="play-tone-label">Tone</span>
                <select class="select play-tone-select" id="play-tone-select" aria-label="Amp Tone"></select>
              </span>
            </div>

            <div class="deck-toggles">
              <button type="button" class="btn btn-sm" id="btn-metronome" title="Toggle Metronome (M)">Metronome</button>
              <button type="button" class="btn btn-sm" id="btn-countin">Count-In</button>
              <button type="button" class="btn btn-sm" id="btn-fingering">Fingering</button>
            </div>
          </div>
        </section>
      </div>
    `;

    this.canvasEl = this.container.querySelector('#highway-canvas');
    this.ytDockEl = this.container.querySelector('#yt-pip-dock');
    this.miniFretboardEl = this.container.querySelector('#play-mini-fretboard');
    this.demoBtnEl = this.container.querySelector('#play-demo-btn');

    this._bindKnobs();

    this.container.querySelector('#btn-play-toggle')?.addEventListener('click', () => {
      if (this.state === 'playing' || this.state === 'countin') this.pause();
      else this.start();
    });
    this.container.querySelector('#btn-restart')?.addEventListener('click', () => this.restart());

    this.container.querySelector('#play-connect-btn')?.addEventListener('click', async (e) => {
      try {
        await this.ctx.input.start({
          deviceId: this.ctx.settings.get('inputDeviceId'),
          channel: this.ctx.settings.get('inputChannel')
        });
        e.target.remove();
      } catch (err) {
        this.ctx.toast(err.message, 'error');
      }
    });

    this.demoBtnEl?.addEventListener('click', () => {
      this._setVirtualGuitar(!this.virtualGuitar);
      if (this.virtualGuitar && this.state !== 'playing') {
        this.restart();
      }
    });

    this.container.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.mode = btn.dataset.mode;
        this._waitPausedAtEvent = -1;
        this._syncControlsUI();
      });
    });

    this.container.querySelector('#ctrl-level')?.addEventListener('change', (e) => {
      this.setLevel(Number(e.target.value));
    });

    this.container.querySelector('#ctrl-speed')?.addEventListener('input', (e) => {
      this.setSpeed(Number(e.target.value));
    });

    this.container.querySelector('#ctrl-guide-vol')?.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      this.ctx.settings.set('guideVolume', v);
      this.ctx.synth.setVolume(v);
      this.scheduler?.setOptions({ guideEnabled: v > 0.02 || this.virtualGuitar });
      const valEl = this.container.querySelector('#ctrl-guide-vol-val');
      if (valEl) valEl.textContent = `${Math.round(v * 100)}%`;
    });

    this.container.querySelector('#ctrl-guide-tone')?.addEventListener('change', async (e) => {
      const v = e.target.value;
      this.ctx.settings.set('guideTone', v);
      this._applyGuideTone();
      await this._previewGuideTone();
    });

    this.container.querySelector('#ctrl-backing-vol')?.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      this.ctx.settings.set('backingVolume', v);
      this.transport?.setVolume(v);
      const valEl = this.container.querySelector('#ctrl-backing-vol-val');
      if (valEl) valEl.textContent = `${Math.round(v * 100)}%`;
    });

    this.container.querySelector('#ctrl-zoom')?.addEventListener('input', (e) => {
      this._userZoomed = true;
      this.pxPerSec = Number(e.target.value);
      this.highway?.setView({ pxPerSec: this.pxPerSec });
      const valEl = this.container.querySelector('#ctrl-zoom-val');
      if (valEl) valEl.textContent = `${Math.round(this.pxPerSec)}px`;
    });

    const updateLoopFromPickers = () => {
      const a = parseInt(this.container.querySelector('#loop-bar-a').value, 10);
      const b = parseInt(this.container.querySelector('#loop-bar-b').value, 10);
      if (Number.isInteger(a) && a >= 1 && a <= this.song.bars.length) {
        const endBarIdx = Number.isInteger(b) && b >= a ? Math.min(this.song.bars.length, b) : a;
        const barA = this.song.bars[a - 1];
        const barB = this.song.bars[endBarIdx - 1];
        this.loop = { barStart: a, barEnd: endBarIdx, t0: barA.t, t1: barB.t + barB.dur };
      } else {
        this.loop = null;
      }
    };

    this.container.querySelector('#loop-bar-a')?.addEventListener('change', updateLoopFromPickers);
    this.container.querySelector('#loop-bar-b')?.addEventListener('change', updateLoopFromPickers);
    this.container.querySelector('#btn-clear-loop')?.addEventListener('click', () => {
      this.loop = null;
      this.container.querySelector('#loop-bar-a').value = '';
      this.container.querySelector('#loop-bar-b').value = '';
    });

    this.container.querySelector('#btn-metronome')?.addEventListener('click', () => {
      const next = !this.ctx.settings.get('metronome');
      this.ctx.settings.set('metronome', next);
      this.scheduler?.setOptions({ metronomeEnabled: next });
      this._syncControlsUI();
    });

    this.container.querySelector('#btn-countin')?.addEventListener('click', () => {
      const next = !this.ctx.settings.get('countIn');
      this.ctx.settings.set('countIn', next);
      this._syncControlsUI();
    });

    this.container.querySelector('#btn-fingering')?.addEventListener('click', () => {
      const next = !(this.ctx.settings.get('showFingering') !== false);
      this.ctx.settings.set('showFingering', next);
      if (next) this._lastMiniFbKey = '';
      this._syncControlsUI();
    });

    this.container.querySelector('#play-tone-select')?.addEventListener('change', async (e) => {
      const chosen = e.target.value;
      this.record.tone = chosen;
      await this.ctx.saveRecord(this.record);
      if (this.ctx.amp?.state === 'online') {
        this.ctx.amp.setPreset(chosen);
      }
      this._syncToneChip(false);
      this._applyGuideTone();
    });
  }

  _bindKnobs() {
    this.container.querySelectorAll('.amp-knob').forEach((knob) => {
      const dial = knob.querySelector('.amp-knob-dial');
      const range = knob.querySelector('input[type="range"]');
      if (!dial || !range) return;

      const min = Number(range.min) || 0;
      const max = Number(range.max) || 1;
      const step = Number(range.step) || 0.05;

      const syncDial = () => {
        const val = Number(range.value);
        const ratio = max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0;
        const deg = -135 + ratio * 270;
        dial.style.setProperty('--a', `${deg.toFixed(1)}deg`);
      };
      knob._syncDial = syncDial;
      syncDial();

      range.addEventListener('input', syncDial);
      range.addEventListener('focus', () => knob.classList.add('is-focused'));
      range.addEventListener('blur', () => knob.classList.remove('is-focused'));

      let dragging = false;
      let startY = 0;
      let startVal = 0;

      dial.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        range.focus();
        dial.setPointerCapture?.(e.pointerId);
        dragging = true;
        startY = e.clientY;
        startVal = Number(range.value);
      });

      dial.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dy = startY - e.clientY;
        const raw = startVal + (dy / 140) * (max - min);
        const stepped = min + Math.round((raw - min) / step) * step;
        const clamped = Math.max(min, Math.min(max, Number(stepped.toFixed(6))));
        if (clamped !== Number(range.value)) {
          range.value = String(clamped);
          range.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });

      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        range.dispatchEvent(new Event('change', { bubbles: true }));
      };
      dial.addEventListener('pointerup', endDrag);
      dial.addEventListener('pointercancel', endDrag);

      dial.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const next = Math.max(min, Math.min(max, Number((Number(range.value) + dir * step).toFixed(6))));
        if (next !== Number(range.value)) {
          range.value = String(next);
          range.dispatchEvent(new Event('input', { bubbles: true }));
          range.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, { passive: false });
    });
  }

  _applyGuideTone() {
    const setting = this.ctx.settings.get('guideTone');
    const songToneId = this.record.tone || this.toneSuggestion?.id;
    this.ctx.synth.setTone(resolveGuideTone(setting, songToneId));
  }

  async _previewGuideTone() {
    await resumeAudio();
    if (this.state !== 'playing' && this.state !== 'countin') {
      this.ctx.synth.stopAll();
    }
    const chord = [40, 47, 52, 55, 59, 64];
    const t0 = this.ctx.synth.ctx.currentTime + 0.04;
    const perNoteGain = 0.95 / Math.sqrt(chord.length);
    chord.forEach((midi, idx) => {
      this.ctx.synth.playNote(midi, t0 + idx * 0.018, 1.2, perNoteGain, 5 - idx);
    });
  }

  _syncToneChip(sendToAmp = false) {
    const chip = this.container.querySelector('#play-tone-chip');
    const labelEl = this.container.querySelector('#play-tone-label');
    const selEl = this.container.querySelector('#play-tone-select');
    if (!chip || !labelEl || !selEl) return;

    const online = this.ctx.amp?.state === 'online';
    chip.classList.toggle('hidden', !online);
    if (!online) return;

    const defaultNames = TONE_NAMES;
    const serverList = this.ctx.amp?.presets?.list || [];
    const map = new Map(Object.entries(defaultNames));
    for (const p of serverList) {
      if (p?.id) map.set(p.id, p.name || map.get(p.id) || p.id);
    }

    const suggestedId = this.toneSuggestion.id;
    const activeTone = this.record.tone || suggestedId;
    const activeName = map.get(activeTone) || activeTone;
    const isSuggested = !this.record.tone || this.record.tone === suggestedId;

    chip.title = this.toneSuggestion.reasons.join(' · ');
    labelEl.textContent = isSuggested ? `Tone: ${activeName} (suggested)` : `Tone: ${activeName}`;

    selEl.innerHTML = Array.from(map.entries()).map(([id, name]) => {
      const suffix = id === suggestedId ? ' (suggested)' : '';
      return `<option value="${id}" ${id === activeTone ? 'selected' : ''}>${name}${suffix}</option>`;
    }).join('');

    if (sendToAmp && activeTone) {
      this.ctx.amp.setPreset(activeTone);
    }
  }

  _syncControlsUI() {
    this.container.querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === this.mode);
    });
    const lvlEl = this.container.querySelector('#ctrl-level');
    if (lvlEl) lvlEl.value = String(this.level);

    const spdEl = this.container.querySelector('#ctrl-speed');
    if (spdEl) spdEl.value = String(this.speed);
    const spdVal = this.container.querySelector('#ctrl-speed-val');
    if (spdVal) spdVal.textContent = `${Math.round(this.speed * 100)}%`;

    const guideVol = Number(this.ctx.settings.get('guideVolume') ?? 0.7);
    const guideVolEl = this.container.querySelector('#ctrl-guide-vol');
    if (guideVolEl) guideVolEl.value = String(guideVol);
    const guideVolVal = this.container.querySelector('#ctrl-guide-vol-val');
    if (guideVolVal) guideVolVal.textContent = `${Math.round(guideVol * 100)}%`;

    const guideToneEl = this.container.querySelector('#ctrl-guide-tone');
    if (guideToneEl) guideToneEl.value = String(this.ctx.settings.get('guideTone') || 'match');

    const backingVol = Number(this.ctx.settings.get('backingVolume') ?? 0.85);
    const backingVolEl = this.container.querySelector('#ctrl-backing-vol');
    if (backingVolEl) backingVolEl.value = String(backingVol);
    const backingVolVal = this.container.querySelector('#ctrl-backing-vol-val');
    if (backingVolVal) backingVolVal.textContent = `${Math.round(backingVol * 100)}%`;

    const zoomEl = this.container.querySelector('#ctrl-zoom');
    if (zoomEl) zoomEl.value = String(this.pxPerSec);
    const zoomVal = this.container.querySelector('#ctrl-zoom-val');
    if (zoomVal) zoomVal.textContent = `${Math.round(this.pxPerSec)}px`;

    this.container.querySelectorAll('.amp-knob').forEach((k) => k._syncDial?.());

    const metOn = Boolean(this.ctx.settings.get('metronome'));
    const metBtn = this.container.querySelector('#btn-metronome');
    if (metBtn) {
      metBtn.classList.toggle('btn-primary', metOn);
      metBtn.setAttribute('aria-pressed', String(metOn));
    }

    const ciOn = Boolean(this.ctx.settings.get('countIn'));
    const ciBtn = this.container.querySelector('#btn-countin');
    if (ciBtn) {
      ciBtn.classList.toggle('btn-primary', ciOn);
      ciBtn.setAttribute('aria-pressed', String(ciOn));
    }

    const showFingering = this.ctx.settings.get('showFingering') !== false;
    const fbWrap = this.container.querySelector('#play-fretboard-wrap');
    if (fbWrap) fbWrap.classList.toggle('hidden', !showFingering);
    const fbBtn = this.container.querySelector('#btn-fingering');
    if (fbBtn) {
      fbBtn.classList.toggle('btn-primary', showFingering);
      fbBtn.setAttribute('aria-pressed', String(showFingering));
    }
  }

  _updatePlayButtonUI() {
    const btn = this.container.querySelector('#btn-play-toggle');
    if (!btn) return;
    const active = this.state === 'playing' || this.state === 'countin';
    const label = this.state === 'countin' ? 'Count-In' : active ? 'Pause' : 'Play';
    btn.setAttribute('aria-label', label);
    btn.title = `${label} (Space)`;
    btn.classList.toggle('is-playing', active);
    btn.innerHTML = active
      ? '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>'
      : '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true"><polygon points="7,5 20,12 7,19"></polygon></svg>';
  }

  _updateHUD() {
    const scoreEl = this.container.querySelector('#hud-score');
    const streakEl = this.container.querySelector('#hud-streak');
    const accEl = this.container.querySelector('#hud-accuracy');
    const judgeEl = this.container.querySelector('#hud-judgement');

    if (scoreEl) scoreEl.textContent = String(this.stats.score);
    const mult = Math.min(4, 1 + Math.floor(this.stats.streak / 10));
    if (streakEl) {
      streakEl.innerHTML = `${this.stats.streak} <small class="hud-streak-mult">x${mult}</small>`;
    }
    if (accEl) {
      const pct = this.stats.judged > 0 ? (this.stats.accuracy * 100).toFixed(0) : '100';
      accEl.textContent = `${pct}%`;
    }
    if (judgeEl) {
      judgeEl.textContent = this.lastJudgement.text;
      judgeEl.className = `judgement-pill ${this.lastJudgement.kind || ''}`;
    }
  }

  _renderNextEventFretboard(tabNow, activeHeard) {
    if (this.ctx.settings.get('showFingering') === false) return;
    const nextEv = this.events.find((ev, idx) => this.eventStates[idx] !== 1 && ev.t >= tabNow - 0.15);
    const keyStr = `${nextEv ? nextEv.index : -1}:${activeHeard ? activeHeard.midi : 0}`;
    if (this._lastMiniFbKey === keyStr) return;
    this._lastMiniFbKey = keyStr;

    const marks = [];
    if (nextEv) {
      for (const n of nextEv.notes) {
        marks.push({
          string: n.string,
          fret: n.fret,
          label: this.ctx.settings.get('showNoteNames') ? midiToName(n.midi).replace(/\d+$/, '') : String(n.fret),
          kind: 'target'
        });
      }
    }

    if (activeHeard && activeHeard.midi > 0) {
      for (let s = 0; s < this.song.tuning.length; s++) {
        const fret = activeHeard.midi - (this.song.tuning[s] + (this.song.capo || 0));
        if (fret >= 0 && fret <= 15) {
          marks.push({
            string: s,
            fret,
            label: midiToName(activeHeard.midi).replace(/\d+$/, ''),
            kind: 'heard'
          });
          break;
        }
      }
    }

    renderFretboard(this.miniFretboardEl, {
      tuning: this.song.tuning,
      capo: this.song.capo,
      frets: 15,
      marks,
      leftHanded: Boolean(this.ctx.settings.get('leftHanded'))
    });
  }

  _updateTransportReadout(tabNow) {
    const timeEl = this.container.querySelector('#transport-time');
    const barEl = this.container.querySelector('#play-bar-readout');
    const fmt = (sec) => {
      const neg = sec < 0;
      const s = neg ? Math.ceil(Math.abs(sec)) : Math.floor(sec);
      return `${neg ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    let barNum = 1;
    for (let i = 0; i < this.song.bars.length; i++) {
      if (tabNow >= this.song.bars[i].t) barNum = i + 1;
    }
    const totalBars = Math.max(1, this.song.bars.length);
    const padLen = Math.max(2, String(totalBars).length);
    if (barEl) {
      barEl.textContent = `BAR ${String(barNum).padStart(padLen, '0')} / ${String(totalBars).padStart(padLen, '0')}`;
    }
    if (timeEl) {
      timeEl.textContent = `${fmt(tabNow)} / ${fmt(this.song.duration)}`;
    }
  }

  _handleKeyDown(e) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (this.state === 'playing' || this.state === 'countin') this.pause();
      else this.start();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      this.restart();
    } else if (e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      this.mode = this.mode === 'wait' ? 'perform' : 'wait';
      this._syncControlsUI();
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      const next = !this.ctx.settings.get('metronome');
      this.ctx.settings.set('metronome', next);
      this.scheduler?.setOptions({ metronomeEnabled: next });
      this._syncControlsUI();
    } else if (e.key === '[') {
      e.preventDefault();
      this.setSpeed(this.speed - 0.05);
    } else if (e.key === ']') {
      e.preventDefault();
      this.setSpeed(this.speed + 0.05);
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      const tabNow = this.getTabNow();
      const barIdx = this.song.bars.findIndex((b) => tabNow >= b.t && tabNow < b.t + b.dur);
      if (barIdx >= 0) {
        const bar = this.song.bars[barIdx];
        this.loop = { barStart: barIdx + 1, barEnd: barIdx + 1, t0: bar.t, t1: bar.t + bar.dur };
        this.container.querySelector('#loop-bar-a').value = String(barIdx + 1);
        this.container.querySelector('#loop-bar-b').value = String(barIdx + 1);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const barDur = this.song.bars[0]?.dur || 2;
      this.seekTab(this.getTabNow() - barDur);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const barDur = this.song.bars[0]?.dur || 2;
      this.seekTab(this.getTabNow() + barDur);
    }
  }

  _handleVisibilityChange() {
    if (document.hidden && (this.state === 'playing' || this.state === 'countin')) {
      this.pause();
    }
  }

  unmount() {
    this._unmounted = true;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    window.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('visibilitychange', this._onVisChange);
    this.ctx.amp?.removeEventListener('state', this._onAmpChange);
    this.ctx.amp?.removeEventListener('presets', this._onAmpChange);
    this._unsubSettings?.();

    if (this.virtualGuitar) {
      this.ctx.synth.setSelfTestRoute(this.ctx.input, false);
    }
    this.scheduler?.stop();
    this.transport?.destroy();
    this.highway?.destroy();

    const ytHolder = document.getElementById('yt-holder');
    const ytContainer = document.getElementById('yt-player-container');
    if (ytHolder && ytContainer && !ytHolder.contains(ytContainer)) {
      ytHolder.appendChild(ytContainer);
    }
  }
}

export function mount(container, ctx) {
  if (!ctx.record) {
    ctx.navigate('#/library');
    return { unmount() {} };
  }
  const game = new Game(container, ctx, ctx.record);
  if (globalThis.window?.woodshed) {
    window.woodshed.game = game;
  }
  game.mount();
  return {
    unmount() {
      game.unmount();
      if (globalThis.window?.woodshed?.game === game) {
        window.woodshed.game = null;
      }
    }
  };
}
