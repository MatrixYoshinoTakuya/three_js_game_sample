import * as THREE from 'three';
import { groundHeight } from '../world/CityLayout';
import { HIDDEN_MATRIX, PartBuilder, createPropMaterial } from './PropGeometry';

export type PickupKind = 'scrap' | 'repair' | 'boost' | 'missile';

export type Pickup = {
  active: boolean;
  kind: PickupKind;
  slot: number;
  ring: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Seconds alive (drives pop-in, bob phase and the magnet arming delay). */
  age: number;
  /** Seconds until a dropped pickup expires; Infinity for authored street pickups. */
  life: number;
  value: number;
  phase: number;
  pulled: boolean;
};

const KINDS: PickupKind[] = ['scrap', 'repair', 'boost', 'missile'];
const CAPACITY: Record<PickupKind, number> = { scrap: 150, repair: 10, boost: 10, missile: 10 };
export const PICKUP_COLORS: Record<PickupKind, [number, number, number]> = {
  scrap: [1.0, 0.62, 0.16],
  repair: [0.25, 1.0, 0.5],
  boost: [0.25, 0.7, 1.0],
  missile: [1.0, 0.22, 0.32],
};
const SCALE: Record<PickupKind, number> = { scrap: 1.05, repair: 1.2, boost: 1.25, missile: 1.2 };
const HOVER: Record<PickupKind, number> = { scrap: 0.75, repair: 0.95, boost: 0.95, missile: 0.9 };
const COLLECT_RADIUS = 2.4;

function scrapGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder();
  // torn plates, a gear, a nut and bolt: salvage, not a coin
  b.bevel(0.74, 0.07, 0.5, 0.03, '#8d8378', { x: -0.08, y: -0.06, rz: 0.42, ry: 0.3 });
  b.bevel(0.56, 0.06, 0.44, 0.03, '#a85a2a', { x: 0.14, y: 0.08, z: 0.08, rx: 0.95, ry: 0.7 });
  b.bevel(0.44, 0.06, 0.5, 0.03, '#6b665f', { x: -0.2, y: 0.14, z: -0.1, rz: -0.95, rx: 0.3 });
  b.bevel(0.3, 0.05, 0.26, 0.02, '#c2702e', { x: 0.26, y: -0.2, z: -0.16, rz: 0.2, rx: -0.6 });
  // gear
  b.cylinder(0.24, 0.24, 0.08, 14, '#d0a85c', { x: 0.1, y: 0.3, z: -0.12, rx: 1.1, rz: 0.3, glow: 0.25 });
  for (let n = 0; n < 8; n += 1) {
    const a = (n / 8) * Math.PI * 2;
    const tooth = new THREE.BoxGeometry(0.1, 0.08, 0.1);
    tooth.translate(Math.cos(a) * 0.27, 0, Math.sin(a) * 0.27);
    b.add(tooth, '#d0a85c', { x: 0.1, y: 0.3, z: -0.12, rx: 1.1, rz: 0.3, glow: 0.25 });
  }
  b.cylinder(0.09, 0.09, 0.1, 10, '#241c14', { x: 0.1, y: 0.3, z: -0.12, rx: 1.1, rz: 0.3 });
  // hex nut + bolt
  b.cylinder(0.17, 0.17, 0.13, 6, '#e0a640', { x: -0.3, y: -0.14, z: 0.2, rx: 0.5, glow: 0.5 });
  b.cylinder(0.06, 0.06, 0.62, 8, '#cfc7b6', { x: 0.02, y: 0.02, z: 0.26, rz: 1.2, rx: 0.2 });
  b.cylinder(0.12, 0.12, 0.09, 6, '#cfc7b6', { x: 0.31, y: 0.13, z: 0.2, rz: 1.2, rx: 0.2 });
  // hot core so it reads as "valuable" at range
  b.add(new THREE.OctahedronGeometry(0.15, 0), '#ffb040', { y: 0.04, ry: 0.6, glow: 3.2 });
  return b.build();
}

function repairGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.bevel(0.96, 0.7, 0.4, 0.07, '#2c8a52');
  b.box(0.98, 0.05, 0.42, '#16241c', { y: 0.12 });
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) b.bevel(0.16, 0.16, 0.44, 0.03, '#1b2a22', { x: sx * 0.42, y: sy * 0.29 });
  }
  for (const side of [-1, 1]) {
    b.box(0.4, 0.13, 0.03, '#f4fff6', { y: -0.1, z: side * 0.205, glow: 1.9 });
    b.box(0.13, 0.4, 0.03, '#f4fff6', { y: -0.1, z: side * 0.205, glow: 1.9 });
    b.box(0.12, 0.09, 0.05, '#c9ced2', { x: -0.26, y: 0.14, z: side * 0.21 });
    b.box(0.12, 0.09, 0.05, '#c9ced2', { x: 0.26, y: 0.14, z: side * 0.21 });
  }
  b.add(new THREE.TorusGeometry(0.19, 0.035, 6, 14, Math.PI), '#20252b', { y: 0.35 });
  b.box(0.1, 0.05, 0.12, '#20252b', { x: -0.19, y: 0.36 });
  b.box(0.1, 0.05, 0.12, '#20252b', { x: 0.19, y: 0.36 });
  b.box(0.5, 0.03, 0.43, '#58ffa0', { y: 0.2, glow: 2.6 });
  return b.build();
}

function boostGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.cylinder(0.27, 0.27, 0.78, 18, '#2a66c8');
  b.add(new THREE.SphereGeometry(0.27, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), '#2a66c8', { y: 0.39 });
  b.add(new THREE.SphereGeometry(0.27, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), '#1d4a94', { y: -0.39, rx: Math.PI });
  b.cylinder(0.295, 0.295, 0.06, 18, '#d6dbe0', { y: 0.27 });
  b.cylinder(0.295, 0.295, 0.06, 18, '#d6dbe0', { y: -0.27 });
  b.cylinder(0.278, 0.278, 0.2, 18, '#66dcff', { glow: 2.6 });
  // valve stack
  b.cylinder(0.09, 0.11, 0.1, 10, '#9aa2aa', { y: 0.68 });
  b.cylinder(0.045, 0.045, 0.2, 8, '#c9ced2', { y: 0.8 });
  b.add(new THREE.TorusGeometry(0.13, 0.026, 6, 14), '#f0b030', { y: 0.9, rx: Math.PI / 2, glow: 0.5 });
  b.box(0.26, 0.03, 0.03, '#f0b030', { y: 0.9 });
  b.box(0.03, 0.03, 0.26, '#f0b030', { y: 0.9 });
  // side pressure line + foot ring
  b.cylinder(0.025, 0.025, 0.7, 6, '#c9ced2', { x: 0.3, y: 0.05 });
  b.add(new THREE.TorusGeometry(0.2, 0.03, 6, 14), '#16202c', { y: -0.64, rx: Math.PI / 2 });
  return b.build();
}

function missileCrateGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder();
  b.bevel(1.0, 0.5, 0.62, 0.04, '#4d5638', { y: -0.1 });
  // slatted sides and corner irons
  b.box(1.02, 0.07, 0.64, '#3a412a', { y: 0.02 });
  b.box(1.02, 0.07, 0.64, '#3a412a', { y: -0.24 });
  for (const sx of [-1, 1]) {
    b.box(0.09, 0.56, 0.66, '#17191b', { x: sx * 0.27, y: -0.1 });
    b.box(0.12, 0.06, 0.1, '#c9ced2', { x: sx * 0.27, y: 0.17, z: 0.3 });
    for (const sz of [-1, 1]) b.box(0.07, 0.54, 0.07, '#22262a', { x: sx * 0.48, y: -0.1, z: sz * 0.29 });
  }
  // hazard stencil
  for (const sz of [-1, 1]) {
    b.box(0.3, 0.2, 0.02, '#ffc928', { y: -0.1, z: sz * 0.316, glow: 0.7 });
    b.box(0.3, 0.05, 0.025, '#17191b', { y: -0.1, z: sz * 0.317, rz: 0.6 });
  }
  // two warheads standing out of the open top
  for (const sx of [-1, 1]) {
    b.cylinder(0.105, 0.105, 0.42, 12, '#dcdcd6', { y: 0.3, z: sx * 0.14 });
    b.cylinder(0.11, 0.11, 0.05, 12, '#17191b', { y: 0.42, z: sx * 0.14 });
    b.add(new THREE.ConeGeometry(0.105, 0.3, 12), '#ff3346', { y: 0.66, z: sx * 0.14, glow: 2.2 });
  }
  b.box(0.7, 0.03, 0.5, '#101214', { y: 0.155 });
  return b.build();
}

/**
 * Pooled world pickups. One InstancedMesh per kind plus one shared ground-glow
 * mesh: five draw calls no matter how many pickups are live.
 */
