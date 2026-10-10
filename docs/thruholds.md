# ThruHolds on ElseMesh

## Goal and trust model

Each ThruHold is a world hosted by an independently operated ElseMesh node on Linux or Android/Termux. ThruHolds connect to one another through portals while remaining independently hosted and governed. Each has a stable `tw-world:` identifier, an owner identity, a signed versioned manifest, and one current authority epoch. Nodes have libp2p PeerIDs. Browser visitors connect to the selected node's HTTPS gateway; the gateway connects to world peers over libp2p. No central service is required for an already-known peer to host a ThruHold.

The current browser is a visitor, not a server. Browser-hosted worlds and direct
WebRTC are target capabilities; neither is implemented. The required browser
host lifecycle, gateway relay, trust checks, and limits are described in
[browser hosting](browser-hosting.md).

The daemon is a transport and content service. The world owner controls the manifest, world rules, and grants. A grant independently enables `content-cache` and/or bounded `failover-authority`; caching never grants write or authority rights. Failover windows for different delegates must not overlap, preventing two owner-authorized delegates from issuing the same next epoch at once. An owner-signed failover window permits a delegate to issue a temporary higher-epoch authority lease when its window opens; the signed lease is bound to the exact host-grant epoch, and the daemon schedules activation even when it started before the window and stops serving the lease when it expires. During a valid lease, a failover-only node can be discovered through DHT or the optional directory and serve the owner-signed manifest; the browser verifies the lease and uses that node as the current authority. Asset bytes still require a separate `content-cache` grant and are retried through other providers. Manifest versions and authority epochs must fit JavaScript's safe-integer range, and each delegated lease must advance exactly one epoch. The lease does not authorize edits, produce a delegate-signed replacement world manifest, or transfer simulation state; runtime conflict recovery and shared simulation authority still need implementation before this is suitable for concurrent writes.

Run `npm run test:world-gateway` for a local owner/cache integration check. It builds temporary `worldd` nodes, signs a world manifest, syncs an owner-authorized cache over libp2p, connects the production `WorldConnector` through a trusted temporary HTTPS/WSS proxy, and verifies content-hash recovery after the owner is stopped. The test exercises Node's native WebSocket implementation with a test-scoped trusted certificate; it does not replace browser-engine or WebTransport testing.

For the two current development-world links, build commands and restart instructions, see [testing two worlds](testing-two-worlds.md).

## Hosting a checked-in world profile

`tools/serve-world-profile.mjs` provisions an immutable world package into one named owner profile, signs its runtime manifest with that profile's persistent node key, verifies and installs all package assets, then starts the supplied daemon binary. Give every simultaneously running profile its own P2P and HTTP ports. The helper refuses to overwrite an existing profile manifest; once provisioned, the same command can restart it without `--source` or `--assets`.

Build `thruholdd` for the host first, then run (from the repository root):

```sh
node tools/serve-world-profile.mjs \
  --worldd /path/to/thruholdd \
  --worlds-dir "$HOME/.config/elsemesh/worlds" \
  --profile island-example \
  --source worlds/island/world-source.json \
  --assets worlds/island/assets \
  --http 127.0.0.1:5200 --p2p-port 42901
```

To run another world at the same time, use a second profile and distinct ports:

```sh
node tools/serve-world-profile.mjs \
  --worldd /path/to/thruholdd \
  --worlds-dir "$HOME/.config/elsemesh/worlds" \
  --profile loz-underneath \
  --source worlds/loz-underneath/world-source.json \
  --assets worlds/loz-underneath/assets \
  --http 127.0.0.1:5202 --p2p-port 42903
```

