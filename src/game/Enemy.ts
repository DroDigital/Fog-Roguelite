// Creatures of the fog: definitions, procedural animation, AI and the
// damage model that drives per-limb dismemberment.

import * as THREE from 'three';
import { J, SEGS, REST, BRACES, Ragdoll, orientBetween, segSegDist2, solveIK } from './Body';
import { buildSegment, makeCreatureMats, makeFlesh, makeWoundCap, type CreatureLook, type CreatureMats } from './CreatureMesh';
import type { Ctx } from './Ctx';
import { audio } from '../engine/Audio';
import { angleDiff, clamp, damp, lerp } from '../engine/Random';

export type EnemyKind = 'hollow' | 'stalker' | 'brute' | 'weeper' | 'warden';
export type AttackKind = 'swipe' | 'slam' | 'sweep' | 'charge' | 'spit';

export interface EnemyDef {
  kind: EnemyKind;
  name: string;
  scale: number;
  hp: number;
  walk: number;
  run: number;
  damage: number;
  reach: number;
  windup: number;
  strike: number;
  recover: number;
  sense: number;
  staggerResist: number;
  limbHp: number;
  crouch: number;
  xp: number;
  echoes: number;
  look: CreatureLook;
  voicePitch: number;
  posture: number;
  ranged?: boolean;
  boss?: boolean;
}

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  hollow: {
    kind: 'hollow', name: 'Hollow', scale: 1, hp: 70, walk: 1.1, run: 4.1, damage: 13, reach: 1.45, windup: 0.62, strike: 0.16, recover: 0.6,
    sense: 15, staggerResist: 1, limbHp: 1, crouch: 0.02, xp: 10, echoes: 2, voicePitch: 1, posture: 70,
    look: { id: 'hollow', skin: new THREE.Color(0.85, 0.86, 0.82), eye: new THREE.Color(9, 2.2, 0.35), gaunt: 0.65, bulk: 1, armour: false, cloth: true },
  },
  stalker: {
    kind: 'stalker', name: 'Mist Stalker', scale: 1.06, hp: 48, walk: 1.6, run: 6.4, damage: 10, reach: 1.5, windup: 0.42, strike: 0.2, recover: 0.5,
    sense: 21, staggerResist: 0.7, limbHp: 0.75, crouch: 0.24, xp: 14, echoes: 3, voicePitch: 1.5, posture: 50,
    look: { id: 'stalker', skin: new THREE.Color(0.62, 0.68, 0.74), eye: new THREE.Color(0.6, 3, 11), gaunt: 1, bulk: 0.82, armour: false, cloth: false },
  },
  brute: {
    kind: 'brute', name: 'Barrow Brute', scale: 1.42, hp: 260, walk: 1.0, run: 3.3, damage: 30, reach: 2.1, windup: 1.0, strike: 0.2, recover: 0.95,
    sense: 14, staggerResist: 2.6, limbHp: 2.4, crouch: 0.06, xp: 40, echoes: 10, voicePitch: 0.6, posture: 190,
    look: { id: 'brute', skin: new THREE.Color(0.75, 0.66, 0.62), eye: new THREE.Color(12, 0.8, 0.3), gaunt: 0.15, bulk: 1.45, armour: true, cloth: true },
  },
  weeper: {
    kind: 'weeper', name: 'Weeper', scale: 0.98, hp: 55, walk: 1.0, run: 3.4, damage: 11, reach: 14, windup: 0.85, strike: 0.15, recover: 0.7,
    sense: 24, staggerResist: 0.8, limbHp: 0.8, crouch: 0.16, xp: 16, echoes: 4, voicePitch: 1.25, posture: 45, ranged: true,
    look: { id: 'weeper', skin: new THREE.Color(0.66, 0.74, 0.6), eye: new THREE.Color(3, 10, 1.2), gaunt: 0.9, bulk: 0.9, armour: false, cloth: true },
  },
  warden: {
    kind: 'warden', name: 'The Drowned Warden', scale: 2.05, hp: 1500, walk: 1.2, run: 3.6, damage: 34, reach: 3.1, windup: 0.95, strike: 0.22, recover: 0.8,
    sense: 60, staggerResist: 6, limbHp: 5, crouch: 0.04, xp: 250, echoes: 120, voicePitch: 0.42, posture: 600, boss: true,
    look: { id: 'warden', skin: new THREE.Color(0.5, 0.52, 0.56), eye: new THREE.Color(5, 9, 22), gaunt: 0.3, bulk: 1.35, armour: true, cloth: true },
  },
};

const LIMB_HP: Record<string, number> = { head: 45, arm: 40, forearm: 28, thigh: 55, shin: 38, torso: 1e9 };
const PART_DMG: Record<string, number> = { head: 2.2, torso: 1, arm: 0.65, forearm: 0.55, thigh: 0.75, shin: 0.6 };
const JOINT_R = [0.14, 0.16, 0.12, 0.06, 0.05, 0.05, 0.06, 0.05, 0.05, 0.08, 0.06, 0.05, 0.08, 0.06, 0.05];

const matCache = new Map<string, CreatureMats>();

export interface HitInfo {
  seg: number;
  point: THREE.Vector3;
  dir: THREE.Vector3;
  damage: number;
  sever: number;
  blunt: boolean;
  stagger: number;
  crit: boolean;
  source: 'melee' | 'bolt' | 'fire' | 'bleed';
  riposte?: boolean;
}

interface Link { vis: THREE.Object3D; ia: number; ib: number; side: THREE.Vector3; sideFrom?: [number, number]; flip?: boolean }

