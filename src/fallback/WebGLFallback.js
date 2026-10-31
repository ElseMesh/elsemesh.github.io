import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ISLAND_DEFINITION as WORLD } from '../world/IslandDefinition.js';
import { computeShoreField } from '../world/ShoreField.js';
import { WorldConnector, worldLinkFromLocation } from '../network/WorldConnector.js';
import { makePresencePose } from '../network/WorldPresenceSession.js';
import { DEFAULT_APPEARANCE } from '../player/AvatarAppearance.js';
import { Input } from '../core/Input.js';
import { Player } from '../player/Player.js';
import { Vector3 as EngineVector3 } from '../engine/index.js';
import { cameraPoseFromSearch } from '../core/DebugViews.js';
import { portalRouteFromPosition } from '../network/PortalHandoff.js';
import { appendVegetationPlacements, decodeVegetationPlacements } from '../network/VegetationPlacements.js';
import { decodeGrassDensityAsset } from '../network/GrassDensityAsset.js';
import { decodeTerrainSurfaceAsset } from '../network/TerrainSurfaceAsset.js';
import { decodeWorldComponentAsset } from '../network/WorldComponentAssetCodecRegistry.js';
import { decodeReefPlacements } from '../network/ReefPlacements.js';
import { LODLoadQueue, WorldObjectLOD } from '../network/WorldObjectLOD.js';
import { buildPalmFar, buildTreeNear, buildShrubNear, buildYoungPalm, buildFern, buildBanana, buildMonstera, buildElephantEar, buildHeliconia, buildStrelitzia, TREE_LOBES } from '../world/vegetation/PlantGeometry.js';
import { getDetailImage } from '../world/terrain/DetailTextures.js';
import { makeFoamLaceData } from '../ocean/FoamLaceData.js';
import { WebGLBoatAdapter } from './WebGLBoatAdapter.js';
import { WebGLWaterQuery } from './WebGLWaterQuery.js';
import { webglLightingForTime } from './WebGLLighting.js';
import { createWorldBehaviorExtensions, dispatchWorldBehaviorHooks } from '../network/WorldBehaviorRegistry.js';
import { WebGLWildlifeAdapter } from './WebGLWildlifeAdapter.js';
import { WebGLSwashProbe } from './WebGLSwashProbe.js';
import { webglSandShoreBounds, webglShoreFieldTexture as encodeWebGLShoreField } from './WebGLShoreField.js';
import { WebGLReefAdapter } from './WebGLReefAdapter.js';
import { WebGLSpray } from './WebGLSpray.js';
import { applyWebGLVillageMaterials, createWebGLVillageMaterials } from './WebGLVillageMaterials.js';
import { Whale } from '../world/marine/Whale.js';
import { hostedCollisionBoxes, initialHostedWebGLSupport, resolveHostedWebGLVehicleSpec, unsupportedHostedWebGLComponents } from './WebGLComponentSupport.js';
import { worldComponentDescriptor } from '../network/WorldComponentRegistry.js';
import { worldComponentBackendAdapter } from '../network/WorldComponentBackendRegistry.js';
import { WildlifeSimulation, DEFAULT_WILDLIFE_ENVIRONMENT } from '../world/wildlife/WildlifeSimulation.js';
import { SHORE_BEACH_SLOPE, SHORE_SWASH_UP, SHORE_SWASH_DOWN, SHORE_DEFAULT_PERIOD, SHORE_DEFAULT_AMPLITUDE, SHORE_DEFAULT_VARIATION } from '../ocean/ShoreSwash.js';
import { pierWalkableHeightAt } from '../world/PierSurface.js';
import { mulberry32 } from '../util/Noise.js';
import { HeightfieldTerrainData } from '../world/HeightfieldTerrainData.js';
import { worldComponentRuntimeRecord, worldEntryPointPose, worldSpawnPose } from '../network/WorldSource.js';
import { selectWorldComponentsForView, selectWorldObjectsForView, transformBoundsCenter } from '../network/WorldStreaming.js';
import { collisionLookaheadDistance } from '../network/CollisionFrontier.js';
import { selectLocalRegionStartupObjects } from '../network/LocalRegionStartup.js';
import { registerWorldPackageCollisionPayload } from '../network/WorldPackage.js';
import { chooseWorldEntryPoint } from '../ui/WorldEntryPointPicker.js';

const LOCAL_REGION_STREAM_BATCH_SIZE = 1;

let sharedFoamLaceTexture;

function asBytes( bytes ) {
	return bytes instanceof Uint8Array ? bytes : new Uint8Array( bytes );
}

function prepareHostedWebGLModel( root ) {
	root.traverse( object => {
		if ( ! object.isMesh ) return;
		object.castShadow = true;
		object.receiveShadow = true;
		const wasArray = Array.isArray( object.material );
		const materials = ( wasArray ? object.material : [ object.material ] ).map( material => {
			if ( ! material ) return material;
			const instance = material.clone();
			if ( /(?:^| )(?:wood|sign-wood|lantern-wood)$/i.test( instance.name ) ) instance.color.set( 0x80532f );
			return instance;
		} );
		object.material = wasArray ? materials : materials[ 0 ];
	} );
}

function disposeHostedWebGLModel( model ) {
	const geometries = new Set(), materials = new Set(), textures = new Set();
	model?.scene?.traverse( object => {
		if ( object.geometry?.dispose ) geometries.add( object.geometry );
		for ( const material of Array.isArray( object.material ) ? object.material : [ object.material ] ) {
			if ( ! material ) continue;
			materials.add( material );
			for ( const value of Object.values( material ) ) {
				if ( value?.isTexture ) textures.add( value );
				else if ( Array.isArray( value ) ) for ( const item of value ) if ( item?.isTexture ) textures.add( item );
			}
		}
	} );
	for ( const geometry of geometries ) geometry.dispose();
	for ( const material of materials ) material.dispose();
	for ( const texture of textures ) texture.dispose();
}

function applyHostedTerrainMaterial( root, material ) {
	root.traverse( object => {
		if ( ! object.isMesh ) return;
		object.receiveShadow = true;
		object.material = Array.isArray( object.material ) ? object.material.map( () => material.clone() ) : material.clone();
	} );
}

function webglFoamLaceTexture( T, size = 512 ) {

	if ( sharedFoamLaceTexture ) return sharedFoamLaceTexture;
	const texture = new T.DataTexture( makeFoamLaceData( size ), size, size, T.RGBAFormat, T.UnsignedByteType );
	texture.wrapS = texture.wrapT = T.RepeatWrapping;
	texture.magFilter = T.LinearFilter;
	texture.minFilter = T.LinearMipmapLinearFilter;
	texture.generateMipmaps = true;
	texture.needsUpdate = true;
	sharedFoamLaceTexture = texture;
	return texture;

}

function webglCloudNoiseTexture( T, size = 512 ) {

	const data = new Uint8Array( size * size * 4 ), channels = [ [ 32, 17 ], [ 40, 29 ], [ 48, 43 ], [ 64, 61 ] ];
	const fade = t => t * t * t * ( t * ( t * 6 - 15 ) + 10 );
	for ( let c = 0; c < 4; c ++ ) {

		const [ frequency, seed ] = channels[ c ], rand = mulberry32( seed ), octaves = [];
		for ( let o = 0; o < 3; o ++ ) {
			const n = frequency << o, gradients = new Float32Array( n * n * 2 );
			for ( let i = 0; i < n * n; i ++ ) {
				const angle = rand() * Math.PI * 2;
				gradients[ i * 2 ] = Math.cos( angle ); gradients[ i * 2 + 1 ] = Math.sin( angle );
			}
			octaves.push( { n, gradients } );
		}

		const values = new Float32Array( size * size );
		let min = Infinity, max = - Infinity;
		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {
			let value = 0, amplitude = 1, weight = 0;
			for ( const { n, gradients } of octaves ) {
				const px = x / size * n, py = y / size * n, ix = Math.floor( px ), iy = Math.floor( py ), fx = px - ix, fy = py - iy;
				const at = ( gx, gy, dx, dy ) => {
					const index = ( ( ( gy % n ) + n ) % n ) * n + ( ( ( gx % n ) + n ) % n );
					return gradients[ index * 2 ] * dx + gradients[ index * 2 + 1 ] * dy;
				};
				const u = fade( fx ), v = fade( fy );
				const a = at( ix, iy, fx, fy ) * ( 1 - u ) + at( ix + 1, iy, fx - 1, fy ) * u;
				const b = at( ix, iy + 1, fx, fy - 1 ) * ( 1 - u ) + at( ix + 1, iy + 1, fx - 1, fy - 1 ) * u;
				value += ( a * ( 1 - v ) + b * v ) * amplitude;
				weight += amplitude; amplitude *= 0.5;
			}
			value /= weight;
			values[ y * size + x ] = value;
			min = Math.min( min, value ); max = Math.max( max, value );
		}
		for ( let i = 0; i < values.length; i ++ ) data[ i * 4 + c ] = Math.round( ( values[ i ] - min ) / ( max - min ) * 255 );

	}
	const texture = new T.DataTexture( data, size, size, T.RGBAFormat, T.UnsignedByteType );
	texture.wrapS = texture.wrapT = T.RepeatWrapping;
	texture.magFilter = T.LinearFilter;
	texture.minFilter = T.LinearMipmapLinearFilter;
	texture.generateMipmaps = true;
	texture.needsUpdate = true;
	return texture;

}

function webglCloudVolumeTexture( T, size = 64 ) {

	const data = new Uint8Array( size * size * size * 4 ), channels = [ [ 4, 73 ], [ 5, 131 ], [ 6, 197 ], [ 8, 251 ] ];
	const fade = t => t * t * t * ( t * ( t * 6 - 15 ) + 10 );
	for ( let c = 0; c < 4; c ++ ) {

		const [ frequency, seed ] = channels[ c ], rand = mulberry32( seed ), octaves = [];
		for ( let o = 0; o < 2; o ++ ) {
			const n = frequency << o, gradients = new Float32Array( n * n * n * 3 );
			for ( let i = 0; i < n * n * n; i ++ ) {
				const z = rand() * 2 - 1, angle = rand() * Math.PI * 2, radius = Math.sqrt( 1 - z * z );
				gradients[ i * 3 ] = Math.cos( angle ) * radius;
				gradients[ i * 3 + 1 ] = Math.sin( angle ) * radius;
				gradients[ i * 3 + 2 ] = z;
			}
			octaves.push( { n, gradients } );
		}

		const values = new Float32Array( size * size * size );
		let min = Infinity, max = - Infinity;
		for ( let z = 0; z < size; z ++ ) for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {
			let value = 0, amplitude = 1, weight = 0;
			for ( const { n, gradients } of octaves ) {
				const px = x / size * n, py = y / size * n, pz = z / size * n;
				const ix = Math.floor( px ), iy = Math.floor( py ), iz = Math.floor( pz );
				const fx = px - ix, fy = py - iy, fz = pz - iz, u = fade( fx ), v = fade( fy ), w = fade( fz );
				const at = ( gx, gy, gz, dx, dy, dz ) => {
					const index = ( ( ( ( gz % n ) + n ) % n ) * n * n + ( ( ( gy % n ) + n ) % n ) * n + ( ( ( gx % n ) + n ) % n ) ) * 3;
					return gradients[ index ] * dx + gradients[ index + 1 ] * dy + gradients[ index + 2 ] * dz;
				};
				const x00 = at( ix, iy, iz, fx, fy, fz ) * ( 1 - u ) + at( ix + 1, iy, iz, fx - 1, fy, fz ) * u;
				const x10 = at( ix, iy + 1, iz, fx, fy - 1, fz ) * ( 1 - u ) + at( ix + 1, iy + 1, iz, fx - 1, fy - 1, fz ) * u;
				const x01 = at( ix, iy, iz + 1, fx, fy, fz - 1 ) * ( 1 - u ) + at( ix + 1, iy, iz + 1, fx - 1, fy, fz - 1 ) * u;
				const x11 = at( ix, iy + 1, iz + 1, fx, fy - 1, fz - 1 ) * ( 1 - u ) + at( ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1 ) * u;
				const y0 = x00 * ( 1 - v ) + x10 * v, y1 = x01 * ( 1 - v ) + x11 * v;
				value += ( y0 * ( 1 - w ) + y1 * w ) * amplitude;
				weight += amplitude; amplitude *= 0.5;
			}
			value /= weight;
			const index = ( z * size * size + y * size + x );
			values[ index ] = value;
			min = Math.min( min, value ); max = Math.max( max, value );
		}
		for ( let i = 0; i < values.length; i ++ ) data[ i * 4 + c ] = Math.round( ( values[ i ] - min ) / ( max - min ) * 255 );

	}

	const texture = new T.Data3DTexture( data, size, size, size );
	texture.format = T.RGBAFormat;
	texture.type = T.UnsignedByteType;
	texture.wrapS = texture.wrapT = texture.wrapR = T.RepeatWrapping;
	texture.magFilter = T.LinearFilter;
	texture.minFilter = T.LinearMipmapLinearFilter;
	texture.unpackAlignment = 1;
	texture.generateMipmaps = true;
	texture.needsUpdate = true;
	return texture;

}

function prepareWebGLLODFade( root ) {

	const clones = new Map();
	root.traverse( object => {
		if ( ! object.isMesh || ! object.material ) return;
		const prepare = source => {
			let material = clones.get( source );
			if ( material ) return material;
			material = source.clone();
			material.alphaHash = true;
			material.userData.elsemeshLODFade = { value: 1 };
			material.onBeforeCompile = shader => {
				shader.uniforms.elsemeshLODFade = material.userData.elsemeshLODFade;
				shader.fragmentShader = shader.fragmentShader
					.replace( 'void main() {', 'uniform float elsemeshLODFade;\nvoid main() {' )
					.replace( '#include <alphahash_fragment>', 'diffuseColor.a *= elsemeshLODFade;\n#include <alphahash_fragment>' );
			};
			material.customProgramCacheKey = () => 'elsemesh-authored-lod-fade-v1';
			clones.set( source, material );
			return material;
		};
		object.material = Array.isArray( object.material ) ? object.material.map( prepare ) : prepare( object.material );
	} );

}

function setWebGLLODFade( root, value ) {
	root.traverse( object => {
		for ( const material of Array.isArray( object.material ) ? object.material : [ object.material ] ) {
			if ( material?.userData?.elsemeshLODFade ) material.userData.elsemeshLODFade.value = value;
		}
	} );
}

