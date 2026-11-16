import type { TouchIntents } from '../game/contracts';

type HoldKey = 'fire' | 'boost' | 'handbrake';

const DEADZONE = 0.14;

function shape(v: number): number {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  const n = Math.min(1, (a - DEADZONE) / (1 - DEADZONE));
  return v < 0 ? -n : n;
}

/**
 * Virtual stick + hold buttons. Each control tracks its own pointerId with
 * pointer capture so steering, firing and boosting work simultaneously.
 */
export class TouchControls {
  private stickPointer = -1;
  private originX = 0;
  private originY = 0;
  private radius = 44;
  private readonly holdPointers = new Map<HTMLElement, number>();

  constructor(
    private readonly stick: HTMLElement,
    private readonly knob: HTMLElement,
    buttons: HTMLElement[],
    private readonly intents: TouchIntents,
    signal: AbortSignal,
  ) {
    const opts: AddEventListenerOptions = { signal, passive: false };

    stick.addEventListener('pointerdown', this.onStickDown, opts);
    stick.addEventListener('pointermove', this.onStickMove, opts);
    stick.addEventListener('pointerup', this.onStickEnd, opts);
    stick.addEventListener('pointercancel', this.onStickEnd, opts);
    stick.addEventListener('lostpointercapture', this.onStickEnd, opts);

    for (const button of buttons) {
      this.holdPointers.set(button, -1);
      button.addEventListener('pointerdown', this.onHoldDown, opts);
      button.addEventListener('pointerup', this.onHoldEnd, opts);
      button.addEventListener('pointercancel', this.onHoldEnd, opts);
      button.addEventListener('lostpointercapture', this.onHoldEnd, opts);
    }
  }

  /** Drop every held control (mode change, blur, tab hidden). */
  releaseAll(): void {
    this.stickPointer = -1;
    this.intents.steer = 0;
    this.intents.throttle = 0;
    this.knob.style.transform = '';
    this.stick.classList.remove('is-down');
    for (const button of this.holdPointers.keys()) {
      this.holdPointers.set(button, -1);
      button.classList.remove('is-down');
    }
    this.intents.fire = false;
    this.intents.boost = false;
    this.intents.handbrake = false;
  }

  private readonly onStickDown = (e: PointerEvent): void => {
    if (this.stickPointer !== -1) return;
    e.preventDefault();
    this.stickPointer = e.pointerId;
    const rect = this.stick.getBoundingClientRect();
    this.originX = rect.left + rect.width / 2;
    this.originY = rect.top + rect.height / 2;
    this.radius = Math.max(24, rect.width * 0.3);
    try {
      this.stick.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers cannot be captured */
    }
    this.stick.classList.add('is-down');
    this.intents.active = true;
    this.moveStick(e.clientX, e.clientY);
  };

  private readonly onStickMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickPointer) return;
    e.preventDefault();
    this.moveStick(e.clientX, e.clientY);
  };

  private readonly onStickEnd = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickPointer) return;
    this.stickPointer = -1;
    this.intents.steer = 0;
    this.intents.throttle = 0;
    this.knob.style.transform = '';
    this.stick.classList.remove('is-down');
  };

  private moveStick(clientX: number, clientY: number): void {
    let dx = (clientX - this.originX) / this.radius;
    let dy = (clientY - this.originY) / this.radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    this.knob.style.transform = `translate3d(${(dx * this.radius).toFixed(1)}px,${(dy * this.radius).toFixed(1)}px,0)`;
    this.intents.steer = shape(dx);
    this.intents.throttle = shape(-dy);
  }

  private readonly onHoldDown = (e: PointerEvent): void => {
    const button = e.currentTarget as HTMLElement;
    e.preventDefault();
    if (this.holdPointers.get(button) !== -1) return;
    this.holdPointers.set(button, e.pointerId);
    try {
      button.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers cannot be captured */
    }
    button.classList.add('is-down');
    this.intents.active = true;
    this.setHold(button, true);
  };

  private readonly onHoldEnd = (e: PointerEvent): void => {
    const button = e.currentTarget as HTMLElement;
    if (this.holdPointers.get(button) !== e.pointerId) return;
    this.holdPointers.set(button, -1);
    button.classList.remove('is-down');
    this.setHold(button, false);
  };

  private setHold(button: HTMLElement, down: boolean): void {
    const key = button.dataset.touch as HoldKey | undefined;
    if (key === 'fire') this.intents.fire = down;
    else if (key === 'boost') this.intents.boost = down;
    else if (key === 'handbrake') this.intents.handbrake = down;
  }
}
