import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createWreckGeometry } from '../assets/modelFactories/VehicleModels';
import { createSeededRandom } from '../utils/random';
import { CITY, type CityLayout, type InstanceBox, type PropPlacement } from './CityLayout';
import { cityUniforms, createFacadeMaterial, createGroundMaterial } from './CityMaterials';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function boxMatrix(box: InstanceBox, out: THREE.Matrix4): THREE.Matrix4 {
  _e.set(box.rotX ?? 0, box.rotY ?? 0, box.rotZ ?? 0, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(box.x, box.y, box.z);
  _s.set(box.sx, box.sy, box.sz);
  return out.compose(_p, _q, _s);
}

export type GlowPoint = { x: number; y: number; z: number; r: number; g: number; b: number; size: number; flicker: number };

export type FireEmitter = { x: number; y: number; z: number; strength: number };

export type CityWorld = {
  group: THREE.Group;
  fires: FireEmitter[];
  glow: GlowField;
  update(time: number, cameraPosition: THREE.Vector3): void;
  dispose(): void;
};

/** One draw call of additive soft sprites: lamps, embers, beacons. */
export class GlowField {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(points: GlowPoint[]) {
    const geometry = new THREE.BufferGeometry();
    const position = new Float32Array(points.length * 3);
    const color = new Float32Array(points.length * 3);
    const info = new Float32Array(points.length * 2);
    points.forEach((g, i) => {
      position.set([g.x, g.y, g.z], i * 3);
      color.set([g.r, g.g, g.b], i * 3);
      info.set([g.size, g.flicker], i * 2);
    });
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 2));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4000);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: cityUniforms.uTime, uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute vec2 aInfo;
        attribute vec3 color;
        uniform float uTime;
        uniform float uScale;
        varying vec3 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float phase = position.x * 0.37 + position.z * 0.53;
          float flick = 1.0 - aInfo.y * (0.35 * sin(uTime * 17.0 + phase) * sin(uTime * 7.3 + phase * 1.7) + 0.25 * step(0.92, sin(uTime * 3.1 + phase * 4.0)));
          vColor = color * flick;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(220.0, aInfo.x * uScale / max(1.0, -mv.z));
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d) * 2.0;
          float core = exp(-r * r * 14.0);
          float halo = pow(max(0.0, 1.0 - r), 2.4) * 0.35;
          gl_FragColor = vec4(vColor * (core + halo), 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  setViewportHeight(height: number): void {
    this.material.uniforms.uScale.value = height * 0.9;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
  cast: boolean,
  receive: boolean,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
  mesh.count = count;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.frustumCulled = false;
  return mesh;
}

function placeProps(mesh: THREE.InstancedMesh, props: PropPlacement[], rotate: (p: PropPlacement, e: THREE.Euler) => void, scale = 1): void {
  props.forEach((prop, index) => {
    _e.set(0, prop.rot, 0, 'YXZ');
    rotate(prop, _e);
    _q.setFromEuler(_e);
    _p.set(prop.x, prop.y, prop.z);
    const s = (prop.scale || 1) * scale;
    _s.set(s, s, s);
    mesh.setMatrixAt(index, _m.compose(_p, _q, _s));
  });
  mesh.instanceMatrix.needsUpdate = true;
}

function createLampGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const base = new THREE.CylinderGeometry(0.2, 0.26, 0.7, 8);
  base.translate(0, 0.35, 0);
  const pole = new THREE.CylinderGeometry(0.075, 0.12, 8.6, 8);
  pole.translate(0, 4.3, 0);
  const arm = new THREE.CylinderGeometry(0.05, 0.065, 2.7, 6);
  arm.rotateX(Math.PI / 2 - 0.22);
  arm.translate(0, 8.75, 1.2);
  const head = new THREE.BoxGeometry(0.42, 0.14, 1.0);
  head.translate(0, 9.02, 2.5);
  const brace = new THREE.CylinderGeometry(0.03, 0.03, 1.6, 5);
  brace.rotateX(Math.PI / 2 - 0.75);
  brace.translate(0, 8.15, 0.55);
  parts.push(base, pole, arm, head, brace);
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  parts.forEach((g) => g.dispose());
  return merged;
}

function createBarrierGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.42, 0);
  shape.lineTo(0.42, 0);
  shape.lineTo(0.42, 0.2);
  shape.lineTo(0.2, 0.46);
  shape.lineTo(0.13, 1.05);
  shape.lineTo(-0.13, 1.05);
  shape.lineTo(-0.2, 0.46);
  shape.lineTo(-0.42, 0.2);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 3.1, bevelEnabled: false });
  geometry.translate(0, 0, -1.55);
  geometry.rotateY(Math.PI / 2);
  return geometry;
}

function createRockGeometry(seed: number): THREE.BufferGeometry {
  const rng = createSeededRandom(seed);
  const source = seed % 2 === 0 ? new THREE.DodecahedronGeometry(1, 0) : new THREE.BoxGeometry(1.6, 0.9, 1.3, 2, 1, 2);
  const geometry = source.toNonIndexed();
  source.dispose();
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const cache = new Map<string, [number, number, number]>();
  for (let i = 0; i < position.count; i += 1) {
    const key = `${position.getX(i).toFixed(3)},${position.getY(i).toFixed(3)},${position.getZ(i).toFixed(3)}`;
    let jitter = cache.get(key);
    if (!jitter) {
      jitter = [(rng() - 0.5) * 0.5, (rng() - 0.5) * 0.36, (rng() - 0.5) * 0.5];
      cache.set(key, jitter);
    }
    position.setXYZ(i, position.getX(i) + jitter[0], position.getY(i) * 0.75 + jitter[1], position.getZ(i) + jitter[2]);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function createBillboardTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const rng = createSeededRandom(77);
  const ads: [string, string, string, string][] = [
    ['#7a2f1c', '#e9d6b0', '灰都電力', 'KAITO GRID'],
    ['#1f3c44', '#d8e6da', '第七中継', 'RELAY-07'],
    ['#4a3a16', '#f0c060', '新天地', 'NEW HORIZON'],
    ['#2a2a2e', '#c85a3a', '退避せよ', 'EVACUATE'],
  ];
  ads.forEach(([bg, fg, jp, en], index) => {
    const x = index * 256;
    ctx.fillStyle = bg;
    ctx.fillRect(x, 0, 256, 256);
    ctx.fillStyle = fg;
    ctx.globalAlpha = 0.9;
    ctx.font = '900 62px "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(jp, x + 128, 118);
    ctx.font = '700 26px "Arial Narrow", Arial, sans-serif';
    ctx.fillText(en, x + 128, 168);
    ctx.fillRect(x + 28, 190, 200, 6);
    ctx.globalAlpha = 1;
    // peeling, rust runs and soot
    for (let n = 0; n < 90; n += 1) {
      ctx.fillStyle = `rgba(${20 + rng() * 40},${14 + rng() * 22},${8 + rng() * 14},${0.12 + rng() * 0.3})`;
      const w = 2 + rng() * 14;
      ctx.fillRect(x + rng() * 256, rng() * 200, w, 30 + rng() * 150);
    }
    for (let n = 0; n < 9; n += 1) {
      ctx.fillStyle = 'rgba(12,10,9,0.92)';
      ctx.beginPath();
      const px = x + rng() * 256;
      const py = rng() * 256;
      ctx.ellipse(px, py, 8 + rng() * 34, 6 + rng() * 26, rng() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function buildCity(layout: CityLayout): CityWorld {
  const group = new THREE.Group();
  group.name = 'city';
  const disposables: { dispose(): void }[] = [];
  const glowPoints: GlowPoint[] = [];
  const fires: FireEmitter[] = [];
  const rng = createSeededRandom(4242);

  // ---------------------------------------------------------------- ground
  const roadMaterial = createGroundMaterial('road');
  const groundGeometry = new THREE.PlaneGeometry(4200, 4200, 1, 1);
  groundGeometry.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(groundGeometry, roadMaterial);
  ground.receiveShadow = true;
  ground.name = 'ground';
  group.add(ground);
  disposables.push(groundGeometry, roadMaterial);

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(unitBox);

  const pavingMaterial = createGroundMaterial('paving', layout.relay);
  const slabs = instanced(unitBox, pavingMaterial, layout.slabs.length, false, true);
  layout.slabs.forEach((box, index) => slabs.setMatrixAt(index, boxMatrix(box, _m)));
  slabs.name = 'blockSlabs';
  group.add(slabs);
  disposables.push(pavingMaterial);

  // ---------------------------------------------------------------- towers
  const facadeMaterial = createFacadeMaterial();
  const allFacades = [...layout.facades, ...layout.farTowers];
  const facadeGeometry = unitBox.clone();
  const info = new Float32Array(allFacades.length * 2);
  allFacades.forEach((box, index) => {
    info[index * 2] = box.style;
    info[index * 2 + 1] = box.tint;
  });
  facadeGeometry.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 2));
  const facades = instanced(facadeGeometry, facadeMaterial, allFacades.length, true, true);
  allFacades.forEach((box, index) => facades.setMatrixAt(index, boxMatrix(box, _m)));
  facades.name = 'towers';
  group.add(facades);
  disposables.push(facadeGeometry, facadeMaterial);

  // ---------------------------------------------------------------- structure: frames, roof kit, highway
  const concreteMaterial = createGroundMaterial('concrete');
  const structure = [...layout.frames, ...layout.roofProps, ...layout.highway];
  const structureMesh = instanced(unitBox, concreteMaterial, structure.length, true, true);
  const frameCount = layout.frames.length;
  const roofCount = layout.roofProps.length;
  structure.forEach((box, index) => {
    structureMesh.setMatrixAt(index, boxMatrix(box, _m));
    if (index < frameCount) {
      _c.setRGB(0.62, 0.6, 0.58).multiplyScalar(0.7 + box.tint * 0.5);
    } else if (index < frameCount + roofCount) {
      if (box.style === 1) _c.setRGB(0.3, 0.3, 0.32);
      else if (box.style === 2) _c.setRGB(0.75, 0.42, 0.26);
      else _c.setRGB(0.95, 0.92, 0.88).multiplyScalar(0.75 + box.tint * 0.4);
    } else {
      _c.setRGB(1.0, 0.98, 0.95).multiplyScalar(box.style === 1 ? 0.78 : 1);
    }
    structureMesh.setColorAt(index, _c);
  });
  structureMesh.name = 'structure';
  group.add(structureMesh);
  disposables.push(concreteMaterial);

  // ---------------------------------------------------------------- street lamps
  const metalMaterial = new THREE.MeshStandardMaterial({ color: '#1b1a19', roughness: 0.62, metalness: 0.75 });
  const lampGeometry = createLampGeometry();
  const lamps = instanced(lampGeometry, metalMaterial, layout.lamps.length, true, false);
  placeProps(lamps, layout.lamps, (prop, euler) => {
    if (prop.scale > 0) {
      euler.x = Math.PI / 2 - prop.scale;
      euler.z = (rng() - 0.5) * 0.6;
    } else {
      euler.x = (rng() - 0.5) * 0.07;
      euler.z = (rng() - 0.5) * 0.07;
    }
  });
  // placeProps used prop.scale for size; lamps always render at unit scale
  layout.lamps.forEach((prop, index) => {
    lamps.getMatrixAt(index, _m);
    _m.decompose(_p, _q, _s);
    _s.set(1, 1, 1);
    lamps.setMatrixAt(index, _m.compose(_p, _q, _s));
    if (prop.flag) {
      const hx = prop.x + Math.sin(prop.rot) * 2.5;
      const hz = prop.z + Math.cos(prop.rot) * 2.5;
      glowPoints.push({ x: hx, y: prop.y + 8.9, z: hz, r: 2.6, g: 1.5, b: 0.62, size: 2.6, flicker: rng() < 0.4 ? 1 : 0.15 });
      fires.push({ x: hx, y: prop.y + 8.6, z: hz, strength: 0 });
    }
  });
  lamps.instanceMatrix.needsUpdate = true;
  lamps.name = 'lamps';
  group.add(lamps);
  disposables.push(lampGeometry, metalMaterial);

  // ---------------------------------------------------------------- wrecks
  const wreckMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.35 });
  disposables.push(wreckMaterial);
  for (let variant = 0; variant < 3; variant += 1) {
    const list = layout.wrecks.filter((w) => w.variant === variant);
    if (list.length === 0) continue;
    const geometry = createWreckGeometry(variant);
    const mesh = instanced(geometry, wreckMaterial, list.length, true, true);
    placeProps(mesh, list, (prop, euler) => {
      euler.z = prop.flag ? (rng() - 0.5) * 0.5 : (rng() - 0.5) * 0.06;
      euler.x = (rng() - 0.5) * 0.05;
    });
    mesh.name = `wrecks${variant}`;
    group.add(mesh);
    disposables.push(geometry);
    for (const wreck of list) {
      if (wreck.flag) fires.push({ x: wreck.x, y: 1.1, z: wreck.z, strength: 0.7 });
    }
  }

  // ---------------------------------------------------------------- rubble
  const rubbleMaterial = new THREE.MeshStandardMaterial({ color: '#57524b', roughness: 0.95, metalness: 0, flatShading: true });
  disposables.push(rubbleMaterial);
  for (let variant = 0; variant < 3; variant += 1) {
    const list = layout.rubble.filter((r) => r.variant === variant);
    const geometry = createRockGeometry(11 + variant);
    const mesh = instanced(geometry, rubbleMaterial, list.length, true, true);
    placeProps(mesh, list, (_prop, euler) => {
      euler.x = (rng() - 0.5) * 1.2;
      euler.z = (rng() - 0.5) * 1.2;
    });
    list.forEach((_prop, index) => {
      const tone = 0.55 + rng() * 0.6;
      mesh.setColorAt(index, _c.setRGB(tone, tone * (0.94 + rng() * 0.08), tone * (0.86 + rng() * 0.1)));
    });
    mesh.name = `rubble${variant}`;
    group.add(mesh);
    disposables.push(geometry);
  }

  // ---------------------------------------------------------------- barriers and barrels
  const barrierGeometry = createBarrierGeometry();
  const barriers = instanced(barrierGeometry, concreteMaterial, layout.barriers.length, true, true);
  placeProps(barriers, layout.barriers, (_prop, euler) => {
    euler.z = (rng() - 0.5) * 0.08;
  });
  layout.barriers.forEach((_prop, index) => barriers.setColorAt(index, _c.setRGB(1.25, 1.18, 1.05)));
  barriers.name = 'barriers';
  group.add(barriers);
  disposables.push(barrierGeometry);

  const barrelGeometry = new THREE.CylinderGeometry(0.42, 0.4, 1.15, 14, 3, true);
  barrelGeometry.translate(0, 0.575, 0);
  const barrelMaterial = new THREE.MeshStandardMaterial({ color: '#4a2a1c', roughness: 0.7, metalness: 0.6, side: THREE.DoubleSide });
  const barrels = instanced(barrelGeometry, barrelMaterial, layout.barrels.length, true, false);
  placeProps(barrels, layout.barrels, () => undefined);
  barrels.name = 'barrels';
  group.add(barrels);
  disposables.push(barrelGeometry, barrelMaterial);
  for (const barrel of layout.barrels) {
    fires.push({ x: barrel.x, y: barrel.y + 1.2, z: barrel.z, strength: 1 });
    glowPoints.push({ x: barrel.x, y: barrel.y + 1.5, z: barrel.z, r: 2.4, g: 0.9, b: 0.22, size: 3.4, flicker: 1 });
  }

  // ---------------------------------------------------------------- billboards
  if (layout.billboards.length > 0) {
    const texture = createBillboardTexture();
    const panelMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8, metalness: 0.1, side: THREE.DoubleSide });
    disposables.push(texture, panelMaterial);
    const frameParts: THREE.BufferGeometry[] = [];
    for (const x of [-6.2, 0, 6.2]) {
      const leg = new THREE.BoxGeometry(0.35, 9, 0.35);
      leg.translate(x, 4.5, -0.5);
      const strut = new THREE.BoxGeometry(0.2, 6.5, 0.2);
      strut.rotateX(0.5);
      strut.translate(x, 3.2, -2.2);
      frameParts.push(leg, strut);
    }
    for (const y of [3.4, 9.2]) {
      const rail = new THREE.BoxGeometry(14.6, 0.3, 0.3);
      rail.translate(0, y, -0.4);
      frameParts.push(rail);
    }
    const frameGeometry = mergeGeometries(frameParts.map((g) => g.toNonIndexed()));
    frameParts.forEach((g) => g.dispose());
    const frames = instanced(frameGeometry, metalMaterial, layout.billboards.length, true, false);
    placeProps(frames, layout.billboards, () => undefined);
    group.add(frames);
    disposables.push(frameGeometry);
    for (let variant = 0; variant < 4; variant += 1) {
      const list = layout.billboards.filter((b) => b.variant === variant);
      if (list.length === 0) continue;
      const panel = new THREE.PlaneGeometry(14, 5.6);
      const uv = panel.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i += 1) uv.setX(i, (variant + uv.getX(i)) / 4);
      panel.translate(0, 6.3, -0.2);
      const mesh = instanced(panel, panelMaterial, list.length, true, false);
      placeProps(mesh, list, () => undefined);
      group.add(mesh);
      disposables.push(panel);
    }
  }

  // ---------------------------------------------------------------- cables
  {
    const segments = 10;
    const position = new Float32Array(layout.cables.length * segments * 6);
    let offset = 0;
    for (const cable of layout.cables) {
      for (let n = 0; n < segments; n += 1) {
        for (const t of [n / segments, (n + 1) / segments]) {
          const sag = Math.sin(t * Math.PI) * cable.sag;
          position[offset] = cable.ax + (cable.bx - cable.ax) * t;
          position[offset + 1] = cable.ay + (cable.by - cable.ay) * t - sag;
          position[offset + 2] = cable.az + (cable.bz - cable.az) * t;
          offset += 3;
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    const material = new THREE.LineBasicMaterial({ color: '#0b0a0a' });
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    lines.name = 'cables';
    group.add(lines);
    disposables.push(geometry, material);
  }

  // distant embers on the skyline give the horizon life
  for (let n = 0; n < 26; n += 1) {
    const tower = layout.farTowers[Math.floor(rng() * layout.farTowers.length)];
    glowPoints.push({ x: tower.x, y: tower.sy * (0.3 + rng() * 0.6), z: tower.z, r: 2.2, g: 0.7, b: 0.2, size: 9 + rng() * 10, flicker: 1 });
  }

  const glow = new GlowField(glowPoints);
  group.add(glow.points);
  disposables.push(glow);

  return {
    group,
    fires,
    glow,
    update(time: number): void {
      cityUniforms.uTime.value = time;
    },
    dispose(): void {
      for (const item of disposables) item.dispose();
    },
  };
}

// ------------------------------------------------------------------ relay tower

export type RelayTower = {
  group: THREE.Group;
  /** 0 = dormant, 1 = fully powered. */
  setPower(power01: number): void;
  update(time: number, objectiveVisible: boolean): void;
  height: number;
};

export function buildRelayTower(position: { x: number; z: number }): RelayTower {
  const group = new THREE.Group();
  group.name = 'relayTower';
  group.position.set(position.x, CITY.curbHeight, position.z);
  const height = 82;
  const steel: THREE.BufferGeometry[] = [];
  const concrete: THREE.BufferGeometry[] = [];

  const beam = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, thickness: number) => {
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    const length = a.distanceTo(b);
    const geometry = new THREE.BoxGeometry(thickness, length, thickness);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    geometry.applyQuaternion(quaternion);
    geometry.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    steel.push(geometry);
  };

  const sections = 11;
  const baseY = 5.5;
  const halfAt = (y: number) => 4.4 - 3.5 * Math.pow((y - baseY) / (height - baseY), 0.8);
  for (let s = 0; s < sections; s += 1) {
    const y0 = baseY + ((height - baseY) / sections) * s;
    const y1 = baseY + ((height - baseY) / sections) * (s + 1);
    const h0 = halfAt(y0);
    const h1 = halfAt(y1);
    const corners0: [number, number][] = [[-h0, -h0], [h0, -h0], [h0, h0], [-h0, h0]];
    const corners1: [number, number][] = [[-h1, -h1], [h1, -h1], [h1, h1], [-h1, h1]];
    for (let c = 0; c < 4; c += 1) {
      const n = (c + 1) % 4;
      beam(corners0[c][0], y0, corners0[c][1], corners1[c][0], y1, corners1[c][1], 0.34);
      beam(corners1[c][0], y1, corners1[c][1], corners1[n][0], y1, corners1[n][1], 0.18);
      if ((s + c) % 2 === 0) beam(corners0[c][0], y0, corners0[c][1], corners1[n][0], y1, corners1[n][1], 0.13);
      else beam(corners0[n][0], y0, corners0[n][1], corners1[c][0], y1, corners1[c][1], 0.13);
    }
  }
  // service platforms with railings
  for (const y of [30, 52, 70]) {
    const half = halfAt(y) + 1.7;
    const deck = new THREE.BoxGeometry(half * 2, 0.25, half * 2);
    deck.translate(0, y, 0);
    steel.push(deck);
    for (const [x, z, w, d] of [[0, -half, half * 2, 0.1], [0, half, half * 2, 0.1], [-half, 0, 0.1, half * 2], [half, 0, 0.1, half * 2]] as const) {
      const rail = new THREE.BoxGeometry(w, 0.1, d);
      rail.translate(x, y + 1.1, z);
      steel.push(rail);
    }
  }
  // mast and antenna combs
  beam(0, height, 0, 0, height + 15, 0, 0.3);
  for (let n = 0; n < 5; n += 1) {
    const y = height + 3 + n * 2.4;
    beam(-2.2 + n * 0.3, y, 0, 2.2 - n * 0.3, y, 0, 0.12);
    beam(0, y + 1.1, -1.8 + n * 0.25, 0, y + 1.1, 1.8 - n * 0.25, 0.12);
  }
  // guy anchors
  for (const [x, z] of [[-19, -19], [19, -19], [19, 19], [-19, 19]] as const) {
    beam(x, 0.5, z, Math.sign(x) * 1.6, 56, Math.sign(z) * 1.6, 0.07);
    const anchor = new THREE.BoxGeometry(2.2, 1.2, 2.2);
    anchor.translate(x, 0.6, z);
    concrete.push(anchor);
  }
  // bunker base
  const bunker = new THREE.BoxGeometry(10.4, 5.5, 10.4);
  bunker.translate(0, 2.75, 0);
  const lip = new THREE.BoxGeometry(11.4, 0.5, 11.4);
  lip.translate(0, 5.5, 0);
  const stair = new THREE.BoxGeometry(3.4, 0.7, 2.2);
  stair.translate(0, 0.35, 6.3);
  concrete.push(bunker, lip, stair);
  for (const [x, z] of [[-6.6, 2.5], [6.6, -2], [6.4, 2.6]] as const) {
    const unit = new THREE.BoxGeometry(2.1, 2.3, 3.2);
    unit.translate(x, 1.15, z);
    steel.push(unit);
  }

  const steelMaterial = new THREE.MeshStandardMaterial({ color: '#3b2f29', roughness: 0.58, metalness: 0.8 });
  const steelMesh = new THREE.Mesh(mergeGeometries(steel.map((g) => g.toNonIndexed())), steelMaterial);
  steel.forEach((g) => g.dispose());
  steelMesh.castShadow = true;
  steelMesh.receiveShadow = true;
  steelMesh.name = 'relayLattice';
  group.add(steelMesh);

  const concreteMaterial = createGroundMaterial('concrete');
  const concreteMesh = new THREE.Mesh(mergeGeometries(concrete.map((g) => g.toNonIndexed())), concreteMaterial);
  concrete.forEach((g) => g.dispose());
  concreteMesh.castShadow = true;
  concreteMesh.receiveShadow = true;
  concreteMesh.name = 'relayBunker';
  group.add(concreteMesh);

  // dishes
  const dishProfile: THREE.Vector2[] = [];
  for (let n = 0; n <= 10; n += 1) {
    const r = (n / 10) * 2.3;
    dishProfile.push(new THREE.Vector2(r, r * r * 0.17));
  }
  const dishGeometry = new THREE.LatheGeometry(dishProfile, 24);
  const dishMaterial = new THREE.MeshStandardMaterial({ color: '#8f887c', roughness: 0.5, metalness: 0.55, side: THREE.DoubleSide });
  const dishes: [number, number, number, number][] = [[52.8, 0.6, 1.2, 1], [53.2, 3.6, 1.0, 0.8], [71, 1.9, 0.9, 0.7], [31.2, 5.0, 1.15, 1.05]];
  for (const [y, yaw, tilt, scale] of dishes) {
    const dish = new THREE.Mesh(dishGeometry, dishMaterial);
    const radius = halfAt(y) + 1.9;
    dish.position.set(Math.sin(yaw) * radius, y + 1.6, Math.cos(yaw) * radius);
    dish.rotation.set(tilt, yaw, 0, 'YXZ');
    dish.scale.setScalar(scale);
    dish.castShadow = true;
    group.add(dish);
  }

  // status strips and warning lamps
  const signalMaterial = new THREE.MeshStandardMaterial({ color: '#111111', emissive: '#ff3b1f', emissiveIntensity: 1.2, roughness: 0.4 });
  const signalParts: THREE.BufferGeometry[] = [];
  for (const y of [30.6, 52.6, 70.6, height + 15]) {
    const lamp = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    lamp.translate(0, y, 0);
    signalParts.push(lamp);
  }
  for (const [x, z, w, d] of [[0, 5.24, 6.4, 0.08], [0, -5.24, 6.4, 0.08], [5.24, 0, 0.08, 6.4], [-5.24, 0, 0.08, 6.4]] as const) {
    const strip = new THREE.BoxGeometry(w, 0.28, d);
    strip.translate(x, 4.4, z);
    signalParts.push(strip);
  }
  for (let s = 1; s < sections; s += 2) {
    const y = baseY + ((height - baseY) / sections) * s;
    const h = halfAt(y) + 0.08;
    for (const [x, z] of [[-h, -h], [h, -h], [h, h], [-h, h]] as const) {
      const pip = new THREE.BoxGeometry(0.22, 1.6, 0.22);
      pip.translate(x, y, z);
      signalParts.push(pip);
    }
  }
  const signalMesh = new THREE.Mesh(mergeGeometries(signalParts.map((g) => g.toNonIndexed())), signalMaterial);
  signalParts.forEach((g) => g.dispose());
  signalMesh.name = 'relaySignals';
  group.add(signalMesh);

  // skyward beam: thin objective beacon while dormant, a full carrier column when powered
  const beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true);
  beamGeometry.translate(0, 0.5, 0);
  const beamMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#ffb347') },
      uIntensity: { value: 0.5 },
      uTime: cityUniforms.uTime,
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormalV = normalize(normalMatrix * normal);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        float facing = abs(dot(normalize(vNormalV), normalize(vViewDir)));
        float core = pow(clamp(facing, 0.0, 1.0), 2.2);
        float rise = 0.75 + 0.25 * sin(vUv.y * 90.0 - uTime * 5.0);
        float fade = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 1.6) * smoothstep(0.0, 0.01, vUv.y);
        gl_FragColor = vec4(uColor * uIntensity * core * rise * fade, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
  });
  const beamMesh = new THREE.Mesh(beamGeometry, beamMaterial);
  beamMesh.position.y = height + 14;
  beamMesh.scale.set(0.8, 700, 0.8);
  beamMesh.renderOrder = 6;
  beamMesh.frustumCulled = false;
  group.add(beamMesh);

  const dormant = new THREE.Color('#ff3b1f');
  const live = new THREE.Color('#38f5d8');
  const amber = new THREE.Color('#ffb347');
  let power = 0;

  return {
    group,
    height,
    setPower(power01: number): void {
      power = THREE.MathUtils.clamp(power01, 0, 1);
      cityUniforms.uPower.value = power;
    },
    update(time: number, objectiveVisible: boolean): void {
      const blink = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(time * 2.4)), 6);
      signalMaterial.emissive.copy(dormant).lerp(live, power);
      signalMaterial.emissiveIntensity = THREE.MathUtils.lerp(1.6 * blink, 5.5 + 1.2 * Math.sin(time * 3.0), power);
      beamMaterial.uniforms.uColor.value.copy(amber).lerp(live, power);
      const target = power > 0 ? 0.9 + power * 2.6 : objectiveVisible ? 0.75 : 0;
      beamMaterial.uniforms.uIntensity.value = target;
      const width = 0.7 + power * 2.1;
      beamMesh.scale.set(width, 700, width);
      beamMesh.visible = target > 0.01;
    },
  };
}
