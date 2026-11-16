import * as THREE from 'three';
import { createSeededRandom } from '../utils/random';
import { type Aabb, CITY, type CityLayout, type ColliderGrid, RELAY_BLOCK, blockCenter, groundHeight, roadCenter } from '../world/CityLayout';
import { PartBuilder, createPropMaterial } from './PropGeometry';

export type CacheSite = {
  x: number; y: number; z: number;
  /** True when the container's long axis runs along world X. */
  alongX: boolean;
  /** Unit vector from the cache toward the street it is reached from. */
  ax: number; az: number;
  guards: { x: number; z: number; heading: number }[];
  collider: Aabb;
};

export type Cache = CacheSite & {
  opened: boolean;
  /** 0 closed .. 1 lid fully open. */
  openT: number;
  guardsSpawned: boolean;
  warned: boolean;
};

export const CACHE_TRIGGER_RADIUS = 7.5;

function clearance(grid: ColliderGrid, x: number, z: number, max: number): number {
  let best = max;
  grid.query(x - max, x + max, z - max, z + max, (box) => {
    const cx = Math.max(box.minX, Math.min(x, box.maxX));
    const cz = Math.max(box.minZ, Math.min(z, box.maxZ));
    const d = Math.hypot(x - cx, z - cz);
    if (d < best) best = d;
  });
  return best;
}

