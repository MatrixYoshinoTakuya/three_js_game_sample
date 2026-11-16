import type { GameHud, HudEvent, HudFrame, HudMode, HudTargetMarker, MinimapWorld, TouchIntents, UpgradeOption } from '../game/contracts';
import { Minimap } from './Minimap';
import { TouchControls } from './TouchControls';
import { buildHudMarkup, COMPASS_PX_PER_DEG, COMPASS_TAPE_START, UPGRADE_ICONS } from './template';

const RAD2DEG = 180 / Math.PI;
const MINIMAP_INTERVAL_MS = 50;
const TYPE_CHARS_PER_SEC = 42;
const TOAST_MS = 2200;
const TOAST_LONG_CHARS = 12;
const POPUP_MS = 1200;
const MAX_MISSILE_PIPS = 6;
const MAX_SIDE = 3;
const MAX_TARGETS = 16;
const UPGRADE_CARDS = 3;

// Keyframes are shared constants so transient effects allocate nothing but the Animation itself.
const POPUP_KEYS: Keyframe[] = [
  { opacity: 0, transform: 'translate3d(-10px,8px,0) scale(1.12)' },
  { opacity: 1, transform: 'translate3d(0,0,0) scale(1)', offset: 0.12 },
  { opacity: 1, transform: 'translate3d(0,-6px,0) scale(1)', offset: 0.7 },
  { opacity: 0, transform: 'translate3d(0,-18px,0) scale(1)' },
];
const POPUP_STILL_KEYS: Keyframe[] = [{ opacity: 1 }, { opacity: 1 }];
const POPUP_TIMING: KeyframeAnimationOptions = { duration: POPUP_MS, easing: 'linear' };
const COMBO_PULSE_KEYS: Keyframe[] = [
  { transform: 'scale(1.5)', filter: 'brightness(2)' },
  { transform: 'scale(1)', filter: 'brightness(1)' },
];
const COMBO_PULSE_TIMING: KeyframeAnimationOptions = { duration: 340, easing: 'cubic-bezier(0.2,0.8,0.2,1)' };
const COMBO_BREAK_KEYS: Keyframe[] = [
  { opacity: 1, transform: 'translate3d(0,0,0)' },
  { opacity: 1, transform: 'translate3d(-6px,0,0)', offset: 0.12 },
  { opacity: 0.9, transform: 'translate3d(5px,0,0)', offset: 0.26 },
  { opacity: 0.8, transform: 'translate3d(-4px,0,0)', offset: 0.4 },
  { opacity: 0.6, transform: 'translate3d(3px,0,0)', offset: 0.55 },
  { opacity: 0, transform: 'translate3d(0,6px,0)' },
];
const COMBO_BREAK_TIMING: KeyframeAnimationOptions = { duration: 460, easing: 'ease-out' };
const MISSILE_GAIN_KEYS: Keyframe[] = [
  { transform: 'scale(2.1)', filter: 'brightness(2.4)' },
  { transform: 'scale(1)', filter: 'brightness(1)' },
];
const MISSILE_GAIN_TIMING: KeyframeAnimationOptions = { duration: 420, easing: 'cubic-bezier(0.2,0.8,0.2,1)' };

type TargetKind = HudTargetMarker['kind'];

/** One pooled reticle and the values last written to it. */
type TargetSlot = {
  el: HTMLElement;
  arc: SVGElement;
  ring: HTMLElement;
  prog: SVGElement;
  dist: HTMLElement;
  on: boolean;
  kind: TargetKind | null;
  x: number;
  y: number;
  value: number;
  meters: number;
};

type SideRow = { el: HTMLElement; label: HTMLElement; dist: HTMLElement; on: boolean; text: string | null; done: boolean; meters: number };