The checked-in `worlds/loz-underneath` package is a static, LOZ-derived cave world, not a port of the full Burning Horizons simulation. To advertise a newly provisioned world through the node's DHT without operating a directory, pass `--discoverable true --dht-mode server` to `tools/serve-world-profile.mjs`; the helper puts discoverability in the owner-signed manifest and starts `thruholdd` as a DHT server. `thruholdd` itself has no `--discoverable` flag. Existing profiles need an owner-reviewed source update and signed manifest publication before becoming discoverable. Peers still need a shared reachable DHT/bootstrap route. A portal may omit `destinationPeerId`: the client asks its configured directory or current gateway to resolve providers by the stable destination world ID. Keep a peer ID in the portal only when you intentionally want to pin a particular provider.

On Android/Termux, the helper places temporary manifest files under `$PREFIX/tmp`; on Linux it uses `/var/tmp`. The persistent identity, signed `world.json`, and installed content-addressed assets stay under `<worlds-dir>/<profile>`. For public browser invites, configure a reachable HTTPS/WSS gateway with `--public-gateway`; add `--directory-url` to publish a discoverable world. A directory URL requires a public gateway. The WebSocket gateway accepts same-origin clients by default; for a separately hosted static client, explicitly allow its exact HTTPS origin with repeatable `--allow-browser-origin https://rebroad.github.io` (for local development, loopback HTTP origins such as `http://127.0.0.1:5189` are also accepted). It does not allow arbitrary cross-origin browser connections. Android hosting may need explicit reachable addresses; pass each as `--announce-address /ip4/.../tcp/...` (or the documented QUIC form). Repeat `--bootstrap`, `--relay`, `--announce-address`, and `--allow-browser-origin` for additional values.

## Connectivity and links

Node-to-node connections use libp2p TCP/QUIC, DHT discovery on the existing Tidewater-prefixed protocol namespace, optional static bootstrap peers, NAT traversal, and opt-in circuit relays. Browser clients cannot use native TCP/QUIC directly, so the node exposes a WebSocket gateway intended to sit behind HTTPS. An optional WebTransport HTTP/3 gateway can be enabled for browsers that support the pinned draft; clients prefer it on HTTPS and fall back to WSS if connection setup fails. Keep WSS available because WebTransport draft support varies by browser and deployment. Public deployment must configure TLS, reachable UDP for HTTP/3, request limits, rate limits, and a trusted bootstrap/DHT mesh.

For the concrete volunteer-node setup, persistent identities, multi-bootstrap and static-relay configuration, and the current deployment verification gaps, see [Community bootstrap and relay nodes](relay-deployment.md).

Android restricts the netlink interface scan used by libp2p. On Termux, provide each reachable interface address with repeatable `--announce-address` values; accepted forms are `/ip4/<address>/tcp/<port>`, `/ip6/<address>/tcp/<port>`, and the corresponding `/udp/<port>/quic-v1` form. These addresses are advertised in signed node records and DHT results. A private Wi-Fi address is only reachable on that LAN; Internet access still needs a forwarded public port or a configured relay. Without an address reachable by intended peers, the daemon can run and serve the local browser gateway but other nodes may not dial it.

A browser link identifies the world and a route to it, for example `https://elsemesh.github.io/?worldId=tw-world:...&nodeId=<PeerID>&gateway=https%3A%2F%2Fworld-host.example&directory=https%3A%2F%2Fthruhold.org`. While visiting a hosted ThruHold, open the **World** panel and choose **Share world invite**; the app shares the current world ID, provider PeerID and gateway, plus its configured directory. Portal crossings update the address bar to the destination route. Unknown worlds can also be looked up by world ID through configured discovery; the browser tries available DHT providers through its gateway in order and falls through when one is unreachable, even without a public directory. When a directory is configured, the browser verifies provider records and tries their signed gateway origins in order. The URL selects a route; ownership and permissions still come from signed world documents, never from unsigned query parameters.

