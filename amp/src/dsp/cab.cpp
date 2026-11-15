#include "cab.h"

#include <algorithm>
#include <cmath>

namespace wsamp::dsp {

void CabSim::prepare(double sampleRate, int maxBlock) noexcept {
    sampleRate_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
    for (auto& b : stages_) {
        b.prepare(sampleRate_, maxBlock);
    }
    rebuildStages();
    reset();
}

void CabSim::reset() noexcept {
    for (auto& b : stages_) {
        b.reset();
    }
}

void CabSim::setType(CabType type) noexcept {
    if (type_ == type && numStages_ > 0) return;
    type_ = type;
    rebuildStages();
}

void CabSim::rebuildStages() noexcept {
    constexpr double kButterworthQ = 0.7071067811865475;
    int n = 0;

    switch (type_) {
        case CabType::C412:
            stages_[n++].configure(BiquadType::HighPass, 75.0, 0.8, 0.0);
            stages_[n++].configure(BiquadType::Peak, 110.0, 1.0, 3.0);
            stages_[n++].configure(BiquadType::Peak, 450.0, 1.0, -3.0);
            stages_[n++].configure(BiquadType::Peak, 2400.0, 1.4, 4.0);
            stages_[n++].configure(BiquadType::LowPass, 5200.0, 0.7, 0.0);
            stages_[n++].configure(BiquadType::LowPass, 6000.0, 0.7, 0.0);
            stages_[n++].configure(BiquadType::Peak, 7500.0, 3.0, -8.0);
            break;

        case CabType::O212:
            stages_[n++].configure(BiquadType::HighPass, 70.0, kButterworthQ, 0.0);
            stages_[n++].configure(BiquadType::Peak, 1800.0, 1.2, 3.0);
            stages_[n++].configure(BiquadType::LowPass, 6500.0, kButterworthQ, 0.0);
            stages_[n++].configure(BiquadType::LowPass, 6500.0, kButterworthQ, 0.0);
            stages_[n++].configure(BiquadType::Peak, 3500.0, 2.0, -2.0);
            break;

        case CabType::O112:
            stages_[n++].configure(BiquadType::HighPass, 80.0, kButterworthQ, 0.0);
            stages_[n++].configure(BiquadType::Peak, 200.0, 1.0, 1.5);
            stages_[n++].configure(BiquadType::LowPass, 5800.0, kButterworthQ, 0.0);
            stages_[n++].configure(BiquadType::LowPass, 5800.0, kButterworthQ, 0.0);
            stages_[n++].configure(BiquadType::Peak, 2800.0, 1.0, 2.0);
            break;

        case CabType::Acoustic:
            stages_[n++].configure(BiquadType::HighPass, 90.0, kButterworthQ, 0.0);
            stages_[n++].configure(BiquadType::Peak, 100.0, 1.5, 5.0);
            stages_[n++].configure(BiquadType::Peak, 220.0, 1.2, 3.0);
            stages_[n++].configure(BiquadType::Peak, 900.0, 1.0, -3.0);
            stages_[n++].configure(BiquadType::HighShelf, 6000.0, kButterworthQ, 4.0);
            stages_[n++].configure(BiquadType::LowPass, 14000.0, kButterworthQ, 0.0);
            break;

        case CabType::Bass:
            stages_[n++].configure(BiquadType::HighPass, 35.0, kButterworthQ, 0.0);
            stages_[n++].configure(BiquadType::Peak, 80.0, 1.0, 3.0);
            stages_[n++].configure(BiquadType::Peak, 600.0, 1.0, -2.0);
            stages_[n++].configure(BiquadType::LowPass, 4500.0, kButterworthQ, 0.0);
            stages_[n++].configure(BiquadType::LowPass, 4500.0, kButterworthQ, 0.0);
            break;
    }

    numStages_ = n;
}

void CabSim::process(float* io, int numSamples) noexcept {
    for (int s = 0; s < numStages_; ++s) {
        stages_[s].processBlock(io, numSamples);
    }
}

void IrConvolver::prepare(double /*sampleRate*/, int /*maxBlock*/) noexcept {
    reset();
}

void IrConvolver::reset() noexcept {
    history_.fill(0.0f);
    writePos_ = kMaxTaps - 1;
}

void IrConvolver::loadIr(std::span<const float> taps, bool applyFadeAndNormalize) noexcept {
    if (taps.empty()) {
        clearIr();
        return;
    }

    const int cur = activeSlot_.load(std::memory_order_acquire);
    const int next = (cur == 0) ? 1 : 0;
    IrSlot& dst = slots_[next];

    const int len = static_cast<int>(std::min<size_t>(taps.size(), kMaxTaps));
    dst.taps.fill(0.0f);
    for (int i = 0; i < len; ++i) {
        dst.taps[i] = taps[static_cast<size_t>(i)];
    }
    dst.length = len;

    if (applyFadeAndNormalize) {
        if (len > kFadeTaps) {
            const int fadeStart = len - kFadeTaps;
            for (int k = 0; k < kFadeTaps; ++k) {
                const double w = 0.5 * (1.0 + std::cos(kPi * static_cast<double>(k + 1) / static_cast<double>(kFadeTaps)));
                dst.taps[fadeStart + k] *= static_cast<float>(w);
            }
        }

        double energy = 0.0;
        for (int i = 0; i < len; ++i) {
            const double v = static_cast<double>(dst.taps[i]);
            energy += v * v;
        }
        if (energy > 1e-18) {
            const float invNorm = static_cast<float>(1.0 / std::sqrt(energy));
            for (int i = 0; i < len; ++i) {
                dst.taps[i] *= invNorm;
            }
        }
    }

    writeSlot_ = next;
    activeSlot_.store(next, std::memory_order_release);
}

void IrConvolver::clearIr() noexcept {
    activeSlot_.store(-1, std::memory_order_release);
}

void IrConvolver::process(float* io, int numSamples) noexcept {
    const int idx = activeSlot_.load(std::memory_order_acquire);
    if (idx < 0) return;

    const IrSlot& slot = slots_[idx];
    const int numTaps = slot.length;
    if (numTaps <= 0) return;

    const float* __restrict h = slot.taps.data();

    for (int n = 0; n < numSamples; ++n) {
        const float x = io[n];
        writePos_ = (writePos_ == 0) ? (kMaxTaps - 1) : (writePos_ - 1);
        history_[writePos_] = x;
        history_[writePos_ + kMaxTaps] = x;

        const float* __restrict hist = history_.data() + writePos_;
        float acc = 0.0f;
        for (int k = 0; k < numTaps; ++k) {
            acc += h[k] * hist[k];
        }
        io[n] = acc;
    }
}

} // namespace wsamp::dsp
