#pragma once
#include <string>

namespace wsamp {

// What Windows' "devices changed" should do. PortAudio's device list is frozen at Pa_Initialize, so the only
// way to see a newly plugged (or removed) interface is to stop the stream and re-initialize; that is worth it
// unless we are already happily running on the interface the player chose.
//   running        a stream is open
//   openDevice     the device that stream is on
//   preferred      the player's saved device ("" = no choice: any device will do)
//   openAlive      the open stream's callbacks are still arriving (false: its device went away)
inline bool shouldRescanOnDeviceChange(bool running, const std::string& openDevice,
                                       const std::string& preferred, bool openAlive) {
    if (!running) return true;                         // nothing open: maybe the interface is here now
    if (!openAlive) return true;                       // the device in use vanished: fall back
    if (preferred.empty()) return false;               // no preference and a working stream
    return openDevice != preferred;                    // on a fallback: the preferred one may be back
}

} // namespace wsamp
