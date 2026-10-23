#!/bin/sh
set -eu
case "$0" in */*) PATH_TOOL_DIR=${0%/*} ;; *) PATH_TOOL_DIR=. ;; esac
PATH_TOOL_ROOT=$(CDPATH= cd -- "$PATH_TOOL_DIR" && pwd)
unset PYTHONHOME PYTHONPATH DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH
exec "$PATH_TOOL_ROOT/portable/macos-arm64/python/bin/python3.14" -I -B -X utf8 "$PATH_TOOL_ROOT/launch.py" "$@"
