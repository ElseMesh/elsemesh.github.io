# Example Island Package

`world-source.json` and `assets/<sha256>` are the checked-in, deterministic package generated from the same terrain, village layout, rock placement, reef placement, and debris placement code used by the playable island.

Regenerate it with:

```sh
npm run export:island
```

The package has an open-view portal at `[-340, 4.2, 80]` to the separately hosted `tw-world:loz-underneath` package. The cave package has the reciprocal portal at `[0, 4.2, 8]`. The signed records identify destination worlds rather than fixed nodes, so each side can discover whichever authorized provider currently serves the destination.

The package contains:

- A 512 by 512 terrain GLB with normals, vertex colors, and a matching heightfield collision declaration. Its colors are a coarse fallback only; full terrain appearance comes from the portable surface asset.
- Deterministic static village, pier, boardwalk, harbor, and prop geometry exported from the same CPU-side builders as the game, with 394 authored walkable and solid box colliders. Its GLB preserves the authored per-vertex tints and material batches. The `tidewater.village-materials/2` component supplies the complete 14-map GPU-baked PBR texture set as content-addressed data; the compatible client uses the same trusted material shaders and tile parameters as the playable island. The package streams this texture bundle with the village bounds, so an open portal preview does not download it prematurely. Moving sign/lantern details and GPU-only fish props are not included yet. The procedurally generated moored lobster boat is exported as a separate static GLB for hosted-world previews; its interactive movement and detailed shader materials remain part of the playable procedural island only.
- The four CC0 scanned debris assets already used by the procedural scene: dead quiver trunk, two branches, and lambis shell. The exporter keeps their LOD1 geometry and embeds each albedo map in a single-mesh GLB.
- Deterministically placed debris instances from the existing `DebrisPlacer`, including full collision-free quaternion transforms. The exporter shares the playable world's CPU vegetation-placement records, so litter, logs, and other debris keep clear of the same plant trunks.

The hosted world declares `tidewater.terrain-surface/1` with profile `example-island-v1`. Its content-addressed asset includes the full heightfield, baked normal/rock/AO and terrain masks, tileable detail texture, linear material palettes and base parameters. The versioned `original-tidewater-terrain-v1` shader contract renders those bytes; no procedural seed is needed by the hosted client. The terrain GLB remains for collision and fallback. See [the terrain export fidelity contract](../../docs/schemas/terrain-package.md).

The source declares `tidewater.static-vegetation/1` with a hash-addressed binary placement asset using `tidewater.vegetation-placement/1`. The compact asset carries deterministic plant records, streams at `portal-preview` priority, and is rendered by the client's existing geometry and shader pipeline; it contains no executable code. These records are absolute world-space placements and omit grass. The original playable island keeps its procedural vegetation and terrain-mask grass path, with `?noVeg` as an opt-out. Placement records are portable with this island package, but this fixed plant taxonomy is not yet a general vegetation or terrain authoring format.

The exporter writes reef placements as versioned `tidewater.static-reef/1` components backed by content-addressed `reef-placement/1` binary assets. Records are grouped into aligned 64 m XZ tiles with conservative streaming bounds; every asset is limited to 16 MiB and the package to 128 reef tiles. The installed Tidewater runtime supplies the deterministic coral meshes and shaders, while the package supplies the full seeded placements, rotations, colors, and motion parameters. Fish and whale simulation are not part of these static reef records.

The source also declares `tidewater.island-ocean/1` at `portal-preview` priority. It reuses the existing FFT waves, water material, and a world-local CDLOD mesh when this package is hosted. The component is limited to the reference island's sea level and terrain interaction. The lobster boat is present as a static visual preview only: boat movement, boarding, water-hull masking, wildlife, fishing behavior, moving sign/lantern details, and GPU-only fish props are still not packaged.

The `tidewater.ambient-audio/1` component packages eight original loop recordings (surf, wind, palms, crickets, pier water, underwater reef, boat water, and dawn birds) as OGG assets addressed by SHA-256. Their gains come from the existing `SoundScape` mix metadata; time-of-day and underwater conditions and the pier/boat positions preserve the portable part of that ambience mix. The browser verifies and streams the assets before using the shared audio context. This does not include dynamic surf events or one-shot boat, wildlife, and fishing sounds; see [the component contract](../../docs/schemas/ambient-audio.md).

The assets are content-addressed by SHA-256 and their IDs are recorded in the world source. The source sets a 128 MiB aggregate package budget to include the village texture bundle. `SOURCE_DATE_EPOCH` can pin the source document timestamp when intentionally refreshing the package; otherwise regeneration preserves the checked-in timestamp. Repeated exports must produce byte-identical source and asset bytes on the supported exporter backend.

This is a transportable example world with static GLB assets and three client-implemented runtime components, not yet a replacement for the playable procedural JavaScript island. The existing unhosted game remains the complete, interactive example; the hosted package does not yet preserve every original interaction or dynamic sound event. Original scanned model files and their CC0 credits remain in `public/models/debris`.

To serve it from a node, import the source GLBs once with `worldd --import-asset` to obtain their IDs, convert the source with `tools/world-source-to-manifest.mjs`, and sign the result with the owner's persistent identity. Then install the complete generated package from its asset directory:

```sh
worldd --data ./node --manifest ./world.signed.json \
  --import-package ./worlds/island/assets
```

The package importer verifies that every file matches the signed manifest and that the directory has no missing or extra files before adding content to the node store. A neighbor can use the same operation only when the owner-signed manifest grants that node `content-cache`.
