import type { Vehicle } from '../entities/Vehicle';
import type { Aabb, ColliderGrid } from '../world/CityLayout';

/** Chain thresholds: the multiplier steps up when the chain count reaches each value. */
const COMBO_STEPS = [1, 2, 4, 6, 9];
export const COMBO_WINDOW = 6;

export type ScoreSnapshot = { score: number; scrap: number; bestCombo: number };

/** Score, scrap and the kill/style chain. Pure bookkeeping: no audio, no HUD. */
export class ScoreSystem {
  score = 0;
  scrap = 0;
  comboCount = 0;
  comboTimer = 0;
  multiplier = 1;
  bestCombo = 0;

  reset(): void {
    this.score = 0;
    this.scrap = 0;
    this.bestCombo = 0;
    this.clearCombo();
  }

  clearCombo(): void {
    this.comboCount = 0;
    this.comboTimer = 0;
    this.multiplier = 1;
  }

  snapshot(): ScoreSnapshot {
    return { score: this.score, scrap: this.scrap, bestCombo: this.bestCombo };
  }

  restore(snapshot: ScoreSnapshot): void {
    this.score = snapshot.score;
    this.scrap = snapshot.scrap;
    this.bestCombo = snapshot.bestCombo;
    this.clearCombo();
  }

  /** Extend the chain. Returns true when the multiplier stepped up. */
  chain(): boolean {
    this.comboCount += 1;
    this.comboTimer = COMBO_WINDOW;
    if (this.comboCount > this.bestCombo) this.bestCombo = this.comboCount;
    let multiplier = 1;
    for (let i = 0; i < COMBO_STEPS.length; i += 1) if (this.comboCount >= COMBO_STEPS[i]) multiplier = i + 1;
    const stepped = multiplier > this.multiplier;
    this.multiplier = multiplier;
    return stepped;
  }

  /** Add points scaled by the current multiplier; returns the amount actually awarded. */
  award(points: number): number {
    const value = Math.round(points * this.multiplier);
    this.score += value;
    return value;
  }

  /** Returns true on the frame the chain expires (only chains of 2+ count as a break). */
  update(dt: number): boolean {
    if (this.comboCount === 0) return false;
    this.comboTimer -= dt;
    if (this.comboTimer > 0) return false;
    const broke = this.comboCount >= 2;
    this.clearCombo();
    return broke;
  }

  get timer01(): number {
    return this.comboCount === 0 ? 0 : Math.max(0, Math.min(1, this.comboTimer / COMBO_WINDOW));
  }
}

/** S/A/B/C/D from score with a pace bonus and a damage penalty. */
export function computeRank(score: number, timeSec: number, damageTaken: number): string {
  const rating = score + Math.max(0, 420 - timeSec) * 6 - damageTaken * 7;
  if (rating >= 9000) return 'S';
  if (rating >= 6800) return 'A';
  if (rating >= 4800) return 'B';
  if (rating >= 3000) return 'C';
  return 'D';
}

/**
 * Sustained-slip detector. A drift banks time x angle while the car slides at
 * speed and pays out when the slide ends without a hit; a crash voids it.
 */
export class DriftTracker {
  /** Seconds of the drift currently being banked (0 when gripping). */
  time = 0;
  private angle = 0;
  private grace = 0;

  reset(): void {
    this.time = 0;
    this.angle = 0;
    this.grace = 0;
  }

  /** Returns the points to pay out this step (0 almost always). */
  update(dt: number, vehicle: Vehicle, crashed: boolean): number {
    const speed = vehicle.speed;
    const slip = Math.abs(vehicle.slip);
    if (crashed) {
      this.reset();
      return 0;
    }
    if (slip > 5 && speed > 15 && vehicle.forwardSpeed > 6) {
      this.time += dt;
      this.angle += Math.min(1, slip / Math.max(10, speed)) * dt;
      this.grace = 0.3;
      return 0;
    }
    if (this.time <= 0) return 0;
    this.grace -= dt;
    if (this.grace > 0 && slip > 2) return 0;
    const time = this.time;
    const avgAngle = this.angle / Math.max(0.01, time);
    this.reset();
    if (time < 0.7) return 0;
    return Math.min(800, Math.round((60 + time * 110) * (0.7 + avgAngle * 1.6) / 10) * 10);
  }
}

/**
 * Near-miss detector: remembers the closest static obstacle while the car is
 * fast, and reports a clean pass once that obstacle is behind it.
 */
export class NearMissTracker {
  private candidate: Aabb | null = null;
  private candidateGap = 0;
  private cooldown = 0;
  private bestBox: Aabb | null = null;
  private bestGap = 0;
  private px = 0;
  private pz = 0;
  private readonly visit = (box: Aabb) => {
    const cx = Math.max(box.minX, Math.min(this.px, box.maxX));
    const cz = Math.max(box.minZ, Math.min(this.pz, box.maxZ));
    const gap = Math.hypot(this.px - cx, this.pz - cz);
    if (gap < this.bestGap) {
      this.bestGap = gap;
      this.bestBox = box;
    }
  };

  reset(): void {
    this.candidate = null;
    this.cooldown = 0;
  }

  /** Returns the clearance in metres of a completed near miss, or -1. */
  update(dt: number, vehicle: Vehicle, grid: ColliderGrid, touched: boolean, minSpeed: number): number {
    this.cooldown -= dt;
    if (touched) {
      this.candidate = null;
      this.cooldown = 1.2;
      return -1;
    }
    this.px = vehicle.x;
    this.pz = vehicle.z;
    const body = vehicle.circleRadius;
    if (this.candidate) {
      const box = this.candidate;
      const cx = Math.max(box.minX, Math.min(this.px, box.maxX));
      const cz = Math.max(box.minZ, Math.min(this.pz, box.maxZ));
      const gap = Math.hypot(this.px - cx, this.pz - cz) - body;
      if (gap < this.candidateGap) this.candidateGap = gap;
      if (gap > 3.2) {
        this.candidate = null;
        if (vehicle.speed > minSpeed * 0.85 && this.cooldown <= 0) {
          this.cooldown = 1.6;
          return Math.max(0, this.candidateGap);
        }
      }
      return -1;
    }
    if (vehicle.speed < minSpeed || this.cooldown > 0) return -1;
    this.bestBox = null;
    this.bestGap = body + 1.0;
    grid.query(this.px - 3, this.px + 3, this.pz - 3, this.pz + 3, this.visit);
    if (this.bestBox) {
      this.candidate = this.bestBox;
      this.candidateGap = this.bestGap - body;
    }
    return -1;
  }
}
