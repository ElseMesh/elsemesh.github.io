#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
DEFAULT_LIBZT_BUILD_ROOT=
case "$ROOT" in
	/mnt/kingston/@home/*)
		SOURCE_ROOT=$ROOT
		relative=${ROOT#/mnt/kingston/@home/}
		parent=${relative%/*}
		name=${relative##*/}
		DEFAULT_BUILD_ROOT="/mnt/kingston/builds/$parent/$name.build/independent"
		DEFAULT_LIBZT_BUILD_ROOT="/mnt/kingston/builds/$parent/libzt.build"
		;;
	/mnt/kingston/builds/*/*.build)
		DEFAULT_BUILD_ROOT="$ROOT/independent"
		relative=${ROOT#/mnt/kingston/builds/}
		parent=${relative%/*}
		name=${relative##*/}
		SOURCE_ROOT="/mnt/kingston/@home/$parent/${name%.build}"
		DEFAULT_LIBZT_BUILD_ROOT="/mnt/kingston/builds/$parent/libzt.build"
		;;
	*)
		SOURCE_ROOT=${THRUHOLDD_SOURCE_ROOT:-}
		DEFAULT_BUILD_ROOT=
		;;
esac
SOURCE_ROOT=${THRUHOLDD_SOURCE_ROOT:-$SOURCE_ROOT}
if [[ -z "$SOURCE_ROOT" ]]; then
	printf 'Set THRUHOLDD_SOURCE_ROOT to the source checkout.\n' >&2
	exit 2
fi
SOURCE_ROOT=$(cd "$SOURCE_ROOT" && pwd -P)
BUILD_ROOT=${THRUHOLDD_BUILD_ROOT:-$DEFAULT_BUILD_ROOT}
if [[ -z "$BUILD_ROOT" && -z "${THRUHOLDD_BUILD_SERVER:-}" ]]; then
	printf 'Set THRUHOLDD_BUILD_SERVER (or THRUHOLDD_BUILD_ROOT) to an external build tree.\n' >&2
	exit 2
fi
BUILD_SERVER=${THRUHOLDD_BUILD_SERVER:-"$BUILD_ROOT/server"}
SOURCE_REAL=$(realpath -m "$SOURCE_ROOT")
BUILD_REAL=$(realpath -m "$BUILD_SERVER")
case "$BUILD_REAL/" in
	"$SOURCE_REAL/"*)
		printf 'Refusing to write build output inside source checkout: %s\n' "$BUILD_REAL" >&2
		exit 2
		;;
esac
GOOS=${GOOS:-$(go env GOOS)}
GOARCH=${GOARCH:-$(go env GOARCH)}
LIBZT_SOURCE_ROOT=${LIBZT_SOURCE_ROOT:-"$(dirname "$SOURCE_ROOT")/libzt"}
LIBZT_BUILD_ROOT=${LIBZT_BUILD_ROOT:-$DEFAULT_LIBZT_BUILD_ROOT}
LIBZT_INCLUDE_DIR=${LIBZT_INCLUDE_DIR:-"$LIBZT_SOURCE_ROOT/include"}
case "$GOOS/$GOARCH" in
	linux/amd64) DEFAULT_LIBZT_LIB_DIR="$LIBZT_BUILD_ROOT/linux-amd64/lib" ;;
	linux/arm64) DEFAULT_LIBZT_LIB_DIR="$LIBZT_BUILD_ROOT/linux-arm64/lib" ;;
	android/arm64) DEFAULT_LIBZT_LIB_DIR="$LIBZT_BUILD_ROOT/android-arm64/lib" ;;
	*) DEFAULT_LIBZT_LIB_DIR= ;;
esac
LIBZT_LIB_DIR=${LIBZT_LIB_DIR:-$DEFAULT_LIBZT_LIB_DIR}
BUILD_REVISION=${BUILD_REVISION:-$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD)}
LIBZT_CXX_LIB=${LIBZT_CXX_LIB:-}

if [[ -z "$LIBZT_INCLUDE_DIR" || -z "$LIBZT_LIB_DIR" ]]; then
	printf 'No default libzt build path for %s/%s; set LIBZT_INCLUDE_DIR and LIBZT_LIB_DIR.\n' "$GOOS" "$GOARCH" >&2
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
OUT_REAL=$(realpath -m "$OUT")
case "$OUT_REAL/" in
	"$SOURCE_REAL/"*)
		printf 'Refusing to write build artifacts inside source checkout: %s\n' "$OUT_REAL" >&2
		exit 2
		;;
esac
LDFLAGS="-s -w -X main.buildRevision=$BUILD_REVISION -extldflags=-Wl,-rpath,\$ORIGIN"
if [[ -z "$LIBZT_CXX_LIB" && "$GOOS" != android ]]; then
	LIBZT_CXX_LIB=-lstdc++
fi
if [[ "$GOOS" == android ]]; then
	# github.com/wlynxg/anet uses //go:linkname for Android network APIs.
	LDFLAGS+=' -checklinkname=0'
fi
mkdir -p "$OUT"
(
	cd "$BUILD_SERVER"
	CGO_ENABLED=1 GOOS="$GOOS" GOARCH="$GOARCH" \
		CGO_CFLAGS="-I$LIBZT_INCLUDE_DIR ${CGO_CFLAGS:-}" \
		CGO_LDFLAGS="-L$LIBZT_LIB_DIR -lzt $LIBZT_CXX_LIB -Wl,-rpath,\$ORIGIN ${CGO_LDFLAGS:-}" \
		go build -buildvcs=false -trimpath -tags zerotier \
		-ldflags="$LDFLAGS" \
		-o "$OUT/thruholdd" ./worldd
)
cp -p "$LIBZT_LIB_DIR/libzt.so" "$OUT/libzt.so"
printf 'Built %s/thruholdd and bundled libzt.so (default ZeroTier network e3918db4832a3056).\n' "$OUT"
