// First-person melee animation: keyframed swing curves with anticipation,
// acceleration through the strike, overshoot and settle; plus the arms that
// hold the weapon and a world-space blade trail.

import * as THREE from 'three';
import { orientBetween, solveIK } from './Body';
import type { WeaponMats } from './WeaponModels';

/** Weapon pose relative to the shoulder pivot: yaw, pitch, wrist roll, hand extension. */
export interface Pose { y: number; p: number; r: number; e: number }
type Ease = 'lin' | 'in' | 'out' | 'inout';
export interface Key { t: number; pose: Pose; ease?: Ease }
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

const P = (y: number, p: number, r: number, e: number): Pose => ({ y, p, r, e });

export const IDLE: Pose = P(0.22, 0.72, -0.35, 0.36);
export const BLOCK: Pose = P(1.25, 0.38, 0.25, 0.36);

/**
 * Timings are for a speed-1.0 weapon. Each light move:
 *   start → anticipation (cock back) → load (slow) → strike (accelerating, extended)
 *   → follow-through (overshoot, wrist rolls over) → settle → idle.
 */
export const MOVES: Record<string, MoveDef> = {
  slashR: {
    keys: [
      { t: 0, pose: IDLE },
      { t: 0.11, pose: P(-0.95, 0.55, 0.35, 0.28), ease: 'out' },
      { t: 0.2, pose: P(-1.25, 0.42, 0.2, 0.29), ease: 'out' },
      { t: 0.255, pose: P(-0.35, 0.04, 0.05, 0.44), ease: 'in' },
      { t: 0.31, pose: P(1.05, -0.22, -0.05, 0.4), ease: 'lin' },
      { t: 0.4, pose: P(1.5, -0.38, -0.45, 0.3), ease: 'out' },
      { t: 0.55, pose: P(1.2, -0.05, -0.3, 0.32), ease: 'inout' },
      { t: 0.74, pose: IDLE, ease: 'inout' },
    ],
    hit: [0.2, 0.36], dmg: 1, sever: 1, stamina: 1, step: 2.2,
  },
  slashL: {
    keys: [
      { t: 0, pose: IDLE },
      { t: 0.1, pose: P(0.95, 0.42, -0.25, 0.28), ease: 'out' },
      { t: 0.19, pose: P(1.28, 0.25, -0.2, 0.29), ease: 'out' },
      { t: 0.245, pose: P(0.35, 0.02, -0.05, 0.44), ease: 'in' },
      { t: 0.3, pose: P(-1.0, 0.18, 0.05, 0.4), ease: 'lin' },
      { t: 0.39, pose: P(-1.5, 0.42, 0.45, 0.3), ease: 'out' },
      { t: 0.54, pose: P(-0.9, 0.55, 0.1, 0.32), ease: 'inout' },
      { t: 0.72, pose: IDLE, ease: 'inout' },
    ],
    hit: [0.19, 0.35], dmg: 1, sever: 1, stamina: 1, step: 2.2,
  },
  diag: {
    keys: [
      { t: 0, pose: IDLE },
      { t: 0.13, pose: P(-0.6, 1.45, 0.95, 0.24), ease: 'out' },
      { t: 0.23, pose: P(-0.75, 1.75, 0.85, 0.23), ease: 'out' },
      { t: 0.29, pose: P(-0.05, 0.55, 0.8, 0.45), ease: 'in' },
      { t: 0.345, pose: P(0.75, -0.65, 0.8, 0.42), ease: 'lin' },
      { t: 0.44, pose: P(1.0, -1.0, 0.55, 0.32), ease: 'out' },
      { t: 0.6, pose: P(0.7, -0.4, 0.2, 0.33), ease: 'inout' },
      { t: 0.8, pose: IDLE, ease: 'inout' },
    ],
    hit: [0.23, 0.39], dmg: 1.12, sever: 1.15, stamina: 1.1, step: 2.6,
  },
  heavy: {
    keys: [
      { t: 0, pose: IDLE },
      { t: 0.22, pose: P(-0.12, 2.0, Math.PI / 2, 0.24), ease: 'out' },
      { t: 0.32, pose: P(-0.16, 2.4, Math.PI / 2, 0.2), ease: 'out' }, // held while charging
      { t: 0.39, pose: P(-0.06, 0.9, Math.PI / 2, 0.46), ease: 'in' },
      { t: 0.45, pose: P(0.05, -0.85, Math.PI / 2, 0.5), ease: 'lin' },
      { t: 0.53, pose: P(0.07, -1.12, Math.PI / 2 + 0.08, 0.46), ease: 'out' }, // bites into the ground
      { t: 0.78, pose: P(0.1, -0.85, 1.2, 0.4), ease: 'inout' },
      { t: 1.05, pose: IDLE, ease: 'inout' },
    ],
    hit: [0.33, 0.52], dmg: 2.1, sever: 1.8, stamina: 1.9, heavy: true, step: 3.6, holdKey: 2,
  },
};
export const COMBO = ['slashR', 'slashL', 'diag'];

