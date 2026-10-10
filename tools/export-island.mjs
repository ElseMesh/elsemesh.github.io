#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerrainData } from '../src/world/TerrainData.js';
import { parseGLB } from '../src/engine/loaders/GLTF.js';
import { Euler, Quaternion } from '../src/engine/index.js';
import { Village } from '../src/world/Village.js';
import { BoatModel } from '../src/world/BoatModel.js';
import { WORLD } from '../src/world/WorldLayout.js';
import { Rocks } from '../src/world/Rocks.js';
import { Colliders } from '../src/world/Colliders.js';
import { Builder, Batch } from '../src/world/village/GeoBuilder.js';
import { VILLAGE_MATERIAL_PROFILE, VILLAGE_MATERIAL_ROLES } from '../src/network/WorldVillageMaterial.js';
import { InstancedProps } from '../src/world/Props.js';
import { DebrisPlacer } from '../src/world/debris/DebrisPlacement.js';
import { SCAN_ASSETS } from '../src/world/debris/ScannedDebris.js';
import { createVegetationPlacement } from '../src/world/vegetation/Scatter.js';
import { encodeVegetationPlacements } from '../src/network/VegetationPlacements.js';
import { Reef } from '../src/world/Reef.js';
import { encodeReefPlacements } from '../src/network/ReefPlacements.js';
import { BANK } from '../src/audio/soundBank.js';
import { MIX } from '../src/audio/SoundScape.js';
import { bakeTerrainMaps } from '../src/world/terrain/TerrainBake.js';
import { getDetailImage } from '../src/world/terrain/DetailTextures.js';
import { encodeTerrainSurfaceAsset } from '../src/network/TerrainSurfaceAsset.js';
import '../test/headless.mjs';
import { GPU } from '../src/engine/gpu/GPU.js';
import { readTexture } from '../src/engine/gpu/Readback.js';
import { VillageTextures } from '../src/world/village/TextureBaker.js';
import { encodeVillageMaterialAsset, wrapCompressedVillageMaterialAsset } from '../src/network/VillageMaterialAsset.js';

const REPO = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const args = process.argv.slice( 2 );
let output = path.join( REPO, 'worlds', 'island' );
for ( let i = 0; i < args.length; i ++ ) {
	if ( args[ i ] !== '--out' || ! args[ i + 1 ] ) throw new Error( `Unknown or incomplete option: ${args[ i ]}` );
	output = path.resolve( args[ ++ i ] );
}

const sourcePath = path.join( output, 'world-source.json' );
let updatedAt = '2026-10-01T00:00:00Z';
try {
	const previous = JSON.parse( await readFile( sourcePath, 'utf8' ) );
	if ( typeof previous.updatedAt === 'string' ) updatedAt = previous.updatedAt;
} catch ( error ) {
	if ( error.code !== 'ENOENT' ) throw error;
}
if ( process.env.SOURCE_DATE_EPOCH !== undefined ) {
	const epoch = Number( process.env.SOURCE_DATE_EPOCH );
	if ( ! Number.isSafeInteger( epoch ) || epoch < 0 ) throw new Error( 'SOURCE_DATE_EPOCH must be a non-negative integer' );
	updatedAt = new Date( epoch * 1000 ).toISOString();
}

