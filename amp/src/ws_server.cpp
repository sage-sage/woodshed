#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include "ws_server.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <fstream>

#include "sha1_base64.h"

#include "version.h"

namespace wsamp {

namespace {

std::string trimAscii(std::string_view sv) {
    size_t start = 0;
    while (start < sv.size() && std::isspace(static_cast<unsigned char>(sv[start]))) {
        ++start;
    }
    size_t end = sv.size();
    while (end > start && std::isspace(static_cast<unsigned char>(sv[end - 1]))) {
        --end;
    }
    return std::string(sv.substr(start, end - start));
}

std::string toLowerAscii(std::string_view sv) {
    std::string out(sv);
    for (char& ch : out) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    return out;
}

bool isValidPortDigits(std::string_view portStr) {
    if (portStr.empty() || portStr.size() > 5) return false;
    uint32_t val = 0;
    for (char c : portStr) {
        if (!std::isdigit(static_cast<unsigned char>(c))) return false;
        val = val * 10u + static_cast<uint32_t>(c - '0');
    }
    return val >= 1u && val <= 65535u;
}

bool isValidSubdomainLabelPrefix(std::string_view prefix) {
    // prefix is everything before ".claude.ai" or ".claudeusercontent.com"
    if (prefix.empty()) return false;
    if (prefix.front() == '.' || prefix.back() == '.') return false;

    bool atLabelStart = true;
    for (size_t i = 0; i < prefix.size(); ++i) {
        const char c = prefix[i];
        if (c == '.') {
            if (atLabelStart) return false; // consecutive dots
            atLabelStart = true;
        } else if (std::isalnum(static_cast<unsigned char>(c)) || c == '-') {
            if (atLabelStart && c == '-') return false;
            atLabelStart = false;
        } else {
            return false;
        }
    }
    return true;
}

bool matchHostWithOptionalPort(std::string_view hostPort, std::string_view expectedHost) {
    if (hostPort == expectedHost) return true;
    if (hostPort.size() > expectedHost.size() + 1 &&
        hostPort.starts_with(expectedHost) &&
        hostPort[expectedHost.size()] == ':') {
        return isValidPortDigits(hostPort.substr(expectedHost.size() + 1));
    }
    return false;
}

bool matchWildcardSuffixHost(std::string_view hostPort, std::string_view suffixDomain) {
    // e.g. suffixDomain = ".claudeusercontent.com"
    std::string_view host = hostPort;
    const size_t colon = hostPort.find(':');
    if (colon != std::string_view::npos) {
        if (!isValidPortDigits(hostPort.substr(colon + 1))) return false;
        host = hostPort.substr(0, colon);
    }
    if (host.size() <= suffixDomain.size()) return false;
    if (!host.ends_with(suffixDomain)) return false;
    const std::string_view prefix = host.substr(0, host.size() - suffixDomain.size());
    return isValidSubdomainLabelPrefix(prefix);
}

bool containsHeaderTokenCI(std::string_view headerVal, std::string_view token) {
    const std::string lowerVal = toLowerAscii(headerVal);
    const std::string lowerTok = toLowerAscii(token);
    size_t pos = 0;
    while (pos < lowerVal.size()) {
        size_t comma = lowerVal.find(',', pos);
        if (comma == std::string::npos) comma = lowerVal.size();
        const std::string part = trimAscii(std::string_view(lowerVal).substr(pos, comma - pos));
        if (part == lowerTok) return true;
        pos = comma + 1;
    }
    return false;
}

} // namespace


bool isOriginAllowed(std::string_view origin, std::span<const std::string> extraOrigins) {
    const std::string trimmed = trimAscii(origin);
    if (trimmed.empty()) return false;

    const std::string lower = toLowerAscii(trimmed);
    if (lower == "null") return false;

    const std::string pagesOriginLower = toLowerAscii(trimAscii(kPagesOrigin));
    if (!pagesOriginLower.empty() && lower == pagesOriginLower) {
        return true;
    }
    if (lower == toLowerAscii(kDesktopOrigin)) {
        return true;  // the Woodshed desktop app (WebView2 virtual host)
    }

    // Check custom extra origins from origins.txt
    for (const auto& extra : extraOrigins) {
        const std::string normExtra = toLowerAscii(trimAscii(extra));
        if (!normExtra.empty() && lower == normExtra) {
            return true;
        }
    }

    const size_t schemeSep = lower.find("://");
    if (schemeSep == std::string::npos) return false;

    const std::string_view scheme = std::string_view(lower).substr(0, schemeSep);
    const std::string_view rest = std::string_view(lower).substr(schemeSep + 3);
    if (rest.empty()) return false;

    // Origins must not contain path, query, fragment, or userinfo
    if (rest.find_first_of("/?#@") != std::string_view::npos) {
        return false;
    }

    if (scheme == "http") {
        return matchHostWithOptionalPort(rest, "localhost") ||
               matchHostWithOptionalPort(rest, "127.0.0.1");
    }

    if (scheme == "https") {
        if (matchHostWithOptionalPort(rest, "localhost") ||
            matchHostWithOptionalPort(rest, "127.0.0.1") ||
            matchHostWithOptionalPort(rest, "claude.ai")) {
            return true;
        }
        if (matchWildcardSuffixHost(rest, ".claude.ai") ||
            matchWildcardSuffixHost(rest, ".claudeusercontent.com")) {
            return true;
        }
    }

    return false;
}

std::filesystem::path defaultOriginsFilePath() {
    if (const char* appData = std::getenv("APPDATA"); appData != nullptr && appData[0] != '\0') {
        return std::filesystem::path(appData) / "WoodshedAmp" / "origins.txt";
    }
    return std::filesystem::path("origins.txt");
}

std::vector<std::string> loadExtraOriginsFile(const std::filesystem::path& path) {
    std::vector<std::string> list;
    std::ifstream in(path);
    if (!in) return list;

    std::string line;
    while (std::getline(in, line)) {
        const std::string t = trimAscii(line);
        if (t.empty() || t[0] == '#') continue;
        list.push_back(t);
    }
    return list;
}

HttpParseStatus parseHttpUpgradeRequest(std::string_view rawHeaders,
                                        HttpUpgradeRequest& outReq,
                                        size_t& headerBytesConsumed) {
    const size_t endPos = rawHeaders.find("\r\n\r\n");
    if (endPos == std::string_view::npos) {
        headerBytesConsumed = 0;
        return HttpParseStatus::Incomplete;
    }

    headerBytesConsumed = endPos + 4;
    outReq = HttpUpgradeRequest{};

    const std::string_view block = rawHeaders.substr(0, endPos);
    size_t lineStart = 0;
    bool firstLine = true;

    while (lineStart < block.size()) {
        size_t lineEnd = block.find("\r\n", lineStart);
        if (lineEnd == std::string_view::npos) lineEnd = block.size();
        const std::string_view line = block.substr(lineStart, lineEnd - lineStart);
        lineStart = lineEnd + 2;

        if (firstLine) {
            firstLine = false;
            // Expect: GET <path> HTTP/1.1
            const size_t sp1 = line.find(' ');
            if (sp1 == std::string_view::npos) return HttpParseStatus::BadRequest;
            const std::string_view method = line.substr(0, sp1);
            if (method != "GET") return HttpParseStatus::BadRequest;

            const size_t sp2 = line.find(' ', sp1 + 1);
            if (sp2 == std::string_view::npos) return HttpParseStatus::BadRequest;
            outReq.path = std::string(line.substr(sp1 + 1, sp2 - (sp1 + 1)));
            continue;
        }

        const size_t colon = line.find(':');
        if (colon == std::string_view::npos) continue;

        const std::string name = toLowerAscii(trimAscii(line.substr(0, colon)));
        const std::string val = trimAscii(line.substr(colon + 1));

        if (name == "upgrade") {
            if (toLowerAscii(val) == "websocket") {
                outReq.hasUpgradeWebSocket = true;
            }
        } else if (name == "connection") {
            if (containsHeaderTokenCI(val, "upgrade")) {
                outReq.hasConnectionUpgrade = true;
            }
        } else if (name == "sec-websocket-key") {
            outReq.secWebSocketKey = val;
        } else if (name == "origin") {
            outReq.origin = val;
        }
    }

    if (!outReq.hasUpgradeWebSocket || !outReq.hasConnectionUpgrade || outReq.secWebSocketKey.empty()) {
        return HttpParseStatus::BadRequest;
    }
    return HttpParseStatus::ValidUpgrade;
}

std::string buildHttpUpgradeResponse(std::string_view secWebSocketKey) {
    const std::string accept = computeWebSocketAccept(secWebSocketKey);
    std::string resp;
    resp.reserve(160);
    resp += "HTTP/1.1 101 Switching Protocols\r\n";
    resp += "Upgrade: websocket\r\n";
    resp += "Connection: Upgrade\r\n";
    resp += "Sec-WebSocket-Accept: ";
    resp += accept;
    resp += "\r\n\r\n";
    return resp;
}

std::string buildHttpForbiddenResponse() {
    return "HTTP/1.1 403 Forbidden\r\n"
           "Content-Type: text/plain\r\n"
           "Content-Length: 9\r\n"
           "Connection: close\r\n\r\n"
           "Forbidden";
}

std::vector<uint8_t> encodeWsFrame(WsOpcode opcode,
                                   std::span<const uint8_t> payload,
                                   bool fin,
                                   bool masked,
                                   std::array<uint8_t, 4> maskKey) {
    std::vector<uint8_t> frame;
    frame.reserve(payload.size() + 14);

    const uint8_t b0 = static_cast<uint8_t>((fin ? 0x80u : 0x00u) | (static_cast<uint8_t>(opcode) & 0x0Fu));
    frame.push_back(b0);

    const uint8_t maskBit = masked ? 0x80u : 0x00u;
    const size_t len = payload.size();
    if (len <= 125) {
        frame.push_back(static_cast<uint8_t>(maskBit | static_cast<uint8_t>(len)));
    } else if (len <= 65535) {
        frame.push_back(static_cast<uint8_t>(maskBit | 126u));
        frame.push_back(static_cast<uint8_t>((len >> 8) & 0xFFu));
        frame.push_back(static_cast<uint8_t>(len & 0xFFu));
    } else {
        frame.push_back(static_cast<uint8_t>(maskBit | 127u));
        const uint64_t len64 = static_cast<uint64_t>(len);
        for (int shift = 56; shift >= 0; shift -= 8) {
            frame.push_back(static_cast<uint8_t>((len64 >> shift) & 0xFFu));
        }
    }

    if (masked) {
        frame.insert(frame.end(), maskKey.begin(), maskKey.end());
        for (size_t i = 0; i < len; ++i) {
            frame.push_back(static_cast<uint8_t>(payload[i] ^ maskKey[i & 3u]));
        }
    } else {
        frame.insert(frame.end(), payload.begin(), payload.end());
    }

    return frame;
}

WsDecodeStatus decodeWsFrame(std::span<const uint8_t> buffer,
                             WsFrame& outFrame,
                             size_t& bytesConsumed,
                             size_t maxPayloadBytes) {
    bytesConsumed = 0;
    if (buffer.size() < 2) {
        return WsDecodeStatus::Incomplete;
    }

    const uint8_t b0 = buffer[0];
    const uint8_t b1 = buffer[1];

    if ((b0 & 0x70u) != 0) {
        return WsDecodeStatus::ProtocolError; // RSV1..3 must be 0
    }

    const bool fin = (b0 & 0x80u) != 0;
    const uint8_t opRaw = b0 & 0x0Fu;
    const bool masked = (b1 & 0x80u) != 0;
    uint64_t payloadLen = b1 & 0x7Fu;
    size_t offset = 2;

    if (payloadLen == 126u) {
        if (buffer.size() < offset + 2) return WsDecodeStatus::Incomplete;
        payloadLen = (static_cast<uint64_t>(buffer[offset]) << 8) |
                     static_cast<uint64_t>(buffer[offset + 1]);
        offset += 2;
    } else if (payloadLen == 127u) {
        if (buffer.size() < offset + 8) return WsDecodeStatus::Incomplete;
        if ((buffer[offset] & 0x80u) != 0) return WsDecodeStatus::ProtocolError;
        payloadLen = 0;
        for (int i = 0; i < 8; ++i) {
            payloadLen = (payloadLen << 8) | static_cast<uint64_t>(buffer[offset + i]);
        }
        offset += 8;
    }

    if (payloadLen > maxPayloadBytes) {
        return WsDecodeStatus::ProtocolError;
    }

    std::array<uint8_t, 4> maskKey{0, 0, 0, 0};
    if (masked) {
        if (buffer.size() < offset + 4) return WsDecodeStatus::Incomplete;
        for (int i = 0; i < 4; ++i) {
            maskKey[i] = buffer[offset + i];
        }
        offset += 4;
    }

    const size_t totalNeeded = offset + static_cast<size_t>(payloadLen);
    if (buffer.size() < totalNeeded) {
        return WsDecodeStatus::Incomplete;
    }

    outFrame.fin = fin;
    outFrame.opcode = static_cast<WsOpcode>(opRaw);
    outFrame.masked = masked;
    outFrame.payload.resize(static_cast<size_t>(payloadLen));

    if (masked) {
        for (size_t i = 0; i < static_cast<size_t>(payloadLen); ++i) {
            outFrame.payload[i] = static_cast<uint8_t>(buffer[offset + i] ^ maskKey[i & 3u]);
        }
    } else if (payloadLen > 0) {
        std::memcpy(outFrame.payload.data(), buffer.data() + offset, static_cast<size_t>(payloadLen));
    }

    bytesConsumed = totalNeeded;
    return WsDecodeStatus::Ok;
}

std::vector<uint8_t> buildWsa1Frame(uint32_t sampleRate,
                                    uint32_t frameIndex,
                                    std::span<const int16_t> samples) {
    const uint32_t count = static_cast<uint32_t>(samples.size());
    std::vector<uint8_t> out(16 + static_cast<size_t>(count) * 2);

    out[0] = 'W';
    out[1] = 'S';
    out[2] = 'A';
    out[3] = '1';

    auto writeU32 = [&](size_t off, uint32_t v) {
        out[off + 0] = static_cast<uint8_t>(v & 0xFFu);
        out[off + 1] = static_cast<uint8_t>((v >> 8) & 0xFFu);
        out[off + 2] = static_cast<uint8_t>((v >> 16) & 0xFFu);
        out[off + 3] = static_cast<uint8_t>((v >> 24) & 0xFFu);
    };

    writeU32(4, sampleRate);
    writeU32(8, frameIndex);
    writeU32(12, count);

    for (size_t i = 0; i < samples.size(); ++i) {
        const uint16_t u = static_cast<uint16_t>(samples[i]);
        out[16 + i * 2 + 0] = static_cast<uint8_t>(u & 0xFFu);
        out[16 + i * 2 + 1] = static_cast<uint8_t>((u >> 8) & 0xFFu);
    }

    return out;
}

// ============================================================================
// WsServer
// ============================================================================

WsServer::WsServer(IWsMessageHandler& handler, uint16_t port)
    : handler_(handler), port_(port) {
    extraOrigins_ = loadExtraOriginsFile(defaultOriginsFilePath());
}

WsServer::~WsServer() {
    stop();
}

bool WsServer::start() {
    if (running_.load(std::memory_order_acquire)) return true;

    WSADATA wsa{};
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        return false;
    }

