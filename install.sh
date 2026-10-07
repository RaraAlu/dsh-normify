#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 22 or newer with npm first." >&2
  exit 1
fi
exec node "$ROOT/scripts/setup.mjs" "$@"
