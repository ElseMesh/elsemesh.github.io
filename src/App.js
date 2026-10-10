import { Vector3, Euler, Color, MathUtils, Mesh } from './engine/index.js';
import { GPU } from './engine/gpu/GPU.js';
import { SunShadows } from './engine/render/Shadows.js';
import { FrameUniforms } from './engine/render/Frame.js';

import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { CDLOD } from './core/CDLOD.js';
import { G } from './core/Globals.js';
import { Profiler } from './core/Profiler.js';
import { SceneRenderer, LAYERS } from './core/SceneRenderer.js';
import { DEPTH_FORMAT } from './engine/render/SceneRenderer.js';
import { installDebugViews } from './core/DebugViews.js';

import { Atmosphere, SUN_ILLUMINANCE } from './sky/Atmosphere.js';
import { Sky, sunDirectionFromTime } from './sky/Sky.js';
import { Clouds } from './sky/Clouds.js';
import { SkyProClouds } from './sky/SkyProClouds.js';
import { Environment } from './sky/Environment.js';

import { TerrainData } from './world/TerrainData.js';
import { HeightfieldTerrainData } from './world/HeightfieldTerrainData.js';
import { TerrainGPU } from './world/TerrainGPU.js';
import { Terrain } from './world/Terrain.js';
import { computeShoreField } from './world/ShoreField.js';
import { WORLD } from './world/WorldLayout.js';
import { Colliders } from './world/Colliders.js';
import { Village } from './world/Village.js';
import { Reef } from './world/Reef.js';
import { BoatModel } from './world/BoatModel.js';
import { Rocks } from './world/Rocks.js';
import { Debris } from './world/Debris.js';
import { Wildlife } from './world/wildlife/Wildlife.js';
import { Whale } from './world/marine/Whale.js';

import { OceanFFT } from './ocean/OceanFFT.js';
import { WaterSurface } from './ocean/WaterSurface.js';
import { WaterMaterial } from './ocean/WaterMaterial.js';
import { applyWaterBodyProfile } from './ocean/WaterProfiles.js';
import { createFoamTexture } from './ocean/FoamTexture.js';
import { ShoreWaves } from './ocean/ShoreWaves.js';
import { ShoreSim } from './ocean/ShoreSim.js';
import { Caustics } from './ocean/Caustics.js';
import { installUnderwaterLighting } from './ocean/UnderwaterLighting.js';
import { RefractionPass } from './ocean/RefractionPass.js';
import { installGroundBounce } from './materials/GroundBounce.js';
import { LocalLights, addVillageLights, addBoatLights } from './materials/LocalLights.js';
import { WaterQuery } from './ocean/WaterQuery.js';
import { Breakers } from './ocean/Breakers.js';
import { SurfFoam } from './ocean/SurfFoam.js';
import { Spray } from './fx/Spray.js';
import { SeaDetail } from './ocean/SeaDetail.js';
import { MarineSnow } from './fx/MarineSnow.js';
import { AirMotes } from './fx/AirMotes.js';

import { Underwater, LENS_REACH } from './post/Underwater.js';
import { PostFX } from './post/PostFX.js';
import { AirHaze } from './post/AirHaze.js';
import { FlyCamera } from './player/FlyCamera.js';
import { Player } from './player/Player.js';
import { Game } from './game/Game.js';
import { STAND } from './game/FishStand.js';
import { CHANDLERY } from './game/Chandlery.js';
import { BoatController } from './player/BoatController.js';
import { BoatSpray } from './player/BoatSpray.js';
import { WakeSim } from './ocean/WakeSim.js';
import { Vegetation } from './world/Vegetation.js';
import { decodeVegetationPlacements } from './network/VegetationPlacements.js';
import { decodeTerrainSurfaceAsset } from './network/TerrainSurfaceAsset.js';
import { decodeReefPlacements, MAX_REEF_PLACEMENTS, REEF_PLACEMENT_HEADER_BYTES, REEF_PLACEMENT_RECORD_BYTES } from './network/ReefPlacements.js';
import { SoundScape } from './audio/SoundScape.js';
import { updateCameraVelocity, useStaticVelocity } from './post/CameraVelocity.js';
import { Group } from './engine/scene/Group.js';
import { WorldConnector, worldLinkFromLocation } from './network/WorldConnector.js';
import { rememberWorldVisit } from './network/WorldLauncher.js';
import { worldSeaLevel } from './network/WorldRules.js';
import { worldSpawnPose } from './network/WorldSource.js';
import { updateWorldPackageLOD, appendWorldPackageAssets, disposeWorldPackage, loadWorldPackage, registerWorldPackageCollisions, unregisterWorldPackageCollisions } from './network/WorldPackage.js';
import { HostedBoat } from './network/HostedBoat.js';
import { selectWorldComponentsForView, selectWorldObjectsForView } from './network/WorldStreaming.js';
import { portalRouteFromPosition, crossedPortalPlane, mapPortalPlayerState, mapPortalVehicleState } from './network/PortalHandoff.js';
import { vehiclePolicy } from './network/WorldRules.js';
import { WorldPresenceSession } from './network/WorldPresenceSession.js';
import { WorldPortalView } from './network/WorldPortalView.js';
import { RenderLoadLOD } from './network/RenderLoadLOD.js';
import { FrameWorkMeter } from './core/FrameWorkMeter.js';
import { DEFAULT_WORLD_EXPERIENCE, GENERIC_WORLD_EXPERIENCE } from './network/WorldExperience.js';

const _up = new Vector3( 0, 1, 0 );
const GRAPHICS_PRIORITY_KEY = 'elsemesh.graphics-priority';

function readGraphicsPriority() {
	try {
		return globalThis.localStorage?.getItem( GRAPHICS_PRIORITY_KEY );
	} catch {
		return null;
	}
}

function saveGraphicsPriority( value ) {
	try {
		globalThis.localStorage?.setItem( GRAPHICS_PRIORITY_KEY, value );
	} catch {
		// Private browsing and storage policies may disable persistence; the choice still applies now.
	}
}

export class App {

	constructor() {

		this.qs = new URLSearchParams( location.search );
		const platform = navigator.userAgentData?.platform || navigator.platform || '';
		this.isLinuxDesktop = /linux/i.test( platform ) && ! /android/i.test( navigator.userAgent );
		const savedGraphicsPriority = readGraphicsPriority();
		this.graphicsPriority = this.isLinuxDesktop && savedGraphicsPriority === 'quality' ? 'quality' : 'fps';
		this.desktopAdaptiveScale = this.isLinuxDesktop && this.graphicsPriority === 'fps';
		// Keep the Linux canvas slightly below the display resolution so full-screen post passes
		// (temporal upscale, haze, bloom and grading) do not remain full cost when the scene scale drops.
		this.desktopCanvasScale = this.desktopAdaptiveScale ? 0.7 : 1;
		// Leave some GPU time for the desktop compositor once the game can sustain the accepted rate.
		this.desktopFrameRateLimit = this.desktopAdaptiveScale ? 24 : 0;
		// The temporal resolve is a measured GPU cost on Linux; keep the full temporal path on Android.
		this.desktopAntiAliasingMode = this.desktopAdaptiveScale ? 'none' : null;
		// Water refraction redraws the submerged scene every frame; it can use fewer pixels on Linux.
		this.desktopRefractionScale = this.desktopAdaptiveScale ? 0.35 : 0.5;
		// ?scale is a deliberate override, useful for profiling and manual quality selection.
		this.autoScale = this.desktopAdaptiveScale && ! this.qs.has( 'scale' );
		this._scaleBelowTarget = 0;
		this._scaleAboveTarget = 0;
		this.remoteWorlds = new Map();
		this.portalPreparations = new Map();
		this.portalPreviewId = null;
		this.worldBackgroundLoads = new Map();
		this.worldStreamState = new Map();
		this.portalPreviousPosition = null;
		this.settings = {
			timeOfDay: 16.2,
			sunAzimuth: 0, // degrees: turns the sun's daily path about the vertical
			timeSpeed: 0, // hours per real second
			exposure: 0.55,
			renderScale: this.desktopAdaptiveScale ? 0.75 : 1, // Linux starts lighter; adaptive scale targets 24 fps
		};
		this.configureGraphicsPriority();
	}

	configureGraphicsPriority( persist = false ) {

		const fpsMode = this.isLinuxDesktop && this.graphicsPriority === 'fps';
		this.desktopAdaptiveScale = fpsMode;
		this.desktopCanvasScale = fpsMode ? 0.7 : 1;
		this.desktopFrameRateLimit = fpsMode ? 24 : 0;
		this.desktopAntiAliasingMode = fpsMode ? 'none' : null;
		this.desktopRefractionScale = fpsMode ? 0.35 : 0.5;
		this.autoScale = fpsMode && ! this.qs.has( 'scale' );
		if ( this.settings ) this.settings.renderScale = fpsMode ? 0.75 : 1;
		if ( persist && this.isLinuxDesktop ) saveGraphicsPriority( this.graphicsPriority );

		if ( this.engine ) this.engine.setFrameRateLimit( this.desktopFrameRateLimit );
		if ( this.settings && this.engine && this.post ) this.setRenderScale( this.settings.renderScale );
		if ( this.post ) this.post.aaMode = fpsMode ? 'none' : 'taa';
		if ( this.shadows ) this.shadows.enabled = ! fpsMode;
		if ( this.refraction ) this.refraction.scale = this.desktopRefractionScale;
		if ( this.scene ) this.scene.traverse( ( object ) => {

			for ( const material of Array.isArray( object.material ) ? object.material : [ object.material ] ) {
				if ( material?.isWaterMaterial && material.params?.ssr ) material.params.ssr.value = fpsMode ? 0 : 1;
			}

		} );
		if ( this.renderLoadLOD ) {
			this.renderLoadLOD.bias = 0;
			this.renderLoadLOD.cpuOverload = this.renderLoadLOD.gpuOverload = 0;
			this.renderLoadLOD.cpuHeadroom = this.renderLoadLOD.gpuHeadroom = 0;
		}
		this.renderLoadBias = 0;

	}

	setGraphicsPriority( priority ) {

		if ( ! this.isLinuxDesktop || ! [ 'fps', 'quality' ].includes( priority ) || priority === this.graphicsPriority ) return;
		this.graphicsPriority = priority;
		this.configureGraphicsPriority( true );

	}

