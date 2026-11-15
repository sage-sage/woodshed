const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeId(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (YT_ID_RE.test(trimmed)) {
    return trimmed;
  }

  if (/\s/.test(trimmed)) {
    return null;
  }

  let urlStr = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlStr)) {
    if (/^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(urlStr)) {
      urlStr = `https://${urlStr}`;
    } else {
      return null;
    }
  }

  let url;
  try {
    url = new URL(urlStr);
  } catch (_) {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(?:www\.|m\.|music\.)/, '');
  if (host === 'youtu.be') {
    const seg = url.pathname.split('/').filter(Boolean)[0] || '';
    return YT_ID_RE.test(seg) ? seg : null;
  }

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const vParam = url.searchParams.get('v') || url.searchParams.get('vi');
    if (vParam && YT_ID_RE.test(vParam)) {
      return vParam;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const prefix = parts[0].toLowerCase();
      const candidate = parts[1];
      if (['embed', 'shorts', 'live', 'v', 'e'].includes(prefix) && YT_ID_RE.test(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

class BaseEmitter {
  constructor() {
    this._listeners = { ended: new Set(), state: new Set(), error: new Set() };
  }

  on(event, fn) {
    if (this._listeners[event] && typeof fn === 'function') {
      this._listeners[event].add(fn);
    }
    return () => this.off(event, fn);
  }

  off(event, fn) {
    if (this._listeners[event]) {
      this._listeners[event].delete(fn);
    }
  }

  _emit(event, payload) {
    if (!this._listeners[event]) return;
    for (const fn of this._listeners[event]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`Transport listener error (${event}):`, err);
      }
    }
  }
}

export class SilentBackend extends BaseEmitter {
  constructor({ duration = 60 } = {}) {
    super();
    this._duration = Math.max(1, Number(duration) || 60);
    this._playing = false;
    this._rate = 1.0;
    this._volume = 1.0;
    this._anchorAudioTime = 0;
    this._anchorWallMs = 0;
    this._rafId = null;
    this._tick = this._checkEnded.bind(this);
  }

  async load() {
    this._emit('state', { state: 'ready' });
    return this;
  }

  _nowMs() {
    return globalThis.performance ? performance.now() : Date.now();
  }

  _checkEnded() {
    if (!this._playing) return;
    if (this.currentTime >= this._duration) {
      this._anchorAudioTime = this._duration;
      this._playing = false;
      this._emit('state', { state: 'paused' });
      this._emit('ended', {});
      return;
    }
    if (globalThis.requestAnimationFrame) {
      this._rafId = requestAnimationFrame(this._tick);
    }
  }

  play() {
    if (this._playing) return;
    if (this._anchorAudioTime >= this._duration) {
      this._anchorAudioTime = 0;
    }
    this._anchorWallMs = this._nowMs();
    this._playing = true;
    this._emit('state', { state: 'playing' });
    if (globalThis.requestAnimationFrame) {
      this._rafId = requestAnimationFrame(this._tick);
    }
  }

  pause() {
    if (!this._playing) return;
    this._anchorAudioTime = this.currentTime;
    this._playing = false;
    if (this._rafId && globalThis.cancelAnimationFrame) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._emit('state', { state: 'paused' });
  }

  seek(t) {
    const clamped = Math.max(0, Math.min(this._duration, Number(t) || 0));
    this._anchorAudioTime = clamped;
    this._anchorWallMs = this._nowMs();
  }

  get currentTime() {
    if (!this._playing) return this._anchorAudioTime;
    const elapsedSec = (this._nowMs() - this._anchorWallMs) / 1000;
    return Math.min(this._duration, this._anchorAudioTime + elapsedSec * this._rate);
  }

  get duration() {
    return this._duration;
  }

  set duration(val) {
    if (Number.isFinite(val) && val > 0) {
      this._duration = val;
    }
  }

  get playing() {
    return this._playing;
  }

  get rate() {
    return this._rate;
  }

  setRate(r) {
    const next = Math.max(0.25, Math.min(1.5, Number(r) || 1));
    if (this._playing) {
      this._anchorAudioTime = this.currentTime;
      this._anchorWallMs = this._nowMs();
    }
    this._rate = next;
    return this._rate;
  }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, Number(v) ?? 1));
  }

  destroy() {
    this.pause();
    this._listeners.ended.clear();
    this._listeners.state.clear();
    this._listeners.error.clear();
  }
}

export class FileBackend extends BaseEmitter {
  constructor({ blob = null, url = '' } = {}) {
    super();
    this.blob = blob;
    this.url = url;
    this.objectUrl = null;
    this.audio = null;
    this._rate = 1.0;
    this._volume = 0.85;
    this._seekTarget = null;
  }

