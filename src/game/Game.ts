// Top-level orchestration: owns every system, runs the frame loop, the
// encounter director, loot, XP / boons and the meta-progression loop.

import * as THREE from 'three';
import { Input } from '../engine/Input';
import { audio } from '../engine/Audio';
import { assets } from '../engine/Assets';
import { RNG, clamp, damp } from '../engine/Random';
import { TextureGen, makeFogNoise3D } from '../render/TextureGen';
import { Pipeline, QUALITY_PRESETS, type FogLight } from '../render/Pipeline';
import { globalUniforms } from '../render/MaterialPatches';
import { World, type Chunk, type POI } from '../world/World';
import { FogSim } from '../world/FogSim';
import { Gore } from './Gore';
import { Enemy, Corpse, type EnemyKind } from './Enemy';
import { J } from './Body';
import { loadCreatureAssets } from './CreatureModel';
import { Player } from './Player';
import { Projectiles } from './Projectiles';
import { makeWeaponMats, type WeaponMats } from './WeaponModels';
import { createInteractable, createWeaponDrop, type Interactable, type LightSource } from './Interactables';
import { makeMelee, makeRanged, randomWeapon, rollBoons, BOONS, RARITIES, type Boon, type Weapon } from './Loot';
import { loadSave, writeSave, metaMods, type MetaSave } from './Progression';
import type { Mod } from './Stats';
import type { Ctx, HitResult } from './Ctx';
import { UI } from '../ui/UI';

type State = 'loading' | 'menu' | 'playing' | 'paused' | 'levelup' | 'dying' | 'dead';

