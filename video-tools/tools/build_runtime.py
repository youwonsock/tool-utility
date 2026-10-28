"""Assemble or audit the two unpacked runtime distributions."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import itertools
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
CACHE = ROOT / ".build/downloads"
MAX_FILE_SIZE = 100 * 1024 * 1024
# Product entry points that every runtime must import; pruning must keep them working.
RUNTIME_IMPORTS = """import json,sys,tkinter,pydantic_core,video_tools.mcp.server,video_tools.gui.app
if sys.platform=="win32":
    import win32api,win32job,win32process
"""


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def input_hash():
    digest = hashlib.sha256()
    for name in ("build_runtime.py", "runtime-assets.json", "requirements-runtime.lock", "wheel-sources.json",
                 "ffmpeg-sources.json"):
        digest.update(name.encode() + b"\0" + (TOOLS / name).read_text(encoding="utf-8").encode("utf-8"))
    return digest.hexdigest()


def native_profile():
    machine = platform.machine().lower()
    if sys.platform == "win32" and machine in {"amd64", "x86_64"}:
        return "windows-x64"
    if sys.platform == "darwin" and machine in {"arm64", "aarch64"}:
        return "macos-arm64"
    raise RuntimeError("Runtime generation requires Windows x64 or Mac Apple Silicon.")


def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, encoding="utf-8", **kwargs)


def download(url, expected):
    if not url.startswith("https://"):
        raise RuntimeError("Runtime downloads require HTTPS.")
    CACHE.mkdir(parents=True, exist_ok=True)
    destination = CACHE / url.rsplit("/", 1)[-1]
    if not destination.is_file() or sha256(destination) != expected:
        temporary = destination.with_suffix(destination.suffix + ".partial")
        curl = "curl.exe" if sys.platform == "win32" else "/usr/bin/curl"
        run([curl, "--fail", "--location", "--silent", "--show-error", "--retry", "2",
             "--max-time", "300", "--output", str(temporary), url])
        if sha256(temporary) != expected:
            temporary.unlink()
            raise RuntimeError(f"Download checksum mismatch: {url}")
        temporary.replace(destination)
    return destination


def environment():
    result = dict(os.environ)
    for key in ("PYTHONHOME", "PYTHONPATH", "TCL_LIBRARY", "TK_LIBRARY",
                "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH"):
        result.pop(key, None)
    result["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    return result


def python_path(product, profile):
    return product / ("python/python.exe" if profile == "windows-x64" else "python/bin/python3.14")


def python_json(python, code):
    return json.loads(run([str(python), "-I", "-B", "-X", "utf8", "-c", code],
                          env=environment(), capture_output=True).stdout)


def select_wheels(python, profile):
    supported = python_json(python, "import json; from pip._vendor.packaging.tags import sys_tags; print(json.dumps([str(t) for t in sys_tags()]))")
    rank = {tag: index for index, tag in enumerate(supported)}
    selected = {}
    sources = json.loads((TOOLS / "wheel-sources.json").read_text())
    for requirement, assets in sources.items():
        if ";" in requirement and profile != "windows-x64":
            continue
        choices = []
        for asset in assets:
            tags = asset["filename"][:-4].rsplit("-", 3)[-3:]
            ranks = [rank["-".join(tag)] for tag in itertools.product(*(value.split(".") for value in tags))
                     if "-".join(tag) in rank]
            if ranks:
                choices.append((min(ranks), asset["filename"], asset))
        if not choices:
            raise RuntimeError(f"No locked native wheel for {profile}: {requirement}")
        selected[requirement.split(";")[0].strip()] = min(choices, key=lambda item: item[:2])[2]
    return selected


def provider_notices(product, archive):
    output = product / "licenses/python-build-standalone"
    output.mkdir(parents=True, exist_ok=True)
    metadata = None
    with tarfile.open(archive, "r|zst") as package:
        for member in package:
            if not member.isfile():
                continue
            relative = Path(member.name).relative_to("python")
            if relative.as_posix() == "PYTHON.json":
                metadata = json.load(package.extractfile(member))
                (output / "PYTHON.json").write_text(json.dumps(metadata, indent=2) + "\n")
            elif relative.parts[0] == "licenses" or relative.name.lower().startswith(("license", "copying", "copyright", "notice")):
                if member.size > 2 * 1024 * 1024:
                    continue
                destination = output / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(package.extractfile(member).read())
    if metadata is None:
        raise RuntimeError("Python provider metadata is missing.")
    required = [metadata["license_path"]]
    for entries in metadata["build_info"]["extensions"].values():
        for extension in entries:
            required.extend(extension.get("license_path", []))
    for relative in set(required):
        if not (output / relative).is_file():
            raise RuntimeError(f"Python dependency notice is missing: {relative}")
    return metadata


def collect_package_notices(product, site):
    legal = product / "licenses/packages"
    for information in site.glob("*.dist-info"):
        for source in information.rglob("*"):
            if source.is_file() and any(part in source.name.lower() for part in ("license", "copying", "notice", "authors")):
                destination = legal / source.relative_to(site)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)


def prune_build_files(product, site):
    # pip is used only while assembling the locked wheels.
    for path in list(site.glob("pip")) + list(site.glob("pip-*.dist-info")):
        shutil.rmtree(path)
    for path in product.rglob("__pycache__"):
        if path.is_dir():
            shutil.rmtree(path)
    for path in product.rglob("*.pyc"):
        path.unlink()
    for path in product.rglob("*.pyo"):
        path.unlink()
    for name in ("include", "share/man"):
        path = product / "python" / name
        if path.exists():
            shutil.rmtree(path)
    # CPython's upstream regression suites, Tk demos, packaging bootstraps and
    # the unused SQLite binding are not runtime inputs.
    library = site.parent
    for name in ("test", "idlelib", "tkinter/test", "ctypes/test", "unittest/test", "ensurepip", "venv",
                 "pydoc_data", "turtledemo", "turtle.py", "sqlite3"):
        path = library / name
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
    extensions = product / "python" / ("DLLs" if sys.platform == "win32" else "lib/python3.14/lib-dynload")
    for pattern in ("_test*", "_ctypes_test*", "xxlimited*", "xxsubtype*", "_xxtestfuzz*", "_sqlite3*", "sqlite3.dll"):
        for path in extensions.glob(pattern):
            path.unlink()
    if sys.platform == "win32":
        # Import libraries only serve extension builds.
        shutil.rmtree(product / "python/libs", ignore_errors=True)
        # MCP needs pywin32's win32 API modules and DLLs, not COM, Pythonwin or ISAPI.
        for name in ("PyWin32.chm", "pythonwin", "win32com", "win32comext", "adodbapi", "isapi",
                     "win32/Demos", "win32/test", "win32/scripts", "win32/include", "win32/libs"):
            path = site / name
            if path.is_dir():
                shutil.rmtree(path)
            elif path.exists():
                path.unlink()
    for name in ("test", "tests"):
        for path in list(site.rglob(name)):
            if path.is_dir():
                shutil.rmtree(path)
    for path in site.glob("annotated_types/test_cases.py"):
        path.unlink()
    # Wheel command wrappers embed the builder's absolute interpreter path.
    # Product launchers call the relocatable interpreter directly.
    scripts = product / "python" / ("Scripts" if sys.platform == "win32" else "bin")
    for path in scripts.iterdir():
        if sys.platform != "win32" and path.name in {"python", "python3", "python3.14"}:
            continue
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    for path in (product / "python").rglob("demos"):
        if path.parent.name.startswith("tk") and path.is_dir():
            shutil.rmtree(path)


def sign_macos(product, repair=True):
    magic = {b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"}
    binaries = []
    for path in product.rglob("*"):
        if path.is_file() and not path.is_symlink():
            with path.open("rb") as stream:
                if stream.read(4) in magic:
                    binaries.append(path)
    for path in binaries:
        check = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(path)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if check.returncode:
            if not repair:
                raise RuntimeError(f"Mac code signature is invalid: {path}")
            run(["/usr/bin/codesign", "--force", "--sign", "-", str(path)], capture_output=True)
        run(["/usr/bin/codesign", "--verify", "--strict", str(path)], capture_output=True)
    return len(binaries)


def inventory(product):
    result = {}
    total = 0
    for path in sorted(product.rglob("*")):
        relative = path.relative_to(product).as_posix()
        if relative == "manifest.json":
            continue
        if path.is_symlink():
            target = os.readlink(path)
            if not path.resolve().is_relative_to(product.resolve()):
                raise RuntimeError(f"Runtime symlink escapes its folder: {relative}")
            result[relative] = {"mode": "120000", "symlink": target}
        elif path.is_file():
            size = path.stat().st_size
            if size > MAX_FILE_SIZE:
                raise RuntimeError(f"GitHub file size limit exceeded: {relative}")
            total += size
            mode = "100755" if path.stat().st_mode & stat.S_IXUSR else "100644"
            if sys.platform == "win32":
                mode = "100644"
            result[relative] = {"mode": mode, "size": size, "sha256": sha256(path)}
    return result, total


def install_ffmpeg(product, profile, source, archive=None):
    """Unpack the pinned tools/build_ffmpeg.py archive into media/ and licenses/."""
    if "ffmpeg_sha256" not in source:
        raise RuntimeError(f"Pin {profile}'s build_ffmpeg.py archive (ffmpeg_url, ffmpeg_sha256) in runtime-assets.json.")
    if archive is None:
        archive = download(source["ffmpeg_url"], source["ffmpeg_sha256"])
    elif sha256(archive) != source["ffmpeg_sha256"]:
        raise RuntimeError(f"FFmpeg archive does not match the pinned hash: {archive}")
    name = "ffmpeg.exe" if profile == "windows-x64" else "ffmpeg"
    media, legal = product / "media", product / "licenses"
    media.mkdir()
    (legal / "FFmpeg").mkdir(parents=True)
    with tarfile.open(archive, "r:gz") as package:
        members = {member.name: member for member in package.getmembers() if member.isfile()}
        if name not in members or "build-info.json" not in members:
            raise RuntimeError("FFmpeg archive lacks its executable or build information.")
        info = json.load(package.extractfile(members["build-info.json"]))
        if info["profile"] != profile or info["sources_sha256"] != sha256(TOOLS / "ffmpeg-sources.json"):
            raise RuntimeError("FFmpeg archive was built for another profile or source pin.")
        (media / name).write_bytes(package.extractfile(members[name]).read())
        for member_name, member in members.items():
            if member_name.startswith("licenses/"):
                (legal / "FFmpeg" / Path(member_name).name).write_bytes(package.extractfile(member).read())
    ffmpeg = media / name
    if profile == "macos-arm64":
        ffmpeg.chmod(0o755)
    sources = info["sources"]
    (legal / "FFmpeg-provenance.txt").write_text(
        "Built by tools/build_ffmpeg.py from these pinned sources (GPLv2 or later with libx264):\n"
        + "".join(f"- {key} {item['version']}: {item['url']} sha256={item['sha256']}\n" for key, item in sources.items())
        + "\nThe release publishing this FFmpeg archive also attaches these exact source archives;"
        + " the build script is tools/build_ffmpeg.py.\n\n"
        + info["version"], encoding="utf-8")
    (legal / "FFmpeg-license.txt").write_text(run([str(ffmpeg), "-L"], capture_output=True).stdout, encoding="utf-8")
    build = {"archive_sha256": sha256(archive), "sources": {key: item["version"] for key, item in sources.items()},
             "linked_libraries": info["linked_libraries"]}
    return ffmpeg, build


def assemble(profile, ffmpeg_archive=None):
    assets = json.loads((TOOLS / "runtime-assets.json").read_text())
    source = assets["profiles"][profile]
    product = ROOT / "portable" / profile
    if product.exists():
        shutil.rmtree(product)
    product.mkdir(parents=True)
    archive = download(source["archive_url"], source["archive_sha256"])
    with tarfile.open(archive, "r:gz") as package:
        package.extractall(product, filter="data")
    python = python_path(product, profile)
    wheels = select_wheels(python, profile)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda value: download(value["url"], value["sha256"]), wheels.values()))
    # The lock is the complete runtime set: it omits optional extras such as
    # MCP's HTTP OAuth cryptography, which the stdio server never imports.
    run([str(python), "-I", "-B", "-X", "utf8", "-m", "pip", "install", "--no-index", "--no-deps",
         "--find-links", str(CACHE), "--only-binary=:all:", "--require-hashes", "--no-compile",
         "-r", str(TOOLS / "requirements-runtime.lock")], env=environment())
    code = """import json,sys,sysconfig,platform,importlib.metadata as m,tkinter as tk
