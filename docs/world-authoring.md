# ElseMesh ThruHold authoring and AI editor direction

For doorway placement, independent front/back routes and friend-to-friend connection exchange, see [adding and sharing portals](portal-authoring.md).

## Product direction

ThruHolds are authored in Blender and through a separate AI editor service. ElseMesh will not ship an in-game world editor in this direction. Blender is the visual authoring tool; the existing `tidewater.world-source/1` JSON identifier is retained for compatibility; the AI service will propose edits to that document and its referenced assets.

For open portal views, an object may declare `replacesObjectId` pointing to a non-colliding `portal-preview` object. The preview can render while visible-tier assets stream; the runtime hides it once the higher-detail object arrives, regardless of arrival order. Preview objects are visual only and must not carry gameplay collision.

A Blender project is a working scene, not the canonical network publication. Keep the editable source, export recipe, and reproducible packaged world assets under version control. The procedural island follows the same rule: it is a built-in example world whose source and exported package live in this repository, rather than a permanent scene layer. A selected hosted world replaces the currently active world content. Server runtime manifests are separately validated and owner-signed; never treat an AI proposal or `.blend` file as an authorization to publish.

## Replaceable world content and packaging

The game runtime should select a world provider by world ID. The procedural island is the default/demo provider; a packaged or remotely hosted world is another provider and occupies the same world-content slot. Shared engine services (renderer, camera, input, audio, and world-transition code) are not island content. Loading a different world must unload the island content instead of drawing it behind or around the selected world.

World content has three related forms, with distinct jobs:

1. **Editable source in Git:** generator code and parameters for procedural content, plus Blender `.blend` files and `tidewater.world-source/1` documents where applicable. This is the human-readable, reviewable source of truth.
2. **Built runtime package in Git:** deterministic export output for the example island, including its runtime manifest and content-addressed asset files. Committing the package makes the exact demo world available to reproduce and lets a node seed its content store without rebuilding from source.
3. **Served content in a node store:** the same immutable package assets copied or imported into `worldd` storage and referenced by an owner-signed runtime manifest. Nodes serve those bytes to clients and permitted neighbor caches. The repository is not itself the live content server.

The reproducible package under [`worlds/island`](../worlds/island/README.md) exports `TerrainData` as a vertex-colored heightfield GLB for collision and compatibility, deterministic static village/pier geometry as a tint-colored multi-material GLB, the moored boat berth and static preview, four CC0 scanned driftwood/shell assets with seeded placements, binary vegetation and tiled reef placement records, eight content-addressed OGG ambience beds, and versioned runtime components including the original terrain renderer and example-only `tidewater.island-ocean/1`. Reef records use fixed-width `reef-placement/1` assets in aligned 64 m XZ tiles, each referenced by a bounded `tidewater.static-reef/1` component and capped at 16 MiB; the client supplies the approved renderer implementation. The hosted `tidewater.downeast-boat/1` component binds the signed berth to the built-in boat model and physics, including automatic deck landing, rocking, helm, and driving; see [`schemas/downeast-boat.md`](schemas/downeast-boat.md). Each scanned GLB embeds its albedo image and keeps the LOD1 mesh. The package still omits the village's GPU-baked tile textures and animated/GPU-only props, portable wildlife simulation, and fishing gameplay. It does not replace or alter the playable procedural island. Extend it as separate stable-ID assets or versioned runtime components so source changes remain reviewable. Large binary assets may be stored with Git LFS if repository size warrants it, while their hashes and package index remain versioned in Git. A world node can import the checked-in package into its local content store and sign/publish it with that node's world identity; private signing keys must never be committed.

### What “export” means and what it must preserve

An export is a conversion from editable source into a deterministic, content-addressed package that another node can store and serve. It is not a screenshot, and the serving node does not run the editor, generator, or renderer. The package must describe the world’s visible assets, collision, placements, portals, and supported behavior so the client can reconstruct the world without access to the author’s checkout. It should preserve the authored appearance within stated visual, size, and performance budgets.

For static Blender-authored models, this usually means exporting GLB geometry and its PBR texture maps. For procedural or dynamic content, the choices are to bake an appearance snapshot into portable assets, or to export the underlying data with a versioned renderer/behavior contract implemented by clients. The example island GLB keeps collision and fallback geometry. Its `tidewater.terrain-surface/1` package transports exact height samples, normal/rock/AO and terrain masks, the detail texture, linear material palettes and parameters under the versioned `original-tidewater-terrain-v1` renderer contract. A seed or profile name alone is insufficient. See [the terrain export fidelity contract](schemas/terrain-package.md). Other supported clients must be able to render without access to this island’s private procedural setup. Keep a low-cost collision/portal-preview representation separate from the full-quality visual representation when their budgets differ.

