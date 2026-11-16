import * as THREE from 'three';
import { createSeededRandom } from '../../utils/random';
import { Soup, trs, type Fx, type Rgb } from './soup';
import { CARD, SIGN, type Rect } from './textures';

/**
 * Authored prop templates in local space (forward +Z, ground at y = 0).
 * A `Kit` separates hard-surface geometry from alpha cards and textured
 * sign faces so each part lands in the right merged draw call.
 */

export type Kit = { solid: Soup; cards: Soup; signs: Soup };

export function newKit(): Kit {
  return { solid: new Soup(), cards: new Soup(), signs: new Soup() };
}

export const PAL = {
  char: [0.03, 0.027, 0.025] as Rgb,
  soot: [0.055, 0.05, 0.047] as Rgb,
  rust: [0.21, 0.085, 0.04] as Rgb,
  rustLight: [0.3, 0.14, 0.065] as Rgb,
  steel: [0.085, 0.085, 0.09] as Rgb,
  steelLight: [0.2, 0.2, 0.2] as Rgb,
  galv: [0.3, 0.3, 0.29] as Rgb,
  rubber: [0.022, 0.022, 0.024] as Rgb,
  glass: [0.02, 0.028, 0.034] as Rgb,
  glassDust: [0.1, 0.11, 0.105] as Rgb,
  wood: [0.24, 0.165, 0.1] as Rgb,
  woodDark: [0.11, 0.075, 0.05] as Rgb,
  sand: [0.33, 0.28, 0.19] as Rgb,
  concrete: [0.3, 0.29, 0.27] as Rgb,
  cream: [0.42, 0.38, 0.3] as Rgb,
  white: [0.46, 0.45, 0.42] as Rgb,
  red: [0.3, 0.06, 0.045] as Rgb,
  teal: [0.06, 0.2, 0.2] as Rgb,
  mustard: [0.4, 0.27, 0.06] as Rgb,
  blue: [0.1, 0.17, 0.28] as Rgb,
  green: [0.09, 0.17, 0.1] as Rgb,
  bark: [0.075, 0.062, 0.052] as Rgb,
  amber: [1.0, 0.52, 0.08] as Rgb,
};

const mul = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Cheap deterministic 3D value hash for vertex paint variation. */
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Soot/char the paint: darker low down, random scorched patches, a burnt end if `burnZ` is set. */
function scorch(s: Soup, from: number, amount: number, burnZ: number | null = null, burnLen = 3): void {
  s.paint(from, (x, y, z, rgb) => {
    const patch = hash3(Math.round(x * 0.9), Math.round(y * 0.9), Math.round(z * 0.7));
    let k = amount * (0.25 + 0.75 * patch);
    if (burnZ !== null) k = Math.max(k, 1 - Math.min(1, Math.abs(z - burnZ) / burnLen));
    k = Math.min(1, k);
    const rusty = patch > 0.72 ? 0.5 : 0;
    rgb[0] = rgb[0] * (1 - k) + (PAL.char[0] * (1 - rusty) + PAL.rust[0] * rusty) * k;
    rgb[1] = rgb[1] * (1 - k) + (PAL.char[1] * (1 - rusty) + PAL.rust[1] * rusty) * k;
    rgb[2] = rgb[2] * (1 - k) + (PAL.char[2] * (1 - rusty) + PAL.rust[2] * rusty) * k;
  });
}

function wheel(s: Soup, x: number, y: number, z: number, r: number, w: number): void {
  s.cyl(x, y, z, r, r, w, 10, PAL.rubber, 'x');
  s.cyl(x + Math.sign(x) * (w * 0.5 + 0.005), y, z, r * 0.5, r * 0.5, 0.02, 8, PAL.rust, 'x');
}

// ------------------------------------------------------------------ bus

function busSection(s: Soup, z0: number, z1: number, paint: Rgb, front: boolean, rear: boolean, rng: () => number): void {
  const len = z1 - z0;
  const mid = (z0 + z1) / 2;
  const from = s.vertexCount;
  const shape = new THREE.Shape();
  const profile: [number, number][] = [[-1.25, 0.45], [1.25, 0.45], [1.25, 1.25], [1.22, 2.55], [1.05, 3.0], [0.6, 3.12], [-0.6, 3.12], [-1.05, 3.0], [-1.22, 2.55], [-1.25, 1.25]];
  profile.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const body = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false, steps: Math.max(2, Math.round(len / 1.5)) });
  body.translate(0, 0, z0);
  s.geo(body, null, paint);
  s.paint(from, (_x, y, _z, rgb) => {
    if (y > 2.9) {
      rgb[0] = PAL.soot[0] * 1.6;
      rgb[1] = PAL.soot[1] * 1.6;
      rgb[2] = PAL.soot[2] * 1.6;
    } else if (y < 0.5) {
      rgb[0] = PAL.char[0];
      rgb[1] = PAL.char[1];
      rgb[2] = PAL.char[2];
    }
  });
  // livery stripe
  for (const side of [-1, 1]) s.box(side * 1.255, 1.32, mid, 0.03, 0.2, len - 0.3, PAL.red);
  // window band
  const count = Math.max(2, Math.floor((len - 0.8) / 1.45));
  const pitch = (len - 0.8) / count;
  for (const side of [-1, 1]) {
    for (let n = 0; n < count; n += 1) {
      const wz = z0 + 0.4 + pitch * (n + 0.5);
      const isDoor = side > 0 && (n === 0 || n === Math.floor(count / 2));
      if (isDoor) {
        s.box(side * 1.235, 1.55, wz, 0.05, 2.05, pitch - 0.3, PAL.char);
        continue;
      }
      const state = rng();
      const col = state < 0.45 ? PAL.char : state < 0.8 ? PAL.glass : PAL.glassDust;
      s.box(side * 1.215, 2.0, wz, 0.05, 0.9, pitch - 0.22, col);
    }
  }
  // roof kit
  s.box(0, 3.24, mid, 1.5, 0.24, Math.min(2.6, len * 0.4), PAL.soot);
  // wheels
  const axles = len > 8 ? [z0 + 1.7, z1 - 2.1] : [front ? z1 - 2.0 : z0 + 1.6];
  for (const az of axles) {
    for (const side of [-1, 1]) {
      wheel(s, side * 1.08, 0.5 - (rng() < 0.4 ? 0.12 : 0), az, 0.5, 0.32);
      s.box(side * 1.2, 0.98, az, 0.12, 0.16, 1.35, PAL.char);
    }
  }
  if (front) {
    s.box(0, 2.02, z1 + 0.01, 2.2, 1.05, 0.06, PAL.glass);
    s.box(0, 2.82, z1 + 0.01, 1.7, 0.3, 0.07, [0.1, 0.06, 0.02]);
    s.box(0, 0.64, z1 + 0.06, 2.5, 0.3, 0.2, PAL.steel);
    for (const side of [-1, 1]) s.box(side * 0.95, 1.02, z1 + 0.02, 0.3, 0.18, 0.06, PAL.glassDust);
    s.beam(1.25, 2.4, z1 - 0.1, 1.62, 2.2, z1 + 0.25, 0.05, PAL.steel);
    s.box(1.64, 2.05, z1 + 0.27, 0.06, 0.4, 0.2, PAL.steel);
  }
  if (rear) {
    s.box(0, 2.1, z0 - 0.01, 2.0, 0.8, 0.06, PAL.glass);
    s.box(0, 1.02, z0 - 0.01, 1.7, 0.62, 0.06, PAL.char);
    s.box(0, 0.62, z0 - 0.05, 2.5, 0.28, 0.18, PAL.steel);
  }
  scorch(s, from, 0.55, rear ? z0 : null, 3.2);
}

