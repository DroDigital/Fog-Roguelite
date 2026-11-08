// Skinned creature models built by tools/blender/build_creatures.py.
//
// One SkinnedMesh per creature, skinned to 20 bones: a bone per limb segment
// (driven from the live skeleton, or a ragdoll after death) plus a spare
// "stub" bone per segment that takes over the far side of a mid-limb cut.
// Because body, stumps and severed parts all share one mesh and skeleton, a
// cut is just a re-weighting of the vertices beyond the cut plane plus the
// removal of the triangles that straddle it; gore caps cover the hole.
// Wounds are painted into a per-vertex attribute at the exact impact point.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SEGS, orientBetween } from './Body';
import type { CreatureLook } from './CreatureMesh';
import type { TextureGen } from '../render/TextureGen';

const JOINT_NAMES = ['Pelvis', 'Chest', 'Head', 'LSh', 'LEl', 'LHa', 'RSh', 'REl', 'RHa', 'LHip', 'LKn', 'LFt', 'RHip', 'RKn', 'RFt'];
const LSH = 3, RSH = 6;

export interface CreatureAsset {
  id: string;
  geometry: THREE.BufferGeometry; // unit scale, engine creature space (left = +X, facing +Z)
  bind: THREE.Vector3[]; // joints in engine order
  eyes: THREE.Vector3[];
  head: THREE.Vector3;
  dominant: Uint8Array;
}

const assets = new Map<string, CreatureAsset>();

export function creatureAsset(id: string) {
  return assets.get(id) ?? null;
}

export async function loadCreatureAssets(ids: string[], base = './assets/creatures/') {
  const loader = new GLTFLoader();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const [gltf, meta] = await Promise.all([loader.loadAsync(`${base}${id}.glb`), fetch(`${base}${id}.json`).then((r) => r.json())]);
        let sk: THREE.SkinnedMesh | null = null;
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh && !sk) sk = o as THREE.SkinnedMesh;
        });
        if (!sk) return;
        const mesh = sk as THREE.SkinnedMesh;
        const g = mesh.geometry.clone();
        g.applyMatrix4(mesh.matrixWorld);
        // remap glTF joint indices to engine segment indices
        const remap = mesh.skeleton.bones.map((b) => SEGS.findIndex((s) => s.name === b.name));
        const si = g.attributes.skinIndex as THREE.BufferAttribute;
        const sw = g.attributes.skinWeight as THREE.BufferAttribute;
        const dominant = new Uint8Array(si.count);
        for (let i = 0; i < si.count; i++) {
          let best = 0, bw = -1;
          for (let k = 0; k < 4; k++) {
            const seg = Math.max(0, remap[si.getComponent(i, k)]);
            si.setComponent(i, k, seg);
            const w = sw.getComponent(i, k);
            if (w > bw) {
              bw = w;
              best = seg;
            }
          }
          dominant[i] = best;
        }
        const v = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
        assets.set(id, {
          id,
          geometry: g,
          bind: JOINT_NAMES.map((n) => v(meta.joints[n])),
          eyes: meta.eyes.map(v),
          head: v(meta.head),
          dominant,
        });
      } catch (e) {
        console.warn('[creatures] no model for', id, e);
      }
    }),
  );
}

/** Segment frame in the engine's convention (see Enemy.applyVisuals). */
function frameFor(seg: number, J: THREE.Vector3[], out: THREE.Matrix4) {
  const def = SEGS[seg];
  const left = new THREE.Vector3().subVectors(J[LSH], J[RSH]).normalize();
  const side = seg <= 1 ? left : left.clone().negate();
  const o = new THREE.Object3D();
  orientBetween(o, J[def.a], J[def.b], side);
  o.updateMatrix();
  return out.copy(o.matrix);
}