The runtime package supports static meshes, embedded base-color textures, transforms, collision intent, world rules, portal records, data-only `tidewater.ambient-audio/1`, and the bundled Downeast boat runtime. Ambient beds reference signed `audio/ogg` assets by SHA-256, are capped at 16 MiB each, and may declare gain, a condition (`always`, `day`, `night`, `dawn`, or `underwater`), and an optional world-space point with bounded distance attenuation. The browser only decodes bytes already verified by `WorldConnector`; manifests cannot name arbitrary URLs. The existing `SoundScape` AudioContext plays and spatializes these loops after the usual user gesture. The exporter carries selected original Tidewater recordings and derives gains from the source mix metadata. This is ambience coverage, not full audio parity: one-shot wildlife/fishing event scheduling remains tied to built-in simulation systems. The original audio files remain in `public/audio/`, with source and licensing notes in `public/audio/CREDITS.md`. Other dynamic systems cannot be assumed to survive a static mesh export: portable weather, wildlife, and fishing simulation still need runtime component definitions. The procedural island remains fully playable as the example ThruHold while package support is expanded.

Static GLB materials may use `KHR_materials_emissive_strength`; the loader applies both `emissiveFactor` and `emissiveStrength`. A world relying on this behavior must require `tidewater.static-glb-emissive-strength/1`, so clients that do not implement it reject the world instead of silently rendering its lights incorrectly. The archived LOZ cave package is the current example and its exporter preserves named material colors and glow strengths.

## Shared source format

The normative JSON Schema is [`schemas/world-source.schema.json`](schemas/world-source.schema.json). The browser-side structural checks are in `src/network/WorldSource.js`; Blender import/export is provided by [`../tools/blender/world_source.py`](../tools/blender/world_source.py). The `tidewater.ambient-audio/1` authored shape and runtime behavior are specified in [`schemas/ambient-audio.md`](schemas/ambient-audio.md).

The format uses right-handed, Y-up coordinates in meters. It records stable IDs, asset hashes, transforms, collision intent, world rules, style guidance, and portal endpoints. Asset instances may use a normalized `[x,y,z,w]` quaternion in addition to yaw when collision is disabled; the browser requires `tidewater.static-glb-quaternion/1` for this transform. Collision objects and portals continue to use yaw-only transforms. `rules.gravity` is a multiplier applied to player movement acceleration (1 preserves the built-in 9.81 m/s²); the browser switches it when entering a linked world. `rules.seaLevel` and `rules.atmosphereLevel` are independent optional world-space Y coordinates in meters: sea level declares the sea surface, and atmosphere level declares the upper atmosphere boundary. A world may declare either, both, or neither. Omission preserves legacy behavior. Hosted worlds apply `seaLevel` to the frame; the `tidewater.water-body/1` renderer stores it and an optional named material profile (`deep-ocean`, `calm-lagoon`, or `storm`) per component so portal previews can show the destination water level and look. The example-only `tidewater.island-ocean/1` still uses the built-in terrain and water profile. A Downeast boat requires a sea level and one of these water renderers; its berth uses a collision-free portal-preview object and is detailed in [`schemas/downeast-boat.md`](schemas/downeast-boat.md). `atmosphereLevel` is transported and validated but does not yet change rendering or simulate weather; it is a coordinate, not a weather preset. `rules.movement` optionally sets `walkSpeed`, `sprintSpeed`, and `jumpSpeed` in meters per second for hosted-world movement. Values are bounded (walk 0.5–10, sprint from walk speed to 15, jump 0–10); omitted values preserve the previous controller defaults (3, 6.2, 4.6). These rules apply to walking, keyboard/touch sprinting, and jumping in hosted static worlds. `rules.maxPackageBytes` optionally caps the aggregate size of the unique assets referenced by the world, in bytes (up to 16 GiB). The source converter, node, and browser reject packages that exceed the signed cap before the browser downloads assets. Omit it for legacy behavior. Only `default` and `tidewater-default` physics profiles are accepted; they currently use the same movement model. `avatarComplexity` caps each remote avatar's triangle count. The client tries the matching medium and low stock meshes before showing its simple fallback, and distance LOD can select an even coarser mesh within the cap. It does not cap the number of remote players, so it is not a total world or session triangle budget. `rules.requiredFeatures` is an optional, unique list of versioned `tidewater.<feature>/N` capability IDs; the daemon validates the syntax and the browser refuses worlds that require features it does not implement. Currently recognized browser requirements are `tidewater.static-glb/1`, `tidewater.static-glb-emissive-strength/1`, `tidewater.static-glb-quaternion/1`, `tidewater.portal-handoff/1`, `tidewater.portal-preview-static/1`, `tidewater.procedural-island-vegetation/1`, `tidewater.static-vegetation/1`, `tidewater.island-ocean/1`, `tidewater.water-body/1`, `tidewater.static-reef/1`, and `tidewater.downeast-boat/1`. Static reef tiles reference documented `tidewater.reef-placement/1` records and use the built-in reef species renderer. The packaged example island exports deterministic placements generated from seed 7 into the `tidewater.vegetation-placement/1` asset format, then serves them through `tidewater.static-vegetation/1`; the signed component no longer asks the client to sample the built-in island terrain. `tidewater.procedural-island-vegetation/1` remains available for the legacy live procedural scene. Static vegetation uses absolute world-space plant positions and the existing species and LODs, without procedural grass. Generic terrain-driven grass masks are still a future capability. The island-ocean capability attaches the existing island ocean renderer to a hosted world. It has no parameters, assumes the example island's terrain and sea-level conventions, and is not a general water-body format. Add capabilities only after their runtime behavior is implemented and verified. Objects and component data refer to content by SHA-256 ID; don't rely on a machine-specific filesystem path. Assign each asset a streaming priority: `portal-preview` for content needed to preview a connected world, `visible` for the first usable scene, `nearby` for close supporting content, or `background` for the remaining world. The browser loads these tiers in order, with bounded concurrency within each tier. Portals identify a stable destination ThruHold ID, optional libp2p PeerID, optional secure browser gateway origin, local entry and destination exit transforms, and whether the opening should show a remote preview. Omitting the PeerID lets the client discover providers by world ID through its configured directory or current gateway; pin a PeerID only when a fixed provider is intended. Without an explicit destination gateway, the browser reuses the current gateway.

