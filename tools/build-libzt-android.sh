#!/usr/bin/env bash
set -euo pipefail

ELSEMESH_SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
case "$ELSEMESH_SOURCE" in
	/mnt/kingston/@home/*)
		relative=${ELSEMESH_SOURCE#/mnt/kingston/@home/}
		parent=${relative%/*}
		DEFAULT_LIBZT_SOURCE="/mnt/kingston/@home/$parent/libzt"
		DEFAULT_ZEROTIERONE_SOURCE="/mnt/kingston/@home/$parent/ZeroTierOne"
		DEFAULT_BUILD_ROOT="/mnt/kingston/builds/$parent/libzt.build"
		;;
	*)
		DEFAULT_LIBZT_SOURCE=
		DEFAULT_ZEROTIERONE_SOURCE=
		DEFAULT_BUILD_ROOT=
		;;
esac

LIBZT_SOURCE_ROOT=${LIBZT_SOURCE_ROOT:-$DEFAULT_LIBZT_SOURCE}
ZEROTIERONE_SOURCE_ROOT=${ZEROTIERONE_SOURCE_ROOT:-$DEFAULT_ZEROTIERONE_SOURCE}
LIBZT_BUILD_ROOT=${LIBZT_BUILD_ROOT:-$DEFAULT_BUILD_ROOT}
LIBZT_SOURCE_MIRROR=${LIBZT_SOURCE_MIRROR:-$LIBZT_BUILD_ROOT/elsemesh-source}
LIBZT_ANDROID_BUILD=${LIBZT_ANDROID_BUILD:-$LIBZT_BUILD_ROOT/android-arm64-elsemesh-exp3}
ANDROID_NDK_ROOT=${ANDROID_NDK_ROOT:-${ANDROID_NDK_HOME:-}}

if [[ -z "$LIBZT_SOURCE_ROOT" || -z "$ZEROTIERONE_SOURCE_ROOT" || -z "$LIBZT_BUILD_ROOT" || -z "$LIBZT_ANDROID_BUILD" ]]; then
	printf 'Set LIBZT_SOURCE_ROOT, ZEROTIERONE_SOURCE_ROOT, LIBZT_BUILD_ROOT, and LIBZT_ANDROID_BUILD.\n' >&2
	exit 2
fi
if [[ -z "$ANDROID_NDK_ROOT" || ! -f "$ANDROID_NDK_ROOT/build/cmake/android.toolchain.cmake" ]]; then
	printf 'Set ANDROID_NDK_ROOT to an installed Android NDK.\n' >&2
	exit 2
fi

LIBZT_SOURCE_ROOT=$(cd "$LIBZT_SOURCE_ROOT" && pwd -P)
ZEROTIERONE_SOURCE_ROOT=$(cd "$ZEROTIERONE_SOURCE_ROOT" && pwd -P)
LIBZT_BUILD_ROOT=$(realpath -m "$LIBZT_BUILD_ROOT")
LIBZT_SOURCE_MIRROR=$(realpath -m "$LIBZT_SOURCE_MIRROR")
LIBZT_ANDROID_BUILD=$(realpath -m "$LIBZT_ANDROID_BUILD")
case "$LIBZT_SOURCE_MIRROR/" in
	"$LIBZT_BUILD_ROOT/"*) ;;
	*)
		printf 'Refusing to place the libzt source mirror outside its build tree: %s\n' "$LIBZT_SOURCE_MIRROR" >&2
		exit 2
		;;
esac
case "$LIBZT_ANDROID_BUILD/" in
	"$LIBZT_BUILD_ROOT/"*) ;;
	*)
		printf 'Refusing to place Android libzt build output outside its build tree: %s\n' "$LIBZT_ANDROID_BUILD" >&2
		exit 2
		;;
esac
for source in "$ELSEMESH_SOURCE" "$LIBZT_SOURCE_ROOT" "$ZEROTIERONE_SOURCE_ROOT"; do
	source_real=$(realpath -m "$source")
	for output in "$LIBZT_SOURCE_MIRROR" "$LIBZT_ANDROID_BUILD"; do
		case "$output/" in
			"$source_real/"*)
				printf 'Refusing to place libzt build files inside source tree: %s\n' "$output" >&2
				exit 2
				;;
		esac
	done
done
case "$LIBZT_ANDROID_BUILD/" in
	"$LIBZT_SOURCE_MIRROR/"*)
		printf 'Refusing to place libzt build output inside its synchronized source mirror: %s\n' "$LIBZT_ANDROID_BUILD" >&2
		exit 2
		;;
esac
if [[ ! -f "$LIBZT_SOURCE_ROOT/CMakeLists.txt" || ! -f "$ZEROTIERONE_SOURCE_ROOT/node/ECC.hpp" ]]; then
	printf 'Expected libzt and the exp3 ZeroTierOne fork at the configured source paths.\n' >&2
	exit 2
fi

mkdir -p "$LIBZT_SOURCE_MIRROR"
sync_log=$(mktemp /var/tmp/elsemesh-libzt-sync.XXXXXX)
if ! cpto --no-lngit --nogit "$LIBZT_SOURCE_ROOT" "$LIBZT_SOURCE_MIRROR" >"$sync_log" 2>&1; then
	tail -n 80 "$sync_log" >&2
	rm -f "$sync_log"
	exit 1
fi
rm -f "$sync_log"
cmake -S "$LIBZT_SOURCE_MIRROR" -B "$LIBZT_ANDROID_BUILD" \
	-DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_ROOT/build/cmake/android.toolchain.cmake" \
	-DZTS_ZEROTIERONE_SOURCE_DIR="$ZEROTIERONE_SOURCE_ROOT" \
	-DANDROID_ABI=arm64-v8a \
	-DANDROID_PLATFORM=android-26 \
	-DZTS_NDK_ONLY=ON \
	-DBUILD_SHARED_LIB=ON \
	-DBUILD_STATIC_LIB=OFF \
	-DBUILD_HOST_SELFTEST=OFF \
	-DBUILD_HOST_EXAMPLES=OFF \
	-DALLOW_INSTALL_TARGET=OFF \
	-DZTS_DISABLE_CENTRAL_API=ON
cmake --build "$LIBZT_ANDROID_BUILD" --parallel "${BUILD_JOBS:-2}"

LIBRARY="$LIBZT_ANDROID_BUILD/lib/libzt.so"
if [[ ! -s "$LIBRARY" ]]; then
	printf 'Android libzt build completed without producing %s\n' "$LIBRARY" >&2
	exit 1
fi
file "$LIBRARY"
printf 'Built libzt from %s using ZeroTierOne %s; outputs are under %s\n' \
	"$LIBZT_SOURCE_ROOT" "$(git -C "$ZEROTIERONE_SOURCE_ROOT" rev-parse --short HEAD 2>/dev/null || printf unknown)" "$LIBZT_ANDROID_BUILD"
