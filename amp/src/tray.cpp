#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>

#include "tray.h"
#include "version.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

namespace wsamp {

namespace {

constexpr wchar_t kWindowClassName[] = L"WoodshedAmpTrayWindowClass";
constexpr UINT kTrayIconId = 1001;

constexpr UINT kCmdBasePreset = 2000;
constexpr UINT kCmdInput1 = 3001;
constexpr UINT kCmdInput2 = 3002;
constexpr UINT kCmdInputBoth = 3003;
constexpr UINT kCmdBypass = 3010;
constexpr UINT kCmdMute = 3011;
constexpr UINT kCmdAsioPanel = 3012;
constexpr UINT kCmdOpenWoodshed = 3013;
constexpr UINT kCmdStartWithWindows = 3014;
constexpr UINT kCmdQuit = 3015;
constexpr UINT kCmdUpdateNow = 3016;
constexpr UINT kCmdCheckUpdates = 3017;

constexpr UINT kUpdateFirstDelayMs = 10000;
constexpr UINT kUpdateRepeatIntervalMs = 6u * 60u * 60u * 1000u;

std::wstring utf8ToWide(std::string_view utf8) {
    if (utf8.empty()) return {};
    const int needed = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (needed <= 0) return {};
    std::wstring out(static_cast<size_t>(needed), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), needed);
    return out;
}

} // namespace

TrayApp::TrayApp(AppController& controller)
    : controller_(controller) {
}

TrayApp::~TrayApp() {
    destroy();
}

bool TrayApp::create(HINSTANCE hInstance, UINT alreadyRunningMsg) {
    hInstance_ = hInstance;
    alreadyRunningMsg_ = alreadyRunningMsg;
    taskbarCreatedMsg_ = RegisterWindowMessageW(L"TaskbarCreated");

    hIcon16_ = createRubyJewelIcon(16);
    hIcon32_ = createRubyJewelIcon(32);

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = &TrayApp::wndProc;
    wc.hInstance = hInstance_;
    wc.hIcon = hIcon32_;
    wc.hIconSm = hIcon16_;
    wc.lpszClassName = kWindowClassName;

    if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        return false;
    }

    hwnd_ = CreateWindowExW(
        0,
        kWindowClassName,
        L"Woodshed Amp",
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 200, 120,
        nullptr,
        nullptr,
        hInstance_,
        this
    );

    if (!hwnd_) {
        return false;
    }

    controller_.setMainWindowHandle(hwnd_);
    controller_.setBalloonCallback([this](const std::string& title, const std::string& msg, bool isError) {
        if (!hwnd_) return;
        const std::wstring wTitle = utf8ToWide(title);
        const std::wstring wMsg = utf8ToWide(msg);
        showBalloon(wTitle, wMsg, isError);
    });

    addTrayIcon();
    updateTooltip();
    SetTimer(hwnd_, kTimerTooltip, 1000, nullptr);
    SetTimer(hwnd_, kTimerUpdateFirst, kUpdateFirstDelayMs, nullptr);
    SetTimer(hwnd_, kTimerUpdateRepeat, kUpdateRepeatIntervalMs, nullptr);
    return true;
}

void TrayApp::destroy() {
    if (hwnd_) {
        KillTimer(hwnd_, kTimerTooltip);
        KillTimer(hwnd_, kTimerUpdateFirst);
        KillTimer(hwnd_, kTimerUpdateRepeat);
        removeTrayIcon();
        DestroyWindow(hwnd_);
        hwnd_ = nullptr;
    }
    if (hIcon16_) {
        DestroyIcon(hIcon16_);
        hIcon16_ = nullptr;
    }
    if (hIcon32_) {
        DestroyIcon(hIcon32_);
        hIcon32_ = nullptr;
    }
}

