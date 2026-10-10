import { validatePortalBack } from './PortalSideContract.js';
import { validateObjectLODs, validateWorldSpawn } from './WorldSource.js';
import { validatePresencePose } from './PlayerPresence.js';
import { validateWorldRequirements } from './WorldRules.js';
import { validateWorldExperience } from './WorldExperience.js';

const ASSET_CHUNK_BYTES = 128 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const PRIORITY_ORDER = Object.freeze( [ 'portal-preview', 'visible', 'nearby', 'background' ] );

function invariant( value, message ) { if ( ! value ) throw new Error( message ); }

function throwIfAborted( signal ) {
	if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
}

export function assetConcurrencyForConnection( connection = globalThis.navigator?.connection, measuredBytesPerSecond = null ) {
	if ( connection?.saveData ) return 1;
	const type = connection?.effectiveType;
	const downlink = Number.isFinite( connection?.downlink ) && connection.downlink > 0 ? connection.downlink : null;
	if ( type === 'slow-2g' || type === '2g' || ( downlink !== null && downlink < 1 ) ) return 1;
	if ( Number.isFinite( measuredBytesPerSecond ) && measuredBytesPerSecond > 0 ) {
		if ( measuredBytesPerSecond < 768 * 1024 ) return 1;
		if ( measuredBytesPerSecond < 4 * 1024 * 1024 ) return 2;
		return 3;
	}
	if ( ! connection ) return 3;
	if ( type === '3g' || ( downlink !== null && downlink < 4 ) ) return 2;
	return 3;
}

export function worldLinkFromLocation( location = globalThis.location ) {
	const params = new URLSearchParams( location.search );
	const worldId = params.get( 'worldId' );
	if ( ! worldId ) return null;
	return {
		worldId,
		nodeId: params.get( 'nodeId' ),
		gateway: params.get( 'gateway' ) || location.origin,
		directory: params.get( 'directory' ),
	};
}

export function createWorldInviteURL( { pageURL = globalThis.location?.href, worldId, nodeId, gateway, directory = '' } = {} ) {
	invariant( /^tw-world:[\w.-]{1,128}$/.test( worldId || '' ), 'A valid worldId is required for an invite' );
	const url = new URL( pageURL );
	invariant( url.protocol === 'https:' || url.protocol === 'http:', 'Invite page URL must use HTTP(S)' );
	url.searchParams.set( 'worldId', worldId );
	if ( nodeId ) {
		invariant( /^[A-Za-z0-9]{20,256}$/.test( nodeId ), 'Invalid invite node PeerID' );
		url.searchParams.set( 'nodeId', nodeId );
	} else url.searchParams.delete( 'nodeId' );
	if ( gateway ) {
		invariant( validSecureGateway( gateway ), 'Invite gateway must be a secure HTTPS/WSS origin' );
		url.searchParams.set( 'gateway', gateway );
	} else url.searchParams.delete( 'gateway' );
	if ( directory ) {
		invariant( validSecureOrigin( directory ), 'Invite directory must be an HTTPS origin' );
		url.searchParams.set( 'directory', directory );
	} else url.searchParams.delete( 'directory' );
	return url.href;
}

export class WorldConnector {
	constructor( { worldId, nodeId, gateway = globalThis.location?.origin, directory = '', chunkBytes = ASSET_CHUNK_BYTES } = {} ) {
		invariant( /^tw-world:[\w.-]{1,128}$/.test( worldId || '' ), 'A valid worldId is required' );
		invariant( Number.isInteger( chunkBytes ) && chunkBytes > 0 && chunkBytes <= 192 * 1024, 'Invalid asset chunk size' );
		invariant( ! directory || validSecureOrigin( directory ), 'Directory must be an HTTPS origin' );
		this.worldId = worldId;
		this.nodeId = nodeId || '';
		this.gateway = gateway;
		this.directory = directory;
		this.chunkBytes = chunkBytes;
		this.manifest = null;
		this.assets = new Map();
		this.assetDownloads = new Map();
		this.unavailableProviders = new Set();
		this.providerRecovery = null;
		this.transferRateBytesPerSecond = null;
		this.socket = null;
		this.webTransport = null;
		this.webTransportFailed = false;
		this.socketPromise = null;
		this.pending = new Map();
	}

	async getManifest( { signal, excludeProviders = this.unavailableProviders } = {} ) {
		throwIfAborted( signal );
		let lastError = null;
		const attempted = new Set( excludeProviders );
		if ( this.nodeId ) {
			const key = `${this.nodeId}\n${this.gateway}`;
			if ( ! attempted.has( key ) ) {
				attempted.add( key );
				try {
					return await this.#fetchManifest( signal );
				} catch ( error ) {
					if ( signal?.aborted ) throw signal.reason || error;
					lastError = error;
					this.close();
					this.nodeId = '';
				}
			}
			this.nodeId = '';
		}
		let providers;
		try {
			providers = this.directory ? await this.#discoverDirectoryProviders( signal ) : await this.#discoverGatewayProviders( signal );
		} catch ( error ) {
			if ( signal?.aborted ) throw signal.reason || error;
			throw lastError || error;
		}
		for ( const provider of providers ) {
			throwIfAborted( signal );
			const nodeId = typeof provider === 'string' ? provider : provider.nodeId;
			const gateway = typeof provider === 'string' ? this.gateway : provider.gateway;
			const key = `${nodeId}\n${gateway}`;
			if ( attempted.has( key ) ) continue;
			attempted.add( key );
			this.nodeId = nodeId;
			this.gateway = gateway;
			try {
				return await this.#fetchManifest( signal );
			} catch ( error ) {
				if ( signal?.aborted ) throw signal.reason || error;
				lastError = error;
				this.close();
				this.nodeId = '';
			}
		}
		throw lastError || new Error( 'No available provider could serve this world' );
	}

	async updatePresence( pose, { signal } = {} ) {
		validatePresencePose( pose );
		const reply = await this.#request( { type: 'presence.update', pose }, { signal } );
		invariant( reply.type === 'presence' && reply.worldId === this.worldId && typeof reply.playerId === 'string' && Array.isArray( reply.players ), 'Invalid player presence response' );
		return reply;
	}

	async leavePresence( { signal } = {} ) {
		const reply = await this.#request( { type: 'presence.leave' }, { signal } );
		invariant( reply.type === 'presence' && reply.worldId === this.worldId, 'Invalid presence departure response' );
		return reply;
	}

