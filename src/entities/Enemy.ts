import * as THREE from 'three';
import { createRaiderBuggy, createWarRig } from '../assets/modelFactories/VehicleModels';
import { CITY, CITY_HALF, type ColliderGrid } from '../world/CityLayout';
import { Vehicle, type VehicleTuning, wrapAngle } from './Vehicle';

export type EnemyKind = 'gunner' | 'rammer' | 'rig';

const TUNING: Record<EnemyKind, VehicleTuning> = {
  gunner: { maxSpeed: 43, boostSpeed: 43, accel: 17, brake: 30, reverseSpeed: 10, grip: 27, driftGrip: 9, wheelBase: 2.5, mass: 1.0 },
  rammer: { maxSpeed: 47, boostSpeed: 56, accel: 20, brake: 30, reverseSpeed: 10, grip: 27, driftGrip: 9, wheelBase: 2.5, mass: 1.3 },
  rig: { maxSpeed: 29, boostSpeed: 29, accel: 9, brake: 20, reverseSpeed: 7, grip: 17, driftGrip: 9, wheelBase: 5.6, mass: 7 },
};

const HEALTH: Record<EnemyKind, number> = { gunner: 85, rammer: 120, rig: 1000 };

/** Everything an enemy needs from the game, kept narrow so AI stays testable. */
export interface EnemyHost {
  rng(): number;
  readonly grid: ColliderGrid;
  readonly player: Vehicle;
  enemyShot(enemy: Enemy, muzzle: THREE.Object3D, tx: number, ty: number, tz: number, spread: number, damage: number): void;
  mortar(enemy: Enemy, tx: number, tz: number, delay: number): void;
  telegraphSound(enemy: Enemy): void;
  /** An idle patrol/guard has just noticed the player. */
  alerted(enemy: Enemy): void;
}

/** hunt = chase the player; patrol = drive a street loop until alerted; guard = parked until alerted. */
export type EnemyMode = 'hunt' | 'patrol' | 'guard';
export const AGGRO = { patrol: 90, guard: 70, blind: 24, cruise: 16 } as const;

const _muzzle = new THREE.Vector3();

export class Enemy {
  readonly vehicle: Vehicle;
  readonly maxHealth: number;
  health: number;
  alive = true;
  /** Seconds since death, drives the burning-wreck fade. */
  deadFor = 0;
  /** 0..1 attack wind-up, shown on the accent lights. */
  telegraph = 0;
  readonly hitRadius: number;
  readonly bodyRadius: number;
  private fireCooldown: number;
  private burstLeft = 0;
  private burstTimer = 0;
  private windUp = 0;
  private mortarCooldown = 3.5;
  private stuckTimer = 0;
  private reverseTimer = 0;
  private reverseSteer = 1;
  private flank: number;
  private navX = 0;
  private navZ = 0;
  private navTimer = 0;
  enraged = false;
  /** Seconds until this enemy can deal or take ram damage again. */
  ramCooldown = 0;
  mode: EnemyMode = 'hunt';
  /** False while a patrol/guard has not noticed the player yet. */
  aware = true;
  /** Enemies sharing a squad id are alerted together (0 = none). */
  squad = 0;
  /** What landed the most recent damage (kill attribution for style bonuses). */
  lastHit: 'cannon' | 'missile' | 'ram' | 'barrel' | 'mortar' | 'other' = 'other';
  lastHitRange = 0;
  /** Game clock of that hit. */
  lastHitAt = -10;
  private route: { x: number; z: number }[] | null = null;
  private routeIndex = 0;

  constructor(readonly kind: EnemyKind, variant: number, flankSide: number, cooldownOffset: number, healthScale = 1) {
    const model = kind === 'rig' ? createWarRig() : createRaiderBuggy(variant);
    this.vehicle = new Vehicle(model, TUNING[kind]);
    this.maxHealth = Math.round(HEALTH[kind] * healthScale);
    this.health = this.maxHealth;
    this.hitRadius = kind === 'rig' ? model.halfExtents.x * 1.25 : Math.max(model.halfExtents.x * 1.3, 1.5);
    this.bodyRadius = kind === 'rig' ? model.halfExtents.x * 1.5 : model.halfExtents.x * 1.25;
    this.flank = flankSide;
    this.fireCooldown = 1.5 + cooldownOffset;
  }

