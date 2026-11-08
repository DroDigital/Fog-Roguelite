// Frame pipeline: scene → volumetric fog (half res) → depth-aware composite
// → physically based bloom → tonemapping, grading and lens effects.

import * as THREE from 'three';
import { FULLSCREEN_VERT, FOG_FRAG, COMPOSITE_FRAG, DOWNSAMPLE_FRAG, UPSAMPLE_FRAG, FINAL_FRAG, FXAA_FRAG, MAX_FOG_LIGHTS } from './shaders';
import type { FogSim } from '../world/FogSim';

export interface Quality {
  renderScale: number;
  fogScale: number;
  fogSteps: number;
  shadowSize: number;
  msaa: number;
}

export const QUALITY_PRESETS: Record<string, Quality> = {
  low: { renderScale: 0.7, fogScale: 0.35, fogSteps: 28, shadowSize: 1024, msaa: 0 },
  medium: { renderScale: 0.85, fogScale: 0.5, fogSteps: 40, shadowSize: 2048, msaa: 2 },
  high: { renderScale: 1, fogScale: 0.5, fogSteps: 56, shadowSize: 2048, msaa: 4 },
  ultra: { renderScale: 1, fogScale: 0.75, fogSteps: 72, shadowSize: 4096, msaa: 4 },
};

export interface FogLight { pos: THREE.Vector3; color: THREE.Color; intensity: number; radius: number }

export class Pipeline {
  private sceneRT!: THREE.WebGLRenderTarget;
  private fogRT!: THREE.WebGLRenderTarget;
  private fogHist!: THREE.WebGLRenderTarget;
  private ldrRT!: THREE.WebGLRenderTarget;
  private fxaaMat: THREE.ShaderMaterial;
  private prevViewProj = new THREE.Matrix4();
  private historyValid = false;
  private compRT!: THREE.WebGLRenderTarget;
  private bloomRTs: THREE.WebGLRenderTarget[] = [];
  private quad: THREE.Mesh;
  private qScene = new THREE.Scene();
  private qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  fogMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private downMat: THREE.ShaderMaterial;
  private upMat: THREE.ShaderMaterial;
  finalMat: THREE.ShaderMaterial;
  private frame = 0;
  private w = 1;
  private h = 1;
  quality: Quality = QUALITY_PRESETS.high;
  /** Dynamic resolution multiplier, driven by measured frame time. */
  dynScale = 1;
  private ftAvg = 16;
  private ftT = 0;

  /** Feed real frame times; nudges internal resolution to hold ~60 fps. */
  adapt(realDt: number) {
    this.ftAvg += (realDt * 1000 - this.ftAvg) * 0.05;
    this.ftT += realDt;
    if (this.ftT < 2.5) return;
    this.ftT = 0;
    let next = this.dynScale;
    if (this.ftAvg > 21 && this.dynScale > 0.55) next = Math.max(0.55, this.dynScale - 0.1);
    else if (this.ftAvg < 13 && this.dynScale < 1) next = Math.min(1, this.dynScale + 0.05);
    if (next !== this.dynScale) {
      this.dynScale = next;
      this.resize(window.innerWidth, window.innerHeight);
    }
  }
  fogLights: FogLight[] = [];

