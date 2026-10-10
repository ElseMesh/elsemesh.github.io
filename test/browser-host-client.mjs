import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserHostSocketURL } from '../src/network/BrowserHost.js';
import { createWorldSource } from '../src/network/WorldSource.js';

assert.equal( browserHostSocketURL( 'https://gateway.example.test/base?x=1' ), 'wss://gateway.example.test/browser-host' );
assert.equal( browserHostSocketURL( 'http://localhost:5189' ), 'ws://localhost:5189/browser-host' );
assert.equal( browserHostSocketURL( 'ws://127.0.0.1:5200' ), 'ws://127.0.0.1:5200/browser-host' );
assert.throws( () => browserHostSocketURL( 'http://gateway.example.test' ), /HTTPS\/WSS/ );
assert.throws( () => browserHostSocketURL( 'ws://gateway.example.test' ), /HTTPS\/WSS/ );

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const tempRoot = await mkdtemp( path.join( '/var/tmp', 'elsemesh-browser-host-' ) );
const worldd = path.join( tempRoot, 'thruholdd-test' );
const worldsDir = path.join( tempRoot, 'worlds' );
const profile = 'browser-host-test';
const profileDir = path.join( worldsDir, profile );
const processes = [];
const assetBytes = Buffer.from( 'browser-host-worker-verified-asset' );
const assetID = `sha256:${createHash( 'sha256' ).update( assetBytes ).digest( 'hex' )}`;
const source = createWorldSource( { worldId: 'tw-world:browser-host-worker-test', title: 'Browser host worker test' } );
source.objects.push( {
	id: 'tw-object:browser-host-asset', kind: 'asset-instance', label: 'Host test asset', assetId: assetID,
	priority: 'visible', transform: { position: [ 0, 0, 0 ], yaw: 0 }, scale: [ 1, 1, 1 ],
	collision: { shape: 'none', enabled: false },
} );

