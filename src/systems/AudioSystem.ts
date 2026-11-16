import type { GameAudio, MusicState, SfxName, SfxOptions } from '../game/contracts';

/**
 * ASHEN SKYLINE runtime audio. Everything is synthesised with the Web Audio API:
 * no audio files, no network. The AudioContext is created lazily in `unlock()`
 * (which must be called from a user gesture); every public method is a safe
 * no-op before that and never throws.
 *
 * Signal flow:
 *   sfx / engine / ambience / music buses ─┬─► master ─► compressor ─► soft clip ─► trim ─► destination
 *   sfx voices, ambience events, music ────┴─► reverb send ─► convolver ─► master
 */

// ------------------------------------------------------------------ constants

const EPS = 0.0001;
const DEFAULT_MASTER = 0.8;

const BUS_SFX = 0.62;
const BUS_ENGINE = 0.085;
const BUS_AMBIENCE = 0.2;
const BUS_MUSIC = 0.34;
const REVERB_RETURN = 0.55;
const MUSIC_REVERB_SEND = 0.28;
const OUTPUT_TRIM = 0.8;

const MAX_VOICES = 24;
const MAX_VOICES_PRIORITY = 32;
const MIN_REPEAT_SEC = 0.025;

const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULER_LOOKAHEAD = 0.12;
const MUSIC_FADE_SEC = 1.5;

// D minor material
const D2 = 73.42;
const PENTATONIC = [293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46];
const VICTORY_ARP = [293.66, 369.99, 440.0, 587.33, 739.99, 880.0, 1174.66];

type PadConfig = { f: [number, number, number, number]; g: [number, number, number, number]; cut: number; level: number };

const PAD: Record<MusicState, PadConfig> = {
  silent: { f: [73.42, 110.0, 146.83, 174.61], g: [1, 0.8, 0.45, 0.6], cut: 300, level: 0 },
  title: { f: [73.42, 110.0, 146.83, 174.61], g: [1, 0.8, 0.45, 0.6], cut: 520, level: 0.9 },
  explore: { f: [73.42, 110.0, 146.83, 174.61], g: [1, 0.8, 0.4, 0.55], cut: 430, level: 0.75 },
  // Bb/F lift: Bb1, F2, D3, A3
  event: { f: [58.27, 87.31, 146.83, 220.0], g: [1, 0.8, 0.7, 0.5], cut: 1100, level: 0.9 },
  battle: { f: [73.42, 110.0, 146.83, 174.61], g: [1, 0.7, 0.4, 0.4], cut: 380, level: 0.42 },
  // D, Ab (tritone), D, Eb
  boss: { f: [73.42, 103.83, 146.83, 155.56], g: [1, 0.6, 0.4, 0.45], cut: 420, level: 0.48 },
  // D major: D2, A2, F#3, A3
  victory: { f: [73.42, 110.0, 185.0, 220.0], g: [1, 0.8, 0.7, 0.6], cut: 1600, level: 1.0 },
  // sinks to G1 / C#2 / G2 / C#3
  fail: { f: [49.0, 69.3, 98.0, 138.59], g: [1, 0.7, 0.5, 0.3], cut: 230, level: 0.85 },
};

type RhythmState = 'event' | 'battle' | 'boss';
const RHYTHM_BPM: Record<RhythmState, number> = { event: 72, battle: 132, boss: 140 };

const BATTLE_BASS = [0, 0, 12, 0, 0, 12, 0, 0, 10, 0, 12, 0, 0, 3, 5, 7];
const BATTLE_ACCENT = [1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1];
const BATTLE_ROOT = [0, 0, 0, -2];
const BOSS_BASS = [0, 0, 0, 12, 0, 0, 1, 0, 0, 0, 12, 0, 1, 0, 13, 12];
const BOSS_ACCENT = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
const BOSS_ROOT = [0, 0, 1, 0];
const BOSS_TOMS = [110, 92, 78, 65];

type SfxMix = { vol: number; send: number; vary: boolean; priority: boolean };

