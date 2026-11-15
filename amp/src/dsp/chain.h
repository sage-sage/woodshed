#pragma once

#include <atomic>
#include <filesystem>
#include <string>
#include <vector>

#include "biquad.h"
#include "builtin_amp.h"
#include "cab.h"
#include "effects.h"
#include "nam_slot.h"

namespace wsamp::dsp {

struct ChainParams {
    float inputTrimDb = 0.0f;
    float gateThresholdDb = -70.0f;

    AmpParams amp{};

    CabType cabType = CabType::C412;
    bool namIncludesCab = false;

    float postLowDb = 0.0f;
    float postMidDb = 0.0f;
    float postHighDb = 0.0f;

    float chorusMix = 0.0f;
    float delayTimeMs = 0.0f;
    float delayFeedback = 0.0f;
    float delayMix = 0.0f;
    float reverbSize = 0.5f;
    float reverbMix = 0.0f;

    float outputLevelDb = 0.0f;
};

class Chain {
public:
    Chain();
    ~Chain() = default;

    void prepare(double sampleRate, int maxBlock);
    void reset() noexcept;

    void setParams(const ChainParams& params) noexcept;
    void snapParameters() noexcept;

    // Individual atomic target setters for real-time control
    void setInputTrimDb(float v) noexcept { targetInputTrimDb_.store(v, std::memory_order_relaxed); }
    void setGateThresholdDb(float v) noexcept { targetGateThresholdDb_.store(v, std::memory_order_relaxed); }
    void setAmpGain(float v) noexcept { targetAmpGain_.store(v, std::memory_order_relaxed); }
    void setAmpBass(float v) noexcept { targetAmpBass_.store(v, std::memory_order_relaxed); }
    void setAmpMid(float v) noexcept { targetAmpMid_.store(v, std::memory_order_relaxed); }
    void setAmpTreble(float v) noexcept { targetAmpTreble_.store(v, std::memory_order_relaxed); }
    void setAmpPresence(float v) noexcept { targetAmpPresence_.store(v, std::memory_order_relaxed); }
    void setAmpTightHz(float v) noexcept { targetAmpTightHz_.store(v, std::memory_order_relaxed); }
    void setAmpCharacter(AmpCharacter c) noexcept { targetAmpCharacter_.store(static_cast<int>(c), std::memory_order_relaxed); }
    void setAmpSag(float v) noexcept { targetAmpSag_.store(v, std::memory_order_relaxed); }
    void setAmpLevelDb(float v) noexcept { targetAmpLevelDb_.store(v, std::memory_order_relaxed); }
    void setCabType(CabType c) noexcept { targetCabType_.store(static_cast<int>(c), std::memory_order_relaxed); }
    void setNamIncludesCab(bool v) noexcept { targetNamIncludesCab_.store(v, std::memory_order_relaxed); }
    void setPostLowDb(float v) noexcept { targetPostLowDb_.store(v, std::memory_order_relaxed); }
    void setPostMidDb(float v) noexcept { targetPostMidDb_.store(v, std::memory_order_relaxed); }
    void setPostHighDb(float v) noexcept { targetPostHighDb_.store(v, std::memory_order_relaxed); }
    void setChorusMix(float v) noexcept { targetChorusMix_.store(v, std::memory_order_relaxed); }
    void setDelayTimeMs(float v) noexcept { targetDelayTimeMs_.store(v, std::memory_order_relaxed); }
    void setDelayFeedback(float v) noexcept { targetDelayFeedback_.store(v, std::memory_order_relaxed); }
    void setDelayMix(float v) noexcept { targetDelayMix_.store(v, std::memory_order_relaxed); }
    void setReverbSize(float v) noexcept { targetReverbSize_.store(v, std::memory_order_relaxed); }
    void setReverbMix(float v) noexcept { targetReverbMix_.store(v, std::memory_order_relaxed); }
    void setOutputLevelDb(float v) noexcept { targetOutputLevelDb_.store(v, std::memory_order_relaxed); }

    // NAM & IR management (always called off the audio thread)
    bool loadNamSync(const std::filesystem::path& path, std::string& errorOut);
    void loadNamAsync(const std::filesystem::path& path);
    void clearNam();
    bool hasNamModel() const noexcept { return namSlot_.hasModel(); }
    std::string lastNamError() const { return namSlot_.lastError(); }

    bool loadIrFromWav(const std::filesystem::path& path, std::string& errorOut);
    void setIrTaps(std::span<const float> taps, bool applyFadeAndNormalize = true) noexcept {
        irConvolver_.loadIr(taps, applyFadeAndNormalize);
    }
    void clearIr() noexcept { irConvolver_.clearIr(); }
    bool hasIr() const noexcept { return irConvolver_.hasIr(); }

    // Real-time mono audio processing: allocation-free, lock-free, exception-free.
    void process(float* io, int n) noexcept;

    double sampleRate() const noexcept { return sampleRate_; }
    int maxBlock() const noexcept { return maxBlock_; }

private:
    void smoothAndApplyParams(int blockSamples) noexcept;
    void processChunk(float* io, int n) noexcept;

    double sampleRate_ = 48000.0;
    int maxBlock_ = 64;

    // Atomic targets written by control/UI thread
    std::atomic<float> targetInputTrimDb_{0.0f};
    std::atomic<float> targetGateThresholdDb_{-70.0f};
    std::atomic<float> targetAmpGain_{3.0f};
    std::atomic<float> targetAmpBass_{5.0f};
    std::atomic<float> targetAmpMid_{5.0f};
    std::atomic<float> targetAmpTreble_{5.0f};
    std::atomic<float> targetAmpPresence_{5.0f};
    std::atomic<float> targetAmpTightHz_{80.0f};
    std::atomic<int> targetAmpCharacter_{0};
    std::atomic<float> targetAmpSag_{0.25f};
    std::atomic<float> targetAmpLevelDb_{0.0f};
    std::atomic<int> targetCabType_{0};
    std::atomic<bool> targetNamIncludesCab_{false};
    std::atomic<float> targetPostLowDb_{0.0f};
    std::atomic<float> targetPostMidDb_{0.0f};
    std::atomic<float> targetPostHighDb_{0.0f};
    std::atomic<float> targetChorusMix_{0.0f};
    std::atomic<float> targetDelayTimeMs_{0.0f};
    std::atomic<float> targetDelayFeedback_{0.0f};
    std::atomic<float> targetDelayMix_{0.0f};
    std::atomic<float> targetReverbSize_{0.5f};
    std::atomic<float> targetReverbMix_{0.0f};
    std::atomic<float> targetOutputLevelDb_{0.0f};

    // Smoothed audio-thread state
    ChainParams current_{};
    ChainParams applied_{};
    bool hasAppliedOnce_ = false;

    // DSP modules
    NoiseGate gate_;
    BuiltinAmp builtinAmp_;
    NamSlot namSlot_;
    CabSim cabSim_;
    IrConvolver irConvolver_;

    Biquad postLowShelf_;
    Biquad postMidPeak_;
    Biquad postHighShelf_;
    bool postEqActive_ = false;

    Chorus chorus_;
    MonoDelay delay_;
    Freeverb reverb_;
    OutputStage outputStage_;

    // Pre-allocated NAM scratch buffers (sized in prepare)
    std::vector<NAM_SAMPLE> namInBuf_;
    std::vector<NAM_SAMPLE> namOutBuf_;
};

} // namespace wsamp::dsp