	async init( onProgress = () => {} ) {

		const qs = this.qs;
		const worldLink = worldLinkFromLocation();
		this.loadingExperience = worldLink ? GENERIC_WORLD_EXPERIENCE : DEFAULT_WORLD_EXPERIENCE;
		this.loadingTitle = worldLink ? 'ThruHold' : 'Example Island';
		globalThis.__ui?.setLoadingPresentation( this.loadingTitle, this.loadingExperience );
		if ( worldLink ) {
			this.worldConnector = new WorldConnector( worldLink );
			this.worldManifestPromise = this.worldConnector.getManifest().then( ( manifest ) => ( { manifest } ), ( error ) => ( { error } ) );
			this.worldManifestPromise.then( ( result ) => {
				if ( result.manifest ) {
					if ( result.manifest.experience ) this.loadingExperience = result.manifest.experience;
					this.loadingTitle = result.manifest.title;
					globalThis.__ui?.setLoadingPresentation( this.loadingTitle, this.loadingExperience );
				}
			} );
		}
		// report a stage, then let the page paint it before the (synchronous) stage work starts
		const progress = async ( p, text, until, stage ) => {

			onProgress( p, stage ? this.loadingExperience?.stages?.[ stage ] || text : text, until );
			if ( typeof requestAnimationFrame === 'function' ) await new Promise( ( r ) => requestAnimationFrame( () => setTimeout( r, 0 ) ) );

		};
		await progress( 0.02, 'Starting WebGPU…', undefined, 'gpu' );
		const engine = this.engine = new Engine( document.getElementById( 'app' ) );
		await engine.init();
		this.backend = engine.backend;
		if ( engine.backend === 'webgl' ) {

			const { WebGLFallback } = await import( './fallback/WebGLFallback.js' );
			this.webglFallback = new WebGLFallback( this, engine );
			await this.webglFallback.init( onProgress );
			return this;

		}
		this.backend = 'webgpu';
		// systems take `renderer` first as in the three.js version: it is the Engine now (GPU access is global)
		const renderer = engine;
		const { scene, camera } = engine;
		// the near clip plane is the lens: it slices the water surface at the waterline (see Underwater)
		camera.near = 0.1;
		camera.updateProjectionMatrix();
		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;

		this.input = new Input( engine.domElement );
		this.fly = new FlyCamera( camera, engine.domElement, this.input );
		this.fly.setPose( new Vector3( 20, 6, - 20 ), Math.PI * 0.9, - 0.12 );

		// ---------------------------------------------------------------- sky
		await progress( 0.04, 'Building the atmosphere…', undefined, 'atmosphere' );
		this.atmosphere = new Atmosphere( renderer );
		this.sky = new Sky( this.atmosphere );
		if ( ! qs.has( 'noClouds' ) ) {

			// sky-pro-webgpu's clouds ("Partly cloudy"); ?oldClouds: the previous ones
			this.clouds = qs.has( 'oldClouds' ) ? new Clouds( renderer, this.atmosphere ) : new SkyProClouds( renderer, this.atmosphere );
			if ( this.clouds.ready ) await this.clouds.ready;
			this.sky.clouds = this.clouds;

		}

		// 3 cascades: 0-10 m (~1 cm texels, fine contact detail), 10-60 m, 60-400 m (rough far shadows);
		// contact-hardening filter sized by the sun's disc on the near cascade. Each cascade's depth range
		// is its light margin (200 m) + its extent, which keeps the depth bias small in metres.
		// Shadows come from the opaque and the late (transparent-pass) layers.
		this.csm = this.shadows = new SunShadows( { size: 2048, splits: [ 10, 60, 400 ], lightMargin: 200, normalBias: [ 0.015, 0.06, 0.3 ], bias: 0.00002 } );
		this.shadows.layerMask = ( 1 << LAYERS.OPAQUE ) | ( 1 << LAYERS.TRANSPARENT );
		if ( this.desktopAdaptiveScale ) this.shadows.enabled = false;

		this.environment = new Environment( renderer, scene, this.sky );
		// Keep renderer-owned atmosphere/environment roots separate from replaceable world content.
		this._sharedSceneRoots = new Set( scene.children );

		// ---------------------------------------------------------------- island
		await progress( 0.06, 'Shaping the island…', undefined, 'terrain' );
		this.terrainData = new TerrainData();
		this.colliders = new Colliders();
		this.hostedColliders = new Colliders();
		// the village flattens building pads into the heightmap: build it before any terrain
		// data is derived (shore field, GPU textures, meshes)
		await progress( 0.12, 'Building the village…', undefined, 'village' );
		this.village = new Village( { scene, terrain: this.terrainData, colliders: this.colliders } );
		this.worldVillageMaterialContext = { materials: this.village.materials, textures: this.village.textures };
		this.vegetationEnabled = ! qs.has( 'noVeg' );
		if ( this.vegetationEnabled ) {

			await progress( 0.14, 'Planting the island…', undefined, 'vegetation' );
			this.vegetation = new Vegetation( { scene, terrain: this.terrainData, village: this.village } );
			useStaticVelocity( this.vegetation.group );

		}

		await progress( 0.19, 'Rolling in the swell…', undefined, 'ocean' );
		this.shoreField = computeShoreField( this.terrainData, { res: 512, swellDir: [ WORLD.swellDir.x, WORLD.swellDir.y ] } );
		this.terrainGPU = new TerrainGPU( this.terrainData, this.shoreField );
		// terrain and rocks apply the heightfield sun shadow (long hill shadows) in their own lighting
		this.terrain = new Terrain( { scene, terrainData: this.terrainData, terrainGPU: this.terrainGPU, renderer } );
		this.rocks = new Rocks( { scene, terrain: this.terrain, village: this.village, colliders: this.colliders } );
		// driftwood (CC0 photoscans), wrack, pebbles and village clutter
		this.debris = new Debris( { scene, terrain: this.terrain, village: this.village, vegetation: this.vegetation, rocks: this.rocks, colliders: this.colliders } );
		// these apply the heightfield sun shadow in their own lighting model (see UnderwaterLighting)
		this.terrain.mesh.material.appliesHillShadow = true;
		this.rocks.material.appliesHillShadow = true;

		await progress( 0.23, 'Growing the reef…', undefined, 'reef' );
		this.reef = new Reef( { scene, terrain: this.terrainData, shoreField: this.shoreField } );

		this.boat = new BoatModel();
		scene.add( this.boat.group );
		this.boat.group.position.copy( WORLD.boatDock.position );
		this.boat.group.rotation.y = WORLD.boatDock.heading;

		// ---------------------------------------------------------------- ocean
		await progress( 0.3, 'Simulating the ocean…', undefined, 'simulation' );
		this.fft = new OceanFFT( renderer );
		if ( this.reef.setOcean ) this.reef.setOcean( this.fft ); // coral / sea fan sway follows the simulated swell
		this.foamTexture = createFoamTexture( renderer );
		this.oceanLOD = new CDLOD( { gridSize: Number( qs.get( 'G' ) || 32 ), leafSize: 8, levels: 12, minY: - 25, maxY: 25 } );
		this.surface = new WaterSurface( { fft: this.fft, cdlod: this.oceanLOD, foamTexture: this.foamTexture } );
		this.surface.terrain = this.terrainGPU;
		this.seaDetail = new SeaDetail();
		this.surface.detail = this.seaDetail;
		this.shore = new ShoreWaves( this.terrainGPU );
		this.surface.shore = this.shore;
		this.caustics = qs.has( 'noCaustics' ) ? null : new Caustics( renderer, this.fft );
		if ( this.caustics ) this.caustics.detail = this.seaDetail;

		if ( ! qs.has( 'noSim' ) ) {

			this.shoreSim = new ShoreSim( renderer, { terrainGPU: this.terrainGPU, shore: this.shore } );
			this.surface.shoreSim = this.shoreSim;
			// WGSL: fn terrainWetness( xz: vec2f, h: f32 ) -> vec2f (x = wetness, y = sand foam)
			this.terrain.wetness = {
				modules: [ this.shoreSim.module ],
				code: /* wgsl */`
fn terrainWetness( xz: vec2f, h: f32 ) -> vec2f {
	let s = shoreSimSample( xz );
	let inside = shoreSimInside( shoreSimUvOf( xz ) );
	// outside the simulated region fall back to a static damp band
	let band = smoothstep( 0.45, 0.0, h );
	// foam left on the sand: the lace the water carried, stranded and popping (ShoreSim.sandFoam)
	return vec2f( max( s.y, band * ( 1.0 - inside ) ), shoreSimSandFoam( xz, s, h ) );
}`,
			};
			this.terrain.finalizeMaterial();
			// surf-zone foam look (whitewater, lace) used by the water shader
			this.surfFoam = new SurfFoam( { shoreSim: this.shoreSim } );
			this.surface.foamShading = ( args ) => this.surfFoam.shading( args );

		}

		// how much of the underwater lighting each group needs (sampler budget, see UnderwaterLighting)
		const underwaterMode = ( root, m ) => root && root.traverse( ( o ) => {

			if ( o.material ) for ( const mat of Array.isArray( o.material ) ? o.material : [ o.material ] ) mat.underwaterLighting = m;

		} );
		underwaterMode( this.village.group, 'lite' );
		underwaterMode( this.boat.group, 'lite' );
		if ( this.vegetation ) underwaterMode( this.vegetation.group, 'none' );

		this.underwaterLighting = installUnderwaterLighting( {
			fft: this.fft, caustics: this.caustics, clouds: this.clouds, terrain: this.terrainGPU,
			shore: this.shore, surface: this.surface, shoreSim: this.shoreSim,
		} );

		// sunlight bounced off the ground (one diffuse bounce, re-baked with the terrain sun shadow)
		installGroundBounce( { terrain: this.terrainGPU, clouds: this.clouds } );
		this.sceneRenderer = new SceneRenderer( engine.meshRenderer, scene, camera );
		// the water's refraction source: the scene below the water only, half resolution
		this.refraction = new RefractionPass( { meshRenderer: engine.meshRenderer, scene, camera, sceneRenderer: this.sceneRenderer, scale: this.desktopRefractionScale } );
		this.sceneRenderer.onBeforeWater = () => this.refraction.render( G.seaLevel.value );
		if ( this.sky.background ) this.sceneRenderer.background = this.sky.background;
		this.portalView = new WorldPortalView( { scene, meshRenderer: engine.meshRenderer, sceneRenderer: this.sceneRenderer, camera } );
		// lanterns, lamp posts, path lights, lit windows, the boat's cabin / navigation lights and the
		// flashlight (L): nearest few packed into one small uniform array each frame
		this.localLights = new LocalLights();
		addVillageLights( this.localLights, this.village );
		addBoatLights( this.localLights, this.boat );
		// rough, large or heavily overdrawn surfaces (ground, rocks, debris, foliage) take the local
		// lights as Lambert only; the village, pier and boat get the full BRDF (glints on wet wood, metal)
		for ( const root of [ this.terrain.mesh, this.rocks.group, this.debris && this.debris.group, this.vegetation && this.vegetation.group ] ) if ( root ) root.traverse( ( o ) => {

			if ( o.material ) for ( const m of Array.isArray( o.material ) ? o.material : [ o.material ] ) m.localLightsCheap = true;

		} );
		// the sea is not drawn inside the boat (its hull volume masks the surface)
		this.sceneRenderer.addHullMask( this.boat.createHullVolumeGeometry(), this.boat.group );
		this.waterMaterial = new WaterMaterial( {
			surface: this.surface, sky: this.sky, sceneCopy: this.sceneRenderer.opaqueCopy, sceneDepthHalf: this.sceneRenderer.opaqueDepthHalf.texture, refraction: this.refraction,
			hullMask: this.sceneRenderer.hullMaskRT.texture, hullMaskActive: this.sceneRenderer.hullMaskActive,
		} );
		if ( this.desktopAdaptiveScale ) this.waterMaterial.params.ssr.value = 0;
		this.waterMaterial.clouds = this.clouds;
		this.ocean = new Mesh( this.oceanLOD.geometry, this.waterMaterial );
		this.ocean.frustumCulled = false;
		this.ocean.receiveShadow = true;
		this.ocean.layers.set( LAYERS.WATER );
		// Thin alpha-tested meshes (nets, cloth, wire traps) are drawn in the late pass: the screen-space
		// AO and the refraction copy only see the opaque pass, so they neither smear dark AO halos over
		// what is behind them nor receive the noisy AO of their own strands. The boat's window glass is
		// blended: in the late pass it goes over the water seen through it (drawn earlier it would be
		// painted over by the water).
		this.scene.traverse( ( o ) => {

			if ( o.isMesh && ( o.name === 'village_fabric' || o.name === 'village_nets' || o.name === 'boat-trap' || o.name === 'boat-glass' ) ) o.layers.set( LAYERS.TRANSPARENT );

		} );
		// Terrain and water place their vertices in the vertex shader (CDLOD), so three's default motion
		// vectors (previous frame = raw grid position) are garbage there. Both are still in the world or
		// nearly so: camera-only reprojection of the real world position is what the temporal resolve needs.
		// ( the water material writes its own velocity + waterline mask outputs )
		useStaticVelocity( this.terrain.mesh );
		useStaticVelocity( this.rocks.group );
		scene.add( this.ocean );

		this.query = new WaterQuery( renderer, this.surface );
		// Hosted boats use the same FFT swell but a terrain-free query surface. This keeps boat
		// hydrostatics independent of the hidden procedural island's shore and wake fields.
		this.hostedWaterSurface = new WaterSurface( { fft: this.fft, cdlod: this.oceanLOD, foamTexture: this.foamTexture } );
		this.hostedQuery = new WaterQuery( renderer, this.hostedWaterSurface );
		this.hostedPlayerSlot = this.hostedQuery.allocate( 'player', 1 );

		this.marineSnow = new MarineSnow( { fft: this.fft, query: this.query } );
		scene.add( this.marineSnow.mesh );

		// ---- surf: plunging lips along the beach + spray particles (the breakers emit on the GPU;
		// spray.emit() / emitAlongPoints() for boat bow spray and splashes)
		this.spray = new Spray( renderer, { query: this.query, terrain: this.terrainGPU, sceneCopy: this.sceneRenderer.opaqueCopy, clouds: this.clouds } );
		scene.add( this.spray.mesh );
		if ( this.reef.setSpray ) this.reef.setSpray( this.spray ); // splashes of leaping fish
		this.breakers = new Breakers( renderer, {
			surface: this.surface, shore: this.shore, terrainData: this.terrainData, sky: this.sky,
			spray: this.spray, clouds: this.clouds,
		} );
		scene.add( this.breakers.mesh );
		// dust, pollen, salt aerosol, seed fluff and gnats drifting around the camera
		this.airMotes = new AirMotes( { terrain: this.terrainGPU, clouds: this.clouds, csm: this.csm, reversedDepth: true } );
		scene.add( this.airMotes.mesh );
		this.boatCtl = new BoatController( { model: this.boat, query: this.query, terrain: this.terrainData, colliders: this.colliders } );
		this.boatSpray = new BoatSpray( { boat: this.boatCtl, spray: this.spray } );
		// humpback cruising the deep water around the island (model fetched from public/models/whale)
		this.whale = new Whale( { scene, terrain: this.terrainData, query: this.query, spray: this.spray } );
		try {

			await this.whale.load();
			if ( this.reef && this.reef.setWhale ) this.reef.setWhale( this.whale ); // escort fish, foam and slick

		} catch ( e ) {

			console.warn( 'whale model failed to load', e );
			this.whale = null;

		}

		// interactive wake around the boat (Kelvin pattern, bow/stern waves, prop wash foam)
		this.wake = new WakeSim( renderer, { terrainGPU: this.terrainGPU, boat: this.boatCtl, colliders: this.colliders } );
		this.surface.wake = this.wake;
		this.player = new Player( { camera, input: this.input, terrain: this.terrainData, colliders: this.colliders, query: this.query, boat: this.boatCtl, reef: this.reef } );
		this.localPlayerEnvironment = { terrain: this.player.terrain, colliders: this.player.colliders, query: this.player.query, slot: this.player.slot, reef: this.player.reef, boat: this.player.boat, hostedSeaLevel: null };
		// birds, beach crabs, sanderlings (after spray / query / boat, which they use)
		this.wildlife = new Wildlife( {
			scene, renderer, terrain: this.terrainData, terrainGPU: this.terrainGPU, shore: this.shore,
			village: this.village, colliders: this.colliders, vegetation: this.vegetation, boat: this.boatCtl, boatModel: this.boat,
			query: this.query, spray: this.spray, csm: this.csm,
		} );
		this.freeCam = qs.has( 'fly' );

		// ---------------------------------------------------------------- post
		await progress( 0.34, 'Preparing the shaders…', undefined, 'shaders' );
		this.underwater = new Underwater( {
			depthTexture: this.sceneRenderer.sceneRT.depthTexture, maskTexture: this.sceneRenderer.waterMaskTexture,
			query: this.query, caustics: this.caustics, fft: this.fft,
		} );
		// the camera's height above the water in the same frame (GPU query): decides the side the surface
		// is seen from where the triangle facing can't be trusted
		this.waterMaterial.cameraWaterHeightNode = this.query.cameraState().x;
		// aerial perspective, marine haze and volumetric sun shafts (post)
		this.haze = qs.has( 'noHaze' ) ? null : new AirHaze( {
			depthTexture: this.sceneRenderer.sceneRT.depthTexture, underwater: this.underwater, atmosphere: this.atmosphere,
			sky: this.sky, clouds: this.clouds, terrain: this.terrainGPU, csm: this.csm,
		} );
		this.post = new PostFX( renderer, { sceneRenderer: this.sceneRenderer, camera, underwater: this.underwater, clouds: this.clouds, sunDir: this.atmosphere.sunDir, haze: this.haze } );
		if ( this.desktopAntiAliasingMode ) this.post.aaMode = this.desktopAntiAliasingMode;
		G.exposure.value = this.settings.exposure;
		if ( qs.has( 'scale' ) ) this.settings.renderScale = Number( qs.get( 'scale' ) ) || 1;
		this.setRenderScale( this.settings.renderScale );

		// ---------------------------------------------------------------- audio
		// recorded field recordings (public/audio, credits in public/audio/CREDITS.md); ?noAudio turns it off
		this.audio = qs.has( 'noAudio' ) ? null : new SoundScape();
		this.player.audio = this.audio;
		// the fishing game (rod, bites, catch, cooler, fish stand)
		this.game = new Game( this );
		// the lanterns at Joe's fish stand and Marta's chandlery (lit from dusk like the village lamps);
		// positions are in each stall's frame (x right, z toward the customer), turned by its yaw
		for ( const [ s, lx, ly, lz ] of [ [ STAND, - 0.9, 1.85, 0.1 ], [ CHANDLERY, - 0.75, 1.58, - 1.45 ] ] ) {

			const c = Math.cos( s.yaw ), sn = Math.sin( s.yaw );
			const x = s.x + lx * c + lz * sn, z = s.z - lx * sn + lz * c;
			this.localLights.add( { position: new Vector3( x, this.terrainData.heightAt( s.x, s.z ) + ly, z ), color: new Color( 1.0, 0.72, 0.42 ), intensity: 5 * 1.5, range: 11, kind: 'lantern', flicker: 0.08 } );

		}

		this.boatCtl.onSlam = ( s ) => this.audio && this.audio.hullSlap( s );
		engine.domElement.addEventListener( 'click', () => {

			if ( window.__ui && window.__ui.isPointerOverUI ) return;
			this.input.requestLock();
			if ( this.audio ) this.audio.resume();

		} );

		this.profiler = new Profiler( renderer );
		this.frameWorkMeter = new FrameWorkMeter();
		this.renderLoadLOD = new RenderLoadLOD();
		this.renderLoadWarmup = 0;
		this.profiler.track( 'fft rows', this.fft.rowKernel );
		this.profiler.track( 'fft columns', this.fft.columnKernel );
		this.profiler.track( 'sky view', this.atmosphere.skyViewKernel );

		this.updateSun();
		if ( worldLink ) {

			await progress( 0.33, 'Connecting to world…', undefined, 'world' );
			this.proceduralWorldRoot = new Group();
			this.proceduralWorldRoot.name = 'procedural-example-world';
			for ( const child of scene.children.slice() ) if ( ! this._sharedSceneRoots.has( child ) ) this.proceduralWorldRoot.add( child );
			scene.add( this.proceduralWorldRoot );
			const connector = this.worldConnector;
			const manifestResult = await this.worldManifestPromise;
			if ( manifestResult.error ) throw manifestResult.error;
			this.player.setWorldRules( connector.manifest.rules );
			G.seaLevel.value = worldSeaLevel( connector.manifest.rules );
			const spawn = worldSpawnPose( connector.manifest );
			this.camera.position.set( ...spawn.position );
			this.player.yaw = spawn.yaw;
			this.player.pitch = spawn.pitch;
			this.camera.quaternion.setFromEuler( new Euler( spawn.pitch, spawn.yaw, 0 ) );
			const initialObjects = selectWorldObjectsForView( connector.manifest, this.camera );
			const initialComponents = selectWorldComponentsForView( connector.manifest, this.camera ).filter( ( component ) => this.vegetationEnabled || ! isVegetationComponent( component ) );
			const initialObjectIDs = new Set( initialObjects.map( ( object ) => object.id ) );
			const initialComponentIDs = new Set( initialComponents.map( ( component ) => component.id ) );
			const initialAssetIDs = new Set( initialObjects.map( ( object ) => object.assetId ) );
			for ( const component of initialComponents ) for ( const id of componentAssetIDs( component ) ) initialAssetIDs.add( id );
			const visibleAssets = await connector.preload( { through: 'background', assetIDs: initialAssetIDs } );
			this.linkedWorldRoot = await loadWorldPackage( connector, { assets: visibleAssets, objectIDs: initialObjectIDs, materialContext: this.worldVillageMaterialContext } );
			this.installWorldComponents( this.linkedWorldRoot, connector, initialComponentIDs );
			registerWorldPackageCollisions( this.linkedWorldRoot, this.hostedColliders );
			this.prepareHostedWorld( connector );
			this.linkedWorldRoot.name = `hosted-world:${worldLink.worldId}`;
			scene.add( this.linkedWorldRoot );
			this.remoteWorlds.set( worldLink.worldId, { connector, root: this.linkedWorldRoot } );
			this.player.setHostedWorldPose( this.camera.position, this.player.yaw, this.player.pitch );
			this.streamWorldRemainder( connector, this.linkedWorldRoot );
			this.proceduralWorldRoot.visible = false;
			this.remoteWorldActive = true;
			this.activateHostedWorld( this.linkedWorldRoot, connector );
			this.refraction.enabled = false;
			this.portalPreviousPosition = this.camera.position.clone();
			rememberWorldVisit( {
				pageURL: location.href,
				worldId: connector.worldId,
				nodeId: connector.nodeId,
				gateway: connector.gateway,
				directory: connector.directory,
				title: connector.manifest.title,
			} );

		}
		installDebugViews( this );
		window.__app = this;
		this.gpu = GPU; // console / test access

		// ---- compile pipelines asynchronously (keeps the page responsive), then prime a few
		// frames behind the loading screen so any remaining first-use stalls happen there
		// stage weights: in the browser the pipeline compile below takes far longer than everything before it
		await progress( 0.36, 'Compiling shaders…', 0.95, 'compile' );
		await this.precompile();
		await progress( 0.96, 'Warming up…', undefined, 'warmup' );
		for ( let i = 0; i < 2; i ++ ) {

			this.frame( 1 / 60 );
			await GPU.queue.onSubmittedWorkDone();

		}

	}

