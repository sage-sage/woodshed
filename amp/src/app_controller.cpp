#include <winsock2.h>
#include <windows.h>
#include <commdlg.h>

#include "app_controller.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>

#include "json.hpp"
#include "version.h"

namespace wsamp {

namespace {

using json = nlohmann::json;

std::wstring utf8ToWide(std::string_view utf8) {
    if (utf8.empty()) return {};
    const int needed = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (needed <= 0) return {};
    std::wstring out(static_cast<size_t>(needed), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), needed);
    return out;
}

std::string wideToUtf8(std::wstring_view wide) {
    if (wide.empty()) return {};
    const int needed = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()),
                                           nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return {};
    std::string out(static_cast<size_t>(needed), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()),
                        out.data(), needed, nullptr, nullptr);
    return out;
}

std::string characterToStr(dsp::AmpCharacter c) {
    switch (c) {
        case dsp::AmpCharacter::Clean: return "Clean";
        case dsp::AmpCharacter::Breakup: return "Breakup";
        case dsp::AmpCharacter::Crunch: return "Crunch";
        case dsp::AmpCharacter::HighGain: return "HighGain";
        case dsp::AmpCharacter::Fuzz: return "Fuzz";
    }
    return "Clean";
}

dsp::AmpCharacter parseCharacter(const json& v, dsp::AmpCharacter fallback) {
    if (v.is_string()) {
        const std::string s = v.get<std::string>();
        if (s == "Clean" || s == "clean") return dsp::AmpCharacter::Clean;
        if (s == "Breakup" || s == "breakup") return dsp::AmpCharacter::Breakup;
        if (s == "Crunch" || s == "crunch") return dsp::AmpCharacter::Crunch;
        if (s == "HighGain" || s == "high_gain" || s == "highgain") return dsp::AmpCharacter::HighGain;
        if (s == "Fuzz" || s == "fuzz") return dsp::AmpCharacter::Fuzz;
    } else if (v.is_number_integer()) {
        const int idx = std::clamp(v.get<int>(), 0, 4);
        return static_cast<dsp::AmpCharacter>(idx);
    }
    return fallback;
}

std::string cabToStr(dsp::CabType c) {
    switch (c) {
        case dsp::CabType::C412: return "C412";
        case dsp::CabType::O212: return "O212";
        case dsp::CabType::O112: return "O112";
        case dsp::CabType::Acoustic: return "Acoustic";
        case dsp::CabType::Bass: return "Bass";
    }
    return "C412";
}

dsp::CabType parseCab(const json& v, dsp::CabType fallback) {
    if (v.is_string()) {
        const std::string s = v.get<std::string>();
        if (s == "C412" || s == "c412") return dsp::CabType::C412;
        if (s == "O212" || s == "o212") return dsp::CabType::O212;
        if (s == "O112" || s == "o112") return dsp::CabType::O112;
        if (s == "Acoustic" || s == "acoustic") return dsp::CabType::Acoustic;
        if (s == "Bass" || s == "bass") return dsp::CabType::Bass;
    } else if (v.is_number_integer()) {
        const int idx = std::clamp(v.get<int>(), 0, 4);
        return static_cast<dsp::CabType>(idx);
    }
    return fallback;
}

double round1(double v) noexcept {
    return std::round(v * 10.0) / 10.0;
}

double round3(double v) noexcept {
    return std::round(v * 1000.0) / 1000.0;
}

} // namespace

AppController::AppController()
    : wsServer_(*this, WsServer::kDefaultPort),
      spscDrainBuf_(AudioEngine::kDryRingCapacity, 0) {
}

AppController::~AppController() {
    stop();
}

void AppController::setBalloonCallback(BalloonCallback cb) {
    std::lock_guard<std::mutex> lock(balloonMutex_);
    balloonCb_ = std::move(cb);
}

std::filesystem::path AppController::defaultSettingsPath() {
    if (const char* appData = std::getenv("APPDATA"); appData != nullptr && appData[0] != '\0') {
        return std::filesystem::path(appData) / "WoodshedAmp" / "settings.json";
    }
    return std::filesystem::path("settings.json");
}

void AppController::loadSettings() {
    settings_ = AppSettings{};
    const std::filesystem::path path = defaultSettingsPath();
    std::error_code ec;
    if (!std::filesystem::exists(path, ec)) return;

    std::ifstream in(path);
    if (!in) return;

    try {
        json j;
        in >> j;
        if (!j.is_object()) return;
        if (j.contains("device") && j["device"].is_string()) {
            settings_.device = j["device"].get<std::string>();
        }
        if (j.contains("inputChannel") && j["inputChannel"].is_number_integer()) {
            settings_.inputChannel = std::clamp(j["inputChannel"].get<int>(), 0, 2);
        }
        if (j.contains("sampleRate") && j["sampleRate"].is_number()) {
            const double sr = j["sampleRate"].get<double>();
            if (sr >= 8000.0 && sr <= 384000.0) {
                settings_.sampleRate = sr;
            }
        }
        if (j.contains("bufferFrames") && j["bufferFrames"].is_number_integer()) {
            const int bf = j["bufferFrames"].get<int>();
            if (bf == 0 || (bf >= 16 && bf <= 2048)) {
                settings_.bufferFrames = bf;
            }
        }
        if (j.contains("preset") && j["preset"].is_string()) {
            settings_.lastPreset = j["preset"].get<std::string>();
        }
        if (j.contains("startWithWindows") && j["startWithWindows"].is_boolean()) {
            settings_.startWithWindows = j["startWithWindows"].get<bool>();
        }
        if (j.contains("monitorOutput") && j["monitorOutput"].is_string()) {
            settings_.monitorOutput = j["monitorOutput"].get<std::string>();
        }
        if (j.contains("monitorExclusive") && j["monitorExclusive"].is_boolean()) {
            settings_.monitorExclusive = j["monitorExclusive"].get<bool>();
        }
    } catch (...) {
    }
}

