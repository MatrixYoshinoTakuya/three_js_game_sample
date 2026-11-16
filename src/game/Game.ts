import * as THREE from 'three';
import { createHeroCar } from '../assets/modelFactories/VehicleModels';
import { InputController } from '../core/InputController';
import { Loop } from '../core/Loop';
import { Enemy, type EnemyHost, type EnemyKind } from '../entities/Enemy';
import { MISSILE, type MissileHost, MissileSystem } from '../entities/Missile';
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
import { CACHE_TRIGGER_RADIUS, SupplyCaches, findCacheSites } from './Caches';
import { DRUM_RADIUS, FuelDrums } from './FuelDrums';
import { PICKUP_COLORS, type Pickup, type PickupKind, PickupSystem } from './Pickups';
import { DriftTracker, NearMissTracker, type ScoreSnapshot, ScoreSystem, computeRank } from './Scoring';
import { type UpgradeId, UPGRADE_DEFS, Upgrades } from './Upgrades';
import type { EnemyEngineSource, HudBlip, HudFrame, HudMode, HudTargetMarker, SfxName, SideObjective, UpgradeOption } from './contracts';

type Phase = 'title' | 'drive' | 'event' | 'battle' | 'victory' | 'failed' | 'complete' | 'endless';
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
  /** Enemy rounds only: the fly-by sound has been considered for this round. */
  whiz: boolean;
};

type DamageCause = 'cannon' | 'missile' | 'ram' | 'barrel' | 'mortar' | 'other';
type DamageSource = 'shot' | 'ram' | 'mortar' | 'wall' | 'blast';
type PatrolRoute = { route: { x: number; z: number }[]; spawned: boolean; squad: number };
type Burn = { x: number; y: number; z: number; life: number };
type Checkpoint = {
  kills: number; runTime: number; damageTaken: number; missiles: number; scrapBank: number;
  score: ScoreSnapshot; upgrades: Record<UpgradeId, number>;
};

type Mortar = { active: boolean; x: number; z: number; timer: number; total: number; sx: number; sy: number; sz: number };

type Cue = { at: number; run: () => void };

