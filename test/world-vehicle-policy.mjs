import assert from 'node:assert/strict';
import { BoatModel } from '../src/world/BoatModel.js';
import { DOWNEAST_BOAT_TRIANGLES } from '../src/network/WorldRules.js';

const model = new BoatModel();
try {
	assert.equal( model.triangleCount, DOWNEAST_BOAT_TRIANGLES, 'boat complexity contract matches the bundled Downeast model' );
} finally {
	model.dispose();
}

console.log( 'ok   bundled boat triangle count matches signed vehicle policy contract' );