function ease(u: number, e: Ease | undefined) {
  switch (e) {
    case 'in':
      return u * u * u;
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

/** Evaluate a move at time t (seconds, unscaled) along a Catmull-Rom path through its keys. */
export function evalMove(def: MoveDef, t: number, start: Pose, out: Pose): Pose {
  const k = def.keys;
  const kp = (i: number) => (i <= 0 ? start : k[Math.min(i, k.length - 1)].pose);
  let i = 0;
  while (i < k.length - 2 && t >= k[i + 1].t) i++;
  const t0 = k[i].t, t1 = k[i + 1].t;
  const u = ease(Math.min(1, Math.max(0, (t - t0) / Math.max(1e-4, t1 - t0))), k[i + 1].ease);
  const a = kp(i - 1), b = kp(i), c = kp(i + 1), d = kp(i + 2);
  out.y = CR(a.y, b.y, c.y, d.y, u);
  out.p = CR(a.p, b.p, c.p, d.p, u);
  out.r = CR(a.r, b.r, c.r, d.r, u);
  out.e = CR(a.e, b.e, c.e, d.e, u);
  return out;
}

export function moveLength(def: MoveDef) {
  return def.keys[def.keys.length - 1].t;
}

// ───────────────────────────────────────────────────────────── arms

export interface Arm {
  shoulder: THREE.Vector3;
  upper: THREE.Mesh;
  fore: THREE.Group;
  elbow: THREE.Vector3;
  pole: THREE.Vector3;
  l1: number;
  l2: number;
}

export function buildArm(parent: THREE.Object3D, mats: WeaponMats, side: 1 | -1): Arm {
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x0f0c0a, roughness: 0.9 });
  const l1 = 0.32, l2 = 0.3;
  const ug = new THREE.CylinderGeometry(0.048, 0.058, l1, 10);
  ug.translate(0, l1 / 2, 0);
  const upper = new THREE.Mesh(ug, sleeve);
  const fore = new THREE.Group();
  const fg = new THREE.CylinderGeometry(0.036, 0.046, l2, 10);
  fg.translate(0, l2 / 2, 0);
  fore.add(new THREE.Mesh(fg, sleeve));
  // vambrace: half shell of dark steel on the outside of the forearm
  const vg = new THREE.CylinderGeometry(0.044, 0.052, l2 * 0.62, 12, 1, true, -Math.PI * 0.55, Math.PI * 1.1);
  vg.translate(0, l2 * 0.55, 0);
  const vam = new THREE.Mesh(vg, mats.darkSteel);
  vam.rotation.y = side > 0 ? Math.PI : 0;
  fore.add(vam);
  for (const o of [upper, fore]) o.traverse((m) => ((m as THREE.Mesh).isMesh ? ((m as THREE.Mesh).castShadow = false) : 0));
  parent.add(upper, fore);
  return { shoulder: new THREE.Vector3(0.2 * side, -0.4, 0.1), upper, fore, elbow: new THREE.Vector3(), pole: new THREE.Vector3(0.8 * side, -0.55, 0.1), l1, l2 };
}

/** Gauntleted fist closed around a grip that runs along the hand's local Z axis. */
export function buildGauntlet(mats: WeaponMats): THREE.Group {
  const g = new THREE.Group();
  // palm under the grip, fingers curling over it, plated knuckles, thumb along the side
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.03, 0.085), mats.leather);
  palm.position.set(0.006, -0.026, 0.005);
  g.add(palm);
  for (let i = 0; i < 4; i++) {
    const z = -0.03 + i * 0.02;
    const prox = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.026, 0.018), mats.leather);
    prox.position.set(0.026, -0.004, z);
    const mid = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.016, 0.018), mats.darkSteel);
    mid.position.set(0.006, 0.022, z);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.022, 0.017), mats.leather);
    tip.position.set(-0.016, 0.008, z);
    g.add(prox, mid, tip);
  }
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.04, 3, 6), mats.leather);
  thumb.rotation.x = Math.PI / 2;
  thumb.position.set(-0.02, -0.012, -0.022);
  g.add(thumb);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.038, 0.06, 10, 1, true), mats.darkSteel);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0.006, -0.012, 0.075);
  g.add(cuff);
  return g;
}

const _t = new THREE.Vector3();
export function poseArm(arm: Arm, wrist: THREE.Vector3) {
  solveIK(arm.shoulder, wrist, arm.l1, arm.l2, arm.pole, arm.elbow);
  orientBetween(arm.upper, arm.shoulder, arm.elbow);
  orientBetween(arm.fore, arm.elbow, wrist, _t.set(0, 1, 0));
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