void AppController::saveSettingsAtomic() const {
    const std::filesystem::path path = defaultSettingsPath();
    std::error_code ec;
    if (!path.parent_path().empty()) {
        std::filesystem::create_directories(path.parent_path(), ec);
    }

    json j = json::object();
    j["device"] = settings_.device;
    j["inputChannel"] = settings_.inputChannel;
    j["sampleRate"] = settings_.sampleRate;
    j["bufferFrames"] = settings_.bufferFrames;
    j["preset"] = currentPresetId_;
    j["startWithWindows"] = settings_.startWithWindows;
    j["monitorOutput"] = settings_.monitorOutput;
    j["monitorExclusive"] = settings_.monitorExclusive;

    std::filesystem::path tmpPath = path;
    tmpPath += ".tmp";
    {
        std::ofstream out(tmpPath, std::ios::binary | std::ios::trunc);
        if (!out) return;
        out << j.dump(2) << '\n';
        out.flush();
        if (!out) return;
    }

    if (!MoveFileExW(tmpPath.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        std::filesystem::remove(tmpPath, ec);
    }
}

void AppController::syncStartupRegistry(bool enabled) const {
    HKEY hKey = nullptr;
    constexpr wchar_t kRunSubKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    constexpr wchar_t kValueName[] = L"WoodshedAmp";

    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunSubKey, 0, KEY_SET_VALUE, &hKey) != ERROR_SUCCESS) {
        return;
    }

    if (enabled) {
        wchar_t exePath[MAX_PATH]{};
        const DWORD len = GetModuleFileNameW(nullptr, exePath, MAX_PATH);
        if (len > 0 && len < MAX_PATH) {
            std::wstring quoted = L"\"";
            quoted.append(exePath, len);
            quoted.push_back(L'"');
            const DWORD bytes = static_cast<DWORD>((quoted.size() + 1) * sizeof(wchar_t));
            RegSetValueExW(hKey, kValueName, 0, REG_SZ,
                           reinterpret_cast<const BYTE*>(quoted.c_str()), bytes);
        }
    } else {
        RegDeleteValueW(hKey, kValueName);
    }

    RegCloseKey(hKey);
}

bool AppController::start() {
    if (running_.load(std::memory_order_acquire)) return true;

    loadSettings();
    syncStartupRegistry(settings_.startWithWindows);

    std::string err;
    presetBank_.loadOverrides(PresetBank::defaultPresetsPath(), err);

    if (presetBank_.findById(settings_.lastPreset) != nullptr) {
        currentPresetId_ = settings_.lastPreset;
    } else {
        currentPresetId_ = "crunch";
    }

    audioEngine_.initialize();
    const bool audioOk = audioEngine_.restart(settings_.device, settings_.inputChannel, settings_.sampleRate, settings_.bufferFrames);
    audioEngine_.setMonitorOutput(settings_.monitorOutput, settings_.monitorExclusive);

    if (const Preset* activePreset = presetBank_.findById(currentPresetId_)) {
        applyPresetToChain(*activePreset, true);
    }

    const AudioStatus initSt = audioEngine_.getStatus();
    if (audioOk && !initSt.device.empty() && settings_.device != initSt.device) {
        settings_.device = initSt.device;
        saveSettingsAtomic();
    }
    refreshTraySnapshot(initSt);

    if (!audioOk && !initSt.lastError.empty()) {
        lastNotifiedError_ = initSt.lastError;
        std::lock_guard<std::mutex> lock(balloonMutex_);
        if (balloonCb_) {
            balloonCb_("Woodshed Amp", initSt.lastError, true);
        }
    }

    wsServer_.start();

    running_.store(true, std::memory_order_release);
    controllerThread_ = std::thread(&AppController::controllerLoop, this);
    return true;
}

void AppController::stop() {
    if (!running_.exchange(false, std::memory_order_acq_rel)) {
        return;
    }
    cmdCv_.notify_all();
    if (controllerThread_.joinable()) {
        controllerThread_.join();
    }

    wsServer_.stop();
    audioEngine_.shutdown();

    std::lock_guard<std::mutex> lock(dialogThreadsMutex_);
    for (auto& t : dialogThreads_) {
        if (t.joinable()) {
            t.join();
        }
    }
    dialogThreads_.clear();
}

