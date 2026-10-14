"""Synchronize both CI runtime archives, preserving Git modes on either OS."""
import argparse
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

from build_runtime import ROOT, input_hash, sha256

PROFILES = {"windows-x64", "macos-arm64"}


def unpack(archive):
    with tarfile.open(archive, "r:gz") as stream:
        members = stream.getmembers()
        roots = {Path(member.name).parts[0] for member in members}
        if len(roots) != 1 or not roots <= PROFILES:
            raise RuntimeError(f"Unexpected runtime archive root: {roots}")
        profile = roots.pop()
        root = ROOT / "portable" / profile
        if root.exists():
            shutil.rmtree(root)
        for member in members:
            relative = Path(member.name)
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError("Archive path escapes the runtime directory.")
            path = ROOT / "portable" / relative
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            elif member.issym():
                path.parent.mkdir(parents=True, exist_ok=True)
                if not (path.parent / member.linkname).resolve().is_relative_to(root.resolve()):
                    raise RuntimeError("Archive symlink escapes the runtime directory.")
                if os.name == "nt":
                    path.write_text(member.linkname, encoding="utf-8")
                else:
                    path.symlink_to(member.linkname)
            elif member.isfile():
                path.parent.mkdir(parents=True, exist_ok=True)
                with stream.extractfile(member) as source, path.open("wb") as destination:
                    shutil.copyfileobj(source, destination)
                if os.name != "nt":
                    path.chmod(member.mode)
            else:
                raise RuntimeError(f"Unsupported runtime archive entry: {member.name}")
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest["profile"] != profile or manifest["input_sha256"] != input_hash():
        raise RuntimeError("CI runtime was generated from different runtime inputs.")
    expected = manifest["files"]
    actual_paths = {path.relative_to(root).as_posix() for path in root.rglob("*")
                    if path.is_file() or path.is_symlink()}
    if actual_paths != set(expected) | {"manifest.json"}:
        raise RuntimeError("Runtime archive has missing or unexpected files.")
    for name, record in expected.items():
        path = root / name
        if record["mode"] == "120000":
            actual = os.readlink(path) if path.is_symlink() else path.read_text(encoding="utf-8")
            if actual != record["symlink"]:
                raise RuntimeError(f"Runtime symlink mismatch: {name}")
        elif sha256(path) != record["sha256"]:
            raise RuntimeError(f"Runtime checksum mismatch: {name}")
    return root, manifest


def stage(root, manifest):
    repository = ROOT.parent
    subprocess.run(["git", "add", "--force", "--", str(root)], cwd=repository, check=True)
    records = bytearray()
    for name, record in {**manifest["files"], "manifest.json": {"mode": "100644"}}.items():
        path = root / name
        data = record["symlink"].encode() if record["mode"] == "120000" else path.read_bytes()
        result = subprocess.run(["git", "hash-object", "-w", "--stdin"], input=data,
                                cwd=repository, capture_output=True, check=True)
        object_id = result.stdout.strip().decode("ascii")
        key = path.relative_to(repository).as_posix()
        records.extend(f'{record["mode"]} {object_id}\t{key}\0'.encode())
    subprocess.run(["git", "update-index", "-z", "--index-info"], input=records,
                   cwd=repository, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", nargs=2, type=Path)
    parser.add_argument("--stage", action="store_true")
    args = parser.parse_args()
    products = [unpack(path) for path in args.archives]
    if {root.name for root, manifest in products} != PROFILES:
        raise RuntimeError("Synchronize Windows x64 and Mac ARM64 together.")
    for root, manifest in products:
        if args.stage:
            stage(root, manifest)
        print(f'Synchronized {root.name}: {len(manifest["files"])} files')


if __name__ == "__main__":
    main()
