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

std::string characterIndexToStr(int idx) {
    switch (idx) {
        case 0: return "Clean";
        case 1: return "Breakup";
        case 2: return "Crunch";
        case 3: return "HighGain";
        case 4: return "Fuzz";
        default: return "Clean";
    }
}

int parseCharacterIndex(const json& v, int fallback) {
    if (v.is_string()) {
        const std::string s = v.get<std::string>();
        if (s == "Clean" || s == "clean") return 0;
        if (s == "Breakup" || s == "breakup") return 1;
        if (s == "Crunch" || s == "crunch") return 2;
        if (s == "HighGain" || s == "high_gain" || s == "highgain") return 3;
        if (s == "Fuzz" || s == "fuzz") return 4;
    } else if (v.is_number_integer()) {
        return std::clamp(v.get<int>(), 0, 4);
    } else if (v.is_number()) {
        const double d = v.get<double>();
        if (std::isfinite(d)) {
            return std::clamp(static_cast<int>(std::lround(d)), 0, 4);
        }
    }
    return fallback;
}

std::string cabIndexToStr(int idx) {
    switch (idx) {
        case 0: return "C412";
        case 1: return "O212";
        case 2: return "O112";
        case 3: return "Acoustic";
        case 4: return "Bass";
        default: return "C412";
    }
}

BlockState* findBlockByUid(Preset& preset, const std::string& uid) noexcept {
    for (auto& b : preset.blocks) {
        if (b.uid == uid) return &b;
    }
    return nullptr;
}

const BlockState* findFirstBlockByType(const Preset& preset, const std::string& type) noexcept {
    for (const auto& b : preset.blocks) {
        if (b.type == type) return &b;
    }
    return nullptr;
}

BlockState* findFirstBlockByTypeMutable(Preset& preset, const std::string& type) noexcept {
    for (auto& b : preset.blocks) {
        if (b.type == type) return &b;
    }
    return nullptr;
}

int findParamIndexByKey(const dsp::BlockTypeSpec& spec, const std::string& key) noexcept {
    for (size_t i = 0; i < spec.params.size(); ++i) {
        if (spec.params[i].key && key == spec.params[i].key) {
            return static_cast<int>(i);
        }
    }
    return -1;
}

float clampSpecParam(const dsp::ParamSpec& ps, float val) noexcept {
    if (!ps.options.empty()) {
        val = std::round(val);
    }
    return std::clamp(val, ps.min, ps.max);
}