void AppController::enqueueSelectPreset(const std::string& presetId) {
    {
        std::lock_guard<std::mutex> lock(cmdMutex_);
        Command cmd;
        cmd.type = CmdType::SelectPreset;
        cmd.presetId = presetId;
        cmdQueue_.push_back(std::move(cmd));
    }
    cmdCv_.notify_one();
}

void AppController::enqueueSetInputChannel(int channel) {
    {
        std::lock_guard<std::mutex> lock(cmdMutex_);
        Command cmd;
        cmd.type = CmdType::SetInputChannel;
        cmd.intVal = channel;
        cmdQueue_.push_back(std::move(cmd));
    }
    cmdCv_.notify_one();
}

void AppController::enqueueToggleBypass() {
    {
        std::lock_guard<std::mutex> lock(cmdMutex_);
        Command cmd;
        cmd.type = CmdType::ToggleBypass;
        cmdQueue_.push_back(std::move(cmd));
    }
    cmdCv_.notify_one();
}

void AppController::enqueueToggleMute() {
    {
        std::lock_guard<std::mutex> lock(cmdMutex_);
        Command cmd;
        cmd.type = CmdType::ToggleMute;
        cmdQueue_.push_back(std::move(cmd));
    }
    cmdCv_.notify_one();
}

void AppController::enqueueOpenAsioPanel() {
    {
        std::lock_guard<std::mutex> lock(cmdMutex_);
        Command cmd;
        cmd.type = CmdType::OpenAsioPanel;
        cmdQueue_.push_back(std::move(cmd));
    }
    cmdCv_.notify_one();
}

void AppController::enqueueSetStartWithWindows(bool enabled) {
    {
        std::lock_guard<std::mutex> lock(cmdMutex_);
        Command cmd;
        cmd.type = CmdType::SetStartWithWindows;
        cmd.boolVal = enabled;
        cmdQueue_.push_back(std::move(cmd));
    }
    cmdCv_.notify_one();
}

void AppController::onClientConnected(uint32_t /*clientId*/) {
}

void AppController::onClientDisconnected(uint32_t /*clientId*/) {
}

void AppController::onClientTextMessage(uint32_t clientId, std::string_view text) {
    {
        std::lock_guard<std::mutex> lock(cmdMutex_);
        Command cmd;
        cmd.type = CmdType::WsText;
        cmd.clientId = clientId;
        cmd.text = std::string(text);
        cmdQueue_.push_back(std::move(cmd));
    }
    cmdCv_.notify_one();
}

void AppController::applyPresetToChain(const Preset& preset, bool loadFiles) {
    auto& chain = audioEngine_.chain();
    chain.setParams(preset.params);
    chain.snapParameters();

    if (loadFiles) {
        if (!preset.namPath.empty()) {
            chain.loadNamAsync(utf8ToWide(preset.namPath));
        } else {
            chain.clearNam();
        }

        if (!preset.irPath.empty()) {
            std::string irErr;
            chain.loadIrFromWav(utf8ToWide(preset.irPath), irErr);
        } else {
            chain.clearIr();
        }
    }
}

void AppController::launchBrowseDialogAsync(uint32_t clientId,
                                            const std::string& presetId,
                                            const std::string& kind) {
    if (browseDialogOpen_.exchange(true, std::memory_order_acq_rel)) {
        wsServer_.sendTextToClient(clientId, buildErrorJson("A file dialog is already open"));
        return;
    }

    std::lock_guard<std::mutex> lock(dialogThreadsMutex_);
    for (auto it = dialogThreads_.begin(); it != dialogThreads_.end();) {
        if (it->joinable()) {
            it->detach();
        }
        it = dialogThreads_.erase(it);
    }

    HWND owner = static_cast<HWND>(mainHwnd_.load(std::memory_order_relaxed));
    dialogThreads_.emplace_back([this, clientId, presetId, kind, owner]() {
        wchar_t fileBuf[MAX_PATH * 4]{};
        OPENFILENAMEW ofn{};
        ofn.lStructSize = sizeof(ofn);
        ofn.hwndOwner = owner;
        ofn.lpstrFile = fileBuf;
        ofn.nMaxFile = static_cast<DWORD>(sizeof(fileBuf) / sizeof(wchar_t));
        ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;

        if (kind == "nam") {
            ofn.lpstrFilter = L"Neural Amp Modeler (*.nam)\0*.nam\0All Files (*.*)\0*.*\0";
            ofn.lpstrTitle = L"Select NAM Capture (.nam)";
        } else {
            ofn.lpstrFilter = L"Impulse Response WAV (*.wav)\0*.wav\0All Files (*.*)\0*.*\0";
            ofn.lpstrTitle = L"Select Cabinet IR (.wav)";
        }

        const BOOL ok = GetOpenFileNameW(&ofn);
        browseDialogOpen_.store(false, std::memory_order_release);

        if (ok) {
            std::string utf8Path = wideToUtf8(fileBuf);
            {
                std::lock_guard<std::mutex> qLock(cmdMutex_);
                Command cmd;
                cmd.type = CmdType::BrowseCompleted;
                cmd.clientId = clientId;
                cmd.presetId = presetId;
                cmd.kind = kind;
                cmd.text = std::move(utf8Path);
                cmdQueue_.push_back(std::move(cmd));
            }
            cmdCv_.notify_one();
        }
    });
}

