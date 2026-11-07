// GPU procedural texture generator. Every surface material in the game
// (terrain, bark, stone, flesh, steel, wood, leather) is synthesised at load
// time into tileable albedo / normal / ORM maps by rendering a fullscreen
// shader into mip-mapped render targets. Any of these can be replaced by
// authored textures (Blender bakes, texture libraries) through AssetLibrary.

import * as THREE from 'three';

export interface PBRSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  orm: THREE.Texture; // R=AO G=roughness B=metalness
}

const COMMON = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform int uMode;
uniform float uSize;
uniform float uSeed;

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))) + uSeed * 17.13;
  return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + uSeed * 0.013);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gnoise(vec2 p, vec2 per) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 a = mod(i, per), b = mod(i + vec2(1, 0), per), c = mod(i + vec2(0, 1), per), d = mod(i + vec2(1, 1), per);
  float va = dot(hash22(a), f);
  float vb = dot(hash22(b), f - vec2(1, 0));
  float vc = dot(hash22(c), f - vec2(0, 1));
  float vd = dot(hash22(d), f - vec2(1, 1));
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 1.4142;
}
float fbm(vec2 p, vec2 per, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * gnoise(p, per);
    p *= 2.0; per *= 2.0; a *= 0.5;
  }
  return s;
}
float ridge(vec2 p, vec2 per, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(gnoise(p, per));
    s += a * n * n;
    p *= 2.0; per *= 2.0; a *= 0.5;
  }
  return s;
}
// Tileable voronoi: x = F1, y = F2, z = cell id hash
vec3 voronoi(vec2 p, vec2 per) {
  vec2 i = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y);
    vec2 cell = mod(i + g, per);
    vec2 o = hash22(cell) * 0.5 + 0.5;
    float d = length(g + o - f);
    if (d < f1) { f2 = f1; f1 = d; id = hash12(cell); }
    else if (d < f2) { f2 = d; }
  }
  return vec3(f1, f2, id);
}

struct Surf { float h; vec3 albedo; float rough; float metal; float ao; };
Surf surf(vec2 uv);

void main() {
  float e = 1.0 / uSize;
  Surf s = surf(vUv);
  if (uMode == 0) {
    gl_FragColor = vec4(s.albedo, 1.0);
  } else if (uMode == 1) {
    float hx = surf(vUv + vec2(e, 0.0)).h;
    float hy = surf(vUv + vec2(0.0, e)).h;
    float strength = 2.6;
    vec3 n = normalize(vec3((s.h - hx) * uSize * strength * 0.02, (s.h - hy) * uSize * strength * 0.02, 1.0));
    gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
  } else {
    gl_FragColor = vec4(s.ao, s.rough, s.metal, 1.0);
  }
}
`;

const RECIPES: Record<string, string> = {
  mud: /* glsl */ `
Surf surf(vec2 uv) {
  vec2 p = uv * 8.0; vec2 per = vec2(8.0);
  float base = fbm(p, per, 6);
  vec3 v = voronoi(uv * 26.0 + vec2(fbm(uv * 4.0, vec2(4.0), 2)) * 0.8, vec2(26.0));
  float pebble = smoothstep(0.3, 0.12, v.x + fbm(uv * 60.0, vec2(60.0), 2) * 0.12) * step(0.86, v.z);
  float cracks = smoothstep(0.06, 0.0, v.y - v.x) * 0.6 * smoothstep(0.1, 0.4, fbm(p * 0.5 + 3.0, per * 0.5, 3));
  float puddle = smoothstep(0.05, 0.25, -fbm(uv * 3.0 + 7.0, vec2(3.0), 3));
  Surf s;
  s.h = base * 0.5 + pebble * (0.6 + 0.2 * v.z) - cracks * 0.4 - puddle * 0.3;
  vec3 dirt = mix(vec3(0.065, 0.052, 0.040), vec3(0.13, 0.105, 0.078), base * 0.5 + 0.5);
  vec3 stone = mix(vec3(0.09, 0.088, 0.083), vec3(0.15, 0.145, 0.135), fract(v.z * 7.0));
  s.albedo = mix(dirt, stone, pebble);
  s.albedo *= 1.0 - cracks * 0.5;
  s.albedo = mix(s.albedo, s.albedo * 0.45, puddle);
  s.rough = mix(0.92, 0.12, puddle);
  s.rough = mix(s.rough, 0.65, pebble);
  s.metal = 0.0;
  s.ao = 1.0 - cracks * 0.7 - (1.0 - pebble) * 0.1;
  return s;
}`,
  grass: /* glsl */ `
