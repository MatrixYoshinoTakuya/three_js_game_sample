import * as THREE from 'three';
import type { SetDressing } from '../game/contracts';
import { createSeededRandom } from '../utils/random';
import { CITY, CITY_HALF, type Aabb, type CityLayout, roadCenter } from './CityLayout';
import {
  createCardMaterial, createCrowMaterial, createDecalMaterial, createDressUniforms, createFxMaterial,
  createNeonMaterial, createPaperMaterial, createPropMaterial, createSignMaterial,
} from './dressing/materials';
import {
  PAL, type Kit, buildAcUnit, buildArticulatedBus, buildBarricade, buildBoxTruck, buildBus, buildBusShelter,
  buildCableDrum, buildCampfire, buildChip, buildContainer, buildCrate, buildDumpster, buildGantry, buildGuardBooth,
  buildLeanTo, buildOilDrum, buildPallet, buildRoadSign, buildRock, buildSandbagWall, buildScaffold,
  buildScrapWall, buildTanker, buildTrafficLight, buildTree, buildTyreStack,
} from './dressing/props';
import { Chunked, Soup, trs, type Rgb } from './dressing/soup';
import { CARD, DECAL, SIGN, createCardAtlas, createDecalAtlas, createNoiseTexture, createSignAtlas, decalRect } from './dressing/textures';

/**
 * Set dressing for the ruined city: street furniture and story props, dead
 * vegetation, shader-driven atmospherics, surviving neon and ground decals.
 * Everything static is merged into a few world-space meshes (one shadow
 * caster, quadrant-chunked non-casters) so the whole layer costs ~20 draw
 * calls; update() only writes one uniform.
 */

const HALF_ROAD = CITY.roadWidth / 2;
const N = CITY.blocksPerSide;
const CURB = CITY.curbHeight;
const WHITE: Rgb = [1, 1, 1];

type Seg = { axis: 0 | 1; k: number; c: number; from: number; to: number };
type Face = { x: number; z: number; nx: number; nz: number; len: number; h: number; setback: number; used: boolean };
type Disc = { x: number; z: number; r: number };

function nearestRoad(v: number): number {
  return Math.max(-CITY_HALF, Math.min(CITY_HALF, Math.round(v / CITY.pitch) * CITY.pitch));
}

/** Visual ground level: kerb-top inside a block, asphalt everywhere else. */
function surfaceY(x: number, z: number): number {
  if (Math.abs(x) > CITY_HALF + HALF_ROAD || Math.abs(z) > CITY_HALF + HALF_ROAD) return 0;
  return Math.abs(x - nearestRoad(x)) > HALF_ROAD && Math.abs(z - nearestRoad(z)) > HALF_ROAD ? CURB : 0;
}

/** Soft-sprite batch: plumes, steam, dust, flames and glow halos in one mesh. */
class FxBatch {
  private readonly position: number[] = [];
  private readonly corner: number[] = [];
  private readonly size: number[] = [];
  private readonly anim: number[] = [];
  private readonly tint: number[] = [];
  private readonly drift: number[] = [];
  private readonly index: number[] = [];

  /** kind 0 smoke (extra = noise scale), 1 flame, 2 glow (extra < 0 blink mode, > 0 power threshold; speed = flicker). */
  add(
    kind: number, x: number, y: number, z: number, w0: number, w1: number, h: number, lean: number,
    speed: number, phase: number, extra: number, color: Rgb, alpha: number,
    dx = 0, dy = 0, dz = 0, vSegs = 1,
  ): void {
    const base = this.position.length / 3;
    for (let row = 0; row <= vSegs; row += 1) {
      for (const cx of [-1, 1]) {
        this.position.push(x, y, z);
        this.corner.push(cx, row / vSegs);
        this.size.push(w0, w1, h, lean);
        this.anim.push(kind, speed, phase, extra);
        this.tint.push(color[0], color[1], color[2], alpha);
        this.drift.push(dx, dy, dz);
      }
    }
    for (let row = 0; row < vSegs; row += 1) {
      const a = base + row * 2;
      this.index.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  get triangleCount(): number {
    return this.index.length / 3;
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array(this.corner), 2));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(this.size), 4));
    g.setAttribute('aAnim', new THREE.BufferAttribute(new Float32Array(this.anim), 4));
    g.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(this.tint), 4));
    g.setAttribute('aDrift', new THREE.BufferAttribute(new Float32Array(this.drift), 3));
    g.setIndex(this.index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000);
    return g;
  }
}

