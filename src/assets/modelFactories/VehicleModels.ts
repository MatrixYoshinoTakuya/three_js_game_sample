import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { VehicleModel } from '../../game/contracts';

/**
 * ASHEN SKYLINE vehicle kit.
 *
 * Bodies are lofted from cross-section ribs (custom BufferGeometry with
 * crease-aware smooth normals); everything bolted on is authored from tubes,
 * plates, lathes and extrusions, then merged BY MATERIAL into a handful of
 * meshes. Static geometry is built once per vehicle type (blueprint cache)
 * and shared by all instances; only the materials the game mutates (paint,
 * head/tail lights, accent) are per-instance. Textures (6 in total, all
 * procedural, <= 1024 px) are generated lazily once and shared.
 *
 * Conventions: metres, Y up, origin on the ground under the vehicle centre,
 * forward = +Z, left = +X. Sockets (muzzles, exhausts) have local +Z pointing
 * out of the barrel / pipe.
 */

// ---------------------------------------------------------------- small utils

type V3 = THREE.Vector3;
type T3 = readonly [number, number, number];
type P2 = readonly [number, number];
type Xf = { p?: T3; r?: T3; s?: T3 | number };
/** Surface look: sRGB colour, roughness, metalness, per-part value jitter. */
type Look = { c: number; r: number; m: number; j: number };

const v = (x: number, y: number, z: number): V3 => new THREE.Vector3(x, y, z);
const look = (c: number, r: number, m: number, j = 0): Look => ({ c, r, m, j });
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const sm = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 0..1 hash of a position (welded corners get the same value). */
const hash3 = (x: number, y: number, z: number, seed = 0): number => {
  const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.1) * 43758.5453;
  return h - Math.floor(h);
};

/** Piecewise-linear 1D curve through (x, y) keys. */
function lin(keys: readonly P2[]): (x: number) => number {
  return (x) => {
    if (x <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (x <= keys[i][0]) return lerp(keys[i - 1][1], keys[i][1], (x - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]));
    }
    return keys[keys.length - 1][1];
  };
}

/** Smooth (Catmull-Rom style Hermite) 1D curve through (x, y) keys. */
function curve1(keys: readonly P2[]): (x: number) => number {
  const n = keys.length;
  const tan: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = keys[Math.max(0, i - 1)];
    const b = keys[Math.min(n - 1, i + 1)];
    tan.push((b[1] - a[1]) / (b[0] - a[0]));
  }
  return (x) => {
    if (x <= keys[0][0]) return keys[0][1];
    if (x >= keys[n - 1][0]) return keys[n - 1][1];
    let i = 1;
    while (x > keys[i][0]) i++;
    const h = keys[i][0] - keys[i - 1][0];
    const t = (x - keys[i - 1][0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * keys[i - 1][1] +
      (t3 - 2 * t2 + t) * h * tan[i - 1] +
      (-2 * t3 + 3 * t2) * keys[i][1] +
      (t3 - t2) * h * tan[i]
    );
  };
}

const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

function xfMatrix(xf: Xf): THREE.Matrix4 {
  const p = xf.p ?? [0, 0, 0];
  const r = xf.r ?? [0, 0, 0];
  const s = xf.s === undefined ? [1, 1, 1] : typeof xf.s === 'number' ? [xf.s, xf.s, xf.s] : xf.s;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(p[0], p[1], p[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2])),
    new THREE.Vector3(s[0], s[1], s[2]),
  );
}

function posAttr(geo: THREE.BufferGeometry): THREE.BufferAttribute {
  return geo.getAttribute('position') as THREE.BufferAttribute;
}

function triangleCount(geo: THREE.BufferGeometry): number {
  return (geo.index ? geo.index.count : posAttr(geo).count) / 3;
}

// ---------------------------------------------------------------- real-GPU safety

type SanitizeEntry = { label: string; triangles: number; droppedTriangles: number; fixedNormals: number };
const sanitizeLog: SanitizeEntry[] = [];

/**
 * Drops degenerate / non-finite triangles and repairs any normal that is NaN
 * or shorter than 0.5 (replaced by the face normal). A zero-length normal
 * turns into NaN after normalize() on real GPUs and poisons the HDR chain.
 */
function sanitize(geoIn: THREE.BufferGeometry, label: string): THREE.BufferGeometry {
  const g = geoIn.index ? geoIn.toNonIndexed() : geoIn;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const pos = posAttr(g);
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const pa = pos.array as Float32Array;
  const na = nor.array as Float32Array;
  const count = pos.count - (pos.count % 3);
  const keep: number[] = [];
  let dropped = 0;
  let fixed = 0;
  for (let t = 0; t < count; t += 3) {
    const o = t * 3;
    let finite = true;
    for (let k = 0; k < 9; k++) if (!Number.isFinite(pa[o + k])) finite = false;
    const ux = pa[o + 3] - pa[o];
    const uy = pa[o + 4] - pa[o + 1];
    const uz = pa[o + 5] - pa[o + 2];
    const wx = pa[o + 6] - pa[o];
    const wy = pa[o + 7] - pa[o + 1];
    const wz = pa[o + 8] - pa[o + 2];
    let fx = uy * wz - uz * wy;
    let fy = uz * wx - ux * wz;
    let fz = ux * wy - uy * wx;
    const fl = Math.hypot(fx, fy, fz);
    if (!finite || !(fl > 1e-8)) {
      dropped++;
      continue;
    }
    fx /= fl;
    fy /= fl;
    fz /= fl;
    for (let k = 0; k < 3; k++) {
      const i = o + k * 3;
      const l = Math.hypot(na[i], na[i + 1], na[i + 2]);
      if (!(l > 0.5)) {
        na[i] = fx;
        na[i + 1] = fy;
        na[i + 2] = fz;
        fixed++;
      } else if (Math.abs(l - 1) > 1e-4) {
        na[i] /= l;
        na[i + 1] /= l;
        na[i + 2] /= l;
      }
    }
    keep.push(t);
  }
  if (dropped > 0 || count !== pos.count) {
    for (const name of Object.keys(g.attributes)) {
      const attr = g.getAttribute(name) as THREE.BufferAttribute;
      const size = attr.itemSize;
      const src = attr.array as Float32Array;
      const dst = new Float32Array(keep.length * 3 * size);
      keep.forEach((t, n) => {
        for (let k = 0; k < 3 * size; k++) dst[n * 3 * size + k] = src[t * size + k];
      });
      g.setAttribute(name, new THREE.BufferAttribute(dst, size));
    }
  }
  sanitizeLog.push({ label, triangles: keep.length, droppedTriangles: dropped, fixedNormals: fixed });
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------- palette

const C = {
  gunmetal: 0x343a41,
  gunmetalDark: 0x1b1d20,
  orange: 0xc2541a,
  orangeWorn: 0x8d4a22,
  steel: 0x4b4f54,
  steelDark: 0x26282b,
  chrome: 0xa9acb0,
  alloy: 0x7d8186,
  rust: 0x6e3b21,
  rustDark: 0x41251a,
  rubber: 0x0e0e10,
  tread: 0x262019,
  black: 0x09090a,
  bone: 0xd3c8a8,
  boneDirty: 0xa99a78,
  raiderRed: 0x8c2616,
  raiderRedDark: 0x5a1b12,
  olive: 0x4a4a2c,
  hazard: 0xc9952a,
  cloth: 0x3a2d22,
  rigIron: 0x2f2b29,
  rigIronLight: 0x453c36,
  rigOxide: 0x57291b,
  dust: 0x94704c,
  mud: 0x4d3a28,
  soot: 0x0d0b0a,
} as const;

const L = {
  steel: look(C.steel, 0.48, 0.85, 0.08),
  steelDark: look(C.steelDark, 0.55, 0.8, 0.08),
  chrome: look(C.chrome, 0.2, 1, 0.03),
  alloy: look(C.alloy, 0.36, 0.9, 0.05),
  rust: look(C.rust, 0.85, 0.35, 0.14),
  rustDark: look(C.rustDark, 0.8, 0.45, 0.14),
  rubber: look(C.rubber, 0.92, 0, 0),
  tread: look(C.tread, 0.96, 0, 0.1),
  matte: look(C.black, 0.9, 0.05, 0),
  blackMetal: look(0x141517, 0.5, 0.7, 0.05),
  bone: look(C.bone, 0.75, 0, 0.06),
  cloth: look(C.cloth, 0.95, 0, 0.08),
  olive: look(C.olive, 0.7, 0.2, 0.05),
  canRed: look(0x7c2a16, 0.65, 0.25, 0.05),
  frame: look(0x352720, 0.7, 0.6, 0.1),
  lens: look(0xffffff, 0.3, 0, 0),
  lensOff: look(0x2b2b2b, 0.3, 0, 0),
  weld: look(0x4c4a52, 0.42, 0.9, 0.12),
  leather: look(0x1c1612, 0.8, 0, 0.08),
  hazard: look(C.hazard, 0.7, 0.2, 0.1),
  mud: look(C.mud, 1, 0, 0.12),
} as const;

/** Look for buckets whose material ignores the PBR palette (paint, lights). */
const paint = (c: number, j = 0.05): Look => look(c, 0.5, 0.5, j);

// ---------------------------------------------------------------- procedural textures (6 total, shared)

let textureCount = 0;

function dataTexture(data: Uint8Array, w: number, h: number, srgb: boolean, repeat: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  textureCount++;
  return tex;
}

/** Tileable value-noise fbm, S x S, normalised to 0..1. */
function fbmField(S: number, octaves: readonly P2[], seed: number): Float32Array {
  const rand = rng(seed);
  const field = new Float32Array(S * S);
  let total = 0;
  for (const [period, amp] of octaves) {
    total += amp;
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    for (let y = 0; y < S; y++) {
      const fy = (y / S) * period;
      const y0 = Math.floor(fy);
      const ty = sm(0, 1, fy - y0);
      for (let x = 0; x < S; x++) {
        const fx = (x / S) * period;
        const x0 = Math.floor(fx);
        const tx = sm(0, 1, fx - x0);
        const a = lattice[(y0 % period) * period + (x0 % period)];
        const b = lattice[(y0 % period) * period + ((x0 + 1) % period)];
        const c = lattice[((y0 + 1) % period) * period + (x0 % period)];
        const d = lattice[((y0 + 1) % period) * period + ((x0 + 1) % period)];
        field[y * S + x] += amp * lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
      }
    }
  }
  for (let i = 0; i < field.length; i++) field[i] /= total;
  return field;
}

/** Bilinear wrapped lookup into an S x S field (coordinates in texels). */
function fieldAt(f: Float32Array, S: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const xa = ((x0 % S) + S) % S;
  const ya = ((y0 % S) + S) % S;
  const xb = (xa + 1) % S;
  const yb = (ya + 1) % S;
  return lerp(lerp(f[ya * S + xa], f[ya * S + xb], tx), lerp(f[yb * S + xa], f[yb * S + xb], tx), ty);
}

/** Height field -> tangent-space normal map bytes. */
function heightToNormal(h: Float32Array, W: number, H: number, strength: number, wrap: boolean): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  const at = (x: number, y: number): number => {
    const xi = wrap ? (x + W) % W : Math.min(W - 1, Math.max(0, x));
    const yi = wrap ? (y + H) % H : Math.min(H - 1, Math.max(0, y));
    return h[yi * W + xi];
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * W + x) * 4;
      out[i] = Math.round((-dx / l) * 127.5 + 127.5);
      out[i + 1] = Math.round((-dy / l) * 127.5 + 127.5);
      out[i + 2] = Math.round((1 / l) * 127.5 + 127.5);
      out[i + 3] = 255;
    }
  }
  return out;
}

let paletteTex: THREE.DataTexture | null = null;
let wearTex: THREE.DataTexture | null = null;
let wearNormalTex: THREE.DataTexture | null = null;
let kitMat: THREE.MeshStandardMaterial | null = null;
let glassMat: THREE.MeshPhysicalMaterial | null = null;

/** 16x16 lookup: uv.x = roughness (G), uv.y = metalness (B). Lets one material carry many surface roles. */
function pbrPalette(): THREE.DataTexture {
  if (paletteTex) return paletteTex;
  const n = 16;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      data[i] = 255;
      data[i + 1] = Math.round(((x + 0.5) / n) * 255);
      data[i + 2] = Math.round(((y + 0.5) / n) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  textureCount++;
  paletteTex = tex;
  return tex;
}

/**
 * 512px tileable wear set for raider / rig paint (linear data):
 * R = scrape field (bare metal revealed by damage), G = grime (albedo multiplier + roughness),
 * B = metalness multiplier, A = scorch field. A matching hammered-plate normal map is built alongside.
 */
function wearTextures(): { wear: THREE.DataTexture; normal: THREE.DataTexture } {
  if (wearTex && wearNormalTex) return { wear: wearTex, normal: wearNormalTex };
  const S = 512;
  const rand = rng(90210);
  const broad = fbmField(S, [[4, 0.5], [9, 0.3], [20, 0.2]], 11);
  const fine = fbmField(S, [[24, 0.45], [56, 0.35], [128, 0.2]], 12);
  const streak = fbmField(S, [[6, 0.5], [14, 0.3], [40, 0.2]], 13);
  const grime = new Float32Array(S * S);
  const scrape = new Float32Array(S * S);
  const scorch = new Float32Array(S * S);
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const b = broad[i];
      const f = fine[i];
      grime[i] = 0.62 + 0.38 * sm(0.2, 0.8, 0.65 * b + 0.35 * f);
      // long streaky ridges: scrapes run along the travel direction
      const s = fieldAt(streak, S, x * 0.35, y * 2.2);
      const ridge = 1 - Math.abs(2 * s - 1);
      scrape[i] = clamp01(Math.pow(ridge, 5) * 0.8 + 0.3 * f + 0.12 * (1 - b));
      scorch[i] = clamp01(sm(0.25, 0.75, fieldAt(broad, S, x * 0.5 + 131, y * 0.5 + 57)) * 0.8 + 0.2 * f);
      // hammered plate: broad dents plus pitting
      height[i] = 0.9 * b + 0.25 * f - 0.5 * sm(0.72, 0.9, f);
    }
  }
  const stroke = (val: number, hgt: number, k: number): void => {
    let x = rand() * S;
    let y = rand() * S;
    const ang = (rand() - 0.5) * 0.7 + (rand() < 0.2 ? Math.PI / 2 : 0);
    const len = 14 + rand() * 110;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    for (let t = 0; t < len; t++) {
      const xi = ((Math.floor(x) % S) + S) % S;
      const yi = ((Math.floor(y) % S) + S) % S;
      const i = yi * S + xi;
      grime[i] = lerp(grime[i], val, k);
      scrape[i] = Math.max(scrape[i], val > 0.8 ? 0.85 : scrape[i]);
      height[i] += hgt;
      x += dx;
      y += dy;
    }
  };
  for (let k = 0; k < 260; k++) stroke(rand() < 0.6 ? 1 : 0.45, -0.35, 0.7);
  for (let k = 0; k < 2400; k++) {
    const i = Math.floor(rand() * S * S);
    grime[i] *= 0.65 + rand() * 0.25;
    height[i] -= 0.3;
  }
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = Math.round(clamp01(scrape[i]) * 255);
    data[i * 4 + 1] = Math.round(clamp01(grime[i]) * 255);
    data[i * 4 + 2] = Math.round(clamp01(0.75 + 0.25 * grime[i]) * 255);
    data[i * 4 + 3] = Math.round(clamp01(scorch[i]) * 255);
  }
  wearTex = dataTexture(data, S, S, false, true);
  wearNormalTex = dataTexture(heightToNormal(height, S, S, 2.2, true), S, S, false, true);
  return { wear: wearTex, normal: wearNormalTex };
}

// ---------------------------------------------------------------- materials

const KIT_NOISE_GLSL = /* glsl */ `
varying vec3 vKitPos;
float kitHash( vec3 p ) {
  p = fract( p * 0.3183099 + vec3( 0.1, 0.2, 0.3 ) );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float kitNoise( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( kitHash( i ), kitHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ), mix( kitHash( i + vec3( 0.0, 1.0, 0.0 ) ), kitHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
    mix( mix( kitHash( i + vec3( 0.0, 0.0, 1.0 ) ), kitHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ), mix( kitHash( i + vec3( 0.0, 1.0, 1.0 ) ), kitHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ),
    f.z );
}
`;

