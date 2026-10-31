import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Builds run from a separate .build worktree whose per-worktree HEAD can lag
// behind the source checkout. Read HEAD from Git's common directory so the
// game stamp always identifies the source repository revision.
const commonGitDir = execFileSync( 'git', [ 'rev-parse', '--git-common-dir' ], { encoding: 'utf8' } ).trim();
const commitSha = execFileSync( 'git', [ '--git-dir', resolve( commonGitDir ), 'rev-parse', 'HEAD' ], { encoding: 'utf8' } ).trim();
if ( ! /^[\da-f]{40}$/i.test( commitSha ) ) throw new Error( 'Git HEAD must be a full 40-character commit SHA' );
const commitShort = commitSha.slice( 0, 8 ).toLowerCase();

const connectionLogPath = resolve( 'logs/browser-connections.jsonl' );
const defaultWorldModule = resolve( process.env.ELSEMESH_DEFAULT_WORLD_MODULE || 'worlds/default.js' );
const worldsPath = resolve( 'worlds' );
const configuredWorldProviderModules = process.env.ELSEMESH_WORLD_PROVIDER_MODULES;
const worldProviderModules = configuredWorldProviderModules === undefined
	? readdirSync( worldsPath, { withFileTypes: true } )
		.filter( entry => entry.isDirectory() && existsSync( resolve( worldsPath, entry.name, 'world-provider.js' ) ) )
		.map( entry => resolve( worldsPath, entry.name, 'world-provider.js' ) )
		.sort()
	: configuredWorldProviderModules.split( ',' ).map( module => resolve( module.trim() ) ).filter( Boolean );
const localWorldProvider = process.env.ELSEMESH_LOCAL_WORLD_PROVIDER || '';
const localWorldMap = process.env.ELSEMESH_LOCAL_WORLD_MAP || '';
const localWorldWaterEnabled = process.env.ELSEMESH_LOCAL_WORLD_WATER !== 'false';
if ( Boolean( localWorldProvider ) !== Boolean( localWorldMap ) ) throw new Error( 'ELSEMESH_LOCAL_WORLD_PROVIDER and ELSEMESH_LOCAL_WORLD_MAP must be configured together' );
if ( localWorldProvider ) {
	const provider = new URL( localWorldProvider );
	if ( ! [ 'http:', 'https:' ].includes( provider.protocol ) || ! [ 'localhost', '127.0.0.1', '[::1]' ].includes( provider.hostname ) || provider.username || provider.password || ! [ '', '/' ].includes( provider.pathname ) || provider.search || provider.hash ) throw new Error( 'ELSEMESH_LOCAL_WORLD_PROVIDER must be a loopback HTTP(S) origin' );
	if ( localWorldMap.length > 256 || ! /^[\w .()/-]+$/.test( localWorldMap ) ) throw new Error( 'ELSEMESH_LOCAL_WORLD_MAP is invalid' );
}

function defaultWorldBinding() {
	const id = '\0virtual:elsemesh-default-world';
	return {
		name: 'elsemesh-default-world-binding',
		resolveId( source ) { return source === 'virtual:elsemesh-default-world' ? id : null; },
		load( source ) {
			if ( source !== id ) return null;
			return `export { defaultWorldPackage } from ${ JSON.stringify( defaultWorldModule ) };`;
		},
	};
}

function worldProviderBinding() {
	const id = '\0virtual:elsemesh-world-providers';
	return {
		name: 'elsemesh-world-provider-binding',
		resolveId( source ) { return source === 'virtual:elsemesh-world-providers' ? id : null; },
		load( source ) {
			if ( source !== id ) return null;
			const imports = worldProviderModules.map( ( module, index ) => `import * as provider${index} from ${JSON.stringify( module )};` ).join( '\n' );
			const providers = worldProviderModules.map( ( _module, index ) => `provider${index}` ).join( ', ' );
			return `${imports}\nconst providers = [ ${providers} ];\nexport async function loadWorldProviders( manifest ) { for ( const provider of providers ) if ( await provider.supportsWorldManifest( manifest ) ) await provider.loadWorldProvider(); }`;
		},
	};
}

