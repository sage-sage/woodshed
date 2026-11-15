#include "sha1_base64.h"

#include <cstring>

namespace wsamp {

namespace {

inline uint32_t rotl32(uint32_t x, uint32_t n) noexcept {
    return (x << n) | (x >> (32u - n));
}

void processSha1Block(const uint8_t block[64], uint32_t state[5]) noexcept {
    uint32_t w[80]{};
    for (int i = 0; i < 16; ++i) {
        w[i] = (static_cast<uint32_t>(block[i * 4 + 0]) << 24) |
               (static_cast<uint32_t>(block[i * 4 + 1]) << 16) |
               (static_cast<uint32_t>(block[i * 4 + 2]) << 8) |
               (static_cast<uint32_t>(block[i * 4 + 3]));
    }
    for (int t = 16; t < 80; ++t) {
        w[t] = rotl32(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1u);
    }

    uint32_t a = state[0];
    uint32_t b = state[1];
    uint32_t c = state[2];
    uint32_t d = state[3];
    uint32_t e = state[4];

    for (int t = 0; t < 80; ++t) {
        uint32_t f = 0;
        uint32_t k = 0;
        if (t < 20) {
            f = (b & c) | ((~b) & d);
            k = 0x5A827999u;
        } else if (t < 40) {
            f = b ^ c ^ d;
            k = 0x6ED9EBA1u;
        } else if (t < 60) {
            f = (b & c) | (b & d) | (c & d);
            k = 0x8F1BBCDCu;
        } else {
            f = b ^ c ^ d;
            k = 0xCA62C1D6u;
        }

        const uint32_t temp = rotl32(a, 5u) + f + e + k + w[t];
        e = d;
        d = c;
        c = rotl32(b, 30u);
        b = a;
        a = temp;
    }

    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
}

constexpr char kBase64Alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int base64CharValue(char ch) noexcept {
    if (ch >= 'A' && ch <= 'Z') return ch - 'A';
    if (ch >= 'a' && ch <= 'z') return (ch - 'a') + 26;
    if (ch >= '0' && ch <= '9') return (ch - '0') + 52;
    if (ch == '+') return 62;
    if (ch == '/') return 63;
    return -1;
}

} // namespace

Sha1Digest sha1(std::span<const uint8_t> data) noexcept {
    uint32_t state[5] = {
        0x67452301u,
        0xEFCDAB89u,
        0x98BADCFEu,
        0x10325476u,
        0xC3D2E1F0u
    };

    const size_t totalBytes = data.size();
    size_t offset = 0;
    while (totalBytes - offset >= 64) {
        processSha1Block(data.data() + offset, state);
        offset += 64;
    }

    uint8_t tail[128]{};
    const size_t rem = totalBytes - offset;
    if (rem > 0) {
        std::memcpy(tail, data.data() + offset, rem);
    }
    tail[rem] = 0x80u;

    const size_t paddedLen = (rem < 56) ? 64 : 128;
    const uint64_t bitLen = static_cast<uint64_t>(totalBytes) * 8ull;
    for (int i = 0; i < 8; ++i) {
        tail[paddedLen - 8 + i] = static_cast<uint8_t>((bitLen >> ((7 - i) * 8)) & 0xFFu);
    }

    processSha1Block(tail, state);
    if (paddedLen == 128) {
        processSha1Block(tail + 64, state);
    }

    Sha1Digest out{};
    for (int i = 0; i < 5; ++i) {
        out[i * 4 + 0] = static_cast<uint8_t>((state[i] >> 24) & 0xFFu);
        out[i * 4 + 1] = static_cast<uint8_t>((state[i] >> 16) & 0xFFu);
        out[i * 4 + 2] = static_cast<uint8_t>((state[i] >> 8) & 0xFFu);
        out[i * 4 + 3] = static_cast<uint8_t>(state[i] & 0xFFu);
    }
    return out;
}

Sha1Digest sha1(std::string_view text) noexcept {
    return sha1(std::span<const uint8_t>(
        reinterpret_cast<const uint8_t*>(text.data()), text.size()));
}

std::string sha1Hex(std::string_view text) {
    constexpr char kHex[] = "0123456789abcdef";
    const Sha1Digest d = sha1(text);
    std::string out;
    out.reserve(40);
    for (uint8_t b : d) {
        out.push_back(kHex[(b >> 4) & 0x0Fu]);
        out.push_back(kHex[b & 0x0Fu]);
    }
    return out;
}

std::string base64Encode(std::span<const uint8_t> data) {
    if (data.empty()) return {};

    std::string out;
    out.reserve(((data.size() + 2) / 3) * 4);

    size_t i = 0;
    while (i + 3 <= data.size()) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8) |
                           static_cast<uint32_t>(data[i + 2]);
        out.push_back(kBase64Alphabet[(v >> 18) & 0x3Fu]);
        out.push_back(kBase64Alphabet[(v >> 12) & 0x3Fu]);
        out.push_back(kBase64Alphabet[(v >> 6) & 0x3Fu]);
        out.push_back(kBase64Alphabet[v & 0x3Fu]);
        i += 3;
    }

    const size_t rem = data.size() - i;
    if (rem == 1) {
        const uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        out.push_back(kBase64Alphabet[(v >> 18) & 0x3Fu]);
        out.push_back(kBase64Alphabet[(v >> 12) & 0x3Fu]);
        out.push_back('=');
        out.push_back('=');
    } else if (rem == 2) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8);
        out.push_back(kBase64Alphabet[(v >> 18) & 0x3Fu]);
        out.push_back(kBase64Alphabet[(v >> 12) & 0x3Fu]);
        out.push_back(kBase64Alphabet[(v >> 6) & 0x3Fu]);
        out.push_back('=');
    }

    return out;
}

