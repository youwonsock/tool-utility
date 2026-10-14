"""Shared entry point for the native script launchers."""
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))
for name in ("PYTHONHOME", "PYTHONPATH", "TCL_LIBRARY", "TK_LIBRARY",
             "IMAGEIO_FFMPEG_EXE", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH"):
    os.environ.pop(name, None)
sys.dont_write_bytecode = True


def main() -> int:
    from video_tools.runtime import require_runtime, configuration
    require_runtime()
    mode = sys.argv[1] if len(sys.argv) > 1 else "gui"
    sys.argv = [sys.argv[0], *sys.argv[2:]]
    if mode == "gui":
        from video_tools.gui.app import main as gui_main
        return gui_main()
    if mode == "mcp":
        from video_tools.mcp.server import main as mcp_main
        mcp_main()
        return 0
    if mode == "configure":
        import argparse
        import json
        parser = argparse.ArgumentParser(description="MCP 연결 설정 생성")
        parser.add_argument("--workspace", type=Path, required=True)
        parser.add_argument("--output", type=Path)
        args = parser.parse_args()
        text = json.dumps(configuration(args.workspace), ensure_ascii=False, indent=2) + "\n"
        if args.output:
            args.output.write_text(text, encoding="utf-8")
        else:
            print(text, end="")
        return 0
    raise ValueError("실행 모드는 gui, mcp, configure 중 하나여야 합니다.")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, ImportError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
