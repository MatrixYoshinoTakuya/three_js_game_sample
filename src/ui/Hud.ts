import type { GameHud, HudEvent, HudFrame, HudMode, MinimapWorld, TouchIntents } from '../game/contracts';
import { Minimap } from './Minimap';
import { TouchControls } from './TouchControls';
import { buildHudMarkup, COMPASS_PX_PER_DEG, COMPASS_TAPE_START } from './template';

const RAD2DEG = 180 / Math.PI;
const MINIMAP_INTERVAL_MS = 50;
const TYPE_CHARS_PER_SEC = 42;
const TOAST_MS = 2200;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function formatTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

/**
 * DOM/SVG/canvas HUD for ASHEN SKYLINE. Builds its own markup inside `#app`,
 * so the game only talks to it through the `GameHud` interface.
 */
export class Hud implements GameHud {
  readonly touch: TouchIntents = {
    active: false,
    steer: 0,
    throttle: 0,
    fire: false,
    boost: false,
    handbrake: false,
  };

  private readonly root: HTMLDivElement;
  private readonly abort = new AbortController();
  private readonly handlers = new Map<HudEvent, Array<() => void>>();
  private readonly minimap: Minimap;
  private readonly touchControls: TouchControls;

  // Cached nodes.
  private readonly elSpeed: HTMLElement;
  private readonly elRpmArc: SVGElement;
  private readonly elBoostArc: SVGElement;
  private readonly elSpeedo: HTMLElement;
  private readonly elArmorRow: HTMLElement;
  private readonly elArmorFill: HTMLElement;
  private readonly elArmorNum: HTMLElement;
  private readonly elHeatRow: HTMLElement;
  private readonly elHeatFill: HTMLElement;
  private readonly elTape: HTMLElement;
  private readonly elCpWindow: HTMLElement;
  private readonly elCpObj: HTMLElement;
  private readonly elCpDeg: HTMLElement;
  private readonly elObj: HTMLElement;
  private readonly elObjTitle: HTMLElement;
  private readonly elObjDetail: HTMLElement;
  private readonly elObjDist: HTMLElement;
  private readonly elChip: HTMLElement;
  private readonly elChipNum: HTMLElement;
  private readonly elBoss: HTMLElement;
  private readonly elBossName: HTMLElement;
  private readonly elBossPct: HTMLElement;
  private readonly elBossFill: HTMLElement;
  private readonly elDlg: HTMLElement;
  private readonly elDlgSpeaker: HTMLElement;
  private readonly elDlgShown: HTMLElement;
  private readonly elDlgRest: HTMLElement;
  private readonly elToast: HTMLElement;
  private readonly elToastText: HTMLElement;
  private readonly elVignette: HTMLElement;
  private readonly elHit: HTMLElement;
  private readonly elDmg: HTMLElement[];
  private readonly elLoadFill: HTMLElement;
  private readonly elLoadPct: HTMLElement;
  private readonly muteButtons: HTMLElement[];
  private readonly statNodes: Record<'fail' | 'done', { kills: HTMLElement; time: HTMLElement; damage: HTMLElement }>;

  // Last-written values (DOM is only touched when one of these changes).
  private mode: HudMode | null = null;
  private vSpeed = -1;
  private vRpm = -1;
  private vBoost = -1;
  private vBoostActive = false;
  private vArmor = -1;
  private vArmorLow = false;
  private vHeat = -1;
  private vOverheated = false;
  private vTapeX = Number.NaN;
  private vDeg = -1;
  private vObjX = Number.NaN;
  private vObjState = 0; // 0 hidden, 1 in view, 2 clamped left, 3 clamped right
  private vTitle: string | null = null;
  private vDetail: string | null = null;
  private vDist = -2;
  private vEnemies = -2;
  private vBossOn = false;
  private vBossName: string | null = null;
  private vBossHp = -1;
  private vKills = -1;
  private vTime = -1;
  private vDamage = -1;
  private vLoad = -1;

  private compassHalfDeg = 70;
  private lastNow = 0;
  private lastMapDraw = 0;
  private reducedMotion = false;
  private dmgIndex = 0;

  // Dialogue typewriter state.
  private dlgOn = false;
  private dlgText = '';
  private dlgClock = 0;
  private dlgDuration = 0;
  private dlgChars = -1;

  private toastTimer = 0;

