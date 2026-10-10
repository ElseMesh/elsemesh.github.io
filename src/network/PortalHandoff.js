import { Matrix4, Quaternion, Vector3, Vector4 } from '../engine/math/index.js';

const _up = new Vector3( 0, 1, 0 );
const _entry = new Vector3();
const _exit = new Vector3();
const _portalRotation = new Quaternion();
const _portalPlane = new Vector4();
const _portalFarCorner = new Vector4();
const _transpose = new Matrix4();

// Open portal previews render at a bounded rate, so advance their self-contained
// component animations by the time between preview renders without simulating a
// long hidden-tab pause in one large step.
export function updatePortalPreviewComponents(components, now, lastRenderedAt, camera) {
	const elapsed = Number.isFinite( lastRenderedAt ) ? ( now - lastRenderedAt ) / 1000 : 0;
	const dt = Number.isFinite( elapsed ) ? Math.min( 0.1, Math.max( 0, elapsed ) ) : 0;
	for ( const component of components || [] ) component.update?.( dt, camera );
	return dt;
}

const backRoutes = new WeakMap();

// A physical opening has a front route and an optional independently configured
// back route. Legacy portals retain only their authored front connection.
export function portalRouteFromPosition( portal, position ) {
	if ( ! portal?.entry?.position || ! Number.isFinite( portal.entry.yaw ) ) return null;
	const [ x, , z ] = portal.entry.position;
	if ( localZ( position.x, position.z, x, z, portal.entry.yaw ) >= 0 ) return portal.enabled ? portal : null;
	if ( ! portal.back?.enabled ) return null;
	let route = backRoutes.get( portal );
	if ( ! route ) {
		route = {
			id: portal.id, connectionKey: `${portal.id}#back`, side: 'back',
			...portal.back,
			entry: { position: [ ...portal.entry.position ], yaw: portal.entry.yaw + Math.PI },
		};
		backRoutes.set( portal, route );
	}
	return route;
}

// Portal entries face local -Z. Only a front-to-back crossing inside the opening transfers worlds.
export function crossedPortalPlane( previous, current, portal, { halfWidth = 1.25, halfHeight = 2.5 } = {} ) {
	const entry = portal?.entry;
	if ( ! entry?.position || ! Number.isFinite( entry.yaw ) ) return false;
	const [ x, y, z ] = entry.position;
	const beforeZ = localZ( previous.x, previous.z, x, z, entry.yaw );
	const afterZ = localZ( current.x, current.z, x, z, entry.yaw );
	const afterX = localX( current.x, current.z, x, z, entry.yaw );
	return beforeZ > 0 && afterZ <= 0 && Math.abs( afterX ) <= halfWidth && Math.abs( current.y - y ) <= halfHeight;
}

export function rotatePortalVelocity( velocity, entryYaw, exitYaw ) {
	const yaw = exitYaw - entryYaw;
	const cos = Math.cos( yaw ), sin = Math.sin( yaw );
	return { x: velocity.x * cos + velocity.z * sin, y: velocity.y ?? 0, z: - velocity.x * sin + velocity.z * cos };
}

// Carry the built-in vehicle's rigid-body state through the same yaw-only
// transform as the player. Vehicle portability is a destination opt-in.
export function mapPortalVehicleState( state, entry, exit ) {
	const yawDelta = exit.yaw - entry.yaw;
	const rotation = new Quaternion().setFromAxisAngle( _up, yawDelta );
	return {
		position: new Vector3().copy( state.position ).sub( new Vector3().fromArray( entry.position ) ).applyAxisAngle( _up, yawDelta ).add( new Vector3().fromArray( exit.position ) ),
		quaternion: rotation.multiply( state.quaternion.clone() ).normalize(),
		velocity: new Vector3( state.velocity.x, state.velocity.y, state.velocity.z ).applyAxisAngle( _up, yawDelta ),
		angular: new Vector3( state.angular.x, state.angular.y, state.angular.z ).applyAxisAngle( _up, yawDelta ),
	};
}

// Preserve the visitor's offset and view through the same rigid transform used
// for the open doorway camera. Destination rules apply to subsequent physics;
// the crossing itself preserves world-space momentum, including a jump or fall.
export function mapPortalPlayerState( state, entry, exit ) {
	const yawDelta = exit.yaw - entry.yaw;
	const position = new Vector3().copy( state.position )
		.sub( new Vector3().fromArray( entry.position ) )
		.applyAxisAngle( _up, yawDelta )
		.add( new Vector3().fromArray( exit.position ) );
	return {
		position,
		velocity: rotatePortalVelocity( state.velocity, entry.yaw, exit.yaw ),
		yaw: state.yaw + yawDelta,
		pitch: state.pitch,
	};
}

