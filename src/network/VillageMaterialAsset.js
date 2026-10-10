const OUTER_MAGIC = new TextEncoder().encode( 'EMVLG1\0\0' );
const INNER_MAGIC = new TextEncoder().encode( 'EVLGMA1\0' );
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export const VILLAGE_MATERIAL_RENDERER_PROFILE = 'original-tidewater-village-v1';
export const VILLAGE_MATERIAL_MAPS = Object.freeze( [
	{ name: 'woodA', width: 1024, height: 1024, tileMeters: [ 2, 1 ], channels: [ 'weathered-albedo', 'paint-chip-mask' ] },
	{ name: 'woodN', width: 1024, height: 1024, tileMeters: [ 2, 1 ], channels: [ 'normal-x', 'normal-y', 'roughness', 'ambient-occlusion' ] },
	{ name: 'paintN', width: 512, height: 512, tileMeters: [ 1, 0.5 ], channels: [ 'normal-x', 'normal-y', 'roughness', 'ambient-occlusion' ] },
	{ name: 'roofA', width: 512, height: 1024, tileMeters: [ 0.84, 1.68 ], channels: [ 'rust', 'rust-variation', 'fade', 'grime' ] },
	{ name: 'roofN', width: 512, height: 1024, tileMeters: [ 0.84, 1.68 ], channels: [ 'normal-x', 'normal-y', 'roughness', 'ambient-occlusion' ] },
	{ name: 'thatchA', width: 1024, height: 1024, tileMeters: [ 1, 1 ], channels: [ 'albedo', 'albedo', 'albedo', 'tip-mask' ] },
	{ name: 'thatchN', width: 1024, height: 1024, tileMeters: [ 1, 1 ], channels: [ 'normal-x', 'normal-y', 'roughness', 'ambient-occlusion' ] },
	{ name: 'stoneA', width: 1024, height: 1024, tileMeters: [ 2, 2 ], channels: [ 'albedo', 'albedo', 'albedo', 'plaster-mask' ] },
	{ name: 'stoneN', width: 1024, height: 1024, tileMeters: [ 2, 2 ], channels: [ 'normal-x', 'normal-y', 'roughness', 'ambient-occlusion' ] },
	{ name: 'hardA', width: 512, height: 512, tileMeters: [ 1, 1 ], channels: [ 'rust', 'scratch', 'grime', 'unused' ] },
	{ name: 'hardN', width: 512, height: 512, tileMeters: [ 1, 1 ], channels: [ 'normal-x', 'normal-y', 'roughness', 'ambient-occlusion' ] },
	{ name: 'grime', width: 512, height: 512, tileMeters: [ 2, 2 ], channels: [ 'streaks', 'salt', 'spots', 'macro-variation' ] },
	{ name: 'rope', width: 256, height: 256, tileMeters: [ 1, 1 ], channels: [ 'shade', 'occlusion', 'normal-x', 'normal-y' ] },
	{ name: 'net', width: 256, height: 256, tileMeters: [ 0.2, 0.2 ], channels: [ 'alpha', 'shade', 'normal-x', 'normal-y' ] },
] );

export function encodeVillageMaterialAsset( maps ) {
	const descriptors = [];
	let byteLength = 0;
	for ( const spec of VILLAGE_MATERIAL_MAPS ) {
		const data = maps?.[ spec.name ];
		if ( !( data instanceof Uint8Array ) || data.byteLength !== spec.width * spec.height * 4 ) throw new Error( `Village material map ${spec.name} has invalid dimensions or encoding` );
		descriptors.push( { ...spec, offset: byteLength, byteLength: data.byteLength } );
		byteLength += data.byteLength;
	}
	const metadata = new TextEncoder().encode( JSON.stringify( {
		protocol: 'tidewater.village-material-data/1', rendererProfile: VILLAGE_MATERIAL_RENDERER_PROFILE,
		format: 'rgba8unorm', mipmaps: 'client-box-filter-v1', sampler: 'repeat-trilinear-anisotropy-8', maps: descriptors,
	} ) );
	const payloadOffset = align4( 12 + metadata.length );
	if ( payloadOffset + byteLength > MAX_UNCOMPRESSED_BYTES ) throw new Error( 'Village material maps exceed the uncompressed asset limit' );
	const raw = new Uint8Array( payloadOffset + byteLength );
	raw.set( INNER_MAGIC );
	new DataView( raw.buffer ).setUint32( 8, metadata.length, true );
	raw.set( metadata, 12 );
	for ( let i = 0; i < descriptors.length; i ++ ) raw.set( maps[ descriptors[ i ].name ], payloadOffset + descriptors[ i ].offset );
	return raw;
}

