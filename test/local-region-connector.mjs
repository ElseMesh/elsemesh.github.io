import assert from 'node:assert/strict';
import { LocalRegionConnector } from '../src/network/LocalRegionConnector.js';
import { parseGLB } from '../src/engine/loaders/GLTF.js';
import { worldLinkFromLocation } from '../src/network/WorldConnector.js';
import { defaultHomeWorldURL, discoverLocalWorldURL } from '../src/network/WorldLauncher.js';
import { chooseWorldEntryPoint } from '../src/ui/WorldEntryPointPicker.js';

function makeGlb() {
	const document = {
		asset: { version: '2.0' },
		nodes: [ { translation: [ 10, 0, 20 ], extras: { elsemeshCollision: {
			coordinateSystem: 'elsemesh-y-up-meters/1',
			boxes: [ { center: [ 0, 0, 0 ], halfExtents: [ 10, 0, 10 ], rotation: [ 0, 0, 0, 1 ] } ],
		} } } ],
	};
	const json = new TextEncoder().encode( JSON.stringify( document ) );
	const jsonLength = ( json.byteLength + 3 ) & ~3;
	const bytes = new Uint8Array( 28 + jsonLength );
	const view = new DataView( bytes.buffer );
	view.setUint32( 0, 0x46546c67, true );
	view.setUint32( 4, 2, true );
	view.setUint32( 8, bytes.byteLength, true );
	view.setUint32( 12, jsonLength, true );
	view.setUint32( 16, 0x4e4f534a, true );
	bytes.fill( 0x20, 20, 20 + jsonLength );
	bytes.set( json, 20 );
	view.setUint32( 20 + jsonLength, 0, true );
	view.setUint32( 24 + jsonLength, 0x004e4942, true );
	return bytes;
}

function makeEmptyGlb() {
	const json = new TextEncoder().encode( JSON.stringify( { asset: { version: '2.0' }, scene: 0, scenes: [ { nodes: [] } ], nodes: [] } ) );
	const jsonLength = ( json.byteLength + 3 ) & ~3;
	const bytes = new Uint8Array( 20 + jsonLength );
	const view = new DataView( bytes.buffer );
	view.setUint32( 0, 0x46546c67, true );
	view.setUint32( 4, 2, true );
	view.setUint32( 8, bytes.byteLength, true );
	view.setUint32( 12, jsonLength, true );
	view.setUint32( 16, 0x4e4f534a, true );
	bytes.fill( 0x20, 20 );
	bytes.set( json, 20 );
	return bytes;
}

