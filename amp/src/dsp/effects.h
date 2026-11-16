#pragma once

#include <array>
#include <cmath>
#include <vector>

#include "biquad.h"

namespace wsamp::dsp {

class NoiseGate {
public:
    void prepare(double sampleRate, int maxBlock = 0) noexcept;
    void reset() noexcept;

    void setThresholdDb(float thresholdDb) noexcept;
    float thresholdDb() const noexcept { return thresholdDb_; }

    void process(float* io, int numSamples) noexcept;

private:
    double sampleRate_ = 48000.0;
    float thresholdDb_ = -70.0f;
    bool bypassed_ = false;

    float openThreshLin_ = 0.000316f;
    float closeThreshLin_ = 0.000158f;

    float detAttackCoeff_ = 0.1f;
    float detReleaseCoeff_ = 0.002f;
    float attackCoeff_ = 0.02f;
    float releaseCoeff_ = 0.00026f;
    int holdSamples_ = 1920;

    float env_ = 0.0f;
    float gain_ = 0.0f;
    int holdCounter_ = 0;
    bool isOpen_ = false;
};

class Chorus {
public:
    void prepare(double sampleRate, int maxBlock = 0);
    void reset() noexcept;

    void setMix(float mix) noexcept;
    float mix() const noexcept { return mix_; }

    void process(float* io, int numSamples) noexcept;

private:
    double sampleRate_ = 48000.0;
    float mix_ = 0.0f;
    double lfoPhase_ = 0.0;
    double lfoInc_ = 0.0;

    std::vector<float> buffer_;
    int mask_ = 0;
    int writePos_ = 0;
};

class MonoDelay {
public:
    void prepare(double sampleRate, int maxBlock = 0);
    void reset() noexcept;

    void setParams(float timeMs, float feedback, float mix) noexcept;
    void setFeedbackToneHz(float cutoffHz) noexcept;

    void process(float* io, int numSamples) noexcept;

private:
    double sampleRate_ = 48000.0;
    float timeMs_ = 0.0f;
    float feedback_ = 0.0f;
    float mix_ = 0.0f;
    double feedbackToneHz_ = 4000.0;

    OnePole feedbackLp_;
    std::vector<float> buffer_;
    int mask_ = 0;
    int writePos_ = 0;
    float maxDelaySamples_ = 72000.0f;
};

class Freeverb {
public:
    static constexpr int kNumCombs = 8;
    static constexpr int kNumAllpasses = 4;

    void prepare(double sampleRate, int maxBlock = 0);
    void reset() noexcept;

    void setParams(float size, float mix, float damp = 0.4f) noexcept;

    void process(float* io, int numSamples) noexcept;

private:
    struct Comb {
        std::vector<float> buffer;
        int index = 0;
        float filterStore = 0.0f;
    };

    struct Allpass {
        std::vector<float> buffer;
        int index = 0;
    };

    double sampleRate_ = 48000.0;
    float roomSize_ = 0.84f;
    float damp1_ = 0.16f;
    float damp2_ = 0.84f;
    float mix_ = 0.0f;

    std::array<Comb, kNumCombs> combs_{};
    std::array<Allpass, kNumAllpasses> allpasses_{};
};

class OutputStage {
public:
    void prepare(double sampleRate, int maxBlock = 0) noexcept;
    void reset() noexcept;

    void setLevelDb(float levelDb) noexcept;

    void process(float* io, int numSamples) noexcept;

private:
    float levelDb_ = 0.0f;
    float levelGain_ = 1.0f;
};

} // namespace wsamp::dsp