export async function decodeVillageMaterialAsset( compressed ) {
	const bytes = compressed instanceof Uint8Array ? compressed : new Uint8Array( compressed );
	if ( bytes.length < 17 || ! matches( bytes, OUTER_MAGIC, 0 ) ) throw new Error( 'Invalid village material asset header' );
	const header = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	if ( header.getUint32( 8, true ) !== 1 ) throw new Error( 'Unsupported village material asset version' );
	const expectedBytes = header.getUint32( 12, true );
	if ( expectedBytes < 16 || expectedBytes > MAX_UNCOMPRESSED_BYTES ) throw new Error( 'Village material asset has an invalid expanded size' );
	if ( typeof DecompressionStream !== 'function' ) throw new Error( 'This browser cannot decompress village material assets' );
	const stream = new Blob( [ bytes.subarray( 16 ) ] ).stream().pipeThrough( new DecompressionStream( 'deflate' ) );
	const reader = stream.getReader();
	const raw = new Uint8Array( expectedBytes );
	let expandedBytes = 0;
	while ( true ) {
		const { value, done } = await reader.read();
		if ( done ) break;
		if ( expandedBytes + value.length > expectedBytes ) {
			await reader.cancel();
			throw new Error( 'Village material asset expanded beyond its declared size' );
		}
		raw.set( value, expandedBytes );
		expandedBytes += value.length;
	}
	if ( expandedBytes !== expectedBytes || ! matches( raw, INNER_MAGIC, 0 ) ) throw new Error( 'Village material asset payload is incomplete or invalid' );
	const metadataLength = new DataView( raw.buffer ).getUint32( 8, true );
	if ( metadataLength < 2 || metadataLength > 16384 || 12 + metadataLength > raw.length ) throw new Error( 'Invalid village material metadata length' );
	let metadata;
	try { metadata = JSON.parse( new TextDecoder().decode( raw.subarray( 12, 12 + metadataLength ) ) ); }
	catch { throw new Error( 'Invalid village material metadata' ); }
	if ( metadata.protocol !== 'tidewater.village-material-data/1' || metadata.rendererProfile !== VILLAGE_MATERIAL_RENDERER_PROFILE || metadata.format !== 'rgba8unorm' || metadata.mipmaps !== 'client-box-filter-v1' || metadata.sampler !== 'repeat-trilinear-anisotropy-8' || !Array.isArray( metadata.maps ) || metadata.maps.length !== VILLAGE_MATERIAL_MAPS.length ) throw new Error( 'Unsupported village material data profile' );
	let payloadOffset = align4( 12 + metadataLength );
	const maps = {};
	for ( let i = 0; i < VILLAGE_MATERIAL_MAPS.length; i ++ ) {
		const spec = VILLAGE_MATERIAL_MAPS[ i ];
		const actual = metadata.maps[ i ];
		if ( actual.name !== spec.name || actual.width !== spec.width || actual.height !== spec.height || actual.byteLength !== spec.width * spec.height * 4 || actual.offset !== ( i ? metadata.maps[ i - 1 ].offset + metadata.maps[ i - 1 ].byteLength : 0 ) || JSON.stringify( actual.tileMeters ) !== JSON.stringify( spec.tileMeters ) || JSON.stringify( actual.channels ) !== JSON.stringify( spec.channels ) ) throw new Error( `Village material map metadata is invalid for ${spec.name}` );
		maps[ spec.name ] = raw.subarray( payloadOffset + actual.offset, payloadOffset + actual.offset + actual.byteLength );
	}
	if ( payloadOffset + metadata.maps.reduce( ( n, map ) => n + map.byteLength, 0 ) !== raw.length ) throw new Error( 'Village material maps do not match their declared payload size' );
	return { maps, metadata };
}

export function wrapCompressedVillageMaterialAsset( raw, deflate ) {
	if ( !( raw instanceof Uint8Array ) || typeof deflate !== 'function' ) throw new Error( 'Village material compression requires raw bytes and a deflater' );
	const compressed = deflate( raw );
	const result = new Uint8Array( 16 + compressed.byteLength );
	result.set( OUTER_MAGIC );
	const view = new DataView( result.buffer );
	view.setUint32( 8, 1, true ); view.setUint32( 12, raw.byteLength, true );
	result.set( compressed, 16 );
	return result;
}

function align4( value ) { return ( value + 3 ) & ~3; }
function matches( bytes, signature, offset ) {
	if ( bytes.length < offset + signature.length ) return false;
	for ( let i = 0; i < signature.length; i ++ ) if ( bytes[ offset + i ] !== signature[ i ] ) return false;
	return true;
}
