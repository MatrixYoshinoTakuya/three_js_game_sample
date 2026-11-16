import type { HudFrame, MinimapWorld } from '../game/contracts';

const RANGE_M = 220;
const ASH = '233,225,210';
const AMBER = '#ffb347';
const RUST = '#e2552b';
const TEAL = '#5fe3d0';
const TAU = Math.PI * 2;

/** Heading-up circular minimap drawn on a 2D canvas. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D | null;
  private world: MinimapWorld | null = null;
  private size = 0;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d');
  }

  setWorld(world: MinimapWorld): void {
    this.world = world;
  }

  /** Reads layout once; call on construction and on resize only. */
  resize(): void {
    const css = this.canvas.clientWidth;
    if (css <= 0) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(css * this.dpr);
    if (px !== this.size) {
      this.size = px;
      this.canvas.width = px;
      this.canvas.height = px;
    }
  }

  draw(frame: HudFrame, timeMs: number, still: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.size === 0) {
      this.resize();
      if (this.size === 0) return;
    }
    const size = this.size;
    const u = this.dpr;
    const c = size / 2;
    const R = c - 1.5 * u;
    const scale = R / RANGE_M;
    const sin = Math.sin(frame.headingRad);
    const cos = Math.cos(frame.headingRad);
    const px = frame.player.x;
    const pz = frame.player.z;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, TAU);
    ctx.clip();

    ctx.fillStyle = 'rgba(14,10,8,0.66)';
    ctx.fillRect(0, 0, size, size);

    // World -> screen: heading up, +X to the right when facing north (+Z).
    ctx.setTransform(scale * cos, -scale * sin, -scale * sin, -scale * cos, c, c);
    ctx.translate(-px, -pz);

    const world = this.world;
    if (world) {
      const h = world.halfExtent;
      const reach = RANGE_M * 1.05;
      ctx.lineCap = 'butt';
      ctx.strokeStyle = `rgba(${ASH},0.17)`;
      ctx.lineWidth = Math.max(world.roadWidth, (2 * u) / scale);
      ctx.beginPath();
      for (let i = 0; i < world.roadCenters.length; i += 1) {
        const r = world.roadCenters[i];
        if (Math.abs(r - px) < reach) {
          ctx.moveTo(r, Math.max(-h, pz - reach));
          ctx.lineTo(r, Math.min(h, pz + reach));
        }
        if (Math.abs(r - pz) < reach) {
          ctx.moveTo(Math.max(-h, px - reach), r);
          ctx.lineTo(Math.min(h, px + reach), r);
        }
      }
      ctx.stroke();
      // Scribed centre lines.
      ctx.strokeStyle = `rgba(${ASH},0.34)`;
      ctx.lineWidth = u / scale;
      ctx.stroke();

      // Edge of the playable area.
      ctx.strokeStyle = 'rgba(226,85,43,0.75)';
      ctx.lineWidth = (1.5 * u) / scale;
      ctx.setLineDash([(5 * u) / scale, (4 * u) / scale]);
      ctx.strokeRect(-h, -h, h * 2, h * 2);
      ctx.setLineDash([]);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Range ring + view cone.
    ctx.strokeStyle = `rgba(${ASH},0.14)`;
    ctx.lineWidth = u;
    ctx.beginPath();
    ctx.arc(c, c, R * 0.5, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,179,71,0.09)';
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, R, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fill();

    if (world) {
      for (let i = 0; i < world.landmarks.length; i += 1) {
        const lm = world.landmarks[i];
        const dx = lm.x - px;
        const dz = lm.z - pz;
        const sx = c + (dx * cos - dz * sin) * scale;
        const sy = c - (dx * sin + dz * cos) * scale;
        if ((sx - c) * (sx - c) + (sy - c) * (sy - c) > R * R) continue;
        if (lm.kind === 'relay') {
          ctx.strokeStyle = TEAL;
          ctx.lineWidth = 1.5 * u;
          ctx.beginPath();
          ctx.moveTo(sx, sy - 6 * u);
          ctx.lineTo(sx + 4.5 * u, sy + 4 * u);
          ctx.lineTo(sx - 4.5 * u, sy + 4 * u);
          ctx.closePath();
          ctx.stroke();
        } else if (lm.kind === 'highway') {
          ctx.strokeStyle = `rgba(${ASH},0.8)`;
          ctx.lineWidth = 1.5 * u;
          ctx.beginPath();
          ctx.moveTo(sx - 4 * u, sy + 2 * u);
          ctx.lineTo(sx, sy - 3 * u);
          ctx.lineTo(sx + 4 * u, sy + 2 * u);
          ctx.stroke();
        } else {
          ctx.strokeStyle = `rgba(${ASH},0.6)`;
          ctx.lineWidth = u;
          ctx.strokeRect(sx - 3 * u, sy - 3 * u, 6 * u, 6 * u);
        }
      }
    }

    const pulse = still ? 0.5 : (timeMs % 900) / 900;
    let hasObjectiveBlip = false;
    const blips = frame.blips;
    for (let i = 0; i < blips.length; i += 1) {
      const b = blips[i];
      if (b.kind === 'objective') hasObjectiveBlip = true;
      this.blip(ctx, b.kind, b.x - px, b.z - pz, sin, cos, scale, c, R, u, pulse);
    }
    const op = frame.objective.position;
    if (op && !hasObjectiveBlip) {
      this.blip(ctx, 'objective', op.x - px, op.z - pz, sin, cos, scale, c, R, u, pulse);
    }

    // Player arrow.
    ctx.fillStyle = AMBER;
    ctx.strokeStyle = 'rgba(14,10,8,0.9)';
    ctx.lineWidth = 1.5 * u;
    ctx.beginPath();
    ctx.moveTo(c, c - 8 * u);
    ctx.lineTo(c + 5.5 * u, c + 6 * u);
    ctx.lineTo(c, c + 3 * u);
    ctx.lineTo(c - 5.5 * u, c + 6 * u);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();

    ctx.restore();

    // North tab on the rim (outside the clip so it stays crisp).
    const nx = c - sin * (R - 9 * u);
    const ny = c - cos * (R - 9 * u);
    ctx.fillStyle = 'rgba(14,10,8,0.85)';
    ctx.beginPath();
    ctx.arc(nx, ny, 7 * u, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#e9e1d2';
    ctx.font = `700 ${Math.round(9 * u)}px "Bahnschrift","DIN Alternate","Roboto Condensed","Arial Narrow",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 0.5 * u);
  }

  private blip(
    ctx: CanvasRenderingContext2D,
    kind: 'enemy' | 'boss' | 'objective' | 'mortar',
    dx: number,
    dz: number,
    sin: number,
    cos: number,
    scale: number,
    c: number,
    R: number,
    u: number,
    pulse: number,
  ): void {
    let ox = (dx * cos - dz * sin) * scale;
    let oy = -(dx * sin + dz * cos) * scale;
    const d = Math.hypot(ox, oy);
    const rim = R - 7 * u;
    let clamped = false;
    if (d > rim) {
      if (kind === 'enemy' || kind === 'mortar') {
        if (d > R) return;
      } else {
        ox = (ox / d) * rim;
        oy = (oy / d) * rim;
        clamped = true;
      }
    }
    const x = c + ox;
    const y = c + oy;
    if (kind === 'enemy') {
      ctx.fillStyle = RUST;
      ctx.strokeStyle = 'rgba(14,10,8,0.9)';
      ctx.lineWidth = u;
      ctx.beginPath();
      ctx.arc(x, y, 3.4 * u, 0, TAU);
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'boss') {
      const s = 6.5 * u;
      ctx.fillStyle = RUST;
      ctx.strokeStyle = '#ffd9c2';
      ctx.lineWidth = 1.2 * u;
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'objective') {
      ctx.strokeStyle = TEAL;
      ctx.lineWidth = 2 * u;
      ctx.beginPath();
      ctx.arc(x, y, 5 * u, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = TEAL;
      if (clamped) {
        // Pointer nib toward the off-map objective.
        const ax = ox / (Math.hypot(ox, oy) || 1);
        const ay = oy / (Math.hypot(ox, oy) || 1);
        ctx.beginPath();
        ctx.moveTo(x + ax * 9.5 * u, y + ay * 9.5 * u);
        ctx.lineTo(x + ax * 5 * u - ay * 3.5 * u, y + ay * 5 * u + ax * 3.5 * u);
        ctx.lineTo(x + ax * 5 * u + ay * 3.5 * u, y + ay * 5 * u - ax * 3.5 * u);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 1.6 * u, 0, TAU);
        ctx.fill();
      }
    } else {
      ctx.strokeStyle = `rgba(255,140,50,${(1 - pulse * 0.75).toFixed(2)})`;
      ctx.lineWidth = 1.6 * u;
      ctx.beginPath();
      ctx.arc(x, y, (3.5 + pulse * 6) * u, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = '#ff8c32';
      ctx.beginPath();
      ctx.arc(x, y, 1.5 * u, 0, TAU);
      ctx.fill();
    }
  }
}
