import { validatePortalBack } from './PortalSideContract.js';
import { validateObjectLODs, validateWorldEntryPoints, validateWorldSpawn, worldComponentRuntimeRecord } from './WorldSource.js';
import { validatePresencePose } from './PlayerPresence.js';
import { validateWorldRequirements } from './WorldRules.js';
import { validateWorldExperience } from './WorldExperience.js';
import { verifySignedDocument } from './SignedDocument.js';
import { isWorldID, WORLD_PROTOCOL_NAMESPACE } from './WorldIdentity.js';

export { verifySignedDocument } from './SignedDocument.js';

const ASSET_CHUNK_BYTES = 128 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const PRIORITY_ORDER = Object.freeze( [ 'portal-preview', 'visible', 'nearby', 'background' ] );
export const DEFAULT_ZEROTIER_NETWORK_ID = 'e3918db4832a3056';

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
	const configuredLocalWorld = globalThis.ELSEMESH_CONFIG?.localWorld;
	const localProvider = params.get( 'localProvider' ) || configuredLocalWorld?.provider;
	const localMap = params.get( 'localMap' ) || configuredLocalWorld?.map;
	if ( localProvider || localMap ) {
		invariant( localProvider && localMap, 'A local provider URL and map name must be supplied together' );
		invariant( ! params.has( 'worldId' ) && ! params.has( 'ztNodeId' ) && ! params.has( 'nodeId' ) && ! params.has( 'gateway' ), 'Local preview cannot be combined with a remote world invite' );
		const provider = new URL( localProvider );
		const loopback = ( hostname ) => [ 'localhost', '127.0.0.1', '[::1]' ].includes( hostname );
		invariant( [ 'http:', 'https:' ].includes( provider.protocol ) && loopback( provider.hostname ) && ! provider.username && ! provider.password && ( provider.pathname === '' || provider.pathname === '/' ) && ! provider.search && ! provider.hash, 'Local region provider must be a loopback HTTP(S) origin' );
		const page = new URL( location.href );
		invariant( [ 'http:', 'https:' ].includes( page.protocol ) && loopback( page.hostname ), 'Local region preview is available only from a loopback browser page' );
		invariant( localMap.length <= 256 && /^[\w .()/-]+$/.test( localMap ), 'Invalid local map selector' );
		return { localProvider: provider.origin, localMap, environment: configuredLocalWorld?.environment || null };
	}
	const worldId = params.get( 'worldId' );
	const zeroTierNodeId = params.get( 'ztNodeId' ) || '';
	if ( ! worldId && ! zeroTierNodeId ) return null;
	const nodeIds = params.getAll( 'nodeId' );
	const gateways = params.getAll( 'gateway' );
	invariant( nodeIds.length === gateways.length || ( nodeIds.length === 0 && gateways.length === 1 ), 'Invite provider IDs and gateways must be paired' );
	return {
		worldId: worldId || '',
		zeroTierNodeId,
		zeroTierNetworkId: DEFAULT_ZEROTIER_NETWORK_ID,
		nodeId: nodeIds[ 0 ] || '',
		gateway: gateways[ 0 ] || location.origin,
		providers: nodeIds.map( ( nodeId, index ) => ( { nodeId, gateway: gateways[ index ] } ) ),
		directory: params.get( 'directory' ) || globalThis.ELSEMESH_CONFIG?.worldResolver || '',
	};
}

