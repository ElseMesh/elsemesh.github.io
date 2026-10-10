import { verifySignedWorldManifest } from './WorldConnector.js';

const MAX_CHUNK = 192 * 1024;
const MAX_PROFILE_BYTES = 512 * 1024 * 1024;
const encoder = new TextEncoder();
let socket = null;
let stopped = false;
let heartbeat = null;
let keyBytes = null;
let profileFiles = null;
let worldId = '';

function status( value ) { self.postMessage( { type: 'status', status: value } ); }
function fail( error ) { self.postMessage( { type: 'error', message: error?.message || String( error ) } ); }
function base64( bytes ) { let value = ''; for ( const byte of new Uint8Array( bytes ) ) value += String.fromCharCode( byte ); return btoa( value ).replace( /=+$/, '' ); }
function base64url( value ) { return Uint8Array.from( atob( value.replace( /-/g, '+' ).replace( /_/g, '/' ) + '='.repeat( ( 4 - value.length % 4 ) % 4 ) ), c => c.charCodeAt( 0 ) ); }
function rawBase64( value ) { return Uint8Array.from( atob( value + '='.repeat( ( 4 - value.length % 4 ) % 4 ) ), c => c.charCodeAt( 0 ) ); }

async function start( message ) {
	try {
		stopped = false;
		worldId = message.document?.payload?.worldId;
		if ( ! /^tw-world:[\w.-]{1,128}$/.test( worldId || '' ) ) throw new Error( 'Invalid world ID in selected profile' );
		const manifest = await verifySignedWorldManifest( message.document );
		if ( ! Array.isArray( manifest.assets ) ) throw new Error( 'Signed manifest asset list is invalid' );
		const refs = new Map();
		let expectedBytes = 0;
		for ( const asset of manifest.assets ) {
			if ( ! /^sha256:[0-9a-f]{64}$/.test( asset.id || '' ) || ! Number.isSafeInteger( asset.bytes ) || asset.bytes < 0 ) throw new Error( 'Manifest contains an invalid asset reference' );
			if ( refs.has( asset.id ) ) throw new Error( 'Manifest contains duplicate asset IDs' );
			refs.set( asset.id, asset.bytes );
			expectedBytes += asset.bytes;
			if ( expectedBytes > MAX_PROFILE_BYTES ) throw new Error( 'This profile exceeds the browser-host 512 MiB safety limit' );
		}
		profileFiles = new Map( message.files );
		keyBytes = new Uint8Array( message.key );
		await validateKey( message.document.publicKey );
		let checked = 0;
		for ( const [ id, size ] of refs ) {
			const file = profileFiles.get( id );
			if ( ! file || file.size !== size ) throw new Error( `Profile is missing the declared asset ${id}` );
			const digest = new Uint8Array( await crypto.subtle.digest( 'SHA-256', await file.arrayBuffer() ) );
			const hex = [ ...digest ].map( byte => byte.toString( 16 ).padStart( 2, '0' ) ).join( '' );
			if ( `sha256:${hex}` !== id ) throw new Error( `Asset content hash failed for ${id}` );
			checked += size;
			status( `Checking world assets (${Math.floor( checked * 100 / Math.max( expectedBytes, 1 ) )}%)` );
		}
		const endpoint = new URL( message.gateway );
		if ( endpoint.protocol === 'https:' ) endpoint.protocol = 'wss:';
		else if ( endpoint.protocol === 'http:' && [ 'localhost', '127.0.0.1', '[::1]' ].includes( endpoint.hostname ) ) endpoint.protocol = 'ws:';
		else if ( endpoint.protocol !== 'wss:' && ! ( endpoint.protocol === 'ws:' && [ 'localhost', '127.0.0.1', '[::1]' ].includes( endpoint.hostname ) ) ) throw new Error( 'Gateway must use HTTPS/WSS (HTTP is allowed only on localhost)' );
		endpoint.pathname = '/browser-host'; endpoint.search = ''; endpoint.hash = '';
		socket = new WebSocket( endpoint.href );
		socket.onmessage = event => { void handleFrame( JSON.parse( event.data ) ).catch( fail ); };
		socket.onopen = () => status( 'Connected; waiting for gateway challenge' );
		socket.onclose = () => { clearInterval( heartbeat ); if ( ! stopped ) status( 'Disconnected' ); clearSecrets(); };
		socket.onerror = () => { if ( ! stopped ) status( 'Connection error' ); };
	} catch ( error ) { clearSecrets(); fail( error ); }
}

