// First-person melee animation: keyframed swing curves with anticipation,
// acceleration through the strike, overshoot and settle; plus the arms that
// hold the weapon and a world-space blade trail.

import * as THREE from 'three';
import { orientBetween, solveIK } from './Body';
import type { WeaponMats } from './WeaponModels';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * A view-model pose. The sword hand is posed explicitly (position in torso
 * space + blade orientation) instead of swinging the whole weapon around a
 * fixed pivot, so the hand travels its own short arc while the tip whips
 * through a long one — the way a real cut is thrown. The torso twists and
 * leans under it, carrying both shoulders (and the lantern) with the blow.
 */
export interface Pose {
  x: number; y: number; z: number; // grip position (torso space, metres)
  yaw: number; pitch: number; roll: number; // blade direction + wrist roll (Euler YXZ, blade along -Z, true edge +X)
  tw: number; // torso twist (+ = turned left)
  lean: number; // torso lean (+ = forward)
}
type Ease = 'lin' | 'in' | 'out' | 'inout';
export interface Key {
  t: number;
  pose: Pose;
  ease?: Ease;
  /** 0..1: how strongly the wrist turns the true edge into the direction of travel. */
  edge?: number;
}
export interface MoveDef {
  keys: Key[]; // keys[0].pose is replaced by the pose the swing starts from
  hit: [number, number]; // active window (seconds, unscaled)
  dmg: number;
  sever: number;
  stamina: number;
  heavy?: boolean;
  step: number; // forward step speed (m/s) through the strike
  holdKey?: number; // heavy: key index held while charging
}

export const P = (x: number, y: number, z: number, yaw: number, pitch: number, roll: number, tw = 0, lean = 0): Pose => ({ x, y, z, yaw, pitch, roll, tw, lean });
export const clonePose = (p: Pose): Pose => ({ ...p });

/** Right shoulder joint (chest space) and how far the wrist can sit from it. */
export const SHOULDER_R = new THREE.Vector3(0.19, -0.3, 0.06);
export const ARM_L1 = 0.31, ARM_L2 = 0.31;
const MAX_REACH = 0.58; // grip from shoulder; keeps a little bend in the elbow
/** Torso pivot (lower spine), in view-model space. */
export const TORSO_PIVOT = new THREE.Vector3(0, -0.55, 0.08);

// Keys are authored in screen terms so every phase of a swing is framed: where
// the fist sits on screen and how deep, where the blade points on screen (or a
// raw yaw/pitch when it points behind the camera), and which way the edge faces.
const TAN_V = Math.tan((78 / 2) * (Math.PI / 180));
const ASPECT = 16 / 9;
const BLADE_L = 0.9;
const _kh = new THREE.Vector3();
const _kr = new THREE.Vector3();
const _kd = new THREE.Vector3();
const _ke = new THREE.Euler();
const _km = new THREE.Matrix4();
const _kx = new THREE.Vector3();
const _ky = new THREE.Vector3();
type Dir = [number, number] | { yaw: number; pitch: number };
/**
 * hand: [ndcX, ndcY, depth]; tip: screen point the blade points at ([ndcX, ndcY],
 * may lie off-screen) or {yaw, pitch}; edge: view-space direction the true edge faces.
 */
export function K(hand: [number, number, number], tip: Dir, edge: [number, number, number], tw = 0, lean = 0): Pose {
  const [sx, sy, d] = hand;
  const H = _kh.set(sx * d * TAN_V * ASPECT, sy * d * TAN_V, -d);
  let yaw: number, pitch: number;
  if (Array.isArray(tip)) {
    const r = _kr.set(tip[0] * TAN_V * ASPECT, tip[1] * TAN_V, -1);
    const rr = r.lengthSq(), rh = r.dot(H), disc = rh * rh - rr * (H.lengthSq() - BLADE_L * BLADE_L);
    const c = (rh + Math.sqrt(Math.max(0, disc))) / rr;
    const dir = _kd.copy(r).multiplyScalar(c).sub(H).normalize();
    pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    yaw = Math.atan2(-dir.x, -dir.z);
  } else {
    yaw = tip.yaw;
    pitch = tip.pitch;
  }
  // un-twist the torso so the authored view-space framing is what ends up on screen
  const tor = _ke.set(-lean, tw, 0, 'YXZ');
  _km.makeRotationFromEuler(tor).invert();
  const local = H.sub(TORSO_PIVOT).applyMatrix4(_km).add(TORSO_PIVOT);
  // an arm is only so long: pull the fist in toward the shoulder rather than let it detach
  const off = local.sub(SHOULDER_R);
  if (off.length() > MAX_REACH) off.setLength(MAX_REACH);
  local.copy(off).add(SHOULDER_R);
  // roll that turns the true edge (+X) toward the requested direction, in torso space
  const e = _kd.set(edge[0], edge[1], edge[2]).applyMatrix4(_km);
  const bm = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  _kx.set(1, 0, 0).applyMatrix4(bm);
  _ky.set(0, 1, 0).applyMatrix4(bm);
  const roll = Math.atan2(e.dot(_ky), e.dot(_kx));
  return { x: local.x, y: local.y, z: local.z, yaw, pitch, roll, tw, lean };
}