    SOCKET ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (ls == INVALID_SOCKET) {
        WSACleanup();
        return false;
    }

    BOOL yes = TRUE;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&yes), sizeof(yes));

    u_long nonBlocking = 1;
    ioctlsocket(ls, FIONBIO, &nonBlocking);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // 127.0.0.1 only
    addr.sin_port = htons(port_);

    if (bind(ls, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) == SOCKET_ERROR ||
        listen(ls, 8) == SOCKET_ERROR) {
        closesocket(ls);
        WSACleanup();
        return false;
    }

    // Create loopback UDP wake-up socket so select() wakes immediately on outbound frames
    SOCKET ws = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (ws != INVALID_SOCKET) {
        ioctlsocket(ws, FIONBIO, &nonBlocking);
        sockaddr_in wakeAddr{};
        wakeAddr.sin_family = AF_INET;
        wakeAddr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        wakeAddr.sin_port = 0;
        if (bind(ws, reinterpret_cast<const sockaddr*>(&wakeAddr), sizeof(wakeAddr)) == 0) {
            int len = sizeof(wakeAddr);
            if (getsockname(ws, reinterpret_cast<sockaddr*>(&wakeAddr), &len) == 0) {
                wakePort_ = ntohs(wakeAddr.sin_port);
            }
        }
    }

    listenSock_ = static_cast<uintptr_t>(ls);
    wakeSock_ = static_cast<uintptr_t>(ws);
    running_.store(true, std::memory_order_release);
    serverThread_ = std::thread(&WsServer::runLoop, this);
    return true;
}

