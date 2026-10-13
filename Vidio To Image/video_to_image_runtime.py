"""Relocatable bundle resources and client configuration, without UI imports."""
import os
import sys
from pathlib import Path
from platforms import current

def bundled() -> bool:
    return bool(getattr(sys, "frozen", False))

def resource_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))

def bundled_ffmpeg() -> Path:
    return resource_root() / "media" / ("ffmpeg" + current.executable_suffix)

def default_settings_path() -> Path:
    return current.settings_path(Path.home(), os.environ)

def mcp_executable(application: Path | None = None) -> Path:
    if application is None:
        parent = Path(sys.executable).absolute().parent
    elif application.suffix.lower() == ".app":
        parent = application / "Contents/MacOS"
    else:
        parent = application if application.is_dir() else application.parent
    return parent / ("video-tools-mcp" + current.executable_suffix)

def configuration(workspace: Path, executable: Path | None = None) -> dict:
    if executable is not None or bundled():
        server = executable or mcp_executable()
        if "AppTranslocation" in server.parts:
            raise ValueError("실제 배포본 위치를 선택하세요. Mac의 임시 실행 경로는 MCP 설정에 저장할 수 없습니다.")
        if not server.is_file():
            raise FileNotFoundError(f"MCP 실행 파일을 찾을 수 없습니다: {server}")
        command, args = str(server.absolute()), []
    else:
        command = str(Path(sys.executable).absolute())
        args = [str(Path(__file__).resolve().with_name("video_to_image_mcp.py"))]
    args += ["--workspace", str(workspace.expanduser().resolve())]
    return {"mcpServers": {"video-tools": {"command": command, "args": args}}}

