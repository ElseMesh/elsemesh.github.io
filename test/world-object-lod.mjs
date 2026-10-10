import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PerspectiveCamera } from '../src/engine/scene/Camera.js';
import { LODLoadQueue, WorldObjectLOD, selectObjectLOD } from '../src/network/WorldObjectLOD.js';
import { loadWorldPackage, updateWorldPackageLOD, disposeWorldPackage, registerWorldPackageCollisions } from '../src/network/WorldPackage.js';
import { Colliders } from '../src/world/Colliders.js';
import { GPU } from '../src/engine/gpu/GPU.js';
import { RenderTarget } from '../src/engine/gpu/Texture.js';
import { G, setFrameCamera } from '../src/engine/render/Frame.js';
import { MeshRenderer } from '../src/engine/render/MeshRenderer.js';
import { SunShadows } from '../src/engine/render/Shadows.js';
import { Scene } from '../src/engine/scene/Scene.js';
import { Vector3 } from '../src/engine/math/Vector3.js';
import { transformBoundsCenter } from '../src/network/WorldStreaming.js';

const camera = new PerspectiveCamera(60,1,.1,1000);
const object = {id:'tw-object:lod', kind:'asset-instance', label:'LOD fixture', assetId:'full', transform:{position:[0,0,-10],yaw:0},scale:[1,1,1], streamingBounds:{center:[0,0,0],radius:1}, collision:{enabled:true,shape:'box',center:[0,0,0],halfExtents:[1,1,1],walkable:true,solid:true},lods:[{assetId:'medium',maxScreenFraction:.12},{assetId:'low',maxScreenFraction:.04}]};
assert.equal(selectObjectLOD(object,camera),0);
camera.position.z = 20;
assert.equal(selectObjectLOD(object,camera),1);
camera.position.z = 60;
assert.equal(selectObjectLOD(object,camera),2);
camera.position.z = 4;
assert.equal(selectObjectLOD(object,camera,1),1,'Retain lower detail in hysteresis band');
camera.position.z = 0;
assert.equal(selectObjectLOD(object,camera,1),0);
let finish;
const shown = [];
const controller = new WorldObjectLOD({object,loadLevel: () => new Promise(resolve => {finish=resolve;}),showLevel: level => shown.push(level)});
camera.position.z = 60; controller.update(camera); await Promise.resolve();
camera.position.z = 0; controller.update(camera); finish(); await controller.pending.get(2);
assert.deepEqual(shown,[0],'Late distant download cannot change near view');
camera.position.z = 60; controller.update(camera); assert.equal(shown.at(-1),2);
controller.dispose(); controller.dispose(); assert.ok(controller.controller.signal.aborted);

const blends=[];let settled=0;
const reversible = new WorldObjectLOD({object,loadLevel:async()=>{},showLevel:level=>{settled=level;},showTransition:(from,to,fade)=>blends.push({from,to,fade})});
camera.position.z=60;reversible.update(camera,0);await reversible.pending.get(2);
reversible.update(camera,0);reversible.update(camera,100);
assert.equal(blends.at(-1).fade,.5,'A running LOD transition advances over time');
camera.position.z=0;reversible.update(camera,100);
assert.deepEqual(blends.at(-1),{from:2,to:0,fade:.5},'Camera reversal reverses the existing blend without a visual jump');
reversible.update(camera,200);assert.equal(blends.at(-1).fade,.75);
reversible.update(camera,300);assert.equal(settled,0,'Reversed transition settles on the full-detail level');
reversible.dispose();

