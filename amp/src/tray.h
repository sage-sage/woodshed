#pragma once

#include <windows.h>

#include <string>

#include "app_controller.h"
#include "updater.h"

namespace wsamp {

class TrayApp {
public:
    static constexpr UINT kMsgTrayCallback = WM_APP + 1;
    static constexpr UINT kMsgBalloon = WM_APP + 2;
    static constexpr UINT kMsgUpdateAvailable = wsamp::kMsgUpdateAvailable;
    static constexpr UINT kMsgUpdateNone = wsamp::kMsgUpdateNone;
    static constexpr UINT kMsgUpdateFailed = wsamp::kMsgUpdateFailed;
    static constexpr UINT kMsgUpdateReady = wsamp::kMsgUpdateReady;
    static constexpr UINT_PTR kTimerTooltip = 1;
    static constexpr UINT_PTR kTimerUpdateFirst = 2;
    static constexpr UINT_PTR kTimerUpdateRepeat = 3;

    explicit TrayApp(AppController& controller);
    ~TrayApp();

    TrayApp(const TrayApp&) = delete;
    TrayApp& operator=(const TrayApp&) = delete;

    bool create(HINSTANCE hInstance, UINT alreadyRunningMsg);
    void destroy();

    HWND hwnd() const noexcept { return hwnd_; }
    void showBalloon(const std::wstring& title, const std::wstring& message, bool isError);

private:
    static LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);
    LRESULT handleMessage(UINT msg, WPARAM wParam, LPARAM lParam);

    HICON createRubyJewelIcon(int size);
    void addTrayIcon();
    void removeTrayIcon();
    void updateTooltip();
    void showContextMenu();

    AppController& controller_;
    Updater updater_;
    std::string notifiedVersion_;
    bool manualCheckPending_ = false;
    bool installInProgress_ = false;
    HINSTANCE hInstance_ = nullptr;
    HWND hwnd_ = nullptr;
    HICON hIcon16_ = nullptr;
    HICON hIcon32_ = nullptr;
    UINT alreadyRunningMsg_ = 0;
    UINT taskbarCreatedMsg_ = 0;
    UINT quitForUpdateMsg_ = 0;
    bool iconAdded_ = false;
};

} // namespace wsamp