const terrain = new TerrainData( 7 );
const glb = exportTerrain( terrain, 512 );
const assetId = `sha256:${createHash( 'sha256' ).update( glb ).digest( 'hex' )}`;
const terrainPreviewGLB = exportTerrain( terrain, 128 );
const terrainPreviewAssetId = `sha256:${createHash( 'sha256' ).update( terrainPreviewGLB ).digest( 'hex' )}`;
const staticAssets = new Map( [ [ assetId, glb ], [ terrainPreviewAssetId, terrainPreviewGLB ] ] );
const generated = buildIslandProceduralContent( terrain );
const terrainMaps = bakeTerrainMaps( terrain );
const terrainDetail = getDetailImage();
const terrainPayload = encodeTerrainSurfaceAsset( terrain, terrainMaps, terrainDetail );
const terrainSurfaceHeader = Buffer.alloc( 16 );
Buffer.from( 'EMTERR1\0' ).copy( terrainSurfaceHeader, 0 );
terrainSurfaceHeader.writeUInt32LE( 1, 8 );
terrainSurfaceHeader.writeUInt32LE( terrainPayload.byteLength, 12 );
const terrainSurface = Buffer.concat( [ terrainSurfaceHeader, deflateSync( terrainPayload, { level: 9 } ) ] );
const terrainSurfaceAssetId = `sha256:${createHash( 'sha256' ).update( terrainSurface ).digest( 'hex' )}`;
staticAssets.set( terrainSurfaceAssetId, terrainSurface );
await GPU.init( { headless: true } );
const villageTextures = new VillageTextures();
villageTextures.bake();
GPU.submit();
const villageMaps = {};
for ( const [ name, texture ] of Object.entries( villageTextures.textures ) ) villageMaps[ name ] = new Uint8Array( ( await readTexture( texture ) ).data );
const villageMaterialsRaw = encodeVillageMaterialAsset( villageMaps );
const villageMaterials = wrapCompressedVillageMaterialAsset( villageMaterialsRaw, bytes => deflateSync( bytes, { level: 9 } ) );
const villageMaterialsAssetId = `sha256:${createHash( 'sha256' ).update( villageMaterials ).digest( 'hex' )}`;
staticAssets.set( villageMaterialsAssetId, villageMaterials );
villageTextures.dispose();
GPU.device.destroy();
const villageGLB = exportBatchGLB( generated.villageBatches, 'Procedural village', true );
const villageAssetId = `sha256:${createHash( 'sha256' ).update( villageGLB ).digest( 'hex' )}`;
const villageBounds = boundsForGLB( villageGLB );
staticAssets.set( villageAssetId, villageGLB );
const villageLODGLB = await readFile( path.join( REPO, 'worlds', 'island', 'lod-source', 'village-low.glb' ) );
const villageLODAssetId = `sha256:${createHash( 'sha256' ).update( villageLODGLB ).digest( 'hex' )}`;
const villageBaseData = parseGLB( villageGLB );
const villageLODData = parseGLB( villageLODGLB );
const triangleCount = ( model ) => model.meshes.flat().reduce( ( total, primitive ) => total + ( primitive.indices?.length || primitive.attributes.POSITION.array.length / 3 ) / 3, 0 );
const materialRoles = ( model ) => [ ...new Set( model.materials.map( ( material ) => material.extras?.tidewaterMaterial?.role ).filter( Boolean ) ) ].sort();
if ( triangleCount( villageLODData ) >= triangleCount( villageBaseData ) * 0.5 ) throw new Error( 'Village distance LOD must use less than half the full-detail triangles' );
if ( JSON.stringify( materialRoles( villageLODData ) ) !== JSON.stringify( VILLAGE_MATERIAL_ROLES.slice().sort() ) ) throw new Error( 'Village distance LOD must preserve every trusted material role' );
if ( villageLODData.meshes.flat().some( primitive => ! primitive.attributes.COLOR_0 || primitive.attributes._TW_VDATA?.itemSize !== 4 ) ) throw new Error( 'Village distance LOD must preserve vertex tints and VEC4 material data' );
staticAssets.set( villageLODAssetId, villageLODGLB );
const boatGLB = exportBatchGLB( generated.boatBatches, 'Moored lobster boat' );
const boatAssetId = `sha256:${createHash( 'sha256' ).update( boatGLB ).digest( 'hex' )}`;
const boatBounds = boundsForGLB( boatGLB );
staticAssets.set( boatAssetId, boatGLB );
const boatLODGLB = await readFile( path.join( REPO, 'worlds', 'island', 'lod-source', 'moored-boat-low.glb' ) );
const boatLODAssetId = `sha256:${createHash( 'sha256' ).update( boatLODGLB ).digest( 'hex' )}`;
const boatBaseData = parseGLB( boatGLB );
const boatLODData = parseGLB( boatLODGLB );
if ( triangleCount( boatLODData ) >= triangleCount( boatBaseData ) * 0.5 ) throw new Error( 'Moored boat distance LOD must use less than half the full-detail triangles' );
if ( JSON.stringify( boatLODData.materials.map( material => material.name ).sort() ) !== JSON.stringify( boatBaseData.materials.map( material => material.name ).sort() ) ) throw new Error( 'Moored boat distance LOD must preserve all material assignments' );
if ( boatLODData.meshes.flat().some( primitive => ! primitive.attributes.COLOR_0 || ! primitive.attributes.TEXCOORD_0 ) ) throw new Error( 'Moored boat distance LOD must preserve vertex colors and UVs' );
staticAssets.set( boatLODAssetId, boatLODGLB );
const debris = generated.debris;
const vegetationDocument = Buffer.from( encodeVegetationPlacements( generated.vegetation, 7 ) );
const vegetationAssetId = `sha256:${createHash( 'sha256' ).update( vegetationDocument ).digest( 'hex' )}`;
staticAssets.set( vegetationAssetId, vegetationDocument );
const reefLayout = new Reef( { terrain, layoutOnly: true } );
const reefRecords = reefLayout.placements();
const reefModelRadius = Math.max( ...[ ...reefLayout.kinds.hard, ...reefLayout.kinds.soft ].filter( ( kind ) => kind.lod === 0 ).map( ( kind ) => {
	const bounds = kind.geometry.boundingBox;
	return Math.max( ...[ bounds.min.x, bounds.max.x ].flatMap( ( x ) => [ bounds.min.y, bounds.max.y ].flatMap( ( y ) => [ bounds.min.z, bounds.max.z ].map( ( z ) => Math.hypot( x, y, z ) ) ) ) );
} ) );
if ( ! Number.isFinite( reefModelRadius ) || reefModelRadius <= 0 ) throw new Error( 'Reef model catalog has no valid placement bounds' );
const reefTiles = tileReefPlacements( reefRecords, 64, reefModelRadius );
if ( reefTiles.length > 128 ) throw new Error( `Reef export produced ${reefTiles.length} tiles; maximum is 128` );
const reefComponents = [];
let reefAssetBytes = 0;
for ( const tile of reefTiles ) {
	const bytes = Buffer.from( encodeReefPlacements( tile.records, 20260923 ) );
	if ( bytes.length > 16 * 1024 * 1024 ) throw new Error( `Reef tile ${tile.x},${tile.z} exceeds the 16 MiB asset limit` );
	const id = `sha256:${createHash( 'sha256' ).update( bytes ).digest( 'hex' )}`;
	staticAssets.set( id, bytes );
	reefAssetBytes += bytes.length;
	reefComponents.push( {
		id: `tw-component:reef-tile-${tile.x}-${tile.z}`,
		type: 'tidewater.static-reef/1',
		priority: 'visible',
		placementAssetId: id,
		streamingBounds: tile.bounds,
	} );
}
if ( reefComponents.length + 4 > 128 ) throw new Error( 'Island world exceeds the 128 component limit after adding reef tiles, the boat, and ambient audio' );
const debrisAssetIDs = new Map();
const debrisLODAssetIDs = new Map();
const debrisAssetBounds = new Map();
for ( const assetName of SCAN_ASSETS ) {
	const originalGLB = await readFile( path.join( REPO, 'public', 'models', 'debris', `${assetName}.glb` ) );
	const albedo = await readFile( path.join( REPO, 'public', 'models', 'debris', `${assetName}_albedo.jpg` ) );
	const packagedGLB = exportScannedLOD( originalGLB, albedo, assetName, 1 );
	const packagedLODGLB = exportScannedLOD( originalGLB, albedo, assetName, 2 );
	const packagedID = `sha256:${createHash( 'sha256' ).update( packagedGLB ).digest( 'hex' )}`;
	const packagedLODID = `sha256:${createHash( 'sha256' ).update( packagedLODGLB ).digest( 'hex' )}`;
	const packagedData = parseGLB( packagedGLB.buffer.slice( packagedGLB.byteOffset, packagedGLB.byteOffset + packagedGLB.byteLength ) );
	const packagedLODData = parseGLB( packagedLODGLB.buffer.slice( packagedLODGLB.byteOffset, packagedLODGLB.byteOffset + packagedLODGLB.byteLength ) );
	if ( triangleCount( packagedLODData ) >= triangleCount( packagedData ) * 0.3 ) throw new Error( `Scanned asset ${assetName} distance LOD must reduce triangles by at least 70%` );
	if ( ! packagedLODData.images[ 0 ]?.bytes || ! packagedData.images[ 0 ]?.bytes || ! Buffer.from( packagedLODData.images[ 0 ].bytes ).equals( Buffer.from( packagedData.images[ 0 ].bytes ) ) ) throw new Error( `Scanned asset ${assetName} distance LOD must preserve its albedo bytes` );
	debrisAssetIDs.set( assetName, packagedID );
	debrisLODAssetIDs.set( assetName, packagedLODID );
	debrisAssetBounds.set( assetName, boundsForGLB( packagedGLB, packagedLODGLB ) );
	staticAssets.set( packagedID, packagedGLB );
	staticAssets.set( packagedLODID, packagedLODGLB );
}
const ambientBeds = [];
const ambientBedSpecs = [
	{ name: 'surf_far', target: MIX.surfFar, condition: 'always' },
	{ name: 'wind', target: MIX.wind, condition: 'always' },
	{ name: 'palms', target: MIX.palms, condition: 'always' },
	{ name: 'crickets', target: MIX.crickets, condition: 'night' },
	{ name: 'pier_lap', target: MIX.pierLap, condition: 'always', position: [ WORLD.pier.x, 0, 35 ], refDistance: 3, rolloff: 1.3 },
	{ name: 'under_reef', target: MIX.reef, condition: 'underwater' },
	{ name: 'boat_lap', target: MIX.boatLap, condition: 'always', position: [ WORLD.boatDock.position.x, WORLD.boatDock.position.y, WORLD.boatDock.position.z ], refDistance: 3, rolloff: 1 },
	{ name: 'birds_dawn', target: MIX.birdChorus, condition: 'dawn' },
];
for ( const spec of ambientBedSpecs ) {
	const bank = BANK[ spec.name ];
	if ( ! bank?.loop || ! Number.isFinite( bank.lufs ) ) throw new Error( `Ambient sound ${spec.name} must have measured loop metadata` );
	const bytes = await readFile( path.join( REPO, 'public', 'audio', bank.file ) );
	const id = `sha256:${createHash( 'sha256' ).update( bytes ).digest( 'hex' )}`;
	staticAssets.set( id, bytes );
	ambientBeds.push( {
		assetId: id,
		gain: Math.pow( 10, ( spec.target - bank.lufs ) / 20 ),
		condition: spec.condition,
		...( spec.position ? { position: spec.position, refDistance: spec.refDistance, rolloff: spec.rolloff } : {} ),
	} );
}
if ( reefComponents.length + 3 > 128 ) throw new Error( 'Island world exceeds the 128 component limit after adding ambient audio' );
const assetsPath = path.join( output, 'assets' );
await mkdir( assetsPath, { recursive: true } );
for ( const entry of await readdir( assetsPath, { withFileTypes: true } ) ) {
	if ( entry.isFile() && /^[0-9a-f]{64}$/.test( entry.name ) && ! [ ...staticAssets.keys() ].some( ( id ) => id.slice( 'sha256:'.length ) === entry.name ) ) await rm( path.join( assetsPath, entry.name ) );
}
for ( const [ id, bytes ] of staticAssets ) await writeFile( path.join( assetsPath, id.slice( 'sha256:'.length ) ), bytes );

