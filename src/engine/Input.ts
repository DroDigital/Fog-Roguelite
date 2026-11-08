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

  /** Standard-mapping gamepad: buttons and sticks become the same virtual codes as keyboard/mouse. */
  padActive = false;
  private padDown = new Set<string>();
  pollGamepad(dt: number) {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = Array.from(pads).find((p) => p && p.connected && p.mapping === 'standard');
    if (!gp) return;
    const want = new Set<string>();
    const btn = (i: number) => !!gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.4);
    const map: [number, string][] = [
      [0, 'Space'], // A: dodge
      [1, 'KeyF'], // B: kick
      [2, 'KeyE'], // X: interact / execute
      [3, 'PadSwap'], // Y: swap weapon
      [4, 'KeyQ'], // LB: vial
      [5, 'KeyR'], // RB: reload
      [6, 'Mouse2'], // LT: block / aim
      [7, 'Mouse0'], // RT: strike
      [9, 'PadStart'],
      [10, 'ShiftLeft'], // L3: sprint
      [12, 'PadUp'], [14, 'PadLeft'], [15, 'PadRight'],
    ];
    for (const [i, code] of map) if (btn(i)) want.add(code);
    const lx = gp.axes[0] ?? 0, ly = gp.axes[1] ?? 0, rx = gp.axes[2] ?? 0, ry = gp.axes[3] ?? 0;
    if (ly < -0.35) want.add('KeyW');
    if (ly > 0.35) want.add('KeyS');
    if (lx < -0.35) want.add('KeyA');
    if (lx > 0.35) want.add('KeyD');
    for (const c of want) if (!this.padDown.has(c)) this.press(c);
    for (const c of this.padDown) if (!want.has(c)) this.release(c);
    this.padDown = want;
    const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : Math.sign(v) * Math.pow((Math.abs(v) - 0.12) / 0.88, 1.6));
    const look = 900 * dt;
    this.mouseDX += dz(rx) * look;
    this.mouseDY += dz(ry) * look * 0.75;
    if (want.size || Math.abs(rx) > 0.2 || Math.abs(ry) > 0.2) this.padActive = true;
    if (this.padActive) this.locked = true;
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