/** Ready guard: fist low right, blade angled up and across the view, edge toward the foe. */
export const IDLE: Pose = K([0.4, -0.7, 0.4], [-0.02, 0.62], [-0.7, 0, -1]);
/** Hanging guard: blade held across the face, hilt right, point to the left, edge up. */
export const BLOCK: Pose = K([0.42, -0.25, 0.42], [-1.4, 0.3], [0, 1, 0.3], 0.04);
/** Running: blade lowered and trailing so the arm can pump. */
export const SPRINT: Pose = K([0.62, -0.95, 0.34], [0.25, -0.35], [-0.5, -0.3, -1], -0.04, 0.04);

/**
 * Timings are for a speed-1.0 weapon. Each cut:
 *   chamber (cock the blade back, torso winds) → release (hand leads, tip lags,
 *   accelerating, edge turned into the line) → impact zone (arm extended) →
 *   follow-through (wrist rolls over, torso unwinds past centre) → recover.
 */
export const MOVES: Record<string, MoveDef> = {
  // forehand: chambered beside the right shoulder, cuts across and down, right → left
  slashR: {
    keys: [
      { t: 0, pose: IDLE },
      { t: 0.15, pose: K([0.8, 0.0, 0.36], [1.0, 2.0], [-1, 0, -0.5], -0.1, -0.03), ease: 'out', edge: 0 },
      { t: 0.22, pose: K([0.86, 0.08, 0.34], [1.2, 2.3], [-1, 0.2, -0.4], -0.13, -0.04), ease: 'out', edge: 0 },
      { t: 0.27, pose: K([0.55, -0.2, 0.42], [1.0, 0.8], [-1, 0, -0.5], -0.04, 0.02), ease: 'in', edge: 1 },
      { t: 0.315, pose: K([0.02, -0.45, 0.48], [-0.9, -0.12], [-1, 0, 0], 0.06, 0.06), ease: 'lin', edge: 1 },
      { t: 0.365, pose: K([-0.34, -0.66, 0.44], [-1.3, -0.62], [-1, 0, 1], 0.12, 0.08), ease: 'out', edge: 0.8 },
      { t: 0.44, pose: K([-0.3, -0.8, 0.42], [-0.95, -0.85], [0, -1, 0.3], 0.1, 0.05), ease: 'out', edge: 0 },
      { t: 0.56, pose: K([0.1, -0.78, 0.42], [-0.55, 0.15], [-1, 0.3, -0.5], 0.04, 0.02), ease: 'inout', edge: 0 },
      { t: 0.72, pose: IDLE, ease: 'inout', edge: 0 },
    ],
    hit: [0.24, 0.365], dmg: 1, sever: 1, stamina: 1, step: 2.2,
  },
  // backhand: the wrist turns over and the blade wraps past the left of the face, cuts left → right, rising
  slashL: {
    keys: [
      { t: 0, pose: IDLE },
      { t: 0.14, pose: K([-0.18, 0.02, 0.38], [-0.9, 1.9], [1, 0, -0.4], 0.1, -0.03), ease: 'out', edge: 0 },
      { t: 0.21, pose: K([-0.25, 0.08, 0.36], [-1.1, 2.2], [1, 0.1, -0.3], 0.13, -0.04), ease: 'out', edge: 0 },
      { t: 0.26, pose: K([0.02, -0.25, 0.42], [-1.0, 0.75], [1, 0, -0.5], 0.04, 0.02), ease: 'in', edge: 1 },
      { t: 0.305, pose: K([0.45, -0.45, 0.46], [1.0, -0.05], [1, 0, 0], -0.06, 0.05), ease: 'lin', edge: 1 },
      { t: 0.355, pose: K([0.72, -0.55, 0.42], [1.6, 0.3], [1, 0, 1], -0.12, 0.06), ease: 'out', edge: 0.8 },
      { t: 0.46, pose: K([0.72, -0.62, 0.4], [1.2, 0.85], [0, 1, 0.4], -0.1, 0.03), ease: 'out', edge: 0 },
      { t: 0.7, pose: IDLE, ease: 'inout', edge: 0 },
    ],
    hit: [0.23, 0.355], dmg: 1, sever: 1, stamina: 1, step: 2.2,
  },
  // descending diagonal from high right to low left, the body dropping into it
  diag: {
    keys: [
      { t: 0, pose: IDLE },
      { t: 0.16, pose: K([0.68, 0.38, 0.3], [1.0, 2.3], [-0.4, 0, -1], -0.09, -0.06), ease: 'out', edge: 0 },
      { t: 0.24, pose: K([0.72, 0.48, 0.28], [1.2, 2.7], [-0.4, -0.2, -1], -0.12, -0.08), ease: 'out', edge: 0 },
      { t: 0.295, pose: K([0.45, 0.05, 0.4], [0.75, 1.3], [-0.5, -0.5, -1], -0.04, 0.03), ease: 'in', edge: 1 },
      { t: 0.345, pose: K([0.05, -0.45, 0.47], [-0.6, -0.5], [-1, -1, 0], 0.06, 0.1), ease: 'lin', edge: 1 },
      { t: 0.405, pose: K([-0.3, -0.8, 0.44], [-1.15, -1.45], [-1, -1, 1], 0.11, 0.13), ease: 'out', edge: 0.8 },
      { t: 0.5, pose: K([-0.3, -0.86, 0.4], [-0.95, -1.15], [-1, 0, 0.3], 0.09, 0.08), ease: 'out', edge: 0 },
      { t: 0.62, pose: K([0.08, -0.8, 0.42], [-0.6, 0.05], [-1, 0.3, -0.5], 0.04, 0.03), ease: 'inout', edge: 0 },
      { t: 0.8, pose: IDLE, ease: 'inout', edge: 0 },
    ],
    hit: [0.26, 0.405], dmg: 1.12, sever: 1.15, stamina: 1.1, step: 2.6,
  },
  // overhead: fists raised above the brow, blade laid back over the head, the whole body crunches it down
  heavy: {
    keys: [
      { t: 0, pose: IDLE },
      { t: 0.24, pose: K([0.5, 0.5, 0.4], { yaw: -0.55, pitch: 1.75 }, [-0.3, 0, -1], -0.06, -0.1), ease: 'out', edge: 0.4 },
      { t: 0.34, pose: K([0.5, 0.62, 0.38], { yaw: -0.62, pitch: 2.0 }, [-0.3, 0.2, -1], -0.08, -0.14), ease: 'out', edge: 0.4 }, // held while charging
      { t: 0.41, pose: K([0.4, 0.3, 0.42], [0.55, 1.6], [-0.3, 0, -1], -0.03, 0.04), ease: 'in', edge: 1 },
      { t: 0.465, pose: K([0.2, -0.38, 0.5], [-0.5, -0.25], [0, -1, 0], 0.03, 0.2), ease: 'lin', edge: 1 },
      { t: 0.54, pose: K([0.1, -0.7, 0.48], [-0.85, -0.78], [0, -1, 0.5], 0.05, 0.3), ease: 'out', edge: 1 }, // drives down into the earth
      { t: 0.74, pose: K([0.16, -0.72, 0.44], [-0.62, -0.62], [-0.3, -1, 0], 0.04, 0.22), ease: 'inout', edge: 0 },
      { t: 1.02, pose: IDLE, ease: 'inout', edge: 0 },
    ],
    hit: [0.36, 0.53], dmg: 2.1, sever: 1.8, stamina: 1.9, heavy: true, step: 3.6, holdKey: 2,
  },
};
export const COMBO = ['slashR', 'slashL', 'diag'];

