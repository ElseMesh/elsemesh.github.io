import { validatePortalBack } from './PortalSideContract.js';
import { MAX_WORLD_PACKAGE_BYTES, movementParameters, SUPPORTED_PHYSICS_PROFILES, validateWorldLevels, vehiclePolicy } from './WorldRules.js';
import { validateWorldExperience } from './WorldExperience.js';

export const WORLD_SOURCE_PROTOCOL = 'tidewater.world-source/1';

export function createWorldSource( { worldId = `tw-world:local-${ crypto.randomUUID() }`, title = 'Untitled world' } = {} ) {
	return {
		protocol: WORLD_SOURCE_PROTOCOL,
		worldId,
		title,
		coordinateSystem: 'right-handed-y-up-meters',
		styleGuide: '',
		rules: { gravity: 1, avatarComplexity: 20000, physicsProfile: 'tidewater-default', movement: { walkSpeed: 3, sprintSpeed: 6.2, jumpSpeed: 4.6 } },
		hosts: [],
		objects: [],
		components: [],
		portals: [],
		updatedAt: new Date().toISOString(),
	};
}

export function validateWorldSource( source ) {
	validateWorldSpawn( source?.spawn );
	if ( ! source || source.protocol !== WORLD_SOURCE_PROTOCOL ) throw new Error( 'Unsupported world source format' );
	if ( ! /^tw-world:[\w.-]{1,128}$/.test( source.worldId || '' ) ) throw new Error( 'Invalid worldId' );
	if ( typeof source.title !== 'string' || ! source.title.trim() || source.title.length > 160 ) throw new Error( 'Invalid world title' );
	try { validateWorldExperience( source.experience ); } catch ( error ) { throw new Error( `Invalid ThruHold experience: ${error.message}` ); }
	if ( source.coordinateSystem !== 'right-handed-y-up-meters' ) throw new Error( 'Unsupported world coordinate system' );
	if ( typeof source.styleGuide !== 'string' || source.styleGuide.length > 10000 || ! source.rules || ! Number.isFinite( source.rules.gravity ) || source.rules.gravity < 0.2 || source.rules.gravity > 2 || ! Number.isInteger( source.rules.avatarComplexity ) || source.rules.avatarComplexity < 1 || source.rules.avatarComplexity > 100000 || ! SUPPORTED_PHYSICS_PROFILES.has( source.rules.physicsProfile ) ) throw new Error( 'Invalid or unsupported world rules or style guide' );
	try { validateWorldLevels( source.rules ); } catch { throw new Error( 'Invalid world sea or atmosphere level' ); }
	try { movementParameters( source.rules ); } catch { throw new Error( 'Invalid or unsupported world movement rules' ); }
	try { vehiclePolicy( source.rules ); } catch { throw new Error( 'Invalid or unsupported world vehicle policy' ); }
	if ( source.rules.maxPackageBytes !== undefined && ( ! Number.isSafeInteger( source.rules.maxPackageBytes ) || source.rules.maxPackageBytes < 1 || source.rules.maxPackageBytes > MAX_WORLD_PACKAGE_BYTES ) ) throw new Error( 'Invalid world package byte budget' );
	if ( source.rules.requiredFeatures !== undefined && ( ! Array.isArray( source.rules.requiredFeatures ) || source.rules.requiredFeatures.length > 64 || new Set( source.rules.requiredFeatures ).size !== source.rules.requiredFeatures.length || source.rules.requiredFeatures.some( ( feature ) => typeof feature !== 'string' || feature.length > 96 || ! /^tidewater\.[a-z0-9.-]+\/\d+$/.test( feature ) ) ) ) throw new Error( 'Invalid required world features' );
	if ( ! Array.isArray( source.objects ) || ! Array.isArray( source.portals ) || source.objects.length > 10000 || source.portals.length > 1024 || source.hosts !== undefined && ( ! Array.isArray( source.hosts ) || source.hosts.length > 256 ) || source.components !== undefined && ( ! Array.isArray( source.components ) || source.components.length > 128 ) ) throw new Error( 'Invalid world object, portal, component, or host grant list' );
	const hosts = new Set();
	const failoverWindows = [];
	for ( const grant of source.hosts || [] ) {
		if ( ! grant || typeof grant !== 'object' || Array.isArray( grant ) || typeof grant.peerId !== 'string' || grant.peerId.length < 20 || grant.peerId.length > 256 || ! /^[A-Za-z0-9]+$/.test( grant.peerId ) || hosts.has( grant.peerId ) || ! Number.isSafeInteger( grant.epoch ) || grant.epoch < 1 || ! Number.isSafeInteger( grant.expiresAt ) || grant.expiresAt < 1 || ! Array.isArray( grant.scopes ) || grant.scopes.length < 1 || grant.scopes.length > 2 || new Set( grant.scopes ).size !== grant.scopes.length || grant.scopes.some( ( scope ) => ! [ 'content-cache', 'failover-authority' ].includes( scope ) ) ) throw new Error( 'Invalid or duplicate owner host grant' );
		const failover = grant.scopes.includes( 'failover-authority' );
		if ( failover && ( ! Number.isSafeInteger( grant.failoverAfter ) || grant.failoverAfter < 1 || ! Number.isSafeInteger( grant.failoverSeconds ) || grant.failoverSeconds < 1 || grant.failoverSeconds > 3600 || grant.failoverAfter > grant.expiresAt - grant.failoverSeconds ) || ! failover && ( grant.failoverAfter !== undefined || grant.failoverSeconds !== undefined ) ) throw new Error( 'Invalid host grant failover window' );
		if ( failover ) failoverWindows.push( [ grant.failoverAfter, grant.failoverAfter + grant.failoverSeconds ] );
		hosts.add( grant.peerId );
	}
	for ( let i = 0; i < failoverWindows.length; i ++ ) for ( let j = i + 1; j < failoverWindows.length; j ++ ) if ( failoverWindows[ i ][ 0 ] < failoverWindows[ j ][ 1 ] && failoverWindows[ j ][ 0 ] < failoverWindows[ i ][ 1 ] ) throw new Error( 'Overlapping host grant failover windows' );
	const ids = new Set();
	for ( const object of source.objects ) {
		if ( typeof object.id !== 'string' || ! /^tw-object:[\w.-]{1,128}$/.test( object.id ) || ids.has( object.id ) || object.kind !== 'asset-instance' || typeof object.label !== 'string' || object.label.length > 160 || ! object.transform || ! validVector( object.transform.position ) || ! Number.isFinite( object.transform.yaw ) || object.transform.rotation !== undefined && ( ! validQuaternion( object.transform.rotation ) || object.collision?.enabled === true ) || object.streamingBounds !== undefined && ( ! object.streamingBounds || ! validVector( object.streamingBounds.center ) || object.streamingBounds.center.some( ( n ) => Math.abs( n ) > 10000 ) || ! Number.isFinite( object.streamingBounds.radius ) || object.streamingBounds.radius <= 0 || object.streamingBounds.radius > 10000 ) || object.priority !== undefined && ! [ 'portal-preview', 'visible', 'nearby', 'background' ].includes( object.priority ) || object.replacesObjectId !== undefined && ( typeof object.replacesObjectId !== 'string' || ! /^tw-object:[\w.-]{1,128}$/.test( object.replacesObjectId ) || object.replacesObjectId === object.id ) || ! validVector( object.scale ) || object.scale.some( ( n ) => n <= 0 || n > 1000 ) || ! object.collision || ! [ 'box', 'compound', 'heightfield', 'none' ].includes( object.collision.shape ) || typeof object.collision.enabled !== 'boolean' ) throw new Error( 'Invalid or duplicate object record' );
		if ( object.collision.enabled ) {
			const collision = object.collision;
			const common = typeof collision.walkable === 'boolean' && typeof collision.solid === 'boolean';
			const box = collision.shape === 'box' && validVector( collision.center ) && validVector( collision.halfExtents ) && collision.halfExtents.every( ( n ) => n > 0 && n <= 1000 );
			const heightfield = collision.shape === 'heightfield' && Number.isInteger( collision.columns ) && Number.isInteger( collision.rows ) && collision.columns >= 2 && collision.rows >= 2 && collision.columns <= 4097 && collision.rows <= 4097 && collision.columns * collision.rows <= 4194304 && collision.walkable === true && collision.solid === true;
			const compound = collision.shape === 'compound' && Array.isArray( collision.boxes ) && collision.boxes.length > 0 && collision.boxes.length <= 2048 && collision.boxes.every( ( item ) => item && validVector( item.center ) && item.center.every( ( n ) => Math.abs( n ) <= 1e6 ) && validVector( item.halfExtents ) && item.halfExtents.every( ( n ) => n > 0 && n <= 1000 ) && Number.isFinite( item.yaw ) && Math.abs( item.yaw ) <= 360 && typeof item.walkable === 'boolean' && typeof item.solid === 'boolean' );
			if ( ! box && ! heightfield && ! compound || ( box || heightfield ) && ! common ) throw new Error( 'Enabled object collision requires bounded box, compound, or heightfield data' );
		}
		if ( object.assetId !== null && object.assetId !== undefined && ! /^sha256:[0-9a-f]{64}$/.test( object.assetId ) ) throw new Error( 'Invalid object assetId' );
		if ( object.priority !== undefined && ! [ 'portal-preview', 'visible', 'nearby', 'background' ].includes( object.priority ) ) throw new Error( 'Invalid object streaming priority' );
		validateObjectLODs( object );
		ids.add( object.id );
	}
	const objectByID = new Map( source.objects.map( ( object ) => [ object.id, object ] ) );
	const replacedIDs = new Set();
	for ( const object of source.objects ) if ( object.replacesObjectId ) {
		const replaced = objectByID.get( object.replacesObjectId );
		if ( ! replaced || replaced.priority !== 'portal-preview' || object.priority === 'portal-preview' || replaced.collision.enabled || replacedIDs.has( replaced.id ) ) throw new Error( `Invalid preview replacement on ${object.id}` );
		replacedIDs.add( replaced.id );
	}
	for ( const portal of source.portals ) {
		if ( typeof portal.id !== 'string' || ! /^tw-portal:[\w.-]{1,128}$/.test( portal.id ) || ids.has( portal.id ) || ! /^tw-world:[\w.-]{1,128}$/.test( portal.destinationWorldId || '' ) || portal.destinationPeerId !== undefined && ( typeof portal.destinationPeerId !== 'string' || ! /^[A-Za-z0-9]{20,256}$/.test( portal.destinationPeerId ) ) || ( portal.destinationGateway !== undefined && ! validGateway( portal.destinationGateway ) ) || portal.visual !== undefined && ! [ 'timber', 'stone', 'metal' ].includes( portal.visual ) || ! portal.entry || ! validVector( portal.entry.position ) || ! Number.isFinite( portal.entry.yaw ) || portal.entry.rotation !== undefined || ! portal.exit || ! validVector( portal.exit.position ) || ! Number.isFinite( portal.exit.yaw ) || portal.exit.rotation !== undefined || typeof portal.openView !== 'boolean' || typeof portal.enabled !== 'boolean' ) throw new Error( 'Invalid or duplicate portal record' );
		if ( portal.back !== undefined ) {
			if ( ! source.rules.requiredFeatures?.includes( 'tidewater.portal-two-sided/1' ) ) throw new Error( 'Portal back requires tidewater.portal-two-sided/1' );
			validatePortalBack( portal.back, validGateway );
		}
		ids.add( portal.id );
	}
	let islandOceanCount = 0;
	let waterBodyCount = 0;
	let ambientAudioCount = 0;
	let boatCount = 0;
	let boatObject = null;
	const waterBodies = [];
	for ( const component of source.components || [] ) {
		const vegetation = component?.type === 'tidewater.procedural-island-vegetation/1' && component.seed === 7 && ( component.placementAssetId === undefined || /^sha256:[0-9a-f]{64}$/.test( component.placementAssetId ) );
		const staticVegetation = component?.type === 'tidewater.static-vegetation/1' && /^sha256:[0-9a-f]{64}$/.test( component.placementAssetId || '' );
		const staticReef = component?.type === 'tidewater.static-reef/1' && /^sha256:[0-9a-f]{64}$/.test( component.placementAssetId || '' ) && validStreamingBounds( component.streamingBounds );
		const islandOcean = component?.type === 'tidewater.island-ocean/1';
		const waterBody = component?.type === 'tidewater.water-body/1' && validWaterBody( component );
		const ambientAudio = component?.type === 'tidewater.ambient-audio/1' && validAmbientAudio( component );
		const boat = component?.type === 'tidewater.downeast-boat/1' && /^tw-object:[\w.-]{1,128}$/.test( component.objectId || '' );
		const proceduralTerrain = component?.type === 'tidewater.procedural-island-terrain/1' && component.profile === 'example-island-v1' && /^tw-object:[\w.-]{1,128}$/.test( component.objectId || '' ) && objectByID.get( component.objectId )?.kind === 'asset-instance';
		const terrainSurface = component?.type === 'tidewater.terrain-surface/1' && component.profile === 'example-island-v1' && /^tw-object:[\w.-]{1,128}$/.test( component.objectId || '' ) && objectByID.get( component.objectId )?.kind === 'asset-instance' && /^sha256:[0-9a-f]{64}$/.test( component.dataAssetId || '' );
		const allowedKeys = vegetation ? [ 'id', 'type', 'seed', 'priority', 'placementAssetId', 'streamingBounds' ] : staticVegetation || staticReef ? [ 'id', 'type', 'priority', 'placementAssetId', 'streamingBounds' ] : islandOcean ? [ 'id', 'type', 'priority', 'streamingBounds' ] : proceduralTerrain ? [ 'id', 'type', 'profile', 'priority', 'objectId', 'streamingBounds' ] : terrainSurface ? [ 'id', 'type', 'profile', 'priority', 'objectId', 'dataAssetId', 'streamingBounds' ] : waterBody ? [ 'id', 'type', 'priority', 'center', 'extent', 'profile', 'streamingBounds' ] : ambientAudio ? [ 'id', 'type', 'priority', 'streamingBounds', 'beds' ] : boat ? [ 'id', 'type', 'priority', 'objectId' ] : [];
		if ( ! component || typeof component.id !== 'string' || ! /^tw-component:[\w.-]{1,128}$/.test( component.id ) || ids.has( component.id ) || ( ! vegetation && ! staticVegetation && ! staticReef && ! islandOcean && ! proceduralTerrain && ! terrainSurface && ! waterBody && ! ambientAudio && ! boat ) || component.priority !== undefined && ! [ 'portal-preview', 'visible', 'nearby', 'background' ].includes( component.priority ) || component.streamingBounds !== undefined && ! validStreamingBounds( component.streamingBounds ) || Object.keys( component ).some( ( key ) => ! allowedKeys.includes( key ) ) ) throw new Error( 'Invalid or duplicate world component' );
		if ( islandOcean && ++ islandOceanCount > 1 ) throw new Error( 'A world may declare only one island ocean component' );
		if ( waterBody && ++ waterBodyCount > 4 ) throw new Error( 'A world may declare at most four water body components' );
		if ( ambientAudio && ++ ambientAudioCount > 16 ) throw new Error( 'A world may declare at most 16 ambient audio components' );
		if ( boat ) {
			boatCount ++;
			boatObject = objectByID.get( component.objectId );
			if ( component.priority !== 'portal-preview' || ! boatObject || boatObject.kind !== 'asset-instance' || boatObject.priority !== 'portal-preview' || boatObject.collision.enabled || boatObject.collision.shape !== 'none' || boatObject.transform.rotation !== undefined || boatObject.scale.some( ( value ) => value !== 1 ) || ! /^sha256:[0-9a-f]{64}$/.test( boatObject.assetId || '' ) ) throw new Error( `Invalid berth preview object on boat component ${component.id}` );
			if ( boatCount > 1 ) throw new Error( 'A world may declare only one Downeast boat component' );
		}
		if ( waterBody && ( source.rules.seaLevel === undefined || islandOceanCount > 0 ) ) throw new Error( 'A portable water body requires seaLevel and cannot be combined with island-ocean' );
		if ( islandOcean && waterBodyCount > 0 ) throw new Error( 'A world cannot combine portable water and island-ocean components' );
		if ( waterBody ) {
			if ( waterBodies.some( ( other ) => Math.abs( component.center[ 0 ] - other.center[ 0 ] ) < component.extent + other.extent && Math.abs( component.center[ 1 ] - other.center[ 1 ] ) < component.extent + other.extent ) ) throw new Error( 'Portable water body bounds cannot overlap' );
			waterBodies.push( component );
		}
		if ( ! source.rules.requiredFeatures?.includes( component.type ) ) throw new Error( `World component ${component.type} must be listed in requiredFeatures` );
		ids.add( component.id );
	}
	if ( boatCount && ( source.rules.seaLevel === undefined || islandOceanCount !== 1 && waterBodyCount === 0 ) ) throw new Error( 'A Downeast boat requires seaLevel and a declared water renderer' );
	if ( boatCount && waterBodyCount && ! waterBodies.some( ( water ) => Math.abs( boatObject.transform.position[ 0 ] - water.center[ 0 ] ) <= water.extent && Math.abs( boatObject.transform.position[ 2 ] - water.center[ 1 ] ) <= water.extent ) ) throw new Error( 'A Downeast boat berth must be inside a declared water body' );
	return source;
}