const run = ( command, args, options = {} ) => {
	const result = spawnSync( command, args, { encoding: 'utf8', timeout: 180000, ...options } );
	assert.equal( result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}` );
	return result.stdout.trim();
};

class ObservedWebSocket extends globalThis.WebSocket {
	static sockets = [];
	constructor( url ) {
		super( url );
		this.sent = [];
		this.frames = [];
		this.addEventListener( 'message', event => this.frames.push( JSON.parse( event.data ) ) );
		ObservedWebSocket.last = this;
		ObservedWebSocket.sockets.push( this );
	}
	send( value ) {
		if ( typeof value === 'string' ) this.sent.push( JSON.parse( value ) );
		return super.send( value );
	}
}

const waitFor = async ( predicate, message ) => {
	const until = Date.now() + 15000;
	while ( Date.now() < until ) {
		if ( await predicate() ) return;
		await new Promise( resolve => setTimeout( resolve, 10 ) );
	}
	assert.fail( message );
};

const waitForHTTP = async ( url, child ) => waitFor( async () => {
	if ( child.exitCode !== null ) assert.fail( `worldd exited before readiness:\n${child.output}` );
	try { return ( await fetch( url, { signal: AbortSignal.timeout( 1000 ) } ) ).ok; }
	catch { return false; }
}, `${url} readiness` );

const waitForFrame = async ( socket, predicate, message ) => {
	await waitFor( () => socket.frames.some( predicate ), message );
	const index = socket.frames.findIndex( predicate );
	return socket.frames.splice( index, 1 )[ 0 ];
};

const unusedPort = async () => {
	const server = net.createServer();
	await new Promise( ( resolve, reject ) => server.listen( 0, '127.0.0.1', resolve ).once( 'error', reject ) );
	const { port } = server.address();
	await new Promise( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
	return port;
};

const startDaemon = ( binary, args ) => {
	const child = spawn( binary, args, { stdio: [ 'ignore', 'pipe', 'pipe' ] } );
	child.output = '';
	child.stdout.setEncoding( 'utf8' ).on( 'data', value => { child.output += value; } );
	child.stderr.setEncoding( 'utf8' ).on( 'data', value => { child.output += value; } );
	processes.push( child );
	return child;
};

const stopDaemon = async child => {
	if ( ! child || child.exitCode !== null ) return;
	await new Promise( resolve => {
		const timer = setTimeout( resolve, 5000 );
		child.once( 'exit', () => { clearTimeout( timer ); resolve(); } );
		child.kill( 'SIGTERM' );
	} );
	if ( child.exitCode === null ) {
		child.kill( 'SIGKILL' );
		await new Promise( resolve => child.once( 'exit', resolve ) );
	}
};

try {
	const built = spawnSync( 'go', [ 'build', '-o', worldd, '.' ], { cwd: path.join( root, 'server/worldd' ), encoding: 'utf8', timeout: 180000 } );
	assert.equal( built.status, 0, `worldd build failed:\n${built.stdout}\n${built.stderr}` );
	await mkdir( path.join( profileDir, 'assets' ), { recursive: true } );
	const assetPath = path.join( profileDir, 'assets', assetID.slice( 'sha256:'.length ) );
	await writeFile( assetPath, assetBytes );
	const sourcePath = path.join( tempRoot, 'world-source.json' );
	const unsignedPath = path.join( tempRoot, 'world-unsigned.json' );
	const manifestPath = path.join( tempRoot, 'world.json' );
	const httpPort = await unusedPort();
	const p2pPort = await unusedPort();
	await writeFile( sourcePath, `${JSON.stringify( source, null, 2 )}\n` );
	const ownerID = run( worldd, [ '--worlds-dir', worldsDir, '--world-profile', profile, '--print-node-id' ] );
	run( process.execPath, [ path.join( root, 'tools/world-source-to-manifest.mjs' ), '--source', sourcePath, '--owner', ownerID, '--assets', path.join( profileDir, 'assets' ), '--out', unsignedPath ] );
	run( worldd, [ '--worlds-dir', worldsDir, '--world-profile', profile, '--sign-manifest', unsignedPath, '--manifest-out', manifestPath ] );
	const document = JSON.parse( await readFile( manifestPath, 'utf8' ) );
	const key = await readFile( path.join( profileDir, 'node.key' ) );
	const cleanKey = Uint8Array.from( key );
	const fileMap = new Map( [ [ assetID, new File( [ assetBytes ], assetID ) ] ] );
	const daemon = startDaemon( worldd, [ '--worlds-dir', worldsDir, '--world-profile', profile, '--manifest', manifestPath, '--p2p-port', String( p2pPort ), '--http', `127.0.0.1:${httpPort}`, '--dht-mode', 'client' ] );
	await waitForHTTP( `http://127.0.0.1:${httpPort}/healthz`, daemon );
	const originalWebSocket = globalThis.WebSocket;
	const originalSelf = globalThis.self;
	const originalPostMessage = globalThis.postMessage;
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let heartbeatCallback = null;
	const heartbeatToken = {};
	const messages = [];
	globalThis.WebSocket = ObservedWebSocket;
	globalThis.setInterval = ( callback, delay, ...args ) => {
		if ( delay === 15000 ) { heartbeatCallback = callback; return heartbeatToken; }
		return originalSetInterval( callback, delay, ...args );
	};
	globalThis.clearInterval = timer => {
		if ( timer === heartbeatToken ) { heartbeatCallback = null; return; }
		return originalClearInterval( timer );
	};
	globalThis.self = globalThis;
	globalThis.self.postMessage = message => messages.push( message );
	try {
		await import( `../src/network/BrowserHostWorker.js?test=${Date.now()}` );
		globalThis.self.onmessage( { data: { type: 'start', document, key: cleanKey.slice().buffer, files: [ ...fileMap ], gateway: `http://127.0.0.1:${httpPort}` } } );
		await waitFor( () => ObservedWebSocket.last, 'worker did not open its gateway socket' );
		const socket = ObservedWebSocket.last;
		assert.equal( socket.url, `ws://127.0.0.1:${httpPort}/browser-host` );
		const challenge = await waitForFrame( socket, frame => frame.type === 'host.challenge', 'worldd did not issue its browser-host challenge' );
		await waitFor( () => socket.sent.some( frame => frame.type === 'host.register' ), 'worker did not register after the gateway challenge' );
		const registration = socket.sent.find( frame => frame.type === 'host.register' );
		const protobufPublicKey = Buffer.from( document.publicKey, 'base64' );
		const publicKey = createPublicKey( { key: Buffer.concat( [ Buffer.from( '302a300506032b6570032100', 'hex' ), protobufPublicKey.subarray( 4 ) ] ), format: 'der', type: 'spki' } );
		const proofMessage = Buffer.from( `elsemesh.browser-host/1\n${document.payload.worldId}\n${challenge.nonce}` );
		assert.equal( verify( null, proofMessage, publicKey, Buffer.from( registration.proof, 'base64' ) ), true, 'registration proof must verify with the signed world owner key' );
		assert.equal( registration.document.signer, document.signer );
		assert.equal( Object.hasOwn( registration, 'key' ), false, 'the gateway registration must not contain the owner private key' );
		await waitForFrame( socket, frame => frame.type === 'host.registered', 'worldd rejected the worker registration' );
		await waitFor( () => messages.some( message => message.status === `Hosting ${document.payload.title}` ), 'worker did not enter the hosting state' );
		assert.equal( typeof heartbeatCallback, 'function', 'worker must start a heartbeat after registration' );
		heartbeatCallback();
		assert.ok( socket.sent.some( frame => frame.type === 'host.heartbeat' && frame.worldId === document.payload.worldId ), 'worker must heartbeat its registered world' );
		const visitor = new ObservedWebSocket( `ws://127.0.0.1:${httpPort}/gateway` );
		await waitFor( () => visitor.readyState === globalThis.WebSocket.OPEN, 'visitor gateway websocket did not open' );
		visitor.send( JSON.stringify( { type: 'connect', worldId: document.payload.worldId, targetPeerId: ownerID } ) );
		await waitForFrame( visitor, frame => frame.type === 'connected', 'gateway did not route the visitor to the browser-host session' );
		visitor.send( JSON.stringify( { type: 'manifest.get', worldId: document.payload.worldId, requestId: 'manifest-request-1' } ) );
		const manifestReply = await waitForFrame( visitor, frame => frame.requestId === 'manifest-request-1', 'visitor did not receive the hosted signed manifest' );
		assert.equal( manifestReply.type, 'manifest' );
		assert.equal( manifestReply.document.signature, document.signature );
		visitor.send( JSON.stringify( { type: 'asset.get', worldId: document.payload.worldId, requestId: 'asset-request-1', assetId: assetID, offset: 0, length: assetBytes.length } ) );
		const assetReply = await waitForFrame( visitor, frame => frame.requestId === 'asset-request-1', 'visitor did not receive the browser-hosted asset' );
		assert.equal( assetReply.type, 'asset.chunk' );
		assert.equal( Buffer.from( assetReply.chunk, 'base64' ).compare( assetBytes ), 0 );
		assert.equal( assetReply.assetId, assetID );
		assert.equal( assetReply.total, assetBytes.length );
		visitor.close();
		globalThis.self.onmessage( { data: { type: 'stop' } } );
	} finally {
		for ( const socket of ObservedWebSocket.sockets ) socket.close();
		globalThis.WebSocket = originalWebSocket;
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		if ( originalPostMessage === undefined ) delete globalThis.postMessage;
		else globalThis.postMessage = originalPostMessage;
		if ( originalSelf === undefined ) delete globalThis.self;
		else globalThis.self = originalSelf;
	}
	console.log( 'Browser-host worker registered with live worldd and served a signed manifest and verified asset through the visitor gateway' );
} finally {
	for ( const child of processes.reverse() ) await stopDaemon( child );
	await rm( tempRoot, { recursive: true, force: true } );
}