type UpgradeCard = {
  el: HTMLButtonElement;
  icon: HTMLElement;
  name: HTMLElement;
  desc: HTMLElement;
  lv: HTMLElement;
  pips: HTMLElement[];
  on: boolean;
  id: string | null;
  vName: string | null;
  vDesc: string | null;
  vIcon: UpgradeOption['icon'] | null;
  vLevel: number;
};

type StatNodes = {
  rank: HTMLElement;
  rankLetter: HTMLElement;
  score: HTMLElement;
  combo: HTMLElement;
  scrap: HTMLElement;
  kills: HTMLElement;
  time: HTMLElement;
  damage: HTMLElement;
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 1234567 -> "1,234,567". */
function formatInt(value: number): string {
  const digits = String(Math.max(0, Math.round(value)));
  if (digits.length <= 3) return digits;
  let out = '';
  for (let end = digits.length; end > 0; end -= 3) {
    const part = digits.slice(Math.max(0, end - 3), end);
    out = out === '' ? part : `${part},${out}`;
  }
  return out;
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
    missile: false,
  };

  private readonly root: HTMLDivElement;
  private readonly abort = new AbortController();
  private readonly handlers = new Map<HudEvent, Array<() => void>>();
  private readonly upgradeHandlers: Array<(id: string) => void> = [];
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
  private readonly statNodes: StatNodes[];
  private readonly elScore: HTMLElement;
  private readonly elScrap: HTMLElement;
  private readonly elCombo: HTMLElement;
  private readonly elComboMult: HTMLElement;
  private readonly elComboCount: HTMLElement;
  private readonly elComboBar: HTMLElement;
  private readonly elMslRow: HTMLElement;
  private readonly elMslPips: HTMLElement[];
  private readonly elSide: HTMLElement;
  private readonly sideRows: SideRow[];
  private readonly elTargets: HTMLElement;
  private readonly targetTemplate: HTMLTemplateElement;
  private readonly targetSlots: TargetSlot[] = [];
  private readonly elPops: HTMLElement[];
  private readonly popLabels: HTMLElement[];
  private readonly popValues: HTMLElement[];
  private readonly elUpTitle: HTMLElement;
  private readonly elUpSub: HTMLElement;
  private readonly elUpCards: HTMLElement;
  private readonly upCards: UpgradeCard[];

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
  private vStatScore = -1;
  private vStatCombo = -1;
  private vStatScrap = -1;
  private vRank: string | null = null;
  private vScore = -1;
  private vScrap = -1;
  private vComboCount = 0;
  private vComboMult = -1;
  private vComboTimer = -1;
  private vMissiles = -1;
  private vMissileMax = -1;
  private vSideCount = 0;
  private vTargetCount = 0;
  private vCritical = false;
  private vUpTitle: string | null = null;
  private vUpSub: string | null = null;
  private vUpCount = -1;
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

  private comboBreak: Animation | null = null;
  private popIndex = 0;
  private popCount = 5;

  // Upgrade selection state.
  private upgradeKeysOn = false;
  private upPicked = false;
  private upSel = -1;

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
    this.statNodes = ['fail', 'done'].map((prefix) => ({
      rank: ref(`${prefix}Rank`),
      rankLetter: ref(`${prefix}RankLetter`),
      score: ref(`${prefix}Score`),
      combo: ref(`${prefix}Combo`),
      scrap: ref(`${prefix}Scrap`),
      kills: ref(`${prefix}Kills`),
      time: ref(`${prefix}Time`),
      damage: ref(`${prefix}Damage`),
    }));

    const child = (parent: Element, selector: string): HTMLElement => {
      const node = parent.querySelector<HTMLElement>(selector);
      if (!node) throw new Error(`HUD markup is missing "${selector}".`);
      return node;
    };

    this.elScore = ref('score');
    this.elScrap = ref('scrap');
    this.elCombo = ref('combo');
    this.elComboMult = ref('comboMult');
    this.elComboCount = ref('comboCount');
    this.elComboBar = ref('comboBar');
    this.elMslRow = ref('mslRow');
    this.elMslPips = Array.from(ref('mslPips').children) as HTMLElement[];
    this.elSide = ref('side');
    this.sideRows = (Array.from(this.elSide.children) as HTMLElement[]).map((el) => ({
      el,
      label: child(el, '.so-label'),
      dist: child(el, '.so-dist'),
      on: false,
      text: null,
      done: false,
      meters: -2,
    }));
    this.elTargets = ref('targets');
    this.targetTemplate = ref<HTMLTemplateElement>('tgTpl');
    this.elPops = Array.from(ref('pops').children) as HTMLElement[];
    this.popLabels = this.elPops.map((el) => child(el, 'span'));
    this.popValues = this.elPops.map((el) => child(el, 'b'));
    this.elUpTitle = ref('upTitle');
    this.elUpSub = ref('upSub');
    this.elUpCards = ref('upCards');
    this.upCards = Array.from(this.elUpCards.querySelectorAll<HTMLButtonElement>('.up-card')).map((el) => ({
      el,
      icon: child(el, '.up-icon'),
      name: child(el, '.up-name'),
      desc: child(el, '.up-desc'),
      lv: child(el, '.up-lv'),
      pips: Array.from(el.querySelectorAll<HTMLElement>('.up-pips i')),
      on: true,
      id: null,
      vName: null,
      vDesc: null,
      vIcon: null,
      vLevel: -1,
    }));

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
    if (this.dlgOn && mode !== 'paused' && mode !== 'upgrade') this.tickDialogue(dt);

    if (mode === 'failed' || mode === 'complete') {
      this.writeStats(frame);
      return;
    }
    if (mode === 'upgrade') {
      this.writeUpgrade(frame.upgrade);
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
    const critical = frame.armor01 < 0.3;
    if (critical !== this.vCritical) {
      this.vCritical = critical;
      this.root.classList.toggle('is-critical', critical);
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

    // Missile pips.
    let missileMax = Math.round(frame.missileMax);
    missileMax = missileMax < 0 ? 0 : missileMax > MAX_MISSILE_PIPS ? MAX_MISSILE_PIPS : missileMax;
    let missiles = Math.round(frame.missiles);
    missiles = missiles < 0 ? 0 : missiles > missileMax ? missileMax : missiles;
    if (missileMax !== this.vMissileMax || missiles !== this.vMissiles) {
      const previous = this.vMissiles;
      const pips = this.elMslPips;
      for (let i = 0; i < pips.length; i += 1) {
        pips[i].hidden = i >= missileMax;
        pips[i].classList.toggle('is-full', i < missiles);
      }
      if (previous < 0 || (previous === 0) !== (missiles === 0)) this.elMslRow.classList.toggle('is-empty', missiles === 0);
      if (previous >= 0 && missiles > previous && !this.reducedMotion) {
        for (let i = previous; i < missiles; i += 1) pips[i].animate(MISSILE_GAIN_KEYS, MISSILE_GAIN_TIMING);
      }
      this.vMissileMax = missileMax;
      this.vMissiles = missiles;
    }

    // Score (ticks toward the target), scrap, combo chain.
    const score = Math.max(0, Math.round(frame.score));
    if (score !== this.vScore) {
      let shown = this.vScore;
      if (this.reducedMotion || shown < 0 || score < shown) shown = score;
      else shown = Math.min(score, shown + Math.max(1, Math.ceil((score - shown) * Math.min(1, dt * 0.012))));
      this.vScore = shown;
      this.elScore.textContent = formatInt(shown);
    }
    const scrap = Math.max(0, Math.round(frame.scrap));
    if (scrap !== this.vScrap) {
      this.vScrap = scrap;
      this.elScrap.textContent = formatInt(scrap);
    }
    const combo = frame.combo;
    const comboCount = Math.max(0, Math.round(combo.count));
    if (comboCount !== this.vComboCount) {
      const previous = this.vComboCount;
      this.vComboCount = comboCount;
      if (comboCount > 0) {
        this.elComboCount.textContent = String(comboCount);
        if (previous === 0) this.showCombo();
      } else {
        this.breakCombo();
      }
    }
    if (comboCount > 0) {
      const mult = Math.round(combo.multiplier * 10) / 10;
      if (mult !== this.vComboMult) {
        const stepped = this.vComboMult > 0 && mult > this.vComboMult;
        this.vComboMult = mult;
        this.elComboMult.textContent = `×${mult}`;
        if (stepped && !this.reducedMotion) this.elComboMult.animate(COMBO_PULSE_KEYS, COMBO_PULSE_TIMING);
      }
      const timer = Math.round(clamp01(combo.timer01) * 100);
      if (timer !== this.vComboTimer) {
        const wasLow = this.vComboTimer >= 0 && this.vComboTimer < 25;
        this.vComboTimer = timer;
        this.elComboBar.style.transform = `scaleX(${timer / 100})`;
        if (wasLow !== timer < 25) this.elCombo.classList.toggle('is-low', timer < 25);
      }
    }

    // Side objectives.
    const side = frame.sideObjectives;
    const sideCount = side.length > MAX_SIDE ? MAX_SIDE : side.length;
    if (sideCount !== this.vSideCount) {
      if ((sideCount > 0) !== (this.vSideCount > 0)) this.elSide.classList.toggle('is-on', sideCount > 0);
      this.vSideCount = sideCount;
    }
    for (let i = 0; i < MAX_SIDE; i += 1) {
      const row = this.sideRows[i];
      const on = i < sideCount;
      if (on !== row.on) {
        row.on = on;
        row.el.hidden = !on;
      }
      if (!on) continue;
      const item = side[i];
      if (item.label !== row.text) {
        row.text = item.label;
        row.label.textContent = item.label;
      }
      if (item.done !== row.done) {
        row.done = item.done;
        row.el.classList.toggle('is-done', item.done);
      }
      const meters = item.done || item.distanceM === null ? -1 : Math.max(0, Math.round(item.distanceM));
      if (meters !== row.meters) {
        row.meters = meters;
        row.dist.textContent = meters < 0 ? '' : `${meters} m`;
      }
    }

    // Screen-space reticles.
    this.writeTargets(frame.targets);

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
    this.elToast.classList.toggle('is-long', text.length > TOAST_LONG_CHARS);
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

  scorePopup(label: string, value: number, kind: 'kill' | 'style' | 'pickup' | 'bonus'): void {
    const i = this.popIndex % this.popCount;
    this.popIndex = i + 1;
    const el = this.elPops[i];
    this.popLabels[i].textContent = label;
    const rounded = Math.round(value);
    this.popValues[i].textContent = rounded === 0 ? '' : `${rounded > 0 ? '+' : '−'}${formatInt(Math.abs(rounded))}`;
    el.dataset.kind = kind;
    const running = el.getAnimations();
    for (let k = 0; k < running.length; k += 1) running[k].cancel();
    el.animate(this.reducedMotion ? POPUP_STILL_KEYS : POPUP_KEYS, POPUP_TIMING);
  }

  onUpgradePick(handler: (id: string) => void): void {
    this.upgradeHandlers.push(handler);
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
    if (enabled && this.comboBreak) this.comboBreak.finish();
  }

  dispose(): void {
    this.abort.abort();
    window.clearTimeout(this.toastTimer);
    this.handlers.clear();
    this.upgradeHandlers.length = 0;
    this.setUpgradeKeys(false);
    if (this.comboBreak) this.comboBreak.cancel();
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
    this.setUpgradeKeys(mode === 'upgrade');
    if (mode === 'upgrade') {
      this.upPicked = false;
      this.setUpgradeSelection(-1);
      for (let i = 0; i < this.upCards.length; i += 1) this.upCards[i].el.classList.remove('is-picked');
      this.elUpCards.classList.remove('is-chosen');
    }
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

  private writeStats(frame: HudFrame): void {
    const stats = frame.stats;
    const nodes = this.statNodes;
    const kills = Math.round(stats.kills);
    const time = Math.floor(stats.timeSec);
    const damage = Math.round(stats.damageTaken);
    const score = Math.max(0, Math.round(stats.score));
    const combo = Math.max(0, Math.round(stats.bestCombo));
    const scrap = Math.max(0, Math.round(stats.scrap));
    if (kills !== this.vKills) {
      this.vKills = kills;
      const text = String(kills);
      for (let i = 0; i < nodes.length; i += 1) nodes[i].kills.textContent = text;
    }
    if (time !== this.vTime) {
      this.vTime = time;
      const text = formatTime(time);
      for (let i = 0; i < nodes.length; i += 1) nodes[i].time.textContent = text;
    }
    if (damage !== this.vDamage) {
      this.vDamage = damage;
      const text = formatInt(damage);
      for (let i = 0; i < nodes.length; i += 1) nodes[i].damage.textContent = text;
    }
    if (score !== this.vStatScore) {
      this.vStatScore = score;
      const text = formatInt(score);
      for (let i = 0; i < nodes.length; i += 1) nodes[i].score.textContent = text;
    }
    if (combo !== this.vStatCombo) {
      this.vStatCombo = combo;
      const text = String(combo);
      for (let i = 0; i < nodes.length; i += 1) nodes[i].combo.textContent = text;
    }
    if (scrap !== this.vStatScrap) {
      this.vStatScrap = scrap;
      const text = formatInt(scrap);
      for (let i = 0; i < nodes.length; i += 1) nodes[i].scrap.textContent = text;
    }
    if (stats.rank !== this.vRank) {
      this.vRank = stats.rank;
      const letter = stats.rank.trim().slice(0, 1).toUpperCase() || '-';
      for (let i = 0; i < nodes.length; i += 1) {
        nodes[i].rankLetter.textContent = letter;
        nodes[i].rank.dataset.rank = letter;
      }
    }
  }

  private writeUpgrade(upgrade: HudFrame['upgrade']): void {
    if (!upgrade) return;
    if (upgrade.title !== this.vUpTitle) {
      this.vUpTitle = upgrade.title;
      this.elUpTitle.textContent = upgrade.title;
    }
    if (upgrade.subtitle !== this.vUpSub) {
      this.vUpSub = upgrade.subtitle;
      this.elUpSub.textContent = upgrade.subtitle;
    }
    const options = upgrade.options;
    const count = options.length > UPGRADE_CARDS ? UPGRADE_CARDS : options.length;
    let offerChanged = false;
    if (count !== this.vUpCount) {
      this.vUpCount = count;
      offerChanged = true;
    }
    for (let i = 0; i < UPGRADE_CARDS; i += 1) {
      const card = this.upCards[i];
      const on = i < count;
      if (on !== card.on) {
        card.on = on;
        card.el.hidden = !on;
      }
      if (!on) continue;
      const option = options[i];
      if (option.id !== card.id) {
        card.id = option.id;
        offerChanged = true;
      }
      if (option.name !== card.vName) {
        card.vName = option.name;
        card.name.textContent = option.name;
      }
      if (option.description !== card.vDesc) {
        card.vDesc = option.description;
        card.desc.textContent = option.description;
      }
      if (option.icon !== card.vIcon) {
        card.vIcon = option.icon;
        card.icon.innerHTML = UPGRADE_ICONS[option.icon] ?? UPGRADE_ICONS.repair;
        card.el.dataset.icon = option.icon;
      }
      const level = Math.max(0, Math.round(option.level));
      if (level !== card.vLevel) {
        card.vLevel = level;
        card.lv.textContent = level === 0 ? 'NEW' : `Lv.${level}`;
        card.el.classList.toggle('is-new', level === 0);
        for (let k = 0; k < card.pips.length; k += 1) {
          card.pips[k].className = k < level ? 'is-full' : k === level ? 'is-next' : '';
        }
        card.el.setAttribute('aria-label', `${i + 1}: ${option.name} — ${option.description}`);
      }
    }
    // A different offer shown without leaving the mode re-arms the selection.
    if (offerChanged && this.upPicked) {
      this.upPicked = false;
      this.setUpgradeSelection(-1);
      for (let i = 0; i < UPGRADE_CARDS; i += 1) this.upCards[i].el.classList.remove('is-picked');
      this.elUpCards.classList.remove('is-chosen');
    }
  }

  private writeTargets(targets: HudTargetMarker[]): void {
    const slots = this.targetSlots;
    const count = targets.length > MAX_TARGETS ? MAX_TARGETS : targets.length;
    while (slots.length < count) this.growTargetPool();
    for (let i = 0; i < count; i += 1) {
      const marker = targets[i];
      const slot = slots[i];
      if (marker.kind !== slot.kind) {
        slot.kind = marker.kind;
        slot.el.dataset.kind = marker.kind;
        slot.value = -1;
        slot.meters = -1;
      }
      const x = Math.round(marker.sx * 2) / 2;
      const y = Math.round(marker.sy * 2) / 2;
      if (x !== slot.x || y !== slot.y) {
        slot.x = x;
        slot.y = y;
        slot.el.style.transform = `translate3d(${x}px,${y}px,0)`;
      }
      const kind = marker.kind;
      if (kind === 'aim' || kind === 'locking') {
        const value = Math.round(clamp01(marker.value01) * 50) / 50;
        if (value !== slot.value) {
          slot.value = value;
          if (kind === 'aim') {
            slot.arc.style.strokeDashoffset = String(100 - value * 100);
          } else {
            const open = 1 - value;
            slot.prog.style.strokeDashoffset = String(100 - value * 100);
            slot.ring.style.transform = `rotate(${(open * 135).toFixed(1)}deg) scale(${(1 + open * 0.9).toFixed(3)})`;
          }
        }
      } else {
        const meters = Math.max(0, Math.round(marker.distanceM));
        if (meters !== slot.meters) {
          slot.meters = meters;
          slot.dist.textContent = `${meters} m`;
        }
      }
      if (!slot.on) {
        slot.on = true;
        slot.el.classList.add('is-on');
      }
    }
    if (count < this.vTargetCount) {
      for (let i = count; i < slots.length; i += 1) {
        const slot = slots[i];
        if (!slot.on) continue;
        slot.on = false;
        slot.el.classList.remove('is-on');
      }
    }
    this.vTargetCount = count;
  }

  /** Pool growth is the only place reticle DOM is created. */
  private growTargetPool(): void {
    const source = this.targetTemplate.content.firstElementChild;
    if (!source) throw new Error('HUD target template is empty.');
    const el = source.cloneNode(true) as HTMLElement;
    const pick = <T extends Element>(selector: string): T => {
      const node = el.querySelector<T>(selector);
      if (!node) throw new Error(`HUD target template is missing "${selector}".`);
      return node;
    };
    this.targetSlots.push({
      el,
      arc: pick<SVGElement>('.tg-arc'),
      ring: pick<HTMLElement>('.tg-ring'),
      prog: pick<SVGElement>('.tg-prog'),
      dist: pick<HTMLElement>('.tg-tag i'),
      on: false,
      kind: null,
      x: Number.NaN,
      y: Number.NaN,
      value: -1,
      meters: -1,
    });
    this.elTargets.appendChild(el);
  }

  private showCombo(): void {
    if (this.comboBreak) {
      this.comboBreak.cancel();
      this.comboBreak = null;
    }
    this.vComboMult = -1;
    this.vComboTimer = -1;
    this.elCombo.classList.remove('is-broken', 'is-low');
    this.elCombo.classList.add('is-on');
  }

  private breakCombo(): void {
    if (this.reducedMotion) {
      this.elCombo.classList.remove('is-on', 'is-low');
      return;
    }
    this.elCombo.classList.add('is-broken');
    const anim = this.elCombo.animate(COMBO_BREAK_KEYS, COMBO_BREAK_TIMING);
    this.comboBreak = anim;
    anim.onfinish = this.onComboBreakEnd;
  }

  private readonly onComboBreakEnd = (): void => {
    this.comboBreak = null;
    if (this.vComboCount === 0) this.elCombo.classList.remove('is-on', 'is-broken', 'is-low');
  };

  private setUpgradeKeys(enabled: boolean): void {
    if (enabled === this.upgradeKeysOn) return;
    this.upgradeKeysOn = enabled;
    if (enabled) window.addEventListener('keydown', this.onUpgradeKey, { signal: this.abort.signal });
    else window.removeEventListener('keydown', this.onUpgradeKey);
  }

  private setUpgradeSelection(index: number): void {
    if (index === this.upSel) return;
    if (this.upSel >= 0) this.upCards[this.upSel].el.classList.remove('is-sel');
    this.upSel = index;
    if (index >= 0) this.upCards[index].el.classList.add('is-sel');
  }

  private pickUpgrade(index: number): void {
    if (this.mode !== 'upgrade' || this.upPicked) return;
    const card = this.upCards[index];
    if (!card || !card.on || card.id === null) return;
    this.upPicked = true;
    this.setUpgradeSelection(index);
    card.el.classList.add('is-picked');
    this.elUpCards.classList.add('is-chosen');
    const id = card.id;
    const list = this.upgradeHandlers;
    for (let i = 0; i < list.length; i += 1) list[i](id);
  }

  private readonly onUpgradeKey = (e: KeyboardEvent): void => {
    if (this.mode !== 'upgrade' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const count = this.vUpCount;
    if (count <= 0) return;
    const code = e.code;
    let digit = -1;
    if (e.key === '1' || code === 'Digit1' || code === 'Numpad1') digit = 0;
    else if (e.key === '2' || code === 'Digit2' || code === 'Numpad2') digit = 1;
    else if (e.key === '3' || code === 'Digit3' || code === 'Numpad3') digit = 2;
    if (digit >= 0) {
      e.preventDefault();
      if (digit < count) this.pickUpgrade(digit);
      return;
    }
    const key = e.key;
    if (key === 'ArrowRight' || key === 'ArrowDown') {
      e.preventDefault();
      if (!this.upPicked) this.setUpgradeSelection(this.upSel < 0 ? 0 : (this.upSel + 1) % count);
    } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
      e.preventDefault();
      if (!this.upPicked) this.setUpgradeSelection(this.upSel < 0 ? count - 1 : (this.upSel + count - 1) % count);
    } else if (key === 'Enter') {
      // Always swallowed so a focused button never turns Enter into a second click.
      e.preventDefault();
      if (this.upSel >= 0) this.pickUpgrade(this.upSel);
    }
  };

  /** Layout reads live here, never in update(). */
  private measure(): void {
    this.minimap.resize();
    const width = this.elCpWindow.clientWidth;
    // Keep the clamped chevron inside the un-faded part of the tape (mask fades the outer 16%).
    if (width > 0) this.compassHalfDeg = Math.max(10, (width * 0.31) / COMPASS_PX_PER_DEG);
    this.vObjX = Number.NaN;
    // Compact layouts only have room for three callout rows.
    this.popCount = window.matchMedia('(max-width: 720px), (max-height: 520px)').matches ? 3 : this.elPops.length;
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
    const origin = e.target instanceof Element ? e.target : null;
    const card = origin ? origin.closest<HTMLElement>('[data-up]') : null;
    if (card) {
      card.blur();
      this.pickUpgrade(Number(card.dataset.up));
      return;
    }
    const target = origin ? origin.closest<HTMLElement>('[data-act]') : null;
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
