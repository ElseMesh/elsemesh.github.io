import assert from 'node:assert/strict';
import { alignPortalPreview, crossedPortalPlane, mapPortalCamera, mapPortalPlayerState, mapPortalVehicleState, portalExitClipPlane, rotatePortalVelocity, updatePortalPreviewComponents } from '../src/network/PortalHandoff.js';
import { PerspectiveCamera } from '../src/engine/scene/Camera.js';
import { Vector3 } from '../src/engine/math/Vector3.js';
import { Quaternion } from '../src/engine/math/Quaternion.js';
import { Vector4 } from '../src/engine/math/Vector4.js';
import { Material } from '../src/engine/render/Material.js';
import { buildMeshShader } from '../src/engine/render/MeshShader.js';
import { validateWorldSource } from '../src/network/WorldSource.js';
import { validateWorldComponents, validateWorldHosts, validateWorldPortals } from '../src/network/WorldConnector.js';
import { createWorldInviteURL, worldLinkFromLocation, WorldConnector } from '../src/network/WorldConnector.js';
import { validateWorldRequirements } from '../src/network/WorldRules.js';
import { VEGETATION_PLACEMENT_KINDS, decodeVegetationPlacements, encodeVegetationPlacements } from '../src/network/VegetationPlacements.js';
import { disposeWorldPackage, loadWorldPackage } from '../src/network/WorldPackage.js';

const portal = { entry: { position: [ 0, 1, 0 ], yaw: 0 } };
const previewDeltas = [];
const previewCamera = {};
const previewComponents = [ { update( dt, camera ) { previewDeltas.push( [ dt, camera ] ); } }, {} ];
assert.equal( updatePortalPreviewComponents( previewComponents, 1000, -Infinity, previewCamera ), 0, 'first portal render starts without a synthetic time jump' );
assert.equal( updatePortalPreviewComponents( previewComponents, 1100, 1000, previewCamera ), 0.1, 'portal animations advance during the normal 10 Hz preview cadence' );
assert.equal( updatePortalPreviewComponents( previewComponents, 5000, 1100, previewCamera ), 0.1, 'portal animation delta is capped after a hidden or paused interval' );
assert.equal( updatePortalPreviewComponents( previewComponents, 4900, 5000, previewCamera ), 0, 'out-of-order preview timestamps do not reverse component time' );
assert.ok( previewDeltas.every( ( [ _dt, camera ] ) => camera === previewCamera ), 'preview components receive the mapped destination camera' );
assert.deepEqual( previewDeltas.map( ( [ dt ] ) => dt ), [ 0, 0.1, 0.1, 0 ], 'all preview components receive the bounded animation delta' );
const sequentialFailoverGrants = [
	{ peerId: '12D3KooWAbcdefghijk1234567890123456', scopes: [ 'failover-authority' ], expiresAt: 2000, epoch: 1, failoverAfter: 1000, failoverSeconds: 60 },
	{ peerId: '12D3KooWAbcdefghijk1234567890123457', scopes: [ 'failover-authority' ], expiresAt: 2000, epoch: 1, failoverAfter: 1060, failoverSeconds: 60 },
];
assert.doesNotThrow( () => validateWorldHosts( sequentialFailoverGrants ), 'adjacent failover grants can provide sequential redundancy' );
assert.throws( () => validateWorldHosts( [ sequentialFailoverGrants[ 0 ], { ...sequentialFailoverGrants[ 1 ], failoverAfter: 1059 } ] ), /overlapping/, 'client rejects owner grants that could activate two failover authorities in the same epoch' );
assert.equal( crossedPortalPlane( { x: 0, y: 1, z: 1 }, { x: 0, y: 1, z: - 0.1 }, portal ), true, 'front-to-back crossing transfers' );
assert.equal( crossedPortalPlane( { x: 0, y: 1, z: - 1 }, { x: 0, y: 1, z: 0.1 }, portal ), false, 'back-to-front crossing does not transfer' );
assert.equal( crossedPortalPlane( { x: 2, y: 1, z: 1 }, { x: 2, y: 1, z: - 0.1 }, portal ), false, 'crossings outside the doorway width do not transfer' );
assert.equal( crossedPortalPlane( { x: 0, y: 4, z: 1 }, { x: 0, y: 4, z: - 0.1 }, portal ), false, 'crossings above the doorway do not transfer' );
assert.equal( crossedPortalPlane( { x: 1, y: 1, z: 1 }, { x: - 1, y: 1, z: - 1 }, { entry: { position: [ 0, 1, 0 ], yaw: Math.PI / 2 } } ), true, 'portal yaw rotates the entry plane' );

