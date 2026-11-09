# Vigil — of the Drowned Fog

A first-person, dark-fantasy roguelite set in an endless, procedurally generated moor swallowed by fog.
Carry a lantern into the mist, cut down what crawls out of it, take what the dead leave behind,
and spend the Echoes you bring home on a permanent skill tree before going back in.

> Status: playable vertical slice. Every system described in the design pitch is implemented end to end
> (infinite world, simulated fog, melee + ranged combat with per-limb dismemberment and ragdolls,
> randomised loot, in-run boons, meta skill tree). Visuals are 100% procedural placeholders built to be
> swapped for authored Blender assets. See [Roadmap](#roadmap-to-aaa) for what that gap looks like.

## Running

```bash
npm install
```

```bash
npm run dev
```

Open the printed URL in a desktop browser with WebGL2 (Chrome / Edge / Firefox). A discrete GPU is recommended;
use **Settings → Quality** to scale fog resolution, ray-march steps, shadow resolution and MSAA.

```bash
npm run build
```

produces a static site in `dist/` that can be hosted anywhere.

### Controls

| Action | Input |
| --- | --- |
| Move / sprint | `WASD` / `Shift` |
| Dodge (i-frames) | `Space` |
| Strike (combo) / heavy | `LMB` tap / hold and release |
| Block (parry if timed) / aim | `RMB` |
| Kick (staggers, breaks guard, punts corpses) | `F` |
| Execute a guard-broken foe | `E` |
| Swap blade ↔ crossbow | `1` `2` or mouse wheel |
| Reload | `R` |
| Drink vial | `Q` |
| Interact (chests, shrines, altars, beacons, loot) | `E` |
| Pause | `Esc` |

Gamepads with the standard mapping also work. Sticks move and look, RT strikes, LT blocks or aims, A dodges,
B kicks, X interacts or executes, Y swaps weapons, LB drinks a vial, RB reloads and L3 sprints. Start pauses,
resumes or begins a run, and the D-pad picks level-up boons.

## What's in the game

**World.** An infinite heightfield streamed in 32 m chunks around the player, with three blended biomes
(open moor, dead forest, barrow-fields). Everything is deterministic from the run seed: gnarled trees, eroded
boulders, graveyards laid out in rows, stone circles, ruined colonnades with lantern posts, reliquary chests,
shrines, blood altars and dormant creature lairs.

**Fog.** Fog is the centrepiece rather than a distance tint:
- A 128×128 fluid simulation (`src/world/FogSim.ts`) scrolls with the player. Bodies, dodges, blade swings,
  impacts, explosions and deaths inject momentum and push fog out of the way. It is advected, diffused and
  slowly rolls back in, so you leave a wake and the mist swirls behind every swing.
- A half-resolution volumetric ray-marcher (`src/render/shaders.ts`) samples that field, a tiling 3D noise
  volume drifting on the wind and terrain-relative height falloff. Moonlight is shadowed through the shadow
  map, which produces god rays between trees. Your lantern, shrines, explosions and creature eyes light the
  fog locally.
- Temporal accumulation reprojects last frame's fog to remove ray-march noise. A depth-aware upsample,
  physically based bloom, ACES tone mapping, colour grading, film grain, chromatic
  aberration, blood on the lens and FXAA complete the frame. Dynamic resolution holds about 60 fps.

**Combat.**
- *Melee.* Light attacks chain into a three-swing combo; hold to wind up a charged overhead. The blade is
  swept through the world every frame with sub-stepping and tested against each limb capsule, so you sever
  what you actually hit. Swings that strike the ground or scenery bounce off with sparks. `RMB` blocks;
  blocking just before impact parries and staggers the attacker, and your next strike is a riposte.
- *Ranged.* Crossbows fire physical bolts with drop. They lodge in whatever they hit and stay in severed
  limbs. Headshots kill.
- *Dismemberment.* Each creature is a particle skeleton with ten limb segments under a rigged, sculpted
  skin, and each limb has its own health. A limb is cut **where the blade struck it**: mid-forearm,
  mid-thigh, through the neck. The severed part becomes an independent Verlet ragdoll, with wound caps
  (flesh, bone) on both sides, arterial spray pulsing from the stump, flesh gibs, bone splinters and blood
  decals.
- *Wounds and impairment.* Every hit opens a wound on the skin at the impact point, on the side the blow came
  from; bolts leave entry and exit wounds. Effects depend on where the hit lands:
  - Leg wounds make creatures limp, and losing a leg drops them to crawl after you, trailing blood.
  - Losing arms weakens their attacks.
  - Head blows leave them dazed.
  - Deep belly cuts spill entrails, which dangle and drag on the ground.
  - Bodies bleed out into spreading pools.
- *Swings.* The sword hand is posed directly (fist position, blade direction, wrist roll) on a torso that
  twists and leans, rather than the weapon pivoting around a fixed point. The fist travels a short arc while
  the tip whips through a long one. Each cut runs chamber → release → impact → follow-through → recovery arc.
  - Keys are authored in screen space (where the fist sits, where the blade points, which way the edge faces),
    so the whole swing stays in frame. Every pose is clamped to the arm's reach so the fist never detaches.
  - During the strike the wrist turns the nearer edge into the line of travel, so cuts land edge-first.
  - A spring layer adds weight: the blade shudders as it catches in flesh, and jars back along its path off stone
    or wood. The guard breathes, shifts its weight, bobs with your steps, and drops low while sprinting.
  - The camera leans with the torso, and you step into each strike.
  - The blade drags as it bites through flesh before tearing free, and flicks blood off in the follow-through.
  - A faint trail marks its path.
  - The fist is curled around the grip in a hammer grip, with the forearm meeting it from behind the back
    edge. The arm has a quilted sleeve, a strapped bracer and a vambrace, and is solved with IK. Decapitation and
  severed legs are lethal. Blunt weapons crush skulls instead of cutting. On death the whole body becomes a
  ragdoll that you can keep hacking at.
- *Feel.* Hit-stop, trauma-based camera shake, view-model sway and recoil, blood that builds up on your blade,
  and fully synthesized positional audio (`src/engine/Audio.ts`): war drums swell with the fight, and a
  formant choir sings while the Warden lives.

- *Posture and executions.* Every hit, parry and kick erodes a foe's posture. When it breaks they drop to
  their knees and you can **execute** them: a slow-motion finishing thrust that takes the head, heals you and
  pays out extra Echoes. On the Warden it lands a huge blow instead.

**Creatures.**
- Hollows: shamblers that reach for you.
- Mist Stalkers: fast, lunging pack hunters.
- Weepers: they keep their distance and lob arcing bile from a swollen throat sac, and back off when you close in.
- Barrow Brutes: armoured, slow, ground-slamming.
- The Drowned Warden: a crowned boss with slams, wide sweeps and a charge. It calls the fog's children at
  two-thirds and one-third health.

Elites appear as difficulty rises. A director spawns creatures just beyond visibility, mostly behind you, so
their eyes are often the first thing you see. Each creature carries its own blood: its skin darkens and glistens
where you've cut it.

**Run structure.** Beacon towers stand across the moor; the compass marks the nearest one. Kindling a beacon
calls a **fog surge**: the mist thickens and the fog's children converge on you. Kindle three and the Warden
rises. Felling it raises the **tier**: the fog grows denser and hungrier, and better loot drops. Surges also
roll in on their own every few minutes.

**Loot and progression.**
- Weapons: longsword, greataxe, flanged mace, falchion, crossbow and arbalest, across five rarities
  (Worn → Abyssal) with up to four random affixes. Look at a dropped weapon to compare it with what you hold.
- In-run boons: levelling up offers three of twenty-one boons (common, rare, forbidden). Stone circles grant
  one; blood altars trade a quarter of your max health for a forbidden one.
- Meta progression: Echoes are gathered from kills, chests, depth reached and slaughter, then banked on death
  and spent in **Remembrance**. This 24-node skill tree has three branches (Blade, Hunter, Wraith) and is saved
  in `localStorage`.

## Architecture

There is no game engine. Three.js is used only as a thin WebGL abstraction (buffers, shader compilation,
the PBR lighting model, shadow maps). Every game system is custom.

```
src/
  engine/   Input (pointer lock), seeded RNG + simplex noise, procedural audio, asset library (GLB overrides)
  render/   GPU procedural PBR texture generator, material shader patches (triplanar, terrain splat, wind),
            post pipeline (volumetric fog, composite, bloom, final grade) and its GLSL
  world/    Terrain + biomes, chunk streaming / instancing / colliders, procedural prop meshes, fog simulation
  game/     Game loop + director, Player (controller, melee sweep, crossbow), SwingAnim (keyframed swings,
            IK arms, blade trail), CreatureModel (skinned creatures, cuts, wounds), Body (skeleton, Verlet ragdoll,
            IK, capsule tests), Enemy (anatomy, procedural animation, AI, damage + severing), Gore (particles,
            decals, arterial emitters, gibs), Projectiles, Loot, Stats, Progression, Interactables
  ui/       DOM HUD and menus
tools/blender/export_fog_assets.py   Blender → GLB exporter that registers props in the asset manifest
```

## Creature models (Blender, rigged)

The creatures are sculpted, rigged and baked in Blender by `tools/blender/build_creatures.py`. The script needs
no manual steps. For each creature it:

1. builds a continuous body from a skin-modifier skeleton, plus anatomy: skull, brow, cheekbones, jaw, eye
   sockets, a full rib cage, sternum, clavicles, scapulae, vertebrae, iliac crests, muscle masses, knees,
   elbows, jointed fingers with claws, and toes;
2. fuses everything with a voxel remesh into a single organic surface, then sculpts wrinkles, veins and lumps
   into it with layered displacement;
3. decimates a game mesh of about 14k triangles and bakes the sculpt's colour (blotches, bruising, veins,
   cavity dirt) and ambient occlusion into its vertex colours with Cycles;
