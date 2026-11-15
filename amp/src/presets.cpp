#include "presets.h"

#include <cmath>
#include <cstdlib>
#include <fstream>

#ifdef _WIN32
#include <windows.h>
#endif

#include "json.hpp"

namespace wsamp {

namespace {

using json = nlohmann::json;

std::string characterToString(dsp::AmpCharacter c) {
    switch (c) {
        case dsp::AmpCharacter::Clean: return "Clean";
        case dsp::AmpCharacter::Breakup: return "Breakup";
        case dsp::AmpCharacter::Crunch: return "Crunch";
        case dsp::AmpCharacter::HighGain: return "HighGain";
        case dsp::AmpCharacter::Fuzz: return "Fuzz";
    }
    return "Clean";
}

dsp::AmpCharacter stringToCharacter(const std::string& s, dsp::AmpCharacter fallback) {
    if (s == "Clean" || s == "clean") return dsp::AmpCharacter::Clean;
    if (s == "Breakup" || s == "breakup") return dsp::AmpCharacter::Breakup;
    if (s == "Crunch" || s == "crunch") return dsp::AmpCharacter::Crunch;
    if (s == "HighGain" || s == "high_gain" || s == "highgain") return dsp::AmpCharacter::HighGain;
    if (s == "Fuzz" || s == "fuzz") return dsp::AmpCharacter::Fuzz;
    return fallback;
}

std::string cabToString(dsp::CabType c) {
    switch (c) {
        case dsp::CabType::C412: return "C412";
        case dsp::CabType::O212: return "O212";
        case dsp::CabType::O112: return "O112";
        case dsp::CabType::Acoustic: return "Acoustic";
        case dsp::CabType::Bass: return "Bass";
    }
    return "C412";
}

dsp::CabType stringToCab(const std::string& s, dsp::CabType fallback) {
    if (s == "C412" || s == "c412") return dsp::CabType::C412;
    if (s == "O212" || s == "o212") return dsp::CabType::O212;
    if (s == "O112" || s == "o112") return dsp::CabType::O112;
    if (s == "Acoustic" || s == "acoustic") return dsp::CabType::Acoustic;
    if (s == "Bass" || s == "bass") return dsp::CabType::Bass;
    return fallback;
}

bool diffFloat(float a, float b) noexcept {
    return std::abs(a - b) > 1e-4f;
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

std::vector<Preset> PresetBank::makeBuiltinDefaults() {
    std::vector<Preset> list;
    list.reserve(10);

    auto add = [&](const char* id,
                   const char* name,
                   dsp::AmpCharacter ch,
                   float gain,
                   float b, float m, float t, float p,
                   float tightHz,
                   dsp::CabType cab,
                   float gateDb,
                   float chorusMix,
                   float delayMs, float delayFb, float delayMix,
                   float reverbMix) {
        Preset pr;
        pr.id = id;
        pr.name = name;
        pr.params.amp.character = ch;
        pr.params.amp.gain = gain;
        pr.params.amp.bass = b;
        pr.params.amp.mid = m;
        pr.params.amp.treble = t;
        pr.params.amp.presence = p;
        pr.params.amp.tightHz = tightHz;
        pr.params.amp.sag = 0.25f;
        pr.params.amp.levelDb = 0.0f;
        pr.params.cabType = cab;
        pr.params.gateThresholdDb = gateDb;
        pr.params.chorusMix = chorusMix;
        pr.params.delayTimeMs = delayMs;
        pr.params.delayFeedback = delayFb;
        pr.params.delayMix = delayMix;
        pr.params.reverbSize = 0.5f;
        pr.params.reverbMix = reverbMix;
        list.push_back(std::move(pr));
    };

    // Exact preset contract from SPEC.md:
    // id, name, character, gain, B, M, T, P, tight, cab, gate, chorus, delay(ms,fb,mix), reverb
    add("clean", "Clean", dsp::AmpCharacter::Clean, 3.0f, 5.0f, 5.0f, 6.0f, 6.0f, 60.0f,
        dsp::CabType::O112, -70.0f, 0.15f, 0.0f, 0.0f, 0.0f, 0.18f);

    add("jazz", "Warm Jazz", dsp::AmpCharacter::Clean, 2.0f, 6.0f, 6.0f, 3.5f, 4.0f, 50.0f,
        dsp::CabType::O112, -72.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.12f);

    add("breakup", "Edge of Breakup", dsp::AmpCharacter::Breakup, 5.0f, 5.0f, 6.0f, 6.0f, 6.0f, 80.0f,
        dsp::CabType::O212, -65.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.14f);

    add("crunch", "Crunch", dsp::AmpCharacter::Crunch, 5.0f, 5.0f, 6.0f, 6.0f, 6.0f, 100.0f,
        dsp::CabType::C412, -60.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.10f);

    add("rock_lead", "Rock Lead", dsp::AmpCharacter::Crunch, 8.0f, 5.0f, 7.0f, 6.0f, 6.0f, 110.0f,
        dsp::CabType::C412, -58.0f, 0.0f, 380.0f, 0.30f, 0.18f, 0.15f);

    add("high_gain", "High Gain", dsp::AmpCharacter::HighGain, 6.0f, 6.0f, 4.0f, 6.0f, 6.0f, 140.0f,
        dsp::CabType::C412, -52.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.08f);

    add("metal", "Metal", dsp::AmpCharacter::HighGain, 8.0f, 6.0f, 3.5f, 6.5f, 6.5f, 220.0f,
        dsp::CabType::C412, -48.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f);

    add("fuzz", "Fuzz", dsp::AmpCharacter::Fuzz, 7.0f, 6.0f, 4.0f, 5.0f, 5.0f, 40.0f,
        dsp::CabType::O212, -60.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.10f);

    add("acoustic", "Acoustic Sim", dsp::AmpCharacter::Clean, 1.0f, 5.0f, 5.0f, 6.0f, 6.0f, 90.0f,
        dsp::CabType::Acoustic, -72.0f, 0.10f, 0.0f, 0.0f, 0.0f, 0.20f);

    add("bass", "Bass", dsp::AmpCharacter::Clean, 3.0f, 6.0f, 5.0f, 5.0f, 5.0f, 30.0f,
        dsp::CabType::Bass, -70.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f);

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

    for (auto& [id, entry] : root.items()) {
        Preset* p = findByIdMutable(id);
        if (!p || !entry.is_object()) continue;

        if (entry.contains("namPath") && entry["namPath"].is_string()) {
            p->namPath = entry["namPath"].get<std::string>();
        }
        if (entry.contains("namIncludesCab") && entry["namIncludesCab"].is_boolean()) {
            p->params.namIncludesCab = entry["namIncludesCab"].get<bool>();
        }
        if (entry.contains("irPath") && entry["irPath"].is_string()) {
            p->irPath = entry["irPath"].get<std::string>();
        }
        if (entry.contains("params") && entry["params"].is_object()) {
            const json& jp = entry["params"];
            if (jp.contains("inputTrimDb") && jp["inputTrimDb"].is_number())
                p->params.inputTrimDb = jp["inputTrimDb"].get<float>();
            if (jp.contains("gateThresholdDb") && jp["gateThresholdDb"].is_number())
                p->params.gateThresholdDb = jp["gateThresholdDb"].get<float>();

            if (jp.contains("character") && jp["character"].is_string())
                p->params.amp.character = stringToCharacter(jp["character"].get<std::string>(), p->params.amp.character);
            if (jp.contains("gain") && jp["gain"].is_number())
                p->params.amp.gain = jp["gain"].get<float>();
            if (jp.contains("bass") && jp["bass"].is_number())
                p->params.amp.bass = jp["bass"].get<float>();
            if (jp.contains("mid") && jp["mid"].is_number())
                p->params.amp.mid = jp["mid"].get<float>();
            if (jp.contains("treble") && jp["treble"].is_number())
                p->params.amp.treble = jp["treble"].get<float>();
            if (jp.contains("presence") && jp["presence"].is_number())
                p->params.amp.presence = jp["presence"].get<float>();
            if (jp.contains("tightHz") && jp["tightHz"].is_number())
                p->params.amp.tightHz = jp["tightHz"].get<float>();
            if (jp.contains("sag") && jp["sag"].is_number())
                p->params.amp.sag = jp["sag"].get<float>();
            if (jp.contains("ampLevelDb") && jp["ampLevelDb"].is_number())
                p->params.amp.levelDb = jp["ampLevelDb"].get<float>();

            if (jp.contains("cab") && jp["cab"].is_string())
                p->params.cabType = stringToCab(jp["cab"].get<std::string>(), p->params.cabType);

            if (jp.contains("postLowDb") && jp["postLowDb"].is_number())
                p->params.postLowDb = jp["postLowDb"].get<float>();
            if (jp.contains("postMidDb") && jp["postMidDb"].is_number())
                p->params.postMidDb = jp["postMidDb"].get<float>();
            if (jp.contains("postHighDb") && jp["postHighDb"].is_number())
                p->params.postHighDb = jp["postHighDb"].get<float>();

            if (jp.contains("chorusMix") && jp["chorusMix"].is_number())
                p->params.chorusMix = jp["chorusMix"].get<float>();
            if (jp.contains("delayTimeMs") && jp["delayTimeMs"].is_number())
                p->params.delayTimeMs = jp["delayTimeMs"].get<float>();
            if (jp.contains("delayFeedback") && jp["delayFeedback"].is_number())
                p->params.delayFeedback = jp["delayFeedback"].get<float>();
            if (jp.contains("delayMix") && jp["delayMix"].is_number())
                p->params.delayMix = jp["delayMix"].get<float>();
            if (jp.contains("reverbSize") && jp["reverbSize"].is_number())
                p->params.reverbSize = jp["reverbSize"].get<float>();
            if (jp.contains("reverbMix") && jp["reverbMix"].is_number())
                p->params.reverbMix = jp["reverbMix"].get<float>();
            if (jp.contains("outputLevelDb") && jp["outputLevelDb"].is_number())
                p->params.outputLevelDb = jp["outputLevelDb"].get<float>();
        }
    }

    return true;
}

bool PresetBank::saveOverridesAtomic(const std::filesystem::path& jsonPath, std::string& errorOut) const {
    errorOut.clear();
    const std::vector<Preset> defaults = makeBuiltinDefaults();

    json root = json::object();
    for (size_t i = 0; i < presets_.size() && i < defaults.size(); ++i) {
        const Preset& cur = presets_[i];
        const Preset& def = defaults[i];

        json entry = json::object();
        if (cur.namPath != def.namPath) entry["namPath"] = cur.namPath;
        if (cur.params.namIncludesCab != def.params.namIncludesCab) entry["namIncludesCab"] = cur.params.namIncludesCab;
        if (cur.irPath != def.irPath) entry["irPath"] = cur.irPath;

        json jp = json::object();
        if (diffFloat(cur.params.inputTrimDb, def.params.inputTrimDb)) jp["inputTrimDb"] = cur.params.inputTrimDb;
        if (diffFloat(cur.params.gateThresholdDb, def.params.gateThresholdDb)) jp["gateThresholdDb"] = cur.params.gateThresholdDb;
        if (cur.params.amp.character != def.params.amp.character) jp["character"] = characterToString(cur.params.amp.character);
        if (diffFloat(cur.params.amp.gain, def.params.amp.gain)) jp["gain"] = cur.params.amp.gain;
        if (diffFloat(cur.params.amp.bass, def.params.amp.bass)) jp["bass"] = cur.params.amp.bass;
        if (diffFloat(cur.params.amp.mid, def.params.amp.mid)) jp["mid"] = cur.params.amp.mid;
        if (diffFloat(cur.params.amp.treble, def.params.amp.treble)) jp["treble"] = cur.params.amp.treble;
        if (diffFloat(cur.params.amp.presence, def.params.amp.presence)) jp["presence"] = cur.params.amp.presence;
        if (diffFloat(cur.params.amp.tightHz, def.params.amp.tightHz)) jp["tightHz"] = cur.params.amp.tightHz;
        if (diffFloat(cur.params.amp.sag, def.params.amp.sag)) jp["sag"] = cur.params.amp.sag;
        if (diffFloat(cur.params.amp.levelDb, def.params.amp.levelDb)) jp["ampLevelDb"] = cur.params.amp.levelDb;
        if (cur.params.cabType != def.params.cabType) jp["cab"] = cabToString(cur.params.cabType);
        if (diffFloat(cur.params.postLowDb, def.params.postLowDb)) jp["postLowDb"] = cur.params.postLowDb;
        if (diffFloat(cur.params.postMidDb, def.params.postMidDb)) jp["postMidDb"] = cur.params.postMidDb;
        if (diffFloat(cur.params.postHighDb, def.params.postHighDb)) jp["postHighDb"] = cur.params.postHighDb;
        if (diffFloat(cur.params.chorusMix, def.params.chorusMix)) jp["chorusMix"] = cur.params.chorusMix;
        if (diffFloat(cur.params.delayTimeMs, def.params.delayTimeMs)) jp["delayTimeMs"] = cur.params.delayTimeMs;
        if (diffFloat(cur.params.delayFeedback, def.params.delayFeedback)) jp["delayFeedback"] = cur.params.delayFeedback;
        if (diffFloat(cur.params.delayMix, def.params.delayMix)) jp["delayMix"] = cur.params.delayMix;
        if (diffFloat(cur.params.reverbSize, def.params.reverbSize)) jp["reverbSize"] = cur.params.reverbSize;
        if (diffFloat(cur.params.reverbMix, def.params.reverbMix)) jp["reverbMix"] = cur.params.reverbMix;
        if (diffFloat(cur.params.outputLevelDb, def.params.outputLevelDb)) jp["outputLevelDb"] = cur.params.outputLevelDb;

        if (!jp.empty()) {
            entry["params"] = std::move(jp);
        }
        if (!entry.empty()) {
            root[cur.id] = std::move(entry);
        }
    }

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