	// Build every pipeline up front, then wait for the GPU (keeps first-use compiles behind the loading
	// screen). The precompile frame visits every mesh of every pass, hidden or out of view, and the
	// pipelines compile in parallel in the background (GPU.renderPipeline); the refraction pass and
	// the hull mask are forced on so their variants are built too.
	async precompile() {

		const mr = this.engine.meshRenderer;
		const refr = this.refraction.enabled;
		// compute / post pipelines were requested while the systems were built: let them finish first
		// (the frame below would otherwise compile each one again, synchronously); the post chain
		// builds its passes on first use, so build it now
		if ( ! this.post._built ) {

			this.post._build();
			this.post._outW = 0; // as PostFX.beginFrame: size the new targets

		}

		await GPU.pipelinesReady();
		mr.precompiling = true;
		this.refraction.enabled = true;
		const sr = this.sceneRenderer, hm = sr.hullMaskRT;
		if ( sr.hullMasks.length ) mr.render( sr.hullMaskScene, {
			label: 'hull mask', kind: 'color', camera: this.camera, colorViews: [ hm.texture.view() ], colorFormats: hm.formats,
			clearColors: [ [ 0, 0, 0, 0 ] ], depthView: hm.depthTexture.view(), depthFormat: DEPTH_FORMAT, clearDepth: 0, cull: false,
		} );
		try {

			// both water variants: with the hull-mask discard (a hull on screen) and without
			for ( const hull of [ 0, 1 ] ) {

				this.waterMaterial.hullOverride = hull;
				this.frame( 1 / 60 );

			}

		} catch ( e ) {

			console.warn( 'precompile failed', e );

		}

		this.waterMaterial.hullOverride = null;
		mr.precompiling = false;
		this.refraction.enabled = refr;
		await GPU.pipelinesReady();
		await GPU.queue.onSubmittedWorkDone();

	}

