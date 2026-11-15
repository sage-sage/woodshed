#include "builtin_amp.h"

#include <algorithm>
#include <cmath>

namespace wsamp::dsp {

namespace {

inline float dbToLinear(float db) noexcept {
    return std::pow(10.0f, db / 20.0f);
}

} // namespace

void BuiltinAmp::prepare(double sampleRate, int maxBlock) {
    sampleRate_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
    maxBlock_ = std::max(1, maxBlock);

    tightHpf_.prepare(sampleRate_, maxBlock_);
    preMidPeak_.prepare(sampleRate_, maxBlock_);
    oversampler_.prepare(sampleRate_, maxBlock_);

    const double rate4x = sampleRate_ * 4.0;
    for (int i = 0; i < kMaxStages; ++i) {
        interstageLp_[i].prepare(rate4x, maxBlock_ * 4);
        interstageLp_[i].setCutoffHz(6000.0);
    }
    dcR_ = std::exp(-2.0 * kPi * 10.0 / rate4x);

    sagAttackCoeff_ = 1.0f - std::exp(-1.0f / (0.005f * static_cast<float>(sampleRate_)));
    sagReleaseCoeff_ = 1.0f - std::exp(-1.0f / (0.120f * static_cast<float>(sampleRate_)));

    bassShelf_.prepare(sampleRate_, maxBlock_);
    midPeak_.prepare(sampleRate_, maxBlock_);
    trebleShelf_.prepare(sampleRate_, maxBlock_);
    presenceShelf_.prepare(sampleRate_, maxBlock_);

    updateDerived();
    reset();
}

void BuiltinAmp::reset() noexcept {
    tightHpf_.reset();
    preMidPeak_.reset();
    oversampler_.reset();
    for (int i = 0; i < kMaxStages; ++i) {
        interstageLp_[i].reset();
        dcPrevIn_[i] = 0.0;
        dcPrevOut_[i] = 0.0;
    }
    sagEnv_ = 0.0f;
    sagGainReduction_ = 1.0f;
    bassShelf_.reset();
    midPeak_.reset();
    trebleShelf_.reset();
    presenceShelf_.reset();
}

void BuiltinAmp::setParams(const AmpParams& p) noexcept {
    params_ = p;
    params_.gain = std::clamp(params_.gain, 0.0f, 10.0f);
    params_.bass = std::clamp(params_.bass, 0.0f, 10.0f);
    params_.mid = std::clamp(params_.mid, 0.0f, 10.0f);
    params_.treble = std::clamp(params_.treble, 0.0f, 10.0f);
    params_.presence = std::clamp(params_.presence, 0.0f, 10.0f);
    params_.tightHz = std::clamp(params_.tightHz, 20.0f, 400.0f);
    params_.sag = std::clamp(params_.sag, 0.0f, 1.0f);
    updateDerived();
}

void BuiltinAmp::updateDerived() noexcept {
    tightHpf_.configure(BiquadType::HighPass, params_.tightHz, 0.7071067811865475, 0.0);

    usePreMidPeak_ = (params_.character == AmpCharacter::Crunch ||
                      params_.character == AmpCharacter::HighGain);
    if (usePreMidPeak_) {
        preMidPeak_.configure(BiquadType::Peak, 700.0, 0.7071067811865475, 3.0);
    }

    float minDb = 0.0f;
    float maxDb = 18.0f;
    bias_ = 0.15f;
    isFuzz_ = false;

    switch (params_.character) {
        case AmpCharacter::Clean:
            numStages_ = 1;
            minDb = 0.0f;
            maxDb = 18.0f;
            bias_ = 0.05f;
            break;
        case AmpCharacter::Breakup:
            numStages_ = 1;
            minDb = 6.0f;
            maxDb = 28.0f;
            bias_ = 0.15f;
            break;
        case AmpCharacter::Crunch:
            numStages_ = 2;
            minDb = 12.0f;
            maxDb = 36.0f;
            bias_ = 0.15f;
            break;
        case AmpCharacter::HighGain:
            numStages_ = 3;
            minDb = 20.0f;
            maxDb = 52.0f;
            bias_ = 0.15f;
            break;
        case AmpCharacter::Fuzz:
            numStages_ = 2;
            minDb = 24.0f;
            maxDb = 48.0f;
            bias_ = 0.35f;
            isFuzz_ = true;
            break;
    }

    tanhBias_ = std::tanh(bias_);
    const float t = params_.gain * 0.1f;
    const float totalDb = minDb + t * (maxDb - minDb);
    const float stageDb = totalDb / static_cast<float>(numStages_);
    stageGain_ = dbToLinear(stageDb);

    bassShelf_.configure(BiquadType::LowShelf, 120.0, 0.7071067811865475, (params_.bass - 5.0f) * 2.0f);
    midPeak_.configure(BiquadType::Peak, 650.0, 0.7, (params_.mid - 5.0f) * 2.0f);
    trebleShelf_.configure(BiquadType::HighShelf, 3200.0, 0.7071067811865475, (params_.treble - 5.0f) * 2.0f);
    presenceShelf_.configure(BiquadType::HighShelf, 5000.0, 0.7071067811865475, (params_.presence - 5.0f) * 1.2f);

    makeupGain_ = computeStaticMakeupGain();
    levelGain_ = dbToLinear(params_.levelDb);
}

float BuiltinAmp::computeStaticMakeupGain() const noexcept {
    // Predict RMS at 110 Hz for a -18 dBFS RMS test tone (0.12589254 RMS)
    // without touching audio state or running an AGC.
    constexpr float kTargetRms = 0.12589254f;
    constexpr float kTestFreq = 110.0f;

    const float ratio = kTestFreq / params_.tightHz;
    const float r2 = ratio * ratio;
    const float hpfGain = r2 / std::sqrt(1.0f + r2 * r2);
    const float preBoost = usePreMidPeak_ ? 1.04f : 1.0f;

    float rms = kTargetRms * hpfGain * preBoost;
    const float sech = 1.0f / std::cosh(bias_);
    const float sech2 = sech * sech;

    for (int s = 0; s < numStages_; ++s) {
        const float drivenRms = rms * stageGain_ * sech2;
        rms = drivenRms / std::sqrt(1.0f + drivenRms * drivenRms);
        if (isFuzz_) {
            rms *= 1.05f;
        }
    }

    // Approximate low-shelf contribution at 110 Hz (near the 120 Hz corner).
    const float bassDb = (params_.bass - 5.0f) * 2.0f;
    const float bassFactor = std::pow(10.0f, (bassDb * 0.5f) / 20.0f);
    rms *= bassFactor;

    return kTargetRms / std::max(rms, 1e-4f);
}

void BuiltinAmp::process(float* io, int numSamples) noexcept {
    if (numSamples <= 0) return;

    // 1. Pre-EQ at 1x rate
    tightHpf_.processBlock(io, numSamples);
    if (usePreMidPeak_) {
        preMidPeak_.processBlock(io, numSamples);
    }

    // 2. Drive stages at 4x oversampling
    float* buf4x = oversampler_.upsample(io, numSamples);
    const int n4 = numSamples * 4;
    const float effectiveStageGain = stageGain_ * sagGainReduction_;

    for (int s = 0; s < numStages_; ++s) {
        OnePole& lp = interstageLp_[s];
        double prevIn = dcPrevIn_[s];
        double prevOut = dcPrevOut_[s];
        const double r = dcR_;

        for (int i = 0; i < n4; ++i) {
            float x = buf4x[i] * effectiveStageGain;
            float y = std::tanh(x + bias_) - tanhBias_;
            if (isFuzz_) {
                const float u = std::clamp(y, -1.0f, 1.0f);
                y = 1.5f * u - 0.5f * u * u * u;
            }
            y = lp.process(y);

            const double xd = static_cast<double>(y);
            const double yd = xd - prevIn + r * prevOut;
            prevIn = xd;
            prevOut = yd;
            buf4x[i] = static_cast<float>(yd);
        }

        dcPrevIn_[s] = prevIn;
        dcPrevOut_[s] = prevOut;
    }

    oversampler_.downsample(io, numSamples);

    // 3. Sag envelope follower on post-drive 1x signal (reduces next block's drive gain)
    for (int i = 0; i < numSamples; ++i) {
        const float a = std::abs(io[i]);
        const float coeff = (a > sagEnv_) ? sagAttackCoeff_ : sagReleaseCoeff_;
        sagEnv_ += coeff * (a - sagEnv_);
    }
    const float sagDb = std::clamp(sagEnv_, 0.0f, 1.0f) * params_.sag * 4.0f;
    sagGainReduction_ = dbToLinear(-sagDb);

    // 4. Passive tone stack approximation at 1x rate
    bassShelf_.processBlock(io, numSamples);
    midPeak_.processBlock(io, numSamples);
    trebleShelf_.processBlock(io, numSamples);
    presenceShelf_.processBlock(io, numSamples);

    // 5. Static make-up normalization + amp output level
    const float totalOutGain = makeupGain_ * levelGain_;
    for (int i = 0; i < numSamples; ++i) {
        io[i] *= totalOutGain;
    }
}

} // namespace wsamp::dsp
