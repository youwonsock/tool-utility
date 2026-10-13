#!/bin/sh
set -eu
video_tool_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$video_tool_root/.venv/bin/python" "$video_tool_root/build_portable.py" --package
