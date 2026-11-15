#include "wav.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>

namespace wsamp {

namespace {

constexpr double kPi = 3.14159265358979323846;

uint16_t readU16LE(const uint8_t* p) noexcept {
    return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

uint32_t readU32LE(const uint8_t* p) noexcept {
    return static_cast<uint32_t>(p[0]) |
           (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

void writeU16LE(std::ofstream& out, uint16_t v) {
    uint8_t b[2] = {
        static_cast<uint8_t>(v & 0xFFu),
        static_cast<uint8_t>((v >> 8) & 0xFFu)
    };
    out.write(reinterpret_cast<const char*>(b), 2);
}

void writeU32LE(std::ofstream& out, uint32_t v) {
    uint8_t b[4] = {
        static_cast<uint8_t>(v & 0xFFu),
        static_cast<uint8_t>((v >> 8) & 0xFFu),
        static_cast<uint8_t>((v >> 16) & 0xFFu),
        static_cast<uint8_t>((v >> 24) & 0xFFu)
    };
    out.write(reinterpret_cast<const char*>(b), 4);
}

} // namespace

bool readWavMono(const std::filesystem::path& path, WavData& out, std::string& errorOut) {
    errorOut.clear();
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        errorOut = "Cannot open WAV file: " + path.string();
        return false;
    }

    uint8_t riffHeader[12]{};
    file.read(reinterpret_cast<char*>(riffHeader), 12);
    if (!file || std::memcmp(riffHeader, "RIFF", 4) != 0 || std::memcmp(riffHeader + 8, "WAVE", 4) != 0) {
        errorOut = "Invalid RIFF/WAVE header in: " + path.string();
        return false;
    }

    bool haveFmt = false;
    bool haveData = false;
    uint16_t formatTag = 0;
    uint16_t numChannels = 0;
    uint32_t sampleRate = 0;
    uint16_t blockAlign = 0;
    uint16_t bitsPerSample = 0;
    std::vector<uint8_t> rawData;

    while (file && (!haveFmt || !haveData)) {
        uint8_t chunkHeader[8]{};
        file.read(reinterpret_cast<char*>(chunkHeader), 8);
        if (!file) break;

        const uint32_t chunkSize = readU32LE(chunkHeader + 4);
        if (std::memcmp(chunkHeader, "fmt ", 4) == 0) {
            if (chunkSize < 16) {
                errorOut = "Corrupt fmt chunk in WAV";
                return false;
            }
            std::vector<uint8_t> fmt(chunkSize);
            file.read(reinterpret_cast<char*>(fmt.data()), chunkSize);
            if (!file) {
                errorOut = "Unexpected EOF reading fmt chunk";
                return false;
            }
            formatTag = readU16LE(fmt.data() + 0);
            numChannels = readU16LE(fmt.data() + 2);
            sampleRate = readU32LE(fmt.data() + 4);
            blockAlign = readU16LE(fmt.data() + 12);
            bitsPerSample = readU16LE(fmt.data() + 14);

            // Handle WAVE_FORMAT_EXTENSIBLE (0xFFFE)
            if (formatTag == 0xFFFEu && chunkSize >= 40) {
                formatTag = readU16LE(fmt.data() + 24);
            }
            haveFmt = true;
        } else if (std::memcmp(chunkHeader, "data", 4) == 0) {
            rawData.resize(chunkSize);
            if (chunkSize > 0) {
                file.read(reinterpret_cast<char*>(rawData.data()), chunkSize);
                if (!file) {
                    errorOut = "Unexpected EOF reading data chunk";
                    return false;
                }
            }
            haveData = true;
        } else {
            file.seekg(static_cast<std::streamoff>(chunkSize), std::ios::cur);
        }

        if (chunkSize & 1u) {
            file.seekg(1, std::ios::cur);
        }
    }

    if (!haveFmt || !haveData) {
        errorOut = "Missing fmt or data chunk in WAV";
        return false;
    }
    if (numChannels == 0 || sampleRate == 0 || blockAlign == 0) {
        errorOut = "Invalid WAV channel/rate metadata";
        return false;
    }

    const bool isPcm = (formatTag == 1u) && (bitsPerSample == 16 || bitsPerSample == 24 || bitsPerSample == 32);
    const bool isFloat = (formatTag == 3u) && (bitsPerSample == 32);
    if (!isPcm && !isFloat) {
        errorOut = "Unsupported WAV format (expected PCM 16/24/32 or IEEE float 32)";
        return false;
    }

    const size_t totalFrames = rawData.size() / blockAlign;
    out.sampleRate = static_cast<int>(sampleRate);
    out.numChannels = static_cast<int>(numChannels);
    out.bitsPerSample = static_cast<int>(bitsPerSample);
    out.samples.resize(totalFrames);

    for (size_t i = 0; i < totalFrames; ++i) {
        const uint8_t* framePtr = rawData.data() + i * blockAlign;
        float val = 0.0f;
        if (isFloat) {
            uint32_t bits = readU32LE(framePtr);
            std::memcpy(&val, &bits, sizeof(float));
        } else if (bitsPerSample == 16) {
            const int16_t s = static_cast<int16_t>(readU16LE(framePtr));
            val = static_cast<float>(s) / 32768.0f;
        } else if (bitsPerSample == 24) {
            int32_t s = static_cast<int32_t>(framePtr[0]) |
                        (static_cast<int32_t>(framePtr[1]) << 8) |
                        (static_cast<int32_t>(framePtr[2]) << 16);
            if (s & 0x00800000) {
                s |= 0xFF000000;
            }
            val = static_cast<float>(s) / 8388608.0f;
        } else if (bitsPerSample == 32) {
            const int32_t s = static_cast<int32_t>(readU32LE(framePtr));
            val = static_cast<float>(static_cast<double>(s) / 2147483648.0);
        }
        out.samples[i] = val;
    }

    return true;
}

bool writeWavFloat32(const std::filesystem::path& path,
                     std::span<const float> samples,
                     int sampleRate,
                     int numChannels,
                     std::string& errorOut) {
    errorOut.clear();
    if (sampleRate <= 0 || numChannels <= 0) {
        errorOut = "Invalid sampleRate or numChannels for WAV output";
        return false;
    }

    std::ofstream out(path, std::ios::binary);
    if (!out) {
        errorOut = "Cannot open output WAV for writing: " + path.string();
        return false;
    }

    const uint32_t dataBytes = static_cast<uint32_t>(samples.size() * sizeof(float));
    const uint32_t riffSize = 36u + dataBytes;
    const uint16_t blockAlign = static_cast<uint16_t>(numChannels * 4);
    const uint32_t byteRate = static_cast<uint32_t>(sampleRate) * blockAlign;

    out.write("RIFF", 4);
    writeU32LE(out, riffSize);
    out.write("WAVE", 4);

    out.write("fmt ", 4);
    writeU32LE(out, 16u);
    writeU16LE(out, 3u); // IEEE float
    writeU16LE(out, static_cast<uint16_t>(numChannels));
    writeU32LE(out, static_cast<uint32_t>(sampleRate));
    writeU32LE(out, byteRate);
    writeU16LE(out, blockAlign);
    writeU16LE(out, 32u);

    out.write("data", 4);
    writeU32LE(out, dataBytes);
    if (!samples.empty()) {
        out.write(reinterpret_cast<const char*>(samples.data()), dataBytes);
    }

    if (!out) {
        errorOut = "Failed writing WAV data to: " + path.string();
        return false;
    }
    return true;
}

std::vector<float> resampleWindowedSinc(std::span<const float> input, int srcRate, int dstRate) {
    if (input.empty() || srcRate <= 0 || dstRate <= 0) {
        return {};
    }
    if (srcRate == dstRate) {
        return std::vector<float>(input.begin(), input.end());
    }

    constexpr int kNumTaps = 32;
    constexpr int kHalfTaps = kNumTaps / 2; // 16

    const double ratio = static_cast<double>(dstRate) / static_cast<double>(srcRate);
    const double cutoff = std::min(1.0, ratio);
    const int inLen = static_cast<int>(input.size());
    const int outLen = std::max(1, static_cast<int>(std::ceil(static_cast<double>(inLen) * ratio)));

    std::vector<float> output(static_cast<size_t>(outLen), 0.0f);

    for (int i = 0; i < outLen; ++i) {
        const double srcPos = static_cast<double>(i) / ratio;
        const int baseIdx = static_cast<int>(std::floor(srcPos));
        const double frac = srcPos - static_cast<double>(baseIdx);

        double acc = 0.0;
        double wSum = 0.0;

        for (int k = -kHalfTaps + 1; k <= kHalfTaps; ++k) {
            const double dist = static_cast<double>(k) - frac;
            const double u = (dist + static_cast<double>(kHalfTaps)) / static_cast<double>(kNumTaps);
            if (u < 0.0 || u > 1.0) continue;

            const double win = 0.42 - 0.5 * std::cos(2.0 * kPi * u) + 0.08 * std::cos(4.0 * kPi * u);
            const double x = dist * cutoff;
            const double sinc = (std::abs(x) < 1e-9)
                ? 1.0
                : std::sin(kPi * x) / (kPi * x);
            const double weight = win * sinc * cutoff;

            const int sampleIdx = baseIdx + k;
            const double s = (sampleIdx >= 0 && sampleIdx < inLen)
                ? static_cast<double>(input[static_cast<size_t>(sampleIdx)])
                : 0.0;

            acc += s * weight;
            wSum += weight;
        }

        if (std::abs(wSum) > 1e-8) {
            acc /= wSum;
        }
        output[static_cast<size_t>(i)] = static_cast<float>(acc);
    }

    return output;
}

} // namespace wsamp
