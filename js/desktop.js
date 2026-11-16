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

/** The host calls these when its update check finishes. */
export function wireDesktopUpdates(toast) {
  if (!isDesktop) return;
  let manual = false;
  window.woodshedDesktopUpdate = (info) => {
    if (info && info.version) {
      toast(`Woodshed ${info.version} is available.`, 'info', {
        actionLabel: 'Update now',
        onAction: () => {
          toast('Downloading the update. Woodshed restarts by itself when it is done.', 'info');
          postToHost({ type: 'install-update' });
        }
      });
    } else if (manual) {
      toast(`Woodshed ${desktop.version} is up to date.`, 'success');
    }
    manual = false;
  };
  window.woodshedDesktopUpdateFailed = (message) => {
    toast(`Update failed: ${message || 'unknown error'}`, 'error');
    manual = false;
  };
  return () => { manual = true; postToHost({ type: 'check-update' }); };
}