void WsServer::stop() {
    if (!running_.exchange(false, std::memory_order_acq_rel)) {
        return;
    }
    wakeSelect();
    if (serverThread_.joinable()) {
        serverThread_.join();
    }

    {
        std::lock_guard<std::mutex> lock(clientsMutex_);
        for (auto& c : clients_) {
            if (c.sock != static_cast<uintptr_t>(INVALID_SOCKET)) {
                closesocket(static_cast<SOCKET>(c.sock));
            }
        }
        clients_.clear();
        updateAtomicCounts();
    }

    if (wakeSock_ != static_cast<uintptr_t>(INVALID_SOCKET)) {
        closesocket(static_cast<SOCKET>(wakeSock_));
        wakeSock_ = static_cast<uintptr_t>(INVALID_SOCKET);
    }
    if (listenSock_ != static_cast<uintptr_t>(INVALID_SOCKET)) {
        closesocket(static_cast<SOCKET>(listenSock_));
        listenSock_ = static_cast<uintptr_t>(INVALID_SOCKET);
    }
    WSACleanup();
}

void WsServer::wakeSelect() {
    if (wakeSock_ == static_cast<uintptr_t>(INVALID_SOCKET) || wakePort_ == 0) return;
    sockaddr_in dst{};
    dst.sin_family = AF_INET;
    dst.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    dst.sin_port = htons(wakePort_);
    const char byte = 1;
    sendto(static_cast<SOCKET>(wakeSock_), &byte, 1, 0,
           reinterpret_cast<const sockaddr*>(&dst), sizeof(dst));
}