/** Find three open lots off the start -> relay route that a car can drive into from the street. */
export function findCacheSites(layout: CityLayout, grid: ColliderGrid, seed: number): CacheSite[] {
  const rng = createSeededRandom(seed);
  const start = layout.start;
  const relay = layout.relay;
  // the route a player actually drives: up the start avenue, then east along the street south of the relay
  const route: [number, number][] = [[start.x, start.z], [start.x, relay.z - CITY.pitch / 2], [relay.x, relay.z - CITY.pitch / 2]];
  const routeLength = Math.hypot(route[1][0] - route[0][0], route[1][1] - route[0][1]) + Math.hypot(route[2][0] - route[1][0], route[2][1] - route[1][1]);
  /** [progress 0..1 along the route, distance off it] */
  const along = (x: number, z: number): [number, number] => {
    let bestOff = 1e9;
    let bestT = 0;
    let walked = 0;
    for (let n = 0; n < route.length - 1; n += 1) {
      const [ax, az] = route[n];
      const [bx, bz] = route[n + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const u = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (len * len)));
      const off = Math.hypot(x - (ax + (bx - ax) * u), z - (az + (bz - az) * u));
      if (off < bestOff) {
        bestOff = off;
        bestT = (walked + len * u) / routeLength;
      }
      walked += len;
    }
    return [bestT, bestOff];
  };
  type Candidate = { x: number; z: number; ax: number; az: number; clear: number; t: number; off: number };
  const candidates: Candidate[] = [];
  const N = CITY.blocksPerSide;
  const half = CITY.blockSize / 2;
  const wide = (x0: number, z0: number, x1: number, z1: number) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const d = Math.hypot(dx, dz) || 1;
    const nx = (-dz / d) * 1.7;
    const nz = (dx / d) * 1.7;
    return grid.lineOfSight(x0, z0, x1, z1) && grid.lineOfSight(x0 + nx, z0 + nz, x1 + nx, z1 + nz) && grid.lineOfSight(x0 - nx, z0 - nz, x1 - nx, z1 - nz);
  };
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      if (i === RELAY_BLOCK.i && j === RELAY_BLOCK.j) continue;
      const bx = blockCenter(i);
      const bz = blockCenter(j);
      let best: Candidate | null = null;
      for (let ox = -half + 9; ox <= half - 9; ox += 4) {
        for (let oz = -half + 9; oz <= half - 9; oz += 4) {
          const x = bx + ox;
          const z = bz + oz;
          const clear = clearance(grid, x, z, 16);
          if (clear < 8.5 || (best && clear <= best.clear)) continue;
          // reachable from one of the four streets around the block?
          const exits: [number, number][] = [
            [roadCenter(i) + 6, z], [roadCenter(i + 1) - 6, z], [x, roadCenter(j) + 6], [x, roadCenter(j + 1) - 6],
          ];
          let exit: [number, number] | null = null;
          let exitDist = 1e9;
          for (const e of exits) {
            const d = Math.hypot(e[0] - x, e[1] - z);
            if (d < exitDist && wide(x, z, e[0], e[1])) {
              exit = e;
              exitDist = d;
            }
          }
          if (!exit) continue;
          const [t, off] = along(x, z);
          best = { x, z, ax: (exit[0] - x) / exitDist, az: (exit[1] - z) / exitDist, clear, t, off };
        }
      }
      if (best) candidates.push(best);
    }
  }
  const chosen: Candidate[] = [];
  const bins: [number, number][] = [[0.08, 0.34], [0.34, 0.66], [0.66, 1.01]];
  const take = (pool: Candidate[]) => {
    let best: Candidate | null = null;
    let bestScore = -1e9;
    for (const c of pool) {
      if (chosen.includes(c)) continue;
      let apart = true;
      for (const other of chosen) if (Math.hypot(other.x - c.x, other.z - c.z) < 180) apart = false;
      if (!apart) continue;
      if (Math.hypot(c.x - start.x, c.z - start.z) < 150 || Math.hypot(c.x - relay.x, c.z - relay.z) < 110) continue;
      // prefer roomy lots a detour away from the direct line, but not across the map
      const score = c.clear * 2 - Math.abs(c.off - 150) * 0.06 + rng() * 2;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) chosen.push(best);
  };
  for (const [a, b] of bins) take(candidates.filter((c) => c.t >= a && c.t < b && c.off > 60 && c.off < 270));
  for (let n = 0; chosen.length < 3 && n < 3; n += 1) take(candidates.filter((c) => c.off < 420));
  for (let n = 0; chosen.length < 3 && n < 3; n += 1) take(candidates);

  return chosen.sort((a, b) => a.t - b.t).map((c) => {
    const alongX = Math.abs(c.az) > Math.abs(c.ax);
    const hw = alongX ? 1.85 : 1.1;
    const hd = alongX ? 1.1 : 1.85;
    const guards: CacheSite['guards'] = [];
    const heading = Math.atan2(c.ax, c.az);
    for (const side of [-1, 1]) {
      // parked either side of the container, nose toward the street
      let gx = c.x - c.az * side * 6 + c.ax * 3.5;
      let gz = c.z + c.ax * side * 6 + c.az * 3.5;
      if (clearance(grid, gx, gz, 6) < 2.4) {
        gx = c.x + c.ax * (7 + side * 2.5) - c.az * side * 2.4;
        gz = c.z + c.az * (7 + side * 2.5) + c.ax * side * 2.4;
      }
      guards.push({ x: gx, z: gz, heading: heading + side * 0.35 });
    }
    return {
      x: c.x, y: groundHeight(c.x, c.z), z: c.z, alongX, ax: c.ax, az: c.az, guards,
      collider: { minX: c.x - hw, maxX: c.x + hw, minZ: c.z - hd, maxZ: c.z + hd },
    };
  });
}

function bodyGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder();
  const hull = '#3c4a4c';
  const dark = '#1c2124';
  b.bevel(3.4, 1.55, 1.9, 0.07, hull, { y: 0.97 });
  for (const sz of [-1, 1]) {
    b.box(3.5, 0.18, 0.26, dark, { y: 0.09, z: sz * 0.72 });
    // bolted applique armour and a stencilled panel
    b.bevel(1.25, 0.95, 0.07, 0.03, '#58645e', { x: -0.82, y: 0.95, z: sz * 0.975 });
    b.bevel(1.25, 0.95, 0.07, 0.03, '#4c5852', { x: 0.82, y: 0.95, z: sz * 0.975 });
    b.box(0.5, 0.16, 0.02, '#e8ecea', { x: 0.82, y: 1.16, z: sz * 1.015, glow: 0.35 });
    b.box(0.28, 0.06, 0.02, '#e8ecea', { x: 0.71, y: 0.98, z: sz * 1.015, glow: 0.35 });
    b.box(3.05, 0.06, 0.05, '#38f5d8', { y: 1.69, z: sz * 0.93, glow: 3.2 });
    for (const sx of [-1, 1]) {
      b.box(0.17, 1.72, 0.17, dark, { x: sx * 1.64, y: 0.9, z: sz * 0.89 });
      b.box(0.2, 0.12, 0.2, '#ffc21a', { x: sx * 1.64, y: 1.7, z: sz * 0.89, glow: 0.5 });
      for (const bx of [-0.5, 0.5]) for (const by of [-0.36, 0.36]) {
        b.cylinder(0.035, 0.035, 0.04, 6, '#b9bfc2', { x: sx * 0.82 + bx, y: 0.95 + by, z: sz * 1.02, rx: Math.PI / 2 });
      }
    }
  }
  for (let n = -2; n <= 2; n += 1) b.box(0.09, 1.5, 1.95, '#2b3537', { x: n * 0.68, y: 0.97 });
  // door end with locking bars and a status strip
  for (const sx of [-1, 1]) {
    b.box(0.06, 1.3, 1.5, '#2a3436', { x: sx * 1.71, y: 0.95 });
    b.cylinder(0.04, 0.04, 1.4, 8, '#aeb4b7', { x: sx * 1.75, y: 0.95, z: -0.35 });
    b.cylinder(0.04, 0.04, 1.4, 8, '#aeb4b7', { x: sx * 1.75, y: 0.95, z: 0.35 });
    b.box(0.05, 0.1, 1.1, '#38f5d8', { x: sx * 1.745, y: 1.52, glow: 3.4 });
  }
  // lit cargo tray, hidden under the lid until the cache is opened
  b.box(3.1, 0.05, 1.6, '#38f5d8', { y: 1.72, glow: 1.6 });
  for (let n = -1; n <= 1; n += 1) b.bevel(0.7, 0.3, 1.1, 0.05, '#c8862c', { x: n * 0.95, y: 1.82, glow: 0.3 });
  // comms mast with beacon
  b.cylinder(0.04, 0.06, 2.6, 8, dark, { x: -1.5, y: 3.0, z: 0.78 });
  b.add(new THREE.SphereGeometry(0.13, 10, 8), '#38f5d8', { x: -1.5, y: 4.34, z: 0.78, glow: 5 });
  b.box(0.5, 0.04, 0.04, dark, { x: -1.5, y: 3.7, z: 0.78 });
  b.box(0.04, 0.04, 0.4, dark, { x: -1.5, y: 3.3, z: 0.78 });
  return b.build();
}

function lidGeometry(): THREE.BufferGeometry {
  // origin on the hinge line (rear top edge); the lid extends toward +Z
  const b = new PartBuilder();
  b.bevel(3.36, 0.14, 1.9, 0.05, '#48575c', { y: 0.07, z: 0.95 });
  b.bevel(1.5, 0.08, 1.0, 0.03, '#3a474b', { y: 0.17, z: 0.95 });
  b.box(0.9, 0.03, 0.12, '#38f5d8', { y: 0.215, z: 0.95, glow: 3 });
  b.box(0.12, 0.03, 0.6, '#38f5d8', { y: 0.215, z: 0.95, glow: 3 });
  for (const sx of [-1, 1]) {
    b.box(0.22, 0.1, 0.3, '#1c2124', { x: sx * 1.2, y: 0.12, z: 0.06 });
    b.box(0.3, 0.07, 0.16, '#ffc21a', { x: sx * 1.25, y: 0.16, z: 1.72, glow: 0.4 });
  }
  return b.build();
}

/** Armoured supply containers with a teal beacon pillar: three draw calls for all of them. */
export class SupplyCaches {
  readonly group = new THREE.Group();
  readonly caches: Cache[] = [];
  private readonly bodies: THREE.InstancedMesh;
  private readonly lids: THREE.InstancedMesh;
  private readonly beams: THREE.InstancedMesh;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly beamMaterial: THREE.ShaderMaterial;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly lidQuaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly euler = new THREE.Euler();