function webglTerrainMaterial( T, terrain, packagedSurface = null ) {

	const resolution = 1024, pixels = new Uint8Array( resolution * resolution * 4 ), step = terrain.res / resolution;
	const smooth = ( a, b, x ) => { const t = T.MathUtils.clamp( ( x - a ) / ( b - a ), 0, 1 ); return t * t * ( 3 - 2 * t ); };
	const linear = c => c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );
	const mix = ( a, b, t ) => a.map( ( c, i ) => c + ( b[ i ] - c ) * t );
	const palette = Object.fromEntries( Object.entries( {
		lush: [ 0.13, 0.2, 0.05 ], green: [ 0.25, 0.32, 0.1 ], olive: [ 0.36, 0.37, 0.14 ],
		yellow: [ 0.5, 0.46, 0.2 ], straw: [ 0.62, 0.54, 0.33 ], soil: [ 0.17, 0.13, 0.08 ],
		sand: [ 0.84, 0.77, 0.64 ], seabed: [ 0.72, 0.7, 0.58 ], rock: [ 0.3, 0.285, 0.265 ],
	} ).map( ( [ name, color ] ) => [ name, color.map( linear ) ] ) );
	const { noise, noise2 } = terrain;
	const samplePackagedFbm = ( x, z, scale ) => {
		const width = packagedSurface.detailWidth, height = packagedSurface.detailHeight, data = packagedSurface.detail;
		const u = ( ( x / scale % 1 ) + 1 ) % 1, v = ( ( z / scale % 1 ) + 1 ) % 1;
		const index = ( Math.floor( v * height ) * width + Math.floor( u * width ) ) * 4 + 3;
		return data[ index ] / 255;
	};
	const meadow = packagedSurface?.metadata.material.meadowLinear;
	if ( meadow ) for ( const key of Object.keys( meadow ) ) palette[ key ] = meadow[ key ];
	for ( let j = 0; j < resolution; j ++ ) {
		const sourceJ = Math.min( terrain.res - 1, Math.floor( ( j + 0.5 ) * step ) );
		for ( let i = 0; i < resolution; i ++ ) {
			const sourceI = Math.min( terrain.res - 1, Math.floor( ( i + 0.5 ) * step ) ), source = sourceJ * terrain.res + sourceI, out = ( j * resolution + i ) * 4;
			const h = terrain.heights[ source ], x = terrain.origin + ( sourceI + 0.5 ) * terrain.texel, z = terrain.origin + ( sourceJ + 0.5 ) * terrain.texel;
			const row = sourceJ * terrain.res, west = Math.max( 0, sourceI - 1 ), east = Math.min( terrain.res - 1, sourceI + 1 );
			const north = Math.max( 0, sourceJ - 1 ) * terrain.res + sourceI, south = Math.min( terrain.res - 1, sourceJ + 1 ) * terrain.res + sourceI;
			const hx = ( terrain.heights[ row + east ] - terrain.heights[ row + west ] ) / ( Math.max( 1, east - west ) * terrain.texel );
			const hz = ( terrain.heights[ south ] - terrain.heights[ north ] ) / ( Math.max( 1, Math.min( terrain.res - 1, sourceJ + 1 ) - Math.max( 0, sourceJ - 1 ) ) * terrain.texel );
			let slope = 1 - 1 / Math.sqrt( hx * hx + 1 + hz * hz ), southFacing = - hz / Math.sqrt( hx * hx + 1 + hz * hz );
			let macroA, macroB, detail;
			if ( packagedSurface ) {
				const normalOffset = source * 4, nx = packagedSurface.normal[ normalOffset ] / 127.5 - 1, nz = packagedSurface.normal[ normalOffset + 1 ] / 127.5 - 1;
				slope = 1 - Math.sqrt( Math.max( 0, 1 - nx * nx - nz * nz ) );
				southFacing = nz;
				macroA = samplePackagedFbm( x * 0.765 + z * 0.644, - x * 0.644 + z * 0.765, 173 );
				macroB = samplePackagedFbm( x * - 0.505 + z * 0.863, - x * 0.863 - z * 0.505, 47 );
				detail = T.MathUtils.clamp( samplePackagedFbm( x, z, 6.7 ) * 0.6 + samplePackagedFbm( x, z, 1.9 ) * 0.4, 0, 1 );
			} else {
				macroA = 0.5 + noise.noise( ( x * 0.765 + z * 0.644 ) / 173, ( - x * 0.644 + z * 0.765 ) / 173 ) * 0.1;
				macroB = 0.5 + noise2.noise( ( x * - 0.505 + z * 0.863 ) / 47, ( - x * 0.863 - z * 0.505 ) / 47 ) * 0.1;
				detail = T.MathUtils.clamp( 0.5 + noise.noise( x / 6.7, z / 6.7 ) * 0.1 + noise2.noise( x / 1.9, z / 1.9 ) * 0.06, 0, 1 );
			}
			const dry = macroA * 0.55 + macroB * 0.45 + slope * 0.25 + southFacing * 0.04 + ( detail - 0.5 ) * 0.28;
			const olive = smooth( 0.52, 0.6, dry ), yellow = smooth( 0.6, 0.67, dry );
			const straw = smooth( 0.66, 0.73, dry + ( macroB - 0.5 ) * 0.2 );
			const lush = smooth( 0.46, 0.37, macroB * 0.7 + macroA * 0.3 + slope * 0.2 + ( detail - 0.5 ) * 0.2 );
			let color = mix( palette.green, palette.olive, olive );
			color = mix( color, palette.yellow, yellow * 0.8 );
			color = mix( color, palette.straw, straw * 0.55 );
			color = mix( color, palette.lush, lush * 0.75 );
			const clump = detail * 0.6 + macroB * 0.4;
			color = color.map( channel => channel * ( ( clump - 0.5 ) * 0.68 + 1 ) * ( ( detail - 0.4 ) * 0.22 + 1 ) );
			const splatOffset = source * 4;
			const path = packagedSurface ? packagedSurface.splat[ splatOffset + 1 ] / 255 : terrain.path[ source ] / 255;
			const gully = packagedSurface ? packagedSurface.splat[ splatOffset + 2 ] / 255 : terrain.gully[ source ] / 255;
			const sand = packagedSurface ? packagedSurface.splat[ splatOffset ] / 255 : terrain.sand[ source ] / 255, seabed = 1 - smooth( - 22, - 3, h );
			const rock = Math.max( packagedSurface ? packagedSurface.normal[ splatOffset + 2 ] / 255 : terrain.rock[ source ], smooth( 0.34, 0.62, slope ) * smooth( 2, 30, h ) );
			color = mix( color, palette.soil, Math.max( path * 0.92, gully * ( 1 - rock ) * 0.5 ) );
			color = mix( color, palette.rock, rock );
			color = mix( color, palette.sand, sand * ( 1 - seabed ) );
			color = mix( color, palette.seabed, seabed * ( 1 - sand * 0.3 ) );
			const seabedDetail = packagedSurface ? packagedSurface.splat[ splatOffset + 2 ] / 255 : terrain.seagrass[ source ] / 255;
			const seabedRock = packagedSurface ? packagedSurface.splat[ splatOffset + 3 ] / 255 : terrain.rubble[ source ] / 255;
			color = mix( color, palette.green, seabedDetail * seabed );
			color = mix( color, palette.rock, seabedRock * seabed );
			color = mix( color, palette.rock, packagedSurface ? 0 : terrain.scarp[ source ] / 255 * 0.92 );
			if ( packagedSurface ) color = color.map( channel => channel * ( 0.82 + packagedSurface.normal[ splatOffset + 3 ] / 255 * 0.18 ) );
			pixels[ out ] = Math.round( T.MathUtils.clamp( color[ 0 ], 0, 1 ) * 255 );
			pixels[ out + 1 ] = Math.round( T.MathUtils.clamp( color[ 1 ], 0, 1 ) * 255 );
			pixels[ out + 2 ] = Math.round( T.MathUtils.clamp( color[ 2 ], 0, 1 ) * 255 );
			pixels[ out + 3 ] = packagedSurface ? packagedSurface.splat[ splatOffset ] : terrain.sand[ source ];
		}
	}
	const texture = new T.DataTexture( pixels, resolution, resolution, T.RGBAFormat, T.UnsignedByteType );
	texture.magFilter = T.LinearFilter; texture.minFilter = T.LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.needsUpdate = true;
	const detailImage = packagedSurface ? { data: packagedSurface.detail, width: packagedSurface.detailWidth, height: packagedSurface.detailHeight } : getDetailImage();
	const detailTexture = new T.DataTexture( detailImage.data, detailImage.width, detailImage.height, T.RGBAFormat, T.UnsignedByteType );
	detailTexture.wrapS = detailTexture.wrapT = T.RepeatWrapping;
	detailTexture.magFilter = T.LinearFilter; detailTexture.minFilter = T.LinearMipmapLinearFilter; detailTexture.generateMipmaps = true; detailTexture.needsUpdate = true;
	const material = new T.MeshStandardMaterial( { roughness: 0.94, side: T.DoubleSide } );
	material.onBeforeCompile = shader => {
		shader.uniforms.uTerrainColor = { value: texture };
		shader.uniforms.uTerrainDetail = { value: detailTexture };
		shader.vertexShader = shader.vertexShader.replace( '#include <common>', '#include <common>\nvarying vec3 vTerrainWorldPosition;' );
		shader.vertexShader = shader.vertexShader.replace( '#include <begin_vertex>', '#include <begin_vertex>\nvTerrainWorldPosition = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;' );
		shader.fragmentShader = shader.fragmentShader.replace( '#include <common>', `#include <common>
uniform sampler2D uTerrainColor;
uniform sampler2D uTerrainDetail;
varying vec3 vTerrainWorldPosition;
` );
		shader.fragmentShader = shader.fragmentShader.replace( '#include <color_fragment>', `#include <color_fragment>
			vec2 terrainUv = ( vTerrainWorldPosition.xz - vec2( ${ terrain.origin.toFixed( 1 ) } ) ) / ${ terrain.size.toFixed( 1 ) };
			vec4 terrainSample = texture2D( uTerrainColor, terrainUv );
			vec3 terrainBase = terrainSample.rgb;
			vec2 terrainXZ = vTerrainWorldPosition.xz;
			vec4 terrainNear = texture2D( uTerrainDetail, terrainXZ / 1.9 );
			vec4 terrainMid = texture2D( uTerrainDetail, mat2( 0.2675, 0.9636, -0.9636, 0.2675 ) * terrainXZ / 6.7 + 0.21 );
			vec4 terrainFine = texture2D( uTerrainDetail, mat2( -0.7374, 0.6755, -0.6755, -0.7374 ) * terrainXZ / 0.63 + 0.53 );
			float terrainClump = terrainMid.a * 0.6 + terrainNear.g * 0.4;
			float sandCoverage = smoothstep( 0.25, 0.8, terrainSample.a );
			float terrainDetail = mix( terrainClump, terrainNear.b * 0.55 + terrainMid.b * 0.45, sandCoverage );
			float terrainFineDetail = mix( terrainFine.g, terrainFine.b, sandCoverage );
			float terrainDistance = length( cameraPosition - vTerrainWorldPosition );
			float terrainClumpContrast = mix( 0.34, 0.95, smoothstep( 40.0, 140.0, terrainDistance ) );
			float terrainDetailContrast = mix( terrainClumpContrast, 0.85, sandCoverage );
			float wetSand = sandCoverage * ( 1.0 - smoothstep( -0.1, 0.35, vTerrainWorldPosition.y ) );
			diffuseColor.rgb = terrainBase.rgb * ( ( terrainDetail - 0.5 ) * terrainDetailContrast + 1.0 ) * ( ( terrainFineDetail - 0.4 ) * 0.24 + 1.0 ) * ( 1.0 - wetSand * 0.2 );` );
	};
	material.customProgramCacheKey = () => 'elsemesh-webgl-baked-terrain-detail-v2';
	material.userData.terrainTextures = [ texture, detailTexture ];
	return material;

}

function webglTerrainWaterTexture( T, terrain ) {

	const resolution = 1024, minHeight = - 512, maxHeight = 1536, data = new Uint8Array( resolution * resolution * 4 ), step = terrain.res / resolution;
	for ( let j = 0; j < resolution; j ++ ) for ( let i = 0; i < resolution; i ++ ) {
		const sourceJ = Math.min( terrain.res - 1, Math.floor( ( j + 0.5 ) * step ) ), sourceI = Math.min( terrain.res - 1, Math.floor( ( i + 0.5 ) * step ) ), source = sourceJ * terrain.res + sourceI, out = ( j * resolution + i ) * 4;
		const normalized = T.MathUtils.clamp( ( terrain.heights[ source ] - minHeight ) / ( maxHeight - minHeight ), 0, 1 ), height = Math.round( normalized * 65535 );
		data[ out ] = height >>> 8;
		data[ out + 1 ] = height & 255;
		data[ out + 2 ] = terrain.sand?.[ source ] ?? terrain.splat?.[ source * 4 ] ?? 0;
		data[ out + 3 ] = 255;
	}
	const texture = new T.DataTexture( data, resolution, resolution, T.RGBAFormat, T.UnsignedByteType );
	texture.wrapS = texture.wrapT = T.ClampToEdgeWrapping;
	texture.magFilter = T.LinearFilter; texture.minFilter = T.LinearFilter; texture.generateMipmaps = false; texture.needsUpdate = true;
	return { texture, minHeight, maxHeight, origin: terrain.origin, size: terrain.size };

}

function webglShoreFieldTexture( T, terrain, seaLevel ) {

	const swellLength = Math.hypot( ...WORLD.swellDir ), swell = WORLD.swellDir.map( value => value / swellLength );
	const field = computeShoreField( terrain, { res: 512, swellDir: swell, seaLevel } );
	const encoded = encodeWebGLShoreField( T, field, swell );
	return encoded ? { ...encoded, field } : null;

}

function webglBreakerSpray( T, terrain, terrainWater, seaLevel ) {

	const positions = [], seeds = [], depths = [];
	for ( let x = WORLD.beach.xMin - 25; x <= WORLD.beach.xMax + 25; x += 0.75 ) for ( let z = - 64; z <= 28; z += 0.75 ) {
		const seed = ( ( Math.sin( x * 12.9898 + z * 78.233 ) * 43758.5453 ) % 1 + 1 ) % 1;
		const jitter = salt => ( ( Math.sin( x * 39.346 + z * 11.135 + salt ) * 24634.6345 ) % 1 + 1 ) % 1;
		const px = x + ( jitter( 1.7 ) - 0.5 ) * 0.7, pz = z + ( jitter( 8.3 ) - 0.5 ) * 0.7;
		const depth = seaLevel - terrain.heightAt( px, pz );
		if ( depth <= 0.15 || depth >= 5.5 ) continue;
		positions.push( px, 0, pz );
		seeds.push( seed );
		depths.push( depth );
	}
	const geometry = new T.BufferGeometry();
	geometry.setAttribute( 'position', new T.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'aSeed', new T.Float32BufferAttribute( seeds, 1 ) );
	geometry.setAttribute( 'aDepth', new T.Float32BufferAttribute( depths, 1 ) );
	const material = new T.ShaderMaterial( {
		uniforms: {
			uTime: { value: 0 }, uCameraPosition: { value: new T.Vector3() },
			uShoreField: { value: terrainWater.shore.texture }, uShoreFieldOrigin: { value: terrainWater.shore.origin }, uShoreFieldSize: { value: terrainWater.shore.size }, uShoreTimeRange: { value: terrainWater.shore.timeRange }, uSeaLevel: { value: seaLevel },
			uTerrainHeight: { value: terrainWater.texture }, uTerrainOrigin: { value: terrainWater.origin }, uTerrainSize: { value: terrainWater.size },
			uHeightRange: { value: new T.Vector2( terrainWater.minHeight, terrainWater.maxHeight ) },
		},
		vertexShader: /* glsl */`
			uniform float uTime;
			uniform vec3 uCameraPosition;
			uniform sampler2D uShoreField;
			uniform float uShoreFieldOrigin;
			uniform float uShoreFieldSize;
			uniform vec2 uShoreTimeRange;
			uniform float uSeaLevel;
			uniform sampler2D uTerrainHeight;
			uniform float uTerrainOrigin;
			uniform float uTerrainSize;
			uniform vec2 uHeightRange;
			attribute float aSeed;
			attribute float aDepth;
			varying float vOpacity;
			void main() {
				vec3 p = position;
				vOpacity = 0.0;
				float depth = aDepth;
				if ( depth > 0.15 && depth < 5.5 ) {
					vec2 shoreUv = ( p.xz - vec2( uShoreFieldOrigin ) ) / uShoreFieldSize;
					vec4 shore = texture2D( uShoreField, shoreUv );
					vec2 dir = normalize( shore.rg * 2.0 - 1.0 );
					float exposure = shore.b;
					float along = dot( p.xz, vec2( -dir.y, dir.x ) );
					float arrival = mix( uShoreTimeRange.x, uShoreTimeRange.y, shore.a );
					float rip = smoothstep( 0.8 + sin( along * 0.017 + 4.1 ) * 0.08, 0.985, sin( along * 0.059 + sin( along * 0.021 + 1.9 ) * 1.4 + sin( along * 0.009 + 0.3 ) * 0.9 ) );
					float bar = ( 0.9 + ( sin( along * 0.031 + 7.3 ) * 0.6 + sin( along * 0.083 + 1.1 ) * 0.4 ) * 0.14 ) * ( 1.0 - rip * 0.58 );
					float phase = ( uTime - arrival ) / 9.0 + sin( along * 0.029 + 0.7 ) * 0.07 + sin( along * 0.083 + 2.1 ) * 0.035 + sin( along * 0.19 + 0.4 ) * 0.022 + sin( along * 0.37 + 2.6 ) * 0.011 + rip * 0.045;
					float index = floor( phase + 0.5 );
					float warp = sin( along * 0.016 + index * 0.9 ) * 1.6;
					float u = phase - index;
					float variation = sin( along * 0.062 + index * 1.7 + warp ) * 0.6 + sin( along * 0.13 + index * 4.1 + 1.3 - warp * 0.7 ) * 0.4;
					variation += ( sin( along * 0.29 + index * 2.3 + warp * 0.5 ) * 0.6 + sin( along * 0.47 + index * 5.9 + 0.8 ) * 0.4 ) * 0.28;
					float randomWave = fract( sin( index * 127.1 + 311.7 ) * 43758.5453 ) * 2.0 - 1.0;
					float waveSet = abs( sin( index * 0.448799 ) ) * 0.6 + 0.55;
					float amp = max( 0.34 * waveSet * ( 1.0 + randomWave * 0.275 + variation * 0.385 ) * bar, 0.02 );
					float lam = sqrt( clamp( depth, 0.3, 25.0 ) * 9.81 ) * 9.0;
					vec2 crestPosition = p.xz + dir * ( u * lam );
					vec2 crestTerrainUv = ( crestPosition - vec2( uTerrainOrigin ) ) / uTerrainSize;
					vec4 crestTerrain = texture2D( uTerrainHeight, crestTerrainUv );
					float crestEncodedHeight = ( crestTerrain.r * 255.0 * 256.0 + crestTerrain.g * 255.0 ) / 65535.0;
					float depthAtCrest = uSeaLevel - mix( uHeightRange.x, uHeightRange.y, crestEncodedHeight );
					depthAtCrest = mix( depthAtCrest, depth, smoothstep( 0.3, 0.5, abs( u ) ) );
					float breakDepth = pow( amp * 3.556 / 0.78, 0.8 );
					float breaking = ( breakDepth - depthAtCrest ) / max( breakDepth * 0.13, 0.05 );
					float impact = smoothstep( 0.86, 0.99, breaking ) * ( 1.0 - smoothstep( 1.4, 1.9, breaking ) ) * exp( -abs( u - 0.08 ) * 22.0 );
					float roller = smoothstep( 0.85, 1.35, breaking ) * exp( -abs( u + 0.08 ) * 16.0 );
					float burst = max( impact, roller * 0.12 );
					float ageJitter = aSeed * 0.12;
					float impactAge = fract( phase - 0.08 + ageJitter + 1.0 ) * 9.0;
					float rollerAge = fract( phase + 0.08 + ageJitter + 1.0 ) * 9.0;
					float age = mix( impactAge, rollerAge, step( impact, roller ) );
					float life = 0.7 + aSeed * 1.2;
					float alive = smoothstep( 0.02, 0.12, age ) * ( 1.0 - smoothstep( life * 0.65, life, age ) );
					float env = smoothstep( 26.0, 13.0, depth ) * smoothstep( -0.25, 0.05, depth ) * smoothstep( 0.02, 0.3, exposure );
					float alongDensity = mix( 0.35, 1.0, smoothstep( -0.45, 0.45, variation ) );
					vOpacity = burst * env * alongDensity * alive * ( 1.0 - age / life * 0.25 );
					float upSpeed = 2.4 + aSeed * 3.0;
					p.xz += dir * age * ( 1.0 + aSeed * 3.0 ) + vec2( -dir.y, dir.x ) * ( aSeed - 0.5 ) * age * 2.5;
					float lift = 0.08 + upSpeed * age - 4.905 * age * age;
					float shoaledAmp = amp * pow( 10.0 / clamp( depth, 0.35, 10.0 ), 0.25 );
					float sharpness = mix( 1.0, 3.0, smoothstep( -2.5, 0.0, breaking ) );
					float meanProfile = inversesqrt( ( sharpness + 0.25 ) * 3.14159265 );
					float skew = smoothstep( -3.0, 0.0, breaking ) * 0.55;
					float phaseSkew = u - skew * ( 1.0 - cos( u * 6.2831853 ) ) / 6.2831853;
					float skewCrest = max( ( cos( phaseSkew * 6.2831853 ) + 1.0 ) * 0.5, 0.0 );
					float curl = smoothstep( -3.0, 0.0, breaking );
					float preHeight = shoaledAmp * 2.0 * ( pow( skewCrest, sharpness ) - meanProfile ) * ( 1.0 + smoothstep( -1.0, 0.3, breaking ) * 0.22 );
					float bore = smoothstep( 0.85, 1.35, breaking );
					float waveHeight = shoaledAmp * 2.0 * ( 1.0 - meanProfile );
					float lipHeight = min( waveHeight * 0.6, max( depth, 0.0 ) * 0.75 ) * ( smoothstep( 0.0, 0.3, depth ) * 0.7 + 0.3 );
					float lip = smoothstep( -0.17, -0.12, u ) * ( 1.0 - smoothstep( -0.025, 0.015, u ) );
					float crestHeight = preHeight + lipHeight * bore * curl * lip;
					p.xz += dir * sin( u * 6.2831853 ) * shoaledAmp * 0.12 * env;
					float a = dot( p.xz, vec2( 0.035, 0.025 ) ) + uTime * 0.3;
					float b = dot( p.xz, vec2( -0.07, 0.15 ) ) - uTime * 0.55;
					float c = dot( p.xz, vec2( 0.21, -0.16 ) ) + uTime * 0.7;
					float d = dot( p.xz, vec2( 0.42, 0.09 ) ) + uTime * 1.3;
					float e = dot( p.xz, vec2( 0.72, -0.48 ) ) + uTime * 1.6;
					float baseWave = 0.95 * sin( a ) + 0.55 * sin( b ) + 0.08 * sin( c ) + 0.03 * sin( d ) + 0.01 * sin( e );
					p.y = uSeaLevel + baseWave + crestHeight * env + lift;
					gl_PointSize = clamp( ( 6.0 + aSeed * 12.0 ) * 120.0 / max( distance( uCameraPosition, p ), 28.0 ), 1.5, 10.0 );
				} else {
					gl_PointSize = 0.0;
				}
				gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
			}
		`,
		fragmentShader: /* glsl */`
			varying float vOpacity;
			void main() {
				float d = length( gl_PointCoord - 0.5 );
				float alpha = min( vOpacity * 2.4, 0.72 ) * exp( - d * d * 10.0 );
				if ( alpha < 0.015 ) discard;
				gl_FragColor = vec4( vec3( 0.92, 0.98, 1.0 ), alpha );
				#include <tonemapping_fragment>
				#include <colorspace_fragment>
			}
		`,
		transparent: true,
		depthWrite: false,
		depthTest: true,
		blending: T.NormalBlending,
		toneMapped: false,
	} );
	const spray = new T.Points( geometry, material );
	spray.renderOrder = 1;
	spray.frustumCulled = false;
	return spray;

}

function sampleGrassMask( mask, x, z ) {
	const fx = Math.max( 0, Math.min( mask.res - 1, ( x - mask.origin ) / ( mask.size / mask.res ) - 0.5 ) );
	const fz = Math.max( 0, Math.min( mask.res - 1, ( z - mask.origin ) / ( mask.size / mask.res ) - 0.5 ) );
	const x0 = Math.floor( fx ), z0 = Math.floor( fz ), x1 = Math.min( mask.res - 1, x0 + 1 ), z1 = Math.min( mask.res - 1, z0 + 1 );
	const tx = fx - x0, tz = fz - z0, result = [ 0, 0, 0, 0 ];
	for ( let channel = 0; channel < 4; channel ++ ) {
		const a = mask.data[ ( z0 * mask.res + x0 ) * 4 + channel ], b = mask.data[ ( z0 * mask.res + x1 ) * 4 + channel ];
		const c = mask.data[ ( z1 * mask.res + x0 ) * 4 + channel ], d = mask.data[ ( z1 * mask.res + x1 ) * 4 + channel ];
		result[ channel ] = ( ( a * ( 1 - tx ) + b * tx ) * ( 1 - tz ) + ( c * ( 1 - tx ) + d * tx ) * tz ) / 255;
	}
	return result;
}