/** Ragdolled remains: whole corpses and severed limbs. */
export class Corpse {
  rag = new Ragdoll();
  links: Link[] = [];
  age = 0;
  owner: Enemy | null = null;
  private _x = new THREE.Vector3();
  private _s = new THREE.Vector3();

  update(dt: number, ctx: Ctx) {
    this.age += dt;
    this.rag.step(dt, ctx.world);
    for (const l of this.links) {
      let side: THREE.Vector3 | undefined = l.side;
      if (l.sideFrom) {
        side = this._s.subVectors(this.rag.pos[l.sideFrom[0]], this.rag.pos[l.sideFrom[1]]);
        if (l.flip) side.negate();
      }
      orientBetween(l.vis, this.rag.pos[l.ia], this.rag.pos[l.ib], side);
      if (!l.sideFrom) l.side.copy(this._x.set(1, 0, 0).applyQuaternion(l.vis.quaternion));
    }
  }

  dispose(scene: THREE.Object3D) {
    for (const l of this.links) scene.remove(l.vis);
    this.links.length = 0;
  }

  /** Closest particle to a point (for kicking bodies around). */
  push(p: THREE.Vector3, dir: THREE.Vector3, force: number, radius: number) {
    let any = false;
    for (let i = 0; i < this.rag.pos.length; i++) {
      const d = this.rag.pos[i].distanceTo(p);
      if (d < radius) {
        this.rag.impulse(i, dir.clone().multiplyScalar(force * (1 - d / radius)), 1 / 60);
        any = true;
      }
    }
    return any;
  }
}

type AIState = 'idle' | 'wander' | 'lurk' | 'chase' | 'attack' | 'stagger' | 'broken' | 'dead';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _seg = { s: 0, t: 0 };
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _left = new THREE.Vector3();
let enemyIds = 1;

export class Enemy {
  id = enemyIds++;
  def: EnemyDef;
  mats: CreatureMats;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  hp: number;
  maxHp: number;
  state: AIState = 'wander';
  joints: THREE.Vector3[] = [];
  prevJoints: THREE.Vector3[] = [];
  jointAlive: boolean[] = [];
  segAlive: boolean[] = [];
  segHp: number[] = [];
  segLen: number[] = [];
  vis: THREE.Object3D[] = [];
  elite = false;
  private phase = Math.random() * 10;
  private stateT = 0;
  private attackT = 0;
  private struck = false;
  private wanderDir = Math.random() * Math.PI * 2;
  private groanT = 2 + Math.random() * 6;
  private flinch = new THREE.Vector3();
  private flinchV = new THREE.Vector3();
  private lunge = 0;
  private speed = 0;
  posture = 0;
  private postureCool = 0;
  brokenT = 0;
  atkKind: AttackKind = 'swipe';
  private aw = 1;
  private as = 0.2;
  private ar = 1;
  private atkCooldown = 0;
  private summoned = 0;
  bleed = 0;
  bleedT = 0;
  staggerT = 0;
  burning = 0;
  alerted = false;
  removed = false;
  lastHitTime = -10;
  scene: THREE.Object3D;

  constructor(kind: EnemyKind, private ctx: Ctx, at: THREE.Vector3, opts: { lurk?: boolean; elite?: boolean } = {}) {
    this.def = ENEMIES[kind];
    this.scene = ctx.scene;
    const d = this.def;
    this.elite = !!opts.elite;
    const diffHp = 1 + ctx.difficulty * 0.35;
    this.maxHp = this.hp = d.hp * diffHp * (this.elite ? 2.2 : 1);
    let mats = matCache.get(d.kind + (this.elite ? 'e' : ''));
    if (!mats) {
      const look = { ...d.look };
      if (this.elite) look.eye = new THREE.Color(20, 14, 30);
      mats = makeCreatureMats(ctx.tex, look);
      matCache.set(d.kind + (this.elite ? 'e' : ''), mats);
    }
    // per-creature skin so blood accumulates on this body only
    const bloodU = { value: 0 };
    const look = { ...d.look };
    this.mats = { ...mats, flesh: makeFlesh(ctx.tex, look, bloodU), bloodU };
    mats = this.mats;
    this.pos.copy(at);
    this.pos.y = ctx.world.height(at.x, at.z);
    this.yaw = Math.random() * Math.PI * 2;
    if (opts.lurk) this.state = 'lurk';
    const S = d.scale;
    for (let j = 0; j < J.COUNT; j++) {
      this.joints.push(new THREE.Vector3());
      this.prevJoints.push(new THREE.Vector3());
      this.jointAlive.push(true);
    }
    for (let s = 0; s < SEGS.length; s++) {
      const def = SEGS[s];
      const a = REST[def.a], b = REST[def.b];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * S;
      this.segLen.push(len);
      this.segAlive.push(true);
      this.segHp.push(LIMB_HP[def.part] * d.limbHp * (this.elite ? 1.5 : 1));
      const v = buildSegment(s, len, S, d.look, mats, this.id * 31 + (d.kind === 'brute' ? 7 : 0));
      if (this.elite) v.scale.setScalar(1.04);
      this.vis.push(v);
      this.scene.add(v);
    }
    this.pose(0);
    for (let j = 0; j < J.COUNT; j++) this.prevJoints[j].copy(this.joints[j]);
    this.applyVisuals();
  }

  get alive() {
    return this.state !== 'dead';
  }

  forward(out: THREE.Vector3) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  // ──────────────────────────────────────────── animation

