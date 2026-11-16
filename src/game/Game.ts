import * as THREE from 'three';
import { createHeroCar } from '../assets/modelFactories/VehicleModels';
import { InputController } from '../core/InputController';
import { Loop } from '../core/Loop';
import { Enemy, type EnemyHost, type EnemyKind } from '../entities/Enemy';
import { HERO_TUNING, Vehicle, collideVehicles, wrapAngle } from '../entities/Vehicle';
import { AshField } from '../systems/AshField';
import { Atmosphere } from '../systems/Atmosphere';
import { AudioSystem } from '../systems/AudioSystem';
import { CameraRig } from '../systems/CameraRig';
import { RenderPipeline } from '../systems/RenderPipeline';
import { VfxSystem } from '../systems/VfxSystem';
import { Hud } from '../ui/Hud';
import { createSeededRandom } from '../utils/random';
import { type CityWorld, type RelayTower, buildCity, buildRelayTower } from '../world/CityBuilder';
import { CITY, CITY_HALF, ColliderGrid, type CityLayout, PLAY_HALF, generateCity, groundHeight, roadCenter } from '../world/CityLayout';
import type { HudBlip, HudFrame, HudMode, SfxName } from './contracts';

type Phase = 'title' | 'drive' | 'event' | 'battle' | 'victory' | 'failed' | 'complete';
type BattleStage = 'none' | 'wave1' | 'wave2' | 'boss' | 'done';

type Projectile = {
  active: boolean;
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  speed: number;
  life: number;
  damage: number;
  player: boolean;
  tracer: number;
  ox: number; oz: number;
};

type Mortar = { active: boolean; x: number; z: number; timer: number; total: number; sx: number; sy: number; sz: number };

type Cue = { at: number; run: () => void };