void AppController::controllerLoop() {
    using clock = std::chrono::steady_clock;
    auto nextAudioTick = clock::now();
    auto nextStatusTick = clock::now();
    auto nextRetryTick = clock::now() + std::chrono::seconds(5);

    while (running_.load(std::memory_order_acquire)) {
        std::deque<Command> localCmds;
        {
            std::unique_lock<std::mutex> lock(cmdMutex_);
            cmdCv_.wait_until(lock, nextAudioTick, [this]() {
                return !running_.load(std::memory_order_acquire) || !cmdQueue_.empty();
            });
            if (!running_.load(std::memory_order_acquire)) break;
            localCmds.swap(cmdQueue_);
        }

        while (!localCmds.empty()) {
            handleCommand(localCmds.front());
            localCmds.pop_front();
        }

        const auto now = clock::now();

        // 1. Every 5 ms: drain SPSC ring and send WSA1 binary audio frames to streaming clients
        if (now >= nextAudioTick) {
            nextAudioTick = now + std::chrono::milliseconds(5);
            const size_t n = audioEngine_.drainDrySamples(spscDrainBuf_.data(), spscDrainBuf_.size());
            if (n > 0) {
                const uint32_t sampleRate = static_cast<uint32_t>(
                    std::lround(audioEngine_.chain().sampleRate()));
                if (wsServer_.hasStreamingClients()) {
                    const std::vector<uint8_t> wsa1 = buildWsa1Frame(
                        sampleRate,
                        runningFrameIndex_,
                        std::span<const int16_t>(spscDrainBuf_.data(), n));
                    wsServer_.broadcastAudioFrame(wsa1);
                }
                runningFrameIndex_ += static_cast<uint32_t>(n);
            }
        }

        // 2. Every 250 ms: broadcast status JSON and refresh tray state snapshot
        if (now >= nextStatusTick) {
            nextStatusTick = now + std::chrono::milliseconds(250);
            const AudioStatus st = audioEngine_.getStatus();
            refreshTraySnapshot(st);
            if (wsServer_.connectedClientCount() > 0) {
                wsServer_.broadcastText(buildStatusJson(st));
            }
        }

        // 3. Every 5 s: retry opening ASIO stream if currently stopped
        if (now >= nextRetryTick) {
            nextRetryTick = now + std::chrono::seconds(5);
            if (!audioEngine_.isRunning()) {
                const bool ok = audioEngine_.restart(settings_.device, settings_.inputChannel, settings_.sampleRate, settings_.bufferFrames);
                const AudioStatus st = audioEngine_.getStatus();
                refreshTraySnapshot(st);
                if (ok) {
                    lastNotifiedError_.clear();
                    if (!st.device.empty() && settings_.device != st.device) {
                        settings_.device = st.device;
                        saveSettingsAtomic();
                    }
                    if (const Preset* p = presetBank_.findById(currentPresetId_)) {
                        applyPresetToChain(*p, true);
                    }
                } else if (!st.lastError.empty() && st.lastError != lastNotifiedError_) {
                    lastNotifiedError_ = st.lastError;
                    std::lock_guard<std::mutex> lock(balloonMutex_);
                    if (balloonCb_) {
                        balloonCb_("Woodshed Amp", st.lastError, true);
                    }
                }
            }
        }
    }
}

void AppController::handleCommand(const Command& cmd) {
    switch (cmd.type) {
        case CmdType::WsText:
            handleWsJson(cmd.clientId, cmd.text);
            break;

        case CmdType::SelectPreset: {
            const Preset* p = presetBank_.findById(cmd.presetId);
            if (!p) break;
            currentPresetId_ = p->id;
            settings_.lastPreset = p->id;
            applyPresetToChain(*p, true);
            saveSettingsAtomic();
            const AudioStatus st = audioEngine_.getStatus();
            refreshTraySnapshot(st);
            wsServer_.broadcastText(buildPresetsJson());
            wsServer_.broadcastText(buildStatusJson(st));
            break;
        }

        case CmdType::SetInputChannel: {
            const int ch = std::clamp(cmd.intVal, 0, 2);
            settings_.inputChannel = ch;
            audioEngine_.setInputChannel(ch);
            saveSettingsAtomic();
            const AudioStatus st = audioEngine_.getStatus();
            refreshTraySnapshot(st);
            wsServer_.broadcastText(buildStatusJson(st));
            break;
        }

        case CmdType::ToggleBypass: {
            audioEngine_.setBypass(!audioEngine_.bypass());
            const AudioStatus st = audioEngine_.getStatus();
            refreshTraySnapshot(st);
            wsServer_.broadcastText(buildStatusJson(st));
            break;
        }

        case CmdType::ToggleMute: {
            audioEngine_.setMute(!audioEngine_.mute());
            const AudioStatus st = audioEngine_.getStatus();
            refreshTraySnapshot(st);
            wsServer_.broadcastText(buildStatusJson(st));
            break;
        }

        case CmdType::OpenAsioPanel: {
            audioEngine_.openAsioControlPanel(mainHwnd_.load(std::memory_order_relaxed));
            break;
        }

        case CmdType::SetStartWithWindows: {
            settings_.startWithWindows = cmd.boolVal;
            syncStartupRegistry(cmd.boolVal);
            saveSettingsAtomic();
            refreshTraySnapshot(audioEngine_.getStatus());
            break;
        }

        case CmdType::BrowseCompleted: {
            Preset* p = presetBank_.findByIdMutable(cmd.presetId);
            if (!p) break;

            const std::wstring wPath = utf8ToWide(cmd.text);
            std::string loadErr;

            if (cmd.kind == "nam") {
                if (p->id == currentPresetId_) {
                    if (!audioEngine_.chain().loadNamSync(wPath, loadErr)) {
                        wsServer_.sendTextToClient(cmd.clientId, buildErrorJson(loadErr));
                        break;
                    }
                }
                p->namPath = cmd.text;
            } else if (cmd.kind == "ir") {
                if (p->id == currentPresetId_) {
                    if (!audioEngine_.chain().loadIrFromWav(wPath, loadErr)) {
                        wsServer_.sendTextToClient(cmd.clientId, buildErrorJson(loadErr));
                        break;
                    }
                }
                p->irPath = cmd.text;
            }

            std::string saveErr;
            presetBank_.saveOverridesAtomic(PresetBank::defaultPresetsPath(), saveErr);
            wsServer_.broadcastText(buildPresetsJson());
            break;
        }
    }
}

