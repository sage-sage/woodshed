#include "presets.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <unordered_set>
#include <utility>

#ifdef _WIN32
#include <windows.h>
#endif

#include "json.hpp"

namespace wsamp {

namespace {

using json = nlohmann::json;

constexpr int kPresetFileVersion = 2;

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
    if (diffFloat(a.inputTrimDb, b.inputTrimDb)) return false;
    if (diffFloat(a.gateThresholdDb, b.gateThresholdDb)) return false;
    if (diffFloat(a.outputLevelDb, b.outputLevelDb)) return false;
    if (a.blocks.size() != b.blocks.size()) return false;
    for (size_t i = 0; i < a.blocks.size(); ++i) {
        const BlockState& ba = a.blocks[i];
        const BlockState& bb = b.blocks[i];
        if (ba.uid != bb.uid || ba.type != bb.type || ba.enabled != bb.enabled || ba.file != bb.file) {
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
    return true;
}

json serializePreset(const Preset& p) {
    json blocksArr = json::array();
    for (const auto& b : p.blocks) {
        json jp = json::object();
        for (const auto& [k, v] : b.params) {
            jp[k] = v;
        }
        json jb = {
            {"uid", b.uid},
            {"type", b.type},
            {"enabled", b.enabled},
            {"params", std::move(jp)}
        };
        if (!b.file.empty()) {
            jb["file"] = b.file;
        }
        blocksArr.push_back(std::move(jb));
    }
    return json{
        {"id", p.id},
        {"name", p.name},
        {"inputTrimDb", p.inputTrimDb},
        {"gateThresholdDb", p.gateThresholdDb},
        {"outputLevelDb", p.outputLevelDb},
        {"nextUid", p.nextUid},
        {"blocks", std::move(blocksArr)}
    };
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
        if (ver != kPresetFileVersion) {
            errorOut = "Unsupported presets.json version: " + std::to_string(ver);
            return false;
        }
        if (!root.contains("presets") || !root["presets"].is_array()) {
            return true;
        }

        for (const auto& item : root["presets"]) {
            if (!item.is_object() || !item.contains("id") || !item["id"].is_string()) continue;
            const std::string id = item["id"].get<std::string>();
            Preset* target = findByIdMutable(id);
            if (!target) continue; // ignore unknown ids

            Preset loaded = *target;
            if (item.contains("name") && item["name"].is_string()) {
                loaded.name = item["name"].get<std::string>();
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

            if (item.contains("blocks") && item["blocks"].is_array()) {
                std::vector<BlockState> newBlocks;
                int namCount = 0;
                for (const auto& jb : item["blocks"]) {
                    if (!jb.is_object() || !jb.contains("type") || !jb["type"].is_string()) continue;
                    const std::string bType = jb["type"].get<std::string>();
                    const dsp::BlockTypeSpec* spec = dsp::findBlockSpec(bType);
                    if (!spec) continue; // ignore unknown block types

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
                    if (spec->usesFile && jb.contains("file") && jb["file"].is_string()) {
                        bs.file = jb["file"].get<std::string>();
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
                loaded.blocks = std::move(newBlocks);
            }

            const int reqNext = (item.contains("nextUid") && item["nextUid"].is_number_integer())
                                    ? item["nextUid"].get<int>()
                                    : 1;
            sanitizeUidsAndNextUid(loaded, reqNext);
            *target = std::move(loaded);
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
