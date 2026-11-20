#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <random>
#include <vector>

#include <atomic>
#include <memory>
#include <string>
#include <thread>
#include <unordered_set>

#include "dsp/biquad.h"
#include "dsp/board.h"
#include "dsp/builtin_amp.h"
#include "dsp/cab.h"
#include "dsp/chain.h"
#include "dsp/effects.h"
#include "dsp/oversampler.h"
#include "spsc.h"
#include "wav.h"

namespace {

int gFailures = 0;

#define CHECK(cond)                                                                           \
    do {                                                                                      \
        if (!(cond)) {                                                                        \
            std::fprintf(stderr, "FAIL [%s:%d]: %s\n", __FILE__, __LINE__, #cond);            \
            ++gFailures;                                                                      \
        }                                                                                     \
    } while (0)

constexpr double kPi = 3.14159265358979323846;

float computeRms(const float* buf, int n, int skip = 0) {
    if (n <= skip) return 0.0f;
    double sumSq = 0.0;
    for (int i = skip; i < n; ++i) {
        const double v = static_cast<double>(buf[i]);
        sumSq += v * v;
    }
    return static_cast<float>(std::sqrt(sumSq / static_cast<double>(n - skip)));
}

float toDbfs(float lin) {
    return 20.0f * std::log10(std::max(lin, 1e-12f));
}

void testBiquadMagnitude() {
    constexpr double kSampleRate = 48000.0;
    constexpr std::array<double, 5> kFreqs = {100.0, 400.0, 1000.0, 3000.0, 8000.0};

    struct Case {
        wsamp::dsp::BiquadType type;
        double fc;
        double q;
        double gainDb;
    };

    const std::array<Case, 5> cases = {{
        {wsamp::dsp::BiquadType::LowPass, 1200.0, 0.7071, 0.0},
        {wsamp::dsp::BiquadType::HighPass, 800.0, 0.8, 0.0},
        {wsamp::dsp::BiquadType::Peak, 1500.0, 1.5, 6.0},
        {wsamp::dsp::BiquadType::LowShelf, 300.0, 0.7071, -6.0},
        {wsamp::dsp::BiquadType::HighShelf, 4000.0, 0.7071, 5.0},
    }};

    constexpr int kNumSamples = 16384;
    constexpr int kSettle = 4096;
    std::vector<float> buf(kNumSamples);

    for (const auto& c : cases) {
        wsamp::dsp::Biquad bq;
        bq.prepare(kSampleRate, 64);
        bq.configure(c.type, c.fc, c.q, c.gainDb);

        for (double f : kFreqs) {
            bq.reset();
            for (int i = 0; i < kNumSamples; ++i) {
                buf[i] = static_cast<float>(std::sin(2.0 * kPi * f * static_cast<double>(i) / kSampleRate));
            }
            bq.processBlock(buf.data(), kNumSamples);

            const float measuredRms = computeRms(buf.data(), kNumSamples, kSettle);
            const double measuredDb = 20.0 * std::log10(std::max<double>(measuredRms * std::sqrt(2.0), 1e-12));
            const double expectedDb = bq.magnitudeDbAt(f);
            CHECK(std::abs(measuredDb - expectedDb) < 0.3);
        }
    }
}

void testOversamplerAndAliasing() {
    constexpr double kSampleRate = 48000.0;
    constexpr int kNumSamples = 8192;
    constexpr int kBlock = 64;

    // 1. 1 kHz sine up+down returns within 0.1 dB
    wsamp::dsp::Oversampler4x os;
    os.prepare(kSampleRate, kBlock);
    CHECK(os.latencySamplesExact() < 48.0f); // < 1 ms at 48 kHz

    std::vector<float> orig(kNumSamples);
    std::vector<float> proc(kNumSamples);
    for (int i = 0; i < kNumSamples; ++i) {
        orig[i] = 0.5f * static_cast<float>(std::sin(2.0 * kPi * 1000.0 * static_cast<double>(i) / kSampleRate));
        proc[i] = orig[i];
    }

    for (int off = 0; off < kNumSamples; off += kBlock) {
        os.upsample(proc.data() + off, kBlock);
        os.downsample(proc.data() + off, kBlock);
    }

    const float inRms = computeRms(orig.data(), kNumSamples, 512);
    const float outRms = computeRms(proc.data(), kNumSamples, 512);
    const float diffDb = std::abs(toDbfs(outRms) - toDbfs(inRms));
    CHECK(diffDb < 0.1f);

    // 2. Aliasing test: 15 kHz sine through Crunch drive at 48 kHz;
    // energy below 10 kHz must be < -40 dB relative to the output.
    wsamp::dsp::BuiltinAmp crunchAmp;
    crunchAmp.prepare(kSampleRate, kBlock);
    wsamp::dsp::AmpParams ap;
    ap.character = wsamp::dsp::AmpCharacter::Crunch;
    ap.gain = 6.0f;
    ap.tightHz = 40.0f;
    crunchAmp.setParams(ap);

    constexpr int kAliasLen = 16384;
    std::vector<float> tone15k(kAliasLen);
    for (int i = 0; i < kAliasLen; ++i) {
        tone15k[i] = 0.5f * static_cast<float>(std::sin(2.0 * kPi * 15000.0 * static_cast<double>(i) / kSampleRate));
    }

    for (int off = 0; off < kAliasLen; off += kBlock) {
        crunchAmp.process(tone15k.data() + off, kBlock);
    }

    // Measure low-band (< 10 kHz) energy via 4 cascaded RBJ lowpass filters at 9.5 kHz
    std::vector<float> lowBand(tone15k.begin() + 2048, tone15k.end());
    for (int stage = 0; stage < 4; ++stage) {
        wsamp::dsp::Biquad lp;
        lp.prepare(kSampleRate, kBlock);
        lp.configure(wsamp::dsp::BiquadType::LowPass, 9500.0, 0.7071, 0.0);
        lp.processBlock(lowBand.data(), static_cast<int>(lowBand.size()));
    }

    const float totalRms = computeRms(tone15k.data(), kAliasLen, 2048);
    const float sub10kRms = computeRms(lowBand.data(), static_cast<int>(lowBand.size()), 1024);
    const float relDb = toDbfs(sub10kRms) - toDbfs(totalRms);
    CHECK(relDb < -40.0f);
}

std::shared_ptr<wsamp::dsp::Board> makeMetalBoard() {
    auto od = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Overdrive, "od1");
    od->setParam(0, 0.45f);
    od->setParam(1, -3.0f);

    auto amp = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Amp, "amp1");
    amp->setParam(0, 3.0f); // High gain
    amp->setParam(1, 7.5f);
    amp->setParam(6, 120.0f);

