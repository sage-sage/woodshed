# Woodshed Amp — design spec (decided; implement exactly)

A tiny Windows tray app that turns the guitar signal into an amp tone with ~5 ms round-trip latency through the
interface's ASIO driver, and talks to the Woodshed website over a local WebSocket: the site picks the tone per song,
and the app streams the DRY guitar signal back so the site can score it.

Target machine: Windows 11 x64, MOTU M2 (ASIO driver "MOTU M Series"). Toolchain: LLVM-MinGW (clang, UCRT), CMake,
Ninja. C++20. Licence: GPLv3 (because of the ASIO SDK).

## Layout
```
woodshed-amp/
  CMakeLists.txt
  deps/portaudio            (git, MIT)          add_subdirectory with PA_USE_ASIO=ON, PA_BUILD_SHARED_LIBS=OFF
  deps/asiosdk              (Steinberg, GPLv3)  found by PortAudio as ../asiosdk
  deps/NeuralAmpModelerCore (MIT; Eigen, nlohmann/json inside Dependencies/)
  src/dsp/biquad.h          RBJ biquads (LP, HP, peak, low/high shelf), TDF-II, double state
  src/dsp/oversampler.h     4x polyphase halfband up/down (two cascaded 2x stages, ~47-tap halfband FIR each,
                            latency reported in samples; < 1 ms total)
  src/dsp/builtin_amp.h/.cpp  the built-in amp (below)
  src/dsp/cab.h/.cpp        built-in virtual cabinet (biquad cascade) and IR convolver (FIR)
  src/dsp/effects.h/.cpp    noise gate, chorus, delay, reverb, output stage
  src/dsp/chain.h/.cpp      Chain: owns everything above + optional NAM model; process(float* io, int n)
  src/nam_slot.h/.cpp       load .nam off the audio thread, swap in lock-free
  src/wav.h/.cpp            read WAV (PCM 16/24/32, float 32, mono or first channel) + resample to device rate
  src/presets.h/.cpp        built-in presets + user overrides in %APPDATA%\WoodshedAmp\presets.json
  src/spsc.h                lock-free single-producer/single-consumer ring (POD items, power-of-two capacity)
  tools/render.cpp          offline: woodshed-amp-render in.wav out.wav --preset crunch [--nam f] [--ir f]
  tests/dsp_tests.cpp       plain asserts, exit code = failures
  (round 2) src/audio_engine.*, src/ws_server.*, src/sha1_base64.*, src/tray.*, src/main.cpp
```

## Signal chain (mono, float, device rate 44.1/48/96 kHz, block = ASIO buffer, typically 64)
input trim (dB) → noise gate → AMP → CAB → post EQ → chorus → delay → reverb → output level → soft limiter → L+R.

AMP = NAM model when the preset has a loaded .nam file, otherwise the built-in amp. CAB = loaded IR when present,
otherwise the built-in cab. When a NAM model is a "full rig" capture (the preset flag `namIncludesCab`), skip CAB.
Everything is allocation-free and lock-free in process(); parameters change through std::atomic<float> targets that
are smoothed per block (one-pole, ~20 ms) to avoid zipper noise.

### Built-in amp (BuiltinAmp)
Params: gain (0..10), bass, mid, treble, presence (0..10, 5 = flat), tight (HPF Hz before the drive, 20..400),
character enum {Clean, Breakup, Crunch, HighGain, Fuzz}, sag (0..1), level (dB).
- Pre: HPF at `tight` (2nd order), then a gentle pre-emphasis peak +3 dB at 700 Hz for Crunch/HighGain.
- Drive: run at 4x oversampling. Stage count by character: Clean 1, Breakup 1, Crunch 2, HighGain 3, Fuzz 2.
  Stage gain from `gain`: dB = map(gain, 0..10 -> {Clean 0..18, Breakup 6..28, Crunch 12..36, HighGain 20..52,
  Fuzz 24..48}) split evenly across stages. Each stage: x*g → asymmetric soft clip
  y = tanh(x + bias) - tanh(bias) with bias 0.15 (Clean 0.05, Fuzz 0.35) → 1st-order LP at 6 kHz (interstage) →
  DC blocker (HP 10 Hz). Fuzz uses a harder curve: y = clamp(1.5x - 0.5x^3) after the tanh stage.
