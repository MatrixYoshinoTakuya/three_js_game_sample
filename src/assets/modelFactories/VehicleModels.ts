import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { VehicleModel } from '../../game/contracts';

/**
 * ASHEN SKYLINE vehicle kit.
 *
 * Every vehicle is authored from extrusions, lofted plates, tubes and lathes,
 * then merged BY MATERIAL into a handful of meshes. Static geometry is built
 * once per vehicle type (blueprint cache) and shared by all instances; only
 * the materials the game mutates (paint, head/tail lights, accent) are
 * per-instance.
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

const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);
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
} as const;

/** Look for buckets whose material ignores the PBR palette (paint, lights). */
const paint = (c: number, j = 0.05): Look => look(c, 0.5, 0.5, j);

// ---------------------------------------------------------------- textures / shared materials

let paletteTex: THREE.DataTexture | null = null;
let grimeTex: THREE.DataTexture | null = null;
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
  paletteTex = tex;
  return tex;
}

/** 256px tileable dust / scratch map, used as both albedo multiplier and roughness variation on paint. */
function grimeTexture(): THREE.DataTexture {
  if (grimeTex) return grimeTex;
  const S = 256;
  const rand = rng(90210);
  const field = new Float32Array(S * S);
  const octaves: [number, number][] = [
    [6, 0.45],
    [14, 0.27],
    [32, 0.17],
    [80, 0.11],
  ];
  for (const [period, amp] of octaves) {
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
  for (let i = 0; i < field.length; i++) field[i] = 0.7 + 0.3 * sm(0.25, 0.8, field[i]);
  // scratches: light scuffs and dark gouges, mostly along the travel direction
  for (let k = 0; k < 110; k++) {
    let x = rand() * S;
    let y = rand() * S;
    const ang = (rand() - 0.5) * 0.7 + (rand() < 0.2 ? Math.PI / 2 : 0);
    const len = 8 + rand() * 56;
    const val = rand() < 0.6 ? 1 : 0.52;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    for (let t = 0; t < len; t++) {
      const xi = ((Math.floor(x) % S) + S) % S;
      const yi = ((Math.floor(y) % S) + S) % S;
      field[yi * S + xi] = lerp(field[yi * S + xi], val, 0.75);
      x += dx;
      y += dy;
    }
  }
  for (let k = 0; k < 700; k++) {
    const i = Math.floor(rand() * S * S);
    field[i] *= 0.7 + rand() * 0.2;
  }
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const b = Math.round(Math.min(1, field[i]) * 255);
    data[i * 4] = b;
    data[i * 4 + 1] = b;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  grimeTex = tex;
  return tex;
}

/** Shared vertex-coloured "everything else" material: steel, rubber, rust, cloth via the PBR palette. */
function kitMaterial(): THREE.MeshStandardMaterial {
  if (!kitMat) {
    kitMat = new THREE.MeshStandardMaterial({
      name: 'vehicleKit',
      color: 0xffffff,
      vertexColors: true,
      roughness: 1,
      metalness: 1,
      roughnessMap: pbrPalette(),
      metalnessMap: pbrPalette(),
    });
  }
  return kitMat;
}

function glassMaterial(): THREE.MeshPhysicalMaterial {
  if (!glassMat) {
    glassMat = new THREE.MeshPhysicalMaterial({
      name: 'tintedGlass',
      color: 0x10161b,
      roughness: 0.07,
      metalness: 0.35,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.4,
    });
  }
  return glassMat;
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
  const upRef = Math.abs(dir.dot(up)) > 0.98 ? new THREE.Vector3(1, 0, 0) : up;
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

/** Per-triangle colour (crisp livery edges without a texture). Geometry must be non-indexed. */
function colorTris(geo: THREE.BufferGeometry, fn: (centroid: V3, normal: V3) => number): THREE.BufferGeometry {
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
    nor.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
    color.set(fn(cen, nor));
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

  constructor(seed: number) {
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
    if (!merged) return undefined;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }
}

/** Road dust: fade vertex colours toward dust near the ground. */
function dustGradient(geo: THREE.BufferGeometry | undefined, top: number, amount: number): void {
  if (!geo) return;
  const pos = posAttr(geo);
  const col = geo.getAttribute('color') as THREE.BufferAttribute;
  const dust = new THREE.Color(C.dust);
  for (let i = 0; i < pos.count; i++) {
    const k = amount * sm(top, 0, pos.getY(i));
    if (k <= 0) continue;
    col.setXYZ(i, lerp(col.getX(i), dust.r, k), lerp(col.getY(i), dust.g, k), lerp(col.getZ(i), dust.b, k));
  }
}

/** Box-projected UVs (per triangle, by dominant normal) for the grime map on paint. */
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

// ---------------------------------------------------------------- wheels

type WheelSpec = {
  r: number;
  w: number;
  seg: number;
  lugs: number;
  rim: Look;
  spokes: number;
  nuts: number;
  hubSpike: number;
  dual: boolean;
};

const wheelCache = new Map<string, { left: THREE.BufferGeometry; right: THREE.BufferGeometry }>();

/** One merged tyre + rim geometry; axle = local X, outer face toward +X (left side). */
function wheelGeometry(key: string, spec: WheelSpec): { left: THREE.BufferGeometry; right: THREE.BufferGeometry } {
  const hit = wheelCache.get(key);
  if (hit) return hit;
  const a = new Asm(4242);
  const { r, w, seg } = spec;
  const rimR = r * 0.6;
  const tyres: [number, number][] = spec.dual
    ? [
        [-w * 0.265, w * 0.47],
        [w * 0.265, w * 0.47],
      ]
    : [[0, w]];
  for (const [cx, tw] of tyres) {
    const profile: P2[] = [
      [rimR, -0.44 * tw],
      [r * 0.8, -0.5 * tw],
      [r * 0.94, -0.47 * tw],
      [r, -0.34 * tw],
      [r, 0.34 * tw],
      [r * 0.94, 0.47 * tw],
      [r * 0.8, 0.5 * tw],
      [rimR, 0.44 * tw],
    ];
    a.add('w', latheX(profile, seg), L.rubber, { p: [cx, 0, 0] });
    // chunky tread blocks on both shoulders, staggered
    for (let side = -1; side <= 1; side += 2) {
      if (spec.dual && side * cx < 0) continue;
      for (let i = 0; i < spec.lugs; i++) {
        const ang = ((i + (side > 0 ? 0.5 : 0)) / spec.lugs) * Math.PI * 2;
        const lug = box(tw * (spec.dual ? 0.5 : 0.36), r * 0.085, r * 0.2);
        lug.rotateY(side * 0.3);
        lug.translate(0, r * 0.99, 0);
        a.add('w', lug, L.tread, { p: [cx + side * tw * (spec.dual ? 0.2 : 0.3), 0, 0], r: [ang, 0, 0] });
      }
    }
  }
  const outer = w * 0.5;
  const rimProfile: P2[] = [
    [0, -outer * 0.6],
    [rimR, -outer * 0.86],
    [rimR * 1.04, outer * 0.9],
    [rimR * 0.95, outer * 0.84],
    [rimR * 0.84, outer * 0.34],
    [rimR * 0.36, outer * 0.2],
    [0, outer * 0.2],
  ];
  a.add('w', latheX(rimProfile, seg), spec.rim);
  const faceX = outer * 0.3;
  for (let i = 0; i < spec.spokes; i++) {
    const ang = (i / spec.spokes) * Math.PI * 2;
    const spoke = box(outer * 0.22, rimR * 0.62, rimR * 0.22);
    spoke.translate(0, rimR * 0.56, 0);
    a.add('w', spoke, look(spec.rim.c, spec.rim.r, spec.rim.m, 0.1), { p: [faceX, 0, 0], r: [ang, 0, 0] });
  }
  a.add('w', cylX(rimR * 0.24, rimR * 0.32, outer * 0.42, 8), L.steelDark, { p: [faceX + outer * 0.1, 0, 0] });
  for (let i = 0; i < spec.nuts; i++) {
    const ang = ((i + 0.5) / spec.nuts) * Math.PI * 2;
    const nut = box(outer * 0.16, rimR * 0.09, rimR * 0.09);
    nut.translate(0, rimR * 0.44, 0);
    a.add('w', nut, L.chrome, { p: [faceX + outer * 0.12, 0, 0], r: [ang, 0, 0] });
  }
  if (spec.hubSpike > 0) {
    a.add('w', rod(v(faceX, 0, 0), v(faceX + spec.hubSpike, 0, 0), rimR * 0.26, 5, 0), L.rust);
  }
  const left = a.build('w') as THREE.BufferGeometry;
  const result = { left, right: mirrorGeometryX(left) };
  wheelCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------- blueprint / instancing

type Socket = { p: T3; d: T3 };
type WheelDef = { name: string; p: T3; geo: THREE.BufferGeometry; steer: boolean };
type Blueprint = {
  paint?: THREE.BufferGeometry;
  kit?: THREE.BufferGeometry;
  glass?: THREE.BufferGeometry;
  head?: THREE.BufferGeometry;
  tail?: THREE.BufferGeometry;
  accent?: THREE.BufferGeometry;
  turret?: { geo: THREE.BufferGeometry; p: T3; muzzles: Socket[] };
  bodyMuzzles: Socket[];
  exhausts: Socket[];
  wheels: WheelDef[];
  halfExtents: { x: number; y: number; z: number };
  wheelRadius: number;
};

type Livery = {
  name: string;
  paint: THREE.MeshStandardMaterial;
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
  const headlightMaterial = new THREE.MeshStandardMaterial({
    name: 'headlight',
    color: livery.headColor,
    emissive: livery.headEmissive,
    emissiveIntensity: 2.2,
    roughness: 0.25,
    metalness: 0,
  });
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
  addMesh(bp.glass, glassMaterial(), 'cockpitGlass', true, false);
  addMesh(bp.head, headlightMaterial, 'headlights', false, false);
  addMesh(bp.tail, tailLightMaterial, 'tailLights', false, false);
  addMesh(bp.accent, accentMaterial, 'accentLights', false, false);

  const muzzles: THREE.Object3D[] = [];
  let turret: THREE.Object3D | undefined;
  if (bp.turret) {
    const mesh = new THREE.Mesh(bp.turret.geo, kitMaterial());
    mesh.name = 'turret';
    mesh.castShadow = true;
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

  const baseRoughness = paintMat.roughness;
  const physical = paintMat instanceof THREE.MeshPhysicalMaterial ? paintMat : null;
  const baseClearcoat = physical ? physical.clearcoat : 0;
  const pristine = new THREE.Color(1, 1, 1);
  const scorched = new THREE.Color(0.3, 0.2, 0.15);
  const setDamage = (level: number): void => {
    const t = Math.min(1, Math.max(0, level));
    paintMat.color.lerpColors(pristine, scorched, t);
    paintMat.roughness = lerp(baseRoughness, livery.scorchRoughness, t);
    if (physical) physical.clearcoat = Math.max(0.04, baseClearcoat * (1 - t));
  };

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

function scatterBolts(a: Asm, pts: V3[], size: number, outward: V3, lk: Look): void {
  const q = new THREE.Quaternion().setFromUnitVectors(AXIS_Z, outward.clone().normalize());
  for (const p of pts) {
    const g = box(size, size, size * 0.6);
    g.applyQuaternion(q);
    g.translate(p.x, p.y, p.z);
    a.add('kit', g, lk);
  }
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
  // brow ridge + cheek rivets give the plate a welded, hand-cut feel
  a.addM('kit', beam(v(0.06, 0.2, 0.06), v(0.44, 0.34, 0.06), 0.05, 0.03), L.rustDark);
  scatterBolts(a, [v(0.4, -0.08, 0.05), v(-0.4, -0.08, 0.05), v(0.25, 0.47, 0.05), v(-0.25, 0.47, 0.05)], 0.035, AXIS_Z, L.steelDark);
}

// ---------------------------------------------------------------- HERO: interceptor

const HERO_HALF_W = 0.92;
const heroSideX = (y: number, z: number): number => {
  const tz = 1 - 0.1 * sm(1.55, 2.33, z) - 0.06 * sm(-1.7, -2.32, z);
  const ty = 1 - 0.045 * sm(0.8, 1.12, y) - 0.05 * sm(0.52, 0.3, y);
  return HERO_HALF_W * tz * ty;
};
/** Greenhouse half width at height y (tumblehome). */
const heroGlassX = (y: number): number => 0.83 * (1 - 0.2 * sm(1.0, 1.45, y));

let heroBlueprint: Blueprint | null = null;

function buildHero(): Blueprint {
  const a = new Asm(11);
  const WR = 0.42;
  const FZ = 1.42;
  const RZ = -1.38;
  const stripeRand = rng(77);

  // --- lower hull: side-profile extrusion with bevel, then tapered / crowned
  const profile: P2[] = [
    [2.16, 0.3],
    [2.27, 0.4],
    [2.31, 0.62],
    [2.29, 0.8],
    [2.22, 0.87],
    [1.85, 0.95],
    [1.3, 1.0],
    [0.62, 1.03],
    [-0.9, 1.04],
    [-1.35, 1.09],
    [-1.85, 1.11],
    [-2.22, 1.15],
    [-2.3, 1.13],
    [-2.29, 0.98],
    [-2.24, 0.62],
    [-2.17, 0.36],
    [-2.05, 0.3],
    ...archPts(RZ, WR, 0.5, 0.3, 9),
    ...archPts(FZ, WR, 0.5, 0.3, 9),
  ];
  let hull = profileX(profile, HERO_HALF_W * 2, 0.03, 14, 2);
  colorTris(hull, (cen, nor) => {
    const top = Math.abs(nor.x) < 0.5 && nor.y > -0.3;
    if (top && cen.x > 0.25 && cen.x < 0.51) return stripeRand() < 0.1 ? C.orangeWorn : C.orange;
    if (top && cen.x > 0.13 && cen.x < 0.25 && cen.z < 0.7 && cen.z > -2.0) return C.gunmetalDark;
    if (Math.abs(nor.x) > 0.9 && cen.y < 0.52) return C.gunmetalDark;
    return C.gunmetal;
  });
  deform(hull, (p) => {
    const xn = p.x / HERO_HALF_W;
    const side = heroSideX(p.y, p.z) / HERO_HALF_W;
    if (p.y > 0.7) p.y += 0.035 * (1 - xn * xn);
    if (p.z > 1.9) p.z -= 0.1 * xn * xn * sm(1.9, 2.25, p.z);
    if (p.z < -1.9) p.z += 0.06 * xn * xn * sm(-1.9, -2.2, p.z);
    p.x *= side;
  });
  hull = toCreasedNormals(hull, 0.62);
  a.add('paint', hull, paint(C.gunmetal));

  // dark structural core fills the wheel tunnels and the underside
  a.add('kit', box(1.34, 0.64, 4.2), L.matte, { p: [0, 0.6, 0] });
  a.add('kit', box(1.5, 0.1, 1.4), L.matte, { p: [0, 0.33, 0] });

  // --- fender flares (annular arcs, flared lip)
  a.addM('paint', archFlare(0.485, 0.595, 0.36, 0.2), paint(C.gunmetalDark), { p: [0.84, WR, FZ] });
  a.addM('paint', archFlare(0.485, 0.615, 0.4, 0.2), paint(C.gunmetalDark), { p: [0.84, WR, RZ] });

  // --- greenhouse (tinted glass volume) + painted roof, pillars, sail panels
  const glassProfile: P2[] = [
    [0.68, 1.0],
    [0.1, 1.445],
    [-0.72, 1.455],
    [-1.78, 1.1],
    [-1.78, 1.0],
  ];
  const glass = profileX(glassProfile, 1.66, 0, 4);
  deform(glass, (p) => {
    const xn = p.x / 0.83;
    p.z -= 0.1 * xn * xn * sm(-0.4, 0.1, p.z);
    p.x *= heroGlassX(p.y) / 0.83;
  });
  a.add('glass', glass, paint(0xffffff, 0));

  const roofProfile: P2[] = [
    [0.17, 1.435],
    [0.11, 1.48],
    [-0.74, 1.49],
    [-0.82, 1.45],
  ];
  let roof = profileX(roofProfile, 1.37, 0.012, 10, 1);
  colorTris(roof, (cen, nor) => (Math.abs(nor.x) < 0.5 && cen.x > 0.26 && cen.x < 0.54 ? C.orange : C.gunmetal));
  deform(roof, (p) => {
    const xn = p.x / 0.685;
    p.z -= 0.1 * xn * xn * sm(-0.4, 0.1, p.z);
    p.y += 0.012 * (1 - xn * xn);
  });
  roof = toCreasedNormals(roof, 0.6);
  a.add('paint', roof, paint(C.gunmetal));

  const outX = v(1, 0, 0);
  const gx = (y: number): number => heroGlassX(y) + 0.004;
  // A pillar, roof rail, B pillar
  a.addM('paint', beam(v(gx(1.0), 1.0, 0.58), v(gx(1.445), 1.45, 0.02), 0.075, 0.07, outX), paint(C.gunmetal));
  a.addM('paint', beam(v(gx(1.45), 1.455, 0.04), v(gx(1.455), 1.462, -0.76), 0.06, 0.06, outX), paint(C.gunmetal));
  a.addM('paint', beam(v(gx(1.02), 1.02, -0.36), v(gx(1.45), 1.45, -0.42), 0.06, 0.09, outX), paint(C.gunmetalDark));
  // sail panel (C pillar) leaves a small quarter window
  a.addM(
    'paint',
    plate(
      [v(gx(1.455), 1.458, -0.72), v(gx(1.1), 1.103, -1.79), v(gx(1.02), 1.02, -1.79), v(gx(1.02), 1.02, -1.12)],
      0.03,
      outX,
    ),
    paint(C.gunmetal),
  );
  // louvred rear window
  for (let i = 0; i < 6; i++) {
    const t = (i + 0.5) / 6;
    const y = 1.455 - 0.355 * t + 0.035;
    const z = -0.74 - 1.04 * t;
    const half = heroGlassX(y - 0.03) - 0.06;
    a.add('kit', box(half * 2, 0.014, 0.2), L.blackMetal, { p: [0, y, z], r: [-0.1, 0, 0] });
  }
  a.addM('kit', beam(v(0.6, 1.475, -0.76), v(0.74, 1.125, -1.78), 0.035, 0.05), L.steelDark);
  a.add('kit', beam(v(0, 1.48, -0.76), v(0, 1.13, -1.78), 0.03, 0.04), L.steelDark);

  // --- nose: grille, four round lamps, bull bar
  const noseZ = (x: number): number => 2.3 - 0.1 * (x / HERO_HALF_W) ** 2;
  a.add('kit', box(0.62, 0.17, 0.05), L.matte, { p: [0, 0.71, 2.305] });
  for (let i = 0; i < 3; i++) a.add('kit', box(0.6, 0.014, 0.02), L.steel, { p: [0, 0.66 + i * 0.05, 2.335] });
  for (const lx of [0.44, 0.66]) {
    const z = noseZ(lx);
    a.addM('kit', cylZ(0.092, 0.1, 0.09, 10), L.steelDark, { p: [lx, 0.71, z + 0.01] });
    a.addM('head', cylZ(0.055, 0.078, 0.03, 10), L.lens, { p: [lx, 0.71, z + 0.068] });
  }
  // bull bar: wrap-around hoops, uprights, skid plate
  const barLook = look(0x2a2c2f, 0.5, 0.8, 0.06);
  a.add(
    'kit',
    tube([v(-0.99, 0.74, 1.95), v(-0.84, 0.88, 2.42), v(-0.3, 0.9, 2.5), v(0.3, 0.9, 2.5), v(0.84, 0.88, 2.42), v(0.99, 0.74, 1.95)], 0.034, 6, 3),
    barLook,
  );
  a.add(
    'kit',
    tube([v(-0.93, 0.44, 2.05), v(-0.78, 0.44, 2.44), v(-0.3, 0.44, 2.5), v(0.3, 0.44, 2.5), v(0.78, 0.44, 2.44), v(0.93, 0.44, 2.05)], 0.04, 6, 3),
    barLook,
  );
  a.addM('kit', rod(v(0.36, 0.3, 2.44), v(0.36, 0.93, 2.5), 0.036, 6, 0.036, false), barLook);
  a.addM('kit', rod(v(0.84, 0.44, 2.4), v(0.84, 0.88, 2.42), 0.028, 5), barLook);
  a.add('kit', plate([v(-0.36, 0.3, 2.42), v(0.36, 0.3, 2.42), v(0.36, 0.55, 2.5), v(-0.36, 0.55, 2.5)], 0.02, AXIS_Z), L.rustDark);
  for (let i = -2; i <= 2; i++) a.add('kit', box(0.07, 0.15, 0.012), L.matte, { p: [i * 0.13, 0.43, 2.49], r: [-0.3, 0, 0] });
  a.addM('kit', beam(v(0.36, 0.5, 2.26), v(0.36, 0.5, 2.46), 0.05, 0.1), L.steelDark);
  a.addM('accent', box(0.07, 0.035, 0.05), paint(0xffffff, 0), { p: [0.62, 0.9, 2.47] });

  // --- hood: blower case, belt drive, bug-catcher intake
  const BZ = 1.12;
  a.add('kit', box(0.5, 0.03, 0.66), L.steelDark, { p: [0, 1.035, BZ] });
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
  a.add('kit', box(0.012, 0.115, 0.03), L.steel, { p: [0.05, 1.27, BZ + 0.255] });
  a.add('kit', box(0.012, 0.115, 0.03), L.steel, { p: [-0.05, 1.27, BZ + 0.255] });
  a.add('accent', box(0.2, 0.012, 0.03), paint(0xffffff, 0), { p: [0, 1.35, BZ + 0.2], r: [-0.25, 0, 0] });

  // --- side exhaust: headers into a lake pipe that kicks out ahead of the rear wheel
  const pipeLook = look(0x5a4a3c, 0.42, 0.9, 0.08);
  a.addM('kit', tube([v(0.93, 0.5, 0.86), v(1.0, 0.36, 0.6), v(1.0, 0.34, -0.35), v(1.02, 0.36, -0.62), v(1.08, 0.43, -0.82)], 0.058, 7, 3, 0.3), pipeLook);
  a.addM('kit', rod(v(1.065, 0.413, -0.77), v(1.095, 0.447, -0.87), 0.066, 8, 0.078), L.steelDark);
  for (let i = 0; i < 3; i++) a.addM('kit', rod(v(0.88, 0.62, 0.84 - i * 0.13), v(0.99, 0.38, 0.72 - i * 0.16), 0.026, 5), pipeLook);
  a.addM('kit', box(0.02, 0.1, 0.7), L.blackMetal, { p: [1.065, 0.36, -0.02] });
  for (let i = 0; i < 5; i++) a.addM('kit', box(0.024, 0.05, 0.05), L.matte, { p: [1.066, 0.36, 0.24 - i * 0.13] });

  // --- bolted door armour
  const sx = (y: number, z: number): number => heroSideX(y, z) + 0.002;
  a.addM(
    'kit',
    plate([v(sx(0.52, 0.4), 0.52, 0.42), v(sx(0.99, 0.4), 0.99, 0.46), v(sx(1.0, -0.3), 1.0, -0.3), v(sx(0.9, -0.7), 0.9, -0.72), v(sx(0.5, -0.7), 0.5, -0.7)], 0.022, outX),
    look(0x3d3f42, 0.62, 0.7, 0.05),
  );
  a.add('kit', plate([v(0.945, 0.6, 0.2), v(0.945, 0.92, 0.26), v(0.945, 0.9, -0.34), v(0.945, 0.56, -0.28)], 0.02, outX), L.rust);
  a.add('kit', plate([v(-0.945, 0.56, -0.1), v(-0.945, 0.84, -0.06), v(-0.945, 0.86, -0.62), v(-0.945, 0.6, -0.6)], 0.02, v(-1, 0, 0)), L.rustDark);
  const boltPts: V3[] = [];
  for (const [by, bz] of [
    [0.58, 0.34],
    [0.93, 0.38],
    [0.94, -0.24],
    [0.86, -0.64],
    [0.56, -0.62],
    [0.56, -0.14],
  ] as P2[])
    boltPts.push(v(sx(by, bz) + 0.024, by, bz));
  scatterBolts(a, boltPts, 0.03, outX, L.steel);
  scatterBolts(
    a,
    boltPts.map((p) => v(-p.x, p.y, p.z)),
    0.03,
    v(-1, 0, 0),
    L.steel,
  );
  // driver-side window armour with a vision slit (left only: deliberate asymmetry)
  const aZ = (y: number): number => 0.5 - (y - 1.0) * 1.26;
  a.add('kit', plate([v(gx(1.06), 1.06, aZ(1.06)), v(gx(1.2), 1.2, aZ(1.2)), v(gx(1.2), 1.2, -0.3), v(gx(1.06), 1.06, -0.3)], 0.018, outX), L.rustDark);
  a.add('kit', plate([v(gx(1.26), 1.26, aZ(1.26)), v(gx(1.42), 1.42, aZ(1.42)), v(gx(1.42), 1.42, -0.3), v(gx(1.26), 1.26, -0.3)], 0.018, outX), L.steelDark);
  // mirrors, sill rails
  a.addM('kit', box(0.05, 0.1, 0.14), L.blackMetal, { p: [0.93, 1.1, 0.52] });
  a.addM('kit', rod(v(0.84, 1.05, 0.56), v(0.92, 1.09, 0.53), 0.014, 4), L.steelDark);
  a.addM('paint', box(0.06, 0.07, 1.74), paint(C.gunmetalDark), { p: [0.9, 0.33, 0.02] });

  // --- tail: light bar, bumper tube, plate
  a.add('kit', box(1.56, 0.17, 0.04), L.matte, { p: [0, 0.93, -2.3] });
  a.add('tail', box(1.44, 0.055, 0.03), L.lens, { p: [0, 0.95, -2.318] });
  for (let i = -3; i <= 3; i++) a.add('kit', box(0.02, 0.07, 0.036), L.matte, { p: [i * 0.2, 0.95, -2.318] });
  a.add('kit', tube([v(-0.92, 0.5, -2.02), v(-0.8, 0.5, -2.4), v(0.8, 0.5, -2.4), v(0.92, 0.5, -2.02)], 0.04, 6, 3), barLook);
  a.addM('kit', beam(v(0.5, 0.5, -2.2), v(0.5, 0.5, -2.4), 0.05, 0.09), L.steelDark);
  a.add('kit', box(0.34, 0.12, 0.012), L.bone, { p: [0, 0.7, -2.3], r: [0.12, 0, 0] });
  a.addM('accent', box(0.03, 0.04, 0.09), paint(0xffffff, 0), { p: [0.9, 0.84, -2.1] });
  a.addM('accent', box(0.03, 0.04, 0.09), paint(0xffffff, 0), { p: [0.875, 0.8, 2.02] });

  // --- deck cargo: leaning spare, two strapped jerry cans, rack rail, whip antenna
  const spare = new THREE.TorusGeometry(0.27, 0.115, 7, 14);
  const spareXf: Xf = { p: [0.4, 1.3, -1.9], r: [-Math.PI / 2 + 0.1, 0, 0.05] };
  a.add('kit', spare, L.rubber, spareXf);
  a.add('kit', cylZ(0.17, 0.17, 0.12, 10), L.steelDark, spareXf);
  a.add('kit', box(0.06, 0.03, 0.8), L.cloth, { p: [0.4, 1.425, -1.9], r: [0.1, 0, 0.05] });
  a.add('kit', box(0.8, 0.03, 0.06), L.cloth, { p: [0.4, 1.425, -1.9], r: [0.1, 0, 0.05] });
  for (const [cz, lk] of [
    [-1.93, L.canRed],
    [-2.11, L.olive],
  ] as [number, Look][]) {
    a.add('kit', box(0.4, 0.3, 0.14), lk, { p: [-0.42, 1.3, cz] });
    a.add('kit', box(0.3, 0.2, 0.15), look(lk.c, lk.r, lk.m, 0.2), { p: [-0.42, 1.3, cz] });
    a.add('kit', cylY(0.025, 0.025, 0.05, 6), L.steelDark, { p: [-0.55, 1.47, cz] });
    a.add('kit', box(0.16, 0.025, 0.03), L.steelDark, { p: [-0.4, 1.47, cz] });
  }
  a.add('kit', box(0.03, 0.34, 0.36), L.cloth, { p: [-0.42, 1.3, -2.02] });
  a.add('kit', tube([v(-0.68, 1.14, -1.82), v(-0.68, 1.3, -1.84), v(-0.68, 1.3, -2.2), v(-0.68, 1.15, -2.24)], 0.016, 4, 2, 0.2), L.steelDark);
  a.add('kit', tube([v(-0.16, 1.14, -1.82), v(-0.16, 1.3, -1.84), v(-0.16, 1.3, -2.2), v(-0.16, 1.15, -2.24)], 0.016, 4, 2, 0.2), L.steelDark);
  a.add('kit', cylY(0.022, 0.028, 0.1, 6), L.steelDark, { p: [-0.78, 1.15, -1.5] });
  a.add('kit', rod(v(-0.78, 1.18, -1.5), v(-0.83, 2.55, -1.98), 0.009, 4, 0.004), L.steelDark);
  a.add('kit', plate([v(-0.83, 2.5, -1.97), v(-0.83, 2.38, -1.93), v(-0.83, 2.42, -2.2)], 0.006, v(-1, 0, 0)), look(C.orange, 0.9, 0, 0));

  // roof marker lights (amber accent)
  for (const mx of [-0.36, -0.18, 0.18, 0.36]) a.add('accent', box(0.07, 0.03, 0.05), paint(0xffffff, 0), { p: [mx, 1.505, 0.02] });
  a.add('kit', box(0.92, 0.02, 0.07), L.blackMetal, { p: [0, 1.49, 0.02] });

  const bodyGeo = finishBody(a, 0.55, 0.3);

  // --- roof autocannon turret (own mesh, yaws)
  const t = new Asm(23);
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
  t.addM('t', plate([v(0.14, 0.07, 0.3), v(0.36, 0.07, 0.16), v(0.34, 0.34, 0.1), v(0.14, 0.33, 0.24)], 0.02, v(0.3, 0, 1)), look(0x33373c, 0.55, 0.75, 0.06));
  t.add('t', plate([v(-0.14, 0.24, 0.27), v(0.14, 0.24, 0.27), v(0.14, 0.34, 0.24), v(-0.14, 0.34, 0.24)], 0.02, AXIS_Z), L.steelDark);
  // ammo drum (left) and optic (right)
  t.add('t', cylX(0.13, 0.13, 0.11, 12), L.steelDark, { p: [0.21, 0.17, -0.08] });
  t.add('t', cylX(0.06, 0.06, 0.13, 8), L.rust, { p: [0.215, 0.17, -0.08] });
  t.add('t', box(0.09, 0.05, 0.2), L.steel, { p: [0.19, 0.2, 0.08], r: [0, 0.3, 0] });
  t.add('t', box(0.08, 0.08, 0.2), L.blackMetal, { p: [-0.2, 0.22, 0.02] });
  t.add('t', cylZ(0.034, 0.034, 0.02, 8), look(0x1a2a3a, 0.1, 0.6, 0), { p: [-0.2, 0.22, 0.13] });
  t.add('t', rod(v(-0.12, 0.265, -0.22), v(-0.14, 0.62, -0.3), 0.007, 4, 0.004), L.steelDark);
  t.add('t', box(0.2, 0.1, 0.1), L.rustDark, { p: [0, 0.16, -0.33] });
  const turretGeo = t.build('t') as THREE.BufferGeometry;

  const spec = (w: number): WheelSpec => ({ r: WR, w, seg: 18, lugs: 12, rim: look(0x64676b, 0.4, 0.9, 0), spokes: 5, nuts: 5, hubSpike: 0, dual: false });
  const front = wheelGeometry('heroFront', spec(0.28));
  const rear = wheelGeometry('heroRear', spec(0.33));

  return {
    ...bodyGeo,
    turret: {
      geo: turretGeo,
      p: [0, 1.495, -0.34],
      muzzles: [
        { p: [0.075, 0.17, 1.09], d: [0, 0, 1] },
        { p: [-0.075, 0.17, 1.09], d: [0, 0, 1] },
      ],
    },
    bodyMuzzles: [],
    exhausts: [
      { p: [1.1, 0.452, -0.885], d: [0.28, 0.32, -0.9] },
      { p: [-1.1, 0.452, -0.885], d: [-0.28, 0.32, -0.9] },
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
  const grime = grimeTexture();
  const paintMat = new THREE.MeshPhysicalMaterial({
    name: 'interceptorPaint',
    color: 0xffffff,
    vertexColors: true,
    map: grime,
    roughnessMap: grime,
    roughness: 0.5,
    metalness: 0.55,
    clearcoat: 0.6,
    clearcoatRoughness: 0.28,
  });
  return instantiate(heroBlueprint, {
    name: 'interceptor',
    paint: paintMat,
    scorchRoughness: 0.95,
    headColor: 0xfff2d6,
    headEmissive: 0xffd9a0,
    accentColor: 0xffa53a,
    accentEmissive: 0xff8a1e,
    accentIntensity: 1.8,
  });
}

// ---------------------------------------------------------------- RAIDER BUGGY

const buggyBlueprints = new Map<number, Blueprint>();

function buildBuggy(variant: number): Blueprint {
  const a = new Asm(100 + variant);
  const ext = variant === 2 ? 0.5 : 0;
  /** Point helper: everything ahead of the cockpit slides forward on the long variant. */
  const F = (x: number, y: number, z: number): V3 => v(x, y, z > 0.6 ? z + ext : z);
  const FR = 0.4;
  const RR = 0.5;
  const fAxle = 1.15 + ext;
  const rAxle = -1.05;
  const TR = 0.034;
  const up = AXIS_Y;
  const outX = v(1, 0, 0);

  const panelA = variant === 1 ? C.raiderRed : C.bone;
  const panelB = variant === 1 ? C.bone : C.raiderRed;
  const frameLook = variant === 2 ? look(0x241d1a, 0.65, 0.65, 0.1) : L.frame;

  // --- tube frame
  a.addM('kit', tube([F(0.3, 0.38, 1.55), F(0.55, 0.36, 0.8), v(0.62, 0.36, -0.45), v(0.48, 0.48, -1.5)], TR, 5, 3), frameLook);
  a.addM('kit', tube([F(0.28, 0.64, 1.5), F(0.58, 0.8, 0.62), v(0.63, 0.84, -0.45), v(0.46, 0.95, -1.5)], TR, 5, 3), frameLook);
  a.add(
    'kit',
    tube([v(0.62, 0.36, -0.45), v(0.64, 0.95, -0.45), v(0.5, 1.42, -0.4), v(-0.5, 1.42, -0.4), v(-0.64, 0.95, -0.45), v(-0.62, 0.36, -0.45)], 0.04, 6, 3, 0.22),
    frameLook,
  );
  a.add('kit', tube([F(0.58, 0.8, 0.62), v(0.47, 1.37, 0.22), v(-0.47, 1.37, 0.22), F(-0.58, 0.8, 0.62)], TR, 5, 3, 0.22), frameLook);
  a.addM('kit', rod(v(0.47, 1.37, 0.22), v(0.5, 1.42, -0.4), TR, 5), frameLook);
  a.add('kit', rod(v(0, 1.38, 0.22), v(0, 1.43, -0.4), TR * 0.9, 5), frameLook);
  a.addM('kit', rod(v(0.5, 1.42, -0.4), v(0.44, 0.95, -1.52), TR, 5), frameLook);
  a.add('kit', rod(v(-0.48, 0.95, -1.5), v(0.48, 0.95, -1.5), TR, 5), frameLook);
  a.add('kit', rod(v(-0.5, 0.48, -1.5), v(0.5, 0.48, -1.5), TR, 5), frameLook);
  a.addM('kit', rod(v(0.48, 0.48, -1.5), v(0.46, 0.95, -1.5), TR, 5), frameLook);
  a.addM('kit', rod(v(0.62, 0.37, 0.45), v(0.63, 0.84, -0.42), TR * 0.85, 5), frameLook);
  a.addM('kit', rod(F(0.3, 0.38, 1.55), F(0.28, 0.64, 1.5), TR, 5), frameLook);
  a.add('kit', rod(F(-0.3, 0.38, 1.56), F(0.3, 0.38, 1.56), TR, 5), frameLook);
  a.add('kit', rod(F(-0.28, 0.64, 1.51), F(0.28, 0.64, 1.51), TR, 5), frameLook);
  a.add('kit', rod(F(-0.42, 0.37, 1.66), F(0.42, 0.37, 1.66), 0.045, 6, 0.045, false), L.steelDark);
  a.addM('kit', rod(F(0.3, 0.38, 1.55), F(0.36, 0.37, 1.66), TR, 5), frameLook);
  // floor pan
  a.add('kit', box(1.16, 0.03, 2.0 + ext), L.matte, { p: [0, 0.35, 0.45 + ext / 2] });

  // --- suspension
  a.addM('kit', rod(F(0.3, 0.4, 1.4), v(0.72, 0.4, fAxle), 0.024, 5), L.steelDark);
  a.addM('kit', rod(F(0.3, 0.4, 0.92), v(0.72, 0.4, fAxle), 0.024, 5), L.steelDark);
  a.addM('kit', rod(F(0.29, 0.62, 1.22), v(0.72, 0.5, fAxle), 0.022, 5), L.steelDark);
  a.addM('kit', rod(F(0.3, 0.66, 1.12), v(0.62, 0.42, fAxle - 0.03), 0.048, 6, 0.048, false), look(C.raiderRedDark, 0.5, 0.6, 0));
  a.add('kit', rod(v(-0.64, RR, rAxle), v(0.64, RR, rAxle), 0.06, 6), L.steelDark);
  a.add('kit', cylY(0.15, 0.15, 0.2, 8).rotateX(Math.PI / 2), L.rustDark, { p: [0, RR, rAxle] });
  a.addM('kit', rod(v(0.6, 0.38, -0.3), v(0.56, RR, rAxle), 0.04, 5), L.steelDark);
  a.addM('kit', rod(v(0.47, 0.95, -1.25), v(0.54, 0.52, rAxle - 0.04), 0.05, 6, 0.05, false), look(C.raiderRedDark, 0.5, 0.6, 0));

  // --- body panels (hazard paint, scorches with damage)
  const hoodFront = 1.5;
  a.add('paint', plate([F(0.27, 0.66, hoodFront), F(-0.27, 0.66, hoodFront), F(-0.57, 0.83, 0.62), F(0.57, 0.83, 0.62)], 0.016, up), paint(panelA));
  if (variant === 2) {
    a.addM('paint', plate([F(0.2, 0.678, hoodFront - 0.02), F(0.12, 0.678, hoodFront - 0.02), F(0.26, 0.845, 0.66), F(0.42, 0.845, 0.66)], 0.008, up), paint(panelB, 0));
  } else {
    a.add('paint', plate([F(0.1, 0.678, hoodFront - 0.02), F(-0.1, 0.678, hoodFront - 0.02), F(-0.16, 0.845, 0.66), F(0.16, 0.845, 0.66)], 0.008, up), paint(panelB, 0));
  }
  a.addM('paint', plate([F(0.315, 0.39, 1.53), F(0.295, 0.63, 1.5), F(0.595, 0.81, 0.63), F(0.57, 0.37, 0.8)], 0.016, outX), paint(panelB));
  a.addM('paint', plate([F(0.585, 0.37, 0.75), F(0.605, 0.8, 0.61), v(0.655, 0.84, -0.43), v(0.645, 0.37, -0.43)], 0.016, outX), paint(panelA));
  // hazard chevrons on the door
  const chev = variant === 2 ? 2 : 3;
  for (let i = 0; i < chev; i++) {
    const z0 = 0.36 - i * (variant === 2 ? 0.36 : 0.26);
    const wz = variant === 2 ? 0.2 : 0.12;
    a.addM('paint', plate([v(0.664, 0.42, z0), v(0.664, 0.42, z0 - wz), v(0.672, 0.76, z0 - wz - 0.18), v(0.672, 0.76, z0 - 0.18)], 0.008, outX), paint(panelB, 0));
  }
  // rear gusset fins between hoop and tail brace
  a.addM('paint', plate([v(0.57, 0.98, -0.5), v(0.52, 1.4, -0.42), v(0.46, 0.97, -1.48)], 0.016, outX), paint(panelB));
  // roof sheet
  a.add('paint', plate([v(0.47, 1.4, 0.24), v(-0.47, 1.4, 0.24), v(-0.52, 1.455, -0.44), v(0.52, 1.455, -0.44)], 0.02, up), paint(variant === 1 ? C.rustDark : C.rust, 0.1));
  if (variant === 1) {
    a.add('paint', plate([v(0.5, 1.42, 0.3), v(-0.5, 1.42, 0.3), v(-0.42, 1.3, 0.62), v(0.42, 1.3, 0.62)], 0.02, up), paint(C.rustDark, 0.1));
  }

  // --- driver, seat, wheel
  a.add('kit', box(0.5, 0.1, 0.5), L.cloth, { p: [0, 0.46, -0.02] });
  a.add('kit', box(0.5, 0.66, 0.1), L.cloth, { p: [0, 0.8, -0.32], r: [-0.14, 0, 0] });
  a.add('kit', box(0.42, 0.5, 0.25), look(0x2a2420, 0.9, 0, 0), { p: [0, 0.8, -0.16], r: [-0.12, 0, 0] });
  a.add('kit', new THREE.SphereGeometry(0.135, 8, 6), L.bone, { p: [0, 1.2, -0.16] });
  a.add('kit', box(0.21, 0.07, 0.08), L.matte, { p: [0, 1.21, -0.06] });
  a.add('kit', box(0.16, 0.1, 0.1), look(C.raiderRedDark, 0.8, 0, 0), { p: [0, 1.11, -0.07] });
  a.addM('kit', rod(v(0.22, 0.98, -0.12), v(0.13, 0.9, 0.3), 0.05, 5), look(0x2a2420, 0.9, 0, 0));
  a.add('kit', rod(v(0, 0.62, 0.62), v(0, 0.9, 0.34), 0.02, 5), L.steelDark);
  a.add('kit', rod(v(0, 0.9, 0.34), v(0, 0.915, 0.325), 0.16, 8, 0.16, false), L.matte);
  a.add('kit', box(0.92, 0.14, 0.06), L.blackMetal, { p: [0, 0.84, 0.58] });

  // --- exposed rear engine
  const EZ = -1.02;
  a.add('kit', box(0.46, 0.34, 0.62), L.steelDark, { p: [0, 0.72, EZ] });
  a.add('kit', box(0.34, 0.26, 0.3), L.rustDark, { p: [0, 0.58, EZ - 0.42] });
  for (const s of [1, -1]) {
    a.add('kit', box(0.2, 0.15, 0.58), L.alloy, { p: [s * 0.2, 0.93, EZ], r: [0, 0, -s * 0.7] });
    a.add('kit', box(0.21, 0.04, 0.5), look(C.raiderRed, 0.55, 0.5, 0), { p: [s * 0.265, 0.985, EZ], r: [0, 0, -s * 0.7] });
  }
  a.add('kit', cylY(0.17, 0.17, 0.09, 10), L.chrome, { p: [0, 1.13, EZ] });
  a.add('kit', cylY(0.11, 0.14, 0.08, 8), L.steelDark, { p: [0, 1.06, EZ] });
  a.add('kit', cylZ(0.14, 0.14, 0.04, 10), L.steel, { p: [0, 0.76, EZ - 0.34] });
  a.add('kit', cylX(0.17, 0.17, 0.78, 10), look(variant === 1 ? C.boneDirty : C.raiderRed, 0.6, 0.4, 0), { p: [0, 0.64, -0.6] });
  a.add('kit', box(0.06, 0.36, 0.36), L.bone, { p: [0.12, 0.64, -0.6] });
  for (let i = 0; i < 3; i++) {
    a.addM('kit', rod(v(0.3, 0.92, EZ + 0.2 - i * 0.2), v(0.4, 0.84, EZ + 0.1 - i * 0.2), 0.026, 5), L.rust);
  }
  const exhausts: Socket[] = [];
  if (variant === 2) {
    a.addM('kit', tube([v(0.4, 0.84, EZ + 0.1), v(0.44, 0.82, -1.4), v(0.44, 1.2, -1.56), v(0.45, 2.02, -1.62)], 0.05, 6, 3, 0.25), L.rust);
    a.addM('kit', rod(v(0.45, 1.3, -1.575), v(0.45, 1.75, -1.6), 0.07, 7, 0.07, false), L.steelDark);
    exhausts.push({ p: [0.45, 2.04, -1.62], d: [0, 1, -0.1] }, { p: [-0.45, 2.04, -1.62], d: [0, 1, -0.1] });
  } else {
    a.addM('kit', tube([v(0.4, 0.84, EZ + 0.1), v(0.5, 0.84, -1.5), v(0.53, 1.02, -1.72), v(0.55, 1.3, -1.86)], 0.048, 6, 3, 0.3), L.rust);
    a.addM('kit', rod(v(0.545, 1.24, -1.83), v(0.56, 1.42, -1.92), 0.055, 7, 0.085), L.steelDark);
    exhausts.push({ p: [0.56, 1.44, -1.93], d: [0.08, 0.9, -0.45] }, { p: [-0.56, 1.44, -1.93], d: [-0.08, 0.9, -0.45] });
  }
  a.addM('tail', box(0.12, 0.07, 0.04), L.lens, { p: [0.32, 0.98, -1.535] });

  // --- skull plate with glowing sockets (attack telegraph)
  a.push({ p: [0, variant === 1 ? 0.86 : 0.76, 1.6 + ext], r: [-0.2, 0, 0], s: variant === 2 ? 0.86 : 0.78 });
  addSkull(a, paint(variant === 1 ? C.boneDirty : C.bone, 0));
  a.pop();
  a.addM('kit', rod(F(0.26, 0.64, 1.51), F(0.2, 0.86, 1.6), 0.02, 4), frameLook);

  // lamps on stalks beside the skull
  a.addM('kit', rod(F(0.3, 0.6, 1.5), F(0.5, 0.7, 1.52), 0.018, 4), frameLook);
  a.addM('kit', cylZ(0.085, 0.07, 0.1, 8), L.blackMetal, { p: [0.5, 0.72, 1.55 + ext] });
  a.addM('head', cylZ(0.055, 0.072, 0.024, 8), L.lens, { p: [0.5, 0.72, 1.61 + ext] });

  // red light bar on the front hoop (accent)
  a.add('kit', box(0.82, 0.08, 0.07), L.blackMetal, { p: [0, 1.41, 0.25] });
  for (const lx of [-0.3, -0.1, 0.1, 0.3]) a.add('accent', box(0.13, 0.055, 0.03), paint(0xffffff, 0), { p: [lx, 1.41, 0.29] });

  // --- front weapons: spikes or dozer blade
  let frontZ = 1.72 + ext;
  if (variant === 1) {
    const R = 0.5;
    const outer: P2[] = [];
    const inner: P2[] = [];
    for (let i = 0; i <= 6; i++) {
      const ang = lerp(-0.95, 0.85, i / 6);
      outer.push([1.86 + R * (1 - Math.cos(ang)), 0.5 + R * Math.sin(ang)]);
      inner.push([1.82 + R * (1 - Math.cos(ang)), 0.5 + R * Math.sin(ang)]);
    }
    const blade = profileX([...outer, ...inner.reverse()], 1.84, 0, 8);
    colorTris(blade, (cen, nor) => {
      if (nor.z < 0.2) return C.rustDark;
      const band = Math.floor((cen.x + 0.92 + cen.y * 0.35) / 0.23);
      return band % 2 === 0 ? C.bone : C.raiderRed;
    });
    a.add('paint', blade, paint(C.bone));
    a.addM('kit', rod(F(0.32, 0.4, 1.5), v(0.6, 0.3, 1.84), 0.035, 5), L.steelDark);
    a.addM('kit', rod(F(0.28, 0.64, 1.48), v(0.6, 0.72, 1.86), 0.03, 5), L.steelDark);
    for (let i = -3; i <= 3; i++) a.add('kit', rod(v(i * 0.27, 0.88, 2.0), v(i * 0.27, 1.06, 2.12), 0.04, 4, 0), L.steelDark);
    for (const sz of [0.32, 0.02, -0.28]) a.addM('kit', rod(v(0.66, 0.6, sz), v(1.0, 0.64, sz), 0.045, 4, 0), L.steelDark);
    frontZ = 2.14;
  } else {
    for (let i = -2; i <= 2; i++) {
      const bx = i * 0.2;
      a.add('kit', rod(F(bx, 0.37, 1.67), F(bx * 1.5, 0.42 + Math.abs(i) * 0.02, 2.06 - Math.abs(i) * 0.05), 0.045, 4, 0), L.steelDark);
    }
    a.addM('kit', plate([F(0.4, 0.3, 1.64), F(0.62, 0.34, 1.5), F(0.66, 0.52, 1.44), F(0.42, 0.5, 1.66)], 0.014, v(0.3, 0, 1)), L.rustDark);
    frontZ = 2.08 + ext;
  }

  // --- variant 2: twin war flags on the hoop
  if (variant === 2) {
    for (const s of [1, -1]) {
      a.add('kit', rod(v(s * 0.5, 1.42, -0.4), v(s * 0.56, 2.62, -0.66), 0.018, 4, 0.012), L.steelDark);
      a.add('paint', plate([v(s * 0.56, 2.58, -0.66), v(s * 0.55, 2.12, -0.57), v(s * 0.56, 2.3, -1.3)], 0.008, v(s, 0, 0)), paint(s > 0 ? C.raiderRed : C.bone, 0));
      a.add('paint', plate([v(s * 0.55, 2.1, -0.57), v(s * 0.54, 1.92, -0.53), v(s * 0.55, 2.0, -0.95)], 0.008, v(s, 0, 0)), paint(C.raiderRedDark, 0));
    }
  }

  // --- pintle gun on the roll hoop (fixed)
  const GY = 1.66;
  const GZ = -0.3;
  a.add('kit', rod(v(0, 1.43, -0.4), v(0, GY - 0.06, -0.36), 0.03, 5), L.steelDark);
  a.add('kit', box(0.11, 0.13, 0.42), L.blackMetal, { p: [0, GY, GZ] });
  a.add('kit', rod(v(0, GY + 0.01, GZ + 0.2), v(0, GY + 0.01, GZ + 0.98), 0.024, 6, 0.022, false), L.blackMetal);
  a.add('kit', rod(v(0, GY + 0.01, GZ + 0.2), v(0, GY + 0.01, GZ + 0.6), 0.042, 6, 0.042, false), L.steel);
  a.add('kit', rod(v(0, GY + 0.01, GZ + 0.94), v(0, GY + 0.01, GZ + 1.02), 0.036, 6, 0.036, false), L.steelDark);
  a.add('kit', box(0.12, 0.16, 0.2), L.olive, { p: [0.13, GY - 0.02, GZ + 0.02] });
  a.addM('kit', rod(v(0.04, GY, GZ - 0.2), v(0.07, GY - 0.02, GZ - 0.34), 0.014, 4), L.steelDark);
  a.addM('kit', plate([v(0.05, GY - 0.14, GZ + 0.26), v(0.24, GY - 0.12, GZ + 0.2), v(0.22, GY + 0.16, GZ + 0.16), v(0.05, GY + 0.14, GZ + 0.24)], 0.014, AXIS_Z), L.rustDark);

  const bodyGeo = finishBody(a, 0.7, 0.5);

  const rimLook = look(variant === 1 ? 0x5b5148 : C.raiderRedDark, 0.6, 0.6, 0);
  const front = wheelGeometry(`buggyFront${variant === 1 ? 'B' : 'A'}`, { r: FR, w: 0.26, seg: 14, lugs: 9, rim: rimLook, spokes: 4, nuts: 0, hubSpike: 0.2, dual: false });
  const rear = wheelGeometry(`buggyRear${variant === 1 ? 'B' : 'A'}`, { r: RR, w: 0.44, seg: 14, lugs: 10, rim: rimLook, spokes: 4, nuts: 0, hubSpike: 0.24, dual: false });

  // keep the origin under the vehicle centre: the long variant grows forward only, so slide it back
  const rearZ = variant === 2 ? -1.66 : -1.95;
  const dz = variant === 2 ? -(frontZ + rearZ) / 2 : 0;
  if (dz !== 0) {
    for (const g of [bodyGeo.paint, bodyGeo.kit, bodyGeo.glass, bodyGeo.head, bodyGeo.tail, bodyGeo.accent]) {
      if (!g) continue;
      g.translate(0, 0, dz);
      g.computeBoundingBox();
      g.computeBoundingSphere();
    }
  }
  const sock = (s: Socket): Socket => ({ p: [s.p[0], s.p[1], s.p[2] + dz], d: s.d });
  const halfLen = Math.max(frontZ + dz, -(rearZ + dz));
  return {
    ...bodyGeo,
    bodyMuzzles: [sock({ p: [0, GY + 0.01, GZ + 1.04], d: [0, 0, 1] })],
    exhausts: exhausts.map(sock),
    wheels: [
      { name: 'wheelFL', p: [0.8, FR, fAxle + dz], geo: front.left, steer: true },
      { name: 'wheelFR', p: [-0.8, FR, fAxle + dz], geo: front.right, steer: true },
      { name: 'wheelRL', p: [0.76, RR, rAxle + dz], geo: rear.left, steer: false },
      { name: 'wheelRR', p: [-0.76, RR, rAxle + dz], geo: rear.right, steer: false },
    ],
    halfExtents: { x: variant === 1 ? 1.0 : 0.98, y: 0.78, z: Math.round(halfLen * 100) / 100 },
    wheelRadius: 0.45,
  };
}

const variantIndex = (variant: number): number => (Number.isFinite(variant) ? ((Math.floor(variant) % 3) + 3) % 3 : 0);

export function createRaiderBuggy(variant: number): VehicleModel {
  const vi = variantIndex(variant);
  let bp = buggyBlueprints.get(vi);
  if (!bp) {
    bp = buildBuggy(vi);
    buggyBlueprints.set(vi, bp);
  }
  const grime = grimeTexture();
  const paintMat = new THREE.MeshStandardMaterial({
    name: 'raiderPaint',
    color: 0xffffff,
    vertexColors: true,
    map: grime,
    roughnessMap: grime,
    roughness: 0.82,
    metalness: 0.25,
  });
  return instantiate(bp, {
    name: `raiderBuggy${vi}`,
    paint: paintMat,
    scorchRoughness: 1,
    headColor: 0xffe9b8,
    headEmissive: 0xffc56a,
    accentColor: 0xff3a1c,
    accentEmissive: 0xff2408,
    accentIntensity: 1.4,
  });
}

// ---------------------------------------------------------------- WAR RIG (boss)

let rigBlueprint: Blueprint | null = null;

function buildRig(): Blueprint {
  const a = new Asm(500);
  const WR = 0.62;
  const FZ = 3.05;
  const R1 = -2.0;
  const R2 = -3.45;
  const up = AXIS_Y;
  const outX = v(1, 0, 0);

  // --- ladder chassis
  a.addM('kit', box(0.16, 0.3, 8.7), L.frame, { p: [0.5, 0.98, -0.2] });
  for (const cz of [3.7, 1.5, -0.5, -2.72, -4.3]) a.add('kit', box(1.0, 0.2, 0.14), L.frame, { p: [0, 0.98, cz] });
  a.add('kit', rod(v(-1.2, WR, FZ), v(1.2, WR, FZ), 0.09, 6), L.steelDark);
  for (const rz of [R1, R2]) {
    a.add('kit', rod(v(-1.1, WR, rz), v(1.1, WR, rz), 0.11, 6), L.steelDark);
    a.add('kit', new THREE.SphereGeometry(0.27, 8, 6), L.rustDark, { p: [0, WR, rz] });
  }
  a.add('kit', rod(v(0, 0.7, 1.6), v(0, WR, R1), 0.06, 5), L.steelDark);
  a.add('kit', box(1.7, 0.36, 6.0), L.matte, { p: [0, 1.2, -1.35] });
  a.add('kit', box(2.3, 0.5, 1.5), L.matte, { p: [0, 1.25, 3.05] });
  // saddle fuel tanks, straps, steps
  a.addM('kit', cylZ(0.33, 0.33, 1.5, 12), look(0x3b3d40, 0.45, 0.85, 0), { p: [1.08, 0.82, 0.55] });
  for (const sz of [0.05, 1.05]) a.addM('kit', cylZ(0.345, 0.345, 0.07, 12, true), L.rustDark, { p: [1.08, 0.82, sz] });
  a.addM('kit', box(0.34, 0.06, 0.5), L.steelDark, { p: [1.3, 0.62, 1.75] });
  a.addM('kit', box(0.34, 0.06, 0.5), L.steelDark, { p: [1.3, 0.95, 1.8] });

  // --- cab-over cab: side profile extrusion with wheel arch, bevel, tumblehome
  const cabProfile: P2[] = [
    [2.1, 1.05],
    [2.1, 3.12],
    [2.28, 3.24],
    [3.45, 3.24],
    [3.72, 3.1],
    [3.93, 2.32],
    [4.0, 2.2],
    [4.0, 1.25],
    [3.9, 1.05],
    ...archPts(FZ, WR, 0.74, 1.05, 8).reverse(),
  ];
  const cabX = (y: number): number => 1.38 * (1 - 0.075 * sm(2.2, 3.24, y));
  let cab = profileX(cabProfile, 2.76, 0.05, 4, 2);
  colorTris(cab, (cen, nor) => {
    if (Math.abs(nor.x) > 0.8 && cen.y < 1.7) return C.rigOxide;
    if (nor.y > 0.8) return C.rigIronLight;
    return C.rigIron;
  });
  deform(cab, (p) => {
    p.x *= cabX(p.y) / 1.38;
  });
  cab = toCreasedNormals(cab, 0.55);
  a.add('paint', cab, paint(C.rigIron));

  a.addM('paint', archFlare(0.75, 0.9, 0.3, 0.1), paint(C.rigIronLight), { p: [1.33, WR, FZ] });

  // windshield: dark glass behind armour bands (two slits) and a bar cage
  const wz = (y: number): number => 3.93 - (y - 2.32) * 0.269;
  const wn = v(0, 0.26, 1).normalize();
  const wpt = (x: number, y: number, off: number): V3 => v(x, y, wz(y)).addScaledVector(wn, off);
  a.add('glass', plate([wpt(1.14, 2.42, 0.004), wpt(1.08, 3.02, 0.004), wpt(-1.08, 3.02, 0.004), wpt(-1.14, 2.42, 0.004)], 0.02, wn), paint(0xffffff, 0));
  const bands: [number, number, number][] = [
    [2.34, 2.57, C.rigOxide],
    [2.68, 2.8, C.rigIronLight],
    [2.91, 3.09, C.rigIron],
  ];
  for (const [y0, y1, c] of bands) {
    a.add('paint', plate([wpt(1.24, y0, 0.03), wpt(1.2, y1, 0.03), wpt(-1.2, y1, 0.03), wpt(-1.24, y0, 0.03)], 0.04, wn), paint(c, 0.06));
  }
  for (let i = -3; i <= 3; i++) {
    a.add('kit', rod(wpt(i * 0.34, 2.28, 0.1), wpt(i * 0.33, 3.14, 0.1), 0.022, 5), L.steelDark);
  }
  a.add('paint', plate([v(1.34, 3.2, 3.5), v(-1.34, 3.2, 3.5), v(-1.3, 3.02, 4.12), v(1.3, 3.02, 4.12)], 0.05, up), paint(C.rigIronLight));
  // side slit windows + door plates + grab rails
  a.addM('glass', plate([v(cabX(2.5) + 0.004, 2.5, 2.85), v(cabX(2.5) + 0.004, 2.5, 3.62), v(cabX(2.96) + 0.004, 2.96, 3.52), v(cabX(2.96) + 0.004, 2.96, 2.85)], 0.012, outX), paint(0xffffff, 0));
  a.addM('paint', plate([v(cabX(2.66) + 0.01, 2.66, 2.78), v(cabX(2.66) + 0.01, 2.66, 3.66), v(cabX(2.8) + 0.01, 2.8, 3.63), v(cabX(2.8) + 0.01, 2.8, 2.78)], 0.035, outX), paint(C.rigIronLight));
  a.addM('paint', plate([v(1.385, 1.55, 2.5), v(1.385, 1.55, 3.7), v(cabX(2.38) + 0.005, 2.38, 3.74), v(cabX(2.38) + 0.005, 2.38, 2.5)], 0.035, outX), paint(C.rigOxide, 0.08));
  a.addM('kit', rod(v(1.44, 1.7, 2.32), v(1.42, 2.9, 2.32), 0.025, 5), L.steelDark);
  // roof: light bar, red cab markers, horns
  a.add('kit', box(2.0, 0.1, 0.14), L.blackMetal, { p: [0, 3.32, 3.3] });
  for (const lx of [-0.78, -0.3, 0.3, 0.78]) {
    a.add('kit', cylZ(0.11, 0.1, 0.14, 8), L.steelDark, { p: [lx, 3.45, 3.3] });
    a.add('head', cylZ(0.075, 0.09, 0.03, 8), L.lens, { p: [lx, 3.45, 3.385] });
  }
  for (let i = -2; i <= 2; i++) a.add('accent', box(0.14, 0.06, 0.09), paint(0xffffff, 0), { p: [i * 0.5, 3.255, 3.56], r: [0.3, 0, 0] });
  a.addM('kit', rod(v(0.5, 3.3, 2.5), v(0.5, 3.32, 3.1), 0.035, 6, 0.08), L.chrome);

  // front face: grille, skull, caged headlights, bumper
  a.add('kit', box(1.56, 0.86, 0.06), L.matte, { p: [0, 1.74, 4.01] });
  for (let i = 0; i < 6; i++) a.add('kit', box(1.5, 0.035, 0.05), L.steelDark, { p: [0, 1.38 + i * 0.145, 4.04] });
  a.push({ p: [0, 1.78, 4.08], s: 1.1 });
  addSkull(a, paint(C.boneDirty, 0));
  a.pop();
  a.addM('kit', cylZ(0.16, 0.16, 0.1, 10), L.steelDark, { p: [1.07, 1.5, 4.02] });
  a.addM('head', cylZ(0.1, 0.13, 0.03, 10), L.lens, { p: [1.07, 1.5, 4.085] });
  a.addM('kit', rod(v(0.9, 1.5, 4.12), v(1.24, 1.5, 4.12), 0.014, 4), L.steelDark);
  a.addM('kit', rod(v(1.07, 1.33, 4.12), v(1.07, 1.67, 4.12), 0.014, 4), L.steelDark);
  a.add('kit', box(2.0, 0.34, 0.22), look(0x2c2d2f, 0.6, 0.8, 0), { p: [0, 0.98, 4.0] });
  a.add('accent', box(2.3, 0.05, 0.03), paint(0xffffff, 0), { p: [0, 2.25, 4.02] });

  // --- V plow with hazard stripes
  const pb = v(0, 0.2, 4.74);
  const pm = v(0, 1.15, 4.92);
  const pt = v(0, 1.95, 5.0);
  const wb = v(1.6, 0.2, 3.72);
  const wm = planarZ(pb, wb, pm, v(1.64, 1.15, 3.87));
  const wt = planarZ(pm, wm, pt, v(1.68, 1.58, 3.95));
  const plowOut = v(0.6, 0, 1);
  const plowLook = look(0x333436, 0.55, 0.8, 0.04);
  a.addM('kit', plate([pb, wb, wm, pm], 0.07, plowOut), plowLook);
  a.addM('kit', plate([pm, wm, wt, pt], 0.07, plowOut), look(C.rustDark, 0.7, 0.55, 0.05));
  const plowN = wb.clone().sub(pb).cross(pm.clone().sub(pb)).normalize();
  if (plowN.dot(plowOut) < 0) plowN.negate();
  const Q = (u: number, w: number): V3 =>
    pb.clone().lerp(wb, u).lerp(pm.clone().lerp(wm, u), w).addScaledVector(plowN, 0.071);
  for (let i = 0; i < 5; i++) {
    const u0 = 0.06 + i * 0.185;
    a.addM('kit', plate([Q(u0, 0.05), Q(u0 + 0.085, 0.05), Q(u0 + 0.19, 0.96), Q(u0 + 0.105, 0.96)], 0.008, plowOut), look(C.hazard, 0.7, 0.2, 0.1));
  }
  a.add('kit', rod(v(0, 0.16, 4.76), v(0, 2.0, 5.04), 0.085, 6, 0.06, false), L.rustDark);
  for (let i = 0; i < 4; i++) {
    const base = pt.clone().lerp(wt, 0.12 + i * 0.26);
    a.addM('kit', rod(base, base.clone().add(v(0.05, 0.36, 0.16)), 0.06, 4, 0), L.steelDark);
  }
  a.addM('kit', rod(v(1.35, 1.0, 4.1), wm.clone().add(v(-0.25, -0.2, -0.14)), 0.05, 5), L.steelDark);
  a.addM('kit', rod(v(0.5, 1.0, 4.1), v(0.4, 0.7, 4.36), 0.05, 5), L.steelDark);
  // teeth along the cutting edge
  for (let i = 0; i < 5; i++) {
    const base = pb.clone().lerp(wb, 0.1 + i * 0.2).add(v(0, 0.02, 0));
    a.addM('kit', rod(base, base.clone().addScaledVector(plowN, 0.26).add(v(0, -0.08, 0)), 0.06, 4, 0), L.steel);
  }

  // --- twin stacks behind the cab
  a.addM('kit', rod(v(1.2, 1.15, 1.92), v(1.2, 3.72, 1.92), 0.1, 10, 0.1, false), look(0x6f6a64, 0.38, 0.9, 0));
  a.addM('kit', rod(v(1.2, 1.95, 1.92), v(1.2, 3.0, 1.92), 0.15, 8, 0.15, false), L.blackMetal);
  for (let i = 0; i < 4; i++) a.addM('kit', cylY(0.16, 0.16, 0.05, 8, true), L.steelDark, { p: [1.2, 2.1 + i * 0.26, 1.92] });
  a.addM('kit', rod(v(1.2, 3.68, 1.92), v(1.2, 3.96, 1.8), 0.1, 8, 0.115), L.rustDark);
  a.addM('kit', box(0.5, 0.06, 0.1), L.steelDark, { p: [1.0, 2.6, 1.92] });

  // --- armoured tank body: octagonal extrusion, weld plates, hoops
  const HW = 1.36;
  const HH = 0.85;
  const CH = 0.4;
  const TY = 2.15;
  const T0 = -4.45;
  const T1 = 1.75;
  const oct: [number, number][] = [
    [HW - CH, -HH],
    [HW, -HH + CH],
    [HW, HH - CH],
    [HW - CH, HH],
    [-HW + CH, HH],
    [-HW, HH - CH],
    [-HW, -HH + CH],
    [-HW + CH, -HH],
  ];
  const octShape = (k: number): THREE.Shape => new THREE.Shape(oct.map(([x, y]) => new THREE.Vector2(x * k, y * k)));
  const tank = new THREE.ExtrudeGeometry(octShape(1), {
    depth: T1 - T0 - 0.14,
    steps: 1,
    curveSegments: 1,
    bevelEnabled: true,
    bevelSize: 0.07,
    bevelThickness: 0.07,
    bevelOffset: -0.07,
    bevelSegments: 1,
  });
  tank.translate(0, TY, T0 + 0.07);
  colorTris(tank, (cen, nor) => {
    if (nor.y > 0.9) return C.rigIronLight;
    if (Math.abs(nor.x) > 0.9) return cen.y < TY ? C.rigOxide : C.rigIron;
    return C.rigIron;
  });
  a.add('paint', tank, paint(C.rigIron));
  for (const hz of [1.25, 0.0, -1.3, -2.6, -3.95]) {
    const hoop = new THREE.ExtrudeGeometry(octShape(1.03), { depth: 0.12, steps: 1, curveSegments: 1, bevelEnabled: false });
    hoop.translate(0, TY * (1 - 1.03) + TY * 1.03 - TY * 0.03, hz);
    a.add('kit', hoop, L.steelDark, { p: [0, TY - TY, 0] });
  }
  // welded patch plates (different each side)
  const patchRand = rng(31337);
  for (const s of [1, -1]) {
    let z = 1.0;
    for (let i = 0; i < 5; i++) {
      const len = Math.min(0.7 + patchRand() * 0.6, z - (T0 + 0.25));
      if (len < 0.3) break;
      const y0 = TY - 0.42 + patchRand() * 0.2;
      const y1 = TY + 0.1 + patchRand() * 0.32;
      const sk = (patchRand() - 0.5) * 0.14;
      const tones = [C.rigIronLight, C.rigOxide, C.rustDark, C.rigIron];
      const tone = tones[Math.floor(patchRand() * tones.length)];
      const x = s * (HW + 0.002);
      a.add('paint', plate([v(x, y0, z), v(x, y0 + sk, z - len), v(x, y1, z - len + 0.05), v(x, y1 - sk, z - 0.03)], 0.035, v(s, 0, 0)), paint(tone, 0.1));
      scatterBolts(a, [v(x + s * 0.036, y0 + 0.07, z - 0.08), v(x + s * 0.036, y1 - 0.08, z - len + 0.12)], 0.05, v(s, 0, 0), L.steelDark);
      z -= len + 0.1 + patchRand() * 0.25;
    }
  }
  // upper chamfer plates + spike rows
  a.addM('paint', plate([v(HW - CH + 0.02, TY + HH + 0.002, 0.9), v(HW + 0.002, TY + HH - CH + 0.02, 0.9), v(HW + 0.002, TY + HH - CH + 0.02, -0.6), v(HW - CH + 0.02, TY + HH + 0.002, -0.5)], 0.03, v(1, 1, 0)), paint(C.rigOxide, 0.1));
  a.addM('paint', plate([v(HW - CH + 0.02, TY + HH + 0.002, -2.2), v(HW + 0.002, TY + HH - CH + 0.02, -2.3), v(HW + 0.002, TY + HH - CH + 0.02, -3.7), v(HW - CH + 0.02, TY + HH + 0.002, -3.7)], 0.03, v(1, 1, 0)), paint(C.rigIronLight, 0.1));
  for (let i = 0; i < 9; i++) {
    const sz = 1.4 - i * 0.66;
    a.addM('kit', rod(v(HW - CH * 0.5, TY + HH - CH * 0.5, sz), v(HW - CH * 0.5 + 0.2, TY + HH - CH * 0.5 + 0.34, sz), 0.06, 4, 0), L.steelDark);
  }
  // catwalk + rails
  a.add('kit', box(1.0, 0.04, 5.9), L.steelDark, { p: [0, TY + HH + 0.03, -1.35] });
  a.addM('kit', rod(v(0.5, TY + HH + 0.34, 1.5), v(0.5, TY + HH + 0.34, -0.2), 0.02, 4), L.steelDark);
  a.addM('kit', rod(v(0.5, TY + HH + 0.34, -2.9), v(0.5, TY + HH + 0.34, -4.3), 0.02, 4), L.steelDark);
  for (const pz of [1.5, 0.65, -0.2, -2.9, -3.6, -4.3]) a.addM('kit', rod(v(0.5, TY + HH, pz), v(0.5, TY + HH + 0.34, pz), 0.02, 4), L.steelDark);
  // red accent strips along the flanks
  a.addM('accent', box(0.03, 0.07, 5.6), paint(0xffffff, 0), { p: [HW + 0.012, TY + HH - CH - 0.09, -1.35] });
  for (let i = 0; i < 9; i++) a.addM('kit', box(0.05, 0.11, 0.12), L.blackMetal, { p: [HW + 0.014, TY + HH - CH - 0.09, 1.3 - i * 0.665] });
  // side skirts with teeth over the tandem axles
  const SK = 1.54;
  a.addM('paint', plate([v(SK, 1.14, -1.1), v(SK, 1.14, -4.35), v(SK, 1.58, -4.35), v(SK, 1.58, -1.1)], 0.035, outX), paint(C.rigIronLight, 0.05));
  for (let i = 0; i < 7; i++) {
    const tz = -1.1 - i * 0.464;
    a.addM('paint', plate([v(SK, 1.15, tz), v(SK, 1.15, tz - 0.464), v(SK, 0.82 + (i % 2) * 0.1, tz - 0.232)], 0.035, outX), paint(i % 2 === 0 ? C.rigOxide : C.rigIron, 0.08));
  }
  for (const bz of [-1.3, -2.72, -4.15]) a.addM('kit', box(0.24, 0.08, 0.1), L.steelDark, { p: [1.44, 1.48, bz] });
  // side gun sponsons (fixed, fire forward)
  const GYs = 2.1;
  let sponson = profileX(
    [
      [-0.5, -0.3],
      [-0.5, 0.3],
      [0.2, 0.3],
      [0.5, 0.12],
      [0.5, -0.16],
      [0.3, -0.3],
    ],
    0.34,
    0.02,
    1,
    1,
  );
  sponson = toCreasedNormals(sponson, 0.5);
  a.addM('paint', sponson, paint(C.rigIronLight), { p: [HW + 0.15, GYs, 0.75] });
  a.addM('kit', rod(v(HW + 0.17, GYs, 1.2), v(HW + 0.19, GYs, 2.3), 0.05, 8, 0.045, false), L.blackMetal);
  a.addM('kit', rod(v(HW + 0.17, GYs, 1.22), v(HW + 0.18, GYs, 1.7), 0.075, 8, 0.075, false), L.steelDark);
  a.addM('kit', rod(v(HW + 0.188, GYs, 2.2), v(HW + 0.19, GYs, 2.34), 0.07, 8, 0.07, false), L.steelDark);
  a.addM('accent', box(0.03, 0.08, 0.3), paint(0xffffff, 0), { p: [HW + 0.325, GYs + 0.14, 0.7] });
  // rear: tail plate, lights, bumper spikes, ladder, mud flaps, war banner
  a.add('kit', box(2.3, 0.5, 0.05), L.blackMetal, { p: [0, 1.5, T0 - 0.02] });
  a.addM('tail', box(0.5, 0.12, 0.04), L.lens, { p: [0.8, 1.52, T0 - 0.05] });
  a.add('accent', box(1.0, 0.05, 0.03), paint(0xffffff, 0), { p: [0, 1.36, T0 - 0.05] });
  a.add('kit', box(2.9, 0.22, 0.2), look(0x2c2d2f, 0.6, 0.8, 0), { p: [0, 0.9, -4.55] });
  for (let i = -2; i <= 2; i++) a.add('kit', rod(v(i * 0.6, 0.9, -4.6), v(i * 0.6, 0.92, -4.95), 0.07, 4, 0), L.steelDark);
  a.addM('kit', rod(v(0.25, 1.75, T0 - 0.06), v(0.25, 3.05, T0 - 0.06), 0.022, 4), L.steelDark);
  for (let i = 0; i < 5; i++) a.add('kit', rod(v(-0.25, 1.9 + i * 0.26, T0 - 0.06), v(0.25, 1.9 + i * 0.26, T0 - 0.06), 0.018, 4), L.steelDark);
  a.addM('kit', box(0.74, 0.66, 0.03), L.rubber, { p: [1.12, 0.62, -4.38] });
  a.add('kit', rod(v(0.95, TY + HH, -4.2), v(1.0, 4.45, -4.36), 0.03, 5, 0.02), L.steelDark);
  a.add('paint', plate([v(1.0, 4.4, -4.37), v(0.99, 3.62, -4.3), v(0.3, 3.74, -4.56), v(0.42, 4.2, -4.5)], 0.01, v(0.2, 0, -1)), paint(C.raiderRed, 0));
  a.add('paint', plate([v(0.99, 3.6, -4.3), v(0.985, 3.3, -4.27), v(0.62, 3.5, -4.42)], 0.01, v(0.2, 0, -1)), paint(C.raiderRedDark, 0));

  const bodyGeo = finishBody(a, 1.3, 0.5);

  // --- roof mortar turret
  const t = new Asm(71);
  t.add('t', cylY(0.62, 0.66, 0.12, 14), L.steelDark, { p: [0, 0.06, 0] });
  let housing = profileX(
    [
      [-0.56, 0.1],
      [-0.6, 0.5],
      [-0.22, 0.72],
      [0.26, 0.6],
      [0.6, 0.3],
      [0.6, 0.1],
    ],
    0.92,
    0.035,
    1,
    1,
  );
  deform(housing, (p) => {
    p.x *= 1 - 0.18 * sm(0.2, 0.72, p.y);
  });
  housing = toCreasedNormals(housing, 0.5);
  t.add('t', housing, look(0x35302d, 0.6, 0.7, 0));
  const pitch = (50 * Math.PI) / 180;
  const dir = v(0, Math.sin(pitch), Math.cos(pitch));
  const breech = v(0, 0.42, 0.02);
  const tip = breech.clone().addScaledVector(dir, 1.15);
  t.add('t', rod(breech, tip, 0.18, 10, 0.165, false), L.blackMetal);
  t.add('t', rod(breech.clone().addScaledVector(dir, 0.98), breech.clone().addScaledVector(dir, 1.17), 0.215, 10, 0.215, false), L.steelDark);
  t.add('t', rod(breech.clone().addScaledVector(dir, 0.25), breech.clone().addScaledVector(dir, 0.55), 0.225, 10, 0.225, false), L.rustDark);
  t.add('t', rod(tip.clone().addScaledVector(dir, 0.012), tip.clone().addScaledVector(dir, 0.022), 0.13, 8, 0.13, false), L.matte);
  t.addM('t', rod(v(0.27, 0.42, 0.1), v(0.27, 0.42, 0.1).addScaledVector(dir, 0.72), 0.05, 6, 0.05, false), L.chrome);
  t.addM('t', plate([v(0.44, 0.1, 0.62), v(0.5, 0.1, -0.3), v(0.42, 0.86, -0.2), v(0.38, 0.7, 0.5)], 0.035, v(1, 0, 0)), look(C.rigOxide, 0.75, 0.5, 0.06));
  for (let i = -1; i <= 1; i++) {
    t.add('t', cylY(0.07, 0.07, 0.3, 6), L.olive, { p: [i * 0.18, 0.56, -0.66] });
    t.add('t', rod(v(i * 0.18, 0.71, -0.66), v(i * 0.18, 0.85, -0.66), 0.07, 6, 0), look(C.raiderRed, 0.6, 0.3, 0));
  }
  t.add('t', box(0.66, 0.24, 0.2), L.steelDark, { p: [0, 0.3, -0.66] });
  t.add('t', cylY(0.16, 0.16, 0.05, 8), L.steel, { p: [-0.2, 0.69, -0.34], r: [0.5, 0, 0] });
  t.add('t', rod(v(0.3, 0.6, -0.4), v(0.33, 1.3, -0.5), 0.012, 4, 0.006), L.steelDark);
  const turretGeo = t.build('t') as THREE.BufferGeometry;

  const rimLook = look(0x3e3531, 0.6, 0.7, 0);
  const front = wheelGeometry('rigFront', { r: WR, w: 0.44, seg: 16, lugs: 10, rim: rimLook, spokes: 0, nuts: 8, hubSpike: 0.3, dual: false });
  const rear = wheelGeometry('rigRear', { r: WR, w: 0.78, seg: 16, lugs: 10, rim: rimLook, spokes: 0, nuts: 8, hubSpike: 0, dual: true });

  return {
    ...bodyGeo,
    turret: { geo: turretGeo, p: [0, TY + HH + 0.05, -1.55], muzzles: [{ p: [tip.x, tip.y + 0.03, tip.z + 0.03], d: [dir.x, dir.y, dir.z] }] },
    bodyMuzzles: [
      { p: [HW + 0.19, GYs, 2.38], d: [0, 0, 1] },
      { p: [-HW - 0.19, GYs, 2.38], d: [0, 0, 1] },
    ],
    exhausts: [
      { p: [1.2, 3.98, 1.79], d: [0, 0.92, -0.4] },
      { p: [-1.2, 3.98, 1.79], d: [0, 0.92, -0.4] },
    ],
    wheels: [
      { name: 'wheelFL', p: [1.2, WR, FZ], geo: front.left, steer: true },
      { name: 'wheelFR', p: [-1.2, WR, FZ], geo: front.right, steer: true },
      { name: 'wheelRL1', p: [1.1, WR, R1], geo: rear.left, steer: false },
      { name: 'wheelRR1', p: [-1.1, WR, R1], geo: rear.right, steer: false },
      { name: 'wheelRL2', p: [1.1, WR, R2], geo: rear.left, steer: false },
      { name: 'wheelRR2', p: [-1.1, WR, R2], geo: rear.right, steer: false },
    ],
    halfExtents: { x: 1.6, y: 1.8, z: 4.85 },
    wheelRadius: WR,
  };
}

export function createWarRig(): VehicleModel {
  if (!rigBlueprint) rigBlueprint = buildRig();
  const grime = grimeTexture();
  const paintMat = new THREE.MeshStandardMaterial({
    name: 'warRigPaint',
    color: 0xffffff,
    vertexColors: true,
    map: grime,
    roughnessMap: grime,
    roughness: 0.78,
    metalness: 0.55,
  });
  return instantiate(rigBlueprint, {
    name: 'warRig',
    paint: paintMat,
    scorchRoughness: 1,
    headColor: 0xffe9b8,
    headEmissive: 0xffc56a,
    accentColor: 0xff3a1c,
    accentEmissive: 0xff2408,
    accentIntensity: 1.5,
  });
}

// ---------------------------------------------------------------- WRECKS (instanced set dressing)

const wreckCache = new Map<number, THREE.BufferGeometry>();

/** Burnt-out husk: one merged geometry with a `color` attribute, origin on ground, forward +Z, ~4.4 m long. */
export function createWreckGeometry(variant: number): THREE.BufferGeometry {
  const vi = variantIndex(variant);
  const hit = wreckCache.get(vi);
  if (hit) return hit;
  const a = new Asm(900 + vi);
  const rand = a.rand;
  const tones = [0x3d2417, 0x55301b, 0x1b1613, 0x2a1f19, 0x6a3d20, 0x231c18];
  const char = (): Look => look(tones[Math.floor(rand() * tones.length)], 1, 0, 0.12);
  const soot = look(0x0f0d0c, 1, 0, 0.1);
  /** Scorched shell: patchy rust / soot per panel, sagging and dented. */
  const shell = (pts: readonly P2[], width: number, amt: number): THREE.BufferGeometry => {
    const g = profileX(pts, width, 0, 2);
    colorTris(g, (cen, nor) => {
      if (nor.y < -0.5) return 0x0f0d0c;
      // both triangles of a panel share a normal, so key panels by normal (+ a coarse band on the flanks)
      const key = Math.abs(nor.x) > 0.7 ? Math.sign(nor.x) * 7 + Math.round(cen.z * 0.8) : Math.round(nor.y * 9) * 3 + Math.round(nor.z * 9) + (cen.x > 0 ? 40 : 0);
      const h = Math.sin(key * 12.9898 + vi * 3.3) * 43758.5453;
      return tones[Math.floor((h - Math.floor(h)) * tones.length)];
    });
    return deform(g, (p) => {
      // position-hashed so welded corners stay welded
      const h = Math.sin(p.x * 12.9898 + p.y * 78.233 + p.z * 37.719 + vi * 4.1) * 43758.5453;
      const n = h - Math.floor(h) - 0.5;
      p.y += n * amt * (p.y > 0.5 ? 1 : 0.2);
      p.z += n * amt * 0.5;
      p.x *= 1 - 0.07 * sm(0.55, 0.95, p.y) - 0.05 * sm(1.7, 2.2, Math.abs(p.z));
    });
  };
  const wheel = (x: number, z: number, tilt: number, tyre: boolean): void => {
    const s = Math.sign(x);
    if (tyre) a.add('g', cylX(0.33, 0.33, 0.22, 9), soot, { p: [x, 0.3, z], r: [0, tilt, 0] });
    a.add('g', cylX(0.2, 0.2, tyre ? 0.25 : 0.2, 7), look(0x4a2e1e, 1, 0, 0.1), { p: [x + s * 0.005, tyre ? 0.3 : 0.2, z], r: [0, tilt, 0] });
  };
  const pillars = (posts: [number, number, number, number, number][], y0: number): void => {
    for (const [x0, z0, x1, y1, z1] of posts) a.addM('g', beam(v(x0, y0, z0), v(x1, y1, z1), 0.06, 0.08), char());
  };
  const arch = (cz: number): P2[] => archPts(cz, 0.3, 0.4, 0.2, 4);

  if (vi === 0) {
    // sedan on its rims, hood sprung, roof sagging
    const body: P2[] = [
      [2.08, 0.2],
      [2.2, 0.42],
      [2.16, 0.7],
      [1.0, 0.86],
      [-1.2, 0.88],
      [-2.12, 0.82],
      [-2.2, 0.45],
      [-2.05, 0.2],
      ...arch(-1.35),
      ...arch(1.35),
    ];
    a.add('g', shell(body, 1.74, 0.07), char());
    a.add('g', plate([v(0.76, 0.84, 0.98), v(-0.76, 0.84, 0.98), v(-0.72, 1.3, 1.9), v(0.72, 1.38, 1.84)], 0.04, AXIS_Y), look(0x6a3d20, 1, 0, 0));
    a.add('g', box(1.34, 0.06, 1.3), char(), { p: [0, 1.3, -0.45], r: [0.06, 0, 0.05] });
    pillars(
      [
        [0.74, 0.92, 0.64, 1.3, 0.2],
        [0.76, -0.36, 0.66, 1.3, -0.4],
        [0.74, -1.5, 0.63, 1.28, -1.08],
      ],
      0.84,
    );
    a.add('g', box(1.2, 0.3, 0.5), soot, { p: [0, 0.78, -0.1], r: [-0.2, 0, 0] });
    a.add('g', box(1.2, 0.34, 0.4), soot, { p: [0, 0.8, -0.95], r: [-0.2, 0, 0] });
    a.add('g', box(0.5, 0.3, 0.6), soot, { p: [0.1, 0.72, 1.45] });
    wheel(0.8, 1.35, 0.25, false);
    wheel(-0.8, 1.35, -0.1, true);
    wheel(0.8, -1.35, 0, true);
    wheel(-0.8, -1.35, 0.05, false);
    a.add('g', box(1.8, 0.14, 0.1), soot, { p: [0, 0.36, 2.24], r: [0, 0.07, 0.06] });
  } else if (vi === 1) {
    // hatchback slumped on a collapsed corner, door hanging open
    const body: P2[] = [
      [1.98, 0.2],
      [2.18, 0.4],
      [2.14, 0.64],
      [1.1, 0.84],
      [-2.0, 0.9],
      [-2.2, 0.5],
      [-2.02, 0.2],
      ...arch(-1.38),
      ...arch(1.32),
    ];
    a.push({ r: [0.05, 0, -0.075], p: [0, -0.03, 0] });
    a.add('g', shell(body, 1.7, 0.06), char());
    a.add('g', box(1.3, 0.06, 1.9), char(), { p: [0, 1.36, -0.95], r: [-0.03, 0, 0] });
    pillars(
      [
        [0.72, 0.95, 0.63, 1.36, 0.0],
        [0.75, -0.6, 0.64, 1.36, -0.62],
        [0.74, -2.05, 0.63, 1.36, -1.88],
      ],
      0.84,
    );
    a.add('g', plate([v(0.84, 0.36, 0.9), v(0.84, 0.88, 0.9), v(1.45, 0.9, 0.22), v(1.45, 0.38, 0.22)], 0.05, v(1, 0, 1)), look(0x55301b, 1, 0, 0));
    a.add('g', box(1.2, 0.34, 0.5), soot, { p: [0, 0.78, -0.1], r: [-0.2, 0, 0] });
    a.add('g', box(1.2, 0.3, 0.9), soot, { p: [0, 0.74, -1.3] });
    wheel(0.8, -1.38, 0, true);
    wheel(-0.8, -1.38, 0.08, true);
    wheel(0.8, 1.32, 0.5, false);
    a.pop();
    a.add('g', cylX(0.33, 0.33, 0.22, 9), soot, { p: [-1.3, 0.11, 1.95], r: [0, 0.4, 1.5] });
  } else {
    // pickup with a crushed cab and a bed full of debris
    const body: P2[] = [
      [2.02, 0.24],
      [2.2, 0.46],
      [2.16, 0.8],
      [0.9, 0.94],
      [-2.16, 0.92],
      [-2.2, 0.5],
      [-2.05, 0.24],
      ...archPts(-1.4, 0.32, 0.42, 0.24, 4),
      ...archPts(1.38, 0.32, 0.42, 0.24, 4),
    ];
    a.add('g', shell(body, 1.8, 0.05), char());
    a.add('g', box(1.44, 0.07, 1.0), char(), { p: [0, 1.34, 0.14], r: [0.16, 0, -0.1] });
    pillars(
      [
        [0.76, 0.82, 0.68, 1.42, 0.5],
        [0.78, -0.42, 0.7, 1.26, -0.36],
      ],
      0.9,
    );
    a.add('g', box(1.5, 0.44, 0.07), char(), { p: [0, 1.1, -0.42] });
    a.addM('g', box(0.07, 0.34, 1.72), char(), { p: [0.82, 1.06, -1.3] });
    a.add('g', box(1.66, 0.32, 0.07), char(), { p: [0, 0.96, -2.26], r: [-0.6, 0, 0] });
    a.add('g', box(0.7, 0.34, 0.5), soot, { p: [0.2, 1.06, -1.2], r: [0.2, 0.5, 0.1] });
    a.add('g', cylX(0.25, 0.25, 0.9, 8), look(0x55301b, 1, 0, 0), { p: [-0.1, 1.14, -1.8], r: [0, 0.3, 0] });
    a.add('g', box(1.2, 0.3, 0.6), soot, { p: [0, 0.84, 0.15] });
    wheel(0.84, 1.38, -0.2, true);
    wheel(-0.84, 1.38, 0, false);
    wheel(0.84, -1.4, 0, true);
    wheel(-0.84, -1.4, 0, true);
    a.add('g', box(1.86, 0.16, 0.12), soot, { p: [0.05, 0.42, 2.24], r: [0, -0.08, -0.1] });
  }

  const geo = a.build('g') as THREE.BufferGeometry;
  geo.deleteAttribute('uv');
  // sit exactly on the ground, ash on upward faces, dust at the sills
  geo.computeBoundingBox();
  const minY = geo.boundingBox ? geo.boundingBox.min.y : 0;
  geo.translate(0, -minY, 0);
  const col = geo.getAttribute('color') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const ash = new THREE.Color(0x6a6058);
  for (let i = 0; i < col.count; i++) {
    const k = 0.28 * Math.max(0, nor.getY(i));
    col.setXYZ(i, lerp(col.getX(i), ash.r, k), lerp(col.getY(i), ash.g, k), lerp(col.getZ(i), ash.b, k));
  }
  dustGradient(geo, 0.4, 0.4);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  wreckCache.set(vi, geo);
  return geo;
}