function webglGrassMesh( T, terrain, camera, previous, grassMask = null ) {

	const radius = 42, spacing = 0.46, positions = [], colors = [], indices = [];
	const cx = camera.position.x, cz = camera.position.z, firstX = Math.floor( ( cx - radius ) / spacing ), firstZ = Math.floor( ( cz - radius ) / spacing );
	const hash = ( x, z ) => { let n = Math.imul( x, 0x1f123bb5 ) ^ Math.imul( z, 0x5f356495 ); n = Math.imul( n ^ n >>> 16, 0x7feb352d ); n = Math.imul( n ^ n >>> 15, 0x846ca68b ); return ( n ^ n >>> 16 ) >>> 0; };
	const addBlade = ( x, z, y, angle, height, width, color ) => {
		const dx = Math.cos( angle ), dz = Math.sin( angle ), bend = 0.12 + height * 0.16, sx = - dz * width, sz = dx * width, base = positions.length / 3;
		positions.push( x - sx, y, z - sz, x + sx, y, z + sz, x + dx * bend - sx * 0.3, y + height * 0.72, z + dz * bend + sz * 0.3, x + dx * bend + sx * 0.3, y + height * 0.72, z + dz * bend - sz * 0.3, x + dx * bend * 1.8, y + height, z + dz * bend * 1.8 );
		for ( let v = 0; v < 5; v ++ ) { const f = v === 4 ? 1.18 : v < 2 ? 0.76 : 1.08; colors.push( color[ 0 ] * f, color[ 1 ] * f, color[ 2 ] * f ); }
		indices.push( base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4 );
	};
	for ( let gz = firstZ; gz <= Math.ceil( ( cz + radius ) / spacing ); gz ++ ) for ( let gx = firstX; gx <= Math.ceil( ( cx + radius ) / spacing ); gx ++ ) {
		const rand = ( shift ) => ( hash( gx + shift * 31, gz - shift * 17 ) & 0xffff ) / 0xffff;
		const x = ( gx + 0.15 + rand( 1 ) * 0.7 ) * spacing, z = ( gz + 0.15 + rand( 2 ) * 0.7 ) * spacing, d = Math.hypot( x - cx, z - cz );
		const near = grassMask ? 1 : 1 - T.MathUtils.smoothstep( d, 14, 24 );
		if ( d > radius || ( ! grassMask && rand( 3 ) > 0.32 + near * 0.68 ) ) continue;
		const h = terrain.heightAt( x, z );
		if ( grassMask ) {
			const mask = sampleGrassMask( grassMask, x, z );
			const duneFraction = mask[ 0 ] / ( mask[ 0 ] + mask[ 1 ] + 1e-3 );
			const meadowDensity = mask[ 1 ] * ( 1 - duneFraction ) + Math.min( mask[ 0 ] * 1.1, 1 ) * duneFraction;
			const candidates = [
				{ density: meadowDensity, salt: 4, height: 0.62 * duneFraction + ( 0.7 + rand( 6 ) * 0.6 ) * ( 1 - duneFraction ), color: [ 0.11, 0.27, 0.09 ] },
				{ density: mask[ 2 ], salt: 20, height: 0.9 + rand( 21 ) * 0.6, color: [ 0.32, 0.34, 0.13 ] },
				{ density: mask[ 3 ], salt: 30, height: 0.18 + rand( 31 ) * 0.22, color: [ 0.16, 0.31, 0.12 ] },
			];
			for ( const candidate of candidates ) {
				if ( rand( candidate.salt ) > candidate.density ) continue;
				const baseAngle = rand( candidate.salt + 1 ) * Math.PI * 2, tone = rand( candidate.salt + 2 );
				const color = candidate.color.map( ( channel, index ) => channel + tone * [ 0.06, 0.08, 0.035 ][ index ] );
				const blades = candidate.salt === 20 ? 2 : Math.round( 3 + near * 2 );
				for ( let blade = 0; blade < blades; blade ++ ) addBlade( x, z, h + 0.025, baseAngle + blade * Math.PI * 2 / blades + rand( blade + candidate.salt + 3 ) * 0.18, candidate.height * ( 0.82 + rand( blade + candidate.salt + 4 ) * 0.32 ), candidate.salt === 30 ? 0.012 : 0.018 + rand( blade + candidate.salt + 5 ) * 0.009, color );
			}
			continue;
		}
		const terrainIndex = Math.max( 0, Math.min( terrain.res - 1, Math.floor( ( z - terrain.origin ) / terrain.texel ) ) ) * terrain.res + Math.max( 0, Math.min( terrain.res - 1, Math.floor( ( x - terrain.origin ) / terrain.texel ) ) );
		const sand = terrain.sand[ terrainIndex ], dune = sand > 86 && h > 2.15 && h < 6.5 && x > - 180 && x < 200 && z > - 260 && z < 0;
		if ( h < ( dune ? 2.15 : 2.6 ) || h > ( dune ? 6.5 : 76 ) || terrain.rock[ terrainIndex ] > 0.42 || terrain.path[ terrainIndex ] > 72 || ( sand > 86 && ! dune ) ) continue;
		const patch = dune ? terrain.noise2.noise( x / 4.2 + 5.5, z / 4.2 - 3.3 ) * 0.6 + terrain.noise.noise( x / 11 - 7.1, z / 11 + 1.9 ) * 0.4 : 1;
		const clump = dune ? T.MathUtils.smoothstep( patch, - 0.45, 0.25 ) : 1;
		const density = Math.min( 1, Math.max( 0.08, ( 1 - ( d / radius ) ** 3 ) * ( dune ? 0.95 * clump : 1.25 ) ));
		if ( rand( 4 ) > density ) continue;
		const baseAngle = rand( 5 ) * Math.PI * 2, height = dune ? 0.24 + rand( 6 ) * 0.38 : 0.38 + rand( 6 ) * 0.48, tone = rand( 7 ), blades = Math.round( 3 + near * 2 );
		const color = [ 0.12 + tone * 0.07, 0.25 + tone * 0.1, 0.075 + tone * 0.035 ];
		for ( let blade = 0; blade < blades; blade ++ ) addBlade( x, z, h + 0.025, baseAngle + blade * Math.PI * 2 / blades + rand( blade + 8 ) * 0.18, height * ( 0.82 + rand( blade + 11 ) * 0.32 ), 0.018 + rand( blade + 14 ) * 0.009, color );
	}
	const geometry = new T.BufferGeometry();
	geometry.setAttribute( 'position', new T.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'color', new T.Float32BufferAttribute( colors, 3 ) );
	geometry.setIndex( indices ); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
	const mesh = new T.Mesh( geometry, new T.MeshLambertMaterial( { vertexColors: true, side: T.DoubleSide } ) );
	mesh.name = 'WebGL camera-following grass'; mesh.frustumCulled = false; mesh.renderOrder = 1;
	if ( previous ) { previous.geometry.dispose(); previous.material.dispose(); }
	return mesh;

}

function webglBeachDebris( T, terrain, camera, previous ) {

	const radius = 25, spacing = 0.62, firstX = Math.floor( ( camera.position.x - radius ) / spacing ), firstZ = Math.floor( ( camera.position.z - radius ) / spacing );
	const hash = ( x, z, salt ) => {
		let n = Math.imul( x + salt * 31, 0x1f123bb5 ) ^ Math.imul( z - salt * 17, 0x5f356495 );
		n = Math.imul( n ^ n >>> 16, 0x7feb352d ); n = Math.imul( n ^ n >>> 15, 0x846ca68b );
		return ( n ^ n >>> 16 ) >>> 0;
	};
	const samples = [];
	for ( let gz = firstZ; gz <= Math.ceil( ( camera.position.z + radius ) / spacing ); gz ++ ) for ( let gx = firstX; gx <= Math.ceil( ( camera.position.x + radius ) / spacing ); gx ++ ) {
		const random = salt => hash( gx, gz, salt ) / 0xffffffff;
		const x = ( gx + 0.18 + random( 1 ) * 0.64 ) * spacing, z = ( gz + 0.18 + random( 2 ) * 0.64 ) * spacing;
		const d = Math.hypot( x - camera.position.x, z - camera.position.z );
		if ( d > radius || random( 3 ) > 0.36 + ( 1 - T.MathUtils.smoothstep( d, 12, 23 ) ) * 0.5 ) continue;
		const ix = Math.max( 0, Math.min( terrain.res - 1, Math.floor( ( x - terrain.origin ) / terrain.texel ) ) );
		const iz = Math.max( 0, Math.min( terrain.res - 1, Math.floor( ( z - terrain.origin ) / terrain.texel ) ) );
		const index = iz * terrain.res + ix, height = terrain.heightAt( x, z ), sand = terrain.sand[ index ] / 255;
		if ( height < 0.35 || height > 4.6 || sand < 0.36 || terrain.rock[ index ] > 0.24 || terrain.path[ index ] > 90 ) continue;
		const slope = Math.hypot( terrain.heightAt( x + 1, z ) - terrain.heightAt( x - 1, z ), terrain.heightAt( x, z + 1 ) - terrain.heightAt( x, z - 1 ) );
		if ( slope > 0.72 ) continue;
		const shore = 1 - T.MathUtils.smoothstep( Math.abs( height - 1.25 ), 0.18, 1.55 );
		const patch = T.MathUtils.smoothstep( terrain.noise2.noise( x / 4.2 + 5.5, z / 4.2 - 3.3 ), - 0.45, 0.25 );
		const density = ( 0.06 + shore * 0.34 ) * ( 0.5 + patch * 0.9 ) * ( 0.55 + ( 1 - T.MathUtils.smoothstep( d, 12, 23 ) ) * 0.45 );
		if ( random( 4 ) > density ) continue;
		samples.push( { x, z, height, random: [ random( 5 ), random( 6 ), random( 7 ) ] } );
	}
	const mesh = previous || new T.InstancedMesh(
		new T.IcosahedronGeometry( 1, 0 ),
		new T.MeshStandardMaterial( { color: 0xffffff, roughness: 0.94, metalness: 0, flatShading: true } ),
		8192,
	);
	const matrix = new T.Matrix4(), position = new T.Vector3(), rotation = new T.Quaternion(), scale = new T.Vector3(), euler = new T.Euler(), color = new T.Color();
	const palette = [ 0xc5b99d, 0x9e927a, 0xd4cbb5, 0x8b7561, 0xb5a88f ];
	for ( let i = 0; i < samples.length; i ++ ) {
		const sample = samples[ i ], [ size, tone, yaw ] = sample.random;
		const r = 0.035 + size * size * 0.105;
		position.set( sample.x, sample.height + r * 0.12, sample.z );
		euler.set( ( tone - 0.5 ) * 0.35, yaw * Math.PI * 2, ( size - 0.5 ) * 0.3 ); rotation.setFromEuler( euler );
		scale.set( r * ( 1.1 + tone * 0.65 ), r * ( 0.28 + size * 0.14 ), r * ( 0.8 + ( 1 - tone ) * 0.45 ) );
		mesh.setMatrixAt( i, matrix.compose( position, rotation, scale ) );
		color.setHex( palette[ Math.floor( tone * palette.length ) ] ); mesh.setColorAt( i, color );
	}
	mesh.count = samples.length;
	mesh.instanceMatrix.setUsage( T.DynamicDrawUsage ); mesh.instanceMatrix.needsUpdate = true;
	if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;
	mesh.name = 'WebGL camera-following beach debris'; mesh.frustumCulled = false; mesh.renderOrder = 2;
	return mesh;

}

function webglPlantGeometry( T, source ) {

	const geometry = new T.BufferGeometry(), position = source.attributes.position, normal = source.attributes.normal, uv = source.attributes.uv, veg = source.attributes.aVeg, parts = source.attributes.aMat;
	const positions = new Float32Array( position.count * 3 ), normals = new Float32Array( position.count * 3 ), uvs = new Float32Array( position.count * 2 ), vegetation = new Float32Array( position.count * 4 ), materials = new Float32Array( position.count * 4 ), colors = new Float32Array( position.count * 3 );
	const palettes = [ 0x765331, 0x416735, 0x527b3b, 0x4c7936, 0x765331, 0x90714a, 0x40642f, 0x5a753b, 0x53743b, 0xb74727, 0x526b44, 0xc17b38 ];
	for ( let i = 0; i < position.count; i ++ ) {
		const j = i * 3;
		positions[ j ] = position.getX( i ); positions[ j + 1 ] = position.getY( i ); positions[ j + 2 ] = position.getZ( i );
		normals[ j ] = normal.getX( i ); normals[ j + 1 ] = normal.getY( i ); normals[ j + 2 ] = normal.getZ( i );
		uvs[ i * 2 ] = uv.getX( i ); uvs[ i * 2 + 1 ] = uv.getY( i );
		for ( let c = 0; c < 4; c ++ ) { vegetation[ i * 4 + c ] = veg.getComponent( i, c ); materials[ i * 4 + c ] = parts.getComponent( i, c ); }
		const color = new T.Color( palettes[ Math.round( parts.getX( i ) ) ] || 0x527b3b );
		colors[ j ] = color.r; colors[ j + 1 ] = color.g; colors[ j + 2 ] = color.b;
	}
	geometry.setAttribute( 'position', new T.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new T.Float32BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'uv', new T.Float32BufferAttribute( uvs, 2 ) );
	geometry.setAttribute( 'aVeg', new T.Float32BufferAttribute( vegetation, 4 ) );
	geometry.setAttribute( 'aMat', new T.Float32BufferAttribute( materials, 4 ) );
	geometry.setAttribute( 'color', new T.Float32BufferAttribute( colors, 3 ) );
	geometry.setIndex( new T.Uint32BufferAttribute( source.index.array, 1 ) );
	geometry.computeBoundingSphere();
	return geometry;

}

function webglPlantMaterial( T, anchored = false ) {

	const material = new T.MeshStandardMaterial( { vertexColors: true, side: T.DoubleSide, roughness: 0.92 } );
	if ( anchored ) {
		material.onBeforeCompile = shader => {
			shader.vertexShader = shader.vertexShader.replace( '#include <common>', '#include <common>\nattribute vec4 aVeg;\nattribute vec4 aMat;\nattribute float instanceScale;\nattribute float instanceHeight;' );
			shader.vertexShader = shader.vertexShader.replace( '#include <begin_vertex>', `#include <begin_vertex>
				if ( aMat.x < 0.5 ) {
					transformed.x *= instanceScale;
					transformed.z *= instanceScale;
					transformed.y = aVeg.x * instanceHeight;
				} else {
					transformed *= instanceScale;
					transformed.y += instanceHeight;
				}` );
		};
		material.customProgramCacheKey = () => 'elsemesh-webgl-anchored-vegetation';
	}
	return material;

}

export class WebGLFallback {

	constructor( app, engine ) {

		this.app = app;
		this.defaultWorldPackage = app.worldPackage;
		const bundledSource = this.defaultWorldPackage?.source || null;
		this.defaultWorldSource = bundledSource ? {
			...bundledSource,
			components: ( bundledSource.components || [] ).map( worldComponentRuntimeRecord ),
		} : null;
		this.defaultWorldAssets = this.defaultWorldPackage?.assets || null;
		this.islandWildlifeComponent = this.defaultWorldSource?.components.find( component => component.type === 'elsemesh.example-island-wildlife/1' ) || null;
		this.islandWhaleComponent = this.defaultWorldSource?.components.find( component => component.type === 'elsemesh.humpback-whale/1' ) || null;
		this.engine = engine;
		this.THREE = engine.THREE;
		this.renderer = engine.renderer;
		this.scene = new this.THREE.Scene();
		this.waterScene = new this.THREE.Scene();
		this.sceneColorTexture = new this.THREE.FramebufferTexture( 1, 1 );
		this.sceneColorTexture.magFilter = this.THREE.LinearFilter;
		this.sceneColorTexture.minFilter = this.THREE.LinearFilter;
		this.terrainColorTexture = null;
		this.scene.background = new this.THREE.Color( 0x172b42 );
		this.camera = new this.THREE.PerspectiveCamera( 62, 1, 0.1, 5000 );
		this.camera.rotation.order = 'YXZ';
		this.keys = new Set();
		this.velocityY = 0;
		this.sequence = 0;
		this.presenceConnector = null;
		this.presencePending = false;
		this.presenceNextSend = 0;
		this.portals = [];
		this.blockers = [];
		this.remotePlayers = new Map();
		this.loader = new GLTFLoader();
		this.worldLink = worldLinkFromLocation();
		this.debugNoWater = new URLSearchParams( location.search ).has( 'noWater' )
			|| this.worldLink?.environment?.water?.enabled === false;
		this.waterQuery = null;
		this.input = null;
		this.player = null;
		this.hostedSeaLevel = null;
		this.worldSeaLevel = this.defaultWorldSource?.rules.seaLevel ?? 0;
		this.hostedWildlifeComponent = null;
		this.hostedComponentRuntimes = [];
		this.hostedCollisionPayloads = new Map();
		this.vegetationRecords = null;
		this.wildlifeRuntime = null;
		this.wildlifeAdapter = null;

	}

