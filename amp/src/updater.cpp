#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>
#include <winhttp.h>
#include <bcrypt.h>

#include "updater.h"
#include "version.h"
#include "json.hpp"

#include <array>
#include <charconv>
#include <cstdint>
#include <string_view>
#include <thread>
#include <vector>

namespace wsamp {

namespace {

constexpr size_t kMaxManifestBytes = 64 * 1024;
constexpr uint64_t kMaxDownloadBytes = 64ull * 1024ull * 1024ull;
constexpr uint64_t kMaxInstallerBytes = 256ull * 1024ull * 1024ull;
constexpr uint64_t kMinExeBytes = 100ull * 1024ull;
constexpr DWORD kHttpTimeoutMs = 10000;

struct BusyGuard {
    std::atomic<bool>& flag;
    ~BusyGuard() { flag.store(false); }
};

struct WinHttpHandle {
    HINTERNET h = nullptr;
    WinHttpHandle() = default;
    explicit WinHttpHandle(HINTERNET handle) : h(handle) {}
    ~WinHttpHandle() { if (h) WinHttpCloseHandle(h); }
    WinHttpHandle(const WinHttpHandle&) = delete;
    WinHttpHandle& operator=(const WinHttpHandle&) = delete;
    explicit operator bool() const noexcept { return h != nullptr; }
};

struct FileHandle {
    HANDLE h = INVALID_HANDLE_VALUE;
    FileHandle() = default;
    explicit FileHandle(HANDLE handle) : h(handle) {}
    ~FileHandle() { close(); }
    void close() {
        if (h != INVALID_HANDLE_VALUE) {
            CloseHandle(h);
            h = INVALID_HANDLE_VALUE;
        }
    }
    FileHandle(const FileHandle&) = delete;
    FileHandle& operator=(const FileHandle&) = delete;
    explicit operator bool() const noexcept { return h != INVALID_HANDLE_VALUE; }
};

struct BCryptHasher {
    BCRYPT_ALG_HANDLE alg = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    std::vector<UCHAR> obj;

    ~BCryptHasher() {
        if (hash) BCryptDestroyHash(hash);
        if (alg) BCryptCloseAlgorithmProvider(alg, 0);
    }

    bool init() {
        if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0))) {
            return false;
        }
        DWORD objLen = 0;
        DWORD cbData = 0;
        if (!BCRYPT_SUCCESS(BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objLen), sizeof(objLen), &cbData, 0))) {
            return false;
        }
        obj.resize(objLen);
        return BCRYPT_SUCCESS(BCryptCreateHash(alg, &hash, obj.data(), objLen, nullptr, 0, 0));
    }

    bool update(const void* data, ULONG size) {
        return BCRYPT_SUCCESS(BCryptHashData(hash, static_cast<PUCHAR>(const_cast<void*>(data)), size, 0));
    }

    bool finish(std::string& outHex) {
        std::array<UCHAR, 32> digest{};
        if (!BCRYPT_SUCCESS(BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0))) {
            return false;
        }
        static constexpr char kHex[] = "0123456789abcdef";
        outHex.resize(64);
        for (size_t i = 0; i < digest.size(); ++i) {
            outHex[i * 2] = kHex[(digest[i] >> 4) & 0x0F];
            outHex[i * 2 + 1] = kHex[digest[i] & 0x0F];
        }
        return true;
    }
};

std::wstring utf8ToWide(std::string_view utf8) {
    if (utf8.empty()) return {};
    const int needed = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (needed <= 0) return {};
    std::wstring out(static_cast<size_t>(needed), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), needed);
    return out;
}

std::wstring getCurrentExePath() {
    std::wstring buf(MAX_PATH, L'\0');
    while (true) {
        const DWORD len = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
        if (len == 0) return {};
        if (len < buf.size() - 1) {
            buf.resize(len);
            return buf;
        }
        buf.resize(buf.size() * 2);
    }
}