const velocity = rotatePortalVelocity( { x: 0, z: - 1 }, 0, Math.PI / 2 );
assert.ok( Math.abs( velocity.x + 1 ) < 1e-9 && Math.abs( velocity.z ) < 1e-9, 'velocity follows the destination orientation' );
assert.equal( velocity.y, 0, 'legacy horizontal velocity inputs have a finite vertical component' );
const boatState = { position: new Vector3( 1, 2, 3 ), quaternion: new Quaternion(), velocity: new Vector3( 0, 1, 4 ), angular: new Vector3( 1, 2, 3 ) };
boatState.quaternion.setFromAxisAngle( new Vector3( 0, 1, 0 ), 0.25 );
const mappedBoat = mapPortalVehicleState( boatState, { position: [ 0, 0, 0 ], yaw: 0 }, { position: [ 20, 0, 0 ], yaw: Math.PI / 2 } );
assert.ok( mappedBoat.position.distanceTo( new Vector3( 23, 2, - 1 ) ) < 1e-9, 'vehicle origin follows the portal transform' );
assert.ok( mappedBoat.velocity.distanceTo( new Vector3( 4, 1, 0 ) ) < 1e-9, 'vehicle velocity follows the portal transform' );
assert.ok( mappedBoat.angular.distanceTo( new Vector3( 3, 2, - 1 ) ) < 1e-9, 'vehicle angular velocity follows the portal transform' );
for ( const verticalSpeed of [ 4.6, - 9.81, 0 ] ) {
	const entry = { position: [ 2, 3, - 7 ], yaw: - 0.4 };
	const exit = { position: [ - 10, 5, 20 ], yaw: 1.2 };
	const state = { position: new Vector3( 2.4, 4.1, - 7.2 ), velocity: new Vector3( 1, verticalSpeed, - 3 ), yaw: 0.7, pitch: - 0.2 };
	const arrival = mapPortalPlayerState( state, entry, exit );
	assert.equal( arrival.velocity.y, verticalSpeed, 'crossing preserves jumping, falling and resting vertical speeds' );
	assert.ok( Math.abs( Math.hypot( arrival.velocity.x, arrival.velocity.z ) - Math.hypot( state.velocity.x, state.velocity.z ) ) < 1e-9, 'crossing preserves horizontal speed' );
	assert.equal( arrival.yaw, state.yaw + exit.yaw - entry.yaw, 'crossing preserves view relative to the doorway' );
	assert.equal( arrival.pitch, state.pitch, 'crossing preserves look pitch' );
	assert.ok( Math.abs( arrival.position.y - 6.1 ) < 1e-9, 'crossing preserves vertical position relative to the threshold' );
	const sourceView = new PerspectiveCamera();
	sourceView.position.copy( state.position );
	const destinationView = new PerspectiveCamera();
	mapPortalCamera( sourceView, destinationView, entry, exit );
	assert.ok( arrival.position.distanceTo( destinationView.position ) < 1e-9, 'arrival matches the view already shown through the portal' );
	const returned = mapPortalPlayerState( arrival, exit, entry );
	assert.ok( returned.position.distanceTo( state.position ) < 1e-9, 'reverse transform restores position without drift' );
	assert.ok( Math.abs( returned.yaw - state.yaw ) < 1e-9 && returned.pitch === state.pitch, 'reverse transform restores view' );
	assert.ok( Math.hypot( returned.velocity.x - state.velocity.x, returned.velocity.y - state.velocity.y, returned.velocity.z - state.velocity.z ) < 1e-9, 'reverse transform restores all momentum components' );
}


const preview = { position: { set( x, y, z ) { this.x = x; this.y = y; this.z = z; } }, rotation: { y: 0 } };
alignPortalPreview( preview, { position: [ 10, 2, 20 ], yaw: Math.PI / 2 }, { position: [ 3, 4, 5 ], yaw: 0 } );
assert.ok( Math.abs( preview.position.x - 5 ) < 1e-9 && Math.abs( preview.position.y + 2 ) < 1e-9 && Math.abs( preview.position.z - 23 ) < 1e-9, 'preview aligns destination exit position with the local portal entry' );
assert.ok( Math.abs( preview.rotation.y - Math.PI / 2 ) < 1e-9, 'preview aligns destination exit orientation with the local portal entry' );