// Texture-free real GLBs exercise package installation without a fake GPU.
function meshGLB(triangles) {
 const positions = new Float32Array(triangles * 9);
 for(let t=0;t<triangles;t++) positions.set([0,0,0,1,0,0,0,1,0],t*9);
 const json = {asset:{version:'2.0'},buffers:[{byteLength:positions.byteLength}],bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength}],accessors:[{bufferView:0,componentType:5126,count:positions.length/3,type:'VEC3'}],materials:[{alphaMode:'MASK',alphaCutoff:.5,pbrMetallicRoughness:{baseColorFactor:[.2,.4,.6,1]}}],meshes:[{primitives:[{attributes:{POSITION:0},material:0,mode:4}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0};
 const encoded = new TextEncoder().encode(JSON.stringify(json)); const padded = Math.ceil(encoded.length/4)*4;
 const buffer = new ArrayBuffer(12+8+padded+8+positions.byteLength); const view = new DataView(buffer);
 view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,buffer.byteLength,true);
 view.setUint32(12,padded,true);view.setUint32(16,0x4e4f534a,true);
 new Uint8Array(buffer,20,padded).fill(32);new Uint8Array(buffer,20,encoded.length).set(encoded);
 view.setUint32(20+padded,positions.byteLength,true);view.setUint32(24+padded,0x004e4942,true);
 new Uint8Array(buffer,28+padded).set(new Uint8Array(positions.buffer));return buffer;
}
const payloads = new Map([['full',meshGLB(8)],['medium',meshGLB(4)],['low',meshGLB(2)]]);
const requests=[];
const connector={worldId:'tw-world:lod',manifest:{objects:[object],portals:[]},getAsset:async id => {requests.push(id);return payloads.get(id);}};
const root = await loadWorldPackage(connector,{assets:new Map([['full',payloads.get('full')]])});
const instance=root.children[0]; const colliders = new Colliders(); registerWorldPackageCollisions(root,colliders);
const originalCollider=root.userData.worldPackage.activeColliders.get(object.id).collider;
function visibleTriangles(start = root) {
 let total=0; function visit(node) {if(!node.visible)return;if(node.isMesh)total+=node.geometry.getAttribute('position').count/3;for(const child of node.children)visit(child);}visit(start);return total;
}
assert.equal(visibleTriangles(),8);
let now=1000;
camera.position.z=60;updateWorldPackageLOD(root,camera,0,now);
await root.userData.worldPackage.lodControllers.get(object.id).pending.get(2);
updateWorldPackageLOD(root,camera,0,now);
assert.equal(visibleTriangles(),10,'Both full and low variants render while the screen-door transition starts'); assert.deepEqual(requests,['low'],'Far view loads desired variant directly');
const instanceMaterials=[]; instance.traverse(node=>{if(node.isMesh)instanceMaterials.push(node.material);});
assert.ok(instanceMaterials.every(material=>material.uniforms.lodFade),'Every object LOD material has an independent fade uniform');
const baseMaterial=instanceMaterials[0];
const lowMaterial=instanceMaterials.find(material=>material!==baseMaterial);
assert.equal(baseMaterial.uniforms.lodFade.value.y,1,'Outgoing base level uses the complementary mask');
assert.equal(lowMaterial.uniforms.lodFade.value.x,0,'Incoming low level starts invisible');
assert.equal(lowMaterial.uniforms.lodFade.value.y,0,'Incoming low level uses the complementary mask');
assert.equal(baseMaterial.modules.some(module=>module.name==='lodFade'),true,'Object material includes screen-door shader module');
now+=100;updateWorldPackageLOD(root,camera,0,now);
assert.equal(baseMaterial.uniforms.lodFade.value.x,.5,'Transition progresses smoothly');
now+=100;updateWorldPackageLOD(root,camera,0,now);
assert.equal(visibleTriangles(),2); assert.deepEqual(requests,['low'],'Far view loads desired variant directly');
assert.equal(root.children[0],instance,'Visual replacement preserves instance wrapper');
registerWorldPackageCollisions(root,colliders);
assert.equal(root.userData.worldPackage.activeColliders.get(object.id).collider,originalCollider,'LOD does not replace collision');
camera.position.z=0;now+=10;updateWorldPackageLOD(root,camera,0,now);assert.equal(visibleTriangles(),10,'Returning close cross-fades to the full-detail base');
now+=200;updateWorldPackageLOD(root,camera,0,now);assert.equal(visibleTriangles(),8);
const authoredWorld=JSON.parse(readFileSync(new URL('../worlds/island/world-source.json',import.meta.url)));
const boatObject=authoredWorld.objects.find(item=>item.id==='tw-object:moored-lobster-boat');
assert.ok(boatObject?.lods?.length===1,'checked-in moored boat has a packaged distance level');
const boatAsset=id=>readFileSync(new URL(`../worlds/island/assets/${id.slice(7)}`,import.meta.url));
const boatBaseBytes=boatAsset(boatObject.assetId),boatLowBytes=boatAsset(boatObject.lods[0].assetId);
const boatConnector={worldId:authoredWorld.worldId,manifest:{objects:[boatObject],portals:[]},getAsset:async id=>{assert.equal(id,boatObject.lods[0].assetId);return boatLowBytes;}};
const boatRoot=await loadWorldPackage(boatConnector,{assets:new Map([[boatObject.assetId,boatBaseBytes]])});
const boatCenter=transformBoundsCenter(boatObject,boatObject.streamingBounds.center,new Vector3());
const boatCamera=new PerspectiveCamera(55,1,.1,1000);boatCamera.position.copy(boatCenter).add(new Vector3(0,0,50));boatCamera.lookAt(boatCenter);
updateWorldPackageLOD(boatRoot,boatCamera,0,2000);
await boatRoot.userData.worldPackage.lodControllers.get(boatObject.id).pending.get(1);
updateWorldPackageLOD(boatRoot,boatCamera,0,2000);
assert.equal(boatRoot.userData.worldPackage.lodControllers.get(boatObject.id).transition?.to,1,'the packaged boat selects its distant level using transformed local bounds');
const portalCamera=new PerspectiveCamera(60,1,.1,1000);portalCamera.position.z=20;
updateWorldPackageLOD(root,portalCamera,0,now);await root.userData.worldPackage.lodControllers.get(object.id).pending.get(1);
updateWorldPackageLOD(root,portalCamera,0,now);assert.equal(visibleTriangles(),12,'Portal view cross-fades its independently selected detail');
now+=200;updateWorldPackageLOD(root,portalCamera,0,now);assert.equal(visibleTriangles(),4,'Independent camera selects its own detail');
updateWorldPackageLOD(root,camera,0,now);assert.equal(visibleTriangles(),12,'Main view restores its detail through a transition after preview');
now+=200;updateWorldPackageLOD(root,camera,0,now);assert.equal(visibleTriangles(),8);
// Sustained-load bias changes actual visible geometry using each render camera.
camera.position.z=0;
const adaptive=root.userData.worldPackage.lodControllers.get(object.id);
adaptive.update(camera,now,1);await adaptive.pending.get(1);
adaptive.update(camera,now,1);assert.equal(visibleTriangles(),12,'Load bias cross-fades toward reduced geometry');
now+=200;adaptive.update(camera,now,1);assert.equal(visibleTriangles(),4,'Load bias selects real reduced geometry');
adaptive.update(camera,now,0);assert.equal(visibleTriangles(),12,'Headroom restores original geometry through a transition');
now+=200;adaptive.update(camera,now,0);assert.equal(visibleTriangles(),8);
portalCamera.position.z=60;adaptive.update(portalCamera,now,2);
assert.equal(visibleTriangles(),10,'Mapped distant preview starts its own biased transition');
now+=200;adaptive.update(portalCamera,now,2);assert.equal(visibleTriangles(),2,'Mapped distant preview uses its own biased level');
camera.position.z=-7;adaptive.update(camera,now,2);
assert.equal(visibleTriangles(),10,'Large near view starts restoring full detail under maximum load');
now+=200;adaptive.update(camera,now,2);assert.equal(visibleTriangles(),8,'Large near view retains full detail under maximum load');
if(process.env.ELSEMESH_WORLD_OBJECT_LOD_RENDER==='1') {
 await import('./headless.mjs');
 await GPU.init({headless:true});
 const scene=new Scene();scene.add(root);
 root.traverse(node=>{if(node.isMesh)node.castShadow=true;});
 const renderCamera=new PerspectiveCamera(55,1,.1,1000);renderCamera.position.set(0,1,60);renderCamera.lookAt(0,0,-10);
 const renderLOD=root.userData.worldPackage.lodControllers.get(object.id);
 renderLOD.update(renderCamera,now+100,0);
 renderLOD.update(renderCamera,now+200,0);
 assert.ok(renderLOD.transition,'GPU smoke renders both variants during their transition');
 assert.equal(visibleTriangles(),10,'GPU smoke keeps complementary base and low variants visible together');
 G.sunDir.value.set(.5,.7,.3).normalize();G.sunColor.value.setRGB(3,2.9,2.7);G.skyIrradiance.value.setRGB(.25,.32,.45);
 const width=128,height=128;
 const target=new RenderTarget(width,height,{colors:['rgba16float','rgba16float','rgba8unorm'],depth:'depth32float',label:'object-lod-smoke'});
 const renderer=new MeshRenderer(),shadows=new SunShadows();
 GPU.device.pushErrorScope('validation');
 GPU.beginFrame();setFrameCamera(renderCamera,width,height);
 shadows.render(scene,renderer,shadows.update(renderCamera,G.sunDir.value));
 renderer.render(scene,{camera:renderCamera,kind:'main',colorViews:target.textures.map(texture=>texture.view()),colorFormats:target.formats,
  clearColors:[[.1,.15,.2,1],[0,0,0,0],[0,0,0,0]],depthView:target.depthTexture.view(),depthFormat:'depth32float',clearDepth:0});
 GPU.submit();await GPU.device.queue.onSubmittedWorkDone();
 const validationError=await GPU.device.popErrorScope();
 assert.equal(validationError,null,validationError?.message);
 assert.ok(renderer.stats.pipelines>=4,'World-object fade shaders compile for both visible levels and their color/shadow passes');
 console.log(`World-object LOD GPU smoke: ${renderer.stats.pipelines} pipelines, complementary masked GLB levels rendered`);
 const boatScene=new Scene();boatScene.add(boatRoot);boatRoot.traverse(node=>{if(node.isMesh)node.castShadow=true;});
 const boatRenderer=new MeshRenderer(),boatShadows=new SunShadows(),boatTarget=new RenderTarget(width,height,{colors:['rgba16float','rgba16float','rgba8unorm'],depth:'depth32float',label:'moored-boat-lod-smoke'});
 GPU.device.pushErrorScope('validation');
 GPU.beginFrame();setFrameCamera(boatCamera,width,height);
 boatShadows.render(boatScene,boatRenderer,boatShadows.update(boatCamera,G.sunDir.value));
 boatRenderer.render(boatScene,{camera:boatCamera,kind:'main',colorViews:boatTarget.textures.map(texture=>texture.view()),colorFormats:boatTarget.formats,
  clearColors:[[.1,.15,.2,1],[0,0,0,0],[0,0,0,0]],depthView:boatTarget.depthTexture.view(),depthFormat:'depth32float',clearDepth:0});
 GPU.submit();await GPU.device.queue.onSubmittedWorkDone();
 const boatValidationError=await GPU.device.popErrorScope();
 assert.equal(boatValidationError,null,boatValidationError?.message);
 assert.ok(boatRenderer.stats.pipelines>=4 && boatRenderer.stats.draws>=24,'actual packaged boat base and distance GLBs render through color and shadow passes');
 console.log(`Moored boat LOD GPU smoke: ${boatRenderer.stats.draws} draws, ${boatRenderer.stats.pipelines} pipelines`);
 await new Promise(resolve=>setTimeout(resolve,100));
}
disposeWorldPackage(root);disposeWorldPackage(root);
disposeWorldPackage(boatRoot);
assert.ok(root.userData.worldPackage.lodControllers.get(object.id).controller.signal.aborted);
console.log('Object LOD: projected selection, hysteresis, async races, real GLB triangle reductions, collision and per-camera restoration passed');

