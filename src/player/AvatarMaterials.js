import { Color, Vector2 } from '../engine/index.js';
import { lodFadeModule } from '../materials/LODFade.js';
const linear = hex => new Color(parseInt(hex.slice(1),16));
export function avatarMaterialOptions({ name }) {
	const options = {
		modules: [ lodFadeModule ],
		uniforms: { lodFade: [ 'vec2f', new Vector2( 1, 0 ) ] },
		surface: 'if ( ! lodFadeVisible( in.pixel, mat.lodFade.x, mat.lodFade.y > 0.5 ) ) { discard; }',
		shadow: 'return lodFadeVisible( in.pixel, mat.lodFade.x, mat.lodFade.y > 0.5 );',
	};
	if (!['body','head','opacity'].includes(name)) return options;
	options.uniforms = {
		...options.uniforms,
		...Object.fromEntries(['shirt','trousers','skin','hair'].map(k => [k,['vec3f',new Color(1,1,1)]])),
	};
	options.surface += name === 'opacity' ? `
			let detail = clamp(dot(s.albedo,vec3f(0.2126,0.7152,0.0722)) * 4.0,0.12,1.8);
			s.albedo = mat.hair * detail;
			s.roughness = 0.9; s.specularIntensity = 0.15;
		` : `
			let zone = i32(round(orm.r * 5.0));
			let lightness = dot(s.albedo,vec3f(0.2126,0.7152,0.0722));
			if (zone == 1) { s.albedo = mat.shirt * clamp(lightness * 3.0,0.12,1.7); }
			if (zone == 2) { s.albedo = mat.trousers * clamp(lightness * 12.0,0.1,1.8); }
			if (zone == 3) { s.albedo = mat.skin * clamp(lightness * 3.0,0.06,1.5); }
			if (zone == 4) { s.albedo = mat.hair * clamp(lightness * 5.0,0.08,1.8); s.roughness = 0.9; s.specularIntensity = 0.15; }
		`;
	return options;
}
export function tintAvatar(model, appearance) {
	for (const material of model.materials) for (const k of ['shirt','trousers','skin','hair']) {
		if (material.uniforms[k]) material.uniforms[k].value = linear(appearance[k]);
	}
}
