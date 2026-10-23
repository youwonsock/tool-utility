"""Portable runtime selection and generic MCP client configuration."""
from __future__ import annotations

import json
import platform
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def profile():
    machine = platform.machine().lower()
    if sys.platform == "win32" and machine in ("amd64", "x86_64"):
        return "windows-x64"
    if sys.platform == "darwin" and machine in ("arm64", "aarch64"):
        return "macos-arm64"
    raise RuntimeError("Portable launchers support Windows x64 and Mac Apple Silicon.")


def executable():
    name = profile()
    relative = "python/python.exe" if name == "windows-x64" else "python/bin/python3.14"
    return ROOT / "portable" / name / relative


def require_runtime():
    manifest = ROOT / "portable" / profile() / "manifest.json"
    if not manifest.is_file() or not executable().is_file():
        raise RuntimeError("Portable runtime is missing; keep the complete tool folder together.")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    if data.get("product") != "path-analysis-tools" or data.get("profile") != profile():
        raise RuntimeError("Invalid runtime manifest.")
    if Path(sys.executable).resolve() != executable().resolve():
        raise RuntimeError("Use the bundled run launcher or install the Python package explicitly.")


def configuration(workspace):
    require_runtime()
    return {"mcpServers": {"path-analysis-tools": {
        "command": str(executable().resolve()),
        "args": ["-I", "-B", "-X", "utf8", str(ROOT / "launch.py"), "mcp", "--workspace", str(Path(workspace).expanduser().resolve())]
    }}}
