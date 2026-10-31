// Build the static, GLB-backed portion of a verified world manifest as a replaceable scene root.
// Dynamic world systems (terrain simulation, water, wildlife, gameplay) are deliberately not
// inferred from a mesh export; they need explicit, versioned runtime components.

import { LODLoadQueue, WorldObjectLOD } from './WorldObjectLOD.js';
import { GPU } from '../engine/gpu/GPU.js';
import { Group } from '../engine/scene/Group.js';
import { Mesh } from '../engine/scene/Mesh.js';
import { BoxGeometry } from '../engine/geometry/PrimitiveGeometries.js';
import { BufferAttribute } from '../engine/geometry/BufferAttribute.js';
import { BufferGeometry } from '../engine/geometry/BufferGeometry.js';
import { parseGLB, decodeImage } from '../engine/loaders/GLTF.js';
import { Texture, generateMipmaps } from '../engine/webgpu.js';
import { Color } from '../engine/math/Color.js';
import { SRGBColorSpace } from '../engine/constants.js';
import { standard } from '../materials/Materials.js';
import { Vector3 } from '../engine/math/Vector3.js';
import { Matrix4 } from '../engine/math/Matrix4.js';
import { Quaternion } from '../engine/math/Quaternion.js';
import { UniformBlock } from '../engine/gpu/Uniforms.js';
import { Vector2 } from '../engine/math/Vector2.js';
import { lodFadeModule } from '../materials/LODFade.js';
import { worldMaterialRole } from './WorldMaterialProfileRegistry.js';
import { registeredWorldPackageMaterialAdapters } from './WorldPackageMaterialAdapterRegistry.js';

const COMPONENTS = Object.freeze( {
	POSITION: [ 'position', 3 ],
	NORMAL: [ 'normal', 3 ],
	TEXCOORD_0: [ 'uv', 2 ],
	COLOR_0: [ 'color', 3 ],
} );

const PORTAL_FRAME = Object.freeze( { width: 2.42, height: 4.9, bar: 0.18, depth: 0.28 } );
const PORTAL_FRAME_STYLES = Object.freeze( {
	timber: { color: 0x68452d, roughness: 0.88, metalness: 0 },
	stone: { color: 0x77766f, roughness: 0.96, metalness: 0 },
	metal: { color: 0x56636a, roughness: 0.42, metalness: 0.72 },
} );

export async function loadWorldPackage( connector, { signal, assets: preloadedAssets, objectIDs, materialContext } = {} ) {

	if ( ! connector.manifest ) throw new Error( 'Load and verify a world manifest first' );
	const assets = preloadedAssets || await connector.preload();
	const root = new Group();
	root.name = `world:${connector.worldId}`;
	root.userData.worldPackage = { parsed: new Map(), loadedObjects: new Set(), replacedByComponents: new Set(), connector, materialContext, materialAdapterContexts: new Map() };
	try {
		await appendWorldPackageAssets( connector, root, assets, { signal, objectIDs } );
		return root;
	} catch ( error ) {
		disposeWorldPackage( root );
		throw error;
	}

}

export async function appendWorldPackageAssets( connector, root, assets, { signal, objectIDs } = {} ) {

	const state = root.userData.worldPackage || ( root.userData.worldPackage = { parsed: new Map(), loadedObjects: new Set() } );
	await prepareWorldPackageMaterialAdapters( connector, root, signal, objectIDs );
	if ( ! state.portalFramesBuilt ) {
		addPortalFrames( root, connector.manifest.portals || [] );
		state.portalFramesBuilt = true;
	}
	const objectRecords = connector.manifest.objects || [];
	const selectedObjects = objectIDs ? new Set( objectIDs ) : null;
	for ( const object of objectRecords ) {

		if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
		if ( state.loadedObjects.has( object.id ) ) continue;
		if ( selectedObjects && ! selectedObjects.has( object.id ) ) continue;
		if ( object.kind !== 'asset-instance' ) throw new Error( `Unsupported world object kind: ${object.kind}` );
		if ( object.assetId === null && object.collision?.enabled ) {
			const collider = new Group();
			collider.name = object.label || object.id;
			collider.userData.worldObjectId = object.id;
			const t = object.transform || {};
			collider.position.set( ...( t.position || [ 0, 0, 0 ] ) );
			if ( t.rotation ) collider.quaternion.set( ...t.rotation );
			else collider.rotation.y = t.yaw || 0;
			collider.scale.set( ...( object.scale || [ 1, 1, 1 ] ) );
			collider.visible = false;
			root.add( collider );
			state.loadedObjects.add( object.id );
			continue;
		}
		const bytes = assets.get( object.assetId );
		if ( ! bytes ) continue;
		let gltf = state.parsed.get( object.assetId );
		if ( ! gltf ) {
			gltf = await buildGLTF( parseGLB( bytes ), state );
			state.parsed.set( object.assetId, gltf );
		}
		const instance = cloneScene( gltf );
		instance.name = object.label || object.id;
		instance.userData.worldObjectId = object.id;
		if ( state.replacedByComponents?.has( object.id ) ) instance.visible = false;
		const t = object.transform || {};
		instance.position.set( ...( t.position || [ 0, 0, 0 ] ) );
		if ( t.rotation ) instance.quaternion.set( ...t.rotation );
		else instance.rotation.y = t.yaw || 0;
		instance.scale.set( ...( object.scale || [ 1, 1, 1 ] ) );
		root.add( instance );
		if ( object.lods?.length ) installObjectLOD( connector, root, instance, object );
		state.loadedObjects.add( object.id );
		if ( object.replacesObjectId ) {
			const replaced = root.children.find( ( child ) => child.userData.worldObjectId === object.replacesObjectId );
			if ( replaced ) replaced.visible = false;
		}
		if ( object.priority === 'portal-preview' && objectRecords.some( ( replacement ) => replacement.replacesObjectId === object.id && state.loadedObjects.has( replacement.id ) ) ) instance.visible = false;

	}
	return root;

}

