import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

class MockWebSocket {
	static OPEN = 1;
	constructor( url ) {
		this.url = url;
		this.readyState = 0;
		this.sent = [];
		MockWebSocket.last = this;
		queueMicrotask( () => { this.readyState = MockWebSocket.OPEN; this.onopen?.(); } );
	}
	send( value ) { this.sent.push( JSON.parse( value ) ); }
	receive( frame ) { this.onmessage?.( { data: JSON.stringify( frame ) } ); }
	close() { this.readyState = 3; this.onclose?.(); }
}

const waitFor = async ( predicate, message ) => {
	const until = Date.now() + 5000;
	while ( Date.now() < until ) {
		if ( predicate() ) return;
		await new Promise( resolve => setTimeout( resolve, 10 ) );
	}
	assert.fail( message );
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
	await writeFile( sourcePath, `${JSON.stringify( source, null, 2 )}\n` );
	const ownerID = run( worldd, [ '--worlds-dir', worldsDir, '--world-profile', profile, '--print-node-id' ] );
	run( process.execPath, [ path.join( root, 'tools/world-source-to-manifest.mjs' ), '--source', sourcePath, '--owner', ownerID, '--assets', path.join( profileDir, 'assets' ), '--out', unsignedPath ] );
	run( worldd, [ '--worlds-dir', worldsDir, '--world-profile', profile, '--sign-manifest', unsignedPath, '--manifest-out', manifestPath ] );
	const document = JSON.parse( await readFile( manifestPath, 'utf8' ) );
	const key = await readFile( path.join( profileDir, 'node.key' ) );
	const cleanKey = Uint8Array.from( key );
	const fileMap = new Map( [ [ assetID, new File( [ assetBytes ], assetID ) ] ] );
	const originalWebSocket = globalThis.WebSocket;
	const originalSelf = globalThis.self;
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let heartbeatCallback = null;
	const messages = [];
	globalThis.WebSocket = MockWebSocket;
	globalThis.setInterval = callback => { heartbeatCallback = callback; return 1; };
	globalThis.clearInterval = () => { heartbeatCallback = null; };
	globalThis.self = globalThis;
	globalThis.self.postMessage = message => messages.push( message );
	try {
		await import( `../src/network/BrowserHostWorker.js?test=${Date.now()}` );
		globalThis.self.onmessage( { data: { type: 'start', document, key: cleanKey.slice().buffer, files: [ ...fileMap ], gateway: 'https://gateway.example.test' } } );
		await waitFor( () => MockWebSocket.last, 'worker did not open its gateway socket' );
		const socket = MockWebSocket.last;
		assert.equal( socket.url, 'wss://gateway.example.test/browser-host' );
		socket.receive( { type: 'host.challenge', nonce: Buffer.alloc( 32, 7 ).toString( 'base64url' ) } );
		await waitFor( () => socket.sent.some( frame => frame.type === 'host.register' ), 'worker did not register after the gateway challenge' );
		const registration = socket.sent.find( frame => frame.type === 'host.register' );
		const protobufPublicKey = Buffer.from( document.publicKey, 'base64' );
		const publicKey = createPublicKey( { key: Buffer.concat( [ Buffer.from( '302a300506032b6570032100', 'hex' ), protobufPublicKey.subarray( 4 ) ] ), format: 'der', type: 'spki' } );
		const proofMessage = Buffer.from( `elsemesh.browser-host/1\n${document.payload.worldId}\n${Buffer.alloc( 32, 7 ).toString( 'base64url' )}` );
		assert.equal( verify( null, proofMessage, publicKey, Buffer.from( registration.proof, 'base64' ) ), true, 'registration proof must verify with the signed world owner key' );
		assert.equal( registration.document.signer, document.signer );
		assert.equal( Object.hasOwn( registration, 'key' ), false, 'the gateway registration must not contain the owner private key' );
		socket.receive( { type: 'host.registered', worldId: document.payload.worldId } );
		await waitFor( () => messages.some( message => message.status === `Hosting ${document.payload.title}` ), 'worker did not enter the hosting state' );
		assert.equal( typeof heartbeatCallback, 'function', 'worker must start a heartbeat after registration' );
		heartbeatCallback();
		assert.ok( socket.sent.some( frame => frame.type === 'host.heartbeat' && frame.worldId === document.payload.worldId ), 'worker must heartbeat its registered world' );
		socket.receive( { type: 'host.request', worldId: document.payload.worldId, requestId: 'asset-request-1', request: { type: 'asset.get', worldId: document.payload.worldId, requestId: 'asset-request-1', assetId: assetID, offset: 0, length: assetBytes.length } } );
		await waitFor( () => socket.sent.some( frame => frame.type === 'host.response' ), 'worker did not answer the declared asset request' );
		const response = socket.sent.find( frame => frame.type === 'host.response' );
		assert.equal( Buffer.from( response.response.chunk, 'base64' ).compare( assetBytes ), 0 );
		assert.equal( response.response.assetId, assetID );
		assert.equal( response.response.total, assetBytes.length );
		globalThis.self.onmessage( { data: { type: 'stop' } } );
	} finally {
		MockWebSocket.last?.close();
		globalThis.WebSocket = originalWebSocket;
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		if ( originalSelf === undefined ) delete globalThis.self;
		else globalThis.self = originalSelf;
	}
	console.log( 'Browser-host profile validation, challenge proof, heartbeat registration, and asset response passed' );
} finally {
	await rm( tempRoot, { recursive: true, force: true } );
}
