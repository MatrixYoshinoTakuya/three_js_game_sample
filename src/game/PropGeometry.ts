import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Small kit for authoring gameplay props (pickups, drums, caches, missiles) as
 * ONE merged, vertex-coloured geometry each, so a whole prop type is a single
 * instanced draw call. `glow` marks faces that should stay lit at dusk (lenses,
 * stripes, warning paint); the matching material adds them to the emissive term.
 */

export type PartOptions = {
  x?: number; y?: number; z?: number;
  rx?: number; ry?: number; rz?: number;
  sx?: number; sy?: number; sz?: number;
  /** 0..n emissive multiplier for this part (vertex colour x glow). */
  glow?: number;
};

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();
const _color = new THREE.Color();

export class PartBuilder {
  private readonly parts: THREE.BufferGeometry[] = [];

  /** Adds a part; the source geometry is consumed (disposed). */
  add(source: THREE.BufferGeometry, color: THREE.ColorRepresentation, options: PartOptions = {}): this {
    const geometry = source.index ? source.toNonIndexed() : source.clone();
    source.dispose();
    _euler.set(options.rx ?? 0, options.ry ?? 0, options.rz ?? 0);
    _matrix.compose(
      _position.set(options.x ?? 0, options.y ?? 0, options.z ?? 0),
      _quaternion.setFromEuler(_euler),
      _scale.set(options.sx ?? 1, options.sy ?? 1, options.sz ?? 1),
    );
    geometry.applyMatrix4(_matrix);
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
    }
    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3);
    const glows = new Float32Array(count);
    _color.set(color);
    const glow = options.glow ?? 0;
    for (let i = 0; i < count; i += 1) {
      colors[i * 3] = _color.r;
      colors[i * 3 + 1] = _color.g;
      colors[i * 3 + 2] = _color.b;
      glows[i] = glow;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aGlow', new THREE.BufferAttribute(glows, 1));
    this.parts.push(geometry);
    return this;
  }

  box(w: number, h: number, d: number, color: THREE.ColorRepresentation, options: PartOptions = {}): this {
    return this.add(new THREE.BoxGeometry(w, h, d), color, options);
  }

  /** Box with chamfered edges: reads as pressed/cast metal instead of a raw cube. */
  bevel(w: number, h: number, d: number, radius: number, color: THREE.ColorRepresentation, options: PartOptions = {}): this {
    return this.add(new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 2.01, h / 2.01, d / 2.01)), color, options);
  }

  cylinder(rTop: number, rBottom: number, h: number, segments: number, color: THREE.ColorRepresentation, options: PartOptions = {}): this {
    return this.add(new THREE.CylinderGeometry(rTop, rBottom, h, segments), color, options);
  }

  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    for (const part of this.parts) part.dispose();
    this.parts.length = 0;
    merged.computeBoundingSphere();
    return merged;
  }
}

/** Lit vertex-colour material whose `aGlow` faces are added to the emissive term (drives bloom). */
export function createPropMaterial(roughness: number, metalness: number, glowBoost = 1): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness });
  const uniform = { value: glowBoost };
  material.userData.glowBoost = uniform;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowBoost = uniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform float uGlowBoost;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * uGlowBoost;');
  };
  material.customProgramCacheKey = () => 'prop-glow';
  return material;
}

/** Hide an instance without touching `count` (keeps slot indices stable). */
export const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0).setPosition(0, -200, 0);
