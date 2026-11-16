import * as THREE from 'three';

/**
 * Pooled, event-driven effects. Nothing here allocates during play: particles,
 * tracers, debris, shockwaves, scorch marks and mortar telegraphs all recycle
 * fixed-size buffers.
 */

type ParticleSpawn = {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  size0: number; size1: number;
  r: number; g: number; b: number; a: number;
  /** End colour multiplier (fire cools, smoke thins). */
  fade?: number;
  drag?: number;
  gravity?: number;
};

class ParticleLayer {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private readonly position: Float32Array;
  private readonly color: Float32Array;
  private readonly size: Float32Array;
  private readonly velocity: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly base: Float32Array;
  private readonly drag: Float32Array;
  private readonly gravity: Float32Array;
  private readonly fade: Float32Array;
  private cursor = 0;
  readonly material: THREE.ShaderMaterial;

  constructor(capacity: number, additive: boolean) {
    this.capacity = capacity;
    this.position = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    this.velocity = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity).fill(1);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.base = new Float32Array(capacity * 4);
    this.drag = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.fade = new Float32Array(capacity);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute vec4 aColor;
        attribute float aSize;
        uniform float uScale;
        varying vec4 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize <= 0.0 ? 0.0 : min(520.0, aSize * uScale / max(0.5, -mv.z));
        }`,
      fragmentShader: additive
        ? /* glsl */ `
        varying vec4 vColor;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float falloff = pow(max(0.0, 1.0 - r), 1.8);
          gl_FragColor = vec4(vColor.rgb * vColor.a * falloff, 1.0);
        }`
        : /* glsl */ `
        varying vec4 vColor;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float r = length(p) * 2.0;
          float puff = smoothstep(1.0, 0.25, r);
          // cheap self-shadowing: darker underside, warm top
          float shade = 0.72 + 0.5 * (0.5 - gl_PointCoord.y);
          gl_FragColor = vec4(vColor.rgb * shade, vColor.a * puff);
        }`,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 8 : 7;
  }

  spawn(p: ParticleSpawn): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.position[i * 3] = p.x;
    this.position[i * 3 + 1] = p.y;
    this.position[i * 3 + 2] = p.z;
    this.velocity[i * 3] = p.vx;
    this.velocity[i * 3 + 1] = p.vy;
    this.velocity[i * 3 + 2] = p.vz;
    this.life[i] = p.life;
    this.maxLife[i] = p.life;
    this.size0[i] = p.size0;
    this.size1[i] = p.size1;
    this.base[i * 4] = p.r;
    this.base[i * 4 + 1] = p.g;
    this.base[i * 4 + 2] = p.b;
    this.base[i * 4 + 3] = p.a;
    this.drag[i] = p.drag ?? 0;
    this.gravity[i] = p.gravity ?? 0;
    this.fade[i] = p.fade ?? 0;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i += 1) {
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const damp = Math.exp(-this.drag[i] * dt);
      const v = i * 3;
      this.velocity[v] *= damp;
      this.velocity[v + 1] = this.velocity[v + 1] * damp - this.gravity[i] * dt;
      this.velocity[v + 2] *= damp;
      this.position[v] += this.velocity[v] * dt;
      this.position[v + 1] += this.velocity[v + 1] * dt;
      this.position[v + 2] += this.velocity[v + 2] * dt;
      this.size[i] = this.life[i] <= 0 ? 0 : this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      const c = i * 4;
      const cool = 1 - (1 - this.fade[i]) * t;
      this.color[c] = this.base[c] * cool;
      this.color[c + 1] = this.base[c + 1] * cool * cool;
      this.color[c + 2] = this.base[c + 2] * cool * cool;
      const fadeIn = Math.min(1, t * 12);
      this.color[c + 3] = this.base[c + 3] * (1 - t) * fadeIn;
    }
    const geometry = this.points.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aColor.needsUpdate = true;
    geometry.attributes.aSize.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.size.fill(0);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

type Tracer = { life: number; x: number; y: number; z: number; dx: number; dy: number; dz: number; length: number; width: number };
type Debris = { life: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; rx: number; ry: number; spin: number; size: number };
type Ring = { mesh: THREE.Mesh; life: number; maxLife: number; radius: number };
type Telegraph = { mesh: THREE.Mesh; life: number; maxLife: number; radius: number };

export class VfxSystem {
  readonly group = new THREE.Group();
  private readonly glow: ParticleLayer;
  private readonly smoke: ParticleLayer;
  private readonly tracerMesh: THREE.InstancedMesh;
  private readonly tracerColor = new THREE.Color();
  private readonly tracers: Tracer[] = [];
  private readonly debrisMesh: THREE.InstancedMesh;
  private readonly debris: Debris[] = [];
  private readonly rings: Ring[] = [];
  private readonly telegraphs: Telegraph[] = [];
  private readonly scorchMesh: THREE.InstancedMesh;
  private scorchCursor = 0;
  private readonly flash: THREE.PointLight;
  private flashLife = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly euler = new THREE.Euler();
  private readonly forward = new THREE.Vector3(0, 0, 1);
  private readonly direction = new THREE.Vector3();
  private readonly disposables: { dispose(): void }[] = [];
  private seed = 1;

  constructor(lowSpec: boolean) {
    this.group.name = 'vfx';
    this.glow = new ParticleLayer(lowSpec ? 720 : 1300, true);
    this.smoke = new ParticleLayer(lowSpec ? 480 : 900, false);
    this.group.add(this.smoke.points, this.glow.points);

    const tracerGeometry = new THREE.BoxGeometry(1, 1, 1);
    tracerGeometry.translate(0, 0, -0.5);
    const tracerMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
    this.tracerMesh = new THREE.InstancedMesh(tracerGeometry, tracerMaterial, 80);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.renderOrder = 9;
    this.tracerMesh.count = 0;
    this.group.add(this.tracerMesh);
    for (let i = 0; i < 80; i += 1) {
      this.tracers.push({ life: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, length: 1, width: 0.1 });
      this.tracerMesh.setColorAt(i, this.tracerColor.setRGB(1, 1, 1));
    }

    const debrisGeometry = new THREE.BoxGeometry(1, 0.5, 0.7);
    const debrisMaterial = new THREE.MeshStandardMaterial({ color: '#221c18', roughness: 0.8, metalness: 0.5 });
    this.debrisMesh = new THREE.InstancedMesh(debrisGeometry, debrisMaterial, 56);
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.castShadow = true;
    this.debrisMesh.count = 0;
    this.group.add(this.debrisMesh);
    for (let i = 0; i < 56; i += 1) {
      this.debris.push({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, spin: 0, size: 0.3 });
    }

    const ringGeometry = new THREE.RingGeometry(0.82, 1, 48);
    ringGeometry.rotateX(-Math.PI / 2);
    for (let i = 0; i < 6; i += 1) {
      const material = new THREE.MeshBasicMaterial({ color: '#ffd9a0', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(ringGeometry, material);
      mesh.visible = false;
      mesh.renderOrder = 8;
      this.group.add(mesh);
      this.rings.push({ mesh, life: 0, maxLife: 1, radius: 1 });
      this.disposables.push(material);
    }

    const discGeometry = new THREE.PlaneGeometry(2, 2);
    discGeometry.rotateX(-Math.PI / 2);
    for (let i = 0; i < 6; i += 1) {
      const material = new THREE.ShaderMaterial({
        uniforms: { uProgress: { value: 0 }, uTime: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uProgress;
          uniform float uTime;
          varying vec2 vUv;
          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float r = length(p);
            float edge = smoothstep(0.9, 0.96, r) * (1.0 - smoothstep(0.985, 1.0, r));
            float closing = 1.0 - smoothstep(0.0, 0.05, abs(r - (1.0 - uProgress)));
            float ang = atan(p.y, p.x);
            float ticks = step(0.5, fract(ang / 6.2831853 * 16.0 + uTime * 0.6)) * step(0.72, r) * step(r, 0.9) * 0.45;
            float fill = (1.0 - smoothstep(0.0, 1.0, r)) * (0.12 + 0.3 * uProgress) * (0.7 + 0.3 * sin(uTime * 22.0));
            float a = (edge + closing * 0.9 + ticks + fill) * step(r, 1.0);
            gl_FragColor = vec4(vec3(3.2, 0.5, 0.16) * a, a);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      });
      const mesh = new THREE.Mesh(discGeometry, material);
      mesh.visible = false;
      mesh.renderOrder = 4;
      this.group.add(mesh);
      this.telegraphs.push({ mesh, life: 0, maxLife: 1, radius: 1 });
      this.disposables.push(material);
    }

    const scorchMaterial = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float ang = atan(p.y, p.x);
          float ragged = 0.78 + 0.16 * sin(ang * 7.0) + 0.08 * sin(ang * 19.0 + 1.3);
          float a = (1.0 - smoothstep(ragged * 0.25, ragged, r)) * 0.86;
          gl_FragColor = vec4(vec3(0.012, 0.01, 0.009), a);
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
    });
    this.scorchMesh = new THREE.InstancedMesh(discGeometry, scorchMaterial, 20);
    this.scorchMesh.frustumCulled = false;
    this.scorchMesh.count = 0;
    this.scorchMesh.renderOrder = 3;
    this.group.add(this.scorchMesh);

    this.flash = new THREE.PointLight('#ffb070', 0, 70, 1.6);
    this.group.add(this.flash);

    this.disposables.push(tracerGeometry, tracerMaterial, debrisGeometry, debrisMaterial, ringGeometry, discGeometry, scorchMaterial, this.glow, this.smoke);
  }

  /** Cheap deterministic-ish jitter; visuals only, never gameplay. */
  private rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private spread(amount: number): number {
    return (this.rand() - 0.5) * 2 * amount;
  }

  setViewportHeight(height: number): void {
    this.glow.material.uniforms.uScale.value = height * 0.9;
    this.smoke.material.uniforms.uScale.value = height * 0.9;
  }

  tracer(x: number, y: number, z: number, dx: number, dy: number, dz: number, player: boolean): number {
    for (let i = 0; i < this.tracers.length; i += 1) {
      const t = this.tracers[i];
      if (t.life > 0) continue;
      t.life = 1;
      t.x = x; t.y = y; t.z = z;
      t.dx = dx; t.dy = dy; t.dz = dz;
      t.length = player ? 7 : 5;
      t.width = player ? 0.13 : 0.11;
      if (player) this.tracerColor.setRGB(6.5, 3.6, 1.2);
      else this.tracerColor.setRGB(7.0, 1.0, 0.5);
      this.tracerMesh.setColorAt(i, this.tracerColor);
      if (this.tracerMesh.instanceColor) this.tracerMesh.instanceColor.needsUpdate = true;
      return i;
    }
    return -1;
  }

  moveTracer(index: number, x: number, y: number, z: number): void {
    if (index < 0) return;
    const t = this.tracers[index];
    t.x = x; t.y = y; t.z = z;
  }

  killTracer(index: number): void {
    if (index >= 0) this.tracers[index].life = 0;
  }

  muzzleFlash(x: number, y: number, z: number, dx: number, dy: number, dz: number, scale: number): void {
    this.glow.spawn({ x, y, z, vx: dx * 4, vy: dy * 4, vz: dz * 4, life: 0.06, size0: 1.7 * scale, size1: 0.6 * scale, r: 5, g: 2.6, b: 0.9, a: 1 });
    for (let i = 0; i < 3; i += 1) {
      const s = 14 + this.rand() * 22;
      this.glow.spawn({
        x, y, z,
        vx: dx * s + this.spread(5), vy: dy * s + this.spread(5), vz: dz * s + this.spread(5),
        life: 0.07 + this.rand() * 0.06, size0: 0.5 * scale, size1: 0.1, r: 4, g: 1.8, b: 0.5, a: 1, drag: 6,
      });
    }
    this.smoke.spawn({ x, y, z, vx: dx * 3 + this.spread(1), vy: 0.8, vz: dz * 3 + this.spread(1), life: 0.5, size0: 0.4, size1: 1.6, r: 0.5, g: 0.46, b: 0.42, a: 0.22, drag: 2 });
  }

  sparks(x: number, y: number, z: number, nx: number, ny: number, nz: number, count: number, hot = 1): void {
    for (let i = 0; i < count; i += 1) {
      const s = 6 + this.rand() * 16;
      this.glow.spawn({
        x, y, z,
        vx: nx * s + this.spread(8), vy: ny * s + 3 + this.rand() * 8, vz: nz * s + this.spread(8),
        life: 0.25 + this.rand() * 0.45, size0: 0.22 + this.rand() * 0.16, size1: 0.04,
        r: 5 * hot, g: 2.6 * hot, b: 0.7, a: 1, gravity: 22, drag: 1.2, fade: 0.25,
      });
    }
    this.glow.spawn({ x, y, z, vx: 0, vy: 0, vz: 0, life: 0.09, size0: 1.5, size1: 0.3, r: 4, g: 2.4, b: 1, a: 1 });
  }

  dust(x: number, y: number, z: number, vx: number, vz: number, amount: number): void {
    this.smoke.spawn({
      x: x + this.spread(0.4), y: y + 0.15, z: z + this.spread(0.4),
      vx: vx + this.spread(1.5), vy: 0.6 + this.rand() * 1.4, vz: vz + this.spread(1.5),
      life: 0.9 + this.rand() * 0.9, size0: 0.7, size1: 3.4 + this.rand() * 2,
      r: 0.62, g: 0.5, b: 0.38, a: 0.2 * amount, drag: 1.6,
    });
  }

  exhaust(x: number, y: number, z: number, dx: number, dy: number, dz: number, boost: boolean): void {
    if (boost) {
      const s = 10 + this.rand() * 8;
      this.glow.spawn({
        x, y, z, vx: dx * s + this.spread(1.2), vy: dy * s + this.spread(1.2), vz: dz * s + this.spread(1.2),
        life: 0.12 + this.rand() * 0.1, size0: 0.75, size1: 0.12, r: 2.2, g: 2.8, b: 6.0, a: 1, drag: 3, fade: 0.2,
      });
      this.glow.spawn({
        x, y, z, vx: dx * s * 0.6, vy: dy * s * 0.6, vz: dz * s * 0.6,
        life: 0.18, size0: 0.55, size1: 0.2, r: 6, g: 2.4, b: 0.6, a: 0.9, drag: 4, fade: 0.2,
      });
    } else {
      this.smoke.spawn({
        x, y, z, vx: dx * 2 + this.spread(0.5), vy: 0.7 + dy, vz: dz * 2 + this.spread(0.5),
        life: 0.7 + this.rand() * 0.5, size0: 0.25, size1: 1.5, r: 0.2, g: 0.19, b: 0.19, a: 0.2, drag: 1.5,
      });
    }
  }

  damageSmoke(x: number, y: number, z: number, heavy: boolean): void {
    this.smoke.spawn({
      x: x + this.spread(0.5), y, z: z + this.spread(0.5),
      vx: this.spread(1), vy: 2.4 + this.rand() * 2, vz: this.spread(1),
      life: 1.2 + this.rand() * 1.0, size0: 0.7, size1: 4.2,
      r: heavy ? 0.06 : 0.3, g: heavy ? 0.055 : 0.28, b: heavy ? 0.05 : 0.27, a: heavy ? 0.5 : 0.28, drag: 0.6,
    });
    if (heavy && this.rand() < 0.5) {
      this.glow.spawn({ x, y, z, vx: this.spread(1), vy: 2.5, vz: this.spread(1), life: 0.3, size0: 1.2, size1: 0.3, r: 4.5, g: 1.6, b: 0.3, a: 0.9, fade: 0.2 });
    }
  }

  fire(x: number, y: number, z: number, strength: number): void {
    this.glow.spawn({
      x: x + this.spread(0.22), y, z: z + this.spread(0.22),
      vx: this.spread(0.5), vy: 2.2 + this.rand() * 2.4, vz: this.spread(0.5),
      life: 0.32 + this.rand() * 0.35, size0: 1.25 * strength, size1: 0.15,
      r: 4.6, g: 1.7, b: 0.32, a: 0.9, fade: 0.25, drag: 0.6,
    });
    if (this.rand() < 0.3) {
      this.smoke.spawn({
        x, y: y + 1, z, vx: this.spread(0.6) + 0.8, vy: 2.6, vz: this.spread(0.6),
        life: 2.4, size0: 0.8, size1: 5, r: 0.07, g: 0.06, b: 0.06, a: 0.34 * strength, drag: 0.25,
      });
    }
    if (this.rand() < 0.12) {
      this.glow.spawn({
        x, y: y + 0.4, z, vx: this.spread(1.6) + 1.2, vy: 3.5 + this.rand() * 3, vz: this.spread(1.6),
        life: 1.4, size0: 0.14, size1: 0.05, r: 5, g: 2, b: 0.4, a: 1, drag: 0.4, gravity: -0.6,
      });
    }
  }

  /** Rocket motor: white-hot core, orange flame and a lingering grey smoke rope. */
  missileTrail(x: number, y: number, z: number, dx: number, dy: number, dz: number, boostPhase: boolean): void {
    this.glow.spawn({ x, y, z, vx: -dx * 6, vy: -dy * 6, vz: -dz * 6, life: 0.07, size0: boostPhase ? 2.6 : 1.7, size1: 0.5, r: 7, g: 5, b: 3, a: 1 });
    this.glow.spawn({
      x: x - dx * 0.5, y: y - dy * 0.5, z: z - dz * 0.5,
      vx: -dx * 14 + this.spread(1.5), vy: -dy * 14 + this.spread(1.5), vz: -dz * 14 + this.spread(1.5),
      life: 0.16 + this.rand() * 0.1, size0: 1.0, size1: 0.2, r: 6, g: 2.4, b: 0.5, a: 0.95, drag: 3, fade: 0.2,
    });
    for (let n = 0; n < 2; n += 1) {
      const back = n * 0.8 + this.rand() * 0.6;
      this.smoke.spawn({
        x: x - dx * back + this.spread(0.12), y: y - dy * back + this.spread(0.12), z: z - dz * back + this.spread(0.12),
        vx: this.spread(0.6), vy: 0.5 + this.rand() * 0.6, vz: this.spread(0.6),
        life: 1.1 + this.rand() * 0.9, size0: 0.45, size1: 2.4 + this.rand(),
        r: 0.62, g: 0.6, b: 0.58, a: 0.34, drag: 1.2,
      });
    }
  }

  /** Pickup collected: a tinted ring of motes that rise and a soft flash. */
  collectBurst(x: number, y: number, z: number, r: number, g: number, b: number, big: boolean): void {
    const count = big ? 16 : 7;
    this.glow.spawn({ x, y, z, vx: 0, vy: 0, vz: 0, life: 0.16, size0: big ? 4.2 : 2.2, size1: 0.4, r: r * 3.5, g: g * 3.5, b: b * 3.5, a: 1 });
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2 + this.rand();
      const s = (big ? 5 : 3) + this.rand() * 3;
      this.glow.spawn({
        x, y, z, vx: Math.cos(a) * s, vy: 2.5 + this.rand() * 4.5, vz: Math.sin(a) * s,
        life: 0.35 + this.rand() * 0.35, size0: 0.32, size1: 0.05, r: r * 4.5, g: g * 4.5, b: b * 4.5, a: 1, drag: 2.4, gravity: -3,
      });
    }
  }

  /** Burning fuel: a rolling orange fireball with black smoke on top of the regular blast. */
  fuelBlast(x: number, y: number, z: number, scale: number): void {
    this.explosion(x, y, z, scale);
    for (let i = 0; i < 10; i += 1) {
      const a = this.rand() * Math.PI * 2;
      const s = this.rand() * 4 * scale;
      this.glow.spawn({
        x: x + Math.cos(a) * s * 0.3, y: y + 0.8 + this.rand() * 1.5, z: z + Math.sin(a) * s * 0.3,
        vx: Math.cos(a) * s, vy: 7 + this.rand() * 9, vz: Math.sin(a) * s,
        life: 0.7 + this.rand() * 0.6, size0: 3.2 * scale, size1: 5.5 * scale, r: 6, g: 1.9, b: 0.25, a: 0.9, drag: 1.8, fade: 0.05,
      });
      this.smoke.spawn({
        x, y: y + 2 + this.rand() * 2, z, vx: Math.cos(a) * s * 0.6, vy: 6 + this.rand() * 6, vz: Math.sin(a) * s * 0.6,
        life: 2.6 + this.rand() * 1.6, size0: 2.4, size1: 9 * scale, r: 0.035, g: 0.03, b: 0.03, a: 0.7, drag: 0.9,
      });
    }
  }

  /** Loose metal thrown from a hit (ploughed wrecks, scrap drops). */
  scrapSpray(x: number, y: number, z: number, count: number, scale: number): void {
    this.spawnDebris(x, y, z, count, scale);
  }

  /** A short vertical flare (cache opened, upgrade taken). */
  flare(x: number, y: number, z: number, r: number, g: number, b: number): void {
    for (let i = 0; i < 14; i += 1) {
      this.glow.spawn({
        x: x + this.spread(1.2), y: y + this.rand() * 1.5, z: z + this.spread(1.2),
        vx: this.spread(1.5), vy: 9 + this.rand() * 14, vz: this.spread(1.5),
        life: 0.6 + this.rand() * 0.6, size0: 0.9, size1: 0.1, r: r * 4, g: g * 4, b: b * 4, a: 1, drag: 1.4,
      });
    }
    this.glow.spawn({ x, y: y + 1.5, z, vx: 0, vy: 0, vz: 0, life: 0.3, size0: 9, size1: 2, r: r * 3, g: g * 3, b: b * 3, a: 1 });
  }

  explosion(x: number, y: number, z: number, scale: number): void {
    // core flash
    this.glow.spawn({ x, y: y + 1, z, vx: 0, vy: 0, vz: 0, life: 0.14, size0: 13 * scale, size1: 20 * scale, r: 7, g: 4.4, b: 1.8, a: 1 });
    const fireballs = Math.round(12 * scale + 6);
    for (let i = 0; i < fireballs; i += 1) {
      const s = (4 + this.rand() * 11) * scale;
      const a = this.rand() * Math.PI * 2;
      const up = this.rand();
      this.glow.spawn({
        x: x + this.spread(0.8), y: y + 0.6 + this.rand(), z: z + this.spread(0.8),
        vx: Math.cos(a) * s * (1 - up * 0.6), vy: (2 + up * 9) * scale, vz: Math.sin(a) * s * (1 - up * 0.6),
        life: 0.45 + this.rand() * 0.55, size0: (2.2 + this.rand() * 2) * scale, size1: (4 + this.rand() * 2) * scale,
        r: 5.5, g: 2.2, b: 0.45, a: 0.95, drag: 2.6, fade: 0.08,
      });
    }
    const smokes = Math.round(14 * scale + 6);
    for (let i = 0; i < smokes; i += 1) {
      const s = (2 + this.rand() * 7) * scale;
      const a = this.rand() * Math.PI * 2;
      this.smoke.spawn({
        x: x + this.spread(1.2), y: y + 0.8 + this.rand() * 2, z: z + this.spread(1.2),
        vx: Math.cos(a) * s, vy: (2.5 + this.rand() * 6) * scale, vz: Math.sin(a) * s,
        life: 1.6 + this.rand() * 2.2, size0: 2 * scale, size1: (7 + this.rand() * 5) * scale,
        r: 0.07, g: 0.06, b: 0.055, a: 0.62, drag: 1.1,
      });
    }
    this.sparks(x, y + 0.8, z, 0, 1, 0, Math.round(16 * scale + 8), 1.2);
    // ground dust skirt
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      this.smoke.spawn({
        x, y: 0.4, z, vx: Math.cos(a) * 13 * scale, vy: 0.8, vz: Math.sin(a) * 13 * scale,
        life: 1.2, size0: 1.4, size1: 6 * scale, r: 0.5, g: 0.42, b: 0.33, a: 0.3, drag: 2.4,
      });
    }
    this.shockwave(x, y + 0.3, z, 16 * scale, 0.5);
    this.spawnDebris(x, y + 0.8, z, Math.round(8 * scale + 4), scale);
    this.scorch(x, y, z, 4.5 * scale);
    this.flash.position.set(x, y + 3, z);
    this.flash.intensity = 900 * scale;
    this.flashLife = 0.35;
  }

  shockwave(x: number, y: number, z: number, radius: number, life: number): void {
    for (const ring of this.rings) {
      if (ring.life > 0) continue;
      ring.life = life;
      ring.maxLife = life;
      ring.radius = radius;
      ring.mesh.position.set(x, y, z);
      ring.mesh.visible = true;
      return;
    }
  }

  /** Relay power-up pulse: wide, slow, teal. */
  pulse(x: number, y: number, z: number, radius: number, life: number, color: THREE.ColorRepresentation): void {
    for (const ring of this.rings) {
      if (ring.life > 0) continue;
      ring.life = life;
      ring.maxLife = life;
      ring.radius = radius;
      ring.mesh.position.set(x, y, z);
      (ring.mesh.material as THREE.MeshBasicMaterial).color.set(color).multiplyScalar(3);
      ring.mesh.visible = true;
      ring.mesh.userData.tinted = true;
      return;
    }
  }

  telegraph(x: number, y: number, z: number, radius: number, seconds: number): void {
    for (const t of this.telegraphs) {
      if (t.life > 0) continue;
      t.life = seconds;
      t.maxLife = seconds;
      t.radius = radius;
      t.mesh.position.set(x, y + 0.06, z);
      t.mesh.scale.set(radius, 1, radius);
      t.mesh.visible = true;
      return;
    }
  }

  scorch(x: number, y: number, z: number, radius: number): void {
    const index = this.scorchCursor % 20;
    this.scorchCursor += 1;
    this.scorchMesh.count = Math.min(20, this.scorchCursor);
    this.euler.set(0, this.rand() * 6.28, 0);
    this.quaternion.setFromEuler(this.euler);
    this.position.set(x, y + 0.04 + index * 0.0015, z);
    this.scale.set(radius, 1, radius);
    this.scorchMesh.setMatrixAt(index, this.matrix.compose(this.position, this.quaternion, this.scale));
    this.scorchMesh.instanceMatrix.needsUpdate = true;
  }

  private spawnDebris(x: number, y: number, z: number, count: number, scale: number): void {
    let spawned = 0;
    for (const d of this.debris) {
      if (d.life > 0) continue;
      const a = this.rand() * Math.PI * 2;
      const s = (6 + this.rand() * 14) * Math.sqrt(scale);
      d.life = 2.2 + this.rand() * 1.5;
      d.x = x; d.y = y; d.z = z;
      d.vx = Math.cos(a) * s;
      d.vy = 6 + this.rand() * 13;
      d.vz = Math.sin(a) * s;
      d.rx = this.rand() * 6;
      d.ry = this.rand() * 6;
      d.spin = this.spread(14);
      d.size = (0.25 + this.rand() * 0.75) * Math.sqrt(scale);
      spawned += 1;
      if (spawned >= count) break;
    }
  }

  update(dt: number, time: number, groundY: (x: number, z: number) => number): void {
    this.glow.update(dt);
    this.smoke.update(dt);

    let tracerCount = 0;
    for (let i = 0; i < this.tracers.length; i += 1) {
      const t = this.tracers[i];
      if (t.life <= 0) {
        this.scale.set(0, 0, 0);
        this.matrix.compose(this.position.set(0, -100, 0), this.quaternion.identity(), this.scale);
      } else {
        this.direction.set(t.dx, t.dy, t.dz);
        this.quaternion.setFromUnitVectors(this.forward, this.direction);
        this.position.set(t.x, t.y, t.z);
        this.scale.set(t.width, t.width, t.length);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        tracerCount = i + 1;
      }
      this.tracerMesh.setMatrixAt(i, this.matrix);
    }
    this.tracerMesh.count = tracerCount;
    this.tracerMesh.instanceMatrix.needsUpdate = true;

    let debrisCount = 0;
    for (let i = 0; i < this.debris.length; i += 1) {
      const d = this.debris[i];
      if (d.life <= 0) {
        this.scale.set(0, 0, 0);
        this.matrix.compose(this.position.set(0, -100, 0), this.quaternion.identity(), this.scale);
      } else {
        d.life -= dt;
        d.vy -= 26 * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.z += d.vz * dt;
        const floor = groundY(d.x, d.z) + d.size * 0.25;
        if (d.y < floor) {
          d.y = floor;
          d.vy = -d.vy * 0.32;
          d.vx *= 0.6;
          d.vz *= 0.6;
          d.spin *= 0.5;
        }
        d.rx += d.spin * dt;
        d.ry += d.spin * 0.7 * dt;
        this.euler.set(d.rx, d.ry, 0);
        this.quaternion.setFromEuler(this.euler);
        const shrink = Math.min(1, d.life * 2);
        this.scale.set(d.size * shrink, d.size * shrink, d.size * shrink);
        this.matrix.compose(this.position.set(d.x, d.y, d.z), this.quaternion, this.scale);
        debrisCount = i + 1;
      }
      this.debrisMesh.setMatrixAt(i, this.matrix);
    }
    this.debrisMesh.count = debrisCount;
    this.debrisMesh.instanceMatrix.needsUpdate = true;

    for (const ring of this.rings) {
      if (ring.life <= 0) continue;
      ring.life -= dt;
      const t = 1 - Math.max(0, ring.life) / ring.maxLife;
      const eased = 1 - Math.pow(1 - t, 3);
      const r = ring.radius * eased + 0.2;
      ring.mesh.scale.set(r, 1, r);
      const material = ring.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = (1 - t) * 0.9;
      if (ring.life <= 0) {
        ring.mesh.visible = false;
        if (ring.mesh.userData.tinted) {
          material.color.set('#ffd9a0');
          ring.mesh.userData.tinted = false;
        }
      }
    }

    for (const t of this.telegraphs) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const material = t.mesh.material as THREE.ShaderMaterial;
      material.uniforms.uProgress.value = 1 - Math.max(0, t.life) / t.maxLife;
      material.uniforms.uTime.value = time;
      if (t.life <= 0) t.mesh.visible = false;
    }

    if (this.flashLife > 0) {
      this.flashLife -= dt;
      this.flash.intensity *= Math.exp(-dt * 12);
      if (this.flashLife <= 0) this.flash.intensity = 0;
    }
  }

  clear(): void {
    this.glow.clear();
    this.smoke.clear();
    for (const t of this.tracers) t.life = 0;
    for (const d of this.debris) d.life = 0;
    for (const ring of this.rings) {
      ring.life = 0;
      ring.mesh.visible = false;
    }
    for (const t of this.telegraphs) {
      t.life = 0;
      t.mesh.visible = false;
    }
    this.scorchCursor = 0;
    this.scorchMesh.count = 0;
    this.flash.intensity = 0;
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
  }
}