	// ---------------------------------------------------------------- sun / sky

	updateSun() {

		const s = this.settings;
		const dir = sunDirectionFromTime( s.timeOfDay ).applyAxisAngle( _up, MathUtils.degToRad( s.sunAzimuth || 0 ) );
		// the sky is always scattered sunlight, even with the sun below the horizon (twilight)
		this.atmosphere.sunDir.value.copy( dir );
		// below the horizon the moon takes over as the key light
		const night = MathUtils.smoothstep( - dir.y, 0.02, 0.18 );
		G.night.value = night;
		this.sky.starIntensity.value = night;
		const moon = new Vector3( - dir.x, Math.abs( dir.y ) * 0.8 + 0.25, - dir.z ).normalize();
		this.sky.moonDir.value.copy( moon );

		// key light: the sun until it is well below the horizon (it gives no direct light in
		// twilight anyway), then the moon
		const light = dir.y > - 0.07 ? dir : moon;
		G.sunDir.value.copy( light );

	}

	applyAtmosphereReadback() {

		const a = this.atmosphere;
		if ( ! a.sunTransmittance ) return;
		const sunTrue = a.sunDir.value;
		const sunUp = sunTrue.y > - 0.07; // same switch as updateSun()
		const T = a.sunTransmittance;
		const horizonFade = MathUtils.smoothstep( sunTrue.y, - 0.03, 0.02 );
		let c;
		if ( sunUp ) c = new Color( T[ 0 ], T[ 1 ], T[ 2 ] ).multiplyScalar( SUN_ILLUMINANCE * horizonFade );
		else c = new Color( 0.6, 0.7, 1.0 ).multiplyScalar( 0.12 * G.night.value );
		G.sunColor.value.copy( c );
		const irr = a.skyIrradiance;
		const nightAmb = 0.012 * G.night.value;
		G.skyIrradiance.value.setRGB( irr[ 0 ] + nightAmb * 0.6, irr[ 1 ] + nightAmb * 0.7, irr[ 2 ] + nightAmb );
		G.horizonColor.value.setRGB( a.horizon[ 0 ], a.horizon[ 1 ], a.horizon[ 2 ] );

	}

	// T: let the day run (about 8 minutes per day) or stop it
	toggleTime() {

		const s = this.settings;
		if ( s.timeSpeed !== 0 ) {

			this._timeSpeed = s.timeSpeed;
			s.timeSpeed = 0;

		} else {

			s.timeSpeed = this._timeSpeed || 0.05;

		}

		if ( this.ui ) {

			this.ui.s.advance = s.timeSpeed !== 0;
			this.ui.ui.refresh();
			this.ui.ui.toast( s.timeSpeed !== 0 ? 'Time running' : 'Time paused' );

		}

	}

	// Free (debug) camera on F; the walker / boat resumes where it was left.
	setFreeCam( on ) {

		if ( on === this.freeCam ) return;
		this.freeCam = on;
		if ( on ) {

			const e = new Euler().setFromQuaternion( this.camera.quaternion, 'YXZ' );
			this.fly.setPose( this.camera.position.clone(), e.y, e.x );
			this.fly.velocity.set( 0, 0, 0 );

		} else if ( this.player.mode !== 'boat' && this.player.mode !== 'deck' ) {

			this.dropPlayerAtCamera();

		}

	}

	// Leaving the free camera: the player continues from where the camera is, facing the same way,
	// and falls from there (swimming at once if the camera is under water).
	dropPlayerAtCamera() {

		const p = this.player, c = this.camera.position;
		const e = new Euler().setFromQuaternion( this.camera.quaternion, 'YXZ' );
		p.yaw = e.y;
		p.pitch = MathUtils.clamp( e.x, - 1.5, 1.5 );
		p.velocity.set( 0, 0, 0 );
		const ground = Math.max( this.terrainData.heightAt( c.x, c.z ), this.colliders.groundHeightAt( c.x, c.z, c.y ) );
		const water = this.cameraWaterHeight ?? 0;
		if ( c.y < water ) {

			p.mode = 'swim';
			p.position.set( c.x, Math.max( c.y - 0.16, ground + 0.3 ), c.z );

		} else {

			// drop from where the camera is: gravity brings you down onto the ground or a deck, or into
			// the sea (the walker starts swimming once it is out of its depth)
			p.mode = 'walk';
			p.position.set( c.x, Math.max( c.y - 1.62, ground ), c.z );
			p.grounded = false;

		}

		p.waterH = water;
		p.waterMean = water;

	}

	// ---------------------------------------------------------------- loop

	start() {

		if ( this.webglFallback ) return this.webglFallback.start();

		this.engine.start( ( dt, t ) => this.frame( dt, t ), this.desktopFrameRateLimit );

	}

	updateFPS( dt ) {

		const f = this._fps || ( this._fps = { el: document.getElementById( 'fps' ), acc: 0, n: 0, worst: 0 } );
		f.acc += dt;
		f.n ++;
		f.worst = Math.max( f.worst, dt );
		if ( f.acc >= 0.5 ) {

			const fps = f.n / f.acc;
			let text = `${ fps.toFixed( 0 ) } fps · ${ ( 1000 * f.acc / f.n ).toFixed( 1 ) } ms · max ${ ( f.worst * 1000 ).toFixed( 1 ) } ms`;
			if ( this.profiler && this.profiler.enabled ) {

				const p = this.profiler.result;
				text += ` · GPU c ${ p.compute.toFixed( 2 ) } r ${ p.render.toFixed( 2 ) }`;

			}

			if ( f.el ) f.el.textContent = text;
			this.fps = fps;
			this.adaptRenderScale( fps );
			f.acc = 0;
			f.n = 0;
			f.worst = 0;

		}

	}

	// Linux desktop integrated GPUs can be starved by the game's full-resolution post chain.
	// Lower only the internal render scale when sustained FPS misses 24; recover slowly above 36
	// so resolution changes do not flap. Android keeps the existing full-quality path.
	adaptRenderScale( fps ) {

		if ( ! this.autoScale ) return;
		if ( fps < 24 ) {

			this._scaleAboveTarget = 0;
			this._scaleBelowTarget += 0.5;
			if ( this._scaleBelowTarget >= 1 ) {
				this._scaleBelowTarget = 0;
				if ( this.settings.renderScale > 0.5 ) this.setRenderScale( Math.max( 0.5, this.settings.renderScale - 0.05 ) );
			}
			return;

		}
		this._scaleBelowTarget = 0;
		if ( fps > 36 ) {

			this._scaleAboveTarget += 0.5;
			if ( this._scaleAboveTarget >= 8 ) {
				this._scaleAboveTarget = 0;
				this.setRenderScale( this.settings.renderScale + 0.05 );
			}
			return;

		}
		this._scaleAboveTarget = 0;

	}