HICON TrayApp::createRubyJewelIcon(int size) {
    BITMAPV5HEADER bi{};
    bi.bV5Size = sizeof(BITMAPV5HEADER);
    bi.bV5Width = size;
    bi.bV5Height = -size; // top-down
    bi.bV5Planes = 1;
    bi.bV5BitCount = 32;
    bi.bV5Compression = BI_BITFIELDS;
    bi.bV5RedMask = 0x00FF0000u;
    bi.bV5GreenMask = 0x0000FF00u;
    bi.bV5BlueMask = 0x000000FFu;
    bi.bV5AlphaMask = 0xFF000000u;

    HDC screenDc = GetDC(nullptr);
    void* bits = nullptr;
    HBITMAP hColor = CreateDIBSection(screenDc, reinterpret_cast<BITMAPINFO*>(&bi), DIB_RGB_COLORS, &bits, nullptr, 0);
    HBITMAP hMask = CreateBitmap(size, size, 1, 1, nullptr);
    ReleaseDC(nullptr, screenDc);

    if (hColor && bits) {
        auto* pixels = static_cast<uint32_t*>(bits);
        const float half = static_cast<float>(size) * 0.5f;
        const float radius = half - 1.0f;

        for (int y = 0; y < size; ++y) {
            for (int x = 0; x < size; ++x) {
                const float dx = (static_cast<float>(x) + 0.5f - half) / radius;
                const float dy = (static_cast<float>(y) + 0.5f - half) / radius;
                // Octagonal / diamond-cut ruby jewel metric
                const float radial = std::sqrt(dx * dx + dy * dy);
                const float diamond = std::abs(dx) + std::abs(dy);
                const float d = 0.72f * radial + 0.28f * diamond;

                if (d > 1.02f) {
                    pixels[y * size + x] = 0x00000000u;
                    continue;
                }

                // Anti-aliased edge alpha
                const float edgeAlpha = std::clamp((1.02f - d) / 0.12f, 0.0f, 1.0f);
                const uint8_t a = static_cast<uint8_t>(edgeAlpha * 255.0f);

                // Ruby jewel shading with facet gradient and top-left specular glint
                float r = 215.0f - d * 95.0f;
                float g = 22.0f - d * 12.0f;
                float b = 38.0f - d * 18.0f;

                // Inner table facet
                if (d < 0.52f) {
                    r = 238.0f - (dx + dy) * 28.0f;
                    g = 34.0f - (dx + dy) * 10.0f;
                    b = 54.0f - (dx + dy) * 12.0f;
                }

                // Dark metallic bezel near rim
                if (d > 0.85f) {
                    r *= 0.55f;
                    g *= 0.55f;
                    b *= 0.55f;
                }

                // Specular highlight
                const float hx = dx + 0.30f;
                const float hy = dy + 0.32f;
                const float specDist = std::sqrt(hx * hx + hy * hy);
                if (specDist < 0.28f) {
                    const float glint = (1.0f - specDist / 0.28f);
                    const float g2 = glint * glint;
                    r += (255.0f - r) * g2 * 0.92f;
                    g += (235.0f - g) * g2 * 0.92f;
                    b += (238.0f - b) * g2 * 0.92f;
                }

                const uint8_t rb = static_cast<uint8_t>(std::clamp(r, 0.0f, 255.0f));
                const uint8_t gb = static_cast<uint8_t>(std::clamp(g, 0.0f, 255.0f));
                const uint8_t bb = static_cast<uint8_t>(std::clamp(b, 0.0f, 255.0f));
                pixels[y * size + x] = (static_cast<uint32_t>(a) << 24) |
                                       (static_cast<uint32_t>(rb) << 16) |
                                       (static_cast<uint32_t>(gb) << 8) |
                                       static_cast<uint32_t>(bb);
            }
        }
    }

    ICONINFO ii{};
    ii.fIcon = TRUE;
    ii.hbmMask = hMask;
    ii.hbmColor = hColor;
    HICON icon = CreateIconIndirect(&ii);

    if (hColor) DeleteObject(hColor);
    if (hMask) DeleteObject(hMask);
    return icon;
}

void TrayApp::addTrayIcon() {
    if (!hwnd_) return;
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof(nid);
    nid.hWnd = hwnd_;
    nid.uID = kTrayIconId;
    nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    nid.uCallbackMessage = kMsgTrayCallback;
    nid.hIcon = hIcon16_;
    wcsncpy_s(nid.szTip, L"Woodshed Amp", _TRUNCATE);

    if (Shell_NotifyIconW(NIM_ADD, &nid)) {
        iconAdded_ = true;
    }
}