  async load() {
    if (typeof Audio === 'undefined') {
      throw new Error('HTMLAudioElement is not available in this environment.');
    }
    this.audio = new Audio();
    this.audio.preload = 'auto';

    if (this.blob) {
      this.objectUrl = URL.createObjectURL(this.blob);
      this.audio.src = this.objectUrl;
    } else if (this.url) {
      this.audio.src = this.url;
    } else {
      throw new Error('FileBackend requires either a Blob or a valid audio URL.');
    }

    this._applyPreservesPitch();
    this.audio.playbackRate = this._rate;
    this.audio.volume = this._volume;

    this.audio.addEventListener('seeked', () => { this._seekTarget = null; });
    this.audio.addEventListener('play', () => this._emit('state', { state: 'playing' }));
    this.audio.addEventListener('pause', () => {
      if (!this.audio.ended) this._emit('state', { state: 'paused' });
    });
    this.audio.addEventListener('ended', () => {
      this._emit('state', { state: 'paused' });
      this._emit('ended', {});
    });
    this.audio.addEventListener('error', () => {
      const code = this.audio?.error?.code;
      const msg = code === 4
        ? 'Audio file format is not supported by this browser.'
        : 'Failed to decode or play the audio file.';
      this._emit('error', { message: msg });
    });

    await new Promise((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        this._emit('state', { state: 'ready' });
        resolve();
      };
      const onError = () => {
        cleanup();
        const err = new Error('Could not load audio file. Check that the file is a valid MP3, WAV, OGG, or M4A.');
        this._emit('error', { message: err.message, error: err });
        reject(err);
      };
      const cleanup = () => {
        this.audio.removeEventListener('loadedmetadata', onLoaded);
        this.audio.removeEventListener('canplay', onLoaded);
        this.audio.removeEventListener('error', onError);
      };
      this.audio.addEventListener('loadedmetadata', onLoaded, { once: true });
      this.audio.addEventListener('canplay', onLoaded, { once: true });
      this.audio.addEventListener('error', onError, { once: true });
      this.audio.load();
    });

    return this;
  }

  _applyPreservesPitch() {
    if (!this.audio) return;
    if ('preservesPitch' in this.audio) this.audio.preservesPitch = true;
    else if ('mozPreservesPitch' in this.audio) this.audio.mozPreservesPitch = true;
    else if ('webkitPreservesPitch' in this.audio) this.audio.webkitPreservesPitch = true;
  }

  play() {
    if (!this.audio) return;
    this._applyPreservesPitch();
    this.audio.playbackRate = this._rate;
    const p = this.audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        this._emit('error', { message: `Audio playback blocked or failed: ${err.message}`, error: err });
      });
    }
  }

  pause() {
    if (!this.audio) return;
    this.audio.pause();
  }

  seek(t) {
    if (!this.audio) return;
    const maxDur = Number.isFinite(this.audio.duration) ? this.audio.duration : Infinity;
    const target = Math.max(0, Math.min(maxDur, Number(t) || 0));
    // While a seek is in flight (e.g. paused audio still buffering) Chrome can report the previous
    // position, so report the target until 'seeked' fires.
    this._seekTarget = target;
    this.audio.currentTime = target;
  }

  get currentTime() {
    if (!this.audio) return 0;
    if (this._seekTarget != null) {
      if (!this.audio.seeking && Math.abs(this.audio.currentTime - this._seekTarget) < 0.05) this._seekTarget = null;
      else return this._seekTarget;
    }
    return this.audio.currentTime;
  }

  get duration() {
    return this.audio && Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  get playing() {
    return Boolean(this.audio && !this.audio.paused && !this.audio.ended);
  }

  get rate() {
    return this._rate;
  }

  setRate(r) {
    const clamped = Math.max(0.25, Math.min(1.5, Number(r) || 1));
    this._rate = clamped;
    if (this.audio) {
      this._applyPreservesPitch();
      this.audio.playbackRate = clamped;
    }
    return this._rate;
  }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, Number(v) ?? 1));
    if (this.audio) {
      this.audio.volume = this._volume;
    }
  }

  destroy() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this._listeners.ended.clear();
    this._listeners.state.clear();
    this._listeners.error.clear();
  }
}

let ytApiPromise = null;

/** The hosted copy (claude.ai) only lets the page load its own files: YouTube's script AND plain YouTube iframes are
 * blocked there (both tested). The local copy on localhost has no such limit. */
export const YOUTUBE_BLOCKED = typeof location !== 'undefined'
  && /(^|\.)claudeusercontent\.com$|(^|\.)claude\.ai$/.test(location.hostname);
