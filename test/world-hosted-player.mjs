import assert from 'node:assert/strict';
import { Vector3 } from '../src/engine/math/Vector3.js';
import { Quaternion } from '../src/engine/math/Quaternion.js';
import { Player } from '../src/player/Player.js';
import { App } from '../src/App.js';
import { mapPortalPlayerState, mapPortalVehicleState } from '../src/network/PortalHandoff.js';
import { Colliders } from '../src/world/Colliders.js';
import { keyboardLookDelta } from '../src/core/Input.js';

const positions = new Float32Array( 11 * 11 * 3 );
for ( let row = 0; row < 11; row ++ ) for ( let column = 0; column < 11; column ++ ) {
	const index = ( row * 11 + column ) * 3;
	positions[ index ] = column - 5;
	positions[ index + 1 ] = 0;
	positions[ index + 2 ] = row - 5;
}
const colliders = new Colliders();
colliders.addHeightfield( positions, 11, 11, { position: new Vector3(), scale: new Vector3( 1, 1, 1 ) } );
let axes = { x: 0, y: 1, sprint: 0 };
let jumpPressed = false;
const input = {
	consumeLook: () => ( { x: 0, y: 0 } ),
	moveAxes: () => axes,
	down: () => false,
	hit: ( key ) => key === 'Space' && jumpPressed,
};
const camera = { position: new Vector3(), quaternion: { setFromEuler() {} } };
const player = {
	camera, input, colliders, position: new Vector3(), velocity: new Vector3(),
	_previousPosition: new Vector3(),
	yaw: 0, pitch: 0, grounded: false, gravity: 9.81,
};
Object.setPrototypeOf( player, Player.prototype );
Player.prototype.setWorldRules.call( player, { gravity: 1, movement: { walkSpeed: 1.5, sprintSpeed: 4, jumpSpeed: 2.5 } } );
Player.prototype.setHostedWorldPose.call( player, new Vector3( 0, 1.62, 0 ), 0, 0 );
assert.equal( player.position.y, 0 );
for ( let frame = 0; frame < 60; frame ++ ) Player.prototype.updateHostedWorld.call( player, 1 / 60 );
assert.ok( player.position.z < -1, 'hosted first-person controller moves forward using keyboard axes' );
assert.equal( player.position.y, 0, 'hosted player remains grounded on the active world heightfield' );
assert.equal( player.grounded, true );
assert.ok( camera.position.z < -1, 'camera follows the hosted player' );
assert.ok( Math.abs( player.velocity.z + 1.5 ) < 0.01, 'hosted walk speed follows the signed world rule' );
axes = { x: 0, y: 1, sprint: 1 };
for ( let frame = 0; frame < 60; frame ++ ) Player.prototype.updateHostedWorld.call( player, 1 / 60 );
assert.ok( Math.abs( player.velocity.z + 4 ) < 0.01, 'hosted sprint speed follows the signed world rule' );
Player.prototype.setHostedWorldPose.call( player, new Vector3( 0, 1.62, 0 ), 0, 0 );
player.grounded = true;
jumpPressed = true;
Player.prototype.updateHostedWorld.call( player, 1 / 60 );
assert.ok( player.velocity.y > 2.3 && player.velocity.y < 2.5, 'hosted jump impulse follows the signed world rule' );

// The ocean spawn used to expose this: hosted swimmers returned before consuming look.
// Exercise real swimming physics with combined mouse/arrow input while moving forward.
const swimPlayer = Object.assign( Object.create( Player.prototype ), {
	camera: { position: new Vector3( 0, 0.1, 0 ), quaternion: new Quaternion() },
	input: { ...input }, colliders: new Colliders(), position: new Vector3( 0, - 1, 0 ),
	velocity: new Vector3(), yaw: 0, pitch: 0, mode: 'swim', hostedSeaLevel: 0,
	waterH: 0, waterMean: 0, floating: true, stepDist: 0, wasUnder: false,
} );
let consumed = 0;
const arrowLook = keyboardLookDelta( new Set( [ 'ArrowRight', 'ArrowUp' ] ), 1 / 60, 260 );
const swimLook = { x: arrowLook.x + 12, y: arrowLook.y - 8 };
swimPlayer.input.consumeLook = () => { consumed ++; return swimLook; };
axes = { x: 0, y: 1, sprint: 0 };
swimPlayer.updateHostedWorld( 1 / 60 );
assert.equal( consumed, 1, 'hosted swimming consumes mouse and arrow look once per frame' );
assert.equal( swimPlayer.yaw, - swimLook.x * 0.0022 );
assert.equal( swimPlayer.pitch, - swimLook.y * 0.0022 );
assert.notEqual( swimPlayer.camera.quaternion.y, 0, 'hosted swimming rotates the actual camera' );
assert.ok( swimPlayer.velocity.z < 0, 'hosted swimmer can move and change view simultaneously' );

