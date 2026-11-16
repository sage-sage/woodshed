"""Publish Woodshed to GitHub: the website on GitHub Pages, the amp as a GitHub Release, version.json for updates.

    python -I tools/release.py "what changed"        build, sync, commit, push, release the amp if its version is new
    python -I tools/release.py --dry "what changed"  everything except commit/push/release

The repo is a separate folder (../woodshed-pub) assembled from three sources:
    woodshed/            -> repo root (served by Pages at https://OWNER.github.io/woodshed/)
    woodshed-amp/        -> amp/        (source only; the .exe goes to the release)
    woodshed-tab-grabber -> tab-grabber/
Needs: gh (logged in), git, and the amp already built (woodshed-amp/build.sh).
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
HOME = os.path.dirname(SITE)
AMP = os.path.join(HOME, "woodshed-amp")
EXT = os.path.join(HOME, "woodshed-tab-grabber")
PUB = os.path.join(HOME, "woodshed-pub")
REPO = "woodshed"

SITE_FILES = ["index.html", "README.md"]
SITE_DIRS = ["css", "js", "vendor", "icons", "downloads", "test", "tools"]
AMP_FILES = ["build.sh", "CMakeLists.txt", "SPEC.md", "README.md"]
AMP_DIRS = ["src", "tools", "tests", "installer"]


def run(cmd, cwd=PUB, check=True, capture=False):
    print("  $", " ".join(cmd))
    r = subprocess.run(cmd, cwd=cwd, check=check, text=True, capture_output=capture)
    return r.stdout.strip() if capture else r.returncode


def owner():
    return run(["gh", "api", "user", "-q", ".login"], cwd=SITE, capture=True)


def amp_version():
    m = re.search(r'kAppVersion\s*=\s*"(\d+\.\d+\.\d+)"', open(os.path.join(AMP, "src", "version.h")).read())
    return m.group(1)


ISCC = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Inno Setup 6", "ISCC.exe")


def build_installer(ver):
    """Woodshed-Setup.exe (desktop app + amp + extension) via Inno Setup; the app bundles this site."""
    out = os.path.join(AMP, "dist")
    subprocess.run([ISCC, "/Q", f"/DAppVersion={ver}", f"/DBuildDir={os.path.join(AMP, 'build')}",
                    f"/DSiteDir={SITE}", f"/DExtDir={EXT}", f"/DOutDir={out}",
                    os.path.join(AMP, "installer", "woodshed.iss")], check=True)
    return os.path.join(out, "Woodshed-Setup.exe")


def ext_version():
    return json.load(open(os.path.join(EXT, "manifest.json"), encoding="utf-8"))["version"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def copy_tree(src, dst, skip=("node_modules", ".git", "build", "deps", "__pycache__")):
    for base, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in skip and not d.startswith(".")]
        rel = os.path.relpath(base, src)
        os.makedirs(os.path.join(dst, rel), exist_ok=True)
        for f in files:
            shutil.copy2(os.path.join(base, f), os.path.join(dst, rel, f))


def sync():
    """Rebuild the repo's working tree from the three source folders (keeps .git)."""
    os.makedirs(PUB, exist_ok=True)
    for name in os.listdir(PUB):
        if name != ".git":
            p = os.path.join(PUB, name)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    for f in SITE_FILES:
        if os.path.exists(os.path.join(SITE, f)):
            shutil.copy2(os.path.join(SITE, f), os.path.join(PUB, f))
    for d in SITE_DIRS:
        if os.path.isdir(os.path.join(SITE, d)):
            copy_tree(os.path.join(SITE, d), os.path.join(PUB, d))
    for f in AMP_FILES:
        os.makedirs(os.path.join(PUB, "amp"), exist_ok=True)
        shutil.copy2(os.path.join(AMP, f), os.path.join(PUB, "amp", f))
    for d in AMP_DIRS:
        copy_tree(os.path.join(AMP, d), os.path.join(PUB, "amp", d))
    copy_tree(EXT, os.path.join(PUB, "tab-grabber"))
    open(os.path.join(PUB, ".nojekyll"), "w").close()
    open(os.path.join(PUB, ".gitignore"), "w").write("*.exe\n*.zip.tmp\n__pycache__/\n")
    open(os.path.join(PUB, "LICENSE-amp.txt"), "w").write(
        "The amp/ folder is free software under the GNU GPL v3 (it uses the Steinberg ASIO SDK under its GPLv3 option).\n"
        "https://www.gnu.org/licenses/gpl-3.0.html\n")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry" in sys.argv
    notes = args[0] if args else "Updates"
    gh_owner = owner()
    exe = os.path.join(AMP, "build", "woodshed-amp.exe")
    ver = amp_version()
    vh = open(os.path.join(AMP, "src", "version.h")).read()
    if "__GH_OWNER__" in vh or f"{gh_owner}.github.io" not in vh:
        sys.exit("amp/src/version.h does not name this GitHub account: fix kGhOwner and rebuild the amp")

    run([sys.executable, "-I", os.path.join(HERE, "package.py")], cwd=SITE)
    # One version for the desktop app, the amp and the installer (kAppVersion in amp src/version.h).
    # A new GitHub release (tag v<ver>) is made only when that version has no release yet, so to ship site
    # changes to the desktop app, bump kAppVersion/kAmpVersion and rebuild the amp first.
    tag = f"v{ver}"
    repo = f"{gh_owner}/{REPO}"
    released = run(["gh", "release", "view", tag, "-R", repo], check=False, capture=False) == 0 if not dry else False
    setup = os.path.join(AMP, "dist", "Woodshed-Setup.exe")
    old_path = os.path.join(PUB, "version.json")
    old = json.load(open(old_path, encoding="utf-8")) if os.path.exists(old_path) else {}
    if not released:
        setup = build_installer(ver)
        setup_sha = sha256(setup)
    else:
        setup_sha = old.get("setup", {}).get("sha256", "")
    base = f"https://github.com/{gh_owner}/{REPO}/releases/download/{tag}/"
    manifest = {
        "site": {"updated": subprocess.run(["git", "log", "-1", "--format=%cI"], cwd=PUB, text=True,
                                           capture_output=True).stdout.strip() or None},
        "setup": {"version": ver, "url": base + "Woodshed-Setup.exe", "sha256": setup_sha, "notes": notes},
        # Portable (not installed) amps update by swapping this exe.
        "amp": {"version": ver, "url": base + "woodshed-amp.exe", "sha256": sha256(exe), "notes": notes},
        "extension": {"version": ext_version(), "url": "downloads/woodshed-tab-grabber.zip"},
    }
    if released and old.get("amp", {}).get("sha256") not in (None, manifest["amp"]["sha256"]):
        sys.exit(f"the amp .exe changed but {ver} is already released: bump kAppVersion/kAmpVersion and rebuild")
    if released:
        manifest["setup"]["notes"] = old.get("setup", {}).get("notes", notes)
        manifest["amp"]["notes"] = old.get("amp", {}).get("notes", notes)
    sync()
    open(os.path.join(PUB, "version.json"), "w", encoding="utf-8").write(json.dumps(manifest, indent=1) + "\n")
    shutil.copy2(os.path.join(PUB, "version.json"), os.path.join(SITE, "version.json"))
    print(f"version {ver} ({'already released' if released else 'new release'})  extension {ext_version()}")
    if dry:
        print("dry run: nothing pushed")
        return

    run(["git", "add", "-A"])
    if run(["git", "diff", "--cached", "--quiet"], check=False) != 0:
        run(["git", "commit", "-q", "-m", notes])
        run(["git", "push", "-q", "-u", "origin", "HEAD:main"])
    if not released:
        # Apps that check in the minute before this finishes just fail the download and try again later.
        run(["gh", "release", "create", tag, setup, exe, "-R", repo, "--target", "main", "--latest",
             "-t", f"Woodshed {ver}", "-n", notes])
    print(f"done: https://{gh_owner}.github.io/{REPO}/")


if __name__ == "__main__":
    main()