Portal records may optionally select a client-rendered frame using `visual: "timber"`, `"stone"`, or `"metal"`. The frame is centered at the signed entry transform and surrounds the 2.42 × 4.9 m preview aperture. Omit `visual` to preserve the frameless appearance of older worlds. These frames are decorative only: they do not add collision or door animation, so authored colliders still define the passage. The example island uses a timber frame and the LOZ-derived cave uses stone.

The portable vegetation placement asset is a binary format. Its fixed field order, bounds, and compatibility rules are documented in [`schemas/vegetation-placement.md`](schemas/vegetation-placement.md). The bounded deep-water component and its current simulation limits are documented in [`schemas/water-body.md`](schemas/water-body.md). The hosted Downeast boat berth and gameplay contract is documented in [`schemas/downeast-boat.md`](schemas/downeast-boat.md).

The example-island water component is documented in [`schemas/island-ocean.md`](schemas/island-ocean.md). It is deliberately scoped to the reference island's water profile.

Runtime component records are closed, versioned contracts. Authoring validation, owner signing, Go node decoding, and browser validation reject fields that are not declared for that component version; introduce new data under a new protocol version rather than relying on unknown fields being ignored.

For view-driven streaming, an object may declare `streamingBounds: { center: [x, y, z], radius }` in asset-local meters and an object-level `priority`. The radius is scaled with the instance; the center is transformed by its signed yaw or quaternion. The browser requests bounded objects intersecting the active view, plus objects within its nearby buffer, and appends only those instances. Objects without bounds keep legacy eager-loading behavior. Asset-backed component data may declare the same shape, but its center and radius are already in world-space meters; the browser selects the component when its sphere is in view or within the nearby buffer, then installs it after its referenced placement asset is fetched and verified. A component's `priority` must match its placement asset's priority; omission means `portal-preview`. Component and object requests share the ordered, cancelable view-streaming batch. Components without bounds keep legacy eager-loading behavior. Portal preview remains a separate prefetch stage so destination content can arrive before a crossing; component data assigned `portal-preview` is staged for that view before `visible` data.

Example exchange:

```sh
blender --background island.blend --python tools/blender/world_source.py -- import worlds/island.world-source.json
blender --background island.blend --python tools/blender/world_source.py -- export worlds/island.world-source.json
```

