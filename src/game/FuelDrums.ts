import * as THREE from 'three';
import { createSeededRandom } from '../utils/random';
import { CITY, type CityLayout, type ColliderGrid, groundHeight, roadCenter } from '../world/CityLayout';
import { HIDDEN_MATRIX, PartBuilder, createPropMaterial } from './PropGeometry';

export type Drum = {
  alive: boolean;
  x: number; y: number; z: number;
  rot: number;
  lying: boolean;
  /** Seconds until it detonates, or -1 when it is not lit. */
  fuse: number;
};

export const DRUM_RADIUS = 0.5;
const MAX_DRUMS = 48;

function drumGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.cylinder(0.44, 0.44, 1.2, 20, '#b0241c', { y: 0.6 });
  for (const y of [0.03, 0.4, 0.82, 1.18]) b.cylinder(0.47, 0.47, 0.055, 20, y === 0.03 || y === 1.18 ? '#3a3d40' : '#84160f', { y });
  // diagonal hazard band: alternating twisted strips
  const strips = 10;
  for (let n = 0; n < strips; n += 1) {
    const strip = new THREE.CylinderGeometry(0.448, 0.448, 0.3, 3, 3, true, (n / strips) * Math.PI * 2, (Math.PI * 2) / strips);
    const position = strip.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const a = position.getY(i) * 2.2;
      const x = position.getX(i);
      const z = position.getZ(i);
      position.setXYZ(i, x * Math.cos(a) - z * Math.sin(a), position.getY(i), x * Math.sin(a) + z * Math.cos(a));
    }
    strip.computeVertexNormals();
    b.add(strip, n % 2 === 0 ? '#ffc21a' : '#141414', { y: 0.61, glow: n % 2 === 0 ? 0.55 : 0 });
  }
  // lid, bung caps and a flammable placard
  b.cylinder(0.41, 0.41, 0.03, 20, '#8f1d16', { y: 1.19 });
  b.cylinder(0.07, 0.07, 0.05, 8, '#d8d6cc', { x: 0.24, y: 1.22 });
  b.cylinder(0.04, 0.04, 0.04, 8, '#d8d6cc', { x: -0.2, y: 1.22, z: 0.12 });
  b.box(0.24, 0.24, 0.02, '#ff7a1a', { y: 0.98, z: 0.445, rz: Math.PI / 4, glow: 1.2 });
  b.box(0.1, 0.1, 0.025, '#141414', { y: 0.98, z: 0.447, rz: Math.PI / 4 });
  return b.build();
}

/** Red hazard drums: one InstancedMesh, a small dynamic collider list, fuse-driven chain reactions. */
export class FuelDrums {
  readonly mesh: THREE.InstancedMesh;
  readonly drums: Drum[] = [];
  private readonly material: THREE.MeshStandardMaterial;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly euler = new THREE.Euler();
  /** Parametric position (0..1) of the last `segmentHit`. */
  hitT = 1;

  constructor(layout: CityLayout, grid: ColliderGrid, seed: number) {
    this.material = createPropMaterial(0.5, 0.3, 1);
    this.mesh = new THREE.InstancedMesh(drumGeometry(), this.material, MAX_DRUMS);
    this.mesh.name = 'fuel-drums';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.place(layout, grid, seed);
    this.reset();
  }