void WsServer::enqueueFrameLocked(ClientConn& c,
                                  WsOpcode opcode,
                                  std::span<const uint8_t> payload,
                                  bool isAudio) {
    if (!c.upgraded || c.closing) return;

    std::vector<uint8_t> encoded = encodeWsFrame(opcode, payload, true, false);
    if (isAudio && (c.queuedBytes + encoded.size() > kMaxSendQueueBytes)) {
        // Cap at 256 KB: drop audio frames, never JSON
        return;
    }

    c.queuedBytes += encoded.size();
    c.sendQueue.push_back(OutboundPacket{std::move(encoded), isAudio});
}

void WsServer::sendTextToClient(uint32_t clientId, std::string_view jsonText) {
    std::lock_guard<std::mutex> lock(clientsMutex_);
    for (auto& c : clients_) {
        if (c.id == clientId) {
            enqueueFrameLocked(c, WsOpcode::Text,
                               std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(jsonText.data()),
                                                        jsonText.size()),
                               false);
            break;
        }
    }
    wakeSelect();
}

void WsServer::broadcastText(std::string_view jsonText) {
    std::lock_guard<std::mutex> lock(clientsMutex_);
    const std::span<const uint8_t> bytes(reinterpret_cast<const uint8_t*>(jsonText.data()), jsonText.size());
    for (auto& c : clients_) {
        if (c.upgraded && !c.closing) {
            enqueueFrameLocked(c, WsOpcode::Text, bytes, false);
        }
    }
    wakeSelect();
}

