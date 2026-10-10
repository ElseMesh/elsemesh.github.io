import { BoxGeometry, Group, Mesh } from '../engine/index.js';
import { standard } from '../materials/Materials.js';
import { loadGLB } from '../engine/loaders/GLTF.js';
import { SkinnedModel } from '../engine/render/Skinning.js';
import { AVATAR_STYLES, DEFAULT_APPEARANCE, validateAppearance, appearanceKey } from './AvatarAppearance.js';
import { avatarMaterialOptions, tintAvatar } from './AvatarMaterials.js';

const sources = new Map();
const LOD_FADE_SECONDS = 0.2;

function sourceFor(asset) {
	if (!sources.has(asset)) {
		const promise = loadGLB((import.meta.env?.BASE_URL || '/') + `models/characters/${asset}.glb`).catch(error => { sources.delete(asset); throw error; });
		sources.set(asset, promise);
	}
	return sources.get(asset);
}

function setAvatarFade(model, fade, outgoing) {
	for (const material of model?.materials || []) {
		const value = material.uniforms?.lodFade?.value;
		value?.set?.(fade, outgoing ? 1 : 0);
	}
}

function matchingAnimation(previous, model) {
	const current = previous?.current;
	const clip = current && model.clipNames().includes(current) ? current : 'idle';
	const oldLayer = previous?.layers?.find(layer => layer.target === 1 && layer.clip?.name === clip);
	const oldDuration = previous?.clipDuration?.(clip) || 0;
	const newDuration = model.clipDuration?.(clip) || 0;
	const phase = oldLayer && oldDuration > 0 && newDuration > 0 ? (oldLayer.time % oldDuration) / oldDuration : 0;
	return { clip, from: phase * newDuration };
}
export function avatarTriangles(source) {
	return source.meshes.reduce((total, primitives) => total + primitives.reduce((sum, p) => sum + (p.indices ? p.indices.length : p.attributes.POSITION.array.length / 3) / 3, 0), 0);
}

