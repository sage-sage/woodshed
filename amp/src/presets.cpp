#include "presets.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <random>
#include <unordered_map>
#include <unordered_set>
#include <utility>

#ifdef _WIN32
#include <windows.h>
#endif

#include "json.hpp"

namespace wsamp {

namespace {

using json = nlohmann::json;

constexpr int kPresetFileVersion = 3;

std::wstring utf8ToWidePath(const std::string& utf8) {
    if (utf8.empty()) return {};
#ifdef _WIN32
    const int needed = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (needed <= 0) return {};
    std::wstring out(static_cast<size_t>(needed), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), needed);
    return out;
#else
    return std::wstring(utf8.begin(), utf8.end());
#endif
}

std::string wideToUtf8Path(const std::wstring& wide) {
    if (wide.empty()) return {};
#ifdef _WIN32
    const int needed = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()),
                                           nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return {};
    std::string out(static_cast<size_t>(needed), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()),
                        out.data(), needed, nullptr, nullptr);
    return out;
#else
    return std::string(wide.begin(), wide.end());
#endif
}

std::string extractFilenameUtf8(const std::string& fullPath) {
    if (fullPath.empty()) return {};
    return wideToUtf8Path(std::filesystem::path(utf8ToWidePath(fullPath)).filename().wstring());
}

std::string trimWhitespace(const std::string& s) {
    size_t start = 0;
    while (start < s.size() && std::isspace(static_cast<unsigned char>(s[start]))) {
        ++start;
    }
    size_t end = s.size();
    while (end > start && std::isspace(static_cast<unsigned char>(s[end - 1]))) {
        --end;
    }
    return s.substr(start, end - start);
}

size_t utf8CodepointCount(const std::string& s) noexcept {
    size_t count = 0;
    for (unsigned char c : s) {
        if ((c & 0xC0u) != 0x80u) {
            ++count;
        }
    }
    return count;
}

std::string truncateUtf8Codepoints(const std::string& s, size_t maxCp) {
    size_t count = 0;
    size_t i = 0;
    while (i < s.size()) {
        if ((static_cast<unsigned char>(s[i]) & 0xC0u) != 0x80u) {
            if (count == maxCp) break;
            ++count;
        }
        ++i;
    }
    return s.substr(0, i);
}

std::string randomHex8() {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<uint32_t> dist(0, 0xFFFFFFFFu);
    char buf[16]{};
    std::snprintf(buf, sizeof(buf), "%08x", dist(gen));
    return std::string(buf);
}

void applyRowLayout(Preset& p) {
    p.inX = 1.0f;
    p.inY = 6.0f;
    for (size_t i = 0; i < p.blocks.size(); ++i) {
        p.blocks[i].x = 10.0f + 9.0f * static_cast<float>(i);
        p.blocks[i].y = 5.0f;
    }
    p.outX = 10.0f + 9.0f * static_cast<float>(p.blocks.size());
    p.outY = 6.0f;

    p.cables.clear();
    if (p.blocks.empty()) {
        p.cables.push_back(CableState{dsp::kInputUid, dsp::kOutputUid, 0});
    } else {
        p.cables.push_back(CableState{dsp::kInputUid, p.blocks.front().uid, 0});
        for (size_t i = 0; i + 1 < p.blocks.size(); ++i) {
            p.cables.push_back(CableState{p.blocks[i].uid, p.blocks[i + 1].uid, 0});
        }
        p.cables.push_back(CableState{p.blocks.back().uid, dsp::kOutputUid, 0});
    }
}

bool diffFloat(float a, float b) noexcept {
    return std::abs(a - b) > 1e-4f;
}

float clampParamSpec(const dsp::ParamSpec& ps, float val) noexcept {
    if (!std::isfinite(val)) val = ps.def;
    if (!ps.options.empty()) {
        val = std::round(val);
    }
    return std::clamp(val, ps.min, ps.max);
}

int stringToCharacterIndex(const std::string& s, int fallback) {
    if (s == "Clean" || s == "clean") return 0;
    if (s == "Breakup" || s == "breakup") return 1;
    if (s == "Crunch" || s == "crunch") return 2;
    if (s == "HighGain" || s == "high_gain" || s == "highgain") return 3;
    if (s == "Fuzz" || s == "fuzz") return 4;
    return fallback;
}

int stringToCabIndex(const std::string& s, int fallback) {
    if (s == "C412" || s == "c412") return 0;
    if (s == "O212" || s == "o212") return 1;
    if (s == "O112" || s == "o112") return 2;
    if (s == "Acoustic" || s == "acoustic") return 3;
    if (s == "Bass" || s == "bass") return 4;
    return fallback;
}