On the start screen, **Choose a ThruHold** opens the world picker. **Example Island** always returns to the built-in procedural island. A hosted world is added to the browser's origin-local visit list after its signed manifest and initial content load; the list keeps the 12 most recently visited world IDs. Select one to reopen its remembered route, or paste an invite URL to open another. **Set as home** saves one visited invite as this browser's personal start ThruHold; a bare visit to the app URL then opens that validated world. The preference stays local to this browser profile and does not host or publish the world. A `?example=1` route or the **Example Island** choice bypasses the home preference. Pasted links are reduced to the supported `worldId`, `nodeId`, `gateway`, and `directory` parameters and rebuilt on the current ElseMesh page, so opening an invite cannot navigate the app to another website. The world daemon's signed manifest remains the authority for content and access. Secure pages require HTTPS/WSS gateways; plain HTTP gateways are accepted only for loopback development.

An optional `directoryd` service provides HTTPS world lookup and signed node links. It is not required for hosting, world authority, or access to a known node. Directory entries are short-lived node-signed records paired with owner-signed manifests; the service indexes only discoverable worlds whose node is the owner, has an active `content-cache` grant, or presents a valid active failover-authority lease. Lookups order the owner first, then an active failover authority, then cache providers, with PeerID as a stable tie-breaker within each tier. This lets a recovered owner reclaim preferred service while still allowing browser fallback when it is unreachable. Directory lookup and DHT provider discovery allow credential-free cross-origin browser GETs so a static page can use independently hosted services; neither endpoint grants access or changes a world's authority. Nodes publish cache entries only after every manifest asset is present and hash-verified. The browser verifies the node record and then verifies the owner-signed world manifest and provider grant or lease. Community relays remain operator opt-in, bounded, and observable.

## Portals and streaming

A portal is a signed-manifest record containing a stable destination world ID, optional destination PeerID, optional HTTPS/WSS gateway origin, entry/exit transforms, and `openView`. When the PeerID is omitted, the client discovers providers for the world ID through its configured directory or the selected gateway's DHT lookup. The browser connects to the specified gateway when present; otherwise it reuses the current gateway, which can route to a discovered peer. This permits owners to keep links stable while providers change, while retaining PeerID pinning for intentionally fixed routes. As the player approaches, the browser downloads assets in ordered stages: `portal-preview`, then `visible`, followed by `nearby` and `background` after arrival. Assets within a stage load with bounded concurrency: data-saver and slow-link hints limit downloads to one, moderate links use two, and unknown or faster links use three. After each completed asset, a smoothed transfer-rate estimate can lower or restore concurrency for the next batch; explicit concurrency settings override these defaults. Browsers without Network Information API hints use measured rate when available and otherwise retain the default. Each completed file is checked against its content hash. Neighbor cache grants allow replicas to serve immutable bytes, not to change the owner's manifest.