const CITY_SEED = 20771;
const START_MISSILES = 2;
/** Missile lock: half-angle of the forward cone (rad), range (m) and seconds of tracking to complete. */
const LOCK_CONE = 0.61;
const LOCK_RANGE = 220;
const LOCK_TIME = 0.7;
const DRUM_BLAST_RADIUS = 8;
const DRUM_DAMAGE = 95;
/** Scrap needed for the field fabricator to print a missile (or a patch when the rack is full). */
const SCRAP_PER_FAB = 40;
const KILL_POINTS: Record<EnemyKind, number> = { gunner: 150, rammer: 200, rig: 2500 };
const NEAR_MISS_SPEED = 27.8;
const CACHE_SQUAD = 100;
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
  private readonly pickups: PickupSystem;
  private readonly drums: FuelDrums;
  private readonly caches: SupplyCaches;
  private readonly missileSystem: MissileSystem;
  private readonly missileHost: MissileHost;
  private readonly upgrades = new Upgrades();
  private readonly scoring = new ScoreSystem();
  private readonly drift = new DriftTracker();
  private readonly nearMiss = new NearMissTracker();
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

  private armor = 100;
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
  private readonly damageBy: Record<DamageSource, number> = { shot: 0, ram: 0, mortar: 0, wall: 0, blast: 0 };
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

  // ---- secondary weapon
  private missiles = START_MISSILES;
  private missileCooldown = 0;
  private missileSide = 1;
  private missilesFired = 0;
  private missileKills = 0;
  private lockTarget: Enemy | null = null;
  private lockProgress = 0;
  private lockComplete = false;
  private missileTaught = false;
  // ---- open world
  private readonly streetScrap: { x: number; z: number }[] = [];
  private readonly patrols: PatrolRoute[] = [];
  private readonly burns: Burn[] = [];
  private hostiles = 0;
  private aliveEnemies = 0;
  private driveCombat = false;
  private patrolTaught = false;
  private relayBlockedToast = 0;
  // ---- score / style
  private scrapBank = 0;
  private scrapPopup = 0;
  private scrapPopupTimer = 0;
  private lastKillClock = -10;
  private multiKill = 0;
  private slowHold = 0;
  private driftCount = 0;
  private nearMissCount = 0;
  private barrelKills = 0;
  private ramKills = 0;
  private drumsDetonated = 0;
  private pickupsCollected = 0;
  private lastStyle = '';
  private contactThisStep = false;
  // ---- upgrades
  private upgradeOffer: { title: string; subtitle: string; options: UpgradeOption[] } | null = null;
  private readonly upgradeQueue: { title: string; subtitle: string }[] = [];
  private upgradesPicked = 0;
  // ---- endless
  private endless = false;
  private endlessWave = 0;
  private endlessTimer = 0;
  private endlessActive = false;
  private endlessDetailKey = -1;
  private endlessStart: Checkpoint | null = null;
  private checkpointData: Checkpoint | null = null;
  // ---- feel
  private threat = 0;
  private ricochetTimer = 0;
  private whizTimer = 0;
  private lastGear = 0;
  private gearTimer = 0;
  private blowoffTimer = 0;
  private wasBoosting = false;
  private lastThrottle = 0;
  private rankPlayed = false;
  private readonly enginePool: EnemyEngineSource[] = [];
  private readonly engineList: EnemyEngineSource[] = [];
  private readonly engineNearest: (Enemy | null)[] = [null, null, null, null];
  private readonly targets: HudTargetMarker[] = [];
  private readonly targetPool: HudTargetMarker[] = [];
  private readonly sideObjectives: SideObjective[] = [];
  private readonly cacheObjective: SideObjective = { label: '補給キャッシュ 0/3', done: false, distanceM: null };
  private cacheLabelCount = -1;
  private diagDrums: { x: number; z: number }[] = [];
  private diagDrumCount = -1;

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
    // supply caches are solid, so their boxes join the static colliders before the grid is built
    const cacheSites = findCacheSites(this.layout, new ColliderGrid(this.layout.colliders), CITY_SEED + 7);
    for (const site of cacheSites) this.layout.colliders.push(site.collider);
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

    // ---- gameplay props
    this.pickups = new PickupSystem();
    this.pickups.onCollect = (pickup) => this.collectPickup(pickup);
    this.drums = new FuelDrums(this.layout, this.grid, CITY_SEED + 3);
    if (this.lowSpec) this.drums.mesh.castShadow = false;
    this.caches = new SupplyCaches(cacheSites);
    this.missileSystem = new MissileSystem(6);
    this.scene.add(this.pickups.group, this.drums.mesh, this.caches.group, this.missileSystem.mesh);
    this.buildScrapTrails();
    this.buildPatrolRoutes();
    for (let i = 0; i < 4; i += 1) this.enginePool.push({ distance: 0, pan: 0, rpm01: 0, heavy: false });
    for (let i = 0; i < 6; i += 1) this.burns.push({ x: 0, y: 0, z: 0, life: 0 });

    for (let i = 0; i < (this.lowSpec ? 2 : 3); i += 1) {
      const light = new THREE.PointLight('#ff8a3c', 0, 42, 1.7);
      this.fireLights.push(light);
      this.scene.add(light);
    }

    // ---- player
    this.player = new Vehicle(createHeroCar(), HERO_TUNING);
    this.player.plow = true;
    this.scene.add(this.player.model.root);
    this.headlight = new THREE.SpotLight('#ffe2b8', 520, 85, 0.5, 0.65, 1.5);
    this.headlight.position.set(0, 0.95, 1.9);
    this.headlight.target.position.set(0, -0.4, 22);
    this.player.model.root.add(this.headlight, this.headlight.target);

    for (let i = 0; i < 96; i += 1) {
      this.projectiles.push({ active: false, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, speed: 0, life: 0, damage: 0, player: true, tracer: -1, ox: 0, oz: 0, whiz: false });
    }
    for (let i = 0; i < 6; i += 1) this.mortars.push({ active: false, x: 0, z: 0, timer: 0, total: 1, sx: 0, sy: 0, sz: 0 });

    this.host = {
      rng: () => this.rng(),
      grid: this.grid,
      player: this.player,
      enemyShot: (enemy, muzzle, tx, ty, tz, spread, damage) => this.enemyShot(enemy, muzzle, tx, ty, tz, spread, damage),
      mortar: (enemy, tx, tz, delay) => this.launchMortar(enemy, tx, tz, delay),
      telegraphSound: (enemy) => this.sfxAt('alarm', enemy.vehicle.x, enemy.vehicle.z, 0.16, 1.7),
      alerted: (enemy) => this.onEnemyAlerted(enemy),
    };
    this.missileHost = {
      grid: this.grid,
      enemies: this.enemies,
      drumHit: (ax, az, bx, bz) => this.drums.segmentHit(ax, az, bx, bz, 0.25),
      drumHitT: () => this.drums.hitT,
      trail: (x, y, z, dx, dy, dz, boostPhase) => this.vfx.missileTrail(x, y, z, dx, dy, dz, boostPhase),
      detonate: (x, y, z, direct, drum) => this.detonateMissile(x, y, z, direct, drum),
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
      score: 0,
      combo: { count: 0, multiplier: 1, timer01: 0 },
      scrap: 0,
      missiles: START_MISSILES,
      missileMax: this.upgrades.missileMax,
      targets: this.targets,
      sideObjectives: this.sideObjectives,
      upgrade: null,
      stats: { kills: 0, timeSec: 0, damageTaken: 0, score: 0, bestCombo: 0, scrap: 0, rank: 'D' },
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
    this.hud.on('continue', () => this.continueEndless());
    this.hud.onUpgradePick((id) => this.resolveUpgrade(id));
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
    this.pickups.dispose();
    this.drums.dispose();
    this.caches.dispose();
    this.missileSystem.dispose();
    this.ash.dispose();
    this.renderer.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  private readonly onVisibility = () => {
    if (document.hidden && !this.paused && this.playing()) this.setPaused(true);
    else if (document.hidden) this.audio.pause();
    else if (!this.paused) this.audio.resume();
  };

  // ================================================================ flow

  /** True while the player is driving and can be hurt (free roam, the defence battle, endless bounty). */
  private playing(): boolean {
    return this.phase === 'drive' || this.phase === 'battle' || this.phase === 'endless';
  }

  private enterTitle(): void {
    this.resetRunState();
    this.resetWorld();
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
    this.missileSystem.clear();
    for (const burn of this.burns) burn.life = 0;
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
    this.slowHold = 0;
    this.armor = this.upgrades.maxArmor;
    this.boost = 1;
    this.boostLock = 0;
    this.missileCooldown = 0;
    this.lockTarget = null;
    this.lockProgress = 0;
    this.lockComplete = false;
    this.upgradeOffer = null;
    this.upgradeQueue.length = 0;
    this.scoring.clearCombo();
    this.drift.reset();
    this.nearMiss.reset();
    this.multiKill = 0;
    this.lastKillClock = -10;
    this.scrapPopup = 0;
    this.hostiles = 0;
    this.aliveEnemies = 0;
    this.driveCombat = false;
    this.relayBlockedToast = 0;
    this.endlessActive = false;
    this.endlessDetailKey = -1;
    this.rankPlayed = false;
    this.player.softImpact = 0;
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

  /** Full restart: everything the player can change in the world goes back to its authored state. */
  private resetWorld(): void {
    this.upgrades.reset();
    this.upgradesPicked = 0;
    this.scoring.reset();
    this.armor = this.upgrades.maxArmor;
    this.missiles = START_MISSILES;
    this.missilesFired = 0;
    this.missileKills = 0;
    this.missileTaught = false;
    this.patrolTaught = false;
    this.scrapBank = 0;
    this.driftCount = 0;
    this.nearMissCount = 0;
    this.barrelKills = 0;
    this.ramKills = 0;
    this.drumsDetonated = 0;
    this.pickupsCollected = 0;
    this.lastStyle = '';
    this.endless = false;
    this.endlessWave = 0;
    this.endlessStart = null;
    this.checkpointData = null;
    this.damageBy.shot = 0;
    this.damageBy.ram = 0;
    this.damageBy.mortar = 0;
    this.damageBy.wall = 0;
    this.damageBy.blast = 0;
    this.drums.reset();
    this.caches.reset();
    for (const patrol of this.patrols) patrol.spawned = false;
    this.pickups.clear();
    for (let i = 0; i < this.streetScrap.length; i += 1) {
      const spot = this.streetScrap[i];
      this.pickups.spawn('scrap', spot.x, spot.z, 1, Infinity, 0, 0, 0, i * 0.7);
    }
  }

  private snapshot(): Checkpoint {
    return {
      kills: this.kills, runTime: this.runTime, damageTaken: this.damageTaken, missiles: this.missiles, scrapBank: this.scrapBank,
      score: this.scoring.snapshot(), upgrades: this.upgrades.snapshot(),
    };
  }

  private restore(data: Checkpoint): void {
    this.kills = data.kills;
    this.runTime = data.runTime;
    this.damageTaken = data.damageTaken;
    this.missiles = Math.max(START_MISSILES, data.missiles);
    this.scrapBank = data.scrapBank;
    this.scoring.restore(data.score);
    this.upgrades.restore(data.upgrades);
    this.armor = this.upgrades.maxArmor;
  }

  private startRun(): void {
    // the start button and the Enter key can both fire for one press
    if (this.phase === 'drive' && this.clock < 0.4) return;
    this.audio.unlock();
    this.audio.resume();
    this.resetRunState();
    this.resetWorld();
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
    if (this.endless) {
      this.startEndless(true);
      return;
    }
    if (this.checkpoint !== 'battle') {
      this.startRun();
      return;
    }
    const stage = this.checkpointStage;
    const data = this.checkpointData;
    this.audio.resume();
    this.resetRunState();
    if (data) this.restore(data);
    this.drums.reset();
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
    if (!this.playing() && this.phase !== 'event') return;
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

    // choosing an upgrade freezes the simulation: it is a decision, not a reflex test
    if (!this.paused && !this.upgradeOffer) {
      if (this.hitStop > 0) {
        this.hitStop -= delta;
      } else {
        if (this.slowHold > 0) this.slowHold -= delta;
        else {
          const recover = this.phase === 'victory' || this.phase === 'failed' ? 1.4 : 3.2;
          this.timeScale += (1 - this.timeScale) * Math.min(1, delta * recover);
        }
        const dt = Math.min(delta, 1 / 20) * this.timeScale;
        this.applyPlayerIntents(intents.steer, intents.throttle, intents.fire, intents.boost, intents.handbrake, intents.missile, dt);
        this.stepSim(dt);
        this.updateCamera(dt);
      }
    }
    this.updateAudio(delta);
    this.updateAmbient(delta);
    this.pushHud();
    this.publishDiagnostics();
    this.input.endFrame();
  }

  private handleMenuKeys(): void {
    const confirm = this.input.consume('Enter', 'NumpadEnter');
    if (this.input.consume('KeyM')) this.toggleMute();
    if (this.upgradeOffer && !this.paused) {
      // keyboard fallback for the upgrade cards
      const options = this.upgradeOffer.options;
      if (this.input.consume('Digit1', 'Numpad1') && options[0]) this.resolveUpgrade(options[0].id);
      else if (this.input.consume('Digit2', 'Numpad2') && options[1]) this.resolveUpgrade(options[1].id);
      else if (this.input.consume('Digit3', 'Numpad3') && options[2]) this.resolveUpgrade(options[2].id);
      return;
    }
    if (this.input.consume('Escape', 'KeyP')) this.setPaused(!this.paused);
    if (this.phase === 'complete' && this.input.consume('KeyC')) this.continueEndless();
    if (!confirm) return;
    if (this.phase === 'title' || this.phase === 'complete') this.startRun();
    else if (this.phase === 'failed') this.retry();
    else if (this.paused) this.setPaused(false);
    else if (this.phase === 'event' && this.eventTime > 1.2) this.skipEvent();
  }

  private applyPlayerIntents(steer: number, throttle: number, fire: boolean, boost: boolean, handbrake: boolean, missile: boolean, dt: number): void {
    const c = this.player.controls;
    if (!this.playing()) {
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
    // the supercharger upgrade stretches the tank and speeds up the refill
    const boostFactor = this.upgrades.boostFactor;
    if (this.boosting) {
      this.boost = Math.max(0, this.boost - (dt * 0.3) / boostFactor);
      this.boostLock = 0.9;
    } else {
      this.boostLock -= dt;
      if (this.boostLock <= 0) this.boost = Math.min(1, this.boost + dt * 0.14 * boostFactor);
    }
    c.boost = this.boosting;
    this.updateWeapon(fire, dt);
    this.missileCooldown -= dt;
    if (missile) this.fireMissile();
  }

  private coolWeapon(dt: number): void {
    this.heat = Math.max(0, this.heat - dt * 0.4);
    if (this.overheated && this.heat < 0.3) this.overheated = false;
  }

  /** One deterministic simulation step. Everything gameplay-relevant lives here. */
  private stepSim(dt: number): void {
    if (dt <= 0) return;
    this.clock += dt;
    const playing = this.playing();
    if (playing) this.runTime += dt;

    for (let i = this.cues.length - 1; i >= 0; i -= 1) {
      if (this.cues[i].at <= this.clock) {
        const cue = this.cues[i];
        this.cues.splice(i, 1);
        cue.run();
      }
    }
    this.updateMission(dt);

    this.player.impact = 0;
    this.contactThisStep = false;
    for (const enemy of this.enemies) enemy.vehicle.impact = 0;
    const sub = 2;
    const h = dt / sub;
    for (let s = 0; s < sub; s += 1) {
      this.player.step(h, this.grid);
      for (const enemy of this.enemies) enemy.vehicle.step(h, this.grid);
      this.resolveVehicleContacts();
      this.resolveDrumContacts();
    }
    if (playing) this.updateStyle(dt);
    this.handlePlayerImpact();

    const simulateAi = playing || this.phase === 'event';
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
    let alive = 0;
    let hostiles = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      alive += 1;
      if (enemy.aware) hostiles += 1;
    }
    this.aliveEnemies = alive;
    this.hostiles = hostiles;
    this.updateAim(dt);
    this.updateMissileLock(dt);
    this.updateProjectiles(dt);
    this.missileSystem.update(dt, this.missileHost);
    this.updateDrums(dt);
    this.updateMortars(dt);
    this.updatePlayerFx(dt);
    const p = this.player;
    this.pickups.update(dt, this.clock, p.x, p.z, p.vx, p.vz, this.upgrades.magnetRadius, playing);
    this.caches.update(dt, this.clock);
    if (playing) this.updateCaches();
    this.updateScoreFeedback(dt, playing);
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
      // guaranteed first contact: a scout drops in behind once the player is rolling
      if (this.scoutState === 'pending' && this.clock > 11 && (dist < 660 || this.clock > 16) && this.player.speed > 12) this.spawnScout();
      if (this.scoutState === 'active' && this.scout && !this.scout.alive) {
        this.scoutState = 'done';
        this.scout = null;
        this.setObjective('第7中継塔へ向かえ', '光柱を目印に灰都を抜けろ');
        this.say(0.8, 'ミラ', 'いい腕ね。……でも斥候がいたなら、本隊も近い。道中の補給キャッシュも狙い目よ。', 5);
      }
      this.updateOpenWorld();
      if (this.flavour === 0 && dist < 380) {
        this.flavour = 1;
        this.say(0, 'ミラ', 'あと少し。……妙ね、周波数にノイズが乗ってる。', 4.5);
      }
      if (dist < 36) {
        // the relay start-up is a cutscene: it waits while raiders are on the player's bumper,
        // but never for enemies that are far away or have not noticed the player
        if (!this.hostileWithin(60)) this.startEvent();
        else if (this.clock > this.relayBlockedToast) {
          this.relayBlockedToast = this.clock + 6;
          this.hud.toast('追手を撃破するか振り切れ', 'warning');
        }
      }
    } else if (this.phase === 'endless') {
      this.updateEndless(dt);
    } else if (this.phase === 'event') {
      this.updateEvent(dt);
    } else if (this.phase === 'battle') {
      this.updateBattle(dt);
    } else if (this.phase === 'victory') {
      this.stageTimer -= dt;
      if (this.stageTimer <= 0) this.enterComplete();
    } else if (this.phase === 'failed') {
      this.stageTimer -= dt;
    }
  }

  private spawnScout(): void {
    const p = this.player;
    const spot = this.roadPointNear(p.x - Math.sin(p.heading) * 115, p.z - Math.cos(p.heading) * 115);
    if (Math.hypot(spot.x - p.x, spot.z - p.z) < 70) return;
    this.scoutState = 'active';
    this.scout = this.spawnEnemy('gunner', 0, spot.x, spot.z, Math.atan2(p.x - spot.x, p.z - spot.z), 1, 1);
    this.scout.vehicle.vx = Math.sin(this.scout.vehicle.heading) * 30;
    this.scout.vehicle.vz = Math.cos(this.scout.vehicle.heading) * 30;
    this.setObjective('斥候を撃破せよ', 'Space／FIRE：機関砲');
    this.audio.play('alarm', { volume: 0.5 });
    this.hud.toast('敵影接近', 'warning');
    this.say(0.2, 'ミラ', '後ろ！錆牙団の斥候よ。機関砲で落として！', 4.5);
    this.audio.setMusicState('battle');
    this.driveCombat = true;
  }

  private hostileWithin(range: number): boolean {
    const p = this.player;
    for (const enemy of this.enemies) {
      if (!enemy.alive || !enemy.aware) continue;
      if (Math.hypot(enemy.vehicle.x - p.x, enemy.vehicle.z - p.z) < range) return true;
    }
    return false;
  }

  // ================================================================ open world

  /** Short "racing line" scrap trails: slaloms down a street and arcs that hug a junction apex. */
  private buildScrapTrails(): void {
    const rng = createSeededRandom(CITY_SEED + 91);
    const start = this.layout.start;
    const relay = this.layout.relay;
    const N = CITY.blocksPerSide;
    const clear = (x: number, z: number) => {
      let ok = true;
      this.grid.query(x - 3, x + 3, z - 3, z + 3, (box) => {
        if (x > box.minX - 2.4 && x < box.maxX + 2.4 && z > box.minZ - 2.4 && z < box.maxZ + 2.4) ok = false;
      });
      return ok && Math.abs(x) < PLAY_HALF - 3 && Math.abs(z) < PLAY_HALF - 3;
    };
    const corridor = (x: number, z: number) => {
      const vx = relay.x - start.x;
      const vz = relay.z - start.z;
      const t = Math.max(0, Math.min(1, ((x - start.x) * vx + (z - start.z) * vz) / (vx * vx + vz * vz)));
      return Math.hypot(x - (start.x + vx * t), z - (start.z + vz * t));
    };
    const trail: { x: number; z: number }[] = [];
    const commit = () => {
      if (trail.length >= 4) for (const piece of trail) this.streetScrap.push(piece);
      trail.length = 0;
    };
    const add = (x: number, z: number) => {
      if (clear(x, z)) trail.push({ x, z });
    };
    // the first one sits right in front of the start line to teach the pickup
    for (let i = 0; i < 6; i += 1) add(start.x + Math.sin(i * 0.9) * 2.6, start.z + 42 + i * 7.5);
    commit();
    for (let guard = 0; guard < 400 && this.streetScrap.length < 62; guard += 1) {
      const k = Math.floor(rng() * (N + 1));
      const m = Math.floor(rng() * (N + 1));
      const ax = roadCenter(k);
      const az = roadCenter(m);
      const mid = rng() < 0.55;
      const sx = rng() < 0.5 ? -1 : 1;
      const sz = rng() < 0.5 ? -1 : 1;
      const side = (rng() < 0.5 ? -1 : 1) * (3 + rng() * 4.5);
      const amp = 2.4 + rng() * 1.8;
      const along = 28 + rng() * 26;
      const northSouth = rng() < 0.5;
      const cx = mid ? (northSouth ? ax : ax + CITY.pitch / 2) : ax;
      const cz = mid ? (northSouth ? az + CITY.pitch / 2 : az) : az;
      const off = corridor(cx, cz);
      if (off > 380 || (off > 200 && rng() < 0.65)) continue;
      if (Math.hypot(cx - start.x, cz - start.z) < 110 || Math.hypot(cx - relay.x, cz - relay.z) < 70) continue;
      let crowded = false;
      for (const piece of this.streetScrap) if (Math.hypot(piece.x - cx, piece.z - cz) < 60) crowded = true;
      if (crowded) continue;
      if (mid) {
        // slalom along a block
        for (let i = 0; i < 6; i += 1) {
          const t = along + i * 7.5;
          const lane = side + Math.sin(i * 1.05) * amp;
          if (northSouth) add(ax + lane, az + t);
          else add(ax + t, az + lane);
        }
      } else {
        // apex arc around the inside kerb of a junction
        const kx = ax + sx * (CITY.roadWidth / 2);
        const kz = az + sz * (CITY.roadWidth / 2);
        for (let i = 0; i < 5; i += 1) {
          const a = (i / 4) * (Math.PI / 2);
          add(kx - sx * Math.cos(a) * 7.5 + sx * Math.sin(a) * 6, kz - sz * Math.sin(a) * 7.5 + sz * Math.cos(a) * 6);
        }
      }
      commit();
    }
  }

  /** Street loops the raider patrols drive, as lists of junction-side waypoints. */
  private buildPatrolRoutes(): void {
    const loop = (k0: number, k1: number, m0: number, m1: number): { x: number; z: number }[] => [
      { x: roadCenter(k0) + 4, z: roadCenter(m0) + 4 },
      { x: roadCenter(k1) - 4, z: roadCenter(m0) + 4 },
      { x: roadCenter(k1) - 4, z: roadCenter(m1) - 4 },
      { x: roadCenter(k0) + 4, z: roadCenter(m1) - 4 },
    ];
    this.patrols.push({ route: loop(1, 3, 4, 6), spawned: false, squad: 1 });
    this.patrols.push({ route: loop(3, 4, 6, 9), spawned: false, squad: 2 });
    this.patrols.push({ route: loop(7, 9, 4, 6), spawned: false, squad: 3 });
  }

  /** Patrols and cache guards are created when the player gets within range, so far-away AI costs nothing. */
  private updateOpenWorld(): void {
    const p = this.player;
    for (const patrol of this.patrols) {
      if (patrol.spawned) continue;
      // pick the loop corner the player cannot see
      let corner = -1;
      let near = 1e9;
      for (let i = 0; i < patrol.route.length; i += 1) {
        const d = Math.hypot(patrol.route[i].x - p.x, patrol.route[i].z - p.z);
        near = Math.min(near, d);
        if (d > 150 && (corner < 0 || !this.grid.lineOfSight(p.x, p.z, patrol.route[i].x, patrol.route[i].z))) corner = i;
      }
      if (near > 300 || corner < 0) continue;
      patrol.spawned = true;
      const a = patrol.route[corner];
      const b = patrol.route[(corner + 1) % patrol.route.length];
      const heading = Math.atan2(b.x - a.x, b.z - a.z);
      const lead = this.spawnEnemy('gunner', 2, a.x, a.z, heading, 1);
      const wing = this.spawnEnemy('rammer', 1, a.x - Math.sin(heading) * 13 + Math.cos(heading) * 4, a.z - Math.cos(heading) * 13 - Math.sin(heading) * 4, heading, -1);
      for (const enemy of [lead, wing]) {
        enemy.setPatrol(patrol.route, corner + 1);
        enemy.squad = patrol.squad;
      }
    }
    for (let i = 0; i < this.caches.caches.length; i += 1) {
      const cache = this.caches.caches[i];
      if (cache.opened || cache.guardsSpawned || Math.hypot(cache.x - p.x, cache.z - p.z) > 260) continue;
      cache.guardsSpawned = true;
      for (let n = 0; n < cache.guards.length; n += 1) {
        const spot = cache.guards[n];
        const guard = this.spawnEnemy(n === 0 ? 'gunner' : 'rammer', n === 0 ? 0 : 1, spot.x, spot.z, spot.heading, n === 0 ? 1 : -1);
        guard.setGuard();
        guard.squad = CACHE_SQUAD + i;
      }
    }
    // music and objective follow whether anything is actually hunting the player
    if (this.hostiles > 0 && !this.driveCombat) {
      this.driveCombat = true;
      this.audio.setMusicState('battle');
    } else if (this.hostiles === 0 && this.driveCombat && this.scoutState !== 'active') {
      this.driveCombat = false;
      this.audio.setMusicState('explore');
    }
  }

  private onEnemyAlerted(enemy: Enemy): void {
    if (enemy.aware) return;
    const guard = enemy.mode === 'guard';
    for (const other of this.enemies) {
      if (other === enemy || (enemy.squad !== 0 && other.squad === enemy.squad)) other.alert();
    }
    this.sfxAt('alarm', enemy.vehicle.x, enemy.vehicle.z, 0.9, 1.2);
    this.hud.toast(guard ? 'キャッシュの護衛が起動' : '敵パトロールに発見された', 'warning');
    if (!this.patrolTaught && this.phase === 'drive') {
      this.patrolTaught = true;
      this.say(0.3, 'ミラ', guard ? '護衛が動いた！片付ければキャッシュはあなたのものよ。' : '錆牙団のパトロールよ！赤いドラム缶の近くに誘い込んで撃てば、まとめて吹き飛ぶわ。', 5);
    }
  }

  private squadAlive(squad: number): boolean {
    for (const enemy of this.enemies) if (enemy.alive && enemy.squad === squad) return true;
    return false;
  }

  private updateCaches(): void {
    const p = this.player;
    for (let i = 0; i < this.caches.caches.length; i += 1) {
      const cache = this.caches.caches[i];
      if (cache.opened) continue;
      if (Math.hypot(cache.x - p.x, cache.z - p.z) > CACHE_TRIGGER_RADIUS) continue;
      if (this.squadAlive(CACHE_SQUAD + i)) {
        if (!cache.warned) {
          cache.warned = true;
          this.hud.toast('護衛を排除せよ', 'warning');
        }
        continue;
      }
      this.openCache(i);
    }
  }

  private openCache(index: number): void {
    const cache = this.caches.caches[index];
    cache.opened = true;
    const opened = this.caches.openedCount;
    const total = this.caches.caches.length;
    const stepped = this.scoring.chain();
    const points = this.scoring.award(500);
    this.hud.scorePopup('CACHE', points, 'bonus');
    if (stepped) this.audio.play('combo', { pitch: this.scoring.multiplier });
    this.hud.toast(`補給キャッシュ確保 ${opened}/${total}`, 'success');
    this.audio.play('checkpoint');
    this.vfx.flare(cache.x, cache.y + 1.6, cache.z, 0.22, 0.96, 0.85);
    this.vfx.pulse(cache.x, cache.y + 0.3, cache.z, 26, 1.0, '#38f5d8');
    this.cameraRig.addTrauma(0.2);
    // contents: a fountain of scrap, two missiles and a field upgrade
    for (let n = 0; n < 10; n += 1) {
      const a = (n / 10) * Math.PI * 2 + this.rng();
      const s = 5 + this.rng() * 5;
      this.pickups.spawn('scrap', cache.x, cache.z, 2, 45, Math.sin(a) * s, 9 + this.rng() * 4, Math.cos(a) * s, n);
    }
    const before = this.missiles;
    this.missiles = Math.min(this.upgrades.missileMax, this.missiles + 2);
    if (this.missiles > before) this.hud.scorePopup('MISSILE', this.missiles - before, 'pickup');
    this.cue(0.9, () => this.offerUpgrade('補給キャッシュ', `SUPPLY CACHE ${opened}/${total} ── 強化を1つ選べ`));
    if (opened === total) {
      this.cue(1.0, () => {
        this.hud.scorePopup('ALL CACHES', this.scoring.award(1000), 'bonus');
        this.say(0.6, 'ミラ', 'キャッシュは全部押さえたわね。これなら本隊が来ても戦える。', 4.5);
      });
    }
  }

  // ================================================================ upgrades

  private offerUpgrade(title: string, subtitle: string): void {
    if (this.upgradeOffer) {
      this.upgradeQueue.push({ title, subtitle });
      return;
    }
    if (this.phase === 'failed' || this.phase === 'title') return;
    const options = this.upgrades.draw(() => this.rng(), this.armor < this.upgrades.maxArmor * 0.6);
    if (options.length === 0) return;
    this.upgradeOffer = { title, subtitle, options };
    this.audio.play('uiConfirm');
  }

  /** The single path every upgrade choice takes: HUD card click/tap, or the 1-3 keys. */
  private resolveUpgrade(id: string): void {
    const offer = this.upgradeOffer;
    if (!offer) return;
    let valid = false;
    for (const option of offer.options) if (option.id === id) valid = true;
    if (!valid) return;
    const applied = this.upgrades.apply(id);
    if (!applied) return;
    this.upgradesPicked += 1;
    const max = this.upgrades.maxArmor;
    if (applied === 'plating') this.armor = Math.min(max, this.armor + 25);
    else if (applied === 'medkit') this.armor = Math.min(max, this.armor + 50);
    else if (applied === 'rack') this.missiles = this.upgrades.missileMax;
    else if (applied === 'turbo') this.boost = 1;
    this.player.model.setDamage(1 - this.armor / max);
    const def = UPGRADE_DEFS.find((entry) => entry.id === applied);
    this.hud.toast(def ? `${def.name}${applied === 'medkit' ? '' : ` Lv.${this.upgrades.level(applied)}`}` : 'UPGRADE', 'success');
    this.audio.play('upgrade');
    const p = this.player;
    this.vfx.flare(p.x, p.y + 0.6, p.z, 1.0, 0.75, 0.3);
    this.upgradeOffer = null;
    const next = this.upgradeQueue.shift();
    if (next) this.offerUpgrade(next.title, next.subtitle);
  }

  // ================================================================ endless

  private enterComplete(): void {
    this.phase = 'complete';
    this.audio.play('uiConfirm');
    if (!this.rankPlayed) {
      this.rankPlayed = true;
      this.audio.play('rankStamp');
    }
  }

  /** "フリーローム続行": keep the car, the upgrades and the score, and let the bounty hunters come. */
  private continueEndless(): void {
    if (this.phase !== 'complete') return;
    this.audio.unlock();
    this.audio.resume();
    this.startEndless(false);
  }

  private startEndless(fromRetry: boolean): void {
    if (fromRetry && this.endlessStart) {
      this.resetRunState();
      this.restore(this.endlessStart);
      this.drums.reset();
      this.player.place(this.layout.relay.x + 3, this.layout.relay.z - 52, 0);
      this.turretYaw = 0;
    } else {
      this.clearEnemies();
      this.cues.length = 0;
      this.hud.clearDialogue();
      this.endlessStart = this.snapshot();
    }
    this.endless = true;
    this.phase = 'endless';
    this.stage = 'none';
    this.checkpoint = 'battle';
    this.relayPower = 1;
    this.relay.setPower(1);
    this.timeScale = 1;
    this.endlessWave = 0;
    this.endlessActive = false;
    this.endlessTimer = 5;
    this.endlessDetailKey = -1;
    this.rankPlayed = false;
    this.cameraRig.snapTo(this.player);
    this.setObjective('フリーローム', '賞金稼ぎが接近中 ── 迎撃せよ');
    this.audio.setMusicState('explore');
    this.audio.play('uiConfirm');
    this.say(0.8, 'ミラ', '塔は生きてる。……でも首に賞金が掛かったわ。来る者は全部、迎え撃って。', 5);
  }

  private updateEndless(dt: number): void {
    const alive = this.aliveEnemies;
    if (this.endlessActive && alive === 0) {
      // wave cleared: patch up, maybe an upgrade, and the next crew is already on its way
      this.endlessActive = false;
      const max = this.upgrades.maxArmor;
      if (this.armor < max) {
        this.armor = Math.min(max, this.armor + 20);
        this.player.model.setDamage(1 - this.armor / max);
        this.audio.play('repair');
      }
      this.hud.toast(`WAVE ${this.endlessWave} CLEAR ── 装甲 +20`, 'success');
      this.hud.scorePopup('WAVE CLEAR', this.scoring.award(200 + this.endlessWave * 50), 'bonus');
      this.audio.setMusicState('explore');
      if (this.endlessWave % 2 === 0) {
        const wave = this.endlessWave;
        this.cue(1.2, () => this.offerUpgrade('バウンティ報酬', `BOUNTY WAVE ${wave} CLEAR ── 強化を1つ選べ`));
      }
      this.endlessTimer = Math.min(this.endlessTimer, 9);
      this.endlessDetailKey = -1;
    }
    this.endlessTimer -= dt;
    if (this.endlessTimer <= 0) {
      if (alive <= 3) this.spawnEndlessWave();
      else this.endlessTimer = 4;
    }
    // keep the objective line current without building a string every frame
    const key = this.endlessActive ? 1000 + alive : Math.max(0, Math.ceil(this.endlessTimer));
    if (key !== this.endlessDetailKey) {
      this.endlessDetailKey = key;
      this.objectiveDetail = this.endlessActive ? `錆牙団 残り ${alive}` : `次の襲撃まで ${key} 秒`;
    }
  }

  private spawnEndlessWave(): void {
    this.endlessWave += 1;
    const wave = this.endlessWave;
    this.endlessActive = true;
    this.endlessTimer = 35 + this.rng() * 15;
    const rigWave = wave % 4 === 0;
    const count = rigWave ? 2 : Math.min(6, 2 + Math.floor((wave + 1) / 2));
    const scale = this.upgrades.enemyHealthScale * (1 + 0.06 * (wave - 1));
    const p = this.player;
    const place = (kind: EnemyKind, variant: number, flank: number): Enemy => {
      // a street point 150-200 m out, preferring one the player cannot see
      let sx = p.x;
      let sz = p.z + 170;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const a = this.rng() * Math.PI * 2;
        const d = 150 + this.rng() * 50;
        const spot = this.roadPointNear(p.x + Math.sin(a) * d, p.z + Math.cos(a) * d);
        const dist = Math.hypot(spot.x - p.x, spot.z - p.z);
        if (dist < 120 || dist > 240) continue;
        let blocked = false;
        this.grid.query(spot.x - 3, spot.x + 3, spot.z - 3, spot.z + 3, (box) => {
          if (spot.x > box.minX - 2.5 && spot.x < box.maxX + 2.5 && spot.z > box.minZ - 2.5 && spot.z < box.maxZ + 2.5) blocked = true;
        });
        if (blocked) continue;
        sx = spot.x;
        sz = spot.z;
        if (!this.grid.lineOfSight(p.x, p.z, spot.x, spot.z)) break;
      }
      const heading = Math.atan2(p.x - sx, p.z - sz);
      const enemy = this.spawnEnemy(kind, variant, sx, sz, heading, flank, scale);
      enemy.vehicle.vx = Math.sin(heading) * 20;
      enemy.vehicle.vz = Math.cos(heading) * 20;
      enemy.holdFire(1.2);
      return enemy;
    };
    if (rigWave) {
      this.boss = place('rig', 0, 1);
      this.audio.play('hornBoss');
      this.audio.setMusicState('boss');
    } else {
      this.audio.setMusicState('battle');
    }
    for (let n = 0; n < count; n += 1) {
      const rammer = (n + wave) % 2 === 0 || (wave > 4 && n % 3 === 0);
      place(rammer ? 'rammer' : 'gunner', rammer ? 1 : n % 2 === 0 ? 0 : 2, n % 2 === 0 ? 1 : -1);
    }
    this.setObjective(`バウンティ WAVE ${wave}`, '');
    this.endlessDetailKey = -1;
    this.hud.toast(rigWave ? `WARNING ── 賞金首 WAVE ${wave}` : `賞金稼ぎ接近 ── WAVE ${wave}`, 'warning');
    this.audio.play('alarm', { volume: 0.7 });
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
    // the open-world raiders do not belong in the cutscene or the wave counts
    for (let i = this.enemies.length - 1; i >= 0; i -= 1) {
      if (!this.enemies[i].alive) continue;
      this.removeEnemy(this.enemies[i]);
      this.enemies.splice(i, 1);
    }
    this.scout = null;
    this.scoutState = 'done';
    this.driveCombat = false;
    this.upgradeQueue.length = 0;
    this.scoring.clearCombo();
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
    this.checkpointData = this.snapshot();
    this.audio.play('checkpoint', { volume: 0.7 });
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
      this.audio.play('hornBoss');
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
        this.sfxAt('hornBoss', this.boss.vehicle.x, this.boss.vehicle.z, 1, 1.12);
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
      const max = this.upgrades.maxArmor;
      const repaired = Math.min(max, this.armor + 45);
      if (repaired > this.armor) {
        this.armor = repaired;
        this.player.model.setDamage(1 - this.armor / max);
        this.audio.play('repair');
      }
      this.hud.toast('WAVE CLEAR ── 応急修理', 'success');
      this.hud.scorePopup('WAVE CLEAR', this.scoring.award(300), 'bonus');
      this.audio.setMusicState('explore');
      const wave = this.stage === 'wave1' ? 1 : 2;
      this.cue(1.2, () => this.offerUpgrade('戦利品', `WAVE ${wave} CLEAR ── 強化を1つ選べ`));
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
    this.hud.scorePopup('MISSION COMPLETE', this.scoring.award(1500), 'bonus');
    this.audio.setMusicState('victory');
    this.hud.toast('ジャガーノート 撃破', 'success');
    this.say(2.6, 'ミラ', '……やった。中継塔は無事よ。ありがとう、ケストレル。次の塔の座標を送るわ──', 5.5);
  }

  // ================================================================ enemies

  private spawnEnemy(kind: EnemyKind, variant: number, x: number, z: number, heading: number, flank: number, healthScale = this.upgrades.enemyHealthScale): Enemy {
    const enemy = new Enemy(kind, variant, flank, this.rng() * 1.5, healthScale);
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
    if (this.lockTarget === enemy) this.lockTarget = null;
    this.missileSystem.forget(enemy);
    for (let i = 0; i < 4; i += 1) if (this.engineNearest[i] === enemy) this.engineNearest[i] = null;
  }

  private clearEnemies(): void {
    for (const enemy of this.enemies) this.removeEnemy(enemy);
    this.enemies.length = 0;
    this.boss = null;
    this.scout = null;
    this.aimTarget = null;
    this.lockTarget = null;
  }

  private damageEnemy(enemy: Enemy, amount: number, cause: DamageCause = 'other', range = 0): void {
    if (!enemy.alive) return;
    enemy.lastHit = cause;
    enemy.lastHitRange = range;
    // getting shot is a fairly clear hint that someone is out there
    if (!enemy.aware) this.onEnemyAlerted(enemy);
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
    if (this.lockTarget === enemy) {
      this.lockTarget = null;
      this.lockProgress = 0;
      this.lockComplete = false;
    }
    this.scoreKill(enemy);
    this.dropLoot(enemy);
  }

  /** Points, chain, style bonuses and the slow-motion beat for a kill. */
  private scoreKill(enemy: Enemy): void {
    const v = enemy.vehicle;
    const stepped = this.scoring.chain();
    const cause = enemy.lastHit;
    let label = enemy.kind === 'rig' ? 'JUGGERNAUT' : 'KILL';
    let bonus = 0;
    if (cause === 'ram') {
      label = 'RAM KILL';
      bonus = 100;
      this.ramKills += 1;
    } else if (cause === 'barrel') {
      label = 'BARREL KILL';
      bonus = 150;
      this.barrelKills += 1;
    } else if (cause === 'missile') {
      label = 'MISSILE KILL';
      bonus = 50;
      this.missileKills += 1;
    } else if (cause === 'cannon' && enemy.lastHitRange > 110) {
      label = 'LONG SHOT';
      bonus = 100;
    }
    this.hud.scorePopup(label, this.scoring.award(KILL_POINTS[enemy.kind] + bonus), 'kill');
    if (stepped) this.audio.play('combo', { pitch: this.scoring.multiplier });
    // multi-kill: two or more inside a second
    if (this.clock - this.lastKillClock < 1.0) this.multiKill += 1;
    else this.multiKill = 1;
    this.lastKillClock = this.clock;
    if (this.multiKill >= 2) {
      const name = this.multiKill === 2 ? 'DOUBLE KILL' : this.multiKill === 3 ? 'TRIPLE KILL' : 'MULTI KILL';
      this.hud.scorePopup(name, this.scoring.award(200 * (this.multiKill - 1)), 'style');
      this.lastStyle = name;
    }
    if ((this.multiKill >= 2 || cause === 'missile' || cause === 'barrel') && this.phase !== 'victory') {
      // a breath of slow motion and a camera punch so the big moments land
      this.timeScale = Math.min(this.timeScale, 0.38);
      this.slowHold = 0.14;
      this.cameraRig.addTrauma(0.3);
      this.impactFx = Math.min(1, this.impactFx + 0.4);
    }
    if (enemy.squad > 0 && enemy.squad < CACHE_SQUAD && !this.squadAlive(enemy.squad)) {
      this.hud.scorePopup('PATROL WIPED', this.scoring.award(250), 'bonus');
    }
    this.vfx.scrapSpray(v.x, v.y + 1, v.z, 3, 0.8);
  }

  /** Every wreck spills salvage; sometimes a repair kit, boost canister or missile crate. */
  private dropLoot(enemy: Enemy): void {
    const v = enemy.vehicle;
    const rig = enemy.kind === 'rig';
    const count = rig ? 12 : 2 + Math.floor(this.rng() * 4);
    for (let n = 0; n < count; n += 1) {
      const a = this.rng() * Math.PI * 2;
      const s = 3.5 + this.rng() * (rig ? 9 : 5.5);
      this.pickups.spawn('scrap', v.x, v.z, rig ? 2 : 1, 40, Math.sin(a) * s + v.vx * 0.3, 7 + this.rng() * 5, Math.cos(a) * s + v.vz * 0.3, this.rng() * 6);
    }
    const max = this.upgrades.maxArmor;
    let special: PickupKind | null = null;
    const roll = this.rng();
    if (this.armor < max * 0.35 || rig) special = 'repair';
    else if (roll < 0.16) special = 'repair';
    else if (roll < 0.3) special = 'boost';
    else if (roll < 0.5) special = this.missiles < this.upgrades.missileMax ? 'missile' : 'boost';
    if (special) {
      const a = this.rng() * Math.PI * 2;
      this.pickups.spawn(special, v.x, v.z, 1, 45, Math.sin(a) * 4, 9, Math.cos(a) * 4, this.rng() * 6);
    }
    if (rig) this.pickups.spawn('missile', v.x, v.z, 1, 45, 3, 10, -3, 1);
  }

  private collectPickup(pickup: Pickup): void {
    const [r, g, b] = PICKUP_COLORS[pickup.kind];
    const max = this.upgrades.maxArmor;
    this.pickupsCollected += 1;
    this.vfx.collectBurst(pickup.x, pickup.y + 0.2, pickup.z, r, g, b, pickup.kind !== 'scrap');
    if (pickup.kind === 'scrap') {
      this.scoring.scrap += pickup.value;
      this.scrapBank += pickup.value;
      this.scrapPopup += this.scoring.award(10 * pickup.value);
      this.scrapPopupTimer = 0.4;
      // the audio system climbs its own pitch ladder on quick repeats
      this.audio.play('pickupScrap');
      if (this.scrapBank >= SCRAP_PER_FAB) {
        this.scrapBank -= SCRAP_PER_FAB;
        if (this.missiles < this.upgrades.missileMax) {
          this.missiles += 1;
          this.hud.toast('スクラップ再生 ── ミサイル +1', 'success');
          this.audio.play('pickupMissile', { volume: 0.8 });
        } else {
          this.armor = Math.min(max, this.armor + 10);
          this.player.model.setDamage(1 - this.armor / max);
          this.hud.toast('スクラップ再生 ── 装甲 +10', 'success');
          this.audio.play('pickupRepair', { volume: 0.8 });
        }
      }
    } else if (pickup.kind === 'repair') {
      const before = this.armor;
      this.armor = Math.min(max, this.armor + 30);
      this.player.model.setDamage(1 - this.armor / max);
      this.hud.scorePopup('REPAIR', Math.round(this.armor - before), 'pickup');
      this.audio.play('pickupRepair');
    } else if (pickup.kind === 'boost') {
      this.boost = 1;
      this.boostLock = 0;
      this.hud.scorePopup('BOOST', 100, 'pickup');
      this.audio.play('pickupBoost');
    } else {
      if (this.missiles < this.upgrades.missileMax) {
        this.missiles += 1;
        this.hud.scorePopup('MISSILE', 1, 'pickup');
      } else {
        this.hud.scorePopup('SALVAGE', this.scoring.award(100), 'pickup');
      }
      this.audio.play('pickupMissile');
    }
  }

  /** Per-step bookkeeping for the chain timer, batched scrap popups and lingering fuel fires. */
  private updateScoreFeedback(dt: number, playing: boolean): void {
    if (playing && this.scoring.update(dt)) this.audio.play('comboBreak', { volume: 0.8 });
    if (this.scrapPopup > 0) {
      this.scrapPopupTimer -= dt;
      if (this.scrapPopupTimer <= 0) {
        this.hud.scorePopup('SCRAP', this.scrapPopup, 'pickup');
        this.scrapPopup = 0;
      }
    }
    for (const burn of this.burns) {
      if (burn.life <= 0) continue;
      burn.life -= dt;
      if (this.rng() < dt * 18) this.vfx.fire(burn.x + (this.rng() - 0.5) * 2.2, burn.y + 0.3, burn.z + (this.rng() - 0.5) * 2.2, 1.2);
    }
  }

  /** Drift and near-miss detection. Both pay score, extend the chain and top up the boost tank. */
  private updateStyle(dt: number): void {
    const p = this.player;
    const crashed = p.impact > 6 || p.softImpact > 0 || this.contactThisStep;
    if (this.drift.time > 0.4) this.boost = Math.min(1, this.boost + dt * 0.03);
    const driftPoints = this.drift.update(dt, p, crashed);
    if (driftPoints > 0) {
      this.driftCount += 1;
      this.boost = Math.min(1, this.boost + 0.05);
      this.styleEvent('DRIFT', driftPoints, 'driftScore');
    }
    const gap = this.nearMiss.update(dt, p, this.grid, p.impact > 1.5 || p.softImpact > 0 || this.contactThisStep, NEAR_MISS_SPEED);
    if (gap >= 0) {
      this.nearMissCount += 1;
      this.boost = Math.min(1, this.boost + 0.1);
      this.styleEvent('NEAR MISS', 120 + Math.round((1 - Math.min(1, gap)) * 8) * 10, 'nearMiss');
    }
  }

  private styleEvent(label: string, points: number, sfx: SfxName): void {
    const stepped = this.scoring.chain();
    this.hud.scorePopup(label, this.scoring.award(points), 'style');
    this.audio.play(sfx);
    if (stepped) this.audio.play('combo', { pitch: this.scoring.multiplier });
    this.lastStyle = label;
  }

  private resolveVehicleContacts(): void {
    const p = this.player;
    for (let i = 0; i < this.enemies.length; i += 1) {
      const enemy = this.enemies[i];
      const closing = collideVehicles(p, enemy.vehicle, PLAYER_RADIUS, enemy.bodyRadius);
      if (closing > 0) this.contactThisStep = true;
      if (closing > 5 && enemy.alive && enemy.ramCooldown <= 0) {
        enemy.ramCooldown = 0.7;
        const rig = enemy.kind === 'rig';
        const playerDriven = Math.abs(p.forwardSpeed) > Math.abs(enemy.vehicle.forwardSpeed);
        // the ram prow upgrade hits harder and shrugs off more of the recoil
        this.damageEnemy(enemy, (closing - 5) * (rig ? 1.1 : playerDriven ? 3.0 : 1.4) * this.upgrades.ramDamage, 'ram');
        this.hurtPlayer(Math.min(rig ? 16 : 13, (closing - 5) * (rig ? 1.1 : playerDriven ? 0.2 : 0.42)) * this.upgrades.ramSelfDamage, enemy.vehicle.x, enemy.vehicle.z, 'ram');
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

  /** Drums are solid for everyone; the player ramming one at speed sets it off. */
  private resolveDrumContacts(): void {
    const drums = this.drums.drums;
    const p = this.player;
    for (let i = 0; i < drums.length; i += 1) {
      const drum = drums[i];
      if (!drum.alive) continue;
      if (Math.abs(drum.x - p.x) < 6 && Math.abs(drum.z - p.z) < 6) {
        const hit = this.pushOffDrum(p, drum.x, drum.z);
        if (hit > 12 && this.playing()) {
          this.drums.ignite(i, 0.02);
          this.contactThisStep = true;
        } else if (hit > 0) this.contactThisStep = true;
      }
      for (const enemy of this.enemies) {
        const v = enemy.vehicle;
        if (Math.abs(drum.x - v.x) < 8 && Math.abs(drum.z - v.z) < 8) this.pushOffDrum(v, drum.x, drum.z);
      }
    }
  }

  /** Circle-vs-circle for both ends of a vehicle; returns the approach speed if it touched, else 0. */
  private pushOffDrum(v: Vehicle, dx: number, dz: number): number {
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    let touched = 0;
    for (let sign = -1; sign <= 1; sign += 2) {
      const cx = v.x + fx * v.circleOffset * sign;
      const cz = v.z + fz * v.circleOffset * sign;
      const nx = cx - dx;
      const nz = cz - dz;
      const d = Math.hypot(nx, nz);
      const min = v.circleRadius + DRUM_RADIUS;
      if (d >= min || d < 1e-4) continue;
      const ux = nx / d;
      const uz = nz / d;
      const vn = v.vx * ux + v.vz * uz;
      touched = Math.max(touched, Math.max(0.01, -vn));
      v.x += ux * (min - d);
      v.z += uz * (min - d);
      if (vn < 0) {
        v.vx -= vn * ux * 1.1;
        v.vz -= vn * uz * 1.1;
      }
    }
    return touched;
  }

  // ================================================================ player combat

  private updateAim(dt: number): void {
    const p = this.player;
    let best: Enemy | null = null;
    let bestScore = 1.05;
    if (this.playing()) {
      for (const enemy of this.enemies) {
        if (!enemy.alive) continue;
        const dx = enemy.vehicle.x - p.x;
        const dz = enemy.vehicle.z - p.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 170 || dist < 2) continue;
        const off = Math.abs(wrapAngle(Math.atan2(dx, dz) - p.heading));
        // raiders that have not noticed the player are only targeted when they are right ahead
        if (!enemy.aware && (off > 0.5 || dist > 120)) continue;
        const score = off * 0.55 + dist * 0.0012 + (enemy.aware ? 0 : 0.25);
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
      this.heat += this.upgrades.heatPerShot;
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
      this.spawnProjectile(_v.x, _v.y, _v.z, dx * inv, dy * inv, dz * inv, 230, this.upgrades.cannonDamage, true);
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

  // ---------------------------------------------------------------- missiles

  /** Hold a target inside the forward cone to build a lock; it sticks to that target while it stays valid. */
  private updateMissileLock(dt: number): void {
    const p = this.player;
    let target: Enemy | null = null;
    if (this.playing() && this.missiles > 0) {
      const current = this.lockTarget;
      if (current && current.alive && this.lockable(current, LOCK_CONE * 1.25)) target = current;
      else {
        let bestScore = 1e9;
        for (const enemy of this.enemies) {
          if (!enemy.alive || !this.lockable(enemy, LOCK_CONE)) continue;
          const dx = enemy.vehicle.x - p.x;
          const dz = enemy.vehicle.z - p.z;
          const score = Math.abs(wrapAngle(Math.atan2(dx, dz) - p.heading)) + Math.hypot(dx, dz) * 0.002 + (enemy.aware ? 0 : 0.3);
          if (score < bestScore) {
            bestScore = score;
            target = enemy;
          }
        }
      }
    }
    if (target !== this.lockTarget) {
      this.lockTarget = target;
      this.lockProgress = 0;
      this.lockComplete = false;
    }
    if (!target) return;
    if (this.lockComplete) return;
    this.lockProgress += dt / LOCK_TIME;
    if (this.lockProgress >= 1) {
      this.lockProgress = 1;
      this.lockComplete = true;
      this.audio.play('missileLock');
      if (!this.missileTaught) {
        this.missileTaught = true;
        this.say(0, 'ミラ', 'ロックオン完了。E キー（右クリック／MSL）で誘導ミサイルを撃って！', 4.5);
      }
    }
  }

  private lockable(enemy: Enemy, cone: number): boolean {
    const p = this.player;
    const dx = enemy.vehicle.x - p.x;
    const dz = enemy.vehicle.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > LOCK_RANGE || dist < 6) return false;
    if (!enemy.aware && dist > 130) return false;
    if (Math.abs(wrapAngle(Math.atan2(dx, dz) - p.heading)) > cone) return false;
    return this.grid.lineOfSight(p.x, p.z, enemy.vehicle.x, enemy.vehicle.z);
  }

  private fireMissile(): void {
    if (this.missileCooldown > 0) return;
    if (this.missiles <= 0) {
      this.missileCooldown = 0.3;
      this.audio.play('uiClick', { volume: 0.6, pitch: 0.7 });
      return;
    }
    const p = this.player;
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    // alternate rails either side of the roof
    this.missileSide = -this.missileSide;
    const x = p.x + fz * this.missileSide * 0.95 + fx * 0.4;
    const z = p.z - fx * this.missileSide * 0.95 + fz * 0.4;
    const y = p.y + 1.45;
    const target = this.lockComplete ? this.lockTarget : null;
    if (!this.missileSystem.launch(x, y, z, fx, target ? 0.16 : 0.02, fz, Math.max(0, p.forwardSpeed), target)) return;
    this.missiles -= 1;
    this.missilesFired += 1;
    this.missileCooldown = 0.55;
    this.lockProgress = this.lockComplete ? 0.45 : 0;
    this.lockComplete = false;
    this.vfx.muzzleFlash(x, y, z, fx, 0.1, fz, 2.4);
    this.vfx.missileTrail(x, y, z, fx, 0, fz, true);
    this.audio.play('missileLaunch');
    this.cameraRig.addTrauma(0.24);
    // launch recoil: a small shove back through the chassis
    p.vx -= fx * 0.9;
    p.vz -= fz * 0.9;
    this.impactFx = Math.min(1, this.impactFx + 0.18);
  }

  private detonateMissile(x: number, y: number, z: number, direct: Enemy | null, drum: number): void {
    const gy = groundHeight(x, z);
    this.vfx.explosion(x, Math.max(gy, y - 0.8), z, 1.25);
    this.sfxAt('explosionBig', x, z, 1, 1.15);
    const dist = Math.hypot(x - this.player.x, z - this.player.z);
    this.cameraRig.addTrauma(Math.max(0.12, 0.6 * (1 - dist / 120)));
    if (direct) {
      this.hud.hitMarker(false);
      this.damageEnemy(direct, MISSILE.directDamage + 18, 'missile', dist);
    }
    this.blast(x, z, MISSILE.blastRadius, MISSILE.directDamage, 'missile', 0, direct);
    if (drum >= 0) this.drums.ignite(drum, 0.01);
  }

  /**
   * Area damage with linear falloff to 25% at the rim. Hurts every enemy in range
   * (the direct-hit target is skipped: it already took the full hit), lights nearby
   * fuel drums and, when `playerDamage` > 0, the player too.
   */
  private blast(x: number, z: number, radius: number, damage: number, cause: DamageCause, playerDamage: number, skip: Enemy | null): void {
    const p = this.player;
    const origin = Math.hypot(x - p.x, z - p.z);
    for (const enemy of this.enemies) {
      if (!enemy.alive || enemy === skip) continue;
      const d = Math.max(0, Math.hypot(enemy.vehicle.x - x, enemy.vehicle.z - z) - enemy.hitRadius * 0.6);
      if (d >= radius) continue;
      this.damageEnemy(enemy, damage * (1 - 0.75 * (d / radius)), cause, origin);
      // shove the survivors outward
      const inv = 1 / Math.max(1, Math.hypot(enemy.vehicle.x - x, enemy.vehicle.z - z));
      const push = (enemy.kind === 'rig' ? 1 : 7) * (1 - d / radius);
      enemy.vehicle.vx += (enemy.vehicle.x - x) * inv * push;
      enemy.vehicle.vz += (enemy.vehicle.z - z) * inv * push;
    }
    const drums = this.drums.drums;
    for (let i = 0; i < drums.length; i += 1) {
      const drum = drums[i];
      if (!drum.alive || drum.fuse >= 0) continue;
      const d = Math.hypot(drum.x - x, drum.z - z);
      if (d < radius * 0.82) this.drums.ignite(i, 0.12 + (d / radius) * 0.22 + this.rng() * 0.08);
    }
    if (playerDamage > 0 && origin < radius + 1) {
      const fall = 1 - 0.7 * (origin / (radius + 1));
      this.hurtPlayer(playerDamage * fall, x, z, 'blast');
      const inv = 1 / Math.max(0.5, origin);
      p.vx += (p.x - x) * inv * 7 * fall;
      p.vz += (p.z - z) * inv * 7 * fall;
    }
  }

  // ---------------------------------------------------------------- fuel drums

  private updateDrums(dt: number): void {
    let due = this.drums.nextDue(dt);
    while (due >= 0) {
      this.detonateDrum(due);
      due = this.drums.nextDue(0);
    }
  }

  private detonateDrum(index: number): void {
    const drum = this.drums.drums[index];
    const { x, y, z } = drum;
    this.drums.remove(index);
    this.drumsDetonated += 1;
    this.vfx.fuelBlast(x, y, z, 1.3);
    this.sfxAt('barrelExplosion', x, z, 1, 0.92 + this.rng() * 0.16);
    const dist = Math.hypot(x - this.player.x, z - this.player.z);
    this.cameraRig.addTrauma(Math.max(0, 0.7 * (1 - dist / 80)));
    this.impactFx = Math.min(1, this.impactFx + Math.max(0, 0.5 * (1 - dist / 40)));
    for (const burn of this.burns) {
      if (burn.life > 0) continue;
      burn.x = x;
      burn.y = y;
      burn.z = z;
      burn.life = 3.5;
      break;
    }
    // enemies take the full blast; the player's armour soaks most of it
    this.blast(x, z, DRUM_BLAST_RADIUS, DRUM_DAMAGE, 'barrel', this.playing() ? 20 : 0, null);
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
      p.whiz = false;
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
    this.ricochetTimer -= dt;
    this.whizTimer -= dt;
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
      // fuel drums: anyone's stray round can set one off
      let drum = -1;
      if (p.y < 2.1) {
        drum = this.drums.segmentHit(p.x, p.z, nx, nz, 0.12);
        if (drum >= 0 && this.drums.hitT <= reach) {
          reach = this.drums.hitT;
          hit = true;
        } else drum = -1;
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
            this.damageEnemy(struck, p.damage, 'cannon', Math.hypot(sx - p.ox, sz - p.oz));
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
        if (drum >= 0) {
          this.drums.ignite(drum, 0.05);
          if (p.player) this.hud.hitMarker(false);
        } else if (p.player && this.ricochetTimer <= 0) {
          this.ricochetTimer = 0.16;
          this.sfxAt('ricochet', hx, hz, 0.55, 0.85 + this.rng() * 0.4);
        }
      }
      if (!hit && !p.player && !p.whiz) {
        // fly-by: the round has just passed the car without connecting
        const tx = player.x - nx;
        const tz = player.z - nz;
        const along = tx * p.dx + tz * p.dz;
        if (along < 0) {
          p.whiz = true;
          const lateral = tx * tx + tz * tz - along * along;
          if (lateral < 3.2 * 3.2 && along > -8 && this.whizTimer <= 0 && this.playing()) {
            this.whizTimer = 0.12;
            // right-hand vector is (-fz, fx): pan toward the side it passed on
            const side = tx * -Math.cos(player.heading) + tz * Math.sin(player.heading);
            this.audio.play('bulletWhiz', { volume: 0.7, pan: side > 0 ? -0.6 : 0.6, pitch: 0.9 + this.rng() * 0.25 });
          }
        }
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
        if (Math.hypot(enemy.vehicle.x - m.x, enemy.vehicle.z - m.z) < MORTAR_RADIUS) this.damageEnemy(enemy, 55, 'mortar');
      }
      // a shell landing on fuel is everybody's problem
      for (let i = 0; i < this.drums.drums.length; i += 1) {
        const drum = this.drums.drums[i];
        if (drum.alive && Math.hypot(drum.x - m.x, drum.z - m.z) < MORTAR_RADIUS * 0.8) this.drums.ignite(i, 0.05 + this.rng() * 0.2);
      }
    }
  }

  private handlePlayerImpact(): void {
    const p = this.player;
    if (p.softImpact > 0) {
      // ploughed a street wreck aside: lose speed and a little armour instead of stopping dead
      const speed = p.softImpact;
      p.softImpact = 0;
      const dirX = p.vx / Math.max(1, p.speed);
      const dirZ = p.vz / Math.max(1, p.speed);
      this.vfx.sparks(p.softX, 0.9, p.softZ, dirX, 0.7, dirZ, 16, 1.1);
      this.vfx.scrapSpray(p.softX, 1.0, p.softZ, 7, 0.9);
      this.vfx.dust(p.softX, 0.3, p.softZ, dirX * 6, dirZ * 6, 1);
      this.sfxAt('wreckSmash', p.softX, p.softZ, Math.min(1, 0.6 + speed / 80), 0.95 + this.rng() * 0.1);
      this.cameraRig.addTrauma(Math.min(0.55, 0.2 + speed / 110));
      this.impactFx = Math.min(1, this.impactFx + 0.3);
      if (this.playing()) {
        this.hurtPlayer(Math.min(7, (speed - 14) * 0.2), p.softX, p.softZ, 'wall');
        // wrecks are salvage too
        if (this.rng() < 0.5) this.pickups.spawn('scrap', p.softX, p.softZ, 1, 30, dirX * 9 + (this.rng() - 0.5) * 5, 8, dirZ * 9 + (this.rng() - 0.5) * 5, this.rng() * 6);
      }
    }
    if (p.impact < 4) return;
    const hx = p.x - p.impactNx * 1.2;
    const hz = p.z - p.impactNz * 1.2;
    this.vfx.sparks(hx, 0.7, hz, p.impactNx, 0.5, p.impactNz, Math.min(16, Math.round(p.impact)));
    if (p.impact > 7) {
      this.sfxAt(p.impact > 20 ? 'wreckSmash' : 'crash', hx, hz, Math.min(1, p.impact / 30), 1);
      this.cameraRig.addTrauma(Math.min(0.7, p.impact / 45));
    }
    if (p.impact > 14 && this.playing()) this.hurtPlayer((p.impact - 14) * 0.55, hx, hz, 'wall');
  }

  private hurtPlayer(amount: number, fromX: number, fromZ: number, source: DamageSource = 'shot'): void {
    if (amount <= 0 || !this.playing()) return;
    const max = this.upgrades.maxArmor;
    const danger = max * 0.3;
    if (this.armor >= danger && this.armor - amount < danger && this.armor - amount > 0) {
      this.audio.play('lowArmor');
      this.hud.toast('装甲危険 ── ARMOR CRITICAL', 'warning');
    }
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
    p.model.setDamage(1 - Math.max(0, this.armor) / max);
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
    this.upgradeOffer = null;
    this.upgradeQueue.length = 0;
    this.lockTarget = null;
    this.lockProgress = 0;
    this.lockComplete = false;
    if (this.scoring.comboCount >= 2) this.audio.play('comboBreak', { volume: 0.6 });
    this.scoring.clearCombo();
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
    const armor01 = this.armor / this.upgrades.maxArmor;
    if (armor01 < 0.45 && this.rng() < dt * (armor01 < 0.22 ? 26 : 10)) {
      this.vfx.damageSmoke(p.x + Math.sin(p.heading) * 1.4, p.y + 1.0, p.z + Math.cos(p.heading) * 1.4, armor01 < 0.22);
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

  private updateAudio(delta: number): void {
    const p = this.player;
    const playing = this.playing();
    const driving = playing || this.phase === 'event';
    const live = driving && !this.paused && !this.upgradeOffer;
    if (live) {
      const speed01 = Math.min(1, p.speed / HERO_TUNING.boostSpeed);
      const gear = Math.min(4, Math.floor(speed01 * 5));
      const within = speed01 * 5 - gear;
      const rpm = this.phase === 'event' ? 0.12 : 0.22 + within * 0.62 + gear * 0.035;
      const throttle = Math.max(0, p.controls.throttle);
      this.audio.setEngine(Math.min(1, rpm), throttle, speed01, this.boosting);
      this.audio.setSkid(Math.min(1, Math.max(0, Math.abs(p.slip) - 2.5) / 9));
      // gearbox and turbo: the car answers the right foot
      this.gearTimer -= delta;
      this.blowoffTimer -= delta;
      if (gear !== this.lastGear) {
        if (playing && throttle > 0.2 && this.gearTimer <= 0) {
          this.gearTimer = 0.28;
          this.audio.play('gearShift', { volume: 0.6, pitch: gear > this.lastGear ? 0.94 + gear * 0.04 : 0.84 });
        }
        this.lastGear = gear;
      }
      const boostEnded = this.wasBoosting && !this.boosting;
      const lifted = this.lastThrottle > 0.5 && throttle <= 0.05 && rpm > 0.62 && p.speed > 26;
      if (playing && (boostEnded || lifted) && this.blowoffTimer <= 0) {
        this.blowoffTimer = 1.4;
        this.audio.play('turboBlowoff', { volume: boostEnded ? 0.8 : 0.55, pitch: boostEnded ? 1 : 1.12 });
      }
      this.wasBoosting = this.boosting;
      this.lastThrottle = throttle;
    }
    this.audio.setAmbience(0.55 + Math.min(0.4, p.speed / 120));

    // combat pressure and the engines of whoever is closing in
    const sources = this.engineList;
    sources.length = 0;
    let pressure = 0;
    if (live) {
      // each engine voice keeps its enemy until that enemy dies or drives out of earshot,
      // so the array order stays stable from frame to frame
      const slots = this.engineNearest;
      for (let i = 0; i < 4; i += 1) {
        const held = slots[i];
        if (held && (!held.alive || Math.hypot(held.vehicle.x - p.x, held.vehicle.z - p.z) > 175)) slots[i] = null;
      }
      for (const enemy of this.enemies) {
        if (!enemy.alive) continue;
        const d = Math.hypot(enemy.vehicle.x - p.x, enemy.vehicle.z - p.z);
        if (enemy.aware) pressure += Math.max(0, 1 - d / 130) * (enemy.kind === 'rig' ? 0.6 : 0.28) + 0.04;
        if (d > 150 || slots[0] === enemy || slots[1] === enemy || slots[2] === enemy || slots[3] === enemy) continue;
        for (let i = 0; i < 4; i += 1) {
          if (slots[i]) continue;
          slots[i] = enemy;
          break;
        }
      }
      this.camera.getWorldDirection(_v2);
      const cam = this.camera.position;
      for (let i = 0; i < 4; i += 1) {
        const enemy = slots[i];
        const source = this.enginePool[i];
        sources.push(source);
        if (!enemy) {
          // empty slot: far beyond earshot, so the voice stays silent without shifting the others
          source.distance = 9999;
          source.pan = 0;
          source.rpm01 = 0;
          source.heavy = false;
          continue;
        }
        const v = enemy.vehicle;
        const dx = v.x - cam.x;
        const dz = v.z - cam.z;
        const dist = Math.hypot(dx, dz);
        source.distance = dist;
        // same pan convention as sfxAt: screen-right is (-fz, fx)
        source.pan = Math.max(-0.9, Math.min(0.9, (dx * -_v2.z + dz * _v2.x) / Math.max(1, dist)));
        source.rpm01 = Math.min(1, 0.18 + (v.speed / v.tuning.boostSpeed) * 0.8);
        source.heavy = enemy.kind === 'rig';
      }
      if (playing) {
        const armor01 = this.armor / this.upgrades.maxArmor;
        pressure += armor01 < 0.3 ? 0.35 : armor01 < 0.5 && pressure > 0 ? 0.15 : 0;
      }
    }
    const target = Math.max(0, Math.min(1, pressure));
    this.threat += (target - this.threat) * Math.min(1, delta * (target > this.threat ? 3 : 0.8));
    this.audio.setThreat(this.threat);
    this.audio.setEnemyEngines(sources);
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
    if (this.upgradeOffer) return 'upgrade';
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
    f.armor01 = Math.max(0, this.armor / this.upgrades.maxArmor);
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
    f.stats.score = this.scoring.score;
    f.stats.bestCombo = this.scoring.bestCombo;
    f.stats.scrap = this.scoring.scrap;
    f.stats.rank = computeRank(this.scoring.score, this.runTime, this.damageTaken);
    f.score = this.scoring.score;
    f.scrap = this.scoring.scrap;
    f.combo.count = this.scoring.comboCount;
    f.combo.multiplier = this.scoring.multiplier;
    f.combo.timer01 = this.scoring.timer01;
    f.missiles = this.missiles;
    f.missileMax = this.upgrades.missileMax;
    f.upgrade = this.upgradeOffer;
    this.pushTargets();

    // optional objectives: the supply caches
    const cacheCount = this.caches.caches.length;
    const opened = this.caches.openedCount;
    this.sideObjectives.length = 0;
    if (cacheCount > 0 && this.playing()) {
      const side = this.cacheObjective;
      if (opened !== this.cacheLabelCount) {
        this.cacheLabelCount = opened;
        side.label = `補給キャッシュ ${opened}/${cacheCount}`;
      }
      side.done = opened >= cacheCount;
      let nearest = -1;
      for (const cache of this.caches.caches) {
        if (cache.opened) continue;
        const d = Math.hypot(cache.x - p.x, cache.z - p.z);
        if (nearest < 0 || d < nearest) nearest = d;
      }
      side.distanceM = nearest < 0 ? null : nearest;
      this.sideObjectives.push(side);
    }

    let ox: number | null = null;
    let oz = 0;
    if (this.phase === 'drive' && this.scoutState === 'active' && this.scout) {
      ox = this.scout.vehicle.x;
      oz = this.scout.vehicle.z;
    } else if (this.phase === 'endless') {
      // point at the nearest bounty hunter
      let best = 1e9;
      for (const enemy of this.enemies) {
        if (!enemy.alive) continue;
        const d = Math.hypot(enemy.vehicle.x - p.x, enemy.vehicle.z - p.z);
        if (d < best) {
          best = d;
          ox = enemy.vehicle.x;
          oz = enemy.vehicle.z;
        }
      }
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
    let hostile = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      alive += 1;
      if (enemy.aware) hostile += 1;
      blip(enemy.vehicle.x, enemy.vehicle.z, enemy.kind === 'rig' ? 'boss' : enemy.aware ? 'enemy' : 'patrol');
    }
    for (const m of this.mortars) if (m.active) blip(m.x, m.z, 'mortar');
    if (this.playing()) {
      blip(this.layout.relay.x, this.layout.relay.z, 'objective');
      for (const cache of this.caches.caches) if (!cache.opened) blip(cache.x, cache.z, 'cache');
      // nearby salvage and every special pickup
      this.blipCount = count;
      this.pickups.forEachActive(this.pickupBlip);
      count = this.blipCount;
    }
    this.blips.length = count;
    f.enemiesRemaining = this.phase === 'battle' || this.phase === 'endless' ? alive : this.phase === 'drive' && hostile > 0 ? hostile : null;
    if (this.boss && this.boss.alive && (this.stage === 'boss' || this.phase === 'endless')) {
      if (!f.boss) f.boss = { name: 'ウォーリグ《ジャガーノート》', hp01: 1 };
      f.boss.hp01 = Math.max(0, this.boss.health / this.boss.maxHealth);
    } else {
      f.boss = null;
    }
    this.hud.update(f);
  }

  private blipCount = 0;
  private readonly pickupBlip = (pickup: Pickup) => {
    if (this.blipCount >= 48) return;
    const p = this.player;
    if (pickup.kind === 'scrap' && (Math.abs(pickup.x - p.x) > 130 || Math.abs(pickup.z - p.z) > 130)) return;
    if (this.blipCount >= this.blips.length) this.blips.push({ x: 0, z: 0, kind: 'pickup' });
    const b = this.blips[this.blipCount];
    b.x = -pickup.x;
    b.z = pickup.z;
    b.kind = 'pickup';
    this.blipCount += 1;
  };

  /** Screen-space reticles: cannon auto-aim, missile lock and the nearest unopened cache. */
  private pushTargets(): void {
    this.targets.length = 0;
    if (!this.playing()) return;
    const p = this.player;
    this.camera.updateMatrixWorld();
    const aim = this.aimTarget;
    if (aim && aim.alive) {
      this.pushTarget(aim.vehicle.x, aim.vehicle.y + 1.0, aim.vehicle.z, 'aim', Math.max(0, aim.health / aim.maxHealth));
    }
    const lock = this.lockTarget;
    if (lock && lock.alive && this.lockProgress > 0) {
      this.pushTarget(lock.vehicle.x, lock.vehicle.y + 1.0, lock.vehicle.z, this.lockComplete ? 'locked' : 'locking', this.lockComplete ? Math.max(0, lock.health / lock.maxHealth) : this.lockProgress);
    }
    let best = 240;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const cache of this.caches.caches) {
      if (cache.opened) continue;
      const d = Math.hypot(cache.x - p.x, cache.z - p.z);
      if (d < best) {
        best = d;
        cx = cache.x;
        cy = cache.y + 2.6;
        cz = cache.z;
      }
    }
    if (best < 240) this.pushTarget(cx, cy, cz, 'cache', 1);
  }

  private pushTarget(x: number, y: number, z: number, kind: HudTargetMarker['kind'], value01: number): void {
    const camera = this.camera;
    _v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    if (_v.z > -0.6) return;
    _v.applyMatrix4(camera.projectionMatrix);
    if (Math.abs(_v.x) > 1.15 || Math.abs(_v.y) > 1.15) return;
    const index = this.targets.length;
    if (index >= this.targetPool.length) this.targetPool.push({ sx: 0, sy: 0, kind, value01: 0, distanceM: 0 });
    const marker = this.targetPool[index];
    marker.sx = (_v.x * 0.5 + 0.5) * this.canvas.clientWidth;
    marker.sy = (-_v.y * 0.5 + 0.5) * this.canvas.clientHeight;
    marker.kind = kind;
    marker.value01 = value01;
    marker.distanceM = Math.hypot(x - this.player.x, z - this.player.z);
    this.targets.push(marker);
  }

  private render(): void {
    this.renderer.info.reset();
    const danger = this.upgrades.maxArmor * 0.3;
    const lowArmor = this.phase === 'failed' ? 0.75 : this.armor < danger && this.phase !== 'title' ? (1 - this.armor / danger) * 0.4 : 0;
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
      this.applyPlayerIntents(steer, throttle, fire, false, false, false, dt);
      this.stepSim(dt);
      this.updateCamera(dt);
    }
  }

  /** Test states: free roam with the scout and tutorial chatter out of the way. */
  private startQuietRun(x: number, z: number, heading: number): void {
    this.startRun();
    this.cues.length = 0;
    this.scoutState = 'done';
    this.missileTaught = true;
    this.patrolTaught = true;
    this.player.place(x, z, heading);
    this.turretYaw = heading;
    this.cameraRig.snapTo(this.player);
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
    } else if (name === 'complete' || name === 'endless') {
      this.startRun();
      this.cues.length = 0;
      this.relayPower = 1;
      this.relay.setPower(1);
      this.player.place(relay.x + 3, relay.z - 52, 0);
      this.kills = 11;
      this.damageTaken = 64;
      this.runTime = 318;
      this.scoring.score = 7450;
      this.scoring.scrap = 86;
      this.scoring.bestCombo = 9;
      this.checkpoint = 'battle';
      this.phase = 'complete';
      this.setObjective('任務完了', '第7中継塔 確保');
      this.simulate(0.5, 0, 0, false);
      if (name === 'endless') {
        // the path the HUD's "フリーローム続行" button takes, then run until the first bounty wave is in
        this.continueEndless();
        this.cues.length = 0;
        this.simulate(5.4, 0, 0, false);
      }
    } else if (name === 'pickups') {
      // a scrap trail ahead plus one of each special pickup
      const spot = this.streetScrap[0];
      this.startQuietRun(spot.x, spot.z - 15, 0);
      this.pickups.spawn('repair', spot.x - 3.6, spot.z - 4, 1);
      this.pickups.spawn('boost', spot.x + 0.4, spot.z - 5, 1);
      this.pickups.spawn('missile', spot.x + 4, spot.z - 4, 1);
      this.simulate(0.4, 0, 0, false);
    } else if (name === 'drums') {
      // parked short of the nearest kerb-side drum stack, two raiders idling beside it
      const drum = this.testDrum();
      const lane = Math.abs(drum.x - Math.round(drum.x / CITY.pitch) * CITY.pitch) < 14;
      const side = drum.x > Math.round(drum.x / CITY.pitch) * CITY.pitch ? -1 : 1;
      this.startQuietRun(lane ? drum.x + side * 5 : drum.x, drum.z - 14, 0);
      const a = this.spawnEnemy('gunner', 0, drum.x + side * 3.2, drum.z + 1.5, Math.PI, 1, 1);
      const b = this.spawnEnemy('rammer', 1, drum.x + side * 3.4, drum.z - 4.5, Math.PI, -1, 1);
      a.setGuard();
      b.setGuard();
      a.squad = 50;
      b.squad = 50;
      this.simulate(0.4, 0, 0, false);
    } else if (name === 'missile') {
      // a raider dead ahead: the lock is complete and one missile is already on its way
      this.startQuietRun(this.clearLane(relay.x - CITY.pitch / 2, relay.z - 150, 150), relay.z - 150, 0);
      this.player.vz = 24;
      const target = this.spawnEnemy('gunner', 0, this.player.x - 2, this.player.z + 75, 0, 1, 1);
      target.vehicle.vz = 22;
      target.holdFire(30);
      this.missiles = 4;
      this.simulate(1.0, 0.7, 0, false);
      this.fireMissile();
      this.simulate(0.22, 0.7, 0, false);
    } else if (name === 'cache' || name === 'cache-clear') {
      // on the approach line of the first supply cache; guards parked (or already dealt with)
      const cache = this.caches.caches[0];
      if (!cache) throw new Error('No supply cache was placed');
      const back = name === 'cache' ? 30 : 13;
      this.startQuietRun(cache.x + cache.ax * back, cache.z + cache.az * back, Math.atan2(-cache.ax, -cache.az));
      this.updateOpenWorld();
      if (name === 'cache-clear') {
        for (const enemy of this.enemies) if (enemy.squad === CACHE_SQUAD) this.destroyEnemy(enemy);
        this.simulate(0.6, 0, 0, false);
      } else {
        for (const enemy of this.enemies) enemy.holdFire(4);
        this.simulate(0.3, 0, 0, false);
      }
    } else if (name === 'upgrade') {
      this.startQuietRun(roadCenter(4) + 5.5, -322, 0);
      this.player.vz = 30;
      this.simulate(1.0, 1, 0, false);
      this.offerUpgrade('戦利品', 'WAVE 1 CLEAR ── 強化を1つ選べ');
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

  /** The drum stack nearest the start that sits beside a north-south street (test states only). */
  private testDrum(): { x: number; z: number } {
    let best = this.drums.drums[0];
    let bestD = 1e9;
    for (const drum of this.drums.drums) {
      const offX = Math.abs(drum.x - Math.round(drum.x / CITY.pitch) * CITY.pitch);
      if (offX > 13) continue;
      if (Math.hypot(drum.x - this.layout.relay.x, drum.z - this.layout.relay.z) < 80) continue;
      if (this.grid.raycast(drum.x, drum.z - 30, drum.x, drum.z - 2) < 1) continue;
      const d = Math.hypot(drum.x - this.layout.start.x, drum.z - this.layout.start.z);
      if (d < bestD) {
        bestD = d;
        best = drum;
      }
    }
    return best;
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
      advance: (seconds: number, intents?: { throttle?: number; steer?: number; fire?: boolean; boost?: boolean; handbrake?: boolean; missile?: boolean }) => {
        const dt = 1 / 60;
        let missile = intents?.missile ?? false;
        for (let n = Math.round(seconds / dt); n > 0; n -= 1) {
          // an upgrade choice freezes the simulation exactly as it does for a player
          if (this.upgradeOffer || this.paused) break;
          if (this.hitStop > 0) this.hitStop = 0;
          this.timeScale = 1;
          this.slowHold = 0;
          this.applyPlayerIntents(intents?.steer ?? 0, intents?.throttle ?? 0, intents?.fire ?? false, intents?.boost ?? false, intents?.handbrake ?? false, missile, dt);
          missile = false;
          this.stepSim(dt);
          this.updateCamera(dt);
        }
        this.pushHud();
        this.publishDiagnostics();
      },
      teleport: (x: number, z: number, heading: number, speed = 0) => {
        this.player.place(x, z, heading);
        this.player.vx = Math.sin(heading) * speed;
        this.player.vz = Math.cos(heading) * speed;
        this.turretYaw = heading;
        this.cameraRig.snapTo(this.player);
        this.publishDiagnostics();
      },
    };
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    let alive = 0;
    let patrolsAlive = 0;
    let hostiles = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      alive += 1;
      if (enemy.aware) hostiles += 1;
      if (enemy.squad > 0 && enemy.squad < CACHE_SQUAD) patrolsAlive += 1;
    }
    const drumsAlive = this.drums.aliveCount;
    if (drumsAlive !== this.diagDrumCount) {
      this.diagDrumCount = drumsAlive;
      this.diagDrums = this.drums.drums.filter((drum) => drum.alive).map((drum) => ({ x: drum.x, z: drum.z }));
    }
    const p = this.player;
    const nearestPickups: { x: number; z: number; kind: string; distance: number }[] = [];
    this.pickups.forEachActive((pickup) => {
      const distance = Math.hypot(pickup.x - p.x, pickup.z - p.z);
      if (distance < 90) nearestPickups.push({ x: pickup.x, z: pickup.z, kind: pickup.kind, distance });
    });
    nearestPickups.sort((a, b) => a.distance - b.distance);
    nearestPickups.length = Math.min(nearestPickups.length, 8);
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
        aware: enemy.aware, mode: enemy.mode, squad: enemy.squad,
      })),
      points: this.scoring.score,
      combo: { count: this.scoring.comboCount, multiplier: this.scoring.multiplier, timer01: this.scoring.timer01, best: this.scoring.bestCombo },
      scrap: this.scoring.scrap,
      scrapBank: this.scrapBank,
      rank: computeRank(this.scoring.score, this.runTime, this.damageTaken),
      maxArmor: this.upgrades.maxArmor,
      missiles: this.missiles,
      missileMax: this.upgrades.missileMax,
      missilesInFlight: this.missileSystem.activeCount,
      missilesFired: this.missilesFired,
      missileKills: this.missileKills,
      lock: { state: this.lockTarget ? (this.lockComplete ? 'locked' : 'locking') : 'none', progress: this.lockProgress },
      upgrades: this.upgrades.snapshot(),
      upgradesOwned: this.upgrades.owned,
      upgradesPicked: this.upgradesPicked,
      upgradePending: this.upgradeOffer ? this.upgradeOffer.options.map((option) => option.id) : null,
      enemyHealthScale: this.upgrades.enemyHealthScale,
      pickupsRemaining: this.pickups.remaining,
      pickupsCollected: this.pickupsCollected,
      pickups: { scrap: this.pickups.count('scrap'), repair: this.pickups.count('repair'), boost: this.pickups.count('boost'), missile: this.pickups.count('missile') },
      nearestPickups,
      drumsRemaining: drumsAlive,
      drumsDetonated: this.drumsDetonated,
      drums: this.diagDrums,
      patrolsAlive,
      hostiles,
      cachesOpened: this.caches.openedCount,
      caches: this.caches.caches.map((cache) => ({ x: cache.x, z: cache.z, ax: cache.ax, az: cache.az, opened: cache.opened })),
      style: { drifts: this.driftCount, nearMisses: this.nearMissCount, ramKills: this.ramKills, barrelKills: this.barrelKills, last: this.lastStyle, drifting: this.drift.time },
      endless: this.endless,
      endlessWave: this.endlessWave,
      hudMode: this.hudMode(),
      hudTargets: this.targets.map((target) => ({ kind: target.kind, sx: Math.round(target.sx), sy: Math.round(target.sy), value01: target.value01 })),
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