/** Articulated bus: [front section, rear section], both with the joint at the origin. */
export function buildArticulatedBus(seed: number): [Soup, Soup] {
  const rng = createSeededRandom(seed);
  const front = new Soup();
  const rear = new Soup();
  busSection(front, 0.5, 7.2, PAL.cream, true, false, rng);
  // bellows
  for (let n = 0; n < 4; n += 1) front.box(0, 1.78, -0.36 + n * 0.25, 2.3 - (n % 2) * 0.14, 2.5 - (n % 2) * 0.14, 0.22, PAL.rubber);
  busSection(rear, -6.0, -0.5, PAL.cream, false, true, rng);
  return [front, rear];
}

export function buildBus(seed: number): Soup {
  const s = new Soup();
  busSection(s, -5.3, 5.3, PAL.cream, true, true, createSeededRandom(seed));
  return s;
}

// ------------------------------------------------------------------ trucks

/** Cab-over truck cab occupying z ∈ [0, 2.05]. */
function truckCab(s: Soup, paint: Rgb): void {
  const from = s.vertexCount;
  const shape = new THREE.Shape();
  const profile: [number, number][] = [[0, 0.55], [2.0, 0.55], [2.0, 1.35], [1.93, 1.5], [1.72, 2.6], [1.5, 2.76], [0, 2.76]];
  profile.forEach(([z, y], i) => (i === 0 ? shape.moveTo(z, y) : shape.lineTo(z, y)));
  shape.closePath();
  const body = new THREE.ExtrudeGeometry(shape, { depth: 2.3, bevelEnabled: false });
  body.rotateY(-Math.PI / 2);
  body.translate(1.15, 0, 0);
  s.geo(body, null, paint);
  s.box(0, 2.05, 1.84, 2.02, 1.0, 0.05, PAL.glass, 0, -0.19);
  for (const side of [-1, 1]) {
    s.box(side * 1.16, 2.08, 1.1, 0.04, 0.72, 0.95, PAL.glass);
    wheel(s, side * 1.0, 0.5, 1.2, 0.5, 0.3);
    s.box(side * 0.82, 1.0, 2.01, 0.34, 0.2, 0.05, PAL.glassDust);
    s.beam(side * 1.15, 2.3, 1.7, side * 1.5, 2.2, 1.9, 0.045, PAL.steel);
    s.box(side * 1.52, 2.0, 1.92, 0.06, 0.42, 0.18, PAL.steel);
  }
  s.box(0, 1.08, 2.01, 1.2, 0.46, 0.05, PAL.char);
  s.box(0, 0.62, 2.07, 2.36, 0.3, 0.22, PAL.steel);
  s.box(0, 2.8, 1.5, 2.1, 0.07, 0.5, PAL.soot);
  scorch(s, from, 0.5);
}

export function buildBoxTruck(seed: number): Soup {
  const rng = createSeededRandom(seed);
  const s = new Soup();
  const cab = new Soup();
  truckCab(cab, PAL.blue);
  s.stamp(cab, trs(0, 0, 1.85));
  // chassis
  for (const side of [-1, 1]) {
    s.box(side * 0.55, 0.78, -1.0, 0.14, 0.24, 6.2, PAL.steel);
    wheel(s, side * 0.98, 0.5, -2.3, 0.5, 0.56);
    s.beam(side * 1.18, 0.55, -1.4, side * 1.18, 0.55, 1.2, 0.07, PAL.steel);
  }
  s.cyl(-0.95, 0.72, 0.3, 0.3, 0.3, 0.9, 8, PAL.steelLight, 'z');
  // cargo box z ∈ [-4.1, 1.7]
  const from = s.vertexCount;
  s.geo(new THREE.BoxGeometry(2.44, 2.5, 5.8, 1, 2, 4), trs(0, 2.25, -1.2), PAL.white);
  for (const side of [-1, 1]) {
    for (const z of [-4.02, 1.62]) s.box(side * 1.2, 2.25, z, 0.1, 2.56, 0.1, PAL.galv);
    s.box(side * 1.2, 3.5, -1.2, 0.1, 0.1, 5.8, PAL.galv);
    s.box(side * 1.2, 1.02, -1.2, 0.1, 0.12, 5.8, PAL.galv);
    // faded livery block
    s.box(side * 1.226, 2.45, -1.0, 0.02, 0.7, 3.8, mix(PAL.teal, PAL.white, 0.25));
    s.box(side * 1.23, 2.45, 0.2, 0.02, 0.38, 0.9, PAL.mustard);
  }
  // rear roll door, jammed half open
  for (let n = 0; n < 5; n += 1) s.box(0, 3.3 - n * 0.3, -4.13, 2.2, 0.27, 0.05, n % 2 === 0 ? PAL.galv : mul(PAL.galv, 0.7));
  s.box(0, 1.5, -4.05, 2.2, 1.0, 0.04, PAL.char);
  s.box(0, 0.62, -4.16, 2.3, 0.14, 0.12, PAL.steel);
  scorch(s, from, 0.35 + rng() * 0.2);
  return s;
}