	async #fetchManifest( signal ) {
		const reply = await this.#request( { type: 'manifest.get' }, { signal } );
		invariant( reply.type === 'manifest' && reply.document, 'World gateway returned no manifest' );
		await verifySignedDocument( reply.document, 'tidewater.world/1' );
		invariant( reply.document.payload.protocol === 'tidewater.world/1' && reply.document.payload.worldId === this.worldId, 'Manifest belongs to another world or protocol' );
		validateWorldRequirements( reply.document.payload );
		validateWorldExperience( reply.document.payload.experience );
		validateWorldSpawn( reply.document.payload.spawn );
		const entityIDs = validateWorldObjects( reply.document.payload.objects, reply.document.payload.assets );
		validateWorldPortals( reply.document.payload.portals, entityIDs, reply.document.payload.rules );
		validateWorldComponents( reply.document.payload.components, reply.document.payload.rules, entityIDs, reply.document.payload.assets, reply.document.payload.objects );
		validateWorldHosts( reply.document.payload.hosts );
		this.manifest = reply.document.payload;
		invariant( Number.isSafeInteger( this.manifest.authorityEpoch ) && this.manifest.authorityEpoch > 0, 'Manifest authority epoch is outside the supported range' );
		this.authorityLease = null;
		if ( reply.authorityLease ) {
			await verifySignedDocument( reply.authorityLease, 'tidewater.authority/2' );
			const lease = reply.authorityLease.payload;
			invariant( lease.worldId === this.worldId && lease.authorityPeerId === reply.authorityLease.signer && Number.isSafeInteger( lease.grantEpoch ) && lease.grantEpoch > 0 && Number.isSafeInteger( lease.epoch ) && lease.epoch === this.manifest.authorityEpoch + 1 && Number.isSafeInteger( lease.notBefore ) && lease.notBefore > 0 && Number.isSafeInteger( lease.expiresAt ) && lease.expiresAt > lease.notBefore && Date.now() / 1000 >= lease.notBefore && Date.now() / 1000 < lease.expiresAt, 'Authority lease is not valid for this world at the current time' );
			const grant = this.manifest.hosts?.find( ( entry ) => entry.peerId === lease.authorityPeerId && entry.scopes.includes( 'failover-authority' ) && entry.epoch === lease.grantEpoch && entry.failoverAfter === lease.notBefore && entry.expiresAt >= lease.expiresAt && lease.expiresAt <= entry.failoverAfter + entry.failoverSeconds );
			invariant( grant, 'Authority lease has no matching owner grant' );
			this.authorityLease = lease;
		}
		const hostGrant = this.manifest.hosts?.find( ( entry ) => entry.peerId === this.nodeId && entry.scopes?.includes( 'content-cache' ) && entry.expiresAt > Date.now() / 1000 );
		const failoverAuthority = this.authorityLease?.authorityPeerId === this.nodeId;
		invariant( this.manifest.ownerPeerId === this.nodeId || hostGrant || failoverAuthority, 'Selected node is not authorized to serve this world manifest' );
		return this.manifest;
	}

	async #discoverGatewayProviders( signal ) {
		const url = new URL( '/api/lookup', this.#httpBaseURL() );
		url.searchParams.set( 'worldId', this.worldId );
		const response = await fetch( url, { credentials: 'omit', cache: 'no-store', signal } );
		if ( ! response.ok ) throw new Error( `World lookup failed (${response.status})` );
		const result = await response.json();
		throwIfAborted( signal );
		invariant( result.worldId === this.worldId && Array.isArray( result.providers ) && result.providers.length > 0, 'No node currently advertises this world' );
		const peerIDs = [ ...new Set( result.providers.filter( ( peerId ) => typeof peerId === 'string' && /^[A-Za-z0-9]{20,256}$/.test( peerId ) ) ) ];
		invariant( peerIDs.length > 0, 'World lookup returned no valid provider identities' );
		return peerIDs;
	}

	async #discoverDirectoryProviders( signal ) {
		const url = new URL( `/v1/worlds/${encodeURIComponent( this.worldId )}`, this.directory );
		const response = await fetch( url, { credentials: 'omit', cache: 'no-store', signal } );
		if ( ! response.ok ) throw new Error( `World directory lookup failed (${response.status})` );
		const result = await response.json();
		throwIfAborted( signal );
		invariant( Array.isArray( result.providers ) && result.providers.length > 0, 'Directory has no provider for this world' );
		const providers = [];
		for ( const document of result.providers ) {
			throwIfAborted( signal );
			try { await verifySignedDocument( document, 'tidewater.node/1' ); }
			catch { continue; }
			const node = document.payload;
			const now = Date.now() / 1000;
			if ( node.protocol !== 'tidewater.node/1' || node.nodeId !== document.signer || ! node.worldIds?.includes( this.worldId ) || ! validSecureGateway( node.gateway ) || node.issuedAt > now + 300 || node.issuedAt < now - 86400 || node.expiresAt <= now || node.expiresAt > node.issuedAt + 172800 ) continue;
			providers.push( { nodeId: node.nodeId, gateway: node.gateway } );
		}
		if ( providers.length === 0 ) throw new Error( 'Directory returned no valid signed provider for this world' );
		return providers;
	}

	async getAsset( assetId, { signal } = {} ) {
		invariant( this.manifest, 'Load and verify the world manifest first' );
		if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
		const asset = this.manifest.assets.find( ( entry ) => entry.id === assetId );
		invariant( asset && /^sha256:[0-9a-f]{64}$/.test( asset.id ), 'Asset is not declared by this world' );
		invariant( Number.isSafeInteger( asset.bytes ) && asset.bytes >= 0 && asset.bytes <= MAX_ASSET_BYTES, 'Asset size is outside the supported range' );
		if ( this.assets.has( assetId ) ) return this.assets.get( assetId );
		let pending = this.assetDownloads.get( assetId );
		if ( ! pending || pending.controller.signal.aborted ) {
			pending = { controller: new AbortController(), waiters: 0, settled: false };
			pending.promise = this.#downloadAsset( assetId, asset, pending.controller.signal ).then( ( bytes ) => {
				this.assets.set( assetId, bytes );
				pending.settled = true;
				return bytes;
			}, ( error ) => { pending.settled = true; throw error; } ).finally( () => {
				if ( this.assetDownloads.get( assetId ) === pending ) this.assetDownloads.delete( assetId );
			} );
			this.assetDownloads.set( assetId, pending );
		}
		return waitForAssetDownload( pending, signal );
	}

	async #downloadAsset( assetId, asset, signal ) {
		let lastError;
		for ( ;; ) {
			throwIfAborted( signal );
			const providerKey = `${this.nodeId}\n${this.gateway}`;
			if ( this.unavailableProviders.has( providerKey ) ) {
				await this.#recoverProvider( signal );
				continue;
			}
			try {
				return await this.#downloadAssetFromCurrentProvider( assetId, asset, signal );
			} catch ( error ) {
				if ( signal?.aborted ) throw signal.reason || error;
				lastError = error;
				this.unavailableProviders.add( providerKey );
				try {
					await this.#recoverProvider( signal );
					const replacement = this.manifest?.assets.find( ( entry ) => entry.id === assetId );
					invariant( replacement && replacement.bytes === asset.bytes, 'Replacement provider does not advertise the same asset' );
				} catch ( recoveryError ) {
					if ( signal?.aborted ) throw signal.reason || recoveryError;
					throw lastError;
				}
			}
		}
	}

	async #recoverProvider( signal ) {
		if ( ! this.providerRecovery ) {
			const recovery = ( async () => {
				this.close();
				this.nodeId = '';
				return this.getManifest( { signal, excludeProviders: this.unavailableProviders } );
			} )();
			const wrapped = recovery.finally( () => {
				if ( this.providerRecovery === wrapped ) this.providerRecovery = null;
			} );
			this.providerRecovery = wrapped;
		}
		return this.providerRecovery;
	}

	async #downloadAssetFromCurrentProvider( assetId, asset, signal ) {
		const startedAt = performance.now();
		const parts = [];
		for ( let offset = 0; offset < asset.bytes; offset += this.chunkBytes ) {
			if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
			const length = Math.min( this.chunkBytes, asset.bytes - offset );
			const reply = await this.#request( { type: 'asset.get', assetId, offset, length }, { signal } );
			invariant( reply.type === 'asset.chunk' && reply.assetId === assetId && reply.offset === offset && reply.total === asset.bytes, `Invalid asset chunk response: ${JSON.stringify( { type: reply.type, assetId: reply.assetId, offset: reply.offset, total: reply.total, expectedAssetId: assetId, expectedOffset: offset, expectedTotal: asset.bytes } )}` );
			const bytes = decodeBase64( reply.chunk );
			invariant( bytes.byteLength === length, 'Asset chunk has an unexpected length' );
			parts.push( bytes );
		}
		const bytes = concatenate( parts, asset.bytes );
		const digest = hex( await crypto.subtle.digest( 'SHA-256', bytes ) );
		invariant( `sha256:${digest}` === assetId, 'Downloaded asset failed its content hash check' );
		const rate = bytes.byteLength * 1000 / Math.max( 1, performance.now() - startedAt );
		this.transferRateBytesPerSecond = this.transferRateBytesPerSecond === null ? rate : this.transferRateBytesPerSecond * 0.65 + rate * 0.35;
		return bytes;
	}

	async preload( { priorities = PRIORITY_ORDER, through = 'background', after = null, assetIDs, signal, concurrency } = {} ) {
		invariant( this.manifest, 'Load and verify the world manifest first' );
		const ranks = new Map( priorities.map( ( priority, index ) => [ priority, index ] ) );
		invariant( concurrency === undefined || Number.isInteger( concurrency ) && concurrency > 0 && concurrency <= 8, 'Invalid asset concurrency' );
		const endRank = ranks.get( through );
		const startRank = after === null ? 0 : ranks.get( after ) + 1;
		invariant( endRank !== undefined && startRank !== undefined && startRank <= endRank + 1, 'Invalid asset priority range' );
		const selected = assetIDs ? new Set( assetIDs ) : null;
		const queue = this.manifest.assets.map( ( asset, index ) => ( { asset, index, rank: ranks.get( asset.priority ) ?? 999 } ) )
			.filter( ( entry ) => entry.rank >= startRank && entry.rank <= endRank && ( selected === null || selected.has( entry.asset.id ) ) )
			.sort( ( a, b ) => a.rank - b.rank || a.index - b.index );
		const loaded = new Map();
		const requestedConcurrency = concurrency;
		for ( let start = 0; start < queue.length; ) {
			const rank = queue[ start ].rank;
			let end = start;
			while ( end < queue.length && queue[ end ].rank === rank ) end ++;
			const group = queue.slice( start, end );
			for ( let offset = 0; offset < group.length; ) {
				if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
				const limit = requestedConcurrency ?? assetConcurrencyForConnection( globalThis.navigator?.connection, this.transferRateBytesPerSecond );
				const batch = group.slice( offset, offset + limit );
				const results = await Promise.all( batch.map( ( { asset } ) => this.getAsset( asset.id, { signal } ) ) );
				for ( let i = 0; i < batch.length; i ++ ) loaded.set( batch[ i ].asset.id, results[ i ] );
				offset += batch.length;
			}
			start = end;
		}
		return loaded;
	}

	// Load portal-preview content first so it can appear beyond an open doorway while
	// the assets needed to enter the destination continue loading.
	async preparePortal( portal, { onPreview, signal } = {} ) {
		throwIfAborted( signal );
		invariant( portal && portal.enabled && portal.destinationWorldId, 'Portal has no active destination' );
		const destination = new WorldConnector( {
			worldId: portal.destinationWorldId,
			nodeId: portal.destinationPeerId || '',
			gateway: portal.destinationGateway || this.gateway,
			directory: this.directory,
			chunkBytes: this.chunkBytes,
		} );
		try {
			await destination.getManifest( { signal } );
			throwIfAborted( signal );
			const previewAssets = await destination.preload( { through: 'portal-preview', signal } );
			throwIfAborted( signal );
			const preview = onPreview ? await onPreview( { connector: destination, assets: previewAssets, signal } ) : null;
			throwIfAborted( signal );
			const assets = await destination.preload( { through: 'visible', signal } );
			throwIfAborted( signal );
			return { connector: destination, manifest: destination.manifest, assets, previewAssetIDs: new Set( previewAssets.keys() ), preview };
		} catch ( error ) {
			destination.close();
			throw error;
		}
	}

	async #connection( signal ) {
		throwIfAborted( signal );
		if ( this.webTransport?.state === 'connected' ) return { kind: 'webtransport', session: this.webTransport };
		if ( this.socket?.readyState === WebSocket.OPEN ) return { kind: 'websocket', socket: this.socket };
		if ( this.socketPromise ) return waitWithAbort( this.socketPromise, signal );
		const promise = ( async () => {
			const base = this.#httpBaseURL();
			if ( ! this.webTransportFailed && base.protocol === 'https:' && typeof globalThis.WebTransport === 'function' ) {
				try { return await this.#openWebTransport( base, signal ); }
				catch ( error ) {
					this.webTransport?.close();
					this.webTransport = null;
					if ( signal?.aborted ) throw signal.reason || error;
					this.webTransportFailed = true;
					console.info( 'WebTransport unavailable; using the WebSocket gateway.', error );
				}
			}
			return { kind: 'websocket', socket: await this.#openWebSocket( base, signal ) };
		} )();
		this.socketPromise = promise;
		try { return await promise; }
		finally { if ( this.socketPromise === promise ) this.socketPromise = null; }
	}

	async #openWebTransport( base, signal ) {
		const url = new URL( base );
		url.pathname = '/gateway-webtransport';
		const session = this.webTransport = new globalThis.WebTransport( url.href );
		session.closed.then( () => { if ( this.webTransport === session ) this.webTransport = null; } ).catch( () => { if ( this.webTransport === session ) this.webTransport = null; } );
		try {
			await withTimeout( session.ready, 8000, 'WebTransport connection timed out', signal );
			const stream = await waitWithAbort( session.createBidirectionalStream(), signal );
			await writeJSONStream( stream.writable, { type: 'connect', worldId: this.worldId, targetPeerId: this.nodeId }, signal );
			const response = await readJSONStream( stream.readable, signal );
			throwIfAborted( signal );
			invariant( response.type === 'connected' && response.worldId === this.worldId, response.error || 'WebTransport world connection failed' );
			return { kind: 'webtransport', session };
		} catch ( error ) {
			session.close();
			if ( this.webTransport === session ) this.webTransport = null;
			throw error;
		}
	}

	#openWebSocket( base, signal ) {
		return new Promise( ( resolve, reject ) => {
			if ( signal?.aborted ) { reject( signal.reason || new DOMException( 'Aborted', 'AbortError' ) ); return; }
			const url = new URL( base );
			url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
			url.pathname = '/gateway';
			const socket = this.socket = new WebSocket( url );
			let connected = false;
			let settled = false;
			const cleanup = () => { clearTimeout( timeout ); signal?.removeEventListener( 'abort', abort ); };
			const failConnect = ( error ) => {
				if ( settled ) return;
				settled = true;
				cleanup();
				if ( this.socket === socket ) this.socket = null;
				socket.close();
				reject( error );
			};
			const abort = () => failConnect( signal.reason || new DOMException( 'Aborted', 'AbortError' ) );
			const timeout = setTimeout( () => failConnect( new Error( 'World gateway connection timed out' ) ), 20000 );
			const failPending = ( error ) => {
				for ( const pending of this.pending.values() ) { clearTimeout( pending.timeout ); pending.reject( error ); }
				this.pending.clear();
			};
			signal?.addEventListener( 'abort', abort, { once: true } );
			socket.addEventListener( 'open', () => {
				try { socket.send( JSON.stringify( { type: 'connect', worldId: this.worldId, targetPeerId: this.nodeId } ) ); }
				catch ( error ) { failConnect( error ); }
			}, { once: true } );
			socket.addEventListener( 'message', ( event ) => {
				let response;
				try { response = JSON.parse( event.data ); } catch { failConnect( new Error( 'Invalid response from world gateway' ) ); return; }
				if ( ! connected ) {
					if ( response.type !== 'connected' || response.worldId !== this.worldId ) { failConnect( new Error( response.error || 'World connection failed' ) ); return; }
					connected = true;
					settled = true;
					cleanup();
					resolve( socket );
					return;
				}
				const pending = this.pending.get( response.requestId );
				if ( ! pending ) return;
				this.pending.delete( response.requestId );
				clearTimeout( pending.timeout );
				if ( response.type === 'error' ) pending.reject( new Error( response.error || response.code || 'World request failed' ) );
				else pending.resolve( response );
			} );
			socket.addEventListener( 'error', () => {
				const error = new Error( 'World gateway connection failed' );
				failConnect( error );
				failPending( error );
			}, { once: true } );
			socket.addEventListener( 'close', () => {
				cleanup();
				this.socket = null;
				const error = new Error( connected ? 'World gateway connection closed' : 'World gateway closed before connecting' );
				if ( ! connected ) failConnect( error );
				failPending( error );
			}, { once: true } );
		} );
	}

	#httpBaseURL() {
		const url = new URL( this.gateway, globalThis.location?.href );
		if ( url.protocol === 'wss:' ) url.protocol = 'https:';
		else if ( url.protocol === 'ws:' ) url.protocol = 'http:';
		invariant( url.protocol === 'https:' || url.protocol === 'http:', 'Gateway must use HTTP(S) or WebSocket(S)' );
		if ( globalThis.location?.protocol === 'https:' && url.protocol !== 'https:' ) throw new Error( 'Secure pages require an HTTPS/WSS world gateway' );
		url.pathname = '/';
		url.search = '';
		url.hash = '';
		return url;
	}

	async #request( message, { signal } = {} ) {
		if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
		const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
		let connection = await this.#connection( signal );
		throwIfAborted( signal );
		if ( connection.kind === 'webtransport' ) {
			try { return await requestWebTransport( connection.session, { ...message, requestId }, signal ); }
			catch ( error ) {
				if ( signal?.aborted ) throw signal.reason || error;
				if ( error.gatewayResponse ) throw error;
				this.webTransportFailed = true;
				connection.session.close();
				if ( this.webTransport === connection.session ) this.webTransport = null;
				console.info( 'WebTransport request failed; retrying through the WebSocket gateway.', error );
				connection = await this.#connection( signal );
				throwIfAborted( signal );
			}
		}
		const socket = connection.socket;
		return new Promise( ( resolve, reject ) => {
			const cleanup = () => { clearTimeout( timeout ); signal?.removeEventListener( 'abort', abort ); };
			const timeout = setTimeout( () => { this.pending.delete( requestId ); cleanup(); reject( new Error( 'World request timed out' ) ); }, 30000 );
			const abort = () => { clearTimeout( timeout ); this.pending.delete( requestId ); cleanup(); reject( signal.reason || new DOMException( 'Aborted', 'AbortError' ) ); };
			this.pending.set( requestId, { resolve: ( value ) => { cleanup(); resolve( value ); }, reject: ( error ) => { cleanup(); reject( error ); }, timeout } );
			signal?.addEventListener( 'abort', abort, { once: true } );
			try { socket.send( JSON.stringify( { ...message, requestId } ) ); }
			catch ( error ) { clearTimeout( timeout ); this.pending.delete( requestId ); reject( error ); }
		} );
	}

	close() {
		this.socket?.close();
		this.webTransport?.close();
		this.socket = null;
		this.webTransport = null;
		this.webTransportFailed = false;
	}
}