- Sag: envelope follower (attack 5 ms, release 120 ms) of the post-drive level reduces the next block's drive gain by
  up to sag*4 dB.
- Tone stack after the drive (passive-stack approximation): low shelf 120 Hz ±10 dB from bass, peak 650 Hz Q 0.7
  ±10 dB from mid (HighGain defaults to a scoop via its preset values, not hard-coded), high shelf 3.2 kHz ±10 dB from
  treble, high shelf 5 kHz ±6 dB from presence. Knob→dB: (v-5)*2 for bass/mid/treble, (v-5)*1.2 for presence.
- Output normalised so a −18 dBFS RMS 110 Hz test tone through any preset comes out within ±3 dB of −18 dBFS before
  `level` (compute a static make-up gain per character/gain at parameter change; do NOT use an AGC).

### Built-in cab (CabSim): zero-latency biquad cascade, type enum
- C412 (closed 4x12): HP 75 Hz Q .8, peak 110 Hz +3 dB Q 1, peak 450 Hz −3 dB Q 1, peak 2.4 kHz +4 dB Q 1.4,
  LP 5.2 kHz Q .7, LP 6.0 kHz Q .7, peak 7.5 kHz −8 dB Q 3.
- O212 (open 2x12): HP 70, peak 1.8 kHz +3 Q 1.2, LP 6.5k ×2, peak 3.5k −2 Q 2.
- O112 (open 1x12, for clean/jazz): HP 80, peak 200 Hz +1.5, LP 5.8k ×2, peak 2.8k +2 Q 1.
- Acoustic (body sim for an electric playing acoustic parts): HP 90, peak 100 Hz +5 Q 1.5, peak 220 +3 Q 1.2,
  peak 900 −3 Q 1, high shelf 6 kHz +4, LP 14k.
- Bass (1x15 / 4x10 blend): HP 35, peak 80 +3, peak 600 −2, LP 4.5k ×2.
### IR convolver: user .wav, resampled to device rate (windowed-sinc, 32 taps), truncated to 2048 taps with a 64-tap
half-Hann fade-out, normalised to unit energy, direct-form FIR with an interleaved double-length history buffer
(no modulo in the inner loop). Zero latency.

### Effects
- Gate: threshold dB (−80 = off), attack 1 ms, hold 40 ms, release 80 ms, hysteresis 6 dB, keyed on the INPUT.
- Chorus: 1 voice, 7 ms base delay, depth 3 ms, rate 0.8 Hz, mix 0..1, linear-interp delay read.
- Delay: time ms (0..1000), feedback 0..0.85, mix 0..1, LP 4 kHz in the feedback path; ping-pong not needed.
- Reverb: Freeverb-style (8 combs + 4 allpasses, tunings scaled from 44.1 kHz), size 0..1, damp 0.4, mix 0..1.
- Output: level dB, then a soft limiter (tanh above −1 dBFS knee) so it can never clip the interface.

### NAM slot
`nam::get_dsp(path)` on a loader thread; `Reset(deviceRate, maxBlock)`; if the model's expected rate differs and it
cannot adapt, reject with a clear error (we do not resample in real time). Loudness: if `HasLoudness()`, apply
make-up gain to target −18 dBFS. Swap via std::atomic<nam::DSP*>; the old model is deleted on the loader thread
after the audio thread acknowledges (epoch counter). Build NAM sources directly into our target with
NAM_SAMPLE_FLOAT defined and include dirs Dependencies/eigen, Dependencies/nlohmann (+ AudioDSPTools if needed).

## Presets (ids are the contract with the website)
| id | name | amp character / gain / B M T P / tight | cab | gate | fx |
|---|---|---|---|---|---|
| clean | Clean | Clean 3, 5 5 6 6, 60 | O112 | −70 | chorus .15, reverb .18 |
| jazz | Warm Jazz | Clean 2, 6 6 3.5 4, 50 | O112 | −72 | reverb .12 |
| breakup | Edge of Breakup | Breakup 5, 5 6 6 6, 80 | O212 | −65 | reverb .14 |
| crunch | Crunch | Crunch 5, 5 6 6 6, 100 | C412 | −60 | reverb .1 |
| rock_lead | Rock Lead | Crunch 8, 5 7 6 6, 110 | C412 | −58 | delay 380 ms fb .3 mix .18, reverb .15 |
| high_gain | High Gain | HighGain 6, 6 4 6 6, 140 | C412 | −52 | reverb .08 |
| metal | Metal | HighGain 8, 6 3.5 6.5 6.5, 220 | C412 | −48 | none |
| fuzz | Fuzz | Fuzz 7, 6 4 5 5, 40 | O212 | −60 | reverb .1 |
| acoustic | Acoustic Sim | Clean 1, 5 5 6 6, 90 | Acoustic | −72 | chorus .1, reverb .2 |
| bass | Bass | Clean 3, 6 5 5 5, 30 | Bass | −70 | none |

