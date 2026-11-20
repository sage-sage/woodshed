#include "metal.h"

#include <algorithm>
#include <cmath>

namespace wsamp::dsp {

namespace {

constexpr float kDenorm = 1e-20f;

inline float flush(float v) noexcept {
    return (std::abs(v) < kDenorm) ? 0.0f : v;
}

inline float dbToLin(float db) noexcept {
    return std::pow(10.0f, db / 20.0f);
}

// Stage 1: asymmetric soft clip (biased tanh, DC removed), like a single-ended triode stage.
constexpr float kBias = 0.3f;
const float kBiasTanh = std::tanh(kBias);
inline float softAsym(float x) noexcept {
    return std::tanh(x + kBias) - kBiasTanh;
}

// Stage 2: "hard-ish" clip: a cubic knee that reaches +-1 at |x| = 1 with zero slope, flat beyond.
inline float hardKnee(float x) noexcept {
    if (x >= 1.0f) return 1.0f;
    if (x <= -1.0f) return -1.0f;
    return 1.5f * x - 0.5f * x * x * x;
}

} // namespace

void MetalDistortion::OnePoleLP::set(double fc, double fs) noexcept {
    const double c = std::clamp(fc, 1.0, 0.49 * fs);
    a = static_cast<float>(1.0 - std::exp(-2.0 * kPi * c / fs));
}

float MetalDistortion::OnePoleLP::lp(float x) noexcept {
    z += a * (x - z);
    z = flush(z);
    return z;
}

void MetalDistortion::prepare(double sampleRate, int maxBlock) {
    fs_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
    maxBlock_ = std::max(1, maxBlock);
    for (Biquad* b : {&tight_, &tight2_, &push_, &preLp_, &low_, &mid_, &high_, &topCut_}) b->prepare(fs_, maxBlock_);
    os_.prepare(fs_, maxBlock_);
    key_.assign(static_cast<size_t>(maxBlock_), 0.0f);

    const double fs4 = fs_ * 4.0;
    stageHp_.set(80.0, fs4);
    stageLp_.set(5500.0, fs4);
    postClipLp_.set(9000.0, fs4);
    dcBlock_.set(15.0, fs_);
    push_.configure(BiquadType::Peak, 900.0, 0.7, 5.0);
    preLp_.configure(BiquadType::LowPass, 6500.0, 0.7071067811865475);
    topCut_.configure(BiquadType::LowPass, 7500.0, 0.7071067811865475);

    gateAttack_ = static_cast<float>(1.0 - std::exp(-1.0 / (0.001 * fs_)));
    gateRelease_ = static_cast<float>(1.0 - std::exp(-1.0 / (0.060 * fs_)));
    envRelease_ = static_cast<float>(std::exp(-1.0 / (0.020 * fs_)));
    gateHold_ = static_cast<int>(0.040 * fs_);
    configured_ = false;
    setParams(p_);
    reset();
}

void MetalDistortion::reset() noexcept {
    for (Biquad* b : {&tight_, &tight2_, &push_, &preLp_, &low_, &mid_, &high_, &topCut_}) b->reset();
    os_.reset();
    stageHp_.z = stageLp_.z = postClipLp_.z = dcBlock_.z = 0.0f;
    preGain_ = preGainTarget_;
    stage2Gain_ = stage2Target_;
    level_ = levelTarget_;
    gateEnv_ = 0.0f;
    gateGain_ = (p_.gateDb <= -79.5f) ? 1.0f : 0.0f;
    gateOpen_ = p_.gateDb <= -79.5f;
    gateHoldLeft_ = 0;
}

void MetalDistortion::setParams(const MetalParams& p) noexcept {
    const bool first = !configured_;
    if (first || p.tightHz != p_.tightHz) {
        // Two cascaded 2nd-order high-passes (24 dB/oct): the "Tight" knob really tightens.
        tight_.configure(BiquadType::HighPass, p.tightHz, 0.7071067811865475);
        tight2_.configure(BiquadType::HighPass, p.tightHz * 0.6, 0.6);
    }
    if (first || p.lowDb != p_.lowDb) low_.configure(BiquadType::LowShelf, 120.0, 0.7071067811865475, p.lowDb);
    if (first || p.midDb != p_.midDb) mid_.configure(BiquadType::Peak, 700.0, 0.8, p.midDb);
    if (first || p.highDb != p_.highDb) high_.configure(BiquadType::HighShelf, 3200.0, 0.7071067811865475, p.highDb);
    const float g = std::clamp(p.gain, 0.0f, 10.0f);
    preGainTarget_ = dbToLin(preGainDb(g));
    stage2Target_ = 1.5f + 0.35f * g;
    levelTarget_ = dbToLin(p.levelDb);
    p_ = p;
    if (first) {
        preGain_ = preGainTarget_;
        stage2Gain_ = stage2Target_;
        level_ = levelTarget_;
        configured_ = true;
    }
}

void MetalDistortion::process(float* io, int n) noexcept {
    if (io == nullptr || n <= 0 || maxBlock_ <= 0) return;
    if (n > maxBlock_) {   // never expected, but stay inside the prepared buffers
        for (int off = 0; off < n; off += maxBlock_) process(io + off, std::min(maxBlock_, n - off));
        return;
    }

    // 1) tighten + voice at the base rate; keep a copy of the clean, tightened signal to key the gate
    for (int i = 0; i < n; ++i) {
        float x = tight2_.process(tight_.process(io[i]));
        key_[static_cast<size_t>(i)] = x;
        x = preLp_.process(push_.process(x));
        io[i] = x;
    }

    // 2) pre-gain, ramped across the chunk
    {
        const float step = (preGainTarget_ - preGain_) / static_cast<float>(n);
        for (int i = 0; i < n; ++i) {
            preGain_ += step;
            io[i] *= preGain_;
        }
        preGain_ = preGainTarget_;
    }

    // 3) the clippers, 4x oversampled
    {
        float* up = os_.upsample(io, n);
        const int n4 = n * 4;
        const float step = (stage2Target_ - stage2Gain_) / static_cast<float>(n4);
        for (int i = 0; i < n4; ++i) {
            float x = softAsym(up[i]);
            x = stageLp_.lp(stageHp_.hp(x));
            stage2Gain_ += step;
            x = hardKnee(x * stage2Gain_);
            up[i] = postClipLp_.lp(x);
        }
        stage2Gain_ = stage2Target_;
        os_.downsample(io, n);
    }

    // 4) tone stack, level, gate
    const bool gateOn = p_.gateDb > -79.5f;
    const float thrOpen = dbToLin(p_.gateDb);
    const float thrClose = thrOpen * 0.5f;   // 6 dB hysteresis
    const float levelStep = (levelTarget_ - level_) / static_cast<float>(n);
    for (int i = 0; i < n; ++i) {
        float x = io[i];
        x = dcBlock_.hp(x);
        x = topCut_.process(high_.process(mid_.process(low_.process(x))));
        level_ += levelStep;
        x *= level_;
        // Output safety: a soft ceiling at +12 dBFS so extreme shelf boosts can't slam the next block.
        // Transparent at normal levels (1.0 -> 0.98).
        x = 4.0f * std::tanh(0.25f * x);

        if (gateOn) {
            const float k = std::abs(key_[static_cast<size_t>(i)]);
            gateEnv_ = std::max(k, gateEnv_ * envRelease_);
            gateEnv_ = flush(gateEnv_);
            if (gateEnv_ > thrOpen) {
                gateOpen_ = true;
                gateHoldLeft_ = gateHold_;
            } else if (gateEnv_ < thrClose) {
                if (gateHoldLeft_ > 0) --gateHoldLeft_;
                else gateOpen_ = false;
            }
            const float target = gateOpen_ ? 1.0f : 0.0f;
            gateGain_ += (gateOpen_ ? gateAttack_ : gateRelease_) * (target - gateGain_);
            gateGain_ = flush(gateGain_);
            x *= gateGain_;
        } else {
            gateGain_ = 1.0f;
        }
        io[i] = flush(x);
    }
    level_ = levelTarget_;
}

} // namespace wsamp::dsp
