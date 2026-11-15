# Woodshed Tab Grabber

A Manifest V3 Chrome extension that grabs ASCII guitar tabs from the active browser tab, cleans them into plain ASCII tab for Woodshed, and sends them directly to Woodshed's import view.

## Install

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `woodshed-tab-grabber` folder.
4. Make sure `icons/16.png`, `icons/32.png`, `icons/48.png`, and `icons/128.png` exist in the `icons/` directory before loading.

## Use

1. Open a song tab page in Chrome (or highlight ≥ 3 lines of tab text on any page).
2. Click the **Woodshed Tab Grabber** toolbar icon or press **Alt+Shift+W**.
3. Review or edit the detected title, artist, tuning, capo, and BPM in the popup.
4. Click **Send to Woodshed** to focus or open Woodshed (the GitHub Pages site by default) and load the tab into **Paste Text Tab**, click **Save to Library** to keep it in your local Tab Library, or use **Copy** / **Save .txt**.

To change the Woodshed URL or enable checking a hosted copy, click **Settings** in the popup or open the extension's **Options** page.

## Tab Library

Click **Open library** in the popup to browse, search, tag, annotate, export, and import saved tabs:

- **Deduplication by URL:** Saving from a URL already in your library updates the existing entry while preserving your tags and notes.
- **Search & sort:** Filter by title, artist, site, or tags, and sort by newest, title, or artist.
- **Backup & portability:** Export the full library to a `.json` file or import/merge an exported library JSON.
- **Woodshed integration:** Open Woodshed tabs can query, load, and delete library entries directly via the page bridge.

## Supported Sites

- **Text tab sites:** Ultimate Guitar (plain text tabs), Cifra Club, E-Chords, AZChords, GuitarTabs.cc, GuitareTab, BigBassTabs, Tabs4Acoustic, Chordie, and any generic web page containing `<pre>`, `<code>`, `<textarea>`, or monospace preformatted tab blocks.
- **Songsterr:** Reads the currently displayed track directly from the rendered SVG notation by scrolling through the virtualized lines and recognizing fret glyphs. **Limits:** reads only the visible track, and rhythm is approximate because note columns are derived from Songsterr's visual spacing.
- **Selection override:** Selecting ≥ 3 lines containing ≥ 4 consecutive tab lines takes priority on any site.
- **Unsupported / chords-only pages:** Ultimate Guitar Pro/Official/Guitar Pro interactive tabs, 911Tabs link directories, and Chordify or chord-sheet pages display a clear explanation.

## Running Tests

    node --test
