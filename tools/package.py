"""Build the Settings page's downloads: downloads/woodshed-amp.zip and downloads/woodshed-tab-grabber.zip.

    python -I tools/package.py        (tools/release.py runs this before publishing)
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
HOME = os.path.dirname(SITE)
AMP = os.path.join(HOME, "woodshed-amp")
EXT = os.path.join(HOME, "woodshed-tab-grabber")

AMP_LICENSE = """Woodshed Amp is free software under the GNU General Public License v3
(https://www.gnu.org/licenses/gpl-3.0.html), because it uses the Steinberg ASIO SDK under its GPLv3 option.
Its source code is included in the "source" folder. To rebuild it, also fetch:
  - PortAudio (MIT): https://github.com/PortAudio/portaudio
  - Neural Amp Modeler Core (MIT, with Eigen MPL-2.0 and nlohmann/json MIT):
    https://github.com/sdatkinson/NeuralAmpModelerCore (with submodules)
  - Steinberg ASIO SDK (GPLv3 option): https://www.steinberg.net/asiosdk
into source/deps/ and run build.sh (see README.md).
"""

SKIP_NAMES = {"package.json"}  # vendor/package.json is only for node tests


def add_tree(z, src_dir, arc_dir, exts=None, skip_dirs=()):
    for base, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
        for f in sorted(files):
            if f in SKIP_NAMES or (exts and os.path.splitext(f)[1].lower() not in exts):
                continue
            full = os.path.join(base, f)
            rel = os.path.relpath(full, src_dir)
            z.write(full, f"{arc_dir}/{rel}".replace("\\", "/"))


def build_parts(exe):
    """downloads/: the amp and the extension as their own zips, for the Settings page's download buttons."""
    out_dir = os.path.join(SITE, "downloads")
    os.makedirs(out_dir, exist_ok=True)

    def write(name, fill):
        path = os.path.join(out_dir, name)
        with zipfile.ZipFile(path + ".tmp", "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            fill(z)
        os.replace(path + ".tmp", path)
        print(f"{path}: {os.path.getsize(path) / 1e6:.2f} MB")

    def amp(z):
        d = "Woodshed Amp"
        z.write(exe, f"{d}/woodshed-amp.exe")
        z.write(os.path.join(AMP, "README.md"), f"{d}/README.md")
        z.writestr(f"{d}/LICENSE.txt", AMP_LICENSE.replace("\n", "\r\n"))
        for sub in ["src", "tools", "tests"]:
            add_tree(z, os.path.join(AMP, sub), f"{d}/source/{sub}", exts={".cpp", ".h", ".py"})
        for f in ["build.sh", "CMakeLists.txt", "SPEC.md", "README.md"]:
            z.write(os.path.join(AMP, f), f"{d}/source/{f}")

    write("woodshed-amp.zip", amp)
    write("woodshed-tab-grabber.zip",
          lambda z: add_tree(z, EXT, "Woodshed Tab Grabber", skip_dirs=("tests",)))


def main():
    exe = os.path.join(AMP, "build", "woodshed-amp.exe")
    for need in [exe, os.path.join(EXT, "manifest.json")]:
        if not os.path.exists(need):
            sys.exit(f"missing: {need}")
    build_parts(exe)


if __name__ == "__main__":
    main()
