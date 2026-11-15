import { toWoodshedText, summarize } from './lib/clean.js';
import { saveEntry } from './lib/library.js';
import { sendToWoodshed as dispatchToWoodshed } from './lib/send.js';

const TUNING_PRESETS = [
  { name: 'Standard', notes: 'E A D G B E' },
  { name: 'Drop D', notes: 'D A D G B E' },
  { name: 'Eb Standard', notes: 'Eb Ab Db Gb Bb Eb' },
  { name: 'D Standard', notes: 'D G C F A D' },
  { name: 'Drop C', notes: 'C G C F A D' },
  { name: 'Drop C#', notes: 'C# G# C# F# A# D#' },
  { name: 'Open G', notes: 'D G D G B D' },
  { name: 'Open D', notes: 'D A D F# A D' },
  { name: 'Open E', notes: 'E B E G# B E' },
  { name: 'DADGAD', notes: 'D A D G A D' },
  { name: '7-String Standard', notes: 'B E A D G B E' },
  { name: 'Drop A (7-String)', notes: 'A E A D G B E' },
  { name: 'Bass Standard', notes: 'E A D G' },
  { name: 'Drop D Bass', notes: 'D A D G' }
];

const loadingView = document.getElementById('loading-view');
const loadingText = document.getElementById('loading-text');
const messageView = document.getElementById('message-view');
const resultView = document.getElementById('result-view');

const msgSiteChip = document.getElementById('msg-site-chip');
const msgText = document.getElementById('msg-text');

const titleInput = document.getElementById('title-input');
const artistInput = document.getElementById('artist-input');
const siteChip = document.getElementById('site-chip');
const summaryText = document.getElementById('summary-text');
const warningText = document.getElementById('warning-text');
const tuningSelect = document.getElementById('tuning-select');
const capoInput = document.getElementById('capo-input');
const bpmInput = document.getElementById('bpm-input');
const tabPreview = document.getElementById('tab-preview');
const statusBanner = document.getElementById('status-banner');

let currentExtraction = null;
let currentSummary = null;

function showView(name) {
  loadingView.classList.toggle('hidden', name !== 'loading');
  messageView.classList.toggle('hidden', name !== 'message');
  resultView.classList.toggle('hidden', name !== 'result');
}

function showMessage(text, site = '') {
  msgText.textContent = text;
  if (site) {
    msgSiteChip.textContent = site;
    msgSiteChip.classList.remove('hidden');
  } else {
    msgSiteChip.classList.add('hidden');
  }
  showView('message');
}

function normalizeNotesKey(notes) {
  return String(notes || '')
    .trim()
    .split(/\s+/)
    .map((n) => n.replace(/^([a-g])/i, (_, c) => c.toUpperCase()))
    .join(' ');
}

function populateTuningSelect(detectedNotes) {
  tuningSelect.innerHTML = '';

  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = 'Auto';
  tuningSelect.appendChild(autoOpt);

  const normalized = normalizeNotesKey(detectedNotes);
  let matchedPresetValue = '';

  for (const preset of TUNING_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.notes;
    opt.textContent = `${preset.name} (${preset.notes})`;
    if (normalized && preset.notes.toLowerCase() === normalized.toLowerCase()) {
      matchedPresetValue = preset.notes;
    }
    tuningSelect.appendChild(opt);
  }

  if (normalized && !matchedPresetValue) {
    const customOpt = document.createElement('option');
    customOpt.value = normalized;
    customOpt.textContent = normalized;
    tuningSelect.appendChild(customOpt);
    matchedPresetValue = normalized;
  }

  tuningSelect.value = matchedPresetValue;
}

function getTuningDisplayLabel(notes) {
  if (!notes) return '';
  const found = TUNING_PRESETS.find((p) => p.notes.toLowerCase() === notes.toLowerCase());
  return found ? found.name : notes;
}