    auto cab = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Cab, "cab1");
    cab->setParam(0, 0.0f); // 4x12 closed

    auto eq = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Eq, "eq1");
    eq->setParam(0, 1.5f);
    eq->setParam(1, -2.0f);
    eq->setParam(2, 2.0f);

    auto dly = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Delay, "dly1");
    dly->setParam(3, 0.15f);

    auto rev = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Reverb, "rev1");
    rev->setParam(0, 1.0f); // Lush
    rev->setParam(3, 0.15f);

    return std::make_shared<wsamp::dsp::Board>(
        std::vector<std::shared_ptr<wsamp::dsp::Block>>{od, amp, cab, eq, dly, rev},
        std::vector<wsamp::dsp::Cable>{
            {wsamp::dsp::kInputUid, "od1", 0},
            {"od1", "amp1", 0},
            {"amp1", "cab1", 0},
            {"cab1", "eq1", 0},
            {"eq1", "dly1", 0},
            {"dly1", "rev1", 0},
            {"rev1", wsamp::dsp::kOutputUid, 0},
        });
}

void testPresetBoards() {
    constexpr double kSampleRate = 48000.0;
    constexpr int kBlock = 64;

    std::mt19937 rng(42);
    std::uniform_real_distribution<float> dist(-1.0f, 1.0f);

    auto cleanAmp = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Amp, "amp_clean");
    cleanAmp->setParam(0, 0.0f);
    auto cleanCab = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Cab, "cab_clean");
    cleanCab->setParam(0, 2.0f);
    auto cleanBoard = std::make_shared<wsamp::dsp::Board>(
        std::vector<std::shared_ptr<wsamp::dsp::Block>>{cleanAmp, cleanCab},
        std::vector<wsamp::dsp::Cable>{
            {wsamp::dsp::kInputUid, "amp_clean", 0},
            {"amp_clean", "cab_clean", 0},
            {"cab_clean", wsamp::dsp::kOutputUid, 0},
        });

    std::vector<std::shared_ptr<wsamp::dsp::Board>> boards = {cleanBoard, makeMetalBoard()};

    for (const auto& board : boards) {
        wsamp::dsp::Chain chain;
        chain.prepare(kSampleRate, kBlock);
        chain.installBoard(board);

        // 1. Silence in -> silence out (< -100 dBFS after gate)
        std::vector<float> silence(4800, 0.0f);
        for (int off = 0; off < 4800; off += kBlock) {
            chain.process(silence.data() + off, kBlock);
        }
        const float silRms = computeRms(silence.data(), 4800, 640);
        CHECK(toDbfs(silRms) < -100.0f);

        // 2. -18 dBFS RMS 110 Hz tone -> finite, non-zero output
        chain.reset();
        constexpr int kToneLen = 24000; // 0.5 s
        const float peak18 = std::pow(10.0f, -18.0f / 20.0f) * std::sqrt(2.0f);
        std::vector<float> tone(kToneLen);
        for (int i = 0; i < kToneLen; ++i) {
            tone[i] = peak18 * static_cast<float>(std::sin(2.0 * kPi * 110.0 * static_cast<double>(i) / kSampleRate));
        }
        for (int off = 0; off < kToneLen; off += kBlock) {
            chain.process(tone.data() + off, kBlock);
        }
        const float outRmsDb = toDbfs(computeRms(tone.data(), kToneLen, 4800));
        CHECK(std::isfinite(outRmsDb) && outRmsDb > -60.0f);

        // 3. Full-scale noise -> no NaN/Inf and never exceeds 0 dBFS
        chain.reset();
        std::vector<float> noise(8192);
        for (float& s : noise) s = dist(rng);
        for (int off = 0; off < 8192; off += kBlock) {
            chain.process(noise.data() + off, kBlock);
        }
        for (float s : noise) {
            CHECK(std::isfinite(s));
            CHECK(std::abs(s) <= 1.0f);
        }
    }
}

