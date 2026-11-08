// Procedural creature anatomy: lathed limbs with muscle/bone profiles,
// skulls with glowing eyes, armour pieces and the gore caps used when a limb
// is severed.

import * as THREE from 'three';
import { SEGS, type Part } from './Body';
import type { TextureGen } from '../render/TextureGen';
import { RNG } from '../engine/Random';

export interface CreatureLook {
  id: string;
  skin: THREE.Color;
  eye: THREE.Color;
  gaunt: number; // 0..1 how emaciated
  bulk: number; // radius multiplier
  armour: boolean;
  cloth: boolean;
}

export interface CreatureMats {
  flesh: THREE.MeshStandardMaterial;
  bloodU?: { value: number };
  gore: THREE.MeshStandardMaterial;
  bone: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
  iron: THREE.MeshStandardMaterial;
  eye: THREE.MeshBasicMaterial;
}

const geoCache = new Map<string, THREE.BufferGeometry>();

/** Limb lathe: profile radius along the bone with a muscle belly and knobbly joints. */
function limbGeo(len: number, ra: number, rb: number, belly: number, gaunt: number, seed: number) {
  const key = `limb:${len.toFixed(3)}:${ra.toFixed(3)}:${rb.toFixed(3)}:${belly.toFixed(2)}:${gaunt.toFixed(2)}:${seed}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const pts: THREE.Vector2[] = [];
  const n = 14;
  // bottom cap
  for (let i = 0; i <= 4; i++) {
    const a = (i / 4) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(Math.sin(a) * ra, -Math.cos(a) * ra * 0.6));
  }
  for (let i = 1; i < n; i++) {
    const t = i / n;
    let r = ra + (rb - ra) * t;
    r *= 1 + belly * Math.sin(Math.PI * Math.min(1, t * 1.3)) * (1 - gaunt * 0.6);
    // bony knuckle near the joints when gaunt
    r *= 1 - gaunt * 0.25 * Math.sin(Math.PI * t) + gaunt * 0.12 * Math.exp(-((t - 0.95) ** 2) * 200);
    pts.push(new THREE.Vector2(r, t * len));
  }
  for (let i = 0; i <= 4; i++) {
    const a = (1 - i / 4) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(Math.sin(a) * rb, len + Math.cos(a) * rb * 0.6));
  }
  const g = new THREE.LatheGeometry(pts, 12);
  // break the perfect symmetry
  const rng = new RNG(seed);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const ph = rng.range(0, 6.28);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ang = Math.atan2(z, x);
    const k = 1 + 0.06 * Math.sin(ang * 2 + ph) + 0.04 * Math.sin(ang * 3 + y * 9 + ph);
    pos.setXYZ(i, x * k, y, z * k * 0.92);
  }
  g.computeVertexNormals();
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 1.5, uv.getY(i) * len * 2);
  geoCache.set(key, g);
  return g;
}

function torsoGeo(len: number, ra: number, rb: number, gaunt: number) {
  const key = `torso:${len.toFixed(3)}:${ra.toFixed(3)}:${rb.toFixed(3)}:${gaunt}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const pts: THREE.Vector2[] = [];
  const n = 20;
  pts.push(new THREE.Vector2(0.001, -0.05));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // pelvis → narrow waist → rib cage → shoulders → neck
    let r = ra * (1 - 0.35 * Math.exp(-((t - 0.3) ** 2) * 40) * (0.5 + gaunt)) + (rb - ra) * THREE.MathUtils.smoothstep(t, 0.3, 0.8);
    if (t > 0.88) r *= 1 - (t - 0.88) * 4.2;
    // ribs
    if (t > 0.42 && t < 0.82) r *= 1 + gaunt * 0.05 * Math.sin(t * 90);
    pts.push(new THREE.Vector2(Math.max(r, 0.02), t * len));
  }
  pts.push(new THREE.Vector2(0.001, len + 0.02));
  const g = new THREE.LatheGeometry(pts, 16);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / len;
    let z = pos.getZ(i) * 0.62;
    // hunched back, sunken belly
    if (z < 0) z *= 1 + 0.25 * Math.sin(Math.PI * y);
    else z *= 1 - gaunt * 0.3 * Math.exp(-((y - 0.35) ** 2) * 30);
    // broaden shoulders
    const x = pos.getX(i) * (1 + 0.35 * THREE.MathUtils.smoothstep(y, 0.6, 0.85) * (1 - THREE.MathUtils.smoothstep(y, 0.9, 1.0)));
    pos.setXYZ(i, x, pos.getY(i), z);
  }
  g.computeVertexNormals();
  geoCache.set(key, g);
  return g;
}

/**
 * Wet, sheened skin with a per-creature blood mask that spreads as it is hurt.
 * Each creature gets its own instance (shared shader program, own uniforms).
 */