export const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Same angle as `a`, expressed nearest to `ref`. */
export const wrapNear = (a: number, ref: number) => ref + wrapPi(a - ref);

// Unwrap yaw/roll key to key so the wrist always takes the short way round.
for (const def of Object.values(MOVES)) {
  let prev = IDLE;
  for (let i = 1; i < def.keys.length; i++) {
    const k = def.keys[i];
    const pose = { ...k.pose, yaw: wrapNear(k.pose.yaw, prev.yaw), roll: wrapNear(k.pose.roll, prev.roll) };
    k.pose = pose;
    prev = pose;
  }
}

function ease(u: number, e: Ease | undefined) {
  switch (e) {
    case 'in':
      // accelerate like a released throw: slow off the chamber, fast into the target
      return u * u * (2.2 * u - 1.2) * 0.5 + u * u * 0.5;
    case 'out':
      return 1 - (1 - u) ** 3;
    case 'inout':
      return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
    default:
      return u;
  }
}

const CR = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};
const FIELDS = ['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'tw', 'lean'] as const;

function evalRaw(def: MoveDef, t: number, start: Pose, out: Pose): number {
  const k = def.keys;
  const kp = (i: number) => (i <= 0 ? start : k[Math.min(i, k.length - 1)].pose);
  let i = 0;
  while (i < k.length - 2 && t >= k[i + 1].t) i++;
  const t0 = k[i].t, t1 = k[i + 1].t;
  const lin = Math.min(1, Math.max(0, (t - t0) / Math.max(1e-4, t1 - t0)));
  const u = ease(lin, k[i + 1].ease);
  const a = kp(i - 1), b = kp(i), c = kp(i + 1), d = kp(i + 2);
  for (const f of FIELDS) out[f] = CR(a[f], b[f], c[f], d[f], u);
  return (k[i].edge ?? 0) + ((k[i + 1].edge ?? 0) - (k[i].edge ?? 0)) * lin;
}

const _m = new THREE.Matrix4();
const _mt = new THREE.Matrix4();
const _qq = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _x0 = new THREE.Vector3();
const _y0 = new THREE.Vector3();
const _pA: Pose = P(0, 0, 0, 0, 0, 0);
const _pB: Pose = P(0, 0, 0, 0, 0, 0);

/** World-in-view-model point `dist` metres along the blade for a pose (roll ignored). */
export function bladePoint(p: Pose, dist: number, out: THREE.Vector3) {
  out.set(0, 0, -dist).applyEuler(_eu.set(p.pitch, p.yaw, 0, 'YXZ')).add(_a.set(p.x, p.y, p.z));
  return out.sub(TORSO_PIVOT).applyEuler(_eu.set(-p.lean, p.tw, 0, 'YXZ')).add(TORSO_PIVOT);
}

/**
 * Evaluate a move at time t (seconds, unscaled) along a Catmull-Rom path through
 * its keys. Where a key asks for it, the wrist rolls the true edge into the
 * direction the blade is travelling, so cuts land edge-first instead of flat.
 */
export function evalMove(def: MoveDef, t: number, start: Pose, out: Pose): Pose {
  const w = evalRaw(def, t, start, out);
  if (w > 0.001) {
    const h = 0.012;
    evalRaw(def, Math.max(0, t - h), start, _pA);
    evalRaw(def, t + h, start, _pB);
    const v = bladePoint(_pB, 0.75, _b).sub(bladePoint(_pA, 0.75, _y0));
    if (v.lengthSq() > 1e-6) {
      // blade frame (view-model space) without roll
      _qq.setFromEuler(_eu.set(-out.lean, out.tw, 0, 'YXZ'));
      _mt.makeRotationFromQuaternion(_qq);
      _m.makeRotationFromEuler(_eu.set(out.pitch, out.yaw, 0, 'YXZ')).premultiply(_mt);
      _x0.set(1, 0, 0).applyMatrix4(_m);
      _y0.set(0, 1, 0).applyMatrix4(_m);
      // either edge may lead: the wrist turns whichever is nearer into the line of the cut
      const want = Math.atan2(v.dot(_y0), v.dot(_x0));
      let d = wrapPi(want - out.roll);
      if (Math.abs(d) > Math.PI / 2) d = wrapPi(want + Math.PI - out.roll);
      out.roll += d * w;
    }
  }
  return out;
}

export function moveLength(def: MoveDef) {
  return def.keys[def.keys.length - 1].t;
}

export function lerpPose(a: Pose, b: Pose, t: number, out: Pose) {
  for (const f of FIELDS) out[f] = a[f] + (b[f] - a[f]) * t;
  return out;
}

export function dampPose(cur: Pose, target: Pose, lambda: number, dt: number) {
  const k = 1 - Math.exp(-lambda * dt);
  for (const f of FIELDS) cur[f] += (f === 'roll' || f === 'yaw' ? wrapPi(target[f] - cur[f]) : target[f] - cur[f]) * k;
  return cur;
}

/**
 * Spring-driven secondary motion layered on the keyed pose: impact shudder,
 * recoil off stone, the blade's weight settling after a stop.
 */
export class PoseSpring {
  off: Pose = P(0, 0, 0, 0, 0, 0);
  private vel: Pose = P(0, 0, 0, 0, 0, 0);
  constructor(private omega = 34, private zeta = 0.32) {}
  kick(imp: Partial<Pose>) {
    for (const f of FIELDS) if (imp[f] !== undefined) this.vel[f] += imp[f]!;
  }
  update(dt: number) {
    const w = this.omega, z = this.zeta;
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      for (const f of FIELDS) {
        const a = -w * w * this.off[f] - 2 * z * w * this.vel[f];
        this.vel[f] += a * h;
        this.off[f] += this.vel[f] * h;
      }
    }
  }
  apply(p: Pose, out: Pose) {
    for (const f of FIELDS) out[f] = p[f] + this.off[f];
    return out;
  }
}

