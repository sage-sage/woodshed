#include "board.h"

#include <algorithm>
#include <cmath>
#include <queue>
#include <unordered_map>
#include <unordered_set>
#include <utility>

#include "Effects/autowah.h"
#include "Effects/chorus.h"
#include "Effects/flanger.h"
#include "Effects/overdrive.h"
#include "Effects/phaser.h"
#include "Effects/reverbsc.h"
#include "Effects/tremolo.h"

#include "biquad.h"
#include "builtin_amp.h"
#include "cab.h"
#include "effects.h"
#include "metal.h"
#include "nam_slot.h"
#include "wav.h"

namespace wsamp::dsp {

const std::vector<BlockTypeSpec>& blockCatalog() {
    static const std::vector<BlockTypeSpec> kCatalog = {
        {
            BlockType::Amp,
            "amp",
            "Amp",
            "amp",
            1,
            false,
            nullptr,
            {
                {"character", "Character", 0.0f, 4.0f, 0.0f, 1.0f, "", {"Clean", "Breakup", "Crunch", "High gain", "Fuzz"}},
                {"gain", "Gain", 0.0f, 10.0f, 3.0f, 0.1f, "", {}},
                {"bass", "Bass", 0.0f, 10.0f, 5.0f, 0.1f, "", {}},
                {"mid", "Mid", 0.0f, 10.0f, 5.0f, 0.1f, "", {}},
                {"treble", "Treble", 0.0f, 10.0f, 5.0f, 0.1f, "", {}},
                {"presence", "Presence", 0.0f, 10.0f, 5.0f, 0.1f, "", {}},
                {"tight", "Tight", 20.0f, 400.0f, 80.0f, 1.0f, "Hz", {}},
                {"level", "Level", -24.0f, 12.0f, 0.0f, 0.5f, "dB", {}},
            },
        },
        {
            BlockType::Nam,
            "nam",
            "NAM capture",
            "amp",
            1,
            true,
            "nam",
            {
                {"level", "Level", -24.0f, 12.0f, 0.0f, 0.5f, "dB", {}},
            },
        },
        {
            BlockType::Cab,
            "cab",
            "Cabinet",
            "cab",
            1,
            false,
            nullptr,
            {
                {"model", "Model", 0.0f, 4.0f, 0.0f, 1.0f, "", {"4x12 closed", "2x12 open", "1x12 open", "Acoustic", "Bass"}},
                {"level", "Level", -24.0f, 12.0f, 0.0f, 0.5f, "dB", {}},
            },
        },
        {
            BlockType::Ir,
            "ir",
            "Cabinet IR",
            "cab",
            1,
            true,
            "ir",
            {
                {"level", "Level", -24.0f, 12.0f, 0.0f, 0.5f, "dB", {}},
            },
        },
        {
            BlockType::Eq,
            "eq",
            "EQ",
            "eq",
            1,
            false,
            nullptr,
            {
                {"low", "Low", -15.0f, 15.0f, 0.0f, 0.5f, "dB", {}},
                {"mid", "Mid", -15.0f, 15.0f, 0.0f, 0.5f, "dB", {}},
                {"high", "High", -15.0f, 15.0f, 0.0f, 0.5f, "dB", {}},
            },
        },
        {
            BlockType::Overdrive,
            "overdrive",
            "Overdrive",
            "drive",
            1,
            false,
            nullptr,
            {
                {"drive", "Drive", 0.0f, 1.0f, 0.4f, 0.01f, "", {}},
                {"level", "Level", -24.0f, 12.0f, -6.0f, 0.5f, "dB", {}},
            },
        },
        {
            BlockType::Metal,
            "metal",
            "Metal distortion",
            "drive",
            1,
            false,
            nullptr,
            {
                {"gain", "Gain", 0.0f, 10.0f, 7.0f, 0.1f, "", {}},
                {"tight", "Tight", 40.0f, 250.0f, 110.0f, 1.0f, "Hz", {}},
                {"low", "Low", -12.0f, 12.0f, 2.0f, 0.5f, "dB", {}},
                {"mid", "Mid", -15.0f, 12.0f, -4.0f, 0.5f, "dB", {}},
                {"high", "High", -12.0f, 12.0f, 2.0f, 0.5f, "dB", {}},
                {"level", "Level", -36.0f, 6.0f, -12.0f, 0.5f, "dB", {}},
                {"gate", "Gate", -80.0f, -30.0f, -62.0f, 1.0f, "dB", {}},
            },
        },
        {
            BlockType::Chorus,
            "chorus",
            "Chorus",
            "modulation",
            1,
            false,
            nullptr,
            {
                {"rate", "Rate", 0.05f, 5.0f, 0.6f, 0.01f, "Hz", {}},
                {"depth", "Depth", 0.0f, 1.0f, 0.5f, 0.01f, "", {}},
                {"delay", "Delay", 2.0f, 20.0f, 8.0f, 0.1f, "ms", {}},
                {"feedback", "Feedback", 0.0f, 0.9f, 0.2f, 0.01f, "", {}},
                {"mix", "Mix", 0.0f, 1.0f, 0.5f, 0.01f, "", {}},
            },
        },
        {
            BlockType::Flanger,
            "flanger",
            "Flanger",
            "modulation",
            1,
            false,
            nullptr,
            {
                {"rate", "Rate", 0.05f, 5.0f, 0.3f, 0.01f, "Hz", {}},
                {"depth", "Depth", 0.0f, 1.0f, 0.5f, 0.01f, "", {}},
                {"delay", "Delay", 0.1f, 7.0f, 1.0f, 0.1f, "ms", {}},
                {"feedback", "Feedback", 0.0f, 0.95f, 0.6f, 0.01f, "", {}},
                {"mix", "Mix", 0.0f, 1.0f, 0.5f, 0.01f, "", {}},
            },
        },
        {
            BlockType::Phaser,
            "phaser",
            "Phaser",
            "modulation",
            1,
            false,
            nullptr,
            {
                {"rate", "Rate", 0.05f, 5.0f, 0.4f, 0.01f, "Hz", {}},
                {"depth", "Depth", 0.0f, 1.0f, 0.8f, 0.01f, "", {}},
                {"freq", "Center", 200.0f, 3000.0f, 700.0f, 10.0f, "Hz", {}},
                {"feedback", "Feedback", 0.0f, 0.9f, 0.3f, 0.01f, "", {}},
                {"stages", "Stages", 0.0f, 3.0f, 1.0f, 1.0f, "", {"2", "4", "6", "8"}},
                {"mix", "Mix", 0.0f, 1.0f, 0.5f, 0.01f, "", {}},
            },
        },
        {
            BlockType::Tremolo,
            "tremolo",
            "Tremolo",
            "modulation",
            1,
            false,
            nullptr,
            {
                {"rate", "Rate", 0.5f, 15.0f, 5.0f, 0.1f, "Hz", {}},
                {"depth", "Depth", 0.0f, 1.0f, 0.6f, 0.01f, "", {}},
                {"wave", "Wave", 0.0f, 2.0f, 0.0f, 1.0f, "", {"Sine", "Triangle", "Square"}},
            },
        },
        {
            BlockType::Autowah,
            "autowah",
            "Auto-wah",
            "modulation",
            1,
            false,
            nullptr,
            {
                {"wah", "Wah", 0.0f, 1.0f, 0.5f, 0.01f, "", {}},
                {"level", "Level", 0.0f, 1.0f, 0.6f, 0.01f, "", {}},
                {"mix", "Mix", 0.0f, 1.0f, 1.0f, 0.01f, "", {}},
            },
        },
        {
            BlockType::Delay,
            "delay",
            "Delay",
            "time",
            1,
            false,
            nullptr,
            {
                {"time", "Time", 20.0f, 1500.0f, 380.0f, 1.0f, "ms", {}},
                {"feedback", "Feedback", 0.0f, 0.9f, 0.35f, 0.01f, "", {}},
                {"tone", "Tone", 1000.0f, 12000.0f, 5000.0f, 50.0f, "Hz", {}},
                {"mix", "Mix", 0.0f, 1.0f, 0.3f, 0.01f, "", {}},
            },
        },
        {
            BlockType::Reverb,
            "reverb",
            "Reverb",
            "time",
            1,
            false,
            nullptr,
            {
                {"type", "Type", 0.0f, 1.0f, 0.0f, 1.0f, "", {"Room", "Lush"}},
                {"size", "Size", 0.0f, 1.0f, 0.5f, 0.01f, "", {}},
                {"tone", "Tone", 0.0f, 1.0f, 0.5f, 0.01f, "", {}},
                {"mix", "Mix", 0.0f, 1.0f, 0.25f, 0.01f, "", {}},
            },
        },
        {
            BlockType::Mixer,
            "mixer",
            "Mixer",
            "utility",
            2,
            false,
            nullptr,
            {
                {"balance", "A / B", 0.0f, 1.0f, 0.5f, 0.01f, "", {}},
                {"level", "Level", -24.0f, 12.0f, 0.0f, 0.5f, "dB", {}},
            },
        },
        {
            BlockType::Volume,
            "volume",
            "Volume",
            "utility",
            1,
            false,
            nullptr,
            {
                {"level", "Level", -60.0f, 12.0f, 0.0f, 0.5f, "dB", {}},
            },
        },
    };
    return kCatalog;
}

const BlockTypeSpec* findBlockSpec(BlockType type) {
    for (const auto& s : blockCatalog()) {
        if (s.type == type) return &s;
    }
    return nullptr;
}

const BlockTypeSpec* findBlockSpec(const std::string& id) {
    for (const auto& s : blockCatalog()) {
        if (id == s.id) return &s;
    }
    return nullptr;
}

Block::Block(BlockType type, std::string uid)
    : type_(type), uid_(std::move(uid)), spec_(findBlockSpec(type)) {
    if (!spec_) {
        spec_ = &blockCatalog().front();
    }
    for (size_t i = 0; i < spec_->params.size() && i < targets_.size(); ++i) {
        targets_[i].store(spec_->params[i].def, std::memory_order_relaxed);
    }
}

void Block::setParam(int index, float value) noexcept {
    if (!spec_ || index < 0 || index >= static_cast<int>(spec_->params.size())) return;
    if (!std::isfinite(value)) return;

    const auto& p = spec_->params[static_cast<size_t>(index)];
    if (!p.options.empty()) {
        const int maxIdx = static_cast<int>(p.options.size()) - 1;
        const int idx = std::clamp(static_cast<int>(std::lround(value)), 0, maxIdx);
        targets_[static_cast<size_t>(index)].store(static_cast<float>(idx), std::memory_order_relaxed);
    } else {
        const float clamped = std::clamp(value, p.min, p.max);
        targets_[static_cast<size_t>(index)].store(clamped, std::memory_order_relaxed);
    }
}

float Block::param(int index) const noexcept {
    if (!spec_ || index < 0 || index >= static_cast<int>(spec_->params.size())) return 0.0f;
    return targets_[static_cast<size_t>(index)].load(std::memory_order_relaxed);
}

bool Block::loadFile(const std::filesystem::path&, std::string& errorOut) {
    errorOut = "This block type does not load files";
    return false;
}

void Block::clearFile() {}

void Block::processMulti(const float* const* ins, int numIns, float* out, int n) noexcept {
    if (out == nullptr || n <= 0) return;
    if (ins != nullptr && numIns > 0 && ins[0] != nullptr) {
        if (ins[0] != out) {
            std::copy_n(ins[0], n, out);
        }
    } else {
        std::fill_n(out, n, 0.0f);
    }
    process(out, n);
}

namespace {

inline float dbToGain(float db) noexcept {
    return std::pow(10.0f, db / 20.0f);
}

struct ParamSmoother {
    std::array<float, kMaxBlockParams> cur{};
    bool snapped = false;

