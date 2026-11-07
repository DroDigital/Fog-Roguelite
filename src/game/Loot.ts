// Randomised loot: weapons with rarity tiers and affixes, plus in-run boons.

import { RNG } from '../engine/Random';
import type { Mod } from './Stats';

export type MeleeArchetype = 'longsword' | 'greataxe' | 'mace' | 'falchion';
export type RangedArchetype = 'crossbow' | 'arbalest';

export interface Rarity { tier: number; name: string; color: string; affixes: number; mult: number }
export const RARITIES: Rarity[] = [
  { tier: 0, name: 'Worn', color: '#9a958c', affixes: 0, mult: 1 },
  { tier: 1, name: 'Forged', color: '#c9c3b5', affixes: 1, mult: 1.12 },
  { tier: 2, name: 'Rune-etched', color: '#5fa8d3', affixes: 2, mult: 1.25 },
  { tier: 3, name: 'Relic', color: '#c79bf2', affixes: 3, mult: 1.4 },
  { tier: 4, name: 'Abyssal', color: '#ff5a3c', affixes: 4, mult: 1.6 },
];

export interface MeleeStats {
  damage: number;
  speed: number; // swings per second multiplier
  reach: number; // blade length (m)
  stamina: number;
  sever: number; // dismember power
  blunt: boolean;
  stagger: number;
}

export interface Weapon {
  uid: number;
  kind: 'melee' | 'ranged';
  archetype: MeleeArchetype | RangedArchetype;
  name: string;
  rarity: Rarity;
  melee?: MeleeStats;
  ranged?: { damage: number; reload: number; velocity: number };
  affixes: { text: string; mods: Mod[] }[];
  mods: Mod[];
}

const MELEE_BASE: Record<MeleeArchetype, MeleeStats & { label: string }> = {
  longsword: { label: 'Longsword', damage: 34, speed: 1, reach: 1.05, stamina: 14, sever: 1, blunt: false, stagger: 1 },
  greataxe: { label: 'Greataxe', damage: 52, speed: 0.74, reach: 1.0, stamina: 22, sever: 1.6, blunt: false, stagger: 1.5 },
  mace: { label: 'Flanged Mace', damage: 44, speed: 0.86, reach: 0.85, stamina: 18, sever: 0.15, blunt: true, stagger: 2 },
  falchion: { label: 'Falchion', damage: 26, speed: 1.3, reach: 0.9, stamina: 10, sever: 1.15, blunt: false, stagger: 0.7 },
};

const RANGED_BASE: Record<RangedArchetype, { label: string; damage: number; reload: number; velocity: number }> = {
  crossbow: { label: 'Crossbow', damage: 55, reload: 1.1, velocity: 75 },
  arbalest: { label: 'Arbalest', damage: 95, reload: 1.9, velocity: 95 },
};

const AFFIXES: { text: string; mods: Mod[]; w: number; melee?: boolean; ranged?: boolean }[] = [
  { text: 'Keen', mods: [{ stat: 'critChance', add: 0.08 }], w: 3 },
  { text: 'Brutal', mods: [{ stat: 'critMult', add: 0.5 }], w: 2 },
  { text: 'Serrated', mods: [{ stat: 'bleedChance', add: 0.18 }], w: 2, melee: true },
  { text: 'Cleaving', mods: [{ stat: 'severMult', mul: 1.3 }], w: 3, melee: true },
  { text: 'Swift', mods: [{ stat: 'attackSpeed', mul: 1.12 }], w: 2, melee: true },
  { text: 'Thirsting', mods: [{ stat: 'lifesteal', add: 0.025 }], w: 1 },
  { text: 'Reaping', mods: [{ stat: 'healOnKill', add: 3 }], w: 2 },
  { text: 'Warding', mods: [{ stat: 'blockEff', mul: 1.25 }], w: 2, melee: true },
  { text: 'Fleet', mods: [{ stat: 'moveSpeed', mul: 1.05 }], w: 2 },
  { text: 'Vigorous', mods: [{ stat: 'maxHp', add: 15 }], w: 2 },
  { text: 'Tireless', mods: [{ stat: 'staminaRegen', mul: 1.15 }], w: 2 },
  { text: 'Quick-wound', mods: [{ stat: 'reloadSpeed', mul: 1.2 }], w: 3, ranged: true },
  { text: 'Piercing', mods: [{ stat: 'rangedDmg', mul: 1.15 }], w: 3, ranged: true },
  { text: 'Echoing', mods: [{ stat: 'echoGain', mul: 1.15 }], w: 1 },
];