	async init( onProgress = () => {} ) {

		const T = this.THREE;
		this.reviewPose = cameraPoseFromSearch( location.search );
		if ( this.reviewPose?.time !== undefined ) this.app.settings.timeOfDay = this.reviewPose.time;
		this.renderer.toneMapping = T.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 0.9;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = T.PCFSoftShadowMap;
		this.spray = new WebGLSpray( T, this.scene );
		const sunDirection = this._sunDirection( this.app.settings.timeOfDay );
		this.cloudLayer = this._makeCloudLayer( sunDirection );
		this.scene.add( this.cloudLayer );
		this.hemisphereLight = new T.HemisphereLight( 0xd9f1ff, 0x42513f, 1.5 );
		this.scene.add( this.hemisphereLight );
		const sun = new T.DirectionalLight( 0xfff0d2, 2.4 );
		sun.position.copy( sunDirection ).multiplyScalar( 500 );
		this.sunLight = sun;
		sun.castShadow = true;
		sun.shadow.mapSize.set( 1024, 1024 );
		sun.shadow.camera.left = sun.shadow.camera.bottom = - 300;
		sun.shadow.camera.right = sun.shadow.camera.top = 300;
		sun.shadow.camera.near = 1;
		sun.shadow.camera.far = 1400;
		sun.shadow.bias = - 0.00008;
		sun.shadow.normalBias = 0.025;
		this.scene.add( sun );
		this.sunDirection = sunDirection;
		this._updateLighting();
		this._makeHUD();
		if ( this.worldLink ) await this._loadHostedWorld( onProgress );
		else await this._loadIsland( onProgress );
		if ( this.reviewPose ) this.spawn = { position: this.reviewPose.p, yaw: this.reviewPose.yaw, pitch: this.reviewPose.pitch };
		this.camera.position.set( ...this.spawn.position );
		this.input = new Input( this.engine.canvas );
		if ( ! this.worldLink ) {
			this.waterQuery = new WebGLWaterQuery( T, this.renderer, this.terrain, this.worldSeaLevel );
			this._bindOceanFFTToWater();
			this.boat = new WebGLBoatAdapter( T, this.scene, { query: this.waterQuery, terrain: this.terrain, colliders: this.app.worldState.colliders, initialPosition: new EngineVector3( ...WORLD.boatDock.position ), initialHeading: WORLD.boatDock.heading } );
			this.boat.controller.model = this.boat.model;
			this._addIslandGameplayColliders();
			this.player = new Player( { camera: this.camera, input: this.input, terrain: this.terrain, colliders: this.app.worldState.colliders, query: this.waterQuery, boat: this.boat.controller, audio: this.app.audio } );
			this.player.yaw = this.spawn.yaw || 0;
			this.player.pitch = this.spawn.pitch || 0;
			this.player.position.set( this.spawn.position[ 0 ], this.spawn.position[ 1 ] - 1.62, this.spawn.position[ 2 ] );
			this.player.camera.position.set( ...this.spawn.position );
			this.player._camY = null;
			this.activeWorldExtensions?.dispose();
			this.activeWorldExtensions = createWorldBehaviorExtensions( this.defaultWorldSource.experience, this.defaultWorldAssets.extensionModules );
			dispatchWorldBehaviorHooks( this.defaultWorldSource.experience, 'onWebGLWorldActivated', { fallback: this, mode: 'builtin', THREE: T, extensions: this.activeWorldExtensions } );
		} else {
			const hostedColliders = this.app.hostedColliders;
			const hostedTerrain = this.hostedTerrainData || { heightAt: () => Number( this.spawn.position[ 1 ] ) - 1.7 };
			this.waterQuery = new WebGLWaterQuery( T, this.renderer, hostedTerrain, this.hostedSeaLevel ?? 0 );
			this._bindOceanFFTToWater();
			this.player = new Player( { camera: this.camera, input: this.input, terrain: hostedTerrain, colliders: hostedColliders, query: this.waterQuery, boat: null, audio: this.app.audio } );
			this.player.setHostedWorldPose( { x: this.spawn.position[ 0 ], y: this.spawn.position[ 1 ], z: this.spawn.position[ 2 ] }, this.spawn.yaw, this.spawn.pitch );
			if ( this.connector?.localOnly ) this.player.hostedCollisionGuard = ( from, to ) => this.connector.isCollisionPathReady( from, to, { loadedObjects: this.localLoadedObjectIDs } );
			this.player.hostedSeaLevel = this.hostedSeaLevel;
			if ( this.hostedVehicleSpec ) {
				const { object: berth, preview } = this.hostedVehicleSpec;
				preview.visible = false;
				this.boat = new WebGLBoatAdapter( T, this.scene, {
					query: this.waterQuery, terrain: this.hostedTerrainData || null, colliders: hostedColliders,
					initialPosition: new EngineVector3( ...berth.transform.position ), initialHeading: berth.transform.yaw || 0,
				} );
				this.boat.controller.model = this.boat.model;
				this.player.boat = this.boat.controller;
			}
			if ( this.hostedTerrainData && this.hostedGrassMask ) {
				this.grass = webglGrassMesh( T, this.hostedTerrainData, this.camera, null, this.hostedGrassMask );
				this.scene.add( this.grass );
				this.grassCenter = new T.Vector2( this.camera.position.x, this.camera.position.z );
			}
		}
		if ( this.worldLink ) {
			this.activeWorldExtensions?.dispose();
			this.activeWorldExtensions = createWorldBehaviorExtensions( this.connector?.manifest?.experience, this.connector?.assets );
			try {
				dispatchWorldBehaviorHooks( this.connector?.manifest?.experience, 'onWebGLWorldActivated', { fallback: this, mode: 'hosted', THREE: T, extensions: this.activeWorldExtensions } );
			} catch ( error ) {
				this.activeWorldExtensions.dispose();
				this.activeWorldExtensions = null;
				throw error;
			}
		}
		if ( this.worldLink ) {
			for ( const { component, assets } of this.hostedWhalePackages || [] ) {
				if ( await this._loadWebGLWhale( component, assets, this.hostedTerrainData, this.hostedSeaLevel ?? 0 ) ) this.hostedSupportedComponents.add( component.id );
			}
			this._updateHostedWebGLStatus();
		} else await this._loadIslandWhale();
		if ( this.worldLink ) {
			if ( this.hostedWildlifeComponent ) {
				if ( ! this.hostedTerrainData ) throw new Error( `Wildlife component ${this.hostedWildlifeComponent.id} requires its packaged terrain surface` );
				this._createWildlifeRuntime( this.hostedTerrainData, this.app.hostedColliders, this.hostedWildlifeComponent );
			}
		} else this._createWildlifeRuntime( this.terrain, this.app.worldState.colliders, this.islandWildlifeComponent );
		if ( this.terrain ) {
			this.beachDebris = webglBeachDebris( T, this.terrain, this.camera );
			this.scene.add( this.beachDebris );
			this.debrisCenter = new T.Vector2( this.camera.position.x, this.camera.position.z );
		}
		this._bindInput();
		this._resize();
		window.addEventListener( 'resize', this._resize );
		this.animationStartTime = performance.now();
		this.renderer.setAnimationLoop( () => this._frame() );
		this._startPresence();
	}

	_createWildlifeRuntime( terrain, colliders, component = null ) {

		this.wildlifeRuntime = new WildlifeSimulation( {
			terrain, colliders, vegetation: { records: this.vegetationRecords || {} },
			footprints: component?.footprints || [], roofPerches: component?.roofPerches || [],
			boat: this.boat?.controller || null,
			boatModel: this.boat?.model || null,
			shoreProbe: this.shoreField ? new WebGLSwashProbe( {
				field: this.shoreField, terrain, seaLevel: this.worldSeaLevel,
				time: () => this.animationStartTime ? ( performance.now() - this.animationStartTime ) * 0.001 : 0,
			} ) : null,
			query: this.waterQuery, seed: component?.seed ?? 5,
		} );
		this.wildlifeAdapter = new WebGLWildlifeAdapter( this.THREE, this.scene, terrain );

	}

	async _loadWebGLWhale( component, assets, terrain = null, seaLevel = 0 ) {

		const whale = new Whale( {
			THREE: this.THREE, webgl: true, scene: this.scene, terrain, query: this.waterQuery, spray: this.spray, queryName: `whale:${component.id}`,
			seaLevel, profile: {
				seed: component.seed, route: component.route, surfaceAt: component.surfaceAt,
				cruiseSpeed: component.cruiseSpeed, surfaceSpeed: component.surfaceSpeed,
			},
		} );
		try {
			if ( assets ) await whale.loadPackage( assets );
			else await whale.load();
			this.whales ||= [];
			this.whales.push( whale );
			return true;
		} catch ( error ) {
			whale.dispose();
			console.warn( `WebGL whale component ${component.id} unavailable:`, error );
			return false;
		}

	}

	async _loadIslandWhale() {

		try {
			await this._loadWebGLWhale( this.islandWhaleComponent, null, this.terrain, this.defaultWorldSource.rules.seaLevel ?? 0 );
		} catch ( error ) {
			console.warn( 'WebGL island whale package unavailable:', error );
		}

	}

	_updateHostedWebGLStatus() {

		const unsupported = unsupportedHostedWebGLComponents( this.hostedComponents, this.hostedSupportedComponents );
		this.fallbackBadge.textContent = `WebGL fallback · ${ this.engine.fallbackReason }${ unsupported.length ? ` · ${ unsupported.length } package feature(s) omitted` : '' }`;

	}