const SFX: Record<SfxName, SfxMix> = {
  playerShot: { vol: 1.1, send: 0.25, vary: true, priority: false },
  enemyShot: { vol: 0.7, send: 0.4, vary: true, priority: false },
  hitMetal: { vol: 0.7, send: 0.15, vary: true, priority: false },
  hitPlayer: { vol: 0.6, send: 0.15, vary: true, priority: true },
  explosionSmall: { vol: 0.58, send: 0.3, vary: true, priority: true },
  explosionBig: { vol: 0.8, send: 0.5, vary: true, priority: true },
  mortarLaunch: { vol: 0.75, send: 0.35, vary: true, priority: true },
  mortarImpact: { vol: 0.7, send: 0.4, vary: true, priority: true },
  crash: { vol: 0.6, send: 0.3, vary: true, priority: true },
  boostStart: { vol: 0.8, send: 0.2, vary: true, priority: true },
  uiClick: { vol: 0.6, send: 0.04, vary: false, priority: true },
  uiConfirm: { vol: 0.75, send: 0.2, vary: false, priority: true },
  radioOpen: { vol: 0.5, send: 0.0, vary: false, priority: true },
  radioClose: { vol: 0.5, send: 0.0, vary: false, priority: true },
  objective: { vol: 0.6, send: 0.5, vary: false, priority: true },
  relayPowerUp: { vol: 0.65, send: 0.5, vary: false, priority: true },
  alarm: { vol: 0.8, send: 0.2, vary: false, priority: true },
  repair: { vol: 0.8, send: 0.15, vary: false, priority: true },
  overheat: { vol: 0.6, send: 0.1, vary: true, priority: true },
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
  p.setValueAtTime(Math.max(1, from), t);
  p.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
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

/** Transparent below |x| = 0.6, then a soft knee that tops out below 0.9. Hard safety net. */
function limiterCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= 0.6 ? a : 0.6 + 0.37 * Math.tanh((a - 0.6) / 0.37);
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
  };
  skid: { filter: BiquadFilterNode; gain: GainNode };
  amb: { gain: GainNode };
  music: {
    padOscs: OscillatorNode[][];
    padVoiceGains: GainNode[];
    padFilter: BiquadFilterNode;
    padLfoDepth: GainNode;
    padGain: GainNode;
    rhythmGain: GainNode;
    bassBus: GainNode;
    pluckBus: GainNode;
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
      this.to(e.lowpass.frequency, 300 + Math.pow(thr, 1.2) * 2000 + rpm * 300, 0.09);
      // lumpy cam at idle, smoothing out as revs rise
      const idle = Math.max(0, 1 - rpm * 2.6);
      this.to(e.lopeLfo.frequency, 5.5 + rpm * 9, 0.1);
      this.to(e.lopeDepth.gain, 0.32 * idle * (1 - thr * 0.5), 0.1);
      this.to(e.gain.gain, 0.38 + thr * 0.34 + rpm * 0.12, 0.08);

      this.to(e.roadFilter.frequency, 260 + spd * 900 + thr * 250, 0.1);
      this.to(e.roadGain.gain, 0.04 + Math.pow(spd, 1.4) * 0.5 + thr * 0.1, 0.1);

      this.to(e.whine.frequency, 900 + rpm * 1500, 0.07);
      this.to(e.whine2.frequency, 900 + rpm * 1500, 0.07);
      this.to(e.whineGain.gain, boosting ? 0.12 + rpm * 0.07 : 0, boosting ? 0.07 : 0.14);
      this.to(e.jetFilter.frequency, 1300 + rpm * 1500, 0.1);
      this.to(e.jetGain.gain, boosting ? 0.5 : 0, boosting ? 0.06 : 0.16);
    } catch {
      /* ignore */
    }
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
        for (const osc of m.padOscs[i]) this.retarget(osc.frequency, cfg.f[i], glide);
        this.retarget(m.padVoiceGains[i].gain, cfg.g[i] * 0.13, tc);
      }
      this.retarget(m.padFilter.frequency, cfg.cut, state === 'fail' ? 1.2 : tc);
      this.retarget(m.padLfoDepth.gain, cfg.cut * 0.32, tc);
      this.retarget(m.padGain.gain, cfg.level, tc);

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

      // sparse bell notes
      this.retarget(m.pluckBus.gain, state === 'silent' || state === 'fail' ? 0 : 1, tc);
      if (state === 'title' || state === 'explore') this.nextPluckTime = now + rand(1.5, 3.5);
      else if (state === 'event') this.nextPluckTime = now + rand(0.8, 1.6);
      else this.nextPluckTime = Number.POSITIVE_INFINITY;

      if (state === 'victory') {
        // swell, slow rising arpeggio, then settle back into a quiet major pad
        for (let i = 0; i < VICTORY_ARP.length; i++) {
          const v = this.voice(m.pluckBus, 1, 0, 0, false);
          this.bell(v, v.out, VICTORY_ARP[i], now + 0.5 + i * 0.42, 0.2, 3.2);
        }
        this.forget(m.padGain.gain);
        m.padGain.gain.setTargetAtTime(0.5, now + 5.5, 1.5);
        this.forget(m.padFilter.frequency);
        m.padFilter.frequency.setTargetAtTime(650, now + 5.5, 2.0);
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
        eg.gain.linearRampToValueAtTime(0.4, now + 0.5);
        eg.gain.setValueAtTime(0.4, now + 2.2);
        eg.gain.exponentialRampToValueAtTime(EPS, now + 5.1);
        osc.connect(lp);
        tri.connect(tg).connect(lp);
        lp.connect(eg).connect(v.out);
        this.forget(m.padGain.gain);
        m.padGain.gain.setTargetAtTime(0.04, now + 4.0, 1.2);
      }
    } catch {
      /* ignore */
    }
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

      if (this.nextPluckTime < horizon) {
        const st = this.musicState;
        const t = Math.max(this.nextPluckTime, now + 0.02);
        if (st === 'title' || st === 'explore' || st === 'event') {
          // wander through the pentatonic scale in small steps
          let idx = this.lastPluckIndex + Math.round(rand(-2.4, 2.4));
          if (idx === this.lastPluckIndex) idx += Math.random() < 0.5 ? -1 : 1;
          idx = Math.max(0, Math.min(PENTATONIC.length - 1, idx));
          this.lastPluckIndex = idx;
          const v = this.voice(g.music.pluckBus, 1, 0, 0, false);
          this.bell(v, v.out, PENTATONIC[idx], t, rand(0.1, 0.16), rand(2.4, 3.6));
          if (Math.random() < 0.3) {
            const j = Math.max(0, idx - 2);
            this.bell(v, v.out, PENTATONIC[j] * 0.5, t + rand(0.25, 0.6), 0.08, 3.0);
          }
          this.nextPluckTime = t + (st === 'event' ? rand(2.2, 4.5) : rand(4, 9));
        } else {
          this.nextPluckTime = Number.POSITIVE_INFINITY;
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

    // --- boss toms (fill at the end of every second bar)
    if (boss && bar % 2 === 1 && step >= 12) {
      used = true;
      const f = BOSS_TOMS[step - 12];
      this.tone(drums, drums.out, 'sine', f * 1.5, f, 0.08, t, 0.002, 0.6, 0.24);
    }
    if (!used) this.finish(drums);

    // --- gritty bass ostinato on D
    const pattern = boss ? BOSS_BASS : BATTLE_BASS;
    const accents = boss ? BOSS_ACCENT : BATTLE_ACCENT;
    const roots = boss ? BOSS_ROOT : BATTLE_ROOT;
    const semis = pattern[step] + (step >= 8 || boss ? roots[bar % 4] : 0);
    const f = D2 * Math.pow(2, semis / 12);
    const accent = accents[step] === 1;
    const bv = this.voice(m.bassBus, 1, 0, 0, false);
    const len = stepDur * 0.82;
    const lp = this.vFilter(bv, 'lowpass', 500, 4);
    const top = accent ? 2100 : 950;
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

    // --- tension stabs
    const stab = boss
      ? (step === 0 && bar % 2 === 0) || (step === 6 && bar % 4 === 3)
      : (step === 0 && bar % 2 === 0) || (step === 10 && bar % 4 === 3);
    if (stab) {
      const sv = this.voice(m.rhythmGain, 1, 0, 0, false);
      const notes = boss ? [293.66, 311.13, 440.0, 622.25] : [293.66, 349.23, 440.0];
      const slp = this.vFilter(sv, 'lowpass', 2600, 1.2);
      slp.frequency.setValueAtTime(2600, t);
      slp.frequency.exponentialRampToValueAtTime(500, t + 0.35);
      slp.connect(sv.out);
      for (const nf of notes) {
        this.tone(sv, slp, 'sawtooth', nf, nf, 0.01, t, 0.006, 0.075, boss ? 0.42 : 0.3);
        this.tone(sv, slp, 'sawtooth', nf * 1.007, nf * 1.007, 0.01, t, 0.006, 0.06, boss ? 0.42 : 0.3);
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
      const pitch = clamp(options?.pitch ?? 1, 0.25, 4) * (mix.vary ? 1 + rand(-0.04, 0.04) : 1);

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

  private buildSfx(g: Graph, name: SfxName, v: Voice, t: number, p: number): void {
    const out = v.out;
    switch (name) {
      case 'playerShot': {
        // autocannon: chest thump + barrel bark + crack + short low body
        this.tone(v, out, 'sine', 180 * p, 60 * p, 0.09, t, 0.002, 0.8, 0.1);
        this.burst(v, out, false, 'bandpass', 1350 * p, 0.8, t, 0.001, 0.55, 0.065);
        this.burst(v, out, false, 'highpass', 4600, 0.7, t, 0.0005, 0.24, 0.022);
        this.burst(v, out, true, 'lowpass', 520 * p, 0.6, t, 0.004, 0.5, 0.15);
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
        const partials = [1230, 1870, 2640, 3510];
        for (let i = 0; i < partials.length; i++) {
          const f = partials[i] * p * rand(0.96, 1.04);
          this.tone(v, out, 'sine', f, f * 0.985, 0.08, t, 0.001, 0.26 / (1 + i * 0.6), 0.08 - i * 0.012);
        }
        this.burst(v, out, false, 'highpass', 3200, 0.7, t, 0.0005, 0.3, 0.012);
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
    }
  }

  private explosion(
    v: Voice,
    t: number,
    p: number,
    o: { f0: number; f1: number; boom: number; rumble: number; crack: number; debris: number },
  ): void {
    const out = v.out;
    // low boom with pitch drop
    this.tone(v, out, 'sine', o.f0 * p, o.f1 * p, o.boom * 0.7, t, 0.004, 0.9, o.boom);
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
      rand(5000, 14000),
    );
  }

  private ambienceEvent(g: Graph): void {
    const t = g.ctx.currentTime + 0.05;
    const level = 0.4 + 0.6 * this.ambienceIntensity;
    const v = this.voice(g.ambBus, level, rand(-0.8, 0.8), 0.7, false);
    if (Math.random() < 0.6) {
      // distant metallic creak: a strained girder somewhere up the tower
      const dur = rand(0.9, 1.9);
      const f = rand(170, 560);
      const bp = this.vFilter(v, 'bandpass', f * 2.3, 7);
      const eg = this.vGain(v, 0);
      eg.gain.setValueAtTime(EPS, t);
      eg.gain.linearRampToValueAtTime(0.11, t + dur * 0.3);
      eg.gain.exponentialRampToValueAtTime(EPS, t + dur);
      bp.connect(eg).connect(v.out);
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
    } else {
      // far-off low rumble: something large settling
      const dur = rand(2.6, 4.2);
      const src = this.vNoise(v, true, t, t + dur + 0.05);
      const lp = this.vFilter(v, 'lowpass', rand(90, 150), 0.7);
      const eg = this.vGain(v, 0);
      eg.gain.setValueAtTime(EPS, t);
      eg.gain.linearRampToValueAtTime(0.9, t + dur * 0.35);
      eg.gain.exponentialRampToValueAtTime(EPS, t + dur);
      src.connect(lp).connect(eg).connect(v.out);
      const osc = this.vOsc(v, 'sine', rand(34, 44), t, t + dur + 0.05);
      const og = this.vGain(v, 0);
      og.gain.setValueAtTime(EPS, t);
      og.gain.linearRampToValueAtTime(0.16, t + dur * 0.4);
      og.gain.exponentialRampToValueAtTime(EPS, t + dur);
      osc.connect(og).connect(v.out);
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

    // --- output chain
    const master = gain(0);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 10;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;
    const clip = ctx.createWaveShaper();
    clip.curve = limiterCurve();
    const output = gain(OUTPUT_TRIM);
    master.connect(comp).connect(clip).connect(output).connect(ctx.destination);

    const sfxBus = gain(BUS_SFX);
    const engineBus = gain(BUS_ENGINE);
    const ambBus = gain(BUS_AMBIENCE);
    const musicBus = gain(BUS_MUSIC);
    sfxBus.connect(master);
    engineBus.connect(master);
    ambBus.connect(master);
    musicBus.connect(master);

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
    const engineLp = filter('lowpass', 300, 1.1);
    const lope = gain(1);
    const lopeLfo = osc('sine', 5.5, 0);
    const lopeDepth = gain(0);
    lopeLfo.connect(lopeDepth).connect(lope.gain);
    const engineGain = gain(0);
    drive.connect(engineShaper).connect(body).connect(engineLp).connect(lope).connect(engineGain).connect(engineBus);

    const roadFilter = filter('bandpass', 300, 0.6);
    const roadGain = gain(0);
    loopNoise(white).connect(roadFilter).connect(roadGain).connect(engineBus);

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
    const rhythmGain = gain(0);
    rhythmGain.connect(musicBus);
    const bassBus = gain(1.5);
    const bassShaper = ctx.createWaveShaper();
    bassShaper.curve = tanhCurve(3);
    const bassPost = gain(0.42);
    bassBus.connect(bassShaper).connect(bassPost).connect(rhythmGain);
    const pluckBus = gain(0);
    pluckBus.connect(musicBus);
    const pluckSend = gain(0.9);
    pluckBus.connect(pluckSend).connect(reverbIn);

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
      },
      skid: { filter: skidFilter, gain: skidGain },
      amb: { gain: ambGain },
      music: { padOscs, padVoiceGains, padFilter, padLfoDepth, padGain, rhythmGain, bassBus, pluckBus },
    };
  }
}
