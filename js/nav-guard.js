// Accidental "back" guard. A trackpad swipe, an edge swipe or the mouse back button goes back in history; with hash
// routes that silently swaps the screen, which in the middle of a take stops the song. Real navigation (rail links,
// buttons, Enter on a link, navigate()) is always preceded by a click or a key press, so a route change that leaves
// a playing song with no such intent just before it is undone.

export const INTENT_WINDOW_MS = 1000;

/** Pure decision: should this hash change be undone? */
export function shouldBlockRouteChange({ oldHash, newHash, playing, intentAgeMs }) {
  if (!playing) return false;
  if (!/^#\/song\/[^/]+\/play$/.test(oldHash || '')) return false;
  if (newHash === oldHash) return false;
  return !(intentAgeMs >= 0 && intentAgeMs <= INTENT_WINDOW_MS);
}

/** Mouse buttons 3/4 are the back/forward thumb buttons; Alt+Left/Right and the BrowserBack keys are history keys. */
function isHistoryKey(e) {
  return e.key === 'BrowserBack' || e.key === 'BrowserForward' || (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'));
}

/**
 * Installs the intent tracking. Returns { markIntent, check(event) }: call check(hashchangeEvent) first thing in the
 * hashchange handler; it returns true when it undid the change (the handler should then do nothing).
 */
export function installNavGuard({ isPlaying, onBlocked }) {
  let intentAt = -Infinity;
  const markIntent = () => { intentAt = performance.now(); };
  window.addEventListener('pointerdown', (e) => { if (e.button !== 3 && e.button !== 4) markIntent(); }, true);
  window.addEventListener('keydown', (e) => { if (!isHistoryKey(e)) markIntent(); }, true);
  const hashOf = (url) => { const i = (url || '').indexOf('#'); return i < 0 ? '' : url.slice(i); };
  const check = (e) => {
    if (!e || !e.oldURL) return false;
    const oldHash = hashOf(e.oldURL);
    const newHash = location.hash;
    const block = shouldBlockRouteChange({ oldHash, newHash, playing: !!isPlaying(), intentAgeMs: performance.now() - intentAt });
    if (!block) return false;
    // Put the play route back as the newest entry without firing another hashchange.
    history.pushState(history.state, '', e.oldURL);
    onBlocked?.();
    return true;
  };
  return { markIntent, check };
}
