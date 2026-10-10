import assert from 'node:assert/strict';
import { Group, Vector3 } from '../src/engine/index.js';
import { BoatController } from '../src/player/BoatController.js';
import { WORLD } from '../src/world/WorldLayout.js';

function modelStub() {
	return {
		group: new Group(),
		hullSamples: [ { position: new Vector3(), area: 1, bottomY: - 1 } ],
		hydro: {},
	};
}

const query = { allocate: () => 1 };
const defaultBoat = new BoatController( { model: modelStub(), query } );
assert.deepEqual( defaultBoat.position.toArray(), WORLD.boatDock.position.toArray() );
assert.deepEqual( defaultBoat.mooring.anchor.toArray(), WORLD.boatDock.position.toArray() );
assert.equal( defaultBoat.homeHeading, WORLD.boatDock.heading );

const berth = new Vector3( 120, 2.5, - 48 );
const heading = 1.17;
const hostedBoat = new BoatController( { model: modelStub(), query, terrain: null, initialPosition: berth, initialHeading: heading } );
assert.deepEqual( hostedBoat.position.toArray(), berth.toArray() );
assert.deepEqual( hostedBoat.mooring.anchor.toArray(), berth.toArray() );
assert.equal( hostedBoat.mooring.heading, heading );

hostedBoat.position.set( 500, - 20, 500 );
hostedBoat.mooring.anchor.set( - 9, - 9, - 9 );
hostedBoat.reset();
assert.deepEqual( hostedBoat.position.toArray(), berth.toArray(), 'physics reset returns to this world’s berth' );
assert.deepEqual( hostedBoat.mooring.anchor.toArray(), berth.toArray(), 'physics reset restores this world’s mooring point' );
assert.equal( hostedBoat.mooring.heading, heading, 'physics reset restores this world’s mooring heading' );

hostedBoat.acceptTransfer( {
	position: new Vector3( 8, 1, - 3 ), quaternion: defaultBoat.quaternion.clone(), velocity: new Vector3( 0, 0, 12 ), angular: new Vector3( 0, 0, 0 ),
	throttle: 0.5, steer: - 0.2, rpm: 0.7, driven: true,
}, 6 );
assert.deepEqual( hostedBoat.position.toArray(), [ 8, 1, - 3 ], 'destination boat accepts the mapped position' );
assert.equal( hostedBoat.velocity.length(), 6, 'destination policy caps imported vehicle speed immediately' );
assert.equal( hostedBoat.driven, true, 'vehicle helm state survives transfer' );
assert.equal( hostedBoat.moored, false, 'a transferred vehicle is not reset to the destination berth' );

console.log( 'ok boat controller uses per-world berth while preserving the built-in island default' );
