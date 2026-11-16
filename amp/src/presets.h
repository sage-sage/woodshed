#pragma once

#include <filesystem>
#include <map>
#include <string>
#include <vector>

#include "dsp/board.h"

namespace wsamp {

struct BlockState {
    std::string uid;
    std::string type;
    bool enabled = true;
    std::map<std::string, float> params;
    std::string file; // full UTF-8 path, file blocks only
};

struct Preset {
    std::string id;
    std::string name;
    float inputTrimDb = 0.0f;
    float gateThresholdDb = -70.0f;
    float outputLevelDb = 0.0f;
    std::vector<BlockState> blocks;
    int nextUid = 1;
};

class PresetBank {
public:
    PresetBank();

    // Returns the default overrides path (%APPDATA%\WoodshedAmp\presets.json on Windows).
    static std::filesystem::path defaultPresetsPath();

    // Validates whether a block of `type` can be added to `preset`.
    static bool canAddBlock(const Preset& preset, const std::string& type, std::string& errorOut);

    // Loads built-in defaults and applies any overrides present in `jsonPath`.
    // Missing file is valid and yields defaults.
    bool loadOverrides(const std::filesystem::path& jsonPath, std::string& errorOut);

    // Atomically saves full Preset objects for every preset differing from built-in defaults (version 2).
    bool saveOverridesAtomic(const std::filesystem::path& jsonPath, std::string& errorOut) const;

    const std::vector<Preset>& presets() const noexcept { return presets_; }
    const Preset* findById(const std::string& id) const noexcept;
    Preset* findByIdMutable(const std::string& id) noexcept;

    void resetToDefaults();

private:
    static std::vector<Preset> makeBuiltinDefaults();

    std::vector<Preset> presets_;
};

} // namespace wsamp