  constructor() {
    const host = document.querySelector<HTMLElement>('#app') ?? document.body;
    host.querySelector('#hud-root')?.remove();

    const root = document.createElement('div');
    root.id = 'hud-root';
    root.className = 'hud';
    root.dataset.mode = 'loading';
    root.innerHTML = buildHudMarkup();
    host.appendChild(root);
    this.root = root;

    const ref = <T extends Element = HTMLElement>(name: string): T => {
      const node = root.querySelector<T>(`[data-ref="${name}"]`);
      if (!node) throw new Error(`HUD markup is missing "${name}".`);
      return node;
    };

    this.elSpeed = ref('speed');
    this.elRpmArc = ref<SVGElement>('rpmArc');
    this.elBoostArc = ref<SVGElement>('boostArc');
    this.elSpeedo = ref('speedo');
    this.elArmorRow = ref('armorRow');
    this.elArmorFill = ref('armorFill');
    this.elArmorNum = ref('armorNum');
    this.elHeatRow = ref('heatRow');
    this.elHeatFill = ref('heatFill');
    this.elTape = ref('tape');
    this.elCpWindow = ref('cpWindow');
    this.elCpObj = ref('cpObj');
    this.elCpDeg = ref('cpDeg');
    this.elObj = ref('obj');
    this.elObjTitle = ref('objTitle');
    this.elObjDetail = ref('objDetail');
    this.elObjDist = ref('objDist');
    this.elChip = ref('chip');
    this.elChipNum = ref('chipNum');
    this.elBoss = ref('boss');
    this.elBossName = ref('bossName');
    this.elBossPct = ref('bossPct');
    this.elBossFill = ref('bossFill');
    this.elDlg = ref('dlg');
    this.elDlgSpeaker = ref('dlgSpeaker');
    this.elDlgShown = ref('dlgShown');
    this.elDlgRest = ref('dlgRest');
    this.elToast = ref('toast');
    this.elToastText = ref('toastText');
    this.elVignette = ref('vignette');
    this.elHit = ref('hit');
    this.elDmg = [ref('dmg0'), ref('dmg1'), ref('dmg2')];
    this.elLoadFill = ref('loadFill');
    this.elLoadPct = ref('loadPct');
    this.muteButtons = Array.from(root.querySelectorAll<HTMLElement>('[data-mute]'));
    this.statNodes = {
      fail: { kills: ref('failKills'), time: ref('failTime'), damage: ref('failDamage') },
      done: { kills: ref('doneKills'), time: ref('doneTime'), damage: ref('doneDamage') },
    };

    this.minimap = new Minimap(ref<HTMLCanvasElement>('map'));
    this.touchControls = new TouchControls(
      ref('stick'),
      ref('knob'),
      Array.from(root.querySelectorAll<HTMLElement>('[data-touch]')),
      this.touch,
      this.abort.signal,
    );

    const signal = this.abort.signal;
    root.addEventListener('click', this.onClick, { signal });
    root.addEventListener('contextmenu', this.onContextMenu, { signal });
    window.addEventListener('resize', this.onResize, { signal });
    window.addEventListener('orientationchange', this.onResize, { signal });
    window.addEventListener('blur', this.onRelease, { signal });
    document.addEventListener('visibilitychange', this.onRelease, { signal });

    // Touch UI: coarse primary pointer, or the first real touch on any device.
    const coarse = window.matchMedia('(pointer: coarse)');
    if (coarse.matches) this.enableTouchUi();
    coarse.addEventListener('change', this.onCoarseChange, { signal });
    window.addEventListener('touchstart', this.enableTouchUi, { signal, passive: true, once: true });

    this.lastNow = performance.now();
    this.measure();
  }

  // ------------------------------------------------------------ GameHud API

  setMinimapWorld(world: MinimapWorld): void {
    this.minimap.setWorld(world);
  }