const boatDeck = { center: new Vector3( 0, 1, 0 ), half: new Vector3( 2, 0.1, 4 ), walkable: true, solid: true };
const hostedBoat = {
	position: new Vector3(), velocity: new Vector3(), quaternion: new Quaternion(), driven: false, moored: true,
	model: { colliders: [ boatDeck ], boardPoint: new Vector3(), lines: { deckY: 1.1 }, helmPosition: new Vector3() },
	getYaw: () => 0,
	toWorld( local, out ) { return out.copy( local ).applyQuaternion( this.quaternion ).add( this.position ); },
};
player.boat = hostedBoat;
player.deckPos = new Vector3();
player.deckVel = new Vector3();
player.deckYaw = 0;
player._ashore = null;
player._ashoreT = 0;
player._camY = null;
player.helmYaw = 0;
player.helmPitch = 0;
player.camMode = 'first';
player.audio = null;
player.mode = 'walk';
player.position.set( 0, 0.9, 0 );
player.velocity.set( 0, -5, 0 );
assert.equal( Player.prototype.landOnBoat.call( player, new Vector3( 0, 1.3, 0 ), player.position ), true, 'descending hosted player lands on the boat deck' );
assert.equal( player.mode, 'deck', 'boat contact automatically boards the player without a separate board action' );
assert.ok( Math.abs( player.position.y - 1.1 ) < 1e-9, 'landing snaps the player feet to the deck surface' );
hostedBoat.position.y = 0.45;
Player.prototype.deckToWorld.call( player );
assert.ok( Math.abs( player.position.y - 1.55 ) < 1e-9, 'deck-local player pose follows boat heave' );
Player.prototype.takeHelm.call( player );
assert.equal( player.mode, 'boat', 'the player can take the helm from the deck' );
assert.equal( hostedBoat.driven, true, 'taking the helm activates the hosted boat controller' );
// Exercise the actual application handoff, then a destination physics frame.
// This catches missing vertical velocity becoming NaN after the portal swap.
globalThis.location = { href: 'http://127.0.0.1:5189/?worldId=tw-world:source' };
globalThis.history = { replaceState( state, title, url ) { globalThis.location.href = url.href; } };
globalThis.document = { title: '' };
player.boat = null;
player.mode = 'walk';
player.yaw = 0.7;
player.pitch = - 0.2;
player.camera.position.set( 2.4, 4.1, - 7.2 );
player.velocity.set( 1, 4.6, - 3 );
const handoffPortal = { entry: { position: [ 2, 3, - 7 ], yaw: - 0.4 }, exit: { position: [ - 10, 5, 20 ], yaw: 1.2 } };
const expected = mapPortalPlayerState( { position: camera.position, velocity: player.velocity, yaw: player.yaw, pitch: player.pitch }, handoffPortal.entry, handoffPortal.exit );
let sourceClosed = false;
const destination = { worldId: 'tw-world:destination', nodeId: '1234567890123456789012345', gateway: 'http://127.0.0.1:5193', manifest: { title: 'Destination', components: [], rules: { gravity: 0.5 } } };
const app = Object.assign( Object.create( App.prototype ), {
	player, camera, worldConnector: { worldId: 'tw-world:source', close() { sourceClosed = true; } },
	linkedWorldRoot: { userData: {} }, hostedColliders: new Colliders(), hostedQuery: {}, hostedPlayerSlot: 0,
	scene: { remove() {}, add() {} }, worldBackgroundLoads: new Map(), remoteWorlds: new Map(),
	portalPreviousPosition: new Vector3(), portalPreparations: new Map(), streamWorldRemainder() {}, startWorldPresence() {},
} );
app.enterWorldPortal( handoffPortal, { connector: destination, root: { userData: { worldComponents: [] } } } );
assert.ok( camera.position.distanceTo( expected.position ) < 1e-9, 'application handoff preserves the mapped camera position' );
assert.equal( player.yaw, expected.yaw );
assert.equal( player.pitch, expected.pitch );
assert.equal( player.velocity.y, 4.6, 'application retains jump momentum after resetting destination pose' );
assert.ok( Math.hypot( player.velocity.x - expected.velocity.x, player.velocity.z - expected.velocity.z ) < 1e-9 );
assert.equal( player.gravity, 9.81 * 0.5, 'destination signed gravity applies after arrival' );
assert.equal( sourceClosed, true, 'handoff closes the old connection' );
assert.equal( app.worldConnector, destination );
assert.equal( new URL( location.href ).searchParams.get( 'worldId' ), destination.worldId );
axes = { x: 0, y: 0, sprint: 0 };
jumpPressed = false;
player.updateHostedWorld( 1 / 60 );
assert.ok( [ ...player.position.toArray(), ...player.velocity.toArray(), ...camera.position.toArray() ].every( Number.isFinite ), 'first destination frame keeps all motion and camera coordinates finite' );
assert.ok( Math.abs( player.velocity.y - ( 4.6 - 9.81 * 0.5 / 60 ) ) < 1e-9, 'destination physics continues the jump with its own gravity' );