The current connector and daemon provide signed manifest/chunk transport foundations. A browser URL with `worldId` and optional `gateway`/`nodeId` selects a ThruHold; the client verifies the manifest and asset hashes, loads static GLB instances, and replaces the procedural example scene. This first renderer supports embedded base-color textures and static triangle meshes. Authored box collision bounds are transformed with their asset instance; grid heightfield collision is extracted from a single GLB mesh when the signed manifest declares its row and column counts. Hosted worlds use a grounded first-person controller against only the active package colliders, so the hidden procedural example island, its reef, water, and boat do not affect hosted-world movement. Signed movement rules can set walk, sprint, and jump speeds within bounded ranges; legacy manifests retain the current defaults. Owners can also sign an aggregate `maxPackageBytes` cap; the converter, daemon, and browser validate it against unique referenced assets before publication or download. Collision is enabled only for the active world. Linked-world portals prefetch destination `portal-preview` assets first, then `visible` assets while nearby. When prepared content exists, an `openView` doorway shows it on an aperture-sized plane using a camera mapped through the source entry and destination exit; the view target is 256 × 512 and refreshes at up to 10 Hz. A per-fragment world-space clip at the destination exit removes geometry on the virtual camera side of the threshold. This renders the static GLB meshes and their embedded materials before the player crosses. Oblique reversed-depth projection places the signed exit plane at the near clip boundary, with the per-fragment world-space clip retained as a fallback; projection-space tests cover the threshold and both sides. Full dynamic destination simulation, including fish, boat behavior, and shared gameplay state, remains incomplete. The player waits at the entry plane until usable destination assets load, then the client swaps the active world and maps the player through the signed entry-to-exit transform. The arrival preserves position relative to the doorway, view yaw/pitch and all three world-space velocity components, so an off-center crossing or jump remains continuous with the preview. The destination then applies its signed gravity and movement parameters; controller contact and boat/deck attachment are re-established in that world. Inventories and authoritative simulation sessions do not yet transfer. `nearby` and `background` assets are appended after arrival. Portal entries face local -Z, and crossing from the +Z side triggers the transfer. Ordinary world objects may include an asset-local streamingBounds sphere and per-object priority; the client requests bounded objects intersecting the active camera frustum plus a small nearby buffer, then appends just those instances. Objects without bounds retain eager-loading compatibility. The client cancels a batch when its objects leave selection or higher-priority view work is waiting. Portal preparation aborts manifest lookup and staged downloads when the player leaves the selected portal or completes a handoff. Concurrent consumers of an asset share one hash-verified download, and one consumer canceling its wait does not interrupt other consumers; the underlying transfer stops after its final consumer leaves. Portal preview assets use their authored tier. A fixed-seed island vegetation component now uses the browser’s existing deterministic JavaScript and shader renderer in hosted roots and portal previews. The first active hosted world reuses its existing full vegetation group; `?noVeg` remains an opt-out. The vegetation component is specific to the example island. The `tidewater.static-reef/1` component references documented `tidewater.reef-placement/1` records in bounded, hash-addressed tiles and reconstructs the built-in Reef geometry, materials, and LODs; the current static package does not include fish, collision, or live Reef simulation. A separate `tidewater.water-body/1` component draws up to four non-overlapping bounded square deep-water surfaces from a signed world sea level; it uses no island terrain and carries destination levels through portal previews. It has no terrain interaction, shoreline, collision, or underwater gameplay. Player/session simulation transfer and full retry/failover behavior remain incomplete.

## Source, manifest, policy

Authoring source is `tidewater.world-source/1` (see [world authoring](world-authoring.md)); these existing protocol identifiers retain their original spelling for compatibility. Runtime manifests use `tidewater.world/1`, are signed by the owner identity, and contain immutable asset references, portals, rules, and host grants. The daemon rejects invalid signatures, IDs, bounds, priorities, and grants. The browser independently validates portal and component records and enforces globally unique object, portal, and component IDs across the signed manifest. Optional `rules.requiredFeatures` are versioned capability IDs: the daemon validates their syntax and uniqueness, and the browser rejects a world if it requires a capability the current client does not support. This prevents a client from silently treating a required simulation or rendering behavior as optional. Worlds are replaceable providers: the procedural island is the built-in example world, and a selected hosted world takes its place as active content. Island source and its reproducible runtime package belong in this Git repository; the checked-in example package includes its static terrain heightfield and deterministically placed scanned driftwood/shell GLBs. The hosted example requires `tidewater.terrain-surface/1` with profile `example-island-v1`: clients render the signed heightfield, baked normal/rock/AO and terrain masks, detail texture, and material metadata, while the GLB supplies collision and fallback geometry. The content-addressed terrain asset is portable and does not require the island generator seed. See [the terrain package fidelity contract](schemas/terrain-package.md). The full playable island continues to use its procedural JavaScript implementation. A world node can import and serve the package using the same owner-signed manifest flow as other worlds. Blender is an authoring/interchange tool, not a replacement runtime format. Dynamic procedural systems require explicit runtime component support and are not represented by static GLB assets alone.

