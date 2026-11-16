import type { VehicleModel } from '../game/contracts';
import { type Aabb, type ColliderGrid, PLAY_HALF, groundHeight } from '../world/CityLayout';

export type VehicleTuning = {
  maxSpeed: number;
  boostSpeed: number;
  accel: number;
  brake: number;
  reverseSpeed: number;
  /** Peak cornering acceleration in m/s^2 before the tyres let go. */
  grip: number;
  /** Lateral friction while the handbrake is held. */
  driftGrip: number;
  wheelBase: number;
  mass: number;
};

export const HERO_TUNING: VehicleTuning = {
  maxSpeed: 50,
  boostSpeed: 68,
  accel: 19,
  brake: 36,
  reverseSpeed: 13,
  grip: 30,
  driftGrip: 8.5,
  wheelBase: 2.8,
  mass: 1.6,
};

export type VehicleControls = { throttle: number; steer: number; handbrake: boolean; boost: boolean };

const TWO_PI = Math.PI * 2;
/** Above this speed a soft (wreck) collider is smashed aside, keeping PLOW_KEEP of the car's speed. */
export const PLOW_SPEED = 14;
const PLOW_KEEP = 0.65;

export function wrapAngle(a: number): number {
  let r = a % TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  if (r < -Math.PI) r += TWO_PI;
  return r;
}

/**
 * Arcade car: bicycle steering with a grip-limited lateral model so the car
 * drifts when pushed, two collision circles against the static city, and a
 * sprung body that leans with acceleration.
 */
export class Vehicle {
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  vx = 0;
  vz = 0;
  /** Signed speed along the facing direction, m/s. */
  forwardSpeed = 0;
  /** Sideways slip speed, m/s (0 when gripping). */
  slip = 0;
  /** Largest wall impact speed since the owner last cleared it (m/s), 0 if none. */
  impact = 0;
  impactNx = 0;
  impactNz = 0;
  /** When true (the player), a fast hit on a `soft` collider ploughs through it instead of stopping. */
  plow = false;
  /** Speed (m/s) at which a soft collider was ploughed since the owner last cleared it, 0 if none. */
  softImpact = 0;
  softX = 0;
  softZ = 0;
  private ghost: Aabb | null = null;
  private ghostSeen = false;
  readonly controls: VehicleControls = { throttle: 0, steer: 0, handbrake: false, boost: false };
  readonly circleOffset: number;
  readonly circleRadius: number;
  private steerVisual = 0;
  private roll = 0;
  private pitch = 0;
  private wheelSpin = 0;
  private lastForward = 0;
  private bob = 0;

  constructor(readonly model: VehicleModel, readonly tuning: VehicleTuning) {
    this.circleRadius = Math.max(0.9, model.halfExtents.x * 1.02);
    this.circleOffset = Math.max(0, model.halfExtents.z - this.circleRadius);
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  place(x: number, z: number, heading: number): void {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.vx = 0;
    this.vz = 0;
    this.forwardSpeed = 0;
    this.slip = 0;
    this.lastForward = 0;
    this.roll = 0;
    this.pitch = 0;
    this.ghost = null;
    this.softImpact = 0;
    this.y = groundHeight(x, z);
    this.syncVisual(0);
  }

  step(dt: number, grid: ColliderGrid): void {
    const t = this.tuning;
    const c = this.controls;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    // left-hand vector in this convention (screen right is -lx)
    const lx = fz;
    const lz = -fx;
    let vf = this.vx * fx + this.vz * fz;
    let vl = this.vx * lx + this.vz * lz;

    const top = c.boost ? t.boostSpeed : t.maxSpeed;
    if (c.throttle > 0) {
      if (vf < -0.5) vf += t.brake * c.throttle * dt;
      else {
        const ratio = Math.max(0, vf) / top;
        const pull = t.accel * (c.boost ? 1.75 : 1) * (1 - ratio * ratio) * (0.55 + 0.45 * Math.min(1, vf / 12 + 0.4));
        vf += pull * c.throttle * dt;
      }
    } else if (c.throttle < 0) {
      if (vf > 0.5) vf = Math.max(0, vf + t.brake * c.throttle * dt);
      else if (vf > -t.reverseSpeed) vf += t.accel * 0.7 * c.throttle * dt;
    }
    // rolling resistance and aero drag; bleed speed above the current top speed
    const drag = 0.35 + 0.012 * Math.abs(vf) + (Math.abs(vf) > top ? 1.2 : 0);
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), drag * dt * (c.throttle === 0 ? 3.2 : 1));
    if (c.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 9 * dt);

