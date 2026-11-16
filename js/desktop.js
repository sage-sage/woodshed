// Woodshed desktop app bridge. In the desktop app (src/desktop/desktop_main.cpp in woodshed-amp) the host
// defines window.woodshedDesktop = { version, ampInstalled } and accepts JSON messages via chrome.webview.

export const SITE_URL = 'https://sage-sage.github.io/woodshed/';
export const SETUP_URL = 'https://github.com/sage-sage/woodshed/releases/latest/download/Woodshed-Setup.exe';

export const desktop = (typeof window !== 'undefined' && window.woodshedDesktop) || null;
export const isDesktop = !!desktop;

export function postToHost(msg) {
  try {
    window.chrome?.webview?.postMessage(JSON.stringify(msg));
    return true;
  } catch (_) {
    return false;
  }
}

/** Update state for the desktop app, shown next to Settings > Check for updates.
 *  status: idle | checking | none (up to date) | available | installing | failed */
export const updateState = { status: 'idle', version: '', error: '', checkedAt: 0 };
const emitUpdate = () => window.dispatchEvent(new CustomEvent('woodshed-update', { detail: { ...updateState } }));
let checkTimer = 0;

export function installUpdate() {
  updateState.status = 'installing';
  emitUpdate();
  postToHost({ type: 'install-update' });
}

/** The host calls window.woodshedDesktopUpdate / woodshedDesktopUpdateFailed when a check or download ends.
 *  Returns the function the Check for updates button calls. */
export function wireDesktopUpdates(toast) {
  if (!isDesktop) return null;
  let manual = false;
  let startedAt = 0;
  const settle = () => { clearTimeout(checkTimer); updateState.checkedAt = Date.now(); };
  // A check usually answers in ~100 ms; keep "Checking…" up long enough to be seen.
  const afterMinShow = (fn) => {
    const wait = manual ? Math.max(0, 700 - (Date.now() - startedAt)) : 0;
    if (wait) setTimeout(fn, wait); else fn();
  };
  const onUpdate = (info) => {
    settle();
    if (info && info.version) {
      const isNew = updateState.version !== info.version;
      Object.assign(updateState, { status: 'available', version: info.version, error: '' });
      // Automatic checks announce a new version once; the Settings line shows it from then on.
      if (isNew || manual) {
        toast(`Woodshed ${info.version} is available.`, 'info', { actionLabel: 'Update now', onAction: installUpdate });
      }
    } else {
      Object.assign(updateState, { status: 'none', error: '' });
    }
    manual = false;
    emitUpdate();
  };
  window.woodshedDesktopUpdate = (info) => afterMinShow(() => onUpdate(info));
  const onFailed = (message) => {
    settle();
    const wasInstalling = updateState.status === 'installing';
    Object.assign(updateState, { status: 'failed', error: message || 'unknown error' });
    if (manual || wasInstalling) toast(`${wasInstalling ? 'Update' : 'Update check'} failed: ${updateState.error}`, 'error');
    manual = false;
    emitUpdate();
  };
  window.woodshedDesktopUpdateFailed = (message) => afterMinShow(() => onFailed(message));
  return () => {
    if (updateState.status === 'checking' || updateState.status === 'installing') return;
    manual = true;
    startedAt = Date.now();
    Object.assign(updateState, { status: 'checking', error: '' });
    emitUpdate();
    postToHost({ type: 'check-update' });
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      if (updateState.status === 'checking') onFailed('no answer from the update server (are you offline?)');
    }, 20000);
  };
}

/** Custom title bar for the desktop app: the host removes Windows' caption, the page draws this bar.
 *  Dragging and double-click-to-maximize come from CSS `app-region: drag` (WebView2 non-client regions). */
export function mountTitleBar() {
  if (!isDesktop || !desktop.customTitleBar || document.getElementById('titlebar')) return;
  const bar = document.createElement('header');
  bar.id = 'titlebar';
  bar.className = 'titlebar';
  bar.innerHTML = `
    <div class="titlebar-brand">
      <img src="icons/mark.svg" alt="" width="16" height="16" />
      <span>Woodshed</span>
    </div>
    <div class="titlebar-title" id="titlebar-title"></div>
    <div class="titlebar-controls">
      <button type="button" class="tb-btn" data-win="minimize" aria-label="Minimize" title="Minimize">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10"/></svg>
      </button>
      <button type="button" class="tb-btn" data-win="maximize" aria-label="Maximize" title="Maximize">
        <svg class="tb-max" viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9"/></svg>
        <svg class="tb-restore" viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V.5h7v7h-2"/></svg>
      </button>
      <button type="button" class="tb-btn tb-close" data-win="close" aria-label="Close" title="Close">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10"/></svg>
      </button>
    </div>`;
  document.body.prepend(bar);
  document.documentElement.classList.add('has-titlebar');
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-win]');
    if (btn) postToHost({ type: `win-${btn.dataset.win}` });
  });
  window.woodshedDesktopWindow = ({ maximized, active } = {}) => {
    document.documentElement.classList.toggle('win-maximized', !!maximized);
    document.documentElement.classList.toggle('win-inactive', active === false);
    const max = bar.querySelector('[data-win="maximize"]');
    max.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
    max.title = maximized ? 'Restore' : 'Maximize';
  };
  postToHost({ type: 'win-state' });
  // The current song (or page) in the middle of the bar.
  const titleEl = bar.querySelector('#titlebar-title');
  const syncTitle = () => {
    const songTitle = document.querySelector('#song-header-root:not(.hidden) .song-header-title');
    titleEl.textContent = songTitle ? songTitle.textContent.trim() : '';
  };
  window.addEventListener('hashchange', () => setTimeout(syncTitle, 50));
  setTimeout(syncTitle, 300);
}

