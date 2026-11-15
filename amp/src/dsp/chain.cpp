#include "chain.h"

#include <algorithm>
#include <cmath>

#include "wav.h"

namespace wsamp::dsp {

namespace {

inline bool changed(float a, float b) noexcept {
    return std::abs(a - b) > 1e-4f;
}

} // namespace

Chain::Chain() {
    setParams(ChainParams{});
    snapParameters();
}

void Chain::prepare(double sampleRate, int maxBlock) {
    sampleRate_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
    maxBlock_ = std::max(1, maxBlock);

    gate_.prepare(sampleRate_, maxBlock_);
    builtinAmp_.prepare(sampleRate_, maxBlock_);
    namSlot_.prepare(sampleRate_, maxBlock_);
    cabSim_.prepare(sampleRate_, maxBlock_);
    irConvolver_.prepare(sampleRate_, maxBlock_);

    postLowShelf_.prepare(sampleRate_, maxBlock_);
    postMidPeak_.prepare(sampleRate_, maxBlock_);
    postHighShelf_.prepare(sampleRate_, maxBlock_);

    chorus_.prepare(sampleRate_, maxBlock_);
    delay_.prepare(sampleRate_, maxBlock_);
    reverb_.prepare(sampleRate_, maxBlock_);
    outputStage_.prepare(sampleRate_, maxBlock_);

    namInBuf_.assign(static_cast<size_t>(maxBlock_), 0.0f);
    namOutBuf_.assign(static_cast<size_t>(maxBlock_), 0.0f);

    hasAppliedOnce_ = false;
    snapParameters();
    reset();
}

void Chain::reset() noexcept {
    gate_.reset();
    builtinAmp_.reset();
    namSlot_.reset();
    cabSim_.reset();
    irConvolver_.reset();
    postLowShelf_.reset();
    postMidPeak_.reset();
    postHighShelf_.reset();
    chorus_.reset();
    delay_.reset();
    reverb_.reset();
    outputStage_.reset();
}

void Chain::setParams(const ChainParams& params) noexcept {
    targetInputTrimDb_.store(params.inputTrimDb, std::memory_order_relaxed);
    targetGateThresholdDb_.store(params.gateThresholdDb, std::memory_order_relaxed);

    targetAmpGain_.store(params.amp.gain, std::memory_order_relaxed);
    targetAmpBass_.store(params.amp.bass, std::memory_order_relaxed);
    targetAmpMid_.store(params.amp.mid, std::memory_order_relaxed);
    targetAmpTreble_.store(params.amp.treble, std::memory_order_relaxed);
    targetAmpPresence_.store(params.amp.presence, std::memory_order_relaxed);
    targetAmpTightHz_.store(params.amp.tightHz, std::memory_order_relaxed);
    targetAmpCharacter_.store(static_cast<int>(params.amp.character), std::memory_order_relaxed);
    targetAmpSag_.store(params.amp.sag, std::memory_order_relaxed);
    targetAmpLevelDb_.store(params.amp.levelDb, std::memory_order_relaxed);

    targetCabType_.store(static_cast<int>(params.cabType), std::memory_order_relaxed);
    targetNamIncludesCab_.store(params.namIncludesCab, std::memory_order_relaxed);

    targetPostLowDb_.store(params.postLowDb, std::memory_order_relaxed);
    targetPostMidDb_.store(params.postMidDb, std::memory_order_relaxed);
    targetPostHighDb_.store(params.postHighDb, std::memory_order_relaxed);

    targetChorusMix_.store(params.chorusMix, std::memory_order_relaxed);
    targetDelayTimeMs_.store(params.delayTimeMs, std::memory_order_relaxed);
    targetDelayFeedback_.store(params.delayFeedback, std::memory_order_relaxed);
    targetDelayMix_.store(params.delayMix, std::memory_order_relaxed);
    targetReverbSize_.store(params.reverbSize, std::memory_order_relaxed);
    targetReverbMix_.store(params.reverbMix, std::memory_order_relaxed);

    targetOutputLevelDb_.store(params.outputLevelDb, std::memory_order_relaxed);
}

void Chain::snapParameters() noexcept {
    current_.inputTrimDb = targetInputTrimDb_.load(std::memory_order_relaxed);
    current_.gateThresholdDb = targetGateThresholdDb_.load(std::memory_order_relaxed);
    current_.amp.gain = targetAmpGain_.load(std::memory_order_relaxed);
    current_.amp.bass = targetAmpBass_.load(std::memory_order_relaxed);
    current_.amp.mid = targetAmpMid_.load(std::memory_order_relaxed);
    current_.amp.treble = targetAmpTreble_.load(std::memory_order_relaxed);
    current_.amp.presence = targetAmpPresence_.load(std::memory_order_relaxed);
    current_.amp.tightHz = targetAmpTightHz_.load(std::memory_order_relaxed);
    current_.amp.character = static_cast<AmpCharacter>(targetAmpCharacter_.load(std::memory_order_relaxed));
    current_.amp.sag = targetAmpSag_.load(std::memory_order_relaxed);
    current_.amp.levelDb = targetAmpLevelDb_.load(std::memory_order_relaxed);
    current_.cabType = static_cast<CabType>(targetCabType_.load(std::memory_order_relaxed));
    current_.namIncludesCab = targetNamIncludesCab_.load(std::memory_order_relaxed);
    current_.postLowDb = targetPostLowDb_.load(std::memory_order_relaxed);
    current_.postMidDb = targetPostMidDb_.load(std::memory_order_relaxed);
    current_.postHighDb = targetPostHighDb_.load(std::memory_order_relaxed);
    current_.chorusMix = targetChorusMix_.load(std::memory_order_relaxed);
    current_.delayTimeMs = targetDelayTimeMs_.load(std::memory_order_relaxed);
    current_.delayFeedback = targetDelayFeedback_.load(std::memory_order_relaxed);
    current_.delayMix = targetDelayMix_.load(std::memory_order_relaxed);
    current_.reverbSize = targetReverbSize_.load(std::memory_order_relaxed);
    current_.reverbMix = targetReverbMix_.load(std::memory_order_relaxed);
    current_.outputLevelDb = targetOutputLevelDb_.load(std::memory_order_relaxed);

    hasAppliedOnce_ = false;
    smoothAndApplyParams(0);
}

void Chain::smoothAndApplyParams(int blockSamples) noexcept {
    const float alpha = (blockSamples <= 0)
        ? 1.0f
        : (1.0f - std::exp(-static_cast<float>(blockSamples) / (0.020f * static_cast<float>(sampleRate_))));

    auto smooth = [alpha](float& cur, float target) noexcept {
        cur += alpha * (target - cur);
        if (std::abs(target - cur) < 1e-5f) {
            cur = target;
        }
    };

    smooth(current_.inputTrimDb, targetInputTrimDb_.load(std::memory_order_relaxed));
    smooth(current_.gateThresholdDb, targetGateThresholdDb_.load(std::memory_order_relaxed));
    smooth(current_.amp.gain, targetAmpGain_.load(std::memory_order_relaxed));
    smooth(current_.amp.bass, targetAmpBass_.load(std::memory_order_relaxed));
    smooth(current_.amp.mid, targetAmpMid_.load(std::memory_order_relaxed));
    smooth(current_.amp.treble, targetAmpTreble_.load(std::memory_order_relaxed));
    smooth(current_.amp.presence, targetAmpPresence_.load(std::memory_order_relaxed));
    smooth(current_.amp.tightHz, targetAmpTightHz_.load(std::memory_order_relaxed));
    smooth(current_.amp.sag, targetAmpSag_.load(std::memory_order_relaxed));
    smooth(current_.amp.levelDb, targetAmpLevelDb_.load(std::memory_order_relaxed));

    current_.amp.character = static_cast<AmpCharacter>(targetAmpCharacter_.load(std::memory_order_relaxed));
    current_.cabType = static_cast<CabType>(targetCabType_.load(std::memory_order_relaxed));
    current_.namIncludesCab = targetNamIncludesCab_.load(std::memory_order_relaxed);

    smooth(current_.postLowDb, targetPostLowDb_.load(std::memory_order_relaxed));
    smooth(current_.postMidDb, targetPostMidDb_.load(std::memory_order_relaxed));
    smooth(current_.postHighDb, targetPostHighDb_.load(std::memory_order_relaxed));

    smooth(current_.chorusMix, targetChorusMix_.load(std::memory_order_relaxed));
    smooth(current_.delayTimeMs, targetDelayTimeMs_.load(std::memory_order_relaxed));
    smooth(current_.delayFeedback, targetDelayFeedback_.load(std::memory_order_relaxed));
    smooth(current_.delayMix, targetDelayMix_.load(std::memory_order_relaxed));
    smooth(current_.reverbSize, targetReverbSize_.load(std::memory_order_relaxed));
    smooth(current_.reverbMix, targetReverbMix_.load(std::memory_order_relaxed));
    smooth(current_.outputLevelDb, targetOutputLevelDb_.load(std::memory_order_relaxed));

    if (!hasAppliedOnce_ || changed(current_.gateThresholdDb, applied_.gateThresholdDb)) {
        gate_.setThresholdDb(current_.gateThresholdDb);
    }

    const bool ampChanged = !hasAppliedOnce_
        || current_.amp.character != applied_.amp.character
        || changed(current_.amp.gain, applied_.amp.gain)
        || changed(current_.amp.bass, applied_.amp.bass)
        || changed(current_.amp.mid, applied_.amp.mid)
        || changed(current_.amp.treble, applied_.amp.treble)
        || changed(current_.amp.presence, applied_.amp.presence)
        || changed(current_.amp.tightHz, applied_.amp.tightHz)
        || changed(current_.amp.sag, applied_.amp.sag)
        || changed(current_.amp.levelDb, applied_.amp.levelDb);

    if (ampChanged) {
        builtinAmp_.setParams(current_.amp);
    }

    if (!hasAppliedOnce_ || current_.cabType != applied_.cabType) {
        cabSim_.setType(current_.cabType);
    }

    const bool postChanged = !hasAppliedOnce_
        || changed(current_.postLowDb, applied_.postLowDb)
        || changed(current_.postMidDb, applied_.postMidDb)
        || changed(current_.postHighDb, applied_.postHighDb);

    if (postChanged) {
        postEqActive_ = (std::abs(current_.postLowDb) > 1e-3f)
            || (std::abs(current_.postMidDb) > 1e-3f)
            || (std::abs(current_.postHighDb) > 1e-3f);
        if (postEqActive_) {
            postLowShelf_.configure(BiquadType::LowShelf, 100.0, 0.7071067811865475, current_.postLowDb);
            postMidPeak_.configure(BiquadType::Peak, 1000.0, 1.0, current_.postMidDb);
            postHighShelf_.configure(BiquadType::HighShelf, 4000.0, 0.7071067811865475, current_.postHighDb);
        }
    }

    if (!hasAppliedOnce_ || changed(current_.chorusMix, applied_.chorusMix)) {
        chorus_.setMix(current_.chorusMix);
    }

    if (!hasAppliedOnce_
        || changed(current_.delayTimeMs, applied_.delayTimeMs)
        || changed(current_.delayFeedback, applied_.delayFeedback)
        || changed(current_.delayMix, applied_.delayMix)) {
        delay_.setParams(current_.delayTimeMs, current_.delayFeedback, current_.delayMix);
    }

    if (!hasAppliedOnce_
        || changed(current_.reverbSize, applied_.reverbSize)
        || changed(current_.reverbMix, applied_.reverbMix)) {
        reverb_.setParams(current_.reverbSize, current_.reverbMix, 0.4f);
    }

    if (!hasAppliedOnce_ || changed(current_.outputLevelDb, applied_.outputLevelDb)) {
        outputStage_.setLevelDb(current_.outputLevelDb);
    }

    applied_ = current_;
    hasAppliedOnce_ = true;
}

bool Chain::loadNamSync(const std::filesystem::path& path, std::string& errorOut) {
    return namSlot_.loadSync(path, errorOut);
}

void Chain::loadNamAsync(const std::filesystem::path& path) {
    namSlot_.loadAsync(path);
}

void Chain::clearNam() {
    namSlot_.clear();
}

bool Chain::loadIrFromWav(const std::filesystem::path& path, std::string& errorOut) {
    WavData wav;
    if (!readWavMono(path, wav, errorOut)) {
        return false;
    }
    std::vector<float> resampled = resampleWindowedSinc(wav.samples, wav.sampleRate, static_cast<int>(std::round(sampleRate_)));
    irConvolver_.loadIr(resampled, true);
    return true;
}

void Chain::process(float* io, int n) noexcept {
    if (io == nullptr || n <= 0) return;

    int offset = 0;
    while (offset < n) {
        const int chunk = std::min(n - offset, maxBlock_);
        processChunk(io + offset, chunk);
        offset += chunk;
    }
}

void Chain::processChunk(float* io, int n) noexcept {
    smoothAndApplyParams(n);

    // 1. Input trim (dB)
    if (std::abs(current_.inputTrimDb) > 1e-4f) {
        const float trimGain = std::pow(10.0f, current_.inputTrimDb / 20.0f);
        for (int i = 0; i < n; ++i) {
            io[i] *= trimGain;
        }
    }

    // 2. Noise gate (keyed on INPUT)
    gate_.process(io, n);

    // 3. AMP (NAM model if loaded, otherwise BuiltinAmp)
    bool ranNam = false;
    if (namSlot_.hasModel() && static_cast<int>(namInBuf_.size()) >= n) {
        for (int i = 0; i < n; ++i) {
            namInBuf_[i] = static_cast<NAM_SAMPLE>(io[i]);
        }
        NAM_SAMPLE* inPtrs[1] = { namInBuf_.data() };
        NAM_SAMPLE* outPtrs[1] = { namOutBuf_.data() };
        float namMakeup = 1.0f;
        if (namSlot_.processAudio(inPtrs, outPtrs, n, namMakeup)) {
            for (int i = 0; i < n; ++i) {
                io[i] = static_cast<float>(namOutBuf_[i]) * namMakeup;
            }
            ranNam = true;
        }
    }
    if (!ranNam) {
        builtinAmp_.process(io, n);
    }

    // 4. CAB (skipped when NAM model is a full rig capture)
    if (!(ranNam && current_.namIncludesCab)) {
        if (irConvolver_.hasIr()) {
            irConvolver_.process(io, n);
        } else {
            cabSim_.process(io, n);
        }
    }

    // 5. Post EQ
    if (postEqActive_) {
        postLowShelf_.processBlock(io, n);
        postMidPeak_.processBlock(io, n);
        postHighShelf_.processBlock(io, n);
    }

    // 6. Chorus -> Delay -> Reverb
    chorus_.process(io, n);
    delay_.process(io, n);
    reverb_.process(io, n);

    // 7. Output level + soft limiter
    outputStage_.process(io, n);
}

} // namespace wsamp::dsp