export function validateWorldObjects( objects, assets ) {
	invariant( Array.isArray( objects ) && objects.length <= 10000, 'World manifest has an invalid object list' );
	const ids = new Set();
	for ( const object of objects ) {
		invariant( object && typeof object.id === 'string' && /^tw-object:[\w.-]{1,128}$/.test( object.id ) && ! ids.has( object.id ), 'World manifest has an invalid or duplicate object ID' );
		invariant( object.replacesObjectId === undefined || typeof object.replacesObjectId === 'string' && /^tw-object:[\w.-]{1,128}$/.test( object.replacesObjectId ) && object.replacesObjectId !== object.id, `World object ${object.id} has an invalid replacement reference` );
		ids.add( object.id );
		invariant( object?.priority === undefined || [ 'portal-preview', 'visible', 'nearby', 'background' ].includes( object.priority ), `World object ${object.id || '(unknown)'} has an invalid streaming priority` );
		if ( object?.streamingBounds !== undefined ) {
			const bounds = object.streamingBounds;
			invariant( bounds && validVector( bounds.center ) && bounds.center.every( ( value ) => Math.abs( value ) <= 10000 ) && Number.isFinite( bounds.radius ) && bounds.radius > 0 && bounds.radius <= 10000, `World object ${object.id || '(unknown)'} has invalid streaming bounds` );
		}
		if ( object?.transform?.rotation !== undefined ) {
			const rotation = object.transform.rotation;
			invariant( Array.isArray( rotation ) && rotation.length === 4 && rotation.every( Number.isFinite ) && Math.abs( Math.hypot( ...rotation ) - 1 ) <= 1e-4 && object.collision?.enabled !== true, `World object ${object.id || '(unknown)'} has an invalid quaternion transform` );
		}
		validateObjectLODs( object, assets );
		const collision = object?.collision;
		if ( collision?.enabled !== true ) continue;
		const box = collision.shape === 'box' && validVector( collision.center ) && validVector( collision.halfExtents ) && collision.halfExtents.every( ( value ) => value > 0 && value <= 1000 ) && typeof collision.walkable === 'boolean' && typeof collision.solid === 'boolean';
		const heightfield = collision.shape === 'heightfield' && Number.isInteger( collision.columns ) && Number.isInteger( collision.rows ) && collision.columns >= 2 && collision.rows >= 2 && collision.columns <= 4097 && collision.rows <= 4097 && collision.columns * collision.rows <= 4194304 && collision.walkable === true && collision.solid === true;
		const compound = collision.shape === 'compound' && Array.isArray( collision.boxes ) && collision.boxes.length > 0 && collision.boxes.length <= 2048 && collision.boxes.every( ( item ) => item && validVector( item.center ) && item.center.every( ( value ) => Math.abs( value ) <= 1e6 ) && validVector( item.halfExtents ) && item.halfExtents.every( ( value ) => value > 0 && value <= 1000 ) && Number.isFinite( item.yaw ) && Math.abs( item.yaw ) <= 360 && typeof item.walkable === 'boolean' && typeof item.solid === 'boolean' );
		invariant( box || heightfield || compound, `World object ${object.id || '(unknown)'} has invalid collision bounds` );
	}
	const objectByID = new Map( objects.map( ( object ) => [ object.id, object ] ) );
	const replacedIDs = new Set();
	for ( const object of objects ) if ( object.replacesObjectId ) {
		const replaced = objectByID.get( object.replacesObjectId );
		invariant( replaced && replaced.priority === 'portal-preview' && object.priority !== 'portal-preview' && replaced.collision?.enabled !== true && ! replacedIDs.has( replaced.id ), `World object ${object.id} has an invalid preview replacement` );
		replacedIDs.add( replaced.id );
	}
	return ids;
}