presets.json stores per-id overrides only: {id: {namPath?, namIncludesCab?, irPath?, params?{...}}}. Missing file =
defaults. Writes are atomic (write temp + rename) and happen off the audio thread.

## Offline render tool (for testing without the interface)
`woodshed-amp-render in.wav out.wav --preset ID [--nam file] [--ir file] [--block 64] [--rate 48000]` processes the
file through exactly the same Chain in blocks, writes 32-bit float WAV, prints peak/RMS in and out and the measured
process time per block (µs) and the real-time factor.

## DSP tests (tests/dsp_tests.cpp)
- Biquad LP/HP/peak/shelf magnitude at 5 frequencies within 0.3 dB of the analytic RBJ response.
- Oversampler: a 1 kHz sine up+down returns within 0.1 dB; aliasing test: 15 kHz sine through the Crunch drive at
  48 kHz shows no component above −60 dBc between 1 and 12 kHz other than harmonics of 15k folded… (simplify: check
  energy below 10 kHz is < −40 dB relative to the output when input is a 15 kHz sine).
- Every preset: silence in → silence out (< −100 dBFS after the gate); −18 dBFS RMS 110 Hz tone → output RMS within
  −18 ± 4 dBFS; no NaN/Inf for full-scale noise; never exceeds 0 dBFS (limiter).
- IR convolver vs naive convolution on random data: max error < 1e-5.
- Gate opens within 2 ms of a pluck and closes after hold+release.
- Real-time budget: the most expensive preset (metal) processes 10 s of audio at 48 kHz in < 250 ms single-threaded
  (−O2), i.e. real-time factor > 40.

## Round 2 (later): engine, WebSocket, tray — protocol summary for reference
WebSocket server on 127.0.0.1:47800, path /ws. Origin allow-list: http(s)://localhost:*, http(s)://127.0.0.1:*,
https://claude.ai, https://*.claude.ai, https://*.claudeusercontent.com; others get 403 (protects the mic stream).
Text frames JSON; binary frames = audio: 'WSA1' magic, u32 sampleRate, u32 frameIndex, u32 count, then count int16
mono samples of the DRY input (device rate), ~every 5 ms.

---------------------------------------------------------------------------------------------------------------------
# ROUND 2 — audio engine, WebSocket server, tray app (decided)

## AudioEngine (src/audio_engine.h/.cpp), PortAudio built with PA_USE_ASIO=ON, static
- Host API: ASIO only (Pa_HostApiTypeIdToHostApiIndex(paASIO)). Device: by saved name, else the first device whose
  name contains "MOTU", else the ASIO default. Never fall back to MME/WASAPI silently: report "no ASIO device".
- Stream: input = 2 channels (MOTU M2 inputs 1+2), output = 2 channels, float32, non-interleaved
  (paNonInterleaved), sample rate saved (default 48000), framesPerBuffer = paFramesPerBufferUnspecified so the ASIO
  control panel's buffer size is used; report the actual latencies from Pa_GetStreamInfo (input/output latency) and
  round trip = input + output.
