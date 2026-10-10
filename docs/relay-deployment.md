# Community bootstrap and relay nodes

ElseMesh can discover a world from its stable world ID and connect to it through
libp2p without a central world directory. New nodes still need an initial route
into the peer mesh. Community-operated bootstrap nodes can provide that route;
nodes that accept circuit-relay reservations can also carry traffic between
peers that cannot establish a direct path. Operate several independently so
the mesh does not depend on one host. No relay or bootstrap node receives world
ownership or portal-editing authority.

## Run a public bootstrap and relay node

Build `worldd` from the `server` directory and install the binary at a stable
path such as `/usr/local/bin/worldd`:

```sh
cd server
go build -o worldd ./worldd
sudo install -o root -g root -m 0755 worldd /usr/local/bin/worldd
```

Run it under a dedicated unprivileged service account. For example, on Debian
or Ubuntu create the account with:

```sh
sudo useradd --system --home-dir /var/lib/elsemesh \
  --shell /usr/sbin/nologin elsemesh
```

Keep its profile
directory persistent and private: it stores the node's private key, the
relay's local starter world, and other daemon state. Do not copy the profile
to another running node; that would duplicate its identity.

For a host with a public address, forward TCP and UDP port `42901` (or the
chosen `--p2p-port`) from the edge firewall/router to the daemon. Allow those
protocols on the host firewall as well. TCP and UDP enable their respective
libp2p transports; circuit-relay streams use the peer connection carrying
them. If ZeroTier is used as an additional transport, see
[zerotier-worldd.md](zerotier-worldd.md) for its separate overlay rules.

Start one node with a persistent named profile:

```sh
worldd \
  --worlds-dir /var/lib/elsemesh/worlds \
  --world-profile community-relay \
  --p2p-port 42901 \
  --dht-mode server \
  --relay-service \
  --http 127.0.0.1:5200
```

The HTTP gateway stays loopback-only here; a relay/bootstrap node does not
need to host a public browser gateway. `--relay-service` enables the libp2p
circuit-relay service, and `--dht-mode server` makes this peer participate in
the ElseMesh DHT namespace. Keep the process supervised and retain the profile
directory across restarts. For systemd, create the `elsemesh` service account
and install this unit as `/etc/systemd/system/elsemesh-relay.service`:

```ini
[Unit]
Description=ElseMesh community bootstrap and relay node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=elsemesh
Group=elsemesh
StateDirectory=elsemesh
StateDirectoryMode=0700
ExecStart=/usr/local/bin/worldd --worlds-dir /var/lib/elsemesh/worlds --world-profile community-relay --p2p-port 42901 --dht-mode server --relay-service --http 127.0.0.1:5200
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Then enable and start it with `sudo systemctl enable --now elsemesh-relay`.
Inspect logs with `journalctl -u elsemesh-relay`.

Read the node's PeerID without starting a second daemon:

```sh
worldd --worlds-dir /var/lib/elsemesh/worlds \
  --world-profile community-relay --print-node-id
```

Publish the reachable transport addresses and PeerID through an out-of-band
channel (for example, the operator's website or a signed community list). Use
the public IP address actually forwarded to this host:

```text
/ip4/<public-ip>/tcp/42901/p2p/<peer-id>
/ip4/<public-ip>/udp/42901/quic-v1/p2p/<peer-id>
```

`--announce-address` accepts literal global-unicast IP addresses, not DNS
multiaddrs. If the public IP changes, update the daemon configuration and
restart it so it advertises the new address. Confirm the PeerID remains the
same after restart. For a host behind NAT, the router must forward the chosen
port; a private LAN address is not a public relay address. When forwarding
through NAT, add both public-IP addresses above to the service command with
repeatable `--announce-address` flags; otherwise the daemon cannot advertise
the router's external IP from its private interface.

## Publish a browser gateway with TLS

`deploy/systemd/elsemesh-gateway.service.example` and
`deploy/caddy/elsemesh-gateway.Caddyfile.example` provide a community-operated
gateway configuration. This is a persistent community node, not a requirement
for each world owner to run a public server. It supports the existing WSS
fallback for browsers and can also seed/relay native libp2p peers. The browser
host remains connected only while its owner tab is open.

Build and install the ordinary Linux daemon from the repository's external
build tree, then install the service example as
`/etc/systemd/system/elsemesh-gateway.service`. Install
`deploy/systemd/elsemesh-gateway.env.example` as the root-owned
`/etc/elsemesh/gateway.env` with mode `0640`, changing the host in both files.
Add each client
origin that should be allowed by repeating `--allow-browser-origin` in
`ExecStart`; the example allows `https://elsemesh.github.io`. The origin is an
exact browser-page origin, without a path. Keep the daemon on
`127.0.0.1:5200`; do not expose that listener directly.