void testIrConvolver() {
    std::mt19937 rng(12345);
    std::uniform_real_distribution<float> dist(-0.5f, 0.5f);

    constexpr int kIrLen = 257;
    constexpr int kSigLen = 2048;

    std::vector<float> ir(kIrLen);
    std::vector<float> sig(kSigLen);
    for (float& h : ir) h = dist(rng);
    for (float& x : sig) x = dist(rng);

    // Naive direct convolution
    std::vector<float> expected(kSigLen, 0.0f);
    for (int n = 0; n < kSigLen; ++n) {
        double acc = 0.0;
        for (int k = 0; k < kIrLen; ++k) {
            if (n - k >= 0) {
                acc += static_cast<double>(ir[k]) * static_cast<double>(sig[n - k]);
            }
        }
        expected[n] = static_cast<float>(acc);
    }

    wsamp::dsp::IrConvolver conv;
    conv.prepare(48000.0, 64);
    conv.loadIr(ir, /*applyFadeAndNormalize=*/false);

    std::vector<float> actual = sig;
    for (int off = 0; off < kSigLen; off += 64) {
        conv.process(actual.data() + off, 64);
    }

    float maxErr = 0.0f;
    for (int n = 0; n < kSigLen; ++n) {
        maxErr = std::max(maxErr, std::abs(actual[n] - expected[n]));
    }
    CHECK(maxErr < 1e-5f);
}

void testNoiseGate() {
    constexpr double kSampleRate = 48000.0;
    wsamp::dsp::NoiseGate gate;
    gate.prepare(kSampleRate, 64);
    gate.setThresholdDb(-45.0f);

    // 50 ms silence, 10 ms pluck (-20 dBFS), 250 ms silence
    const int preSil = static_cast<int>(0.050 * kSampleRate);
    const int pluckLen = static_cast<int>(0.010 * kSampleRate);
    const int postSil = static_cast<int>(0.250 * kSampleRate);

    std::vector<float> sig(preSil + pluckLen + postSil, 0.0f);
    for (int i = 0; i < pluckLen; ++i) {
        sig[preSil + i] = 0.1f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * static_cast<double>(i) / kSampleRate));
    }

    gate.process(sig.data(), static_cast<int>(sig.size()));

    // Check gate opens within 2 ms (96 samples at 48 kHz) of pluck onset
    const int twoMs = static_cast<int>(0.002 * kSampleRate);
    float peakAfter2Ms = 0.0f;
    for (int i = twoMs; i < pluckLen; ++i) {
        peakAfter2Ms = std::max(peakAfter2Ms, std::abs(sig[preSil + i]));
    }
    CHECK(peakAfter2Ms > 0.07f);

    // Check gate stays open during 40 ms hold (first 20 ms of post-pluck with tiny residual signal above close threshold)
    // and closes after hold (40 ms) + release (80 ms) -> check tail at 220 ms after pluck
    const int tailStart = preSil + pluckLen + static_cast<int>(0.220 * kSampleRate);
    float maxTail = 0.0f;
    for (int i = tailStart; i < static_cast<int>(sig.size()); ++i) {
        maxTail = std::max(maxTail, std::abs(sig[i]));
    }
    CHECK(maxTail < 1e-4f);
}

