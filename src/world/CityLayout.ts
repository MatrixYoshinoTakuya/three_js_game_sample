import { createSeededRandom } from '../utils/random';

/**
 * Deterministic data-only description of the ruined city. CityBuilder turns it
 * into instanced meshes; gameplay uses the colliders and road graph directly.
 */

export const CITY = {
  blocksPerSide: 10,
  pitch: 110,
  roadWidth: 26,
  blockSize: 84,
  curbHeight: 0.22,
  floorHeight: 3.6,
} as const;

export const CITY_HALF = (CITY.blocksPerSide * CITY.pitch) / 2;
export const PLAY_HALF = CITY_HALF + CITY.roadWidth / 2 - 1.5;

export type InstanceBox = {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  /** Facade style 0..3 or material slot depending on the list. */
  style: number;
  /** 0..1 per-building tint/variation seed. */
  tint: number;
};

/** `soft` boxes (street wrecks) can be ploughed through by a fast, heavy hit instead of stopping the car dead. */
export type Aabb = { minX: number; maxX: number; minZ: number; maxZ: number; soft?: boolean };

export type PropPlacement = { x: number; y: number; z: number; rot: number; scale: number; variant: number; flag: boolean };

export type Cable = { ax: number; ay: number; az: number; bx: number; by: number; bz: number; sag: number };

export type CityLayout = {
  facades: InstanceBox[];
  frames: InstanceBox[];
  roofProps: InstanceBox[];
  slabs: InstanceBox[];
  highway: InstanceBox[];
  farTowers: InstanceBox[];
  colliders: Aabb[];
  lamps: PropPlacement[];
  wrecks: PropPlacement[];
  rubble: PropPlacement[];
  barriers: PropPlacement[];
  barrels: PropPlacement[];
  billboards: PropPlacement[];
  cables: Cable[];
  relay: { x: number; z: number };
  start: { x: number; z: number; heading: number };
  roadCenters: number[];
};

export function roadCenter(k: number): number {
  return (k - CITY.blocksPerSide / 2) * CITY.pitch;
}

export function blockCenter(i: number): number {
  return (i + 0.5 - CITY.blocksPerSide / 2) * CITY.pitch;
}

export const RELAY_BLOCK = { i: 6, j: 7 };
const LEAN_BLOCK = { i: 3, j: 3 };
const CATCH_BLOCK = { i: 4, j: 3 };
const HIGHWAY_ROAD = 5;

/** Height of the drivable ground: 0 on asphalt, curb height on blocks with a short ramp. */
export function groundHeight(x: number, z: number): number {
  const dx = distanceToRoadEdge(x);
  const dz = distanceToRoadEdge(z);
  const inside = Math.min(dx, dz);
  if (inside <= 0) return 0;
  const t = Math.min(1, inside / 0.7);
  return CITY.curbHeight * t * t * (3 - 2 * t);
}

/** Positive when the coordinate is inside a block (distance from the road edge), negative on the road. */
function distanceToRoadEdge(v: number): number {
  if (Math.abs(v) > CITY_HALF + CITY.roadWidth / 2) return -1;
  const local = ((((v + CITY_HALF) % CITY.pitch) + CITY.pitch) % CITY.pitch);
  const fromRoad = Math.min(local, CITY.pitch - local);
  return fromRoad - CITY.roadWidth / 2;
}

