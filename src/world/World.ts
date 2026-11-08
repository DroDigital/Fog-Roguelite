// Chunked infinite world: streams terrain + props around the player and
// exposes collision / height queries to gameplay.

import * as THREE from 'three';
import { Terrain, Biome } from './Terrain';
import { RNG, hash2 } from '../engine/Random';
import type { TextureGen } from '../render/TextureGen';
import { makeTerrainMaterial, makeTriplanar, addWind } from '../render/MaterialPatches';
import * as PM from './PropMeshes';
import { assets } from '../engine/Assets';

export const CHUNK = 32;
const RES = 32;
const VIEW_R = 2;

export interface Collider { x: number; z: number; r: number; h: number; y: number }
export type POIKind = 'chest' | 'shrine' | 'lantern' | 'lair' | 'altar' | 'beacon';
export const BEACON_REGION = 4; // chunks per side of a beacon region
export interface POI { kind: POIKind; id: string; x: number; y: number; z: number; rot: number; tier: number }
interface PropInst { type: string; variant: number; m: THREE.Matrix4 }

export interface Chunk {
  cx: number;
  cz: number;
  key: string;
  mesh: THREE.Mesh;
  props: PropInst[];
  grass: THREE.Matrix4[];
  colliders: Collider[];
  pois: POI[];
}

interface PropType {
  id: string;
  variants: THREE.BufferGeometry[];
  material: THREE.Material;
  shadow: boolean;
  mesh: THREE.InstancedMesh[];
}

export class World {
  terrain: Terrain;
  chunks = new Map<string, Chunk>();
  group = new THREE.Group();
  private terrainMat: THREE.MeshStandardMaterial;
  private propTypes = new Map<string, PropType>();
  private grassMesh: THREE.InstancedMesh;
  private grassGeo: THREE.BufferGeometry;
  private dirty = true;
  private lastGrassCenter = new THREE.Vector2(1e9, 1e9);
  onChunkLoad: (c: Chunk) => void = () => {};
  onChunkUnload: (c: Chunk) => void = () => {};
  private tmpN = { x: 0, y: 1, z: 0 };

  constructor(public seed: number, tex: TextureGen) {
    this.terrain = new Terrain(seed);
    this.terrainMat = makeTerrainMaterial(tex.get('mud', 1024, 3), tex.get('grass', 1024, 5), tex.get('rock', 1024, 9));
    this.terrainMat.normalScale.set(1.4, 1.4);

    const bark = tex.material('bark', 512, { metalness: 0 });
    addWind(bark, 0.05, 0.12);
    const stone = makeTriplanar(tex.material('rock', 1024, { metalness: 0 }), 0.6, 1);
    const ruin = makeTriplanar(tex.material('rock', 1024, { metalness: 0, color: new THREE.Color(0.85, 0.82, 0.78) }), 0.9, 1);

    const def = (id: string, variants: THREE.BufferGeometry[], material: THREE.Material, shadow = true) => {
      const override = assets.geometry(id);
      this.propTypes.set(id, { id, variants: override ? [override] : variants, material, shadow, mesh: [] });
    };
    def('tree', [1, 2, 3, 4, 5, 6].map((s) => PM.makeDeadTree(seed * 13 + s)), bark);
    def('rock', [1, 2, 3, 4, 5].map((s) => PM.makeRock(seed * 7 + s)), stone);
    def('grave', [1, 2, 3, 4].map((s) => PM.makeGravestone(seed * 3 + s)), ruin);
    def('menhir', [1, 2, 3].map((s) => PM.makeMenhir(seed * 5 + s)), stone);
    def('pillar', [1, 2, 3].map((s) => PM.makePillar(seed * 11 + s)), ruin);
    def('wall', [1, 2, 3].map((s) => PM.makeWall(seed * 17 + s)), ruin);
    def('shrine', [PM.makeShrine()], ruin);
    const iron = new THREE.MeshStandardMaterial({ color: 0x1a1816, roughness: 0.55, metalness: 0.85 });
    def('lantern', [PM.makeLanternPost()], iron);
    def('beacon', [PM.makeBeacon()], ruin);
    def('beaconCage', [PM.makeBeaconCage()], iron, false);

    for (const pt of this.propTypes.values()) {
      for (const g of pt.variants) {
        const im = new THREE.InstancedMesh(g, pt.material, 256);
        im.count = 0;
        im.castShadow = pt.shadow;
        im.receiveShadow = true;
        im.frustumCulled = false;
        pt.mesh.push(im);
        this.group.add(im);
      }
    }

    this.grassGeo = PM.makeGrassTuft(seed);
    const grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    addWind(grassMat, 0.35, 1.6);
    this.grassMesh = new THREE.InstancedMesh(this.grassGeo, grassMat, 12000);
    this.grassMesh.count = 0;
    this.grassMesh.frustumCulled = false;
    this.grassMesh.receiveShadow = true;
    this.group.add(this.grassMesh);
  }