// ───────────────────────────────────────────────────────────── arms

export interface Arm {
  shoulder: THREE.Vector3;
  upper: THREE.Group;
  fore: THREE.Group;
  elbow: THREE.Vector3;
  pole: THREE.Vector3;
  l1: number;
  l2: number;
}

/**
 * Where the wrist joint sits in the sword hand's frame. The grip runs along Z
 * (blade toward -Z), the knuckles and true edge face +X, the back of the hand +Y.
 * In a hammer grip the forearm meets the fist from behind the back edge, roughly
 * square to the grip — not in line with the pommel.
 */
export const WRIST_IN_HAND = new THREE.Vector3(-0.078, 0.012, -0.016);

const lathe = (pts: [number, number][], seg = 14) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);

export function buildArm(parent: THREE.Object3D, mats: WeaponMats, side: 1 | -1): Arm {
  const cloth = new THREE.MeshStandardMaterial({ color: 0x17120e, roughness: 0.96 });
  const l1 = ARM_L1, l2 = ARM_L2;
  // upper arm: a heavy quilted sleeve, a steel couter over the elbow
  const upper = new THREE.Group();
  upper.add(new THREE.Mesh(lathe([[0.0, -0.01], [0.052, 0.0], [0.06, 0.07], [0.058, 0.16], [0.052, 0.25], [0.046, l1], [0.0, l1 + 0.005]]), cloth));
  for (let i = 1; i < 4; i++) {
    const quilt = new THREE.Mesh(new THREE.TorusGeometry(0.058 - i * 0.003, 0.0035, 5, 18), cloth);
    quilt.rotation.x = Math.PI / 2;
    quilt.position.y = i * 0.07;
    upper.add(quilt);
  }
  const couter = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), mats.darkSteel);
  couter.position.y = l1;
  couter.rotation.x = Math.PI / 2;
  couter.scale.set(1, 1, 0.8);
  upper.add(couter);
  // forearm (local +Y elbow → wrist, +X the back of the arm): muscled under a leather
  // bracer, strapped, a dark steel vambrace on top, a flared gauntlet cuff at the wrist
  const fore = new THREE.Group();
  fore.add(new THREE.Mesh(lathe([[0.0, -0.01], [0.041, 0.0], [0.048, 0.05], [0.05, 0.1], [0.045, 0.17], [0.037, 0.24], [0.032, 0.29], [0.031, l2], [0.0, l2 + 0.004]]), cloth));
  fore.add(new THREE.Mesh(lathe([[0.051, 0.1], [0.049, 0.15], [0.043, 0.2], [0.038, 0.25], [0.035, 0.285]]), mats.leather));
  for (const y of [0.135, 0.235]) {
    const strap = new THREE.Mesh(new THREE.TorusGeometry(y < 0.2 ? 0.05 : 0.04, 0.0045, 5, 18), mats.leather);
    strap.rotation.x = Math.PI / 2;
    strap.position.y = y;
    fore.add(strap);
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.014, 0.006), mats.darkSteel);
    buckle.position.set(0, y, -(y < 0.2 ? 0.054 : 0.044));
    fore.add(buckle);
  }
  const vg = new THREE.CylinderGeometry(0.041, 0.054, 0.17, 16, 3, true, Math.PI / 2 - 1.15, 2.3);
  const vam = new THREE.Mesh(vg, mats.darkSteel);
  vam.position.y = 0.19;
  fore.add(vam);
  const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.17, 6), mats.darkSteel);
  ridge.position.set(0.05, 0.19, 0);
  ridge.rotation.z = -0.07;
  fore.add(ridge);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.036, 0.06, 16, 1, true), mats.darkSteel);
  cuff.position.y = l2 - 0.015;
  fore.add(cuff);
  for (const o of [upper, fore]) o.traverse((m) => ((m as THREE.Mesh).isMesh ? ((m as THREE.Mesh).castShadow = false) : 0));
  parent.add(upper, fore);
  return { shoulder: SHOULDER_R.clone().setX(SHOULDER_R.x * side), upper, fore, elbow: new THREE.Vector3(), pole: new THREE.Vector3(0.8 * side, -0.6, 0.1), l1, l2 };
}