const source = {
	protocol: 'tidewater.world-source/1',
	worldId: 'tw-world:example-island',
	title: 'Example Island',
	experience: JSON.parse( await readFile( path.join( REPO, 'worlds/island/presentation.json' ), 'utf8' ) ),
	spawn: generated.spawn,
	coordinateSystem: 'right-handed-y-up-meters',
	styleGuide: 'Procedural volcanic island terrain. Preserve the coast, central bay, volcanic ridge, beaches, seabed, and terrain color regions.',
	rules: {
		gravity: 1,
		seaLevel: 0,
		avatarComplexity: 20000,
		physicsProfile: 'tidewater-default',
		vehiclePolicy: { enabled: true, maxSpeed: 8, maxCombinedComplexity: 100000 },
			requiredFeatures: [ 'tidewater.static-glb/1', 'tidewater.static-glb-quaternion/1', 'tidewater.village-materials/1', 'tidewater.village-materials/2', 'tidewater.terrain-surface/1', 'tidewater.static-vegetation/1', 'tidewater.static-reef/1', 'tidewater.island-ocean/1', 'tidewater.downeast-boat/1', 'tidewater.ambient-audio/1', 'tidewater.portal-handoff/1', 'tidewater.portal-preview-static/1' ],
		maxPackageBytes: 128 * 1024 * 1024,
	},
	hosts: [],
	objects: [ {
		id: 'tw-object:island-terrain',
		kind: 'asset-instance',
		label: 'Procedural island terrain',
		assetId,
		priority: 'visible',
		replacesObjectId: 'tw-object:island-terrain-preview',
		streamingBounds: { center: [ 0, 0, 0 ], radius: 500 },
		transform: { position: [ 0, 0, 0 ], yaw: 0 },
		scale: [ 1, 1, 1 ],
		collision: { shape: 'heightfield', enabled: true, columns: 513, rows: 513, walkable: true, solid: true },
	}, {
		id: 'tw-object:island-terrain-preview',
		kind: 'asset-instance',
		label: 'Portal preview terrain',
		assetId: terrainPreviewAssetId,
		priority: 'portal-preview',
		streamingBounds: { center: [ 0, 0, 0 ], radius: 500 },
		transform: { position: [ 0, 0, 0 ], yaw: 0 },
		scale: [ 1, 1, 1 ],
		collision: { shape: 'none', enabled: false },
	}, {
		id: 'tw-object:island-village',
		kind: 'asset-instance',
		label: 'Procedural village, pier and harbor',
		assetId: villageAssetId,
		lods: [ { assetId: villageLODAssetId, maxScreenFraction: 0.45 } ],
		priority: 'visible',
		streamingBounds: villageBounds,
		transform: { position: [ 0, 0, 0 ], yaw: 0 },
		scale: [ 1, 1, 1 ],
		collision: { shape: 'compound', enabled: true, boxes: generated.villageColliders },
	}, {
		id: 'tw-object:moored-lobster-boat',
		kind: 'asset-instance',
		label: 'Moored lobster boat (static preview)',
		assetId: boatAssetId,
		lods: [ { assetId: boatLODAssetId, maxScreenFraction: 0.45 } ],
		priority: 'portal-preview',
		streamingBounds: boatBounds,
		transform: { position: [ WORLD.boatDock.position.x, WORLD.boatDock.position.y, WORLD.boatDock.position.z ], yaw: WORLD.boatDock.heading },
		scale: [ 1, 1, 1 ],
		collision: { shape: 'none', enabled: false },
	}, ...debris.map( ( instance, index ) => {
		const assetName = SCAN_ASSETS[ instance.asset ];
		const rotation = new Quaternion().setFromEuler( new Euler( instance.roll || 0, instance.yaw, instance.pitch || 0, 'YXZ' ) ).toArray();
		return {
			id: `tw-object:scanned-debris-${index}`,
			kind: 'asset-instance',
			label: assetName.replaceAll( '_', ' ' ),
			assetId: debrisAssetIDs.get( assetName ),
			lods: [ { assetId: debrisLODAssetIDs.get( assetName ), maxScreenFraction: 0.45 } ],
			priority: 'visible',
			streamingBounds: debrisAssetBounds.get( assetName ),
			transform: { position: [ instance.x, instance.y, instance.z ], yaw: instance.yaw, rotation },
			scale: [ instance.sx, instance.sy, instance.sz ],
			collision: { shape: 'none', enabled: false },
		};
	} ) ],
	components: [
		{ id: 'tw-component:island-village-materials', type: 'tidewater.village-materials/2', profile: 'original-tidewater-village-v1', dataAssetId: villageMaterialsAssetId, objectId: 'tw-object:island-village', priority: 'visible', streamingBounds: villageBounds },
		{ id: 'tw-component:island-vegetation', type: 'tidewater.static-vegetation/1', priority: 'portal-preview', placementAssetId: vegetationAssetId },
		{ id: 'tw-component:island-terrain', type: 'tidewater.terrain-surface/1', profile: 'example-island-v1', objectId: 'tw-object:island-terrain', dataAssetId: terrainSurfaceAssetId, priority: 'visible' },
		...reefComponents,
		{ id: 'tw-component:island-ocean', type: 'tidewater.island-ocean/1', priority: 'portal-preview' },
		{ id: 'tw-component:island-lobster-boat', type: 'tidewater.downeast-boat/1', objectId: 'tw-object:moored-lobster-boat', priority: 'portal-preview' },
		{ id: 'tw-component:island-ambience', type: 'tidewater.ambient-audio/1', priority: 'portal-preview', beds: ambientBeds },
	],
	portals: [ {
		id: 'tw-portal:loz-underneath',
		destinationWorldId: 'tw-world:loz-underneath',
		entry: { position: [ - 340, 4.2, 80 ], yaw: Math.PI / 2 },
		exit: { position: [ 0, 4.2, 8 ], yaw: Math.PI / 2 },
		visual: 'timber',
		openView: true,
		enabled: true,
	} ],
	updatedAt,
};
await writeFile( sourcePath, `${JSON.stringify( source, null, 2 )}\n` );
console.log( `Wrote ${sourcePath}` );
const boatTriangles = generated.boatBatches.reduce( ( count, { batch } ) => count + batch.idx.length / 3, 0 );
console.log( `Wrote ${staticAssets.size} content-addressed assets (${generated.villageTriangles} village triangles, ${boatTriangles} boat triangles, ${debris.length} scanned debris instances)` );
console.log( `Reef export: ${reefRecords.length} records, ${reefTiles.length} tiles, ${reefAssetBytes} encoded bytes` );

