#pragma once

#include <algorithm>
#include <cmath>
#include <complex>

namespace wsamp::dsp {

constexpr double kPi = 3.14159265358979323846;

enum class BiquadType {
    LowPass,
    HighPass,
    Peak,
    LowShelf,
    HighShelf
};

class OnePole {
public:
    void prepare(double sampleRate, int /*maxBlock*/ = 0) noexcept {
        sampleRate_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
        recompute();
    }

    void reset() noexcept {
        z_ = 0.0;
    }

    void setCutoffHz(double cutoffHz) noexcept {
        cutoffHz_ = std::clamp(cutoffHz, 0.1, 0.49 * sampleRate_);
        recompute();
    }

    void setTimeConstantSec(double tauSec) noexcept {
        if (tauSec <= 0.0) {
            alpha_ = 1.0;
        } else {
            alpha_ = 1.0 - std::exp(-1.0 / (tauSec * sampleRate_));
        }
    }

    float process(float x) noexcept {
        z_ += alpha_ * (static_cast<double>(x) - z_);
        if (std::abs(z_) < 1e-30) {
            z_ = 0.0;
        }
        return static_cast<float>(z_);
    }

private:
    void recompute() noexcept {
        double fc = std::clamp(cutoffHz_, 0.1, 0.49 * sampleRate_);
        alpha_ = 1.0 - std::exp(-2.0 * kPi * fc / sampleRate_);
    }

    double sampleRate_ = 48000.0;
    double cutoffHz_ = 6000.0;
    double alpha_ = 0.5;
    double z_ = 0.0;
};

class Biquad {
public:
    void prepare(double sampleRate, int /*maxBlock*/ = 0) noexcept {
        sampleRate_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
        updateCoefficients();
    }

    void reset() noexcept {
        z1_ = 0.0;
        z2_ = 0.0;
    }

    void configure(BiquadType type, double freqHz, double q, double gainDb = 0.0) noexcept {
        type_ = type;
        freqHz_ = freqHz;
        q_ = q;
        gainDb_ = gainDb;
        updateCoefficients();
    }

    void setBypass() noexcept {
        b0_ = 1.0;
        b1_ = 0.0;
        b2_ = 0.0;
        a1_ = 0.0;
        a2_ = 0.0;
    }

    float process(float in) noexcept {
        const double x = static_cast<double>(in);
        const double y = b0_ * x + z1_;
        z1_ = b1_ * x - a1_ * y + z2_;
        z2_ = b2_ * x - a2_ * y;
        if (std::abs(z1_) < 1e-30) z1_ = 0.0;
        if (std::abs(z2_) < 1e-30) z2_ = 0.0;
        return static_cast<float>(y);
    }

    void processBlock(float* buffer, int numSamples) noexcept {
        for (int i = 0; i < numSamples; ++i) {
            buffer[i] = process(buffer[i]);
        }
    }

    double magnitudeDbAt(double freqHz) const noexcept {
        const double w = 2.0 * kPi * freqHz / sampleRate_;
        const std::complex<double> ejw = std::polar(1.0, -w);
        const std::complex<double> ej2w = ejw * ejw;
        const std::complex<double> num = b0_ + b1_ * ejw + b2_ * ej2w;
        const std::complex<double> den = 1.0 + a1_ * ejw + a2_ * ej2w;
        const double mag = std::abs(num / den);
        return 20.0 * std::log10(std::max(mag, 1e-20));
    }

private:
    void updateCoefficients() noexcept {
        const double f0 = std::clamp(freqHz_, 1.0, 0.49 * sampleRate_);
        const double q = std::max(q_, 0.01);
        const double w0 = 2.0 * kPi * f0 / sampleRate_;
        const double cosW0 = std::cos(w0);
        const double sinW0 = std::sin(w0);
        const double alpha = sinW0 / (2.0 * q);
        const double A = std::pow(10.0, gainDb_ / 40.0);

        double b0 = 1.0, b1 = 0.0, b2 = 0.0;
        double a0 = 1.0, a1 = 0.0, a2 = 0.0;

        switch (type_) {
            case BiquadType::LowPass: {
                b0 = (1.0 - cosW0) * 0.5;
                b1 = 1.0 - cosW0;
                b2 = (1.0 - cosW0) * 0.5;
                a0 = 1.0 + alpha;
                a1 = -2.0 * cosW0;
                a2 = 1.0 - alpha;
                break;
            }
            case BiquadType::HighPass: {
                b0 = (1.0 + cosW0) * 0.5;
                b1 = -(1.0 + cosW0);
                b2 = (1.0 + cosW0) * 0.5;
                a0 = 1.0 + alpha;
                a1 = -2.0 * cosW0;
                a2 = 1.0 - alpha;
                break;
            }
            case BiquadType::Peak: {
                b0 = 1.0 + alpha * A;
                b1 = -2.0 * cosW0;
                b2 = 1.0 - alpha * A;
                a0 = 1.0 + alpha / A;
                a1 = -2.0 * cosW0;
                a2 = 1.0 - alpha / A;
                break;
            }
            case BiquadType::LowShelf: {
                const double beta = 2.0 * std::sqrt(A) * alpha;
                b0 = A * ((A + 1.0) - (A - 1.0) * cosW0 + beta);
                b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cosW0);
                b2 = A * ((A + 1.0) - (A - 1.0) * cosW0 - beta);
                a0 = (A + 1.0) + (A - 1.0) * cosW0 + beta;
                a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cosW0);
                a2 = (A + 1.0) + (A - 1.0) * cosW0 - beta;
                break;
            }
            case BiquadType::HighShelf: {
                const double beta = 2.0 * std::sqrt(A) * alpha;
                b0 = A * ((A + 1.0) + (A - 1.0) * cosW0 + beta);
                b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cosW0);
                b2 = A * ((A + 1.0) + (A - 1.0) * cosW0 - beta);
                a0 = (A + 1.0) - (A - 1.0) * cosW0 + beta;
                a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cosW0);
                a2 = (A + 1.0) - (A - 1.0) * cosW0 - beta;
                break;
            }
        }

        const double invA0 = 1.0 / a0;
        b0_ = b0 * invA0;
        b1_ = b1 * invA0;
        b2_ = b2 * invA0;
        a1_ = a1 * invA0;
        a2_ = a2 * invA0;
    }

    double sampleRate_ = 48000.0;
    BiquadType type_ = BiquadType::LowPass;
    double freqHz_ = 1000.0;
    double q_ = 0.7071067811865475;
    double gainDb_ = 0.0;

    double b0_ = 1.0;
    double b1_ = 0.0;
    double b2_ = 0.0;
    double a1_ = 0.0;
    double a2_ = 0.0;

    double z1_ = 0.0;
    double z2_ = 0.0;
};

} // namespace wsamp::dsp
