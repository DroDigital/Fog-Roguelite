// 2D fluid simulation of the ground fog around the player.
//
// A scrolling 128x128 grid (1m cells) stores fog velocity (u,v) and a
// "displacement" field d (how much fog has been pushed out of a cell). Moving
// bodies, weapon swings, impacts and explosions inject momentum and clear
// fog; the field is advected semi-Lagrangian, diffused and relaxes back so
// fog visibly parts, swirls behind you and rolls back in. The result is
// uploaded each frame as a texture that the volumetric raymarcher samples.

import * as THREE from 'three';

export const SIM_N = 128;
export const SIM_CELL = 1.0;

export class FogSim {
  readonly size = SIM_N * SIM_CELL;
  originX = 0; // world coords of grid cell (0,0)
  originZ = 0;
  private u = new Float32Array(SIM_N * SIM_N);
  private v = new Float32Array(SIM_N * SIM_N);
  private d = new Float32Array(SIM_N * SIM_N);
  private u2 = new Float32Array(SIM_N * SIM_N);
  private v2 = new Float32Array(SIM_N * SIM_N);
  private d2 = new Float32Array(SIM_N * SIM_N);
  private ground = new Float32Array(SIM_N * SIM_N);
  private groundValid = new Uint8Array(SIM_N * SIM_N);
  private bytes = new Uint8Array(SIM_N * SIM_N * 4);
  readonly texture: THREE.DataTexture;
  groundRef = 0; // height reference for alpha channel encoding

  constructor(private heightFn: (x: number, z: number) => number) {
    this.texture = new THREE.DataTexture(this.bytes, SIM_N, SIM_N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
  }

  /** Keep the grid centred on the player by shifting whole cells. */
  recenter(px: number, pz: number) {
    const tx = Math.floor(px / SIM_CELL - SIM_N / 2) * SIM_CELL;
    const tz = Math.floor(pz / SIM_CELL - SIM_N / 2) * SIM_CELL;
    const sx = Math.round((tx - this.originX) / SIM_CELL);
    const sz = Math.round((tz - this.originZ) / SIM_CELL);
    if (sx === 0 && sz === 0) return;
    const shift = (a: Float32Array, tmp: Float32Array, fill: number) => {
      for (let j = 0; j < SIM_N; j++)
        for (let i = 0; i < SIM_N; i++) {
          const si = i + sx, sj = j + sz;
          tmp[j * SIM_N + i] = si >= 0 && si < SIM_N && sj >= 0 && sj < SIM_N ? a[sj * SIM_N + si] : fill;
        }
      a.set(tmp);
    };
    shift(this.u, this.u2, 0);
    shift(this.v, this.v2, 0);
    shift(this.d, this.d2, 0);
    const gv = new Float32Array(SIM_N * SIM_N);
    for (let i = 0; i < gv.length; i++) gv[i] = this.groundValid[i];
    shift(this.ground, this.u2, 0);
    shift(gv, this.v2, 0);
    for (let i = 0; i < gv.length; i++) this.groundValid[i] = gv[i] > 0.5 ? 1 : 0;
    this.u2.fill(0);
    this.v2.fill(0);
    this.originX = tx;
    this.originZ = tz;
  }

  /**
   * Inject a disturbance: velocity (vx,vz) in m/s spread over `radius`, and
   * `clear` (0..1) that pushes fog out of the area.
   */
  splat(x: number, z: number, vx: number, vz: number, radius: number, clear: number) {
    const ci = (x - this.originX) / SIM_CELL, cj = (z - this.originZ) / SIM_CELL;
    const r = radius / SIM_CELL;
    const i0 = Math.max(1, Math.floor(ci - r - 1)), i1 = Math.min(SIM_N - 2, Math.ceil(ci + r + 1));
    const j0 = Math.max(1, Math.floor(cj - r - 1)), j1 = Math.min(SIM_N - 2, Math.ceil(cj + r + 1));
    const inv = 1 / (r * r);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const dx = i - ci, dz = j - cj;
        const w = Math.exp(-(dx * dx + dz * dz) * inv * 2);
        if (w < 0.01) continue;
        const k = j * SIM_N + i;
        this.u[k] += vx * w;
        this.v[k] += vz * w;
        this.d[k] = Math.min(1, this.d[k] + clear * w);
      }
  }