void WsServer::broadcastAudioFrame(std::span<const uint8_t> wsa1Payload) {
    std::lock_guard<std::mutex> lock(clientsMutex_);
    for (auto& c : clients_) {
        if (c.upgraded && !c.closing && c.streaming) {
            enqueueFrameLocked(c, WsOpcode::Binary, wsa1Payload, true);
        }
    }
    wakeSelect();
}

void WsServer::setClientStreaming(uint32_t clientId, bool on) {
    std::lock_guard<std::mutex> lock(clientsMutex_);
    for (auto& c : clients_) {
        if (c.id == clientId) {
            c.streaming = on;
            break;
        }
    }
    updateAtomicCounts();
}

void WsServer::updateAtomicCounts() {
    size_t connected = 0;
    size_t streaming = 0;
    for (const auto& c : clients_) {
        if (c.upgraded && !c.closing) {
            ++connected;
            if (c.streaming) ++streaming;
        }
    }
    connectedClientCount_.store(connected, std::memory_order_release);
    streamingClientCount_.store(streaming, std::memory_order_release);
}

void WsServer::closeClient(ClientConn& c, std::vector<uint32_t>& disconnectedIds) {
    if (c.sock != static_cast<uintptr_t>(INVALID_SOCKET)) {
        closesocket(static_cast<SOCKET>(c.sock));
        c.sock = static_cast<uintptr_t>(INVALID_SOCKET);
    }
    if (c.upgraded) {
        disconnectedIds.push_back(c.id);
        c.upgraded = false;
    }
    c.streaming = false;
}

