"""Build the minimal static FFmpeg that the runtime bundles, from pinned sources.

Windows runs inside MSYS2 MINGW64 (nasm, make, meson, ninja, pkgconf, gcc);
macOS uses the Xcode toolchain plus nasm, meson, ninja and pkg-config.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

from build_runtime import ROOT, TOOLS, download, native_profile, sha256

SOURCES = TOOLS / "ffmpeg-sources.json"
MIRROR = TOOLS / "ffmpeg-source-mirror.json"
WORK = ROOT / ".build/ffmpeg"
LISTINGS = {"protocol": "-protocols", "demuxer": "-demuxers", "muxer": "-muxers", "decoder": "-decoders",
            "encoder": "-encoders", "bsf": "-bsfs", "filter": "-filters", "indev": "-devices"}
# configure names that FFmpeg lists under their runtime format name.
LISTED_AS = {"image_png_pipe": "png_pipe", "image_jpeg_pipe": "jpeg_pipe"}
MACOS_TARGET = "15.0"


def posix(path: Path) -> str:
    """Path as the build shell sees it; MSYS2 maps C:\\x to /c/x."""
    text = path.resolve().as_posix()
    if sys.platform == "win32" and re.match(r"^[A-Za-z]:/", text):
        text = "/" + text[0].lower() + text[2:]
    return text


def shell(script: str, cwd: Path, env: dict[str, str]) -> str:
    if sys.platform == "win32":
        bash = Path(os.environ.get("MSYS2_ROOT", "C:/msys64")) / "usr/bin/bash.exe"
        command = [str(bash), "-lc", script]
        env = {**env, "MSYSTEM": "MINGW64", "CHERE_INVOKING": "1"}
    else:
        command = ["/bin/sh", "-c", script]
    print("+", script, flush=True)
    return subprocess.run(command, cwd=cwd, env=env, check=True, text=True, encoding="utf-8",
                          stdout=subprocess.PIPE).stdout


def fetch_source(item: dict) -> Path:
    """Fall back to the released corresponding sources when upstream moves or rewrites an archive."""
    try:
        return download(item["url"], item["sha256"])
    except (RuntimeError, subprocess.SubprocessError) as exc:
        base = json.loads(MIRROR.read_text(encoding="utf-8"))["base_url"]
        print(f"Using the source mirror after {item['url']} failed: {exc}", flush=True)
        return download(base + item["url"].rsplit("/", 1)[-1], item["sha256"])


def unpack(archive: Path, destination: Path) -> Path:
    with tarfile.open(archive) as package:
        roots = {Path(member.name).parts[0] for member in package.getmembers()}
        if len(roots) != 1:
            raise RuntimeError(f"Unexpected source archive layout: {archive.name}")
        package.extractall(destination, filter="data")
    return destination / roots.pop()


def configure_flags(components: dict[str, list[str]], prefix: str) -> list[str]:
    flags = ["--disable-everything", "--disable-autodetect", "--disable-network", "--disable-doc",
             "--disable-ffplay", "--disable-ffprobe", "--disable-debug", "--enable-gpl", "--enable-static",
             "--disable-shared", "--pkg-config-flags=--static", "--enable-zlib", "--enable-libx264",
             "--enable-libdav1d", "--enable-swscale", "--enable-swresample", "--enable-avfilter",
             # Autodetection is off, so threads must be requested or FFmpeg runs single-threaded.
             "--enable-w32threads" if sys.platform == "win32" else "--enable-pthreads",
             f"--prefix={prefix}", f"--extra-cflags=-I{prefix}/include", f"--extra-ldflags=-L{prefix}/lib"]
    if sys.platform == "win32":
        flags.append("--extra-ldflags=-static")
    for kind, names in components.items():
        flags.extend(f"--enable-{kind}={name}" for name in names)
    return flags


def verify_components(ffmpeg: Path, components: dict[str, list[str]]) -> None:
    missing = []
    for kind, names in components.items():
        if kind not in LISTINGS:
            continue  # The CLI cannot list parsers; configure rejects unknown names.
        listing = subprocess.run([str(ffmpeg), "-hide_banner", LISTINGS[kind]], check=True, text=True,
                                 encoding="utf-8", capture_output=True).stdout
        words = set(re.split(r"[\s,]+", listing))
        missing.extend(f"{kind}:{name}" for name in names if LISTED_AS.get(name, name) not in words)
    if missing:
        raise RuntimeError(f"FFmpeg lacks required components: {missing}")


def verify_static(ffmpeg: Path, env: dict[str, str]) -> list[str]:
    if sys.platform == "win32":
        output = shell(f"objdump -p '{posix(ffmpeg)}'", ffmpeg.parent, env)
        libraries = re.findall(r"DLL Name:\s*(\S+)", output)
        # MinGW runtime or codec DLLs would make the copied executable non-portable.
        foreign = [name for name in libraries if name.lower().startswith("lib")
                   or any(part in name.lower() for part in ("x264", "dav1d", "zlib", "z.dll"))]
    else:
        output = subprocess.run(["/usr/bin/otool", "-L", str(ffmpeg)], check=True, text=True,
                                capture_output=True).stdout
        libraries = [line.split()[0] for line in output.splitlines()[1:] if line.strip()]
        foreign = [name for name in libraries if not name.startswith(("/usr/lib/", "/System/Library/"))]
    if foreign:
        raise RuntimeError(f"FFmpeg links non-system libraries: {foreign}")
    return libraries


def build(profile: str) -> Path:
    data = json.loads(SOURCES.read_text(encoding="utf-8"))
    sources, components = data["sources"], data["components"]
    root = WORK / profile
    if root.exists():
        shutil.rmtree(root)
    (root / "src").mkdir(parents=True)
    prefix = root / "prefix"
    archives = {name: fetch_source(item) for name, item in sources.items()}
    folders = {name: unpack(archive, root / "src") for name, archive in archives.items()}
    env = dict(os.environ)
    for key in ("CFLAGS", "LDFLAGS", "CPPFLAGS", "PKG_CONFIG_PATH"):
        env.pop(key, None)
    if profile == "macos-arm64":
        env["MACOSX_DEPLOYMENT_TARGET"] = MACOS_TARGET
    jobs = str(os.cpu_count() or 2)
    p = posix(prefix)
    # Set inside the script: the MSYS2 login profile overwrites an inherited PKG_CONFIG_PATH.
    pc = f"export PKG_CONFIG_PATH='{p}/lib/pkgconfig'; "

    if sys.platform == "win32":
        shell(f"make -f win32/Makefile.gcc -j{jobs} libz.a && make -f win32/Makefile.gcc install SHARED_MODE=0 "
              f"BINARY_PATH='{p}/bin' INCLUDE_PATH='{p}/include' LIBRARY_PATH='{p}/lib'", folders["zlib"], env)
    else:
        shell(f"./configure --static --prefix='{p}' && make -j{jobs} install", folders["zlib"], env)
    shell(pc + f"./configure --prefix='{p}' --enable-static --disable-cli --disable-opencl --enable-pic "
          f"&& make -j{jobs} && make install", folders["x264"], env)
    shell(pc + f"meson setup build --prefix='{p}' --libdir=lib --buildtype=release --default-library=static "
          "-Denable_tools=false -Denable_tests=false -Denable_examples=false && ninja -C build install",
          folders["dav1d"], env)
    flags = " ".join(f"'{flag}'" for flag in configure_flags(components, p))
    shell(pc + f"./configure {flags} && make -j{jobs} && make install", folders["ffmpeg"], env)

    name = "ffmpeg.exe" if profile == "windows-x64" else "ffmpeg"
    output = root / "output"
    (output / "licenses").mkdir(parents=True)
    ffmpeg = output / name
    shutil.copy2(prefix / "bin" / name, ffmpeg)
    shell(f"strip '{posix(ffmpeg)}'", output, env)
    verify_components(ffmpeg, components)
    libraries = verify_static(ffmpeg, env)
    for source, item in sources.items():
        shutil.copy2(folders[source] / item["license"], output / "licenses" / f"{source}-{item['license']}")
    version = subprocess.run([str(ffmpeg), "-version"], check=True, text=True, encoding="utf-8",
                             capture_output=True).stdout
    info = {"profile": profile, "sources": sources, "components": components, "version": version,
            "linked_libraries": libraries, "builder": platform.platform(),
            "sources_sha256": sha256(SOURCES), "build_script_sha256": sha256(Path(__file__))}
    (output / "build-info.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")

    folder = ROOT / ".build/artifacts"
    # GPL corresponding source: published beside the binary archives.
    (folder / "ffmpeg-sources").mkdir(parents=True, exist_ok=True)
    for source_archive in archives.values():
        shutil.copy2(source_archive, folder / "ffmpeg-sources" / source_archive.name)
    archive = folder / f"ffmpeg-{profile}.tar.gz"
    with tarfile.open(archive, "w:gz", compresslevel=9) as package:
        for path in sorted(output.rglob("*")):
            if path.is_file():
                package.add(path, arcname=path.relative_to(output).as_posix())
    archive.with_suffix(archive.suffix + ".sha256").write_text(sha256(archive) + "  " + archive.name + "\n")
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    archive = build(native_profile())
    print(json.dumps({"archive": str(archive), "sha256": sha256(archive), "bytes": archive.stat().st_size}))


if __name__ == "__main__":
    main()