    void snap(const std::array<std::atomic<float>, kMaxBlockParams>& targets, size_t count) noexcept {
        for (size_t i = 0; i < count; ++i) {
            cur[i] = targets[i].load(std::memory_order_relaxed);
        }
        snapped = true;
    }

    bool smooth(const std::array<std::atomic<float>, kMaxBlockParams>& targets,
                const std::vector<ParamSpec>& specs,
                double sampleRate,
                int blockSamples,
                bool forceApply) noexcept {
        if (!snapped) {
            snap(targets, specs.size());
            return true;
        }

        const float fs = (sampleRate > 1.0) ? static_cast<float>(sampleRate) : 48000.0f;
        const float alpha = (blockSamples <= 0)
            ? 1.0f
            : (1.0f - std::exp(-static_cast<float>(blockSamples) / (0.020f * fs)));

        bool moved = forceApply;
        for (size_t i = 0; i < specs.size(); ++i) {
            const float target = targets[i].load(std::memory_order_relaxed);
            if (!specs[i].options.empty()) {
                if (cur[i] != target) {
                    cur[i] = target;
                    moved = true;
                }
            } else {
                const float prev = cur[i];
                cur[i] += alpha * (target - cur[i]);
                if (std::abs(target - cur[i]) < 1e-5f) {
                    cur[i] = target;
                }
                if (std::abs(cur[i] - prev) > 1e-6f) {
                    moved = true;
                }
            }
        }
        return moved;
    }
};

class AmpBlock final : public Block {
public:
    explicit AmpBlock(std::string uid) : Block(BlockType::Amp, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        amp_.prepare(sampleRate, maxBlock);
        applied_ = false;
    }