	frame( dt ) {

		const t0 = performance.now();
		this.frameWorkMeter?.begin();
		this._frame( dt );
		const ms = performance.now() - t0;
		this.cpuMs = this.cpuMs === undefined ? ms : this.cpuMs * 0.95 + ms * 0.05;
		this.renderLoadWarmup += Math.min( dt, 0.1 );
		const gpuSample = this.frameWorkMeter?.takeGPUSample();
		const loadBias = ! this.isLinuxDesktop || this.graphicsPriority === 'fps' ? ( this.renderLoadWarmup < 8 ? 0 : this.renderLoadLOD.sample( { cpuMs: ms, gpuMs: gpuSample?.gpuMs ?? null, gpuElapsedSeconds: gpuSample?.elapsedSeconds, budgetMs: 1000 / ( this.desktopFrameRateLimit || 60 ), elapsedSeconds: dt } ) ) : 0;
		this.renderLoadBias = loadBias;

	}

	streamWorldRemainder( connector, root ) {

		this.worldBackgroundLoads.get( connector.worldId )?.abort();
		const controller = new AbortController();
		this.worldBackgroundLoads.set( connector.worldId, controller );
		this.worldStreamState.set( connector.worldId, { connector, root, controller, lastUpdate: 0, loading: false, loadingController: null, loadingObjectIDs: new Set(), loadingComponentIDs: new Set(), loadingRank: Infinity } );

	}

	async installWorldComponents( root, connector, componentIDs = null ) {
		const installed = [];
		const installedIDs = root.userData.installedWorldComponentIDs ||= new Set();
		for ( const component of connector.manifest.components || [] ) {
			if ( installedIDs.has( component.id ) || componentIDs && ! componentIDs.has( component.id ) || component.placementAssetId && ! connector.assets.has( component.placementAssetId ) || component.dataAssetId && ! connector.assets.has( component.dataAssetId ) || component.type === 'tidewater.ambient-audio/1' && component.beds.some( ( bed ) => ! connector.assets.has( bed.assetId ) ) ) continue;
			const count = installed.length;
			if ( component.type === 'tidewater.procedural-island-vegetation/1' || component.type === 'tidewater.static-vegetation/1' ) {
				if ( ! this.vegetationEnabled ) continue;
				const placementRecords = component.placementAssetId ? readVegetationPlacements( connector, component ) : null;
				const staticVegetation = component.type === 'tidewater.static-vegetation/1';
				if ( ! staticVegetation && ! this.remoteWorldActive && this.vegetation && this.vegetation.group.parent !== root && ( ! placementRecords || sameVegetationPlacements( this.vegetation.records, placementRecords ) ) ) {
					root.add( this.vegetation.group );
					installed.push( this.vegetation );
				} else {
					installed.push( new Vegetation( { scene: root, terrain: staticVegetation ? null : this.terrainData, village: staticVegetation ? null : this.village, includeGrass: ! staticVegetation, placementRecords } ) );
				}
			} else if ( component.type === 'tidewater.terrain-surface/1' ) {
				const fallback = root.children.find( ( child ) => child.userData.worldObjectId === component.objectId );
				const replacedObjects = root.userData.worldPackage?.replacedByComponents || ( root.userData.worldPackage.replacedByComponents = new Set() );
				replacedObjects.add( component.objectId );
				const maps = await decodeTerrainSurfaceAsset( connector.assets.get( component.dataAssetId ) );
				const terrainData = new HeightfieldTerrainData( maps );
				const surfaceMaps = { normal: maps.normal, splat: maps.splat, detailWidth: maps.detailWidth, detailHeight: maps.detailHeight, detail: maps.detail };
				const terrainGPU = new TerrainGPU( terrainData, null, surfaceMaps );
				const terrain = new Terrain( { scene: root, terrainData, terrainGPU } );
				if ( fallback ) fallback.visible = false;
				installed.push( {
					islandTerrain: true,
					update: ( _dt, camera ) => terrain.update( camera, true ),
					dispose: () => { replacedObjects.delete( component.objectId ); root.remove( terrain.mesh ); terrain.mesh.geometry.dispose(); terrain.mesh.material.dispose(); terrainGPU.dispose(); if ( fallback ) fallback.visible = true; },
				} );
			} else if ( component.type === 'tidewater.procedural-island-terrain/1' ) {
				const fallback = root.children.find( ( child ) => child.userData.worldObjectId === component.objectId );
				const replacedObjects = root.userData.worldPackage?.replacedByComponents || ( root.userData.worldPackage.replacedByComponents = new Set() );
				replacedObjects.add( component.objectId );
				const terrain = new Terrain( { scene: root, terrainData: this.terrainData, terrainGPU: this.terrainGPU } );
				if ( fallback ) fallback.visible = false;
				installed.push( {
					islandTerrain: true,
					update: ( _dt, camera ) => terrain.update( camera, false ),
					dispose: () => { replacedObjects.delete( component.objectId ); root.remove( terrain.mesh ); terrain.mesh.geometry.dispose(); terrain.mesh.material.dispose(); if ( fallback ) fallback.visible = true; },
				} );
			} else if ( component.type === 'tidewater.static-reef/1' ) {
				const { records } = readReefPlacements( connector, component );
				let reef = root.userData.staticReef;
				if ( reef ) {
					reef.appendPlacements( records );
				} else {
					reef = new Reef( { scene: root, terrain: null, placementRecords: records, maxInstances: reefPlacementCapacity( connector ) } );
					reef.setOcean( this.fft );
					root.userData.staticReef = reef;
					installed.push( {
						reef: true,
						update: ( dt, camera ) => reef.update( dt, camera?.position ),
						dispose: () => {
							if ( root.userData.staticReef === reef ) delete root.userData.staticReef;
							reef.dispose();
						},
					} );
				}
				installedIDs.add( component.id );
			} else if ( component.type === 'tidewater.island-ocean/1' ) {
				const lod = new CDLOD( { gridSize: Number( this.qs.get( 'G' ) || 32 ), leafSize: 8, levels: 12, minY: - 25, maxY: 25 } );
				const mesh = new Mesh( lod.geometry, this.waterMaterial );
				mesh.frustumCulled = false;
				mesh.receiveShadow = true;
				mesh.layers.set( LAYERS.WATER );
				root.add( mesh );
				installed.push( { islandOcean: true, update: ( _dt, camera ) => lod.update( camera ), dispose: () => { root.remove( mesh ); lod.geometry.dispose(); } } );
			} else if ( component.type === 'tidewater.water-body/1' ) {
				const extent = component.extent;
				const lod = new CDLOD( {
					gridSize: Number( this.qs.get( 'G' ) || 32 ), leafSize: 8, levels: 12, minY: - 25, maxY: 25,
					center: { x: component.center[ 0 ] - extent, z: component.center[ 1 ] - extent, size: extent * 2 },
				} );
				const surface = new WaterSurface( { fft: this.fft, cdlod: lod, foamTexture: this.foamTexture, seaLevel: connector.manifest.rules.seaLevel } );
				applyWaterBodyProfile( surface, component.profile );
				const material = new WaterMaterial( {
					surface, sky: this.sky, sceneCopy: this.sceneRenderer.opaqueCopy, sceneDepthHalf: this.sceneRenderer.opaqueDepthHalf.texture,
				} );
				material.clouds = this.clouds;
				if ( this.desktopAdaptiveScale ) material.params.ssr.value = 0;
				const mesh = new Mesh( lod.geometry, material );
				mesh.frustumCulled = false;
				mesh.receiveShadow = true;
				mesh.layers.set( LAYERS.WATER );
				root.add( mesh );
				installed.push( { waterBody: true, update: ( _dt, camera ) => lod.update( camera ), dispose: () => { root.remove( mesh ); lod.geometry.dispose(); material.dispose(); } } );
			} else if ( component.type === 'tidewater.ambient-audio/1' ) {
				// SoundScape consumes the signed component from the connector directly; record
				// installation here so view streaming does not repeatedly request its loop assets.
				installedIDs.add( component.id );
			} else if ( component.type === 'tidewater.downeast-boat/1' ) {
				const object = connector.manifest.objects.find( ( candidate ) => candidate.id === component.objectId );
				if ( ! object ) throw new Error( `Boat component ${component.id} has no berth object` );
				const boat = new HostedBoat( { root, component, object } );
				installed.push( {
					hostedBoat: true,
					boat,
					activate: ( context ) => boat.activate( context ),
					deactivate: () => boat.deactivate(),
					update: ( dt ) => boat.update( dt ),
					dispose: () => boat.dispose(),
				} );
			}
			if ( installed.length > count ) installedIDs.add( component.id );
		}
		root.userData.worldComponents ||= [];
		root.userData.worldComponents.push( ...installed );
	}

	activateHostedWorld( root, connector ) {

		this.prepareHostedWorld( connector );
		const runtime = ( root.userData.worldComponents || [] ).find( ( component ) => component.hostedBoat );
		this.activeHostedBoat = runtime || null;
		this.player.boat = runtime ? runtime.activate( { query: this.hostedQuery, colliders: this.hostedColliders } ) : null;
		if ( runtime ) {
			const policy = vehiclePolicy( connector.manifest.rules );
			if ( policy.enabled ) this.player.boat.setMaxSpeed( policy.maxSpeed );
		}
		this.startWorldPresence( root, connector );

	}

	startWorldPresence( root, connector ) {
		this.worldPresence = new WorldPresenceSession( { connector, parent: root } );
	}

	prepareHostedWorld( connector ) {

		this.deactivateHostedWorld();
		this.player.terrain = null;
		this.player.colliders = this.hostedColliders;
		this.player.query = this.hostedQuery;
		this.player.slot = this.hostedPlayerSlot;
		this.player.reef = null;
		const hasWater = connector.manifest.components.some( ( component ) => component.type === 'tidewater.island-ocean/1' || component.type === 'tidewater.water-body/1' );
		this.player.hostedSeaLevel = hasWater && Number.isFinite( connector.manifest.rules.seaLevel ) ? connector.manifest.rules.seaLevel : hasWater ? 0 : null;

	}

	deactivateHostedWorld() {

		this.worldPresence?.dispose();
		this.worldPresence = null;

		const runtime = this.activeHostedBoat;
		if ( ! runtime ) return;
		const controller = runtime.boat.controller;
		const wasDriving = controller?.driven;
		runtime.deactivate();
		if ( this.player.boat === controller ) this.player.boat = null;
		if ( this.player.mode === 'boat' || this.player.mode === 'deck' ) {
			this.player.mode = 'walk';
			this.player.velocity.set( 0, 0, 0 );
			this.player._camY = null;
		}
		if ( wasDriving && this.player.audio ) this.player.audio.engineStop();
		this.activeHostedBoat = null;

	}