export function createWorldInviteURL( { pageURL = globalThis.location?.href, worldId, nodeId, gateway, providers = [], directory = '' } = {} ) {
		invariant( isWorldID( worldId ), 'A valid worldId is required for an invite' );
	const url = new URL( pageURL );
	invariant( url.protocol === 'https:' || url.protocol === 'http:', 'Invite page URL must use HTTP(S)' );
	url.searchParams.set( 'worldId', worldId );
	const candidates = providers.length ? providers : nodeId && gateway ? [ { nodeId, gateway } ] : [];
	invariant( candidates.length <= 8, 'Invite contains too many gateway candidates' );
	url.searchParams.delete( 'nodeId' );
	url.searchParams.delete( 'gateway' );
	for ( const provider of candidates ) {
		invariant( /^[A-Za-z0-9]{20,256}$/.test( provider.nodeId || '' ), 'Invalid invite node PeerID' );
		invariant( validSecureGateway( provider.gateway ), 'Invite gateway must be a secure HTTPS/WSS origin' );
		url.searchParams.append( 'nodeId', provider.nodeId );
		url.searchParams.append( 'gateway', provider.gateway );
	}
	invariant( candidates.length || ! nodeId, 'Invite provider ID and gateway must be supplied together' );
	if ( ! candidates.length && gateway ) {
		invariant( validSecureGateway( gateway ), 'Invite gateway must be a secure HTTPS/WSS origin' );
		url.searchParams.set( 'gateway', gateway );
	}
	if ( directory ) {
		invariant( validSecureOrigin( directory ), 'Invite directory must be an HTTPS origin' );
		url.searchParams.set( 'directory', directory );
	} else url.searchParams.delete( 'directory' );
	return url.href;
}

export class WorldConnector {
	constructor( { worldId, zeroTierNodeId = '', zeroTierNetworkId = DEFAULT_ZEROTIER_NETWORK_ID, nodeId, gateway = globalThis.location?.origin, providers = [], directory = '', chunkBytes = ASSET_CHUNK_BYTES, loadWorldProviders = null } = {} ) {
		invariant( isWorldID( worldId ) || ! worldId && /^[0-9a-f]{10}$/.test( zeroTierNodeId ), 'A valid worldId or ZeroTier node locator is required' );
		invariant( Number.isInteger( chunkBytes ) && chunkBytes > 0 && chunkBytes <= 192 * 1024, 'Invalid asset chunk size' );
		invariant( ! directory || validSecureOrigin( directory ), 'Directory must be an HTTPS origin' );
		invariant( ! zeroTierNodeId || /^[0-9a-f]{10}$/.test( zeroTierNodeId ) && /^[0-9a-f]{16}$/.test( zeroTierNetworkId ) && directory, 'ZeroTier lookup requires a valid node ID, network ID, and HTTPS resolver' );
		this.worldId = worldId;
		this.zeroTierNodeId = zeroTierNodeId;
		this.zeroTierNetworkId = zeroTierNetworkId;
		this.nodeId = nodeId || '';
		this.gateway = gateway;
		this.providers = providers.length ? providers.map( ( provider ) => ( { ...provider } ) ) : this.nodeId ? [ { nodeId: this.nodeId, gateway } ] : [];
		invariant( this.providers.length <= 8 && this.providers.every( ( provider ) => /^[A-Za-z0-9]{20,256}$/.test( provider.nodeId || '' ) && validGatewayForCurrentPage( provider.gateway ) ), 'Invalid world gateway candidates' );
		this.directory = directory;
		this.chunkBytes = chunkBytes;
		this.loadWorldProviders = loadWorldProviders;
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
		this.rtcPending = new Map();
		this.rtcPeerConnection = null;
		this.rtcChannel = null;
		this.rtcAttempted = false;
		this.iceServers = [];
	}