	_makeWater( geometry, seaLevel, terrainWater, beachPatchMode = 0, beachPatchBounds = null ) {

		const T = this.THREE;
		const material = new T.ShaderMaterial( {
			uniforms: {
				uTime: { value: 0 }, uCameraPosition: { value: new T.Vector3() }, uSunDirection: { value: this.sunDirection.clone() },
				uOceanDisplacement: { value: null }, uOceanSizes: { value: new T.Vector4() }, uOceanEnabled: { value: 0 },
				uCloudNoise: { value: this.cloudLayer.userData.cloudNoise }, uFoamLace: { value: webglFoamLaceTexture( T ) }, uSceneColor: { value: this.sceneColorTexture }, uViewProjection: { value: new T.Matrix4() }, uViewport: { value: new T.Vector2( 1, 1 ) },
				uTerrainColor: { value: this.terrainColorTexture },
				uTerrainHeight: { value: terrainWater?.texture || null }, uTerrainOrigin: { value: terrainWater?.origin || 0 }, uTerrainSize: { value: terrainWater?.size || 0 },
				uHeightRange: { value: new T.Vector2( terrainWater?.minHeight ?? - 512, terrainWater?.maxHeight ?? 1536 ) }, uSeaLevel: { value: seaLevel },
				uShoreField: { value: terrainWater?.shore?.texture || null }, uShoreFieldOrigin: { value: terrainWater?.shore?.origin || 0 }, uShoreFieldSize: { value: terrainWater?.shore?.size || 0 },
				uShoreTimeRange: { value: terrainWater?.shore?.timeRange || new T.Vector2() }, uSwashField: { value: terrainWater?.shore?.swashTexture || null }, uSwashTimeRange: { value: terrainWater?.shore?.swashTimeRange || new T.Vector2() },
				uBeachPatchMode: { value: beachPatchMode }, uBeachPatchBounds: { value: beachPatchBounds ? new T.Vector4( beachPatchBounds.xMin, beachPatchBounds.zMin, beachPatchBounds.xMax, beachPatchBounds.zMax ) : new T.Vector4() },
			},
			vertexShader: /* glsl */`
				uniform float uTime;
				uniform sampler2D uOceanDisplacement;
				uniform vec4 uOceanSizes;
				uniform int uOceanEnabled;
				uniform sampler2D uTerrainHeight;
				uniform sampler2D uShoreField;
				uniform float uTerrainOrigin;
				uniform float uTerrainSize;
				uniform float uShoreFieldOrigin;
				uniform float uShoreFieldSize;
				uniform vec2 uShoreTimeRange;
				uniform sampler2D uSwashField;
				uniform vec2 uSwashTimeRange;
				uniform vec2 uHeightRange;
				uniform float uSeaLevel;
				uniform int uBeachPatchMode;
				varying vec3 vWorldPosition;
				varying vec2 vRestPosition;
				varying float vWaveHeight;
				varying float vShoreU;
				varying float vShoreBreaking;
				varying float vShoreEnv;
				varying float vShoreAlongVariation;
				varying float vShoreSlope;
				varying float vSwashFront;
				varying float vSwashFoam;
				vec3 oceanDisplacementCascade( vec2 xz, int cascade ) {
					vec2 g = fract( xz / uOceanSizes[ cascade ] ) * 256.0 - 0.5;
					// Keep hardware bilinear filtering inside the selected 256x256 cascade
					// tile; the atlas stores four cascades in vertically adjacent tiles.
					g = clamp( g, vec2( 0.0 ), vec2( 255.0 ) );
					vec2 atlasPixel = vec2( g.x, float( cascade * 256 ) + g.y );
					return texture2D( uOceanDisplacement, ( atlasPixel + 0.5 ) / vec2( 256.0, 1024.0 ) ).xyz;
				}
				vec3 oceanDisplacementAt( vec2 xz, float depth ) {
					vec3 displacement = vec3( 0.0 );
					for ( int cascade = 0; cascade < 4; cascade ++ ) {
						float d0 = min( 40.0, uOceanSizes[ cascade ] * 0.08 );
						float floorAmount = cascade == 0 ? 0.0 : cascade == 1 ? 0.05 : cascade == 2 ? 0.25 : 0.5;
						float attenuation = mix( floorAmount * smoothstep( 0.0, 0.6, depth ), 1.0, smoothstep( 0.0, d0, depth ) );
						displacement += oceanDisplacementCascade( xz, cascade ) * attenuation;
					}
					return displacement;
				}
				void main() {
					vec4 world = modelMatrix * vec4( position, 1.0 );
					vec2 p = world.xz;
					vRestPosition = p;
					vSwashFront = -1.0;
					vSwashFoam = 0.0;
					float vertexGroundHeight = uHeightRange.x;
					float vertexSandCoverage = 0.0;
					float shoreWaveHeight = 0.0;
					float a = dot( p, vec2( 0.035, 0.025 ) ) + uTime * 0.3;
					float b = dot( p, vec2( -0.07, 0.15 ) ) - uTime * 0.55;
					float c = dot( p, vec2( 0.21, -0.16 ) ) + uTime * 0.7;
					float d = dot( p, vec2( 0.42, 0.09 ) ) + uTime * 1.3;
					float e = dot( p, vec2( 0.72, -0.48 ) ) + uTime * 1.6;
					vWaveHeight = 0.95 * sin( a ) + 0.55 * sin( b ) + 0.08 * sin( c ) + 0.03 * sin( d ) + 0.01 * sin( e );
					vShoreU = 0.0;
					vShoreBreaking = -10.0;
					vShoreEnv = 0.0;
					vShoreAlongVariation = 0.0;
					vShoreSlope = 0.0;
					if ( uTerrainSize > 0.0 ) {
						vec2 terrainUv = ( p - vec2( uTerrainOrigin ) ) / uTerrainSize;
						if ( all( greaterThanEqual( terrainUv, vec2( 0.0 ) ) ) && all( lessThanEqual( terrainUv, vec2( 1.0 ) ) ) ) {
							vec4 terrain = texture2D( uTerrainHeight, terrainUv );
							float encodedHeight = ( terrain.r * 255.0 * 256.0 + terrain.g * 255.0 ) / 65535.0;
							vertexGroundHeight = mix( uHeightRange.x, uHeightRange.y, encodedHeight );
							vertexSandCoverage = terrain.b;
							float depth = uSeaLevel - vertexGroundHeight;
							if ( depth > -0.25 && depth < 26.0 && uShoreFieldSize > 0.0 ) {
								vec2 shoreUv = ( p - vec2( uShoreFieldOrigin ) ) / uShoreFieldSize;
								vec4 shore = texture2D( uShoreField, shoreUv );
								vec2 shoreDirection = normalize( shore.rg * 2.0 - 1.0 );
								float exposure = shore.b;
								float arrival = mix( uShoreTimeRange.x, uShoreTimeRange.y, shore.a );
								float along = dot( p, vec2( -shoreDirection.y, shoreDirection.x ) );
								float rip = smoothstep( 0.8 + sin( along * 0.017 + 4.1 ) * 0.08, 0.985, sin( along * 0.059 + sin( along * 0.021 + 1.9 ) * 1.4 + sin( along * 0.009 + 0.3 ) * 0.9 ) );
								float bar = ( 0.9 + ( sin( along * 0.031 + 7.3 ) * 0.6 + sin( along * 0.083 + 1.1 ) * 0.4 ) * 0.14 ) * ( 1.0 - rip * 0.58 );
								float phase = ( uTime - arrival ) / ${SHORE_DEFAULT_PERIOD.toFixed( 1 )} + sin( along * 0.029 + 0.7 ) * 0.07 + sin( along * 0.083 + 2.1 ) * 0.035 + sin( along * 0.19 + 0.4 ) * 0.022 + sin( along * 0.37 + 2.6 ) * 0.011 + rip * 0.045;
								float waveIndex = floor( phase + 0.5 );
								float warp = sin( along * 0.016 + waveIndex * 0.9 ) * 1.6;
								float alongVariation = sin( along * 0.062 + waveIndex * 1.7 + warp ) * 0.6 + sin( along * 0.13 + waveIndex * 4.1 + 1.3 - warp * 0.7 ) * 0.4;
								alongVariation += ( sin( along * 0.29 + waveIndex * 2.3 + warp * 0.5 ) * 0.6 + sin( along * 0.47 + waveIndex * 5.9 + 0.8 ) * 0.4 ) * 0.28;
								float u = phase - waveIndex;
								float randomWave = fract( sin( waveIndex * 127.1 + 311.7 ) * 43758.5453 ) * 2.0 - 1.0;
								float waveSet = abs( sin( waveIndex * 0.448799 ) ) * 0.6 + 0.55;
								float amplitude = max( ${SHORE_DEFAULT_AMPLITUDE.toFixed( 2 )} * waveSet * ( 1.0 + randomWave * ${( SHORE_DEFAULT_VARIATION * 0.5 ).toFixed( 3 )} + alongVariation * ${( SHORE_DEFAULT_VARIATION * 0.7 ).toFixed( 3 )} ) * bar, 0.02 );
								float lam = sqrt( clamp( depth, 0.3, 25.0 ) * 9.81 ) * 9.0;
								vec2 crestPosition = p + shoreDirection * ( u * lam );
								vec2 crestTerrainUv = ( crestPosition - vec2( uTerrainOrigin ) ) / uTerrainSize;
								vec4 crestTerrain = texture2D( uTerrainHeight, crestTerrainUv );
								float crestEncodedHeight = ( crestTerrain.r * 255.0 * 256.0 + crestTerrain.g * 255.0 ) / 65535.0;
								float depthAtCrest = uSeaLevel - mix( uHeightRange.x, uHeightRange.y, crestEncodedHeight );
								depthAtCrest = mix( depthAtCrest, depth, smoothstep( 0.3, 0.5, abs( u ) ) );
								float breakDepth = pow( amplitude * 3.556 / 0.78, 0.8 );
								float breaking = ( breakDepth - depthAtCrest ) / max( breakDepth * 0.13, 0.05 );
								vShoreU = u;
								vShoreBreaking = breaking;
								vShoreAlongVariation = alongVariation;
								float shoaledAmplitude = amplitude * pow( 10.0 / clamp( depth, 0.35, 10.0 ), 0.25 );
								float sharpness = mix( 1.0, 3.0, smoothstep( -2.5, 0.0, breaking ) );
								float meanProfile = inversesqrt( ( sharpness + 0.25 ) * 3.14159265 );
								float skew = smoothstep( -3.0, 0.0, breaking ) * 0.55;
								float phaseSkew = u - skew * ( 1.0 - cos( u * 6.2831853 ) ) / 6.2831853;
								float skewCrest = max( ( cos( phaseSkew * 6.2831853 ) + 1.0 ) * 0.5, 0.0 );
								float curl = smoothstep( -3.0, 0.0, breaking );
								float env = smoothstep( 26.0, 13.0, depth ) * smoothstep( -0.25, 0.05, depth ) * smoothstep( 0.02, 0.3, exposure );
								vShoreEnv = env;
								float preHeight = shoaledAmplitude * 2.0 * ( pow( skewCrest, sharpness ) - meanProfile ) * ( 1.0 + smoothstep( -1.0, 0.3, breaking ) * 0.22 );
								vShoreSlope = 2.0 * shoaledAmplitude * sharpness * 3.14159265 * pow( skewCrest, max( sharpness - 1.0, 0.0 ) ) * sin( phaseSkew * 6.2831853 ) * ( 1.0 - skew * sin( u * 6.2831853 ) ) / ( sqrt( clamp( depth, 0.3, 25.0 ) * 9.81 ) * 9.0 ) * env;
								shoreWaveHeight += preHeight * env;
								float bore = smoothstep( 0.85, 1.35, breaking );
								float waveHeight = shoaledAmplitude * 2.0 * ( 1.0 - meanProfile );
								float lipHeight = min( waveHeight * 0.6, max( depth, 0.0 ) * 0.75 ) * ( smoothstep( 0.0, 0.3, depth ) * 0.7 + 0.3 );
								float lip = smoothstep( -0.17, -0.12, u ) * ( 1.0 - smoothstep( -0.025, 0.015, u ) );
								float crestHeight = preHeight + lipHeight * bore * curl * lip;
								world.xz += shoreDirection * ( sin( u * 6.2831853 ) * shoaledAmplitude * 0.12 + lipHeight * 0.55 * bore * curl * lip ) * env;
								shoreWaveHeight += ( crestHeight - preHeight ) * env;
							}
						}
					}
					if ( uOceanEnabled == 1 ) {
						float oceanDepth = uSeaLevel - vertexGroundHeight;
						vec2 rest = p, displaced = p;
						for ( int iteration = 0; iteration < 2; iteration ++ ) displaced = rest - oceanDisplacementAt( displaced, oceanDepth ).xz;
						vec3 ocean = oceanDisplacementAt( displaced, oceanDepth );
						world.xz += ocean.xz;
						vWaveHeight = ocean.y + shoreWaveHeight;
					}
					if ( uBeachPatchMode == 2 && vertexGroundHeight > uSeaLevel && vertexSandCoverage > 0.05 ) {
						vec2 shoreUv = ( p - vec2( uShoreFieldOrigin ) ) / uShoreFieldSize;
						vec4 shore = texture2D( uShoreField, shoreUv );
						vec2 dir = normalize( shore.rg * 2.0 - 1.0 );
						float exposure = shore.b;
						float along = dot( p, vec2( -dir.y, dir.x ) );
						float swashArrival = mix( uSwashTimeRange.x, uSwashTimeRange.y, texture2D( uSwashField, shoreUv ).r );
						float rip = smoothstep( 0.8 + sin( along * 0.017 + 4.1 ) * 0.08, 0.985, sin( along * 0.059 + sin( along * 0.021 + 1.9 ) * 1.4 + sin( along * 0.009 + 0.3 ) * 0.9 ) );
						float phase = ( uTime - swashArrival ) / ${SHORE_DEFAULT_PERIOD.toFixed( 1 )} + sin( along * 0.029 + 0.7 ) * 0.07 + sin( along * 0.083 + 2.1 ) * 0.035 + sin( along * 0.19 + 0.4 ) * 0.022 + sin( along * 0.37 + 2.6 ) * 0.011 + rip * 0.045;
						float waveIndex = floor( phase );
						float tau = fract( phase );
						float warp = sin( along * 0.016 + waveIndex * 0.9 ) * 1.6;
						float variation = sin( along * 0.062 + waveIndex * 1.7 + warp ) * 0.6 + sin( along * 0.13 + waveIndex * 4.1 + 1.3 - warp * 0.7 ) * 0.4;
						variation += ( sin( along * 0.29 + waveIndex * 2.3 + warp * 0.5 ) * 0.6 + sin( along * 0.47 + waveIndex * 5.9 + 0.8 ) * 0.4 ) * 0.28;
						float randomWave = fract( sin( waveIndex * 127.1 + 311.7 ) * 43758.5453 ) * 2.0 - 1.0;
						float waveSet = abs( sin( waveIndex * 0.448799 ) ) * 0.6 + 0.55;
						float bar = ( 0.9 + ( sin( along * 0.031 + 7.3 ) * 0.6 + sin( along * 0.083 + 1.1 ) * 0.4 ) * 0.14 ) * ( 1.0 - rip * 0.58 );
						float amp = max( ${SHORE_DEFAULT_AMPLITUDE.toFixed( 2 )} * waveSet * ( 1.0 + randomWave * ${( SHORE_DEFAULT_VARIATION * 0.5 ).toFixed( 3 )} + variation * ${( SHORE_DEFAULT_VARIATION * 0.7 ).toFixed( 3 )} ) * bar, 0.02 );
						float runupMax = amp * 2.1 * clamp( exposure * 1.4, 0.0, 1.0 ) / ${SHORE_BEACH_SLOPE};
						float su = clamp( tau / ${SHORE_SWASH_UP}, 0.0, 1.0 ), sb = clamp( ( tau - ${SHORE_SWASH_UP} ) / ${SHORE_SWASH_DOWN}, 0.0, 1.0 );
						float runup = ( tau < ${SHORE_SWASH_UP} ? 1.0 - pow( 1.0 - su, 1.5 ) : 1.0 - pow( sb, 1.6 ) ) * runupMax - 0.3;
						float lobes = sin( along * 0.61 + waveIndex * 2.3 ) * 0.5 + sin( along * 1.73 + waveIndex * 5.1 ) * 0.3 + sin( along * 4.3 + waveIndex * 1.7 ) * 0.2;
						float runupFront = max( runup + lobes * ( max( runup, 0.0 ) * 0.07 + 0.35 ), 0.35 ) - max( vertexGroundHeight - uSeaLevel, 0.0 ) / ${SHORE_BEACH_SLOPE};
						vSwashFront = runupFront;
						if ( runupFront > 0.0 ) {
							float uprush = 1.0 - smoothstep( 0.32, 0.46, tau );
							vSwashFoam = ( 1.0 - smoothstep( 0.0, 0.8, runupFront ) ) * smoothstep( -0.05, 0.05, runupFront ) * uprush * 0.9;
						}
					}
					world.y += vWaveHeight;
					vWorldPosition = world.xyz;
					gl_Position = projectionMatrix * viewMatrix * world;
				}
			`,
			fragmentShader: /* glsl */`
				uniform float uTime;
				uniform vec3 uCameraPosition;
				uniform vec3 uSunDirection;
				uniform sampler2D uCloudNoise;
				uniform sampler2D uFoamLace;
				uniform sampler2D uSceneColor;
				uniform mat4 uViewProjection;
				uniform vec2 uViewport;
				uniform sampler2D uTerrainColor;
				uniform sampler2D uTerrainHeight;
				uniform float uTerrainOrigin;
				uniform float uTerrainSize;
				uniform vec2 uHeightRange;
				uniform float uSeaLevel;
				uniform int uBeachPatchMode;
				uniform vec4 uBeachPatchBounds;
				varying vec3 vWorldPosition;
				varying vec2 vRestPosition;
				varying float vWaveHeight;
				varying float vShoreU;
				varying float vShoreBreaking;
				varying float vShoreEnv;
				varying float vShoreAlongVariation;
				varying float vShoreSlope;
				varying float vSwashFront;
				varying float vSwashFoam;
				vec3 screenColorToLinear( vec3 color ) {
					return mix( color / 12.92, pow( ( color + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), color ) );
				}
				void main() {
					vec2 p = vWorldPosition.xz;
					bool inBeachPatch = vRestPosition.x >= uBeachPatchBounds.x && vRestPosition.x <= uBeachPatchBounds.z && vRestPosition.y >= uBeachPatchBounds.y && vRestPosition.y <= uBeachPatchBounds.w;
					if ( ( uBeachPatchMode == 1 && inBeachPatch ) || ( uBeachPatchMode == 2 && ! inBeachPatch ) ) discard;
					vec2 kA = vec2( 0.035, 0.025 ), kB = vec2( -0.07, 0.15 ), kC = vec2( 0.21, -0.16 );
					float a = dot( p, kA ) + uTime * 0.3;
					float b = dot( p, kB ) - uTime * 0.55;
					float c = dot( p, kC ) + uTime * 0.7;
					vec2 waterUv = p * 0.024 + vec2( uTime * 0.0013, -uTime * 0.0008 );
					vec4 waterNoise = texture2D( uCloudNoise, waterUv );
					vec2 fineUv = p * 0.19 + vec2( -uTime * 0.0021, uTime * 0.0015 );
					vec4 fineNoise = texture2D( uCloudNoise, fineUv );
					vec3 geometricNormal = normalize( cross( dFdx( vWorldPosition ), dFdy( vWorldPosition ) ) );
					if ( geometricNormal.y < 0.0 ) geometricNormal = -geometricNormal;
					vec2 slope = vec2( -geometricNormal.x, -geometricNormal.z ) / max( geometricNormal.y, 0.05 );
					vec2 fineStep = vec2( 0.0012, 0.0 );
					float fineSlopeX = texture2D( uCloudNoise, fineUv + fineStep ).r - texture2D( uCloudNoise, fineUv - fineStep ).r;
					float fineSlopeY = texture2D( uCloudNoise, fineUv + fineStep.yx ).r - texture2D( uCloudNoise, fineUv - fineStep.yx ).r;
					slope += ( waterNoise.rg - 0.5 ) * 0.11 + vec2( fineSlopeX, fineSlopeY ) * 0.52;
					slope.y += vShoreSlope;
					vec3 normal = normalize( vec3( -slope.x, 1.0, -slope.y ) );
					float groundHeight = uHeightRange.x, depth = 100.0, sandCoverage = 0.0;
					vec3 seabedColor = vec3( 0.31, 0.27, 0.19 );
					if ( uTerrainSize > 0.0 ) {
						vec2 terrainUv = ( p - vec2( uTerrainOrigin ) ) / uTerrainSize;
						if ( all( greaterThanEqual( terrainUv, vec2( 0.0 ) ) ) && all( lessThanEqual( terrainUv, vec2( 1.0 ) ) ) ) {
							vec4 terrain = texture2D( uTerrainHeight, terrainUv );
							seabedColor = texture2D( uTerrainColor, terrainUv ).rgb;
							float encodedHeight = ( terrain.r * 255.0 * 256.0 + terrain.g * 255.0 ) / 65535.0;
							groundHeight = mix( uHeightRange.x, uHeightRange.y, encodedHeight );
							depth = max( 0.0, uSeaLevel + vWaveHeight - groundHeight );
							sandCoverage = terrain.b;
						}
					}
					if ( uBeachPatchMode == 2 && groundHeight > uSeaLevel ) {
						if ( sandCoverage <= 0.05 || vSwashFront <= 0.0 ) discard;
					}
					vec2 screenUv = gl_FragCoord.xy / uViewport;
					vec2 refractedUv = clamp( screenUv + slope * min( depth, 24.0 ) * 0.0007, vec2( 0.001 ), vec2( 0.999 ) );
					vec3 sceneColor = screenColorToLinear( texture2D( uSceneColor, refractedUv ).rgb );
					vec3 absorption = exp( -vec3( 0.42, 0.075, 0.035 ) * min( depth, 60.0 ) );
					vec3 refractedBed = mix( seabedColor, sceneColor, 0.1 ) * vec3( 0.58, 0.86, 0.96 );
					vec3 transmitted = refractedBed * absorption + vec3( 0.008, 0.13, 0.17 ) * ( 1.0 - absorption );
					vec3 viewDirection = normalize( uCameraPosition - vWorldPosition );
					vec3 reflectionDirection = reflect( -viewDirection, normal );
					float fresnel = 0.025 + 0.86 * pow( 1.0 - max( dot( normal, viewDirection ), 0.0 ), 5.0 );
					vec3 sky = mix( vec3( 0.025, 0.07, 0.18 ), vec3( 0.13, 0.25, 0.43 ), smoothstep( -0.08, 0.75, reflectionDirection.y ) );
					vec2 skyUv = vec2( atan( reflectionDirection.x, reflectionDirection.z ) / 6.2831853 + 0.5, asin( clamp( reflectionDirection.y, -1.0, 1.0 ) ) / 3.1415927 + 0.5 );
					skyUv += vec2( uTime * 0.0005, -uTime * 0.00014 );
					vec4 cloudField = texture2D( uCloudNoise, skyUv * 0.38 );
					vec2 cloudWarp = ( cloudField.rg - 0.5 ) * 0.024;
					float cloudBroad = texture2D( uCloudNoise, skyUv * 0.92 + cloudWarp ).r;
					float cloudDetail = texture2D( uCloudNoise, skyUv * 2.2 + vec2( 0.17, -0.11 ) ).g;
					float cloudFine = texture2D( uCloudNoise, skyUv * 4.6 + vec2( 0.31, -0.19 ) ).b;
					float reflectedCloudNoise = cloudBroad - max( 0.0, 0.52 - cloudDetail ) * 0.32 + ( cloudFine - 0.5 ) * 0.045;
					float reflectedCloudBand = smoothstep( 0.055, 0.16, reflectionDirection.y ) * ( 1.0 - smoothstep( 0.72, 0.96, reflectionDirection.y ) );
					float reflectedCloud = smoothstep( 0.64, 0.78, reflectedCloudNoise ) * reflectedCloudBand * 0.85;
					float reflectedSun = pow( max( dot( reflectionDirection, normalize( uSunDirection ) ), 0.0 ), 96.0 );
					vec3 cloudColor = mix( vec3( 0.42, 0.5, 0.62 ), vec3( 1.25, 1.16, 1.0 ), max( dot( reflectionDirection, normalize( uSunDirection ) ), 0.0 ) * 0.6 + 0.2 );
					sky = mix( sky, cloudColor, reflectedCloud );
					sky += vec3( 1.0, 0.72, 0.43 ) * reflectedSun * 0.14;
					vec4 reflectedClip = uViewProjection * vec4( vWorldPosition + reflectionDirection * 1200.0, 1.0 );
					vec2 reflectedUv = reflectedClip.xy / max( reflectedClip.w, 0.0001 ) * 0.5 + 0.5;
					float reflectedOnScreen = step( 0.015, reflectionDirection.y ) * step( 0.001, reflectedClip.w )
						* step( 0.001, reflectedUv.x ) * step( reflectedUv.x, 0.999 )
						* step( 0.001, reflectedUv.y ) * step( reflectedUv.y, 0.999 );
					vec3 screenReflection = screenColorToLinear( texture2D( uSceneColor, reflectedUv ).rgb );
					sky = mix( sky, screenReflection, reflectedOnScreen * 0.72 );
					float ripple = 0.5 + 0.5 * sin( a * 3.1 + sin( b * 2.6 + c * 1.7 ) );
					float micro = fineNoise.r * 0.65 + fineNoise.g * 0.35;
					float shallow = smoothstep( 0.0, 18.0, depth );
					vec3 water = mix( vec3( 0.012, 0.16, 0.24 ), vec3( 0.002, 0.016, 0.065 ), shallow ) * ( 0.97 + ( ripple - 0.5 ) * 0.18 + ( micro - 0.5 ) * 0.08 );
					float bottomVisibility = ( uTerrainSize > 0.0 ) ? 1.0 - smoothstep( 4.0, 36.0, depth ) : 0.0;
					float waterFresnel = fresnel * mix( 1.0, 0.38, bottomVisibility );
					vec3 waterBody = mix( water, transmitted, bottomVisibility * 0.18 * ( 1.0 - waterFresnel ) );
					vec3 reflected = mix( waterBody, sky, waterFresnel * 0.82 );
					vec3 sunReflection = reflect( -normalize( uSunDirection ), normal );
					float glint = pow( max( dot( viewDirection, sunReflection ), 0.0 ), 96.0 );
					reflected += vec3( 1.0, 0.88, 0.72 ) * glint * ( 0.025 + 0.055 * ripple );
					float foamNoise = texture2D( uCloudNoise, p * 0.09 + vec2( -uTime * 0.00031, uTime * 0.00017 ) ).b;
					float shoreDetail = foamNoise * 0.62 + micro * 0.38;
					float shoreDepth = depth + sin( p.x * 0.13 - uTime * 0.42 ) * 0.3 + ( shoreDetail - 0.5 ) * 0.45;
					float shoreWave = 0.5 + 0.5 * sin( shoreDepth * 1.8 + dot( p, vec2( 0.038, 0.061 ) ) - uTime * 0.9 + ( shoreDetail - 0.5 ) * 4.8 );
					float shoreBand = sandCoverage * ( 1.0 - smoothstep( 0.08, 0.42, shoreDepth ) );
					float shoreCrest = smoothstep( 0.62, 0.86, shoreWave ) * smoothstep( 0.22, 0.66, shoreDetail );
					float shoreFoam = shoreBand * shoreCrest;
					float faceBand = smoothstep( -0.19, -0.13, vShoreU ) * ( 1.0 - smoothstep( -0.015, 0.01, vShoreU ) );
					float faceProgress = smoothstep( -0.4, 0.0, vShoreBreaking ) * ( 1.0 - smoothstep( 0.9, 1.08, vShoreBreaking ) );
					float breakerFace = faceBand * faceProgress * vShoreEnv;
					float impact = smoothstep( 0.86, 0.99, vShoreBreaking ) * ( 1.0 - smoothstep( 1.4, 1.9, vShoreBreaking ) ) * exp( -abs( vShoreU - 0.08 ) * 38.0 );
					float roller = smoothstep( 0.85, 1.35, vShoreBreaking ) * exp( -abs( vShoreU + 0.08 ) * 24.0 );
					vec4 foamLaceData = texture2D( uFoamLace, p / 3.5 + vec2( -uTime * 0.0008, uTime * 0.00057 ) );
					float foamLace = 1.0 - smoothstep( 0.42, 0.72, foamLaceData.r );
					float crestFoam = smoothstep( 0.68, 0.94, vShoreBreaking ) * ( 1.0 - smoothstep( 1.45, 1.9, vShoreBreaking ) ) * exp( -abs( vShoreU - 0.06 ) * 16.0 ) * mix( 0.2, 1.0, foamLace );
					float breakerFoam = max( max( impact, roller ), crestFoam * 0.85 ) * vShoreEnv * smoothstep( 0.15, 0.55, vShoreAlongVariation + 0.6 ) * smoothstep( 0.14, 0.58, shoreDetail );
					float laceWidth = clamp( pow( breakerFoam, 1.4 ) * ( 0.7 + foamLaceData.b * 0.2 ), 0.0, 0.78 );
					float laceMat = 1.0 - smoothstep( laceWidth - 0.035, laceWidth + 0.035, foamLaceData.r );
					float laceBubbles = foamLaceData.g * smoothstep( laceWidth + 0.22, laceWidth, foamLaceData.r );
					breakerFoam *= mix( laceMat, 1.0, smoothstep( 0.55, 0.92, breakerFoam ) );
					breakerFoam = max( breakerFoam, laceBubbles * smoothstep( 0.12, 0.5, breakerFoam ) * 0.48 );
					reflected = mix( reflected, vec3( 0.02, 0.34, 0.34 ), breakerFace * 0.34 );
					float foam = max( max( sandCoverage * ( 1.0 - smoothstep( 0.05, 0.75, depth ) ) * ( 0.025 + 0.08 * ripple + 0.03 * micro ), max( shoreFoam, breakerFoam ) * 0.88 ), vSwashFoam );
					reflected = mix( reflected, vec3( 0.86, 0.94, 0.93 ), foam );
					gl_FragColor = vec4( reflected, 1.0 );
					#include <tonemapping_fragment>
					#include <colorspace_fragment>
				}
			`,
			side: T.DoubleSide,
			depthWrite: true,
		} );
		const water = new T.Mesh( geometry, material );
		water.rotation.x = - Math.PI / 2;
		water.position.y = seaLevel;
		water.isWater = true;
		water.onBeforeRender = ( renderer, scene, camera ) => {
			material.uniforms.uCameraPosition.value.setFromMatrixPosition( camera.matrixWorld );
			material.uniforms.uViewProjection.value.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
		};
		return water;

	}

	_bindOceanFFTToWater() {

		const fft = this.waterQuery?.fft;
		if ( ! fft ) return;
		for ( const water of this.waterScene.children ) {
			const uniforms = water.material?.uniforms;
			if ( ! uniforms?.uOceanDisplacement ) continue;
			uniforms.uOceanDisplacement.value = fft.displacementTarget.texture;
			uniforms.uOceanSizes.value.set( ...fft.parameters.sizes );
			uniforms.uOceanEnabled.value = 1;
		}

	}