	updateWorldComponents( root, dt, camera ) {
		const components = root?.userData?.worldComponents || [];
		const activeWater = components.some( ( component ) => component.islandOcean || component.waterBody || component.reef );
		const previewRoot = this.portalPreviewId ? this.portalPreparations.get( this.portalPreviewId )?.root : null;
		const previewWater = ( previewRoot?.userData?.worldComponents || [] ).some( ( component ) => component.islandOcean || component.waterBody || component.reef );
		if ( dt > 0 && ( activeWater || previewWater ) ) this.fft.update( dt );
		for ( const component of components ) component.update( dt, camera );
	}

	updateWorldStreaming() {

		const connector = this.worldConnector, root = this.linkedWorldRoot;
		const state = connector && this.worldStreamState.get( connector.worldId );
		if ( ! this.remoteWorldActive || ! state || state.root !== root || state.controller.signal.aborted || performance.now() - state.lastUpdate < 400 ) return;
		state.lastUpdate = performance.now();
		const loaded = root.userData.worldPackage?.loadedObjects || new Set();
		const objects = selectWorldObjectsForView( connector.manifest, this.camera ).filter( ( object ) => ! loaded.has( object.id ) );
		const wantedObjectIDs = new Set( objects.map( ( object ) => object.id ) );
		const installedComponents = root.userData.installedWorldComponentIDs || new Set();
		const components = selectWorldComponentsForView( connector.manifest, this.camera ).filter( ( component ) => ( this.vegetationEnabled || ! isVegetationComponent( component ) ) && ! installedComponents.has( component.id ) );
		const wantedComponentIDs = new Set( components.map( ( component ) => component.id ) );
		const assetPriorities = new Map( connector.manifest.assets.map( ( asset ) => [ asset.id, asset.priority ] ) );
		const rank = { 'portal-preview': 0, visible: 1, nearby: 2, background: 3 };
		const wantedRank = objects.reduce( ( best, object ) => Math.min( best, rank[ object.priority || assetPriorities.get( object.assetId ) ] ?? 1 ), Infinity );
		const componentRank = components.reduce( ( best, component ) => Math.min( best, rank[ component.priority || assetPriorities.get( component.placementAssetId ) || assetPriorities.get( component.beds?.[ 0 ]?.assetId ) ] ?? 1 ), Infinity );
		const loadRank = Math.min( wantedRank, componentRank );
		if ( state.loading ) {
			const allStillNeeded = [ ...state.loadingObjectIDs ].every( ( objectID ) => wantedObjectIDs.has( objectID ) ) && [ ...state.loadingComponentIDs ].every( ( componentID ) => wantedComponentIDs.has( componentID ) );
			if ( ! allStillNeeded || loadRank < state.loadingRank ) state.loadingController?.abort( new DOMException( 'View priority changed', 'AbortError' ) );
			return;
		}
		if ( objects.length === 0 && components.length === 0 ) return;
		const objectIDs = new Set( objects.map( ( object ) => object.id ) );
		const componentIDs = new Set( components.map( ( component ) => component.id ) );
		const assetIDs = new Set( [ ...objects.map( ( object ) => object.assetId ), ...components.flatMap( componentAssetIDs ) ] );
		const loadController = new AbortController();
		const abortForWorldChange = () => loadController.abort( state.controller.signal.reason );
		if ( state.controller.signal.aborted ) abortForWorldChange();
		else state.controller.signal.addEventListener( 'abort', abortForWorldChange, { once: true } );
		state.loading = true;
		state.loadingController = loadController;
		state.loadingObjectIDs = objectIDs;
		state.loadingComponentIDs = componentIDs;
		state.loadingRank = loadRank;
		connector.preload( { assetIDs, signal: loadController.signal, concurrency: 2 } ).then( async ( assets ) => {
			if ( loadController.signal.aborted || state.controller.signal.aborted || this.linkedWorldRoot !== root ) return;
			await appendWorldPackageAssets( connector, root, assets, { signal: loadController.signal, objectIDs } );
			await this.installWorldComponents( root, connector, componentIDs );
			return registerWorldPackageCollisions( root, this.hostedColliders );
		} ).catch( ( error ) => {
			if ( ! loadController.signal.aborted && ! state.controller.signal.aborted ) console.warn( `View-driven world asset load failed for ${connector.worldId}`, error );
		} ).finally( () => {
			state.controller.signal.removeEventListener( 'abort', abortForWorldChange );
			if ( state.loadingController === loadController ) {
				state.loading = false;
				state.loadingController = null;
				state.loadingObjectIDs = new Set();
				state.loadingComponentIDs = new Set();
				state.loadingRank = Infinity;
			}
		} );

	}

	updateWorldPortals() {

		const connector = this.worldConnector;
		if ( ! this.remoteWorldActive || ! connector?.manifest?.portals ) {
			this.clearPortalPreview();
			return;
		}
		const current = this.camera.position;
		if ( ! this.portalPreviousPosition ) this.portalPreviousPosition = current.clone();
		const previous = this.portalPreviousPosition.clone();
		this.portalPreviousPosition.copy( current );
		const candidates = connector.manifest.portals.flatMap( ( physicalPortal ) => {
			const previousRoute = portalRouteFromPosition( physicalPortal, previous );
			const crossed = previousRoute && crossedPortalPlane( previous, current, previousRoute );
			const portal = crossed ? previousRoute : portalRouteFromPosition( physicalPortal, current );
			if ( ! portal ) return [];
			const entry = portal.entry.position;
			const dx = current.x - entry[ 0 ], dy = current.y - entry[ 1 ], dz = current.z - entry[ 2 ];
			return [ { portal, distanceSq: dx * dx + dy * dy + dz * dz, crossed } ];
		} );
		const crossed = candidates.filter( ( candidate ) => candidate.crossed ).sort( ( a, b ) => a.distanceSq - b.distanceSq )[ 0 ];
		const inRange = candidates.filter( ( candidate ) => candidate.distanceSq <= 32 * 32 );
		const target = crossed || inRange.filter( ( candidate ) => candidate.portal.openView ).sort( ( a, b ) => a.distanceSq - b.distanceSq )[ 0 ] || inRange.sort( ( a, b ) => a.distanceSq - b.distanceSq )[ 0 ];
		if ( ! target ) {
			this.cancelUnneededPortalPreparations( null );
			this.clearPortalPreview();
			return;
		}

		const { portal } = target;
		const portalKey = portal.connectionKey || portal.id;
		this.cancelUnneededPortalPreparations( portalKey );
		if ( ! portal.openView ) this.clearPortalPreview();
		let preparation = this.portalPreparations.get( portalKey );
		const attempt = preparation?.attempt || 0;
		if ( preparation?.status === 'failed' && Date.now() >= preparation.retryAt ) {
			this.portalPreparations.delete( portalKey );
			preparation = null;
		}
		if ( ! preparation && this.remoteWorlds.has( portal.destinationWorldId ) ) {
			const cached = this.remoteWorlds.get( portal.destinationWorldId );
			preparation = { status: 'ready', connector: cached.connector, root: cached.root };
			this.portalPreparations.set( portalKey, preparation );
		}
		if ( ! preparation ) {
			preparation = { status: 'loading', noticeShown: false, attempt, controller: new AbortController() };
			this.portalPreparations.set( portalKey, preparation );
			const signal = preparation.controller.signal;
			connector.preparePortal( portal, { signal, onPreview: async ( { connector: destination, assets } ) => {
				if ( signal.aborted ) return null;
				if ( ! portal.openView ) return null;
				const root = await loadWorldPackage( destination, { assets, signal, materialContext: this.worldVillageMaterialContext } );
				if ( signal.aborted ) { disposeWorldPackage( root ); return null; }
				await this.installWorldComponents( root, destination, componentsThroughPriority( destination, 'portal-preview', this.vegetationEnabled ) );
				root.name = `hosted-world:${portal.destinationWorldId}`;
				Object.assign( preparation, { connector: destination, root } );
				return { root };
			} } ).then( async ( prepared ) => {
			if ( signal.aborted ) { prepared.connector.close(); return; }
			const root = prepared.preview?.root || await loadWorldPackage( prepared.connector, { assets: prepared.assets, signal, materialContext: this.worldVillageMaterialContext } );
			preparation.root = root;
			if ( signal.aborted ) { this.disposeUncommittedWorldComponents( root ); prepared.connector.close(); return; }
			await this.installWorldComponents( root, prepared.connector, componentsThroughPriority( prepared.connector, 'visible', this.vegetationEnabled ) );
			await appendWorldPackageAssets( prepared.connector, root, prepared.assets, { signal } );
			if ( signal.aborted ) { this.disposeUncommittedWorldComponents( root ); prepared.connector.close(); return; }
				root.name = `hosted-world:${portal.destinationWorldId}`;
				Object.assign( preparation, { status: 'ready', connector: prepared.connector, root } );
				preparation.vehicleTransfer = this.vehicleTransferStatus( prepared.connector );
				this.remoteWorlds.set( portal.destinationWorldId, { connector: prepared.connector, root } );
			} ).catch( ( error ) => {
				if ( signal.aborted ) {
					this.disposeUncommittedWorldComponents( preparation.root );
					preparation.connector?.close();
					if ( this.portalPreparations.get( portalKey ) === preparation ) this.portalPreparations.delete( portalKey );
					return;
				}
				preparation.retryAt = Date.now() + Math.min( 60000, 2500 * 2 ** preparation.attempt );
				Object.assign( preparation, { status: 'failed', error, attempt: preparation.attempt + 1 } );
				console.warn( `Could not prepare portal ${portalKey}`, error );
			} );
		}
		const ridingVehicle = this.player.mode === 'boat' || this.player.mode === 'deck';
		const vehicleTransfer = preparation.connector ? this.vehicleTransferStatus( preparation.connector ) : preparation.vehicleTransfer;
		if ( portal.openView && preparation.root && ( ! ridingVehicle || vehicleTransfer?.allowed ) ) {
			if ( this.portalPreviewId !== portalKey ) this.clearPortalPreview();
			this.portalPreviewId = portalKey;
			this.portalView.setTarget( preparation.root, portal );
		} else {
			this.clearPortalPreview();
		}

		if ( ! crossed ) return;
		if ( preparation.status === 'ready' ) {
			if ( ridingVehicle && ! vehicleTransfer?.allowed ) {
				this.holdPlayerAtPortal( previous );
				if ( ! preparation.vehicleBlockedNoticeShown ) {
					preparation.vehicleBlockedNoticeShown = true;
					this.ui?.ui?.toast( vehicleTransfer?.reason || 'This ThruHold does not accept vehicle entry', 3500 );
				}
				return;
			}
			this.enterWorldPortal( portal, preparation );
			return;
		}

		// Never expose an empty destination: hold the camera on the entry side until its
		// signed manifest and prioritized destination assets are ready.
		this.camera.position.copy( previous );
		this.portalPreviousPosition.copy( previous );
		this.holdPlayerAtPortal( previous );
		if ( ! preparation.noticeShown ) {
			preparation.noticeShown = true;
			this.ui?.ui?.toast( preparation.status === 'failed' ? 'This portal could not load its destination' : 'Preparing the world beyond this portal…', 3500 );
		}

	}