const vehicleModel = { traverse( visit ) { visit( { isMesh: true, geometry: { attributes: { position: { count: 300 } }, drawRange: { start: 0, count: Infinity } } } ); } };
const vehicleGate = Object.assign( Object.create( App.prototype ), {
	player: { mode: 'boat' }, activeHostedBoat: { boat: { controller: {}, model: { group: vehicleModel } } },
} );
const acceptingWorld = { manifest: { rules: { avatarComplexity: 200, vehiclePolicy: { enabled: true, maxSpeed: 8, maxCombinedComplexity: 500 } }, components: [ { type: 'tidewater.downeast-boat/1' } ] } };
assert.deepEqual( vehicleGate.vehicleTransferStatus( acceptingWorld ), { allowed: true, maxSpeed: 8 }, 'destination accepts a vehicle within the combined triangle budget' );
acceptingWorld.manifest.rules.vehiclePolicy.maxCombinedComplexity = 299;
assert.equal( vehicleGate.vehicleTransferStatus( acceptingWorld ).allowed, false, 'destination denies a vehicle above the combined triangle budget' );
acceptingWorld.manifest.rules.vehiclePolicy.maxCombinedComplexity = 500;
acceptingWorld.manifest.components = [];
assert.equal( vehicleGate.vehicleTransferStatus( acceptingWorld ).allowed, false, 'destination denies transfer without a compatible boat berth' );

const vehiclePlayer = Object.assign( Object.create( Player.prototype ), {
	camera: { position: new Vector3( 0, 2, 0 ), quaternion: new Quaternion() }, colliders,
	position: new Vector3(), velocity: new Vector3( 0, 0, 3 ), yaw: 0.4, pitch: 0.1, mode: 'boat',
	deckPos: new Vector3( 1, 0, 2 ), deckYaw: 0.2, audio: null,
} );
const sourceVehicleController = {
	transferState: () => ( { position: new Vector3( 2, 1, 3 ), quaternion: new Quaternion(), velocity: new Vector3( 0, 0, 7 ), angular: new Vector3( 0, 0.2, 0 ), throttle: 0.6, steer: 0.1, rpm: 0.7, driven: true } ),
	driven: true, throttle: 0.6, throttleTarget: 0.6, steer: 0.1, _acc: 0,
};
vehiclePlayer.boat = sourceVehicleController;
let acceptedVehicleState;
let appliedVehicleLimit;
const destinationBoatController = {
	setMaxSpeed: ( speed ) => { appliedVehicleLimit = speed; },
	acceptTransfer: ( state, speed ) => { acceptedVehicleState = state; appliedVehicleLimit = speed; },
};
const sourceBoatRuntime = { boat: { controller: sourceVehicleController }, deactivate() {} };
const destinationBoatRuntime = { hostedBoat: true, boat: { controller: destinationBoatController }, activate() { return destinationBoatController; }, deactivate() {} };
const vehicleSourceConnector = { worldId: 'tw-world:vehicle-source', close() {} };
const vehicleDestination = {
	worldId: 'tw-world:vehicle-destination', nodeId: '1234567890123456789012345', gateway: 'http://127.0.0.1:5193',
	manifest: { title: 'Vehicle destination', components: [ { type: 'tidewater.downeast-boat/1' } ], rules: { gravity: 1, avatarComplexity: 200, vehiclePolicy: { enabled: true, maxSpeed: 6, maxCombinedComplexity: 1000 } } },
};
const vehiclePortalApp = Object.assign( Object.create( App.prototype ), {
	player: vehiclePlayer, camera: vehiclePlayer.camera, worldConnector: vehicleSourceConnector, activeHostedBoat: sourceBoatRuntime,
	linkedWorldRoot: { userData: {} }, hostedColliders: colliders, hostedQuery: {}, hostedPlayerSlot: 0,
	scene: { remove() {}, add() {} }, worldBackgroundLoads: new Map(), remoteWorlds: new Map(), portalPreviousPosition: new Vector3(),
	portalPreparations: new Map(), streamWorldRemainder() {}, startWorldPresence() {},
} );
const vehicleDestinationRoot = { userData: { worldComponents: [ destinationBoatRuntime ] } };
const expectedVehicleState = mapPortalVehicleState( sourceVehicleController.transferState(), handoffPortal.entry, handoffPortal.exit );
vehiclePortalApp.enterWorldPortal( handoffPortal, { connector: vehicleDestination, root: vehicleDestinationRoot } );
assert.equal( vehiclePlayer.mode, 'boat', 'helm mode survives destination activation' );
assert.equal( vehiclePlayer.boat, destinationBoatController, 'player reattaches to the destination boat controller' );
assert.ok( acceptedVehicleState.position.distanceTo( expectedVehicleState.position ) < 1e-9, 'destination boat receives the transformed origin' );
assert.ok( acceptedVehicleState.quaternion.angleTo( expectedVehicleState.quaternion ) < 1e-9, 'destination boat receives the transformed orientation' );
assert.ok( Math.abs( acceptedVehicleState.velocity.length() - 7 ) < 1e-9, 'handoff preserves vehicle speed before destination policy is applied' );
assert.equal( appliedVehicleLimit, 6, 'destination speed limit reaches the transferred boat controller' );
console.log( 'ok   hosted first-person movement uses only active world colliders' );
