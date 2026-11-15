"""Build "woodshed-local.zip": everything needed to run Woodshed on a Windows PC, offered by the hosted copy's
"Download for Windows" button.

    python -I tools/package.py            -> woodshed-local.zip next to index.html

Layout inside the zip (one top folder so unzipping never scatters files):
  Woodshed/
    Start Woodshed.cmd                 double-click: serves the app on http://localhost:8642/ and opens it
    README.txt
    app/                               the website (index.html, css, js, vendor, serve.ps1, launcher)
    Woodshed Amp/                      woodshed-amp.exe + README + licence notes + its own source code (GPLv3)
    Woodshed Tab Grabber/              the Chrome extension (load unpacked)
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
HOME = os.path.dirname(SITE)
AMP = os.path.join(HOME, "woodshed-amp")
EXT = os.path.join(HOME, "woodshed-tab-grabber")
OUT = os.path.join(SITE, "woodshed-local.zip")
TOP = "Woodshed"

README = """Woodshed for Windows
====================

1. Double-click "Start Woodshed.cmd". A small window opens (that is the local server: keep it open while you
   play) and Woodshed opens in your browser at http://localhost:8642/ . Close the window to stop.
   Windows may ask whether to allow it the first time; it only listens on your own computer.

2. Guitar input: plug your audio interface in, then press "Connect Guitar" (bottom left) and allow the microphone.
   Pick the interface and the input your guitar is on under Settings, and run Calibrate once.

3. Woodshed Amp (optional, recommended with an ASIO interface such as a MOTU M2):
   run "Woodshed Amp\\woodshed-amp.exe". It plays your guitar back through an amp tone with almost no delay,
   picks a tone for each song, and sends the signal to Woodshed for scoring. Its icon sits in the notification
   area (right-click it). See "Woodshed Amp\\README.md". Close your DAW first: ASIO drivers usually allow one
   program at a time.

4. Woodshed Tab Grabber (optional Chrome extension): grabs the tab you are looking at on Ultimate Guitar, Cifra
   Club, E-Chords and other text-tab sites and sends it to Woodshed's Add Song page.
   Install: open chrome://extensions, switch on "Developer mode" (top right), click "Load unpacked" and choose the
   "Woodshed Tab Grabber" folder. Then click its icon (or press Alt+Shift+W) on a tab page.