const bytes = makeGlb();
const hash = Buffer.from( await crypto.subtle.digest( 'SHA-256', bytes ) ).toString( 'hex' );
const emptyBytes = makeEmptyGlb();
const emptyHash = Buffer.from( await crypto.subtle.digest( 'SHA-256', emptyBytes ) ).toString( 'hex' );
const originalFetch = globalThis.fetch;
let cellFetches = 0;
let leaseReleases = 0;
let descriptorWorldId = 'elsemesh:hogwarts-legacy-local';
let descriptorChoices = [ { id: 'gryffindor', label: 'Gryffindor' }, { id: 'hufflepuff', label: 'Hufflepuff' } ];
const payloadFetchOrder = [];
let secondCellCollisionMissing = true;
let knownEmptyCellCollisionMissing = true;
let abortNextCellFetch = false;
let abortableFetchStarted;
globalThis.fetch = async ( input, options = {} ) => {
	const url = new URL( input );
	if ( url.pathname === '/v1/regions/great-hall/leases' && options.method === 'POST' ) return Response.json( { leaseId: 'a'.repeat( 32 ), expiresInSeconds: 30 } );
	if ( url.pathname === `/v1/leases/${ 'a'.repeat( 32 ) }` && options.method === 'DELETE' ) {
		leaseReleases++;
		return new Response( null, { status: 204 } );
	}
	if ( url.pathname === '/v1/regions/great-hall' && ( options.method === undefined || options.method === 'GET' ) && url.searchParams.has( 'lease' ) ) payloadFetchOrder.push( url.searchParams.get( 'payload' ) );
	if ( url.pathname === '/v1/descriptor' ) return Response.json( {
		schema: 'elsemesh.dynamic-region-provider/1', worldId: descriptorWorldId, title: 'Hogwarts Legacy',
		sourceRevision: 'test-revision', readOnly: true, regions: '/v1/regions',
		entrySelection: {
			schema: 'elsemesh.world-entry-selection/1', entryPointActionLabel: 'Choose your house',
			entryPointPrompt: 'Which Hogwarts house will you join?',
			previewSpawn: { position: [ 1, 8.62, 9 ], yaw: 0, pitch: - 0.1 },
			previewRegion: { cellSizeMeters: 16, maxViewDistanceMeters: 32, startupCellOffsetBounds: { min: [ -1, 0, 0 ], max: [ 0, 0, 0 ] } },
			previewSupport: { status: 'provisional', position: [ 0, 6.75, 8 ], halfExtents: [ 2, 0.25, 3 ], basis: 'synthetic rendered floor bounds' },
			choices: descriptorChoices,
		},
	} );
	if ( url.pathname === '/v1/regions' ) return Response.json( { regions: [ { id: 'great-hall', label: 'Great Hall', asset: '/v1/regions/great-hall' } ] } );
	if ( url.pathname === '/v1/regions/great-hall/cells' ) return Response.json( {
		sourceRevision: 'test-revision', cellSizeMeters: Number( url.searchParams.get( 'size' ) ), collisionSourceInventory: { staticMeshComponents: 3, otherPrimitiveComponents: 0, unclassifiedOtherPrimitiveComponents: 0, explicitlyNonQueryOtherPrimitiveComponents: 0, explicitlyNonBlockingForPawnOtherPrimitiveComponents: 0, landscapeHeightfieldCollisionComponents: 0, otherPrimitiveStatuses: {} }, cells: [
			{ x: 0, y: 0, z: 0, collisionEvidence: { scope: 'all-collision-sources', staticMeshComponentCount: 1, supportedSimpleShapeComponents: 1, explicitlyNonQueryCollidableComponents: 0, explicitlyNonBlockingForPawnComponents: 0, unknownComponents: 0, staticMeshComponentsClassified: true } },
			{ x: 1, y: 0, z: 0, collisionEvidence: { scope: 'static-mesh-components-only', staticMeshComponentCount: 1, supportedSimpleShapeComponents: 0, explicitlyNonQueryCollidableComponents: 0, explicitlyNonBlockingForPawnComponents: 0, unknownComponents: 1, staticMeshComponentsClassified: false } },
			{ x: 2, y: 0, z: 0, collisionEvidence: { scope: 'all-collision-sources', staticMeshComponentCount: 1, supportedSimpleShapeComponents: 0, explicitlyNonQueryCollidableComponents: 1, explicitlyNonBlockingForPawnComponents: 0, unknownComponents: 0, staticMeshComponentsClassified: true } },
		],
	} );
	if ( url.pathname === '/v1/regions/great-hall' && url.searchParams.get( 'cell' ) === '0,0,0,16' && url.searchParams.get( 'lease' ) === 'a'.repeat( 32 ) ) {
		cellFetches++;
		if ( abortNextCellFetch ) {
			abortNextCellFetch = false;
			abortableFetchStarted();
			return new Promise( ( resolve, reject ) => options.signal.addEventListener( 'abort', () => reject( options.signal.reason ), { once: true } ) );
		}
		return new Response( bytes, { headers: {
			'Content-Length': String( bytes.byteLength ), ETag: `"sha256-${hash}"`,
		} } );
	}
	if ( url.pathname === '/v1/regions/great-hall' && url.searchParams.get( 'cell' ) === '1,0,0,16' && url.searchParams.get( 'payload' ) === 'collision' && url.searchParams.get( 'lease' ) === 'a'.repeat( 32 ) ) {
		if ( secondCellCollisionMissing ) return new Response( 'not found', { status: 404 } );
		return new Response( bytes, { headers: {
			'Content-Length': String( bytes.byteLength ), ETag: `"sha256-${hash}"`,
		} } );
	}
	if ( url.pathname === '/v1/regions/great-hall' && url.searchParams.get( 'cell' ) === '2,0,0,16' && url.searchParams.get( 'payload' ) === 'collision' && url.searchParams.get( 'lease' ) === 'a'.repeat( 32 ) ) {
		if ( knownEmptyCellCollisionMissing ) return new Response( 'not found', { status: 404 } );
		return new Response( emptyBytes, { headers: {
			'Content-Length': String( emptyBytes.byteLength ), ETag: `"sha256-${emptyHash}"`,
		} } );
	}
	if ( url.pathname === '/v1/regions/great-hall' && url.searchParams.has( 'cell' ) && url.searchParams.has( 'lease' ) ) return new Response( bytes, { headers: { 'Content-Length': String( bytes.byteLength ), ETag: `"sha256-${hash}"` } } );
	return new Response( 'not found', { status: 404 } );
};