std::string base64Encode(std::string_view text) {
    return base64Encode(std::span<const uint8_t>(
        reinterpret_cast<const uint8_t*>(text.data()), text.size()));
}

std::optional<std::vector<uint8_t>> base64Decode(std::string_view encoded) {
    if (encoded.empty()) return std::vector<uint8_t>{};
    if ((encoded.size() % 4) != 0) return std::nullopt;

    std::vector<uint8_t> out;
    out.reserve((encoded.size() / 4) * 3);

    for (size_t i = 0; i < encoded.size(); i += 4) {
        const char c0 = encoded[i];
        const char c1 = encoded[i + 1];
        const char c2 = encoded[i + 2];
        const char c3 = encoded[i + 3];

        const int v0 = base64CharValue(c0);
        const int v1 = base64CharValue(c1);
        if (v0 < 0 || v1 < 0) return std::nullopt;

        if (c2 == '=') {
            if (c3 != '=' || (i + 4) != encoded.size()) return std::nullopt;
            const uint32_t v = (static_cast<uint32_t>(v0) << 18) | (static_cast<uint32_t>(v1) << 12);
            out.push_back(static_cast<uint8_t>((v >> 16) & 0xFFu));
        } else if (c3 == '=') {
            if ((i + 4) != encoded.size()) return std::nullopt;
            const int v2 = base64CharValue(c2);
            if (v2 < 0) return std::nullopt;
            const uint32_t v = (static_cast<uint32_t>(v0) << 18) |
                               (static_cast<uint32_t>(v1) << 12) |
                               (static_cast<uint32_t>(v2) << 6);
            out.push_back(static_cast<uint8_t>((v >> 16) & 0xFFu));
            out.push_back(static_cast<uint8_t>((v >> 8) & 0xFFu));
        } else {
            const int v2 = base64CharValue(c2);
            const int v3 = base64CharValue(c3);
            if (v2 < 0 || v3 < 0) return std::nullopt;
            const uint32_t v = (static_cast<uint32_t>(v0) << 18) |
                               (static_cast<uint32_t>(v1) << 12) |
                               (static_cast<uint32_t>(v2) << 6) |
                               static_cast<uint32_t>(v3);
            out.push_back(static_cast<uint8_t>((v >> 16) & 0xFFu));
            out.push_back(static_cast<uint8_t>((v >> 8) & 0xFFu));
            out.push_back(static_cast<uint8_t>(v & 0xFFu));
        }
    }

    return out;
}

std::string computeWebSocketAccept(std::string_view clientKey) {
    while (!clientKey.empty() && (clientKey.front() == ' ' || clientKey.front() == '\t')) {
        clientKey.remove_prefix(1);
    }
    while (!clientKey.empty() && (clientKey.back() == ' ' || clientKey.back() == '\t')) {
        clientKey.remove_suffix(1);
    }

    constexpr std::string_view kWsGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    std::string combined;
    combined.reserve(clientKey.size() + kWsGuid.size());
    combined.append(clientKey);
    combined.append(kWsGuid);

    const Sha1Digest digest = sha1(combined);
    return base64Encode(digest);
}

} // namespace wsamp