Account login is optional and distinct from world identity. The Google-to-world-role trust model, consent, revocation, deletion, and recovery rules are specified in [account roles](account-roles.md). When the deployment supplies an HTTPS `accountd` URL and Google client ID through `elsemesh-config.js`, the browser shows a sign-in panel and binds the session to a browser-held Ed25519 key. The client can submit a signed, role-authorized world-edit proposal to the owner gateway; owner review and publication remain separate, explicit steps. This repository implements the broker and client but does not operate the service or provide deployment credentials. Guest worlds, node identities, hosting, and invites remain independent of account login.

## Current implementation and operation

The `server/worldd` Go program persists a node identity, serves a signed local starter manifest, accepts an owner-signed manifest, exposes browser gateways and content-addressed assets, and supports optional discovery/relay configuration. The default browser gateway is WebSocket. To enable WebTransport, provide a separate HTTP/3 UDP listener and certificate/key; make the browser's HTTPS host/port route to that listener over UDP while TCP HTTPS/WSS continues to route to the web server or reverse proxy. For example, a public `:443/udp` forwarding rule can target `thruholdd --webtransport :5201`; the certificate must cover the public host. The client tries WebTransport at `/gateway-webtransport` on the configured HTTPS origin, then falls back to `/gateway` over WSS. `src/network/WorldConnector.js` verifies signed documents and content hashes and fetches prioritized chunks; `src/network/WorldPackage.js` builds the currently supported static GLB instances. Author a Blender source document, import its GLB assets, convert it to an unsigned runtime manifest, then sign it using the same persistent node identity:

`tools/build-server.sh all` remains the CGO-free compatibility build for `worldd`, `directoryd`, and `accountd` across Linux amd64/arm64 and Android arm64. For the primary daemon with ZeroTier included, build `thruholdd` with `tools/build-thruholdd.sh`. It defaults to the ElseMesh network `e3918db4832a3056`, discovers the sibling libzt checkout and matching external libzt build for Linux amd64 and Android arm64, and bundles `libzt.so` beside the binary. No `--zerotier-network`, `LIBZT_INCLUDE_DIR`, or `LIBZT_LIB_DIR` is needed with the repository's standard source/build layout; nonstandard installations can override these paths. When cross-building for Termux, set `GOOS=android GOARCH=arm64` and the NDK `CC`/`CXX`; use `THRUHOLDD_OUT` under the external build tree to keep the Android binary separate from a Linux build. Each binary's `--version` prints the exact source commit. `build-server.sh` disables Go's automatic VCS scan because its external build checkout may not have independent Git metadata; Android uses `-checklinkname=0` for its network-interface dependency, while Linux keeps normal linker checks.

`accountd` is optional and exits without configuration. Configure the Google OAuth web client and browser origins before starting it, and put a local HTTPS reverse proxy in front of its loopback listener:

```sh
export ELSEMESH_GOOGLE_CLIENT_ID='<your OAuth web client ID>'
export ELSEMESH_ACCOUNT_ALLOWED_ORIGINS='https://rebroad.github.io,https://thruhold.org'
accountd --http 127.0.0.1:5203 --data "$HOME/.local/share/elsemesh/accountd"
```

```sh
thruholdd --data ./world-data --print-node-id
thruholdd --data ./world-data --import-asset ./assets/boat.glb
node tools/world-source-to-manifest.mjs --source ./island.world-source.json --owner <PeerID> --assets ./world-data/assets --out ./world-data/unsigned.json
thruholdd --data ./world-data --sign-manifest ./world-data/unsigned.json --manifest-out ./world-data/world.signed.json
thruholdd --data ./world-data --manifest ./world-data/world.signed.json --webtransport :5201 --webtransport-tls-cert fullchain.pem --webtransport-tls-key privkey.pem
```

### Multiple local ThruHolds

