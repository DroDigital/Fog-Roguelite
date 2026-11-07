// Keyboard / mouse input with pointer lock and edge-triggered queries.

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  sensitivity = 1;
  enabled = true;

  constructor(private canvas: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.press(e.code);
    });
    window.addEventListener('keyup', (e) => this.release(e.code));
    window.addEventListener('mousedown', (e) => {
      if (this.locked) this.press('Mouse' + e.button);
    });
    window.addEventListener('mouseup', (e) => this.release('Mouse' + e.button));
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      if (this.locked) this.wheel += Math.sign(e.deltaY);
    });
    window.addEventListener('blur', () => this.down.clear());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.down.clear();
    });
  }

  private press(code: string) {
    if (!this.down.has(code)) this.pressed.add(code);
    this.down.add(code);
  }
  private release(code: string) {
    if (this.down.has(code)) this.released.add(code);
    this.down.delete(code);
  }

  lock() {
    const c = this.canvas as HTMLCanvasElement;
    const p = c.requestPointerLock?.() as unknown;
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
  }
  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code: string) {
    return this.enabled && this.down.has(code);
  }
  wasPressed(code: string) {
    return this.enabled && this.pressed.has(code);
  }
  wasReleased(code: string) {
    return this.enabled && this.released.has(code);
  }
  /** Simulate a key for automated tests / demo mode. */
  inject(code: string, isDown: boolean) {
    if (isDown) this.press(code);
    else this.release(code);
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