r=tk.Tk(); r.withdraw(); r.update()
data={"python":platform.python_version(),"machine":platform.machine(),
      "site":sysconfig.get_path("purelib"),
      "tcl":str(r.tk.call("info","patchlevel")),"tk":str(r.tk.call("package","require","Tk")),
      "dependencies":{d.metadata["Name"]:d.version for d in m.distributions() if d.metadata["Name"]!="pip"}}
r.destroy(); print(json.dumps(data))
"""
    data = python_json(python, code)
    if data["python"] != assets["python"]:
        raise RuntimeError("Unexpected Python version.")
    ffmpeg, ffmpeg_build = install_ffmpeg(product, profile, source, ffmpeg_archive)
    version = run([str(ffmpeg), "-version"], capture_output=True).stdout
    encoders = run([str(ffmpeg), "-hide_banner", "-encoders"], capture_output=True).stdout
    if not all(name in encoders for name in ("libx264", "libx264rgb", "aac", "mjpeg", "png")):
        raise RuntimeError("FFmpeg lacks a required encoder.")
    metadata_archive = download(source["metadata_url"], source["metadata_sha256"])
    metadata = provider_notices(product, metadata_archive)
    if metadata["target_triple"] != source["triple"]:
        raise RuntimeError("Python metadata target does not match its runtime.")
    site = Path(data.pop("site"))
    collect_package_notices(product, site)
    prune_build_files(product, site)
    python_json(python, f"import sys; sys.path.insert(0, {str(ROOT / 'src')!r})\n" + RUNTIME_IMPORTS + 'print(json.dumps({"ready":True}))')
    prune_build_files(product, site)  # The import check must not leave bytecode behind.
    signed = sign_macos(product) if profile == "macos-arm64" else 0
    files, total = inventory(product)
    manifest = {**data, "profile": profile, "input_sha256": input_hash(),
                "provider": source, "wheels": wheels, "ffmpeg_build": ffmpeg_build,
                "ffmpeg_version": version, "signed_macho_files": signed, "total_bytes": total,
                "files": files}
    (product / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return product


def audit(profile, git=False):
    product = ROOT / "portable" / profile
    manifest = json.loads((product / "manifest.json").read_text(encoding="utf-8"))
    if manifest["profile"] != profile or manifest["input_sha256"] != input_hash():
        raise RuntimeError(f"Runtime inputs changed: regenerate and synchronize {profile}.")
    actual, total = inventory(product)
    expected = manifest["files"]
    if sys.platform == "win32" and profile == "macos-arm64":
        # A Windows checkout may materialize POSIX symlinks as ordinary text.
        raise RuntimeError("Audit Mac runtime file modes on macOS.")
    if actual != expected or total != manifest["total_bytes"]:
        differences = sorted(set(actual) ^ set(expected)) + [
            name for name in set(actual) & set(expected) if actual[name] != expected[name]]
        raise RuntimeError(f"Runtime files differ from their manifest: {differences[:12]}")
    if git:
        listing = run(["git", "ls-files", "-s", "-z", "--", str(product)],
                      capture_output=True, cwd=ROOT.parent).stdout
        tracked = {}
        for item in listing.split("\0"):
            if item:
                information, name = item.split("\t", 1)
                tracked[name] = information.split()[0]
        for name, entry in {**expected, "manifest.json": {"mode": "100644"}}.items():
            key = product.relative_to(ROOT.parent).as_posix() + "/" + name
            if tracked.get(key) != entry["mode"]:
                raise RuntimeError(f"Runtime file absent or wrong mode in Git: {key}")
    if profile == native_profile():
        python = python_path(product, profile)
        python_json(python, f"import sys; sys.path.insert(0, {str(ROOT / 'src')!r})\n" + RUNTIME_IMPORTS + 'print(json.dumps({"ready":True}))')
        if profile == "macos-arm64":
            sign_count = sign_macos(product, repair=False)
            if sign_count != manifest["signed_macho_files"]:
                raise RuntimeError("Mac code signature inventory changed.")
    return product


def pack(product):
    folder = ROOT / ".build/artifacts"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (product.name + ".tar.gz")
    with tarfile.open(path, "w:gz", compresslevel=6) as archive:
        archive.add(product, arcname=product.name)
    path.with_suffix(path.suffix + ".sha256").write_text(sha256(path) + "  " + path.name + "\n")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Regenerate native runtime artifacts")
    parser.add_argument("--audit", action="store_true", help="Audit the committed runtime without downloading")
    parser.add_argument("--git", action="store_true", help="Require every payload file to be tracked")
    parser.add_argument("--archive", action="store_true")
    parser.add_argument("--ffmpeg", type=Path, help="Local build_ffmpeg.py archive matching the pinned hash")
    args = parser.parse_args()
    profile = native_profile()
    manifest = ROOT / "portable" / profile / "manifest.json"
    if args.audit:
        product = audit(profile, args.git)
    else:
        product = assemble(profile, args.ffmpeg) if args.refresh or not manifest.is_file() else audit(profile)
    if args.archive:
        print(pack(product))
    print(json.dumps({"profile": profile, "input_sha256": input_hash(), "status": "ready"}))


if __name__ == "__main__":
    main()
