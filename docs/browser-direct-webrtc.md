# Direct browser-to-world WebRTC

## Purpose and boundary

The browser should be able to send world requests directly to the selected
`worldd` after the HTTPS/WSS gateway has introduced the peers. The gateway
remains the signaling path and the compatibility transport. A direct data
channel is an optimization and a path for peers whose gateway is not a content
relay; it is not a new identity system or an authorization grant. The client
continues to verify the owner-signed manifest and content hashes, and
`worldd` continues to enforce its world and host rules.

The browser client and daemon now implement this initial path. A real headless
Chromium test uses a loopback signaling gateway separate from the target
`worldd`, retrieves the target's signed manifest and a hash-verified asset over
the data channel, then closes the channel and confirms manifest retrieval falls
back through the gateway. This proves browser API and local peer-routing
interoperability; it does not prove connectivity across NATs or a public
deployment.

## Connection sequence

1. The client opens the selected gateway and completes the existing `connect`
   handshake for a world and target PeerID. The gateway returns configured
   STUN URLs. If WebRTC is unavailable or the selected target rejects the offer,
   the client keeps the current transport.
2. The browser creates an ordered, reliable `elsemesh-world-v1` data channel
   and a WebRTC offer. It completes ICE gathering before sending the offer;
   the first version uses non-trickle ICE so signaling remains one bounded
   request and response.
3. The client sends `webrtc.offer` over its authenticated gateway session. The
   gateway forwards the request to the selected PeerID using the existing
   authenticated libp2p route. A gateway must not answer on behalf of a target
   that it cannot reach or that does not own/host the requested world.
4. The target daemon validates the world and peer route, creates a bounded
   PeerConnection, applies the offer, waits for ICE gathering, and returns the
   SDP answer. The gateway carries that answer back to the browser without
   modifying the SDP. A random server-side session identifier is used only for
   cleanup; it is not exposed as a bearer credential.
5. The browser applies the answer and waits for the data channel to open. It
   then sends the existing JSON request shapes (`manifest.get`, `asset.get`,
   `presence.update`, and `presence.leave`) directly over the channel. Replies
   use the existing `peerResponse` shape and must match both `worldId` and
   `requestId`.
6. The browser falls back to WebTransport or WebSocket if setup fails. Safe
   read requests (`manifest.get`, `role-revocations.get`, and `asset.get`) are
   retried through the gateway if the data channel closes before a response.
   Mutating presence updates are never retried after an ambiguous disconnect;
   this avoids applying the same sequence twice. Late responses on the closed
   channel have no matching pending request and are ignored.

The initial offer/answer should travel over an existing gateway request rather
than adding an unauthenticated public signaling endpoint. The target's
PeerConnection and data-channel handlers must be bound to the world and the
gateway session that requested the offer. Presence identity must be derived
from that server-side session, as it is for the current gateway path; never
trust a browser-selected presence key.

## ICE and relay behavior

ICE configuration is deployment configuration, not world metadata. Add one or
more `--webrtc-stun-server stun:<host>:<port>` options to the gateway and target
`worldd` processes. STUN can improve direct-path discovery, but cannot relay
traffic or guarantee connectivity through symmetric NATs and restrictive
firewalls. TURN credentials are not currently configurable; the existing
HTTPS/WSS gateway is the fallback relay. Never put relay credentials in a world
package, invite URL, source repository, or long-lived client bundle.

The daemon limits its local ICE sockets to UDP ports `42950` through `43049` by
default. These bounds can be changed with `--webrtc-udp-port-min` and
`--webrtc-udp-port-max`; the configured range must contain at least 32 ports.
If direct browser connectivity is desired, allow this UDP destination range on
the host firewall and forward it at the edge router to the daemon. Replies are
stateful. Keep the HTTPS/WSS gateway path available when those ports cannot be
opened; direct WebRTC is opportunistic.

The existing HTTPS/WSS gateway remains the relay fallback when ICE fails or
TURN is unavailable. WebRTC failure must not make a world unreachable when its
gateway path still works. ZeroTier remains an optional daemon-to-daemon
transport and does not make a browser join the overlay.

## Limits and safety

- Bound SDP size, offer concurrency, pending setup time, data-channel message
  size, in-flight requests, and per-peer sessions. Close idle or failed peer
  connections and remove their routing/session state.
- The current daemon caps the process at 32 WebRTC sessions and one offer per
  gateway session, allows three concurrent RPCs per data channel, rejects
  duplicate request IDs, and closes idle sessions after two minutes.
- Accept only the supported world RPC types. Do not expose arbitrary daemon
  HTTP handlers or filesystem operations over a data channel.
- Validate every request's world ID, request ID, asset declaration, byte
  range, and authorization using the same code path as gateway requests.
- The random connection identifier stays server-side, is short-lived, and is
  bound to the selected world and PeerConnection. It is not a bearer token.
- Do not report a direct connection until ICE reaches `connected` or
  `completed` and a request/reply round trip succeeds.
- Treat browser-hosted worlds separately: their owner worker currently
  registers through a reverse WebSocket. Direct access to a browser-hosted
  owner needs an independently verified browser-worker WebRTC path; the daemon
  gateway remains required for that workflow until such support exists.

## Verification gates

Before claiming public direct WebRTC reachability, tests must prove:

1. **Passed locally:** headless Chromium uses a separate signaling gateway to
   negotiate with the target daemon, retrieves a signed manifest and
   hash-verified asset, closes the channel, and recovers over gateway fallback.
2. **Passed locally:** signaling through a gateway to a distinct intended
   target PeerID and world. Traversal over independent NATs remains open.
3. Invalid SDP, mismatched worlds, unauthorized providers, stale connection
   IDs, oversized messages, duplicate request IDs, and unauthorized asset
   ranges are rejected.
4. ICE failure, data-channel closure, and daemon restart recover over the
   existing WebTransport/WebSocket path without hanging a portal load or
   corrupting an asset transfer.
5. Direct ICE is tested across independent NATs. TURN relay is tested where
   configured; gateway fallback is tested with TURN absent. Localhost-only
   Pion tests do not prove internet reachability.
6. The real-browser local integration test covers browser APIs and the Linux
   daemon. Android renderer checks remain separate; Flip7 checks must wait until
   the device is available.

See [browser hosting](browser-hosting.md) and
[relay deployment](relay-deployment.md) for the current gateway path and its
deployment limits.
