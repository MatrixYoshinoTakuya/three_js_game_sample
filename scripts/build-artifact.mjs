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
</style>
<main id="app">
  <canvas id="game-canvas" aria-label="ASHEN SKYLINE のゲーム画面"></canvas>
</main>
<script type="module" src="game.js"></script>
`;

mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'ashen-skyline.html'), page);
writeFileSync(path.join(out, 'game.js'), js);
console.log(`artifact-build/ashen-skyline.html ${(page.length / 1024).toFixed(0)} kB, game.js ${(js.length / 1024).toFixed(0)} kB`);
