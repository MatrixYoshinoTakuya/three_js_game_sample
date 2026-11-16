import * as THREE from 'three';
import { createSeededRandom } from '../../utils/random';

/**
 * The four canvas/data textures shared by the whole dressing kit:
 * a signage atlas (road signs + neon masks), a ground-decal atlas, an
 * alpha-tested card atlas (weeds, twigs, cloth, wire) and a tiling noise.
 */

export type Rect = readonly [number, number, number, number];

const JP = '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", "IPAGothic", sans-serif';
const EN = '"Arial Narrow", "Helvetica Neue", Arial, sans-serif';

/** Pixel rect → uv rect [u0, v0, u1, v1] for a flipY canvas texture, inset to avoid bleeding. */
function uvRect(x: number, y: number, w: number, h: number, W: number, H: number, inset = 1.5): Rect {
  return [(x + inset) / W, 1 - (y + h - inset) / H, (x + w - inset) / W, 1 - (y + inset) / H];
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [canvas, ctx];
}

function finish(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.anisotropy = 4;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

/** Stylised raider "rust fang" tooth mark. */
function drawFang(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size / 100, size / 100);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  // main fang
  ctx.beginPath();
  ctx.moveTo(-26, -58);
  ctx.lineTo(-10, -46);
  ctx.lineTo(2, -60);
  ctx.lineTo(12, -44);
  ctx.lineTo(28, -56);
  ctx.quadraticCurveTo(26, 10, -4, 82);
  ctx.quadraticCurveTo(-14, 10, -26, -58);
  ctx.fill();
  // flanking teeth
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 36, -52);
    ctx.lineTo(side * 58, -44);
    ctx.quadraticCurveTo(side * 54, -6, side * 42, 22);
    ctx.quadraticCurveTo(side * 36, -10, side * 36, -52);
    ctx.fill();
  }
  // jaw arc and slash
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.arc(0, -40, 74, Math.PI * 1.13, Math.PI * 1.87);
  ctx.stroke();
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(-70, 40);
  ctx.lineTo(-38, 62);
  ctx.moveTo(70, 40);
  ctx.lineTo(40, 60);
  ctx.stroke();
  ctx.restore();
}