export function makeFlesh(tex: TextureGen, look: CreatureLook, bloodU: { value: number }): THREE.MeshPhysicalMaterial {
  const set = tex.get('flesh', 512);
  const m = new THREE.MeshPhysicalMaterial({
    map: set.map,
    normalMap: set.normalMap,
    normalScale: new THREE.Vector2(1.6, 1.6),
    roughnessMap: set.orm,
    aoMap: set.orm,
    color: look.skin,
    roughness: 1,
    metalness: 0,
    sheen: 0.6,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0.45, 0.12, 0.1),
    clearcoat: 0.18,
    clearcoatRoughness: 0.45,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBlood = bloodU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vObjP;
         uniform float uBlood;
         float bh3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
         float bn3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
           return mix(mix(mix(bh3(i), bh3(i+vec3(1,0,0)), f.x), mix(bh3(i+vec3(0,1,0)), bh3(i+vec3(1,1,0)), f.x), f.y),
                      mix(mix(bh3(i+vec3(0,0,1)), bh3(i+vec3(1,0,1)), f.x), mix(bh3(i+vec3(0,1,1)), bh3(i+vec3(1,1,1)), f.x), f.y), f.z); }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         float bmask = bn3(vObjP * 9.0) * 0.6 + bn3(vObjP * 23.0) * 0.4;
         // streaks run downward
         bmask += bn3(vec3(vObjP.x * 30.0, vObjP.y * 3.0, vObjP.z * 30.0)) * 0.25;
         bmask = smoothstep(1.02 - uBlood * 0.75, 1.1 - uBlood * 0.75, bmask);
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13, 0.004, 0.004), bmask * 0.92);
         roughnessFactor = mix(roughnessFactor, 0.16, bmask);`,
      );
  };
  m.customProgramCacheKey = () => 'creatureflesh';
  return m;
}

export function makeCreatureMats(tex: TextureGen, look: CreatureLook): CreatureMats {
  const flesh = makeFlesh(tex, look, { value: 0 });
  const gore = tex.material('gore', 512, { metalness: 0, emissive: new THREE.Color(0.04, 0, 0) });
  const bone = new THREE.MeshStandardMaterial({ color: 0xcfc2a0, roughness: 0.5, metalness: 0 });
  const cloth = tex.material('cloth', 512, { metalness: 0, side: THREE.DoubleSide });
  const iron = tex.material('steel', 512, { color: new THREE.Color(0.35, 0.3, 0.27) });
  const eye = new THREE.MeshBasicMaterial({ color: look.eye.clone() });
  return { flesh, gore, bone, cloth, iron, eye };
}

/**
 * Build the mesh for one body segment. Local frame: origin at joint a, +Y
 * towards joint b, +X = creature's right (for torso/head), +Z forward.
 */
export function buildSegment(segIdx: number, len: number, scale: number, look: CreatureLook, mats: CreatureMats, seed: number): THREE.Object3D {
  const def = SEGS[segIdx];
  const root = new THREE.Group();
  const ra = def.ra * scale * look.bulk, rb = def.rb * scale * look.bulk;
  const part: Part = def.part;
  const add = (g: THREE.BufferGeometry, m: THREE.Material, px = 0, py = 0, pz = 0, sx = 1, sy = 1, sz = 1) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(px, py, pz);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };

  if (part === 'torso') {
    add(torsoGeo(len, ra, rb, look.gaunt), mats.flesh);
    // collarbones and a ridged spine read through the skin
    for (const sx of [-1, 1]) {
      const cb = new THREE.CapsuleGeometry(rb * 0.09, rb * 0.95, 3, 6);
      const m = add(cb, mats.flesh, sx * rb * 0.48, len * 0.9, rb * 0.32);
      m.rotation.z = sx * (Math.PI / 2 - 0.25);
    }
    for (let i = 0; i < 7; i++) {
      const v = new THREE.SphereGeometry(rb * 0.11, 6, 4);
      add(v, mats.flesh, 0, len * (0.3 + i * 0.09), -rb * 0.55 - Math.sin(i * 0.5) * rb * 0.04, 1, 0.7, 0.8);
    }
    if (look.gaunt > 0.5) {
      // ribs: thin arcs around the chest
      for (let i = 0; i < 5; i++) {
        const rib = new THREE.TorusGeometry(rb * (0.86 - i * 0.04), rb * 0.05, 4, 14, Math.PI * 0.85);
        const m = add(rib, mats.flesh, 0, len * (0.5 + i * 0.065), 0, 1, 1, 0.66);
        m.rotation.set(Math.PI / 2 + 0.25, 0, Math.PI * 0.075);
      }
    }
    if (look.cloth) {
      // tattered strips hanging from the waist
      const srng = new RNG(seed + 5);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + srng.range(-0.2, 0.2);
        const h = len * srng.range(0.35, 0.75);
        const strip = new THREE.PlaneGeometry(rb * srng.range(0.35, 0.6), h, 1, 3);
        const sp = strip.attributes.position as THREE.BufferAttribute;
        for (let k = 0; k < sp.count; k++) if (sp.getY(k) < 0) sp.setX(k, sp.getX(k) * srng.range(0.3, 0.9));
        strip.translate(0, -h / 2, 0);
        const m = add(strip, mats.cloth, Math.sin(a) * ra * 1.25, len * 0.06, Math.cos(a) * ra * 0.95);
        m.rotation.set(srng.range(-0.15, 0.15), a, 0);
      }
      const cg = new THREE.CylinderGeometry(ra * 1.12, ra * 1.35, len * 0.55, 14, 3, true);
      const p = cg.attributes.position as THREE.BufferAttribute;
      const rng = new RNG(seed);
      for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setY(i, p.getY(i) - rng.range(0, len * 0.35));
      cg.computeVertexNormals();
      add(cg, mats.cloth, 0, len * 0.08, 0, 1, 1, 0.8);
    }
    if (look.armour) {
      const plate = new THREE.SphereGeometry(rb * 1.05, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
      add(plate, mats.iron, 0, len * 0.72, 0, 1.25, 0.7, 0.8);
      for (const sx of [-1, 1]) {
        const pa = new THREE.SphereGeometry(rb * 0.55, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
        const m = add(pa, mats.iron, sx * rb * 1.15, len * 0.86, 0, 1, 0.8, 1);
        m.rotation.z = -sx * 0.5;
      }
    }
  } else if (part === 'head') {
    // neck
    add(limbGeo(len * 0.55, ra, ra * 0.9, 0.05, look.gaunt, seed), mats.flesh);
    // skull
    const skull = new THREE.Group();
    skull.position.set(0, len - rb * 0.4, 0);
    root.add(skull);
    const cran = new THREE.Mesh(new THREE.SphereGeometry(rb, 18, 14), mats.flesh);
    if (look.id === 'stalker') cran.scale.set(0.7, 1.15, 1.35);
    else cran.scale.set(0.82, 1.05, 1.0);
    // sunken temples and a heavy brow
    const brow = new THREE.Mesh(new THREE.CapsuleGeometry(rb * 0.16, rb * 0.9, 3, 8), mats.flesh);
    brow.rotation.z = Math.PI / 2;
    brow.position.set(0, rb * 0.3, rb * 0.72);
    skull.add(brow);
    if (look.id === 'hollow' || look.id === 'weeper') {
      // lank strands of hair
      const rng = new RNG(seed + 11);
      const hairMat = new THREE.MeshStandardMaterial({ color: 0x0d0b09, roughness: 0.7 });
      for (let i = 0; i < 14; i++) {
        const a = rng.range(Math.PI * 0.55, Math.PI * 1.45) + Math.PI / 2;
        const hl = rb * rng.range(1.4, 3.2);
        const st = new THREE.Mesh(new THREE.CylinderGeometry(rb * 0.025, rb * 0.012, hl, 3), hairMat);
        st.position.set(Math.cos(a) * rb * 0.75, rb * 0.35 - hl * 0.45, Math.sin(a) * rb * 0.8);
        st.rotation.set(rng.range(-0.15, 0.15) - Math.sin(a) * 0.25, 0, Math.cos(a) * 0.25);
        skull.add(st);
      }
    }
    if (look.id === 'weeper') {
      // swollen bile sac in the throat
      const sac = new THREE.Mesh(new THREE.SphereGeometry(rb * 0.75, 12, 10), new THREE.MeshPhysicalMaterial({ color: 0x4a6a2a, roughness: 0.2, transmission: 0, emissive: new THREE.Color(0.2, 0.6, 0.05), clearcoat: 1 }));
      sac.position.set(0, -rb * 1.1, rb * 0.55);
      sac.scale.set(1, 0.85, 1);
      skull.add(sac);
    }
    cran.castShadow = true;
    skull.add(cran);
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(rb * 1.1, rb * 0.5, rb * 1.0, 2, 2, 2), mats.flesh);
    jaw.position.set(0, -rb * 0.7, rb * 0.25);
    jaw.rotation.x = 0.25;
    jaw.castShadow = true;
    jaw.name = 'jaw';
    skull.add(jaw);
    // teeth
    const teeth = new THREE.Mesh(new THREE.BoxGeometry(rb * 0.9, rb * 0.12, rb * 0.1), mats.bone);
    teeth.position.set(0, -rb * 0.45, rb * 0.72);
    skull.add(teeth);
    for (const sx of [-1, 1]) {
      const socket = new THREE.Mesh(new THREE.SphereGeometry(rb * 0.24, 8, 6), mats.gore);
      socket.position.set(sx * rb * 0.33, rb * 0.08, rb * 0.78);
      socket.scale.set(1.2, 0.8, 0.5);
      skull.add(socket);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(rb * 0.11, 8, 6), mats.eye);
      eye.position.set(sx * rb * 0.33, rb * 0.08, rb * 0.86);
      skull.add(eye);
    }
    if (look.id === 'warden') {
      // crown of iron spikes
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const sp = new THREE.Mesh(new THREE.ConeGeometry(rb * 0.08, rb * (0.6 + (i % 2) * 0.4), 5), mats.iron);
        sp.position.set(Math.cos(a) * rb * 0.95, rb * 1.35, Math.sin(a) * rb * 0.95);
        sp.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3);
        skull.add(sp);
      }
    }
    if (look.armour) {
      const helm = new THREE.Mesh(new THREE.CylinderGeometry(rb * 1.02, rb * 1.08, rb * 1.5, 14, 1, true), mats.iron);
      helm.position.set(0, rb * 0.25, 0);
      helm.castShadow = true;
      skull.add(helm);
      const top = new THREE.Mesh(new THREE.SphereGeometry(rb * 1.02, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), mats.iron);
      top.position.set(0, rb * 1.0, 0);
      skull.add(top);
    }
  } else {
    const belly = part === 'arm' || part === 'thigh' ? 0.22 : 0.15;
    add(limbGeo(len, ra, rb, belly, look.gaunt, seed + segIdx), mats.flesh);
    // knobbly joint cap hides the seam with the parent segment
    add(new THREE.SphereGeometry(ra * 1.08, 10, 8), mats.flesh, 0, 0, 0, 1, 0.9, 1);
    if (part === 'forearm') {
      // hand + claws
      const hand = new THREE.Mesh(new THREE.BoxGeometry(rb * 2.2, rb * 2.6, rb * 1.1), mats.flesh);
      hand.position.set(0, len + rb * 1.3, 0);
      hand.castShadow = true;
      root.add(hand);
      // long fingers ending in black-nailed claws
      for (let i = 0; i < 4; i++) {
        const fl = rb * (2.0 + (i === 1 || i === 2 ? 0.5 : 0)) * (look.id === 'weeper' || look.id === 'stalker' ? 1.5 : 1);
        const f = new THREE.Mesh(new THREE.CapsuleGeometry(rb * 0.17, fl, 3, 5), mats.flesh);
        f.position.set((i - 1.5) * rb * 0.55, len + rb * 2.4 + fl * 0.5, rb * 0.1 + fl * 0.15);
        f.rotation.x = 0.3;
        f.castShadow = true;
        root.add(f);
        const c = new THREE.Mesh(new THREE.ConeGeometry(rb * 0.15, rb * 1.1, 5), mats.bone);
        c.position.set((i - 1.5) * rb * 0.55, len + rb * 2.6 + fl * 1.05, rb * 0.1 + fl * 0.32);
        c.rotation.x = 0.55;
        root.add(c);
      }
      const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(rb * 0.19, rb * 1.3, 3, 5), mats.flesh);
      thumb.position.set(rb * 1.15, len + rb * 1.6, rb * 0.6);
      thumb.rotation.set(0.6, 0, -0.6);
      root.add(thumb);
    } else if (part === 'shin') {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(rb * 2.4, rb * 1.4, rb * 5.5), mats.flesh);
      foot.position.set(0, len + rb * 0.2, rb * 1.6);
      foot.castShadow = true;
      root.add(foot);
    }
    if (look.armour && (part === 'forearm' || part === 'shin')) {
      const brace = new THREE.Mesh(new THREE.CylinderGeometry(rb * 1.35, ra * 1.3, len * 0.6, 10, 1, true), mats.iron);
      brace.position.set(0, len * 0.55, 0);
      root.add(brace);
    }
  }
  root.userData.seg = segIdx;
  return root;
}

const capGeo = new THREE.CircleGeometry(1, 12);
capGeo.rotateX(-Math.PI / 2); // normal +Y
const boneGeo = new THREE.CylinderGeometry(0.28, 0.32, 0.6, 7);
boneGeo.translate(0, 0.3, 0);

/** A raw wound cap facing +Y (or -Y if flip) at the given local height. */
export function makeWoundCap(radius: number, mats: CreatureMats, flip: boolean): THREE.Object3D {
  const g = new THREE.Group();
  const disk = new THREE.Mesh(capGeo, mats.gore);
  disk.scale.setScalar(radius * 1.05);
  g.add(disk);
  const bone = new THREE.Mesh(boneGeo, mats.bone);
  bone.scale.set(radius, radius * 0.8, radius);
  g.add(bone);
  // ragged flesh ring
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.95, radius * 0.22, 5, 12), mats.gore);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  if (flip) g.rotation.x = Math.PI;
  return g;
}