function connectionLog() {
	const middleware = ( req, res, next ) => {
		if ( req.method !== 'POST' || req.url !== '/__elsemesh/connection' ) return next();
		let body = '';
		req.setEncoding( 'utf8' );
		req.on( 'data', ( chunk ) => {
			body += chunk;
			if ( body.length > 16_384 ) req.destroy();
		} );
		req.on( 'end', async () => {
			try {
				const event = JSON.parse( body );
				if ( event?.type !== 'game-ready' || typeof event.connectionId !== 'string' || event.connectionId.length > 64 || ! event.settings || typeof event.settings !== 'object' ) {
					res.statusCode = 400;
					res.end( 'Invalid connection event' );
					return;
				}
				await mkdir( resolve( 'logs' ), { recursive: true } );
				await appendFile( connectionLogPath, JSON.stringify( { receivedAt: new Date().toISOString(), ...event } ) + '\n' );
				res.statusCode = 204;
				res.end();
			} catch {
				res.statusCode = 400;
				res.end( 'Invalid connection event' );
			}
		} );
	};
	return {
		name: 'elsemesh-browser-connection-log',
		configureServer( server ) { server.middlewares.use( middleware ); },
		configurePreviewServer( server ) { server.middlewares.use( middleware ); },
	};
}

function localWorldRuntimeConfig() {
	if ( ! localWorldProvider ) return null;
	const config = JSON.stringify( {
		localWorld: {
			provider: localWorldProvider,
			map: localWorldMap,
			environment: { water: { enabled: localWorldWaterEnabled } },
		},
	} );
	const serveConfig = ( req, res, next ) => {
		if ( req.method !== 'GET' && req.method !== 'HEAD' ) return next();
		if ( new URL( req.url, 'http://localhost' ).pathname !== '/elsemesh-config.js' ) return next();
		res.statusCode = 200;
		res.setHeader( 'Content-Type', 'text/javascript; charset=utf-8' );
		res.setHeader( 'Cache-Control', 'no-store' );
		res.end( `globalThis.ELSEMESH_CONFIG = Object.assign(globalThis.ELSEMESH_CONFIG || {}, ${config});` );
	};
	return {
		name: 'elsemesh-local-world-runtime-config',
		configureServer( server ) { server.middlewares.use( serveConfig ); },
		configurePreviewServer( server ) { server.middlewares.use( serveConfig ); },
	};
}

function worldPackageAssets() {
	const worldsPath = resolve( 'worlds' );
	return {
		name: 'elsemesh-world-package-assets',
		configureServer( server ) {
			server.middlewares.use( async ( req, res, next ) => {
				if ( req.method !== 'GET' && req.method !== 'HEAD' ) return next();
				const requestUrl = new URL( req.url, 'http://localhost' );
				// Vite uses ?url/?import for extensionless files in the JS module
				// graph; let its asset plugin produce the URL module.
				if ( requestUrl.searchParams.has( 'url' ) || requestUrl.searchParams.has( 'import' ) ) return next();
				const match = /^\/worlds\/([a-z\d_-]+)\/assets\/([a-f\d]{64})$/i.exec( requestUrl.pathname );
				if ( ! match ) return next();

				const assetPath = resolve( worldsPath, match[1], 'assets', match[2].toLowerCase() );
				let info;
				try {
					info = await stat( assetPath );
				} catch ( error ) {
					if ( error.code === 'ENOENT' ) return next();
					return next( error );
				}
				if ( ! info.isFile() ) return next();

				res.statusCode = 200;
				res.setHeader( 'Content-Type', 'application/octet-stream' );
				res.setHeader( 'Content-Length', info.size );
				res.setHeader( 'Cache-Control', 'no-cache' );
				if ( req.method === 'HEAD' ) return res.end();
				createReadStream( assetPath ).on( 'error', ( error ) => res.destroy( error ) ).pipe( res );
			} );
		},
	};
}

export default defineConfig( {
	// Relative asset paths let the client run at the GitHub Pages root and under a deployment subpath.
	base: './',
	// World package assets use extensionless, content-addressed filenames.
	assetsInclude: [ /\/assets\/[a-f\d]{64}$/i ],
	resolve: { preserveSymlinks: true },
	plugins: [ defaultWorldBinding(), worldProviderBinding(), connectionLog(), worldPackageAssets(), localWorldRuntimeConfig(), {
		name: 'elsemesh-build-commit',
		transformIndexHtml( html ) {
			if ( ! html.includes( '%ELSEMESH_COMMIT%' ) ) throw new Error( 'Build commit placeholder is missing from index.html' );
			return html.replaceAll( '%ELSEMESH_COMMIT%', commitShort );
		},
	} ],
	build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
	server: {
		port: 0,
		strictPort: true,
		host: '127.0.0.1',
		proxy: {
			'/api/world/manifest': 'http://127.0.0.1:5200',
			'/gateway': { target: 'ws://127.0.0.1:5200', ws: true },
		},
	},
	preview: {
		port: 0,
		strictPort: true,
	},
} );
