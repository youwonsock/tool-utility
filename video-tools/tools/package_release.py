"""Package one platform's audited runtime as a standalone release ZIP."""
from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

from build_runtime import ROOT, audit, native_profile, sha256

LAUNCHERS = {"windows-x64": ("run.bat", "run_mcp.bat"), "macos-arm64": ("run_mac.command", "run_mcp.command")}
# Fixed timestamps keep the archive bytes independent of checkout time.
STAMP = (1980, 1, 1, 0, 0, 0)


def entries(profile):
    """Yield (archive path, source path, Git mode) for every shipped file."""
    for name in ("launch.py", "README.md", *LAUNCHERS[profile]):
        yield name, ROOT / name, "100755" if name.endswith(".command") else "100644"
    for folder in ("src", "docs"):
        for path in sorted((ROOT / folder).rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix not in {".pyc", ".pyo"}:
                yield path.relative_to(ROOT).as_posix(), path, "100644"
    product = ROOT / "portable" / profile
    yield f"portable/{profile}/manifest.json", product / "manifest.json", "100644"
    for name, entry in json.loads((product / "manifest.json").read_text(encoding="utf-8"))["files"].items():
        # A link ships as its manifest target; Windows checkouts hold it as plain text.
        yield f"portable/{profile}/{name}", entry.get("symlink", product / name), entry["mode"]


def package(profile):
    audit(profile)
    folder = ROOT / ".build/artifacts"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"video-tools-{profile}.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, source, mode in entries(profile):
            info = zipfile.ZipInfo(f"video-tools/{name}", STAMP)
            info.create_system = 3  # Unix, so Archive Utility applies the stored modes.
            info.external_attr = int(mode, 8) << 16
            if isinstance(source, str):
                archive.writestr(info, source, zipfile.ZIP_STORED)
            else:
                info.compress_type = zipfile.ZIP_DEFLATED
                with source.open("rb") as stream:
                    archive.writestr(info, stream.read())
    path.with_suffix(path.suffix + ".sha256").write_text(sha256(path) + "  " + path.name + "\n")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    path = package(native_profile())
    print(json.dumps({"archive": str(path), "sha256": sha256(path), "bytes": path.stat().st_size}))


if __name__ == "__main__":
    main()
