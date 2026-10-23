"""Export schemas plus a runnable synthetic, host-neutral example workspace."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from path_analysis_tools.schema_catalog import SCHEMAS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    schema_root = ROOT / "src/path_analysis_tools/schemas"
    for name, schema in SCHEMAS.items():
        destination = schema_root / f"{name}.schema.json"
        text = json.dumps(schema, ensure_ascii=False, indent=2) + "\n"
        if args.check:
            if destination.read_text(encoding="utf-8") != text:
                raise RuntimeError(f"Schema export is stale: {name}")
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(text, encoding="utf-8")
    print(f"{len(SCHEMAS)} schema exports {'verified' if args.check else 'written'}")


if __name__ == "__main__":
    main()
