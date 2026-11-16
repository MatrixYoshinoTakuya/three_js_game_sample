import * as THREE from 'three';
import type { Vehicle } from '../entities/Vehicle';
import { wrapAngle } from '../entities/Vehicle';
import type { ColliderGrid } from '../world/CityLayout';

/**
 * Chase camera with speed-driven FOV, drift-aware heading lag, trauma shake
 * and a wall check so tower corners never swallow the view. Cinematic shots
 * drive `position`/`target` directly through `setShot`.
 */
export class CameraRig {
  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly desiredTarget = new THREE.Vector3();
  private camHeading = 0;
  private fov = 58;
  private trauma = 0;
  private shakeTime = 0;
  private roll = 0;
  private portrait = false;
  reducedMotion = false;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  setAspect(aspect: number): void {
    this.portrait = aspect < 0.9;
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  snapTo(vehicle: Vehicle): void {
    this.camHeading = vehicle.heading;
    this.computeChase(vehicle, 0, false);
    this.position.copy(this.desired);
    this.target.copy(this.desiredTarget);
    this.fov = this.portrait ? 74 : 58;
    this.roll = 0;
    this.trauma = 0;
    this.apply(0);
  }

  private computeChase(vehicle: Vehicle, speed01: number, boosting: boolean): void {
    const distance = (this.portrait ? 10.5 : 7.9) + speed01 * 1.6 - (boosting ? 0.9 : 0);
    const height = (this.portrait ? 4.1 : 2.75) + speed01 * 0.25;
    const sx = Math.sin(this.camHeading);
    const sz = Math.cos(this.camHeading);
    this.desired.set(vehicle.x - sx * distance, vehicle.y + height, vehicle.z - sz * distance);
    const fx = Math.sin(vehicle.heading);
    const fz = Math.cos(vehicle.heading);
    const ahead = 5 + speed01 * 7;
    this.desiredTarget.set(vehicle.x + fx * ahead, vehicle.y + 1.35 + speed01 * 0.5, vehicle.z + fz * ahead);
  }

  updateChase(dt: number, vehicle: Vehicle, grid: ColliderGrid, boosting: boolean): void {
    const speed = vehicle.speed;
    const speed01 = Math.min(1, speed / 62);
    // follow the direction of travel when sliding so the drift angle reads
    let follow = vehicle.heading;
    if (speed > 6 && vehicle.forwardSpeed > 0) {
      const travel = Math.atan2(vehicle.vx, vehicle.vz);
      follow = vehicle.heading + wrapAngle(travel - vehicle.heading) * 0.55;
    }
    this.camHeading += wrapAngle(follow - this.camHeading) * (1 - Math.exp(-dt * (3.2 + speed01 * 3)));
    this.computeChase(vehicle, speed01, boosting);

    // keep the lens out of buildings
    const hit = grid.raycast(vehicle.x, vehicle.z, this.desired.x, this.desired.z);
    if (hit < 1) {
      const t = Math.max(0.22, hit - 0.08);
      this.desired.x = vehicle.x + (this.desired.x - vehicle.x) * t;
      this.desired.z = vehicle.z + (this.desired.z - vehicle.z) * t;
      this.desired.y += (1 - t) * 2.2;
    }

    const k = 1 - Math.exp(-dt * 9);
    this.position.lerp(this.desired, k);
    this.target.lerp(this.desiredTarget, 1 - Math.exp(-dt * 11));
    const baseFov = this.portrait ? 74 : 56;
    const targetFov = baseFov + speed01 * 15 + (boosting ? 9 : 0);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-dt * 3.5));
    const targetRoll = Math.max(-0.05, Math.min(0.05, -vehicle.slip * 0.004 + vehicle.controls.steer * speed01 * 0.018));
    this.roll += (targetRoll - this.roll) * (1 - Math.exp(-dt * 4));
    this.apply(dt);
  }

  /** Scripted shot; `blend` 1 snaps, lower values ease toward it. */
  setShot(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov: number, dt: number, blend = 1): void {
    const k = blend >= 1 ? 1 : 1 - Math.exp(-dt * blend);
    this.position.lerp(this.desired.set(px, py, pz), k);
    this.target.lerp(this.desiredTarget.set(tx, ty, tz), k);
    this.fov += ((this.portrait ? fov + 14 : fov) - this.fov) * k;
    this.roll += (0 - this.roll) * k;
    this.apply(dt);
  }

  private apply(dt: number): void {
    const camera = this.camera;
    camera.position.copy(this.position);
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    let rollShake = 0;
    if (this.trauma > 0 && !this.reducedMotion) {
      this.shakeTime += dt * 38;
      const power = this.trauma * this.trauma;
      camera.position.x += Math.sin(this.shakeTime * 1.3) * Math.cos(this.shakeTime * 0.7) * 0.42 * power;
      camera.position.y += Math.sin(this.shakeTime * 1.9 + 1.7) * 0.36 * power;
      camera.position.z += Math.cos(this.shakeTime * 1.1 + 0.4) * 0.3 * power;
      rollShake = Math.sin(this.shakeTime * 1.6) * 0.025 * power;
    }
    camera.lookAt(this.target);
    camera.rotateZ(this.roll + rollShake);
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }
}