  /** Radial blast (impacts, heavy attacks, deaths). */
  burst(x: number, z: number, strength: number, radius: number) {
    const ci = (x - this.originX) / SIM_CELL, cj = (z - this.originZ) / SIM_CELL;
    const r = radius / SIM_CELL;
    const i0 = Math.max(1, Math.floor(ci - r)), i1 = Math.min(SIM_N - 2, Math.ceil(ci + r));
    const j0 = Math.max(1, Math.floor(cj - r)), j1 = Math.min(SIM_N - 2, Math.ceil(cj + r));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const dx = i - ci, dz = j - cj;
        const dist = Math.hypot(dx, dz);
        if (dist > r || dist < 1e-3) continue;
        const w = 1 - dist / r;
        const k = j * SIM_N + i;
        this.u[k] += (dx / dist) * strength * w;
        this.v[k] += (dz / dist) * strength * w;
        this.d[k] = Math.min(1, this.d[k] + 0.6 * w);
      }
  }

  private sample(a: Float32Array, x: number, z: number) {
    x = Math.min(Math.max(x, 0), SIM_N - 1.001);
    z = Math.min(Math.max(z, 0), SIM_N - 1.001);
    const i = Math.floor(x), j = Math.floor(z);
    const fx = x - i, fz = z - j;
    const k = j * SIM_N + i;
    return (a[k] * (1 - fx) + a[k + 1] * fx) * (1 - fz) + (a[k + SIM_N] * (1 - fx) + a[k + SIM_N + 1] * fx) * fz;
  }

  step(dt: number, windX: number, windZ: number) {
    dt = Math.min(dt, 1 / 20);
    const N = SIM_N;
    const { u, v, d, u2, v2, d2 } = this;
    const k = dt / SIM_CELL;
    // advect (semi-Lagrangian), velocity includes the ambient wind
    for (let j = 1; j < N - 1; j++)
      for (let i = 1; i < N - 1; i++) {
        const idx = j * N + i;
        const x = i - (u[idx] + windX) * k;
        const z = j - (v[idx] + windZ) * k;
        u2[idx] = this.sample(u, x, z);
        v2[idx] = this.sample(v, x, z);
        d2[idx] = this.sample(d, x, z);
      }
    // diffuse + damp; displaced fog relaxes back (fog refills the hole)
    const velDecay = Math.exp(-1.6 * dt);
    const refill = Math.exp(-0.45 * dt);
    const nu = Math.min(0.24, 6 * dt);
    for (let j = 1; j < N - 1; j++)
      for (let i = 1; i < N - 1; i++) {
        const idx = j * N + i;
        const lu = u2[idx - 1] + u2[idx + 1] + u2[idx - N] + u2[idx + N] - 4 * u2[idx];
        const lv = v2[idx - 1] + v2[idx + 1] + v2[idx - N] + v2[idx + N] - 4 * v2[idx];
        const ld = d2[idx - 1] + d2[idx + 1] + d2[idx - N] + d2[idx + N] - 4 * d2[idx];
        u[idx] = (u2[idx] + nu * lu) * velDecay;
        v[idx] = (v2[idx] + nu * lv) * velDecay;
        // divergence of the flow pushes fog out, convergence piles it back
        const div = (u2[idx + 1] - u2[idx - 1] + v2[idx + N] - v2[idx - N]) * 0.5;
        d[idx] = Math.min(1, Math.max(0, (d2[idx] + nu * 0.5 * ld + div * dt * 0.35) * refill));
      }
    this.upload();
  }

  private upload() {
    const N = SIM_N;
    const b = this.bytes;
    const ref = this.groundRef;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        if (!this.groundValid[idx]) {
          this.ground[idx] = this.heightFn(this.originX + (i + 0.5) * SIM_CELL, this.originZ + (j + 0.5) * SIM_CELL);
          this.groundValid[idx] = 1;
        }
        const o = idx * 4;
        b[o] = Math.max(0, Math.min(255, 128 + this.u[idx] * 16));
        b[o + 1] = Math.max(0, Math.min(255, 128 + this.v[idx] * 16));
        b[o + 2] = Math.max(0, Math.min(255, this.d[idx] * 255));
        b[o + 3] = Math.max(0, Math.min(255, 128 + (this.ground[idx] - ref) * 4));
      }
    this.texture.needsUpdate = true;
  }

  /** Fog displacement at a point (0 = untouched fog, 1 = fully cleared). */
  clearAt(x: number, z: number) {
    return this.sample(this.d, (x - this.originX) / SIM_CELL - 0.5, (z - this.originZ) / SIM_CELL - 0.5);
  }
}