// Decode one content-addressed GLB through the same cache and material adapter
// path used by ordinary world objects. Callers may clone its primitives, but
// this cached source remains owned by disposeWorldPackage().
export async function loadWorldPackageModelAsset( connector, root, assetId, { signal, parsedGLTF = null } = {} ) {
	const state = root?.userData?.worldPackage;
	if ( ! state || state.disposed ) throw new Error( 'Cannot load a model into a disposed world package' );
	const cached = state.parsed.get( assetId );
	if ( cached ) return cached;
	const bytes = parsedGLTF ? null : await connector.getAsset( assetId, { signal } );
	if ( signal?.aborted || state.disposed ) throw signal?.reason || new DOMException( 'World unloaded', 'AbortError' );
	const decoded = await buildGLTF( parsedGLTF || parseGLB( bytes ), state );
	if ( signal?.aborted || state.disposed ) {
		disposeWorldPackage( decoded );
		throw signal?.reason || new DOMException( 'World unloaded', 'AbortError' );
	}
	const raced = state.parsed.get( assetId );
	if ( raced ) {
		disposeWorldPackage( decoded );
		return raced;
	}
	state.parsed.set( assetId, decoded );
	return decoded;
}

async function prepareWorldPackageMaterialAdapters( connector, root, signal, objectIDs ) {
	const state = root.userData.worldPackage;
	if ( state.disposed ) return;
	const selected = objectIDs ? new Set( objectIDs ) : null;
	for ( const adapter of registeredWorldPackageMaterialAdapters() ) {
		if ( state.materialAdapterContexts?.has( adapter.componentType ) ) continue;
		const component = connector.manifest.components?.find( candidate => candidate.type === adapter.componentType );
		if ( ! component || selected && ! selected.has( component.objectId ) ) continue;
		const prepared = await adapter.prepare( { connector, root, signal, component } );
		if ( signal?.aborted || state.disposed ) {
			prepared?.dispose?.();
			throw signal?.reason || new DOMException( 'World unloaded', 'AbortError' );
		}
		if ( ! prepared?.context ) throw new Error( `World package material adapter ${adapter.componentType} did not provide a context` );
		state.materialAdapterContexts ||= new Map();
		state.materialAdapterContexts.set( adapter.componentType, { adapter, component, context: prepared.context, dispose: prepared.dispose || null } );
	}
}

export function updateWorldPackageLOD( root, camera, loadBias = 0, now = performance.now() ) {
	for ( const controller of root?.userData?.worldPackage?.lodControllers?.values() || [] ) controller.update( camera, now, loadBias );
}

function installObjectLOD( connector, root, instance, object ) {
	const state = root.userData.worldPackage;
	const levels = new Map();
	const base = new Group();
	for ( const child of [ ...instance.children ] ) base.add( child );
	prepareObjectLODVisual( base );
	instance.add( base ); levels.set( 0, base );
	instance.userData.collisionRoot = base;
	state.lodControllers ||= new Map();
	state.lodQueue ||= new LODLoadQueue();
	state.lodControllers.set( object.id, new WorldObjectLOD( {
		object,
		loadLevel: ( level, signal ) => state.lodQueue.run( signal, async () => {
			const assetId = object.lods[ level - 1 ].assetId;
			const bytes = await connector.getAsset( assetId, { signal } );
			if ( signal.aborted || state.disposed ) throw signal.reason || new DOMException( 'World unloaded', 'AbortError' );
			let source = state.parsed.get( assetId );
			if ( ! source ) {
				source = await buildGLTF( parseGLB( bytes ), state );
				if ( signal.aborted || state.disposed ) { disposeWorldPackage( source ); throw signal.reason || new DOMException( 'World unloaded', 'AbortError' ); }
				const shared = state.parsed.get( assetId );
				if ( shared ) { disposeWorldPackage( source ); source = shared; }
				else state.parsed.set( assetId, source );
			}
			const visual = cloneScene( source ); prepareObjectLODVisual( visual ); visual.visible = false;
			instance.add( visual ); levels.set( level, visual );
		} ),
		showLevel: level => {
			for ( const [ index, visual ] of levels ) {
				visual.visible = index === level;
				setObjectLODFade( visual, 1, false );
			}
		},
		showTransition: ( from, to, fade ) => {
			for ( const [ index, visual ] of levels ) {
				visual.visible = index === from || index === to;
				if ( index === from ) setObjectLODFade( visual, fade, true );
				else if ( index === to ) setObjectLODFade( visual, fade, false );
			}
		},
	} ) );
}

