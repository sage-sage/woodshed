"""Render a synthetic guitar DI through every preset and check that each preset behaves like its name.

Usage: python tests/tone_check.py path/to/woodshed-amp-render.exe
Writes WAVs to build-tone/ (listen to them) and prints a table; exits 1 if a check fails.
"""
import os
import subprocess
import sys
import wave

import numpy as np

SR = 48000
OUT = "build-tone"
PRESETS = ["clean", "jazz", "breakup", "crunch", "rock_lead", "high_gain", "metal", "fuzz", "acoustic", "bass"]


def pluck(n, midi, sr=SR, decay=0.9992, seed=0):
    """Karplus-Strong string, pick position filtered, like a passive single-coil DI."""
    f = 440 * 2 ** ((midi - 69) / 12)
    p = sr / f
    N = int(p)
    frac = p - N
    rng = np.random.default_rng(seed + midi)
    buf = rng.uniform(-1, 1, N)
    buf -= buf.mean()
    for _ in range(2):
        buf = 0.5 * (buf + np.roll(buf, 1))
    out = np.zeros(n)
    idx = 0
    prev = 0.0
    for i in range(n):
        a = buf[idx % N]
        b = buf[(idx + 1) % N]
        y = decay * ((1 - frac) * 0.5 * (a + b) + frac * prev)
        prev = 0.5 * (a + b)
        buf[idx % N] = y
        out[i] = a
        idx += 1
    return out


def di_signal():
    """2 s chord strum (E5 power chord, then open E minor), 2 s single-note riff; DI peaks around -10 dBFS."""
    total = np.zeros(SR * 5)
    def add(sig, at):
        i = int(at * SR)
        total[i:i + len(sig)] += sig[: len(total) - i]
    for k, m in enumerate([40, 47, 52]):
        add(pluck(SR, m) * 0.5, 0.02 + k * 0.008)
    for k, m in enumerate([40, 47, 52, 55, 59, 64]):
        add(pluck(SR, m) * 0.35, 1.2 + k * 0.012)
    for k, m in enumerate([45, 48, 50, 52, 55, 57, 60, 62]):
        add(pluck(int(SR * 0.4), m) * 0.6, 2.5 + k * 0.25)
    total /= np.max(np.abs(total))
    return total * 10 ** (-10 / 20)


def write(path, x):
    x = np.clip(x, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())


def read(path):
    with open(path, "rb") as f:
        data = f.read()
    # minimal RIFF reader (the render tool writes 32-bit float, possibly stereo)
    pos = 12
    fmt = None
    while pos < len(data):
        cid, size = data[pos:pos + 4], int.from_bytes(data[pos + 4:pos + 8], "little")
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt = (int.from_bytes(body[0:2], "little"), int.from_bytes(body[2:4], "little"),
                   int.from_bytes(body[14:16], "little"))
        elif cid == b"data":
            tag, ch, bits = fmt
            if tag in (3, 0xFFFE) and bits == 32:
                x = np.frombuffer(body, "<f4")
            elif bits == 16:
                x = np.frombuffer(body, "<i2") / 32768.0
            else:
                raise SystemExit(f"unsupported wav {fmt}")
            return x.reshape(-1, ch)[:, 0].astype(float)
        pos += 8 + size + (size & 1)
    raise SystemExit("no data chunk")


def analyse(y):
    """Drive = how much the crest factor drops; brightness = spectral centroid of the chord part."""
    seg = y[int(1.3 * SR): int(2.3 * SR)]
    rms = np.sqrt(np.mean(seg ** 2)) + 1e-12
    crest = 20 * np.log10(np.max(np.abs(seg)) / rms)
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1 / SR)
    centroid = float(np.sum(freqs * spec) / np.sum(spec))
    # odd-harmonic energy share of the low E power chord (E2 = 82.4 Hz) in the first second: distortion indicator
    first = y[int(0.1 * SR): int(1.1 * SR)]
    s1 = np.abs(np.fft.rfft(first * np.hanning(len(first))))
    f1 = np.fft.rfftfreq(len(first), 1 / SR)
    above = np.sum(s1[f1 > 1500] ** 2) / np.sum(s1[(f1 > 60) & (f1 < 20000)] ** 2)
    return 20 * np.log10(rms), crest, centroid, 10 * np.log10(above + 1e-12), float(np.max(np.abs(y)))


def main():
    exe = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    di = di_signal()
    src = os.path.join(OUT, "di.wav")
    write(src, di)
    rows = {}
    print(f"{'preset':10} {'rms dB':>7} {'crest':>6} {'centroid':>9} {'hi-band dB':>10} {'peak':>6}")
    base = analyse(di)
    print(f"{'(DI)':10} {base[0]:7.1f} {base[1]:6.1f} {base[2]:9.0f} {base[3]:10.1f} {base[4]:6.2f}")
    for p in PRESETS:
        out = os.path.join(OUT, f"{p}.wav")
        r = subprocess.run([exe, src, out, "--preset", p], capture_output=True, text=True)
        if r.returncode:
            print(p, "render failed", r.stderr[-300:])
            sys.exit(1)
        rows[p] = analyse(read(out))
        a = rows[p]
        print(f"{p:10} {a[0]:7.1f} {a[1]:6.1f} {a[2]:9.0f} {a[3]:10.1f} {a[4]:6.2f}")

    fails = []
    def check(cond, msg):
        if not cond:
            fails.append(msg)
    crest = {p: rows[p][1] for p in PRESETS}
    # more drive = lower crest factor (more compression), in the order the names promise
    check(crest["clean"] > crest["breakup"] > crest["crunch"] > crest["high_gain"] >= crest["metal"] - 0.5,
          f"drive order wrong: {crest}")
    check(crest["jazz"] > crest["crunch"], "jazz should be cleaner than crunch")
    check(rows["jazz"][2] < rows["clean"][2], "jazz should be darker than clean")
    check(rows["bass"][2] < rows["clean"][2], "bass should be darker than clean")
    levels = [rows[p][0] for p in PRESETS]
    check(max(levels) - min(levels) < 8, f"presets differ in loudness by {max(levels) - min(levels):.1f} dB")
    check(all(rows[p][4] <= 1.0 for p in PRESETS), "a preset exceeded 0 dBFS")
    for f in fails:
        print("FAIL:", f)
    print("tone checks:", "FAILED" if fails else "passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