    void reset() noexcept override {
        amp_.reset();
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            AmpParams p;
            const int ch = std::clamp(static_cast<int>(std::lround(smoother_.cur[0])), 0, 4);
            p.character = static_cast<AmpCharacter>(ch);
            p.gain = smoother_.cur[1];
            p.bass = smoother_.cur[2];
            p.mid = smoother_.cur[3];
            p.treble = smoother_.cur[4];
            p.presence = smoother_.cur[5];
            p.tightHz = smoother_.cur[6];
            p.levelDb = smoother_.cur[7];
            amp_.setParams(p);
            applied_ = true;
        }
        amp_.process(io, n);
    }

private:
    BuiltinAmp amp_;
    ParamSmoother smoother_;
    bool applied_ = false;
};

class NamBlock final : public Block {
public:
    explicit NamBlock(std::string uid) : Block(BlockType::Nam, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        slot_.prepare(sampleRate, maxBlock);
        const size_t cap = static_cast<size_t>(std::max(1, maxBlock));
        inBuf_.assign(cap, 0.0f);
        outBuf_.assign(cap, 0.0f);
        applied_ = false;
    }

    void reset() noexcept override {
        slot_.reset();
        smoother_.snapped = false;
        applied_ = false;
    }

    bool loadFile(const std::filesystem::path& path, std::string& errorOut) override {
        return slot_.loadSync(path, errorOut);
    }

    void clearFile() override {
        slot_.clear();
    }

    bool hasFile() const noexcept override {
        return slot_.hasModel();
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            levelGain_ = dbToGain(smoother_.cur[0]);
            applied_ = true;
        }

        if (slot_.hasModel() && static_cast<int>(inBuf_.size()) >= n) {
            for (int i = 0; i < n; ++i) {
                inBuf_[static_cast<size_t>(i)] = static_cast<NAM_SAMPLE>(io[i]);
            }
            NAM_SAMPLE* inPtrs[1] = {inBuf_.data()};
            NAM_SAMPLE* outPtrs[1] = {outBuf_.data()};
            float makeup = 1.0f;
            if (slot_.processAudio(inPtrs, outPtrs, n, makeup)) {
                const float gain = makeup * levelGain_;
                for (int i = 0; i < n; ++i) {
                    io[i] = static_cast<float>(outBuf_[static_cast<size_t>(i)]) * gain;
                }
                return;
            }
        }

        if (std::abs(levelGain_ - 1.0f) > 1e-6f) {
            for (int i = 0; i < n; ++i) {
                io[i] *= levelGain_;
            }
        }
    }

private:
    NamSlot slot_;
    std::vector<NAM_SAMPLE> inBuf_;
    std::vector<NAM_SAMPLE> outBuf_;
    ParamSmoother smoother_;
    float levelGain_ = 1.0f;
    bool applied_ = false;
};

class CabBlock final : public Block {
public:
    explicit CabBlock(std::string uid) : Block(BlockType::Cab, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        cab_.prepare(sampleRate, maxBlock);
        applied_ = false;
    }

    void reset() noexcept override {
        cab_.reset();
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            const int model = std::clamp(static_cast<int>(std::lround(smoother_.cur[0])), 0, 4);
            cab_.setType(static_cast<CabType>(model));
            levelGain_ = dbToGain(smoother_.cur[1]);
            applied_ = true;
        }
        cab_.process(io, n);
        if (std::abs(levelGain_ - 1.0f) > 1e-6f) {
            for (int i = 0; i < n; ++i) {
                io[i] *= levelGain_;
            }
        }
    }

private:
    CabSim cab_;
    ParamSmoother smoother_;
    float levelGain_ = 1.0f;
    bool applied_ = false;
};

class IrBlock final : public Block {
public:
    explicit IrBlock(std::string uid) : Block(BlockType::Ir, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        convolver_.prepare(sampleRate, maxBlock);
        if (!rawWav_.samples.empty()) {
            std::vector<float> resampled = resampleWindowedSinc(
                rawWav_.samples, rawWav_.sampleRate, static_cast<int>(std::round(sampleRate)));
            convolver_.loadIr(resampled, true);
        }
        applied_ = false;
    }

