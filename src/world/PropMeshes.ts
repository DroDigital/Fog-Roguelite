// Procedural prop geometry. Each generator produces a BufferGeometry from a
// seed, so the world gets endless variation without authored meshes. When a
// Blender-exported GLB with the same prop id exists, AssetLibrary uses it
// instead (see src/engine/Assets.ts and tools/blender/).

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RNG, Noise2D } from '../engine/Random';

const up = new THREE.Vector3(0, 1, 0);

function tube(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, radial: number, uvScale = 1): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, Math.max(1, Math.round(len / 1.2)), true);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const circ = Math.max(1, Math.round((Math.PI * 2 * Math.max(r0, r1)) / 0.6));
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ * uvScale, uv.getY(i) * len * 0.5 * uvScale);
  g.translate(0, len / 2, 0);
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

function randomDir(rng: RNG, base: THREE.Vector3, spreadDeg: number) {
  const s = THREE.MathUtils.degToRad(spreadDeg);
  const yaw = rng.range(0, Math.PI * 2);
  const pitch = rng.range(s * 0.4, s);
  const perp = new THREE.Vector3().crossVectors(base, Math.abs(base.y) < 0.9 ? up : new THREE.Vector3(1, 0, 0)).normalize();
  const d = base.clone().applyAxisAngle(perp, pitch).applyAxisAngle(base, yaw);
  return d.normalize();
}

/** Gnarled dead tree: recursive bent branches merged into one mesh. */
export function makeDeadTree(seed: number): THREE.BufferGeometry {
  const rng = new RNG(seed);
  const parts: THREE.BufferGeometry[] = [];
  const height = rng.range(6, 11);
  const baseR = rng.range(0.22, 0.38);

  const grow = (start: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number) => {
    const segs = 3;
    let p = start.clone();
    let d = dir.clone();
    let rr = r;
    for (let i = 0; i < segs; i++) {
      const segLen = len / segs;
      d = d.add(new THREE.Vector3(rng.range(-0.35, 0.35), rng.range(-0.1, 0.25), rng.range(-0.35, 0.35))).normalize();
      if (depth > 0) d.y = Math.max(d.y, -0.2);
      const next = p.clone().addScaledVector(d, segLen);
      const rNext = rr * (depth === 0 ? 0.78 : 0.7);
      parts.push(tube(p, next, rr, rNext, depth === 0 ? 9 : depth < 2 ? 6 : 4));
      // knuckle at the joint keeps bends from showing gaps
      if (depth < 2) {
        const k = new THREE.SphereGeometry(rNext * 1.02, depth === 0 ? 9 : 6, 4);
        k.translate(next.x, next.y, next.z);
        parts.push(k);
      }
      if (depth < 3 && i > 0 && rng.chance(depth === 0 ? 0.85 : 0.6)) {
        const nb = depth === 0 ? rng.int(1, 2) : 1;
        for (let k = 0; k < nb; k++) {
          grow(next.clone(), randomDir(rng, d, 70), len * rng.range(0.45, 0.65), rNext * 0.62, depth + 1);
        }
      }
      p = next;
      rr = rNext;
    }
    if (depth < 3) {
      const n = rng.int(1, 3);
      for (let k = 0; k < n; k++) grow(p.clone(), randomDir(rng, d, 45), len * rng.range(0.5, 0.7), rr * 0.75, depth + 1);
    }
  };

  // Root flare
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const end = new THREE.Vector3(Math.cos(a) * rng.range(0.8, 1.4), -0.3, Math.sin(a) * rng.range(0.8, 1.4));
    parts.push(tube(new THREE.Vector3(0, 0.5, 0), end, baseR * 0.55, 0.05, 5));
  }
  grow(new THREE.Vector3(0, -0.4, 0), new THREE.Vector3(rng.range(-0.1, 0.1), 1, rng.range(-0.1, 0.1)).normalize(), height, baseR, 0);

  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()), false)!;
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Eroded boulder: displaced icosphere. */
export function makeRock(seed: number, flat = 0.7): THREE.BufferGeometry {
  const rng = new RNG(seed);
  const n = new Noise2D(seed);
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 4);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const sx = rng.range(0.8, 1.4), sz = rng.range(0.8, 1.4);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const lat = Math.atan2(v.y, Math.hypot(v.x, v.z));
    const lon = Math.atan2(v.z, v.x);
    let d = 1 + n.fbm(lon * 1.3 + 10, lat * 1.3, 4) * 0.35 + n.ridged(v.x * 2 + 3, v.z * 2 + v.y, 3) * 0.12;
    // chisel planes for a fractured look
    d = Math.min(d, 1.05 + n.noise(lon * 0.5, 3) * 0.1);
    v.multiplyScalar(d);
    v.x *= sx;
    v.z *= sz;
    v.y *= flat;
    if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.3;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Weathered gravestone with rounded or pointed head. */
