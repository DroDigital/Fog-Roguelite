// First-person player: movement, camera feel, melee (swept blade collision),
// blocking/parrying, dodging, the crossbow and the lantern.

import * as THREE from 'three';
import type { Input } from '../engine/Input';
import { audio } from '../engine/Audio';
import { clamp, damp, lerp, angleDiff } from '../engine/Random';
import type { Enemy, Corpse } from './Enemy';
import type { World } from '../world/World';
import type { Gore } from './Gore';
import type { FogSim } from '../world/FogSim';
import type { Projectiles } from './Projectiles';
import { applyMods, baseStats, type Mod, type Stats } from './Stats';
import type { Weapon, MeleeArchetype } from './Loot';
import { buildMelee, buildCrossbow, buildLantern, type WeaponMats, type CrossbowModel } from './WeaponModels';
import type { HitResult } from './Ctx';
import { IDLE, BLOCK, MOVES, COMBO, evalMove, moveLength, buildArm, buildGauntlet, poseArm, BladeTrail, type Pose, type MoveDef, type Arm } from './SwingAnim';

interface AtkState {
  def: MoveDef;
  name: string;
  t: number;
  prevT: number;
  start: Pose;
  hit: Set<number>;
  bounced: boolean;
  bite: number; // time left in the blade's bite (swing slows while it cuts through)
  connected: boolean;
}

