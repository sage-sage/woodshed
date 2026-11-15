#pragma once

#include <array>
#include <cmath>

#include "biquad.h"
#include "oversampler.h"

namespace wsamp::dsp {

enum class AmpCharacter {
    Clean = 0,
    Breakup = 1,
    Crunch = 2,
    HighGain = 3,
    Fuzz = 4
};

struct AmpParams {
    float gain = 3.0f;          // 0..10
    float bass = 5.0f;          // 0..10 (5 = flat)
    float mid = 5.0f;           // 0..10 (5 = flat)
    float treble = 5.0f;        // 0..10 (5 = flat)
    float presence = 5.0f;      // 0..10 (5 = flat)
    float tightHz = 80.0f;      // 20..400 Hz
    AmpCharacter character = AmpCharacter::Clean;
    float sag = 0.25f;          // 0..1
    float levelDb = 0.0f;       // dB
};

class BuiltinAmp {
public:
    static constexpr int kMaxStages = 3;

    void prepare(double sampleRate, int maxBlock);
    void reset() noexcept;

    void setParams(const AmpParams& p) noexcept;
    const AmpParams& params() const noexcept { return params_; }

    void process(float* io, int numSamples) noexcept;

private:
    void updateDerived() noexcept;
    float computeStaticMakeupGain() const noexcept;

    double sampleRate_ = 48000.0;
    int maxBlock_ = 64;
    AmpParams params_{};

    // Pre-drive filters (1x rate)
    Biquad tightHpf_;
    Biquad preMidPeak_;
    bool usePreMidPeak_ = false;

    // 4x oversampling + interstage filters
    Oversampler4x oversampler_;
    int numStages_ = 1;
    float stageGain_ = 1.0f;
    float bias_ = 0.15f;
    float tanhBias_ = 0.148885f;
    bool isFuzz_ = false;

    std::array<OnePole, kMaxStages> interstageLp_{};
    std::array<double, kMaxStages> dcPrevIn_{};
    std::array<double, kMaxStages> dcPrevOut_{};
    double dcR_ = 0.99967;

    // Sag envelope follower (1x post-drive level)
    float sagEnv_ = 0.0f;
    float sagAttackCoeff_ = 0.004f;
    float sagReleaseCoeff_ = 0.00017f;
    float sagGainReduction_ = 1.0f;

    // Post-drive passive tone stack approximation (1x rate)
    Biquad bassShelf_;
    Biquad midPeak_;
    Biquad trebleShelf_;
    Biquad presenceShelf_;

    float makeupGain_ = 1.0f;
    float levelGain_ = 1.0f;
};

} // namespace wsamp::dsp
