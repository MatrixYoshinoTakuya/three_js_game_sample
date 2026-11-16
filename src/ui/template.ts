/**
 * Static HUD markup. Built once by Hud.ts; every dynamic node carries a
 * `data-ref` so the Hud can cache direct element references.
 */

const DEG = Math.PI / 180;

/** Clockwise arc path around (100,100), angles in SVG degrees (0 = +x, 90 = down). */
function arc(r: number, a0: number, a1: number): string {
  const x0 = 100 + r * Math.cos(a0 * DEG);
  const y0 = 100 + r * Math.sin(a0 * DEG);
  const x1 = 100 + r * Math.cos(a1 * DEG);
  const y1 = 100 + r * Math.sin(a1 * DEG);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export const GAUGE_START = 150;
export const GAUGE_SWEEP = 240;

function gaugeTicks(): string {
  let out = '';
  for (let i = 0; i <= 32; i += 1) {
    const major = i % 4 === 0;
    const a = (GAUGE_START + (GAUGE_SWEEP * i) / 32) * DEG;
    const r0 = 89;
    const r1 = major ? 97 : 93;
    const cls = i >= 28 ? 'sp-tick sp-tick--red' : major ? 'sp-tick sp-tick--major' : 'sp-tick';
    out += `<line class="${cls}" x1="${(100 + r0 * Math.cos(a)).toFixed(2)}" y1="${(100 + r0 * Math.sin(a)).toFixed(2)}" x2="${(100 + r1 * Math.cos(a)).toFixed(2)}" y2="${(100 + r1 * Math.sin(a)).toFixed(2)}"/>`;
  }
  return out;
}

export const COMPASS_PX_PER_DEG = 3;
export const COMPASS_TAPE_START = -180;
const COMPASS_TAPE_END = 540;

function compassLabels(): string {
  const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  let out = '';
  for (let d = COMPASS_TAPE_START; d <= COMPASS_TAPE_END; d += 45) {
    const norm = ((d % 360) + 360) % 360;
    const cardinal = norm % 90 === 0;
    const left = (d - COMPASS_TAPE_START) * COMPASS_PX_PER_DEG;
    out += `<span class="cp-mark${cardinal ? ' cp-mark--card' : ''}${norm === 0 ? ' cp-mark--north' : ''}" style="left:${left}px">${names[norm]}</span>`;
  }
  return out;
}

const ICON_SOUND = `<svg class="ico ico-sound" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.6L12 5.6v12.8L7.6 14.5H4z" fill="currentColor"/><path class="ico-sound-on" d="M15 9a4.2 4.2 0 0 1 0 6M17.4 6.4a7.8 7.8 0 0 1 0 11.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/><path class="ico-sound-off" d="M15.2 9.2l5 5.6M20.2 9.2l-5 5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/></svg>`;

const ICON_PAUSE = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor"/></svg>`;

const ICON_DIAMOND = `<svg class="ico-s" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1l5 5-5 5-5-5z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 4.2L7.8 6 6 7.8 4.2 6z" fill="currentColor"/></svg>`;

const ICON_RADIO = `<svg class="ico-s" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 7.2v7.3M5.2 14.5h5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="5.6" r="1.5" fill="currentColor"/><path d="M4.6 2.4a4.6 4.6 0 0 0 0 6.4M11.4 2.4a4.6 4.6 0 0 1 0 6.4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`;

const ICON_THREAT = `<svg class="ico-s" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l6.5 6.5L8 14.5 1.5 8z" fill="currentColor"/><path d="M8 4.6v4.2M8 10.2v1.4" stroke="#140b08" stroke-width="1.5"/></svg>`;

const ICON_BOLT = `<svg class="ico-s" viewBox="0 0 12 12" aria-hidden="true"><path d="M7.2 0.6L2.2 6.8h3L4.4 11.4l5.4-6.6H6.6z" fill="currentColor"/></svg>`;

/** Ruined-skyline mark used on loading/title. */
const MARK = `<svg class="mark" viewBox="0 0 120 64" aria-hidden="true"><path d="M2 62h116" stroke="currentColor" stroke-width="1"/><path d="M8 62V34l6-4v32M20 62V22h9l3 5v35M38 62V40h8v22M50 62V8l4-5 4 5v10h5v44M68 62V28l8-6v40M82 62V38h7v-9l5 3v30M100 62V44h9v18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter"/><path d="M54 3v-3M46 12h16" stroke="var(--teal)" stroke-width="1.4"/><circle cx="54" cy="12" r="2.2" fill="var(--teal)"/></svg>`;

function muteButton(extra: string): string {
  return `<button type="button" class="ibtn ${extra}" data-act="muteToggle" data-mute aria-label="ミュート切替" aria-pressed="false" title="ミュート (M)">${ICON_SOUND}</button>`;
}

function legend(): string {
  const row = (keys: string[], label: string): string =>
    `<li><span class="lg-keys">${keys.map((k) => `<kbd>${k}</kbd>`).join('')}</span><span class="lg-label">${label}</span></li>`;
  return `<div class="legend" aria-label="操作方法">
    <div class="legend-head"><span>操作</span><em>CONTROLS</em></div>
    <ul class="legend-keys">
      ${row(['W', 'S', '↑', '↓'], 'アクセル / ブレーキ')}
      ${row(['A', 'D', '←', '→'], 'ステアリング')}
      ${row(['SPACE'], '機関砲')}
      ${row(['SHIFT'], 'ブースト')}
      ${row(['X'], 'ハンドブレーキ')}
      ${row(['ESC', 'P'], 'ポーズ')}
      ${row(['M'], 'ミュート')}
    </ul>
    <ul class="legend-touch">
      <li><span class="lg-keys"><kbd>STICK</kbd></span><span class="lg-label">操舵・アクセル</span></li>
      <li><span class="lg-keys"><kbd>FIRE</kbd></span><span class="lg-label">機関砲</span></li>
      <li><span class="lg-keys"><kbd>BOOST</kbd></span><span class="lg-label">ブースト</span></li>
      <li><span class="lg-keys"><kbd>DRIFT</kbd></span><span class="lg-label">ハンドブレーキ</span></li>
    </ul>
  </div>`;
}

function stats(prefix: string): string {
  return `<dl class="stats">
    <div><dt>撃破<em>KILLS</em></dt><dd data-ref="${prefix}Kills">0</dd></div>
    <div><dt>走行時間<em>TIME</em></dt><dd data-ref="${prefix}Time">00:00</dd></div>
    <div><dt>被ダメージ<em>DAMAGE</em></dt><dd data-ref="${prefix}Damage">0</dd></div>
  </dl>`;
}

export function buildHudMarkup(): string {
  const gaugeEnd = GAUGE_START + GAUGE_SWEEP;
  const rpmPath = arc(84, GAUGE_START, gaugeEnd);
  const redPath = arc(84, GAUGE_START + GAUGE_SWEEP * 0.875, gaugeEnd);
  const boostPath = arc(70, GAUGE_START, gaugeEnd);

  return `
  <div class="hud-shade" aria-hidden="true"></div>

  <div class="hud-fx" aria-hidden="true">
    <div class="hud-vignette" data-ref="vignette"></div>
    <div class="hud-dmg" data-ref="dmg0"><svg viewBox="0 0 200 200"><path d="M52 36A80 80 0 0 1 148 36"/><path class="dmg-tip" d="M100 4l7 12h-14z"/></svg></div>
    <div class="hud-dmg" data-ref="dmg1"><svg viewBox="0 0 200 200"><path d="M52 36A80 80 0 0 1 148 36"/><path class="dmg-tip" d="M100 4l7 12h-14z"/></svg></div>
    <div class="hud-dmg" data-ref="dmg2"><svg viewBox="0 0 200 200"><path d="M52 36A80 80 0 0 1 148 36"/><path class="dmg-tip" d="M100 4l7 12h-14z"/></svg></div>
    <div class="hud-hit" data-ref="hit"><svg viewBox="0 0 40 40"><path d="M7 7l8 8M33 7l-8 8M7 33l8-8M33 33l-8-8"/></svg></div>
  </div>

  <div class="hud-bar hud-bar--top" aria-hidden="true"><span class="cine-tag">${ICON_RADIO}<b>イベント</b><em>EVENT</em></span></div>
  <div class="hud-bar hud-bar--bottom" aria-hidden="true"></div>

  <div class="hud-play">
    <div class="hud-col">
      <div class="hud-obj" data-ref="obj" aria-live="polite">
        <div class="obj-label">${ICON_DIAMOND}<span>目標</span><em>OBJECTIVE</em></div>
        <div class="obj-title" data-ref="objTitle"></div>
        <div class="obj-meta"><span class="obj-detail" data-ref="objDetail"></span><span class="obj-dist" data-ref="objDist"></span></div>
      </div>
      <div class="hud-chip" data-ref="chip">${ICON_THREAT}<span>敵影</span><b data-ref="chipNum">×0</b></div>
      <div class="hud-minimap">
        <canvas data-ref="map" width="168" height="168"></canvas>
        <svg class="mm-rim" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="49" /><path d="M50 0v5M100 50h-5M50 100v-5M0 50h5"/></svg>
        <span class="mm-range">220M</span>
      </div>
      <div class="hud-vitals">
        <div class="vt-row vt-armor" data-ref="armorRow">
          <span class="vt-label">ARMOR<small>装甲</small></span>
          <div class="vt-bar vt-bar--seg"><i data-ref="armorFill"></i></div>
          <span class="vt-num" data-ref="armorNum">100</span>
        </div>
        <div class="vt-row vt-heat" data-ref="heatRow">
          <span class="vt-label">HEAT<small>砲身</small></span>
          <div class="vt-bar"><i data-ref="heatFill"></i></div>
          <span class="vt-state">OVERHEAT</span>
        </div>
      </div>
    </div>

    <div class="hud-top">
      <div class="hud-compass" aria-hidden="true">
        <div class="cp-window" data-ref="cpWindow">
          <div class="cp-tape" data-ref="tape">${compassLabels()}</div>
          <div class="cp-obj" data-ref="cpObj"><svg viewBox="0 0 14 10"><path d="M1 1l6 7 6-7" fill="none" stroke="currentColor" stroke-width="2.2"/></svg></div>
        </div>
        <div class="cp-needle"></div>
        <div class="cp-deg"><span data-ref="cpDeg">000</span>°</div>
      </div>
      <div class="hud-boss" data-ref="boss">
        <div class="boss-head">${ICON_THREAT}<span class="boss-name" data-ref="bossName"></span><em>WAR RIG</em><b data-ref="bossPct">100%</b></div>
        <div class="boss-bar"><i data-ref="bossFill"></i></div>
      </div>
    </div>

    <div class="hud-tr">
      ${muteButton('')}
      <button type="button" class="ibtn" data-act="pauseToggle" aria-label="ポーズ" title="ポーズ (Esc / P)">${ICON_PAUSE}</button>
    </div>

    <div class="hud-speedo" data-ref="speedo" aria-hidden="true">
      <svg class="sp-svg" viewBox="0 0 200 164">
        <path class="sp-track" d="${rpmPath}"/>
        <path class="sp-red" d="${redPath}"/>
        ${gaugeTicks()}
        <path class="sp-rpm" data-ref="rpmArc" d="${rpmPath}" pathLength="100"/>
        <path class="sp-boost-track" d="${boostPath}"/>
        <path class="sp-boost" data-ref="boostArc" d="${boostPath}" pathLength="100"/>
      </svg>
      <div class="sp-read"><span class="sp-num" data-ref="speed">0</span><span class="sp-unit">KM/H</span></div>
      <div class="sp-boost-label">${ICON_BOLT}<span>BOOST</span></div>
    </div>
  </div>

  <div class="hud-dialogue" data-ref="dlg" role="status">
    <div class="dlg-tag"><span class="dlg-wave"><i></i><i></i><i></i><i></i><i></i></span><b data-ref="dlgSpeaker"></b><em>RADIO</em></div>
    <p class="dlg-text"><span data-ref="dlgShown"></span><span class="dlg-rest" data-ref="dlgRest" aria-hidden="true"></span></p>
  </div>

  <div class="hud-toast" data-ref="toast" data-kind="info" role="status"><span data-ref="toastText"></span></div>

  <div class="hud-touch" data-ref="touch">
    <div class="tc-stick" data-ref="stick">
      <div class="tc-base"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48"/><path d="M50 8l6 9H44zM50 92l6-9H44zM8 50l9-6v12zM92 50l-9-6v12z"/></svg></div>
      <div class="tc-knob" data-ref="knob"></div>
    </div>
    <button type="button" tabindex="-1" class="tc-btn tc-drift" data-touch="handbrake" aria-label="ハンドブレーキ"><span>DRIFT</span></button>
    <button type="button" tabindex="-1" class="tc-btn tc-boost" data-touch="boost" aria-label="ブースト">${ICON_BOLT}<span>BOOST</span></button>
    <button type="button" tabindex="-1" class="tc-btn tc-fire" data-touch="fire" aria-label="機関砲"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="11"/><path d="M20 3v10M20 27v10M3 20h10M27 20h10"/></svg><span>FIRE</span></button>
  </div>

  <section class="hud-screen hud-loading" aria-label="読み込み中">
    <div class="load-inner">
      ${MARK}
      <div class="load-title">ASHEN SKYLINE</div>
      <div class="load-sub">灰の摩天楼</div>
      <div class="load-bar"><i data-ref="loadFill"></i></div>
      <div class="load-meta"><span>起動シーケンス<em>SYSTEM BOOT</em></span><b data-ref="loadPct">0%</b></div>
    </div>
  </section>

  <section class="hud-screen hud-title" aria-label="タイトル">
    <div class="tt-sector">${ICON_RADIO}<span>灰都・封鎖区域</span><em>RELAY LINE 07</em></div>
    ${muteButton('tt-mute')}
    <div class="tt-main">
      ${MARK}
      <h1 class="tt-logo"><span>ASHEN</span><span>SKYLINE</span></h1>
      <div class="tt-sub"><i></i><span>灰の摩天楼</span><i></i></div>
      <p class="tt-tagline">灰に沈んだ都市を駆け抜け、最後の電波を繋げ。</p>
      <button type="button" class="btn btn--primary tt-start" data-act="start"><span>エンジン始動</span><kbd>ENTER</kbd></button>
    </div>
    <div class="tt-legend">${legend()}</div>
  </section>

  <section class="hud-screen hud-paused" aria-label="ポーズ">
    <div class="panel">
      <div class="panel-head"><h2>PAUSED</h2><span>一時停止</span></div>
      <div class="panel-actions">
        <button type="button" class="btn btn--primary" data-act="resume"><span>再開</span><kbd>ESC</kbd></button>
        <button type="button" class="btn" data-act="restart"><span>最初からやり直す</span></button>
        <button type="button" class="btn btn--toggle" data-act="muteToggle" data-mute aria-pressed="false">${ICON_SOUND}<span class="lbl-on">サウンド ON</span><span class="lbl-off">サウンド OFF</span></button>
      </div>
      ${legend()}
    </div>
  </section>

  <section class="hud-screen hud-failed" aria-label="車両大破">
    <div class="result">
      <div class="result-kicker">SIGNAL LOST</div>
      <h2 class="result-title">車両大破</h2>
      <div class="result-sub">WRECKED</div>
      ${stats('fail')}
      <div class="result-actions">
        <button type="button" class="btn btn--primary" data-act="retry"><span>リトライ</span><small>チェックポイントから</small></button>
        <button type="button" class="btn" data-act="restart"><span>最初から</span></button>
      </div>
    </div>
  </section>

  <section class="hud-screen hud-complete" aria-label="ミッション完了">
    <div class="result">
      <div class="result-kicker">RELAY ONLINE</div>
      <h2 class="result-title">MISSION COMPLETE</h2>
      <div class="result-sub">第7中継塔 確保</div>
      ${stats('done')}
      <p class="result-chapter">CHAPTER 1 完 — TO BE CONTINUED</p>
      <div class="result-actions">
        <button type="button" class="btn btn--primary" data-act="restart"><span>もう一度走る</span></button>
      </div>
    </div>
  </section>
  `;
}
