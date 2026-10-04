#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SERVER="$ROOT/server"
LIBZT_INCLUDE_DIR=${LIBZT_INCLUDE_DIR:-}
LIBZT_LIB_DIR=${LIBZT_LIB_DIR:-}
GOOS=${GOOS:-$(go env GOOS)}
GOARCH=${GOARCH:-$(go env GOARCH)}
BUILD_REVISION=${BUILD_REVISION:-$(git -C "$ROOT" rev-parse --verify HEAD)}
OUT=${THRUHOLDD_OUT:-}

if [[ -z "$LIBZT_INCLUDE_DIR" || -z "$LIBZT_LIB_DIR" ]]; then
	printf 'Set LIBZT_INCLUDE_DIR and LIBZT_LIB_DIR to a built libzt installation.\n' >&2
	exit 2
fi
if [[ ! -f "$LIBZT_INCLUDE_DIR/ZeroTierSockets.h" || ! -f "$LIBZT_LIB_DIR/libzt.so" ]]; then
	printf 'Expected ZeroTierSockets.h and libzt.so under the configured libzt directories.\n' >&2
	exit 2
fi
if [[ -z "$OUT" ]]; then
	printf 'Set THRUHOLDD_OUT to an output path in the external build tree.\n' >&2
	exit 2
fi

mkdir -p "$OUT"
(
	cd "$SERVER"
	CGO_ENABLED=1 GOOS="$GOOS" GOARCH="$GOARCH" \
		CGO_CFLAGS="-I$LIBZT_INCLUDE_DIR ${CGO_CFLAGS:-}" \
		CGO_LDFLAGS="-L$LIBZT_LIB_DIR -lzt -lstdc++ ${CGO_LDFLAGS:-}" \
		go build -buildvcs=false -trimpath -tags zerotier \
		-ldflags="-s -w -X main.buildRevision=$BUILD_REVISION" \
		-o "$OUT/thruholdd" ./worldd
)
printf 'Built %s/thruholdd with default ZeroTier network e3918db4832a3056.\n' "$OUT"
