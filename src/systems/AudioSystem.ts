import type { EnemyEngineSource, GameAudio, MusicState, SfxName, SfxOptions } from '../game/contracts';

/**
 * ASHEN SKYLINE runtime audio. Everything is synthesised with the Web Audio API:
 * no audio files, no network. The AudioContext is created lazily in `unlock()`
 * (which must be called from a user gesture); every public method is a safe
 * no-op before that and never throws.
 *
 * Signal flow:
 *   sfx / engine / enemy engines ───────────┐
 *   music / ambience ─► duck (sidechain) ───┼─► master (volume) ─► glue comp ─► makeup ─► limiter ─► soft clip ─► output
 *   reverb send ─► convolver ───────────────┘
 * The soft clip tops out at 0.95, so the output can never reach |1.0|.
 */

// ------------------------------------------------------------------ constants

const EPS = 0.0001;
const DEFAULT_MASTER = 0.9;

const BUS_SFX = 0.8;
const BUS_ENGINE = 0.115;
const BUS_ENEMY = 0.09;
const BUS_AMBIENCE = 0.21;
const BUS_MUSIC = 0.54;
const REVERB_RETURN = 0.6;
const MUSIC_REVERB_SEND = 0.3;
const GLUE_MAKEUP = 1.0;
/** The clipper input is halved so the curve covers |x| up to 2.0 before the WaveShaper's own clamp. */
const CLIP_RANGE = 2;
const CLIP_KNEE = 0.72;
const CLIP_CEILING = 0.95;

const DUCK_ATTACK_TC = 0.012;
const DUCK_RELEASE_TC = 0.085; // ~250 ms to recover

const MAX_VOICES = 26;
const MAX_VOICES_PRIORITY = 36;
const MIN_REPEAT_SEC = 0.025;
const ENEMY_VOICES = 4;

const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULER_LOOKAHEAD = 0.12;
const MUSIC_FADE_SEC = 1.5;
const CHORD_SEC = 8.4;

// D minor material
const D2 = 73.42;
const D4 = 293.66;
const PENTATONIC = [293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46];
const VICTORY_ARP = [293.66, 369.99, 440.0, 587.33, 739.99, 880.0, 1174.66];
/** Semitone ladders for stacking cues (major pentatonic for scrap, major scale for combo). */
const SCRAP_LADDER = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const COMBO_LADDER = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19];

type Quad = [number, number, number, number];
type PadConfig = { f: Quad; g: Quad; cut: number; level: number };

const PAD: Record<MusicState, PadConfig> = {
  silent: { f: [73.42, 110.0, 146.83, 174.61], g: [1, 0.8, 0.45, 0.6], cut: 300, level: 0 },
  title: { f: [73.42, 110.0, 146.83, 174.61], g: [1, 0.8, 0.5, 0.65], cut: 640, level: 0.62 },
  explore: { f: [73.42, 110.0, 146.83, 174.61], g: [1, 0.8, 0.45, 0.6], cut: 540, level: 0.6 },
  // Bb/F lift: Bb1, F2, D3, A3
  event: { f: [58.27, 87.31, 146.83, 220.0], g: [1, 0.8, 0.7, 0.5], cut: 1100, level: 0.62 },
  battle: { f: [73.42, 110.0, 146.83, 174.61], g: [1, 0.7, 0.4, 0.4], cut: 420, level: 0.42 },
  // D, Ab (tritone), D, Eb
  boss: { f: [73.42, 103.83, 146.83, 155.56], g: [1, 0.6, 0.4, 0.45], cut: 440, level: 0.48 },
  // D major: D2, A2, F#3, A3 (reached through a G - A - D cadence)
  victory: { f: [73.42, 110.0, 185.0, 220.0], g: [1, 0.8, 0.7, 0.6], cut: 1600, level: 1.0 },
  // sinks to G1 / C#2 / G2 / C#3
  fail: { f: [49.0, 69.3, 98.0, 138.59], g: [1, 0.7, 0.5, 0.3], cut: 230, level: 0.85 },
};

/** Slow pad progressions for the calm states: pad voicing + melody tones that fit the chord. */
type Chord = { f: Quad; mel: number[] };
const CHORD_DM: Chord = { f: [73.42, 110.0, 146.83, 174.61], mel: [293.66, 349.23, 440.0, 523.25, 587.33] };
const PROG: Record<'title' | 'explore', Chord[]> = {
  // Dm - Bb - F - C
  title: [
    CHORD_DM,
    { f: [58.27, 116.54, 146.83, 174.61], mel: [293.66, 349.23, 466.16, 523.25, 587.33] },
    { f: [87.31, 110.0, 130.81, 174.61], mel: [261.63, 349.23, 440.0, 523.25, 698.46] },
    { f: [65.41, 98.0, 130.81, 164.81], mel: [261.63, 329.63, 392.0, 523.25, 659.25] },
  ],
  // Dm - Gm/D - Bbmaj7 - Am
  explore: [
    CHORD_DM,
    { f: [73.42, 116.54, 146.83, 196.0], mel: [293.66, 392.0, 466.16, 587.33, 783.99] },
    { f: [58.27, 110.0, 146.83, 174.61], mel: [293.66, 349.23, 440.0, 466.16, 587.33] },
    { f: [55.0, 110.0, 130.81, 164.81], mel: [261.63, 329.63, 440.0, 523.25, 659.25] },
  ],
};
/** Victory cadence voicings: G (IV) -> A (V) -> D (I, = PAD.victory.f). */
const VICTORY_IV: Quad = [49.0, 98.0, 146.83, 196.0];
const VICTORY_V: Quad = [55.0, 110.0, 164.81, 220.0];

type RhythmState = 'event' | 'battle' | 'boss';
const RHYTHM_BPM: Record<RhythmState, number> = { event: 72, battle: 132, boss: 140 };

const BATTLE_BASS = [0, 0, 12, 0, 0, 12, 0, 0, 10, 0, 12, 0, 0, 3, 5, 7];
const BATTLE_ACCENT = [1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1];
/** 8-bar root movement: D D C C Bb Bb A C */
const BATTLE_ROOT = [0, 0, -2, -2, -4, -4, -5, -2];
const BOSS_BASS = [0, 0, 0, 12, 0, 0, 1, 0, 0, 0, 12, 0, 1, 0, 13, 12];
const BOSS_ACCENT = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
/** D D Eb D D D F Eb */
const BOSS_ROOT = [0, 0, 1, 0, 0, 0, 3, 1];
const BOSS_TOMS = [110, 92, 78, 65];
const R = -1; // rest
/** Lead motifs, semitones above D4, played over bars 4-7 of every 8 (the Bb Bb A C / D D F Eb half). */
const BATTLE_LEAD = [
  [12, R, R, 15, R, R, 12, R, R, R, 8, R, R, R, R, R],
  [10, R, R, 12, R, R, 15, R, R, R, R, R, 12, R, 10, R],
  [7, R, R, 14, R, R, 12, R, R, R, 7, R, R, R, R, R],
  [5, R, R, 10, R, R, 14, R, R, 17, R, R, 14, R, R, R],
];
const BOSS_LEAD = [
  [12, R, R, R, R, R, 13, R, 12, R, R, R, R, R, R, R],
  [7, R, R, R, R, R, 6, R, R, R, 7, R, R, R, R, R],
  [10, R, R, R, 7, R, R, R, 15, R, R, R, R, R, R, R],
  [13, R, R, R, 8, R, R, R, 13, R, R, R, 10, R, 8, R],
];

/** duck: 0 = none, otherwise the gain the music/ambience bed is pulled to; hold = seconds before recovery. */
type SfxMix = { vol: number; send: number; vary: boolean; priority: boolean; duck?: number; hold?: number };

const SFX: Record<SfxName, SfxMix> = {
  playerShot: { vol: 0.62, send: 0.22, vary: true, priority: false },
  enemyShot: { vol: 1.0, send: 0.4, vary: true, priority: false },
  hitMetal: { vol: 0.72, send: 0.15, vary: true, priority: false },
  hitPlayer: { vol: 0.7, send: 0.15, vary: true, priority: true, duck: 0.75, hold: 0.12 },
  explosionSmall: { vol: 0.62, send: 0.3, vary: true, priority: true, duck: 0.66, hold: 0.22 },
  explosionBig: { vol: 1.15, send: 0.5, vary: true, priority: true, duck: 0.56, hold: 0.45 },
  mortarLaunch: { vol: 0.85, send: 0.35, vary: true, priority: true },
  mortarImpact: { vol: 0.95, send: 0.4, vary: true, priority: true, duck: 0.6, hold: 0.3 },
  crash: { vol: 0.7, send: 0.3, vary: true, priority: true, duck: 0.7, hold: 0.15 },
  boostStart: { vol: 0.85, send: 0.2, vary: true, priority: true },
  uiClick: { vol: 0.7, send: 0.04, vary: false, priority: true },
  uiConfirm: { vol: 1.0, send: 0.2, vary: false, priority: true },
  radioOpen: { vol: 0.7, send: 0.0, vary: false, priority: true, duck: 0.63, hold: 0.9 },
  radioClose: { vol: 0.7, send: 0.0, vary: false, priority: true, duck: 0.7, hold: 0.1 },
  objective: { vol: 0.7, send: 0.5, vary: false, priority: true, duck: 0.7, hold: 0.4 },
  relayPowerUp: { vol: 0.75, send: 0.5, vary: false, priority: true },
  alarm: { vol: 0.8, send: 0.2, vary: false, priority: true },
  repair: { vol: 1.2, send: 0.15, vary: false, priority: true },
  overheat: { vol: 0.7, send: 0.1, vary: true, priority: true },
  missileLaunch: { vol: 0.95, send: 0.35, vary: true, priority: true },
  missileLock: { vol: 0.6, send: 0.05, vary: false, priority: true },
  pickupScrap: { vol: 0.6, send: 0.15, vary: false, priority: false },
  pickupRepair: { vol: 0.7, send: 0.2, vary: false, priority: true },
  pickupBoost: { vol: 0.7, send: 0.15, vary: false, priority: true },
  pickupMissile: { vol: 0.65, send: 0.12, vary: false, priority: true },
  combo: { vol: 0.9, send: 0.3, vary: false, priority: true },
  comboBreak: { vol: 0.4, send: 0.15, vary: false, priority: false },
  upgrade: { vol: 0.8, send: 0.6, vary: false, priority: true, duck: 0.63, hold: 0.9 },
  lowArmor: { vol: 0.7, send: 0.12, vary: false, priority: true },
  nearMiss: { vol: 0.8, send: 0.2, vary: true, priority: false },
  driftScore: { vol: 1.0, send: 0.25, vary: true, priority: false },
  barrelExplosion: { vol: 1.0, send: 0.4, vary: true, priority: true, duck: 0.63, hold: 0.25 },
  bulletWhiz: { vol: 1.2, send: 0.1, vary: true, priority: false },
  ricochet: { vol: 0.8, send: 0.3, vary: true, priority: false },
  hornBoss: { vol: 1.0, send: 0.7, vary: false, priority: true, duck: 0.56, hold: 1.5 },
  gearShift: { vol: 0.5, send: 0.05, vary: true, priority: false },
  turboBlowoff: { vol: 0.95, send: 0.12, vary: true, priority: false },
  rankStamp: { vol: 0.95, send: 0.5, vary: false, priority: true, duck: 0.63, hold: 0.3 },
  checkpoint: { vol: 0.65, send: 0.45, vary: false, priority: true },
  wreckSmash: { vol: 0.8, send: 0.3, vary: true, priority: true, duck: 0.7, hold: 0.15 },
};

// ------------------------------------------------------------------ helpers

function clamp(v: number, lo: number, hi: number): number {
  if (!(v >= lo)) return lo; // also catches NaN
  return v > hi ? hi : v;
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

/** Attack/decay envelope starting and ending at a tiny non-zero value (click free). */
function ad(p: AudioParam, t: number, attack: number, peak: number, decay: number): void {
  p.setValueAtTime(EPS, t);
  p.linearRampToValueAtTime(Math.max(EPS, peak), t + attack);
  p.exponentialRampToValueAtTime(EPS, t + attack + decay);
}

function sweep(p: AudioParam, t: number, from: number, to: number, dur: number): void {
  p.setValueAtTime(clamp(from, 1, 20000), t);
  p.exponentialRampToValueAtTime(clamp(to, 1, 20000), t + dur);
}

function tanhCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

/**
 * Final safety clipper. The curve spans inputs of -CLIP_RANGE..CLIP_RANGE (the node is fed
 * through a 1/CLIP_RANGE gain): transparent below CLIP_KNEE, then a tanh knee whose asymptote
 * is CLIP_CEILING, so the output magnitude is bounded by 0.95 whatever comes in.
 */
function limiterCurve(): Float32Array<ArrayBuffer> {
  const n = 8192;
  const curve = new Float32Array(n);
  const room = CLIP_CEILING - CLIP_KNEE;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * CLIP_RANGE;
    const a = Math.abs(x);
    const y = a <= CLIP_KNEE ? a : CLIP_KNEE + room * Math.tanh((a - CLIP_KNEE) / room);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

/** Loopable noise: the tail is crossfaded into the head so the loop seam is continuous. */
function makeNoise(ctx: AudioContext, seconds: number, brown: boolean): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const fade = Math.floor(sr * 0.08);
  const raw = new Float32Array(n + fade);
  let b = 0;
  let peak = EPS;
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      b = (b + 0.02 * w) / 1.02;
      raw[i] = b;
    } else {
      raw[i] = w;
    }
    const a = Math.abs(raw[i]);
    if (a > peak) peak = a;
  }
  const buffer = ctx.createBuffer(1, n, sr);
  const out = buffer.getChannelData(0);
  const scale = 0.9 / peak;
  for (let i = 0; i < n; i++) {
    let s = raw[i];
    if (i < fade) {
      const k = i / fade;
      s = raw[i] * k + raw[n + i] * (1 - k);
    }
    out[i] = s * scale;
  }
  return buffer;
}

/** ~2.2 s decaying-noise impulse response that gets darker as it decays (dusty urban canyon). */
function makeImpulse(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 2.2);
  const pre = Math.floor(sr * 0.018);
  const buffer = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp(-t * 3.1);
      const a = Math.min(0.95, 0.5 + t * 0.32); // one-pole coefficient: darker over time
      lp += (1 - a) * (Math.random() * 2 - 1 - lp);
      data[i] = lp * env;
    }
    // a few discrete early reflections (walls across the street)
    for (let k = 0; k < 6; k++) {
      const idx = pre + Math.floor(sr * rand(0.012, 0.11));
      if (idx < n) data[idx] += (Math.random() < 0.5 ? -1 : 1) * rand(0.25, 0.5) * (1 - k * 0.1);
    }
  }
  return buffer;
}

// ------------------------------------------------------------------ graph types

type Voice = {
  out: GainNode;
  nodes: AudioNode[];
  pending: number;
  done: boolean;
  counted: boolean;
};

type EnemyVoice = {
  o1: OscillatorNode;
  o2: OscillatorNode;
  lfo: OscillatorNode;
  lfoDepth: GainNode;
  rattleGain: GainNode;
  hp: BiquadFilterNode;
  lp: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
};

type EnemyTrack = { d: number; t: number; dop: number };