BlockState makeBlockStateWithSpec(dsp::BlockType type,
                                  const std::string& uid,
                                  std::initializer_list<std::pair<const char*, float>> overrides) {
    BlockState bs;
    bs.uid = uid;
    bs.enabled = true;
    const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(type);
    if (spec) {
        bs.type = spec->id;
        for (const auto& ps : spec->params) {
            bs.params[ps.key] = clampParamSpec(ps, ps.def);
        }
        for (const auto& [k, v] : overrides) {
            bool matched = false;
            for (const auto& ps : spec->params) {
                if (std::string(ps.key) == k) {
                    bs.params[ps.key] = clampParamSpec(ps, v);
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                bs.params[k] = v;
            }
        }
    } else {
        for (const auto& [k, v] : overrides) {
            bs.params[k] = v;
        }
    }
    return bs;
}

void setParamByIndexOrKey(BlockState& bs,
                          const dsp::BlockTypeSpec* spec,
                          size_t idx,
                          const char* fallbackKey,
                          float value) {
    if (spec && idx < spec->params.size()) {
        const auto& ps = spec->params[idx];
        bs.params[ps.key] = clampParamSpec(ps, value);
    } else {
        bs.params[fallbackKey] = value;
    }
}

void normalizeBlockParams(BlockState& bs, const dsp::BlockTypeSpec& spec) {
    std::map<std::string, float> normalized;
    for (const auto& ps : spec.params) {
        float v = ps.def;
        if (auto it = bs.params.find(ps.key); it != bs.params.end()) {
            v = it->second;
        }
        normalized[ps.key] = clampParamSpec(ps, v);
    }
    bs.params = std::move(normalized);
    if (!spec.usesFile) {
        bs.file.clear();
    }
}

int parseUidNumber(const std::string& uid) noexcept {
    if (uid.size() < 2 || uid[0] != 'b') return 0;
    int val = 0;
    for (size_t i = 1; i < uid.size(); ++i) {
        const unsigned char c = static_cast<unsigned char>(uid[i]);
        if (!std::isdigit(c)) return 0;
        val = val * 10 + (c - '0');
    }
    return val;
}

void sanitizeUidsAndNextUid(Preset& p, int requestedNextUid) {
    std::unordered_set<std::string> seen;
    int maxNum = 0;
    for (const auto& b : p.blocks) {
        if (!b.uid.empty()) {
            maxNum = std::max(maxNum, parseUidNumber(b.uid));
        }
    }
    int nextNum = std::max({1, requestedNextUid, maxNum + 1});
    for (auto& b : p.blocks) {
        if (b.uid.empty() || seen.count(b.uid) > 0) {
            b.uid = "b" + std::to_string(nextNum++);
        }
        seen.insert(b.uid);
    }
    p.nextUid = std::max(nextNum, static_cast<int>(p.blocks.size()) + 1);
}

BlockState* findFirstBlockOfType(Preset& p, const std::string& type) {
    for (auto& b : p.blocks) {
        if (b.type == type) return &b;
    }
    return nullptr;
}

bool presetsEqual(const Preset& a, const Preset& b) noexcept {
    if (a.id != b.id || a.name != b.name) return false;
    if (a.builtin != b.builtin || a.basedOn != b.basedOn) return false;
    if (diffFloat(a.inputTrimDb, b.inputTrimDb)) return false;
    if (diffFloat(a.gateThresholdDb, b.gateThresholdDb)) return false;
    if (diffFloat(a.outputLevelDb, b.outputLevelDb)) return false;
    if (diffFloat(a.inX, b.inX) || diffFloat(a.inY, b.inY)) return false;
    if (diffFloat(a.outX, b.outX) || diffFloat(a.outY, b.outY)) return false;
    if (a.blocks.size() != b.blocks.size()) return false;
    for (size_t i = 0; i < a.blocks.size(); ++i) {
        const BlockState& ba = a.blocks[i];
        const BlockState& bb = b.blocks[i];
        if (ba.uid != bb.uid || ba.type != bb.type || ba.enabled != bb.enabled ||
            ba.file != bb.file || ba.missingFile != bb.missingFile ||
            diffFloat(ba.x, bb.x) || diffFloat(ba.y, bb.y)) {
            return false;
        }
        if (ba.params.size() != bb.params.size()) return false;
        for (const auto& [k, va] : ba.params) {
            const auto it = bb.params.find(k);
            if (it == bb.params.end() || diffFloat(va, it->second)) {
                return false;
            }
        }
    }
    if (a.cables.size() != b.cables.size()) return false;
    for (size_t i = 0; i < a.cables.size(); ++i) {
        if (a.cables[i].from != b.cables[i].from ||
            a.cables[i].to != b.cables[i].to ||
            a.cables[i].port != b.cables[i].port) {
            return false;
        }
    }
    return true;
}

json serializePreset(const Preset& p) {
    json nodesArr = json::array();
    for (const auto& b : p.blocks) {
        json jp = json::object();
        for (const auto& [k, v] : b.params) {
            jp[k] = v;
        }
        json jb = {
            {"uid", b.uid},
            {"type", b.type},
            {"enabled", b.enabled},
            {"params", std::move(jp)},
            {"x", b.x},
            {"y", b.y}
        };
        if (!b.file.empty()) {
            jb["file"] = b.file;
        }
        if (!b.missingFile.empty()) {
            jb["missingFile"] = b.missingFile;
        }
        nodesArr.push_back(std::move(jb));
    }

    json cablesArr = json::array();
    for (const auto& c : p.cables) {
        cablesArr.push_back({
            {"from", c.from},
            {"to", c.to},
            {"port", c.port}
        });
    }

    return json{
        {"id", p.id},
        {"name", p.name},
        {"builtin", p.builtin},
        {"basedOn", p.basedOn},
        {"inputTrimDb", p.inputTrimDb},
        {"gateThresholdDb", p.gateThresholdDb},
        {"outputLevelDb", p.outputLevelDb},
        {"nextUid", p.nextUid},
        {"io", {
            {"inX", p.inX},
            {"inY", p.inY},
            {"outX", p.outX},
            {"outY", p.outY}
        }},
        {"nodes", std::move(nodesArr)},
        {"cables", std::move(cablesArr)}
    };
}

void parseBlocksArray(const json& blocksJson, Preset& outPreset) {
    std::vector<BlockState> newBlocks;
    int namCount = 0;
    for (const auto& jb : blocksJson) {
        if (!jb.is_object() || !jb.contains("type") || !jb["type"].is_string()) continue;
        const std::string bType = jb["type"].get<std::string>();
        const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(bType);
        if (!spec) continue; // drop unknown block types

        if (static_cast<int>(newBlocks.size()) >= dsp::kMaxBoardBlocks) break;
        if (spec->type == dsp::BlockType::Nam) {
            if (namCount >= dsp::kMaxNamBlocks) continue;
            ++namCount;
        }

        BlockState bs;
        bs.type = spec->id;
        if (jb.contains("uid") && jb["uid"].is_string()) {
            bs.uid = jb["uid"].get<std::string>();
        }
        if (jb.contains("enabled") && jb["enabled"].is_boolean()) {
            bs.enabled = jb["enabled"].get<bool>();
        }
        if (jb.contains("x") && jb["x"].is_number()) {
            const float vx = jb["x"].get<float>();
            if (std::isfinite(vx)) bs.x = vx;
        }
        if (jb.contains("y") && jb["y"].is_number()) {
            const float vy = jb["y"].get<float>();
            if (std::isfinite(vy)) bs.y = vy;
        }
        if (spec->usesFile) {
            if (jb.contains("file") && jb["file"].is_string()) {
                bs.file = jb["file"].get<std::string>();
            }
            if (bs.file.empty() && jb.contains("missingFile") && jb["missingFile"].is_string()) {
                bs.missingFile = jb["missingFile"].get<std::string>();
            }
        }
        if (jb.contains("params") && jb["params"].is_object()) {
            for (const auto& [pk, pv] : jb["params"].items()) {
                if (pv.is_number()) {
                    bs.params[pk] = pv.get<float>();
                }
            }
        }
        normalizeBlockParams(bs, *spec);
        newBlocks.push_back(std::move(bs));
    }
    outPreset.blocks = std::move(newBlocks);
}

} // namespace

PresetBank::PresetBank()
    : presets_(makeBuiltinDefaults()) {
}

std::filesystem::path PresetBank::defaultPresetsPath() {
#ifdef _WIN32
    if (const char* appData = std::getenv("APPDATA"); appData != nullptr && appData[0] != '\0') {
        return std::filesystem::path(appData) / "WoodshedAmp" / "presets.json";
    }
#endif
    if (const char* home = std::getenv("HOME"); home != nullptr && home[0] != '\0') {
        return std::filesystem::path(home) / ".config" / "WoodshedAmp" / "presets.json";
    }
    return std::filesystem::path("presets.json");
}

bool PresetBank::canAddBlock(const Preset& preset, const std::string& type, std::string& errorOut) {
    errorOut.clear();
    const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(type);
    if (!spec) {
        errorOut = "Unknown block type: " + type;
        return false;
    }
    if (static_cast<int>(preset.blocks.size()) >= dsp::kMaxBoardBlocks) {
        errorOut = "Board cannot exceed " + std::to_string(dsp::kMaxBoardBlocks) + " blocks";
        return false;
    }
    if (spec->type == dsp::BlockType::Nam) {
        int namCount = 0;
        for (const auto& b : preset.blocks) {
            if (b.type == "nam") ++namCount;
        }
        if (namCount >= dsp::kMaxNamBlocks) {
            errorOut = "Board cannot exceed " + std::to_string(dsp::kMaxNamBlocks) + " NAM blocks";
            return false;
        }
    }
    return true;
}