export function generateCity(seed: number): CityLayout {
  const rng = createSeededRandom(seed);
  const range = (min: number, max: number) => min + (max - min) * rng();
  const chance = (p: number) => rng() < p;
  const pick = (n: number) => Math.floor(rng() * n);

  const layout: CityLayout = {
    facades: [],
    frames: [],
    roofProps: [],
    slabs: [],
    highway: [],
    farTowers: [],
    colliders: [],
    lamps: [],
    wrecks: [],
    rubble: [],
    barriers: [],
    barrels: [],
    billboards: [],
    cables: [],
    relay: { x: blockCenter(RELAY_BLOCK.i), z: blockCenter(RELAY_BLOCK.j) },
    start: { x: roadCenter(2) + 5, z: -470, heading: 0 },
    roadCenters: [],
  };
  for (let k = 0; k <= CITY.blocksPerSide; k += 1) layout.roadCenters.push(roadCenter(k));

  const N = CITY.blocksPerSide;
  const curb = CITY.curbHeight;
  const roofHeights: { x: number; z: number; h: number; hw: number; hd: number }[] = [];

  const addCollider = (x: number, z: number, hw: number, hd: number, soft = false) => {
    if (soft) layout.colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd, soft: true });
    else layout.colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd });
  };

  const addRubblePile = (x: number, z: number, radius: number, count: number) => {
    for (let n = 0; n < count; n += 1) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * radius;
      const s = range(0.5, 2.4) * (1 - r / (radius * 1.6));
      layout.rubble.push({
        x: x + Math.cos(a) * r,
        y: groundHeight(x + Math.cos(a) * r, z + Math.sin(a) * r) + s * 0.25,
        z: z + Math.sin(a) * r,
        rot: rng() * 6.28,
        scale: Math.max(0.35, s),
        variant: pick(3),
        flag: false,
      });
    }
  };

  const addRoofKit = (x: number, z: number, top: number, w: number, d: number, tint: number) => {
    // parapet ring
    const p = 0.9;
    layout.roofProps.push({ x, y: top + p / 2, z: z - d / 2 + 0.3, sx: w, sy: p, sz: 0.6, style: 0, tint });
    layout.roofProps.push({ x, y: top + p / 2, z: z + d / 2 - 0.3, sx: w, sy: p, sz: 0.6, style: 0, tint });
    layout.roofProps.push({ x: x - w / 2 + 0.3, y: top + p / 2, z, sx: 0.6, sy: p, sz: d, style: 0, tint });
    layout.roofProps.push({ x: x + w / 2 - 0.3, y: top + p / 2, z, sx: 0.6, sy: p, sz: d, style: 0, tint });
    const units = 1 + pick(3);
    for (let n = 0; n < units; n += 1) {
      const ux = x + range(-0.3, 0.3) * w;
      const uz = z + range(-0.3, 0.3) * d;
      const kind = pick(3);
      if (kind === 0) {
        // mechanical penthouse
        const s = range(4, Math.min(11, w * 0.4));
        layout.roofProps.push({ x: ux, y: top + 2.2, z: uz, sx: s, sy: 4.4, sz: s * range(0.6, 1), style: 1, tint });
      } else if (kind === 1) {
        // water tank on legs
        layout.roofProps.push({ x: ux, y: top + 3.6, z: uz, sx: 3.4, sy: 3.4, sz: 3.4, style: 2, tint });
        layout.roofProps.push({ x: ux, y: top + 1, z: uz, sx: 2.6, sy: 2, sz: 2.6, style: 1, tint });
      } else {
        // antenna mast
        const h = range(9, 26);
        layout.roofProps.push({ x: ux, y: top + h / 2, z: uz, sx: 0.45, sy: h, sz: 0.45, style: 1, tint });
        layout.roofProps.push({ x: ux, y: top + h * 0.62, z: uz, sx: 3.2, sy: 0.25, sz: 0.25, style: 1, tint });
        layout.roofProps.push({ x: ux, y: top + h * 0.8, z: uz, sx: 2, sy: 0.25, sz: 0.25, style: 1, tint });
      }
    }
  };

  const addSkeleton = (x: number, z: number, base: number, w: number, d: number, floors: number, tint: number) => {
    const fh = CITY.floorHeight;
    const nx = Math.max(2, Math.round(w / 9));
    const nz = Math.max(2, Math.round(d / 9));
    let keep = 1;
    for (let f = 0; f < floors; f += 1) {
      const y = base + f * fh;
      keep *= range(0.62, 0.92);
      // which quadrant survives shrinks as we go up
      const sw = w * Math.max(0.3, keep);
      const sd = d * Math.max(0.35, keep + range(-0.1, 0.15));
      const ox = (w - sw) / 2 * (tint > 0.5 ? 1 : -1);
      const oz = (d - sd) / 2 * (tint * 7 % 1 > 0.5 ? 1 : -1);
      layout.frames.push({ x: x + ox, y: y + fh - 0.2, z: z + oz, sx: sw, sy: 0.4, sz: sd, style: 0, tint });
      for (let cx = 0; cx <= nx; cx += 1) {
        for (let cz = 0; cz <= nz; cz += 1) {
          if (cx !== 0 && cx !== nx && cz !== 0 && cz !== nz) continue;
          const px = x - w / 2 + (w / nx) * cx;
          const pz = z - d / 2 + (d / nz) * cz;
          if (Math.abs(px - (x + ox)) > sw / 2 + 0.2 || Math.abs(pz - (z + oz)) > sd / 2 + 0.2) {
            if (chance(0.8)) continue;
          }
          const broken = chance(0.2) ? range(0.3, 0.8) : 1;
          layout.frames.push({
            x: px, y: y + (fh * broken) / 2, z: pz,
            sx: 0.75, sy: fh * broken, sz: 0.75,
            rotZ: broken < 1 ? range(-0.12, 0.12) : 0,
            style: 0, tint,
          });
        }
      }
    }
  };

  const addBuilding = (x: number, z: number, w: number, d: number, h: number, allowRuin: boolean) => {
    const tint = rng();
    const style = pick(4);
    const base = curb;
    const kind = rng();
    let top = base + h;
    let topW = w;
    let topD = d;
    addCollider(x, z, w / 2, d / 2);

    // street-level podium band reads as storefronts / lobby
    const podiumH = Math.min(h * 0.3, range(7, 13));
    layout.facades.push({ x, y: base + podiumH / 2, z, sx: w, sy: podiumH, sz: d, style: 3 - (style % 2), tint });
    layout.roofProps.push({ x, y: base + podiumH + 0.3, z, sx: w + 1.0, sy: 0.6, sz: d + 1.0, style: 0, tint });

    const bodyBase = base + podiumH;
    const bodyH = h - podiumH;
    const ruin = allowRuin && h > 55 && chance(0.34);
    const ruinCut = ruin ? range(0.55, 0.82) : 1;

    if (kind < 0.38 && h > 60) {
      // stepped setbacks
      const tiers = 2 + pick(2);
      let y = bodyBase;
      let tw = w - range(1, 3);
      let td = d - range(1, 3);
      for (let t = 0; t < tiers; t += 1) {
        const th = (bodyH * ruinCut) * (t === tiers - 1 ? 1 - (tiers - 1) * 0.3 : 0.3);
        layout.facades.push({ x, y: y + th / 2, z, sx: tw, sy: th, sz: td, style, tint });
        y += th;
        if (t < tiers - 1) {
          layout.roofProps.push({ x, y: y + 0.25, z, sx: tw + 0.8, sy: 0.5, sz: td + 0.8, style: 0, tint });
          tw *= range(0.68, 0.86);
          td *= range(0.68, 0.86);
        }
      }
      top = y;
      topW = tw;
      topD = td;
    } else if (kind < 0.55 && w > 40) {
      // twin towers on a shared podium
      const tw = w * 0.4;
      for (const side of [-1, 1]) {
        const th = bodyH * ruinCut * (side < 0 ? 1 : range(0.6, 0.9));
        const tx = x + side * (w / 2 - tw / 2 - 1.5);
        layout.facades.push({ x: tx, y: bodyBase + th / 2, z, sx: tw, sy: th, sz: d - 4, style, tint: (tint + side * 0.07 + 1) % 1 });
        if (side < 0) {
          top = bodyBase + th;
          topW = tw;
          topD = d - 4;
          roofHeights.push({ x: tx, z, h: top, hw: tw / 2, hd: (d - 4) / 2 });
        } else {
          addRoofKit(tx, z, bodyBase + th, tw, d - 4, tint);
        }
      }
      // sky bridge
      layout.roofProps.push({ x, y: bodyBase + bodyH * 0.42, z, sx: w * 0.3, sy: 3.2, sz: 6, style: 1, tint });
      x -= w / 2 - tw / 2 - 1.5;
    } else {
      // slab tower with vertical fins and cornice bands
      const tw = w - range(1.5, 4);
      const td = d - range(1.5, 4);
      const th = bodyH * ruinCut;
      layout.facades.push({ x, y: bodyBase + th / 2, z, sx: tw, sy: th, sz: td, style, tint });
      const bands = Math.floor(th / range(26, 40));
      for (let b = 1; b <= bands; b += 1) {
        const by = bodyBase + (th / (bands + 1)) * b;
        layout.roofProps.push({ x, y: by, z, sx: tw + 0.7, sy: 0.7, sz: td + 0.7, style: 0, tint });
      }
      if (chance(0.5)) {
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            layout.roofProps.push({
              x: x + sx * (tw / 2 + 0.2), y: bodyBase + th / 2, z: z + sz * (td / 2 + 0.2),
              sx: 1.4, sy: th, sz: 1.4, style: 0, tint,
            });
          }
        }
      }
      top = bodyBase + th;
      topW = tw;
      topD = td;
    }

    if (ruin) {
      const floors = 3 + pick(5);
      addSkeleton(x, z, top, topW, topD, floors, tint);
      addRubblePile(x + range(-1, 1) * w * 0.4, z + (chance(0.5) ? 1 : -1) * (d / 2 + range(2, 7)), range(5, 9), 14 + pick(10));
    } else {
      addRoofKit(x, z, top, topW, topD, tint);
      if (chance(0.16) && h > 40) {
        layout.billboards.push({ x, y: top + 1, z, rot: pick(4) * (Math.PI / 2), scale: range(0.9, 1.4), variant: pick(4), flag: false });
      }
    }
    roofHeights.push({ x, z, h: top, hw: topW / 2, hd: topD / 2 });
  };

  // ------------------------------------------------------------ blocks
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const cx = blockCenter(i);
      const cz = blockCenter(j);
      const isRelay = i === RELAY_BLOCK.i && j === RELAY_BLOCK.j;
      layout.slabs.push({ x: cx, y: curb / 2 - 0.4, z: cz, sx: CITY.blockSize, sy: curb + 0.8, sz: CITY.blockSize, style: isRelay ? 1 : 0, tint: rng() });
      if (isRelay) continue;

      const centerDist = Math.hypot(cx, cz) / CITY_HALF;
      const downtown = Math.max(0, 1 - centerDist * 0.95);
      const baseH = 34 + downtown * 150;
      const usable = CITY.blockSize - 10;

      if (i === LEAN_BLOCK.i && j === LEAN_BLOCK.j) {
        // The fallen tower: a landmark leaning over the avenue onto its neighbour.
        const lean = 0.42;
        const h = 178;
        const bx = cx + 22;
        layout.facades.push({
          x: bx + Math.sin(lean) * (h / 2), y: Math.cos(lean) * (h / 2) - 3, z: cz - 6,
          sx: 30, sy: h, sz: 34, rotZ: -lean, style: 1, tint: 0.31,
        });
        addCollider(bx, cz - 6, 17, 18);
        addBuilding(cx - 24, cz + 16, 28, 40, 64, false);
        addBuilding(cx - 22, cz - 26, 30, 26, 46, false);
        addRubblePile(bx + 18, cz - 6, 13, 46);
        addRubblePile(bx - 4, cz + 20, 8, 20);
        continue;
      }
      if (i === CATCH_BLOCK.i && j === CATCH_BLOCK.j) {
        addBuilding(cx - 16, cz - 6, 44, 46, 128, false);
        addBuilding(cx + 26, cz + 18, 22, 30, 52, false);
        addBuilding(cx + 24, cz - 24, 24, 26, 70, true);
        continue;
      }

      const split = rng();
      if (split < 0.24) {
        const w = usable - range(0, 14);
        const d = usable - range(0, 14);
        addBuilding(cx, cz, w, d, baseH * range(0.9, 1.35), true);
      } else if (split < 0.62) {
        const alongX = chance(0.5);
        const ratio = range(0.38, 0.62);
        const a = usable * ratio - 3;
        const b = usable * (1 - ratio) - 3;
        if (alongX) {
          addBuilding(cx - usable / 2 + a / 2, cz, a, usable - range(0, 12), baseH * range(0.5, 1.25), true);
          addBuilding(cx + usable / 2 - b / 2, cz, b, usable - range(0, 12), baseH * range(0.5, 1.25), true);
        } else {
          addBuilding(cx, cz - usable / 2 + a / 2, usable - range(0, 12), a, baseH * range(0.5, 1.25), true);
          addBuilding(cx, cz + usable / 2 - b / 2, usable - range(0, 12), b, baseH * range(0.5, 1.25), true);
        }
      } else {
        const q = usable / 2 - 3;
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            if (chance(0.1)) {
              // an empty lot buried in rubble
              addRubblePile(cx + sx * (q / 2 + 3), cz + sz * (q / 2 + 3), 12, 26);
              continue;
            }
            addBuilding(
              cx + sx * (q / 2 + 3), cz + sz * (q / 2 + 3),
              q - range(0, 8), q - range(0, 8),
              baseH * range(0.35, 1.15), true,
            );
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ relay plaza
  {
    const { x, z } = layout.relay;
    addCollider(x, z, 5.2, 5.2);
    const ring = 30;
    for (let n = 0; n < 12; n += 1) {
      const a = (n / 12) * Math.PI * 2 + 0.26;
      if (n % 3 === 0) continue;
      const bx = x + Math.cos(a) * ring;
      const bz = z + Math.sin(a) * ring;
      layout.barriers.push({ x: bx, y: curb, z: bz, rot: -a, scale: 1, variant: 0, flag: false });
      addCollider(bx, bz, 1.6, 1.6);
    }
    layout.barrels.push({ x: x + 12, y: curb, z: z - 11, rot: 0, scale: 1, variant: 0, flag: true });
    layout.barrels.push({ x: x - 14, y: curb, z: z + 9, rot: 0, scale: 1, variant: 0, flag: true });
    addRubblePile(x - 30, z - 30, 7, 16);
    addRubblePile(x + 33, z + 28, 6, 12);
  }

  // ------------------------------------------------------------ elevated highway
  {
    const hx = roadCenter(HIGHWAY_ROAD);
    const deckY = 12.5;
    const gapStart = 30;
    const gapEnd = 150;
    for (let z = -CITY_HALF + 27.5; z < CITY_HALF; z += 55) {
      const inGap = z > gapStart && z < gapEnd;
      const stub = inGap ? 0.55 : 1;
      layout.highway.push({ x: hx, y: (deckY * stub) / 2, z, sx: 2.4, sy: deckY * stub, sz: 3.4, style: 0, tint: 0.5 });
      layout.highway.push({ x: hx, y: deckY * stub - 0.6, z, sx: 15, sy: 1.6, sz: 2.6, style: 0, tint: 0.5 });
      addCollider(hx, z, 1.3, 1.8);
    }
    const segments: [number, number][] = [[-CITY_HALF - 40, gapStart], [gapEnd, CITY_HALF + 40]];
    for (const [a, b] of segments) {
      const len = b - a;
      const mid = (a + b) / 2;
      layout.highway.push({ x: hx, y: deckY + 0.8, z: mid, sx: 17, sy: 1.5, sz: len, style: 1, tint: 0.5 });
      layout.highway.push({ x: hx - 8.3, y: deckY + 2.1, z: mid, sx: 0.5, sy: 1.2, sz: len, style: 0, tint: 0.5 });
      layout.highway.push({ x: hx + 8.3, y: deckY + 2.1, z: mid, sx: 0.5, sy: 1.2, sz: len, style: 0, tint: 0.5 });
    }
    // collapsed span resting on the road shoulder
    const fallLen = 44;
    const tilt = 0.29;
    layout.highway.push({
      x: hx + 5, y: deckY * 0.52, z: gapStart + 20,
      sx: 17, sy: 1.5, sz: fallLen, rotX: tilt, rotY: 0.1, style: 1, tint: 0.5,
    });
    addCollider(hx + 6, gapStart + 39, 8.5, 5);
    addRubblePile(hx + 2, gapStart + 44, 9, 30);
    addRubblePile(hx - 3, gapEnd - 8, 7, 18);
  }

  // ------------------------------------------------------------ street furniture
  const nearStart = (x: number, z: number) => Math.abs(x - layout.start.x) < 8 && z > layout.start.z - 20 && z < layout.start.z + 150;
  const nearRelay = (x: number, z: number) => Math.hypot(x - layout.relay.x, z - layout.relay.z) < 62;

  for (let axis = 0; axis < 2; axis += 1) {
    for (let k = 0; k <= N; k += 1) {
      const c = roadCenter(k);
      for (let b = 0; b < N; b += 1) {
        const from = roadCenter(b) + CITY.roadWidth / 2 + 6;
        const to = roadCenter(b + 1) - CITY.roadWidth / 2 - 6;
        // lamps: staggered on both sides
        let side = (k + b) % 2 === 0 ? 1 : -1;
        for (let t = from + 8; t < to; t += 31) {
          side = -side;
          if (chance(0.14)) continue;
          const off = side * (CITY.roadWidth / 2 + 1.3);
          const lx = axis === 0 ? c + off : t;
          const lz = axis === 0 ? t : c + off;
          if (Math.abs(lx) > CITY_HALF + 10 || Math.abs(lz) > CITY_HALF + 10) continue;
          const fallen = chance(0.1);
          layout.lamps.push({
            x: lx, y: curb, z: lz,
            rot: (axis === 0 ? (side > 0 ? Math.PI : 0) : (side > 0 ? Math.PI / 2 : -Math.PI / 2)),
            scale: fallen ? range(0.12, 0.5) : 0,
            variant: 0,
            flag: !fallen && chance(0.16),
          });
        }
        // wrecks and debris on the carriageway
        const isHighwayRoad = axis === 0 && k === HIGHWAY_ROAD;
        const wrecks = chance(0.45) ? 1 + pick(2) : 0;
        for (let w = 0; w < wrecks; w += 1) {
          const t = range(from, to);
          const lane = range(isHighwayRoad ? 4.5 : -9.5, 9.5) * (chance(0.5) ? 1 : -1);
          const wx = axis === 0 ? c + lane : t;
          const wz = axis === 0 ? t : c + lane;
          if (nearStart(wx, wz) || nearRelay(wx, wz) || Math.abs(wx) > CITY_HALF || Math.abs(wz) > CITY_HALF) continue;
          layout.wrecks.push({
            x: wx, y: 0, z: wz,
            rot: (axis === 0 ? 0 : Math.PI / 2) + range(-0.7, 0.7) + (chance(0.5) ? Math.PI : 0),
            scale: 1, variant: pick(3), flag: chance(0.18),
          });
          addCollider(wx, wz, 1.7, 1.7, true);
        }
        for (let s = 0; s < 5; s += 1) {
          const t = range(from - 10, to + 10);
          const lane = range(-12.5, 12.5);
          const sx = axis === 0 ? c + lane : t;
          const sz = axis === 0 ? t : c + lane;
          layout.rubble.push({ x: sx, y: 0.1, z: sz, rot: rng() * 6.28, scale: range(0.18, 0.5), variant: pick(3), flag: false });
        }
        if (chance(0.13) && !isHighwayRoad) {
          // half-road barricade
          const t = range(from + 10, to - 10);
          const sideSign = chance(0.5) ? 1 : -1;
          for (let n = 0; n < 3; n += 1) {
            const lane = sideSign * (3 + n * 3.6);
            const bx = axis === 0 ? c + lane : t + range(-0.6, 0.6);
            const bz = axis === 0 ? t + range(-0.6, 0.6) : c + lane;
            if (nearStart(bx, bz) || nearRelay(bx, bz)) continue;
            layout.barriers.push({ x: bx, y: 0, z: bz, rot: (axis === 0 ? 0 : Math.PI / 2) + range(-0.25, 0.25), scale: 1, variant: 0, flag: false });
            addCollider(bx, bz, 1.6, 1.0);
          }
        }
      }
      // fire barrels at some corners
      for (let m = 0; m <= N; m += 1) {
        if (!chance(0.07)) continue;
        const cx = roadCenter(k) + (chance(0.5) ? 1 : -1) * (CITY.roadWidth / 2 + 2.5);
        const cz = roadCenter(m) + (chance(0.5) ? 1 : -1) * (CITY.roadWidth / 2 + 2.5);
        if (axis === 0 && Math.abs(cx) < CITY_HALF && Math.abs(cz) < CITY_HALF) {
          layout.barrels.push({ x: cx, y: curb, z: cz, rot: rng() * 6.28, scale: 1, variant: 0, flag: true });
          addCollider(cx, cz, 0.5, 0.5);
        }
      }
    }
  }
  // guaranteed atmosphere near the start
  layout.barrels.push({ x: layout.start.x - 20, y: curb, z: layout.start.z + 34, rot: 0, scale: 1, variant: 0, flag: true });
  layout.wrecks.push({ x: layout.start.x - 13, y: 0, z: layout.start.z + 22, rot: 0.5, scale: 1, variant: 1, flag: true });
  addCollider(layout.start.x - 13, layout.start.z + 22, 1.7, 1.7, true);

  // ------------------------------------------------------------ cables between rooftops
  for (let n = 0; n < roofHeights.length; n += 1) {
    const a = roofHeights[n];
    if (!chance(0.3)) continue;
    let best = -1;
    let bestDist = 1e9;
    for (let m = 0; m < roofHeights.length; m += 1) {
      if (m === n) continue;
      const b = roofHeights[m];
      const dist = Math.hypot(a.x - b.x, a.z - b.z);
      if (dist > 34 && dist < 95 && dist < bestDist && rng() < 0.6) {
        best = m;
        bestDist = dist;
      }
    }
    if (best < 0) continue;
    const b = roofHeights[best];
    const ya = Math.min(a.h, 20 + rng() * 50);
    const yb = Math.min(b.h, ya + range(-10, 10));
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    layout.cables.push({
      ax: a.x + (dx / len) * Math.min(a.hw, a.hd), ay: ya, az: a.z + (dz / len) * Math.min(a.hw, a.hd),
      bx: b.x - (dx / len) * Math.min(b.hw, b.hd), by: Math.max(8, yb), bz: b.z - (dz / len) * Math.min(b.hw, b.hd),
      sag: range(2, 7),
    });
  }

  // ------------------------------------------------------------ distant skyline ring
  for (let n = 0; n < 150; n += 1) {
    const a = rng() * Math.PI * 2;
    const r = CITY_HALF + range(70, 620);
    const w = range(26, 70);
    const h = range(40, 260) * (1 - (r - CITY_HALF) / 1500);
    layout.farTowers.push({
      x: Math.cos(a) * r * 1.1, y: h / 2, z: Math.sin(a) * r * 1.1,
      sx: w, sy: h, sz: range(26, 70), rotY: chance(0.25) ? range(-0.4, 0.4) : 0,
      rotZ: chance(0.08) ? range(-0.16, 0.16) : 0,
      style: pick(4), tint: rng(),
    });
  }
  // rubble berm sealing the city edge
  for (let n = 0; n < 420; n += 1) {
    const t = (n / 420) * 4;
    const sideIndex = Math.floor(t);
    const u = (t - sideIndex) * 2 - 1;
    const edge = CITY_HALF + CITY.roadWidth / 2 + range(1, 9);
    const px = sideIndex === 0 ? u * edge : sideIndex === 1 ? edge : sideIndex === 2 ? -u * edge : -edge;
    const pz = sideIndex === 0 ? -edge : sideIndex === 1 ? u * edge : sideIndex === 2 ? edge : -u * edge;
    const s = range(2.2, 6.5);
    layout.rubble.push({ x: px, y: s * 0.3, z: pz, rot: rng() * 6.28, scale: s, variant: pick(3), flag: false });
  }

  return layout;
}

