#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "sha1_base64.h"
#include "ws_server.h"

namespace {

int gFailures = 0;

#define CHECK(cond)                                                                           \
    do {                                                                                      \
        if (!(cond)) {                                                                        \
            std::fprintf(stderr, "FAIL [%s:%d]: %s\n", __FILE__, __LINE__, #cond);            \
            ++gFailures;                                                                      \
        }                                                                                     \
    } while (0)

void testSha1Vectors() {
    // RFC 3174 / FIPS 180-1 standard test vectors
    CHECK(wsamp::sha1Hex("") == "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    CHECK(wsamp::sha1Hex("abc") == "a9993e364706816aba3e25717850c26c9cd0d89d");
    CHECK(wsamp::sha1Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ==
          "84983e441c3bd26ebaae4aa1f95129e5e54670f1");
}

void testBase64Vectors() {
    // RFC 4648 section 10 test vectors
    CHECK(wsamp::base64Encode("") == "");
    CHECK(wsamp::base64Encode("f") == "Zg==");
    CHECK(wsamp::base64Encode("fo") == "Zm8=");
    CHECK(wsamp::base64Encode("foo") == "Zm9v");
    CHECK(wsamp::base64Encode("foob") == "Zm9vYg==");
    CHECK(wsamp::base64Encode("fooba") == "Zm9vYmE=");
    CHECK(wsamp::base64Encode("foobar") == "Zm9vYmFy");

    const auto dec = wsamp::base64Decode("Zm9vYmFy");
    CHECK(dec.has_value());
    if (dec) {
        const std::string roundTrip(dec->begin(), dec->end());
        CHECK(roundTrip == "foobar");
    }
    CHECK(!wsamp::base64Decode("abc").has_value());
}

void testRfc6455Handshake() {
    // RFC 6455 Section 1.3 / 4.2.2 example
    const std::string accept = wsamp::computeWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ==");
    CHECK(accept == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");

    const std::string rawReq =
        "GET /ws HTTP/1.1\r\n"
        "Host: 127.0.0.1:47800\r\n"
        "Upgrade: websocket\r\n"
        "Connection: keep-alive, Upgrade\r\n"
        "Origin: http://localhost:8642\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n";

    wsamp::HttpUpgradeRequest req;
    size_t consumed = 0;
    CHECK(wsamp::parseHttpUpgradeRequest(rawReq, req, consumed) == wsamp::HttpParseStatus::ValidUpgrade);
    CHECK(consumed == rawReq.size());
    CHECK(req.path == "/ws");
    CHECK(req.origin == "http://localhost:8642");
    CHECK(req.secWebSocketKey == "dGhlIHNhbXBsZSBub25jZQ==");
    CHECK(wsamp::isOriginAllowed(req.origin));

    const std::string resp = wsamp::buildHttpUpgradeResponse(req.secWebSocketKey);
    CHECK(resp.find("HTTP/1.1 101 Switching Protocols\r\n") == 0);
    CHECK(resp.find("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n") != std::string::npos);

    const std::string forbidden = wsamp::buildHttpForbiddenResponse();
    CHECK(forbidden.find("HTTP/1.1 403 Forbidden\r\n") == 0);
}

void testOriginAllowList() {
    // Required allowed cases
    CHECK(wsamp::isOriginAllowed("http://localhost:8642"));
    CHECK(wsamp::isOriginAllowed("http://127.0.0.1:5500"));
    CHECK(wsamp::isOriginAllowed("https://claude.ai"));
    CHECK(wsamp::isOriginAllowed("https://x.claudeusercontent.com"));

    // Additional valid variants
    CHECK(wsamp::isOriginAllowed("http://localhost"));
    CHECK(wsamp::isOriginAllowed("https://localhost:3000"));
    CHECK(wsamp::isOriginAllowed("https://127.0.0.1:8443"));
    CHECK(wsamp::isOriginAllowed("https://sub.claude.ai"));
    CHECK(wsamp::isOriginAllowed("https://a.b.claudeusercontent.com"));

    // Required rejected cases
    CHECK(!wsamp::isOriginAllowed("https://evil.com"));
    CHECK(!wsamp::isOriginAllowed("https://claude.ai.evil.com"));
    CHECK(!wsamp::isOriginAllowed("http://localhost.evil.com"));
    CHECK(!wsamp::isOriginAllowed("null"));
    CHECK(!wsamp::isOriginAllowed(""));

    // Extra origins from origins.txt
    const std::filesystem::path tmpOrigins =
        std::filesystem::temp_directory_path() / "wsamp_test_origins.txt";
    {
        std::ofstream out(tmpOrigins);
        out << "# Custom dev origin\n";
        out << "https://staging.woodshed.example\n";
    }
    const auto extras = wsamp::loadExtraOriginsFile(tmpOrigins);
    CHECK(wsamp::isOriginAllowed("https://staging.woodshed.example", extras));
    CHECK(!wsamp::isOriginAllowed("https://other.woodshed.example", extras));
    std::error_code ec;
    std::filesystem::remove(tmpOrigins, ec);
}

void testFrameCodecRoundTrips() {
    const std::array<uint8_t, 4> maskKey = {0x37u, 0xFAu, 0x21u, 0x3Du};

    // 1. Short text frame (7-bit length), unmasked & masked
    const std::string hello = "{\"type\":\"hello\"}";
    const std::span<const uint8_t> helloBytes(
        reinterpret_cast<const uint8_t*>(hello.data()), hello.size());

    for (bool masked : {false, true}) {
        const auto wire = wsamp::encodeWsFrame(wsamp::WsOpcode::Text, helloBytes, true, masked, maskKey);
        wsamp::WsFrame decoded;
        size_t consumed = 0;
        CHECK(wsamp::decodeWsFrame(wire, decoded, consumed) == wsamp::WsDecodeStatus::Ok);
        CHECK(consumed == wire.size());
        CHECK(decoded.fin == true);
        CHECK(decoded.opcode == wsamp::WsOpcode::Text);
        CHECK(decoded.masked == masked);
        CHECK(decoded.payload.size() == helloBytes.size());
        CHECK(std::memcmp(decoded.payload.data(), helloBytes.data(), helloBytes.size()) == 0);
    }

    // 2. Medium binary frame (16-bit extended length: 1000 bytes)
    std::vector<uint8_t> med(1000);
    for (size_t i = 0; i < med.size(); ++i) med[i] = static_cast<uint8_t>((i * 73u + 19u) & 0xFFu);
    {
        const auto wire = wsamp::encodeWsFrame(wsamp::WsOpcode::Binary, med, true, true, maskKey);
        CHECK((wire[1] & 0x7Fu) == 126u);
        wsamp::WsFrame decoded;
        size_t consumed = 0;
        CHECK(wsamp::decodeWsFrame(wire, decoded, consumed) == wsamp::WsDecodeStatus::Ok);
        CHECK(consumed == wire.size());
        CHECK(decoded.opcode == wsamp::WsOpcode::Binary);
        CHECK(decoded.payload == med);
    }

    // 3. Large binary frame (64-bit extended length: 70000 bytes)
    std::vector<uint8_t> large(70000);
    for (size_t i = 0; i < large.size(); ++i) large[i] = static_cast<uint8_t>((i * 31u + 7u) & 0xFFu);
    {
        const auto wire = wsamp::encodeWsFrame(wsamp::WsOpcode::Binary, large, true, true, maskKey);
        CHECK((wire[1] & 0x7Fu) == 127u);

        // Partial frame should return Incomplete
        wsamp::WsFrame decoded;
        size_t consumed = 0;
        CHECK(wsamp::decodeWsFrame(std::span<const uint8_t>(wire.data(), 100), decoded, consumed, 100000) ==
              wsamp::WsDecodeStatus::Incomplete);

        // Full frame should decode cleanly
        CHECK(wsamp::decodeWsFrame(wire, decoded, consumed, 100000) == wsamp::WsDecodeStatus::Ok);
        CHECK(consumed == wire.size());
        CHECK(decoded.opcode == wsamp::WsOpcode::Binary);
        CHECK(decoded.payload == large);
    }
}

void testWsa1AudioFrameLayout() {
    const std::array<int16_t, 4> samples = {-32768, -1, 0, 32767};
    constexpr uint32_t kRate = 48000u;
    constexpr uint32_t kFrameIdx = 0x12345678u;

    const auto pkt = wsamp::buildWsa1Frame(kRate, kFrameIdx, samples);
    CHECK(pkt.size() == 16 + samples.size() * 2);

    // Bytes 0..3: 'WSA1'
    CHECK(pkt[0] == 'W');
    CHECK(pkt[1] == 'S');
    CHECK(pkt[2] == 'A');
    CHECK(pkt[3] == '1');

    // Bytes 4..7: sampleRate u32 LE (48000 = 0x0000BB80)
    CHECK(pkt[4] == 0x80u);
    CHECK(pkt[5] == 0xBBu);
    CHECK(pkt[6] == 0x00u);
    CHECK(pkt[7] == 0x00u);

    // Bytes 8..11: frameIndex u32 LE (0x12345678)
    CHECK(pkt[8] == 0x78u);
    CHECK(pkt[9] == 0x56u);
    CHECK(pkt[10] == 0x34u);
    CHECK(pkt[11] == 0x12u);

    // Bytes 12..15: count u32 LE (4)
    CHECK(pkt[12] == 4u);
    CHECK(pkt[13] == 0u);
    CHECK(pkt[14] == 0u);
    CHECK(pkt[15] == 0u);

    // Bytes 16..23: int16 LE samples
    for (size_t i = 0; i < samples.size(); ++i) {
        const uint16_t raw = static_cast<uint16_t>(pkt[16 + i * 2]) |
                             (static_cast<uint16_t>(pkt[16 + i * 2 + 1]) << 8);
        CHECK(static_cast<int16_t>(raw) == samples[i]);
    }
}

} // namespace

// Guide audio from the page: parse what buildWsa1Frame makes, reject malformed payloads.
void testWsa1Parse() {
    std::vector<int16_t> in = {0, 1, -1, 32767, -32768, 1234, -4321};
    const std::vector<uint8_t> frame = wsamp::buildWsa1Frame(48000, 77, in);
    uint32_t rate = 0, idx = 0;
    std::vector<int16_t> out;
    CHECK(wsamp::parseWsa1Frame(frame, rate, idx, out));
    CHECK(rate == 48000);
    CHECK(idx == 77);
    CHECK(out == in);

    std::vector<uint8_t> badMagic = frame;
    badMagic[0] = 'X';
    CHECK(!wsamp::parseWsa1Frame(badMagic, rate, idx, out));

    std::vector<uint8_t> shortPayload(frame.begin(), frame.end() - 2);   // count says 7 samples, 6.5 present
    CHECK(!wsamp::parseWsa1Frame(shortPayload, rate, idx, out));

    std::vector<uint8_t> hugeCount = frame;
    hugeCount[12] = 0xFF; hugeCount[13] = 0xFF; hugeCount[14] = 0x00; hugeCount[15] = 0x00;  // 65535 samples
    CHECK(!wsamp::parseWsa1Frame(hugeCount, rate, idx, out));

    std::vector<uint8_t> tiny = {'W', 'S', 'A', '1'};
    CHECK(!wsamp::parseWsa1Frame(tiny, rate, idx, out));
}

int main() {
    testWsa1Parse();
    testSha1Vectors();
    testBase64Vectors();
    testRfc6455Handshake();
    testOriginAllowList();
    testFrameCodecRoundTrips();
    testWsa1AudioFrameLayout();

    if (gFailures == 0) {
        std::printf("All WebSocket/protocol unit tests passed.\n");
    } else {
        std::fprintf(stderr, "%d WebSocket test check(s) failed.\n", gFailures);
    }
    return gFailures;
}
