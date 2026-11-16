import * as THREE from 'three';
import { HIDDEN_MATRIX, PartBuilder, createPropMaterial } from '../game/PropGeometry';
import { type ColliderGrid, PLAY_HALF, groundHeight } from '../world/CityLayout';
import type { Enemy } from './Enemy';

export type Missile = {
  active: boolean;
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  speed: number;
  age: number;
  target: Enemy | null;
  /** Roll angle, purely visual. */
  spin: number;
};

/** What a missile needs from the game. Kept narrow so the flight model stays testable. */
export interface MissileHost {
  readonly grid: ColliderGrid;
  readonly enemies: Enemy[];
  /** Index of a fuel drum crossed by the segment (and its 0..1 position via the return of drumHitT), or -1. */
  drumHit(ax: number, az: number, bx: number, bz: number): number;
  drumHitT(): number;
  trail(x: number, y: number, z: number, dx: number, dy: number, dz: number, boostPhase: boolean): void;
  detonate(x: number, y: number, z: number, direct: Enemy | null, drum: number): void;
}

export const MISSILE = {
  launchSpeed: 38,
  maxSpeed: 128,
  accel: 150,
  /** rad/s once the motor is steering. */
  turnRate: 2.7,
  armTime: 0.16,
  life: 4.2,
  proximity: 2.4,
  blastRadius: 9,
  directDamage: 70,
} as const;

function missileGeometry(): THREE.BufferGeometry {
  // forward is +Z
  const b = new PartBuilder();
  b.cylinder(0.11, 0.11, 1.1, 12, '#d9d8d2', { rx: Math.PI / 2 });
  b.add(new THREE.ConeGeometry(0.11, 0.36, 12), '#e23a2e', { z: 0.73, rx: Math.PI / 2, glow: 0.5 });
  b.cylinder(0.114, 0.114, 0.08, 12, '#1a1c1e', { z: 0.5, rx: Math.PI / 2 });
  b.cylinder(0.114, 0.114, 0.06, 12, '#ffc21a', { z: 0.16, rx: Math.PI / 2, glow: 0.6 });
  b.cylinder(0.085, 0.12, 0.16, 12, '#2a2d30', { z: -0.62, rx: Math.PI / 2 });
  b.cylinder(0.07, 0.07, 0.03, 10, '#ffb060', { z: -0.705, rx: Math.PI / 2, glow: 8 });
  for (let n = 0; n < 4; n += 1) {
    const a = (n / 4) * Math.PI * 2 + Math.PI / 4;
    const fin = new THREE.BoxGeometry(0.02, 0.24, 0.3);
    fin.translate(0, 0.2, -0.4);
    fin.rotateZ(a);
    b.add(fin, '#3a3f44');
    const canard = new THREE.BoxGeometry(0.018, 0.12, 0.14);
    canard.translate(0, 0.15, 0.36);
    canard.rotateZ(a);
    b.add(canard, '#3a3f44');
  }
  return b.build();
}

const _forward = new THREE.Vector3(0, 0, 1);

