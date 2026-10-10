import assert from 'node:assert/strict';
import { selectBackend } from '../src/engine/Backend.js';
import { loadThreeModule } from '../src/engine/Engine.js';

const three = await loadThreeModule();
assert.equal( typeof three.WebGLRenderer, 'function', 'the dynamically loaded Three.js namespace exposes the named renderer export' );

{
	let webgpuStarted = false;
	let webglStarted = false;
	const selected = await selectBackend( {
		forceWebGL: true,
		initWebGPU: async () => { webgpuStarted = true; },
		initWebGL: async () => { webglStarted = true; },
	} );
	assert.equal( webgpuStarted, false );
	assert.equal( webglStarted, true );
	assert.equal( selected.backend, 'webgl' );
}

{
	const selected = await selectBackend( { initWebGPU: async () => {}, initWebGL: async () => assert.fail( 'WebGL must not initialize when WebGPU succeeds' ) } );
	assert.deepEqual( selected, { backend: 'webgpu', fallbackReason: null } );
}

for ( const error of [ new Error( 'WebGPU unavailable' ), new Error( 'No adapter' ), new Error( 'Device creation failed' ) ] ) {
	let fallbackStarted = false;
	const selected = await selectBackend( {
		initWebGPU: async () => { throw error; },
		initWebGL: async () => { fallbackStarted = true; },
	} );
	assert.equal( fallbackStarted, true );
	assert.equal( selected.backend, 'webgl' );
	assert.equal( selected.fallbackReason, error.message );
}

await assert.rejects( selectBackend( {
	initWebGPU: async () => { throw new Error( 'WebGPU failed' ); },
	initWebGL: async () => { throw new Error( 'WebGL unavailable' ); },
} ), AggregateError );

console.log( 'webgl backend selection passed' );
