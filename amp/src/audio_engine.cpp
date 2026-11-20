#include "audio_engine.h"

#include <chrono>
#include <thread>

#include <windows.h>
#include <pmmintrin.h>
#include <xmmintrin.h>

#include <algorithm>
#include <cmath>
#include <cstring>

#include "pa_asio.h"
#include "pa_win_wasapi.h"

namespace wsamp {

namespace {

float linToDbfs(float lin) noexcept {
    if (lin <= 1e-6f) return -120.0f;
    return 20.0f * std::log10(lin);
}

bool containsIgnoreCase(const std::string& haystack, const char* needle) {
    const size_t nLen = std::strlen(needle);
    if (nLen == 0) return true;
    if (haystack.size() < nLen) return false;
    for (size_t i = 0; i + nLen <= haystack.size(); ++i) {
        bool match = true;
        for (size_t j = 0; j < nLen; ++j) {
            char a = haystack[i + j];
            char b = needle[j];
            if (a >= 'A' && a <= 'Z') a = static_cast<char>(a + ('a' - 'A'));
            if (b >= 'A' && b <= 'Z') b = static_cast<char>(b + ('a' - 'A'));
            if (a != b) {
                match = false;
                break;
            }
        }
        if (match) return true;
    }
    return false;
}

long snapAsioBufferSize(long requested, long minBuf, long maxBuf, long prefBuf, long gran) noexcept {
    if (minBuf <= 0 || maxBuf < minBuf) {
        return (requested > 0) ? requested : ((prefBuf > 0) ? prefBuf : 64);
    }
    if (requested <= 0) {
        return (prefBuf > 0) ? std::clamp(prefBuf, minBuf, maxBuf) : minBuf;
    }

    const long clamped = std::clamp(requested, minBuf, maxBuf);
    if (gran == 0) {
        return minBuf;
    }
    if (gran == -1) {
        long best = 0;
        long bestDist = 0;
        for (long p = 1; p <= maxBuf && p > 0; p <<= 1) {
            if (p >= minBuf) {
                const long dist = std::abs(p - clamped);
                if (best == 0 || dist < bestDist) {
                    best = p;
                    bestDist = dist;
                }
            }
            if (p > (1L << 29)) break;
        }
        return (best > 0) ? best : clamped;
    }
    if (gran > 0) {
        const long k = static_cast<long>(std::llround(
            static_cast<double>(clamped - minBuf) / static_cast<double>(gran)));
        long cand = minBuf + k * gran;
        if (cand > maxBuf) cand -= gran;
        if (cand < minBuf) cand += gran;
        return std::clamp(cand, minBuf, maxBuf);
    }
    return clamped;
}

} // namespace

AudioEngine::AudioEngine() {
    LARGE_INTEGER freq{};
    QueryPerformanceFrequency(&freq);
    invQpcFreq_ = (freq.QuadPart > 0) ? (1.0 / static_cast<double>(freq.QuadPart)) : 0.0;

    workBuf_.assign(kMaxBlock, 0.0f);
    dryConvertBuf_.assign(kMaxBlock, 0);
    guideBuf_.assign(kMaxBlock, 0.0f);
    chain_.prepare(48000.0, kMaxBlock);
}

AudioEngine::~AudioEngine() {
    shutdown();
}

bool AudioEngine::initialize() {
    std::lock_guard<std::mutex> lock(streamMutex_);
    if (paInitialized_) return true;
    const PaError err = Pa_Initialize();
    if (err != paNoError) {
        lastError_ = std::string("PortAudio init failed: ") + Pa_GetErrorText(err);
        return false;
    }
    paInitialized_ = true;
    return true;
}

void AudioEngine::shutdown() {
    std::lock_guard<std::mutex> lock(streamMutex_);
    closeMonitorStreamLocked();
    closeStreamLocked();
    if (paInitialized_) {
        Pa_Terminate();
        paInitialized_ = false;
    }
}

std::vector<std::string> AudioEngine::enumerateAsioDevices() const {
    std::lock_guard<std::mutex> lock(streamMutex_);
    std::vector<std::string> list;
    if (!paInitialized_) return list;

    const PaHostApiIndex asioIdx = Pa_HostApiTypeIdToHostApiIndex(paASIO);
    if (asioIdx < 0) return list;

    const PaHostApiInfo* hostInfo = Pa_GetHostApiInfo(asioIdx);
    if (!hostInfo || hostInfo->deviceCount <= 0) return list;

    for (int i = 0; i < hostInfo->deviceCount; ++i) {
        const PaDeviceIndex devIdx = Pa_HostApiDeviceIndexToDeviceIndex(asioIdx, i);
        if (devIdx < 0) continue;
        const PaDeviceInfo* devInfo = Pa_GetDeviceInfo(devIdx);
        if (!devInfo || !devInfo->name) continue;
        if (devInfo->maxInputChannels >= 1 && devInfo->maxOutputChannels >= 1) {
            list.emplace_back(devInfo->name);
        }
    }
    return list;
}

std::vector<int> AudioEngine::legalBufferSizes() const {
    std::lock_guard<std::mutex> lock(streamMutex_);
    std::vector<int> result;
    if (!paInitialized_ || activeDeviceIndex_ == paNoDevice) {
        return result;
    }

    long minBuf = 0, maxBuf = 0, prefBuf = 0, gran = 0;
    if (PaAsio_GetAvailableBufferSizes(activeDeviceIndex_, &minBuf, &maxBuf, &prefBuf, &gran) != paNoError) {
        return result;
    }
    if (minBuf <= 0 || maxBuf < minBuf) {
        return result;
    }

    auto isLegal = [&](long s) -> bool {
        if (s < minBuf || s > maxBuf) return false;
        if (gran == 0) return s == minBuf;
        if (gran == -1) return (s & (s - 1)) == 0;
        if (gran > 0) return ((s - minBuf) % gran) == 0;
        return true;
    };

    constexpr long kPreferredPow2[] = {32, 64, 128, 256, 512, 1024};
    for (long p : kPreferredPow2) {
        if (isLegal(p)) {
            result.push_back(static_cast<int>(p));
        }
    }

    if (result.empty()) {
        if (gran == 0) {
            result.push_back(static_cast<int>(minBuf));
        } else if (gran == -1) {
            for (long p = 1; p <= maxBuf && p > 0 && result.size() < 8; p <<= 1) {
                if (p >= minBuf) {
                    result.push_back(static_cast<int>(p));
                }
                if (p > (1L << 29)) break;
            }
        } else if (gran > 0) {
            for (long s = minBuf; s <= maxBuf && result.size() < 8; s += gran) {
                result.push_back(static_cast<int>(s));
            }
        }
    }

    return result;
}

std::vector<std::pair<std::string, PaDeviceIndex>> AudioEngine::enumerateMonitorDevicesLocked() const {
    std::vector<std::pair<std::string, PaDeviceIndex>> list;
    if (!paInitialized_) return list;

    const PaHostApiIndex wasapiIdx = Pa_HostApiTypeIdToHostApiIndex(paWASAPI);
    if (wasapiIdx < 0) return list;

    const PaHostApiInfo* hostInfo = Pa_GetHostApiInfo(wasapiIdx);
    if (!hostInfo || hostInfo->deviceCount <= 0) return list;

    for (int i = 0; i < hostInfo->deviceCount; ++i) {
        const PaDeviceIndex devIdx = Pa_HostApiDeviceIndexToDeviceIndex(wasapiIdx, i);
        if (devIdx < 0) continue;
        const PaDeviceInfo* devInfo = Pa_GetDeviceInfo(devIdx);
        if (!devInfo || !devInfo->name) continue;
        if (devInfo->maxOutputChannels <= 0) continue;

        const std::string baseName(devInfo->name);
        std::string uniqueName = baseName;
        int suffix = 2;
        while (std::any_of(list.begin(), list.end(),
                           [&uniqueName](const auto& entry) { return entry.first == uniqueName; })) {
            uniqueName = baseName + " (" + std::to_string(suffix++) + ")";
        }
        list.emplace_back(std::move(uniqueName), devIdx);
    }
    return list;
}

std::vector<std::string> AudioEngine::enumerateMonitorOutputs() const {
    std::lock_guard<std::mutex> lock(streamMutex_);
    const auto devices = enumerateMonitorDevicesLocked();
    std::vector<std::string> names;
    names.reserve(devices.size());
    for (const auto& entry : devices) {
        names.push_back(entry.first);
    }
    return names;
}

void AudioEngine::closeMonitorStreamLocked() {
    monitorEnabled_.store(false, std::memory_order_release);
    monitorRunning_.store(false, std::memory_order_release);
    monitorExclusive_.store(false, std::memory_order_release);
    monitorAvgFill_.store(0.0f, std::memory_order_relaxed);
    monAvgFillInit_ = false;
    if (monitorStream_ != nullptr) {
        if (Pa_IsStreamStopped(monitorStream_) == 0) {
            Pa_StopStream(monitorStream_);
        }
        Pa_CloseStream(monitorStream_);
        monitorStream_ = nullptr;
    }
    monitorLatencyMs_ = 0.0;
}

bool AudioEngine::openMonitorStreamLocked() {
    if (monitorName_.empty()) {
        monitorError_.clear();
        return true;
    }
    if (!paInitialized_) {
        monitorError_ = "Couldn't open " + monitorName_ + ": PortAudio not initialized";
        return false;
    }

    PaDeviceIndex targetDev = paNoDevice;
    const auto devices = enumerateMonitorDevicesLocked();
    for (const auto& entry : devices) {
        if (entry.first == monitorName_) {
            targetDev = entry.second;
            break;
        }
    }
    if (targetDev == paNoDevice) {
        monitorError_ = "Couldn't open " + monitorName_ + ": Device not found";
        return false;
    }

    const PaDeviceInfo* devInfo = Pa_GetDeviceInfo(targetDev);
    if (!devInfo || devInfo->maxOutputChannels <= 0) {
        monitorError_ = "Couldn't open " + monitorName_ + ": Invalid output device";
        return false;
    }

    const int outChannels = std::min(2, devInfo->maxOutputChannels);
    const double targetMonRate = (devInfo->defaultSampleRate > 1000.0) ? devInfo->defaultSampleRate : 48000.0;

    float drainTmp[256];
    while (monitorRing_.popBatch(drainTmp, 256) > 0) {
    }

    monResamplerPos_ = 0.0;
    monS0_ = 0.0f;
    monS1_ = 0.0f;
    monRatioAdj_ = 1.0;
    monPrimed_ = false;
    monAvgFillInit_ = false;
    monitorAvgFill_.store(0.0f, std::memory_order_relaxed);
    monitorChannels_ = outChannels;
    monitorRate_ = targetMonRate;
    monitorUnderruns_.store(0, std::memory_order_relaxed);
    monitorResyncs_.store(0, std::memory_order_relaxed);
    monitorOverflows_.store(0, std::memory_order_relaxed);

    PaWasapiStreamInfo wasapiInfo{};
    wasapiInfo.size = sizeof(PaWasapiStreamInfo);
    wasapiInfo.hostApiType = paWASAPI;
    wasapiInfo.version = 1;
    wasapiInfo.flags = paWinWasapiExclusive | paWinWasapiThreadPriority;
    wasapiInfo.threadPriority = eThreadPriorityProAudio;

    PaStreamParameters outParams{};
    outParams.device = targetDev;
    outParams.channelCount = outChannels;
    outParams.sampleFormat = paFloat32;

    PaStream* newStream = nullptr;
    PaError err = paUnanticipatedHostError;
    bool openedExclusive = false;
    double chosenMonRate = targetMonRate;
    std::string fallbackNote;

    if (monitorRequestedExclusive_) {
        double rateCandidates[4]{};
        int numRates = 0;
        auto addRate = [&](double r) {
            if (r <= 1000.0) return;
            for (int i = 0; i < numRates; ++i) {
                if (std::abs(rateCandidates[i] - r) < 1.0) return;
            }
            rateCandidates[numRates++] = r;
        };
        addRate(actualSampleRate_);
        addRate(devInfo->defaultSampleRate);
        addRate(48000.0);
        addRate(44100.0);

        outParams.suggestedLatency = 0.003;
        outParams.hostApiSpecificStreamInfo = &wasapiInfo;

        for (int i = 0; i < numRates; ++i) {
            const double r = rateCandidates[i];
            if (Pa_IsFormatSupported(nullptr, &outParams, r) != paFormatIsSupported) {
                continue;
            }
            PaStream* candidateStream = nullptr;
            const PaError openErr = Pa_OpenStream(
                &candidateStream,
                nullptr,
                &outParams,
                r,
                paFramesPerBufferUnspecified,
                paNoFlag,
                &AudioEngine::paMonitorCallback,
                this
            );
            if (openErr == paNoError && candidateStream != nullptr) {
                newStream = candidateStream;
                err = paNoError;
                openedExclusive = true;
                chosenMonRate = r;
                break;
            }
        }

        if (!newStream) {
            fallbackNote = monitorName_ +
                           " couldn't be opened exclusively (another app may be using it); using shared mode";
        }
    }

    if (!newStream) {
        openedExclusive = false;
        chosenMonRate = targetMonRate;
        outParams.suggestedLatency = devInfo->defaultLowOutputLatency;
        outParams.hostApiSpecificStreamInfo = nullptr;
        err = Pa_OpenStream(
            &newStream,
            nullptr,
            &outParams,
            chosenMonRate,
            paFramesPerBufferUnspecified,
            paNoFlag,
            &AudioEngine::paMonitorCallback,
            this
        );
    }

    if (err != paNoError || !newStream) {
        monitorError_ = "Couldn't open " + monitorName_ + ": " + Pa_GetErrorText(err);
        monitorExclusive_.store(false, std::memory_order_release);
        return false;
    }

    monitorRate_ = chosenMonRate;
    const PaStreamInfo* sInfo = Pa_GetStreamInfo(newStream);
    if (sInfo) {
        if (sInfo->sampleRate > 1.0) {
            monitorRate_ = sInfo->sampleRate;
        }
        monitorLatencyMs_ = sInfo->outputLatency * 1000.0;
    } else {
        monitorLatencyMs_ = (openedExclusive ? 0.003 : devInfo->defaultLowOutputLatency) * 1000.0;
    }

    monitorExclusive_.store(openedExclusive, std::memory_order_release);

    err = Pa_StartStream(newStream);
    if (err != paNoError) {
        monitorError_ = "Couldn't open " + monitorName_ + ": " + Pa_GetErrorText(err);
        monitorExclusive_.store(false, std::memory_order_release);
        Pa_CloseStream(newStream);
        return false;
    }

    monitorStream_ = newStream;
    monitorError_ = std::move(fallbackNote);
    monitorRunning_.store(true, std::memory_order_release);
    monitorEnabled_.store(true, std::memory_order_release);
    return true;
}

bool AudioEngine::setMonitorOutput(const std::string& name, bool exclusive) {
    std::lock_guard<std::mutex> lock(streamMutex_);
    closeMonitorStreamLocked();
    monitorName_ = name;
    monitorRequestedExclusive_ = exclusive;
    monitorError_.clear();

    if (monitorName_.empty()) {
        return true;
    }
    if (!running_.load(std::memory_order_acquire) || stream_ == nullptr) {
        return true;
    }
    return openMonitorStreamLocked();
}

void AudioEngine::closeStreamLocked() {
    running_.store(false, std::memory_order_release);
    if (stream_ != nullptr) {
        if (Pa_IsStreamStopped(stream_) == 0) {
            Pa_StopStream(stream_);
        }
        Pa_CloseStream(stream_);
        stream_ = nullptr;
    }
    activeDeviceIndex_ = paNoDevice;
}

bool AudioEngine::rescanDevices() {
    std::lock_guard<std::mutex> lock(streamMutex_);
    if (stream_ != nullptr && running_.load(std::memory_order_acquire) && streamAlive()) {
        // Fade the output to silence before stopping (a hard stop mid-signal pops): ~10 ms ramp, then wait
        // two buffers so the silent ones reach the interface.
        fadeOut_.store(true, std::memory_order_release);
        const double rate = (actualSampleRate_ > 1.0) ? actualSampleRate_ : 48000.0;
        const int frames = std::max(64, bufferFrames_.load(std::memory_order_relaxed));
        const int waitMs = std::clamp(static_cast<int>(20.0 + 2000.0 * frames / rate), 20, 200);
        std::this_thread::sleep_for(std::chrono::milliseconds(waitMs));
    }
    closeMonitorStreamLocked();
    closeStreamLocked();
    if (paInitialized_) {
        Pa_Terminate();
        paInitialized_ = false;
    }
    rescans_.fetch_add(1, std::memory_order_relaxed);
    const PaError err = Pa_Initialize();
    if (err != paNoError) {
        lastError_ = std::string("PortAudio init failed: ") + Pa_GetErrorText(err);
        return false;
    }
    paInitialized_ = true;
    return true;
}

void AudioEngine::stopStream() {
    std::lock_guard<std::mutex> lock(streamMutex_);
    closeMonitorStreamLocked();
    closeStreamLocked();
}

bool AudioEngine::restart(const std::string& requestedDeviceName, int inputChannel, double sampleRate, int requestedBufferFrames) {
    std::lock_guard<std::mutex> lock(streamMutex_);
    closeMonitorStreamLocked();
    closeStreamLocked();

    requestedBufferFrames_ = (requestedBufferFrames > 0) ? requestedBufferFrames : 0;
    bufferNote_.clear();
    inputChannel_.store(std::clamp(inputChannel, 0, 2), std::memory_order_relaxed);
    const double targetRate = (sampleRate > 1000.0) ? sampleRate : 48000.0;

    if (!paInitialized_) {
        const PaError initErr = Pa_Initialize();
        if (initErr != paNoError) {
            lastError_ = std::string("PortAudio init failed: ") + Pa_GetErrorText(initErr);
            return false;
        }
        paInitialized_ = true;
    }

    const PaHostApiIndex asioIdx = Pa_HostApiTypeIdToHostApiIndex(paASIO);
    if (asioIdx < 0) {
        lastError_ = "no ASIO device";
        return false;
    }

    const PaHostApiInfo* hostInfo = Pa_GetHostApiInfo(asioIdx);
    if (!hostInfo || hostInfo->deviceCount <= 0) {
        lastError_ = "no ASIO device";
        return false;
    }

    PaDeviceIndex chosenDev = paNoDevice;
    PaDeviceIndex motuDev = paNoDevice;
    PaDeviceIndex firstValidDev = paNoDevice;

    for (int i = 0; i < hostInfo->deviceCount; ++i) {
        const PaDeviceIndex devIdx = Pa_HostApiDeviceIndexToDeviceIndex(asioIdx, i);
        if (devIdx < 0) continue;
        const PaDeviceInfo* devInfo = Pa_GetDeviceInfo(devIdx);
        if (!devInfo || !devInfo->name) continue;
        if (devInfo->maxInputChannels < 1 || devInfo->maxOutputChannels < 1) continue;

        if (firstValidDev == paNoDevice) {
            firstValidDev = devIdx;
        }
        if (motuDev == paNoDevice && containsIgnoreCase(devInfo->name, "MOTU")) {
            motuDev = devIdx;
        }
        if (!requestedDeviceName.empty() && requestedDeviceName == devInfo->name) {
            chosenDev = devIdx;
        }
    }

    if (chosenDev == paNoDevice) {
        if (motuDev != paNoDevice) {
            chosenDev = motuDev;
        } else if (hostInfo->defaultInputDevice != paNoDevice) {
            const PaDeviceInfo* defInfo = Pa_GetDeviceInfo(hostInfo->defaultInputDevice);
            if (defInfo && defInfo->hostApi == asioIdx &&
                defInfo->maxInputChannels >= 1 && defInfo->maxOutputChannels >= 1) {
                chosenDev = hostInfo->defaultInputDevice;
            }
        }
        if (chosenDev == paNoDevice) {
            chosenDev = firstValidDev;
        }
    }

    if (chosenDev == paNoDevice) {
        lastError_ = "no ASIO device";
        return false;
    }

    const PaDeviceInfo* devInfo = Pa_GetDeviceInfo(chosenDev);
    if (!devInfo) {
        lastError_ = "no ASIO device";
        return false;
    }

    activeDeviceName_ = devInfo->name ? devInfo->name : "ASIO Device";
    activeInputChannels_ = std::min(2, devInfo->maxInputChannels);
    activeOutputChannels_ = std::min(2, devInfo->maxOutputChannels);

    // Prepare DSP chain and ring buffers before opening stream
    chain_.prepare(targetRate, kMaxBlock);
    workBuf_.assign(kMaxBlock, 0.0f);
    dryConvertBuf_.assign(kMaxBlock, 0);
    guideBuf_.assign(kMaxBlock, 0.0f);
    dryRing_.reset();
    guideRing_.reset();
    seenGuideFlushSeq_ = guideFlushSeq_.load(std::memory_order_acquire);
    guidePrimed_ = false;
    guideHasPrev_ = false;
    guideResamplerPos_ = 0.0;
    guideS0_ = 0.0f;
    guideS1_ = 0.0f;
    guideBufferedMs_.store(0.0f, std::memory_order_relaxed);
    guideUnderruns_.store(0, std::memory_order_relaxed);
    xruns_.store(0, std::memory_order_relaxed);
    streamDrops_.store(0, std::memory_order_relaxed);
    cpuLoad_.store(0.0f, std::memory_order_relaxed);

    long minBuf = 0, maxBuf = 0, prefBuf = 64, gran = 0;
    const bool gotSizes =
        (PaAsio_GetAvailableBufferSizes(chosenDev, &minBuf, &maxBuf, &prefBuf, &gran) == paNoError);
    const long preferred = gotSizes
        ? snapAsioBufferSize(0, minBuf, maxBuf, prefBuf, gran)
        : 64;
    long chosen = gotSizes
        ? snapAsioBufferSize(requestedBufferFrames_, minBuf, maxBuf, prefBuf, gran)
        : ((requestedBufferFrames_ > 0) ? requestedBufferFrames_ : 64);
    if (chosen <= 0) chosen = 64;

    bufferFrames_.store(static_cast<int>(chosen), std::memory_order_relaxed);

    PaStreamParameters inParams{};
    inParams.device = chosenDev;
    inParams.channelCount = activeInputChannels_;
    inParams.sampleFormat = paFloat32 | paNonInterleaved;
    inParams.suggestedLatency = static_cast<double>(chosen) / targetRate;
    inParams.hostApiSpecificStreamInfo = nullptr;

    PaStreamParameters outParams{};
    outParams.device = chosenDev;
    outParams.channelCount = activeOutputChannels_;
    outParams.sampleFormat = paFloat32 | paNonInterleaved;
    outParams.suggestedLatency = static_cast<double>(chosen) / targetRate;
    outParams.hostApiSpecificStreamInfo = nullptr;

    PaStream* newStream = nullptr;
    PaError err = Pa_OpenStream(
        &newStream,
        &inParams,
        &outParams,
        targetRate,
        static_cast<unsigned long>(chosen),
        paNoFlag,
        &AudioEngine::paStreamCallback,
        this
    );

    if ((err != paNoError || !newStream) &&
        requestedBufferFrames_ > 0 && preferred > 0 && preferred != chosen) {
        const long refusedSize = chosen;
        inParams.suggestedLatency = static_cast<double>(preferred) / targetRate;
        outParams.suggestedLatency = static_cast<double>(preferred) / targetRate;
        newStream = nullptr;
        err = Pa_OpenStream(
            &newStream,
            &inParams,
            &outParams,
            targetRate,
            static_cast<unsigned long>(preferred),
            paNoFlag,
            &AudioEngine::paStreamCallback,
            this
        );
        if (err == paNoError && newStream != nullptr) {
            bufferNote_ = "Interface refused " + std::to_string(refusedSize) +
                          " samples; using " + std::to_string(preferred);
            chosen = preferred;
            bufferFrames_.store(static_cast<int>(chosen), std::memory_order_relaxed);
        }
    }

    if (err != paNoError || !newStream) {
        const PaHostErrorInfo* hostErr = Pa_GetLastHostErrorInfo();
        lastError_ = std::string("ASIO open failed: ") + Pa_GetErrorText(err);
        if (hostErr && hostErr->errorText && hostErr->errorText[0] != '\0') {
            lastError_ += std::string(" (") + hostErr->errorText + ")";
        }
        return false;
    }

    const PaStreamInfo* sInfo = Pa_GetStreamInfo(newStream);
    if (sInfo) {
        actualSampleRate_ = (sInfo->sampleRate > 1.0) ? sInfo->sampleRate : targetRate;
        inputLatencyMs_ = sInfo->inputLatency * 1000.0;
        outputLatencyMs_ = sInfo->outputLatency * 1000.0;
    } else {
        actualSampleRate_ = targetRate;
        inputLatencyMs_ = 0.0;
        outputLatencyMs_ = 0.0;
    }

    if (std::abs(actualSampleRate_ - targetRate) > 1.0) {
        chain_.prepare(actualSampleRate_, kMaxBlock);
    }

    fadeOut_.store(false, std::memory_order_relaxed);
    outGain_ = 0.0f;   // fade in: no pop when the stream comes (back) up
    lastCallbackQpc_.store(0, std::memory_order_relaxed);
    err = Pa_StartStream(newStream);
    if (err != paNoError) {
        lastError_ = std::string("ASIO start failed: ") + Pa_GetErrorText(err);
        Pa_CloseStream(newStream);
        return false;
    }

    stream_ = newStream;
    activeDeviceIndex_ = chosenDev;
    lastError_.clear();
    running_.store(true, std::memory_order_release);
    if (!monitorName_.empty()) {
        openMonitorStreamLocked();
    }
    return true;
}

bool AudioEngine::openAsioControlPanel(void* hwnd) {
    std::lock_guard<std::mutex> lock(streamMutex_);
    if (!paInitialized_ || activeDeviceIndex_ == paNoDevice) {
        return false;
    }
    return PaAsio_ShowControlPanel(activeDeviceIndex_, hwnd) == paNoError;
}

void AudioEngine::updatePeakAtomic(std::atomic<float>& target, float val) noexcept {
    float prev = target.load(std::memory_order_relaxed);
    while (val > prev && !target.compare_exchange_weak(prev, val, std::memory_order_relaxed)) {
    }
}

void AudioEngine::setGuideActive(bool active, uint32_t sampleRate) noexcept {
    if (active) {
        if (sampleRate > 0) {
            guideSampleRate_.store(sampleRate, std::memory_order_relaxed);
        }
        guideFlushSeq_.fetch_add(1, std::memory_order_acq_rel);
        guideActive_.store(true, std::memory_order_release);
    } else {
        guideActive_.store(false, std::memory_order_release);
        guideFlushSeq_.fetch_add(1, std::memory_order_acq_rel);
        guideBufferedMs_.store(0.0f, std::memory_order_relaxed);
        if (!running_.load(std::memory_order_acquire)) {
            guideRing_.reset();
        }
    }
}

void AudioEngine::setGuideGain(float gain) noexcept {
    const float clamped = std::clamp(gain, 0.0f, 2.0f);
    guideGain_.store(clamped, std::memory_order_relaxed);
}

void AudioEngine::pushGuide(std::span<const int16_t> samples, uint32_t sampleRate) noexcept {
    if (!guideActive_.load(std::memory_order_acquire) || samples.empty()) {
        return;
    }
    if (sampleRate > 0) {
        guideSampleRate_.store(sampleRate, std::memory_order_relaxed);
    }

    constexpr float kInv32768 = 1.0f / 32768.0f;
    float convBuf[512];
    size_t idx = 0;
    while (idx < samples.size()) {
        const size_t batch = std::min(samples.size() - idx, size_t{512});
        for (size_t i = 0; i < batch; ++i) {
            convBuf[i] = static_cast<float>(samples[idx + i]) * kInv32768;
        }
        const size_t pushed = guideRing_.pushBatch(convBuf, batch);
        if (pushed < batch) {
            break;
        }
        idx += batch;
    }
}

void AudioEngine::fillGuideChunk(int chunk) noexcept {
    const uint32_t flushSeq = guideFlushSeq_.load(std::memory_order_acquire);
    if (flushSeq != seenGuideFlushSeq_) {
        float drainTmp[256];
        while (guideRing_.popBatch(drainTmp, 256) > 0) {
        }
        guidePrimed_ = false;
        guideHasPrev_ = false;
        guideResamplerPos_ = 0.0;
        guideS0_ = 0.0f;
        guideS1_ = 0.0f;
        guideLast_ = 0.0f;
        guideDrift_ = 0.0;
        guideFadeIn_ = 0;
        guideBufferedMs_.store(0.0f, std::memory_order_relaxed);
        seenGuideFlushSeq_ = flushSeq;
    }

    if (!guideActive_.load(std::memory_order_acquire)) {
        std::memset(guideBuf_.data(), 0, static_cast<size_t>(chunk) * sizeof(float));
        guideBufferedMs_.store(0.0f, std::memory_order_relaxed);
        return;
    }

    const double deviceRate = (actualSampleRate_ > 1.0) ? actualSampleRate_ : 48000.0;
    const uint32_t rawGuideRate = guideSampleRate_.load(std::memory_order_relaxed);
    const double guideRate = (rawGuideRate > 1000u) ? static_cast<double>(rawGuideRate) : deviceRate;
    const float gain = guideGain_.load(std::memory_order_relaxed);

    const size_t targetSamples = std::max<size_t>(
        2u, static_cast<size_t>(std::llround((kGuideTargetMs / 1000.0) * guideRate)));
    const size_t maxSamples = targetSamples +
        static_cast<size_t>(std::llround((kGuideMaxExcessMs / 1000.0) * guideRate));

    // On a gap, glide the last sample to silence instead of cutting (a cut is a click).
    auto fadeOutFrom = [&](int start) {
        for (int j = start; j < chunk; ++j) {
            guideLast_ *= 0.94f;
            guideBuf_[j] = guideLast_;
        }
    };

    size_t avail = guideRing_.size();
    if (!guidePrimed_) {
        if (avail < targetSamples) {
            fadeOutFrom(0);
            guideBufferedMs_.store(
                static_cast<float>((static_cast<double>(avail) / guideRate) * 1000.0),
                std::memory_order_relaxed);
            return;
        }
        guidePrimed_ = true;
        guideHasPrev_ = false;
        guideResamplerPos_ = 0.0;
        guideFadeIn_ = 0;
    }

    // A big burst (the page stalled, then caught up): drop back to the target, then fade back in.
    if (avail > maxSamples) {
        size_t toDrop = avail - targetSamples;
        float discard[256];
        while (toDrop > 0) {
            const size_t batch = std::min(toDrop, size_t{256});
            const size_t popped = guideRing_.popBatch(discard, batch);
            if (popped == 0) break;
            toDrop -= popped;
        }
        avail = guideRing_.size();
        guideHasPrev_ = false;
        guideResamplerPos_ = 0.0;
        guideFadeIn_ = 0;
    }

    // The page's audio clock and the interface's clock never run at exactly the same speed. Instead of
    // letting the buffer drain (gap) or overflow (skip), play the guide fractionally faster or slower to hold
    // it at the target: +25 ms of extra buffer -> about 0.1% faster, never more than 0.3% (inaudible).
    const double errMs = (static_cast<double>(avail) - static_cast<double>(targetSamples)) / guideRate * 1000.0;
    const double wantDrift = std::clamp(errMs * 0.00004, -0.003, 0.003);
    guideDrift_ += 0.02 * (wantDrift - guideDrift_);
    const double ratio = (guideRate / deviceRate) * (1.0 + guideDrift_);

    if (!guideHasPrev_) {
        if (!guideRing_.tryPop(guideS0_) || !guideRing_.tryPop(guideS1_)) {
            fadeOutFrom(0);
            guideUnderruns_.fetch_add(1, std::memory_order_relaxed);
            guidePrimed_ = false;
            guideBufferedMs_.store(0.0f, std::memory_order_relaxed);
            return;
        }
        guideHasPrev_ = true;
        guideResamplerPos_ = 0.0;
    }

    for (int i = 0; i < chunk; ++i) {
        while (guideResamplerPos_ >= 1.0) {
            guideS0_ = guideS1_;
            float nextSample = 0.0f;
            if (!guideRing_.tryPop(nextSample)) {
                fadeOutFrom(i);
                guideUnderruns_.fetch_add(1, std::memory_order_relaxed);
                guidePrimed_ = false;
                guideHasPrev_ = false;
                guideResamplerPos_ = 0.0;
                guideBufferedMs_.store(0.0f, std::memory_order_relaxed);
                return;
            }
            guideS1_ = nextSample;
            guideResamplerPos_ -= 1.0;
        }

        const float frac = static_cast<float>(guideResamplerPos_);
        float v = (guideS0_ + (guideS1_ - guideS0_) * frac) * gain;
        if (guideFadeIn_ < kGuideFadeSamples) {
            v *= static_cast<float>(guideFadeIn_) / static_cast<float>(kGuideFadeSamples);
            ++guideFadeIn_;
        }
        guideBuf_[i] = v;
        guideLast_ = v;
        guideResamplerPos_ += ratio;
    }

    const size_t rem = guideRing_.size();
    guideBufferedMs_.store(
        static_cast<float>((static_cast<double>(rem) / guideRate) * 1000.0),
        std::memory_order_relaxed);
}

int AudioEngine::paStreamCallback(const void* input,
                                  void* output,
                                  unsigned long frameCount,
                                  const PaStreamCallbackTimeInfo* /*timeInfo*/,
                                  PaStreamCallbackFlags statusFlags,
                                  void* userData) {
    return static_cast<AudioEngine*>(userData)->handleCallback(input, output, frameCount, statusFlags);
}

int AudioEngine::handleCallback(const void* input,
                                void* output,
                                unsigned long frameCount,
                                PaStreamCallbackFlags statusFlags) noexcept {
    // Flush denormals to zero on the audio thread: NAM's network and the reverb/delay tails decay into tiny
    // numbers that make the CPU crawl (heard as crackle at any buffer size). FTZ (0x8000) + DAZ (0x0040).
    _mm_setcsr(_mm_getcsr() | 0x8040);
    LARGE_INTEGER qpcStart{};
    QueryPerformanceCounter(&qpcStart);
    lastCallbackQpc_.store(qpcStart.QuadPart, std::memory_order_relaxed);

    if ((statusFlags & (paInputOverflow | paOutputUnderflow)) != 0) {
        xruns_.fetch_add(1, std::memory_order_relaxed);
    }

    const int totalFrames = static_cast<int>(frameCount);
    if (totalFrames > 0) {
        bufferFrames_.store(totalFrames, std::memory_order_relaxed);
    }

    const float* const* inCh = static_cast<const float* const*>(input);
    float* const* outCh = static_cast<float* const*>(output);

    if (!outCh || totalFrames <= 0) {
        return paContinue;
    }

    const int chSel = inputChannel_.load(std::memory_order_relaxed);
    const bool isBypass = bypass_.load(std::memory_order_relaxed);
    const bool isMute = mute_.load(std::memory_order_relaxed);

    float blockInPeak = 0.0f;
    float blockOutPeak = 0.0f;

    int offset = 0;
    while (offset < totalFrames) {
        const int chunk = std::min(totalFrames - offset, kMaxBlock);

        // 1. Extract chosen dry input channel
        if (inCh && activeInputChannels_ >= 1 && inCh[0] != nullptr) {
            const float* in0 = inCh[0] + offset;
            const float* in1 = (activeInputChannels_ >= 2 && inCh[1] != nullptr) ? (inCh[1] + offset) : nullptr;

            if (chSel == 1) {
                if (in1) {
                    std::memcpy(workBuf_.data(), in1, static_cast<size_t>(chunk) * sizeof(float));
                } else {
                    std::memset(workBuf_.data(), 0, static_cast<size_t>(chunk) * sizeof(float));
                }
            } else if (chSel == 2 && in1) {
                for (int i = 0; i < chunk; ++i) {
                    workBuf_[i] = in0[i] + in1[i];
                }
            } else {
                std::memcpy(workBuf_.data(), in0, static_cast<size_t>(chunk) * sizeof(float));
            }
        } else {
            std::memset(workBuf_.data(), 0, static_cast<size_t>(chunk) * sizeof(float));
        }

        // 2. Measure input peak and push DRY input as int16 into SPSC ring
        for (int i = 0; i < chunk; ++i) {
            const float s = workBuf_[i];
            const float a = (s < 0.0f) ? -s : s;
            if (a > blockInPeak) blockInPeak = a;

            const float clamped = (s > 1.0f) ? 1.0f : ((s < -1.0f) ? -1.0f : s);
            const int scaled = static_cast<int>(clamped * 32767.0f + (clamped >= 0.0f ? 0.5f : -0.5f));
            dryConvertBuf_[i] = static_cast<int16_t>(std::clamp(scaled, -32768, 32767));
        }

        const size_t pushed = dryRing_.pushBatch(dryConvertBuf_.data(), static_cast<size_t>(chunk));
        if (pushed < static_cast<size_t>(chunk)) {
            streamDrops_.fetch_add(static_cast<uint32_t>(static_cast<size_t>(chunk) - pushed),
                                   std::memory_order_relaxed);
        }

        // 3. Pull guide guitar chunk & process DSP chain (unless muted or bypassed)
        const bool hasGuide = guideActive_.load(std::memory_order_acquire);
        fillGuideChunk(chunk);

        if (isMute) {
            std::memset(workBuf_.data(), 0, static_cast<size_t>(chunk) * sizeof(float));
        } else if (isBypass) {
            if (hasGuide) {
                for (int i = 0; i < chunk; ++i) {
                    workBuf_[i] += guideBuf_[i];
                }
            }
        } else {
            chain_.process(workBuf_.data(), chunk, hasGuide ? guideBuf_.data() : nullptr);
        }

        if (monitorEnabled_.load(std::memory_order_acquire)) {
            const size_t monPushed = monitorRing_.pushBatch(workBuf_.data(), static_cast<size_t>(chunk));
            if (monPushed < static_cast<size_t>(chunk)) {
                monitorOverflows_.fetch_add(static_cast<uint32_t>(static_cast<size_t>(chunk) - monPushed),
                                            std::memory_order_relaxed);
            }
        }

        // 4. Fade in after a (re)start, out before a rescan stops the stream; then write L and R + output peak
        {
            const float target = fadeOut_.load(std::memory_order_relaxed) ? 0.0f : 1.0f;
            if (outGain_ != target || target < 1.0f) {
                const float step = 1.0f / 480.0f;
                for (int i = 0; i < chunk; ++i) {
                    outGain_ = (outGain_ < target) ? std::min(target, outGain_ + step) : std::max(target, outGain_ - step);
                    workBuf_[i] *= outGain_;
                }
            }
        }
        for (int i = 0; i < chunk; ++i) {
            const float y = workBuf_[i];
            const float ay = (y < 0.0f) ? -y : y;
            if (ay > blockOutPeak) blockOutPeak = ay;
        }

        for (int ch = 0; ch < activeOutputChannels_; ++ch) {
            if (outCh[ch] != nullptr) {
                std::memcpy(outCh[ch] + offset, workBuf_.data(), static_cast<size_t>(chunk) * sizeof(float));
            }
        }

        offset += chunk;
    }

    updatePeakAtomic(inPeakLin_, blockInPeak);
    updatePeakAtomic(outPeakLin_, blockOutPeak);
    if (blockOutPeak >= 0.999f) {
        clipLatched_.store(true, std::memory_order_relaxed);
    }

    LARGE_INTEGER qpcEnd{};
    QueryPerformanceCounter(&qpcEnd);
    if (invQpcFreq_ > 0.0 && actualSampleRate_ > 1.0 && totalFrames > 0) {
        const double elapsedSec = static_cast<double>(qpcEnd.QuadPart - qpcStart.QuadPart) * invQpcFreq_;
        const double budgetSec = static_cast<double>(totalFrames) / actualSampleRate_;
        const float load = static_cast<float>(elapsedSec / budgetSec);
        const float prevCpu = cpuLoad_.load(std::memory_order_relaxed);
        cpuLoad_.store(prevCpu + 0.2f * (load - prevCpu), std::memory_order_relaxed);
    }

    return paContinue;
}

int AudioEngine::paMonitorCallback(const void* /*input*/,
                                   void* output,
                                   unsigned long frameCount,
                                   const PaStreamCallbackTimeInfo* /*timeInfo*/,
                                   PaStreamCallbackFlags /*statusFlags*/,
                                   void* userData) {
    return static_cast<AudioEngine*>(userData)->handleMonitorCallback(output, frameCount);
}

int AudioEngine::handleMonitorCallback(void* output, unsigned long frameCount) noexcept {
    _mm_setcsr(_mm_getcsr() | 0x8040);  // see handleCallback
    float* out = static_cast<float*>(output);
    const int channels = monitorChannels_;
    if (!out || frameCount == 0 || channels <= 0) {
        return paContinue;
    }

    const size_t totalSamples = static_cast<size_t>(frameCount) * static_cast<size_t>(channels);
    const double asioRate = (actualSampleRate_ > 1.0) ? actualSampleRate_ : 48000.0;
    const double monRate = (monitorRate_ > 1.0) ? monitorRate_ : 48000.0;
    const double baseStep = asioRate / monRate;

    const int asioBuf = std::max(1, bufferFrames_.load(std::memory_order_relaxed));
    const bool exclusive = monitorExclusive_.load(std::memory_order_relaxed);
    const double slackSec = exclusive ? 0.0015 : 0.003;
    const double target = static_cast<double>(asioBuf) + static_cast<double>(frameCount) * baseStep +
                          slackSec * asioRate;
    const size_t fill = monitorRing_.size();

    if (!monPrimed_) {
        if (static_cast<double>(fill) < target) {
            std::memset(out, 0, totalSamples * sizeof(float));
            return paContinue;
        }
        monPrimed_ = true;
        monitorAvgFill_.store(static_cast<float>(fill), std::memory_order_relaxed);
        monAvgFillInit_ = true;
    } else {
        const float fillF = static_cast<float>(fill);
        if (!monAvgFillInit_) {
            monitorAvgFill_.store(fillF, std::memory_order_relaxed);
            monAvgFillInit_ = true;
        } else {
            const float prevFill = monitorAvgFill_.load(std::memory_order_relaxed);
            monitorAvgFill_.store(prevFill + 0.05f * (fillF - prevFill), std::memory_order_relaxed);
        }
    }

    double err = (target > 0.0) ? ((static_cast<double>(fill) - target) / target) : 0.0;
    err = std::clamp(err, -1.0, 1.0);
    monRatioAdj_ = std::clamp(monRatioAdj_ + 0.0005 * err, 0.995, 1.005);
    const double step = baseStep * monRatioAdj_;

    if (static_cast<double>(fill) > 4.0 * target) {
        const size_t targetSamples = static_cast<size_t>(target);
        size_t toDiscard = (fill > targetSamples) ? (fill - targetSamples) : 0;
        float discardBuf[256];
        while (toDiscard > 0) {
            const size_t batch = std::min(toDiscard, size_t{256});
            const size_t popped = monitorRing_.popBatch(discardBuf, batch);
            if (popped == 0) break;
            toDiscard -= popped;
        }
        monitorResyncs_.fetch_add(1, std::memory_order_relaxed);
    }

    for (unsigned long f = 0; f < frameCount; ++f) {
        monResamplerPos_ += step;
        while (monResamplerPos_ >= 1.0) {
            monS0_ = monS1_;
            float nextSample = 0.0f;
            if (!monitorRing_.tryPop(nextSample)) {
                monitorUnderruns_.fetch_add(1, std::memory_order_relaxed);
                monPrimed_ = false;
                monAvgFillInit_ = false;
                const size_t writtenSamples = static_cast<size_t>(f) * static_cast<size_t>(channels);
                std::memset(out + writtenSamples, 0, (totalSamples - writtenSamples) * sizeof(float));
                return paContinue;
            }
            monS1_ = nextSample;
            monResamplerPos_ -= 1.0;
        }

        const float sampleOut = monS0_ + (monS1_ - monS0_) * static_cast<float>(monResamplerPos_);
        const size_t baseIdx = static_cast<size_t>(f) * static_cast<size_t>(channels);
        for (int ch = 0; ch < channels; ++ch) {
            out[baseIdx + static_cast<size_t>(ch)] = sampleOut;
        }
    }

    return paContinue;
}

bool AudioEngine::streamAlive() const noexcept {
    // Callbacks stop when the interface disappears (unplugged) even though PortAudio still holds the stream.
    const int64_t last = lastCallbackQpc_.load(std::memory_order_relaxed);
    if (!running_.load(std::memory_order_acquire)) return false;
    if (last == 0 || invQpcFreq_ <= 0.0) return true;   // just started: give it the benefit of the doubt
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    return static_cast<double>(now.QuadPart - last) * invQpcFreq_ < 0.5;
}

AudioStatus AudioEngine::getStatus() {
    AudioStatus st;
    st.bufferFrames = bufferFrames_.load(std::memory_order_relaxed);
    st.monitorRunning = monitorRunning_.load(std::memory_order_acquire);
    st.monitorExclusive = monitorExclusive_.load(std::memory_order_acquire);
    st.monitorUnderruns = monitorUnderruns_.load(std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lock(streamMutex_);
        st.running = running_.load(std::memory_order_acquire);
        st.device = activeDeviceName_;
        st.sampleRate = actualSampleRate_;
        st.requestedBufferFrames = requestedBufferFrames_;
        st.bufferNote = bufferNote_;
        st.inputMs = inputLatencyMs_;
        st.outputMs = outputLatencyMs_;
        st.roundTripMs = inputLatencyMs_ + outputLatencyMs_;
        st.lastError = lastError_;
        st.monitorOutput = monitorName_;
        st.monitorError = monitorError_;
        if (st.monitorRunning && actualSampleRate_ > 1.0) {
            const int asioBuf = std::max(1, st.bufferFrames);
            const double avgFillSamples = static_cast<double>(monitorAvgFill_.load(std::memory_order_relaxed));
            const double avgFillMs = (avgFillSamples / actualSampleRate_) * 1000.0;
            const double asioInputBufMs = (static_cast<double>(asioBuf) / actualSampleRate_) * 1000.0;
            st.monitorLatencyMs = monitorLatencyMs_ + avgFillMs + asioInputBufMs;
        } else {
            st.monitorLatencyMs = 0.0;
        }
        st.guideLatencyMs = kGuideTargetMs + outputLatencyMs_;
    }

    st.guideActive = guideActive_.load(std::memory_order_acquire);
    st.guideBufferedMs = st.guideActive ? guideBufferedMs_.load(std::memory_order_relaxed) : 0.0f;
    st.guideUnderruns = guideUnderruns_.load(std::memory_order_relaxed);

    const float inPk = inPeakLin_.exchange(0.0f, std::memory_order_relaxed);
    const float outPk = outPeakLin_.exchange(0.0f, std::memory_order_relaxed);
    st.inPeakDb = linToDbfs(inPk);
    st.outPeakDb = linToDbfs(outPk);
    st.clip = clipLatched_.exchange(false, std::memory_order_relaxed);
    st.cpu = cpuLoad_.load(std::memory_order_relaxed);
    st.xruns = xruns_.load(std::memory_order_relaxed);
    st.bypass = bypass_.load(std::memory_order_relaxed);
    st.mute = mute_.load(std::memory_order_relaxed);
    st.streamDrops = streamDrops_.load(std::memory_order_relaxed);
    st.inputChannel = inputChannel_.load(std::memory_order_relaxed);
    return st;
}

} // namespace wsamp
