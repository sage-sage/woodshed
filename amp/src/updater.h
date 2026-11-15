#pragma once

#include <windows.h>

#include <atomic>
#include <mutex>
#include <optional>
#include <string>

namespace wsamp {

struct UpdateInfo {
    std::string version;
    std::string url;
    std::string sha256;
    std::string notes;
};

class Updater {
public:
    Updater() = default;
    ~Updater() = default;

    Updater(const Updater&) = delete;
    Updater& operator=(const Updater&) = delete;

    void checkAsync(HWND notify, bool manual);
    std::optional<UpdateInfo> available() const;
    void installAsync(HWND notify);
    static void cleanupOld();
    std::string lastError() const;

private:
    mutable std::mutex mutex_;
    std::optional<UpdateInfo> available_;
    std::string lastError_;
    std::atomic<bool> busy_{false};
    std::atomic<bool> manualCheck_{false};
};

} // namespace wsamp