  constructor(private renderer: THREE.WebGLRenderer, noise3D: THREE.Data3DTexture, sim: FogSim) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.qScene.add(this.quad);
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    const lp: THREE.Vector4[] = [];
    const lc: THREE.Vector3[] = [];
    for (let i = 0; i < MAX_FOG_LIGHTS; i++) {
      lp.push(new THREE.Vector4());
      lc.push(new THREE.Vector3());
    }
    this.fogMat = mk(FOG_FRAG, {
      tDepth: { value: null },
      tSim: { value: sim.texture },
      tNoise: { value: noise3D },
      tShadow: { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uShadowOn: { value: 0 },
      uProjInv: { value: new THREE.Matrix4() },
      uViewInv: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uSimOrigin: { value: new THREE.Vector2() },
      uSimSize: { value: sim.size },
      uGroundRef: { value: 0 },
      uDensity: { value: 0.085 },
      uFalloff: { value: 0.22 },
      uMaxDist: { value: 150 },
      uWindOffset: { value: new THREE.Vector3() },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonCol: { value: new THREE.Color(0.1, 0.12, 0.16) },
      uAmbient: { value: new THREE.Color(0.012, 0.015, 0.02) },
      uLightPos: { value: lp },
      uLightCol: { value: lc },
      uLightCount: { value: 0 },
      uSteps: { value: 48 },
      uFrame: { value: 0 },
      uRes: { value: new THREE.Vector2() },
      tHistory: { value: null },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uHistoryValid: { value: 0 },
    });
    this.fxaaMat = mk(FXAA_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.compMat = mk(COMPOSITE_FRAG, {
      tScene: { value: null },
      tFog: { value: null },
      tDepth: { value: null },
      uFogRes: { value: new THREE.Vector2() },
      uNear: { value: 0.05 },
      uFar: { value: 300 },
    });
    this.downMat = mk(DOWNSAMPLE_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 } });
    this.upMat = mk(UPSAMPLE_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } });
    this.upMat.blending = THREE.AdditiveBlending;
    this.upMat.transparent = true;
    this.finalMat = mk(FINAL_FRAG, {
      tHdr: { value: null },
      tBloom: { value: null },
      uExposure: { value: 1.0 },
      uBloom: { value: 0.09 },
      uTime: { value: 0 },
      uDamage: { value: 0 },
      uHealth: { value: 1 },
      uBlood: { value: 0 },
      uBloodSeed: { value: 0 },
      uAberration: { value: 0.0025 },
      uGrain: { value: 0.045 },
      uFade: { value: 1 },
      uRes: { value: new THREE.Vector2() },
    });
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.resize(window.innerWidth, window.innerHeight);
  }

  resize(cw: number, ch: number) {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(cw, ch, false);
    this.renderer.domElement.style.width = cw + 'px';
    this.renderer.domElement.style.height = ch + 'px';
    const s = this.quality.renderScale * this.dynScale * Math.min(dpr, 1.5);
    const w = Math.max(2, Math.floor(cw * s)), h = Math.max(2, Math.floor(ch * s));
    this.w = w;
    this.h = h;
    this.sceneRT?.dispose();
    this.fogRT?.dispose();
    this.fogHist?.dispose();
    this.ldrRT?.dispose();
    this.compRT?.dispose();
    for (const b of this.bloomRTs) b.dispose();
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      depthTexture,
      samples: this.quality.msaa,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const fw = Math.max(2, Math.floor(w * this.quality.fogScale)), fh = Math.max(2, Math.floor(h * this.quality.fogScale));
    const fogOpts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter } as const;
    this.fogRT = new THREE.WebGLRenderTarget(fw, fh, fogOpts);
    this.fogHist = new THREE.WebGLRenderTarget(fw, fh, fogOpts);
    this.historyValid = false;
    this.ldrRT = new THREE.WebGLRenderTarget(cw, ch, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.fxaaMat.uniforms.uTexel.value.set(1 / cw, 1 / ch);
    this.compRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.bloomRTs = [];
    let bw = w, bh = h;
    for (let i = 0; i < 6; i++) {
      bw = Math.max(1, Math.floor(bw / 2));
      bh = Math.max(1, Math.floor(bh / 2));
      this.bloomRTs.push(new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping }));
    }
    this.fogMat.uniforms.uRes.value.set(fw, fh);
    this.compMat.uniforms.uFogRes.value.set(fw, fh);
    this.finalMat.uniforms.uRes.value.set(cw, ch);
  }

  private pass(mat: THREE.Material, target: THREE.WebGLRenderTarget | null, clear = true) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    if (clear) this.renderer.clear(true, false, false);
    this.renderer.render(this.qScene, this.qCam);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, sim: FogSim, moon: THREE.DirectionalLight, time: number) {
    const r = this.renderer;
    this.frame++;
    r.autoClear = true;
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    // --- Volumetric fog
    const fu = this.fogMat.uniforms;
    fu.tDepth.value = this.sceneRT.depthTexture;
    fu.uProjInv.value.copy(camera.projectionMatrixInverse);
    fu.uViewInv.value.copy(camera.matrixWorld);
    fu.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    fu.uTime.value = time;
    fu.uSimOrigin.value.set(sim.originX, sim.originZ);
    fu.uGroundRef.value = sim.groundRef;
    fu.uFrame.value = this.frame % 64;
    fu.uSteps.value = this.quality.fogSteps;
    fu.uWindOffset.value.set(time * 0.018, Math.sin(time * 0.05) * 0.02, time * 0.009);
    fu.uMoonDir.value.copy(moon.position).sub(moon.target.position).normalize();
    const sm = moon.shadow.map;
    if (moon.castShadow && sm && sm.depthTexture) {
      fu.tShadow.value = sm.depthTexture;
      fu.uShadowMatrix.value.copy(moon.shadow.matrix);
      fu.uShadowOn.value = 1;
    } else fu.uShadowOn.value = 0;
    const n = Math.min(MAX_FOG_LIGHTS, this.fogLights.length);
    for (let i = 0; i < n; i++) {
      const L = this.fogLights[i];
      fu.uLightPos.value[i].set(L.pos.x, L.pos.y, L.pos.z, L.radius);
      fu.uLightCol.value[i].set(L.color.r * L.intensity, L.color.g * L.intensity, L.color.b * L.intensity);
    }
    fu.uLightCount.value = n;
    fu.tHistory.value = this.fogHist.texture;
    fu.uPrevViewProj.value.copy(this.prevViewProj);
    fu.uHistoryValid.value = this.historyValid ? 1 : 0;
    this.pass(this.fogMat, this.fogRT);
    // ping-pong: this frame's fog becomes next frame's history
    const tmp = this.fogRT;
    this.fogRT = this.fogHist;
    this.fogHist = tmp;
    this.historyValid = true;
    this.prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    // --- Composite
    const cu = this.compMat.uniforms;
    cu.tScene.value = this.sceneRT.texture;
    cu.tFog.value = this.fogHist.texture;
    cu.tDepth.value = this.sceneRT.depthTexture;
    cu.uNear.value = camera.near;
    cu.uFar.value = camera.far;
    this.pass(this.compMat, this.compRT);

    // --- Bloom (mip chain)
    let src = this.compRT.texture;
    let sw = this.w, sh = this.h;
    for (let i = 0; i < this.bloomRTs.length; i++) {
      this.downMat.uniforms.tSrc.value = src;
      this.downMat.uniforms.uTexel.value.set(1 / sw, 1 / sh);
      this.downMat.uniforms.uPrefilter.value = i === 0 ? 1 : 0;
      this.pass(this.downMat, this.bloomRTs[i]);
      src = this.bloomRTs[i].texture;
      sw = this.bloomRTs[i].width;
      sh = this.bloomRTs[i].height;
    }
    for (let i = this.bloomRTs.length - 1; i > 0; i--) {
      const s = this.bloomRTs[i];
      this.upMat.uniforms.tSrc.value = s.texture;
      this.upMat.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
      this.pass(this.upMat, this.bloomRTs[i - 1], false);
    }

    // --- Final
    const fin = this.finalMat.uniforms;
    fin.tHdr.value = this.compRT.texture;
    fin.tBloom.value = this.bloomRTs[0].texture;
    fin.uTime.value = time;
    this.pass(this.finalMat, this.ldrRT);
    this.fxaaMat.uniforms.tSrc.value = this.ldrRT.texture;
    this.pass(this.fxaaMat, null);
  }
}