Install the Caddy example into the active Caddyfile and replace its hostname.
It obtains/renews a public TLS certificate, forwards only the daemon's health,
discovery, signed manifest, asset, role-state, proposal, visitor-WebSocket and
browser-host-WebSocket routes, and returns 404 for other paths. Caddy's
`reverse_proxy` supports WebSocket upgrades. The daemon validates browser
origins itself; the proxy must preserve the request `Origin` header. Caddy's
default reverse proxy does this. See the [Caddy reverse proxy
reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Allow TCP 80/443 to Caddy for HTTP/TLS and certificate renewal. Allow TCP and
UDP 42901 to `thruholdd` for native libp2p TCP and QUIC, plus outbound
connections needed for DHT bootstrap and peer discovery. Do not open TCP 5200
to the Internet. The example deliberately omits the optional WebTransport
listener: the WSS fallback works through this proxy, while direct HTTP/3
WebTransport needs its own publicly reachable UDP listener and certificate
configuration. If a host firewall is enabled, add these narrow rules there as
well as at the edge firewall/router.

After installing the service, run `systemctl daemon-reload` and
`systemctl enable --now elsemesh-gateway`; validate Caddy with `caddy validate`
and reload it. Confirm `https://world.example.org/healthz`, then test an
actual browser invite through `wss://world.example.org/gateway` and an owner
tab through `/browser-host` from a network outside the host. A green health
check proves only the HTTP process is reachable; it does not prove DHT
discovery, remote asset retrieval, or relay traversal.

## Configure world nodes

Pass multiple bootstrap and relay addresses so a single unavailable operator
does not isolate new peers. Bootstrap peers seed DHT connectivity; relay peers
provide an alternate path for nodes behind restrictive NAT. These flags are
independent and may point to the same or different community nodes:

```sh
worldd --world-profile island \
  --bootstrap /ip4/<bootstrap-a-ip>/tcp/42901/p2p/<bootstrap-a-peer-id> \
  --bootstrap /ip4/<bootstrap-b-ip>/tcp/42901/p2p/<bootstrap-b-peer-id> \
  --relay /ip4/<relay-a-ip>/tcp/42901/p2p/<relay-a-peer-id> \
  --relay /ip4/<relay-b-ip>/tcp/42901/p2p/<relay-b-peer-id>
```

Repeat these arguments for each candidate. `--relay` configures libp2p
AutoRelay with the listed static relay peers; running `--relay-service` on a
node does not automatically make every other node use it. A node behind NAT
must be able to contact a relay, and that relay must have a reachable public
address. Direct connections and hole punching remain preferred when they work;
the relay is the fallback path.

To find a ThruHold without a directory, its manifest must be discoverable in
the DHT, and the requesting gateway/node must already have a route to DHT
peers. Portals can then name the destination world ID without pinning one
provider PeerID; a gateway connected to the mesh resolves providers and
forwards the browser request. Browser players use an HTTPS/WSS gateway and do
not join the native libp2p or ZeroTier network themselves. Direct WebRTC to a
standalone `worldd` is implemented and verified in loopback Chromium tests; it
uses WSS signaling and falls back to the gateway when ICE or the data channel
fails. Configure `--webrtc-stun-server` on the signaling gateway and target,
then permit/forward the configured UDP ICE range (`42950-43049` by default)
for direct paths. Public NAT traversal remains unverified. The gateway daemon
needs the same bootstrap/relay setup if the world's owner is reachable only
through a circuit relay. Browser-hosted owner sessions and their required
reverse gateway path are described in [browser hosting](browser-hosting.md).

## Checks and limits

Run the automated local check from `server`:

```sh
go test ./worldd -run TestWorlddStaticRelayForwardsToPrivatePeer -count=1
```

It starts a relay-enabled `worldd` option set, a private AutoRelay peer and a
caller, then proves a ping travels on a connection whose multiaddress contains
`/p2p-circuit`. This uses loopback addresses; it validates relay option wiring
and circuit forwarding, not traversal across actual NATs or the public
Internet.

For each operator node, verify the PeerID is stable across a clean restart,
confirm its advertised addresses are reachable from another network, and check
that it remains connected to multiple DHT peers. A gateway or world daemon can
log relay reservation and connection failures; do not treat a successful
`/healthz` response as proof of peer reachability. Test both the direct path
and a forced relay path between separate NATs, then stop one bootstrap or relay
node and confirm another path still works.

This repository supplies the daemon flags, a systemd/Caddy deployment example,
and loopback circuit test; no deployed bootstrap, relay, gateway, DNS, TLS, or
monitoring infrastructure exists yet. The deployment example has not been
validated against a public host; run `caddy validate` after installing it on
the target host. Caddy was not installed in the development environment, so
its parser could not be run here. Public two-NAT relay traversal and
browser-to-world traversal through a remotely deployed relay remain
verification gates. The
mesh must work without the Central API; Central is only an administrative
interface for the optional ZeroTier LAN. Bootstrap peers must use the
ElseMesh-compatible DHT protocol prefix currently set to
`/tidewater/kad/1.0.0`; generic IPFS bootstrap nodes are not interchangeable.

An attempted process-level WSS test with a relay bound only to loopback/LAN
addresses did not obtain an AutoRelay circuit reservation. Those addresses are
not valid public relay candidates, so this topology cannot prove browser
traffic over a circuit. Keep the passing WSS gateway test and the separate
loopback libp2p circuit test as distinct evidence; verify the combined path
against a relay with a genuinely reachable public address.
