"""Download and unpack the pinned codec samples read by verify_smoke.py --codec-matrix."""
import argparse
import json
import tarfile
from pathlib import Path

from build_runtime import TOOLS, download


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    pin = json.loads((TOOLS / "codec-samples.json").read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)
    with tarfile.open(download(pin["url"], pin["sha256"]), "r:gz") as stream:
        stream.extractall(args.output, filter="data")
    print(f"Unpacked {len(list(args.output.iterdir()))} samples to {args.output}")


if __name__ == "__main__":
    main()
