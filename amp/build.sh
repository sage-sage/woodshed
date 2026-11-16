#!/usr/bin/env bash
# Build Woodshed Amp with LLVM-MinGW (clang), no CMake needed.
#   ./build.sh          incremental build of everything into build/
#   ./build.sh clean    start over
# Outputs: build/woodshed-amp.exe (tray app), build/woodshed-amp-render.exe, build/wsamp-tests.exe,
#          build/wsamp-ws-tests.exe
set -euo pipefail
cd "$(dirname "$0")"
[ "${1:-}" = clean ] && rm -rf build

if ! command -v clang++ >/dev/null 2>&1; then
  LLVM=$(ls -d "$HOME"/AppData/Local/Microsoft/WinGet/Packages/MartinStorsjo.LLVM-MinGW*/llvm-mingw-*/bin 2>/dev/null | head -1)
  [ -n "$LLVM" ] || { echo "LLVM-MinGW not found (winget install MartinStorsjo.LLVM-MinGW.UCRT)"; exit 1; }
  export PATH="$LLVM:$PATH"
fi

B=build
N=deps/NeuralAmpModelerCore
P=deps/portaudio
A=deps/asiosdk
mkdir -p $B/obj

CXXFLAGS="-std=c++20 -O2 -DNAM_SAMPLE_FLOAT -DNOMINMAX -DWIN32_LEAN_AND_MEAN -DUNICODE -D_UNICODE
  -Isrc -I$N -I$N/NAM -I$N/Dependencies/eigen -I$N/Dependencies/nlohmann -I$P/include"
PADEF="-O2 -DPA_USE_ASIO=1 -DPA_USE_WMME=0 -DPA_USE_DS=0 -DPA_USE_WASAPI=1 -DPA_USE_WDMKS=0 -DPA_USE_JACK=0
  -DPA_LITTLE_ENDIAN -DNDEBUG -I$P/include -I$P/src/common -I$P/src/os/win -I$A/common -I$A/host -I$A/host/pc -w"

# compile SRC OBJ COMPILER FLAGS... (skips when the object is newer than the source and every header in src/)
compile() {
  local src=$1 obj=$2; shift 2
  if [ -f "$obj" ] && [ "$obj" -nt "$src" ] && [ -z "$(find src -name '*.h' -newer "$obj" 2>/dev/null | head -1)" ]; then
    return 0
  fi
  echo "  ${src}"
  "$@" -c "$src" -o "$obj"
}

pids=()
wait_all() { local ok=0; for p in "${pids[@]}"; do wait "$p" || ok=1; done; pids=(); return $ok; }
par() { "$@" & pids+=($!); if [ ${#pids[@]} -ge 8 ]; then wait_all; fi; }

echo "PortAudio (ASIO + WASAPI) + ASIO SDK"
for f in $P/src/common/{pa_allocation,pa_converters,pa_cpuload,pa_debugprint,pa_dither,pa_front,pa_process,pa_ringbuffer,pa_stream,pa_trace}.c \
         $P/src/os/win/{pa_win_coinitialize,pa_win_hostapis,pa_win_util,pa_win_version,pa_win_waveformat}.c \
         $P/src/hostapi/wasapi/pa_win_wasapi.c; do
  par compile "$f" $B/obj/pa_$(basename "$f" .c).o clang $PADEF
done
for f in $P/src/hostapi/asio/pa_asio.cpp $P/src/hostapi/asio/iasiothiscallresolver.cpp \
         $A/common/asio.cpp $A/host/asiodrivers.cpp $A/host/pc/asiolist.cpp; do
  par compile "$f" $B/obj/pa_$(basename "$f" .cpp).o clang++ $PADEF
done
wait_all

echo "Neural Amp Modeler core"
for f in $N/NAM/*.cpp $N/NAM/wavenet/*.cpp; do
  par compile "$f" $B/obj/nam_$(basename "$f" .cpp).o clang++ $CXXFLAGS -w
done
wait_all

echo "Woodshed Amp"
APP_SRC=(src/dsp/builtin_amp.cpp src/dsp/cab.cpp src/dsp/effects.cpp src/dsp/chain.cpp src/nam_slot.cpp src/wav.cpp
         src/presets.cpp)
NET_SRC=(src/sha1_base64.cpp src/ws_server.cpp)
APPONLY_SRC=(src/audio_engine.cpp src/app_controller.cpp src/updater.cpp src/tray.cpp src/main.cpp)
for f in "${APP_SRC[@]}" "${NET_SRC[@]}" "${APPONLY_SRC[@]}" tools/render.cpp tests/dsp_tests.cpp tests/ws_tests.cpp; do
  [ -f "$f" ] || continue
  par compile "$f" $B/obj/app_$(basename "$f" .cpp).o clang++ $CXXFLAGS -Wall -Wextra -Wno-unused-parameter
done
wait_all

DSP_OBJ=($B/obj/nam_*.o $(for f in "${APP_SRC[@]}"; do echo $B/obj/app_$(basename $f .cpp).o; done))
NET_OBJ=($(for f in "${NET_SRC[@]}"; do if [ -f "$f" ]; then echo $B/obj/app_$(basename $f .cpp).o; fi; done))
LIBS="-static -lole32 -luuid -lwinmm -lws2_32 -lshell32 -luser32 -lgdi32 -lcomdlg32 -ladvapi32 -lwinhttp -lbcrypt"

echo "Linking"
clang++ -o $B/woodshed-amp-render.exe $B/obj/app_render.o "${DSP_OBJ[@]}" -static
clang++ -o $B/wsamp-tests.exe $B/obj/app_dsp_tests.o "${DSP_OBJ[@]}" -static
if [ -f tests/ws_tests.cpp ]; then
  clang++ -o $B/wsamp-ws-tests.exe $B/obj/app_ws_tests.o "${NET_OBJ[@]}" "${DSP_OBJ[@]}" $LIBS
fi
if [ -f src/main.cpp ]; then
  APP_OBJ=($(for f in "${APPONLY_SRC[@]}"; do echo $B/obj/app_$(basename $f .cpp).o; done))
  clang++ -mwindows -o $B/woodshed-amp.exe "${APP_OBJ[@]}" "${NET_OBJ[@]}" "${DSP_OBJ[@]}" $B/obj/pa_*.o $LIBS
fi
if [ -f src/desktop/desktop_main.cpp ]; then
  compile src/desktop/desktop_main.cpp $B/obj/desk_main.o clang++ $CXXFLAGS -Ideps/webview2/include -Wno-unknown-pragmas -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00 -Wall -Wextra -Wno-unused-parameter
  WINDRES=$(command -v llvm-windres || command -v windres)
  if [ ! -f $B/obj/desk_res.o ] || [ src/desktop/woodshed.rc -nt $B/obj/desk_res.o ] || [ src/desktop/woodshed.manifest -nt $B/obj/desk_res.o ] || [ src/desktop/woodshed.ico -nt $B/obj/desk_res.o ]; then
    "$WINDRES" src/desktop/woodshed.rc -O coff -o $B/obj/desk_res.o
  fi
  clang++ -mwindows -o $B/woodshed.exe $B/obj/desk_main.o $B/obj/app_updater.o $B/obj/desk_res.o -static -lole32 -luuid -lshell32 -luser32 -lgdi32 -ladvapi32 -lwinhttp -lbcrypt -lshlwapi
  [ -f deps/webview2/x64/WebView2Loader.dll ] && cp -f deps/webview2/x64/WebView2Loader.dll $B/
fi
ls -la $B/*.exe