  private pose(dt: number) {
    const d = this.def;
    const S = d.scale;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const runN = clamp(speed / d.run, 0, 1);
    this.phase += dt * (1.6 + speed * 1.55 / S);
    const ph = this.phase;
    const fwd = this.forward(_fwd);
    _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const P = this.pos;
    const L = (x: number, y: number, z: number, out: THREE.Vector3) =>
      out.set(P.x + _right.x * x + fwd.x * z, P.y + y, P.z + _right.z * x + fwd.z * z);

    // attack curve
    let atkRaise = 0, atkStrike = 0;
    if (this.state === 'attack') {
      const t = this.attackT;
      if (t < this.aw) atkRaise = THREE.MathUtils.smoothstep(t / this.aw, 0, 1);
      else if (t < this.aw + this.as) {
        const k = (t - this.aw) / this.as;
        atkRaise = 1 - k;
        atkStrike = Math.sin(k * Math.PI * 0.5);
      } else {
        const k = (t - this.aw - this.as) / this.ar;
        atkStrike = 1 - THREE.MathUtils.smoothstep(k, 0, 1);
      }
    }
    const stag = this.state === 'stagger' ? Math.min(1, this.staggerT * 2) : 0;
    const kneel = this.state === 'broken' ? Math.min(1, (3.2 - this.brokenT) * 4) : 0;
    const crouch = d.crouch * S + atkRaise * (d.kind === 'stalker' || d.kind === 'weeper' ? 0.18 : 0.04) * S + kneel * 0.42 * S;
    const bob = Math.abs(Math.sin(ph)) * 0.05 * S * (0.3 + runN);
    const lean = 0.12 + runN * 0.35 + d.crouch * 1.2 + atkStrike * 0.35 - atkRaise * (d.kind === 'weeper' ? 0.55 : 0.15) - stag * 0.4 + kneel * 0.75;
    const sway = Math.sin(ph * 0.5) * 0.04 * S;

    const pelvisY = REST[J.Pelvis][1] * S - crouch - bob;
    const pelvis = L(sway, pelvisY, -lean * 0.05 * S, this.joints[J.Pelvis]);
    // spine
    const spineLen = this.segLen[0];
    const chest = this.joints[J.Chest];
    chest.set(0, Math.cos(lean), Math.sin(lean)).multiplyScalar(spineLen);
    chest.set(pelvis.x + fwd.x * chest.z + this.flinch.x, pelvis.y + chest.y + this.flinch.y, pelvis.z + fwd.z * chest.z + this.flinch.z);
    // head: look towards player when hunting
    const head = this.joints[J.Head];
    const hLen = this.segLen[1];
    const headLean = lean * 0.4 + Math.sin(this.ctx.time * 1.7 + this.id) * 0.08;
    head.set(chest.x + fwd.x * Math.sin(headLean) * hLen + this.flinch.x * 0.6, chest.y + Math.cos(headLean) * hLen, chest.z + fwd.z * Math.sin(headLean) * hLen + this.flinch.z * 0.6);
    // shoulders / hips follow the spine
    const shY = chest.y - 0.04 * S, hipY = pelvis.y - 0.04 * S;
    const shRot = Math.sin(ph) * 0.06 * runN;
    for (const side of [-1, 1]) {
      const sh = side < 0 ? this.joints[J.LSh] : this.joints[J.RSh];
      sh.set(chest.x + _right.x * 0.2 * S * side + fwd.x * shRot * side, shY, chest.z + _right.z * 0.2 * S * side + fwd.z * shRot * side);
      const hip = side < 0 ? this.joints[J.LHip] : this.joints[J.RHip];
      hip.set(pelvis.x + _right.x * 0.1 * S * side, hipY, pelvis.z + _right.z * 0.1 * S * side);
    }
    // legs: phase-offset stride with foot planting on terrain
    const stride = (0.08 + 0.32 * runN) * S;
    const lift = (0.06 + 0.12 * runN) * S;
    for (const side of [-1, 1]) {
      const p = ph + (side < 0 ? 0 : Math.PI);
      const hip = side < 0 ? this.joints[J.LHip] : this.joints[J.RHip];
      const foot = side < 0 ? this.joints[J.LFt] : this.joints[J.RFt];
      const knee = side < 0 ? this.joints[J.LKn] : this.joints[J.RKn];
      const z = Math.sin(p) * stride + (stag > 0 ? -0.15 * S : 0) + kneel * (side < 0 ? 0.35 : -0.25) * S;
      const lifted = Math.max(0, Math.cos(p)) * lift;
      L(side * 0.13 * S, 0, z, foot);
      foot.y = this.ctx.world.height(foot.x, foot.z) + 0.07 * S + lifted;
      _pole.copy(fwd).multiplyScalar(1).add(_c.set(0, 0.2, 0));
      solveIK(hip, foot, this.segLen[6], this.segLen[7], _pole, knee);
    }
    // arms
    const l1 = this.segLen[2], l2 = this.segLen[3];
    const reach = this.state === 'chase' && d.kind === 'hollow' ? 0.65 + 0.15 * Math.sin(ph * 0.5) : 0;
    for (const side of [-1, 1]) {
      const sh = side < 0 ? this.joints[J.LSh] : this.joints[J.RSh];
      const el = side < 0 ? this.joints[J.LEl] : this.joints[J.REl];
      const ha = side < 0 ? this.joints[J.LHa] : this.joints[J.RHa];
      const swing = -Math.sin(ph + (side < 0 ? Math.PI : 0)) * 0.25 * runN;
      // relaxed hang + gait swing
      let hx = side * 0.05, hy = -(l1 + l2) * 0.92, hz = swing + 0.05;
      // hollow: reaching arms while chasing
      hx = lerp(hx, side * 0.05, reach);
      hy = lerp(hy, -0.25 * S, reach);
      hz = lerp(hz, 0.55 * S, reach);
      // attack: right arm (or both for brute) raises then rakes down
      const twoHanded = d.kind === 'brute' || d.kind === 'warden' || d.kind === 'weeper' || this.atkKind === 'slam';
      const attacking = side > 0 || twoHanded || (side < 0 && !this.segAlive[5]);
      if (attacking && (atkRaise > 0 || atkStrike > 0)) {
        let rx = twoHanded ? side * 0.1 : side * 0.15, ry = 0.5 * S, rz = -0.1 * S;
        let sx = twoHanded ? side * 0.05 : -side * 0.25, sy = -0.45 * S, sz = 0.6 * S;
        if (this.atkKind === 'sweep') { rx = side * 0.7 * S; ry = 0.05 * S; rz = -0.3 * S; sx = -side * 0.6 * S; sy = -0.15 * S; sz = 0.55 * S; }
        if (this.atkKind === 'spit') { rx = side * 0.25; ry = 0.3 * S; rz = 0.1 * S; sx = side * 0.2; sy = 0.05 * S; sz = 0.55 * S; }
        if (this.atkKind === 'charge') { rx = side * 0.3; ry = -0.1 * S; rz = 0.45 * S; sx = side * 0.2; sy = -0.05 * S; sz = 0.7 * S; }
        hx = lerp(lerp(hx, rx, atkRaise), sx, atkStrike);
        hy = lerp(lerp(hy, ry, atkRaise), sy, atkStrike);
        hz = lerp(lerp(hz, rz, atkRaise), sz, atkStrike);
      }
      if (kneel > 0) {
        hx = lerp(hx, side * 0.12, kneel);
        hy = lerp(hy, -(l1 + l2) * 0.75, kneel);
        hz = lerp(hz, 0.25 * S, kneel);
      }
      if (stag > 0) {
        hx += side * 0.25 * stag;
        hy += 0.2 * stag;
        hz -= 0.2 * stag;
      }
      const shLocalX = side * 0.2 * S;
      ha.set(
        sh.x + _right.x * (hx) + fwd.x * hz,
        sh.y + hy,
        sh.z + _right.z * (hx) + fwd.z * hz,
      );
      void shLocalX;
      _pole.copy(_right).multiplyScalar(side * 0.6).addScaledVector(fwd, -1).add(_c.set(0, -0.3, 0));
      solveIK(sh, ha, l1, l2, _pole, el);
    }
  }

