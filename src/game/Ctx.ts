// Shared game context handed to subsystems (avoids import cycles).

import type * as THREE from 'three';
import type { World } from '../world/World';
import type { Gore } from './Gore';
import type { FogSim } from '../world/FogSim';
import type { TextureGen } from '../render/TextureGen';
import type { Corpse } from './Enemy';

export type HitResult = 'hit' | 'blocked' | 'parried' | 'dodged';

export interface Ctx {
  scene: THREE.Scene;
  world: World;
  gore: Gore;
  fog: FogSim;
  tex: TextureGen;
  time: number;
  difficulty: number;
  playerPos: THREE.Vector3; // feet
  playerEye: THREE.Vector3;
  playerNoise: number; // 0..1 how loud the player is this frame
  playerAlive: boolean;
  hitstop(seconds: number): void;
  shake(amount: number): void;
  damagePlayer(amount: number, from: THREE.Vector3, opts?: { unblockable?: boolean; knock?: number }): HitResult;
  onEnemyKilled(e: unknown, how: { severed: boolean; head: boolean; crit: boolean }): void;
  onPieceCreated(p: Corpse): void;
  spawnBile(from: THREE.Vector3, vel: THREE.Vector3, damage: number): void;
  summon(at: THREE.Vector3, n: number): void;
  pan(p: THREE.Vector3): { dist: number; pan: number };
}