function validAmbientAudio( component ) {
	return Array.isArray( component.beds ) && component.beds.length > 0 && component.beds.length <= 16 && component.beds.every( ( bed ) => {
		if ( ! bed || typeof bed !== 'object' || Array.isArray( bed ) || Object.keys( bed ).some( ( key ) => ! [ 'assetId', 'gain', 'condition', 'position', 'refDistance', 'rolloff' ].includes( key ) ) ) return false;
		if ( typeof bed.assetId !== 'string' || ! /^sha256:[0-9a-f]{64}$/.test( bed.assetId ) || ! Number.isFinite( bed.gain ) || bed.gain < 0 || bed.gain > 1 || bed.condition !== undefined && ! [ 'always', 'day', 'night', 'dawn', 'underwater' ].includes( bed.condition ) ) return false;
		if ( bed.position !== undefined && ( ! validVector( bed.position ) || bed.position.some( ( value ) => Math.abs( value ) > 100000 ) ) ) return false;
		return ( bed.refDistance === undefined || Number.isFinite( bed.refDistance ) && bed.refDistance >= 0.5 && bed.refDistance <= 1000 ) && ( bed.rolloff === undefined || Number.isFinite( bed.rolloff ) && bed.rolloff >= 0 && bed.rolloff <= 10 );
	} );
}

