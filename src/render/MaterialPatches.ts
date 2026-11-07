// Shader injections on top of three's physically based MeshStandardMaterial:
// triplanar projection, terrain splatting and wind animation. Keeping the
// standard lighting model means every surface gets the same lights/shadows.

import * as THREE from 'three';
import type { PBRSet } from './TextureGen';

export const globalUniforms = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector2(0.8, 0.3) },
};

const TRI_VERT_PARS = /* glsl */ `
varying vec3 vTpPos;
varying vec3 vTpNormal;
`;
const TRI_VERT = /* glsl */ `
{
  vec4 tpP = vec4(transformed, 1.0);
  vec3 tpN = objectNormal;
  #ifdef USE_INSTANCING
    tpP = instanceMatrix * tpP;
    tpN = mat3(instanceMatrix) * tpN;
  #endif
  vTpPos = (modelMatrix * tpP).xyz;
  vTpNormal = normalize(mat3(modelMatrix) * tpN);
}
`;
const TRI_FRAG_PARS = /* glsl */ `
varying vec3 vTpPos;
varying vec3 vTpNormal;
uniform float uTpScale;
vec3 tpWeights(vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0));
  return w / (w.x + w.y + w.z);
}
vec4 tpSample(sampler2D t, vec3 p, vec3 w) {
  return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z;
}
vec3 tpNormal(sampler2D t, vec3 p, vec3 n, vec3 w) {
  // Whiteout-blended triplanar normal mapping in world space.
  vec3 tx = texture2D(t, p.zy).xyz * 2.0 - 1.0;
  vec3 ty = texture2D(t, p.xz).xyz * 2.0 - 1.0;
  vec3 tz = texture2D(t, p.xy).xyz * 2.0 - 1.0;
  tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x);
  ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y);
  tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
  return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
}
`;

/** Converts a textured MeshStandardMaterial into world-space triplanar mapping. */
export function makeTriplanar(mat: THREE.MeshStandardMaterial, scale = 0.5, normalStrength = 1) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTpScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + TRI_VERT_PARS)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + TRI_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + TRI_FRAG_PARS)
      .replace(
        '#include <map_fragment>',
        `vec3 tpW = tpWeights(normalize(vTpNormal));
         vec3 tpP = vTpPos * uTpScale;
         #ifdef USE_MAP
           diffuseColor *= tpSample(map, tpP, tpW);
         #endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
         #ifdef USE_ROUGHNESSMAP
           vec4 texelRoughness = tpSample(roughnessMap, tpP, tpW);
           roughnessFactor *= texelRoughness.g;
         #endif`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `float metalnessFactor = metalness;
         #ifdef USE_METALNESSMAP
           metalnessFactor *= tpSample(metalnessMap, tpP, tpW).b;
         #endif`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#ifdef USE_NORMALMAP
           vec3 tpWN = tpNormal(normalMap, tpP, normalize(vTpNormal), tpW);
           tpWN = normalize(mix(normalize(vTpNormal), tpWN, ${normalStrength.toFixed(2)}));
           normal = normalize((viewMatrix * vec4(tpWN, 0.0)).xyz);
         #endif`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#ifdef USE_AOMAP
           float ambientOcclusion = (tpSample(aoMap, tpP, tpW).r - 1.0) * aoMapIntensity + 1.0;
           reflectedLight.indirectDiffuse *= ambientOcclusion;
         #endif`,
      );
  };
  mat.customProgramCacheKey = () => 'triplanar' + scale + normalStrength;
  return mat;
}

