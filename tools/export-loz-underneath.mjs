#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGLB } from '../src/engine/loaders/GLTF.js';
import { Matrix4 } from '../src/engine/math/Matrix4.js';
import { Quaternion } from '../src/engine/math/Quaternion.js';
import { Vector3 } from '../src/engine/math/Vector3.js';
import { validateWorldSource } from '../src/network/WorldSource.js';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const packageDir = path.join( root, 'worlds/loz-underneath' );
const sourceDir = path.join( packageDir, 'source' );

function parseArgs( argv ) {
	const options = {};
	for ( let i = 0; i < argv.length; i ++ ) {
		if ( argv[ i ] !== '--out' || ! argv[ i + 1 ] || argv[ i + 1 ].startsWith( '--' ) || options.out ) throw new Error( `Invalid or incomplete option: ${argv[ i ]}` );
		options.out = path.resolve( argv[ ++ i ] );
	}
	return options;
}

function caveColor( name ) {
	if ( name.includes( 'Glow_Mineral' ) ) return 0x7fcbd1;
	if ( name.includes( 'Keypad_Light' ) || name.includes( 'Keypad_Screen' ) ) return 0x49d8e9;
	if ( name.includes( 'Waiting_Train_Headlight' ) || name.includes( 'Waiting_Train_Route_Display' ) || name.includes( 'Station_Ceiling_Light' ) || name.includes( 'Station_Wall_Light' ) || name.includes( 'Station_Destination_Glow' ) ) return 0xbce5d9;
	if ( name.includes( 'Waiting_Train_Windshield' ) || name.includes( 'Waiting_Train_Side_Window' ) ) return 0x102c3b;
	if ( name.includes( 'Waiting_Train_Door' ) || name.includes( 'Station_Preview_Safety_Stripe' ) ) return 0xd89a35;
	if ( name.includes( 'Waiting_Train_Belt' ) || name.includes( 'Waiting_Train_Nose_Band' ) ) return 0x447789;
	if ( name.includes( 'Waiting_Train_Body' ) ) return 0x547581;
	if ( name.includes( 'Waiting_Train_Nose_Front' ) ) return 0x49636c;
	if ( name.includes( 'Waiting_Train' ) ) return 0x344b54;
	if ( name.includes( 'Station_Wall_Panel' ) || name.includes( 'Station_Wall_Rib' ) ) return 0x1f3339;
	if ( name.includes( 'Station_Wall_Trim' ) ) return 0x789596;
	if ( name.includes( 'Station_Track_Rail' ) ) return 0x789392;
	if ( name.includes( 'Station_Track_Tie' ) ) return 0x293337;
	if ( name.includes( 'Station_Preview_Platform_Edge' ) ) return 0xc1afa0;
	if ( name.includes( 'Salt' ) || name.includes( 'Hall' ) ) return 0x77776c;
	if ( name.includes( 'Door_Brass' ) || name.includes( 'Band' ) || name.includes( 'Jamb' ) || name.includes( 'Lintel' ) ) return 0x8f6430;
	if ( name.includes( 'Closed_Door' ) ) return 0x292e32;
	if ( name.includes( 'Landing' ) ) return 0x55504a;
	if ( name.includes( 'Boat' ) || name.includes( 'Entrance_Rock' ) ) return 0x303c42;
	return 0x3a4244;
}

function caveEmissiveStrength( name ) {
	if ( name.includes( 'Glow_Mineral' ) ) return 1.5;
	if ( name.includes( 'Waiting_Train_Headlight' ) || name.includes( 'Station_Ceiling_Light' ) || name.includes( 'Station_Wall_Light' ) ) return 1.2;
	if ( name.includes( 'Waiting_Train' ) || name.includes( 'Station_Wall_Panel' ) ) return 0.08;
	return 0.32;
}

