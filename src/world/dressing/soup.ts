import * as THREE from 'three';

/**
 * Tiny geometry-authoring toolkit for the set dressing. A `Soup` is a growable
 * indexed triangle list with the attributes every dressing material needs
 * (position, normal, colour(+alpha), uv, fx). Props are authored once into a
 * template soup in local space and then stamped many times into a few merged
 * world-space soups, so the whole kit renders in a handful of draw calls.
 */

export type Rgb = readonly [number, number, number];
/** [sway weight, emissive strength, blink mode + phase fraction] */
export type Fx = readonly [number, number, number];

const NO_FX: Fx = [0, 0, 0];
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Compose a TRS matrix into a shared scratch matrix (consume it immediately). */
export function trs(x: number, y: number, z: number, rotY = 0, scale = 1, rotX = 0, rotZ = 0, out: THREE.Matrix4 = _m2): THREE.Matrix4 {
  _e.set(rotX, rotY, rotZ, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(scale, scale, scale);
  return out.compose(_p, _q, _s);
}

export class Soup {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  fx: number[] = [];
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, a = 1, u = 0, v = 0, fx: Fx = NO_FX): number {
    const index = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(r, g, b, a);
    this.uv.push(u, v);
    this.fx.push(fx[0], fx[1], fx[2]);
    return index;
  }

  /** Append a three.js geometry (disposed afterwards) with a flat colour. */
  geo(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, color: Rgb, fx: Fx = NO_FX): this {
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const base = this.vertexCount;
    if (matrix) _nm.getNormalMatrix(matrix);
    for (let i = 0; i < position.count; i += 1) {
      _v.set(position.getX(i), position.getY(i), position.getZ(i));
      if (normal) _n.set(normal.getX(i), normal.getY(i), normal.getZ(i));
      else _n.set(0, 1, 0);
      if (matrix) {
        _v.applyMatrix4(matrix);
        _n.applyMatrix3(_nm);
      }
      const len = _n.length();
      if (len > 1e-8) _n.multiplyScalar(1 / len);
      else _n.set(0, 1, 0);
      this.vertex(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, color[0], color[1], color[2], 1, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0, fx);
    }
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 1) this.idx.push(base + index.getX(i));
    } else {
      for (let i = 0; i < position.count; i += 1) this.idx.push(base + i);
    }
    geometry.dispose();
    return this;
  }

  /** Axis-aligned box centred on (x, y, z), optionally yawed/tilted about its centre. */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: Rgb, rotY = 0, rotX = 0, rotZ = 0, fx: Fx = NO_FX): this {
    return this.geo(new THREE.BoxGeometry(sx, sy, sz), trs(x, y, z, rotY, 1, rotX, rotZ, _m), color, fx);
  }

  /** Cylinder centred on (x, y, z) along the given axis. */
  cyl(x: number, y: number, z: number, rTop: number, rBottom: number, h: number, seg: number, color: Rgb, axis: 'x' | 'y' | 'z' = 'y', open = false, fx: Fx = NO_FX): this {
    const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    return this.geo(g, null, color, fx);
  }

  /** Square (or n-sided) prism between two points, without end caps. */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, thickness: number, color: Rgb, sides = 4, fx: Fx = NO_FX): this {
    _a.set(ax, ay, az);
    _b.set(bx, by, bz);
    _c.subVectors(_b, _a);
    const len = _c.length();
    if (len < 1e-4) return this;
    _c.multiplyScalar(1 / len);
    const g = new THREE.CylinderGeometry(thickness * 0.5, thickness * 0.5, len, sides, 1, true);
    _q.setFromUnitVectors(UP, _c);
    _p.addVectors(_a, _b).multiplyScalar(0.5);
    _s.set(1, 1, 1);
    return this.geo(g, _m.compose(_p, _q, _s), color, fx);
  }

  /**
   * Quad a→b→c→d (counter-clockwise seen from the front). `rect` is the uv
   * rectangle [u0, v0, u1, v1] with a at (u0,v0), b at (u1,v0), c at (u1,v1), d at (u0,v1).
   * `sway` gives per-corner sway weights [a, b, c, d] for cloth/foliage.
   */
  quad(
    a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[],
    rect: readonly number[], color: Rgb, alpha = 1, normal: readonly number[] | null = null,
    sway: readonly number[] | null = null, glow = 0, blink = 0,
  ): this {
    let nx: number;
    let ny: number;
    let nz: number;
    if (normal) {
      [nx, ny, nz] = normal;
    } else {
      _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      _b.set(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
      _c.crossVectors(_a, _b);
      const len = _c.length();
      if (len < 1e-10) return this;
      nx = _c.x / len;
      ny = _c.y / len;
      nz = _c.z / len;
    }
    const base = this.vertexCount;
    const corners = [a, b, c, d];
    const us = [rect[0], rect[2], rect[2], rect[0]];
    const vs = [rect[1], rect[1], rect[3], rect[3]];
    for (let i = 0; i < 4; i += 1) {
      const p = corners[i];
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx, ny, nz);
      this.col.push(color[0], color[1], color[2], alpha);
      this.uv.push(us[i], vs[i]);
      this.fx.push(sway ? sway[i] : 0, glow, blink);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return this;
  }

  /** Recolour vertices added since `fromVertex` (used for paint bands, soot gradients, rust). */
  paint(fromVertex: number, fn: (x: number, y: number, z: number, rgb: number[]) => void): this {
    const rgb = [0, 0, 0];
    for (let i = fromVertex; i < this.vertexCount; i += 1) {
      rgb[0] = this.col[i * 4];
      rgb[1] = this.col[i * 4 + 1];
      rgb[2] = this.col[i * 4 + 2];
      fn(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2], rgb);
      this.col[i * 4] = rgb[0];
      this.col[i * 4 + 1] = rgb[1];
      this.col[i * 4 + 2] = rgb[2];
    }
    return this;
  }

  /** Transform vertices added since `fromVertex` in place. */
  transform(fromVertex: number, matrix: THREE.Matrix4): this {
    _nm.getNormalMatrix(matrix);
    for (let i = fromVertex; i < this.vertexCount; i += 1) {
      _v.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]).applyMatrix4(matrix);
      this.pos[i * 3] = _v.x;
      this.pos[i * 3 + 1] = _v.y;
      this.pos[i * 3 + 2] = _v.z;
      _n.set(this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]).applyMatrix3(_nm);
      const len = _n.length();
      if (len > 1e-8) _n.multiplyScalar(1 / len);
      else _n.set(0, 1, 0);
      this.nrm[i * 3] = _n.x;
      this.nrm[i * 3 + 1] = _n.y;
      this.nrm[i * 3 + 2] = _n.z;
    }
    return this;
  }

  /**
   * Append a transformed copy of a template. `tint` multiplies colours, `phase`
   * (0..1) is added to the blink channel of emissive vertices so repeated lamps
   * do not pulse in unison.
   */
  stamp(src: Soup, matrix: THREE.Matrix4, tint: Rgb | null = null, phase = 0): this {
    const base = this.vertexCount;
    _nm.getNormalMatrix(matrix);
    const count = src.vertexCount;
    const tr = tint ? tint[0] : 1;
    const tg = tint ? tint[1] : 1;
    const tb = tint ? tint[2] : 1;
    for (let i = 0; i < count; i += 1) {
      _v.set(src.pos[i * 3], src.pos[i * 3 + 1], src.pos[i * 3 + 2]).applyMatrix4(matrix);
      _n.set(src.nrm[i * 3], src.nrm[i * 3 + 1], src.nrm[i * 3 + 2]).applyMatrix3(_nm);
      const len = _n.length();
      if (len > 1e-8) _n.multiplyScalar(1 / len);
      else _n.set(0, 1, 0);
      this.pos.push(_v.x, _v.y, _v.z);
      this.nrm.push(_n.x, _n.y, _n.z);
      const glow = src.fx[i * 3 + 1];
      // emissive vertices keep their authored hue
      if (glow > 0) this.col.push(src.col[i * 4], src.col[i * 4 + 1], src.col[i * 4 + 2], src.col[i * 4 + 3]);
      else this.col.push(src.col[i * 4] * tr, src.col[i * 4 + 1] * tg, src.col[i * 4 + 2] * tb, src.col[i * 4 + 3]);
      this.uv.push(src.uv[i * 2], src.uv[i * 2 + 1]);
      const blink = src.fx[i * 3 + 2];
      this.fx.push(src.fx[i * 3], glow, blink > 0 ? Math.floor(blink) + Math.min(0.99, phase) : 0);
    }
    for (let i = 0; i < src.idx.length; i += 1) this.idx.push(base + src.idx[i]);
    return this;
  }

  /**
   * Bake into a BufferGeometry. Triangles with non-finite or collapsed corners
   * are dropped and unusable normals replaced, so nothing here can feed a NaN
   * into the HDR chain.
   */
  toGeometry(opts: { uv?: boolean; fx?: boolean; alpha?: boolean; pad?: number } = {}): THREE.BufferGeometry {
    const count = this.vertexCount;
    const position = new Float32Array(this.pos);
    const normal = new Float32Array(this.nrm);
    const finite = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      const x = position[i * 3];
      const y = position[i * 3 + 1];
      const z = position[i * 3 + 2];
      finite[i] = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? 1 : 0;
      if (!finite[i]) position[i * 3] = position[i * 3 + 1] = position[i * 3 + 2] = 0;
      const nx = normal[i * 3];
      const ny = normal[i * 3 + 1];
      const nz = normal[i * 3 + 2];
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 1e-6) || !Number.isFinite(len)) {
        normal[i * 3] = 0;
        normal[i * 3 + 1] = 1;
        normal[i * 3 + 2] = 0;
      } else {
        normal[i * 3] = nx / len;
        normal[i * 3 + 1] = ny / len;
        normal[i * 3 + 2] = nz / len;
      }
    }
    const kept: number[] = [];
    for (let t = 0; t < this.idx.length; t += 3) {
      const i0 = this.idx[t];
      const i1 = this.idx[t + 1];
      const i2 = this.idx[t + 2];
      if (!finite[i0] || !finite[i1] || !finite[i2]) continue;
      _a.set(position[i1 * 3] - position[i0 * 3], position[i1 * 3 + 1] - position[i0 * 3 + 1], position[i1 * 3 + 2] - position[i0 * 3 + 2]);
      _b.set(position[i2 * 3] - position[i0 * 3], position[i2 * 3 + 1] - position[i0 * 3 + 1], position[i2 * 3 + 2] - position[i0 * 3 + 2]);
      _c.crossVectors(_a, _b);
      if (!(_c.lengthSq() > 1e-16)) continue;
      kept.push(i0, i1, i2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    if (opts.alpha) {
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 4));
    } else {
      const rgb = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) {
        rgb[i * 3] = this.col[i * 4];
        rgb[i * 3 + 1] = this.col[i * 4 + 1];
        rgb[i * 3 + 2] = this.col[i * 4 + 2];
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    }
    if (opts.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    if (opts.fx) geometry.setAttribute('aFx', new THREE.BufferAttribute(new Float32Array(this.fx), 3));
    geometry.setIndex(new THREE.BufferAttribute(count > 65535 ? new Uint32Array(kept) : new Uint16Array(kept), 1));
    geometry.computeBoundingSphere();
    if (geometry.boundingSphere) {
      if (!Number.isFinite(geometry.boundingSphere.radius)) geometry.boundingSphere.set(new THREE.Vector3(), 2000);
      geometry.boundingSphere.radius += opts.pad ?? 0;
    }
    return geometry;
  }
}

/** Four world-quadrant soups so merged layers still frustum-cull. */
export class Chunked {
  readonly soups: Soup[] = [new Soup(), new Soup(), new Soup(), new Soup()];

  at(x: number, z: number): Soup {
    return this.soups[(x >= 0 ? 1 : 0) + (z >= 0 ? 2 : 0)];
  }

  get triangleCount(): number {
    return this.soups.reduce((sum, s) => sum + s.triangleCount, 0);
  }
}