/** Subtree of a segment (itself + everything that hangs below it). */
export function subtree(seg: number): number[] {
  const out = [seg];
  for (const c of SEGS[seg].children) out.push(...subtree(c));
  return out;
}

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export class CreatureModel {
  mesh: THREE.SkinnedMesh;
  bones: THREE.Bone[] = []; // 0..9 segment bones, 10..19 cut stubs
  geometry: THREE.BufferGeometry;
  bindFrames: THREE.Matrix4[] = [];
  bindInv: THREE.Matrix4[] = [];
  private wound: THREE.BufferAttribute;
  private pos: THREE.BufferAttribute;
  private si: THREE.BufferAttribute;
  private sw: THREE.BufferAttribute;
  dominant: Uint8Array;
  bindJoints: THREE.Vector3[];
  refs = 1;

  constructor(public asset: CreatureAsset, public S: number, material: THREE.Material) {
    const src = asset.geometry;
    const g = new THREE.BufferGeometry();
    // positions are scaled per creature; normals/colours are shared
    const p = (src.attributes.position as THREE.BufferAttribute).clone();
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * S, p.getY(i) * S, p.getZ(i) * S);
    g.setAttribute('position', p);
    g.setAttribute('normal', src.attributes.normal);
    if (src.attributes.color) g.setAttribute('color', src.attributes.color);
    g.setAttribute('skinIndex', (src.attributes.skinIndex as THREE.BufferAttribute).clone());
    g.setAttribute('skinWeight', (src.attributes.skinWeight as THREE.BufferAttribute).clone());
    this.wound = new THREE.BufferAttribute(new Float32Array(p.count), 1);
    this.wound.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aWound', this.wound);
    g.setIndex(src.index!.clone());
    g.computeBoundingSphere();
    this.geometry = g;
    this.pos = p;
    this.si = g.attributes.skinIndex as THREE.BufferAttribute;
    this.sw = g.attributes.skinWeight as THREE.BufferAttribute;
    this.dominant = asset.dominant.slice();
    this.bindJoints = asset.bind.map((j) => j.clone().multiplyScalar(S));
    for (let s = 0; s < SEGS.length; s++) {
      const f = frameFor(s, this.bindJoints, new THREE.Matrix4());
      this.bindFrames.push(f);
      this.bindInv.push(f.clone().invert());
    }
    const inverses: THREE.Matrix4[] = [];
    for (let k = 0; k < 2; k++)
      for (let s = 0; s < SEGS.length; s++) {
        const b = new THREE.Bone();
        b.name = (k ? 'stub_' : '') + SEGS[s].name;
        this.bones.push(b);
        inverses.push(this.bindInv[s].clone());
      }
    this.mesh = new THREE.SkinnedMesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.bind(new THREE.Skeleton(this.bones, inverses), new THREE.Matrix4());
  }

  /** A point given in bind space, expressed in the local frame of a segment bone. */
  bindToLocal(seg: number, p: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(p).applyMatrix4(this.bindInv[seg]);
  }

  /** Average skin radius around a segment's axis at a fraction `t` of its length. */
  radiusAt(seg: number, t: number, segs: number[] = [seg]) {
    const len = this.bindJoints[SEGS[seg].a].distanceTo(this.bindJoints[SEGS[seg].b]);
    const y0 = t * len;
    let sum = 0, n = 0;
    for (let i = 0; i < this.pos.count; i++) {
      if (!segs.includes(this.dominant[i])) continue;
      _v.fromBufferAttribute(this.pos, i).applyMatrix4(this.bindInv[seg]);
      if (Math.abs(_v.y - y0) < 0.025 * this.S) {
        sum += Math.hypot(_v.x, _v.z);
        n++;
      }
    }
    return n ? sum / n : 0.05 * this.S;
  }

  /**
   * Split the mesh. `far(i)` decides which vertices leave with the severed part;
   * they are re-weighted onto `farBone`/their own subtree bones, the rest onto
   * the body side. Triangles that straddle the cut are dropped.
   */
  private split(far: (i: number) => boolean, farBones: number[], farRoot: number, nearRoot: number) {
    const n = this.pos.count;
    const isFar = new Uint8Array(n);
    for (let i = 0; i < n; i++) isFar[i] = far(i) ? 1 : 0;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) {
        const b = this.si.getComponent(i, k);
        const w = this.sw.getComponent(i, k);
        if (w <= 0) continue;
        const onFar = farBones.includes(b);
        if (isFar[i] && !onFar) this.si.setComponent(i, k, farRoot);
        else if (!isFar[i] && onFar) this.si.setComponent(i, k, nearRoot);
      }
      if (isFar[i] && this.dominant[i] < SEGS.length && !farBones.includes(this.dominant[i])) this.dominant[i] = farRoot;
    }
    this.si.needsUpdate = true;
    const idx = this.geometry.index!;
    const arr = idx.array as Uint32Array | Uint16Array;
    const keep: number[] = [];
    for (let t = 0; t < arr.length; t += 3) {
      const a = isFar[arr[t]], b = isFar[arr[t + 1]], c = isFar[arr[t + 2]];
      if (a === b && b === c) keep.push(arr[t], arr[t + 1], arr[t + 2]);
    }
    this.geometry.setIndex(keep);
  }

  /** Drop every triangle owned by a segment (a crushed skull simply ceases to be). */
  removeSegment(seg: number) {
    const arr = this.geometry.index!.array as Uint32Array | Uint16Array;
    const keep: number[] = [];
    const gone = (i: number) => this.dominant[i] === seg || this.dominant[i] === seg + SEGS.length;
    for (let t = 0; t < arr.length; t += 3) if (!gone(arr[t]) && !gone(arr[t + 1]) && !gone(arr[t + 2])) keep.push(arr[t], arr[t + 1], arr[t + 2]);
    this.geometry.setIndex(keep);
  }

  /** Cut at the root joint of `seg`: the whole subtree leaves. Returns the stump radius. */
  cutAtJoint(seg: number, parentSeg: number) {
    const sub = subtree(seg);
    const r = this.radiusAt(seg, 0.08, sub);
    const farBones = [...sub, ...sub.map((s) => s + SEGS.length)];
    this.split((i) => sub.includes(this.dominant[i]) || (this.dominant[i] >= SEGS.length && sub.includes(this.dominant[i] - SEGS.length)), farBones, seg, parentSeg);
    return r;
  }

  /**
   * Cut part-way along `seg` at fraction t. The far part of `seg` moves to its
   * stub bone; children go with it. Returns the cut radius.
   */
  cutMid(seg: number, t: number) {
    const sub = subtree(seg);
    const len = this.bindJoints[SEGS[seg].a].distanceTo(this.bindJoints[SEGS[seg].b]);
    const y0 = t * len;
    const r = this.radiusAt(seg, t, [seg]);
    const stub = seg + SEGS.length;
    const kids = sub.slice(1);
    const farBones = [stub, ...kids, ...kids.map((s) => s + SEGS.length)];
    this.split(
      (i) => {
        const d = this.dominant[i];
        if (kids.includes(d)) return true;
        if (d !== seg) return false;
        _v.fromBufferAttribute(this.pos, i).applyMatrix4(this.bindInv[seg]);
        return _v.y > y0;
      },
      farBones,
      stub,
      seg,
    );
    return r;
  }

  /**
   * Paint a wound around a world-space impact on segment `seg`. Slashes are
   * stretched along the blade's travel; `depth` 0..1 controls how deep it reads.
   */
  addWound(seg: number, world: THREE.Vector3, dir: THREE.Vector3, size: number, depth: number, bone = this.bones[seg]) {
    bone.updateWorldMatrix(true, false);
    // world -> bone local -> bind space
    const inv = _m.copy(bone.matrixWorld).invert();
    const pBind = _v.copy(world).applyMatrix4(inv).applyMatrix4(this.bindFrames[seg]);
    const dBind = _w.copy(dir).transformDirection(inv).transformDirection(this.bindFrames[seg]).normalize();
    const R = size * this.S;
    const a = this.wound.array as Float32Array;
    const p = new THREE.Vector3();
    let touched = false;
    for (let i = 0; i < this.pos.count; i++) {
      p.fromBufferAttribute(this.pos, i).sub(pBind);
      const along = p.dot(dBind);
      const perp = Math.sqrt(Math.max(0, p.lengthSq() - along * along));
      const d = Math.sqrt(perp * perp + (along / 2.6) ** 2);
      if (d > R) continue;
      const k = (1 - d / R) ** 1.5 * depth;
      if (k > a[i]) {
        a[i] = Math.min(1, k);
        touched = true;
      }
    }
    if (touched) this.wound.needsUpdate = true;
  }
}

