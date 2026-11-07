// Articulated body used by every creature.
//
// A body is a set of joint particles connected by distance constraints. While
// alive it is driven kinematically by procedural animation (poses are written
// into the particles); on death, or when a limb is cut off, the particles are
// handed to a Verlet solver and become a ragdoll. Limb segments are separate
// meshes stretched between their two joints, so severing is precise: the
// segment you hit (and everything below it) is split into a new ragdoll piece
// at the joint, with gore caps on both wounds.

import * as THREE from 'three';

export enum J {
  Pelvis, Chest, Head,
  LSh, LEl, LHa,
  RSh, REl, RHa,
  LHip, LKn, LFt,
  RHip, RKn, RFt,
  COUNT,
}

export type Part = 'torso' | 'head' | 'arm' | 'forearm' | 'thigh' | 'shin';

export interface SegDef {
  name: string;
  a: J;
  b: J;
  ra: number;
  rb: number;
  part: Part;
  /** segments that hang below this one (cut off with it) */
  children: number[];
}

export const SEGS: SegDef[] = [
  { name: 'torso', a: J.Pelvis, b: J.Chest, ra: 0.15, rb: 0.19, part: 'torso', children: [] },
  { name: 'head', a: J.Chest, b: J.Head, ra: 0.06, rb: 0.13, part: 'head', children: [] },
  { name: 'l_arm', a: J.LSh, b: J.LEl, ra: 0.06, rb: 0.048, part: 'arm', children: [3] },
  { name: 'l_fore', a: J.LEl, b: J.LHa, ra: 0.046, rb: 0.035, part: 'forearm', children: [] },
  { name: 'r_arm', a: J.RSh, b: J.REl, ra: 0.06, rb: 0.048, part: 'arm', children: [5] },
  { name: 'r_fore', a: J.REl, b: J.RHa, ra: 0.046, rb: 0.035, part: 'forearm', children: [] },
  { name: 'l_thigh', a: J.LHip, b: J.LKn, ra: 0.085, rb: 0.06, part: 'thigh', children: [7] },
  { name: 'l_shin', a: J.LKn, b: J.LFt, ra: 0.058, rb: 0.04, part: 'shin', children: [] },
  { name: 'r_thigh', a: J.RHip, b: J.RKn, ra: 0.085, rb: 0.06, part: 'thigh', children: [9] },
  { name: 'r_shin', a: J.RKn, b: J.RFt, ra: 0.058, rb: 0.04, part: 'shin', children: [] },
];

/** Rest pose in body space (x right, y up, z forward), metres, for a 1.8m figure. */
export const REST: [number, number, number][] = [
  [0, 0.98, 0], [0, 1.46, 0.02], [0, 1.74, 0.05],
  [-0.2, 1.42, 0], [-0.24, 1.14, -0.02], [-0.26, 0.88, 0.04],
  [0.2, 1.42, 0], [0.24, 1.14, -0.02], [0.26, 0.88, 0.04],
  [-0.1, 0.94, 0], [-0.11, 0.52, 0.03], [-0.12, 0.08, 0],
  [0.1, 0.94, 0], [0.11, 0.52, 0.03], [0.12, 0.08, 0],
];

// Bracing constraints that keep the torso rigid in ragdoll mode.
export const BRACES: [J, J][] = [
  [J.Chest, J.LSh], [J.Chest, J.RSh], [J.LSh, J.RSh],
  [J.Pelvis, J.LHip], [J.Pelvis, J.RHip], [J.LHip, J.RHip],
  [J.LSh, J.Pelvis], [J.RSh, J.Pelvis], [J.LHip, J.Chest], [J.RHip, J.Chest],
  [J.LSh, J.LHip], [J.RSh, J.RHip],
];

export interface Constraint { i: number; j: number; len: number; k: number }

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _u = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export interface GroundQuery { height(x: number, z: number): number; collide?(p: THREE.Vector3, r: number): boolean }

export class Ragdoll {
  pos: THREE.Vector3[] = [];
  prev: THREE.Vector3[] = [];
  invMass: number[] = [];
  radius: number[] = [];
  cons: Constraint[] = [];
  sleeping = false;
  private still = 0;
  age = 0;

