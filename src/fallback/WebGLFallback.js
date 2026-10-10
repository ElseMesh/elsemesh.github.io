import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TerrainData } from '../world/TerrainData.js';
import { WorldConnector, worldLinkFromLocation } from '../network/WorldConnector.js';
import { DEFAULT_APPEARANCE } from '../player/AvatarAppearance.js';
import { portalRouteFromPosition } from '../network/PortalHandoff.js';
import villageUrl from '../../worlds/island/lod-source/village-low.glb?url';

const PRESENCE_PROTOCOL = 'elsemesh.player-presence/1';

export class WebGLFallback {

	constructor( app, engine ) {

		this.app = app;
		this.engine = engine;
		this.THREE = engine.THREE;
		this.renderer = engine.renderer;
		this.scene = new this.THREE.Scene();
		this.scene.background = new this.THREE.Color( 0xa6c9d3 );
		this.camera = new this.THREE.PerspectiveCamera( 65, 1, 0.1, 5000 );
		this.camera.rotation.order = 'YXZ';
		this.keys = new Set();
		this.velocityY = 0;
		this.sequence = 0;
		this.portals = [];
		this.blockers = [];
		this.remotePlayers = new Map();
		this.moveStick = { x: 0, y: 0 };
		this.loader = new GLTFLoader();
		this.worldLink = worldLinkFromLocation();

	}

	async init( onProgress = () => {} ) {

		const T = this.THREE;
		this.scene.add( new T.HemisphereLight( 0xd9f1ff, 0x42513f, 2.2 ) );
		const sun = new T.DirectionalLight( 0xfff0d2, 2.1 );
		sun.position.set( - 120, 220, 80 );
		this.scene.add( sun );
		this._makeHUD();
		if ( this.worldLink ) await this._loadHostedWorld( onProgress );
		else await this._loadIsland( onProgress );
		this.camera.position.set( ...this.spawn.position );
		this.yaw = this.spawn.yaw || 0;
		this.pitch = this.spawn.pitch || 0;
		this._look();
		this._bindInput();
		this._resize();
		window.addEventListener( 'resize', this._resize );
		this.renderer.setAnimationLoop( () => this._frame() );
		this._startPresence();

	}

