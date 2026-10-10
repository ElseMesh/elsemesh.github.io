import { GPU } from './gpu/GPU.js';
import { PerspectiveCamera } from './scene/Camera.js';
import { Scene } from './scene/Scene.js';
import { Timer } from './math/Timer.js';
import { MeshRenderer } from './render/MeshRenderer.js';
import { FrameUniforms } from './render/Frame.js';
import { selectBackend } from './Backend.js';

// Canvas, device, main camera / scene and the frame loop.
export class Engine {

	constructor( container ) {

		this.container = container;
		this.renderScale = 1;
		this.clock = new Timer();
		this.frame = 0;
		this.onResize = [];
		this.backend = 'webgpu';

	}

	async init() {

		const canvas = document.createElement( 'canvas' );
		canvas.tabIndex = 0;
		this.container.appendChild( canvas );
		this.canvas = canvas;
		this.domElement = canvas;
		const result = await selectBackend( {
			initWebGPU: () => GPU.init( { canvas } ),
			initWebGL: async () => {

				// A canvas that attempted to acquire a WebGPU context cannot later be
				// used for WebGL, so give the fallback a fresh canvas.
				canvas.remove();
				const { default: THREE } = await import( 'three' );
				const webglCanvas = document.createElement( 'canvas' );
				webglCanvas.tabIndex = 0;
				this.renderer = new THREE.WebGLRenderer( { canvas: webglCanvas, antialias: true, powerPreference: 'high-performance' } );
				this.renderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, 1.5 ) );
				this.container.appendChild( webglCanvas );
				this.canvas = this.domElement = webglCanvas;
				this.THREE = THREE;

			},
		} );
		this.backend = result.backend;
		this.fallbackReason = result.fallbackReason;
		if ( this.backend === 'webgl' ) return this;
		this.meshRenderer = new MeshRenderer();
		this.meshRenderer.syncPipelines = false; // compile in the background (App.precompile waits for them)
		this.camera = new PerspectiveCamera( 62, window.innerWidth / window.innerHeight, 0.06, 60000 );
		this.scene = new Scene();
		window.addEventListener( 'resize', () => this.resize() );
		this.resize();

	}

	setRenderScale( s ) {

		this.renderScale = s;
		this.resize();

	}

	// output (canvas) size in pixels
	get width() {

		return this.canvas.width;

	}

	get height() {

		return this.canvas.height;

	}

	resize() {

		const w = window.innerWidth, h = window.innerHeight;
		const dpr = this.renderScale;
		this.canvas.width = Math.max( 1, Math.floor( w * dpr ) );
		this.canvas.height = Math.max( 1, Math.floor( h * dpr ) );
		this.canvas.style.width = w + 'px';
		this.canvas.style.height = h + 'px';
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		FrameUniforms.fields.outputResolution.value.set( this.canvas.width, this.canvas.height );
		for ( const f of this.onResize ) f( w, h );

	}

	// the canvas texture of this frame (render target of the final post pass)
	currentTexture() {

		return GPU.context.getCurrentTexture();

	}

	start( update, maxFps = 0 ) {

		this.maxFps = Math.max( 0, Number( maxFps ) || 0 );
		let pendingDt = 0;
		let nextFrame = null;
		const loop = ( t ) => {

			this.clock.update( t );
			pendingDt += this.clock.getDelta();
			const frameInterval = this.maxFps > 0 ? 1000 / this.maxFps : 0;
			if ( ! frameInterval || nextFrame === null || t >= nextFrame ) {

				const dt = Math.min( pendingDt, 0.1 );
				pendingDt = 0;
				if ( frameInterval ) {

					if ( nextFrame === null ) nextFrame = t + frameInterval;
					else {

						nextFrame += frameInterval;
						if ( nextFrame <= t ) nextFrame += ( Math.floor( ( t - nextFrame ) / frameInterval ) + 1 ) * frameInterval;

					}

				} else nextFrame = t;
				this.frame ++;
				update( dt, this.clock.getElapsed() );

			}
			this._raf = requestAnimationFrame( loop );

		};

		this._raf = requestAnimationFrame( loop );

	}

	setFrameRateLimit( maxFps = 0 ) {

		this.maxFps = Math.max( 0, Number( maxFps ) || 0 );

	}

	stop() {

		cancelAnimationFrame( this._raf );

	}

}