function capsuleBetween(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, len), 4, 10), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3().subVectors(b, a).normalize());
  return m;
}

/** Gauntleted fist closed around a grip that runs along the hand's local Z axis. */
export function buildGauntlet(mats: WeaponMats): THREE.Group {
  const g = new THREE.Group();
  const zc = -0.018; // hand centre along the grip, just behind the guard
  // back of the hand and the heel of the palm, sloping down to the wrist
  const back = new THREE.Mesh(new RoundedBoxGeometry(0.082, 0.034, 0.086, 3, 0.013), mats.leather);
  back.position.set(-0.034, 0.02, zc);
  back.rotation.z = -0.2;
  g.add(back);
  const heel = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.036, 0.078, 3, 0.014), mats.leather);
  heel.position.set(-0.042, -0.012, zc);
  g.add(heel);
  // four fingers curled around the grip (index by the guard, pinky by the pommel)
  const R = 0.0268;
  const at = (deg: number, r = R) => new THREE.Vector3(Math.cos((deg * Math.PI) / 180) * r, Math.sin((deg * Math.PI) / 180) * r, 0);
  const fz = [-0.05, -0.027, -0.005, 0.017];
  const fr = [0.0098, 0.0102, 0.0096, 0.0085];
  for (let i = 0; i < 4; i++) {
    const z = zc + fz[i] + 0.018;
    const r = fr[i];
    const k = at(78, R + 0.004).setZ(z).add(new THREE.Vector3(-0.004, 0.004, 0));
    const j1 = at(-2).setZ(z), j2 = at(-84).setZ(z), tip = at(i === 3 ? -128 : -138, R - 0.002).setZ(z);
    g.add(capsuleBetween(k, j1, r, mats.leather), capsuleBetween(j1, j2, r * 0.95, mats.leather), capsuleBetween(j2, tip, r * 0.88, mats.leather));
    // steel finger scale over the middle joint
    const sc = new THREE.Mesh(new THREE.SphereGeometry(r * 1.15, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), mats.darkSteel);
    sc.position.copy(j1);
    sc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), j1.clone().setZ(0).normalize());
    g.add(sc);
  }
  // thumb wraps from the palm side over the index and middle fingers
  const t0 = new THREE.Vector3(-0.05, -0.02, zc - 0.03), t1 = new THREE.Vector3(-0.014, -0.034, zc - 0.044), t2 = new THREE.Vector3(0.016, -0.03, zc - 0.04);
  g.add(capsuleBetween(t0, t1, 0.0115, mats.leather), capsuleBetween(t1, t2, 0.0102, mats.leather));
  // plates: curved knuckle guard across the proximal joints, a lame over the back of the hand
  const kp = new THREE.CylinderGeometry(R + 0.012, R + 0.012, 0.09, 12, 1, true, (95 * Math.PI) / 180, (82 * Math.PI) / 180);
  kp.rotateX(Math.PI / 2);
  const knuckles = new THREE.Mesh(kp, mats.darkSteel);
  knuckles.position.z = zc;
  g.add(knuckles);
  const lame = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.008, 0.08, 2, 0.003), mats.darkSteel);
  lame.position.set(-0.03, 0.04, zc);
  lame.rotation.z = -0.2;
  g.add(lame);
  g.traverse((m) => ((m as THREE.Mesh).isMesh ? ((m as THREE.Mesh).castShadow = false) : 0));
  return g;
}

