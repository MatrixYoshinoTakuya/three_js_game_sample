import type * as THREE from 'three';

/**
 * Shared interfaces between the game lead code and the independently authored
 * modules (vehicle models, HUD, audio). World units are metres, Y is up and a
 * vehicle's local forward axis is +Z.
 */

// ---------------------------------------------------------------- vehicles

export type VehicleModel = {
  /** Origin on the ground under the vehicle centre. Forward is +Z. */
  root: THREE.Group;
  /** Sprung chassis (child of root). The game applies roll/pitch lean to it. */
  body: THREE.Group;
  /** Spin with rotation.x. Order: front-left, front-right, rear-left, rear-right, then extras. */
  wheels: THREE.Object3D[];
  /** Parents of the front wheels. The game sets rotation.y for steering. */
  steerPivots: THREE.Object3D[];
  /** Optional weapon mount that yaws with rotation.y (child of body). */
  turret?: THREE.Object3D;
  /** Empty sockets at each gun muzzle, local +Z pointing out of the barrel. */
  muzzles: THREE.Object3D[];
  /** Empty sockets at exhaust tips (boost flame / smoke spawn points). */
  exhausts: THREE.Object3D[];
  /** Emissive headlight lens material (the game drives emissiveIntensity). */
  headlightMaterial: THREE.MeshStandardMaterial;
  /** Emissive tail/brake light material (the game drives emissiveIntensity). */
  tailLightMaterial: THREE.MeshStandardMaterial;
  /** Emissive faction accent used for attack telegraphs (enemies). */
  accentMaterial: THREE.MeshStandardMaterial;
  /** 0 = pristine, 1 = wrecked. Darkens/scorches paint. Cheap to call every hit. */
  setDamage(level: number): void;
  /** Half extents of the gameplay collision box (x = half width, z = half length). */
  halfExtents: { x: number; y: number; z: number };
  /** Wheel radius in metres, used to convert speed into wheel spin. */
  wheelRadius: number;
  diagnostics: { meshes: number; materials: number; triangles: number };
};

// ---------------------------------------------------------------- audio

export type SfxName =
  | 'playerShot'
  | 'enemyShot'
  | 'hitMetal'
  | 'hitPlayer'
  | 'explosionSmall'
  | 'explosionBig'
  | 'mortarLaunch'
  | 'mortarImpact'
  | 'crash'
  | 'boostStart'
  | 'uiClick'
  | 'uiConfirm'
  | 'radioOpen'
  | 'radioClose'
  | 'objective'
  | 'relayPowerUp'
  | 'alarm'
  | 'repair'
  | 'overheat';

export type MusicState = 'silent' | 'title' | 'explore' | 'event' | 'battle' | 'boss' | 'victory' | 'fail';

export type SfxOptions = {
  /** Linear gain multiplier, default 1. */
  volume?: number;
  /** Stereo pan -1 (left) .. 1 (right), default 0. */
  pan?: number;
  /** Playback pitch multiplier, default 1. */
  pitch?: number;
};

export interface GameAudio {
  /** Must be called from a user gesture. Safe to call repeatedly. */
  unlock(): void;
  readonly muted: boolean;
  setMuted(muted: boolean): void;
  setMasterVolume(volume01: number): void;
  /** Called every frame while driving. All arguments are 0..1 except boosting. */
  setEngine(rpm01: number, throttle01: number, speed01: number, boosting: boolean): void;
  /** Tyre scrub loudness 0..1 (drift / handbrake). Called every frame. */
  setSkid(amount01: number): void;
  /** Wind + city ambience bed, 0..1. */
  setAmbience(intensity01: number): void;
  setMusicState(state: MusicState): void;
  play(name: SfxName, options?: SfxOptions): void;
  /** Pause menu: duck/suspend everything; resume restores. */
  pause(): void;
  resume(): void;
  dispose(): void;
}

// ---------------------------------------------------------------- HUD

export type HudMode = 'loading' | 'title' | 'playing' | 'cinematic' | 'paused' | 'failed' | 'complete';

export type HudBlip = { x: number; z: number; kind: 'enemy' | 'boss' | 'objective' | 'mortar' };

export type HudFrame = {
  mode: HudMode;
  speedKmh: number;
  rpm01: number;
  armor01: number;
  boost01: number;
  boostActive: boolean;
  /** Weapon heat 0..1, overheated locks the cannon until it cools. */
  heat01: number;
  overheated: boolean;
  /** Player heading in radians; 0 = facing +Z (north on the map), increasing toward +X (east). */
  headingRad: number;
  player: { x: number; z: number };
  objective: {
    /** Short label, e.g. "第7中継塔へ向かえ". */
    title: string;
    /** Optional secondary line, e.g. "灰都・中央区". */
    detail: string;
    /** Metres to the objective, or null when there is no positional objective. */
    distanceM: number | null;
    /** World position of the objective, or null. */
    position: { x: number; z: number } | null;
  };
  blips: HudBlip[];
  /** Remaining hostile vehicles, or null outside combat. */
  enemiesRemaining: number | null;
  /** Boss health bar, or null when no boss is active. */
  boss: { name: string; hp01: number } | null;
  /** Seconds since the run started. */
  elapsed: number;
  /** Final stats, shown on the complete/failed screens. */
  stats: { kills: number; timeSec: number; damageTaken: number };
};

export type MinimapWorld = {
  /** Playable area spans [-halfExtent, +halfExtent] on X and Z. */
  halfExtent: number;
  /** Centre coordinates of every road line (same list used on both axes). */
  roadCenters: number[];
  roadWidth: number;
  landmarks: { x: number; z: number; kind: 'relay' | 'highway' | 'start' }[];
};

export type TouchIntents = {
  /** True once the player has touched the on-screen controls. */
  active: boolean;
  /** -1 (left) .. 1 (right). */
  steer: number;
  /** -1 (reverse/brake) .. 1 (full throttle). */
  throttle: number;
  fire: boolean;
  boost: boolean;
  handbrake: boolean;
};

export type HudEvent = 'start' | 'resume' | 'retry' | 'restart' | 'pauseToggle' | 'muteToggle';

export interface GameHud {
  /** Live touch-control state, mutated in place by the HUD's pointer handlers. */
  readonly touch: TouchIntents;
  setMinimapWorld(world: MinimapWorld): void;
  /** Called once per rendered frame. Must be allocation-light and skip unchanged DOM writes. */
  update(frame: HudFrame): void;
  /** Radio subtitle. Replaces any current line. */
  showDialogue(speaker: string, text: string, seconds: number): void;
  clearDialogue(): void;
  /** Short centre-screen notice, e.g. "目標更新" / "WAVE 2". */
  toast(text: string, kind?: 'info' | 'warning' | 'success'): void;
  /** Directional damage indicator. angleRad is relative to the player's facing: 0 = from ahead, +PI/2 = from the right. */
  flashDamage(angleRad: number, strength01: number): void;
  hitMarker(kill: boolean): void;
  setMuted(muted: boolean): void;
  /** Loading progress 0..1 shown in 'loading' mode. */
  setLoadingProgress(value01: number): void;
  on(event: HudEvent, handler: () => void): void;
  /** Test support: hide transient animation so screenshots are stable. */
  setReducedMotion(enabled: boolean): void;
  dispose(): void;
}
