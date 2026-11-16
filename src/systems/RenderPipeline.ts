import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ATMOSPHERE_GLSL, SUN_DIRECTION } from './Atmosphere';

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/**
 * Renders the scene into an HDR target with a depth texture, then resolves
 * analytic height fog whose colour follows the sky in the view direction.
 */
class SceneFogPass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    samples: number,
  ) {
    super();
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedIntType;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture,
      samples,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: depthTexture },
        uProjInv: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uSunDir: { value: SUN_DIRECTION.clone() },
        uDensity: { value: 0.0021 },
        uFalloff: { value: 0.0125 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform mat4 uProjInv;
        uniform mat4 uCamWorld;
        uniform vec3 uCamPos;
        uniform vec3 uSunDir;
        uniform float uDensity;
        uniform float uFalloff;
        varying vec2 vUv;
        ${ATMOSPHERE_GLSL}
        void main() {
          vec4 scene = texture2D(tColor, vUv);
          // A single NaN/Inf texel (pow of a negative, a zero-length normal...) would be
          // smeared over the whole frame by the bloom blur, so scrub them here.
          if (any(isnan(scene.rgb)) || any(isinf(scene.rgb))) scene.rgb = vec3(0.0);
          scene.rgb = clamp(scene.rgb, 0.0, 64.0);
          float depth = texture2D(tDepth, vUv).x;
          if (depth >= 0.999995) {
            gl_FragColor = vec4(scene.rgb, 1.0);
            return;
          }
          vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          vec4 view = uProjInv * ndc;
          view /= view.w;
          vec3 world = (uCamWorld * vec4(view.xyz, 1.0)).xyz;
          vec3 ray = world - uCamPos;
          float dist = length(ray);
          vec3 rd = ray / max(dist, 1e-4);
          float k = rd.y * uFalloff;
          float integral = abs(k) < 1e-5 ? dist : (1.0 - exp(-dist * k)) / k;
          float amount = uDensity * exp(-max(uCamPos.y, 0.0) * uFalloff) * integral;
          float fog = 1.0 - exp(-amount);
          vec3 hazeDir = normalize(vec3(rd.x, max(rd.y, 0.0) * 0.35 + 0.035, rd.z));
          vec3 haze = ashAtmosphere(hazeDir, uSunDir);
          // forward scattering: looking toward the sun the dust glows
          float sunAmt = max(dot(rd, uSunDir), 0.0);
          haze += vec3(1.3, 0.6, 0.2) * pow(sunAmt, 6.0) * 0.3;
          haze = min(haze, vec3(2.4, 1.5, 0.8));
          vec3 fogged = mix(scene.rgb, haze, clamp(fog, 0.0, 1.0));
          if (any(isnan(fogged)) || any(isinf(fogged))) fogged = scene.rgb;
          gl_FragColor = vec4(fogged, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.needsSwap = true;
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  /** Change the MSAA sample count; the GPU resources are rebuilt on the next render. */
  setSamples(samples: number): void {
    if (this.target.samples === samples) return;
    this.target.samples = samples;
    this.target.dispose();
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget): void {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    const uniforms = this.material.uniforms;
    (uniforms.uProjInv.value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse);
    (uniforms.uCamWorld.value as THREE.Matrix4).copy(this.camera.matrixWorld);
    (uniforms.uCamPos.value as THREE.Vector3).setFromMatrixPosition(this.camera.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

/** Light shafts, lens fringing, speed streaks, grade, ACES tone map, sRGB and grain in one pass. */
class FinalGradePass extends Pass {
  readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor(raySamples: number) {
    super();
    this.material = new THREE.ShaderMaterial({
      defines: { RAY_SAMPLES: raySamples },
      uniforms: {
        tDiffuse: { value: null },
        uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
        uSunWeight: { value: 0 },
        uExposure: { value: 1.0 },
        uAberration: { value: 0.0009 },
        uSpeed: { value: 0 },
        uTime: { value: 0 },
        uVignette: { value: 1 },
        uDesaturate: { value: 0 },
        uAspect: { value: 1 },
        uGrain: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 uSunScreen;
        uniform float uSunWeight;
        uniform float uExposure;
        uniform float uAberration;
        uniform float uSpeed;
        uniform float uTime;
        uniform float uVignette;
        uniform float uDesaturate;
        uniform float uAspect;
        uniform float uGrain;
        varying vec2 vUv;

        float gHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        // ACES filmic fit (Stephen Hill)
        vec3 rrtOdtFit(vec3 v) {
          vec3 a = v * (v + 0.0245786) - 0.000090537;
          vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
          return a / b;
        }
        vec3 acesFilmic(vec3 color) {
          const mat3 inputMat = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
          const mat3 outputMat = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
          color = inputMat * color;
          color = rrtOdtFit(color);
          return clamp(outputMat * color, 0.0, 1.0);
        }
        vec3 toSrgb(vec3 c) {
          c = max(c, 0.0);
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }

        void main() {
          vec2 centred = vUv - 0.5;
          float radius = length(centred * vec2(uAspect, 1.0));
          vec2 dir = centred;

          // lens fringing grows toward the edge
          float ca = uAberration * (0.35 + radius * 1.8);
          vec3 color;
          color.r = texture2D(tDiffuse, vUv + dir * ca).r;
          color.g = texture2D(tDiffuse, vUv).g;
          color.b = texture2D(tDiffuse, vUv - dir * ca).b;

          // speed streaks: radial smear only at the periphery
          float smear = uSpeed * smoothstep(0.28, 0.85, radius);
          if (smear > 0.001) {
            vec3 acc = color;
            for (int i = 1; i <= 5; i++) {
              acc += texture2D(tDiffuse, vUv - dir * smear * 0.035 * float(i)).rgb;
            }
            color = mix(color, acc / 6.0, min(1.0, smear * 1.4));
          }

          // volumetric light shafts marched toward the sun
          if (uSunWeight > 0.001) {
            float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
            vec2 delta = (uSunScreen - vUv) / float(RAY_SAMPLES) * 0.92;
            vec2 uv = vUv + delta * jitter;
            vec3 shafts = vec3(0.0);
            float decay = 1.0;
            for (int i = 0; i < RAY_SAMPLES; i++) {
              vec3 s = texture2D(tDiffuse, clamp(uv, 0.001, 0.999)).rgb;
              shafts += min(max(s - 1.15, 0.0), vec3(3.0)) * decay;
              decay *= 0.94;
              uv += delta;
            }
            color += shafts / float(RAY_SAMPLES) * uSunWeight * 1.25 * vec3(1.0, 0.72, 0.45);
          }

          if (any(isnan(color)) || any(isinf(color))) color = vec3(0.0);
          color = max(color, 0.0) * uExposure;
          // split-tone grade in scene-referred space: cool shadows, ember highlights
          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          color = mix(color, color * vec3(0.90, 1.0, 1.10), (1.0 - smoothstep(0.0, 0.35, luma)) * 0.55);
          color = mix(color, color * vec3(1.08, 0.99, 0.90), smoothstep(0.4, 2.0, luma) * 0.6);
          color = mix(vec3(luma), color, 1.08 - uDesaturate);

          color = acesFilmic(color);
          // gentle filmic contrast after the tone curve
          color = mix(color, color * color * (3.0 - 2.0 * color), 0.22);
          float vig = 1.0 - smoothstep(0.42, 1.12, radius) * 0.52 * uVignette;
          color *= vig;
          color = toSrgb(color);
          float grain = (gHash(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0) - 0.5) * 0.028 * uGrain;
          color += grain * (1.0 - 0.5 * luma);
          gl_FragColor = vec4(color, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

export type RenderFrameState = {
  time: number;
  /** 0..1 speed streak strength (boost). */
  speed: number;
  /** 0..1 transient impact, widens chromatic aberration. */
  impact: number;
  /** 0..1 drains colour (wrecked / low armour). */
  desaturate: number;
  /** Freeze grain and jitter for stable screenshots. */
  stable: boolean;
};

export class RenderPipeline {
  readonly composer: EffectComposer;
  private readonly fogPass: SceneFogPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly finalPass: FinalGradePass;
  private readonly sunWorld = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  readonly postPasses = 2;
  /**
   * 0 = full pipeline. Each step trades fidelity for compatibility when a GPU
   * returns a black frame: 1 = no MSAA, 2 = no bloom, 3 = plain forward render.
   */
  safeLevel = 0;
  private readonly scene: THREE.Scene;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    lowSpec: boolean,
  ) {
    this.scene = scene;
    renderer.toneMapping = THREE.NoToneMapping;
    this.composer = new EffectComposer(renderer);
    this.fogPass = new SceneFogPass(scene, camera, lowSpec ? 0 : 4);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), lowSpec ? 0.42 : 0.5, 0.72, 1.0);
    this.finalPass = new FinalGradePass(lowSpec ? 14 : 32);
    this.composer.addPass(this.fogPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.finalPass);
  }

  setSafeLevel(level: number): void {
    this.safeLevel = Math.max(0, Math.min(3, Math.floor(level)));
    if (this.safeLevel >= 1) this.fogPass.setSamples(0);
    this.bloomPass.enabled = this.safeLevel < 2;
    if (this.safeLevel >= 3) {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 0.9;
      this.scene.fog = new THREE.FogExp2(0x9a6444, 0.0021);
    } else {
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.scene.fog = null;
    }
  }

  setExposure(value: number): void {
    this.finalPass.material.uniforms.uExposure.value = value;
  }

  setFog(density: number): void {
    this.fogPass.material.uniforms.uDensity.value = density;
  }

  setSize(width: number, height: number, dpr: number): void {
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(width, height);
    this.finalPass.material.uniforms.uAspect.value = width / Math.max(1, height);
  }

  render(state: RenderFrameState): void {
    if (this.safeLevel >= 3) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const uniforms = this.finalPass.material.uniforms;
    // project the sun to screen space for the light-shaft march
    this.sunWorld.setFromMatrixPosition(this.camera.matrixWorld).addScaledVector(SUN_DIRECTION, 1000);
    this.camera.getWorldDirection(this.forward);
    const facing = this.forward.dot(SUN_DIRECTION);
    this.sunWorld.project(this.camera);
    (uniforms.uSunScreen.value as THREE.Vector2).set(this.sunWorld.x * 0.5 + 0.5, this.sunWorld.y * 0.5 + 0.5);
    const offscreen = Math.max(Math.abs(this.sunWorld.x), Math.abs(this.sunWorld.y));
    uniforms.uSunWeight.value = THREE.MathUtils.smoothstep(facing, 0.15, 0.6) * (1 - THREE.MathUtils.smoothstep(offscreen, 1.0, 1.9));
    uniforms.uTime.value = state.stable ? 0 : state.time;
    uniforms.uGrain.value = state.stable ? 0 : 1;
    uniforms.uSpeed.value = state.speed;
    uniforms.uAberration.value = 0.0009 + state.impact * 0.007;
    uniforms.uDesaturate.value = state.desaturate;
    this.composer.render();
    this.renderer.setRenderTarget(null);
  }

  dispose(): void {
    this.fogPass.dispose();
    this.bloomPass.dispose();
    this.finalPass.dispose();
    this.composer.dispose();
  }
}