function rewriteGLBMaterials( bytes ) {
	if ( bytes.readUInt32LE( 0 ) !== 0x46546c67 || bytes.readUInt32LE( 4 ) !== 2 || bytes.readUInt32LE( 8 ) !== bytes.length ) throw new Error( 'Expected a complete GLB version 2 file' );
	let gltf = null;
	const untouchedChunks = [];
	for ( let offset = 12; offset < bytes.length; ) {
		const chunkLength = bytes.readUInt32LE( offset ), chunkType = bytes.readUInt32LE( offset + 4 );
		const end = offset + 8 + chunkLength;
		if ( end > bytes.length ) throw new Error( 'GLB chunk exceeds the file boundary' );
		if ( chunkType === 0x4e4f534a ) {
			if ( gltf ) throw new Error( 'GLB contains multiple JSON chunks' );
			gltf = JSON.parse( bytes.toString( 'utf8', offset + 8, end ) );
		} else untouchedChunks.push( bytes.subarray( offset, end ) );
		offset = end;
	}
	if ( ! gltf || ! Array.isArray( gltf.materials ) || ! Array.isArray( gltf.meshes ) || ! Array.isArray( gltf.nodes ) ) throw new Error( 'Cave GLB has no supported named meshes or materials' );
	const sourceMaterials = gltf.materials.slice();
	const materialVariants = new Map();
	for ( const node of gltf.nodes ) {
		if ( node.mesh === undefined ) continue;
		const gltfMesh = gltf.meshes[ node.mesh ];
		if ( ! gltfMesh ) throw new Error( `Cave GLB node ${node.name || '?'} has an invalid mesh reference` );
		const color = caveColor( node.name || '' );
		for ( const primitive of gltfMesh.primitives || [] ) {
			const sourceIndex = primitive.material ?? 0;
			const material = sourceMaterials[ sourceIndex ];
			if ( ! material ) throw new Error( `Cave GLB mesh ${node.name || '?'} has an invalid material reference` );
			const key = `${sourceIndex}:${color}:${caveEmissiveStrength( node.name || '' )}`;
			let variantIndex = materialVariants.get( key );
			if ( variantIndex === undefined ) {
				const variant = structuredClone( material );
				variant.name = `${node.name || 'Cave'} ${material.name || sourceIndex}`;
				const pbr = variant.pbrMetallicRoughness ||= {};
				pbr.baseColorFactor = [ ( color >> 16 & 255 ) / 255, ( color >> 8 & 255 ) / 255, ( color & 255 ) / 255, pbr.baseColorFactor?.[ 3 ] ?? 1 ];
				variant.emissiveFactor = pbr.baseColorFactor.slice( 0, 3 );
				variant.extensions ||= {};
				variant.extensions.KHR_materials_emissive_strength = { emissiveStrength: caveEmissiveStrength( node.name || '' ) };
				variantIndex = gltf.materials.push( variant ) - 1;
				materialVariants.set( key, variantIndex );
			}
			primitive.material = variantIndex;
		}
	}
	gltf.extensionsUsed ||= [];
	if ( ! gltf.extensionsUsed.includes( 'KHR_materials_emissive_strength' ) ) gltf.extensionsUsed.push( 'KHR_materials_emissive_strength' );
	const json = Buffer.from( JSON.stringify( gltf ) );
	const paddedJSON = Buffer.concat( [ json, Buffer.alloc( ( 4 - json.length % 4 ) % 4, 0x20 ) ] );
	const jsonHeader = Buffer.alloc( 8 );
	jsonHeader.writeUInt32LE( paddedJSON.length, 0 );
	jsonHeader.writeUInt32LE( 0x4e4f534a, 4 );
	const rest = Buffer.concat( untouchedChunks );
	const header = Buffer.alloc( 12 );
	const totalLength = header.length + jsonHeader.length + paddedJSON.length + rest.length;
	header.writeUInt32LE( 0x46546c67, 0 );
	header.writeUInt32LE( 2, 4 );
	header.writeUInt32LE( totalLength, 8 );
	return Buffer.concat( [ header, jsonHeader, paddedJSON, rest ] );
}

