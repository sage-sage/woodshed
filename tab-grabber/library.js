import {
  listEntries,
  updateEntry,
  deleteEntry,
  exportLibrary,
  importLibrary
} from './lib/library.js';
import { sendToWoodshed } from './lib/send.js';

const countBadge = document.getElementById('count-badge');
const searchInput = document.getElementById('search-input');
const sortSelect = document.getElementById('sort-select');
const entryListEl = document.getElementById('entry-list');
const emptyListMsg = document.getElementById('empty-list-msg');

const noSelectionEl = document.getElementById('no-selection');
const detailViewEl = document.getElementById('detail-view');
const detailTitleInput = document.getElementById('detail-title');
const detailArtistInput = document.getElementById('detail-artist');
const detailTagsInput = document.getElementById('detail-tags');
const detailNoteInput = document.getElementById('detail-note');
const detailBadgesEl = document.getElementById('detail-badges');
const saveIndicatorEl = document.getElementById('save-indicator');
const detailTextEl = document.getElementById('detail-text');

const detailSendBtn = document.getElementById('detail-send-btn');
const detailSourceBtn = document.getElementById('detail-source-btn');
const detailCopyBtn = document.getElementById('detail-copy-btn');
const detailDeleteBtn = document.getElementById('detail-delete-btn');

const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');
const importFileInput = document.getElementById('import-file');
const footerStatusEl = document.getElementById('footer-status');

let allEntries = [];
let selectedId = null;
let saveDebounceTimer = null;
let deleteConfirmTimer = null;
let deleteConfirmArmed = false;

function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch (_err) {
    return '';
  }
}

function isSafeHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_err) {
    return false;
  }
}

function resetDeleteConfirm() {
  if (deleteConfirmTimer !== null) {
    clearTimeout(deleteConfirmTimer);
    deleteConfirmTimer = null;
  }
  deleteConfirmArmed = false;
  detailDeleteBtn.textContent = 'Delete';
  detailDeleteBtn.classList.remove('confirming');
}

