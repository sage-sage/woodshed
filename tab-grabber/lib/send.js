function normalizeBaseUrl(raw, fallback = 'https://sage-sage.github.io/woodshed/') {
  try {
    const u = new URL((raw || fallback).trim());
    return `${u.origin}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`;
  } catch (_err) {
    return fallback;
  }
}

function buildImportUrl(baseUrl) {
  const cleanBase = baseUrl.replace(/#.*$/, '');
  return `${cleanBase}#/import`;
}

export async function sendToWoodshed(payload) {
  const importPayload = {
    v: 1,
    title: payload.title || '',
    artist: payload.artist || '',
    tuning: payload.tuning || '',
    capo: payload.capo ?? 0,
    bpm: payload.bpm ?? null,
    text: payload.text || '',
    ...(payload.notation ? { notation: payload.notation } : {}),
    source: payload.source || payload.site || 'web',
    url: payload.url || '',
    ts: Date.now()
  };

  await chrome.storage.local.set({ pendingImport: importPayload });

  const cfg = await chrome.storage.local.get({
    woodshedUrl: 'https://sage-sage.github.io/woodshed/',
    checkHosted: false,
    hostedUrl: ''
  });

  const primaryBase = normalizeBaseUrl(cfg.woodshedUrl, 'https://sage-sage.github.io/woodshed/');
  const candidateBases = [primaryBase];
  if (cfg.checkHosted && cfg.hostedUrl && cfg.hostedUrl.trim()) {
    candidateBases.push(normalizeBaseUrl(cfg.hostedUrl, ''));
  }

  const tabs = await chrome.tabs.query({});
  let matchedTab = null;
  let matchedBase = primaryBase;

  for (const base of candidateBases) {
    if (!base) continue;
    const prefix = base.replace(/\/$/, '');
    const found = tabs.find(
      (t) =>
        typeof t.url === 'string' &&
        (t.url === prefix || t.url.startsWith(`${prefix}/`) || t.url.startsWith(`${prefix}#`))
    );
    if (found) {
      matchedTab = found;
      matchedBase = base;
      break;
    }
  }

  if (matchedTab && matchedTab.id !== undefined) {
    await chrome.windows.update(matchedTab.windowId, { focused: true });
    await chrome.tabs.update(matchedTab.id, {
      active: true,
      url: buildImportUrl(matchedBase)
    });
    // Chrome only adds content scripts to pages loaded after the extension was installed or reloaded, so a
    // Woodshed tab that was already open has no bridge: add it now (bridge.js ignores a second copy).
    try {
      await chrome.scripting.executeScript({ target: { tabId: matchedTab.id }, files: ['bridge.js'] });
    } catch (_err) {
      await chrome.tabs.reload(matchedTab.id);
    }
  } else {
    await chrome.tabs.create({
      url: buildImportUrl(primaryBase)
    });
  }
}