function retainSourceMaterials( sourceBytes, lodBytes ) {
	function parse( bytes ) {
		let json = null;
		const chunks = [];
		for ( let offset = 12; offset < bytes.length; ) {
			const length = bytes.readUInt32LE( offset ), type = bytes.readUInt32LE( offset + 4 );
			const end = offset + 8 + length;
			if ( end > bytes.length ) throw new Error( 'Cave LOD GLB chunk exceeds the file boundary' );
			if ( type === 0x4e4f534a ) json = JSON.parse( bytes.toString( 'utf8', offset + 8, end ) );
			else chunks.push( bytes.subarray( offset, end ) );
			offset = end;
		}
		if ( ! json ) throw new Error( 'Cave LOD GLB has no JSON chunk' );
		return { json, chunks };
	}
	const base = parse( sourceBytes ), lod = parse( lodBytes );
	const materials = base.json.materials || [], lodMaterials = lod.json.materials || [];
	const indices = new Map( materials.map( ( material, index ) => [ material.name, index ] ) );
	for ( const mesh of lod.json.meshes || [] ) for ( const primitive of mesh.primitives || [] ) {
		if ( primitive.material === undefined ) continue;
		const name = lodMaterials[ primitive.material ]?.name;
		const index = indices.get( name );
		if ( index === undefined ) throw new Error( `Cave LOD uses a material missing from the full-detail GLB: ${name || primitive.material}` );
		primitive.material = index;
	}
	lod.json.materials = materials;
	lod.json.extensionsUsed = [ ...new Set( [ ...( lod.json.extensionsUsed || [] ), ...( base.json.extensionsUsed || [] ) ] ) ];
	const json = Buffer.from( JSON.stringify( lod.json ) );
	const paddedJSON = Buffer.concat( [ json, Buffer.alloc( ( 4 - json.length % 4 ) % 4, 0x20 ) ] );
	const jsonHeader = Buffer.alloc( 8 );
	jsonHeader.writeUInt32LE( paddedJSON.length, 0 ); jsonHeader.writeUInt32LE( 0x4e4f534a, 4 );
	const rest = Buffer.concat( lod.chunks );
	const header = Buffer.alloc( 12 );
	header.writeUInt32LE( 0x46546c67, 0 ); header.writeUInt32LE( 2, 4 );
	header.writeUInt32LE( header.length + jsonHeader.length + paddedJSON.length + rest.length, 8 );
	return Buffer.concat( [ header, jsonHeader, paddedJSON, rest ] );
}

function boundsForGLB( bytes ) {
	const parsed = parseGLB( bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength ) );
	const min = [ Infinity, Infinity, Infinity ], max = [ - Infinity, - Infinity, - Infinity ];
	const point = new Vector3();
	const matrixForNode = node => node.matrix ? new Matrix4().fromArray( node.matrix ) : new Matrix4().compose(
		new Vector3( ...( node.translation || [ 0, 0, 0 ] ) ),
		new Quaternion( ...( node.rotation || [ 0, 0, 0, 1 ] ) ),
		new Vector3( ...( node.scale || [ 1, 1, 1 ] ) ),
	);
	function visit( nodeIndex, parent ) {
		const node = parsed.json.nodes[ nodeIndex ];
		if ( ! node ) throw new Error( `Cave GLB has invalid node ${nodeIndex}` );
		const world = parent.clone().multiply( matrixForNode( node ) );
		if ( node.mesh !== undefined ) for ( const primitive of parsed.meshes[ node.mesh ] || [] ) {
			const positions = primitive.attributes?.POSITION?.array;
			if ( ! positions ) continue;
			for ( let index = 0; index < positions.length; index += 3 ) {
				point.set( positions[ index ], positions[ index + 1 ], positions[ index + 2 ] ).applyMatrix4( world );
				for ( let axis = 0; axis < 3; axis ++ ) { min[ axis ] = Math.min( min[ axis ], point.getComponent( axis ) ); max[ axis ] = Math.max( max[ axis ], point.getComponent( axis ) ); }
			}
		}
		for ( const child of node.children || [] ) visit( child, world );
	}
	const scene = parsed.json.scenes?.[ parsed.json.scene || 0 ];
	if ( ! scene?.nodes?.length ) throw new Error( 'Cave GLB has no active scene nodes for streaming bounds' );
	for ( const node of scene.nodes ) visit( node, new Matrix4() );
	if ( ! Number.isFinite( min[ 0 ] ) ) throw new Error( 'Cave asset has no positions for streaming bounds' );
	const center = min.map( ( value, axis ) => ( value + max[ axis ] ) * 0.5 );
	let radiusSq = 0;
	function radiusVisit( nodeIndex, parent ) {
		const node = parsed.json.nodes[ nodeIndex ];
		const world = parent.clone().multiply( matrixForNode( node ) );
		if ( node.mesh !== undefined ) for ( const primitive of parsed.meshes[ node.mesh ] || [] ) {
			const positions = primitive.attributes?.POSITION?.array;
			if ( ! positions ) continue;
			for ( let index = 0; index < positions.length; index += 3 ) {
				point.set( positions[ index ], positions[ index + 1 ], positions[ index + 2 ] ).applyMatrix4( world );
				radiusSq = Math.max( radiusSq, ( point.x - center[ 0 ] ) ** 2 + ( point.y - center[ 1 ] ) ** 2 + ( point.z - center[ 2 ] ) ** 2 );
			}
		}
		for ( const child of node.children || [] ) radiusVisit( child, world );
	}
	for ( const node of scene.nodes ) radiusVisit( node, new Matrix4() );
	return { center, radius: Math.max( 0.01, Math.sqrt( radiusSq ) ) };
}