export function validateWorldPortals( portals = [], ids = new Set(), rules = {} ) {
	invariant( Array.isArray( portals ) && portals.length <= 1024, 'World manifest has an invalid portal list' );
	for ( const portal of portals ) {
		invariant( portal && typeof portal.id === 'string' && /^tw-portal:[\w.-]{1,128}$/.test( portal.id ) && ! ids.has( portal.id ), 'World manifest has an invalid or duplicate portal ID' );
		invariant( /^tw-world:[\w.-]{1,128}$/.test( portal.destinationWorldId || '' ) && ( portal.destinationPeerId === undefined || typeof portal.destinationPeerId === 'string' && /^[A-Za-z0-9]{20,256}$/.test( portal.destinationPeerId ) ), `Portal ${portal.id} has an invalid destination` );
		invariant( portal.destinationGateway === undefined || validWorldGateway( portal.destinationGateway ), `Portal ${portal.id} has an invalid destination gateway` );
		invariant( portal.visual === undefined || [ 'timber', 'stone', 'metal' ].includes( portal.visual ), `Portal ${portal.id} has an unsupported visual style` );
		for ( const transform of [ portal.entry, portal.exit ] ) {
			invariant( transform && validVector( transform.position ) && transform.position.every( ( value ) => Math.abs( value ) <= 1e6 ) && Number.isFinite( transform.yaw ) && Math.abs( transform.yaw ) <= 360 && transform.rotation === undefined, `Portal ${portal.id} has an invalid transform` );
		}
		invariant( typeof portal.openView === 'boolean' && typeof portal.enabled === 'boolean', `Portal ${portal.id} has invalid flags` );
		if ( portal.back !== undefined ) {
			invariant( rules.requiredFeatures?.includes( 'tidewater.portal-two-sided/1' ), 'Portal back requires tidewater.portal-two-sided/1' );
			validatePortalBack( portal.back, validWorldGateway );
		}
		ids.add( portal.id );
	}
	return ids;
}

