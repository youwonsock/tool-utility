"""Import verified offline runtimes at build time, or audit product copies.

The installed product never reads the developer's seed distribution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILES = ("windows-x64", "macos-arm64")


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(root):
    return {p.relative_to(root).as_posix(): {"sha256": sha(p), "bytes": p.stat().st_size,
            "executable": bool(p.stat().st_mode & stat.S_IXUSR)}
            for p in sorted(root.rglob("*")) if p.is_file() and p != root / "manifest.json"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=Path, help="Developer input containing both verified runtime profiles")
    parser.add_argument("--audit", action="store_true")
    parser.add_argument("--profile", choices=PROFILES)
    args = parser.parse_args()
    reports = []
    for profile in ([args.profile] if args.profile else PROFILES):
        target = ROOT / "portable" / profile
        if args.seed:
            source = args.seed.expanduser().resolve() / profile
            if target.exists():
                raise RuntimeError(f"Refusing to overwrite an existing runtime: {target}")
            original = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
            for relative, entry in original["files"].items():
                if isinstance(entry, dict) and "symlink" in entry:
                    link = source / relative
                    if not link.is_symlink() or os.readlink(link) != entry["symlink"] or not link.resolve().is_relative_to(source):
                        raise RuntimeError(f"Seed symlink mismatch: {relative}")
                    continue
                expected = entry["sha256"] if isinstance(entry, dict) else entry
                if sha(source / relative) != expected:
                    raise RuntimeError(f"Seed checksum mismatch: {relative}")
            target.mkdir(parents=True)
            shutil.copytree(source / "python", target / "python", symlinks=False)
            shutil.copytree(source / "licenses", target / "licenses", symlinks=False)
            for site in (target / "python").rglob("site-packages"):
                for candidate in site.glob("imageio_ffmpeg*"):
                    shutil.rmtree(candidate) if candidate.is_dir() else candidate.unlink()
            manifest = {"product": "path-analysis-tools", "profile": profile, "python": original["python"],
                        "provider": original.get("provider", {}),
                        "seed_manifest_sha256": sha(source / "manifest.json"),
                        "dependencies": {k: v for k, v in original["dependencies"].items() if k != "imageio-ffmpeg"},
                        "files": inventory(target)}
            (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
        actual = inventory(target)
        expected = manifest["files"]
        if os.name == "nt":
            for value in actual.values():
                value.pop("executable", None)
            expected = {key: {k: v for k, v in entry.items() if k != "executable"} for key, entry in expected.items()}
        if actual != expected:
            missing = sorted(set(expected) - set(actual))
            extra = sorted(set(actual) - set(expected))
            changed = sorted(key for key in set(actual) & set(expected) if actual[key] != expected[key])
            raise RuntimeError(f"Runtime mismatch {profile}: missing={missing[:5]} extra={extra[:5]} changed={changed[:5]}")
        if manifest["product"] != "path-analysis-tools":
            raise RuntimeError("Wrong product manifest")
        reports.append({"profile": profile, "files": len(actual), "bytes": sum(e["bytes"] for e in actual.values()),
                        "manifest_sha256": sha(target / "manifest.json")})
    print(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
