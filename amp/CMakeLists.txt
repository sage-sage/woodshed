cmake_minimum_required(VERSION 3.20)
project(woodshed-amp VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

add_compile_options(-O2 -Wall -Wextra -Wno-unused-parameter)

if(WIN32)
    add_compile_definitions(NOMINMAX WIN32_LEAN_AND_MEAN)
    add_link_options(-static)
endif()

set(NAM_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/deps/NeuralAmpModelerCore")

file(GLOB NAM_CORE_SOURCES CONFIGURE_DEPENDS
    "${NAM_ROOT}/NAM/*.cpp"
    "${NAM_ROOT}/NAM/wavenet/*.cpp"
)

set(WSAMP_DSP_SOURCES
    src/dsp/builtin_amp.cpp
    src/dsp/cab.cpp
    src/dsp/effects.cpp
    src/dsp/chain.cpp
    src/nam_slot.cpp
    src/wav.cpp
    src/presets.cpp
    ${NAM_CORE_SOURCES}
)

add_library(wsamp_dsp STATIC ${WSAMP_DSP_SOURCES})

target_compile_definitions(wsamp_dsp PUBLIC NAM_SAMPLE_FLOAT)

target_include_directories(wsamp_dsp PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${NAM_ROOT}"
    "${NAM_ROOT}/NAM"
    "${NAM_ROOT}/Dependencies/eigen"
    "${NAM_ROOT}/Dependencies/nlohmann"
)

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/Dependencies/eigen")
    target_include_directories(wsamp_dsp PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/Dependencies/eigen")
endif()
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/Dependencies/nlohmann")
    target_include_directories(wsamp_dsp PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/Dependencies/nlohmann")
endif()

add_executable(woodshed-amp-render tools/render.cpp)
target_link_libraries(woodshed-amp-render PRIVATE wsamp_dsp)

enable_testing()
add_executable(wsamp-tests tests/dsp_tests.cpp)
target_link_libraries(wsamp-tests PRIVATE wsamp_dsp)
add_test(NAME dsp_tests COMMAND wsamp-tests)

# ============================================================================
# ROUND 2: PortAudio (ASIO) + Woodshed Amp Windows Tray & WebSocket Server
# ============================================================================
set(PA_USE_ASIO ON CACHE BOOL "" FORCE)
set(PA_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(PA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(PA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
add_subdirectory(deps/portaudio)

if(TARGET PortAudio::PortAudio)
    set(WSAMP_PORTAUDIO_TARGET PortAudio::PortAudio)
elseif(TARGET PortAudio)
    set(WSAMP_PORTAUDIO_TARGET PortAudio)
else()
    set(WSAMP_PORTAUDIO_TARGET portaudio_static)
endif()

add_executable(woodshed-amp WIN32
    src/audio_engine.cpp
    src/sha1_base64.cpp
    src/ws_server.cpp
    src/app_controller.cpp
    src/tray.cpp
    src/main.cpp
)
target_include_directories(woodshed-amp PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/deps/portaudio/include"
)
target_link_libraries(woodshed-amp PRIVATE
    wsamp_dsp
    ${WSAMP_PORTAUDIO_TARGET}
    ws2_32
    shell32
    user32
    gdi32
    comdlg32
    ole32
    advapi32
    winmm
)

add_executable(wsamp-ws-tests
    tests/ws_tests.cpp
    src/sha1_base64.cpp
    src/ws_server.cpp
)
target_include_directories(wsamp-ws-tests PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
)
if(WIN32)
    target_link_libraries(wsamp-ws-tests PRIVATE ws2_32)
endif()
add_test(NAME ws_tests COMMAND wsamp-ws-tests)