void TrayApp::removeTrayIcon() {
    if (!hwnd_ || !iconAdded_) return;
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof(nid);
    nid.hWnd = hwnd_;
    nid.uID = kTrayIconId;
    Shell_NotifyIconW(NIM_DELETE, &nid);
    iconAdded_ = false;
}

void TrayApp::updateTooltip() {
    if (!hwnd_ || !iconAdded_) return;
    const TrayStateSnapshot snap = controller_.getTraySnapshot();

    wchar_t tip[128]{};
    const std::wstring wPreset = utf8ToWide(snap.currentPresetName);
    if (snap.running) {
        swprintf_s(tip, L"Woodshed Amp - %ls - %.1f ms", wPreset.c_str(), snap.roundTripMs);
    } else {
        const std::wstring wErr = snap.lastError.empty() ? L"Stopped" : utf8ToWide(snap.lastError);
        swprintf_s(tip, L"Woodshed Amp - %ls - %ls", wPreset.c_str(), wErr.c_str());
    }

    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof(nid);
    nid.hWnd = hwnd_;
    nid.uID = kTrayIconId;
    nid.uFlags = NIF_TIP;
    wcsncpy_s(nid.szTip, tip, _TRUNCATE);
    Shell_NotifyIconW(NIM_MODIFY, &nid);
}

void TrayApp::showBalloon(const std::wstring& title, const std::wstring& message, bool isError) {
    if (!hwnd_ || !iconAdded_) return;
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof(nid);
    nid.hWnd = hwnd_;
    nid.uID = kTrayIconId;
    nid.uFlags = NIF_INFO;
    nid.dwInfoFlags = isError ? NIIF_WARNING : NIIF_INFO;
    wcsncpy_s(nid.szInfoTitle, title.c_str(), _TRUNCATE);
    wcsncpy_s(nid.szInfo, message.c_str(), _TRUNCATE);
    Shell_NotifyIconW(NIM_MODIFY, &nid);
}