function getEditedFields() {
  const title = titleInput.value.trim();
  const artist = artistInput.value.trim();
  const tuning = tuningSelect.value.trim();

  const capoRaw = capoInput.value.trim();
  const capoNum = capoRaw === '' ? 0 : parseInt(capoRaw, 10);
  const capo = Number.isFinite(capoNum) && capoNum >= 0 && capoNum <= 12 ? capoNum : 0;

  const bpmRaw = bpmInput.value.trim();
  const bpmNum = bpmRaw === '' ? null : parseInt(bpmRaw, 10);
  const bpm = bpmNum !== null && Number.isFinite(bpmNum) && bpmNum >= 30 && bpmNum <= 300 ? bpmNum : null;

  return { title, artist, tuning, capo, bpm };
}

function buildFormattedOutput() {
  const { title, artist, bpm } = getEditedFields();
  return toWoodshedText({
    title,
    artist,
    bpm,
    text: currentExtraction?.text || ''
  });
}

function updateSummaryAndPreview() {
  if (!currentExtraction || !currentSummary) return;
  const { tuning, capo, bpm } = getEditedFields();

  const parts = [];
  parts.push(`${currentSummary.systems} ${currentSummary.systems === 1 ? 'system' : 'systems'}`);
  if (currentSummary.strings > 0) {
    parts.push(`${currentSummary.strings} strings`);
  }
  const tuningLabel = getTuningDisplayLabel(tuning);
  if (tuningLabel) {
    parts.push(tuningLabel);
  }
  if (capo > 0) {
    parts.push(`capo ${capo}`);
  }
  if (bpm !== null) {
    parts.push(`${bpm} BPM`);
  }
  summaryText.textContent = parts.join(' · ');

  const fullText = buildFormattedOutput();
  const first40 = fullText.split('\n').slice(0, 40).join('\n');
  tabPreview.textContent = first40;
}

function renderResult(data) {
  currentExtraction = data;
  currentSummary = summarize(data.text);

  titleInput.value = data.title || '';
  artistInput.value = data.artist || '';
  siteChip.textContent = data.site || 'tab';
  populateTuningSelect(data.tuning || '');
  capoInput.value = data.capo !== null && data.capo !== undefined ? String(data.capo) : '0';
  bpmInput.value = data.bpm !== null && data.bpm !== undefined ? String(data.bpm) : '';

  if (data.warning) {
    warningText.textContent = data.warning;
    warningText.classList.remove('hidden');
  } else {
    warningText.textContent = '';
    warningText.classList.add('hidden');
  }

  statusBanner.classList.add('hidden');
  updateSummaryAndPreview();
  showView('result');
}

function explainRestrictedUrl(url) {
  if (!url) return 'Cannot read tabs from this browser page.';
  if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) {
    return 'Browser internal pages cannot be accessed by extensions. Open a tab website and click Woodshed Tab Grabber again.';
  }
  if (url.startsWith('https://chrome.google.com/webstore') || url.startsWith('https://chromewebstore.google.com')) {
    return 'The Chrome Web Store blocks extensions from reading page content. Open a guitar tab site instead.';
  }
  if (url.startsWith('file://')) {
    return 'Local file access is disabled. Enable "Allow access to file URLs" for Woodshed Tab Grabber in chrome://extensions.';
  }
  return '';
}

async function handleSendToWoodshed() {
  if (!currentExtraction) return;
  const { title, artist, tuning, capo, bpm } = getEditedFields();
  const text = buildFormattedOutput();

  try {
    await dispatchToWoodshed({
      title,
      artist,
      tuning,
      capo,
      bpm,
      text,
      source: currentExtraction.site || 'web',
      url: currentExtraction.url || ''
    });
  } catch (err) {
    showStatus(`Couldn't open Woodshed: ${err?.message || err}. Is it running? Check the address in Options.`);
    return;
  }

  window.close();
}

let statusTimer = null;