function tileReefPlacements( records, tileSize, modelRadius ) {
	const tiles = new Map();
	for ( const record of records ) {
		const x = Math.floor( record.x / tileSize ), z = Math.floor( record.z / tileSize );
		const key = `${x},${z}`;
		let tile = tiles.get( key );
		if ( ! tile ) tiles.set( key, tile = { x, z, records: [] } );
		tile.records.push( record );
	}
	return [ ...tiles.values() ].sort( ( a, b ) => a.z - b.z || a.x - b.x ).map( ( tile ) => {
		const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
		for ( const record of tile.records ) {
			// The maximum LOD0 geometry radius is measured from all eight bounding-box
			// corners above, so it encloses every species vertex; max scale covers the
			// nonuniform stretch and the renderer's reciprocal-X bound for narrow forms.
			const scale = record.s * Math.max( record.sx, 1 / record.sx, record.sy, record.sz );
			const extent = modelRadius * scale;
			for ( const [ axis, value ] of [ record.x, record.y, record.z ].entries() ) {
				min[ axis ] = Math.min( min[ axis ], value - extent );
				max[ axis ] = Math.max( max[ axis ], value + extent );
			}
		}
		const center = min.map( ( value, axis ) => ( value + max[ axis ] ) * 0.5 );
		const radius = Math.max( 0.01, Math.hypot( ...max.map( ( value, axis ) => ( value - min[ axis ] ) * 0.5 ) ) );
		return { ...tile, bounds: { center, radius } };
	} );
}