void testRealtimeBudget() {
    constexpr double kSampleRate = 48000.0;
    constexpr int kBlock = 64;
    constexpr int kTotalSamples = 480000; // 10 seconds

    wsamp::dsp::Chain chain;
    chain.prepare(kSampleRate, kBlock);
    chain.installBoard(makeMetalBoard());

    std::vector<float> audio(kTotalSamples);
    for (int i = 0; i < kTotalSamples; ++i) {
        audio[i] = 0.15f * static_cast<float>(std::sin(2.0 * kPi * 110.0 * static_cast<double>(i) / kSampleRate));
    }

    const auto t0 = std::chrono::steady_clock::now();
    for (int off = 0; off < kTotalSamples; off += kBlock) {
        chain.process(audio.data() + off, kBlock);
    }
    const auto t1 = std::chrono::steady_clock::now();

    const double elapsedMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
    const double rtf = 10000.0 / std::max(elapsedMs, 1e-6);
    std::printf("Metal 10s @ 48kHz: %.2f ms (RTF = %.1fx)\n", elapsedMs, rtf);
    CHECK(elapsedMs < 250.0);
    CHECK(rtf > 40.0);
}

void testSpscAndPresetsAndWav() {
    wsamp::SpscRing<int, 16> ring;
    for (int i = 0; i < 16; ++i) {
        CHECK(ring.tryPush(i * 10));
    }
    CHECK(!ring.tryPush(999));
    for (int i = 0; i < 16; ++i) {
        int v = -1;
        CHECK(ring.tryPop(v));
        CHECK(v == i * 10);
    }
    int emptyVal = 0;
    CHECK(!ring.tryPop(emptyVal));

    // WAV write + read + resample
    std::string err;
    std::error_code ec;
    const std::filesystem::path tmpWav = std::filesystem::temp_directory_path() / "wsamp_test_tone.wav";
    std::vector<float> src(4410);
    for (int i = 0; i < 4410; ++i) {
        src[i] = 0.25f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * static_cast<double>(i) / 44100.0));
    }
    CHECK(wsamp::writeWavFloat32(tmpWav, src, 44100, 1, err));
    wsamp::WavData rd;
    CHECK(wsamp::readWavMono(tmpWav, rd, err));
    CHECK(rd.sampleRate == 44100);
    CHECK(rd.samples.size() == src.size());
    auto resampled = wsamp::resampleWindowedSinc(rd.samples, 44100, 48000);
    CHECK(resampled.size() == 4800);
    std::filesystem::remove(tmpWav, ec);
}

} // namespace

