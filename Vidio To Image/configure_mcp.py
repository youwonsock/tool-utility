"""Generate an absolute-path MCP client entry using the active Python environment."""
import argparse
import json
import sys
from pathlib import Path
from video_to_image_runtime import configuration


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--executable", type=Path, help="Portable MCP executable")
    args = parser.parse_args()
    content = json.dumps(configuration(args.workspace, args.executable), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(content, encoding="utf-8")
        print(f"Created {args.output.resolve()}")
    else:
        print(content, end="")


if __name__ == "__main__":
    main()