function prepareObjectLODVisual( root ) {
	const materials = new Map();
	root.traverse( object => {
		if ( ! object.material ) return;
		const prepare = source => {
			let material = materials.get( source );
			if ( material ) return material;
			material = source.clone();
			const fields = Object.fromEntries( material.uniformBlock.order.map( name => {
				const value = material.uniforms[ name ].value;
				return [ name, [ material.uniformBlock.layout[ name ].typeStr, value?.clone ? value.clone() : value ] ];
			} ) );
			fields.lodFade = [ 'vec2f', new Vector2( 1, 0 ) ];
			material.uniformBlock = new UniformBlock( `MaterialParams${ material.id }`, fields, { label: material.name } );
			material.uniforms = material.uniformBlock.fields;
			material.modules = [ ...material.modules, lodFadeModule ];
			material.surface = `if ( ! lodFadeVisible( in.pixel, mat.lodFade.x, mat.lodFade.y > 0.5 ) ) { discard; }\n${ material.surface }`;
			const fadeGuard = 'if ( ! lodFadeVisible( in.pixel, mat.lodFade.x, mat.lodFade.y > 0.5 ) ) { return false; }';
			material.shadow = material.shadow
				? `${ fadeGuard }\n${ material.shadow }`
				: `${ fadeGuard }\nif ( mat.alphaTest > 0.0 ) { let s = surfaceOf( in ); if ( s.alpha < mat.alphaTest ) { return false; } }\nreturn true;`;
			materials.set( source, material );
			return material;
		};
		object.material = Array.isArray( object.material ) ? object.material.map( prepare ) : prepare( object.material );
	} );
}

function setObjectLODFade( root, fade, outgoing ) {
	root.traverse( object => {
		for ( const material of Array.isArray( object.material ) ? object.material : [ object.material ] ) {
			const uniform = material?.uniforms?.lodFade?.value;
			if ( uniform ) uniform.set( fade, outgoing ? 1 : 0 );
		}
	} );
}

function addPortalFrames( root, portals ) {
	for ( const portal of portals ) {
		const style = PORTAL_FRAME_STYLES[ portal.visual ];
		if ( ( ! portal.enabled && ! portal.back?.enabled ) || ! style ) continue;
		const frame = new Group();
		frame.name = `portal frame:${portal.id}`;
		frame.userData.worldPortalFrame = portal.id;
		frame.position.fromArray( portal.entry.position );
		frame.rotation.y = portal.entry.yaw;
		const material = standard( { name: `portal frame ${portal.visual}`, ...style } );
		const { width, height, bar, depth } = PORTAL_FRAME;
		const outerWidth = width + bar * 2;
		const outerHeight = height + bar;
		const postGeometry = new BoxGeometry( bar, outerHeight, depth );
		const lintelGeometry = new BoxGeometry( outerWidth, bar, depth );
		for ( const x of [ - ( width + bar ) / 2, ( width + bar ) / 2 ] ) {
			const post = new Mesh( postGeometry, material );
			post.name = 'portal frame post';
			post.position.set( x, 0, 0 );
			post.castShadow = true;
			frame.add( post );
		}
		const lintel = new Mesh( lintelGeometry, material );
		lintel.name = 'portal frame lintel';
		lintel.position.y = ( height + bar ) / 2;
		lintel.castShadow = true;
		frame.add( lintel );
		root.add( frame );
	}
}

export function cloneWorldPackageAssets( root, connector, assetIDs ) {
	const preview = new Group();
	preview.name = `${root.name}:portal-preview`;
	if ( ! assetIDs?.size ) return preview;
	const objectAssets = new Map( connector.manifest.objects.map( ( object ) => [ object.id, object.assetId ] ) );
	for ( const child of root.children ) {
		const objectId = child.userData.worldObjectId;
		if ( assetIDs.has( objectAssets.get( objectId ) ) ) preview.add( child.clone( true ) );
	}
	return preview;
}

