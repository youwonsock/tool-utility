"""Exercise CLI and the real stdio MCP server with the bundled interpreter."""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import io
import json
import os
import platform
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from PIL import Image
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from path_analysis_tools.runtime import require_runtime


def json_result(result):
    if result.isError:
        raise RuntimeError(str(result.content))
    if result.structuredContent is not None:
        return result.structuredContent
    return json.loads(next(item.text for item in result.content if item.type == "text"))


async def check(workspace):
    require_runtime()
    command = [sys.executable, "-I", "-B", "-X", "utf8"]
    environment = {key: value for key, value in os.environ.items()
                   if key not in ("PYTHONHOME", "PYTHONPATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH")}
    environment["PATH"] = ""
    subprocess.run([*command, str(ROOT / "tools/make_example.py"), "--output", str(workspace)], check=True,
                   capture_output=True, env=environment)
    pairs = [("inspect_sheets", "inspect-request.json"), ("calculate_path", "calculate-request.json"),
             ("plan_scene_edits", "edit-request.json"), ("verify_scene_apply", "verify-request.json")]
    cli = {}
    for tool, request in pairs:
        output = subprocess.run([*command, str(ROOT / "launch.py"), "cli", "--workspace", str(workspace), tool, "--input", request],
                                check=True, capture_output=True, text=True, encoding="utf-8", env=environment)
        cli[tool] = json.loads(output.stdout)
    params = StdioServerParameters(command=sys.executable,
        args=["-I", "-B", "-X", "utf8", str(ROOT / "launch.py"), "mcp", "--workspace", str(workspace)], env=environment)
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            listed = await session.list_tools()
            names = {tool.name for tool in listed.tools}
            expected = {"server_info", "inspect_sheets", "read_frame", "calculate_path", "preview_path", "plan_scene_edits", "verify_scene_apply"}
            if names != expected:
                raise RuntimeError(f"Unexpected tools: {names}")
            info = json_result(await session.call_tool("server_info", {}))
            if info["scene_io"] or info["model_io"]:
                raise RuntimeError("Server must not perform model or scene I/O.")
            for tool, request in pairs:
                payload = json.loads((workspace / request).read_text())
                actual = json_result(await session.call_tool(tool, {"request": payload}))
                if actual != cli[tool]:
                    raise RuntimeError(f"CLI/MCP parity failed: {tool}")
            for tool, request in [("read_frame", "frame-request.json"), ("preview_path", "preview-request.json")]:
                payload = json.loads((workspace / request).read_text())
                destination = payload.pop("output")
                image_result = await session.call_tool(tool, {"request": payload})
                if image_result.isError:
                    raise RuntimeError(str(image_result.content))
                item = next(c for c in image_result.content if c.type == "image")
                data = base64.b64decode(item.data)
                with Image.open(io.BytesIO(data)) as image:
                    image.verify()
                (workspace / destination).write_bytes(data)
                cli_result = subprocess.run([*command, str(ROOT / "launch.py"), "cli", "--workspace", str(workspace),
                    tool, "--input", request], check=True, capture_output=True, env=environment)
                if (workspace / destination).read_bytes() != data:
                    raise RuntimeError(f"Image parity failed: {tool}")
            bad = await session.call_tool("read_frame", {"request": {"manifest": "manifest.json", "frame_ref": "synthetic:8"}})
            if not bad.isError:
                raise RuntimeError("Invalid cells must be rejected over MCP.")
            if not any("UNKNOWN_FRAME" in getattr(item, "text", "") for item in bad.content):
                raise RuntimeError("MCP errors must retain the shared contract error code")
            cli_error = subprocess.run([*command, str(ROOT / "launch.py"), "cli", "--workspace", str(workspace),
                "read_frame"], input=json.dumps({"manifest": "manifest.json", "frame_ref": "synthetic:8"}),
                capture_output=True, text=True, encoding="utf-8", env=environment)
            if cli_error.returncode != 2 or json.loads(cli_error.stderr)["error"]["code"] != "UNKNOWN_FRAME":
                raise RuntimeError("CLI errors must retain the shared contract error code")
    return {"status": "passed", "platform": platform.platform(), "python": platform.python_version(),
            "executable": sys.executable, "tools": sorted(expected), "json_parity": len(pairs), "image_parity": 2,
            "path_environment": "empty", "synthetic_reference": True, "shared_error_code": "UNKNOWN_FRAME",
            "source_sha256": {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in sorted([*ROOT.glob('*.py'), *ROOT.glob('*.command'), *ROOT.glob('*.bat'), *(ROOT/'src').rglob('*')])
                if path.is_file() and path.suffix in ('.py', '.command', '.bat', '.json')},
            "real_video_analysis": "not_run", "unity_scene_application": "separate_report"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path)
    parser.add_argument("--workspace", type=Path)
    args = parser.parse_args()
    if args.workspace:
        args.workspace.mkdir(parents=True, exist_ok=True)
        result = asyncio.run(check(args.workspace.resolve()))
    else:
        with tempfile.TemporaryDirectory(prefix="path-analysis-smoke-") as temporary:
            result = asyncio.run(check(Path(temporary)))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key:value for key,value in result.items() if key != 'source_sha256'}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
