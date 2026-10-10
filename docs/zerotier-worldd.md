# ZeroTier networking for ElseMesh

## Current test LAN

The existing public test LAN is ZeroTier network `632ea2908569fc9e`, named
`xellent` in ZeroTier Central. It has 6PLANE enabled and its IPv4 managed route
is `10.205.192.0/24`. Keep this network and its rules unchanged; it is a test
network, separate from the dedicated ElseMesh network. Each member receives its own
network-scoped 6PLANE IPv6 address. Use the address reported for that member by
Central or the local ZeroTier client; do not derive peer addresses from the node
ID yourself.

## Dedicated ElseMesh network

The owner created ZeroTier network `e3918db4832a3056` in Central for ElseMesh.
An authenticated Central UI inspection on 2026-10-10 confirmed that it is
public, has 6PLANE enabled, and uses the managed IPv4 route `172.22.0.0/16`.
A native client previously received `172.22.194.239/16`, consistent with that
range. On 2026-10-10, a disposable libzt `thruholdd` identity (`56497525c1`)
also joined and received `172.22.2.36`, within the configured `/16`, plus its
expected 6PLANE address. The host kernel's route lookup for `172.22.2.36`
selected the ordinary `wlo1` default gateway (`192.168.20.1`), confirming that
this userspace libzt address is not installed as a host OS route. The current
implementation advertises and listens on both assigned managed IPv4 and
6PLANE IPv6 addresses, and routes in-prefix IPv4 libp2p TCP dials through
libzt. Live IPv4 peer connectivity remains unverified. The locally
stored Legacy API token still returns HTTP 403; that blocks API reads but does
not prevent checking the settings in Central's web UI.
The Legacy API's `physicalAddress` is the IP address the member last spoke
to the controller through ([API schema](https://docs.rs/zerotier-central-api/latest/zerotier_central_api/types/struct.Member.html)); it is not a list of all peer paths or a hole-punching guarantee. A blank Central field means no such address is currently recorded for that member. A successful local join and 6PLANE assignment do not by themselves prove that Central's member record has a physical address.

The packaged daemon name is `thruholdd`. A ZeroTier-enabled build defaults to
this network without a network-ID argument. `--zerotier-network` remains an
operator override for testing; use the existing `xellent` network only when
explicitly testing that separate `/24` LAN. The `/16` route can overlap with
private networks on a user's device; inspect local routes before relying on
managed IPv4. `thruholdd` reports an assigned managed IPv4 address in startup
logs, advertises its managed IPv4 and 6PLANE IPv6 addresses, and routes managed
IPv4 TCP peer traffic through libzt. IPv4 routing is restricted to the actual
prefix reported by libzt for the joined network; other IPv4 traffic uses the
normal host dialer. Managed IPv4 can overlap a user's local routes, so prefer
6PLANE where address ambiguity prevents reliable routing.

The Legacy Central API token at `~/.config/zerotier/central-api-token` is an
administration credential, not a runtime setting. Keep it owner-readable only
(mode `0600`), do not copy it into a repository or world/client configuration,
and do not include it in command output or logs. A read-only request to the
documented Legacy API endpoint returned HTTP 403 on 2026-10-10; the local file
is still mode `0600`. The saved credential is not accepted, but current network
settings have been checked through the authenticated Central UI. Replacing the
local API credential is not required for world runtime or peer connectivity.
Never share the token in chat or source control.

The 2026-10-10 Central UI inspection confirmed this custom, stateless policy.
It explicitly drops frame types other than IPv4, ARP, and IPv6; its default
action also drops unmatched packets, so only the listed traffic is allowed:

```text
drop not ethertype ipv4 and not ethertype arp and not ethertype ipv6;
accept ethertype arp;
accept ipprotocol tcp and dport 42901;
accept ipprotocol tcp and sport 42901;
accept ipprotocol udp and dport 42901;
accept ipprotocol udp and sport 42901;
accept ipprotocol 1;
accept ipprotocol 58;
```

Both source and destination port rules are required because custom ZeroTier
rules are stateless. This permits the TCP/UDP replies for peer traffic on
`42901`; it is not a public-host firewall rule. The rules were saved and
persisted in Central. If the daemon port changes, update the policy as well.
These rules govern traffic inside the overlay; the host firewall separately
needs to permit libzt's outbound UDP bootstrap/peer traffic over the physical
network. The browser HTTPS/WSS gateway does not need an overlay rule unless
clients intentionally connect to it over ZeroTier.

The configured custom rules are a narrow starting policy for TCP and QUIC on
the default port. Keep any future ports similarly explicit and update both
directions where the rules engine is stateless. See the
[ZeroTier Rules Engine guide](https://docs.zerotier.com/rules/) before changing
the policy. These rules apply only to overlay traffic; they do not open the
machine's public firewall.

Public membership means anyone who knows this network ID may join; application
identity signatures and world permissions must still be enforced by ElseMesh.

## Joining a Linux host to the test LAN

Install and start ZeroTier One using the package for the host, then join the
existing `xellent` public test LAN only when explicitly testing that network:

```sh
sudo zerotier-cli join 632ea2908569fc9e
sudo zerotier-cli listnetworks
```

Because the network is public, a new member does not need manual authorization.
Confirm the network is `OK` and note the 6PLANE IPv6 address assigned to this
host. Do not use a physical/public IP in place of the 6PLANE address for this
path.

`thruholdd` listens for libp2p TCP and QUIC on port `42901` by default (the port
can be changed with `--p2p-port`). Permit TCP and UDP on the chosen peer port
in the network flow rules and the host firewall. TCP carries the TCP transport;
QUIC carries UDP. If using the default, announce the assigned 6PLANE address
when starting it so peers can dial the overlay address:

```sh
thruholdd --announce-address /ip6/<this-host-6plane-address>/tcp/42901 \
  --announce-address /ip6/<this-host-6plane-address>/udp/42901/quic-v1
```

The daemon's TCP and QUIC listeners bind on IPv6 when an IPv6 announce address
is supplied. Use a currently assigned address for that host only. The last
recorded network policy allowed TCP 42901 explicitly and UDP through a broader
existing rule; verify that policy in Central before relying on it. ZeroTier
flow rules are enforced in the distributed network path, so verify the
required peer traffic in both directions. If either transport cannot connect,
check Central's rules and the local OS firewall for the selected port on the
ZeroTier interface.

## Browser access and decentralized world access

Ordinary browsers do not join the ZeroTier LAN. Publish the daemon's HTTPS/WSS
gateway and configure the hosted client to use that gateway. Direct browser
WebRTC is a planned path, not implemented yet; until then browsers use the
gateway. Browser-hosted owner sessions also need a reachable reverse gateway
path and are not implemented yet; see [browser hosting](browser-hosting.md).
Do not expose the Central API token to a browser.

Portal links identify worlds and peers using signed ElseMesh identity. A ZeroTier
address is a transport locator, not proof of ownership or permission. Central
may be unavailable after setup: world identity, portal resolution, and access
authorization must continue to work without a Central API request.

## Embedded libzt transport

### Host firewall for embedded libzt

`worldd`'s libzt node runs ZeroTier in userspace; it does not create a native
`zt...` network interface. The host firewall therefore sees the encrypted
outer UDP packets, not the inner ElseMesh TCP connection. For ordinary hosts,
allow UDP egress to ZeroTier roots on port 9993 and stateful reply traffic.
Direct peer paths also use dynamically negotiated UDP endpoints, so a strict
egress policy may need to permit outbound UDP to peer endpoints; blocking this
can force relay paths or prevent connectivity. Do not open the world's TCP or
UDP peer port on the physical WAN just for libzt. The TCP peer stream is carried
inside ZeroTier. The same `42901` TCP allowance still belongs in ZeroTier
Central's *inner network flow rules* when other overlay members need to reach a
thruholdd listener. See ZeroTier's [corporate firewall guidance](https://docs.zerotier.com/corporate-firewalls/)
and [root server whitelist](https://docs.zerotier.com/whitelist/) for the
outer-path requirements. Native ZeroTier One deployments are different: their
host firewall may need rules on the kernel `zt...` interface for inner peer
traffic.

The development host has an additional local `spod` isolation interface. Its
output chain deliberately drops general UDP from that interface. That is a
property of this host's command-execution environment, not an ElseMesh or
ZeroTier network requirement; do not add a `spod` exception to deployment
firewalls. The system's physical route to ZeroTier roots uses `wlo1`.

`thruholdd` includes libzt and joins the dedicated network by default, without
installing the separate ZeroTier One service or passing `--zerotier-network`.
Keep the source checkout and build tree separate. On this Linux development
machine, sync by copying the source into the independent subdirectory of the
mirrored `.build` tree; do not use a Git-linked build worktree or symlink the
build tree to source. Build libzt for the target platform first. With the
standard sibling layout, the helper discovers `../libzt/include` and the
matching library under the sibling `libzt.build`; set `LIBZT_SOURCE_ROOT`,
`LIBZT_BUILD_ROOT`, or the specific include/library variables only for a
nonstandard installation. When run from the source checkout, the helper selects
the external `independent` build copy automatically; `THRUHOLDD_BUILD_SERVER`
can override the server build directory explicitly.

```sh
mkdir -p /mnt/kingston/builds/rebroad/src/elsemesh.build/independent
cpto --no-lngit --nogit "$HOME/src/elsemesh" /mnt/kingston/builds/rebroad/src/elsemesh.build/independent
BUILD_REVISION="$(git -C "$HOME/src/elsemesh" rev-parse HEAD)" \
"$HOME/src/elsemesh/tools/build-thruholdd.sh"
```

This builds from the selected external source mirror and creates `thruholdd`
under its `bin/` directory. The helper embeds the source checkout's current
commit; set `BUILD_REVISION` explicitly when building from a source snapshot
without Git metadata. It refuses server or output directories that resolve
inside the source checkout. It places the matching `libzt.so` beside the binary
and embeds an `$ORIGIN` runtime search path, so the binary starts without a
separate `LD_LIBRARY_PATH` when both files remain together. The default network
is compiled into the ZeroTier-enabled build, so neither the network ID nor a
special transport flag is needed. Non-libzt `worldd` builds remain available
for development and targets without a supported libzt toolchain. The helper can
be invoked from either the source checkout or its mirrored `.build` tree; both
paths resolve to the same external server and sibling libzt build directories.

The embedded node identity is persisted in
`$XDG_CONFIG_HOME/elsemesh/zerotier/identity.public` and
`identity.secret` (normally `~/.config/elsemesh/zerotier/` on Linux). This
device-wide path is independent of a ThruHold profile or `--data`, so changing
world profiles does not create another ZeroTier node. The private secret file
and its directory are owner-only. `elsemesh-node-id` records the first
successful node ID; if the identity files are lost, incomplete, or produce a
different ID, `thruholdd` now stops instead of silently accepting a new node.
At first startup, existing state at the former default
`~/.config/tidewater/worldd/zerotier/` path is moved into this location so its
node identity is preserved.
Back up the complete `zerotier` directory and restore it with the daemon on a
new installation. Run one libzt-enabled `thruholdd` process per OS user at a
time because they share this device identity and libzt state. A separate
`--zerotier-data` path is available for an explicit second node or isolated
test; using it intentionally creates a different ZeroTier identity.
`thruholdd` waits up to 60 seconds for network membership/configuration, computes its
network-scoped 6PLANE address from its stable ZeroTier node ID, and announces
that address on TCP port 42901. TCP dials to that network's 6PLANE `/40` prefix
go through libzt; inbound connections are bridged to the ordinary libp2p TCP
listener. Other TCP addresses and QUIC/WebSocket/WebTransport/WebRTC keep their
normal paths. The address is a transport locator only; signed identity and
world authorization remain authoritative.

This path requires a libzt build for each target architecture and its native
dependencies. For Android arm64, build `libzt.so` with the Android NDK for
`arm64-v8a` and API 26 or newer, then cross-build `thruholdd` with the matching
NDK compiler. The Android arm64 build and Flip7 daemon validation are recorded
below; this repository does not yet distribute prebuilt libzt libraries.
The build also depends on the licensing terms and notices shipped with the
exact libzt version; keep those notices with distributed builds. Users who
already have ZeroTier One can use the native setup above without cgo. A browser
does not join ZeroTier: it connects through the HTTPS/WSS gateway or supported
browser peer path.

## Build and validation status

Android arm64 was built on Linux with NDK r29 (`29.0.14206865`), ABI
`arm64-v8a`, and minimum API 26. The libzt configuration used
`ZTS_NDK_ONLY=ON`, shared-library output, and disabled host-only tests and
examples. Run `tools/build-libzt-android.sh` from the ElseMesh source checkout
to synchronize the adjacent libzt source into `libzt.build/elsemesh-source`
and build from that mirror against the existing ZeroTierOne `exp3` checkout.
Outputs go to `libzt.build/android-arm64-elsemesh-exp3`; the script rejects
build paths inside ElseMesh, libzt, or ZeroTierOne source trees. It does not
copy ZeroTierOne into `libzt/ext` or link a build tree to a source tree. CMake
reads the existing ZeroTierOne checkout as an input and writes generated files
only into the external build directory. Override `LIBZT_SOURCE_ROOT`,
`ZEROTIERONE_SOURCE_ROOT`, `LIBZT_BUILD_ROOT`, `LIBZT_SOURCE_MIRROR`,
`LIBZT_ANDROID_BUILD`, or `ANDROID_NDK_ROOT` for a different layout. The
equivalent manual CMake commands are:

```sh
NDK=/path/to/android-ndk
BUILD_ROOT=/mnt/kingston/builds/rebroad/src/libzt.build
mkdir -p "$BUILD_ROOT/elsemesh-source"
cpto --no-lngit --nogit /path/to/libzt "$BUILD_ROOT/elsemesh-source"
cmake -S "$BUILD_ROOT/elsemesh-source" -B "$BUILD_ROOT/android-arm64-elsemesh-exp3" \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DZTS_ZEROTIERONE_SOURCE_DIR=/path/to/ZeroTierOne \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-26 \
  -DZTS_NDK_ONLY=ON -DBUILD_SHARED_LIB=ON -DBUILD_STATIC_LIB=OFF \
  -DBUILD_HOST_SELFTEST=OFF -DBUILD_HOST_EXAMPLES=OFF \
  -DALLOW_INSTALL_TARGET=OFF -DZTS_DISABLE_CENTRAL_API=ON
cmake --build "$BUILD_ROOT/android-arm64-elsemesh-exp3" --target zt-shared --parallel
```

This build was validated against the ElseMesh owner's ZeroTierOne `exp3` fork
at commit `be0d1923d88d62f7c9e9499d96a1fb541a870153` (including the Android
thread-affinity fix). Set
`ZTS_ZEROTIERONE_SOURCE_DIR` to the existing checkout; libzt reads its source
directly and writes build outputs only under the external CMake build
directory. No copy or symlink into `ext/ZeroTierOne` is needed. libzt detects
the fork's `node/ECC.hpp` API and selects its C++17, `ZT_Node_Config`, and
ECC-key compatibility path. When the pinned upstream `C25519` API is present
instead, it retains the C++11 and upstream constructor path. The fork also
skips unsupported CPU-affinity pinning on Android (ZeroTierOne commit
`be0d1923d`).

The resulting `libzt.so` is an AArch64 Android shared library and depends
only on Android system libraries. Build `thruholdd` against that library and
the matching NDK compiler with:

```sh
THRUHOLDD_BUILD_SERVER=/path/to/prepared/external/server-build \
THRUHOLDD_OUT=/path/to/prepared/external/server-build/bin/android-arm64 \
GOOS=android GOARCH=arm64 \
CC=/path/to/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android26-clang \
CXX=/path/to/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android26-clang++ \
tools/build-thruholdd.sh
```

The build helper omits the Linux `libstdc++` linker flag on Android and applies
the Go linker compatibility option needed by the Android network-interface
dependency. The helper automatically bundles the matching Android `libzt.so`
beside `thruholdd`; keep both files together when installing it.

On the Flip7, two temporary `thruholdd` processes with separate libzt state
directories joined network `e3918db4832a3056`. They received distinct 6PLANE
addresses, dialed each other over the 6PLANE TCP path, and each reported one
DHT peer. This verifies Android arm64 loading and a successful libzt-backed
peer connection on one device. It does not establish connectivity between
different devices or different NATs, and it did not exercise the game
renderer. Test identities and files were kept under Termux `$PREFIX/tmp`; no
permanent phone identity was created or changed.

On 2026-10-10, a fresh Flip7 node and a Linux `thruholdd` node on this
development host joined `e3918db4832a3056` with distinct ZeroTier IDs and
6PLANE addresses. While the Linux process was running, the Flip7 health
endpoint briefly reported one DHT peer; a later sample returned zero. This is
evidence of an inter-device peer connection, but not a stable/sustained path
or a world/portal asset exchange. The two devices produced the same hash when
their public IPv4 egress responses were compared, so the run does not prove
separate-NAT traversal. The restricted shell timed out joining. Its UDP/9993
packets were logged as `SDROP` on `OUT=spod` at 12:09:23 and 12:09:28 local
time. The same Linux test identity joined when run with host-network access
at 12:09:34; no later matching `spod` UDP/9993 drops appeared in the inspected
log tail. This isolates that failed attempt to the restricted shell's `spod`
policy; it is not a deployment firewall rule and must not be copied into the
host ruleset.

Host `adb devices -l` lists no attached phone, but the Termux ADB client can
connect to the phone's local debug endpoint at `127.0.0.1:5555`. At the latest
screen check Android reported `mWakefulness=Dozing`; the capture was black, so
it did not verify rendering or visual quality. The renderer check still needs
an awake, unlocked phone. The temporary daemon was stopped; the persistent
phone ZeroTier identity was not touched.

On 2026-10-10, `tools/build-thruholdd.sh` was run with no `LIBZT_*` overrides.
It discovered the sibling libzt source and external build, produced the Linux
binary and colocated `libzt.so`, and `ldd` resolved that library through the
binary's `$ORIGIN` path with no `LD_LIBRARY_PATH`. A separate Android arm64
cross-build did the same using the NDK. The installed pair ran on the Flip7
with `LD_LIBRARY_PATH` unset; a temporary daemon joined the default network
and reported its 6PLANE address. This verifies default build discovery,
runtime library loading, and Android network join; it does not establish a
second-device or separate-NAT connection.

After the fork-compatibility changes, a clean 128-step `zt-shared` rebuild
passed with `ZTS_ZEROTIERONE_SOURCE_DIR` pointing directly to the `exp3`
checkout. The generated Ninja rules name source files under that checkout;
all object files and libraries are written under the external libzt build
tree. `thruholdd` was rebuilt against the resulting artifact. `llvm-readelf`
confirmed both outputs are Android AArch64/API 26 binaries; `thruholdd`
depends on `libzt.so` plus Android system libraries.

The rebuilt binaries were then copied to a disposable Termux directory on the
Flip7. Their SHA-256 hashes matched the external build artifacts, and
`thruholdd --version` printed `d8f2eb2017c7892a6b094fe1cab06250f622a0a8`. A
fresh temporary libzt identity (`fb164545f7`) joined network
`e3918db4832a3056` at `fc60:bbbd:e2fb:1645:45f7::1`; `/healthz` returned
`status: ok` with `dhtPeers: 0`. Android still denied libp2p's interface
enumeration (`netlinkrib: permission denied`), while the ZeroTier join and
loopback health endpoint succeeded. The process was stopped and its temporary
identity and files were removed. This validates the new binary on-device, not
peer connectivity, portal transfer, or renderer appearance.

A native Linux amd64 `zt-shared` build and `thruholdd` link also passed with
`ZTS_ZEROTIERONE_SOURCE_DIR` set to the same fork checkout. A disposable Linux
daemon joined the dedicated network as node `17bef5bb87` at
`fc60:bbbd:e217:bef5:bb87::1`; its loopback `/healthz` returned HTTP 200 and
`status: ok` with `dhtPeers: 0`. The daemon was stopped and its temporary
identity removed. This confirms Linux startup and health against the direct
source build, but not peer discovery or public reachability.

That Flip7 runtime smoke used an independent build-tree copy of the same
ZeroTierOne `exp3` commit. The subsequent direct-source CMake build passed,
but it has not been redeployed: the host's next SSH attempt returned `No route
to host`. The direct-source build is compile-verified; its exact artifact has
not received a second device runtime check.

## Remaining validation

An earlier Linux amd64 `thruholdd` build joined the dedicated ElseMesh network;
its disposable node ID was `3af4fd5d50` and it announced 6PLANE address
`fc60:bbbd:e23a:f4fd:5d50::1`. On 2026-10-04, two separate Linux `thruholdd`
processes, each with its
own libzt state directory and ZeroTier identity, both joined public network
`e3918db4832a3056` and received distinct 6PLANE addresses
`fc60:bbbd:e24a:daf7:9c46::1` and `fc60:bbbd:e2f9:9b2:626f::1`. These were isolated test identities using
explicit separate storage paths; normal installations now reuse the single
device-wide identity described above. That earlier Linux pair test failed
before the custom connection adapter was fixed. The later Flip7 test above
confirms that the adapter can establish a peer connection. The managed IPv4
address was not queried through libzt; current `thruholdd` code only uses and
announces the 6PLANE IPv6 address.

During that attempt, `/var/log/fw.log` recorded outbound UDP drops on
`OUT=spod`, including packets to ZeroTier root `103.195.103.66`. The local
nftables output chain intentionally drops traffic on `spod`. A later process
inspection showed that libzt had opened sockets for `thruholdd` on several
interfaces, including both `spod` and the active `wlo1`; the log entries
therefore prove that the `spod`-bound attempts were dropped, but do not prove
that this caused the peer dial to fail. No exception was added to `spod`.

### Latest clean two-device retry (2026-10-10)

The Android arm64 daemon was rebuilt from source revision
`bc0f06b22ea5b46568f73a922bf45352c3977c32` with NDK r29 and the existing
libzt build whose CMake cache points directly to
`/mnt/kingston/@home/rebroad/src/ZeroTierOne`. Its binary and `libzt.so` were
copied to a disposable Termux directory; SHA-256 hashes matched the external
build artifacts. The source `server` directory was synchronized into the
external build tree with `cpto --no-lngit --nogit`; no build-to-source links
were created.

One Linux node and one Flip7 node each used fresh, separate world and libzt
state directories. Both joined `e3918db4832a3056` and returned healthy local
`/healthz` responses. The Linux node was `3af8192ed2` at
`fc60:bbbd:e23a:f819:2ed2::1`; the phone was `fe616aa61f` at
`fc60:bbbd:e2fe:616a:a61f::1`. The phone's bootstrap dial to the Linux
6PLANE TCP address on port `42901` timed out, and both health responses showed
`dhtPeers: 0`. This clean retry does not establish inter-device connectivity.
This retry used the then-current pre-policy state; the Central policy was
checked and saved afterward through the authenticated UI. The timeout does not
identify the cause. Both test daemons and their disposable files were removed
after the run.

### Post-policy peer check and current access state (2026-10-10)

After saving the stateless Central policy documented above, a new Linux node
(`680b1b1a8c`, `fc60:bbbd:e268:b1b:1a8c::1`) and a new Flip7 node
(`af2eb03963`, `fc60:bbbd:e2af:2eb0:3963::1`) joined the dedicated network.
Both local `/healthz` endpoints returned `status: ok`, but the phone's bootstrap
dial to the Linux node at TCP `42901` timed out and both reported
`dhtPeers: 0`. The separate-NAT condition was not established, and this result
does not prove whether Central, host routing, libzt path establishment, or the
network topology caused the failure.

The Linux connection adapter now retains libzt's `zts_connect` return code in
the error even when libp2p's context deadline also fires. This diagnostic was
built for Linux amd64 and Android arm64, and `go test -tags zerotier ./worldd`
passed on Linux. It has not yet been exercised on the Flip7: the current host
has no ADB device listed, and `ssh flip7` resolves to `192.168.192.8` but fails
with `No route to host`; the host's ZeroTier neighbor entry for that address is
incomplete. A Linux-only network-enabled smoke test did join the network as
`077e7872b2` (`fc60:bbbd:e207:7e78:72b2::1`) and returned healthy local status,
but had no bootstrap peer and therefore showed `dhtPeers: 0`.

After that retry, two Linux `thruholdd` processes with fresh, isolated
identities were run on the same host using the final `c303ce6` build-tree
artifact. Both joined the dedicated network as `59eb492c1f`
(`fc60:bbbd:e259:eb49:2c1f::1`) and `a88184b5e8`
(`fc60:bbbd:e2a8:8184:b5e8::1`). The second daemon bootstrapped to the first
using its 6PLANE `/ip6/.../tcp/42901` address, and both `/healthz` responses
reported `dhtPeers: 1`. This verifies a successful libzt-backed daemon peer
connection over 6PLANE on one host. It does not validate different hosts,
separate-NAT traversal, or sustained world-content exchange. The processes and
their test identities were stopped and removed after the check. The executable
and `libzt.so` remained in the external `.build` tree; no build-to-source links
were created.

Use a network-enabled test shell for live libzt checks. A first attempt from the
restricted build shell could not bring the node online; that was a sandbox
network restriction, not evidence of a ZeroTier runtime failure. Source edits
remain under the source tree and binaries under the mirrored external build
tree; the trees are copied/synchronized with `cpto`, not linked together.

### Managed IPv4 implementation and live check (2026-10-10)

`thruholdd` now reads the assigned IPv4 address and prefix from libzt, binds a
libzt IPv4 TCP listener on the configured daemon port, advertises the resulting
`/ip4/.../tcp/...` address, and uses libzt for TCP dials only when the IPv4
destination lies inside that assigned prefix. The 6PLANE IPv6 listener and
route remain enabled. Unit tests cover IPv4/IPv6 address announcements and
invalid-address rejection. Linux amd64 and Android arm64 builds passed, and
`go test -tags zerotier ./worldd` passed on Linux.

In a disposable two-node check, Linux received `172.22.198.191/16` and Flip7
received `172.22.205.137/16`; both also received 6PLANE addresses and reported
both IPv4 and IPv6 TCP multiaddresses. Flip7's bootstrap attempt to the Linux
managed IPv4 address on TCP `42901` timed out. This verifies assignment,
listener startup, and address advertisement, but not IPv4 peer connectivity.
The test ended when the Flip7 went offline. Its disposable test files remain
under Termux's private temporary directory and did not replace the normal
installation or persistent ZeroTier identity. No phone retry is possible
while it is offline. The host could not read `/var/log/fw.log` because sudo
required an unavailable password, so the cause of the timeout is unresolved.

### Managed IPv4 Linux peer check (2026-10-10)

Two Linux `thruholdd` processes using separate temporary world data and libzt
identities joined the same public network. They received
`172.22.248.107/16` and `172.22.159.170/16`; the first node listened on the
flow-rule-allowed TCP port `42901`. The second bootstrapped to the first using
`/ip4/172.22.248.107/tcp/42901`. Both local `/healthz` responses identified
their expected process and reported `dhtPeers: 1`. This verifies a managed
IPv4 TCP connection and bidirectional libp2p peer session on one Linux host.
The test used the allowed port; an earlier attempt using `43901` was invalid
because the Central policy does not allow that port. This does not validate
separate hosts, distinct NATs, or internet relay behavior. Both daemon
processes were stopped and their temporary state removed.

The remaining tests are:

1. Restore Flip7 connectivity to the host, diagnose the post-policy TCP dial,
   then verify the managed IPv4 path on the phone. The same-host Linux peer
   session is now verified.
2. Repeat from separate NATs and record whether the path is direct or relayed.
3. Inspect firewall logs/rules and verify the phone's managed IPv4 peer path.
4. Verify the saved Central flow policy continues to allow the configured
   daemon ports and replies when those ports change.
5. Test browser gateway/WebRTC access and relay fallback without ZeroTier in
   the browser.
6. Confirm operation while the Central API is unavailable.
7. Check the game renderer and visual quality on the Flip7; the completed
   Android test above exercised only the headless daemon.