export function buildSetDressing(layout: CityLayout, lowSpec: boolean): SetDressing {
  const group = new THREE.Group();
  group.name = 'setDressing';
  const disposables: { dispose(): void }[] = [];
  const uniforms = createDressUniforms();
  const windX = uniforms.uWind.value.x;
  const windZ = uniforms.uWind.value.y;

  // textures first: they also fill the atlas rect tables used during placement
  const signAtlas = createSignAtlas();
  const decalAtlas = createDecalAtlas();
  const cardAtlas = createCardAtlas();
  const noise = createNoiseTexture();
  disposables.push(signAtlas, decalAtlas, cardAtlas, noise);

  // merged output layers
  const heavy = new Soup();
  const light = new Chunked();
  const cards = new Chunked();
  const decals = new Chunked();
  const signs = new Soup();
  const neon = new Soup();
  const fx = new FxBatch();
  const fxNear = new FxBatch();
  const colliders: Aabb[] = [];

  // ------------------------------------------------------------------ occupancy
  const blockers: Aabb[] = layout.colliders.slice();
  const soft: Disc[] = [];
  for (const lamp of layout.lamps) soft.push({ x: lamp.x, z: lamp.z, r: lamp.scale > 0 ? 4.5 : 0.7 });
  for (const rock of layout.rubble) if (rock.scale >= 0.9) soft.push({ x: rock.x, z: rock.z, r: rock.scale * 0.85 });
  for (const barrel of layout.barrels) soft.push({ x: barrel.x, z: barrel.z, r: 1.2 });

  const start = layout.start;
  const relay = layout.relay;
  const reserved = (x: number, z: number, pad = 0): boolean =>
    (Math.abs(x - start.x) < 8 + pad && z > start.z - 20 - pad && z < start.z + 150 + pad) ||
    Math.hypot(x - relay.x, z - relay.z) < 45 + pad;

  const boxHit = (minX: number, maxX: number, minZ: number, maxZ: number, margin: number): boolean => {
    for (let i = 0; i < blockers.length; i += 1) {
      const b = blockers[i];
      if (b.minX < maxX + margin && b.maxX > minX - margin && b.minZ < maxZ + margin && b.maxZ > minZ - margin) return true;
    }
    return false;
  };
  const free = (x: number, z: number, r: number): boolean => !boxHit(x - r, x + r, z - r, z + r, 0);
  const softClear = (x: number, z: number, r: number): boolean => {
    for (let i = 0; i < soft.length; i += 1) {
      const s = soft[i];
      const dx = s.x - x;
      const dz = s.z - z;
      const rr = s.r + r;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  };

  // leaning / toppled towers: nothing tall may stand in their footprint
  const tallZones: Aabb[] = [];
  {
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    for (const f of layout.facades) {
      if (!f.rotX && !f.rotZ) continue;
      trs(f.x, f.y, f.z, f.rotY ?? 0, 1, f.rotX ?? 0, f.rotZ ?? 0, m);
      const zone = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      for (let c = 0; c < 8; c += 1) {
        v.set((c & 1 ? 0.5 : -0.5) * f.sx, (c & 2 ? 0.5 : -0.5) * f.sy, (c & 4 ? 0.5 : -0.5) * f.sz).applyMatrix4(m);
        zone.minX = Math.min(zone.minX, v.x - 4);
        zone.maxX = Math.max(zone.maxX, v.x + 4);
        zone.minZ = Math.min(zone.minZ, v.z - 4);
        zone.maxZ = Math.max(zone.maxZ, v.z + 4);
      }
      tallZones.push(zone);
    }
  }
  const highwayX = roadCenter(5);
  const tallBlocked = (x: number, z: number): boolean => {
    if (Math.abs(x - highwayX) < 11) return true;
    for (const zone of tallZones) if (x > zone.minX && x < zone.maxX && z > zone.minZ && z < zone.maxZ) return true;
    return false;
  };

  // ------------------------------------------------------------------ road graph helpers
  const segs: Seg[] = [];
  for (let axis = 0; axis < 2; axis += 1) {
    for (let k = 0; k <= N; k += 1) {
      for (let b = 0; b < N; b += 1) {
        segs.push({ axis: axis as 0 | 1, k, c: roadCenter(k), from: roadCenter(b) + HALF_ROAD, to: roadCenter(b + 1) - HALF_ROAD });
      }
    }
  }
  const isHighway = (seg: Seg): boolean => seg.axis === 0 && seg.k === 5;
  const px = (seg: Seg, lat: number, t: number): number => (seg.axis === 0 ? seg.c + lat : t);
  const pz = (seg: Seg, lat: number, t: number): number => (seg.axis === 0 ? t : seg.c + lat);
  /** Yaw so +Z points along (lateral, along) in road space. */
  const yawOf = (seg: Seg, lat: number, along: number): number => (seg.axis === 0 ? Math.atan2(lat, along) : Math.atan2(along, lat));
  const shuffled = <T>(list: T[], rng: () => number): T[] => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  /** A road obstacle must leave the centre lanes, the intersections and >= 11 m of carriageway free. */
  const carriagewayOk = (box: Aabb): boolean => {
    const cx = nearestRoad((box.minX + box.maxX) / 2);
    const cz = nearestRoad((box.minZ + box.maxZ) / 2);
    const inX = box.maxX > cx - HALF_ROAD && box.minX < cx + HALF_ROAD;
    const inZ = box.maxZ > cz - HALF_ROAD && box.minZ < cz + HALF_ROAD;
    if (!inX && !inZ) return true;
    if (inX && inZ) return false;
    const c = inX ? cx : cz;
    if (inX && c === highwayX) return false;
    const lo = (inX ? box.minX : box.minZ) - c;
    const hi = (inX ? box.maxX : box.maxZ) - c;
    if (lo < 6.2 && hi > -6.2) return false;
    const a0 = (inX ? box.minZ : box.minX) - 8;
    const a1 = (inX ? box.maxZ : box.maxX) + 8;
    const spans: [number, number][] = [[Math.max(-HALF_ROAD, lo), Math.min(HALF_ROAD, hi)]];
    for (const b of blockers) {
      const bA0 = inX ? b.minZ : b.minX;
      const bA1 = inX ? b.maxZ : b.maxX;
      if (bA1 < a0 || bA0 > a1) continue;
      const l0 = (inX ? b.minX : b.minZ) - c;
      const l1 = (inX ? b.maxX : b.maxZ) - c;
      if (l1 < -HALF_ROAD || l0 > HALF_ROAD) continue;
      spans.push([Math.max(-HALF_ROAD, l0), Math.min(HALF_ROAD, l1)]);
    }
    spans.sort((p, q) => p[0] - q[0]);
    let cursor = -HALF_ROAD;
    let best = 0;
    for (const [l0, l1] of spans) {
      best = Math.max(best, l0 - cursor);
      cursor = Math.max(cursor, l1);
    }
    best = Math.max(best, HALF_ROAD - cursor);
    return best >= 11;
  };

  const footprint = (cx: number, cz: number, yaw: number, halfLen: number, halfWid: number): Aabb => {
    const s = Math.abs(Math.sin(yaw));
    const c = Math.abs(Math.cos(yaw));
    const ex = s * halfLen + c * halfWid;
    const ez = c * halfLen + s * halfWid;
    return { minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez };
  };
  const boxesOk = (boxes: Aabb[], margin = 0.7): boolean => {
    for (const b of boxes) {
      if (reserved(b.minX, b.minZ, 3) || reserved(b.maxX, b.maxZ, 3) || reserved(b.minX, b.maxZ, 3) || reserved(b.maxX, b.minZ, 3)) return false;
      if (boxHit(b.minX, b.maxX, b.minZ, b.maxZ, margin)) return false;
      if (!carriagewayOk(b)) return false;
    }
    return true;
  };
  const commit = (boxes: Aabb[]): void => {
    for (const b of boxes) {
      colliders.push(b);
      blockers.push(b);
      soft.push({ x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, r: Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.5 });
    }
  };

  // ------------------------------------------------------------------ output helpers
  const anchorSoup = (x: number, z: number): Soup => (lowSpec ? light.at(x, z) : heavy);
  const tmp = new THREE.Vector3();

  /** Ground decal; refuses to straddle a kerb. Local +Z of the cell maps to the image bottom. */
  const decal = (cell: number, x: number, z: number, w: number, d: number, yaw: number, alpha: number, tint: Rgb = WHITE): boolean => {
    const y = surfaceY(x, z);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const pts: number[][] = [];
    for (const [lx, lz] of [[-w / 2, d / 2], [w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]]) {
      const wx = x + lx * c + lz * s;
      const wz = z - lx * s + lz * c;
      if (surfaceY(wx, wz) !== y) return false;
      pts.push([wx, y + 0.03, wz]);
    }
    decals.at(x, z).quad(pts[0], pts[1], pts[2], pts[3], decalRect(cell), tint, alpha, [0, 1, 0]);
    return true;
  };
  /** Soft contact shadow for props that do not cast real shadows. */
  const blob = (x: number, z: number, r: number, alpha = 0.7): void => {
    decal(DECAL.shadow, x, z, r * 2, r * 2, 0, alpha, [0, 0, 0]);
  };
  const putLight = (tpl: Soup, x: number, z: number, yaw: number, scale = 1, tint: Rgb | null = null, rotX = 0, rotZ = 0, yOff = 0, phase = 0): void => {
    light.at(x, z).stamp(tpl, trs(x, surfaceY(x, z) + yOff, z, yaw, scale, rotX, rotZ), tint, phase);
  };
  const putKit = (kit: Kit, m: THREE.Matrix4, x: number, z: number, anchor: boolean, tint: Rgb | null = null, phase = 0): void => {
    (anchor ? anchorSoup(x, z) : light.at(x, z)).stamp(kit.solid, m, tint, phase);
    if (kit.cards.vertexCount > 0) cards.at(x, z).stamp(kit.cards, m);
    if (kit.signs.vertexCount > 0) signs.stamp(kit.signs, m);
  };
  const glow = (x: number, y: number, z: number, size: number, color: Rgb, intensity: number, mode: number, phase: number, flicker = 0): void => {
    fx.add(2, x, y, z, size, size, size, 0, flicker, phase, mode, color, intensity);
  };

  /** Where each landmark family ended up: [x, z, x, z, ...] (handy for cameras, tests and the minimap). */
  const landmarks: Record<string, number[]> = {};
  const mark = (name: string, x: number, z: number): void => {
    (landmarks[name] ??= []).push(Math.round(x * 10) / 10, Math.round(z * 10) / 10);
  };
  const families: Record<string, number> = {};
  let tallied = 0;
  const tally = (name: string): void => {
    const total = heavy.triangleCount * 2 + light.triangleCount + cards.triangleCount + decals.triangleCount + signs.triangleCount + neon.triangleCount + fx.triangleCount + fxNear.triangleCount;
    families[name] = (families[name] ?? 0) + total - tallied;
    tallied = total;
  };

  // ------------------------------------------------------------------ shared templates
  const rocks = [buildRock(61), buildRock(62), buildRock(63)];
  const chips = [buildChip(64), buildChip(65), buildChip(66)];
  const tyreStacks = [buildTyreStack(3, 71), buildTyreStack(4, 72), buildTyreStack(5, 73), buildTyreStack(1, 74)];
  const pallet = buildPallet();
  const crates = [buildCrate(0.9, PAL.wood), buildCrate(0.65, PAL.woodDark), buildCrate(1.1, [0.2, 0.22, 0.16])];
  const cableDrum = buildCableDrum();
  const oilDrums = [buildOilDrum(PAL.rust), buildOilDrum(PAL.blue), buildOilDrum([0.4, 0.3, 0.05])];
  const acUnit = buildAcUnit();
  const dumpsters = [buildDumpster(PAL.green, false), buildDumpster(PAL.blue, true), buildDumpster([0.2, 0.12, 0.08], true)];
  const barricades = [buildBarricade(true), buildBarricade(false)];
  const beacon = new Soup();
  beacon.box(0, 0.06, 0, 0.16, 0.12, 0.16, PAL.char);
  beacon.cyl(0, 0.21, 0, 0.075, 0.085, 0.18, 6, PAL.amber, 'y', false, [0, 6, 2]);

  /** A small pile of junk props around a point: the "someone left in a hurry" cluster. */
  const junkCluster = (rng: () => number, x: number, z: number, radius: number, count: number): void => {
    for (let n = 0; n < count; n += 1) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * radius;
      const jx = x + Math.cos(a) * r;
      const jz = z + Math.sin(a) * r;
      if (!free(jx, jz, 0.9) || reserved(jx, jz, 1) || !softClear(jx, jz, 0.7)) continue;
      if (Math.abs(jx - nearestRoad(jx)) < 6.5 || Math.abs(jz - nearestRoad(jz)) < 6.5) continue;
      const pick = rng();
      const yaw = rng() * Math.PI * 2;
      if (pick < 0.22) {
        putLight(tyreStacks[Math.floor(rng() * 4)], jx, jz, yaw);
        blob(jx, jz, 0.75);
      } else if (pick < 0.42) {
        const stack = 1 + Math.floor(rng() * 4);
        for (let k = 0; k < stack; k += 1) putLight(pallet, jx, jz, yaw + (rng() - 0.5) * 0.3, 1, null, 0, 0, k * 0.155);
        blob(jx, jz, 1.0);
      } else if (pick < 0.66) {
        const crate = crates[Math.floor(rng() * 3)];
        putLight(crate, jx, jz, yaw, 1, [0.7 + rng() * 0.5, 0.7 + rng() * 0.4, 0.7 + rng() * 0.4]);
        if (rng() < 0.4) putLight(crates[1], jx + 0.1, jz - 0.05, yaw + 0.5, 1, null, 0, 0, crate === crates[2] ? 1.1 : crate === crates[0] ? 0.9 : 0.65);
        blob(jx, jz, 0.9);
      } else if (pick < 0.84) {
        const tipped = rng() < 0.3;
        putLight(oilDrums[Math.floor(rng() * 3)], jx, jz, yaw, 1, null, tipped ? Math.PI / 2 : 0, 0, tipped ? 0.29 : 0);
        blob(jx, jz, 0.6);
      } else if (pick < 0.92) {
        putLight(cableDrum, jx, jz, yaw, 0.8 + rng() * 0.3);
        blob(jx, jz, 1.0);
      } else {
        putLight(rocks[Math.floor(rng() * 3)], jx, jz, yaw, 0.35 + rng() * 0.4, null, rng(), rng(), 0.1);
      }
      soft.push({ x: jx, z: jz, r: 0.8 });
    }
  };

  // ------------------------------------------------------------------ building faces that look onto a street
  const faces: Face[] = [];
  for (const f of layout.facades) {
    if (f.rotX || f.rotY || f.rotZ) continue;
    if (Math.abs(f.y - f.sy / 2 - CURB) > 0.02) continue;
    const sides: [number, number, number, number, number][] = [
      [f.x + f.sx / 2, f.z, 1, 0, f.sz], [f.x - f.sx / 2, f.z, -1, 0, f.sz],
      [f.x, f.z + f.sz / 2, 0, 1, f.sx], [f.x, f.z - f.sz / 2, 0, -1, f.sx],
    ];
    for (const [fx0, fz0, nx, nz, len] of sides) {
      let setback = -1;
      for (let d = 1.5; d <= 15; d += 1.5) {
        const qx = fx0 + nx * d;
        const qz = fz0 + nz * d;
        if (!free(qx, qz, 1.2)) break;
        if (surfaceY(qx, qz) === 0) {
          setback = d;
          break;
        }
      }
      if (setback > 0 && len > 9) faces.push({ x: fx0, z: fz0, nx, nz, len, h: f.sy, setback, used: false });
    }
  }
  // best guess at the drive from the start to the relay (start avenue, under the fallen tower, relay plaza):
  // live neon, street trees and bunting are biased toward it
  const leanTower = layout.facades.find((f) => f.rotZ);
  const heroX = nearestRoad(leanTower ? leanTower.x : 0);
  const crossZ = nearestRoad(start.z + 140);
  const relayRoadZ = nearestRoad(relay.z - 55);
  const routePts: [number, number][] = [
    [nearestRoad(start.x), start.z], [nearestRoad(start.x), crossZ], [heroX, crossZ], [heroX, relayRoadZ], [nearestRoad(relay.x - 55), relayRoadZ], [relay.x, relay.z],
  ];
  const onRoute = (x: number, z: number): boolean => {
    if (Math.hypot(x - relay.x, z - relay.z) < 140) return true;
    for (let i = 0; i + 1 < routePts.length; i += 1) {
      const [ax, az] = routePts[i];
      const [bx, bz] = routePts[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / Math.max(1e-6, dx * dx + dz * dz)));
      if (Math.hypot(x - ax - dx * t, z - az - dz * t) < 70) return true;
    }
    return false;
  };

  // ------------------------------------------------------------------ 1a. landmark vehicles (colliders: identical on every spec)
  {
    const rng = createSeededRandom(101);
    const [articFront, articRear] = buildArticulatedBus(11);
    const bus = buildBus(12);
    const boxTruck = buildBoxTruck(13);
    const [tankTrailer, tankTractor] = buildTanker();
    const order = shuffled(segs.filter((s) => !isHighway(s) && s.k > 0 && s.k < N), rng);
    const wishlist = ['artic', 'tanker', 'truck', 'bus', 'artic', 'truck', 'tanker', 'bus', 'truck', 'artic', 'truckTipped', 'bus', 'tanker', 'truck', 'bus'];
    let cursor = 0;
    const m = new THREE.Matrix4();
    const tints: Rgb[] = [[1, 1, 1], [0.8, 0.9, 1.05], [1.05, 0.85, 0.7], [0.75, 0.75, 0.75]];
    for (const kind of wishlist) {
      let placed = false;
      for (let attempt = 0; attempt < 40 && !placed; attempt += 1) {
        const seg = order[cursor % order.length];
        cursor += 1;
        const side = rng() < 0.5 ? 1 : -1;
        const fwd = rng() < 0.5 ? 1 : -1;
        const t = seg.from + 14 + rng() * (seg.to - seg.from - 28);
        const tint = tints[Math.floor(rng() * tints.length)];
        if (kind === 'artic') {
          const lat = side * 9.3;
          const a1 = -0.08 - rng() * 0.06;
          const a2 = 0.42 + rng() * 0.22;
          const yf = yawOf(seg, -side * Math.sin(a1), fwd * Math.cos(a1));
          const yr = yawOf(seg, -side * Math.sin(a2), fwd * Math.cos(a2));
          const jx = px(seg, lat, t);
          const jz = pz(seg, lat, t);
          const boxes = [
            footprint(jx + Math.sin(yf) * 3.85, jz + Math.cos(yf) * 3.85, yf, 3.45, 1.3),
            footprint(jx - Math.sin(yr) * 3.25, jz - Math.cos(yr) * 3.25, yr, 2.85, 1.3),
          ];
          if (!boxesOk(boxes)) continue;
          commit(boxes);
          mark('articBus', jx, jz);
          heavy.stamp(articFront, trs(jx, 0, jz, yf, 1, 0, 0, m), tint);
          heavy.stamp(articRear, trs(jx, 0.08, jz, yr, 1, 0, 0.035, m), tint);
          // the skid that ended here, glass and a hazard barricade someone set out afterwards
          decal(DECAL.skidArc, px(seg, side * 7.6, t - fwd * 9), pz(seg, side * 7.6, t - fwd * 9), 7, 9, yf + (fwd * side > 0 ? 0 : Math.PI), 0.85);
          decal(DECAL.glass, jx, jz, 5, 5, rng() * 6, 0.9);
          decal(DECAL.oilA, jx + Math.sin(yf) * 3, jz + Math.cos(yf) * 3, 4.5, 4.5, rng() * 6, 0.8);
          const hx = px(seg, side * 7.4, t - fwd * 13);
          const hz = pz(seg, side * 7.4, t - fwd * 13);
          if (free(hx, hz, 1.2) && !reserved(hx, hz, 2)) {
            putLight(barricades[0], hx, hz, yf + 0.3, 1, null, 0, 0, 0, rng());
            tmp.set(0.9, 1.3, 0).applyMatrix4(trs(hx, 0, hz, yf + 0.3));
            glow(tmp.x, tmp.y, tmp.z, 1.5, PAL.amber, 3.2, -2, rng());
          }
          placed = true;
        } else if (kind === 'bus') {
          const lat = side * (10.5 + rng() * 0.5);
          const yaw = yawOf(seg, (rng() - 0.5) * 0.08, fwd);
          const cx = px(seg, lat, t);
          const cz = pz(seg, lat, t);
          const boxes = [footprint(cx, cz, yaw, 5.5, 1.35)];
          if (!boxesOk(boxes)) continue;
          commit(boxes);
          mark('bus', cx, cz);
          heavy.stamp(bus, trs(cx, 0, cz, yaw, 1, 0, (rng() - 0.5) * 0.05, m), tint);
          decal(DECAL.oilB, cx, cz, 5, 3, yaw + Math.PI / 2, 0.8);
          placed = true;
        } else if (kind === 'truck' || kind === 'truckTipped') {
          const lat = side * (9.9 + rng() * 0.6);
          const yaw = yawOf(seg, (rng() - 0.5) * 0.3, fwd);
          const cx = px(seg, lat, t);
          const cz = pz(seg, lat, t);
          const tipped = kind === 'truckTipped';
          const boxes = [footprint(cx, cz, yaw, 4.25, tipped ? 1.85 : 1.3)];
          if (!boxesOk(boxes)) continue;
          commit(boxes);
          mark(tipped ? 'truckTipped' : 'truck', cx, cz);
          if (tipped) {
            m.makeTranslation(0, 1.24, 0);
            m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
            m.multiply(new THREE.Matrix4().makeTranslation(0, -1.78, 0));
            m.premultiply(trs(cx, 0, cz, yaw));
            heavy.stamp(boxTruck, m, tint);
            // spilled cargo
            for (let n = 0; n < 7; n += 1) {
              const sx = cx - Math.sin(yaw) * (4.5 + rng() * 4) + (rng() - 0.5) * 3;
              const sz = cz - Math.cos(yaw) * (4.5 + rng() * 4) + (rng() - 0.5) * 3;
              if (Math.abs(sx - nearestRoad(sx)) < 6.5 || Math.abs(sz - nearestRoad(sz)) < 6.5) continue;
              putLight(crates[Math.floor(rng() * 3)], sx, sz, rng() * 6, 1, null, rng() < 0.3 ? 0.4 : 0, 0, 0);
              blob(sx, sz, 0.8);
            }
            decal(DECAL.skidStraight, cx - Math.sin(yaw) * 9, cz - Math.cos(yaw) * 9, 3.4, 12, yaw, 0.9);
          } else {
            heavy.stamp(boxTruck, trs(cx, 0, cz, yaw, 1, 0, (rng() - 0.5) * 0.04, m), tint);
          }
          decal(DECAL.oilA, cx + Math.sin(yaw) * 2, cz + Math.cos(yaw) * 2, 4, 4, rng() * 6, 0.85);
          placed = true;
        } else {
          const lat = side * 10.2;
          const a1 = 0.02 + rng() * 0.05;
          const a2 = 0.38 + rng() * 0.2;
          const yt = yawOf(seg, -side * Math.sin(a1), fwd * Math.cos(a1));
          const yc = yawOf(seg, -side * Math.sin(a2), fwd * Math.cos(a2));
          const cx = px(seg, lat, t);
          const cz = pz(seg, lat, t);
          const kx = cx + Math.sin(yt) * 3.3;
          const kz = cz + Math.cos(yt) * 3.3;
          const boxes = [
            footprint(cx, cz, yt, 4.6, 1.3),
            footprint(kx + Math.sin(yc) * 0.85, kz + Math.cos(yc) * 0.85, yc, 2.6, 1.3),
          ];
          if (!boxesOk(boxes)) continue;
          commit(boxes);
          mark('tanker', cx, cz);
          heavy.stamp(tankTrailer, trs(cx, 0, cz, yt, 1, 0, 0, m), tint);
          heavy.stamp(tankTractor, trs(kx, 0, kz, yc, 1, 0, 0, m), tint);
          decal(DECAL.scorchA, cx + Math.sin(yt) * 4, cz + Math.cos(yt) * 4, 13, 13, rng() * 6, 0.95);
          decal(DECAL.oilA, cx - Math.sin(yt) * 2, cz - Math.cos(yt) * 2, 6, 6, rng() * 6, 0.85);
          decal(DECAL.oilB, cx - Math.sin(yt) * 7, cz - Math.cos(yt) * 7, 7, 3, yt + Math.PI / 2, 0.8);
          placed = true;
        }
      }
    }
  }

  tally('vehicles');
  // ------------------------------------------------------------------ empty lots: container yards and raider camps
  const lots: { x: number; z: number; cornerX: number; cornerZ: number }[] = [];
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const bx = roadCenter(i) + CITY.pitch / 2;
      const bz = roadCenter(j) + CITY.pitch / 2;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const x = bx + sx * 20;
          const z = bz + sz * 20;
          if (boxHit(x - 14, x + 14, z - 14, z + 14, 0) || reserved(x, z, 20)) continue;
          lots.push({ x, z, cornerX: sx, cornerZ: sz });
        }
      }
    }
  }
  const campLots: typeof lots = [];
  const yardLots: typeof lots = [];
  const wildLots: typeof lots = [];
  {
    const rng = createSeededRandom(202);
    // the lot beside the start is always a camp: the first thing the player sees is that the raiders live here
    const ranked = lots.slice().sort((a, b) => Math.hypot(a.x - start.x, a.z - start.z) - Math.hypot(b.x - start.x, b.z - start.z));
    const rest = shuffled(ranked.slice(1), rng);
    if (ranked.length > 0) campLots.push(ranked[0]);
    rest.forEach((lot, index) => {
      if (index % 3 === 0 && yardLots.length < 5) yardLots.push(lot);
      else if (index % 3 === 1 && campLots.length < 4) campLots.push(lot);
      else wildLots.push(lot);
    });

    // container yards (colliders)
    const paints: Rgb[] = [PAL.red, PAL.teal, PAL.mustard, PAL.blue, PAL.white, PAL.rust];
    const c20 = paints.map((p, i) => buildContainer(6.06, p, 300 + i));
    const c40 = [buildContainer(12.19, PAL.blue, 320), buildContainer(12.19, PAL.red, 321)];
    const m = new THREE.Matrix4();
    for (const lot of yardLots) {
      mark('containerYard', lot.x, lot.z);
      // rows along the two street-facing edges of the lot, clear of the rubble heap in the middle
      for (let row = 0; row < 2; row += 1) {
        const alongX = row === 0;
        const edge = 14.5;
        let t = -13 + rng() * 3;
        while (t < 11) {
          const long = rng() < 0.3;
          const len = long ? 12.19 : 6.06;
          if (t + len > 15) break;
          const cx = alongX ? lot.x + t + len / 2 : lot.x + lot.cornerX * edge;
          const cz = alongX ? lot.z + lot.cornerZ * edge : lot.z + t + len / 2;
          const yaw = (alongX ? Math.PI / 2 : 0) + (rng() - 0.5) * 0.12 + (rng() < 0.5 ? Math.PI : 0);
          const box = footprint(cx, cz, yaw, len / 2, 1.22);
          t += len + 0.5 + rng() * 2.5;
          if (boxHit(box.minX, box.maxX, box.minZ, box.maxZ, 0.3) || rng() < 0.15) continue;
          commit([box]);
          const tpl = long ? c40[Math.floor(rng() * 2)] : c20[Math.floor(rng() * 6)];
          // containers only cast on desktop; low spec grounds them with a contact blob
          const yard = lowSpec ? light.at(cx, cz) : heavy;
          yard.stamp(tpl, trs(cx, CURB, cz, yaw, 1, 0, 0, m), [0.8 + rng() * 0.3, 0.8 + rng() * 0.3, 0.8 + rng() * 0.3]);
          if (lowSpec) decal(DECAL.shadow, cx, cz, long ? 14.5 : 8.4, 4.6, yaw + Math.PI / 2, 0.75, [0, 0, 0]);
          // second tier: every other stack is dropped on low spec (visual only, the footprint collider is the same)
          const stackRoll = rng();
          const upper = c20[Math.floor(rng() * 6)];
          const j1 = rng() - 0.5;
          const j2 = rng() - 0.5;
          const j3 = rng() - 0.5;
          const keepUpper = !lowSpec || colliders.length % 2 === 0;
          if (stackRoll < 0.42 && !long && keepUpper) {
            yard.stamp(upper, trs(cx + j1 * 0.5, CURB + 2.59, cz + j2 * 0.5, yaw + j3 * 0.2, 1, 0, 0, m));
          } else if (stackRoll < 0.3 && long && keepUpper) {
            yard.stamp(upper, trs(cx + Math.sin(yaw) * 2.6, CURB + 2.59, cz + Math.cos(yaw) * 2.6, yaw + j3 * 0.3, 1, 0, 0, m));
          }
        }
      }
      junkCluster(rng, lot.x - lot.cornerX * 6, lot.z - lot.cornerZ * 6, 9, 9);
      decal(DECAL.fang, lot.x + lot.cornerX * 7, lot.z + lot.cornerZ * 7, 5, 5, rng() * 6, 0.85);
    }
  }

  tally('containers');
  // ------------------------------------------------------------------ checkpoints and sandbag nests (colliders)
  {
    const rng = createSeededRandom(303);
    const walls = [buildSandbagWall(5.8, 4, 31), buildSandbagWall(5.8, 3, 32), buildSandbagWall(3.6, 3, 33)];
    const booth = buildGuardBooth();
    const order = shuffled(segs.filter((s) => !isHighway(s) && s.k > 0 && s.k < N), rng);
    let made = 0;
    for (const seg of order) {
      if (made >= 4) break;
      const t = seg.from + 30 + rng() * (seg.to - seg.from - 60);
      const cxm = px(seg, 0, t);
      const czm = pz(seg, 0, t);
      if (reserved(cxm, czm, 40) || tallBlocked(cxm, czm)) continue;
      const crossYaw = seg.axis === 0 ? 0 : Math.PI / 2;
      const wallBoxes: Aabb[] = [];
      const wallPos: [number, number][] = [];
      for (const side of [-1, 1]) {
        const wt = t + side * 4;
        const wx = px(seg, side * 9.6, wt);
        const wz = pz(seg, side * 9.6, wt);
        wallPos.push([wx, wz]);
        wallBoxes.push(footprint(wx, wz, crossYaw + Math.PI / 2, 2.95, 0.42));
      }
      const side = rng() < 0.5 ? 1 : -1;
      const bx = px(seg, side * 15.4, t);
      const bz = pz(seg, side * 15.4, t);
      const boothBox = { minX: bx - 1.0, maxX: bx + 1.0, minZ: bz - 1.0, maxZ: bz + 1.0 };
      if (!boxesOk(wallBoxes) || boxHit(boothBox.minX, boothBox.maxX, boothBox.minZ, boothBox.maxZ, 0.3) || !softClear(bx, bz, 1.6)) continue;
      commit(wallBoxes);
      commit([boothBox]);
      made += 1;
      mark('checkpoint', cxm, czm);
      wallPos.forEach(([wx, wz], n) => {
        light.at(wx, wz).stamp(walls[n], trs(wx, 0, wz, crossYaw + (rng() - 0.5) * 0.06));
        blob(wx, wz, 3.2, 0.6);
        // concertina wire along the top and trailing off toward the kerb
        const c = Math.cos(crossYaw);
        const s = Math.sin(crossYaw);
        const top = n === 0 ? 0.98 : 0.74;
        for (const tilt of [-0.25, 0.25]) {
          cards.at(wx, wz).quad(
            [wx - c * 2.9, top - 0.1, wz + s * 2.9 - tilt * c], [wx + c * 2.9, top - 0.1, wz - s * 2.9 - tilt * c],
            [wx + c * 2.9, top + 0.72, wz - s * 2.9 + tilt * c], [wx - c * 2.9, top + 0.72, wz + s * 2.9 + tilt * c],
            CARD.wire, [0.8, 0.8, 0.8], 1, [0, 1, 0],
          );
        }
        // barricade with a strobing beacon ahead of each wall
        const sideSign = n === 0 ? -1 : 1;
        const hx = px(seg, sideSign * 8.6, t + sideSign * 10);
        const hz = pz(seg, sideSign * 8.6, t + sideSign * 10);
        const hy = crossYaw + (rng() - 0.5) * 0.5;
        putLight(barricades[0], hx, hz, hy, 1, null, 0, 0, 0, rng());
        blob(hx, hz, 1.2, 0.5);
        tmp.set(0.9, 1.3, 0).applyMatrix4(trs(hx, 0, hz, hy));
        glow(tmp.x, tmp.y, tmp.z, 1.5, PAL.amber, 3.2, -2, rng());
        decal(DECAL.hazard, px(seg, sideSign * 9.6, t + sideSign * 7), pz(seg, sideSign * 9.6, t + sideSign * 7), 6, 6, crossYaw, 0.8);
      });
      putLight(booth, bx, bz, yawOf(seg, -side, 0) + (rng() - 0.5) * 0.1);
      blob(bx, bz, 1.9, 0.75);
      // fence run and wire on the booth's pavement, junk behind it
      for (let n = -2; n <= 2; n += 1) {
        if (n === 0) continue;
        const fx0 = px(seg, side * 14.2, t + n * 3.2 - 1.6);
        const fz0 = pz(seg, side * 14.2, t + n * 3.2 - 1.6);
        const fx1 = px(seg, side * 14.2, t + n * 3.2 + 1.6);
        const fz1 = pz(seg, side * 14.2, t + n * 3.2 + 1.6);
        if (!free((fx0 + fx1) / 2, (fz0 + fz1) / 2, 1.2)) continue;
        cards.at(fx0, fz0).quad([fx0, CURB, fz0], [fx1, CURB, fz1], [fx1, CURB + 2.1, fz1], [fx0, CURB + 2.1, fz0], CARD.fence, [0.85, 0.85, 0.85], 1, [0, 1, 0]);
        light.at(fx0, fz0).beam(fx0, CURB, fz0, fx0, CURB + 2.2, fz0, 0.07, PAL.galv);
      }
      junkCluster(rng, px(seg, side * 16.2, t + 5), pz(seg, side * 16.2, t + 5), 2.6, 5);
      decal(DECAL.stop, px(seg, 3.2, t - 16), pz(seg, 3.2, t - 16), 2.2, 6, seg.axis === 0 ? Math.PI : -Math.PI / 2, 0.8);
      decal(DECAL.stop, px(seg, -3.2, t + 16), pz(seg, -3.2, t + 16), 2.2, 6, seg.axis === 0 ? 0 : Math.PI / 2, 0.8);
    }
    // U-shaped sandbag nests on pavement corners
    let nests = 0;
    for (let n = 0; n < 60 && nests < 6; n += 1) {
      const k = 1 + Math.floor(rng() * (N - 1));
      const mIdx = 1 + Math.floor(rng() * (N - 1));
      const sx = rng() < 0.5 ? 1 : -1;
      const sz = rng() < 0.5 ? 1 : -1;
      const cx = roadCenter(k) + sx * 16.6;
      const cz = roadCenter(mIdx) + sz * 16.6;
      if (reserved(cx, cz, 12) || !free(cx, cz, 3.2) || !softClear(cx, cz, 3)) continue;
      const wallA = footprint(cx - sx * 1.9, cz, Math.PI, 1.85, 0.42);
      const wallB = footprint(cx, cz - sz * 1.9, Math.PI / 2, 1.85, 0.42);
      commit([wallA, wallB]);
      nests += 1;
      mark('sandbagNest', cx, cz);
      light.at(cx, cz).stamp(walls[2], trs(cx - sx * 1.9, CURB, cz, Math.PI / 2));
      light.at(cx, cz).stamp(walls[2], trs(cx, CURB, cz - sz * 1.9, 0));
      blob(cx - sx * 1.9, cz, 2.2, 0.55);
      blob(cx, cz - sz * 1.9, 2.2, 0.55);
      putLight(crates[2], cx + sx * 0.4, cz + sz * 0.4, rng() * 6);
      putLight(oilDrums[1], cx - sx * 0.6, cz + sz * 1.1, 0);
      soft.push({ x: cx, z: cz, r: 3 });
    }
  }

  tally('checkpoints');
  // ------------------------------------------------------------------ bus stops (colliders)
  {
    const rng = createSeededRandom(404);
    const shelters = [buildBusShelter(41), buildBusShelter(42)];
    const order = shuffled(segs.filter((s) => s.k > 0 && s.k < N), rng);
    let made = 0;
    for (const seg of order) {
      if (made >= 14) break;
      const side = rng() < 0.5 ? 1 : -1;
      const t = rng() < 0.5 ? seg.from + 16 + rng() * 10 : seg.to - 16 - rng() * 10;
      const x = px(seg, side * 16.1, t);
      const z = pz(seg, side * 16.1, t);
      const yaw = yawOf(seg, -side, 0);
      const box = footprint(x, z, yaw + Math.PI / 2, 2.4, 1.0);
      if (reserved(x, z, 6) || boxHit(box.minX, box.maxX, box.minZ, box.maxZ, 0.6) || !softClear(x, z, 3.2)) continue;
      commit([box]);
      made += 1;
      mark('busShelter', x, z);
      putKit(shelters[made % 2], trs(x, CURB, z, yaw + (rng() - 0.5) * 0.05), x, z, true);
      if (lowSpec) blob(x, z, 2.6, 0.6);
      decal(DECAL.glass, x - Math.sin(yaw) * 0.2, z - Math.cos(yaw) * 0.2, 4.5, 3, yaw, 0.9);
      decal(DECAL.paper, px(seg, side * 14.6, t + 3), pz(seg, side * 14.6, t + 3), 3, 3, rng() * 6, 0.9);
      if (rng() < 0.5) junkCluster(rng, px(seg, side * 16.4, t + 5.5), pz(seg, side * 16.4, t + 5.5), 1.6, 3);
    }
  }

  tally('busStops');
  // ------------------------------------------------------------------ traffic lights
  {
    const rng = createSeededRandom(505);
    const variants = [buildTrafficLight(0), buildTrafficLight(1), buildTrafficLight(2)];
    const m = new THREE.Matrix4();
    for (let k = 0; k <= N; k += 1) {
      for (let j = 0; j <= N; j += 1) {
        const edge = k === 0 || k === N || j === 0 || j === N;
        if (rng() > (edge ? 0.2 : lowSpec ? 0.3 : 0.62)) continue;
        const cx = roadCenter(k);
        const cz = roadCenter(j);
        const flip = rng() < 0.5 ? 1 : -1;
        const corners: [number, number][] = rng() < 0.4 ? [[-1, -flip], [1, flip]] : [[flip, 1]];
        for (const [sx, sz] of corners) {
          const x = cx + sx * 14.3;
          const z = cz + sz * 14.3;
          if (Math.abs(x) > CITY_HALF + 2 || Math.abs(z) > CITY_HALF + 2) continue;
          if (reserved(x, z, 4) || tallBlocked(x, z) || !softClear(x, z, 1.2) || !free(x, z, 0.6)) continue;
          const overZRoad = rng() < 0.5;
          const yaw = overZRoad ? (sx < 0 ? 0 : Math.PI) : (sz < 0 ? -Math.PI / 2 : Math.PI / 2);
          const roll = rng();
          const variant = roll < 0.2 ? 1 : roll < 0.42 ? 2 : 0;
          const lean = rng() < 0.3 ? 0.08 + rng() * 0.16 : rng() * 0.03;
          trs(x, CURB, z, yaw, 1, (rng() - 0.5) * lean * 2, (rng() - 0.5) * lean * 2, m);
          const phase = rng();
          anchorSoup(x, z).stamp(variants[variant], m, null, phase);
          soft.push({ x, z, r: 1.2 });
          mark(variant === 1 ? 'trafficBlink' : variant === 2 ? 'trafficDangling' : 'trafficDead', x, z);
          if (variant === 1) {
            tmp.set(5.6, 6.2, 0.4).applyMatrix4(m);
            // matches the lamp's shader blink: same mode and phase
            glow(tmp.x, tmp.y, tmp.z, 2.6, PAL.amber, 3.4, -1, Math.min(0.99, phase));
          }
        }
      }
    }
  }

  tally('trafficLights');
  // ------------------------------------------------------------------ overhead gantries
  {
    const rng = createSeededRandom(606);
    const kits = [buildGantry(false, [0, 1]), buildGantry(true, [3, 2]), buildGantry(false, [2, -1]), buildGantry(true, [1, 0])];
    const spots: { seg: Seg; t: number; kit: number; faceBack: boolean }[] = [];
    // one greets the player just past the start lane
    const startSeg = segs.find((s) => s.axis === 0 && s.c === nearestRoad(start.x) && start.z + 170 > s.from && start.z + 170 < s.to);
    if (startSeg) spots.push({ seg: startSeg, t: start.z + 172, kit: 0, faceBack: true });
    const order = shuffled(segs.filter((s) => !isHighway(s) && s.k > 0 && s.k < N), rng);
    for (const seg of order) {
      if (spots.length >= (lowSpec ? 6 : 9)) break;
      const t = (seg.from + seg.to) / 2 + (rng() - 0.5) * 30;
      if (spots.some((s) => Math.hypot(px(s.seg, 0, s.t) - px(seg, 0, t), pz(s.seg, 0, s.t) - pz(seg, 0, t)) < 150)) continue;
      spots.push({ seg, t, kit: 1 + Math.floor(rng() * 3), faceBack: rng() < 0.5 });
    }
    for (const spot of spots) {
      const { seg } = spot;
      let t = spot.t;
      let ok = false;
      for (let tries = 0; tries < 8 && !ok; tries += 1) {
        ok = true;
        for (const side of [-1, 1]) {
          const x = px(seg, side * 15, t);
          const z = pz(seg, side * 15, t);
          if (!free(x, z, 0.8) || !softClear(x, z, 1.4) || tallBlocked(x, z) || reserved(x, z, 14)) ok = false;
        }
        if (boxHit(px(seg, -12, t) - 1, px(seg, 12, t) + 1, pz(seg, -12, t) - 1, pz(seg, 12, t) + 1, 0)) ok = false;
        if (!ok) t += 5;
      }
      if (!ok || t > seg.to - 6) continue;
      const x = px(seg, 0, t);
      const z = pz(seg, 0, t);
      const yaw = (seg.axis === 0 ? 0 : Math.PI / 2) + (spot.faceBack ? Math.PI : 0);
      const m = trs(x, 0, z, yaw);
      // posts stand on the kerb: lift the whole frame by the kerb height
      m.elements[13] = CURB - 0.02;
      putKit(kits[spot.kit], m, x, z, true);
      mark('gantry', x, z);
      for (const side of [-1, 1]) soft.push({ x: px(seg, side * 15, t), z: pz(seg, side * 15, t), r: 1.4 });
    }
  }

  tally('gantries');
  // ------------------------------------------------------------------ bent road signs
  {
    const rng = createSeededRandom(707);
    const kits: Kit[] = [];
    for (let kind = 0; kind < 12; kind += 1) kits.push(buildRoadSign(kind));
    const target = lowSpec ? 34 : 76;
    let made = 0;
    for (let n = 0; n < 600 && made < target; n += 1) {
      const seg = segs[Math.floor(rng() * segs.length)];
      const side = rng() < 0.5 ? 1 : -1;
      const nearCorner = rng() < 0.55;
      const fwd = rng() < 0.5 ? 1 : -1;
      const t = nearCorner ? (fwd > 0 ? seg.to - 2 - rng() * 5 : seg.from + 2 + rng() * 5) : seg.from + 10 + rng() * (seg.to - seg.from - 20);
      const x = px(seg, side * 13.9, t);
      const z = pz(seg, side * 13.9, t);
      if (Math.abs(x) > CITY_HALF + 14 || Math.abs(z) > CITY_HALF + 14) continue;
      if (reserved(x, z, 1) || !free(x, z, 0.6) || !softClear(x, z, 1.0)) continue;
      const kind = nearCorner ? (rng() < 0.4 ? 0 : rng() < 0.5 ? 8 + Math.floor(rng() * 3) : 1 + Math.floor(rng() * 4)) : (rng() < 0.3 ? 7 : rng() < 0.5 ? 11 : 2 + Math.floor(rng() * 4));
      // plates face the traffic that approaches them
      const yaw = yawOf(seg, -side * 0.15, -fwd) + (rng() - 0.5) * 0.5;
      const bent = rng();
      const rx = bent < 0.18 ? (rng() - 0.5) * 1.3 : (rng() - 0.5) * 0.16;
      const rz = bent < 0.3 ? (rng() - 0.5) * 0.9 : (rng() - 0.5) * 0.12;
      putKit(kits[kind], trs(x, CURB - 0.05, z, yaw, 1, rx, rz), x, z, false);
      soft.push({ x, z, r: 0.8 });
      made += 1;
    }
  }

  tally('roadSigns');
  // ------------------------------------------------------------------ scaffolding with torn tarps
  {
    const rng = createSeededRandom(808);
    const tarpTints: Rgb[] = [[0.16, 0.3, 0.52], [0.42, 0.4, 0.34], [0.5, 0.26, 0.08], [0.2, 0.3, 0.2]];
    const order = shuffled(faces.filter((f) => f.len > 16 && f.h > 6.5 && f.setback > 3.2), rng);
    const placed: Disc[] = [];
    const target = lowSpec ? 4 : 16;
    for (const face of order) {
      if (placed.length >= target) break;
      if (placed.some((p) => Math.hypot(p.x - face.x, p.z - face.z) < 70)) continue;
      const length = Math.min(face.len - 4, 9.6 + Math.floor(rng() * 5) * 2.4);
      const off = (rng() - 0.5) * (face.len - length - 2);
      const x = face.x - face.nz * off;
      const z = face.z + face.nx * off;
      if (reserved(x, z, 10) || tallBlocked(x, z)) continue;
      if (!softClear(x + face.nx * 1.2, z + face.nz * 1.2, 1.0)) continue;
      const levels = Math.max(2, Math.min(5, Math.floor((face.h - 0.6) / 2)));
      const kit = buildScaffold(length, levels, 800 + placed.length, tarpTints[Math.floor(rng() * tarpTints.length)]);
      putKit(kit, trs(x + face.nx * 0.05, CURB, z + face.nz * 0.05, Math.atan2(face.nx, face.nz)), x, z, false);
      face.used = true;
      mark('scaffold', x, z);
      placed.push({ x, z, r: length / 2 });
      for (let s = -length / 2; s <= length / 2; s += 2.4) soft.push({ x: x - face.nz * s + face.nx * 1.2, z: z + face.nx * s + face.nz * 1.2, r: 1.6 });
      decal(DECAL.apron, x + face.nx * 2.2, z + face.nz * 2.2, length, 4.2, Math.atan2(-face.nx, -face.nz), 0.9);
    }
  }

  tally('scaffolds');
  // ------------------------------------------------------------------ tower bases: rubble aprons, fallen plant, creeper, posters
  {
    const rng = createSeededRandom(909);
    for (const face of faces) {
      if (rng() > (lowSpec ? 0.25 : 0.72)) continue;
      const tx = -face.nz;
      const tz = face.nx;
      const wallYaw = Math.atan2(face.nx, face.nz);
      const spots = lowSpec ? 1 : 1 + Math.floor(rng() * (face.len / 18));
      for (let n = 0; n < spots; n += 1) {
        const off = (rng() - 0.5) * (face.len - 8);
        const bx = face.x + tx * off;
        const bz = face.z + tz * off;
        if (reserved(bx, bz, 2)) continue;
        const depth = Math.min(face.setback - 0.4, 2.6 + rng() * 2.4);
        const width = 6 + rng() * 6;
        decal(DECAL.apron, bx + face.nx * depth * 0.5, bz + face.nz * depth * 0.5, width, depth, wallYaw + Math.PI, 0.75 + rng() * 0.2);
        const chunks = lowSpec ? Math.floor(rng() * 2) : Math.floor(rng() * 3);
        for (let c = 0; c < chunks; c += 1) {
          const cx = bx + tx * (rng() - 0.5) * width * 0.8 + face.nx * (0.3 + Math.pow(rng(), 1.6) * depth);
          const cz = bz + tz * (rng() - 0.5) * width * 0.8 + face.nz * (0.3 + Math.pow(rng(), 1.6) * depth);
          if (!softClear(cx, cz, 0.4)) continue;
          const s = 0.18 + Math.pow(rng(), 2) * 0.6;
          putLight(chips[Math.floor(rng() * 3)], cx, cz, rng() * 6, s, [0.8 + rng() * 0.5, 0.8 + rng() * 0.45, 0.8 + rng() * 0.4], rng() * 0.6, rng() * 0.6, s * 0.12);
        }
        const roll = rng();
        const ox = bx + face.nx * (1.0 + rng() * 1.2);
        const oz = bz + face.nz * (1.0 + rng() * 1.2);
        if (roll < (lowSpec ? 0.1 : 0.15) && softClear(ox, oz, 1.2) && face.setback > 3) {
          // condenser that came off the roof, with the dent it left
          putLight(acUnit, ox, oz, rng() * 6, 1, null, (rng() - 0.5) * 0.5, 0.2 + rng() * 0.5, 0.1);
          blob(ox, oz, 1.2);
          decal(DECAL.crack, ox, oz, 3.4, 3.4, rng() * 6, 0.9);
          soft.push({ x: ox, z: oz, r: 1.2 });
        } else if (roll < 0.33 && !lowSpec) {
          // dead creeper up the first floors
          const w = 4.5;
          const h = Math.min(face.h - 0.5, 5.5);
          const px0 = bx - tx * w * 0.5 + face.nx * 0.06;
          const pz0 = bz - tz * w * 0.5 + face.nz * 0.06;
          cards.at(bx, bz).quad([px0, CURB, pz0], [px0 + tx * w, CURB, pz0 + tz * w], [px0 + tx * w, CURB + h, pz0 + tz * w], [px0, CURB + h, pz0], CARD.ivy, [0.8, 0.75, 0.7], 1, [face.nx * 0.7, 0.7, face.nz * 0.7]);
        } else if (roll < 0.5) {
          // evacuation-order posters
          for (let p = 0; p < 3; p += 1) {
            const w = 1.1;
            const px0 = bx + tx * (p * 1.3 - 2) + face.nx * 0.05;
            const pz0 = bz + tz * (p * 1.3 - 2) + face.nz * 0.05;
            const y0 = CURB + 1.0 + rng() * 0.4;
            cards.at(bx, bz).quad([px0, y0, pz0], [px0 + tx * w, y0, pz0 + tz * w], [px0 + tx * w, y0 + 1.25, pz0 + tz * w], [px0, y0 + 1.25, pz0], CARD.poster, [0.7 + rng() * 0.2, 0.68, 0.62], 1, [face.nx * 0.7, 0.7, face.nz * 0.7]);
          }
        }
      }
    }
  }

  tally('towerBases');
  // ------------------------------------------------------------------ service alleys: dumpsters, pallets, string lights
  const alleyLines: { ax: number; az: number; bx: number; bz: number }[] = [];
  {
    const rng = createSeededRandom(1010);
    const buildings = layout.colliders.filter((c) => c.maxX - c.minX > 12 && c.maxZ - c.minZ > 12);
    const mouths: { x: number; z: number; dx: number; dz: number; w: number }[] = [];
    for (let a = 0; a < buildings.length; a += 1) {
      for (let b = a + 1; b < buildings.length; b += 1) {
        const A = buildings[a];
        const B = buildings[b];
        const gx = Math.max(A.minX, B.minX) - Math.min(A.maxX, B.maxX);
        const gz = Math.max(A.minZ, B.minZ) - Math.min(A.maxZ, B.maxZ);
        if (gx > 4 && gx < 13 && gz < -12) {
          const x0 = Math.min(A.maxX, B.maxX);
          const z0 = Math.max(A.minZ, B.minZ);
          const z1 = Math.min(A.maxZ, B.maxZ);
          mouths.push({ x: x0 + gx / 2, z: z0, dx: 0, dz: 1, w: gx }, { x: x0 + gx / 2, z: z1, dx: 0, dz: -1, w: gx });
        } else if (gz > 4 && gz < 13 && gx < -12) {
          const z0 = Math.min(A.maxZ, B.maxZ);
          const x0 = Math.max(A.minX, B.minX);
          const x1 = Math.min(A.maxX, B.maxX);
          mouths.push({ x: x0, z: z0 + gz / 2, dx: 1, dz: 0, w: gz }, { x: x1, z: z0 + gz / 2, dx: -1, dz: 0, w: gz });
        }
      }
    }
    const order = shuffled(mouths, rng);
    const target = lowSpec ? 12 : 36;
    let made = 0;
    for (const mouth of order) {
      if (made >= target) break;
      // only mouths that open toward a street within the block's pavement
      const ox = mouth.x - mouth.dx * 9;
      const oz = mouth.z - mouth.dz * 9;
      if (surfaceY(ox, oz) !== 0 && surfaceY(mouth.x - mouth.dx * 14, mouth.z - mouth.dz * 14) !== 0) continue;
      if (reserved(mouth.x, mouth.z, 8)) continue;
      const tx = -mouth.dz;
      const tz = mouth.dx;
      const wallSide = rng() < 0.5 ? 1 : -1;
      const inset = 3 + rng() * 5;
      const dx0 = mouth.x + mouth.dx * inset + tx * wallSide * (mouth.w / 2 - 0.85);
      const dz0 = mouth.z + mouth.dz * inset + tz * wallSide * (mouth.w / 2 - 0.85);
      if (!free(dx0, dz0, 0.6)) continue;
      made += 1;
      mark('alley', mouth.x, mouth.z);
      const dYaw = Math.atan2(-tx * wallSide, -tz * wallSide);
      putLight(dumpsters[Math.floor(rng() * 3)], dx0, dz0, dYaw + (rng() - 0.5) * 0.15);
      blob(dx0, dz0, 1.5);
      if (rng() < 0.5) {
        const d2x = dx0 + mouth.dx * 2.4;
        const d2z = dz0 + mouth.dz * 2.4;
        putLight(dumpsters[Math.floor(rng() * 3)], d2x, d2z, dYaw + (rng() - 0.5) * 0.4);
        blob(d2x, d2z, 1.5);
      }
      soft.push({ x: dx0, z: dz0, r: 1.6 });
      junkCluster(rng, mouth.x + mouth.dx * (inset + 3) - tx * wallSide * (mouth.w / 2 - 1.4), mouth.z + mouth.dz * (inset + 3) - tz * wallSide * (mouth.w / 2 - 1.4), 1.8, 4);
      decal(DECAL.paper, mouth.x + mouth.dx * 2, mouth.z + mouth.dz * 2, 3.4, 3.4, rng() * 6, 0.9);
      decal(DECAL.oilB, mouth.x + mouth.dx * inset, mouth.z + mouth.dz * inset, 4, 2.4, rng() * 6, 0.7);
      if (rng() < 0.45) {
        const s = 1.5 + rng() * 2.5;
        const half = mouth.w / 2;
        alleyLines.push({
          ax: mouth.x + mouth.dx * s - tx * half, az: mouth.z + mouth.dz * s - tz * half,
          bx: mouth.x + mouth.dx * s + tx * half, bz: mouth.z + mouth.dz * s + tz * half,
        });
      }
    }
  }

  tally('alleys');
  // ------------------------------------------------------------------ raider camps
  const campFires: Disc[] = [];
  {
    const rng = createSeededRandom(1616);
    const scrap = [buildScrapWall(161), buildScrapWall(162)];
    const leanTos = [buildLeanTo([0.2, 0.3, 0.42]), buildLeanTo([0.36, 0.3, 0.2])];
    const fire = buildCampfire(163);
    campLots.forEach((lot, index) => {
      // camps sit in the street-side corner of the lot, off the rubble heap
      let cx = lot.x + lot.cornerX * 9;
      let cz = lot.z + lot.cornerZ * 9;
      for (let tries = 0; tries < 12 && !(free(cx, cz, 2.5) && softClear(cx, cz, 1.6)); tries += 1) {
        cx = lot.x + (rng() - 0.5) * 22;
        cz = lot.z + (rng() - 0.5) * 22;
      }
      if (!free(cx, cz, 2)) return;
      putLight(fire, cx, cz, rng() * 6, 1, null, 0, 0, 0, rng());
      decal(DECAL.scorchB, cx, cz, 5.5, 5.5, rng() * 6, 0.9);
      soft.push({ x: cx, z: cz, r: 2 });
      campFires.push({ x: cx, z: cz, r: 1 });
      mark('raiderCamp', cx, cz);
      const ring = 7;
      for (let n = 0; n < ring; n += 1) {
        const a = (n / ring) * Math.PI * 2 + index;
        const r = 5.2 + rng() * 1.6;
        const jx = cx + Math.cos(a) * r;
        const jz = cz + Math.sin(a) * r;
        if (!free(jx, jz, 1.8) || !softClear(jx, jz, 1.5)) continue;
        const outward = Math.atan2(Math.cos(a), Math.sin(a));
        if (n % 3 === 0) {
          putKit(leanTos[n % 2], trs(jx, CURB, jz, outward + Math.PI + (rng() - 0.5) * 0.3), jx, jz, false);
          blob(jx, jz, 2.4, 0.5);
        } else {
          putKit(scrap[n % 2], trs(jx, CURB, jz, outward + (rng() - 0.5) * 0.3), jx, jz, false);
          blob(jx, jz, 1.9, 0.5);
        }
        soft.push({ x: jx, z: jz, r: 2 });
      }
      junkCluster(rng, cx, cz, 4.2, 9);
      // war banner on a pole
      const fxp = cx + lot.cornerX * 3.4;
      const fzp = cz + lot.cornerZ * 3.4;
      if (free(fxp, fzp, 0.6)) {
        const s = light.at(fxp, fzp);
        s.beam(fxp, CURB, fzp, fxp + 0.2, CURB + 6.4, fzp, 0.09, PAL.woodDark);
        s.beam(fxp + 0.18, CURB + 6.0, fzp, fxp + 0.18 + windX * 2.2, CURB + 6.0, fzp + windZ * 2.2, 0.05, PAL.woodDark);
        cards.at(fxp, fzp).quad(
          [fxp + 0.18, CURB + 3.3, fzp], [fxp + 0.18 + windX * 2.2, CURB + 3.3, fzp + windZ * 2.2],
          [fxp + 0.18 + windX * 2.2, CURB + 6.0, fzp + windZ * 2.2], [fxp + 0.18, CURB + 6.0, fzp],
          CARD.banner, [1, 1, 1], 1, [0.3, 0.8, 0.5], [0.3, 0.42, 0.05, 0],
        );
      }
      decal(DECAL.fang, cx - lot.cornerX * 4, cz + lot.cornerZ * 3, 4, 4, rng() * 6, 0.9);
      // flames, embers, smoke column and the warm pool of light around the fire
      const y = CURB + 0.2;
      fx.add(1, cx, y, cz, 1.9, 0.5, 2.7, 0.05, 0, rng(), 0, [1, 1, 1], 1.0);
      fx.add(1, cx + 0.2, y, cz - 0.1, 1.2, 0.3, 1.9, 0.08, 0, rng(), 0, [1, 0.9, 0.8], 0.9);
      glow(cx, y + 1.0, cz, 9, [1.0, 0.42, 0.12], 1.5, -3, rng());
      for (let e = 0; e < (lowSpec ? 4 : 8); e += 1) {
        fx.add(2, cx + (rng() - 0.5) * 0.8, y + 0.8, cz + (rng() - 0.5) * 0.8, 0.14, 0.14, 0.14, 0, 0.16 + rng() * 0.2, rng(), 0, [1.0, 0.5, 0.12], 5, windX * 1.6 + (rng() - 0.5), 5 + rng() * 3, windZ * 1.6 + (rng() - 0.5));
      }
      fxNear.add(0, cx, y + 1.6, cz, 2.2, 7, 30, 0.42, 0, rng(), 1.4, [0.05, 0.045, 0.045], 0.5, 0, 0, 0, 5);
    });
  }

  tally('camps');
  // ------------------------------------------------------------------ utility poles and sagging overhead wires
  const wirePoints: number[] = [];
  {
    const rng = createSeededRandom(2121);
    const pole = new Soup();
    pole.cyl(0, 4.7, 0, 0.09, 0.15, 9.4, 4, PAL.woodDark, 'y', true);
    pole.box(0, 8.9, 0, 0.1, 0.1, 2.2, PAL.woodDark);
    const poleTx = new Soup();
    poleTx.stamp(pole, trs(0, 0, 0));
    poleTx.box(0.32, 7.5, 0, 0.5, 0.9, 0.5, PAL.galv);
    const wire = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, sag: number): void => {
      const steps = 5;
      for (let n = 0; n < steps; n += 1) {
        for (const t of [n / steps, (n + 1) / steps]) {
          wirePoints.push(ax + (bx - ax) * t, ay + (by - ay) * t - Math.sin(t * Math.PI) * sag, az + (bz - az) * t);
        }
      }
    };
    const m = new THREE.Matrix4();
    const tops: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const prevTops: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let axis = 0; axis < 2; axis += 1) {
      for (let k = 1; k < N; k += 1) {
        if (rng() > (lowSpec ? 0.28 : 0.78)) continue;
        const side = rng() < 0.5 ? 1 : -1;
        const c = roadCenter(k);
        let hasPrev = false;
        for (let b = 0; b < N; b += 1) {
          for (const offset of [8, 36, 64]) {
            const t = roadCenter(b) + HALF_ROAD + offset + (rng() - 0.5) * 3;
            const x = axis === 0 ? c + side * 13.75 : t;
            const z = axis === 0 ? t : c + side * 13.75;
            const snapped = rng() < 0.07;
            if (snapped || reserved(x, z, 2.5) || tallBlocked(x, z) || !free(x, z, 0.5) || !softClear(x, z, 0.9)) {
              // the run breaks here: the last span droops to the ground
              if (hasPrev && snapped) for (let w = 0; w < 2; w += 1) wire(prevTops[w].x, prevTops[w].y, prevTops[w].z, x + (rng() - 0.5) * 3, surfaceY(x, z) + 0.05, z + (rng() - 0.5) * 3, 1.5);
              hasPrev = false;
              continue;
            }
            const lean = rng() < 0.2 ? 0.14 : 0.03;
            // crossarm (local Z) lies across the street
            trs(x, CURB - 0.1, z, axis === 0 ? Math.PI / 2 : 0, 1, (rng() - 0.5) * lean, (rng() - 0.5) * lean, m);
            light.at(x, z).stamp(rng() < 0.3 ? poleTx : pole, m, [0.8 + rng() * 0.5, 0.8 + rng() * 0.45, 0.8 + rng() * 0.4]);
            soft.push({ x, z, r: 0.9 });
            tops[0].set(0, 8.98, -1.0).applyMatrix4(m);
            tops[1].set(0, 8.98, 1.0).applyMatrix4(m);
            tops[2].set(0, 8.45, 0).applyMatrix4(m);
            if (hasPrev) for (let w = 0; w < 3; w += 1) wire(prevTops[w].x, prevTops[w].y, prevTops[w].z, tops[w].x, tops[w].y, tops[w].z, 0.5 + rng() * 0.7);
            for (let w = 0; w < 3; w += 1) prevTops[w].copy(tops[w]);
            hasPrev = true;
          }
        }
      }
    }
  }
  tally('poles');
  // ------------------------------------------------------------------ 2. dead trees
  const treeSpots: Disc[] = [];
  {
    const rng = createSeededRandom(1111);
    const kinds = [0, 1, 2].map((v) => [buildTree(v, 400 + v), buildTree(v, 410 + v)]);
    const target = lowSpec ? 46 : 104;
    const order = shuffled(segs, rng);
    const m = new THREE.Matrix4();
    const plant = (x: number, z: number): boolean => {
      if (reserved(x, z, 2) || tallBlocked(x, z) || !free(x, z, 1.3) || !softClear(x, z, 2.2)) return false;
      const roll = rng();
      const variant = roll < 0.55 ? 0 : roll < 0.75 ? 1 : 2;
      const tree = kinds[variant][Math.floor(rng() * 2)];
      const scale = 0.85 + rng() * 0.4;
      trs(x, surfaceY(x, z), z, rng() * Math.PI * 2, scale, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.08, m);
      const tone = 0.8 + rng() * 0.6;
      anchorSoup(x, z).stamp(tree.wood, m, [tone, tone, tone]);
      light.at(x, z).stamp(tree.fine, m, [tone, tone, tone]);
      cards.at(x, z).stamp(tree.cards, m);
      if (lowSpec) blob(x, z, 1.3, 0.6);
      soft.push({ x, z, r: 1.6 });
      treeSpots.push({ x, z, r: 1 });
      mark('tree', x, z);
      return true;
    };
    // authored runs first: the start avenue, the cross street, the approach under the fallen tower, the relay road
    const run = (axis: 0 | 1, c: number, t0: number, t1: number, sides: number[], spacing: number): void => {
      for (const side of sides) {
        let t = Math.min(t0, t1) + 3 + rng() * 5;
        while (t < Math.max(t0, t1)) {
          const clearOfJunction = Math.abs(t - nearestRoad(t)) > HALF_ROAD + 5;
          if (clearOfJunction && rng() > 0.16) plant(axis === 0 ? c + side * 15.3 : t, axis === 0 ? t : c + side * 15.3);
          t += spacing * (0.85 + rng() * 0.35);
        }
      }
    };
    const sp = lowSpec ? 27 : 14.5;
    const startRoad = nearestRoad(start.x);
    run(0, startRoad, start.z - 12, crossZ, [-1, 1], sp);
    run(1, crossZ, startRoad, heroX, [1], sp * 1.25);
    run(0, heroX, crossZ, crossZ + 150, [-1, 1], sp);
    run(0, heroX, crossZ + 150, relayRoadZ, [rng() < 0.5 ? 1 : -1], sp * 1.5);
    run(1, relayRoadZ, heroX, relay.x + 60, [-1, 1], sp * 1.15);
    // then loose runs through the rest of the city
    for (const seg of order) {
      if (treeSpots.length >= target) break;
      if (seg.k === 0 || seg.k === N || rng() < 0.5) continue;
      const side = rng() < 0.5 ? 1 : -1;
      let t = seg.from + 7 + rng() * 5;
      while (t < seg.to - 6 && treeSpots.length < target) {
        if (rng() > 0.25) plant(px(seg, side * 15.3, t), pz(seg, side * 15.3, t));
        t += 13 + rng() * 6;
      }
    }
    // a couple of survivors in every wild lot
    for (const lot of wildLots) {
      for (let n = 0; n < 3; n += 1) plant(lot.x + (rng() - 0.5) * 26, lot.z + (rng() - 0.5) * 26);
    }
  }

  tally('trees');
  // ------------------------------------------------------------------ 2. dry weeds and scrub
  {
    const rng = createSeededRandom(1212);
    const target = lowSpec ? 700 : 2700;
    let made = 0;
    const tuft = (x: number, z: number, big: boolean): void => {
      if (reserved(x, z, 0.5) || !free(x, z, 0.15)) return;
      const y = surfaceY(x, z) - 0.03;
      const scrub = big && rng() < 0.5;
      const w = scrub ? 1.1 + rng() * 0.9 : (0.55 + rng() * 0.6) * (big ? 1.5 : 1);
      const h = scrub ? 1.0 + rng() * 0.9 : (0.34 + rng() * 0.5) * (big ? 1.5 : 1);
      const rect = scrub ? CARD.scrub[Math.floor(rng() * 2)] : CARD.grass[Math.floor(rng() * 4)];
      const tone = 0.2 + rng() * 0.16;
      const tint: Rgb = scrub ? [tone * 2.2, tone * 2.2, tone * 2.2] : [tone * (0.95 + rng() * 0.15), tone * 0.92, tone * (0.8 + rng() * 0.25)];
      const a0 = rng() * Math.PI;
      const sway = scrub ? 0.07 : 0.12 + rng() * 0.1;
      const out = cards.at(x, z);
      for (let k = 0; k < 2; k += 1) {
        const a = a0 + k * (Math.PI / 2) + (rng() - 0.5) * 0.4;
        const cx = Math.cos(a) * w * 0.5;
        const cz = Math.sin(a) * w * 0.5;
        out.quad([x - cx, y, z - cz], [x + cx, y, z + cz], [x + cx, y + h, z + cz], [x - cx, y + h, z - cz], rect, tint, 1, [0, 1, 0], [0, 0, sway, sway]);
      }
      made += 1;
    };
    const wildAndCamps = [...wildLots, ...campLots, ...yardLots];
    let guard = 0;
    while (made < target && guard < target * 8) {
      guard += 1;
      const roll = rng();
      if (roll < 0.5) {
        // kerb lines: patches, not a hedge
        const seg = segs[Math.floor(rng() * segs.length)];
        const side = rng() < 0.5 ? 1 : -1;
        const t = seg.from + rng() * (seg.to - seg.from);
        const patchKey = Math.sin(Math.floor(t / 9) * 12.9898 + seg.k * 78.233 + seg.axis * 37.7 + side * 11.1) * 43758.5453;
        if (patchKey - Math.floor(patchKey) < 0.5) continue;
        const count = 1 + Math.floor(rng() * 3);
        for (let n = 0; n < count; n += 1) {
          const lat = side * (rng() < 0.5 ? 12.5 + rng() * 0.45 : 13.12 + rng() * 0.7);
          tuft(px(seg, lat, t + (rng() - 0.5) * 2.5), pz(seg, lat, t + (rng() - 0.5) * 2.5), false);
        }
      } else if (roll < 0.7 && faces.length > 0) {
        const face = faces[Math.floor(rng() * faces.length)];
        const off = (rng() - 0.5) * face.len;
        const d = 0.15 + rng() * 0.5;
        tuft(face.x - face.nz * off + face.nx * d, face.z + face.nx * off + face.nz * d, rng() < 0.15);
      } else if (roll < 0.9 && wildAndCamps.length > 0) {
        const lot = wildAndCamps[Math.floor(rng() * wildAndCamps.length)];
        const x = lot.x + (rng() - 0.5) * 32;
        const z = lot.z + (rng() - 0.5) * 32;
        tuft(x, z, rng() < 0.45);
        if (rng() < 0.5) tuft(x + (rng() - 0.5) * 1.5, z + (rng() - 0.5) * 1.5, false);
      } else {
        // cracks toward the edges of the carriageway and around tree pits
        if (treeSpots.length > 0 && rng() < 0.4) {
          const tree = treeSpots[Math.floor(rng() * treeSpots.length)];
          tuft(tree.x + (rng() - 0.5) * 2.2, tree.z + (rng() - 0.5) * 2.2, rng() < 0.3);
        } else {
          const seg = segs[Math.floor(rng() * segs.length)];
          const lat = (rng() < 0.5 ? 1 : -1) * (8 + rng() * 4.4);
          const t = seg.from + rng() * (seg.to - seg.from);
          tuft(px(seg, lat, t), pz(seg, lat, t), false);
        }
      }
    }
  }

  tally('weeds');
  // ------------------------------------------------------------------ 5. ground decals
  const steamVents: Disc[] = [];
  {
    const rng = createSeededRandom(1313);
    const scale = lowSpec ? 0.4 : 1;
    const roadSpot = (latMin: number, latMax: number): [Seg, number, number, number, number] => {
      const seg = segs[Math.floor(rng() * segs.length)];
      const lat = (rng() < 0.5 ? 1 : -1) * (latMin + rng() * (latMax - latMin));
      const t = seg.from + rng() * (seg.to - seg.from);
      return [seg, lat, t, px(seg, lat, t), pz(seg, lat, t)];
    };
    // wrecks leak, burn and leave skids
    for (const wreck of layout.wrecks) {
      if (rng() < 0.75) decal(rng() < 0.5 ? DECAL.oilA : DECAL.oilB, wreck.x + (rng() - 0.5), wreck.z + (rng() - 0.5), 3.5 + rng() * 2, 3.5 + rng() * 2, rng() * 6, 0.85);
      if (wreck.flag) decal(DECAL.scorchA, wreck.x, wreck.z, 8, 8, rng() * 6, 0.9);
      if (rng() < 0.5 * scale + 0.2) decal(DECAL.skidStraight, wreck.x - Math.sin(wreck.rot) * 7, wreck.z - Math.cos(wreck.rot) * 7, 3, 10, wreck.rot, 0.8);
      if (rng() < 0.4) decal(DECAL.glass, wreck.x, wreck.z, 5, 5, rng() * 6, 0.9);
    }
    for (const barrel of layout.barrels) decal(DECAL.scorchB, barrel.x, barrel.z, 3.2, 3.2, rng() * 6, 0.8);
    for (let n = 0; n < 130 * scale; n += 1) {
      const [seg, , , x, z] = roadSpot(1.5, 10.5);
      const along = seg.axis === 0 ? 0 : Math.PI / 2;
      if (rng() < 0.5) decal(DECAL.skidStraight, x, z, 2.8 + rng(), 9 + rng() * 7, along + (rng() - 0.5) * 0.3, 0.55 + rng() * 0.35);
      else decal(DECAL.skidArc, x, z, 7 + rng() * 3, 7 + rng() * 3, along + Math.floor(rng() * 4) * (Math.PI / 2), 0.55 + rng() * 0.35);
    }
    for (let n = 0; n < 50 * scale; n += 1) {
      const [, , , x, z] = roadSpot(0, 11);
      if (reserved(x, z, 4)) continue;
      const s = 5 + rng() * 8;
      decal(rng() < 0.6 ? DECAL.scorchA : DECAL.scorchB, x, z, s, s, rng() * 6, 0.75 + rng() * 0.2);
    }
    for (let n = 0; n < 110 * scale; n += 1) {
      const [, , , x, z] = roadSpot(0, 11.5);
      const s = 2.4 + rng() * 3;
      decal(DECAL.crack, x, z, s, s, rng() * 6, 0.8);
    }
    for (let n = 0; n < 90 * scale; n += 1) {
      const [, , , x, z] = roadSpot(1, 11);
      const s = 2.5 + rng() * 3.5;
      decal(rng() < 0.5 ? DECAL.oilA : DECAL.oilB, x, z, s, s * (0.6 + rng() * 0.5), rng() * 6, 0.6 + rng() * 0.3);
    }
    for (let n = 0; n < 150 * scale; n += 1) {
      const [, , , x, z] = roadSpot(13.6, 17.2);
      if (!free(x, z, 1.2)) continue;
      const s = 2.2 + rng() * 2;
      decal(rng() < 0.75 ? DECAL.paper : DECAL.glass, x, z, s, s, rng() * 6, 0.9);
    }
    // ash and debris swept against the kerbs: pale fans that read on the dark asphalt
    for (let n = 0; n < 230 * scale; n += 1) {
      const seg = segs[Math.floor(rng() * segs.length)];
      const side = rng() < 0.5 ? 1 : -1;
      const t = seg.from + rng() * (seg.to - seg.from);
      const depth = 2.2 + rng() * 2.6;
      const x = px(seg, side * (HALF_ROAD - 0.1 - depth / 2), t);
      const z = pz(seg, side * (HALF_ROAD - 0.1 - depth / 2), t);
      if (reserved(x, z, 0)) continue;
      decal(DECAL.apron, x, z, 6 + rng() * 9, depth, yawOf(seg, side, 0), 0.5 + rng() * 0.35);
    }
    // 止まれ at the stop lines (left-hand traffic)
    for (let k = 1; k < N; k += 1) {
      for (let j = 1; j < N; j += 1) {
        if (rng() > 0.4 * scale + 0.1) continue;
        const cx = roadCenter(k);
        const cz = roadCenter(j);
        const arm = Math.floor(rng() * 4);
        const d = HALF_ROAD + 9;
        if (arm === 0) decal(DECAL.stop, cx - 3.2, cz - d, 2.3, 6.5, 0, 0.75);
        else if (arm === 1) decal(DECAL.stop, cx + 3.2, cz + d, 2.3, 6.5, Math.PI, 0.75);
        else if (arm === 2) decal(DECAL.stop, cx - d, cz + 3.2, 2.3, 6.5, Math.PI / 2, 0.75);
        else decal(DECAL.stop, cx + d, cz - 3.2, 2.3, 6.5, -Math.PI / 2, 0.75);
      }
    }
    // chalk evacuation arrows in short runs, pointing away from the city centre
    for (let n = 0; n < 34 * scale; n += 1) {
      const [seg, lat, t] = roadSpot(13.8, 16.4);
      const dir = (seg.axis === 0 ? pz(seg, lat, t) : px(seg, lat, t)) >= 0 ? 1 : -1;
      const yaw = seg.axis === 0 ? (dir > 0 ? Math.PI : 0) : (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      for (let r = 0; r < 3; r += 1) {
        const x = px(seg, lat, t + dir * r * 7);
        const z = pz(seg, lat, t + dir * r * 7);
        if (free(x, z, 1) && !reserved(x, z, 0)) decal(DECAL.chalk, x, z, 1.7, 1.7, yaw + (rng() - 0.5) * 0.25, 0.85);
      }
    }
    // raider territory marks sprayed on the road around their camps
    for (const camp of campFires) {
      for (let n = 0; n < 5; n += 1) {
        const a = rng() * 6.28;
        const r = 22 + rng() * 26;
        decal(DECAL.fang, camp.x + Math.cos(a) * r, camp.z + Math.sin(a) * r, 3.6, 3.6, rng() * 6, 0.8);
      }
    }
    for (let n = 0; n < 14 * scale; n += 1) {
      const [, , , x, z] = roadSpot(2, 10);
      if (!reserved(x, z, 2)) decal(DECAL.fang, x, z, 3.4, 3.4, rng() * 6, 0.7);
    }
    // manholes; a few still breathe steam
    for (let n = 0; n < 46 * scale + 8; n += 1) {
      const [, , , x, z] = roadSpot(2.6, 9.5);
      if (!free(x, z, 1.5)) continue;
      if (!decal(DECAL.manhole, x, z, 1.1, 1.1, rng() * 6, 1)) continue;
      if (steamVents.length < (lowSpec ? 5 : 11) && !reserved(x, z, 6) && steamVents.every((v) => Math.hypot(v.x - x, v.z - z) > 90)) {
        steamVents.push({ x, z, r: 1 });
      }
    }
    // hazard beacons on the concrete barricades already blocking half-roads
    const hazardRng = createSeededRandom(1314);
    for (const barrier of layout.barriers) {
      if (barrier.y !== 0 || hazardRng() > 0.6 || reserved(barrier.x, barrier.z, 0)) continue;
      const phase = hazardRng();
      light.at(barrier.x, barrier.z).stamp(beacon, trs(barrier.x, 1.04, barrier.z, barrier.rot), null, phase);
      glow(barrier.x, 1.3, barrier.z, 1.5, PAL.amber, 3.2, -2, Math.min(0.99, phase));
    }
  }

  tally('decals');
  // ------------------------------------------------------------------ 4. neon that survived, and the signs waiting for power
  {
    const rng = createSeededRandom(1414);
    const palette: Rgb[] = [[0.1, 1.0, 0.84], [1.0, 0.08, 0.5], [1.0, 0.48, 0.07], [0.1, 1.0, 0.84], [1.0, 0.08, 0.5], [1.0, 0.14, 0.08]];
    const target = lowSpec ? 80 : 210;
    const order = shuffled(faces.filter((f) => !f.used), rng).sort((a, b) => Number(onRoute(b.x, b.z)) - Number(onRoute(a.x, a.z)));
    let made = 0;
    let alive = 0;
    const sign = (a: number[], b: number[], c: number[], d: number[], rect: readonly number[], color: Rgb, seed: number, threshold: number, intensity: number): void => {
      neon.quad(a, b, c, d, rect, color);
      for (let v = 0; v < 4; v += 1) {
        const at = (neon.vertexCount - 4 + v) * 3;
        neon.fx[at] = seed;
        neon.fx[at + 1] = threshold;
        neon.fx[at + 2] = intensity;
      }
      made += 1;
    };
    for (const face of order) {
      if (made >= target) break;
      if (reserved(face.x, face.z, 0) || tallBlocked(face.x + face.nx * 2, face.z + face.nz * 2)) continue;
      const route = onRoute(face.x, face.z);
      if (!route && rng() < 0.45) continue;
      const tx = -face.nz;
      const tz = face.nx;
      const spots = route ? 1 + Math.floor(rng() * 2) : 1;
      for (let n = 0; n < spots && made < target; n += 1) {
        // blade stacks hang near the corners where both streets see them
        const corner = rng() < 0.6;
        const off = corner ? (rng() < 0.5 ? 1 : -1) * (face.len / 2 - 1.5 - rng() * 3) : (rng() - 0.5) * (face.len - 8);
        const wx = face.x + tx * off;
        const wz = face.z + tz * off;
        // roughly one in five burns from the start on the route; the rest wait for the relay
        const startsLit = rng() < (route ? 0.22 : 0.07);
        const blade = face.h > 8.5 && rng() < 0.66;
        if (blade) {
          const w = 1.25;
          const h = 4.5;
          const tiers = Math.max(1, Math.min(1 + Math.floor(rng() * 3), Math.floor((face.h - 3.2) / (h + 0.35))));
          const ix = wx + face.nx * 0.4;
          const iz = wz + face.nz * 0.4;
          const oxp = wx + face.nx * (0.4 + w);
          const ozp = wz + face.nz * (0.4 + w);
          const e = 0.09;
          const s = light.at(wx, wz);
          for (let tier = 0; tier < tiers; tier += 1) {
            const y0 = CURB + 3.3 + tier * (h + 0.35);
            const rect = SIGN.neonV[Math.floor(rng() * SIGN.neonV.length)];
            const color = palette[Math.floor(rng() * palette.length)];
            const lit = startsLit && rng() < 0.75;
            const threshold = lit ? 0 : 0.1 + rng() * 0.82;
            const seed = rng();
            const intensity = 3.8 + rng() * 2.2;
            if (lit) {
              alive += 1;
              mark('neonLit', wx, wz);
            }
            sign([ix + tx * e, y0, iz + tz * e], [oxp + tx * e, y0, ozp + tz * e], [oxp + tx * e, y0 + h, ozp + tz * e], [ix + tx * e, y0 + h, iz + tz * e], rect, color, seed, threshold, intensity);
            sign([oxp - tx * e, y0, ozp - tz * e], [ix - tx * e, y0, iz - tz * e], [ix - tx * e, y0 + h, iz - tz * e], [oxp - tx * e, y0 + h, ozp - tz * e], rect, color, seed, threshold, intensity);
            s.box(wx + face.nx * (0.4 + w / 2), y0 + h / 2, wz + face.nz * (0.4 + w / 2), 0.15, h + 0.16, w + 0.12, PAL.soot, Math.atan2(tx, tz));
            glow(wx + face.nx * 2.0, y0 + h / 2, wz + face.nz * 2.0, 6.5, color, 0.5, threshold, seed, 0.6);
          }
          const top = CURB + 3.3 + tiers * (h + 0.35);
          for (const off2 of [-0.07, 0.07]) s.beam(wx + tx * off2, CURB + 3.1, wz + tz * off2, wx + tx * off2 + face.nx * 0.42, top, wz + tz * off2 + face.nz * 0.42, 0.08, PAL.steel, 3);
        } else {
          const rect = SIGN.neonH[Math.floor(rng() * SIGN.neonH.length)];
          const color = palette[Math.floor(rng() * palette.length)];
          const threshold = startsLit ? 0 : 0.1 + rng() * 0.82;
          const seed = rng();
          const w = 6.4;
          const h = 1.8;
          const y0 = CURB + Math.min(face.h - 2.1, 3.4 + rng() * 1.8);
          const cx = wx + face.nx * 0.18;
          const cz = wz + face.nz * 0.18;
          if (startsLit) {
            alive += 1;
            mark('neonLit', wx, wz);
          }
          sign(
            [cx + tx * w * 0.5, y0, cz + tz * w * 0.5], [cx - tx * w * 0.5, y0, cz - tz * w * 0.5],
            [cx - tx * w * 0.5, y0 + h, cz - tz * w * 0.5], [cx + tx * w * 0.5, y0 + h, cz + tz * w * 0.5], rect, color, seed, threshold, 3.8 + rng() * 2.2,
          );
          light.at(wx, wz).box(wx + face.nx * 0.08, y0 + h / 2, wz + face.nz * 0.08, w + 0.2, h + 0.2, 0.16, PAL.soot, Math.atan2(face.nx, face.nz));
          glow(wx + face.nx * 2.0, y0 + h / 2, wz + face.nz * 2.0, 7.5, color, 0.5, threshold, seed, 0.6);
        }
      }
    }
    // guarantee a handful of live signs even on an unlucky seed
    for (let v = 0; v < neon.vertexCount && alive < 6; v += 4) {
      if (neon.fx[v * 3 + 1] > 0.5) {
        for (let c = 0; c < 4; c += 1) neon.fx[(v + c) * 3 + 1] = 0;
        alive += 1;
      }
    }
  }

  tally('neon');
  // ------------------------------------------------------------------ 4. bunting between lamp posts, string lights across alleys
  {
    const rng = createSeededRandom(1515);
    const flagColors: Rgb[] = [[0.16, 0.26, 0.5], [0.6, 0.58, 0.52], [0.5, 0.1, 0.07], [0.14, 0.34, 0.16], [0.6, 0.45, 0.1]];
    const line = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, sag: number, flags: boolean, bulbs: boolean): void => {
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      const steps = Math.max(6, Math.round(len / 2.2));
      const out = cards.at((ax + bx) / 2, (az + bz) / 2);
      const point = (t: number): [number, number, number] => [ax + (bx - ax) * t, ay + (by - ay) * t - Math.sin(t * Math.PI) * sag, az + (bz - az) * t];
      for (let n = 0; n < steps; n += 1) {
        const p = point(n / steps);
        const q = point((n + 1) / steps);
        const s0 = Math.sin((n / steps) * Math.PI) * 0.1;
        const s1 = Math.sin(((n + 1) / steps) * Math.PI) * 0.1;
        out.quad([p[0], p[1] - 0.035, p[2]], [q[0], q[1] - 0.035, q[2]], [q[0], q[1] + 0.035, q[2]], [p[0], p[1] + 0.035, p[2]], CARD.solid, [0.03, 0.03, 0.03], 1, [0, 1, 0], [s0, s1, s1, s0]);
      }
      const items = Math.floor(len / (flags ? 0.95 : 1.5));
      for (let n = 1; n < items; n += 1) {
        const t = n / items;
        const p = point(t);
        const sw = Math.sin(t * Math.PI) * 0.1;
        if (flags) {
          if (rng() < 0.22) continue;
          const q = point(t + 0.45 / len);
          const drop = 0.55 + rng() * 0.35;
          out.quad([p[0], p[1] - drop, p[2]], [q[0], q[1] - drop, q[2]], [q[0], q[1], q[2]], [p[0], p[1], p[2]], CARD.rag[Math.floor(rng() * 4)], flagColors[Math.floor(rng() * flagColors.length)], 1, [0, 1, 0], [sw + 0.22, sw + 0.22, sw, sw]);
        }
        if (bulbs) {
          const startsLit = rng() < 0.22;
          glow(p[0], p[1] - 0.12, p[2], 0.75, [1.0, 0.62, 0.25], 2.6, startsLit ? 0 : 0.15 + rng() * 0.6, rng(), 0.8);
        }
      }
    };
    // zig-zag bunting down a few avenues, strung from the standing lamp posts
    const standing = layout.lamps.filter((l) => l.scale === 0);
    const runs = lowSpec ? 3 : 7;
    const order = shuffled(segs.filter((s) => !isHighway(s) && s.k > 0 && s.k < N), rng);
    let made = 0;
    for (const seg of order) {
      if (made >= runs) break;
      const posts = standing
        .filter((l) => (seg.axis === 0 ? Math.abs(l.x - seg.c) < 16 && l.z > seg.from && l.z < seg.to : Math.abs(l.z - seg.c) < 16 && l.x > seg.from && l.x < seg.to))
        .sort((a, b) => (seg.axis === 0 ? a.z - b.z : a.x - b.x));
      if (posts.length < 3) continue;
      if (posts.some((p) => reserved(p.x, p.z, 6) || tallBlocked(p.x, p.z))) continue;
      made += 1;
      mark('bunting', posts[0].x, posts[0].z);
      for (let n = 0; n + 1 < posts.length; n += 1) {
        const a = posts[n];
        const b = posts[n + 1];
        line(a.x, a.y + 8.1, a.z, b.x, b.y + 8.1, b.z, 1.2 + rng() * 0.8, true, rng() < 0.4);
      }
    }
    for (const alley of alleyLines) {
      const y = CURB + 4.6 + rng() * 1.6;
      line(alley.ax, y, alley.az, alley.bx, y + (rng() - 0.5) * 0.8, alley.bz, 0.5 + rng() * 0.5, rng() < 0.45, true);
    }
  }

  tally('lines');
  // ------------------------------------------------------------------ 3. atmospherics
  const plumeSites: { x: number; y: number; z: number; w: number }[] = [];
  {
    const rng = createSeededRandom(1717);
    const towers = shuffled(layout.facades.filter((f) => !f.rotZ && !f.rotX && f.y + f.sy / 2 > 55 && f.sx > 14 && f.sz > 14), rng);
    const want = lowSpec ? 4 : 6;
    for (const f of towers) {
      if (plumeSites.length >= want) break;
      if (Math.hypot(f.x - relay.x, f.z - relay.z) < 130 || Math.hypot(f.x - start.x, f.z - start.z) < 110) continue;
      if (plumeSites.some((p) => Math.hypot(p.x - f.x, p.z - f.z) < 260)) continue;
      plumeSites.push({ x: f.x, y: f.y + f.sy / 2, z: f.z, w: Math.min(f.sx, f.sz) });
    }
    // two more beyond the grid so the horizon burns too
    const far = shuffled(layout.farTowers.filter((f) => f.sy > 60 && Math.hypot(f.x, f.z) < CITY_HALF + 420), rng);
    for (const f of far) {
      if (plumeSites.length >= want + 2) break;
      if (plumeSites.some((p) => Math.hypot(p.x - f.x, p.z - f.z) < 380)) continue;
      plumeSites.push({ x: f.x, y: f.sy, z: f.z, w: Math.min(f.sx, f.sz) });
    }
    for (const site of plumeSites) {
      mark('plume', site.x, site.z);
      const h = 330 + rng() * 170;
      const w = site.w * (0.7 + rng() * 0.3);
      const lean = 0.34 + rng() * 0.26;
      const tone = 0.032 + rng() * 0.02;
      fx.add(0, site.x, site.y - 4, site.z, w, w * 4.6, h, lean, 0, rng(), 1.0, [tone, tone * 0.95, tone], 0.82, 0, 0, 0, 8);
      fx.add(0, site.x + windX * 5, site.y + 6, site.z + windZ * 5, w * 0.6, w * 3.0, h * 0.72, lean * 1.25, 0, rng(), 1.5, [tone * 1.5, tone * 1.35, tone * 1.3], 0.6, 0, 0, 0, 8);
      // the fire itself: visible from across the city, feeds the bloom
      fx.add(1, site.x, site.y - 2, site.z, w * 0.9, w * 0.3, w * 0.85, 0.12, 0, rng(), 0, [1, 1, 1], 1.1);
      fx.add(1, site.x + w * 0.2, site.y - 2, site.z - w * 0.15, w * 0.5, w * 0.2, w * 0.6, 0.16, 0, rng(), 0, [1, 0.85, 0.7], 0.9);
      glow(site.x, site.y + 4, site.z, w * 2.6, [1.0, 0.38, 0.1], 0.8, -3, rng());
    }
  }
  {
    const rng = createSeededRandom(1818);
    // dust banks rolling through intersections
    const banks = lowSpec ? 4 : 9;
    let made = 0;
    for (let n = 0; n < 200 && made < banks; n += 1) {
      const cx = roadCenter(1 + Math.floor(rng() * (N - 1)));
      const cz = roadCenter(1 + Math.floor(rng() * (N - 1)));
      if (Math.hypot(cx - start.x, cz - start.z) < 120 || Math.hypot(cx - relay.x, cz - relay.z) < 90) continue;
      if (plumeSites.length > 0 && rng() < 0.2) continue;
      made += 1;
      mark('dustBank', cx, cz);
      const puffs = lowSpec ? 3 : 5;
      for (let p = 0; p < puffs; p += 1) {
        const ox = cx + (rng() - 0.5) * 30 - windX * 30;
        const oz = cz + (rng() - 0.5) * 30 - windZ * 30;
        const travel = 55 + rng() * 25;
        fxNear.add(0, ox, 0.1, oz, 26 + rng() * 14, 34 + rng() * 14, 6 + rng() * 5, 0.2, 0.028 + rng() * 0.022, rng(), 0.55, [0.36, 0.27, 0.19], 0.26, windX * travel, 0, windZ * travel, 2);
      }
    }
    // steam from manholes
    for (const vent of steamVents) {
      mark('steamVent', vent.x, vent.z);
      for (let p = 0; p < 3; p += 1) {
        fxNear.add(0, vent.x, 0.02, vent.z, 1.3, 3.8, 3.2 + rng() * 0.9, 0.5, 0.11 + rng() * 0.05, p / 3 + rng() * 0.1, 0.45, [0.36, 0.33, 0.3], 0.27, windX * 2.4, 0.7 + rng() * 0.5, windZ * 2.4, 2);
      }
    }
  }

  tally('atmos');
  // ------------------------------------------------------------------ build meshes
  const propMaterial = createPropMaterial(uniforms);
  const cardMaterial = createCardMaterial(uniforms, cardAtlas);
  const signMaterial = createSignMaterial(signAtlas);
  const decalMaterial = createDecalMaterial(decalAtlas);
  const neonMaterial = createNeonMaterial(uniforms, signAtlas);
  const fxMaterial = createFxMaterial(uniforms, noise);
  disposables.push(propMaterial, cardMaterial, signMaterial, decalMaterial, neonMaterial, fxMaterial);

  const addMesh = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string, cast: boolean, receive: boolean, order = 0): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.renderOrder = order;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    disposables.push(geometry);
    return mesh;
  };

  let triangles = 0;
  if (heavy.triangleCount > 0) {
    // one mesh for every shadow caster: split, it would only add shadow-pass draws
    addMesh(heavy.toGeometry({ fx: true, pad: 2 }), propMaterial, 'dressAnchors', true, true);
    triangles += heavy.triangleCount * 2;
  }
  light.soups.forEach((soup, i) => {
    if (soup.triangleCount === 0) return;
    addMesh(soup.toGeometry({ fx: true, pad: 2 }), propMaterial, `dressProps${i}`, false, true);
    triangles += soup.triangleCount;
  });
  cards.soups.forEach((soup, i) => {
    if (soup.triangleCount === 0) return;
    addMesh(soup.toGeometry({ uv: true, fx: true, pad: 2 }), cardMaterial, `dressCards${i}`, false, true);
    triangles += soup.triangleCount;
  });
  decals.soups.forEach((soup, i) => {
    if (soup.triangleCount === 0) return;
    addMesh(soup.toGeometry({ uv: true, alpha: true }), decalMaterial, `dressDecals${i}`, false, true, 1);
    triangles += soup.triangleCount;
  });
  if (signs.triangleCount > 0) {
    addMesh(signs.toGeometry({ uv: true }), signMaterial, 'dressSigns', false, true);
    triangles += signs.triangleCount;
  }
  if (neon.triangleCount > 0) {
    addMesh(neon.toGeometry({ uv: true, fx: true }), neonMaterial, 'dressNeon', false, false);
    triangles += neon.triangleCount;
  }
  // far sprites first, then near smoke so street-level dust layers over distant fire
  for (const [batch, name, order] of [[fx, 'dressFxFar', 3], [fxNear, 'dressFxNear', 4]] as const) {
    if (batch.triangleCount === 0) continue;
    const mesh = addMesh(batch.toGeometry(), fxMaterial, name, false, false, order);
    mesh.frustumCulled = false;
    triangles += batch.triangleCount;
  }

  if (wirePoints.length > 0) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wirePoints), 3));
    g.computeBoundingSphere();
    const material = new THREE.LineBasicMaterial({ color: '#0b0a0a' });
    const lines = new THREE.LineSegments(g, material);
    lines.name = 'dressWires';
    lines.matrixAutoUpdate = false;
    group.add(lines);
    disposables.push(g, material);
  }

  // ------------------------------------------------------------------ crows
  {
    const rng = createSeededRandom(1919);
    const flocks: { x: number; y: number; z: number; r: number; n: number }[] = [];
    // one flock wheels over the fallen tower, another over the tallest ruin
    const lean = layout.facades.find((f) => f.rotZ);
    if (lean) flocks.push({ x: lean.x + 10, y: lean.y + 34, z: lean.z, r: 46, n: lowSpec ? 16 : 26 });
    if (!lowSpec) {
      let tallest = layout.facades[0];
      for (const f of layout.facades) if (!f.rotZ && f.y + f.sy / 2 > tallest.y + tallest.sy / 2 && Math.hypot(f.x - relay.x, f.z - relay.z) < 420) tallest = f;
      flocks.push({ x: tallest.x, y: tallest.y + tallest.sy / 2 + 16, z: tallest.z, r: 38, n: 22 });
      if (plumeSites.length > 0) flocks.push({ x: plumeSites[0].x - windX * 60, y: plumeSites[0].y + 30, z: plumeSites[0].z - windZ * 60, r: 52, n: 14 });
    }
    const total = flocks.reduce((sum, f) => sum + f.n, 0);
    if (total > 0) {
      const g = new THREE.InstancedBufferGeometry();
      // flat bird: x = span, z = nose
      const verts = [
        0, 0, 0.55, -0.12, 0, 0.05, 0.12, 0, 0.05, // head
        -0.12, 0, 0.05, 0, 0, -0.6, 0.12, 0, 0.05, // body + tail
        -0.1, 0, 0.3, -0.1, 0, -0.15, -0.62, 0, 0.22, -0.58, 0, -0.2, -1.15, 0, -0.08, // left wing
        0.1, 0, 0.3, 0.1, 0, -0.15, 0.62, 0, 0.22, 0.58, 0, -0.2, 1.15, 0, -0.08, // right wing
      ];
      const wing = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 1, 0, 0, 0.5, 0.5, 1];
      const index = [0, 1, 2, 3, 4, 5, 6, 7, 8, 7, 9, 8, 8, 9, 10, 11, 13, 12, 12, 13, 14, 13, 15, 14];
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      g.setAttribute('aWing', new THREE.BufferAttribute(new Float32Array(wing), 1));
      g.setIndex(index);
      const orbit = new Float32Array(total * 4);
      const bird = new Float32Array(total * 4);
      let o = 0;
      for (const flock of flocks) {
        for (let n = 0; n < flock.n; n += 1) {
          orbit.set([flock.x + (rng() - 0.5) * 24, flock.y + (rng() - 0.5) * 26, flock.z + (rng() - 0.5) * 24, flock.r * (0.45 + rng() * 0.75)], o * 4);
          const dir = rng() < 0.82 ? 1 : -1;
          bird.set([dir * (0.16 + rng() * 0.12), rng() * Math.PI * 2, 0.8 + rng() * 0.5, 7 + rng() * 3], o * 4);
          o += 1;
        }
      }
      g.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit, 4));
      g.setAttribute('aBird', new THREE.InstancedBufferAttribute(bird, 4));
      g.instanceCount = total;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000);
      const material = createCrowMaterial(uniforms);
      const mesh = addMesh(g, material, 'dressCrows', false, false);
      mesh.frustumCulled = false;
      disposables.push(material);
      triangles += total * 8;
    }
  }

  // ------------------------------------------------------------------ windblown paper around the camera
  {
    const rng = createSeededRandom(2020);
    const count = lowSpec ? 44 : 120;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i += 1) seeds[i] = rng();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = count;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000);
    const material = createPaperMaterial(uniforms);
    const mesh = addMesh(g, material, 'dressPaper', false, false);
    mesh.frustumCulled = false;
    disposables.push(material);
    triangles += count * 2;
  }

  group.userData.stats = { triangles, meshes: group.children.length, colliders: colliders.length, families };
  group.userData.landmarks = landmarks;

  return {
    group,
    colliders,
    update(time: number): void {
      uniforms.uTime.value = time;
    },
    dispose(): void {
      for (const item of disposables) item.dispose();
    },
  };
}
