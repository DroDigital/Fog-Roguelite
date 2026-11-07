// Visceral effects: blood particles (droplets, mist, arterial spray), sparks,
// embers, ground decals and flesh gibs. All pooled; zero allocation per frame.

import * as THREE from 'three';
import type { World } from '../world/World';

const MAX_P = 6000;

const PART_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
uniform vec3 uLightPos;
uniform vec3 uLightCol;
uniform vec3 uAmbient;
uniform float uScale;
uniform float uLit;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / max(-mv.z, 0.05);
  vAlpha = aAlpha;
  vec3 d = uLightPos - position;
  float l = 1.0 / (1.0 + dot(d, d) * 0.6);
  vColor = mix(aColor, aColor * (uAmbient + uLightCol * l), uLit);
}`;
const PART_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
uniform float uSoft;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float a = mix(step(r, 1.0) * (1.0 - r * r * 0.3), exp(-r * r * 3.0), uSoft);
  if (a * vAlpha < 0.01) discard;
  // fake glossy highlight on droplets
  float spec = (1.0 - uSoft) * smoothstep(0.3, 0.0, length(c - vec2(-0.15, -0.15))) * 0.6;
  gl_FragColor = vec4(vColor * (1.0 + spec * 3.0), a * vAlpha);
}`;

enum PT { Droplet, Mist, Spark, Ember, Dust, Spurt }

class ParticleSet {
  pos = new Float32Array(MAX_P * 3);
  vel = new Float32Array(MAX_P * 3);
  life = new Float32Array(MAX_P);
  maxLife = new Float32Array(MAX_P);
  size = new Float32Array(MAX_P);
  alpha = new Float32Array(MAX_P);
  color = new Float32Array(MAX_P * 3);
  type = new Uint8Array(MAX_P);
  baseSize = new Float32Array(MAX_P);
  drag = new Float32Array(MAX_P);
  grav = new Float32Array(MAX_P);
  next = 0;
  geo = new THREE.BufferGeometry();
  points: THREE.Points;
  mat: THREE.ShaderMaterial;

  constructor(additive: boolean, soft: number, lit: number) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PART_VERT,
      fragmentShader: PART_FRAG,
      uniforms: {
        uLightPos: { value: new THREE.Vector3() },
        uLightCol: { value: new THREE.Vector3(3, 2, 1) },
        uAmbient: { value: new THREE.Vector3(0.05, 0.05, 0.06) },
        uScale: { value: 600 },
        uSoft: { value: soft },
        uLit: { value: lit },
      },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  spawn(type: PT, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number, drag = 0.5, grav = 1) {
    const i = this.next;
    this.next = (this.next + 1) % MAX_P;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
    this.size[i] = size;
    this.alpha[i] = 1;
    this.color[i * 3] = r; this.color[i * 3 + 1] = g; this.color[i * 3 + 2] = b;
    this.type[i] = type;
    this.drag[i] = drag;
    this.grav[i] = grav;
  }
}

interface Emitter { parent: THREE.Object3D; local: THREE.Vector3; dir: THREE.Vector3; t: number; dur: number; rate: number; acc: number; power: number }
interface Gib { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; life: number; resting: boolean }