bool PresetBank::canAddCable(const Preset& preset, const CableState& cable, std::string& errorOut) {
    errorOut.clear();
    if (static_cast<int>(preset.cables.size()) >= dsp::kMaxCables) {
        errorOut = "Board cannot exceed " + std::to_string(dsp::kMaxCables) + " cables";
        return false;
    }
    if (cable.from == dsp::kOutputUid) {
        errorOut = "Cable cannot start at Output";
        return false;
    }
    if (cable.to == dsp::kInputUid) {
        errorOut = "Cable cannot end at Input";
        return false;
    }
    if (cable.from.empty() || cable.to.empty()) {
        errorOut = "Cable endpoints cannot be empty";
        return false;
    }
    if (cable.from == cable.to) {
        errorOut = "Cable cannot connect a node to itself";
        return false;
    }

    if (cable.from != dsp::kInputUid) {
        bool foundFrom = false;
        for (const auto& b : preset.blocks) {
            if (b.uid == cable.from) {
                foundFrom = true;
                break;
            }
        }
        if (!foundFrom) {
            errorOut = "Unknown source uid: " + cable.from;
            return false;
        }
    }

    int targetInputs = 0;
    if (cable.to == dsp::kOutputUid) {
        targetInputs = 1;
    } else {
        const BlockState* targetBlock = nullptr;
        for (const auto& b : preset.blocks) {
            if (b.uid == cable.to) {
                targetBlock = &b;
                break;
            }
        }
        if (!targetBlock) {
            errorOut = "Unknown destination uid: " + cable.to;
            return false;
        }
        const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(targetBlock->type);
        if (!spec) {
            errorOut = "Unknown block type: " + targetBlock->type;
            return false;
        }
        targetInputs = spec->inputs;
    }

    if (cable.port < 0 || cable.port >= targetInputs) {
        errorOut = "Invalid input port " + std::to_string(cable.port) + " for " + cable.to;
        return false;
    }

    for (const auto& existing : preset.cables) {
        if (existing.from == cable.from && existing.to == cable.to && existing.port == cable.port) {
            errorOut = "Duplicate cable";
            return false;
        }
    }

    std::vector<dsp::Cable> dspCables;
    dspCables.reserve(preset.cables.size());
    for (const auto& c : preset.cables) {
        dspCables.push_back(dsp::Cable{c.from, c.to, c.port});
    }
    if (dsp::wouldCreateCycle(dspCables, dsp::Cable{cable.from, cable.to, cable.port})) {
        errorOut = "Cable would create a cycle";
        return false;
    }

    return true;
}

json PresetBank::toExportJson(const Preset& preset) {
    json nodesArr = json::array();
    for (const auto& b : preset.blocks) {
        json jp = json::object();
        for (const auto& [k, v] : b.params) {
            jp[k] = v;
        }
        json fileNameVal = nullptr;
        json filePathVal = nullptr;
        if (!b.file.empty()) {
            fileNameVal = extractFilenameUtf8(b.file);
            filePathVal = b.file;
        } else if (!b.missingFile.empty()) {
            fileNameVal = b.missingFile;
        }
        nodesArr.push_back({
            {"uid", b.uid},
            {"type", b.type},
            {"enabled", b.enabled},
            {"params", std::move(jp)},
            {"x", b.x},
            {"y", b.y},
            {"file", std::move(fileNameVal)},
            {"filePath", std::move(filePathVal)}
        });
    }

    json cablesArr = json::array();
    for (const auto& c : preset.cables) {
        cablesArr.push_back({
            {"from", c.from},
            {"to", c.to},
            {"port", c.port}
        });
    }

    return json{
        {"format", "woodshed-preset"},
        {"version", 1},
        {"name", preset.name},
        {"basedOn", preset.basedOn},
        {"inputTrimDb", preset.inputTrimDb},
        {"gateThresholdDb", preset.gateThresholdDb},
        {"outputLevelDb", preset.outputLevelDb},
        {"io", {
            {"inX", preset.inX},
            {"inY", preset.inY},
            {"outX", preset.outX},
            {"outY", preset.outY}
        }},
        {"nodes", std::move(nodesArr)},
        {"cables", std::move(cablesArr)}
    };
}

