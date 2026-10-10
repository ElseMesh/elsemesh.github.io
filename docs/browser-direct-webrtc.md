# Direct browser-to-world WebRTC

## Purpose and boundary

The browser should be able to send world requests directly to the selected
`worldd` after the HTTPS/WSS gateway has introduced the peers. The gateway
remains the signaling path and the compatibility transport. A direct data
channel is an optimization and a path for peers whose gateway is not a content
relay; it is not a new identity system or an authorization grant. The client
continues to verify the owner-signed manifest and content hashes, and
`worldd` continues to enforce its world and host rules.

This is a protocol target, not a claim that direct WebRTC currently works. The
existing implementation uses WebTransport and WebSocket through the gateway.

## Connection sequence

1. The client opens the selected gateway and completes the existing `connect`
   handshake for a world and target PeerID. If WebRTC is unavailable or the
   selected target does not advertise support, it keeps the current transport.
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
   SDP answer and a short-lived connection identifier. The gateway carries
   that answer back to the browser without modifying the SDP.
5. The browser applies the answer and waits for the data channel to open. It
   then sends the existing JSON request shapes (`manifest.get`, `asset.get`,
   `presence.update`, and `presence.leave`) directly over the channel. Replies
   use the existing `peerResponse` shape and must match both `worldId` and
   `requestId`.
6. The browser falls back to WebTransport or WebSocket for an individual
   request if direct ICE fails, the channel closes, or the daemon rejects a
   request. Fallback must not duplicate presence updates or accept a late
   response from the abandoned transport.

The initial offer/answer should travel over an existing gateway request rather
than adding an unauthenticated public signaling endpoint. The target's
PeerConnection and data-channel handlers must be bound to the world and the
gateway session that requested the offer. Presence identity must be derived
from that server-side session, as it is for the current gateway path; never
trust a browser-selected presence key.

## ICE and relay behavior

ICE configuration is deployment configuration, not world metadata. A public
STUN service may improve direct-path discovery, but STUN alone cannot relay
traffic or guarantee connectivity through symmetric NATs and restrictive
firewalls. Deployments may configure TURN credentials out of band. TURN
credentials must be short-lived and scoped; they must not be embedded in a
world package, invite URL, source repository, or long-lived client bundle.

The existing HTTPS/WSS gateway remains the relay fallback when ICE fails or
TURN is unavailable. WebRTC failure must not make a world unreachable when its
gateway path still works. ZeroTier remains an optional daemon-to-daemon
transport and does not make a browser join the overlay.

## Limits and safety

- Bound SDP size, offer concurrency, pending setup time, data-channel message
  size, in-flight requests, and per-peer sessions. Close idle or failed peer
  connections and remove their routing/session state.
- Accept only the supported world RPC types. Do not expose arbitrary daemon
  HTTP handlers or filesystem operations over a data channel.
- Validate every request's world ID, request ID, asset declaration, byte
  range, and authorization using the same code path as gateway requests.
- The connection identifier is random, short-lived, and bound to the specific
  offerer, target world, and PeerConnection. It is not a reusable bearer token.
- Do not report a direct connection until ICE reaches `connected` or
  `completed` and a request/reply round trip succeeds.
- Treat browser-hosted worlds separately: their owner worker currently
  registers through a reverse WebSocket. Direct access to a browser-hosted
  owner needs an independently verified browser-worker WebRTC path; the daemon
  gateway remains required for that workflow until such support exists.

## Verification gates

Before advertising direct WebRTC, tests must prove:

1. Browser-engine to `worldd` offer/answer and data-channel request/reply for a
   signed manifest and a hash-verified asset.
2. The browser reaches the intended target PeerID and world, including when
   the signaling gateway is not the world owner.
3. Invalid SDP, mismatched worlds, unauthorized providers, stale connection
   IDs, oversized messages, duplicate request IDs, and unauthorized asset
   ranges are rejected.
4. ICE failure, data-channel closure, and daemon restart recover over the
   existing WebTransport/WebSocket path without hanging a portal load or
   corrupting an asset transfer.
5. Direct ICE is tested across independent NATs. TURN relay is tested where
   configured; gateway fallback is tested with TURN absent. Localhost-only
   Pion tests do not prove internet reachability.
6. A real browser integration test covers the browser APIs and the Linux
   `worldd` build. Android renderer checks remain separate; Flip7 checks must
   wait until the device is available.

See [browser hosting](browser-hosting.md) and
[relay deployment](relay-deployment.md) for the current gateway path and its
deployment limits.
