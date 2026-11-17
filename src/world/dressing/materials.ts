import * as THREE from 'three';
import { ATMOSPHERE_GLSL, SUN_DIRECTION } from '../../systems/Atmosphere';
import { cityUniforms } from '../CityMaterials';

/**
 * Shared materials for the set dressing. Every shader here keeps its HDR
 * output finite: pow() bases are clamped, nothing normalises a vector that
 * can be zero, and no divisor can reach zero.
 */

export type DressUniforms = {
  uTime: { value: number };
  uPower: { value: number };
  uWind: { value: THREE.Vector3 };
  uSunDir: { value: THREE.Vector3 };
};

export function createDressUniforms(): DressUniforms {
  return {
    uTime: { value: 0 },
    uPower: cityUniforms.uPower,
    // xy = unit wind direction in world xz, z = strength
    uWind: { value: new THREE.Vector3(0.83, 0.56, 1) },
    uSunDir: { value: SUN_DIRECTION.clone() },
  };
}

const HASH_GLSL = /* glsl */ `
float dHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float dNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dHash(i), dHash(i + vec2(1.0, 0.0)), u.x), mix(dHash(i + vec2(0.0, 1.0)), dHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

/** Matches the depth-fog pass so unlit/transparent layers sink into the same haze. */
const HAZE_GLSL = /* glsl */ `
${ATMOSPHERE_GLSL}
vec3 dressHaze(vec3 col, vec3 world, vec3 camPos, vec3 sunDir, float strength) {
  vec3 ray = world - camPos;
  float dist = length(ray);
  vec3 rd = ray / max(dist, 1e-3);
  float k = rd.y * 0.0125;
  float integral = abs(k) < 1e-5 ? dist : (1.0 - exp(clamp(-dist * k, -60.0, 60.0))) / k;
  float amount = 0.0021 * exp(-max(camPos.y, 0.0) * 0.0125) * max(integral, 0.0);
  float fog = clamp((1.0 - exp(-amount)) * strength, 0.0, 1.0);
  vec3 hd = vec3(rd.x, max(rd.y, 0.0) * 0.35 + 0.035, rd.z);
  hd /= max(length(hd), 1e-3);
  vec3 haze = ashAtmosphere(hd, sunDir);
  haze += vec3(1.3, 0.6, 0.2) * pow(max(dot(rd, sunDir), 0.0), 6.0) * 0.3;
  haze = min(haze, vec3(2.4, 1.5, 0.8));
  return mix(col, haze, fog);
}
`;

const SWAY_VERTEX = /* glsl */ `
float dSwayPhase = position.x * 0.11 + position.z * 0.13;
float dSway = aFx.x * (sin(uDressTime * 1.3 + dSwayPhase) * 0.6 + sin(uDressTime * 2.9 + dSwayPhase * 1.9) * 0.28 + 0.35);
transformed.x += dSway * uDressWind.x * uDressWind.z;
transformed.z += dSway * uDressWind.y * uDressWind.z;
`;

/**
 * Painted/rusted hard-surface props: vertex colour albedo, world-space grime,
 * ash banked at the base, per-vertex emissive lamps with blink modes and
 * optional vertex-shader sway (dead trees).
 */
export function createPropMaterial(u: DressUniforms): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.25, envMapIntensity: 0.9 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDressTime = u.uTime;
    shader.uniforms.uDressWind = u.uWind;
    shader.uniforms.uDressPower = u.uPower;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aFx;
uniform float uDressTime;
uniform vec3 uDressWind;
varying vec3 vDressFx;
varying vec3 vDressPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${SWAY_VERTEX}
vDressFx = aFx;
vDressPos = transformed;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uDressTime;
uniform float uDressPower;
varying vec3 vDressFx;
varying vec3 vDressPos;
${HASH_GLSL}`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
float dGrain = dNoise(vDressPos.xz * 1.7 + vDressPos.y * 1.3) * 0.6 + dNoise(vDressPos.xz * 9.0 + vDressPos.y * 7.0) * 0.4;
float dStreak = dNoise(vec2(dot(vDressPos.xz, vec2(2.3, 1.7)), vDressPos.y * 0.35));
float dLamp = step(0.001, vDressFx.y);
vec3 dBase = diffuseColor.rgb * (0.66 + 0.6 * dGrain);
dBase *= mix(1.0, 0.6, smoothstep(0.55, 0.9, dStreak));
dBase = mix(dBase, vec3(0.25, 0.1, 0.045) * (0.6 + 0.8 * dGrain), smoothstep(0.62, 0.86, dNoise(vDressPos.xz * 0.55 + vDressPos.y * 0.8 + 7.0)) * 0.55);
float dAsh = (1.0 - smoothstep(0.0, 0.85, vDressPos.y - 0.2 + dGrain * 0.5)) * 0.62;
dBase = mix(dBase, vec3(0.27, 0.235, 0.19) * (0.7 + 0.5 * dGrain), dAsh);
diffuseColor.rgb = mix(dBase, diffuseColor.rgb, dLamp);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor - 0.22 + 0.4 * dGrain + dAsh * 0.3, 0.3, 1.0);')
      .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
{
  float dMode = floor(vDressFx.z + 0.001);
  float dPh = fract(vDressFx.z) * 6.2831853;
  float dBlink = 1.0;
  if (dMode > 3.5) dBlink = uDressPower;
  else if (dMode > 2.5) dBlink = 0.62 + 0.38 * sin(uDressTime * 13.0 + dPh) * sin(uDressTime * 7.1 + dPh * 2.0);
  else if (dMode > 1.5) { float dS = max(sin(uDressTime * 4.2 + dPh), 0.0); dBlink = 0.04 + dS * dS * dS * dS * dS * dS; }
  else if (dMode > 0.5) dBlink = 0.05 + 0.95 * smoothstep(-0.15, 0.15, sin(uDressTime * 3.3 + dPh));
  totalEmissiveRadiance += vColor.rgb * vDressFx.y * dBlink;
}`);
  };
  material.customProgramCacheKey = () => 'ashen-dress-prop';
  return material;
}

/** Alpha-tested cards (weeds, twigs, tarps, flags, wire): lit by the authored normal on both sides. */
export function createCardMaterial(u: DressUniforms, map: THREE.Texture): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ map, vertexColors: true, alphaTest: 0.42, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDressTime = u.uTime;
    shader.uniforms.uDressWind = u.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aFx;
uniform float uDressTime;
uniform vec3 uDressWind;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${SWAY_VERTEX}
transformed.y -= abs(dSway) * 0.12;`);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      'vec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;',
    );
  };
  material.customProgramCacheKey = () => 'ashen-dress-card';
  return material;
}

