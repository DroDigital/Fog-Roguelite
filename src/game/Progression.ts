// Meta progression: the persistent skill tree bought with Echoes between runs.

import type { Mod } from './Stats';

export interface SkillNode {
  id: string;
  name: string;
  desc: string;
  branch: 'blade' | 'hunter' | 'wraith';
  cost: number;
  requires: string[];
  mods: Mod[];
  x: number; // layout (0..1 within branch column)
  y: number; // tier
  flag?: string;
}

export const SKILL_TREE: SkillNode[] = [
  // ── Blade: melee & dismemberment
  { id: 'b1', name: 'Tempered Edge', desc: 'Your strikes bite deeper.', branch: 'blade', cost: 20, requires: [], mods: [{ stat: 'meleeDmg', mul: 1.12 }], x: 0.5, y: 0 },
  { id: 'b2', name: "Butcher's Wrist", desc: 'Limbs part like wet bread.', branch: 'blade', cost: 35, requires: ['b1'], mods: [{ stat: 'severMult', mul: 1.35 }], x: 0.25, y: 1 },
  { id: 'b3', name: 'Quickened Grip', desc: 'Swing faster.', branch: 'blade', cost: 35, requires: ['b1'], mods: [{ stat: 'attackSpeed', mul: 1.1 }], x: 0.75, y: 1 },
  { id: 'b4', name: 'Hemorrhage', desc: 'Melee hits may cause bleeding.', branch: 'blade', cost: 60, requires: ['b2'], mods: [{ stat: 'bleedChance', add: 0.2 }], x: 0.15, y: 2 },
  { id: 'b5', name: 'Iron Guard', desc: 'Blocking costs less stamina; wider parry window.', branch: 'blade', cost: 60, requires: ['b3'], mods: [{ stat: 'blockEff', mul: 1.3 }, { stat: 'parryWindow', add: 0.08 }], x: 0.85, y: 2 },
  { id: 'b6', name: 'Executioner', desc: 'Foes below 15% health die to any strike.', branch: 'blade', cost: 90, requires: ['b4'], mods: [{ stat: 'executeBelow', add: 0.15 }], x: 0.3, y: 3 },
  { id: 'b7', name: 'Riposte', desc: 'Strikes after a parry deal triple damage.', branch: 'blade', cost: 90, requires: ['b5'], mods: [{ stat: 'riposteMult', add: 1 }], x: 0.7, y: 3 },
  { id: 'b8', name: 'Red Harvest', desc: 'Heal 4 for every enemy slain.', branch: 'blade', cost: 140, requires: ['b6', 'b7'], mods: [{ stat: 'healOnKill', add: 4 }, { stat: 'meleeDmg', mul: 1.1 }], x: 0.5, y: 4 },
  // ── Hunter: ranged & mobility
  { id: 'h1', name: 'Steady Hands', desc: 'Bolts strike harder.', branch: 'hunter', cost: 20, requires: [], mods: [{ stat: 'rangedDmg', mul: 1.15 }], x: 0.5, y: 0 },
  { id: 'h2', name: 'Deep Quiver', desc: 'Carry more bolts.', branch: 'hunter', cost: 30, requires: ['h1'], mods: [{ stat: 'bolts', add: 10 }], x: 0.25, y: 1 },
  { id: 'h3', name: 'Fleet Foot', desc: 'Move faster.', branch: 'hunter', cost: 35, requires: ['h1'], mods: [{ stat: 'moveSpeed', mul: 1.08 }], x: 0.75, y: 1 },
  { id: 'h4', name: 'Practised Reload', desc: 'Reload 25% faster.', branch: 'hunter', cost: 55, requires: ['h2'], mods: [{ stat: 'reloadSpeed', mul: 1.25 }], x: 0.15, y: 2 },
  { id: 'h5', name: 'Shadowstep', desc: 'Dodging costs less stamina.', branch: 'hunter', cost: 55, requires: ['h3'], mods: [{ stat: 'dodgeCost', mul: 0.7 }], x: 0.85, y: 2 },
  { id: 'h6', name: 'Marksman', desc: 'Higher critical chance and damage.', branch: 'hunter', cost: 85, requires: ['h4'], mods: [{ stat: 'critChance', add: 0.1 }, { stat: 'critMult', add: 0.4 }], x: 0.3, y: 3 },
  { id: 'h7', name: 'Second Wind', desc: 'Stamina recovers much faster.', branch: 'hunter', cost: 85, requires: ['h5'], mods: [{ stat: 'staminaRegen', mul: 1.35 }], x: 0.7, y: 3 },
  { id: 'h8', name: 'Split Bolt', desc: 'The crossbow looses two bolts at once.', branch: 'hunter', cost: 150, requires: ['h6', 'h7'], mods: [{ stat: 'boltsPerShot', add: 1 }], x: 0.5, y: 4 },
  // ── Wraith: survival & fog
  { id: 'w1', name: 'Hollow Vigour', desc: 'More health.', branch: 'wraith', cost: 20, requires: [], mods: [{ stat: 'maxHp', add: 20 }], x: 0.5, y: 0 },
  { id: 'w2', name: 'Mistborn', desc: 'Creatures sense you from closer.', branch: 'wraith', cost: 35, requires: ['w1'], mods: [{ stat: 'detection', mul: 0.8 }], x: 0.25, y: 1 },
  { id: 'w3', name: 'Alchemist', desc: 'Carry an extra vial; vials heal more.', branch: 'wraith', cost: 40, requires: ['w1'], mods: [{ stat: 'vials', add: 1 }, { stat: 'vialHeal', add: 15 }], x: 0.75, y: 1 },
  { id: 'w4', name: 'Bright Wick', desc: 'Your lantern burns wider and parts the fog.', branch: 'wraith', cost: 55, requires: ['w2'], mods: [{ stat: 'lanternRadius', mul: 1.3 }, { stat: 'fogClear', mul: 1.6 }], x: 0.15, y: 2 },
  { id: 'w5', name: 'Scarred Hide', desc: 'Take less damage.', branch: 'wraith', cost: 65, requires: ['w3'], mods: [{ stat: 'damageTaken', mul: 0.88 }], x: 0.85, y: 2 },
  { id: 'w6', name: 'Echo Hoarder', desc: 'Gain more Echoes.', branch: 'wraith', cost: 80, requires: ['w4'], mods: [{ stat: 'echoGain', mul: 1.3 }], x: 0.3, y: 3 },
  { id: 'w7', name: 'Thornmail', desc: 'Attackers take damage when they strike you.', branch: 'wraith', cost: 80, requires: ['w5'], mods: [{ stat: 'thorns', add: 8 }, { stat: 'maxHp', add: 15 }], x: 0.7, y: 3 },
  { id: 'w8', name: 'Fog Communion', desc: 'Blood sustains you: 3% lifesteal.', branch: 'wraith', cost: 150, requires: ['w6', 'w7'], mods: [{ stat: 'lifesteal', add: 0.03 }, { stat: 'maxHp', add: 25 }], x: 0.5, y: 4 },
];