const NAMES_PRE = ['Grave', 'Ashen', 'Hollow', 'Pale', 'Weeping', 'Bitter', 'Mourning', 'Black', 'Rusted', 'Saint', 'Gaunt', 'Vigil'];
const NAMES_SUF = ['of the Barrow', 'of Last Light', 'of the Drowned', 'of Thorns', 'of the Mire', 'of Ash', 'of Silence', 'of the Wake'];

let uidCounter = 1;

export function rollRarity(rng: RNG, tierBias: number, luck: number): Rarity {
  const r = rng.next() + tierBias * 0.12 + luck * 0.05;
  if (r > 1.12) return RARITIES[4];
  if (r > 0.97) return RARITIES[3];
  if (r > 0.8) return RARITIES[2];
  if (r > 0.45) return RARITIES[1];
  return RARITIES[0];
}

export function makeMelee(archetype: MeleeArchetype, rarity: Rarity, rng: RNG): Weapon {
  const b = MELEE_BASE[archetype];
  const affixes = pickAffixes(rng, rarity.affixes, 'melee');
  const name = rarity.tier >= 2 ? `${rng.pick(NAMES_PRE)} ${b.label}${rarity.tier >= 3 ? ' ' + rng.pick(NAMES_SUF) : ''}` : `${rarity.name} ${b.label}`;
  return {
    uid: uidCounter++,
    kind: 'melee',
    archetype,
    name,
    rarity,
    melee: { ...b, damage: Math.round(b.damage * rarity.mult * rng.range(0.92, 1.08)) },
    affixes,
    mods: affixes.flatMap((a) => a.mods),
  };
}

export function makeRanged(archetype: RangedArchetype, rarity: Rarity, rng: RNG): Weapon {
  const b = RANGED_BASE[archetype];
  const affixes = pickAffixes(rng, rarity.affixes, 'ranged');
  const name = rarity.tier >= 2 ? `${rng.pick(NAMES_PRE)} ${b.label}` : `${rarity.name} ${b.label}`;
  return {
    uid: uidCounter++,
    kind: 'ranged',
    archetype,
    name,
    rarity,
    ranged: { damage: Math.round(b.damage * rarity.mult * rng.range(0.92, 1.08)), reload: b.reload, velocity: b.velocity },
    affixes,
    mods: affixes.flatMap((a) => a.mods),
  };
}

function pickAffixes(rng: RNG, n: number, kind: 'melee' | 'ranged') {
  const pool = AFFIXES.filter((a) => (kind === 'melee' ? !a.ranged : !a.melee));
  const out: { text: string; mods: Mod[] }[] = [];
  for (let i = 0; i < n && pool.length; i++) {
    const a = rng.weighted(pool.map((p) => ({ item: p, w: p.w })));
    pool.splice(pool.indexOf(a), 1);
    out.push({ text: a.text, mods: a.mods });
  }
  return out;
}

export function randomWeapon(rng: RNG, tierBias: number, luck: number): Weapon {
  const rarity = rollRarity(rng, tierBias, luck);
  if (rng.chance(0.28)) return makeRanged(rng.chance(0.65) ? 'crossbow' : 'arbalest', rarity, rng);
  return makeMelee(rng.pick(['longsword', 'greataxe', 'mace', 'falchion'] as const), rarity, rng);
}

// ───────────────────────── Boons (level-up choices)

export interface Boon {
  id: string;
  name: string;
  desc: string;
  rarity: number; // 0 common, 1 rare, 2 cursed-legendary
  mods: Mod[];
  max: number;
}

