#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUILD_SERVER=${THRUHOLDD_BUILD_SERVER:-"$ROOT/server"}
LIBZT_INCLUDE_DIR=${LIBZT_INCLUDE_DIR:-}
LIBZT_LIB_DIR=${LIBZT_LIB_DIR:-}
GOOS=${GOOS:-$(go env GOOS)}
GOARCH=${GOARCH:-$(go env GOARCH)}
BUILD_REVISION=${BUILD_REVISION:-$(git -C "$ROOT" rev-parse --verify HEAD)}

if [[ -z "$LIBZT_INCLUDE_DIR" || -z "$LIBZT_LIB_DIR" ]]; then
	printf 'Set LIBZT_INCLUDE_DIR and LIBZT_LIB_DIR to a built libzt installation.\n' >&2
	exit 2
fi
if [[ ! -f "$LIBZT_INCLUDE_DIR/ZeroTierSockets.h" || ! -f "$LIBZT_LIB_DIR/libzt.so" ]]; then
	printf 'Expected ZeroTierSockets.h and libzt.so under the configured libzt directories.\n' >&2
	exit 2
fi
if [[ ! -d "$BUILD_SERVER" ]]; then
	printf 'THRUHOLDD_BUILD_SERVER must point at a prepared external server build directory.\n' >&2
	exit 2
fi

OUT=${THRUHOLDD_OUT:-"$BUILD_SERVER/bin"}
mkdir -p "$OUT"
(
	cd "$BUILD_SERVER"
	CGO_ENABLED=1 GOOS="$GOOS" GOARCH="$GOARCH" \
		CGO_CFLAGS="-I$LIBZT_INCLUDE_DIR ${CGO_CFLAGS:-}" \
		CGO_LDFLAGS="-L$LIBZT_LIB_DIR -lzt -lstdc++ ${CGO_LDFLAGS:-}" \
		go build -buildvcs=false -trimpath -tags zerotier \
		-ldflags="-s -w -X main.buildRevision=$BUILD_REVISION" \
		-o "$OUT/thruholdd" ./worldd
)
printf 'Built %s/thruholdd with default ZeroTier network e3918db4832a3056.\n' "$OUT"