export function registerWorldPackageCollisions( root, colliders ) {
	if ( ! colliders ) return;
	const state = root.userData.worldPackage;
	if ( ! state ) return;
	state.activeColliders ||= new Map();
	state.embeddedColliders ||= new Map();
	for ( const object of state.connector?.manifest?.objects || [] ) {
		if ( ! state.loadedObjects.has( object.id ) ) continue;
		const instance = root.children.find( ( child ) => child.userData.worldObjectId === object.id );
		if ( ! instance ) continue;
		const collision = object.collision;
		if ( ! collision?.enabled && ! state.embeddedColliders.has( object.id ) && instance.traverse ) {
			const shapes = registerEmbeddedBodySetup( root, instance, object.id, colliders );
			if ( shapes.length ) state.embeddedColliders.set( object.id, shapes );
		}
		if ( ! collision?.enabled || state.activeColliders.has( object.id ) ) continue;
		if ( collision.shape === 'heightfield' ) {
			const meshes = [];
			( instance.userData.collisionRoot || instance ).traverse( ( child ) => { if ( child.isMesh ) meshes.push( child ); } );
			if ( meshes.length !== 1 ) throw new Error( `World object ${object.id} heightfield must have exactly one mesh` );
			const attribute = meshes[ 0 ].geometry.getAttribute( 'position' );
			if ( ! attribute || attribute.count !== collision.columns * collision.rows ) throw new Error( `World object ${object.id} heightfield vertex count does not match its dimensions` );
			root.updateMatrixWorld( true );
			const relative = new Matrix4().copy( instance.matrixWorld ).invert().multiply( meshes[ 0 ].matrixWorld );
			const positions = new Float32Array( attribute.count * 3 );
			const point = new Vector3();
			for ( let index = 0; index < attribute.count; index ++ ) {
				point.fromBufferAttribute( attribute, index ).applyMatrix4( relative );
				positions[ index * 3 ] = point.x;
				positions[ index * 3 + 1 ] = point.y;
				positions[ index * 3 + 2 ] = point.z;
			}
			const field = colliders.addHeightfield( positions, collision.columns, collision.rows, {
				position: new Vector3( ...object.transform.position ), scale: new Vector3( ...( object.scale || [ 1, 1, 1 ] ) ),
				yaw: object.transform.yaw || 0, tag: `world:${object.id}`,
			} );
			state.activeColliders.set( object.id, { shape: 'heightfield', collider: field } );
			continue;
		}
		if ( collision.shape === 'compound' ) {
			if ( ! Array.isArray( collision.boxes ) || collision.boxes.length === 0 || collision.boxes.length > 2048 || ! collision.boxes.every( ( item ) => item && ( item.tag === undefined || item.tag === 'pierRail' ) && Array.isArray( item.center ) && item.center.length === 3 && item.center.every( ( value ) => Number.isFinite( value ) && Math.abs( value ) <= 1e6 ) && Array.isArray( item.halfExtents ) && item.halfExtents.length === 3 && item.halfExtents.every( ( value ) => Number.isFinite( value ) && value > 0 && value <= 1000 ) && Number.isFinite( item.yaw ) && Math.abs( item.yaw ) <= 360 && typeof item.walkable === 'boolean' && typeof item.solid === 'boolean' ) ) throw new Error( `World object ${object.id} has invalid compound collision boxes` );
			const scale = object.scale || [ 1, 1, 1 ];
			const yaw = object.transform?.yaw || 0;
			const cos = Math.cos( yaw ), sin = Math.sin( yaw );
			const boxes = [];
			for ( const item of collision.boxes ) {
				const localX = item.center[ 0 ] * scale[ 0 ], localY = item.center[ 1 ] * scale[ 1 ], localZ = item.center[ 2 ] * scale[ 2 ];
				const center = new Vector3(
					object.transform.position[ 0 ] + localX * cos + localZ * sin,
					object.transform.position[ 1 ] + localY,
					object.transform.position[ 2 ] - localX * sin + localZ * cos,
				);
				const half = new Vector3( item.halfExtents[ 0 ] * scale[ 0 ], item.halfExtents[ 1 ] * scale[ 1 ], item.halfExtents[ 2 ] * scale[ 2 ] );
				boxes.push( colliders.addBox( center, half, yaw + item.yaw, { walkable: item.walkable, solid: item.solid, tag: item.tag || `world:${object.id}` } ) );
			}
			state.activeColliders.set( object.id, { shape: 'compound', collider: boxes } );
			continue;
		}
		if ( collision.shape !== 'box' || ! Array.isArray( collision.center ) || collision.center.length !== 3 || ! collision.center.every( Number.isFinite ) || ! Array.isArray( collision.halfExtents ) || collision.halfExtents.length !== 3 || ! collision.halfExtents.every( ( value ) => Number.isFinite( value ) && value > 0 ) ) throw new Error( `World object ${object.id} has invalid collision bounds` );
		const scale = object.scale || [ 1, 1, 1 ];
		const yaw = object.transform?.yaw || 0;
		const cos = Math.cos( yaw ), sin = Math.sin( yaw );
		const localX = collision.center[ 0 ] * scale[ 0 ], localY = collision.center[ 1 ] * scale[ 1 ], localZ = collision.center[ 2 ] * scale[ 2 ];
		const center = new Vector3(
			object.transform.position[ 0 ] + localX * cos + localZ * sin,
			object.transform.position[ 1 ] + localY,
			object.transform.position[ 2 ] - localX * sin + localZ * cos,
		);
		const half = new Vector3( collision.halfExtents[ 0 ] * scale[ 0 ], collision.halfExtents[ 1 ] * scale[ 1 ], collision.halfExtents[ 2 ] * scale[ 2 ] );
		const box = colliders.addBox( center, half, yaw, { walkable: collision.walkable, solid: collision.solid, tag: `world:${object.id}` } );
		state.activeColliders.set( object.id, { shape: 'box', collider: box } );
	}
}

