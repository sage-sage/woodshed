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

async function sendViaAmp(payload, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (typeof WebSocket === 'undefined') {
      resolve(0);
      return;
    }
    let ws;
    let settled = false;
    let timer = null;

    const finish = (delivered) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
        }
      } catch (_err) {
        // ignore close errors
      }
      resolve(delivered);
    };

    try {
      ws = new WebSocket('ws://127.0.0.1:47800/ws');
    } catch (_err) {
      finish(0);
      return;
    }

    timer = setTimeout(() => finish(0), timeoutMs);

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'tabImport', payload }));
      } catch (_err) {
        finish(0);
      }
    });

    ws.addEventListener('message', (event) => {
      try {
        if (typeof event.data !== 'string') return;
        const msg = JSON.parse(event.data);
        if (msg && msg.type === 'tabImportAck') {
          const n = typeof msg.delivered === 'number' && Number.isFinite(msg.delivered) ? msg.delivered : 0;
          finish(n > 0 ? n : 0);
        } else if (msg && msg.type === 'error') {
          finish(0);
        }
      } catch (_err) {
        // ignore malformed frames
      }
    });

    ws.addEventListener('error', () => finish(0));
    ws.addEventListener('close', () => finish(0));
  });
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
    const delivered = await sendViaAmp(importPayload);
    if (delivered > 0) {
      await chrome.storage.local.remove('pendingImport');
      return { via: 'app', delivered };
    }
    await chrome.tabs.create({
      url: buildImportUrl(primaryBase)
    });
  }
}