  height(x: number, z: number) {
    return this.terrain.height(x, z);
  }

  update(px: number, pz: number, budget = 2) {
    const ccx = Math.floor(px / CHUNK), ccz = Math.floor(pz / CHUNK);
    // load missing chunks nearest-first
    const want: [number, number, number][] = [];
    for (let dz = -VIEW_R; dz <= VIEW_R; dz++)
      for (let dx = -VIEW_R; dx <= VIEW_R; dx++) {
        const key = `${ccx + dx},${ccz + dz}`;
        if (!this.chunks.has(key)) want.push([ccx + dx, ccz + dz, dx * dx + dz * dz]);
      }
    want.sort((a, b) => a[2] - b[2]);
    for (let i = 0; i < Math.min(budget, want.length); i++) {
      const c = this.generate(want[i][0], want[i][1]);
      this.chunks.set(c.key, c);
      this.group.add(c.mesh);
      this.onChunkLoad(c);
      this.dirty = true;
    }
    for (const [key, c] of this.chunks) {
      if (Math.abs(c.cx - ccx) > VIEW_R + 1 || Math.abs(c.cz - ccz) > VIEW_R + 1) {
        this.group.remove(c.mesh);
        c.mesh.geometry.dispose();
        this.chunks.delete(key);
        this.onChunkUnload(c);
        this.dirty = true;
      }
    }
    if (this.dirty) this.rebuildProps();
    if (this.dirty || Math.hypot(px - this.lastGrassCenter.x, pz - this.lastGrassCenter.y) > 8) {
      this.rebuildGrass(px, pz);
    }
    this.dirty = false;
  }

  /** Generate everything until the area around (x,z) is fully loaded. */
  preload(x: number, z: number) {
    this.update(x, z, 999);
  }

  private rebuildProps() {
    const counts = new Map<THREE.InstancedMesh, number>();
    for (const pt of this.propTypes.values()) for (const m of pt.mesh) counts.set(m, 0);
    for (const c of this.chunks.values()) {
      for (const p of c.props) {
        const pt = this.propTypes.get(p.type)!;
        let im = pt.mesh[p.variant % pt.mesh.length];
        let n = counts.get(im)!;
        if (n >= im.instanceMatrix.count) {
          // grow
          const bigger = new THREE.InstancedMesh(im.geometry, im.material, im.instanceMatrix.count * 2);
          bigger.castShadow = im.castShadow;
          bigger.receiveShadow = true;
          bigger.frustumCulled = false;
          for (let i = 0; i < n; i++) {
            const mm = new THREE.Matrix4();
            im.getMatrixAt(i, mm);
            bigger.setMatrixAt(i, mm);
          }
          this.group.remove(im);
          this.group.add(bigger);
          pt.mesh[pt.mesh.indexOf(im)] = bigger;
          counts.delete(im);
          im.dispose();
          im = bigger;
        }
        im.setMatrixAt(n, p.m);
        counts.set(im, n + 1);
      }
    }
    for (const [im, n] of counts) {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    }
  }

  private rebuildGrass(px: number, pz: number) {
    this.lastGrassCenter.set(px, pz);
    let n = 0;
    const max = this.grassMesh.instanceMatrix.count;
    const R2 = 46 * 46;
    const tmp = new THREE.Vector3();
    for (const c of this.chunks.values()) {
      const ox = (c.cx + 0.5) * CHUNK - px, oz = (c.cz + 0.5) * CHUNK - pz;
      if (ox * ox + oz * oz > (46 + CHUNK) * (46 + CHUNK)) continue;
      for (const m of c.grass) {
        tmp.setFromMatrixPosition(m);
        const dx = tmp.x - px, dz = tmp.z - pz;
        if (dx * dx + dz * dz > R2) continue;
        if (n >= max) break;
        this.grassMesh.setMatrixAt(n++, m);
      }
    }
    this.grassMesh.count = n;
    this.grassMesh.instanceMatrix.needsUpdate = true;
  }