try {
	const link = worldLinkFromLocation( {
		search: '?localProvider=http%3A%2F%2F127.0.0.1%3A4179&localMap=Great%20Hall',
		href: 'http://127.0.0.1:5189/?localProvider=http%3A%2F%2F127.0.0.1%3A4179&localMap=Great%20Hall',
	} );
	assert.deepEqual( link, { localProvider: 'http://127.0.0.1:4179', localMap: 'Great Hall', environment: null } );
	const localPage = 'http://127.0.0.1:5189/?localProvider=http%3A%2F%2F127.0.0.1%3A4179&localMap=Great%20Hall';
	assert.equal( await discoverLocalWorldURL( { pageURL: localPage, fetchImpl: () => { throw new Error( 'must not query the default world for a local bridge link' ); } } ), null );
	assert.equal( defaultHomeWorldURL( { pageURL: localPage, storage: { getItem: () => '{"worldId":"elsemesh:example-island"}' } } ), null );
	assert.throws( () => worldLinkFromLocation( {
		search: '?localProvider=http%3A%2F%2Fexample.com&localMap=Great%20Hall',
		href: 'http://127.0.0.1:5189/',
	} ), /loopback/ );
	assert.throws( () => worldLinkFromLocation( {
		search: '?localProvider=http%3A%2F%2F127.0.0.1%3A4179&localMap=Great%20Hall&worldId=elsemesh%3Atidewater',
		href: 'http://127.0.0.1:5189/',
	} ), /cannot be combined/ );
	const invalidIDConnector = new LocalRegionConnector( link );
	for ( const worldId of [ 'world:legacy', 'elsemesh-world:legacy', 'em-world:legacy' ] ) {
		descriptorWorldId = worldId;
		await assert.rejects( invalidIDConnector.getManifest(), /unsupported descriptor/, `dynamic world providers must reject ${worldId}` );
	}
	descriptorWorldId = 'elsemesh:hogwarts-legacy-local';

	const connector = new LocalRegionConnector( link );
	const manifest = await connector.getManifest();
	assert.equal( manifest.title, 'Hogwarts Legacy · Great Hall' );
	assert.deepEqual( manifest.spawn.position, [ 1, 8.62, 9 ] );
	assert.equal( manifest.entryPointActionLabel, 'Choose your house' );
	assert.equal( manifest.entryPointPrompt, 'Which Hogwarts house will you join?' );
	assert.deepEqual( manifest.entryPoints.map( entry => entry.id ), [ 'gryffindor', 'hufflepuff' ] );
	assert.equal( manifest.rules.physicsProfile, 'default' );
	assert.equal( 'seaLevel' in manifest.rules, false, 'local Hogwarts preview does not activate a default waterline' );
	assert.equal( manifest.assets.length, 8, 'indexed collision and visual cells should have distinct assets' );
	assert.equal( manifest.objects.length, 9, 'collision and visual cell objects plus the preview collider should be present' );
	assert.equal( manifest.assets[ 0 ].id, 'local-region:great-hall:16:0,0,0:collision' );
	assert.equal( manifest.objects[ 0 ].assetId, manifest.assets[ 0 ].id );
	assert.equal( manifest.objects[ 0 ].regionCell, true );
	assert.equal( manifest.objects[ 0 ].collisionPayload, true );
	assert.equal( connector.initialRegionCellObjectIDs.has( manifest.objects[ 0 ].id ), true, 'startup preloads collision objects before visuals' );
	assert.equal( connector.initialRegionCellObjectIDs.size, 2, 'startup cells are derived from the spawn cell and authored offset bounds' );
	assert.ok( manifest.objects.some( object => object.id.endsWith( '-1,0,0:collision' ) ), 'negative startup cell offsets are applied to the derived spawn cell' );
	assert.deepEqual( manifest.objects[ 0 ].streamingBounds.center, [ 8, 8, 8 ] );
	const previewSupport = manifest.objects.find( object => object.id === 'elsemesh-object:region-preview-floor-support' );
	assert.equal( previewSupport.assetId, null );
	assert.equal( previewSupport.collision.enabled, true );
	const loaded = await connector.preload();
	assert.equal( loaded.get( manifest.assets[ 0 ].id ).byteLength, bytes.byteLength );
	assert.equal( parseGLB( loaded.get( manifest.assets[ 0 ].id ) ).nodes[ 0 ].extras.elsemeshCollision.coordinateSystem, 'elsemesh-y-up-meters/1', 'collision-only GLB metadata is readable by the ElseMesh loader' );
	assert.deepEqual( parseGLB( loaded.get( manifest.assets[ 2 ].id ) ).nodes, [], 'missing collision bytes remain representable to the package loader' );
	assert.deepEqual( payloadFetchOrder, [ 'collision', 'collision', 'collision', 'collision', 'visual', 'visual', 'visual', 'visual' ], 'collision requests must be fetched before visual requests' );
	assert.equal( connector.assetBytes, [ ...connector.assets.values() ].reduce( ( sum, value ) => sum + value.byteLength, 0 ), 'unknown collision placeholders are not cached as provider data' );
	assert.equal( leaseReleases, 8, 'each region fetch should release its temporary visitor lease' );
	const collisionIDs = [ ...connector.collisionObjectIDsByCell.get( '0,0,0' ), ...connector.collisionObjectIDsByCell.get( '1,0,0' ) ];
	const emptyCollisionID = [ ...connector.collisionObjectIDsByCell.get( '2,0,0' ) ][ 0 ];
	assert.equal( connector.isCollisionPathReady( [ 1, 0, 1 ], [ 2, 0, 1 ], { loadedObjects: new Set( [ collisionIDs[ 0 ] ] ) } ), true, 'loaded collision with complete source coverage permits a local path' );
	assert.equal( connector.isCollisionPathReady( [ 15, 0, 1 ], [ 17, 0, 1 ], { loadedObjects: new Set( [ collisionIDs[ 0 ] ] ) } ), false, 'movement stops until collision data for every crossed cell has loaded' );
	assert.equal( connector.isCollisionPathReady( [ 15, 0, 1 ], [ 17, 0, 1 ], { loadedObjects: new Set( collisionIDs ) } ), false, 'a missing collision response remains unknown and blocks the swept path even if the loader has an empty placeholder' );
	secondCellCollisionMissing = false;
	await connector.getAsset( manifest.assets[ 2 ].id );
	assert.equal( connector.isCollisionPathReady( [ 15, 0, 1 ], [ 17, 0, 1 ], { loadedObjects: new Set( collisionIDs ) } ), false, 'a shape-bearing response cannot clear source coverage that the provider marked unknown' );
	const emptyCellCollisionAsset = manifest.assets.find( asset => asset.id === 'local-region:great-hall:16:2,0,0:collision' );
	assert.ok( emptyCellCollisionAsset );
	assert.equal( connector.isCollisionPathReady( [ 33, 0, 1 ], [ 34, 0, 1 ], { loadedObjects: new Set( [ emptyCollisionID ] ) } ), false, 'an absent payload remains unknown even when index evidence predicts a collision-empty cell' );
	knownEmptyCellCollisionMissing = false;
	const emptyCollisionPayload = await connector.getAsset( emptyCellCollisionAsset.id );
	assert.deepEqual( parseGLB( emptyCollisionPayload ).nodes, [] );
	assert.equal( connector.isCollisionPathReady( [ 33, 0, 1 ], [ 34, 0, 1 ], { loadedObjects: new Set( [ emptyCollisionID ] ) } ), true, 'a valid empty payload plus complete all-source evidence proves the cell has no blocking collision' );
	assert.equal( connector.releaseAsset( manifest.assets[ 0 ].id ), true );
	assert.equal( connector.assetBytes, [ ...connector.assets.values() ].reduce( ( sum, value ) => sum + value.byteLength, 0 ), 'unloaded cells should release cached browser bytes' );
	assert.equal( await connector.getAsset( manifest.assets[ 0 ].id ).then( value => value.byteLength ), bytes.byteLength );
	assert.equal( cellFetches, 3, 'a released cell should be fetched again on demand' );
	assert.equal( leaseReleases, 11, 'collision retries and a refetched cell should release their leases' );
	connector.releaseAsset( manifest.assets[ 0 ].id );
	abortNextCellFetch = true;
	const requestStarted = new Promise( resolve => { abortableFetchStarted = resolve; } );
	const abortController = new AbortController();
	const abortedRequest = connector.getAsset( manifest.assets[ 0 ].id, { signal: abortController.signal } );
	await requestStarted;
	abortController.abort();
	await assert.rejects( abortedRequest, { name: 'AbortError' } );
	assert.equal( leaseReleases, 12, 'aborting a visitor fetch should release its server lease' );
	const retainedAssetId = manifest.assets[ 0 ].id;
	const streamedAssetId = manifest.assets[ 1 ].id;
	connector.releaseAsset( retainedAssetId );
	connector.releaseAsset( streamedAssetId );
	const streamedAssetIDs = [];
	const retainedAssets = await connector.preload( {
		assetIDs: new Set( [ retainedAssetId, streamedAssetId ] ), retainAssets: false,
		retainAssetIDs: new Set( [ retainedAssetId ] ),
		onAsset: async assetId => streamedAssetIDs.push( assetId ),
	} );
	assert.deepEqual( streamedAssetIDs, [ retainedAssetId, streamedAssetId ], 'streamed asset callback receives collision then visual payloads' );
	assert.deepEqual( [ ...retainedAssets.keys() ], [ retainedAssetId ], 'only explicitly retained asset IDs stay in the returned preload map' );
	assert.equal( connector.assets.has( retainedAssetId ), true, 'retained component data remains cached for installation' );
	assert.equal( connector.assets.has( streamedAssetId ), false, 'streamed visuals release their browser byte cache after processing' );
	connector.close();
	assert.equal( connector.assets.size, 0 );
	descriptorChoices = [];
	const singleSpawnConnector = new LocalRegionConnector( link );
	const singleSpawnManifest = await singleSpawnConnector.getManifest();
	assert.deepEqual( singleSpawnManifest.entryPoints, [], 'a world may temporarily disable optional entry-point choices' );
	assert.equal( await chooseWorldEntryPoint( singleSpawnManifest, { documentRef: null } ), null, 'no choices means entry directly at the world spawn without opening a prompt' );
	singleSpawnConnector.close();
	console.log( 'local region connector tests passed' );
} finally {
	globalThis.fetch = originalFetch;
}