- inputChannel setting: 0 = input 1, 1 = input 2, 2 = sum. Default 0 (guitar on the M2's front Hi-Z input 1).
- Callback: copy the chosen input into the Chain buffer; push the DRY input as int16 into the SPSC ring for the
  WebSocket stream (drop on overflow, count drops); run Chain::process; write to out L and R; measure the peak of in
  and out and the callback CPU load (QueryPerformanceCounter time / buffer duration) into atomics.
- Bypass (atomic): output = dry input (so the player still hears themselves). Mute (atomic): output = 0.
- openAsioControlPanel(): PaAsio_ShowControlPanel (lets the user change the MOTU buffer size).
- restart(): close + reopen the stream off the audio thread (after device, rate or channel changes). The Chain is
  prepare()'d with the new rate and max block 4096.
- Count paInputOverflow/paOutputUnderflow flags as xruns.

## WsServer (src/ws_server.h/.cpp + src/sha1_base64.h/.cpp), Winsock2, one thread, select() loop, max 4 clients
- Listen 127.0.0.1:47800 only. HTTP Upgrade on any path; RFC 6455 handshake (Sec-WebSocket-Accept = base64(SHA1(key
  + GUID))). Origin allow-list (others get HTTP 403 and close): http://localhost[:port], http://127.0.0.1[:port],
  https://localhost[:port], https://claude.ai, https://*.claude.ai, https://*.claudeusercontent.com, plus any origins
  listed in %APPDATA%\WoodshedAmp\origins.txt (one per line). No Origin header = rejected (browsers always send one;
  this keeps other local programs and random websites from reading the guitar stream).
- Frames: text and binary; client frames must be masked; reassemble fragments up to 64 KB; ping/pong; close; server
  frames unmasked. Non-blocking sockets, per-client send queue capped at 256 KB (drop audio frames, never JSON).
- Audio stream: every 5 ms drain the SPSC ring and send one binary frame per streaming client: bytes 0-3 'WSA1', u32 LE
  sampleRate, u32 LE frameIndex (running count of samples), u32 LE count, then count int16 LE samples. Streaming is
  per client and off until the client sends {"type":"stream","on":true}.
- Status every 250 ms to every client.

## JSON protocol (text frames). Client -> app
{"type":"hello","client":"woodshed","version":1}        -> app replies hello + presets + devices + status
{"type":"preset","id":"crunch"}
{"type":"param","id":"crunch","key":"gain","value":6.5}  -> override one built-in amp/fx param of a preset (saved)
{"type":"resetPreset","id":"crunch"}                     -> drop overrides, capture and IR for that preset
{"type":"browse","id":"crunch","kind":"nam"|"ir"}        -> native Open dialog (GetOpenFileNameW, *.nam or *.wav) on a
                                                            helper thread; load into that preset; save; reply presets
{"type":"clearFile","id":"crunch","kind":"nam"|"ir"}
{"type":"stream","on":true}  {"type":"bypass","on":true}  {"type":"mute","on":true}
{"type":"device","name":"MOTU M Series","inputChannel":0,"sampleRate":48000}
{"type":"asioPanel"}
App -> client
{"type":"hello","app":"woodshed-amp","version":"1.0.0","protocol":1}
{"type":"presets","current":"crunch","list":[{"id","name","nam":file-name|null,"namIncludesCab":bool,
  "ir":file-name|null,"params":{effective values}}]}
{"type":"devices","list":["MOTU M Series"],"current":"MOTU M Series"}
{"type":"status","running":true,"device":"MOTU M Series","sampleRate":48000,"bufferFrames":64,"inputMs":2.1,
  "outputMs":2.4,"roundTripMs":5.8,"inPeakDb":-14.2,"outPeakDb":-6.1,"clip":false,"cpu":0.07,"xruns":0,
  "bypass":false,"mute":false,"preset":"crunch","streamDrops":0,"inputChannel":0}
{"type":"error","message":"human readable"}

## Tray (src/tray.h/.cpp) + src/main.cpp, Win32, -mwindows, single instance (named mutex
"WoodshedAmpSingleInstance"; a second launch shows a balloon "already running" via the first instance and exits)
- Notification-area icon drawn at runtime with GDI (a red jewel, 16 and 32 px). Tooltip "Woodshed Amp - Crunch - 5.8 ms",
  refreshed every second.
- Right-click menu: status line (disabled), Presets > (radio items), Input > Input 1 / Input 2 / Both, Bypass (check),
  Mute (check), ASIO control panel..., Open Woodshed (ShellExecute http://localhost:8642/), Start with Windows (check;
  HKCU\Software\Microsoft\Windows\CurrentVersion\Run), Quit. Double-click = toggle Bypass.
- Errors (no ASIO device, device busy) show one balloon and retry every 5 s.
- Settings (device, inputChannel, sampleRate, last preset, startWithWindows) in %APPDATA%\WoodshedAmp\settings.json.