const CITY_SEED = 20771;
const MAX_ARMOR = 100;
const PLAYER_RADIUS = 1.35;
const MORTAR_RADIUS = 9;
const EVENT_LENGTH = 15.5;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(58, 1, 0.3, 6000);
  private readonly lowSpec: boolean;
  private readonly maxDpr: number;
  private readonly input: InputController;
  private readonly audio = new AudioSystem();
  private readonly hud = new Hud();
  private readonly cameraRig = new CameraRig(this.camera);
  private readonly loop = new Loop(
    (delta, elapsed) => this.update(delta, elapsed),
    () => this.render(),
  );

  private readonly layout: CityLayout;
  private readonly grid: ColliderGrid;
  private readonly world: CityWorld;
  private readonly relay: RelayTower;
  private readonly atmosphere: Atmosphere;
  private readonly pipeline: RenderPipeline;
  private readonly vfx: VfxSystem;
  private readonly ash: AshField;
  private readonly player: Vehicle;
  private readonly headlight: THREE.SpotLight;
  private readonly fireLights: THREE.PointLight[] = [];
  private fireLightTimer = 0;

  private readonly enemies: Enemy[] = [];
  private readonly projectiles: Projectile[] = [];
  private readonly mortars: Mortar[] = [];
  private readonly cues: Cue[] = [];
  private readonly host: EnemyHost;

  // Route ALL gameplay randomness through this.rng so seeded test runs are reproducible.
  private rng = createSeededRandom(1);
  private phase: Phase = 'title';
  private stage: BattleStage = 'none';
  private paused = false;
  private pausedForScreenshot = false;
  private reducedMotion = false;
  private frame = 0;
  private time = 0;
  private clock = 0;
  private runTime = 0;
  private eventTime = 0;
  private stageTimer = 0;
  private timeScale = 1;
  private hitStop = 0;
  private impactFx = 0;

  private armor = MAX_ARMOR;
  private boost = 1;
  private boostLock = 0;
  private boosting = false;
  private heat = 0;
  private overheated = false;
  private fireTimer = 0;
  private muzzleIndex = 0;
  private turretYaw = 0;
  private aimTarget: Enemy | null = null;
  private relayPower = 0;
  private kills = 0;
  private readonly damageBy = { shot: 0, ram: 0, mortar: 0, wall: 0 };
  private damageTaken = 0;
  private scout: Enemy | null = null;
  private scoutState: 'pending' | 'active' | 'done' = 'pending';
  private boss: Enemy | null = null;
  private checkpoint: 'start' | 'battle' = 'start';
  private checkpointStage: BattleStage = 'wave1';
  private flavour = 0;
  private dustTimer = 0;
  private exhaustTimer = 0;
  private fireEmit = 0;
  private objectiveTitle = '';
  private objectiveDetail = '';
  private readonly blips: HudBlip[] = [];
  private readonly hudFrame: HudFrame;
  private viewW = 0;
  private viewH = 0;
  private viewDpr = 0;
  private readonly adaptive: boolean;
  private readonly forcedSafeLevel: number;
  private renderVerified = false;
  private blackFrames = 0;
  private lastBrightest = -1;
  private probe: Uint8Array | null = null;
  private resolutionScale = 1;
  private slowTime = 0;
  private fastTime = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const quality = new URLSearchParams(window.location.search).get('quality');
    this.lowSpec = quality === 'low' || (quality !== 'high' && (window.matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 520));
    this.maxDpr = this.lowSpec ? 1.25 : 1.5;
    this.adaptive = quality === null;
    this.forcedSafeLevel = Number(new URLSearchParams(window.location.search).get('safe') ?? 0) || 0;
    this.hud.setLoadingProgress(0.1);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor('#1a1416');
    this.renderer.info.autoReset = false;

    this.input = new InputController(canvas);

    // ---- world
    this.layout = generateCity(CITY_SEED);
    this.grid = new ColliderGrid(this.layout.colliders);
    this.world = buildCity(this.layout);
    this.scene.add(this.world.group);
    if (this.lowSpec) {
      // small repeated props are the bulk of the shadow pass; towers and wrecks keep theirs
      for (const child of this.world.group.children) {
        if (/^(rubble|lamps|barrels|barriers)/.test(child.name)) child.castShadow = false;
      }
    }
    this.relay = buildRelayTower(this.layout.relay);
    this.scene.add(this.relay.group);
    this.atmosphere = new Atmosphere(this.scene, this.renderer, this.lowSpec);
    this.pipeline = new RenderPipeline(this.renderer, this.scene, this.camera, this.lowSpec);
    if (this.forcedSafeLevel > 0) this.pipeline.setSafeLevel(this.forcedSafeLevel);
    // test switch: blank the post chain so the automatic fallback can be exercised
    if (new URLSearchParams(window.location.search).has('debugBlack')) this.pipeline.setExposure(0);
    this.vfx = new VfxSystem(this.lowSpec);
    this.scene.add(this.vfx.group);
    this.ash = new AshField(this.lowSpec ? 700 : 1600);
    this.scene.add(this.ash.points);

    for (let i = 0; i < (this.lowSpec ? 2 : 3); i += 1) {
      const light = new THREE.PointLight('#ff8a3c', 0, 42, 1.7);
      this.fireLights.push(light);
      this.scene.add(light);
    }

    // ---- player
    this.player = new Vehicle(createHeroCar(), HERO_TUNING);
    this.scene.add(this.player.model.root);
    this.headlight = new THREE.SpotLight('#ffe2b8', 520, 85, 0.5, 0.65, 1.5);
    this.headlight.position.set(0, 0.95, 1.9);
    this.headlight.target.position.set(0, -0.4, 22);
    this.player.model.root.add(this.headlight, this.headlight.target);

    for (let i = 0; i < 96; i += 1) {
      this.projectiles.push({ active: false, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, speed: 0, life: 0, damage: 0, player: true, tracer: -1, ox: 0, oz: 0 });
    }
    for (let i = 0; i < 6; i += 1) this.mortars.push({ active: false, x: 0, z: 0, timer: 0, total: 1, sx: 0, sy: 0, sz: 0 });

    this.host = {
      rng: () => this.rng(),
      grid: this.grid,
      player: this.player,
      enemyShot: (enemy, muzzle, tx, ty, tz, spread, damage) => this.enemyShot(enemy, muzzle, tx, ty, tz, spread, damage),
      mortar: (enemy, tx, tz, delay) => this.launchMortar(enemy, tx, tz, delay),
      telegraphSound: (enemy) => this.sfxAt('alarm', enemy.vehicle.x, enemy.vehicle.z, 0.16, 1.7),
    };

    this.hudFrame = {
      mode: 'loading',
      speedKmh: 0, rpm01: 0, armor01: 1, boost01: 1, boostActive: false, heat01: 0, overheated: false,
      headingRad: 0,
      player: { x: 0, z: 0 },
      objective: { title: '', detail: '', distanceM: null, position: null },
      blips: this.blips,
      enemiesRemaining: null,
      boss: null,
      elapsed: 0,
      stats: { kills: 0, timeSec: 0, damageTaken: 0 },
    };
    // The HUD's map convention has +X to the east/right; this world's +X is to the
    // driver's left when facing +Z, so every HUD coordinate mirrors X.
    this.hud.setMinimapWorld({
      halfExtent: PLAY_HALF,
      roadCenters: this.layout.roadCenters,
      roadWidth: CITY.roadWidth,
      landmarks: [
        { x: -this.layout.relay.x, z: this.layout.relay.z, kind: 'relay' },
        { x: -roadCenter(5), z: 0, kind: 'highway' },
        { x: -this.layout.start.x, z: this.layout.start.z, kind: 'start' },
      ],
    });
    this.hud.on('start', () => this.startRun());
    this.hud.on('resume', () => this.setPaused(false));
    this.hud.on('retry', () => this.retry());
    this.hud.on('restart', () => this.startRun());
    this.hud.on('pauseToggle', () => this.setPaused(!this.paused));
    this.hud.on('muteToggle', () => this.toggleMute());
    document.addEventListener('visibilitychange', this.onVisibility);

    this.hud.setLoadingProgress(0.8);
    this.resize();
    this.enterTitle();
    this.renderer.compile(this.scene, this.camera);
    this.hud.setLoadingProgress(1);
    this.installTestHooks();
    this.publishDiagnostics();
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.input.dispose();
    this.audio.dispose();
    this.hud.dispose();
    this.clearEnemies();
    this.world.dispose();
    this.atmosphere.dispose();
    this.pipeline.dispose();
    this.vfx.dispose();
    this.ash.dispose();
    this.renderer.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  private readonly onVisibility = () => {
    if (document.hidden && !this.paused && (this.phase === 'drive' || this.phase === 'battle')) this.setPaused(true);
    else if (document.hidden) this.audio.pause();
    else if (!this.paused) this.audio.resume();
  };

  // ================================================================ flow

  private enterTitle(): void {
    this.resetRunState();
    this.phase = 'title';
    this.player.place(this.layout.start.x, this.layout.start.z, this.layout.start.heading);
    this.audio.setMusicState('title');
  }

  private resetRunState(): void {
    this.clearEnemies();
    for (const p of this.projectiles) {
      if (p.active) this.vfx.killTracer(p.tracer);
      p.active = false;
    }
    for (const m of this.mortars) m.active = false;
    this.vfx.clear();
    this.cues.length = 0;
    this.hud.clearDialogue();
    this.stage = 'none';
    this.paused = false;
    this.clock = 0;
    this.runTime = 0;
    this.eventTime = 0;
    this.stageTimer = 0;
    this.timeScale = 1;
    this.hitStop = 0;
    this.armor = MAX_ARMOR;
    this.boost = 1;
    this.heat = 0;
    this.overheated = false;
    this.kills = 0;
    this.damageTaken = 0;
    this.scout = null;
    this.scoutState = 'pending';
    this.boss = null;
    this.checkpoint = 'start';
    this.flavour = 0;
    this.relayPower = 0;
    this.relay.setPower(0);
    this.player.model.setDamage(0);
    this.player.controls.throttle = 0;
    this.player.controls.steer = 0;
    this.player.controls.boost = false;
    this.player.controls.handbrake = false;
  }

  private startRun(): void {
    // the start button and the Enter key can both fire for one press
    if (this.phase === 'drive' && this.clock < 0.4) return;
    this.audio.unlock();
    this.audio.resume();
    this.resetRunState();
    this.phase = 'drive';
    this.player.place(this.layout.start.x, this.layout.start.z, this.layout.start.heading);
    this.turretYaw = this.player.heading;
    this.cameraRig.snapTo(this.player);
    this.setObjective('第7中継塔へ向かえ', '光柱を目印に灰都を抜けろ');
    this.audio.setMusicState('explore');
    this.audio.play('uiConfirm');
    this.say(1.4, 'ミラ', '聞こえる？ケストレル。第7中継塔はまだ生きてる。日没までに辿り着いて。', 5.5);
    this.say(8.5, 'ミラ', '灰が濃いわ。空へ伸びる光柱を目印にして。', 4.5);
  }

  private retry(): void {
    if (this.checkpoint !== 'battle') {
      this.startRun();
      return;
    }
    const kills = this.kills;
    const stage = this.checkpointStage;
    this.audio.resume();
    this.resetRunState();
    this.kills = kills;
    this.checkpoint = 'battle';
    this.scoutState = 'done';
    this.relayPower = 1;
    this.relay.setPower(1);
    this.phase = 'battle';
    this.player.place(this.layout.relay.x + 3, this.layout.relay.z - 52, 0);
    this.turretYaw = 0;
    this.cameraRig.snapTo(this.player);
    this.beginStage(stage);
  }

  private setPaused(paused: boolean): void {
    if (this.phase !== 'drive' && this.phase !== 'battle' && this.phase !== 'event') return;
    if (this.paused === paused) return;
    this.paused = paused;
    this.audio.play('uiClick');
    if (paused) this.audio.pause();
    else this.audio.resume();
  }

  private toggleMute(): void {
    this.audio.unlock();
    this.audio.setMuted(!this.audio.muted);
    this.hud.setMuted(this.audio.muted);
  }

  private setObjective(title: string, detail: string): void {
    if (title !== this.objectiveTitle && this.phase !== 'title') this.audio.play('objective', { volume: 0.7 });
    this.objectiveTitle = title;
    this.objectiveDetail = detail;
  }

  private cue(delay: number, run: () => void): void {
    this.cues.push({ at: this.clock + delay, run });
  }

  private say(delay: number, speaker: string, text: string, seconds: number): void {
    this.cue(delay, () => {
      this.audio.play('radioOpen', { volume: 0.6 });
      this.hud.showDialogue(speaker, text, seconds);
    });
  }

  // ================================================================ frame

  private update(delta: number, elapsed: number): void {
    this.frame += 1;
    this.adaptResolution(delta);
    this.resize();
    if (this.pausedForScreenshot) {
      this.input.endFrame();
      this.pushHud();
      this.publishDiagnostics();
      return;
    }
    this.time = elapsed;
    this.handleMenuKeys();
    const intents = this.input.update(delta, this.hud.touch);

    if (!this.paused) {
      if (this.hitStop > 0) {
        this.hitStop -= delta;
      } else {
        this.timeScale += (1 - this.timeScale) * Math.min(1, delta * 1.4);
        const dt = Math.min(delta, 1 / 20) * this.timeScale;
        this.applyPlayerIntents(intents.steer, intents.throttle, intents.fire, intents.boost, intents.handbrake, dt);
        this.stepSim(dt);
        this.updateCamera(dt);
      }
    }
    this.updateAudio();
    this.updateAmbient(delta);
    this.pushHud();
    this.publishDiagnostics();
    this.input.endFrame();
  }

  private handleMenuKeys(): void {
    const confirm = this.input.consume('Enter', 'NumpadEnter');
    if (this.input.consume('KeyM')) this.toggleMute();
    if (this.input.consume('Escape', 'KeyP')) this.setPaused(!this.paused);
    if (!confirm) return;
    if (this.phase === 'title' || this.phase === 'complete') this.startRun();
    else if (this.phase === 'failed') this.retry();
    else if (this.paused) this.setPaused(false);
    else if (this.phase === 'event' && this.eventTime > 1.2) this.skipEvent();
  }

  private applyPlayerIntents(steer: number, throttle: number, fire: boolean, boost: boolean, handbrake: boolean, dt: number): void {
    const c = this.player.controls;
    if (this.phase !== 'drive' && this.phase !== 'battle') {
      c.steer = 0;
      c.throttle = 0;
      c.boost = false;
      c.handbrake = this.phase !== 'title' && this.player.speed > 0.5;
      if (this.phase === 'event' || this.phase === 'failed') {
        // roll to a controlled stop
        if (this.player.forwardSpeed > 0.5) c.throttle = -0.7;
        c.handbrake = false;
      }
      this.boosting = false;
      this.coolWeapon(dt);
      return;
    }
    c.steer = steer;
    c.throttle = throttle;
    c.handbrake = handbrake;

    // boost: drains while held, recharges after a short lockout
    const wantsBoost = boost && throttle > 0 && this.boost > 0.02;
    if (wantsBoost && !this.boosting) {
      if (this.boost > 0.15) {
        this.boosting = true;
        this.audio.play('boostStart', { volume: 0.8 });
        this.cameraRig.addTrauma(0.12);
      }
    } else if (!wantsBoost) {
      this.boosting = false;
    }
    if (this.boosting) {
      this.boost = Math.max(0, this.boost - dt * 0.3);
      this.boostLock = 0.9;
    } else {
      this.boostLock -= dt;
      if (this.boostLock <= 0) this.boost = Math.min(1, this.boost + dt * 0.14);
    }
    c.boost = this.boosting;
    this.updateWeapon(fire, dt);
  }

  private coolWeapon(dt: number): void {
    this.heat = Math.max(0, this.heat - dt * 0.4);
    if (this.overheated && this.heat < 0.3) this.overheated = false;
  }

  /** One deterministic simulation step. Everything gameplay-relevant lives here. */
  private stepSim(dt: number): void {
    if (dt <= 0) return;
    this.clock += dt;
    if (this.phase === 'drive' || this.phase === 'battle') this.runTime += dt;

    for (let i = this.cues.length - 1; i >= 0; i -= 1) {
      if (this.cues[i].at <= this.clock) {
        const cue = this.cues[i];
        this.cues.splice(i, 1);
        cue.run();
      }
    }
    this.updateMission(dt);

    this.player.impact = 0;
    for (const enemy of this.enemies) enemy.vehicle.impact = 0;
    const sub = 2;
    const h = dt / sub;
    for (let s = 0; s < sub; s += 1) {
      this.player.step(h, this.grid);
      for (const enemy of this.enemies) enemy.vehicle.step(h, this.grid);
      this.resolveVehicleContacts();
    }
    this.handlePlayerImpact();

    const simulateAi = this.phase === 'drive' || this.phase === 'battle' || this.phase === 'event';
    for (let i = this.enemies.length - 1; i >= 0; i -= 1) {
      const enemy = this.enemies[i];
      const v = enemy.vehicle;
      if (enemy.alive) {
        if (simulateAi) enemy.think(dt, this.host);
        else {
          v.controls.throttle = 0;
          v.controls.steer = 0;
        }
        if (v.impact > 8) this.vfx.sparks(v.x - v.impactNx, 0.8, v.z - v.impactNz, v.impactNx, 0.4, v.impactNz, 6);
        const hurt = enemy.health / enemy.maxHealth;
        if (hurt < 0.5 && this.rng() < dt * 14) this.vfx.damageSmoke(v.x, v.y + 1.4, v.z, hurt < 0.25);
      } else {
        enemy.deadFor += dt;
        v.controls.throttle = 0;
        v.controls.boost = false;
        v.controls.handbrake = true;
        if (enemy.deadFor < 6 && this.rng() < dt * 22) {
          this.vfx.fire(v.x + (this.rng() - 0.5) * 1.6, v.y + 1.2, v.z + (this.rng() - 0.5) * 1.6, enemy.kind === 'rig' ? 1.8 : 1.1);
        }
        if (enemy.deadFor > 9) {
          this.removeEnemy(enemy);
          this.enemies.splice(i, 1);
          continue;
        }
      }
      v.syncVisual(dt);
    }
    this.player.syncVisual(dt);
    this.updateAim(dt);
    this.updateProjectiles(dt);
    this.updateMortars(dt);
    this.updatePlayerFx(dt);
    this.vfx.update(dt, this.time, groundHeight);
    this.impactFx = Math.max(0, this.impactFx - dt * 3.2);
  }

  // ================================================================ mission

  private relayDistance(): number {
    return Math.hypot(this.player.x - this.layout.relay.x, this.player.z - this.layout.relay.z);
  }

  private updateMission(dt: number): void {
    if (this.phase === 'drive') {
      const dist = this.relayDistance();
      if (this.scoutState === 'pending' && this.clock > 12 && dist < 640 && this.player.speed > 12) this.spawnScout();
      if (this.scoutState === 'active' && this.scout && !this.scout.alive) {
        this.scoutState = 'done';
        this.scout = null;
        this.setObjective('第7中継塔へ向かえ', '光柱を目印に灰都を抜けろ');
        this.say(0.8, 'ミラ', 'いい腕ね。……でも斥候がいたなら、本隊も近い。急いで。', 4.5);
      }
      if (this.flavour === 0 && dist < 380) {
        this.flavour = 1;
        this.say(0, 'ミラ', 'あと少し。……妙ね、周波数にノイズが乗ってる。', 4.5);
      }
      if (dist < 36 && this.scoutState !== 'active') this.startEvent();
    } else if (this.phase === 'event') {
      this.updateEvent(dt);
    } else if (this.phase === 'battle') {
      this.updateBattle(dt);
    } else if (this.phase === 'victory') {
      this.stageTimer -= dt;
      if (this.stageTimer <= 0) {
        this.phase = 'complete';
        this.audio.play('uiConfirm');
      }
    } else if (this.phase === 'failed') {
      this.stageTimer -= dt;
    }
  }

  private spawnScout(): void {
    const p = this.player;
    const spot = this.roadPointNear(p.x - Math.sin(p.heading) * 115, p.z - Math.cos(p.heading) * 115);
    if (Math.hypot(spot.x - p.x, spot.z - p.z) < 70) return;
    this.scoutState = 'active';
    this.scout = this.spawnEnemy('gunner', 0, spot.x, spot.z, Math.atan2(p.x - spot.x, p.z - spot.z), 1);
    this.scout.vehicle.vx = Math.sin(this.scout.vehicle.heading) * 30;
    this.scout.vehicle.vz = Math.cos(this.scout.vehicle.heading) * 30;
    this.setObjective('斥候を撃破せよ', 'Space／FIRE：機関砲');
    this.audio.play('alarm', { volume: 0.5 });
    this.hud.toast('敵影接近', 'warning');
    this.say(0.2, 'ミラ', '後ろ！錆牙団の斥候よ。機関砲で落として！', 4.5);
    this.audio.setMusicState('battle');
    this.cue(0.1, () => undefined);
  }

  /** Snap a point to the nearest street centre-line (offset into a lane, clear of the highway piers). */
  private roadPointNear(x: number, z: number): { x: number; z: number } {
    const clamp = (value: number) => Math.max(-CITY_HALF + 20, Math.min(CITY_HALF - 20, value));
    const nearest = (value: number) => Math.round((value + CITY_HALF) / CITY.pitch) * CITY.pitch - CITY_HALF;
    const rx = nearest(x);
    const rz = nearest(z);
    if (Math.abs(x - rx) < Math.abs(z - rz)) return { x: rx + 6, z: clamp(z) };
    return { x: clamp(x), z: rz + 6 };
  }

  private startEvent(): void {
    this.phase = 'event';
    this.eventTime = 0;
    this.hud.clearDialogue();
    this.cues.length = 0;
    this.setObjective('第7中継塔 再起動', '');
    this.audio.setMusicState('event');
    this.audio.play('objective');
    this.say(0.6, 'ミラ', '着いたのね、ケストレル。塔の基部に端末がある。起動信号を送って。', 4.2);
    this.cue(5.0, () => this.audio.play('relayPowerUp'));
    this.say(5.6, 'ミラ', '……搬送波、確認。第7中継塔、再起動。灰都に声が戻る。', 4.2);
    this.cue(6.6, () => this.relayPulse());
    this.cue(7.8, () => this.relayPulse());
    this.cue(10.0, () => this.eventAmbush());
    this.say(10.4, 'ミラ', '待って……熱源多数。錆牙団よ、電波に釣られたわ！', 3.0);
    this.say(13.4, 'ケストレル', '……望むところだ。', 2.2);
  }

  private relayPulse(): void {
    const { x, z } = this.layout.relay;
    this.vfx.pulse(x, CITY.curbHeight + 0.4, z, 70, 1.6, '#38f5d8');
    this.cameraRig.addTrauma(0.25);
  }

  private eventAmbush(): void {
    this.audio.play('alarm');
    this.audio.setMusicState('battle');
    this.spawnWave('wave1');
    for (const enemy of this.enemies) enemy.holdFire(EVENT_LENGTH - 10 + 1.5);
  }

  private updateEvent(dt: number): void {
    this.eventTime += dt;
    const t = this.eventTime;
    if (t > 5) this.relayPower = Math.min(1, this.relayPower + dt / 3);
    this.relay.setPower(this.relayPower);
    if (t >= EVENT_LENGTH) this.endEvent();
  }

  private skipEvent(): void {
    this.hud.clearDialogue();
    this.cues.length = 0;
    this.relayPower = 1;
    this.relay.setPower(1);
    if (this.enemies.length === 0) this.eventAmbush();
    this.endEvent();
  }

  private endEvent(): void {
    this.phase = 'battle';
    this.relayPower = 1;
    this.relay.setPower(1);
    this.checkpoint = 'battle';
    this.cameraRig.snapTo(this.player);
    this.beginStage('wave1', false);
  }

  private beginStage(stage: BattleStage, spawn = true): void {
    this.stage = stage;
    this.checkpointStage = stage;
    this.stageTimer = 0;
    if (stage === 'wave1') {
      if (spawn) this.spawnWave('wave1');
      this.setObjective('中継塔を防衛せよ', 'WAVE 1／2 ── 錆牙団を殲滅');
      this.hud.toast('襲撃 ── WAVE 1', 'warning');
      this.audio.setMusicState('battle');
    } else if (stage === 'wave2') {
      if (spawn) this.spawnWave('wave2');
      this.setObjective('中継塔を防衛せよ', 'WAVE 2／2 ── 錆牙団を殲滅');
      this.hud.toast('増援 ── WAVE 2', 'warning');
      this.audio.play('alarm', { volume: 0.7 });
      this.audio.setMusicState('battle');
      this.say(0.4, 'ミラ', '第二波、四方から来る！ブーストで囲みを抜けて！', 4);
    } else if (stage === 'boss') {
      if (spawn) this.spawnWave('boss');
      this.setObjective('ジャガーノートを破壊せよ', '赤い着弾円から離れろ');
      this.hud.toast('WARNING ── 重装車両', 'warning');
      this.audio.play('alarm');
      this.audio.setMusicState('boss');
      this.say(0.4, 'ミラ', '大型反応……ウォーリグ《ジャガーノート》！迫撃砲が来る、赤い円から離れて！', 5.5);
    }
  }

  private spawnWave(stage: BattleStage): void {
    const r = this.layout.relay;
    const half = CITY.pitch / 2;
    // junctions and street mouths around the plaza block
    const gates: [number, number][] = [
      [r.x - half + 6, r.z - 175], [r.x + half - 6, r.z + 175], [r.x - 175, r.z - half + 6], [r.x + 175, r.z + half - 6],
      [r.x + half + 6, r.z - 175], [r.x - half - 6, r.z + 175],
    ];
    const add = (kind: EnemyKind, variant: number, gate: number, flank: number, back = 0) => {
      const [gx, gz] = gates[gate % gates.length];
      const heading = Math.atan2(r.x - gx, r.z - gz);
      const x = gx - Math.sin(heading) * back;
      const z = gz - Math.cos(heading) * back;
      const enemy = this.spawnEnemy(kind, variant, x, z, heading, flank);
      enemy.vehicle.vx = Math.sin(heading) * 22;
      enemy.vehicle.vz = Math.cos(heading) * 22;
      return enemy;
    };
    if (stage === 'wave1') {
      add('gunner', 0, 0, 1);
      add('gunner', 2, 2, -1);
      add('rammer', 1, 1, 1);
    } else if (stage === 'wave2') {
      add('gunner', 0, 3, 1);
      add('gunner', 2, 4, -1);
      add('rammer', 1, 5, 1, 60);
      add('rammer', 1, 0, -1, 130);
    } else if (stage === 'boss') {
      this.boss = add('rig', 0, 1, 1);
      add('gunner', 0, 2, 1, 40);
      add('gunner', 2, 3, -1, 90);
    }
  }

  private updateBattle(dt: number): void {
    let alive = 0;
    for (const enemy of this.enemies) if (enemy.alive) alive += 1;
    if (this.stage === 'boss' && this.boss) {
      if (this.boss.alive && !this.boss.enraged && this.boss.health < this.boss.maxHealth * 0.5) {
        this.boss.enraged = true;
        this.hud.toast('ジャガーノート 激昂', 'warning');
        this.audio.play('alarm', { volume: 0.8 });
        this.say(0.3, 'ミラ', '装甲が剥がれた！でも砲撃が激しくなる、止まらないで！', 4);
        const r = this.layout.relay;
        const a = this.spawnEnemy('rammer', 1, r.x - 175, r.z - CITY.pitch / 2 + 6, Math.PI / 2, 1);
        const b = this.spawnEnemy('rammer', 1, r.x + 175, r.z + CITY.pitch / 2 - 6, -Math.PI / 2, -1);
        a.vehicle.vx = 20;
        b.vehicle.vx = -20;
      }
      if (!this.boss.alive) {
        this.winBattle();
        return;
      }
    }
    if (alive > 0 || this.stage === 'boss' || this.stage === 'done') return;
    // wave cleared: brief breather with a field repair, then escalate
    if (this.stageTimer === 0) {
      this.stageTimer = 4.2;
      const repaired = Math.min(MAX_ARMOR, this.armor + 45);
      if (repaired > this.armor) {
        this.armor = repaired;
        this.player.model.setDamage(1 - this.armor / MAX_ARMOR);
        this.audio.play('repair');
      }
      this.hud.toast('WAVE CLEAR ── 応急修理', 'success');
      this.audio.setMusicState('explore');
      return;
    }
    this.stageTimer -= dt;
    if (this.stageTimer <= 0) this.beginStage(this.stage === 'wave1' ? 'wave2' : 'boss');
  }

  private winBattle(): void {
    this.stage = 'done';
    this.phase = 'victory';
    this.stageTimer = 9;
    this.timeScale = 0.28;
    for (const enemy of this.enemies) {
      if (enemy.alive) this.cue(0.4 + this.rng() * 1.2, () => this.destroyEnemy(enemy));
    }
    this.setObjective('任務完了', '第7中継塔 確保');
    this.audio.setMusicState('victory');
    this.hud.toast('ジャガーノート 撃破', 'success');
    this.say(2.6, 'ミラ', '……やった。中継塔は無事よ。ありがとう、ケストレル。次の塔の座標を送るわ──', 5.5);
  }

  // ================================================================ enemies

  private spawnEnemy(kind: EnemyKind, variant: number, x: number, z: number, heading: number, flank: number): Enemy {
    const enemy = new Enemy(kind, variant, flank, this.rng() * 1.5);
    enemy.vehicle.place(x, z, heading);
    this.scene.add(enemy.vehicle.model.root);
    this.enemies.push(enemy);
    return enemy;
  }

  private removeEnemy(enemy: Enemy): void {
    const root = enemy.vehicle.model.root;
    this.scene.remove(root);
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    if (this.aimTarget === enemy) this.aimTarget = null;
  }

  private clearEnemies(): void {
    for (const enemy of this.enemies) this.removeEnemy(enemy);
    this.enemies.length = 0;
    this.boss = null;
    this.scout = null;
    this.aimTarget = null;
  }

  private damageEnemy(enemy: Enemy, amount: number): void {
    if (!enemy.alive) return;
    enemy.health -= amount;
    enemy.vehicle.model.setDamage(1 - Math.max(0, enemy.health) / enemy.maxHealth);
    if (enemy.health <= 0) this.destroyEnemy(enemy);
  }

  private destroyEnemy(enemy: Enemy): void {
    if (!enemy.alive) return;
    enemy.alive = false;
    enemy.health = 0;
    enemy.telegraph = 0;
    const v = enemy.vehicle;
    const model = v.model;
    model.setDamage(1);
    model.accentMaterial.emissiveIntensity = 0;
    model.headlightMaterial.emissiveIntensity = 0;
    model.tailLightMaterial.emissiveIntensity = 0;
    const big = enemy.kind === 'rig';
    this.vfx.explosion(v.x, v.y, v.z, big ? 2.4 : 1.1);
    this.sfxAt(big ? 'explosionBig' : 'explosionSmall', v.x, v.z, 1, 1);
    if (big) {
      for (let n = 1; n <= 3; n += 1) {
        this.cue(n * 0.32, () => {
          this.vfx.explosion(v.x + (this.rng() - 0.5) * 6, v.y, v.z + (this.rng() - 0.5) * 6, 1.5);
          this.sfxAt('explosionBig', v.x, v.z, 0.9, 1);
          this.cameraRig.addTrauma(0.5);
        });
      }
    }
    const dist = Math.hypot(v.x - this.player.x, v.z - this.player.z);
    this.cameraRig.addTrauma(Math.max(0.15, (big ? 0.9 : 0.55) * (1 - dist / 140)));
    this.hitStop = big ? 0.16 : 0.06;
    this.impactFx = Math.min(1, this.impactFx + (big ? 1 : 0.45));
    this.kills += 1;
    this.hud.hitMarker(true);
  }

  private resolveVehicleContacts(): void {
    const p = this.player;
    for (let i = 0; i < this.enemies.length; i += 1) {
      const enemy = this.enemies[i];
      const closing = collideVehicles(p, enemy.vehicle, PLAYER_RADIUS, enemy.bodyRadius);
      if (closing > 5 && enemy.alive && enemy.ramCooldown <= 0) {
        enemy.ramCooldown = 0.7;
        const rig = enemy.kind === 'rig';
        const playerDriven = Math.abs(p.forwardSpeed) > Math.abs(enemy.vehicle.forwardSpeed);
        this.damageEnemy(enemy, (closing - 5) * (rig ? 1.1 : playerDriven ? 3.0 : 1.4));
        this.hurtPlayer(Math.min(rig ? 16 : 13, (closing - 5) * (rig ? 1.1 : playerDriven ? 0.2 : 0.42)), enemy.vehicle.x, enemy.vehicle.z, 'ram');
        const mx = (p.x + enemy.vehicle.x) / 2;
        const mz = (p.z + enemy.vehicle.z) / 2;
        this.vfx.sparks(mx, 0.9, mz, 0, 0.6, 0, 14);
        this.sfxAt('crash', mx, mz, Math.min(1, closing / 26), 1);
        this.cameraRig.addTrauma(Math.min(0.6, closing / 40));
      }
      for (let j = i + 1; j < this.enemies.length; j += 1) {
        const other = this.enemies[j];
        collideVehicles(enemy.vehicle, other.vehicle, enemy.bodyRadius, other.bodyRadius);
      }
    }
  }

  // ================================================================ player combat

  private updateAim(dt: number): void {
    const p = this.player;
    let best: Enemy | null = null;
    let bestScore = 1.05;
    if (this.phase === 'drive' || this.phase === 'battle') {
      for (const enemy of this.enemies) {
        if (!enemy.alive) continue;
        const dx = enemy.vehicle.x - p.x;
        const dz = enemy.vehicle.z - p.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 170 || dist < 2) continue;
        const off = Math.abs(wrapAngle(Math.atan2(dx, dz) - p.heading));
        const score = off * 0.55 + dist * 0.0012;
        if (score < bestScore && this.grid.lineOfSight(p.x, p.z, enemy.vehicle.x, enemy.vehicle.z)) {
          bestScore = score;
          best = enemy;
        }
      }
    }
    this.aimTarget = best;
    let desired = p.heading;
    if (best) {
      const lead = Math.hypot(best.vehicle.x - p.x, best.vehicle.z - p.z) / 230;
      desired = Math.atan2(best.vehicle.x + best.vehicle.vx * lead - p.x - p.vx * lead, best.vehicle.z + best.vehicle.vz * lead - p.z - p.vz * lead);
    }
    const diff = wrapAngle(desired - this.turretYaw);
    const stepMax = dt * 7.5;
    this.turretYaw = wrapAngle(this.turretYaw + Math.max(-stepMax, Math.min(stepMax, diff)));
    // the turret can only traverse so far from the hull
    const rel = Math.max(-1.9, Math.min(1.9, wrapAngle(this.turretYaw - p.heading)));
    this.turretYaw = wrapAngle(p.heading + rel);
    if (p.model.turret) p.model.turret.rotation.y = rel;
  }

  private updateWeapon(fire: boolean, dt: number): void {
    this.fireTimer -= dt;
    if (fire && !this.overheated && this.fireTimer <= 0) {
      this.fireTimer = 1 / 9.5;
      this.heat += 0.052;
      const p = this.player;
      const muzzles = p.model.muzzles;
      const muzzle = muzzles[this.muzzleIndex % Math.max(1, muzzles.length)];
      this.muzzleIndex += 1;
      p.model.root.updateWorldMatrix(true, true);
      muzzle.getWorldPosition(_v);
      const yaw = this.turretYaw + (this.rng() - 0.5) * 0.028;
      let dy = 0;
      if (this.aimTarget) {
        const t = this.aimTarget.vehicle;
        dy = (t.y + 0.9 - _v.y) / Math.max(4, Math.hypot(t.x - _v.x, t.z - _v.z));
      }
      const dx = Math.sin(yaw);
      const dz = Math.cos(yaw);
      const inv = 1 / Math.hypot(dx, dy, dz);
      this.spawnProjectile(_v.x, _v.y, _v.z, dx * inv, dy * inv, dz * inv, 230, 10, true);
      this.vfx.muzzleFlash(_v.x, _v.y, _v.z, dx, dy, dz, 1);
      this.audio.play('playerShot', { volume: 0.8 });
      this.cameraRig.addTrauma(0.035);
      if (this.heat >= 1) {
        this.heat = 1;
        this.overheated = true;
        this.audio.play('overheat');
      }
    } else if (!fire || this.overheated) {
      this.heat = Math.max(0, this.heat - dt * (this.overheated ? 0.5 : 0.36));
      if (this.overheated && this.heat < 0.3) this.overheated = false;
    }
  }

  private spawnProjectile(x: number, y: number, z: number, dx: number, dy: number, dz: number, speed: number, damage: number, player: boolean): void {
    for (const p of this.projectiles) {
      if (p.active) continue;
      p.active = true;
      p.x = x; p.y = y; p.z = z;
      p.ox = x; p.oz = z;
      p.dx = dx; p.dy = dy; p.dz = dz;
      p.speed = speed;
      p.damage = damage;
      p.player = player;
      p.life = player ? 1.0 : 1.5;
      p.tracer = this.vfx.tracer(x, y, z, dx, dy, dz, player);
      return;
    }
  }

  private enemyShot(enemy: Enemy, muzzle: THREE.Object3D, tx: number, ty: number, tz: number, spread: number, damage: number): void {
    enemy.vehicle.model.root.updateWorldMatrix(true, true);
    muzzle.getWorldPosition(_v2);
    let dx = tx - _v2.x;
    let dy = ty - _v2.y;
    let dz = tz - _v2.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx = dx / len + (this.rng() - 0.5) * spread * 2;
    dy = dy / len + (this.rng() - 0.5) * spread * 0.4;
    dz = dz / len + (this.rng() - 0.5) * spread * 2;
    const inv = 1 / Math.hypot(dx, dy, dz);
    this.spawnProjectile(_v2.x, _v2.y, _v2.z, dx * inv, dy * inv, dz * inv, 125, damage, false);
    this.vfx.muzzleFlash(_v2.x, _v2.y, _v2.z, dx * inv, dy * inv, dz * inv, 0.8);
    this.sfxAt('enemyShot', _v2.x, _v2.z, 0.7, 1);
  }

  private updateProjectiles(dt: number): void {
    const player = this.player;
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.life -= dt;
      const travel = p.speed * dt;
      const nx = p.x + p.dx * travel;
      const ny = p.y + p.dy * travel;
      const nz = p.z + p.dz * travel;
      let hit = false;
      // static city
      const wall = this.grid.raycast(p.x, p.z, nx, nz);
      let reach = 1;
      if (wall < 1) {
        reach = wall;
        hit = true;
      }
      // vehicles, sampled along the step
      const samples = Math.max(1, Math.ceil(travel / 1.4));
      for (let s = 1; s <= samples && (!hit || s / samples <= reach); s += 1) {
        const t = (s / samples) * (hit ? reach : 1);
        const sx = p.x + (nx - p.x) * t;
        const sz = p.z + (nz - p.z) * t;
        if (p.player) {
          let struck: Enemy | null = null;
          for (const enemy of this.enemies) {
            if (enemy.alive && enemy.hitTest(sx, sz, 0.35)) {
              struck = enemy;
              break;
            }
          }
          if (struck) {
            const sy = p.y + (ny - p.y) * t;
            this.vfx.sparks(sx, Math.max(0.5, sy), sz, -p.dx, 0.3, -p.dz, 5);
            this.sfxAt('hitMetal', sx, sz, 0.6, 1);
            this.hud.hitMarker(false);
            this.damageEnemy(struck, p.damage);
            hit = true;
            reach = -1;
            break;
          }
        } else if (this.phase !== 'event' && this.phase !== 'failed') {
          const ddx = sx - player.x;
          const ddz = sz - player.z;
          if (ddx * ddx + ddz * ddz < 1.6 * 1.6) {
            this.vfx.sparks(sx, 1.0, sz, -p.dx, 0.4, -p.dz, 6);
            this.hurtPlayer(p.damage, p.ox, p.oz);
            hit = true;
            reach = -1;
            break;
          }
        }
      }
      if (hit && reach >= 0) {
        const hx = p.x + (nx - p.x) * reach;
        const hz = p.z + (nz - p.z) * reach;
        this.vfx.sparks(hx, p.y + (ny - p.y) * reach, hz, -p.dx, 0.5, -p.dz, 4, 0.7);
        this.vfx.dust(hx, p.y, hz, -p.dx * 2, -p.dz * 2, 0.7);
      }
      if (hit || p.life <= 0 || ny < groundHeight(nx, nz)) {
        p.active = false;
        this.vfx.killTracer(p.tracer);
        continue;
      }
      p.x = nx;
      p.y = ny;
      p.z = nz;
      this.vfx.moveTracer(p.tracer, nx, ny, nz);
    }
  }

  private launchMortar(enemy: Enemy, tx: number, tz: number, delay: number): void {
    const limit = PLAY_HALF - 4;
    const x = Math.max(-limit, Math.min(limit, tx));
    const z = Math.max(-limit, Math.min(limit, tz));
    for (const m of this.mortars) {
      if (m.active) continue;
      enemy.vehicle.model.root.updateWorldMatrix(true, true);
      enemy.vehicle.model.muzzles[0].getWorldPosition(_v2);
      m.active = true;
      m.x = x;
      m.z = z;
      m.timer = delay;
      m.total = delay;
      m.sx = _v2.x;
      m.sy = _v2.y;
      m.sz = _v2.z;
      this.vfx.telegraph(x, groundHeight(x, z), z, MORTAR_RADIUS, delay);
      this.vfx.muzzleFlash(_v2.x, _v2.y, _v2.z, 0, 1, 0, 2.2);
      this.sfxAt('mortarLaunch', _v2.x, _v2.z, 0.9, 1);
      return;
    }
  }

  private updateMortars(dt: number): void {
    for (const m of this.mortars) {
      if (!m.active) continue;
      m.timer -= dt;
      const t = 1 - Math.max(0, m.timer) / m.total;
      // shell rides a tall arc; drawn as a hot glint with a smoke trail
      const sx = m.sx + (m.x - m.sx) * t;
      const sz = m.sz + (m.z - m.sz) * t;
      const sy = m.sy + (0.5 - m.sy) * t + Math.sin(t * Math.PI) * 55;
      this.vfx.exhaust(sx, sy, sz, 0, 0, 0, false);
      this.vfx.sparks(sx, sy, sz, 0, 0, 0, 1, 1.4);
      if (m.timer > 0) continue;
      m.active = false;
      const gy = groundHeight(m.x, m.z);
      this.vfx.explosion(m.x, gy, m.z, 1.5);
      this.sfxAt('mortarImpact', m.x, m.z, 1, 1);
      const dist = Math.hypot(this.player.x - m.x, this.player.z - m.z);
      this.cameraRig.addTrauma(Math.max(0, 0.75 * (1 - dist / 70)));
      if (dist < MORTAR_RADIUS + 1) {
        this.hurtPlayer(19 * (1 - (dist / (MORTAR_RADIUS + 1)) * 0.55), m.x, m.z, 'mortar');
        const push = 9 * (1 - dist / (MORTAR_RADIUS + 1));
        const inv = 1 / Math.max(0.5, dist);
        this.player.vx += (this.player.x - m.x) * inv * push;
        this.player.vz += (this.player.z - m.z) * inv * push;
      }
      for (const enemy of this.enemies) {
        if (enemy.kind === 'rig' || !enemy.alive) continue;
        if (Math.hypot(enemy.vehicle.x - m.x, enemy.vehicle.z - m.z) < MORTAR_RADIUS) this.damageEnemy(enemy, 55);
      }
    }
  }

  private handlePlayerImpact(): void {
    const p = this.player;
    if (p.impact < 4) return;
    const hx = p.x - p.impactNx * 1.2;
    const hz = p.z - p.impactNz * 1.2;
    this.vfx.sparks(hx, 0.7, hz, p.impactNx, 0.5, p.impactNz, Math.min(16, Math.round(p.impact)));
    if (p.impact > 7) {
      this.sfxAt('crash', hx, hz, Math.min(1, p.impact / 30), 1);
      this.cameraRig.addTrauma(Math.min(0.7, p.impact / 45));
    }
    if (p.impact > 14 && (this.phase === 'drive' || this.phase === 'battle')) this.hurtPlayer((p.impact - 14) * 0.55, hx, hz, 'wall');
  }

  private hurtPlayer(amount: number, fromX: number, fromZ: number, source: 'shot' | 'ram' | 'mortar' | 'wall' = 'shot'): void {
    if (amount <= 0 || (this.phase !== 'drive' && this.phase !== 'battle')) return;
    this.damageBy[source] += amount;
    this.armor -= amount;
    this.damageTaken += amount;
    const p = this.player;
    const dx = fromX - p.x;
    const dz = fromZ - p.z;
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    // right-hand vector is (-fz, fx) in this convention
    const angle = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz);
    this.hud.flashDamage(angle, Math.min(1, amount / 18));
    this.audio.play('hitPlayer', { volume: Math.min(1, 0.45 + amount / 25) });
    this.cameraRig.addTrauma(Math.min(0.55, 0.12 + amount / 45));
    this.impactFx = Math.min(1, this.impactFx + amount / 30);
    p.model.setDamage(1 - Math.max(0, this.armor) / MAX_ARMOR);
    if (this.armor <= 0) this.failRun();
  }

  private failRun(): void {
    this.armor = 0;
    this.phase = 'failed';
    this.stageTimer = 2;
    this.timeScale = 0.3;
    this.boosting = false;
    const p = this.player;
    this.vfx.explosion(p.x, p.y, p.z, 1.6);
    this.audio.play('explosionBig');
    this.audio.setMusicState('fail');
    this.cameraRig.addTrauma(1);
    this.hud.clearDialogue();
    this.cues.length = 0;
  }

  private updatePlayerFx(dt: number): void {
    const p = this.player;
    const model = p.model;
    const braking = p.controls.throttle < 0 && p.forwardSpeed > 1;
    model.tailLightMaterial.emissiveIntensity = braking ? 7 : 1.8;
    model.headlightMaterial.emissiveIntensity = 5;
    model.accentMaterial.emissiveIntensity = 2.2;

    // tyre dust when sliding or launching hard
    const slide = Math.abs(p.slip);
    const amount = Math.min(1, slide / 9) + (p.controls.throttle > 0 && p.speed < 12 && p.speed > 1 ? 0.5 : 0) + (p.speed > 30 ? 0.18 : 0);
    this.dustTimer += dt * amount * 46;
    while (this.dustTimer > 1) {
      this.dustTimer -= 1;
      const side = this.rng() < 0.5 ? -1 : 1;
      const fx = Math.sin(p.heading);
      const fz = Math.cos(p.heading);
      this.vfx.dust(p.x - fx * 1.7 + fz * side * 0.9, p.y, p.z - fz * 1.7 - fx * side * 0.9, p.vx * 0.25, p.vz * 0.25, Math.min(1, 0.4 + amount));
    }
    // exhaust: flame when boosting, thin smoke under throttle
    this.exhaustTimer += dt * (this.boosting ? 70 : p.controls.throttle > 0 ? 9 : 2);
    if (this.exhaustTimer > 1 && model.exhausts.length > 0) {
      model.root.updateWorldMatrix(true, true);
      while (this.exhaustTimer > 1) {
        this.exhaustTimer -= 1;
        const socket = model.exhausts[Math.floor(this.rng() * model.exhausts.length)];
        socket.getWorldPosition(_v);
        this.vfx.exhaust(_v.x, _v.y, _v.z, -Math.sin(p.heading), 0.15, -Math.cos(p.heading), this.boosting);
      }
    }
    if (this.armor < 45 && this.rng() < dt * (this.armor < 22 ? 26 : 10)) {
      this.vfx.damageSmoke(p.x + Math.sin(p.heading) * 1.4, p.y + 1.0, p.z + Math.cos(p.heading) * 1.4, this.armor < 22);
    }
    if (this.phase === 'failed' && this.rng() < dt * 24) this.vfx.fire(p.x + (this.rng() - 0.5), p.y + 1.1, p.z + (this.rng() - 0.5), 1.3);
  }

  // ================================================================ presentation

  private updateCamera(dt: number): void {
    const p = this.player;
    if (this.phase === 'title') {
      const a = this.reducedMotion ? 0.6 : this.time * 0.11 + 0.6;
      this.cameraRig.setShot(
        p.x + Math.sin(a + 2.6) * 8.2, p.y + 1.25 + Math.sin(a * 0.7) * 0.25, p.z + Math.cos(a + 2.6) * 8.2,
        p.x - 0.4, p.y + 1.55, p.z + 1.5, 44, dt, 1,
      );
    } else if (this.phase === 'event') {
      this.eventCamera(dt);
    } else if (this.phase === 'failed') {
      const a = this.clock * 0.3;
      this.cameraRig.setShot(p.x + Math.sin(a) * 11, p.y + 4.5, p.z + Math.cos(a) * 11, p.x, p.y + 1, p.z, 52, dt, 2.2);
    } else if (this.phase === 'complete' || (this.phase === 'victory' && this.stageTimer < 6.2)) {
      const r = this.layout.relay;
      const a = this.clock * 0.16;
      this.cameraRig.setShot(r.x + Math.sin(a) * 58, 9 + Math.sin(a * 0.5) * 3, r.z + Math.cos(a) * 58, r.x, 40, r.z, 50, dt, 1.4);
    } else {
      this.cameraRig.updateChase(dt, p, this.grid, this.boosting);
    }
  }

  private eventCamera(dt: number): void {
    const p = this.player;
    const r = this.layout.relay;
    const t = this.eventTime;
    const ease = (x: number) => x * x * (3 - 2 * x);
    if (t < 4.6) {
      // low hero shot: the car in the foreground, the dead tower looming
      const k = ease(Math.min(1, t / 4.6));
      const away = Math.atan2(p.x - r.x, p.z - r.z);
      this.cameraRig.setShot(
        p.x + Math.sin(away + 0.75) * (6.5 - k), p.y + 0.75 + k * 0.5, p.z + Math.cos(away + 0.75) * (6.5 - k),
        THREE.MathUtils.lerp(p.x, r.x, 0.25 + k * 0.55), 2 + k * 30, THREE.MathUtils.lerp(p.z, r.z, 0.25 + k * 0.55),
        40, dt, t < 0.1 ? 1 : 3,
      );
    } else if (t < 10) {
      // crane up the lattice as the relay wakes
      const k = ease((t - 4.6) / 5.4);
      const a = 2.3 + k * 0.7;
      const radius = 40 - k * 8;
      this.cameraRig.setShot(
        r.x + Math.sin(a) * radius, 5 + k * 62, r.z + Math.cos(a) * radius,
        r.x, 22 + k * 62, r.z, 46, dt, t < 4.7 ? 1 : 4,
      );
    } else {
      // the ambush arrives: look down the avenue past the car
      const k = ease(Math.min(1, (t - 10) / 5.5));
      let ex = r.x;
      let ez = r.z - 150;
      let found = false;
      for (const enemy of this.enemies) {
        if (!enemy.alive) continue;
        if (!found) {
          ex = enemy.vehicle.x;
          ez = enemy.vehicle.z;
          found = true;
        }
      }
      const toward = Math.atan2(ex - p.x, ez - p.z);
      this.cameraRig.setShot(
        p.x - Math.sin(toward) * (9 - k * 2) + Math.cos(toward) * 3.2, p.y + 2.3 - k * 0.6, p.z - Math.cos(toward) * (9 - k * 2) - Math.sin(toward) * 3.2,
        ex, 1.5, ez, 38 + k * 6, dt, t < 10.1 ? 1 : 2.5,
      );
    }
  }

  private updateAmbient(delta: number): void {
    const stable = this.reducedMotion;
    const t = stable ? 0 : this.time;
    this.world.update(t, this.camera.position);
    this.relay.update(t, this.phase === 'drive' || this.phase === 'title');
    this.atmosphere.update(t, this.phase === 'title' || this.phase === 'event' ? this.player.model.root.position : this.camera.position);
    this.ash.update(t, this.camera.position, this.viewH * this.viewDpr);

    // fires: feed particles near the camera and hand the nearest ones a real light
    if (!stable && !this.paused) {
      const cam = this.camera.position;
      this.fireEmit += delta * 26;
      const bursts = Math.floor(this.fireEmit);
      this.fireEmit -= bursts;
      for (const fire of this.world.fires) {
        if (fire.strength <= 0) continue;
        const d2 = (fire.x - cam.x) ** 2 + (fire.z - cam.z) ** 2;
        if (d2 > 150 * 150) continue;
        for (let n = 0; n < bursts; n += 1) this.vfx.fire(fire.x, fire.y, fire.z, fire.strength);
      }
    }
    this.fireLightTimer -= delta;
    if (this.fireLightTimer <= 0) {
      this.fireLightTimer = 0.3;
      const p = this.player;
      const used = new Set<number>();
      for (const light of this.fireLights) {
        let best = -1;
        let bestD = 70 * 70;
        for (let i = 0; i < this.world.fires.length; i += 1) {
          if (used.has(i)) continue;
          const fire = this.world.fires[i];
          const d2 = (fire.x - p.x) ** 2 + (fire.z - p.z) ** 2;
          if (d2 < bestD) {
            bestD = d2;
            best = i;
          }
        }
        if (best < 0) {
          light.userData.target = 0;
          continue;
        }
        used.add(best);
        const fire = this.world.fires[best];
        light.position.set(fire.x, fire.y + 0.6, fire.z);
        light.userData.target = fire.strength > 0 ? 420 * fire.strength : 260;
        light.userData.flicker = fire.strength > 0 ? 1 : 0.2;
      }
    }
    for (const light of this.fireLights) {
      const target = (light.userData.target as number | undefined) ?? 0;
      const flicker = stable ? 1 : 1 - ((light.userData.flicker as number | undefined) ?? 0) * 0.3 * (0.5 + 0.5 * Math.sin(this.time * 19 + light.position.x));
      light.intensity += (target * flicker - light.intensity) * Math.min(1, delta * 8);
    }
  }

  private updateAudio(): void {
    const p = this.player;
    const driving = this.phase === 'drive' || this.phase === 'battle' || this.phase === 'event';
    if (driving && !this.paused) {
      const speed01 = Math.min(1, p.speed / HERO_TUNING.boostSpeed);
      const gear = Math.min(4, Math.floor(speed01 * 5));
      const within = speed01 * 5 - gear;
      const rpm = this.phase === 'event' ? 0.12 : 0.22 + within * 0.62 + gear * 0.035;
      this.audio.setEngine(Math.min(1, rpm), Math.max(0, p.controls.throttle), speed01, this.boosting);
      this.audio.setSkid(Math.min(1, Math.max(0, Math.abs(p.slip) - 2.5) / 9));
    }
    this.audio.setAmbience(0.55 + Math.min(0.4, p.speed / 120));
  }

  private sfxAt(name: SfxName, x: number, z: number, volume: number, pitch: number): void {
    const cam = this.camera.position;
    const dx = x - cam.x;
    const dz = z - cam.z;
    const dist = Math.hypot(dx, dz);
    const gain = volume / (1 + (dist / 38) ** 2);
    if (gain < 0.02) return;
    this.camera.getWorldDirection(_v2);
    // screen-right is (-fz, fx) for a camera looking along (fx, fz)
    const right = (dx * -_v2.z + dz * _v2.x) / Math.max(1, dist);
    this.audio.play(name, { volume: gain, pan: Math.max(-0.9, Math.min(0.9, right)), pitch });
  }

  private hudMode(): HudMode {
    if (this.paused) return 'paused';
    switch (this.phase) {
      case 'title': return 'title';
      case 'event': return 'cinematic';
      case 'victory': return this.stageTimer < 6.2 ? 'cinematic' : 'playing';
      case 'failed': return this.stageTimer > 0 ? 'playing' : 'failed';
      case 'complete': return 'complete';
      default: return 'playing';
    }
  }

  private pushHud(): void {
    const f = this.hudFrame;
    const p = this.player;
    f.mode = this.hudMode();
    const speed01 = Math.min(1, p.speed / HERO_TUNING.boostSpeed);
    const gear = Math.min(4, Math.floor(speed01 * 5));
    f.speedKmh = p.speed * 3.6;
    f.rpm01 = Math.min(1, 0.18 + (speed01 * 5 - gear) * 0.68 + gear * 0.035);
    f.armor01 = Math.max(0, this.armor / MAX_ARMOR);
    f.boost01 = this.boost;
    f.boostActive = this.boosting;
    f.heat01 = this.heat;
    f.overheated = this.overheated;
    f.headingRad = -p.heading;
    f.player.x = -p.x;
    f.player.z = p.z;
    f.elapsed = this.runTime;
    f.stats.kills = this.kills;
    f.stats.timeSec = this.runTime;
    f.stats.damageTaken = Math.round(this.damageTaken);

    let ox: number | null = null;
    let oz = 0;
    if (this.phase === 'drive' && this.scoutState === 'active' && this.scout) {
      ox = this.scout.vehicle.x;
      oz = this.scout.vehicle.z;
    } else if (this.phase === 'drive') {
      ox = this.layout.relay.x;
      oz = this.layout.relay.z;
    } else if (this.phase === 'battle' && this.stage === 'boss' && this.boss && this.boss.alive) {
      ox = this.boss.vehicle.x;
      oz = this.boss.vehicle.z;
    }
    f.objective.title = this.objectiveTitle;
    f.objective.detail = this.objectiveDetail;
    if (ox === null) {
      f.objective.distanceM = null;
      f.objective.position = null;
    } else {
      f.objective.distanceM = Math.hypot(ox - p.x, oz - p.z);
      if (!f.objective.position) f.objective.position = { x: 0, z: 0 };
      f.objective.position.x = -ox;
      f.objective.position.z = oz;
    }

    let count = 0;
    let alive = 0;
    const blip = (x: number, z: number, kind: HudBlip['kind']) => {
      if (count >= this.blips.length) this.blips.push({ x: 0, z: 0, kind });
      const b = this.blips[count];
      b.x = -x;
      b.z = z;
      b.kind = kind;
      count += 1;
    };
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      alive += 1;
      blip(enemy.vehicle.x, enemy.vehicle.z, enemy.kind === 'rig' ? 'boss' : 'enemy');
    }
    for (const m of this.mortars) if (m.active) blip(m.x, m.z, 'mortar');
    if (this.phase === 'drive' || this.phase === 'battle') blip(this.layout.relay.x, this.layout.relay.z, 'objective');
    this.blips.length = count;
    f.enemiesRemaining = this.phase === 'battle' || (this.phase === 'drive' && alive > 0) ? alive : null;
    if (this.boss && this.boss.alive && this.stage === 'boss') {
      if (!f.boss) f.boss = { name: 'ウォーリグ《ジャガーノート》', hp01: 1 };
      f.boss.hp01 = Math.max(0, this.boss.health / this.boss.maxHealth);
    } else {
      f.boss = null;
    }
    this.hud.update(f);
  }

  private render(): void {
    this.renderer.info.reset();
    const lowArmor = this.phase === 'failed' ? 0.75 : this.armor < 30 && this.phase !== 'title' ? (1 - this.armor / 30) * 0.4 : 0;
    this.pipeline.render({
      time: this.time,
      speed: this.boosting ? 1 : Math.max(0, (this.player.speed - 40) / 40),
      impact: this.impactFx,
      desaturate: lowArmor,
      stable: this.reducedMotion || this.pausedForScreenshot,
    });
    this.verifyOutput();
  }

  /**
   * The sky alone makes every legitimate frame bright somewhere. If the drawing
   * buffer comes back black the GPU rejected part of the post chain, so step
   * down to a simpler pipeline instead of leaving the player with a void.
   */
  private verifyOutput(): void {
    if (this.renderVerified || this.frame < 4 || this.frame % 10 !== 0 || this.phase === 'failed') return;
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    // two full-width rows: one through the sky, one through the street
    if (!this.probe || this.probe.length !== w * 4) this.probe = new Uint8Array(w * 4);
    let brightest = 0;
    for (const row of [0.72, 0.3]) {
      gl.readPixels(0, Math.floor(h * row), w, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.probe);
      for (let i = 0; i < this.probe.length; i += 16) {
        brightest = Math.max(brightest, this.probe[i], this.probe[i + 1], this.probe[i + 2]);
      }
    }
    this.lastBrightest = brightest;
    if (brightest > 24) {
      this.renderVerified = true;
      return;
    }
    this.blackFrames += 1;
    if (this.blackFrames < 2) return;
    this.blackFrames = 0;
    if (this.pipeline.safeLevel >= 3) {
      this.renderVerified = true;
      console.error('[ashen-skyline] The canvas is still black with the plain forward renderer.');
      return;
    }
    this.pipeline.setSafeLevel(this.pipeline.safeLevel + 1);
    console.warn(`[ashen-skyline] Black frame detected; falling back to render safe level ${this.pipeline.safeLevel}.`);
  }

  /** Drop render resolution on GPUs that cannot hold ~40 fps, and recover when there is headroom. */
  private adaptResolution(delta: number): void {
    if (!this.adaptive || this.pausedForScreenshot || document.hidden) return;
    if (delta > 1 / 38) {
      this.slowTime += delta;
      this.fastTime = 0;
    } else if (delta < 1 / 56) {
      this.fastTime += delta;
      this.slowTime = Math.max(0, this.slowTime - delta);
    }
    if (this.slowTime > 1.5 && this.resolutionScale > 0.55) {
      this.resolutionScale = Math.max(0.55, this.resolutionScale - 0.15);
      this.slowTime = 0;
    } else if (this.fastTime > 12 && this.resolutionScale < 1) {
      this.resolutionScale = Math.min(1, this.resolutionScale + 0.1);
      this.fastTime = 0;
    }
  }

  private resize(): void {
    const width = Math.max(1, Math.floor(this.canvas.clientWidth));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr) * this.resolutionScale;
    if (width === this.viewW && height === this.viewH && dpr === this.viewDpr) return;
    this.viewW = width;
    this.viewH = height;
    this.viewDpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.pipeline.setSize(width, height, dpr);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.cameraRig.setAspect(width / height);
    this.vfx.setViewportHeight(height * dpr);
    this.world.glow.setViewportHeight(height * dpr);
  }

  // ================================================================ test support

  /** Advance the simulation deterministically with scripted intents (used by test states and bots). */
  private simulate(seconds: number, throttle: number, steer: number, fire: boolean): void {
    const dt = 1 / 60;
    for (let n = Math.round(seconds / dt); n > 0; n -= 1) {
      this.applyPlayerIntents(steer, throttle, fire, false, false, dt);
      this.stepSim(dt);
      this.updateCamera(dt);
    }
  }

  /** Pick a lane on a north-south street with a clear run ahead (test states only). */
  private clearLane(roadX: number, z: number, run: number): number {
    for (const lane of [5.5, -5.5, 9.5, -9.5, 2.5, -2.5]) {
      if (this.grid.raycast(roadX + lane, z - 6, roadX + lane, z + run) >= 1) return roadX + lane;
    }
    return roadX + 5.5;
  }

  private applyTestState(name: string): void {
    const relay = this.layout.relay;
    this.pausedForScreenshot = false;
    if (name === 'title') {
      this.enterTitle();
    } else if (name === 'active-play') {
      this.startRun();
      this.cues.length = 0;
      this.scoutState = 'done';
      this.player.place(roadCenter(4) + 5.5, -322, 0);
      this.player.vz = 40;
      this.cameraRig.snapTo(this.player);
      this.simulate(1.2, 1, 0, false);
      this.hud.showDialogue('ミラ', '灰が濃いわ。空へ伸びる光柱を目印にして。', 60);
    } else if (name === 'event') {
      this.startRun();
      this.player.place(relay.x + 4, relay.z - 34, 0);
      this.startEvent();
      this.simulate(8.4, 0, 0, false);
    } else if (name === 'battle' || name === 'boss' || name === 'boss-final') {
      this.startRun();
      this.cues.length = 0;
      this.scoutState = 'done';
      this.relayPower = 1;
      this.relay.setPower(1);
      this.phase = 'battle';
      this.checkpoint = 'battle';
      this.player.place(this.clearLane(relay.x - CITY.pitch / 2, relay.z - 150, 150), relay.z - 150, 0);
      this.player.vz = 30;
      this.turretYaw = 0;
      this.cameraRig.snapTo(this.player);
      this.beginStage(name === 'battle' ? 'wave1' : 'boss', false);
      const px = this.player.x;
      const pz = this.player.z;
      if (name === 'battle') {
        this.spawnEnemy('gunner', 0, px - 5, pz + 62, Math.PI, 1);
        this.spawnEnemy('rammer', 1, px + 6, pz + 96, Math.PI, -1);
        this.spawnEnemy('gunner', 2, px - 2, pz + 128, Math.PI, 1);
      } else {
        this.boss = this.spawnEnemy('rig', 0, px - 3, pz + 84, Math.PI, 1);
        this.boss.health = this.boss.maxHealth * (name === 'boss' ? 0.62 : 0.05);
        if (name === 'boss') this.spawnEnemy('gunner', 0, px + 8, pz + 120, Math.PI, 1);
      }
      for (const enemy of this.enemies) enemy.holdFire(0.2);
      this.simulate(name === 'boss-final' ? 0.2 : 1.5, 0.6, 0, name !== 'boss-final');
    } else if (name === 'failed') {
      this.startRun();
      this.cues.length = 0;
      this.player.place(roadCenter(4) + 5.5, -322, 0);
      this.cameraRig.snapTo(this.player);
      this.kills = 3;
      this.damageTaken = 100;
      this.failRun();
      this.simulate(3.2, 0, 0, false);
    } else if (name === 'complete') {
      this.startRun();
      this.cues.length = 0;
      this.relayPower = 1;
      this.relay.setPower(1);
      this.player.place(relay.x + 3, relay.z - 52, 0);
      this.kills = 11;
      this.damageTaken = 64;
      this.runTime = 318;
      this.phase = 'complete';
      this.setObjective('任務完了', '第7中継塔 確保');
      this.simulate(0.5, 0, 0, false);
    } else {
      throw new Error(`Unknown test state: ${name}`);
    }
    this.timeScale = 1;
    this.hitStop = 0;
    this.updateAmbient(0);
    this.pushHud();
    this.render();
    this.publishDiagnostics();
  }

  private installTestHooks(): void {
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (value: number) => {
        this.rng = createSeededRandom(value);
      },
      setState: (name: string) => {
        this.applyTestState(name);
        return { state: name };
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.pausedForScreenshot = paused;
      },
      setReducedMotion: (enabled: boolean) => {
        this.reducedMotion = enabled;
        this.cameraRig.reducedMotion = enabled;
        this.hud.setReducedMotion(enabled);
        this.updateAmbient(0);
        this.render();
        this.publishDiagnostics();
      },
      hideDebugUi: () => undefined,
      advance: (seconds: number, intents?: { throttle?: number; steer?: number; fire?: boolean; boost?: boolean; handbrake?: boolean }) => {
        const dt = 1 / 60;
        for (let n = Math.round(seconds / dt); n > 0; n -= 1) {
          if (this.hitStop > 0) this.hitStop = 0;
          this.timeScale = 1;
          this.applyPlayerIntents(intents?.steer ?? 0, intents?.throttle ?? 0, intents?.fire ?? false, intents?.boost ?? false, intents?.handbrake ?? false, dt);
          this.stepSim(dt);
          this.updateCamera(dt);
        }
        this.pushHud();
        this.publishDiagnostics();
      },
    };
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    let alive = 0;
    for (const enemy of this.enemies) if (enemy.alive) alive += 1;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.runTime,
      score: this.kills,
      targetScore: 11,
      complete: this.phase === 'complete',
      phase: this.phase,
      stage: this.stage,
      paused: this.paused,
      armor: this.armor,
      boost: this.boost,
      heat: this.heat,
      enemiesAlive: alive,
      bossHealth: this.boss ? this.boss.health / this.boss.maxHealth : null,
      relayDistance: this.relayDistance(),
      kills: this.kills,
      damageTaken: this.damageTaken,
      damageBy: { ...this.damageBy },
      enemies: this.enemies.filter((enemy) => enemy.alive).map((enemy) => ({
        x: enemy.vehicle.x, z: enemy.vehicle.z, kind: enemy.kind, health: enemy.health / enemy.maxHealth,
      })),
      relay: this.layout.relay,
      feelers: [0, 0.5, -0.5].map((offset) => {
        const a = this.player.heading + offset;
        return this.grid.raycast(this.player.x, this.player.z, this.player.x + Math.sin(a) * 45, this.player.z + Math.cos(a) * 45);
      }),
      relayBearing: wrapAngle(Math.atan2(this.layout.relay.x - this.player.x, this.layout.relay.z - this.player.z) - this.player.heading),
      player: {
        position: { x: this.player.x, y: this.player.y, z: this.player.z },
        speed: this.player.speed,
        heading: this.player.heading,
      },
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        postPasses: this.pipeline.postPasses,
        shadowMapSize: this.atmosphere.sun.shadow.mapSize.x,
        shadowLights: 1,
        safeLevel: this.pipeline.safeLevel,
        outputVerified: this.renderVerified,
        brightestSample: this.lastBrightest,
      },
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: this.viewDpr,
      },
    };
  }
}