/** Tanker: [trailer centred on origin, tractor with the kingpin at the origin]. */
export function buildTanker(): [Soup, Soup] {
  const trailer = new Soup();
  const from = trailer.vertexCount;
  const tank = new THREE.CylinderGeometry(1.2, 1.2, 8.2, 14, 4, false);
  tank.rotateX(Math.PI / 2);
  tank.translate(0, 2.2, 0);
  trailer.geo(tank, null, [0.36, 0.35, 0.33]);
  for (const end of [-1, 1]) {
    const cap = new THREE.CylinderGeometry(end > 0 ? 0.72 : 1.2, end > 0 ? 1.2 : 0.72, 0.34, 14, 1, false);
    cap.rotateX(Math.PI / 2);
    cap.translate(0, 2.2, end * 4.27);
    trailer.geo(cap, null, [0.33, 0.32, 0.3]);
  }
  scorch(trailer, from, 0.4, 4.3, 4.5);
  for (const z of [-2.7, 0, 2.7]) trailer.cyl(0, 2.2, z, 1.235, 1.235, 0.14, 14, PAL.steel, 'z', true);
  trailer.box(0, 3.43, 0, 0.7, 0.06, 6.6, PAL.steel);
  for (const z of [-2.2, 0.2, 2.6]) trailer.cyl(0, 3.5, z, 0.3, 0.32, 0.2, 8, PAL.steelLight);
  // ladder
  for (const side of [-1, 1]) trailer.beam(side * 0.25, 0.9, -4.5, side * 0.25, 3.4, -4.32, 0.05, PAL.steel);
  for (let n = 0; n < 5; n += 1) trailer.beam(-0.25, 1.2 + n * 0.5, -4.49 + n * 0.035, 0.25, 1.2 + n * 0.5, -4.49 + n * 0.035, 0.04, PAL.steel);
  // frame, saddles, running gear
  for (const side of [-1, 1]) {
    trailer.box(side * 0.6, 0.92, -0.6, 0.16, 0.2, 7.2, PAL.steel);
    for (const z of [-2.5, -3.6]) wheel(trailer, side * 1.0, 0.5, z, 0.5, 0.56);
    trailer.beam(side * 0.6, 0.85, 2.0, side * 0.6, 0.05, 2.0, 0.12, PAL.steel);
    trailer.box(side * 1.05, 0.78, -3.05, 0.5, 0.06, 2.4, PAL.char);
    // hazard placards
    trailer.box(side * 1.215, 2.2, 1.6, 0.03, 0.5, 0.5, [0.55, 0.2, 0.03], 0, Math.PI / 4);
  }
  for (const z of [-3.0, -1.0, 1.0, 3.0]) trailer.box(0, 1.08, z, 1.5, 0.2, 0.24, PAL.steel);
  trailer.box(0, 1.5, -4.47, 0.5, 0.5, 0.03, [0.55, 0.2, 0.03], 0, 0, Math.PI / 4);
  trailer.box(0, 0.6, -4.2, 2.3, 0.12, 0.12, PAL.steel);

  const tractor = new Soup();
  const cab = new Soup();
  truckCab(cab, PAL.red);
  tractor.stamp(cab, trs(0, 0, 1.3));
  for (const side of [-1, 1]) {
    tractor.box(side * 0.55, 0.78, -0.2, 0.14, 0.24, 3.4, PAL.steel);
    wheel(tractor, side * 1.0, 0.5, -0.9, 0.5, 0.56);
    tractor.cyl(side * 0.98, 0.75, 0.55, 0.28, 0.28, 0.8, 8, PAL.steelLight, 'z');
  }
  tractor.box(0, 1.0, -0.5, 1.1, 0.14, 1.2, PAL.char);
  tractor.cyl(0.9, 2.3, 1.2, 0.07, 0.07, 3.0, 6, PAL.steel);
  return [trailer, tractor];
}

// ------------------------------------------------------------------ containers

export function buildContainer(len: number, paint: Rgb, seed: number): Soup {
  const rng = createSeededRandom(seed);
  const s = new Soup();
  const W = 2.44;
  const H = 2.59;
  const from = s.vertexCount;
  const wall = (length: number, ribs: number, m: THREE.Matrix4) => {
    const start = s.vertexCount;
    const pitch = length / ribs;
    const d = 0.07;
    for (let n = 0; n < ribs; n += 1) {
      const x0 = -length / 2 + n * pitch;
      const xs = [x0, x0 + pitch * 0.36, x0 + pitch * 0.5, x0 + pitch * 0.86, x0 + pitch];
      const zs = [0, 0, -d, -d, 0];
      for (let k = 0; k < 4; k += 1) {
        s.quad([xs[k], 0.12, zs[k]], [xs[k + 1], 0.12, zs[k + 1]], [xs[k + 1], H - 0.12, zs[k + 1]], [xs[k], H - 0.12, zs[k]], [0, 0, 1, 1], paint);
      }
    }
    s.transform(start, m);
  };
  const side = new THREE.Matrix4();
  wall(len - 0.2, Math.round(len / 0.55), side.makeRotationY(Math.PI / 2).setPosition(W / 2 - 0.03, 0, 0));
  wall(len - 0.2, Math.round(len / 0.55), side.makeRotationY(-Math.PI / 2).setPosition(-W / 2 + 0.03, 0, 0));
  wall(W - 0.2, 5, side.makeRotationY(Math.PI).setPosition(0, 0, -len / 2 + 0.03));
  // roof
  s.quad([-W / 2, H - 0.03, len / 2], [W / 2, H - 0.03, len / 2], [W / 2, H - 0.03, -len / 2], [-W / 2, H - 0.03, -len / 2], [0, 0, 1, 1], mul(paint, 0.7));
  // doors
  for (const sx of [-1, 1]) {
    s.box(sx * 0.58, H / 2, len / 2 - 0.05, 1.1, H - 0.3, 0.05, mul(paint, 0.92));
    for (const rx of [0.25, 0.85]) s.beam(sx * rx, 0.14, len / 2, sx * rx, H - 0.14, len / 2, 0.045, PAL.galv);
    s.box(sx * 0.5, 1.15, len / 2 + 0.03, 0.34, 0.05, 0.03, PAL.galv);
  }
  // frame
  const frame = mul(paint, 0.72);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) s.box(sx * (W / 2 - 0.07), H / 2, sz * (len / 2 - 0.07), 0.16, H, 0.16, frame);
    s.box(sx * (W / 2 - 0.06), H - 0.07, 0, 0.13, 0.14, len - 0.3, frame);
    s.box(sx * (W / 2 - 0.06), 0.08, 0, 0.13, 0.16, len - 0.3, frame);
  }
  for (const sz of [-1, 1]) s.box(0, H - 0.07, sz * (len / 2 - 0.06), W - 0.3, 0.14, 0.13, frame);
  // stencil block
  for (const sx of [-1, 1]) s.box(sx * (W / 2 + 0.005), H * 0.66, len * 0.18, 0.02, 0.5, Math.min(2.4, len * 0.3), mix(paint, PAL.white, 0.7));
  scorch(s, from, 0.22 + rng() * 0.3);
  return s;
}