  /** Keep weapons quiet for a while (cinematics, fresh spawns). */
  holdFire(seconds: number): void {
    this.fireCooldown = Math.max(this.fireCooldown, seconds);
    this.mortarCooldown = Math.max(this.mortarCooldown, seconds + 1.5);
  }

  /** Drive a loop of street junctions until the player is spotted. */
  setPatrol(route: { x: number; z: number }[], startIndex: number): void {
    this.mode = 'patrol';
    this.aware = false;
    this.route = route;
    this.routeIndex = startIndex % route.length;
  }

  /** Sit parked until the player comes close. */
  setGuard(): void {
    this.mode = 'guard';
    this.aware = false;
  }

  alert(): void {
    if (this.aware) return;
    this.aware = true;
    this.fireCooldown = Math.max(this.fireCooldown, 1.1);
  }

  /** Circles along the hull used for bullet hits (longer for the rig). */
  hitTest(px: number, pz: number, radius: number): boolean {
    const v = this.vehicle;
    const reach = this.hitRadius + radius;
    if (this.kind !== 'rig') {
      const dx = px - v.x;
      const dz = pz - v.z;
      return dx * dx + dz * dz < reach * reach;
    }
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const span = v.model.halfExtents.z * 0.62;
    for (let n = -1; n <= 1; n += 1) {
      const dx = px - (v.x + fx * span * n);
      const dz = pz - (v.z + fz * span * n);
      if (dx * dx + dz * dz < reach * reach) return true;
    }
    return false;
  }

  think(dt: number, host: EnemyHost): void {
    this.ramCooldown = Math.max(0, this.ramCooldown - dt);
    const v = this.vehicle;
    const p = host.player;
    const c = v.controls;
    const dx = p.x - v.x;
    const dz = p.z - v.z;
    const dist = Math.hypot(dx, dz);
    const sight = host.grid.lineOfSight(v.x, v.z, p.x, p.z);

    if (!this.aware) {
      const range = this.mode === 'guard' ? AGGRO.guard : AGGRO.patrol;
      if ((dist < range && sight) || dist < AGGRO.blind) host.alerted(this);
    }
    if (!this.aware && (this.mode === 'guard' || !this.route)) {
      // parked: engine idling, lights low
      c.throttle = 0;
      c.steer = 0;
      c.boost = false;
      c.handbrake = true;
      this.telegraph = 0;
      v.model.accentMaterial.emissiveIntensity = 0.7;
      return;
    }

    // ---- choose a point to drive at
    let tx = p.x;
    let tz = p.z;
    const idle = !this.aware;
    if (idle && this.route) {
      let wp = this.route[this.routeIndex];
      if (Math.hypot(wp.x - v.x, wp.z - v.z) < 15) {
        this.routeIndex = (this.routeIndex + 1) % this.route.length;
        wp = this.route[this.routeIndex];
      }
      tx = wp.x;
      tz = wp.z;
    } else if (sight) {
      const lead = Math.min(1.2, dist / 55);
      tx = p.x + p.vx * lead;
      tz = p.z + p.vz * lead;
      if (this.kind === 'gunner' && dist < 70) {
        // gunners hold a flanking offset instead of ramming
        const pfx = Math.sin(p.heading);
        const pfz = Math.cos(p.heading);
        tx += pfz * 15 * this.flank + pfx * 6;
        tz += -pfx * 15 * this.flank + pfz * 6;
      }
    } else {
      this.navTimer -= dt;
      if (this.navTimer <= 0) {
        this.navTimer = 0.35;
        this.pickRoadTarget(p.x, p.z);
      }
      tx = this.navX;
      tz = this.navZ;
    }

    const desired = Math.atan2(tx - v.x, tz - v.z);
    let diff = wrapAngle(desired - v.heading);
    let throttle = 1;
    let handbrake = false;

    // ---- obstacle feelers
    const look = 9 + Math.abs(v.forwardSpeed) * 0.55;
    const ahead = this.feel(host.grid, v.heading, look);
    if (ahead < 1) {
      const left = this.feel(host.grid, v.heading + 0.6, look * 0.9);
      const right = this.feel(host.grid, v.heading - 0.6, look * 0.9);
      const dodge = left > right ? 1 : -1;
      diff = dodge * (1.1 - ahead * 0.6);
      if (ahead < 0.45 && v.forwardSpeed > 14) throttle = -0.6;
      else throttle = 0.55;
    }

    if (Math.abs(diff) > 1.25 && v.forwardSpeed > 16) {
      throttle = 0.2;
      handbrake = true;
    }
    if (idle) {
      // patrol pace: unhurried, slowing for junction turns
      const cruise = Math.abs(diff) > 0.5 ? AGGRO.cruise * 0.6 : AGGRO.cruise;
      if (v.forwardSpeed > cruise) throttle = Math.min(throttle, v.forwardSpeed > cruise + 4 ? -0.4 : 0);
      else throttle = Math.min(throttle, 0.6);
      handbrake = false;
    }
    if (this.kind === 'gunner' && sight && dist < 26 && Math.abs(diff) < 0.6) throttle = Math.min(throttle, 0.45);
    if (this.kind === 'rig' && sight && dist < 20 && v.forwardSpeed > 12 && Math.abs(diff) > 0.7) throttle = 0.3;

    // ---- unstick
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      c.throttle = -1;
      c.steer = this.reverseSteer;
      c.handbrake = false;
      c.boost = false;
    } else {
      if (Math.abs(v.forwardSpeed) < 1.6 && throttle > 0) this.stuckTimer += dt;
      else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
      if (this.stuckTimer > 1.1) {
        this.stuckTimer = 0;
        this.reverseTimer = this.kind === 'rig' ? 1.7 : 1.0;
        this.reverseSteer = diff > 0 ? 1 : -1;
      }
      c.throttle = throttle;
      // heading increases when steer is negative
      c.steer = Math.max(-1, Math.min(1, -diff * 2.4));
      c.handbrake = handbrake;
      const charging = !idle && this.kind === 'rammer' && sight && dist < 55 && Math.abs(diff) < 0.3;
      c.boost = charging;
      if (this.kind === 'rammer') this.telegraph += ((charging ? 1 : 0) - this.telegraph) * Math.min(1, dt * 6);
    }

