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
    Reverb      // "room" = Freeverb (existing), "lush" = DaisySP-LGPL ReverbSc
};

inline constexpr int kMaxBlockParams = 8;
inline constexpr int kMaxBoardBlocks = 12;
inline constexpr int kMaxNamBlocks = 3;

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
    const char* category;   // "amp", "cab", "drive", "modulation", "time", "eq"
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

class Board {
public:
    explicit Board(std::vector<std::shared_ptr<Block>> blocks);

    const std::vector<std::shared_ptr<Block>>& blocks() const noexcept { return blocks_; }
    Block* findByUid(const std::string& uid) const noexcept;

    // Audio thread. Runs every block in order; a block whose enabled() changed crossfades its wet and dry
    // signal over ~10 ms (uses the scratch buffer, sized in prepareScratch).
    void process(float* io, int n) noexcept;

    // Controller thread, before install.
    void prepareScratch(int maxBlock);

private:
    std::vector<std::shared_ptr<Block>> blocks_;
    std::vector<Block*> raw_;
    std::vector<float> dry_;
};

} // namespace wsamp::dsp
