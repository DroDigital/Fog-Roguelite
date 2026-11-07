// Character statistics and the modifier system shared by the skill tree,
// in-run boons and weapon affixes.

export interface Stats {
  maxHp: number;
  maxStamina: number;
  staminaRegen: number;
  moveSpeed: number;
  meleeDmg: number;
  rangedDmg: number;
  attackSpeed: number;
  severMult: number;
  critChance: number;
  critMult: number;
  damageTaken: number;
  healOnKill: number;
  lifesteal: number;
  vials: number;
  vialHeal: number;
  bolts: number;
  reloadSpeed: number;
  boltsPerShot: number;
  explosiveBolts: number;
  detection: number;
  echoGain: number;
  dodgeCost: number;
  blockEff: number;
  parryWindow: number;
  riposteMult: number;
  bleedChance: number;
  lanternRadius: number;
  xpGain: number;
  luck: number;
  fogClear: number;
  thorns: number;
  executeBelow: number;
}

export type StatKey = keyof Stats;

export function baseStats(): Stats {
  return {
    maxHp: 100,
    maxStamina: 100,
    staminaRegen: 30,
    moveSpeed: 4.4,
    meleeDmg: 1,
    rangedDmg: 1,
    attackSpeed: 1,
    severMult: 1,
    critChance: 0.05,
    critMult: 1.8,
    damageTaken: 1,
    healOnKill: 0,
    lifesteal: 0,
    vials: 3,
    vialHeal: 45,
    bolts: 16,
    reloadSpeed: 1,
    boltsPerShot: 1,
    explosiveBolts: 0,
    detection: 1,
    echoGain: 1,
    dodgeCost: 22,
    blockEff: 1,
    parryWindow: 0.2,
    riposteMult: 2,
    bleedChance: 0,
    lanternRadius: 1,
    xpGain: 1,
    luck: 0,
    fogClear: 1,
    thorns: 0,
    executeBelow: 0,
  };
}

export interface Mod {
  stat: StatKey;
  add?: number;
  mul?: number;
}

export function applyMods(base: Stats, mods: Mod[]): Stats {
  const s = { ...base };
  const mul: Partial<Record<StatKey, number>> = {};
  for (const m of mods) {
    if (m.add) s[m.stat] += m.add;
    if (m.mul) mul[m.stat] = (mul[m.stat] ?? 1) * m.mul;
  }
  for (const k of Object.keys(mul) as StatKey[]) s[k] *= mul[k]!;
  return s;
}

export function describeMod(m: Mod): string {
  const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
  const names: Record<StatKey, string> = {
    maxHp: 'Max Health', maxStamina: 'Max Stamina', staminaRegen: 'Stamina Regen', moveSpeed: 'Move Speed',
    meleeDmg: 'Melee Damage', rangedDmg: 'Ranged Damage', attackSpeed: 'Attack Speed', severMult: 'Dismemberment',
    critChance: 'Crit Chance', critMult: 'Crit Damage', damageTaken: 'Damage Taken', healOnKill: 'Heal on Kill',
    lifesteal: 'Lifesteal', vials: 'Vials', vialHeal: 'Vial Potency', bolts: 'Bolt Capacity', reloadSpeed: 'Reload Speed',
    boltsPerShot: 'Bolts per Shot', explosiveBolts: 'Ember Bolts', detection: 'Detection Range', echoGain: 'Echo Gain',
    dodgeCost: 'Dodge Cost', blockEff: 'Block Efficiency', parryWindow: 'Parry Window', riposteMult: 'Riposte Damage',
    bleedChance: 'Bleed Chance', lanternRadius: 'Lantern Radius', xpGain: 'Experience', luck: 'Fortune',
    fogClear: 'Fog Dispersal', thorns: 'Thorns', executeBelow: 'Execute Threshold',
  };
  const n = names[m.stat];
  if (m.mul !== undefined) return `${pct(m.mul - 1)} ${n}`;
  const a = m.add ?? 0;
  if (['critChance', 'bleedChance', 'lifesteal', 'executeBelow'].includes(m.stat)) return `${pct(a)} ${n}`;
  if (m.stat === 'parryWindow') return `+${Math.round(a * 1000)}ms ${n}`;
  return `${a > 0 ? '+' : ''}${Math.round(a * 10) / 10} ${n}`;
}
