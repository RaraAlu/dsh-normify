#!/bin/sh
# 旧入口复用跨平台构建命令。
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
npm run build