The helper creates editable metadata empties in a dedicated collection and keeps the full JSON in a Blender text block. Mesh assets remain normal Blender objects/files and should be exported to GLB/glTF and content-addressed separately. Review source diffs after export; Blender saves are not automatically trusted or published.

Static asset instances may declare an enabled box collision in local asset coordinates: `center` and positive `halfExtents` vectors, plus explicit `walkable` and `solid` flags. Terrain may instead declare a `heightfield` with `columns`, `rows`, `walkable: true`, and `solid: true`; its GLB must contain exactly one mesh whose regular XZ-grid vertex count equals `columns * rows`. The browser extracts that mesh's vertex heights and applies the asset instance scale, yaw, and position when the active world is entered. Keep collision geometry intentional and review it in Blender; arbitrary visual triangle meshes are never treated as implicit collision geometry.

Owner-authorized serving permissions live in the source document's optional `hosts` list, so Blender and AI source edits retain the policy that will be signed. Each grant names a node PeerID, a unique subset of `content-cache` and `failover-authority` scopes, an expiry Unix timestamp, and a positive grant epoch. Failover grants also require an activation timestamp and a duration of 1–3600 seconds fully inside the grant expiry. The converter copies grants into the runtime manifest; only the owner node signs that manifest. Keep grants scoped to known neighbors and remove/re-issue them when permissions change.

To produce a runtime document, import each GLB with `worldd --import-asset`, set the resulting ID on the matching source object, then run `tools/world-source-to-manifest.mjs`. After signing the result, `worldd --import-package` can install all assets from the generated hash-named `assets` directory in one verified operation:

```sh
worldd --data ./node --manifest ./world.signed.json \
  --import-package ./worlds/island/assets
```

The package operation requires the owner or an active `content-cache` grant, requires the directory to contain exactly the assets listed by that signed manifest, checks each byte count and SHA-256, and verifies every asset before installing any. It is repeatable and leaves existing valid content-addressed files in place. Use `--import-asset` for a single asset or before its ID is known. The converter carries `updatedAt` and owner host grants into the runtime manifest so the same source and assets produce byte-stable unsigned manifest content. Worlds are private by default; pass `--discoverable true` only when publishing to public discovery. Blender export preserves `updatedAt` when metadata is unchanged; when it changes metadata, set `SOURCE_DATE_EPOCH` for reproducible timestamps. Finally, use `worldd --sign-manifest` with the world's persistent owner identity. Runtime signing keys stay on the owner node; the AI service must only return unsigned proposals.

### Apply a reviewable proposal

`tools/apply-world-proposal.mjs` applies a bounded unsigned patch to one exact source snapshot. The proposal format is defined in [`schemas/world-proposal.schema.json`](schemas/world-proposal.schema.json). It binds both `worldId` and `sourceHash`; the hash is SHA-256 of the source file bytes, so a proposal for another world or an older edit is rejected instead of silently rebasing. The allowlisted operations add, update, or remove stable-ID objects and portals, or update selected world metadata. Protected IDs and arbitrary script execution are not accepted.

```sh
node tools/apply-world-proposal.mjs --source ./island.world-source.json \
  --proposal ./proposal.json --out ./candidate.world-source.json
```

The tool applies operations to a copy, runs the same source validator used by Blender/client code, and creates a new output file only if the complete result is valid. Review the resulting diff and candidate assets before converting or signing. The proposal tool never imports Blender scripts, signs a manifest, or publishes content.

An account with an owner-issued `world.content.edit` grant can submit the unsigned proposal to the owner's `worldd` using `AccountClient.submitWorldProposal(gateway, proposal, grant)`. The owner node requires fresh signed revocation state and stores the signed submission under `<worldd --data>/proposals/` for manual review. See [account-roles.md](account-roles.md) for the envelope, limits, and security boundary. Queueing a proposal does not accept, apply, or publish it; owners still review the source diff and candidate assets and perform the normal signing workflow themselves.

### Apply typed Blender preview actions

`tools/blender/world_actions.py` is the Blender-side companion for data-only scene edits. It accepts a JSON plan bound to the exact source-file bytes with `sourceHash`. Existing operations add, update, or remove stable-ID asset instances and portals. `mesh.create` adds a new stable-ID object and creates its asset from up to 12 fixed primitive parts (`box`, `cylinder`, or `uv-sphere`) with four fixed material presets. Each part has bounded dimensions and position; a plan may create at most 16 assets and 96 parts total. The runner exports each asset as GLB, names it by its SHA-256, writes the hash into the source object, and saves a separate candidate asset directory. No model-provided code, Blender operator names, or asset paths are evaluated. Existing asset instances still require a `sha256:` asset, whose digest the runner verifies before import. Existing source markers created by `world_source.py` are the edit targets, so start from a Blender file imported from the same source snapshot.