function validWaterBody( component ) {
	return ( component.profile === undefined || [ 'deep-ocean', 'calm-lagoon', 'storm' ].includes( component.profile ) ) && Array.isArray( component.center ) && component.center.length === 2 && component.center.every( ( n ) => Number.isFinite( n ) && Math.abs( n ) + component.extent <= 1e6 ) && Number.isFinite( component.extent ) && component.extent >= 8 && component.extent <= 100000;
}

function validStreamingBounds( bounds ) {
	return bounds && typeof bounds === 'object' && ! Array.isArray( bounds ) && Object.keys( bounds ).every( ( key ) => [ 'center', 'radius' ].includes( key ) ) && validVector( bounds.center ) && bounds.center.every( ( n ) => Math.abs( n ) <= 10000 ) && Number.isFinite( bounds.radius ) && bounds.radius > 0 && bounds.radius <= 10000;
}

function validVector( value ) {
	return Array.isArray( value ) && value.length === 3 && value.every( ( n ) => Number.isFinite( n ) && Math.abs( n ) <= 1e6 );
}

function validQuaternion( value ) {
	return Array.isArray( value ) && value.length === 4 && value.every( Number.isFinite ) && Math.abs( Math.hypot( ...value ) - 1 ) <= 1e-4;
}

function validGateway( value ) {
	if ( typeof value !== 'string' ) return false;
	try {
		const gateway = new URL( value );
		return [ 'https:', 'wss:' ].includes( gateway.protocol ) && ! gateway.username && ! gateway.password && ( gateway.pathname === '' || gateway.pathname === '/' ) && ! gateway.search && ! gateway.hash;
	} catch {
		return false;
	}
}