/** Pooled guided missiles: accelerate, steer with a limited turn rate, proximity fuse. */
export class MissileSystem {
  readonly mesh: THREE.InstancedMesh;
  readonly missiles: Missile[] = [];
  private readonly material: THREE.MeshStandardMaterial;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly rollQuaternion = new THREE.Quaternion();
  private readonly direction = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1.5, 1.5, 1.5);

  constructor(capacity = 6) {
    this.material = createPropMaterial(0.45, 0.4, 1.4);
    this.mesh = new THREE.InstancedMesh(missileGeometry(), this.material, capacity);
    this.mesh.name = 'missiles';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    for (let i = 0; i < capacity; i += 1) {
      this.missiles.push({ active: false, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, speed: 0, age: 0, target: null, spin: 0 });
      this.mesh.setMatrixAt(i, HIDDEN_MATRIX);
    }
  }

  get activeCount(): number {
    let total = 0;
    for (const m of this.missiles) if (m.active) total += 1;
    return total;
  }

  launch(x: number, y: number, z: number, dx: number, dy: number, dz: number, inheritSpeed: number, target: Enemy | null): boolean {
    for (const m of this.missiles) {
      if (m.active) continue;
      m.active = true;
      m.x = x; m.y = y; m.z = z;
      const inv = 1 / (Math.hypot(dx, dy, dz) || 1);
      m.dx = dx * inv; m.dy = dy * inv; m.dz = dz * inv;
      m.speed = MISSILE.launchSpeed + Math.max(0, inheritSpeed);
      m.age = 0;
      m.target = target;
      m.spin = 0;
      return true;
    }
    return false;
  }

  clear(): void {
    for (let i = 0; i < this.missiles.length; i += 1) {
      this.missiles[i].active = false;
      this.missiles[i].target = null;
      this.mesh.setMatrixAt(i, HIDDEN_MATRIX);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Forget a target that is being removed from the world. */
  forget(enemy: Enemy): void {
    for (const m of this.missiles) if (m.target === enemy) m.target = null;
  }

  update(dt: number, host: MissileHost): void {
    for (let i = 0; i < this.missiles.length; i += 1) {
      const m = this.missiles[i];
      if (!m.active) continue;
      m.age += dt;
      m.spin += dt * 9;
      m.speed = Math.min(MISSILE.maxSpeed, m.speed + MISSILE.accel * dt);

      // ---- guidance
      const target = m.target && m.target.alive ? m.target : null;
      if (!target) m.target = null;
      let fuse: Enemy | null = null;
      if (target && m.age > MISSILE.armTime) {
        const tv = target.vehicle;
        const range = Math.hypot(tv.x - m.x, tv.z - m.z);
        const lead = Math.min(0.5, range / Math.max(40, m.speed));
        let wx = tv.x + tv.vx * lead - m.x;
        let wy = tv.y + 0.95 - m.y;
        let wz = tv.z + tv.vz * lead - m.z;
        const wl = Math.hypot(wx, wy, wz) || 1;
        wx /= wl; wy /= wl; wz /= wl;
        const dot = Math.max(-1, Math.min(1, wx * m.dx + wy * m.dy + wz * m.dz));
        const angle = Math.acos(dot);
        const k = angle < 1e-4 ? 1 : Math.min(1, (MISSILE.turnRate * dt) / angle);
        m.dx += (wx - m.dx) * k;
        m.dy += (wy - m.dy) * k;
        m.dz += (wz - m.dz) * k;
        const inv = 1 / (Math.hypot(m.dx, m.dy, m.dz) || 1);
        m.dx *= inv; m.dy *= inv; m.dz *= inv;
        if (range < MISSILE.proximity + target.hitRadius) fuse = target;
      } else if (!target) {
        // unguided: level out and hold altitude
        m.dy += (0 - m.dy) * Math.min(1, dt * 6);
        const inv = 1 / (Math.hypot(m.dx, m.dy, m.dz) || 1);
        m.dx *= inv; m.dy *= inv; m.dz *= inv;
      }

      // ---- flight + collision
      const travel = m.speed * dt;
      const nx = m.x + m.dx * travel;
      let ny = m.y + m.dy * travel;
      const nz = m.z + m.dz * travel;
      const floor = groundHeight(nx, nz) + 0.45;
      if (ny < floor) {
        ny = floor;
        if (m.dy < 0) m.dy = 0;
      }
      let reach = host.grid.raycast(m.x, m.z, nx, nz);
      let direct: Enemy | null = null;
      let drum = -1;
      const drumIndex = host.drumHit(m.x, m.z, nx, nz);
      if (drumIndex >= 0 && host.drumHitT() <= reach) {
        reach = host.drumHitT();
        drum = drumIndex;
      }
      const samples = Math.max(1, Math.ceil(travel / 1.2));
      for (let s = 1; s <= samples && !direct; s += 1) {
        const t = s / samples;
        if (t > reach) break;
        const sx = m.x + (nx - m.x) * t;
        const sz = m.z + (nz - m.z) * t;
        for (const enemy of host.enemies) {
          if (enemy.alive && enemy.hitTest(sx, sz, 0.6)) {
            direct = enemy;
            reach = t;
            drum = -1;
            break;
          }
        }
      }
      if (!direct && fuse) direct = fuse;
      const outside = Math.abs(nx) > PLAY_HALF + 30 || Math.abs(nz) > PLAY_HALF + 30;
      if (direct || drum >= 0 || reach < 1 || m.age > MISSILE.life || outside) {
        const t = Math.min(1, reach);
        m.active = false;
        m.target = null;
        this.mesh.setMatrixAt(i, HIDDEN_MATRIX);
        // back off the wall a touch so the blast is not swallowed by geometry
        const bx = m.x + (nx - m.x) * t - m.dx * 0.6;
        const bz = m.z + (nz - m.z) * t - m.dz * 0.6;
        host.detonate(bx, m.y + (ny - m.y) * t, bz, direct, drum);
        continue;
      }
      m.x = nx;
      m.y = ny;
      m.z = nz;
      host.trail(m.x - m.dx * 0.9, m.y - m.dy * 0.9, m.z - m.dz * 0.9, m.dx, m.dy, m.dz, m.age < 0.35);
      this.direction.set(m.dx, m.dy, m.dz);
      this.quaternion.setFromUnitVectors(_forward, this.direction);
      this.rollQuaternion.setFromAxisAngle(_forward, m.spin);
      this.quaternion.multiply(this.rollQuaternion);
      this.matrix.compose(this.position.set(m.x, m.y, m.z), this.quaternion, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
