import * as THREE from 'three';
import { CITY, CITY_HALF } from './CityLayout';

const NOISE_GLSL = /* glsl */ `
float cHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float cNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash21(i), cHash21(i + vec2(1.0, 0.0)), u.x),
             mix(cHash21(i + vec2(0.0, 1.0)), cHash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float cFbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * cNoise(p);
    p = p * 2.03 + 17.7;
    a *= 0.5;
  }
  return s;
}
`;

/** Shared uniform so every city shader can react to the relay powering up. */
export const cityUniforms = {
  uPower: { value: 0 },
  uTime: { value: 0 },
};

/**
 * Procedural skyscraper facade. Windows, broken panes, soot and the few lit
 * rooms are computed from the instance's local position, so one InstancedMesh
 * of unit boxes renders every tower with consistent window scale.
 */
export function createFacadeMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, metalness: 0, envMapIntensity: 1.0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPower = cityUniforms.uPower;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aInfo;
varying vec3 vFacadePos;
varying vec3 vFacadeNormal;
varying vec3 vFacadeScale;
varying vec2 vInfo;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 fScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
#else
vec3 fScale = vec3(1.0);
#endif
vFacadePos = position * fScale;
vFacadeNormal = normal;
vFacadeScale = fScale;
vInfo = aInfo;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uPower;
varying vec3 vFacadePos;
varying vec3 vFacadeNormal;
varying vec3 vFacadeScale;
varying vec2 vInfo;
${NOISE_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
vec3 fN = abs(vFacadeNormal);
float fStyle = vInfo.x;
float fTint = vInfo.y;
float fFaceW = fN.x > 0.5 ? vFacadeScale.z : vFacadeScale.x;
vec2 fUv = fN.x > 0.5 ? vec2(vFacadePos.z, vFacadePos.y) : vec2(vFacadePos.x, vFacadePos.y);
fUv += vec2(fFaceW, vFacadeScale.y) * 0.5;
float fSide = fN.x > 0.5 ? (vFacadeNormal.x > 0.0 ? 1.0 : 2.0) : (vFacadeNormal.z > 0.0 ? 3.0 : 4.0);

vec3 fWall = mix(vec3(0.30, 0.285, 0.27), vec3(0.47, 0.42, 0.36), fTint);
float fPal = fract(fTint * 3.71);
if (fPal > 0.72) fWall = vec3(0.17, 0.175, 0.19);
else if (fPal > 0.5) fWall = mix(fWall, vec3(0.36, 0.25, 0.20), 0.55);

vec2 fCell = vec2(3.0, 3.6);
vec2 fMargin = vec2(0.56, 0.52);
if (fStyle > 2.5) { fCell = vec2(6.4, 5.4); fMargin = vec2(0.82, 0.70); }
else if (fStyle > 1.5) { fCell = vec2(5.0, 3.6); fMargin = vec2(0.965, 0.46); }
else if (fStyle > 0.5) { fCell = vec2(1.9, 3.6); fMargin = vec2(0.86, 0.84); fWall *= 0.7; }

float fNx = max(1.0, floor(fFaceW / fCell.x));
vec2 fG = vec2(fUv.x / (fFaceW / fNx), fUv.y / fCell.y);
vec2 fId = floor(fG);
vec2 fF = fract(fG);
vec2 fD = abs(fF - 0.5) * 2.0;
vec2 fAa = fwidth(fG) * 2.0 + 0.002;
float fWin = (1.0 - smoothstep(fMargin.x - fAa.x, fMargin.x + fAa.x, fD.x))
           * (1.0 - smoothstep(fMargin.y - fAa.y, fMargin.y + fAa.y, fD.y));
float fLod = clamp(1.0 - max(fAa.x, fAa.y) * 0.55, 0.0, 1.0);
fWin = mix(fMargin.x * fMargin.y * 0.8, fWin, fLod);

float fH = cHash21(fId + vec2(fTint * 91.7, fSide * 13.1));
float fH2 = cHash21(fId * 1.7 + vec2(fSide * 5.3, fTint * 37.0));
float fSoot = smoothstep(0.42, 0.72, cFbm(fUv * 0.035 + fTint * 40.0 + fSide * 9.0));
float fHeight01 = clamp(fUv.y / max(vFacadeScale.y, 1.0), 0.0, 1.0);

// wall weathering
float fStreak = cNoise(vec2(fUv.x * 1.3 + fSide * 7.0, fUv.y * 0.07));
float fGrain = cNoise(fUv * 2.6) * 0.5 + cNoise(fUv * 11.0) * 0.5;
vec3 fAlbedo = fWall * (0.72 + 0.4 * fGrain);
fAlbedo *= mix(1.0, 0.55, smoothstep(0.45, 0.9, fStreak) * 0.8);
fAlbedo *= mix(1.0, 0.38, fSoot);
// floor slab lines and sill stains
float fSlab = smoothstep(0.93, 0.985, fD.y) * fLod;
fAlbedo *= 1.0 - 0.45 * fSlab;
float fStain = (1.0 - fWin) * smoothstep(0.0, 0.5, 0.5 - fF.y) * step(fD.x, fMargin.x) * fH2 * fLod;
fAlbedo *= 1.0 - 0.4 * fStain;
// ash banked against the first metres, sun-bleached crowns
fAlbedo = mix(fAlbedo, vec3(0.36, 0.33, 0.29), (1.0 - smoothstep(0.0, 5.5, fUv.y + fGrain * 2.5)) * 0.65);
fAlbedo *= 0.85 + 0.3 * fHeight01;
float fRough = 0.86 + 0.1 * fGrain;
float fMetal = 0.0;
vec3 fEmis = vec3(0.0);

// window states
float fBrokenBias = 0.34 + 0.4 * fSoot;
vec3 fGlassCol = mix(vec3(0.20, 0.25, 0.30), vec3(0.34, 0.30, 0.26), fH2);
vec3 fWinCol = fGlassCol;
float fWinRough = 0.13 + 0.25 * fH2 * fH2;
float fWinMetal = 0.82;
if (fH < fBrokenBias) {
  // blown-out opening: dark interior with a hint of depth
  fWinCol = vec3(0.012, 0.011, 0.01) + 0.03 * vec3(fF.y * fH2);
  fWinRough = 1.0;
  fWinMetal = 0.0;
} else if (fH < fBrokenBias + 0.09) {
  // boarded up
  fWinCol = vec3(0.16, 0.11, 0.07) * (0.6 + 0.5 * cNoise(fUv * vec2(9.0, 1.5)));
  fWinRough = 0.92;
  fWinMetal = 0.0;
}
float fLitChance = 0.012 + 0.05 * uPower * (1.0 - fHeight01);
if (fH > 1.0 - fLitChance) {
  float fFlicker = 0.75 + 0.25 * sin(fH2 * 60.0);
  vec3 fLamp = mix(vec3(1.0, 0.56, 0.22), vec3(0.45, 0.95, 0.9), step(0.985, fH) * uPower);
  fEmis = fLamp * 3.2 * fFlicker * fWin * (0.4 + 0.6 * fF.y);
  fWinCol = vec3(0.05);
  fWinRough = 0.5;
  fWinMetal = 0.0;
}
fAlbedo = mix(fAlbedo, fWinCol, fWin);
fRough = mix(fRough, fWinRough, fWin);
fMetal = mix(fMetal, fWinMetal, fWin);

// roofs: gravel and tar
if (fN.y > 0.5) {
  float fRoofN = cNoise(vFacadePos.xz * 0.9) * 0.6 + cNoise(vFacadePos.xz * 6.0) * 0.4;
  fAlbedo = vec3(0.09, 0.085, 0.08) * (0.7 + 0.7 * fRoofN);
  fRough = 0.96;
  fMetal = 0.0;
  fEmis = vec3(0.0);
}
diffuseColor.rgb = fAlbedo;
`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = fRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = fMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += fEmis;');
  };
  material.customProgramCacheKey = () => 'ashen-facade';
  return material;
}

export type GroundMode = 'road' | 'paving' | 'concrete';

/**
 * World-space procedural surfaces: cracked asphalt with worn markings and
 * puddles, block paving, and stained structural concrete.
 */
export function createGroundMaterial(mode: GroundMode, relay?: { x: number; z: number }): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.9,
    metalness: 0,
    envMapIntensity: mode === 'road' ? 1.25 : 0.8,
  });
  const modeIndex = mode === 'road' ? 0 : mode === 'paving' ? 1 : 2;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCity = { value: new THREE.Vector3(CITY_HALF, CITY.pitch, CITY.roadWidth) };
    shader.uniforms.uRelay = { value: new THREE.Vector2(relay?.x ?? 0, relay?.z ?? 0) };
    shader.uniforms.uPower = cityUniforms.uPower;
    shader.uniforms.uTime = cityUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;\nvarying vec3 vGroundNormal;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 gPos = vec4(transformed, 1.0);
vec3 gNrm = normal;
#ifdef USE_INSTANCING
gPos = instanceMatrix * gPos;
gNrm = mat3(instanceMatrix) * gNrm;
#endif
vGroundPos = (modelMatrix * gPos).xyz;
vGroundNormal = normalize(mat3(modelMatrix) * gNrm);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
#define GROUND_MODE ${modeIndex}
uniform vec3 uCity;
uniform vec2 uRelay;
uniform float uPower;
uniform float uTime;
varying vec3 vGroundPos;
varying vec3 vGroundNormal;
${NOISE_GLSL}
float gLine(float v, float center, float halfWidth, float aa) {
  return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(v - center));
}`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
vec2 gP = vGroundPos.xz;
vec3 gAlbedo = vec3(0.05);
float gRough = 0.9;
vec3 gEmis = vec3(0.0);
float gAa = max(fwidth(gP.x), fwidth(gP.y)) + 0.001;
#if GROUND_MODE == 0
{
  float gHalf = uCity.x;
  float gPitch = uCity.y;
  float gRoadHalf = uCity.z * 0.5;
  vec2 gLocal = mod(gP + gHalf, gPitch);
  vec2 gFrom = min(gLocal, gPitch - gLocal);
  vec2 gSigned = gLocal - gPitch * step(gPitch * 0.5, gLocal);
  bool gInCity = max(abs(gP.x), abs(gP.y)) < gHalf + gRoadHalf;
  float gCoarse = cFbm(gP * 0.045);
  float gMid = cNoise(gP * 0.6);
  float gFine = cNoise(gP * 7.0) * 0.6 + cNoise(gP * 23.0) * 0.4;
  gAlbedo = vec3(0.042, 0.041, 0.043) * (0.65 + 0.5 * gMid + 0.5 * gFine);
  // tar repair patches
  vec2 gPatchId = floor(gP / vec2(5.5, 8.0));
  float gPatch = step(0.8, cHash21(gPatchId)) * step(abs(fract(gP.x / 5.5) - 0.5), 0.36) * step(abs(fract(gP.y / 8.0) - 0.5), 0.4);
  gAlbedo *= 1.0 - 0.38 * gPatch;
  // crack network
  float gCrackField = abs(cNoise(gP * 0.33 + 4.0) - 0.5) + 0.35 * abs(cNoise(gP * 1.3) - 0.5);
  float gCrack = 1.0 - smoothstep(0.004, 0.022 + gAa * 0.2, gCrackField);
  gAlbedo *= 1.0 - 0.75 * gCrack;
  gRough = 0.78 + 0.18 * gFine;
  if (gInCity) {
    bool gOnNS = gFrom.x < gRoadHalf;
    bool gOnEW = gFrom.y < gRoadHalf;
    float gWear = smoothstep(0.3, 0.62, cFbm(gP * 0.21 + 9.0));
    float gPaint = 0.0;
    vec3 gPaintCol = vec3(0.62, 0.6, 0.55);
    if (gOnNS && !gOnEW) {
      float gAlong = gFrom.y - gRoadHalf;
      float gX = gSigned.x;
      float gMask = smoothstep(3.0, 5.0, gAlong);
      float gCentre = gLine(abs(gX), 0.24, 0.08, gAa);
      float gDash = gLine(abs(gX), 6.3, 0.09, gAa) * step(fract(gP.y / 9.0), 0.42);
      float gEdge = gLine(abs(gX), 12.1, 0.08, gAa);
      gPaint = max(gCentre, max(gDash, gEdge)) * gMask;
      if (gCentre > 0.5) gPaintCol = vec3(0.68, 0.5, 0.12);
      float gWalk = step(1.4, gAlong) * step(gAlong, 4.6) * step(fract(gX / 1.3), 0.5) * step(abs(gX), 11.4);
      gPaint = max(gPaint, gWalk);
    } else if (gOnEW && !gOnNS) {
      float gAlong = gFrom.x - gRoadHalf;
      float gZ = gSigned.y;
      float gMask = smoothstep(3.0, 5.0, gAlong);
      float gCentre = gLine(abs(gZ), 0.24, 0.08, gAa);
      float gDash = gLine(abs(gZ), 6.3, 0.09, gAa) * step(fract(gP.x / 9.0), 0.42);
      float gEdge = gLine(abs(gZ), 12.1, 0.08, gAa);
      gPaint = max(gCentre, max(gDash, gEdge)) * gMask;
      if (gCentre > 0.5) gPaintCol = vec3(0.68, 0.5, 0.12);
      float gWalk = step(1.4, gAlong) * step(gAlong, 4.6) * step(fract(gZ / 1.3), 0.5) * step(abs(gZ), 11.4);
      gPaint = max(gPaint, gWalk);
    }
    gPaint *= (1.0 - gWear) * (0.55 + 0.45 * gFine) * clamp(1.6 - gAa * 3.0, 0.0, 1.0);
    gAlbedo = mix(gAlbedo, gPaintCol * (0.7 + 0.3 * gFine), gPaint * 0.85);
    // ash drifts along kerbs and in wind-shadowed lanes
    float gKerb = min(gOnNS ? gRoadHalf - gFrom.x : 99.0, gOnEW ? gRoadHalf - gFrom.y : 99.0);
    float gDrift = (1.0 - smoothstep(0.0, 3.4, gKerb + (gCoarse - 0.5) * 4.0)) * 0.85;
    gDrift = max(gDrift, smoothstep(0.6, 0.75, cFbm(gP * 0.035 + 31.0)) * 0.7);
    vec3 gAsh = vec3(0.30, 0.255, 0.20) * (0.75 + 0.4 * gFine);
    gAlbedo = mix(gAlbedo, gAsh, gDrift);
    gRough = mix(gRough, 0.97, gDrift);
    // standing water from the last ash-rain
    float gPuddle = smoothstep(0.585, 0.63, cFbm(gP * 0.075 + 3.3)) * (1.0 - gDrift);
    gAlbedo *= 1.0 - 0.55 * gPuddle;
    gRough = mix(gRough, 0.035, gPuddle);
    // damp halo
    gRough = mix(gRough, 0.42, smoothstep(0.5, 0.6, cFbm(gP * 0.075 + 3.3)) * (1.0 - gDrift) * 0.7);
  } else {
    float gDune = cFbm(gP * 0.012);
    gAlbedo = mix(vec3(0.17, 0.145, 0.12), vec3(0.3, 0.25, 0.19), gDune) * (0.8 + 0.3 * gFine);
    gRough = 0.97;
  }
}
#elif GROUND_MODE == 1
{
  float gFine = cNoise(gP * 9.0);
  float gMid = cNoise(gP * 0.5);
  vec2 gTile = gP / 1.6;
  vec2 gTf = abs(fract(gTile) - 0.5);
  float gJoint = smoothstep(0.46 - gAa, 0.49, max(gTf.x, gTf.y)) * clamp(1.5 - gAa * 4.0, 0.0, 1.0);
  float gTileTone = cHash21(floor(gTile));
  gAlbedo = vec3(0.21, 0.2, 0.19) * (0.7 + 0.25 * gTileTone + 0.25 * gFine) * (0.8 + 0.3 * gMid);
  gAlbedo *= 1.0 - 0.5 * gJoint;
  float gMissing = step(0.94, gTileTone);
  gAlbedo = mix(gAlbedo, vec3(0.08, 0.07, 0.06), gMissing * 0.8);
  float gCrackField = abs(cNoise(gP * 0.4 + 14.0) - 0.5);
  gAlbedo *= 1.0 - 0.6 * (1.0 - smoothstep(0.004, 0.02, gCrackField));
  float gDrift = smoothstep(0.5, 0.7, cFbm(gP * 0.05 + 11.0));
  gAlbedo = mix(gAlbedo, vec3(0.3, 0.26, 0.21) * (0.8 + 0.3 * gFine), gDrift * 0.75);
  gRough = 0.88 + 0.1 * gFine;
  if (vGroundNormal.y < 0.5) {
    // kerb face
    gAlbedo = vec3(0.26, 0.25, 0.23) * (0.7 + 0.4 * gFine);
  }
  // relay plaza inlay
  float gR = length(gP - uRelay);
  if (gR < 46.0) {
    float gRing = gLine(gR, 9.0, 0.35, gAa) + gLine(gR, 20.0, 0.22, gAa) + gLine(gR, 36.0, 0.5, gAa);
    float gAng = atan(gP.y - uRelay.y, gP.x - uRelay.x);
    float gSpoke = step(abs(fract(gAng / 6.2831853 * 12.0) - 0.5), 0.012 + 0.2 / max(gR, 1.0)) * step(9.0, gR) * step(gR, 36.0);
    float gHaz = step(34.0, gR) * step(gR, 38.0) * step(fract(gAng / 6.2831853 * 90.0), 0.5) * 0.0;
    float gInlay = clamp(gRing + gSpoke + gHaz, 0.0, 1.0);
    gAlbedo = mix(gAlbedo * (0.75 + 0.25 * step(20.0, gR)), vec3(0.42, 0.36, 0.26), gInlay * 0.7);
    float gPulse = 0.55 + 0.45 * sin(uTime * 2.2 - gR * 0.28);
    gEmis = vec3(0.12, 0.95, 0.82) * gInlay * uPower * (0.5 + 1.6 * gPulse);
  }
}
#else
{
  vec2 gQ = abs(vGroundNormal.y) > 0.5 ? gP : (abs(vGroundNormal.x) > 0.5 ? vGroundPos.zy : vGroundPos.xy);
  float gFine = cNoise(gQ * 6.0) * 0.6 + cNoise(gQ * 21.0) * 0.4;
  float gStreak = cNoise(vec2(gQ.x * 0.9, gQ.y * 0.06 + 3.0));
  float gForm = smoothstep(0.47, 0.5, abs(fract(gQ.y / 1.25) - 0.5)) * clamp(1.4 - gAa * 5.0, 0.0, 1.0);
  gAlbedo = vec3(0.25, 0.235, 0.215) * (0.62 + 0.5 * gFine);
  gAlbedo *= mix(1.0, 0.5, smoothstep(0.5, 0.9, gStreak));
  gAlbedo *= 1.0 - 0.3 * gForm;
  gAlbedo *= mix(1.0, 0.5, smoothstep(0.45, 0.75, cFbm(gQ * 0.06 + 8.0)));
  gAlbedo *= diffuseColor.rgb;
  gRough = 0.9;
}
#endif
diffuseColor.rgb = gAlbedo;
`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gRough;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmis;');
  };
  material.customProgramCacheKey = () => `ashen-ground-${modeIndex}`;
  return material;
}