  update(frame: HudFrame): void {
    const now = performance.now();
    const dt = Math.min(100, now - this.lastNow);
    this.lastNow = now;

    const mode = frame.mode;
    if (mode !== this.mode) this.applyMode(mode);
    if (this.dlgOn && mode !== 'paused') this.tickDialogue(dt);

    if (mode === 'failed' || mode === 'complete') {
      this.writeStats(mode === 'failed' ? 'fail' : 'done', frame);
      return;
    }
    if (mode !== 'playing' && mode !== 'paused' && mode !== 'cinematic') return;

    // Speed + tachometer.
    const speed = Math.round(Math.abs(frame.speedKmh));
    if (speed !== this.vSpeed) {
      this.vSpeed = speed;
      this.elSpeed.textContent = String(speed);
    }
    const rpm = Math.round(clamp01(frame.rpm01) * 200) / 2;
    if (rpm !== this.vRpm) {
      this.vRpm = rpm;
      this.elRpmArc.style.strokeDashoffset = String(100 - rpm);
    }
    const boost = Math.round(clamp01(frame.boost01) * 100);
    if (boost !== this.vBoost) {
      this.vBoost = boost;
      this.elBoostArc.style.strokeDashoffset = String(100 - boost);
    }
    if (frame.boostActive !== this.vBoostActive) {
      this.vBoostActive = frame.boostActive;
      this.elSpeedo.classList.toggle('is-boosting', frame.boostActive);
    }

    // Armor + weapon heat.
    const armor = Math.round(clamp01(frame.armor01) * 100);
    if (armor !== this.vArmor) {
      this.vArmor = armor;
      this.elArmorFill.style.transform = `scaleX(${armor / 100})`;
      this.elArmorNum.textContent = String(armor);
      const low = armor < 30;
      if (low !== this.vArmorLow) {
        this.vArmorLow = low;
        this.elArmorRow.classList.toggle('is-low', low);
      }
    }
    const heat = Math.round(clamp01(frame.heat01) * 100);
    if (heat !== this.vHeat) {
      this.vHeat = heat;
      this.elHeatFill.style.transform = `scaleX(${heat / 100})`;
    }
    if (frame.overheated !== this.vOverheated) {
      this.vOverheated = frame.overheated;
      this.elHeatRow.classList.toggle('is-over', frame.overheated);
    }

    // Compass tape + objective chevron.
    let deg = (frame.headingRad * RAD2DEG) % 360;
    if (deg < 0) deg += 360;
    const tapeX = Math.round(-(deg - COMPASS_TAPE_START) * COMPASS_PX_PER_DEG * 2) / 2;
    if (tapeX !== this.vTapeX) {
      this.vTapeX = tapeX;
      this.elTape.style.transform = `translate3d(${tapeX}px,0,0)`;
    }
    const degInt = Math.round(deg) % 360;
    if (degInt !== this.vDeg) {
      this.vDeg = degInt;
      this.elCpDeg.textContent = degInt < 10 ? `00${degInt}` : degInt < 100 ? `0${degInt}` : String(degInt);
    }
    const objective = frame.objective;
    const pos = objective.position;
    let objState = 0;
    let objX = 0;
    if (pos) {
      const bearing = Math.atan2(pos.x - frame.player.x, pos.z - frame.player.z) * RAD2DEG;
      let rel = (bearing - deg) % 360;
      if (rel > 180) rel -= 360;
      else if (rel < -180) rel += 360;
      const limit = this.compassHalfDeg;
      objState = 1;
      if (rel > limit) {
        rel = limit;
        objState = 3;
      } else if (rel < -limit) {
        rel = -limit;
        objState = 2;
      }
      objX = Math.round(rel * COMPASS_PX_PER_DEG * 2) / 2;
    }
    if (objState !== this.vObjState) {
      this.vObjState = objState;
      this.elCpObj.dataset.state = String(objState);
    }
    if (objState !== 0 && objX !== this.vObjX) {
      this.vObjX = objX;
      this.elCpObj.style.transform = `translate3d(${objX}px,0,0)`;
    }

    // Objective tracker.
    if (objective.title !== this.vTitle) {
      const first = this.vTitle === null;
      this.vTitle = objective.title;
      this.elObjTitle.textContent = objective.title;
      if (!first && !this.reducedMotion) {
        this.elObj.animate(
          [
            { opacity: 0.2, transform: 'translate3d(-14px,0,0)', filter: 'brightness(2.2)' },
            { opacity: 1, transform: 'translate3d(0,0,0)', filter: 'brightness(1)' },
          ],
          { duration: 520, easing: 'cubic-bezier(0.2,0.8,0.2,1)' },
        );
      }
    }
    if (objective.detail !== this.vDetail) {
      this.vDetail = objective.detail;
      this.elObjDetail.textContent = objective.detail;
    }
    const dist = objective.distanceM === null ? -1 : Math.max(0, Math.round(objective.distanceM));
    if (dist !== this.vDist) {
      this.vDist = dist;
      this.elObjDist.textContent = dist < 0 ? '' : `${dist} m`;
    }

    // Enemy counter chip.
    const enemies = frame.enemiesRemaining === null ? -1 : Math.max(0, Math.round(frame.enemiesRemaining));
    if (enemies !== this.vEnemies) {
      const wasOn = this.vEnemies >= 0;
      this.vEnemies = enemies;
      if (enemies >= 0) this.elChipNum.textContent = `×${enemies}`;
      if (wasOn !== enemies >= 0) this.elChip.classList.toggle('is-on', enemies >= 0);
    }

    // Boss bar.
    const boss = frame.boss;
    if ((boss !== null) !== this.vBossOn) {
      this.vBossOn = boss !== null;
      this.elBoss.classList.toggle('is-on', this.vBossOn);
      this.root.classList.toggle('has-boss', this.vBossOn);
    }
    if (boss) {
      if (boss.name !== this.vBossName) {
        this.vBossName = boss.name;
        this.elBossName.textContent = boss.name;
      }
      const hp = Math.round(clamp01(boss.hp01) * 200) / 2;
      if (hp !== this.vBossHp) {
        this.vBossHp = hp;
        this.elBossFill.style.transform = `scaleX(${hp / 100})`;
        this.elBossPct.textContent = `${Math.ceil(hp)}%`;
      }
    }

    // Minimap (throttled to ~20 Hz, skipped while hidden).
    if (mode !== 'cinematic' && now - this.lastMapDraw >= MINIMAP_INTERVAL_MS) {
      this.lastMapDraw = now;
      this.minimap.draw(frame, now, this.reducedMotion);
    }
  }

