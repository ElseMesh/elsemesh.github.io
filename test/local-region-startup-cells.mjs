import assert from 'node:assert/strict';
import { LocalRegionConnector } from '../src/network/LocalRegionConnector.js';

const indexedStartupCell = [ 0, 0, 5 ];
const descriptor = {
	schema: 'elsemesh.dynamic-region-provider/1', readOnly: true, sourceRevision: 'test-revision', worldId: 'elsemesh:test', regions: '/v1/regions',
	entrySelection: {
		entryPointActionLabel: 'Choose your house', entryPointPrompt: 'Which house?',
		choices: [ { id: 'gryffindor', label: 'Gryffindor' } ],
		experience: {
			genre: 'The Great Hall', tagline: 'Choose your house.', loadingNote: 'Preparing the Hall.', tips: [ 'Nearby rooms load as you explore.' ],
			stages: { world: 'Loading the starting area…' }, theme: { logo: { src: '/v1/presentation/logo.svg', alt: 'Castle mark' }, colors: { accent: '#c6a664' } },
		},
		previewSpawn: { position: [ 0, 8.62, 90 ], yaw: 0 },
		previewRegion: { cellSizeMeters: 16, maxViewDistanceMeters: 32, startupCellOffsetBounds: { min: [ -1, 0, -1 ], max: [ 1, 0, 1 ] } },
	},
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
	const path = new URL( url ).pathname;
	const payload = path.endsWith( '/descriptor' ) ? descriptor : path === '/v1/regions' ? { regions: [ { id: 'hall', label: 'Great Hall', asset: '/v1/regions/hall' } ] } : { sourceRevision: 'test-revision', cellSizeMeters: 16, cells: [ { x: 0, y: 0, z: 5 } ] };
	if ( path !== '/v1/descriptor' && path !== '/v1/regions' ) {
		payload.collisionSourceInventory = {
			staticMeshComponents: 0, otherPrimitiveComponents: 0, unclassifiedOtherPrimitiveComponents: 0, unindexedOtherPrimitiveComponents: 0,
			explicitlyNonQueryOtherPrimitiveComponents: 0, explicitlyNonBlockingForPawnOtherPrimitiveComponents: 0,
			landscapeHeightfieldCollisionComponents: 0, unresolvedInstancedMeshComponents: 0, otherPrimitiveStatuses: {},
		};
		payload.cells = [ { x: indexedStartupCell[ 0 ], y: indexedStartupCell[ 1 ], z: indexedStartupCell[ 2 ], collisionEvidence: {
			scope: 'all-collision-sources', staticMeshComponentCount: 0, unknownComponents: 0,
			supportedSimpleShapeComponents: 0, explicitlyNonQueryCollidableComponents: 0,
			explicitlyNonBlockingForPawnComponents: 0, staticMeshComponentsClassified: true,
			otherPrimitiveComponentCount: 0, supportedOtherPrimitiveComponents: 0, unknownOtherPrimitiveComponents: 0,
		} } ];
	}
	return new Response( JSON.stringify( payload ), { status: 200, headers: { 'Content-Type': 'application/json' } } );
};

try {
	const connector = new LocalRegionConnector( { localProvider: 'http://127.0.0.1:4179', localMap: 'hall' } );
	const manifest = await connector.getManifest();
	assert.equal( manifest.title, 'Great Hall', 'providers without an optional title use the selected region label' );
	assert.equal( connector.initialRegionCellObjectIDs.size, 1, 'only an indexed startup collision cell is marked for preload' );
	assert.equal( connector.initialRegionVisualObjectIDs.size, 1, 'only an indexed startup visual cell is required before entry' );
	assert.equal( connector.emptyCollisionCellsAreVerified, true, 'complete per-layer inventories prove absent cells are empty' );
	assert.equal( manifest.experience.genre, 'The Great Hall', 'the local world controls its loading copy' );
	assert.equal( manifest.experience.theme.logo.src, 'http://127.0.0.1:4179/v1/presentation/logo.svg', 'world logo paths resolve against the local content provider' );
	assert.equal( manifest.objects.filter( object => object.priority === 'visible' && object.regionCell && object.collisionPayload ).length, 1, 'indexed startup collision cells receive the required-load priority' );
	assert.equal( manifest.objects.filter( object => object.regionCell && object.collisionPayload ).length, 1, 'unindexed empty cells do not create synthetic collision assets' );
	assert.equal( connector.isCollisionPathReady( [ 17, 1, 81 ], [ 18, 1, 81 ], { loadedObjects: new Set() } ), true, 'a path through an absent cell is open when every layer has complete collision coverage' );
	connector.close();
} finally {
	globalThis.fetch = originalFetch;
}

console.log( 'ok world-authored startup cells are required before local-world entry' );