void AppController::handleWsJson(uint32_t clientId, const std::string& text) {
    json msg;
    try {
        msg = json::parse(text);
    } catch (...) {
        wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid JSON message"));
        return;
    }

    if (!msg.is_object() || !msg.contains("type") || !msg["type"].is_string()) {
        wsServer_.sendTextToClient(clientId, buildErrorJson("Missing message type"));
        return;
    }

    const std::string type = msg["type"].get<std::string>();

    if (type == "hello") {
        wsServer_.sendTextToClient(clientId, buildHelloJson());
        wsServer_.sendTextToClient(clientId, buildPresetsJson());
        wsServer_.sendTextToClient(clientId, buildDevicesJson());
        wsServer_.sendTextToClient(clientId, buildStatusJson(audioEngine_.getStatus()));
        return;
    }

    if (type == "preset") {
        if (!msg.contains("id") || !msg["id"].is_string()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Missing preset id"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        const Preset* p = presetBank_.findById(id);
        if (!p) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }
        currentPresetId_ = p->id;
        settings_.lastPreset = p->id;
        applyPresetToChain(*p, true);
        saveSettingsAtomic();
        const AudioStatus st = audioEngine_.getStatus();
        refreshTraySnapshot(st);
        wsServer_.broadcastText(buildPresetsJson());
        wsServer_.broadcastText(buildStatusJson(st));
        return;
    }

    if (type == "param") {
        if (!msg.contains("id") || !msg["id"].is_string() ||
            !msg.contains("key") || !msg["key"].is_string() ||
            !msg.contains("value")) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid param message"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        const std::string key = msg["key"].get<std::string>();
        const json& val = msg["value"];

        Preset* p = presetBank_.findByIdMutable(id);
        if (!p) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }

        auto& cp = p->params;
        auto& chain = audioEngine_.chain();
        const bool isActive = (id == currentPresetId_);

        if (key == "gain" && val.is_number()) {
            cp.amp.gain = std::clamp(val.get<float>(), 0.0f, 10.0f);
            if (isActive) chain.setAmpGain(cp.amp.gain);
        } else if (key == "bass" && val.is_number()) {
            cp.amp.bass = std::clamp(val.get<float>(), 0.0f, 10.0f);
            if (isActive) chain.setAmpBass(cp.amp.bass);
        } else if (key == "mid" && val.is_number()) {
            cp.amp.mid = std::clamp(val.get<float>(), 0.0f, 10.0f);
            if (isActive) chain.setAmpMid(cp.amp.mid);
        } else if (key == "treble" && val.is_number()) {
            cp.amp.treble = std::clamp(val.get<float>(), 0.0f, 10.0f);
            if (isActive) chain.setAmpTreble(cp.amp.treble);
        } else if (key == "presence" && val.is_number()) {
            cp.amp.presence = std::clamp(val.get<float>(), 0.0f, 10.0f);
            if (isActive) chain.setAmpPresence(cp.amp.presence);
        } else if ((key == "tightHz" || key == "tight") && val.is_number()) {
            cp.amp.tightHz = std::clamp(val.get<float>(), 20.0f, 400.0f);
            if (isActive) chain.setAmpTightHz(cp.amp.tightHz);
        } else if (key == "character") {
            cp.amp.character = parseCharacter(val, cp.amp.character);
            if (isActive) chain.setAmpCharacter(cp.amp.character);
        } else if (key == "sag" && val.is_number()) {
            cp.amp.sag = std::clamp(val.get<float>(), 0.0f, 1.0f);
            if (isActive) chain.setAmpSag(cp.amp.sag);
        } else if ((key == "ampLevelDb" || key == "levelDb") && val.is_number()) {
            cp.amp.levelDb = std::clamp(val.get<float>(), -40.0f, 24.0f);
            if (isActive) chain.setAmpLevelDb(cp.amp.levelDb);
        } else if (key == "cab" || key == "cabType") {
            cp.cabType = parseCab(val, cp.cabType);
            if (isActive) chain.setCabType(cp.cabType);
        } else if (key == "namIncludesCab" && val.is_boolean()) {
            cp.namIncludesCab = val.get<bool>();
            if (isActive) chain.setNamIncludesCab(cp.namIncludesCab);
        } else if ((key == "inputTrimDb" || key == "inputTrim") && val.is_number()) {
            cp.inputTrimDb = std::clamp(val.get<float>(), -24.0f, 24.0f);
            if (isActive) chain.setInputTrimDb(cp.inputTrimDb);
        } else if ((key == "gateThresholdDb" || key == "gateThreshold" || key == "gate") && val.is_number()) {
            cp.gateThresholdDb = std::clamp(val.get<float>(), -80.0f, 0.0f);
            if (isActive) chain.setGateThresholdDb(cp.gateThresholdDb);
        } else if (key == "postLowDb" && val.is_number()) {
            cp.postLowDb = std::clamp(val.get<float>(), -15.0f, 15.0f);
            if (isActive) chain.setPostLowDb(cp.postLowDb);
        } else if (key == "postMidDb" && val.is_number()) {
            cp.postMidDb = std::clamp(val.get<float>(), -15.0f, 15.0f);
            if (isActive) chain.setPostMidDb(cp.postMidDb);
        } else if (key == "postHighDb" && val.is_number()) {
            cp.postHighDb = std::clamp(val.get<float>(), -15.0f, 15.0f);
            if (isActive) chain.setPostHighDb(cp.postHighDb);
        } else if ((key == "chorusMix" || key == "chorus") && val.is_number()) {
            cp.chorusMix = std::clamp(val.get<float>(), 0.0f, 1.0f);
            if (isActive) chain.setChorusMix(cp.chorusMix);
        } else if ((key == "delayTimeMs" || key == "delayTime") && val.is_number()) {
            cp.delayTimeMs = std::clamp(val.get<float>(), 0.0f, 1000.0f);
            if (isActive) chain.setDelayTimeMs(cp.delayTimeMs);
        } else if (key == "delayFeedback" && val.is_number()) {
            cp.delayFeedback = std::clamp(val.get<float>(), 0.0f, 0.85f);
            if (isActive) chain.setDelayFeedback(cp.delayFeedback);
        } else if ((key == "delayMix" || key == "delay") && val.is_number()) {
            cp.delayMix = std::clamp(val.get<float>(), 0.0f, 1.0f);
            if (isActive) chain.setDelayMix(cp.delayMix);
        } else if (key == "reverbSize" && val.is_number()) {
            cp.reverbSize = std::clamp(val.get<float>(), 0.0f, 1.0f);
            if (isActive) chain.setReverbSize(cp.reverbSize);
        } else if ((key == "reverbMix" || key == "reverb") && val.is_number()) {
            cp.reverbMix = std::clamp(val.get<float>(), 0.0f, 1.0f);
            if (isActive) chain.setReverbMix(cp.reverbMix);
        } else if ((key == "outputLevelDb" || key == "outputLevel") && val.is_number()) {
            cp.outputLevelDb = std::clamp(val.get<float>(), -60.0f, 24.0f);
            if (isActive) chain.setOutputLevelDb(cp.outputLevelDb);
        } else {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown or invalid parameter: " + key));
            return;
        }

        std::string saveErr;
        presetBank_.saveOverridesAtomic(PresetBank::defaultPresetsPath(), saveErr);
        wsServer_.broadcastText(buildPresetsJson());
        return;
    }

    if (type == "resetPreset") {
        if (!msg.contains("id") || !msg["id"].is_string()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Missing preset id"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        Preset* target = presetBank_.findByIdMutable(id);
        if (!target) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }

        PresetBank freshDefaults;
        if (const Preset* def = freshDefaults.findById(id)) {
            *target = *def;
        }

        std::string saveErr;
        presetBank_.saveOverridesAtomic(PresetBank::defaultPresetsPath(), saveErr);

        if (id == currentPresetId_) {
            applyPresetToChain(*target, true);
        }
        wsServer_.broadcastText(buildPresetsJson());
        return;
    }

    if (type == "browse") {
        if (!msg.contains("id") || !msg["id"].is_string() ||
            !msg.contains("kind") || !msg["kind"].is_string()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid browse request"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        const std::string kind = msg["kind"].get<std::string>();
        if (!presetBank_.findById(id)) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }
        if (kind != "nam" && kind != "ir") {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Browse kind must be 'nam' or 'ir'"));
            return;
        }
        launchBrowseDialogAsync(clientId, id, kind);
        return;
    }

    if (type == "clearFile") {
        if (!msg.contains("id") || !msg["id"].is_string() ||
            !msg.contains("kind") || !msg["kind"].is_string()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid clearFile request"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        const std::string kind = msg["kind"].get<std::string>();
        Preset* p = presetBank_.findByIdMutable(id);
        if (!p) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }

        if (kind == "nam") {
            p->namPath.clear();
            p->params.namIncludesCab = false;
            if (id == currentPresetId_) {
                audioEngine_.chain().clearNam();
                audioEngine_.chain().setNamIncludesCab(false);
            }
        } else if (kind == "ir") {
            p->irPath.clear();
            if (id == currentPresetId_) {
                audioEngine_.chain().clearIr();
            }
        } else {
            wsServer_.sendTextToClient(clientId, buildErrorJson("clearFile kind must be 'nam' or 'ir'"));
            return;
        }

        std::string saveErr;
        presetBank_.saveOverridesAtomic(PresetBank::defaultPresetsPath(), saveErr);
        wsServer_.broadcastText(buildPresetsJson());
        return;
    }

    if (type == "stream") {
        const bool on = msg.value("on", false);
        wsServer_.setClientStreaming(clientId, on);
        return;
    }

    if (type == "bypass") {
        const bool on = msg.value("on", false);
        audioEngine_.setBypass(on);
        const AudioStatus st = audioEngine_.getStatus();
        refreshTraySnapshot(st);
        wsServer_.broadcastText(buildStatusJson(st));
        return;
    }

    if (type == "mute") {
        const bool on = msg.value("on", false);
        audioEngine_.setMute(on);
        const AudioStatus st = audioEngine_.getStatus();
        refreshTraySnapshot(st);
        wsServer_.broadcastText(buildStatusJson(st));
        return;
    }

    if (type == "device") {
        bool needRestart = false;
        if (msg.contains("name") && msg["name"].is_string()) {
            const std::string newName = msg["name"].get<std::string>();
            if (newName != settings_.device) {
                settings_.device = newName;
                needRestart = true;
            }
        }
        if (msg.contains("sampleRate") && msg["sampleRate"].is_number()) {
            const double newRate = msg["sampleRate"].get<double>();
            if (newRate >= 8000.0 && newRate <= 384000.0 && std::abs(newRate - settings_.sampleRate) > 1.0) {
                settings_.sampleRate = newRate;
                needRestart = true;
            }
        }
        if (msg.contains("bufferFrames") && msg["bufferFrames"].is_number_integer()) {
            const int bf = msg["bufferFrames"].get<int>();
            if (bf == 0 || (bf >= 16 && bf <= 2048)) {
                if (bf != settings_.bufferFrames) {
                    settings_.bufferFrames = bf;
                    needRestart = true;
                }
            } else {
                wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid bufferFrames (must be 0 or 16..2048)"));
                return;
            }
        }
        if (msg.contains("inputChannel") && msg["inputChannel"].is_number_integer()) {
            settings_.inputChannel = std::clamp(msg["inputChannel"].get<int>(), 0, 2);
            audioEngine_.setInputChannel(settings_.inputChannel);
        }

        saveSettingsAtomic();

        if (needRestart) {
            const bool ok = audioEngine_.restart(settings_.device, settings_.inputChannel, settings_.sampleRate, settings_.bufferFrames);
            if (ok) {
                lastNotifiedError_.clear();
                if (const Preset* p = presetBank_.findById(currentPresetId_)) {
                    applyPresetToChain(*p, true);
                }
            }
        }

        const AudioStatus st = audioEngine_.getStatus();
        refreshTraySnapshot(st);
        wsServer_.broadcastText(buildDevicesJson());
        wsServer_.broadcastText(buildStatusJson(st));
        if (!st.running && !st.lastError.empty()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson(st.lastError));
        }
        return;
    }

    if (type == "monitorOutput") {
        std::string newName;
        if (msg.contains("name") && msg["name"].is_string()) {
            newName = msg["name"].get<std::string>();
        } else if (msg.contains("name") && !msg["name"].is_null()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid monitorOutput name"));
            return;
        }
        if (msg.contains("exclusive")) {
            if (msg["exclusive"].is_boolean()) {
                settings_.monitorExclusive = msg["exclusive"].get<bool>();
            } else if (!msg["exclusive"].is_null()) {
                wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid monitorOutput exclusive flag"));
                return;
            }
        }
        settings_.monitorOutput = newName;
        saveSettingsAtomic();
        const bool ok = audioEngine_.setMonitorOutput(settings_.monitorOutput, settings_.monitorExclusive);
        const AudioStatus st = audioEngine_.getStatus();
        refreshTraySnapshot(st);
        wsServer_.broadcastText(buildDevicesJson());
        wsServer_.broadcastText(buildStatusJson(st));
        if (!ok && !st.monitorError.empty()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson(st.monitorError));
        }
        return;
    }

    if (type == "asioPanel") {
        if (!audioEngine_.openAsioControlPanel(mainHwnd_.load(std::memory_order_relaxed))) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unable to open ASIO control panel"));
        }
        return;
    }

    wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown message type: " + type));
}