export const BOONS: Boon[] = [
  { id: 'edge', name: 'Whetstone Prayer', desc: '+12% melee damage', rarity: 0, mods: [{ stat: 'meleeDmg', mul: 1.12 }], max: 5 },
  { id: 'bolt', name: 'Fletcher\'s Blessing', desc: '+15% ranged damage', rarity: 0, mods: [{ stat: 'rangedDmg', mul: 1.15 }], max: 5 },
  { id: 'hp', name: 'Grave Vigour', desc: '+20 max health', rarity: 0, mods: [{ stat: 'maxHp', add: 20 }], max: 5 },
  { id: 'stam', name: 'Iron Lungs', desc: '+20 max stamina', rarity: 0, mods: [{ stat: 'maxStamina', add: 20 }], max: 4 },
  { id: 'speed', name: 'Mist Stride', desc: '+6% move speed', rarity: 0, mods: [{ stat: 'moveSpeed', mul: 1.06 }], max: 4 },
  { id: 'aspd', name: 'Feverish Arm', desc: '+8% attack speed', rarity: 0, mods: [{ stat: 'attackSpeed', mul: 1.08 }], max: 4 },
  { id: 'sever', name: 'Carver\'s Hunger', desc: '+30% dismemberment', rarity: 0, mods: [{ stat: 'severMult', mul: 1.3 }], max: 4 },
  { id: 'crit', name: 'Omen of Ruin', desc: '+6% critical chance', rarity: 0, mods: [{ stat: 'critChance', add: 0.06 }], max: 5 },
  { id: 'quiver', name: 'Bundle of Bolts', desc: '+8 bolt capacity, refill quiver', rarity: 0, mods: [{ stat: 'bolts', add: 8 }], max: 3 },
  { id: 'vial', name: 'Blood Vial', desc: '+1 vial capacity', rarity: 1, mods: [{ stat: 'vials', add: 1 }], max: 2 },
  { id: 'bleed', name: 'Weeping Wounds', desc: '+20% bleed chance on melee hits', rarity: 1, mods: [{ stat: 'bleedChance', add: 0.2 }], max: 3 },
  { id: 'leech', name: 'Leech Rite', desc: '+2% lifesteal', rarity: 1, mods: [{ stat: 'lifesteal', add: 0.02 }], max: 3 },
  { id: 'harvest', name: 'Reaper\'s Tithe', desc: 'Heal 3 per kill', rarity: 1, mods: [{ stat: 'healOnKill', add: 3 }], max: 3 },
  { id: 'reload', name: 'Clockwork Crank', desc: '+25% reload speed', rarity: 1, mods: [{ stat: 'reloadSpeed', mul: 1.25 }], max: 3 },
  { id: 'hide', name: 'Barrow Hide', desc: '-10% damage taken', rarity: 1, mods: [{ stat: 'damageTaken', mul: 0.9 }], max: 3 },
  { id: 'thorns', name: 'Briar Heart', desc: 'Attackers take 10 damage', rarity: 1, mods: [{ stat: 'thorns', add: 10 }], max: 3 },
  { id: 'ember', name: 'Ember Bolts', desc: 'Bolts burst into flame on impact', rarity: 2, mods: [{ stat: 'explosiveBolts', add: 1 }], max: 1 },
  { id: 'split', name: 'Forked Shot', desc: 'Loose an extra bolt per shot', rarity: 2, mods: [{ stat: 'boltsPerShot', add: 1 }], max: 2 },
  { id: 'exec', name: 'Headsman\'s Oath', desc: 'Execute foes below 12% health', rarity: 2, mods: [{ stat: 'executeBelow', add: 0.12 }], max: 2 },
  { id: 'glass', name: 'Glass Covenant', desc: '+40% all damage, +25% damage taken', rarity: 2, mods: [{ stat: 'meleeDmg', mul: 1.4 }, { stat: 'rangedDmg', mul: 1.4 }, { stat: 'damageTaken', mul: 1.25 }], max: 1 },
  { id: 'wick', name: 'Undying Wick', desc: 'Lantern +40% radius, fog parts around you', rarity: 1, mods: [{ stat: 'lanternRadius', mul: 1.4 }, { stat: 'fogClear', mul: 1.8 }], max: 1 },
];

export function rollBoons(rng: RNG, owned: Map<string, number>, n = 3): Boon[] {
  const pool = BOONS.filter((b) => (owned.get(b.id) ?? 0) < b.max);
  const out: Boon[] = [];
  for (let i = 0; i < n && pool.length; i++) {
    const b = rng.weighted(pool.map((p) => ({ item: p, w: p.rarity === 0 ? 10 : p.rarity === 1 ? 4.5 : 1.6 })));
    pool.splice(pool.indexOf(b), 1);
    out.push(b);
  }
  return out;
}