const sourceCamera = new PerspectiveCamera();
sourceCamera.position.set( 0, 1, 2 );
sourceCamera.rotation.y = 0;
sourceCamera.updateMatrixWorld( true );
const destinationCamera = new PerspectiveCamera();
mapPortalCamera( sourceCamera, destinationCamera, { position: [ 0, 0, 0 ], yaw: 0 }, { position: [ 10, 2, 20 ], yaw: Math.PI / 2 } );
const destinationDirection = destinationCamera.getWorldDirection( new Vector3() );
assert.ok( Math.abs( destinationCamera.position.x - 12 ) < 1e-9 && Math.abs( destinationCamera.position.y - 3 ) < 1e-9 && Math.abs( destinationCamera.position.z - 20 ) < 1e-9, 'portal camera position maps from entry coordinates into the destination' );
assert.ok( Math.abs( destinationDirection.x + 1 ) < 1e-9 && Math.abs( destinationDirection.z ) < 1e-9, 'portal camera direction rotates through the destination orientation' );
assert.equal( destinationCamera.userData.portalObliqueClipApplied, true, 'portal camera applies an oblique reversed-depth clip plane' );
const projectedPortalDepth = ( point ) => new Vector4( ...point, 1 ).applyMatrix4( destinationCamera.matrixWorldInverse ).applyMatrix4( destinationCamera.projectionMatrix );
const destinationSide = projectedPortalDepth( [ 8, 3, 20 ] );
const portalThreshold = projectedPortalDepth( [ 10, 3, 20 ] );
const cameraSide = projectedPortalDepth( [ 12, 3, 20 ] );
assert.ok( destinationSide.z >= 0 && destinationSide.z <= destinationSide.w, 'oblique projection keeps destination-side content inside the WebGPU clip volume' );
assert.ok( Math.abs( portalThreshold.z - portalThreshold.w ) < 1e-8, 'oblique projection places the portal exit exactly on the near plane' );
assert.ok( cameraSide.z > cameraSide.w, 'oblique projection clips content on the virtual camera side of the exit plane' );
const exitClipPlane = portalExitClipPlane( { position: [ 10, 2, 20 ], yaw: Math.PI / 2 } );
const clipDistance = ( point ) => exitClipPlane[ 0 ] * point[ 0 ] + exitClipPlane[ 1 ] * point[ 1 ] + exitClipPlane[ 2 ] * point[ 2 ] + exitClipPlane[ 3 ];
assert.ok( clipDistance( [ 12, 3, 20 ] ) > 0 && clipDistance( [ 8, 3, 20 ] ) < 0, 'exit-plane clipping keeps destination-side geometry and rejects geometry on the virtual camera side' );
const clippedShader = buildMeshShader( new Material( { lit: false } ), [ { name: 'position', location: 0, wgsl: 'vec3f' } ], { kind: 'main', defines: { PORTAL_CLIP: 1 } } );
assert.match( clippedShader.code, /frame\.portalClipPlane/, 'portal render pipelines discard fragments using the per-view exit plane' );

