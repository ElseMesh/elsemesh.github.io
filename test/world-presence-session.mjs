import assert from 'node:assert/strict';
import { WorldPresenceSession, makePresencePose } from '../src/network/WorldPresenceSession.js';
import { DEFAULT_APPEARANCE } from '../src/player/AvatarAppearance.js';
import { Vector3 } from '../src/engine/math/Vector3.js';

const own = 'player:' + 'a'.repeat(64), remote = 'player:' + 'b'.repeat(64);
let now = 0, options, sent = [], pending, closed = 0, disposed = 0;
const created = [];
const player = { position: new Vector3(1,2,3), velocity: new Vector3(0,0,-3), mode: 'walk', yaw: 10000, pitch: .1 };
const connector = { worldId: 'tw-world:test', gateway: 'http://127.0.0.1:5193', manifest: { ownerPeerId: 'owner', rules: { avatarComplexity: 20000 } } };
const session = new WorldPresenceSession({connector, parent: {add(group){created.push(group)}}, clock: () => now,
 createConnector(value){ options=value; return {updatePresence(pose,{signal}){ sent.push({pose,signal}); return new Promise((resolve,reject)=>{pending={resolve,reject}})},close(){closed++}} },
 createAvatar({appearance,maxComplexity}){ assert.equal(maxComplexity,20000); return {group:{},setAppearance(){},update(dt,pose){this.pose=pose},dispose(){disposed++}} },
});
assert.equal(options.nodeId,'owner','presence targets signed owner even when content gateway belongs to a replica');
session.update(.016,player); assert.equal(sent.length,1);
assert.ok(Math.abs(sent[0].pose.yaw)<=Math.PI,'accumulated player yaw is normalized for bounded wire protocol');
now=500; session.update(.016,player); assert.equal(sent.length,1,'one in-flight request prevents overlapping publishes');
const pose = {...sent[0].pose,id:remote,position:[4,2,3],updatedAt:1000};
pending.resolve({type:'presence',worldId:connector.worldId,requestId:'one',playerId:own,players:[pose]});
await session.pending;
session.update(.016,player); assert.equal(created.length,1,'validated remote snapshot creates an avatar');
assert.equal(sent.length,2,'publication resumes after the request completes');
now=550; session.update(.016,player); assert.equal(sent.length,2,'10Hz cadence remains bounded');
pending.resolve({type:'presence',worldId:connector.worldId,requestId:'two',playerId:own,players:[]}); await session.pending;
session.update(.016,player); assert.equal(disposed,1,'departure releases avatar resources');
now=600;session.update(.016,player); assert.equal(sent.length,3);
session.dispose(); assert.equal(closed,1); assert.equal(sent[2].signal.aborted,true,'handoff aborts pending presence');
pending.resolve({type:'presence',worldId:connector.worldId,requestId:'late',playerId:own,players:[pose]}); await session.pending;
session.update(.016,player); assert.equal(created.length,1,'late source-world response cannot resurrect an avatar after handoff');
session.dispose(); assert.equal(closed,1,'disposal is idempotent');
const boatPose=makePresencePose({...player,mode:'boat',boat:{getYaw:()=>1,speed:7.5},helmYaw:.2,helmPitch:.4},4,DEFAULT_APPEARANCE);
assert.ok(Math.abs(boatPose.yaw-Math.atan2(Math.sin(1+Math.PI+.2),Math.cos(1+Math.PI+.2)))<1e-9);
assert.equal(boatPose.pitch,.4); assert.equal(boatPose.moving,false,'helm pose is distinct from walking');
assert.equal(boatPose.vehicleSpeed,7.5,'vehicle presence includes the speed checked against destination rules');
console.log('ok   active-world publisher cadence, owner routing, avatar departure and handoff cleanup');
