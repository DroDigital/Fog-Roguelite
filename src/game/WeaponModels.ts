// Procedural first-person weapon models. Every model is built with its grip
// at the origin and the business end pointing down -Z.

import * as THREE from 'three';
import type { TextureGen } from '../render/TextureGen';
import type { MeleeArchetype, RangedArchetype, Rarity } from './Loot';

export interface WeaponMats {
  steel: THREE.MeshStandardMaterial;
  darkSteel: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  leather: THREE.MeshStandardMaterial;
  bloodU: { value: number };
}

export function makeWeaponMats(tex: TextureGen): WeaponMats {
  const bloodU = { value: 0 };
  const steel = tex.material("steel", 512, { envMapIntensity: 2.6 });
  // blood smears build up on the blade the more you kill
  steel.onBeforeCompile = (sh) => {
    sh.uniforms.uBlood = bloodU;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uBlood;\nfloat bh(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}\nfloat bn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(bh(i),bh(i+vec2(1,0)),f.x),mix(bh(i+vec2(0,1)),bh(i+vec2(1,1)),f.x),f.y);}')
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         float bm = 0.0;
         #ifdef USE_MAP
           vec2 bp = vMapUv * vec2(6.0, 30.0);
           bm = smoothstep(0.55, 0.62, bn(bp) * 0.6 + bn(bp * 2.7) * 0.4 + uBlood * 0.45 - 0.35);
         #endif
         bm *= step(0.001, uBlood);
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.0, 0.0), bm * 0.9);
         roughnessFactor = mix(roughnessFactor, 0.12, bm);`,
      )
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.0, bm);');
  };
  steel.customProgramCacheKey = () => 'bloodsteel';
  const darkSteel = tex.material('steel', 512, { color: new THREE.Color(0.35, 0.33, 0.32) });
  const wood = tex.material('wood', 512, { metalness: 0 });
  const leather = tex.material('leather', 512, { metalness: 0 });
  return { steel, darkSteel, wood, leather, bloodU };
}

/** Lofted blade with a diamond cross-section and crisp edges; length along -Z. */
function bladeGeo(len: number, w0: number, w1: number, thick: number, curve = 0, chop = 0): THREE.BufferGeometry {
  const N = 28;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const station = (t: number) => {
    let w = w0 + (w1 - w0) * t + chop * Math.sin(t * Math.PI);
    if (t > 0.86) w *= Math.max(0, 1 - (t - 0.86) / 0.14) ** 0.8;
    const th = thick * (1 - t * 0.5) * (t > 0.86 ? Math.max(0.15, 1 - (t - 0.86) / 0.14) : 1);
    const c = curve * t * t;
    return { w: Math.max(w, 1e-4), th, c, z: -t * len };
  };
  // 4 faces: (+x edge → +y spine), (+y → -x), (-x → -y), (-y → +x)
  const corners = (st: { w: number; th: number; c: number; z: number }) => [
    [st.w / 2 + st.c, 0], [st.c * 0.5, st.th / 2], [-st.w / 2 + st.c * 0.2, 0], [st.c * 0.5, -st.th / 2],
  ];
  for (let f = 0; f < 4; f++) {
    const base = pos.length / 3;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const st = station(t);
      const cs = corners(st);
      const a = cs[f], b = cs[(f + 1) % 4];
      pos.push(a[0], a[1], st.z, b[0], b[1], st.z);
      uv.push(0.5 + (f % 2) * 0.25, t, 0.75 - (f % 2) * 0.25, t);
    }
    for (let i = 0; i < N; i++) {
      const k = base + i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // ensure outward winding
  const n = g.attributes.normal as THREE.BufferAttribute;
  if (n.getX(0) < 0) {
    g.setIndex(idx.map((_, i) => idx[i - (i % 3) + (2 - (i % 3))]));
    g.computeVertexNormals();
  }
  return g;
}

function cyl(r0: number, r1: number, len: number, mat: THREE.Material, z0: number, seg = 10) {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.z = z0 - len / 2;
  m.castShadow = true;
  return m;
}

export function buildMelee(kind: MeleeArchetype, mats: WeaponMats, rarity: Rarity): THREE.Group {
  const g = new THREE.Group();
  const add = (m: THREE.Mesh) => {
    m.castShadow = true;
    g.add(m);
    return m;
  };
  const rune = rarity.tier >= 2;
  if (kind === 'longsword' || kind === 'falchion') {
    const isF = kind === 'falchion';
    // grip behind the hand, blade in front
    add(cyl(0.017, 0.015, 0.2, mats.leather, 0.12));
    const pommel = add(new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), mats.darkSteel));
    pommel.position.z = 0.13;
    const guard = add(new THREE.Mesh(new THREE.BoxGeometry(isF ? 0.16 : 0.24, 0.026, 0.03), mats.darkSteel));
    guard.position.z = -0.08;
    if (!isF) {
      for (const sx of [-1, 1]) {
        const q = add(new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), mats.darkSteel));
        q.position.set(sx * 0.12, 0, -0.08);
      }
    }
    const blade = add(new THREE.Mesh(isF ? bladeGeo(0.82, 0.045, 0.075, 0.009, 0.05, 0.01) : bladeGeo(0.98, 0.052, 0.022, 0.009), mats.steel));
    blade.position.z = -0.09;
    if (rune) {
      const glow = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.002, 0.5), new THREE.MeshBasicMaterial({ color: new THREE.Color(rarity.color).multiplyScalar(4) }));
      glow.position.set(0, 0.0055, -0.4);
      g.add(glow);
    }
  } else if (kind === 'greataxe') {
    add(cyl(0.02, 0.018, 1.05, mats.wood, 0.3));
    const s = new THREE.Shape();
    s.moveTo(0, -0.06);
    s.quadraticCurveTo(0.12, -0.08, 0.2, -0.18);
    s.quadraticCurveTo(0.26, 0, 0.2, 0.18);
    s.quadraticCurveTo(0.12, 0.06, 0, 0.06);
    s.lineTo(0, -0.06);
    const head = new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.01, bevelSegments: 2, curveSegments: 8 });
    head.translate(0, 0, -0.006);
    head.rotateY(Math.PI / 2);
    head.rotateX(-Math.PI / 2);
    const hm = add(new THREE.Mesh(head, mats.steel));
    hm.position.set(0, 0, -0.68);
    hm.rotation.z = -Math.PI / 2;
    const collar = add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 8), mats.darkSteel));
    collar.rotation.x = Math.PI / 2;
    collar.position.z = -0.7;
    const spike = add(new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.12, 6), mats.darkSteel));
    spike.rotation.x = -Math.PI / 2;
    spike.position.z = -0.8;
  } else {
    // mace
    add(cyl(0.017, 0.016, 0.62, mats.wood, 0.12));
    const head = new THREE.Group();
    head.position.z = -0.52;
    g.add(head);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), mats.darkSteel);
    core.scale.z = 1.6;
    head.add(core);
    for (let i = 0; i < 7; i++) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.07, 0.15), mats.steel);
      const a = (i / 7) * Math.PI * 2;
      f.position.set(Math.cos(a) * 0.045, Math.sin(a) * 0.045, 0);
      f.rotation.z = a + Math.PI / 2;
      f.castShadow = true;
      head.add(f);
    }
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.07, 6), mats.steel);
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = -0.1;
    head.add(tip);
  }
  return g;
}

export interface CrossbowModel {
  group: THREE.Group;
  string: THREE.Line;
  bolt: THREE.Object3D;
  setDraw(t: number): void; // 0 = released, 1 = spanned
}

export function buildCrossbow(kind: RangedArchetype, mats: WeaponMats): CrossbowModel {
  const g = new THREE.Group();
  const big = kind === 'arbalest' ? 1.2 : 1;
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.62 * big), mats.wood);
  stock.position.set(0, -0.01, -0.12);
  stock.castShadow = true;
  g.add(stock);
  const butt = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.11, 0.18), mats.wood);
  butt.position.set(0, -0.04, 0.22);
  g.add(butt);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.5 * big), mats.darkSteel);
  rail.position.set(0, 0.025, -0.16);
  g.add(rail);
  // prod (bow)
  const span = 0.34 * big;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16 - 0.5;
    pts.push(new THREE.Vector3(t * span * 2, 0.02, -0.42 * big + Math.abs(t) * t * 0 + t * t * 0.28));
  }
  const prod = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.011, 6, false), mats.steel);
  prod.castShadow = true;
  g.add(prod);
  const tipL = pts[0], tipR = pts[16];
  const nutZ = -0.06;
  const sg = new THREE.BufferGeometry().setFromPoints([tipL, new THREE.Vector3(0, 0.03, nutZ), tipR]);
  const string = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: 0x9a8f78 }));
  g.add(string);
  // stirrup
  const stir = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.007, 5, 12, Math.PI), mats.darkSteel);
  stir.position.set(0, 0.02, -0.46 * big);
  stir.rotation.x = Math.PI / 2;
  g.add(stir);
  // trigger
  const trig = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.05, 0.015), mats.darkSteel);
  trig.position.set(0, -0.06, 0.02);
  g.add(trig);
  // loaded bolt
  const bolt = makeBoltMesh(mats);
  bolt.position.set(0, 0.04, nutZ);
  g.add(bolt);
  const setDraw = (t: number) => {
    const pos = sg.attributes.position as THREE.BufferAttribute;
    const z = -0.42 * big + 0.07 + (nutZ - (-0.42 * big + 0.07)) * t;
    pos.setXYZ(1, 0, 0.03, z);
    // prod flexes when spanned
    pos.setXYZ(0, tipL.x * (1 - 0.12 * t), tipL.y, tipL.z + 0.05 * t);
    pos.setXYZ(2, tipR.x * (1 - 0.12 * t), tipR.y, tipR.z + 0.05 * t);
    pos.needsUpdate = true;
    prod.scale.x = 1 - 0.12 * t;
  };
  setDraw(1);
  return { group: g, string, bolt, setDraw };
}

/** Bolt mesh with its tip at -Z. */
export function makeBoltMesh(mats: WeaponMats): THREE.Group {
  const b = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.36, 5), mats.wood);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = -0.18;
  b.add(shaft);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.05, 4), mats.darkSteel);
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = -0.38;
  b.add(tip);
  for (let i = 0; i < 3; i++) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(0.025, 0.06), new THREE.MeshStandardMaterial({ color: 0x2a1d17, side: THREE.DoubleSide, roughness: 1 }));
    f.rotation.set(Math.PI / 2, (i / 3) * Math.PI * 2, 0);
    f.position.z = -0.02;
    const holder = new THREE.Group();
    holder.rotation.z = (i / 3) * Math.PI * 2;
    f.rotation.set(Math.PI / 2, 0, 0);
    f.position.set(0.012, 0, -0.03);
    holder.add(f);
    b.add(holder);
  }
  return b;
}

/** Held lantern for the off hand. */
export function buildLantern(mats: WeaponMats): { group: THREE.Group; flame: THREE.Mesh } {
  const g = new THREE.Group();
  const frame = mats.darkSteel;
  const top = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.05, 6), frame);
  top.position.y = 0.085;
  g.add(top);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.02, 6), frame);
  base.position.y = -0.07;
  g.add(base);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.14, 0.006), frame);
    bar.position.set(Math.cos(a) * 0.052, 0, Math.sin(a) * 0.052);
    g.add(bar);
  }
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.05, 0.13, 12, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.16, 0.05), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
  g.add(glass);
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 3.6, 0.9) }));
  flame.scale.y = 1.8;
  g.add(flame);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.004, 4, 10), frame);
  ring.position.y = 0.12;
  g.add(ring);
  return { group: g, flame };
}
