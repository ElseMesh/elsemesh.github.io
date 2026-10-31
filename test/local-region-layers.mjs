import assert from 'node:assert/strict';
import { LocalRegionConnector } from '../src/network/LocalRegionConnector.js';

const descriptor = {
	schema: 'elsemesh.dynamic-region-provider/1', readOnly: true, sourceRevision: 'test-revision', worldId: 'elsemesh:test', title: 'Test world', regions: '/v1/regions',
	entrySelection: {
		schema: 'elsemesh.world-entry-selection/1', entryPointActionLabel: 'Choose your house', entryPointPrompt: 'Which house?',
		choices: [ { id: 'gryffindor', label: 'Gryffindor' } ], previewSpawn: { position: [ 0, 8, 0 ], yaw: 0 },
		previewRegion: { cellSizeMeters: 8, maxViewDistanceMeters: 16, startupCellOffsetBounds: { min: [ 0, 0, 0 ], max: [ 1, 0, 0 ] }, layers: [ 'Tech', 'Lighting', 'Collision' ] },
	},
};
const regions = [
	{ id: 'main', label: 'GreatHall_Int', asset: '/v1/regions/main' },
	{ id: 'tech', label: 'Tech', asset: '/v1/regions/tech' },
	{ id: 'lighting', label: 'Lighting', asset: '/v1/regions/lighting' },
	{ id: 'collision', label: 'Collision', asset: '/v1/regions/collision' },
];
const cellsByRegion = {
	main: [ { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 } ],
	tech: [ { x: 0, y: 0, z: 0 } ],
	lighting: [ { x: 1, y: 0, z: 0 } ],
	collision: [],
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
	const request = new URL( url );
	if ( request.pathname.endsWith( '/descriptor' ) ) return new Response( JSON.stringify( descriptor ) );
	if ( request.pathname === '/v1/regions' ) return new Response( JSON.stringify( { regions } ) );
	const regionId = request.pathname.split( '/' )[ 3 ];
	return new Response( JSON.stringify( {
		sourceRevision: 'test-revision', cellSizeMeters: 8,
		collisionSourceInventory: { staticMeshComponents: 0, otherPrimitiveComponents: 0, unclassifiedOtherPrimitiveComponents: 0, explicitlyNonQueryOtherPrimitiveComponents: 0, explicitlyNonBlockingForPawnOtherPrimitiveComponents: 0, unindexedOtherPrimitiveComponents: 0, landscapeHeightfieldCollisionComponents: 0, unresolvedInstancedMeshComponents: 0, otherPrimitiveStatuses: {} },
		cells: ( cellsByRegion[ regionId ] || [] ).map( cell => ( { ...cell, collisionEvidence: { scope: 'all-collision-sources', staticMeshComponentCount: 0, unknownComponents: 0, supportedSimpleShapeComponents: 0, explicitlyNonQueryCollidableComponents: 0, explicitlyNonBlockingForPawnComponents: 0, staticMeshComponentsClassified: true, otherPrimitiveComponentCount: 0, supportedOtherPrimitiveComponents: 0, unknownOtherPrimitiveComponents: 0 } } ) ),
	} ) );
};

try {
	const connector = new LocalRegionConnector( { localProvider: 'http://127.0.0.1:4179', localMap: 'GreatHall_Int' } );
	const manifest = await connector.getManifest();
	const cellObjects = manifest.objects.filter( object => object.regionCell );
	assert.deepEqual( cellObjects.map( object => object.label ), [
		'GreatHall_Int collision cell 0,1,0', 'GreatHall_Int visual cell 0,1,0',
		'GreatHall_Int collision cell 1,1,0', 'GreatHall_Int visual cell 1,1,0',
		'Tech collision cell 0,0,0', 'Tech visual cell 0,0,0',
		'Lighting collision cell 1,0,0', 'Lighting visual cell 1,0,0',
	], 'the manifest combines only occupied cells from each authored layer' );
	assert.equal( connector.initialRegionCellObjectIDs.size, 2, 'primary startup collision cells are required before entry' );
	assert.equal( connector.initialRegionVisualObjectIDs.size, 2, 'primary startup visuals are also required before entry' );
	assert.equal( cellObjects.filter( object => object.priority === 'visible' ).length, 4, 'startup collision and visual payloads receive visible priority' );
	assert.equal( manifest.assets.length, 8, 'only composed occupied collision and visual cells receive streamed assets' );
	assert.equal( cellObjects.some( object => object.label === 'GreatHall_Int collision cell 0,0,0' ), false, 'an unindexed startup cell does not get a synthetic collision object' );
	connector.close();
} finally {
	globalThis.fetch = originalFetch;
}

console.log( 'ok local region connector composes world-authored region layers' );
