#include "chain.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace wsamp::dsp {

namespace {

inline bool changed(float a, float b) noexcept {
    return std::abs(a - b) > 1e-4f;
}

} // namespace

Chain::Chain() {
    setGlobal(GlobalParams{});
    snapParameters();
}

Chain::~Chain() {
    activeBoard_.store(nullptr, std::memory_order_release);
    std::lock_guard<std::mutex> lock(boardMutex_);
    currentBoard_.reset();
    retiredBoards_.clear();
}

void Chain::prepare(double sampleRate, int maxBlock) {
    std::lock_guard<std::mutex> lock(boardMutex_);
    sampleRate_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
    maxBlock_ = std::max(1, maxBlock);

    gate_.prepare(sampleRate_, maxBlock_);
    outputStage_.prepare(sampleRate_, maxBlock_);

    retiredBoards_.clear();

    if (currentBoard_) {
        for (const auto& blk : currentBoard_->blocks()) {
            if (blk) {
                blk->prepare(sampleRate_, maxBlock_);
                blk->blockPrepared(sampleRate_, maxBlock_);
            }
        }
        currentBoard_->prepareScratch(maxBlock_);
    }

    hasAppliedOnce_ = false;
    snapParameters();
    reset();
}

void Chain::reset() noexcept {
    gate_.reset();
    outputStage_.reset();
    if (Board* b = activeBoard_.load(std::memory_order_acquire)) {
        for (const auto& blk : b->blocks()) {
            if (blk) {
                blk->reset();
            }
        }
    }
}

void Chain::setGlobal(const GlobalParams& params) noexcept {
    targetInputTrimDb_.store(params.inputTrimDb, std::memory_order_relaxed);
    targetGateThresholdDb_.store(params.gateThresholdDb, std::memory_order_relaxed);
    targetOutputLevelDb_.store(params.outputLevelDb, std::memory_order_relaxed);
}

void Chain::snapParameters() noexcept {
    current_.inputTrimDb = targetInputTrimDb_.load(std::memory_order_relaxed);
    current_.gateThresholdDb = targetGateThresholdDb_.load(std::memory_order_relaxed);
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
    smooth(current_.outputLevelDb, targetOutputLevelDb_.load(std::memory_order_relaxed));

    if (!hasAppliedOnce_ || changed(current_.gateThresholdDb, applied_.gateThresholdDb)) {
        gate_.setThresholdDb(current_.gateThresholdDb);
    }

    if (!hasAppliedOnce_ || changed(current_.outputLevelDb, applied_.outputLevelDb)) {
        outputStage_.setLevelDb(current_.outputLevelDb);
    }

    applied_ = current_;
    hasAppliedOnce_ = true;
}

void Chain::installBoard(std::shared_ptr<Board> board) {
    std::lock_guard<std::mutex> lock(boardMutex_);
    reclaimLocked();

    if (board) {
        for (const auto& blk : board->blocks()) {
            if (blk && (blk->preparedRate_ != sampleRate_ || blk->preparedMax_ != maxBlock_)) {
                blk->prepare(sampleRate_, maxBlock_);
                blk->blockPrepared(sampleRate_, maxBlock_);
            }
        }
        board->prepareScratch(maxBlock_);
    }

    const uint64_t epoch = audioEpoch_.load(std::memory_order_acquire);
    activeBoard_.store(board ? board.get() : nullptr, std::memory_order_release);

    if (currentBoard_ && currentBoard_ != board) {
        retiredBoards_.push_back(RetiredBoard{std::move(currentBoard_), epoch});
    }
    currentBoard_ = std::move(board);
    reclaimLocked();
}

std::shared_ptr<Board> Chain::board() const {
    std::lock_guard<std::mutex> lock(boardMutex_);
    return currentBoard_;
}

void Chain::reclaim() {
    std::lock_guard<std::mutex> lock(boardMutex_);
    reclaimLocked();
}

void Chain::reclaimLocked() {
    const uint64_t now = audioEpoch_.load(std::memory_order_acquire);
    std::erase_if(retiredBoards_, [now](const RetiredBoard& r) {
        return (now - r.retiredAtEpoch) >= 2;
    });
}

void Chain::process(float* io, int n, const float* addAfterGate) noexcept {
    Board* board = activeBoard_.load(std::memory_order_acquire);
    if (io != nullptr && n > 0) {
        int offset = 0;
        while (offset < n) {
            const int chunk = std::min(n - offset, maxBlock_);
            const float* guideChunk = (addAfterGate != nullptr) ? (addAfterGate + offset) : nullptr;
            processChunk(io + offset, chunk, board, guideChunk);
            offset += chunk;
        }
    }
    audioEpoch_.fetch_add(1, std::memory_order_release);
}

void Chain::processChunk(float* io, int n, Board* board, const float* addAfterGate) noexcept {
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

    // 3. Pedalboard
    if (board != nullptr) {
        board->process(io, n);
    }

    // 3b. Optional guide guitar, mixed in clean AFTER the pedalboard (the guide is a recorded guitar sample;
    // running it through the player's amp model made it sound mangled). It still gets the output level/limiter.
    if (addAfterGate != nullptr) {
        for (int i = 0; i < n; ++i) {
            io[i] += addAfterGate[i];
        }
    }

    // 4. Output level + soft limiter
    outputStage_.process(io, n);
}

} // namespace wsamp::dsp
