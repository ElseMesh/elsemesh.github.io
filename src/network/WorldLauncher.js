import { isWorldID } from './WorldIdentity.js';

const STORAGE_KEY = 'elsemesh.visited-worlds.v1';
const HOME_STORAGE_KEY = 'elsemesh.home-world.v1';
const MAX_VISITED_WORLDS = 12;
const MAX_INVITE_URL_CHARS = 4096;

function appPageURL( value ) {
	const url = new URL( value );
	if ( ! [ 'http:', 'https:' ].includes( url.protocol ) ) throw new Error( 'World links must use HTTP or HTTPS' );
	url.search = '';
	url.hash = '';
	return url;
}

function configuredWorldResolver() {
	const value = globalThis.ELSEMESH_CONFIG?.worldResolver || '';
	if ( ! value ) return '';
	const resolver = new URL( value );
	if ( resolver.protocol !== 'https:' || resolver.username || resolver.password || ! [ '', '/' ].includes( resolver.pathname ) || resolver.search || resolver.hash ) throw new Error( 'Configured world resolver must be an HTTPS origin' );
	return resolver.origin;
}

function isLoopback( hostname ) {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export async function discoverLocalWorldURL( { pageURL = globalThis.location?.href, fetchImpl = globalThis.fetch } = {} ) {
	const page = new URL( pageURL );
	if ( ! [ 'http:', 'https:' ].includes( page.protocol ) ) return null;
	if ( globalThis.ELSEMESH_CONFIG?.localWorld ) return null;
	if ( page.searchParams.has( 'localProvider' ) || page.searchParams.has( 'localMap' ) ) return null;
	if ( ! isLoopback( page.hostname ) || page.searchParams.has( 'worldId' ) || page.searchParams.has( 'ztNodeId' ) || page.searchParams.get( 'example' ) === '1' ) return null;
	try {
		const response = await fetchImpl( new URL( '/api/world/manifest', page ), { credentials: 'omit', cache: 'no-store' } );
		if ( ! response.ok ) return null;
		const document = ( await response.json() )?.document;
		const worldId = document?.payload?.worldId;
		const nodeId = document?.payload?.ownerPeerId;
		if ( ! isWorldID( worldId ) || ! /^[A-Za-z0-9]{20,256}$/.test( nodeId || '' ) ) return null;
		page.searchParams.set( 'worldId', worldId );
		page.searchParams.delete( 'ztNodeId' );
		page.searchParams.delete( 'directory' );
		page.searchParams.set( 'nodeId', nodeId );
		page.searchParams.set( 'gateway', page.origin );
		page.hash = '';
		return page.href;
	} catch {
		return null;
	}
}

function validGateway( value, page ) {
	try {
		const gateway = new URL( value );
		if ( gateway.username || gateway.password || ! [ '', '/' ].includes( gateway.pathname ) || gateway.search || gateway.hash ) return false;
		if ( [ 'https:', 'wss:' ].includes( gateway.protocol ) ) return true;
		return page.protocol === 'http:' && isLoopback( page.hostname ) && [ 'http:', 'ws:' ].includes( gateway.protocol ) && isLoopback( gateway.hostname );
	} catch {
		return false;
	}
}

function normalizedWorldURL( { pageURL, worldId, zeroTierNodeId = '', nodeId = '', gateway = '', providers = [], directory = '' } ) {
	const page = appPageURL( pageURL );
	if ( ! isWorldID( worldId ) && ! ( ! worldId && /^[0-9a-f]{10}$/i.test( zeroTierNodeId ) ) ) throw new Error( 'Invite does not contain a valid ThruHold ID or ZeroTier node ID' );
	if ( zeroTierNodeId && ! /^[0-9a-f]{10}$/i.test( zeroTierNodeId ) ) throw new Error( 'Invite contains an invalid ZeroTier node ID' );
	const candidates = providers.length ? providers : nodeId && gateway ? [ { nodeId, gateway } ] : [];
	if ( candidates.length > 8 ) throw new Error( 'Invite contains too many gateway candidates' );
	for ( const candidate of candidates ) {
		if ( ! /^[A-Za-z0-9]{20,256}$/.test( candidate.nodeId || '' ) ) throw new Error( 'Invite contains an invalid provider ID' );
		if ( ! validGateway( candidate.gateway, page ) ) throw new Error( 'Invite contains an invalid or insecure gateway' );
	}
	if ( ! candidates.length && nodeId ) throw new Error( 'Invite provider ID and gateway must be supplied together' );
	if ( ! candidates.length && gateway && ! validGateway( gateway, page ) ) throw new Error( 'Invite contains an invalid or insecure gateway' );
	if ( directory ) {
		const directoryURL = new URL( directory );
		if ( directoryURL.protocol !== 'https:' || directoryURL.username || directoryURL.password || ! [ '', '/' ].includes( directoryURL.pathname ) || directoryURL.search || directoryURL.hash ) throw new Error( 'Invite contains an invalid directory URL' );
	}
	if ( zeroTierNodeId && ! directory ) throw new Error( 'A ZeroTier node ID requires an HTTPS world resolver' );
	if ( worldId ) page.searchParams.set( 'worldId', worldId );
	else page.searchParams.delete( 'worldId' );
	page.searchParams.delete( 'ztNodeId' );
	if ( zeroTierNodeId ) page.searchParams.set( 'ztNodeId', zeroTierNodeId.toLowerCase() );
	page.searchParams.delete( 'nodeId' );
	page.searchParams.delete( 'gateway' );
	for ( const candidate of candidates ) {
		page.searchParams.append( 'nodeId', candidate.nodeId );
		page.searchParams.append( 'gateway', candidate.gateway );
	}
	if ( ! candidates.length && gateway ) page.searchParams.set( 'gateway', gateway );
	if ( directory ) page.searchParams.set( 'directory', directory );
	return page;
}

export function builtInWorldURL( pageURL = globalThis.location?.href ) {
	return appPageURL( pageURL ).href;
}

export function parseWorldInviteURL( value, pageURL = globalThis.location?.href ) {
	const page = appPageURL( pageURL );
	const input = String( value ).trim();
	if ( input.length > MAX_INVITE_URL_CHARS ) throw new Error( 'Invite URL is too long' );
	const resolver = configuredWorldResolver();
	if ( isWorldID( input ) ) {
		if ( ! resolver ) throw new Error( 'No ThruHold resolver is configured; paste a full invite URL or configure worldResolver in elsemesh-config.js' );
		return normalizedWorldURL( { pageURL: page.href, worldId: input, directory: resolver } ).href;
	}
	if ( /^[0-9a-f]{10}$/i.test( input ) ) {
		if ( ! resolver ) throw new Error( 'No ZeroTier resolver is configured; configure worldResolver in elsemesh-config.js first' );
		return normalizedWorldURL( { pageURL: page.href, zeroTierNodeId: input, directory: resolver } ).href;
	}
	let invite;
	try {
		invite = new URL( input, page );
	} catch {
		throw new Error( 'Enter a valid ElseMesh world invite URL' );
	}
	if ( ! [ 'http:', 'https:' ].includes( invite.protocol ) || invite.username || invite.password ) throw new Error( 'Enter a valid ElseMesh world invite URL' );
	const params = invite.searchParams;
	const nodeIds = params.getAll( 'nodeId' );
	const gateways = params.getAll( 'gateway' );
	if ( nodeIds.length !== gateways.length && ! ( nodeIds.length === 0 && gateways.length === 1 ) ) throw new Error( 'Invite provider IDs and gateways must be paired' );
	return normalizedWorldURL( {
		pageURL: page.href,
		worldId: params.get( 'worldId' ),
		zeroTierNodeId: params.get( 'ztNodeId' ) || '',
		providers: nodeIds.map( ( nodeId, index ) => ( { nodeId, gateway: gateways[ index ] } ) ),
		gateway: nodeIds.length ? '' : gateways[ 0 ] || '',
		directory: params.get( 'directory' ) || resolver,
	} ).href;
}

function getStorage( storage ) {
	if ( storage !== undefined ) return storage;
	try { return globalThis.localStorage; } catch { return null; }
}

function readVisitedWorlds( pageURL, storage ) {
	if ( ! storage ) return [];
	let raw;
	try { raw = JSON.parse( storage.getItem( STORAGE_KEY ) || '[]' ); } catch { return []; }
	if ( ! Array.isArray( raw ) ) return [];
	const visited = [];
	for ( const item of raw ) {
		if ( ! item || typeof item.url !== 'string' ) continue;
		try {
			const page = appPageURL( pageURL );
			const storedURL = new URL( item.url );
			if ( storedURL.origin !== page.origin || storedURL.pathname !== page.pathname || storedURL.username || storedURL.password ) continue;
			const url = parseWorldInviteURL( item.url, pageURL );
			const worldId = new URL( url ).searchParams.get( 'worldId' );
			const title = typeof item.title === 'string' ? item.title.trim().slice( 0, 80 ) : '';
			visited.push( { worldId, title: title || worldId, url, updatedAt: Number.isFinite( item.updatedAt ) ? item.updatedAt : 0 } );
		} catch {}
	}
	const byWorld = new Map();
	for ( const item of visited.sort( ( a, b ) => b.updatedAt - a.updatedAt ) ) if ( ! byWorld.has( item.worldId ) ) byWorld.set( item.worldId, item );
	return [ ...byWorld.values() ].slice( 0, MAX_VISITED_WORLDS );
}

export function listVisitedWorlds( { pageURL = globalThis.location?.href, storage } = {} ) {
	return readVisitedWorlds( pageURL, getStorage( storage ) );
}

export function getHomeWorld( { pageURL = globalThis.location?.href, storage } = {} ) {
	const targetStorage = getStorage( storage );
	if ( ! targetStorage ) return null;
	try {
		const saved = JSON.parse( targetStorage.getItem( HOME_STORAGE_KEY ) || 'null' );
		if ( ! saved || typeof saved.url !== 'string' || typeof saved.worldId !== 'string' ) return null;
		const page = appPageURL( pageURL ), stored = new URL( saved.url );
		if ( stored.origin !== page.origin || stored.pathname !== page.pathname || stored.username || stored.password ) return null;
		const url = parseWorldInviteURL( saved.url, pageURL );
		if ( new URL( url ).searchParams.get( 'worldId' ) !== saved.worldId ) return null;
		return { worldId: saved.worldId, title: String( saved.title || saved.worldId ).slice( 0, 80 ), url };
	} catch {
		return null;
	}
}

export function setHomeWorld( { pageURL = globalThis.location?.href, worldId, nodeId = '', gateway = '', providers = [], directory = '', title = '', url: worldURL = '', storage } = {} ) {
	const targetStorage = getStorage( storage );
	if ( ! targetStorage ) return false;
	const url = worldURL ? parseWorldInviteURL( worldURL, pageURL ) : normalizedWorldURL( { pageURL, worldId, nodeId, gateway, providers, directory } ).href;
	const actualWorldId = new URL( url ).searchParams.get( 'worldId' );
	if ( worldId && worldId !== actualWorldId ) throw new Error( 'Home world ID does not match its invite URL' );
	try {
		targetStorage.setItem( HOME_STORAGE_KEY, JSON.stringify( { worldId: actualWorldId, title: String( title || actualWorldId ).trim().slice( 0, 80 ), url } ) );
		return true;
	} catch {
		return false;
	}
}

export function clearHomeWorld( { storage } = {} ) {
	const targetStorage = getStorage( storage );
	if ( ! targetStorage ) return false;
	try { targetStorage.removeItem( HOME_STORAGE_KEY ); return true; } catch { return false; }
}

export function defaultHomeWorldURL( { pageURL = globalThis.location?.href, storage } = {} ) {
	const current = new URL( pageURL );
	if ( current.searchParams.has( 'localProvider' ) || current.searchParams.has( 'localMap' ) ) return null;
	if ( current.searchParams.has( 'worldId' ) || current.searchParams.has( 'ztNodeId' ) || current.searchParams.get( 'example' ) === '1' ) return null;
	const home = getHomeWorld( { pageURL, storage } );
	if ( ! home ) return null;
	const url = new URL( home.url );
	for ( const [ key, value ] of current.searchParams ) {
		if ( ! [ 'worldId', 'ztNodeId', 'nodeId', 'gateway', 'directory', 'example' ].includes( key ) ) url.searchParams.append( key, value );
	}
	return url.href;
}

export function rememberWorldVisit( { pageURL = globalThis.location?.href, worldId, nodeId = '', gateway = '', providers = [], directory = '', title = '', storage, now = Date.now() } = {} ) {
	const url = normalizedWorldURL( { pageURL, worldId, nodeId, gateway, providers, directory } ).href;
	const targetStorage = getStorage( storage );
	if ( ! targetStorage ) return false;
	const visited = readVisitedWorlds( pageURL, targetStorage ).filter( item => item.worldId !== worldId );
	visited.unshift( { worldId, title: String( title || worldId ).trim().slice( 0, 80 ), url, updatedAt: now } );
	try {
		targetStorage.setItem( STORAGE_KEY, JSON.stringify( visited.slice( 0, MAX_VISITED_WORLDS ) ) );
		return true;
	} catch {
		return false;
	}
}

export function worldLauncherStorageKey() {
	return STORAGE_KEY;
}

export function homeWorldStorageKey() {
	return HOME_STORAGE_KEY;
}