---------------------------------------------------------------------------------------------------------------------
# ROUND 3 — website side (Woodshed, plain ES modules)

## js/amp-link.js (no game imports)
export class AmpLink extends EventTarget: connect() to ws://127.0.0.1:47800/ws, auto-reconnect with backoff 1 s to
10 s (pauses while the page has been hidden > 60 s), sends hello on open. state 'offline'|'connecting'|'online'.
Exposes .status .presets .devices and setPreset(id), setParam(id,k,v), resetPreset(id), browse(id,kind),
clearFile(id,kind), setBypass(on), setMute(on), setDevice(obj), openAsioPanel(), setStreaming(on).
Events: state, status, presets, devices, error.
Audio: decode WSA1 frames into a jitter buffer feeding `ampSource` (AudioWorkletNode from a Blob-URL module; fallback
ScriptProcessorNode 1024 if worklets or blob URLs are blocked). Target 25 ms; drop/insert to stay within 10-60 ms;
linear resample when the app rate differs from the AudioContext rate. .streamLatencyMs = current buffer.

## GuitarInput integration
- Setting `inputSource`: 'auto' (default) | 'browser' | 'amp'. In auto, when the amp is online the game uses the amp
  stream (input.connectSource(ampLink.ampSource); stop getUserMedia so the MOTU is not opened twice) and the rail shows
  "Guitar via Woodshed Amp - 5.8 ms"; otherwise the existing browser input.
- With the amp as the source the browser monitor is forced off, and scoring latency compensation = roundTripMs / 2 +
  streamLatencyMs + settings.latencyMs (user trim; the Calibrate routine keeps working as is).

## Tone suggestion (js/tone-suggest.js, pure, node-testable)
suggestTone(song) -> {id, confidence 0..1, reasons:[string]}. Features:
- song.instrument = {program, name} (new, optional; tab-gp.js fills it from the track's playbackInfo.program and name).
  GM 24/25 -> acoustic; 26 -> jazz; 27, 28 -> clean; 29 -> crunch; 30 -> high_gain; 32-39 -> bass. Name keywords
  (case-insensitive): acoustic, jazz, clean, crunch|drive|od, dist|distortion|lead|solo, fuzz, bass, metal|djent.
- bass when 4-5 strings and the lowest open string <= 33, or a bass program/name.
- pmShare = palm-muted notes / notes; powerShare = share of chord events that are fifths/octaves only (2-3 notes);
  openChordShare = share of 3+ note events containing a third; leadShare = share of single notes with bend, vibrato
  or slide, or fret >= 12; low = lowest tuning note <= 38; bpm.
- Rules, first match wins (confidence higher when more cues agree):
  1 bass -> bass. 2 acoustic -> acoustic. 3 jazz -> jazz.
  4 distortion program/name or metal keyword: (low, or pmShare > .25 and bpm > 120) -> metal, else high_gain.
  5 fuzz -> fuzz. 6 overdriven/crunch: leadShare > .4 -> rock_lead, else crunch.
  7 clean program/name: powerShare > .3 -> breakup, else clean.
  8 no instrument info: pmShare > .25 and powerShare > .3 -> (low -> metal, else high_gain); powerShare > .3 -> crunch;
    leadShare > .45 -> rock_lead; openChordShare > .35 and powerShare < .1 -> clean; else breakup.
  reasons: up to 3 short phrases ("Track is a distortion guitar", "42% of chords are power chords", "palm mutes on
  30% of notes", "drop-D tuning").

## UI
- Settings card "Woodshed Amp": connection state; when offline a one-line explanation of what the amp is and how to
  start it; when online: device, sample rate, buffer, round trip ms, CPU, in/out meters, input channel select, Bypass,
  Mute, "ASIO control panel" button, input source select, and a preset list: name, "Capture: <file> [Load .nam]
  [Clear]", "Cabinet IR: <file> [Load .wav] [Clear]", gain/bass/mid/treble/presence sliders -> setParam, [Reset].
- Play view: "Tone" chip next to the mode toggle: "Tone: Crunch (suggested)" with a select to override; on song open
  tone = record.tone || suggestTone(song).id is sent to the amp; tooltip lists the reasons; changing it saves
  record.tone. Hidden while the amp is offline.
- Learn view: one line under "The big picture": "Suggested tone: Crunch - 42% power chords, palm mutes".