/** The "checking for updates" screen (desktop app): a modal that follows updateState until the user hides it.
 *  check() starts the check (the function wireDesktopUpdates returned). */
export function openUpdateDialog(check) {
  if (!isDesktop) return;
  document.getElementById('ws-update-dialog')?.remove();
  const root = document.createElement('div');
  root.id = 'ws-update-dialog';
  root.className = 'ws-update-overlay';
  root.innerHTML = `
    <section class="ws-update-dialog" role="dialog" aria-modal="true" aria-labelledby="ws-update-title">
      <header class="ws-update-head"><span>Woodshed for Windows</span><span>v${desktop.version}</span></header>
      <div class="ws-update-body">
        <div class="ws-update-mark" aria-hidden="true">✦</div>
        <h2 id="ws-update-title" class="ws-update-title"></h2>
        <p class="ws-update-text"></p>
        <div class="ws-update-bar" aria-hidden="true"><span></span></div>
        <ol class="ws-update-steps">
          <li data-step="reach"><span>Reach the update server</span><b></b></li>
          <li data-step="compare"><span>Compare versions</span><b></b></li>
          <li data-step="install"><span>Download and install</span><b></b></li>
        </ol>
      </div>
      <footer class="ws-update-foot">
        <button type="button" class="ws-update-btn" data-act="close">Hide</button>
        <button type="button" class="ws-update-btn is-primary" data-act="primary" hidden></button>
      </footer>
    </section>`;
  document.body.appendChild(root);
  const $ = (sel) => root.querySelector(sel);
  const step = (name, label, state) => {
    const li = root.querySelector(`[data-step="${name}"]`);
    li.className = state || '';
    li.querySelector('b').textContent = label;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  function close() {
    window.removeEventListener('woodshed-update', render);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
  }
  function render() {
    const st = updateState;
    const primary = $('[data-act="primary"]');
    root.dataset.state = st.status;
    primary.hidden = true;
    if (st.status === 'checking' || st.status === 'idle') {
      $('.ws-update-title').textContent = 'Checking for updates';
      $('.ws-update-text').textContent = 'Looking for a newer Woodshed on GitHub. This takes a second or two.';
      step('reach', '…', 'is-active'); step('compare', '', ''); step('install', 'If newer', 'is-dim');
    } else if (st.status === 'none') {
      $('.ws-update-title').textContent = 'You’re up to date';
      $('.ws-update-text').textContent = `Woodshed ${desktop.version} is the latest version.`;
      step('reach', 'Done', 'is-done'); step('compare', 'Same version', 'is-done'); step('install', 'Not needed', 'is-dim');
      primary.hidden = false; primary.textContent = 'Check again'; primary.onclick = () => check?.();
    } else if (st.status === 'available') {
      $('.ws-update-title').textContent = `Woodshed ${st.version} is ready`;
      $('.ws-update-text').textContent = `You have ${desktop.version}. Updating closes Woodshed, installs the new version and opens it again.`;
      step('reach', 'Done', 'is-done'); step('compare', `${st.version} is newer`, 'is-done'); step('install', 'Waiting for you', 'is-active');
      primary.hidden = false; primary.textContent = `Update to ${st.version}`; primary.onclick = () => installUpdate();
    } else if (st.status === 'installing') {
      $('.ws-update-title').textContent = 'Updating…';
      $('.ws-update-text').textContent = 'Downloading the update. Woodshed closes, installs it and opens again by itself.';
      step('reach', 'Done', 'is-done'); step('compare', 'Done', 'is-done'); step('install', '…', 'is-active');
    } else if (st.status === 'failed') {
      $('.ws-update-title').textContent = 'Couldn’t check for updates';
      $('.ws-update-text').textContent = `${st.error}. You have Woodshed ${desktop.version}.`;
      step('reach', 'Failed', 'is-bad'); step('compare', '', 'is-dim'); step('install', '', 'is-dim');
      primary.hidden = false; primary.textContent = 'Try again'; primary.onclick = () => check?.();
    }
  }
  $('[data-act="close"]').addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('woodshed-update', render);
  render();
  $('[data-act="close"]').focus();
}