void testPedalboardCatalogAndBlocks() {
    constexpr double kSampleRate = 48000.0;
    constexpr int kBlock = 64;

    // (a) Catalog sanity
    const auto& cat = wsamp::dsp::blockCatalog();
    CHECK(!cat.empty());
    CHECK(wsamp::dsp::findBlockSpec("nonexistent") == nullptr);

    std::unordered_set<std::string> seenIds;
    for (const auto& spec : cat) {
        CHECK(spec.params.size() <= static_cast<size_t>(wsamp::dsp::kMaxBlockParams));
        CHECK(seenIds.insert(spec.id).second);
        CHECK(wsamp::dsp::findBlockSpec(spec.type) == &spec);
        CHECK(wsamp::dsp::findBlockSpec(spec.id) == &spec);

        for (const auto& p : spec.params) {
            CHECK(p.min <= p.def && p.def <= p.max);
            if (!p.options.empty()) {
                CHECK(p.min == 0.0f);
                CHECK(static_cast<size_t>(p.max) + 1 == p.options.size());
            }
        }
    }

    // (b) Every non-file block type: 1 s noise + 1 s silence at 48 kHz in 64-sample chunks
    std::mt19937 rng(777);
    std::uniform_real_distribution<float> dist(-1.0f, 1.0f);
    std::array<float, kBlock> buf{};

    for (const auto& spec : cat) {
        if (spec.usesFile) continue;
        auto blk = wsamp::dsp::makeBlock(spec.type, std::string("b_") + spec.id);
        CHECK(blk != nullptr);
        blk->prepare(kSampleRate, kBlock);

        for (int off = 0; off < 48000; off += kBlock) {
            for (float& s : buf) s = dist(rng);
            blk->process(buf.data(), kBlock);
            for (float s : buf) {
                CHECK(std::isfinite(s));
                CHECK(std::abs(s) < 20.0f);
            }
        }
        for (int off = 0; off < 48000; off += kBlock) {
            buf.fill(0.0f);
            blk->process(buf.data(), kBlock);
            for (float s : buf) {
                CHECK(std::isfinite(s));
                CHECK(std::abs(s) < 20.0f);
            }
        }
    }

    // Also exercise Reverb Lush mode (ReverbSc)
    {
        auto rev = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Reverb, "rev_lush");
        rev->setParam(0, 1.0f);
        rev->prepare(kSampleRate, kBlock);
        for (int off = 0; off < 48000; off += kBlock) {
            for (float& s : buf) s = dist(rng);
            rev->process(buf.data(), kBlock);
            for (float s : buf) {
                CHECK(std::isfinite(s));
                CHECK(std::abs(s) < 20.0f);
            }
        }
    }

    // (c) Board with a single disabled block outputs exact input after fade (run 0.1 s)
    {
        auto od = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Overdrive, "od_dis");
        od->setParam(0, 1.0f);
        od->setParam(1, 12.0f);
        od->setEnabled(false);
        od->prepare(kSampleRate, kBlock);

        wsamp::dsp::Board board(
            {od},
            {
                {wsamp::dsp::kInputUid, "od_dis", 0},
                {"od_dis", wsamp::dsp::kOutputUid, 0},
            });
        board.prepareScratch(kBlock);

        for (int off = 0; off < 4800; off += kBlock) {
            for (int i = 0; i < kBlock; ++i) {
                buf[i] = 0.25f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * static_cast<double>(off + i) / kSampleRate));
            }
            board.process(buf.data(), kBlock);
        }

        std::array<float, kBlock> expected{};
        for (int i = 0; i < kBlock; ++i) {
            expected[i] = 0.25f * static_cast<float>(std::sin(2.0 * kPi * 330.0 * static_cast<double>(i) / kSampleRate));
        }
        buf = expected;
        board.process(buf.data(), kBlock);
        for (int i = 0; i < kBlock; ++i) {
            CHECK(buf[i] == expected[i]);
        }
    }

    // (d) Chain with installBoard(nullptr) or empty Board is transparent below limiter knee
    {
        wsamp::dsp::Chain chain;
        chain.prepare(kSampleRate, kBlock);

        auto checkTransparent = [&]() {
            chain.reset();
            constexpr int kLen = 4800;
            std::vector<float> in(kLen);
            for (int i = 0; i < kLen; ++i) {
                in[i] = 0.25f * static_cast<float>(std::sin(2.0 * kPi * 1000.0 * static_cast<double>(i) / kSampleRate));
            }
            std::vector<float> out = in;
            for (int off = 0; off < kLen; off += kBlock) {
                chain.process(out.data() + off, kBlock);
            }
            for (int i = 2048; i < kLen; ++i) {  // after the noise gate has fully opened
                CHECK(std::abs(out[i] - in[i]) < 1e-6f);
            }
        };

        chain.installBoard(nullptr);
        checkTransparent();

        auto emptyBoard = std::make_shared<wsamp::dsp::Board>(
            std::vector<std::shared_ptr<wsamp::dsp::Block>>{},
            std::vector<wsamp::dsp::Cable>{
                {wsamp::dsp::kInputUid, wsamp::dsp::kOutputUid, 0},
            });
        chain.installBoard(emptyBoard);
        checkTransparent();
    }

    // (e) installBoard twice + reclaim does not crash while processing
    {
        wsamp::dsp::Chain chain;
        chain.prepare(kSampleRate, kBlock);

        std::atomic<bool> stop{false};
        std::thread audioThread([&]() {
            std::array<float, kBlock> audio{};
            int phase = 0;
            while (!stop.load(std::memory_order_acquire)) {
                for (int i = 0; i < kBlock; ++i) {
                    audio[i] = 0.2f * static_cast<float>(std::sin(2.0 * kPi * 220.0 * static_cast<double>(phase++) / kSampleRate));
                }
                chain.process(audio.data(), kBlock);
                for (float s : audio) {
                    CHECK(std::isfinite(s));
                }
            }
        });

        for (int iter = 0; iter < 50; ++iter) {
            auto b1 = std::make_shared<wsamp::dsp::Board>(
                std::vector<std::shared_ptr<wsamp::dsp::Block>>{wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Chorus, "c1")},
                std::vector<wsamp::dsp::Cable>{
                    {wsamp::dsp::kInputUid, "c1", 0},
                    {"c1", wsamp::dsp::kOutputUid, 0},
                });
            chain.installBoard(b1);
            chain.reclaim();

            auto b2 = std::make_shared<wsamp::dsp::Board>(
                std::vector<std::shared_ptr<wsamp::dsp::Block>>{wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Delay, "d1")},
                std::vector<wsamp::dsp::Cable>{
                    {wsamp::dsp::kInputUid, "d1", 0},
                    {"d1", wsamp::dsp::kOutputUid, 0},
                });
            chain.installBoard(b2);
            chain.reclaim();
        }

        stop.store(true, std::memory_order_release);
        audioThread.join();

        // Advance epoch by >= 2 and reclaim final retired boards
        std::array<float, kBlock> tail{};
        chain.process(tail.data(), kBlock);
        chain.process(tail.data(), kBlock);
        chain.reclaim();
    }
}

