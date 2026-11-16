#include "board.h"

#include <algorithm>
#include <cmath>
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
            false,
            nullptr,
            {
                {"drive", "Drive", 0.0f, 1.0f, 0.4f, 0.01f, "", {}},
                {"level", "Level", -24.0f, 12.0f, -6.0f, 0.5f, "dB", {}},
            },
        },
        {
            BlockType::Chorus,
            "chorus",
            "Chorus",
            "modulation",
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
            false,
            nullptr,
            {
                {"type", "Type", 0.0f, 1.0f, 0.0f, 1.0f, "", {"Room", "Lush"}},
                {"size", "Size", 0.0f, 1.0f, 0.5f, 0.01f, "", {}},
                {"tone", "Tone", 0.0f, 1.0f, 0.5f, 0.01f, "", {}},
                {"mix", "Mix", 0.0f, 1.0f, 0.25f, 0.01f, "", {}},
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
    }
    return std::make_shared<AmpBlock>(uid);
}

Board::Board(std::vector<std::shared_ptr<Block>> blocks)
    : blocks_(std::move(blocks)) {
    raw_.reserve(blocks_.size());
    for (const auto& b : blocks_) {
        if (b) {
            raw_.push_back(b.get());
        }
    }
}

Block* Board::findByUid(const std::string& uid) const noexcept {
    for (Block* b : raw_) {
        if (b->uid() == uid) return b;
    }
    return nullptr;
}

void Board::prepareScratch(int maxBlock) {
    dry_.assign(static_cast<size_t>(std::max(1, maxBlock)), 0.0f);
}

void Board::process(float* io, int n) noexcept {
    if (io == nullptr || n <= 0) return;

    const int scratchCap = static_cast<int>(dry_.size());
    if (scratchCap > 0 && n > scratchCap) {
        int offset = 0;
        while (offset < n) {
            const int chunk = std::min(n - offset, scratchCap);
            process(io + offset, chunk);
            offset += chunk;
        }
        return;
    }

    for (Block* b : raw_) {
        const float target = b->enabled() ? 1.0f : 0.0f;
        if (b->fade == 1.0f && target == 1.0f) {
            b->process(io, n);
        } else if (b->fade == 0.0f && target == 0.0f) {
            continue;
        } else if (scratchCap >= n) {
            std::copy_n(io, n, dry_.data());
            b->process(io, n);

            const double sr = (b->preparedRate_ > 1.0) ? b->preparedRate_ : 48000.0;
            const float step = 1.0f / (0.01f * static_cast<float>(sr));
            for (int i = 0; i < n; ++i) {
                if (b->fade < target) {
                    b->fade = std::min(1.0f, b->fade + step);
                } else if (b->fade > target) {
                    b->fade = std::max(0.0f, b->fade - step);
                }
                const float f = b->fade;
                io[i] = dry_[static_cast<size_t>(i)] * (1.0f - f) + io[i] * f;
            }
        } else {
            b->fade = target;
            if (target > 0.5f) {
                b->process(io, n);
            }
        }
    }
}

} // namespace wsamp::dsp