function showStatus(msg, autoHideMs = 0) {
  if (statusTimer !== null) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  statusBanner.textContent = msg;
  statusBanner.classList.remove('hidden');
  if (autoHideMs > 0) {
    statusTimer = setTimeout(() => {
      statusBanner.classList.add('hidden');
      statusTimer = null;
    }, autoHideMs);
  }
}

async function handleSaveToLibrary() {
  if (!currentExtraction) return;
  const { title, artist, tuning, capo, bpm } = getEditedFields();
  const text = buildFormattedOutput();

  const { updated } = await saveEntry({
    title,
    artist,
    site: currentExtraction.site || 'web',
    url: currentExtraction.url || '',
    tuning,
    capo,
    bpm,
    text
  });

  showStatus(updated ? 'Updated in your library' : 'Saved to your library', 3000);
}

function openLibraryPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
}

async function copyToClipboard() {
  const text = buildFormattedOutput();
  await navigator.clipboard.writeText(text);
  statusBanner.textContent = 'Copied — paste it into Woodshed → Add Song';
  statusBanner.classList.remove('hidden');
}

function sanitizeFilename(s) {
  return String(s || '')
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function saveAsTxt() {
  const { title, artist } = getEditedFields();
  const text = buildFormattedOutput();
  const safeArtist = sanitizeFilename(artist);
  const safeTitle = sanitizeFilename(title) || 'tab';
  const fileName = safeArtist ? `${safeArtist} - ${safeTitle}.txt` : `${safeTitle}.txt`;

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function runExtraction() {
  showView('loading');
  let activeTab = null;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab || null;
    if (!activeTab || activeTab.id === undefined) {
      showMessage('No active tab found.');
      return;
    }

    const restrictedReason = explainRestrictedUrl(activeTab.url || '');
    if (restrictedReason && activeTab.url && !activeTab.url.startsWith('file://')) {
      showMessage(restrictedReason);
      return;
    }

    let isSongsterr = false;
    try {
      isSongsterr = new URL(activeTab.url || '').hostname.toLowerCase().endsWith('songsterr.com');
    } catch (_err) {
      isSongsterr = false;
    }

    loadingText.textContent = isSongsterr
      ? 'Reading Songsterr: scrolling through the song…'
      : 'Scanning page for tab...';

    const timeoutMs = isSongsterr ? 60000 : 3000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timed out while scanning this page.')), timeoutMs);
    });

    const execPromise = chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['lib/songsterr.js', 'extract.js']
    });

    const results = await Promise.race([execPromise, timeoutPromise]);
    const res = results && results[0] ? results[0].result : null;

    if (!res) {
      showMessage('Could not read tab content from this page.');
      return;
    }

    if (res.ok && res.kind === 'tab') {
      renderResult(res);
    } else {
      showMessage(res.message || 'No ASCII guitar tab was found on this page.', res.site || '');
    }
  } catch (err) {
    const restrictedReason = explainRestrictedUrl(activeTab?.url || '');
    if (restrictedReason) {
      showMessage(restrictedReason);
    } else {
      showMessage(err?.message || 'Unable to access this page.');
    }
  }
}

titleInput.addEventListener('input', updateSummaryAndPreview);
artistInput.addEventListener('input', updateSummaryAndPreview);
tuningSelect.addEventListener('change', updateSummaryAndPreview);
capoInput.addEventListener('input', updateSummaryAndPreview);
bpmInput.addEventListener('input', updateSummaryAndPreview);

document.getElementById('send-btn').addEventListener('click', handleSendToWoodshed);
document.getElementById('save-lib-btn').addEventListener('click', handleSaveToLibrary);
document.getElementById('copy-btn').addEventListener('click', copyToClipboard);
document.getElementById('save-btn').addEventListener('click', saveAsTxt);
document.getElementById('retry-btn').addEventListener('click', runExtraction);
document.getElementById('open-library-btn').addEventListener('click', openLibraryPage);
document.getElementById('msg-library-btn').addEventListener('click', openLibraryPage);
document.getElementById('open-options-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

runExtraction();
