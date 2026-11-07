// Infinite deterministic heightfield + biome classification.

import { Noise2D, smoothstep, clamp } from '../engine/Random';

export enum Biome {
  Moor = 0,
  DeadForest = 1,
  Barrow = 2,
}

export class Terrain {
  private nHills: Noise2D;
  private nMid: Noise2D;
  private nDetail: Noise2D;
  private nBiome: Noise2D;
  private nBiome2: Noise2D;
  readonly nSplat: Noise2D;

  constructor(public seed: number) {
    this.nHills = new Noise2D(seed);
    this.nMid = new Noise2D(seed + 101);
    this.nDetail = new Noise2D(seed + 202);
    this.nBiome = new Noise2D(seed + 303);
    this.nBiome2 = new Noise2D(seed + 404);
    this.nSplat = new Noise2D(seed + 505);
  }

  height(x: number, z: number): number {
    const warpX = this.nMid.noise(x * 0.004 + 31.7, z * 0.004) * 30;
    const warpZ = this.nMid.noise(x * 0.004, z * 0.004 - 17.3) * 30;
    const hills = this.nHills.fbm((x + warpX) * 0.0055, (z + warpZ) * 0.0055, 4) * 13;
    const ridges = this.nHills.ridged(x * 0.011 + 5.1, z * 0.011 - 2.7, 3) * 5 - 2;
    const mid = this.nMid.fbm(x * 0.035, z * 0.035, 3) * 1.6;
    const detail = this.nDetail.noise(x * 0.21, z * 0.21) * 0.18;
    // A calmer hollow around the starting vigil
    const d = Math.sqrt(x * x + z * z);
    const calm = smoothstep(10, 60, d);
    return (hills + ridges * this.ridgeAmount(x, z) + mid) * (0.35 + 0.65 * calm) + detail;
  }

  private ridgeAmount(x: number, z: number) {
    return smoothstep(-0.1, 0.5, this.nBiome2.noise(x * 0.003, z * 0.003));
  }

  normal(x: number, z: number, out: { x: number; y: number; z: number }) {
    const e = 0.5;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    const nx = -hx, ny = 2 * e, nz = -hz;
    const l = Math.hypot(nx, ny, nz);
    out.x = nx / l;
    out.y = ny / l;
    out.z = nz / l;
    return out;
  }

  /** Continuous biome weights (forest, barrow); moor is the remainder. */
  biomeWeights(x: number, z: number): { forest: number; barrow: number } {
    const b = this.nBiome.fbm(x * 0.0035, z * 0.0035, 3);
    const c = this.nBiome2.fbm(x * 0.005 + 40, z * 0.005 - 40, 2);
    const forest = smoothstep(-0.05, 0.25, b);
    const barrow = smoothstep(0.15, 0.4, c) * (1 - forest * 0.7);
    return { forest, barrow };
  }

  biome(x: number, z: number): Biome {
    const w = this.biomeWeights(x, z);
    if (w.forest > 0.5) return Biome.DeadForest;
    if (w.barrow > 0.5) return Biome.Barrow;
    return Biome.Moor;
  }

  /** Splat weights for shading: grass, rock (mud is the remainder). */
  splat(x: number, z: number, ny: number): [number, number, number] {
    const slope = 1 - ny;
    const w = this.biomeWeights(x, z);
    const n = this.nSplat.fbm(x * 0.06, z * 0.06, 3);
    let grass = smoothstep(-0.25, 0.3, n + 0.25 - w.forest * 0.55) * (1 - smoothstep(0.12, 0.3, slope));
    const rock = smoothstep(0.18, 0.38, slope + this.nSplat.noise(x * 0.2, z * 0.2) * 0.08);
    grass = clamp(grass * (1 - rock), 0, 1);
    const wet = smoothstep(0.2, 0.6, -this.nSplat.fbm(x * 0.02 + 9, z * 0.02, 2));
    return [grass, rock, wet];
  }
}
