// World interactables: reliquary chests, shrines, blood altars, lantern posts
// and dropped weapons.

import * as THREE from 'three';
import type { POI } from '../world/World';
import { makeChest } from '../world/PropMeshes';
import type { TextureGen } from '../render/TextureGen';
import type { Weapon } from './Loot';
import { buildMelee, buildCrossbow, type WeaponMats } from './WeaponModels';
import type { MeleeArchetype, RangedArchetype } from './Loot';

export interface LightSource {
  pos: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  radius: number;
  flicker: number;
  life?: number; // transient flashes
  maxLife?: number;
  real?: boolean; // may be assigned a real PointLight
}

export interface Interactable {
  id: string;
  kind: 'chest' | 'shrine' | 'altar' | 'lantern' | 'weapon';
  pos: THREE.Vector3;
  obj: THREE.Object3D;
  used: boolean;
  light?: LightSource;
  weapon?: Weapon;
  tier: number;
  anim: number;
  label(): string;
}

let mats: { wood: THREE.Material; iron: THREE.Material; flame: THREE.MeshBasicMaterial; blood: THREE.MeshStandardMaterial } | null = null;
let chestGeo: ReturnType<typeof makeChest> | null = null;

function getMats(tex: TextureGen) {
  if (!mats) {
    mats = {
      wood: tex.material('wood', 512, { metalness: 0 }),
      iron: tex.material('steel', 512, { color: new THREE.Color(0.3, 0.27, 0.25) }),
      flame: new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 2.4, 0.5) }),
      blood: new THREE.MeshStandardMaterial({ color: 0x2a0000, roughness: 0.08, metalness: 0, emissive: new THREE.Color(0.25, 0, 0) }),
    };
  }
  return mats;
}

export function createInteractable(poi: POI, tex: TextureGen, used: boolean): Interactable | null {
  const m = getMats(tex);
  const pos = new THREE.Vector3(poi.x, poi.y, poi.z);
  const obj = new THREE.Group();
  obj.position.copy(pos);
  obj.rotation.y = poi.rot;
  switch (poi.kind) {
    case 'chest': {
      chestGeo ??= makeChest();
      const body = new THREE.Mesh(chestGeo.body, m.wood);
      const bands = new THREE.Mesh(chestGeo.bands, m.iron);
      const lidPivot = new THREE.Group();
      lidPivot.position.set(0, 0.6, -0.35);
      const lid = new THREE.Mesh(chestGeo.lid, m.wood);
      lid.position.set(0, 0, 0);
      lidPivot.add(lid);
      lidPivot.name = 'lid';
      for (const o of [body, bands, lid]) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
      obj.add(body, bands, lidPivot);
      if (used) lidPivot.rotation.x = -1.9;
      // faint glow leaking from tier 2 chests
      const it: Interactable = {
        id: poi.id, kind: 'chest', pos, obj, used, tier: poi.tier, anim: used ? 1 : 0,
        label: () => (it.used ? '' : poi.tier >= 2 ? 'Open Ornate Reliquary' : 'Open Reliquary'),
      };
      if (!used && poi.tier >= 2) it.light = { pos: pos.clone().add(new THREE.Vector3(0, 0.8, 0)), color: new THREE.Color(1, 0.75, 0.4), intensity: 1.2, radius: 4, flicker: 0.1 };
      return it;
    }
    case 'shrine': {
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), m.flame);
      flame.position.set(0, 1.95, 0);
      flame.scale.set(1, 1.6, 1);
      flame.name = 'flame';
      flame.visible = !used || poi.tier === 0;
      obj.add(flame);
      const it: Interactable = {
        id: poi.id, kind: 'shrine', pos, obj, used, tier: poi.tier, anim: 0,
        label: () => (poi.tier === 0 ? 'The Last Vigil' : it.used ? 'Spent Shrine' : poi.tier >= 2 ? 'Kneel at the Stone Circle' : 'Pray at the Shrine'),
      };
      it.light = { pos: pos.clone().add(new THREE.Vector3(0, 2.2, 0)), color: poi.tier >= 2 ? new THREE.Color(0.55, 0.7, 1.0) : new THREE.Color(1, 0.55, 0.22), intensity: used && poi.tier !== 0 ? 0 : 14, radius: 14, flicker: 0.25, real: true };
      if (poi.tier >= 2) flame.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 2.6, 8) });
      return it;
    }
    case 'altar': {
      const stone = tex.material('rock', 512, { metalness: 0 });
      const slab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 0.9), stone);
      slab.position.y = 0.35;
      slab.castShadow = true;
      slab.receiveShadow = true;
      const pool = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.3, 0.04, 16), m.blood);
      pool.position.y = 0.81;
      pool.name = 'pool';
      obj.add(slab, pool);
      for (const sx of [-0.65, 0.65]) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.3, 6), new THREE.MeshStandardMaterial({ color: 0xd8ccb0, roughness: 0.8 }));
        c.position.set(sx, 0.95, 0.25);
        const f = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 5), m.flame);
        f.position.set(sx, 1.13, 0.25);
        f.scale.y = 1.8;
        obj.add(c, f);
      }
      const it: Interactable = {
        id: poi.id, kind: 'altar', pos, obj, used, tier: poi.tier, anim: 0,
        label: () => (it.used ? 'Dry Altar' : 'Bleed upon the Altar  (−25% max health → forbidden boon)'),
      };
      it.light = { pos: pos.clone().add(new THREE.Vector3(0, 1.3, 0)), color: new THREE.Color(1, 0.3, 0.15), intensity: used ? 1 : 3, radius: 6, flicker: 0.3, real: true };
      return it;
    }
    case 'lantern': {
      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), m.flame);
      flame.scale.y = 1.6;
      obj.position.set(poi.x, poi.y, poi.z);
      obj.rotation.set(0, 0, 0);
      obj.add(flame);
      const it: Interactable = { id: poi.id, kind: 'lantern', pos, obj, used: true, tier: 0, anim: 0, label: () => '' };
      it.light = { pos: pos.clone(), color: new THREE.Color(1, 0.62, 0.3), intensity: 7, radius: 12, flicker: 0.2, real: true };
      return it;
    }
    case 'lair':
      return null;
  }
}

export function createWeaponDrop(w: Weapon, pos: THREE.Vector3, wm: WeaponMats): Interactable {
  const obj = new THREE.Group();
  obj.position.copy(pos);
  const model = w.kind === 'melee' ? buildMelee(w.archetype as MeleeArchetype, wm, w.rarity) : buildCrossbow(w.archetype as RangedArchetype, wm).group;
  model.rotation.set(Math.PI / 2 - 0.2, 0, 0.3);
  model.position.y = 0.6;
  model.name = 'model';
  obj.add(model);
  const color = new THREE.Color(w.rarity.color);
  const it: Interactable = {
    id: 'drop:' + w.uid, kind: 'weapon', pos: pos.clone(), obj, used: false, weapon: w, tier: w.rarity.tier, anim: Math.random() * 6,
    label: () => `Take ${w.name}`,
  };
  it.light = { pos: pos.clone().add(new THREE.Vector3(0, 0.7, 0)), color, intensity: 0.6 + w.rarity.tier * 0.5, radius: 3 + w.rarity.tier, flicker: 0.05 };
  return it;
}