// Assets are selected exclusively by the validated stock-style allowlist.
export class RemoteAvatar {
	constructor({ appearance = DEFAULT_APPEARANCE, maxComplexity = 20000, loadSource = sourceFor, createModel = (source, options) => SkinnedModel.create(source, options) } = {}) {
		if (!Number.isInteger(maxComplexity) || maxComplexity < 1 || maxComplexity > 100000) throw new Error('Invalid avatar complexity');
		this.group = new Group(); this.group.name = 'Remote_player_avatar';
		this.maxComplexity = maxComplexity; this.loadSource = loadSource; this.createModel = createModel;
		this.version = 0; this.disposed = false; this.lod = 0; this.model = null; this.transition = null;
		this.fallbackMaterial = standard({ name: 'Remote_avatar_fallback', color: 0x7194aa, roughness: .9 });
		this.fallback = new Mesh(new BoxGeometry(.45, 1.7, .3), this.fallbackMaterial);
		this.fallback.position.y = .85; this.fallback.visible = maxComplexity >= 12;
		this.group.add(this.fallback);
		this.setAppearance(appearance);
	}
	setAppearance(appearance = DEFAULT_APPEARANCE) {
		validateAppearance(appearance);
		if (this.disposed) return Promise.resolve();
		const key = appearanceKey(appearance) + `|lod:${this.lod}`;
		if (key === this.appearanceId) return this.ready;
		if (key === this.failedKey && Date.now() < this.retryAfter) return this.ready;
		this.appearanceId = key; this.appearance = { ...appearance };
		const asset = AVATAR_STYLES[appearance.style].asset + ['', '-medium', '-low'][this.lod];
		if (asset === this.asset) {
			if (this.model) tintAvatar(this.model, this.appearance);
			if (this.transition?.outgoing) tintAvatar(this.transition.outgoing, this.appearance);
			return this.ready;
		}
		this.asset = asset;
		const version = ++this.version;
		this.ready = this.loadCharacter(asset, version).catch(error => {
			if (!this.disposed && version === this.version) { this.asset = null; this.appearanceId = null; this.error = error; this.failedKey = key; this.retryAfter = Date.now() + 5000; }
			return false;
		});
		return this.ready;
	}
	// Hysteresis keeps small camera movements from repeatedly rebuilding meshes.
	setViewDistance(distance, loadBias = 0) {
		if (!Number.isFinite(distance) || distance < 0 || this.disposed) return;
		// Keep nearby faces/body at full detail even during sustained overload.
		const bias = Number.isFinite(loadBias) ? Math.max(0, Math.min(2, loadBias)) : 0;
		distance *= 2 ** (bias * Math.min(1, Math.max(0, (distance - 8) / 10)));
		let next = distance <= 8 ? 0 : this.lod;
		if (next === 0 && distance > 18) next = 1;
		if (next === 1 && distance > 45) next = 2;
		if (next === 2 && distance < 38) next = 1;
		if (next === 1 && distance < 14) next = 0;
		if (next !== this.lod) { this.lod = next; this.setAppearance(this.appearance); }
	}
	async loadCharacter(asset, version) {
		const source = await this.loadSource(asset);
		if (this.disposed || version !== this.version) return false;
		if (avatarTriangles(source) > this.maxComplexity) {
			if (!this.model) this.fallback.visible = this.maxComplexity >= 12;
			return false;
		}
		const model = await this.createModel(source, { materials: avatarMaterialOptions });
		if (this.disposed || version !== this.version) { model.dispose(); return false; }
		try {
			for (const clip of ['idle', 'walk', 'run', 'helm']) if (!model.clipNames().includes(clip)) throw new Error(`Missing character clip: ${clip}`);
			tintAvatar(model, this.appearance);
			const animation = matchingAnimation(this.model, model);
			model.play(animation.clip, { fade: .01, from: animation.from });
			model.update(0);
		} catch (error) { model.dispose(); throw error; }
		this.finishTransition();
		const previous = this.model;
		this.model = model;
		this.group.add(model.group);
		this.fallback.visible = false; this.error = null; this.failedKey = null;
		if (previous) {
			this.transition = { outgoing: previous, elapsed: 0 };
			setAvatarFade(previous, 0, true);
			setAvatarFade(model, 0, false);
		} else setAvatarFade(model, 1, false);
		return true;
	}
	finishTransition() {
		if (!this.transition) return;
		const { outgoing } = this.transition;
		this.transition = null;
		outgoing.group.parent?.remove(outgoing.group);
		outgoing.dispose();
		setAvatarFade(this.model, 1, false);
	}
	update(dt, pose) {
		if (this.disposed || !pose) return;
		this.setAppearance(pose.appearance);
		const speed = this.previous && dt > 0 ? Math.hypot(pose.position[0] - this.previous[0], pose.position[2] - this.previous[2]) / dt : 0;
		this.previous = [...pose.position];
		this.group.position.set(...pose.position); this.group.rotation.y = pose.yaw + Math.PI;
		const clip = pose.mode === 'boat' ? 'helm' : pose.moving ? (speed > 4.3 ? 'run' : 'walk') : 'idle';
		for (const model of [this.model, this.transition?.outgoing]) {
			if (!model) continue;
			if (model.current !== clip) model.play(clip, { fade: .2 });
			model.update(dt);
		}
		if (this.transition) {
			this.transition.elapsed += Math.max(0, dt);
			const fade = Math.min(1, this.transition.elapsed / LOD_FADE_SECONDS);
			setAvatarFade(this.transition.outgoing, fade, true);
			setAvatarFade(this.model, fade, false);
			if (fade >= 1) this.finishTransition();
		}
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true; ++this.version; this.group.parent?.remove(this.group);
		this.model?.dispose(); this.transition?.outgoing.dispose(); this.transition = null;
		this.fallback.geometry.dispose(); this.fallbackMaterial.dispose();
	}
}