// ------------------------------------------------------------------ dead trees

export function buildTree(variant: number, seed: number): { wood: Soup; cards: Soup } {
  const rng = createSeededRandom(seed);
  const wood = new Soup();
  const cards = new Soup();
  const maxDepth = variant === 1 ? 1 : 2;
  const height = [10.5, 6.5, 8.5][variant];
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const ref = new THREE.Vector3();
  const swayAt = (y: number, depth: number) => Math.pow(Math.max(0, (y - 1.5) / height), 1.5) * 0.34 * (1 + depth * 0.45);

  const ring = (c: THREE.Vector3, d: THREE.Vector3, radius: number, sides: number, depth: number): number => {
    ref.set(Math.abs(d.x) < 0.9 ? 1 : 0, 0, Math.abs(d.x) < 0.9 ? 0 : 1);
    u.crossVectors(d, ref).normalize();
    v.crossVectors(d, u).normalize();
    const start = wood.vertexCount;
    const tone = 0.8 + rng() * 0.5 + Math.min(0.5, c.y / 20);
    const fx: Fx = [swayAt(c.y, depth), 0, 0];
    for (let n = 0; n < sides; n += 1) {
      const a = (n / sides) * Math.PI * 2;
      const nx = u.x * Math.cos(a) + v.x * Math.sin(a);
      const ny = u.y * Math.cos(a) + v.y * Math.sin(a);
      const nz = u.z * Math.cos(a) + v.z * Math.sin(a);
      wood.vertex(c.x + nx * radius, c.y + ny * radius, c.z + nz * radius, nx, ny, nz, PAL.bark[0] * tone, PAL.bark[1] * tone, PAL.bark[2] * tone, 1, 0, 0, fx);
    }
    return start;
  };
  const connect = (a: number, b: number, sides: number) => {
    for (let n = 0; n < sides; n += 1) {
      const m = (n + 1) % sides;
      wood.idx.push(a + n, b + n, b + m, a + n, b + m, a + m);
    }
  };
  const twigs = (tip: THREE.Vector3, d: THREE.Vector3, size: number) => {
    const sw0 = swayAt(tip.y, 2);
    const sw1 = sw0 + 0.12;
    for (let k = 0; k < 2; k += 1) {
      ref.set(rng() - 0.5, (rng() - 0.5) * 0.3, rng() - 0.5);
      u.crossVectors(d, ref);
      if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
      u.normalize().multiplyScalar(size * 0.5);
      const top = [tip.x + d.x * size, tip.y + d.y * size, tip.z + d.z * size];
      cards.quad(
        [tip.x - u.x, tip.y - u.y, tip.z - u.z], [tip.x + u.x, tip.y + u.y, tip.z + u.z],
        [top[0] + u.x, top[1] + u.y, top[2] + u.z], [top[0] - u.x, top[1] - u.y, top[2] - u.z],
        CARD.twig[Math.floor(rng() * 2)], [0.75, 0.72, 0.7], 1, [0, 1, 0], [sw0, sw0, sw1, sw1],
      );
    }
  };
  const branch = (start: THREE.Vector3, dir: THREE.Vector3, len: number, r0: number, depth: number) => {
    const segs = depth === 0 ? 4 : depth === 1 ? 3 : 2;
    const sides = depth === 0 ? 5 : depth === 1 ? 4 : 3;
    const cur = start.clone();
    const d = dir.clone();
    if (d.lengthSq() < 1e-6) d.set(0, 1, 0);
    d.normalize();
    let prev = ring(cur, d, r0, sides, depth);
    const bend = depth === 0 ? 0.16 : 0.42;
    for (let i = 1; i <= segs; i += 1) {
      const t = i / segs;
      d.x += (rng() - 0.5) * bend;
      d.z += (rng() - 0.5) * bend;
      d.y += depth > 0 ? 0.16 : 0.02;
      if (d.lengthSq() < 1e-6) d.set(0, 1, 0);
      d.normalize();
      cur.addScaledVector(d, len / segs);
      const tipTaper = depth === maxDepth ? 0.9 : 0.42;
      const radius = Math.max(0.018, r0 * (1 - t * tipTaper));
      const next = ring(cur, d, radius, sides, depth);
      connect(prev, next, sides);
      prev = next;
      if (depth < maxDepth && i >= (depth === 0 ? segs - 1 : 1)) {
        const kids = depth === 0 ? (i === segs ? 3 : 1 + (variant === 2 ? 1 : 0)) : 1 + (rng() < 0.4 ? 1 : 0);
        const baseAz = rng() * Math.PI * 2;
        for (let k = 0; k < kids; k += 1) {
          const az = baseAz + (k / kids) * Math.PI * 2 + (rng() - 0.5) * 0.7;
          const spread = depth === 0 ? (variant === 2 ? 1.05 : 0.62) + rng() * 0.3 : 0.6 + rng() * 0.5;
          const child = new THREE.Vector3(Math.cos(az) * Math.sin(spread), Math.cos(spread), Math.sin(az) * Math.sin(spread));
          // tilt the child cone toward the parent direction
          child.addScaledVector(d, 0.7).normalize();
          branch(cur, child, len * (0.55 + rng() * 0.25), radius * 0.62, depth + 1);
        }
      }
    }
    if (depth === maxDepth || (variant === 1 && depth === 1)) twigs(cur, d, 1.5 + rng() * 1.1);
    if (depth === 0 && variant === 1) {
      // splintered break
      for (let k = 0; k < 4; k += 1) {
        const a = rng() * 6.28;
        wood.beam(cur.x + Math.cos(a) * 0.08, cur.y - 0.1, cur.z + Math.sin(a) * 0.08, cur.x + Math.cos(a) * 0.2, cur.y + 0.4 + rng() * 0.7, cur.z + Math.sin(a) * 0.2, 0.07, mul(PAL.bark, 1.5), 3);
      }
    }
  };
  const lean = variant === 2 ? new THREE.Vector3(0.32, 1, 0.12) : new THREE.Vector3((rng() - 0.5) * 0.1, 1, (rng() - 0.5) * 0.1);
  branch(new THREE.Vector3(0, -0.15, 0), lean, [4.4, 5.2, 3.0][variant], [0.2, 0.25, 0.24][variant], 0);
  // root flare and broken paving collar
  wood.cyl(0, 0.12, 0, 0.24, 0.42, 0.3, 6, mul(PAL.bark, 0.9));
  for (let k = 0; k < 4; k += 1) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    wood.box(Math.cos(a) * 0.78, 0.04, Math.sin(a) * 0.78, 1.0, 0.1, 0.16, mul(PAL.concrete, 0.8), -a + Math.PI / 2, 0, (rng() - 0.5) * 0.2);
  }
  return { wood, cards };
}

