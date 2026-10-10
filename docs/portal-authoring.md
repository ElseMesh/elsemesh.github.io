# Adding and sharing portals

A portal belongs to its ThruHold's editable `world-source.json`. Author it in Blender using [world authoring](world-authoring.md), or propose a `portal.add` / `portal.update` operation through the [AI editor service](ai-editor-worker.md). Review the source and geometry before owner publication. There is no in-game placement editor.

## Place a doorway

Coordinates use right-handed Y-up meters; yaw is radians around Y. `entry.position` is the doorway opening's center in your world; `exit.position` is the corresponding opening center in the destination world. The doorway's normal follows `[sin(yaw), 0, cos(yaw)]`. Agree both frames with the destination owner. The current aperture is 2.42 m wide and 4.9 m high; place it above traversable ground with clearance on both sides. The frame must not collide with the doorway opening.

A minimal front route is:

```json
{
  "id": "tw-portal:alice-to-bob",
  "destinationWorldId": "tw-world:bob",
  "entry": { "position": [0, 2.5, 5], "yaw": 0 },
  "exit": { "position": [10, 2.5, 0], "yaw": 1.5707963267948966 },
  "openView": true,
  "enabled": true,
  "visual": "timber"
}
```

Append it to Alice's source `portals` array. `openView` requests a view of the destination before crossing; `enabled` controls crossing. Optional `destinationPeerId` pins a content provider and `destinationGateway` names its HTTPS/WSS gateway. Omit them to use discovery. A provider address is a routing hint, not proof of ownership or a permission grant.

## Two independently routed sides

The legacy front fields above remain the front route. Add an optional `back` object with its own `destinationWorldId`, `exit`, `openView`, `enabled`, and optional destination provider/gateway. Its entry uses the same position with `entry.yaw + π`: it faces the other way. Add `tidewater.portal-two-sided/1` to `rules.requiredFeatures` so older clients refuse an unsupported world rather than interpreting the doorway incorrectly.

The back can lead to another world. To use the same destination, give its exit the same position as the front exit with opposite yaw. This lets the two directions arrive facing opposite ways. Omitting `back` leaves the back unconfigured; it does not create an automatic return route. Each destination owner's complementary doorway is a separate authored record.

### Vehicle entry rules

The bundled Downeast boat can cross a portal only when the destination explicitly opts in and declares a compatible `tidewater.downeast-boat/1` berth. Add these destination rules:

```json
"vehiclePolicy": {
  "enabled": true,
  "maxSpeed": 8,
  "maxCombinedComplexity": 100000
}
```

`maxSpeed` caps the boat's world-space speed in meters per second after the handoff. `maxCombinedComplexity` must accommodate the destination's configured `avatarComplexity` plus the bundled boat's measured triangle count. If the policy is omitted or disabled, the destination has no compatible berth, or its complexity budget is exceeded, crossing is held at the threshold and an open-portal preview is hidden while the visitor is aboard or at the helm. The boat pose, orientation, linear and angular velocity, and helm state transfer to the destination boat; the destination speed cap applies immediately. This is client runtime enforcement; authoritative server-side vehicle simulation and anti-cheat remain part of multiplayer simulation work.

## Share one side with a friend

After Alice has agreed Bob's destination frame, export a small JSON connection document:

```sh
node tools/portal-link.mjs export \
  --source alice.world-source.json --id tw-portal:alice-to-bob \
  --side front --out alice-to-bob.link.json \
  --gateway https://alice.example --node-id ALICE_NODE_PEER_ID
```

Use the actual reachable gateway and PeerID; omit those two options when discovery is sufficient. `--side back` exports the independently configured back route instead. Send the JSON file to the destination owner through your chosen messaging/file-sharing channel. It uses the data-only `elsemesh.portal-link/1` protocol and carries world IDs, source portal ID/side, source entry frame, intended destination exit frame and optional source provider. It carries no signing keys, publication authority, scripts, or permission grants, and is not an invitation token granting access to a private world.

Bob imports it against his exact source snapshot:

```sh
node tools/portal-link.mjs import \
  --source bob.world-source.json --link alice-to-bob.link.json \
  --id tw-portal:bob-to-alice --out bob-return.proposal.json
node tools/apply-world-proposal.mjs \
  --source bob.world-source.json --proposal bob-return.proposal.json \
  --out bob.candidate.world-source.json
```

The import requires Bob's world ID to equal the shared target world ID. It produces a front-only complementary doorway: entry is Alice's destination exit facing the opposite way; exit is Alice's source entry facing the opposite way. Thus arrival faces away from the return doorway. The proposal binds the SHA-256 of Bob's exact source bytes; editing the source after import requires regeneration. New IDs must not already exist. Tools refuse to overwrite output files.

Review `bob.candidate.world-source.json` against the original, inspect placement in Blender, and independently confirm Alice's identity and addresses. A shared file is unsigned authoring information; trust comes from the owner-signed manifests checked at runtime. Moving either doorway or changing its intended exit requires re-sharing and updating the other owner's complementary record. Sharing both sides requires two exports and independent imports by their respective destination owners. There is no automatic two-owner synchronization.

## Publish and test both ends

Alice reviews and publishes her authored source through her own persistent owner profile. Bob publishes his candidate through his profile:

```sh
node tools/publish-world-source.mjs \
  --worldd ./worldd --data ~/.config/elsemesh/worlds/bob \
  --base-source bob.world-source.json \
  --source bob.candidate.world-source.json --assets bob-assets
```

Use the build-tree CLI and the actual profile/assets paths; keep source edits in the source tree. The [owner publication workflow](account-roles.md#owner-publication) validates the current signed source hash and owner identity, verifies assets, signs the next manifest revision and archives the previous revision. Restart Bob's daemon after publication, then keep the accepted candidate as the versioned source for future edits. Alice uses the same workflow with her own source and profile. Each owner retains their own keys.

Run both nodes as in [testing two worlds](testing-two-worlds.md), with reachable discovery/routing between them. Inspect the preview before crossing, enter from each configured side, verify arrival orientation and return travel, and check blocked/disabled routes. Destination availability, permissions, required features and travel rules still determine whether viewing/crossing is allowed. This CLI adds reviewable metadata; it does not establish network reachability or silently publish worlds.

## Validation

`node test/portal-link.mjs` checks complementary orientations, separate back destinations, target-world mismatch, source-hash binding, closed bounded fields and an actual CLI export/import roundtrip. Source files are capped at 16 MiB; links at 16 KiB. Frames, identifiers and provider URLs are bounded, and arbitrary extra fields are rejected. These checks do not substitute for a visual two-owner crossing check.

## Runtime implementation and remaining checks

The signed front/back route is selected from the viewer's side of the plane.
Crossings retain the approach-side route even after the camera crosses the
threshold. Each side has a separate preparation key; the back uses the opposite
entry orientation for both preview-camera mapping and player handoff. One physical
frame serves both sides, including when only the back route is enabled.

Tests exercise both App route selections and crossing paths, independent
preparation keys, same-world opposite-facing exits, matching preview/player
transforms, and pose/momentum round trips through an exported/imported return
portal. The production build and focused Go contract checks pass. Live visual
checks with two owner-published worlds, Flip7 traversal and destination travel-rule
enforcement remain outstanding; these tests do not establish those outcomes.