    void reset() noexcept override {
        convolver_.reset();
        smoother_.snapped = false;
        applied_ = false;
    }

    bool loadFile(const std::filesystem::path& path, std::string& errorOut) override {
        WavData wav;
        if (!readWavMono(path, wav, errorOut)) {
            return false;
        }
        const double targetSr = (preparedRate_ > 1.0) ? preparedRate_ : 48000.0;
        std::vector<float> resampled = resampleWindowedSinc(
            wav.samples, wav.sampleRate, static_cast<int>(std::round(targetSr)));
        rawWav_ = std::move(wav);
        convolver_.loadIr(resampled, true);
        return true;
    }

    void clearFile() override {
        rawWav_ = WavData{};
        convolver_.clearIr();
    }

    bool hasFile() const noexcept override {
        return convolver_.hasIr();
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            levelGain_ = dbToGain(smoother_.cur[0]);
            applied_ = true;
        }
        if (convolver_.hasIr()) {
            convolver_.process(io, n);
        }
        if (std::abs(levelGain_ - 1.0f) > 1e-6f) {
            for (int i = 0; i < n; ++i) {
                io[i] *= levelGain_;
            }
        }
    }

private:
    WavData rawWav_;
    IrConvolver convolver_;
    ParamSmoother smoother_;
    float levelGain_ = 1.0f;
    bool applied_ = false;
};

class EqBlock final : public Block {
public:
    explicit EqBlock(std::string uid) : Block(BlockType::Eq, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        lowShelf_.prepare(sampleRate, maxBlock);
        midPeak_.prepare(sampleRate, maxBlock);
        highShelf_.prepare(sampleRate, maxBlock);
        applied_ = false;
    }

    void reset() noexcept override {
        lowShelf_.reset();
        midPeak_.reset();
        highShelf_.reset();
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            const float lowDb = smoother_.cur[0];
            const float midDb = smoother_.cur[1];
            const float highDb = smoother_.cur[2];
            active_ = (std::abs(lowDb) > 1e-3f) || (std::abs(midDb) > 1e-3f) || (std::abs(highDb) > 1e-3f);
            if (active_) {
                lowShelf_.configure(BiquadType::LowShelf, 100.0, 0.7071067811865475, lowDb);
                midPeak_.configure(BiquadType::Peak, 1000.0, 1.0, midDb);
                highShelf_.configure(BiquadType::HighShelf, 4000.0, 0.7071067811865475, highDb);
            }
            applied_ = true;
        }
        if (active_) {
            lowShelf_.processBlock(io, n);
            midPeak_.processBlock(io, n);
            highShelf_.processBlock(io, n);
        }
    }

private:
    Biquad lowShelf_;
    Biquad midPeak_;
    Biquad highShelf_;
    ParamSmoother smoother_;
    bool active_ = false;
    bool applied_ = false;
};

class OverdriveBlock final : public Block {
public:
    explicit OverdriveBlock(std::string uid) : Block(BlockType::Overdrive, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        od_.Init();
        applied_ = false;
    }

    void reset() noexcept override {
        od_.Init();
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            od_.SetDrive(smoother_.cur[0]);
            levelGain_ = dbToGain(smoother_.cur[1]);
            applied_ = true;
        }
        for (int i = 0; i < n; ++i) {
            io[i] = od_.Process(io[i]) * levelGain_;
        }
    }

private:
    daisysp::Overdrive od_;
    ParamSmoother smoother_;
    float levelGain_ = 1.0f;
    bool applied_ = false;
};

class ChorusBlock final : public Block {
public:
    explicit ChorusBlock(std::string uid) : Block(BlockType::Chorus, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        chorus_.Init(static_cast<float>(sampleRate));
        applied_ = false;
    }

    void reset() noexcept override {
        const double sr = (preparedRate_ > 1.0) ? preparedRate_ : 48000.0;
        chorus_.Init(static_cast<float>(sr));
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            chorus_.SetLfoFreq(smoother_.cur[0]);
            chorus_.SetLfoDepth(smoother_.cur[1]);
            chorus_.SetDelayMs(smoother_.cur[2]);
            chorus_.SetFeedback(smoother_.cur[3]);
            mix_ = smoother_.cur[4];
            applied_ = true;
        }
        const float dryGain = 1.0f - mix_;
        for (int i = 0; i < n; ++i) {
            const float dry = io[i];
            const float wet = chorus_.Process(dry);
            io[i] = dry * dryGain + wet * mix_;
        }
    }

private:
    daisysp::Chorus chorus_;
    ParamSmoother smoother_;
    float mix_ = 0.5f;
    bool applied_ = false;
};

class FlangerBlock final : public Block {
public:
    explicit FlangerBlock(std::string uid) : Block(BlockType::Flanger, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        flanger_.Init(static_cast<float>(sampleRate));
        applied_ = false;
    }

    void reset() noexcept override {
        const double sr = (preparedRate_ > 1.0) ? preparedRate_ : 48000.0;
        flanger_.Init(static_cast<float>(sr));
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            flanger_.SetLfoFreq(smoother_.cur[0]);
            flanger_.SetLfoDepth(smoother_.cur[1]);
            flanger_.SetDelayMs(smoother_.cur[2]);
            flanger_.SetFeedback(smoother_.cur[3]);
            mix_ = smoother_.cur[4];
            applied_ = true;
        }
        const float dryGain = 1.0f - mix_;
        for (int i = 0; i < n; ++i) {
            const float dry = io[i];
            const float wet = flanger_.Process(dry);
            io[i] = dry * dryGain + wet * mix_;
        }
    }

private:
    daisysp::Flanger flanger_;
    ParamSmoother smoother_;
    float mix_ = 0.5f;
    bool applied_ = false;
};

class PhaserBlock final : public Block {
public:
    explicit PhaserBlock(std::string uid) : Block(BlockType::Phaser, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        phaser_.Init(static_cast<float>(sampleRate));
        applied_ = false;
    }

