import * as THREE from 'three';
import { SUN_DIRECTION } from './Atmosphere';

/**
 * Falling ash and drifting embers in a camera-centred wrapping volume. One draw
 * call; all motion is computed in the vertex shader.
 */
export class AshField {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(count: number) {
    const position = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    let s = 9973;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < count; i += 1) {
      position[i * 3] = rand();
      position[i * 3 + 1] = rand();
      position[i * 3 + 2] = rand();
      seed[i] = rand();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCamera: { value: new THREE.Vector3() },
        uScale: { value: 600 },
        uSunDir: { value: SUN_DIRECTION.clone() },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform vec3 uCamera;
        uniform float uScale;
        uniform vec3 uSunDir;
        varying vec4 vColor;
        const vec3 BOX = vec3(90.0, 46.0, 90.0);
        void main() {
          vec3 p = position * BOX;
          float ember = step(0.93, aSeed);
          vec3 wind = vec3(1.6, -1.1 + ember * 2.3, 0.7) * uTime * (0.6 + aSeed);
          p += wind;
          p.x += sin(uTime * 0.7 + aSeed * 40.0) * 1.4;
          p.z += cos(uTime * 0.5 + aSeed * 31.0) * 1.4;
          p = mod(p - uCamera + BOX * 0.5, BOX) - BOX * 0.5 + uCamera;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = -mv.z;
          float size = mix(0.07, 0.16, fract(aSeed * 7.0));
          gl_PointSize = clamp(size * uScale / max(dist, 0.5), 1.0, 9.0);
          float fade = smoothstep(46.0, 20.0, dist) * smoothstep(0.6, 3.0, dist);
          vec3 viewDir = normalize(p - uCamera);
          float forward = pow(max(dot(viewDir, uSunDir), 0.0), 4.0);
          vec3 ash = vec3(0.5, 0.45, 0.4) + vec3(1.6, 0.8, 0.3) * forward;
          vec3 emberCol = vec3(5.0, 1.8, 0.4) * (0.6 + 0.4 * sin(uTime * 9.0 + aSeed * 90.0));
          vColor = vec4(mix(ash, emberCol, ember), fade * mix(0.5, 1.0, ember));
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.3, r) * vColor.a;
          gl_FragColor = vec4(vColor.rgb, a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.name = 'ash';
  }

  update(time: number, camera: THREE.Vector3, viewportHeight: number): void {
    this.material.uniforms.uTime.value = time;
    (this.material.uniforms.uCamera.value as THREE.Vector3).copy(camera);
    this.material.uniforms.uScale.value = viewportHeight * 0.9;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