/**
 * Skin for the skinned creatures: baked colour/AO from the sculpt (vertex
 * colours), seamless triplanar flesh detail in bind space, wet sheen, a
 * spreading blood mask and per-vertex wounds that sink the surface and turn
 * it to raw meat.
 */
export function makeSkinnedFlesh(tex: TextureGen, look: CreatureLook, bloodU: { value: number }): THREE.MeshPhysicalMaterial {
  const set = tex.get('flesh', 512);
  const gore = tex.get('gore', 512);
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    color: new THREE.Color(look.skin.r * 0.95, look.skin.g * 0.95, look.skin.b * 0.95),
    roughness: 0.55,
    metalness: 0,
    sheen: 0.5,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0.5, 0.14, 0.1),
    clearcoat: 0.22,
    clearcoatRoughness: 0.4,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBlood = bloodU;
    sh.uniforms.tDetail = { value: set.map };
    sh.uniforms.tDetailN = { value: set.normalMap };
    sh.uniforms.tGore = { value: gore.map };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aWound;\nvarying float vWound;\nvarying vec3 vBindPos;\nvarying vec3 vBindN;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWound = aWound;
         vBindPos = position;
         vBindN = normal;
         transformed -= normal * aWound * 0.022;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying float vWound;
         varying vec3 vBindPos;
         varying vec3 vBindN;
         uniform float uBlood;
         uniform sampler2D tDetail, tDetailN, tGore;
         vec4 tri(sampler2D t, vec3 p, vec3 n) {
           vec3 w = pow(abs(n) + 1e-4, vec3(4.0)); w /= (w.x + w.y + w.z);
           return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z;
         }
         float bh3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
         float bn3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
           return mix(mix(mix(bh3(i), bh3(i+vec3(1,0,0)), f.x), mix(bh3(i+vec3(0,1,0)), bh3(i+vec3(1,1,0)), f.x), f.y),
                      mix(mix(bh3(i+vec3(0,0,1)), bh3(i+vec3(1,0,1)), f.x), mix(bh3(i+vec3(0,1,1)), bh3(i+vec3(1,1,1)), f.x), f.y), f.z); }
         vec3 bumpN(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
           vec3 dx = dFdx(surf_pos), dy = dFdy(surf_pos);
           if (dot(dx, dx) < 1e-14 || dot(dy, dy) < 1e-14) return surf_norm;
           vec3 vSigmaX = normalize(dx); vec3 vSigmaY = normalize(dy);
           vec3 R1 = cross(vSigmaY, surf_norm); vec3 R2 = cross(surf_norm, vSigmaX);
           float fDet = dot(vSigmaX, R1) * faceDir;
           vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
           vec3 n = abs(fDet) * surf_norm - vGrad;
           float l = dot(n, n);
           return (l > 1e-12 && !(l != l)) ? n * inversesqrt(l) : surf_norm;
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         vec3 tp = vBindPos * 2.2;
         vec3 bn = normalize(vBindN + vec3(1e-5));
         vec3 det = tri(tDetail, tp, bn).rgb;
         float detL = dot(det, vec3(0.333));
         diffuseColor.rgb *= 0.7 + detL * 1.9;
         float ao = 1.0;
         #if defined( USE_COLOR_ALPHA )
           ao = vColor.a;
         #endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness * mix(0.62, 1.0, ao);
         // spreading blood
         float bmask = bn3(vBindPos * 9.0) * 0.6 + bn3(vBindPos * 23.0) * 0.4;
         bmask += bn3(vec3(vBindPos.x * 30.0, vBindPos.y * 3.0, vBindPos.z * 30.0)) * 0.25;
         bmask = smoothstep(1.02 - uBlood * 0.75, 1.1 - uBlood * 0.75, bmask);
         // wounds: torn edges, glistening muscle, darker cavity in the middle
         float wn = vWound * (0.75 + 0.5 * bn3(vBindPos * 60.0));
         float wEdge = smoothstep(0.08, 0.3, wn);
         float wCore = smoothstep(0.45, 0.85, wn);
         vec3 meat = tri(tGore, vBindPos * 4.0, bn).rgb;
         vec3 woundCol = mix(meat * 1.3, vec3(0.05, 0.0, 0.0), wCore * 0.75);
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.004, 0.004), max(bmask * 0.92, wEdge * 0.6));
         diffuseColor.rgb = mix(diffuseColor.rgb, woundCol, wEdge * 0.9);
         roughnessFactor = mix(roughnessFactor, 0.12, max(bmask, wEdge));`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `{
           float h = dot(tri(tDetailN, vBindPos * 2.2, normalize(vBindN + vec3(1e-5))).rg, vec2(0.5));
           float hw = vWound * 0.6 + bn3(vBindPos * 90.0) * vWound * 0.4;
           vec2 dH = vec2(dFdx(h), dFdy(h)) * 1.1 + vec2(dFdx(hw), dFdy(hw)) * 2.5;
           normal = bumpN(-vViewPosition, normal, dH, faceDirection);
         }`,
      );
  };
  m.customProgramCacheKey = () => 'skinnedflesh';
  return m;
}