    void reset() noexcept override {
        const double sr = (preparedRate_ > 1.0) ? preparedRate_ : 48000.0;
        phaser_.Init(static_cast<float>(sr));
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            phaser_.SetLfoFreq(smoother_.cur[0]);
            phaser_.SetLfoDepth(smoother_.cur[1]);
            phaser_.SetFreq(smoother_.cur[2]);
            phaser_.SetFeedback(smoother_.cur[3]);
            const int stageIdx = std::clamp(static_cast<int>(std::lround(smoother_.cur[4])), 0, 3);
            phaser_.SetPoles((stageIdx + 1) * 2);
            mix_ = smoother_.cur[5];
            applied_ = true;
        }
        const float dryGain = 1.0f - mix_;
        for (int i = 0; i < n; ++i) {
            const float dry = io[i];
            const float wet = phaser_.Process(dry);
            io[i] = dry * dryGain + wet * mix_;
        }
    }

private:
    daisysp::Phaser phaser_;
    ParamSmoother smoother_;
    float mix_ = 0.5f;
    bool applied_ = false;
};

class TremoloBlock final : public Block {
public:
    explicit TremoloBlock(std::string uid) : Block(BlockType::Tremolo, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        tremolo_.Init(static_cast<float>(sampleRate));
        applied_ = false;
    }

    void reset() noexcept override {
        const double sr = (preparedRate_ > 1.0) ? preparedRate_ : 48000.0;
        tremolo_.Init(static_cast<float>(sr));
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            tremolo_.SetFreq(smoother_.cur[0]);
            tremolo_.SetDepth(smoother_.cur[1]);
            constexpr int kWaves[3] = {
                daisysp::Oscillator::WAVE_SIN,
                daisysp::Oscillator::WAVE_TRI,
                daisysp::Oscillator::WAVE_SQUARE,
            };
            const int waveIdx = std::clamp(static_cast<int>(std::lround(smoother_.cur[2])), 0, 2);
            tremolo_.SetWaveform(kWaves[waveIdx]);
            applied_ = true;
        }
        for (int i = 0; i < n; ++i) {
            io[i] = tremolo_.Process(io[i]);
        }
    }

private:
    daisysp::Tremolo tremolo_;
    ParamSmoother smoother_;
    bool applied_ = false;
};

class AutowahBlock final : public Block {
public:
    explicit AutowahBlock(std::string uid) : Block(BlockType::Autowah, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        wah_.Init(static_cast<float>(sampleRate));
        applied_ = false;
    }

    void reset() noexcept override {
        const double sr = (preparedRate_ > 1.0) ? preparedRate_ : 48000.0;
        wah_.Init(static_cast<float>(sr));
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            wah_.SetWah(smoother_.cur[0]);
            wah_.SetLevel(smoother_.cur[1]);
            wah_.SetDryWet(smoother_.cur[2] * 100.0f);
            applied_ = true;
        }
        for (int i = 0; i < n; ++i) {
            io[i] = wah_.Process(io[i]);
        }
    }

private:
    daisysp::Autowah wah_;
    ParamSmoother smoother_;
    bool applied_ = false;
};

class DelayBlock final : public Block {
public:
    explicit DelayBlock(std::string uid) : Block(BlockType::Delay, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        delay_.prepare(sampleRate, maxBlock);
        applied_ = false;
    }

    void reset() noexcept override {
        delay_.reset();
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            delay_.setParams(smoother_.cur[0], smoother_.cur[1], smoother_.cur[3]);
            delay_.setFeedbackToneHz(smoother_.cur[2]);
            applied_ = true;
        }
        delay_.process(io, n);
    }

private:
    MonoDelay delay_;
    ParamSmoother smoother_;
    bool applied_ = false;
};

class ReverbBlock final : public Block {
public:
    explicit ReverbBlock(std::string uid) : Block(BlockType::Reverb, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        freeverb_.prepare(sampleRate, maxBlock);
        reverbSc_.Init(static_cast<float>(sampleRate));
        applied_ = false;
    }

    void reset() noexcept override {
        const double sr = (preparedRate_ > 1.0) ? preparedRate_ : 48000.0;
        freeverb_.reset();
        reverbSc_.Init(static_cast<float>(sr));
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            const int nextType = std::clamp(static_cast<int>(std::lround(smoother_.cur[0])), 0, 1);
            if (applied_ && nextType != mode_) {
                if (nextType == 0) {
                    freeverb_.reset();
                } else {
                    const double sr = (preparedRate_ > 1.0) ? preparedRate_ : 48000.0;
                    reverbSc_.Init(static_cast<float>(sr));
                }
            }
            mode_ = nextType;
            const float size = smoother_.cur[1];
            const float tone = smoother_.cur[2];
            mix_ = smoother_.cur[3];

            if (mode_ == 0) {
                freeverb_.setParams(size, mix_, 1.0f - tone);
            } else {
                const float fb = 0.6f + size * 0.37f;
                const float maxLp = static_cast<float>((preparedRate_ > 1.0 ? preparedRate_ : 48000.0) * 0.48);
                const float lp = std::min(2000.0f + tone * 14000.0f, maxLp);
                reverbSc_.SetFeedback(fb);
                reverbSc_.SetLpFreq(lp);
            }
            applied_ = true;
        }

        if (mode_ == 0) {
            freeverb_.process(io, n);
        } else {
            const float dryGain = 1.0f - mix_;
            for (int i = 0; i < n; ++i) {
                const float dry = io[i];
                float outL = 0.0f;
                float outR = 0.0f;
                reverbSc_.Process(dry, dry, &outL, &outR);
                const float wet = 0.5f * (outL + outR);
                io[i] = dry * dryGain + wet * mix_;
            }
        }
    }

private:
    Freeverb freeverb_;
    daisysp::ReverbSc reverbSc_;
    ParamSmoother smoother_;
    int mode_ = 0;
    float mix_ = 0.25f;
    bool applied_ = false;
};