Surf surf(vec2 uv) {
  vec2 per = vec2(6.0);
  float clump = fbm(uv * 6.0, per, 4);
  // Strand-like streaks via anisotropic noise sampled in rotated cells.
  float strands = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    vec2 q = uv * vec2(40.0 + fk * 13.0, 9.0 + fk * 3.0) + vec2(fk * 3.7, fk * 1.3);
    strands += ridge(q, vec2(40.0 + fk * 13.0, 9.0 + fk * 3.0), 2) / 3.0;
  }
  float dry = smoothstep(-0.3, 0.5, fbm(uv * 3.0 + 11.0, vec2(3.0), 4));
  Surf s;
  s.h = strands * 0.8 + clump * 0.4;
  vec3 green = mix(vec3(0.035, 0.045, 0.022), vec3(0.06, 0.07, 0.035), strands);
  vec3 straw = mix(vec3(0.07, 0.06, 0.04), vec3(0.13, 0.11, 0.07), strands);
  s.albedo = mix(green, straw, dry) * (0.75 + 0.35 * clump);
  s.rough = 0.85 - strands * 0.15;
  s.metal = 0.0;
  s.ao = 0.55 + strands * 0.45;
  return s;
}`,
  rock: /* glsl */ `
Surf surf(vec2 uv) {
  vec2 per = vec2(4.0);
  float b = fbm(uv * 4.0, per, 7);
  vec3 v = voronoi(uv * 6.0, vec2(6.0));
  float crack = smoothstep(0.08, 0.0, v.y - v.x);
  float lichen = smoothstep(0.15, 0.45, fbm(uv * 10.0 + 5.0, vec2(10.0), 5)) ;
  float moss = smoothstep(0.1, 0.5, fbm(uv * 2.0 + 9.0, vec2(2.0), 4));
  Surf s;
  s.h = b * 0.7 + (1.0 - v.x) * 0.25 - crack * 0.5;
  vec3 c = mix(vec3(0.13, 0.13, 0.125), vec3(0.30, 0.29, 0.27), b * 0.5 + 0.5 + v.z * 0.15);
  c = mix(c, vec3(0.19, 0.20, 0.13), lichen * 0.55);
  c = mix(c, vec3(0.04, 0.06, 0.025), moss * 0.7);
  s.albedo = c * (1.0 - crack * 0.6);
  s.rough = mix(0.82, 0.95, moss);
  s.metal = 0.0;
  s.ao = 1.0 - crack * 0.8;
  return s;
}`,
  bark: /* glsl */ `
Surf surf(vec2 uv) {
  vec2 q = vec2(uv.x * 10.0, uv.y * 3.0);
  vec3 v = voronoi(q + vec2(fbm(uv * vec2(4.0, 2.0), vec2(4.0, 2.0), 3) * 0.6, 0.0), vec2(10.0, 3.0));
  float grooves = smoothstep(0.0, 0.35, v.y - v.x);
  float fib = ridge(uv * vec2(60.0, 6.0), vec2(60.0, 6.0), 3);
  Surf s;
  s.h = grooves * 0.8 + fib * 0.2;
  vec3 c = mix(vec3(0.03, 0.026, 0.022), vec3(0.15, 0.13, 0.11), grooves * (0.7 + 0.3 * v.z));
  c = mix(c, vec3(0.07, 0.08, 0.05), smoothstep(0.3, 0.6, fbm(uv * 3.0 + 1.0, vec2(3.0), 4)) * 0.6);
  s.albedo = c;
  s.rough = 0.9;
  s.metal = 0.0;
  s.ao = 0.35 + grooves * 0.65;
  return s;
}`,
  flesh: /* glsl */ `
