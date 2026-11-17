#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <mutex>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace wsamp {

class IWsMessageHandler {
public:
    virtual ~IWsMessageHandler() = default;
    virtual void onClientConnected(uint32_t clientId) = 0;
    virtual void onClientDisconnected(uint32_t clientId) = 0;
    virtual void onClientTextMessage(uint32_t clientId, std::string_view text) = 0;
    virtual void onClientBinaryMessage(uint32_t clientId, std::span<const uint8_t> data) {}
};

// Origin allow-list check per SPEC.md
bool isOriginAllowed(std::string_view origin, std::span<const std::string> extraOrigins = {});

// Loads %APPDATA%\WoodshedAmp\origins.txt (one origin per line)
std::vector<std::string> loadExtraOriginsFile(const std::filesystem::path& path);
std::filesystem::path defaultOriginsFilePath();

// HTTP WebSocket Upgrade parsing & response helpers
struct HttpUpgradeRequest {
    std::string path;
    std::string origin;
    std::string secWebSocketKey;
    bool hasUpgradeWebSocket = false;
    bool hasConnectionUpgrade = false;
};

enum class HttpParseStatus {
    Incomplete,
    ValidUpgrade,
    BadRequest
};

HttpParseStatus parseHttpUpgradeRequest(std::string_view rawHeaders,
                                        HttpUpgradeRequest& outReq,
                                        size_t& headerBytesConsumed);

std::string buildHttpUpgradeResponse(std::string_view secWebSocketKey);
std::string buildHttpForbiddenResponse();

// RFC 6455 frame encoding & decoding
enum class WsOpcode : uint8_t {
    Continuation = 0x0,
    Text = 0x1,
    Binary = 0x2,
    Close = 0x8,
    Ping = 0x9,
    Pong = 0xA
};

struct WsFrame {
    bool fin = true;
    WsOpcode opcode = WsOpcode::Text;
    bool masked = false;
    std::vector<uint8_t> payload;
};

enum class WsDecodeStatus {
    Ok,
    Incomplete,
    ProtocolError
};

std::vector<uint8_t> encodeWsFrame(WsOpcode opcode,
                                   std::span<const uint8_t> payload,
                                   bool fin = true,
                                   bool masked = false,
                                   std::array<uint8_t, 4> maskKey = {0, 0, 0, 0});

WsDecodeStatus decodeWsFrame(std::span<const uint8_t> buffer,
                             WsFrame& outFrame,
                             size_t& bytesConsumed,
                             size_t maxPayloadBytes = 65536);

// Builds a WSA1 binary audio payload:
// 'WSA1' (4B) + sampleRate u32 LE + frameIndex u32 LE + count u32 LE + count * int16 LE.
std::vector<uint8_t> buildWsa1Frame(uint32_t sampleRate,
                                    uint32_t frameIndex,
                                    std::span<const int16_t> samples);

// Parses and validates a WSA1 binary audio payload into aligned int16_t storage.
bool parseWsa1Frame(std::span<const uint8_t> payload,
                    uint32_t& sampleRate,
                    uint32_t& frameIndex,
                    std::vector<int16_t>& samples);

class WsServer {
public:
    static constexpr uint16_t kDefaultPort = 47800;
    static constexpr size_t kMaxClients = 4;
    static constexpr size_t kMaxReassembledBytes = 65536;
    static constexpr size_t kMaxTabImportBytes = 8 * 1024 * 1024;
    static constexpr size_t kMaxSendQueueBytes = 256 * 1024;

    explicit WsServer(IWsMessageHandler& handler, uint16_t port = kDefaultPort);
    ~WsServer();

    WsServer(const WsServer&) = delete;
    WsServer& operator=(const WsServer&) = delete;

    bool start();
    void stop();

    // Thread-safe outbound messaging (callable from AppController thread)
    void sendTextToClient(uint32_t clientId, std::string_view jsonText);
    size_t sendTextToOrigin(std::string_view origin, std::string_view jsonText);
    void broadcastText(std::string_view jsonText);
    void broadcastAudioFrame(std::span<const uint8_t> wsa1Payload);
    void setClientStreaming(uint32_t clientId, bool on);
    bool isRestrictedClient(uint32_t clientId) const;

    bool hasStreamingClients() const noexcept {
        return streamingClientCount_.load(std::memory_order_acquire) > 0;
    }

    size_t connectedClientCount() const noexcept {
        return connectedClientCount_.load(std::memory_order_acquire);
    }

private:
    struct OutboundPacket {
        std::vector<uint8_t> data;
        bool isAudio = false;
    };

    struct ClientConn {
        uintptr_t sock = ~static_cast<uintptr_t>(0);
        uint32_t id = 0;
        bool upgraded = false;
        bool restricted = false;
        bool streaming = false;
        bool closing = false;
        std::string origin;

        std::string recvBuf;
        bool assemblingFragment = false;
        WsOpcode fragmentOpcode = WsOpcode::Text;
        std::vector<uint8_t> fragmentBuf;

        std::deque<OutboundPacket> sendQueue;
        size_t sendOffset = 0;
        size_t queuedBytes = 0;
    };

    void runLoop();
    void wakeSelect();
    void enqueueFrameLocked(ClientConn& c, WsOpcode opcode, std::span<const uint8_t> payload, bool isAudio);
    void handleClientReadable(ClientConn& c, std::vector<uint32_t>& disconnectedIds);
    void handleClientWritable(ClientConn& c);
    void closeClient(ClientConn& c, std::vector<uint32_t>& disconnectedIds);
    void updateAtomicCounts();

    IWsMessageHandler& handler_;
    uint16_t port_;
    std::vector<std::string> extraOrigins_;

    uintptr_t listenSock_ = ~static_cast<uintptr_t>(0);
    uintptr_t wakeSock_ = ~static_cast<uintptr_t>(0);
    uint16_t wakePort_ = 0;

    std::atomic<bool> running_{false};
    std::atomic<size_t> connectedClientCount_{0};
    std::atomic<size_t> streamingClientCount_{0};
    uint32_t nextClientId_ = 1;

    mutable std::mutex clientsMutex_;
    std::vector<ClientConn> clients_;
    std::thread serverThread_;
};

} // namespace wsamp