export function unregisterWorldPackageCollisions( root, colliders ) {
	const active = root?.userData?.worldPackage?.activeColliders;
	const embedded = root?.userData?.worldPackage?.embeddedColliders;
	if ( ! colliders ) return;
	for ( const { shape, collider } of active?.values() || [] ) {
		if ( shape === 'heightfield' ) colliders.removeHeightfield( collider );
		else if ( shape === 'compound' ) for ( const box of collider || [] ) colliders.removeBox( box );
		else colliders.removeBox( collider );
	}
	active?.clear();
	for ( const shapes of embedded?.values() || [] ) for ( const { kind, collider } of shapes ) {
		if ( kind === 'box' ) colliders.removeBox( collider );
		else if ( kind === 'cylinder' ) colliders.removeCylinder( collider );
	}
	embedded?.clear();
}

export function unloadWorldPackageObjects( root, connector, colliders, objectIDs ) {
	const state = root?.userData?.worldPackage;
	if ( ! state || ! objectIDs?.size ) return;
	const assetByObject = new Map( connector.manifest.objects.map( object => [ object.id, object.assetId ] ) );
	for ( const objectID of objectIDs ) {
		const active = state.activeColliders?.get( objectID );
		if ( active && colliders ) {
			if ( active.shape === 'heightfield' ) colliders.removeHeightfield( active.collider );
			else if ( active.shape === 'compound' ) for ( const box of active.collider || [] ) colliders.removeBox( box );
			else colliders.removeBox( active.collider );
			state.activeColliders.delete( objectID );
		}
		for ( const { kind, collider } of state.embeddedColliders?.get( objectID ) || [] ) {
			if ( ! colliders ) continue;
			if ( kind === 'box' ) colliders.removeBox( collider );
			else colliders.removeCylinder( collider );
		}
		state.embeddedColliders?.delete( objectID );
		const instance = root.children.find( child => child.userData.worldObjectId === objectID );
		if ( instance ) root.remove( instance );
		state.loadedObjects.delete( objectID );
		state.lodControllers?.get( objectID )?.dispose();
		state.lodControllers?.delete( objectID );
	}
	const releaseAssetIDs = new Set( [ ...objectIDs ].map( id => assetByObject.get( id ) ).filter( Boolean ) );
	for ( const assetID of releaseAssetIDs ) {
		if ( connector.manifest.objects.some( object => object.assetId === assetID && state.loadedObjects.has( object.id ) ) ) continue;
		const parsed = state.parsed?.get( assetID );
		if ( parsed ) {
			const geometries = new Set(), materials = new Set(), textures = new Set();
			parsed.traverse( object => {
				if ( object.geometry?.dispose ) geometries.add( object.geometry );
				for ( const material of Array.isArray( object.material ) ? object.material : [ object.material ] ) {
					if ( ! material || material.userData?.borrowedWorldMaterial ) continue;
					materials.add( material );
					for ( const binding of Object.values( material.bindings || {} ) ) {
						const texture = binding?.texture || binding;
						if ( texture?.isTexture && texture.destroy ) textures.add( texture );
					}
				}
			} );
			const release = () => {
				for ( const geometry of geometries ) geometry.dispose();
				for ( const material of materials ) material.dispose?.();
				for ( const texture of textures ) texture.destroy();
			};
			if ( GPU.encoder ) GPU.onSubmit( null, release );
			else release();
			state.parsed.delete( assetID );
		}
		connector.releaseAsset?.( assetID );
	}
}

const MAX_EMBEDDED_SHAPES_PER_OBJECT = 4096;
const COLLISION_COORDINATE_SYSTEM = 'elsemesh-y-up-meters/1';

