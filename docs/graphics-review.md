# Reproducible graphics review

The current ElseMesh build accepts review-camera URL parameters so a view can be opened in a local build or the fork deployment:

- `?view=beach` opens the beach and pier overview.
- `?view=village` opens the beach buildings.
- `?view=tValley` opens the mountain valley and trail approach.
- `?view=tSummit` opens the summit.
- `?pose=<URL-encoded-JSON>` restores a captured pose with `p` (three coordinates), `yaw`, `pitch`, and optional `time`. The shape matches the JSON returned by the existing `window.__pose()` review helper.

These opt-in parameters switch to the existing free camera; they do not affect ordinary launches. Named poses also set a fixed time of day, so lighting is consistent across captures.

The upstream `dgreenheck.github.io/tidewater/` deployment does not include these review-camera parameters. A URL such as `?view=beach` there is ignored, so its spawn view cannot be treated as the same pose as one of the named ElseMesh views. Before calling an image comparison like-for-like, arrange for both builds to use the same camera pose, viewport, time of day, render scale, anti-aliasing, shadows, and water-reflection settings. Otherwise report the mismatch and use screenshots only to identify candidate differences.

## Follow-up browser check, 2026-10-01

The desktop Chrome tab for `https://rebroad.github.io/tidewater/?view=beach` showed a white 3D view while its ElseMesh HUD and performance panel remained active (10 fps, 466 × 295 render size, 50% scale, shadows and water reflections off). The upstream tab completed startup and rendered the beach scene. The two captures used different viewports and the upstream ignored `?view=beach`, so they are not a like-for-like graphics comparison. This differs from the earlier same-day check, which observed both pages rendering. Root cause of the white current view is unknown; inspect fresh renderer diagnostics before attributing it to the world package or making visual changes. The Flip7 had no ADB device, and SSH to its configured `192.168.192.7:8022` endpoint returned `Network is unreachable`.

Record the browser viewport and Performance-tab render scale with each capture: Linux adaptive rendering can lower internal resolution when it misses its 24 FPS target, while the Android path retains its full-quality settings.

## Browser check, 2026-10-01

The Flip7 was not reachable over ADB or SSH during this check, so Chrome on the desktop was used to inspect both deployed pages. Both started and rendered. The upstream page reported 1166 × 683 render size, 100% scale, shadows on, and water reflections on. The fork page at `?view=beach` reported 466 × 295, 50% scale, shadows off, and water reflections off; its URL-selected view worked. The browser tabs had different viewport sizes, and the upstream ignored the named-view URL, so these captures do not establish visual parity. They do confirm that Linux adaptive defaults visibly change rendering settings; those settings are Linux-only in `src/App.js`, with Android excluded by platform detection. A matched camera and viewport comparison remains required before deciding whether scene content or materials regressed.

## Mountain color parity

The island exporter currently writes its 513 × 513 heightfield as a static GLB with hand-authored `COLOR_0` values. That export choice approximates terrain zones; it is not a limit of export or of GLB. Those vertex colors cannot carry the original shader’s layered detail textures, slope-dependent rock, wetness, triplanar rock, or terrain lighting, so drawing that mesh as the final visual surface made the mountain look flatter and differently colored than upstream.

The signed `tidewater.terrain-surface/1` component now carries the deterministic heightfield, baked normal/rock/AO and terrain masks, detail texture, palette, and material parameters. The terrain GLB stays for collision and fallback. The exporter test checks deterministic bytes and the versioned original-terrain material profile. Matched-view screenshots against upstream and Flip7 visual confirmation remain outstanding; see [the terrain export fidelity contract](schemas/terrain-package.md).

## Village texture package

The Example Island package now includes the GPU-baked village PBR maps in its own content-addressed `tidewater.village-materials/2` asset. This removes the prior omission of baked wood, roof, thatch, stone, metal, grime, rope, and net texture inputs. The client regenerates only mip levels from the packaged level-zero bytes and uses the trusted original village shader profile. A matched-camera review of the packaged village against upstream and the Flip7 is still required before claiming visual parity; see [the village material asset contract](schemas/village-materials.md).

## WebGL fallback check, 2026-10-10

The hosted page initially reported `WebGL fallback failed (Cannot read properties of undefined (reading 'WebGLRenderer'))` after WebGPU adapter creation failed. `three@0.180` exposes `WebGLRenderer` as a named ESM export, not a default export. Commit `58f253c` changed the lazy import to use the module namespace and added a regression check. The Pages workflow succeeded, and the live page showed build stamp `58f253c8`; its fallback error changed to `WebGL fallback failed (Error creating WebGL context.)`. That confirms the module import defect is fixed and the renderer constructor was reached. This Chrome session has neither a usable WebGPU adapter nor a usable WebGL context, so it still cannot verify scene rendering. No game click or pointer-lock request was used. The separate `npm run test:webgl-backend` check and production build pass.