  private applyVisuals() {
    _left.subVectors(this.joints[J.LSh], this.joints[J.RSh]).normalize();
    for (let s = 0; s < SEGS.length; s++) {
      if (!this.segAlive[s]) continue;
      const def = SEGS[s];
      const side = s <= 1 ? _left : _c.copy(_left).negate();
      orientBetween(this.vis[s], this.joints[def.a], this.joints[def.b], side);
    }
  }

  // ──────────────────────────────────────────── AI

  update(dt: number) {
    if (this.state === 'dead') return;
    const ctx = this.ctx;
    const d = this.def;
    for (let j = 0; j < J.COUNT; j++) this.prevJoints[j].copy(this.joints[j]);
    this.stateT += dt;
    // flinch spring
    this.flinchV.addScaledVector(this.flinch, -120 * dt);
    this.flinchV.multiplyScalar(Math.exp(-14 * dt));
    this.flinch.addScaledVector(this.flinchV, dt);

    // bleeding / burning
    if (this.bleed > 0) {
      this.bleedT -= dt;
      this.bleed -= dt;
      if (this.bleedT <= 0) {
        this.bleedT = 0.5;
        const p = this.joints[J.Chest];
        ctx.gore.splash(p, _a.set(0, -1, 0), 0.25);
        this.damage(4 * (1 + ctx.difficulty * 0.2), p, _a.set(0, -1, 0), 'bleed');
        if (!this.alive) return;
      }
    }
    if (this.burning > 0) {
      this.burning -= dt;
      ctx.gore.embers(this.joints[J.Chest], 2, [18, 6, 1], 0.6);
      if (Math.random() < dt * 4) {
        this.damage(5, this.joints[J.Chest], _a.set(0, 1, 0), 'fire');
        if (!this.alive) return;
      }
    }

    const toP = _a.subVectors(ctx.playerPos, this.pos);
    toP.y = 0;
    const dist = toP.length();
    const desiredYaw = Math.atan2(toP.x, toP.z);
    let targetSpeed = 0;
    let targetYaw = this.yaw;

    // perception: fog limits sight; noise and proximity give you away
    const senseR = d.sense * (0.6 + ctx.playerNoise * 0.8) * (1 + ctx.difficulty * 0.1);
    const canSense = ctx.playerAlive && (dist < senseR || (dist < 4) || this.alerted);

    switch (this.state) {
      case 'lurk':
        if (canSense && dist < senseR * 0.7) this.alert();
        break;
      case 'idle':
      case 'wander':
        if (canSense) {
          this.alert();
          break;
        }
        if (this.stateT > 4 + Math.random() * 3) {
          this.stateT = 0;
          this.wanderDir += (Math.random() - 0.5) * 2;
          this.state = Math.random() < 0.35 ? 'idle' : 'wander';
        }
        if (this.state === 'wander') {
          targetSpeed = d.walk;
          targetYaw = this.wanderDir;
        }
        break;
      case 'chase': {
        if (!ctx.playerAlive) {
          this.state = 'wander';
          break;
        }
        targetYaw = desiredYaw;
        this.atkCooldown -= dt;
        const facing = Math.abs(angleDiff(this.yaw, desiredYaw)) < 0.5;
        if (d.ranged) {
          // keep a distance and lob bile; back away when pressed
          if (dist < 7) {
            targetYaw = desiredYaw + Math.PI + Math.sin(this.ctx.time + this.id) * 0.6;
            targetSpeed = d.run;
          } else if (dist > 17) targetSpeed = d.run;
          else targetSpeed = d.walk * 0.4;
          if (dist < 20 && dist > 4 && facing && this.atkCooldown <= 0) this.beginAttack('spit');
          else if (dist < 2 && this.atkCooldown <= 0) this.beginAttack('swipe');
        } else if (d.boss) {
          targetSpeed = dist > d.reach + 0.4 ? d.run : d.walk * 0.4;
          if (this.atkCooldown <= 0) {
            if (dist > 6 && dist < 12.5 && facing) this.beginAttack('charge');
            else if (dist < d.reach + 0.6 && facing) this.beginAttack(Math.random() < 0.5 ? 'slam' : 'sweep');
          }
          const frac = this.hp / this.maxHp;
          if ((frac < 0.66 && this.summoned === 0) || (frac < 0.33 && this.summoned === 1)) {
            this.summoned++;
            ctx.summon(this.pos, 3 + this.summoned * 2);
            this.beginAttack('slam');
          }
        } else {
          const slowRange = d.reach + 0.6;
          targetSpeed = dist > slowRange ? d.run * (1 + ctx.difficulty * 0.05) : d.walk * 0.5;
          if (dist < d.reach + 0.35 && facing && this.atkCooldown <= 0) this.beginAttack(d.kind === 'brute' ? 'slam' : 'swipe');
        }
        // lose interest when far away
        if (dist > 60) {
          this.state = 'wander';
          this.alerted = false;
        }
        break;
      }
      case 'attack': {
        this.attackT += dt;
        const t = this.attackT;
        if (t < this.aw * 0.8) targetYaw = desiredYaw;
        if (d.kind === 'stalker' && t > this.aw && t < this.aw + this.as) this.lunge = 7;
        if (this.atkKind === 'charge' && t > this.aw && t < this.aw + this.as) {
          this.lunge = 13;
          ctx.fog.splat(this.pos.x, this.pos.z, this.vel.x * 0.6, this.vel.z * 0.6, 2.5, 0.2);
          if (!this.struck && dist < 2.8) {
            this.struck = true;
            this.resolveHit(ctx.damagePlayer(this.dmg() * 0.8, this.joints[J.Chest], { knock: 9 }));
          }
        }
        if (!this.struck && this.atkKind !== 'charge' && t >= this.aw + this.as * 0.5) {
          this.struck = true;
          this.strike(dist, desiredYaw);
        }
        if (t > this.aw + this.as + this.ar) {
          this.state = 'chase';
          this.stateT = 0;
        }
        break;
      }
      case 'broken':
        this.brokenT -= dt;
        if (this.brokenT <= 0) {
          this.posture = 0;
          this.state = 'chase';
          this.stateT = 0;
        }
        break;
      case 'stagger':
        this.staggerT -= dt;
        if (this.staggerT <= 0) {
          this.state = 'chase';
          this.stateT = 0;
        }
        break;
    }

    // locomotion
    this.yaw += angleDiff(this.yaw, targetYaw) * Math.min(1, dt * (this.state === 'attack' ? 4 : 6));
    const fwd = this.forward(_fwd);
    const nsp = (this.speed = damp(this.speed, targetSpeed, 5, dt));
    this.vel.x = fwd.x * nsp + fwd.x * this.lunge;
    this.vel.z = fwd.z * nsp + fwd.z * this.lunge;
    this.lunge = damp(this.lunge, 0, 6, dt);
    if (this.state === 'stagger' || this.state === 'broken') {
      this.vel.multiplyScalar(this.state === 'broken' ? 0 : 0.3);
    }
    // posture recovers when left alone
    this.postureCool -= dt;
    if (this.postureCool <= 0 && this.state !== 'broken') this.posture = Math.max(0, this.posture - d.posture * 0.12 * dt);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    ctx.world.collide(this.pos, 0.35 * d.scale);
    // don't walk into the player
    const pd = Math.hypot(this.pos.x - ctx.playerPos.x, this.pos.z - ctx.playerPos.z);
    const minD = 0.85 * d.scale;
    if (pd < minD && pd > 1e-4) {
      this.pos.x = ctx.playerPos.x + ((this.pos.x - ctx.playerPos.x) / pd) * minD;
      this.pos.z = ctx.playerPos.z + ((this.pos.z - ctx.playerPos.z) / pd) * minD;
    }
    this.pos.y = ctx.world.height(this.pos.x, this.pos.z);

    // stir the fog
    if (nsp > 0.3) ctx.fog.splat(this.pos.x, this.pos.z, this.vel.x * 0.25, this.vel.z * 0.25, 0.9 * d.scale, 0.03 * nsp * dt * 10);

    // voice
    this.groanT -= dt;
    if (this.groanT <= 0) {
      this.groanT = 4 + Math.random() * 7;
      const s = ctx.pan(this.joints[J.Head]);
      audio.play('enemyGroan', { dist: s.dist, pan: s.pan, pitch: d.voicePitch });
    }

    this.pose(dt);
    this.applyVisuals();
  }