function registerEmbeddedBodySetup( root, instance, objectId, colliders ) {
	root.updateMatrixWorld( true );
	const registered = [];
	let count = 0;
	let vertices = 0, indices = 0;
	try { instance.traverse( node => {
		const source = node.userData?.elsemeshCollision;
		if ( ! source ) return;
		if ( source.coordinateSystem !== COLLISION_COORDINATE_SYSTEM || typeof source.source !== 'string' ) throw new Error( `World object ${objectId} has unsupported embedded collision data` );
		const checkCount = value => {
			if ( ! Array.isArray( value ) || count + value.length > MAX_EMBEDDED_SHAPES_PER_OBJECT ) throw new Error( `World object ${objectId} exceeds the embedded collision shape limit` );
			count += value.length;
			return value;
		};
		const vector = ( value, label, positive = false ) => {
			if ( ! Array.isArray( value ) || value.length !== 3 || ! value.every( item => Number.isFinite( item ) && Math.abs( item ) <= 1e6 ) || ( positive && ( value.some( item => item < 0 || item > 1000 ) || value.every( item => item === 0 ) ) ) ) throw new Error( `World object ${objectId} has invalid embedded collision ${label}` );
			return new Vector3( ...value );
		};
		const shapeRotation = value => {
			if ( ! Array.isArray( value ) || value.length !== 4 || ! value.every( Number.isFinite ) ) throw new Error( `World object ${objectId} has invalid embedded collision rotation` );
			if ( Math.hypot( ...value ) < 1e-6 ) throw new Error( `World object ${objectId} has invalid embedded collision rotation` );
			return new Quaternion( ...value ).normalize();
		};
		const bounds = ( center, half, rotation = new Quaternion() ) => {
			const min = new Vector3( Infinity, Infinity, Infinity ), max = new Vector3( - Infinity, - Infinity, - Infinity );
			const local = new Vector3();
			for ( const x of [ - 1, 1 ] ) for ( const y of [ - 1, 1 ] ) for ( const z of [ - 1, 1 ] ) {
				local.set( center.x + half.x * x, center.y + half.y * y, center.z + half.z * z ).applyQuaternion( rotation );
				node.localToWorld( local );
				min.min( local ); max.max( local );
			}
			return { center: min.clone().add( max ).multiplyScalar( 0.5 ), half: max.clone().sub( min ).multiplyScalar( 0.5 ) };
		};
		const addBounds = ( center, half, rotation, walkable = false ) => {
			const box = bounds( center, half, rotation );
			const collider = colliders.addBox( box.center, box.half, 0, { walkable, solid: true, tag: `world:${objectId}:body-setup` } );
			registered.push( { kind: 'box', collider } );
		};
		for ( const box of checkCount( source.boxes || [] ) ) {
			const center = vector( box.center, 'box center' ), half = vector( box.halfExtents, 'box half extents', true );
			const rotation = shapeRotation( box.rotation );
			const worldRotation = node.getWorldQuaternion( new Quaternion() ).multiply( rotation );
			const up = new Vector3( 0, 1, 0 ).applyQuaternion( worldRotation );
			const walkable = up.y > 0.95 && half.y <= Math.min( half.x, half.z ) * 0.2;
			addBounds( center, half, rotation, walkable );
		}
		for ( const sphere of checkCount( source.spheres || [] ) ) {
			const center = vector( sphere.center, 'sphere center' );
			if ( ! Number.isFinite( sphere.radius ) || sphere.radius <= 0 || sphere.radius > 1000 ) throw new Error( `World object ${objectId} has invalid embedded collision sphere` );
			const worldCenter = node.localToWorld( center );
			const scale = node.getWorldScale( new Vector3() );
			const radius = sphere.radius * Math.max( Math.abs( scale.x ), Math.abs( scale.y ), Math.abs( scale.z ) );
			registered.push( { kind: 'cylinder', collider: colliders.addCylinder( worldCenter.x, worldCenter.z, radius, worldCenter.y - radius, worldCenter.y + radius, { tag: `world:${objectId}:body-setup` } ) } );
		}
		for ( const [ field, tapered ] of [ [ 'capsules', false ], [ 'taperedCapsules', true ] ] ) for ( const capsule of checkCount( source[ field ] || [] ) ) {
			const center = vector( capsule.center, 'capsule center' );
			const radii = tapered ? [ capsule.radius0, capsule.radius1 ] : [ capsule.radius ];
			if ( ! radii.every( value => Number.isFinite( value ) && value > 0 && value <= 1000 ) || ! Number.isFinite( capsule.length ) || capsule.length < 0 || capsule.length > 10000 ) throw new Error( `World object ${objectId} has invalid embedded collision capsule` );
			const rotation = shapeRotation( capsule.rotation );
			const worldRotation = node.getWorldQuaternion( new Quaternion() ).multiply( rotation );
			const axis = new Vector3( 0, 1, 0 ).applyQuaternion( worldRotation );
			const worldCenter = node.localToWorld( center );
			const scale = node.getWorldScale( new Vector3() );
			const maxScale = Math.max( Math.abs( scale.x ), Math.abs( scale.y ), Math.abs( scale.z ) );
			const radius = Math.max( ...radii ) * maxScale;
			const halfLength = capsule.length * maxScale * 0.5 + radius;
			if ( Math.abs( axis.y ) > 0.95 ) {
				registered.push( { kind: 'cylinder', collider: colliders.addCylinder( worldCenter.x, worldCenter.z, radius, worldCenter.y - halfLength, worldCenter.y + halfLength, { tag: `world:${objectId}:body-setup` } ) } );
			} else addBounds( center, new Vector3( radius, halfLength, radius ), rotation );
		}
		for ( const convex of checkCount( source.convexes || [] ) ) {
			if ( ! Array.isArray( convex.vertices ) || convex.vertices.length < 4 || convex.vertices.length > 65536 ) throw new Error( `World object ${objectId} has invalid embedded convex collision vertices` );
			vertices += convex.vertices.length;
			if ( vertices > 262144 ) throw new Error( `World object ${objectId} exceeds the embedded convex vertex limit` );
			const points = convex.vertices.map( point => vector( point, 'convex vertex' ) );
			if ( ! Array.isArray( convex.indices ) || convex.indices.length < 12 || convex.indices.length % 3 !== 0 || convex.indices.length > 196608 || convex.indices.some( index => ! Number.isInteger( index ) || index < 0 || index >= points.length ) ) throw new Error( `World object ${objectId} has invalid embedded convex collision indices` );
			indices += convex.indices.length;
			if ( indices > 786432 ) throw new Error( `World object ${objectId} exceeds the embedded convex index limit` );
			const min = new Vector3( Infinity, Infinity, Infinity ), max = new Vector3( - Infinity, - Infinity, - Infinity );
			for ( const point of points ) { node.localToWorld( point ); min.min( point ); max.max( point ); }
			const half = max.clone().sub( min ).multiplyScalar( 0.5 );
			const walkable = half.y <= Math.min( half.x, half.z ) * 0.1;
			const collider = colliders.addBox( min.clone().add( max ).multiplyScalar( 0.5 ), half, 0, { walkable, solid: true, tag: `world:${objectId}:body-setup-convex-bounds` } );
			registered.push( { kind: 'box', collider } );
		}
	} ); } catch ( error ) {
		for ( const { kind, collider } of registered ) {
			if ( kind === 'box' ) colliders.removeBox( collider );
			else colliders.removeCylinder( collider );
		}
		throw error;
	}
	return registered;
}