export function validateWorldComponents( components = [], rules, ids = new Set(), assets = [], objects = [] ) {
	invariant( Array.isArray( components ) && components.length <= 128, 'World manifest has an invalid component list' );
	const assetRefs = new Map( assets.map( ( asset ) => [ asset.id, asset ] ) );
	const objectRefs = new Map( objects.map( ( object ) => [ object.id, object ] ) );
	let islandOceanCount = 0;
	let waterBodyCount = 0;
	let audioComponentCount = 0;
	let boatCount = 0;
	let boatObject = null;
	const waterBodies = [];
	for ( const component of components ) {
		invariant( component && typeof component.id === 'string' && /^tw-component:[\w.-]{1,128}$/.test( component.id ) && ! ids.has( component.id ), 'World manifest has an invalid or duplicate component ID' );
		const vegetation = component.type === 'tidewater.procedural-island-vegetation/1' && component.seed === 7 && Object.keys( component ).every( ( key ) => [ 'id', 'type', 'seed', 'priority', 'placementAssetId', 'streamingBounds' ].includes( key ) );
		const staticVegetation = component.type === 'tidewater.static-vegetation/1' && Object.keys( component ).every( ( key ) => [ 'id', 'type', 'priority', 'placementAssetId', 'streamingBounds' ].includes( key ) );
		const staticReef = component.type === 'tidewater.static-reef/1' && component.streamingBounds !== undefined && Object.keys( component ).every( ( key ) => [ 'id', 'type', 'priority', 'placementAssetId', 'streamingBounds' ].includes( key ) );
		const islandOcean = component.type === 'tidewater.island-ocean/1' && Object.keys( component ).every( ( key ) => [ 'id', 'type', 'priority', 'streamingBounds' ].includes( key ) );
		const waterBody = component.type === 'tidewater.water-body/1' && ( component.profile === undefined || [ 'deep-ocean', 'calm-lagoon', 'storm' ].includes( component.profile ) ) && Array.isArray( component.center ) && component.center.length === 2 && Number.isFinite( component.extent ) && component.extent >= 8 && component.extent <= 100000 && component.center.every( ( n ) => Number.isFinite( n ) && Math.abs( n ) + component.extent <= 1e6 ) && Object.keys( component ).every( ( key ) => [ 'id', 'type', 'priority', 'center', 'extent', 'profile', 'streamingBounds' ].includes( key ) );
		const ambientAudio = component.type === 'tidewater.ambient-audio/1' && Object.keys( component ).every( ( key ) => [ 'id', 'type', 'priority', 'streamingBounds', 'beds' ].includes( key ) ) && Array.isArray( component.beds ) && component.beds.length > 0 && component.beds.length <= 16 && component.beds.every( ( bed ) => validAudioBed( bed, assetRefs, component.priority || 'portal-preview' ) );
		const boat = component.type === 'tidewater.downeast-boat/1' && typeof component.objectId === 'string' && /^tw-object:[\w.-]{1,128}$/.test( component.objectId ) && Object.keys( component ).every( ( key ) => [ 'id', 'type', 'priority', 'objectId' ].includes( key ) );
		const proceduralTerrain = component.type === 'tidewater.procedural-island-terrain/1' && component.profile === 'example-island-v1' && typeof component.objectId === 'string' && objectRefs.get( component.objectId )?.kind === 'asset-instance' && Object.keys( component ).every( ( key ) => [ 'id', 'type', 'profile', 'priority', 'objectId', 'streamingBounds' ].includes( key ) );
		const terrainSurface = component.type === 'tidewater.terrain-surface/1' && component.profile === 'example-island-v1' && typeof component.objectId === 'string' && objectRefs.get( component.objectId )?.kind === 'asset-instance' && /^sha256:[0-9a-f]{64}$/.test( component.dataAssetId || '' ) && Object.keys( component ).every( ( key ) => [ 'id', 'type', 'profile', 'priority', 'objectId', 'dataAssetId', 'streamingBounds' ].includes( key ) );
		const villageMaterials = component.type === 'tidewater.village-materials/2' && component.profile === 'original-tidewater-village-v1' && /^sha256:[0-9a-f]{64}$/.test( component.dataAssetId || '' ) && typeof component.objectId === 'string' && objectRefs.get( component.objectId )?.kind === 'asset-instance' && Object.keys( component ).every( ( key ) => [ 'id', 'type', 'profile', 'priority', 'objectId', 'dataAssetId', 'streamingBounds' ].includes( key ) );
		invariant( ( vegetation || staticVegetation || staticReef || islandOcean || proceduralTerrain || terrainSurface || villageMaterials || waterBody || ambientAudio || boat ) && ( component.priority === undefined || [ 'portal-preview', 'visible', 'nearby', 'background' ].includes( component.priority ) ), `Unsupported or invalid world component ${component.id}` );
		if ( islandOcean ) invariant( ++ islandOceanCount === 1, 'World manifest may declare only one island ocean component' );
		if ( waterBody ) invariant( ++ waterBodyCount <= 4 && rules.seaLevel !== undefined && islandOceanCount === 0, 'Portable water requires seaLevel, allows at most four bodies, and cannot be combined with island-ocean' );
		if ( islandOcean ) invariant( waterBodyCount === 0, 'A world cannot combine portable water and island-ocean components' );
		if ( ambientAudio ) invariant( ++ audioComponentCount <= 16, 'World manifest may declare at most 16 ambient audio components' );
		if ( boat ) {
			boatCount ++;
			boatObject = objectRefs.get( component.objectId );
			const berthAsset = assetRefs.get( boatObject?.assetId );
			invariant( boatCount === 1 && component.priority === 'portal-preview' && boatObject?.kind === 'asset-instance' && boatObject.priority === 'portal-preview' && boatObject.collision?.enabled === false && boatObject.collision?.shape === 'none' && boatObject.transform?.rotation === undefined && boatObject.scale?.length === 3 && boatObject.scale.every( ( value ) => value === 1 ) && berthAsset?.kind === 'glb' && berthAsset.priority === 'portal-preview', `Boat component ${component.id} has an invalid berth preview object` );
		}
		if ( waterBody ) {
			invariant( ! waterBodies.some( ( other ) => Math.abs( component.center[ 0 ] - other.center[ 0 ] ) < component.extent + other.extent && Math.abs( component.center[ 1 ] - other.center[ 1 ] ) < component.extent + other.extent ), 'Portable water body bounds cannot overlap' );
			waterBodies.push( component );
		}
		invariant( rules.requiredFeatures?.includes( component.type ), `World component ${component.type} is missing from requiredFeatures` );
		if ( component.streamingBounds !== undefined ) invariant( validComponentStreamingBounds( component.streamingBounds ), `World component ${component.id} has invalid streaming bounds` );
		if ( component.placementAssetId !== undefined ) {
			const expectedKind = staticReef ? 'reef-placement/1' : 'vegetation-placement/1';
			invariant( /^sha256:[0-9a-f]{64}$/.test( component.placementAssetId ) && assetRefs.get( component.placementAssetId )?.kind === expectedKind && assetRefs.get( component.placementAssetId )?.priority === ( component.priority || 'portal-preview' ), `World component ${component.id} has an invalid placement asset reference` );
		}
		if ( terrainSurface || villageMaterials ) {
			const asset = assetRefs.get( component.dataAssetId );
			const kind = terrainSurface ? 'terrain-surface/1' : 'village-materials/1';
			const limit = terrainSurface ? 128 * 1024 * 1024 : 64 * 1024 * 1024;
			invariant( asset?.kind === kind && asset.priority === ( component.priority || 'portal-preview' ) && asset.bytes > 0 && asset.bytes <= limit, `World component ${component.id} has an invalid ${kind} asset` );
		}
		if ( component.type === 'tidewater.static-vegetation/1' ) invariant( typeof component.placementAssetId === 'string', `Static vegetation component ${component.id} requires placement data` );
		if ( staticReef ) invariant( typeof component.placementAssetId === 'string', `Static reef component ${component.id} requires placement data` );
		ids.add( component.id );
	}
	if ( boatCount ) {
		invariant( rules.seaLevel !== undefined && ( islandOceanCount === 1 || waterBodyCount > 0 ), 'A Downeast boat requires seaLevel and a declared water renderer' );
		if ( waterBodyCount ) invariant( waterBodies.some( ( water ) => Math.abs( boatObject.transform.position[ 0 ] - water.center[ 0 ] ) <= water.extent && Math.abs( boatObject.transform.position[ 2 ] - water.center[ 1 ] ) <= water.extent ), 'A Downeast boat berth must be inside a declared water body' );
	}
	return ids;
}