export interface PlayerHost {
  input: Input;
  camera: THREE.PerspectiveCamera;
  world: World;
  gore: Gore;
  fog: FogSim;
  enemies: Enemy[];
  corpses: Corpse[];
  projectiles: Projectiles;
  time: number;
  hitstop(t: number): void;
  onMeleeHit(e: Enemy, seg: number, point: THREE.Vector3, dir: THREE.Vector3, move: { heavy: boolean; dmgMult: number; severMult: number; riposte: boolean; t: number }): void;
  onPlayerDeath(): void;
  onKick(origin: THREE.Vector3, dir: THREE.Vector3): void;
  onExecuteStrike(): void;
  notify(msg: string): void;
  bloodiness?(): number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _e = new THREE.Euler();

function easeStrike(t: number) {
  // fast through the middle of the arc
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function lerpPose(a: Pose, b: Pose, t: number, out: Pose) {
  out.y = lerp(a.y, b.y, t);
  out.p = lerp(a.p, b.p, t);
  out.r = lerp(a.r, b.r, t);
  out.e = lerp(a.e, b.e, t);
  return out;
}

export class Player {
  pos = new THREE.Vector3(0, 0, 0);
  vel = new THREE.Vector3();
  yaw = Math.PI * 0.75;
  pitch = 0;
  stats: Stats = baseStats();
  hp = 100;
  stamina = 100;
  private staminaDelay = 0;
  vials = 3;
  bolts = 16;
  alive = true;
  melee!: Weapon;
  ranged!: Weapon;
  active: 'melee' | 'ranged' = 'melee';
  noise = 0.3;
  kills = 0;
  distance = 0;
  // combat state
  private atk: AtkState | null = null;
  private combo = 0;
  private comboT = 0;
  private charge = -1;
  blocking = false;
  private blockT = 0;
  private dodgeT = 0;
  private dodgeDir = new THREE.Vector3();
  iframes = 0;
  private riposteT = 0;
  private hurtKick = 0;
  private staggerT = 0;
  private healT = 0;
  private healLeft = 0;
  private loaded = true;
  private reloadT = 0;
  private aim = 0;
  private recoil = 0;
  private swapT = 0;
  // camera feel
  private bobPhase = 0;
  private lastStep = 0;
  trauma = 0;
  private fovBase = 78;
  private landDip = 0;
  private dodgeRoll = 0;
  private swayX = 0;
  private swayY = 0;
  // view model
  vm = new THREE.Group();
  private pivot = new THREE.Object3D();
  private handGroup = new THREE.Group();
  private meleeModel: THREE.Group | null = null;
  private crossbow: CrossbowModel | null = null;
  private lantern: { group: THREE.Group; flame: THREE.Mesh };
  private lanternHolder = new THREE.Group();
  light: THREE.PointLight;
  private curPose: Pose = { ...IDLE };
  private armR!: Arm;
  private armL!: Arm;
  private gauntlet!: THREE.Group;
  private trail = new BladeTrail();
  private trailOn = 0;
  private swingYawV = 0;
  private swingPitchV = 0;
  private lastPose: Pose = { ...IDLE };
  private stepV = 0;
  private bladeTip = new THREE.Vector3();
  private bladeTipPrev = new THREE.Vector3();
  private flingT = 0;
  private extraMods: Mod[] = [];
  private metaMods: Mod[] = [];

  constructor(private host: PlayerHost, private mats: WeaponMats) {
    host.camera.add(this.vm);
    this.pivot.position.set(0.3, -0.42, 0.02);
    this.vm.add(this.pivot);
    this.pivot.add(this.handGroup);
    this.lantern = buildLantern(mats);
    this.lanternHolder.position.set(-0.36, -0.37, -0.52);
    this.lanternHolder.scale.setScalar(0.8);
    this.lanternHolder.add(this.lantern.group);
    this.vm.add(this.lanternHolder);
    this.light = new THREE.PointLight(new THREE.Color(1.0, 0.6, 0.3), 6.5, 20, 1.35);
    this.light.position.set(0, 0.0, 0);
    this.lantern.group.add(this.light);
    this.light.shadow.mapSize.set(512, 512);
    this.light.shadow.camera.near = 0.1;
    this.light.shadow.camera.far = 22;
    this.light.shadow.bias = -0.004;
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.075, 0.5, 8), mats.leather);
    shin.position.y = 0.25;
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.1, 0.3), mats.leather);
    sole.position.set(0, -0.02, -0.08);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 0.04), mats.darkSteel);
    plate.position.set(0, 0.25, -0.08);
    this.boot.add(shin, sole, plate);
    this.boot.visible = false;
    this.vm.add(this.boot);
    // arms: the sword hand on the right, the lantern hand on the left
    this.armR = buildArm(this.vm, mats, 1);
    this.armL = buildArm(this.vm, mats, -1);
    this.gauntlet = buildGauntlet(mats);
    this.handGroup.add(this.gauntlet);
  }

  setFov(f: number) {
    this.fovBase = f;
  }

  setMods(meta: Mod[], extra: Mod[]) {
    this.metaMods = meta;
    this.extraMods = extra;
    this.recompute();
  }

  recompute() {
    const prevMax = this.stats.maxHp;
    const all = [...this.metaMods, ...this.extraMods, ...(this.melee?.mods ?? []), ...(this.ranged?.mods ?? [])];
    this.stats = applyMods(baseStats(), all);
    if (this.stats.maxHp > prevMax) this.hp += this.stats.maxHp - prevMax;
    this.hp = Math.min(this.hp, this.stats.maxHp);
    this.vials = Math.min(this.vials, Math.round(this.stats.vials));
    this.bolts = Math.min(this.bolts, Math.round(this.stats.bolts));
    this.light.distance = 20 * this.stats.lanternRadius;
  }

  equip(w: Weapon) {
    if (w.kind === 'melee') {
      this.melee = w;
      if (this.meleeModel) this.handGroup.remove(this.meleeModel);
      this.meleeModel = buildMelee(w.archetype as MeleeArchetype, this.mats, w.rarity);
      this.handGroup.add(this.meleeModel);
    } else {
      this.ranged = w;
      if (this.crossbow) this.vm.remove(this.crossbow.group);
      this.crossbow = buildCrossbow(w.archetype as 'crossbow', this.mats);
      this.vm.add(this.crossbow.group);
    }
    this.recompute();
    this.showActive();
  }

  private showActive() {
    if (this.meleeModel) this.meleeModel.visible = this.active === 'melee';
    if (this.armR) {
      this.armR.upper.visible = this.armR.fore.visible = this.gauntlet.visible = this.active === 'melee';
    }
    if (this.crossbow) this.crossbow.group.visible = this.active === 'ranged';
  }

  reset(spawn: THREE.Vector3) {
    this.pos.copy(spawn);
    this.vel.set(0, 0, 0);
    this.alive = true;
    this.hp = this.stats.maxHp;
    this.stamina = this.stats.maxStamina;
    this.vials = Math.round(this.stats.vials);
    this.bolts = Math.round(this.stats.bolts);
    this.atk = null;
    this.charge = -1;
    this.kills = 0;
    this.distance = 0;
    this.loaded = true;
    this.trauma = 0;
    this.active = 'melee';
    this.showActive();
  }

  get eye(): THREE.Vector3 {
    return this.host.camera.position;
  }

  addTrauma(a: number) {
    this.trauma = Math.min(1, this.trauma + a);
  }

  // ────────────────────────────────────────────── damage

  receive(amount: number, from: THREE.Vector3, opts: { unblockable?: boolean; knock?: number } = {}): HitResult {
    if (!this.alive) return 'hit';
    if (this.iframes > 0) return 'dodged';
    _v.subVectors(from, this.pos);
    const toYaw = Math.atan2(-_v.x, -_v.z);
    const facing = Math.abs(angleDiff(this.yaw, toYaw)) < 1.3;
    if (this.blocking && facing && !opts.unblockable) {
      if (this.blockT < this.stats.parryWindow) {
        audio.play('parry');
        this.host.gore.sparks(_w.copy(this.eye).addScaledVector(this.forward(_q), 0.8), _q.negate(), 30);
        this.host.hitstop(0.13);
        this.addTrauma(0.25);
        this.riposteT = 1.5;
        this.stamina = Math.min(this.stats.maxStamina, this.stamina + 10);
        this.host.notify('PARRY');
        return 'parried';
      }
      const cost = (amount * 1.6) / this.stats.blockEff;
      this.stamina -= cost;
      this.staminaDelay = 0.9;
      audio.play('hitBlock');
      this.host.gore.sparks(_w.copy(this.eye).addScaledVector(this.forward(_q), 0.7).add(_v.set(0, -0.15, 0)), this.forward(_q).negate(), 14);
      this.addTrauma(0.2);
      if (this.stamina < 0) {
        // guard broken
        this.stamina = 0;
        this.blocking = false;
        this.staggerT = 0.6;
        this.applyDamage(amount * 0.5, from, opts.knock ?? 0);
        this.host.notify('GUARD BROKEN');
        return 'hit';
      }
      return 'blocked';
    }
    this.applyDamage(amount, from, opts.knock ?? 0);
    return 'hit';
  }

  private applyDamage(amount: number, from: THREE.Vector3, knock: number) {
    const dmg = amount * this.stats.damageTaken;
    this.hp -= dmg;
    this.hurtKick = 1;
    this.addTrauma(0.35 + dmg * 0.01);
    _v.subVectors(this.pos, from).setY(0).normalize();
    this.vel.addScaledVector(_v, knock);
    audio.play('hurt');
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.atk = null;
      this.blocking = false;
      audio.play('death');
      this.host.onPlayerDeath();
    }
  }

  heal(n: number) {
    if (!this.alive) return;
    this.hp = Math.min(this.stats.maxHp, this.hp + n);
  }

  forward(out: THREE.Vector3) {
    return out.set(0, 0, -1).applyQuaternion(this.host.camera.quaternion);
  }

  get riposteReady() {
    return this.riposteT > 0;
  }

  // ────────────────────────────────────────────── update

  update(dt: number, realDt: number) {
    const inp = this.host.input;
    const cam = this.host.camera;
    const s = this.stats;
    const world = this.host.world;

    // look (uses real dt so hitstop never freezes the mouse)
    if (this.alive && !this.executing) {
      const sens = 0.0022 * inp.sensitivity * (this.aim > 0.5 ? 0.6 : 1);
      this.yaw -= inp.mouseDX * sens;
      this.pitch -= inp.mouseDY * sens;
      this.pitch = clamp(this.pitch, -1.45, 1.45);
    }
    void realDt;

    // movement input
    let mx = 0, mz = 0;
    if (this.alive) {
      if (inp.isDown('KeyW')) mz -= 1;
      if (inp.isDown('KeyS')) mz += 1;
      if (inp.isDown('KeyA')) mx -= 1;
      if (inp.isDown('KeyD')) mx += 1;
    }
    if (this.executing) mx = mz = 0;
    const ml = Math.hypot(mx, mz);
    if (ml > 0) {
      mx /= ml;
      mz /= ml;
    }
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wishX = mx * cos + mz * sin;
    const wishZ = -mx * sin + mz * cos;
    const sprinting = this.alive && inp.isDown('ShiftLeft') && mz < 0 && this.stamina > 1 && !this.blocking && this.aim < 0.5 && !this.atk && this.healT <= 0;
    let speed = s.moveSpeed * (sprinting ? 1.6 : 1);
    if (this.blocking) speed *= 0.55;
    if (this.atk) speed *= this.atk.def.heavy ? 0.35 : 0.7;
    if (this.aim > 0.5) speed *= 0.6;
    if (this.healT > 0) speed *= 0.5;
    if (this.staggerT > 0) speed *= 0.2;
    if (sprinting) {
      this.stamina -= 13 * dt;
      this.staminaDelay = 0.4;
    }

    // dodge
    if (this.alive && !this.executing && inp.wasPressed('Space') && this.dodgeT <= 0 && this.stamina >= s.dodgeCost * 0.5 && this.staggerT <= 0) {
      this.stamina -= s.dodgeCost;
      this.staminaDelay = 0.8;
      if (ml > 0) this.dodgeDir.set(wishX, 0, wishZ);
      else this.dodgeDir.set(sin, 0, cos); // backwards
      this.dodgeT = 0.32;
      this.iframes = 0.3;
      this.dodgeRoll = mx !== 0 ? -mx * 0.08 : 0;
      this.atk = null;
      this.charge = -1;
      audio.play('dodge');
      this.host.fog.splat(this.pos.x, this.pos.z, this.dodgeDir.x * 6, this.dodgeDir.z * 6, 1.6, 0.4 * s.fogClear);
    }
    this.iframes -= dt;
    let vx: number, vz: number;
    if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      const k = 11.5 * Math.min(1, this.dodgeT / 0.32 + 0.3);
      vx = this.dodgeDir.x * k;
      vz = this.dodgeDir.z * k;
      this.vel.x = vx;
      this.vel.z = vz;
    } else {
      const accel = 12;
      this.vel.x = damp(this.vel.x, wishX * speed, accel, dt);
      // stepping into a strike
      if (this.stepV > 0.01) {
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        this.pos.x += fx * this.stepV * dt;
        this.pos.z += fz * this.stepV * dt;
      }
      this.vel.z = damp(this.vel.z, wishZ * speed, accel, dt);
    }
    const ox = this.pos.x, oz = this.pos.z;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    world.collide(this.pos, 0.35);
    for (const e of this.host.enemies) {
      if (!e.alive) continue;
      const dx = this.pos.x - e.pos.x, dz = this.pos.z - e.pos.z;
      const md = 0.7 * e.def.scale;
      const d2 = dx * dx + dz * dz;
      if (d2 < md * md && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        this.pos.x = e.pos.x + (dx / d) * md;
        this.pos.z = e.pos.z + (dz / d) * md;
      }
    }
    const gy = world.height(this.pos.x, this.pos.z);
    // simple grounded controller (no jumping in the fog)
    const fall = this.pos.y - gy;
    if (fall > 0.05) {
      this.vel.y -= 20 * dt;
      this.pos.y += this.vel.y * dt;
      if (this.pos.y <= gy) {
        this.landDip = Math.min(0.15, -this.vel.y * 0.02);
        this.pos.y = gy;
        this.vel.y = 0;
      }
    } else {
      this.pos.y = gy;
      this.vel.y = 0;
    }
    const moved = Math.hypot(this.pos.x - ox, this.pos.z - oz);
    this.distance = Math.max(this.distance, Math.hypot(this.pos.x, this.pos.z));
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.noise = damp(this.noise, sprinting ? 1 : hs > 0.5 ? 0.55 : 0.25, 3, dt);

    // fog reacts to the body pushing through it
    if (hs > 0.2) this.host.fog.splat(this.pos.x + this.vel.x * 0.15, this.pos.z + this.vel.z * 0.15, this.vel.x * 0.5, this.vel.z * 0.5, 1.1, 0.05 * hs * dt * 8 * s.fogClear);
    this.host.fog.splat(this.pos.x, this.pos.z, 0, 0, 1.4 * s.fogClear, 0.25 * dt * s.fogClear); // lantern heat

    // stamina
    this.staminaDelay -= dt;
    if (this.staminaDelay <= 0 && !this.blocking) this.stamina = Math.min(s.maxStamina, this.stamina + s.staminaRegen * dt);
    else if (this.blocking) this.stamina = Math.min(s.maxStamina, this.stamina + s.staminaRegen * 0.25 * dt);
    this.riposteT -= dt;
    this.staggerT -= dt;

    // vial
    if (this.alive && inp.wasPressed('KeyQ') && this.vials > 0 && this.healT <= 0 && this.hp < s.maxHp) {
      this.vials--;
      this.healT = 1.0;
      this.healLeft = s.vialHeal;
      this.host.notify('VIAL');
    }
    if (this.healT > 0) {
      const k = Math.min(this.healT, dt);
      this.heal(this.healLeft * (k / 1.0));
      this.healT -= dt;
    }

    // weapon swap
    if (this.alive && (inp.wasPressed('Digit1') || inp.wasPressed('Digit2') || inp.wasPressed('PadSwap') || inp.wheel !== 0)) {
      const want = inp.wasPressed('Digit1') ? 'melee' : inp.wasPressed('Digit2') ? 'ranged' : this.active === 'melee' ? 'ranged' : 'melee';
      if (want !== this.active && !this.atk) {
        this.active = want;
        this.swapT = 0.35;
        this.blocking = false;
        this.charge = -1;
        this.showActive();
      }
    }
    this.swapT = Math.max(0, this.swapT - dt);

    this.updateKick(dt);
    if (this.executing) this.updateExecution(dt);
    else if (this.active === 'melee') this.updateMelee(dt);
    else this.updateRanged(dt);

    // ── camera
    const bobAmt = this.dodgeT > 0 ? 0 : Math.min(1, hs / 4.5);
    this.bobPhase += moved * (sprinting ? 1.25 : 1.6);
    const bobY = Math.sin(this.bobPhase * 2) * 0.035 * bobAmt;
    const bobX = Math.cos(this.bobPhase) * 0.025 * bobAmt;
    const stepIdx = Math.floor(this.bobPhase / Math.PI);
    if (stepIdx !== this.lastStep && hs > 0.8) {
      this.lastStep = stepIdx;
      audio.play('step', { vol: sprinting ? 1.4 : 0.9 });
    }
    this.landDip = damp(this.landDip, 0, 8, dt);
    this.hurtKick = damp(this.hurtKick, 0, 6, dt);
    this.dodgeRoll = damp(this.dodgeRoll, 0, 6, dt);
    this.recoil = damp(this.recoil, 0, 9, dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const sh = this.trauma * this.trauma;
    const t = this.host.time;
    const shX = (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 71.3) * 0.4) * sh * 0.06;
    const shY = (Math.sin(t * 41.7 + 1) * 0.6 + Math.sin(t * 89.1) * 0.4) * sh * 0.06;
    const shR = Math.sin(t * 29.3 + 2) * sh * 0.05;
    const eyeH = 1.62 - (this.alive ? 0 : 1.3) - this.landDip - (this.healT > 0 ? 0.05 : 0);
    cam.position.set(this.pos.x + bobX * 0.3, this.pos.y + eyeH + bobY, this.pos.z);
    // the body follows the blade: yaw/roll lean into the swing, pitch dips on overheads
    const torqueY = clamp(this.swingYawV * 0.012, -0.06, 0.06);
    const torqueP = clamp(this.swingPitchV * 0.01, -0.05, 0.05);
    _e.set(this.pitch + shY + this.recoil * 0.06 + this.hurtKick * 0.04 + torqueP, this.yaw + shX + torqueY, shR + this.dodgeRoll + bobX * 0.15 + (this.alive ? 0 : 0.5) - torqueY * 0.8, 'YXZ');
    cam.quaternion.setFromEuler(_e);
    const fovTarget = this.fovBase + (sprinting ? 7 : 0) + (this.dodgeT > 0 ? 6 : 0) - this.aim * 25;
    cam.fov = damp(cam.fov, fovTarget, 8, dt);
    cam.updateProjectionMatrix();

    // view-model sway & bob
    this.swayX = damp(this.swayX, -inp.mouseDX * 0.0006, 10, dt);
    this.swayY = damp(this.swayY, inp.mouseDY * 0.0006, 10, dt);
    this.vm.position.set(this.swayX + bobX * 0.4, this.swayY + bobY * 0.5 - (this.swapT > 0 ? this.swapT * 0.6 : 0) - this.hurtKick * 0.03, 0);
    this.vm.rotation.set(this.swayY * 2, this.swayX * 2, 0);
    // lantern swings gently
    this.lantern.group.rotation.z = Math.sin(this.bobPhase) * 0.12 * bobAmt + this.swayX * 4;
    this.lantern.group.rotation.x = Math.cos(this.bobPhase * 2) * 0.06 * bobAmt;
    const flick = 0.85 + 0.1 * Math.sin(t * 17.3) + 0.06 * Math.sin(t * 31.7 + 2) + 0.04 * Math.sin(t * 7.1);
    this.light.intensity = 6.5 * flick * (this.alive ? 1 : 0.3);
    this.lantern.flame.scale.set(1, 1.8 * flick, 1);
  }

  private updateMelee(dt: number) {
    const inp = this.host.input;
    const w = this.melee.melee!;
    const s = this.stats;
    const spd = w.speed * s.attackSpeed;
    this.comboT -= dt;
    const canAct = this.alive && this.dodgeT <= 0 && this.staggerT <= 0 && this.swapT <= 0 && this.healT <= 0;

    // block
    const wantBlock = canAct && inp.isDown('Mouse2') && !this.atk;
    if (wantBlock && !this.blocking) this.blockT = 0;
    this.blocking = wantBlock && this.stamina > 0;
    if (this.blocking) this.blockT += dt;

    // attack input: tap = light combo, hold = charged heavy. A swing in its
    // follow-through can be cancelled straight into the next combo strike.
    const lateInSwing = this.atk && !this.atk.def.heavy && this.atk.t > this.atk.def.hit[1] + 0.06;
    if (canAct && (!this.atk || lateInSwing) && !this.blocking) {
      if (inp.wasPressed('Mouse0')) this.charge = 0;
      if (this.charge >= 0) {
        if (inp.isDown('Mouse0')) {
          this.charge += dt;
          this.staminaDelay = 0.3;
        }
        if (inp.wasReleased('Mouse0') || !inp.isDown('Mouse0') || this.charge > 0.9) {
          const heavy = this.charge > 0.28;
          const chain = this.comboT > 0 || !!this.atk;
          const name = heavy ? 'heavy' : COMBO[chain ? this.combo % COMBO.length : 0];
          const def = MOVES[name];
          const cost = w.stamina * def.stamina;
          if (this.stamina > 2) {
            this.stamina -= cost;
            this.staminaDelay = 0.7;
            const t0 = heavy ? def.keys[def.holdKey!].t : 0;
            this.atk = { def, name, t: t0, prevT: t0, start: { ...this.curPose }, hit: new Set(), bounced: false, bite: 0, connected: false };
            this.combo = chain ? this.combo + 1 : 1;
            if (heavy) this.combo = 0;
            this.atkCharge = Math.min(1, this.charge / 0.9);
            audio.play(heavy ? 'swingHeavy' : 'swing', { pitch: (1 / Math.sqrt(w.reach)) * (0.92 + Math.random() * 0.16) });
          }
          this.charge = -1;
        }
      }
    }

    let target: Pose = this.blocking ? BLOCK : IDLE;
    if (this.charge > 0.28 && !this.atk) {
      // wind up the heavy while holding: blade drawn back over the shoulder, trembling with strain
      const k = Math.min(1, (this.charge - 0.28) / 0.45);
      const held = evalMove(MOVES.heavy, MOVES.heavy.keys[MOVES.heavy.holdKey!].t * k, this.curPose, { ...IDLE });
      held.p += Math.sin(this.host.time * 37) * 0.006 * k;
      target = held;
    }
    this.stepV = damp(this.stepV, 0, 10, dt);
    if (this.atk) {
      const a = this.atk;
      const def = a.def;
      a.prevT = a.t;
      // while the blade bites into flesh the swing drags, then tears through
      const rate = a.bite > 0 ? 0.16 : 1;
      a.bite = Math.max(0, a.bite - dt);
      a.t += dt * spd * rate;
      const pose = evalMove(def, a.t, a.start, { ...IDLE });
      if (a.bounced) {
        // recoil off stone or earth: the arm jolts back
        pose.e -= 0.08;
        pose.p += 0.15;
      }
      if (a.t >= def.hit[0] && a.t <= def.hit[1] && !a.bounced) {
        this.stepV = Math.max(this.stepV, def.step * (a.connected ? 0.3 : 1));
        this.sweep(a, dt);
      }
      // flick blood off the blade in the follow-through
      if (a.connected && a.t > def.hit[1] && a.t < def.hit[1] + 0.15) this.flingT = 0.15;
      this.trailOn = a.t >= def.hit[0] - 0.03 && a.t <= def.hit[1] + 0.05 ? 1 : 0;
      target = pose;
      if (a.t >= moveLength(def) || (a.bounced && a.t > def.hit[1] + 0.12)) {
        this.atk = null;
        this.comboT = 0.5;
      }
      this.curPose = { ...target };
    } else {
      this.trailOn = 0;
      // springy follow when not attacking
      this.curPose.y = damp(this.curPose.y, target.y, 14, dt);
      this.curPose.p = damp(this.curPose.p, target.p, 14, dt);
      this.curPose.r = damp(this.curPose.r, target.r, 14, dt);
      this.curPose.e = damp(this.curPose.e, target.e, 14, dt);
      // idle breathing
      this.curPose.p += Math.sin(this.host.time * 1.6) * 0.0015;
    }
    // angular velocity of the swing drives the body torque on the camera
    const idt = 1 / Math.max(dt, 1e-3);
    this.swingYawV = damp(this.swingYawV, (this.curPose.y - this.lastPose.y) * idt, 18, dt);
    this.swingPitchV = damp(this.swingPitchV, (this.curPose.p - this.lastPose.p) * idt, 18, dt);
    this.lastPose = { ...this.curPose };
    this.applyPose(this.curPose);
    this.updateArmsAndTrail(dt);
  }

  /** Bite: called by the game when the blade connects, so the swing drags through flesh. */
  bite(amount: number) {
    if (this.atk) {
      this.atk.bite = Math.max(this.atk.bite, amount);
      this.atk.connected = true;
    }
  }

  private updateArmsAndTrail(dt: number) {
    // right arm: shoulder → wrist behind the grip
    this.vm.updateMatrixWorld(true);
    const wrist = _v.set(0, -0.012, 0.09).applyMatrix4(this.handGroup.matrix).applyMatrix4(this.pivot.matrix);
    poseArm(this.armR, wrist);
    // left arm holds the lantern ring
    const lw = _w.copy(this.lanternHolder.position).add(_p.set(0.02, 0.1, 0.02));
    poseArm(this.armL, lw);
    // trail and blade tip in world space
    const reach = this.melee.melee!.reach;
    const base = _p.set(0, 0, -(this.curPose.e + 0.1)).applyMatrix4(this.pivot.matrixWorld);
    this.bladeTipPrev.copy(this.bladeTip);
    this.bladeTip.set(0, 0, -(this.curPose.e + 0.1 + reach)).applyMatrix4(this.pivot.matrixWorld);
    if (!this.trail.mesh.parent && this.host.camera.parent) this.host.camera.parent.add(this.trail.mesh);
    if (this.trailOn && this.active === 'melee') this.trail.push(base, this.bladeTip);
    this.trail.update(dt, this.host.bloodiness?.() ?? 0);
    if (this.flingT > 0) {
      this.flingT -= dt;
      const v = _q.subVectors(this.bladeTip, this.bladeTipPrev).divideScalar(Math.max(dt, 1e-3));
      if (Math.random() < 0.6) this.host.gore.splash(this.bladeTip, v.normalize(), 0.12);
    }
  }

  private atkCharge = 0;
  executing: { t: number; target: THREE.Vector3; struck: boolean } | null = null;
  private kickT = 0;
  private kickCd = 0;
  private boot = new THREE.Group();

  /** Begin a finishing move on a guard-broken foe. */
  beginExecution(target: THREE.Vector3) {
    this.executing = { t: 0, target: target.clone(), struck: false };
    this.atk = null;
    this.charge = -1;
    this.blocking = false;
    this.iframes = 1.2;
    if (this.active !== 'melee') {
      this.active = 'melee';
      this.showActive();
    }
  }

  private updateExecution(dt: number) {
    const ex = this.executing!;
    ex.t += dt;
    const t = ex.t;
    // turn to face the victim
    const to = _v.subVectors(ex.target, this.host.camera.position);
    const wantYaw = Math.atan2(-to.x, -to.z);
    const wantPitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
    this.yaw += angleDiff(this.yaw, wantYaw) * Math.min(1, dt * 10);
    this.pitch = damp(this.pitch, wantPitch, 10, dt);
    const back: Pose = { y: 0.05, p: 0.25, r: Math.PI / 2, e: 0.12 };
    const thrust: Pose = { y: 0.0, p: 0.05, r: Math.PI / 2, e: 0.78 };
    let pose: Pose;
    if (t < 0.28) pose = lerpPose(this.curPose, back, THREE.MathUtils.smoothstep(t / 0.28, 0, 1), { ...IDLE });
    else if (t < 0.4) pose = lerpPose(back, thrust, easeStrike((t - 0.28) / 0.12), { ...IDLE });
    else if (t < 0.85) pose = { ...thrust, p: thrust.p + Math.sin((t - 0.4) * 30) * 0.01 };
    else pose = lerpPose(thrust, IDLE, THREE.MathUtils.smoothstep((t - 0.85) / 0.35, 0, 1), { ...IDLE });
    if (!ex.struck && t >= 0.36) {
      ex.struck = true;
      this.addTrauma(0.55);
      this.host.onExecuteStrike();
    }
    this.curPose = { ...pose };
    this.applyPose(pose);
    if (t > 1.2) this.executing = null;
  }

  private updateKick(dt: number) {
    const inp = this.host.input;
    this.kickCd -= dt;
    if (this.alive && !this.executing && inp.wasPressed('KeyF') && this.kickCd <= 0 && this.stamina > 5 && this.dodgeT <= 0) {
      this.kickCd = 0.75;
      this.kickT = 0.45;
      this.stamina -= 15;
      this.staminaDelay = 0.6;
      audio.play('swing', { pitch: 0.55, vol: 0.7 });
    }
    if (this.kickT > 0) {
      const prev = this.kickT;
      this.kickT -= dt;
      if (prev > 0.3 && this.kickT <= 0.3) {
        const dir = this.forward(new THREE.Vector3()).setY(0).normalize();
        this.host.onKick(this.pos.clone().addScaledVector(dir, 1.0).setY(this.pos.y + 0.8), dir);
        this.addTrauma(0.15);
      }
    }
    const k = this.kickT > 0 ? Math.sin(((0.45 - this.kickT) / 0.45) * Math.PI) : 0;
    this.boot.visible = k > 0.01;
    this.boot.position.set(0.05, -0.95 + k * 0.55, -0.35 - k * 0.45);
    this.boot.rotation.x = -0.6 + k * 0.9;
  }

  private applyPose(p: Pose) {
    this.pivot.rotation.set(p.p, p.y, p.r, 'YXZ');
    this.handGroup.position.set(0, 0, -p.e);
  }

  /** Blade sweep between the previous and current pose with sub-stepping along the swing curve. */
  private sweep(a: AtkState, dt: number) {
    const def = a.def;
    const w = this.melee.melee!;
    const reach = w.reach * 1.15;
    const steps = 6;
    const t0 = Math.max(a.prevT, def.hit[0]), t1 = Math.min(a.t, def.hit[1]);
    const tmpPose: Pose = { ...IDLE };
    const cam = this.host.camera;
    cam.updateMatrixWorld();
    const prevTip = new THREE.Vector3();
    const span = def.hit[1] - def.hit[0];
    for (let i = 0; i <= steps; i++) {
      const tt = t0 + ((t1 - t0) * i) / steps;
      const k = (tt - def.hit[0]) / span;
      evalMove(def, tt, a.start, tmpPose);
      this.applyPose(tmpPose);
      this.vm.updateMatrixWorld(true);
      const e = tmpPose.e + 0.08;
      // test from the forearm outward so foes pressed up against you still get hit
      _p.set(0, 0, -tmpPose.e * 0.35).applyMatrix4(this.pivot.matrixWorld);
      _q.set(0, 0, -(e + reach)).applyMatrix4(this.pivot.matrixWorld);
      if (i === 0) {
        prevTip.copy(_q);
        continue;
      }
      this.trail.push(_w.set(0, 0, -(e + 0.02)).applyMatrix4(this.pivot.matrixWorld), _q);
      // the blade can hit the ground or scenery and bounce off
      const gh = this.host.world.height(_q.x, _q.z);
      const hitProp = this.host.world.raycastProps(_p, _q) >= 0;
      if ((_q.y < gh - 0.05 || hitProp) && k > 0.12 && k < 0.88 && !def.heavy) {
        a.bounced = true;
        audio.play(hitProp ? 'boltWood' : 'hitBlock', { pitch: 0.6 });
        this.host.gore.sparks(_q, _w.set(0, 1, 0), hitProp ? 6 : 12);
        this.host.gore.dust(_q, 6);
        this.host.fog.burst(_q.x, _q.z, 4, 2);
        this.addTrauma(0.3);
        this.host.hitstop(0.05);
        return;
      }
      if (def.heavy && _q.y < gh - 0.02 && k > 0.5 && !a.bounced) {
        // a heavy blow drives into the earth: dust, fog blast, shake
        a.bounced = true;
        audio.play('swingHeavy', { pitch: 0.35, vol: 0.8 });
        this.host.gore.dust(_q, 20);
        this.host.fog.burst(_q.x, _q.z, 10, 4);
        this.addTrauma(0.45);
        this.host.hitstop(0.06);
      }
      for (const en of this.host.enemies) {
        if (!en.alive || a.hit.has(en.id)) continue;
        if (en.pos.distanceToSquared(this.pos) > 25) continue;
        const r = en.testSegment(_p, _q, 0.05);
        if (r) {
          a.hit.add(en.id);
          const dir = _w.subVectors(_q, prevTip);
          if (dir.lengthSq() < 1e-6) this.forward(dir);
          dir.normalize();
          const riposte = this.riposteT > 0;
          if (riposte) this.riposteT = 0;
          const heavyMult = def.heavy ? 1 + this.atkCharge * 0.5 : 1;
          this.host.onMeleeHit(en, r.seg, r.point, dir.clone(), { heavy: !!def.heavy, dmgMult: def.dmg * heavyMult, severMult: def.sever, riposte, t: r.t });
        }
      }
      // kick corpses and severed limbs around
      for (const c of this.host.corpses) {
        if (c.rag.pos.length === 0) continue;
        if (c.rag.pos[0].distanceToSquared(this.pos) > 16) continue;
        const dir = _w.subVectors(_q, prevTip).normalize();
        if (c.push(_q, dir, 3.5, 0.35)) this.host.gore.splash(_q, dir, 0.2);
      }
      // the swing stirs the fog
      const tvx = (_q.x - prevTip.x) / (dt / steps + 1e-4), tvz = (_q.z - prevTip.z) / (dt / steps + 1e-4);
      if (i === steps) this.host.fog.splat(_q.x, _q.z, tvx * 0.08, tvz * 0.08, 1.0, 0.12 * this.stats.fogClear);
      prevTip.copy(_q);
    }
  }

  private updateRanged(dt: number) {
    const inp = this.host.input;
    const cb = this.crossbow!;
    const w = this.ranged.ranged!;
    const s = this.stats;
    this.blocking = false;
    const canAct = this.alive && this.dodgeT <= 0 && this.staggerT <= 0 && this.swapT <= 0 && this.healT <= 0;
    this.aim = damp(this.aim, canAct && inp.isDown('Mouse2') ? 1 : 0, 12, dt);
    if (!this.loaded && this.reloadT <= 0 && this.bolts > 0 && canAct) {
      this.reloadT = w.reload / s.reloadSpeed;
    }
    if (inp.wasPressed('KeyR') && !this.loaded && this.bolts > 0 && this.reloadT <= 0) this.reloadT = w.reload / s.reloadSpeed;
    let reloadK = 0;
    if (this.reloadT > 0) {
      const total = w.reload / s.reloadSpeed;
      this.reloadT -= dt;
      reloadK = Math.sin(clamp(1 - this.reloadT / total, 0, 1) * Math.PI);
      cb.setDraw(clamp(1 - this.reloadT / total, 0, 1));
      if (this.reloadT <= 0) {
        this.loaded = true;
        cb.setDraw(1);
        audio.play('boltWood', { pitch: 1.6, vol: 0.5 });
      }
    }
    cb.bolt.visible = this.loaded;
    if (canAct && inp.wasPressed('Mouse0')) {
      if (this.loaded && this.bolts > 0) {
        this.loaded = false;
        this.bolts--;
        cb.setDraw(0);
        const cam = this.host.camera;
        const n = Math.max(1, Math.round(s.boltsPerShot));
        const spread = this.aim > 0.5 ? 0.004 : 0.018;
        for (let i = 0; i < n; i++) {
          const dir = this.forward(new THREE.Vector3());
          const off = n > 1 ? (i - (n - 1) / 2) * 0.035 : 0;
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
          dir.addScaledVector(right, off + (Math.random() - 0.5) * spread).addScaledVector(up, (Math.random() - 0.5) * spread).normalize();
          const origin = cam.position.clone().addScaledVector(dir, 0.3).addScaledVector(up, -0.05);
          const crit = Math.random() < s.critChance;
          this.host.projectiles.fire(origin, dir, w.velocity, w.damage * s.rangedDmg * (crit ? s.critMult : 1), crit, s.explosiveBolts > 0);
        }
        this.recoil = 1;
        this.addTrauma(0.12);
        audio.play('bowFire');
      } else if (this.bolts <= 0) {
        this.host.notify('NO BOLTS');
      }
    }
    // pose
    const g = cb.group;
    const ax = lerp(0.2, 0.0, this.aim), ay = lerp(-0.24, -0.135, this.aim), az = lerp(-0.42, -0.34, this.aim);
    g.position.set(ax, ay - reloadK * 0.18, az + this.recoil * 0.06);
    g.rotation.set(this.recoil * 0.25 - reloadK * 0.6, lerp(0.06, 0, this.aim), reloadK * 0.4);
  }
}
