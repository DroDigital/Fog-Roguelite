// DOM user interface: HUD, menus, level-up choices, skill tree, death screen.

import { SKILL_TREE, canUnlock, type MetaSave, type SkillNode } from '../game/Progression';
import type { Boon, Weapon } from '../game/Loot';
import { describeMod } from '../game/Stats';
import { audio } from '../engine/Audio';

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export interface HudState {
  hp: number; maxHp: number; st: number; maxSt: number; xp: number; xpNext: number; level: number;
  vials: number; bolts: number; maxBolts: number; weapon: Weapon; active: 'melee' | 'ranged';
  echoes: number; distance: number; kills: number; yaw: number; time: number;
  beacon: { rel: number; dist: number } | null; beaconsLit: number; beaconsNeeded: number; tier: number;
  surge: boolean;
}

export interface EnemyBar { x: number; y: number; hp: number; posture: number; broken: boolean; elite: boolean }

export class UI {
  root: HTMLElement;
  private screens: Record<string, HTMLElement> = {};
  private notifyT = 0;
  private hudCache: Record<string, string> = {};
  onStart: () => void = () => {};
  onResume: () => void = () => {};
  onQuit: () => void = () => {};
  onSettings: (s: MetaSave['settings']) => void = () => {};

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div id="hud" class="off">
        <div class="compass"><div class="strip"></div><div class="marker" id="h-marker">◆</div></div>
        <div id="h-objective"></div>
        <div id="bossbar" class="hidden"><div class="bname"></div><div class="btrack"><i class="bfill"></i><i class="bpost"></i></div></div>
        <div id="hurtdir"></div>
        <div id="ebars"></div>
        <div id="hint"></div>
        <div id="feed"></div>
        <div class="topinfo"><div>TIER <b id="h-tier">I</b></div><div>DEPTH <b id="h-dist">0</b> M</div><div>SLAIN <b id="h-kills">0</b></div><div>ECHOES <b id="h-echo">0</b></div></div>
        <div id="crosshair"></div>
        <div id="prompt"></div>
        <div id="notify"></div>
        <div id="lootcard"></div>
        <div class="bars">
          <div class="bar hp"><i class="trail"></i><i class="fill"></i></div>
          <div class="bar st"><i class="fill"></i></div>
          <div class="bar xp"><i class="fill"></i></div>
          <div class="lvl" id="h-lvl">LEVEL 1</div>
        </div>
        <div class="kit">
          <div class="wname" id="h-wname"></div>
          <div class="wsub" id="h-wsub"></div>
          <div class="counts"><span id="h-vials"></span><span id="h-bolts"></span></div>
        </div>
      </div>
      <div class="screen menu" id="s-main">
        <h1 class="title">VIGIL</h1>
        <div class="subtitle">of the drowned fog</div>
        <div class="btns">
          <button class="mb" data-a="start">Enter the Fog</button>
          <button class="mb" data-a="tree">Remembrance</button>
          <button class="mb" data-a="settings">Settings</button>
        </div>
        <div class="meta-line" id="m-meta"></div>
        <div class="hint">WASD move · Shift sprint · Space dodge · LMB strike (hold for heavy) · RMB block / aim · F kick · 1 / 2 or wheel swap · R reload · Q vial · E interact / execute · Esc pause<br>Gamepad: sticks move / look · RT strike · LT block · A dodge · B kick · X interact · Y swap · LB vial · RB reload · L3 sprint · Start pause / begin</div>
      </div>
      <div class="screen menu" id="s-pause">
        <h2 class="title" style="font-size:42px">PAUSED</h2>
        <div class="btns" style="margin-top:30px">
          <button class="mb" data-a="resume">Resume</button>
          <button class="mb" data-a="settings">Settings</button>
          <button class="mb" data-a="quit">Abandon Run</button>
        </div>
      </div>
      <div class="screen menu" id="s-settings">
        <div class="panel">
          <h2>SETTINGS</h2>
          <div class="setting">Quality <select id="o-quality"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="ultra">Ultra</option></select></div>
          <div class="setting">Mouse Sensitivity <input type="range" id="o-sens" min="0.2" max="3" step="0.05"></div>
          <div class="setting">Field of View <input type="range" id="o-fov" min="60" max="100" step="1"></div>
          <div class="setting">Volume <input type="range" id="o-vol" min="0" max="1" step="0.01"></div>
          <div class="setting">Gore <input type="range" id="o-gore" min="0" max="1.5" step="0.05"></div>
          <div class="setting">Dynamic Resolution <input type="checkbox" id="o-dyn"></div>
          <div class="btns" style="margin-top:20px"><button class="mb" data-a="back">Back</button></div>
        </div>
      </div>
      <div class="screen menu" id="s-level">
        <h2 class="title" style="font-size:34px">THE FOG OFFERS</h2>
        <div class="subtitle">choose one</div>
        <div class="choices" id="l-choices"></div>
      </div>
      <div class="screen menu" id="s-tree">
        <div class="panel">
          <h2>REMEMBRANCE</h2>
          <div class="echoes" id="t-echoes"></div>
          <div class="tree" id="t-tree"></div>
          <div class="tip" id="t-tip">What the fog takes, it remembers. Spend Echoes to make it remember you.</div>
          <div class="btns"><button class="mb" data-a="back">Back</button></div>
        </div>
      </div>
      <div class="screen menu death" id="s-death">
        <div class="you">YOU FADED</div>
        <div class="stats" id="d-stats"></div>
        <div class="btns">
          <button class="mb" data-a="tree">Remembrance</button>
          <button class="mb" data-a="start">Return to the Fog</button>
          <button class="mb" data-a="menu">Main Menu</button>
        </div>
      </div>
      <div id="fade"></div>
      <div id="loading">KINDLING THE LANTERN…</div>
    `;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.screen'))) this.screens[el.id.slice(2)] = el;
    root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-a]') as HTMLElement | null;
      if (!b) return;
      audio.init();
      audio.play('uiClick');
      this.action(b.dataset.a!);
    });
  }

  private backTo = 'main';
  private save: MetaSave | null = null;
  current = 'loading';

  bindSave(save: MetaSave) {
    this.save = save;
  }

  private action(a: string) {
    switch (a) {
      case 'start':
        this.onStart();
        break;
      case 'resume':
        this.onResume();
        break;
      case 'quit':
        this.onQuit();
        break;
      case 'menu':
        this.show('main');
        break;
      case 'tree':
        this.backTo = this.current;
        this.renderTree();
        this.show('tree');
        break;
      case 'settings':
        this.backTo = this.current;
        this.renderSettings();
        this.show('settings');
        break;
      case 'back':
        this.show(this.backTo);
        break;
    }
  }

  loaded() {
    $('#loading').classList.add('hidden');
  }

  fade(out: boolean) {
    $('#fade').classList.toggle('out', out);
  }

  show(name: string | null) {
    for (const [k, el] of Object.entries(this.screens)) el.classList.toggle('on', k === name);
    this.current = name ?? 'game';
    $('#hud').classList.toggle('off', name !== null);
    $('#hud').style.transition = name !== null ? 'none' : '';
    if (name === 'main' && this.save) {
      const s = this.save;
      $('#m-meta').innerHTML = s.runs > 0 ? `ECHOES ${s.echoes} · RUNS ${s.runs} · DEEPEST ${Math.round(s.bestDistance)} M · SLAIN ${s.totalKills}` : 'The lantern is lit. The fog is waiting.';
    }
  }

  private renderSettings() {
    const s = this.save!.settings;
    const q = $<HTMLSelectElement>('#o-quality');
    q.value = s.quality;
    const sens = $<HTMLInputElement>('#o-sens');
    sens.value = String(s.sensitivity);
    const fov = $<HTMLInputElement>('#o-fov');
    fov.value = String(s.fov);
    const vol = $<HTMLInputElement>('#o-vol');
    vol.value = String(s.volume);
    const gore = $<HTMLInputElement>('#o-gore');
    gore.value = String(s.gore);
    const dyn = $<HTMLInputElement>('#o-dyn');
    dyn.checked = s.dynamicRes !== false;
    dyn.onchange = () => {
      s.dynamicRes = dyn.checked;
      this.onSettings(s);
    };
    const upd = () => {
      s.quality = q.value;
      s.sensitivity = +sens.value;
      s.fov = +fov.value;
      s.volume = +vol.value;
      s.gore = +gore.value;
      this.onSettings(s);
    };
    for (const el of [q, sens, fov, vol, gore]) el.oninput = upd;
  }

  renderTree() {
    const save = this.save!;
    $('#t-echoes').textContent = `ECHOES  ${save.echoes}`;
    const tree = $('#t-tree');
    tree.innerHTML = '';
    const branches: [SkillNode['branch'], string, string][] = [
      ['blade', 'BLADE', 'steel and severance'],
      ['hunter', 'HUNTER', 'bolt and swiftness'],
      ['wraith', 'WRAITH', 'endurance in the mist'],
    ];
    for (const [b, title, desc] of branches) {
      const col = document.createElement('div');
      col.className = 'branch';
      col.innerHTML = `<h3>${title}</h3><div class="bd">${desc}</div><div class="nodes"><svg></svg></div>`;
      const nodesEl = col.querySelector('.nodes') as HTMLElement;
      const svg = col.querySelector('svg')!;
      const nodes = SKILL_TREE.filter((n) => n.branch === b);
      const px = (n: SkillNode) => ({ x: 58 + n.x * 144, y: 14 + n.y * 100 });
      for (const n of nodes) {
        for (const r of n.requires) {
          const p = SKILL_TREE.find((k) => k.id === r)!;
          const a = px(p), c = px(n);
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', String(a.x));
          line.setAttribute('y1', String(a.y + 40));
          line.setAttribute('x2', String(c.x));
          line.setAttribute('y2', String(c.y));
          line.setAttribute('stroke', save.unlocked.includes(r) ? '#b8a676' : 'rgba(216,208,192,0.18)');
          svg.appendChild(line);
        }
      }
      for (const n of nodes) {
        const el = document.createElement('div');
        const owned = save.unlocked.includes(n.id);
        const avail = canUnlock(save, n);
        const reqMet = n.requires.every((r) => save.unlocked.includes(r));
        el.className = 'node ' + (owned ? 'owned' : avail ? 'avail' : reqMet ? 'avail' : 'locked');
        const p = px(n);
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        el.innerHTML = `<div class="n">${n.name}</div><div class="c">${owned ? 'REMEMBERED' : n.cost + ' ✦'}</div>`;
        el.onmouseenter = () => {
          $('#t-tip').innerHTML = `<b>${n.name}</b> — ${n.desc}<br><span style="color:var(--dim)">${n.mods.map(describeMod).join(' · ')}</span>`;
        };
        el.onclick = () => {
          if (canUnlock(save, n)) {
            save.echoes -= n.cost;
            save.unlocked.push(n.id);
            audio.init();
            audio.play('levelUp');
            this.onSettings(save.settings); // triggers save
            this.renderTree();
          } else if (!owned) {
            audio.play('uiClick');
          }
        };
        nodesEl.appendChild(el);
      }
      tree.appendChild(col);
    }
  }

  levelUp(boons: Boon[], title: string, onPick: (b: Boon) => void) {
    const wrap = $('#l-choices');
    $('#s-level .title').textContent = title;
    wrap.innerHTML = '';
    const rn = ['COMMON', 'RARE', 'FORBIDDEN'];
    const rc = ['#c9c3b5', '#5fa8d3', '#ff5a3c'];
    boons.forEach((b, i) => {
      const el = document.createElement('div');
      el.className = 'choice';
      el.innerHTML = `<div class="r" style="color:${rc[b.rarity]}">${rn[b.rarity]}</div><h3>${b.name}</h3><p>${b.desc}</p><div class="k">[ ${i + 1} ]</div>`;
      el.onclick = () => onPick(b);
      wrap.appendChild(el);
    });
    this.show('level');
  }

  death(rows: [string, string][]) {
    $('#d-stats').innerHTML = rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join('');
    this.show('death');
  }

  // ───────────────────────── HUD

  private set(id: string, prop: 'text' | 'width', v: string) {
    const k = id + prop;
    if (this.hudCache[k] === v) return;
    this.hudCache[k] = v;
    const el = this.root.querySelector(id) as HTMLElement;
    if (!el) return;
    if (prop === 'text') el.textContent = v;
    else el.style.width = v;
  }

  hud(s: HudState) {
    const hp = Math.max(0, s.hp / s.maxHp) * 100;
    this.set('.bar.hp .fill', 'width', hp.toFixed(1) + '%');
    this.set('.bar.hp .trail', 'width', hp.toFixed(1) + '%');
    this.set('.bar.st .fill', 'width', (Math.max(0, s.st / s.maxSt) * 100).toFixed(1) + '%');
    this.set('.bar.xp .fill', 'width', (Math.min(1, s.xp / s.xpNext) * 100).toFixed(1) + '%');
    (this.root.querySelector('.bar.hp') as HTMLElement).style.width = Math.min(100, 70 + s.maxHp * 0.3) + '%';
    (this.root.querySelector('.bar.st') as HTMLElement).style.width = Math.min(100, 50 + s.maxSt * 0.35) + '%';
    this.set('#h-lvl', 'text', `LEVEL ${s.level}`);
    this.set('#h-wname', 'text', s.weapon.name);
    const sub = s.weapon.kind === 'melee' ? `${s.weapon.rarity.name.toUpperCase()} · ${s.weapon.melee!.damage} DMG` : `${s.weapon.rarity.name.toUpperCase()} · ${s.weapon.ranged!.damage} DMG`;
    this.set('#h-wsub', 'text', sub);
    (this.root.querySelector('#h-wname') as HTMLElement).style.color = s.weapon.rarity.color;
    this.set('#h-vials', 'text', `VIALS ${s.vials}`);
    this.set('#h-bolts', 'text', `BOLTS ${s.bolts}/${s.maxBolts}`);
    this.set('#h-dist', 'text', String(Math.round(s.distance)));
    this.set('#h-kills', 'text', String(s.kills));
    this.set('#h-echo', 'text', String(s.echoes));
    // compass
    const strip = this.root.querySelector('.compass .strip') as HTMLElement;
    if (!strip.childElementCount) {
      const labels = ['N', '·', 'NE', '·', 'E', '·', 'SE', '·', 'S', '·', 'SW', '·', 'W', '·', 'NW', '·'];
      strip.innerHTML = [...labels, ...labels, ...labels].map((l) => `<span>${l}</span>`).join('');
    }
    const deg = ((-s.yaw * 180) / Math.PI) % 360;
    const px = ((deg + 360) % 360) / 22.5 * 45;
    strip.style.transform = `translateX(${180 - 22.5 - px - 16 * 45}px)`;
    const mk = this.root.querySelector('#h-marker') as HTMLElement;
    if (s.beacon) {
      const x = Math.max(-170, Math.min(170, -s.beacon.rel * 114.6));
      mk.style.display = 'block';
      mk.style.transform = `translateX(${x}px)`;
      mk.style.opacity = Math.abs(x) >= 170 ? '0.45' : '1';
    } else mk.style.display = 'none';
    const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
    this.set('#h-tier', 'text', roman[Math.min(9, s.tier)] ?? String(s.tier + 1));
    const obj = s.surge
      ? '<span style="color:#d4776b">THE FOG SURGES — SURVIVE</span>'
      : s.beaconsLit >= s.beaconsNeeded
        ? '<span style="color:#9fb6d4">THE WARDEN STIRS</span>'
        : `BEACONS KINDLED ${s.beaconsLit} / ${s.beaconsNeeded}${s.beacon ? ` · NEAREST ${Math.round(s.beacon.dist)} M` : ''}`;
    if (this.hudCache.obj !== obj) {
      this.hudCache.obj = obj;
      (this.root.querySelector('#h-objective') as HTMLElement).innerHTML = obj;
    }
  }

  bossBar(name: string | null, hp = 0, posture = 0) {
    const el = this.root.querySelector('#bossbar') as HTMLElement;
    el.classList.toggle('hidden', !name);
    if (!name) return;
    this.set('#bossbar .bname', 'text', name);
    this.set('#bossbar .bfill', 'width', (Math.max(0, hp) * 100).toFixed(1) + '%');
    this.set('#bossbar .bpost', 'width', (Math.max(0, posture) * 100).toFixed(1) + '%');
  }

  private barPool: HTMLElement[] = [];
  enemyBars(bars: EnemyBar[]) {
    const host = this.root.querySelector('#ebars') as HTMLElement;
    while (this.barPool.length < bars.length) {
      const d = document.createElement('div');
      d.className = 'ebar';
      d.innerHTML = '<i class="h"></i><i class="p"></i>';
      host.appendChild(d);
      this.barPool.push(d);
    }
    this.barPool.forEach((d, i) => {
      const b = bars[i];
      if (!b) {
        d.style.display = 'none';
        return;
      }
      d.style.display = 'block';
      d.style.transform = `translate(${b.x - 30}px, ${b.y}px)`;
      d.classList.toggle('broken', b.broken);
      d.classList.toggle('elite', b.elite);
      (d.firstElementChild as HTMLElement).style.width = (b.hp * 100).toFixed(0) + '%';
      (d.lastElementChild as HTMLElement).style.width = (b.posture * 100).toFixed(0) + '%';
    });
  }

  /** Flash a damage arc pointing at an attacker; `rel` is radians, 0 = ahead, + = left. */
  hurtFrom(rel: number) {
    const el = this.root.querySelector('#hurtdir') as HTMLElement;
    el.style.transform = `translate(-50%, -50%) rotate(${-rel}rad)`;
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }

  hint(text: string | null) {
    const el = this.root.querySelector('#hint') as HTMLElement;
    const v = text ?? '';
    if (this.hudCache.hint === v) return;
    this.hudCache.hint = v;
    el.innerHTML = v;
    el.style.opacity = v ? '1' : '0';
  }

  hitMarker() {
    const c = $('#crosshair');
    c.classList.add('hit');
    setTimeout(() => c.classList.remove('hit'), 90);
  }

  notify(text: string, dur = 0.9) {
    const n = $('#notify');
    n.textContent = text;
    n.classList.add('on');
    this.notifyT = dur;
  }

  feed(text: string, color = 'var(--ink)') {
    const f = $('#feed');
    const d = document.createElement('div');
    d.innerHTML = text;
    d.style.color = color;
    f.appendChild(d);
    setTimeout(() => d.classList.add('fade'), 3500);
    setTimeout(() => d.remove(), 4600);
    while (f.childElementCount > 6) f.firstElementChild!.remove();
  }

  prompt(html: string | null) {
    const p = $('#prompt');
    const v = html ?? '';
    if (this.hudCache.prompt !== v) {
      this.hudCache.prompt = v;
      p.innerHTML = v;
    }
  }

  lootCard(w: Weapon | null, current: Weapon | null) {
    const el = $('#lootcard');
    const key = w ? w.uid + ':' + (current?.uid ?? 0) : '';
    if (this.hudCache.loot === key) return;
    this.hudCache.loot = key;
    if (!w) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = this.weaponCard(w, current, 'FOUND') + (current ? this.weaponCard(current, null, 'EQUIPPED') : '');
  }

  private weaponCard(w: Weapon, cmp: Weapon | null, label: string) {
    const rows: string[] = [];
    const cls = (a: number, b: number | undefined, higherBetter = true) => (b === undefined || a === b ? '' : (a > b) === higherBetter ? 'up' : 'down');
    if (w.melee) {
      const c = cmp?.melee;
      rows.push(`<div class="row">Damage <b class="${cls(w.melee.damage, c?.damage)}">${w.melee.damage}</b></div>`);
      rows.push(`<div class="row">Speed <b class="${cls(w.melee.speed, c?.speed)}">${w.melee.speed.toFixed(2)}</b></div>`);
      rows.push(`<div class="row">Reach <b class="${cls(w.melee.reach, c?.reach)}">${w.melee.reach.toFixed(2)} m</b></div>`);
      rows.push(`<div class="row">Severance <b class="${cls(w.melee.sever, c?.sever)}">${w.melee.blunt ? 'Crushing' : w.melee.sever.toFixed(2)}</b></div>`);
    } else if (w.ranged) {
      const c = cmp?.ranged;
      rows.push(`<div class="row">Damage <b class="${cls(w.ranged.damage, c?.damage)}">${w.ranged.damage}</b></div>`);
      rows.push(`<div class="row">Reload <b class="${cls(w.ranged.reload, c?.reload, false)}">${w.ranged.reload.toFixed(1)} s</b></div>`);
    }
    const aff = w.affixes.map((a) => `<div class="aff">${a.text}: ${a.mods.map(describeMod).join(', ')}</div>`).join('');
    return `<div class="card"><div class="lbl">${label}</div><h3 style="color:${w.rarity.color}">${w.name}</h3><div class="tier" style="color:${w.rarity.color}">${w.rarity.name}</div>${rows.join('')}${aff}</div>`;
  }

  tick(dt: number) {
    if (this.notifyT > 0) {
      this.notifyT -= dt;
      if (this.notifyT <= 0) $('#notify').classList.remove('on');
    }
  }
}
