"""Portable entry point; resolves only this product's source and runtime."""
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))
sys.dont_write_bytecode = True
for key in ("PYTHONHOME", "PYTHONPATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH"):
    os.environ.pop(key, None)


def main():
    from path_analysis_tools.runtime import configuration, require_runtime
    require_runtime()
    mode = sys.argv[1] if len(sys.argv) > 1 else "help"
    sys.argv = [sys.argv[0], *sys.argv[2:]]
    if mode == "mcp":
        from path_analysis_tools.mcp_server import main as mcp_main
        mcp_main()
        return 0
    if mode == "cli":
        from path_analysis_tools.cli import main as cli_main
        return cli_main()
    if mode == "configure":
        import argparse
        import json
        parser = argparse.ArgumentParser()
        parser.add_argument("--workspace", required=True)
        parser.add_argument("--output")
        args = parser.parse_args()
        value = json.dumps(configuration(args.workspace), ensure_ascii=False, indent=2) + "\n"
        if args.output:
            Path(args.output).write_text(value, encoding="utf-8")
        else:
            print(value, end="")
        return 0
    print("Path Analysis Tools\nrun cli --workspace <folder> server_info\nrun configure --workspace <folder>\nrun mcp --workspace <folder>")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, RuntimeError, ImportError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