  alert() {
    if (this.state === 'dead' || this.state === 'chase' || this.state === 'attack') return;
    this.alerted = true;
    this.state = 'chase';
    this.stateT = 0;
    const s = this.ctx.pan(this.joints[J.Head]);
    audio.play('enemyScream', { dist: s.dist * 0.6, pan: s.pan, pitch: this.def.voicePitch });
  }

  private beginAttack(kind: AttackKind = 'swipe') {
    const d = this.def;
    this.state = 'attack';
    this.attackT = 0;
    this.struck = false;
    this.atkKind = kind;
    const m = kind === 'sweep' ? [1.15, 1.4, 1.0] : kind === 'charge' ? [0.9, 4, 0.9] : kind === 'spit' ? [1, 1, 1] : [1, 1, 1];
    const haste = 1 / (1 + this.ctx.difficulty * 0.08);
    this.aw = d.windup * m[0] * haste;
    this.as = d.strike * m[1];
    this.ar = d.recover * m[2] * haste;
    this.atkCooldown = d.ranged ? 2.2 + Math.random() * 1.5 : d.boss ? 0.6 + Math.random() * 0.8 : 0.15;
    const s = this.ctx.pan(this.joints[J.Head]);
    audio.play('enemyAttack', { dist: s.dist, pan: s.pan, pitch: this.def.voicePitch });
  }