4. rigs it to a 10-bone armature that matches the engine's limb segments, and exports a GLB and a JSON file
   with the bind pose to `public/assets/creatures/`.

```bash
pip install bpy
```

```bash
python tools/blender/build_creatures.py
```

The second command builds every creature; add ids such as `hollow brute` to build only those.
`VIGIL_PREVIEW=<dir>` also writes Cycles turntable renders. Without the GLBs the game falls back to its
procedural capsule bodies.

In the engine (`src/game/CreatureModel.ts`) each creature is one skinned mesh on 20 bones: one per limb segment
plus a spare stub bone per segment. Cutting a limb, at any point along it, re-weights the vertices beyond the
cut onto the severed part's bones and drops the triangles that straddle the cut; wound caps cover both sides.
Wounds are painted into a per-vertex attribute at the exact impact point, stretched along the blade's path,
and the shader sinks and reddens them into raw, glistening meat. Seamless triplanar flesh detail is added in
bind space, so the model needs no UV layout.

## Asset pipeline (Blender and libraries)

The game ships with no binary assets. All meshes, textures, animation and audio are generated at load time,
so it always runs. Authored content overrides the procedural version per id:

1. In Blender, put each prop in a collection named `prop_<id>`. The ids are `tree`, `rock`, `grave`, `menhir`,
   `pillar`, `wall`, `shrine` and `lantern`. Use metres, put the origin at the ground contact, and make one
   mesh per prop.