  constructor(sites: CacheSite[]) {
    this.group.name = 'supply-caches';
    for (const site of sites) this.caches.push({ ...site, opened: false, openT: 0, guardsSpawned: false, warned: false });
    const count = Math.max(1, sites.length);
    this.material = createPropMaterial(0.6, 0.4, 1.2);
    this.bodies = new THREE.InstancedMesh(bodyGeometry(), this.material, count);
    this.lids = new THREE.InstancedMesh(lidGeometry(), this.material, count);
    this.bodies.castShadow = true;
    this.lids.castShadow = true;
    const beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true);
    beamGeometry.translate(0, 0.5, 0);
    this.beamMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float rise = fract(vUv.y * 6.0 - uTime * 0.7);
          float band = 0.75 + 0.25 * smoothstep(0.0, 0.2, rise) * (1.0 - smoothstep(0.6, 1.0, rise));
          float fade = pow(1.0 - vUv.y, 1.6) * smoothstep(0.0, 0.03, vUv.y);
          float a = fade * band * 0.55;
          gl_FragColor = vec4(vec3(0.22, 0.96, 0.85) * a * 2.2, a);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.beams = new THREE.InstancedMesh(beamGeometry, this.beamMaterial, count);
    this.beams.renderOrder = 6;
    for (const mesh of [this.bodies, this.lids, this.beams]) {
      mesh.frustumCulled = false;
      mesh.count = sites.length;
      this.group.add(mesh);
    }
    this.reset();
  }

  get openedCount(): number {
    let total = 0;
    for (const cache of this.caches) if (cache.opened) total += 1;
    return total;
  }

  reset(): void {
    for (let i = 0; i < this.caches.length; i += 1) {
      const cache = this.caches[i];
      cache.opened = false;
      cache.openT = 0;
      cache.guardsSpawned = false;
      cache.warned = false;
      this.euler.set(0, cache.alongX ? 0 : Math.PI / 2, 0);
      this.matrix.compose(this.position.set(cache.x, cache.y, cache.z), this.quaternion.setFromEuler(this.euler), this.scale.set(1, 1, 1));
      this.bodies.setMatrixAt(i, this.matrix);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.update(0, 0);
  }

  update(dt: number, time: number): void {
    this.beamMaterial.uniforms.uTime.value = time;
    for (let i = 0; i < this.caches.length; i += 1) {
      const cache = this.caches[i];
      if (cache.opened && cache.openT < 1) cache.openT = Math.min(1, cache.openT + dt * 1.8);
      // ease-out-back: the lid snaps open and settles
      const t = cache.openT;
      const eased = t <= 0 ? 0 : 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
      this.euler.set(0, cache.alongX ? 0 : Math.PI / 2, 0);
      this.quaternion.setFromEuler(this.euler);
      this.euler.set(-eased * 1.95, 0, 0);
      this.lidQuaternion.setFromEuler(this.euler);
      // hinge sits on the rear top edge of the hull (local 0, 1.745, -0.95)
      this.position.set(0, 1.745, -0.95).applyQuaternion(this.quaternion);
      this.position.x += cache.x;
      this.position.y += cache.y;
      this.position.z += cache.z;
      this.matrix.compose(this.position, this.lidQuaternion.premultiply(this.quaternion), this.scale.set(1, 1, 1));
      this.lids.setMatrixAt(i, this.matrix);
      const beam = cache.opened ? Math.max(0, 1 - t * 1.4) : 1;
      this.matrix.compose(this.position.set(cache.x, cache.y + 1.9, cache.z), this.quaternion.identity(), this.scale.set(0.85 * beam + 0.001, 62 * beam + 0.001, 0.85 * beam + 0.001));
      this.beams.setMatrixAt(i, this.matrix);
    }
    this.lids.instanceMatrix.needsUpdate = true;
    this.beams.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.bodies.geometry.dispose();
    this.lids.geometry.dispose();
    this.beams.geometry.dispose();
    this.material.dispose();
    this.beamMaterial.dispose();
  }
}
