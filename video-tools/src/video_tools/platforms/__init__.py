"""Select the supported OS adapter without importing GUI or MCP libraries."""
import platform
import sys

if sys.platform == "win32" and platform.machine().lower() in {"amd64", "x86_64"}:
    from . import windows as current
    profile = "windows-x64"
elif sys.platform == "darwin" and platform.machine().lower() in {"arm64", "aarch64"}:
    from . import macos as current
    profile = "macos-arm64"
else:
    raise RuntimeError("Windows x64와 Mac Apple Silicon만 지원합니다.")
