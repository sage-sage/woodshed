#pragma once
// Pedalboard: a per-preset, user-ordered list of effect blocks (NAM captures, cabinet IRs, the built-in amp
// and cab, EQ, and DaisySP effects), processed between the fixed input stage (trim + noise gate) and the
// fixed output stage (level + soft limiter) in dsp::Chain.
//
// Threading model
//  - Blocks are created, prepared and (for NAM/IR) loaded on the controller thread.
//  - A Board is an immutable ordered list of shared Block pointers. Changing the structure (add, remove,
//    move, load a file) builds a NEW Board that reuses the existing Block objects (so a moved delay keeps
//    its tail and a NAM model is not reloaded) and installs it with Chain::installBoard().
//  - The audio thread only reads Block* through the active Board, never copies shared_ptrs, never
//    allocates. Parameter changes go through Block::setParam (atomic targets, smoothed per chunk).

#include <array>
#include <atomic>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace wsamp::dsp {

enum class BlockType {
    Amp,        // built-in amp (BuiltinAmp)
    Nam,        // Neural Amp Modeler capture (.nam file)
    Cab,        // built-in cabinet (CabSim)
    Ir,         // cabinet impulse response (.wav file)
    Eq,         // 3-band post EQ
    Overdrive,  // DaisySP Overdrive
    Chorus,     // DaisySP Chorus
    Flanger,    // DaisySP Flanger
    Phaser,     // DaisySP Phaser
    Tremolo,    // DaisySP Tremolo
    Autowah,    // DaisySP Autowah
    Delay,      // MonoDelay (existing) with a tone control in the feedback path
    Reverb,     // "room" = Freeverb (existing), "lush" = DaisySP-LGPL ReverbSc
    Mixer,      // 2 inputs (A = port 0, B = port 1) blended by "balance", then "level"
    Volume      // gain stage ("level"), handy on parallel paths
};

inline constexpr int kMaxBlockParams = 8;
inline constexpr int kMaxBoardBlocks = 16;   // tiles, not counting the fixed Input and Output
inline constexpr int kMaxNamBlocks = 3;
inline constexpr int kMaxCables = 40;

// Graph endpoints: cables may start at kInputUid and end at kOutputUid (they are not Blocks).
inline constexpr const char* kInputUid = "in";
inline constexpr const char* kOutputUid = "out";

// A cable from `from`'s output to input `port` of `to`. Several cables into one input are summed; one
// output may feed any number of cables.
struct Cable {
    std::string from;
    std::string to;
    int port = 0;
};

// One knob/switch of a block type. `options` non-empty = a choice: the value is the option index.
struct ParamSpec {
    const char* key;        // stable JSON key, e.g. "rate"
    const char* label;      // UI label, e.g. "Rate"
    float min;
    float max;
    float def;
    float step;
    const char* unit;       // "", "dB", "Hz", "ms", "%"
    std::vector<const char*> options;
};

struct BlockTypeSpec {
    BlockType type;
    const char* id;         // stable JSON id: "amp","nam","cab","ir","eq","overdrive","chorus","flanger",
                            // "phaser","tremolo","autowah","delay","reverb"
    const char* name;       // UI name, e.g. "Chorus"
    const char* category;   // "amp", "cab", "drive", "modulation", "time", "eq", "utility"
    int inputs = 1;         // input ports: 1, or 2 for the mixer
    bool usesFile;          // nam, ir: the block is loaded from a file
    const char* fileKind;   // "nam" or "ir" (nullptr when !usesFile)
    std::vector<ParamSpec> params;   // at most kMaxBlockParams
};

const std::vector<BlockTypeSpec>& blockCatalog();
const BlockTypeSpec* findBlockSpec(BlockType type);
const BlockTypeSpec* findBlockSpec(const std::string& id);

class Block {
public:
    Block(BlockType type, std::string uid);
    virtual ~Block() = default;
    Block(const Block&) = delete;
    Block& operator=(const Block&) = delete;

    BlockType type() const noexcept { return type_; }
    const std::string& uid() const noexcept { return uid_; }
    const BlockTypeSpec& spec() const noexcept { return *spec_; }