const source = {
	protocol: 'tidewater.world-source/1', worldId: 'tw-world:source', title: 'Source',
	coordinateSystem: 'right-handed-y-up-meters', styleGuide: '',
	rules: { gravity: 1, avatarComplexity: 1000, physicsProfile: 'tidewater-default' },
	objects: [], updatedAt: '2026-09-30T12:00:00Z',
	portals: [ {
		id: 'tw-portal:door', destinationWorldId: 'tw-world:destination', destinationPeerId: '12D3KooW12345678901234567890',
		destinationGateway: 'https://world.example', entry: { position: [ 0, 0, 0 ], yaw: 0 },
		exit: { position: [ 0, 0, 0 ], yaw: 0 }, openView: true, enabled: true,
	} ],
};
assert.doesNotThrow( () => validateWorldSource( source ), 'portal may pin a separate secure destination gateway' );
assert.doesNotThrow( () => validateWorldSource( { ...source, portals: [ { ...source.portals[ 0 ], visual: 'timber' } ] } ), 'source accepts a supported optional portal frame style' );
assert.throws( () => validateWorldSource( { ...source, portals: [ { ...source.portals[ 0 ], visual: 'glass' } ] } ), /Invalid or duplicate portal record/, 'source rejects unsupported portal frame styles' );
const discoveredSourcePortal = { ...source.portals[ 0 ] };
delete discoveredSourcePortal.destinationPeerId;
assert.doesNotThrow( () => validateWorldSource( { ...source, portals: [ discoveredSourcePortal ] } ), 'portal can resolve providers by stable destination world ID' );
assert.throws( () => validateWorldSource( { ...source, portals: [ { ...discoveredSourcePortal, destinationPeerId: 'invalid' } ] } ), /Invalid or duplicate portal record/, 'portal rejects malformed optional provider identities' );
assert.throws( () => validateWorldSource( { ...source, portals: [ { ...source.portals[ 0 ], destinationGateway: 'http://world.example' } ] } ), 'insecure destination gateways must be rejected' );
const runtimePortal = { id: 'tw-portal:runtime-door', destinationWorldId: 'tw-world:destination', destinationPeerId: '12D3KooW12345678901234567890', entry: { position: [ 0, 0, 0 ], yaw: 0 }, exit: { position: [ 0, 0, 0 ], yaw: 0 }, openView: true, enabled: true };
const runtimeIDs = new Set( [ 'tw-object:asset' ] );
assert.doesNotThrow( () => validateWorldPortals( [ runtimePortal ], runtimeIDs ), 'browser accepts a valid signed portal' );
assert.doesNotThrow( () => validateWorldPortals( [ { ...runtimePortal, visual: 'stone' } ] ), 'browser accepts signed portal frame styles' );
assert.throws( () => validateWorldPortals( [ { ...runtimePortal, visual: 'glass' } ] ), /unsupported visual style/, 'browser rejects unknown signed portal frame styles' );
const discoverableRuntimePortal = { ...runtimePortal };
delete discoverableRuntimePortal.destinationPeerId;
assert.doesNotThrow( () => validateWorldPortals( [ discoverableRuntimePortal ] ), 'browser permits world-ID discovery when the portal does not pin a provider' );
assert.throws( () => validateWorldPortals( [ { ...runtimePortal, id: 'tw-object:asset' } ], new Set( [ 'tw-object:asset' ] ) ), /duplicate portal ID/, 'browser rejects cross-kind entity ID collisions' );
assert.throws( () => validateWorldPortals( [ { ...runtimePortal, destinationGateway: 'http://world.example' } ] ), /destination gateway/, 'browser rejects insecure portal gateways' );
const framedWorld = await loadWorldPackage( {
	worldId: 'tw-world:framed', manifest: { objects: [], components: [], portals: [ { ...runtimePortal, visual: 'timber' } ] },
}, { assets: new Map() } );
const portalFrame = framedWorld.children.find( ( child ) => child.userData.worldPortalFrame === runtimePortal.id );
assert.ok( portalFrame, 'authored portal frame is included in the portable world scene' );
assert.equal( portalFrame.children.length, 3, 'portal frame contains two jambs and a lintel' );
assert.deepEqual( portalFrame.children.map( ( child ) => child.geometry.parameters ), [
	{ width: 0.18, height: 5.08, depth: 0.28, widthSegments: 1, heightSegments: 1, depthSegments: 1 },
	{ width: 0.18, height: 5.08, depth: 0.28, widthSegments: 1, heightSegments: 1, depthSegments: 1 },
	{ width: 2.78, height: 0.18, depth: 0.28, widthSegments: 1, heightSegments: 1, depthSegments: 1 },
], 'portal frame geometry leaves the opening clear and surrounds the preview aperture' );
disposeWorldPackage( framedWorld );
assert.throws( () => validateWorldComponents( [ { id: 'tw-component:duplicate', type: 'tidewater.procedural-island-vegetation/1', seed: 7 } ], { requiredFeatures: [ 'tidewater.procedural-island-vegetation/1' ] }, new Set( [ 'tw-component:duplicate' ] ) ), /duplicate component ID/, 'browser rejects duplicate IDs across entity kinds' );
const islandOcean = { id: 'tw-component:island-ocean', type: 'tidewater.island-ocean/1', priority: 'portal-preview' };
assert.doesNotThrow( () => validateWorldComponents( [ islandOcean ], { requiredFeatures: [ islandOcean.type ] } ), 'browser accepts the versioned example-island ocean component' );
assert.doesNotThrow( () => validateWorldRequirements( { rules: { gravity: 1, avatarComplexity: 1, physicsProfile: 'default', requiredFeatures: [ islandOcean.type ] } } ), 'browser recognizes the example-ocean runtime capability' );
assert.throws( () => validateWorldComponents( [ { ...islandOcean, seaLevel: 3 } ], { requiredFeatures: [ islandOcean.type ] } ), /Unsupported or invalid world component/, 'browser rejects undeclared island-ocean parameters' );
assert.throws( () => validateWorldComponents( [ islandOcean, { ...islandOcean, id: 'tw-component:island-ocean-copy' } ], { requiredFeatures: [ islandOcean.type ] } ), /only one island ocean/, 'browser rejects duplicate infinite ocean components' );
const waterBody = { id: 'tw-component:water-body', type: 'tidewater.water-body/1', center: [ -20, 45 ], extent: 256, priority: 'visible' };
const waterRules = { seaLevel: 3, requiredFeatures: [ waterBody.type ] };
assert.doesNotThrow( () => validateWorldComponents( [ waterBody ], waterRules ), 'browser accepts a bounded terrain-independent deep-water component' );
assert.doesNotThrow( () => validateWorldComponents( [ { ...waterBody, profile: 'calm-lagoon' } ], waterRules ), 'browser accepts a named water profile' );
assert.throws( () => validateWorldComponents( [ { ...waterBody, profile: 'custom-shader' } ], waterRules ), /Unsupported or invalid world component/, 'browser rejects unknown water material profiles' );
assert.throws( () => validateWorldComponents( [ waterBody ], { ...waterRules, seaLevel: undefined } ), /requires seaLevel/, 'portable water requires a declared world sea level' );
assert.throws( () => validateWorldComponents( [ { ...waterBody, extent: 7 } ], waterRules ), /Unsupported or invalid world component/, 'portable water enforces a useful bounded extent' );
assert.throws( () => validateWorldComponents( [ { ...waterBody, center: [ 1000000, 0 ] } ], waterRules ), /Unsupported or invalid world component/, 'portable water bounds the full square inside world coordinate limits' );
const fourWaterBodies = [ -900, -300, 300, 900 ].map( ( x, index ) => ( { ...waterBody, id: `tw-component:water-${index + 1}`, center: [ x, 0 ], extent: 100 } ) );
assert.doesNotThrow( () => validateWorldComponents( fourWaterBodies, waterRules ), 'browser accepts four non-overlapping portable water bodies' );
assert.throws( () => validateWorldComponents( [ ...fourWaterBodies, { ...fourWaterBodies[ 3 ], id: 'tw-component:water-5', center: [ 1500, 0 ] } ], waterRules ), /at most four/, 'browser limits worlds to four portable water bodies' );
assert.throws( () => validateWorldComponents( [ waterBody, { ...waterBody, id: 'tw-component:overlap', center: [ 120, 45 ] } ], waterRules ), /bounds cannot overlap/, 'browser rejects overlapping portable water bounds' );
assert.throws( () => validateWorldComponents( [ waterBody, islandOcean ], { ...waterRules, requiredFeatures: [ waterBody.type, islandOcean.type ] } ), /combine portable water and island-ocean|cannot be combined/, 'portable water cannot silently stack with island-specific water' );
const boatAssetID = `sha256:${'c'.repeat( 64 )}`;
const boatBerth = { id: 'tw-object:boat-berth', kind: 'asset-instance', label: 'Boat berth', assetId: boatAssetID, priority: 'portal-preview', transform: { position: [ 0, 0, 0 ], yaw: 0 }, scale: [ 1, 1, 1 ], collision: { shape: 'none', enabled: false } };
const hostedBoat = { id: 'tw-component:hosted-boat', type: 'tidewater.downeast-boat/1', objectId: boatBerth.id, priority: 'portal-preview' };
const boatWorldRules = { seaLevel: 0, requiredFeatures: [ islandOcean.type, hostedBoat.type ] };
const boatAssets = [ { id: boatAssetID, kind: 'glb', priority: 'portal-preview', bytes: 10 } ];
assert.doesNotThrow( () => validateWorldComponents( [ islandOcean, hostedBoat ], boatWorldRules, new Set(), boatAssets, [ boatBerth ] ), 'browser accepts a signed boat component linked to a staged collision-free berth preview' );
assert.throws( () => validateWorldComponents( [ islandOcean, hostedBoat ], boatWorldRules, new Set(), [], [ boatBerth ] ), /invalid berth preview object/, 'browser rejects a boat berth asset that is not declared in the manifest' );
assert.throws( () => validateWorldComponents( [ islandOcean, hostedBoat ], boatWorldRules, new Set(), [ { ...boatAssets[ 0 ], kind: 'audio/ogg' } ], [ boatBerth ] ), /invalid berth preview object/, 'browser rejects a non-GLB boat berth asset' );
assert.throws( () => validateWorldComponents( [ islandOcean, hostedBoat ], boatWorldRules, new Set(), [ { ...boatAssets[ 0 ], priority: 'background' } ], [ boatBerth ] ), /invalid berth preview object/, 'browser requires the boat berth preview asset to be staged before portal entry' );
assert.throws( () => validateWorldComponents( [ islandOcean, hostedBoat ], boatWorldRules, new Set(), boatAssets, [ { ...boatBerth, collision: { shape: 'box', enabled: false } } ] ), /invalid berth preview object/, 'boat berth previews must remain collision-free static markers' );
assert.doesNotThrow( () => validateWorldSource( { ...source, rules: { ...source.rules, seaLevel: 0, requiredFeatures: [ islandOcean.type, hostedBoat.type ] }, objects: [ boatBerth ], components: [ islandOcean, hostedBoat ] } ), 'authoring source accepts a data-only boat berth and ocean contract' );
assert.throws( () => validateWorldSource( { ...source, rules: { ...source.rules, requiredFeatures: [ hostedBoat.type ] }, objects: [ boatBerth ], components: [ hostedBoat ] } ), /requires seaLevel and a declared water renderer/, 'authoring requires a world sea level and water renderer for a boat' );
assert.doesNotThrow( () => validateWorldSource( { ...source, rules: { ...source.rules, seaLevel: 3, requiredFeatures: [ waterBody.type ] }, components: [ waterBody ] } ), 'authoring source accepts portable bounded deep water' );
assert.doesNotThrow( () => validateWorldSource( { ...source, rules: { ...source.rules, seaLevel: 3, requiredFeatures: [ waterBody.type ] }, components: fourWaterBodies } ), 'authoring accepts four non-overlapping portable water bodies' );
assert.throws( () => validateWorldSource( { ...source, rules: { ...source.rules, seaLevel: 3, requiredFeatures: [ waterBody.type ] }, components: [ ...fourWaterBodies, { ...fourWaterBodies[ 3 ], id: 'tw-component:water-5', center: [ 1500, 0 ] } ] } ), /at most four/, 'authoring enforces the portable water body limit' );
assert.throws( () => validateWorldSource( { ...source, rules: { ...source.rules, seaLevel: 3, requiredFeatures: [ waterBody.type ] }, components: [ waterBody, { ...waterBody, id: 'tw-component:overlap', center: [ 120, 45 ] } ] } ), /bounds cannot overlap/, 'authoring rejects overlapping portable water bounds' );
assert.doesNotThrow( () => validateWorldSource( { ...source, rules: { ...source.rules, seaLevel: 3, requiredFeatures: [ waterBody.type ] }, components: [ { ...waterBody, profile: 'storm' } ] } ), 'authoring accepts a named storm profile' );
assert.throws( () => validateWorldSource( { ...source, rules: { ...source.rules, requiredFeatures: [ waterBody.type ] }, components: [ waterBody ] } ), /requires seaLevel/, 'authoring requires a world sea level for portable water' );
const placementAssetId = `sha256:${'a'.repeat( 64 )}`;
const vegetationComponent = { id: 'tw-component:portable-vegetation', type: 'tidewater.procedural-island-vegetation/1', seed: 7, placementAssetId };
const placementAsset = [ { id: placementAssetId, kind: 'vegetation-placement/1', priority: 'portal-preview' } ];
assert.doesNotThrow( () => validateWorldComponents( [ vegetationComponent ], { requiredFeatures: [ vegetationComponent.type ] }, new Set(), placementAsset ), 'browser accepts a declared JSON placement asset available for portal preview' );
assert.throws( () => validateWorldComponents( [ vegetationComponent ], { requiredFeatures: [ vegetationComponent.type ] }, new Set(), [] ), /placement asset reference/, 'browser rejects a component that points at undeclared placement data' );
assert.throws( () => validateWorldComponents( [ { ...vegetationComponent, extra: true } ], { requiredFeatures: [ vegetationComponent.type ] }, new Set(), placementAsset ), /Unsupported or invalid world component/, 'browser rejects unknown fields on signed vegetation components' );
assert.throws( () => validateWorldSource( { ...source, rules: { ...source.rules, requiredFeatures: [ vegetationComponent.type ] }, components: [ { ...vegetationComponent, extra: true } ] } ), /Invalid or duplicate world component/, 'authoring rejects unknown fields on vegetation components' );
const portablePlacements = { villagePalms: 0, ...Object.fromEntries( VEGETATION_PLACEMENT_KINDS.map( ( kind ) => [ kind, [] ] ) ) };
const portablePlacementBytes = encodeVegetationPlacements( portablePlacements, 12345 );
assert.deepEqual( decodeVegetationPlacements( portablePlacementBytes ), portablePlacements, 'terrain-independent placement data accepts its own deterministic embedded seed' );
const staticVegetation = { id: 'tw-component:static-foliage', type: 'tidewater.static-vegetation/1', placementAssetId };
assert.doesNotThrow( () => validateWorldComponents( [ staticVegetation ], { requiredFeatures: [ staticVegetation.type ] }, new Set(), placementAsset ), 'browser accepts portable world-space foliage placements' );
assert.throws( () => validateWorldComponents( [ { id: staticVegetation.id, type: staticVegetation.type } ], { requiredFeatures: [ staticVegetation.type ] } ), /requires placement data/, 'browser requires a placement asset for static vegetation' );
assert.doesNotThrow( () => validateWorldSource( { ...source, rules: { ...source.rules, requiredFeatures: [ staticVegetation.type ] }, components: [ staticVegetation ] } ), 'authoring accepts portable static vegetation without island-only seed fields' );
const boundedStaticVegetation = { ...staticVegetation, priority: 'visible', streamingBounds: { center: [ 0, 2, -10 ], radius: 12 } };
const visiblePlacementAsset = [ { ...placementAsset[ 0 ], priority: 'visible' } ];
assert.doesNotThrow( () => validateWorldComponents( [ boundedStaticVegetation ], { requiredFeatures: [ staticVegetation.type ] }, new Set(), visiblePlacementAsset ), 'browser accepts bounded component data whose asset has the same staged priority' );
assert.doesNotThrow( () => validateWorldSource( { ...source, rules: { ...source.rules, requiredFeatures: [ staticVegetation.type ] }, components: [ boundedStaticVegetation ] } ), 'authoring accepts signed world-space bounds on component data' );
assert.throws( () => validateWorldSource( { ...source, rules: { ...source.rules, requiredFeatures: [ staticVegetation.type ] }, components: [ { ...boundedStaticVegetation, streamingBounds: { center: [ 0, 0 ], radius: 0 } } ] } ), /Invalid or duplicate world component/, 'authoring rejects malformed component bounds' );
assert.throws( () => validateWorldComponents( [ boundedStaticVegetation ], { requiredFeatures: [ staticVegetation.type ] }, new Set(), placementAsset ), /placement asset reference/, 'browser rejects component data whose component and asset priorities disagree' );
const staticReef = { id: 'tw-component:reef-tile', type: 'tidewater.static-reef/1', priority: 'visible', placementAssetId: 'sha256:' + '3'.repeat( 64 ), streamingBounds: { center: [ 1, -4, 8 ], radius: 32 } };
assert.doesNotThrow( () => validateWorldComponents( [ staticReef ], { requiredFeatures: [ staticReef.type ] }, new Set(), [ { id: staticReef.placementAssetId, kind: 'reef-placement/1', priority: 'visible' } ] ), 'browser validates reef placement assets and bounded component tiers' );
assert.throws( () => validateWorldComponents( [ staticReef ], { requiredFeatures: [ staticReef.type ] }, new Set(), [ { id: staticReef.placementAssetId, kind: 'vegetation-placement/1', priority: 'visible' } ] ), /placement asset reference/, 'reef components cannot consume vegetation placement assets' );
assert.doesNotThrow( () => validateWorldSource( { ...source, rules: { ...source.rules, requiredFeatures: [ staticReef.type ] }, components: [ staticReef ] } ), 'authoring accepts bounded static reef tiles' );
assert.throws( () => validateWorldSource( { ...source, rules: { ...source.rules, requiredFeatures: [ staticReef.type ] }, components: [ { ...staticReef, streamingBounds: undefined } ] } ), /Invalid or duplicate world component/, 'authoring requires streaming bounds for large static reef data' );
const audioAssetID = `sha256:${'b'.repeat( 64 )}`;
const ambientAudio = { id: 'tw-component:forest-ambience', type: 'tidewater.ambient-audio/1', priority: 'portal-preview', beds: [ { assetId: audioAssetID, gain: 0.4, condition: 'night', position: [ 0, 2, 4 ], refDistance: 2, rolloff: 1 } ] };
const audioAsset = [ { id: audioAssetID, kind: 'audio/ogg', priority: 'portal-preview', bytes: 64 } ];
assert.doesNotThrow( () => validateWorldComponents( [ ambientAudio ], { requiredFeatures: [ ambientAudio.type ] }, new Set(), audioAsset ), 'browser accepts signed ambient audio referencing a staged OGG asset' );
assert.throws( () => validateWorldComponents( [ ambientAudio ], { requiredFeatures: [ ambientAudio.type ] }, new Set(), [ { ...audioAsset[ 0 ], kind: 'glb' } ] ), /Unsupported or invalid world component/, 'ambient audio cannot reference non-audio assets' );
assert.throws( () => validateWorldComponents( [ ambientAudio ], { requiredFeatures: [ ambientAudio.type ] }, new Set(), [ { ...audioAsset[ 0 ], bytes: 0 } ] ), /Unsupported or invalid world component/, 'ambient audio rejects empty asset files' );
assert.throws( () => validateWorldComponents( [ { ...ambientAudio, beds: [ { ...ambientAudio.beds[ 0 ], url: 'https://example.invalid/audio.ogg' } ] } ], { requiredFeatures: [ ambientAudio.type ] }, new Set(), audioAsset ), /Unsupported or invalid world component/, 'browser rejects untrusted URL fields on ambient beds' );
assert.doesNotThrow( () => validateWorldSource( { ...source, rules: { ...source.rules, requiredFeatures: [ ambientAudio.type ] }, components: [ ambientAudio ] } ), 'authoring accepts the versioned portable ambience data' );
assert.throws( () => validateWorldSource( { ...source, rules: { ...source.rules, requiredFeatures: [ ambientAudio.type ] }, components: [ { ...ambientAudio, beds: [ { ...ambientAudio.beds[ 0 ], condition: 'storm' } ] } ] } ), /Invalid or duplicate world component/, 'authoring rejects conditions without runtime semantics' );
const directoryLink = worldLinkFromLocation( { search: '?worldId=tw-world:coast&directory=https%3A%2F%2Fthruhold.org', origin: 'https://rebroad.github.io' } );
assert.equal( directoryLink.directory, 'https://thruhold.org', 'browser link can opt into the community directory' );
assert.throws( () => new WorldConnector( { worldId: 'tw-world:coast', directory: 'http://thruhold.org' } ), 'directory endpoints must use HTTPS' );
const invite = createWorldInviteURL( {
	pageURL: 'https://rebroad.github.io/tidewater/?noVeg=1',
	worldId: 'tw-world:coast',
	nodeId: '12D3KooWAbcdefghijk1234567890123456',
	gateway: 'https://coast.example',
	directory: 'https://thruhold.org',
} );
const inviteURL = new URL( invite );
assert.equal( inviteURL.pathname, '/tidewater/', 'world invitations preserve the game base path' );
assert.equal( inviteURL.searchParams.get( 'worldId' ), 'tw-world:coast', 'world invitations carry the stable world ID' );
assert.equal( inviteURL.searchParams.get( 'nodeId' ), '12D3KooWAbcdefghijk1234567890123456', 'world invitations pin a signed provider identity' );
assert.equal( inviteURL.searchParams.get( 'gateway' ), 'https://coast.example', 'world invitations carry the provider gateway' );
assert.equal( inviteURL.searchParams.get( 'directory' ), 'https://thruhold.org', 'world invitations retain optional decentralized discovery' );
assert.equal( inviteURL.searchParams.get( 'noVeg' ), '1', 'world invitations preserve unrelated client options' );
assert.throws( () => createWorldInviteURL( { pageURL: 'https://rebroad.github.io/tidewater/', worldId: 'tw-world:coast', gateway: 'http://coast.example' } ), /secure HTTPS\/WSS/, 'world invitations reject an insecure gateway' );
console.log( 'ok   portal crossing geometry and orientation handoff' );
