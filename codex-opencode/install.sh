#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
npm ci --cache "${TMPDIR:-/tmp}/codex-opencode-npm-cache"
npm run build
node scripts/install.mjs "$@"