class MixerBlock final : public Block {
public:
    explicit MixerBlock(std::string uid) : Block(BlockType::Mixer, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        applied_ = false;
    }

    void reset() noexcept override {
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        const float* ins[2] = {io, nullptr};
        processMulti(ins, 2, io, n);
    }

    void processMulti(const float* const* ins, int numIns, float* out, int n) noexcept override {
        if (out == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            const float bal = std::clamp(smoother_.cur[0], 0.0f, 1.0f);
            const double angle = static_cast<double>(bal) * 1.57079632679489661923;
            const float gainA = (bal <= 0.0f) ? 1.0f : (bal >= 1.0f ? 0.0f : static_cast<float>(std::cos(angle)));
            const float gainB = (bal <= 0.0f) ? 0.0f : (bal >= 1.0f ? 1.0f : static_cast<float>(std::sin(angle)));
            const float levelGain = dbToGain(smoother_.cur[1]);
            totalA_ = gainA * levelGain;
            totalB_ = gainB * levelGain;
            applied_ = true;
        }

        const float* inA = (ins != nullptr && numIns >= 1) ? ins[0] : nullptr;
        const float* inB = (ins != nullptr && numIns >= 2) ? ins[1] : nullptr;
        for (int i = 0; i < n; ++i) {
            const float a = (inA != nullptr) ? inA[i] : 0.0f;
            const float b = (inB != nullptr) ? inB[i] : 0.0f;
            out[i] = a * totalA_ + b * totalB_;
        }
    }

private:
    ParamSmoother smoother_;
    float totalA_ = 0.70710678f;
    float totalB_ = 0.70710678f;
    bool applied_ = false;
};

class VolumeBlock final : public Block {
public:
    explicit VolumeBlock(std::string uid) : Block(BlockType::Volume, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        applied_ = false;
    }

    void reset() noexcept override {
        smoother_.snapped = false;
        applied_ = false;
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, !applied_)) {
            levelGain_ = dbToGain(smoother_.cur[0]);
            applied_ = true;
        }
        if (std::abs(levelGain_ - 1.0f) > 1e-6f) {
            for (int i = 0; i < n; ++i) {
                io[i] *= levelGain_;
            }
        }
    }

private:
    ParamSmoother smoother_;
    float levelGain_ = 1.0f;
    bool applied_ = false;
};

class MetalBlock final : public Block {
public:
    explicit MetalBlock(std::string uid) : Block(BlockType::Metal, std::move(uid)) {}

    void prepare(double sampleRate, int maxBlock) override {
        blockPrepared(sampleRate, maxBlock);
        smoother_.snap(targets_, spec().params.size());
        metal_.setParams(current());
        metal_.prepare(sampleRate, maxBlock);
    }

    void reset() noexcept override {
        smoother_.snap(targets_, spec().params.size());
        metal_.setParams(current());
        metal_.reset();
    }

    void process(float* io, int n) noexcept override {
        if (io == nullptr || n <= 0) return;
        if (smoother_.smooth(targets_, spec().params, preparedRate_, n, false)) {
            metal_.setParams(current());
        }
        metal_.process(io, n);
    }

private:
    MetalParams current() const noexcept {
        MetalParams p;
        p.gain = smoother_.cur[0];
        p.tightHz = smoother_.cur[1];
        p.lowDb = smoother_.cur[2];
        p.midDb = smoother_.cur[3];
        p.highDb = smoother_.cur[4];
        p.levelDb = smoother_.cur[5];
        p.gateDb = smoother_.cur[6];
        return p;
    }

    MetalDistortion metal_;
    ParamSmoother smoother_;
};

} // namespace

std::shared_ptr<Block> makeBlock(BlockType type, const std::string& uid) {
    switch (type) {
        case BlockType::Amp:       return std::make_shared<AmpBlock>(uid);
        case BlockType::Nam:       return std::make_shared<NamBlock>(uid);
        case BlockType::Cab:       return std::make_shared<CabBlock>(uid);
        case BlockType::Ir:        return std::make_shared<IrBlock>(uid);
        case BlockType::Eq:        return std::make_shared<EqBlock>(uid);
        case BlockType::Overdrive: return std::make_shared<OverdriveBlock>(uid);
        case BlockType::Chorus:    return std::make_shared<ChorusBlock>(uid);
        case BlockType::Flanger:   return std::make_shared<FlangerBlock>(uid);
        case BlockType::Phaser:    return std::make_shared<PhaserBlock>(uid);
        case BlockType::Tremolo:   return std::make_shared<TremoloBlock>(uid);
        case BlockType::Autowah:   return std::make_shared<AutowahBlock>(uid);
        case BlockType::Delay:     return std::make_shared<DelayBlock>(uid);
        case BlockType::Reverb:    return std::make_shared<ReverbBlock>(uid);
        case BlockType::Mixer:     return std::make_shared<MixerBlock>(uid);
        case BlockType::Volume:    return std::make_shared<VolumeBlock>(uid);
        case BlockType::Metal:     return std::make_shared<MetalBlock>(uid);
    }
    return std::make_shared<AmpBlock>(uid);
}

