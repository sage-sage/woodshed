const DEFAULT_URL = 'https://sage-sage.github.io/woodshed/';
const HOSTED_SCRIPT_ID = 'woodshed-hosted-bridge';

const form = document.getElementById('options-form');
const woodshedUrlInput = document.getElementById('woodshed-url');
const checkHostedInput = document.getElementById('check-hosted');
const hostedUrlInput = document.getElementById('hosted-url');
const resetBtn = document.getElementById('reset-btn');
const statusEl = document.getElementById('status');

function normalizeUrl(raw, fallback) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return fallback;
  const u = new URL(trimmed);
  return `${u.origin}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`;
}

function updateHostedState() {
  hostedUrlInput.disabled = !checkHostedInput.checked;
}

async function syncHostedBridgeRegistration(enabled, hostedUrl) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [HOSTED_SCRIPT_ID] });
  } catch (_err) {
    // Ignore when not yet registered
  }

  if (!enabled || !hostedUrl) return;

  const u = new URL(hostedUrl);
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return;

  const originPattern = `${u.origin}/*`;
  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) {
    throw new Error('Permission for the hosted Woodshed origin was not granted.');
  }

  await chrome.scripting.registerContentScripts([
    {
      id: HOSTED_SCRIPT_ID,
      matches: [originPattern],
      js: ['bridge.js'],
      runAt: 'document_idle'
    }
  ]);
}

async function loadOptions() {
  const saved = await chrome.storage.local.get({
    woodshedUrl: DEFAULT_URL,
    checkHosted: false,
    hostedUrl: ''
  });
  woodshedUrlInput.value = saved.woodshedUrl || DEFAULT_URL;
  checkHostedInput.checked = Boolean(saved.checkHosted);
  hostedUrlInput.value = saved.hostedUrl || '';
  updateHostedState();
}

checkHostedInput.addEventListener('change', updateHostedState);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = '';

  try {
    const woodshedUrl = normalizeUrl(woodshedUrlInput.value, DEFAULT_URL);
    const checkHosted = checkHostedInput.checked;
    const hostedUrl = checkHosted && hostedUrlInput.value.trim()
      ? normalizeUrl(hostedUrlInput.value, '')
      : hostedUrlInput.value.trim();

    if (checkHosted && !hostedUrl) {
      statusEl.textContent = 'Enter a hosted URL or uncheck the option.';
      return;
    }

    await syncHostedBridgeRegistration(checkHosted, hostedUrl);
    await chrome.storage.local.set({
      woodshedUrl,
      checkHosted,
      hostedUrl
    });

    woodshedUrlInput.value = woodshedUrl;
    if (hostedUrl) hostedUrlInput.value = hostedUrl;
    statusEl.textContent = 'Saved.';
  } catch (err) {
    statusEl.textContent = err?.message || 'Invalid URL.';
  }
});

resetBtn.addEventListener('click', async () => {
  woodshedUrlInput.value = DEFAULT_URL;
  checkHostedInput.checked = false;
  hostedUrlInput.value = '';
  updateHostedState();
  await syncHostedBridgeRegistration(false, '');
  await chrome.storage.local.set({
    woodshedUrl: DEFAULT_URL,
    checkHosted: false,
    hostedUrl: ''
  });
  statusEl.textContent = 'Reset to default.';
});

loadOptions();
