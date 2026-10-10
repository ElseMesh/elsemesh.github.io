// Selects a rendering backend during device initialization only. Errors after this
// function returns belong to the selected backend and are not silently retried.
export async function selectBackend( { initWebGPU, initWebGL } ) {

	try {

		await initWebGPU();
		return { backend: 'webgpu', fallbackReason: null };

	} catch ( webgpuError ) {

		try {

			await initWebGL();
			return { backend: 'webgl', fallbackReason: webgpuError?.message || String( webgpuError ) };

		} catch ( webglError ) {

			throw new AggregateError( [ webgpuError, webglError ], `WebGPU initialization failed (${ webgpuError?.message || webgpuError }); WebGL fallback failed (${ webglError?.message || webglError })` );

		}

	}

}
