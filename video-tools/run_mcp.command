#!/bin/bash
set -e
VIDEO_TOOLS_ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)"
if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Only Mac Apple Silicon is supported." >&2
    exit 1
fi
if [[ "$(uname -m)" != "arm64" && "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" != "1" ]]; then
    echo "Only Mac Apple Silicon is supported. Intel Mac is unsupported." >&2
    exit 1
fi
VIDEO_TOOLS_PYTHON="$VIDEO_TOOLS_ROOT/portable/macos-arm64/python/bin/python3.14"
if [[ ! -x "$VIDEO_TOOLS_PYTHON" ]]; then
    echo "Required bundled Python is missing. Download and extract the whole video-tools folder." >&2
    exit 1
fi
exec "$VIDEO_TOOLS_PYTHON" -I -B -X utf8 "$VIDEO_TOOLS_ROOT/launch.py" mcp "$@"