std::optional<Preset> PresetBank::fromExportJson(const json& j, std::string& errorOut) {
    errorOut.clear();
    if (!j.is_object()) {
        errorOut = "Preset export must be a JSON object";
        return std::nullopt;
    }
    if (j.contains("format") && j["format"].is_string() && j["format"].get<std::string>() != "woodshed-preset") {
        errorOut = "Invalid preset export format";
        return std::nullopt;
    }
    if (j.contains("version") && j["version"].is_number_integer() && j["version"].get<int>() != 1) {
        errorOut = "Unsupported preset export version";
        return std::nullopt;
    }

    Preset p;
    p.id = "u_" + randomHex8();
    p.builtin = false;
    p.name = "Imported Preset";
    if (j.contains("name") && j["name"].is_string()) {
        std::string trimmed = trimWhitespace(j["name"].get<std::string>());
        if (!trimmed.empty()) {
            p.name = truncateUtf8Codepoints(trimmed, 40);
        }
    }
    if (j.contains("basedOn") && j["basedOn"].is_string()) {
        p.basedOn = j["basedOn"].get<std::string>();
    }
    if (j.contains("inputTrimDb") && j["inputTrimDb"].is_number()) {
        const float v = j["inputTrimDb"].get<float>();
        if (std::isfinite(v)) p.inputTrimDb = std::clamp(v, -24.0f, 24.0f);
    }
    if (j.contains("gateThresholdDb") && j["gateThresholdDb"].is_number()) {
        const float v = j["gateThresholdDb"].get<float>();
        if (std::isfinite(v)) p.gateThresholdDb = std::clamp(v, -80.0f, 0.0f);
    }
    if (j.contains("outputLevelDb") && j["outputLevelDb"].is_number()) {
        const float v = j["outputLevelDb"].get<float>();
        if (std::isfinite(v)) p.outputLevelDb = std::clamp(v, -60.0f, 24.0f);
    }
    if (j.contains("io") && j["io"].is_object()) {
        const json& jio = j["io"];
        if (jio.contains("inX") && jio["inX"].is_number() && std::isfinite(jio["inX"].get<float>())) {
            p.inX = jio["inX"].get<float>();
        }
        if (jio.contains("inY") && jio["inY"].is_number() && std::isfinite(jio["inY"].get<float>())) {
            p.inY = jio["inY"].get<float>();
        }
        if (jio.contains("outX") && jio["outX"].is_number() && std::isfinite(jio["outX"].get<float>())) {
            p.outX = jio["outX"].get<float>();
        }
        if (jio.contains("outY") && jio["outY"].is_number() && std::isfinite(jio["outY"].get<float>())) {
            p.outY = jio["outY"].get<float>();
        }
    }

    std::unordered_map<std::string, std::string> uidMap;
    int nextNum = 1;
    int namCount = 0;
    if (j.contains("nodes") && j["nodes"].is_array()) {
        for (const auto& jn : j["nodes"]) {
            if (!jn.is_object() || !jn.contains("type") || !jn["type"].is_string()) continue;
            const std::string bType = jn["type"].get<std::string>();
            const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(bType);
            if (!spec) continue; // unknown block types dropped

            if (static_cast<int>(p.blocks.size()) >= dsp::kMaxBoardBlocks) break;
            if (spec->type == dsp::BlockType::Nam) {
                if (namCount >= dsp::kMaxNamBlocks) continue;
                ++namCount;
            }

            const std::string freshUid = "b" + std::to_string(nextNum++);
            if (jn.contains("uid") && jn["uid"].is_string()) {
                const std::string oldUid = jn["uid"].get<std::string>();
                if (!oldUid.empty() && oldUid != dsp::kInputUid && oldUid != dsp::kOutputUid && !uidMap.count(oldUid)) {
                    uidMap[oldUid] = freshUid;
                }
            }

            BlockState bs;
            bs.uid = freshUid;
            bs.type = spec->id;
            bs.enabled = (jn.contains("enabled") && jn["enabled"].is_boolean()) ? jn["enabled"].get<bool>() : true;
            bs.x = 10.0f + 9.0f * static_cast<float>(p.blocks.size());
            bs.y = 5.0f;
            if (jn.contains("x") && jn["x"].is_number() && std::isfinite(jn["x"].get<float>())) {
                bs.x = jn["x"].get<float>();
            }
            if (jn.contains("y") && jn["y"].is_number() && std::isfinite(jn["y"].get<float>())) {
                bs.y = jn["y"].get<float>();
            }
            if (jn.contains("params") && jn["params"].is_object()) {
                for (const auto& [pk, pv] : jn["params"].items()) {
                    if (pv.is_number()) {
                        bs.params[pk] = pv.get<float>();
                    }
                }
            }
            normalizeBlockParams(bs, *spec);

            if (spec->usesFile) {
                std::string rawFilePath;
                std::string rawFileName;
                if (jn.contains("filePath") && jn["filePath"].is_string()) {
                    rawFilePath = jn["filePath"].get<std::string>();
                }
                if (jn.contains("file") && jn["file"].is_string()) {
                    rawFileName = jn["file"].get<std::string>();
                }
                if (!rawFilePath.empty()) {
                    std::error_code ec;
                    const std::filesystem::path fsPath(utf8ToWidePath(rawFilePath));
                    if (std::filesystem::exists(fsPath, ec) && !std::filesystem::is_directory(fsPath, ec)) {
                        bs.file = rawFilePath;
                    } else {
                        bs.file.clear();
                        bs.missingFile = !rawFileName.empty() ? rawFileName : extractFilenameUtf8(rawFilePath);
                    }
                } else if (!rawFileName.empty()) {
                    bs.file.clear();
                    bs.missingFile = rawFileName;
                }
            }

            p.blocks.push_back(std::move(bs));
        }
    }
    p.nextUid = nextNum;

    if (j.contains("cables") && j["cables"].is_array()) {
        for (const auto& jc : j["cables"]) {
            if (!jc.is_object() || !jc.contains("from") || !jc["from"].is_string() ||
                !jc.contains("to") || !jc["to"].is_string()) {
                continue;
            }
            const std::string rawFrom = jc["from"].get<std::string>();
            const std::string rawTo = jc["to"].get<std::string>();
            const int port = (jc.contains("port") && jc["port"].is_number_integer()) ? jc["port"].get<int>() : 0;

            std::string mappedFrom;
            if (rawFrom == dsp::kInputUid) {
                mappedFrom = dsp::kInputUid;
            } else if (auto it = uidMap.find(rawFrom); it != uidMap.end()) {
                mappedFrom = it->second;
            } else {
                continue; // source node was unknown/dropped
            }

            std::string mappedTo;
            if (rawTo == dsp::kOutputUid) {
                mappedTo = dsp::kOutputUid;
            } else if (auto it = uidMap.find(rawTo); it != uidMap.end()) {
                mappedTo = it->second;
            } else {
                continue; // target node was unknown/dropped
            }

            CableState cs{mappedFrom, mappedTo, port};
            std::string cableErr;
            if (canAddCable(p, cs, cableErr)) {
                p.cables.push_back(std::move(cs));
            }
        }
    }

    return p;
}

std::vector<Preset> PresetBank::makeBuiltinDefaults() {
    std::vector<Preset> list;
    list.reserve(10);

    auto add = [&](const char* id,
                   const char* name,
                   int charIdx,
                   float gain,
                   float b, float m, float t, float p,
                   float tightHz,
                   int cabIdx,
                   float gateDb,
                   float chorusMix,
                   float delayMs, float delayFb, float delayMix,
                   float reverbMix) {
        Preset pr;
        pr.id = id;
        pr.name = name;
        pr.builtin = true;
        pr.basedOn = id;
        pr.inputTrimDb = 0.0f;
        pr.gateThresholdDb = gateDb;
        pr.outputLevelDb = 0.0f;

        int uidNum = 1;
        auto nextId = [&]() { return "b" + std::to_string(uidNum++); };

        pr.blocks.push_back(makeBlockStateWithSpec(
            dsp::BlockType::Amp,
            nextId(),
            {
                {"character", static_cast<float>(charIdx)},
                {"gain", gain},
                {"bass", b},
                {"mid", m},
                {"treble", t},
                {"presence", p},
                {"tight", tightHz},
                {"level", 0.0f}
            }));

        pr.blocks.push_back(makeBlockStateWithSpec(
            dsp::BlockType::Cab,
            nextId(),
            {
                {"model", static_cast<float>(cabIdx)}
            }));

        if (chorusMix > 0.0f) {
            pr.blocks.push_back(makeBlockStateWithSpec(
                dsp::BlockType::Chorus,
                nextId(),
                {
                    {"mix", chorusMix}
                }));
        }

        if (delayMix > 0.0f) {
            pr.blocks.push_back(makeBlockStateWithSpec(
                dsp::BlockType::Delay,
                nextId(),
                {
                    {"time", delayMs},
                    {"feedback", delayFb},
                    {"mix", delayMix}
                }));
        }

        if (reverbMix > 0.0f) {
            pr.blocks.push_back(makeBlockStateWithSpec(
                dsp::BlockType::Reverb,
                nextId(),
                {
                    {"size", 0.5f},
                    {"mix", reverbMix},
                    {"type", 0.0f}
                }));
        }

        pr.nextUid = uidNum;
        applyRowLayout(pr);
        list.push_back(std::move(pr));
    };

    // Character indices: Clean=0, Breakup=1, Crunch=2, HighGain=3, Fuzz=4
    // Cab indices: C412=0, O212=1, O112=2, Acoustic=3, Bass=4
    add("clean", "Clean", 0, 3.0f, 5.0f, 5.0f, 6.0f, 6.0f, 60.0f,
        2, -70.0f, 0.15f, 0.0f, 0.0f, 0.0f, 0.18f);

    add("jazz", "Warm Jazz", 0, 2.0f, 6.0f, 6.0f, 3.5f, 4.0f, 50.0f,
        2, -72.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.12f);

    add("breakup", "Edge of Breakup", 1, 5.0f, 5.0f, 6.0f, 6.0f, 6.0f, 80.0f,
        1, -65.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.14f);

    add("crunch", "Crunch", 2, 5.0f, 5.0f, 6.0f, 6.0f, 6.0f, 100.0f,
        0, -60.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.10f);

    add("rock_lead", "Rock Lead", 2, 8.0f, 5.0f, 7.0f, 6.0f, 6.0f, 110.0f,
        0, -58.0f, 0.0f, 380.0f, 0.30f, 0.18f, 0.15f);

    add("high_gain", "High Gain", 3, 6.0f, 6.0f, 4.0f, 6.0f, 6.0f, 140.0f,
        0, -52.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.08f);

    add("metal", "Metal", 3, 8.0f, 6.0f, 3.5f, 6.5f, 6.5f, 220.0f,
        0, -48.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f);

    add("fuzz", "Fuzz", 4, 7.0f, 6.0f, 4.0f, 5.0f, 5.0f, 40.0f,
        1, -60.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.10f);

    add("acoustic", "Acoustic Sim", 0, 1.0f, 5.0f, 5.0f, 6.0f, 6.0f, 90.0f,
        3, -72.0f, 0.10f, 0.0f, 0.0f, 0.0f, 0.20f);

    add("bass", "Bass", 0, 3.0f, 6.0f, 5.0f, 5.0f, 5.0f, 30.0f,
        4, -70.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f);

    return list;
}