	async _loadIsland( progress ) {

		progress( 0.15, 'Building a WebGL terrain…' );
		this.terrain = new TerrainData();
		const T = this.THREE, divisions = 144, size = this.terrain.size;
		const positions = [], colors = [], indices = [];
		for ( let j = 0; j <= divisions; j ++ ) for ( let i = 0; i <= divisions; i ++ ) {

			const x = - size / 2 + size * i / divisions, z = - size / 2 + size * j / divisions;
			const h = this.terrain.heightAt( x, z );
			positions.push( x, h, z );
			const c = h < - 0.7 ? [ 0.35, 0.42, 0.34 ] : h < 3.5 ? [ 0.76, 0.68, 0.48 ] : h < 28 ? [ 0.25, 0.39, 0.24 ] : [ 0.39, 0.38, 0.34 ];
			colors.push( ...c );
			if ( i < divisions && j < divisions ) {
				const a = j * ( divisions + 1 ) + i, b = a + divisions + 1;
				indices.push( a, b, a + 1, b, b + 1, a + 1 );
			}

		}
		const geometry = new T.BufferGeometry();
		geometry.setAttribute( 'position', new T.Float32BufferAttribute( positions, 3 ) );
		geometry.setAttribute( 'color', new T.Float32BufferAttribute( colors, 3 ) );
		geometry.setIndex( indices );
		geometry.computeVertexNormals();
		this.scene.add( new T.Mesh( geometry, new T.MeshStandardMaterial( { vertexColors: true, roughness: 0.94, side: T.DoubleSide } ) ) );
		const water = new T.Mesh( new T.PlaneGeometry( 4000, 4000 ), new T.MeshStandardMaterial( { color: 0x388da5, roughness: 0.32, metalness: 0.08 } ) );
		water.rotation.x = - Math.PI / 2;
		water.position.y = - 0.15;
		this.scene.add( water );
		progress( 0.55, 'Loading the island village…' );
		try {
			const model = await this.loader.loadAsync( villageUrl );
			this.scene.add( model.scene );
			this._collectBlockers( model.scene );
		} catch ( error ) {
			console.warn( 'WebGL fallback village model unavailable:', error );
		}
		this.spawn = { position: [ 53.6, this.terrain.heightAt( 53.6, -77 ) + 1.7, -77 ], yaw: Math.PI, pitch: - 0.05 };
		this.groundHeight = ( x, z ) => this.terrain.heightAt( x, z );
		this.worldName.textContent = 'WebGL mode · island rendering simplified';
		progress( 0.9, 'Starting the WebGL island…' );

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
		const assets = await this.connector.preload( { through: 'visible' } );
		const T = this.THREE, cache = new Map();
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
			const root = model.scene.clone( true );
			const tr = object.transform || {};
			root.position.set( ...( tr.position || [ 0, 0, 0 ] ) );
			if ( tr.rotation ) root.quaternion.set( ...tr.rotation ); else root.rotation.y = tr.yaw || 0;
			root.scale.set( ...( object.scale || [ 1, 1, 1 ] ) );
			root.updateMatrixWorld( true );
			this.scene.add( root );


		}
		this.portals = ( manifest.portals || [] ).filter( portal => portal.enabled || portal.back?.enabled );
		for ( const portal of this.portals ) this._addPortalMarker( portal );
		this._collectManifestBlockers( manifest.objects || [] );
		this._addHostedWater( manifest.components || [] );
		const unsupported = ( manifest.components || [] ).filter( component => ! [ 'tidewater.island-ocean/1', 'tidewater.water-body/1' ].includes( component.type ) ).map( component => component.type );
		const spawn = manifest.spawn || {};
		this.spawn = { position: spawn.position || [ 0, 1.7, 0 ], yaw: spawn.yaw || 0, pitch: spawn.pitch || 0 };
		const transfer = new URLSearchParams( location.search ).get( 'webglSpawn' )?.split( ',' ).map( Number );
		if ( transfer?.length === 5 && transfer.every( Number.isFinite ) && transfer.slice( 0, 3 ).every( value => Math.abs( value ) <= 100000 ) && Math.abs( transfer[ 3 ] ) <= 1000 && Math.abs( transfer[ 4 ] ) <= 1.5 ) {
			this.spawn = { position: transfer.slice( 0, 3 ), yaw: transfer[ 3 ], pitch: transfer[ 4 ] };
		}
		this.groundHeight = () => Number( this.spawn.position[ 1 ] ) - 1.7;
		this.worldName.textContent = `${ manifest.title || 'Hosted world' } · WebGL mode${ unsupported.length ? ` · ${ unsupported.length } GPU feature(s) omitted` : '' }`;
		progress( 0.9, 'Preparing hosted world…' );

	}

	_collectBlockers( root ) {

		const T = this.THREE;
		root.traverse( object => {
			if ( ! object.isMesh ) return;
			const bounds = new T.Box3().setFromObject( object );
			const size = bounds.getSize( new T.Vector3() );
			if ( ! bounds.isEmpty() && size.x > 0.5 && size.z > 0.5 && size.x < 90 && size.z < 90 && size.y > 0.5 ) this.blockers.push( { bounds, yaw: 0, centerX: ( bounds.min.x + bounds.max.x ) / 2, centerZ: ( bounds.min.z + bounds.max.z ) / 2, halfX: size.x / 2, halfZ: size.z / 2 } );
		} );

	}

	_collectManifestBlockers( objects ) {

		for ( const object of objects ) {
			const collision = object.collision;
			if ( ! collision?.enabled || ! collision.solid || ! [ 'box', 'compound' ].includes( collision.shape ) ) continue;
			const scale = object.scale || [ 1, 1, 1 ], transform = object.transform;
			const boxes = collision.shape === 'box' ? [ { center: collision.center, halfExtents: collision.halfExtents, yaw: 0 } ] : collision.boxes;
			for ( const item of boxes ) {
				const yaw = ( transform.yaw || 0 ) + ( item.yaw || 0 ), cos = Math.cos( transform.yaw || 0 ), sin = Math.sin( transform.yaw || 0 );
				const lx = item.center[ 0 ] * scale[ 0 ], lz = item.center[ 2 ] * scale[ 2 ];
				const hx = item.halfExtents[ 0 ] * scale[ 0 ], hz = item.halfExtents[ 2 ] * scale[ 2 ];
				this.blockers.push( { centerX: transform.position[ 0 ] + lx * cos + lz * sin, centerZ: transform.position[ 2 ] - lx * sin + lz * cos, halfX: hx, halfZ: hz, yaw, minY: transform.position[ 1 ] + item.center[ 1 ] * scale[ 1 ] - item.halfExtents[ 1 ] * scale[ 1 ], maxY: transform.position[ 1 ] + item.center[ 1 ] * scale[ 1 ] + item.halfExtents[ 1 ] * scale[ 1 ] } );
			}
		}

	}

	_addHostedWater( components ) {

		const T = this.THREE;
		for ( const component of components ) {
			if ( component.type === 'tidewater.island-ocean/1' ) {
				const water = new T.Mesh( new T.PlaneGeometry( 4000, 4000 ), new T.MeshStandardMaterial( { color: 0x388da5, roughness: 0.35 } ) );
				water.rotation.x = - Math.PI / 2; water.position.y = this.app.worldConnector?.manifest?.rules?.seaLevel ?? - 4.5; this.scene.add( water );
			} else if ( component.type === 'tidewater.water-body/1' ) {
				const water = new T.Mesh( new T.CircleGeometry( component.extent, 64 ), new T.MeshStandardMaterial( { color: 0x388da5, roughness: 0.35, side: T.DoubleSide } ) );
				water.rotation.x = - Math.PI / 2; water.position.set( component.center[ 0 ], this.app.worldConnector?.manifest?.rules?.seaLevel ?? 0, component.center[ 1 ] ); this.scene.add( water );
			}
		}

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
		Object.assign( badge.style, { position: 'fixed', top: '14px', right: '14px', zIndex: 30, maxWidth: 'min(440px, 80vw)', padding: '8px 11px', borderRadius: '8px', color: '#f2f7f4', background: '#14201ddd', font: '12px/1.4 system-ui', pointerEvents: 'none' } );
		document.body.appendChild( badge );
		const hint = document.createElement( 'div' );
		hint.className = 'elsemesh-webgl-hint';
		Object.assign( hint.style, { position: 'fixed', left: '16px', bottom: '16px', zIndex: 30, padding: '10px 12px', borderRadius: '8px', color: '#f2f7f4', background: '#14201ddd', font: '13px/1.5 system-ui', pointerEvents: 'none' } );
		hint.textContent = 'WASD move · mouse look · Shift run · E use portal';
		const style = document.createElement( 'style' );
		style.textContent = '@media (hover:none), (pointer:coarse) { .elsemesh-touch-pad { display:flex !important; } .elsemesh-webgl-hint { bottom:150px !important; } }';
		document.head.appendChild( style );
		const touchPads = [];
		for ( const role of [ 'move', 'look' ] ) {
			const pad = document.createElement( 'div' );
			pad.className = 'elsemesh-touch-pad';
			Object.assign( pad.style, { display: 'none', position: 'fixed', bottom: '20px', [ role === 'move' ? 'left' : 'right' ]: '20px', width: '112px', height: '112px', borderRadius: '50%', border: '1px solid #d9eee866', background: '#14201d66', zIndex: 29, touchAction: 'none', alignItems: 'center', justifyContent: 'center' } );
			const knob = document.createElement( 'div' );
			Object.assign( knob.style, { width: '42px', height: '42px', borderRadius: '50%', background: '#d9eee888', pointerEvents: 'none' } );
			pad.appendChild( knob ); document.body.appendChild( pad ); touchPads.push( { pad, knob, role } );
		}
		document.body.append( hint );
		this.worldName = document.createElement( 'div' );
		Object.assign( this.worldName.style, { position: 'fixed', left: '16px', top: '14px', zIndex: 30, padding: '8px 11px', borderRadius: '8px', color: '#f2f7f4', background: '#14201ddd', font: '12px/1.4 system-ui', pointerEvents: 'none' } );
		document.body.append( this.worldName );
		this.hud = [ badge, hint, this.worldName, style, ...touchPads.map( item => item.pad ) ];
		this.useButton = document.createElement( 'button' );
		this.useButton.textContent = 'Use portal';
		Object.assign( this.useButton.style, { display: 'none', position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: 31, padding: '12px 18px', border: '0', borderRadius: '10px', color: '#f2f7f4', background: '#14201ddd', font: 'bold 15px system-ui' } );
		this.useButton.addEventListener( 'click', () => this._useNearestPortal() ); document.body.append( this.useButton ); this.hud.push( this.useButton );
		this.touchPads = touchPads;

	}

	_bindInput() {

		this._keyDown = event => {
			this.keys.add( event.code );
			if ( event.code === 'KeyE' ) this._useNearestPortal();
			if ( event.code === 'Space' ) { event.preventDefault(); if ( this.onGround ) this.velocityY = 5; }
		};
		this._keyUp = event => this.keys.delete( event.code );
		this._mouse = event => {
			if ( document.pointerLockElement !== this.engine.canvas ) return;
			this.yaw -= event.movementX * 0.002;
			this.pitch = Math.max( - 1.45, Math.min( 1.45, this.pitch - event.movementY * 0.002 ) );
			this._look();
		};
		this._touches = new Map();
		for ( const { pad, knob, role } of this.touchPads ) {
			pad.addEventListener( 'pointerdown', event => {
				event.preventDefault(); pad.setPointerCapture( event.pointerId );
				this._touches.set( event.pointerId, { role, x: event.clientX, y: event.clientY, originX: event.clientX, originY: event.clientY, pad, knob } );
			} );
			pad.addEventListener( 'pointermove', event => {
				const touch = this._touches.get( event.pointerId ); if ( ! touch ) return;
				if ( role === 'move' ) {
					const dx = event.clientX - touch.originX, dy = event.clientY - touch.originY, radius = 40;
					const length = Math.max( 1, Math.hypot( dx, dy ) ), scale = Math.min( 1, radius / length );
					this.moveStick.x = dx * scale / radius; this.moveStick.y = dy * scale / radius;
					knob.style.transform = `translate(${ dx * scale }px, ${ dy * scale }px)`;
				} else {
					this.yaw -= ( event.clientX - touch.x ) * 0.006;
					this.pitch = Math.max( - 1.45, Math.min( 1.45, this.pitch - ( event.clientY - touch.y ) * 0.006 ) );
					touch.x = event.clientX; touch.y = event.clientY; this._look();
				}
			} );
			const end = event => {
				const touch = this._touches.get( event.pointerId ); if ( ! touch ) return;
				this._touches.delete( event.pointerId );
				if ( role === 'move' ) { this.moveStick.x = this.moveStick.y = 0; knob.style.transform = ''; }
			};
			pad.addEventListener( 'pointerup', end ); pad.addEventListener( 'pointercancel', end );
		}
		this._lockChange = () => { this.locked = document.pointerLockElement === this.engine.canvas; };
		this._resize = () => {
			const w = window.innerWidth, h = window.innerHeight;
			this.camera.aspect = w / Math.max( 1, h );
			this.camera.updateProjectionMatrix();
			this.renderer.setSize( w, h );
		};
		window.addEventListener( 'keydown', this._keyDown );
		window.addEventListener( 'keyup', this._keyUp );
		window.addEventListener( 'mousemove', this._mouse );
		document.addEventListener( 'pointerlockchange', this._lockChange );
		this.requestLock = () => this.engine.canvas.requestPointerLock?.();
		this.engine.canvas.addEventListener( 'click', this.requestLock );

	}

	_look() { this.camera.rotation.set( this.pitch, this.yaw, 0, 'YXZ' ); }

	_frame() {

		const now = performance.now(), dt = Math.min( 0.05, Math.max( 0, ( now - ( this.lastFrame || now ) ) / 1000 ) );
		this.lastFrame = now;
		const T = this.THREE, speed = this.keys.has( 'ShiftLeft' ) || this.keys.has( 'ShiftRight' ) ? 10 : 5;
		const forward = new T.Vector3( - Math.sin( this.yaw ), 0, - Math.cos( this.yaw ) );
		const right = new T.Vector3( Math.cos( this.yaw ), 0, - Math.sin( this.yaw ) );
		const move = new T.Vector3();
		if ( this.keys.has( 'KeyW' ) || this.keys.has( 'ArrowUp' ) ) move.add( forward );
		if ( this.keys.has( 'KeyS' ) || this.keys.has( 'ArrowDown' ) ) move.sub( forward );
		if ( this.keys.has( 'KeyD' ) || this.keys.has( 'ArrowRight' ) ) move.add( right );
		if ( this.keys.has( 'KeyA' ) || this.keys.has( 'ArrowLeft' ) ) move.sub( right );
		move.addScaledVector( forward, - this.moveStick.y );
		move.addScaledVector( right, this.moveStick.x );
		if ( move.lengthSq() ) {
			move.normalize().multiplyScalar( speed * dt );
			const old = this.camera.position.clone();
			this.camera.position.x += move.x;
			this.camera.position.z += move.z;
			if ( this._blocked( this.camera.position.x, this.camera.position.z ) ) this.camera.position.set( old.x, this.camera.position.y, old.z );
		}
		this.useButton.style.display = this._nearestPortalRoute() ? '' : 'none';
		const floor = Math.max( this.groundHeight( this.camera.position.x, this.camera.position.z ) + 1.7, 1.7 );
		this.velocityY -= 14 * dt;
		this.camera.position.y += this.velocityY * dt;
		if ( this.camera.position.y <= floor ) { this.camera.position.y = floor; this.velocityY = 0; this.onGround = true; } else this.onGround = false;
		this.renderer.render( this.scene, this.camera );

	}

	_blocked( x, z ) {

		for ( const box of this.blockers ) {
			if ( box.maxY !== undefined && ( box.maxY < this.camera.position.y - 1.7 || box.minY > this.camera.position.y + 0.2 ) ) continue;
			const dx = x - box.centerX, dz = z - box.centerZ, cos = Math.cos( box.yaw ), sin = Math.sin( box.yaw );
			if ( Math.abs( dx * cos - dz * sin ) < box.halfX + 0.35 && Math.abs( dx * sin + dz * cos ) < box.halfZ + 0.35 ) return true;
		}
		return false;

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

		if ( ! this.connector || ! this.worldLink ) return;
		const send = () => this.connector.updatePresence( {
			protocol: PRESENCE_PROTOCOL, sequence: this.sequence ++,
			position: [ this.camera.position.x, this.camera.position.y - 1.7, this.camera.position.z ], yaw: this.yaw, pitch: this.pitch,
			moving: this.keys.size > 0, mode: 'walk', appearance: { ...DEFAULT_APPEARANCE },
		} ).then( snapshot => this._updateRemotePlayers( snapshot ) ).catch( error => { if ( ! this.presenceFailed ) console.warn( 'WebGL fallback presence unavailable:', error.message ); this.presenceFailed = true; } );
		this.presenceTimer = setInterval( send, 1800 );
		send();
		window.addEventListener( 'pagehide', () => this.connector.leavePresence().catch( () => {} ), { once: true } );

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