function makeSplatTexture(seed: number): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  g.fillStyle = 'rgba(0,0,0,0)';
  g.fillRect(0, 0, S, S);
  const blob = (x: number, y: number, r: number, a: number) => {
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(70,2,4,${a})`);
    grd.addColorStop(0.7, `rgba(55,0,2,${a * 0.95})`);
    grd.addColorStop(1, 'rgba(40,0,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  blob(S / 2, S / 2, S * 0.22, 1);
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * S * 0.38;
    blob(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, S * (0.02 + rnd() * 0.08) * (1 - d / (S * 0.5)), 0.95);
  }
  // streaks
  for (let i = 0; i < 6; i++) {
    const a = rnd() * Math.PI * 2;
    g.strokeStyle = 'rgba(60,0,2,0.9)';
    g.lineWidth = 2 + rnd() * 5;
    g.beginPath();
    g.moveTo(S / 2, S / 2);
    g.lineTo(S / 2 + Math.cos(a) * S * 0.45, S / 2 + Math.sin(a) * S * 0.45);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Gore {
  group = new THREE.Group();
  private blood: ParticleSet;
  private glow: ParticleSet;
  private emitters: Emitter[] = [];
  private decals: THREE.InstancedMesh[] = [];
  private decalNext = 0;
  private decalCount = 0;
  private readonly DECALS = 220;
  private gibs: Gib[] = [];
  private gibGeo: THREE.BufferGeometry[];
  private _v = new THREE.Vector3();
  private _d = new THREE.Vector3();
  private _m = new THREE.Matrix4();
  private _q = new THREE.Quaternion();
  private _n = { x: 0, y: 1, z: 0 };
  intensity = 1; // gore slider

  constructor(public world: World, private gibMat: THREE.Material) {
    this.blood = new ParticleSet(false, 0, 1);
    this.glow = new ParticleSet(true, 1, 0);
    this.group.add(this.blood.points, this.glow.points);
    for (let k = 0; k < 4; k++) {
      const mat = new THREE.MeshStandardMaterial({
        map: makeSplatTexture(k + 1),
        transparent: true,
        depthWrite: false,
        roughness: 0.12,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.rotateX(-Math.PI / 2);
      const im = new THREE.InstancedMesh(geo, mat, Math.ceil(this.DECALS / 4));
      im.count = 0;
      im.frustumCulled = false;
      im.receiveShadow = true;
      this.decals.push(im);
      this.group.add(im);
    }
    this.gibGeo = [new THREE.IcosahedronGeometry(0.05, 0), new THREE.DodecahedronGeometry(0.04, 0), new THREE.TetrahedronGeometry(0.06, 0)];
  }

  setLight(pos: THREE.Vector3, col: THREE.Color, intensity: number) {
    this.blood.mat.uniforms.uLightPos.value.copy(pos);
    this.blood.mat.uniforms.uLightCol.value.set(col.r * intensity, col.g * intensity, col.b * intensity).multiplyScalar(0.25);
  }
  setScale(pxHeight: number, fovDeg: number) {
    const s = pxHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
    this.blood.mat.uniforms.uScale.value = s;
    this.glow.mat.uniforms.uScale.value = s;
  }

  /** Blood burst at p travelling roughly along dir. */
  splash(p: THREE.Vector3, dir: THREE.Vector3, amount: number) {
    const n = Math.round(40 * amount * this.intensity);
    for (let i = 0; i < n; i++) {
      const sp = 1.5 + Math.random() * 5 * amount;
      const vx = dir.x * sp + (Math.random() - 0.5) * 3;
      const vy = dir.y * sp + Math.random() * 2.5;
      const vz = dir.z * sp + (Math.random() - 0.5) * 3;
      const dark = 0.5 + Math.random() * 0.5;
      this.blood.spawn(PT.Droplet, p.x, p.y, p.z, vx, vy, vz, 1.5 + Math.random(), 0.01 + Math.random() * 0.025, 0.2 * dark, 0.006 * dark, 0.008 * dark, 0.25, 1);
    }
    const m = Math.round(6 * amount * this.intensity);
    for (let i = 0; i < m; i++) {
      this.blood.spawn(PT.Mist, p.x, p.y, p.z, dir.x * 1.5 + (Math.random() - 0.5), dir.y * 1.5 + Math.random() * 0.5, dir.z * 1.5 + (Math.random() - 0.5), 0.6 + Math.random() * 0.5, 0.15 + Math.random() * 0.2, 0.2, 0.01, 0.01, 3, 0.05);
    }
  }

  /** Arterial spray from a wound that follows its parent for a few seconds. */
  spurt(parent: THREE.Object3D, local: THREE.Vector3, dir: THREE.Vector3, dur = 3, power = 1) {
    if (this.emitters.length > 24) this.emitters.shift();
    this.emitters.push({ parent, local: local.clone(), dir: dir.clone(), t: 0, dur, rate: 90 * this.intensity, acc: 0, power });
  }

  sparks(p: THREE.Vector3, dir: THREE.Vector3, n = 18) {
    for (let i = 0; i < n; i++) {
      const sp = 3 + Math.random() * 7;
      this.glow.spawn(PT.Spark, p.x, p.y, p.z, dir.x * sp + (Math.random() - 0.5) * 5, dir.y * sp + Math.random() * 4, dir.z * sp + (Math.random() - 0.5) * 5, 0.25 + Math.random() * 0.35, 0.02, 30, 14, 4, 0.8, 1);
    }
  }

  embers(p: THREE.Vector3, n: number, color: [number, number, number] = [16, 6, 1.5], spread = 0.3) {
    for (let i = 0; i < n; i++) {
      this.glow.spawn(PT.Ember, p.x + (Math.random() - 0.5) * spread, p.y + (Math.random() - 0.5) * spread * 0.5, p.z + (Math.random() - 0.5) * spread,
        (Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 1.2, (Math.random() - 0.5) * 0.6, 0.8 + Math.random() * 1.2, 0.025 + Math.random() * 0.03, color[0], color[1], color[2], 0.8, -0.05);
    }
  }

  dust(p: THREE.Vector3, n = 10) {
    for (let i = 0; i < n; i++) {
      this.blood.spawn(PT.Dust, p.x, p.y, p.z, (Math.random() - 0.5) * 2, Math.random() * 1.2, (Math.random() - 0.5) * 2, 1 + Math.random(), 0.2 + Math.random() * 0.3, 0.06, 0.055, 0.05, 2.5, 0.05);
    }
  }

  gibsAt(p: THREE.Vector3, dir: THREE.Vector3, n: number) {
    n = Math.round(n * this.intensity);
    for (let i = 0; i < n; i++) {
      let gib: Gib;
      if (this.gibs.length >= 60) {
        gib = this.gibs.shift()!;
      } else {
        const mesh = new THREE.Mesh(this.gibGeo[i % 3], this.gibMat);
        mesh.castShadow = true;
        this.group.add(mesh);
        gib = { mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, resting: false };
      }
      gib.mesh.position.copy(p);
      gib.mesh.scale.setScalar(0.6 + Math.random() * 1.2);
      gib.vel.set(dir.x * 3 + (Math.random() - 0.5) * 4, 1.5 + Math.random() * 3, dir.z * 3 + (Math.random() - 0.5) * 4);
      gib.spin.set(Math.random() * 10, Math.random() * 10, Math.random() * 10);
      gib.life = 30;
      gib.resting = false;
      this.gibs.push(gib);
    }
  }

  decal(x: number, z: number, size: number) {
    const im = this.decals[this.decalNext % 4];
    const slot = Math.floor(this.decalNext / 4) % im.instanceMatrix.count;
    this.decalNext = (this.decalNext + 1) % this.DECALS;
    this.decalCount = Math.min(this.DECALS, this.decalCount + 1);
    const y = this.world.height(x, z) + 0.02;
    const n = this.world.terrain.normal(x, z, this._n);
    this._d.set(n.x, n.y, n.z);
    this._q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this._d);
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    this._q.multiply(rot);
    this._m.compose(this._v.set(x, y, z), this._q, new THREE.Vector3(size, 1, size));
    im.setMatrixAt(slot, this._m);
    im.count = Math.max(im.count, slot + 1);
    im.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    // emitters
    for (let e = this.emitters.length - 1; e >= 0; e--) {
      const em = this.emitters[e];
      em.t += dt;
      if (em.t > em.dur || !em.parent.parent) {
        this.emitters.splice(e, 1);
        continue;
      }
      const pulse = 0.5 + 0.5 * Math.sin(em.t * 9);
      const fade = 1 - em.t / em.dur;
      em.acc += dt * em.rate * pulse * fade;
      em.parent.updateWorldMatrix(true, false);
      const wp = this._v.copy(em.local).applyMatrix4(em.parent.matrixWorld);
      const wd = this._d.copy(em.dir).transformDirection(em.parent.matrixWorld);
      while (em.acc > 1) {
        em.acc -= 1;
        const sp = (2 + Math.random() * 2.5) * em.power * (0.4 + pulse * 0.8);
        this.blood.spawn(PT.Spurt, wp.x, wp.y, wp.z, wd.x * sp + (Math.random() - 0.5) * 0.6, wd.y * sp + (Math.random() - 0.5) * 0.6, wd.z * sp + (Math.random() - 0.5) * 0.6, 1.4, 0.01 + Math.random() * 0.012, 0.2, 0.006, 0.008, 0.2, 1);
      }
    }
    this.sim(this.blood, dt, true);
    this.sim(this.glow, dt, false);
    // gibs
    for (const g of this.gibs) {
      if (g.resting) continue;
      g.vel.y -= 9.81 * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      g.mesh.rotation.x += g.spin.x * dt;
      g.mesh.rotation.y += g.spin.y * dt;
      const h = this.world.height(g.mesh.position.x, g.mesh.position.z) + 0.03;
      if (g.mesh.position.y < h) {
        g.mesh.position.y = h;
        if (Math.abs(g.vel.y) > 1.5 && Math.random() < 0.6) this.decal(g.mesh.position.x, g.mesh.position.z, 0.3 + Math.random() * 0.3);
        g.vel.y *= -0.3;
        g.vel.x *= 0.6;
        g.vel.z *= 0.6;
        g.spin.multiplyScalar(0.5);
        if (g.vel.lengthSq() < 0.05) g.resting = true;
      }
    }
  }

  private sim(s: ParticleSet, dt: number, collide: boolean) {
    for (let i = 0; i < MAX_P; i++) {
      if (s.life[i] <= 0) {
        if (s.alpha[i] !== 0) {
          s.alpha[i] = 0;
          s.size[i] = 0;
        }
        continue;
      }
      s.life[i] -= dt;
      const k = i * 3;
      const drag = Math.exp(-s.drag[i] * dt);
      s.vel[k] *= drag;
      s.vel[k + 1] = s.vel[k + 1] * drag - 9.81 * s.grav[i] * dt;
      s.vel[k + 2] *= drag;
      s.pos[k] += s.vel[k] * dt;
      s.pos[k + 1] += s.vel[k + 1] * dt;
      s.pos[k + 2] += s.vel[k + 2] * dt;
      const t = s.life[i] / s.maxLife[i];
      const type = s.type[i] as PT;
      if (type === PT.Mist || type === PT.Dust) {
        s.size[i] = s.baseSize[i] * (1.8 - t);
        s.alpha[i] = t * (type === PT.Dust ? 0.25 : 0.45);
      } else if (type === PT.Ember || type === PT.Spark) {
        s.alpha[i] = Math.min(1, t * 2);
        s.size[i] = s.baseSize[i];
      } else {
        s.alpha[i] = Math.min(1, t * 4);
        s.size[i] = s.baseSize[i];
      }
      if (collide && (type === PT.Droplet || type === PT.Spurt)) {
        const h = this.world.height(s.pos[k], s.pos[k + 2]);
        if (s.pos[k + 1] < h) {
          if (Math.random() < (type === PT.Spurt ? 0.08 : 0.2) * this.intensity) this.decal(s.pos[k], s.pos[k + 2], 0.4 + Math.random() * 0.9);
          s.life[i] = 0;
        }
      }
    }
    (s.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (s.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (s.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    (s.geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
  }
}