// Shared source and signed-manifest contract; variants change visuals only.
export function validateObjectLODs( object, assets ) {
	if ( object.lods === undefined ) return;
	if ( ! /^sha256:[0-9a-f]{64}$/.test( object.assetId || '' ) || ! object.streamingBounds || ! Array.isArray( object.lods ) || object.lods.length < 1 || object.lods.length > 3 ) throw new Error( `Invalid object LOD list on ${object.id}` );
	const seen = new Set( [ object.assetId ] );
	let previous = 1;
	const refs = assets && new Map( assets.map( ( asset ) => [ asset.id, asset ] ) );
	if ( refs && refs.get( object.assetId )?.kind !== 'glb' ) throw new Error( `Object LOD base must reference GLB on ${object.id}` );
	for ( const level of object.lods ) {
		if ( ! level || typeof level !== 'object' || Array.isArray( level ) || Object.keys( level ).some( ( key ) => ! [ 'assetId', 'maxScreenFraction' ].includes( key ) ) || ! /^sha256:[0-9a-f]{64}$/.test( level.assetId || '' ) || seen.has( level.assetId ) || ! Number.isFinite( level.maxScreenFraction ) || level.maxScreenFraction <= 0 || level.maxScreenFraction >= previous || refs && refs.get( level.assetId )?.kind !== 'glb' ) throw new Error( `Invalid object LOD variant on ${object.id}` );
		seen.add( level.assetId );
		previous = level.maxScreenFraction;
	}
}

// Positions describe the camera eye in world-space meters, like portal entry/exit poses.
export function validateWorldSpawn( spawn ) {
	if ( spawn === undefined ) return;
	if ( ! spawn || typeof spawn !== 'object' || Array.isArray( spawn ) || ! validVector( spawn.position ) || spawn.position.some( ( value ) => Math.abs( value ) > 1e6 ) || ! Number.isFinite( spawn.yaw ) || Math.abs( spawn.yaw ) > 360 || ! Number.isFinite( spawn.pitch ) || Math.abs( spawn.pitch ) > 1.5 ) throw new Error( 'Invalid world spawn pose' );
}

export function worldSpawnPose( manifest ) {
	validateWorldSpawn( manifest?.spawn );
	const pose = manifest?.spawn ?? { position: [ 0, 3, 8 ], yaw: Math.PI, pitch: - 0.1 };
	return { position: [ ...pose.position ], yaw: pose.yaw, pitch: pose.pitch };
}
