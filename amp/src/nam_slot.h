#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "dsp.h"

namespace wsamp {

class NamSlot {
public:
    NamSlot();
    ~NamSlot();

    NamSlot(const NamSlot&) = delete;
    NamSlot& operator=(const NamSlot&) = delete;

    void prepare(double sampleRate, int maxBlock);
    void reset() noexcept;

    // Loads a .nam model synchronously on the calling (non-audio) thread.
    bool loadSync(const std::filesystem::path& path, std::string& errorOut);

    // Queues asynchronous loading on the background loader thread.
    void loadAsync(const std::filesystem::path& path);

    // Unloads any active NAM model safely off the audio thread.
    void clear();

    bool hasModel() const noexcept {
        return activeModel_.load(std::memory_order_acquire) != nullptr;
    }

    std::string lastError() const {
        std::lock_guard<std::mutex> lock(errorMutex_);
        return lastError_;
    }

    // Real-time audio thread entry point: lock-free, allocation-free, exception-free.
    bool processAudio(NAM_SAMPLE** in, NAM_SAMPLE** out, int numFrames, float& makeupGainOut) noexcept;

private:
    struct RetiredModel {
        std::unique_ptr<nam::DSP> dsp;
        uint64_t retiredAtEpoch = 0;
    };

    void workerLoop();
    void installModel(std::unique_ptr<nam::DSP> newDsp, float makeupGain);
    void reclaimRetiredLocked();

    double sampleRate_ = 48000.0;
    int maxBlock_ = 64;

    // Shared with audio thread (lock-free)
    std::atomic<nam::DSP*> activeModel_{nullptr};
    std::atomic<float> activeMakeupGain_{1.0f};
    std::atomic<uint64_t> audioEpoch_{0};
    std::atomic<bool> audioInProcess_{false};

    // Loader/control thread state (never touched by audio thread)
    mutable std::mutex controlMutex_;
    std::unique_ptr<nam::DSP> ownedModel_;
    std::vector<RetiredModel> retiredModels_;

    mutable std::mutex errorMutex_;
    std::string lastError_;

    // Background loader thread
    std::mutex queueMutex_;
    std::condition_variable queueCv_;
    std::filesystem::path pendingPath_;
    bool hasPendingLoad_ = false;
    bool stopWorker_ = false;
    std::thread workerThread_;
};

} // namespace wsamp