    // steering: geometric yaw rate capped by available grip
    const lock = 0.6 / (1 + Math.abs(vf) / 16);
    let yawRate = (vf / t.wheelBase) * Math.tan(c.steer * lock);
    const gripLimit = (c.handbrake ? t.grip * 1.5 : t.grip) / Math.max(6, Math.abs(vf));
    yawRate = Math.max(-gripLimit, Math.min(gripLimit, yawRate));
    this.heading = wrapAngle(this.heading - yawRate * dt);

    // momentum carries on in world space; the tyres then remove slip in the new
    // frame at a limited rate, and whatever is left over is the drift
    const pvx = fx * vf + lx * vl;
    const pvz = fz * vf + lz * vl;
    const nfx = Math.sin(this.heading);
    const nfz = Math.cos(this.heading);
    let newVf = pvx * nfx + pvz * nfz;
    let newVl = pvx * nfz - pvz * nfx;
    const lateralGrip = c.handbrake ? t.driftGrip : t.grip * 1.15;
    newVl -= Math.sign(newVl) * Math.min(Math.abs(newVl), lateralGrip * dt);
    newVf -= Math.sign(newVf) * Math.min(Math.abs(newVf), Math.abs(newVl) * 0.3 * dt);
    this.vx = nfx * newVf + nfz * newVl;
    this.vz = nfz * newVf - nfx * newVl;

    this.x += this.vx * dt;
    this.z += this.vz * dt;

    this.ghostSeen = false;
    this.resolveStatic(grid, 1);
    this.resolveStatic(grid, -1);
    if (!this.ghostSeen) this.ghost = null;