BlockState makeDefaultBlockState(const dsp::BlockTypeSpec& spec, const std::string& uid) {
    BlockState bs;
    bs.uid = uid;
    bs.type = spec.id;
    bs.enabled = true;
    for (const auto& ps : spec.params) {
        bs.params[ps.key] = clampSpecParam(ps, ps.def);
    }
    return bs;
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

    liveBlocks_.clear();
    loadedBlockFiles_.clear();
    blockLoadErrors_.clear();
    if (const Preset* activePreset = presetBank_.findById(currentPresetId_)) {
        buildAndInstallBoard(*activePreset, true);
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

    if (presetsDirty_) {
        savePresetsNow();
    }

    wsServer_.stop();
    audioEngine_.shutdown();
    audioEngine_.chain().reclaim();

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

void AppController::markPresetsDirty() {
    presetsDirty_ = true;
    lastPresetDirtyTime_ = std::chrono::steady_clock::now();
}

void AppController::savePresetsNow() {
    std::string saveErr;
    presetBank_.saveOverridesAtomic(PresetBank::defaultPresetsPath(), saveErr);
    presetsDirty_ = false;
}

void AppController::buildAndInstallBoard(const Preset& preset, bool reloadFiles, uint32_t targetClientId) {
    auto& chain = audioEngine_.chain();

    dsp::GlobalParams gp;
    gp.inputTrimDb = preset.inputTrimDb;
    gp.gateThresholdDb = preset.gateThresholdDb;
    gp.outputLevelDb = preset.outputLevelDb;
    chain.setGlobal(gp);

    std::unordered_map<std::string, std::shared_ptr<dsp::Block>> nextLive;
    nextLive.reserve(preset.blocks.size());

    std::vector<std::shared_ptr<dsp::Block>> boardBlocks;
    boardBlocks.reserve(preset.blocks.size());

    for (const auto& bs : preset.blocks) {
        const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(bs.type);
        if (!spec) continue;

        bool isNew = false;
        std::shared_ptr<dsp::Block> blk;
        if (auto it = liveBlocks_.find(bs.uid); it != liveBlocks_.end() && it->second && it->second->type() == spec->type) {
            blk = it->second;
        } else {
            blk = dsp::makeBlock(spec->type, bs.uid);
            isNew = true;
        }
        if (!blk) continue;

        for (size_t i = 0; i < spec->params.size(); ++i) {
            const auto& ps = spec->params[i];
            float val = ps.def;
            if (auto pit = bs.params.find(ps.key); pit != bs.params.end()) {
                val = pit->second;
            }
            blk->setParam(static_cast<int>(i), clampSpecParam(ps, val));
        }
        blk->setEnabled(bs.enabled);

        if (spec->usesFile) {
            if (bs.file.empty()) {
                if (blk->hasFile() || !loadedBlockFiles_[bs.uid].empty()) {
                    blk->clearFile();
                }
                loadedBlockFiles_[bs.uid].clear();
                blockLoadErrors_.erase(bs.uid);
            } else {
                const bool fileChanged = (loadedBlockFiles_[bs.uid] != bs.file);
                if (isNew || fileChanged || reloadFiles) {
                    loadedBlockFiles_[bs.uid] = bs.file;
                    std::string loadErr;
                    const std::filesystem::path fsPath(utf8ToWide(bs.file));
                    if (!blk->loadFile(fsPath, loadErr)) {
                        blockLoadErrors_[bs.uid] = loadErr;
                        const std::string fileName = wideToUtf8(fsPath.filename().wstring());
                        const std::string errJson = buildErrorJson("Could not load " + fileName + ": " + loadErr);
                        if (targetClientId != 0) {
                            wsServer_.sendTextToClient(targetClientId, errJson);
                        } else {
                            wsServer_.broadcastText(errJson);
                        }
                    } else {
                        blockLoadErrors_.erase(bs.uid);
                    }
                }
            }
        }

        nextLive[bs.uid] = blk;
        boardBlocks.push_back(std::move(blk));
    }

    for (auto it = loadedBlockFiles_.begin(); it != loadedBlockFiles_.end();) {
        if (nextLive.find(it->first) == nextLive.end()) {
            it = loadedBlockFiles_.erase(it);
        } else {
            ++it;
        }
    }
    for (auto it = blockLoadErrors_.begin(); it != blockLoadErrors_.end();) {
        if (nextLive.find(it->first) == nextLive.end()) {
            it = blockLoadErrors_.erase(it);
        } else {
            ++it;
        }
    }
    liveBlocks_ = std::move(nextLive);

    auto board = std::make_shared<dsp::Board>(std::move(boardBlocks));
    if (chain.maxBlock() > 0) {
        board->prepareScratch(chain.maxBlock());
    }
    chain.installBoard(std::move(board));
}

void AppController::launchBrowseDialogAsync(uint32_t clientId,
                                            const std::string& presetId,
                                            const std::string& kind,
                                            const std::string& uid) {
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
    dialogThreads_.emplace_back([this, clientId, presetId, kind, uid, owner]() {
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
                cmd.uid = uid;
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
            const auto maxWait = clock::now() + std::chrono::milliseconds(200);
            auto wakeAt = std::min(nextAudioTick, maxWait);
            if (presetsDirty_) {
                wakeAt = std::min(wakeAt, lastPresetDirtyTime_ + std::chrono::milliseconds(400));
            }
            cmdCv_.wait_until(lock, wakeAt, [this]() {
                return !running_.load(std::memory_order_acquire) || !cmdQueue_.empty();
            });
            if (!running_.load(std::memory_order_acquire)) break;
            localCmds.swap(cmdQueue_);
        }

        while (!localCmds.empty()) {
            handleCommand(localCmds.front());
            localCmds.pop_front();
        }

        audioEngine_.chain().reclaim();

        const auto now = clock::now();

        if (presetsDirty_ && (now - lastPresetDirtyTime_ >= std::chrono::milliseconds(400))) {
            savePresetsNow();
        }

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
                        buildAndInstallBoard(*p, true);
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
            liveBlocks_.clear();
            loadedBlockFiles_.clear();
            blockLoadErrors_.clear();
            buildAndInstallBoard(*p, true);
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

            BlockState* bs = !cmd.uid.empty() ? findBlockByUid(*p, cmd.uid) : nullptr;
            if (!bs && !cmd.kind.empty()) {
                for (auto& b : p->blocks) {
                    const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(b.type);
                    if (spec && spec->usesFile && spec->fileKind && cmd.kind == spec->fileKind) {
                        bs = &b;
                        break;
                    }
                }
            }
            if (!bs) break;

            bs->file = cmd.text;
            if (p->id == currentPresetId_) {
                buildAndInstallBoard(*p, false, cmd.clientId);
            }

            savePresetsNow();
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
        liveBlocks_.clear();
        loadedBlockFiles_.clear();
        blockLoadErrors_.clear();
        buildAndInstallBoard(*p, true, clientId);
        saveSettingsAtomic();
        const AudioStatus st = audioEngine_.getStatus();
        refreshTraySnapshot(st);
        wsServer_.broadcastText(buildPresetsJson());
        wsServer_.broadcastText(buildStatusJson(st));
        return;
    }

    if (type == "blockParam") {
        if (!msg.contains("id") || !msg["id"].is_string() ||
            !msg.contains("uid") || !msg["uid"].is_string() ||
            !msg.contains("key") || !msg["key"].is_string() ||
            !msg.contains("value") || !msg["value"].is_number()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid blockParam message"));
            return;
        }
        const double rawVal = msg["value"].get<double>();
        if (!std::isfinite(rawVal)) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid blockParam value"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        const std::string uid = msg["uid"].get<std::string>();
        const std::string key = msg["key"].get<std::string>();

        Preset* p = presetBank_.findByIdMutable(id);
        if (!p) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }
        BlockState* bs = findBlockByUid(*p, uid);
        if (!bs) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown block uid: " + uid));
            return;
        }
        const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(bs->type);
        if (!spec) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown block type: " + bs->type));
            return;
        }
        const int paramIdx = findParamIndexByKey(*spec, key);
        if (paramIdx < 0) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown parameter key: " + key));
            return;
        }

        const float clamped = clampSpecParam(spec->params[static_cast<size_t>(paramIdx)], static_cast<float>(rawVal));
        bs->params[key] = clamped;

        if (id == currentPresetId_) {
            if (auto it = liveBlocks_.find(uid); it != liveBlocks_.end() && it->second) {
                it->second->setParam(paramIdx, clamped);
            }
        }

        markPresetsDirty();
        return;
    }

    if (type == "blockEnable") {
        if (!msg.contains("id") || !msg["id"].is_string() ||
            !msg.contains("uid") || !msg["uid"].is_string() ||
            !msg.contains("on") || !msg["on"].is_boolean()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid blockEnable message"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        const std::string uid = msg["uid"].get<std::string>();
        const bool on = msg["on"].get<bool>();

        Preset* p = presetBank_.findByIdMutable(id);
        if (!p) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }
        BlockState* bs = findBlockByUid(*p, uid);
        if (!bs) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown block uid: " + uid));
            return;
        }

        bs->enabled = on;
        if (id == currentPresetId_) {
            if (auto it = liveBlocks_.find(uid); it != liveBlocks_.end() && it->second) {
                it->second->setEnabled(on);
            }
        }

        savePresetsNow();
        wsServer_.broadcastText(buildPresetsJson());
        return;
    }

    if (type == "blockAdd") {
        if (!msg.contains("id") || !msg["id"].is_string() ||
            !msg.contains("blockType") || !msg["blockType"].is_string()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid blockAdd message"));
            return;
        }
        if (msg.contains("index") && !msg["index"].is_null() && !msg["index"].is_number_integer()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid blockAdd index"));
            return;
        }

        const std::string id = msg["id"].get<std::string>();
        const std::string blockType = msg["blockType"].get<std::string>();

        Preset* p = presetBank_.findByIdMutable(id);
        if (!p) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }

        std::string addErr;
        if (!PresetBank::canAddBlock(*p, blockType, addErr)) {
            wsServer_.sendTextToClient(clientId, buildErrorJson(addErr));
            return;
        }

        const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(blockType);
        if (!spec) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown block type: " + blockType));
            return;
        }

        const std::string newUid = "b" + std::to_string(p->nextUid++);
        BlockState newBlock = makeDefaultBlockState(*spec, newUid);

        int insertIdx = static_cast<int>(p->blocks.size());
        if (msg.contains("index") && msg["index"].is_number_integer()) {
            insertIdx = std::clamp(msg["index"].get<int>(), 0, static_cast<int>(p->blocks.size()));
        }
        p->blocks.insert(p->blocks.begin() + insertIdx, std::move(newBlock));

        if (id == currentPresetId_) {
            buildAndInstallBoard(*p, false, clientId);
        }

        savePresetsNow();
        wsServer_.broadcastText(buildPresetsJson());

        if (spec->usesFile && spec->fileKind) {
            launchBrowseDialogAsync(clientId, id, spec->fileKind, newUid);
        }
        return;
    }

    if (type == "blockRemove") {
        if (!msg.contains("id") || !msg["id"].is_string() ||
            !msg.contains("uid") || !msg["uid"].is_string()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid blockRemove message"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        const std::string uid = msg["uid"].get<std::string>();

        Preset* p = presetBank_.findByIdMutable(id);
        if (!p) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }

        auto it = std::find_if(p->blocks.begin(), p->blocks.end(),
                               [&](const BlockState& b) { return b.uid == uid; });
        if (it == p->blocks.end()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown block uid: " + uid));
            return;
        }

        p->blocks.erase(it);
        if (id == currentPresetId_) {
            buildAndInstallBoard(*p, false, clientId);
        }

        savePresetsNow();
        wsServer_.broadcastText(buildPresetsJson());
        return;
    }

    if (type == "blockMove") {
        if (!msg.contains("id") || !msg["id"].is_string() ||
            !msg.contains("uid") || !msg["uid"].is_string() ||
            !msg.contains("index") || !msg["index"].is_number_integer()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid blockMove message"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        const std::string uid = msg["uid"].get<std::string>();
        const int requestedIdx = msg["index"].get<int>();

        Preset* p = presetBank_.findByIdMutable(id);
        if (!p) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }

        int fromIdx = -1;
        for (int i = 0; i < static_cast<int>(p->blocks.size()); ++i) {
            if (p->blocks[static_cast<size_t>(i)].uid == uid) {
                fromIdx = i;
                break;
            }
        }
        if (fromIdx < 0) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown block uid: " + uid));
            return;
        }

        const int toIdx = std::clamp(requestedIdx, 0, static_cast<int>(p->blocks.size()) - 1);
        if (fromIdx != toIdx) {
            BlockState moved = std::move(p->blocks[static_cast<size_t>(fromIdx)]);
            p->blocks.erase(p->blocks.begin() + fromIdx);
            p->blocks.insert(p->blocks.begin() + toIdx, std::move(moved));
        }

        if (id == currentPresetId_) {
            buildAndInstallBoard(*p, false, clientId);
        }

        savePresetsNow();
        wsServer_.broadcastText(buildPresetsJson());
        return;
    }

    if (type == "boardGlobal") {
        if (!msg.contains("id") || !msg["id"].is_string() ||
            !msg.contains("key") || !msg["key"].is_string() ||
            !msg.contains("value") || !msg["value"].is_number()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid boardGlobal message"));
            return;
        }
        const double rawVal = msg["value"].get<double>();
        if (!std::isfinite(rawVal)) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid boardGlobal value"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        const std::string key = msg["key"].get<std::string>();

        Preset* p = presetBank_.findByIdMutable(id);
        if (!p) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }

        const bool isActive = (id == currentPresetId_);
        auto& chain = audioEngine_.chain();
        const float val = static_cast<float>(rawVal);

        if (key == "inputTrimDb") {
            p->inputTrimDb = std::clamp(val, -24.0f, 24.0f);
            if (isActive) chain.setInputTrimDb(p->inputTrimDb);
        } else if (key == "gateThresholdDb") {
            p->gateThresholdDb = std::clamp(val, -80.0f, 0.0f);
            if (isActive) chain.setGateThresholdDb(p->gateThresholdDb);
        } else if (key == "outputLevelDb") {
            p->outputLevelDb = std::clamp(val, -60.0f, 24.0f);
            if (isActive) chain.setOutputLevelDb(p->outputLevelDb);
        } else {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown board global parameter: " + key));
            return;
        }

        markPresetsDirty();
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

        auto& chain = audioEngine_.chain();
        const bool isActive = (id == currentPresetId_);

        if (key == "inputTrimDb" && val.is_number() && std::isfinite(val.get<double>())) {
            p->inputTrimDb = std::clamp(val.get<float>(), -24.0f, 24.0f);
            if (isActive) chain.setInputTrimDb(p->inputTrimDb);
            markPresetsDirty();
            return;
        }
        if (key == "gateThresholdDb" && val.is_number() && std::isfinite(val.get<double>())) {
            p->gateThresholdDb = std::clamp(val.get<float>(), -80.0f, 0.0f);
            if (isActive) chain.setGateThresholdDb(p->gateThresholdDb);
            markPresetsDirty();
            return;
        }
        if (key == "outputLevelDb" && val.is_number() && std::isfinite(val.get<double>())) {
            p->outputLevelDb = std::clamp(val.get<float>(), -60.0f, 24.0f);
            if (isActive) chain.setOutputLevelDb(p->outputLevelDb);
            markPresetsDirty();
            return;
        }

        std::string mappedKey;
        if (key == "gain" || key == "bass" || key == "mid" || key == "treble" || key == "presence" || key == "character") {
            mappedKey = key;
        } else if (key == "tightHz") {
            mappedKey = "tight";
        } else if (key == "ampLevelDb") {
            mappedKey = "level";
        } else {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown or invalid parameter: " + key));
            return;
        }

        BlockState* ampBlock = findFirstBlockByTypeMutable(*p, "amp");
        const dsp::BlockTypeSpec* ampSpec = dsp::findBlockSpec(dsp::BlockType::Amp);
        if (!ampBlock || !ampSpec) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown or invalid parameter: " + key));
            return;
        }

        const int paramIdx = findParamIndexByKey(*ampSpec, mappedKey);
        if (paramIdx < 0) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown or invalid parameter: " + key));
            return;
        }
        const auto& ps = ampSpec->params[static_cast<size_t>(paramIdx)];

        float targetVal = 0.0f;
        if (mappedKey == "character") {
            const int curIdx = static_cast<int>(std::lround(ampBlock->params[mappedKey]));
            const int parsedIdx = parseCharacterIndex(val, -1);
            if (parsedIdx < 0) {
                wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown or invalid parameter: " + key));
                return;
            }
            (void)curIdx;
            targetVal = clampSpecParam(ps, static_cast<float>(parsedIdx));
        } else {
            if (!val.is_number() || !std::isfinite(val.get<double>())) {
                wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown or invalid parameter: " + key));
                return;
            }
            targetVal = clampSpecParam(ps, val.get<float>());
        }

        ampBlock->params[mappedKey] = targetVal;
        if (isActive) {
            if (auto it = liveBlocks_.find(ampBlock->uid); it != liveBlocks_.end() && it->second) {
                it->second->setParam(paramIdx, targetVal);
            }
        }

        markPresetsDirty();
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

        savePresetsNow();

        if (id == currentPresetId_) {
            liveBlocks_.clear();
            loadedBlockFiles_.clear();
            blockLoadErrors_.clear();
            buildAndInstallBoard(*target, true, clientId);
        }
        wsServer_.broadcastText(buildPresetsJson());
        return;
    }

    if (type == "browse") {
        if (!msg.contains("id") || !msg["id"].is_string()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid browse request"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        Preset* p = presetBank_.findByIdMutable(id);
        if (!p) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }

        if (msg.contains("uid") && msg["uid"].is_string() && !msg["uid"].get<std::string>().empty()) {
            const std::string uid = msg["uid"].get<std::string>();
            BlockState* bs = findBlockByUid(*p, uid);
            if (!bs) {
                wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown block uid: " + uid));
                return;
            }
            const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(bs->type);
            if (!spec || !spec->usesFile || !spec->fileKind) {
                wsServer_.sendTextToClient(clientId, buildErrorJson("Block does not use a file: " + uid));
                return;
            }
            const std::string resolvedKind = spec->fileKind;
            if (msg.contains("kind") && msg["kind"].is_string()) {
                const std::string reqKind = msg["kind"].get<std::string>();
                if (!reqKind.empty() && reqKind != resolvedKind) {
                    wsServer_.sendTextToClient(clientId, buildErrorJson("Browse kind mismatch for block: " + uid));
                    return;
                }
            }
            launchBrowseDialogAsync(clientId, id, resolvedKind, uid);
            return;
        }

        if (!msg.contains("kind") || !msg["kind"].is_string()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid browse request"));
            return;
        }
        const std::string kind = msg["kind"].get<std::string>();
        if (kind != "nam" && kind != "ir") {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Browse kind must be 'nam' or 'ir'"));
            return;
        }

        std::string targetUid;
        for (const auto& b : p->blocks) {
            const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(b.type);
            if (spec && spec->usesFile && spec->fileKind && kind == spec->fileKind) {
                targetUid = b.uid;
                break;
            }
        }

        if (targetUid.empty()) {
            std::string addErr;
            if (!PresetBank::canAddBlock(*p, kind, addErr)) {
                wsServer_.sendTextToClient(clientId, buildErrorJson(addErr));
                return;
            }
            const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(kind);
            if (!spec) {
                wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown block type: " + kind));
                return;
            }
            targetUid = "b" + std::to_string(p->nextUid++);
            BlockState newBlock = makeDefaultBlockState(*spec, targetUid);
            if (kind == "nam") {
                p->blocks.insert(p->blocks.begin(), std::move(newBlock));
            } else {
                size_t insertPos = 0;
                for (size_t i = 0; i < p->blocks.size(); ++i) {
                    if (p->blocks[i].type == "amp" || p->blocks[i].type == "nam") {
                        insertPos = i + 1;
                    }
                }
                p->blocks.insert(p->blocks.begin() + static_cast<ptrdiff_t>(insertPos), std::move(newBlock));
            }

            if (id == currentPresetId_) {
                buildAndInstallBoard(*p, false, clientId);
            }
            savePresetsNow();
            wsServer_.broadcastText(buildPresetsJson());
        }

        launchBrowseDialogAsync(clientId, id, kind, targetUid);
        return;
    }

    if (type == "clearFile") {
        if (!msg.contains("id") || !msg["id"].is_string()) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid clearFile request"));
            return;
        }
        const std::string id = msg["id"].get<std::string>();
        Preset* p = presetBank_.findByIdMutable(id);
        if (!p) {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown preset id: " + id));
            return;
        }

        BlockState* targetBlock = nullptr;
        if (msg.contains("uid") && msg["uid"].is_string() && !msg["uid"].get<std::string>().empty()) {
            const std::string uid = msg["uid"].get<std::string>();
            targetBlock = findBlockByUid(*p, uid);
            if (!targetBlock) {
                wsServer_.sendTextToClient(clientId, buildErrorJson("Unknown block uid: " + uid));
                return;
            }
            const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(targetBlock->type);
            if (!spec || !spec->usesFile) {
                wsServer_.sendTextToClient(clientId, buildErrorJson("Block does not use a file: " + uid));
                return;
            }
        } else if (msg.contains("kind") && msg["kind"].is_string()) {
            const std::string kind = msg["kind"].get<std::string>();
            if (kind != "nam" && kind != "ir") {
                wsServer_.sendTextToClient(clientId, buildErrorJson("clearFile kind must be 'nam' or 'ir'"));
                return;
            }
            for (auto& b : p->blocks) {
                const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(b.type);
                if (spec && spec->usesFile && spec->fileKind && kind == spec->fileKind) {
                    targetBlock = &b;
                    break;
                }
            }
        } else {
            wsServer_.sendTextToClient(clientId, buildErrorJson("Invalid clearFile request"));
            return;
        }

        if (targetBlock) {
            targetBlock->file.clear();
            loadedBlockFiles_.erase(targetBlock->uid);
            blockLoadErrors_.erase(targetBlock->uid);
            if (id == currentPresetId_) {
                if (auto it = liveBlocks_.find(targetBlock->uid); it != liveBlocks_.end() && it->second) {
                    it->second->clearFile();
                }
            }
        }

        savePresetsNow();
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
                    buildAndInstallBoard(*p, true, clientId);
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
        {"protocol", 1},
        {"features", json::array({"board"})}
    };
    return j.dump();
}