void testSignalGraph() {
    constexpr double kSampleRate = 48000.0;
    constexpr int kBlock = 64;

    std::array<float, kBlock> in{};
    for (int i = 0; i < kBlock; ++i) {
        in[i] = 0.3f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * static_cast<double>(i) / kSampleRate));
    }

    // (a) in->out with no blocks is transparent; no cable to out gives silence
    {
        wsamp::dsp::Board through(
            {},
            {{wsamp::dsp::kInputUid, wsamp::dsp::kOutputUid, 0}});
        CHECK(through.valid());
        through.prepareScratch(kBlock);
        auto buf = in;
        through.process(buf.data(), kBlock);
        for (int i = 0; i < kBlock; ++i) {
            CHECK(buf[i] == in[i]);
        }

        wsamp::dsp::Board silent({}, {});
        CHECK(silent.valid());
        silent.prepareScratch(kBlock);
        buf = in;
        silent.process(buf.data(), kBlock);
        for (int i = 0; i < kBlock; ++i) {
            CHECK(buf[i] == 0.0f);
        }
    }

    // (b) parallel paths: two +0 dB Volume blocks give 2x input
    {
        auto v1 = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Volume, "v1");
        auto v2 = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Volume, "v2");
        v1->prepare(kSampleRate, kBlock);
        v2->prepare(kSampleRate, kBlock);

        wsamp::dsp::Board parallel(
            {v1, v2},
            {
                {wsamp::dsp::kInputUid, "v1", 0},
                {"v1", wsamp::dsp::kOutputUid, 0},
                {wsamp::dsp::kInputUid, "v2", 0},
                {"v2", wsamp::dsp::kOutputUid, 0},
            });
        CHECK(parallel.valid());
        parallel.prepareScratch(kBlock);

        auto buf = in;
        parallel.process(buf.data(), kBlock);
        for (int i = 0; i < kBlock; ++i) {
            CHECK(std::abs(buf[i] - 2.0f * in[i]) < 1e-5f);
        }
    }

    // (c) mixer: A = in, B = in through Volume(-60 dB); balance 0 -> input, balance 1 -> 0.001 * input
    {
        auto volB = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Volume, "vol_b");
        volB->setParam(0, -60.0f);
        volB->prepare(kSampleRate, kBlock);

        auto mix = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Mixer, "mix1");
        mix->setParam(0, 0.0f); // balance = 0 (only A)
        mix->prepare(kSampleRate, kBlock);

        wsamp::dsp::Board mixBoard(
            {volB, mix},
            {
                {wsamp::dsp::kInputUid, "mix1", 0},
                {wsamp::dsp::kInputUid, "vol_b", 0},
                {"vol_b", "mix1", 1},
                {"mix1", wsamp::dsp::kOutputUid, 0},
            });
        CHECK(mixBoard.valid());
        mixBoard.prepareScratch(kBlock);

        std::array<float, kBlock> buf{};
        for (int off = 0; off < 9600; off += kBlock) { // 0.2 s settle
            buf = in;
            mixBoard.process(buf.data(), kBlock);
        }
        for (int i = 0; i < kBlock; ++i) {
            CHECK(std::abs(buf[i] - in[i]) < 1e-4f);
        }

        mix->setParam(0, 1.0f); // balance = 1 (only B)
        for (int off = 0; off < 9600; off += kBlock) { // 0.2 s settle
            buf = in;
            mixBoard.process(buf.data(), kBlock);
        }
        for (int i = 0; i < kBlock; ++i) {
            CHECK(std::abs(buf[i] - 0.001f * in[i]) < 1e-4f);  // the smoothed balance is within 1e-4 of 1 after 0.2 s
        }
    }

    // (d) cycle b1->b2->b1 is dropped (valid() false) and processing stays finite
    {
        auto b1 = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Volume, "b1");
        auto b2 = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Volume, "b2");
        b1->prepare(kSampleRate, kBlock);
        b2->prepare(kSampleRate, kBlock);

        wsamp::dsp::Board cyclic(
            {b1, b2},
            {
                {wsamp::dsp::kInputUid, "b1", 0},
                {"b1", "b2", 0},
                {"b2", "b1", 0},
                {"b2", wsamp::dsp::kOutputUid, 0},
            });
        CHECK(!cyclic.valid());
        cyclic.prepareScratch(kBlock);

        auto buf = in;
        cyclic.process(buf.data(), kBlock);
        for (float s : buf) {
            CHECK(std::isfinite(s));
        }
    }

    // (e) wouldCreateCycle cases: self-loop, simple back edge, no cycle across diamond
    {
        CHECK(wsamp::dsp::wouldCreateCycle({}, {"b1", "b1", 0}));
        CHECK(wsamp::dsp::wouldCreateCycle({{"b1", "b2", 0}}, {"b2", "b1", 0}));

        const std::vector<wsamp::dsp::Cable> diamond = {
            {wsamp::dsp::kInputUid, "b1", 0},
            {wsamp::dsp::kInputUid, "b2", 0},
            {"b1", "b3", 0},
            {"b3", wsamp::dsp::kOutputUid, 0},
        };
        CHECK(!wsamp::dsp::wouldCreateCycle(diamond, {"b2", "b3", 0}));
        CHECK(!wsamp::dsp::wouldCreateCycle(diamond, {"b2", wsamp::dsp::kOutputUid, 0}));
    }

    // (f) unreachable blocks are not processed
    {
        auto liveVol = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Volume, "live_v");
        liveVol->setParam(0, 0.0f);
        liveVol->prepare(kSampleRate, kBlock);

        auto dead1 = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Volume, "dead1");
        dead1->setParam(0, 12.0f);
        dead1->prepare(kSampleRate, kBlock);

        auto dead2 = wsamp::dsp::makeBlock(wsamp::dsp::BlockType::Volume, "dead2");
        dead2->setParam(0, 12.0f);
        dead2->prepare(kSampleRate, kBlock);

        wsamp::dsp::Board board(
            {liveVol, dead1, dead2},
            {
                {wsamp::dsp::kInputUid, "live_v", 0},
                {"live_v", wsamp::dsp::kOutputUid, 0},
                {wsamp::dsp::kInputUid, "dead1", 0},
                {"dead2", "live_v", 0},
            });
        CHECK(board.valid());
        board.prepareScratch(kBlock);

        auto buf = in;
        board.process(buf.data(), kBlock);
        for (int i = 0; i < kBlock; ++i) {
            CHECK(std::abs(buf[i] - in[i]) < 1e-6f);
        }
    }
}