export const YOUTUBE_BLOCKED_MSG = 'YouTube can’t play on the hosted copy of Woodshed: claude.ai blocks videos from other sites. '
  + 'It works in the Windows download (bottom left), or attach an audio file instead.';

function loadYouTubeIframeApi() {
  if (YOUTUBE_BLOCKED) return Promise.reject(new Error(YOUTUBE_BLOCKED_MSG));
  if (globalThis.YT && globalThis.YT.Player) {
    return Promise.resolve(globalThis.YT);
  }
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve, reject) => {
    const prevCallback = globalThis.onYouTubeIframeAPIReady;
    globalThis.onYouTubeIframeAPIReady = () => {
      if (typeof prevCallback === 'function') prevCallback();
      resolve(globalThis.YT);
    };

    const existingScript = document.querySelector('script[src*="youtube.com/iframe_api"]');
    if (!existingScript) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => {
        ytApiPromise = null;
        reject(new Error('Failed to load YouTube IFrame Player API. Check your internet connection.'));
      };
      document.head.appendChild(tag);
    }
  });

  return ytApiPromise;
}

const YT_ERROR_MESSAGES = {
  2: 'Invalid YouTube video ID (Error 2). Check the URL and try again.',
  5: 'YouTube HTML5 player error (Error 5). Try reloading the page.',
  100: 'This YouTube video was not found or has been marked private (Error 100).',
  101: 'The video owner has disabled playback on embedded websites (Error 101). Use a local audio file instead.',
  150: 'The video owner has disabled playback on embedded websites (Error 150). Use a local audio file instead.'
};

export class YouTubeBackend extends BaseEmitter {
  constructor({ videoId, url, container } = {}) {
    super();
    this.videoId = videoId || parseYouTubeId(url || '');
    this.container = container || null;
    this.player = null;
    this.mountEl = null;

    this._playing = false;
    this._rate = 1.0;
    this._volume = 0.85;
    this._duration = 0;

    this._lastReportedTime = 0;
    this._anchorTime = 0;
    this._anchorPerfMs = 0;
  }

  _nowMs() {
    return globalThis.performance ? performance.now() : Date.now();
  }

  async load() {
    if (!this.videoId) {
      const err = new Error('Invalid YouTube URL or Video ID.');
      this._emit('error', { message: err.message, error: err });
      throw err;
    }

    const YT = await loadYouTubeIframeApi();

    let hostContainer = this.container;
    if (!hostContainer) {
      hostContainer = document.getElementById('yt-player-container');
      if (!hostContainer) {
        hostContainer = document.createElement('div');
        hostContainer.id = 'yt-player-container';
        document.body.appendChild(hostContainer);
      }
    }

    this.mountEl = document.createElement('div');
    hostContainer.innerHTML = '';
    hostContainer.appendChild(this.mountEl);

    await new Promise((resolve, reject) => {
      let settled = false;
      this.player = new YT.Player(this.mountEl, {
        width: '100%',
        height: '100%',
        videoId: this.videoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          playsinline: 1,
          rel: 0,
          origin: globalThis.location?.origin || undefined
        },
        events: {
          onReady: () => {
            this._duration = Number(this.player.getDuration?.()) || 0;
            this.setVolume(this._volume);
            this.setRate(this._rate);
            this._emit('state', { state: 'ready' });
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          onStateChange: (ev) => this._handleStateChange(ev, YT),
          onPlaybackRateChange: (ev) => {
            const newRate = Number(ev.data) || 1.0;
            this._reanchor(this.currentTime);
            this._rate = newRate;
          },
          onError: (ev) => {
            const code = Number(ev.data);
            const msg = YT_ERROR_MESSAGES[code] || `YouTube player error (code ${code}).`;
            const err = new Error(msg);
            this._playing = false;
            this._emit('error', { code, message: msg, error: err });
            if (!settled) {
              settled = true;
              reject(err);
            }
          }
        }
      });
    });

    return this;
  }

  _reanchor(timeSec) {
    this._anchorTime = timeSec;
    this._anchorPerfMs = this._nowMs();
  }

