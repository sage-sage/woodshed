#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include "dsp/chain.h"
#include "portaudio.h"
#include "spsc.h"

namespace wsamp {

struct AudioStatus {
    bool running = false;
    std::string device;
    double sampleRate = 48000.0;
    int bufferFrames = 64;
    int requestedBufferFrames = 0;
    std::string bufferNote;
    double inputMs = 0.0;
    double outputMs = 0.0;
    double roundTripMs = 0.0;
    float inPeakDb = -120.0f;
    float outPeakDb = -120.0f;
    bool clip = false;
    float cpu = 0.0f;
    uint32_t xruns = 0;
    bool bypass = false;
    bool mute = false;
    uint32_t streamDrops = 0;
    int inputChannel = 0;
    std::string lastError;
    std::string monitorOutput;
    bool monitorExclusive = false;
    bool monitorRunning = false;
    double monitorLatencyMs = 0.0;
    uint32_t monitorUnderruns = 0;
    std::string monitorError;
    bool guideActive = false;
    float guideBufferedMs = 0.0f;
    uint32_t guideUnderruns = 0;
    double guideLatencyMs = 30.0;
};

class AudioEngine {
public:
    static constexpr int kMaxBlock = 4096;
    static constexpr size_t kDryRingCapacity = 32768;
    static constexpr size_t kMonitorRingCapacity = 16384;
    static constexpr size_t kGuideRingCapacity = 131072; // >1 s at 96 kHz (power of two)
    static constexpr double kGuideTargetMs = 30.0;
    static constexpr double kGuideMaxExcessMs = 120.0;

    AudioEngine();
    ~AudioEngine();

    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    // Initializes PortAudio (must be called off the audio thread).
    bool initialize();
    void shutdown();

    // Enumerates all available ASIO devices.
    std::vector<std::string> enumerateAsioDevices() const;

    // Returns legal ASIO buffer sizes for the active device (up to 8 entries, powers of two preferred).
    std::vector<int> legalBufferSizes() const;

    // Enumerates all available WASAPI output devices for secondary monitoring.
    std::vector<std::string> enumerateMonitorOutputs() const;

    // Opens or closes the secondary WASAPI monitor output stream off the audio thread.
    bool setMonitorOutput(const std::string& name, bool exclusive = false);

    // Starts or restarts the ASIO stream off the audio thread.
    // Device selection priority: requestedDeviceName -> first containing "MOTU" -> ASIO default.
    bool restart(const std::string& requestedDeviceName, int inputChannel, double sampleRate, int requestedBufferFrames = 0);
    void stopStream();

    // Opens the ASIO driver control panel for the active device.
    bool openAsioControlPanel(void* hwnd = nullptr);

    // Real-time safe parameter atomics
    void setInputChannel(int ch) noexcept { inputChannel_.store(ch, std::memory_order_relaxed); }
    int inputChannel() const noexcept { return inputChannel_.load(std::memory_order_relaxed); }

    void setBypass(bool on) noexcept { bypass_.store(on, std::memory_order_relaxed); }
    bool bypass() const noexcept { return bypass_.load(std::memory_order_relaxed); }

    void setMute(bool on) noexcept { mute_.store(on, std::memory_order_relaxed); }
    bool mute() const noexcept { return mute_.load(std::memory_order_relaxed); }

    bool isRunning() const noexcept { return running_.load(std::memory_order_acquire); }

    // Access to the DSP chain (caller only calls loadNam/loadIr/prepare off audio thread).
    dsp::Chain& chain() noexcept { return chain_; }
    const dsp::Chain& chain() const noexcept { return chain_; }

    // Consumer side of SPSC dry int16 ring (called by AppController thread every ~5 ms).
    size_t drainDrySamples(int16_t* out, size_t maxSamples) noexcept {
        return dryRing_.popBatch(out, maxSamples);
    }

    // Guide guitar stream controls & lock-free single-producer input (called from WsServer thread).
    void setGuideActive(bool active, uint32_t sampleRate = 48000) noexcept;
    bool isGuideActive() const noexcept { return guideActive_.load(std::memory_order_acquire); }
    void setGuideGain(float gain) noexcept;
    float guideGain() const noexcept { return guideGain_.load(std::memory_order_relaxed); }
    void pushGuide(std::span<const int16_t> samples, uint32_t sampleRate) noexcept;