// ------------------------------------------------------------------ street furniture

/**
 * Japanese horizontal traffic signal on a mast arm. Pole at the origin, arm
 * along +X, lamps facing +Z. variant 0 = dead, 1 = amber still blinking,
 * 2 = arm buckled with the head dangling from its cable.
 */
export function buildTrafficLight(variant: number): Soup {
  const s = new Soup();
  const metal = PAL.steel;
  s.cyl(0, 0.3, 0, 0.2, 0.26, 0.6, 6, metal);
  s.cyl(0, 3.6, 0, 0.1, 0.14, 6.6, 6, metal, 'y', true);
  const head = (x: number, y: number, z: number, rz: number, ry: number) => {
    const part = new Soup();
    part.box(0, 0, 0, 1.3, 0.44, 0.28, PAL.soot);
    part.box(0, 0.26, 0.18, 1.34, 0.03, 0.36, PAL.soot);
    const lamps: Rgb[] = [[0.04, 0.09, 0.07], PAL.amber, [0.11, 0.02, 0.015]];
    lamps.forEach((col, n) => {
      const lit = n === 1 && variant === 1;
      const disc = new THREE.CircleGeometry(0.15, 8);
      disc.translate(-0.42 + n * 0.42, 0, 0.145);
      part.geo(disc, null, lit ? col : n === 1 ? [0.12, 0.07, 0.015] : col, lit ? [0, 7, 1] : [0, 0, 0]);
    });
    s.stamp(part, trs(x, y, z, ry, 1, 0, rz));
  };
  if (variant === 2) {
    s.beam(0, 6.5, 0, 3.4, 6.55, 0, 0.13, metal);
    s.beam(3.4, 6.55, 0, 5.6, 5.3, 0.5, 0.12, metal);
    s.beam(5.6, 5.3, 0.5, 5.75, 4.1, 0.6, 0.025, PAL.char);
    head(5.8, 3.8, 0.62, 0.5, 0.5);
  } else {
    s.beam(0, 6.45, 0, 6.6, 6.75, 0, 0.13, metal);
    s.beam(0, 5.6, 0, 2.2, 6.5, 0, 0.06, metal);
    s.beam(5.6, 6.7, 0, 5.6, 6.35, 0.05, 0.05, metal);
    head(5.6, 6.2, 0.1, 0, 0);
    if (variant === 0) {
      s.beam(3.0, 6.6, 0, 3.0, 6.25, 0.05, 0.05, metal);
      head(3.0, 6.1, 0.1, 0.08, 0);
    }
  }
  // pedestrian signal on the pole
  s.box(0.24, 2.9, 0.05, 0.26, 0.6, 0.3, PAL.soot);
  s.box(0.38, 3.05, 0.05, 0.02, 0.2, 0.2, [0.1, 0.02, 0.015]);
  s.box(0.38, 2.78, 0.05, 0.02, 0.2, 0.2, [0.03, 0.08, 0.06]);
  // control cabinet
  s.box(-0.5, 0.75, 0.1, 0.5, 1.3, 0.4, PAL.galv);
  return s;
}

/** Overhead sign gantry spanning the road along X (posts at x = ±15). */
export function buildGantry(damaged: boolean, panels: readonly number[]): Kit {
  const kit = newKit();
  const s = kit.solid;
  const metal = PAL.galv;
  for (const side of [-1, 1]) {
    s.box(side * 15, 3.9, 0, 0.5, 7.8, 0.5, metal);
    s.box(side * 15, 0.15, 0, 1.2, 0.3, 1.2, PAL.concrete);
    s.beam(side * 15, 6.0, 0, side * 13.2, 7.4, 0, 0.14, metal);
  }
  const sag = damaged ? 0.5 : 0.08;
  const yAt = (x: number, base: number) => base - sag * (1 - (x / 15) * (x / 15));
  const steps = 10;
  for (let n = 0; n < steps; n += 1) {
    const x0 = -15 + (30 / steps) * n;
    const x1 = x0 + 30 / steps;
    for (const z of [-0.32, 0.32]) {
      s.beam(x0, yAt(x0, 7.2), z, x1, yAt(x1, 7.2), z, 0.13, metal);
      s.beam(x0, yAt(x0, 8.3), z, x1, yAt(x1, 8.3), z, 0.13, metal);
    }
    const up = n % 2 === 0;
    s.beam(x0, yAt(x0, up ? 7.2 : 8.3), 0.32, x1, yAt(x1, up ? 8.3 : 7.2), 0.32, 0.07, metal);
    s.beam(x0, yAt(x0, 7.2), -0.32, x0, yAt(x0, 7.2), 0.32, 0.07, metal);
  }
  // sign panels facing +Z
  const slots = [-6.6, 6.6];
  slots.forEach((px, n) => {
    const panel = panels[n];
    if (panel < 0) return;
    const hang = damaged && n === 1;
    const w = 9.6;
    const h = 3.0;
    const part = newKit();
    part.solid.box(0, 0, -0.06, w + 0.2, h + 0.2, 0.1, PAL.steel);
    part.signs.quad([-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0], SIGN.gantry[panel], [0.9, 0.9, 0.9]);
    const m = hang ? trs(px + 1.2, yAt(px, 7.75) - 2.6, 0.5, 0.12, 1, 0.1, -1.05) : trs(px, yAt(px, 7.75) + 0.2, 0.42, 0, 1, 0, (n - 0.5) * 0.03);
    s.stamp(part.solid, m);
    kit.signs.stamp(part.signs, m);
  });
  return kit;
}

/** Pole-mounted road sign; the plate faces +Z. kind: 0-7 small signs, 8-11 blades. */
export function buildRoadSign(kind: number): Kit {
  const kit = newKit();
  const s = kit.solid;
  s.cyl(0, 1.7, 0, 0.045, 0.05, 3.4, 5, PAL.galv, 'y', true);
  const face = (rect: Rect, w: number, h: number, y: number) => {
    kit.signs.quad([-w / 2, y - h / 2, 0.06], [w / 2, y - h / 2, 0.06], [w / 2, y + h / 2, 0.06], [-w / 2, y + h / 2, 0.06], rect, [0.95, 0.95, 0.95]);
    kit.signs.quad([w / 2, y - h / 2, 0.04], [-w / 2, y - h / 2, 0.04], [-w / 2, y + h / 2, 0.04], [w / 2, y + h / 2, 0.04], [rect[2], rect[1], rect[0], rect[3]], [0.1, 0.1, 0.1]);
  };
  if (kind < 8) {
    face(SIGN.small[kind], 0.95, 0.95, 2.85);
    if (kind === 2 || kind === 3) face(SIGN.blade[3], 0.9, 0.225, 2.2);
  } else {
    face(SIGN.blade[kind - 8], 1.5, 0.375, 3.1);
  }
  return kit;
}

