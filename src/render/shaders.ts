// GLSL for the post-processing chain.

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const MAX_FOG_LIGHTS = 8;

export const FOG_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
precision highp sampler2DShadow;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform sampler2D tSim;
uniform sampler3D tNoise;
uniform sampler2DShadow tShadow;
uniform mat4 uShadowMatrix;
uniform float uShadowOn;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec2 uSimOrigin;
uniform float uSimSize;
uniform float uGroundRef;
uniform float uDensity;
uniform float uFalloff;
uniform float uMaxDist;
uniform vec3 uWindOffset;
uniform vec3 uMoonDir;
uniform vec3 uMoonCol;
uniform vec3 uAmbient;
uniform vec4 uLightPos[${MAX_FOG_LIGHTS}];
uniform vec3 uLightCol[${MAX_FOG_LIGHTS}];
uniform int uLightCount;
uniform int uSteps;
uniform float uFrame;
uniform vec2 uRes;
uniform sampler2D tHistory;
uniform mat4 uPrevViewProj;
uniform float uHistoryValid;

float ign(vec2 p) { // interleaved gradient noise
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

float densityAt(vec3 p) {
  vec2 suv = (p.xz - uSimOrigin) / uSimSize;
  vec2 e = smoothstep(vec2(0.0), vec2(0.08), suv) * smoothstep(vec2(1.0), vec2(0.92), suv);
  float inside = e.x * e.y;
  vec4 s = texture2D(tSim, suv);
  vec2 vel = (s.rg * 255.0 - 128.0) / 16.0 * inside;
  float disp = s.b * inside;
  float ground = uGroundRef + (s.a * 255.0 - 128.0) / 4.0 * inside;
  float h = p.y - ground;
  float layer = exp(-max(h, 0.0) * uFalloff);
  float haze = exp(-max(p.y - uGroundRef, 0.0) * 0.035) * 0.22;
  vec3 q = p * 0.05 + uWindOffset - vec3(vel.x, 0.0, vel.y) * 0.05;
  float n1 = texture(tNoise, q).r;
  float n2 = texture(tNoise, q * 2.9 + vec3(0.37, uTime * 0.01, 0.71)).r;
  float n = n1 * 0.68 + n2 * 0.32;
  float billow = smoothstep(0.3, 0.72, n);
  float d = layer * (0.25 + 1.6 * billow) + haze * (0.6 + 0.8 * n);
  return uDensity * d * (1.0 - disp * 0.92);
}

void main() {
  float depth = texture2D(tDepth, vUv).r;
  vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 vp = uProjInv * ndc;
  vp /= vp.w;
  vec3 wp = (uViewInv * vp).xyz;
  vec3 rd = wp - uCamPos;
  float dist = length(rd);
  rd /= dist;
  if (depth >= 1.0) dist = uMaxDist;
  float L = min(dist, uMaxDist);

  float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.618034);
  float cosM = dot(rd, uMoonDir);
  float phM = hg(cosM, 0.55) * 0.8 + hg(cosM, -0.2) * 0.2;
  vec3 scat = vec3(0.0);
  float T = 1.0;
  float prevT = 0.0;
  int N = uSteps;
  for (int i = 0; i < 96; i++) {
    if (i >= N) break;
    float f0 = (float(i) + jitter) / float(N);
    float f1 = (float(i) + 1.0 + jitter) / float(N);
    float t = L * f0 * f0;
    float t1 = L * min(f1 * f1, 1.0);
    float dt = max(t1 - t, 0.0);
    vec3 p = uCamPos + rd * t;
    float sigma = densityAt(p);
    if (sigma > 1e-4) {
      // moonlight with volumetric shadows
      float sh = 1.0;
      if (uShadowOn > 0.5) {
        vec4 sc = uShadowMatrix * vec4(p, 1.0);
        if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0) sh = texture(tShadow, vec3(sc.xy, sc.z - 0.002));
      }
      vec3 Lr = uAmbient + uMoonCol * phM * sh * 4.0;
      for (int k = 0; k < ${MAX_FOG_LIGHTS}; k++) {
        if (k >= uLightCount) break;
        vec3 dl = uLightPos[k].xyz - p;
        float d2 = dot(dl, dl);
        float r = uLightPos[k].w;
        float fall = clamp(1.0 - d2 / (r * r), 0.0, 1.0);
        fall *= fall;
        float c = dot(rd, dl * inversesqrt(d2 + 1e-4));
        Lr += uLightCol[k] * (hg(c, 0.35) * 0.7 + 0.03) * fall / (1.0 + d2 * 12.0 / (r * r));
      }
      float ext = exp(-sigma * dt);
      scat += T * Lr * (1.0 - ext);
      T *= ext;
      if (T < 0.004) break;
    }
  }
  vec4 cur = vec4(scat, T);
  // temporal accumulation: reproject the ray's end point into last frame
  if (uHistoryValid > 0.5) {
    vec3 pr = uCamPos + rd * min(L, 60.0);
    vec4 pc = uPrevViewProj * vec4(pr, 1.0);
    vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
    if (pc.w > 0.0 && puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) {
      vec4 hist = texture2D(tHistory, puv);
      // clamp history towards the current estimate to avoid ghosting on moving bodies
      hist.rgb = clamp(hist.rgb, cur.rgb * 0.55 - 0.002, cur.rgb * 1.7 + 0.002);
      hist.a = clamp(hist.a, cur.a - 0.12, cur.a + 0.12);
      float w = 0.86 * (1.0 - clamp(abs(hist.a - cur.a) * 2.5, 0.0, 0.6));
      cur = mix(cur, hist, w);
    }
  }
  gl_FragColor = cur;
}
`;

export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tFog;
uniform sampler2D tDepth;
uniform vec2 uFogRes;
uniform float uNear;
uniform float uFar;
float linDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
void main() {
  vec3 col = texture2D(tScene, vUv).rgb;
  float dc = linDepth(texture2D(tDepth, vUv).r);
  // depth-aware upsample of the half resolution fog buffer
  vec2 tc = vUv * uFogRes - 0.5;
  vec2 f = fract(tc);
  vec2 base = (floor(tc) + 0.5) / uFogRes;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int y = 0; y < 2; y++)
  for (int x = 0; x < 2; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 suv = base + o / uFogRes;
    float ds = linDepth(texture2D(tDepth, suv).r);
    float bw = (x == 0 ? 1.0 - f.x : f.x) * (y == 0 ? 1.0 - f.y : f.y);
    float w = bw / (0.02 + abs(ds - dc) / max(dc, 0.1) * 40.0);
    acc += texture2D(tFog, suv) * w;
    wsum += w;
  }
  vec4 fog = acc / max(wsum, 1e-5);
  gl_FragColor = vec4(col * fog.a + fog.rgb, 1.0);
}
`;