	holdPlayerAtPortal( previous ) {
		const mode = this.player.mode;
		if ( mode === 'boat' || mode === 'deck' ) {
			const snapshot = this.portalVehiclePreviousState;
			if ( snapshot?.controller === this.activeHostedBoat?.boat.controller ) {
				snapshot.controller.acceptTransfer( snapshot.state, snapshot.controller.maxSpeed );
				this.player.mode = snapshot.mode;
				this.player.deckPos.copy( snapshot.deckPos );
				this.player.deckYaw = snapshot.deckYaw;
			}
			this.camera.position.copy( previous );
			return;
		}
		const velocity = this.player.velocity.clone();
		this.camera.position.copy( previous );
		this.player.setHostedWorldPose( previous, this.player.yaw, this.player.pitch );
		this.player.velocity.copy( velocity );
		this.player.mode = mode;
	}

	vehicleTransferStatus( destinationConnector ) {
		if ( ! [ 'boat', 'deck' ].includes( this.player.mode ) ) return { allowed: true };
		const sourceController = this.activeHostedBoat?.boat.controller;
		if ( ! sourceController ) return { allowed: false, reason: 'The current vehicle cannot be transferred' };
		const policy = vehiclePolicy( destinationConnector.manifest.rules );
		if ( ! policy.enabled ) return { allowed: false, reason: 'This ThruHold does not accept vehicles' };
		if ( ! destinationConnector.manifest.components.some( ( component ) => component.type === 'tidewater.downeast-boat/1' ) ) return { allowed: false, reason: 'This ThruHold has no compatible boat berth' };
		const combinedComplexity = destinationConnector.manifest.rules.avatarComplexity + boatTriangleCount( this.activeHostedBoat.boat.model.group );
		if ( combinedComplexity > policy.maxCombinedComplexity ) return { allowed: false, reason: 'This vehicle exceeds the ThruHold complexity limit' };
		return { allowed: true, maxSpeed: policy.maxSpeed };
	}

	clearPortalPreview() {

		this.portalView?.setTarget( null, null );
		this.portalPreviewId = null;

	}

	cancelUnneededPortalPreparations( targetPortalId ) {
		for ( const [ portalId, preparation ] of this.portalPreparations ) {
			if ( portalId === targetPortalId || preparation.status !== 'loading' ) continue;
			preparation.controller?.abort( new DOMException( 'Portal is no longer in view', 'AbortError' ) );
			this.disposeUncommittedWorldComponents( preparation.root );
			preparation.connector?.close();
			this.portalPreparations.delete( portalId );
		}

	}

	disposeUncommittedWorldComponents( root ) {
		for ( const component of root?.userData?.worldComponents || [] ) {
			if ( component !== this.vegetation ) component.dispose?.();
		}
		if ( root?.userData ) root.userData.worldComponents = [];
		disposeWorldPackage( root );

	}

	enterWorldPortal( portal, preparation ) {

		const sourceConnector = this.worldConnector;
		const destinationConnector = preparation.connector;
		const destinationRoot = preparation.root;
		this.clearPortalPreview();
		const sourceVehicleMode = this.player.mode;
		const sourceVehicle = [ 'boat', 'deck' ].includes( sourceVehicleMode ) ? this.activeHostedBoat?.boat.controller?.transferState() : null;
		const deckPosition = this.player.deckPos.clone();
		const deckYaw = this.player.deckYaw;
		const arrival = mapPortalPlayerState( {
			position: this.camera.position, velocity: this.player.velocity,
			yaw: this.player.yaw, pitch: this.player.pitch,
		}, portal.entry, portal.exit );
		this.deactivateHostedWorld();
		this.worldBackgroundLoads.get( sourceConnector.worldId )?.abort();
		this.worldBackgroundLoads.delete( sourceConnector.worldId );
		this.scene.remove( this.linkedWorldRoot );
		unregisterWorldPackageCollisions( this.linkedWorldRoot, this.hostedColliders );
		this.linkedWorldRoot = destinationRoot;
		registerWorldPackageCollisions( destinationRoot, this.hostedColliders );
		this.scene.add( destinationRoot );
		this.worldConnector = destinationConnector;
		this.player.setWorldRules( destinationConnector.manifest.rules );
		G.seaLevel.value = worldSeaLevel( destinationConnector.manifest.rules );
		this.player.setHostedWorldPose( arrival.position, arrival.yaw, arrival.pitch );
		this.activateHostedWorld( destinationRoot, destinationConnector );
		if ( sourceVehicle ) {
			const destinationBoat = this.activeHostedBoat?.boat.controller;
			const policy = vehiclePolicy( destinationConnector.manifest.rules );
			const mappedVehicle = mapPortalVehicleState( sourceVehicle, portal.entry, portal.exit );
			destinationBoat.acceptTransfer( { ...sourceVehicle, ...mappedVehicle }, policy.maxSpeed );
			this.player.mode = sourceVehicleMode;
			this.player.deckPos.copy( deckPosition );
			this.player.deckYaw = deckYaw;
		}
		this.remoteWorlds.set( destinationConnector.worldId, { connector: destinationConnector, root: destinationRoot } );
		this.streamWorldRemainder( destinationConnector, destinationRoot );

		this.player.velocity.set( arrival.velocity.x, arrival.velocity.y, arrival.velocity.z );
		this.portalPreviousPosition.copy( this.camera.position );
		this.cancelUnneededPortalPreparations( null );
		this.portalPreparations.clear();
		sourceConnector.close();

		const url = new URL( location.href );
		url.searchParams.set( 'worldId', destinationConnector.worldId );
		url.searchParams.set( 'nodeId', destinationConnector.nodeId );
		url.searchParams.set( 'gateway', destinationConnector.gateway );
		history.replaceState( null, '', url );
		rememberWorldVisit( {
			pageURL: location.href,
			worldId: destinationConnector.worldId,
			nodeId: destinationConnector.nodeId,
			gateway: destinationConnector.gateway,
			directory: destinationConnector.directory,
			title: destinationConnector.manifest.title,
		} );
		document.title = `${destinationConnector.manifest.title} · ElseMesh`;
		this.ui?.ui?.toast( `Entered ${destinationConnector.manifest.title}`, 2600 );

	}

	_frame( dt ) {

		GPU.beginFrame();
		FrameUniforms.fields.frameIndex.value = GPU.frame;
		const s = this.settings;
		this.updateFPS( dt );
		G.dt.value = dt;
		G.time.value += dt;
		if ( s.timeSpeed !== 0 ) s.timeOfDay = ( s.timeOfDay + dt * s.timeSpeed + 24 ) % 24;

		// ---- player / boat (boat physics first so the cameras follow this frame's pose)
		if ( ! this.remoteWorldActive && this.input.hit( 'KeyF' ) ) this.setFreeCam( ! this.freeCam );
		if ( this.input.hit( 'KeyT' ) ) this.toggleTime();
		if ( this.input.hit( 'KeyL' ) ) {

			const on = this.localLights.toggleFlashlight();
			if ( this.ui ) this.ui.ui.toast( on ? 'Flashlight on' : 'Flashlight off' );

		}

		if ( this.input.hit( 'KeyM' ) && this.audio ) {

			this.audio.setMuted( ! this.audio.muted );
			if ( this.ui ) this.ui.ui.toast( this.audio.muted ? 'Sound off' : 'Sound on' );

		}
		if ( this.remoteWorldActive ) {
			const hostedBoat = this.activeHostedBoat?.boat.controller;
			this.portalVehiclePreviousState = [ 'boat', 'deck' ].includes( this.player.mode ) && hostedBoat ? {
				controller: hostedBoat, state: hostedBoat.transferState(), mode: this.player.mode,
				deckPos: this.player.deckPos.clone(), deckYaw: this.player.deckYaw,
			} : null;
			if ( this.player.hostedSeaLevel !== null ) {
				this.hostedQuery.setCamera( this.camera.position.x, this.camera.position.z );
				this.hostedQuery.setPoint( this.player.slot, this.player.position.x, this.player.position.z );
				hostedBoat?.queueQueries();
				this.hostedQuery.update();
				hostedBoat?.update( dt );
				this.player.waterH = this.player.waterHeight();
				this.player.waterMean = this.player.waterMean === null ? this.player.waterH : this.player.waterMean + ( this.player.waterH - this.player.waterMean ) * ( 1 - Math.exp( - dt / 4 ) );
			}
			this.player.updateHostedWorld( dt );
			this.updateWorldPortals();
			this.updateWorldStreaming();
			this.worldPresence?.update( dt, this.player, undefined, this.renderLoadBias );
			updateWorldPackageLOD( this.linkedWorldRoot, this.camera, this.renderLoadBias );
		}
		else {

			this.boatCtl.update( dt );
			this.boatSpray.update( dt );
			this.wake.update( dt );
			if ( this.freeCam ) this.fly.update( dt );
			else this.player.update( dt );
			this.game.update( dt );

		}
		this.updateSun();

		this.atmosphere.update( dt, this.camera.position.y );
		this.applyAtmosphereReadback();

		if ( this.remoteWorldActive ) {

			const waterSample = this.player.hostedSeaLevel !== null && this.hostedQuery.cpuValid ? this.hostedQuery.cpu[ 0 ] : this.player.hostedSeaLevel;
			this.cameraWaterHeight = Number.isFinite( waterSample ) ? waterSample : 0;
			G.cameraUnderwater.value = this.player.hostedSeaLevel !== null && this.camera.position.y < this.cameraWaterHeight - LENS_REACH ? 1 : 0;
			G.cameraWaterHeight.value = this.cameraWaterHeight;
			if ( this.clouds ) this.clouds.update( dt, this.camera );
			this.environment.update( dt );
			this.updateWorldComponents( this.linkedWorldRoot, dt, this.camera );

		} else {

			// ---- water simulation
			this.fft.update( dt );
			this.seaDetail.update( dt );
			this.query.setCamera( this.camera.position.x, this.camera.position.z );
			this.boatCtl.queueQueries();
			this.query.update();
			if ( this.query.cpuValid ) {

			const h0 = this.query.cpu[ 0 ];
			const h = Number.isFinite( h0 ) ? h0 : ( this.cameraWaterHeight ?? 0 );
			G.cameraUnderwater.value = this.camera.position.y < h - LENS_REACH ? 1 : 0;
			G.cameraWaterHeight.value = h;
			this.cameraWaterHeight = h;

			}

		if ( this.caustics ) this.caustics.update();
		// drawn while any part of the view can be under water (the specks above the surface are dropped)
		this.marineSnow.update( this.camera, this.camera.position.y < ( this.cameraWaterHeight ?? 0 ) + LENS_REACH );
		this.airMotes.update( dt, this.camera, this.cameraWaterHeight ?? 0 );
		if ( this.shoreSim ) this.shoreSim.update();
		this.underwaterLighting.update( this.camera );
		this.breakers.update( this.camera );
		this.spray.update();
		if ( this.clouds ) this.clouds.update( dt, this.camera );
		this.environment.update( dt );

		// ---- world
		this.oceanLOD.update( this.camera );
		this.terrain.update( this.camera );
		this.rocks.update( this.camera );
		this.debris.update( this.camera );
		this.reef.update( dt, this.camera.position );
		this.village.update( dt );
		if ( this.vegetation && ! this.remoteWorldActive ) this.vegetation.update( dt, this.camera );
		if ( this.whale ) this.whale.update( dt, this.camera );
		this.boat.update( dt );
		this.wildlife.update( dt, this.camera, this.freeCam ? null : this.player );
		this.localLights.update( this.camera, dt );

		}

		// ---- render
		G.exposure.value = s.exposure;
		updateCameraVelocity( this.camera );
		this.post.lens.update( dt, this.camera.position.y < ( this.cameraWaterHeight ?? 0 ) );
		if ( this.post.flare ) {

			this.post.flare.setDepthHeight( this.sceneRenderer.sceneRT.height );
			this.post.flare.update( this.camera, dt, { aboveWater: this.camera.position.y > ( this.cameraWaterHeight ?? 0 ) - 0.02 } );

		}

		// the post chain sets the TAAU jitter + internal size and writes the camera into the frame
		// uniforms (setFrameCamera); shadows then render with this frame's sun and camera
		this.post.beginFrame();
		this.underwater.updateCamera( this.camera );
		this.shadows.render( this.scene, this.engine.meshRenderer, this.shadows.update( this.camera, G.sunDir.value ) );
		this.portalView.render( performance.now(), this.camera, this.renderLoadBias );
		if ( this.remoteWorldActive ) this.updateWorldComponents( this.linkedWorldRoot, 0, this.camera );
		this.sceneRenderer.render();
		if ( this.post.flare ) this.post.flare.kernel.dispatch( 1 );
		this.post.render();
		this.post.endFrame();
		this.frameWorkMeter?.end();
		GPU.submit();
		this.profiler.update( dt );

		this.updateAudio( dt );
		if ( this.ui ) this.ui.update( dt );
		this.input.endFrame();

	}