  private strike(dist: number, desiredYaw: number) {
    const d = this.def;
    const ctx = this.ctx;
    const inArc = Math.abs(angleDiff(this.yaw, desiredYaw)) < (this.atkKind === 'sweep' ? 1.9 : 1.1);
    if (this.atkKind === 'spit') {
      const from = _b.copy(this.joints[J.Head]);
      const target = _c.copy(ctx.playerEye).add(_a.set(0, -0.5, 0));
      const flight = Math.max(0.4, from.distanceTo(target) / 15);
      const vel = new THREE.Vector3().subVectors(target, from).divideScalar(flight);
      vel.y += 0.5 * 9.81 * 0.6 * flight; // arc (projectile gravity is 0.6g)
      ctx.spawnBile(from.clone(), vel, this.dmg());
      return;
    }
    if (this.atkKind === 'sweep') {
      ctx.fog.burst(this.pos.x, this.pos.z, 7, d.reach * 1.5);
      if (dist < d.reach + 0.9 && inArc) this.resolveHit(ctx.damagePlayer(this.dmg(), this.joints[J.Chest], { knock: 7 }));
      return;
    }
    if (this.atkKind === 'slam') {
      const fwd = this.forward(_fwd);
      const impact = _b.copy(this.pos).addScaledVector(fwd, 1.6 * d.scale);
      ctx.fog.burst(impact.x, impact.z, 9, 6);
      ctx.gore.dust(impact.setY(ctx.world.height(impact.x, impact.z) + 0.1), 18);
      const pd = impact.distanceTo(_c.copy(ctx.playerPos));
      ctx.shake(Math.max(0, 0.6 - pd * 0.08));
      if (pd < 2.6 || (dist < d.reach + 0.5 && inArc)) this.resolveHit(ctx.damagePlayer(this.dmg(), this.joints[J.Chest], { knock: 6 }));
      return;
    }
    if (dist < d.reach + 0.55 && inArc) this.resolveHit(ctx.damagePlayer(this.dmg(), this.joints[J.Chest], { knock: 2 }));
  }

  private dmg() {
    return this.def.damage * (1 + this.ctx.difficulty * 0.25) * (this.elite ? 1.4 : 1);
  }

  private resolveHit(r: string) {
    if (r === 'parried') {
      this.addPosture(this.def.posture * 0.45);
      if (this.state !== 'broken') this.stagger(this.def.boss ? 0.8 : 1.4);
    }
    else if (r === 'blocked') {
      this.attackT = Math.max(this.attackT, this.aw + this.as + this.ar * 0.3);
      this.addPosture(this.def.posture * 0.08);
    }
  }

  addPosture(n: number) {
    if (this.state === 'dead' || this.state === 'broken') return;
    this.posture += n;
    this.postureCool = 2.2;
    if (this.posture >= this.def.posture) {
      this.posture = this.def.posture;
      this.state = 'broken';
      this.brokenT = this.def.boss ? 4 : 3.2;
      this.stateT = 0;
      const s = this.ctx.pan(this.joints[J.Head]);
      audio.play('enemyScream', { dist: s.dist, pan: s.pan, pitch: this.def.voicePitch * 0.7 });
    }
  }

  /** Boot to the chest: shove back, stagger and posture damage. */
  kicked(dir: THREE.Vector3, power: number) {
    if (this.state === 'dead') return;
    const push = power / this.def.staggerResist;
    this.pos.addScaledVector(_a.copy(dir).setY(0).normalize(), Math.min(1.4, push * 0.7));
    this.flinchV.addScaledVector(dir, 3 / this.def.staggerResist);
    this.addPosture(this.def.posture * 0.22 * power);
    if (this.state !== 'broken' && !this.def.boss) this.stagger(0.55);
  }

  get canBeExecuted() {
    return this.state === 'broken';
  }

  stagger(t: number) {
    if (this.state === 'dead' || this.state === 'broken') return;
    this.state = 'stagger';
    this.staggerT = t;
    this.stateT = 0;
  }

