#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "dsp/chain.h"
#include "presets.h"
#include "wav.h"

namespace {

struct AudioStats {
    float peakDb = -120.0f;
    float rmsDb = -120.0f;
};

AudioStats computeStats(const std::vector<float>& samples) {
    if (samples.empty()) return {};
    double sumSq = 0.0;
    float peak = 0.0f;
    for (float s : samples) {
        const float a = std::abs(s);
        if (a > peak) peak = a;
        sumSq += static_cast<double>(s) * static_cast<double>(s);
    }
    const float rms = static_cast<float>(std::sqrt(sumSq / static_cast<double>(samples.size())));
    AudioStats st;
    st.peakDb = 20.0f * std::log10(std::max(peak, 1e-6f));
    st.rmsDb = 20.0f * std::log10(std::max(rms, 1e-6f));
    return st;
}

void printUsage(const char* argv0) {
    std::cerr << "Usage: " << argv0
              << " in.wav out.wav [--preset ID] [--nam file] [--ir file] [--block 64] [--rate 48000]\n";
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        printUsage(argv[0]);
        return 1;
    }

    std::string inPath;
    std::string outPath;
    std::string presetId = "crunch";
    std::string namPath;
    std::string irPath;
    int blockSize = 64;
    int targetRate = 48000;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--preset" && i + 1 < argc) {
            presetId = argv[++i];
        } else if (arg == "--nam" && i + 1 < argc) {
            namPath = argv[++i];
        } else if (arg == "--ir" && i + 1 < argc) {
            irPath = argv[++i];
        } else if (arg == "--block" && i + 1 < argc) {
            blockSize = std::max(1, std::atoi(argv[++i]));
        } else if (arg == "--rate" && i + 1 < argc) {
            targetRate = std::max(8000, std::atoi(argv[++i]));
        } else if (arg == "--help" || arg == "-h") {
            printUsage(argv[0]);
            return 0;
        } else if (inPath.empty()) {
            inPath = arg;
        } else if (outPath.empty()) {
            outPath = arg;
        } else {
            std::cerr << "Unknown argument: " << arg << "\n";
            printUsage(argv[0]);
            return 1;
        }
    }

    if (inPath.empty() || outPath.empty()) {
        printUsage(argv[0]);
        return 1;
    }

    wsamp::PresetBank bank;
    std::string err;
    bank.loadOverrides(wsamp::PresetBank::defaultPresetsPath(), err);

    const wsamp::Preset* preset = bank.findById(presetId);
    if (!preset) {
        std::cerr << "Unknown preset id: " << presetId << "\n";
        return 1;
    }

    wsamp::WavData wav;
    if (!wsamp::readWavMono(inPath, wav, err)) {
        std::cerr << "Failed reading input WAV: " << err << "\n";
        return 1;
    }

    std::vector<float> audio = wsamp::resampleWindowedSinc(wav.samples, wav.sampleRate, targetRate);
    const AudioStats inStats = computeStats(audio);

    wsamp::dsp::Chain chain;
    chain.prepare(static_cast<double>(targetRate), blockSize);
    chain.setParams(preset->params);
    chain.snapParameters();

    const std::string effectiveNam = !namPath.empty() ? namPath : preset->namPath;
    if (!effectiveNam.empty()) {
        if (!chain.loadNamSync(effectiveNam, err)) {
            std::cerr << "Failed loading NAM model: " << err << "\n";
            return 1;
        }
    }

    const std::string effectiveIr = !irPath.empty() ? irPath : preset->irPath;
    if (!effectiveIr.empty()) {
        if (!chain.loadIrFromWav(effectiveIr, err)) {
            std::cerr << "Failed loading IR WAV: " << err << "\n";
            return 1;
        }
    }

    const size_t totalSamples = audio.size();
    size_t numBlocks = 0;

    const auto t0 = std::chrono::steady_clock::now();
    for (size_t offset = 0; offset < totalSamples; offset += static_cast<size_t>(blockSize)) {
        const int n = static_cast<int>(std::min<size_t>(static_cast<size_t>(blockSize), totalSamples - offset));
        chain.process(audio.data() + offset, n);
        ++numBlocks;
    }
    const auto t1 = std::chrono::steady_clock::now();

    if (!wsamp::writeWavFloat32(outPath, audio, targetRate, 1, err)) {
        std::cerr << "Failed writing output WAV: " << err << "\n";
        return 1;
    }

    const AudioStats outStats = computeStats(audio);
    const double elapsedSec = std::chrono::duration<double>(t1 - t0).count();
    const double audioSec = static_cast<double>(totalSamples) / static_cast<double>(targetRate);
    const double usPerBlock = (numBlocks > 0) ? (elapsedSec * 1e6 / static_cast<double>(numBlocks)) : 0.0;
    const double rtf = (elapsedSec > 0.0) ? (audioSec / elapsedSec) : 0.0;

    std::printf("Preset: %s | Rate: %d Hz | Block: %d | Samples: %zu\n",
                preset->id.c_str(), targetRate, blockSize, totalSamples);
    std::printf("Input : peak = %.2f dBFS, RMS = %.2f dBFS\n", inStats.peakDb, inStats.rmsDb);
    std::printf("Output: peak = %.2f dBFS, RMS = %.2f dBFS\n", outStats.peakDb, outStats.rmsDb);
    std::printf("Perf  : %.2f us/block, real-time factor = %.1fx\n", usPerBlock, rtf);

    return 0;
}
