#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "dsp/chain.h"

namespace wsamp {

struct Preset {
    std::string id;
    std::string name;
    dsp::ChainParams params{};
    std::string namPath;
    std::string irPath;
};

class PresetBank {
public:
    PresetBank();

    // Returns the default overrides path (%APPDATA%\WoodshedAmp\presets.json on Windows).
    static std::filesystem::path defaultPresetsPath();

    // Loads built-in defaults and applies any overrides present in `jsonPath`.
    // Missing file is valid and yields defaults.
    bool loadOverrides(const std::filesystem::path& jsonPath, std::string& errorOut);

    // Atomically saves only per-id overrides relative to built-in defaults (write temp + rename).
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