export function makeGravestone(seed: number): THREE.BufferGeometry {
  const rng = new RNG(seed);
  const w = rng.range(0.45, 0.7), h = rng.range(0.8, 1.3), t = rng.range(0.12, 0.2);
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(w / 2, h);
  const style = rng.int(0, 2);
  if (style === 0) shape.absarc(0, h, w / 2, 0, Math.PI, false);
  else if (style === 1) shape.lineTo(0, h + w * 0.45);
  else {
    // cross
    shape.lineTo(w * 0.15, h);
    shape.lineTo(w * 0.15, h + 0.45);
    shape.lineTo(-w * 0.15, h + 0.45);
    shape.lineTo(-w * 0.15, h);
  }
  shape.lineTo(-w / 2, h);
  shape.lineTo(-w / 2, 0);
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2, curveSegments: 10, steps: 1 });
  g.translate(0, -0.25, -t / 2);
  g = erode(g, seed, 0.025);
  // chipped corner
  return g;
}

/** Tall menhir / standing stone. */
export function makeMenhir(seed: number): THREE.BufferGeometry {
  const rng = new RNG(seed);
  let g: THREE.BufferGeometry = new THREE.BoxGeometry(rng.range(0.9, 1.4), rng.range(3, 5.5), rng.range(0.6, 0.9), 4, 12, 4);
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox!.min.y - 0.5, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const top = g.boundingBox!.max.y - g.boundingBox!.min.y - 0.5;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const taper = 1 - (y / top) * 0.35;
    pos.setX(i, pos.getX(i) * taper + Math.sin(y * 0.7 + seed) * 0.08);
    pos.setZ(i, pos.getZ(i) * taper);
    if (y > top - 0.6) pos.setY(i, y - Math.abs(pos.getX(i)) * 0.6);
  }
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  g = erode(g, seed, 0.09);
  return g;
}

/** Broken colonnade drum stack. */
export function makePillar(seed: number): THREE.BufferGeometry {
  const rng = new RNG(seed);
  const parts: THREE.BufferGeometry[] = [];
  const r = rng.range(0.4, 0.55);
  const base = new THREE.BoxGeometry(r * 2.8, 0.5, r * 2.8);
  base.translate(0, -0.05, 0);
  parts.push(base);
  let y = 0.2;
  const drums = rng.int(1, 5);
  for (let i = 0; i < drums; i++) {
    const h = rng.range(0.7, 1.1);
    const c = new THREE.CylinderGeometry(r * 0.95, r, h, 16, 2);
    c.rotateY(rng.range(0, 1));
    c.translate(rng.range(-0.04, 0.04), y + h / 2, rng.range(-0.04, 0.04));
    parts.push(c);
    y += h;
  }
  let g = mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); return p.toNonIndexed(); }))!;
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  g = erode(g, seed, 0.04);
  return g;
}

/** Ruined wall section with jagged top. */
export function makeWall(seed: number): THREE.BufferGeometry {
  const rng = new RNG(seed);
  const len = rng.range(3, 6);
  let g: THREE.BufferGeometry = new THREE.BoxGeometry(len, 3, 0.7, 16, 10, 2);
  g.translate(0, 1.0, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = new Noise2D(seed);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    if (y > 0) {
      const cut = 0.4 + (n.fbm(x * 0.5, 1.3, 3) * 0.5 + 0.5) * 2.2;
      pos.setY(i, Math.min(y, cut - 0.5 + y * 0.2));
    }
  }
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  g = erode(g, seed, 0.06);
  return g;
}

/** Shrine: stepped plinth and a stone bowl (the flame is a separate effect). */
export function makeShrine(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const s1 = new THREE.CylinderGeometry(1.6, 1.8, 0.4, 8);
  s1.translate(0, 0.0, 0);
  const s2 = new THREE.CylinderGeometry(1.1, 1.3, 0.4, 8);
  s2.translate(0, 0.4, 0);
  const col = new THREE.CylinderGeometry(0.3, 0.4, 1.0, 8);
  col.translate(0, 1.1, 0);
  const bowl = new THREE.SphereGeometry(0.6, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  bowl.scale(1, 0.55, 1);
  bowl.translate(0, 1.85, 0);
  const rim = new THREE.TorusGeometry(0.58, 0.07, 6, 16);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 1.85, 0);
  parts.push(s1, s2, col, bowl, rim);
  let g = mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); return p.toNonIndexed(); }))!;
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  g = erode(g, 7, 0.02);
  return g;
}

/** Iron-banded reliquary chest. Returns body and lid separately. */
export function makeChest(): { body: THREE.BufferGeometry; lid: THREE.BufferGeometry; bands: THREE.BufferGeometry } {
  const body = new THREE.BoxGeometry(1.1, 0.6, 0.7);
  body.translate(0, 0.3, 0);
  const lid = new THREE.CylinderGeometry(0.35, 0.35, 1.1, 12, 1, false, 0, Math.PI);
  lid.rotateZ(Math.PI / 2);
  lid.rotateX(Math.PI / 2);
  lid.translate(0, 0, 0.35); // pivot at back edge
  const bandParts: THREE.BufferGeometry[] = [];
  for (const x of [-0.42, 0, 0.42]) {
    const b = new THREE.BoxGeometry(0.08, 0.62, 0.72);
    b.translate(x, 0.3, 0);
    bandParts.push(b);
  }
  const lock = new THREE.BoxGeometry(0.16, 0.2, 0.06);
  lock.translate(0, 0.5, 0.37);
  bandParts.push(lock);
  const bands = mergeGeometries(bandParts)!;
  return { body, lid, bands };
}