void PresetBank::resetToDefaults() {
    presets_ = makeBuiltinDefaults();
}

const Preset* PresetBank::findById(const std::string& id) const noexcept {
    for (const auto& p : presets_) {
        if (p.id == id) return &p;
    }
    return nullptr;
}

Preset* PresetBank::findByIdMutable(const std::string& id) noexcept {
    for (auto& p : presets_) {
        if (p.id == id) return &p;
    }
    return nullptr;
}

int PresetBank::customPresetCount() const noexcept {
    int count = 0;
    for (const auto& p : presets_) {
        if (!p.builtin) ++count;
    }
    return count;
}

std::string PresetBank::generateUniqueCustomId() const {
    for (;;) {
        std::string candidate = "u_" + randomHex8();
        if (findById(candidate) == nullptr) {
            return candidate;
        }
    }
}

Preset& PresetBank::createCustom(const std::string& name, const std::string& basedOn) {
    Preset pr;
    pr.id = generateUniqueCustomId();
    std::string trimmed = trimWhitespace(name);
    pr.name = trimmed.empty() ? "New Preset" : truncateUtf8Codepoints(trimmed, 40);
    pr.builtin = false;
    pr.basedOn = basedOn;
    pr.inputTrimDb = 0.0f;
    pr.gateThresholdDb = -70.0f;
    pr.outputLevelDb = 0.0f;
    pr.blocks.push_back(makeBlockStateWithSpec(dsp::BlockType::Amp, "b1", {}));
    pr.blocks.push_back(makeBlockStateWithSpec(dsp::BlockType::Cab, "b2", {}));
    pr.nextUid = 3;
    applyRowLayout(pr);
    presets_.push_back(std::move(pr));
    return presets_.back();
}

Preset& PresetBank::addCustomPreset(Preset preset) {
    preset.builtin = false;
    if (preset.id.empty() || findById(preset.id) != nullptr) {
        preset.id = generateUniqueCustomId();
    }
    presets_.push_back(std::move(preset));
    return presets_.back();
}

Preset* PresetBank::duplicatePreset(const std::string& sourceId, const std::string& requestedName, std::string& errorOut) {
    errorOut.clear();
    const Preset* source = findById(sourceId);
    if (!source) {
        errorOut = "Unknown preset id: " + sourceId;
        return nullptr;
    }
    if (customPresetCount() >= kMaxCustomPresets) {
        errorOut = "Maximum of " + std::to_string(kMaxCustomPresets) + " custom presets reached";
        return nullptr;
    }

    Preset copy = *source;
    copy.id = generateUniqueCustomId();
    copy.builtin = false;
    if (!source->basedOn.empty()) {
        copy.basedOn = source->basedOn;
    } else if (source->builtin) {
        copy.basedOn = source->id;
    } else {
        copy.basedOn.clear();
    }

    std::string trimmed = trimWhitespace(requestedName);
    if (trimmed.empty()) {
        trimmed = source->name + " copy";
    }
    copy.name = truncateUtf8Codepoints(trimmed, 40);

    presets_.push_back(std::move(copy));
    return &presets_.back();
}

bool PresetBank::renamePreset(const std::string& id, const std::string& newName, std::string& errorOut) {
    errorOut.clear();
    Preset* target = findByIdMutable(id);
    if (!target) {
        errorOut = "Unknown preset id: " + id;
        return false;
    }
    if (target->builtin) {
        errorOut = "Built-in presets cannot be renamed";
        return false;
    }
    const std::string trimmed = trimWhitespace(newName);
    const size_t cpLen = utf8CodepointCount(trimmed);
    if (cpLen < 1 || cpLen > 40) {
        errorOut = "Preset name must be 1 to 40 characters";
        return false;
    }
    target->name = trimmed;
    return true;
}

bool PresetBank::removePreset(const std::string& id, std::string& errorOut) {
    errorOut.clear();
    auto it = std::find_if(presets_.begin(), presets_.end(), [&](const Preset& p) { return p.id == id; });
    if (it == presets_.end()) {
        errorOut = "Unknown preset id: " + id;
        return false;
    }
    if (it->builtin) {
        errorOut = "Built-in presets cannot be deleted";
        return false;
    }
    presets_.erase(it);
    return true;
}