Run it in a disposable copy of the scene. It writes an unsigned source candidate and a separate `.blend` candidate, refusing to overwrite either destination. When a plan includes `mesh.create`, also pass a new `--out-assets` directory; the runner refuses to overwrite it. Review all candidates and run the ordinary source and asset validators before publishing. The runner does not sign or publish. Pure plan validation does not require Blender. The runtime integration check imports a hash-verified island GLB, creates and hashes a primitive mesh GLB, writes all candidate artifacts, reopens the `.blend`, and verifies both stable IDs and the generated content hash:

```sh
python3 test/blender-world-actions.py
BLENDER_EXECUTABLE=/path/to/blender python3 test/blender-world-actions-runtime.py
```

An example data-only mesh action is:

```json
{
  "op": "mesh.create",
  "object": {
    "id": "tw-object:wooden-crate",
    "kind": "asset-instance",
    "label": "Wooden crate",
    "priority": "visible",
    "transform": { "position": [2, 0, -1], "yaw": 0 },
    "scale": [1, 1, 1],
    "collision": { "shape": "box", "enabled": true, "center": [0, 0.5, 0], "halfExtents": [0.5, 0.5, 0.5], "walkable": false, "solid": true }
  },
  "parts": [
    { "shape": "box", "dimensions": [1, 1, 1], "position": [0, 0, 0], "material": "wood" }
  ]
}
```

On 2026-10-02 this completed with Blender 4.3.2 on Linux. It verifies that Blender can execute this typed scene action; it does not establish an isolated service worker, arbitrary AI task handling, or publication.

```sh
blender working-copy.blend --background --python tools/blender/world_actions.py -- \
  --plan plan.json --source island.world-source.json --assets worlds/island/assets \
  --out-source candidate.world-source.json --out-blend candidate.blend
```

Enabled collision supports one box, a compound of up to 2048 asset-local boxes, or a regular-grid heightfield. Each compound box stores its local center, positive half extents, yaw, and walkable/solid flags; the loader applies the parent instance transform and removes every box during world handoff.

## AI editor service

The service is a planned, separate authoring product, not part of the world daemon's authority path. Its first implementation should be a tool-using assistant rather than model fine-tuning: provide a bounded Blender workspace and explicit operations through `bpy`, alongside schema-aware JSON edits. This yields inspectable actions and avoids training a model to emit opaque scene files.

A task starts from a versioned world-source snapshot, referenced asset catalog, style guide, coordinate conventions, and relevant neighborhood/portal context. The agent produces a patch (stable IDs plus add/update/remove operations), Blender Python actions for mesh work when needed, and a short rationale. The service applies changes in an isolated working copy, exports candidate GLB assets, computes hashes, validates the source and asset limits, then renders preview images and a structured diff. The owner reviews and accepts or rejects the proposal. Only accepted content is converted into a new owner-signed world manifest and published.

Required safety and quality boundaries:

- Run generated Blender scripts in a disposable, resource-limited worker with no ambient network or host filesystem access. Expose only the task files and a small documented helper API.
- Validate JSON against the schema and project rules; validate GLB size, hashes, triangle budgets, transforms, collision declarations, and portal destinations before preview.
- Keep every operation attributable to a task and model; store the source revision, tool calls, generated files, validation output, preview, and reviewer decision.
- Never give the assistant node identity keys, owner signing keys, deployment credentials, or direct write access to a live world.
- Require human review for world publication and for edits that alter rules, portals, ownership, or neighbor permissions.
- Make retries deterministic from a pinned source revision, prompt/context bundle, model identifier, and tool version. Use an explicit patch format so a failed task can be discarded without corrupting the source.

## Training and evaluation path

Initially, "teach the AI Blender" means give it good Blender-specific tools, examples, and feedback—not train a foundation model from scratch. Build a curated task set from accepted changes: object placement, transform correction, simple prop creation, portal placement, style matching, and repair of invalid source documents. Each example should pair the request and source snapshot with the accepted patch, Blender operations, preview, and validation results. Exclude rejected/private world data unless its owner opts in.

Evaluate on held-out worlds and measure schema validity, correct IDs/links, rule compliance, visual review scores, performance budgets, and how often owners accept with no edits. Fine-tuning can be considered later if these evaluations show repeatable tool-use failures that prompting and tools cannot address. Preserve provenance and owner consent for any training data.