export function registerWorldPackageCollisionPayload( bytes, object, colliders ) {
	const parsed = parseGLB( bytes );
	const root = new Group();
	const instance = new Group();
	const transform = object.transform || {};
	instance.position.set( ...( transform.position || [ 0, 0, 0 ] ) );
	if ( transform.rotation ) instance.quaternion.set( ...transform.rotation );
	else instance.rotation.y = transform.yaw || 0;
	instance.scale.set( ...( object.scale || [ 1, 1, 1 ] ) );
	root.add( instance );

	const nodes = parsed.nodes.map( source => {
		const node = new Group();
		node.name = source.name;
		node.position.set( ...source.t );
		node.quaternion.set( ...source.r );
		node.scale.set( ...source.s );
		if ( source.extras?.elsemeshCollision ) node.userData.elsemeshCollision = source.extras.elsemeshCollision;
		return node;
	} );
	for ( let index = 0; index < parsed.nodes.length; index ++ ) {
		for ( const childIndex of parsed.nodes[ index ].children ) nodes[ index ].add( nodes[ childIndex ] );
	}
	for ( const rootIndex of parsed.roots ) instance.add( nodes[ rootIndex ] );
	root.updateMatrixWorld( true );
	return registerEmbeddedBodySetup( root, instance, object.id, colliders );
}

export function disposeWorldPackage( root ) {
	const state = root?.userData?.worldPackage;
	if ( ! root || state?.disposed ) return;
	if ( state ) state.disposed = true;
	for ( const controller of state?.lodControllers?.values() || [] ) controller.dispose();
	const geometries = new Set(), materials = new Set(), textures = new Set();
	const roots = [ root, ...( state?.parsed?.values?.() || [] ) ];
	for ( const packageRoot of roots ) packageRoot.traverse( ( object ) => {
		if ( object.geometry?.dispose ) geometries.add( object.geometry );
		for ( const material of Array.isArray( object.material ) ? object.material : [ object.material ] ) {
			if ( ! material ) continue;
			if ( material.userData?.borrowedWorldMaterial ) continue;
			materials.add( material );
			for ( const binding of Object.values( material.bindings || {} ) ) {
				const texture = binding?.texture || binding;
				if ( texture?.isTexture && texture.destroy ) textures.add( texture );
			}
		}
	} );
	const release = () => {
		for ( const geometry of geometries ) geometry.dispose();
		for ( const material of materials ) material.dispose?.();
		for ( const texture of textures ) texture.destroy();
		for ( const entry of state?.materialAdapterContexts?.values() || [] ) entry.dispose?.();
		state?.materialAdapterContexts?.clear();
	};
	if ( GPU.encoder ) GPU.onSubmit( null, release );
	else release();
	state?.parsed?.clear();
	state?.loadedObjects?.clear();
}