void WsServer::handleClientReadable(ClientConn& c, std::vector<uint32_t>& disconnectedIds) {
    char tmp[4096];
    while (true) {
        const int n = recv(static_cast<SOCKET>(c.sock), tmp, sizeof(tmp), 0);
        if (n > 0) {
            c.recvBuf.append(tmp, static_cast<size_t>(n));
            if (c.recvBuf.size() > 128 * 1024) {
                closeClient(c, disconnectedIds);
                return;
            }
        } else if (n == 0) {
            closeClient(c, disconnectedIds);
            return;
        } else {
            const int err = WSAGetLastError();
            if (err == WSAEWOULDBLOCK) break;
            closeClient(c, disconnectedIds);
            return;
        }
    }

    if (!c.upgraded) {
        if (c.recvBuf.size() > 8192 && c.recvBuf.find("\r\n\r\n") == std::string::npos) {
            closeClient(c, disconnectedIds);
            return;
        }

        HttpUpgradeRequest req;
        size_t consumed = 0;
        const HttpParseStatus st = parseHttpUpgradeRequest(c.recvBuf, req, consumed);
        if (st == HttpParseStatus::Incomplete) {
            return;
        }
        if (st == HttpParseStatus::BadRequest) {
            const std::string forbidden = buildHttpForbiddenResponse();
            std::vector<uint8_t> raw(forbidden.begin(), forbidden.end());
            c.queuedBytes += raw.size();
            c.sendQueue.push_back(OutboundPacket{std::move(raw), false});
            c.closing = true;
            return;
        }

        c.recvBuf.erase(0, consumed);

        if (!isOriginAllowed(req.origin, extraOrigins_)) {
            const std::string forbidden = buildHttpForbiddenResponse();
            std::vector<uint8_t> raw(forbidden.begin(), forbidden.end());
            c.queuedBytes += raw.size();
            c.sendQueue.push_back(OutboundPacket{std::move(raw), false});
            c.closing = true;
            return;
        }

        const std::string okResp = buildHttpUpgradeResponse(req.secWebSocketKey);
        std::vector<uint8_t> raw(okResp.begin(), okResp.end());
        c.queuedBytes += raw.size();
        c.sendQueue.push_back(OutboundPacket{std::move(raw), false});
        c.upgraded = true;
        updateAtomicCounts();
        handler_.onClientConnected(c.id);
    }

    // Parse WebSocket frames
    while (c.upgraded && !c.closing && !c.recvBuf.empty()) {
        WsFrame frame;
        size_t consumed = 0;
        const std::span<const uint8_t> view(
            reinterpret_cast<const uint8_t*>(c.recvBuf.data()), c.recvBuf.size());
        const WsDecodeStatus dec = decodeWsFrame(view, frame, consumed, kMaxReassembledBytes);

        if (dec == WsDecodeStatus::Incomplete) {
            break;
        }
        if (dec == WsDecodeStatus::ProtocolError || !frame.masked) {
            closeClient(c, disconnectedIds);
            return;
        }

        c.recvBuf.erase(0, consumed);

        // Control frames (may appear between fragmented data frames)
        if (frame.opcode == WsOpcode::Ping) {
            enqueueFrameLocked(c, WsOpcode::Pong, frame.payload, false);
            continue;
        }
        if (frame.opcode == WsOpcode::Pong) {
            continue;
        }
        if (frame.opcode == WsOpcode::Close) {
            enqueueFrameLocked(c, WsOpcode::Close, frame.payload, false);
            c.closing = true;
            break;
        }

        // Data frames & fragmentation up to 64 KB
        if (frame.opcode == WsOpcode::Text || frame.opcode == WsOpcode::Binary) {
            if (c.assemblingFragment) {
                closeClient(c, disconnectedIds);
                return;
            }
            if (frame.fin) {
                if (frame.opcode == WsOpcode::Text) {
                    const std::string_view txt(
                        reinterpret_cast<const char*>(frame.payload.data()), frame.payload.size());
                    handler_.onClientTextMessage(c.id, txt);
                }
            } else {
                c.assemblingFragment = true;
                c.fragmentOpcode = frame.opcode;
                c.fragmentBuf = std::move(frame.payload);
                if (c.fragmentBuf.size() > kMaxReassembledBytes) {
                    closeClient(c, disconnectedIds);
                    return;
                }
            }
        } else if (frame.opcode == WsOpcode::Continuation) {
            if (!c.assemblingFragment) {
                closeClient(c, disconnectedIds);
                return;
            }
            if (c.fragmentBuf.size() + frame.payload.size() > kMaxReassembledBytes) {
                closeClient(c, disconnectedIds);
                return;
            }
            c.fragmentBuf.insert(c.fragmentBuf.end(), frame.payload.begin(), frame.payload.end());
            if (frame.fin) {
                c.assemblingFragment = false;
                if (c.fragmentOpcode == WsOpcode::Text) {
                    const std::string_view txt(
                        reinterpret_cast<const char*>(c.fragmentBuf.data()), c.fragmentBuf.size());
                    handler_.onClientTextMessage(c.id, txt);
                }
                c.fragmentBuf.clear();
            }
        } else {
            closeClient(c, disconnectedIds);
            return;
        }
    }
}

