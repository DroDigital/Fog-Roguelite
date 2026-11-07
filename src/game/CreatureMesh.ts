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

export function makeCreatureMats(tex: TextureGen, look: CreatureLook): CreatureMats {
  const flesh = tex.material('flesh', 512, { color: look.skin, metalness: 0 });
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
    if (look.cloth) {
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
    const cran = new THREE.Mesh(new THREE.SphereGeometry(rb, 16, 12), mats.flesh);
    cran.scale.set(0.82, 1.05, 1.0);
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
    if (part === 'forearm') {
      // hand + claws
      const hand = new THREE.Mesh(new THREE.BoxGeometry(rb * 2.2, rb * 2.6, rb * 1.1), mats.flesh);
      hand.position.set(0, len + rb * 1.3, 0);
      hand.castShadow = true;
      root.add(hand);
      for (let i = 0; i < 4; i++) {
        const c = new THREE.Mesh(new THREE.ConeGeometry(rb * 0.22, rb * 2.4, 5), mats.bone);
        c.position.set((i - 1.5) * rb * 0.55, len + rb * 3.4, rb * 0.15);
        c.rotation.x = 0.35;
        root.add(c);
      }
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