async function buildGLTF( gltf, packageState = null ) {

	const root = new Group();
	const textures = new Map();
	const resolvedMaterials = [];
	const materialHooks = [];
	for ( let index = 0; index < gltf.materials.length; index ++ ) {

		const source = gltf.materials[ index ];

		const pbr = source.pbrMetallicRoughness || {};
		const profileRole = worldMaterialRole( source );
		if ( profileRole ) {
			let resolution = null;
			for ( const adapter of registeredWorldPackageMaterialAdapters() ) {
				const context = packageState?.materialAdapterContexts?.get( adapter.componentType )?.context || packageState?.materialContext || null;
				resolution = adapter.resolve( { source, index, gltf, profileRole, context, connector: packageState?.connector } );
				if ( resolution ) break;
			}
			if ( ! resolution?.material ) throw new Error( `World material profile has no registered package renderer for role ${profileRole}` );
			resolvedMaterials.push( resolution.material );
			materialHooks.push( resolution );
			continue;
		}
		const textureInfo = pbr.baseColorTexture;
		let albedo = null;
		if ( textureInfo ) {

			const textureSource = gltf.textures[ textureInfo.index ]?.source;
			const image = gltf.images[ textureSource ];
			if ( ! image?.bytes ) throw new Error( `GLB material ${source.name || index} requires an embedded image` );
			if ( ! textures.has( textureSource ) ) {
				const pixels = await decodeImage( image.bytes, image.mimeType );
				const texture = new Texture( { label: `world-albedo-${textureSource}`, width: pixels.width, height: pixels.height, format: 'rgba8unorm-srgb', data: pixels.data, mips: true, usage: [ 'sample', 'copyDst' ], sampler: 'anisoRepeat' } );
				texture.getGPU();
				generateMipmaps( texture );
				textures.set( textureSource, texture );
			}
			albedo = textures.get( textureSource );

		}
		const base = pbr.baseColorFactor || [ 1, 1, 1, 1 ];
		const emissive = source.emissiveFactor || [ 0, 0, 0 ];
		const emissiveStrength = source.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
		const alphaMode = source.alphaMode || 'OPAQUE';
		const vertexColors = gltf.meshes.some( ( primitives ) => primitives.some( ( primitive ) => primitive.material === index && primitive.attributes.COLOR_0 !== undefined ) );
		resolvedMaterials.push( standard( {
			name: source.name || `world-material-${index}`,
			color: new Color().setRGB( base[ 0 ], base[ 1 ], base[ 2 ], SRGBColorSpace ), opacity: base[ 3 ], roughness: pbr.roughnessFactor ?? 1,
			metalness: pbr.metallicFactor ?? 1, side: source.doubleSided ? 'double' : 'front',
			emissive: new Color().setRGB( emissive[ 0 ], emissive[ 1 ], emissive[ 2 ], SRGBColorSpace ), emissiveIntensity: emissiveStrength,
			transparent: alphaMode === 'BLEND', alphaTest: alphaMode === 'MASK' ? ( source.alphaCutoff ?? 0.5 ) : 0, vertexColors,
			textures: albedo ? { worldAlbedo: albedo } : {},
			defines: { WORLD_HAS_ALBEDO: albedo ? 1 : 0 },
			surface: `#if WORLD_HAS_ALBEDO\n\tlet baseColor = textureSample( worldAlbedo, smpAnisoRepeat, in.uv );\n\ts.albedo *= baseColor.rgb;\n\ts.alpha *= baseColor.a;\n#endif\n`,
		} ) );
		materialHooks.push( null );

	}
	const builtMeshes = gltf.meshes.map( ( primitives ) => primitives.map( ( primitive ) => {

		if ( primitive.mode !== 4 ) throw new Error( `GLB primitive mode ${primitive.mode} is not supported (triangle list required)` );
		const geometry = new BufferGeometry();
		for ( const [ gltfName, [ name, size ] ] of Object.entries( { ...COMPONENTS, _ELSEMESH_VDATA: [ 'vdata', 4 ] } ) ) {
			const attribute = primitive.attributes[ gltfName ];
			if ( ! attribute ) continue;
			const values = floatAttribute( attribute );
			geometry.setAttribute( name, new BufferAttribute( values, gltfName === 'COLOR_0' ? attribute.itemSize : size ) );
		}
		materialHooks[ primitive.material ]?.prepareGeometry?.( geometry, primitive );
		if ( primitive.indices ) geometry.setIndex( new BufferAttribute( asIndexArray( primitive.indices ), 1 ) );
		if ( ! geometry.getAttribute( 'position' ) ) throw new Error( 'GLB primitive has no POSITION attribute' );
		if ( ! geometry.getAttribute( 'normal' ) ) geometry.computeVertexNormals();
		geometry.computeBoundingSphere();
		const material = resolvedMaterials[ primitive.material ] || standard( { name: 'world-default', color: 0xffffff, roughness: 1, metalness: 0 } );
		const mesh = new Mesh( geometry, material );
		if ( materialHooks[ primitive.material ]?.beforeRender ) mesh.onBeforeRender = materialHooks[ primitive.material ].beforeRender;
		return mesh;

	} ) );
	const nodes = gltf.nodes.map( ( node ) => {

		const object = new Group();
		object.name = node.name;
		object.position.set( ...node.t );
		object.quaternion.set( ...node.r );
		object.scale.set( ...node.s );
		if ( node.extras ) Object.assign( object.userData, node.extras );
		if ( node.mesh !== undefined ) for ( const mesh of builtMeshes[ node.mesh ] || [] ) object.add( mesh );
		return object;

	} );
	for ( let i = 0; i < gltf.nodes.length; i ++ ) for ( const child of gltf.nodes[ i ].children ) nodes[ i ].add( nodes[ child ] );
	for ( const index of gltf.roots ) root.add( nodes[ index ] );
	return root;

}

function cloneScene( source ) {

	const copy = new Group();
	copy.name = source.name;
	for ( const child of source.children ) copy.add( child.clone( true ) );
	return copy;

}

function floatAttribute( attribute ) {

	const { array, componentType, normalized, itemSize } = attribute;
	if ( array instanceof Float32Array ) return array;
	const scale = normalized ? ( componentType === 5121 ? 1 / 255 : componentType === 5123 ? 1 / 65535 : componentType === 5120 ? 1 / 127 : componentType === 5122 ? 1 / 32767 : 1 ) : 1;
	const out = new Float32Array( array.length );
	for ( let i = 0; i < array.length; i ++ ) out[ i ] = normalized && componentType <= 5122 ? Math.max( -1, array[ i ] * scale ) : array[ i ] * scale;
	return out;

}

function asIndexArray( array ) {
	if ( array instanceof Uint16Array || array instanceof Uint32Array ) return array;
	let max = 0;
	for ( const value of array ) if ( value > max ) max = value;
	return max < 65536 ? Uint16Array.from( array ) : Uint32Array.from( array );
}
