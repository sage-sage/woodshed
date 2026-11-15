#pragma once

#include <array>
#include <cmath>
#include <vector>

#include "biquad.h"

namespace wsamp::dsp {

// 47-tap Kaiser-windowed polyphase halfband 2x up/downsampler.
// Center tap is at index 23 (odd); all 24 even-indexed taps (0, 2, ..., 46) are
// symmetric pairs; all other odd-indexed taps are identically zero.
class Halfband2x {
public:
    static constexpr int kNumTaps = 47;
    static constexpr int kCenter = 23;
    static constexpr int kEvenTaps = 24;
    static constexpr int kHalfEven = 12;

    Halfband2x() noexcept {
        designCoefficients();
        reset();
    }

    void prepare(double /*sampleRate*/, int /*maxBlock*/) noexcept {
        designCoefficients();
        reset();
    }

    void reset() noexcept {
        upHist_.fill(0.0f);
        upWrite_ = kEvenTaps - 1;
        downEvenHist_.fill(0.0f);
        downEvenWrite_ = kEvenTaps - 1;
        downOddHist_.fill(0.0f);
        downOddWrite_ = kEvenTaps - 1;
    }

    // Upsamples `numIn` samples into `2 * numIn` samples in `out2x`.
    void upsample(const float* in, float* out2x, int numIn) noexcept {
        for (int i = 0; i < numIn; ++i) {
            const float x = in[i];
            upWrite_ = (upWrite_ == 0) ? (kEvenTaps - 1) : (upWrite_ - 1);
            upHist_[upWrite_] = x;
            upHist_[upWrite_ + kEvenTaps] = x;

            const float* h = upHist_.data() + upWrite_;
            float evenAcc = 0.0f;
            for (int r = 0; r < kHalfEven; ++r) {
                evenAcc += upCoeffs_[r] * (h[r] + h[kEvenTaps - 1 - r]);
            }
            out2x[2 * i] = evenAcc;
            out2x[2 * i + 1] = h[11];
        }
    }

    // Downsamples `2 * numOut` samples from `in2x` into `numOut` samples in `out`.
    void downsample(const float* in2x, float* out, int numOut) noexcept {
        for (int i = 0; i < numOut; ++i) {
            const float e = in2x[2 * i];
            const float o = in2x[2 * i + 1];

            downEvenWrite_ = (downEvenWrite_ == 0) ? (kEvenTaps - 1) : (downEvenWrite_ - 1);
            downEvenHist_[downEvenWrite_] = e;
            downEvenHist_[downEvenWrite_ + kEvenTaps] = e;

            downOddWrite_ = (downOddWrite_ == 0) ? (kEvenTaps - 1) : (downOddWrite_ - 1);
            downOddHist_[downOddWrite_] = o;
            downOddHist_[downOddWrite_ + kEvenTaps] = o;

            const float* he = downEvenHist_.data() + downEvenWrite_;
            float acc = 0.0f;
            for (int r = 0; r < kHalfEven; ++r) {
                acc += downCoeffs_[r] * (he[r] + he[kEvenTaps - 1 - r]);
            }
            acc += 0.5f * downOddHist_[downOddWrite_ + 12];
            out[i] = acc;
        }
    }

private:
    static double besselI0(double x) noexcept {
        double sum = 1.0;
        double term = 1.0;
        const double halfX2 = 0.25 * x * x;
        for (int k = 1; k < 30; ++k) {
            term *= halfX2 / (static_cast<double>(k) * static_cast<double>(k));
            sum += term;
            if (term < 1e-16 * sum) break;
        }
        return sum;
    }

    void designCoefficients() noexcept {
        constexpr double kBeta = 8.5;
        const double denom = besselI0(kBeta);

        std::array<double, kHalfEven> raw{};
        double halfSum = 0.0;
        for (int r = 0; r < kHalfEven; ++r) {
            const int n = 2 * r;
            const int k = n - kCenter; // odd: -23, -21, ..., -1
            const double rel = static_cast<double>(n - kCenter) / static_cast<double>(kCenter);
            const double arg = std::max(0.0, 1.0 - rel * rel);
            const double win = besselI0(kBeta * std::sqrt(arg)) / denom;
            const double sinc = std::sin(kPi * 0.5 * static_cast<double>(k)) / (kPi * static_cast<double>(k));
            raw[r] = win * sinc;
            halfSum += raw[r];
        }

        // Normalize so that 2 * sum(raw) == 0.5 (exact unity DC gain with h[23] = 0.5).
        const double scale = 0.25 / halfSum;
        for (int r = 0; r < kHalfEven; ++r) {
            const double c = raw[r] * scale;
            downCoeffs_[r] = static_cast<float>(c);
            upCoeffs_[r] = static_cast<float>(2.0 * c);
        }
    }

    std::array<float, kHalfEven> upCoeffs_{};
    std::array<float, kHalfEven> downCoeffs_{};

    std::array<float, kEvenTaps * 2> upHist_{};
    int upWrite_ = kEvenTaps - 1;

    std::array<float, kEvenTaps * 2> downEvenHist_{};
    int downEvenWrite_ = kEvenTaps - 1;

    std::array<float, kEvenTaps * 2> downOddHist_{};
    int downOddWrite_ = kEvenTaps - 1;
};

class Oversampler4x {
public:
    void prepare(double sampleRate, int maxBlock) {
        maxBlock_ = std::max(1, maxBlock);
        stage1_.prepare(sampleRate, maxBlock_);
        stage2_.prepare(sampleRate * 2.0, maxBlock_ * 2);
        buf2x_.assign(static_cast<size_t>(maxBlock_ * 2), 0.0f);
        buf4x_.assign(static_cast<size_t>(maxBlock_ * 4), 0.0f);
    }

    void reset() noexcept {
        stage1_.reset();
        stage2_.reset();
    }

    // Upsamples `numIn` base-rate samples into internal 4x buffer of size `4 * numIn`.
    float* upsample(const float* in, int numIn) noexcept {
        stage1_.upsample(in, buf2x_.data(), numIn);
        stage2_.upsample(buf2x_.data(), buf4x_.data(), numIn * 2);
        return buf4x_.data();
    }

    // Downsamples `4 * numOut` samples from internal 4x buffer into `out`.
    void downsample(float* out, int numOut) noexcept {
        stage2_.downsample(buf4x_.data(), buf2x_.data(), numOut * 2);
        stage1_.downsample(buf2x_.data(), out, numOut);
    }

    float* buffer4x() noexcept { return buf4x_.data(); }

    // Round-trip group delay in base-rate samples: 23 (stage 1) + 11.5 (stage 2) = 34.5 -> 35 samples.
    int latencySamples() const noexcept { return 35; }
    float latencySamplesExact() const noexcept { return 34.5f; }

private:
    int maxBlock_ = 64;
    Halfband2x stage1_;
    Halfband2x stage2_;
    std::vector<float> buf2x_;
    std::vector<float> buf4x_;
};

} // namespace wsamp::dsp