bool PresetBank::loadOverrides(const std::filesystem::path& jsonPath, std::string& errorOut) {
    errorOut.clear();
    resetToDefaults();

    std::error_code ec;
    if (!std::filesystem::exists(jsonPath, ec)) {
        return true; // Missing file = defaults
    }

    std::ifstream in(jsonPath);
    if (!in) {
        errorOut = "Failed to open presets file: " + jsonPath.string();
        return false;
    }

    json root;
    try {
        in >> root;
    } catch (const std::exception& e) {
        errorOut = std::string("Invalid presets JSON: ") + e.what();
        return false;
    }

    if (!root.is_object()) {
        errorOut = "presets.json root must be a JSON object";
        return false;
    }

    if (root.contains("version") && root["version"].is_number_integer()) {
        const int ver = root["version"].get<int>();
        if (ver != 2 && ver != kPresetFileVersion) {
            errorOut = "Unsupported presets.json version: " + std::to_string(ver);
            return false;
        }
        if (!root.contains("presets") || !root["presets"].is_array()) {
            if (ver == 2) {
                std::string migrateSaveErr;
                saveOverridesAtomic(jsonPath, migrateSaveErr);
            }
            return true;
        }

        for (const auto& item : root["presets"]) {
            if (!item.is_object() || !item.contains("id") || !item["id"].is_string()) continue;
            const std::string id = item["id"].get<std::string>();
            Preset* existingBuiltin = findByIdMutable(id);
            const bool isBuiltinOverride = (existingBuiltin != nullptr && existingBuiltin->builtin);

            if (ver == 2 && !isBuiltinOverride) {
                continue; // v2 only stored built-in overrides
            }

            if (!isBuiltinOverride) {
                if (customPresetCount() >= kMaxCustomPresets) continue;
            }

            Preset loaded = isBuiltinOverride ? *existingBuiltin : Preset{};
            loaded.id = id;
            loaded.builtin = isBuiltinOverride;
            if (isBuiltinOverride) {
                loaded.basedOn = id;
            } else if (item.contains("basedOn") && item["basedOn"].is_string()) {
                loaded.basedOn = item["basedOn"].get<std::string>();
            }

            if (item.contains("name") && item["name"].is_string()) {
                std::string nm = item["name"].get<std::string>();
                if (!isBuiltinOverride) {
                    nm = trimWhitespace(nm);
                    if (nm.empty()) nm = "Custom Preset";
                    nm = truncateUtf8Codepoints(nm, 40);
                }
                loaded.name = std::move(nm);
            } else if (!isBuiltinOverride) {
                loaded.name = "Custom Preset";
            }

            if (item.contains("inputTrimDb") && item["inputTrimDb"].is_number()) {
                const float v = item["inputTrimDb"].get<float>();
                if (std::isfinite(v)) loaded.inputTrimDb = std::clamp(v, -24.0f, 24.0f);
            }
            if (item.contains("gateThresholdDb") && item["gateThresholdDb"].is_number()) {
                const float v = item["gateThresholdDb"].get<float>();
                if (std::isfinite(v)) loaded.gateThresholdDb = std::clamp(v, -80.0f, 0.0f);
            }
            if (item.contains("outputLevelDb") && item["outputLevelDb"].is_number()) {
                const float v = item["outputLevelDb"].get<float>();
                if (std::isfinite(v)) loaded.outputLevelDb = std::clamp(v, -60.0f, 24.0f);
            }

            if (ver == kPresetFileVersion && item.contains("io") && item["io"].is_object()) {
                const json& jio = item["io"];
                if (jio.contains("inX") && jio["inX"].is_number() && std::isfinite(jio["inX"].get<float>())) {
                    loaded.inX = jio["inX"].get<float>();
                }
                if (jio.contains("inY") && jio["inY"].is_number() && std::isfinite(jio["inY"].get<float>())) {
                    loaded.inY = jio["inY"].get<float>();
                }
                if (jio.contains("outX") && jio["outX"].is_number() && std::isfinite(jio["outX"].get<float>())) {
                    loaded.outX = jio["outX"].get<float>();
                }
                if (jio.contains("outY") && jio["outY"].is_number() && std::isfinite(jio["outY"].get<float>())) {
                    loaded.outY = jio["outY"].get<float>();
                }
            }

            if (item.contains("nodes") && item["nodes"].is_array()) {
                parseBlocksArray(item["nodes"], loaded);
            } else if (item.contains("blocks") && item["blocks"].is_array()) {
                parseBlocksArray(item["blocks"], loaded);
            }

            const int reqNext = (item.contains("nextUid") && item["nextUid"].is_number_integer())
                                    ? item["nextUid"].get<int>()
                                    : 1;
            sanitizeUidsAndNextUid(loaded, reqNext);

            if (ver == 2) {
                applyRowLayout(loaded);
            } else {
                loaded.cables.clear();
                if (item.contains("cables") && item["cables"].is_array()) {
                    for (const auto& jc : item["cables"]) {
                        if (!jc.is_object() || !jc.contains("from") || !jc["from"].is_string() ||
                            !jc.contains("to") || !jc["to"].is_string()) {
                            continue;
                        }
                        CableState cs;
                        cs.from = jc["from"].get<std::string>();
                        cs.to = jc["to"].get<std::string>();
                        cs.port = (jc.contains("port") && jc["port"].is_number_integer())
                                      ? jc["port"].get<int>()
                                      : 0;
                        std::string cableErr;
                        if (canAddCable(loaded, cs, cableErr)) {
                            loaded.cables.push_back(std::move(cs));
                        }
                    }
                }
            }

            if (isBuiltinOverride) {
                *existingBuiltin = std::move(loaded);
            } else {
                if (findById(loaded.id) != nullptr) {
                    loaded.id = generateUniqueCustomId();
                }
                presets_.push_back(std::move(loaded));
            }
        }

        if (ver == 2) {
            std::string migrateSaveErr;
            saveOverridesAtomic(jsonPath, migrateSaveErr);
        }
        return true;
    }

    // Legacy v1 format (no version key): migrate onto built-in defaults and re-save as version 2.
    for (auto& [id, entry] : root.items()) {
        Preset* p = findByIdMutable(id);
        if (!p || !entry.is_object()) continue;

        std::string namPath;
        if (entry.contains("namPath") && entry["namPath"].is_string()) {
            namPath = entry["namPath"].get<std::string>();
        } else if (entry.contains("nam") && entry["nam"].is_string()) {
            namPath = entry["nam"].get<std::string>();
        }

        const bool namIncludesCab = entry.contains("namIncludesCab") && entry["namIncludesCab"].is_boolean()
                                        ? entry["namIncludesCab"].get<bool>()
                                        : false;

        std::string irPath;
        if (entry.contains("irPath") && entry["irPath"].is_string()) {
            irPath = entry["irPath"].get<std::string>();
        } else if (entry.contains("ir") && entry["ir"].is_string()) {
            irPath = entry["ir"].get<std::string>();
        }

        if (entry.contains("params") && entry["params"].is_object()) {
            const json& jp = entry["params"];

            if (jp.contains("inputTrimDb") && jp["inputTrimDb"].is_number()) {
                const float v = jp["inputTrimDb"].get<float>();
                if (std::isfinite(v)) p->inputTrimDb = std::clamp(v, -24.0f, 24.0f);
            }
            if (jp.contains("gateThresholdDb") && jp["gateThresholdDb"].is_number()) {
                const float v = jp["gateThresholdDb"].get<float>();
                if (std::isfinite(v)) p->gateThresholdDb = std::clamp(v, -80.0f, 0.0f);
            }
            if (jp.contains("outputLevelDb") && jp["outputLevelDb"].is_number()) {
                const float v = jp["outputLevelDb"].get<float>();
                if (std::isfinite(v)) p->outputLevelDb = std::clamp(v, -60.0f, 24.0f);
            }

            if (BlockState* amp = findFirstBlockOfType(*p, "amp")) {
                const dsp::BlockTypeSpec* ampSpec = dsp::findBlockSpec(dsp::BlockType::Amp);
                auto setAmp = [&](const char* key, float val) {
                    if (!std::isfinite(val)) return;
                    if (ampSpec) {
                        for (const auto& ps : ampSpec->params) {
                            if (std::string(ps.key) == key) {
                                amp->params[ps.key] = clampParamSpec(ps, val);
                                return;
                            }
                        }
                    }
                    amp->params[key] = val;
                };

                if (jp.contains("character")) {
                    if (jp["character"].is_string()) {
                        const int curIdx = static_cast<int>(std::lround(amp->params["character"]));
                        setAmp("character", static_cast<float>(stringToCharacterIndex(jp["character"].get<std::string>(), curIdx)));
                    } else if (jp["character"].is_number()) {
                        setAmp("character", jp["character"].get<float>());
                    }
                }
                if (jp.contains("gain") && jp["gain"].is_number()) setAmp("gain", jp["gain"].get<float>());
                if (jp.contains("bass") && jp["bass"].is_number()) setAmp("bass", jp["bass"].get<float>());
                if (jp.contains("mid") && jp["mid"].is_number()) setAmp("mid", jp["mid"].get<float>());
                if (jp.contains("treble") && jp["treble"].is_number()) setAmp("treble", jp["treble"].get<float>());
                if (jp.contains("presence") && jp["presence"].is_number()) setAmp("presence", jp["presence"].get<float>());
                if (jp.contains("tightHz") && jp["tightHz"].is_number()) setAmp("tight", jp["tightHz"].get<float>());
                if (jp.contains("ampLevelDb") && jp["ampLevelDb"].is_number()) setAmp("level", jp["ampLevelDb"].get<float>());
            }

            if (jp.contains("cab")) {
                if (BlockState* cab = findFirstBlockOfType(*p, "cab")) {
                    const dsp::BlockTypeSpec* cabSpec = dsp::findBlockSpec(dsp::BlockType::Cab);
                    int curIdx = static_cast<int>(std::lround(cab->params["model"]));
                    if (jp["cab"].is_string()) {
                        curIdx = stringToCabIndex(jp["cab"].get<std::string>(), curIdx);
                    } else if (jp["cab"].is_number()) {
                        curIdx = static_cast<int>(std::lround(jp["cab"].get<float>()));
                    }
                    if (cabSpec && !cabSpec->params.empty()) {
                        cab->params[cabSpec->params[0].key] = clampParamSpec(cabSpec->params[0], static_cast<float>(curIdx));
                    } else {
                        cab->params["model"] = static_cast<float>(curIdx);
                    }
                }
            }

            // Post EQ -> eq block if any band != 0
            if (jp.contains("postLowDb") || jp.contains("postMidDb") || jp.contains("postHighDb")) {
                const dsp::BlockTypeSpec* eqSpec = dsp::findBlockSpec(dsp::BlockType::Eq);
                BlockState* eq = findFirstBlockOfType(*p, "eq");
                auto getBand = [&](size_t idx, const char* fallback) -> float {
                    if (!eq) return 0.0f;
                    if (eqSpec && idx < eqSpec->params.size()) {
                        if (auto it = eq->params.find(eqSpec->params[idx].key); it != eq->params.end()) return it->second;
                    }
                    if (auto it = eq->params.find(fallback); it != eq->params.end()) return it->second;
                    return 0.0f;
                };
                float low = getBand(0, "low");
                float mid = getBand(1, "mid");
                float high = getBand(2, "high");
                if (jp.contains("postLowDb") && jp["postLowDb"].is_number()) low = jp["postLowDb"].get<float>();
                if (jp.contains("postMidDb") && jp["postMidDb"].is_number()) mid = jp["postMidDb"].get<float>();
                if (jp.contains("postHighDb") && jp["postHighDb"].is_number()) high = jp["postHighDb"].get<float>();

                const bool anyNonZero = diffFloat(low, 0.0f) || diffFloat(mid, 0.0f) || diffFloat(high, 0.0f);
                if (anyNonZero) {
                    if (!eq) {
                        BlockState newEq = makeBlockStateWithSpec(dsp::BlockType::Eq, "b" + std::to_string(p->nextUid++), {});
                        size_t pos = p->blocks.size();
                        for (size_t i = 0; i < p->blocks.size(); ++i) {
                            if (p->blocks[i].type == "chorus" || p->blocks[i].type == "delay" || p->blocks[i].type == "reverb") {
                                pos = i;
                                break;
                            }
                        }
                        p->blocks.insert(p->blocks.begin() + static_cast<ptrdiff_t>(pos), std::move(newEq));
                        eq = findFirstBlockOfType(*p, "eq");
                    }
                    if (eq) {
                        setParamByIndexOrKey(*eq, eqSpec, 0, "low", low);
                        setParamByIndexOrKey(*eq, eqSpec, 1, "mid", mid);
                        setParamByIndexOrKey(*eq, eqSpec, 2, "high", high);
                    }
                } else if (eq) {
                    p->blocks.erase(std::remove_if(p->blocks.begin(), p->blocks.end(),
                                                   [](const BlockState& b) { return b.type == "eq"; }),
                                    p->blocks.end());
                }
            }

            // Chorus
            if (jp.contains("chorusMix") && jp["chorusMix"].is_number()) {
                const float mix = jp["chorusMix"].get<float>();
                BlockState* ch = findFirstBlockOfType(*p, "chorus");
                const dsp::BlockTypeSpec* chSpec = dsp::findBlockSpec(dsp::BlockType::Chorus);
                if (mix > 0.0f) {
                    if (!ch) {
                        BlockState newCh = makeBlockStateWithSpec(dsp::BlockType::Chorus, "b" + std::to_string(p->nextUid++), {{"mix", mix}});
                        size_t pos = p->blocks.size();
                        for (size_t i = 0; i < p->blocks.size(); ++i) {
                            if (p->blocks[i].type == "delay" || p->blocks[i].type == "reverb") {
                                pos = i;
                                break;
                            }
                        }
                        p->blocks.insert(p->blocks.begin() + static_cast<ptrdiff_t>(pos), std::move(newCh));
                    } else if (chSpec) {
                        for (const auto& ps : chSpec->params) {
                            if (std::string(ps.key) == "mix") {
                                ch->params[ps.key] = clampParamSpec(ps, mix);
                                break;
                            }
                        }
                    } else {
                        ch->params["mix"] = mix;
                    }
                } else if (ch) {
                    p->blocks.erase(std::remove_if(p->blocks.begin(), p->blocks.end(),
                                                   [](const BlockState& b) { return b.type == "chorus"; }),
                                    p->blocks.end());
                }
            }

            // Delay
            if (jp.contains("delayTimeMs") || jp.contains("delayFeedback") || jp.contains("delayMix")) {
                BlockState* dl = findFirstBlockOfType(*p, "delay");
                const dsp::BlockTypeSpec* dlSpec = dsp::findBlockSpec(dsp::BlockType::Delay);
                float timeMs = dl && dl->params.count("time") ? dl->params["time"] : 380.0f;
                float fb = dl && dl->params.count("feedback") ? dl->params["feedback"] : 0.30f;
                float mix = dl && dl->params.count("mix") ? dl->params["mix"] : 0.0f;
                if (jp.contains("delayTimeMs") && jp["delayTimeMs"].is_number()) timeMs = jp["delayTimeMs"].get<float>();
                if (jp.contains("delayFeedback") && jp["delayFeedback"].is_number()) fb = jp["delayFeedback"].get<float>();
                if (jp.contains("delayMix") && jp["delayMix"].is_number()) mix = jp["delayMix"].get<float>();

                if (mix > 0.0f) {
                    if (!dl) {
                        BlockState newDl = makeBlockStateWithSpec(
                            dsp::BlockType::Delay,
                            "b" + std::to_string(p->nextUid++),
                            {{"time", timeMs}, {"feedback", fb}, {"mix", mix}});
                        size_t pos = p->blocks.size();
                        for (size_t i = 0; i < p->blocks.size(); ++i) {
                            if (p->blocks[i].type == "reverb") {
                                pos = i;
                                break;
                            }
                        }
                        p->blocks.insert(p->blocks.begin() + static_cast<ptrdiff_t>(pos), std::move(newDl));
                    } else {
                        auto setDl = [&](const char* k, float v) {
                            if (dlSpec) {
                                for (const auto& ps : dlSpec->params) {
                                    if (std::string(ps.key) == k) {
                                        dl->params[ps.key] = clampParamSpec(ps, v);
                                        return;
                                    }
                                }
                            }
                            dl->params[k] = v;
                        };
                        setDl("time", timeMs);
                        setDl("feedback", fb);
                        setDl("mix", mix);
                    }
                } else if (dl) {
                    p->blocks.erase(std::remove_if(p->blocks.begin(), p->blocks.end(),
                                                   [](const BlockState& b) { return b.type == "delay"; }),
                                    p->blocks.end());
                }
            }

            // Reverb
            if (jp.contains("reverbSize") || jp.contains("reverbMix")) {
                BlockState* rv = findFirstBlockOfType(*p, "reverb");
                const dsp::BlockTypeSpec* rvSpec = dsp::findBlockSpec(dsp::BlockType::Reverb);
                float size = rv && rv->params.count("size") ? rv->params["size"] : 0.5f;
                float mix = rv && rv->params.count("mix") ? rv->params["mix"] : 0.0f;
                if (jp.contains("reverbSize") && jp["reverbSize"].is_number()) size = jp["reverbSize"].get<float>();
                if (jp.contains("reverbMix") && jp["reverbMix"].is_number()) mix = jp["reverbMix"].get<float>();

                if (mix > 0.0f) {
                    if (!rv) {
                        BlockState newRv = makeBlockStateWithSpec(
                            dsp::BlockType::Reverb,
                            "b" + std::to_string(p->nextUid++),
                            {{"size", size}, {"mix", mix}, {"type", 0.0f}});
                        p->blocks.push_back(std::move(newRv));
                    } else {
                        auto setRv = [&](const char* k, float v) {
                            if (rvSpec) {
                                for (const auto& ps : rvSpec->params) {
                                    if (std::string(ps.key) == k) {
                                        rv->params[ps.key] = clampParamSpec(ps, v);
                                        return;
                                    }
                                }
                            }
                            rv->params[k] = v;
                        };
                        setRv("size", size);
                        setRv("mix", mix);
                    }
                } else if (rv) {
                    p->blocks.erase(std::remove_if(p->blocks.begin(), p->blocks.end(),
                                                   [](const BlockState& b) { return b.type == "reverb"; }),
                                    p->blocks.end());
                }
            }
        }

        // Old "nam" path -> insert a nam block at the amp block's position and REMOVE the amp block;
        // if old namIncludesCab was true also remove the cab block.
        if (!namPath.empty()) {
            BlockState namBlock = makeBlockStateWithSpec(dsp::BlockType::Nam, "b" + std::to_string(p->nextUid++), {});
            namBlock.type = "nam";
            namBlock.file = namPath;

            auto ampIt = std::find_if(p->blocks.begin(), p->blocks.end(),
                                      [](const BlockState& b) { return b.type == "amp"; });
            if (ampIt != p->blocks.end()) {
                *ampIt = std::move(namBlock);
            } else {
                p->blocks.insert(p->blocks.begin(), std::move(namBlock));
            }

            if (namIncludesCab) {
                auto cabIt = std::find_if(p->blocks.begin(), p->blocks.end(),
                                          [](const BlockState& b) { return b.type == "cab"; });
                if (cabIt != p->blocks.end()) {
                    p->blocks.erase(cabIt);
                }
            }
        }

        // Old "ir" path -> replace the cab block with an ir block (or insert after the nam/amp block if there is no cab).
        if (!irPath.empty()) {
            BlockState irBlock = makeBlockStateWithSpec(dsp::BlockType::Ir, "b" + std::to_string(p->nextUid++), {});
            irBlock.type = "ir";
            irBlock.file = irPath;

            auto cabIt = std::find_if(p->blocks.begin(), p->blocks.end(),
                                      [](const BlockState& b) { return b.type == "cab"; });
            if (cabIt != p->blocks.end()) {
                *cabIt = std::move(irBlock);
            } else {
                size_t insertPos = 0;
                for (size_t i = 0; i < p->blocks.size(); ++i) {
                    if (p->blocks[i].type == "amp" || p->blocks[i].type == "nam") {
                        insertPos = i + 1;
                    }
                }
                p->blocks.insert(p->blocks.begin() + static_cast<ptrdiff_t>(insertPos), std::move(irBlock));
            }
        }

        sanitizeUidsAndNextUid(*p, p->nextUid);
        applyRowLayout(*p);
    }

    std::string migrateSaveErr;
    saveOverridesAtomic(jsonPath, migrateSaveErr);
    return true;
}