Board::Board(std::vector<std::shared_ptr<Block>> blocks, std::vector<Cable> cables)
    : blocks_(std::move(blocks)) {
    std::unordered_map<std::string, int> uidToIdx;
    uidToIdx.reserve(blocks_.size());
    for (size_t i = 0; i < blocks_.size(); ++i) {
        if (!blocks_[i]) {
            valid_ = false;
            continue;
        }
        const std::string& uid = blocks_[i]->uid();
        if (uid.empty() || uid == kInputUid || uid == kOutputUid || uidToIdx.count(uid) > 0) {
            valid_ = false;
            continue;
        }
        uidToIdx.emplace(uid, static_cast<int>(i));
    }

    std::unordered_set<std::string> seenCables;
    seenCables.reserve(cables.size());
    std::vector<Cable> cleanCables;
    cleanCables.reserve(cables.size());

    for (const auto& c : cables) {
        if (c.to == kInputUid || c.from == kOutputUid) {
            valid_ = false;
            continue;
        }
        if (c.from != kInputUid && uidToIdx.count(c.from) == 0) {
            valid_ = false;
            continue;
        }
        if (c.to == kOutputUid) {
            if (c.port != 0) {
                valid_ = false;
                continue;
            }
        } else {
            auto it = uidToIdx.find(c.to);
            if (it == uidToIdx.end()) {
                valid_ = false;
                continue;
            }
            const int maxInputs = blocks_[static_cast<size_t>(it->second)]->spec().inputs;
            if (c.port < 0 || c.port >= maxInputs) {
                valid_ = false;
                continue;
            }
        }

        std::string dedupKey = c.from;
        dedupKey.push_back(char(0));
        dedupKey += c.to;
        dedupKey.push_back(char(0));
        dedupKey += std::to_string(c.port);
        if (!seenCables.insert(std::move(dedupKey)).second) {
            valid_ = false;
            continue;
        }

        cleanCables.push_back(c);
    }

    const int numBlocks = static_cast<int>(blocks_.size());
    const int inNode = numBlocks;
    const int outNode = numBlocks + 1;
    const int totalNodes = numBlocks + 2;

    auto nodeOf = [&](const std::string& uid) -> int {
        if (uid == kInputUid) return inNode;
        if (uid == kOutputUid) return outNode;
        return uidToIdx.at(uid);
    };

    std::vector<int> topo;
    while (true) {
        std::vector<std::vector<int>> fwd(static_cast<size_t>(totalNodes));
        std::vector<std::vector<int>> rev(static_cast<size_t>(totalNodes));
        for (const auto& c : cleanCables) {
            const int u = nodeOf(c.from);
            const int v = nodeOf(c.to);
            fwd[static_cast<size_t>(u)].push_back(v);
            rev[static_cast<size_t>(v)].push_back(u);
        }

        std::vector<bool> fromIn(static_cast<size_t>(totalNodes), false);
        {
            std::queue<int> q;
            fromIn[static_cast<size_t>(inNode)] = true;
            q.push(inNode);
            while (!q.empty()) {
                const int u = q.front();
                q.pop();
                for (int v : fwd[static_cast<size_t>(u)]) {
                    if (!fromIn[static_cast<size_t>(v)]) {
                        fromIn[static_cast<size_t>(v)] = true;
                        q.push(v);
                    }
                }
            }
        }

        std::vector<bool> toOut(static_cast<size_t>(totalNodes), false);
        {
            std::queue<int> q;
            toOut[static_cast<size_t>(outNode)] = true;
            q.push(outNode);
            while (!q.empty()) {
                const int u = q.front();
                q.pop();
                for (int v : rev[static_cast<size_t>(u)]) {
                    if (!toOut[static_cast<size_t>(v)]) {
                        toOut[static_cast<size_t>(v)] = true;
                        q.push(v);
                    }
                }
            }
        }

        std::vector<bool> isLive(static_cast<size_t>(numBlocks), false);
        std::vector<int> liveBlocks;
        for (int i = 0; i < numBlocks; ++i) {
            if (fromIn[static_cast<size_t>(i)] && toOut[static_cast<size_t>(i)]) {
                isLive[static_cast<size_t>(i)] = true;
                liveBlocks.push_back(i);
            }
        }

        std::vector<std::vector<int>> liveAdj(static_cast<size_t>(numBlocks));
        std::vector<int> inDeg(static_cast<size_t>(numBlocks), 0);
        for (const auto& c : cleanCables) {
            const int u = nodeOf(c.from);
            const int v = nodeOf(c.to);
            if (u < numBlocks && v < numBlocks && isLive[static_cast<size_t>(u)] && isLive[static_cast<size_t>(v)]) {
                liveAdj[static_cast<size_t>(u)].push_back(v);
                ++inDeg[static_cast<size_t>(v)];
            }
        }

        topo.clear();
        topo.reserve(liveBlocks.size());
        std::queue<int> q;
        for (int bIdx : liveBlocks) {
            if (inDeg[static_cast<size_t>(bIdx)] == 0) {
                q.push(bIdx);
            }
        }
        while (!q.empty()) {
            const int u = q.front();
            q.pop();
            topo.push_back(u);
            for (int v : liveAdj[static_cast<size_t>(u)]) {
                if (--inDeg[static_cast<size_t>(v)] == 0) {
                    q.push(v);
                }
            }
        }

        if (topo.size() == liveBlocks.size()) {
            break;
        }

        // Cycle exists among live blocks: drop cables on any cycle and re-sort.
        std::vector<std::vector<bool>> canReach(static_cast<size_t>(numBlocks),
                                                std::vector<bool>(static_cast<size_t>(numBlocks), false));
        for (int start : liveBlocks) {
            std::queue<int> rq;
            canReach[static_cast<size_t>(start)][static_cast<size_t>(start)] = true;
            rq.push(start);
            while (!rq.empty()) {
                const int cur = rq.front();
                rq.pop();
                for (int nxt : liveAdj[static_cast<size_t>(cur)]) {
                    if (!canReach[static_cast<size_t>(start)][static_cast<size_t>(nxt)]) {
                        canReach[static_cast<size_t>(start)][static_cast<size_t>(nxt)] = true;
                        rq.push(nxt);
                    }
                }
            }
        }

        std::vector<Cable> pruned;
        pruned.reserve(cleanCables.size());
        for (const auto& c : cleanCables) {
            const int u = nodeOf(c.from);
            const int v = nodeOf(c.to);
            if (u < numBlocks && v < numBlocks &&
                isLive[static_cast<size_t>(u)] && isLive[static_cast<size_t>(v)] &&
                canReach[static_cast<size_t>(v)][static_cast<size_t>(u)]) {
                valid_ = false;
                continue;
            }
            pruned.push_back(c);
        }
        cleanCables = std::move(pruned);
    }

    cables_ = std::move(cleanCables);

    std::vector<int> blockToOutBuf(static_cast<size_t>(numBlocks), -1);
    for (size_t s = 0; s < topo.size(); ++s) {
        blockToOutBuf[static_cast<size_t>(topo[s])] = static_cast<int>(s);
    }

    plan_.resize(topo.size());
    for (size_t s = 0; s < topo.size(); ++s) {
        Block* blk = blocks_[static_cast<size_t>(topo[s])].get();
        plan_[s].block = blk;
        plan_[s].numInputs = std::clamp(blk->spec().inputs, 1, 2);
        plan_[s].outBuf = static_cast<int>(s);
    }

    for (const auto& c : cables_) {
        int srcBuf = -1;
        if (c.from != kInputUid) {
            srcBuf = blockToOutBuf[static_cast<size_t>(uidToIdx.at(c.from))];
            if (srcBuf < 0) continue;
        }

        if (c.to == kOutputUid) {
            outputSources_.push_back(srcBuf);
        } else {
            const int dstIdx = uidToIdx.at(c.to);
            const int dstStep = blockToOutBuf[static_cast<size_t>(dstIdx)];
            if (dstStep >= 0 && c.port >= 0 && c.port < plan_[static_cast<size_t>(dstStep)].numInputs) {
                plan_[static_cast<size_t>(dstStep)].sources[c.port].push_back(srcBuf);
            }
        }
    }
}