    if (idle) {
      this.telegraph = 0;
      v.model.accentMaterial.emissiveIntensity = 1.1;
      return;
    }

    // ---- weapons
    if (this.kind === 'gunner') this.thinkGuns(dt, host, dist, sight, 62, 4, 0.11, 4.2, 0.055);
    if (this.kind === 'rig') {
      this.thinkGuns(dt, host, dist, sight, 40, 4, 0.1, 3.8, 0.085);
      this.mortarCooldown -= dt;
      if (this.mortarCooldown <= 0 && dist < 150 && dist > 12) {
        const shells = this.enraged ? 3 : 1;
        this.mortarCooldown = this.enraged ? 3.6 : 5.0;
        for (let n = 0; n < shells; n += 1) {
          const lead = 1.25 + n * 0.5;
          const jitter = n === 0 ? 7 : 12;
          const mx = p.x + p.vx * lead + (host.rng() - 0.5) * jitter;
          const mz = p.z + p.vz * lead + (host.rng() - 0.5) * jitter;
          host.mortar(this, mx, mz, 1.55 + n * 0.28);
        }
      }
    }
    const accent = v.model.accentMaterial;
    accent.emissiveIntensity = 1.6 + this.telegraph * 9 + (this.enraged ? 1.5 : 0);
  }

  private thinkGuns(
    dt: number, host: EnemyHost, dist: number, sight: boolean,
    range: number, burst: number, interval: number, cooldown: number, spread: number,
  ): void {
    const v = this.vehicle;
    const p = host.player;
    if (this.burstLeft > 0) {
      this.burstTimer -= dt;
      this.telegraph = 1;
      if (this.burstTimer <= 0) {
        this.burstTimer = interval;
        this.burstLeft -= 1;
        const muzzle = this.pickMuzzle(p.x, p.z);
        const lead = dist / 130;
        host.enemyShot(this, muzzle, p.x + p.vx * lead, p.y + 0.9, p.z + p.vz * lead, spread, 3);
        if (this.burstLeft === 0) this.fireCooldown = cooldown * (0.8 + host.rng() * 0.5);
      }
      return;
    }
    if (this.windUp > 0) {
      this.windUp -= dt;
      this.telegraph = Math.min(1, this.telegraph + dt * 2.6);
      if (this.windUp <= 0) {
        this.burstLeft = burst;
        this.burstTimer = 0;
      }
      return;
    }
    this.telegraph = Math.max(0, this.telegraph - dt * 3);
    this.fireCooldown -= dt;
    if (this.fireCooldown > 0 || !sight || dist > range) return;
    const bearing = Math.abs(wrapAngle(Math.atan2(p.x - v.x, p.z - v.z) - v.heading));
    if (this.kind === 'gunner' && bearing > 1.25) return;
    this.windUp = 0.5;
    host.telegraphSound(this);
  }

  private pickMuzzle(px: number, pz: number): THREE.Object3D {
    const muzzles = this.vehicle.model.muzzles;
    if (this.kind !== 'rig' || muzzles.length < 3) return muzzles[0];
    // rig: muzzle 0 is the mortar, use whichever side gun faces the player
    let best = muzzles[1];
    let bestDist = Infinity;
    for (let n = 1; n < muzzles.length; n += 1) {
      muzzles[n].getWorldPosition(_muzzle);
      const d = (px - _muzzle.x) ** 2 + (pz - _muzzle.z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = muzzles[n];
      }
    }
    return best;
  }

  private feel(grid: ColliderGrid, heading: number, length: number): number {
    const v = this.vehicle;
    return grid.raycast(v.x, v.z, v.x + Math.sin(heading) * length, v.z + Math.cos(heading) * length);
  }

  /** No line of sight: follow the street grid toward the player's nearest junction. */
  private pickRoadTarget(px: number, pz: number): void {
    const v = this.vehicle;
    const pitch = CITY.pitch;
    const max = CITY.blocksPerSide;
    const node = (value: number) => Math.max(0, Math.min(max, Math.round((value + CITY_HALF) / pitch)));
    const centre = (index: number) => index * pitch - CITY_HALF;
    const ei = node(v.x);
    const ej = node(v.z);
    const pi = node(px);
    const pj = node(pz);
    const nodeX = centre(ei);
    const nodeZ = centre(ej);
    const offX = Math.abs(v.x - nodeX);
    const offZ = Math.abs(v.z - nodeZ);
    const lane = 5.5 * this.flank;
    if (offX > 16 && offZ <= 16) {
      // on an east-west street: run along it toward the player's column
      const dir = px > v.x ? 1 : -1;
      const next = Math.max(0, Math.min(max, Math.floor((v.x + CITY_HALF) / pitch) + (dir > 0 ? 1 : 0)));
      this.navX = centre(next);
      this.navZ = nodeZ + lane;
      return;
    }
    if (offZ > 16 && offX <= 16) {
      const dir = pz > v.z ? 1 : -1;
      const next = Math.max(0, Math.min(max, Math.floor((v.z + CITY_HALF) / pitch) + (dir > 0 ? 1 : 0)));
      this.navX = nodeX + lane;
      this.navZ = centre(next);
      return;
    }
    if (offX > 16 && offZ > 16) {
      // inside a block (plaza or pushed off-road): regain the nearest street
      if (offX < offZ) {
        this.navX = nodeX;
        this.navZ = v.z;
      } else {
        this.navX = v.x;
        this.navZ = nodeZ;
      }
      return;
    }
    // at a junction: step along the axis with the most ground to cover
    const di = pi - ei;
    const dj = pj - ej;
    if (di === 0 && dj === 0) {
      this.navX = px;
      this.navZ = pz;
    } else if (Math.abs(px - v.x) > Math.abs(pz - v.z) && di !== 0) {
      this.navX = centre(ei + Math.sign(di));
      this.navZ = nodeZ + lane;
    } else if (dj !== 0) {
      this.navX = nodeX + lane;
      this.navZ = centre(ej + Math.sign(dj));
    } else {
      this.navX = centre(ei + Math.sign(di));
      this.navZ = nodeZ + lane;
    }
  }
}