std::string AppController::buildHelloJson() const {
    json j = {
        {"type", "hello"},
        {"app", "woodshed-amp"},
        {"version", kAmpVersion},
        {"protocol", 1}
    };
    return j.dump();
}

std::string AppController::buildPresetsJson() const {
    json list = json::array();
    for (const auto& p : presetBank_.presets()) {
        json item = json::object();
        item["id"] = p.id;
        item["name"] = p.name;

        if (!p.namPath.empty()) {
            item["nam"] = wideToUtf8(std::filesystem::path(utf8ToWide(p.namPath)).filename().wstring());
        } else {
            item["nam"] = nullptr;
        }
        item["namIncludesCab"] = p.params.namIncludesCab;

        if (!p.irPath.empty()) {
            item["ir"] = wideToUtf8(std::filesystem::path(utf8ToWide(p.irPath)).filename().wstring());
        } else {
            item["ir"] = nullptr;
        }

        item["params"] = {
            {"character", characterToStr(p.params.amp.character)},
            {"gain", p.params.amp.gain},
            {"bass", p.params.amp.bass},
            {"mid", p.params.amp.mid},
            {"treble", p.params.amp.treble},
            {"presence", p.params.amp.presence},
            {"tightHz", p.params.amp.tightHz},
            {"sag", p.params.amp.sag},
            {"ampLevelDb", p.params.amp.levelDb},
            {"cab", cabToStr(p.params.cabType)},
            {"inputTrimDb", p.params.inputTrimDb},
            {"gateThresholdDb", p.params.gateThresholdDb},
            {"postLowDb", p.params.postLowDb},
            {"postMidDb", p.params.postMidDb},
            {"postHighDb", p.params.postHighDb},
            {"chorusMix", p.params.chorusMix},
            {"delayTimeMs", p.params.delayTimeMs},
            {"delayFeedback", p.params.delayFeedback},
            {"delayMix", p.params.delayMix},
            {"reverbSize", p.params.reverbSize},
            {"reverbMix", p.params.reverbMix},
            {"outputLevelDb", p.params.outputLevelDb}
        };
        list.push_back(std::move(item));
    }

    json j = {
        {"type", "presets"},
        {"current", currentPresetId_},
        {"list", std::move(list)}
    };
    return j.dump();
}