function addFloorPath( boxes, points, { widthIndex = 4, walls = true, skipNegativeBoatWallAfter = -1 } = {} ) {
	for ( let segment = 0; segment < points.length - 1; segment ++ ) {
		const a = points[ segment ], b = points[ segment + 1 ];
		const dx = b[ 0 ] - a[ 0 ], dz = b[ 1 ] - a[ 1 ];
		const distance = Math.hypot( dx, dz );
		const steps = Math.max( 1, Math.ceil( distance / 1.6 ) );
		const yaw = - Math.atan2( dz, dx );
		for ( let step = 0; step < steps; step ++ ) {
			const t = ( step + 0.5 ) / steps;
			const x = a[ 0 ] + dx * t, z = a[ 1 ] + dz * t, y = a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t;
			const width = Math.max( 0.7, a[ widthIndex ] + ( b[ widthIndex ] - a[ widthIndex ] ) * t - 0.3 );
			const halfLength = distance / steps / 2 + 0.18;
			boxes.push( { center: [ x, y - 0.22, z ], halfExtents: [ halfLength, 0.22, width ], yaw, walkable: true, solid: true } );
			if ( ! walls ) continue;
			for ( const side of [ -1, 1 ] ) {
				if ( side === -1 && skipNegativeBoatWallAfter >= 0 && segment >= skipNegativeBoatWallAfter ) continue;
				const normalX = - dz / distance, normalZ = dx / distance;
				const wallHeight = 4.5;
				boxes.push( { center: [ x + normalX * side * ( width - 0.2 ), y + wallHeight / 2, z + normalZ * side * ( width - 0.2 ) ], halfExtents: [ halfLength, wallHeight / 2, 0.35 ], yaw, walkable: false, solid: true } );
			}
		}
	}
}

