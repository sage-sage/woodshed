#pragma once
// High-gain metal / crunch distortion ("Branding Iron" on the pedalboard).
//
//   in -> tight high-pass (40..250 Hz, 12 dB/oct) -> pre-clip voicing (mid push, fizz low-pass)
//      -> pre-gain (+10..+55 dB, smoothed per sample)
//      -> [4x oversampled] asymmetric soft clip -> interstage high-pass + low-pass -> stage-2 gain
//                          -> hard-knee clip -> anti-fizz low-pass
//      -> DC blocker -> tone stack: Low shelf / Mid peak (~700 Hz, scoopable) / High shelf -> cab-less top cut
//      -> Level -> built-in noise gate (keyed from the clean input, hysteresis + hold)
//
// Real-time rules: prepare() allocates; reset(), setParams() and process() never allocate, never lock, and
// flush denormals in every recursive state.

#include <vector>

#include "biquad.h"
#include "oversampler.h"

namespace wsamp::dsp {

struct MetalParams {
    float gain = 7.0f;       // 0..10  -> pre-gain +10..+55 dB
    float tightHz = 110.0f;  // 40..250 input high-pass corner
    float lowDb = 2.0f;      // -12..12 low shelf @ 120 Hz
    float midDb = -4.0f;     // -15..12 mid peak @ 700 Hz (negative = scooped)
    float highDb = 2.0f;     // -12..12 high shelf @ 3.2 kHz
    float levelDb = -12.0f;  // -36..6 output level
    float gateDb = -62.0f;   // -80 (off) .. -30 gate threshold on the clean input
};

class MetalDistortion {
public:
    void prepare(double sampleRate, int maxBlock);
    void reset() noexcept;
    // Call once per chunk (from the audio thread) with the smoothed parameter values.
    void setParams(const MetalParams& p) noexcept;
    void process(float* io, int n) noexcept;

    static float preGainDb(float gainKnob) noexcept { return 10.0f + 4.5f * gainKnob; }

private:
    struct OnePoleLP {   // per-sample one-pole low-pass with denormal flushing (used at 4x rate)
        float a = 1.0f, z = 0.0f;
        void set(double fc, double fs) noexcept;
        float lp(float x) noexcept;
        float hp(float x) noexcept { return x - lp(x); }
    };

    double fs_ = 48000.0;
    int maxBlock_ = 0;
    bool configured_ = false;
    MetalParams p_{};

    // base rate, before the clippers
    Biquad tight_;
    Biquad tight2_;
    Biquad push_;      // mid push into the clipper (keeps the low end from farting out)
    Biquad preLp_;     // pre-clip fizz control
    // oversampled clipper section
    Oversampler4x os_;
    OnePoleLP stageHp_;    // interstage tightening (4x rate)
    OnePoleLP stageLp_;    // interstage smoothing (4x rate)
    OnePoleLP postClipLp_; // anti-fizz after the second clipper (4x rate)
    // base rate, after the clippers
    OnePoleLP dcBlock_;
    Biquad low_;
    Biquad mid_;
    Biquad high_;
    Biquad topCut_;
    // gains, ramped per sample from the previous chunk's value
    float preGain_ = 1.0f, preGainTarget_ = 1.0f;
    float stage2Gain_ = 1.0f, stage2Target_ = 1.0f;
    float level_ = 1.0f, levelTarget_ = 1.0f;
    // gate
    float gateEnv_ = 0.0f;
    float gateGain_ = 1.0f;
    float gateRelease_ = 0.0f, gateAttack_ = 0.0f, envRelease_ = 0.0f;
    int gateHold_ = 0, gateHoldLeft_ = 0;
    bool gateOpen_ = true;
    std::vector<float> key_;   // clean, tightened input that keys the gate
};

} // namespace wsamp::dsp