/** Shared vertex-coloured "everything else" material: steel, rubber, rust, cloth via the PBR palette + object-space grime noise. */
function kitMaterial(): THREE.MeshStandardMaterial {
  if (!kitMat) {
    const mat = new THREE.MeshStandardMaterial({
      name: 'vehicleKit',
      color: 0xffffff,
      vertexColors: true,
      roughness: 1,
      metalness: 1,
      roughnessMap: pbrPalette(),
      metalnessMap: pbrPalette(),
    });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vKitPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvKitPos = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${KIT_NOISE_GLSL}`)
        .replace(
          '#include <metalnessmap_fragment>',
          /* glsl */ `#include <metalnessmap_fragment>
          {
            float kitN = 0.6 * kitNoise( vKitPos * 9.0 ) + 0.4 * kitNoise( vKitPos * 37.0 );
            diffuseColor.rgb *= 0.74 + 0.5 * kitN;
            roughnessFactor = clamp( roughnessFactor + ( kitN - 0.5 ) * 0.42, 0.05, 1.0 );
          }`,
        );
    };
    mat.customProgramCacheKey = () => 'vehicleKit-noise-v2';
    kitMat = mat;
  }
  return kitMat;
}

/** Semi-transparent tinted glass: the dark interior reads through it, reflections stay strong. */
function glassMaterial(): THREE.MeshPhysicalMaterial {
  if (!glassMat) {
    glassMat = new THREE.MeshPhysicalMaterial({
      name: 'tintedGlass',
      color: 0x0b1216,
      roughness: 0.06,
      metalness: 0,
      transmission: 0,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      envMapIntensity: 3.2,
      specularIntensity: 1,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
    });
  }
  return glassMat;
}

type DamageUniform = { value: number };

const DAMAGE_GLSL = /* glsl */ `
float vmCoat = 1.0;
#if defined( USE_MAP ) && defined( USE_ROUGHNESSMAP )
{
  // dusty / rusty (rough) areas carry no lacquer
  vmCoat = 1.0 - smoothstep( 0.5, 0.82, roughnessFactor );
  float vmD = clamp( uDamage, 0.0, 1.0 );
  float vmScrapeEdge = 1.0 - vmD * 0.6;
  float vmScrape = smoothstep( vmScrapeEdge, vmScrapeEdge + 0.07, texelRoughness.r ) * step( 0.01, vmD );
  float vmScorchEdge = 1.0 - vmD * 0.95;
  float vmScorch = smoothstep( vmScorchEdge, vmScorchEdge + 0.3, sampledDiffuseColor.a ) * min( 1.0, vmD * 1.8 );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.42, 0.4, 0.38 ), vmScrape );
  metalnessFactor = mix( metalnessFactor, 0.95, vmScrape );
  roughnessFactor = mix( roughnessFactor, 0.4, vmScrape );
  float vmSoot = vmScorch * ( 1.0 - 0.45 * vmScrape );
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.13, 0.105, 0.09 ), vmSoot );
  roughnessFactor = mix( roughnessFactor, 0.96, vmSoot );
  metalnessFactor *= 1.0 - 0.7 * vmSoot;
  vmCoat *= ( 1.0 - vmSoot ) * ( 1.0 - 0.6 * vmScrape );
}
#endif
`;

const WEAR_MAP_GLSL = /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  diffuseColor.rgb *= vec3( sampledDiffuseColor.g );
#endif
`;

/**
 * Adds progressive battle damage to a paint material: `uDamage` reveals
 * bare-metal scrapes (map R of the roughness map) and soot (albedo alpha).
 * `packedWear` = the albedo map is the shared linear wear texture (G = grime).
 */