const _t = new THREE.Vector3();
/** Two-bone IK to the wrist; `dorsal` turns the forearm so its plate faces the back of the hand. */
export function poseArm(arm: Arm, wrist: THREE.Vector3, dorsal?: THREE.Vector3) {
  solveIK(arm.shoulder, wrist, arm.l1, arm.l2, arm.pole, arm.elbow);
  orientBetween(arm.upper, arm.shoulder, arm.elbow, _t.copy(arm.pole).sub(arm.shoulder));
  orientBetween(arm.fore, arm.elbow, wrist, dorsal ?? _t.set(0, 1, 0));
}

// ───────────────────────────────────────────────────────────── trail

const TRAIL_N = 48;
export class BladeTrail {
  mesh: THREE.Mesh;
  private base: THREE.Vector3[] = [];
  private tip: THREE.Vector3[] = [];
  private age: number[] = [];
  private geo = new THREE.BufferGeometry();
  private pos = new Float32Array(TRAIL_N * 2 * 3);
  private alpha = new Float32Array(TRAIL_N * 2);
  readonly mat: THREE.ShaderMaterial;
  life = 0.09;

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_N - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: 'attribute float aAlpha; varying float vA; varying float vEdge; void main(){ vA = aAlpha; vEdge = float(gl_VertexID % 2); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uColor; varying float vA; varying float vEdge; void main(){ float a = vA * smoothstep(0.0, 1.0, vEdge); gl_FragColor = vec4(uColor * a, a); }',
      uniforms: { uColor: { value: new THREE.Color(0.55, 0.62, 0.75) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  push(base: THREE.Vector3, tip: THREE.Vector3) {
    this.base.unshift(base.clone());
    this.tip.unshift(tip.clone());
    this.age.unshift(0);
    if (this.base.length > TRAIL_N) {
      this.base.pop();
      this.tip.pop();
      this.age.pop();
    }
  }

  update(dt: number, blood: number) {
    for (let i = 0; i < this.age.length; i++) this.age[i] += dt;
    while (this.age.length && this.age[this.age.length - 1] > this.life) {
      this.base.pop();
      this.tip.pop();
      this.age.pop();
    }
    const n = this.age.length;
    const last = n ? n - 1 : 0;
    for (let i = 0; i < TRAIL_N; i++) {
      const k = Math.min(i, last);
      const b = this.base[k], t = this.tip[k];
      const o = i * 6;
      if (!b) {
        this.alpha[i * 2] = this.alpha[i * 2 + 1] = 0;
        continue;
      }
      // the trail hugs the outer half of the blade
      this.pos[o] = b.x + (t.x - b.x) * 0.62; this.pos[o + 1] = b.y + (t.y - b.y) * 0.62; this.pos[o + 2] = b.z + (t.z - b.z) * 0.62;
      this.pos[o + 3] = t.x; this.pos[o + 4] = t.y; this.pos[o + 5] = t.z;
      const a = i < n ? Math.max(0, 1 - this.age[k] / this.life) ** 2.0 * 0.22 : 0;
      this.alpha[i * 2] = a;
      this.alpha[i * 2 + 1] = a;
    }
    this.mat.uniforms.uColor.value.setRGB(0.8 + blood * 0.6, 0.85 - blood * 0.7, 1.0 - blood * 0.9);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }
}