`thruholdd` normally keeps one node identity, signed manifest, and content store in its selected data directory. Named profiles create separate directories under `--worlds-dir` (default: `$XDG_CONFIG_HOME/elsemesh/worlds`, or the platform's Go user config directory), including independent node keys. Profile names are lowercase slugs containing letters, digits, hyphens, and underscores. List and initialize profiles with:

```sh
thruholdd --list-world-profiles
thruholdd --world-profile example-island --world-name "Example Island" --print-node-id
thruholdd --world-profile loz-forest --world-name "Loz Forest" --print-node-id
```

Start either profile by selecting its name. To run both on one machine, start separate processes and assign distinct P2P, HTTP, and (if enabled) WebTransport listener ports. Each process has its own PeerID; do not copy one `node.key` into simultaneous processes. `--data` remains available for an explicit single-profile path and cannot be combined with `--world-profile`.

```sh
thruholdd --world-profile example-island --p2p-port 42901 --http 127.0.0.1:5200
thruholdd --world-profile loz-forest --p2p-port 42902 --http 127.0.0.1:5201
```

These profiles provide isolated runtime storage and two independently served ThruHolds; they do not merge the identities into one multi-world daemon. Canonical Blender sources and exported packages remain in the repository's `worlds/` tree.

Back up a node identity before migrating its world data. Export creates a new file with mode `0600` and refuses to overwrite an existing file; store that key offline in a protected location, never in shared Android storage or Git. Restore accepts only a `0600` backup and refuses to replace an existing `node.key`. Both commands print the PeerID so you can confirm the restored identity matches:

```sh
thruholdd --data ./world-data --export-node-key ./offline-backup/node.key
thruholdd --data ./new-world-data --import-node-key ./offline-backup/node.key
thruholdd --data ./new-world-data --print-node-id
```

These commands copy the raw libp2p private-key encoding; protect the backup as a signing credential. Identity rotation is distinct from recovery and still needs a signed ownership-transfer protocol before old PeerIDs can be safely retired.

To publish a discoverable node in an optional directory such as `https://thruhold.org`, create its runtime manifest with `tools/world-source-to-manifest.mjs --discoverable true`, then sign it. Public discovery is off by default. Set the node's externally reachable browser gateway and directory URL:

```sh
thruholdd --data ./world-data --manifest ./world-data/world.signed.json \
  --public-gateway https://world-host.example --directory-url https://thruhold.org
directoryd --http 127.0.0.1:5202 --data ./directory-data
```

On Android/Termux, add explicit reachable libp2p addresses when interface discovery is restricted, for example `--announce-address /ip4/192.168.1.42/tcp/42901 --announce-address /ip4/192.168.1.42/udp/42901/quic-v1` for a LAN peer.

Transfer the Android arm64 `thruholdd` binary and its matching `libzt.so` to the device, then inside Termux install both (keep identity keys and world data in Termux-private storage, not shared storage):

```sh
cp "$HOME/thruholdd" "$PREFIX/bin/thruholdd"
cp "$HOME/libzt.so" "$PREFIX/bin/libzt.so"
chmod 700 "$PREFIX/bin/thruholdd"
mkdir -p "$HOME/.local/share/elsemesh/world"
thruholdd --data "$HOME/.local/share/elsemesh/world" --print-node-id
```

Then start it with the signed manifest and reachable announce addresses shown above. Termux background execution and network reachability remain device/operator responsibilities; Android may suspend processes that are not kept alive by the user's service setup.

Run `directoryd` behind HTTPS and rate limiting; its default listener is loopback. The directory stores announcements for up to 24 hours, while `thruholdd` refreshes every 12 hours. The node must be owner-authorized, and the world manifest must set `discoverable: true`. Browser links can select this directory without relying on the page's own host: `https://elsemesh.github.io/?worldId=tw-world:...&directory=https%3A%2F%2Fthruhold.org`. This repository supplies the directory service; registering or operating the `thruhold.org` domain is a separate deployment step.

`--import-asset` prints the content hash to assign to a source object. Add owner grants in the source document's `hosts` list before conversion; signing validates the runtime document and never overwrites an existing signature file. A manifest must be signed by the owning identity before other nodes can host it. The grant format has source validation and converter support, while a dedicated grant-management UI is still pending.

To seed an owner-authorized neighbor cache, first get that node's PeerID with `thruholdd --data ./neighbor-cache --print-node-id`, add an unexpired grant for that PeerID to the canonical source document's `hosts` list, convert and sign the manifest, then provide the signed manifest to the neighbor. A cache-only entry looks like `{ "peerId": "<peer-id>", "scopes": ["content-cache"], "expiresAt": 1900000000, "epoch": 1 }`. Add `failover-authority` only with an explicit `failoverAfter` and `failoverSeconds` window. Start the neighbor with `--cache-from <owner-peer-id>` and a `--bootstrap` multiaddr for that source if it is not discoverable through DHT. The cache node fetches missing assets over libp2p, verifies the complete SHA-256 before an atomic install, and only advertises a discoverable world after all its manifest assets are verified locally. A live gateway's `/api/lookup` returns the local provider plus other DHT advertisers, including authorized caches. Use `--cache-sync-interval` to adjust retry cadence. Only the owner or a node with an active `content-cache` grant can serve asset bytes; a `failover-authority` grant alone never permits content serving.

Role revocation state is separately replicated because role enforcement must not require asset-cache permission. On each replica that needs fresh role state, pass `--role-state-from <owner-peer-id>` and a `--bootstrap` multiaddr if the owner is not discoverable. Each replica then checks the owner's signed world-role revocation document over libp2p at startup and every minute by default; use `--role-state-sync-interval` to set a cadence from one second to ten minutes. It verifies the owner signature, world ID, schema, and serial before storing state. Nodes can also sync from another same-world peer that already has the owner state. The signed state remains public data and does not grant edit rights by itself.

```sh
thruholdd --data ./neighbor-cache --manifest ./world.signed.json \
  --bootstrap /ip4/<owner-ip>/tcp/42901/p2p/<owner-peer-id> \
  --cache-from <owner-peer-id>
```

Build/test from the repo's `server` directory with Go 1.24.6 or newer. Build `worldd`, `directoryd`, and `accountd` with `go build -o <binary> ./<worldd-or-directoryd-or-accountd>`. For Android arm64/Termux, build each with `GOOS=android GOARCH=arm64 go build -ldflags=-checklinkname=0 -o <binary> ./<worldd-or-directoryd-or-accountd>`. The linker flag is required by the current libp2p Android network-interface dependency (`wlynxg/anet`), which uses Go linkname to work around Android netlink restrictions; keep it scoped to Android builds. For public browsers, serve the web app, directory and gateway through HTTPS/WSS. The daemons' default HTTP binds are loopback. Bootstrap peers must speak the legacy Tidewater DHT protocol prefix; generic public IPFS bootstrap peers are not compatible.

See `server/worldd`, `server/directoryd`, and `server/accountd` for the current code. These are evolving prototypes. The repository does not deploy a public directory or account service, complete the owner policy engine, simulate dynamic destinations in portal views, or provide robust multi-writer simulation. It implements optional Google ID-token verification in `accountd`; operators must configure its OAuth client and exact browser origins. Portal previews use oblique reversed-depth clipping with fragment clipping as a fallback. Desktop Chrome loaded the published game and the secure-origin WebGPU diagnostic passed adapter, device, and buffer creation. The current Flip7 build was delivered over SSH and its URL opened, but Android denied screen capture, so device rendering, appearance, and WebGPU initialization remain unverified.

The Go test suite includes a local two-node cache integration test. It starts owner and neighbor libp2p hosts, transfers the owner-signed manifest and a multi-chunk asset over the world protocol, then verifies that the neighbor installed bytes matching the declared size and SHA-256. Run it with `cd server && go test ./worldd -run TestAuthorizedNeighborFetchesSignedManifestAndAssetOverLibp2p -count=1`. This exercises the transfer and integrity path on loopback; it does not prove public Internet reachability, NAT traversal, or directory deployment.