// The guide is added after the noise gate: silence on the guitar input must not gate it, and the guitar
// path is unchanged when there is no guide.
void testGuideAfterGate() {
    constexpr double sr = 48000.0;
    constexpr int n = 64;
    wsamp::dsp::Chain chain;
    chain.prepare(sr, n);
    chain.setGateThresholdDb(-20.0f);   // a harsh gate: it closes on silence
    std::vector<float> io(n), guide(n);
    double phase = 0.0;
    float maxErr = 0.0f;
    for (int blk = 0; blk < 400; ++blk) {   // ~0.53 s
        for (int i = 0; i < n; ++i) {
            guide[i] = 0.25f * static_cast<float>(std::sin(phase));
            phase += 2.0 * 3.14159265358979 * 330.0 / sr;
            io[i] = 0.0f;
        }
        chain.process(io.data(), n, guide.data());
        if (blk > 200) {
            for (int i = 0; i < n; ++i) maxErr = std::max(maxErr, std::abs(io[i] - guide[i]));
        }
    }
    CHECK(maxErr < 1e-4f);
}

// Goertzel power of one frequency over buf[skip..n).
double tonePower(const float* buf, int n, int skip, double freq, double fs) {
    const double w = 2.0 * kPi * freq / fs;
    const double c = 2.0 * std::cos(w);
    double s1 = 0.0, s2 = 0.0;
    for (int i = skip; i < n; ++i) {
        const double s0 = static_cast<double>(buf[i]) + c * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return s1 * s1 + s2 * s2 - c * s1 * s2;
}

void testMetalDistortion() {
    using wsamp::dsp::BlockType;
    constexpr double kFs = 48000.0;
    constexpr int kBlock = 64;
    const auto* spec = wsamp::dsp::findBlockSpec("metal");
    CHECK(spec != nullptr);
    if (!spec) return;
    CHECK(spec->params.size() == 7);

    // (a) A loud, guitar-like pluck train at max gain and extreme EQ, then silence: bounded, finite, no
    //     denormals; the gate closes the tail to true silence.
    {
        auto m = wsamp::dsp::makeBlock(BlockType::Metal, "metal_a");
        m->setParam(0, 10.0f);   // gain
        m->setParam(2, 12.0f);   // low
        m->setParam(4, 12.0f);   // high
        m->setParam(5, 6.0f);    // level
        m->setParam(6, -60.0f);  // gate
        m->prepare(kFs, kBlock);
        std::vector<float> sig(static_cast<size_t>(kFs * 3), 0.0f);
        const double f0s[] = {82.41, 110.0, 146.83, 98.0};
        for (int k = 0; k < 4; ++k) {
            const int start = static_cast<int>(k * 0.5 * kFs);
            for (int i = 0; i < static_cast<int>(0.5 * kFs); ++i) {
                const double t = i / kFs;
                double v = 0.0;
                for (int h = 1; h <= 8; ++h) v += std::sin(2.0 * kPi * f0s[k] * h * t) / h;
                sig[static_cast<size_t>(start + i)] = static_cast<float>(0.9 * v * std::exp(-3.0 * t));
            }
        }
        bool finite = true, denorm = false;
        float peak = 0.0f;
        for (size_t off = 0; off < sig.size(); off += kBlock) {
            m->process(sig.data() + off, kBlock);
            for (int i = 0; i < kBlock; ++i) {
                const float s = sig[off + static_cast<size_t>(i)];
                if (!std::isfinite(s)) finite = false;
                if (std::fpclassify(s) == FP_SUBNORMAL) denorm = true;
                peak = std::max(peak, std::abs(s));
            }
        }
        std::printf("metal: worst-case peak %.2f\n", peak);
        CHECK(finite);
        CHECK(!denorm);
        CHECK(peak < 8.0f);     // +6 dB level and +12 dB shelves on a +-1 clipper
        CHECK(peak > 0.05f);
        // the last 0.5 s is silence: the gate has shut it fully
        float tail = 0.0f;
        for (size_t i = sig.size() - 12000; i < sig.size(); ++i) tail = std::max(tail, std::abs(sig[i]));
        CHECK(tail == 0.0f);
    }

    // (b) More gain = more harmonics: a quiet 220 Hz sine, harmonic power (2..10) relative to the fundamental.
    auto harmonicRatio = [&](float gain) {
        auto m = wsamp::dsp::makeBlock(BlockType::Metal, "metal_b");
        m->setParam(0, gain);
        m->setParam(6, -80.0f);   // gate off
        m->prepare(kFs, kBlock);
        const int n = static_cast<int>(kFs);
        std::vector<float> buf(static_cast<size_t>(n));
        for (int i = 0; i < n; ++i) buf[static_cast<size_t>(i)] = static_cast<float>(0.02 * std::sin(2.0 * kPi * 220.0 * i / kFs));
        for (int off = 0; off < n; off += kBlock) m->process(buf.data() + off, kBlock);
        const double fund = tonePower(buf.data(), n, n / 2, 220.0, kFs);
        double harm = 0.0;
        for (int h = 2; h <= 10; ++h) harm += tonePower(buf.data(), n, n / 2, 220.0 * h, kFs);
        return harm / std::max(fund, 1e-30);
    };
    const double lowGain = harmonicRatio(0.0f);
    const double highGain = harmonicRatio(10.0f);
    std::printf("metal: harmonics/fundamental at gain 0 = %.4f, at gain 10 = %.4f\n", lowGain, highGain);
    CHECK(highGain > lowGain * 3.0);
    // A fully squared-off sine tops out near 0.19 here (odd harmonics 1/h^2 up to 9), and the tone stack's
    // top cut trims some of that, so 0.05 is a clear "heavily distorted" bar.
    CHECK(highGain > 0.05);

    // (c) Silence in, silence out (gate off, no DC from the asymmetric clipper), and no denormals.
    {
        auto m = wsamp::dsp::makeBlock(BlockType::Metal, "metal_c");
        m->setParam(6, -80.0f);
        m->prepare(kFs, kBlock);
        std::array<float, kBlock> buf{};
        bool ok = true;
        for (int off = 0; off < 48000; off += kBlock) {
            buf.fill(0.0f);
            m->process(buf.data(), kBlock);
            for (float s : buf) {
                if (s != 0.0f && std::fpclassify(s) != FP_NORMAL) ok = false;
                if (std::abs(s) > 1e-6f) ok = false;
            }
        }
        CHECK(ok);
    }
}

int main() {
    testMetalDistortion();
    testGuideAfterGate();
    testBiquadMagnitude();
    testOversamplerAndAliasing();
    testPresetBoards();
    testIrConvolver();
    testNoiseGate();
    testRealtimeBudget();
    testSpscAndPresetsAndWav();
    testPedalboardCatalogAndBlocks();
    testSignalGraph();

    if (gFailures == 0) {
        std::printf("All DSP tests passed.\n");
    } else {
        std::fprintf(stderr, "%d test check(s) failed.\n", gFailures);
    }
    return gFailures;
}