  private generate(cx: number, cz: number): Chunk {
    const t = this.terrain;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const N = RES + 1;
    const step = CHUNK / RES;
    // heights with 1-cell border for normals
    const H = new Float32Array((N + 2) * (N + 2));
    for (let j = -1; j <= N; j++)
      for (let i = -1; i <= N; i++) H[(j + 1) * (N + 2) + (i + 1)] = t.height(x0 + i * step, z0 + j * step);
    const pos = new Float32Array(N * N * 3);
    const nor = new Float32Array(N * N * 3);
    const uv = new Float32Array(N * N * 2);
    const spl = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const h = H[(j + 1) * (N + 2) + (i + 1)];
        pos[k * 3] = i * step;
        pos[k * 3 + 1] = h;
        pos[k * 3 + 2] = j * step;
        const hl = H[(j + 1) * (N + 2) + i], hr = H[(j + 1) * (N + 2) + i + 2];
        const hd = H[j * (N + 2) + i + 1], hu = H[(j + 2) * (N + 2) + i + 1];
        let nx = hl - hr, ny = 2 * step, nz = hd - hu;
        const l = Math.hypot(nx, ny, nz);
        nx /= l; ny /= l; nz /= l;
        nor[k * 3] = nx; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = nz;
        uv[k * 2] = (x0 + i * step) * 0.25;
        uv[k * 2 + 1] = (z0 + j * step) * 0.25;
        const s = t.splat(x0 + i * step, z0 + j * step, ny);
        spl[k * 3] = s[0]; spl[k * 3 + 1] = s[1]; spl[k * 3 + 2] = s[2];
      }
    const idx = new Uint32Array(RES * RES * 6);
    let q = 0;
    for (let j = 0; j < RES; j++)
      for (let i = 0; i < RES; i++) {
        const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('splat', new THREE.BufferAttribute(spl, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.terrainMat);
    mesh.position.set(x0, 0, z0);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    const chunk: Chunk = { cx, cz, key: `${cx},${cz}`, mesh, props: [], grass: [], colliders: [], pois: [] };
    this.populate(chunk);
    return chunk;
  }

  private place(c: Chunk, type: string, variant: number, x: number, z: number, rot: number, scale: number, opts: { sink?: number; tilt?: number; collider?: number; colH?: number; scaleY?: number } = {}) {
    const y = this.height(x, z) - (opts.sink ?? 0) * scale;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(opts.tilt ? (hash2(x * 10, z * 10, 1) - 0.5) * opts.tilt : 0, rot, opts.tilt ? (hash2(x * 10, z * 10, 2) - 0.5) * opts.tilt : 0));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(scale, scale * (opts.scaleY ?? 1), scale));
    c.props.push({ type, variant, m });
    if (opts.collider) c.colliders.push({ x, z, r: opts.collider * scale, h: (opts.colH ?? 2) * scale, y });
  }

  private populate(c: Chunk) {
    const t = this.terrain;
    const rng = new RNG(Math.floor(hash2(c.cx, c.cz, this.seed) * 4294967295));
    const x0 = c.cx * CHUNK, z0 = c.cz * CHUNK;
    const cxw = x0 + CHUNK / 2, czw = z0 + CHUNK / 2;
    const bw = t.biomeWeights(cxw, czw);
    const distOrigin = Math.hypot(cxw, czw);
    const nearSpawn = (x: number, z: number) => x * x + z * z < 14 * 14;
    const slopeAt = (x: number, z: number) => 1 - t.normal(x, z, this.tmpN).y;
    const free = (x: number, z: number, r: number) => {
      for (const col of c.colliders) {
        const dx = col.x - x, dz = col.z - z;
        if (dx * dx + dz * dz < (col.r + r) * (col.r + r)) return false;
      }
      return true;
    };

    // Trees
    const nTrees = Math.round(2 + bw.forest * 26 + rng.range(0, 3));
    for (let i = 0; i < nTrees; i++) {
      const x = x0 + rng.range(0, CHUNK), z = z0 + rng.range(0, CHUNK);
      if (nearSpawn(x, z) || slopeAt(x, z) > 0.35 || !free(x, z, 1.5)) continue;
      const local = t.biomeWeights(x, z).forest;
      if (rng.next() > 0.25 + local) continue;
      const s = rng.range(0.75, 1.35);
      this.place(c, 'tree', rng.int(0, 5), x, z, rng.range(0, Math.PI * 2), s, { sink: 0.1, tilt: 0.15, collider: 0.4, colH: 8 });
    }
    // Boulders
    const nRocks = rng.int(3, 9);
    for (let i = 0; i < nRocks; i++) {
      const x = x0 + rng.range(0, CHUNK), z = z0 + rng.range(0, CHUNK);
      if (nearSpawn(x, z)) continue;
      const s = rng.chance(0.25) ? rng.range(1.2, 2.6) : rng.range(0.25, 0.9);
      if (!free(x, z, s)) continue;
      this.place(c, 'rock', rng.int(0, 4), x, z, rng.range(0, 6.28), s, { sink: 0.15, collider: s > 0.6 ? 1.0 : 0, colH: 0.8 });
    }
    // Barrow / graveyard features
    if (bw.barrow > 0.35 && !nearSpawn(cxw, czw)) {
      const gx = x0 + rng.range(8, 24), gz = z0 + rng.range(8, 24);
      const rows = rng.int(2, 4), cols = rng.int(3, 6);
      const rot = rng.range(0, Math.PI);
      const cr = Math.cos(rot), sr = Math.sin(rot);
      for (let r = 0; r < rows; r++)
        for (let k = 0; k < cols; k++) {
          if (rng.chance(0.2)) continue;
          const lx = (k - cols / 2) * 1.8 + rng.range(-0.3, 0.3), lz = (r - rows / 2) * 2.6 + rng.range(-0.3, 0.3);
          const x = gx + lx * cr - lz * sr, z = gz + lx * sr + lz * cr;
          this.place(c, 'grave', rng.int(0, 3), x, z, -rot + rng.range(-0.15, 0.15), rng.range(0.85, 1.2), { tilt: 0.35, collider: 0.35, colH: 1.2 });
        }
      if (rng.chance(0.5)) c.pois.push({ kind: 'altar', id: `${c.key}:altar`, x: gx, y: this.height(gx, gz), z: gz, rot, tier: 1 });
    }
    // Stone circle
    if (rng.chance(0.1 + bw.barrow * 0.15) && !nearSpawn(cxw, czw)) {
      const r = rng.range(5.5, 8);
      const n = rng.int(7, 10);
      for (let i = 0; i < n; i++) {
        if (rng.chance(0.15)) continue;
        const a = (i / n) * Math.PI * 2;
        const x = cxw + Math.cos(a) * r, z = czw + Math.sin(a) * r;
        this.place(c, 'menhir', rng.int(0, 2), x, z, -a, rng.range(0.8, 1.2), { sink: 0.2, tilt: 0.2, collider: 0.6, colH: 4 });
      }
      c.pois.push({ kind: 'shrine', id: `${c.key}:circle`, x: cxw, y: this.height(cxw, czw), z: czw, rot: 0, tier: 2 });
      this.place(c, 'shrine', 0, cxw, czw, 0, 1, { collider: 1.6, colH: 1 });
    }
    // Ruins
    if (rng.chance(0.18 + bw.barrow * 0.2) && !nearSpawn(cxw, czw)) {
      const rx = x0 + rng.range(6, 26), rz = z0 + rng.range(6, 26);
      const rot = rng.range(0, Math.PI * 2);
      const cr = Math.cos(rot), sr = Math.sin(rot);
      const pts: [string, number, number, number][] = [
        ['wall', -3, 0, 0], ['wall', 3.5, 0.3, 0], ['wall', 0, 5, Math.PI / 2],
        ['pillar', -5.5, 3, 0], ['pillar', 5.5, 3, 0], ['pillar', -5.5, 7, 0], ['pillar', 5.5, 7, 0],
      ];
      for (const [type, lx, lz, lr] of pts) {
        if (rng.chance(0.3)) continue;
        const x = rx + lx * cr - lz * sr, z = rz + lx * sr + lz * cr;
        const isWall = type === 'wall';
        this.place(c, type, rng.int(0, 2), x, z, rot + lr, 1, { sink: 0.2, collider: isWall ? 0 : 0.6, colH: 4 });
        if (isWall) {
          // walls get a chain of small colliders along their length
          const len = 4.5;
          for (let s = -len / 2; s <= len / 2; s += 0.9) {
            const wx = x + Math.cos(rot + lr) * s, wz = z - Math.sin(rot + lr) * s;
            c.colliders.push({ x: wx, z: wz, r: 0.55, h: 2.5, y: this.height(wx, wz) });
          }
        }
      }
      const lx = rx + 2 * cr, lz = rz + 2 * sr;
      this.place(c, 'lantern', 0, lx, lz, rot, 1, { collider: 0.15, colH: 3 });
      c.pois.push({ kind: 'lantern', id: `${c.key}:lantern`, x: lx + Math.cos(rot) * 0.75, y: this.height(lx, lz) + 2.8, z: lz - Math.sin(rot) * 0.75, rot, tier: 0 });
      const chx = rx + 1.5 * -sr, chz = rz + 3 * cr;
      c.pois.push({ kind: 'chest', id: `${c.key}:ruinchest`, x: chx, y: this.height(chx, chz), z: chz, rot: rot + Math.PI, tier: 2 });
    }
    // Loose chest
    if (rng.chance(0.22)) {
      const x = x0 + rng.range(4, 28), z = z0 + rng.range(4, 28);
      if (!nearSpawn(x, z) && free(x, z, 1.2)) c.pois.push({ kind: 'chest', id: `${c.key}:chest`, x, y: this.height(x, z), z, rot: rng.range(0, 6.28), tier: rng.chance(0.15) ? 2 : 1 });
    }
    // Wayside shrine
    if (rng.chance(0.06) && !nearSpawn(cxw, czw)) {
      const x = x0 + rng.range(6, 26), z = z0 + rng.range(6, 26);
      if (free(x, z, 2)) {
        this.place(c, 'shrine', 0, x, z, 0, 1, { collider: 1.6, colH: 1 });
        c.pois.push({ kind: 'shrine', id: `${c.key}:shrine`, x, y: this.height(x, z), z, rot: 0, tier: 1 });
      }
    }
    // Enemy lair (spawn group anchor); more frequent further out
    if (!nearSpawn(cxw, czw) && rng.chance(0.25 + Math.min(0.35, distOrigin / 1200))) {
      const x = x0 + rng.range(4, 28), z = z0 + rng.range(4, 28);
      c.pois.push({ kind: 'lair', id: `${c.key}:lair`, x, y: this.height(x, z), z, rot: 0, tier: t.biome(x, z) === Biome.Barrow ? 2 : 1 });
    }
    // Beacon tower (one per region)
    const b = this.beaconFor(Math.floor(c.cx / BEACON_REGION), Math.floor(c.cz / BEACON_REGION));
    if (b && b.cx === c.cx && b.cz === c.cz) {
      // clear the area around it
      c.colliders = c.colliders.filter((col) => Math.hypot(col.x - b.x, col.z - b.z) > 6);
      c.props = c.props.filter((p) => {
        const e = p.m.elements;
        return Math.hypot(e[12] - b.x, e[14] - b.z) > 6;
      });
      const by = this.height(b.x, b.z);
      this.place(c, 'beacon', 0, b.x, b.z, 0, 1, { sink: 0.3, collider: 1.9, colH: 7 });
      const cm = new THREE.Matrix4().makeTranslation(b.x, by - 0.3 + 7.2, b.z);
      c.props.push({ type: 'beaconCage', variant: 0, m: cm });
      c.pois.push({ kind: 'beacon', id: b.id, x: b.x, y: by, z: b.z, rot: 0, tier: 3 });
    }
    // Starting vigil at the origin
    if (c.cx === 0 && c.cz === 0) {
      c.pois.push({ kind: 'shrine', id: 'origin:vigil', x: 4, y: this.height(4, 4), z: 4, rot: 0, tier: 0 });
      this.place(c, 'shrine', 0, 4, 4, 0, 1, { collider: 1.6, colH: 1 });
      this.place(c, 'lantern', 0, -2, 6, 0.4, 1, { collider: 0.15, colH: 3 });
      c.pois.push({ kind: 'lantern', id: 'origin:lantern', x: -2 + Math.cos(0.4) * 0.75, y: this.height(-2, 6) + 2.8, z: 6 - Math.sin(0.4) * 0.75, rot: 0, tier: 0 });
    }
    // Grass tufts
    const gr = new RNG(Math.floor(hash2(c.cx, c.cz, this.seed + 9) * 4294967295));
    for (let i = 0; i < 520; i++) {
      const x = x0 + gr.range(0, CHUNK), z = z0 + gr.range(0, CHUNK);
      const n = t.normal(x, z, this.tmpN);
      const s = t.splat(x, z, n.y);
      if (s[0] < 0.35 + gr.next() * 0.4) continue;
      const m = new THREE.Matrix4();
      const sc = gr.range(0.7, 1.5) * (0.5 + s[0] * 0.6);
      m.compose(new THREE.Vector3(x, t.height(x, z) - 0.03, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), gr.range(0, 6.28)), new THREE.Vector3(sc, sc * gr.range(0.7, 1.3), sc));
      c.grass.push(m);
    }
  }

  /** Push a circle out of all nearby colliders. Returns true if it collided. */
  collide(p: THREE.Vector3, radius: number): boolean {
    const ccx = Math.floor(p.x / CHUNK), ccz = Math.floor(p.z / CHUNK);
    let hit = false;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(`${ccx + dx},${ccz + dz}`);
        if (!c) continue;
        for (const col of c.colliders) {
          if (p.y > col.y + col.h) continue;
          const ox = p.x - col.x, oz = p.z - col.z;
          const rr = col.r + radius;
          const d2 = ox * ox + oz * oz;
          if (d2 < rr * rr && d2 > 1e-8) {
            const d = Math.sqrt(d2);
            p.x = col.x + (ox / d) * rr;
            p.z = col.z + (oz / d) * rr;
            hit = true;
          }
        }
      }
    return hit;
  }

  /** Segment test against prop colliders (vertical cylinders). Returns t in [0,1] or -1. */
  raycastProps(a: THREE.Vector3, b: THREE.Vector3): number {
    let best = -1;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const ccx = Math.floor(mx / CHUNK), ccz = Math.floor(mz / CHUNK);
    const dx = b.x - a.x, dz = b.z - a.z;
    const A = dx * dx + dz * dz;
    if (A < 1e-9) return -1;
    for (let oz = -1; oz <= 1; oz++)
      for (let ox = -1; ox <= 1; ox++) {
        const c = this.chunks.get(`${ccx + ox},${ccz + oz}`);
        if (!c) continue;
        for (const col of c.colliders) {
          const fx = a.x - col.x, fz = a.z - col.z;
          const B = 2 * (fx * dx + fz * dz);
          const C = fx * fx + fz * fz - col.r * col.r;
          const disc = B * B - 4 * A * C;
          if (disc < 0) continue;
          const t = (-B - Math.sqrt(disc)) / (2 * A);
          if (t < 0 || t > 1) continue;
          const y = a.y + (b.y - a.y) * t;
          if (y < col.y - 0.5 || y > col.y + col.h) continue;
          if (best < 0 || t < best) best = t;
        }
      }
    return best;
  }

  /** Deterministic beacon location for a region (null if the region has none). */
  beaconFor(rx: number, rz: number): { x: number; z: number; id: string; cx: number; cz: number } | null {
    const h1 = hash2(rx, rz, this.seed + 71), h2 = hash2(rx, rz, this.seed + 72);
    const cx = rx * BEACON_REGION + 1 + Math.floor(h1 * (BEACON_REGION - 2));
    const cz = rz * BEACON_REGION + 1 + Math.floor(h2 * (BEACON_REGION - 2));
    const x = cx * CHUNK + 6 + hash2(cx, cz, this.seed + 73) * 20;
    const z = cz * CHUNK + 6 + hash2(cx, cz, this.seed + 74) * 20;
    if (Math.hypot(x, z) < 70) return null;
    return { x, z, id: `beacon:${rx},${rz}`, cx, cz };
  }

  /** Beacons within `radius` of a point, nearest first. */
  beaconsNear(px: number, pz: number, radius: number) {
    const R = CHUNK * BEACON_REGION;
    const out: { x: number; z: number; id: string; d: number }[] = [];
    const r0x = Math.floor((px - radius) / R), r1x = Math.floor((px + radius) / R);
    const r0z = Math.floor((pz - radius) / R), r1z = Math.floor((pz + radius) / R);
    for (let rz = r0z; rz <= r1z; rz++)
      for (let rx = r0x; rx <= r1x; rx++) {
        const b = this.beaconFor(rx, rz);
        if (!b) continue;
        const d = Math.hypot(b.x - px, b.z - pz);
        if (d <= radius) out.push({ x: b.x, z: b.z, id: b.id, d });
      }
    return out.sort((a, b) => a.d - b.d);
  }

  allPOIs(): POI[] {
    const out: POI[] = [];
    for (const c of this.chunks.values()) out.push(...c.pois);
    return out;
  }
}