/** Dirt, rust runs and chips painted only where the cell already has paint. */
function weather(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rng: () => number, amount: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.globalCompositeOperation = 'source-atop';
  const runs = Math.floor((w * h) / 900 * amount);
  for (let n = 0; n < runs; n += 1) {
    ctx.fillStyle = `rgba(${40 + rng() * 50},${22 + rng() * 26},${10 + rng() * 14},${0.1 + rng() * 0.28})`;
    const rw = 1.5 + rng() * 7;
    ctx.fillRect(x + rng() * w, y + rng() * h * 0.8, rw, 12 + rng() * h * 0.6);
  }
  for (let n = 0; n < runs * 0.5; n += 1) {
    ctx.fillStyle = `rgba(14,11,9,${0.35 + rng() * 0.5})`;
    ctx.beginPath();
    ctx.ellipse(x + rng() * w, y + rng() * h, 2 + rng() * w * 0.05, 2 + rng() * h * 0.06, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // sun-bleach wash
  ctx.fillStyle = `rgba(190,170,140,${0.12 * amount})`;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// ------------------------------------------------------------------ signage

export const SIGN = {
  gantry: [] as Rect[],
  small: [] as Rect[],
  blade: [] as Rect[],
  neonV: [] as Rect[],
  neonH: [] as Rect[],
};

export function createSignAtlas(): THREE.CanvasTexture {
  const W = 1024;
  const H = 1024;
  const [canvas, ctx] = makeCanvas(W, H);
  const rng = createSeededRandom(9107);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // ---- gantry panels 512x160
  const gantry: [string, string, string, string, string][] = [
    ['#0f4a34', '#e8e6da', '避難経路 →', 'EVAC ROUTE', '7'],
    ['#12356a', '#e8e6da', '第7区 中継塔 ↑', 'SECTOR 7 · RELAY TOWER', 'R'],
    ['#b88a12', '#16130f', '通行止', 'ROAD CLOSED AHEAD', '!'],
    ['#0f4a34', '#e8e6da', '灰都高速 入口', 'KAITO EXPWY · 600m', '5'],
  ];
  SIGN.gantry.length = 0;
  gantry.forEach(([bg, fg, jp, en, badge], i) => {
    const x = (i % 2) * 512;
    const y = Math.floor(i / 2) * 160;
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, 512, 160);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 5;
    ctx.strokeRect(x + 9, y + 9, 494, 142);
    ctx.fillStyle = fg;
    ctx.font = `900 58px ${JP}`;
    ctx.fillText(jp, x + 290, y + 62, 400);
    ctx.font = `700 26px ${EN}`;
    ctx.fillText(en, x + 290, y + 122, 400);
    // route badge
    ctx.beginPath();
    ctx.arc(x + 56, y + 80, 32, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = bg;
    ctx.font = `900 40px ${EN}`;
    ctx.fillText(badge, x + 56, y + 83);
    weather(ctx, x, y, 512, 160, rng, 1);
    SIGN.gantry.push(uvRect(x, y, 512, 160, W, H));
  });

  // ---- small signs 128x128 at y = 320
  SIGN.small.length = 0;
  for (let i = 0; i < 8; i += 1) {
    const x = i * 128;
    const y = 320;
    const cx = x + 64;
    const cy = y + 64;
    ctx.save();
    if (i === 0) {
      // 止まれ: inverted red triangle
      ctx.fillStyle = '#e9e4d8';
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 10);
      ctx.lineTo(x + 124, y + 10);
      ctx.lineTo(cx, y + 122);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#a81d16';
      ctx.beginPath();
      ctx.moveTo(x + 14, y + 16);
      ctx.lineTo(x + 114, y + 16);
      ctx.lineTo(cx, y + 110);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#efe9dc';
      ctx.font = `900 30px ${JP}`;
      ctx.fillText('止まれ', cx, y + 46, 84);
    } else if (i === 1) {
      // no entry
      ctx.fillStyle = '#a81d16';
      ctx.beginPath();
      ctx.arc(cx, cy, 58, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#efe9dc';
      ctx.fillRect(x + 22, y + 52, 84, 24);
    } else if (i === 2 || i === 3) {
      // speed limit / closed ring
      ctx.fillStyle = '#a81d16';
      ctx.beginPath();
      ctx.arc(cx, cy, 58, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = i === 2 ? '#efe9dc' : '#1d3f8a';
      ctx.beginPath();
      ctx.arc(cx, cy, 43, 0, Math.PI * 2);
      ctx.fill();
      if (i === 2) {
        ctx.fillStyle = '#1b2f6e';
        ctx.font = `900 56px ${EN}`;
        ctx.fillText('40', cx, cy + 3);
      } else {
        ctx.strokeStyle = '#a81d16';
        ctx.lineWidth = 13;
        ctx.beginPath();
        ctx.moveTo(x + 30, y + 30);
        ctx.lineTo(x + 98, y + 98);
        ctx.moveTo(x + 98, y + 30);
        ctx.lineTo(x + 30, y + 98);
        ctx.stroke();
      }
    } else if (i === 4) {
      // mandatory direction
      ctx.fillStyle = '#1d3f8a';
      ctx.beginPath();
      ctx.arc(cx, cy, 58, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#efe9dc';
      ctx.fillRect(cx - 9, y + 44, 18, 60);
      ctx.beginPath();
      ctx.moveTo(cx, y + 16);
      ctx.lineTo(cx + 30, y + 54);
      ctx.lineTo(cx - 30, y + 54);
      ctx.closePath();
      ctx.fill();
    } else if (i === 5) {
      // yellow warning diamond
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#14110d';
      ctx.fillRect(-44, -44, 88, 88);
      ctx.fillStyle = '#d9a514';
      ctx.fillRect(-39, -39, 78, 78);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = '#14110d';
      ctx.font = `900 62px ${EN}`;
      ctx.fillText('!', 0, 4);
    } else if (i === 6) {
      // bus stop roundel
      ctx.fillStyle = '#e9e4d8';
      ctx.beginPath();
      ctx.arc(cx, cy, 58, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1d5a8a';
      ctx.beginPath();
      ctx.arc(cx, cy, 50, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#efe9dc';
      ctx.font = `900 34px ${JP}`;
      ctx.fillText('バス', cx, cy - 12);
      ctx.font = `700 17px ${EN}`;
      ctx.fillText('BUS STOP', cx, cy + 22);
    } else {
      // shelter square
      ctx.fillStyle = '#e9e4d8';
      ctx.fillRect(x + 6, y + 6, 116, 116);
      ctx.fillStyle = '#0f5a3a';
      ctx.fillRect(x + 11, y + 11, 106, 106);
      ctx.fillStyle = '#efe9dc';
      ctx.font = `900 34px ${JP}`;
      ctx.fillText('避難所', cx, cy - 14, 96);
      ctx.font = `700 18px ${EN}`;
      ctx.fillText('SHELTER', cx, cy + 26);
    }
    ctx.restore();
    weather(ctx, x, y, 128, 128, rng, 0.8);
    SIGN.small.push(uvRect(x, y, 128, 128, W, H));
  }

  // ---- blades 256x64 at y = 448
  const blades: [string, string, string, string][] = [
    ['#12356a', '#e8e6da', '第7区', 'SECTOR 7'],
    ['#0f4a34', '#e8e6da', '中央通り', 'Chuo-dori'],
    ['#0f5a3a', '#e8e6da', '避難所 →', 'SHELTER'],
    ['#c79a14', '#16130f', '立入禁止', 'KEEP OUT'],
  ];
  SIGN.blade.length = 0;
  blades.forEach(([bg, fg, jp, en], i) => {
    const x = i * 256;
    const y = 448;
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, 256, 64);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 5, y + 5, 246, 54);
    ctx.fillStyle = fg;
    ctx.font = `900 34px ${JP}`;
    ctx.fillText(jp, x + 88, y + 34, 150);
    ctx.font = `700 18px ${EN}`;
    ctx.fillText(en, x + 200, y + 35, 92);
    weather(ctx, x, y, 256, 64, rng, 0.9);
    SIGN.blade.push(uvRect(x, y, 256, 64, W, H));
  });

  // ---- neon masks (white tubes on black)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 512, W, 512);
  const tube = (draw: () => void) => {
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 7;
    draw();
    ctx.shadowBlur = 0;
    draw();
  };
  const vertical = ['酒場', '薬', '修理', 'ラーメン', 'ホテル', '質', '麻雀', 'カラオケ', '電器', '食堂', '充電', 'BAR'];
  SIGN.neonV.length = 0;
  vertical.forEach((text, i) => {
    const x = i * 85;
    const y = 512;
    const chars = [...text];
    const size = Math.min(58, 250 / chars.length);
    ctx.strokeStyle = '#9a9a9a';
    ctx.lineWidth = 3;
    tube(() => ctx.strokeRect(x + 7, y + 8, 66, 272));
    ctx.fillStyle = '#ffffff';
    ctx.font = `900 ${size}px ${JP}`;
    const step = Math.min(size * 1.12, 250 / chars.length);
    const top = y + 144 - (step * (chars.length - 1)) / 2;
    chars.forEach((ch, n) => {
      tube(() => {
        if (ch === 'ー') {
          ctx.fillRect(x + 36, top + n * step - size * 0.36, size * 0.13, size * 0.72);
        } else {
          ctx.fillText(ch, x + 40, top + n * step + 2);
        }
      });
    });
    SIGN.neonV.push(uvRect(x, y, 80, 288, W, H, 1));
  });
  const horizontal = ['HOTEL', '居酒屋', '修理 REPAIR', 'OPEN 24H', '薬局', 'PARTS', '銭湯', 'NOODLE', '第七酒場', 'GARAGE', 'カプセル', 'RELAY BAR'];
  SIGN.neonH.length = 0;
  horizontal.forEach((text, i) => {
    const x = (i % 4) * 256;
    const y = 808 + Math.floor(i / 4) * 72;
    ctx.strokeStyle = '#9a9a9a';
    ctx.lineWidth = 3;
    tube(() => ctx.strokeRect(x + 8, y + 7, 240, 58));
    ctx.fillStyle = '#ffffff';
    ctx.font = `900 40px ${JP}`;
    tube(() => ctx.fillText(text, x + 128, y + 38, 216));
    SIGN.neonH.push(uvRect(x, y, 256, 72, W, H, 1));
  });

  return finish(canvas, true);
}

// ------------------------------------------------------------------ ground decals

export const DECAL = {
  oilA: 0, oilB: 1, skidArc: 2, skidStraight: 3, scorchA: 4, scorchB: 5, fang: 6, chalk: 7,
  paper: 8, apron: 9, crack: 10, manhole: 11, shadow: 12, stop: 13, hazard: 14, glass: 15,
} as const;

export function decalRect(cell: number): Rect {
  return uvRect((cell % 4) * 256, Math.floor(cell / 4) * 256, 256, 256, 1024, 1024, 2);
}

export function createDecalAtlas(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(1024, 1024);
  const rng = createSeededRandom(5521);
  const cell = (index: number, draw: (r: () => number) => void) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect((index % 4) * 256 + 2, Math.floor(index / 4) * 256 + 2, 252, 252);
    ctx.clip();
    ctx.translate((index % 4) * 256 + 128, Math.floor(index / 4) * 256 + 128);
    draw(rng);
    ctx.restore();
  };
  const blob = (x: number, y: number, r: number, rgb: string, alpha: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${alpha})`);
    g.addColorStop(0.6, `rgba(${rgb},${alpha * 0.7})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // 0 oil stain: multi-lobed dark pool
  cell(0, (r) => {
    for (let n = 0; n < 16; n += 1) {
      const a = r() * 6.28;
      const d = r() * 52;
      blob(Math.cos(a) * d, Math.sin(a) * d * 0.8, 26 + r() * 40, '8,6,5', 0.75);
    }
    for (let n = 0; n < 26; n += 1) {
      const a = r() * 6.28;
      const d = 60 + r() * 50;
      blob(Math.cos(a) * d, Math.sin(a) * d, 3 + r() * 8, '8,6,5', 0.7);
    }
  });
  // 1 oil drip trail
  cell(1, (r) => {
    let x = -100;
    let y = (r() - 0.5) * 30;
    while (x < 100) {
      blob(x, y, 7 + r() * 16, '9,7,6', 0.7);
      x += 6 + r() * 16;
      y += (r() - 0.5) * 14;
    }
    blob(60, y, 44, '8,6,5', 0.7);
  });
  // 2 skid arc, 3 straight skid
  for (const index of [2, 3]) {
    cell(index, (r) => {
      ctx.lineCap = 'round';
      for (const off of [-17, 17]) {
        for (let pass = 0; pass < 5; pass += 1) {
          ctx.strokeStyle = `rgba(6,6,6,${0.16 + r() * 0.16})`;
          ctx.lineWidth = 9 + r() * 5;
          ctx.setLineDash([30 + r() * 80, 4 + r() * 16]);
          ctx.beginPath();
          if (index === 2) {
            ctx.arc(-120, 300, 330 + off + (r() - 0.5) * 3, -1.4, -0.52);
          } else {
            ctx.moveTo(off + (r() - 0.5) * 3, -118);
            ctx.bezierCurveTo(off + 6, -40, off - 8, 40, off + (r() - 0.5) * 8, 118);
          }
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      // fade the ends
      ctx.globalCompositeOperation = 'destination-out';
      const g = ctx.createLinearGradient(0, -128, 0, 128);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.25, 'rgba(0,0,0,0)');
      g.addColorStop(0.8, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = g;
      ctx.fillRect(-128, -128, 256, 256);
    });
  }
  // 4 scorch blast with rays, 5 burn patch
  cell(4, (r) => {
    ctx.lineCap = 'round';
    for (let n = 0; n < 46; n += 1) {
      const a = r() * 6.28;
      const len = 50 + r() * 68;
      ctx.strokeStyle = `rgba(4,3,3,${0.14 + r() * 0.2})`;
      ctx.lineWidth = 3 + r() * 12;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 14, Math.sin(a) * 14);
      ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
      ctx.stroke();
    }
    blob(0, 0, 86, '3,3,3', 0.9);
    blob(0, 0, 34, '70,62,54', 0.5);
  });
  cell(5, (r) => {
    for (let n = 0; n < 12; n += 1) blob((r() - 0.5) * 90, (r() - 0.5) * 90, 30 + r() * 44, '4,3,3', 0.62);
    for (let n = 0; n < 40; n += 1) blob((r() - 0.5) * 200, (r() - 0.5) * 200, 2 + r() * 6, '50,24,10', 0.6);
  });
  // 6 rust fang glyph (sprayed)
  cell(6, (r) => {
    ctx.globalAlpha = 0.86;
    drawFang(ctx, 0, -8, 118, '#8a2a12');
    ctx.globalAlpha = 1;
    // drips and overspray
    for (let n = 0; n < 10; n += 1) {
      ctx.fillStyle = 'rgba(138,42,18,0.75)';
      ctx.fillRect((r() - 0.5) * 120, 30 + r() * 30, 3 + r() * 3, 20 + r() * 50);
    }
    ctx.globalCompositeOperation = 'destination-out';
    for (let n = 0; n < 240; n += 1) blob((r() - 0.5) * 250, (r() - 0.5) * 250, 2 + r() * 7, '0,0,0', 0.55);
  });
  // 7 chalk evacuation arrow
  cell(7, (r) => {
    ctx.strokeStyle = 'rgba(225,220,205,0.85)';
    ctx.fillStyle = 'rgba(225,220,205,0.85)';
    ctx.lineWidth = 13;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 112);
    ctx.lineTo(0, -40);
    ctx.moveTo(-46, -30);
    ctx.lineTo(0, -106);
    ctx.lineTo(46, -30);
    ctx.stroke();
    ctx.font = `900 44px ${JP}`;
    ctx.textAlign = 'center';
    ctx.fillText('避', -72, 60);
    ctx.fillText('難', 72, 60);
    ctx.globalCompositeOperation = 'destination-out';
    for (let n = 0; n < 700; n += 1) blob((r() - 0.5) * 250, (r() - 0.5) * 250, 1 + r() * 5, '0,0,0', 0.6);
  });
  // 8 scattered paper
  cell(8, (r) => {
    for (let n = 0; n < 15; n += 1) {
      ctx.save();
      ctx.translate((r() - 0.5) * 200, (r() - 0.5) * 200);
      ctx.rotate(r() * 6.28);
      const tone = 150 + r() * 70;
      ctx.fillStyle = `rgb(${tone},${tone * 0.95},${tone * 0.84})`;
      const w = 16 + r() * 16;
      ctx.fillRect(-w / 2, -w * 0.7, w, w * 1.4);
      ctx.fillStyle = 'rgba(40,36,30,0.55)';
      for (let l = 0; l < 4; l += 1) ctx.fillRect(-w / 2 + 3, -w * 0.5 + l * 5, w - 6 - r() * 6, 1.5);
      ctx.restore();
    }
  });
  // 9 rubble / dust apron (dense at the bottom edge = against the wall)
  cell(9, (r) => {
    const g = ctx.createLinearGradient(0, 128, 0, -100);
    g.addColorStop(0, 'rgba(120,108,92,0.85)');
    g.addColorStop(0.45, 'rgba(110,98,84,0.45)');
    g.addColorStop(1, 'rgba(110,98,84,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-128, -128, 256, 256);
    for (let n = 0; n < 420; n += 1) {
      const y = 128 - Math.pow(r(), 1.7) * 230;
      const tone = 50 + r() * 120;
      ctx.fillStyle = `rgba(${tone},${tone * 0.93},${tone * 0.82},${0.5 + r() * 0.5})`;
      const s = 1.5 + r() * 6 * (1 - (128 - y) / 300);
      ctx.save();
      ctx.translate((r() - 0.5) * 256, y);
      ctx.rotate(r() * 3);
      ctx.fillRect(-s / 2, -s / 2, s, s * (0.6 + r() * 0.8));
      ctx.restore();
    }
    // soft side edges
    ctx.globalCompositeOperation = 'destination-out';
    const e = ctx.createLinearGradient(-128, 0, 128, 0);
    e.addColorStop(0, 'rgba(0,0,0,1)');
    e.addColorStop(0.18, 'rgba(0,0,0,0)');
    e.addColorStop(0.82, 'rgba(0,0,0,0)');
    e.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = e;
    ctx.fillRect(-128, -128, 256, 256);
  });
  // 10 crack burst / pothole
  cell(10, (r) => {
    blob(0, 0, 44, '8,7,6', 0.85);
    ctx.lineCap = 'round';
    const crack = (x: number, y: number, a: number, len: number, w: number) => {
      if (len < 10 || w < 0.6) return;
      const nx = x + Math.cos(a) * len;
      const ny = y + Math.sin(a) * len;
      ctx.strokeStyle = 'rgba(6,5,5,0.9)';
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      crack(nx, ny, a + (r() - 0.5) * 0.9, len * 0.78, w * 0.75);
      if (r() < 0.55) crack(nx, ny, a + (r() < 0.5 ? 1 : -1) * (0.5 + r() * 0.6), len * 0.6, w * 0.6);
    };
    for (let n = 0; n < 7; n += 1) crack(0, 0, (n / 7) * 6.28 + r() * 0.5, 30 + r() * 16, 4.5);
  });
  // 11 manhole cover
  cell(11, () => {
    ctx.fillStyle = 'rgba(20,18,16,1)';
    ctx.beginPath();
    ctx.arc(0, 0, 118, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(58,50,42,1)';
    ctx.beginPath();
    ctx.arc(0, 0, 106, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(24,21,18,1)';
    ctx.lineWidth = 6;
    for (const rr of [30, 56, 82]) {
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let n = 0; n < 16; n += 1) {
      const a = (n / 16) * 6.28;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 30, Math.sin(a) * 30);
      ctx.lineTo(Math.cos(a) * 104, Math.sin(a) * 104);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(12,11,10,1)';
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fill();
  });
  // 12 contact shadow blob
  cell(12, () => {
    const g = ctx.createRadialGradient(0, 0, 10, 0, 0, 122);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.5)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-128, -128, 256, 256);
  });
  // 13 worn road paint 止まれ
  cell(13, (r) => {
    ctx.fillStyle = 'rgba(205,200,186,0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 76px ${JP}`;
    ['止', 'ま', 'れ'].forEach((ch, n) => ctx.fillText(ch, 0, -80 + n * 80));
    ctx.globalCompositeOperation = 'destination-out';
    for (let n = 0; n < 520; n += 1) blob((r() - 0.5) * 250, (r() - 0.5) * 250, 1 + r() * 7, '0,0,0', 0.65);
  });
  // 14 hazard chevrons
  cell(14, (r) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-116, -60, 232, 120);
    ctx.clip();
    ctx.fillStyle = 'rgba(190,140,20,0.9)';
    ctx.fillRect(-128, -128, 256, 256);
    ctx.fillStyle = 'rgba(14,12,10,0.92)';
    for (let n = -6; n < 7; n += 1) {
      ctx.beginPath();
      ctx.moveTo(n * 44, -60);
      ctx.lineTo(n * 44 + 22, -60);
      ctx.lineTo(n * 44 + 82, 60);
      ctx.lineTo(n * 44 + 60, 60);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'destination-out';
    for (let n = 0; n < 420; n += 1) blob((r() - 0.5) * 250, (r() - 0.5) * 140, 1 + r() * 8, '0,0,0', 0.6);
  });
  // 15 glass and grit
  cell(15, (r) => {
    for (let n = 0; n < 240; n += 1) {
      const a = r() * 6.28;
      const d = Math.pow(r(), 0.7) * 118;
      const light = r() < 0.6;
      ctx.fillStyle = light ? `rgba(${170 + r() * 60},${200 + r() * 40},${200 + r() * 40},${0.6 + r() * 0.4})` : `rgba(20,18,16,${0.5 + r() * 0.4})`;
      ctx.save();
      ctx.translate(Math.cos(a) * d, Math.sin(a) * d);
      ctx.rotate(r() * 6.28);
      ctx.beginPath();
      const s = 1.5 + r() * 5;
      ctx.moveTo(-s, -s * 0.4);
      ctx.lineTo(s, 0);
      ctx.lineTo(-s * 0.3, s);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  });

  return finish(canvas, true);
}

// ------------------------------------------------------------------ alpha cards

const CW = 1024;
const CH = 512;
export const CARD = {
  grass: [0, 1, 2, 3].map((i) => uvRect(i * 128, 0, 128, 128, CW, CH, 2)),
  scrub: [4, 5].map((i) => uvRect(i * 128, 0, 128, 128, CW, CH, 2)),
  twig: [6, 7].map((i) => uvRect(i * 128, 0, 128, 128, CW, CH, 2)),
  wire: uvRect(0, 128, 256, 128, CW, CH, 2),
  glass: uvRect(256, 128, 128, 128, CW, CH, 2),
  solid: uvRect(392, 136, 48, 48, CW, CH, 4),
  rag: [0, 1, 2, 3].map((i) => uvRect(448 + i * 64, 128, 64, 128, CW, CH, 2)),
  poster: uvRect(704, 128, 128, 128, CW, CH, 2),
  fence: uvRect(832, 128, 192, 128, CW, CH, 2),
  tarp: [uvRect(0, 256, 256, 256, CW, CH, 2), uvRect(256, 256, 256, 256, CW, CH, 2)],
  banner: uvRect(512, 256, 256, 256, CW, CH, 2),
  ivy: uvRect(768, 256, 256, 256, CW, CH, 2),
};

export function createCardAtlas(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(CW, CH);
  const rng = createSeededRandom(31337);
  const cell = (x: number, y: number, w: number, h: number, draw: (w: number, h: number) => void) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, w - 4, h - 4);
    ctx.clip();
    ctx.translate(x, y);
    draw(w, h);
    ctx.restore();
  };
  ctx.lineCap = 'round';

  // dry grass tufts
  for (let i = 0; i < 4; i += 1) {
    cell(i * 128, 0, 128, 128, (w, h) => {
      const blades = 26 + i * 8;
      for (let n = 0; n < blades; n += 1) {
        const bx = w / 2 + (rng() - 0.5) * (30 + i * 12);
        const lean = (rng() - 0.5) * (70 + i * 14);
        const height = (0.45 + rng() * 0.5) * (h - 10) * (i === 3 ? 0.7 : 1);
        const tone = rng();
        ctx.strokeStyle = `rgb(${150 + tone * 75},${120 + tone * 62},${58 + tone * 40})`;
        ctx.lineWidth = 2.2 + rng() * 2.4;
        ctx.beginPath();
        ctx.moveTo(bx, h - 3);
        ctx.quadraticCurveTo(bx + lean * 0.2, h - height * 0.6, bx + lean, h - height);
        ctx.stroke();
        if (i >= 2 && rng() < 0.4) {
          // seed head
          ctx.fillStyle = 'rgb(205,180,120)';
          ctx.beginPath();
          ctx.ellipse(bx + lean, h - height, 2.5, 6, lean * 0.01, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }
  // bare scrub and twig sprays
  const twig = (x: number, y: number, a: number, len: number, w: number, tone: number) => {
    if (len < 5) return;
    const nx = x + Math.cos(a) * len;
    const ny = y + Math.sin(a) * len;
    ctx.strokeStyle = `rgb(${tone},${tone * 0.86},${tone * 0.72})`;
    ctx.lineWidth = Math.max(1.3, w);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(nx, ny);
    ctx.stroke();
    const kids = rng() < 0.75 ? 2 : 3;
    for (let k = 0; k < kids; k += 1) twig(nx, ny, a + (rng() - 0.5) * 1.3, len * (0.62 + rng() * 0.2), w * 0.68, tone);
  };
  for (let i = 0; i < 2; i += 1) {
    cell((4 + i) * 128, 0, 128, 128, (w, h) => {
      for (let n = 0; n < 5 + i; n += 1) twig(w / 2 + (rng() - 0.5) * 16, h - 3, -Math.PI / 2 + (rng() - 0.5) * 1.5, 26 + rng() * 10, 3.6, 66 + rng() * 30);
    });
    cell((6 + i) * 128, 0, 128, 128, (w, h) => {
      for (let n = 0; n < 4; n += 1) twig(w / 2 + (rng() - 0.5) * 8, h - 3, -Math.PI / 2 + (rng() - 0.5) * 1.1, 30 + rng() * 8, 3.2, 34 + rng() * 22);
    });
  }
  // concertina wire
  cell(0, 128, 256, 128, (w, h) => {
    for (let n = 0; n < 15; n += 1) {
      const cx = 8 + (n / 14) * (w - 16);
      ctx.strokeStyle = n % 2 === 0 ? 'rgb(120,116,110)' : 'rgb(62,58,54)';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.ellipse(cx, h / 2 + 6, 21, h / 2 - 12, 0.12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgb(150,146,138)';
      for (let b = 0; b < 9; b += 1) {
        const a = (b / 9) * 6.28 + n;
        ctx.fillRect(cx + Math.cos(a) * 21 - 2.5, h / 2 + 6 + Math.sin(a) * (h / 2 - 12) - 1.2, 5, 2.4);
      }
    }
  });
  // shattered glass left in a frame
  cell(256, 128, 128, 128, (w, h) => {
    const shard = (pts: number[]) => {
      const tone = rng();
      ctx.fillStyle = `rgb(${120 + tone * 60},${150 + tone * 60},${150 + tone * 55})`;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let n = 2; n < pts.length; n += 2) ctx.lineTo(pts[n], pts[n + 1]);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgb(215,230,228)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    };
    for (let n = 0; n < 7; n += 1) {
      const x = (n / 7) * w;
      shard([x, h, x + w / 7 + 4, h, x + (rng() * w) / 7, h - 18 - rng() * 64]);
    }
    shard([0, 0, 46, 0, 0, 58]);
    shard([w, 0, w - 38, 0, w, 44]);
    shard([0, h, 0, h - 70, 30, h]);
    shard([w, h - 20, w, h - 96, w - 26, h - 30]);
  });
  // solid patch (lines, ribbons)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(386, 130, 60, 60);
  // rag flags (white base, tinted per vertex)
  for (let i = 0; i < 4; i += 1) {
    cell(448 + i * 64, 128, 64, 128, (w, h) => {
      const len = h * (0.55 + rng() * 0.4);
      ctx.fillStyle = `rgb(${200 + rng() * 40},${200 + rng() * 40},${195 + rng() * 40})`;
      ctx.beginPath();
      ctx.moveTo(6, 2);
      ctx.lineTo(w - 6, 2);
      let x = w - 6;
      ctx.lineTo(x, len * (0.8 + rng() * 0.2));
      while (x > 8) {
        x -= 5 + rng() * 9;
        ctx.lineTo(Math.max(6, x), len * (0.72 + rng() * 0.34));
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(60,50,40,0.25)';
      for (let n = 0; n < 5; n += 1) ctx.fillRect(6 + rng() * (w - 16), 4, 3 + rng() * 5, len);
    });
  }
  // torn poster
  cell(704, 128, 128, 128, (w, h) => {
    ctx.fillStyle = 'rgb(196,184,158)';
    ctx.fillRect(8, 6, w - 16, h - 14);
    ctx.fillStyle = 'rgb(120,30,20)';
    ctx.fillRect(14, 12, w - 28, 26);
    ctx.fillStyle = 'rgb(232,224,200)';
    ctx.font = `900 20px ${JP}`;
    ctx.textAlign = 'center';
    ctx.fillText('避難命令', w / 2, 32, w - 32);
    ctx.fillStyle = 'rgb(46,42,36)';
    for (let n = 0; n < 7; n += 1) ctx.fillRect(16, 48 + n * 9, w - 32 - rng() * 30, 3);
    ctx.globalCompositeOperation = 'destination-out';
    for (let n = 0; n < 7; n += 1) {
      ctx.beginPath();
      ctx.ellipse(rng() < 0.5 ? rng() * 26 : w - rng() * 26, rng() * h, 8 + rng() * 14, 8 + rng() * 18, rng() * 3, 0, 6.3);
      ctx.fill();
    }
  });
  // chain-link fence panel
  cell(832, 128, 192, 128, (w, h) => {
    ctx.strokeStyle = 'rgb(96,92,86)';
    ctx.lineWidth = 1.6;
    for (let n = -h; n < w + h; n += 11) {
      ctx.beginPath();
      ctx.moveTo(n, 4);
      ctx.lineTo(n + h, h - 4);
      ctx.moveTo(n + h, 4);
      ctx.lineTo(n, h - 4);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgb(70,64,58)';
    ctx.lineWidth = 5;
    ctx.strokeRect(4, 5, w - 8, h - 9);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.ellipse(w * 0.62, h * 0.7, 30, 40, 0.4, 0, 6.3);
    ctx.fill();
  });
  // torn tarps (white base, folds, holes)
  for (let i = 0; i < 2; i += 1) {
    cell(i * 256, 256, 256, 256, (w, h) => {
      ctx.fillStyle = 'rgb(214,212,206)';
      ctx.beginPath();
      ctx.moveTo(4, 4);
      ctx.lineTo(w - 4, 4);
      let x = w - 4;
      ctx.lineTo(x, h * (0.7 + rng() * 0.25));
      while (x > 10) {
        x -= 10 + rng() * 26;
        ctx.lineTo(Math.max(4, x), h * (0.62 + rng() * 0.36));
      }
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-atop';
      for (let n = 0; n < 22; n += 1) {
        const fx = rng() * w;
        const g = ctx.createLinearGradient(fx - 12, 0, fx + 12, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(0.5, `rgba(0,0,0,${0.1 + rng() * 0.18})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(fx - 12, 0, 24, h);
      }
      for (let n = 0; n < 60; n += 1) {
        ctx.fillStyle = `rgba(70,52,34,${0.08 + rng() * 0.2})`;
        ctx.fillRect(rng() * w, rng() * h, 3 + rng() * 9, 20 + rng() * 90);
      }
      ctx.globalCompositeOperation = 'destination-out';
      for (let n = 0; n < 4 + i * 3; n += 1) {
        ctx.beginPath();
        ctx.ellipse(20 + rng() * (w - 40), 40 + rng() * (h - 60), 8 + rng() * 22, 14 + rng() * 40, rng() * 3, 0, 6.3);
        ctx.fill();
      }
    });
  }
  // raider banner
  cell(512, 256, 256, 256, (w, h) => {
    ctx.fillStyle = 'rgb(46,22,16)';
    ctx.beginPath();
    ctx.moveTo(6, 4);
    ctx.lineTo(w - 6, 4);
    let x = w - 6;
    ctx.lineTo(x, h * 0.86);
    while (x > 12) {
      x -= 14 + rng() * 20;
      ctx.lineTo(Math.max(6, x), h * (0.74 + rng() * 0.24));
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-atop';
    drawFang(ctx, w / 2, h * 0.42, 120, 'rgb(214,196,160)');
    for (let n = 0; n < 50; n += 1) {
      ctx.fillStyle = `rgba(10,8,6,${0.1 + rng() * 0.25})`;
      ctx.fillRect(rng() * w, rng() * h, 3 + rng() * 10, 20 + rng() * 80);
    }
  });
  // dead creeper
  cell(768, 256, 256, 256, (w, h) => {
    const vine = (x: number, y: number, a: number, len: number, width: number) => {
      if (len < 7 || y < 6) return;
      const nx = x + Math.cos(a) * len;
      const ny = y + Math.sin(a) * len;
      ctx.strokeStyle = 'rgb(52,40,28)';
      ctx.lineWidth = Math.max(1.4, width);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      if (rng() < 0.8) {
        ctx.fillStyle = `rgb(${92 + rng() * 50},${66 + rng() * 34},${30 + rng() * 16})`;
        ctx.beginPath();
        ctx.ellipse(nx + (rng() - 0.5) * 8, ny + (rng() - 0.5) * 8, 3.5, 5.5, rng() * 3, 0, 6.3);
        ctx.fill();
      }
      vine(nx, ny, a + (rng() - 0.5) * 0.9, len * 0.93, width * 0.9);
      if (rng() < 0.3) vine(nx, ny, a + (rng() < 0.5 ? 0.9 : -0.9), len * 0.75, width * 0.7);
    };
    for (let n = 0; n < 6; n += 1) vine(20 + rng() * (w - 40), h - 3, -Math.PI / 2 + (rng() - 0.5) * 0.5, 22, 3.4);
  });

  const texture = finish(canvas, true);
  return texture;
}

// ------------------------------------------------------------------ tiling noise

/** 256² tiling fbm in R and G (different lattices), plain value noise in B. */
export function createNoiseTexture(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const rng = createSeededRandom(8086);
  const lattices: Float32Array[][] = [];
  for (let channel = 0; channel < 3; channel += 1) {
    const octaves: Float32Array[] = [];
    for (let o = 0; o < 5; o += 1) {
      const period = 4 << o;
      const lattice = new Float32Array(period * period);
      for (let i = 0; i < lattice.length; i += 1) lattice[i] = rng();
      octaves.push(lattice);
    }
    lattices.push(octaves);
  }
  const sample = (lattice: Float32Array, period: number, x: number, y: number): number => {
    const fx = x * period;
    const fy = y * period;
    const x0 = Math.floor(fx) % period;
    const y0 = Math.floor(fy) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    let tx = fx - Math.floor(fx);
    let ty = fy - Math.floor(fy);
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const a = lattice[y0 * period + x0] + (lattice[y0 * period + x1] - lattice[y0 * period + x0]) * tx;
    const b = lattice[y1 * period + x0] + (lattice[y1 * period + x1] - lattice[y1 * period + x0]) * tx;
    return a + (b - a) * ty;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const o = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        let amp = 0.5;
        let norm = 0;
        const octaves = channel === 2 ? 2 : 5;
        for (let k = 0; k < octaves; k += 1) {
          sum += sample(lattices[channel][k], 4 << k, u, v) * amp;
          norm += amp;
          amp *= 0.5;
        }
        data[o + channel] = Math.max(0, Math.min(255, Math.round((sum / norm) * 255)));
      }
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