void TrayApp::showContextMenu() {
    const TrayStateSnapshot snap = controller_.getTraySnapshot();

    HMENU hMenu = CreatePopupMenu();
    if (!hMenu) return;

    if (const auto updateInfo = updater_.available()) {
        const std::wstring updateLabel = L"Update to " + utf8ToWide(updateInfo->version);
        UINT updateFlags = MF_STRING;
        if (installInProgress_) {
            updateFlags |= MF_GRAYED;
        }
        AppendMenuW(hMenu, updateFlags, kCmdUpdateNow, updateLabel.c_str());
        AppendMenuW(hMenu, MF_SEPARATOR, 0, nullptr);
    }

    wchar_t statusLine[160]{};
    if (snap.running) {
        const std::wstring wDev = utf8ToWide(snap.device);
        swprintf_s(statusLine, L"%ls (%.1f ms)", wDev.c_str(), snap.roundTripMs);
    } else {
        const std::wstring wErr = snap.lastError.empty() ? L"Stopped" : utf8ToWide(snap.lastError);
        swprintf_s(statusLine, L"Stopped: %ls", wErr.c_str());
    }
    AppendMenuW(hMenu, MF_STRING | MF_GRAYED, 0, statusLine);
    AppendMenuW(hMenu, MF_SEPARATOR, 0, nullptr);

    // Presets > submenu (radio items)
    HMENU hPresetsMenu = CreatePopupMenu();
    for (size_t i = 0; i < snap.presetIdAndNames.size(); ++i) {
        const auto& [id, name] = snap.presetIdAndNames[i];
        const std::wstring wName = utf8ToWide(name);
        const UINT itemId = kCmdBasePreset + static_cast<UINT>(i);
        UINT flags = MF_STRING;
        if (id == snap.currentPresetId) {
            flags |= MF_CHECKED;
        }
        AppendMenuW(hPresetsMenu, flags, itemId, wName.c_str());
    }
    if (!snap.presetIdAndNames.empty()) {
        CheckMenuRadioItem(
            hPresetsMenu,
            kCmdBasePreset,
            kCmdBasePreset + static_cast<UINT>(snap.presetIdAndNames.size() - 1),
            kCmdBasePreset + static_cast<UINT>(std::distance(
                snap.presetIdAndNames.begin(),
                std::find_if(snap.presetIdAndNames.begin(), snap.presetIdAndNames.end(),
                             [&](const auto& pair) { return pair.first == snap.currentPresetId; }))),
            MF_BYCOMMAND
        );
    }
    AppendMenuW(hMenu, MF_POPUP, reinterpret_cast<UINT_PTR>(hPresetsMenu), L"Presets");

    // Input > submenu (radio items)
    HMENU hInputMenu = CreatePopupMenu();
    AppendMenuW(hInputMenu, MF_STRING, kCmdInput1, L"Input 1");
    AppendMenuW(hInputMenu, MF_STRING, kCmdInput2, L"Input 2");
    AppendMenuW(hInputMenu, MF_STRING, kCmdInputBoth, L"Both");
    const UINT activeInputCmd = (snap.inputChannel == 1) ? kCmdInput2
                              : (snap.inputChannel == 2) ? kCmdInputBoth
                                                         : kCmdInput1;
    CheckMenuRadioItem(hInputMenu, kCmdInput1, kCmdInputBoth, activeInputCmd, MF_BYCOMMAND);
    AppendMenuW(hMenu, MF_POPUP, reinterpret_cast<UINT_PTR>(hInputMenu), L"Input");

    AppendMenuW(hMenu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(hMenu, MF_STRING | (snap.bypass ? MF_CHECKED : MF_UNCHECKED), kCmdBypass, L"Bypass");
    AppendMenuW(hMenu, MF_STRING | (snap.mute ? MF_CHECKED : MF_UNCHECKED), kCmdMute, L"Mute");
    AppendMenuW(hMenu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(hMenu, MF_STRING, kCmdAsioPanel, L"ASIO control panel...");
    AppendMenuW(hMenu, MF_STRING, kCmdCheckUpdates, L"Check for updates");
    AppendMenuW(hMenu, MF_STRING, kCmdOpenWoodshed, L"Open Woodshed");
    AppendMenuW(hMenu, MF_STRING | (snap.startWithWindows ? MF_CHECKED : MF_UNCHECKED),
                kCmdStartWithWindows, L"Start with Windows");
    AppendMenuW(hMenu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(hMenu, MF_STRING, kCmdQuit, L"Quit");

    POINT pt{};
    GetCursorPos(&pt);
    SetForegroundWindow(hwnd_);

    const UINT chosen = TrackPopupMenu(
        hMenu,
        TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
        pt.x, pt.y,
        0,
        hwnd_,
        nullptr
    );
    PostMessageW(hwnd_, WM_NULL, 0, 0);
    DestroyMenu(hMenu);

    if (chosen == 0) return;

    if (chosen >= kCmdBasePreset && chosen < kCmdBasePreset + snap.presetIdAndNames.size()) {
        const size_t idx = chosen - kCmdBasePreset;
        controller_.enqueueSelectPreset(snap.presetIdAndNames[idx].first);
    } else if (chosen == kCmdInput1) {
        controller_.enqueueSetInputChannel(0);
    } else if (chosen == kCmdInput2) {
        controller_.enqueueSetInputChannel(1);
    } else if (chosen == kCmdInputBoth) {
        controller_.enqueueSetInputChannel(2);
    } else if (chosen == kCmdBypass) {
        controller_.enqueueToggleBypass();
    } else if (chosen == kCmdMute) {
        controller_.enqueueToggleMute();
    } else if (chosen == kCmdAsioPanel) {
        controller_.enqueueOpenAsioPanel();
    } else if (chosen == kCmdCheckUpdates) {
        manualCheckPending_ = true;
        updater_.checkAsync(hwnd_, true);
    } else if (chosen == kCmdUpdateNow) {
        if (!installInProgress_) {
            installInProgress_ = true;
            showBalloon(L"Woodshed Amp", L"Downloading update\u2026", false);
            updater_.installAsync(hwnd_);
        }
    } else if (chosen == kCmdOpenWoodshed) {
        ShellExecuteW(nullptr, L"open", kSiteUrlW, nullptr, nullptr, SW_SHOWNORMAL);
    } else if (chosen == kCmdStartWithWindows) {
        controller_.enqueueSetStartWithWindows(!snap.startWithWindows);
    } else if (chosen == kCmdQuit) {
        removeTrayIcon();
        PostQuitMessage(0);
    }
}

LRESULT CALLBACK TrayApp::wndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == WM_NCCREATE) {
        auto* cs = reinterpret_cast<CREATESTRUCTW*>(lParam);
        auto* self = static_cast<TrayApp*>(cs->lpCreateParams);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        self->hwnd_ = hwnd;
        return TRUE;
    }

    auto* self = reinterpret_cast<TrayApp*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (self) {
        return self->handleMessage(msg, wParam, lParam);
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

LRESULT TrayApp::handleMessage(UINT msg, WPARAM wParam, LPARAM lParam) {
    if (alreadyRunningMsg_ != 0 && msg == alreadyRunningMsg_) {
        showBalloon(L"Woodshed Amp", L"Woodshed Amp is already running.", false);
        return 0;
    }

    if (taskbarCreatedMsg_ != 0 && msg == taskbarCreatedMsg_) {
        iconAdded_ = false;
        addTrayIcon();
        updateTooltip();
        return 0;
    }

    switch (msg) {
        case kMsgTrayCallback: {
            const UINT event = LOWORD(lParam);
            if (event == WM_RBUTTONUP || event == WM_CONTEXTMENU) {
                showContextMenu();
            } else if (event == WM_LBUTTONDBLCLK) {
                controller_.enqueueToggleBypass();
            }
            return 0;
        }

        case WM_TIMER: {
            if (wParam == kTimerTooltip) {
                updateTooltip();
            } else if (wParam == kTimerUpdateFirst) {
                KillTimer(hwnd_, kTimerUpdateFirst);
                updater_.checkAsync(hwnd_, false);
            } else if (wParam == kTimerUpdateRepeat) {
                updater_.checkAsync(hwnd_, false);
            }
            return 0;
        }

        case kMsgUpdateAvailable: {
            manualCheckPending_ = false;
            if (const auto info = updater_.available()) {
                if (notifiedVersion_ != info->version) {
                    notifiedVersion_ = info->version;
                    const std::wstring wVer = utf8ToWide(info->version);
                    showBalloon(L"Woodshed Amp " + wVer + L" is available",
                                L"Right-click the amp icon and choose Update.", false);
                }
            }
            return 0;
        }

        case kMsgUpdateNone: {
            manualCheckPending_ = false;
            showBalloon(L"You're up to date",
                        std::wstring(L"Woodshed Amp ") + kAmpVersionW + L" is the latest.", false);
            return 0;
        }

        case kMsgUpdateFailed: {
            const bool showFailure = manualCheckPending_ || installInProgress_;
            manualCheckPending_ = false;
            installInProgress_ = false;
            if (showFailure) {
                const std::wstring wErr = utf8ToWide(updater_.lastError());
                showBalloon(L"Update failed", wErr.empty() ? L"Unknown error." : wErr, true);
            }
            return 0;
        }

        case kMsgUpdateReady: {
            installInProgress_ = false;
            controller_.stop();
            removeTrayIcon();

            std::wstring exePath(MAX_PATH, L'\0');
            while (true) {
                const DWORD len = GetModuleFileNameW(nullptr, exePath.data(), static_cast<DWORD>(exePath.size()));
                if (len == 0) {
                    exePath.clear();
                    break;
                }
                if (len < exePath.size() - 1) {
                    exePath.resize(len);
                    break;
                }
                exePath.resize(exePath.size() * 2);
            }

            if (!exePath.empty()) {
                std::wstring cmdLine = L"\"" + exePath + L"\" --updated";
                STARTUPINFOW si{};
                si.cb = sizeof(si);
                PROCESS_INFORMATION pi{};
                if (CreateProcessW(exePath.c_str(), cmdLine.data(), nullptr, nullptr, FALSE,
                                   0, nullptr, nullptr, &si, &pi)) {
                    CloseHandle(pi.hThread);
                    CloseHandle(pi.hProcess);
                }
            }

            PostQuitMessage(0);
            return 0;
        }

        case WM_QUERYENDSESSION:
            return TRUE;

        case WM_ENDSESSION: {
            if (wParam == TRUE) {
                removeTrayIcon();
                controller_.stop();
            }
            return 0;
        }

        case WM_DESTROY: {
            removeTrayIcon();
            PostQuitMessage(0);
            return 0;
        }
    }

    return DefWindowProcW(hwnd_, msg, wParam, lParam);
}

} // namespace wsamp