  // ──────────────────────────────────────────── combat

  /** Swept capsule test: blade/bolt segment p→q of radius r against limbs. */
  testSegment(p: THREE.Vector3, q: THREE.Vector3, r: number): { seg: number; point: THREE.Vector3; d2: number } | null {
    let best: { seg: number; point: THREE.Vector3; d2: number } | null = null;
    for (let s = 0; s < SEGS.length; s++) {
      if (!this.segAlive[s]) continue;
      const def = SEGS[s];
      const a = this.joints[def.a], b = this.joints[def.b];
      const S = this.def.scale * this.def.look.bulk;
      let rad = Math.max(def.ra, def.rb) * S + r;
      if (def.part === 'torso') rad *= 1.25;
      if (def.part === 'head') rad = def.rb * S * 1.1 + r;
      let d2: number;
      if (def.part === 'head') {
        // the skull sits at the end of the neck segment
        d2 = segSegDist2(p, q, b, b, _seg);
        _seg.t = 1;
      } else d2 = segSegDist2(p, q, a, b, _seg);
      if (d2 < rad * rad && (!best || d2 < best.d2)) {
        const pt = new THREE.Vector3().lerpVectors(a, b, _seg.t);
        best = { seg: s, point: pt, d2 };
      }
    }
    return best;
  }

  /** Apply a weapon hit. Returns whether it killed / severed. */
  hit(h: HitInfo): { killed: boolean; severed: boolean; headshot: boolean } {
    if (this.state === 'dead') return { killed: false, severed: false, headshot: false };
    const ctx = this.ctx;
    const def = SEGS[h.seg];
    this.lastHitTime = ctx.time;
    this.alert();
    let dmg = h.damage * PART_DMG[def.part];
    if (this.mats.bloodU) this.mats.bloodU.value = Math.min(1, this.mats.bloodU.value + 0.12 + (h.crit ? 0.1 : 0));
    if (this.elite) dmg *= 0.85;
    // flinch impulse
    this.flinchV.addScaledVector(h.dir, 2.5 / this.def.staggerResist);
    let severed = false;
    // limb damage & severing
    if (def.part !== 'torso') {
      this.segHp[h.seg] -= h.damage * h.sever;
      // a boss keeps its head until it is nearly spent
      if (this.def.boss && def.part === 'head' && this.hp / this.maxHp > 0.25) this.segHp[h.seg] = Math.max(this.segHp[h.seg], 1);
      if (this.segHp[h.seg] <= 0) {
        if (!h.blunt) {
          this.sever(h.seg, h.dir, h.source === 'bolt' ? 3 : 4.5);
          severed = true;
        } else if (def.part === 'head') {
          this.crushHead(h.dir);
          severed = true;
        }
      }
    }
    ctx.gore.splash(h.point, _a.copy(h.dir).add(_b.set(0, 0.3, 0)).normalize(), severed ? 1.4 : h.crit ? 1 : 0.6);
    const headshot = def.part === 'head';
    if (severed && (def.part === 'head' || ((def.part === 'thigh' || def.part === 'shin') && !this.def.boss))) {
      this.die(h.dir, { severed: true, head: headshot, crit: h.crit });
      return { killed: true, severed, headshot };
    }
    const killed = this.damage(dmg, h.point, h.dir, h.source, h.crit, severed);
    if (!killed) {
      this.addPosture((dmg * h.stagger * 0.55) / Math.sqrt(this.def.staggerResist) * (h.riposte ? 2 : 1));
      if (h.stagger * dmg > 28 * this.def.staggerResist) this.stagger(0.45 + h.stagger * 0.15);
    }
    return { killed, severed, headshot };
  }