	async getManifest( { signal, excludeProviders = this.unavailableProviders } = {} ) {
		throwIfAborted( signal );
		if ( this.zeroTierNodeId ) {
			const discovered = await this.#discoverZeroTierProviders( signal );
			if ( ! this.worldId ) {
				const worldIDs = [ ...new Set( discovered.flatMap( ( provider ) => provider.worldIds ) ) ];
				invariant( worldIDs.length === 1, worldIDs.length ? 'ZeroTier node advertises multiple ThruHolds; choose one by ThruHold ID' : 'ZeroTier node does not currently advertise a ThruHold' );
				this.worldId = worldIDs[ 0 ];
			}
			const candidates = discovered.filter( ( provider ) => provider.worldIds.includes( this.worldId ) );
			invariant( candidates.length > 0, 'ZeroTier node does not advertise the requested ThruHold' );
			this.providers = candidates.map( ( provider ) => ( { nodeId: provider.nodeId, gateway: provider.gateway } ) );
		}
		invariant( isWorldID( this.worldId ), 'A valid worldId is required' );
		let lastError = null;
		const attempted = new Set( excludeProviders );
		for ( const provider of this.providers ) {
			const key = `${provider.nodeId}\n${provider.gateway}`;
			if ( ! attempted.has( key ) ) {
				attempted.add( key );
				this.nodeId = provider.nodeId;
				this.gateway = provider.gateway;
				try {
					return await this.#fetchManifest( signal );
				} catch ( error ) {
					if ( signal?.aborted ) throw signal.reason || error;
					lastError = error;
					this.close();
					this.nodeId = '';
				}
			}
		}
		this.nodeId = '';
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

	async updatePresence( pose, { signal, spawnCandidates } = {} ) {
		validatePresencePose( pose );
		if ( spawnCandidates !== undefined && ( ! Array.isArray( spawnCandidates ) || spawnCandidates.length < 1 || spawnCandidates.length > 1024 || spawnCandidates.some( ( position ) => ! Array.isArray( position ) || position.length !== 3 || ! position.every( ( value ) => Number.isFinite( value ) && Math.abs( value ) <= 100000 ) ) ) ) throw new Error( 'Invalid world spawn candidates' );
		const reply = await this.#request( { type: 'presence.update', pose, ...( spawnCandidates ? { spawnCandidates } : {} ) }, { signal } );
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
		this.manifest = await verifySignedWorldManifest( reply.document, { loadWorldProviders: this.loadWorldProviders } );
		invariant( this.manifest.worldId === this.worldId, 'Manifest belongs to another world' );
		this.authorityLease = null;
		if ( reply.authorityLease ) {
			await verifySignedDocument( reply.authorityLease, 'elsemesh.authority/2' );
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
			try { await verifySignedDocument( document, 'elsemesh.node/1' ); }
			catch { continue; }
			const node = document.payload;
			const now = Date.now() / 1000;
			if ( node.protocol !== 'elsemesh.node/1' || node.nodeId !== document.signer || ! node.worldIds?.includes( this.worldId ) || ! validSecureGateway( node.gateway ) || node.issuedAt > now + 300 || node.issuedAt < now - 86400 || node.expiresAt <= now || node.expiresAt > node.issuedAt + 172800 ) continue;
			providers.push( { nodeId: node.nodeId, gateway: node.gateway } );
		}
		if ( providers.length === 0 ) throw new Error( 'Directory returned no valid signed provider for this world' );
		return providers;
	}

	async #discoverZeroTierProviders( signal ) {
		const url = new URL( `/v1/zerotier/${this.zeroTierNetworkId}/${this.zeroTierNodeId}`, this.directory );
		const response = await fetch( url, { credentials: 'omit', cache: 'no-store', signal } );
		if ( ! response.ok ) throw new Error( `ZeroTier resolver lookup failed (${response.status})` );
		const result = await response.json();
		throwIfAborted( signal );
		invariant( result.networkId === this.zeroTierNetworkId && result.nodeId === this.zeroTierNodeId && Array.isArray( result.providers ), 'ZeroTier resolver returned an invalid node lookup' );
		const providers = [];
		for ( const document of result.providers ) {
			throwIfAborted( signal );
			try { await verifySignedDocument( document, 'elsemesh.node/1' ); }
			catch { continue; }
			const node = document.payload;
			const now = Date.now() / 1000;
			if ( node.protocol !== 'elsemesh.node/1' || node.nodeId !== document.signer || node.zeroTierNodeId !== this.zeroTierNodeId || node.zeroTierNetworkId !== this.zeroTierNetworkId || ! Array.isArray( node.worldIds ) || node.worldIds.length !== 1 || ! isWorldID( node.worldIds[ 0 ] ) || ! validSecureGateway( node.gateway ) || node.issuedAt > now + 300 || node.issuedAt < now - 86400 || node.expiresAt <= now || node.expiresAt > node.issuedAt + 172800 ) continue;
			providers.push( { nodeId: node.nodeId, gateway: node.gateway, worldIds: node.worldIds } );
		}
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

	// Load the portal view's initial content first while the rest of the destination
	// world continues loading through its own connector.
	async preparePortal( portal, { onPortalView, signal } = {} ) {
		throwIfAborted( signal );
		invariant( portal && portal.enabled && portal.destinationWorldId, 'Portal has no active destination' );
		const destination = new WorldConnector( {
			worldId: portal.destinationWorldId,
			nodeId: portal.destinationPeerId || '',
			gateway: portal.destinationGateway || this.gateway,
			directory: this.directory,
			chunkBytes: this.chunkBytes,
			loadWorldProviders: this.loadWorldProviders,
		} );
		try {
			await destination.getManifest( { signal } );
			throwIfAborted( signal );
			const previewAssets = await destination.preload( { through: 'portal-preview', signal } );
			throwIfAborted( signal );
			const portalView = onPortalView ? await onPortalView( { connector: destination, assets: previewAssets, signal } ) : null;
			throwIfAborted( signal );
			const assets = await destination.preload( { through: 'visible', signal } );
			throwIfAborted( signal );
			return { connector: destination, manifest: destination.manifest, assets, portalViewAssetIDs: new Set( previewAssets.keys() ), portalView };
		} catch ( error ) {
			destination.close();
			throw error;
		}
	}

	async #connection( signal ) {
		throwIfAborted( signal );
		if ( this.rtcChannel?.readyState === 'open' ) return { kind: 'webrtc', channel: this.rtcChannel };
		if ( this.webTransport?.state === 'connected' ) return { kind: 'webtransport', session: this.webTransport };
		if ( this.socketPromise ) return waitWithAbort( this.socketPromise, signal );
		if ( this.socket?.readyState === WebSocket.OPEN ) {
			if ( ! this.rtcAttempted && typeof globalThis.RTCPeerConnection === 'function' ) {
				try { await this.#openRTC( this.socket, signal ); }
				catch ( error ) { if ( signal?.aborted ) throw signal.reason || error; }
			}
			if ( this.rtcChannel?.readyState === 'open' ) return { kind: 'webrtc', channel: this.rtcChannel };
			return { kind: 'websocket', socket: this.socket };
		}
		const promise = ( async () => {
			const base = this.#httpBaseURL();
			let socket = null;
			if ( typeof globalThis.RTCPeerConnection === 'function' ) {
				socket = await this.#openWebSocket( base, signal );
				try {
					await this.#openRTC( socket, signal );
					return { kind: 'webrtc', channel: this.rtcChannel };
				} catch ( error ) {
					if ( signal?.aborted ) throw signal.reason || error;
					console.info( 'Direct WebRTC unavailable; trying the world gateway.', error );
				}
			}
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
			return { kind: 'websocket', socket: socket || await this.#openWebSocket( base, signal ) };
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
					this.iceServers = validateICEServers( response.iceServers );
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
		if ( connection.kind === 'webrtc' ) {
			try { return await this.#requestRTC( connection.channel, { ...message, worldId: this.worldId, requestId }, signal ); }
			catch ( error ) {
				if ( signal?.aborted || ! [ 'manifest.get', 'role-revocations.get', 'asset.get' ].includes( message.type ) || this.rtcChannel?.readyState === 'open' ) throw error;
				connection = await this.#connection( signal );
				if ( connection.kind === 'webrtc' ) throw error;
				if ( connection.kind === 'webtransport' ) return requestWebTransport( connection.session, { ...message, requestId }, signal );
				return this.#requestSocket( connection.socket, { ...message, requestId }, signal );
			}
		}
		const socket = connection.socket;
		return this.#requestSocket( socket, { ...message, requestId }, signal );
	}

	#requestSocket( socket, message, signal ) {
		const requestId = message.requestId;
		return new Promise( ( resolve, reject ) => {
			const cleanup = () => { clearTimeout( timeout ); signal?.removeEventListener( 'abort', abort ); };
			const timeout = setTimeout( () => { this.pending.delete( requestId ); cleanup(); reject( new Error( 'World request timed out' ) ); }, 30000 );
			const abort = () => { clearTimeout( timeout ); this.pending.delete( requestId ); cleanup(); reject( signal.reason || new DOMException( 'Aborted', 'AbortError' ) ); };
			this.pending.set( requestId, { resolve: ( value ) => { cleanup(); resolve( value ); }, reject: ( error ) => { cleanup(); reject( error ); }, timeout } );
			signal?.addEventListener( 'abort', abort, { once: true } );
			try { socket.send( JSON.stringify( message ) ); }
			catch ( error ) { clearTimeout( timeout ); this.pending.delete( requestId ); reject( error ); }
		} );
	}

	async #openRTC( socket, signal ) {
		if ( this.rtcAttempted ) throw new Error( 'Direct WebRTC was already attempted for this connection' );
		this.rtcAttempted = true;
		throwIfAborted( signal );
		const peer = new globalThis.RTCPeerConnection( { iceServers: this.iceServers } );
		const channel = peer.createDataChannel( WORLD_PROTOCOL_NAMESPACE, { ordered: true } );
		this.rtcPeerConnection = peer;
		this.rtcChannel = channel;
		channel.addEventListener( 'message', async ( event ) => {
			let response;
			try {
				const data = typeof event.data === 'string' ? event.data : event.data instanceof ArrayBuffer ? new TextDecoder().decode( event.data ) : event.data instanceof Blob ? await event.data.text() : null;
				if ( data === null ) throw new Error( 'Unsupported world data channel message' );
				response = JSON.parse( data );
			} catch { this.#failRTCPending( new Error( 'Invalid response from world data channel' ) ); return; }
			const pending = this.rtcPending.get( response.requestId );
			if ( ! pending ) return;
			this.rtcPending.delete( response.requestId );
			clearTimeout( pending.timeout );
			if ( response.worldId !== this.worldId ) { pending.reject( new Error( 'World data channel response mismatch' ) ); return; }
			if ( response.type === 'error' ) pending.reject( new Error( response.error || 'World request failed' ) );
			else pending.resolve( response );
		} );
		channel.addEventListener( 'close', () => this.#closeRTC( new Error( 'Direct WebRTC data channel closed' ) ), { once: true } );
		peer.addEventListener( 'connectionstatechange', () => {
			if ( peer.connectionState === 'failed' || peer.connectionState === 'closed' ) this.#closeRTC( new Error( 'Direct WebRTC connection closed' ) );
		} );
		try {
			const offer = await peer.createOffer();
			await peer.setLocalDescription( offer );
			await waitForICEGathering( peer, signal );
			invariant( peer.localDescription?.sdp && peer.localDescription.sdp.length <= 64 * 1024, 'WebRTC offer is invalid or too large' );
			const response = await this.#requestSocket( socket, { type: 'webrtc.offer', sdp: peer.localDescription.sdp, requestId: `webrtc-${globalThis.crypto?.randomUUID?.() || Date.now()}` }, signal );
			invariant( response.type === 'webrtc.answer' && response.worldId === this.worldId && typeof response.sdp === 'string' && response.sdp.length <= 64 * 1024, 'World gateway returned an invalid WebRTC answer' );
			await peer.setRemoteDescription( { type: 'answer', sdp: response.sdp } );
			await waitForDataChannel(channel, signal);
			return channel;
		} catch ( error ) {
			this.#closeRTC( error );
			throw error;
		}
	}

	#requestRTC( channel, message, signal ) {
		throwIfAborted( signal );
		if ( channel.readyState !== 'open' ) return Promise.reject( new Error( 'Direct WebRTC data channel is not open' ) );
		const requestId = message.requestId;
		return new Promise( ( resolve, reject ) => {
			const cleanup = () => { clearTimeout( timeout ); signal?.removeEventListener( 'abort', abort ); };
			const timeout = setTimeout( () => { this.rtcPending.delete( requestId ); cleanup(); reject( new Error( 'World data channel request timed out' ) ); }, 30000 );
			const abort = () => { this.rtcPending.delete( requestId ); cleanup(); reject( signal.reason || new DOMException( 'Aborted', 'AbortError' ) ); };
			this.rtcPending.set( requestId, { resolve: ( value ) => { cleanup(); resolve( value ); }, reject: ( error ) => { cleanup(); reject( error ); }, timeout } );
			signal?.addEventListener( 'abort', abort, { once: true } );
			try { channel.send( JSON.stringify( message ) ); }
			catch ( error ) { this.rtcPending.delete( requestId ); cleanup(); reject( error ); }
		} );
	}

	#failRTCPending( error ) {
		for ( const pending of this.rtcPending.values() ) { clearTimeout( pending.timeout ); pending.reject( error ); }
		this.rtcPending.clear();
	}

	#closeRTC( reason = new Error( 'Direct WebRTC connection closed' ) ) {
		const peer = this.rtcPeerConnection;
		this.rtcPeerConnection = null;
		this.rtcChannel = null;
		this.#failRTCPending( reason );
		if ( peer && peer.connectionState !== 'closed' ) peer.close();
	}

	close() {
		this.#closeRTC( new Error( 'World connector closed' ) );
		this.socket?.close();
		this.webTransport?.close();
		this.socket = null;
		this.webTransport = null;
		this.webTransportFailed = false;
		this.rtcAttempted = false;
		this.iceServers = [];
	}
}

export function validateWorldObjects( objects, assets ) {
	invariant( Array.isArray( objects ) && objects.length <= 10000, 'World manifest has an invalid object list' );
	const ids = new Set();
	for ( const object of objects ) {
		invariant( object && typeof object.id === 'string' && /^elsemesh-object:[\w.-]{1,128}$/.test( object.id ) && ! ids.has( object.id ), 'World manifest has an invalid or duplicate object ID' );
		invariant( object.replacesObjectId === undefined || typeof object.replacesObjectId === 'string' && /^elsemesh-object:[\w.-]{1,128}$/.test( object.replacesObjectId ) && object.replacesObjectId !== object.id, `World object ${object.id} has an invalid replacement reference` );
		ids.add( object.id );
		invariant( object?.priority === undefined || [ 'portal-preview', 'visible', 'nearby', 'background' ].includes( object.priority ), `World object ${object.id || '(unknown)'} has an invalid streaming priority` );
		if ( object?.streamingBounds !== undefined ) {
			const bounds = object.streamingBounds;
			invariant( bounds && validVector( bounds.center ) && bounds.center.every( ( value ) => Math.abs( value ) <= 10000 ) && Number.isFinite( bounds.radius ) && bounds.radius > 0 && bounds.radius <= 10000, `World object ${object.id || '(unknown)'} has invalid streaming bounds` );
			invariant( bounds.maxDistanceMeters === undefined || Number.isFinite( bounds.maxDistanceMeters ) && bounds.maxDistanceMeters > 0 && bounds.maxDistanceMeters <= 10000, `World object ${object.id || '(unknown)'} has an invalid maximum streaming distance` );
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
		const compound = collision.shape === 'compound' && Array.isArray( collision.boxes ) && collision.boxes.length > 0 && collision.boxes.length <= 2048 && collision.boxes.every( ( item ) => item && ( item.tag === undefined || item.tag === 'pierRail' ) && validVector( item.center ) && item.center.every( ( value ) => Math.abs( value ) <= 1e6 ) && validVector( item.halfExtents ) && item.halfExtents.every( ( value ) => value > 0 && value <= 1000 ) && Number.isFinite( item.yaw ) && Math.abs( item.yaw ) <= 360 && typeof item.walkable === 'boolean' && typeof item.solid === 'boolean' );
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
		invariant( portal && typeof portal.id === 'string' && /^elsemesh-portal:[\w.-]{1,128}$/.test( portal.id ) && ! ids.has( portal.id ), 'World manifest has an invalid or duplicate portal ID' );
		invariant( isWorldID( portal.destinationWorldId ) && ( portal.destinationPeerId === undefined || typeof portal.destinationPeerId === 'string' && /^[A-Za-z0-9]{20,256}$/.test( portal.destinationPeerId ) ), `Portal ${portal.id} has an invalid destination` );
		invariant( portal.destinationGateway === undefined || validWorldGateway( portal.destinationGateway ), `Portal ${portal.id} has an invalid destination gateway` );
		invariant( portal.visual === undefined || [ 'timber', 'stone', 'metal' ].includes( portal.visual ), `Portal ${portal.id} has an unsupported visual style` );
		for ( const transform of [ portal.entry, portal.exit ] ) {
			invariant( transform && validVector( transform.position ) && transform.position.every( ( value ) => Math.abs( value ) <= 1e6 ) && Number.isFinite( transform.yaw ) && Math.abs( transform.yaw ) <= 360 && transform.rotation === undefined, `Portal ${portal.id} has an invalid transform` );
		}
		invariant( typeof portal.openView === 'boolean' && typeof portal.enabled === 'boolean', `Portal ${portal.id} has invalid flags` );
		if ( portal.back !== undefined ) {
			invariant( rules.requiredFeatures?.includes( 'elsemesh.portal-two-sided/1' ), 'Portal back requires elsemesh.portal-two-sided/1' );
			validatePortalBack( portal.back, validWorldGateway );
		}
		ids.add( portal.id );
	}
	return ids;
}

export function validateWorldComponents( components = [], rules, ids = new Set(), assets = [] ) {
	invariant( Array.isArray( components ) && components.length <= 128, 'World manifest has an invalid component list' );
	const assetRefs = new Map( assets.map( asset => [ asset.id, asset ] ) );
	for ( const component of components ) {
		invariant( component && typeof component === 'object' && ! Array.isArray( component ) && Object.keys( component ).every( key => [ 'id', 'type', 'priority', 'streamingBounds', 'assets', 'data' ].includes( key ) ) && typeof component.id === 'string' && /^elsemesh-component:[\w.-]{1,128}$/.test( component.id ) && ! ids.has( component.id ) && typeof component.type === 'string' && /^elsemesh\.[a-z0-9.-]+\/\d+$/.test( component.type ) && ( component.priority === undefined || [ 'portal-preview', 'visible', 'nearby', 'background' ].includes( component.priority ) ) && Array.isArray( component.assets ) && component.assets.length <= 256 && component.data && typeof component.data === 'object' && ! Array.isArray( component.data ) && Object.keys( component.data ).every( key => ! [ 'id', 'type', 'priority', 'streamingBounds', 'assets', 'data' ].includes( key ) ) && JSON.stringify( component.data ).length <= 64 * 1024, 'World manifest contains an invalid or duplicate component envelope' );
		if ( component.streamingBounds !== undefined ) invariant( validComponentStreamingBounds( component.streamingBounds ), `World component ${component.id} has invalid streaming bounds` );
		invariant( rules.requiredFeatures?.includes( component.type ), `World component ${component.type} is missing from requiredFeatures` );
		const componentAssetIDs = new Set();
		for ( const reference of component.assets ) {
			invariant( reference && typeof reference === 'object' && ! Array.isArray( reference ) && Object.keys( reference ).length === 2 && Object.keys( reference ).every( key => [ 'assetId', 'kind' ].includes( key ) ) && /^sha256:[0-9a-f]{64}$/.test( reference.assetId || '' ) && typeof reference.kind === 'string' && /^[a-z0-9][a-z0-9./-]{0,63}$/.test( reference.kind ) && ! componentAssetIDs.has( reference.assetId ), `World component ${component.id} has an invalid asset declaration` );
			const asset = assetRefs.get( reference.assetId );
			invariant( asset?.kind === reference.kind && asset.priority === ( component.priority || 'portal-preview' ) && asset.bytes > 0, `World component ${component.id} has an invalid component asset reference` );
			componentAssetIDs.add( reference.assetId );
		}
		ids.add( component.id );
	}
	return ids;
}

function validComponentStreamingBounds( bounds ) {
	return bounds && typeof bounds === 'object' && ! Array.isArray( bounds ) && Object.keys( bounds ).every( ( key ) => [ 'center', 'radius', 'maxDistanceMeters' ].includes( key ) ) && validVector( bounds.center ) && bounds.center.every( ( value ) => Math.abs( value ) <= 10000 ) && Number.isFinite( bounds.radius ) && bounds.radius > 0 && bounds.radius <= 10000 && ( bounds.maxDistanceMeters === undefined || Number.isFinite( bounds.maxDistanceMeters ) && bounds.maxDistanceMeters > 0 && bounds.maxDistanceMeters <= 10000 );
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

function validGatewayForCurrentPage( value ) {
	if ( validSecureGateway( value ) ) return true;
	try {
		const gateway = new URL( value );
		const page = globalThis.location && new URL( globalThis.location.href );
		const loopback = ( hostname ) => [ 'localhost', '127.0.0.1', '::1', '[::1]' ].includes( hostname );
		return [ 'http:', 'ws:' ].includes( gateway.protocol ) && loopback( gateway.hostname ) && ( ! page || page.protocol === 'http:' && loopback( page.hostname ) );
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

function waitForICEGathering( peer, signal ) {
	if ( peer.iceGatheringState === 'complete' ) return Promise.resolve();
	return waitForEvent( peer, 'icegatheringstatechange', () => peer.iceGatheringState === 'complete', 12000, 'WebRTC ICE gathering timed out', signal );
}

function waitForDataChannel( channel, signal ) {
	if ( channel.readyState === 'open' ) return Promise.resolve();
	return waitForEvent( channel, 'open', () => channel.readyState === 'open', 15000, 'WebRTC data channel did not open', signal );
}

function waitForEvent( target, eventName, ready, timeoutMs, timeoutMessage, signal ) {
	if ( signal?.aborted ) return Promise.reject( signal.reason || new DOMException( 'Aborted', 'AbortError' ) );
	return new Promise( ( resolve, reject ) => {
		const cleanup = () => {
			clearTimeout( timeout );
			target.removeEventListener( eventName, changed );
			target.removeEventListener( 'close', closed );
			signal?.removeEventListener( 'abort', abort );
		};
		const finish = () => { cleanup(); resolve(); };
		const changed = () => { if ( ready() ) finish(); };
		const closed = () => { cleanup(); reject( new Error( 'WebRTC channel closed during setup' ) ); };
		const abort = () => { cleanup(); reject( signal.reason || new DOMException( 'Aborted', 'AbortError' ) ); };
		const timeout = setTimeout( () => { cleanup(); reject( new Error( timeoutMessage ) ); }, timeoutMs );
		target.addEventListener( eventName, changed );
		target.addEventListener( 'close', closed, { once: true } );
		signal?.addEventListener( 'abort', abort, { once: true } );
		changed();
	} );
}

function validateICEServers( servers ) {
	if ( ! Array.isArray( servers ) ) return [];
	const result = [];
	for ( const server of servers.slice( 0, 8 ) ) {
		const urls = Array.isArray( server?.urls ) ? server.urls : typeof server?.urls === 'string' ? [ server.urls ] : [];
		const valid = urls.filter( ( value ) => typeof value === 'string' && value.length <= 255 && /^(stun|stuns):[^\s]+$/i.test( value ) ).slice( 0, 8 );
		if ( valid.length ) result.push( { urls: valid } );
	}
	return result;
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

export async function verifySignedWorldManifest( document, { loadWorldProviders = null } = {} ) {
	await verifySignedDocument( document, 'elsemesh.world/3' );
	const manifest = document.payload;
	invariant( manifest.protocol === 'elsemesh.world/3' && isWorldID( manifest.worldId ) && manifest.ownerPeerId === document.signer, 'Signed world manifest identity is invalid' );
	await loadWorldProviders?.( manifest );
	validateWorldRequirements( manifest );
	validateWorldExperience( manifest.experience, manifest.assets ?? null );
	validateWorldSpawn( manifest.spawn );
	validateWorldEntryPoints( manifest.entryPoints, manifest.entryPointPrompt, manifest.entryPointActionLabel );
	const entityIDs = validateWorldObjects( manifest.objects, manifest.assets );
	validateWorldPortals( manifest.portals, entityIDs, manifest.rules );
	validateWorldComponents( manifest.components, manifest.rules, entityIDs, manifest.assets );
	validateWorldHosts( manifest.hosts );
	invariant( Number.isSafeInteger( manifest.authorityEpoch ) && manifest.authorityEpoch > 0, 'Manifest authority epoch is outside the supported range' );
	return {
		...manifest,
		components: ( manifest.components || [] ).map( worldComponentRuntimeRecord ),
	};
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