    // Snapshot of telemetry & resets interval peak/clip trackers.
    AudioStatus getStatus();

private:
    static int paStreamCallback(const void* input,
                                void* output,
                                unsigned long frameCount,
                                const PaStreamCallbackTimeInfo* timeInfo,
                                PaStreamCallbackFlags statusFlags,
                                void* userData);

    int handleCallback(const void* input,
                       void* output,
                       unsigned long frameCount,
                       PaStreamCallbackFlags statusFlags) noexcept;

    static int paMonitorCallback(const void* input,
                                 void* output,
                                 unsigned long frameCount,
                                 const PaStreamCallbackTimeInfo* timeInfo,
                                 PaStreamCallbackFlags statusFlags,
                                 void* userData);

    int handleMonitorCallback(void* output, unsigned long frameCount) noexcept;

    std::vector<std::pair<std::string, PaDeviceIndex>> enumerateMonitorDevicesLocked() const;
    bool openMonitorStreamLocked();
    void closeMonitorStreamLocked();
    void closeStreamLocked();
    void updatePeakAtomic(std::atomic<float>& target, float val) noexcept;

    mutable std::mutex streamMutex_;
    bool paInitialized_ = false;
    PaStream* stream_ = nullptr;
    PaDeviceIndex activeDeviceIndex_ = paNoDevice;
    int activeInputChannels_ = 2;
    int activeOutputChannels_ = 2;

    std::string activeDeviceName_;
    std::string lastError_;
    std::string bufferNote_;
    int requestedBufferFrames_ = 0;
    double actualSampleRate_ = 48000.0;
    double inputLatencyMs_ = 0.0;
    double outputLatencyMs_ = 0.0;

    std::atomic<bool> running_{false};
    std::atomic<int> inputChannel_{0};
    std::atomic<bool> bypass_{false};
    std::atomic<bool> mute_{false};
    std::atomic<int> bufferFrames_{64};

    std::atomic<float> inPeakLin_{0.0f};
    std::atomic<float> outPeakLin_{0.0f};
    std::atomic<bool> clipLatched_{false};
    std::atomic<float> cpuLoad_{0.0f};
    std::atomic<uint32_t> xruns_{0};
    std::atomic<uint32_t> streamDrops_{0};

    double invQpcFreq_ = 0.0;
    dsp::Chain chain_;
    std::vector<float> workBuf_;
    std::vector<int16_t> dryConvertBuf_;
    SpscRing<int16_t, kDryRingCapacity> dryRing_;

    PaStream* monitorStream_ = nullptr;
    std::string monitorName_;
    std::string monitorError_;
    bool monitorRequestedExclusive_ = false;
    double monitorRate_ = 48000.0;
    double monitorLatencyMs_ = 0.0;
    int monitorChannels_ = 2;
    std::atomic<bool> monitorExclusive_{false};
    std::atomic<bool> monitorEnabled_{false};
    std::atomic<bool> monitorRunning_{false};
    std::atomic<float> monitorAvgFill_{0.0f};
    std::atomic<uint32_t> monitorOverflows_{0};
    std::atomic<uint32_t> monitorUnderruns_{0};
    std::atomic<uint32_t> monitorResyncs_{0};

    double monResamplerPos_ = 0.0;
    float monS0_ = 0.0f;
    float monS1_ = 0.0f;
    double monRatioAdj_ = 1.0;
    bool monPrimed_ = false;
    bool monAvgFillInit_ = false;
    SpscRing<float, kMonitorRingCapacity> monitorRing_;

    void fillGuideChunk(int chunk) noexcept;

    std::atomic<bool> guideActive_{false};
    std::atomic<uint32_t> guideSampleRate_{48000};
    std::atomic<float> guideGain_{1.0f};
    std::atomic<uint32_t> guideFlushSeq_{0};
    std::atomic<float> guideBufferedMs_{0.0f};
    std::atomic<uint32_t> guideUnderruns_{0};

    uint32_t seenGuideFlushSeq_ = 0;
    bool guidePrimed_ = false;
    bool guideHasPrev_ = false;
    double guideResamplerPos_ = 0.0;
    float guideS0_ = 0.0f;
    float guideS1_ = 0.0f;
    std::vector<float> guideBuf_;
    SpscRing<float, kGuideRingCapacity> guideRing_;
};

} // namespace wsamp