bool PresetBank::saveOverridesAtomic(const std::filesystem::path& jsonPath, std::string& errorOut) const {
    errorOut.clear();
    const std::vector<Preset> defaults = makeBuiltinDefaults();

    json presetsArr = json::array();
    for (const auto& cur : presets_) {
        if (!cur.builtin) {
            presetsArr.push_back(serializePreset(cur));
            continue;
        }
        const Preset* defPtr = nullptr;
        for (const auto& d : defaults) {
            if (d.id == cur.id) {
                defPtr = &d;
                break;
            }
        }
        if (!defPtr || !presetsEqual(cur, *defPtr)) {
            presetsArr.push_back(serializePreset(cur));
        }
    }

    json root = {
        {"version", kPresetFileVersion},
        {"presets", std::move(presetsArr)}
    };

    std::error_code ec;
    const std::filesystem::path parent = jsonPath.parent_path();
    if (!parent.empty()) {
        std::filesystem::create_directories(parent, ec);
    }

    std::filesystem::path tmpPath = jsonPath;
    tmpPath += ".tmp";

    {
        std::ofstream out(tmpPath, std::ios::binary | std::ios::trunc);
        if (!out) {
            errorOut = "Cannot write temporary presets file: " + tmpPath.string();
            return false;
        }
        out << root.dump(2) << '\n';
        out.flush();
        if (!out) {
            errorOut = "Failed flushing temporary presets file: " + tmpPath.string();
            return false;
        }
    }

#ifdef _WIN32
    if (!MoveFileExW(tmpPath.c_str(), jsonPath.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        errorOut = "Atomic rename failed for presets file: " + jsonPath.string();
        std::filesystem::remove(tmpPath, ec);
        return false;
    }
#else
    std::filesystem::rename(tmpPath, jsonPath, ec);
    if (ec) {
        errorOut = "Atomic rename failed: " + ec.message();
        std::filesystem::remove(tmpPath, ec);
        return false;
    }
#endif

    return true;
}

} // namespace wsamp