const SKY_VERT = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; }`;
const SKY_FRAG = `
varying vec3 vDir;
uniform vec3 uMoon;
float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
void main(){
  vec3 d = normalize(vDir);
  float up = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(vec3(0.010,0.012,0.016), vec3(0.002,0.003,0.006), pow(up, 0.5));
  float m = dot(d, uMoon);
  col += vec3(0.75,0.82,1.0) * smoothstep(0.99955, 0.9997, m) * 3.0;
  col += vec3(0.25,0.3,0.4) * pow(max(m,0.0), 180.0) * 0.6;
  col += vec3(0.06,0.07,0.1) * pow(max(m,0.0), 12.0) * 0.25;
  vec3 sp = floor(d * 400.0);
  float st = step(0.9985, h(sp)) * up;
  col += vec3(st) * 0.08;
  gl_FragColor = vec4(col, 1.0);
}`;

interface Mote { mesh: THREE.Mesh; vel: THREE.Vector3; value: number; t: number; kind: 'echo' | 'xp' }
interface Bile { mesh: THREE.Mesh; vel: THREE.Vector3; dmg: number; life: number }

const HINTS: [number, string][] = [
  [2, 'Tap <b>LMB</b> to strike, hold it for a heavy blow. Aim at a limb to take it.'],
  [9, '<b>RMB</b> blocks. Block just as a blow lands to <b>parry</b>.'],
  [16, 'Break a foe\'s guard with parries, heavy blows and kicks (<b>F</b>), then <b>E</b> to execute.'],
  [24, 'Follow the ◆ on the compass. Kindle three beacons to call out the Warden.'],
  [32, '<b>2</b> draws the crossbow. Bolts to the head kill. <b>Q</b> drinks a vial.'],
];

export class Game implements Ctx {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  input: Input;
  ui: UI;
  tex!: TextureGen;
  pipeline!: Pipeline;
  world!: World;
  fog!: FogSim;
  gore!: Gore;
  player!: Player;
  projectiles!: Projectiles;
  wmats!: WeaponMats;
  moon!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private sky!: THREE.Mesh;
  private noise3D!: THREE.Data3DTexture;
  enemies: Enemy[] = [];
  corpses: Corpse[] = [];
  interactables = new Map<string, Interactable>();
  drops: Interactable[] = [];
  private usedPOIs = new Set<string>();
  private triggeredLairs = new Set<string>();
  private lights: LightSource[] = [];
  private flashes: LightSource[] = [];
  private pointPool: THREE.PointLight[] = [];
  private motes: Mote[] = [];
  private biles: Bile[] = [];
  private bileGeo = new THREE.SphereGeometry(0.11, 10, 8);
  private bileMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 6, 0.6) });
  private executionTarget: Enemy | null = null;
  beaconsLit = 0;
  readonly beaconsNeeded = 3;
  tier = 0;
  private boss: Enemy | null = null;
  private bossPending = -1;
  private surgeT = 0;
  private surgeMix = 0;
  private nextSurge = 200;
  private nearestBeacon: { x: number; z: number; id: string; d: number } | null = null;
  private moteGeo = new THREE.SphereGeometry(0.035, 6, 5);
  private moteMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 9, 14) });
  private xpMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 8, 3) });
  state: State = 'loading';
  save: MetaSave;
  seed = 1;
  time = 0;
  private runTime = 0;
  private hitstopT = 0;
  private spawnT = 4;
  private rng = new RNG(Date.now() >>> 0);
  difficulty = 0;
  private xp = 0;
  private level = 1;
  private pendingLevels = 0;
  private boons = new Map<string, number>();
  private boonMods: Mod[] = [];
  private runEchoes = 0;
  private dyingT = 0;
  private damageFx = 0;
  private bloodFx = 0;
  private bloodSeed = 0;
  private menuAngle = 0;
  private lookTarget: Interactable | null = null;
  private execCandidate: Enemy | null = null;
  private eyeLights: FogLight[] = [];
  private kills = 0;
  private severs = 0;
  private autostart = false;
  private last = performance.now();

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.05, 300);
    this.scene.add(this.camera);
    this.input = new Input(canvas);
    this.ui = new UI(uiRoot);
    this.save = loadSave();
    this.ui.bindSave(this.save);
    const params = new URLSearchParams(location.search);
    this.autostart = params.has('autostart');
    if (params.has('seed')) this.seed = parseInt(params.get('seed')!) || 1;
    else this.seed = (Math.random() * 1e6) | 0;
    (window as unknown as { game: Game }).game = this;
  }

  // ─────────────────────────────────────────────────────── Ctx

  get playerPos() {
    return this.player.pos;
  }
  get playerEye() {
    return this.camera.position;
  }
  get playerNoise() {
    return this.player.noise * this.player.stats.detection;
  }
  get playerAlive() {
    return this.player.alive && this.state !== 'menu';
  }
  hitstop(s: number) {
    this.hitstopT = Math.max(this.hitstopT, s);
  }
  shake(a: number) {
    this.player.addTrauma(a);
  }
  damagePlayer(amount: number, from: THREE.Vector3, opts?: { unblockable?: boolean; knock?: number }): HitResult {
    if (this.state !== 'playing') return 'dodged';
    const r = this.player.receive(amount, from, opts);
    if (r === 'hit') {
      const to = from.clone().sub(this.player.pos);
      const ang = Math.atan2(-to.x, -to.z);
      let rel = ang - this.player.yaw;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      this.ui.hurtFrom(rel);
      this.damageFx = 1;
      this.bloodFx = Math.min(1, this.bloodFx + 0.25 + amount * 0.01);
      this.bloodSeed = Math.random() * 100;
      this.gore.splash(this.camera.position.clone().add(new THREE.Vector3(0, -0.3, 0)), new THREE.Vector3(0, -1, 0), 0.3);
      if (this.player.stats.thorns > 0) {
        for (const e of this.enemies) if (e.alive && e.pos.distanceTo(this.player.pos) < 3) e.damage(this.player.stats.thorns, e.joints[J.Chest], new THREE.Vector3(0, 1, 0), 'thorns');
      }
    } else if (r === 'parried') {
      this.flash(this.camera.position.clone().add(this.player.forward(new THREE.Vector3()).multiplyScalar(0.8)), new THREE.Color(1, 0.8, 0.5), 6, 6, 0.2);
    }
    return r;
  }
  pan(p: THREE.Vector3) {
    const d = p.distanceTo(this.camera.position);
    const local = p.clone().applyMatrix4(this.camera.matrixWorldInverse);
    return { dist: d, pan: clamp(local.x / Math.max(1, Math.abs(local.z) + Math.abs(local.x)), -1, 1) };
  }
  spawnBile(from: THREE.Vector3, vel: THREE.Vector3, damage: number) {
    const mesh = new THREE.Mesh(this.bileGeo, this.bileMat);
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.biles.push({ mesh, vel, dmg: damage, life: 5 });
    const sp = this.pan(from);
    audio.play('enemyAttack', { dist: sp.dist, pan: sp.pan, pitch: 1.7 });
  }

  summon(at: THREE.Vector3, n: number) {
    this.ui.notify('THE FOG ANSWERS', 1.4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random();
      const p = at.clone().add(new THREE.Vector3(Math.cos(a) * 9, 0, Math.sin(a) * 9));
      this.spawnEnemy(Math.random() < 0.3 ? 'stalker' : 'hollow', p).alert();
    }
    this.fog.burst(at.x, at.z, 14, 14);
  }

  private updateBiles(dt: number) {
    for (let i = this.biles.length - 1; i >= 0; i--) {
      const b = this.biles[i];
      b.life -= dt;
      b.vel.y -= 9.81 * 0.6 * dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      const p = b.mesh.position;
      if (Math.random() < 0.6) this.gore.embers(p, 1, [1.5, 4, 0.4], 0.05);
      const toEye = p.distanceTo(this.camera.position.clone().add(new THREE.Vector3(0, -0.35, 0)));
      const ground = this.world.height(p.x, p.z);
      let burst = false;
      if (toEye < 0.6 && this.player.alive) {
        const r = this.damagePlayer(b.dmg, p.clone().sub(b.vel.clone().normalize()));
        if (r === 'hit') {
          this.bloodFx = Math.min(1, this.bloodFx + 0.2);
          this.bloodSeed = Math.random() * 100;
        }
        burst = true;
      } else if (p.y < ground || b.life <= 0) {
        burst = true;
        if (Math.hypot(p.x - this.player.pos.x, p.z - this.player.pos.z) < 1.8) this.damagePlayer(b.dmg * 0.5, p, { unblockable: true });
      }
      if (burst) {
        this.gore.embers(p, 25, [1.5, 4.5, 0.4], 0.8);
        this.gore.dust(p, 6);
        this.fog.burst(p.x, p.z, 4, 2.5);
        const sp = this.pan(p);
        audio.play('hitFlesh', { dist: sp.dist, pan: sp.pan, pitch: 1.6, vol: 0.6 });
        this.scene.remove(b.mesh);
        this.biles.splice(i, 1);
      }
    }
  }

  private onKick(origin: THREE.Vector3, dir: THREE.Vector3) {
    let hit = false;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.joints[J.Pelvis].distanceTo(origin) < 1.3 * e.def.scale) {
        e.kicked(dir, 1);
        hit = true;
      }
    }
    for (const c of this.corpses) if (c.push(origin, dir.clone().add(new THREE.Vector3(0, 0.4, 0)), 9, 1.2)) hit = true;
    this.fog.splat(origin.x, origin.z, dir.x * 7, dir.z * 7, 1.4, 0.3);
    if (hit) {
      audio.play('boltHit', { pitch: 0.55 });
      this.hitstop(0.05);
      this.shake(0.2);
    }
  }

  private onExecuteStrike() {
    const e = this.executionTarget;
    this.executionTarget = null;
    if (!e || !e.alive) return;
    const head = e.joints[J.Head].clone();
    const dir = new THREE.Vector3().subVectors(head, this.camera.position).normalize();
    audio.play('sever', { pitch: 0.85 });
    audio.play('hitFlesh', { pitch: 0.7 });
    this.hitstop(0.16);
    this.bloodFx = Math.min(1, this.bloodFx + 0.55);
    this.bloodSeed = Math.random() * 100;
    this.gore.splash(head, dir.clone().add(new THREE.Vector3(0, 0.6, 0)).normalize(), 2.5);
    this.wmats.bloodU.value = Math.min(1, this.wmats.bloodU.value + 0.25);
    const s = this.player.stats;
    if (e.def.boss) {
      e.damage(e.maxHp * 0.2 * s.meleeDmg, head, dir, 'execute');
      e.posture = 0;
      e.brokenT = 0.01;
      this.ui.notify('BRUTALISED', 1);
    } else {
      e.hit({ seg: 1, point: head, dir, damage: 1e4, sever: 50, blunt: false, stagger: 1, crit: true, source: 'melee' });
      this.severs++;
      this.ui.notify('EXECUTED', 1.1);
    }
    this.player.heal(s.maxHp * 0.12);
    for (let i = 0; i < 3; i++) this.spawnMote(head, 'echo', 2);
  }

  onPieceCreated(p: Corpse) {
    this.corpses.push(p);
    // cap remains so the world doesn't drown in bodies
    if (this.corpses.length > 46) {
      const old = this.corpses.shift()!;
      old.dispose(this.scene);
    }
  }
  onEnemyKilled(eu: unknown, how: { severed: boolean; head: boolean; crit: boolean }) {
    const e = eu as Enemy;
    const s = this.player.stats;
    this.kills++;
    this.player.kills++;
    this.wmats.bloodU.value = Math.min(1, this.wmats.bloodU.value + 0.06);
    this.player.heal(s.healOnKill);
    const chest = e.joints[J.Chest].clone();
    const echoes = Math.round(e.def.echoes * (e.elite ? 3 : 1) * (1 + this.difficulty * 0.3));
    const nm = Math.min(5, echoes);
    for (let i = 0; i < nm; i++) this.spawnMote(chest, 'echo', Math.ceil(echoes / nm));
    this.gainXp(e.def.xp * (e.elite ? 2.5 : 1) * s.xpGain);
    if (e.def.boss) this.onBossDefeated(e);
    const label = how.head ? 'BEHEADED' : how.severed ? 'DISMEMBERED' : how.crit ? 'BRUTALISED' : '';
    if (label) this.ui.feed(`${e.def.name} — ${label.toLowerCase()}`, '#c9b98c');
    // drops
    const r = this.rng;
    if (e.elite || (e.def.kind === 'brute' && r.chance(0.35)) || r.chance(0.035 + s.luck * 0.02)) {
      this.dropWeapon(randomWeapon(r, e.elite ? 2 : e.def.kind === 'brute' ? 1 : 0, s.luck), e.pos.clone());
    }
    if (r.chance(0.12)) this.spawnSupply(e.pos.clone());
  }

  private onBossDefeated(e: Enemy) {
    this.boss = null;
    this.tier++;
    this.beaconsLit = 0;
    this.ui.bossBar(null);
    this.ui.notify('THE WARDEN IS ASHES', 3);
    this.ui.feed(`Tier ${this.tier + 1}: the fog grows hungrier.`, '#d4776b');
    audio.play('levelUp');
    audio.play('death');
    this.player.heal(this.player.stats.maxHp);
    this.player.vials = Math.round(this.player.stats.vials);
    const r = this.rng;
    for (let i = 0; i < 2; i++) this.dropWeapon(randomWeapon(r, 3 + this.tier, this.player.stats.luck + 1), e.pos.clone().add(new THREE.Vector3(r.range(-2, 2), 0, r.range(-2, 2))));
    this.flash(e.pos.clone().add(new THREE.Vector3(0, 2, 0)), new THREE.Color(0.6, 0.75, 1), 60, 25, 2);
    this.fog.burst(e.pos.x, e.pos.z, 25, 30);
    this.pendingLevels++;
  }

  private startSurge(dur: number) {
    if (this.surgeT > 0) return;
    this.surgeT = dur;
    this.ui.notify('THE FOG THICKENS', 2.2);
    audio.play('enemyScream', { pitch: 0.5, vol: 0.8 });
    this.spawnT = 1;
  }

  private spawnBoss() {
    const p = this.player.pos;
    const a = this.player.yaw + (Math.random() - 0.5) * 1.2;
    const at = new THREE.Vector3(p.x - Math.sin(a) * 24, 0, p.z - Math.cos(a) * 24);
    this.boss = this.spawnEnemy('warden', at);
    this.boss.alert();
    this.ui.notify('THE DROWNED WARDEN RISES', 3);
    audio.play('death');
    this.fog.burst(at.x, at.z, 20, 20);
    this.flash(at.clone().add(new THREE.Vector3(0, 3, 0)), new THREE.Color(0.5, 0.7, 1), 40, 20, 1.5);
  }

  // ─────────────────────────────────────────────────────── boot

  async init() {
    const r = this.renderer;
    this.tex = new TextureGen(r, Math.min(8, r.capabilities.getMaxAnisotropy()));
    this.noise3D = makeFogNoise3D(64);
    await assets.load();
    await loadCreatureAssets(['hollow', 'stalker', 'weeper', 'brute', 'warden']);
    this.fog = new FogSim((x, z) => (this.world ? this.world.height(x, z) : 0));
    this.pipeline = new Pipeline(r, this.noise3D, this.fog);
    this.applySettings();

    // lighting
    this.moon = new THREE.DirectionalLight(new THREE.Color(0.55, 0.64, 0.85), 0.75);
    this.moon.castShadow = true;
    const sc = this.moon.shadow.camera;
    sc.left = -48; sc.right = 48; sc.top = 48; sc.bottom = -48; sc.near = 1; sc.far = 220;
    this.moon.shadow.bias = -0.0006;
    this.moon.shadow.normalBias = 0.04;
    this.scene.add(this.moon, this.moon.target);
    this.hemi = new THREE.HemisphereLight(new THREE.Color(0.25, 0.3, 0.42), new THREE.Color(0.08, 0.07, 0.06), 0.22);
    this.scene.add(this.hemi);
    for (let i = 0; i < 4; i++) {
      const pl = new THREE.PointLight(0xffffff, 0, 10, 1.8);
      this.pointPool.push(pl);
      this.scene.add(pl);
    }
    const moonDir = new THREE.Vector3(-0.45, 0.42, -0.79).normalize();
    this.moon.userData.dir = moonDir;
    this.pipeline.fogMat.uniforms.uMoonCol.value.setRGB(0.07, 0.085, 0.12);
    this.pipeline.fogMat.uniforms.uAmbient.value.setRGB(0.0055, 0.0068, 0.0095);

    // sky + environment for reflections
    const skyMat = new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: { uMoon: { value: moonDir } }, side: THREE.BackSide, depthWrite: false });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(240, 32, 16), skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMat.clone()));
    const pm = new THREE.PMREMGenerator(r);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 0.65, 0.8) }));
    glow.position.copy(moonDir).multiplyScalar(8);
    envScene.add(glow);
    const warm = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.2, 0.08) }));
    warm.position.set(3, -2, 6);
    envScene.add(warm);
    this.scene.environment = pm.fromScene(envScene, 0.02).texture;
    this.scene.environmentIntensity = 0.35;

    this.wmats = makeWeaponMats(this.tex);
    this.buildWorld(this.seed);
    this.gore = new Gore(this.world, this.tex.material('gore', 512, { metalness: 0 }));
    this.scene.add(this.gore.group);
    this.projectiles = new Projectiles(
      {
        world: this.world,
        enemies: this.enemies,
        corpses: this.corpses,
        scene: this.scene,
        onBoltHit: (e, seg, point, dir, damage, crit, t, from) => this.onBoltHit(e, seg, point, dir, damage, crit, t, from),
        onBoltImpact: (p, d, ex, surf) => this.onBoltImpact(p, d, ex, surf),
        pan: (p) => this.pan(p),
      },
      this.wmats,
    );
    const game = this;
    this.player = new Player(
      {
        input: this.input,
        camera: this.camera,
        get world() { return game.world; },
        get gore() { return game.gore; },
        fog: this.fog,
        enemies: this.enemies,
        corpses: this.corpses,
        projectiles: this.projectiles,
        get time() { return game.time; },
        hitstop: (t) => this.hitstop(t),
        onMeleeHit: (e, seg, p, d, mv) => this.onMeleeHit(e, seg, p, d, mv),
        onPlayerDeath: () => this.onPlayerDeath(),
        onKick: (o, d) => this.onKick(o, d),
        onExecuteStrike: () => this.onExecuteStrike(),
        notify: (m) => this.ui.notify(m),
        bloodiness: () => game.wmats.bloodU.value,
      },
      this.wmats,
    );
    this.player.setFov(this.save.settings.fov);
    this.newLoadout();

    this.ui.onStart = () => this.startRun();
    this.ui.onResume = () => this.resume();
    this.ui.onQuit = () => this.onPlayerDeath(true);
    this.ui.onSettings = () => {
      this.applySettings();
      writeSave(this.save);
    };
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.state === 'playing' && !this.autostart) this.pause();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.state === 'paused') this.resume();
      else if (e.code === 'Escape' && this.state === 'playing') this.pause();
      if (this.state === 'levelup' && /^Digit[1-3]$/.test(e.code)) {
        const el = document.querySelectorAll<HTMLElement>('#l-choices .choice')[+e.code.slice(5) - 1];
        el?.click();
      }
    });
    this.resize();
    // warm up shaders + world around the vigil
    this.world.preload(0, 0);
    this.fog.recenter(0, 0);
    this.renderer.compile(this.scene, this.camera);
    this.ui.loaded();
    this.state = 'menu';
    this.ui.show('main');
    this.ui.fade(true);
    if (this.autostart) this.startRun();
    if (!new URLSearchParams(location.search).has('noloop')) this.loop();
  }

  private buildWorld(seed: number) {
    if (this.world) {
      this.scene.remove(this.world.group);
      for (const it of this.interactables.values()) this.scene.remove(it.obj);
      this.interactables.clear();
    }
    this.world = new World(seed, this.tex);
    this.world.onChunkLoad = (c) => this.onChunkLoad(c);
    this.world.onChunkUnload = (c) => this.onChunkUnload(c);
    this.scene.add(this.world.group);
    if (this.gore) this.gore.world = this.world;
    if (this.projectiles) this.projectiles.host.world = this.world;
  }

  private applySettings() {
    const s = this.save.settings;
    this.input.sensitivity = s.sensitivity;
    audio.setVolume(s.volume);
    if (this.gore) this.gore.intensity = s.gore;
    this.player?.setFov(s.fov);
    const forced = new URLSearchParams(location.search).get('q');
    const q = QUALITY_PRESETS[forced ?? s.quality] ?? QUALITY_PRESETS.high;
    this.pipeline.setQuality(q);
    if (this.moon) {
      this.moon.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      this.moon.shadow.map?.dispose();
      this.moon.shadow.map = null;
    }
    if (this.player) this.player.light.castShadow = s.quality === 'ultra';
  }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pipeline.resize(w, h);
  }

  private newLoadout() {
    const r = new RNG(this.seed);
    const sword = makeMelee('longsword', RARITIES[0], r);
    const bow = makeRanged('crossbow', RARITIES[0], r);
    this.player.equip(bow);
    this.player.equip(sword);
  }

  // ─────────────────────────────────────────────────────── run lifecycle

  private samplesRequested = false;

  startRun() {
    audio.init();
    if (!this.samplesRequested && audio.ctx) {
      // authored sound effects listed in public/assets/manifest.json override the synthesized cues
      this.samplesRequested = true;
      for (const [cue, file] of Object.entries(assets.manifest.audio ?? {})) void audio.loadSample(cue as Parameters<typeof audio.play>[0], './assets/' + file);
    }
    if (this.save.runs > 0 || this.state === 'dead') {
      this.seed = (Math.random() * 1e6) | 0;
      this.clearRun();
      this.buildWorld(this.seed);
      this.world.preload(0, 0);
    } else this.clearRun();
    this.save.runs++;
    writeSave(this.save);
    this.runTime = 0;
    this.difficulty = 0;
    this.xp = 0;
    this.level = 1;
    this.pendingLevels = 0;
    this.boons.clear();
    this.boonMods = [];
    this.runEchoes = 0;
    this.kills = 0;
    this.severs = 0;
    this.wmats.bloodU.value = 0;
    this.newLoadout();
    this.player.setMods(metaMods(this.save), this.boonMods);
    this.player.reset(new THREE.Vector3(0, this.world.height(0, 0), 0));
    this.player.yaw = Math.atan2(-4, -4) + Math.PI;
    this.player.pitch = -0.05;
    this.spawnT = 6;
    this.state = 'playing';
    this.ui.show(null);
    this.ui.fade(false);
    setTimeout(() => this.ui.fade(true), 50);
    if (!this.autostart) this.input.lock();
    this.ui.feed('The vigil fire gutters behind you.', '#8a8273');
  }

  private clearRun() {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    for (const c of this.corpses) c.dispose(this.scene);
    this.corpses.length = 0;
    for (const d of this.drops) this.scene.remove(d.obj);
    this.drops.length = 0;
    for (const m of this.motes) this.scene.remove(m.mesh);
    this.motes.length = 0;
    this.projectiles?.clear();
    this.usedPOIs.clear();
    this.triggeredLairs.clear();
    this.flashes.length = 0;
    for (const b of this.biles) this.scene.remove(b.mesh);
    this.biles.length = 0;
    this.boss = null;
    this.bossPending = -1;
    this.beaconsLit = 0;
    this.tier = 0;
    this.surgeT = 0;
    this.surgeMix = 0;
    this.nextSurge = 200;
    this.nearestBeacon = null;
    this.executionTarget = null;
    this.ui?.bossBar(null);
    this.ui?.enemyBars([]);
    this.bloodFx = 0;
    this.damageFx = 0;
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.unlock();
    this.ui.show('pause');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.ui.show(null);
    if (!this.autostart) this.input.lock();
    this.last = performance.now();
  }

  private onPlayerDeath(abandon = false) {
    if (this.state === 'dying' || this.state === 'dead') return;
    if (abandon && this.player.alive) this.player.alive = false;
    this.state = 'dying';
    this.dyingT = abandon ? 0.3 : 3;
    this.input.unlock();
  }

  private finishDeath() {
    const s = this.player.stats;
    const dist = Math.round(this.player.distance);
    const fromDist = Math.floor(dist / 20);
    const fromKills = this.kills * 2;
    const total = Math.round((this.runEchoes + fromDist + fromKills) * s.echoGain);
    this.save.echoes += total;
    this.save.bestDistance = Math.max(this.save.bestDistance, dist);
    this.save.totalKills += this.kills;
    this.save.bestKills = Math.max(this.save.bestKills, this.kills);
    writeSave(this.save);
    const mins = Math.floor(this.runTime / 60), secs = Math.floor(this.runTime % 60);
    this.ui.death([
      ['Survived', `${mins}:${String(secs).padStart(2, '0')}`],
      ['Depth reached', `${dist} m`],
      ['Creatures slain', String(this.kills)],
      ['Limbs severed', String(this.severs)],
      ['Level', String(this.level)],
      ['Tier reached', String(this.tier + 1)],
      ['Echoes gathered', String(this.runEchoes)],
      ['Echoes from depth & slaughter', String(fromDist + fromKills)],
      ['Echoes remembered', `<b style="color:var(--gold)">+${total}</b>`],
    ]);
    this.state = 'dead';
    audio.setBoss(false);
  }

  // ─────────────────────────────────────────────────────── progression

  private xpNext() {
    return Math.round(40 + 28 * Math.pow(this.level, 1.35));
  }

  private gainXp(n: number) {
    this.xp += n;
    while (this.xp >= this.xpNext()) {
      this.xp -= this.xpNext();
      this.level++;
      this.pendingLevels++;
    }
  }

  private offerBoons(title = 'THE FOG OFFERS', forbidden = false) {
    const choices = forbidden ? rollBoons(this.rng, this.boons, 3).map((b) => (b.rarity < 2 ? BOONS.filter((x) => x.rarity === 2 && (this.boons.get(x.id) ?? 0) < x.max)[0] ?? b : b)) : rollBoons(this.rng, this.boons, 3);
    const uniq = [...new Map(choices.map((c) => [c.id, c])).values()];
    if (!uniq.length) return;
    this.state = 'levelup';
    this.input.unlock();
    audio.play('levelUp');
    this.ui.levelUp(uniq, title, (b) => this.pickBoon(b));
  }

  private pickBoon(b: Boon) {
    this.boons.set(b.id, (this.boons.get(b.id) ?? 0) + 1);
    this.boonMods.push(...b.mods);
    this.player.setMods(metaMods(this.save), this.boonMods);
    if (b.id === 'quiver') this.player.bolts = Math.round(this.player.stats.bolts);
    if (b.id === 'vial') this.player.vials++;
    this.ui.feed(`${b.name}`, '#c8a45a');
    this.state = 'playing';
    this.ui.show(null);
    if (!this.autostart) this.input.lock();
    this.last = performance.now();
  }

  // ─────────────────────────────────────────────────────── combat callbacks

  private onMeleeHit(e: Enemy, seg: number, point: THREE.Vector3, dir: THREE.Vector3, mv: { heavy: boolean; dmgMult: number; severMult: number; riposte: boolean; t: number }) {
    const w = this.player.melee.melee!;
    const s = this.player.stats;
    const crit = Math.random() < s.critChance + (mv.riposte ? 0.5 : 0);
    let dmg = w.damage * s.meleeDmg * mv.dmgMult * (crit ? s.critMult : 1) * (mv.riposte ? s.riposteMult : 1);
    if (s.executeBelow > 0 && e.hp / e.maxHp < s.executeBelow) dmg = 1e5;
    const res = e.hit({ seg, point, dir, damage: dmg, sever: w.sever * s.severMult * mv.severMult, blunt: w.blunt, stagger: w.stagger * (mv.heavy ? 2 : 1), crit, source: 'melee', riposte: mv.riposte, t: mv.t, from: this.camera.position.clone() });
    if (res.severed) this.severs++;
    // the blade drags through flesh; harder when it cleaves bone
    this.player.bite(w.blunt ? 0.05 : res.severed ? 0.11 : 0.075 + (mv.heavy ? 0.04 : 0));
    this.player.heal(dmg * s.lifesteal);
    if (!w.blunt && Math.random() < s.bleedChance) {
      e.bleed = 4;
      e.bleedT = 0.3;
    }
    const near = point.distanceTo(this.camera.position);
    this.hitstop(0.035 + (mv.heavy ? 0.05 : 0) + (res.severed ? 0.04 : 0) + (crit ? 0.02 : 0));
    this.shake(0.18 + (mv.heavy ? 0.2 : 0) + (res.severed ? 0.12 : 0));
    const sp = this.pan(point);
    audio.play('hitFlesh', { dist: sp.dist, pan: sp.pan, pitch: w.blunt ? 0.7 : 1 });
    this.ui.hitMarker();
    if (near < 2.4) {
      this.bloodFx = Math.min(1, this.bloodFx + (res.severed ? 0.35 : 0.08));
      this.bloodSeed = Math.random() * 100;
    }
    if (res.headshot && res.severed) this.ui.notify('BEHEADED');
    else if (res.severed) this.ui.notify('SEVERED', 0.6);
    else if (mv.riposte) this.ui.notify('RIPOSTE', 0.6);
    else if (crit) this.ui.notify('CRITICAL', 0.5);
    this.wmats.bloodU.value = Math.min(1, this.wmats.bloodU.value + 0.02);
  }

  private onBoltHit(e: Enemy, seg: number, point: THREE.Vector3, dir: THREE.Vector3, damage: number, crit: boolean, t: number, from: THREE.Vector3) {
    const res = e.hit({ seg, point, dir, damage, sever: 0.6 * this.player.stats.severMult, blunt: false, stagger: 1.4, crit, source: 'bolt', t, from });
    if (res.severed) this.severs++;
    this.player.heal(damage * this.player.stats.lifesteal);
    this.ui.hitMarker();
    if (res.headshot) this.ui.notify(res.killed ? 'HEADSHOT' : 'SKULL PIERCED', 0.7);
    this.hitstop(0.03);
  }

  private onBoltImpact(p: THREE.Vector3, d: THREE.Vector3, explosive: boolean, surf: 'ground' | 'prop' | 'flesh') {
    if (surf === 'ground') this.gore.dust(p, 6);
    if (surf === 'prop') this.gore.sparks(p, d.clone().negate(), 6);
    if (!explosive) return;
    this.gore.embers(p, 50, [20, 7, 1.5], 1.2);
    this.gore.sparks(p, new THREE.Vector3(0, 1, 0), 30);
    this.fog.burst(p.x, p.z, 10, 5);
    this.flash(p.clone().add(new THREE.Vector3(0, 0.5, 0)), new THREE.Color(1, 0.5, 0.15), 40, 12, 0.5);
    this.shake(Math.max(0, 0.5 - p.distanceTo(this.player.pos) * 0.05));
    const sp = this.pan(p);
    audio.play('swingHeavy', { dist: sp.dist, pan: sp.pan, pitch: 0.4 });
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dd = e.pos.distanceTo(p);
      if (dd < 3.4) {
        e.burning = 3;
        e.damage(38 * this.player.stats.rangedDmg * (1 - dd / 4), p, new THREE.Vector3().subVectors(e.pos, p).normalize(), 'fire');
      }
    }
  }

  flash(pos: THREE.Vector3, color: THREE.Color, intensity: number, radius: number, life: number) {
    this.flashes.push({ pos, color, intensity, radius, flicker: 0, life, maxLife: life, real: true });
  }

  // ─────────────────────────────────────────────────────── world population

  private onChunkLoad(c: Chunk) {
    for (const poi of c.pois) {
      if (poi.kind === 'lair') continue;
      const it = createInteractable(poi, this.tex, this.usedPOIs.has(poi.id));
      if (!it) continue;
      this.interactables.set(poi.id, it);
      this.scene.add(it.obj);
    }
  }

  private onChunkUnload(c: Chunk) {
    for (const poi of c.pois) {
      const it = this.interactables.get(poi.id);
      if (it) {
        this.scene.remove(it.obj);
        this.interactables.delete(poi.id);
      }
    }
  }

  private dropWeapon(w: Weapon, at: THREE.Vector3) {
    at.y = this.world.height(at.x, at.z);
    const it = createWeaponDrop(w, at, this.wmats);
    this.drops.push(it);
    this.scene.add(it.obj);
    this.ui.feed(`<span style="color:${w.rarity.color}">${w.name}</span> lies in the mud`, '#8a8273');
  }

  private spawnSupply(at: THREE.Vector3) {
    // vials and bolts appear as glowing motes that fly to you
    for (let i = 0; i < 3; i++) this.spawnMote(at.clone().add(new THREE.Vector3(0, 1, 0)), 'xp', 1);
  }

  private spawnMote(at: THREE.Vector3, kind: 'echo' | 'xp', value: number) {
    const mesh = new THREE.Mesh(this.moteGeo, kind === 'echo' ? this.moteMat : this.xpMat);
    mesh.position.copy(at);
    this.scene.add(mesh);
    this.motes.push({ mesh, vel: new THREE.Vector3((Math.random() - 0.5) * 3, 2 + Math.random() * 2, (Math.random() - 0.5) * 3), value, t: 0, kind });
  }

  private openChest(it: Interactable) {
    it.used = true;
    this.usedPOIs.add(it.id);
    it.light = undefined;
    audio.play('loot');
    const r = this.rng;
    const s = this.player.stats;
    const spot = it.pos.clone().add(new THREE.Vector3(0, 0.8, 0));
    const n = it.tier >= 2 ? 6 : 3;
    for (let i = 0; i < n; i++) this.spawnMote(spot, 'echo', Math.round(2 + this.difficulty * 2));
    if (r.chance(it.tier >= 2 ? 0.9 : 0.55)) {
      const fwd = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), it.obj.rotation.y);
      this.dropWeapon(randomWeapon(r, it.tier + this.difficulty * 0.5, s.luck), it.pos.clone().addScaledVector(fwd, 1.1));
    }
    if (r.chance(0.6)) {
      this.player.bolts = Math.min(Math.round(s.bolts), this.player.bolts + 6);
      this.ui.feed('+6 bolts', '#8a8273');
    }
    if (r.chance(0.35)) {
      this.player.vials = Math.min(Math.round(s.vials), this.player.vials + 1);
      this.ui.feed('+1 vial', '#8a8273');
    }
    this.gore.embers(spot, 30, [10, 8, 4], 0.6);
  }

  private interact(it: Interactable) {
    const s = this.player.stats;
    switch (it.kind) {
      case 'chest':
        if (!it.used) this.openChest(it);
        break;
      case 'shrine':
        if (it.used || it.tier === 0) {
          if (it.tier === 0) this.ui.notify('THE VIGIL ENDURES', 1.5);
          return;
        }
        it.used = true;
        this.usedPOIs.add(it.id);
        audio.play('shrine');
        this.player.heal(s.maxHp * 0.6);
        this.player.vials = Math.round(s.vials);
        this.ui.feed('The flame mends you. Vials refilled.', '#c8a45a');
        this.gore.embers(it.pos.clone().add(new THREE.Vector3(0, 2, 0)), 60, [12, 6, 2], 0.5);
        if (it.light) it.light.intensity = 0;
        (it.obj.getObjectByName('flame') as THREE.Object3D).visible = false;
        if (it.tier >= 2) setTimeout(() => this.offerBoons('THE STONES REMEMBER'), 400);
        break;
      case 'altar':
        if (it.used) return;
        it.used = true;
        this.usedPOIs.add(it.id);
        this.player.hp = Math.max(1, this.player.hp - s.maxHp * 0.25);
        this.damageFx = 1;
        this.bloodFx = 0.6;
        audio.play('hurt');
        audio.play('shrine');
        this.gore.splash(it.pos.clone().add(new THREE.Vector3(0, 0.9, 0)), new THREE.Vector3(0, 1, 0), 1.5);
        setTimeout(() => this.offerBoons('BLOOD BUYS FORBIDDEN THINGS', true), 500);
        break;
      case 'beacon': {
        if (it.used) return;
        it.used = true;
        this.usedPOIs.add(it.id);
        (it.obj.getObjectByName('flame') as THREE.Object3D).visible = true;
        if (it.light) it.light.intensity = 60;
        this.beaconsLit++;
        audio.play('shrine');
        audio.play('swingHeavy', { pitch: 0.3 });
        const top = it.pos.clone().add(new THREE.Vector3(0, 7.7, 0));
        this.gore.embers(top, 120, [16, 6, 1.5], 1.5);
        this.flash(top, new THREE.Color(1, 0.55, 0.2), 80, 40, 1.2);
        this.fog.burst(it.pos.x, it.pos.z, 18, 22);
        this.gainXp(40);
        this.player.heal(this.player.stats.maxHp * 0.35);
        this.ui.notify(`BEACON KINDLED  ${this.beaconsLit} / ${this.beaconsNeeded}`, 2.5);
        this.startSurge(26 + this.tier * 4);
        if (this.beaconsLit >= this.beaconsNeeded && !this.boss) this.bossPending = 30;
        break;
      }
      case 'weapon': {
        const w = it.weapon!;
        const old = w.kind === 'melee' ? this.player.melee : this.player.ranged;
        this.player.equip(w);
        this.player.active = w.kind;
        this.player.equip(w); // refresh visibility
        this.scene.remove(it.obj);
        this.drops.splice(this.drops.indexOf(it), 1);
        audio.play('loot');
        this.ui.feed(`Equipped <span style="color:${w.rarity.color}">${w.name}</span>`);
        if (old) this.dropWeapon(old, this.player.pos.clone().add(new THREE.Vector3(Math.sin(this.player.yaw) * 0.6, 0, Math.cos(this.player.yaw) * 0.6)));
        break;
      }
    }
  }

  // ─────────────────────────────────────────────────────── director

  private spawnEnemy(kind: EnemyKind, at: THREE.Vector3, opts: { lurk?: boolean; elite?: boolean } = {}) {
    const e = new Enemy(kind, this, at, opts);
    this.enemies.push(e);
    return e;
  }

  private director(dt: number) {
    const p = this.player.pos;
    this.difficulty = this.runTime / 300 + this.player.distance / 650 + this.tier * 0.7;
    const alive = this.enemies.filter((e) => e.alive).length;
    const surging = this.surgeT > 0;
    const maxAlive = Math.min(surging ? 22 : 16, Math.round(3 + this.difficulty * 3.2) + (surging ? 7 : 0));
    this.spawnT -= dt;
    // fog surges: periodic, and every time a beacon is kindled
    this.nextSurge -= dt;
    if (this.nextSurge <= 0) {
      this.nextSurge = 170 + Math.random() * 110;
      if (!this.boss) this.startSurge(24);
    }
    if (this.surgeT > 0) this.surgeT -= dt;
    if (this.bossPending > 0) {
      this.bossPending -= dt;
      if (this.bossPending <= 0 && this.surgeT <= 0) {
        this.bossPending = -1;
        this.spawnBoss();
      } else if (this.bossPending <= 0) this.bossPending = 1;
    }
    if (this.spawnT <= 0 && alive < maxAlive && !this.boss) {
      this.spawnT = Math.max(3.5, 11 - this.difficulty * 2.5) * (0.7 + Math.random() * 0.6) * (surging ? 0.3 : 1);
      // emerge from the fog: behind or beside the player, just past visibility
      const ang = this.player.yaw + Math.PI + (Math.random() - 0.5) * 2.6;
      const dist = 26 + Math.random() * 12;
      const c = new THREE.Vector3(p.x - Math.sin(ang) * dist, 0, p.z - Math.cos(ang) * dist);
      const r = this.rng;
      const group = 1 + (r.chance(0.3 + this.difficulty * 0.1) ? 1 : 0) + (r.chance(this.difficulty * 0.15) ? 1 : 0);
      for (let i = 0; i < group; i++) {
        const kind = r.weighted<EnemyKind>([
          { item: 'hollow', w: 10 },
          { item: 'stalker', w: 2 + this.difficulty * 4 },
          { item: 'brute', w: this.difficulty > 0.4 ? 0.8 + this.difficulty * 1.5 : 0 },
          { item: 'weeper', w: this.difficulty > 0.25 ? 1 + this.difficulty * 1.6 : 0 },
        ]);
        const at = c.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4));
        const e = this.spawnEnemy(kind, at, { elite: r.chance(0.02 + this.difficulty * 0.03) });
        if (surging || r.chance(0.5)) e.alert();
      }
    }
    // lairs: dormant groups that wake when you get close
    for (const poi of this.world.allPOIs()) {
      if (poi.kind !== 'lair' || this.triggeredLairs.has(poi.id)) continue;
      const d = Math.hypot(poi.x - p.x, poi.z - p.z);
      if (d < 38) {
        this.triggeredLairs.add(poi.id);
        this.spawnLair(poi);
      }
    }
    // despawn stragglers far away
    for (const e of this.enemies) {
      if (e.alive && e.pos.distanceTo(p) > 95 && !e.def.boss) e.dispose();
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) if (this.enemies[i].removed || !this.enemies[i].alive) this.enemies.splice(i, 1);
  }

  private spawnLair(poi: POI) {
    const r = new RNG(poi.id.length * 7919 + Math.floor(poi.x * 13 + poi.z * 7));
    const n = r.int(2, 3 + Math.floor(this.difficulty * 2));
    for (let i = 0; i < n; i++) {
      const at = new THREE.Vector3(poi.x + r.range(-5, 5), 0, poi.z + r.range(-5, 5));
      const kind: EnemyKind = poi.tier >= 2 && i === 0 && this.difficulty > 0.25 ? 'brute' : r.chance(0.25) ? 'stalker' : 'hollow';
      this.spawnEnemy(kind, at, { lurk: true, elite: i === 0 && r.chance(0.08 + this.difficulty * 0.05) });
    }
  }

  // ─────────────────────────────────────────────────────── per-frame

  private loop = () => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const realDt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.frame(realDt);
    if (this.state === 'playing' && this.save.settings.dynamicRes !== false) this.pipeline.adapt(realDt);
  };

  /** Advance one frame (exposed so automated tests can step deterministically). */
  frame(realDt: number, render = true) {
    this.skipRender = !render;
    this.input.pollGamepad(realDt);
    if (this.input.wasPressed('PadStart')) {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
      else if (this.state === 'menu' || this.state === 'dead') this.startRun();
    }
    if (this.state === 'levelup') {
      const pick = this.input.wasPressed('PadLeft') ? 0 : this.input.wasPressed('PadUp') ? 1 : this.input.wasPressed('PadRight') ? 2 : -1;
      if (pick >= 0) document.querySelectorAll<HTMLElement>('#l-choices .choice')[pick]?.click();
    }
    let dt = realDt;
    const ex = this.player?.executing;
    if (ex && ex.t > 0.2 && ex.t < 0.75) dt *= 0.45;
    if (this.hitstopT > 0) {
      this.hitstopT -= realDt;
      dt *= 0.04;
    }
    const running = this.state === 'playing' || this.state === 'dying';
    if (running) {
      this.time += dt;
      this.runTime += dt;
    } else this.time += realDt * 0.5;
    globalUniforms.uTime.value = this.time;

    if (this.state === 'menu' || this.state === 'loading') this.updateMenuCamera(realDt);
    if (running) this.updatePlaying(dt, realDt);
    if (this.state === 'dying') {
      this.dyingT -= realDt;
      if (this.dyingT <= 0) this.finishDeath();
    }
    if (this.state === 'playing' && this.pendingLevels > 0 && this.state === 'playing') {
      this.pendingLevels--;
      this.offerBoons();
    }
    this.updateWorldAndRender(running ? dt : realDt * 0.5, realDt);
    this.input.endFrame();
  }

  private updateMenuCamera(dt: number) {
    this.menuAngle += dt * 0.04;
    const r = 9;
    const cx = 4 + Math.cos(this.menuAngle) * r, cz = 4 + Math.sin(this.menuAngle) * r;
    this.camera.position.set(cx, this.world.height(cx, cz) + 1.7, cz);
    this.camera.lookAt(4, this.world.height(4, 4) + 1.6, 4);
    this.camera.fov = 60;
    this.camera.updateProjectionMatrix();
    this.player.vm.visible = false;
    // stir fog for life
    this.fog.splat(4 + Math.cos(this.time * 0.3) * 6, 4 + Math.sin(this.time * 0.4) * 6, Math.cos(this.time) * 2, Math.sin(this.time) * 2, 3, 0.01);
  }

  private updatePlaying(dt: number, realDt: number) {
    const pl = this.player;
    pl.vm.visible = pl.alive;
    pl.update(dt, realDt);
    this.director(dt);
    for (const e of this.enemies) e.update(dt);
    // keep enemies apart
    for (let i = 0; i < this.enemies.length; i++)
      for (let j = i + 1; j < this.enemies.length; j++) {
        const a = this.enemies[i], b = this.enemies[j];
        if (!a.alive || !b.alive) continue;
        const dx = a.pos.x - b.pos.x, dz = a.pos.z - b.pos.z;
        const md = 0.55 * (a.def.scale + b.def.scale);
        const d2 = dx * dx + dz * dz;
        if (d2 < md * md && d2 > 1e-6) {
          const d = Math.sqrt(d2), push = (md - d) * 0.5;
          a.pos.x += (dx / d) * push; a.pos.z += (dz / d) * push;
          b.pos.x -= (dx / d) * push; b.pos.z -= (dz / d) * push;
        }
      }
    for (const c of this.corpses) {
      c.update(dt, this);
      if (c.owner && !c.pooled && c.rag.sleeping && c.rag.pos[0]) {
        c.pooled = true;
        this.gore.pool(c.rag.pos[0].x, c.rag.pos[0].z, 1.3 + Math.random() * 0.8);
      }
    }
    // fade very old remains far away
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      if (c.age > 90 || (c.rag.pos[0] && c.rag.pos[0].distanceTo(pl.pos) > 110)) {
        c.dispose(this.scene);
        this.corpses.splice(i, 1);
      }
    }
    this.projectiles.update(dt);
    this.updateBiles(dt);

    // motes home in on the lantern
    const target = this.camera.position.clone().add(new THREE.Vector3(0, -0.5, 0));
    for (let i = this.motes.length - 1; i >= 0; i--) {
      const m = this.motes[i];
      m.t += dt;
      if (m.t > 0.6) {
        const to = target.clone().sub(m.mesh.position);
        const d = to.length();
        m.vel.addScaledVector(to.normalize(), dt * (14 + m.t * 20));
        m.vel.multiplyScalar(Math.exp(-2.5 * dt));
        if (d < 0.6) {
          if (m.kind === 'echo') this.runEchoes += m.value;
          else {
            const s = pl.stats;
            if (Math.random() < 0.5) pl.bolts = Math.min(Math.round(s.bolts), pl.bolts + 2);
            else pl.heal(6);
          }
          this.scene.remove(m.mesh);
          this.motes.splice(i, 1);
          if (Math.random() < 0.3) audio.play('loot', { vol: 0.3 });
          continue;
        }
      } else {
        m.vel.y -= 4 * dt;
        m.vel.multiplyScalar(Math.exp(-1.5 * dt));
      }
      m.mesh.position.addScaledVector(m.vel, dt);
      if (Math.random() < 0.2) this.gore.embers(m.mesh.position, 1, m.kind === 'echo' ? [2, 3.5, 6] : [6, 3.5, 1.5], 0.02);
    }

    // interaction
    this.lookTarget = null;
    if (pl.alive) {
      const fwd = pl.forward(new THREE.Vector3());
      let best = 1e9;
      const consider = (it: Interactable) => {
        if (it.kind === 'lantern' || (it.used && it.kind !== 'shrine')) return;
        const to = it.pos.clone().add(new THREE.Vector3(0, it.kind === 'shrine' ? 1.2 : 0.5, 0)).sub(this.camera.position);
        const d = to.length();
        if (d > 3.2) return;
        const dot = to.normalize().dot(fwd);
        if (dot < 0.75) return;
        const score = d * (2 - dot);
        if (score < best) {
          best = score;
          this.lookTarget = it;
        }
      };
      for (const it of this.interactables.values()) consider(it);
      for (const it of this.drops) consider(it);
      // guard-broken foes can be executed
      let exec: Enemy | null = null;
      if (!pl.executing) {
        let bestE = 1e9;
        for (const e of this.enemies) {
          if (!e.canBeExecuted) continue;
          const to = e.joints[J.Chest].clone().sub(this.camera.position);
          const d = to.length();
          if (d > 2.4 + e.def.scale * 0.6) continue;
          const dot = to.normalize().dot(fwd);
          if (dot < 0.55) continue;
          if (d < bestE) {
            bestE = d;
            exec = e;
          }
        }
      }
      if (exec) {
        this.lookTarget = null;
        if (this.input.wasPressed('KeyE')) {
          this.executionTarget = exec;
          exec.brokenT = Math.max(exec.brokenT, 1.5);
          pl.beginExecution(exec.joints[J.Head]);
        }
      } else if (this.lookTarget && this.input.wasPressed('KeyE')) this.interact(this.lookTarget);
      this.execCandidate = exec;
    }
    const lt = this.lookTarget as Interactable | null;
    const label = lt?.label() ?? '';
    this.ui.prompt(this.execCandidate ? `<kbd>E</kbd><span style="color:#ffe1a0">Execute</span>` : lt && label ? `<kbd>E</kbd>${label}` : null);
    if (lt && lt.kind === 'weapon') this.ui.lootCard(lt.weapon!, lt.weapon!.kind === 'melee' ? pl.melee : pl.ranged);
    else this.ui.lootCard(null, null);

    // screen fx
    this.damageFx = damp(this.damageFx, 0, 3, realDt);
    this.bloodFx = Math.max(0, this.bloodFx - realDt * 0.12);
    this.wmats.bloodU.value = Math.max(0, this.wmats.bloodU.value - realDt * 0.002);
    const f = this.pipeline.finalMat.uniforms;
    f.uDamage.value = this.damageFx;
    f.uHealth.value = pl.hp / pl.stats.maxHp;
    f.uBlood.value = this.bloodFx * this.save.settings.gore;
    f.uBloodSeed.value = this.bloodSeed;
    f.uFade.value = this.state === 'dying' ? Math.max(0, this.dyingT / 3) : 1;

    // audio
    const near = this.enemies.reduce((m, e) => (e.alive && e.state !== 'lurk' ? Math.min(m, e.pos.distanceTo(pl.pos)) : m), 99);
    audio.update(realDt, this.time, Math.max(clamp(1 - near / 18, 0, 1), this.surgeT > 0 ? 0.6 : 0), pl.hp / pl.stats.maxHp);
    audio.setBoss(!!(this.boss && this.boss.alive));

    // HUD
    const w = pl.active === 'melee' ? pl.melee : pl.ranged;
    this.ui.hud({
      hp: pl.hp, maxHp: pl.stats.maxHp, st: pl.stamina, maxSt: pl.stats.maxStamina, xp: this.xp, xpNext: this.xpNext(), level: this.level,
      vials: pl.vials, bolts: pl.bolts, maxBolts: Math.round(pl.stats.bolts), weapon: w, active: pl.active,
      echoes: this.runEchoes, distance: pl.distance, kills: this.kills, yaw: pl.yaw, time: this.time,
      beacon: this.beaconHud(), beaconsLit: this.beaconsLit, beaconsNeeded: this.beaconsNeeded, tier: this.tier, surge: this.surgeT > 0,
    });
    this.updateBars();
    if (this.save.runs <= 2) {
      const h = HINTS.filter(([t]) => this.runTime > t && this.runTime < t + 6.5).pop();
      this.ui.hint(h ? h[1] : null);
    } else this.ui.hint(null);
    // fog surge thickens the mist
    this.surgeMix = damp(this.surgeMix, this.surgeT > 0 ? 1 : 0, 0.8, realDt);
    this.pipeline.fogMat.uniforms.uDensity.value = 0.085 * (1 + this.surgeMix * 0.75 + this.tier * 0.08);
    this.ui.tick(realDt);
  }

  private beaconHud() {
    if (this.boss || this.beaconsLit >= this.beaconsNeeded) {
      this.nearestBeacon = null;
      return null;
    }
    // finding beacons is cheap (pure hashing), refresh twice a second
    if (!this.nearestBeacon || Math.floor(this.time * 2) !== Math.floor((this.time - 1 / 60) * 2)) {
      const p = this.player.pos;
      this.nearestBeacon = this.world.beaconsNear(p.x, p.z, 520).find((b) => !this.usedPOIs.has(b.id)) ?? null;
    }
    const b = this.nearestBeacon;
    if (!b) return null;
    const p = this.player.pos;
    const ang = Math.atan2(-(b.x - p.x), -(b.z - p.z));
    let rel = ang - this.player.yaw;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    return { rel, dist: Math.hypot(b.x - p.x, b.z - p.z) };
  }

  private updateBars() {
    const bars: { x: number; y: number; hp: number; posture: number; broken: boolean; elite: boolean }[] = [];
    const w = window.innerWidth, h = window.innerHeight;
    const v = new THREE.Vector3();
    for (const e of this.enemies) {
      if (!e.alive || e.def.boss) continue;
      const recent = this.time - e.lastHitTime < 6 || e.posture > 0 || e.elite;
      if (!recent) continue;
      v.copy(e.joints[J.Head]).add(new THREE.Vector3(0, 0.35 * e.def.scale, 0));
      if (v.distanceTo(this.camera.position) > 22) continue;
      v.project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      bars.push({ x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, hp: Math.max(0, e.hp / e.maxHp), posture: e.posture / e.def.posture, broken: e.state === 'broken', elite: e.elite });
    }
    this.ui.enemyBars(bars);
    if (this.boss && this.boss.alive) this.ui.bossBar(this.boss.def.name.toUpperCase(), this.boss.hp / this.boss.maxHp, this.boss.posture / this.boss.def.posture);
    else this.ui.bossBar(null);
  }

  private updateWorldAndRender(dt: number, realDt: number) {
    const focus = this.state === 'menu' ? new THREE.Vector3(4, 0, 4) : this.player.pos;
    this.world.update(focus.x, focus.z, 2);
    this.fog.groundRef = this.world.height(focus.x, focus.z);
    this.fog.recenter(focus.x, focus.z);
    this.fog.step(dt, Math.sin(this.time * 0.05) * 0.6 + 0.5, 0.3);
    this.gore.update(dt);

    // interactable animation
    for (const it of [...this.interactables.values(), ...this.drops]) {
      it.anim += realDt;
      if (it.kind === 'chest' && it.used) {
        const lid = it.obj.getObjectByName('lid');
        if (lid) lid.rotation.x = damp(lid.rotation.x, -1.9, 6, realDt);
      }
      if (it.kind === 'weapon') {
        const m = it.obj.getObjectByName('model');
        if (m) {
          m.rotation.z = it.anim * 0.8;
          m.position.y = 0.6 + Math.sin(it.anim * 1.7) * 0.05;
        }
      }
      if (it.kind === 'shrine' && (!it.used || it.tier === 0) && Math.random() < realDt * 12) this.gore.embers(it.pos.clone().add(new THREE.Vector3(0, 2.05, 0)), 1, it.tier >= 2 ? [4, 7, 18] : [16, 6, 1.5], 0.3);
    }

    // lights: gather sources, assign nearest to real point lights, all to fog
    this.lights.length = 0;
    for (const it of this.interactables.values()) if (it.light && it.light.intensity > 0) this.lights.push(it.light);
    for (const d of this.drops) if (d.light) this.lights.push(d.light);
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const fl = this.flashes[i];
      fl.life! -= realDt;
      if (fl.life! <= 0) this.flashes.splice(i, 1);
      else this.lights.push(fl);
    }
    const cam = this.camera.position;
    this.lights.sort((a, b) => a.pos.distanceToSquared(cam) - b.pos.distanceToSquared(cam));
    let k = 0;
    for (const L of this.lights) {
      if (k >= this.pointPool.length) break;
      if (!L.real) continue;
      const pl = this.pointPool[k++];
      const fl = L.life !== undefined ? L.life / L.maxLife! : 1;
      pl.position.copy(L.pos);
      pl.color.copy(L.color);
      pl.intensity = L.intensity * fl * (1 - L.flicker * 0.5 + L.flicker * 0.5 * Math.sin(this.time * 13 + L.pos.x));
      pl.distance = L.radius * 1.6;
    }
    for (; k < this.pointPool.length; k++) this.pointPool[k].intensity = 0;

    const fogLights: FogLight[] = [];
    const lantern = this.player.light;
    if (this.state !== 'menu') {
      const lp = new THREE.Vector3();
      lantern.getWorldPosition(lp);
      fogLights.push({ pos: lp, color: lantern.color, intensity: lantern.intensity * 0.05, radius: 16 * this.player.stats.lanternRadius });
    }
    for (const L of this.lights) {
      if (fogLights.length >= 6) break;
      const fl = L.life !== undefined ? L.life / L.maxLife! : 1;
      fogLights.push({ pos: L.pos, color: L.color, intensity: L.intensity * 0.12 * fl, radius: L.radius * 1.3 });
    }
    // creature eyes glow faintly in the mist
    this.eyeLights.length = 0;
    const eyes = this.enemies.filter((e) => e.alive && e.segAlive[1]).sort((a, b) => a.pos.distanceToSquared(cam) - b.pos.distanceToSquared(cam));
    for (const e of eyes) {
      if (fogLights.length >= 8) break;
      const c = e.def.look.eye;
      const max = Math.max(c.r, c.g, c.b);
      fogLights.push({ pos: e.joints[J.Head].clone().add(new THREE.Vector3(Math.sin(e.yaw) * 0.25, 0, Math.cos(e.yaw) * 0.25)), color: new THREE.Color(c.r / max, c.g / max, c.b / max), intensity: e.state === 'attack' ? 0.25 : 0.1, radius: 3 });
    }
    this.pipeline.fogLights = fogLights;
    this.gore.setLight(fogLights[0]?.pos ?? cam, lantern.color, this.state === 'menu' ? 0 : lantern.intensity * 0.5);
    this.gore.setScale(window.innerHeight * this.pipeline.quality.renderScale, this.camera.fov);

    // moon shadow follows the player (texel-snapped to avoid shimmering)
    const md = this.moon.userData.dir as THREE.Vector3;
    const snap = 96 / this.moon.shadow.mapSize.x;
    const fx = Math.round(focus.x / snap) * snap, fz = Math.round(focus.z / snap) * snap;
    const fy = this.world.height(focus.x, focus.z);
    this.moon.target.position.set(fx, fy, fz);
    this.moon.position.set(fx + md.x * 100, fy + md.y * 100, fz + md.z * 100);
    this.sky.position.copy(cam);

    if (!this.skipRender) this.pipeline.render(this.scene, this.camera, this.fog, this.moon, this.time);
  }
  private skipRender = false;
}
