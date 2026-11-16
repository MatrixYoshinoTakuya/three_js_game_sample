import * as THREE from 'three';

/**
 * Grounding cues that cost two draw calls: soft contact shadows under every
 * vehicle (the sun is so low that cast shadows stretch far away from the car)
 * and tyre skid marks laid down as a ring buffer of fading quads.
 */
export class GroundFx {
  readonly group = new THREE.Group();
  private readonly shadowMesh: THREE.InstancedMesh;
  private readonly skidMesh: THREE.InstancedMesh;
  private readonly skidBirth: THREE.InstancedBufferAttribute;
  private readonly skidMaterial: THREE.ShaderMaterial;
  private readonly shadowMaterial: THREE.ShaderMaterial;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly skidGeometry: THREE.PlaneGeometry;
  private shadowCount = 0;
  private skidCursor = 0;
  private skidUsed = 0;
  private readonly capacity: number;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private time = 0;

  constructor(lowSpec: boolean) {
    this.group.name = 'groundFx';
    this.capacity = lowSpec ? 260 : 640;
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.geometry.rotateX(-Math.PI / 2);

    this.shadowMaterial = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vec2 p = abs(vUv * 2.0 - 1.0);
          // rounded-box falloff: dense under the chassis, feathered at the sills
          float d = length(max(p - vec2(0.55, 0.62), 0.0)) / 0.45;
          float a = (1.0 - smoothstep(0.0, 1.0, d)) * 0.62;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.shadowMesh = new THREE.InstancedMesh(this.geometry, this.shadowMaterial, 16);
    this.shadowMesh.count = 0;
    this.shadowMesh.frustumCulled = false;
    this.shadowMesh.renderOrder = 2;
    this.group.add(this.shadowMesh);

    this.skidGeometry = new THREE.PlaneGeometry(1, 1);
    this.skidGeometry.rotateX(-Math.PI / 2);
    this.skidBirth = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 2), 2);
    this.skidBirth.setUsage(THREE.DynamicDrawUsage);
    this.skidGeometry.setAttribute('aBirth', this.skidBirth);
    this.skidMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec2 aBirth;
        uniform float uTime;
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          vUv = uv;
          float age = uTime - aBirth.x;
          vAlpha = aBirth.y * (1.0 - smoothstep(14.0, 26.0, age)) * step(0.0, age);
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          float edge = 1.0 - smoothstep(0.25, 0.5, abs(vUv.x - 0.5));
          // tread streaks so the mark is not a flat ribbon
          float tread = 0.72 + 0.28 * step(0.5, fract(vUv.x * 5.0));
          gl_FragColor = vec4(vec3(0.012, 0.011, 0.01), edge * tread * vAlpha * 0.7);
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.skidMesh = new THREE.InstancedMesh(this.skidGeometry, this.skidMaterial, this.capacity);
    this.skidMesh.count = 0;
    this.skidMesh.frustumCulled = false;
    this.skidMesh.renderOrder = 1;
    this.group.add(this.skidMesh);
  }

  beginFrame(time: number): void {
    this.time = time;
    this.shadowCount = 0;
    this.skidMaterial.uniforms.uTime.value = time;
  }

  /** Contact shadow under a vehicle. halfWidth/halfLength are the body half extents. */
  addShadow(x: number, y: number, z: number, heading: number, halfWidth: number, halfLength: number): void {
    if (this.shadowCount >= 16) return;
    this.quaternion.setFromAxisAngle(this.up, heading);
    this.position.set(x, y + 0.035, z);
    this.scale.set(halfWidth * 1.75, 1, halfLength * 1.45);
    this.shadowMesh.setMatrixAt(this.shadowCount, this.matrix.compose(this.position, this.quaternion, this.scale));
    this.shadowCount += 1;
  }

  endFrame(): void {
    this.shadowMesh.count = this.shadowCount;
    this.shadowMesh.instanceMatrix.needsUpdate = true;
  }

  /** Lay one skid segment between two points on the ground (per wheel, per step). */
  skid(ax: number, az: number, bx: number, bz: number, y: number, strength01: number): void {
    const dx = bx - ax;
    const dz = bz - az;
    const length = Math.hypot(dx, dz);
    if (length < 0.05 || length > 6) return;
    const index = this.skidCursor;
    this.skidCursor = (this.skidCursor + 1) % this.capacity;
    this.skidUsed = Math.min(this.capacity, this.skidUsed + 1);
    this.quaternion.setFromAxisAngle(this.up, Math.atan2(dx, dz));
    this.position.set((ax + bx) / 2, y + 0.022, (az + bz) / 2);
    this.scale.set(0.3, 1, length * 1.08);
    this.skidMesh.setMatrixAt(index, this.matrix.compose(this.position, this.quaternion, this.scale));
    this.skidBirth.setXY(index, this.time, Math.min(1, strength01));
    this.skidMesh.count = this.skidUsed;
    this.skidMesh.instanceMatrix.needsUpdate = true;
    this.skidBirth.needsUpdate = true;
  }

  clear(): void {
    this.skidCursor = 0;
    this.skidUsed = 0;
    this.skidMesh.count = 0;
    this.shadowCount = 0;
    this.shadowMesh.count = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.skidGeometry.dispose();
    this.shadowMaterial.dispose();
    this.skidMaterial.dispose();
  }
}