function validAudioBed( bed, assetRefs, priority ) {
	if ( ! bed || typeof bed !== 'object' || Array.isArray( bed ) || Object.keys( bed ).some( ( key ) => ! [ 'assetId', 'gain', 'condition', 'position', 'refDistance', 'rolloff' ].includes( key ) ) ) return false;
	const asset = assetRefs.get( bed.assetId );
	return typeof bed.assetId === 'string' && /^sha256:[0-9a-f]{64}$/.test( bed.assetId ) && asset?.kind === 'audio/ogg' && asset.bytes > 0 && asset.bytes <= 16 * 1024 * 1024 && asset.priority === priority && Number.isFinite( bed.gain ) && bed.gain >= 0 && bed.gain <= 1 && ( bed.condition === undefined || [ 'always', 'day', 'night', 'dawn', 'underwater' ].includes( bed.condition ) ) && ( bed.position === undefined || validVector( bed.position ) && bed.position.every( ( value ) => Math.abs( value ) <= 100000 ) ) && ( bed.refDistance === undefined || Number.isFinite( bed.refDistance ) && bed.refDistance >= 0.5 && bed.refDistance <= 1000 ) && ( bed.rolloff === undefined || Number.isFinite( bed.rolloff ) && bed.rolloff >= 0 && bed.rolloff <= 10 );
}