/** Uniform spatial hash over the static colliders for fast circle/segment queries. */
export class ColliderGrid {
  private readonly cell = 28;
  private readonly cells = new Map<number, Aabb[]>();

  constructor(colliders: Aabb[]) {
    for (const box of colliders) {
      const x0 = Math.floor(box.minX / this.cell);
      const x1 = Math.floor(box.maxX / this.cell);
      const z0 = Math.floor(box.minZ / this.cell);
      const z1 = Math.floor(box.maxZ / this.cell);
      for (let x = x0; x <= x1; x += 1) {
        for (let z = z0; z <= z1; z += 1) {
          const key = this.key(x, z);
          let list = this.cells.get(key);
          if (!list) {
            list = [];
            this.cells.set(key, list);
          }
          list.push(box);
        }
      }
    }
  }

  private key(x: number, z: number): number {
    return (x + 512) * 2048 + (z + 512);
  }

  /** Visit every collider whose cell overlaps the query rectangle (may repeat a box). */
  query(minX: number, maxX: number, minZ: number, maxZ: number, visit: (box: Aabb) => void): void {
    const x0 = Math.floor(minX / this.cell);
    const x1 = Math.floor(maxX / this.cell);
    const z0 = Math.floor(minZ / this.cell);
    const z1 = Math.floor(maxZ / this.cell);
    for (let x = x0; x <= x1; x += 1) {
      for (let z = z0; z <= z1; z += 1) {
        const list = this.cells.get(this.key(x, z));
        if (!list) continue;
        for (let n = 0; n < list.length; n += 1) visit(list[n]);
      }
    }
  }

  /** Distance along the segment (0..1) of the first hit, or 1 when clear. */
  raycast(ax: number, az: number, bx: number, bz: number): number {
    let best = 1;
    const dx = bx - ax;
    const dz = bz - az;
    this.query(Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz), (box) => {
      let t0 = 0;
      let t1 = best;
      if (Math.abs(dx) < 1e-6) {
        if (ax < box.minX || ax > box.maxX) return;
      } else {
        let a = (box.minX - ax) / dx;
        let b = (box.maxX - ax) / dx;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        if (t0 > t1) return;
      }
      if (Math.abs(dz) < 1e-6) {
        if (az < box.minZ || az > box.maxZ) return;
      } else {
        let a = (box.minZ - az) / dz;
        let b = (box.maxZ - az) / dz;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        if (t0 > t1) return;
      }
      best = t0;
    });
    return best;
  }

  lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    return this.raycast(ax, az, bx, bz) >= 1;
  }
}
