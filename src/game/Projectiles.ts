// Crossbow bolts: swept collision against limbs, props and terrain; bolts
// lodge in whatever they hit (and stay in severed limbs).

import * as THREE from 'three';
import type { Enemy, Corpse } from './Enemy';
import type { World } from '../world/World';
import { makeBoltMesh, type WeaponMats } from './WeaponModels';
import { audio } from '../engine/Audio';

interface Bolt {
  mesh: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  alive: boolean;
  life: number;
  damage: number;
  crit: boolean;
  explosive: boolean;
  hit: Set<number>;
}

export interface BoltHost {
  world: World;
  enemies: Enemy[];
  corpses: Corpse[];
  scene: THREE.Scene;
  onBoltHit(e: Enemy, seg: number, point: THREE.Vector3, dir: THREE.Vector3, damage: number, crit: boolean, t: number, from: THREE.Vector3): void;
  onBoltImpact(point: THREE.Vector3, dir: THREE.Vector3, explosive: boolean, surface: 'ground' | 'prop' | 'flesh'): void;
  pan(p: THREE.Vector3): { dist: number; pan: number };
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const FWD = new THREE.Vector3(0, 0, -1);

export class Projectiles {
  bolts: Bolt[] = [];
  private stuck: THREE.Object3D[] = [];

  constructor(public host: BoltHost, private mats: WeaponMats) {}

  fire(origin: THREE.Vector3, dir: THREE.Vector3, speed: number, damage: number, crit: boolean, explosive: boolean) {
    const mesh = makeBoltMesh(this.mats);
    mesh.scale.setScalar(1.2);
    this.host.scene.add(mesh);
    this.bolts.push({ mesh, pos: origin.clone(), vel: dir.clone().multiplyScalar(speed), alive: true, life: 6, damage, crit, explosive, hit: new Set() });
  }

  private lodge(mesh: THREE.Object3D, parent: THREE.Object3D | null) {
    if (parent) parent.attach(mesh);
    this.stuck.push(mesh);
    if (this.stuck.length > 40) {
      const old = this.stuck.shift()!;
      old.parent?.remove(old);
    }
  }

  update(dt: number) {
    const h = this.host;
    for (const b of this.bolts) {
      if (!b.alive) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.alive = false;
        h.scene.remove(b.mesh);
        continue;
      }
      b.vel.y -= 9.81 * 0.35 * dt;
      const p0 = b.pos;
      const p1 = _a.copy(p0).addScaledVector(b.vel, dt);
      const dir = _b.copy(b.vel).normalize();
      // flesh
      let bestT = 2;
      let bestE: Enemy | null = null;
      let bestSeg = -1;
      let bestPt: THREE.Vector3 | null = null;
      let bestSegT = 0.5;
      for (const e of h.enemies) {
        if (!e.alive || b.hit.has(e.id)) continue;
        if (e.pos.distanceToSquared(p0) > 100 + b.vel.lengthSq() * dt * dt) continue;
        const r = e.testSegment(p0, p1, 0.03);
        if (r) {
          const t = r.point.distanceTo(p0) / Math.max(p0.distanceTo(p1), 1e-4);
          if (t < bestT) {
            bestT = t;
            bestE = e;
            bestSeg = r.seg;
            bestPt = r.point;
            bestSegT = r.t;
          }
        }
      }
      // props / terrain
      const tp = h.world.raycastProps(p0, p1);
      let tg = -1;
      if (p1.y < h.world.height(p1.x, p1.z)) {
        let lo = 0, hi = 1;
        for (let i = 0; i < 8; i++) {
          const m = (lo + hi) / 2;
          const x = p0.x + (p1.x - p0.x) * m, y = p0.y + (p1.y - p0.y) * m, z = p0.z + (p1.z - p0.z) * m;
          if (y < h.world.height(x, z)) hi = m;
          else lo = m;
        }
        tg = hi;
      }
      const tw = tp >= 0 && tg >= 0 ? Math.min(tp, tg) : Math.max(tp, tg);
      if (bestE && (tw < 0 || bestT <= tw)) {
        const vis = bestE.vis[bestSeg];
        const pt = bestPt!;
        b.hit.add(bestE.id);
        h.onBoltHit(bestE, bestSeg, pt, dir.clone(), b.damage, b.crit, bestSegT, p0.clone().addScaledVector(dir, -1));
        h.onBoltImpact(pt, dir.clone(), b.explosive, 'flesh');
        b.alive = false;
        b.mesh.position.copy(pt).addScaledVector(dir, 0.06);
        b.mesh.quaternion.copy(_q.setFromUnitVectors(FWD, dir));
        this.lodge(b.mesh, vis);
        continue;
      }
      if (tw >= 0) {
        const pt = new THREE.Vector3().lerpVectors(p0, p1, tw);
        b.alive = false;
        b.mesh.position.copy(pt).addScaledVector(dir, 0.12);
        b.mesh.quaternion.copy(_q.setFromUnitVectors(FWD, dir));
        this.lodge(b.mesh, null);
        const s = h.pan(pt);
        audio.play(tp >= 0 && (tg < 0 || tp < tg) ? 'boltWood' : 'boltHit', { dist: s.dist, pan: s.pan, vol: 0.6 });
        h.onBoltImpact(pt, dir.clone(), b.explosive, tp >= 0 && (tg < 0 || tp < tg) ? 'prop' : 'ground');
        continue;
      }
      b.pos.copy(p1);
      b.mesh.position.copy(p1);
      b.mesh.quaternion.copy(_q.setFromUnitVectors(FWD, dir));
    }
    this.bolts = this.bolts.filter((b) => b.alive);
  }

  clear() {
    for (const b of this.bolts) this.host.scene.remove(b.mesh);
    for (const s of this.stuck) s.parent?.remove(s);
    this.bolts = [];
    this.stuck = [];
  }
}