function buildCollision( layout ) {
	const boxes = [];
	const landing = layout.landing;
	boxes.push( { center: [ landing.center[ 0 ], landing.center[ 1 ] - 0.35, landing.center[ 2 ] ], halfExtents: [ landing.size[ 0 ] / 2, 0.35, landing.size[ 2 ] / 2 ], yaw: 0, walkable: true, solid: true } );
	addFloorPath( boxes, layout.boatPath, { walls: true, skipNegativeBoatWallAfter: 2 } );
	for ( const passage of layout.passages ) addFloorPath( boxes, passage.points );
	addFloorPath( boxes, [ [ -220, -10, 1.2, 9.2, 5 ], [ -220, -28, 1.2, 9.2, 6 ], [ -220, -47, 1.2, 9.2, 5.5 ] ] );
	for ( const room of [ layout.junction, layout.chamber ] ) {
		const cell = 2;
		for ( let x = room.center[ 0 ] - room.radius + cell / 2; x < room.center[ 0 ] + room.radius; x += cell ) for ( let z = room.center[ 1 ] - room.radius + cell / 2; z < room.center[ 1 ] + room.radius; z += cell ) {
			if ( Math.hypot( x - room.center[ 0 ], z - room.center[ 1 ] ) > room.radius - 0.4 ) continue;
			boxes.push( { center: [ x, room.center[ 2 ] - 0.22, z ], halfExtents: [ cell / 2, 0.22, cell / 2 ], yaw: 0, walkable: true, solid: true } );
		}
		const walls = 24, wallHalf = room.radius * Math.sin( Math.PI / walls ) + 0.1;
		for ( let index = 0; index < walls; index ++ ) {
			const angle = index * Math.PI * 2 / walls;
			const tangent = angle + Math.PI / 2;
			boxes.push( { center: [ room.center[ 0 ] + Math.cos( angle ) * ( room.radius - 0.35 ), room.center[ 2 ] + 3.6, room.center[ 1 ] + Math.sin( angle ) * ( room.radius - 0.35 ) ], halfExtents: [ wallHalf, 3.6, 0.35 ], yaw: -tangent, walkable: false, solid: true } );
		}
	}
	const ramp = layout.wadingRamp;
	const rampSteps = Math.ceil( ( ramp.waterEdgeZ - ramp.landingEdgeZ ) / 1.4 );
	for ( let index = 0; index < rampSteps; index ++ ) {
		const z1 = ramp.waterEdgeZ - ( ramp.waterEdgeZ - ramp.landingEdgeZ ) * index / rampSteps;
		const z2 = ramp.waterEdgeZ - ( ramp.waterEdgeZ - ramp.landingEdgeZ ) * ( index + 1 ) / rampSteps;
		const z = ( z1 + z2 ) / 2, ratio = ( ramp.waterEdgeZ - z ) / ( ramp.waterEdgeZ - ramp.landingEdgeZ );
		const y = ramp.waterFloor + ( ramp.landingFloor - ramp.waterFloor ) * ratio;
		boxes.push( { center: [ ( ramp.xMin + ramp.xMax ) / 2, y - 0.22, z ], halfExtents: [ ( ramp.xMax - ramp.xMin ) / 2, 0.22, Math.abs( z1 - z2 ) / 2 + 0.08 ], yaw: 0, walkable: true, solid: true } );
	}
	const shelf = layout.wadingShelf;
	boxes.push( { center: [ ( shelf.xMin + shelf.xMax ) / 2, shelf.floor - 0.22, ( shelf.zMin + shelf.zMax ) / 2 ], halfExtents: [ ( shelf.xMax - shelf.xMin ) / 2, 0.22, ( shelf.zMax - shelf.zMin ) / 2 ], yaw: 0, walkable: true, solid: true } );
	const door = layout.door;
	boxes.push( { center: [ door.center[ 0 ], door.center[ 2 ] + door.height / 2, door.center[ 1 ] ], halfExtents: [ door.width / 2, door.height / 2, 0.55 ], yaw: 0, walkable: false, solid: true } );
	if ( boxes.length > 2048 ) throw new Error( `Cave collision uses ${boxes.length} boxes, above the world package limit` );
	return boxes;
}