function validComponentStreamingBounds( bounds ) {
	return bounds && typeof bounds === 'object' && ! Array.isArray( bounds ) && Object.keys( bounds ).every( ( key ) => [ 'center', 'radius' ].includes( key ) ) && validVector( bounds.center ) && bounds.center.every( ( value ) => Math.abs( value ) <= 10000 ) && Number.isFinite( bounds.radius ) && bounds.radius > 0 && bounds.radius <= 10000;
}

function validWorldGateway( value ) {
	if ( typeof value !== 'string' ) return false;
	try {
		const gateway = new URL( value );
		return [ 'https:', 'wss:' ].includes( gateway.protocol ) && ! gateway.username && ! gateway.password && ( gateway.pathname === '' || gateway.pathname === '/' ) && ! gateway.search && ! gateway.hash;
	} catch {
		return false;
	}
}

export function validateWorldHosts( hosts = [] ) {
	invariant( Array.isArray( hosts ) && hosts.length <= 256, 'World manifest has an invalid host grant list' );
	const peerIDs = new Set();
	const failoverWindows = [];
	for ( const grant of hosts ) {
		invariant( grant && typeof grant.peerId === 'string' && /^[A-Za-z0-9]{20,256}$/.test( grant.peerId ) && ! peerIDs.has( grant.peerId ) && Number.isSafeInteger( grant.epoch ) && grant.epoch > 0 && Number.isSafeInteger( grant.expiresAt ) && grant.expiresAt > 0 && Array.isArray( grant.scopes ) && grant.scopes.length > 0 && grant.scopes.length <= 2 && new Set( grant.scopes ).size === grant.scopes.length && grant.scopes.every( ( scope ) => scope === 'content-cache' || scope === 'failover-authority' ), 'World manifest contains an invalid host grant' );
		const failover = grant.scopes.includes( 'failover-authority' );
		invariant( failover ? Number.isSafeInteger( grant.failoverAfter ) && grant.failoverAfter > 0 && Number.isSafeInteger( grant.failoverSeconds ) && grant.failoverSeconds >= 1 && grant.failoverSeconds <= 3600 && grant.failoverAfter <= grant.expiresAt - grant.failoverSeconds : grant.failoverAfter === undefined && grant.failoverSeconds === undefined, 'World manifest contains an invalid host grant failover window' );
		if ( failover ) failoverWindows.push( [ grant.failoverAfter, grant.failoverAfter + grant.failoverSeconds ] );
		peerIDs.add( grant.peerId );
	}
	for ( let i = 0; i < failoverWindows.length; i ++ ) for ( let j = i + 1; j < failoverWindows.length; j ++ ) invariant( failoverWindows[ i ][ 0 ] >= failoverWindows[ j ][ 1 ] || failoverWindows[ j ][ 0 ] >= failoverWindows[ i ][ 1 ], 'World manifest contains overlapping host grant failover windows' );
}

function validVector( value ) {
	return Array.isArray( value ) && value.length === 3 && value.every( ( item ) => Number.isFinite( item ) && Math.abs( item ) <= 1e6 );
}

function validSecureOrigin( value ) {
	try {
		const url = new URL( value );
		return url.protocol === 'https:' && ! url.username && ! url.password && ( url.pathname === '' || url.pathname === '/' ) && ! url.search && ! url.hash;
	} catch {
		return false;
	}
}

function validSecureGateway( value ) {
	try {
		const url = new URL( value );
		return [ 'https:', 'wss:' ].includes( url.protocol ) && ! url.username && ! url.password && ( url.pathname === '' || url.pathname === '/' ) && ! url.search && ! url.hash;
	} catch {
		return false;
	}
}

function waitForAssetDownload( pending, signal ) {
	if ( signal?.aborted ) return Promise.reject( signal.reason || new DOMException( 'Aborted', 'AbortError' ) );
	pending.waiters ++;
	return new Promise( ( resolve, reject ) => {
		let finished = false;
		const finish = ( callback, value ) => {
			if ( finished ) return;
			finished = true;
			signal?.removeEventListener( 'abort', abort );
			pending.waiters --;
			if ( pending.waiters === 0 && ! pending.settled ) pending.controller.abort( new DOMException( 'No asset consumers remain', 'AbortError' ) );
			callback( value );
		};
		const abort = () => finish( reject, signal.reason || new DOMException( 'Aborted', 'AbortError' ) );
		signal?.addEventListener( 'abort', abort, { once: true } );
		pending.promise.then( ( bytes ) => finish( resolve, bytes ), ( error ) => finish( reject, error ) );
	} );
}

