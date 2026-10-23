#!/bin/sh
set -eu
case "$0" in */*) PATH_TOOL_DIR=${0%/*} ;; *) PATH_TOOL_DIR=. ;; esac
PATH_TOOL_ROOT=$(CDPATH= cd -- "$PATH_TOOL_DIR" && pwd)
exec "$PATH_TOOL_ROOT/run_mac.command" mcp "$@"