/** Dead grass tuft: a fan of tapered blades (vertex colour gives root→tip gradient). */
export function makeGrassTuft(seed: number): THREE.BufferGeometry {
  const rng = new RNG(seed);
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const blades = 9;
  for (let b = 0; b < blades; b++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(0, 0.18);
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const h = rng.range(0.35, 0.8);
    const w = rng.range(0.01, 0.02);
    const lean = rng.range(0.1, 0.5);
    const la = a + rng.range(-0.6, 0.6);
    const lx = Math.cos(la) * lean, lz = Math.sin(la) * lean;
    const px = -Math.sin(la) * w, pz = Math.cos(la) * w;
    const segs = 3;
    const tint = rng.range(0.7, 1.15);
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs, t1 = (s + 1) / segs;
      const y0 = h * t0, y1 = h * t1;
      const o0 = t0 * t0, o1 = t1 * t1;
      const w0 = 1 - t0, w1 = 1 - t1;
      const p = [
        [bx - px * w0 + lx * o0, y0, bz - pz * w0 + lz * o0],
        [bx + px * w0 + lx * o0, y0, bz + pz * w0 + lz * o0],
        [bx + px * w1 + lx * o1, y1, bz + pz * w1 + lz * o1],
        [bx - px * w1 + lx * o1, y1, bz - pz * w1 + lz * o1],
      ];
      const tri = [0, 1, 2, 0, 2, 3];
      for (const i of tri) {
        positions.push(...p[i]);
        const t = p[i][1] / h;
        colors.push((0.05 + t * 0.16) * tint, (0.045 + t * 0.12) * tint, (0.025 + t * 0.06) * tint);
        normals.push(0, 1, 0); // up-facing normals: soft, fog-friendly lighting
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeBoundingSphere();
  return g;
}

/** Iron gibbet / lantern post. */
export function makeLanternPost(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const pole = new THREE.CylinderGeometry(0.06, 0.08, 3.2, 6);
  pole.translate(0, 1.6, 0);
  const arm = new THREE.BoxGeometry(0.8, 0.06, 0.06);
  arm.translate(0.4, 3.1, 0);
  const cage = new THREE.CylinderGeometry(0.14, 0.18, 0.35, 6, 1, true);
  cage.translate(0.75, 2.8, 0);
  const cap = new THREE.ConeGeometry(0.22, 0.2, 6);
  cap.translate(0.75, 3.07, 0);
  parts.push(pole, arm, cage, cap);
  return mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); return p.toNonIndexed(); }))!;
}

function erode(g: THREE.BufferGeometry, seed: number, amt: number): THREE.BufferGeometry {
  if (!g.index) {
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
  }
  g.computeVertexNormals();
  const n = new Noise2D(seed + 77);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const d = (n.fbm(x * 2.1 + z * 0.7, y * 2.1 - z * 0.9, 4) - 0.2) * amt;
    pos.setXYZ(i, x + nor.getX(i) * d, y + nor.getY(i) * d, z + nor.getZ(i) * d);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Beacon tower: stepped plinth, tall weathered column and an iron fire cage. */
export function makeBeacon(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, y: number) => {
    g.translate(0, y, 0);
    g.deleteAttribute('uv');
    parts.push(g.toNonIndexed());
  };
  add(new THREE.CylinderGeometry(2.6, 3.0, 0.5, 10), 0.0);
  add(new THREE.CylinderGeometry(2.0, 2.3, 0.5, 10), 0.5);
  add(new THREE.CylinderGeometry(1.5, 1.7, 0.5, 10), 1.0);
  add(new THREE.CylinderGeometry(0.75, 0.95, 5.5, 10, 6), 4.0);
  add(new THREE.CylinderGeometry(1.15, 0.8, 0.5, 10), 6.95);
  let g = mergeGeometries(parts)!;
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  g = erode(g, 31, 0.05);
  return g;
}

/** Iron fire cage sitting on top of the beacon column. */
export function makeBeaconCage(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const bar = new THREE.BoxGeometry(0.07, 1.3, 0.07);
    bar.rotateZ(0.25);
    bar.rotateY(-a);
    bar.translate(Math.cos(a) * 0.95, 0.6, Math.sin(a) * 0.95);
    parts.push(bar);
  }
  const ring = new THREE.TorusGeometry(1.15, 0.05, 5, 16);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 1.2, 0);
  parts.push(ring.toNonIndexed());
  const base = new THREE.CylinderGeometry(0.95, 0.75, 0.15, 12);
  parts.push(base.toNonIndexed());
  return mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); return p.index ? p.toNonIndexed() : p; }))!;
}