Your songs are stored in the browser for http://localhost:8642/ . Use Export on a song card to back one up.
Windows SmartScreen may warn that woodshed-amp.exe is from an unknown publisher (it is not code-signed):
choose "More info" -> "Run anyway" if you trust this copy.
"""

LAUNCHER = ('@echo off\r\nrem Starts Woodshed on http://localhost:8642/ and opens it. Close this window to stop.\r\n'
            'call "%~dp0app\\Start Woodshed.cmd"\r\n')

AMP_LICENSE = """Woodshed Amp is free software under the GNU General Public License v3
(https://www.gnu.org/licenses/gpl-3.0.html), because it uses the Steinberg ASIO SDK under its GPLv3 option.
Its source code is included in the "source" folder. To rebuild it, also fetch:
  - PortAudio (MIT): https://github.com/PortAudio/portaudio
  - Neural Amp Modeler Core (MIT, with Eigen MPL-2.0 and nlohmann/json MIT):
    https://github.com/sdatkinson/NeuralAmpModelerCore (with submodules)
  - Steinberg ASIO SDK (GPLv3 option): https://www.steinberg.net/asiosdk
into source/deps/ and run build.sh (see README.md).
"""

SITE_FILES = ["index.html", "serve.ps1", "Start Woodshed.cmd", "README.md"]
SITE_DIRS = ["css", "js", "vendor", "icons"]
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


def main():
    exe = os.path.join(AMP, "build", "woodshed-amp.exe")
    for need in [exe, os.path.join(EXT, "manifest.json")] + [os.path.join(SITE, f) for f in SITE_FILES]:
        if not os.path.exists(need):
            sys.exit(f"missing: {need}")
    tmp = OUT + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr(f"{TOP}/README.txt", README.replace("\n", "\r\n"))
        z.writestr(f"{TOP}/Start Woodshed.cmd", LAUNCHER)
        for f in SITE_FILES:
            z.write(os.path.join(SITE, f), f"{TOP}/app/{f}")
        for d in SITE_DIRS:
            add_tree(z, os.path.join(SITE, d), f"{TOP}/app/{d}")
        amp_dir = f"{TOP}/Woodshed Amp"
        z.write(exe, f"{amp_dir}/woodshed-amp.exe")
        z.write(os.path.join(AMP, "README.md"), f"{amp_dir}/README.md")
        z.writestr(f"{amp_dir}/LICENSE.txt", AMP_LICENSE.replace("\n", "\r\n"))
        for d in ["src", "tools", "tests"]:
            add_tree(z, os.path.join(AMP, d), f"{amp_dir}/source/{d}", exts={".cpp", ".h", ".py"})
        for f in ["build.sh", "CMakeLists.txt", "SPEC.md", "README.md"]:
            z.write(os.path.join(AMP, f), f"{amp_dir}/source/{f}")
        add_tree(z, EXT, f"{TOP}/Woodshed Tab Grabber", skip_dirs=("tests",))
    os.replace(tmp, OUT)
    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
    print(f"{OUT}: {os.path.getsize(OUT) / 1e6:.2f} MB, {len(names)} files")
    for n in names:
        if n.count("/") <= 2:
            print("  ", n)
    build_parts(exe)


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


HOSTED_README = README.replace(
    """3. Woodshed Amp (optional, recommended with an ASIO interface such as a MOTU M2):
   run "Woodshed Amp\\woodshed-amp.exe".""",
    """3. Woodshed Amp (optional, recommended with an ASIO interface such as a MOTU M2) is not part of this
   download (program files can't be offered from the hosted page); it is distributed separately as
   woodshed-amp.exe. When it runs,""").replace(
    """It plays your guitar back through an amp tone with almost no delay,
   picks a tone for each song,""", """it plays your guitar back through an amp tone with almost no delay,
   picks a tone for each song,""").replace(
    """ See "Woodshed Amp\\README.md". Close your DAW first: ASIO drivers usually allow one
   program at a time.""", """ Close your DAW first: ASIO drivers usually allow one program at a time.""")


def build_hosted():
    """Write dl/ for the hosted copy: the page zips these files itself (artifacts cannot serve .zip or .exe).
    Files the page already publishes (css/, js/, vendor/) are referenced, not copied. Prints the publish map."""
    import json
    import shutil
    dl = os.path.join(SITE, "dl")
    shutil.rmtree(dl, ignore_errors=True)
    os.makedirs(dl)
    entries = []
    publish = {}

    def put(zip_name, published, src=None, text=None):
        dst = os.path.join(SITE, published.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if text is not None:
            open(dst, "w", encoding="utf-8", newline="").write(text)
        else:
            shutil.copyfile(src, dst)
        entries.append({"zip": zip_name, "url": published})
        publish[published] = published

    put(f"{TOP}/README.txt", "dl/README.txt", text=HOSTED_README.replace("\n", "\r\n"))
    put(f"{TOP}/Start Woodshed.cmd", "dl/start-woodshed.cmd.txt", text=LAUNCHER)
    put(f"{TOP}/app/index.html", "dl/app/index.html", os.path.join(SITE, "index.html"))
    put(f"{TOP}/app/serve.ps1", "dl/app/serve.ps1.txt", os.path.join(SITE, "serve.ps1"))
    put(f"{TOP}/app/Start Woodshed.cmd", "dl/app/start-woodshed.cmd.txt", os.path.join(SITE, "Start Woodshed.cmd"))
    put(f"{TOP}/app/README.md", "dl/app/README.md", os.path.join(SITE, "README.md"))
    for d in SITE_DIRS:
        for base, _, files in os.walk(os.path.join(SITE, d)):
            for f in sorted(files):
                if f in SKIP_NAMES:
                    continue
                rel = os.path.relpath(os.path.join(base, f), SITE).replace("\\", "/")
                entries.append({"zip": f"{TOP}/app/{rel}", "url": rel})  # already published at this path
    for base, dirs, files in os.walk(EXT):
        dirs[:] = [d for d in dirs if d not in ("tests",) and not d.startswith(".")]
        for f in sorted(files):
            if f in SKIP_NAMES:
                continue
            rel = os.path.relpath(os.path.join(base, f), EXT).replace("\\", "/")
            put(f"{TOP}/Woodshed Tab Grabber/{rel}", f"dl/ext/{rel}", os.path.join(base, f))
    manifest = {"filename": "Woodshed for Windows.zip", "files": entries}
    open(os.path.join(dl, "manifest.json"), "w", encoding="utf-8").write(json.dumps(manifest, indent=1))
    publish["dl/manifest.json"] = "dl/manifest.json"
    open(os.path.join(SITE, "dl-publish.json"), "w", encoding="utf-8").write(json.dumps(publish, indent=1))
    print(f"dl/: {len(entries)} zip entries, {len(publish)} new files to publish (map in dl-publish.json)")


if __name__ == "__main__":
    if "--hosted" in sys.argv:
        build_hosted()
    else:
        main()
