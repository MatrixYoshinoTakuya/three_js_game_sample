// Packages the production build as a Claude Artifact: one HTML page (styles
// inlined, no <html>/<head>/<body> of its own) plus the game bundle beside it.
// Usage: npm run build && node scripts/build-artifact.mjs
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const assets = path.join(root, 'dist', 'assets');
const out = path.join(root, 'artifact-build');

const files = readdirSync(assets);
const jsName = files.find((name) => /^index-.*\.js$/.test(name));
const cssName = files.find((name) => /^index-.*\.css$/.test(name));
if (!jsName || !cssName) throw new Error('Run "npm run build" first: dist/assets has no bundle.');

const css = readFileSync(path.join(assets, cssName), 'utf8');
// The source map is not published with the artifact.
const js = readFileSync(path.join(assets, jsName), 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');

const page = `<title>ASHEN SKYLINE</title>
<style>
/* One fixed dusk look: a full-bleed game canvas with the HUD layered on top. */
:root { color-scheme: dark; --void: #0b0908; }
html, body { height: 100%; }
body { background: var(--void); overflow: hidden; }
${css}
/* Fit inside the viewer's safe-area padding instead of the raw viewport. */
html, body, #app { width: 100%; height: 100%; }
#game-canvas { width: 100%; height: 100%; }
#install-app {
  position: fixed;
  z-index: 60;
  top: calc(env(safe-area-inset-top, 0px) + 22px);
  right: calc(max(16px, env(safe-area-inset-right, 0px)) + 68px);
  padding: 11px 18px;
  font: 600 13px/1 "Bahnschrift", "DIN Alternate", "Roboto Condensed", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif;
  letter-spacing: 0.08em;
  color: var(--amber, #ffb347);
  background: rgba(14, 10, 8, 0.72);
  border: 1px solid var(--amber, #ffb347);
  clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
  cursor: pointer;
}
#install-note {
  position: fixed;
  z-index: 60;
  top: calc(env(safe-area-inset-top, 0px) + 26px);
  right: calc(max(16px, env(safe-area-inset-right, 0px)) + 68px);
  max-width: min(46ch, 52vw);
  margin: 0;
  padding: 8px 12px;
  font: 12px/1.5 "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif;
  color: var(--ash, #e9e1d2);
  background: rgba(14, 10, 8, 0.72);
  border-left: 2px solid var(--amber, #ffb347);
  pointer-events: none;
}
#install-app:hover { background: var(--amber, #ffb347); color: var(--void); }
#install-app:focus-visible { outline: 2px solid var(--ash, #e9e1d2); outline-offset: 3px; }
#install-app:disabled { opacity: 0.55; cursor: default; }
</style>
<main id="app">
  <canvas id="game-canvas" aria-label="ASHEN SKYLINE のゲーム画面"></canvas>
</main>
<button type="button" id="install-app" hidden>アプリとしてインストール</button>
<p id="install-note" hidden></p>
<script type="module" src="game.js"></script>
<script type="module">
// Desktop app support: an icon of its own, a sensible window, and an install
// button that only appears where the Claude desktop app can actually install it.
function drawIcon() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.beginPath();
  g.roundRect(0, 0, size, size, 56);
  g.clip();
  const sky = g.createLinearGradient(0, 0, 0, size);
  sky.addColorStop(0, '#2a2140');
  sky.addColorStop(0.55, '#c8572a');
  sky.addColorStop(0.78, '#ffb347');
  sky.addColorStop(1, '#1a100c');
  g.fillStyle = sky;
  g.fillRect(0, 0, size, size);
  // low sun
  const sun = g.createRadialGradient(168, 176, 4, 168, 176, 70);
  sun.addColorStop(0, 'rgba(255,244,214,1)');
  sun.addColorStop(0.35, 'rgba(255,196,110,0.75)');
  sun.addColorStop(1, 'rgba(255,160,70,0)');
  g.fillStyle = sun;
  g.fillRect(0, 0, size, size);
  // ruined skyline, one tower leaning on its neighbour
  g.fillStyle = '#120c0a';
  const towers = [[18, 120, 34], [58, 84, 30], [94, 136, 26], [196, 104, 28], [228, 142, 22]];
  for (const [x, top, w] of towers) g.fillRect(x, top, w, size - top);
  g.save();
  g.translate(128, 214);
  g.rotate(0.3);
  g.fillRect(-16, -150, 32, 150);
  g.restore();
  g.fillRect(0, 206, size, 50);
  // relay beam
  const beam = g.createLinearGradient(0, 20, 0, 206);
  beam.addColorStop(0, 'rgba(95,227,208,0)');
  beam.addColorStop(1, 'rgba(95,227,208,0.95)');
  g.fillStyle = beam;
  g.fillRect(71, 20, 5, 66);
  // road vanishing toward the sun
  g.fillStyle = '#ffb347';
  g.beginPath();
  g.moveTo(124, 256);
  g.lineTo(132, 256);
  g.lineTo(165, 210);
  g.lineTo(163, 210);
  g.closePath();
  g.fill();
  return canvas.toDataURL('image/png');
}

const desktop = await window.claude?.use?.('desktop').catch(() => null);
if (desktop?.app?.dock) {
  const icon = drawIcon();
  if (icon) desktop.app.dock.setIcon(icon).catch(() => undefined);
}
if (desktop?.window) {
  desktop.window.setOptions({ width: 1280, height: 720 }).catch(() => undefined);
}

const button = document.getElementById('install-app');
const installState = desktop ? await (desktop.install ? desktop.install.state().catch(() => 'error') : 'no-install') : 'no-desktop';
const installable = installState === 'available';
// When the app cannot be installed from this view, say why on the title screen:
// "no-desktop" = the desktop-app feature is off for this account/organization or
// this view does not serve it; "unavailable" = the feature is on but this view
// (browser, pop-out window) is not one the Claude desktop app installs from.
const note = document.getElementById('install-note');
if (note && !installable && !desktop?.fs) {
  const reason = {
    'no-desktop': 'この表示ではデスクトップアプリ機能が提供されていません（機能が未提供・組織設定でオフ・未対応の画面のいずれか）',
    unavailable: '機能は有効ですが、この画面からはインストールできません（Claude Desktop のメイン画面で開いてください）',
    installed: 'このコンピュータにはインストール済みです',
    'no-install': 'インストール機能を取得できませんでした',
    error: 'インストール状態の確認に失敗しました',
  }[installState] ?? installState;
  note.textContent = 'アプリ化: ' + reason;
  const syncNote = () => {
    note.hidden = document.getElementById('hud-root')?.dataset.mode !== 'title';
  };
  syncNote();
  setInterval(syncNote, 400);
}
if (button && installable) {
  // Offer it on the title screen only, so it never sits over the HUD in play.
  const sync = () => {
    const mode = document.getElementById('hud-root')?.dataset.mode;
    button.hidden = mode !== 'title';
  };
  sync();
  const timer = setInterval(sync, 400);
  button.addEventListener('click', async () => {
    button.disabled = true;
    const result = await desktop.install.request().catch(() => 'failed');
    if (result === 'installed') {
      clearInterval(timer);
      button.hidden = true;
    } else {
      button.disabled = false;
      if (result === 'failed') button.textContent = 'インストールできませんでした。もう一度試す';
    }
    button.blur();
  });
}
</script>
`;

mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'ashen-skyline.html'), page);
writeFileSync(path.join(out, 'game.js'), js);
console.log(`artifact-build/ashen-skyline.html ${(page.length / 1024).toFixed(0)} kB, game.js ${(js.length / 1024).toFixed(0)} kB`);