async function validateKey( encodedPublicKey ) {
	if ( keyBytes.length !== 68 || keyBytes[ 0 ] !== 8 || keyBytes[ 1 ] !== 1 || keyBytes[ 2 ] !== 18 || keyBytes[ 3 ] !== 64 ) throw new Error( 'node.key must be a libp2p Ed25519 private key' );
	const prefix = Uint8Array.from( [ 0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20 ] );
	const pkcs8 = new Uint8Array( prefix.length + 32 ); pkcs8.set( prefix ); pkcs8.set( keyBytes.subarray( 4, 36 ), prefix.length );
	let privateKey;
	try {
		const checkKey = await crypto.subtle.importKey( 'pkcs8', pkcs8, { name: 'Ed25519' }, true, [ 'sign' ] );
		const jwk = await crypto.subtle.exportKey( 'jwk', checkKey );
		const publicKey = new Uint8Array( [ 8, 1, 18, 32, ...base64url( jwk.x ) ] );
		const manifestKey = rawBase64( encodedPublicKey );
		if ( publicKey.length !== manifestKey.length || publicKey.some( ( value, i ) => value !== manifestKey[ i ] ) ) throw new Error( 'node.key does not match the signed world owner key' );
		privateKey = await crypto.subtle.importKey( 'pkcs8', pkcs8, { name: 'Ed25519' }, false, [ 'sign' ] );
	} finally { pkcs8.fill( 0 ); }
	keyBytes.fill( 0 );
	keyBytes = privateKey;
}

async function handleFrame( frame ) {
	if ( frame.type === 'host.challenge' ) {
		if ( ! frame.nonce || ! keyBytes || !( keyBytes instanceof CryptoKey ) ) throw new Error( 'Invalid gateway challenge or missing owner key' );
		const proofMessage = encoder.encode( `elsemesh.browser-host/1\n${worldId}\n${frame.nonce}` );
		const proof = await crypto.subtle.sign( 'Ed25519', keyBytes, proofMessage );
		socket.send( JSON.stringify( { type: 'host.register', worldId, document: activeDocument, proof: base64( proof ) } ) );
		return;
	}
	if ( frame.type === 'host.registered' && frame.worldId === worldId ) {
		status( `Hosting ${activeDocument.payload.title}` );
		heartbeat = setInterval( () => { if ( socket?.readyState === WebSocket.OPEN ) socket.send( JSON.stringify( { type: 'host.heartbeat', worldId } ) ); }, 15000 );
		return;
	}
	if ( frame.type === 'host.request' ) { await serveRequest( frame ); return; }
	if ( frame.type === 'error' ) throw new Error( frame.error || 'Gateway rejected browser host' );
	throw new Error( 'Unexpected browser-host gateway message' );
}

async function serveRequest( frame ) {
	const request = frame.request;
	if ( frame.worldId !== worldId || ! request || request.worldId !== worldId || request.type !== 'asset.get' || frame.requestId !== request.requestId ) throw new Error( 'Invalid gateway asset request' );
	const size = activeDocument.payload.assets.find( asset => asset.id === request.assetId )?.bytes;
	const file = profileFiles?.get( request.assetId );
	if ( ! file || ! Number.isSafeInteger( size ) || ! Number.isSafeInteger( request.offset ) || ! Number.isSafeInteger( request.length ) || request.offset < 0 || request.length < 1 || request.length > MAX_CHUNK || request.offset + request.length > size || file.size !== size ) throw new Error( 'Gateway requested an undeclared asset range' );
	const chunk = await file.slice( request.offset, request.offset + request.length ).arrayBuffer();
	socket.send( JSON.stringify( { type: 'host.response', worldId, requestId: frame.requestId, response: { type: 'asset.chunk', worldId, requestId: frame.requestId, assetId: request.assetId, offset: request.offset, total: size, chunk: base64( chunk ) } } ) );
}

let activeDocument = null;
function clearSecrets() { clearInterval( heartbeat ); heartbeat = null; profileFiles = null; if ( keyBytes instanceof Uint8Array ) keyBytes.fill( 0 ); keyBytes = null; }
self.onmessage = event => {
	if ( event.data?.type === 'stop' ) { stopped = true; clearSecrets(); socket?.close( 1000, 'host stopped' ); return; }
	if ( event.data?.type === 'start' ) { activeDocument = event.data.document; void start( event.data ); }
};
