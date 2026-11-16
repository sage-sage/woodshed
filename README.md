# Woodshed

A guitar practice game that listens to your real guitar. Import a tab, line it up with a recording
(a YouTube video or an audio file), and play along while the notes scroll past and get scored.

## Run it

Open <https://sage-sage.github.io/woodshed/> in Chrome or Edge. Nothing to install.
Or install **Woodshed for Windows** (Settings → Downloads → Download Woodshed Setup): the setup wizard lets you
pick the Woodshed app (the game in its own window, works offline), **Woodshed Amp** (lowest latency and amp tones,
also works with the website), and the Tab Grabber extension.

1. Plug the guitar into your audio interface and click **Connect guitar**. In **Settings** pick the
   interface and the channel the guitar is on (Input 1 = left, Input 2 = right).
2. Run **Calibrate** in Settings once so timing is judged fairly for your interface.
3. Open the built-in demo song, or **Add song**.

## What is in it

- **Play**: scrolling tab highway, hit/miss scoring with timing, streaks and stars; speed 50-125%, bar
  loops, count-in, metronome, a built-in guitar that can play the tab; *Wait for note* mode that pauses until
  you play the right thing; three difficulty layers (roots, bass line, full part).
- **Add song**: paste a text tab, or load Guitar Pro (`.gp3 .gp4 .gp5 .gpx .gp`) / MusicXML files. Audio can
  be a YouTube link (played through YouTube's own embedded player; nothing is downloaded), an audio file
  from your computer, a direct audio URL, or none.
- **Sync**: tap along on the first beat of each bar, or mark the first note and set the tempo, then nudge.
  "Check it" plays the tab over the recording so you can hear whether they line up.
- **Learn**: key, scale on the fretboard, the chords with roman numerals and what each one does, the
  progression, why it works, and drills.
- **Tuner**: chromatic and per-string, any tuning preset, adjustable A4. While you play, the game also
  notices when a string is consistently flat or sharp and tells you.

## Good to know

- Text tabs carry no rhythm. Notes are spaced by their position in the bar, so sync those bar by bar.
  Guitar Pro files have exact rhythm and need only two or three taps.
- Single notes are judged by pitch. Chords are judged by checking that each chord note's harmonics are
  present; a note cannot be told apart from an octave or twelfth overtone of another ringing string, so
  chord checking is deliberately a little forgiving (60% of a big chord's notes).
- Everything is stored in your browser (IndexedDB). Use **Back Up All** in Settings to keep a copy.

## Development

No build step; `npm start` serves it locally for development. `node --test` runs the unit tests (pitch detection across the whole neck at 44.1/48 kHz,
chord recognition, onsets, tab parsing, Guitar Pro import, sync maths, theory).
Add `?virtual=1#/song/demo/play` to the address for the self-test: the built-in guitar is fed into
the detector and should score 95% or better.

Guitar Pro / MusicXML parsing uses [alphaTab](https://alphatab.net) (MPL-2.0), vendored unmodified in
`vendor/`.

## Credits

- Guide guitar samples: FluidR3_GM SoundFont by Frank Wen, rendered by [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts), licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Stored in `vendor/fluidr3/`.
- Fonts: Rye, Ultra, Archivo, Archivo Narrow, JetBrains Mono (SIL Open Font License) via Google Fonts.
