#include "effects.h"

#include <algorithm>
#include <cmath>

namespace wsamp::dsp {

namespace {

int nextPowerOfTwo(int v) noexcept {
    int p = 1;
    while (p < v) {
        p <<= 1;
    }
    return p;
}

} // namespace

// ============================================================================
// NoiseGate
// ============================================================================

void NoiseGate::prepare(double sampleRate, int /*maxBlock*/) noexcept {
    sampleRate_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
    const float fs = static_cast<float>(sampleRate_);

    detAttackCoeff_ = 1.0f - std::exp(-1.0f / (0.00025f * fs));
    detReleaseCoeff_ = 1.0f - std::exp(-1.0f / (0.015f * fs));
    attackCoeff_ = 1.0f - std::exp(-1.0f / (0.001f * fs));
    releaseCoeff_ = 1.0f - std::exp(-1.0f / (0.080f * fs));
    holdSamples_ = static_cast<int>(std::round(0.040 * sampleRate_));

    setThresholdDb(thresholdDb_);
    reset();
}

void NoiseGate::reset() noexcept {
    env_ = 0.0f;
    gain_ = bypassed_ ? 1.0f : 0.0f;
    holdCounter_ = 0;
    isOpen_ = bypassed_;
}

void NoiseGate::setThresholdDb(float thresholdDb) noexcept {
    thresholdDb_ = std::clamp(thresholdDb, -80.0f, 0.0f);
    bypassed_ = (thresholdDb_ <= -79.9f);
    openThreshLin_ = std::pow(10.0f, thresholdDb_ / 20.0f);
    closeThreshLin_ = std::pow(10.0f, (thresholdDb_ - 6.0f) / 20.0f);
    if (bypassed_) {
        isOpen_ = true;
        gain_ = 1.0f;
    }
}

void NoiseGate::process(float* io, int numSamples) noexcept {
    if (bypassed_) return;

    for (int i = 0; i < numSamples; ++i) {
        const float x = io[i];
        const float a = std::abs(x);

        const float detCoeff = (a > env_) ? detAttackCoeff_ : detReleaseCoeff_;
        env_ += detCoeff * (a - env_);

        if (env_ >= openThreshLin_) {
            isOpen_ = true;
            holdCounter_ = holdSamples_;
        } else if (isOpen_) {
            if (env_ >= closeThreshLin_) {
                holdCounter_ = holdSamples_;
            } else if (holdCounter_ > 0) {
                --holdCounter_;
            } else {
                isOpen_ = false;
            }
        }

        const float target = isOpen_ ? 1.0f : 0.0f;
        const float coeff = isOpen_ ? attackCoeff_ : releaseCoeff_;
        gain_ += coeff * (target - gain_);
        if (!isOpen_ && gain_ < 1e-6f) {
            gain_ = 0.0f;
        }

        io[i] = x * gain_;
    }
}

// ============================================================================
// Chorus
// ============================================================================

void Chorus::prepare(double sampleRate, int /*maxBlock*/) {
    sampleRate_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
    lfoInc_ = 0.8 / sampleRate_;
    const int minSize = static_cast<int>(std::ceil(0.020 * sampleRate_)) + 16;
    const int size = nextPowerOfTwo(std::max(64, minSize));
    buffer_.assign(static_cast<size_t>(size), 0.0f);
    mask_ = size - 1;
    reset();
}

void Chorus::reset() noexcept {
    std::fill(buffer_.begin(), buffer_.end(), 0.0f);
    lfoPhase_ = 0.0;
    writePos_ = 0;
}

void Chorus::setMix(float mix) noexcept {
    mix_ = std::clamp(mix, 0.0f, 1.0f);
}

void Chorus::process(float* io, int numSamples) noexcept {
    if (buffer_.empty()) return;

    const float baseDelaySamples = 0.007f * static_cast<float>(sampleRate_);
    const float depthSamples = 0.003f * static_cast<float>(sampleRate_);
    const float twoPi = static_cast<float>(2.0 * kPi);

    for (int i = 0; i < numSamples; ++i) {
        const float x = io[i];
        buffer_[writePos_] = x;

        const float lfo = std::sin(twoPi * static_cast<float>(lfoPhase_));
        lfoPhase_ += lfoInc_;
        if (lfoPhase_ >= 1.0) lfoPhase_ -= 1.0;

        if (mix_ > 1e-5f) {
            const float delaySamples = baseDelaySamples + depthSamples * lfo;
            const float readPos = static_cast<float>(writePos_) - delaySamples;
            const int idx0 = static_cast<int>(std::floor(readPos));
            const float frac = readPos - static_cast<float>(idx0);

            const float s0 = buffer_[idx0 & mask_];
            const float s1 = buffer_[(idx0 + 1) & mask_];
            const float wet = s0 + frac * (s1 - s0);
            io[i] = x * (1.0f - mix_) + wet * mix_;
        }

        writePos_ = (writePos_ + 1) & mask_;
    }
}

// ============================================================================
// MonoDelay
// ============================================================================

void MonoDelay::prepare(double sampleRate, int maxBlock) {
    sampleRate_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
    maxDelaySamples_ = static_cast<float>(sampleRate_);
    const int minSize = static_cast<int>(std::ceil(1.05 * sampleRate_)) + 16;
    const int size = nextPowerOfTwo(std::max(128, minSize));
    buffer_.assign(static_cast<size_t>(size), 0.0f);
    mask_ = size - 1;

    feedbackLp_.prepare(sampleRate_, maxBlock);
    feedbackLp_.setCutoffHz(4000.0);
    reset();
}

void MonoDelay::reset() noexcept {
    std::fill(buffer_.begin(), buffer_.end(), 0.0f);
    feedbackLp_.reset();
    writePos_ = 0;
}

void MonoDelay::setParams(float timeMs, float feedback, float mix) noexcept {
    timeMs_ = std::clamp(timeMs, 0.0f, 1000.0f);
    feedback_ = std::clamp(feedback, 0.0f, 0.85f);
    mix_ = std::clamp(mix, 0.0f, 1.0f);
}

void MonoDelay::process(float* io, int numSamples) noexcept {
    if (buffer_.empty()) return;
    if (mix_ <= 1e-5f && feedback_ <= 1e-5f) return;

    const float delaySamples = std::clamp(
        timeMs_ * 0.001f * static_cast<float>(sampleRate_),
        1.0f,
        maxDelaySamples_
    );

    for (int i = 0; i < numSamples; ++i) {
        const float x = io[i];
        const float readPos = static_cast<float>(writePos_) - delaySamples;
        const int idx0 = static_cast<int>(std::floor(readPos));
        const float frac = readPos - static_cast<float>(idx0);

        const float s0 = buffer_[idx0 & mask_];
        const float s1 = buffer_[(idx0 + 1) & mask_];
        const float wet = s0 + frac * (s1 - s0);

        const float fb = feedbackLp_.process(wet * feedback_);
        buffer_[writePos_] = x + fb;
        writePos_ = (writePos_ + 1) & mask_;

        io[i] = x * (1.0f - mix_) + wet * mix_;
    }
}

// ============================================================================
// Freeverb
// ============================================================================

void Freeverb::prepare(double sampleRate, int /*maxBlock*/) {
    sampleRate_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
    const double scale = sampleRate_ / 44100.0;

    constexpr std::array<int, kNumCombs> kCombTunings = {
        1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617
    };
    constexpr std::array<int, kNumAllpasses> kAllpassTunings = {
        556, 441, 341, 225
    };

    for (int i = 0; i < kNumCombs; ++i) {
        const int len = std::max(1, static_cast<int>(std::round(kCombTunings[i] * scale)));
        combs_[i].buffer.assign(static_cast<size_t>(len), 0.0f);
    }
    for (int i = 0; i < kNumAllpasses; ++i) {
        const int len = std::max(1, static_cast<int>(std::round(kAllpassTunings[i] * scale)));
        allpasses_[i].buffer.assign(static_cast<size_t>(len), 0.0f);
    }

    reset();
}

void Freeverb::reset() noexcept {
    for (auto& c : combs_) {
        std::fill(c.buffer.begin(), c.buffer.end(), 0.0f);
        c.index = 0;
        c.filterStore = 0.0f;
    }
    for (auto& a : allpasses_) {
        std::fill(a.buffer.begin(), a.buffer.end(), 0.0f);
        a.index = 0;
    }
}

void Freeverb::setParams(float size, float mix, float damp) noexcept {
    const float s = std::clamp(size, 0.0f, 1.0f);
    roomSize_ = 0.7f + s * 0.28f;
    const float d = std::clamp(damp, 0.0f, 1.0f);
    damp1_ = d * 0.4f;
    damp2_ = 1.0f - damp1_;
    mix_ = std::clamp(mix, 0.0f, 1.0f);
}

void Freeverb::process(float* io, int numSamples) noexcept {
    if (mix_ <= 1e-5f) return;

    constexpr float kFixedGain = 0.015f;
    constexpr float kAllpassFeedback = 0.5f;

    for (int n = 0; n < numSamples; ++n) {
        const float x = io[n];
        const float in = x * kFixedGain;
        float out = 0.0f;

        for (int i = 0; i < kNumCombs; ++i) {
            Comb& c = combs_[i];
            const float bufOut = c.buffer[c.index];
            c.filterStore = bufOut * damp2_ + c.filterStore * damp1_;
            if (std::abs(c.filterStore) < 1e-25f) c.filterStore = 0.0f;

            c.buffer[c.index] = in + c.filterStore * roomSize_;
            c.index++;
            if (c.index >= static_cast<int>(c.buffer.size())) c.index = 0;

            out += bufOut;
        }

        for (int i = 0; i < kNumAllpasses; ++i) {
            Allpass& a = allpasses_[i];
            const float bufOut = a.buffer[a.index];
            a.buffer[a.index] = out + bufOut * kAllpassFeedback;
            a.index++;
            if (a.index >= static_cast<int>(a.buffer.size())) a.index = 0;

            out = bufOut - out;
        }

        io[n] = x * (1.0f - mix_) + out * mix_;
    }
}

// ============================================================================
// OutputStage
// ============================================================================

void OutputStage::prepare(double /*sampleRate*/, int /*maxBlock*/) noexcept {
    reset();
}

void OutputStage::reset() noexcept {
}

void OutputStage::setLevelDb(float levelDb) noexcept {
    levelDb_ = std::clamp(levelDb, -60.0f, 24.0f);
    levelGain_ = std::pow(10.0f, levelDb_ / 20.0f);
}

void OutputStage::process(float* io, int numSamples) noexcept {
    // Soft limiter with C1 knee at -1 dBFS and asymptotic ceiling at 0 dBFS (1.0).
    constexpr float kKnee = 0.891250938f;     // 10^(-1 / 20)
    constexpr float kHeadroom = 1.0f - kKnee; // 0.108749062
    constexpr float kInvHeadroom = 1.0f / kHeadroom;

    for (int i = 0; i < numSamples; ++i) {
        const float x = io[i] * levelGain_;
        const float ax = std::abs(x);
        if (ax <= kKnee) {
            io[i] = x;
        } else {
            const float sign = (x >= 0.0f) ? 1.0f : -1.0f;
            const float excess = ax - kKnee;
            io[i] = sign * (kKnee + kHeadroom * std::tanh(excess * kInvHeadroom));
        }
    }
}

} // namespace wsamp::dsp