  showDialogue(speaker: string, text: string, seconds: number): void {
    this.dlgOn = true;
    this.dlgText = text;
    this.dlgClock = 0;
    this.dlgDuration = Math.max(0.5, seconds) * 1000;
    this.dlgChars = -1;
    this.elDlgSpeaker.textContent = speaker;
    if (this.reducedMotion) {
      this.dlgChars = text.length;
      this.elDlgShown.textContent = text;
      this.elDlgRest.textContent = '';
    } else {
      this.elDlgShown.textContent = '';
      this.elDlgRest.textContent = text;
    }
    this.elDlg.classList.add('is-on');
    this.elDlg.classList.remove('is-done');
  }

  clearDialogue(): void {
    if (!this.dlgOn) return;
    this.dlgOn = false;
    this.elDlg.classList.remove('is-on');
  }

  toast(text: string, kind: 'info' | 'warning' | 'success' = 'info'): void {
    this.elToastText.textContent = text;
    this.elToast.dataset.kind = kind;
    this.elToast.classList.add('is-on');
    if (!this.reducedMotion) {
      this.elToast.animate(
        [
          { opacity: 0, transform: 'translate3d(-50%,10px,0) scaleX(1.12)' },
          { opacity: 1, transform: 'translate3d(-50%,0,0) scaleX(1)' },
        ],
        { duration: 260, easing: 'cubic-bezier(0.2,0.8,0.2,1)' },
      );
    }
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(this.hideToast, TOAST_MS);
  }

  flashDamage(angleRad: number, strength01: number): void {
    if (this.reducedMotion) return;
    const s = 0.45 + clamp01(strength01) * 0.55;
    const arc = this.elDmg[this.dmgIndex];
    this.dmgIndex = (this.dmgIndex + 1) % this.elDmg.length;
    const rot = `rotate(${(angleRad * RAD2DEG).toFixed(1)}deg)`;
    arc.animate(
      [
        { opacity: s, transform: `translate(-50%,-50%) ${rot} scale(1.08)` },
        { opacity: s, transform: `translate(-50%,-50%) ${rot} scale(1)`, offset: 0.25 },
        { opacity: 0, transform: `translate(-50%,-50%) ${rot} scale(1)` },
      ],
      { duration: 900, easing: 'ease-out' },
    );
    this.elVignette.animate([{ opacity: s * 0.9 }, { opacity: 0 }], { duration: 650, easing: 'ease-out' });
  }

  hitMarker(kill: boolean): void {
    if (this.reducedMotion) return;
    this.elHit.classList.toggle('is-kill', kill);
    const from = kill ? 1.5 : 1.15;
    this.elHit.animate(
      [
        { opacity: 1, transform: `translate(-50%,-50%) scale(${from})` },
        { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.35 },
        { opacity: 0, transform: 'translate(-50%,-50%) scale(0.92)' },
      ],
      { duration: kill ? 420 : 200, easing: 'ease-out' },
    );
  }

  setMuted(muted: boolean): void {
    this.root.classList.toggle('is-muted', muted);
    for (const button of this.muteButtons) button.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }

  setLoadingProgress(value01: number): void {
    const pct = Math.round(clamp01(value01) * 100);
    if (pct === this.vLoad) return;
    this.vLoad = pct;
    this.elLoadFill.style.transform = `scaleX(${pct / 100})`;
    this.elLoadPct.textContent = `${pct}%`;
  }

  on(event: HudEvent, handler: () => void): void {
    const list = this.handlers.get(event);
    if (list) list.push(handler);
    else this.handlers.set(event, [handler]);
  }

  setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
    this.root.classList.toggle('hud--still', enabled);
    if (enabled && this.dlgOn) {
      this.dlgChars = this.dlgText.length;
      this.elDlgShown.textContent = this.dlgText;
      this.elDlgRest.textContent = '';
    }
  }

  dispose(): void {
    this.abort.abort();
    window.clearTimeout(this.toastTimer);
    this.handlers.clear();
    this.touchControls.releaseAll();
    this.root.remove();
  }

  // ------------------------------------------------------------ internals

  private applyMode(mode: HudMode): void {
    const previous = this.mode;
    this.mode = mode;
    this.root.dataset.mode = mode;
    if (mode !== 'playing') this.touchControls.releaseAll();
    if (previous === null || mode === 'playing') this.measure();
    if (mode === 'title' || mode === 'loading') {
      // Fresh run: drop transient overlays so nothing stale carries over.
      this.clearDialogue();
      this.hideToast();
    }
  }

  private tickDialogue(dt: number): void {
    this.dlgClock += dt;
    const total = this.dlgText.length;
    if (this.dlgChars < total) {
      const chars = Math.min(total, Math.floor((this.dlgClock / 1000) * TYPE_CHARS_PER_SEC));
      if (chars !== this.dlgChars) {
        this.dlgChars = chars;
        this.elDlgShown.textContent = this.dlgText.slice(0, chars);
        this.elDlgRest.textContent = this.dlgText.slice(chars);
        if (chars >= total) this.elDlg.classList.add('is-done');
      }
    }
    if (this.dlgClock >= this.dlgDuration) this.clearDialogue();
  }

  private writeStats(which: 'fail' | 'done', frame: HudFrame): void {
    const nodes = this.statNodes[which];
    const kills = Math.round(frame.stats.kills);
    const time = Math.floor(frame.stats.timeSec);
    const damage = Math.round(frame.stats.damageTaken);
    if (kills !== this.vKills) {
      this.vKills = kills;
      this.statNodes.fail.kills.textContent = String(kills);
      this.statNodes.done.kills.textContent = String(kills);
    }
    if (time !== this.vTime) {
      this.vTime = time;
      const text = formatTime(time);
      this.statNodes.fail.time.textContent = text;
      this.statNodes.done.time.textContent = text;
    }
    if (damage !== this.vDamage) {
      this.vDamage = damage;
      nodes.damage.textContent = String(damage);
      (which === 'fail' ? this.statNodes.done : this.statNodes.fail).damage.textContent = String(damage);
    }
  }

  /** Layout reads live here, never in update(). */
  private measure(): void {
    this.minimap.resize();
    const width = this.elCpWindow.clientWidth;
    // Keep the clamped chevron inside the un-faded part of the tape (mask fades the outer 16%).
    if (width > 0) this.compassHalfDeg = Math.max(10, (width * 0.31) / COMPASS_PX_PER_DEG);
    this.vObjX = Number.NaN;
  }

  private emit(event: HudEvent): void {
    const list = this.handlers.get(event);
    if (!list) return;
    for (let i = 0; i < list.length; i += 1) list[i]();
  }

  private readonly hideToast = (): void => {
    window.clearTimeout(this.toastTimer);
    this.elToast.classList.remove('is-on');
  };

  private readonly onClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-act]') : null;
    if (!target) return;
    // Hand keyboard focus back to the game so Space/Enter never re-trigger UI.
    target.blur();
    this.emit(target.dataset.act as HudEvent);
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private readonly onResize = (): void => {
    this.measure();
    this.lastMapDraw = 0;
  };

  private readonly onRelease = (): void => {
    this.touchControls.releaseAll();
  };

  private readonly onCoarseChange = (e: MediaQueryListEvent): void => {
    if (e.matches) this.enableTouchUi();
  };

  private readonly enableTouchUi = (): void => {
    if (this.root.classList.contains('is-touch')) return;
    this.root.classList.add('is-touch');
    this.measure();
  };
}