function buildIslandProceduralContent( terrainData ) {
	const scene = { add() {}, remove() {} };
	// Keep the CPU-built batches for export and skip GPU-backed fish, textures, and animated details.
	class PackageVillage extends Village {
		_assemble() { this.meshes = []; }
		_buildSign() {}
		_buildLanterns() {}
	}
	const colliders = new Colliders();
	const village = new PackageVillage( { scene, terrain: terrainData, colliders } );
	const vegetation = createVegetationPlacement( terrainData, village );
	const rocks = new Rocks( { scene, terrain: terrainData, village, colliders, castShadow: false, sunShadow: false } );
	const villageColliders = colliders.boxes.map( ( box ) => ( {
		center: box.center.toArray(),
		halfExtents: box.half.toArray(),
		yaw: box.rotY,
		walkable: box.walkable,
		solid: box.solid,
	} ) );
	const B = new Builder();
	const placer = new DebrisPlacer( { B, inst: new InstancedProps( B ), terrain: terrainData, village, vegetation, rocks, colliders } ).run();
	foldVillageMaterialBatches( village.B );
	const batches = Object.entries( village.B.batches )
		.filter( ( [ , batch ] ) => batch.vcount > 0 )
		.map( ( [ name, batch ] ) => ( { name, batch } ) );
	for ( const [ name, batch ] of Object.entries( village.signB?.batches || {} ) ) if ( batch.vcount > 0 ) batches.push( { name: `sign-${name}`, batch } );
	return {
		spawn: { position: [ WORLD.start.position.x, Math.max( terrainData.heightAt( WORLD.start.position.x, WORLD.start.position.z ), colliders.groundHeightAt( WORLD.start.position.x, WORLD.start.position.z, 50 ) ) + 1.62, WORLD.start.position.z ], yaw: WORLD.start.yaw, pitch: - 0.05 },
		villageBatches: batches,
		villageTriangles: batches.reduce( ( total, { batch } ) => total + batch.triangles, 0 ),
		villageColliders,
		boatBatches: buildBoatBatches(),
		debris: placer.scanned,
		vegetation: vegetation.records,
	};
}

// Preserve the exact material packing used by Village._assemble().
function foldVillageMaterialBatches( builder ) {
	const take = ( key ) => { const batch = builder.batches[ key ]; delete builder.batches[ key ]; return batch; };
	const wood = builder.batch( 'wood' ), hard = builder.batch( 'hard' ), fabric = builder.batch( 'fabric' );
	const glass = take( 'glass' ), rope = take( 'rope' ), cloth = take( 'cloth' ), net = take( 'net' ), flag = take( 'flag' );
	if ( glass ) wood.append( glass, ( d ) => [ d[ 0 ], d[ 1 ], 9, d[ 2 ] ] );
	if ( rope ) hard.append( rope, ( d ) => [ d[ 0 ], 0, 0, 2 + d[ 1 ] ] );
	if ( cloth ) fabric.append( cloth, ( d ) => [ d[ 0 ], d[ 1 ], 0, 0 ] );
	const nets = new Batch();
	if ( net ) nets.append( net, ( d ) => [ d[ 0 ], d[ 1 ], Math.max( 0.02, d[ 2 ] ), 0 ] );
	if ( flag ) fabric.append( flag, ( d ) => [ d[ 0 ], d[ 1 ], d[ 2 ] + 10000, d[ 3 ] ] );
	if ( nets.vcount > 0 ) builder.batches.net = nets;
}

function buildBoatBatches() {

	const boat = new BoatModel();
	boat.group.updateWorldMatrix( true, true );
	const batches = [];
	boat.group.traverse( ( object ) => {

		if ( ! object.isMesh || ! object.geometry.index ) return;
		const geometry = object.geometry.clone().applyMatrix4( object.matrixWorld );
		const attribute = ( name ) => geometry.attributes[ name ].array;
		const batch = {
			pos: Float32Array.from( attribute( 'position' ) ),
			nrm: Float32Array.from( attribute( 'normal' ) ),
			uv: Float32Array.from( attribute( 'uv' ) ),
			tint: Float32Array.from( attribute( 'color' ) ),
			idx: Uint32Array.from( geometry.index.array ),
		};
		batches.push( { name: `boat-${object.name.replace( 'boat-', '' )}`, batch } );

	} );
	if ( batches.length === 0 ) throw new Error( 'Procedural lobster boat produced no exportable geometry' );
	return batches;

}

