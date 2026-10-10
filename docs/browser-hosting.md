# Browser-hosted ThruHolds

## Current capability

The browser client is still a visitor: it has no owner-facing host controls or
browser-host worker. `WorldConnector` opens an outbound WebSocket or
WebTransport connection to a Go `worldd` gateway; the daemon serves the signed
manifest and assets, or forwards requests to an authorized libp2p peer. The
gateway now accepts authenticated reverse-host WebSocket sessions at
`/browser-host`, serves their owner-signed manifest, and forwards bounded asset
requests. This server-side protocol does not yet make browser hosting available
in the shipped client. The client also has no `RTCPeerConnection` transport.
A browser cannot open the ordinary TCP or UDP listeners used by `worldd`, so a
static GitHub Pages deployment by itself cannot make a browser tab reachable
as a server from arbitrary networks.

This distinction matters for availability: a browser-only host can serve a
world only while its tab is open, but peers still need a reachable rendezvous
and request-forwarding path to that tab. Until the owner worker and its UI are
implemented, users need a standalone `thruholdd` or an independently operated
gateway-connected owner/cache node.

## Reverse-host gateway protocol

The initial gateway endpoint is WebSocket-only. A host connects to the
gateway's `wss://<origin>/browser-host` endpoint. The gateway sends a fresh
32-byte nonce in `host.challenge`. The host registers one world by sending its
owner-signed `tidewater.world/1` document and a base64 signature over the UTF-8
message `elsemesh.browser-host/1\n<worldId>\n<nonce>`. The gateway verifies the
world document, checks that its signer owns the world, verifies the
nonce-bound proof, and replies `host.registered`. Reusing a proof with another
nonce fails.

An active host sends `host.heartbeat` with its world ID at least every 45
seconds. Visitors can discover its owner PeerID through that gateway's
`/api/lookup` response or pin the owner PeerID in an invite. The ordinary
`/gateway` and WebTransport visitor handshake then routes `manifest.get` to the
registered signed document and forwards declared `asset.get` chunks to the
host as `host.request` frames. Hosts answer with matching `host.response`
frames. The gateway rejects undeclared assets, ranges outside the signed asset
size, oversized chunks, duplicate request IDs and mismatched response IDs.

The gateway limits a daemon to 128 active browser-host sessions, four hosts
per world, 32 pending requests per host and 192 KiB per asset chunk. Host
registration has a 15-second deadline, requests have a 20-second deadline,
and a host with no heartbeat for 45 seconds is removed. A same-owner
re-registration replaces that owner's session. Browser-host presence messages,
owner UI/worker integration, deployed public gateway operation and WebRTC are
not implemented yet; the current gateway relay supports signed manifest and
asset retrieval only.

## Intended browser-host mode

The first browser-host implementation should use the same signed manifest,
asset hashes, world rules, and gateway request messages as standalone worlds.
It should not introduce a second world format or require a ZeroTier client.

1. The owner selects or imports a packaged ThruHold in the client. The client
   verifies the signed manifest and every asset before making the package
   available. World editing and signing remain owner-authorized operations.
2. A dedicated Web Worker owns the package session and opens an outbound secure
   WebSocket to a configured, public ElseMesh gateway. The worker sends a
   heartbeat and answers bounded manifest, asset-chunk, and supported live
   presence requests for its world.
3. The gateway authenticates the worker against the world owner key and a
   fresh challenge. It routes visitor requests to the active worker, applies
   per-world and per-session quotas, and closes expired registrations. It
   relays requests; it does not become the world owner or acquire signing
   authority.
4. Visitors keep using `WorldConnector`, so portal lookup, destination entry
   rules, previews, and asset-hash verification stay the same. The invite names
   the world and its reachable gateway. When the owner tab closes or loses its
   connection, the gateway marks this host offline; it must not imply that the
   world remains available.

This baseline uses browser-native APIs and does not require WASM. It does
require a public gateway that supports authenticated reverse connections and
request forwarding. A gateway can be operated by the world owner or a
community member; it must not become a mandatory central world directory.
Portal relationships continue to identify worlds organically. They do not by
themselves provide a network route through NAT.

## Direct peer transport

WebRTC data channels may later reduce gateway bandwidth when two browsers or a
browser and a daemon can connect directly. This needs an implemented signaling
exchange, ICE/STUN configuration, and a TURN or gateway relay fallback for
networks where direct ICE fails. The invite or portal identifies the intended
world; signaling exchanges temporary connection data and does not grant world
access. The gateway-forwarded WebSocket path remains the compatibility path.

WebRTC is not implemented in the current client. Do not describe browser-to-
world direct WebRTC as a supported path until browser-engine tests prove
signaling, authenticated channel setup, request/reply framing, disconnection,
and relay fallback.

## Security and lifecycle requirements

- Never send a ZeroTier Central API credential, node private key, or world
  signing key to the gateway. The browser must prove owner authority using a
  nonce-bound signature, and the gateway must validate against the signed
  manifest's owner identity.
- Limit host requests to declared, hash-verified manifest assets and explicitly
  supported runtime messages. Never execute downloaded JavaScript as world
  authority.
- Bind a host session to one world, one authenticated owner, and an expiring
  session nonce. Prevent replay, cross-world routing, and one host session from
  replacing another without an owner-approved handover.
- Bound request size, concurrency, asset chunk size, memory, and CPU. Handle a
  suspended tab, lost network, worker crash, owner logout, and browser shutdown
  as host unavailability.
- Keep owner key recovery and backups explicit. A browser profile is not a
  durable server backup; recommend a standalone daemon or authorized cache for
  persistent availability.

## Acceptance checks

Verify that an owner can start and stop browser hosting, that the host appears
online only while its tab is connected, and that a second browser can fetch and
verify the signed manifest and assets through the gateway. Check malformed and
replayed owner proofs, expired sessions, cross-world requests, quotas, tab
suspension, owner handover, and reconnect behavior. Repeat with a ThruHold portal
and with gateway failure. Test direct WebRTC separately only after its signaling
and relay paths exist. Public hosting claims require tests against a deployed
HTTPS/WSS gateway from a network outside the developer machine.

## Current implementation validation

The gateway integration tests cover owner proof, replay rejection, provider
lookup, signed manifest retrieval, declared asset range forwarding, chunk-size
checks, and removal after disconnect. `go test ./...` and the Linux
`thruholdd` build pass. The Android arm64 libzt build also ran on the Flip7:
`--version` reported revision `2a89a63`, and two isolated `--print-node-id`
starts reused the same identity. This did not join ZeroTier, exercise a public
gateway, or verify Flip7 client rendering.