type Graph = {
  ctx: AudioContext;
  master: GainNode;
  output: GainNode;
  sfxBus: GainNode;
  engineBus: GainNode;
  ambBus: GainNode;
  musicBus: GainNode;
  reverbIn: GainNode;
  white: AudioBuffer;
  brown: AudioBuffer;
  softCurve: Float32Array<ArrayBuffer>;
  hardCurve: Float32Array<ArrayBuffer>;
  loops: AudioScheduledSourceNode[];
  engine: {
    oscA: OscillatorNode;
    oscB: OscillatorNode;
    oscC: OscillatorNode;
    sub: OscillatorNode;
    drive: GainNode;
    lowpass: BiquadFilterNode;
    lopeLfo: OscillatorNode;
    lopeDepth: GainNode;
    gain: GainNode;
    roadFilter: BiquadFilterNode;
    roadGain: GainNode;
    whine: OscillatorNode;
    whine2: OscillatorNode;
    whineGain: GainNode;
    jetFilter: BiquadFilterNode;
    jetGain: GainNode;
    rumbleFilter: BiquadFilterNode;
    rumbleGain: GainNode;
  };
  enemy: EnemyVoice[];
  skid: { filter: BiquadFilterNode; gain: GainNode };
  amb: { gain: GainNode };
  duck: GainNode;
  music: {
    padOscs: OscillatorNode[][];
    padVoiceGains: GainNode[];
    padFilter: BiquadFilterNode;
    padLfoDepth: GainNode;
    padGain: GainNode;
    rhythmGain: GainNode;
    bassBus: GainNode;
    pluckBus: GainNode;
    leadBus: GainNode;
    rhythmLp: BiquadFilterNode;
    rhythmBoost: GainNode;
    tensionGain: GainNode;
  };
};

// ------------------------------------------------------------------ system

export class AudioSystem implements GameAudio {
  private g: Graph | null = null;
  private disposed = false;
  private paused = false;
  private isMuted = false;
  private masterVolume = DEFAULT_MASTER;

  private ambienceIntensity = 0;
  private musicState: MusicState = 'silent';

  private lastTarget = new WeakMap<AudioParam, number>();
  private activeVoices = 0;
  private lastPlay = new Map<SfxName, number>();

  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private houseTimer: ReturnType<typeof setInterval> | null = null;
  private ambTimer: ReturnType<typeof setTimeout> | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;

  private engineActive = false;
  private lastEngineCall = 0;
  private skidActive = false;
  private lastSkidCall = 0;

  private rhythmState: RhythmState | null = null;
  private rhythmUntil = 0;
  private nextStepTime = 0;
  private step = 0;
  private bar = 0;
  private nextPluckTime = Number.POSITIVE_INFINITY;
  private lastPluckIndex = 0;
  private chordIndex = 0;
  private nextChordTime = Number.POSITIVE_INFINITY;
  private nextHeartTime = 0;

  private threat = 0;
  private enemyActive = false;
  private lastEnemyCall = 0;
  private enemyTrack: EnemyTrack[] = [];
  private lastHighThrottle = 0;
  private nextCrackleAt = 0;
  private scrapStep = 0;
  private lastScrapTime = -100;
  private comboStep = 0;
  private lastComboTime = -100;

  get muted(): boolean {
    return this.isMuted;
  }

  // ---------------------------------------------------------------- lifecycle

