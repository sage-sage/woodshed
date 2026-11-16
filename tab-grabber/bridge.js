(() => {
  if (!document.querySelector('meta[name="woodshed"]')) {
    return;
  }
  // The popup also injects this file into Woodshed tabs that were open before the extension loaded. Run once
  // per tab, but replace a copy left over from before an extension reload (its chrome.runtime is gone).
  if (typeof window.__woodshedBridgeAlive === 'function' && window.__woodshedBridgeAlive()) {
    return;
  }
  window.__woodshedBridgeAlive = () => {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_err) {
      return false;
    }
  };

  const MAX_AGE_MS = 10 * 60 * 1000;
  const RETRY_INTERVAL_MS = 500;
  const MAX_WAIT_MS = 10 * 1000;

  let activeTs = null;
  let retryIntervalId = null;
  let stopTimeoutId = null;

  function clearTimers() {
    if (retryIntervalId !== null) {
      clearInterval(retryIntervalId);
      retryIntervalId = null;
    }
    if (stopTimeoutId !== null) {
      clearTimeout(stopTimeoutId);
      stopTimeoutId = null;
    }
    activeTs = null;
  }

  function deliverPayload(payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.ts !== 'number') {
      return;
    }

    if (Date.now() - payload.ts >= MAX_AGE_MS) {
      clearTimers();
      chrome.storage.local.remove('pendingImport');
      return;
    }

    if (activeTs === payload.ts && retryIntervalId !== null) {
      return;
    }

    clearTimers();
    activeTs = payload.ts;

    const send = () => {
      window.postMessage(
        {
          source: 'woodshed-tab-grabber',
          type: 'import-tab',
          payload
        },
        window.location.origin
      );
    };

    send();
    retryIntervalId = setInterval(send, RETRY_INTERVAL_MS);
    stopTimeoutId = setTimeout(() => {
      clearTimers();
    }, MAX_WAIT_MS);
  }

  function postHello() {
    window.postMessage(
      {
        source: 'woodshed-tab-grabber',
        type: 'hello',
        version: chrome.runtime.getManifest().version,
        library: true
      },
      window.location.origin
    );
  }

  function handleLibraryRequest(data) {
    const { id, op, entryId } = data;
    chrome.storage.local.get({ library: [] }, (items) => {
      const library = Array.isArray(items?.library) ? items.library : [];
      if (op === 'list') {
        const entries = library.map(({ text, notation, ...rest }) => ({
          ...rest,
          textLength: typeof text === 'string' ? text.length : 0,
          hasNotation: Boolean(notation && typeof notation === 'object' && notation.format === 'songsterr' && Array.isArray(notation.measures))
        }));
        window.postMessage(
          {
            source: 'woodshed-tab-grabber',
            type: 'library-response',
            id,
            ok: true,
            entries
          },
          window.location.origin
        );
      } else if (op === 'get') {
        const entry = library.find((item) => item && item.id === entryId) || null;
        if (!entry) {
          window.postMessage(
            {
              source: 'woodshed-tab-grabber',
              type: 'library-response',
              id,
              ok: false,
              error: 'Entry not found'
            },
            window.location.origin
          );
        } else {
          window.postMessage(
            {
              source: 'woodshed-tab-grabber',
              type: 'library-response',
              id,
              ok: true,
              entry
            },
            window.location.origin
          );
        }
      } else if (op === 'delete') {
        const next = library.filter((item) => item && item.id !== entryId);
        chrome.storage.local.set({ library: next }, () => {
          window.postMessage(
            {
              source: 'woodshed-tab-grabber',
              type: 'library-response',
              id,
              ok: true
            },
            window.location.origin
          );
        });
      } else {
        window.postMessage(
          {
            source: 'woodshed-tab-grabber',
            type: 'library-response',
            id,
            ok: false,
            error: `Unknown library operation: ${String(op)}`
          },
          window.location.origin
        );
      }
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'woodshed') return;

    if (data.type === 'ping') {
      postHello();
      return;
    }

    if (data.type === 'library-request') {
      handleLibraryRequest(data);
      return;
    }

    if (data.type !== 'import-tab-received') return;
    if (activeTs !== null && data.ts !== activeTs) return;

    clearTimers();
    chrome.storage.local.remove('pendingImport');
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.pendingImport && changes.pendingImport.newValue) {
      deliverPayload(changes.pendingImport.newValue);
    }
    if (changes.library) {
      window.postMessage(
        {
          source: 'woodshed-tab-grabber',
          type: 'library-changed'
        },
        window.location.origin
      );
    }
  });

  postHello();

  chrome.storage.local.get('pendingImport', (items) => {
    if (items && items.pendingImport) {
      deliverPayload(items.pendingImport);
    }
  });
})();
