#include <winsock2.h>
#include <windows.h>
#include <objbase.h>

#include "app_controller.h"
#include "tray.h"
#include "updater.h"
#include "version.h"

#include <cwchar>
#include <string>

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE /*hPrevInstance*/, LPSTR /*lpCmdLine*/, int /*nCmdShow*/) {
    wsamp::Updater::cleanupOld();

    const wchar_t* cmdLine = GetCommandLineW();
    const bool isUpdated = (cmdLine != nullptr && std::wcsstr(cmdLine, L"--updated") != nullptr);
    const bool autostartOn = (cmdLine != nullptr && std::wcsstr(cmdLine, L"--autostart=on") != nullptr);
    const bool autostartOff = (cmdLine != nullptr && std::wcsstr(cmdLine, L"--autostart=off") != nullptr);
    const bool hasAutostartArg = autostartOn || autostartOff;

    const UINT alreadyRunningMsg = RegisterWindowMessageW(L"WoodshedAmpAlreadyRunningMsg");

    HANDLE hMutex = CreateMutexW(nullptr, TRUE, L"WoodshedAmpSingleInstance");
    if (hMutex != nullptr && GetLastError() == ERROR_ALREADY_EXISTS) {
        CloseHandle(hMutex);
        hMutex = nullptr;

        if (isUpdated) {
            for (int attempt = 0; attempt < 50; ++attempt) {
                Sleep(200);
                HANDLE hTry = CreateMutexW(nullptr, TRUE, L"WoodshedAmpSingleInstance");
                if (hTry != nullptr) {
                    if (GetLastError() != ERROR_ALREADY_EXISTS) {
                        hMutex = hTry;
                        break;
                    }
                    CloseHandle(hTry);
                }
            }
            if (hMutex == nullptr) {
                return 1;
            }
            wsamp::Updater::cleanupOld();
        } else {
            if (!hasAutostartArg && alreadyRunningMsg != 0) {
                PostMessageW(HWND_BROADCAST, alreadyRunningMsg, 0, 0);
            }
            return 0;
        }
    }

    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    wsamp::AppController controller;
    wsamp::TrayApp tray(controller);

    if (!tray.create(hInstance, alreadyRunningMsg)) {
        CoUninitialize();
        if (hMutex) CloseHandle(hMutex);
        return 1;
    }

    if (isUpdated) {
        tray.showBalloon(
            L"Woodshed Amp updated",
            std::wstring(L"Now running version ") + wsamp::kAmpVersionW + L".",
            false
        );
    }

    controller.start();
    if (autostartOn) {
        controller.enqueueSetStartWithWindows(true);
    } else if (autostartOff) {
        controller.enqueueSetStartWithWindows(false);
    }

    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    controller.stop();
    tray.destroy();

    CoUninitialize();
    if (hMutex) {
        ReleaseMutex(hMutex);
        CloseHandle(hMutex);
    }
    return static_cast<int>(msg.wParam);
}