  add(p: THREE.Vector3, prev: THREE.Vector3, r: number, invMass = 1) {
    this.pos.push(p.clone());
    this.prev.push(prev.clone());
    this.radius.push(r);
    this.invMass.push(invMass);
    return this.pos.length - 1;
  }
  link(i: number, j: number, k = 1) {
    this.cons.push({ i, j, len: this.pos[i].distanceTo(this.pos[j]), k });
  }

  impulse(i: number, v: THREE.Vector3, dt: number) {
    this.prev[i].addScaledVector(v, -dt);
    this.sleeping = false;
  }

  step(dt: number, ground: GroundQuery) {
    if (this.sleeping) return;
    this.age += dt;
    const g = -9.81 * dt * dt;
    let motion = 0;
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i], q = this.prev[i];
      const vx = (p.x - q.x) * 0.992, vy = (p.y - q.y) * 0.992, vz = (p.z - q.z) * 0.992;
      q.copy(p);
      p.x += vx;
      p.y += vy + g;
      p.z += vz;
      motion += vx * vx + vy * vy + vz * vz;
    }
    for (let it = 0; it < 8; it++) {
      for (const c of this.cons) {
        const a = this.pos[c.i], b = this.pos[c.j];
        _v.subVectors(b, a);
        const d = _v.length() || 1e-6;
        const wa = this.invMass[c.i], wb = this.invMass[c.j];
        const diff = ((d - c.len) / (d * (wa + wb))) * c.k;
        a.addScaledVector(_v, diff * wa);
        b.addScaledVector(_v, -diff * wb);
      }
      for (let i = 0; i < this.pos.length; i++) {
        const p = this.pos[i];
        const h = ground.height(p.x, p.z) + this.radius[i];
        if (p.y < h) {
          p.y = h;
          // friction: kill tangential velocity
          const q = this.prev[i];
          q.x += (p.x - q.x) * 0.35;
          q.z += (p.z - q.z) * 0.35;
          if (q.y > p.y) q.y = p.y;
        }
      }
    }
    if (ground.collide) for (let i = 0; i < this.pos.length; i += 2) ground.collide(this.pos[i], this.radius[i]);
    if (motion / this.pos.length < 1e-7 && this.age > 1) {
      this.still += dt;
      if (this.still > 0.8) this.sleeping = true;
    } else this.still = 0;
  }
}

export interface SegmentVisual {
  root: THREE.Object3D; // positioned at joint a, +Y towards joint b
  len: number;
}

/** Orient an object at a with +Y pointing to b; `side` (optional) fixes roll. */
export function orientBetween(o: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, side?: THREE.Vector3, restLen?: number) {
  _v.subVectors(b, a);
  const len = _v.length();
  if (len < 1e-5) return;
  _v.divideScalar(len);
  if (side) {
    _w.copy(side).addScaledVector(_v, -side.dot(_v)).normalize();
    _u.crossVectors(_w, _v);
    _m.makeBasis(_w, _v, _u);
    o.quaternion.setFromRotationMatrix(_m);
  } else {
    _q.setFromUnitVectors(UP, _v);
    o.quaternion.copy(_q);
  }
  o.position.copy(a);
  if (restLen) o.scale.set(1, len / restLen, 1);
}

/** Closest points between segments p1q1 and p2q2. Returns squared distance; writes params. */
export function segSegDist2(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3, out: { s: number; t: number }) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) { s = t = 0; }
  else if (a <= 1e-9) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-9) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      s = den !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  out.s = s;
  out.t = t;
  const cx = p1.x + d1x * s - (p2.x + d2x * t);
  const cy = p1.y + d1y * s - (p2.y + d2y * t);
  const cz = p1.z + d1z * s - (p2.z + d2z * t);
  return cx * cx + cy * cy + cz * cz;
}

/** Analytic two-bone IK: returns the middle joint for root→target with bone lengths l1,l2. */
export function solveIK(root: THREE.Vector3, target: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, out: THREE.Vector3) {
  _v.subVectors(target, root);
  let d = _v.length();
  const maxD = (l1 + l2) * 0.999;
  if (d > maxD) {
    _v.multiplyScalar(maxD / d);
    d = maxD;
  }
  d = Math.max(d, Math.abs(l1 - l2) + 1e-3);
  const dir = _w.copy(_v).normalize();
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _u.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (_u.lengthSq() < 1e-8) _u.set(0, 0, 1);
  _u.normalize();
  out.copy(root).addScaledVector(dir, a).addScaledVector(_u, h);
  return out;
}
