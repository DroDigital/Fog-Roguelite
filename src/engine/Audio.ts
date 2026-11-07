// Procedural audio: everything is synthesised at runtime with WebAudio so the
// game ships without sound files. Samples can be dropped into /public/audio
// later and registered via `loadSample` to override any synthesized cue.

type Cue =
  | 'swing' | 'swingHeavy' | 'hitFlesh' | 'sever' | 'hitBlock' | 'parry'
  | 'bowFire' | 'boltHit' | 'boltWood' | 'step' | 'hurt' | 'enemyGroan'
  | 'enemyScream' | 'enemyAttack' | 'loot' | 'levelUp' | 'dodge' | 'shrine' | 'death' | 'uiClick';

export class AudioSys {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private amb!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private noiseBuf!: AudioBuffer;
  private samples = new Map<string, AudioBuffer>();
  private heartbeatT = 0;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  volume = 0.8;

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.amb = ctx.createGain();
    this.amb.gain.value = 0.6;
    this.amb.connect(this.master);

    // Noise buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Generated impulse response: long, dark, foggy reverb.
    const irLen = ctx.sampleRate * 3.2;
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen;
        lp = lp * 0.82 + (Math.random() * 2 - 1) * 0.18;
        ch[i] = lp * Math.pow(1 - t, 2.6) * 1.6;
      }
    }
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.45;
    this.reverbSend.connect(this.reverb).connect(this.master);
    this.sfx.connect(this.reverbSend);
    this.startAmbience();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  async loadSample(cue: Cue, url: string) {
    if (!this.ctx) return;
    try {
      const res = await fetch(url);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.samples.set(cue, buf);
    } catch {
      /* keep synthesized fallback */
    }
  }

  private startAmbience() {
    const ctx = this.ctx!;
    // Wind: looped noise through a wandering band-pass.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 400;
    f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = 0.18;
    src.connect(f).connect(g).connect(this.amb);
    src.start();
    this.windGain = g;
    this.windFilter = f;
    // Low drone
    for (const fr of [43.65, 65.4, 87.3]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = fr;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 140;
      const og = ctx.createGain();
      og.gain.value = 0.025;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.05 + Math.random() * 0.08;
      const lg = ctx.createGain();
      lg.gain.value = 0.018;
      lfo.connect(lg).connect(og.gain);
      lfo.start();
      o.connect(lp).connect(og).connect(this.amb);
      o.start();
    }
  }

  /** Called every frame. `danger` 0..1 drives tension layers. */
  update(dt: number, time: number, danger: number, healthFrac: number) {
    if (!this.ctx || !this.windFilter || !this.windGain) return;
    const t = this.ctx.currentTime;
    this.windFilter.frequency.setTargetAtTime(430 + 170 * Math.sin(time * 0.13) + 110 * Math.sin(time * 0.31), t, 0.5);
    this.windGain.gain.setTargetAtTime(0.13 + 0.07 * Math.sin(time * 0.21) + danger * 0.05, t, 0.6);
    if (healthFrac < 0.35) {
      this.heartbeatT -= dt;
      if (this.heartbeatT <= 0) {
        this.heartbeatT = 0.55 + healthFrac * 1.2;
        this.thump(55, 0.5 * (1 - healthFrac));
        setTimeout(() => this.thump(48, 0.35 * (1 - healthFrac)), 140);
      }
    }
  }

  private env(g: GainNode, t: number, a: number, peak: number, d: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private noise(t: number, dur: number, type: BiquadFilterType, freq: number, q: number, peak: number, pan = 0, freqEnd?: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, 0.005, peak, dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(f).connect(g).connect(p).connect(this.sfx);
    src.start(t, Math.random() * 1.5, dur + 0.1);
  }

  private tone(t: number, dur: number, type: OscillatorType, f0: number, f1: number, peak: number, pan = 0) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, 0.004, peak, dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private thump(freq: number, vol: number) {
    if (!this.ctx) return;
    this.tone(this.ctx.currentTime, 0.18, 'sine', freq, freq * 0.6, vol);
  }

  /** Play a cue. `dist` attenuates, `pan` -1..1. */
  play(cue: Cue, opts: { dist?: number; pan?: number; pitch?: number; vol?: number } = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const dist = opts.dist ?? 0;
    const att = (opts.vol ?? 1) / (1 + dist * dist * 0.012);
    if (att < 0.01) return;
    const pan = opts.pan ?? 0;
    const p = opts.pitch ?? 1;
    const s = this.samples.get(cue);
    if (s) {
      const src = ctx.createBufferSource();
      src.buffer = s;
      src.playbackRate.value = p;
      const g = ctx.createGain();
      g.gain.value = att;
      const pn = ctx.createStereoPanner();
      pn.pan.value = pan;
      src.connect(g).connect(pn).connect(this.sfx);
      src.start();
      return;
    }
    const r = () => 0.9 + Math.random() * 0.2;
    switch (cue) {
      case 'swing':
        this.noise(t, 0.22, 'bandpass', 900 * p * r(), 1.2, 0.35 * att, pan, 2600 * p);
        break;
      case 'swingHeavy':
        this.noise(t, 0.38, 'bandpass', 420 * p, 1.0, 0.5 * att, pan, 1600 * p);
        break;
      case 'hitFlesh':
        this.noise(t, 0.16, 'lowpass', 1400 * r(), 1, 0.9 * att, pan, 200);
        this.tone(t, 0.12, 'sine', 120 * r(), 50, 0.7 * att, pan);
        this.noise(t + 0.03, 0.25, 'bandpass', 700, 3, 0.25 * att, pan, 300); // squelch
        break;
      case 'sever':
        this.noise(t, 0.1, 'highpass', 2500, 0.8, 0.45 * att, pan);
        this.noise(t, 0.45, 'bandpass', 500 * r(), 4, 0.5 * att, pan, 160);
        this.tone(t, 0.2, 'triangle', 90, 40, 0.8 * att, pan);
        this.tone(t + 0.02, 0.08, 'square', 1800, 600, 0.06 * att, pan); // bone crack
        break;
      case 'hitBlock':
        this.tone(t, 0.35, 'triangle', 1400 * r(), 1300, 0.25 * att, pan);
        this.tone(t, 0.5, 'sine', 2950 * r(), 2900, 0.12 * att, pan);
        this.noise(t, 0.08, 'highpass', 3000, 1, 0.4 * att, pan);
        break;
      case 'parry':
        this.tone(t, 0.9, 'sine', 2200, 2150, 0.35 * att, pan);
        this.tone(t, 0.9, 'sine', 3310, 3300, 0.2 * att, pan);
        this.noise(t, 0.12, 'highpass', 4000, 1, 0.5 * att, pan);
        break;
      case 'bowFire':
        this.tone(t, 0.18, 'triangle', 220, 90, 0.5 * att, pan);
        this.noise(t, 0.12, 'bandpass', 1800, 2, 0.35 * att, pan, 600);
        break;
      case 'boltHit':
        this.noise(t, 0.1, 'lowpass', 2000, 1, 0.8 * att, pan, 300);
        this.tone(t, 0.1, 'sine', 160, 60, 0.6 * att, pan);
        break;
      case 'boltWood':
        this.tone(t, 0.12, 'square', 420 * r(), 200, 0.15 * att, pan);
        this.noise(t, 0.06, 'bandpass', 1600, 2, 0.4 * att, pan);
        break;
      case 'step':
        this.noise(t, 0.09, 'lowpass', 500 * r(), 1, 0.12 * att, pan, 120);
        break;
      case 'hurt':
        this.tone(t, 0.25, 'sawtooth', 160, 70, 0.3 * att, pan);
        this.noise(t, 0.2, 'lowpass', 900, 1, 0.6 * att, pan, 150);
        break;
      case 'dodge':
        this.noise(t, 0.25, 'bandpass', 600, 0.8, 0.25 * att, pan, 1500);
        break;
      case 'enemyGroan': {
        const f = (70 + Math.random() * 40) * p;
        this.tone(t, 1.2, 'sawtooth', f, f * 0.7, 0.12 * att, pan);
        this.noise(t, 1.1, 'bandpass', 350 * p, 6, 0.18 * att, pan, 220);
        break;
      }
      case 'enemyScream': {
        const f = (300 + Math.random() * 120) * p;
        this.tone(t, 0.8, 'sawtooth', f, f * 0.45, 0.16 * att, pan);
        this.tone(t, 0.8, 'square', f * 1.01, f * 0.5, 0.06 * att, pan);
        this.noise(t, 0.7, 'bandpass', 1200 * p, 3, 0.3 * att, pan, 500);
        break;
      }
      case 'enemyAttack':
        this.noise(t, 0.3, 'bandpass', 700 * p, 2, 0.3 * att, pan, 300);
        this.tone(t, 0.35, 'sawtooth', 180 * p, 90, 0.12 * att, pan);
        break;
      case 'loot':
        [0, 0.07, 0.14].forEach((d, i) => this.tone(t + d, 0.6, 'sine', 660 * Math.pow(1.26, i), 650 * Math.pow(1.26, i), 0.16 * att, pan));
        break;
      case 'levelUp':
        [0, 0.1, 0.2, 0.3].forEach((d, i) => this.tone(t + d, 1.2, 'triangle', 330 * Math.pow(1.335, i), 330 * Math.pow(1.335, i), 0.14 * att));
        break;
      case 'shrine':
        this.tone(t, 2.5, 'sine', 196, 196, 0.2 * att, pan);
        this.tone(t, 2.5, 'sine', 293.6, 293.6, 0.14 * att, pan);
        this.tone(t + 0.2, 2.2, 'sine', 392, 392, 0.1 * att, pan);
        break;
      case 'death':
        this.tone(t, 3, 'sawtooth', 110, 30, 0.3, 0);
        this.noise(t, 3, 'lowpass', 800, 1, 0.4, 0, 60);
        break;
      case 'uiClick':
        this.tone(t, 0.05, 'square', 900, 700, 0.05);
        break;
    }
  }
}

export const audio = new AudioSys();
