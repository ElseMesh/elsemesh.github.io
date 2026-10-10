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
The owner reports a `/16` IPv4 range and 6PLANE enabled, and confirmed in
ZeroTier Central that the network is public. A native client previously
received `172.22.194.239/16`, indicating the managed range `172.22.0.0/16`.
The exact current managed route and flow rules could not be read back from
Central on 2026-10-04 because the locally stored API token returned HTTP 403.
The Legacy API's `physicalAddress` is the IP address the member last spoke
to the controller through ([API schema](https://docs.rs/zerotier-central-api/latest/zerotier_central_api/types/struct.Member.html)); it is not a list of all peer paths or a hole-punching guarantee. A blank Central field means no such address is currently recorded for that member. A successful local join and 6PLANE assignment do not by themselves prove that Central's member record has a physical address.

The packaged daemon name is `thruholdd`. A ZeroTier-enabled build defaults to
this network without a network-ID argument. `--zerotier-network` remains an
operator override for testing; use the existing `xellent` network only when
explicitly testing that separate `/24` LAN. After
Central API access is restored, record the exact IPv4 CIDR and confirm its
managed route and flow rules here. Verify that the `/16` route does not capture
traffic intended for a user's existing private network.

The Legacy Central API token at `~/.config/zerotier/central-api-token` is an
administration credential, not a runtime setting. Keep it owner-readable only
(mode `0600`), do not copy it into a repository or world/client configuration,
and do not include it in command output or logs. The locally available token
returned HTTP 403 for read-only requests to the documented Legacy API endpoint
on 2026-10-04, as it did in the earlier 2026-10-03 check. This points to a
credential/account access problem; it does not establish that the network
settings changed. Generate a working Legacy API token in Central and replace
the local file without sharing the token in chat or source control.

The last recorded flow-rule inspection found TCP destination port `42901` in
the allow list for `worldd`'s libp2p listener, while the existing final UDP
rule allowed QUIC traffic on UDP `42901`. Preserve the other existing service
rules. Because the current Central API credential is rejected, treat this as
the last known configuration, not a verified current snapshot.

If Central is using templated flow rules, add custom allowances for both TCP
and UDP destination port `42901` (or the configured `--p2p-port`). If the UDP
catch-all has been removed, do not open all UDP for ElseMesh. For the advanced
custom rules engine, do not assume connection tracking: ZeroTier documents
that custom rules are stateless. TCP replies need the documented SYN/ACK
whitelisting pattern, and UDP request/reply policy needs deliberate handling
for both directions, preferably scoped to the intended members/tags. A lone
UDP destination-port rule can allow requests while dropping replies. See the
[ZeroTier Rules Engine guide](https://docs.zerotier.com/rules/) before editing
custom rules, and verify the final policy in Central. These flow rules apply
only to traffic carried over ZeroTier; they do not open the machine's public
firewall. The browser HTTPS/WSS gateway does not need an overlay rule unless
clients are intentionally connecting to it over ZeroTier.

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
worldd --announce-address /ip6/<this-host-6plane-address>/tcp/42901 \
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
gateway and configure the hosted client to use that gateway. Direct WebRTC may
be used where the client and host can establish a peer path; the public gateway
or an available libp2p relay remains the fallback. Do not expose the Central API
token to a browser.

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
Build libzt for the target platform first, then use the build helper with its
headers and shared library:

```sh
LIBZT_INCLUDE_DIR=/path/to/libzt/include \
LIBZT_LIB_DIR=/path/to/libzt/lib \
THRUHOLDD_BUILD_SERVER=/path/to/external-build/server \
tools/build-thruholdd.sh
```

This builds from the selected external source mirror and creates `thruholdd`
under its `bin/` directory. Set `BUILD_REVISION` to the source repository's
current commit when the build mirror's Git metadata is stale. At runtime,
make `libzt.so` available to
the dynamic linker (for example with `LD_LIBRARY_PATH`). The default network
is compiled into the ZeroTier-enabled build, so neither the network ID nor a
special transport flag is needed. Non-libzt `worldd` builds remain available
for development and targets without a supported libzt toolchain.

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
examples. Reproduce it with:

```sh
NDK=/path/to/android-ndk
cmake -S /path/to/libzt -B /path/to/libzt-android-arm64-build \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-26 \
  -DZTS_NDK_ONLY=ON -DBUILD_SHARED_LIB=ON -DBUILD_STATIC_LIB=OFF \
  -DBUILD_HOST_SELFTEST=OFF -DBUILD_HOST_EXAMPLES=OFF \
  -DALLOW_INSTALL_TARGET=OFF -DZTS_DISABLE_CENTRAL_API=ON
cmake --build /path/to/libzt-android-arm64-build --target zt-shared --parallel
```

The resulting `libzt.so` is an AArch64 Android shared library and depends
only on Android system libraries. Build `thruholdd` against that library and
the matching NDK compiler with:

```sh
LIBZT_INCLUDE_DIR=/path/to/libzt/include \
LIBZT_LIB_DIR=/path/to/android-arm64/lib \
THRUHOLDD_BUILD_SERVER=/path/to/prepared/external/server-build \
GOOS=android GOARCH=arm64 \
CC=/path/to/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android26-clang \
CXX=/path/to/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android26-clang++ \
tools/build-thruholdd.sh
```

The build helper omits the Linux `libstdc++` linker flag on Android and applies
the Go linker compatibility option needed by the Android network-interface
dependency. Keep `libzt.so` beside the resulting `thruholdd` binary when
running it.

On the Flip7, two temporary `thruholdd` processes with separate libzt state
directories joined network `e3918db4832a3056`. They received distinct 6PLANE
addresses, dialed each other over the 6PLANE TCP path, and each reported one
DHT peer. This verifies Android arm64 loading and a successful libzt-backed
peer connection on one device. It does not establish connectivity between
different devices or different NATs, and it did not exercise the game
renderer. Test identities and files were kept under Termux `$PREFIX/tmp`; no
permanent phone identity was created or changed.

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

During that attempt, `/var/log/fw.log` recorded outbound UDP/9993 drops on
`OUT=spod` at 19:40:55 and 19:41:00, including packets to ZeroTier root
`103.195.103.66`. The local nftables output chain intentionally drops general
traffic on `spod`; this explains why this execution environment could not
complete the peer test, and is not evidence that native ZeroTier One is needed
or that the public network is misconfigured. No firewall exception was left in
place. The remaining tests are:

1. Repeat a real `thruholdd` peer dial on two ordinary hosts and verify
   connection establishment plus sustained bidirectional traffic.
2. Repeat from separate NATs and record whether the path is direct or relayed.
3. Add and test managed IPv4 support in libzt; current `thruholdd` uses 6PLANE
   IPv6 only.
4. Read back and verify Central flow rules for inner TCP peer traffic and
   replies.
5. Test browser gateway/WebRTC access and relay fallback without ZeroTier in
   the browser.
6. Confirm operation while the Central API is unavailable.
7. Check the game renderer and visual quality on the Flip7; the completed
   Android test above exercised only the headless daemon.
