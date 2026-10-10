import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gravityAcceleration, movementParameters, validateWorldRequirements, worldSeaLevel } from '../src/network/WorldRules.js';
import { validateWorldSource, validateWorldSpawn, worldSpawnPose } from '../src/network/WorldSource.js';
import { encodeVegetationPlacements, VEGETATION_PLACEMENT_KINDS } from '../src/network/VegetationPlacements.js';

const temporaryRoot = process.env.PREFIX ? path.join( process.env.PREFIX, 'tmp' ) : '/var/tmp';
const root = await mkdtemp( path.join( temporaryRoot, 'elsemesh-manifest-test-' ) );

try {
	const sourcePath = path.join( root, 'world-source.json' );
	const assetsPath = path.join( root, 'assets' );
	await mkdir( assetsPath );
	const boundedAssetBytes = Buffer.from( 'mesh' );
	const boundedAssetID = `sha256:${createHashForTest( boundedAssetBytes )}`;
	await writeFile( path.join( assetsPath, boundedAssetID.slice( 'sha256:'.length ) ), boundedAssetBytes );
	const boatPreviewBytes = Buffer.from( 'trusted boat berth preview mesh' );
	const boatPreviewAssetID = `sha256:${createHashForTest( boatPreviewBytes )}`;
	await writeFile( path.join( assetsPath, boatPreviewAssetID.slice( 'sha256:'.length ) ), boatPreviewBytes );
	const emptyVegetation = Object.fromEntries( [ ...VEGETATION_PLACEMENT_KINDS.map( ( kind ) => [ kind, [] ] ), [ 'villagePalms', 0 ] ] );
	const placementBytes = Buffer.from( encodeVegetationPlacements( emptyVegetation, 7 ) );
	const placementAssetID = `sha256:${createHashForTest( placementBytes )}`;
	await writeFile( path.join( assetsPath, placementAssetID.slice( 'sha256:'.length ) ), placementBytes );
	const reefPlacementBytes = Buffer.from( 'reef placements test payload' );
	const reefPlacementAssetID = `sha256:${createHashForTest( reefPlacementBytes )}`;
	await writeFile( path.join( assetsPath, reefPlacementAssetID.slice( 'sha256:'.length ) ), reefPlacementBytes );
	const ambientBytes = Buffer.from( 'fake OGG bytes for manifest conversion' );
	const ambientAssetID = `sha256:${createHashForTest( ambientBytes )}`;
	await writeFile( path.join( assetsPath, ambientAssetID.slice( 'sha256:'.length ) ), ambientBytes );
	await writeFile( sourcePath, JSON.stringify( {
		protocol: 'tidewater.world-source/1',
		worldId: 'tw-world:manifest-test',
		title: 'Manifest test',
		spawn: { position: [ 53.6, 4.447713719743241, -77 ], yaw: Math.PI, pitch: -0.05 },
		coordinateSystem: 'right-handed-y-up-meters',
		styleGuide: '',
		rules: { gravity: 1, seaLevel: -4.5, atmosphereLevel: 18000, avatarComplexity: 20000, physicsProfile: 'default', movement: { walkSpeed: 2.5, sprintSpeed: 7, jumpSpeed: 4.2 }, vehiclePolicy: { enabled: true, maxSpeed: 8, maxCombinedComplexity: 50000 }, maxPackageBytes: 1024, requiredFeatures: [ 'tidewater.portal-handoff/1', 'tidewater.procedural-island-vegetation/1', 'tidewater.static-vegetation/1', 'tidewater.static-reef/1', 'tidewater.island-ocean/1', 'tidewater.downeast-boat/1', 'tidewater.ambient-audio/1', 'tidewater.static-glb-emissive-strength/1' ] },
		hosts: [ { peerId: '12D3KooWAbcdefghijk1234567890123456', scopes: [ 'content-cache', 'failover-authority' ], expiresAt: 1900000000, epoch: 3, failoverAfter: 1800000000, failoverSeconds: 300 } ],
		objects: [ { id: 'tw-object:bounded', kind: 'asset-instance', label: 'Bounded', assetId: boundedAssetID, priority: 'nearby', streamingBounds: { center: [ 1, 2, 3 ], radius: 4 }, transform: { position: [ 0, 0, 0 ], yaw: 0 }, scale: [ 1, 1, 1 ], collision: { shape: 'none', enabled: false } }, { id: 'tw-object:boat-preview', kind: 'asset-instance', label: 'Boat berth preview', assetId: boatPreviewAssetID, priority: 'portal-preview', transform: { position: [ 0, -4.5, 0 ], yaw: 0 }, scale: [ 1, 1, 1 ], collision: { shape: 'none', enabled: false } } ],
		components: [ { id: 'tw-component:test-vegetation', type: 'tidewater.procedural-island-vegetation/1', seed: 7, priority: 'portal-preview', placementAssetId: placementAssetID }, { id: 'tw-component:static-plants', type: 'tidewater.static-vegetation/1', priority: 'portal-preview', placementAssetId: placementAssetID }, { id: 'tw-component:reef-tile', type: 'tidewater.static-reef/1', priority: 'visible', placementAssetId: reefPlacementAssetID, streamingBounds: { center: [ 0, -4, 0 ], radius: 32 } }, { id: 'tw-component:test-ocean', type: 'tidewater.island-ocean/1', priority: 'portal-preview' }, { id: 'tw-component:hosted-boat', type: 'tidewater.downeast-boat/1', objectId: 'tw-object:boat-preview', priority: 'portal-preview' }, { id: 'tw-component:test-ambience', type: 'tidewater.ambient-audio/1', priority: 'portal-preview', beds: [ { assetId: ambientAssetID, gain: 0.3, condition: 'underwater', position: [ 1, 2, 3 ] } ] } ],
		portals: [],
		updatedAt: '2026-09-30T12:34:56Z',
	} ) );

	const outputs = [ 'first.json', 'second.json' ];
	for ( const output of outputs ) {
		execFileSync( process.execPath, [
			'tools/world-source-to-manifest.mjs',
			'--source', sourcePath,
			'--owner', 'owner-peer',
			'--assets', assetsPath,
			'--out', path.join( root, output ),
		], { stdio: 'ignore' } );
	}

	const [ first, second ] = await Promise.all( outputs.map( ( output ) => readFile( path.join( root, output ) ) ) );
	assert.deepEqual( first, second, 'same source must produce byte-identical manifests' );
	const manifest = JSON.parse( first );
	assert.deepEqual( manifest.spawn, { position: [ 53.6, 4.447713719743241, -77 ], yaw: Math.PI, pitch: -0.05 }, 'authored spawn survives signed-manifest conversion' );
	assert.deepEqual( worldSpawnPose( manifest ), manifest.spawn );
	assert.deepEqual( worldSpawnPose( {} ), { position: [ 0, 3, 8 ], yaw: Math.PI, pitch: -0.1 }, 'legacy cave entrance remains compatible' );
	for ( const spawn of [ null, [], { position: [ 1, 2 ], yaw: 0, pitch: 0 }, { position: [ 0, Infinity, 0 ], yaw: 0, pitch: 0 }, { position: [ 0, 1000001, 0 ], yaw: 0, pitch: 0 }, { position: [ 0, 3, 8 ], yaw: NaN, pitch: 0 }, { position: [ 0, 3, 8 ], yaw: 0, pitch: 1.6 }, { position: [ 0, 3, 8 ], yaw: 0 } ] ) assert.throws( () => validateWorldSpawn( spawn ), /spawn pose/ );
	const copy = worldSpawnPose( manifest ); copy.position[ 0 ] = 999;
	assert.equal( manifest.spawn.position[ 0 ], 53.6, 'runtime pose cannot mutate the signed document' );
	assert.equal( manifest.updatedAt, 1790771696, 'runtime timestamp must come from the source snapshot' );
	assert.equal( manifest.discoverable, false, 'world publication is private by default' );
	assert.deepEqual( manifest.hosts, [ { peerId: '12D3KooWAbcdefghijk1234567890123456', scopes: [ 'content-cache', 'failover-authority' ], expiresAt: 1900000000, epoch: 3, failoverAfter: 1800000000, failoverSeconds: 300 } ], 'owner-granted cache and failover authority survive conversion' );
	assert.deepEqual( manifest.rules.requiredFeatures, [ 'tidewater.portal-handoff/1', 'tidewater.procedural-island-vegetation/1', 'tidewater.static-vegetation/1', 'tidewater.static-reef/1', 'tidewater.island-ocean/1', 'tidewater.downeast-boat/1', 'tidewater.ambient-audio/1', 'tidewater.static-glb-emissive-strength/1' ], 'runtime feature requirements survive deterministic conversion' );
	assert.deepEqual( manifest.components.at( -1 ), { id: 'tw-component:test-ambience', type: 'tidewater.ambient-audio/1', priority: 'portal-preview', beds: [ { assetId: ambientAssetID, gain: 0.3, condition: 'underwater', position: [ 1, 2, 3 ] } ] }, 'ambient bed contract survives deterministic conversion' );
	assert.deepEqual( manifest.components.find( ( component ) => component.type === 'tidewater.downeast-boat/1' ), { id: 'tw-component:hosted-boat', type: 'tidewater.downeast-boat/1', objectId: 'tw-object:boat-preview', priority: 'portal-preview' }, 'boat runtime binds through stable world object ID' );
	assert.ok( manifest.assets.some( ( asset ) => asset.id === ambientAssetID && asset.kind === 'audio/ogg' && asset.priority === 'portal-preview' ), 'audio bytes are included in the signed manifest at the component streaming priority' );
	const invalidAmbientSource = JSON.parse( await readFile( sourcePath, 'utf8' ) );
	invalidAmbientSource.components.at( -1 ).beds[ 0 ].condition = 'storm';
	assert.throws( () => validateWorldSource( invalidAmbientSource ), /world component/, 'source validation rejects unimplemented ambient audio conditions' );
	assert.ok( manifest.assets.some( ( asset ) => asset.id === placementAssetID && asset.kind === 'vegetation-placement/1' && asset.priority === 'portal-preview' ), 'component placement data is included as a hash-verified early-stream asset' );
	assert.ok( manifest.assets.some( ( asset ) => asset.id === reefPlacementAssetID && asset.kind === 'reef-placement/1' && asset.priority === 'visible' ), 'reef placement data is content-addressed and keeps its view streaming priority' );
	assert.deepEqual( manifest.rules.movement, { walkSpeed: 2.5, sprintSpeed: 7, jumpSpeed: 4.2 }, 'world movement rules survive deterministic conversion' );
	assert.deepEqual( manifest.rules.vehiclePolicy, { enabled: true, maxSpeed: 8, maxCombinedComplexity: 50000 }, 'destination vehicle acceptance and limits survive deterministic conversion' );
	assert.equal( manifest.rules.maxPackageBytes, 1024, 'aggregate content budget survives deterministic conversion' );
	assert.equal( manifest.rules.seaLevel, -4.5, 'authored sea level survives deterministic conversion' );
	assert.equal( manifest.rules.atmosphereLevel, 18000, 'authored atmosphere boundary survives deterministic conversion' );
	for ( const policy of [ { enabled: true }, { enabled: true, maxSpeed: 17, maxCombinedComplexity: 50000 }, { enabled: false, maxSpeed: 8 }, { enabled: true, maxSpeed: 8, maxCombinedComplexity: 0 }, { enabled: true, maxSpeed: 8, maxCombinedComplexity: 50000, unknown: true } ] ) {
		const invalidPolicySource = JSON.parse( await readFile( sourcePath, 'utf8' ) );
		invalidPolicySource.rules.vehiclePolicy = policy;
		assert.throws( () => validateWorldSource( invalidPolicySource ), /vehicle policy/, `authoring source rejects invalid vehicle policy ${JSON.stringify( policy )}` );
	}
	assert.deepEqual( manifest.objects[ 0 ].streamingBounds, { center: [ 1, 2, 3 ], radius: 4 }, 'object streaming bounds survive deterministic conversion' );
	assert.equal( manifest.objects[ 0 ].priority, 'nearby', 'per-object streaming priority survives deterministic conversion' );
	const oversizedBytes = Buffer.from( 'over budget' );
	const oversizedAssetID = `sha256:${createHashForTest( oversizedBytes )}`;
	await writeFile( path.join( assetsPath, oversizedAssetID.slice( 'sha256:'.length ) ), oversizedBytes );
	const oversizedSource = JSON.parse( await readFile( sourcePath, 'utf8' ) );
	oversizedSource.worldId = 'tw-world:over-budget';
	oversizedSource.rules.maxPackageBytes = 1;
	oversizedSource.rules.requiredFeatures = [];
	oversizedSource.components = [];
	oversizedSource.objects = [ { id: 'tw-object:asset', kind: 'asset-instance', label: 'Asset', assetId: oversizedAssetID, transform: { position: [ 0, 0, 0 ], yaw: 0 }, scale: [ 1, 1, 1 ], collision: { shape: 'none', enabled: false }, priority: 'visible' } ];
	const oversizedSourcePath = path.join( root, 'over-budget-source.json' );
	await writeFile( oversizedSourcePath, JSON.stringify( oversizedSource ) );
	let converterRejectedBudget = false;
	try {
		execFileSync( process.execPath, [ 'tools/world-source-to-manifest.mjs', '--source', oversizedSourcePath, '--owner', 'owner-peer', '--assets', assetsPath, '--out', path.join( root, 'over-budget.json' ) ], { stdio: 'pipe' } );
	} catch ( error ) {
		converterRejectedBudget = String( error.stderr ).includes( 'over its declared' );
	}
	assert.equal( converterRejectedBudget, true, 'source converter refuses to publish assets over the declared byte budget' );
	assert.doesNotThrow( () => validateWorldRequirements( manifest ), 'client accepts requirements it implements' );
	assert.doesNotThrow( () => validateWorldRequirements( { ...manifest, rules: { ...manifest.rules, seaLevel: undefined } } ), 'atmosphere boundary works without a sea-level declaration' );
	assert.doesNotThrow( () => validateWorldRequirements( { ...manifest, rules: { ...manifest.rules, atmosphereLevel: undefined } } ), 'sea level works without an atmosphere declaration' );
	assert.throws( () => validateWorldRequirements( { ...manifest, rules: { ...manifest.rules, seaLevel: Infinity } } ), /seaLevel must be a finite/, 'client rejects non-finite sea levels' );
	assert.throws( () => validateWorldRequirements( { ...manifest, rules: { ...manifest.rules, atmosphereLevel: 1000001 } } ), /atmosphereLevel must be a finite/, 'client rejects out-of-bounds atmosphere levels' );
	assert.throws( () => validateWorldRequirements( { ...manifest, rules: { ...manifest.rules, requiredFeatures: [ 'tidewater.water-simulation/2' ] } } ), /does not support required world feature/, 'client must not silently ignore an unsupported required feature' );
	assert.throws( () => validateWorldRequirements( { ...manifest, rules: { ...manifest.rules, physicsProfile: 'custom-physics' } } ), /invalid runtime rules/, 'client rejects a physics profile without implemented semantics' );
	assert.throws( () => validateWorldSource( { protocol: 'tidewater.world-source/1', worldId: 'tw-world:duplicate-feature', title: 'Rules', coordinateSystem: 'right-handed-y-up-meters', styleGuide: '', rules: { gravity: 1, avatarComplexity: 100, physicsProfile: 'default', requiredFeatures: [ 'tidewater.portal-handoff/1', 'tidewater.portal-handoff/1' ] }, objects: [], portals: [], updatedAt: '2026-09-30T12:00:00Z' } ), /required world features/, 'authoring source rejects duplicate required features' );
	assert.throws( () => validateWorldSource( { protocol: 'tidewater.world-source/1', worldId: 'tw-world:custom-profile', title: 'Rules', coordinateSystem: 'right-handed-y-up-meters', styleGuide: '', rules: { gravity: 1, avatarComplexity: 100, physicsProfile: 'custom-physics' }, objects: [], portals: [], updatedAt: '2026-09-30T12:00:00Z' } ), /unsupported world rules/, 'authoring source rejects a profile without implemented semantics' );
	assert.throws( () => validateWorldSource( { protocol: 'tidewater.world-source/1', worldId: 'tw-world:fast-player', title: 'Rules', coordinateSystem: 'right-handed-y-up-meters', styleGuide: '', rules: { gravity: 1, avatarComplexity: 100, physicsProfile: 'default', movement: { walkSpeed: 12, sprintSpeed: 12, jumpSpeed: 4 } }, objects: [], portals: [], updatedAt: '2026-09-30T12:00:00Z' } ), /movement rules/, 'authoring source rejects out-of-range movement values' );
	assert.throws( () => validateWorldSource( { protocol: 'tidewater.world-source/1', worldId: 'tw-world:bad-host', title: 'Grant', coordinateSystem: 'right-handed-y-up-meters', styleGuide: '', rules: { gravity: 1, avatarComplexity: 100, physicsProfile: 'default' }, hosts: [ { peerId: '12D3KooWAbcdefghijk1234567890123456', scopes: [ 'failover-authority' ], expiresAt: 1900000000, epoch: 1, failoverAfter: 1800000000 } ], objects: [], portals: [], updatedAt: '2026-09-30T12:00:00Z' } ), /failover window/, 'failover grants require a bounded duration' );
	const overlappingFailoverSource = { protocol: 'tidewater.world-source/1', worldId: 'tw-world:overlapping-failover', title: 'Overlapping failover', coordinateSystem: 'right-handed-y-up-meters', styleGuide: '', rules: { gravity: 1, avatarComplexity: 100, physicsProfile: 'default' }, hosts: [ { peerId: '12D3KooWAbcdefghijk1234567890123456', scopes: [ 'failover-authority' ], expiresAt: 2000, epoch: 1, failoverAfter: 1000, failoverSeconds: 60 }, { peerId: '12D3KooWAbcdefghijk1234567890123457', scopes: [ 'failover-authority' ], expiresAt: 2000, epoch: 1, failoverAfter: 1059, failoverSeconds: 60 } ], objects: [], portals: [], updatedAt: '2026-09-30T12:00:00Z' };
	assert.throws( () => validateWorldSource( overlappingFailoverSource ), /Overlapping host grant failover windows/, 'world source refuses overlapping delegated authority windows' );
	assert.equal( gravityAcceleration( { gravity: 1 } ), 9.81, 'default world gravity preserves the built-in movement physics' );
	assert.equal( gravityAcceleration( { gravity: 0.5 } ), 4.905, 'world gravity multiplier affects player acceleration' );
	assert.throws( () => gravityAcceleration( { gravity: 2.1 } ), /gravity multiplier/, 'gravity outside the validated range is rejected' );
	assert.equal( worldSeaLevel( {} ), 0, 'worlds without sea-level retain the legacy renderer level' );
	assert.equal( worldSeaLevel( { seaLevel: -4.5 } ), -4.5, 'hosted-world sea-level is applied as declared' );
	assert.deepEqual( movementParameters( {} ), { walkSpeed: 3, sprintSpeed: 6.2, jumpSpeed: 4.6 }, 'older manifests retain existing controller movement defaults' );
	assert.throws( () => movementParameters( { movement: { walkSpeed: 5, sprintSpeed: 4, jumpSpeed: 2 } } ), /movement speeds/, 'sprint speed cannot be lower than walk speed' );
	assert.throws( () => validateWorldRequirements( { ...manifest, assets: [ { bytes: 1025 } ] } ), /exceeds its declared byte budget/, 'client rejects a package larger than its signed byte budget before downloading' );
	assert.throws( () => validateWorldSource( { protocol: 'tidewater.world-source/1', worldId: 'tw-world:bad-budget', title: 'Budget', coordinateSystem: 'right-handed-y-up-meters', styleGuide: '', rules: { gravity: 1, avatarComplexity: 100, physicsProfile: 'default', maxPackageBytes: 0 }, objects: [], portals: [], updatedAt: '2026-09-30T12:00:00Z' } ), /byte budget/, 'authoring source rejects an invalid package budget' );
	assert.throws( () => validateWorldSource( { protocol: 'tidewater.world-source/1', worldId: 'tw-world:bad-sea', title: 'Sea', coordinateSystem: 'right-handed-y-up-meters', styleGuide: '', rules: { gravity: 1, avatarComplexity: 100, physicsProfile: 'default', seaLevel: NaN }, objects: [], portals: [], updatedAt: '2026-09-30T12:00:00Z' } ), /sea or atmosphere level/, 'authoring source rejects non-finite environment levels' );
	const quaternionSource = { protocol: 'tidewater.world-source/1', worldId: 'tw-world:quaternion', title: 'Quaternion', coordinateSystem: 'right-handed-y-up-meters', styleGuide: '', rules: { gravity: 1, avatarComplexity: 100, physicsProfile: 'default' }, objects: [ { id: 'tw-object:rotated', kind: 'asset-instance', label: 'Rotated', transform: { position: [ 0, 0, 0 ], yaw: 0, rotation: [ 0, 0, 0, 1 ] }, scale: [ 1, 1, 1 ], collision: { shape: 'none', enabled: false } } ], portals: [], updatedAt: '2026-09-30T12:00:00Z' };
	assert.doesNotThrow( () => validateWorldSource( quaternionSource ), 'collision-free objects accept normalized quaternion transforms' );
	const boundedSource = structuredClone( quaternionSource );
	boundedSource.objects[ 0 ].streamingBounds = { center: [ 1, 2, 3 ], radius: 4 };
	boundedSource.objects[ 0 ].priority = 'nearby';
	assert.doesNotThrow( () => validateWorldSource( boundedSource ), 'objects accept validated local streaming bounds and per-object priority' );
	boundedSource.objects[ 0 ].streamingBounds.radius = 0;
	assert.throws( () => validateWorldSource( boundedSource ), /object record/, 'authoring source rejects zero-radius streaming bounds' );
	boundedSource.objects[ 0 ].streamingBounds.radius = 4;
	boundedSource.objects[ 0 ].priority = 'urgent';
	assert.throws( () => validateWorldSource( boundedSource ), /object record/, 'authoring source rejects unknown object streaming priority' );
	quaternionSource.objects[ 0 ].transform.rotation = [ 0, 0, 0, 2 ];
	assert.throws( () => validateWorldSource( quaternionSource ), /object record/, 'authoring source rejects non-normalized quaternions' );
	quaternionSource.objects[ 0 ].transform.rotation = [ 0, 0, 0, 1 ];
	quaternionSource.objects[ 0 ].collision.enabled = true;
	assert.throws( () => validateWorldSource( quaternionSource ), /object record/, 'authoring source rejects quaternion transforms when collision is enabled' );
	const publicOutput = path.join( root, 'discoverable.json' );
	execFileSync( process.execPath, [
		'tools/world-source-to-manifest.mjs', '--source', sourcePath, '--owner', 'owner-peer',
		'--assets', assetsPath, '--out', publicOutput, '--discoverable', 'true',
	], { stdio: 'ignore' } );
	assert.equal( JSON.parse( await readFile( publicOutput, 'utf8' ) ).discoverable, true, 'discoverable must require an explicit author choice' );
	console.log( 'ok deterministic source-to-manifest conversion' );
} finally {
	await rm( root, { recursive: true, force: true } );
}

function createHashForTest( bytes ) {
	return createHash( 'sha256' ).update( bytes ).digest( 'hex' );
}