/** Bus shelter 4.4 m long along X, open toward +Z. */
export function buildBusShelter(seed: number): Kit {
  const rng = createSeededRandom(seed);
  const kit = newKit();
  const s = kit.solid;
  const metal = PAL.steel;
  for (const x of [-2.1, 0, 2.1]) {
    s.beam(x, 0, -0.7, x, 2.5, -0.7, 0.09, metal);
    s.beam(x, 2.45, -0.7, x, 2.62, 0.85, 0.07, metal);
  }
  s.beam(-2.1, 0, 0.6, -2.1, 2.55, 0.6, 0.09, metal);
  s.box(0, 2.62, 0.05, 4.7, 0.09, 1.9, PAL.soot, 0, 0.06);
  s.box(0, 2.58, 0.98, 4.7, 0.2, 0.05, PAL.teal, 0, 0.06);
  for (const y of [0.35, 2.2]) s.beam(-2.1, y, -0.7, 2.1, y, -0.7, 0.06, metal);
  s.beam(-2.1, 0.35, -0.7, -2.1, 0.35, 0.6, 0.06, metal);
  s.beam(-2.1, 2.2, -0.7, -2.1, 2.2, 0.6, 0.06, metal);
  // bench
  s.box(0.4, 0.5, -0.35, 2.6, 0.07, 0.42, PAL.wood);
  for (const x of [-0.7, 1.5]) s.box(x, 0.24, -0.35, 0.07, 0.48, 0.36, metal);
  // dead ad lightbox
  s.box(2.1, 1.3, -0.1, 0.14, 1.9, 1.15, PAL.soot);
  s.box(2.18, 1.3, -0.1, 0.02, 1.7, 1.0, [0.16, 0.15, 0.12]);
  // glass remains
  const glassTint: Rgb = [0.75, 0.85, 0.85];
  for (const x0 of [-2.05, 0.05]) {
    if (rng() < 0.25) continue;
    kit.cards.quad([x0, 0.38, -0.7], [x0 + 2.0, 0.38, -0.7], [x0 + 2.0, 2.18, -0.7], [x0, 2.18, -0.7], CARD.glass, glassTint, 1, [0, 0.5, 0.86]);
  }
  kit.cards.quad([-2.1, 0.38, 0.58], [-2.1, 0.38, -0.68], [-2.1, 2.18, -0.68], [-2.1, 2.18, 0.58], CARD.glass, glassTint, 1, [0, 0.5, 0.86]);
  kit.cards.quad([2.19, 0.5, 0.38], [2.19, 0.5, -0.58], [2.19, 2.1, -0.58], [2.19, 2.1, 0.38], CARD.poster, [0.8, 0.78, 0.72], 1, [0.5, 0.6, 0.3]);
  // stop pole
  const pole = buildRoadSign(6);
  const m = trs(3.1, 0, 0.6, 0.2, 1, 0, 0.06);
  s.stamp(pole.solid, m);
  kit.signs.stamp(pole.signs, m);
  return kit;
}

export function buildSandbagWall(length: number, rows: number, seed: number): Soup {
  const rng = createSeededRandom(seed);
  const s = new Soup();
  const bagLen = 0.74;
  const perRow = Math.max(2, Math.round(length / bagLen));
  for (let r = 0; r < rows; r += 1) {
    const offset = r % 2 === 0 ? 0 : bagLen / 2;
    const count = perRow - (r % 2) - (r === rows - 1 && rng() < 0.6 ? 1 : 0);
    for (let n = 0; n < count; n += 1) {
      if (r === rows - 1 && rng() < 0.18) continue;
      const tone = 0.75 + rng() * 0.45;
      const g = new THREE.SphereGeometry(1, 5, 3);
      g.scale(bagLen * 0.56, 0.155, 0.24);
      g.rotateY((rng() - 0.5) * 0.3);
      g.translate(-length / 2 + bagLen / 2 + offset + n * bagLen, 0.13 + r * 0.235, (rng() - 0.5) * 0.08);
      s.geo(g, null, mul(PAL.sand, tone));
    }
  }
  return s;
}

export function buildDumpster(paint: Rgb, open: boolean): Soup {
  const s = new Soup();
  const shape = new THREE.Shape();
  const profile: [number, number][] = [[-0.5, 0.18], [0.5, 0.18], [0.62, 1.2], [-0.62, 1.32]];
  profile.forEach(([z, y], i) => (i === 0 ? shape.moveTo(z, y) : shape.lineTo(z, y)));
  shape.closePath();
  const body = new THREE.ExtrudeGeometry(shape, { depth: 1.9, bevelEnabled: false });
  body.rotateY(-Math.PI / 2);
  body.translate(0.95, 0, 0);
  s.geo(body, null, paint);
  s.box(0, 1.27, 0, 2.0, 0.07, 1.34, mul(paint, 0.7), 0, -0.1);
  if (open) s.box(0, 1.75, -0.68, 1.9, 0.05, 1.0, PAL.soot, 0, 1.25);
  else s.box(0, 1.33, 0, 1.92, 0.05, 1.28, PAL.soot, 0, -0.1);
  for (const sx of [-1, 1]) {
    s.box(sx * 0.99, 0.95, 0, 0.1, 0.16, 0.7, mul(paint, 0.6));
    for (const sz of [-1, 1]) s.box(sx * 0.75, 0.09, sz * 0.4, 0.08, 0.18, 0.16, PAL.rubber);
  }
  return s;
}

export function buildTyreStack(count: number, seed: number): Soup {
  const rng = createSeededRandom(seed);
  const s = new Soup();
  let x = 0;
  let z = 0;
  for (let n = 0; n < count; n += 1) {
    x += (rng() - 0.5) * 0.09;
    z += (rng() - 0.5) * 0.09;
    const y = 0.13 + n * 0.25;
    s.cyl(x, y, z, 0.42, 0.42, 0.25, 9, mul(PAL.rubber, 0.8 + rng() * 0.8), 'y', n < count - 1);
    if (n === count - 1) s.cyl(x, y + 0.126, z, 0.24, 0.24, 0.004, 8, [0.004, 0.004, 0.004]);
  }
  return s;
}