Block* Board::findByUid(const std::string& uid) const noexcept {
    for (const auto& b : blocks_) {
        if (b && b->uid() == uid) return b.get();
    }
    return nullptr;
}

void Board::prepareScratch(int maxBlock) {
    const size_t cap = static_cast<size_t>(std::max(1, maxBlock));
    buffers_.resize(plan_.size());
    for (auto& buf : buffers_) {
        buf.assign(cap, 0.0f);
    }
    inputCopy_.assign(cap, 0.0f);
    portScratch_[0].assign(cap, 0.0f);
    portScratch_[1].assign(cap, 0.0f);
    dry_.assign(cap, 0.0f);
}

void Board::process(float* io, int n) noexcept {
    if (io == nullptr || n <= 0) return;

    const int scratchCap = static_cast<int>(inputCopy_.size());
    if (scratchCap > 0 && n > scratchCap) {
        int offset = 0;
        while (offset < n) {
            const int chunk = std::min(n - offset, scratchCap);
            process(io + offset, chunk);
            offset += chunk;
        }
        return;
    }
    if (scratchCap < n) {
        std::fill_n(io, n, 0.0f);
        return;
    }

    std::copy_n(io, n, inputCopy_.data());

    auto sumSources = [&](const std::vector<int>& srcs, float* dst) noexcept {
        if (srcs.empty()) {
            std::fill_n(dst, n, 0.0f);
            return;
        }
        const float* first = (srcs[0] < 0) ? inputCopy_.data() : buffers_[static_cast<size_t>(srcs[0])].data();
        std::copy_n(first, n, dst);
        for (size_t s = 1; s < srcs.size(); ++s) {
            const float* src = (srcs[s] < 0) ? inputCopy_.data() : buffers_[static_cast<size_t>(srcs[s])].data();
            for (int i = 0; i < n; ++i) {
                dst[i] += src[i];
            }
        }
    };

    for (const Step& step : plan_) {
        for (int p = 0; p < step.numInputs; ++p) {
            sumSources(step.sources[p], portScratch_[p].data());
        }

        Block* b = step.block;
        float* outBuf = buffers_[static_cast<size_t>(step.outBuf)].data();
        const float target = b->enabled() ? 1.0f : 0.0f;

        if (b->fade == 1.0f && target == 1.0f) {
            if (step.numInputs == 1) {
                std::copy_n(portScratch_[0].data(), n, outBuf);
                b->process(outBuf, n);
            } else {
                const float* ins[2] = {portScratch_[0].data(), portScratch_[1].data()};
                b->processMulti(ins, step.numInputs, outBuf, n);
            }
        } else if (b->fade == 0.0f && target == 0.0f) {
            std::copy_n(portScratch_[0].data(), n, outBuf);
        } else {
            if (step.numInputs == 1) {
                std::copy_n(portScratch_[0].data(), n, outBuf);
                b->process(outBuf, n);
            } else {
                const float* ins[2] = {portScratch_[0].data(), portScratch_[1].data()};
                b->processMulti(ins, step.numInputs, outBuf, n);
            }

            const double sr = (b->preparedRate_ > 1.0) ? b->preparedRate_ : 48000.0;
            const float fadeStep = 1.0f / (0.01f * static_cast<float>(sr));
            for (int i = 0; i < n; ++i) {
                if (b->fade < target) {
                    b->fade = std::min(1.0f, b->fade + fadeStep);
                } else if (b->fade > target) {
                    b->fade = std::max(0.0f, b->fade - fadeStep);
                }
                const float f = b->fade;
                outBuf[i] = portScratch_[0][static_cast<size_t>(i)] * (1.0f - f) + outBuf[i] * f;
            }
        }
    }

    sumSources(outputSources_, io);
}

bool wouldCreateCycle(const std::vector<Cable>& cables, const Cable& add) {
    if (add.from == add.to) {
        return true;
    }

    std::vector<std::string> stack;
    std::unordered_set<std::string> visited;
    stack.push_back(add.to);
    visited.insert(add.to);

    while (!stack.empty()) {
        std::string cur = std::move(stack.back());
        stack.pop_back();
        for (const auto& c : cables) {
            if (c.from == cur) {
                if (c.to == add.from) {
                    return true;
                }
                if (visited.insert(c.to).second) {
                    stack.push_back(c.to);
                }
            }
        }
    }
    return false;
}

} // namespace wsamp::dsp