	_makeCloudLayer( sunDirection ) {

		const T = this.THREE, cloudNoise = webglCloudNoiseTexture( T ), cloudVolume = webglCloudVolumeTexture( T );
		const material = new T.ShaderMaterial( {
			uniforms: {
				uTime: { value: 0 }, uSunDirection: { value: sunDirection.clone() }, uCameraPosition: { value: new T.Vector3() },
				uCloudNoise: { value: cloudNoise }, uCloudVolume: { value: cloudVolume },
			},
			vertexShader: /* glsl */`
				varying vec3 vDirection;
				void main() {
					vDirection = position;
					vec4 clip = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
					gl_Position = clip.xyww;
				}
			`,
			fragmentShader: /* glsl */`
				uniform float uTime;
				uniform vec3 uSunDirection;
				uniform vec3 uCameraPosition;
				uniform sampler2D uCloudNoise;
				uniform sampler3D uCloudVolume;
				varying vec3 vDirection;
				void main() {
					vec3 dir = normalize( vDirection );
					float elevation = max( dir.y, 0.0 );
					float day = smoothstep( -0.12, 0.08, uSunDirection.y );
					float skyHeight = pow( smoothstep( 0.0, 0.9, elevation ), 0.72 );
					vec3 daySky = mix( vec3( 0.19, 0.31, 0.4 ), vec3( 0.002, 0.014, 0.075 ), pow( skyHeight, 0.55 ) );
					vec3 nightSky = mix( vec3( 0.025, 0.045, 0.075 ), vec3( 0.008, 0.018, 0.045 ), skyHeight );
					vec3 sky = mix( nightSky, daySky, day );
					float horizonHaze = ( 1.0 - smoothstep( 0.0, 0.22, elevation ) ) * day;
					sky = mix( sky, vec3( 0.22, 0.28, 0.32 ), horizonHaze * 0.6 );
					float sunGlow = pow( max( dot( dir, normalize( uSunDirection ) ), 0.0 ), 10.0 ) * day;
					sky += vec3( 0.16, 0.095, 0.035 ) * sunGlow;
					vec2 uv = vec2( atan( dir.x, dir.z ) / 6.2831853 + 0.5, asin( clamp( dir.y, -1.0, 1.0 ) ) / 3.1415927 + 0.5 );
					uv += vec2( uTime * 0.0005, -uTime * 0.00014 );
					vec4 field = texture2D( uCloudNoise, uv * 0.28 );
					vec2 warp = ( field.rg - 0.5 ) * 0.024;
					float broad = texture2D( uCloudNoise, uv * 0.62 + warp ).r;
					float detail = texture2D( uCloudNoise, uv * 1.55 + vec2( 0.17, -0.11 ) ).g;
					float fine = texture2D( uCloudNoise, uv * 3.1 + vec2( 0.31, -0.19 ) ).b;
					float n = broad - max( 0.0, 0.52 - detail ) * 0.32 + ( fine - 0.5 ) * 0.045;
					float band = smoothstep( 0.055, 0.16, dir.y ) * ( 1.0 - smoothstep( 0.72, 0.96, dir.y ) );
					float coverage = smoothstep( 0.57, 0.73, n ) * band * 0.92;
					float transmittance = 1.0;
					vec3 cloudRadiance = vec3( 0.0 );
					float cloudSun = max( dot( dir, normalize( uSunDirection ) ), 0.0 );
					float cloudStart = max( 0.0, ( 850.0 - uCameraPosition.y ) / max( dir.y, 0.055 ) );
					float cloudEnd = max( cloudStart, ( 1650.0 - uCameraPosition.y ) / max( dir.y, 0.055 ) );
					float stepLength = min( ( cloudEnd - cloudStart ) / 12.0, 12000.0 );
					if ( coverage > 0.002 && stepLength > 0.0 && dir.y > 0.055 ) {
						for ( int i = 0; i < 12; i ++ ) {
							float t = cloudStart + ( float( i ) + 0.5 ) * stepLength;
							vec3 worldPoint = uCameraPosition + dir * t;
							vec3 noisePoint = worldPoint * 0.0027 + vec3( uTime * 0.0000068, 0.0, -uTime * 0.0000044 );
							vec4 volume = texture( uCloudVolume, noisePoint );
							float height = clamp( ( worldPoint.y - 850.0 ) / 800.0, 0.0, 1.0 );
							float profile = smoothstep( 0.0, 0.15, height ) * ( 1.0 - smoothstep( 0.76, 1.0, height ) );
							float shape = 0.5 + ( volume.r - 0.5 ) * 0.24 + ( volume.g - 0.5 ) * 0.08 + ( broad - 0.5 ) * 0.45;
							float density = smoothstep( 0.36, 0.63, shape - max( 0.0, 0.52 - volume.b ) * 0.06 ) * profile * coverage;
							float lightFacing = clamp( 0.43 + ( volume.a - volume.r ) * 1.35 + cloudSun * 0.16, 0.12, 1.0 );
							float lightHeight = 0.12 + height * 0.3 + smoothstep( 0.52, 0.76, volume.g ) * 0.2 + lightFacing * 0.38;
							vec3 light = mix( vec3( 0.18, 0.25, 0.37 ), vec3( 1.35, 1.28, 1.15 ), clamp( lightHeight, 0.0, 1.0 ) );
							light += vec3( 1.0, 0.66, 0.38 ) * pow( cloudSun, 12.0 ) * 0.18;
							float stepAlpha = 1.0 - exp( - density * stepLength * 0.00045 );
							cloudRadiance += transmittance * stepAlpha * light;
							transmittance *= 1.0 - stepAlpha;
						}
					}
					gl_FragColor = vec4( sky * transmittance + cloudRadiance, 1.0 );
					#include <tonemapping_fragment>
					#include <colorspace_fragment>
				}
			`,
			side: T.BackSide,
			transparent: false,
			depthWrite: false,
			depthTest: true,
			toneMapped: true,
		} );
		const clouds = new T.Mesh( new T.SphereGeometry( 1, 64, 32 ), material );
		clouds.userData.cloudNoise = cloudNoise;
		clouds.userData.cloudVolume = cloudVolume;
		clouds.renderOrder = - 999;
		clouds.frustumCulled = false;
		return clouds;

	}

	_sunDirection( hours ) {

		return webglLightingForTime( this.THREE, hours ).sunDirection;

	}

	_updateLighting() {

		const T = this.THREE, lighting = webglLightingForTime( T, this.app.settings.timeOfDay );
		this.sunDirection.copy( lighting.sunDirection );
		this.sunLight.position.copy( lighting.keyDirection ).multiplyScalar( 500 );
		this.sunLight.color.setHex( lighting.keyColor );
		this.sunLight.intensity = lighting.keyIntensity;
		this.hemisphereLight.intensity = lighting.ambientIntensity;
		this.cloudLayer.material.uniforms.uSunDirection.value.copy( this.sunDirection );
		for ( const water of this.waterScene.children ) water.material.uniforms.uSunDirection?.value.copy( this.sunDirection );

	}

	async _loadIsland( progress ) {

		progress( 0.15, 'Building a WebGL terrain…' );
		this.terrain = this.app.worldState.terrain;
		const T = this.THREE;
		try {
			const model = await this.loader.loadAsync( this.defaultWorldAssets.terrainLOD );
			const terrainMaterial = webglTerrainMaterial( T, this.terrain );
			this.terrainColorTexture = terrainMaterial.userData.terrainTextures[ 0 ];
			model.scene.traverse( object => {
				if ( ! object.isMesh ) return;
				object.receiveShadow = true;
				object.material = terrainMaterial;
			} );
			this.scene.add( model.scene );
		} catch ( error ) {
			console.warn( 'WebGL fallback packaged terrain unavailable:', error );
			const divisions = 144, size = this.terrain.size, positions = [], colors = [], indices = [];
			const toLinear = value => value <= 0.04045 ? value / 12.92 : Math.pow( ( value + 0.055 ) / 1.055, 2.4 );
			for ( let j = 0; j <= divisions; j ++ ) for ( let i = 0; i <= divisions; i ++ ) {
				const x = - size / 2 + size * i / divisions, z = - size / 2 + size * j / divisions, h = this.terrain.heightAt( x, z );
				positions.push( x, h, z );
				const c = h < - 0.7 ? [ 0.35, 0.42, 0.34 ] : h < 3.5 ? [ 0.76, 0.68, 0.48 ] : h < 28 ? [ 0.25, 0.39, 0.24 ] : [ 0.39, 0.38, 0.34 ];
				colors.push( toLinear( c[ 0 ] ), toLinear( c[ 1 ] ), toLinear( c[ 2 ] ) );
				if ( i < divisions && j < divisions ) { const a = j * ( divisions + 1 ) + i, b = a + divisions + 1; indices.push( a, b, a + 1, b, b + 1, a + 1 ); }
			}
			const geometry = new T.BufferGeometry();
			geometry.setAttribute( 'position', new T.Float32BufferAttribute( positions, 3 ) );
			geometry.setAttribute( 'color', new T.Float32BufferAttribute( colors, 3 ) );
			geometry.setIndex( indices ); geometry.computeVertexNormals();
			const terrain = new T.Mesh( geometry, new T.MeshStandardMaterial( { vertexColors: true, roughness: 0.94, side: T.DoubleSide } ) );
			terrain.receiveShadow = true; this.scene.add( terrain );
		}
		progress( 0.52, 'Mapping the coastal swell…' );
		const waterTerrain = webglTerrainWaterTexture( T, this.terrain );
		waterTerrain.shore = webglShoreFieldTexture( T, this.terrain, this.worldSeaLevel );
		this.shoreField = waterTerrain.shore?.field || null;
		this.waterScene.add( this._makeWater( new T.PlaneGeometry( 4000, 4000, 768, 768 ), this.worldSeaLevel, waterTerrain, 1 ) );
		const beachBounds = { xMin: WORLD.beach.xMin - 50, xMax: WORLD.beach.xMax + 50, zMin: - 120, zMax: 40 };
		const beachPatch = this._makeWater( new T.PlaneGeometry( beachBounds.xMax - beachBounds.xMin, beachBounds.zMax - beachBounds.zMin, 672, 256 ), this.worldSeaLevel, waterTerrain, 2, beachBounds );
		beachPatch.position.x = ( WORLD.beach.xMin + WORLD.beach.xMax ) * 0.5;
		beachPatch.position.z = - 40;
		this.waterScene.add( beachPatch );
		this.waterScene.add( webglBreakerSpray( T, this.terrain, waterTerrain, this.worldSeaLevel ) );
		progress( 0.55, 'Loading the island village…' );
		try {
			const model = await this.loader.loadAsync( this.defaultWorldAssets.villageLOD );
			model.scene.traverse( object => {
				if ( ! object.isMesh ) return;
				object.castShadow = true;
				object.receiveShadow = true;
				for ( const material of Array.isArray( object.material ) ? object.material : [ object.material ] ) {
					if ( /(?:^| )(?:wood|sign-wood|lantern-wood)$/i.test( material.name ) ) material.color.set( 0x80532f );
				}
			} );
			this.scene.add( model.scene );
			this._collectBlockers( model.scene );
		} catch ( error ) {
			console.warn( 'WebGL fallback village model unavailable:', error );
		}
		await this._loadPackagedReef();
		await this._loadVegetation();
		const start = WORLD.start || WORLD.spawn;
		this.spawn = { position: [ start.position[ 0 ], this.terrain.heightAt( start.position[ 0 ], start.position[ 2 ] ) + 1.7, start.position[ 2 ] ], yaw: start.yaw, pitch: - 0.05 };
		this.grass = webglGrassMesh( T, this.terrain, { position: new T.Vector3( start.position[ 0 ], 0, start.position[ 2 ] ) } );
		this.scene.add( this.grass );
		this.grassCenter = new T.Vector2( start.position[ 0 ], start.position[ 2 ] );
		progress( 0.9, 'Starting the WebGL island…' );

	}

	_addIslandGameplayColliders() {

		const C = this.app.worldState.colliders, P = WORLD.pier, y = P.deckHeight;
		const box = ( x, cy, z, hx, hy, hz, tag, options = {} ) => C.addBox( new EngineVector3( x, cy, z ), new EngineVector3( hx, hy, hz ), 0, { tag, ...options } );
		const stepGround = this.terrain.heightAt( P.x, P.zStart - 0.7 ), nSteps = Math.max( 2, Math.ceil( Math.max( 0, y - stepGround ) / 0.22 ) ), tread = 0.32;
		for ( let k = 1; k < nSteps; k ++ ) {
			const zc = P.zStart - ( k - 0.5 ) * tread, top = pierWalkableHeightAt( P.x, zc, ( px, pz ) => this.terrain.heightAt( px, pz ) ), gb = this.terrain.heightAt( P.x, zc );
			box( P.x, ( top + gb - 0.4 ) * 0.5, zc, P.width * 0.5, ( top - gb + 0.4 ) * 0.5, tread * 0.5 + 0.005, 'pierStep', { walkable: true } );
		}
		// Walkable pier deck and T-head.
		box( P.x, y - 0.04, ( P.zStart + P.zEnd ) * 0.5, P.width * 0.5, 0.04, ( P.zEnd - P.zStart ) * 0.5, 'pierDeck', { walkable: true } );
		box( P.x, y - 0.04, P.zEnd - P.headDepth * 0.5, P.headWidth * 0.5, 0.04, P.headDepth * 0.5, 'pierDeck', { walkable: true } );
		// The ladder is on the outer (+X) T-head edge at z = 35.1. Its rungs
		// are walkable, non-solid stepping surfaces for the shared swimmer.
		const ladderX = P.x + P.headWidth * 0.5 + 0.07, ladderZ = 35.1;
		for ( let rungY = - 0.15; rungY < y; rungY += 0.3 ) if ( rungY >= - 0.4 ) box( ladderX + 0.25, rungY - 0.15, ladderZ, 0.27, 0.15, 0.3, 'ladder', { walkable: true, solid: false } );
		// Solid rail/hull boundaries, with a deliberate opening at the ladder.
		const side = ( x, za, zb ) => box( x, ( y - 2 ) * 0.5, ( za + zb ) * 0.5, 0.22, ( y + 2 ) * 0.5, ( zb - za ) * 0.5, 'pierRail' );
		side( P.x - P.width * 0.5 - 0.2, P.zStart + 3, P.zEnd + P.headDepth );
		side( P.x + P.width * 0.5 + 0.2, P.zStart + 3, P.zEnd + P.headDepth );
		side( P.x + P.headWidth * 0.5, P.zEnd - P.headDepth, ladderZ - 1 );
		side( P.x + P.headWidth * 0.5, ladderZ + 1, P.zEnd );
		side( P.x - P.headWidth * 0.5, P.zEnd - P.headDepth, P.zEnd );

	}

	async _loadVegetation( { placementBytes = null, centerPosition = null } = {} ) {

		const packaged = placementBytes !== null;
		try {
			let expectedSeed;
			if ( ! placementBytes ) {
				const response = await fetch( this.defaultWorldAssets.vegetationPlacements );
				if ( ! response.ok ) throw new Error( `Vegetation placement asset returned ${response.status}` );
				placementBytes = new Uint8Array( await response.arrayBuffer() );
				expectedSeed = 7;
			}
			const records = decodeVegetationPlacements( asBytes( placementBytes ), expectedSeed );
			this.vegetationRecords ||= {};
			appendVegetationPlacements( this.vegetationRecords, records );
			const start = WORLD.start || WORLD.spawn;
			const center = centerPosition || [ start.position[ 0 ], start.position[ 2 ] ];
			const T = this.THREE, group = new T.Group();
			const material = webglPlantMaterial( T ), anchoredMaterial = webglPlantMaterial( T, true );
			const distance = record => Math.hypot( record.x - center[ 0 ], record.z - center[ 1 ] );
			const add = ( kind, build, maxDistance, heightScale, castShadow = false, anchored = false ) => {
				const selected = records[ kind ].filter( record => record.y > 0 && distance( record ) <= maxDistance );
				if ( ! selected.length ) return;
				const source = build(), geometry = webglPlantGeometry( T, source.geometry );
				const mesh = new T.InstancedMesh( geometry, anchored ? anchoredMaterial : material, selected.length ), matrix = new T.Matrix4(), position = new T.Vector3(), rotation = new T.Quaternion(), scale = new T.Vector3();
				if ( anchored ) {
					const instanceScale = new Float32Array( selected.length ), instanceHeight = new Float32Array( selected.length );
					for ( let i = 0; i < selected.length; i ++ ) { instanceScale[ i ] = selected[ i ].s; instanceHeight[ i ] = selected[ i ].H; }
					geometry.setAttribute( 'instanceScale', new T.InstancedBufferAttribute( instanceScale, 1 ) );
					geometry.setAttribute( 'instanceHeight', new T.InstancedBufferAttribute( instanceHeight, 1 ) );
				}
				for ( let i = 0; i < selected.length; i ++ ) {
					const record = selected[ i ], h = heightScale( record );
					position.set( record.x, record.y, record.z );
					rotation.setFromAxisAngle( new T.Vector3( 0, 1, 0 ), record.yaw );
					scale.set( anchored ? 1 : record.s, anchored ? 1 : h * ( record.sy ?? 1 ), anchored ? 1 : record.s );
					matrix.compose( position, rotation, scale ); mesh.setMatrixAt( i, matrix );
				}
				mesh.instanceMatrix.needsUpdate = true;
				mesh.computeBoundingSphere();
				mesh.castShadow = castShadow;
				if ( anchored ) mesh.frustumCulled = false;
				mesh.name = `WebGL ${kind}`;
				group.add( mesh );
			};
			add( 'palms', buildPalmFar, 480, record => record.H, true, true );
			add( 'trees', buildTreeNear, 110, record => record.s, true );
			add( 'shrubs', buildShrubNear, 145, record => record.s );
			add( 'youngPalms', buildYoungPalm, 175, record => record.H, false, true );
			add( 'ferns', buildFern, 125, record => record.H, false, true );
			add( 'bananas', buildBanana, 180, record => record.s, true );
			add( 'monsteras', buildMonstera, 175, record => record.s );
			add( 'elephantEars', buildElephantEar, 175, record => record.s );
			add( 'heliconias', buildHeliconia, 175, record => record.s );
			add( 'strelitzias', buildStrelitzia, 175, record => record.s );
			const distantTrees = records.trees.filter( record => {
				const d = distance( record );
				return record.y > 0 && d > 110 && d < 1400;
			} );
			if ( distantTrees.length ) {
				const trunk = new T.CylinderGeometry( 0.11, 0.2, 1, 5 ); trunk.translate( 0, 0.5, 0 );
				const crownLobe = new T.SphereGeometry( 1, 5, 3 );
				const trunkMesh = new T.InstancedMesh( trunk, new T.MeshStandardMaterial( { color: 0x574431, roughness: 1 } ), distantTrees.length );
				const matrix = new T.Matrix4(), position = new T.Vector3(), rotation = new T.Quaternion(), scale = new T.Vector3();
				for ( let i = 0; i < distantTrees.length; i ++ ) {
					const record = distantTrees[ i ], h = record.H;
					position.set( record.x, record.y, record.z ); rotation.setFromAxisAngle( new T.Vector3( 0, 1, 0 ), record.yaw );
					scale.set( h * 0.035, h * 0.38, h * 0.035 );
					matrix.compose( position, rotation, scale ); trunkMesh.setMatrixAt( i, matrix );
				}
				trunkMesh.instanceMatrix.needsUpdate = true;
				trunkMesh.computeBoundingSphere();
				trunkMesh.name = 'WebGL distant trunks'; group.add( trunkMesh );
				const crownColors = [ 0x416b35, 0x527b3b, 0x365f31, 0x47723a, 0x3b6332, 0x527b3b, 0x416b35, 0x365f31 ];
				for ( let l = 0; l < TREE_LOBES.length; l ++ ) {
					const [ ox, oy, oz, radius ] = TREE_LOBES[ l ];
					const mesh = new T.InstancedMesh( crownLobe, new T.MeshStandardMaterial( { color: crownColors[ l ], roughness: 1 } ), distantTrees.length );
					for ( let i = 0; i < distantTrees.length; i ++ ) {
						const record = distantTrees[ i ], s = record.s, sy = record.sy ?? 1, c = Math.cos( record.yaw ), sn = Math.sin( record.yaw );
						position.set( record.x + ( ox * c - oz * sn ) * s, record.y + oy * s * sy, record.z + ( ox * sn + oz * c ) * s );
						rotation.setFromAxisAngle( new T.Vector3( 0, 1, 0 ), record.yaw );
						scale.set( radius * s, radius * s * sy, radius * s );
						matrix.compose( position, rotation, scale ); mesh.setMatrixAt( i, matrix );
					}
					mesh.instanceMatrix.needsUpdate = true;
					mesh.computeBoundingSphere();
					mesh.name = 'WebGL distant canopy lobe'; group.add( mesh );
				}
			}
			this.scene.add( group );
		} catch ( error ) {
			if ( packaged ) throw error;
			console.warn( 'WebGL fallback vegetation unavailable:', error );
		}

	}