  _handleStateChange(ev, YT) {
    const state = ev.data;
    if (this.player && typeof this.player.getDuration === 'function') {
      const d = this.player.getDuration();
      if (d > 0) this._duration = d;
    }

    if (state === YT.PlayerState.PLAYING) {
      const rep = Number(this.player.getCurrentTime?.()) || 0;
      this._lastReportedTime = rep;
      this._reanchor(rep);
      this._playing = true;
      this._emit('state', { state: 'playing' });
    } else if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.CUED) {
      const rep = Number(this.player.getCurrentTime?.()) || this._anchorTime;
      this._lastReportedTime = rep;
      this._reanchor(rep);
      this._playing = false;
      this._emit('state', { state: 'paused' });
    } else if (state === YT.PlayerState.BUFFERING) {
      const rep = Number(this.player.getCurrentTime?.()) || this._anchorTime;
      this._reanchor(rep);
      this._playing = false;
      this._emit('state', { state: 'buffering' });
    } else if (state === YT.PlayerState.ENDED) {
      this._playing = false;
      this._reanchor(this._duration);
      this._emit('state', { state: 'paused' });
      this._emit('ended', {});
    }
  }

  play() {
    if (!this.player || typeof this.player.playVideo !== 'function') return;
    this.player.playVideo();
  }

  pause() {
    if (!this.player || typeof this.player.pauseVideo !== 'function') return;
    this.player.pauseVideo();
  }

  seek(t) {
    const target = Math.max(0, Number(t) || 0);
    this._lastReportedTime = target;
    this._reanchor(target);
    if (this.player && typeof this.player.seekTo === 'function') {
      this.player.seekTo(target, true);
    }
  }

  get currentTime() {
    if (!this.player || typeof this.player.getCurrentTime !== 'function') {
      return this._anchorTime;
    }

    const reported = Number(this.player.getCurrentTime()) || 0;
    if (!this._playing) {
      if (Math.abs(reported - this._lastReportedTime) > 0.001) {
        this._lastReportedTime = reported;
        this._anchorTime = reported;
      }
      return this._anchorTime;
    }

    const now = this._nowMs();
    const interpolated = this._anchorTime + ((now - this._anchorPerfMs) / 1000) * this._rate;

    if (reported !== this._lastReportedTime) {
      this._lastReportedTime = reported;
      this._anchorTime = reported;
      this._anchorPerfMs = now;
      return reported;
    }

    if (Math.abs(interpolated - reported) > 0.08 && Math.abs(interpolated - reported) > 0.35 * this._rate) {
      this._anchorTime = reported;
      this._anchorPerfMs = now;
      return reported;
    }

    return Math.max(0, interpolated);
  }

  get duration() {
    if (this.player && typeof this.player.getDuration === 'function') {
      const d = Number(this.player.getDuration());
      if (d > 0) this._duration = d;
    }
    return this._duration;
  }

  get playing() {
    return this._playing;
  }

  get rate() {
    return this._rate;
  }

  setRate(r) {
    const desired = Number(r) || 1.0;
    let available = [0.25, 0.5, 0.75, 1, 1.25, 1.5];
    if (this.player && typeof this.player.getAvailablePlaybackRates === 'function') {
      const list = this.player.getAvailablePlaybackRates();
      if (Array.isArray(list) && list.length > 0) {
        available = list;
      }
    }
    let closest = available[0];
    let minDiff = Math.abs(desired - closest);
    for (const candidate of available) {
      const diff = Math.abs(desired - candidate);
      if (diff < minDiff) {
        minDiff = diff;
        closest = candidate;
      }
    }

    if (this._playing) {
      this._reanchor(this.currentTime);
    }
    this._rate = closest;
    if (this.player && typeof this.player.setPlaybackRate === 'function') {
      this.player.setPlaybackRate(closest);
    }
    return closest;
  }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, Number(v) ?? 1));
    if (this.player && typeof this.player.setVolume === 'function') {
      this.player.setVolume(Math.round(this._volume * 100));
    }
  }

  destroy() {
    this._playing = false;
    if (this.player && typeof this.player.destroy === 'function') {
      try {
        this.player.destroy();
      } catch (_) {
        // Ignore
      }
    }
    this.player = null;
    if (this.mountEl && this.mountEl.parentNode) {
      this.mountEl.parentNode.removeChild(this.mountEl);
    }
    this.mountEl = null;
    this._listeners.ended.clear();
    this._listeners.state.clear();
    this._listeners.error.clear();
  }
}

export function createBackend(audioDescriptor = { kind: 'none' }, { container = null, blob = null, duration = 60 } = {}) {
  const kind = audioDescriptor?.kind || 'none';
  if (kind === 'file') {
    return new FileBackend({ blob: blob || audioDescriptor.blob, url: audioDescriptor.url });
  }
  if (kind === 'url') {
    return new FileBackend({ url: audioDescriptor.url });
  }
  if (kind === 'youtube') {
    return new YouTubeBackend({
      videoId: audioDescriptor.videoId || parseYouTubeId(audioDescriptor.url || ''),
      url: audioDescriptor.url,
      container
    });
  }
  return new SilentBackend({ duration: audioDescriptor?.duration || duration });
}
