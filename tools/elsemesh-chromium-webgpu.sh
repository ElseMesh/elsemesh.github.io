#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/elsemesh-chromium-webgpu.sh [URL]

Open ElseMesh in a dedicated Chromium app window with WebGPU enabled.
The default URL is https://elsemesh.org/.

Set CHROMIUM to choose the Chromium executable and
ELSEMESH_CHROMIUM_PROFILE to choose its isolated profile directory.
EOF
}

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  usage
  exit 0
fi

url=${1:-https://elsemesh.org/}
chromium=${CHROMIUM:-}
if [[ -z $chromium ]]; then
  for candidate in chromium chromium-browser google-chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      chromium=$(command -v "$candidate")
      break
    fi
  done
fi

if [[ -z $chromium ]]; then
  echo "Chromium was not found. Set CHROMIUM to its executable path." >&2
  exit 1
fi

profile=${ELSEMESH_CHROMIUM_PROFILE:-${XDG_DATA_HOME:-$HOME/.local/share}/elsemesh/chromium-webgpu}
mkdir -p "$profile"

exec "$chromium" \
  --user-data-dir="$profile" \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --disable-extensions \
  --enable-unsafe-webgpu \
  --enable-features=Vulkan \
  --use-vulkan \
  --app="$url"
