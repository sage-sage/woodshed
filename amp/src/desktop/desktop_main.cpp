#include <windows.h>
#include <windowsx.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <objbase.h>

#include "webview2_uuids.h"
#include "updater.h"
#include "version.h"

#include <atomic>
#include <cstdio>
#include <cwchar>
#include <cwctype>
#include <functional>
#include <string>
#include <string_view>
#include <utility>

namespace {

constexpr wchar_t kWindowClass[] = L"WoodshedAppWindow";
constexpr wchar_t kWindowTitle[] = L"Woodshed";
constexpr wchar_t kSingleInstanceMutex[] = L"WoodshedAppSingleInstance";
constexpr wchar_t kAmpMutex[] = L"WoodshedAmpSingleInstance";
constexpr wchar_t kQuitForUpdateMsgName[] = L"WoodshedQuitForUpdate";
constexpr wchar_t kWebView2DownloadUrl[] = L"https://go.microsoft.com/fwlink/p/?LinkId=2124703";
constexpr wchar_t kDesktopRegSubkey[] = L"Software\\Woodshed\\Desktop";
constexpr wchar_t kPlacementValueName[] = L"Placement";

constexpr int kDefaultWidth = 1280;
constexpr int kDefaultHeight = 820;
constexpr int kMinTrackWidth = 960;
constexpr int kMinTrackHeight = 620;

constexpr UINT_PTR kTimerUpdateFirst = 1;
constexpr UINT_PTR kTimerUpdateRepeat = 2;
constexpr UINT kUpdateFirstDelayMs = 5000;
constexpr UINT kUpdateRepeatIntervalMs = 6u * 60u * 60u * 1000u;

using PFN_CreateCoreWebView2EnvironmentWithOptions = HRESULT(STDAPICALLTYPE*)(
    PCWSTR browserExecutableFolder,
    PCWSTR userDataFolder,
    ICoreWebView2EnvironmentOptions* environmentOptions,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* environmentCreatedHandler);

template <typename T>
class ComPtr {
public:
    ComPtr() noexcept = default;
    ~ComPtr() { reset(); }

    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;

    ComPtr(ComPtr&& other) noexcept : ptr_(other.ptr_) { other.ptr_ = nullptr; }
    ComPtr& operator=(ComPtr&& other) noexcept {
        if (this != &other) {
            reset();
            ptr_ = other.ptr_;
            other.ptr_ = nullptr;
        }
        return *this;
    }

    void reset() noexcept {
        if (ptr_) {
            ptr_->Release();
            ptr_ = nullptr;
        }
    }

    void attach(T* p) noexcept {
        reset();
        ptr_ = p;
    }

    T** put() noexcept {
        reset();
        return &ptr_;
    }

    T* get() const noexcept { return ptr_; }
    T* operator->() const noexcept { return ptr_; }
    explicit operator bool() const noexcept { return ptr_ != nullptr; }

    template <typename U>
    HRESULT as(ComPtr<U>& out) const noexcept {
        if (!ptr_) return E_POINTER;
        return ptr_->QueryInterface(__uuidof(U), reinterpret_cast<void**>(out.put()));
    }

private:
    T* ptr_ = nullptr;
};

template <typename TInterface, typename... TArgs>
class ComCallback final : public TInterface {
public:
    using Func = std::function<HRESULT(TArgs...)>;

    explicit ComCallback(Func fn) noexcept : fn_(std::move(fn)) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
        if (!ppvObject) return E_POINTER;
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, __uuidof(TInterface))) {
            *ppvObject = static_cast<TInterface*>(this);
            AddRef();
            return S_OK;
        }
        *ppvObject = nullptr;
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return refCount_.fetch_add(1, std::memory_order_relaxed) + 1;
    }

    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG count = refCount_.fetch_sub(1, std::memory_order_acq_rel) - 1;
        if (count == 0) {
            delete this;
        }
        return count;
    }

    HRESULT STDMETHODCALLTYPE Invoke(TArgs... args) override {
        if (!fn_) return S_OK;
        try {
            return fn_(args...);
        } catch (...) {
            return E_FAIL;
        }
    }

private:
    ~ComCallback() = default;
    std::atomic<ULONG> refCount_{1};
    Func fn_;
};

