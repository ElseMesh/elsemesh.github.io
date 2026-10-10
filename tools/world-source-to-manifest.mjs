#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { validateWorldSource } from '../src/network/WorldSource.js';

function options(argv) {
	const result = {};
	for ( let i = 0; i < argv.length; i ++ ) {
		const key = argv[ i ];
		if ( ! [ '--source', '--owner', '--assets', '--out', '--version', '--discoverable', '--authority-epoch' ].includes( key ) || ! argv[ i + 1 ] ) throw new Error( `Invalid or incomplete option: ${key}` );
		result[ key.slice( 2 ) ] = argv[ ++ i ];
	}
	for ( const key of [ 'source', 'owner', 'assets', 'out' ] ) if ( ! result[ key ] ) throw new Error( `Missing --${key}` );
	return result;
}

async function main() {
	const args = options( process.argv.slice( 2 ) );
	const sourceBytes = await readFile( args.source );
	const source = validateWorldSource( JSON.parse( sourceBytes.toString( 'utf8' ) ) );
	const version = args.version === undefined ? 1 : Number( args.version );
	if ( ! Number.isSafeInteger( version ) || version < 1 ) throw new Error( '--version must be a positive integer' );
	const authorityEpoch = args[ 'authority-epoch' ] === undefined ? 1 : Number( args[ 'authority-epoch' ] );
	if ( ! Number.isSafeInteger( authorityEpoch ) || authorityEpoch < 1 ) throw new Error( '--authority-epoch must be a positive integer' );
	if ( args.discoverable !== undefined && ! [ 'true', 'false' ].includes( args.discoverable ) ) throw new Error( '--discoverable must be true or false' );
	if ( source.styleGuide.length > 512 ) throw new Error( 'styleGuide exceeds the runtime manifest limit of 512 characters' );
	const updatedAt = Date.parse( source.updatedAt );
	const validTimestamp = typeof source.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test( source.updatedAt ) && Number.isFinite( updatedAt );
	if ( ! validTimestamp ) throw new Error( 'source updatedAt must be a valid ISO date-time' );
	const assets = new Map();
	for ( const object of source.objects ) {
		if ( ! object.assetId ) throw new Error( `Object ${object.id} has no assetId; add/export its GLB and import it with worldd --import-asset` );
		for ( const id of [ object.assetId, ...( object.lods || [] ).map( ( level ) => level.assetId ) ] ) {
			let ref = assets.get( id );
			if ( ! ref ) {
				const assetPath = path.join( args.assets, id.slice( 'sha256:'.length ) );
				const info = await stat( assetPath );
				if ( ! info.isFile() || info.size > 2 * 1024 * 1024 * 1024 ) throw new Error( `Invalid or oversized asset ${id}` );
				const hasher = createHash( 'sha256' );
				for await ( const chunk of createReadStream( assetPath ) ) hasher.update( chunk );
				const digest = hasher.digest( 'hex' );
				if ( `sha256:${digest}` !== id ) throw new Error( `Hash mismatch for imported asset ${id}` );
				ref = { id, bytes: info.size, kind: 'glb', priority: 'background' };
				assets.set( id, ref );
			}
			const priority = object.priority || 'visible';
			if ( ! [ 'portal-preview', 'visible', 'nearby', 'background' ].includes( priority ) ) throw new Error( `Invalid stream priority on ${object.id}` );
			const rank = [ 'portal-preview', 'visible', 'nearby', 'background' ];
			if ( rank.indexOf( priority ) < rank.indexOf( ref.priority ) ) ref.priority = priority;
		}
	}
	for ( const component of source.components || [] ) {
		const priority = component.priority || 'portal-preview';
		const references = [
			...( component.placementAssetId ? [ { id: component.placementAssetId, kind: component.type === 'tidewater.static-reef/1' ? 'reef-placement/1' : 'vegetation-placement/1', limit: 16 * 1024 * 1024 } ] : [] ),
			...( component.dataAssetId ? [ { id: component.dataAssetId, kind: component.type === 'tidewater.village-materials/2' ? 'village-materials/1' : 'terrain-surface/1', limit: component.type === 'tidewater.village-materials/2' ? 64 * 1024 * 1024 : 128 * 1024 * 1024 } ] : [] ),
			...( component.beds || [] ).map( ( bed ) => ( { id: bed.assetId, kind: 'audio/ogg', limit: 16 * 1024 * 1024 } ) ),
		];
		for ( const { id, kind, limit } of references ) {
			let ref = assets.get( id );
			if ( ! ref ) {
				const assetPath = path.join( args.assets, id.slice( 'sha256:'.length ) );
				const info = await stat( assetPath );
				if ( ! info.isFile() || info.size < 1 || info.size > limit ) throw new Error( `Invalid or oversized component asset ${id}` );
				const hasher = createHash( 'sha256' );
				for await ( const chunk of createReadStream( assetPath ) ) hasher.update( chunk );
				if ( `sha256:${hasher.digest( 'hex' )}` !== id ) throw new Error( `Hash mismatch for component asset ${id}` );
				ref = { id, bytes: info.size, kind, priority };
				assets.set( id, ref );
			} else if ( ref.kind !== kind || ref.priority !== priority ) {
				throw new Error( `Component asset ${id} conflicts with another asset kind or streaming priority` );
			}
		}
	}
	if ( source.rules.maxPackageBytes !== undefined ) {
		const packageBytes = [ ...assets.values() ].reduce( ( total, asset ) => total + asset.bytes, 0 );
		if ( packageBytes > source.rules.maxPackageBytes ) throw new Error( `World package uses ${packageBytes} bytes, over its declared ${source.rules.maxPackageBytes}-byte budget` );
	}
	const manifest = {
		protocol: 'tidewater.world/1',
		worldId: source.worldId,
		sourceHash: `sha256:${createHash( 'sha256' ).update( sourceBytes ).digest( 'hex' )}`,
		ownerPeerId: args.owner,
		authorityPeerId: args.owner,
		authorityEpoch,
		discoverable: args.discoverable === 'true',
		version,
		title: source.title,
		...( source.experience === undefined ? {} : { experience: source.experience } ),
		...( source.spawn === undefined ? {} : { spawn: source.spawn } ),
		rules: { ...source.rules, styleGuide: source.styleGuide },
		assets: [ ...assets.values() ],
		objects: source.objects.map( ( { id, kind, label, assetId, priority, streamingBounds, transform, scale, collision, replacesObjectId, lods } ) => ( { id, kind, label, assetId, priority, streamingBounds, transform, scale, collision, replacesObjectId, lods } ) ),
		components: source.components || [],
		portals: source.portals,
		hosts: ( source.hosts || [] ).map( ( grant ) => ( { ...grant, scopes: [ ...grant.scopes ] } ) ),
		updatedAt: Math.floor( updatedAt / 1000 ),
	};
	await writeFile( args.out, `${JSON.stringify( manifest, null, 2 )}\n`, { flag: 'wx' } );
	console.log( `Wrote unsigned manifest for ${manifest.worldId} with ${manifest.objects.length} objects, ${manifest.portals.length} portals and ${manifest.assets.length} assets.` );
}

main().catch( ( error ) => { console.error( error.message ); process.exitCode = 1; } );