export function buildPallet(): Soup {
  const s = new Soup();
  for (const z of [-0.45, 0, 0.45]) s.box(0, 0.06, z, 1.2, 0.1, 0.1, PAL.woodDark);
  for (let n = 0; n < 5; n += 1) s.box(-0.5 + n * 0.25, 0.135, 0, 0.16, 0.035, 1.0, mul(PAL.wood, 0.8 + (n % 3) * 0.15));
  return s;
}

export function buildCrate(size: number, color: Rgb): Soup {
  const s = new Soup();
  s.box(0, size / 2, 0, size, size, size, color);
  for (const sx of [-1, 1]) {
    s.box(sx * (size / 2 - 0.04), size / 2, 0, 0.09, size + 0.03, size + 0.03, mul(color, 0.6));
  }
  s.box(0, size - 0.02, 0, size + 0.03, 0.05, 0.12, mul(color, 0.6));
  return s;
}

export function buildCableDrum(): Soup {
  const s = new Soup();
  for (const sx of [-1, 1]) s.cyl(sx * 0.42, 0.75, 0, 0.75, 0.75, 0.07, 12, PAL.wood, 'x');
  s.cyl(0, 0.75, 0, 0.36, 0.36, 0.8, 10, PAL.rubber, 'x', true);
  return s;
}

export function buildOilDrum(color: Rgb): Soup {
  const s = new Soup();
  s.cyl(0, 0.45, 0, 0.29, 0.29, 0.9, 9, color);
  for (const y of [0.3, 0.6]) s.cyl(0, y, 0, 0.3, 0.3, 0.03, 9, mul(color, 0.6), 'y', true);
  return s;
}

/** Rooftop condenser that fell to the street. */
export function buildAcUnit(): Soup {
  const s = new Soup();
  s.box(0, 0.5, 0, 1.3, 1.0, 0.75, PAL.galv);
  const fan = new THREE.CircleGeometry(0.36, 10);
  fan.translate(0, 0.52, 0.38);
  s.geo(fan, null, PAL.char);
  for (let n = 0; n < 5; n += 1) s.box(-0.56, 0.2 + n * 0.15, 0.378, 0.12, 0.05, 0.01, PAL.char);
  s.box(0.3, 1.02, 0, 0.5, 0.05, 0.6, PAL.soot);
  s.beam(0.66, 0.3, -0.2, 1.1, 0.05, -0.5, 0.05, [0.3, 0.16, 0.08]);
  return s;
}

export function buildRock(seed: number): Soup {
  const rng = createSeededRandom(seed);
  const source = new THREE.DodecahedronGeometry(1, 0);
  const g = source.toNonIndexed();
  source.dispose();
  const position = g.getAttribute('position') as THREE.BufferAttribute;
  const cache = new Map<string, [number, number, number]>();
  for (let i = 0; i < position.count; i += 1) {
    const key = `${position.getX(i).toFixed(2)},${position.getY(i).toFixed(2)},${position.getZ(i).toFixed(2)}`;
    let j = cache.get(key);
    if (!j) {
      j = [(rng() - 0.5) * 0.5, (rng() - 0.5) * 0.3, (rng() - 0.5) * 0.5];
      cache.set(key, j);
    }
    position.setXYZ(i, position.getX(i) + j[0], position.getY(i) * 0.6 + j[1], position.getZ(i) + j[2]);
  }
  g.computeVertexNormals();
  return new Soup().geo(g, null, [0.27, 0.255, 0.235]);
}

/** A-frame barricade with a striped board and an amber beacon. */
export function buildBarricade(beacon: boolean): Soup {
  const s = new Soup();
  for (const sx of [-1, 1]) {
    s.beam(sx * 0.9, 0, -0.32, sx * 0.9, 1.05, 0, 0.06, PAL.galv);
    s.beam(sx * 0.9, 0, 0.32, sx * 0.9, 1.05, 0, 0.06, PAL.galv);
  }
  for (const y of [0.85, 0.45]) {
    for (let n = 0; n < 6; n += 1) {
      s.box(-0.86 + n * 0.345, y, 0, 0.345, 0.2, 0.035, n % 2 === 0 ? [0.5, 0.3, 0.04] : PAL.char);
    }
  }
  if (beacon) {
    s.box(0.9, 1.12, 0, 0.14, 0.12, 0.14, PAL.char);
    s.cyl(0.9, 1.27, 0, 0.075, 0.085, 0.18, 6, PAL.amber, 'y', false, [0, 6, 2]);
  }
  return s;
}

export function buildGuardBooth(): Soup {
  const s = new Soup();
  s.box(0, 1.2, 0, 1.8, 2.4, 1.8, PAL.cream);
  s.box(0, 2.48, 0, 2.3, 0.14, 2.3, PAL.soot);
  s.box(0, 1.65, 0.91, 1.3, 0.7, 0.03, PAL.glass);
  for (const sx of [-1, 1]) s.box(sx * 0.91, 1.65, 0, 0.03, 0.7, 1.3, PAL.glass);
  s.box(0, 0.5, 0.92, 1.8, 0.3, 0.03, PAL.red);
  // boom gate stub
  s.box(1.2, 0.55, 0.6, 0.3, 1.1, 0.3, PAL.galv);
  for (let n = 0; n < 4; n += 1) s.box(1.25 + Math.cos(0.9) * (0.4 + n * 0.8), 1.0 + Math.sin(0.9) * (0.4 + n * 0.8), 0.6, 0.8, 0.1, 0.06, n % 2 === 0 ? PAL.white : PAL.red, 0, 0, 0.9);
  return s;
}

/** Raider camp fire: stone ring, charred logs (the flames are sprites). */
export function buildCampfire(seed: number): Soup {
  const rng = createSeededRandom(seed);
  const s = new Soup();
  for (let n = 0; n < 8; n += 1) {
    const a = (n / 8) * Math.PI * 2;
    s.box(Math.cos(a) * 0.8, 0.12, Math.sin(a) * 0.8, 0.42 + rng() * 0.15, 0.24 + rng() * 0.12, 0.3, mul(PAL.concrete, 0.6 + rng() * 0.4), -a + rng(), 0, (rng() - 0.5) * 0.4);
  }
  for (let n = 0; n < 4; n += 1) {
    const a = (n / 4) * Math.PI + rng();
    s.beam(Math.cos(a) * 0.6, 0.1, Math.sin(a) * 0.6, -Math.cos(a) * 0.3, 0.5, -Math.sin(a) * 0.3, 0.14, PAL.char, 5);
  }
  // ember bed
  s.cyl(0, 0.07, 0, 0.5, 0.55, 0.08, 8, [1.0, 0.3, 0.05], 'y', false, [0, 2.2, 3]);
  return s;
}

