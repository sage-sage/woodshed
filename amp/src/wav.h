#pragma once

#include <filesystem>
#include <span>
#include <string>
#include <vector>

namespace wsamp {

struct WavData {
    int sampleRate = 48000;
    int numChannels = 1;
    int bitsPerSample = 16;
    std::vector<float> samples; // mono (or channel 0) normalized to [-1, 1]
};

// Reads PCM 16/24/32-bit or IEEE float 32-bit WAV (mono or extracts channel 0).
bool readWavMono(const std::filesystem::path& path, WavData& out, std::string& errorOut);

// Writes a 32-bit IEEE float WAV file.
bool writeWavFloat32(const std::filesystem::path& path,
                     std::span<const float> samples,
                     int sampleRate,
                     int numChannels,
                     std::string& errorOut);

// Resamples mono audio using a 32-tap Blackman-windowed sinc filter.
std::vector<float> resampleWindowedSinc(std::span<const float> input, int srcRate, int dstRate);

} // namespace wsamp