function addDamageShader(mat: THREE.MeshStandardMaterial, packedWear: boolean): DamageUniform {
  const damage: DamageUniform = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDamage = damage;
    let fs = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uDamage;');
    if (packedWear) fs = fs.replace('#include <map_fragment>', WEAR_MAP_GLSL);
    fs = fs.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${DAMAGE_GLSL}`);
    fs = fs.replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n  material.clearcoat *= vmCoat;\n#endif');
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => (packedWear ? 'vehiclePaint-wear-v2' : 'vehiclePaint-hero-v2');
  return damage;
}

/** Vertex-coloured scrap paint (raiders, rig): shared wear + normal maps, per-instance damage. */
function scrapPaint(name: string, roughness: number, metalness: number): { mat: THREE.MeshStandardMaterial; damage: DamageUniform } {
  const { wear, normal } = wearTextures();
  const mat = new THREE.MeshStandardMaterial({
    name,
    color: 0xffffff,
    vertexColors: true,
    map: wear,
    roughnessMap: wear,
    metalnessMap: wear,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughness,
    metalness,
  });
  return { mat, damage: addDamageShader(mat, true) };
}

// ---------------------------------------------------------------- geometry primitives

const box = (w: number, h: number, d: number): THREE.BufferGeometry => new THREE.BoxGeometry(w, h, d);

/** Cylinder along Y. */
function cylY(rTop: number, rBot: number, h: number, seg: number, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
}
/** Cylinder along Z (rTop at +Z). */
function cylZ(rTop: number, rBot: number, h: number, seg: number, open = false): THREE.BufferGeometry {
  return cylY(rTop, rBot, h, seg, open).rotateX(Math.PI / 2);
}
/** Cylinder along X (rTop at +X). */
function cylX(rTop: number, rBot: number, h: number, seg: number, open = false): THREE.BufferGeometry {
  return cylY(rTop, rBot, h, seg, open).rotateZ(-Math.PI / 2);
}

/** Round bar from a to b (radius ra at a, rb at b). rb = 0 makes a spike. */
function rod(a: V3, b: V3, ra: number, seg = 6, rb = ra, open = true): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(rb, ra, len, seg, 1, open);
  const q = new THREE.Quaternion().setFromUnitVectors(AXIS_Y, dir.normalize());
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** Rectangular bar from a to b; w across, h along the "up-ish" axis. */
function beam(a: V3, b: V3, w: number, h: number, up: V3 = AXIS_Y): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(w, h, len);
  const dir = b.clone().sub(a).normalize();
  const upRef = Math.abs(dir.dot(up)) > 0.98 ? (Math.abs(dir.x) > 0.9 ? AXIS_Z : AXIS_X) : up;
  const m = new THREE.Matrix4().lookAt(a, b, upRef);
  m.setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  g.applyMatrix4(m);
  return g;
}

/** Bent tube through points. */
function tube(pts: V3[], r: number, radial = 6, segPer = 3, tension = 0.35, closed = false): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'catmullrom', tension);
  return new THREE.TubeGeometry(curve, Math.max(2, (pts.length - (closed ? 0 : 1)) * segPer), r, radial, closed);
}

/** Weld bead / node: a lumpy low-poly blob at a tube joint. */
function weld(p: V3, r: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, 0);
  g.scale(1, 0.85, 1.1);
  g.translate(p.x, p.y, p.z);
  return g;
}

/** Convex polygon plate: `pts` is the back face, extruded by `t` toward `outward`. */
function plate(ptsIn: V3[], t: number, outward: V3): THREE.BufferGeometry {
  let pts = ptsIn;
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) n.add(pts[i].clone().cross(pts[(i + 1) % pts.length]));
  n.normalize();
  if (n.dot(outward) < 0) {
    pts = pts.slice().reverse();
    n.negate();
  }
  const top = pts.map((p) => p.clone().addScaledVector(n, t));
  const pos: number[] = [];
  const tri = (a: V3, b: V3, c: V3): void => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  for (let i = 1; i < pts.length - 1; i++) {
    tri(top[0], top[i], top[i + 1]);
    tri(pts[0], pts[i + 1], pts[i]);
  }
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    tri(pts[i], pts[j], top[j]);
    tri(pts[i], top[j], top[i]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Flat single-sided polygon decal (fan-triangulated convex polygon) facing `outward`. */
function decal(ptsIn: V3[], outward: V3): THREE.BufferGeometry {
  let pts = ptsIn;
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) n.add(pts[i].clone().cross(pts[(i + 1) % pts.length]));
  if (n.dot(outward) < 0) pts = pts.slice().reverse();
  const pos: number[] = [];
  for (let i = 1; i < pts.length - 1; i++) pos.push(pts[0].x, pts[0].y, pts[0].z, pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Rivet heads: 4-sided pyramids (4 triangles each) sitting on a surface that faces `outward`. */
function rivets(pts: V3[], size: number, outward: V3): THREE.BufferGeometry {
  const n = outward.clone().normalize();
  const t1 = new THREE.Vector3().crossVectors(n, Math.abs(n.y) > 0.9 ? AXIS_X : AXIS_Y).normalize();
  const t2 = new THREE.Vector3().crossVectors(n, t1).normalize();
  const pos: number[] = [];
  const h = size * 0.5;
  for (const p of pts) {
    const apex = p.clone().addScaledVector(n, size * 0.55);
    const c = [
      p.clone().addScaledVector(t1, h).addScaledVector(t2, h),
      p.clone().addScaledVector(t1, -h).addScaledVector(t2, h),
      p.clone().addScaledVector(t1, -h).addScaledVector(t2, -h),
      p.clone().addScaledVector(t1, h).addScaledVector(t2, -h),
    ];
    for (let i = 0; i < 4; i++) {
      const a = c[i];
      const b = c[(i + 1) % 4];
      // wind so the face normal points away from the surface
      const fn = b.clone().sub(a).cross(apex.clone().sub(a));
      const mid = a.clone().add(b).multiplyScalar(0.5).sub(p);
      if (fn.dot(mid.addScaledVector(n, size)) >= 0) pos.push(a.x, a.y, a.z, b.x, b.y, b.z, apex.x, apex.y, apex.z);
      else pos.push(b.x, b.y, b.z, a.x, a.y, a.z, apex.x, apex.y, apex.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Points along the closed polygon outline, `pitch` apart, inset toward the centroid. */
function outlinePts(poly: V3[], pitch: number, inset: number): V3[] {
  const cen = new THREE.Vector3();
  for (const p of poly) cen.add(p);
  cen.multiplyScalar(1 / poly.length);
  const out: V3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.round(a.distanceTo(b) / pitch));
    for (let k = 0; k < n; k++) {
      const p = a.clone().lerp(b, (k + 0.5) / n);
      const toC = cen.clone().sub(p);
      const d = toC.length();
      out.push(p.addScaledVector(toC, Math.min(0.45, inset / Math.max(d, 1e-4))));
    }
  }
  return out;
}

/** Static rag / pennant: a slightly curled, tattered, double-sided strip. Local: hangs from the origin along +X, drooping -Y. */
function rag(w: number, h: number, curl: number, seed: number): THREE.BufferGeometry {
  const rand = rng(seed);
  const nx = 5;
  const ny = 2;
  const pts: V3[][] = [];
  for (let j = 0; j <= ny; j++) {
    const row: V3[] = [];
    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      const t = j / ny;
      const tatter = i === nx ? (rand() - 0.3) * 0.22 * w : 0;
      row.push(v(u * w + tatter, -t * h * (1 - 0.25 * u) - 0.12 * w * u * u, curl * Math.sin(u * 4.4 + t * 1.6) * (0.25 + u)));
    }
    pts.push(row);
  }
  const pos: number[] = [];
  const tri = (a: V3, b: V3, c: V3): void => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    pos.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      tri(pts[j][i], pts[j + 1][i], pts[j][i + 1]);
      tri(pts[j][i + 1], pts[j + 1][i], pts[j + 1][i + 1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Move d into the plane of a, b, c (along Z) so a 4-point plate is flat. */
function planarZ(a: V3, b: V3, c: V3, d: V3): V3 {
  const n = b.clone().sub(a).cross(c.clone().sub(a));
  const out = d.clone();
  if (Math.abs(n.z) > 1e-5) out.z = a.z - (n.x * (d.x - a.x) + n.y * (d.y - a.y)) / n.z;
  return out;
}

/** Side profile (z, y) extruded across X, centred on x = 0, total width `width`. */
function profileX(pts: readonly P2[], width: number, bevel = 0, steps = 1, bevelSegments = 1): THREE.BufferGeometry {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const depth = width - 2 * bevel;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps,
    curveSegments: 1,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelOffset: -bevel,
    bevelSegments,
  });
  g.rotateY(-Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  return g;
}

/** Lathe around the X axis from (radius, axial) pairs; outside is to the right of travel. */
function latheX(pts: readonly P2[], seg: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    pts.map(([r, ax]) => new THREE.Vector2(Math.max(r, 0.0001), ax)),
    seg,
  );
  return g.rotateZ(-Math.PI / 2);
}

function deform(geo: THREE.BufferGeometry, fn: (p: V3) => void): THREE.BufferGeometry {
  const pos = posAttr(geo);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    fn(p);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Per-vertex colour from position (smooth gradients: mud, heat-blueing). */
function tint(geo: THREE.BufferGeometry, fn: (p: V3) => number | THREE.Color): THREE.BufferGeometry {
  const pos = posAttr(geo);
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const color = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const c = fn(p);
    if (typeof c === 'number') color.set(c);
    else color.copy(c);
    col.set([color.r, color.g, color.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Per-triangle colour (crisp livery edges without a texture). Returns a non-indexed geometry. */
function colorTris(geoIn: THREE.BufferGeometry, fn: (centroid: V3, normal: V3, tri: number) => number): THREE.BufferGeometry {
  const geo = geoIn.index ? geoIn.toNonIndexed() : geoIn;
  const pos = posAttr(geo);
  const col = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cen = new THREE.Vector3();
  const nor = new THREE.Vector3();
  const color = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    nor.copy(b).sub(a).cross(c.clone().sub(a));
    const l = nor.length();
    if (l > 1e-12) nor.multiplyScalar(1 / l);
    else nor.set(0, 1, 0);
    color.set(fn(cen, nor, i / 3));
    for (let k = 0; k < 3; k++) col.set([color.r, color.g, color.b], (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Normalise a part to {position, normal, uv, color}, non-indexed, in final space. */
function prep(geoIn: THREE.BufferGeometry, lk: Look, m: THREE.Matrix4, jitter: number): THREE.BufferGeometry {
  const g = geoIn.index ? geoIn.toNonIndexed() : geoIn;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  g.applyMatrix4(m);
  const pos = posAttr(g);
  const count = pos.count;
  if (m.determinant() < 0) {
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const existing = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    for (const attr of existing ? [pos, nor, existing] : [pos, nor]) {
      for (let i = 0; i < count; i += 3) {
        const x = attr.getX(i + 1);
        const y = attr.getY(i + 1);
        const z = attr.getZ(i + 1);
        attr.setXYZ(i + 1, attr.getX(i + 2), attr.getY(i + 2), attr.getZ(i + 2));
        attr.setXYZ(i + 2, x, y, z);
      }
    }
  }
  if (!g.getAttribute('color')) {
    const c = new THREE.Color(lk.c).multiplyScalar(jitter);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) uv.set([lk.r, lk.m], i * 2);
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') g.deleteAttribute(name);
  }
  g.clearGroups();
  return g;
}

/** Collects parts per material bucket and merges each bucket into one geometry. */
class Asm {
  private readonly buckets = new Map<string, THREE.BufferGeometry[]>();
  private readonly stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  readonly rand: () => number;

  constructor(
    seed: number,
    private readonly label = 'asm',
  ) {
    this.rand = rng(seed);
  }

  push(xf: Xf): void {
    this.stack.push(this.top().clone().multiply(xfMatrix(xf)));
  }

  pop(): void {
    if (this.stack.length > 1) this.stack.pop();
  }

  private top(): THREE.Matrix4 {
    return this.stack[this.stack.length - 1];
  }

  private store(bucket: string, g: THREE.BufferGeometry): void {
    const list = this.buckets.get(bucket);
    if (list) list.push(g);
    else this.buckets.set(bucket, [g]);
  }

  private jitter(lk: Look): number {
    return 1 + (this.rand() * 2 - 1) * lk.j;
  }

  add(bucket: string, geo: THREE.BufferGeometry, lk: Look, xf?: Xf): void {
    const m = this.top().clone();
    if (xf) m.multiply(xfMatrix(xf));
    this.store(bucket, prep(geo, lk, m, this.jitter(lk)));
  }

  /** Adds the part and its mirror image across the YZ plane. */
  addM(bucket: string, geo: THREE.BufferGeometry, lk: Look, xf?: Xf): void {
    const m = this.top().clone();
    if (xf) m.multiply(xfMatrix(xf));
    const j = this.jitter(lk);
    const base = geo.index ? geo.toNonIndexed() : geo;
    this.store(bucket, prep(base.clone(), lk, m, j));
    this.store(bucket, prep(base, lk, MIRROR_X.clone().multiply(m), j));
  }

  build(bucket: string): THREE.BufferGeometry | undefined {
    const list = this.buckets.get(bucket);
    if (!list || list.length === 0) return undefined;
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    this.buckets.delete(bucket);
    if (!merged) return undefined;
    return sanitize(merged, `${this.label}.${bucket}`);
  }
}

/** Road dust: fade vertex colours toward dust near the ground. */
function dustGradient(geo: THREE.BufferGeometry | undefined, top: number, amount: number, dustColor: number = C.dust): void {
  if (!geo) return;
  const pos = posAttr(geo);
  const col = geo.getAttribute('color') as THREE.BufferAttribute;
  const dust = new THREE.Color(dustColor);
  for (let i = 0; i < pos.count; i++) {
    const k = amount * sm(top, 0, pos.getY(i));
    if (k <= 0) continue;
    col.setXYZ(i, lerp(col.getX(i), dust.r, k), lerp(col.getY(i), dust.g, k), lerp(col.getZ(i), dust.b, k));
  }
}

/** Box-projected UVs (per triangle, by dominant normal) for the wear maps on paint. */
function boxUV(geo: THREE.BufferGeometry | undefined, scale: number): void {
  if (!geo) return;
  const pos = posAttr(geo);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.copy(b).sub(a).cross(c.clone().sub(a));
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const x = pos.getX(i + k);
      const y = pos.getY(i + k);
      const z = pos.getZ(i + k);
      if (ax >= ay && ax >= az) uv.setXY(i + k, z * scale, y * scale);
      else if (ay >= az) uv.setXY(i + k, x * scale, z * scale);
      else uv.setXY(i + k, x * scale, y * scale);
    }
  }
}

function mirrorGeometryX(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.clone();
  g.applyMatrix4(MIRROR_X);
  const count = posAttr(g).count;
  for (const name of ['position', 'normal', 'uv', 'color']) {
    const attr = g.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!attr) continue;
    const size = attr.itemSize;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < count; i += 3) {
      for (let k = 0; k < size; k++) {
        const t = arr[(i + 1) * size + k];
        arr[(i + 1) * size + k] = arr[(i + 2) * size + k];
        arr[(i + 2) * size + k] = t;
      }
    }
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Wheel-arch notch points for a side profile, travelling rear -> front along the sill. */
function archPts(cz: number, cy: number, r: number, yBase: number, n: number): P2[] {
  const a = Math.asin(Math.min(1, (cy - yBase) / r));
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const ang = lerp(Math.PI + a, -a, i / n);
    out.push([cz + r * Math.cos(ang), cy + r * Math.sin(ang)]);
  }
  return out;
}

/** Fender flare: annular arc in the (z, y) plane around a wheel centre, lip tapering toward the body. */
function archFlare(rIn: number, rOut: number, width: number, droop: number): THREE.BufferGeometry {
  const pts: P2[] = [];
  const a0 = -droop;
  const a1 = Math.PI + droop;
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const ang = lerp(a0, a1, i / n);
    pts.push([rOut * Math.cos(ang), rOut * Math.sin(ang)]);
  }
  for (let i = n; i >= 0; i--) {
    const ang = lerp(a0, a1, i / n);
    pts.push([rIn * Math.cos(ang), rIn * Math.sin(ang)]);
  }
  const g = profileX(pts, width, 0.015, 1, 1);
  deform(g, (p) => {
    const r = Math.hypot(p.z, p.y);
    if (p.x > 0) p.x *= lerp(1, 0.3, sm(rIn + 0.02, rOut, r));
  });
  return toCreasedNormals(g, 0.7);
}

// ---------------------------------------------------------------- lofted car body

/**
 * Ring point ids, bottom centre -> top centre on the +X half:
 * UC underside centre, UT wheel-tub foot, TW tub wall top, SL sill, RK rocker, WS waist,
 * CH character line, SH shoulder roll, BT belt, GB greenhouse base, WB window bottom,
 * WT window top, RO roof rail outer, RI roof rail inner, R1/R2 roof, TC top centre.
 */
const RID = { UC: 0, UT: 1, TW: 2, SL: 3, RK: 4, WS: 5, CH: 6, SH: 7, BT: 8, GB: 9, WB: 10, WT: 11, RO: 12, RI: 13, R1: 14, R2: 15, TC: 16 } as const;
/** Texture v per ring id on the +X half (mirrored as 1 - v), roughly proportional to arc length. */
const RING_V = [0, 0.018, 0.03, 0.045, 0.075, 0.115, 0.16, 0.19, 0.212, 0.235, 0.25, 0.305, 0.318, 0.335, 0.4, 0.455, 0.5];
const SIDE_F = [0, 0.14, 0.42, 0.72, 0.93, 1.0];
const SIDE_X = [0.965, 0.995, 0.972, 1.0, 0.968, 0.93];
const RING_HI = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const RING_LO = [3, 6, 8, 10, 11, 13, 16];

/** One cross-section: top/bottom centreline points (z may differ: raked faces), half width, cabin height and widths. */
type Rib = { zt: number; yt: number; zb: number; yb: number; w: number; h: number; gb: number; gt: number };
type Arch = { cz: number; cy: number; r: number; bulge: number };
type LoftSpec = {
  /** Ordered rear (-Z) to front (+Z). */
  ribs: Rib[];
  arches: Arch[];
  xTub: number;
  crown: number;
  /** Low-res ring (7 half points, open underside) for wrecks. */
  lo: boolean;
  /** Cell role between ribs i, i+1 and ring ids a < b: 0 = hole, 1 = body, 2 = glass. */
  cell: (i: number, a: number, b: number, side: number) => number;
  warp?: (p: V3, i: number, id: number, side: number) => void;
  /** Per-cell vertex colour (wrecks). Hull paint stays white. */
  color?: (i: number, a: number, b: number, side: number, cen: V3, nor: V3) => number;
  /** Ring ids that always break smoothing (hard panel edges). */
  hardIds?: readonly number[];
  /** Rib indices that always break smoothing. */
  hardRibs?: readonly number[];
  creaseAngle?: number;
  label: string;
};
type LoftOut = {
  body?: THREE.BufferGeometry;
  glass?: THREE.BufferGeometry;
  /** Final ring positions, nr x nq x 3. */
  P: Float32Array;
  /** Unit face normal per cell, (nr-1) x (nq-1) x 3. */
  N: Float32Array;
  nr: number;
  nq: number;
  u: number[];
  vv: number[];
};

function ribPoint(spec: LoftSpec, r: Rib, id: number, out: V3): V3 {
  const deck = (x: number): number => r.yt - spec.crown * (x / r.w) ** 2;
  let arch = -Infinity;
  let bulge = 0;
  for (const a of spec.arches) {
    const d = r.zb - a.cz;
    if (Math.abs(d) < a.r) arch = Math.max(arch, a.cy + Math.sqrt(a.r * a.r - d * d));
    bulge = Math.max(bulge, a.bulge * Math.exp(-((d / (a.r * 1.15)) ** 2)));
  }
  const yBT = deck(r.w * 0.93);
  arch = Math.min(arch, yBT - 0.05);
  const H = yBT - r.yb;
  let x = 0;
  let y = r.yb;
  if (id <= RID.TW) {
    x = id === RID.UC ? 0 : Math.min(spec.xTub, r.w * 0.8);
    if (id === RID.TW) y = Math.max(r.yb, arch);
  } else if (id <= RID.BT) {
    y = r.yb + H * SIDE_F[id - 3];
    x = r.w * SIDE_X[id - 3];
    if (id < RID.BT && y < arch) {
      y = arch;
      x = r.w + bulge;
    } else if (bulge > 0) {
      x += bulge * lerp(1, 0.3, sm(Math.max(arch, r.yb), yBT, y));
    }
  } else if (id <= RID.RO) {
    const t = id === RID.GB ? 0 : id === RID.WB ? 0.1 : id === RID.WT ? 0.9 : 0.985;
    x = lerp(r.gb, r.gt, t);
    y = deck(x) + r.h * t;
  } else {
    const k = id === RID.RI ? 1 : id === RID.R1 ? 0.62 : id === RID.R2 ? 0.3 : 0;
    const xr = Math.max(0.02, r.gt - 0.07);
    x = xr * k;
    y = deck(x) + r.h + 0.022 * (1 - k * k) * Math.min(1, r.h / 0.2);
  }
  const span = r.yt - r.yb;
  const fz = span > 1e-4 ? clamp01((y - r.yb) / span) : 1;
  return out.set(x, y, lerp(r.zb, r.zt, fz));
}

/** Loft the ribs into a body shell (+ optional inset glass) with crease-aware smooth normals and unwrapped UVs. */
function loftBody(spec: LoftSpec): LoftOut {
  const half = spec.lo ? RING_LO : RING_HI;
  const ids: number[] = [...half];
  const sides: number[] = half.map(() => 1);
  for (let k = half.length - 2; k >= 0; k--) {
    ids.push(half[k]);
    sides.push(-1);
  }
  const nq = ids.length;
  const nr = spec.ribs.length;
  const P = new Float32Array(nr * nq * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < nr; i++) {
    for (let q = 0; q < nq; q++) {
      ribPoint(spec, spec.ribs[i], ids[q], p);
      p.x *= sides[q];
      if (spec.warp) spec.warp(p, i, ids[q], sides[q]);
      P.set([p.x, p.y, p.z], (i * nq + q) * 3);
    }
  }
  // unwrapped texture coordinates: u follows surface distance along the body, v the ring
  const u: number[] = [0];
  const probe = [RING_HI.length - 1, 0, Math.min(3, nq - 1)].filter((q) => q < nq);
  for (let i = 1; i < nr; i++) {
    let d = 0;
    for (const q of probe) {
      const a = ((i - 1) * nq + q) * 3;
      const b = (i * nq + q) * 3;
      d = Math.max(d, Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]));
    }
    u.push(u[i - 1] + Math.max(d, 1e-4));
  }
  const total = u[nr - 1];
  for (let i = 0; i < nr; i++) u[i] /= total;
  const vv = ids.map((id, q) => (sides[q] > 0 ? RING_V[id] : 1 - RING_V[id]));

  // per-cell triangles: (A, D, B) and (D, C, B) face outward
  const nc = nq - 1;
  const cellCount = (nr - 1) * nc;
  const N = new Float32Array(cellCount * 3);
  const triN = new Float32Array(cellCount * 2 * 3); // area-weighted
  const triOK = new Uint8Array(cellCount * 2);
  const corner = (i: number, q: number): number => (i * nq + q) * 3;
  const faceN = (ia: number, ib: number, ic: number, out: Float32Array, o: number): number => {
    const ux = P[ib] - P[ia];
    const uy = P[ib + 1] - P[ia + 1];
    const uz = P[ib + 2] - P[ia + 2];
    const wx = P[ic] - P[ia];
    const wy = P[ic + 1] - P[ia + 1];
    const wz = P[ic + 2] - P[ia + 2];
    out[o] = uy * wz - uz * wy;
    out[o + 1] = uz * wx - ux * wz;
    out[o + 2] = ux * wy - uy * wx;
    return Math.hypot(out[o], out[o + 1], out[o + 2]);
  };
  for (let i = 0; i < nr - 1; i++) {
    for (let q = 0; q < nc; q++) {
      const c = i * nc + q;
      const A = corner(i, q);
      const B = corner(i + 1, q);
      const Cc = corner(i + 1, q + 1);
      const D = corner(i, q + 1);
      const l0 = faceN(A, D, B, triN, c * 6);
      const l1 = faceN(D, Cc, B, triN, c * 6 + 3);
      triOK[c * 2] = l0 > 2e-6 ? 1 : 0;
      triOK[c * 2 + 1] = l1 > 2e-6 ? 1 : 0;
      const nx = (triOK[c * 2] ? triN[c * 6] : 0) + (triOK[c * 2 + 1] ? triN[c * 6 + 3] : 0);
      const ny = (triOK[c * 2] ? triN[c * 6 + 1] : 0) + (triOK[c * 2 + 1] ? triN[c * 6 + 4] : 0);
      const nz = (triOK[c * 2] ? triN[c * 6 + 2] : 0) + (triOK[c * 2 + 1] ? triN[c * 6 + 5] : 0);
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-9) N.set([nx / l, ny / l, nz / l], c * 3);
      else N.set([0, 1, 0], c * 3);
    }
  }
  // smoothing bands
  const hardIds = spec.hardIds ?? [];
  const hardRibs = spec.hardRibs ?? [];
  const ringBand = (q: number): number => {
    const a = Math.min(ids[q], ids[q + 1]);
    let band = 0;
    for (const h of hardIds) if (a >= h) band++;
    return band;
  };
  const ribBand = (i: number): number => {
    let band = 0;
    for (const h of hardRibs) if (i >= h) band++;
    return band;
  };
  const creaseCos = Math.cos(spec.creaseAngle ?? 0.7);
  const cornerNormal = (i: number, q: number, c: number, tri: number, out: number[]): void => {
    const fo = c * 6 + tri * 3;
    const fl = Math.hypot(triN[fo], triN[fo + 1], triN[fo + 2]);
    const fx = triN[fo] / fl;
    const fy = triN[fo + 1] / fl;
    const fz = triN[fo + 2] / fl;
    const rb = ringBand(c % nc);
    const ib = ribBand(Math.floor(c / nc));
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let di = -1; di <= 0; di++) {
      for (let dq = -1; dq <= 0; dq++) {
        const ci = i + di;
        const cq = q + dq;
        if (ci < 0 || ci >= nr - 1 || cq < 0 || cq >= nc) continue;
        if (ringBand(cq) !== rb || ribBand(ci) !== ib) continue;
        const cc = ci * nc + cq;
        for (let t = 0; t < 2; t++) {
          if (!triOK[cc * 2 + t]) continue;
          // does this triangle touch the vertex? tri 0 = (A, D, B), tri 1 = (D, C, B)
          const isA = di === 0 && dq === 0;
          const isC = di === -1 && dq === -1;
          if (t === 0 && isC) continue;
          if (t === 1 && isA) continue;
          const o = cc * 6 + t * 3;
          const l = Math.hypot(triN[o], triN[o + 1], triN[o + 2]);
          if ((triN[o] * fx + triN[o + 1] * fy + triN[o + 2] * fz) / l < creaseCos) continue;
          nx += triN[o];
          ny += triN[o + 1];
          nz += triN[o + 2];
        }
      }
    }
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-9) out.push(nx / l, ny / l, nz / l);
    else out.push(fx, fy, fz);
  };

  const bPos: number[] = [];
  const bNor: number[] = [];
  const bUv: number[] = [];
  const bCol: number[] = [];
  const gPos: number[] = [];
  const gNor: number[] = [];
  const cen = new THREE.Vector3();
  const nor = new THREE.Vector3();
  const color = new THREE.Color();
  for (let i = 0; i < nr - 1; i++) {
    for (let q = 0; q < nc; q++) {
      const c = i * nc + q;
      const a = Math.min(ids[q], ids[q + 1]);
      const b = Math.max(ids[q], ids[q + 1]);
      const side = sides[ids[q] === RID.TC ? q + 1 : q];
      const role = spec.cell(i, a, b, side);
      if (role === 0) continue;
      const quad: [number, number][] = [
        [i, q],
        [i, q + 1],
        [i + 1, q],
        [i, q + 1],
        [i + 1, q + 1],
        [i + 1, q],
      ];
      if (spec.color && role === 1) {
        cen.set(0, 0, 0);
        for (const [ci, cq] of [quad[0], quad[1], quad[2], quad[4]]) {
          const o = corner(ci, cq);
          cen.x += P[o] * 0.25;
          cen.y += P[o + 1] * 0.25;
          cen.z += P[o + 2] * 0.25;
        }
        nor.set(N[c * 3], N[c * 3 + 1], N[c * 3 + 2]);
        color.set(spec.color(i, a, b, side, cen, nor));
      } else color.set(0xffffff);
      for (let t = 0; t < 2; t++) {
        if (!triOK[c * 2 + t]) continue;
        for (let k = 0; k < 3; k++) {
          const [ci, cq] = quad[t * 3 + k];
          const o = corner(ci, cq);
          if (role === 2) {
            // glass sits a little inside the frame
            gPos.push(P[o] - N[c * 3] * 0.012, P[o + 1] - N[c * 3 + 1] * 0.012, P[o + 2] - N[c * 3 + 2] * 0.012);
            cornerNormal(ci, cq, c, t, gNor);
          } else {
            bPos.push(P[o], P[o + 1], P[o + 2]);
            cornerNormal(ci, cq, c, t, bNor);
            bUv.push(u[ci], vv[cq]);
            bCol.push(color.r, color.g, color.b);
          }
        }
      }
    }
  }
  const make = (pos: number[], norm: number[], uv?: number[], col?: number[]): THREE.BufferGeometry | undefined => {
    if (pos.length === 0) return undefined;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (col) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  };
  return { body: make(bPos, bNor, bUv, bCol), glass: make(gPos, gNor), P, N, nr, nq, u, vv };
}

// ---------------------------------------------------------------- wheels

type WheelSpec = {
  r: number;
  w: number;
  seg: number;
  lugs: number;
  rim: Look;
  /** alloy = deep-dish split spokes + brake disc, steel = scrap beadlock dish, truck = hub-nut commercial rim. */
  style: 'alloy' | 'steel' | 'truck';
  hubSpike: number;
  dual: boolean;
  /** 0..1 mud caking on tread and lower sidewall. */
  mud: number;
};

const wheelCache = new Map<string, { left: THREE.BufferGeometry; right: THREE.BufferGeometry }>();

/** One merged tyre + rim geometry; axle = local X, outer face toward +X (left side). */
function wheelGeometry(key: string, spec: WheelSpec): { left: THREE.BufferGeometry; right: THREE.BufferGeometry } {
  const hit = wheelCache.get(key);
  if (hit) return hit;
  const a = new Asm(4242, `wheel.${key}`);
  const { r, w, seg } = spec;
  const rimR = r * (spec.style === 'alloy' ? 0.64 : 0.58);
  const rubber = new THREE.Color(C.rubber);
  const mud = new THREE.Color(C.mud);
  const dusty = new THREE.Color(C.tread);
  const tyres: [number, number][] = spec.dual
    ? [
        [-w * 0.265, w * 0.47],
        [w * 0.265, w * 0.47],
      ]
    : [[0, w]];
  for (const [cx, tw] of tyres) {
    // rounded shoulder, bulged sidewall, bead tucked into the rim
    const halfProfile: P2[] = [
      [rimR * 0.99, -0.4],
      [rimR + 0.035 * r, -0.465],
      [r * 0.8, -0.5],
      [r * 0.9, -0.488],
      [r * 0.955, -0.44],
      [r * 0.988, -0.345],
      [r, -0.17],
    ];
    const profile: P2[] = [...halfProfile.map(([pr, ax]): P2 => [pr, ax * tw]), ...halfProfile.reverse().map(([pr, ax]): P2 => [pr, -ax * tw])];
    const tyre = latheX(profile, seg);
    tint(tyre, (p) => {
      const rad = Math.hypot(p.y, p.z);
      const n = hash3(Math.round(p.x * 40), Math.round(p.y * 14), Math.round(p.z * 14));
      const c = rubber.clone().lerp(dusty, 0.5 * sm(r * 0.9, r, rad));
      if (spec.mud > 0) c.lerp(mud, spec.mud * sm(r * 0.62, r * 0.98, rad) * (0.45 + 0.55 * n));
      return c;
    });
    a.add('w', tyre, L.rubber, { p: [cx, 0, 0] });
    // tread: staggered chevron shoulder lugs + centre blocks
    const lugLook = spec.mud > 0.4 ? look(0x33271c, 1, 0, 0.14) : L.tread;
    for (let side = -1; side <= 1; side += 2) {
      if (spec.dual && side * cx < 0) continue;
      for (let i = 0; i < spec.lugs; i++) {
        const ang = ((i + (side > 0 ? 0.5 : 0)) / spec.lugs) * Math.PI * 2;
        const lug = box(tw * (spec.dual ? 0.46 : 0.3), r * 0.07, r * 0.17);
        lug.rotateY(side * 0.34);
        lug.translate(0, r * 0.985, 0);
        a.add('w', lug, lugLook, { p: [cx + side * tw * (spec.dual ? 0.2 : 0.32), 0, 0], r: [ang, 0, 0] });
      }
    }
    if (!spec.dual) {
      for (let i = 0; i < spec.lugs; i++) {
        const ang = ((i + 0.25) / spec.lugs) * Math.PI * 2;
        const blk = box(tw * 0.2, r * 0.06, r * 0.13);
        blk.translate(0, r * 0.99, 0);
        a.add('w', blk, lugLook, { p: [cx, 0, 0], r: [ang, 0, 0] });
      }
    }
  }
  const outer = w * 0.5;
  // sidewall lettering hint: two arcs of pale raised blocks on the outer wall
  {
    const lr = r * 0.855;
    const lx = outer * 0.985;
    const letter = new THREE.Color(0x77736a);
    const blocks = [0, 1, 2, 3, 4, 6, 7, 8];
    for (const arc of [0.35, 0.35 + Math.PI]) {
      for (const k of blocks) {
        const ang = arc + k * 0.085;
        const hw = 0.028 * r * (k % 3 === 1 ? 0.6 : 1);
        const g = decal([v(0, lr - 0.03 * r, -hw), v(0, lr - 0.03 * r, hw), v(0, lr + 0.035 * r, hw), v(0, lr + 0.035 * r, -hw)], AXIS_X);
        tint(g, () => letter);
        a.add('w', g, L.rubber, { p: [lx, 0, 0], r: [ang, 0, 0] });
      }
    }
  }
  const rimDark = look(new THREE.Color(spec.rim.c).multiplyScalar(0.45).getHex(), 0.6, spec.rim.m, 0);
  if (spec.style === 'alloy') {
    // open deep-dish barrel: outer lip, inner barrel wall, dark back plate
    a.add(
      'w',
      latheX(
        [
          [rimR * 0.99, -outer * 0.86],
          [rimR * 1.06, outer * 0.9],
          [rimR * 0.985, outer * 0.96],
          [rimR * 0.9, outer * 0.84],
          [rimR * 0.87, -outer * 0.42],
        ],
        seg,
      ),
      spec.rim,
    );
    a.add(
      'w',
      latheX(
        [
          [rimR * 0.87, -outer * 0.42],
          [0.0001, -outer * 0.42],
        ],
        seg,
      ),
      L.matte,
    );
    // vented brake disc + hat, visible between the spokes
    const discX = -outer * 0.12;
    a.add('w', cylX(rimR * 0.8, rimR * 0.8, 0.03, 20), look(0x6f7175, 0.34, 1, 0), { p: [discX, 0, 0] });
    a.add('w', cylX(rimR * 0.34, rimR * 0.38, 0.07, 12), L.steelDark, { p: [discX + 0.03, 0, 0] });
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2;
      a.add('w', box(0.004, rimR * 0.22, 0.012).translate(0, rimR * 0.58, 0), L.blackMetal, { p: [discX + 0.016, 0, 0], r: [ang, 0, 0] });
    }
    // five split (Y) spokes, set back from the lip
    const hubX = outer * 0.2;
    const tipX = outer * 0.46;
    const spokeLook = look(spec.rim.c, spec.rim.r, spec.rim.m, 0.06);
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2;
      for (const d of [-0.23, 0.23]) {
        const from = v(hubX, rimR * 0.2 * Math.cos(d * 0.6), rimR * 0.2 * Math.sin(d * 0.6));
        const to = v(tipX, rimR * 0.9 * Math.cos(d), rimR * 0.9 * Math.sin(d));
        const spoke = beam(from, to, rimR * 0.12, outer * 0.24, AXIS_X);
        a.add('w', spoke, spokeLook, { r: [ang, 0, 0] });
      }
      const web = beam(v(hubX, rimR * 0.14, 0), v(hubX + (tipX - hubX) * 0.45, rimR * 0.5, 0), rimR * 0.2, outer * 0.2, AXIS_X);
      a.add('w', web, spokeLook, { r: [ang, 0, 0] });
    }
    a.add('w', cylX(rimR * 0.2, rimR * 0.27, outer * 0.34, 10), spec.rim, { p: [hubX + outer * 0.05, 0, 0] });
    a.add('w', cylX(rimR * 0.1, rimR * 0.13, outer * 0.1, 8), L.blackMetal, { p: [hubX + outer * 0.25, 0, 0] });
    for (let i = 0; i < 5; i++) {
      const ang = ((i + 0.5) / 5) * Math.PI * 2;
      a.add('w', cylX(rimR * 0.035, rimR * 0.04, outer * 0.12, 5), L.chrome, { p: [hubX + outer * 0.22, rimR * 0.19 * Math.cos(ang), rimR * 0.19 * Math.sin(ang)] });
    }
  } else if (spec.style === 'steel') {
    a.add(
      'w',
      latheX(
        [
          [rimR * 0.99, -outer * 0.86],
          [rimR * 1.07, outer * 0.88],
          [rimR * 0.97, outer * 0.94],
          [rimR * 0.88, outer * 0.52],
          [rimR * 0.5, outer * 0.3],
          [rimR * 0.3, outer * 0.44],
          [0.0001, outer * 0.44],
        ],
        seg,
      ),
      spec.rim,
    );
    // lightening holes + beadlock bolts
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      a.add('w', cylX(rimR * 0.1, rimR * 0.1, 0.012, 7), L.matte, {
        p: [outer * 0.425, rimR * 0.69 * Math.cos(ang), rimR * 0.69 * Math.sin(ang)],
        r: [0, 0, 0],
      });
    }
    const bolts: V3[] = [];
    for (let i = 0; i < 10; i++) {
      const ang = ((i + 0.5) / 10) * Math.PI * 2;
      bolts.push(v(outer * 0.93, rimR * 1.02 * Math.cos(ang), rimR * 1.02 * Math.sin(ang)));
    }
    a.add('w', rivets(bolts, rimR * 0.1, AXIS_X), L.steel);
    a.add('w', cylX(rimR * 0.2, rimR * 0.3, outer * 0.3, 8), rimDark, { p: [outer * 0.5, 0, 0] });
  } else {
    const face = spec.dual ? 0.0 : 0.3;
    a.add(
      'w',
      latheX(
        spec.dual
          ? [
              [rimR * 0.99, -outer * 0.3],
              [rimR * 1.06, outer * 0.86],
              [rimR * 0.96, outer * 0.92],
              [rimR * 0.87, outer * 0.02],
              [rimR * 0.42, outer * 0.02],
              [rimR * 0.32, outer * 0.3],
              [0.0001, outer * 0.3],
            ]
          : [
              [rimR * 0.99, -outer * 0.86],
              [rimR * 1.06, outer * 0.86],
              [rimR * 0.96, outer * 0.92],
              [rimR * 0.86, outer * 0.3],
              [rimR * 0.52, outer * 0.3],
              [rimR * 0.44, outer * 0.78],
              [rimR * 0.2, outer * 0.92],
              [0.0001, outer * 0.92],
            ],
        seg,
      ),
      spec.rim,
    );
    const nuts: V3[] = [];
    for (let i = 0; i < 8; i++) {
      const ang = ((i + 0.5) / 8) * Math.PI * 2;
      nuts.push(v(outer * face + 0.004, rimR * 0.68 * Math.cos(ang), rimR * 0.68 * Math.sin(ang)));
    }
    a.add('w', rivets(nuts, rimR * 0.13, AXIS_X), L.steel);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + 0.4;
      a.add('w', cylX(rimR * 0.09, rimR * 0.09, 0.012, 6), L.matte, { p: [outer * face + 0.006, rimR * 0.68 * Math.cos(ang), rimR * 0.68 * Math.sin(ang)] });
    }
  }
  if (spec.hubSpike > 0) {
    const base = spec.style === 'truck' ? outer * 0.9 : outer * 0.6;
    a.add('w', rod(v(base, 0, 0), v(base + spec.hubSpike, 0, 0), rimR * 0.24, 5, 0), L.rust);
  }
  const left = a.build('w') as THREE.BufferGeometry;
  const result = { left, right: mirrorGeometryX(left) };
  wheelCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------- blueprint / instancing

type Socket = { p: T3; d: T3 };
type WheelDef = { name: string; p: T3; geo: THREE.BufferGeometry; steer: boolean };
/** Extra mesh: static brake callipers, recoil barrel, or cosmetic parts that fall off with damage. */
type Extra = {
  name: string;
  geo: THREE.BufferGeometry;
  /** body / root / turret, or the index of a steering pivot. */
  parent: 'body' | 'root' | 'turret' | number;
  p?: T3;
  /** Hidden once damage reaches this level. */
  hideAt?: number;
};
type Blueprint = {
  paint?: THREE.BufferGeometry;
  kit?: THREE.BufferGeometry;
  glass?: THREE.BufferGeometry;
  head?: THREE.BufferGeometry;
  tail?: THREE.BufferGeometry;
  accent?: THREE.BufferGeometry;
  turret?: { geo: THREE.BufferGeometry; p: T3; muzzles: Socket[] };
  extras?: Extra[];
  bodyMuzzles: Socket[];
  exhausts: Socket[];
  wheels: WheelDef[];
  halfExtents: { x: number; y: number; z: number };
  wheelRadius: number;
};

type Livery = {
  name: string;
  paint: THREE.MeshStandardMaterial;
  damage: DamageUniform;
  scorchRoughness: number;
  headColor: number;
  headEmissive: number;
  accentColor: number;
  accentEmissive: number;
  accentIntensity: number;
};

function makeSocket(name: string, s: Socket): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(s.p[0], s.p[1], s.p[2]);
  o.quaternion.setFromUnitVectors(AXIS_Z, new THREE.Vector3(s.d[0], s.d[1], s.d[2]).normalize());
  return o;
}

function instantiate(bp: Blueprint, livery: Livery): VehicleModel {
  const root = new THREE.Group();
  root.name = livery.name;
  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);

  const paintMat = livery.paint;
  // lens vertex colour scales the emissive, so "switched off" lamps can share the material
  const headlightMaterial = new THREE.MeshStandardMaterial({
    name: 'headlight',
    color: livery.headColor,
    emissive: livery.headEmissive,
    emissiveIntensity: 2.2,
    roughness: 0.25,
    metalness: 0,
    vertexColors: true,
  });
  headlightMaterial.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n  totalEmissiveRadiance *= max( vColor.rgb, vec3( 0.0 ) );\n#endif',
    );
  };
  headlightMaterial.customProgramCacheKey = () => 'vehicleLens-v1';
  const tailLightMaterial = new THREE.MeshStandardMaterial({
    name: 'tailLight',
    color: 0x3a0806,
    emissive: 0xff2410,
    emissiveIntensity: 1.6,
    roughness: 0.35,
    metalness: 0,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    name: 'accent',
    color: livery.accentColor,
    emissive: livery.accentEmissive,
    emissiveIntensity: livery.accentIntensity,
    roughness: 0.4,
    metalness: 0,
  });

  const addMesh = (
    geo: THREE.BufferGeometry | undefined,
    mat: THREE.Material,
    name: string,
    cast: boolean,
    receive: boolean,
  ): void => {
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    body.add(mesh);
  };
  addMesh(bp.paint, paintMat, 'hull', true, true);
  addMesh(bp.kit, kitMaterial(), 'chassisKit', true, true);
  addMesh(bp.head, headlightMaterial, 'headlights', true, false);
  addMesh(bp.tail, tailLightMaterial, 'tailLights', true, false);
  addMesh(bp.accent, accentMaterial, 'accentLights', true, false);
  if (bp.glass) {
    const glass = new THREE.Mesh(bp.glass, glassMaterial());
    glass.name = 'cockpitGlass';
    glass.castShadow = true;
    glass.renderOrder = 2;
    body.add(glass);
  }

  const muzzles: THREE.Object3D[] = [];
  let turret: THREE.Object3D | undefined;
  if (bp.turret) {
    const mesh = new THREE.Mesh(bp.turret.geo, kitMaterial());
    mesh.name = 'turret';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(bp.turret.p[0], bp.turret.p[1], bp.turret.p[2]);
    bp.turret.muzzles.forEach((s, i) => {
      const socket = makeSocket(`muzzleTurret${i}`, s);
      mesh.add(socket);
      muzzles.push(socket);
    });
    body.add(mesh);
    turret = mesh;
  }
  bp.bodyMuzzles.forEach((s, i) => {
    const socket = makeSocket(`muzzleFixed${i}`, s);
    body.add(socket);
    muzzles.push(socket);
  });
  const exhausts = bp.exhausts.map((s, i) => {
    const socket = makeSocket(`exhaust${i}`, s);
    body.add(socket);
    return socket;
  });

  const wheels: THREE.Object3D[] = [];
  const steerPivots: THREE.Object3D[] = [];
  for (const def of bp.wheels) {
    const mesh = new THREE.Mesh(def.geo, kitMaterial());
    mesh.name = def.name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (def.steer) {
      const pivot = new THREE.Object3D();
      pivot.name = `${def.name}Steer`;
      pivot.position.set(def.p[0], def.p[1], def.p[2]);
      pivot.add(mesh);
      root.add(pivot);
      steerPivots.push(pivot);
    } else {
      mesh.position.set(def.p[0], def.p[1], def.p[2]);
      root.add(mesh);
    }
    wheels.push(mesh);
  }

  const breakaway: { mesh: THREE.Mesh; at: number }[] = [];
  for (const ex of bp.extras ?? []) {
    const mesh = new THREE.Mesh(ex.geo, kitMaterial());
    mesh.name = ex.name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (ex.p) mesh.position.set(ex.p[0], ex.p[1], ex.p[2]);
    const parent = ex.parent === 'body' ? body : ex.parent === 'root' ? root : ex.parent === 'turret' ? (turret ?? body) : (steerPivots[ex.parent] ?? root);
    parent.add(mesh);
    if (ex.hideAt !== undefined) breakaway.push({ mesh, at: ex.hideAt });
  }

  const baseRoughness = paintMat.roughness;
  const physical = paintMat instanceof THREE.MeshPhysicalMaterial ? paintMat : null;
  const baseClearcoat = physical ? physical.clearcoat : 0;
  const baseEnv = paintMat.envMapIntensity;
  const pristine = new THREE.Color(1, 1, 1);
  const scorched = new THREE.Color(0.62, 0.55, 0.5);
  let applied = -1;
  const setDamage = (level: number): void => {
    const t = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    if (t === applied) return;
    applied = t;
    // the shader reveals scrapes + soot from the wear masks; these cheap params follow along
    livery.damage.value = t;
    paintMat.color.lerpColors(pristine, scorched, t);
    paintMat.roughness = lerp(baseRoughness, livery.scorchRoughness, t * t);
    paintMat.envMapIntensity = baseEnv * (1 - 0.45 * t);
    if (physical) physical.clearcoat = Math.max(0.03, baseClearcoat * (1 - t));
    for (const part of breakaway) part.mesh.visible = t < part.at;
  };
  setDamage(0);

  const materials = new Set<THREE.Material>();
  let meshes = 0;
  let triangles = 0;
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      meshes++;
      triangles += triangleCount(o.geometry as THREE.BufferGeometry);
      const m = o.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((x) => materials.add(x));
      else materials.add(m);
    }
  });

  return {
    root,
    body,
    wheels,
    steerPivots,
    turret,
    muzzles,
    exhausts,
    headlightMaterial,
    tailLightMaterial,
    accentMaterial,
    setDamage,
    halfExtents: { ...bp.halfExtents },
    wheelRadius: bp.wheelRadius,
    diagnostics: { meshes, materials: materials.size, triangles: Math.round(triangles) },
  };
}

function finishBody(a: Asm, dustTop: number, dustAmount: number): Pick<Blueprint, 'paint' | 'kit' | 'glass' | 'head' | 'tail' | 'accent'> {
  const paintGeo = a.build('paint');
  const kit = a.build('kit');
  dustGradient(paintGeo, dustTop, dustAmount);
  dustGradient(kit, dustTop, dustAmount);
  boxUV(paintGeo, 0.55);
  return { paint: paintGeo, kit, glass: a.build('glass'), head: a.build('head'), tail: a.build('tail'), accent: a.build('accent') };
}

function scatterBolts(a: Asm, pts: V3[], size: number, outward: V3, lk: Look, bucket = 'kit'): void {
  a.add(bucket, rivets(pts, size, outward), lk);
}

/** Hazard-striped panel: the quad (p0 -> p1 along the stripe run, p3 -> p2 opposite edge) cut into slanted bands. */
function hazardPanel(a: Asm, bucket: string, quad: [V3, V3, V3, V3], bands: number, slant: number, cA: number, cB: number, t: number, outward: V3, mirror = false): void {
  const [p0, p1, p2, p3] = quad;
  for (let i = 0; i < bands; i++) {
    const u0 = i / bands;
    const u1 = (i + 1) / bands;
    const lo0 = p0.clone().lerp(p1, clamp01(u0 - slant));
    const lo1 = p0.clone().lerp(p1, clamp01(u1 - slant));
    const hi0 = p3.clone().lerp(p2, clamp01(u0 + slant));
    const hi1 = p3.clone().lerp(p2, clamp01(u1 + slant));
    if (lo0.distanceTo(lo1) < 1e-4 && hi0.distanceTo(hi1) < 1e-4) continue;
    const g = plate([lo0, lo1, hi1, hi0], t, outward);
    if (mirror) a.addM(bucket, g, paint(i % 2 === 0 ? cA : cB, 0.06));
    else a.add(bucket, g, paint(i % 2 === 0 ? cA : cB, 0.06));
  }
}

/** Hand-painted glyphs as flat decals in the XY plane (facing +Z), roughly unit sized. */
function glyph(kind: 'claw' | 'eye' | 'bolt' | 'cross' | 'fang'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const poly = (pts: P2[]): void => {
    parts.push(decal(pts.map(([x, y]) => v(x, y, 0)), AXIS_Z));
  };
  if (kind === 'claw') {
    for (let i = -1; i <= 1; i++) poly([[i * 0.3 - 0.2, 0.5], [i * 0.3 - 0.06, 0.52], [i * 0.3 + 0.18, -0.44], [i * 0.3 + 0.12, -0.5]]);
  } else if (kind === 'eye') {
    poly([[-0.5, 0], [0, 0.26], [0, 0.14], [-0.3, 0]]);
    poly([[0.5, 0], [0, 0.26], [0, 0.14], [0.3, 0]]);
    poly([[-0.5, 0], [-0.3, 0], [0, -0.14], [0, -0.26]]);
    poly([[0.5, 0], [0.3, 0], [0, -0.14], [0, -0.26]]);
    poly([[-0.09, 0], [0, 0.1], [0.09, 0], [0, -0.1]]);
  } else if (kind === 'bolt') {
    poly([[0.1, 0.5], [-0.24, -0.04], [0.0, -0.02], [0.3, 0.5]]);
    poly([[-0.02, 0.06], [-0.14, -0.5], [0.24, 0.08], [0.02, 0.04]]);
  } else if (kind === 'cross') {
    poly([[-0.5, 0.38], [-0.38, 0.5], [0.5, -0.38], [0.38, -0.5]]);
    poly([[0.5, 0.38], [0.38, 0.5], [-0.5, -0.38], [-0.38, -0.5]]);
  } else {
    for (let i = -2; i <= 2; i++) poly([[i * 0.2 - 0.09, 0.3], [i * 0.2 + 0.09, 0.3], [i * 0.2, -0.3 + Math.abs(i) * 0.1]]);
  }
  const g = mergeGeometries(parts, false) as THREE.BufferGeometry;
  return g;
}

// ---------------------------------------------------------------- faction skull plate (raiders)

/** Jagged skull face plate in the XY plane facing +Z, about 1.0 wide x 1.1 tall, with glowing sockets. */
function addSkull(a: Asm, boneLook: Look): void {
  const right: P2[] = [
    [0, -0.5],
    [0.07, -0.39],
    [0.14, -0.5],
    [0.21, -0.39],
    [0.28, -0.48],
    [0.3, -0.24],
    [0.45, -0.15],
    [0.5, 0.12],
    [0.45, 0.38],
    [0.29, 0.55],
    [0, 0.6],
  ];
  const full: P2[] = [...right, ...right.slice(1, -1).reverse().map(([x, y]): P2 => [-x, y])];
  const shape = new THREE.Shape(full.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const s of [1, -1]) {
    const eye: P2[] = [
      [0.08, 0.0],
      [0.33, -0.03],
      [0.38, 0.25],
      [0.1, 0.11],
    ];
    shape.holes.push(new THREE.Path(eye.map(([x, y]) => new THREE.Vector2(s * x, y))));
  }
  shape.holes.push(new THREE.Path([new THREE.Vector2(0, -0.07), new THREE.Vector2(0.06, -0.21), new THREE.Vector2(-0.06, -0.21)]));
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false, curveSegments: 1 });
  a.add('paint', g, boneLook);
  a.add('accent', box(0.34, 0.32, 0.014), paint(0xffffff, 0), { p: [0.23, 0.1, 0.02] });
  a.add('accent', box(0.34, 0.32, 0.014), paint(0xffffff, 0), { p: [-0.23, 0.1, 0.02] });
  a.add('kit', box(0.16, 0.18, 0.014), L.matte, { p: [0, -0.14, 0.02] });
  // brow ridge, cheek rivets and a cracked forehead give the plate a welded, hand-cut feel
  a.addM('kit', beam(v(0.06, 0.2, 0.06), v(0.44, 0.34, 0.06), 0.05, 0.03), L.rustDark);
  a.add('kit', decal([v(0.02, 0.58, 0.052), v(0.05, 0.4, 0.052), v(-0.03, 0.3, 0.052), v(-0.01, 0.42, 0.052)], AXIS_Z), L.matte);
  scatterBolts(a, [v(0.4, -0.08, 0.05), v(-0.4, -0.08, 0.05), v(0.25, 0.47, 0.05), v(-0.25, 0.47, 0.05), v(0.43, 0.2, 0.05), v(-0.43, 0.2, 0.05)], 0.04, AXIS_Z, L.steelDark);
}

// ---------------------------------------------------------------- HERO: interceptor

const HERO_W = 0.92;
const HERO_WR = 0.42;
const HERO_FZ = 1.42;
const HERO_RZ = -1.38;
const HERO_CAB = 0.425;
const HERO_COWL = 0.68;
const HERO_HEAD = 0.1;
const HERO_ROOF_END = -0.72;
const HERO_GLASS_END = -1.78;

const heroTopY = curve1([
  [-2.22, 1.15],
  [-2.0, 1.128],
  [-1.78, 1.105],
  [-1.35, 1.085],
  [-0.9, 1.045],
  [0.62, 1.03],
  [1.3, 1.0],
  [1.85, 0.95],
  [2.1, 0.905],
  [2.22, 0.87],
]);
const heroCabH = lin([
  [HERO_GLASS_END, 0],
  [HERO_ROOF_END, HERO_CAB],
  [HERO_HEAD, HERO_CAB],
  [HERO_COWL, 0],
]);
/** Plan-view half width: tapered nose and tail, pinched waist at the doors. */
const heroW = (z: number): number => HERO_W * (1 - 0.1 * sm(1.55, 2.33, z) - 0.06 * sm(-1.7, -2.32, z)) * (1 - 0.035 * Math.exp(-(((z + 0.02) / 0.5) ** 2)));
function heroRib(z: number): Rib {
  const w = heroW(z);
  const h = heroCabH(z);
  const gb = Math.min(0.83, w * 0.9);
  return { zt: z, zb: z, yt: heroTopY(z), yb: 0.3, w, h, gb, gt: gb - (gb - 0.664) * (h / HERO_CAB) };
}
const HERO_SHAPE = {
  arches: [
    { cz: HERO_FZ, cy: HERO_WR, r: 0.5, bulge: 0.05 },
    { cz: HERO_RZ, cy: HERO_WR, r: 0.5, bulge: 0.065 },
  ] as Arch[],
  xTub: 0.5,
  crown: 0.035,
};

/** Body-side half width at height y for station z (follows fender bulges and the waist). */
function heroSideX(y: number, z: number): number {
  const spec = { ...HERO_SHAPE, lo: false, ribs: [], cell: () => 1, label: '' } as LoftSpec;
  const rib = heroRib(z);
  const p = new THREE.Vector3();
  let px = 0;
  let py = 0;
  for (let id = RID.SL; id <= RID.BT; id++) {
    ribPoint(spec, rib, id, p);
    if (y <= p.y) return id === RID.SL || p.y - py < 1e-5 ? p.x : lerp(px, p.x, (y - py) / (p.y - py));
    px = p.x;
    py = p.y;
  }
  return px;
}
const heroDeckY = (x: number, z: number): number => heroTopY(z) - HERO_SHAPE.crown * (x / heroW(z)) ** 2;

function heroLoftSpec(): LoftSpec {
  const zs: number[] = [];
  const add = (z: number, tol: number): void => {
    if (z < -2.0 || z > 2.1) return;
    for (const e of zs) if (Math.abs(e - z) < tol) return;
    zs.push(z);
  };
  for (const z of [HERO_COWL, HERO_COWL - 0.045, HERO_HEAD + 0.045, HERO_HEAD, -0.36, -0.44, HERO_ROOF_END, HERO_ROOF_END - 0.04, -1.08, HERO_GLASS_END + 0.04, HERO_GLASS_END, -2.0, 2.1]) add(z, 0.001);
  for (const arch of HERO_SHAPE.arches) {
    const dz = Math.sqrt(arch.r * arch.r - (arch.cy - 0.3) ** 2);
    add(arch.cz - dz, 0.02);
    add(arch.cz + dz, 0.02);
    for (let k = 1; k < 12; k++) add(arch.cz + arch.r * Math.cos((k * Math.PI) / 12), 0.022);
  }
  for (let z = -2.0; z <= 2.1; z += 0.12) add(z, 0.07);
  zs.sort((p, q) => p - q);
  const ribs = zs.map(heroRib);
  const cap = (zt: number, yt: number, zb: number, yb: number): Rib => {
    const w = heroW((zt + zb) / 2) * (Math.abs(yt - yb) < 0.05 ? 0.93 : 1);
    const gb = w * 0.9;
    return { zt, yt, zb, yb, w, h: 0, gb, gt: gb };
  };
  // raked nose and tail faces: ribs whose top and bottom sit at different z, closed by a collapsed "bumper line" rib
  ribs.unshift(cap(-2.318, 0.805, -2.318, 0.8), cap(-2.3, 1.13, -2.17, 0.36), cap(-2.22, 1.15, -2.05, 0.3));
  ribs.push(cap(2.22, 0.87, 2.16, 0.3), cap(2.29, 0.8, 2.27, 0.4), cap(2.318, 0.605, 2.318, 0.6));
  const nr = ribs.length;
  const mid = (i: number): number => (ribs[i].zt + ribs[i + 1].zt) / 2;
  return {
    ...HERO_SHAPE,
    ribs,
    lo: false,
    label: 'hero.hull',
    hardIds: [RID.CH],
    hardRibs: [1, nr - 2],
    creaseAngle: 0.62,
    cell: (i, a, b) => {
      const z = mid(i);
      if (a >= RID.RI) {
        if (z > HERO_HEAD + 0.045 && z < HERO_COWL - 0.045) return 2; // windshield
        if (z > HERO_GLASS_END + 0.04 && z < HERO_ROOF_END - 0.04) return 2; // rear window (under the louvres)
        return 1;
      }
      if (a === RID.WB && b === RID.WT) {
        if (z > -0.36 && z < HERO_COWL - 0.045) return 2; // door glass + front quarter
        if (z > -1.08 && z < -0.44) return 2; // rear quarter window
      }
      return 1;
    },
    warp: (p, _i, id) => {
      const xn = p.x / HERO_W;
      if (p.z > 1.9) p.z -= 0.1 * xn * xn * sm(1.9, 2.25, p.z);
      if (p.z < -1.9) p.z += 0.06 * xn * xn * sm(-1.9, -2.2, p.z);
      // bowed windshield / roof header
      if (id >= RID.GB) p.z -= 0.1 * xn * xn * sm(-0.4, 0.1, p.z) * (1 - sm(HERO_COWL, 1.2, p.z));
    },
  };
}

/** Point on the windshield plane: x across, t = 0 at the cowl .. 1 at the header, `off` metres off the glass. */
const heroWindshield = (x: number, t: number, off: number): V3 => {
  const xn = x / HERO_W;
  return v(x, 1.03 + HERO_CAB * t - 0.035 * xn * xn + 0.807 * off, HERO_COWL - (HERO_COWL - HERO_HEAD) * t - 0.1 * xn * xn + 0.591 * off);
};

/** 7-segment stencil digit: lx 0..1 across, ly 0..1 up. */
function seg7(digit: number, lx: number, ly: number): boolean {
  if (lx < 0.12 || lx > 0.88 || ly < 0.04 || ly > 0.96) return false;
  const on = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'][digit] ?? '';
  const t = 0.17;
  const left = lx < 0.12 + t;
  const right = lx > 0.88 - t;
  const top = ly > 0.96 - t * 0.6;
  const bot = ly < 0.04 + t * 0.6;
  const midY = Math.abs(ly - 0.5) < t * 0.3;
  const upper = ly > 0.5;
  return (
    (top && on.includes('a')) ||
    (right && upper && on.includes('b')) ||
    (right && !upper && on.includes('c')) ||
    (bot && on.includes('d')) ||
    (left && !upper && on.includes('e')) ||
    (left && upper && on.includes('f')) ||
    (midY && on.includes('g'))
  );
}

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
};

/**
 * Paints the interceptor's unwrapped hull: sun-faded gunmetal, chipped burnt-orange stripe, stencils,
 * panel gaps, rivet rows, rust blooms at edges, dust on the lower body and tail, scratches.
 * Returns albedo (A = scorch field), ORM-style (R = scrape field, G = roughness, B = metalness) and a normal map.
 */
function buildHeroTextures(lo: LoftOut): { albedo: THREE.DataTexture; orm: THREE.DataTexture; normal: THREE.DataTexture } {
  const W = 1024;
  const H = 512;
  const { P, N, nr, nq, u, vv } = lo;
  const colI = new Int32Array(W);
  const colT = new Float32Array(W);
  for (let x = 0, i = 0; x < W; x++) {
    const uu = (x + 0.5) / W;
    while (i < nr - 2 && u[i + 1] < uu) i++;
    colI[x] = i;
    colT[x] = clamp01((uu - u[i]) / Math.max(1e-6, u[i + 1] - u[i]));
  }
  const rowQ = new Int32Array(H);
  const rowS = new Float32Array(H);
  for (let y = 0, q = 0; y < H; y++) {
    const v0 = (y + 0.5) / H;
    while (q < nq - 2 && vv[q + 1] < v0) q++;
    rowQ[y] = q;
    rowS[y] = clamp01((v0 - vv[q]) / Math.max(1e-6, vv[q + 1] - vv[q]));
  }
  const S = 256;
  const nA = fbmField(S, [[4, 0.5], [9, 0.3], [20, 0.2]], 301);
  const nB = fbmField(S, [[18, 0.4], [44, 0.35], [100, 0.25]], 302);
  const nC = fbmField(S, [[6, 0.5], [14, 0.3], [40, 0.2]], 303);

  const sideLines: [number, number, number, number][] = [
    [0.56, 0.36, 0.57, 1.0],
    [-0.5, 0.36, -0.53, 1.02],
    [0.56, 0.36, -0.5, 0.36],
    [1.99, 0.33, 2.03, 0.9],
    [-1.95, 0.33, -1.99, 1.1],
    [-1.62, 0.99, -1.48, 0.99],
    [-1.62, 1.07, -1.48, 1.07],
    [-1.62, 0.99, -1.62, 1.07],
    [-1.48, 0.99, -1.48, 1.07],
  ];
  const topLines: [number, number, number, number][] = [
    [0.76, 0.72, 0.74, 2.08],
    [0, 2.1, 0.74, 2.08],
    [0, 0.72, 0.76, 0.72],
    [0.64, -1.82, 0.62, -2.21],
    [0, -1.82, 0.64, -1.82],
    [0, -2.21, 0.62, -2.21],
  ];

  const albedo = new Uint8Array(W * H * 4);
  const orm = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  const GM = [0.204, 0.227, 0.255];
  const GMD = [0.1, 0.108, 0.12];
  const OR = [0.78, 0.33, 0.09];
  const ORW = [0.56, 0.29, 0.13];
  const DUST = [0.6, 0.45, 0.3];
  const RUST = [0.45, 0.23, 0.12];
  const RUSTD = [0.24, 0.14, 0.095];
  const BONE = [0.8, 0.76, 0.64];
  const col = [0, 0, 0];
  const mixTo = (c: number[], k: number, s = 1): void => {
    col[0] = lerp(col[0], c[0] * s, k);
    col[1] = lerp(col[1], c[1] * s, k);
    col[2] = lerp(col[2], c[2] * s, k);
  };
  const V_SL = RING_V[RID.SL];
  const V_BT = RING_V[RID.BT];
  const nc = nq - 1;
  for (let py = 0; py < H; py++) {
    const q = rowQ[py];
    const s = rowS[py];
    const v0 = (py + 0.5) / H;
    const vh = v0 < 0.5 ? v0 : 1 - v0;
    const under = vh < V_SL;
    const inboard = vh >= V_BT;
    for (let px = 0; px < W; px++) {
      const i = colI[px];
      const t = colT[px];
      const a = (i * nq + q) * 3;
      const b = ((i + 1) * nq + q) * 3;
      const c = (i * nq + q + 1) * 3;
      const d = ((i + 1) * nq + q + 1) * 3;
      const bl = (k: number): number => lerp(lerp(P[a + k], P[b + k], t), lerp(P[c + k], P[d + k], t), s);
      const x = bl(0);
      const y = bl(1);
      const z = bl(2);
      const ny = N[(i * nc + q) * 3 + 1];
      const n1 = fieldAt(nA, S, px * 0.25, py * 0.5);
      const n2 = fieldAt(nB, S, px * 0.9, py * 1.8);
      const n3 = fieldAt(nB, S, px * 0.31 + 70, py * 0.62 + 19);
      const n4 = fieldAt(nA, S, px * 0.6 + 11, py * 1.2 + 140);
      const topness = sm(0.35, 0.9, ny);
      let rough = 0.4;
      let metal = 0.62;
      let hgt = 0;
      let edge = 0;
      let groove = 0;
      let scrape = 0;
      const tone = 0.8 + 0.4 * n1;
      col[0] = GM[0] * tone;
      col[1] = GM[1] * tone;
      col[2] = GM[2] * tone;
      // sun fade: chalky and lighter where the paint faces the sky
      mixTo([0.34, 0.345, 0.34], topness * (0.22 + 0.34 * n3));
      rough += 0.16 * topness;
      if (under) {
        col[0] = 0.034;
        col[1] = 0.032;
        col[2] = 0.03;
        rough = 0.95;
        metal = 0.05;
      } else {
        if (!inboard) {
          // two-tone lower body + worn rocker pinstripe
          if (y < 0.5 + 0.02 * (n2 - 0.5)) {
            mixTo(GMD, 1, 0.8 + 0.4 * n1);
            rough = 0.58;
          }
          if (y > 0.535 && y < 0.572 && Math.abs(z) < 2.02 && n2 * 0.6 + n3 * 0.4 < 0.62) mixTo(ORW, 1, 0.9 + 0.3 * n1);
          for (const [z0, y0, z1, y1] of sideLines) {
            const dl = segDist(z, y, z0, y0, z1, y1);
            groove = Math.max(groove, 1 - sm(0.0035, 0.01, dl));
            edge = Math.max(edge, 1 - sm(0, 0.09, dl));
          }
          for (const arch of HERO_SHAPE.arches) edge = Math.max(edge, 1 - sm(0, 0.08, Math.abs(Math.hypot(z - arch.cz, y - arch.cy) - arch.r)));
          edge = Math.max(edge, 1 - sm(0.3, 0.4, y));
          // sill rivet row
          if (z > -0.82 && z < 0.9) {
            const lz = ((z % 0.15) + 0.15) % 0.15 - 0.075;
            const rv = 1 - sm(0.006, 0.012, Math.hypot(lz, y - 0.345));
            if (rv > 0) {
              mixTo([col[0] * 1.6 + 0.05, col[1] * 1.6 + 0.05, col[2] * 1.6 + 0.05], rv);
              hgt += 1.1 * rv;
            }
          }
        } else {
          const ax = Math.abs(x);
          // burnt-orange offset stripe with chipped edges, dark keyline and pinstripe
          const chipA = (n2 - 0.5) * 0.034;
          const chipB = (n4 - 0.5) * 0.03;
          const holes = n3 * 0.55 + n2 * 0.45 > 0.68;
          if (x > 0.25 + chipA && x < 0.51 + chipB) {
            if (holes) mixTo([0.3, 0.29, 0.28], 0.85);
            else {
              mixTo(OR, 1, 0.86 + 0.28 * n1);
              mixTo(ORW, 0.55 * n3 + 0.25 * topness);
              rough = 0.46 + 0.14 * topness;
              metal = 0.3;
            }
          } else if (x > 0.555 + chipB && x < 0.59 + chipA && !holes) {
            mixTo(ORW, 1, 0.9 + 0.3 * n1);
            metal = 0.3;
          } else if (x > 0.2 + chipB && x < 0.235) mixTo(GMD, 0.9);
          // stencilled unit number: roof (reads from the chase camera) and hood (reads from the front)
          let stencil = false;
          if (z > -0.52 && z < -0.16 && x < -0.3 && x > -0.58) {
            const gx = (-0.3 - x) / 0.14;
            stencil = seg7(gx < 1 ? 0 : 7, gx % 1, (z + 0.52) / 0.36);
          } else if (z > 1.3 && z < 1.84 && x > -0.64 && x < -0.24) {
            const gx = (x + 0.64) / 0.2;
            stencil = seg7(gx < 1 ? 0 : 7, gx % 1, (1.84 - z) / 0.54);
          }
          if (stencil && n2 * 0.5 + n4 * 0.5 < 0.6) {
            mixTo(BONE, 0.92, 0.85 + 0.2 * n1);
            metal = 0.1;
            rough = 0.62;
          }
          for (const [x0, z0, x1, z1] of topLines) {
            const dl = segDist(ax, z, x0, z0, x1, z1);
            groove = Math.max(groove, 1 - sm(0.0035, 0.01, dl));
            edge = Math.max(edge, 1 - sm(0, 0.08, dl));
          }
          // rivet rows: hood edges, roof header and tail of the roof
          let dr = 1;
          if (z > 0.8 && z < 2.02) dr = Math.hypot(((z % 0.13) + 0.13) % 0.13 - 0.065, ax - 0.815);
          if (ax < 0.56 && z < 0.2) {
            const lx = ((ax % 0.11) + 0.11) % 0.11 - 0.055;
            dr = Math.min(dr, Math.hypot(lx, z + 0.01), Math.hypot(lx, z + 0.665));
          }
          const rv = 1 - sm(0.006, 0.012, dr);
          if (rv > 0) {
            mixTo([col[0] * 1.6 + 0.05, col[1] * 1.6 + 0.05, col[2] * 1.6 + 0.05], rv);
            hgt += 1.1 * rv;
          }
        }
        // hazard band low on the tail face
        if (z < -2.19 && y > 0.4 && y < 0.6) {
          const band = Math.floor((x + y * 0.9 + 4) / 0.11) % 2 === 0;
          if (n2 * 0.5 + n3 * 0.5 < 0.64) {
            if (band) mixTo([0.8, 0.58, 0.14], 0.95, 0.85 + 0.3 * n1);
            else mixTo([0.05, 0.05, 0.05], 0.95);
            metal = 0.2;
            rough = 0.6;
          }
        }
        // rust blooms creep out of panel edges, arches and the sill
        const rustM = sm(0.6, 0.78, 0.5 * n3 + 0.28 * n2 + 0.44 * edge + 0.1 * (1 - n1));
        if (rustM > 0) {
          mixTo([lerp(RUSTD[0], RUST[0], n2), lerp(RUSTD[1], RUST[1], n2), lerp(RUSTD[2], RUST[2], n2)], rustM * 0.92);
          rough = lerp(rough, 0.9, rustM);
          metal = lerp(metal, 0.2, rustM);
          hgt -= 0.5 * rustM * n2;
        }
        // dust: heavy on the lower body, drifting over the tail, a film on flat tops
        const dust = Math.min(0.9, 0.95 * sm(0.98, 0.33, y) * (0.25 + 0.95 * n1) + 0.55 * sm(-1.0, -2.3, z) * (0.3 + n3) + 0.2 * topness * n4);
        mixTo(DUST, dust, 0.85 + 0.3 * n2);
        rough = lerp(rough, 0.95, dust);
        metal *= 1 - 0.92 * dust;
        // panel gaps
        col[0] *= 1 - 0.9 * groove;
        col[1] *= 1 - 0.9 * groove;
        col[2] *= 1 - 0.9 * groove;
        rough = lerp(rough, 0.92, groove);
        hgt -= 1.6 * groove;
        const cs = fieldAt(nC, S, px * 0.3, py * 3.2);
        const ridge = 1 - Math.abs(2 * cs - 1);
        scrape = clamp01(Math.pow(ridge, 4) * 0.82 + 0.3 * edge + 0.16 * n2 + 0.22 * sm(1.7, 2.3, Math.abs(z)) + 0.12 * sm(0.62, 0.32, y));
      }
      const scorch = clamp01(0.72 * sm(0.22, 0.8, fieldAt(nA, S, px * 0.2 + 40, py * 0.4 + 90)) + 0.16 * n2 + 0.3 * Math.exp(-(((z - 1.25) / 0.8) ** 2)) * topness);
      const o = (py * W + px) * 4;
      albedo[o] = Math.round(clamp01(col[0]) * 255);
      albedo[o + 1] = Math.round(clamp01(col[1]) * 255);
      albedo[o + 2] = Math.round(clamp01(col[2]) * 255);
      albedo[o + 3] = Math.round(scorch * 255);
      orm[o] = Math.round(scrape * 255);
      orm[o + 1] = Math.round(clamp01(rough + 0.12 * (n2 - 0.5)) * 255);
      orm[o + 2] = Math.round(clamp01(metal) * 255);
      orm[o + 3] = 255;
      height[py * W + px] = hgt + 0.25 * n2 + 0.5 * n1;
    }
  }
  // scratches: bare-metal strokes, mostly along the travel direction
  const rand = rng(4711);
  for (let k = 0; k < 240; k++) {
    let x = rand() * W;
    let y = (0.05 + rand() * 0.9) * H;
    const ang = (rand() - 0.5) * 0.5 + (rand() < 0.15 ? 1.2 : 0);
    const len = 20 + rand() * 150;
    const deep = rand() < 0.5;
    for (let t = 0; t < len; t++) {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      if (xi < 0 || xi >= W || yi < 0 || yi >= H) break;
      const vh = Math.min((yi + 0.5) / H, 1 - (yi + 0.5) / H);
      if (vh > V_SL) {
        const o = (yi * W + xi) * 4;
        const k2 = deep ? 0.7 : 0.35;
        for (let ch = 0; ch < 3; ch++) albedo[o + ch] = Math.round(lerp(albedo[o + ch], 132, k2));
        orm[o] = 255;
        orm[o + 1] = Math.round(lerp(orm[o + 1], 90, k2));
        orm[o + 2] = Math.round(lerp(orm[o + 2], 235, k2));
        height[yi * W + xi] -= deep ? 0.9 : 0.4;
      }
      x += Math.cos(ang);
      y += Math.sin(ang) * 0.5;
    }
  }
  // dents
  for (let k = 0; k < 18; k++) {
    const cx = rand() * W;
    const cy = (0.06 + rand() * 0.88) * H;
    const rad = 10 + rand() * 26;
    const depth = 1.2 + rand() * 1.6;
    const x0 = Math.max(0, Math.floor(cx - rad * 2));
    const x1 = Math.min(W - 1, Math.ceil(cx + rad * 2));
    const y0 = Math.max(0, Math.floor(cy - rad));
    const y1 = Math.min(H - 1, Math.ceil(cy + rad));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dd = ((x - cx) / (rad * 2)) ** 2 + ((y - cy) / rad) ** 2;
        if (dd < 1) height[y * W + x] -= depth * (1 - dd) * (1 - dd);
      }
    }
  }
  return {
    albedo: dataTexture(albedo, W, H, true, false),
    orm: dataTexture(orm, W, H, false, false),
    normal: dataTexture(heightToNormal(height, W, H, 1.5, false), W, H, false, false),
  };
}

type HeroBlueprint = Blueprint & { hull: LoftOut };
let heroBlueprint: HeroBlueprint | null = null;
let heroTextures: { albedo: THREE.DataTexture; orm: THREE.DataTexture; normal: THREE.DataTexture } | null = null;

function buildHero(): HeroBlueprint {
  const a = new Asm(11, 'hero');
  const WR = HERO_WR;
  const FZ = HERO_FZ;
  const RZ = HERO_RZ;
  const outX = v(1, 0, 0);
  const inX = v(-1, 0, 0);
  const extras: Extra[] = [];

  // --- sculpted hull: lofted ribs (tumblehome, shoulder crease, fender bulges, pinched waist, raked nose, fastback)
  const hull = loftBody(heroLoftSpec());
  const paintGeo = sanitize(hull.body as THREE.BufferGeometry, 'hero.paint');
  const glassGeo = sanitize(hull.glass as THREE.BufferGeometry, 'hero.glass');
  const sx = (y: number, z: number): number => heroSideX(y, z) + 0.002;
  const roofY = heroTopY(-0.3) + HERO_CAB + 0.022;

  // --- dark interior behind the tinted glass: floor, dash, seats, harness, wheel, cage
  const trim = look(0x0c0c0d, 0.85, 0.05, 0.04);
  a.add('kit', box(1.5, 0.04, 2.5), trim, { p: [0, 0.47, -0.55] });
  a.add('kit', box(1.56, 0.22, 0.34), trim, { p: [0, 0.94, 0.56] });
  a.add('kit', box(0.5, 0.05, 0.2), look(0x1d1f22, 0.5, 0.4, 0), { p: [0.38, 1.06, 0.5], r: [0.5, 0, 0] });
  a.add('kit', box(1.4, 0.04, 0.7), trim, { p: [0, 1.02, -1.35] });
  a.add('kit', box(0.26, 0.3, 1.5), trim, { p: [0, 0.62, -0.1] });
  for (const s of [1, -1]) {
    const seatLook = L.leather;
    a.add('kit', box(0.46, 0.12, 0.48), seatLook, { p: [s * 0.4, 0.6, 0.0] });
    a.add('kit', box(0.44, 0.62, 0.11), seatLook, { p: [s * 0.4, 0.95, -0.27], r: [-0.17, 0, 0] });
    a.add('kit', box(0.07, 0.5, 0.2), seatLook, { p: [s * 0.4 + 0.22, 0.92, -0.2], r: [-0.17, 0, 0] });
    a.add('kit', box(0.07, 0.5, 0.2), seatLook, { p: [s * 0.4 - 0.22, 0.92, -0.2], r: [-0.17, 0, 0] });
    a.add('kit', box(0.25, 0.17, 0.09), seatLook, { p: [s * 0.4, 1.31, -0.34], r: [-0.1, 0, 0] });
    // harness straps read as colour through the glass
    for (const hx of [-0.09, 0.09]) a.add('kit', box(0.05, 0.56, 0.012), look(C.orangeWorn, 0.9, 0, 0.05), { p: [s * 0.4 + hx, 0.97, -0.2], r: [-0.17, 0, 0] });
  }
  const wheelXf: Xf = { p: [0.4, 1.06, 0.33], r: [-1.05, 0, 0] };
  a.add('kit', new THREE.TorusGeometry(0.165, 0.018, 5, 14), look(0x18191b, 0.6, 0.2, 0), wheelXf);
  a.add('kit', box(0.3, 0.03, 0.02), L.steel, wheelXf);
  a.add('kit', rod(v(0.4, 1.06, 0.33), v(0.4, 0.92, 0.6), 0.02, 5), L.steelDark);
  a.add('kit', rod(v(0.02, 0.6, 0.18), v(0.02, 0.86, 0.14), 0.014, 4), L.steel);
  a.add('kit', weld(v(0.02, 0.88, 0.14), 0.035), look(C.orange, 0.5, 0.1, 0));
  // roll cage: main hoop, halo, rear stays, door bars, with weld nodes at the joints
  const cage = look(0x54585d, 0.42, 0.85, 0.06);
  const hoopZ = -0.5;
  a.add('kit', tube([v(0.74, 0.5, hoopZ), v(0.72, 1.12, hoopZ), v(0.56, roofY - 0.085, hoopZ), v(-0.56, roofY - 0.085, hoopZ), v(-0.72, 1.12, hoopZ), v(-0.74, 0.5, hoopZ)], 0.028, 6, 3, 0.2), cage);
  a.addM('kit', tube([v(0.56, roofY - 0.085, hoopZ), v(0.54, roofY - 0.09, 0.02), v(0.7, 1.08, 0.5), v(0.74, 0.52, 0.56)], 0.024, 5, 3, 0.25), cage);
  a.add('kit', rod(v(-0.54, roofY - 0.09, 0.03), v(0.54, roofY - 0.09, 0.03), 0.022, 5), cage);
  a.addM('kit', rod(v(0.5, roofY - 0.1, hoopZ), v(0.56, 1.06, -1.55), 0.024, 5), cage);
  a.addM('kit', rod(v(0.75, 0.62, 0.5), v(0.73, 0.98, hoopZ), 0.022, 5), cage);
  a.add('kit', rod(v(-0.7, 1.14, hoopZ), v(0.62, 0.56, hoopZ), 0.022, 5), cage);
  for (const [wx, wy, wz] of [
    [0.56, roofY - 0.085, hoopZ],
    [0.54, roofY - 0.09, 0.03],
    [0.72, 1.12, hoopZ],
    [0.73, 0.98, hoopZ],
  ] as T3[]) {
    a.addM('kit', weld(v(wx, wy, wz), 0.042), L.weld);
  }

  // --- windshield furniture: wipers, cowl vent, header visor strip
  for (const [x0, x1] of [
    [0.52, 0.12],
    [-0.08, -0.48],
  ] as P2[]) {
    a.add('kit', rod(heroWindshield(x0, 0.02, 0.018), heroWindshield(x1, 0.2, 0.014), 0.008, 4), L.matte);
    a.add('kit', beam(heroWindshield(lerp(x0, x1, 0.45), 0.1, 0.012), heroWindshield(x1, 0.2, 0.01), 0.022, 0.008), L.matte);
    a.add('kit', weld(heroWindshield(x0, 0.015, 0.012), 0.022), L.steelDark);
  }
  for (let i = -3; i <= 3; i++) a.add('kit', box(0.14, 0.008, 0.035), L.matte, { p: [i * 0.18, heroDeckY(i * 0.18, 0.78) + 0.004, 0.78 - 0.1 * ((i * 0.18) / HERO_W) ** 2] });

  // --- mirrors (the driver's one is knocked off by heavy damage), door handles, hood pins
  const mirror = (s: number, target: Asm): void => {
    const mx = s * (sx(1.06, 0.5) + 0.1);
    target.add('kit', rod(v(s * sx(1.06, 0.55), 1.06, 0.56), v(mx, 1.12, 0.53), 0.014, 4), L.steelDark);
    target.add('kit', box(0.06, 0.11, 0.17), look(C.gunmetalDark, 0.5, 0.6, 0), { p: [mx, 1.14, 0.52] });
    target.add('kit', box(0.045, 0.085, 0.012), look(0x9aa3ab, 0.08, 1, 0), { p: [mx, 1.14, 0.432] });
  };
  mirror(-1, a);
  const mirrorAsm = new Asm(31, 'hero.mirror');
  mirror(1, mirrorAsm);
  extras.push({ name: 'mirrorLeft', geo: mirrorAsm.build('kit') as THREE.BufferGeometry, parent: 'body', hideAt: 0.6 });
  for (const s of [1, -1]) {
    a.add('kit', box(0.018, 0.026, 0.13), L.chrome, { p: [s * (sx(1.0, -0.36) + 0.006), 1.0, -0.36] });
    a.add('kit', cylY(0.011, 0.011, 0.04, 6), L.chrome, { p: [s * 0.5, heroDeckY(0.5, 1.96) + 0.02, 1.96] });
    a.add('kit', box(0.06, 0.006, 0.05), L.steel, { p: [s * 0.5, heroDeckY(0.5, 1.96) + 0.004, 1.96] });
    a.add('kit', rod(v(s * 0.5, heroDeckY(0.5, 1.96) + 0.035, 1.96), v(s * 0.56, heroDeckY(0.56, 1.9) + 0.006, 1.9), 0.004, 3), L.steelDark);
  }

  // --- bolt-on fender flares with rivets, arch liners come from the hull's recessed tubs
  const flare = look(0x16181a, 0.62, 0.55, 0.05);
  for (const [cz, lipX, rOut] of [
    [FZ, HERO_W + 0.05, 0.6],
    [RZ, HERO_W * 0.99 + 0.065, 0.62],
  ] as T3[]) {
    a.addM('kit', archFlare(0.49, rOut, 0.24, 0.18), flare, { p: [lipX - 0.06, WR, cz] });
    const pts: V3[] = [];
    for (let i = 0; i < 7; i++) {
      const ang = lerp(0.1, Math.PI - 0.1, i / 6);
      pts.push(v(lipX + 0.042, WR + 0.535 * Math.sin(ang), cz + 0.535 * Math.cos(ang)));
    }
    scatterBolts(a, pts, 0.026, outX, L.steel);
    scatterBolts(a, pts.map((p) => v(-p.x, p.y, p.z)), 0.026, inX, L.steel);
  }
  // mud flaps behind every wheel
  for (const [fx, fz] of [
    [0.87, FZ - 0.55],
    [0.86, RZ - 0.56],
  ] as P2[]) {
    a.addM('kit', box(0.3, 0.3, 0.018), L.rubber, { p: [fx, 0.34, fz], r: [0.12, 0, 0] });
    a.addM('kit', box(0.3, 0.03, 0.03), L.steelDark, { p: [fx, 0.49, fz + 0.016] });
  }
  // rock sliders along the sill
  a.addM('kit', tube([v(0.9, 0.36, 0.86), v(1.0, 0.33, 0.66), v(1.0, 0.33, -0.62), v(0.9, 0.36, -0.82)], 0.036, 6, 3, 0.25), look(0x2a2c2f, 0.5, 0.8, 0.06));
  for (const bz of [0.5, 0.0, -0.5]) a.addM('kit', rod(v(0.86, 0.36, bz), v(1.0, 0.33, bz), 0.022, 4), L.steelDark);

  // --- nose: mesh grille with lamps behind the bars, bull bar, tow hooks
  const noseZ = (x: number, y: number): number => lerp(2.3, 2.318, sm(0.8, 0.62, y)) - 0.1 * (x / HERO_W) ** 2;
  for (const [gx, gw, ry] of [
    [0, 0.72, 0],
    [0.56, 0.44, 0.22],
    [-0.56, 0.44, -0.22],
  ] as T3[]) {
    a.add('kit', box(gw, 0.2, 0.05), L.matte, { p: [gx, 0.7, noseZ(gx, 0.7) + 0.004], r: [0, ry, 0] });
  }
  for (const lx of [0.45, 0.66]) {
    const z = noseZ(lx, 0.7);
    a.addM('kit', cylZ(0.085, 0.09, 0.05, 10, true), L.steelDark, { p: [lx, 0.7, z + 0.03] });
    a.addM('head', cylZ(0.06, 0.075, 0.03, 10), L.lens, { p: [lx, 0.7, z + 0.035] });
  }
  for (let i = 0; i < 5; i++) {
    const y = 0.624 + i * 0.038;
    a.add('kit', tube([v(-0.8, y, noseZ(0.8, y) + 0.05), v(-0.42, y, noseZ(0.42, y) + 0.062), v(0, y, noseZ(0, y) + 0.066), v(0.42, y, noseZ(0.42, y) + 0.062), v(0.8, y, noseZ(0.8, y) + 0.05)], 0.0075, 4, 2, 0.4), L.steel);
  }
  for (let i = -6; i <= 6; i++) {
    const x = i * 0.125;
    a.add('kit', box(0.012, 0.19, 0.012), L.steelDark, { p: [x, 0.7, noseZ(x, 0.7) + 0.058] });
  }
  a.add('kit', box(0.5, 0.05, 0.02), look(C.orange, 0.6, 0.3, 0), { p: [0, 0.84, noseZ(0, 0.84) + 0.012] });
  const barLook = look(0x2a2c2f, 0.5, 0.8, 0.06);
  // upper hoop is its own mesh: it gets torn off when the car is badly hit
  const bar = new Asm(32, 'hero.bullbar');
  bar.add('kit', tube([v(-0.99, 0.74, 1.95), v(-0.84, 0.88, 2.42), v(-0.3, 0.9, 2.5), v(0.3, 0.9, 2.5), v(0.84, 0.88, 2.42), v(0.99, 0.74, 1.95)], 0.034, 6, 3), barLook);
  bar.addM('kit', rod(v(0.84, 0.44, 2.4), v(0.84, 0.88, 2.42), 0.028, 5), barLook);
  bar.addM('kit', weld(v(0.84, 0.88, 2.42), 0.045), L.weld);
  extras.push({ name: 'bullBarHoop', geo: bar.build('kit') as THREE.BufferGeometry, parent: 'body', hideAt: 0.75 });
  a.addM('accent', box(0.07, 0.035, 0.05), paint(0xffffff, 0), { p: [0.6, 0.46, 2.5] });
  a.add('kit', tube([v(-0.93, 0.44, 2.05), v(-0.78, 0.44, 2.44), v(-0.3, 0.44, 2.5), v(0.3, 0.44, 2.5), v(0.78, 0.44, 2.44), v(0.93, 0.44, 2.05)], 0.04, 6, 3), barLook);
  a.addM('kit', rod(v(0.36, 0.3, 2.44), v(0.36, 0.93, 2.5), 0.036, 6, 0.036, false), barLook);
  a.addM('kit', weld(v(0.36, 0.44, 2.5), 0.05), L.weld);
  a.addM('kit', weld(v(0.36, 0.9, 2.5), 0.046), L.weld);
  a.add('kit', plate([v(-0.36, 0.3, 2.42), v(0.36, 0.3, 2.42), v(0.36, 0.55, 2.5), v(-0.36, 0.55, 2.5)], 0.02, AXIS_Z), L.rustDark);
  for (let i = -2; i <= 2; i++) a.add('kit', box(0.07, 0.15, 0.012), L.matte, { p: [i * 0.13, 0.43, 2.49], r: [-0.3, 0, 0] });
  a.addM('kit', beam(v(0.36, 0.5, 2.26), v(0.36, 0.5, 2.46), 0.05, 0.1), L.steelDark);
  const hook = new THREE.TorusGeometry(0.045, 0.014, 5, 8, Math.PI * 1.4);
  a.addM('kit', hook, look(0xa3271a, 0.5, 0.5, 0), { p: [0.56, 0.36, 2.4], r: [Math.PI / 2, 0, -0.6] });
  a.add('kit', hook.clone(), look(0xa3271a, 0.5, 0.5, 0), { p: [0.0, 0.38, -2.44], r: [Math.PI / 2, 0, 2.2] });

  // --- hood: blower case, belt drive, bug-catcher intake
  const BZ = 1.12;
  a.add('kit', box(0.5, 0.03, 0.66), L.steelDark, { p: [0, 1.03, BZ] });
  a.add('kit', box(0.34, 0.15, 0.52), L.alloy, { p: [0, 1.11, BZ] });
  for (let i = 0; i < 6; i++) a.addM('kit', box(0.02, 0.13, 0.03), L.steel, { p: [0.178, 1.11, BZ - 0.21 + i * 0.084] });
  a.add('kit', cylZ(0.085, 0.085, 0.05, 10), L.steelDark, { p: [0, 1.13, BZ + 0.3] });
  a.add('kit', cylZ(0.06, 0.06, 0.05, 8), L.steelDark, { p: [0.1, 1.02, BZ + 0.3] });
  a.add('kit', beam(v(-0.07, 1.16, BZ + 0.3), v(0.05, 1.03, BZ + 0.3), 0.04, 0.012, AXIS_Z), L.rubber);
  let scoop = profileX(
    [
      [0.25, 0],
      [0.26, 0.16],
      [0.12, 0.2],
      [-0.24, 0.07],
      [-0.26, 0],
    ],
    0.36,
    0.012,
    1,
    1,
  );
  scoop = toCreasedNormals(scoop, 0.5);
  a.add('kit', scoop, look(0x8b8e92, 0.3, 0.95, 0), { p: [0, 1.185, BZ] });
  a.add('kit', box(0.3, 0.115, 0.02), L.matte, { p: [0, 1.27, BZ + 0.252] });
  for (const bx of [-0.1, -0.03, 0.04, 0.11]) a.add('kit', box(0.012, 0.115, 0.03), L.steel, { p: [bx, 1.27, BZ + 0.255] });
  a.add('accent', box(0.2, 0.012, 0.03), paint(0xffffff, 0), { p: [0, 1.35, BZ + 0.2], r: [-0.25, 0, 0] });
  scatterBolts(a, outlinePts([v(-0.25, 1.046, BZ - 0.33), v(0.25, 1.046, BZ - 0.33), v(0.25, 1.046, BZ + 0.33), v(-0.25, 1.046, BZ + 0.33)], 0.11, 0.03), 0.022, AXIS_Y, L.steel);
  // hood louvre vents either side of the blower
  for (const s of [1, -1]) for (let i = 0; i < 4; i++) a.add('kit', box(0.2, 0.012, 0.05), L.matte, { p: [s * 0.56, heroDeckY(0.56, 1.5 - i * 0.09) + 0.008, 1.5 - i * 0.09], r: [-0.35, 0, 0] });

  // --- bolted door armour with rivet rows (different each side), driver-side window slat
  const doorPlate = (s: number): void => {
    const poly = [v(sx(0.52, 0.4), 0.52, 0.42), v(sx(0.97, 0.4), 0.97, 0.46), v(sx(0.98, -0.3), 0.98, -0.3), v(sx(0.9, -0.42), 0.9, -0.44), v(sx(0.5, -0.42), 0.5, -0.42)].map((p) => v(p.x * s, p.y, p.z));
    const out = v(s, 0, 0);
    a.add('kit', plate(poly, 0.022, out), look(0x3d3f42, 0.62, 0.7, 0.05));
    scatterBolts(a, outlinePts(poly, 0.115, 0.045).map((p) => p.addScaledVector(out, 0.023)), 0.026, out, L.steel);
  };
  doorPlate(1);
  doorPlate(-1);
  a.add('kit', plate([v(sx(0.6, 0.2) + 0.022, 0.6, 0.2), v(sx(0.9, 0.2) + 0.022, 0.9, 0.26), v(sx(0.88, -0.3) + 0.022, 0.88, -0.3), v(sx(0.56, -0.3) + 0.022, 0.56, -0.26)], 0.018, outX), L.rust);
  a.add('kit', plate([v(-sx(0.56, -0.02) - 0.022, 0.56, -0.02), v(-sx(0.82, -0.02) - 0.022, 0.82, 0.02), v(-sx(0.84, -0.4) - 0.022, 0.84, -0.4), v(-sx(0.6, -0.4) - 0.022, 0.6, -0.38)], 0.018, inX), L.rustDark);
  // welded patch on the right rear quarter + kill tally scratched into the left fender
  const patch = [v(-sx(0.96, -0.72), 0.96, -0.66), v(-sx(1.04, -0.72), 1.04, -0.7), v(-sx(1.03, -1.0), 1.03, -1.02), v(-sx(0.97, -1.0), 0.97, -0.98)];
  a.add('kit', plate(patch, 0.014, inX), L.rustDark);
  scatterBolts(a, outlinePts(patch, 0.09, 0.02).map((p) => p.add(v(-0.016, 0, 0))), 0.02, inX, L.steel);
  for (let i = 0; i < 5; i++) {
    const tz = 0.98 - i * 0.045;
    const g = decal([v(0, 0.94, tz), v(0, 0.94, tz - 0.014), v(0, 1.02, tz - 0.024), v(0, 1.02, tz - 0.01)], outX);
    a.add('kit', g, look(C.bone, 0.8, 0, 0.1), { p: [sx(0.98, tz) + 0.004, 0, 0] });
  }
  // window slat armour on the driver side (deliberate asymmetry), still leaves the interior readable
  const gxAt = (y: number): number => lerp(0.83, 0.664, (y - 1.03) / HERO_CAB) + 0.012;
  a.add('kit', plate([v(gxAt(1.09), 1.09, 0.4), v(gxAt(1.19), 1.19, 0.28), v(gxAt(1.19), 1.19, -0.3), v(gxAt(1.09), 1.09, -0.3)], 0.016, outX), L.rustDark);
  scatterBolts(a, [v(gxAt(1.14) + 0.018, 1.14, 0.2), v(gxAt(1.14) + 0.018, 1.14, -0.05), v(gxAt(1.14) + 0.018, 1.14, -0.26)], 0.024, outX, L.steel);

  // --- louvred rear window (one slat rattles loose at high damage)
  for (let i = 0; i < 6; i++) {
    const t = (i + 0.5) / 6;
    const y = lerp(roofY - 0.01, heroTopY(HERO_GLASS_END), t) + 0.04;
    const z = lerp(HERO_ROOF_END - 0.03, HERO_GLASS_END + 0.03, t);
    const halfW = 0.83 - 0.166 * (1 - t) - 0.1;
    const slat = box(halfW * 2, 0.014, 0.2);
    if (i === 2) {
      const la = new Asm(33, 'hero.louver');
      la.add('kit', slat, L.blackMetal, { p: [0, y, z], r: [-0.1, 0, 0] });
      extras.push({ name: 'louverLoose', geo: la.build('kit') as THREE.BufferGeometry, parent: 'body', hideAt: 0.9 });
    } else a.add('kit', slat, L.blackMetal, { p: [0, y, z], r: [-0.1, 0, i === 4 ? 0.012 : 0] });
  }
  a.addM('kit', beam(v(0.6, roofY, -0.76), v(0.74, 1.135, -1.78), 0.035, 0.05), L.steelDark);
  a.add('kit', beam(v(0, roofY + 0.005, -0.76), v(0, 1.14, -1.78), 0.03, 0.04), L.steelDark);

  // --- tail: light bar, bumper tube, quad heat-blued exhaust tips, diffuser, plate
  const tailZ = (x: number): number => -2.305 + 0.06 * (x / HERO_W) ** 2;
  for (const [tx, tw, ry] of [
    [0, 0.8, 0],
    [0.58, 0.42, -0.13],
    [-0.58, 0.42, 0.13],
  ] as T3[]) {
    a.add('kit', box(tw, 0.17, 0.04), L.matte, { p: [tx, 0.95, tailZ(tx) - 0.004], r: [0, ry, 0] });
    a.add('tail', box(tw - 0.05, 0.055, 0.03), L.lens, { p: [tx, 0.965, tailZ(tx) - 0.02], r: [0, ry, 0] });
  }
  for (let i = -3; i <= 3; i++) a.add('kit', box(0.02, 0.075, 0.036), L.matte, { p: [i * 0.2, 0.965, tailZ(i * 0.2) - 0.022] });
  a.add('kit', tube([v(-0.92, 0.5, -2.02), v(-0.8, 0.5, -2.4), v(0.8, 0.5, -2.4), v(0.92, 0.5, -2.02)], 0.04, 6, 3), barLook);
  a.addM('kit', beam(v(0.5, 0.5, -2.2), v(0.5, 0.5, -2.4), 0.05, 0.09), L.steelDark);
  a.addM('kit', weld(v(0.5, 0.5, -2.4), 0.05), L.weld);
  a.add('kit', box(0.34, 0.12, 0.012), L.bone, { p: [0, 0.74, -2.325], r: [0.1, 0, 0] });
  a.addM('accent', box(0.03, 0.04, 0.09), paint(0xffffff, 0), { p: [0.925, 0.86, -2.1] });
  a.addM('accent', box(0.03, 0.04, 0.09), paint(0xffffff, 0), { p: [0.9, 0.82, 2.02] });
  // quad tips: straw -> purple -> blue heat bands toward the outlet
  const blued = (len: number): THREE.BufferGeometry => {
    const g = cylZ(0.05, 0.046, len, 10, true);
    const cols = [new THREE.Color(0x6b6e73), new THREE.Color(0x9a7a3a), new THREE.Color(0x6a3f7a), new THREE.Color(0x2f4f9a), new THREE.Color(0x3b4046)];
    return tint(g, (p) => {
      const t = clamp01(0.5 - p.z / len) * (cols.length - 1);
      const i = Math.min(cols.length - 2, Math.floor(t));
      return cols[i].clone().lerp(cols[i + 1], t - i);
    });
  };
  for (const ex of [0.4, 0.53]) {
    a.addM('kit', blued(0.34), look(0x6b6e73, 0.28, 1, 0), { p: [ex, 0.37, -2.26] });
    a.addM('kit', cylZ(0.044, 0.044, 0.01, 8), L.matte, { p: [ex, 0.37, -2.36] });
    a.addM('kit', cylZ(0.056, 0.056, 0.03, 10, true), L.chrome, { p: [ex, 0.37, -2.42] });
  }
  a.addM('kit', box(0.3, 0.02, 0.05), L.steelDark, { p: [0.465, 0.43, -2.2] });
  // diffuser: raked plate with fins between the pipes
  a.add('kit', plate([v(-0.32, 0.28, -1.95), v(0.32, 0.28, -1.95), v(0.32, 0.36, -2.34), v(-0.32, 0.36, -2.34)], 0.016, v(0, -1, 0)), L.blackMetal);
  for (let i = -2; i <= 2; i++) a.add('kit', plate([v(i * 0.13, 0.27, -1.98), v(i * 0.13, 0.36, -2.36), v(i * 0.13, 0.22, -2.36), v(i * 0.13, 0.22, -2.02)], 0.012, outX), L.steelDark);

  // --- deck cargo: strapped spare, jerry cans, rack rail, whip antenna with pennant
  const spare = new THREE.TorusGeometry(0.27, 0.115, 7, 14);
  const spareXf: Xf = { p: [0.36, 1.31, -1.92], r: [-Math.PI / 2 + 0.16, 0, 0.05] };
  a.add('kit', spare, L.rubber, spareXf);
  a.add('kit', cylZ(0.17, 0.17, 0.12, 10), L.steelDark, spareXf);
  a.add('kit', box(0.06, 0.03, 0.8), L.cloth, { p: [0.36, 1.435, -1.92], r: [0.16, 0, 0.05] });
  a.add('kit', box(0.8, 0.03, 0.06), L.cloth, { p: [0.36, 1.435, -1.92], r: [0.16, 0, 0.05] });
  for (const [cz, lk] of [
    [-1.93, L.canRed],
    [-2.11, L.olive],
  ] as [number, Look][]) {
    a.add('kit', box(0.4, 0.3, 0.14), lk, { p: [-0.42, 1.31, cz] });
    a.add('kit', box(0.3, 0.2, 0.15), look(lk.c, lk.r, lk.m, 0.2), { p: [-0.42, 1.31, cz] });
    a.add('kit', cylY(0.025, 0.025, 0.05, 6), L.steelDark, { p: [-0.55, 1.48, cz] });
    a.add('kit', box(0.16, 0.025, 0.03), L.steelDark, { p: [-0.4, 1.48, cz] });
  }
  a.add('kit', box(0.03, 0.34, 0.36), L.cloth, { p: [-0.42, 1.31, -2.02] });
  a.add('kit', tube([v(-0.68, 1.14, -1.82), v(-0.68, 1.31, -1.84), v(-0.68, 1.31, -2.2), v(-0.68, 1.15, -2.24)], 0.016, 4, 2, 0.2), L.steelDark);
  a.add('kit', tube([v(-0.16, 1.14, -1.82), v(-0.16, 1.31, -1.84), v(-0.16, 1.31, -2.2), v(-0.16, 1.15, -2.24)], 0.016, 4, 2, 0.2), L.steelDark);
  a.add('kit', cylY(0.022, 0.028, 0.1, 6), L.steelDark, { p: [-0.8, 1.14, -1.62] });
  a.add('kit', rod(v(-0.8, 1.17, -1.62), v(-0.85, 2.55, -2.05), 0.009, 4, 0.004), L.steelDark);
  a.add('kit', rag(0.34, 0.14, 0.05, 5), look(C.orange, 0.9, 0, 0.05), { p: [-0.85, 2.52, -2.05], r: [0, Math.PI / 2 + 0.2, 0] });

  // --- roof: light bar (lamps share the headlight material but sit dark), amber markers
  a.add('kit', box(0.96, 0.075, 0.11), L.blackMetal, { p: [0, roofY + 0.05, 0.0] });
  a.addM('kit', box(0.03, 0.06, 0.08), L.steelDark, { p: [0.4, roofY + 0.01, 0.0] });
  for (const lx of [-0.3, -0.1, 0.1, 0.3]) {
    a.add('kit', cylZ(0.042, 0.042, 0.03, 8, true), L.steel, { p: [lx, roofY + 0.05, 0.06] });
    a.add('head', cylZ(0.034, 0.038, 0.02, 8), L.lensOff, { p: [lx, roofY + 0.05, 0.062] });
  }
  for (const mx of [-0.44, 0.44]) a.add('accent', box(0.06, 0.05, 0.06), paint(0xffffff, 0), { p: [mx, roofY + 0.05, 0.03] });

  const kit = a.build('kit');
  dustGradient(kit, 0.6, 0.34);

  // --- roof autocannon turret (own mesh, yaws)
  const t = new Asm(23, 'hero.turret');
  t.add('t', cylY(0.25, 0.27, 0.05, 14), L.steelDark, { p: [0, 0.025, 0] });
  t.add('t', cylY(0.17, 0.2, 0.05, 10), L.steel, { p: [0, 0.07, 0] });
  let housing = profileX(
    [
      [-0.3, 0.08],
      [-0.3, 0.2],
      [-0.16, 0.265],
      [0.14, 0.265],
      [0.27, 0.19],
      [0.27, 0.08],
    ],
    0.3,
    0.014,
    1,
    1,
  );
  housing = toCreasedNormals(housing, 0.5);
  t.add('t', housing, look(0x2c3035, 0.5, 0.8, 0));
  for (const bx of [-0.075, 0.075]) {
    t.add('t', rod(v(bx, 0.17, 0.2), v(bx, 0.17, 1.02), 0.027, 8, 0.024, false), L.blackMetal);
    t.add('t', rod(v(bx, 0.17, 0.24), v(bx, 0.17, 0.6), 0.045, 8, 0.045, false), L.steel);
    t.add('t', rod(v(bx, 0.17, 0.98), v(bx, 0.17, 1.08), 0.04, 8, 0.04, false), L.steelDark);
    for (let i = 0; i < 3; i++) t.add('t', cylZ(0.05, 0.05, 0.02, 8), L.steelDark, { p: [bx, 0.17, 0.32 + i * 0.1] });
  }
  t.add('t', box(0.24, 0.035, 0.06), L.steelDark, { p: [0, 0.17, 0.7] });
  // gun shield: two raked plates either side of the barrels
  const shield = [v(0.14, 0.07, 0.3), v(0.36, 0.07, 0.16), v(0.34, 0.34, 0.1), v(0.14, 0.33, 0.24)];
  t.addM('t', plate(shield, 0.02, v(0.3, 0, 1)), look(0x33373c, 0.55, 0.75, 0.06));
  t.addM('t', rivets(outlinePts(shield, 0.1, 0.03).map((p) => p.add(v(0.008, 0, 0.02))), 0.02, v(0.5, 0, 1)), L.steel);
  t.add('t', plate([v(-0.14, 0.24, 0.27), v(0.14, 0.24, 0.27), v(0.14, 0.34, 0.24), v(-0.14, 0.34, 0.24)], 0.02, AXIS_Z), L.steelDark);
  // ammo drum (left), feed belt and optic (right)
  t.add('t', cylX(0.13, 0.13, 0.11, 12), L.steelDark, { p: [0.21, 0.17, -0.08] });
  t.add('t', cylX(0.06, 0.06, 0.13, 8), L.rust, { p: [0.215, 0.17, -0.08] });
  t.add('t', box(0.09, 0.05, 0.2), L.steel, { p: [0.19, 0.2, 0.08], r: [0, 0.3, 0] });
  for (let i = 0; i < 5; i++) t.add('t', cylX(0.012, 0.012, 0.07, 5), look(0xa07a2c, 0.35, 0.9, 0.08), { p: [0.2 - i * 0.012, 0.236, 0.02 + i * 0.03] });
  t.add('t', box(0.08, 0.08, 0.2), L.blackMetal, { p: [-0.2, 0.22, 0.02] });
  t.add('t', cylZ(0.034, 0.034, 0.02, 8), look(0x1a2a3a, 0.1, 0.6, 0), { p: [-0.2, 0.22, 0.13] });
  t.add('t', rod(v(-0.12, 0.265, -0.22), v(-0.14, 0.62, -0.3), 0.007, 4, 0.004), L.steelDark);
  t.add('t', box(0.2, 0.1, 0.1), L.rustDark, { p: [0, 0.16, -0.33] });
  t.add('t', decal([v(-0.1, 0.268, -0.1), v(0.1, 0.268, -0.1), v(0.1, 0.268, -0.02), v(-0.1, 0.268, -0.02)], AXIS_Y), look(C.orange, 0.6, 0.2, 0));
  const turretGeo = t.build('t') as THREE.BufferGeometry;

  const spec = (w: number): WheelSpec => ({ r: WR, w, seg: 24, lugs: 14, rim: look(0x6c6f74, 0.36, 0.92, 0), style: 'alloy', hubSpike: 0, dual: false, mud: 0.25 });
  const front = wheelGeometry('heroFront', spec(0.28));
  const rear = wheelGeometry('heroRear', spec(0.33));

  // static brake callipers (do not spin with the wheel): fronts follow the steering pivots
  const calliper = (s: number, w: number): THREE.BufferGeometry => {
    const c = new Asm(34, 'hero.calliper');
    const rimR = WR * 0.64;
    const cx = s * (-w * 0.5 * 0.12);
    c.add('kit', box(0.075, 0.1, 0.2), look(0xb02a18, 0.45, 0.4, 0), { p: [cx, rimR * 0.66 * Math.sin(0.5), -rimR * 0.66 * Math.cos(0.5)], r: [0.5 - Math.PI / 2, 0, 0] });
    c.add('kit', box(0.085, 0.03, 0.12), L.steelDark, { p: [cx, rimR * 0.66 * Math.sin(0.5), -rimR * 0.66 * Math.cos(0.5)], r: [0.5 - Math.PI / 2, 0, 0] });
    return c.build('kit') as THREE.BufferGeometry;
  };
  extras.push({ name: 'calliperFL', geo: calliper(1, 0.28), parent: 0 }, { name: 'calliperFR', geo: calliper(-1, 0.28), parent: 1 });
  const rearPair = mergeGeometries([calliper(1, 0.33).translate(0.86, WR, RZ), calliper(-1, 0.33).translate(-0.86, WR, RZ)], false) as THREE.BufferGeometry;
  extras.push({ name: 'callipersRear', geo: sanitize(rearPair, 'hero.callipersRear'), parent: 'root' });

  return {
    paint: paintGeo,
    kit,
    glass: glassGeo,
    head: a.build('head'),
    tail: a.build('tail'),
    accent: a.build('accent'),
    hull,
    extras,
    turret: {
      geo: turretGeo,
      p: [0, roofY + 0.01, -0.34],
      muzzles: [
        { p: [0.075, 0.17, 1.09], d: [0, 0, 1] },
        { p: [-0.075, 0.17, 1.09], d: [0, 0, 1] },
      ],
    },
    bodyMuzzles: [],
    exhausts: [
      { p: [0.465, 0.37, -2.45], d: [0.04, 0.06, -1] },
      { p: [-0.465, 0.37, -2.45], d: [-0.04, 0.06, -1] },
    ],
    wheels: [
      { name: 'wheelFL', p: [0.87, WR, FZ], geo: front.left, steer: true },
      { name: 'wheelFR', p: [-0.87, WR, FZ], geo: front.right, steer: true },
      { name: 'wheelRL', p: [0.86, WR, RZ], geo: rear.left, steer: false },
      { name: 'wheelRR', p: [-0.86, WR, RZ], geo: rear.right, steer: false },
    ],
    halfExtents: { x: 1.03, y: 0.75, z: 2.45 },
    wheelRadius: WR,
  };
}

export function createHeroCar(): VehicleModel {
  if (!heroBlueprint) heroBlueprint = buildHero();
  if (!heroTextures) heroTextures = buildHeroTextures(heroBlueprint.hull);
  const paintMat = new THREE.MeshPhysicalMaterial({
    name: 'interceptorPaint',
    color: 0xffffff,
    vertexColors: true,
    map: heroTextures.albedo,
    roughnessMap: heroTextures.orm,
    metalnessMap: heroTextures.orm,
    normalMap: heroTextures.normal,
    normalScale: new THREE.Vector2(1, 1),
    roughness: 1,
    metalness: 1,
    clearcoat: 0.55,
    clearcoatRoughness: 0.26,
    envMapIntensity: 1.15,
    // the cabin is visible through the glass, so the shell needs its inner faces
    side: THREE.DoubleSide,
  });
  const damage = addDamageShader(paintMat, false);
  return instantiate(heroBlueprint, {
    name: 'interceptor',
    paint: paintMat,
    damage,
    scorchRoughness: 1,
    headColor: 0xfff2d6,
    headEmissive: 0xffd9a0,
    accentColor: 0xffa53a,
    accentEmissive: 0xff8a1e,
    accentIntensity: 1.8,
  });
}

export function createRaiderBuggy(_variant: number): VehicleModel {
  return createHeroCar();
}
export function createWarRig(): VehicleModel {
  return createHeroCar();
}
export function createWreckGeometry(_variant: number): THREE.BufferGeometry {
  void [colorTris, planarZ, archPts, hazardPanel, glyph, addSkull, finishBody, scrapPaint, sanitizeLog, textureCount, rag, RING_LO, L.hazard];
  return box(1, 1, 1);
}

/** Build-time safety report: per merged geometry, degenerate triangles dropped and normals repaired. */
export function vehicleKitDiagnostics(): { geometries: SanitizeEntry[]; textures: number } {
  return { geometries: sanitizeLog.map((e) => ({ ...e })), textures: textureCount };
}
