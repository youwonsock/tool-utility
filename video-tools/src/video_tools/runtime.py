"""Resources and client commands belonging to the tool folder."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from video_tools.platforms import current, profile

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ROOT = ROOT / "portable" / profile


def python_executable() -> Path:
    relative = "python/python.exe" if profile == "windows-x64" else "python/bin/python3.14"
    return RUNTIME_ROOT / relative


def bundled_ffmpeg() -> Path:
    return RUNTIME_ROOT / "media" / ("ffmpeg" + current.executable_suffix)


def require_runtime() -> None:
    manifest = RUNTIME_ROOT / "manifest.json"
    for path in (python_executable(), bundled_ffmpeg(), manifest):
        if not path.is_file():
            raise RuntimeError(f"필수 동봉 파일이 없습니다: {path}. 저장소를 다시 clone하세요.")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    if data.get("profile") != profile or data.get("python") != "3.14.8":
        raise RuntimeError("동봉 런타임 버전 또는 플랫폼이 올바르지 않습니다. 저장소를 다시 clone하세요.")
    if Path(sys.executable).resolve() != python_executable().resolve():
        raise RuntimeError("run.bat 또는 run_mac.command로 동봉 Python을 실행하세요.")


def default_settings_path() -> Path:
    return current.settings_path(Path.home(), os.environ)


def configuration(workspace: Path) -> dict:
    require_runtime()
    return {"mcpServers": {"video-tools": {
        "command": str(python_executable().resolve()),
        "args": ["-I", "-B", "-X", "utf8", str(ROOT / "launch.py"), "mcp",
                 "--workspace", str(workspace.expanduser().resolve())],
    }}}