void WsServer::handleClientWritable(ClientConn& c) {
    while (!c.sendQueue.empty() && c.sock != static_cast<uintptr_t>(INVALID_SOCKET)) {
        OutboundPacket& pkt = c.sendQueue.front();
        const size_t rem = pkt.data.size() - c.sendOffset;
        const int sent = send(static_cast<SOCKET>(c.sock),
                              reinterpret_cast<const char*>(pkt.data.data() + c.sendOffset),
                              static_cast<int>(rem),
                              0);
        if (sent > 0) {
            c.sendOffset += static_cast<size_t>(sent);
            c.queuedBytes -= static_cast<size_t>(sent);
            if (c.sendOffset >= pkt.data.size()) {
                c.sendQueue.pop_front();
                c.sendOffset = 0;
            }
        } else {
            const int err = WSAGetLastError();
            if (err == WSAEWOULDBLOCK) break;
            c.closing = true;
            c.sendQueue.clear();
            c.queuedBytes = 0;
            break;
        }
    }
}

void WsServer::runLoop() {
    while (running_.load(std::memory_order_acquire)) {
        fd_set readSet;
        fd_set writeSet;
        FD_ZERO(&readSet);
        FD_ZERO(&writeSet);

        const SOCKET ls = static_cast<SOCKET>(listenSock_);
        if (ls != INVALID_SOCKET) {
            FD_SET(ls, &readSet);
        }
        const SOCKET ws = static_cast<SOCKET>(wakeSock_);
        if (ws != INVALID_SOCKET) {
            FD_SET(ws, &readSet);
        }

        {
            std::lock_guard<std::mutex> lock(clientsMutex_);
            for (const auto& c : clients_) {
                const SOCKET s = static_cast<SOCKET>(c.sock);
                if (s == INVALID_SOCKET) continue;
                if (!c.closing) {
                    FD_SET(s, &readSet);
                }
                if (!c.sendQueue.empty()) {
                    FD_SET(s, &writeSet);
                }
            }
        }

        timeval tv{};
        tv.tv_sec = 0;
        tv.tv_usec = 5000; // 5 ms max wait
        const int ready = select(0, &readSet, &writeSet, nullptr, &tv);
        if (!running_.load(std::memory_order_acquire)) break;
        if (ready <= 0) continue;

        if (ws != INVALID_SOCKET && FD_ISSET(ws, &readSet)) {
            char drain[64];
            sockaddr_in from{};
            int fromLen = sizeof(from);
            while (recvfrom(ws, drain, sizeof(drain), 0,
                            reinterpret_cast<sockaddr*>(&from), &fromLen) > 0) {
            }
        }

        std::vector<uint32_t> disconnectedIds;
        {
            std::lock_guard<std::mutex> lock(clientsMutex_);

            if (ls != INVALID_SOCKET && FD_ISSET(ls, &readSet)) {
                sockaddr_in clientAddr{};
                int addrLen = sizeof(clientAddr);
                SOCKET cs = accept(ls, reinterpret_cast<sockaddr*>(&clientAddr), &addrLen);
                if (cs != INVALID_SOCKET) {
                    if (clients_.size() >= kMaxClients) {
                        closesocket(cs);
                    } else {
                        u_long nb = 1;
                        ioctlsocket(cs, FIONBIO, &nb);
                        BOOL noDelay = TRUE;
                        setsockopt(cs, IPPROTO_TCP, TCP_NODELAY,
                                   reinterpret_cast<const char*>(&noDelay), sizeof(noDelay));

                        ClientConn conn;
                        conn.sock = static_cast<uintptr_t>(cs);
                        conn.id = nextClientId_++;
                        clients_.push_back(std::move(conn));
                    }
                }
            }

            for (auto& c : clients_) {
                const SOCKET s = static_cast<SOCKET>(c.sock);
                if (s == INVALID_SOCKET) continue;

                if (FD_ISSET(s, &readSet)) {
                    handleClientReadable(c, disconnectedIds);
                }
                if (c.sock != static_cast<uintptr_t>(INVALID_SOCKET) && FD_ISSET(s, &writeSet)) {
                    handleClientWritable(c);
                }
                if (c.closing && c.sendQueue.empty() && c.sock != static_cast<uintptr_t>(INVALID_SOCKET)) {
                    closeClient(c, disconnectedIds);
                }
            }

            clients_.erase(
                std::remove_if(clients_.begin(), clients_.end(),
                               [](const ClientConn& c) {
                                   return c.sock == static_cast<uintptr_t>(INVALID_SOCKET);
                               }),
                clients_.end());
            updateAtomicCounts();
        }

        for (uint32_t id : disconnectedIds) {
            handler_.onClientDisconnected(id);
        }
    }
}

} // namespace wsamp