function exportBatchGLB( batches, sceneName, villageMaterials = false ) {
	const chunks = [], bufferViews = [], accessors = [];
	let byteLength = 0;
	const append = ( typed, target ) => {
		const bytes = Buffer.from( typed.buffer, typed.byteOffset, typed.byteLength );
		const padding = ( 4 - byteLength % 4 ) % 4;
		if ( padding ) { chunks.push( Buffer.alloc( padding ) ); byteLength += padding; }
		const view = bufferViews.length;
		bufferViews.push( { buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target } );
		chunks.push( bytes );
		byteLength += bytes.length;
		return view;
	};
	const accessor = ( typed, target, type, componentType = 5126 ) => {
		const bufferView = append( typed, target );
		const size = type === 'VEC4' ? 4 : type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1;
		const index = accessors.length;
		accessors.push( { bufferView, componentType, count: typed.length / size, type } );
		return index;
	};
	const primitives = [], materials = [];
	for ( const { name, batch } of batches ) {
		const material = materials.length;
		const role = name.startsWith( 'sign-' ) ? name.slice( 5 ) : name;
		if ( villageMaterials && ! VILLAGE_MATERIAL_ROLES.includes( role ) ) throw new Error( `Unknown village material role: ${role}` );
		materials.push( {
			...( villageMaterials ? { extras: { tidewaterMaterial: { profile: VILLAGE_MATERIAL_PROFILE, role } } } : {} ),
			name: `${sceneName} ${name}`,
			pbrMetallicRoughness: { baseColorFactor: [ 1, 1, 1, 1 ], metallicFactor: 0, roughnessFactor: name.includes( 'roofMetal' ) ? 0.72 : name.includes( 'boat-glass' ) ? 0.35 : 0.82 },
			doubleSided: true,
		} );
		primitives.push( {
			attributes: {
				POSITION: accessor( Float32Array.from( batch.pos ), 34962, 'VEC3' ),
				NORMAL: accessor( Float32Array.from( batch.nrm ), 34962, 'VEC3' ),
				TEXCOORD_0: accessor( Float32Array.from( batch.uv ), 34962, 'VEC2' ),
				COLOR_0: accessor( Float32Array.from( batch.tint ), 34962, 'VEC3' ),
				...( villageMaterials ? { _TW_VDATA: accessor( Float32Array.from( batch.data ), 34962, 'VEC4' ) } : {} ),
			},
			indices: accessor( Uint32Array.from( batch.idx ), 34963, 'SCALAR', 5125 ),
			material,
			mode: 4,
		} );
	}
	const binary = Buffer.concat( chunks );
	const gltf = {
		asset: { version: '2.0', generator: 'ElseMesh island village exporter/1' },
		scene: 0, scenes: [ { nodes: [ 0 ] } ], nodes: [ { name: 'Procedural village', mesh: 0 } ],
		meshes: [ { name: 'Procedural village', primitives } ], materials, accessors, bufferViews,
		buffers: [ { byteLength: binary.length } ],
	};
	const json = Buffer.from( JSON.stringify( gltf ) );
	const jsonPadded = Buffer.concat( [ json, Buffer.alloc( ( 4 - json.length % 4 ) % 4, 0x20 ) ] );
	const binPadded = Buffer.concat( [ binary, Buffer.alloc( ( 4 - binary.length % 4 ) % 4 ) ] );
	const totalLength = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
	const header = Buffer.alloc( 12 );
	header.writeUInt32LE( 0x46546c67, 0 ); header.writeUInt32LE( 2, 4 ); header.writeUInt32LE( totalLength, 8 );
	const jsonHeader = Buffer.alloc( 8 ); jsonHeader.writeUInt32LE( jsonPadded.length, 0 ); jsonHeader.writeUInt32LE( 0x4e4f534a, 4 );
	const binHeader = Buffer.alloc( 8 ); binHeader.writeUInt32LE( binPadded.length, 0 ); binHeader.writeUInt32LE( 0x004e4942, 4 );
	return Buffer.concat( [ header, jsonHeader, jsonPadded, binHeader, binPadded ] );
}

function exportScannedLOD( sourceBytes, albedoBytes, name, meshIndex ) {
	const parsed = parseGLB( sourceBytes.buffer.slice( sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength ) );
	const primitive = parsed.meshes[ meshIndex ]?.[ 0 ];
	if ( ! primitive?.attributes?.POSITION || ! primitive.attributes.NORMAL || ! primitive.attributes.TEXCOORD_0 || ! primitive.indices ) throw new Error( `Scanned asset ${name} has no supported LOD${meshIndex} triangle mesh` );
	const chunks = [];
	const bufferViews = [];
	const accessors = [];
	let byteLength = 0;
	const append = ( bytes, { target, mimeType } = {} ) => {
		const padding = ( 4 - byteLength % 4 ) % 4;
		if ( padding ) { chunks.push( Buffer.alloc( padding ) ); byteLength += padding; }
		const view = { buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength };
		if ( target !== undefined ) view.target = target;
		if ( mimeType ) view.mimeType = mimeType;
		bufferViews.push( view );
		chunks.push( bytes );
		byteLength += bytes.byteLength;
		return bufferViews.length - 1;
	};
	const addAccessor = ( attribute, type, target, bounds = false ) => {
		const bytes = Buffer.from( attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength );
		const bufferView = append( bytes, { target } );
		const accessor = { bufferView, componentType: attribute.componentType, count: attribute.array.length / attribute.itemSize, type };
		if ( attribute.normalized ) accessor.normalized = true;
		if ( bounds ) {
			const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
			for ( let i = 0; i < attribute.array.length; i += 3 ) for ( let axis = 0; axis < 3; axis ++ ) {
				min[ axis ] = Math.min( min[ axis ], attribute.array[ i + axis ] );
				max[ axis ] = Math.max( max[ axis ], attribute.array[ i + axis ] );
			}
			accessor.min = min; accessor.max = max;
		}
		accessors.push( accessor );
		return accessors.length - 1;
	};
	const attributes = primitive.attributes;
	const position = addAccessor( attributes.POSITION, 'VEC3', 34962, true );
	const normal = addAccessor( attributes.NORMAL, 'VEC3', 34962 );
	const sourceUV = attributes.TEXCOORD_0;
	const uvArray = Float32Array.from( sourceUV.array, ( value ) => Math.min( 0.998, Math.max( 0.002, value ) ) );
	const uv = addAccessor( { ...sourceUV, array: uvArray, componentType: 5126, normalized: false }, 'VEC2', 34962 );
	const indices = addAccessor( { array: primitive.indices, itemSize: 1, componentType: primitive.indices instanceof Uint32Array ? 5125 : 5123 }, 'SCALAR', 34963 );
	const imageView = append( albedoBytes, { mimeType: 'image/jpeg' } );
	const binary = Buffer.concat( chunks );
	const gltf = {
		asset: { version: '2.0', generator: 'ElseMesh island scanned asset exporter/1' },
		scene: 0, scenes: [ { nodes: [ 0 ] } ], nodes: [ { name, mesh: 0 } ],
		meshes: [ { name, primitives: [ { attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, indices, material: 0, mode: 4 } ] } ],
		materials: [ { name: `${name} albedo`, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } } ],
		textures: [ { sampler: 0, source: 0 } ], samplers: [ { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 } ],
		images: [ { bufferView: imageView, mimeType: 'image/jpeg', name: `${name} albedo` } ],
		accessors, bufferViews, buffers: [ { byteLength: binary.length } ],
	};
	const json = Buffer.from( JSON.stringify( gltf ) );
	const jsonPadded = Buffer.concat( [ json, Buffer.alloc( ( 4 - json.length % 4 ) % 4, 0x20 ) ] );
	const binPadded = Buffer.concat( [ binary, Buffer.alloc( ( 4 - binary.length % 4 ) % 4 ) ] );
	const totalLength = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
	const header = Buffer.alloc( 12 );
	header.writeUInt32LE( 0x46546c67, 0 ); header.writeUInt32LE( 2, 4 ); header.writeUInt32LE( totalLength, 8 );
	const jsonHeader = Buffer.alloc( 8 ); jsonHeader.writeUInt32LE( jsonPadded.length, 0 ); jsonHeader.writeUInt32LE( 0x4e4f534a, 4 );
	const binHeader = Buffer.alloc( 8 ); binHeader.writeUInt32LE( binPadded.length, 0 ); binHeader.writeUInt32LE( 0x004e4942, 4 );
	return Buffer.concat( [ header, jsonHeader, jsonPadded, binHeader, binPadded ] );
}