export interface MetaSave {
  version: 1;
  echoes: number;
  unlocked: string[];
  runs: number;
  bestDistance: number;
  totalKills: number;
  bestKills: number;
  settings: { sensitivity: number; volume: number; quality: string; gore: number; fov: number };
}

const KEY = 'fog-roguelite-save-v1';

export function defaultSave(): MetaSave {
  return {
    version: 1,
    echoes: 0,
    unlocked: [],
    runs: 0,
    bestDistance: 0,
    totalKills: 0,
    bestKills: 0,
    settings: { sensitivity: 1, volume: 0.8, quality: 'high', gore: 1, fov: 78 },
  };
}

export function loadSave(): MetaSave {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSave();
    const d = JSON.parse(raw) as Partial<MetaSave>;
    const def = defaultSave();
    return { ...def, ...d, settings: { ...def.settings, ...(d.settings ?? {}) } } as MetaSave;
  } catch {
    return defaultSave();
  }
}

export function writeSave(s: MetaSave) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: progress lasts for this session only */
  }
}

export function canUnlock(save: MetaSave, node: SkillNode) {
  if (save.unlocked.includes(node.id)) return false;
  if (save.echoes < node.cost) return false;
  return node.requires.every((r) => save.unlocked.includes(r));
}

export function metaMods(save: MetaSave): Mod[] {
  const out: Mod[] = [];
  for (const n of SKILL_TREE) if (save.unlocked.includes(n.id)) out.push(...n.mods);
  return out;
}