export class PickupSystem {
  readonly group = new THREE.Group();
  private readonly pools: Record<PickupKind, Pickup[]> = { scrap: [], repair: [], boost: [], missile: [] };
  private readonly meshes: Record<PickupKind, THREE.InstancedMesh>;
  private readonly ringMesh: THREE.InstancedMesh;
  private readonly ringMaterial: THREE.ShaderMaterial;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly euler = new THREE.Euler();
  private readonly color = new THREE.Color();
  private activeCount = 0;
  /** Called when the player touches a pickup (the pickup is already deactivated). */
  onCollect: (pickup: Pickup) => void = () => undefined;

  constructor() {
    this.group.name = 'pickups';
    this.material = createPropMaterial(0.55, 0.35, 1.5);
    const geometries: Record<PickupKind, THREE.BufferGeometry> = {
      scrap: scrapGeometry(),
      repair: repairGeometry(),
      boost: boostGeometry(),
      missile: missileCrateGeometry(),
    };
    const meshes = {} as Record<PickupKind, THREE.InstancedMesh>;
    let ringTotal = 0;
    for (const kind of KINDS) {
      const mesh = new THREE.InstancedMesh(geometries[kind], this.material, CAPACITY[kind]);
      mesh.name = `pickup-${kind}`;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      for (let i = 0; i < CAPACITY[kind]; i += 1) {
        mesh.setMatrixAt(i, HIDDEN_MATRIX);
        this.pools[kind].push({
          active: false, kind, slot: i, ring: ringTotal + i,
          x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: Infinity, value: 1, phase: 0, pulled: false,
        });
      }
      ringTotal += CAPACITY[kind];
      meshes[kind] = mesh;
      this.group.add(mesh);
    }
    this.meshes = meshes;

    const ringGeometry = new THREE.PlaneGeometry(2, 2);
    ringGeometry.rotateX(-Math.PI / 2);
    this.ringMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vTint;
        void main() {
          vUv = uv;
          vTint = instanceColor;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vTint;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float ring = smoothstep(0.62, 0.72, r) * (1.0 - smoothstep(0.78, 0.9, r));
          float pulse = fract(uTime * 0.6);
          float wave = (1.0 - smoothstep(0.0, 0.07, abs(r - pulse * 0.95))) * (1.0 - pulse) * 0.7;
          float pool = (1.0 - smoothstep(0.0, 0.7, r)) * 0.32;
          float a = (ring * 0.85 + wave + pool) * step(r, 1.0);
          gl_FragColor = vec4(vTint * a * 1.7, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.ringMesh = new THREE.InstancedMesh(ringGeometry, this.ringMaterial, ringTotal);
    this.ringMesh.name = 'pickup-rings';
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 4;
    for (const kind of KINDS) {
      const [r, g, b] = PICKUP_COLORS[kind];
      for (const pickup of this.pools[kind]) {
        this.ringMesh.setMatrixAt(pickup.ring, HIDDEN_MATRIX);
        this.ringMesh.setColorAt(pickup.ring, this.color.setRGB(r, g, b));
      }
    }
    this.group.add(this.ringMesh);
  }

  get remaining(): number {
    return this.activeCount;
  }

  /** Count of live pickups of one kind (diagnostics). */
  count(kind: PickupKind): number {
    let total = 0;
    for (const pickup of this.pools[kind]) if (pickup.active) total += 1;
    return total;
  }

  spawn(kind: PickupKind, x: number, z: number, value: number, life = Infinity, vx = 0, vy = 0, vz = 0, phase = 0): Pickup | null {
    for (const pickup of this.pools[kind]) {
      if (pickup.active) continue;
      pickup.active = true;
      pickup.x = x;
      pickup.z = z;
      pickup.y = groundHeight(x, z) + (vy > 0 ? 0.6 : HOVER[kind]);
      pickup.vx = vx;
      pickup.vy = vy;
      pickup.vz = vz;
      pickup.age = 0;
      pickup.life = life;
      pickup.value = value;
      pickup.phase = phase;
      pickup.pulled = false;
      this.activeCount += 1;
      return pickup;
    }
    return null;
  }

  /** Nearest live pickup positions for the minimap (writes into `visit`). */
  forEachActive(visit: (pickup: Pickup) => void): void {
    for (const kind of KINDS) {
      for (const pickup of this.pools[kind]) if (pickup.active) visit(pickup);
    }
  }

  clear(): void {
    for (const kind of KINDS) {
      for (const pickup of this.pools[kind]) {
        pickup.active = false;
        this.meshes[kind].setMatrixAt(pickup.slot, HIDDEN_MATRIX);
        this.ringMesh.setMatrixAt(pickup.ring, HIDDEN_MATRIX);
      }
      this.meshes[kind].instanceMatrix.needsUpdate = true;
    }
    this.ringMesh.instanceMatrix.needsUpdate = true;
    this.activeCount = 0;
  }

  update(dt: number, time: number, px: number, pz: number, pvx: number, pvz: number, magnetRadius: number, canCollect: boolean): void {
    this.ringMaterial.uniforms.uTime.value = time;
    for (const kind of KINDS) {
      const mesh = this.meshes[kind];
      const hover = HOVER[kind];
      const base = SCALE[kind];
      for (const pickup of this.pools[kind]) {
        if (!pickup.active) continue;
        pickup.age += dt;
        pickup.life -= dt;
        const ground = groundHeight(pickup.x, pickup.z);
        const dx = px - pickup.x;
        const dz = pz - pickup.z;
        const dist = Math.hypot(dx, dz);
        if (canCollect && pickup.age > 0.3 && dist < COLLECT_RADIUS) {
          this.release(pickup);
          this.onCollect(pickup);
          continue;
        }
        if (pickup.life <= 0) {
          this.release(pickup);
          continue;
        }
        if (canCollect && pickup.age > 0.45 && dist < magnetRadius) {
          // magnet: accelerate onto the car, faster the closer it gets
          pickup.pulled = true;
          const pull = 16 + (1 - dist / magnetRadius) * 46;
          const inv = 1 / Math.max(0.2, dist);
          const k = Math.min(1, dt * 9);
          pickup.vx += (dx * inv * pull + pvx - pickup.vx) * k;
          pickup.vz += (dz * inv * pull + pvz - pickup.vz) * k;
          pickup.vy = 0;
          pickup.y += (ground + 0.85 - pickup.y) * Math.min(1, dt * 8);
          pickup.x += pickup.vx * dt;
          pickup.z += pickup.vz * dt;
        } else if (pickup.vy !== 0 || pickup.y > ground + hover + 0.02 || pickup.vx !== 0 || pickup.vz !== 0) {
          // scatter arc after a drop, then settle to the hover height
          pickup.pulled = false;
          pickup.vy -= 24 * dt;
          pickup.x += pickup.vx * dt;
          pickup.y += pickup.vy * dt;
          pickup.z += pickup.vz * dt;
          const drag = Math.exp(-dt * 2.2);
          pickup.vx *= drag;
          pickup.vz *= drag;
          if (pickup.y <= ground + hover) {
            pickup.y = ground + hover;
            if (pickup.vy < -5) pickup.vy = -pickup.vy * 0.38;
            else {
              pickup.vy = 0;
              pickup.vx = 0;
              pickup.vz = 0;
            }
          }
        } else {
          pickup.y = ground + hover;
        }
        const bob = Math.sin(time * 2.4 + pickup.phase) * 0.12;
        const pop = pickup.age < 0.28 ? 0.3 + (pickup.age / 0.28) * 0.95 : pickup.age < 0.4 ? 1.25 - ((pickup.age - 0.28) / 0.12) * 0.25 : 1;
        const blink = pickup.life < 4 ? (Math.sin(pickup.life * 16) > -0.2 ? 1 : 0.001) : 1;
        const s = base * pop * blink * (pickup.pulled ? 0.8 : 1);
        this.euler.set(kind === 'boost' ? 0.32 : kind === 'scrap' ? 0.25 : 0.12, time * (kind === 'scrap' ? 2.2 : 1.5) + pickup.phase, 0, 'YXZ');
        this.quaternion.setFromEuler(this.euler);
        this.matrix.compose(this.position.set(pickup.x, pickup.y + bob, pickup.z), this.quaternion, this.scale.set(s, s, s));
        mesh.setMatrixAt(pickup.slot, this.matrix);
        const ringSize = (kind === 'scrap' ? 1.15 : 1.7) * (pickup.pulled ? 0.5 : 1) * blink;
        this.matrix.compose(this.position.set(pickup.x, ground + 0.05, pickup.z), this.quaternion.identity(), this.scale.set(ringSize, 1, ringSize));
        this.ringMesh.setMatrixAt(pickup.ring, this.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.ringMesh.instanceMatrix.needsUpdate = true;
  }

  private release(pickup: Pickup): void {
    pickup.active = false;
    this.activeCount -= 1;
    this.meshes[pickup.kind].setMatrixAt(pickup.slot, HIDDEN_MATRIX);
    this.ringMesh.setMatrixAt(pickup.ring, HIDDEN_MATRIX);
  }

  dispose(): void {
    for (const kind of KINDS) this.meshes[kind].geometry.dispose();
    this.ringMesh.geometry.dispose();
    this.ringMaterial.dispose();
    this.material.dispose();
  }
}
