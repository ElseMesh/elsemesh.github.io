import assert from 'node:assert/strict';
import { portalRouteFromPosition, crossedPortalPlane, mapPortalPlayerState, mapPortalCamera } from '../src/network/PortalHandoff.js';
import { Vector3 } from '../src/engine/math/Vector3.js';
import { PerspectiveCamera } from '../src/engine/scene/Camera.js';
import { loadWorldPackage, disposeWorldPackage } from '../src/network/WorldPackage.js';
import { createWorldSource } from '../src/network/WorldSource.js';
import { exportPortalLink, importPortalLink } from '../tools/portal-link.mjs';
import { applyWorldProposal } from '../tools/apply-world-proposal.mjs';
import { App } from '../src/App.js';

const portal = {id:'tw-portal:two-sided',destinationWorldId:'tw-world:front',entry:{position:[0,2,0],yaw:0},exit:{position:[10,2,0],yaw:.4},enabled:true,openView:true,back:{destinationWorldId:'tw-world:back',exit:{position:[50,2,0],yaw:Math.PI},enabled:true,openView:true}};
const front = new Vector3(0,2,2), back = new Vector3(0,2,-2);
const frontRoute = portalRouteFromPosition(portal,front), backRoute=portalRouteFromPosition(portal,back);
assert.equal(frontRoute,portal);
assert.equal(backRoute.destinationWorldId,'tw-world:back');
assert.equal(backRoute.entry.yaw,Math.PI);
assert.equal(backRoute.connectionKey,'tw-portal:two-sided#back');
assert.equal(portalRouteFromPosition(portal,back),backRoute,'Derived back route identity stays stable for preview cadence');
assert.ok(crossedPortalPlane(front,back,frontRoute));
assert.ok(crossedPortalPlane(back,front,backRoute));
assert.equal(crossedPortalPlane(back,front,frontRoute),false);
assert.equal(portalRouteFromPosition({...portal,back:undefined},back),null,'Legacy front does not preview from back');
assert.equal(portalRouteFromPosition({...portal,enabled:false},front),null);
assert.equal(portalRouteFromPosition({...portal,enabled:false},back).destinationWorldId,'tw-world:back');

function exercise(previous,current,{crossing=false}={}) {
 const selected=[];
 const app={player:{mode:'walk'},remoteWorldActive:true,worldConnector:{manifest:{portals:[portal]}},camera:{position:current.clone()},portalPreviousPosition:previous.clone(),portalPreparations:new Map([[portal.id,{status:'ready',root:{},connector:{}}],[backRoute.connectionKey,{status:'ready',root:{},connector:{}}]]),vehicleTransferStatus(){return {allowed:true};},
 cancelUnneededPortalPreparations(key){this.selectedKey=key;},clearPortalPreview(){this.portalPreviewId=null;},portalView:{setTarget(root,route){selected.push(route);}},enterWorldPortal(route){selected.push(route);this.crossed=true;}};
 App.prototype.updateWorldPortals.call(app);
 assert.equal(!!app.crossed,crossing);
 return {app,route:selected.at(-1)};
}
assert.equal(exercise(front,front).route.destinationWorldId,'tw-world:front');
assert.equal(exercise(back,back).route.destinationWorldId,'tw-world:back');
assert.equal(exercise(front,back,{crossing:true}).route.destinationWorldId,'tw-world:front','Crossing retains approach side after crossing plane');
assert.equal(exercise(back,front,{crossing:true}).app.selectedKey,backRoute.connectionKey);

const sourceCamera=new PerspectiveCamera(60,1,.1,1000),destinationCamera=sourceCamera.clone();sourceCamera.position.copy(back);
mapPortalCamera(sourceCamera,destinationCamera,backRoute.entry,backRoute.exit);
const arrival=mapPortalPlayerState({position:back,velocity:{x:0,y:1,z:3},yaw:1,pitch:.2},backRoute.entry,backRoute.exit);
assert.ok(destinationCamera.position.distanceTo(arrival.position)<1e-6,'Preview and player use same selected-side transform');
assert.equal(arrival.velocity.y,1);
const sameWorld={...portal,back:{...portal.back,destinationWorldId:portal.destinationWorldId,exit:{position:[...portal.exit.position],yaw:portal.exit.yaw+Math.PI}}};
assert.equal(portalRouteFromPosition(sameWorld,back).destinationWorldId,portal.destinationWorldId);
assert.equal(portalRouteFromPosition(sameWorld,back).exit.yaw-portal.exit.yaw,Math.PI);
console.log('Two-sided portal: approach selection, distinct preparation keys, both crossings, previews and opposite-facing same destination passed');

const rearOnly = {...portal,enabled:false,visual:'stone'};
const framed = await loadWorldPackage({worldId:'tw-world:frame',manifest:{objects:[],portals:[rearOnly]}},{assets:new Map()});
assert.equal(framed.children.length,1,'Rear-only portal retains its physical frame');
assert.equal(framed.children[0].children.length,3,'One frame serves both sides');
disposeWorldPackage(framed);

const aliceSource={...createWorldSource(),worldId:'tw-world:alice',portals:[{...portal,back:undefined}]};
const bobSource={...createWorldSource(),worldId:portal.destinationWorldId,portals:[]};
const bobBytes=new TextEncoder().encode(JSON.stringify(bobSource));
const shared=exportPortalLink(aliceSource,portal.id);
const proposal=importPortalLink(bobBytes,shared,'tw-portal:return-to-alice');
const bobCandidate=applyWorldProposal(bobBytes,proposal);
const reciprocal=bobCandidate.source.portals[0];
const original={position:back,velocity:{x:1,y:2,z:-3},yaw:.7,pitch:.2};
const outbound=mapPortalPlayerState(original,portal.entry,portal.exit);
const returned=mapPortalPlayerState(outbound,reciprocal.entry,reciprocal.exit);
assert.ok(returned.position.distanceTo(original.position)<1e-6);
for(const axis of ['x','y','z'])assert.ok(Math.abs(returned.velocity[axis]-original.velocity[axis])<1e-6);
assert.ok(Math.abs(Math.atan2(Math.sin(returned.yaw-original.yaw),Math.cos(returned.yaw-original.yaw)))<1e-6);
console.log('Shared complementary portal preserves round-trip pose and momentum');