2. Run the exporter. It writes `public/assets/models/<id>.glb` and updates `public/assets/manifest.json`:
   ```bash
   blender props.blend --background --python tools/blender/export_fog_assets.py -- /path/to/Fog-Roguelite
   ```
3. Sound effects work the same way. Add `"audio": { "hitFlesh": "audio/hit_flesh.ogg" }` to the manifest; any
   cue name in `src/engine/Audio.ts` can be overridden.

Textures can be replaced in the same spirit through `TextureGen` (`src/render/TextureGen.ts`).

## Development hooks

The URL parameters below make the game scriptable, for example from Playwright:

| Param | Effect |
| --- | --- |
| `?seed=123` | fixed world seed |
| `?autostart` | skip the menu, run without pointer lock |
| `?q=low\|medium\|high\|ultra` | force a quality preset |
| `?noloop` | don't start the RAF loop; step manually with `game.frame(dt, render?)` |

`window.game` exposes the running instance. `game.input.inject('Mouse0', true)` simulates input.

`npm run typecheck` type-checks the project.

`npm run build && npm run smoke` runs an end-to-end smoke test (`scripts/smoke.mjs`). It serves the build,
drives the game headlessly with Playwright, and asserts that melee kills, limb severing, executions, crossbow
headshots, boss spawning and beacon generation all work, then soaks 3,000 frames of random input. It needs
`playwright` and `npx playwright install chromium`.

## Roadmap to AAA

What a production pass still needs. The code is structured so each item drops in without rework.
- **Authored assets.** Sculpted and retopologised creatures with skinned meshes, hand-made trees and ruins,
  baked texture sets and recorded foley through the manifest above. The procedural generators remain as
  variation and fallback.
- **Animation.** Mocap or keyframed clips blended over the IK and procedural layer. The joint-particle skeleton
  already accepts any pose source.
- **Rendering.** Temporal reprojection for the fog and TAA, clustered lights, GPU particles, screen-space
  reflections on wet ground, and a WebGPU backend.
- **Content.** More creature archetypes and bosses, weapon movesets per archetype, biome-specific events and
  a narrative layer.
