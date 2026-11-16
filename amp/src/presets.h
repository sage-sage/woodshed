#pragma once

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "dsp/board.h"
#include "json.hpp"

namespace wsamp {

struct BlockState {
    std::string uid;
    std::string type;
    bool enabled = true;
    std::map<std::string, float> params;
    std::string file;        // full UTF-8 path, file blocks only
    std::string missingFile; // original filename when an imported file path does not exist
    float x = 0.0f;
    float y = 0.0f;
};

struct CableState {
    std::string from;
    std::string to;
    int port = 0;
};

struct Preset {
    std::string id;
    std::string name;
    bool builtin = true;
    std::string basedOn;
    float inputTrimDb = 0.0f;
    float gateThresholdDb = -70.0f;
    float outputLevelDb = 0.0f;
    float inX = 1.0f;
    float inY = 6.0f;
    float outX = 10.0f;
    float outY = 6.0f;
    std::vector<BlockState> blocks;
    std::vector<CableState> cables;
    int nextUid = 1;
};

class PresetBank {
public:
    static constexpr int kMaxCustomPresets = 50;

    PresetBank();

    // Returns the default overrides path (%APPDATA%\WoodshedAmp\presets.json on Windows).
    static std::filesystem::path defaultPresetsPath();

    // Validates whether a block of `type` can be added to `preset`.
    static bool canAddBlock(const Preset& preset, const std::string& type, std::string& errorOut);

    // Validates whether `cable` can be added to `preset`.
    static bool canAddCable(const Preset& preset, const CableState& cable, std::string& errorOut);

    // Export/import serialization per protocol-graph.md.
    static nlohmann::json toExportJson(const Preset& preset);
    static std::optional<Preset> fromExportJson(const nlohmann::json& j, std::string& errorOut);

    // Loads built-in defaults and applies any overrides/custom presets present in `jsonPath`.
    // Missing file is valid and yields defaults.
    bool loadOverrides(const std::filesystem::path& jsonPath, std::string& errorOut);

    // Atomically saves full Preset objects for every modified built-in and every custom preset (version 3).
    bool saveOverridesAtomic(const std::filesystem::path& jsonPath, std::string& errorOut) const;

    const std::vector<Preset>& presets() const noexcept { return presets_; }
    const Preset* findById(const std::string& id) const noexcept;
    Preset* findByIdMutable(const std::string& id) noexcept;

    int customPresetCount() const noexcept;
    Preset& createCustom(const std::string& name, const std::string& basedOn);
    Preset& addCustomPreset(Preset preset);
    Preset* duplicatePreset(const std::string& sourceId, const std::string& requestedName, std::string& errorOut);
    bool renamePreset(const std::string& id, const std::string& newName, std::string& errorOut);
    bool removePreset(const std::string& id, std::string& errorOut);

    void resetToDefaults();

private:
    static std::vector<Preset> makeBuiltinDefaults();
    std::string generateUniqueCustomId() const;

    std::vector<Preset> presets_;
};

} // namespace wsamp