  unlock(): void {
    try {
      if (this.disposed) return;
      if (!this.g) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        const ctx = new Ctor({ latencyHint: 'interactive' });
        try {
          this.g = this.build(ctx);
        } catch (err) {
          void ctx.close().catch(() => undefined);
          throw err;
        }
        this.applyMaster(0.05);
        this.to(this.g.amb.gain.gain, this.ambienceIntensity, 0.8);
        const wanted = this.musicState;
        this.musicState = 'silent';
        this.setMusicState(wanted);
        this.houseTimer = setInterval(() => this.housekeeping(), 250);
        this.queueAmbienceEvent();
      }
      if (!this.paused) {
        if (this.g.ctx.state !== 'running') void this.g.ctx.resume().catch(() => undefined);
        this.startScheduler();
      }
    } catch {
      /* audio is optional: never break the game */
    }
  }

  setMuted(muted: boolean): void {
    this.isMuted = !!muted;
    this.applyMaster(0.03);
  }

  setMasterVolume(volume01: number): void {
    this.masterVolume = clamp(volume01, 0, 1);
    this.applyMaster(0.05);
  }

  pause(): void {
    try {
      const g = this.g;
      if (!g || this.paused) return;
      this.paused = true;
      this.stopScheduler();
      this.applyMaster(0.018); // ~98% down within 80 ms
      if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = null;
        if (this.paused && this.g) void this.g.ctx.suspend().catch(() => undefined);
      }, 90);
    } catch {
      /* ignore */
    }
  }

  resume(): void {
    try {
      const g = this.g;
      if (!this.paused) return;
      this.paused = false;
      if (this.pauseTimer !== null) {
        clearTimeout(this.pauseTimer);
        this.pauseTimer = null;
      }
      if (!g) return;
      void g.ctx.resume().catch(() => undefined);
      this.applyMaster(0.04);
      this.nextStepTime = 0; // scheduler re-syncs to the clock
      this.startScheduler();
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.stopScheduler();
      if (this.houseTimer !== null) clearInterval(this.houseTimer);
      if (this.ambTimer !== null) clearTimeout(this.ambTimer);
      if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
      this.houseTimer = null;
      this.ambTimer = null;
      this.pauseTimer = null;
      const g = this.g;
      this.g = null;
      if (g) {
        for (const src of g.loops) {
          try {
            src.stop();
          } catch {
            /* already stopped */
          }
        }
        try {
          g.output.disconnect();
        } catch {
          /* ignore */
        }
        if (g.ctx.state !== 'closed') void g.ctx.close().catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }

  /** Debug/test tap: the final node feeding `destination` (post limiter). Null before unlock. */
  getOutputNode(): AudioNode | null {
    return this.g ? this.g.output : null;
  }

  /** Debug/test: AudioContext state, or 'none' before unlock. */
  getContextState(): string {
    return this.g ? this.g.ctx.state : 'none';
  }

  // ---------------------------------------------------------------- continuous layers

  setEngine(rpm01: number, throttle01: number, speed01: number, boosting: boolean): void {
    try {
      const g = this.g;
      if (!g || this.paused) return;
      const rpm = clamp(rpm01, 0, 1);
      const thr = clamp(throttle01, 0, 1);
      const spd = clamp(speed01, 0, 1);
      const e = g.engine;
      this.engineActive = true;
      this.lastEngineCall = performance.now();

      const f = 38 + rpm * 150;
      this.to(e.oscA.frequency, f, 0.06);
      this.to(e.oscB.frequency, f, 0.06);
      this.to(e.oscC.frequency, f, 0.06);
      this.to(e.sub.frequency, f * 0.5, 0.06);
      this.to(e.drive.gain, 0.55 + thr * 0.75, 0.08);
      this.to(e.lowpass.frequency, 320 + Math.pow(thr, 1.2) * 1500 + rpm * 380, 0.09);
      // lumpy cam at idle, smoothing out as revs rise
      const idle = Math.max(0, 1 - rpm * 2.6);
      this.to(e.lopeLfo.frequency, 5.5 + rpm * 9, 0.1);
      this.to(e.lopeDepth.gain, 0.32 * idle * (1 - thr * 0.5), 0.1);
      this.to(e.gain.gain, 0.46 + thr * 0.14 + rpm * 0.08, 0.08);

      // tyre hiss + low road rumble, both scaling with speed
      this.to(e.roadFilter.frequency, 260 + spd * 900 + thr * 250, 0.1);
      this.to(e.roadGain.gain, 0.04 + Math.pow(spd, 1.4) * 0.42 + thr * 0.08, 0.1);
      this.to(e.rumbleFilter.frequency, 70 + spd * 150, 0.15);
      this.to(e.rumbleGain.gain, Math.pow(spd, 1.2) * 1.0, 0.15);

      this.to(e.whine.frequency, 900 + rpm * 1500, 0.07);
      this.to(e.whine2.frequency, 900 + rpm * 1500, 0.07);
      this.to(e.whineGain.gain, boosting ? 0.1 + rpm * 0.06 : 0, boosting ? 0.07 : 0.14);
      this.to(e.jetFilter.frequency, 1100 + rpm * 1200, 0.1);
      this.to(e.jetGain.gain, boosting ? 0.5 : 0, boosting ? 0.06 : 0.16);

      // exhaust overrun: pops and crackle when the throttle is lifted at high revs
      const ms = this.lastEngineCall;
      if (thr > 0.55) this.lastHighThrottle = ms;
      else if (thr < 0.2 && rpm > 0.5 && ms - this.lastHighThrottle < 1500 && ms >= this.nextCrackleAt) {
        this.nextCrackleAt = ms + rand(320, 760);
        if (g.ctx.state === 'running') this.exhaustCrackle(g, rpm);
      }
    } catch {
      /* ignore */
    }
  }

  private exhaustCrackle(g: Graph, rpm: number): void {
    const t0 = g.ctx.currentTime + 0.01;
    const v = this.voice(g.sfxBus, 0.2 + rpm * 0.2, rand(-0.25, 0.25), 0.15, false);
    const pops = 2 + Math.floor(Math.random() * 4);
    let t = t0;
    for (let i = 0; i < pops; i++) {
      const k = rand(0.45, 1);
      this.burst(v, v.out, true, 'lowpass', rand(600, 1500), 0.7, t, 0.001, 0.5 * k, rand(0.025, 0.06));
      this.tone(v, v.out, 'sine', rand(130, 190), 62, 0.04, t, 0.001, 0.5 * k, 0.05);
      if (Math.random() < 0.6) this.burst(v, v.out, false, 'bandpass', rand(1500, 2600), 1.2, t, 0.0005, 0.2 * k, 0.012);
      t += rand(0.035, 0.13);
    }
  }

  /**
   * Positional engines of up to 4 hostile vehicles. Voice i follows sources[i]; missing
   * entries fade out. Falls silent by itself if the method stops being called.
   */
  setEnemyEngines(sources: EnemyEngineSource[]): void {
    try {
      const g = this.g;
      if (!g || this.paused) return;
      const list = Array.isArray(sources) ? sources : [];
      const ms = performance.now();
      this.lastEnemyCall = ms;
      let any = false;
      for (let i = 0; i < ENEMY_VOICES; i++) {
        const ev = g.enemy[i];
        const track = this.enemyTrack[i] ?? (this.enemyTrack[i] = { d: -1, t: 0, dop: 1 });
        const s = list[i];
        if (!s || !Number.isFinite(s.distance)) {
          this.to(ev.gain.gain, 0, 0.15);
          track.d = -1;
          continue;
        }
        any = true;
        const d = clamp(s.distance, 0, 5000);
        const rpm = clamp(s.rpm01, 0, 1);
        const heavy = !!s.heavy;
        // doppler-ish: closing raises the pitch a little, receding lowers it
        let dop = 1;
        if (track.d >= 0) {
          const dt = (ms - track.t) / 1000;
          const rate = dt > 0.004 && dt < 0.25 ? (d - track.d) / dt : 0;
          if (Math.abs(rate) < 90) dop = clamp(1 - rate / 430, 0.86, 1.16);
          track.dop += (dop - track.dop) * 0.12;
        } else {
          track.dop = 1;
        }
        track.d = d;
        track.t = ms;
        const f = (heavy ? 29 + rpm * 36 : 64 + rpm * 112) * track.dop;
        const near = 1 / (1 + (d / 35) * (d / 35));
        this.to(ev.o1.frequency, f, 0.08);
        this.to(ev.o2.frequency, heavy ? f * 0.5 : f * 2.01, 0.08);
        this.to(ev.lfo.frequency, heavy ? 5 + rpm * 8 : f * 0.5, 0.1);
        this.to(ev.lfoDepth.gain, heavy ? 0.3 : 0.45, 0.2);
        this.to(ev.rattleGain.gain, heavy ? 0.3 + rpm * 0.25 : 0.06, 0.2);
        this.to(ev.hp.frequency, heavy ? 26 : 150, 0.2);
        this.to(ev.lp.frequency, (heavy ? 320 : 550) + (heavy ? 2400 : 4600) * near * (0.55 + 0.45 * rpm), 0.12);
        this.to(ev.gain.gain, near * (heavy ? 1.5 : 1) * (0.72 + 0.28 * rpm), 0.1);
        this.to(ev.pan.pan, clamp(s.pan, -1, 1), 0.08);
      }
      this.enemyActive = any;
    } catch {
      /* ignore */
    }
  }

  /** Combat pressure: thickens whichever music state is playing. Cheap; call every frame. */
  setThreat(level01: number): void {
    try {
      const level = Math.round(clamp(level01, 0, 1) * 40) / 40;
      if (level === this.threat) return;
      this.threat = level;
      this.applyThreat();
    } catch {
      /* ignore */
    }
  }

  private applyThreat(): void {
    const g = this.g;
    if (!g) return;
    const th = this.threat;
    const st = this.musicState;
    const combat = st === 'battle' || st === 'boss';
    const m = g.music;
    const tc = 0.35; // ~1 s to settle
    this.to(m.tensionGain.gain, st === 'explore' ? th : 0, tc);
    this.to(m.rhythmLp.frequency, 4800 + Math.pow(th, 1.3) * 11000, tc);
    this.to(m.rhythmBoost.gain, 1 + th * 0.2, tc);
    this.to(m.bassBus.gain, 1.5 + (combat ? th * 2.2 : 0), tc);
    this.to(m.padFilter.detune, combat ? th * 1500 : st === 'explore' ? th * 500 : 0, tc);
  }

  setSkid(amount01: number): void {
    try {
      const g = this.g;
      if (!g || this.paused) return;
      const a = clamp(amount01, 0, 1);
      this.skidActive = a > 0.001;
      this.lastSkidCall = performance.now();
      this.to(g.skid.gain.gain, Math.pow(a, 1.3) * 0.6, 0.06);
      this.to(g.skid.filter.frequency, 1000 + a * 600, 0.08);
    } catch {
      /* ignore */
    }
  }

  setAmbience(intensity01: number): void {
    try {
      this.ambienceIntensity = clamp(intensity01, 0, 1);
      const g = this.g;
      if (!g) return;
      this.to(g.amb.gain.gain, this.ambienceIntensity, 0.6);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- music

  setMusicState(state: MusicState): void {
    try {
      if (!(state in PAD)) return;
      const previous = this.musicState;
      this.musicState = state;
      const g = this.g;
      if (!g || previous === state) return;
      const ctx = g.ctx;
      const now = ctx.currentTime;
      const m = g.music;
      const cfg = PAD[state];
      const tc = MUSIC_FADE_SEC / 3; // ~95% of the way after the 1.5 s crossfade
      const glide = state === 'fail' ? 1.6 : tc;

      for (let i = 0; i < m.padOscs.length; i++) {
        for (const osc of m.padOscs[i]) {
          this.retarget(osc.frequency, state === 'victory' ? VICTORY_IV[i] : cfg.f[i], state === 'victory' ? 0.12 : glide);
          if (state === 'victory') {
            osc.frequency.setTargetAtTime(VICTORY_V[i], now + 1.7, 0.1);
            osc.frequency.setTargetAtTime(cfg.f[i], now + 3.4, 0.1);
          }
        }
        this.retarget(m.padVoiceGains[i].gain, cfg.g[i] * 0.13, tc);
      }
      this.retarget(m.padFilter.frequency, cfg.cut, state === 'fail' ? 1.2 : tc);
      this.retarget(m.padLfoDepth.gain, cfg.cut * 0.32, tc);
      this.retarget(m.padGain.gain, cfg.level, state === 'victory' ? 0.2 : tc);

      // rhythm section (event pulse / battle / boss)
      if (state === 'event' || state === 'battle' || state === 'boss') {
        if (this.rhythmState === null || now > this.rhythmUntil) {
          this.step = 0;
          this.bar = 0;
          this.nextStepTime = now + 0.12;
        }
        this.rhythmState = state;
        this.rhythmUntil = Number.POSITIVE_INFINITY;
        this.retarget(m.rhythmGain.gain, 1, tc);
      } else {
        if (this.rhythmState !== null) this.rhythmUntil = Math.min(this.rhythmUntil, now + MUSIC_FADE_SEC);
        this.retarget(m.rhythmGain.gain, 0, tc * 0.8);
      }

      // melodic phrases + slow chord movement in the calm states
      this.retarget(m.pluckBus.gain, state === 'silent' || state === 'fail' ? 0 : 1, tc);
      this.chordIndex = 0;
      if (state === 'title' || state === 'explore') {
        this.nextPluckTime = now + rand(1.2, 2.6);
        this.nextChordTime = now + CHORD_SEC;
      } else {
        this.nextPluckTime = state === 'event' ? now + rand(0.8, 1.6) : Number.POSITIVE_INFINITY;
        this.nextChordTime = Number.POSITIVE_INFINITY;
      }
      this.nextHeartTime = 0;
      this.applyThreat();

      if (state === 'victory') {
        this.victoryCadence(g, now);
      } else if (state === 'fail') {
        // low descending drone, then near silence
        const v = this.voice(g.musicBus, 1, 0, 0, false);
        const osc = this.vOsc(v, 'sine', 110, now, now + 5.2);
        osc.frequency.setValueAtTime(110, now);
        osc.frequency.exponentialRampToValueAtTime(36.7, now + 4.6);
        const lp = this.vFilter(v, 'lowpass', 260, 0.7);
        const tri = this.vOsc(v, 'sawtooth', 110.6, now, now + 5.2);
        tri.frequency.setValueAtTime(110.6, now);
        tri.frequency.exponentialRampToValueAtTime(37.1, now + 4.6);
        const tg = this.vGain(v, 0.35);
        const eg = this.vGain(v, 0);
        eg.gain.setValueAtTime(EPS, now);
        eg.gain.linearRampToValueAtTime(0.3, now + 0.5);
        eg.gain.setValueAtTime(0.3, now + 2.2);
        eg.gain.exponentialRampToValueAtTime(EPS, now + 5.1);
        osc.connect(lp);
        tri.connect(tg).connect(lp);
        lp.connect(eg).connect(v.out);
        // three falling bell tolls (D - Bb - G) over the sinking drone
        const tolls = [293.66, 233.08, 196.0];
        const bv = this.voice(m.pluckBus, 1, 0, 0, false);
        for (let i = 0; i < tolls.length; i++) this.bell(bv, bv.out, tolls[i], now + 0.25 + i * 1.15, 0.2 - i * 0.03, 3.4);
        this.forget(m.pluckBus.gain);
        m.pluckBus.gain.cancelScheduledValues(now);
        m.pluckBus.gain.setTargetAtTime(1, now, 0.05);
        m.pluckBus.gain.setTargetAtTime(0, now + 5.5, 0.5);
        this.forget(m.padGain.gain);
        m.padGain.gain.setTargetAtTime(0.04, now + 4.0, 1.2);
      }
    } catch {
      /* ignore */
    }
  }

  /** IV - V - I in D major: brass-like stabs, timpani, a cymbal swell into the tonic, then a rising arpeggio. */
  private victoryCadence(g: Graph, now: number): void {
    const m = g.music;
    const chords = [
      { t: now + 0.12, notes: [196.0, 246.94, 293.66, 392.0], root: 98.0, len: 1.5 },
      { t: now + 1.72, notes: [220.0, 277.18, 329.63, 440.0], root: 110.0, len: 1.5 },
      { t: now + 3.42, notes: [293.66, 369.99, 440.0, 587.33], root: 73.42, len: 3.6 },
    ];
    const v = this.voice(m.pluckBus, 1, 0, 0, false);
    for (const c of chords) {
      const lp = this.vFilter(v, 'lowpass', 900, 0.9);
      lp.frequency.setValueAtTime(700, c.t);
      lp.frequency.linearRampToValueAtTime(3400, c.t + 0.09);
      lp.frequency.exponentialRampToValueAtTime(900, c.t + c.len);
      lp.connect(v.out);
      for (const f of c.notes) {
        this.tone(v, lp, 'sawtooth', f, f, 0.01, c.t, 0.03, 0.075, c.len);
        this.tone(v, lp, 'sawtooth', f * 1.006, f * 1.006, 0.01, c.t, 0.04, 0.06, c.len);
      }
      // timpani
      this.tone(v, v.out, 'sine', c.root * 1.25, c.root, 0.06, c.t, 0.004, 0.5, 0.9);
      this.tone(v, v.out, 'triangle', c.root * 2, c.root * 2, 0.01, c.t, 0.004, 0.12, 0.4);
      this.burst(v, v.out, false, 'lowpass', 900, 0.5, c.t, 0.002, 0.12, 0.05);
    }
    // cymbal swell into the tonic, then the crash
    const tonic = chords[2].t;
    const swell = this.vNoise(v, false, tonic - 1.3, tonic + 2.6);
    const hp = this.vFilter(v, 'highpass', 5200, 0.7);
    const sg = this.vGain(v, 0);
    sg.gain.setValueAtTime(EPS, tonic - 1.3);
    sg.gain.exponentialRampToValueAtTime(0.1, tonic - 0.02);
    sg.gain.linearRampToValueAtTime(0.2, tonic + 0.01);
    sg.gain.exponentialRampToValueAtTime(EPS, tonic + 2.5);
    swell.connect(hp).connect(sg).connect(v.out);
    // rising arpeggio and a final high D
    for (let i = 0; i < VICTORY_ARP.length; i++) {
      this.bell(v, v.out, VICTORY_ARP[i], tonic + 0.3 + i * 0.22, 0.2, 2.8);
    }
    this.bell(v, v.out, 1174.66, tonic + 2.4, 0.24, 3.6);
    this.bell(v, v.out, 587.33, tonic + 2.4, 0.16, 3.6);
    // settle back into a quiet major pad
    this.forget(m.padGain.gain);
    m.padGain.gain.setTargetAtTime(0.55, now + 7.5, 1.5);
    this.forget(m.padFilter.frequency);
    m.padFilter.frequency.setTargetAtTime(700, now + 7.5, 2.0);
  }

  private startScheduler(): void {
    if (this.schedulerTimer !== null || this.disposed) return;
    this.schedulerTimer = setInterval(() => this.schedulerTick(), SCHEDULER_INTERVAL_MS);
  }

  private stopScheduler(): void {
    if (this.schedulerTimer !== null) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  private schedulerTick(): void {
    try {
      const g = this.g;
      if (!g || this.paused || g.ctx.state !== 'running') return;
      const now = g.ctx.currentTime;
      const horizon = now + SCHEDULER_LOOKAHEAD;
      const st = this.musicState;

      const rs = this.rhythmState;
      if (rs !== null) {
        if (now > this.rhythmUntil) {
          this.rhythmState = null;
        } else {
          const stepDur = 60 / RHYTHM_BPM[rs] / 4;
          // timer throttled / just resumed: re-sync instead of machine-gunning late notes
          if (this.nextStepTime < now - 0.02) this.nextStepTime = now + 0.03;
          let guard = 0;
          while (this.nextStepTime < horizon && guard++ < 8) {
            this.scheduleStep(g, rs, this.step, this.bar, this.nextStepTime, stepDur);
            this.nextStepTime += stepDur;
            this.step++;
            if (this.step >= 16) {
              this.step = 0;
              this.bar++;
            }
          }
        }
      }

      // slow chord movement under title / explore
      if (this.nextChordTime < horizon) {
        if (st === 'title' || st === 'explore') {
          const prog = PROG[st];
          this.chordIndex = (this.chordIndex + 1) % prog.length;
          const chord = prog[this.chordIndex];
          const t = Math.max(this.nextChordTime, now + 0.02);
          const m = g.music;
          for (let i = 0; i < m.padOscs.length; i++) {
            for (const osc of m.padOscs[i]) {
              this.forget(osc.frequency);
              osc.frequency.setTargetAtTime(chord.f[i], t, 0.45);
            }
          }
          // a soft bass note and fifth mark the change
          const v = this.voice(g.musicBus, 1, 0, 0, false);
          const root = chord.f[0] < 60 ? chord.f[0] * 2 : chord.f[0];
          this.tone(v, v.out, 'sine', root, root, 0.01, t, 0.5, 0.2, 5.5);
          this.tone(v, v.out, 'triangle', root * 2, root * 2, 0.01, t, 0.7, 0.045, 4.5);
          this.tone(v, v.out, 'sine', root * 3, root * 3, 0.01, t + 0.4, 0.9, 0.02, 3.5);
          this.nextChordTime = t + CHORD_SEC;
        } else {
          this.nextChordTime = Number.POSITIVE_INFINITY;
        }
      }

      // melodic phrases: 2-4 bell notes drawn from the current chord
      if (this.nextPluckTime < horizon) {
        const t = Math.max(this.nextPluckTime, now + 0.02);
        if (st === 'title' || st === 'explore' || st === 'event') {
          const scale = st === 'event' ? PENTATONIC : PROG[st][this.chordIndex].mel;
          const count = st === 'event' ? 1 + Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 3);
          const beat = st === 'title' ? 0.62 : 0.52;
          const v = this.voice(g.music.pluckBus, 1, rand(-0.25, 0.25), 0, false);
          let nt = t;
          let idx = this.lastPluckIndex;
          for (let i = 0; i < count; i++) {
            let next = idx + Math.round(rand(-2.2, 2.2));
            if (next === idx) next += Math.random() < 0.5 ? -1 : 1;
            idx = Math.max(0, Math.min(scale.length - 1, next));
            const last = i === count - 1;
            this.bell(v, v.out, scale[idx], nt, rand(0.11, 0.16) * (last ? 1.1 : 0.9), last ? rand(2.8, 3.8) : rand(1.6, 2.4));
            if (last && Math.random() < 0.45) this.bell(v, v.out, scale[Math.max(0, idx - 2)] * 0.5, nt + beat * 0.5, 0.09, 3.0);
            nt += beat * (Math.random() < 0.3 ? 2 : 1);
          }
          this.lastPluckIndex = idx;
          this.nextPluckTime = nt + (st === 'event' ? rand(1.6, 3.4) : rand(2.2, 5));
        } else {
          this.nextPluckTime = Number.POSITIVE_INFINITY;
        }
      }

      // threat heartbeat under explore
      if (st === 'explore' && this.threat > 0.12) {
        if (this.nextHeartTime < now - 0.05) this.nextHeartTime = now + 0.05;
        if (this.nextHeartTime < horizon) {
          const t = this.nextHeartTime;
          const lvl = Math.min(1, this.threat * 1.25);
          const v = this.voice(g.musicBus, lvl, 0, 0, false);
          this.tone(v, v.out, 'sine', 74, 42, 0.09, t, 0.006, 0.44, 0.17);
          this.tone(v, v.out, 'triangle', 110, 60, 0.06, t, 0.004, 0.1, 0.07);
          this.tone(v, v.out, 'sine', 62, 38, 0.09, t + 0.19, 0.006, 0.3, 0.2);
          this.nextHeartTime = t + 60 / (54 + this.threat * 44);
        }
      }
    } catch {
      /* ignore */
    }
  }

  private scheduleStep(g: Graph, rs: RhythmState, step: number, bar: number, t: number, stepDur: number): void {
    const m = g.music;
    if (rs === 'event') {
      // gentle heartbeat pulse under the opened-up pad
      if (step % 4 === 0) {
        const v = this.voice(m.rhythmGain, 1, 0, 0, false);
        const strong = step === 0;
        const f = step === 8 ? 87.31 : 58.27; // F2 / Bb1
        const lp = this.vFilter(v, 'lowpass', strong ? 520 : 380, 0.7);
        lp.connect(v.out);
        this.tone(v, lp, 'triangle', f * 2, f * 2, 0.01, t, 0.02, strong ? 0.3 : 0.2, 0.42);
        this.tone(v, lp, 'sine', f, f, 0.01, t, 0.02, strong ? 0.34 : 0.22, 0.5);
      }
      return;
    }

    const boss = rs === 'boss';
    const th = this.threat;
    const drums = this.voice(m.rhythmGain, 1, 0, 0, false);
    let used = false;

    // --- kick
    const kick = boss
      ? step === 0 || step === 3 || step === 6 || step === 10 || (bar % 2 === 1 && step === 11)
      : step % 4 === 0 || (bar % 4 === 3 && step === 14);
    if (kick) {
      used = true;
      const lowF = boss ? 38 : 45;
      this.tone(drums, drums.out, 'sine', boss ? 140 : 155, lowF, 0.09, t, 0.002, boss ? 0.95 : 0.85, boss ? 0.3 : 0.2);
      this.burst(drums, drums.out, false, 'lowpass', 1800, 0.5, t, 0.001, 0.16, 0.012);
    }

    // --- snare (battle: 2 & 4, boss: half-time on 3)
    const snare = boss ? step === 8 : step === 4 || step === 12;
    if (snare) {
      used = true;
      this.burst(drums, drums.out, false, 'bandpass', boss ? 1500 : 1900, 0.7, t, 0.001, boss ? 0.5 : 0.4, boss ? 0.2 : 0.13);
      this.tone(drums, drums.out, 'triangle', 200, 150, 0.06, t, 0.001, 0.3, 0.09);
    }

    // --- hats
    const hat = boss ? step % 2 === 0 || step === 15 : step % 2 === 0 || step === 7 || step === 15;
    if (hat) {
      used = true;
      const open = step === 14 || (boss && step === 6);
      const off = step % 4 === 2;
      this.burst(drums, drums.out, false, 'highpass', 7200, 0.7, t, 0.001, off ? 0.11 : 0.07, open ? 0.16 : 0.03);
    }

    // --- threat layer: 16th hats / shaker, then off-beat metal percussion and ghost kicks
    if (th > 0.25) {
      const k = Math.min(1, (th - 0.25) / 0.5);
      if (step % 2 === 1) {
        used = true;
        this.burst(drums, drums.out, false, 'highpass', 8600, 0.7, t, 0.001, 0.075 * k, 0.022);
      }
      if (th > 0.55) {
        const k2 = Math.min(1, (th - 0.55) / 0.35);
        if (step === 3 || step === 6 || step === 11 || step === 14) {
          used = true;
          const pf = step === 6 || step === 14 ? 540 : 810;
          this.tone(drums, drums.out, 'triangle', pf, pf * 0.96, 0.05, t, 0.001, 0.13 * k2, 0.07);
          this.tone(drums, drums.out, 'sine', pf * 2.76, pf * 2.7, 0.05, t, 0.001, 0.06 * k2, 0.04);
        }
        if (!kick && (step === 7 || step === 15)) {
          used = true;
          this.tone(drums, drums.out, 'sine', 130, 48, 0.07, t, 0.002, 0.4 * k2, 0.12);
        }
      }
    }

    // --- boss toms (fill at the end of every second bar)
    if (boss && bar % 2 === 1 && step >= 12) {
      used = true;
      const f = BOSS_TOMS[step - 12];
      this.tone(drums, drums.out, 'sine', f * 1.5, f, 0.08, t, 0.002, 0.6, 0.24);
    }
    if (!used) this.finish(drums);

    // --- gritty bass ostinato following the 8-bar root movement
    const pattern = boss ? BOSS_BASS : BATTLE_BASS;
    const accents = boss ? BOSS_ACCENT : BATTLE_ACCENT;
    const roots = boss ? BOSS_ROOT : BATTLE_ROOT;
    const root = roots[bar % roots.length];
    const semis = pattern[step] + root;
    const f = D2 * Math.pow(2, semis / 12);
    const accent = accents[step] === 1;
    const bv = this.voice(m.bassBus, 1, 0, 0, false);
    const len = stepDur * 0.82;
    const lp = this.vFilter(bv, 'lowpass', 500, 4);
    const top = (accent ? 2100 : 950) * (1 + th * 0.8);
    lp.frequency.setValueAtTime(top, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + len);
    const eg = this.vGain(bv, 0);
    eg.gain.setValueAtTime(EPS, t);
    eg.gain.linearRampToValueAtTime(accent ? 0.5 : 0.32, t + 0.004);
    eg.gain.exponentialRampToValueAtTime(EPS, t + len);
    lp.connect(eg).connect(bv.out);
    const o1 = this.vOsc(bv, 'sawtooth', f, t, t + len + 0.02);
    const o2 = this.vOsc(bv, 'square', f * (boss ? 0.5 : 1.006), t, t + len + 0.02);
    const o2g = this.vGain(bv, boss ? 0.55 : 0.35);
    o1.connect(lp);
    o2.connect(o2g).connect(lp);

    // --- tension stabs (follow the root)
    const stab = boss
      ? (step === 0 && bar % 2 === 0) || (step === 6 && bar % 4 === 3)
      : (step === 0 && bar % 2 === 0) || (step === 10 && bar % 4 === 3);
    if (stab) {
      const sv = this.voice(m.rhythmGain, 1, 0, 0, false);
      const tr = Math.pow(2, root / 12);
      // battle: open fifth + octave (works over every root); boss: tritone cluster
      const notes = boss ? [293.66, 311.13, 440.0, 622.25] : [293.66 * tr, 440.0 * tr, 587.33 * tr];
      const slp = this.vFilter(sv, 'lowpass', 2600, 1.2);
      slp.frequency.setValueAtTime(2600, t);
      slp.frequency.exponentialRampToValueAtTime(500, t + 0.35);
      slp.connect(sv.out);
      for (const nf of notes) {
        this.tone(sv, slp, 'sawtooth', nf, nf, 0.01, t, 0.006, 0.075, boss ? 0.42 : 0.3);
        this.tone(sv, slp, 'sawtooth', nf * 1.007, nf * 1.007, 0.01, t, 0.006, 0.06, boss ? 0.42 : 0.3);
      }
    }

    // --- lead motif over the second half of the 8-bar phrase
    if (bar % 8 >= 4) {
      const semi = (boss ? BOSS_LEAD : BATTLE_LEAD)[bar % 4][step];
      if (semi !== R) {
        const lf = D4 * Math.pow(2, semi / 12) * (boss ? 0.5 : 1);
        const dur = stepDur * (boss ? 4.2 : 2.7);
        const lv = this.voice(m.leadBus, 0.8 + th * 0.3, boss ? -0.1 : 0.12, 0, false);
        const llp = this.vFilter(lv, 'lowpass', 900, 2.2);
        llp.frequency.setValueAtTime(700, t);
        llp.frequency.linearRampToValueAtTime(2400 + th * 1600, t + 0.03);
        llp.frequency.exponentialRampToValueAtTime(800, t + dur);
        const leg = this.vGain(lv, 0);
        leg.gain.setValueAtTime(EPS, t);
        leg.gain.linearRampToValueAtTime(0.2, t + 0.012);
        leg.gain.setValueAtTime(0.17, t + dur * 0.55);
        leg.gain.exponentialRampToValueAtTime(EPS, t + dur);
        llp.connect(leg).connect(lv.out);
        const a = this.vOsc(lv, 'sawtooth', lf, t, t + dur + 0.03);
        const b = this.vOsc(lv, 'sawtooth', lf * 1.008, t, t + dur + 0.03);
        const c = this.vOsc(lv, 'square', lf * 0.5, t, t + dur + 0.03);
        const cg = this.vGain(lv, 0.4);
        // short scoop into the note
        a.frequency.setValueAtTime(lf * 0.97, t);
        a.frequency.exponentialRampToValueAtTime(lf, t + 0.04);
        a.connect(llp);
        b.connect(llp);
        c.connect(cg).connect(llp);
      }
    }
  }

  // ---------------------------------------------------------------- one-shots

  play(name: SfxName, options?: SfxOptions): void {
    try {
      const g = this.g;
      if (!g || this.paused || g.ctx.state !== 'running') return;
      const mix = SFX[name];
      if (!mix) return;
      const now = g.ctx.currentTime;
      const last = this.lastPlay.get(name);
      if (last !== undefined && now - last < MIN_REPEAT_SEC) return;
      if (this.activeVoices >= (mix.priority ? MAX_VOICES_PRIORITY : MAX_VOICES)) return;
      this.lastPlay.set(name, now);

      const volume = clamp(options?.volume ?? 1, 0, 2);
      if (volume <= 0) return;
      const pan = clamp(options?.pan ?? 0, -1, 1);
      let pitch = clamp(options?.pitch ?? 1, 0.25, 4) * (mix.vary ? 1 + rand(-0.04, 0.04) : 1);

      if (name === 'pickupScrap') {
        // rapid pickups climb a pentatonic ladder
        this.scrapStep = now - this.lastScrapTime < 1 ? Math.min(this.scrapStep + 1, SCRAP_LADDER.length - 1) : 0;
        this.lastScrapTime = now;
        pitch *= Math.pow(2, SCRAP_LADDER[this.scrapStep] / 12);
      } else if (name === 'combo') {
        // each call inside 8 s steps up the scale; options.pitch >= 1.5 is read as the combo multiplier (x2, x3...)
        const hint = options?.pitch ?? 1;
        this.comboStep = now - this.lastComboTime < 8 ? Math.min(this.comboStep + 1, COMBO_LADDER.length - 1) : 0;
        this.lastComboTime = now;
        if (hint >= 1.5) {
          this.comboStep = Math.min(COMBO_LADDER.length - 1, Math.max(0, Math.round(hint) - 1));
          pitch = 1;
        }
        pitch *= Math.pow(2, COMBO_LADDER[this.comboStep] / 12);
      } else if (name === 'comboBreak') {
        this.lastComboTime = -100;
      }

      if (mix.duck) this.duckBed(g, mix.duck + (1 - mix.duck) * (1 - Math.min(1, volume)), mix.hold ?? 0.2);

      const v = this.voice(g.sfxBus, volume * mix.vol, pan, mix.send, true);
      try {
        this.buildSfx(g, name, v, now + 0.004, pitch);
        if (v.pending === 0) this.finish(v);
      } catch {
        this.finish(v);
      }
    } catch {
      /* ignore */
    }
  }

  /** Sidechain-style duck of the music + ambience bed (never the engine or sfx). */
  private duckBed(g: Graph, depth: number, hold: number): void {
    const now = g.ctx.currentTime;
    const p = g.duck.gain;
    p.cancelScheduledValues(now);
    p.setTargetAtTime(clamp(depth, 0.4, 1), now, DUCK_ATTACK_TC);
    p.setTargetAtTime(1, now + hold, DUCK_RELEASE_TC);
  }

  private buildSfx(g: Graph, name: SfxName, v: Voice, t: number, p: number): void {
    const out = v.out;
    switch (name) {
      case 'playerShot': {
        // autocannon: chest thump + sub + barrel bark + crack + low body + breech clack
        this.tone(v, out, 'sine', 180 * p, 58 * p, 0.09, t, 0.002, 0.8, 0.11);
        this.tone(v, out, 'sine', 96 * p, 41 * p, 0.12, t, 0.003, 0.55, 0.17);
        this.tone(v, out, 'triangle', 330 * p, 120 * p, 0.05, t, 0.001, 0.22, 0.05);
        this.burst(v, out, false, 'bandpass', 1350 * p, 0.8, t, 0.001, 0.55, 0.065);
        this.burst(v, out, false, 'highpass', 4600, 0.7, t, 0.0005, 0.24, 0.022);
        this.burst(v, out, true, 'lowpass', 560 * p, 0.6, t, 0.004, 0.55, 0.17);
        this.burst(v, out, false, 'bandpass', 3100 * p, 3, t + 0.042, 0.0005, 0.07, 0.012);
        break;
      }
      case 'enemyShot': {
        const hp = this.vFilter(v, 'highpass', 520, 0.7);
        hp.connect(out);
        this.burst(v, hp, false, 'bandpass', 2700 * p, 1.2, t, 0.001, 0.5, 0.05);
        this.tone(v, hp, 'triangle', 460 * p, 170 * p, 0.05, t, 0.001, 0.3, 0.06);
        this.burst(v, hp, false, 'highpass', 6000, 0.7, t, 0.0005, 0.14, 0.015);
        break;
      }
      case 'hitMetal': {
        const kind = Math.floor(Math.random() * 3);
        if (kind === 0) {
          // bright plate ping
          const partials = [1230, 1870, 2640, 3510];
          for (let i = 0; i < partials.length; i++) {
            const f = partials[i] * p * rand(0.96, 1.04);
            this.tone(v, out, 'sine', f, f * 0.985, 0.08, t, 0.001, 0.26 / (1 + i * 0.6), 0.09 - i * 0.012);
          }
          this.burst(v, out, false, 'highpass', 3200, 0.7, t, 0.0005, 0.3, 0.012);
        } else if (kind === 1) {
          // heavy armour clank
          const partials = [640, 1010, 1630, 2480];
          for (let i = 0; i < partials.length; i++) {
            const f = partials[i] * p * rand(0.94, 1.06);
            this.tone(v, out, i < 2 ? 'triangle' : 'sine', f, f * 0.97, 0.1, t, 0.001, 0.3 / (1 + i * 0.5), 0.11 - i * 0.018);
          }
          this.tone(v, out, 'sine', 210 * p, 90 * p, 0.04, t, 0.001, 0.4, 0.045);
          this.burst(v, out, false, 'bandpass', 2100, 0.9, t, 0.0005, 0.3, 0.02);
        } else {
          // glancing spark: tick + short falling zing
          const f = rand(2500, 3400) * p;
          this.tone(v, out, 'sine', f, f * 0.62, 0.09, t, 0.001, 0.2, 0.1);
          this.tone(v, out, 'sine', f * 1.52, f * 1.44, 0.05, t, 0.001, 0.1, 0.05);
          this.burst(v, out, false, 'bandpass', 5200, 1.5, t, 0.0005, 0.34, 0.016);
          this.tone(v, out, 'triangle', 900 * p, 700 * p, 0.03, t, 0.001, 0.16, 0.03);
        }
        break;
      }
      case 'hitPlayer': {
        const shaper = this.vShaper(v, g.hardCurve);
        const post = this.vGain(v, 0.75);
        shaper.connect(post).connect(out);
        this.tone(v, out, 'sine', 115 * p, 44 * p, 0.14, t, 0.003, 0.85, 0.2);
        const crunch = [310, 487, 742, 1130];
        for (let i = 0; i < crunch.length; i++) {
          const f = crunch[i] * p * rand(0.95, 1.05);
          this.tone(v, shaper, 'square', f, f * 0.9, 0.12, t, 0.001, 0.16, 0.11 - i * 0.015);
        }
        this.burst(v, shaper, false, 'lowpass', 1500, 0.6, t, 0.002, 0.4, 0.1);
        break;
      }
      case 'explosionSmall':
        this.explosion(v, t, p, { f0: 92, f1: 38, boom: 0.6, rumble: 0.75, crack: 0.5, debris: 5 });
        break;
      case 'explosionBig':
        this.explosion(v, t, p, { f0: 70, f1: 28, boom: 1.4, rumble: 1.8, crack: 0.6, debris: 11 });
        break;
      case 'mortarImpact':
        this.explosion(v, t, p, { f0: 84, f1: 32, boom: 0.8, rumble: 1.0, crack: 0.85, debris: 8 });
        break;
      case 'mortarLaunch': {
        // hollow tube thump
        this.tone(v, out, 'sine', 150 * p, 68 * p, 0.12, t, 0.003, 0.75, 0.16);
        this.burst(v, out, true, 'bandpass', 380 * p, 2.2, t, 0.003, 0.7, 0.13);
        this.burst(v, out, false, 'bandpass', 900 * p, 1.0, t, 0.001, 0.2, 0.04);
        // shell whistle: rises, then falls away
        const osc = this.vOsc(v, 'sine', 700 * p, t + 0.05, t + 1.25);
        osc.frequency.setValueAtTime(700 * p, t + 0.05);
        osc.frequency.exponentialRampToValueAtTime(1500 * p, t + 0.5);
        osc.frequency.exponentialRampToValueAtTime(520 * p, t + 1.2);
        const wg = this.vGain(v, 0);
        wg.gain.setValueAtTime(EPS, t + 0.05);
        wg.gain.linearRampToValueAtTime(0.09, t + 0.4);
        wg.gain.exponentialRampToValueAtTime(EPS, t + 1.22);
        osc.connect(wg).connect(out);
        const air = this.burst(v, out, false, 'bandpass', 1400 * p, 5, t + 0.05, 0.3, 0.1, 0.85);
        air.frequency.setValueAtTime(1400 * p, t + 0.05);
        air.frequency.exponentialRampToValueAtTime(3000 * p, t + 0.5);
        air.frequency.exponentialRampToValueAtTime(1000 * p, t + 1.2);
        break;
      }
      case 'crash': {
        const shaper = this.vShaper(v, g.softCurve);
        const post = this.vGain(v, 0.8);
        shaper.connect(post).connect(out);
        this.tone(v, out, 'sine', 96 * p, 40 * p, 0.18, t, 0.003, 0.85, 0.24);
        this.burst(v, shaper, false, 'lowpass', 2600, 0.5, t, 0.002, 0.6, 0.17);
        this.burst(v, shaper, true, 'lowpass', 700, 0.5, t, 0.004, 0.7, 0.3);
        const metal = [420, 633, 951, 1480, 2210];
        for (let i = 0; i < metal.length; i++) {
          const f = metal[i] * p * rand(0.94, 1.06);
          this.tone(v, shaper, 'triangle', f, f * 0.97, 0.2, t + rand(0, 0.012), 0.001, 0.2 / (1 + i * 0.4), 0.26 - i * 0.03);
        }
        // glass / debris scatter
        for (let i = 0; i < 4; i++) {
          this.burst(v, out, false, 'bandpass', rand(1500, 5000), rand(3, 7), t + rand(0.08, 0.4), 0.002, rand(0.05, 0.12), rand(0.03, 0.07));
        }
        break;
      }
      case 'boostStart': {
        this.tone(v, out, 'sine', 125 * p, 48 * p, 0.15, t, 0.003, 0.75, 0.2);
        const src = this.vNoise(v, false, t, t + 0.85);
        const bp = this.vFilter(v, 'bandpass', 300, 1.5);
        bp.frequency.setValueAtTime(300 * p, t);
        bp.frequency.exponentialRampToValueAtTime(3400 * p, t + 0.6);
        const wg = this.vGain(v, 0);
        wg.gain.setValueAtTime(EPS, t);
        wg.gain.linearRampToValueAtTime(0.55, t + 0.34);
        wg.gain.exponentialRampToValueAtTime(EPS, t + 0.82);
        src.connect(bp).connect(wg).connect(out);
        // turbine spin-up
        const osc = this.tone(v, out, 'triangle', 420 * p, 1900 * p, 0.55, t, 0.25, 0.06, 0.5);
        osc.detune.value = 6;
        break;
      }
      case 'uiClick': {
        // soft relay: contact tick + tiny body + bounce
        this.burst(v, out, false, 'bandpass', 1800, 1.6, t, 0.0005, 0.45, 0.016);
        this.tone(v, out, 'sine', 170, 92, 0.035, t, 0.001, 0.4, 0.04);
        this.burst(v, out, false, 'bandpass', 2400, 2.0, t + 0.028, 0.0005, 0.14, 0.01);
        break;
      }
      case 'uiConfirm': {
        const lp = this.vFilter(v, 'lowpass', 1900, 0.7);
        lp.connect(out);
        this.burst(v, out, false, 'bandpass', 1700, 1.6, t, 0.0005, 0.25, 0.014);
        const notes = [293.66, 440.0]; // D4 -> A4
        for (let i = 0; i < notes.length; i++) {
          const nt = t + 0.008 + i * 0.115;
          this.tone(v, lp, 'triangle', notes[i], notes[i], 0.01, nt, 0.008, 0.32, 0.3);
          this.tone(v, lp, 'sine', notes[i] * 2, notes[i] * 2, 0.01, nt, 0.006, 0.07, 0.16);
        }
        break;
      }
      case 'radioOpen':
      case 'radioClose': {
        const open = name === 'radioOpen';
        const dur = open ? 0.13 : 0.075;
        const src = this.vNoise(v, false, t, t + dur + 0.04);
        const hp = this.vFilter(v, 'highpass', 1000, 0.8);
        const lp = this.vFilter(v, 'lowpass', 3000, 0.8);
        const sg = this.vGain(v, 0);
        sg.gain.setValueAtTime(EPS, t);
        sg.gain.linearRampToValueAtTime(0.4, t + 0.004);
        sg.gain.setValueAtTime(0.34, t + dur - 0.012);
        sg.gain.exponentialRampToValueAtTime(EPS, t + dur + 0.012);
        src.connect(hp).connect(lp).connect(sg).connect(out);
        // key click + carrier chirp
        this.burst(v, out, false, 'bandpass', 2300, 2, open ? t : t + dur, 0.0005, 0.35, 0.008);
        if (open) this.tone(v, out, 'sine', 1400, 2100, 0.05, t + dur - 0.02, 0.004, 0.09, 0.06);
        else this.tone(v, out, 'sine', 1900, 1100, 0.05, t, 0.004, 0.09, 0.06);
        break;
      }
      case 'objective': {
        this.bell(v, out, 440.0, t, 0.42, 1.3); // A4
        this.bell(v, out, 587.33, t + 0.17, 0.5, 1.9); // D5
        break;
      }
      case 'relayPowerUp': {
        // 2.5 s: hum winds up with a quickening flutter, then a shimmering chord
        const lp = this.vFilter(v, 'lowpass', 200, 2);
        lp.frequency.setValueAtTime(200, t);
        lp.frequency.exponentialRampToValueAtTime(2600, t + 2.2);
        const amp = this.vGain(v, 0);
        amp.gain.setValueAtTime(EPS, t);
        amp.gain.linearRampToValueAtTime(0.3, t + 2.0);
        amp.gain.exponentialRampToValueAtTime(EPS, t + 2.55);
        const trem = this.vGain(v, 1);
        const lfo = this.vOsc(v, 'sine', 5, t, t + 2.6);
        lfo.frequency.setValueAtTime(5, t);
        lfo.frequency.exponentialRampToValueAtTime(28, t + 2.2);
        const lfoDepth = this.vGain(v, 0.3);
        lfo.connect(lfoDepth).connect(trem.gain);
        lp.connect(trem).connect(amp).connect(out);
        const saw = this.vOsc(v, 'sawtooth', 45, t, t + 2.6);
        sweep(saw.frequency, t, 45, 180, 2.2);
        const saw2 = this.vOsc(v, 'sawtooth', 45.4, t, t + 2.6);
        sweep(saw2.frequency, t, 45.4, 181.5, 2.2);
        const sine = this.vOsc(v, 'sine', 90, t, t + 2.6);
        sweep(sine.frequency, t, 90, 360, 2.2);
        const hi = this.vOsc(v, 'triangle', 180, t, t + 2.6);
        sweep(hi.frequency, t, 180, 720, 2.2);
        const hiGain = this.vGain(v, 0.3);
        saw.connect(lp);
        saw2.connect(lp);
        sine.connect(lp);
        hi.connect(hiGain).connect(lp);
        // shimmer: D5 A5 D6 E6, detuned pairs
        const chord = [587.33, 880.0, 1174.66, 1318.51];
        for (const f of chord) {
          this.tone(v, out, 'sine', f, f, 0.01, t + 2.0, 0.18, 0.075, 1.6);
          this.tone(v, out, 'sine', f * 1.004, f * 1.004, 0.01, t + 2.0, 0.22, 0.06, 1.5);
        }
        this.tone(v, out, 'sine', 146.83, 146.83, 0.01, t + 2.0, 0.1, 0.3, 1.2);
        break;
      }
      case 'alarm': {
        // two alternating tones x3 (~1.8 s), driven for grit
        const total = 1.8;
        const shaper = this.vShaper(v, g.hardCurve);
        const bp = this.vFilter(v, 'bandpass', 1100, 0.7);
        const amp = this.vGain(v, 0);
        shaper.connect(bp).connect(amp).connect(out);
        const a = this.vOsc(v, 'square', 620, t, t + total + 0.03);
        const b = this.vOsc(v, 'sawtooth', 623, t, t + total + 0.03);
        const pre = this.vGain(v, 0.6);
        a.connect(pre);
        b.connect(pre);
        pre.connect(shaper);
        amp.gain.setValueAtTime(EPS, t);
        for (let i = 0; i < 6; i++) {
          const nt = t + i * 0.3;
          const f = i % 2 === 0 ? 622.25 : 466.16; // Eb5 / Bb4
          a.frequency.setValueAtTime(f, nt);
          b.frequency.setValueAtTime(f * 1.006, nt);
          amp.gain.setValueAtTime(EPS, nt);
          amp.gain.linearRampToValueAtTime(0.3, nt + 0.015);
          amp.gain.setValueAtTime(0.3, nt + 0.25);
          amp.gain.linearRampToValueAtTime(EPS, nt + 0.295);
        }
        break;
      }
      case 'repair': {
        // ratchet clicks + rising tone
        for (let i = 0; i < 6; i++) {
          this.burst(v, out, false, 'bandpass', 2500 + i * 90, 3, t + i * 0.055, 0.0005, 0.3, 0.014);
        }
        const lp = this.vFilter(v, 'lowpass', 1500, 0.7);
        lp.connect(out);
        this.tone(v, lp, 'triangle', 293.66, 587.33, 0.42, t + 0.05, 0.12, 0.2, 0.42);
        this.tone(v, lp, 'sine', 440.0, 880.0, 0.42, t + 0.05, 0.14, 0.07, 0.36);
        break;
      }
      case 'overheat': {
        this.burst(v, out, false, 'highpass', 3400, 0.7, t, 0.012, 0.3, 0.7);
        const lp = this.vFilter(v, 'lowpass', 1300, 1);
        lp.connect(out);
        this.tone(v, lp, 'sawtooth', 520 * p, 140 * p, 0.6, t, 0.01, 0.16, 0.62);
        this.tone(v, out, 'sine', 180 * p, 70 * p, 0.3, t, 0.004, 0.3, 0.3);
        break;
      }
      case 'missileLaunch': {
        // launch thump + clamp release, hissing ignition that sweeps up, low motor roar, receding whistle
        this.tone(v, out, 'sine', 135 * p, 44 * p, 0.14, t, 0.003, 0.85, 0.24);
        this.burst(v, out, false, 'bandpass', 1900, 1.2, t, 0.0005, 0.4, 0.02);
        const hiss = this.vNoise(v, false, t, t + 0.95);
        const bp = this.vFilter(v, 'bandpass', 900, 0.9);
        bp.frequency.setValueAtTime(900 * p, t);
        bp.frequency.exponentialRampToValueAtTime(Math.min(16000, 4600 * p), t + 0.4);
        bp.frequency.exponentialRampToValueAtTime(2400 * p, t + 0.9);
        const hg = this.vGain(v, 0);
        hg.gain.setValueAtTime(EPS, t);
        hg.gain.linearRampToValueAtTime(0.7, t + 0.045);
        hg.gain.setValueAtTime(0.6, t + 0.25);
        hg.gain.exponentialRampToValueAtTime(EPS, t + 0.92);
        hiss.connect(bp).connect(hg).connect(out);
        const roar = this.burst(v, out, true, 'lowpass', 700, 0.8, t, 0.03, 0.6, 0.75);
        sweep(roar.frequency, t, 700, 240, 0.8);
        const lp = this.vFilter(v, 'lowpass', 2200, 1);
        lp.connect(out);
        this.tone(v, lp, 'sawtooth', 620 * p, 210 * p, 0.8, t + 0.03, 0.05, 0.1, 0.8);
        break;
      }
      case 'missileLock': {
        // three rising beeps, then a solid lock tone
        const lp = this.vFilter(v, 'lowpass', 4200, 0.7);
        lp.connect(out);
        const beeps = [987.77, 1174.66, 1396.91];
        for (let i = 0; i < beeps.length; i++) {
          this.gate(v, lp, 'square', beeps[i], t + i * 0.095, 0.05, 0.16);
          this.gate(v, lp, 'sine', beeps[i] * 2, t + i * 0.095, 0.05, 0.08);
        }
        const ts = t + 0.3;
        this.gate(v, lp, 'square', 1760, ts, 0.36, 0.17);
        this.gate(v, lp, 'sine', 1760, ts, 0.36, 0.2);
        this.gate(v, lp, 'sine', 880, ts, 0.36, 0.12);
        break;
      }
      case 'pickupScrap': {
        // two small metal clinks; p carries the ladder pitch
        for (let k = 0; k < 2; k++) {
          const tk = t + k * 0.062;
          const f = (k === 0 ? 1568 : 2093) * p;
          const amp = k === 0 ? 0.3 : 0.38;
          this.tone(v, out, 'sine', f, f * 0.995, 0.1, tk, 0.001, amp, 0.14);
          this.tone(v, out, 'sine', f * 2.41, f * 2.4, 0.05, tk, 0.001, amp * 0.4, 0.07);
          this.tone(v, out, 'sine', f * 3.87, f * 3.85, 0.03, tk, 0.001, amp * 0.2, 0.04);
          this.burst(v, out, false, 'highpass', 5200, 0.7, tk, 0.0005, 0.16, 0.008);
        }
        break;
      }
      case 'pickupRepair': {
        // warm rising two-note + ratchet
        for (let i = 0; i < 4; i++) {
          this.burst(v, out, false, 'bandpass', 2300 + i * 130, 3, t + i * 0.045, 0.0005, 0.24, 0.012);
        }
        const lp = this.vFilter(v, 'lowpass', 1900, 0.7);
        lp.connect(out);
        const notes = [293.66, 440.0];
        for (let i = 0; i < notes.length; i++) {
          const nt = t + 0.03 + i * 0.13;
          this.tone(v, lp, 'triangle', notes[i] * 0.97, notes[i], 0.05, nt, 0.012, 0.36, i === 0 ? 0.22 : 0.45);
          this.tone(v, lp, 'sine', notes[i] * 2, notes[i] * 2, 0.01, nt, 0.01, 0.1, 0.25);
          this.tone(v, lp, 'sine', notes[i] * 0.5, notes[i] * 0.5, 0.01, nt, 0.012, 0.2, 0.3);
        }
        break;
      }
      case 'pickupBoost': {
        // pressurised gas release + rising tone
        this.burst(v, out, false, 'highpass', 3600, 0.7, t, 0.004, 0.42, 0.3);
        const bp = this.burst(v, out, false, 'bandpass', 1200, 2, t, 0.01, 0.5, 0.28);
        sweep(bp.frequency, t, 1200, 5200, 0.26);
        this.tone(v, out, 'sine', 120, 70, 0.04, t, 0.002, 0.4, 0.06);
        const lp = this.vFilter(v, 'lowpass', 3200, 0.7);
        lp.connect(out);
        this.tone(v, lp, 'triangle', 330, 990, 0.3, t + 0.03, 0.08, 0.26, 0.34);
        this.tone(v, lp, 'sine', 660, 1980, 0.3, t + 0.03, 0.1, 0.08, 0.3);
        break;
      }
      case 'pickupMissile': {
        // heavy latch clunk, second catch, arming chirp
        for (let k = 0; k < 2; k++) {
          const tk = t + k * 0.095;
          const a = k === 0 ? 1 : 0.6;
          this.tone(v, out, 'sine', 120, 52, 0.06, tk, 0.002, 0.8 * a, 0.1);
          this.burst(v, out, false, 'lowpass', 1300, 0.7, tk, 0.001, 0.5 * a, 0.035);
          this.tone(v, out, 'square', 610 * rand(0.97, 1.03), 590, 0.05, tk, 0.001, 0.1 * a, 0.05);
          this.tone(v, out, 'triangle', 937, 920, 0.05, tk, 0.001, 0.12 * a, 0.06);
        }
        this.tone(v, out, 'sine', 1250, 2500, 0.08, t + 0.21, 0.01, 0.2, 0.09);
        this.gate(v, out, 'sine', 2500, t + 0.33, 0.04, 0.16);
        this.gate(v, out, 'sine', 2500, t + 0.4, 0.04, 0.16);
        break;
      }
      case 'combo': {
        // bright stab that climbs with the multiplier
        const f = 523.25 * p;
        const lp = this.vFilter(v, 'lowpass', 5200, 1.4);
        lp.frequency.setValueAtTime(5600, t);
        lp.frequency.exponentialRampToValueAtTime(1400, t + 0.32);
        lp.connect(out);
        for (const ratio of [1, 1.5, 2]) {
          const o = this.tone(v, lp, 'sawtooth', f * ratio * 0.94, f * ratio, 0.03, t, 0.004, 0.13, 0.3);
          o.detune.value = 5;
          this.tone(v, lp, 'square', f * ratio * 0.94, f * ratio, 0.03, t, 0.004, 0.05, 0.22);
        }
        this.bell(v, out, f * 2, t + 0.02, 0.22, 0.5);
        this.burst(v, out, false, 'highpass', 6000, 0.7, t, 0.0005, 0.12, 0.02);
        break;
      }
      case 'comboBreak': {
        const lp = this.vFilter(v, 'lowpass', 1300, 0.8);
        lp.connect(out);
        this.tone(v, lp, 'triangle', 440, 185, 0.28, t, 0.008, 0.4, 0.32);
        this.tone(v, lp, 'sine', 220, 92.5, 0.28, t, 0.008, 0.3, 0.3);
        this.burst(v, out, true, 'lowpass', 400, 0.7, t + 0.2, 0.005, 0.25, 0.1);
        break;
      }
      case 'upgrade': {
        // power-up: D add9 chord swelling open, rising air, sub hit and sparkle on arrival
        const lp = this.vFilter(v, 'lowpass', 400, 1.2);
        lp.frequency.setValueAtTime(380, t);
        lp.frequency.exponentialRampToValueAtTime(5200, t + 0.62);
        lp.frequency.exponentialRampToValueAtTime(1500, t + 1.25);
        const amp = this.vGain(v, 0);
        amp.gain.setValueAtTime(EPS, t);
        amp.gain.exponentialRampToValueAtTime(0.5, t + 0.6);
        amp.gain.exponentialRampToValueAtTime(EPS, t + 1.3);
        lp.connect(amp).connect(out);
        const chord = [146.83, 220.0, 293.66, 369.99, 440.0, 659.25];
        for (let i = 0; i < chord.length; i++) {
          const a = this.vOsc(v, 'sawtooth', chord[i], t, t + 1.34);
          const b = this.vOsc(v, 'sawtooth', chord[i] * 1.007, t, t + 1.34);
          const og = this.vGain(v, 0.2 / (1 + i * 0.15));
          a.connect(og);
          b.connect(og);
          og.connect(lp);
        }
        const air = this.burst(v, out, false, 'bandpass', 500, 1.5, t, 0.55, 0.22, 0.25);
        sweep(air.frequency, t, 500, 6500, 0.6);
        this.tone(v, out, 'sine', 110, 73.42, 0.1, t + 0.58, 0.01, 0.6, 0.5);
        this.bell(v, out, 1174.66, t + 0.6, 0.2, 0.9);
        this.bell(v, out, 1760, t + 0.7, 0.15, 0.8);
        this.bell(v, out, 2349.32, t + 0.8, 0.1, 0.7);
        break;
      }
      case 'lowArmor': {
        // urgent two-tone alarm x2, driven for grit
        const shaper = this.vShaper(v, g.hardCurve);
        const bp = this.vFilter(v, 'bandpass', 1300, 0.8);
        const amp = this.vGain(v, 0);
        shaper.connect(bp).connect(amp).connect(out);
        const total = 0.72;
        const a = this.vOsc(v, 'square', 740, t, t + total + 0.03);
        const b = this.vOsc(v, 'sawtooth', 744, t, t + total + 0.03);
        const pre = this.vGain(v, 0.7);
        a.connect(pre);
        b.connect(pre);
        pre.connect(shaper);
        amp.gain.setValueAtTime(EPS, t);
        for (let i = 0; i < 4; i++) {
          const nt = t + i * 0.18;
          const f = i % 2 === 0 ? 739.99 : 554.37; // F#5 / C#5
          a.frequency.setValueAtTime(f, nt);
          b.frequency.setValueAtTime(f * 1.008, nt);
          amp.gain.setValueAtTime(EPS, nt);
          amp.gain.linearRampToValueAtTime(0.34, nt + 0.01);
          amp.gain.setValueAtTime(0.34, nt + 0.14);
          amp.gain.linearRampToValueAtTime(EPS, nt + 0.172);
        }
        this.tone(v, out, 'sine', 150, 80, 0.05, t, 0.003, 0.3, 0.09);
        this.tone(v, out, 'sine', 150, 80, 0.05, t + 0.36, 0.003, 0.3, 0.09);
        break;
      }
      case 'nearMiss': {
        // something heavy passing close: doppler whoosh that crosses the stereo field
        const sweepPan = this.g!.ctx.createStereoPanner();
        v.nodes.push(sweepPan);
        const dir = Math.random() < 0.5 ? -1 : 1;
        sweepPan.pan.setValueAtTime(-0.75 * dir, t);
        sweepPan.pan.linearRampToValueAtTime(0.75 * dir, t + 0.36);
        sweepPan.connect(out);
        const src = this.vNoise(v, false, t, t + 0.5);
        const bp = this.vFilter(v, 'bandpass', 2600, 1.6);
        bp.frequency.setValueAtTime(3000 * p, t);
        bp.frequency.exponentialRampToValueAtTime(520 * p, t + 0.42);
        const eg = this.vGain(v, 0);
        eg.gain.setValueAtTime(EPS, t);
        eg.gain.exponentialRampToValueAtTime(0.9, t + 0.13);
        eg.gain.exponentialRampToValueAtTime(EPS, t + 0.47);
        src.connect(bp).connect(eg).connect(sweepPan);
        const lp = this.vFilter(v, 'lowpass', 900, 1);
        lp.connect(sweepPan);
        const o = this.tone(v, lp, 'sawtooth', 300 * p, 300 * p, 0.01, t, 0.12, 0.2, 0.32);
        o.frequency.setValueAtTime(300 * p, t);
        o.frequency.setValueAtTime(300 * p, t + 0.1);
        o.frequency.exponentialRampToValueAtTime(150 * p, t + 0.3);
        const rumble = this.burst(v, sweepPan, true, 'lowpass', 300, 0.7, t, 0.12, 0.4, 0.3);
        rumble.Q.value = 0.8;
        break;
      }
      case 'driftScore': {
        // tyre chirp + small chime
        const bp = this.burst(v, out, false, 'bandpass', 1500 * p, 7, t, 0.004, 0.6, 0.085);
        sweep(bp.frequency, t, 1500 * p, 2300 * p, 0.08);
        this.tone(v, out, 'sawtooth', 950 * p, 1350 * p, 0.07, t, 0.004, 0.05, 0.07);
        this.bell(v, out, 1318.51, t + 0.07, 0.24, 0.5);
        this.bell(v, out, 1975.53, t + 0.15, 0.2, 0.6);
        break;
      }
      case 'barrelExplosion': {
        // sharp crack, ringing drum shell, fire whoosh; shorter and more metallic than a vehicle explosion
        this.burst(v, out, false, 'highpass', 1800, 0.7, t, 0.0005, 0.85, 0.035);
        this.tone(v, out, 'triangle', 420 * p, 80 * p, 0.04, t, 0.001, 0.6, 0.05);
        this.tone(v, out, 'sine', 118 * p, 40 * p, 0.2, t, 0.003, 0.85, 0.36);
        this.tone(v, out, 'sine', 70 * p, 30 * p, 0.3, t, 0.01, 0.45, 0.45);
        const ring = [311, 517, 843, 1289, 1760];
        for (let i = 0; i < ring.length; i++) {
          const f = ring[i] * p * rand(0.97, 1.03);
          this.tone(v, out, i % 2 === 0 ? 'triangle' : 'sine', f, f * 0.955, 0.4, t + 0.004, 0.001, 0.2 / (1 + i * 0.35), 0.55 - i * 0.07);
        }
        const fire = this.vNoise(v, false, t, t + 0.95);
        const fbp = this.vFilter(v, 'bandpass', 420, 0.8);
        fbp.frequency.setValueAtTime(380, t);
        fbp.frequency.exponentialRampToValueAtTime(1500, t + 0.3);
        fbp.frequency.exponentialRampToValueAtTime(500, t + 0.9);
        const fg = this.vGain(v, 0);
        fg.gain.setValueAtTime(EPS, t);
        fg.gain.linearRampToValueAtTime(0.5, t + 0.16);
        fg.gain.exponentialRampToValueAtTime(EPS, t + 0.92);
        fire.connect(fbp).connect(fg).connect(out);
        const lp = this.burst(v, out, true, 'lowpass', 1400, 0.5, t, 0.006, 0.6, 0.6);
        sweep(lp.frequency, t, 1400, 90, 0.5);
        for (let i = 0; i < 4; i++) {
          const f = rand(900, 2600);
          this.tone(v, out, 'triangle', f, f * 0.98, 0.05, t + rand(0.15, 0.6), 0.001, rand(0.04, 0.09), rand(0.05, 0.12));
        }
        break;
      }
      case 'bulletWhiz': {
        // supersonic crack then a very short falling zip
        this.burst(v, out, false, 'highpass', 4200, 0.7, t, 0.0003, 0.5, 0.006);
        const bp = this.burst(v, out, false, 'bandpass', 6200 * p, 7, t + 0.004, 0.012, 0.9, 0.085);
        sweep(bp.frequency, t + 0.004, 6200 * p, 1500 * p, 0.09);
        this.tone(v, out, 'sine', 3300 * p, 900 * p, 0.09, t + 0.004, 0.01, 0.1, 0.08);
        break;
      }
      case 'ricochet': {
        // "pyeew": impact tick, then a whining tone that falls away (sometimes rises first)
        const f0 = rand(2300, 3900) * p;
        const dur = rand(0.2, 0.36);
        const end = f0 * rand(0.24, 0.42);
        this.burst(v, out, false, 'highpass', 3000, 0.7, t, 0.0005, 0.4, 0.01);
        this.tone(v, out, 'triangle', 1100 * p, 700 * p, 0.02, t, 0.001, 0.2, 0.025);
        const osc = this.vOsc(v, 'sine', f0, t, t + dur + 0.05);
        const osc2 = this.vOsc(v, 'triangle', f0 * 1.5, t, t + dur + 0.05);
        const g2 = this.vGain(v, 0.25);
        const eg = this.vGain(v, 0);
        const rise = Math.random() < 0.3;
        for (const o of [osc, osc2]) {
          const k = o === osc ? 1 : 1.5;
          o.frequency.setValueAtTime(f0 * k * (rise ? 0.8 : 1), t);
          if (rise) o.frequency.exponentialRampToValueAtTime(f0 * k * 1.12, t + dur * 0.22);
          o.frequency.exponentialRampToValueAtTime(end * k, t + dur);
        }
        eg.gain.setValueAtTime(EPS, t);
        eg.gain.linearRampToValueAtTime(0.34, t + 0.006);
        eg.gain.exponentialRampToValueAtTime(EPS, t + dur + 0.03);
        osc.connect(eg);
        osc2.connect(g2).connect(eg);
        eg.connect(out);
        const nz = this.burst(v, out, false, 'bandpass', f0, 14, t, 0.004, 0.5, dur);
        sweep(nz.frequency, t, f0, end, dur);
        break;
      }
      case 'hornBoss': {
        // rig air-horn: diminished cluster of detuned reeds through a driven horn body, with sub
        const dur = 1.6;
        const shaper = this.vShaper(v, g.softCurve);
        const form = this.vFilter(v, 'peaking', 620, 1.2);
        form.gain.value = 7;
        const form2 = this.vFilter(v, 'peaking', 1450, 2);
        form2.gain.value = 4;
        const lp = this.vFilter(v, 'lowpass', 2300, 0.7);
        const amp = this.vGain(v, 0);
        amp.gain.setValueAtTime(EPS, t);
        amp.gain.linearRampToValueAtTime(0.52, t + 0.07);
        amp.gain.linearRampToValueAtTime(0.44, t + 0.3);
        amp.gain.setValueAtTime(0.44, t + dur - 0.28);
        amp.gain.exponentialRampToValueAtTime(EPS, t + dur);
        // slow beating tremolo, like two horns slightly out of tune
        const trem = this.vGain(v, 1);
        const lfo = this.vOsc(v, 'sine', 6.3, t, t + dur + 0.05);
        const depth = this.vGain(v, 0.08);
        lfo.connect(depth).connect(trem.gain);
        const pre = this.vGain(v, 0.5);
        pre.connect(shaper).connect(form).connect(form2).connect(lp).connect(trem).connect(amp).connect(out);
        const notes = [146.83, 174.61, 207.65]; // D3 F3 Ab3
        for (let i = 0; i < notes.length; i++) {
          for (const det of [-9, 8]) {
            const o = this.vOsc(v, 'sawtooth', notes[i], t, t + dur + 0.05);
            o.detune.value = det + i * 3;
            // scoop up on the attack, sag as the air runs out
            o.frequency.setValueAtTime(notes[i] * 0.93, t);
            o.frequency.exponentialRampToValueAtTime(notes[i], t + 0.11);
            o.frequency.setValueAtTime(notes[i], t + dur - 0.3);
            o.frequency.exponentialRampToValueAtTime(notes[i] * 0.955, t + dur);
            o.connect(pre);
          }
        }
        const sq = this.vOsc(v, 'square', 73.42, t, t + dur + 0.05);
        const sqg = this.vGain(v, 0.5);
        sq.connect(sqg).connect(pre);
        const sub = this.vOsc(v, 'sine', 73.42, t, t + dur + 0.05);
        const sub2 = this.vOsc(v, 'sine', 36.71, t, t + dur + 0.05);
        const subAmp = this.vGain(v, 0);
        subAmp.gain.setValueAtTime(EPS, t);
        subAmp.gain.linearRampToValueAtTime(0.4, t + 0.09);
        subAmp.gain.setValueAtTime(0.4, t + dur - 0.3);
        subAmp.gain.exponentialRampToValueAtTime(EPS, t + dur);
        sub.connect(subAmp);
        sub2.connect(subAmp);
        subAmp.connect(out);
        // air blast at the onset
        this.burst(v, out, false, 'bandpass', 1500, 0.8, t, 0.02, 0.2, 0.25);
        break;
      }
      case 'gearShift': {
        // dog-box clunk, then the thud of the revs dropping back in
        this.burst(v, out, false, 'lowpass', 1000, 0.7, t, 0.001, 0.5, 0.03);
        this.tone(v, out, 'sine', 170 * p, 72 * p, 0.05, t, 0.001, 0.6, 0.07);
        this.tone(v, out, 'square', 1900 * p, 1700 * p, 0.02, t, 0.0005, 0.07, 0.016);
        this.tone(v, out, 'triangle', 720 * p, 650 * p, 0.03, t, 0.001, 0.14, 0.035);
        this.tone(v, out, 'sine', 96 * p, 50 * p, 0.1, t + 0.055, 0.004, 0.55, 0.13);
        this.burst(v, out, true, 'lowpass', 420, 0.7, t + 0.055, 0.004, 0.3, 0.1);
        break;
      }
      case 'turboBlowoff': {
        // blow-off valve: fluttering "pshhh" that thins into a "tsss"
        const dur = 0.55;
        const src = this.vNoise(v, false, t, t + dur + 0.05);
        const bp = this.vFilter(v, 'bandpass', 2800, 1.1);
        bp.frequency.setValueAtTime(2600 * p, t);
        bp.frequency.exponentialRampToValueAtTime(Math.min(16000, 6200 * p), t + dur);
        const trem = this.vGain(v, 0.6);
        const lfo = this.vOsc(v, 'sawtooth', 30, t, t + dur + 0.05);
        lfo.frequency.setValueAtTime(34, t);
        lfo.frequency.exponentialRampToValueAtTime(13, t + dur * 0.7);
        const depth = this.vGain(v, 0);
        depth.gain.setValueAtTime(0.4, t);
        depth.gain.linearRampToValueAtTime(0.05, t + dur * 0.8);
        lfo.connect(depth).connect(trem.gain);
        const eg = this.vGain(v, 0);
        eg.gain.setValueAtTime(EPS, t);
        eg.gain.linearRampToValueAtTime(0.9, t + 0.012);
        eg.gain.exponentialRampToValueAtTime(0.25, t + 0.2);
        eg.gain.exponentialRampToValueAtTime(EPS, t + dur);
        src.connect(bp).connect(trem).connect(eg).connect(out);
        this.burst(v, out, false, 'highpass', 7000, 0.7, t + 0.12, 0.08, 0.16, 0.35);
        this.tone(v, out, 'sine', 210, 120, 0.04, t, 0.002, 0.22, 0.05);
        break;
      }
      case 'rankStamp': {
        // heavy stamp + bright bell
        this.tone(v, out, 'sine', 100, 36, 0.14, t, 0.002, 0.95, 0.26);
        this.tone(v, out, 'triangle', 200, 72, 0.08, t, 0.002, 0.3, 0.1);
        this.burst(v, out, true, 'lowpass', 520, 0.7, t, 0.002, 0.6, 0.16);
        this.burst(v, out, false, 'lowpass', 2600, 0.6, t, 0.0005, 0.5, 0.022);
        this.bell(v, out, 1046.5, t + 0.012, 0.3, 1.4);
        this.bell(v, out, 1567.98, t + 0.03, 0.2, 1.2);
        this.tone(v, out, 'sine', 3135.96, 3135.96, 0.01, t + 0.012, 0.002, 0.05, 0.5);
        break;
      }
      case 'checkpoint': {
        // soft confirm chime: E5 -> B5 over a faint fifth
        this.bell(v, out, 659.25, t, 0.26, 0.9);
        this.bell(v, out, 987.77, t + 0.13, 0.3, 1.3);
        this.tone(v, out, 'sine', 329.63, 329.63, 0.01, t, 0.05, 0.12, 0.8);
        this.tone(v, out, 'sine', 493.88, 493.88, 0.01, t + 0.13, 0.05, 0.08, 0.9);
        break;
      }
      case 'wreckSmash': {
        // ploughing through a wreck: body thud, tearing sheet-metal crunches, glass and debris
        const shaper = this.vShaper(v, g.hardCurve);
        const post = this.vGain(v, 0.55);
        shaper.connect(post).connect(out);
        this.tone(v, out, 'sine', 88 * p, 34 * p, 0.2, t, 0.003, 0.9, 0.28);
        this.burst(v, out, true, 'lowpass', 600, 0.6, t, 0.003, 0.6, 0.3);
        for (let i = 0; i < 4; i++) {
          const tc = t + i * rand(0.035, 0.075);
          this.burst(v, shaper, false, 'bandpass', rand(700, 2400), 1.2, tc, 0.002, rand(0.35, 0.6), rand(0.05, 0.11));
        }
        const metal = [183, 291, 468, 757, 1190];
        for (let i = 0; i < metal.length; i++) {
          const f = metal[i] * p * rand(0.93, 1.07);
          this.tone(v, shaper, 'square', f, f * 0.93, 0.25, t + rand(0, 0.03), 0.001, 0.14 / (1 + i * 0.3), 0.3 - i * 0.035);
        }
        // glass shatter + scatter
        this.burst(v, out, false, 'highpass', 5200, 0.7, t + 0.03, 0.002, 0.3, 0.09);
        for (let i = 0; i < 9; i++) {
          const td = t + rand(0.05, 0.75);
          this.burst(v, out, false, 'bandpass', rand(3000, 8500), rand(6, 14), td, 0.001, rand(0.08, 0.2), rand(0.02, 0.06));
          if (i % 3 === 0) {
            const f = rand(3800, 7200);
            this.tone(v, out, 'sine', f, f * 0.99, 0.03, td, 0.001, rand(0.03, 0.06), rand(0.04, 0.1));
          }
        }
        break;
      }
    }
  }

  private explosion(
    v: Voice,
    t: number,
    p: number,
    o: { f0: number; f1: number; boom: number; rumble: number; crack: number; debris: number },
  ): void {
    const out = v.out;
    // low boom with pitch drop, a sub layer under it and a harmonic layer small speakers can reproduce
    this.tone(v, out, 'sine', o.f0 * p, o.f1 * p, o.boom * 0.7, t, 0.004, 0.9, o.boom);
    this.tone(v, out, 'sine', o.f0 * 0.62 * p, o.f1 * 0.7 * p, o.boom, t, 0.012, 0.6, o.boom * 1.3);
    this.tone(v, out, 'triangle', o.f0 * 2 * p, o.f1 * 2 * p, o.boom * 0.5, t, 0.003, 0.22, o.boom * 0.6);
    // pressure wave: brown thump, hard low-passed
    this.burst(v, out, true, 'lowpass', 260, 0.9, t, 0.003, 0.55, o.boom * 0.5);
    // brown rumble, lowpass sweeping down
    const lp = this.burst(v, out, true, 'lowpass', 2200, 0.5, t, 0.008, 0.85, o.rumble);
    sweep(lp.frequency, t, 2200, 70, o.rumble * 0.8);
    // initial crack
    this.burst(v, out, false, 'bandpass', 2400 * p, 0.6, t, 0.001, o.crack, 0.07);
    this.tone(v, out, 'triangle', 260 * p, 60 * p, 0.06, t, 0.001, o.crack * 0.6, 0.08);
    // debris tail: sparse filtered grains
    for (let i = 0; i < o.debris; i++) {
      const td = t + 0.12 + Math.random() * o.rumble * 0.8;
      this.burst(v, out, false, 'bandpass', rand(700, 4300), rand(3, 8), td, 0.003, rand(0.05, 0.15), rand(0.03, 0.1));
    }
  }

  /** Bell-like FM note (inharmonic modulator, index decays faster than the amplitude). */
  private bell(v: Voice, dst: AudioNode, f: number, t: number, peak: number, dur: number): void {
    const car = this.vOsc(v, 'sine', f, t, t + dur + 0.05);
    const mod = this.vOsc(v, 'sine', f * 2.76, t, t + dur + 0.05);
    const index = this.vGain(v, 0);
    index.gain.setValueAtTime(f * 1.3, t);
    index.gain.exponentialRampToValueAtTime(f * 0.03, t + dur * 0.55);
    mod.connect(index).connect(car.frequency);
    const eg = this.vGain(v, 0);
    ad(eg.gain, t, 0.005, peak, dur);
    car.connect(eg).connect(dst);
    this.tone(v, dst, 'sine', f * 2, f * 2, 0.01, t, 0.004, peak * 0.18, dur * 0.4);
  }

  // ---------------------------------------------------------------- voice plumbing

  private voice(dest: AudioNode, volume: number, pan: number, send: number, counted: boolean): Voice {
    const g = this.g;
    if (!g) throw new Error('audio not ready');
    const out = g.ctx.createGain();
    out.gain.value = volume;
    const v: Voice = { out, nodes: [out], pending: 0, done: false, counted };
    let tail: AudioNode = out;
    if (pan !== 0 || send > 0) {
      const panner = g.ctx.createStereoPanner();
      panner.pan.value = pan;
      out.connect(panner);
      v.nodes.push(panner);
      tail = panner;
    }
    tail.connect(dest);
    if (send > 0) {
      const sendGain = g.ctx.createGain();
      sendGain.gain.value = send;
      tail.connect(sendGain).connect(g.reverbIn);
      v.nodes.push(sendGain);
    }
    if (counted) this.activeVoices++;
    return v;
  }

  private finish(v: Voice): void {
    if (v.done) return;
    v.done = true;
    if (v.counted) this.activeVoices = Math.max(0, this.activeVoices - 1);
    for (const node of v.nodes) {
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    v.nodes.length = 0;
  }

  private track(v: Voice, src: AudioScheduledSourceNode): void {
    v.pending++;
    v.nodes.push(src);
    src.onended = () => {
      src.onended = null;
      v.pending--;
      if (v.pending <= 0) this.finish(v);
    };
  }

  private vOsc(v: Voice, type: OscillatorType, freq: number, start: number, stop: number): OscillatorNode {
    const ctx = this.g!.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = clamp(freq, 1, 20000);
    this.track(v, osc);
    osc.start(start);
    osc.stop(stop);
    return osc;
  }

  private vNoise(v: Voice, brown: boolean, start: number, stop: number): AudioBufferSourceNode {
    const g = this.g!;
    const src = g.ctx.createBufferSource();
    src.buffer = brown ? g.brown : g.white;
    src.loop = true;
    this.track(v, src);
    src.start(start, Math.random() * (src.buffer.duration - 0.1));
    src.stop(stop);
    return src;
  }

  private vGain(v: Voice, value: number): GainNode {
    const node = this.g!.ctx.createGain();
    node.gain.value = value;
    v.nodes.push(node);
    return node;
  }

  private vFilter(v: Voice, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
    const node = this.g!.ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = clamp(freq, 10, 20000);
    node.Q.value = q;
    v.nodes.push(node);
    return node;
  }

  private vShaper(v: Voice, curve: Float32Array<ArrayBuffer>): WaveShaperNode {
    const node = this.g!.ctx.createWaveShaper();
    node.curve = curve;
    v.nodes.push(node);
    return node;
  }

  /** Oscillator with a pitch sweep and an attack/decay envelope, connected to `dst`. */
  private tone(
    v: Voice,
    dst: AudioNode,
    type: OscillatorType,
    f0: number,
    f1: number,
    sweepDur: number,
    t: number,
    attack: number,
    peak: number,
    decay: number,
  ): OscillatorNode {
    const osc = this.vOsc(v, type, f0, t, t + attack + decay + 0.03);
    if (f0 !== f1) sweep(osc.frequency, t, f0, f1, sweepDur);
    const eg = this.vGain(v, 0);
    ad(eg.gain, t, attack, peak, decay);
    osc.connect(eg).connect(dst);
    return osc;
  }

  /** Oscillator gated on for `dur` seconds at a flat level (beeps, alarms), connected to `dst`. */
  private gate(v: Voice, dst: AudioNode, type: OscillatorType, f: number, t: number, dur: number, peak: number): void {
    const osc = this.vOsc(v, type, f, t, t + dur + 0.04);
    const eg = this.vGain(v, 0);
    eg.gain.setValueAtTime(EPS, t);
    eg.gain.linearRampToValueAtTime(peak, t + 0.005);
    eg.gain.setValueAtTime(peak, t + Math.max(0.006, dur - 0.015));
    eg.gain.exponentialRampToValueAtTime(EPS, t + dur + 0.01);
    osc.connect(eg).connect(dst);
  }

  /** Filtered noise with an attack/decay envelope, connected to `dst`. Returns the filter. */
  private burst(
    v: Voice,
    dst: AudioNode,
    brown: boolean,
    type: BiquadFilterType,
    freq: number,
    q: number,
    t: number,
    attack: number,
    peak: number,
    decay: number,
  ): BiquadFilterNode {
    const src = this.vNoise(v, brown, t, t + attack + decay + 0.03);
    const filter = this.vFilter(v, type, freq, q);
    const eg = this.vGain(v, 0);
    // brown noise is much quieter per-sample than white: compensate
    ad(eg.gain, t, attack, brown ? peak * 2.2 : peak, decay);
    src.connect(filter).connect(eg).connect(dst);
    return filter;
  }

  // ---------------------------------------------------------------- param smoothing

  /** Smoothed continuous parameter change; skips redundant automation events. */
  private to(param: AudioParam, value: number, tc: number): void {
    const g = this.g;
    if (!g || !Number.isFinite(value)) return;
    const last = this.lastTarget.get(param);
    if (last !== undefined && Math.abs(last - value) <= 1e-4 * Math.max(1, Math.abs(value))) return;
    this.lastTarget.set(param, value);
    param.setTargetAtTime(value, g.ctx.currentTime, tc);
  }

  /** Like `to`, but also drops any automation scheduled in the future (music transitions). */
  private retarget(param: AudioParam, value: number, tc: number): void {
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, tc);
    this.lastTarget.set(param, value);
  }

  private forget(param: AudioParam): void {
    this.lastTarget.delete(param);
  }

  private applyMaster(tc: number): void {
    const g = this.g;
    if (!g) return;
    const target = this.isMuted || this.paused ? 0 : this.masterVolume;
    this.retarget(g.master.gain, target, tc);
  }

  // ---------------------------------------------------------------- housekeeping / ambience events

  private housekeeping(): void {
    try {
      const g = this.g;
      if (!g || this.paused) return;
      const now = performance.now();
      // Nobody is driving any more (title, cinematic, game over): let the car fall silent.
      if (this.engineActive && now - this.lastEngineCall > 450) {
        this.engineActive = false;
        const e = g.engine;
        this.to(e.gain.gain, 0, 0.3);
        this.to(e.roadGain.gain, 0, 0.3);
        this.to(e.whineGain.gain, 0, 0.2);
        this.to(e.jetGain.gain, 0, 0.2);
        this.to(e.rumbleGain.gain, 0, 0.3);
      }
      // setEnemyEngines stopped being called: fade the pool out
      if (this.enemyActive && now - this.lastEnemyCall > 450) {
        this.enemyActive = false;
        for (let i = 0; i < g.enemy.length; i++) {
          this.to(g.enemy[i].gain.gain, 0, 0.25);
          if (this.enemyTrack[i]) this.enemyTrack[i].d = -1;
        }
      }
      if (this.skidActive && now - this.lastSkidCall > 300) {
        this.skidActive = false;
        this.to(g.skid.gain.gain, 0, 0.1);
      }
    } catch {
      /* ignore */
    }
  }

  private queueAmbienceEvent(): void {
    if (this.disposed) return;
    this.ambTimer = setTimeout(
      () => {
        this.ambTimer = null;
        try {
          const g = this.g;
          if (g && !this.paused && g.ctx.state === 'running' && this.ambienceIntensity > 0.05) {
            this.ambienceEvent(g);
          }
        } catch {
          /* ignore */
        }
        this.queueAmbienceEvent();
      },
      rand(4000, 10000),
    );
  }

  /** Sporadic far-off life in the dead city: low level, random pan, long reverb. */
  private ambienceEvent(g: Graph): void {
    const t = g.ctx.currentTime + 0.05;
    const level = 0.45 + 0.55 * this.ambienceIntensity;
    const v = this.voice(g.ambBus, level, rand(-0.85, 0.85), 0.85, false);
    const out = v.out;
    const roll = Math.random();
    if (roll < 0.17) {
      // distant metallic creak: a strained girder somewhere up the tower
      const dur = rand(0.9, 1.9);
      const f = rand(170, 560);
      const bp = this.vFilter(v, 'bandpass', f * 2.3, 7);
      const eg = this.vGain(v, 0);
      eg.gain.setValueAtTime(EPS, t);
      eg.gain.linearRampToValueAtTime(0.13, t + dur * 0.3);
      eg.gain.exponentialRampToValueAtTime(EPS, t + dur);
      bp.connect(eg).connect(out);
      const end = f * rand(0.82, 1.22);
      for (const ratio of [1, 1.31, 2.02]) {
        const osc = this.vOsc(v, 'sawtooth', f * ratio, t, t + dur + 0.05);
        osc.frequency.setValueAtTime(f * ratio, t);
        osc.frequency.linearRampToValueAtTime(f * ratio * 1.04, t + dur * 0.35);
        osc.frequency.linearRampToValueAtTime(end * ratio, t + dur);
        osc.connect(bp);
      }
      bp.frequency.setValueAtTime(f * 2.3, t);
      bp.frequency.linearRampToValueAtTime(end * 2.6, t + dur);
    } else if (roll < 0.32) {
      // far collapse: a long low rumble with falling rubble
      const dur = rand(2.8, 4.4);
      const src = this.vNoise(v, true, t, t + dur + 0.05);
      const lp = this.vFilter(v, 'lowpass', rand(110, 190), 0.7);
      const eg = this.vGain(v, 0);
      eg.gain.setValueAtTime(EPS, t);
      eg.gain.linearRampToValueAtTime(1.0, t + dur * 0.3);
      eg.gain.exponentialRampToValueAtTime(EPS, t + dur);
      src.connect(lp).connect(eg).connect(out);
      const osc = this.vOsc(v, 'sine', rand(36, 48), t, t + dur + 0.05);
      const og = this.vGain(v, 0);
      og.gain.setValueAtTime(EPS, t);
      og.gain.linearRampToValueAtTime(0.2, t + dur * 0.35);
      og.gain.exponentialRampToValueAtTime(EPS, t + dur);
      osc.connect(og).connect(out);
      for (let i = 0; i < 7; i++) {
        const td = t + dur * rand(0.15, 0.75);
        this.burst(v, out, true, 'bandpass', rand(250, 900), 1.5, td, 0.004, rand(0.08, 0.2), rand(0.08, 0.22));
      }
    } else if (roll < 0.55) {
      // far gunfire: a dull burst of pops, somebody else's fight
      const shots = 3 + Math.floor(Math.random() * 7);
      const gap = rand(0.075, 0.15);
      const tone = rand(600, 1100);
      let ts = t;
      for (let i = 0; i < shots; i++) {
        const k = rand(0.6, 1);
        this.burst(v, out, false, 'lowpass', tone, 0.8, ts, 0.001, 0.2 * k, rand(0.04, 0.07));
        this.tone(v, out, 'sine', 130, 62, 0.05, ts, 0.001, 0.16 * k, 0.07);
        ts += gap * rand(0.85, 1.25) + (Math.random() < 0.15 ? rand(0.2, 0.5) : 0);
      }
    } else if (roll < 0.74) {
      // wind gust through steel: a broad swell with a thin aeolian whistle riding on it
      const dur = rand(3, 5.5);
      const peakAt = dur * rand(0.35, 0.55);
      const src = this.vNoise(v, true, t, t + dur + 0.05);
      const bp = this.vFilter(v, 'bandpass', 320, 1.1);
      bp.frequency.setValueAtTime(rand(240, 340), t);
      bp.frequency.linearRampToValueAtTime(rand(620, 900), t + peakAt);
      bp.frequency.linearRampToValueAtTime(rand(260, 380), t + dur);
      const eg = this.vGain(v, 0);
      eg.gain.setValueAtTime(EPS, t);
      eg.gain.linearRampToValueAtTime(2.6, t + peakAt);
      eg.gain.exponentialRampToValueAtTime(EPS, t + dur);
      src.connect(bp).connect(eg).connect(out);
      const wf = rand(650, 1500);
      const wsrc = this.vNoise(v, false, t, t + dur + 0.05);
      const wbp = this.vFilter(v, 'bandpass', wf, 30);
      wbp.frequency.setValueAtTime(wf * 0.9, t);
      wbp.frequency.linearRampToValueAtTime(wf * 1.12, t + peakAt);
      wbp.frequency.linearRampToValueAtTime(wf * 0.86, t + dur);
      const wg = this.vGain(v, 0);
      wg.gain.setValueAtTime(EPS, t);
      wg.gain.linearRampToValueAtTime(0.5, t + peakAt);
      wg.gain.exponentialRampToValueAtTime(EPS, t + dur * 0.9);
      wsrc.connect(wbp).connect(wg).connect(out);
    } else if (roll < 0.86) {
      // a lone carrion bird: 2-3 hoarse calls
      const calls = 2 + Math.floor(Math.random() * 2);
      const base = rand(470, 620);
      for (let i = 0; i < calls; i++) {
        const tc = t + i * rand(0.34, 0.46);
        const dur = rand(0.18, 0.27);
        const f = base * rand(0.96, 1.04);
        const form = this.vFilter(v, 'bandpass', 1500, 2.5);
        const form2 = this.vFilter(v, 'bandpass', 2700, 3);
        const rough = this.vGain(v, 0.6);
        const lfo = this.vOsc(v, 'sawtooth', rand(48, 66), tc, tc + dur + 0.05);
        const depth = this.vGain(v, 0.4);
        lfo.connect(depth).connect(rough.gain);
        const eg = this.vGain(v, 0);
        eg.gain.setValueAtTime(EPS, tc);
        eg.gain.linearRampToValueAtTime(0.4, tc + 0.03);
        eg.gain.setValueAtTime(0.34, tc + dur * 0.6);
        eg.gain.exponentialRampToValueAtTime(EPS, tc + dur);
        const f2g = this.vGain(v, 0.5);
        form.connect(rough);
        form2.connect(f2g).connect(rough);
        rough.connect(eg).connect(out);
        for (const ratio of [1, 1.5]) {
          const osc = this.vOsc(v, ratio === 1 ? 'sawtooth' : 'square', f * ratio, tc, tc + dur + 0.05);
          osc.frequency.setValueAtTime(f * ratio * 0.92, tc);
          osc.frequency.linearRampToValueAtTime(f * ratio * 1.06, tc + dur * 0.25);
          osc.frequency.linearRampToValueAtTime(f * ratio * 0.8, tc + dur);
          osc.connect(form);
          osc.connect(form2);
        }
      }
    } else {
      // loose sheet metal: a bouncing, decelerating clatter
      const hits = 4 + Math.floor(Math.random() * 4);
      const partials = [rand(280, 420), rand(560, 800), rand(1000, 1500), rand(1800, 2600)];
      let th = t;
      let gap = rand(0.16, 0.28);
      for (let i = 0; i < hits; i++) {
        const k = Math.pow(0.78, i) * rand(0.7, 1);
        for (let j = 0; j < partials.length; j++) {
          const f = partials[j] * rand(0.97, 1.03);
          this.tone(v, out, j < 2 ? 'triangle' : 'sine', f, f * 0.96, 0.15, th, 0.001, (0.12 * k) / (1 + j * 0.4), rand(0.1, 0.22));
        }
        this.burst(v, out, false, 'bandpass', rand(1800, 3200), 1.5, th, 0.001, 0.14 * k, 0.03);
        th += gap;
        gap *= rand(0.62, 0.85);
      }
    }
  }

  // ---------------------------------------------------------------- graph construction

  private build(ctx: AudioContext): Graph {
    const loops: AudioScheduledSourceNode[] = [];
    const gain = (value: number): GainNode => {
      const node = ctx.createGain();
      node.gain.value = value;
      return node;
    };
    const filter = (type: BiquadFilterType, freq: number, q: number): BiquadFilterNode => {
      const node = ctx.createBiquadFilter();
      node.type = type;
      node.frequency.value = freq;
      node.Q.value = q;
      return node;
    };
    const osc = (type: OscillatorType, freq: number, detune = 0): OscillatorNode => {
      const node = ctx.createOscillator();
      node.type = type;
      node.frequency.value = freq;
      node.detune.value = detune;
      node.start();
      loops.push(node);
      return node;
    };

    const white = makeNoise(ctx, 2.0, false);
    const brown = makeNoise(ctx, 4.0, true);
    const loopNoise = (buffer: AudioBuffer): AudioBufferSourceNode => {
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.loop = true;
      node.start(0, Math.random() * (buffer.duration - 0.1));
      loops.push(node);
      return node;
    };
    const softCurve = tanhCurve(1.6);
    const hardCurve = tanhCurve(4);

    // --- output chain: master volume -> glue compressor -> makeup -> fast limiter -> soft clip (hard ceiling 0.95)
    const master = gain(0);
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -20;
    glue.knee.value = 14;
    glue.ratio.value = 2.5;
    glue.attack.value = 0.012;
    glue.release.value = 0.16;
    const makeup = gain(GLUE_MAKEUP);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    const clipIn = gain(1 / CLIP_RANGE);
    const clip = ctx.createWaveShaper();
    clip.curve = limiterCurve();
    const output = gain(1);
    master.connect(glue).connect(makeup).connect(limiter).connect(clipIn).connect(clip).connect(output).connect(ctx.destination);

    const sfxBus = gain(BUS_SFX);
    const engineBus = gain(BUS_ENGINE);
    const enemyBus = gain(BUS_ENEMY);
    const ambBus = gain(BUS_AMBIENCE);
    const musicBus = gain(BUS_MUSIC);
    // music + ambience share a ducking stage that explosions / radio / stingers pull down
    const duck = gain(1);
    sfxBus.connect(master);
    engineBus.connect(master);
    enemyBus.connect(master);
    ambBus.connect(duck);
    musicBus.connect(duck);
    duck.connect(master);

    // --- shared reverb
    const reverbIn = gain(1);
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(ctx);
    const reverbTone = filter('lowpass', 3800, 0.5);
    const reverbOut = gain(REVERB_RETURN);
    reverbIn.connect(convolver).connect(reverbTone).connect(reverbOut).connect(master);
    const musicSend = gain(MUSIC_REVERB_SEND);
    musicBus.connect(musicSend).connect(reverbIn);

    // --- engine: detuned saws/square + sub -> drive -> shaper -> body EQ -> lowpass -> lope AM
    const oscA = osc('sawtooth', 38, 0);
    const oscB = osc('sawtooth', 38, 14);
    const oscC = osc('square', 38, -9);
    const sub = osc('sine', 19, 0);
    const drive = gain(0.55);
    const gA = gain(0.5);
    const gB = gain(0.45);
    const gC = gain(0.22);
    const gSub = gain(0.7);
    oscA.connect(gA).connect(drive);
    oscB.connect(gB).connect(drive);
    oscC.connect(gC).connect(drive);
    sub.connect(gSub).connect(drive);
    const engineShaper = ctx.createWaveShaper();
    engineShaper.curve = tanhCurve(2.4);
    engineShaper.oversample = '2x';
    const body = filter('peaking', 95, 1.1);
    body.gain.value = 5;
    const lowMid = filter('peaking', 210, 0.9);
    lowMid.gain.value = 3;
    const harsh = filter('peaking', 2900, 0.8); // tame the fatiguing 2-4 kHz band
    harsh.gain.value = -9;
    const engineLp = filter('lowpass', 300, 1.0);
    const lope = gain(1);
    const lopeLfo = osc('sine', 5.5, 0);
    const lopeDepth = gain(0);
    lopeLfo.connect(lopeDepth).connect(lope.gain);
    const engineGain = gain(0);
    drive.connect(engineShaper).connect(body).connect(lowMid).connect(harsh).connect(engineLp).connect(lope).connect(engineGain).connect(engineBus);

    const roadFilter = filter('bandpass', 300, 0.6);
    const roadGain = gain(0);
    loopNoise(white).connect(roadFilter).connect(roadGain).connect(engineBus);
    // low road / tyre rumble
    const rumbleFilter = filter('lowpass', 80, 0.9);
    const rumbleGain = gain(0);
    loopNoise(brown).connect(rumbleFilter).connect(rumbleGain).connect(engineBus);

    const whine = osc('triangle', 900, 0);
    const whine2 = osc('sine', 900, 702); // second rotor partial a fifth above
    const whine2Gain = gain(0.45);
    const whineGain = gain(0);
    whine.connect(whineGain);
    whine2.connect(whine2Gain).connect(whineGain);
    whineGain.connect(engineBus);
    const jetFilter = filter('bandpass', 1500, 0.7);
    const jetGain = gain(0);
    loopNoise(white).connect(jetFilter).connect(jetGain).connect(engineBus);

    // --- enemy engines: 4 persistent voices, retuned between buggy buzz and rig diesel
    const enemy: EnemyVoice[] = [];
    const rattleSrc = loopNoise(white);
    for (let i = 0; i < ENEMY_VOICES; i++) {
      const o1 = osc('sawtooth', 70 + i * 7, 0);
      const o2 = osc('square', 141 + i * 9, 6);
      const o2g = gain(0.45);
      const pre = gain(1.3);
      const shaper = ctx.createWaveShaper();
      shaper.curve = hardCurve;
      const am = gain(0.6);
      const lfo = osc('sine', 35 + i * 3, 0);
      const lfoDepth = gain(0.4);
      lfo.connect(lfoDepth).connect(am.gain);
      const rattleBp = filter('bandpass', 2100 + i * 160, 1.4);
      const rattleGain = gain(0);
      const hp = filter('highpass', 150, 0.7);
      const lp = filter('lowpass', 600, 0.8);
      const vg = gain(0);
      const pan = ctx.createStereoPanner();
      o1.connect(pre);
      o2.connect(o2g).connect(pre);
      pre.connect(shaper).connect(am);
      rattleSrc.connect(rattleBp).connect(rattleGain).connect(am);
      am.connect(hp).connect(lp).connect(vg).connect(pan).connect(enemyBus);
      enemy.push({ o1, o2, lfo, lfoDepth, rattleGain, hp, lp, gain: vg, pan });
    }

    // --- tyre scrub
    const skidFilter = filter('bandpass', 1300, 3.2);
    const skidGain = gain(0);
    const skidLfo = osc('sine', 7.3, 0);
    const skidWobble = gain(230);
    skidLfo.connect(skidWobble).connect(skidFilter.frequency);
    const skidHigh = filter('bandpass', 2700, 5);
    const skidHighGain = gain(0.35);
    const skidSrc = loopNoise(white);
    skidSrc.connect(skidFilter).connect(skidGain);
    skidSrc.connect(skidHigh).connect(skidHighGain).connect(skidGain);
    skidGain.connect(sfxBus);

    // --- ambience: wind bed, gusts, dust hiss
    const ambGain = gain(0);
    ambGain.connect(ambBus);
    const windLp = filter('lowpass', 420, 0.6);
    const windLfo = osc('sine', 0.07, 0);
    const windLfoDepth = gain(190);
    windLfo.connect(windLfoDepth).connect(windLp.frequency);
    const windGain = gain(0.75);
    loopNoise(brown).connect(windLp).connect(windGain).connect(ambGain);

    const gustBp = filter('bandpass', 620, 1.3);
    const gustFreqLfo = osc('sine', 0.043, 0);
    const gustFreqDepth = gain(240);
    gustFreqLfo.connect(gustFreqDepth).connect(gustBp.frequency);
    const gustGain = gain(0.4);
    const gustLfo = osc('sine', 0.11, 0);
    const gustDepth = gain(0.3);
    gustLfo.connect(gustDepth).connect(gustGain.gain);
    loopNoise(brown).connect(gustBp).connect(gustGain).connect(ambGain);

    const hissHp = filter('highpass', 6200, 0.7);
    const hissGain = gain(0.014);
    const hissLfo = osc('sine', 0.17, 0);
    const hissDepth = gain(0.008);
    hissLfo.connect(hissDepth).connect(hissGain.gain);
    loopNoise(white).connect(hissHp).connect(hissGain).connect(ambGain);

    // --- music: evolving drone pad (4 voices x 2 detuned saws) + buses for scheduled notes
    const padFilter = filter('lowpass', 300, 0.8);
    const padLfo = osc('sine', 0.05, 0);
    const padLfoDepth = gain(90);
    padLfo.connect(padLfoDepth).connect(padFilter.frequency);
    const padGain = gain(0);
    padFilter.connect(padGain).connect(musicBus);
    const padOscs: OscillatorNode[][] = [];
    const padVoiceGains: GainNode[] = [];
    const base = PAD.silent;
    for (let i = 0; i < 4; i++) {
      const vg = gain(base.g[i] * 0.13);
      const a = osc('sawtooth', base.f[i], -7 - i);
      const b = osc('sawtooth', base.f[i], 7 + i * 1.5);
      a.connect(vg);
      b.connect(vg);
      vg.connect(padFilter);
      padOscs.push([a, b]);
      padVoiceGains.push(vg);
    }
    // rhythm section -> threat-controlled lowpass -> threat boost -> music bus
    const rhythmGain = gain(0);
    const rhythmLp = filter('lowpass', 4800, 0.5);
    const rhythmBoost = gain(1);
    rhythmGain.connect(rhythmLp).connect(rhythmBoost).connect(musicBus);
    const bassBus = gain(1.5);
    const bassShaper = ctx.createWaveShaper();
    bassShaper.curve = tanhCurve(3);
    const bassPost = gain(0.42);
    bassBus.connect(bassShaper).connect(bassPost).connect(rhythmGain);
    const leadBus = gain(1);
    leadBus.connect(rhythmGain);
    const leadSend = gain(0.5);
    leadBus.connect(leadSend).connect(reverbIn);
    const pluckBus = gain(0);
    pluckBus.connect(musicBus);
    const pluckSend = gain(0.9);
    pluckBus.connect(pluckSend).connect(reverbIn);

    // tension pad (explore + threat): a tremolo semitone cluster over a low throb
    const tensionGain = gain(0);
    const tensionLp = filter('lowpass', 1100, 0.7);
    const tensionTrem = gain(0.6);
    const tensionLfo = osc('sine', 5.2, 0);
    const tensionDepth = gain(0.3);
    tensionLfo.connect(tensionDepth).connect(tensionTrem.gain);
    const tA = osc('sawtooth', 440.0, -6);
    const tB = osc('sawtooth', 466.16, 5);
    const tC = osc('sawtooth', 220.0, 4);
    const tMix = gain(0.028);
    tA.connect(tMix);
    tB.connect(tMix);
    tC.connect(tMix);
    tMix.connect(tensionLp).connect(tensionTrem).connect(tensionGain);
    const tSub = osc('sine', 55.0, 0);
    const tSubGain = gain(0.11);
    const tSubLfo = osc('sine', 0.9, 0);
    const tSubDepth = gain(0.07);
    tSubLfo.connect(tSubDepth).connect(tSubGain.gain);
    tSub.connect(tSubGain).connect(tensionGain);
    tensionGain.connect(musicBus);

    return {
      ctx,
      master,
      output,
      sfxBus,
      engineBus,
      ambBus,
      musicBus,
      reverbIn,
      white,
      brown,
      softCurve,
      hardCurve,
      loops,
      engine: {
        oscA,
        oscB,
        oscC,
        sub,
        drive,
        lowpass: engineLp,
        lopeLfo,
        lopeDepth,
        gain: engineGain,
        roadFilter,
        roadGain,
        whine,
        whine2,
        whineGain,
        jetFilter,
        jetGain,
        rumbleFilter,
        rumbleGain,
      },
      enemy,
      skid: { filter: skidFilter, gain: skidGain },
      amb: { gain: ambGain },
      duck,
      music: {
        padOscs,
        padVoiceGains,
        padFilter,
        padLfoDepth,
        padGain,
        rhythmGain,
        bassBus,
        pluckBus,
        leadBus,
        rhythmLp,
        rhythmBoost,
        tensionGain,
      },
    };
  }
}
