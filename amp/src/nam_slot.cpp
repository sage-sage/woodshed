#include "nam_slot.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <exception>

#include "get_dsp.h"

namespace wsamp {

NamSlot::NamSlot() {
    workerThread_ = std::thread(&NamSlot::workerLoop, this);
}

NamSlot::~NamSlot() {
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        stopWorker_ = true;
        queueCv_.notify_all();
    }
    if (workerThread_.joinable()) {
        workerThread_.join();
    }
    clear();
}

void NamSlot::prepare(double sampleRate, int maxBlock) {
    sampleRate_ = (sampleRate > 1.0) ? sampleRate : 48000.0;
    maxBlock_ = std::max(1, maxBlock);
}

void NamSlot::reset() noexcept {
    // Models are reset on the loader thread when loaded; no allocation on audio thread.
}

bool NamSlot::loadSync(const std::filesystem::path& path, std::string& errorOut) {
    errorOut.clear();
    if (path.empty()) {
        clear();
        return true;
    }

    try {
        std::unique_ptr<nam::DSP> dsp = nam::get_dsp(path);
        if (!dsp) {
            errorOut = "nam::get_dsp returned null";
            std::lock_guard<std::mutex> errLock(errorMutex_);
            lastError_ = errorOut;
            return false;
        }

        if (dsp->NumInputChannels() != 1 || dsp->NumOutputChannels() != 1) {
            errorOut = "NAM model must be mono (1 input, 1 output)";
            std::lock_guard<std::mutex> errLock(errorMutex_);
            lastError_ = errorOut;
            return false;
        }

        const double expectedRate = dsp->GetExpectedSampleRate();
        if (expectedRate > 0.0 &&
            std::abs(expectedRate - sampleRate_) > 1.0 &&
            !dsp->SupportsArbitrarySampleRate()) {
            errorOut = "NAM model sample rate (" + std::to_string(static_cast<int>(expectedRate)) +
                       " Hz) does not match device rate (" + std::to_string(static_cast<int>(sampleRate_)) +
                       " Hz) and model cannot adapt";
            std::lock_guard<std::mutex> errLock(errorMutex_);
            lastError_ = errorOut;
            return false;
        }

        dsp->Reset(sampleRate_, maxBlock_);

        float makeupGain = 1.0f;
        if (dsp->HasLoudness()) {
            const double loudnessDb = dsp->GetLoudness();
            const float rawGain = std::pow(10.0f, (-18.0f - static_cast<float>(loudnessDb)) / 20.0f);
            makeupGain = std::clamp(rawGain, 0.01f, 100.0f);
        }

        installModel(std::move(dsp), makeupGain);

        {
            std::lock_guard<std::mutex> errLock(errorMutex_);
            lastError_.clear();
        }
        return true;
    } catch (const std::exception& e) {
        errorOut = e.what();
        std::lock_guard<std::mutex> errLock(errorMutex_);
        lastError_ = errorOut;
        return false;
    } catch (...) {
        errorOut = "Unknown error loading NAM model";
        std::lock_guard<std::mutex> errLock(errorMutex_);
        lastError_ = errorOut;
        return false;
    }
}

void NamSlot::loadAsync(const std::filesystem::path& path) {
    std::lock_guard<std::mutex> lock(queueMutex_);
    pendingPath_ = path;
    hasPendingLoad_ = true;
    queueCv_.notify_one();
}

void NamSlot::clear() {
    installModel(nullptr, 1.0f);
}

void NamSlot::installModel(std::unique_ptr<nam::DSP> newDsp, float makeupGain) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    reclaimRetiredLocked();

    const uint64_t epochBeforeSwap = audioEpoch_.load(std::memory_order_seq_cst);
    nam::DSP* rawNew = newDsp.get();

    activeMakeupGain_.store(makeupGain, std::memory_order_relaxed);
    activeModel_.store(rawNew, std::memory_order_release);

    if (ownedModel_) {
        retiredModels_.push_back(RetiredModel{std::move(ownedModel_), epochBeforeSwap});
    }
    ownedModel_ = std::move(newDsp);

    // Wait on the loader/control thread until the audio thread is either idle
    // or has completed its current block (acknowledged by incrementing audioEpoch_).
    for (int spin = 0; spin < 200; ++spin) {
        reclaimRetiredLocked();
        if (retiredModels_.empty()) {
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

void NamSlot::reclaimRetiredLocked() {
    const bool inAudio = audioInProcess_.load(std::memory_order_seq_cst);
    const uint64_t currentEpoch = audioEpoch_.load(std::memory_order_seq_cst);

    auto it = retiredModels_.begin();
    while (it != retiredModels_.end()) {
        if (!inAudio || currentEpoch > it->retiredAtEpoch) {
            it = retiredModels_.erase(it);
        } else {
            ++it;
        }
    }
}

void NamSlot::workerLoop() {
    while (true) {
        std::filesystem::path pathToLoad;
        {
            std::unique_lock<std::mutex> lock(queueMutex_);
            queueCv_.wait(lock, [this]() { return stopWorker_ || hasPendingLoad_; });
            if (stopWorker_) {
                return;
            }
            pathToLoad = std::move(pendingPath_);
            hasPendingLoad_ = false;
        }

        std::string err;
        loadSync(pathToLoad, err);
    }
}

bool NamSlot::processAudio(NAM_SAMPLE** in, NAM_SAMPLE** out, int numFrames, float& makeupGainOut) noexcept {
    audioInProcess_.store(true, std::memory_order_seq_cst);
    nam::DSP* dsp = activeModel_.load(std::memory_order_acquire);
    const float gain = activeMakeupGain_.load(std::memory_order_relaxed);

    bool processed = false;
    if (dsp != nullptr) {
        dsp->process(in, out, numFrames);
        makeupGainOut = gain;
        processed = true;
    }

    audioEpoch_.fetch_add(1, std::memory_order_seq_cst);
    audioInProcess_.store(false, std::memory_order_seq_cst);
    return processed;
}

} // namespace wsamp
