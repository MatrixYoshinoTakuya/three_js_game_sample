import type { TouchIntents } from '../game/contracts';

export type DriveIntents = {
  /** -1 = left, +1 = right. */
  steer: number;
  /** -1 = brake/reverse, +1 = accelerate. */
  throttle: number;
  fire: boolean;
  boost: boolean;
  handbrake: boolean;
  /** Secondary weapon: true for exactly one update per press (E / Q / right mouse / touch). */
  missile: boolean;
};

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Keyboard + mouse intents, merged with the HUD's touch controls. Edge-triggered keys are consumed once. */
export class InputController {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  private mouseFire = false;
  private mouseMissile = false;
  private touchMissile = false;
  private steerSmoothed = 0;
  readonly intents: DriveIntents = { steer: 0, throttle: 0, fire: false, boost: false, handbrake: false, missile: false };

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('contextmenu', this.onContext);
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (PREVENT.has(event.code)) event.preventDefault();
    if (!event.repeat) this.pressed.add(event.code);
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = () => {
    this.keys.clear();
    this.mouseFire = false;
    this.mouseMissile = false;
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button === 0) this.mouseFire = true;
    if (event.button === 2) this.mouseMissile = true;
  };

  private readonly onMouseUp = (event: MouseEvent) => {
    if (event.button === 0) this.mouseFire = false;
  };

  private readonly onContext = (event: Event) => event.preventDefault();

  private down(...codes: string[]): boolean {
    for (const code of codes) if (this.keys.has(code)) return true;
    return false;
  }

  /** True once per physical key press. */
  consume(...codes: string[]): boolean {
    let hit = false;
    for (const code of codes) {
      if (this.pressed.delete(code)) hit = true;
    }
    return hit;
  }

  endFrame(): void {
    this.pressed.clear();
  }

  update(dt: number, touch: TouchIntents): DriveIntents {
    const out = this.intents;
    let steer = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
    let throttle = (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0);
    // keyboard steering eases in so taps make small corrections
    const rate = steer === 0 ? 9 : 5.5;
    this.steerSmoothed += (steer - this.steerSmoothed) * Math.min(1, dt * rate);
    steer = this.steerSmoothed;
    out.fire = this.down('Space', 'KeyJ', 'KeyF') || this.mouseFire;
    out.boost = this.down('ShiftLeft', 'ShiftRight', 'KeyK');
    out.handbrake = this.down('KeyX', 'KeyL', 'ControlLeft');
    // edge-triggered: one launch per press, whichever device asked
    const touchMissile = touch.active && touch.missile === true;
    out.missile = this.consume('KeyE', 'KeyQ') || this.mouseMissile || (touchMissile && !this.touchMissile);
    this.mouseMissile = false;
    this.touchMissile = touchMissile;
    if (touch.active) {
      if (Math.abs(touch.steer) > Math.abs(steer)) steer = touch.steer;
      if (Math.abs(touch.throttle) > Math.abs(throttle)) throttle = touch.throttle;
      out.fire = out.fire || touch.fire;
      out.boost = out.boost || touch.boost;
      out.handbrake = out.handbrake || touch.handbrake;
    }
    out.steer = Math.max(-1, Math.min(1, steer));
    out.throttle = Math.max(-1, Math.min(1, throttle));
    return out;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('contextmenu', this.onContext);
  }
}
