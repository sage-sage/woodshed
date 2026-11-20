#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

#include "audio_engine.h"
#include "dsp/board.h"
#include "presets.h"
#include "ws_server.h"

namespace wsamp {

struct AppSettings {
    std::string device;
    int inputChannel = 0;
    double sampleRate = 48000.0;
    int bufferFrames = 64;
    std::string lastPreset = "crunch";
    bool startWithWindows = false;
    std::string monitorOutput;
    bool monitorExclusive = false;
};

struct TrayStateSnapshot {
    bool running = false;
    std::string device;
    double roundTripMs = 0.0;
    bool bypass = false;
    bool mute = false;
    int inputChannel = 0;
    bool startWithWindows = false;
    std::string currentPresetId = "crunch";
    std::string currentPresetName = "Crunch";
    std::string lastError;
    std::vector<std::pair<std::string, std::string>> presetIdAndNames;
};

class AppController : public IWsMessageHandler {
public:
    using BalloonCallback = std::function<void(const std::string& title, const std::string& message, bool isError)>;

    AppController();
    ~AppController() override;

    AppController(const AppController&) = delete;
    AppController& operator=(const AppController&) = delete;

    void setMainWindowHandle(void* hwnd) noexcept { mainHwnd_.store(hwnd, std::memory_order_relaxed); }
    void setBalloonCallback(BalloonCallback cb);

    bool start();
    void stop();

    // Thread-safe commands callable from Win32 Tray thread
    void enqueueSelectPreset(const std::string& presetId);
    void enqueueSetInputChannel(int channel);
    void enqueueToggleBypass();
    void enqueueToggleMute();
    void enqueueOpenAsioPanel();
    // force=false (Windows reported a device change): only when no stream is running. force=true: stop and rescan.
    void enqueueRescanDevices(bool force);
    void enqueueSetStartWithWindows(bool enabled);

    TrayStateSnapshot getTraySnapshot() const;

    // IWsMessageHandler overrides (called on WsServer thread; push to command queue / lock-free ring)
    void onClientConnected(uint32_t clientId) override;
    void onClientDisconnected(uint32_t clientId) override;
    void onClientTextMessage(uint32_t clientId, std::string_view text) override;
    void onClientBinaryMessage(uint32_t clientId, std::span<const uint8_t> data) override;

private:
    enum class CmdType {
        WsText,
        SelectPreset,
        SetInputChannel,
        ToggleBypass,
        ToggleMute,
        OpenAsioPanel,
        SetStartWithWindows,
        BrowseCompleted,
        RescanDevices
    };

    struct Command {
        CmdType type = CmdType::WsText;
        uint32_t clientId = 0;
        std::string text;
        std::string presetId;
        std::string kind;
        std::string uid;
        int intVal = 0;
        bool boolVal = false;
    };

    static std::filesystem::path defaultSettingsPath();
    void loadSettings();
    void saveSettingsAtomic() const;
    void syncStartupRegistry(bool enabled) const;

    void controllerLoop();
    void handleCommand(const Command& cmd);
    void handleWsJson(uint32_t clientId, const std::string& text);

    void buildAndInstallBoard(const Preset& preset, bool reloadFiles, uint32_t targetClientId = 0);
    void launchBrowseDialogAsync(uint32_t clientId, const std::string& presetId, const std::string& kind, const std::string& uid);

    void markPresetsDirty();
    void savePresetsNow();

    std::string buildHelloJson() const;
    std::string buildPresetsJson() const;
    std::string buildDevicesJson() const;
    std::string buildStatusJson(const AudioStatus& st) const;
    std::string buildErrorJson(const std::string& msg) const;

    void refreshTraySnapshot(const AudioStatus& st);

    AudioEngine audioEngine_;
    WsServer wsServer_;
    PresetBank presetBank_;
    AppSettings settings_;
    std::string currentPresetId_ = "crunch";

    std::unordered_map<std::string, std::shared_ptr<dsp::Block>> liveBlocks_;
    std::unordered_map<std::string, std::string> loadedBlockFiles_;
    std::unordered_map<std::string, std::string> blockLoadErrors_;

    bool presetsDirty_ = false;
    std::chrono::steady_clock::time_point lastPresetDirtyTime_{};

    std::atomic<void*> mainHwnd_{nullptr};
    std::atomic<bool> running_{false};
    std::thread controllerThread_;

    mutable std::mutex cmdMutex_;
    std::condition_variable cmdCv_;
    std::deque<Command> cmdQueue_;

    mutable std::mutex snapshotMutex_;
    TrayStateSnapshot traySnapshot_;

    mutable std::mutex balloonMutex_;
    BalloonCallback balloonCb_;
    std::string lastNotifiedError_;

    uint32_t runningFrameIndex_ = 0;
    std::vector<int16_t> spscDrainBuf_;

    std::atomic<uint32_t> guideClientId_{0};
    std::vector<int16_t> guideDecodeBuf_;

    std::atomic<bool> browseDialogOpen_{false};
    std::mutex dialogThreadsMutex_;
    std::vector<std::thread> dialogThreads_;
};

} // namespace wsamp
