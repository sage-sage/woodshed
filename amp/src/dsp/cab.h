#pragma once

#include <array>
#include <atomic>
#include <span>
#include <vector>

#include "biquad.h"

namespace wsamp::dsp {

enum class CabType {
    C412 = 0,
    O212 = 1,
    O112 = 2,
    Acoustic = 3,
    Bass = 4
};

class CabSim {
public:
    static constexpr int kMaxBiquads = 8;

    void prepare(double sampleRate, int maxBlock = 0) noexcept;
    void reset() noexcept;

    void setType(CabType type) noexcept;
    CabType type() const noexcept { return type_; }

    void process(float* io, int numSamples) noexcept;

private:
    void rebuildStages() noexcept;

    double sampleRate_ = 48000.0;
    CabType type_ = CabType::C412;
    std::array<Biquad, kMaxBiquads> stages_{};
    int numStages_ = 0;
};

class IrConvolver {
public:
    static constexpr int kMaxTaps = 2048;
    static constexpr int kFadeTaps = 64;

    void prepare(double sampleRate, int maxBlock = 0) noexcept;
    void reset() noexcept;

    // Loads an IR (already at device sample rate).
    // When applyFadeAndNormalize is true, truncates to 2048 taps, applies a 64-tap
    // half-Hann fade-out, and normalizes to unit energy.
    // Safe to call off the audio thread; swapped lock-free into process().
    void loadIr(std::span<const float> taps, bool applyFadeAndNormalize = true) noexcept;
    void clearIr() noexcept;

    bool hasIr() const noexcept {
        return activeSlot_.load(std::memory_order_acquire) >= 0;
    }

    std::span<const float> activeTaps() const noexcept {
        const int idx = activeSlot_.load(std::memory_order_acquire);
        if (idx < 0) return {};
        return std::span<const float>(slots_[idx].taps.data(), static_cast<size_t>(slots_[idx].length));
    }

    void process(float* io, int numSamples) noexcept;

private:
    struct IrSlot {
        std::array<float, kMaxTaps> taps{};
        int length = 0;
    };

    std::array<IrSlot, 2> slots_{};
    std::atomic<int> activeSlot_{-1};
    int writeSlot_ = 0;

    std::array<float, kMaxTaps * 2> history_{};
    int writePos_ = kMaxTaps - 1;
};

} // namespace wsamp::dsp