// Place destination-world geometry so its signed exit transform meets the local entry.
export function alignPortalPreview( root, entry, exit ) {
	const yaw = entry.yaw - exit.yaw;
	const cos = Math.cos( yaw ), sin = Math.sin( yaw );
	const [ x, y, z ] = exit.position;
	const rotatedX = x * cos + z * sin;
	const rotatedZ = - x * sin + z * cos;
	root.rotation.y = yaw;
	root.position.set( entry.position[ 0 ] - rotatedX, entry.position[ 1 ] - y, entry.position[ 2 ] - rotatedZ );
	return root;
}

// Map the visitor's view through the opening into destination coordinates.
export function mapPortalCamera( sourceCamera, destinationCamera, entry, exit ) {
	const yaw = exit.yaw - entry.yaw;
	_entry.fromArray( entry.position );
	_exit.fromArray( exit.position );
	destinationCamera.position.copy( sourceCamera.position ).sub( _entry ).applyAxisAngle( _up, yaw ).add( _exit );
	_portalRotation.setFromAxisAngle( _up, yaw );
	destinationCamera.quaternion.copy( _portalRotation ).multiply( sourceCamera.quaternion );
	destinationCamera.fov = sourceCamera.fov;
	destinationCamera.near = sourceCamera.near;
	destinationCamera.far = sourceCamera.far;
	destinationCamera.aspect = 0.5;
	destinationCamera.updateProjectionMatrix();
	destinationCamera.updateMatrixWorld( true );
	destinationCamera.userData.portalObliqueClipApplied = applyPortalObliqueClip( destinationCamera, portalExitClipPlane( exit ) );
	return destinationCamera;
}

// Move the reversed-depth WebGPU near plane onto the portal exit plane. Plane
// distances are positive on the virtual-camera side; retain only the destination
// side. A false return leaves the regular projection intact for shader clipping.
export function applyPortalObliqueClip( camera, worldPlane ) {
	const [ x, y, z, w ] = worldPlane;
	_portalPlane.set( x, y, z, w ).applyMatrix4( _transpose.copy( camera.matrixWorld ).transpose() );
	if ( ! [ _portalPlane.x, _portalPlane.y, _portalPlane.z, _portalPlane.w ].every( Number.isFinite ) ) return false;

	// WebGPU reversed depth places the far plane at clip-space z = 0.
	_portalFarCorner.set( Math.sign( _portalPlane.x ) || 1, Math.sign( _portalPlane.y ) || 1, 0, 1 ).applyMatrix4( camera.projectionMatrixInverse );
	const denominator = _portalPlane.dot( _portalFarCorner );
	if ( ! Number.isFinite( denominator ) || denominator >= - 1e-7 ) return false;
	const scale = 1 / denominator;
	const plane = _portalPlane;
	const e = camera.projectionMatrix.elements;
	// Row 3 = row 4 - plane / dot(plane, farCorner). With reversed depth,
	// the near clip inequality is w - z >= 0, which keeps plane distance <= 0.
	e[ 2 ] = e[ 3 ] - plane.x * scale;
	e[ 6 ] = e[ 7 ] - plane.y * scale;
	e[ 10 ] = e[ 11 ] - plane.z * scale;
	e[ 14 ] = e[ 15 ] - plane.w * scale;
	camera.projectionMatrixInverse.copy( camera.projectionMatrix ).invert();
	return true;
}

// Plane normal points toward the source-side of the exit. Portal rendering discards
// fragments with positive signed distance so only content beyond the threshold shows.
export function portalExitClipPlane( exit ) {
	const nx = Math.sin( exit.yaw ), nz = Math.cos( exit.yaw );
	const [ x, , z ] = exit.position;
	return [ nx, 0, nz, - nx * x - nz * z ];
}

function localX( x, z, originX, originZ, yaw ) {
	const dx = x - originX, dz = z - originZ;
	return dx * Math.cos( yaw ) - dz * Math.sin( yaw );
}

function localZ( x, z, originX, originZ, yaw ) {
	const dx = x - originX, dz = z - originZ;
	return dx * Math.sin( yaw ) + dz * Math.cos( yaw );
}