std::string AppController::buildPresetsJson() const {
    json list = json::array();
    for (const auto& p : presetBank_.presets()) {
        json item = json::object();
        item["id"] = p.id;
        item["name"] = p.name;

        std::string firstNamFile;
        std::string firstIrFile;
        for (const auto& b : p.blocks) {
            if (firstNamFile.empty() && b.type == "nam" && !b.file.empty()) {
                firstNamFile = wideToUtf8(std::filesystem::path(utf8ToWide(b.file)).filename().wstring());
            }
            if (firstIrFile.empty() && b.type == "ir" && !b.file.empty()) {
                firstIrFile = wideToUtf8(std::filesystem::path(utf8ToWide(b.file)).filename().wstring());
            }
        }
        item["nam"] = firstNamFile.empty() ? json(nullptr) : json(firstNamFile);
        item["ir"] = firstIrFile.empty() ? json(nullptr) : json(firstIrFile);

        const BlockState* amp = findFirstBlockByType(p, "amp");
        auto ampParam = [&](const char* key, float fallback) -> float {
            if (!amp) return fallback;
            if (auto it = amp->params.find(key); it != amp->params.end()) return it->second;
            return fallback;
        };

        const BlockState* cab = findFirstBlockByType(p, "cab");
        int cabIdx = 0;
        if (cab) {
            if (auto it = cab->params.find("model"); it != cab->params.end()) {
                cabIdx = static_cast<int>(std::lround(it->second));
            }
        }

        const int charIdx = static_cast<int>(std::lround(ampParam("character", 0.0f)));
        item["params"] = {
            {"character", characterIndexToStr(charIdx)},
            {"gain", ampParam("gain", 5.0f)},
            {"bass", ampParam("bass", 5.0f)},
            {"mid", ampParam("mid", 5.0f)},
            {"treble", ampParam("treble", 5.0f)},
            {"presence", ampParam("presence", 5.0f)},
            {"tightHz", ampParam("tight", 80.0f)},
            {"ampLevelDb", ampParam("level", 0.0f)},
            {"cab", cabIndexToStr(cabIdx)},
            {"inputTrimDb", p.inputTrimDb},
            {"gateThresholdDb", p.gateThresholdDb},
            {"outputLevelDb", p.outputLevelDb}
        };

        json boardBlocks = json::array();
        for (const auto& b : p.blocks) {
            json bParams = json::object();
            for (const auto& [k, v] : b.params) {
                bParams[k] = v;
            }
            json fileVal = nullptr;
            if (!b.file.empty()) {
                fileVal = wideToUtf8(std::filesystem::path(utf8ToWide(b.file)).filename().wstring());
            }
            boardBlocks.push_back({
                {"uid", b.uid},
                {"type", b.type},
                {"enabled", b.enabled},
                {"params", std::move(bParams)},
                {"file", std::move(fileVal)}
            });
        }

        item["board"] = {
            {"inputTrimDb", p.inputTrimDb},
            {"gateThresholdDb", p.gateThresholdDb},
            {"outputLevelDb", p.outputLevelDb},
            {"blocks", std::move(boardBlocks)}
        };

        list.push_back(std::move(item));
    }

    json blockTypes = json::array();
    for (const auto& bt : dsp::blockCatalog()) {
        json paramsArr = json::array();
        for (const auto& ps : bt.params) {
            json optsArr = json::array();
            for (const char* opt : ps.options) {
                if (opt) optsArr.push_back(opt);
            }
            paramsArr.push_back({
                {"key", ps.key ? ps.key : ""},
                {"label", ps.label ? ps.label : ""},
                {"min", ps.min},
                {"max", ps.max},
                {"def", ps.def},
                {"step", ps.step},
                {"unit", ps.unit ? ps.unit : ""},
                {"options", std::move(optsArr)}
            });
        }
        blockTypes.push_back({
            {"id", bt.id ? bt.id : ""},
            {"name", bt.name ? bt.name : ""},
            {"category", bt.category ? bt.category : ""},
            {"usesFile", bt.usesFile},
            {"fileKind", bt.fileKind ? json(bt.fileKind) : json(nullptr)},
            {"params", std::move(paramsArr)}
        });
    }

    json j = {
        {"type", "presets"},
        {"current", currentPresetId_},
        {"list", std::move(list)},
        {"blockTypes", std::move(blockTypes)},
        {"limits", {
            {"maxBlocks", dsp::kMaxBoardBlocks},
            {"maxNam", dsp::kMaxNamBlocks}
        }}
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