Surf surf(vec2 uv) {
  vec2 per = vec2(5.0);
  float b = fbm(uv * 5.0, per, 6);
  float veins = pow(ridge(uv * 7.0 + 3.0, vec2(7.0), 4), 3.0);
  float rot = smoothstep(0.1, 0.5, fbm(uv * 3.0 + 13.0, vec2(3.0), 5));
  vec3 v = voronoi(uv * 30.0, vec2(30.0));
  float pores = smoothstep(0.25, 0.0, v.x) * 0.3;
  float wound = smoothstep(0.35, 0.6, fbm(uv * 4.0 + 21.0, vec2(4.0), 5));
  Surf s;
  s.h = b * 0.3 + veins * 0.35 - pores - wound * 0.4;
  vec3 skin = mix(vec3(0.15, 0.15, 0.145), vec3(0.27, 0.265, 0.25), b * 0.5 + 0.5);
  skin = mix(skin, vec3(0.07, 0.08, 0.06), rot * 0.8);
  skin = mix(skin, vec3(0.07, 0.03, 0.06), veins * 0.7);
  skin = mix(skin, vec3(0.16, 0.012, 0.01), wound * 0.9);
  s.albedo = skin;
  s.rough = mix(0.48, 0.18, wound) - veins * 0.1;
  s.metal = 0.0;
  s.ao = 1.0 - pores;
  return s;
}`,
  gore: /* glsl */ `
Surf surf(vec2 uv) {
  float fib = ridge(uv * vec2(14.0, 3.0), vec2(14.0, 3.0), 4);
  float b = fbm(uv * 6.0, vec2(6.0), 5);
  float fat = smoothstep(0.35, 0.55, fbm(uv * 4.0 + 8.0, vec2(4.0), 4));
  Surf s;
  s.h = fib * 0.6 + b * 0.3;
  vec3 c = mix(vec3(0.14, 0.008, 0.008), vec3(0.42, 0.04, 0.035), fib);
  c = mix(c, vec3(0.5, 0.36, 0.22), fat * 0.5);
  s.albedo = c;
  s.rough = 0.18 + b * 0.1;
  s.metal = 0.0;
  s.ao = 0.6 + fib * 0.4;
  return s;
}`,
  steel: /* glsl */ `
Surf surf(vec2 uv) {
  float brushed = fbm(uv * vec2(2.0, 120.0), vec2(2.0, 120.0), 3);
  float scratches = pow(ridge(uv * vec2(30.0, 3.0) + 2.0, vec2(30.0, 3.0), 2), 6.0);
  float rust = smoothstep(0.25, 0.6, fbm(uv * 4.0 + 4.0, vec2(4.0), 6));
  float pit = smoothstep(0.3, 0.0, voronoi(uv * 40.0, vec2(40.0)).x) * rust;
  Surf s;
  s.h = brushed * 0.1 - pit * 0.5 + scratches * 0.1 - rust * 0.2;
  s.albedo = mix(vec3(0.56, 0.56, 0.58) * (0.9 + brushed * 0.2), vec3(0.18, 0.07, 0.03), rust);
  s.rough = mix(0.28 + brushed * 0.1 - scratches * 0.15, 0.85, rust);
  s.metal = mix(1.0, 0.1, rust);
  s.ao = 1.0 - pit * 0.6;
  return s;
}`,
  wood: /* glsl */ `
Surf surf(vec2 uv) {
  float w = fbm(uv * vec2(3.0, 1.0), vec2(3.0, 1.0), 4);
  float rings = sin((uv.x * 40.0 + w * 6.0) * 3.14159) * 0.5 + 0.5;
  float grain = fbm(uv * vec2(80.0, 4.0), vec2(80.0, 4.0), 3);
  Surf s;
  s.h = rings * 0.3 + grain * 0.3;
  s.albedo = mix(vec3(0.07, 0.04, 0.022), vec3(0.20, 0.12, 0.065), rings * 0.6 + grain * 0.4 + 0.1);
  s.rough = 0.7 - rings * 0.15;
  s.metal = 0.0;
  s.ao = 0.8 + rings * 0.2;
  return s;
}`,
  leather: /* glsl */ `
Surf surf(vec2 uv) {
  float wrap = fract(uv.y * 12.0 + uv.x * 1.0);
  float band = smoothstep(0.0, 0.12, wrap) * smoothstep(1.0, 0.85, wrap);
  float b = fbm(uv * 20.0, vec2(20.0), 4);
  vec3 v = voronoi(uv * 50.0, vec2(50.0));
  Surf s;
  s.h = band * 0.6 + b * 0.15 + v.x * 0.1;
  s.albedo = mix(vec3(0.03, 0.02, 0.015), vec3(0.11, 0.07, 0.045), band * (0.7 + b * 0.3));
  s.rough = 0.6 + b * 0.2;
  s.metal = 0.0;
  s.ao = 0.4 + band * 0.6;
  return s;
}`,
  cloth: /* glsl */ `