    // Controller thread. prepare() may allocate; it is called before the block is first installed and
    // again whenever the sample rate or max block size changes (audio stopped).
    virtual void prepare(double sampleRate, int maxBlock) = 0;
    virtual void reset() noexcept = 0;

    // Any thread: atomic target, clamped to the spec range; the audio thread smooths towards it.
    void setParam(int index, float value) noexcept;
    float param(int index) const noexcept;      // current target
    void setEnabled(bool on) noexcept { enabled_.store(on, std::memory_order_relaxed); }
    bool enabled() const noexcept { return enabled_.load(std::memory_order_relaxed); }

    // File blocks (Nam, Ir) only; controller thread; blocking load. Returns false and sets errorOut on
    // failure (the previous file stays loaded). clearFile() unloads.
    virtual bool loadFile(const std::filesystem::path& path, std::string& errorOut);
    virtual void clearFile();
    virtual bool hasFile() const noexcept { return false; }

    // Audio thread: in-place, allocation-free, lock-free, exception-free. n <= maxBlock.
    virtual void process(float* io, int n) noexcept = 0;

    // Audio thread, for blocks with more than one input (the mixer): ins[p] is the summed signal arriving at
    // port p (never null; silence when nothing is connected), out receives the result. Default: copy ins[0]
    // to out and call process(out, n).
    virtual void processMulti(const float* const* ins, int numIns, float* out, int n) noexcept;

    // Audio thread, used by Board for click-free enable/disable: 0..1 ramp state.
    float fade = 1.0f;

protected:
    std::array<std::atomic<float>, kMaxBlockParams> targets_{};
    double preparedRate_ = 0.0;
    int preparedMax_ = 0;
    void blockPrepared(double sr, int maxBlock) noexcept {
        preparedRate_ = sr;
        preparedMax_ = maxBlock;
    }

private:
    friend class Chain;
    friend class Board;
    BlockType type_;
    std::string uid_;
    const BlockTypeSpec* spec_ = nullptr;
    std::atomic<bool> enabled_{true};
};

// Creates a block of `type` with every parameter at its default. Not yet prepared.
std::shared_ptr<Block> makeBlock(BlockType type, const std::string& uid);

// An immutable signal graph. Only blocks on some path from kInputUid to kOutputUid are processed (others
// are kept, so their state survives, but cost nothing). Built on the controller thread; the audio thread
// only calls process().
class Board {
public:
    // Builds the processing plan (topological order, one output buffer per block, input fan-in lists).
    // Cables naming unknown uids, bad ports or forming a cycle are ignored; valid() reports whether
    // anything was dropped. With no cable reaching kOutputUid the output is silence.
    Board(std::vector<std::shared_ptr<Block>> blocks, std::vector<Cable> cables);

    const std::vector<std::shared_ptr<Block>>& blocks() const noexcept { return blocks_; }
    const std::vector<Cable>& cables() const noexcept { return cables_; }
    Block* findByUid(const std::string& uid) const noexcept;
    bool valid() const noexcept { return valid_; }

    // Audio thread. A block whose enabled() is false passes its port-0 input through; switching crossfades
    // over ~10 ms. n <= the maxBlock given to prepareScratch.
    void process(float* io, int n) noexcept;

    // Controller thread, before install: allocates every buffer the plan needs.
    void prepareScratch(int maxBlock);

private:
    struct Step {
        Block* block = nullptr;
        int numInputs = 1;
        int outBuf = 0;                  // index into buffers_
        std::vector<int> sources[2];     // per input port: buffer indices summed into it (-1 = graph input)
    };
    std::vector<std::shared_ptr<Block>> blocks_;
    std::vector<Cable> cables_;
    std::vector<Step> plan_;
    std::vector<int> outputSources_;         // buffer indices summed into the output (-1 = graph input)
    std::vector<std::vector<float>> buffers_;
    std::vector<float> inputCopy_;
    std::vector<float> portScratch_[2];
    std::vector<float> dry_;
    bool valid_ = true;
};

// Controller helpers.
// True if adding `add` to `cables` would create a cycle (or is a self-loop).
bool wouldCreateCycle(const std::vector<Cable>& cables, const Cable& add);

} // namespace wsamp::dsp
