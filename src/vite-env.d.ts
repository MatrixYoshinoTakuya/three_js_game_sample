/// <reference types="vite/client" />

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  score: number;
  targetScore: number;
  complete: boolean;
  phase: string;
  stage: string;
  paused: boolean;
  armor: number;
  boost: number;
  heat: number;
  enemiesAlive: number;
  bossHealth: number | null;
  relayDistance: number;
  kills: number;
  damageTaken: number;
  /** Cumulative damage by source for the whole session (balance telemetry). */
  damageBy: { shot: number; ram: number; mortar: number; wall: number; blast: number };
  enemies: { x: number; z: number; kind: string; health: number; aware: boolean; mode: string; squad: number }[];
  /** Mortar shells in the air: impact point and seconds to impact. */
  mortars: { x: number; z: number; timer: number }[];
  /** Session score in points (`score` above stays the kill count for the generic inspector). */
  points: number;
  combo: { count: number; multiplier: number; timer01: number; best: number };
  scrap: number;
  /** Scrap banked toward the next fabricated missile (0..39). */
  scrapBank: number;
  rank: string;
  maxArmor: number;
  missiles: number;
  missileMax: number;
  missilesInFlight: number;
  missilesFired: number;
  missileKills: number;
  lock: { state: string; progress: number };
  /** Level of every upgrade id (ap, cooling, turbo, plating, rack, ram, magnet, medkit). */
  upgrades: Record<string, number>;
  upgradesOwned: number;
  upgradesPicked: number;
  /** Option ids on offer while the upgrade screen is up, else null. */
  upgradePending: string[] | null;
  enemyHealthScale: number;
  pickupsRemaining: number;
  pickupsCollected: number;
  pickups: { scrap: number; repair: number; boost: number; missile: number };
  /** Up to 8 live pickups within 90 m, nearest first. */
  nearestPickups: { x: number; z: number; kind: string; distance: number }[];
  drumsRemaining: number;
  drumsDetonated: number;
  drums: { x: number; z: number }[];
  /** Living raiders that belong to a roaming patrol squad. */
  patrolsAlive: number;
  /** Living raiders that are aware of the player. */
  hostiles: number;
  cachesOpened: number;
  /** ax/az: unit vector from the cache toward the street it is entered from. */
  caches: { x: number; z: number; ax: number; az: number; opened: boolean }[];
  style: { drifts: number; nearMisses: number; ramKills: number; barrelKills: number; last: string; drifting: number };
  endless: boolean;
  endlessWave: number;
  hudMode: string;
  hudTargets: { kind: string; sx: number; sy: number; value01: number }[];
  relay: { x: number; z: number };
  /** Clear fraction of a 45 m ray: straight ahead, 0.5 rad left (+heading), 0.5 rad right. */
  feelers: number[];
  /** Signed angle from the player's facing to the relay; positive = steer left. */
  relayBearing: number;
  player: {
    position: { x: number; y: number; z: number };
    speed: number;
    heading: number;
  };
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
    postPasses: number;
    shadowMapSize: number;
    shadowLights: number;
    /** 0 = full post pipeline; 1-3 = automatic compatibility fallbacks. */
    safeLevel: number;
    outputVerified: boolean;
    brightestSample: number;
  };
  canvas: {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    dpr: number;
  };
}

interface ThreeGameTestHooks {
  /** Re-seed the game RNG; all gameplay randomness must flow through it. */
  seed(value: number): void | Promise<void>;
  /** Acknowledge after setup/assets are ready; throw for unknown states. */
  setState(name: string): { state: string } | Promise<{ state: string }>;
  /** Stop simulation/state transitions immediately; keep rendering. Await optional synchronization. */
  setPausedForScreenshot(paused: boolean): void | Promise<void>;
  /** Stabilize ambient/idle visuals without requiring an unpaused simulation tick. */
  setReducedMotion(enabled: boolean): void | Promise<void>;
  /** Hide debug UI (lil-gui) before capturing. */
  hideDebugUi(hidden: boolean): void | Promise<void>;
  /** Step the simulation deterministically without waiting for rendered frames (bot playtests). */
  advance(seconds: number, intents?: { throttle?: number; steer?: number; fire?: boolean; boost?: boolean; handbrake?: boolean; missile?: boolean }): void;
  /** Put the player car somewhere (bot playtests of open-world content). */
  teleport(x: number, z: number, heading: number, speed?: number): void;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}