  /** Returns true if this killed the creature. */
  damage(amount: number, _p: THREE.Vector3, dir: THREE.Vector3, _src: string, crit = false, severed = false): boolean {
    if (this.state === 'dead') return false;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.die(dir, { severed, head: false, crit });
      return true;
    }
    return false;
  }

  /** Cut the body at the root joint of segment `segIdx`. */
  sever(segIdx: number, dir: THREE.Vector3, force: number) {
    const ctx = this.ctx;
    const def = SEGS[segIdx];
    const segs = [segIdx, ...def.children].filter((s) => this.segAlive[s]);
    if (!segs.length) return;
    const cut = def.a;
    const piece = new Corpse();
    const map = new Map<number, number>();
    const pIdx = (j: number) => {
      if (map.has(j)) return map.get(j)!;
      const i = piece.rag.add(this.joints[j], this.prevJoints[j], JOINT_R[j] * this.def.scale);
      map.set(j, i);
      return i;
    };
    for (const s of segs) {
      const sd = SEGS[s];
      const ia = pIdx(sd.a), ib = pIdx(sd.b);
      piece.rag.link(ia, ib);
      const vis = this.vis[s];
      piece.links.push({ vis, ia, ib, side: new THREE.Vector3(1, 0, 0).applyQuaternion(vis.quaternion) });
      this.segAlive[s] = false;
      if (sd.b !== cut) this.jointAlive[sd.b] = false;
    }
    // fling the piece
    const v = _a.copy(dir).multiplyScalar(force).add(_b.set((Math.random() - 0.5) * 1.5, 2 + Math.random() * 2, (Math.random() - 0.5) * 1.5));
    for (let i = 0; i < piece.rag.pos.length; i++) piece.rag.impulse(i, v.clone().multiplyScalar(0.7 + i * 0.3), 1 / 60);
    ctx.onPieceCreated(piece);

    // wound caps
    const childVis = this.vis[segIdx];
    const r = Math.max(def.ra, 0.04) * this.def.scale * this.def.look.bulk;
    childVis.add(makeWoundCap(r, this.mats, true));
    ctx.gore.spurt(childVis, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0), 1.2, 0.5);
    // stump on the parent
    const parentSeg = SEGS.findIndex((s, i) => s.b === cut && this.segAlive[i]);
    let stumpParent: THREE.Object3D;
    const local = new THREE.Vector3();
    const ldir = new THREE.Vector3(0, 1, 0);
    if (parentSeg >= 0) {
      stumpParent = this.vis[parentSeg];
      local.set(0, this.segLen[parentSeg], 0);
    } else {
      stumpParent = this.vis[0];
      stumpParent.updateWorldMatrix(true, false);
      local.copy(this.joints[cut]);
      stumpParent.worldToLocal(local);
      const wdir = _c.subVectors(this.joints[def.b], this.joints[cut]).normalize();
      const inv = stumpParent.quaternion.clone().invert();
      ldir.copy(wdir).applyQuaternion(inv);
    }
    const cap = makeWoundCap(r, this.mats, false);
    cap.position.copy(local);
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ldir);
    stumpParent.add(cap);
    ctx.gore.spurt(stumpParent, local, ldir, 3 + Math.random() * 2, def.part === 'head' ? 1.4 : 1);
    ctx.gore.gibsAt(this.joints[cut], dir, 3 + Math.floor(Math.random() * 3));
    ctx.fog.burst(this.joints[cut].x, this.joints[cut].z, 3, 2.5);
    const s = ctx.pan(this.joints[cut]);
    audio.play('sever', { dist: s.dist, pan: s.pan });
    // losing your sword arm makes you desperate (and a bit slower)
    if (def.part === 'arm' || def.part === 'forearm') this.stagger(0.6);
  }

  private crushHead(dir: THREE.Vector3) {
    const ctx = this.ctx;
    const head = this.joints[J.Head];
    this.segAlive[1] = false;
    this.jointAlive[J.Head] = false;
    this.scene.remove(this.vis[1]);
    ctx.gore.splash(head, dir, 2.2);
    ctx.gore.gibsAt(head, dir, 9);
    const cap = makeWoundCap(SEGS[1].ra * this.def.scale * 1.4, this.mats, false);
    cap.position.set(0, this.segLen[0], 0);
    this.vis[0].add(cap);
    ctx.gore.spurt(this.vis[0], new THREE.Vector3(0, this.segLen[0], 0), new THREE.Vector3(0, 1, 0), 4, 1.4);
    const s = ctx.pan(head);
    audio.play('sever', { dist: s.dist, pan: s.pan, pitch: 0.7 });
  }

  die(dir: THREE.Vector3, how: { severed: boolean; head: boolean; crit: boolean }) {
    if (this.state === 'dead') return;
    this.state = 'dead';
    const ctx = this.ctx;
    const body = new Corpse();
    body.owner = this;
    const map: number[] = [];
    for (let j = 0; j < J.COUNT; j++) {
      if (!this.jointAlive[j]) {
        map.push(-1);
        continue;
      }
      map.push(body.rag.add(this.joints[j], this.prevJoints[j], JOINT_R[j] * this.def.scale, j === J.Pelvis || j === J.Chest ? 0.5 : 1));
    }
    const hasSh = map[J.LSh] >= 0 && map[J.RSh] >= 0;
    for (let s = 0; s < SEGS.length; s++) {
      if (!this.segAlive[s]) continue;
      const sd = SEGS[s];
      if (map[sd.a] < 0 || map[sd.b] < 0) continue;
      body.rag.link(map[sd.a], map[sd.b]);
      const link: Link = { vis: this.vis[s], ia: map[sd.a], ib: map[sd.b], side: new THREE.Vector3(1, 0, 0).applyQuaternion(this.vis[s].quaternion) };
      if (hasSh) {
        link.sideFrom = [map[J.LSh], map[J.RSh]];
        link.flip = s > 1;
      }
      body.links.push(link);
    }
    for (const [a, b] of BRACES) if (map[a] >= 0 && map[b] >= 0) body.rag.link(map[a], map[b], 0.9);
    // keep knees and elbows from folding through the body: soft long-range links
    const soft: [J, J][] = [[J.LHip, J.LFt], [J.RHip, J.RFt], [J.LSh, J.LHa], [J.RSh, J.RHa], [J.Chest, J.Head]];
    for (const [a, b] of soft) if (map[a] >= 0 && map[b] >= 0) body.rag.link(map[a], map[b], 0.05);
    const imp = _a.copy(dir).multiplyScalar(how.crit ? 5 : 3.2).add(_b.set(0, 1.2, 0));
    for (const j of [J.Chest, J.Head, J.LSh, J.RSh]) if (map[j] >= 0) body.rag.impulse(map[j], imp, 1 / 60);
    ctx.onPieceCreated(body);
    ctx.fog.burst(this.pos.x, this.pos.z, 4, 3);
    ctx.onEnemyKilled(this, how);
  }

  /** Remove visuals that are still owned by the live body (used on despawn). */
  dispose() {
    this.removed = true;
    if (this.state !== 'dead') for (let s = 0; s < SEGS.length; s++) if (this.segAlive[s]) this.scene.remove(this.vis[s]);
  }

  eyePos(out: THREE.Vector3) {
    return out.copy(this.joints[J.Head]);
  }
}