## Implementation boundary

The current repository contains the source-format helper, Blender interchange script, ElseMesh node/client foundation, a deterministic terrain, village, pier, boat, and debris island package, and a browser loader for static GLB instances in a signed hosted ThruHold. That loader can replace the procedural example scene, stream authored priority tiers, register authored box and heightfield collision, render prepared static GLB content through an open portal using a mapped destination camera, clip source-side geometry at the signed destination exit plane, and hand off the player through configured portals. Hosted static worlds use the grounded first-person controller and their active-world colliders. The versioned hosted Downeast boat component supplies automatic deck landing, boat-relative movement as the hull rocks, helm access, and the existing driving controller. Portal views use a fixed 2.42 × 4.9 m aperture and 256 × 512 render target refreshed at up to 10 Hz; oblique reversed-depth projection places the exit plane at the near clip boundary, with fragment clipping as a fallback; dynamic destination wildlife, fishing systems, and remote simulation remain unimplemented. Object assets use signed bounds and frustum/nearby selection; asset-backed component data can also declare signed world-space bounds and follows the same priority tiers. Downloads are canceled when a pending batch leaves selection, while already loaded content stays cached. Legacy unbounded components remain eager. Signed manifests now record the exact source-file hash, and the owner publication command checks the supplied base snapshot against it before replacing content. Proposal acceptance still requires human review. Extending the island package to remaining content, the AI editor service, isolated Blender worker, and preview/review UI remain future implementation work. This document describes intended boundaries; it does not claim those services are running.

## Proposed service contract

The initial service boundary should stay separate from `worldd` so world hosting remains decentralized and owners can run without an AI account. A task API can use these operations:

- `POST /v1/edit-tasks` with `{worldId, baseRevision, request, allowedOperations, assetIds}` creates an isolated proposal task.
- `GET /v1/edit-tasks/{taskId}` returns queued/running/ready/failed state, validation findings, previews, and a patch reference.
- `POST /v1/edit-tasks/{taskId}/review` records owner accept/reject and optional comments. Acceptance creates a candidate revision; it does not itself publish or sign it.
- `GET /v1/edit-tasks/{taskId}/patch` downloads a patch bound to the exact base revision. Applying it to a changed source must fail and require a rebase/review.

The worker should receive a capability-limited task bundle, not arbitrary world-server credentials. Its Blender adapter should expose named operations (create/edit mesh, place asset instance, position portal marker, export candidate GLB, render preview) and a bounded `bpy` subset; direct Python execution can be an early prototype only inside a disposable sandbox. Store audit events and artifact hashes, and delete private task bundles according to owner-configured retention.

The service should be optional and deployable by a world owner or community operator. A hosted service must not become a mandatory discovery service, acquire world signing keys, or silently reuse authored worlds as training data. Keep a local CLI/worker path so authors can run the same validators without trusting a hosted AI service.

## ThruHold loading presentation

Each ThruHold may provide its own loading-screen identity and copy in `presentation.json` beside its authoring files. The exporter embeds this document as the source's `experience` object, and the owner publication tool carries it into the signed manifest. The ElseMesh loader supplies the progress UI and sanitizes all values as plain text; genre, tagline, loading note, rotating tips, and stage labels belong to the ThruHold author. Keep stage keys limited to the engine's documented stages (`gpu`, `atmosphere`, `terrain`, `village`, `vegetation`, `ocean`, `reef`, `simulation`, `shaders`, `world`, `compile`, and `warmup`). Worlds without an experience descriptor use a neutral loader fallback.

The checked-in Example Island and UNDERNEATH packages are examples of per-world presentations. Change their `presentation.json` files, then run the matching world exporter before validating or publishing the updated source.

## Initial arrival pose

Set optional top-level `spawn` in `world-source.json` before publishing:

```json
"spawn": { "position": [53.6, 4.447713719743241, -77], "yaw": 3.141592653589793, "pitch": -0.05 }
```

`position` is the **camera eye**, in world-space meters (Y up). Allow 1.62 meters above the standing surface. `yaw` and `pitch` are radians; pitch must lie between -1.5 and 1.5, yaw between -360 and 360, and coordinates within ±1,000,000 meters. The island exporter derives this pose from the original boardwalk start and its collision height. Worlds without a spawn keep the previous `[0,3,8]` entrance. This only controls initial world visits: entering through a portal uses the portal's mapped arrival pose.

Republish the source through the owner profile to update its signed manifest; changing the checked-in source does not change an already running server's published snapshot.
