import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGLB } from '../src/engine/loaders/GLTF.js';
import { loadWorldPackage, registerWorldPackageCollisions, unregisterWorldPackageCollisions, disposeWorldPackage } from '../src/network/WorldPackage.js';
import { validateWorldSource } from '../src/network/WorldSource.js';
import { validateWorldRequirements } from '../src/network/WorldRules.js';
import { Colliders } from '../src/world/Colliders.js';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const temporaryBase = process.env.PREFIX?.startsWith( '/data/data/' ) ? path.join( process.env.PREFIX, 'tmp' ) : '/var/tmp';
const output = await mkdtemp( path.join( temporaryBase, 'elsemesh-loz-underneath-' ) );
const packageDir = path.join( root, 'worlds/loz-underneath' );

try {
	for ( let exportCount = 0; exportCount < 2; exportCount ++ ) execFileSync( process.execPath, [ 'tools/export-loz-underneath.mjs', '--out', output ], { cwd: root, stdio: 'ignore' } );
	const generatedSourceBytes = await readFile( path.join( output, 'world-source.json' ) );
	const checkedSourceBytes = await readFile( path.join( packageDir, 'world-source.json' ) );
	assert.deepEqual( generatedSourceBytes, checkedSourceBytes, 'checked-in cave source matches a clean deterministic export' );
	const source = validateWorldSource( JSON.parse( generatedSourceBytes ) );
	assert.equal( source.worldId, 'tw-world:loz-underneath' );
	assert.equal( source.title, 'UNDERNEATH: Basalt Cavern' );
	assert.deepEqual( source.rules.requiredFeatures, [ 'tidewater.static-glb/1', 'tidewater.static-glb-emissive-strength/1', 'tidewater.ambient-audio/1', 'tidewater.portal-handoff/1', 'tidewater.portal-preview-static/1' ] );
	const rulesWithoutPackageBudget = { ...source.rules };
	delete rulesWithoutPackageBudget.maxPackageBytes;
	assert.doesNotThrow( () => validateWorldRequirements( { rules: rulesWithoutPackageBudget, assets: [] } ), 'browser recognizes every capability required by this package' );
	assert.equal( source.objects.length, 1 );
	assert.match( source.objects[ 0 ].assetId, /^sha256:[0-9a-f]{64}$/ );
	assert.equal( source.objects[ 0 ].priority, 'portal-preview', 'the complete compact cave scene can be staged behind an open portal before arrival' );
	assert.equal( source.objects[ 0 ].collision.shape, 'compound' );
	assert.deepEqual( source.portals, [ {
		id: 'tw-portal:example-island', destinationWorldId: 'tw-world:example-island',
		entry: { position: [ 0, 4.2, 8 ], yaw: Math.PI / 2 }, exit: { position: [ - 340, 4.2, 80 ], yaw: Math.PI / 2 }, visual: 'stone', openView: true, enabled: true,
	} ], 'the cave ships a reciprocal, provider-discoverable portal at its mapped entrance' );
	const islandSource = validateWorldSource( JSON.parse( await readFile( path.join( root, 'worlds/island/world-source.json' ), 'utf8' ) ) );
	assert.deepEqual( islandSource.portals, [ {
		id: 'tw-portal:loz-underneath', destinationWorldId: source.worldId,
		entry: { position: [ - 340, 4.2, 80 ], yaw: Math.PI / 2 }, exit: { position: [ 0, 4.2, 8 ], yaw: Math.PI / 2 }, visual: 'timber', openView: true, enabled: true,
	} ], 'the island ships the reciprocal portal to the cave world' );
	assert.ok( source.objects[ 0 ].collision.boxes.length > 300 && source.objects[ 0 ].collision.boxes.length <= 2048, 'the converted cave layout has bounded floor and wall proxies' );
	assert.ok( source.objects[ 0 ].collision.boxes.some( box => box.walkable ) && source.objects[ 0 ].collision.boxes.some( box => ! box.walkable && box.solid ), 'collision includes both walkable floors and solid walls' );
	const ambience = source.components.find( component => component.type === 'tidewater.ambient-audio/1' );
	assert.equal( ambience?.beds.length, 1, 'the cave package carries one ambient loop' );
	assert.equal( ambience.beds[ 0 ].gain, 0.1 );
	assert.equal( ambience.beds[ 0 ].condition, 'always' );
	const referencedIDs = new Set( [ ...source.objects.flatMap( object => [ object.assetId, ...( object.lods || [] ).map( lod => lod.assetId ) ] ), ...source.components.flatMap( component => ( component.beds || [] ).map( bed => bed.assetId ) ) ] );
	const files = ( await readdir( path.join( output, 'assets' ) ) ).sort();
	assert.deepEqual( files, [ ...referencedIDs ].map( id => id.slice( 'sha256:'.length ) ).sort(), 'package contains exactly the assets referenced by its source' );
	for ( const assetID of referencedIDs ) {
		const bytes = await readFile( path.join( output, 'assets', assetID.slice( 'sha256:'.length ) ) );
		assert.equal( `sha256:${createHash( 'sha256' ).update( bytes ).digest( 'hex' )}`, assetID, 'each generated package asset matches its content hash' );
		assert.deepEqual( bytes, await readFile( path.join( packageDir, 'assets', assetID.slice( 'sha256:'.length ) ) ), 'checked-in package asset matches the reproducible output' );
	}
	const caveID = source.objects[ 0 ].assetId;
	const caveBytes = await readFile( path.join( output, 'assets', caveID.slice( 'sha256:'.length ) ) );
	const caveGLB = parseGLB( caveBytes );
	assert.equal( caveGLB.meshes.length, 145, 'the source cave GLB keeps all 145 named Blender mesh nodes' );
	assert.ok( caveGLB.json.extensionsUsed.includes( 'KHR_materials_emissive_strength' ), 'the authored cave light materials retain their emissive-strength extension' );
	assert.ok( caveGLB.materials.some( material => material.name.includes( 'Glow_Mineral' ) && material.extensions?.KHR_materials_emissive_strength?.emissiveStrength === 1.5 ), 'glowing minerals retain their authored strength' );
	const caveMaterialVariants = caveGLB.materials.filter( material => material.extensions?.KHR_materials_emissive_strength );
	assert.ok( caveMaterialVariants.length > 0 && caveMaterialVariants.every( material => material.emissiveFactor?.length === 3 ), 'every styled cave material has explicit portable emissive colors' );
	const caveLOD = source.objects[ 0 ].lods?.[ 0 ];
	assert.deepEqual( caveLOD && Object.keys( caveLOD ).sort(), [ 'assetId', 'maxScreenFraction' ], 'the cave distance level uses the signed object LOD contract' );
	assert.equal( source.objects[ 0 ].lods.length, 1 );
	assert.ok( source.objects[ 0 ].streamingBounds.radius > 0, 'cave LOD selection uses bounds in asset-local coordinates' );
	assert.ok( Math.abs( source.objects[ 0 ].streamingBounds.center[ 0 ] + 270 ) < 0.01 && source.objects[ 0 ].streamingBounds.radius < 100, 'cave bounds include every GLB node transform rather than raw mesh-local vertices' );
	const caveLODBytes = await readFile( path.join( output, 'assets', caveLOD.assetId.slice( 'sha256:'.length ) ) );
	const caveLODGLB = parseGLB( caveLODBytes );
	const triangles = glb => glb.meshes.flat().reduce( ( total, primitive ) => total + primitive.indices.length / 3, 0 );
	assert.ok( triangles( caveLODGLB ) < triangles( caveGLB ) * 0.75 && triangles( caveLODGLB ) > triangles( caveGLB ) * 0.65, 'cave distance level keeps a conservative 25–35% triangle reduction' );
	assert.deepEqual( caveLODGLB.materials, caveGLB.materials, 'cave LOD retains the exact authored material catalog, including emissive strengths' );
	assert.ok( caveLODGLB.meshes.flat().every( primitive => Number.isInteger( primitive.material ) && caveLODGLB.materials[ primitive.material ] ), 'cave LOD primitives retain valid authored material assignments' );
	assert.equal( caveLOD.maxScreenFraction, 0.45 );
	const audio = ambience.beds[ 0 ];
	const audioBytes = await readFile( path.join( output, 'assets', audio.assetId.slice( 'sha256:'.length ) ) );
	assert.deepEqual( audioBytes, await readFile( path.join( packageDir, 'source/under_reef.ogg' ) ), 'the shipped loop is the original archived LOZ audio recording' );

	const connector = { worldId: source.worldId, manifest: { ...source, assets: [ { id: caveID, bytes: caveBytes.length, kind: 'glb', priority: 'visible' } ], objects: source.objects } };
	const scene = await loadWorldPackage( connector, { assets: new Map( [ [ caveID, caveBytes ] ] ) } );
	let meshCount = 0, portalFrameMeshes = 0, emittedMaterials = 0;
	scene.traverse( object => {
		if ( ! object.isMesh ) return;
		meshCount ++;
		if ( object.parent?.userData.worldPortalFrame ) portalFrameMeshes ++;
		for ( const material of Array.isArray( object.material ) ? object.material : [ object.material ] ) {
			if ( material.emissiveIntensity > 0 && material.emissive?.getHex() !== 0 ) emittedMaterials ++;
		}
	} );
	assert.equal( meshCount, 148, 'hosted package loader instantiates all cave GLB meshes and the three doorway-frame meshes' );
	assert.equal( portalFrameMeshes, 3, 'hosted cave portal includes two stone jambs and a lintel' );
	assert.ok( emittedMaterials > 0, 'hosted GLB renderer applies material emissive colors and strengths' );
	const colliders = new Colliders();
	registerWorldPackageCollisions( scene, colliders );
	assert.equal( colliders.boxes.length, source.objects[ 0 ].collision.boxes.length, 'hosted cave installs every generated collision proxy' );
	unregisterWorldPackageCollisions( scene, colliders );
	assert.equal( colliders.boxes.length, 0, 'cave collision proxies are removed on world handoff' );
	disposeWorldPackage( scene );
	console.log( `LOZ UNDERNEATH package verified: ${meshCount} meshes and ${colliders.boxes.length} remaining colliders after cleanup` );
} finally {
	await rm( output, { recursive: true, force: true } );
}
