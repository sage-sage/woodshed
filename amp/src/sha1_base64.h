#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace wsamp {

using Sha1Digest = std::array<uint8_t, 20>;

Sha1Digest sha1(std::span<const uint8_t> data) noexcept;
Sha1Digest sha1(std::string_view text) noexcept;
std::string sha1Hex(std::string_view text);

std::string base64Encode(std::span<const uint8_t> data);
std::string base64Encode(std::string_view text);
std::optional<std::vector<uint8_t>> base64Decode(std::string_view encoded);

// Computes RFC 6455 Sec-WebSocket-Accept = base64(SHA1(trim(clientKey) + GUID)).
std::string computeWebSocketAccept(std::string_view clientKey);

} // namespace wsamp