/** Rusted scrap-sheet barricade with spikes, 3.4 m wide, facing +Z. */
export function buildScrapWall(seed: number): Kit {
  const rng = createSeededRandom(seed);
  const kit = newKit();
  const s = kit.solid;
  let x = -1.7;
  while (x < 1.5) {
    const w = 0.8 + rng() * 0.6;
    const h = 1.5 + rng() * 0.9;
    const col = mix(PAL.rust, rng() < 0.3 ? PAL.teal : PAL.rustLight, rng() * 0.6);
    s.box(x + w / 2, h / 2, (rng() - 0.5) * 0.1, w, h, 0.05, col, (rng() - 0.5) * 0.12, (rng() - 0.5) * 0.14, (rng() - 0.5) * 0.08);
    if (rng() < 0.7) {
      const sx = x + w * (0.3 + rng() * 0.4);
      s.beam(sx, h - 0.2, 0, sx + (rng() - 0.5) * 0.3, h + 0.7 + rng() * 0.5, 0.25, 0.07, PAL.steel, 3);
    }
    x += w - 0.08;
  }
  for (const px of [-1.5, 0, 1.5]) s.beam(px, 0, -0.1, px, 1.6, -0.6, 0.09, PAL.steel);
  s.beam(-1.7, 1.0, -0.06, 1.7, 1.1, -0.06, 0.08, PAL.steel);
  // painted fang
  kit.cards.quad([-0.6, 0.5, 0.06], [0.6, 0.5, 0.06], [0.6, 1.7, 0.06], [-0.6, 1.7, 0.06], [CARD.banner[0] + 0.03, CARD.banner[1] + 0.12, CARD.banner[2] - 0.03, CARD.banner[3] - 0.02], [1, 1, 1], 1, [0, 0.4, 0.9]);
  return kit;
}

/** Tarp lean-to on poles, ridge along X. */
export function buildLeanTo(tint: Rgb): Kit {
  const kit = newKit();
  const s = kit.solid;
  for (const sx of [-1, 1]) {
    s.beam(sx * 1.7, 0, 0.9, sx * 1.7, 2.2, 0.9, 0.07, PAL.woodDark);
    s.beam(sx * 1.7, 0, -1.2, sx * 1.7, 0.9, -1.2, 0.07, PAL.woodDark);
  }
  s.beam(-1.8, 2.2, 0.9, 1.8, 2.2, 0.9, 0.06, PAL.woodDark);
  kit.cards.quad([-1.9, 2.24, 1.0], [1.9, 2.24, 1.0], [1.9, 0.72, -1.5], [-1.9, 0.72, -1.5], [CARD.tarp[0][2], CARD.tarp[0][3], CARD.tarp[0][0], CARD.tarp[0][1]], tint, 1, [0, 0.9, 0.4], [0, 0, 0.05, 0.05]);
  // bedroll and crate inside
  s.box(0.5, 0.1, -0.2, 0.7, 0.16, 1.8, [0.16, 0.14, 0.1]);
  return kit;
}

/**
 * Tube-and-clamp scaffold against a wall at z = 0, extending toward +Z.
 * Runs along X centred on the origin.
 */
export function buildScaffold(length: number, levels: number, seed: number, tarpTint: Rgb): Kit {
  const rng = createSeededRandom(seed);
  const kit = newKit();
  const s = kit.solid;
  const bay = 2.4;
  const bays = Math.max(2, Math.round(length / bay));
  const lift = 2.0;
  const depth = 1.3;
  const tube = PAL.galv;
  const x0 = -(bays * bay) / 2;
  const topOf: number[] = [];
  for (let b = 0; b <= bays; b += 1) {
    // ragged top: some standards stop a lift early
    const top = levels - (rng() < 0.3 ? 1 : 0);
    topOf.push(top);
    const x = x0 + b * bay;
    for (const z of [0.25, 0.25 + depth]) {
      s.beam(x, 0, z, x + (rng() - 0.5) * 0.06, top * lift + 0.9, z, 0.06, tube);
    }
    s.box(x, 0.03, 0.25 + depth, 0.22, 0.05, 0.22, PAL.wood);
  }
  for (let l = 1; l <= levels; l += 1) {
    const y = l * lift;
    for (let b = 0; b < bays; b += 1) {
      if (Math.min(topOf[b], topOf[b + 1]) < l) continue;
      const xa = x0 + b * bay;
      const xb = xa + bay;
      s.beam(xa, y, 0.25 + depth, xb, y, 0.25 + depth, 0.05, tube);
      s.beam(xa, y + 1.0, 0.25 + depth, xb, y + 1.0, 0.25 + depth, 0.04, tube);
      s.beam(xa, y, 0.25, xa, y, 0.25 + depth, 0.05, tube);
      const missing = rng() < 0.18;
      if (!missing) {
        const droop = rng() < 0.12 ? -0.5 : 0;
        s.box(xa + bay / 2, y + 0.05 + droop * 0.5, 0.25 + depth / 2, bay - 0.05, 0.05, depth - 0.1, mul(PAL.wood, 0.75 + rng() * 0.4), 0, 0, droop * 0.4);
      }
      if ((b + l) % 3 === 0) s.beam(xa, y - lift, 0.25 + depth, xb, y, 0.25 + depth, 0.04, tube);
      // torn sheeting
      if (rng() < 0.4) {
        const rect = CARD.tarp[rng() < 0.5 ? 0 : 1];
        const zf = 0.25 + depth + 0.05;
        const drop = lift * (0.8 + rng() * 0.2);
        const tone = 0.7 + rng() * 0.4;
        kit.cards.quad(
          [xa + 0.05, y + 1.0 - drop, zf + 0.12], [xb - 0.05, y + 1.0 - drop, zf + 0.12], [xb - 0.05, y + 1.0, zf], [xa + 0.05, y + 1.0, zf],
          [rect[0], rect[1], rect[2], rect[3]], mul(tarpTint, tone), 1, [0, 0.35, 0.94], [0.28, 0.28, 0, 0],
        );
      }
    }
  }
  // ladder
  s.beam(x0 + 0.4, 0, 0.25 + depth + 0.5, x0 + 0.4, lift + 0.6, 0.25 + depth, 0.04, tube);
  s.beam(x0 + 0.8, 0, 0.25 + depth + 0.5, x0 + 0.8, lift + 0.6, 0.25 + depth, 0.04, tube);
  // fallen tubes and planks at the foot
  for (let n = 0; n < 3; n += 1) {
    const fx = x0 + rng() * bays * bay;
    s.beam(fx, 0.05, 2.0 + rng(), fx + 2.2 + rng() * 1.5, 0.05 + rng() * 0.3, 2.2 + rng() * 1.2, 0.06, tube);
  }
  return kit;
}
