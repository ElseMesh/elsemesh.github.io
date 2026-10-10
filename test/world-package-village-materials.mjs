import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import '../test/headless.mjs';
import { GPU } from '../src/engine/gpu/GPU.js';
import { readTexture } from '../src/engine/gpu/Readback.js';
import { loadWorldPackage, disposeWorldPackage } from '../src/network/WorldPackage.js';
import { decodeVillageMaterialAsset } from '../src/network/VillageMaterialAsset.js';
import { VILLAGE_MATERIAL_PROFILE, VILLAGE_MATERIAL_ROLES } from '../src/network/WorldVillageMaterial.js';

const source = JSON.parse( await readFile( new URL( '../worlds/island/world-source.json', import.meta.url ) ) );
const village = source.objects.find( object => object.id === 'tw-object:island-village' );
const previewObject = source.objects.find( object => object.priority === 'portal-preview' && object.id !== village.id );
const bytes = new Uint8Array( await readFile( new URL( `../worlds/island/assets/${village.assetId.slice( 'sha256:'.length )}`, import.meta.url ) ) );
assert.equal( `sha256:${createHash( 'sha256' ).update( bytes ).digest( 'hex' )}`, village.assetId );
const materialComponent = source.components.find( component => component.type === 'tidewater.village-materials/2' );
assert.ok( materialComponent, 'the island package must include its portable village maps' );
const materialBytes = new Uint8Array( await readFile( new URL( `../worlds/island/assets/${materialComponent.dataAssetId.slice( 'sha256:'.length )}`, import.meta.url ) ) );
assert.equal( `sha256:${createHash( 'sha256' ).update( materialBytes ).digest( 'hex' )}`, materialComponent.dataAssetId );
const previewBytes = new Uint8Array( await readFile( new URL( `../worlds/island/assets/${previewObject.assetId.slice( 'sha256:'.length )}`, import.meta.url ) ) );
const materialData = await decodeVillageMaterialAsset( materialBytes );
await GPU.init( { headless: true } );
const materials = Object.fromEntries( VILLAGE_MATERIAL_ROLES.map( role => [ role, { name: role, userData: {}, dispose() { this.disposed = true; } } ] ) );
const materialContext = { materials, textures: { bake() {} } };
const assetIndex = [
	{ id: village.assetId, kind: 'glb', bytes: bytes.byteLength, priority: village.priority },
	{ id: previewObject.assetId, kind: 'glb', bytes: previewBytes.byteLength, priority: previewObject.priority },
	{ id: materialComponent.dataAssetId, kind: 'village-materials/1', bytes: materialBytes.byteLength, priority: materialComponent.priority },
];
const makeConnector = requiredFeatures => ( {
	worldId: source.worldId, manifest: { ...source, rules: { ...source.rules, requiredFeatures }, portals: [], assets: assetIndex },
	assets: new Map( [ [ village.assetId, bytes ], [ previewObject.assetId, previewBytes ], [ materialComponent.dataAssetId, materialBytes ] ] ),
	getAsset: async id => id === village.assetId ? bytes : id === previewObject.assetId ? previewBytes : id === materialComponent.dataAssetId ? materialBytes : null,
} );

let previewMapReads = 0;
const previewConnector = makeConnector( source.rules.requiredFeatures );
const previewGetAsset = previewConnector.getAsset;
previewConnector.getAsset = async id => {
	if ( id === materialComponent.dataAssetId ) previewMapReads ++;
	return previewGetAsset( id );
};
const previewRoot = await loadWorldPackage( previewConnector, { objectIDs: [ previewObject.id ], assets: new Map( [ [ previewObject.assetId, previewBytes ] ] ), materialContext } );
assert.equal( previewMapReads, 0, 'a portal preview must not fetch the village texture bundle' );
disposeWorldPackage( previewRoot );

await assert.rejects( loadWorldPackage( makeConnector( source.rules.requiredFeatures.filter( feature => feature !== 'tidewater.village-materials/1' ) ), { objectIDs: [ village.id ], assets: new Map( [ [ village.assetId, bytes ] ] ), materialContext } ), /missing tidewater.village-materials\/1/ );
const root = await loadWorldPackage( makeConnector( source.rules.requiredFeatures ), { objectIDs: [ village.id ], assets: new Map( [ [ village.assetId, bytes ] ] ), materialContext } );
const meshes = [];
root.traverse( object => { if ( object.isMesh ) meshes.push( object ); } );
assert.ok( meshes.length >= VILLAGE_MATERIAL_ROLES.length );
const roles = new Set();
for ( const mesh of meshes ) {
	if ( ! mesh.material.userData?.borrowedWorldMaterial ) continue;
	assert.ok( mesh.geometry.getAttribute( 'vdata' )?.itemSize === 4 );
	assert.ok( mesh.geometry.getAttribute( 'color' )?.itemSize === 3 );
	assert.equal( mesh.geometry.getAttribute( 'tint' ), mesh.geometry.getAttribute( 'color' ), 'the original village shader consumes COLOR_0 as tint' );
	assert.ok( mesh.geometry.getAttribute( 'tint' ).array.some( value => value > 0 ), 'tint values must be uploaded instead of the shader default' );
	assert.ok( mesh.onBeforeRender );
	mesh.onBeforeRender();
	const roleName = mesh.material.name.replace( /^Village/, '' );
	roles.add( roleName[ 0 ].toLowerCase() + roleName.slice( 1 ) );
}
assert.deepEqual( roles, new Set( VILLAGE_MATERIAL_ROLES ) );
const ownedContext = root.userData.worldPackage.ownedMaterialContext;
assert.ok( ownedContext?.textures?.baked, 'the renderer must use packaged maps instead of re-baking hidden project state' );
const map = await readTexture( ownedContext.textures.textures.woodA );
assert.deepEqual( new Uint8Array( map.data ), materialData.maps.woodA, 'the GPU texture must match the packaged level-zero bytes' );
disposeWorldPackage( root );
assert.ok( Object.values( materials ).every( material => ! material.disposed ), 'package cleanup must preserve App-owned procedural materials' );
GPU.device.destroy();
console.log( 'Hosted island uses packaged village maps with trusted shaders and preserves original vertex parameters' );