	// Internal render resolution relative to the output. Lower values reduce GPU pixel work; the
	// temporal upscaler reconstructs the full output resolution.
	setRenderScale( v ) {

		const scale = MathUtils.clamp( Math.round( v * 20 ) / 20, 0.35, 1 );
		const canvasScale = Math.max( this.desktopCanvasScale, scale );
		const postScale = scale / canvasScale;
		if ( scale === this.settings.renderScale && this.engine.renderScale === canvasScale && this.post.scale === postScale ) return;
		this.settings.renderScale = scale;
		if ( this.engine.renderScale !== canvasScale ) this.engine.setRenderScale( canvasScale );
		if ( this.post.scale !== postScale ) this.post.setScale( postScale );
		if ( this.clouds ) this.clouds.resolutionScale = postScale;

	}

	updateAudio( dt ) {

		if ( ! this.audio ) return;
		if ( ! this.remoteWorldActive && ! this.audio.enabled ) {
			this.audio.setWorldAmbience( null, [] );
			return;
		}
		const cam = this.camera;
		const p = cam.position;
		const f = this._af || ( this._af = { fwd: new Vector3(), up: new Vector3() } );
		cam.getWorldDirection( f.fwd );
		f.up.set( 0, 1, 0 ).applyQuaternion( cam.quaternion );
		const listener = { position: p, forward: f.fwd, up: f.up };
		if ( this.remoteWorldActive && this.worldConnector ) {
			const connector = this.worldConnector;
			const components = ( connector.manifest.components || [] ).filter( ( component ) => component.type === 'tidewater.ambient-audio/1' );
			this.audio.setWorldAmbience( connector.worldId, components, connector.assets );
			if ( this.audio.enabled ) {
				const h = this.cameraWaterHeight ?? G.seaLevel.value;
				const boat = this.activeHostedBoat?.boat.controller;
				this.audio.updateWorldAudio( dt, {
					listener,
					underwater: p.y < h ? 1 : 0,
					depthBelowSurface: Math.max( 0, h - p.y ),
					daylight: 1 - G.night.value,
					timeOfDay: this.settings.timeOfDay,
					boat: boat ? {
						active: boat.driven, rpm: boat.rpm, speed: boat.velocity.length(), position: boat.model.group.position,
						listenerInside: this.player.mode === 'boat' && this.player.camMode === 'first',
					} : undefined,
				} );
			}
			return;
		}
		this.audio.setWorldAmbience( null, [] );
		if ( ! this.audio.enabled ) return;
		const h = this.cameraWaterHeight ?? 0;
		const coast = this.terrainData.coastDistance( p.x, p.z ).d;
		this.audio.update( dt, {
			listener,
			underwater: p.y < h ? 1 : 0,
			depthBelowSurface: Math.max( 0, h - p.y ),
			surfIntensity: Math.min( 1, this.shore.amplitude.value / 0.6 ),
			distanceToShore: Math.abs( coast ),
			coastDistance: coast,
			waveHeight: this.shore.amplitude.value * 2,
			windSpeed: G.windSpeed.value,
			windDir: G.windDir.value,
			daylight: 1 - G.night.value,
			nearPier: Math.abs( p.x - WORLD.pier.x ) < 12 && p.z > WORLD.pier.zStart - 5 && p.z < WORLD.pier.zEnd + 8,
			boat: {
				active: this.boatCtl.driven, rpm: this.boatCtl.rpm, throttle: this.boatCtl.throttle, speed: this.boatCtl.velocity.length(),
				position: this.boat.group.position, listenerInside: this.player.mode === 'boat' && this.player.camMode === 'first',
			},
		} );

	}

}

function readVegetationPlacements( connector, component ) {
	const bytes = connector.assets.get( component.placementAssetId );
	if ( ! bytes ) throw new Error( `Vegetation component ${component.id} is missing its placement asset` );
	return decodeVegetationPlacements( bytes, component.seed );
}

function boatTriangleCount( root ) {
	let triangles = 0;
	root.traverse( ( object ) => {
		const geometry = object.geometry;
		if ( ! object.isMesh || ! geometry?.attributes?.position ) return;
		const available = geometry.index?.count ?? geometry.attributes.position.count;
		const start = geometry.drawRange?.start ?? 0;
		const count = Number.isFinite( geometry.drawRange?.count ) ? geometry.drawRange.count : available - start;
		triangles += Math.floor( Math.max( 0, Math.min( available - start, count ) ) / 3 );
	} );
	return triangles;
}

function componentAssetIDs( component ) {
	return [ ...( component.placementAssetId ? [ component.placementAssetId ] : [] ), ...( component.dataAssetId ? [ component.dataAssetId ] : [] ), ...( component.beds || [] ).map( ( bed ) => bed.assetId ) ];
}

function readReefPlacements( connector, component ) {
	const bytes = connector.assets.get( component.placementAssetId );
	if ( ! bytes ) throw new Error( `Reef component ${component.id} is missing its placement asset` );
	return decodeReefPlacements( bytes );
}

function reefPlacementCapacity( connector ) {
	const assets = new Map( connector.manifest.assets.map( ( asset ) => [ asset.id, asset ] ) );
	let capacity = 0;
	for ( const component of connector.manifest.components || [] ) {
		if ( component.type !== 'tidewater.static-reef/1' ) continue;
		const asset = assets.get( component.placementAssetId );
		if ( ! asset || ! Number.isSafeInteger( asset.bytes ) || asset.bytes < REEF_PLACEMENT_HEADER_BYTES || ( asset.bytes - REEF_PLACEMENT_HEADER_BYTES ) % REEF_PLACEMENT_RECORD_BYTES !== 0 ) throw new Error( `Reef component ${component.id} has an invalid placement asset size` );
		capacity += ( asset.bytes - REEF_PLACEMENT_HEADER_BYTES ) / REEF_PLACEMENT_RECORD_BYTES;
		if ( capacity > MAX_REEF_PLACEMENTS ) throw new Error( 'World reef placements exceed the supported instance capacity' );
	}
	return Math.max( 1, capacity );
}

function componentsThroughPriority( connector, through, vegetationEnabled ) {
	const ranks = { 'portal-preview': 0, visible: 1, nearby: 2, background: 3 };
	const end = ranks[ through ];
	return new Set( ( connector.manifest.components || [] )
		.filter( ( component ) => ( vegetationEnabled || ! isVegetationComponent( component ) ) && ( ranks[ component.priority || ( component.placementAssetId ? 'portal-preview' : 'visible' ) ] ?? 1 ) <= end )
		.map( ( component ) => component.id ) );
}

function isVegetationComponent( component ) {
	return component.type === 'tidewater.procedural-island-vegetation/1' || component.type === 'tidewater.static-vegetation/1';
}

function sameVegetationPlacements( left, right ) {
	for ( const key of Object.keys( left ) ) {
		const a = left[ key ], b = right[ key ];
		if ( Array.isArray( a ) ) {
			if ( ! Array.isArray( b ) || a.length !== b.length ) return false;
			for ( let index = 0; index < a.length; index ++ ) {
				const aRecord = a[ index ], bRecord = b[ index ];
				const keys = Object.keys( aRecord );
				if ( ! bRecord || keys.length !== Object.keys( bRecord ).length || keys.some( ( field ) => ! Object.hasOwn( bRecord, field ) || Math.fround( aRecord[ field ] ) !== bRecord[ field ] ) ) return false;
			}
		} else if ( a !== b ) return false;
	}
	return true;
}
