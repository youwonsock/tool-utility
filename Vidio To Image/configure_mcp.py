"""Generate an absolute-path MCP client entry using the active Python environment."""
import argparse
import json
import sys
from pathlib import Path


def configuration(workspace: Path) -> dict:
    return {"mcpServers": {"video-tools": {
        # Resolving the symlink would select the base Python on Unix and lose
        # the virtual environment containing the MCP dependencies.
        "command": str(Path(sys.executable).absolute()),
        "args": [str(Path(__file__).resolve().with_name("video_to_image_mcp.py")),
                 "--workspace", str(workspace.expanduser().resolve())],
    }}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    content = json.dumps(configuration(args.workspace), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(content, encoding="utf-8")
        print(f"Created {args.output.resolve()}")
    else:
        print(content, end="")


if __name__ == "__main__":
    main()
