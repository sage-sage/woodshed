# Woodshed Tab Grabber — Chrome extension spec (decided; implement exactly)

Purpose: on a tab website, one click takes the tab the user is looking at, cleans it into plain ASCII tab that
Woodshed's parser understands (`parseAsciiTab`: systems of `e|--0--2--|` string lines, chord/lyric lines between
systems are ignored), and sends it to Woodshed's import page with title, artist, tuning, capo and tempo filled in.

Rules: it only reads what the page already shows the user (or data the page itself already embedded for that view).
It never calls a site's private API (two exceptions on Songsterr, both data the page itself already downloads for the song
being viewed: the note-data file for the shown track, to get the exact rhythm, approved by the user on 2026-11-15; and the
video-points list `/api/video-points/<songId>/<revisionId>/list`, the per-bar YouTube timings, so Woodshed can start a
song already synced, approved by the user on 2026-11-16 knowing Songsterr sells uninterrupted video sync in its Plus
plan; the user asked that this not be advertised in the UI; and the song's track list `/api/meta/<songId>`, read only when
the page's embedded state is stale after moving between songs inside Songsterr, so the right track is picked, approved by
the user on 2026-11-17), never bypasses login or paywalls (Ultimate Guitar "Pro"/"Official" tabs that are
locked stay locked: show "This tab isn't available as text on this page"), never runs on pages until the user clicks
the extension (activeTab + scripting), and sends nothing anywhere except to the Woodshed tab the user chose, or, when no Woodshed tab is open, to Woodshed Amp on
this computer (ws://127.0.0.1:47800), which hands the tab only to the open Woodshed desktop app (the amp accepts extension
connections only for this one message; added 2026-11-16 at the user's request).

## Files (Manifest V3, no build step, no libraries)
```
manifest.json
popup.html, popup.css, popup.js        the UI (black, simple: matches Woodshed: #000 bg, #0c0c0c panels, #f2f2f2
                                       text, #8c8c8c muted, 1px #1f1f1f lines, white primary button, system-ui font)
extract.js                             injected with chrome.scripting.executeScript({files:['extract.js']}) into the
                                       active tab; defines globalThis.__woodshedExtract() and returns its result
lib/clean.js                           PURE text functions (ES module, no DOM): used by popup.js and the tests
options.html, options.js               Woodshed address (default https://sage-sage.github.io/woodshed/), "also check the hosted copy"
bridge.js                              content script for the Woodshed pages (below)
icons/16.png 32.png 48.png 128.png     (I will generate these; reference them in the manifest)
tests/clean.test.mjs                   node --test, fixtures inline as strings
README.md                              install (chrome://extensions → Developer mode → Load unpacked), use, sites
```
manifest: name "Woodshed Tab Grabber", version 1.0.0, action with popup, permissions ["activeTab", "scripting",
"storage", "clipboardWrite"], host_permissions only for the Woodshed bridge: "http://localhost/*",
"http://127.0.0.1/*". content_scripts: bridge.js on "http://localhost/*", "http://127.0.0.1/*", run_at
document_idle. Keyboard shortcut (commands): Alt+Shift+W opens the popup ("_execute_action").

## extract.js → returns
`{ ok, site, url, title, artist, tuning (string like "D A D G B E" or ""), capo (int|null), bpm (int|null),
   kind: "tab"|"chords"|"unsupported", text (raw), message }`
Order of strategies (first that yields ≥ 4 consecutive tab lines wins; record which in `site`):
1. The user's current text selection, if it is ≥ 3 lines (site "selection").
2. Site specific:
   - Ultimate Guitar (`*.ultimate-guitar.com/tab/...`): the page embeds its data as JSON in
     `div.js-store[data-content]`; read `store.page.data.tab_view.wiki_tab.content` (markup [tab]...[/tab],
     [ch]Am[/ch], [Verse] section headers), `store.page.data.tab.song_name`, `.artist_name`, `.type`
     ("Tabs", "Chords", "Bass Tabs", "Ukulele", "Guitar Pro", "Pro", "Official"), `tab_view.meta.tuning.value`,
     `tab_view.meta.capo`, `tab_view.meta.bpm` if present. If that JSON is missing or the shape differs, fall back to
     the rendered text of the tab container (`pre`, or `[class*="Tablature"]`, `code`). Types "Guitar Pro", "Pro",
     "Official", "Power" are interactive/locked: return kind "unsupported" with message "This is an interactive tab
     on Ultimate Guitar. Open the plain \"Tab\" version of the song, or use the Guitar Pro file if you own it".
   - Cifra Club (`cifraclub.com`, `cifraclub.com.br`): text of `.cifra_cnt pre` (or `pre`), title `h1.t1`, artist
     `h2.t3`; capo from the "Capotraste" text if present.
   - E-Chords (`e-chords.com`): `pre#core` or the largest `pre`; title/artist from `h1`/`h2`.
   - Songsterr (`songsterr.com`): tabs are drawn as graphics, there is no tab text on the page: return kind
     "unsupported" with message "Songsterr shows tabs as graphics, so there's no text to grab. Use Ultimate
     Guitar's text tab, or a Guitar Pro file, for this song".
   - AZChords, GuitarTabs.cc, Guitaretab.com, BigBassTabs, Tabs4Acoustic, 911Tabs (link pages: message "911Tabs
     links to other sites; open one of the results"), Chordie, Chordify ("chords only, no tab"): use the generic
     strategy, with title/artist from `h1` and `document.title` patterns "<Song> Tab by <Artist>", "<Artist> -
     <Song> (...) tab", "<Song> chords by <Artist>".
3. Generic: every `pre`, `code`, `textarea`, and any element whose computed `white-space` is pre/pre-wrap with
   monospace font; pick the block with the most tab lines (lib/clean.js `countTabLines`).
If nothing has ≥ 4 consecutive tab lines: kind "chords" when chord-over-lyric lines are found (Woodshed needs tab,
so the popup says "This page has chords but no tab lines — Woodshed needs tab notation"), else "unsupported".

## lib/clean.js (pure, exported, fully tested)
- `stripUgMarkup(s)`: remove [tab]/[/tab], turn [ch]X[/ch] into X keeping column alignment (the tag characters are
  not in the rendered text, so just delete the tags), keep [Verse]-style headers as plain lines, decode &amp; &lt;
  &gt; &quot; &#39; &nbsp;.
- `normalize(s)`: \r\n → \n, nbsp/tabs/zero-width → spaces (a tab character → spaces to the next multiple of 8),
  "—" "–" "‒" → "-", "│" "┃" "¦" → "|", trim trailing spaces, collapse > 2 blank lines.
- `isTabLine(line)`: string name optional (`e`, `B`, `G`, `D`, `A`, `E`, `Eb`, `d#`, `F#`…, or digits for 7/8
  strings) followed by `|` or `:` or `-`, then a run of ≥ 8 chars from `-0123456789|hpbr/\~x()<>.*sPHVvt^` with at
  least 60% dashes and digits. Lines of only `|`/spaces are not tab lines.
- `countTabLines(text)`: largest run of consecutive tab lines, and total.
- `detectTuning(text, hint)`: from hint ("D A D G B E", "Drop D", "Eb Ab Db Gb Bb Eb", "Half step down"), or a line
  "Tuning: …", or the string-name column of the systems (lowest first). Return letters lowest first, or "".
- `detectCapo(text, hint)`: hint number, "Capo 2", "Capo on 2nd fret", "capo: II" (roman 1-12), "no capo" → 0.
- `detectBpm(text, hint)`: hint, "BPM: 120", "Tempo: 96", "♩ = 100", "q=100".
- `toWoodshedText({title, artist, bpm, text})`: header lines `# Title: …`, `# Artist: …`, `# Tempo: N` (only when
  known), a blank line, then the cleaned text with leading/trailing non-tab prose (site chrome, "Intro" is kept,
  "Ultimate Guitar" ads/ratings removed: drop lines longer than 140 chars that contain no `|`).
- `summarize(text)`: {systems, tabLines, strings (most common system size), hasRhythmMarks}.

## popup.js
On open: inject extract.js into the active tab; show a spinner ≤ 3 s; then either the result card or the message.
Result card: song title (editable), artist (editable), site chip, "N systems · 6 strings · Drop D · capo 2 · 96 BPM"
(editable tuning select with Woodshed's preset names + "Auto", capo and BPM number inputs), a scrollable monospace
preview of the first 40 lines, and buttons:
- **Send to Woodshed** (primary): save `{v:1, title, artist, tuning, capo, bpm, text: toWoodshedText(...), source:
  site, url, ts}` in `chrome.storage.local` under "pendingImport"; then find an open tab whose URL starts with the
  configured Woodshed address → focus it and set its hash to `#/import`; otherwise open a new tab at
  `<address>#/import`. Close the popup.
- **Copy**: copies toWoodshedText to the clipboard (navigator.clipboard.writeText) and shows "Copied — paste it into
  Woodshed → Add Song".
- **Save .txt**: downloads `<Artist> - <Title>.txt` via a Blob URL anchor in the popup.
Errors (chrome:// pages, the Web Store, file:// without access): plain explanation.

## bridge.js (content script on the Woodshed pages)
Only acts when the page is Woodshed: `document.querySelector('meta[name="woodshed"]')` exists (I will add
`<meta name="woodshed" content="1">` to Woodshed's index.html). On load and on chrome.storage.onChanged for
"pendingImport" (and only if ts is < 10 minutes old): post `window.postMessage({source: "woodshed-tab-grabber",
type: "import-tab", payload}, window.location.origin)`, wait for a reply message `{source: "woodshed", type:
"import-tab-received", ts}` (retry every 500 ms up to 10 s while the app boots), then remove "pendingImport".

## Woodshed side (edits to the attached js/app.js and js/import.js; draft-mode JSON edits)
- app.js: listen for `message` events with `event.source === window && event.data?.source === "woodshed-tab-grabber"
  && event.data.type === "import-tab"`; validate the payload (strings ≤ 200 KB, numbers in range); store it in a
  module variable `pendingTabImport`; reply `{source:"woodshed", type:"import-tab-received", ts}`; navigate to
  `#/import` (or, if already there, dispatch a `woodshed:tab-import` CustomEvent on window). Expose
  `ctx.takePendingTabImport()` that returns and clears it.
- import.js: on mount and on `woodshed:tab-import`, if `ctx.takePendingTabImport()` returns a payload: switch to the
  "Paste Text Tab" tab, fill the textarea with payload.text, title, artist, BPM (if set), capo (if set), tuning
  (match by notes to a TUNINGS preset name, else "auto"), trigger the existing live parse, and toast
  `Tab from <source> loaded — check it and press Next`.