template <typename TInterface, typename... TArgs, typename TFn>
ComPtr<TInterface> makeComCallback(TFn&& fn) {
    ComPtr<TInterface> ptr;
    ptr.attach(new ComCallback<TInterface, TArgs...>(std::forward<TFn>(fn)));
    return ptr;
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

std::wstring getExeDir() {
    const std::wstring exePath = getCurrentExePath();
    const size_t slash = exePath.find_last_of(L"\\/");
    return (slash != std::wstring::npos) ? exePath.substr(0, slash) : L".";
}

bool fileExists(const std::wstring& path) {
    const DWORD attrs = GetFileAttributesW(path.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool startsWithIgnoreCase(std::wstring_view str, std::wstring_view prefix) {
    if (str.size() < prefix.size()) return false;
    for (size_t i = 0; i < prefix.size(); ++i) {
        if (std::towlower(str[i]) != std::towlower(prefix[i])) {
            return false;
        }
    }
    return true;
}

bool isExternalBrowserScheme(std::wstring_view uri) {
    return startsWithIgnoreCase(uri, L"http://") ||
           startsWithIgnoreCase(uri, L"https://") ||
           startsWithIgnoreCase(uri, L"mailto:");
}

std::wstring utf8ToWide(std::string_view utf8) {
    if (utf8.empty()) return {};
    const int needed = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (needed <= 0) return {};
    std::wstring out(static_cast<size_t>(needed), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), needed);
    return out;
}

std::wstring escapeJsonStringW(std::string_view utf8) {
    const std::wstring wide = utf8ToWide(utf8);
    std::wstring out;
    out.reserve(wide.size() + 16);
    for (wchar_t ch : wide) {
        switch (ch) {
            case L'\\': out += L"\\\\"; break;
            case L'"':  out += L"\\\""; break;
            case L'\b': out += L"\\b"; break;
            case L'\f': out += L"\\f"; break;
            case L'\n': out += L"\\n"; break;
            case L'\r': out += L"\\r"; break;
            case L'\t': out += L"\\t"; break;
            default:
                if (static_cast<unsigned int>(ch) < 0x20u) {
                    wchar_t buf[8];
                    std::swprintf(buf, 8, L"\\u%04x", static_cast<unsigned int>(ch));
                    out += buf;
                } else {
                    out += ch;
                }
                break;
        }
    }
    return out;
}

std::wstring extractJsonType(std::wstring_view json) {
    size_t pos = 0;
    while (pos < json.size()) {
        const size_t keyPos = json.find(L"\"type\"", pos);
        if (keyPos == std::wstring_view::npos) return {};
        size_t i = keyPos + 6;
        while (i < json.size() && std::iswspace(json[i])) ++i;
        if (i >= json.size() || json[i] != L':') {
            pos = keyPos + 6;
            continue;
        }
        ++i;
        while (i < json.size() && std::iswspace(json[i])) ++i;
        if (i >= json.size() || json[i] != L'"') {
            pos = keyPos + 6;
            continue;
        }
        ++i;
        std::wstring value;
        while (i < json.size()) {
            const wchar_t c = json[i++];
            if (c == L'\\') {
                if (i < json.size()) value.push_back(json[i++]);
            } else if (c == L'"') {
                return value;
            } else {
                value.push_back(c);
            }
        }
        return {};
    }
    return {};
}

void launchAmpIfNeeded(const std::wstring& exeDir) {
    const std::wstring ampExe = exeDir + L"\\woodshed-amp.exe";
    if (!fileExists(ampExe)) {
        return;
    }
    HANDLE hAmpMutex = OpenMutexW(SYNCHRONIZE, FALSE, kAmpMutex);
    if (hAmpMutex != nullptr) {
        CloseHandle(hAmpMutex);
        return;
    }

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::wstring cmdLine = L"\"" + ampExe + L"\"";
    if (CreateProcessW(ampExe.c_str(), cmdLine.data(), nullptr, nullptr, FALSE,
                       0, nullptr, exeDir.c_str(), &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
}

std::wstring getWebView2UserDataDir() {
    PWSTR localAppData = nullptr;
    std::wstring baseDir;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE, nullptr, &localAppData)) && localAppData) {
        baseDir = localAppData;
        CoTaskMemFree(localAppData);
    } else {
        wchar_t envBuf[MAX_PATH]{};
        const DWORD len = GetEnvironmentVariableW(L"LOCALAPPDATA", envBuf, MAX_PATH);
        if (len > 0 && len < MAX_PATH) {
            baseDir.assign(envBuf, len);
        }
    }
    if (baseDir.empty()) return {};
    std::wstring userDataDir = baseDir + L"\\Woodshed\\WebView2";
    SHCreateDirectoryExW(nullptr, userDataDir.c_str(), nullptr);
    return userDataDir;
}

void enablePerMonitorDpiAwareness() {
    using PFN_SetProcessDpiAwarenessContext = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    if (!user32) return;
    auto fn = reinterpret_cast<PFN_SetProcessDpiAwarenessContext>(
        GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
    if (fn) {
        fn(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

bool loadWindowPlacement(WINDOWPLACEMENT& wp) {
    HKEY hKey = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kDesktopRegSubkey, 0, KEY_READ, &hKey) != ERROR_SUCCESS) {
        return false;
    }
    DWORD type = 0;
    DWORD size = sizeof(WINDOWPLACEMENT);
    WINDOWPLACEMENT loaded{};
    const LSTATUS status = RegQueryValueExW(
        hKey, kPlacementValueName, nullptr, &type, reinterpret_cast<LPBYTE>(&loaded), &size);
    RegCloseKey(hKey);

    if (status != ERROR_SUCCESS || type != REG_BINARY || size != sizeof(WINDOWPLACEMENT) ||
        loaded.length != sizeof(WINDOWPLACEMENT)) {
        return false;
    }

    const RECT& rc = loaded.rcNormalPosition;
    if ((rc.right - rc.left) < 200 || (rc.bottom - rc.top) < 150) {
        return false;
    }

    HMONITOR hMon = MonitorFromRect(&rc, MONITOR_DEFAULTTONULL);
    if (!hMon) {
        return false;
    }
    MONITORINFO mi{};
    mi.cbSize = sizeof(mi);
    if (!GetMonitorInfoW(hMon, &mi)) {
        return false;
    }

    RECT inter{};
    if (!IntersectRect(&inter, &rc, &mi.rcWork) ||
        (inter.right - inter.left) < 100 || (inter.bottom - inter.top) < 50) {
        return false;
    }

    if (loaded.showCmd == SW_SHOWMINIMIZED) {
        loaded.showCmd = SW_SHOWNORMAL;
    }
    wp = loaded;
    return true;
}

void saveWindowPlacement(HWND hwnd) {
    if (!hwnd) return;
    WINDOWPLACEMENT wp{};
    wp.length = sizeof(wp);
    if (!GetWindowPlacement(hwnd, &wp)) {
        return;
    }
    HKEY hKey = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kDesktopRegSubkey, 0, nullptr,
                        REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr, &hKey, nullptr) == ERROR_SUCCESS) {
        RegSetValueExW(hKey, kPlacementValueName, 0, REG_BINARY,
                       reinterpret_cast<const BYTE*>(&wp), sizeof(wp));
        RegCloseKey(hKey);
    }
}

class DesktopApp {
public:
    DesktopApp(std::wstring exeDir, bool enableDevTools)
        : exeDir_(std::move(exeDir)), enableDevTools_(enableDevTools) {}

    ~DesktopApp() {
        cleanupWebView();
        if (hWebView2Loader_) {
            FreeLibrary(hWebView2Loader_);
            hWebView2Loader_ = nullptr;
        }
        if (bgBrush_) {
            DeleteObject(bgBrush_);
            bgBrush_ = nullptr;
        }
    }

    bool create(HINSTANCE hInstance) {
        hInstance_ = hInstance;
        quitForUpdateMsg_ = RegisterWindowMessageW(kQuitForUpdateMsgName);
        bgBrush_ = CreateSolidBrush(RGB(23, 20, 18));

        HICON hIconBig = LoadIconW(hInstance_, MAKEINTRESOURCEW(1));
        HICON hIconSmall = static_cast<HICON>(LoadImageW(
            hInstance_, MAKEINTRESOURCEW(1), IMAGE_ICON,
            GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR));

        WNDCLASSEXW wc{};
        wc.cbSize = sizeof(wc);
        wc.style = CS_HREDRAW | CS_VREDRAW;
        wc.lpfnWndProc = &DesktopApp::wndProc;
        wc.hInstance = hInstance_;
        wc.hIcon = hIconBig;
        wc.hIconSm = hIconSmall ? hIconSmall : hIconBig;
        wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        wc.hbrBackground = bgBrush_;
        wc.lpszClassName = kWindowClass;

        if (!RegisterClassExW(&wc)) {
            return false;
        }

        RECT wa{};
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0);
        const int workW = wa.right - wa.left;
        const int workH = wa.bottom - wa.top;
        const int sysDpi = static_cast<int>(GetDpiForSystem());
        const int wantW = MulDiv(kDefaultWidth, sysDpi, 96);
        const int wantH = MulDiv(kDefaultHeight, sysDpi, 96);
        const int winW = (wantW < workW) ? wantW : workW;
        const int winH = (wantH < workH) ? wantH : workH;
        const int winX = wa.left + (workW - winW) / 2;
        const int winY = wa.top + (workH - winH) / 2;

        hwnd_ = CreateWindowExW(
            0, kWindowClass, kWindowTitle, WS_OVERLAPPEDWINDOW,
            winX, winY, winW, winH,
            nullptr, nullptr, hInstance_, this);
        if (!hwnd_) {
            return false;
        }

        WINDOWPLACEMENT wp{};
        if (loadWindowPlacement(wp)) {
            SetWindowPlacement(hwnd_, &wp);
        } else {
            ShowWindow(hwnd_, SW_SHOWNORMAL);
        }
        UpdateWindow(hwnd_);

        if (wsamp::Updater::installerMode()) {
            SetTimer(hwnd_, kTimerUpdateFirst, kUpdateFirstDelayMs, nullptr);
            SetTimer(hwnd_, kTimerUpdateRepeat, kUpdateRepeatIntervalMs, nullptr);
        }

        return initWebView2();
    }

    HWND hwnd() const noexcept { return hwnd_; }

private:
    static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        DesktopApp* self = nullptr;
        if (msg == WM_NCCREATE) {
            auto* cs = reinterpret_cast<CREATESTRUCTW*>(lParam);
            self = static_cast<DesktopApp*>(cs->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
            self->hwnd_ = hwnd;
        } else {
            self = reinterpret_cast<DesktopApp*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        }
        if (self) {
            return self->handleMessage(msg, wParam, lParam);
        }
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }

    LRESULT handleMessage(UINT msg, WPARAM wParam, LPARAM lParam) {
        if (quitForUpdateMsg_ != 0 && msg == quitForUpdateMsg_) {
            DestroyWindow(hwnd_);
            return 0;
        }

        switch (msg) {
            case WM_DPICHANGED: {
            const RECT* r = reinterpret_cast<const RECT*>(lParam);
            SetWindowPos(hwnd_, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top,
                         SWP_NOZORDER | SWP_NOACTIVATE);
            return 0;
        }
        case WM_GETMINMAXINFO: {
                auto* mmi = reinterpret_cast<MINMAXINFO*>(lParam);
                UINT dpi = 96;
                if (hwnd_) {
                    const UINT winDpi = GetDpiForWindow(hwnd_);
                    if (winDpi > 0) dpi = winDpi;
                }
                mmi->ptMinTrackSize.x = MulDiv(kMinTrackWidth, static_cast<int>(dpi), 96);
                mmi->ptMinTrackSize.y = MulDiv(kMinTrackHeight, static_cast<int>(dpi), 96);
                return 0;
            }
            case WM_SIZE: {
                if (controller_) {
                    if (wParam == SIZE_MINIMIZED) {
                        controller_->put_IsVisible(FALSE);
                    } else {
                        controller_->put_IsVisible(TRUE);
                        RECT rc{};
                        GetClientRect(hwnd_, &rc);
                        controller_->put_Bounds(rc);
                    }
                }
                return 0;
            }
            case WM_MOVE: {
                if (controller_) {
                    controller_->NotifyParentWindowPositionChanged();
                }
                return 0;
            }
            case WM_TIMER: {
                if (wParam == kTimerUpdateFirst) {
                    KillTimer(hwnd_, kTimerUpdateFirst);
                    updater_.checkAsync(hwnd_, false);
                    return 0;
                }
                if (wParam == kTimerUpdateRepeat) {
                    updater_.checkAsync(hwnd_, false);
                    return 0;
                }
                break;
            }
            case wsamp::kMsgUpdateAvailable: {
                const auto info = updater_.available();
                if (info && webview_) {
                    const std::wstring verEsc = escapeJsonStringW(info->version);
                    const std::wstring notesEsc = escapeJsonStringW(info->notes);
                    const std::wstring script =
                        L"window.woodshedDesktopUpdate && window.woodshedDesktopUpdate({version:\"" +
                        verEsc + L"\",notes:\"" + notesEsc + L"\"})";
                    webview_->ExecuteScript(script.c_str(), nullptr);
                }
                return 0;
            }
            case wsamp::kMsgUpdateNone: {
                if (webview_) {
                    webview_->ExecuteScript(
                        L"window.woodshedDesktopUpdate && window.woodshedDesktopUpdate(null)",
                        nullptr);
                }
                return 0;
            }
            case wsamp::kMsgUpdateFailed: {
                if (webview_) {
                    const std::wstring errEsc = escapeJsonStringW(updater_.lastError());
                    const std::wstring script =
                        L"window.woodshedDesktopUpdateFailed && window.woodshedDesktopUpdateFailed(\"" +
                        errEsc + L"\")";
                    webview_->ExecuteScript(script.c_str(), nullptr);
                }
                return 0;
            }
            case wsamp::kMsgUpdateReady: {
                if (wParam == 1) {
                    DestroyWindow(hwnd_);
                }
                return 0;
            }
            case WM_CLOSE: {
                saveWindowPlacement(hwnd_);
                DestroyWindow(hwnd_);
                return 0;
            }
            case WM_DESTROY: {
                saveWindowPlacement(hwnd_);
                if (hwnd_) {
                    KillTimer(hwnd_, kTimerUpdateFirst);
                    KillTimer(hwnd_, kTimerUpdateRepeat);
                }
                cleanupWebView();
                PostQuitMessage(0);
                return 0;
            }
            default:
                break;
        }
        return DefWindowProcW(hwnd_, msg, wParam, lParam);
    }

    void cleanupWebView() noexcept {
        if (controller_) {
            controller_->Close();
            controller_.reset();
        }
        webview_.reset();
    }

    void showWebView2MissingAndExit() {
        const int choice = MessageBoxW(
            hwnd_,
            L"Woodshed requires the Microsoft Edge WebView2 Runtime, which is not installed or failed to start.\n\n"
            L"Would you like to open the Microsoft WebView2 Runtime download page now?",
            L"Woodshed - WebView2 Runtime Required",
            MB_YESNO | MB_ICONERROR);
        if (choice == IDYES) {
            ShellExecuteW(nullptr, L"open", kWebView2DownloadUrl, nullptr, nullptr, SW_SHOWNORMAL);
        }
        if (hwnd_) {
            DestroyWindow(hwnd_);
        }
    }

    bool initWebView2() {
        const std::wstring loaderPath = exeDir_ + L"\\WebView2Loader.dll";
        hWebView2Loader_ = LoadLibraryW(loaderPath.c_str());
        if (!hWebView2Loader_) {
            showWebView2MissingAndExit();
            return false;
        }

        auto createEnv = reinterpret_cast<PFN_CreateCoreWebView2EnvironmentWithOptions>(
            GetProcAddress(hWebView2Loader_, "CreateCoreWebView2EnvironmentWithOptions"));
        if (!createEnv) {
            showWebView2MissingAndExit();
            return false;
        }

        const std::wstring userDataDir = getWebView2UserDataDir();
        auto envHandler = makeComCallback<
            ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,
            HRESULT,
            ICoreWebView2Environment*>(
            [this](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                if (FAILED(result) || !env) {
                    showWebView2MissingAndExit();
                    return S_OK;
                }
                auto ctrlHandler = makeComCallback<
                    ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
                    HRESULT,
                    ICoreWebView2Controller*>(
                    [this](HRESULT ctrlResult, ICoreWebView2Controller* ctrl) -> HRESULT {
                        if (FAILED(ctrlResult) || !ctrl) {
                            showWebView2MissingAndExit();
                            return S_OK;
                        }
                        onControllerCreated(ctrl);
                        return S_OK;
                    });
                const HRESULT hrCtrl = env->CreateCoreWebView2Controller(hwnd_, ctrlHandler.get());
                if (FAILED(hrCtrl)) {
                    showWebView2MissingAndExit();
                }
                return S_OK;
            });

        const HRESULT hr = createEnv(
            nullptr,
            userDataDir.empty() ? nullptr : userDataDir.c_str(),
            nullptr,
            envHandler.get());
        if (FAILED(hr)) {
            showWebView2MissingAndExit();
            return false;
        }
        return true;
    }

    void onControllerCreated(ICoreWebView2Controller* ctrl) {
        if (!hwnd_ || !ctrl) return;

        ctrl->AddRef();
        controller_.attach(ctrl);

        if (FAILED(controller_->get_CoreWebView2(webview_.put())) || !webview_) {
            showWebView2MissingAndExit();
            return;
        }

        RECT rc{};
        GetClientRect(hwnd_, &rc);
        controller_->put_Bounds(rc);
        controller_->put_IsVisible(IsIconic(hwnd_) ? FALSE : TRUE);

        ComPtr<ICoreWebView2Settings> settings;
        if (SUCCEEDED(webview_->get_Settings(settings.put())) && settings) {
            settings->put_AreDevToolsEnabled(enableDevTools_ ? TRUE : FALSE);
            settings->put_IsStatusBarEnabled(FALSE);
            settings->put_IsZoomControlEnabled(TRUE);
            settings->put_AreDefaultContextMenusEnabled(TRUE);
        }

        ComPtr<ICoreWebView2_3> webview3;
        if (SUCCEEDED(webview_.as(webview3)) && webview3) {
            const std::wstring siteDir = exeDir_ + L"\\site";
            webview3->SetVirtualHostNameToFolderMapping(
                wsamp::kDesktopHostW,
                siteDir.c_str(),
                COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
        }

        const bool ampInstalled = fileExists(exeDir_ + L"\\woodshed-amp.exe");
        const std::wstring initScript =
            std::wstring(L"window.woodshedDesktop = Object.freeze({ version: \"") +
            wsamp::kAppVersionW + L"\", ampInstalled: " +
            (ampInstalled ? L"true" : L"false") + L" });";
        webview_->AddScriptToExecuteOnDocumentCreated(initScript.c_str(), nullptr);

        EventRegistrationToken token{};

        auto permHandler = makeComCallback<
            ICoreWebView2PermissionRequestedEventHandler,
            ICoreWebView2*,
            ICoreWebView2PermissionRequestedEventArgs*>(
            [](ICoreWebView2* /*sender*/, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                if (!args) return E_POINTER;
                LPWSTR uri = nullptr;
                if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
                    const bool allowed = startsWithIgnoreCase(uri, L"https://woodshed.example/");
                    CoTaskMemFree(uri);
                    args->put_State(allowed ? COREWEBVIEW2_PERMISSION_STATE_ALLOW
                                            : COREWEBVIEW2_PERMISSION_STATE_DENY);
                } else {
                    args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
                }
                return S_OK;
            });
        webview_->add_PermissionRequested(permHandler.get(), &token);

        auto navHandler = makeComCallback<
            ICoreWebView2NavigationStartingEventHandler,
            ICoreWebView2*,
            ICoreWebView2NavigationStartingEventArgs*>(
            [](ICoreWebView2* /*sender*/, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                if (!args) return E_POINTER;
                LPWSTR uri = nullptr;
                if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
                    const std::wstring_view uriView(uri);
                    const bool isInternal =
                        startsWithIgnoreCase(uriView, L"https://woodshed.example/") ||
                        _wcsicmp(uri, L"about:blank") == 0;
                    if (!isInternal) {
                        args->put_Cancel(TRUE);
                        if (isExternalBrowserScheme(uriView)) {
                            ShellExecuteW(nullptr, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL);
                        }
                    }
                    CoTaskMemFree(uri);
                }
                return S_OK;
            });
        webview_->add_NavigationStarting(navHandler.get(), &token);

        auto newWinHandler = makeComCallback<
            ICoreWebView2NewWindowRequestedEventHandler,
            ICoreWebView2*,
            ICoreWebView2NewWindowRequestedEventArgs*>(
            [](ICoreWebView2* /*sender*/, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                if (!args) return E_POINTER;
                args->put_Handled(TRUE);
                LPWSTR uri = nullptr;
                if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
                    if (isExternalBrowserScheme(uri)) {
                        ShellExecuteW(nullptr, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL);
                    }
                    CoTaskMemFree(uri);
                }
                return S_OK;
            });
        webview_->add_NewWindowRequested(newWinHandler.get(), &token);

        auto msgHandler = makeComCallback<
            ICoreWebView2WebMessageReceivedEventHandler,
            ICoreWebView2*,
            ICoreWebView2WebMessageReceivedEventArgs*>(
            [this](ICoreWebView2* sender, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                if (!sender || !args) return E_POINTER;
                LPWSTR source = nullptr;
                bool trustedSource = false;
                if (SUCCEEDED(sender->get_Source(&source)) && source) {
                    trustedSource = startsWithIgnoreCase(source, L"https://woodshed.example/");
                    CoTaskMemFree(source);
                }
                if (!trustedSource) {
                    return S_OK;
                }

                LPWSTR msgRaw = nullptr;
                if (FAILED(args->TryGetWebMessageAsString(&msgRaw)) || !msgRaw) {
                    if (FAILED(args->get_WebMessageAsJson(&msgRaw)) || !msgRaw) {
                        return S_OK;
                    }
                }
                const std::wstring jsonStr(msgRaw);
                CoTaskMemFree(msgRaw);

                const std::wstring type = extractJsonType(jsonStr);
                if (type == L"launch-amp") {
                    launchAmpIfNeeded(exeDir_);
                } else if (type == L"install-update") {
                    updater_.installAsync(hwnd_);
                } else if (type == L"check-update") {
                    updater_.checkAsync(hwnd_, true);
                }
                return S_OK;
            });
        webview_->add_WebMessageReceived(msgHandler.get(), &token);

        webview_->Navigate(L"https://woodshed.example/index.html");
    }

    std::wstring exeDir_;
    bool enableDevTools_ = false;
    HINSTANCE hInstance_ = nullptr;
    HWND hwnd_ = nullptr;
    HBRUSH bgBrush_ = nullptr;
    HMODULE hWebView2Loader_ = nullptr;
    UINT quitForUpdateMsg_ = 0;
    wsamp::Updater updater_;
    ComPtr<ICoreWebView2Controller> controller_;
    ComPtr<ICoreWebView2> webview_;
};

} // namespace

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE /*hPrevInstance*/, LPSTR /*lpCmdLine*/, int /*nCmdShow*/) {
    enablePerMonitorDpiAwareness();

    HANDLE hMutex = CreateMutexW(nullptr, TRUE, kSingleInstanceMutex);
    if (hMutex != nullptr && GetLastError() == ERROR_ALREADY_EXISTS) {
        CloseHandle(hMutex);
        HWND existing = FindWindowW(kWindowClass, nullptr);
        if (existing != nullptr) {
            ShowWindow(existing, SW_RESTORE);
            SetForegroundWindow(existing);
        }
        return 0;
    }

    const HRESULT hrCom = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    const std::wstring exeDir = getExeDir();
    const wchar_t* cmdLine = GetCommandLineW();
    const bool enableDevTools = (cmdLine != nullptr && std::wcsstr(cmdLine, L"--devtools") != nullptr);

    launchAmpIfNeeded(exeDir);

    int exitCode = 0;
    {
        DesktopApp app(exeDir, enableDevTools);
        if (!app.create(hInstance)) {
            exitCode = 1;
        } else {
            MSG msg{};
            while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            exitCode = static_cast<int>(msg.wParam);
        }
    }

    if (SUCCEEDED(hrCom)) {
        CoUninitialize();
    }
    if (hMutex) {
        ReleaseMutex(hMutex);
        CloseHandle(hMutex);
    }
    return exitCode;
}