std::string AppController::buildDevicesJson() const {
    const std::vector<std::string> devs = audioEngine_.enumerateAsioDevices();
    const std::vector<std::string> outputs = audioEngine_.enumerateMonitorOutputs();
    const std::vector<int> bufferSizes = audioEngine_.legalBufferSizes();
    json j = {
        {"type", "devices"},
        {"list", devs},
        {"current", settings_.device},
        {"bufferSizes", bufferSizes},
        {"outputs", outputs},
        {"monitorOutput", settings_.monitorOutput},
        {"monitorExclusive", settings_.monitorExclusive}
    };
    return j.dump();
}

std::string AppController::buildStatusJson(const AudioStatus& st) const {
    json j = {
        {"type", "status"},
        {"running", st.running},
        {"device", st.device},
        {"sampleRate", static_cast<int>(std::lround(st.sampleRate))},
        {"bufferFrames", st.bufferFrames},
        {"requestedBufferFrames", st.requestedBufferFrames},
        {"bufferNote", st.bufferNote},
        {"inputMs", round1(st.inputMs)},
        {"outputMs", round1(st.outputMs)},
        {"roundTripMs", round1(st.roundTripMs)},
        {"inPeakDb", round1(st.inPeakDb)},
        {"outPeakDb", round1(st.outPeakDb)},
        {"clip", st.clip},
        {"cpu", round3(st.cpu)},
        {"xruns", st.xruns},
        {"bypass", st.bypass},
        {"mute", st.mute},
        {"preset", currentPresetId_},
        {"streamDrops", st.streamDrops},
        {"inputChannel", st.inputChannel},
        {"monitorOutput", st.monitorOutput},
        {"monitorExclusive", st.monitorExclusive},
        {"monitorRunning", st.monitorRunning},
        {"monitorLatencyMs", round1(st.monitorLatencyMs)},
        {"monitorUnderruns", st.monitorUnderruns},
        {"monitorError", st.monitorError}
    };
    return j.dump();
}

std::string AppController::buildErrorJson(const std::string& msg) const {
    json j = {
        {"type", "error"},
        {"message", msg}
    };
    return j.dump();
}

void AppController::refreshTraySnapshot(const AudioStatus& st) {
    TrayStateSnapshot snap;
    snap.running = st.running;
    snap.device = st.device;
    snap.roundTripMs = st.roundTripMs;
    snap.bypass = st.bypass;
    snap.mute = st.mute;
    snap.inputChannel = st.inputChannel;
    snap.startWithWindows = settings_.startWithWindows;
    snap.currentPresetId = currentPresetId_;
    snap.lastError = st.lastError;

    for (const auto& p : presetBank_.presets()) {
        snap.presetIdAndNames.emplace_back(p.id, p.name);
        if (p.id == currentPresetId_) {
            snap.currentPresetName = p.name;
        }
    }

    std::lock_guard<std::mutex> lock(snapshotMutex_);
    traySnapshot_ = std::move(snap);
}

TrayStateSnapshot AppController::getTraySnapshot() const {
    std::lock_guard<std::mutex> lock(snapshotMutex_);
    return traySnapshot_;
}

} // namespace wsamp