const authored = authoredWorld;
authored.objects[0].lods=[{assetId:'sha256:'+'a'.repeat(64),maxScreenFraction:.12},{assetId:'sha256:'+'b'.repeat(64),maxScreenFraction:.04}];
const validation = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('actions',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
source=json.load(sys.stdin)
module.validate_source(source)
source['objects'][0]['lods'][1]['maxScreenFraction']=.5
try: module.validate_source(source)
except ValueError: pass
else: raise AssertionError('unordered LOD thresholds accepted')
`;
execFileSync('python3',['-B','-c',validation,fileURLToPath(new URL('../tools/blender/world_actions.py',import.meta.url))],{input:JSON.stringify(authored),stdio:['pipe','pipe','pipe']});
console.log('Blender authoring accepts valid levels and rejects unordered thresholds');

const queue = new LODLoadQueue(1), release = [];
const firstSignal = new AbortController(), cancelledSignal = new AbortController();
let releaseFirst;
const firstTask = queue.run(firstSignal.signal, () => new Promise(resolve => {releaseFirst=resolve;}));
await Promise.resolve();
const cancelledTask = queue.run(cancelledSignal.signal, () => {throw new Error('Cancelled queued work ran');});
const lastTask = queue.run(firstSignal.signal, () => release.push('last'));
const rejected = assert.rejects(cancelledTask,{name:'AbortError'});
cancelledSignal.abort(new DOMException('World unloaded','AbortError')); await rejected;
assert.equal(queue.active,1); assert.deepEqual(release,[]);
releaseFirst(); await firstTask; await lastTask; assert.deepEqual(release,['last']);
console.log('LOD acquisition concurrency and queued cancellation passed');