export function createSignMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map, vertexColors: true, alphaTest: 0.5, roughness: 0.62, metalness: 0.25, envMapIntensity: 0.8 });
}

export function createDecalMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    roughness: 0.86,
    metalness: 0,
    envMapIntensity: 0.6,
  });
}

/**
 * Surviving neon: opaque quads whose tubes are an HDR emissive mask.
 * aNeon = (seed, power threshold, intensity). Threshold 0 burns from the start,
 * the rest strike up as the relay powers the district.
 */
export function createNeonMaterial(u: DressUniforms, map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: u.uTime, uPower: u.uPower, tMap: { value: map } },
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute vec3 aFx;
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec3 vNeon;
      void main() {
        vUv = uv;
        vColor = color;
        vNeon = aFx;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tMap;
      uniform float uTime;
      uniform float uPower;
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec3 vNeon;
      ${HASH_GLSL}
      void main() {
        float mask = texture2D(tMap, vUv).r;
        float seed = vNeon.x;
        float on = vNeon.y <= 0.0001 ? 1.0 : smoothstep(vNeon.y, vNeon.y + 0.06, uPower);
        // striking flutter while the grid comes up, then the odd dropout
        float strike = on * (1.0 - on);
        float buzz = 0.86 + 0.14 * sin(uTime * 37.0 + seed * 40.0);
        float tick = floor(uTime * 11.0);
        float drop = step(0.9 - strike * 2.4, dHash(vec2(tick, seed * 91.0)));
        float flick = buzz * (1.0 - 0.75 * drop);
        // a dead tube section per sign
        float band = floor(vUv.y * 14.0) + floor(vUv.x * 9.0) * 7.0;
        float dead = step(0.84, dHash(vec2(band * 0.37, seed * 17.0)));
        float tube = mask * mask;
        vec3 lit = vColor * vNeon.z * tube * flick * on * (1.0 - dead * 0.92);
        lit += vec3(1.0) * vNeon.z * 0.22 * tube * tube * flick * on * (1.0 - dead);
        vec3 col = vec3(0.012, 0.012, 0.014) + vec3(0.05, 0.048, 0.045) * mask + lit;
        gl_FragColor = vec4(min(col, vec3(24.0)), 1.0);
      }`,
  });
}

/**
 * One draw call for every soft sprite: smoke plumes, steam, dust banks (alpha),
 * flames and glow halos (additive) via premultiplied blending.
 * kind (aAnim.x): 0 smoke, 1 flame, 2 glow.
 */
export function createFxMaterial(u: DressUniforms, noise: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: u.uTime, uPower: u.uPower, uWind: u.uWind, uSunDir: u.uSunDir, tNoise: { value: noise } },
    vertexShader: /* glsl */ `
      attribute vec2 aCorner;
      attribute vec4 aSize;
      attribute vec4 aAnim;
      attribute vec4 aTint;
      attribute vec3 aDrift;
      uniform float uTime;
      uniform float uPower;
      uniform vec3 uWind;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying vec4 vTint;
      varying vec4 vParam;
      varying vec3 vWorld;
      varying float vSunSide;
      void main() {
        float kind = aAnim.x;
        float looping = step(1e-4, dot(aDrift, aDrift));
        float loopT = fract(uTime * aAnim.y * looping + aAnim.z);
        vec3 base = position + aDrift * loopT * looping;
        vec2 flat2 = cameraPosition.xz - base.xz;
        vec2 f = flat2 / max(length(flat2), 1e-3);
        vec3 right = vec3(f.y, 0.0, -f.x);
        vec3 up = vec3(0.0, 1.0, 0.0);
        float yy = aCorner.y;
        if (kind > 1.5) {
          right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          yy = aCorner.y - 0.5;
        }
        float w = mix(aSize.x, aSize.y, aCorner.y);
        vec3 world = base + right * (aCorner.x * w * 0.5) + up * (yy * aSize.z);
        world.xz += uWind.xy * (aSize.w * aCorner.y * aCorner.y * aSize.z);
        float fade = mix(1.0, sin(3.14159265 * loopT), looping);
        // glows: blink (negative w) or relay-power gate (positive w)
        float gate = 1.0;
        if (kind > 1.5) {
          float ph = aAnim.z * 6.2831853;
          if (aAnim.w < -2.5) gate = 0.6 + 0.4 * sin(uTime * 13.0 + ph) * sin(uTime * 7.1 + ph * 2.0);
          else if (aAnim.w < -1.5) { float s = max(sin(uTime * 4.2 + ph), 0.0); gate = s * s * s * s * s * s; }
          else if (aAnim.w < -0.5) gate = 0.03 + 0.97 * smoothstep(-0.15, 0.15, sin(uTime * 3.3 + ph));
          else if (aAnim.w > 0.0001) gate = smoothstep(aAnim.w, aAnim.w + 0.06, uPower);
          gate *= 1.0 - min(aAnim.y, 1.0) * (0.5 + 0.5 * sin(uTime * 19.0 + ph * 3.0)) * 0.35;
        }
        vUv = vec2(aCorner.x, aCorner.y);
        vTint = vec4(aTint.rgb, aTint.a * fade * gate);
        vParam = vec4(kind, aAnim.y, aAnim.z, aAnim.w);
        vWorld = world;
        vSunSide = dot(right, uSunDir);
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tNoise;
      uniform float uTime;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying vec4 vTint;
      varying vec4 vParam;
      varying vec3 vWorld;
      varying float vSunSide;
      ${HAZE_GLSL}
      void main() {
        float kind = vParam.x;
        float seed = vParam.z * 7.31;
        vec4 outCol;
        if (kind > 1.5) {
          vec2 d = vec2(vUv.x, vUv.y * 2.0 - 1.0);
          float r = min(length(d), 1.0);
          float core = exp(-r * r * 14.0);
          float halo = (1.0 - r) * (1.0 - r) * 0.3;
          outCol = vec4(vTint.rgb * vTint.a * (core + halo), 0.0);
        } else if (kind > 0.5) {
          float n1 = texture2D(tNoise, vec2(vUv.x * 0.33 + seed, vUv.y * 0.42 - uTime * 0.55)).r;
          float n2 = texture2D(tNoise, vec2(vUv.x * 0.8 - seed, vUv.y * 0.9 - uTime * 1.05)).g;
          float width = max(0.1, 1.0 - vUv.y * 0.85);
          float shape = 1.0 - abs(vUv.x + (n2 - 0.5) * 0.5 * vUv.y) / width;
          float flame = clamp(shape + (n1 - 0.5) * 1.3, 0.0, 1.0);
          flame *= smoothstep(0.0, 0.07, vUv.y) * (1.0 - smoothstep(0.45, 1.0, vUv.y + (n1 - 0.5) * 0.6));
          flame *= flame;
          vec3 fire = mix(vec3(1.7, 0.24, 0.03), vec3(3.6, 1.9, 0.55), clamp(flame * 1.6 - vUv.y * 0.6, 0.0, 1.0));
          float dist = length(vWorld - cameraPosition);
          outCol = vec4(fire * vTint.rgb * flame * vTint.a * exp(-dist * 0.0007), 0.0);
        } else {
          float scale = max(vParam.w, 0.05);
          float isStatic = 1.0 - step(1e-4, vParam.y);
          vec2 q = vec2(vUv.x * 0.5 * scale + seed, vUv.y * scale * 1.6 - uTime * 0.035);
          float n1 = texture2D(tNoise, q).r;
          float n2 = texture2D(tNoise, q * 2.7 + vec2(seed, -uTime * 0.03)).g;
          float n3 = texture2D(tNoise, q * 6.1 + vec2(-seed, -uTime * 0.05)).r;
          float n = n1 * 0.6 + n2 * 0.28 + n3 * 0.12;
          float edge = 1.0 - abs(vUv.x);
          float body = smoothstep(0.02, 0.72, edge + (n - 0.5) * 1.1);
          float vfade = smoothstep(0.0, 0.07, vUv.y) * (1.0 - smoothstep(0.5, 1.0, vUv.y + (n - 0.5) * 0.45));
          float a = clamp(body * vfade * vTint.a * (0.5 + 0.75 * n), 0.0, 1.0);
          float lit = clamp(0.5 + 0.5 * vUv.x * sign(vSunSide) * min(abs(vSunSide) * 3.0, 1.0) + (n2 - 0.5) * 0.9, 0.0, 1.0);
          lit = lit * lit * (0.45 + 0.55 * vUv.y);
          vec3 smoke = vTint.rgb * (0.55 + 0.9 * n1);
          smoke += vec3(1.0, 0.5, 0.22) * (lit * 0.34 * (0.3 + dot(vTint.rgb, vec3(2.4))));
          // fire under-light at the root of the column
          smoke += vec3(1.5, 0.42, 0.1) * (1.0 - smoothstep(0.0, 0.16, vUv.y)) * n2 * isStatic * 0.6;
          smoke = dressHaze(smoke, vWorld, cameraPosition, uSunDir, 0.85);
          outCol = vec4(smoke * a, a);
        }
        gl_FragColor = clamp(outCol, vec4(0.0), vec4(32.0, 32.0, 32.0, 1.0));
      }`,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
  });
}

/** Crows: flat instanced birds on looping orbits, flap in the vertex shader. */
export function createCrowMaterial(u: DressUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: u.uTime, uSunDir: u.uSunDir },
    vertexShader: /* glsl */ `
      attribute float aWing;
      attribute vec4 aOrbit;
      attribute vec4 aBird;
      uniform float uTime;
      varying vec3 vWorld;
      varying float vShade;
      void main() {
        float dirS = aBird.x < 0.0 ? -1.0 : 1.0;
        float a = aBird.y + uTime * aBird.x;
        float r = aOrbit.w * (1.0 + 0.2 * sin(a * 2.0 + aBird.y * 3.0));
        vec3 c = aOrbit.xyz + vec3(cos(a) * r, sin(a * 1.7 + aBird.y) * 7.0, sin(a) * r * 0.8);
        vec2 fwd = vec2(-sin(a), cos(a) * 0.8) * dirS;
        fwd /= max(length(fwd), 1e-3);
        vec2 rt = vec2(fwd.y, -fwd.x);
        float flap = sin(uTime * aBird.w + aBird.y * 7.0);
        float glide = smoothstep(0.25, 0.7, sin(uTime * 0.31 + aBird.y * 5.0));
        flap = mix(flap, 0.3, glide);
        vec3 lp = position * aBird.z;
        float wy = aWing * flap * abs(lp.x) * 0.95 + lp.x * 0.28 * dirS;
        float span = 1.0 - 0.22 * aWing * abs(flap);
        vec3 world = c + vec3(rt.x * lp.x * span + fwd.x * lp.z, wy + lp.y, rt.y * lp.x * span + fwd.y * lp.z);
        vWorld = world;
        vShade = 0.6 + 0.4 * aWing;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      varying vec3 vWorld;
      varying float vShade;
      ${HAZE_GLSL}
      void main() {
        vec3 col = vec3(0.012, 0.011, 0.013) * vShade;
        col = dressHaze(col, vWorld, cameraPosition, uSunDir, 0.8);
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
}

/** Windblown paper/trash that wraps around the camera inside a fixed box. */
export function createPaperMaterial(u: DressUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: u.uTime, uWind: u.uWind, uSunDir: u.uSunDir },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform vec3 uWind;
      uniform vec3 uSunDir;
      varying vec3 vCol;
      void main() {
        vec2 box = vec2(96.0, 96.0);
        vec2 p0 = aSeed.xz * box + uWind.xy * uTime * (1.2 + aSeed.w * 2.6);
        vec2 rel = mod(p0 - cameraPosition.xz + box * 0.5, box) - box * 0.5;
        float hop = abs(sin(uTime * (0.45 + aSeed.w * 0.8) + aSeed.x * 40.0));
        float gust = 0.5 + 0.5 * sin(uTime * 0.23 + aSeed.z * 20.0);
        vec3 centre = vec3(cameraPosition.x + rel.x, 0.08 + hop * hop * hop * (0.15 + aSeed.y * 1.7) * gust, cameraPosition.z + rel.y);
        float edgeFade = 1.0 - smoothstep(34.0, 47.0, max(abs(rel.x), abs(rel.y)));
        float ang = uTime * (0.8 + aSeed.w * 3.2) * (0.25 + hop) + aSeed.y * 30.0;
        float tilt = ang * 0.7 + aSeed.z * 9.0;
        vec3 ax = vec3(cos(ang), 0.0, sin(ang));
        vec3 ay = vec3(-sin(ang) * sin(tilt), cos(tilt), cos(ang) * sin(tilt));
        float size = (0.7 + aSeed.y * 0.9) * edgeFade;
        vec3 world = centre + (ax * position.x * 0.15 + ay * position.y * 0.105) * size;
        vec3 n = cross(ax, ay);
        float tone = 0.5 + 0.5 * aSeed.z;
        vCol = mix(vec3(0.2, 0.185, 0.16), vec3(0.11, 0.085, 0.06), step(0.6, aSeed.w)) * tone * (0.4 + 0.8 * abs(dot(n, uSunDir)));
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      void main() {
        gl_FragColor = vec4(vCol, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
}