function boundsForGLB( ...assets ) {
	const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
	let found = false;
	const parsedAssets = assets.map( bytes => parseGLB( bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength ) ) );
	for ( const parsed of parsedAssets ) for ( const primitive of parsed.meshes.flat() ) {
		const positions = primitive.attributes?.POSITION?.array;
		if ( ! positions?.length ) continue;
		found = true;
		for ( let index = 0; index < positions.length; index += 3 ) for ( let axis = 0; axis < 3; axis ++ ) {
			min[ axis ] = Math.min( min[ axis ], positions[ index + axis ] );
			max[ axis ] = Math.max( max[ axis ], positions[ index + axis ] );
		}
	}
	if ( ! found ) throw new Error( 'Exported asset has no positions for streaming bounds' );
	const center = min.map( ( value, axis ) => ( value + max[ axis ] ) * 0.5 );
	let radiusSq = 0;
	for ( const parsed of parsedAssets ) for ( const primitive of parsed.meshes.flat() ) {
		const positions = primitive.attributes?.POSITION?.array;
		if ( ! positions ) continue;
		for ( let index = 0; index < positions.length; index += 3 ) radiusSq = Math.max( radiusSq, ( positions[ index ] - center[ 0 ] ) ** 2 + ( positions[ index + 1 ] - center[ 1 ] ) ** 2 + ( positions[ index + 2 ] - center[ 2 ] ) ** 2 );
	}
	return { center, radius: Math.max( 0.01, Math.sqrt( radiusSq ) ) };
}

