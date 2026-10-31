export function sweptCollisionCellKeys( from, to, { cellSizeMeters, radius = 0.3, height = 1.75 } = {} ) {
	if ( ! Number.isInteger( cellSizeMeters ) || cellSizeMeters < 1 || cellSizeMeters > 256 || ! Number.isFinite( radius ) || radius < 0 || ! Number.isFinite( height ) || height <= 0 ) throw new TypeError( 'Invalid collision frontier dimensions' );
	const start = vectorValues( from ), end = vectorValues( to );
	const distance = Math.hypot( end[ 0 ] - start[ 0 ], end[ 1 ] - start[ 1 ], end[ 2 ] - start[ 2 ] );
	const spacing = Math.min( cellSizeMeters / 4, Math.max( radius, 0.25 ) );
	const sampleCount = Math.max( 1, Math.ceil( distance / spacing ) );
	if ( sampleCount > 10000 ) throw new RangeError( 'Movement step exceeds collision frontier limits' );
	const cells = new Set();
	for ( let sample = 0; sample <= sampleCount; sample ++ ) {
		const t = sample / sampleCount;
		const x = start[ 0 ] + ( end[ 0 ] - start[ 0 ] ) * t;
		const y = start[ 1 ] + ( end[ 1 ] - start[ 1 ] ) * t;
		const z = start[ 2 ] + ( end[ 2 ] - start[ 2 ] ) * t;
		for ( let cellX = Math.floor( ( x - radius ) / cellSizeMeters ); cellX <= Math.floor( ( x + radius ) / cellSizeMeters ); cellX ++ ) {
			for ( let cellY = Math.floor( y / cellSizeMeters ); cellY <= Math.floor( ( y + height ) / cellSizeMeters ); cellY ++ ) {
				for ( let cellZ = Math.floor( ( z - radius ) / cellSizeMeters ); cellZ <= Math.floor( ( z + radius ) / cellSizeMeters ); cellZ ++ ) cells.add( `${cellX},${cellY},${cellZ}` );
			}
		}
	}
	return cells;
}

export function collisionPathReady( { from, to, cellSizeMeters, radius = 0.3, height = 1.75, objectIDsByCell, loadedObjectIDs, unknownObjectIDs, emptyCellsAreVerified = false } ) {
	if ( ! objectIDsByCell || ! loadedObjectIDs ) return false;
	for ( const cellKey of sweptCollisionCellKeys( from, to, { cellSizeMeters, radius, height } ) ) {
		const objectIDs = objectIDsByCell.get( cellKey );
		if ( ! objectIDs?.size ) {
			if ( emptyCellsAreVerified ) continue;
			return false;
		}
		for ( const objectID of objectIDs ) {
			if ( unknownObjectIDs?.has( objectID ) ) return false;
			if ( ! loadedObjectIDs.has( objectID ) ) return false;
		}
	}
	return true;
}

export function collisionLookaheadDistance( speedMetersPerSecond, latencyMs, cellSizeMeters, maxDistance = 512 ) {
	if ( ! Number.isFinite( speedMetersPerSecond ) || speedMetersPerSecond < 0 || ! Number.isFinite( latencyMs ) || latencyMs < 0 || ! Number.isInteger( cellSizeMeters ) || cellSizeMeters < 1 || ! Number.isFinite( maxDistance ) || maxDistance < cellSizeMeters ) throw new TypeError( 'Invalid collision lookahead inputs' );
	return Math.min( maxDistance, speedMetersPerSecond * Math.max( 400, latencyMs ) / 1000 + cellSizeMeters * 2 );
}

function vectorValues( value ) {
	const result = Array.isArray( value ) ? value : [ value?.x, value?.y, value?.z ];
	if ( result.length !== 3 || ! result.every( Number.isFinite ) ) throw new TypeError( 'Collision frontier positions must contain three finite coordinates' );
	return result;
}