	async _loadHostedWorld( progress ) {

		this.connector = this.app.worldConnector || new WorldConnector( this.worldLink );
		progress( 0.12, 'Connecting to hosted world…' );
		let manifest;
		if ( this.app.worldManifestPromise ) {
			const result = await this.app.worldManifestPromise;
			if ( result.error ) throw result.error;
			manifest = result.manifest;
		} else manifest = await this.connector.getManifest();
		let localSpawn = null;
		let assets;
		const components = manifest.components || [];
		const T = this.THREE, cache = new Map(), lodQueue = new LODLoadQueue();
		this.hostedModelCache = cache;
		this.worldLODs = new Map();
		this.hostedObjectRoots ||= new Map();
		if ( this.connector.localOnly ) {
			const entry = await chooseWorldEntryPoint( manifest );
			localSpawn = worldEntryPointPose( entry ) || worldSpawnPose( manifest );
			this.camera.position.set( ...localSpawn.position );
			this.camera.rotation.order = 'YXZ';
			this.camera.rotation.set( localSpawn.pitch || 0, localSpawn.yaw || 0, 0 );
			const initialObjects = selectLocalRegionStartupObjects( this.connector, manifest, this.camera, localSpawn );
			const initialComponents = selectWorldComponentsForView( manifest, this.camera, { maxPriority: 'nearby' } );
			const initialObjectIDs = new Set( initialObjects.map( object => object.id ) );
			const assetIDs = new Set( manifest.objects.filter( object => initialObjectIDs.has( object.id ) && object.assetId ).map( object => object.assetId ) );
			const retainAssetIDs = new Set( initialComponents.flatMap( component => ( component.assets || [] ).map( reference => reference.assetId ) ) );
			for ( const assetId of retainAssetIDs ) assetIDs.add( assetId );
			for ( const extension of manifest.experience?.extensions || [] ) {
				assetIDs.add( extension.assetId );
				retainAssetIDs.add( extension.assetId );
			}
			const objectsByAsset = new Map();
			for ( const object of initialObjects ) {
				if ( ! object.assetId ) continue;
				const objects = objectsByAsset.get( object.assetId ) || [];
				objects.push( object );
				objectsByAsset.set( object.assetId, objects );
			}
			this.localLoadedObjectIDs = new Set( initialObjects.filter( object => ! object.assetId ).map( object => object.id ) );
			assets = await this.connector.preload( {
				assetIDs,
				retainAssets: false,
				retainAssetIDs,
				onAsset: async ( assetId, bytes ) => {
					const objects = objectsByAsset.get( assetId ) || [];
					if ( ! objects.length ) return;
					if ( this.connector.collisionAssetIDs.has( assetId ) ) {
						for ( const object of objects ) {
							const shapes = registerWorldPackageCollisionPayload( bytes, object, this.app.hostedColliders );
							if ( shapes.length ) this.hostedCollisionPayloads.set( object.id, shapes );
							this.localLoadedObjectIDs.add( object.id );
						}
						return;
					}
					let model = cache.get( assetId );
					if ( ! model ) {
						const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength );
						model = await this.loader.parseAsync( buffer, '' );
						cache.set( assetId, model );
					}
					for ( const object of objects ) {
						const root = new T.Group();
						const base = model.scene.clone( true );
						prepareHostedWebGLModel( base );
						prepareWebGLLODFade( base );
						base.name = `${ object.label || object.id } · LOD 0`;
						root.add( base );
						const tr = object.transform || {};
						root.position.set( ...( tr.position || [ 0, 0, 0 ] ) );
						if ( tr.rotation ) root.quaternion.set( ...tr.rotation ); else root.rotation.y = tr.yaw || 0;
						root.scale.set( ...( object.scale || [ 1, 1, 1 ] ) );
						root.updateMatrixWorld( true );
						this.scene.add( root );
						this.hostedObjectRoots.set( object.id, root );
						this.localLoadedObjectIDs.add( object.id );
					}
					if ( objects.length === 1 && ! objects[ 0 ].lods?.length ) cache.delete( assetId );
				},
				onProgress: ( done, total ) => globalThis.__ui?.setLoadingDetail( done, total ),
			} );
			for ( const object of initialObjects ) if ( object.assetId && ! this.connector.regionAssets.has( object.assetId ) && assets.has( object.assetId ) ) this.localLoadedObjectIDs.add( object.id );
		} else {
			assets = await this.connector.preload( { through: 'visible' } );
			this.localLoadedObjectIDs = new Set( manifest.objects.filter( object => object.assetId && assets.has( object.assetId ) ).map( object => object.id ) );
		}
		this.hostedWildlifeComponent = components.find( component => worldComponentDescriptor( component.type )?.wildlifeSimulation ) || null;
		const terrainComponent = components.find( component => component.type === 'elsemesh.terrain-surface/1' );
		this.hostedTerrainComponent = terrainComponent;
		const villageMaterialComponent = components.find( component => component.type === 'elsemesh.village-materials/2' );
		let villageMaterials = null, villageMaterialApplied = 0;
		if ( villageMaterialComponent && assets.has( villageMaterialComponent.dataAssetId ) ) {
			try {
				const decoded = await decodeWorldComponentAsset( 'village-materials/1', asBytes( assets.get( villageMaterialComponent.dataAssetId ) ) );
				villageMaterials = createWebGLVillageMaterials( T, decoded, { anisotropy: this.renderer.capabilities.getMaxAnisotropy() } );
			} catch ( error ) {
				console.warn( 'WebGL fallback village materials unavailable:', error );
			}
		}
		this.hostedVillageMaterialComponent = villageMaterialComponent;
		this.hostedVillageMaterials = villageMaterials;
		this.hostedSharedMaterials = new Set( Object.values( villageMaterials || {} ) );
		let terrainSurface = null, hostedTerrainMaterial = null, hostedTerrainVisualReady = false;
		if ( terrainComponent && assets.has( terrainComponent.dataAssetId ) ) {
			const terrainBytes = assets.get( terrainComponent.dataAssetId );
			terrainSurface = await decodeTerrainSurfaceAsset( asBytes( terrainBytes ) );
			this.hostedTerrainSurface = terrainSurface;
			this.hostedTerrainData = new HeightfieldTerrainData( { size: terrainSurface.size, origin: terrainSurface.origin, resolution: terrainSurface.resolution, heights: terrainSurface.heights, splat: terrainSurface.splat } );
		}
		for ( const object of manifest.objects || [] ) {

			if ( object.kind !== 'asset-instance' ) continue;
			const bytes = assets.get( object.assetId );
			if ( ! bytes ) continue;
			let model = cache.get( object.assetId );
			if ( ! model ) {
				const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength );
				model = await this.loader.parseAsync( buffer, '' );
				cache.set( object.assetId, model );
			}
			const root = new T.Group();
			const base = model.scene.clone( true );
			prepareHostedWebGLModel( base );
			if ( object.id === villageMaterialComponent?.objectId && villageMaterials ) villageMaterialApplied += applyWebGLVillageMaterials( base, villageMaterials );
			if ( object.id === terrainComponent?.objectId && terrainSurface ) {
				hostedTerrainMaterial ||= webglTerrainMaterial( T, this.hostedTerrainData, terrainSurface );
				this.hostedTerrainMaterial = hostedTerrainMaterial;
				applyHostedTerrainMaterial( base, hostedTerrainMaterial );
				this.terrainColorTexture = hostedTerrainMaterial.userData.terrainTextures[ 0 ];
				hostedTerrainVisualReady = true;
			}
			prepareWebGLLODFade( base );
			base.name = `${ object.label || object.id } · LOD 0`;
			root.add( base );
			const tr = object.transform || {};
			root.position.set( ...( tr.position || [ 0, 0, 0 ] ) );
			if ( tr.rotation ) root.quaternion.set( ...tr.rotation ); else root.rotation.y = tr.yaw || 0;
			root.scale.set( ...( object.scale || [ 1, 1, 1 ] ) );
			root.updateMatrixWorld( true );
			this.scene.add( root );
			this.hostedObjectRoots ||= new Map();
			this.hostedObjectRoots.set( object.id, root );
			if ( object.lods?.length ) {
				const levels = new Map( [ [ 0, base ] ] );
				this.worldLODs.set( object.id, new WorldObjectLOD( {
					object,
					loadLevel: ( level, signal ) => lodQueue.run( signal, async () => {
						const assetId = object.lods[ level - 1 ].assetId;
						const bytes = await this.connector.getAsset( assetId, { signal } );
						if ( signal.aborted ) throw signal.reason || new DOMException( 'World unloaded', 'AbortError' );
						let variant = cache.get( assetId );
						if ( ! variant ) {
							const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength );
							variant = await this.loader.parseAsync( buffer, '' );
							cache.set( assetId, variant );
						}
						if ( signal.aborted ) throw signal.reason || new DOMException( 'World unloaded', 'AbortError' );
						const visual = variant.scene.clone( true );
						prepareHostedWebGLModel( visual );
						if ( object.id === villageMaterialComponent?.objectId && villageMaterials ) villageMaterialApplied += applyWebGLVillageMaterials( visual, villageMaterials );
						if ( object.id === terrainComponent?.objectId && hostedTerrainMaterial ) applyHostedTerrainMaterial( visual, hostedTerrainMaterial );
						prepareWebGLLODFade( visual );
						visual.name = `${ object.label || object.id } · LOD ${ level }`;
						visual.visible = false;
						root.add( visual );
						levels.set( level, visual );
					} ),
					showLevel: level => {
						for ( const [ index, visual ] of levels ) {
							visual.visible = index === level;
							setWebGLLODFade( visual, 1 );
						}
					},
					showTransition: ( from, to, fade ) => {
						for ( const [ index, visual ] of levels ) {
							visual.visible = index === from || index === to;
							if ( index === from ) setWebGLLODFade( visual, 1 - fade );
							else if ( index === to ) setWebGLLODFade( visual, fade );
						}
					},
				} ) );
			}


		}
		this.portals = ( manifest.portals || [] ).filter( portal => portal.enabled || portal.back?.enabled );
		for ( const portal of this.portals ) this._addPortalMarker( portal );
		this._collectManifestBlockers( manifest.objects || [] );
		const backendComponentIDs = await this._installHostedBackendComponents( components, manifest, assets );
		this.hostedVehicleSpec = resolveHostedWebGLVehicleSpec( components, manifest.objects || [], this.hostedObjectRoots );
		const supportedComponents = initialHostedWebGLSupport( components, {
			terrainReady: !! this.hostedTerrainData, vehicleComponentId: this.hostedVehicleSpec?.component.id,
		} );
		for ( const id of backendComponentIDs ) supportedComponents.add( id );
		if ( villageMaterialApplied > 0 ) supportedComponents.add( villageMaterialComponent.id );
		if ( terrainComponent && hostedTerrainVisualReady ) supportedComponents.add( terrainComponent.id );
		const hostedReefRecords = [], hostedReefIds = [];
		for ( const reef of components.filter( component => component.type === 'elsemesh.static-reef/1' ) ) {
			const placementBytes = assets.get( reef.placementAssetId );
			if ( ! placementBytes ) continue;
			const decoded = decodeReefPlacements( asBytes( placementBytes ) );
			hostedReefRecords.push( ...decoded.records );
			hostedReefIds.push( reef.id );
		}
		if ( hostedReefIds.length ) {
			this.hostedReefAdapter = new WebGLReefAdapter( T, this.scene, hostedReefRecords );
			for ( const id of hostedReefIds ) supportedComponents.add( id );
		}
		for ( const vegetation of components.filter( component => component.type === 'elsemesh.static-vegetation/1' ) ) {
			const placementBytes = assets.get( vegetation.placementAssetId );
			const grassMaskBytes = vegetation.grassMaskAssetId && assets.get( vegetation.grassMaskAssetId );
			if ( ! placementBytes || vegetation.grassMaskAssetId && ! grassMaskBytes ) continue;
			if ( vegetation.grassMaskAssetId ) {
				this.hostedGrassMask = decodeGrassDensityAsset( asBytes( grassMaskBytes ) );
				if ( ! this.hostedTerrainData ) throw new Error( `Static grass component ${vegetation.id} requires its terrain surface` );
				if ( this.hostedGrassMask.size !== this.hostedTerrainData.size || this.hostedGrassMask.origin !== this.hostedTerrainData.origin ) throw new Error( `Static grass component ${vegetation.id} does not match its terrain surface` );
			}
			await this._loadVegetation( { placementBytes, centerPosition: [ ( manifest.spawn?.position || [ 0, 0, 0 ] )[ 0 ], ( manifest.spawn?.position || [ 0, 0, 0 ] )[ 2 ] ] } );
			supportedComponents.add( vegetation.id );
		}
		for ( const ambience of components.filter( component => component.type === 'elsemesh.ambient-audio/1' ) ) {
			if ( ambience.beds.every( bed => assets.has( bed.assetId ) ) ) supportedComponents.add( ambience.id );
		}
		const spawn = localSpawn || manifest.spawn || {};
		this.spawn = { position: spawn.position || [ 0, 1.7, 0 ], yaw: spawn.yaw || 0, pitch: spawn.pitch || 0 };
		const transfer = new URLSearchParams( location.search ).get( 'webglSpawn' )?.split( ',' ).map( Number );
		if ( transfer?.length === 5 && transfer.every( Number.isFinite ) && transfer.slice( 0, 3 ).every( value => Math.abs( value ) <= 100000 ) && Math.abs( transfer[ 3 ] ) <= 1000 && Math.abs( transfer[ 4 ] ) <= 1.5 ) {
			this.spawn = { position: transfer.slice( 0, 3 ), yaw: transfer[ 3 ], pitch: transfer[ 4 ] };
		}
		this.hostedSeaLevel = ( manifest.components || [] ).some( component => worldComponentDescriptor( component.type )?.waterSurface )
			? ( Number.isFinite( manifest.rules?.seaLevel ) ? manifest.rules.seaLevel : 0 ) : null;
		this.worldSeaLevel = this.hostedSeaLevel ?? 0;
		this.hostedComponents = components;
		this.hostedTitle = manifest.title || 'Hosted world';
		this.hostedSupportedComponents = supportedComponents;
		this.hostedWhalePackages = [];
		for ( const component of components.filter( candidate => candidate.type === 'elsemesh.humpback-whale/1' ) ) {
			const ids = [ component.modelAssetId, component.geometryAssetId, component.albedoAssetId, component.heightAssetId ];
			if ( ids.every( id => assets.has( id ) ) ) this.hostedWhalePackages.push( { component, assets: { manifest: assets.get( ids[ 0 ] ), geometry: assets.get( ids[ 1 ] ), albedo: assets.get( ids[ 2 ] ), height: assets.get( ids[ 3 ] ) } } );
		}
		this._updateHostedWebGLStatus();
		progress( 0.9, 'Preparing hosted world…' );

	}

	async _loadPackagedReef() {

		const components = this.defaultWorldSource.components.filter( item => item.type === 'elsemesh.static-reef/1' );
		const recordsByTile = await Promise.all( components.map( async component => {
			const url = this.defaultWorldAssets.reefPlacements[ component.placementAssetId ];
			if ( ! url ) throw new Error( `Default world reef asset ${component.placementAssetId} is missing from its package` );
			const response = await fetch( url );
			if ( ! response.ok ) throw new Error( `Default world reef asset ${component.placementAssetId} returned ${response.status}` );
			return decodeReefPlacements( new Uint8Array( await response.arrayBuffer() ) ).records;
		} ) );
		const records = recordsByTile.flat();
		if ( records.length ) this.reefAdapter = new WebGLReefAdapter( this.THREE, this.scene, records );

	}

	_collectBlockers( root ) {

		const T = this.THREE;
		root.traverse( object => {
			if ( ! object.isMesh ) return;
			const bounds = new T.Box3().setFromObject( object );
			const size = bounds.getSize( new T.Vector3() );
			if ( ! bounds.isEmpty() && size.x > 0.5 && size.z > 0.5 && size.x < 22 && size.z < 22 && size.y > 1 && size.y < 24 ) {
				this.app.worldState.colliders.addBox( new EngineVector3( ( bounds.min.x + bounds.max.x ) / 2, ( bounds.min.y + bounds.max.y ) / 2, ( bounds.min.z + bounds.max.z ) / 2 ), new EngineVector3( size.x / 2, size.y / 2, size.z / 2 ), 0, { tag: 'villageObject' } );
			}
		} );

	}

	_collectManifestBlockers( objects ) {

		for ( const object of objects ) {
			const collision = object.collision;
			if ( ! collision?.enabled || ! [ 'box', 'compound' ].includes( collision.shape ) ) continue;
			const scale = object.scale || [ 1, 1, 1 ], transform = object.transform;
			const boxes = hostedCollisionBoxes( collision );
			for ( const item of boxes ) {
				const yaw = ( transform.yaw || 0 ) + ( item.yaw || 0 ), cos = Math.cos( transform.yaw || 0 ), sin = Math.sin( transform.yaw || 0 );
				const lx = item.center[ 0 ] * scale[ 0 ], lz = item.center[ 2 ] * scale[ 2 ];
				const hx = item.halfExtents[ 0 ] * scale[ 0 ], hz = item.halfExtents[ 2 ] * scale[ 2 ];
				this.app.hostedColliders.addBox( new EngineVector3( transform.position[ 0 ] + lx * cos + lz * sin, transform.position[ 1 ] + item.center[ 1 ] * scale[ 1 ], transform.position[ 2 ] - lx * sin + lz * cos ), new EngineVector3( hx, item.halfExtents[ 1 ] * scale[ 1 ], hz ), yaw, { walkable: item.walkable, solid: item.solid, tag: `world:${object.id}` } );
			}
		}

	}

	async _installHostedBackendComponents( components, manifest, assets ) {

		const T = this.THREE;
		const terrain = this.hostedTerrainData;
		const terrainWater = terrain ? webglTerrainWaterTexture( T, terrain ) : null;
		if ( terrainWater && this.hostedTerrainSurface?.shoreField ) terrainWater.shore = encodeWebGLShoreField( T, this.hostedTerrainSurface.shoreField );
		const installed = new Set();
		for ( const component of components ) {
			const adapter = worldComponentBackendAdapter( this.engine.backend, component.type );
			if ( ! adapter ) continue;
			const result = await adapter( { fallback: this, rules: manifest.rules || {}, terrain, terrainWater, manifest, assets }, component );
			if ( result === true || result?.installed ) installed.add( component.id );
			if ( result?.runtime ) this.hostedComponentRuntimes.push( result.runtime );
		}
		return installed;

	}

	_addPortalMarker( portal ) {

		const T = this.THREE, group = new T.Group(), p = portal.entry.position;
		const frame = new T.MeshStandardMaterial( { color: 0x9acddd, emissive: 0x16404d, roughness: 0.35, metalness: 0.4 } );
		for ( const [ x, y, w, h ] of [ [ - 1.1, 1.5, 0.18, 3 ], [ 1.1, 1.5, 0.18, 3 ], [ 0, 2.9, 2.4, 0.18 ] ] ) {
			const bar = new T.Mesh( new T.BoxGeometry( w, h, 0.16 ), frame );
			bar.position.set( x, y, 0 ); group.add( bar );
		}
		group.position.set( ...p );
		group.rotation.y = portal.entry.yaw || 0;
		this.scene.add( group );

	}

	_makeHUD() {

		const badge = document.createElement( 'div' );
		badge.className = 'elsemesh-webgl-badge';
		badge.textContent = `WebGL fallback · ${ this.engine.fallbackReason }`;
		this.fallbackBadge = badge;
		Object.assign( badge.style, { position: 'fixed', top: '14px', right: '14px', zIndex: 30, maxWidth: 'min(440px, 80vw)', padding: '8px 11px', borderRadius: '8px', color: '#f2f7f4', background: '#14201ddd', font: '12px/1.4 system-ui', pointerEvents: 'none' } );
		document.body.appendChild( badge );
		const hint = document.createElement( 'div' );
		hint.className = 'elsemesh-webgl-hint';
		Object.assign( hint.style, { position: 'fixed', left: '16px', bottom: '16px', zIndex: 30, padding: '10px 12px', borderRadius: '8px', color: '#f2f7f4', background: '#14201ddd', font: '13px/1.5 system-ui', pointerEvents: 'none' } );
		hint.textContent = 'WASD move · mouse look · Shift run · E use portal';
		const style = document.createElement( 'style' );
		style.textContent = '@media (hover:none), (pointer:coarse) { .elsemesh-webgl-hint { bottom:150px !important; } }';
		document.head.appendChild( style );
		document.body.append( hint );
		this.hud = [ badge, hint, style ];
		this.useButton = document.createElement( 'button' );
		this.useButton.textContent = 'Use portal';
		Object.assign( this.useButton.style, { display: 'none', position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: 31, padding: '12px 18px', border: '0', borderRadius: '10px', color: '#f2f7f4', background: '#14201ddd', font: 'bold 15px system-ui' } );
		this.useButton.addEventListener( 'click', () => this._useNearestPortal() ); document.body.append( this.useButton ); this.hud.push( this.useButton );
	}

	_bindInput() {

		this._keyDown = event => {
			if ( event.target instanceof Element && event.target.closest( 'input, select, textarea, [contenteditable="true"]' ) ) return;
			if ( event.code.startsWith( 'Arrow' ) ) event.preventDefault();
			const experience = this.worldLink ? this.connector?.manifest?.experience : this.defaultWorldSource.experience;
			if ( dispatchWorldBehaviorHooks( experience, 'onWebGLKeyDown', { fallback: this, event, extensions: this.activeWorldExtensions } ) ) { event.preventDefault(); event.stopImmediatePropagation(); return; }
			if ( this.worldLink && event.code === 'KeyE' ) this._useNearestPortal();
		};
		this._resize = () => {
			const w = window.innerWidth, h = window.innerHeight;
			this.camera.aspect = w / Math.max( 1, h );
			this.camera.updateProjectionMatrix();
			this.renderer.setSize( w, h );
			const size = this.renderer.getDrawingBufferSize( new this.THREE.Vector2() );
			this.sceneColorTexture.image.width = size.x;
			this.sceneColorTexture.image.height = size.y;
			this.sceneColorTexture.needsUpdate = true;
			for ( const water of this.waterScene.children ) water.material.uniforms.uViewport?.value.copy( size );
		};
		// Capture key events before UI descendants can stop them from reaching the fallback.
		window.addEventListener( 'keydown', this._keyDown, true );
		this.requestLock = () => this.input?.requestLock?.() || this.engine.canvas.requestPointerLock?.();
		this.engine.canvas.addEventListener( 'click', this.requestLock );

	}

	_frame() {

		const now = performance.now(), dt = Math.min( 0.1, Math.max( 0, ( now - ( this.lastFrame || now ) ) / 1000 ) );
		this.app.updateFPS( dt );
		this.app.hud?.setStats( { fps: this.app.fps, frameMs: dt * 1000 } );
		const simulationTime = ( now - this.animationStartTime ) * 0.001;
		this.lastFrame = now;
		for ( const lod of this.worldLODs?.values() || [] ) lod.update( this.camera, now );
		for ( const runtime of this.hostedComponentRuntimes || [] ) runtime.update( dt, this.camera, this.player );
		if ( this.waterQuery ) {
			this.waterQuery.setCamera( this.camera.position.x, this.camera.position.z );
			this.boat?.controller?.queueQueries();
			this.waterQuery.update( dt, simulationTime );
		}
		this.boat?.update( dt );
		for ( const whale of this.whales || [] ) whale.update( dt, this.camera );
		this.spray?.update( dt );
		const T = this.THREE;
		this._updateLighting();
		this.cloudLayer.position.copy( this.camera.position );
		this.cloudLayer.material.uniforms.uTime.value = simulationTime;
		this.cloudLayer.material.uniforms.uCameraPosition.value.copy( this.camera.position );
		for ( const object of this.waterScene.children ) {
			object.material.uniforms.uTime.value = simulationTime;
			object.material.uniforms.uCameraPosition?.value.copy( this.camera.position );
		}
		const experience = this.worldLink ? this.connector?.manifest?.experience : this.defaultWorldSource.experience;
		const gamePanelOpen = dispatchWorldBehaviorHooks( experience, 'onWebGLBlocksPlayerInput', { fallback: this, extensions: this.activeWorldExtensions } );
		if ( this.player && ! gamePanelOpen ) {
			if ( this.worldLink ) this.player.updateHostedWorld( dt );
			else this.player.update( dt );
		}
		if ( this.worldLink ) this._updateHostedWorldStreaming();
		this.useButton.style.display = this._nearestPortalRoute() ? '' : 'none';
		const grassDx = this.grassCenter ? this.camera.position.x - this.grassCenter.x : 0, grassDz = this.grassCenter ? this.camera.position.z - this.grassCenter.y : 0;
		if ( this.grass && ( this.terrain || this.hostedTerrainData ) && grassDx * grassDx + grassDz * grassDz > 64 ) {
			this.scene.remove( this.grass );
			this.grass = webglGrassMesh( T, this.terrain || this.hostedTerrainData, this.camera, this.grass, this.hostedGrassMask || null );
			this.scene.add( this.grass );
			this.grassCenter.set( this.camera.position.x, this.camera.position.z );
		}
		if ( this.beachDebris ) {
			const dx = this.camera.position.x - this.debrisCenter.x, dz = this.camera.position.z - this.debrisCenter.y;
			if ( dx * dx + dz * dz > 36 ) {
				webglBeachDebris( T, this.terrain, this.camera, this.beachDebris );
				this.debrisCenter.set( this.camera.position.x, this.camera.position.z );
			}
		}
		this.reefAdapter?.update( this.camera, simulationTime, this.defaultWorldSource.rules.seaLevel ?? 0 );
		this.hostedReefAdapter?.update( this.camera, simulationTime, this.hostedSeaLevel ?? 0 );
		dispatchWorldBehaviorHooks( experience, 'onWebGLWorldFrame', { fallback: this, mode: this.worldLink ? 'hosted' : 'builtin', dt, simulationTime, extensions: this.activeWorldExtensions } );
		if ( this.wildlifeRuntime ) {
			const sunY = this._sunDirection( this.app.settings.timeOfDay ).y;
			this.wildlifeRuntime.update( dt, this.camera, this.player, {
				windX: DEFAULT_WILDLIFE_ENVIRONMENT.windX, windZ: DEFAULT_WILDLIFE_ENVIRONMENT.windZ,
				windSpeed: DEFAULT_WILDLIFE_ENVIRONMENT.windSpeed,
				night: T.MathUtils.smoothstep( - sunY, 0.02, 0.18 ), sunY,
				seaLevel: this.hostedSeaLevel ?? DEFAULT_WILDLIFE_ENVIRONMENT.seaLevel,
			} );
			this.wildlifeAdapter.update( this.wildlifeRuntime, this.camera );
		}
		this._updateAudio( dt );
		this.renderer.autoClear = true;
		this.renderer.render( this.scene, this.camera );
		if ( this.waterScene.children.length && ! this.debugNoWater ) {
			this.renderer.copyFramebufferToTexture( this.sceneColorTexture );
			this.renderer.autoClear = false;
			this.renderer.render( this.waterScene, this.camera );
			this.renderer.autoClear = true;
		}
		this.input.endFrame();

	}

	_updateHostedWorldStreaming() {

		const connector = this.connector;
		if ( ! connector?.manifest || this.hostedWorldStreaming || performance.now() - ( this.hostedWorldStreamingAt || 0 ) < 400 ) return;
		this.hostedWorldStreamingAt = performance.now();
		const manifest = connector.manifest;
		const loaded = this.localLoadedObjectIDs || ( this.localLoadedObjectIDs = new Set() );
		const objects = selectWorldObjectsForView( manifest, this.camera, {
			nearbyDistance: connector.localOnly ? connector.cellSizeMeters || 8 : 24,
			maxDistance: connector.localOnly ? connector.maxViewDistanceMeters : 500,
		} )
			.filter( object => ! connector.localOnly || ! object.collisionPayload );
		const viewObjectIDs = new Set( objects.map( object => object.id ) );
		if ( connector.localOnly ) {
			const released = [];
			const center = new this.THREE.Vector3();
			for ( const object of manifest.objects ) {
				if ( ! object.regionCell || ! object.streamingBounds || ! loaded.has( object.id ) ) continue;
				transformBoundsCenter( object, object.streamingBounds.center, center );
				if ( this.camera.position.distanceTo( center ) > 64 && ! viewObjectIDs.has( object.id ) ) released.push( object );
			}
			for ( const object of released ) {
				for ( const { kind, collider } of this.hostedCollisionPayloads.get( object.id ) || [] ) {
					if ( kind === 'box' ) this.app.hostedColliders.removeBox( collider );
					else this.app.hostedColliders.removeCylinder( collider );
				}
				this.hostedCollisionPayloads.delete( object.id );
				const root = this.hostedObjectRoots?.get( object.id );
				if ( root ) {
					root.traverse( node => {
						for ( const material of Array.isArray( node.material ) ? node.material : [ node.material ] ) {
							if ( material && ! this.hostedSharedMaterials?.has( material ) ) material.dispose?.();
						}
					} );
					root.parent?.remove( root );
					root.clear();
					this.hostedObjectRoots.delete( object.id );
				}
				this.worldLODs?.get( object.id )?.dispose();
				this.worldLODs?.delete( object.id );
				loaded.delete( object.id );
			}
			if ( released.length ) {
				const retainedAssets = new Set();
				const evictedAssets = new Set();
				for ( const object of manifest.objects ) {
					if ( ! loaded.has( object.id ) ) continue;
					if ( object.assetId ) retainedAssets.add( object.assetId );
					for ( const lod of object.lods || [] ) retainedAssets.add( lod.assetId );
				}
				for ( const [ assetId, model ] of this.hostedModelCache || [] ) {
					if ( retainedAssets.has( assetId ) ) continue;
					disposeHostedWebGLModel( model );
					this.hostedModelCache.delete( assetId );
					connector.releaseAsset?.( assetId );
					evictedAssets.add( assetId );
				}
				for ( const object of released ) {
					if ( object.assetId && ! retainedAssets.has( object.assetId ) && ! evictedAssets.has( object.assetId ) ) connector.releaseAsset?.( object.assetId );
					for ( const lod of object.lods || [] ) if ( ! retainedAssets.has( lod.assetId ) && ! evictedAssets.has( lod.assetId ) ) connector.releaseAsset?.( lod.assetId );
				}
			}
		}
		if ( connector.localOnly && connector.collisionObjectIDsAlongPath && this.player ) {
			const position = this.player.position;
			const axes = this.input.moveAxes();
			const direction = new this.THREE.Vector3( - Math.sin( this.player.yaw ), 0, - Math.cos( this.player.yaw ) );
			if ( axes.x || axes.y ) {
				const forward = direction.clone().multiplyScalar( axes.y );
				const right = new this.THREE.Vector3( - direction.z, 0, direction.x ).multiplyScalar( axes.x );
				direction.copy( forward.add( right ) );
			}
			const sprinting = this.input.down( 'ShiftLeft' ) || this.input.down( 'ShiftRight' );
			const speed = Math.max( sprinting ? this.player.worldMovement.sprintSpeed : this.player.worldMovement.walkSpeed, this.player.velocity.length() );
			const cellSize = connector.cellSizeMeters || 8;
			const lookahead = collisionLookaheadDistance( speed, connector.collisionLoadLatencyMs || 2000, cellSize );
			const destination = position.clone().addScaledVector( direction.normalize(), lookahead );
			const selected = new Set( objects.map( object => object.id ) );
			for ( const objectID of connector.collisionObjectIDsAlongPath( position, destination ) ) selected.add( objectID );
			const objectByID = new Map( manifest.objects.map( object => [ object.id, object ] ) );
			for ( const objectID of selected ) {
				const object = objectByID.get( objectID );
				if ( object && ! objects.includes( object ) ) objects.push( object );
			}
		}
		const wanted = objects.filter( object => ! loaded.has( object.id ) );
		if ( wanted.length === 0 ) return;
		if ( connector.localOnly ) {
			const center = new this.THREE.Vector3();
			wanted.sort( ( a, b ) => {
				const aCollision = a.collisionPayload ? 0 : 1, bCollision = b.collisionPayload ? 0 : 1;
				if ( aCollision !== bCollision ) return aCollision - bCollision;
				transformBoundsCenter( a, a.streamingBounds.center, center );
				const aDistance = this.camera.position.distanceToSquared( center );
				transformBoundsCenter( b, b.streamingBounds.center, center );
				return aDistance - this.camera.position.distanceToSquared( center );
			} );
			wanted.length = Math.min( wanted.length, LOCAL_REGION_STREAM_BATCH_SIZE );
		}
		const assetIDs = new Set( wanted.map( object => object.assetId ).filter( Boolean ) );
		this.hostedWorldStreaming = true;
		connector.preload( { assetIDs, concurrency: 1 } ).then( async assets => {
			for ( const object of wanted ) {
				if ( loaded.has( object.id ) ) continue;
				if ( object.assetId && ! assets.has( object.assetId ) ) continue;
				if ( object.collisionPayload ) {
					const shapes = registerWorldPackageCollisionPayload( assets.get( object.assetId ), object, this.app.hostedColliders );
					if ( shapes.length ) this.hostedCollisionPayloads.set( object.id, shapes );
					loaded.add( object.id );
					continue;
				}
				if ( object.assetId ) {
					let model = this.hostedModelCache.get( object.assetId );
					if ( ! model ) {
						const bytes = assets.get( object.assetId );
						const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength );
						model = await this.loader.parseAsync( buffer, '' );
						this.hostedModelCache.set( object.assetId, model );
					}
					const root = new this.THREE.Group(), base = model.scene.clone( true );
					prepareHostedWebGLModel( base );
					if ( object.id === this.hostedVillageMaterialComponent?.objectId && this.hostedVillageMaterials ) applyWebGLVillageMaterials( base, this.hostedVillageMaterials );
					if ( object.id === this.hostedTerrainComponent?.objectId && this.hostedTerrainMaterial ) applyHostedTerrainMaterial( base, this.hostedTerrainMaterial );
					prepareWebGLLODFade( base );
					base.name = `${ object.label || object.id } · LOD 0`;
					root.add( base );
					const tr = object.transform || {};
					root.position.set( ...( tr.position || [ 0, 0, 0 ] ) );
					if ( tr.rotation ) root.quaternion.set( ...tr.rotation ); else root.rotation.y = tr.yaw || 0;
					root.scale.set( ...( object.scale || [ 1, 1, 1 ] ) );
					root.updateMatrixWorld( true );
					this.scene.add( root );
					this.hostedObjectRoots ||= new Map();
					this.hostedObjectRoots.set( object.id, root );
				}
				loaded.add( object.id );
			}
		} ).catch( error => {
			console.warn( `WebGL hosted-world streaming failed for ${connector.worldId}`, error );
		} ).finally( () => { this.hostedWorldStreaming = false; } );

	}

	_updateAudio( dt ) {

		const audio = this.app.audio;
		if ( ! audio ) return;
		const p = this.camera.position, fwd = new this.THREE.Vector3();
		this.camera.getWorldDirection( fwd );
		if ( this.worldLink && this.connector?.manifest ) {
			const components = ( this.connector.manifest.components || [] ).filter( component => component.type === 'elsemesh.ambient-audio/1' );
			audio.setWorldAmbience( this.connector.worldId, components, this.connector.assets );
			if ( ! audio.enabled ) return;
			const seaLevel = this.hostedSeaLevel ?? 0;
			const sunHeight = this._sunDirection( this.app.settings.timeOfDay ).y;
			audio.updateWorldAudio( dt, {
				listener: { position: p, forward: fwd, up: new this.THREE.Vector3( 0, 1, 0 ).applyQuaternion( this.camera.quaternion ) },
				underwater: p.y < seaLevel ? 1 : 0,
				depthBelowSurface: Math.max( 0, seaLevel - p.y ),
				daylight: 1 - this.THREE.MathUtils.smoothstep( - sunHeight, 0.02, 0.18 ),
				timeOfDay: this.app.settings.timeOfDay,
			} );
			return;
		}
		if ( ! audio.enabled ) return;
		const coast = this.terrain?.coastDistance?.( p.x, p.z )?.d ?? 60;
		const boat = this.boat?.controller;
		audio.update( dt, {
			listener: { position: p, forward: fwd, up: new this.THREE.Vector3( 0, 1, 0 ) },
			underwater: p.y < this.worldSeaLevel ? 1 : 0,
			depthBelowSurface: Math.max( 0, this.worldSeaLevel - p.y ),
			distanceToShore: Math.abs( coast ), coastDistance: coast,
			nearPier: Math.abs( p.x - WORLD.pier.x ) < 12 && p.z > WORLD.pier.zStart - 5 && p.z < WORLD.pier.zEnd + 8,
			boat: { active: !! boat?.driven, rpm: boat?.rpm || 0, speed: boat?.velocity?.length?.() || 0, position: this.boat?.model?.group?.position, listenerInside: false },
		} );

	}

	_useNearestPortal() {

		if ( ! this.portals.length || ! this.worldLink ) return;
		const route = this._nearestPortalRoute();
		if ( ! route ) return;
		const url = new URL( location.href );
		url.searchParams.set( 'worldId', route.destinationWorldId );
		if ( route.destinationPeerId ) url.searchParams.set( 'nodeId', route.destinationPeerId ); else url.searchParams.delete( 'nodeId' );
		if ( route.destinationGateway ) url.searchParams.set( 'gateway', route.destinationGateway ); else url.searchParams.delete( 'gateway' );
		url.searchParams.set( 'webglSpawn', [ route.exit.position[ 0 ], route.exit.position[ 1 ] + 1.7, route.exit.position[ 2 ], route.exit.yaw, 0 ].join( ',' ) );
		location.assign( url.href );

	}

	_nearestPortalRoute() {

		let nearest = null, distance = 3.5;
		for ( const portal of this.portals ) {
			const d = Math.hypot( this.camera.position.x - portal.entry.position[ 0 ], this.camera.position.z - portal.entry.position[ 2 ] );
			const route = portalRouteFromPosition( portal, this.camera.position );
			if ( route && d < distance ) { nearest = route; distance = d; }
		}
		return nearest;

	}

	_startPresence() {

		if ( ! this.connector || ! this.worldLink || ! this.connector.manifest?.ownerPeerId || this.connector.localOnly ) return;
		this.presenceConnector = new WorldConnector( {
			worldId: this.connector.worldId, nodeId: this.connector.manifest.ownerPeerId,
			gateway: this.connector.gateway, directory: this.connector.directory,
		} );
		const send = () => {
			if ( this.presencePending || performance.now() < this.presenceNextSend ) return;
			this.presencePending = true;
			this.presenceConnector.updatePresence( makePresencePose( this.player, this.sequence ++, DEFAULT_APPEARANCE ) )
				.then( snapshot => { this._updateRemotePlayers( snapshot ); this.presenceFailed = false; } )
				.catch( error => {
					this.presenceNextSend = performance.now() + 2000;
					if ( ! this.presenceFailed ) console.warn( 'WebGL fallback presence unavailable:', error.message );
					this.presenceFailed = true;
				} )
				.finally( () => { this.presencePending = false; } );
		};
		this.presenceTimer = setInterval( send, 100 );
		send();
		window.addEventListener( 'pagehide', () => {
			clearInterval( this.presenceTimer );
			const connector = this.presenceConnector;
			connector?.leavePresence().catch( () => {} ).finally( () => connector.close() );
		}, { once: true } );

	}

	_updateRemotePlayers( snapshot ) {

		const ids = new Set();
		for ( const pose of snapshot.players ) {
			if ( pose.id === snapshot.playerId ) continue;
			ids.add( pose.id );
			let actor = this.remotePlayers.get( pose.id );
			if ( ! actor ) {
				const T = this.THREE, group = new T.Group();
				const body = new T.Mesh( new T.CapsuleGeometry( 0.34, 0.85, 4, 8 ), new T.MeshStandardMaterial( { color: pose.appearance.shirt, roughness: 0.9 } ) );
				body.position.y = 0.95; group.add( body );
				const head = new T.Mesh( new T.SphereGeometry( 0.23, 10, 8 ), new T.MeshStandardMaterial( { color: pose.appearance.skin, roughness: 0.9 } ) );
				head.position.y = 1.72; group.add( head );
				this.scene.add( group ); actor = { group, body, head }; this.remotePlayers.set( pose.id, actor );
			}
			actor.group.position.set( ...pose.position ); actor.group.rotation.y = pose.yaw + Math.PI;
			actor.body.material.color.set( pose.appearance.shirt ); actor.head.material.color.set( pose.appearance.skin );
		}
		for ( const [ id, actor ] of this.remotePlayers ) if ( ! ids.has( id ) ) {
			this.scene.remove( actor.group ); actor.body.geometry.dispose(); actor.body.material.dispose(); actor.head.geometry.dispose(); actor.head.material.dispose(); this.remotePlayers.delete( id );
		}

	}

	start() { /* the renderer animation loop starts during init */ }

}
