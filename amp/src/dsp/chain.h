#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <vector>

#include "board.h"
#include "effects.h"

namespace wsamp::dsp {

struct GlobalParams {
    float inputTrimDb = 0.0f;
    float gateThresholdDb = -70.0f;
    float outputLevelDb = 0.0f;
};

class Chain {
public:
    Chain();
    ~Chain();

    void prepare(double sampleRate, int maxBlock);
    void reset() noexcept;

    void setGlobal(const GlobalParams& params) noexcept;
    void setInputTrimDb(float v) noexcept { targetInputTrimDb_.store(v, std::memory_order_relaxed); }
    void setGateThresholdDb(float v) noexcept { targetGateThresholdDb_.store(v, std::memory_order_relaxed); }
    void setOutputLevelDb(float v) noexcept { targetOutputLevelDb_.store(v, std::memory_order_relaxed); }

    // Controller thread: prepares any block whose prepared sample rate/maxBlock differs, sizes scratch,
    // then publishes the raw Board* atomically; the previous shared_ptr is kept in a retired list tagged
    // with the current audio epoch.
    void installBoard(std::shared_ptr<Board> board);
    std::shared_ptr<Board> board() const;
    void reclaim();

    // Audio thread: load the Board* once per call, run it, then increment the epoch.
    void process(float* io, int n) noexcept;

    double sampleRate() const noexcept { return sampleRate_; }
    int maxBlock() const noexcept { return maxBlock_; }

private:
    struct RetiredBoard {
        std::shared_ptr<Board> board;
        uint64_t retiredAtEpoch = 0;
    };

    void snapParameters() noexcept;
    void smoothAndApplyParams(int blockSamples) noexcept;
    void processChunk(float* io, int n, Board* board) noexcept;
    void reclaimLocked();

    double sampleRate_ = 48000.0;
    int maxBlock_ = 64;

    std::atomic<float> targetInputTrimDb_{0.0f};
    std::atomic<float> targetGateThresholdDb_{-70.0f};
    std::atomic<float> targetOutputLevelDb_{0.0f};

    GlobalParams current_{};
    GlobalParams applied_{};
    bool hasAppliedOnce_ = false;

    NoiseGate gate_;
    OutputStage outputStage_;

    std::atomic<Board*> activeBoard_{nullptr};
    std::atomic<uint64_t> audioEpoch_{0};

    mutable std::mutex boardMutex_;
    std::shared_ptr<Board> currentBoard_;
    std::vector<RetiredBoard> retiredBoards_;
};

} // namespace wsamp::dsp