std::wstring getExeDir(const std::wstring& exePath) {
    const size_t slash = exePath.find_last_of(L"\\/");
    return (slash != std::wstring::npos) ? exePath.substr(0, slash) : L".";
}

std::wstring getTempDir() {
    std::wstring buf(MAX_PATH + 1, L'\0');
    DWORD len = GetTempPathW(static_cast<DWORD>(buf.size()), buf.data());
    if (len == 0) return {};
    if (len >= buf.size()) {
        buf.resize(len + 1);
        len = GetTempPathW(static_cast<DWORD>(buf.size()), buf.data());
        if (len == 0 || len >= buf.size()) return {};
    }
    buf.resize(len);
    if (!buf.empty() && buf.back() != L'\\' && buf.back() != L'/') {
        buf.push_back(L'\\');
    }
    return buf;
}

bool parseSemver(std::string_view s, std::array<int, 3>& out) {
    size_t pos = 0;
    for (int part = 0; part < 3; ++part) {
        const size_t dot = s.find('.', pos);
        if (part < 2 && dot == std::string_view::npos) return false;
        if (part == 2 && dot != std::string_view::npos) return false;
        const std::string_view token = (part < 2) ? s.substr(pos, dot - pos) : s.substr(pos);
        if (token.empty()) return false;
        for (char c : token) {
            if (c < '0' || c > '9') return false;
        }
        int val = 0;
        const auto [ptr, ec] = std::from_chars(token.data(), token.data() + token.size(), val);
        if (ec != std::errc{} || ptr != token.data() + token.size() || val < 0) return false;
        out[static_cast<size_t>(part)] = val;
        pos = dot + 1;
    }
    return true;
}

bool isValidSha256Hex(std::string_view s) {
    if (s.size() != 64) return false;
    for (char c : s) {
        const bool isHex = (c >= '0' && c <= '9') ||
                           (c >= 'a' && c <= 'f') ||
                           (c >= 'A' && c <= 'F');
        if (!isHex) return false;
    }
    return true;
}

bool equalsIgnoreCaseAscii(std::string_view a, std::string_view b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        const char ca = (a[i] >= 'A' && a[i] <= 'Z') ? static_cast<char>(a[i] + ('a' - 'A')) : a[i];
        const char cb = (b[i] >= 'A' && b[i] <= 'Z') ? static_cast<char>(b[i] + ('a' - 'A')) : b[i];
        if (ca != cb) return false;
    }
    return true;
}

std::wstring makeUserAgent() {
    return std::wstring(L"Woodshed/") + kAppVersionW;
}

} // namespace

