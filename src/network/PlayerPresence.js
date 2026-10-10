import { validateAppearance } from '../player/AvatarAppearance.js';

export const PLAYER_PRESENCE_PROTOCOL = 'elsemesh.player-presence/2';
const LEGACY_PLAYER_PRESENCE_PROTOCOL = 'elsemesh.player-presence/1';
const playerID = /^player:[0-9a-f]{64}$/;
export function validatePresencePose(pose) {
	if (!pose || ![ PLAYER_PRESENCE_PROTOCOL, LEGACY_PLAYER_PRESENCE_PROTOCOL ].includes( pose.protocol ) || !Number.isSafeInteger(pose.sequence) || pose.sequence < 0) throw new Error('Invalid presence sequence or protocol');
	if (!Array.isArray(pose.position) || pose.position.length !== 3 || !pose.position.every(v => Number.isFinite(v) && Math.abs(v) <= 100000)) throw new Error('Invalid presence position');
	if (!Number.isFinite(pose.yaw) || Math.abs(pose.yaw) > 1000 || !Number.isFinite(pose.pitch) || Math.abs(pose.pitch) > 1.5 || typeof pose.moving !== 'boolean' || !['walk', 'swim', 'deck', 'boat'].includes(pose.mode)) throw new Error('Invalid presence orientation or mode');
	if ( pose.protocol === PLAYER_PRESENCE_PROTOCOL && ( pose.mode === 'boat' || pose.mode === 'deck' ) ) {
		if ( ! Number.isFinite( pose.vehicleSpeed ) || pose.vehicleSpeed < 0 || pose.vehicleSpeed > 100 ) throw new Error( 'Invalid presence vehicle speed' );
	} else if ( pose.protocol === PLAYER_PRESENCE_PROTOCOL && pose.vehicleSpeed !== undefined ) throw new Error( 'Unexpected presence vehicle speed' );
	validateAppearance(pose.appearance);
	return pose;
}

// One instance belongs to one transport session. Reset it on reconnect or handoff.
export class PlayerPresence {
	constructor(worldId, { interpolationMs = 100, staleMs = 1500 } = {}) {
		if (typeof worldId !== 'string' || !worldId || !Number.isFinite(interpolationMs) || interpolationMs <= 0 || !Number.isFinite(staleMs) || staleMs <= 0) throw new Error('Invalid presence configuration');
		this.worldId = worldId; this.interpolationMs = interpolationMs; this.staleMs = staleMs;
		this.reset();
	}
	reset() { this.playerId = null; this.players = new Map(); this.lastRequestId = null; }
	observe(snapshot, { requestId, now = performance.now() } = {}) {
		if (!snapshot || snapshot.type !== 'presence' || snapshot.worldId !== this.worldId || typeof requestId !== 'string' || snapshot.requestId !== requestId || !Number.isFinite(now) || !playerID.test(snapshot.playerId || '') || !Array.isArray(snapshot.players) || snapshot.players.length > 128) throw new Error('Invalid presence snapshot');
		if (this.playerId && snapshot.playerId !== this.playerId) throw new Error('Presence belongs to another session');
		if (requestId === this.lastRequestId) return false;
		const ids = new Set();
		for (const pose of snapshot.players) {
			validatePresencePose(pose);
			if (!playerID.test(pose.id || '') || ids.has(pose.id) || !Number.isSafeInteger(pose.updatedAt) || pose.updatedAt < 0) throw new Error('Invalid presence player');
			ids.add(pose.id);
		}
		this.playerId = snapshot.playerId; this.lastRequestId = requestId;
		for (const id of this.players.keys()) if (!ids.has(id)) this.players.delete(id);
		for (const pose of snapshot.players) {
			if (pose.id === this.playerId) continue;
			const old = this.players.get(pose.id);
			if (old && (pose.sequence <= old.pose.sequence || pose.updatedAt < old.pose.updatedAt)) continue;
			const copy = { ...pose, position: [...pose.position], appearance: { ...pose.appearance } };
			this.players.set(pose.id, { pose: copy, previous: old?.pose || copy, receivedAt: now });
		}
		return true;
	}
	interpolated(now = performance.now()) {
		const result = [];
		for (const { pose, previous, receivedAt } of this.players.values()) {
			if (now - receivedAt >= this.staleMs) continue;
			const t = Math.max(0, Math.min(1, (now - receivedAt) / this.interpolationMs));
			const yawDelta = Math.atan2(Math.sin(pose.yaw - previous.yaw), Math.cos(pose.yaw - previous.yaw));
			result.push({ ...pose, appearance: { ...pose.appearance }, position: pose.position.map((v, i) => previous.position[i] + (v - previous.position[i]) * t), yaw: previous.yaw + yawDelta * t, pitch: previous.pitch + (pose.pitch - previous.pitch) * t });
		}
		return result;
	}
}
