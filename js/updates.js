// Latest versions, read from version.json next to index.html (published with every release, see tools/release.py).

let cached = null;

export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/** { amp: {version, url, notes}, extension: {version, url}, site: {version} } or null when unavailable. */
export function fetchLatest() {
  if (!cached) {
    // The desktop app bundles an old copy of version.json, so it asks the website for the current one.
    const url = globalThis.window?.woodshedDesktop ? 'https://sage-sage.github.io/woodshed/version.json' : 'version.json';
    cached = fetch(url, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return cached;
}
