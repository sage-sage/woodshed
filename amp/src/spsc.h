#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <type_traits>

namespace wsamp {

template <typename T, size_t Capacity>
class SpscRing {
    static_assert(std::is_trivially_copyable_v<T>, "SpscRing requires trivially copyable POD items");
    static_assert(Capacity >= 2 && (Capacity & (Capacity - 1)) == 0, "Capacity must be a power of two");

public:
    static constexpr size_t kMask = Capacity - 1;

    SpscRing() noexcept = default;

    void reset() noexcept {
        head_.store(0, std::memory_order_relaxed);
        tail_.store(0, std::memory_order_relaxed);
    }

    size_t capacity() const noexcept {
        return Capacity;
    }

    size_t size() const noexcept {
        const size_t h = head_.load(std::memory_order_acquire);
        const size_t t = tail_.load(std::memory_order_acquire);
        return h - t;
    }

    bool tryPush(const T& item) noexcept {
        const size_t h = head_.load(std::memory_order_relaxed);
        const size_t t = tail_.load(std::memory_order_acquire);
        if (h - t >= Capacity) {
            return false;
        }
        buffer_[h & kMask] = item;
        head_.store(h + 1, std::memory_order_release);
        return true;
    }

    size_t pushBatch(const T* items, size_t count) noexcept {
        const size_t h = head_.load(std::memory_order_relaxed);
        const size_t t = tail_.load(std::memory_order_acquire);
        const size_t freeSlots = Capacity - (h - t);
        const size_t n = (count < freeSlots) ? count : freeSlots;
        for (size_t i = 0; i < n; ++i) {
            buffer_[(h + i) & kMask] = items[i];
        }
        if (n > 0) {
            head_.store(h + n, std::memory_order_release);
        }
        return n;
    }

    bool tryPop(T& out) noexcept {
        const size_t t = tail_.load(std::memory_order_relaxed);
        const size_t h = head_.load(std::memory_order_acquire);
        if (h == t) {
            return false;
        }
        out = buffer_[t & kMask];
        tail_.store(t + 1, std::memory_order_release);
        return true;
    }

    size_t popBatch(T* out, size_t maxCount) noexcept {
        const size_t t = tail_.load(std::memory_order_relaxed);
        const size_t h = head_.load(std::memory_order_acquire);
        const size_t avail = h - t;
        const size_t n = (maxCount < avail) ? maxCount : avail;
        for (size_t i = 0; i < n; ++i) {
            out[i] = buffer_[(t + i) & kMask];
        }
        if (n > 0) {
            tail_.store(t + n, std::memory_order_release);
        }
        return n;
    }

private:
    alignas(64) std::atomic<size_t> head_{0};
    alignas(64) std::atomic<size_t> tail_{0};
    std::array<T, Capacity> buffer_{};
};

} // namespace wsamp