bool Updater::installerMode() {
    const std::wstring exePath = getCurrentExePath();
    if (exePath.empty()) return false;
    const std::wstring uninsPath = getExeDir(exePath) + L"\\unins000.exe";
    const DWORD attrs = GetFileAttributesW(uninsPath.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

void Updater::checkAsync(HWND notify, bool manual) {
    if (manual) {
        manualCheck_.store(true);
    }
    bool expected = false;
    if (!busy_.compare_exchange_strong(expected, true)) {
        return;
    }

    try {
        std::thread([this, notify]() {
            BusyGuard guard{busy_};

            auto fail = [&](const std::string& err) {
                const bool isManual = manualCheck_.exchange(false);
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    lastError_ = err;
                }
                if (isManual && notify) {
                    PostMessageW(notify, kMsgUpdateFailed, 0, 0);
                }
            };

            const std::wstring ua = makeUserAgent();
            WinHttpHandle hSession(WinHttpOpen(ua.c_str(), WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                               WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
            if (!hSession) {
                fail("Failed to initialize WinHTTP.");
                return;
            }
            WinHttpSetTimeouts(hSession.h, kHttpTimeoutMs, kHttpTimeoutMs, kHttpTimeoutMs, kHttpTimeoutMs);

            WinHttpHandle hConnect(WinHttpConnect(hSession.h, kManifestHost, INTERNET_DEFAULT_HTTPS_PORT, 0));
            if (!hConnect) {
                fail("Failed to connect to update server.");
                return;
            }

            WinHttpHandle hRequest(WinHttpOpenRequest(hConnect.h, L"GET", kManifestPath, nullptr,
                                                      WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                      WINHTTP_FLAG_SECURE));
            if (!hRequest) {
                fail("Failed to create update request.");
                return;
            }

            WinHttpAddRequestHeaders(hRequest.h, L"Cache-Control: no-cache\r\n",
                                     static_cast<DWORD>(-1),
                                     WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);

            if (!WinHttpSendRequest(hRequest.h, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                                    WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
                !WinHttpReceiveResponse(hRequest.h, nullptr)) {
                fail("Update check request failed.");
                return;
            }

            DWORD statusCode = 0;
            DWORD statusSize = sizeof(statusCode);
            if (!WinHttpQueryHeaders(hRequest.h,
                                     WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                     WINHTTP_HEADER_NAME_BY_INDEX,
                                     &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX)) {
                fail("Failed to read HTTP status.");
                return;
            }
            if (statusCode != 200) {
                fail("Update server returned HTTP " + std::to_string(statusCode) + ".");
                return;
            }

            std::string body;
            std::array<char, 8192> buf{};
            while (true) {
                DWORD bytesRead = 0;
                if (!WinHttpReadData(hRequest.h, buf.data(), static_cast<DWORD>(buf.size()), &bytesRead)) {
                    fail("Failed reading update manifest.");
                    return;
                }
                if (bytesRead == 0) break;
                if (body.size() + bytesRead > kMaxManifestBytes) {
                    fail("Update manifest exceeds 64 KB.");
                    return;
                }
                body.append(buf.data(), bytesRead);
            }

            const char* sectionKey = installerMode() ? "setup" : "amp";
            const nlohmann::json root = nlohmann::json::parse(body, nullptr, false);
            if (root.is_discarded() || !root.is_object() || !root.contains(sectionKey) || !root[sectionKey].is_object()) {
                fail("Invalid update manifest format.");
                return;
            }

            const auto& entry = root[sectionKey];
            if (!entry.contains("version") || !entry["version"].is_string() ||
                !entry.contains("url") || !entry["url"].is_string() ||
                !entry.contains("sha256") || !entry["sha256"].is_string()) {
                fail("Missing fields in update manifest.");
                return;
            }

            UpdateInfo info;
            info.version = entry["version"].get<std::string>();
            info.url = entry["url"].get<std::string>();
            info.sha256 = entry["sha256"].get<std::string>();
            if (entry.contains("notes") && entry["notes"].is_string()) {
                info.notes = entry["notes"].get<std::string>();
            }

            std::array<int, 3> remoteVer{};
            std::array<int, 3> localVer{};
            if (!parseSemver(info.version, remoteVer) || !parseSemver(kAppVersion, localVer)) {
                fail("Invalid version format in manifest.");
                return;
            }
            if (!std::string_view(info.url).starts_with(kReleasePrefix) ||
                info.url.size() <= std::string_view(kReleasePrefix).size()) {
                fail("Invalid release URL in manifest.");
                return;
            }
            if (!isValidSha256Hex(info.sha256)) {
                fail("Invalid SHA-256 in manifest.");
                return;
            }

            const bool isManual = manualCheck_.exchange(false);
            if (remoteVer > localVer) {
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    available_ = std::move(info);
                    lastError_.clear();
                }
                if (notify) {
                    PostMessageW(notify, kMsgUpdateAvailable, 0, 0);
                }
            } else {
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    available_.reset();
                    lastError_.clear();
                }
                if (isManual && notify) {
                    PostMessageW(notify, kMsgUpdateNone, 0, 0);
                }
            }
        }).detach();
    } catch (...) {
        manualCheck_.store(false);
        busy_.store(false);
    }
}

std::optional<UpdateInfo> Updater::available() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return available_;
}

void Updater::installAsync(HWND notify) {
    bool expected = false;
    if (!busy_.compare_exchange_strong(expected, true)) {
        return;
    }

    try {
        std::thread([this, notify]() {
            BusyGuard guard{busy_};

            std::wstring newPath;
            auto fail = [&](const std::string& err) {
                if (!newPath.empty()) {
                    DeleteFileW(newPath.c_str());
                }
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    lastError_ = err;
                }
                if (notify) {
                    PostMessageW(notify, kMsgUpdateFailed, 0, 0);
                }
            };

            const std::optional<UpdateInfo> info = available();
            if (!info) {
                fail("No update is available.");
                return;
            }

            const bool isInstaller = installerMode();
            std::wstring exePath;
            std::wstring oldPath;
            if (isInstaller) {
                const std::wstring tempDir = getTempDir();
                if (tempDir.empty()) {
                    fail("Failed to resolve temporary directory.");
                    return;
                }
                newPath = tempDir + L"Woodshed-Setup-" + utf8ToWide(info->version) + L".exe";
            } else {
                exePath = getCurrentExePath();
                if (exePath.empty()) {
                    fail("Failed to resolve executable path.");
                    return;
                }
                const std::wstring exeDir = getExeDir(exePath);
                newPath = exeDir + L"\\woodshed-amp.new.exe";
                oldPath = exeDir + L"\\woodshed-amp.old.exe";
            }

            const std::wstring wUrl = utf8ToWide(info->url);
            URL_COMPONENTS uc{};
            uc.dwStructSize = sizeof(uc);
            uc.dwHostNameLength = static_cast<DWORD>(-1);
            uc.dwUrlPathLength = static_cast<DWORD>(-1);
            if (wUrl.empty() || !WinHttpCrackUrl(wUrl.c_str(), static_cast<DWORD>(wUrl.size()), 0, &uc) ||
                uc.nScheme != INTERNET_SCHEME_HTTPS || uc.dwHostNameLength == 0 || uc.dwUrlPathLength == 0) {
                fail("Invalid HTTPS download URL.");
                return;
            }

            const std::wstring host(uc.lpszHostName, uc.dwHostNameLength);
            const std::wstring path(uc.lpszUrlPath, uc.dwUrlPathLength);

            const std::wstring ua = makeUserAgent();
            WinHttpHandle hSession(WinHttpOpen(ua.c_str(), WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                               WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
            if (!hSession) {
                fail("Failed to initialize WinHTTP.");
                return;
            }
            WinHttpSetTimeouts(hSession.h, kHttpTimeoutMs, kHttpTimeoutMs, kHttpTimeoutMs, kHttpTimeoutMs);

            WinHttpHandle hConnect(WinHttpConnect(hSession.h, host.c_str(), uc.nPort, 0));
            if (!hConnect) {
                fail("Failed to connect to download host.");
                return;
            }

            WinHttpHandle hRequest(WinHttpOpenRequest(hConnect.h, L"GET", path.c_str(), nullptr,
                                                      WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                      WINHTTP_FLAG_SECURE));
            if (!hRequest) {
                fail("Failed to create download request.");
                return;
            }

            if (!WinHttpSendRequest(hRequest.h, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                                    WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
                !WinHttpReceiveResponse(hRequest.h, nullptr)) {
                fail("Update download request failed.");
                return;
            }

            DWORD statusCode = 0;
            DWORD statusSize = sizeof(statusCode);
            if (!WinHttpQueryHeaders(hRequest.h,
                                     WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                     WINHTTP_HEADER_NAME_BY_INDEX,
                                     &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX)) {
                fail("Failed to read download HTTP status.");
                return;
            }
            if (statusCode != 200) {
                fail("Download server returned HTTP " + std::to_string(statusCode) + ".");
                return;
            }

            BCryptHasher hasher;
            if (!hasher.init()) {
                fail("Failed to initialize SHA-256.");
                return;
            }

            FileHandle hFile(CreateFileW(newPath.c_str(), GENERIC_WRITE, 0, nullptr,
                                         CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
            if (!hFile) {
                fail("Failed to create temporary update file.");
                return;
            }

            uint64_t totalBytes = 0;
            std::array<uint8_t, 2> magic{};
            std::array<uint8_t, 65536> buf{};

            while (true) {
                DWORD bytesRead = 0;
                if (!WinHttpReadData(hRequest.h, buf.data(), static_cast<DWORD>(buf.size()), &bytesRead)) {
                    hFile.close();
                    fail("Network error while downloading update.");
                    return;
                }
                if (bytesRead == 0) break;

                if (totalBytes == 0) {
                    magic[0] = buf[0];
                    if (bytesRead >= 2) magic[1] = buf[1];
                } else if (totalBytes == 1) {
                    magic[1] = buf[0];
                }

                totalBytes += bytesRead;
                const uint64_t maxDownload = isInstaller ? kMaxInstallerBytes : kMaxDownloadBytes;
                if (totalBytes > maxDownload) {
                    hFile.close();
                    fail("Update package exceeds size limit.");
                    return;
                }

                if (!hasher.update(buf.data(), bytesRead)) {
                    hFile.close();
                    fail("SHA-256 hashing failed.");
                    return;
                }

                DWORD offset = 0;
                while (offset < bytesRead) {
                    DWORD written = 0;
                    if (!WriteFile(hFile.h, buf.data() + offset, bytesRead - offset, &written, nullptr) || written == 0) {
                        hFile.close();
                        fail("Failed writing update to disk.");
                        return;
                    }
                    offset += written;
                }
            }

            hFile.close();

            if (totalBytes < kMinExeBytes) {
                fail("Downloaded update is smaller than 100 KB.");
                return;
            }
            if (magic[0] != 'M' || magic[1] != 'Z') {
                fail("Downloaded file is not a valid Windows executable.");
                return;
            }

            std::string actualSha256;
            if (!hasher.finish(actualSha256)) {
                fail("Failed to finalize SHA-256.");
                return;
            }
            if (!equalsIgnoreCaseAscii(actualSha256, info->sha256)) {
                fail("SHA-256 verification failed.");
                return;
            }

            if (isInstaller) {
                const std::wstring installerPath = newPath;
                newPath.clear();
                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    lastError_.clear();
                }
                const HINSTANCE execRes = ShellExecuteW(
                    nullptr,
                    L"open",
                    installerPath.c_str(),
                    L"/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /RELAUNCH",
                    nullptr,
                    SW_SHOWNORMAL);
                if (reinterpret_cast<INT_PTR>(execRes) <= 32) {
                    DeleteFileW(installerPath.c_str());
                    fail("Failed to launch update installer.");
                    return;
                }
                if (notify) {
                    PostMessageW(notify, kMsgUpdateReady, 1, 0);
                }
            } else {
                if (!MoveFileExW(exePath.c_str(), oldPath.c_str(), MOVEFILE_REPLACE_EXISTING)) {
                    fail("Failed to back up current executable.");
                    return;
                }
                if (!MoveFileExW(newPath.c_str(), exePath.c_str(), MOVEFILE_REPLACE_EXISTING)) {
                    MoveFileExW(oldPath.c_str(), exePath.c_str(), MOVEFILE_REPLACE_EXISTING);
                    fail("Failed to replace executable.");
                    return;
                }
                newPath.clear();

                {
                    std::lock_guard<std::mutex> lock(mutex_);
                    lastError_.clear();
                }
                if (notify) {
                    PostMessageW(notify, kMsgUpdateReady, 0, 0);
                }
            }
        }).detach();
    } catch (...) {
        busy_.store(false);
    }
}

void Updater::cleanupOld() {
    const std::wstring exePath = getCurrentExePath();
    if (exePath.empty()) return;
    const std::wstring oldPath = getExeDir(exePath) + L"\\woodshed-amp.old.exe";
    DeleteFileW(oldPath.c_str());
}

std::string Updater::lastError() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return lastError_;
}

} // namespace wsamp