async function exportPackage( outDir ) {
	const rawGLB = await readFile( path.join( sourceDir, 'caves.glb' ) );
	const rawLOD = await readFile( path.join( packageDir, 'lod-source/cave-low.glb' ) );
	const ambienceBytes = await readFile( path.join( sourceDir, 'under_reef.ogg' ) );
	const layout = JSON.parse( await readFile( path.join( sourceDir, 'underneath-layout.json' ), 'utf8' ) );
	const glb = rewriteGLBMaterials( rawGLB );
	const lodGLB = retainSourceMaterials( glb, rawLOD );
	const assetID = `sha256:${createHash( 'sha256' ).update( glb ).digest( 'hex' )}`;
	const lodAssetID = `sha256:${createHash( 'sha256' ).update( lodGLB ).digest( 'hex' )}`;
	const ambienceID = `sha256:${createHash( 'sha256' ).update( ambienceBytes ).digest( 'hex' )}`;
	const worldSourcePath = path.join( outDir, 'world-source.json' );
	let updatedAt = process.env.SOURCE_DATE_EPOCH ? new Date( Number( process.env.SOURCE_DATE_EPOCH ) * 1000 ).toISOString() : undefined;
	try { updatedAt ||= JSON.parse( await readFile( worldSourcePath, 'utf8' ) ).updatedAt; } catch { /* new export */ }
	updatedAt ||= '2026-10-01T00:00:00.000Z';
	const source = validateWorldSource( {
		protocol: 'tidewater.world-source/1',
		worldId: 'tw-world:loz-underneath',
		title: 'UNDERNEATH: Basalt Cavern',
		experience: JSON.parse( await readFile( path.join( packageDir, 'presentation.json' ), 'utf8' ) ),
		coordinateSystem: 'right-handed-y-up-meters',
		styleGuide: 'Static ElseMesh ThruHold export of the UNDERNEATH cave scene from archived loz/main (717d054). Authored materials preserve the cave color and emissive presentation. Source coordinates follow the Burning Horizons Y-up metre layout.',
		rules: { gravity: 1, avatarComplexity: 20000, physicsProfile: 'tidewater-default', movement: { walkSpeed: 3, sprintSpeed: 6.2, jumpSpeed: 4.6 }, maxPackageBytes: 4 * 1024 * 1024, requiredFeatures: [ 'tidewater.static-glb/1', 'tidewater.static-glb-emissive-strength/1', 'tidewater.ambient-audio/1', 'tidewater.portal-handoff/1', 'tidewater.portal-preview-static/1' ] },
		hosts: [],
		objects: [ {
			id: 'tw-object:loz-underneath-cave', kind: 'asset-instance', label: 'UNDERNEATH cave, train station and closed door', assetId: assetID, lods: [ { assetId: lodAssetID, maxScreenFraction: 0.45 } ], priority: 'portal-preview',
			transform: { position: [ 340, 4.2, -72 ], yaw: 0 }, scale: [ 1, 1, 1 ], streamingBounds: boundsForGLB( glb ),
			collision: { shape: 'compound', enabled: true, boxes: buildCollision( layout ) },
		} ],
		components: [ { id: 'tw-component:underneath-ambience', type: 'tidewater.ambient-audio/1', priority: 'portal-preview', beds: [ { assetId: ambienceID, gain: 0.1, condition: 'always' } ] } ],
		portals: [ {
			id: 'tw-portal:example-island',
			destinationWorldId: 'tw-world:example-island',
			entry: { position: [ 0, 4.2, 8 ], yaw: Math.PI / 2 },
			exit: { position: [ - 340, 4.2, 80 ], yaw: Math.PI / 2 },
			visual: 'stone',
			openView: true,
			enabled: true,
		} ], updatedAt,
	} );
	const assetsDir = path.join( outDir, 'assets' );
	await rm( assetsDir, { recursive: true, force: true } );
	await mkdir( assetsDir, { recursive: true } );
	await writeFile( path.join( assetsDir, assetID.slice( 'sha256:'.length ) ), glb );
	await writeFile( path.join( assetsDir, lodAssetID.slice( 'sha256:'.length ) ), lodGLB );
	await writeFile( path.join( assetsDir, ambienceID.slice( 'sha256:'.length ) ), ambienceBytes );
	await writeFile( worldSourcePath, `${JSON.stringify( source, null, 2 )}\n` );
	console.log( `Exported ${source.title}: ${source.objects.length} object, ${source.objects[ 0 ].collision.boxes.length} collision boxes, ${glb.length + ambienceBytes.length} asset bytes, ${assetID}` );
}

try {
	const options = parseArgs( process.argv.slice( 2 ) );
	await exportPackage( options.out || packageDir );
} catch ( error ) {
	console.error( error.message );
	process.exitCode = 1;
}