    const fx2 = Math.sin(this.heading);
    const fz2 = Math.cos(this.heading);
    this.forwardSpeed = this.vx * fx2 + this.vz * fz2;
    this.slip = this.vx * fz2 - this.vz * fx2;
    this.y = groundHeight(this.x, this.z);
  }

  private resolveStatic(grid: ColliderGrid, sign: number): void {
    const r = this.circleRadius;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    let cx = this.x + fx * this.circleOffset * sign;
    let cz = this.z + fz * this.circleOffset * sign;

    const push = (nx: number, nz: number, depth: number) => {
      this.x += nx * depth;
      this.z += nz * depth;
      cx += nx * depth;
      cz += nz * depth;
      const vn = this.vx * nx + this.vz * nz;
      if (vn < 0) {
        this.vx -= 1.22 * vn * nx;
        this.vz -= 1.22 * vn * nz;
        // scraping friction along the wall
        this.vx *= 0.992;
        this.vz *= 0.992;
        if (-vn > this.impact) {
          this.impact = -vn;
          this.impactNx = nx;
          this.impactNz = nz;
        }
      }
      // a hit on one end swings the car round
      const twist = (fz * nx - fx * nz) * depth * sign;
      this.heading = wrapAngle(this.heading + (twist / Math.max(1.2, this.circleOffset + r)) * 0.55);
    };

    const visit = (box: Aabb) => {
      const px = Math.max(box.minX, Math.min(cx, box.maxX));
      const pz = Math.max(box.minZ, Math.min(cz, box.maxZ));
      let dx = cx - px;
      let dz = cz - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) return;
      if (box === this.ghost) {
        // still passing through the wreck that was just ploughed aside
        this.ghostSeen = true;
        return;
      }
      if (box.soft && this.plow) {
        const speed = Math.hypot(this.vx, this.vz);
        if (speed > PLOW_SPEED) {
          this.vx *= PLOW_KEEP;
          this.vz *= PLOW_KEEP;
          this.softImpact = speed;
          this.softX = px;
          this.softZ = pz;
          this.ghost = box;
          this.ghostSeen = true;
          return;
        }
      }
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        push(dx / d, dz / d, r - d);
        return;
      }
      // centre is inside the box: leave through the nearest face
      const left = cx - box.minX;
      const right = box.maxX - cx;
      const back = cz - box.minZ;
      const front = box.maxZ - cz;
      const min = Math.min(left, right, back, front);
      dx = 0;
      dz = 0;
      if (min === left) dx = -1;
      else if (min === right) dx = 1;
      else if (min === back) dz = -1;
      else dz = 1;
      push(dx, dz, min + r);
    };
    grid.query(cx - r, cx + r, cz - r, cz + r, visit);

    const limit = PLAY_HALF - r;
    if (cx > limit) push(-1, 0, cx - limit);
    else if (cx < -limit) push(1, 0, -limit - cx);
    if (cz > limit) push(0, -1, cz - limit);
    else if (cz < -limit) push(0, 1, -limit - cz);
  }

  /** Drive the model: position, body lean, wheel spin and steering lock. */
  syncVisual(dt: number): void {
    const model = this.model;
    model.root.position.set(this.x, this.y, this.z);
    model.root.rotation.y = this.heading;
    if (dt <= 0) return;
    const accel = (this.forwardSpeed - this.lastForward) / dt;
    this.lastForward = this.forwardSpeed;
    const lerp = 1 - Math.exp(-dt * 9);
    const targetPitch = Math.max(-0.07, Math.min(0.07, -accel * 0.0028));
    const targetRoll = Math.max(-0.11, Math.min(0.11, this.slip * 0.013 + this.controls.steer * Math.min(1, Math.abs(this.forwardSpeed) / 30) * -0.05));
    this.pitch += (targetPitch - this.pitch) * lerp;
    this.roll += (targetRoll - this.roll) * lerp;
    this.bob += dt * (6 + Math.abs(this.forwardSpeed) * 0.9);
    const rough = Math.min(1, Math.abs(this.forwardSpeed) / 40);
    model.body.rotation.x = this.pitch + Math.sin(this.bob * 1.7) * 0.0035 * rough;
    model.body.rotation.z = this.roll + Math.sin(this.bob) * 0.004 * rough;
    model.body.position.y = Math.sin(this.bob * 1.3) * 0.012 * rough;

    this.wheelSpin += (this.forwardSpeed / model.wheelRadius) * dt;
    for (let i = 0; i < model.wheels.length; i += 1) model.wheels[i].rotation.x = this.wheelSpin;
    this.steerVisual += (-this.controls.steer * 0.42 - this.steerVisual) * (1 - Math.exp(-dt * 12));
    for (let i = 0; i < model.steerPivots.length; i += 1) model.steerPivots[i].rotation.y = this.steerVisual;
  }
}

/** Separate two vehicles treated as discs; returns the closing speed along the contact normal (0 if apart). */
export function collideVehicles(a: Vehicle, b: Vehicle, radiusA: number, radiusB: number): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = Math.hypot(dx, dz);
  const min = radiusA + radiusB;
  if (dist >= min || dist < 1e-4) return 0;
  const nx = dx / dist;
  const nz = dz / dist;
  const total = a.tuning.mass + b.tuning.mass;
  const shareA = b.tuning.mass / total;
  const shareB = a.tuning.mass / total;
  const overlap = min - dist;
  a.x -= nx * overlap * shareA;
  a.z -= nz * overlap * shareA;
  b.x += nx * overlap * shareB;
  b.z += nz * overlap * shareB;
  const rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
  if (rel <= 0) return 0;
  const impulse = rel * 1.3;
  a.vx -= nx * impulse * shareA;
  a.vz -= nz * impulse * shareA;
  b.vx += nx * impulse * shareB;
  b.vz += nz * impulse * shareB;
  return rel;
}
