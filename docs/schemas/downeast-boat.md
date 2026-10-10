# Hosted Downeast boat component

`tidewater.downeast-boat/1` attaches the reviewed, built-in lobster-boat model and physics controller to one signed berth in a hosted ThruHold. The component is data-only; a world cannot supply scripts, forces, or arbitrary controller settings.

```json
{
  "id": "tw-component:island-lobster-boat",
  "type": "tidewater.downeast-boat/1",
  "objectId": "tw-object:moored-lobster-boat",
  "priority": "portal-preview"
}
```

The referenced object is a collision-free `asset-instance` marker. It must have `priority: "portal-preview"`, unit scale, a yaw-only transform, and an asset declared in the signed manifest as a `glb` with `portal-preview` priority. The transform's position is the boat's local design-waterline origin; its yaw is the home heading. The GLB remains authored/reproducible world content, while the runtime uses the bundled `BoatModel` implementation for animation and physical interaction.

A world may contain at most one boat and must declare `rules.seaLevel` plus either exactly one `tidewater.island-ocean/1` component or at least one `tidewater.water-body/1`. For portable water, the berth must lie within one body's bounds. The owner source validator, manifest converter, Go daemon, and browser enforce this contract.

The boat component is staged at portal-preview priority. Its model appears in an open portal before crossing; only the active world's controller runs physics. Entering the water without terrain collisions uses the shared ocean FFT query surface. A descending player lands on its walkable deck, remains attached while the hull rocks, can press E at the helm, and can drive with the existing boat controls. `worldd` still serves immutable content and signed records; it does not simulate boat physics.

This first contract reuses the original island's boat implementation and does not define a generic vehicle framework, remote player replication, fishing interactions in arbitrary worlds, or portable wildlife. Those behaviors require separate versioned components.

## Portal transport

Cross-world transfer is opt-in at the destination. Set `rules.vehiclePolicy` to
`{"enabled":true,"maxSpeed":8,"maxCombinedComplexity":100000}` and include a
`tidewater.downeast-boat/1` component with a valid berth. The bundled client maps
boat pose and motion through the portal, restores helm or deck mode, and enforces
the destination speed ceiling. A destination that rejects the vehicle or exceeds
its combined avatar-plus-boat triangle budget holds the visitor at the threshold
and hides an open preview. See [portal authoring](../portal-authoring.md#vehicle-entry-rules).
