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
  damageBy: { shot: number; ram: number; mortar: number; wall: number };
  enemies: { x: number; z: number; kind: string; health: number }[];
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
  advance(seconds: number, intents?: { throttle?: number; steer?: number; fire?: boolean; boost?: boolean; handbrake?: boolean }): void;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}
