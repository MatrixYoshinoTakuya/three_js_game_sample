import * as THREE from 'three';

/**
 * Dusk atmosphere: procedural sky dome, low sun, hemisphere fill, PMREM
 * environment and a shadow frustum that follows the player. The same
 * `ashAtmosphere` GLSL feeds the depth-fog pass so distant towers dissolve
 * into exactly the sky colour behind them.
 */

export const SUN_DIRECTION = new THREE.Vector3(
  Math.sin(0.36) * Math.cos(0.235),
  Math.sin(0.235),
  Math.cos(0.36) * Math.cos(0.235),
).normalize();

export const ATMOSPHERE_GLSL = /* glsl */ `
vec3 ashAtmosphere(vec3 rd, vec3 sunDir) {
  float h = clamp(rd.y, 0.0, 1.0);
  float sunAmt = clamp(dot(rd, sunDir), 0.0, 1.0);
  vec2 flatRd = normalize(rd.xz + vec2(1e-4, 1e-4));
  vec2 flatSun = normalize(sunDir.xz);
  float az = clamp(dot(flatRd, flatSun) * 0.5 + 0.5, 0.0, 1.0);
  vec3 zenith = vec3(0.085, 0.115, 0.23);
  vec3 upper = vec3(0.30, 0.25, 0.36);
  vec3 horizonAway = vec3(0.40, 0.29, 0.31);
  vec3 horizonSun = vec3(1.75, 0.78, 0.27);
  vec3 horizon = mix(horizonAway, horizonSun, pow(az, 2.6));
  vec3 mid = mix(upper, vec3(0.95, 0.5, 0.3), pow(az, 3.0) * 0.6);
  vec3 col = mix(horizon, mid, smoothstep(0.0, 0.28, h));
  col = mix(col, zenith, smoothstep(0.16, 0.95, h));
  col += vec3(1.6, 0.72, 0.24) * pow(sunAmt, 9.0) * 0.55;
  col += vec3(2.6, 1.5, 0.6) * pow(sunAmt, 70.0) * 0.8;
  return col;
}
`;

const SKY_NOISE = /* glsl */ `
float sHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float sNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sFbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * sNoise(p);
    p = p * 2.02 + 11.3;
    a *= 0.5;
  }
  return s;
}
`;

function createSkyMaterial(disc: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: SUN_DIRECTION.clone() },
      uTime: { value: 0 },
      uDisc: { value: disc },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 pos = projectionMatrix * viewMatrix * vec4(cameraPosition + position * 100.0, 1.0);
        // just inside the far plane: exact w can be clipped on some GPUs
        gl_Position = vec4(pos.xy, pos.w * 0.9999995, pos.w);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform float uTime;
      uniform float uDisc;
      varying vec3 vDir;
      ${ATMOSPHERE_GLSL}
      ${SKY_NOISE}
      void main() {
        vec3 rd = normalize(vDir);
        vec3 col = ashAtmosphere(rd, uSunDir);
        float sunAmt = max(dot(rd, uSunDir), 0.0);
        // layered ash cloud deck, lit from beneath by the low sun
        if (rd.y > -0.02) {
          vec2 uv = rd.xz / (rd.y + 0.16);
          float drift = uTime * 0.004;
          float c1 = sFbm(uv * 0.55 + vec2(drift, drift * 0.4));
          float c2 = sFbm(uv * 1.7 - vec2(drift * 1.6, 0.0) + 5.0);
          float cover = smoothstep(0.46, 0.78, c1 * 0.72 + c2 * 0.38);
          float fade = smoothstep(-0.02, 0.12, rd.y);
          vec3 cloudDark = vec3(0.14, 0.11, 0.16);
          vec3 cloudLit = vec3(1.5, 0.62, 0.26);
          float under = smoothstep(0.35, 0.8, c2) * 0.6 + 0.4;
          vec3 cloud = mix(cloudDark, cloudLit, pow(sunAmt, 1.6) * under + 0.12 * under);
          cloud += vec3(0.6, 0.25, 0.12) * (1.0 - cover) * 0.3;
          col = mix(col, cloud, cover * fade * 0.86);
          // sun disc, dimmed where cloud covers it
          float disc = smoothstep(0.99955, 0.99985, sunAmt);
          col += vec3(60.0, 34.0, 14.0) * disc * uDisc * (1.0 - cover * 0.85);
        } else {
          col = mix(col, vec3(0.24, 0.19, 0.17), smoothstep(-0.02, -0.25, rd.y));
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
}

export class Atmosphere {
  readonly sky: THREE.Mesh;
  readonly sun: THREE.DirectionalLight;
  readonly hemisphere: THREE.HemisphereLight;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly skyGeometry: THREE.SphereGeometry;
  private environment: THREE.WebGLRenderTarget | null = null;
  private readonly shadowExtent: number;
  private readonly lightBasis = new THREE.Matrix4();
  private readonly lightBasisInv = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, renderer: THREE.WebGLRenderer, lowSpec: boolean) {
    this.skyGeometry = new THREE.SphereGeometry(1, 48, 24);
    this.skyMaterial = createSkyMaterial(1);
    this.sky = new THREE.Mesh(this.skyGeometry, this.skyMaterial);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.sky.name = 'skyDome';
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.56, 0.27), 6.2);
    this.sun.castShadow = true;
    const mapSize = lowSpec ? 1024 : 2048;
    this.shadowExtent = lowSpec ? 70 : 95;
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    this.sun.shadow.camera.left = -this.shadowExtent;
    this.sun.shadow.camera.right = this.shadowExtent;
    this.sun.shadow.camera.top = this.shadowExtent;
    this.sun.shadow.camera.bottom = -this.shadowExtent;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 1500;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.35;
    this.sun.shadow.radius = 1.4;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemisphere = new THREE.HemisphereLight(new THREE.Color(0.36, 0.42, 0.72), new THREE.Color(0.34, 0.22, 0.16), 1.25);
    scene.add(this.hemisphere);

    this.lightBasis.lookAt(SUN_DIRECTION, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    this.lightBasisInv.copy(this.lightBasis).invert();

    this.bakeEnvironment(renderer);
  }

  private bakeEnvironment(renderer: THREE.WebGLRenderer): void {
    const envScene = new THREE.Scene();
    const material = createSkyMaterial(0.04);
    const mesh = new THREE.Mesh(this.skyGeometry, material);
    mesh.frustumCulled = false;
    envScene.add(mesh);
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.environment = pmrem.fromScene(envScene, 0.02, 0.1, 1000);
    pmrem.dispose();
    material.dispose();
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.85;
  }

  /** Keep the shadow frustum centred on the action, snapped to texels to stop shimmer. */
  update(time: number, focus: THREE.Vector3): void {
    this.skyMaterial.uniforms.uTime.value = time;
    const texel = (this.shadowExtent * 2) / this.sun.shadow.mapSize.x;
    this.tmp.copy(focus).applyMatrix4(this.lightBasisInv);
    this.tmp.x = Math.round(this.tmp.x / texel) * texel;
    this.tmp.y = Math.round(this.tmp.y / texel) * texel;
    this.tmp.applyMatrix4(this.lightBasis);
    this.sun.target.position.copy(this.tmp);
    this.sun.position.copy(this.tmp).addScaledVector(SUN_DIRECTION, 900);
    this.sun.target.updateMatrixWorld();
  }

  dispose(): void {
    this.scene.remove(this.sky, this.sun, this.sun.target, this.hemisphere);
    this.skyGeometry.dispose();
    this.skyMaterial.dispose();
    this.environment?.dispose();
    this.sun.shadow.map?.dispose();
  }
}
