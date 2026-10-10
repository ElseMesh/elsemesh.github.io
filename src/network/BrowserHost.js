export const MAX_BROWSER_HOST_BYTES = 512 * 1024 * 1024;

export function browserHostSocketURL( gateway ) {
	const url = new URL( gateway );
	if ( url.protocol === 'https:' ) url.protocol = 'wss:';
	else if ( url.protocol === 'http:' && [ 'localhost', '127.0.0.1', '[::1]' ].includes( url.hostname ) ) url.protocol = 'ws:';
	else if ( url.protocol !== 'wss:' && ! ( url.protocol === 'ws:' && [ 'localhost', '127.0.0.1', '[::1]' ].includes( url.hostname ) ) ) throw new Error( 'Browser hosting requires an HTTPS/WSS gateway (HTTP is allowed only on localhost)' );
	url.pathname = '/browser-host';
	url.search = '';
	url.hash = '';
	return url.href;
}

export async function readBrowserWorldProfile( directory ) {
	const manifestFile = await directory.getFileHandle( 'world.json' ).then( handle => handle.getFile() );
	const keyFile = await directory.getFileHandle( 'node.key' ).then( handle => handle.getFile() );
	const manifest = JSON.parse( await manifestFile.text() );
	if ( manifest?.protocol !== 'tidewater.world/1' || ! manifest.payload || typeof manifest.payload.worldId !== 'string' || ! Array.isArray( manifest.payload.assets ) ) throw new Error( 'Selected directory does not contain a signed ElseMesh world profile' );
	const assetsDirectory = await directory.getDirectoryHandle( 'assets' );
	const files = new Map();
	let total = 0;
	for await ( const [ name, handle ] of assetsDirectory.entries() ) {
		if ( handle.kind !== 'file' || ! /^[0-9a-f]{64}$/.test( name ) ) continue;
		const file = await handle.getFile();
		total += file.size;
		if ( total > MAX_BROWSER_HOST_BYTES ) throw new Error( 'This browser-host profile exceeds the 512 MiB safety limit' );
		files.set( `sha256:${name}`, file );
	}
	return { document: manifest, key: await keyFile.arrayBuffer(), files };
}

export async function pickBrowserWorldProfile() {
	if ( window.showDirectoryPicker ) return readBrowserWorldProfile( await window.showDirectoryPicker( { mode: 'read' } ) );
	const input = document.createElement( 'input' );
	input.type = 'file'; input.multiple = true; input.setAttribute( 'webkitdirectory', '' ); input.hidden = true;
	document.body.append( input );
	try {
		const selected = await new Promise( ( resolve, reject ) => {
			input.addEventListener( 'change', () => resolve( [ ...input.files ] ), { once: true } );
			input.addEventListener( 'cancel', () => reject( new DOMException( 'Profile selection cancelled', 'AbortError' ) ), { once: true } );
			input.click();
		} );
		const byPath = new Map( selected.map( file => [ file.webkitRelativePath.split( '/' ).slice( 1 ).join( '/' ), file ] ) );
		const manifestFile = byPath.get( 'world.json' ), keyFile = byPath.get( 'node.key' );
		if ( ! manifestFile || ! keyFile ) throw new Error( 'Selected directory must contain world.json and node.key' );
		const manifest = JSON.parse( await manifestFile.text() );
		if ( manifest?.protocol !== 'tidewater.world/1' || ! manifest.payload || typeof manifest.payload.worldId !== 'string' || ! Array.isArray( manifest.payload.assets ) ) throw new Error( 'Selected directory does not contain a signed ElseMesh world profile' );
		const files = new Map(); let total = 0;
		for ( const [ name, file ] of byPath ) {
			const match = /^assets\/([0-9a-f]{64})$/.exec( name );
			if ( ! match ) continue;
			total += file.size;
			if ( total > MAX_BROWSER_HOST_BYTES ) throw new Error( 'This browser-host profile exceeds the 512 MiB safety limit' );
			files.set( `sha256:${match[ 1 ]}`, file );
		}
		return { document: manifest, key: await keyFile.arrayBuffer(), files };
	} finally { input.remove(); }
}

export function createBrowserHostWorker( { document, key, files, gateway, onStatus } ) {
	const worker = new Worker( new URL( './BrowserHostWorker.js', import.meta.url ), { type: 'module' } );
	worker.onmessage = ( event ) => {
		const message = event.data;
		if ( message?.type === 'status' ) onStatus?.( message.status );
		else if ( message?.type === 'error' ) onStatus?.( `Error: ${message.message}` );
	};
	worker.onerror = ( event ) => onStatus?.( `Error: ${event.message || 'Browser host worker failed'}` );
	worker.postMessage( { type: 'start', document, key, files: [ ...files ], gateway }, [ key ] );
	return { stop: () => { worker.postMessage( { type: 'stop' } ); worker.terminate(); }, worker };
}
