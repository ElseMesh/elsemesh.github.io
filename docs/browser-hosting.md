# Browser-hosted ThruHolds

## Current capability

The browser client can act as a temporary owner host through a dedicated
module worker. In the World tab, choose **Host a world from this browser** and
select a standalone world profile directory containing `world.json`,
`node.key`, and `assets/<sha256>`. The client verifies the owner-signed
manifest, confirms that `node.key` matches its owner key, and hashes every
declared asset before connecting. It then opens the gateway's `/browser-host`
WebSocket and answers bounded asset-range requests from those verified files.
`WorldConnector` continues to serve visitors through a Go `worldd` gateway; the
client still has no `RTCPeerConnection` transport. A browser cannot open the
ordinary TCP or UDP listeners used by `worldd`.

The owner key is read locally by the worker and used only to sign the
gateway's fresh challenge. It is never sent to the gateway. The browser host
currently accepts profiles up to 512 MiB and serves only declared assets. The
browser must support the File System Access API or directory upload. A browser
host is online only while its tab is open and active; it is not a durable
replacement for `thruholdd`. The selected gateway must allow the page's origin
and be reachable over WSS from invited visitors. HTTP/WS is permitted only for
localhost development.

Browser hosting does not remove the gateway dependency. The gateway must
rendezvous with the browser session and forward asset requests; visitors do
not connect directly to the browser tab. Users who need durable availability
should run `thruholdd` or an authorized cache node.

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
deployed public gateway operation and WebRTC are not implemented; the current
gateway relay supports signed manifest and asset retrieval only.

## Browser-host workflow and limits

The browser host uses the same signed manifest, asset hashes, world rules, and
gateway request messages as standalone worlds. It does not introduce a second
world format or require a ZeroTier client.

1. Prepare the world as a standalone profile with `world.json`, `node.key`,
   and its `assets/` directory. For default profiles this is under
   `~/.config/elsemesh/worlds/<profile>`.
2. In the ElseMesh client, open **World → Browser hosting → Host a world from
   this browser** and choose the profile directory. Confirm the key handling,
   then enter the gateway's HTTPS/WSS origin. The worker verifies the signed
   manifest, checks that the key belongs to its owner, and hashes every
   manifest asset before it registers.
3. Keep the tab open. The worker sends heartbeats and answers bounded asset
   range requests. The gateway authenticates it with the fresh challenge and
   relays manifest and asset retrieval to visitors. It does not receive the
   owner's private key or acquire signing authority.
4. Use **Share world invite** while the host status is `Hosting <world>` to
   copy or share a URL containing the world ID, owner PeerID, and selected
   gateway. When the tab closes or disconnects, the gateway removes the host.

Browser hosting uses browser-native APIs and does not require WASM. It does
require a reachable gateway that supports authenticated reverse connections
and request forwarding, and the gateway must allow the website's origin. A
gateway can be operated by the world owner or a community member; it is a
transport rendezvous, not a mandatory central world directory. Current client
support is limited to profiles of 512 MiB or less and declared asset retrieval;
browser-host presence and live world state are not served by this worker.
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
For a community-operated TLS gateway and relay deployment example, see
[`relay-deployment.md`](relay-deployment.md#publish-a-browser-gateway-with-tls).

## Current implementation validation

The browser-host UI and worker now load a profile, verify its signed manifest
and every declared asset, check that the selected `node.key` matches the world
owner, register through the challenge protocol, maintain heartbeats, and serve
bounded asset ranges. `npm test` includes `test/browser-host-client.mjs`, which
builds a temporary `thruholdd` profile and drives the actual worker against a
mock WSS gateway. It checks owner-key matching, declared asset hashes, the
nonce-bound signature, registration and heartbeat messages, and exact bytes
for a requested asset range. The full test suite and Go `worldd` tests pass,
including serving the Example Island and cave as separate portal-linked
worlds. These checks do not yet exercise the owner worker in a real browser
against a deployed public WSS gateway or test a second browser fetching from
it. Flip7 is offline at present, so no device-side graphics check was run.

The gateway integration tests cover owner proof, replay rejection, provider
lookup, signed manifest retrieval, declared asset range forwarding, chunk-size
checks, and removal after disconnect. `go test ./...` and the Linux
`thruholdd` build pass. The Android arm64 libzt build from ElseMesh revision
`0cfcde2`, linked to a libzt build using ZeroTierOne `exp3` commit `be0d1923d`,
ran on the Flip7: `--version` reported that revision, and two isolated
`--print-node-id` starts reused the same temporary identity. This did not join
ZeroTier, exercise a public gateway, or verify Flip7 client rendering; the
phone display was keyguard-locked during this check.