export const DOWNSAMPLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uPrefilter;
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  // 13-tap downsample (Jimenez 2014)
  vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
  vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
  vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
  vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (uPrefilter > 0.5) {
    // soft knee + firefly suppression on the first mip
    float br = max(col.r, max(col.g, col.b));
    col *= clamp((br - 0.6) / max(br, 1e-4), 0.0, 1.0) * 1.0 + 0.15;
    col /= 1.0 + br * 0.05;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export const UPSAMPLE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += (texture2D(tSrc, vUv + vec2(-t.x, 0)).rgb + texture2D(tSrc, vUv + vec2(t.x, 0)).rgb + texture2D(tSrc, vUv + vec2(0, t.y)).rgb + texture2D(tSrc, vUv + vec2(0, -t.y)).rgb) * 2.0;
  c += texture2D(tSrc, vUv + t).rgb + texture2D(tSrc, vUv - t).rgb + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb + texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb;
  gl_FragColor = vec4(c / 16.0, 1.0);
}
`;

export const FINAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tHdr;
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uBloom;
uniform float uTime;
uniform float uDamage;     // flash on hit 0..1
uniform float uHealth;     // 0..1
uniform float uBlood;      // screen blood splatter 0..1
uniform float uBloodSeed;
uniform float uAberration;
uniform float uGrain;
uniform float uFade;       // 0 = black
uniform vec2 uRes;

vec3 ACES(vec3 x) {
  // Hill ACES fitted (sRGB -> AP1 -> RRT/ODT -> sRGB)
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 o = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  x = i * x;
  vec3 a = x * (x + 0.0245786) - 0.000090537;
  vec3 b = x * (0.983729 * x + 0.4329510) + 0.238081;
  return clamp(o * (a / b), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += vnoise(p) * a; p *= 2.03; a *= 0.5; } return s; }

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  // radial chromatic aberration, stronger when hurt
  float ab = (uAberration + uDamage * 0.006) * r2 * 4.0;
  vec3 hdr;
  hdr.r = texture2D(tHdr, uv - c * ab).r;
  hdr.g = texture2D(tHdr, uv).g;
  hdr.b = texture2D(tHdr, uv + c * ab).b;
  vec3 bloom = texture2D(tBloom, uv).rgb;
  vec3 col = hdr + bloom * uBloom;
  col *= uExposure;
  col = ACES(col);
  // grading: cold desaturated shadows, warm lantern highlights
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 shadowTint = vec3(0.86, 0.97, 1.08);
  vec3 highTint = vec3(1.07, 1.0, 0.9);
  col *= mix(shadowTint, highTint, smoothstep(0.05, 0.6, lum));
  float sat = mix(0.78, 0.35, 1.0 - uHealth);
  col = mix(vec3(lum), col, sat);
  col = pow(col, vec3(1.0 / 2.2)); // to display (sRGB approx)
  col = col * 1.04 - 0.012;          // gentle toe crush
  // vignette
  float vig = smoothstep(0.85, 0.2, length(c * vec2(1.0, 0.85)));
  col *= mix(0.45, 1.0, vig);
  // damage / low health pulse
  float pulse = (1.0 - uHealth) * (0.6 + 0.4 * sin(uTime * 6.0));
  float edge = smoothstep(0.25, 0.75, length(c) * 1.3);
  col = mix(col, vec3(0.25, 0.0, 0.0), edge * clamp(uDamage * 0.8 + pulse * 0.45 * step(uHealth, 0.4), 0.0, 0.85));
  // screen blood splatter
  if (uBlood > 0.001) {
    // droplets and smears that cling to the edges of your vision
    vec2 bp = uv * vec2(uRes.x / uRes.y, 1.0) * 4.0 + uBloodSeed * 13.7;
    float n = fbm(bp) * 0.75 + fbm(bp * 3.1 + 3.1) * 0.35;
    float e2 = smoothstep(0.18, 0.75, length(c) * 1.35);
    float th = 1.08 - uBlood * 0.24 * (0.2 + e2) - e2 * 0.12;
    float mask = smoothstep(th, th + 0.025, n);
    float drip = smoothstep(0.72, 0.95, fbm(vec2(uv.x * 38.0 + uBloodSeed, uv.y * 1.5 + uTime * 0.03))) * e2;
    mask = max(mask, drip * step(th - 0.12, n));
    vec3 bc = vec3(0.05, 0.0, 0.002) + vec3(0.07, 0.0, 0.0) * fbm(bp * 6.0);
    col = mix(col, bc, clamp(mask * min(1.0, uBlood * 2.0), 0.0, 0.9));
  }
  // film grain
  float g = hash(uv * uRes + fract(uTime * 13.37) * 100.0) - 0.5;
  col += g * uGrain * (1.0 - lum * 0.6);
  col *= uFade;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// FXAA 3.11 (console/"quality lite" variant) on the tonemapped image.
export const FXAA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec3 rgbNW = texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb;
  vec3 rgbM = texture2D(tSrc, vUv).rgb;
  float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0 / 128.0);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 a = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tSrc, vUv + dir * -0.5).rgb + texture2D(tSrc, vUv + dir * 0.5).rgb);
  float lB = luma(b);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}
`;