Surf surf(vec2 uv) {
  float wx = sin(uv.x * 400.0) * 0.5 + 0.5;
  float wy = sin(uv.y * 400.0) * 0.5 + 0.5;
  float weave = mix(wx, wy, step(0.5, fract((floor(uv.x * 127.3) + floor(uv.y * 127.3)) * 0.5)));
  float dirt = fbm(uv * 4.0, vec2(4.0), 5);
  float tear = smoothstep(0.42, 0.5, fbm(uv * 6.0 + 3.0, vec2(6.0), 4));
  Surf s;
  s.h = weave * 0.2 + dirt * 0.2 - tear;
  s.albedo = mix(vec3(0.06, 0.055, 0.05), vec3(0.14, 0.12, 0.10), dirt * 0.5 + 0.5) * (0.85 + weave * 0.15);
  s.albedo = mix(s.albedo, vec3(0.12, 0.01, 0.01), smoothstep(0.2, 0.5, fbm(uv * 3.0 + 9.0, vec2(3.0), 4)) * 0.6);
  s.rough = 0.95;
  s.metal = 0.0;
  s.ao = 0.8 + weave * 0.2;
  return s;
}`,
};

export class TextureGen {
  private cache = new Map<string, PBRSet>();
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(private renderer: THREE.WebGLRenderer, private maxAniso: number) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get(name: keyof typeof RECIPES | string, size = 512, seed = 1): PBRSet {
    const key = `${name}:${size}:${seed}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const mat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: COMMON + RECIPES[name],
      uniforms: { uMode: { value: 0 }, uSize: { value: size }, uSeed: { value: seed } },
      depthTest: false,
      depthWrite: false,
    });
    this.quad.material = mat;
    const make = (mode: number, srgb: boolean) => {
      const rt = new THREE.WebGLRenderTarget(size, size, {
        type: THREE.UnsignedByteType,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        depthBuffer: false,
        colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      });
      rt.texture.anisotropy = this.maxAniso;
      mat.uniforms.uMode.value = mode;
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(rt);
      this.renderer.render(this.scene, this.cam);
      this.renderer.setRenderTarget(prev);
      return rt.texture;
    };
    const set: PBRSet = { map: make(0, true), normalMap: make(1, false), orm: make(2, false) };
    mat.dispose();
    this.cache.set(key, set);
    return set;
  }

  material(name: string, size = 512, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const s = this.get(name, size);
    const m = new THREE.MeshStandardMaterial({
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.orm,
      metalnessMap: s.orm,
      aoMap: s.orm,
      roughness: 1,
      metalness: 1,
      ...extra,
    });
    return m;
  }
}

/** 3D tileable value noise for the volumetric fog (CPU, generated once). */
export function makeFogNoise3D(size = 64): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size);
  const lattice = (period: number) => {
    const a = new Float32Array(period * period * period);
    for (let i = 0; i < a.length; i++) a[i] = Math.random();
    return a;
  };
  const octaves = [
    { p: 4, amp: 0.55, l: lattice(4) },
    { p: 8, amp: 0.28, l: lattice(8) },
    { p: 16, amp: 0.12, l: lattice(16) },
    { p: 32, amp: 0.05, l: lattice(32) },
  ];
  const sm = (t: number) => t * t * (3 - 2 * t);
  let idx = 0;
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let v = 0;
        for (const o of octaves) {
          const fx = (x / size) * o.p, fy = (y / size) * o.p, fz = (z / size) * o.p;
          const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
          const tx = sm(fx - ix), ty = sm(fy - iy), tz = sm(fz - iz);
          const P = o.p;
          const g = (a: number, b: number, c: number) => o.l[((c % P) * P + (b % P)) * P + (a % P)];
          const c00 = g(ix, iy, iz) * (1 - tx) + g(ix + 1, iy, iz) * tx;
          const c10 = g(ix, iy + 1, iz) * (1 - tx) + g(ix + 1, iy + 1, iz) * tx;
          const c01 = g(ix, iy, iz + 1) * (1 - tx) + g(ix + 1, iy, iz + 1) * tx;
          const c11 = g(ix, iy + 1, iz + 1) * (1 - tx) + g(ix + 1, iy + 1, iz + 1) * tx;
          const c0 = c00 * (1 - ty) + c10 * ty;
          const c1 = c01 * (1 - ty) + c11 * ty;
          v += (c0 * (1 - tz) + c1 * tz) * o.amp;
        }
        data[idx++] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