async function requestWebTransport( session, message, signal ) {
	if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
	const stream = await session.createBidirectionalStream();
	await writeJSONStream( stream.writable, message, signal );
	const response = await withTimeout( readJSONStream( stream.readable, signal ), 30000, 'World request timed out', signal );
	if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
	if ( response.type === 'error' ) {
		const error = new Error( response.error || response.code || 'World request failed' );
		error.gatewayResponse = true;
		throw error;
	}
	invariant( response.requestId === message.requestId, 'World response does not match its request' );
	return response;
}

async function writeJSONStream( writable, value, signal ) {
	if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
	const writer = writable.getWriter();
	const abort = () => { writer.abort( signal.reason ).catch( () => {} ); };
	signal?.addEventListener( 'abort', abort, { once: true } );
	try {
		await writer.write( new TextEncoder().encode( JSON.stringify( value ) ) );
		if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
		await writer.close();
	} finally {
		signal?.removeEventListener( 'abort', abort );
		writer.releaseLock();
	}
}

async function readJSONStream( readable, signal ) {
	if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
	const reader = readable.getReader();
	const chunks = [];
	let length = 0;
	const abort = () => { reader.cancel( signal.reason ).catch( () => {} ); };
	signal?.addEventListener( 'abort', abort, { once: true } );
	try {
		if ( signal?.aborted ) abort();
		for (;;) {
			const { value, done } = await reader.read();
			if ( done ) break;
			length += value.byteLength;
			invariant( length <= 384 * 1024, 'World gateway response exceeds the size limit' );
			chunks.push( value );
		}
		if ( signal?.aborted ) throw signal.reason || new DOMException( 'Aborted', 'AbortError' );
	} finally {
		signal?.removeEventListener( 'abort', abort );
		reader.releaseLock();
	}
	const bytes = new Uint8Array( length );
	let offset = 0;
	for ( const chunk of chunks ) { bytes.set( chunk, offset ); offset += chunk.byteLength; }
	return JSON.parse( new TextDecoder().decode( bytes ) );
}

function withTimeout( promise, milliseconds, message, signal ) {
	if ( signal?.aborted ) return Promise.reject( signal.reason || new DOMException( 'Aborted', 'AbortError' ) );
	return new Promise( ( resolve, reject ) => {
		const cleanup = () => { clearTimeout( timeout ); signal?.removeEventListener( 'abort', abort ); };
		const timeout = setTimeout( () => { cleanup(); reject( new Error( message ) ); }, milliseconds );
		const abort = () => { cleanup(); reject( signal.reason || new DOMException( 'Aborted', 'AbortError' ) ); };
		signal?.addEventListener( 'abort', abort, { once: true } );
		Promise.resolve( promise ).then( ( value ) => { cleanup(); resolve( value ); }, ( error ) => { cleanup(); reject( error ); } );
	} );
}

function waitWithAbort( promise, signal ) {
	if ( ! signal ) return promise;
	if ( signal.aborted ) return Promise.reject( signal.reason || new DOMException( 'Aborted', 'AbortError' ) );
	return new Promise( ( resolve, reject ) => {
		const cleanup = () => signal.removeEventListener( 'abort', abort );
		const abort = () => { cleanup(); reject( signal.reason || new DOMException( 'Aborted', 'AbortError' ) ); };
		signal.addEventListener( 'abort', abort, { once: true } );
		Promise.resolve( promise ).then( ( value ) => { cleanup(); resolve( value ); }, ( error ) => { cleanup(); reject( error ); } );
	} );
}

async function verifySignedDocument( document, protocol ) {
	invariant( document?.protocol === protocol && typeof document.signer === 'string' && typeof document.publicKey === 'string' && typeof document.signature === 'string' && document.payload, 'Invalid signed world document' );
	const protobufKey = decodeBase64( document.publicKey );
	invariant( protobufKey.length === 36 && protobufKey[ 0 ] === 8 && protobufKey[ 1 ] === 1 && protobufKey[ 2 ] === 18 && protobufKey[ 3 ] === 32, 'Unsupported world signing key' );
	invariant( peerIdFromEd25519( protobufKey ) === document.signer, 'World signer does not match its public key' );
	const unsigned = { protocol: document.protocol, signer: document.signer, publicKey: document.publicKey, payload: document.payload };
	const key = await crypto.subtle.importKey( 'raw', protobufKey.subarray( 4 ), { name: 'Ed25519' }, false, [ 'verify' ] );
	const valid = await crypto.subtle.verify( 'Ed25519', key, decodeBase64( document.signature ), new TextEncoder().encode( canonicalJSON( unsigned ) ) );
	invariant( valid, 'World signature verification failed' );
}

function canonicalJSON( value ) {
	if ( Array.isArray( value ) ) return `[${value.map( canonicalJSON ).join( ',' )}]`;
	if ( value && typeof value === 'object' ) return `{${Object.keys( value ).sort().map( ( key ) => `${canonicalString( key )}:${canonicalJSON( value[ key ] )}` ).join( ',' )}}`;
	return typeof value === 'string' ? canonicalString( value ) : JSON.stringify( value );
}

// encoding/json escapes HTML-sensitive characters and U+2028/U+2029 even in canonical payloads.
function canonicalString( value ) { return JSON.stringify( value ).replace( /[<>&\u2028\u2029]/g, ( char ) => `\\u${char.charCodeAt( 0 ).toString( 16 ).padStart( 4, '0' )}` ); }

function peerIdFromEd25519( protobufKey ) {
	const multihash = new Uint8Array( 2 + protobufKey.length );
	multihash[ 0 ] = 0; // identity multihash
	multihash[ 1 ] = protobufKey.length;
	multihash.set( protobufKey, 2 );
	return base58( multihash );
}

function base58( bytes ) {
	const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
	let value = 0n;
	for ( const byte of bytes ) value = value * 256n + BigInt( byte );
	let encoded = '';
	while ( value > 0n ) { const remainder = Number( value % 58n ); encoded = alphabet[ remainder ] + encoded; value /= 58n; }
	for ( const byte of bytes ) { if ( byte !== 0 ) break; encoded = `1${encoded}`; }
	return encoded;
}

function decodeBase64( value ) {
	const normalized = value.replace( /-/g, '+' ).replace( /_/g, '/' );
	const binary = atob( normalized + '='.repeat( ( 4 - normalized.length % 4 ) % 4 ) );
	return Uint8Array.from( binary, ( char ) => char.charCodeAt( 0 ) );
}

function concatenate( parts, length ) {
	const bytes = new Uint8Array( length );
	let offset = 0;
	for ( const part of parts ) { bytes.set( part, offset ); offset += part.length; }
	return bytes;
}

function hex( bytes ) { return Array.from( new Uint8Array( bytes ), ( byte ) => byte.toString( 16 ).padStart( 2, '0' ) ).join( '' ); }