function getFilteredAndSortedEntries() {
  const q = searchInput.value.trim().toLowerCase();
  const sortBy = sortSelect.value;

  const filtered = q
    ? allEntries.filter((entry) => {
        const hay = [
          entry.title || '',
          entry.artist || '',
          entry.site || '',
          ...(Array.isArray(entry.tags) ? entry.tags : [])
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
    : allEntries.slice();

  filtered.sort((a, b) => {
    if (sortBy === 'title') {
      return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    }
    if (sortBy === 'artist') {
      const byArtist = (a.artist || '').localeCompare(b.artist || '', undefined, { sensitivity: 'base' });
      return byArtist !== 0
        ? byArtist
        : (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    }
    const aTime = a.updatedAt || a.savedAt || 0;
    const bTime = b.updatedAt || b.savedAt || 0;
    return bTime - aTime;
  });

  return filtered;
}

function renderList() {
  const visible = getFilteredAndSortedEntries();
  countBadge.textContent = `${allEntries.length} ${allEntries.length === 1 ? 'tab' : 'tabs'}`;

  entryListEl.textContent = '';
  if (visible.length === 0) {
    emptyListMsg.textContent = allEntries.length === 0
      ? 'Your library is empty. Save a tab from the popup to see it here.'
      : 'No saved tabs match your search.';
    emptyListMsg.classList.remove('hidden');
    return;
  }
  emptyListMsg.classList.add('hidden');

  for (const entry of visible) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'entry-card';
    if (entry.id === selectedId) {
      card.classList.add('selected');
    }

    const top = document.createElement('div');
    top.className = 'entry-card-top';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'entry-title';
    titleSpan.textContent = entry.title || 'Untitled';
    top.appendChild(titleSpan);

    if (entry.site) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = entry.site;
      top.appendChild(chip);
    }

    card.appendChild(top);

    if (entry.artist) {
      const artistDiv = document.createElement('div');
      artistDiv.className = 'entry-artist';
      artistDiv.textContent = entry.artist;
      card.appendChild(artistDiv);
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'entry-meta-row';

    const dateStr = formatDate(entry.savedAt);
    if (dateStr) {
      const dateSpan = document.createElement('span');
      dateSpan.textContent = dateStr;
      metaRow.appendChild(dateSpan);
    }

    if (Array.isArray(entry.tags)) {
      for (const tag of entry.tags) {
        const tagSpan = document.createElement('span');
        tagSpan.className = 'tag-pill';
        tagSpan.textContent = tag;
        metaRow.appendChild(tagSpan);
      }
    }

    card.appendChild(metaRow);
    card.addEventListener('click', () => {
      selectedId = entry.id;
      resetDeleteConfirm();
      renderList();
      renderDetail();
    });

    entryListEl.appendChild(card);
  }
}

function renderDetail(preserveInputs = false) {
  const entry = allEntries.find((item) => item.id === selectedId) || null;
  if (!entry) {
    noSelectionEl.classList.remove('hidden');
    detailViewEl.classList.add('hidden');
    return;
  }

  noSelectionEl.classList.add('hidden');
  detailViewEl.classList.remove('hidden');

  if (!preserveInputs) {
    detailTitleInput.value = entry.title || '';
    detailArtistInput.value = entry.artist || '';
    detailTagsInput.value = Array.isArray(entry.tags) ? entry.tags.join(', ') : '';
    detailNoteInput.value = entry.note || '';
    saveIndicatorEl.textContent = '';
  }

  detailBadgesEl.textContent = '';
  if (entry.site) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = entry.site;
    detailBadgesEl.appendChild(chip);
  }
  const details = [];
  if (entry.tuning) details.push(`Tuning: ${entry.tuning}`);
  if (Number.isFinite(entry.capo) && entry.capo > 0) details.push(`Capo ${entry.capo}`);
  if (Number.isFinite(entry.bpm)) details.push(`${entry.bpm} BPM`);
  if (entry.savedAt) details.push(`Saved ${formatDate(entry.savedAt)}`);
  if (details.length > 0) {
    const infoSpan = document.createElement('span');
    infoSpan.textContent = details.join(' · ');
    detailBadgesEl.appendChild(infoSpan);
  }

  detailSourceBtn.disabled = !isSafeHttpUrl(entry.url);
  detailTextEl.textContent = entry.text || '';
}

function scheduleFieldSave() {
  if (!selectedId) return;
  saveIndicatorEl.textContent = 'Saving…';
  if (saveDebounceTimer !== null) {
    clearTimeout(saveDebounceTimer);
  }
  const targetId = selectedId;
  saveDebounceTimer = setTimeout(async () => {
    saveDebounceTimer = null;
    await updateEntry(targetId, {
      title: detailTitleInput.value,
      artist: detailArtistInput.value,
      tags: detailTagsInput.value,
      note: detailNoteInput.value
    });
    saveIndicatorEl.textContent = 'Saved';
  }, 250);
}

async function refreshLibrary(preserveInputs = false) {
  allEntries = await listEntries();
  if (selectedId && !allEntries.some((item) => item.id === selectedId)) {
    selectedId = allEntries[0]?.id || null;
    preserveInputs = false;
  } else if (!selectedId && allEntries.length > 0) {
    selectedId = allEntries[0].id;
    preserveInputs = false;
  }
  renderList();
  renderDetail(preserveInputs);
}

detailTitleInput.addEventListener('input', scheduleFieldSave);
detailArtistInput.addEventListener('input', scheduleFieldSave);
detailTagsInput.addEventListener('input', scheduleFieldSave);
detailNoteInput.addEventListener('input', scheduleFieldSave);

searchInput.addEventListener('input', renderList);
sortSelect.addEventListener('change', renderList);

detailSendBtn.addEventListener('click', async () => {
  const entry = allEntries.find((item) => item.id === selectedId);
  if (!entry) return;
  await sendToWoodshed({
    title: detailTitleInput.value.trim(),
    artist: detailArtistInput.value.trim(),
    tuning: entry.tuning || '',
    capo: entry.capo ?? 0,
    bpm: entry.bpm ?? null,
    text: entry.text || '',
    source: entry.site || 'library',
    url: entry.url || ''
  });
});

detailSourceBtn.addEventListener('click', () => {
  const entry = allEntries.find((item) => item.id === selectedId);
  if (!entry || !isSafeHttpUrl(entry.url)) return;
  chrome.tabs.create({ url: entry.url });
});

detailCopyBtn.addEventListener('click', async () => {
  const entry = allEntries.find((item) => item.id === selectedId);
  if (!entry) return;
  await navigator.clipboard.writeText(entry.text || '');
  saveIndicatorEl.textContent = 'Copied tab text';
});

detailDeleteBtn.addEventListener('click', async () => {
  if (!selectedId) return;
  if (!deleteConfirmArmed) {
    deleteConfirmArmed = true;
    detailDeleteBtn.textContent = 'Confirm delete';
    detailDeleteBtn.classList.add('confirming');
    deleteConfirmTimer = setTimeout(() => {
      resetDeleteConfirm();
    }, 4000);
    return;
  }

  const idToDelete = selectedId;
  resetDeleteConfirm();
  await deleteEntry(idToDelete);
});

exportBtn.addEventListener('click', async () => {
  const json = await exportLibrary();
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'woodshed-tab-library.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  footerStatusEl.textContent = 'Exported library JSON.';
});

importBtn.addEventListener('click', () => {
  importFileInput.value = '';
  importFileInput.click();
});

importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files?.[0];
  if (!file) return;
  try {
    const rawText = await file.text();
    const { added, updated } = await importLibrary(rawText);
    footerStatusEl.textContent = `Imported: ${added} added, ${updated} updated.`;
  } catch (err) {
    footerStatusEl.textContent = err?.message || 'Failed to import library file.';
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.library) {
    const isEditing = [
      detailTitleInput,
      detailArtistInput,
      detailTagsInput,
      detailNoteInput
    ].includes(document.activeElement);
    refreshLibrary(isEditing);
  }
});

refreshLibrary();