/** Terrain: 3-way splat (mud / grass / rock) driven by a per-vertex attribute. */
export function makeTerrainMaterial(mud: PBRSet, grass: PBRSet, rock: PBRSet): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: mud.map,
    normalMap: mud.normalMap,
    roughnessMap: mud.orm,
    aoMap: mud.orm,
    roughness: 1,
    metalness: 0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrassMap = { value: grass.map };
    shader.uniforms.uGrassNormal = { value: grass.normalMap };
    shader.uniforms.uGrassOrm = { value: grass.orm };
    shader.uniforms.uRockMap = { value: rock.map };
    shader.uniforms.uRockNormal = { value: rock.normalMap };
    shader.uniforms.uRockOrm = { value: rock.orm };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 splat;\nvarying vec3 vSplat;\nvarying vec2 vWorldXZ;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSplat = splat;\nvWorldXZ = (modelMatrix * vec4(position,1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vSplat; varying vec2 vWorldXZ;
         uniform sampler2D uGrassMap, uGrassNormal, uGrassOrm, uRockMap, uRockNormal, uRockOrm;
         // height-aware blend weights so materials interlock instead of crossfading
         vec3 splatW(float hMud, float hGrass, float hRock) {
           vec3 w = vec3(max(1.0 - vSplat.x - vSplat.y, 0.0), vSplat.x, vSplat.y);
           vec3 h = vec3(hMud, hGrass, hRock) + w;
           float m = max(max(h.x, h.y), h.z) - 0.25;
           vec3 b = max(h - m, 0.0);
           return b / (b.x + b.y + b.z + 1e-4);
         }`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 uvM = vWorldXZ * 0.28;
         vec2 uvG = vWorldXZ * 0.37 + 0.31;
         vec2 uvR = vWorldXZ * 0.15;
         vec4 cM = texture2D(map, uvM);
         vec4 cG = texture2D(uGrassMap, uvG);
         vec4 cR = texture2D(uRockMap, uvR);
         // macro variation to kill tiling
         float macro = texture2D(uRockMap, vWorldXZ * 0.013).g;
         vec3 sw = splatW(dot(cM.rgb, vec3(2.0)), dot(cG.rgb, vec3(2.0)), dot(cR.rgb, vec3(1.5)));
         vec3 terrainAlbedo = cM.rgb * sw.x + cG.rgb * sw.y + cR.rgb * sw.z;
         terrainAlbedo *= 0.7 + macro * 1.6;
         terrainAlbedo *= mix(1.0, 0.6, vSplat.z);
         diffuseColor.rgb *= terrainAlbedo;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `vec4 oM = texture2D(roughnessMap, uvM);
         vec4 oG = texture2D(uGrassOrm, uvG);
         vec4 oR = texture2D(uRockOrm, uvR);
         vec4 terrainOrm = oM * sw.x + oG * sw.y + oR * sw.z;
         float roughnessFactor = roughness * mix(terrainOrm.g, terrainOrm.g * 0.35, vSplat.z * sw.x);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 nM = texture2D(normalMap, uvM).xyz * 2.0 - 1.0;
         vec3 nG = texture2D(uGrassNormal, uvG).xyz * 2.0 - 1.0;
         vec3 nR = texture2D(uRockNormal, uvR).xyz * 2.0 - 1.0;
         vec3 mapN = normalize(nM * sw.x + nG * sw.y + nR * sw.z);
         mapN.xy *= normalScale;
         normal = normalize(tbn * mapN);`,
      )
      .replace(
        '#include <aomap_fragment>',
        `float ambientOcclusion = (terrainOrm.r - 1.0) * aoMapIntensity + 1.0;
         reflectedLight.indirectDiffuse *= ambientOcclusion;`,
      );
  };
  mat.customProgramCacheKey = () => 'terrain';
  return mat;
}

/** Vertex wind sway, scaled by local height (y) above the object's base. */
export function addWind(mat: THREE.Material, strength = 0.15, heightScale = 0.1) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prev?.call(mat, shader, r);
    shader.uniforms.uTime = globalUniforms.uTime;
    shader.uniforms.uWind = globalUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec2 uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           float hgt = max(position.y, 0.0) * ${heightScale.toFixed(3)};
           vec3 basePos = vec3(0.0);
           #ifdef USE_INSTANCING
             basePos = instanceMatrix[3].xyz;
           #endif
           float ph = dot(basePos.xz, vec2(0.13, 0.17));
           float sway = sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 2.7 + ph * 1.7) * 0.3 + sin(uTime * 0.4 + ph * 0.3) * 0.8;
           transformed.xz += uWind * sway * hgt * hgt * ${strength.toFixed(3)};
         }`,
      );
  };
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + 'wind' + strength + heightScale;
}
