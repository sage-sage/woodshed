# Woodshed Amp

A small Windows tray app for Woodshed. It plays your guitar back through an amp tone with almost no delay, using
your interface's ASIO driver. It also sends the dry guitar signal to the Woodshed website so the game can score you,
and the website picks a tone for each song.

## Use it

1. Plug in the MOTU M2, guitar into input 1, headphones or monitors on the M2.
2. Run `build\woodshed-amp.exe`. A red jewel icon appears in the notification area (right-click it for presets,
   input 1/2, bypass, mute, the ASIO control panel and "Start with Windows").
3. Open Woodshed at <https://sage-sage.github.io/woodshed/> (or "Open Woodshed" in the tray menu). It connects by itself;
   **Settings → Woodshed Amp** shows the latency and lets you change the presets and load captures.
4. Set the buffer in the MOTU's ASIO control panel: 64 samples at 48 kHz gives about 5 ms round trip.

Only one program can usually use the MOTU's ASIO driver at a time, so close any DAW first.

## Playing through laptop speakers

In **Settings → Woodshed Amp**, **Also play through** mirrors the processed amp output to a Windows WASAPI
device (such as your laptop speakers) while the MOTU M2 keeps running ASIO input and output. Because Windows
WASAPI adds buffering and sample-rate conversion on top of ASIO, the secondary output has roughly 15–30 ms of
extra delay — fine for casual practice without headphones, while headphones plugged directly into the M2 remain
near-zero latency.

## Tones

Ten built-in presets: Clean, Warm Jazz, Edge of Breakup, Crunch, Rock Lead, High Gain, Metal, Fuzz, Acoustic Sim
and Bass. Opening a song picks one from the tab: the Guitar Pro instrument and track name, power chords, palm mutes,
lead playing (bends, high frets) and drop tuning. The reason is shown under the Tone chip and in Learn. You can
override it per song.

For a much more realistic sound, load a Neural Amp Modeler capture (`.nam`) and/or a cabinet impulse response
(`.wav`) into any preset from Settings (free captures: tone3000.com). Captures are read from where you saved them;
the paths are remembered in `%APPDATA%\WoodshedAmp\presets.json`.

## Privacy

The app listens only on `127.0.0.1:47800` and only accepts connections from Woodshed pages (the GitHub Pages site,
localhost for development, and claude.ai artifact origins). Other websites cannot connect, so they cannot hear your guitar. Extra origins can be added one per
line in `%APPDATA%\WoodshedAmp\origins.txt`.

## Build

`./build.sh` (Git Bash) with LLVM-MinGW (`winget install MartinStorsjo.LLVM-MinGW.UCRT`). No CMake needed
(`CMakeLists.txt` is kept as an alternative). Dependencies in `deps/`: PortAudio (MIT), Neural Amp Modeler Core
(MIT) with Eigen (MPL-2.0) and nlohmann/json (MIT), and the Steinberg ASIO SDK used under GPLv3, so this app is
GPLv3.

Tests: `build/wsamp-tests.exe` (DSP), `build/wsamp-ws-tests.exe` (WebSocket/protocol),
`python -I tests/tone_check.py build\woodshed-amp-render.exe` (renders a guitar part through every preset into
`build-tone/` so you can listen and checks that each preset sounds like its name). `tests/fake_amp.py` stands in for
the app (streams a test tone) to test the website without an interface.
Offline renders: `build/woodshed-amp-render.exe in.wav out.wav --preset crunch [--nam f.nam] [--ir cab.wav]`.