function exportTerrain( data, segments ) {
	const side = segments + 1;
	const vertexCount = side * side;
	const indexCount = segments * segments * 6;
	const positions = Buffer.allocUnsafe( vertexCount * 3 * 4 );
	const normals = Buffer.allocUnsafe( vertexCount * 3 * 4 );
	const colors = Buffer.allocUnsafe( vertexCount * 3 );
	const indices = Buffer.allocUnsafe( indexCount * 4 );
	const p = new DataView( positions.buffer, positions.byteOffset, positions.byteLength );
	const n = new DataView( normals.buffer, normals.byteOffset, normals.byteLength );
	const indexView = new DataView( indices.buffer, indices.byteOffset, indices.byteLength );
	const normal = { set( x, y, z ) { this.x = x; this.y = y; this.z = z; return this; }, normalize() { const l = Math.hypot( this.x, this.y, this.z ); this.x /= l; this.y /= l; this.z /= l; return this; } };
	const mins = [ Infinity, Infinity, Infinity ], maxs = [ - Infinity, - Infinity, - Infinity ];

	for ( let z = 0; z < side; z ++ ) {
		const sampleZ = z * ( data.res - 1 ) / segments;
		const iz = Math.round( sampleZ );
		const worldZ = data.origin + ( sampleZ + 0.5 ) * data.texel;
		for ( let x = 0; x < side; x ++ ) {
			const sampleX = x * ( data.res - 1 ) / segments;
			const ix = Math.round( sampleX );
			const worldX = data.origin + ( sampleX + 0.5 ) * data.texel;
			const sourceIndex = iz * data.res + ix;
			const height = data.heights[ sourceIndex ];
			const vertex = z * side + x;
			const offset = vertex * 3;
			p.setFloat32( offset * 4, worldX, true );
			p.setFloat32( ( offset + 1 ) * 4, height, true );
			p.setFloat32( ( offset + 2 ) * 4, worldZ, true );
			data.normalAt( worldX, worldZ, normal );
			n.setFloat32( offset * 4, normal.x, true );
			n.setFloat32( ( offset + 1 ) * 4, normal.y, true );
			n.setFloat32( ( offset + 2 ) * 4, normal.z, true );
			const rgb = terrainColor( height, data.rock[ sourceIndex ], data.sand[ sourceIndex ], data.path[ sourceIndex ], data.seagrass[ sourceIndex ], data.rubble[ sourceIndex ], data.scarp[ sourceIndex ] );
			colors[ offset ] = rgb[ 0 ]; colors[ offset + 1 ] = rgb[ 1 ]; colors[ offset + 2 ] = rgb[ 2 ];
			mins[ 0 ] = Math.min( mins[ 0 ], worldX ); maxs[ 0 ] = Math.max( maxs[ 0 ], worldX );
			mins[ 1 ] = Math.min( mins[ 1 ], height ); maxs[ 1 ] = Math.max( maxs[ 1 ], height );
			mins[ 2 ] = Math.min( mins[ 2 ], worldZ ); maxs[ 2 ] = Math.max( maxs[ 2 ], worldZ );
		}
	}

	let cursor = 0;
	for ( let z = 0; z < segments; z ++ ) for ( let x = 0; x < segments; x ++ ) {
		const a = z * side + x, b = a + 1, c = a + side, d = c + 1;
		indexView.setUint32( cursor, a, true ); cursor += 4;
		indexView.setUint32( cursor, c, true ); cursor += 4;
		indexView.setUint32( cursor, b, true ); cursor += 4;
		indexView.setUint32( cursor, b, true ); cursor += 4;
		indexView.setUint32( cursor, c, true ); cursor += 4;
		indexView.setUint32( cursor, d, true ); cursor += 4;
	}

	const colorPadding = Buffer.alloc( ( 4 - colors.length % 4 ) % 4 );
	const bin = Buffer.concat( [ positions, normals, colors, colorPadding, indices ] );
	const bufferViews = [
		{ buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 },
		{ buffer: 0, byteOffset: positions.length, byteLength: normals.length, target: 34962 },
		{ buffer: 0, byteOffset: positions.length + normals.length, byteLength: colors.length, target: 34962 },
		{ buffer: 0, byteOffset: positions.length + normals.length + colors.length + colorPadding.length, byteLength: indices.length, target: 34963 },
	];
	const gltf = {
		asset: { version: '2.0', generator: 'ElseMesh deterministic island exporter/1' },
		scene: 0,
		scenes: [ { nodes: [ 0 ] } ],
		nodes: [ { name: 'Procedural island terrain', mesh: 0 } ],
		meshes: [ { primitives: [ { attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0, mode: 4 } ] } ],
		materials: [ { name: 'Island terrain vertex colors', pbrMetallicRoughness: { baseColorFactor: [ 1, 1, 1, 1 ], metallicFactor: 0, roughnessFactor: 0.94 }, doubleSided: false } ],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: vertexCount, type: 'VEC3', min: mins, max: maxs },
			{ bufferView: 1, componentType: 5126, count: vertexCount, type: 'VEC3' },
			{ bufferView: 2, componentType: 5121, normalized: true, count: vertexCount, type: 'VEC3' },
			{ bufferView: 3, componentType: 5125, count: indexCount, type: 'SCALAR' },
		],
		bufferViews,
		buffers: [ { byteLength: bin.length } ],
	};
	const json = Buffer.from( JSON.stringify( gltf ) );
	const jsonPadded = Buffer.concat( [ json, Buffer.alloc( ( 4 - json.length % 4 ) % 4, 0x20 ) ] );
	const binPadded = Buffer.concat( [ bin, Buffer.alloc( ( 4 - bin.length % 4 ) % 4 ) ] );
	const totalLength = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
	const header = Buffer.alloc( 12 );
	header.writeUInt32LE( 0x46546c67, 0 ); header.writeUInt32LE( 2, 4 ); header.writeUInt32LE( totalLength, 8 );
	const jsonHeader = Buffer.alloc( 8 ); jsonHeader.writeUInt32LE( jsonPadded.length, 0 ); jsonHeader.writeUInt32LE( 0x4e4f534a, 4 );
	const binHeader = Buffer.alloc( 8 ); binHeader.writeUInt32LE( binPadded.length, 0 ); binHeader.writeUInt32LE( 0x004e4942, 4 );
	return Buffer.concat( [ header, jsonHeader, jsonPadded, binHeader, binPadded ] );
}

function terrainColor( height, rock, sand, path, seagrass, rubble, scarp ) {
	const mix = ( a, b, t ) => Math.round( a + ( b - a ) * t );
	const smooth = ( a, b, x ) => { const t = Math.max( 0, Math.min( 1, ( x - a ) / ( b - a ) ) ); return t * t * ( 3 - 2 * t ); };
	const beach = [ 194, 163, 111 ];
	const grass = [ 82, 112, 49 ];
	const darkGrass = [ 52, 75, 38 ];
	const stone = [ 106, 104, 94 ];
	const seabed = [ 76, 91, 75 ];
	const green = [ 39, 87, 57 ];
	const loose = Math.max( 0, Math.min( 1, sand / 255 ) );
	const rockMask = Math.max( Math.max( 0, Math.min( 1, rock ) ), Math.max( 0, Math.min( 1, scarp / 255 ) ) * 0.92 );
	const pathMask = Math.max( 0, Math.min( 1, path / 255 ) ) * 0.82;
	const grassFactor = smooth( 0.3, 5, height );
	let color = beach.map( ( c, i ) => mix( c, grass[ i ], grassFactor ) );
	color = color.map( ( c, i ) => mix( c, darkGrass[ i ], smooth( 24, 54, height ) * 0.3 ) );
	color = color.map( ( c, i ) => mix( c, stone[ i ], rockMask ) );
	color = color.map( ( c, i ) => mix( c, [ 119, 99, 66 ][ i ], pathMask ) );
	color = color.map( ( c, i ) => mix( c, seabed[ i ], ( 1 - smooth( - 22, - 3, height ) ) * ( 1 - loose * 0.3 ) ) );
	const meadow = Math.max( 0, Math.min( 1, seagrass / 255 ) );
	color = color.map( ( c, i ) => mix( c, green[ i ], meadow ) );
	const coralRubble = Math.max( 0, Math.min( 1, rubble / 255 ) );
	color = color.map( ( c, i ) => mix( c, [ 74, 69, 58 ][ i ], coralRubble ) );
	return color;
}