  private place(layout: CityLayout, grid: ColliderGrid, seed: number): void {
    const rng = createSeededRandom(seed);
    const relay = layout.relay;
    const start = layout.start;
    const edge = CITY.roadWidth / 2 - 1.7;
    const blocked = (x: number, z: number) => {
      let hit = false;
      grid.query(x - 1.6, x + 1.6, z - 1.6, z + 1.6, (box) => {
        if (x > box.minX - 1.4 && x < box.maxX + 1.4 && z > box.minZ - 1.4 && z < box.maxZ + 1.4) hit = true;
      });
      return hit;
    };
    const sites: { x: number; z: number; ax: number; az: number }[] = [];
    const cluster = (x: number, z: number, ax: number, az: number, count: number) => {
      if (Math.hypot(x - start.x, z - start.z) < 55) return;
      if (Math.hypot(x - (relay.x + 3), z - (relay.z - 52)) < 12) return;
      for (const site of sites) if (Math.hypot(site.x - x, site.z - z) < 40) return;
      sites.push({ x, z, ax, az });
      for (let n = 0; n < count && this.drums.length < MAX_DRUMS; n += 1) {
        // a tight, hand-stacked looking group: a row with one drum tucked behind
        const along = (n - (count - 1) / 2) * 1.08 + (rng() - 0.5) * 0.14;
        const back = n === 2 ? 0.98 : (rng() - 0.5) * 0.12;
        const dx = x + ax * along - az * back;
        const dz = z + az * along + ax * back;
        if (blocked(dx, dz)) continue;
        this.drums.push({ alive: true, x: dx, y: groundHeight(dx, dz), z: dz, rot: rng() * 6.28, lying: false, fuse: -1 });
      }
    };
    // relay plaza: cover for the defence fight
    cluster(relay.x + 28, relay.z - 29, 1, 0, 3);
    cluster(relay.x - 29, relay.z + 28, 0, 1, 3);
    cluster(relay.x - 37, relay.z - 9, 0, 1, 3);
    cluster(relay.x + 37, relay.z + 11, 0, 1, 2);

    // junction corners and kerb-side stacks, biased toward the start -> relay corridor
    const corridor = (x: number, z: number) => {
      const vx = relay.x - start.x;
      const vz = relay.z - start.z;
      const t = Math.max(0, Math.min(1, ((x - start.x) * vx + (z - start.z) * vz) / (vx * vx + vz * vz)));
      return Math.hypot(x - (start.x + vx * t), z - (start.z + vz * t));
    };
    const N = CITY.blocksPerSide;
    let guard = 0;
    while (this.drums.length < 41 && guard < 600) {
      guard += 1;
      const k = Math.floor(rng() * (N + 1));
      const m = Math.floor(rng() * (N + 1));
      const sx = rng() < 0.5 ? -1 : 1;
      const sz = rng() < 0.5 ? -1 : 1;
      const junction = rng() < 0.6;
      let x: number;
      let z: number;
      let ax = 0;
      let az = 1;
      if (junction) {
        x = roadCenter(k) + sx * edge;
        z = roadCenter(m) + sz * (edge + 2.5);
      } else if (rng() < 0.5) {
        // north-south street, mid-block
        x = roadCenter(k) + sx * edge;
        z = roadCenter(m) + (0.3 + rng() * 0.4) * CITY.pitch;
      } else {
        x = roadCenter(k) + (0.3 + rng() * 0.4) * CITY.pitch;
        z = roadCenter(m) + sz * edge;
        ax = 1;
        az = 0;
      }
      if (Math.abs(x) > roadCenter(N) + 8 || Math.abs(z) > roadCenter(N) + 8) continue;
      const off = corridor(x, z);
      if (off > 330 || (off > 170 && rng() < 0.7)) continue;
      if (Math.hypot(x - relay.x, z - relay.z) < 75) continue;
      cluster(x, z, ax, az, 2 + Math.floor(rng() * 2.4));
    }
    for (const drum of this.drums) {
      if (rng() < 0.12) drum.lying = true;
    }
  }

  get aliveCount(): number {
    let total = 0;
    for (const drum of this.drums) if (drum.alive) total += 1;
    return total;
  }

  /** Restore every drum (new run). */
  reset(): void {
    for (let i = 0; i < MAX_DRUMS; i += 1) {
      const drum = this.drums[i];
      if (!drum) {
        this.mesh.setMatrixAt(i, HIDDEN_MATRIX);
        continue;
      }
      drum.alive = true;
      drum.fuse = -1;
      if (drum.lying) {
        this.euler.set(Math.PI / 2, drum.rot, 0, 'YXZ');
        this.position.set(drum.x, drum.y + 0.46, drum.z);
      } else {
        this.euler.set(0, drum.rot, 0);
        this.position.set(drum.x, drum.y, drum.z);
      }
      // lying drums pivot around their middle so they rest on their side
      this.matrix.compose(this.position, this.quaternion.setFromEuler(this.euler), this.scale);
      if (drum.lying) this.matrix.multiply(_offset);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  ignite(index: number, delay: number): void {
    const drum = this.drums[index];
    if (!drum || !drum.alive) return;
    if (drum.fuse < 0 || delay < drum.fuse) drum.fuse = delay;
  }

  remove(index: number): void {
    const drum = this.drums[index];
    drum.alive = false;
    drum.fuse = -1;
    this.mesh.setMatrixAt(index, HIDDEN_MATRIX);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Tick fuses; returns the index of ONE drum that is due this step, or -1 (call until -1). */
  nextDue(dt: number): number {
    let due = -1;
    for (let i = 0; i < this.drums.length; i += 1) {
      const drum = this.drums[i];
      if (!drum.alive || drum.fuse < 0) continue;
      drum.fuse -= dt;
      if (drum.fuse <= 0 && due < 0) due = i;
    }
    return due;
  }

  /** First live drum crossed by the segment, or -1. Sets `hitT`. */
  segmentHit(ax: number, az: number, bx: number, bz: number, radius: number): number {
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    let best = -1;
    let bestT = 2;
    const reach = DRUM_RADIUS + radius;
    for (let i = 0; i < this.drums.length; i += 1) {
      const drum = this.drums[i];
      if (!drum.alive) continue;
      const t = Math.max(0, Math.min(1, ((drum.x - ax) * dx + (drum.z - az) * dz) / len2));
      const cx = ax + dx * t - drum.x;
      const cz = az + dz * t - drum.z;
      if (cx * cx + cz * cz < reach * reach && t < bestT) {
        bestT = t;
        best = i;
      }
    }
    this.hitT = best < 0 ? 1 : bestT;
    return best;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

const _offset = new THREE.Matrix4().makeTranslation(0, -0.6, 0);
