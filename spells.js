// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  spells.js — THE SPELL TABLE (magic step 1, 2026-11-16 — `scratchpad/kickoff_magic.md` §ROUND 3). SHARED: server/index.js requires
//  it and checks every cast against it; the client gets it inlined as `MWSpells` (extension/build.js, dev/serve.js) and reads the
//  same inputs from it — so the input you put in is the one the server would accept.
//
//  · DIRECTIONS: 0 up · 1 right · 2 down · 3 left.
//  · THE NINE POINTS of a traced rune are numbered 0–8, row by row from the top left:   0 1 2 / 3 4 5 / 6 7 8.
//  · A SPELL'S INPUT, two ways (a switch on the client, Items › Magic):
//      the LANGUAGE — its school's piece, then its form's piece, then one more "up" / an underline per tier above 0;
//      PLAIN        — a sequence and a rune of its own, sharing nothing with other spells (`plain` on the spell).
//    Both exist as direction KEYS and as a RUNE through the nine points.
//  · A CATALYST changes the cooldown (`cdK`) and the strength (`powK`), and has an INNATE ability (a spell id here, `innate: true`).
//  New spell = an entry in SPELLS + what it does on the client (16zj `MAGIC_FX`) and, if it changes the world, on the server.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MWSpells = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  const U = 0, R = 1, D = 2, L = 3;
  // name · colour · its two keys · its stroke through the nine points
  const SCHOOLS = {
    fire:       { name: 'Fire',            col: '#ff8a3c', keys: [U, U], rune: [6, 1, 8] },
    frost:      { name: 'Frost and water', col: '#7fd0ff', keys: [D, D], rune: [0, 7, 2] },
    storm:      { name: 'Storm',           col: '#c9d6ff', keys: [L, R], rune: [0, 5, 6] },
    earth:      { name: 'Earth',           col: '#c9a26a', keys: [D, U], rune: [0, 6, 8] },
    force:      { name: 'Force',           col: '#e6e6f0', keys: [R, R], rune: [3, 4, 5] },
    space:      { name: 'Space',           col: '#b08cff', keys: [R, L], rune: [2, 4, 6] },
    wards:      { name: 'Wards',           col: '#ffd86b', keys: [L, L], rune: [0, 2, 8] },
    life:       { name: 'Life',            col: '#8be28b', keys: [U, D], rune: [7, 4, 1] },
    decay:      { name: 'Decay',           col: '#a9b860', keys: [D, L], rune: [1, 3, 7] },
    alteration: { name: 'Alteration',      col: '#f0b0d0', keys: [U, R], rune: [3, 7, 5] },
    illusion:   { name: 'Illusion',        col: '#ff9be0', keys: [L, U], rune: [2, 0, 6] },
    knowing:    { name: 'Knowing',         col: '#8fe8e0', keys: [U, L], rune: [6, 2, 8] },
    voice:      { name: 'Voice',           col: '#f5f5a0', keys: [R, U], rune: [3, 1, 5] },
    summoning:  { name: 'Summoning',       col: '#e09a9a', keys: [D, R], rune: [2, 8, 6] },
    light:      { name: 'Light',           col: '#bcd8ff', keys: [L, D], rune: [0, 1, 2] },   // (step 3a: was 1 4 7 — with a form's stroke from the middle it ran back over itself, 7 → 4 → 7; no spell used it before)
  };
  // (the user, round 2: form pieces run THROUGH THE GRID'S POINTS — burst = the diamond, field = the full square, on yourself = the short diagonal)
  const FORMS = {
    bolt:    { name: 'Bolt',                 keys: [R, R], rune: [4, 5] },
    stream:  { name: 'Stream',               keys: [R, D], rune: [4, 8] },
    burst:   { name: 'Burst',                keys: [U, D], rune: [1, 5, 7, 3, 1] },
    self:    { name: 'On yourself',          keys: [D, D], rune: [4, 6] },
    placed:  { name: 'Placed',               keys: [D, L], rune: [4, 7] },
    shaping: { name: 'Shaping',              keys: [L, R], rune: [4, 2] },
    trail:   { name: 'Trail',                keys: [R, L], rune: [3, 4] },
    field:   { name: 'Field',                keys: [L, L], rune: [0, 2, 8, 6, 0] },
    touch:   { name: 'Touch',                keys: [U, U], rune: [4, 1] },
    thing:   { name: 'On a weapon or thing', keys: [U, R], rune: [0, 2] },
  };
  //  cd       seconds before it can be cast again (× the catalyst's `cdK`)
  //  stance   how the catalyst is held once the spell is prepared: 'level' = pointed at the pointer (a projectile) · 'raise' = held up
  //  tier     0 simple … — one more piece of input each, and easier to interrupt (client 16zj `magicHurt`)
  //  speed, life, grav, r   a bolt: px a second, seconds it flies, how much gravity pulls it (0–1), its radius (px)
  //  dmg      health it takes (of 10) · burn = what it hits catches fire
  //  innate   a catalyst's own ability: no input, not learnt
  //  learn    (step 2) how many times it must be put in rightly with its tome open before it is yours (this life)
  //  uses     (step 2) the reagents one cast uses up: [[item id, how many], …] (server/items.js, kind 'reagent')
  //  burnR    cells round where it lands that catch (a bolt with `burn`), default 1
  const SPELLS = {
    firebolt: { name: 'Firebolt', school: 'fire', form: 'bolt', tier: 0, cd: 2.5, stance: 'level', kind: 'bolt', learn: 3,
      speed: 760, life: 1.1, grav: 0.06, r: 3, dmg: 1.2, burn: true, plain: { keys: [U, R, R, D, R], rune: [6, 0, 4, 2, 8] } },
    // (step 2, 2026-11-17 — the user's step 0 pick: "1A for the quick low one, 1B for a bigger / stronger version") the same bolt one tier up: slower, heavier, it burns
    //   wider, and it uses up an EMBER SALT each cast
    greatbolt: { name: 'Great firebolt', school: 'fire', form: 'bolt', tier: 1, cd: 6, stance: 'level', kind: 'bolt', learn: 5, uses: [['ember_salt', 1]],
      speed: 560, life: 1.4, grav: 0.1, r: 5.5, dmg: 2.8, burn: true, burnR: 2, trailS: 1.2, plain: { keys: [U, R, R, D, R, U], rune: [6, 0, 4, 2, 8, 7] } },
    // ⭐ STEP 3a (2026-11-17, the user's step 0 picks): GUST (2B — wind seen only by what it moves: a cone from the hand that shoves bodies, loose things and liquid) and the LIGHT ORB
    //   (both 3A 'follows you' and 3B 'stays where you point', from ONE spell by a small change to its input — Light + Placed stays, Light + On yourself follows; the bluer light).
    //   `alt` = the spell it is a variant of: learnt with it, your own part shared with it (`baseOf`). `alts` = its variants (the tome's page shows them).
    //   reach  px (gust: how far it shoves; orb: how far it may be set) · cone  half its width, degrees · push  how hard (a body's speed, px a tick)
    //   secs  how long an orb lasts · pow, rr  its light: strength and reach (px) · stay  it hangs where it was set (else it follows its caster)
    gust: { name: 'Gust', school: 'storm', form: 'burst', tier: 0, cd: 3, stance: 'level', kind: 'gust', learn: 3, reach: 150, cone: 32, push: 9,
      plain: { keys: [L, L, R, U], rune: [3, 1, 5, 7] } },
    lightorb: { name: 'Light orb', school: 'light', form: 'placed', tier: 0, cd: 4, stance: 'level', kind: 'orb', learn: 3, stay: true, reach: 420, secs: 60, pow: 2, rr: 230, alts: ['lightorb_f'],
      plain: { keys: [L, D, D, L], rune: [1, 4, 7, 6] } },
    lightorb_f: { name: 'Light orb (following)', school: 'light', form: 'self', tier: 0, cd: 4, stance: 'level', kind: 'orb', alt: 'lightorb', stay: false, secs: 60, pow: 1.6, rr: 170,
      plain: { keys: [L, D, D, D], rune: [1, 4, 7, 8] } },
    // ⭐ STEP 3d (2026-11-17), BATCH b — the server changes the world; what it changes goes back by itself (server `magicTemp`, kept in the database so a restart does not strand it):
    //   FREEZE (4A: clear blue ice) — the WATER at the pointer turns to ice cell by cell, outward from where it struck; walkable; melts back to the same water after `secs`.
    //     cells  at most this many · ringMs  between one ring of cells and the next
    //   STONE WALL (5A: plain rock like the ground, lasting longer) — rises out of the ground at the pointer row by row; cracks over its last `crackS` seconds, then crumbles.
    //     wide, high  cells · rowMs  between rows rising
    //   ⭐ STEP 3e (the user): freeze and the wall are SHOTS — `speed`, `life`, `grav`, `r` as a bolt's: freeze stops in the first liquid (or on rock) and freezes there; the wall's stone
    //     is lobbed, sinks through liquid (slowed), drops down a face it meets, and the wall rises where it comes to rest on the ground. high 6 → 12 · `crumbleMs` a row, from the top
    //     · `thruLiq` it rises through liquid, pushing it aside
    //   THE RUNE THAT GOES OFF (9A: it fades) — written on the ground at the pointer; bright, then a faint trace; whoever else steps on it sets it off: a blast (`blastR` px,
    //     `blastF` its push, `dmg` health at its middle). `armS` before it can go off · at most `most` a caster.
    freeze: { name: 'Freeze', school: 'frost', form: 'burst', tier: 0, cd: 4, stance: 'level', kind: 'freeze', learn: 3, reach: 420, secs: 30, cells: 90, ringMs: 70, speed: 620, life: 1.3, grav: 0.04, r: 3.5,
      plain: { keys: [D, L, D, R], rune: [2, 4, 6, 7] } },
    stonewall: { name: 'Stone wall', school: 'earth', form: 'placed', tier: 1, cd: 8, stance: 'level', kind: 'wall', learn: 5, reach: 360, secs: 45, crackS: 6, wide: 2, high: 12, rowMs: 55, crumbleMs: 30, thruLiq: true, speed: 560, life: 3, grav: 0.35, r: 4.5,
      plain: { keys: [D, U, U, L, D], rune: [6, 7, 8, 5, 2] } },
    rune: { name: 'Warding rune', school: 'wards', form: 'placed', tier: 1, cd: 6, stance: 'level', kind: 'rune', learn: 5, reach: 300, secs: 180, armS: 1.5, most: 3, blastR: 90, blastF: 14, dmg: 3,
      plain: { keys: [R, L, L, D, U], rune: [0, 3, 6, 7, 4] } },
    // ⭐ STEP 3g (2026-11-17), BATCH c (the user's picks): CLOSE WOUNDS (6A + 6B — motes drawn in, stitches across each cut, one after another; it heals into its scar) ·
    //   LIFT AND THROW (7A — a thread of light to a loose thing; held while the button is, the other button throws) · A DOUBLE OF YOU (8Y — it walks on the way you were going;
    //   see-through on your own screen; struck, it bursts). hp  health it gives back · closeMs, gap  a cut's closing, between cuts · ms  the motes · reach  px (lift: how far
    //   the thing may be from you) · secs  how long it lasts · pull, vmax  how hard the thing is drawn to the pointer (px a tick) · throwV  its speed thrown · walk  px a second
    closewounds: { name: 'Close wounds', school: 'life', form: 'self', tier: 0, cd: 10, stance: 'raise', kind: 'heal', learn: 3, hp: 3, closeMs: 700, gap: 350, ms: 2600,
      plain: { keys: [U, D, U, D], rune: [7, 4, 1, 0] } },
    lift: { name: 'Lift and throw', school: 'force', form: 'shaping', tier: 0, cd: 3, stance: 'level', kind: 'lift', learn: 3, reach: 320, secs: 10, pull: 0.16, vmax: 11, throwV: 12,
      plain: { keys: [R, R, U, L], rune: [3, 4, 5, 2] } },
    double: { name: 'A double of you', school: 'illusion', form: 'self', tier: 1, cd: 12, stance: 'raise', kind: 'double', learn: 5, secs: 60, secsWalk: 6, walk: 150, jump: 420, alts: ['double_m'],
      plain: { keys: [L, U, R, D, D], rune: [2, 0, 6, 7, 8] } },
    // ⭐ 4b (2026-11-18, Trello #711): THE MIRROR DOUBLE — the double's variant (one mark changed, as the light orb's: On yourself → Placed; plain: the last key up). It comes out
    //   on you and moves with YOUR movement LEFT ↔ RIGHT SWAPPED (jumps as they are) while you move freely — never steered; it bursts as the double does; `secs`.
    //   mirror  moves as your mirror image (client 16zj `magicDoubleSimStep`)
    double_m: { name: 'A mirror double', school: 'illusion', form: 'placed', tier: 1, cd: 12, stance: 'raise', kind: 'double', alt: 'double', mirror: true, secs: 60,
      plain: { keys: [L, U, R, D, U], rune: [2, 0, 6, 7, 4] } },
    // ⭐ 4d (2026-11-18, kickoff §ROUND 4 — CHANNELLING, the user agreed the proposal): A HELD SPELL. `chan` = it goes on while the fire button is held (you stand still, aiming with
    //   the pointer), letting go ends it at once; `chanS` = the most it can be held, seconds (0 = for as long as you hold it — the server still ends it after a minute); its cooldown
    //   counts from when it ends; a blow of 1 health breaks it. FLAME STREAM: the flamethrower's jet (16b `drawFlameJetPts`) from the catalyst towards the pointer — `reach` px,
    //   stopped by rock, fizzling in liquid; `hw` its half width; it sets alight what it touches (each player's own game for their body, as a turret's jet), the ground at its end
    flamestream: { name: 'Flame stream', school: 'fire', form: 'stream', tier: 0, cd: 4, stance: 'level', kind: 'stream', learn: 3, chan: true, chanS: 5, reach: 120, hw: 7,
      plain: { keys: [U, R, D, D, R], rune: [6, 0, 4, 8, 5] } },
    // ⭐ 4e (2026-11-18, kickoff §ROUND 4 — ON YOURSELF / ON ANOTHER, from the powerups' timed effects): kind 'boon' gives the powerup `pw` for `secs` seconds through the same
    //   grant a pickup uses (client 16a `powerGrant`) — each player's own game holds their own, everybody sees it by the powers' mask on the position packet. On yourself = the
    //   form 'On yourself'; ON ANOTHER = its variant with 'Touch' (`other`): the player nearest your pointer within `reach` px of you (the server checks they are there).
    //   CHILL BOLT: a frost bolt that SLOWS whoever it hits (`slow` × their speed for `slowS` s — the new 'slow' power, 01_state `POWERUP_KINDS.slow`).
    leap: { name: 'Leap', school: 'force', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'boon', pw: 'boots', secs: 20, learn: 3, alts: ['leap_o'], plain: { keys: [R, U, U, D, R], rune: [6, 4, 2, 5, 8] } },
    leap_o: { name: 'Leap (on another)', school: 'force', form: 'touch', tier: 0, cd: 8, stance: 'level', kind: 'boon', pw: 'boots', secs: 20, alt: 'leap', other: true, reach: 240, plain: { keys: [R, U, U, D, L], rune: [6, 4, 2, 5, 3] } },
    feather: { name: 'Feather fall', school: 'storm', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'boon', pw: 'feather', secs: 20, learn: 3, alts: ['feather_o'], plain: { keys: [L, R, D, D, U], rune: [0, 4, 8, 7, 6] } },
    feather_o: { name: 'Feather fall (on another)', school: 'storm', form: 'touch', tier: 0, cd: 8, stance: 'level', kind: 'boon', pw: 'feather', secs: 20, alt: 'feather', other: true, reach: 240, plain: { keys: [L, R, D, D, R], rune: [0, 4, 8, 7, 4] } },
    haste: { name: 'Haste', school: 'space', form: 'self', tier: 0, cd: 10, stance: 'raise', kind: 'boon', pw: 'speed', secs: 15, learn: 3, alts: ['haste_o'], plain: { keys: [R, R, R, D, L], rune: [3, 5, 2, 0, 1] } },
    haste_o: { name: 'Haste (on another)', school: 'space', form: 'touch', tier: 0, cd: 10, stance: 'level', kind: 'boon', pw: 'speed', secs: 15, alt: 'haste', other: true, reach: 240, plain: { keys: [R, R, R, D, R], rune: [3, 5, 2, 0, 4] } },
    grow: { name: 'Grow', school: 'alteration', form: 'self', tier: 1, cd: 12, stance: 'raise', kind: 'boon', pw: 'mega', secs: 15, learn: 5, alts: ['grow_o'], plain: { keys: [U, L, U, R, U], rune: [7, 3, 1, 5, 7] } },
    grow_o: { name: 'Grow (on another)', school: 'alteration', form: 'touch', tier: 1, cd: 12, stance: 'level', kind: 'boon', pw: 'mega', secs: 15, alt: 'grow', other: true, reach: 240, plain: { keys: [U, L, U, R, D], rune: [7, 3, 1, 5, 4] } },
    shrink: { name: 'Shrink', school: 'decay', form: 'self', tier: 1, cd: 12, stance: 'raise', kind: 'boon', pw: 'mini', secs: 15, learn: 5, alts: ['shrink_o'], plain: { keys: [D, R, D, L, D], rune: [1, 5, 7, 3, 4] } },
    shrink_o: { name: 'Shrink (on another)', school: 'decay', form: 'touch', tier: 1, cd: 12, stance: 'level', kind: 'boon', pw: 'mini', secs: 15, alt: 'shrink', other: true, reach: 240, plain: { keys: [D, R, D, L, U], rune: [1, 5, 7, 3, 0] } },
    fireward: { name: 'Fire ward', school: 'wards', form: 'self', tier: 0, cd: 10, stance: 'raise', kind: 'boon', pw: 'fireproof', secs: 20, learn: 3, alts: ['fireward_o'], plain: { keys: [L, D, R, U, U], rune: [0, 6, 8, 2, 4] } },
    fireward_o: { name: 'Fire ward (on another)', school: 'wards', form: 'touch', tier: 0, cd: 10, stance: 'level', kind: 'boon', pw: 'fireproof', secs: 20, alt: 'fireward', other: true, reach: 240, plain: { keys: [L, D, R, U, L], rune: [0, 6, 8, 2, 1] } },
    chillbolt: { name: 'Chill bolt', school: 'frost', form: 'bolt', tier: 0, cd: 4, stance: 'level', kind: 'bolt', learn: 3, speed: 640, life: 1.1, grav: 0.05, r: 3, dmg: 0.4, slow: 0.55, slowS: 4, freezeN: 2, freezeS: 20,
      plain: { keys: [D, D, R, U, R], rune: [2, 4, 3, 6, 7] } },
    // ⭐ STEP 5a (2026-11-18 — EARTH, the user: 'all the spells should go in'; 'how the earth spells change the world sound right': moved / changed matter STAYS, made matter goes).
    //   kind 'change': a SHOT (as freeze: flies from the hand, ends on the first rock — lava to rock in the first liquid, `inLiq`) that CHANGES THE GROUND where it lands, from
    //   the nearest cell it works on (within 3 cells) outward through the touching ones, ring by ring (`ringMs`), at most `cells` (server `magicChange`). For good — the matter
    //   is changed, not made (a cell for a cell). `map` = what becomes what (cell ids) · `lava` + `to` = lava (a cell at least a third full of lava alone) becomes `to` ·
    //   `mend` = the damage taken out of rock (its strength and its cracks — wood and plants not) · `oil` = GREASE: that many cells of oil as a film (`film` of a cell each) on the
//   rock it hit — floor, wall or ceiling (the open cells touching rock nearest it, within `oilR`),
    //   MADE (so it dries away after `secs`, as much as was poured, from round where it was — `dryR` cells). `fx` the shot's and the change's colour.
    crumble: { name: 'Rock to sand', school: 'earth', form: 'burst', tier: 0, cd: 5, stance: 'level', kind: 'change', learn: 3, reach: 420, cells: 24, ringMs: 60, speed: 620, life: 1.3, grav: 0.04, r: 3.5, fx: '#e6cb86', look: 'sand',
      map: { 2: 3, 19: 3, 22: 3, 23: 3, 24: 3, 25: 3, 26: 3, 33: 3, 43: 3, 44: 3, 45: 3, 76: 3, 77: 3, 79: 3, 80: 3, 81: 3, 89: 3 }, plain: { keys: [D, U, L, D, D], rune: [0, 3, 4, 7, 6] } },
    harden: { name: 'Sand to rock', school: 'earth', form: 'burst', tier: 0, cd: 5, stance: 'level', kind: 'change', learn: 3, reach: 420, cells: 30, ringMs: 60, speed: 620, life: 1.3, grav: 0.04, r: 3.5, fx: '#a08868', look: 'rock',
      map: { 3: 25, 21: 89, 38: 44, 39: 89, 8: 4, 5: 19 }, plain: { keys: [D, U, L, U, U], rune: [6, 3, 4, 1, 0] } },
    glassify: { name: 'Sand to glass', school: 'earth', form: 'burst', tier: 0, cd: 6, stance: 'level', kind: 'change', learn: 3, reach: 420, cells: 20, ringMs: 70, speed: 620, life: 1.3, grav: 0.04, r: 3.5, fx: '#bfe6ea', look: 'glass',
      map: { 3: 16 }, plain: { keys: [D, U, D, L, R], rune: [8, 5, 4, 3, 0] } },
    coollava: { name: 'Lava to rock', school: 'earth', form: 'burst', tier: 0, cd: 6, stance: 'level', kind: 'change', learn: 3, reach: 420, cells: 30, ringMs: 60, speed: 620, life: 1.3, grav: 0.04, r: 3.5, fx: '#ff9a4a', look: 'cool',
      lava: true, to: 23, inLiq: true, plain: { keys: [D, U, D, R, U], rune: [2, 5, 4, 7, 8] } },
    mend: { name: 'Mend rock', school: 'earth', form: 'burst', tier: 0, cd: 6, stance: 'level', kind: 'change', learn: 3, reach: 420, cells: 60, ringMs: 50, speed: 620, life: 1.3, grav: 0.04, r: 3.5, fx: '#d9c08a', look: 'mend',
      mend: true, plain: { keys: [D, U, U, L, U], rune: [6, 7, 4, 1, 2] } },
    grease: { name: 'Grease', school: 'earth', form: 'burst', tier: 0, cd: 6, stance: 'level', kind: 'change', learn: 3, reach: 420, oil: 3, film: 0.5, oilR: 6, secs: 60, dryR: 30, speed: 620, life: 1.3, grav: 0.04, r: 3.5, fx: '#caa12a', look: 'oil',
      plain: { keys: [D, U, U, R, D], rune: [0, 1, 4, 5, 8] } },
    // ⭐ STEP 5b (2026-11-18 — EARTH, THE THROWS; the user: the chunk 'should come from pulling actual terrain near the pointer … then I guess you could move it around and such, and
    //   then releasing it would shoot it in the direction it is pointing away from the player'). kind 'chunk', HELD (`chan`, `chanS` the most): the cast TEARS up to `cells` of the
    //   ground nearest the pointer (within `grab` cells; the pointer within `reach` of you) out of the world (server `magicChunkTear` — moved, not made); while the fire button is
    //   held it floats to your pointer (no further than `reach` from you, `holdV` px/s, stopped by rock); FIRE AGAIN (5b round 2, the user: 'press right click again to fire') and
//   it flies AWAY FROM YOU (from your middle through it) at
    //   `speed` px/s under `grav` until it meets something (`life` only a safety cap); time up / a blow / the cast let go DROPS it. Where it strikes, it and what it struck are CRACKED by
//   how hard (`dent` the most wear, at full speed). ROCK CHUNK: hard ground (not what a spade digs) — it hurts whoever it hits by its weight (`dmg` a
    //   cell, at most 4; `kn` its knock a cell) and breaks into its own cells where it comes down (server `magicPileAt`). SOIL FLUNG (`soil`): only what a spade digs — let go it
    //   SPRAYS out as grains (`fan` radians) that land as ground (the spade's throw: `powder-fly`).
    rockchunk: { name: 'Rock chunk', school: 'earth', form: 'shaping', tier: 0, cd: 6, stance: 'level', kind: 'chunk', learn: 3, chan: true, chanS: 10, reach: 320, grab: 3, cells: 9, holdV: 520, speed: 520, grav: 0.35, life: 20, dmg: 0.35, kn: 0.7, dent: 34, breakThrowV: 150, breakV: 230, fx: '#c9a26a', look: 'tear',
      plain: { keys: [D, U, L, R, R], rune: [6, 3, 4, 5, 8] } },
    soilfling: { name: 'Soil flung', school: 'earth', form: 'shaping', tier: 0, cd: 4, stance: 'level', kind: 'chunk', soil: true, learn: 3, chan: true, chanS: 10, reach: 320, grab: 3, cells: 12, holdV: 560, speed: 640, fan: 0.12, fx: '#b89060', look: 'tear',
      plain: { keys: [D, U, L, L, D], rune: [0, 3, 6, 7, 8] } },
    // ⭐ STEP 5c (2026-11-19 — EARTH: THE TUNNEL AND THE QUAKE; the user's answers: the bored rock comes out of the mouth as rubble · the quake on the ground UNDER THE CATALYST, a staff's
    //   foot slammed down 'like a "you shall not pass" type action' · the worst cracked cells and weakly held overhangs shaken loose). Matter MOVED or CHANGED, never made or lost.
    //   TUNNELLING BOLT, kind 'tunnel': a SHOT (as the ground-changing ones: it flies at `speed`, `life` s, and ends on the first rock — stopped by liquid); where it lands the server
    //   BORES on along its way (server `magicTunnel`): a step every half cell (`stepMs` apart, the drill seen going in), every cell within `bore` cells of its line taken out, each
    //   costing its rock's strength (1 earth … 4 granite) of `push`; no further than `len` cells, stopped by rock nothing breaks, liquid, an object, or `air` cells of open air.
    //   What it takes SPRAYS BACK OUT OF THE MOUTH as rubble (`rubbleV` cells/s, `fan` radians either side): hard rock as scree (crushed), soft ground as itself — the spade's throw.
    //   QUAKE, kind 'quake': cast at the ground under the catalyst's tip (server `magicGroundAt`), `slamMs` after the cast (the staff's foot coming down — 16zj `magicSlamPose`). From
    //   there ring by ring (`ringMs` a cell), within `rad` cells, every rock cell CRACKS by `crack` (of 60) at the middle, less outward (kept wear, as a blow's); a cell then at
    //   `looseW` or more, or hanging with open air under it and at most one rock neighbour, SHAKES LOOSE: touching ones together as a loose BOULDER (5b's, up to `clump` cells),
    //   a cell alone as falling scree — at most `loose` cells a cast. Every screen: the rumble, the view shaken (`shake`, by distance), dust off faces, loose things and bodies jolted
    //   (`kn`); the caster's own body is not jolted.
    tunnelbolt: { name: 'Tunnelling bolt', school: 'earth', form: 'bolt', tier: 0, cd: 6, stance: 'level', kind: 'tunnel', learn: 3, reach: 480, speed: 680, life: 1.4, grav: 0, r: 3.5,
      push: 34, len: 40, bore: 1.05, stepMs: 30, air: 4, rubbleV: 22, fan: 0.45, fx: '#e2b878', look: 'bore', plain: { keys: [D, U, R, R, R], rune: [3, 4, 5, 2, 1] } },
    quake: { name: 'Quake', school: 'earth', form: 'burst', tier: 0, cd: 10, stance: 'level', kind: 'quake', learn: 3, rad: 9, crack: 34, looseW: 52, ringMs: 55, loose: 30, clump: 9,
      slamMs: 260, shake: 5, kn: 4, fx: '#d8b07a', look: 'quake', plain: { keys: [D, U, D, D, D], rune: [6, 3, 0, 1, 2] } },
    // ⭐ STEP 5d (2026-11-19 — EARTH, MADE MATTER: it goes; the user agreed the proposal and its picks — the spikes a line along the ground, the pillar SINKS back, the bridge
    //   follows the line to the pointer). All three grow as the stone wall does (server `magicWallLines`: the ground's own rock, through liquid pushing it aside, kept in the
    //   database, cracking over `crackS` before `secs` is up, then going `crumbleMs` a cell from the far end). What it does to bodies is each player's own game's (16zj).
    //   STONE SPIKES, kind 'spikes': a line of `n` along the ground from `first` cells past the ground under the catalyst's tip (5d round 2) towards the pointer, `gap` cells apart, each on the ground there (up or down
    //     `step` cells at most); (round 3, the user's pick D: 'only an attack') a spike is a DRAWN needle, not cells — `high` cells tall, `base` cells either side at its foot,
    //     its seams lit as it bursts, `warnMs` after the cast and `waveMs` after the one before (its spot bulges first); its real shape rising into a body: `dmg` health, thrown
    //     up `kn`, once a cast; it stands `secs`, then breaks into chips and dust.
    //   RISING PILLAR, kind 'pillar': `wide` columns out of the ground under YOU (5d round 2, the user: under the pointer it was the stone wall again), `high` tall, a row every `rowMs` — whoever stands on it rides it up; a
    //     resting loose thing on it is hopped up (it waits `waitN` ticks for it); `secs`, then it SINKS back a row every `crumbleMs` (`sink`: no cracks, no rubble).
    //   BRIDGE, kind 'bridge': from the edge in front of your feet towards the pointer, `thick` cells deep, its top level with your ground, along the line to the pointer (slope at
    //     most `slope`: 1 = 45°), `len` columns, `rowMs` a column; rock it meets ends it (joined). `skip` = how far the ground may go on before it begins.
    spikes: { name: 'Stone spikes', school: 'earth', form: 'trail', tier: 0, cd: 6, stance: 'level', kind: 'spikes', learn: 3, n: 5, first: 0, gap: 4, step: 3, high: 6.5, base: 1.1, warnMs: 140, waveMs: 70,
      secs: 4, dmg: 1.5, kn: 7, fx: '#d9b27a', look: 'spike', plain: { keys: [D, U, U, D, U], rune: [6, 4, 8, 5, 2] } },
    pillar: { name: 'Rising pillar', school: 'earth', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'pillar', learn: 3, wide: 3, high: 16, rowMs: 90, waitN: 12, secs: 30, crackS: 0, crumbleMs: 90, sink: true,
      thruLiq: true, warnMs: 300, fx: '#d9b27a', look: 'pillar', plain: { keys: [D, U, D, U, U], rune: [8, 7, 4, 1, 2] } },
    bridge: { name: 'Bridge', school: 'earth', form: 'shaping', tier: 0, cd: 8, stance: 'level', kind: 'bridge', learn: 3, len: 32, thick: 2, slope: 1, skip: 12, rowMs: 40, secs: 40, crackS: 4, crumbleMs: 30,
      thruLiq: true, fx: '#d9b27a', look: 'bridge', plain: { keys: [D, U, R, L, R], rune: [3, 4, 5, 8, 6] } },
    // ⭐ STEP 6a (2026-11-19 — FIRE; kickoff §'STEP 6', the user agreed the set and picked the fireball's look 3A: a swelling ball that rolls up into smoke).
    //   FIREBALL, kind 'bolt' with a `burst`: a slow heavy ball of flame (`speed`, `life`, `grav`, `r` as a bolt's) that BURSTS on the first thing it touches — the ground, a
    //     player, a loose thing, liquid — or in the air when its flight ends. `burst.r` px: everything that burns there catches (server `magicFireBurst` — round, only what the
    //     blast reaches), and on every screen its own body: thrown out (`burst.f`, a small bomb's push), up to `burst.dmg` health at the middle, alight; the caster's game throws
    //     the loose things and the dummy, flings the liquid, sets off bombs and barrels. No hole (the user: fire burns, bombs dig). Into liquid: a burst of steam — nothing lit,
    //     no one alight, half the blow. Its direct hit is no extra blow (the burst is the blow).
    //   KINDLE, kind 'kindle': no shot — the spot under the pointer (`reach` px, short of the first rock on the way) catches: what burns there (server `igniteBox`), a player
    //     standing on it (alight, no blow), a bomb's fuse. A thread of sparks from the catalyst's tip to it, a flare there.
    fireball: { name: 'Fireball', school: 'fire', form: 'burst', tier: 1, cd: 8, stance: 'level', kind: 'bolt', learn: 5, uses: [['ember_salt', 1]], speed: 430, life: 1.6, grav: 0.16, r: 6,
      dmg: 0, burn: true, burst: { r: 64, dmg: 2.5, f: 14 }, plain: { keys: [U, D, R, U, D], rune: [6, 1, 5, 3, 8] } },
    kindle: { name: 'Kindle', school: 'fire', form: 'placed', tier: 0, cd: 2, stance: 'level', kind: 'kindle', learn: 3, reach: 400, fx: '#ffb060',
      plain: { keys: [U, R, U, L, U], rune: [6, 5, 1, 3, 2] } },
    // ⭐ 6b (2026-11-19, kickoff §'STEP 6' — the user's picks): WALL OF FIRE, kind 'firewall', two variants (`alt`, as the light orb's): lobbed as the stone wall's stone (`speed`,
    //   `life`, `grav`, `r`) — it goes OUT in liquid (steam) — and where it comes down on the ground a wall of flame stands `secs`: the CURTAIN `wide` × `high` cells upright, the
    //   STRIP along the ground. Not solid: whoever touches it catches fire (each game its own body — the caster's too), what burns where it stands catches (server `igniteBox`),
    //   moving wooden things and bomb fuses touching it catch (the caster's game). Liquid reaching its foot puts it out.
    //   FLAME RING, kind 'firering': cast, then flames ORBIT you (`n` of them, `orbit` × your radius out, a turn every `turnS` s) for `secs`, in depth (behind you on the far side).
    //   Whoever ELSE they touch catches fire; the ground they brush catches (the caster's game says where — server `magic-fire-at`); you are untouched. A flame in liquid goes out.
    //   FLAME PILLARS, kind 'pillars', HELD (`chan`, `chanS` the most), held as any held spell (the upright catalyst was tried and taken out, the user 2026-11-19): pillars of flame (`high` px, ± `highJ`) shoot up out of the
    //   ground either side of you in a random pattern (the same on every screen — from the cast's id), one every `gapMs`, `near`–`far` px from you; whoever stands in one is
    //   flung up (`lift`) and set alight, a loose thing thrown up, the ground at its foot lit (`magic-chan-burn`). A foot in liquid: a burst of steam.
    firewall: { name: 'Wall of fire', school: 'fire', form: 'placed', tier: 1, cd: 10, stance: 'level', kind: 'firewall', learn: 5, reach: 360, secs: 8, wide: 3, high: 12, speed: 560, life: 3, grav: 0.35, r: 4.5, alts: ['firestrip'],
      plain: { keys: [U, L, R, L, R], rune: [6, 7, 5, 3, 1] } },
    firestrip: { name: 'Wall of fire (along the ground)', school: 'fire', form: 'placed', tier: 1, cd: 10, stance: 'level', kind: 'firewall', alt: 'firewall', reach: 360, secs: 8, wide: 12, high: 5, speed: 560, life: 3, grav: 0.35, r: 4.5,
      plain: { keys: [U, L, R, L, D], rune: [6, 7, 5, 3, 0] } },
    flamering: { name: 'Flame ring', school: 'fire', form: 'self', tier: 0, cd: 14, stance: 'raise', kind: 'firering', learn: 3, secs: 12, n: 5, orbit: 1.9, turnS: 1.5, fr: 6,
      plain: { keys: [U, D, D, L, R], rune: [6, 3, 1, 5, 8] } },
    flamepillars: { name: 'Flame pillars', school: 'fire', form: 'stream', tier: 1, cd: 8, stance: 'raise', kind: 'pillars', learn: 5, chan: true, chanS: 6, reach: 140, gapMs: 190, near: 34, far: 120, high: 120, highJ: 34, hw: 8, lift: 9,
      plain: { keys: [U, D, U, D, U], rune: [6, 4, 0, 5, 2] } },
    // ⭐ 6c (2026-11-19, kickoff §'STEP 6'): HEAT, kind 'heat', HELD (`chanS` the most): a cone (`half` its half-angle, `reach` px) from the catalyst's tip that reaches out from the hand
    //   (`growMs` to full) — snow and ice in it turn to water, nearest first (the freeze spell's ice back to the water it was), `melt` cells a tick at most; a player in it is thawed
    //   (frozen into ice, a frost flask's freeze) and a chill bolt's slow ends; it lights nothing. Seen as a SHIMMER (what is behind it wavers — no lines), steam where it melts.
    //   FLAMING WEAPON, kind 'flameblade': the weapon in your OTHER hand (`wpn`, the caster's game says which; none: refused) burns `secs`: its hits set alight, what it brushes
    //   that burns catches (server `magic-blade-burn`), torch light; everybody sees it. In liquid its flames are out until it comes out.
    heat: { name: 'Heat', school: 'fire', form: 'stream', tier: 0, cd: 6, stance: 'level', kind: 'heat', learn: 3, chan: true, chanS: 10, reach: 140, half: 0.42, growMs: 2500, melt: 16,
      plain: { keys: [U, L, U, L, R], rune: [6, 3, 2, 7, 0] } },
    flameblade: { name: 'Flaming weapon', school: 'fire', form: 'self', tier: 1, cd: 20, stance: 'raise', kind: 'flameblade', learn: 5, secs: 30,
      plain: { keys: [U, R, U, R, D], rune: [6, 1, 2, 4, 8] } },
    // ⭐ STEP 7a (2026-11-20, kickoff §'STEP 7' — FROST AND WATER; the user took every suggestion).
    //   ICE SHARD, kind 'shard': a REAL OBJECT (server/held.js `iceshard`, an arrow's kind) made at the catalyst's tip by its caster's game and flown as an arrow is (16w's flight):
    //   it sticks where it meets something, wounds (`dmg`), bleeds, a shield stops it. MADE matter, so it MELTS — gone after `secs` (the server's), dripping as it goes. Never an item.
    //   `speed` px a step (as the bow's), `grav` × the bow's fall.
    //   FROST PATH, kind 'frostpath': from the caster's feet towards the pointer, `len` columns along the ground (up or down `step` cells a column at most), a column every `colMs`:
    //   the ground's TOP CELL TURNED TO ICE (slippery — ice's own `slip`) for `secs`, then back to what it was (server kind 'glaze'); a water surface on the way frozen as the freeze
    //   does. Never ore, plants, wood or a loose thing's cells.
    iceshard: { name: 'Ice shard', school: 'frost', form: 'bolt', tier: 1, cd: 5, stance: 'level', kind: 'shard', learn: 5, speed: 34, grav: 0.8, dmg: 2, secs: 20,
      plain: { keys: [D, R, R, D, U], rune: [0, 4, 5, 8, 6] } },
    frostpath: { name: 'Frost path', school: 'frost', form: 'trail', tier: 0, cd: 6, stance: 'level', kind: 'frostpath', learn: 3, len: 22, step: 3, drop: 6, colMs: 32, secs: 30, fx: '#d8f4ff', look: 'frost',
      plain: { keys: [D, L, L, D, R], rune: [2, 4, 3, 6, 8] } },
    // ⭐ STEP 7b (2026-11-20): SHAPE WATER, kind 'waterball' (held, as the rock chunk is held): REAL LIQUID near the pointer (within `grab` cells — any but lava, at most `cells` cells'
    //   worth) drawn up into a ball; it follows the pointer (`reach`, `holdV`); a SECOND CLICK throws it away from you (`speed`, `grav`); where it meets something it BURSTS into the
    //   world's own drops and lands as liquid. A player it meets is shoved (`kn`), put out and rinsed (oil in it coats them instead). Let go / its time: it falls as it is. Nothing made or lost.
    //   WATER JET, kind 'jet' (held, `chanS` the most): water MADE at the catalyst's tip, `ups` units a second flown out as the world's own drops (`dropV` cells a second) along the aim;
    //   whoever is in the stream (`reach`, `hw`) is pushed (`push`), put out and rinsed; loose things pushed. MADE, so as much as was made dries away `drySecs` after it ends.
    //   `wet` = what it hits is put out and rinsed (16zj `magicOnHit`).
    shapewater: { name: 'Shape water', school: 'frost', form: 'shaping', tier: 0, cd: 4, stance: 'level', kind: 'waterball', learn: 3, chan: true, chanS: 10, reach: 320, grab: 3, cells: 3, holdV: 560, speed: 620, grav: 0.35, kn: 4.5, wet: true, fx: '#7fd0ff',
      plain: { keys: [D, U, L, R, D], rune: [6, 3, 1, 2, 5] } },
    waterjet: { name: 'Water jet', school: 'frost', form: 'stream', tier: 0, cd: 5, stance: 'level', kind: 'jet', learn: 3, chan: true, chanS: 6, reach: 150, hw: 5, ups: 60, dropV: 34, jetR: 4, push: 40, drySecs: 60, wet: true,
      plain: { keys: [D, R, D, R, U], rune: [0, 3, 4, 8, 7] } },
    // ⭐ STEP 7c (2026-11-20): RAIN CLOUD / SNOW CLOUD, kind 'cloud', two variants (`alt`, as the walls of fire): a cloud forms ON the pointer (`reach`; its underside `down` cells below it),
    //   `wide` cells across, for `cloudS` s (not shortened by the testing dial — it is the spell, not a world change). RAIN: water MADE — `ups` units a second fall from its underside as
    //   the world's own drops (`dropV` cells a second down, drawn `dropR` px round); burning ground where they land goes out, a burning player they touch is put out and rinsed;
    //   as much as was made dries away `drySecs` after it ends (the jet's way). SNOW: `cps` grains a second of real SNOW fall slowly (`flakeG` cells/s² down, `flakeD` sideways
    //   drag) and land as snow cells (deep snow slows you — snow's own `sink`); each MELTS AWAY `meltSecs` after the cloud ends (kept in the database, as the freeze's ice).
    //   COLD SNAP, kind 'coldsnap' (tier 1): a burst round you — the water within `rad` px turns to ice outward from you, ring by ring (`ringMs` a cell), as the freeze does (back
    //   to water after `secs`); burning ground there goes out; every OTHER player within reach (nothing solid between) is frosted and held still `hold` s and put out, as the frost
    //   flask does; a frost crust lies on the ground it reached for `crustS` s. You are untouched.
    raincloud: { name: 'Rain cloud', school: 'frost', form: 'placed', tier: 0, cd: 10, stance: 'level', kind: 'cloud', learn: 3, reach: 360, cloudS: 8, wide: 14, down: 3, ups: 40, dropV: 6, dropR: 1.1, drySecs: 60, alts: ['snowcloud'], fx: '#9fd2f4',
      plain: { keys: [D, U, L, U, L], rune: [6, 4, 1, 0, 3] } },
    snowcloud: { name: 'Snow cloud', school: 'frost', form: 'placed', tier: 0, cd: 10, stance: 'level', kind: 'cloud', alt: 'raincloud', snow: true, reach: 360, cloudS: 8, wide: 14, down: 3, cps: 8, flakeG: 4, flakeD: 1.2, meltSecs: 60, fx: '#eef7ff', look: 'melt',
      plain: { keys: [D, U, L, U, R], rune: [6, 4, 1, 2, 5] } },
    // ⭐ STEP 7d (2026-11-20): ICE WALL, kind 'wall' (the stone wall's: lobbed, a wall `wide` × `high` where it lands, or level out of a rock face), MADE OF ICE (`mat` 4 —
    //   slippery), `melts`: when its time is up it MELTS away from the top, `meltMs` a cell — no rubble, no water left. Like all ice it falls straight down when nothing
    //   holds it, and its cells take their melt with them. (The ICE STEP was built and taken out, the user 2026-11-20: too much like the spells that already turn water
    //   to ice and help you cross it — server commit 'Magic 7d' has it.)
    icewall: { name: 'Ice wall', school: 'frost', form: 'placed', tier: 1, cd: 8, stance: 'level', kind: 'wall', learn: 5, reach: 360, secs: 30, crackS: 0, wide: 2, high: 12, rowMs: 55, crumbleMs: 45, thruLiq: true, speed: 560, life: 3, grav: 0.35, r: 4.5,
      mat: 4, melts: true, fx: '#cfefff', look: 'icemelt', plain: { keys: [D, R, L, R, U], rune: [2, 5, 4, 6, 3] } },
    coldsnap: { name: 'Cold snap', school: 'frost', form: 'burst', tier: 1, cd: 12, stance: 'raise', kind: 'coldsnap', learn: 5, rad: 96, cells: 220, ringMs: 22, secs: 30, hold: 1.5, crustS: 8, fx: '#cfefff',
      plain: { keys: [D, L, U, R, D], rune: [8, 4, 3, 1, 5] } },
    // ⭐ STEP 8a (2026-11-20, STORM — kickoff §'STEP 8'): LIGHTNING, kind 'zap': an instant jagged strike from the tip towards the pointer, `reach` px, stopped by the first rock,
    //   liquid or body on the way (the caster's game traces it); it JUMPS on to `jumps` more bodies within `jumpR` px (× `metalK` for one wearing plate or mail — they are found
    //   first), each jump `jumpK` of the blow. `dmg` health + `stunMs` of stun to whom it strikes (× `metalHurtK` in metal). IN LIQUID that conducts (water, brine, acid — not oil or
    //   lava) the charge runs through the touching liquid, at most `liqCells`, and shocks everybody in it for `liqDmg` (the caster too); into a METAL ORE vein it runs along it,
    //   at most `oreCells`, shocking whoever touches it. What burns where it ends catches.
    lightning: { name: 'Lightning', school: 'storm', form: 'bolt', tier: 0, cd: 3, stance: 'level', kind: 'zap', learn: 3, reach: 280, jumps: 2, jumpR: 70, metalK: 1.6, jumpK: 0.6, dmg: 1.5, metalHurtK: 1.5, stunMs: 350,
      liqCells: 700, liqDmg: 1, oreCells: 160, fx: '#cfe0ff', plain: { keys: [L, R, R, U, R], rune: [0, 4, 2, 5, 7] } },
    // CALL LIGHTNING, kind 'skystrike': a dark thundercloud gathers ON the pointer (the rain cloud's place, `down` cells), `gatherMs` later one great strike falls straight down from
    //   it onto the first thing under it (a body within `side` px of its middle — one in metal from `side` × `metalK` — or the ground); `dmg` + alight + `stunMs`. Sand where it lands
    //   FUSES to glass (a small branching tube down into it, at most `glass` cells — for good, changed not made); liquid / ore as lightning's.
    calllightning: { name: 'Call lightning', school: 'storm', form: 'placed', tier: 1, cd: 10, stance: 'level', kind: 'skystrike', learn: 5, reach: 400, wide: 14, down: 1, gatherMs: 1800, formMs: 1200, side: 14, metalK: 1.8,
      dmg: 3, metalHurtK: 1.5, stunMs: 600, liqCells: 1000, liqDmg: 1.5, oreCells: 240, glass: 9, fx: '#cfe0ff', plain: { keys: [L, U, L, D, D], rune: [0, 1, 3, 7, 8] } },
    // ⭐ 8a ROUND 2 (2026-11-20, the user: 'a similar spell that calls more of a storm, with several clouds which all randomly shoot lightning down in the area over some period,
    //   perhaps as a channelled spell, with lesser lightning bolts also, but more of them'): THUNDERSTORM, kind 'storm', HELD (`chanS` s at most): `clouds` thunderclouds `spread` px
    //   apart over the pointer (in sight), formed over `formMs`; then while it is held EACH cloud strikes every `gapMin`–`gapMax` ms at a random spot under it — a LESSER strike
    //   (`dmg` + `stunMs`, no fire on a body, what burns on the ground catches; liquid / ore as lightning's, smaller). Its caster's game aims each (`magic-strike` with `st`).
    //   (8a round 3, the user: 'more plentiful and thick … and there should be rain as well') 5 clouds 64 px apart (a bank), each RAINING as the rain cloud does (`ups` units a
    //   second of made water, dried `drySecs` after) from when it has formed until it is let go.
    thunderstorm: { name: 'Thunderstorm', school: 'storm', form: 'stream', tier: 1, cd: 16, stance: 'level', kind: 'storm', learn: 5, chan: true, chanS: 10, reach: 400, clouds: 5, spread: 64, wide: 14, down: 1, formMs: 1400,
      ups: 26, dropV: 6, dropR: 1.1, drySecs: 60, gapMin: 500, gapMax: 1400, side: 10, metalK: 1.8, dmg: 1, metalHurtK: 1.5, stunMs: 250, liqCells: 300, liqDmg: 1, oreCells: 80, fx: '#cfe0ff', plain: { keys: [L, D, L, U, U], rune: [0, 3, 7, 5, 1] } },
    // ⭐ STEP 8b (2026-11-20, STORM — kickoff §'STEP 8'): THUNDERCLAP, kind 'clap' (a burst round you): a flash and a ring of bent air out to `rad` px; every OTHER body in it
    //   thrown back (`push`) and DAZED (`dazeMs` at the middle, less at the edge — stood dizzy, no moving or punching); GLASS within `shatterR` px shatters (pick-ups where things
    //   cost), out to `rad` it cracks (`crack` wear); loose things hop; pools splash. No harm to health.
    thunderclap: { name: 'Thunderclap', school: 'storm', form: 'burst', tier: 1, cd: 12, stance: 'raise', kind: 'clap', learn: 5, rad: 110, push: 10, dazeMs: 800, shatterR: 56, crack: 40, fx: '#e8eeff',
      plain: { keys: [L, D, R, D, L], rune: [0, 3, 1, 5, 7] } },
    // WIND SHIELD, kind 'windshield' (on yourself, `secs` s; the Touch variant on another): wind circling the body bends ARROWS, THROWN THINGS, ICE SHARDS and SPELL BOLTS that come
    //   within `R` px of it aside (turned along the wind, `k` how hard) — never its own owner's. Seen by motes and leaves circling and faint curved streaks.
    windshield: { name: 'Wind shield', school: 'storm', form: 'self', tier: 0, cd: 14, stance: 'raise', kind: 'windshield', learn: 3, secs: 12, R: 44, k: 24, alts: ['windshield_o'], fx: '#dfe8f0',
      plain: { keys: [L, R, D, L, U], rune: [0, 5, 7, 3, 1] } },
    windshield_o: { name: 'Wind shield (on another)', school: 'storm', form: 'touch', tier: 0, cd: 14, stance: 'level', kind: 'windshield', alt: 'windshield', other: true, reach: 240, secs: 12, R: 44, k: 24, fx: '#dfe8f0',
      plain: { keys: [L, R, D, L, R], rune: [0, 5, 7, 3, 4] } },
    // ⭐ (8b, FROST — the user 2026-11-20: 'we should build the blizzard in Frost also') BLIZZARD, kind 'blizzard', HELD (`chanS` s at most): `clouds` snow clouds `spread` px apart
    //   over the pointer (in sight), formed from vapour out of the staff as the thunderstorm's; once formed each SNOWS (`cps` grains a second of real snow, as the snow cloud — melted
    //   `meltSecs` after) blown by a WIND away from the caster (`wind` cells a step on each flake); under them (and `lee` px downwind) bodies are pushed by the wind (`windPush`),
    //   loose things blown, and whoever stays `frostS` s is slowed (`slow`) and put out. Let go and it ends.
    blizzard: { name: 'Blizzard', school: 'frost', form: 'stream', tier: 1, cd: 16, stance: 'level', kind: 'blizzard', learn: 5, chan: true, chanS: 10, reach: 400, clouds: 4, spread: 76, wide: 14, down: 1, formMs: 1400,
      cps: 14, flakeG: 4, flakeD: 1.2, meltSecs: 60, wind: 2.6, lee: 90, windPush: 30, frostS: 1.5, slow: 0.6, look: 'melt', fx: '#eef7ff', plain: { keys: [D, L, D, U, L], rune: [2, 5, 1, 3, 7] } },
    // ⭐ STEP 8c (2026-11-20, STORM): WHIRLWIND, kind 'whirl' (placed on the ground at the pointer, in sight; `secs` s): a funnel `high` px tall that DRIFTS along the ground away from
    //   its caster at `speed` px/s (turned back once by a wall, then it stays). It takes up the surface's loose powder (`grab` cells a tick, at most `carry` — never a spell's own snow)
    //   and liquid (at most `liq` units, not lava), and FLINGS it all back out when it ends (grains landing as ground, drops as liquid — moved, nothing made or lost); over fire it
    //   catches and becomes a FLAMING TORNADO that lights what it touches. A body it catches is lifted (`lift`) and spun round it, thrown out after `catchS` s (still steering).
    whirlwind: { name: 'Whirlwind', school: 'storm', form: 'placed', tier: 1, cd: 14, stance: 'level', kind: 'whirl', learn: 5, reach: 360, secs: 12, speed: 40, high: 150, grab: 3, carry: 90, liq: 200, liqTick: 20, throwV: 280,
      catchS: 2.6, lift: 8, turnS: 0.5, throwOut: 13, minRoom: 40, fx: '#dfe8f0', plain: { keys: [L, U, L, U, R], rune: [0, 3, 4, 1, 2] } },
    // UPDRAFT, kind 'draft' (placed, in sight; `secs` s): a column of rising air from the ground under the pointer up to `high` px (or the first rock), `wide` cells across. Bodies
    //   in it rise at `riseV` px a frame and hover near its top; leaving it near the top gives `featherS` s of feather fall. Loose things are lifted; now and then a grain of the
    //   surface's loose powder at its foot is flown up it (moved, as a throw).
    // (8c round 2, the user: 'it should be more powerful … something you could use on another player to launch them into the air, or an object'; no feather fall; it should lift
    //   liquid too) bodies and loose things in it are LAUNCHED up at `riseV` px a frame (on past its top); the liquid at its foot is thrown up it (`liq` units a tick), powder too.
    updraft: { name: 'Updraft', school: 'storm', form: 'placed', tier: 0, cd: 10, stance: 'level', kind: 'draft', learn: 3, reach: 360, secs: 8, high: 240, wide: 4, riseV: 10, grainMs: 150, liq: 6, fx: '#dfe8f0',
      plain: { keys: [L, L, U, U, R], rune: [0, 6, 3, 1, 5] } },
    // ⭐ STEP 8d (2026-11-21, STORM): BALL LIGHTNING, kind 'ball' (placed: it leaves the tip at `speed` px/s for the pointer, then wanders; `secs` s): its caster's game flies it (wind
    //   spells push it: gust, whirlwind, updraft) and every `zapMs` sends a small arc to the nearest body (metal from further), or water, within `zapR` px — `dmg` health + `stunMs`;
    //   touching a body it BURSTS (`burstDmg`, thrown back, set alight); into water it bursts and its charge runs through the water; at its end it pops (what burns there catches).
    balllightning: { name: 'Ball lightning', school: 'storm', form: 'placed', tier: 1, cd: 10, stance: 'level', kind: 'ball', learn: 5, reach: 360, secs: 8, speed: 70, wander: 26, r: 7,
      zapMs: 700, zapR: 90, metalK: 1.6, dmg: 0.75, stunMs: 250, burstDmg: 2, burstR: 40, knock: 9, metalHurtK: 1.5, liqDmg: 1, liqCells: 400, oreCells: 80, fx: '#c9d6ff',
      plain: { keys: [L, U, R, U, D], rune: [0, 4, 6, 7, 5] } },
    // LIGHTNING WEAPON, kind 'stormblade' (on yourself, `secs` s — as the flaming weapon): the weapon in your other hand crackles with charge; its hits SHOCK (`dmg`, `stunMs`,
    //   metal ×`metalHurtK`); a blow stopped on a metal blade or shield shocks its holder; dipped in liquid it empties into it (everyone in that water shocked, you too) and ends.
    stormblade: { name: 'Lightning weapon', school: 'storm', form: 'self', tier: 1, cd: 20, stance: 'raise', kind: 'stormblade', learn: 5, secs: 30, dmg: 1, stunMs: 300, metalHurtK: 1.5,
      liqDmg: 1.5, liqCells: 600, oreCells: 120, fx: '#c9d6ff', plain: { keys: [L, R, U, R, D], rune: [0, 3, 4, 2, 8] } },
    // ⭐ FROST AND WATER (the user's ideas, 2026-11-20): WHIRLPOOL, kind 'pool' (placed IN liquid at the pointer, `secs` s): stationary; the server keeps pumping the liquid from its
    //   middle out to its rim (`pump` units a tick) so its surface dips into a funnel — moved, nothing made or lost; bodies and loose things in the liquid within its reach are drawn
    //   in and carried round, and in its middle SUCKED DOWN to the bottom and held there spinning until it ends (the user: 'hold them and suck them downwards').
    whirlpool: { name: 'Whirlpool', school: 'frost', form: 'placed', tier: 1, cd: 14, stance: 'level', kind: 'pool', learn: 5, reach: 400, secs: 10, maxR: 12, minR: 3, pump: 60, pull: 2.2, turnS: 1.2, inward: 16,
      spin: 3.2, down: 5, core: 0.35, fx: '#7fd0ff', plain: { keys: [D, R, D, L, L], rune: [2, 5, 8, 7, 6] } },
    // WAVE, kind 'wave' (placed: it rises on the ground at the pointer and rolls AWAY from its caster along the terrain, `secs` s at most): REAL WATER, conjured — the server moves a
    //   mound of it (`len` cells long, `high` cells at its crest) forward `speed` px/s, taking its own water back each tick and putting it down ahead, over the ground or a pool's
    //   surface; climbs steps up to `step` cells, breaks against anything taller. Bodies and loose things are carried along and up its face, knocked down (no harm); fire under it
    //   is put out by the water; the surface's powder at its front swept along and dropped where it breaks. When it ends its water is gone (in spray and mist): nothing left.
    wave: { name: 'Wave', school: 'frost', form: 'placed', tier: 1, cd: 14, stance: 'level', kind: 'wave', learn: 5, reach: 360, secs: 4.5, speed: 130, len: 26, high: 8, step: 3, tickMs: 30,
      grab: 2, carry: 60, push: 7, lift: 5, knockMs: 350, fx: '#7fd0ff', plain: { keys: [R, U, R, D, R], rune: [6, 4, 1, 5, 8] } },
    // the innate abilities (step 1: one each, small)
    glow:  { name: 'Glow',  school: 'light', innate: true, cd: 1.5, kind: 'glow', secs: 20 },
    spark: { name: 'Spark', school: 'fire',  innate: true, cd: 1.5, kind: 'spark' },
  };
  //  cdK, powK   × every cooldown, × every spell's strength with it · innate = its own ability
  const CATALYSTS = {
    // (step 2b) the staff in ONE hand (something in the other) casts at `powK1`; in both, at `powK`
    staff: { cdK: 1.25, powK: 1.35, powK1: 1, innate: 'glow' },
    wand:  { cdK: 0.75, powK: 0.85, innate: 'spark' },
    orb:   { cdK: 1,    powK: 1,    innate: 'glow' },
  };

  // ⭐ STEP 2 (2026-11-17): TOMES, SCROLLS. A tome is an ITEM (server/items.js makes one per entry, kind 'tome'): its pages, each one spell, in order. A page may be
  //   DAMAGED — 'torn' (its lower half gone: the rune is lost), 'burnt' (its corner burnt: the end of the input and your own part are lost), 'missing' (torn out: a stub,
  //   nothing on it). Damage only hides writing: a torn or burnt page can still be learnt from by whoever works out what is missing; a missing page cannot.
  //   `cover` = its look (server/held.js `tome_<cover>`, `tome_<cover>_open`).
  const TOMES = {
    // (step 3b, the user: build the spells first, tomes and scrolls later — "a master tome for the time being that I can use … which contains all spells") every castable spell, a
    //   page each, in the table's order; a variant (`alt`) is shown on its spell's page. Filled in below, once SPELLS is known.
    tome_master: { name: 'The master tome', cover: 'master', pages: [] },
    tome_hearth: { name: 'The hearth primer', cover: 'hearth', pages: [{ spell: 'firebolt' }, { spell: 'greatbolt' }] },
    tome_wayfarer: { name: 'The wayfarer’s primer', cover: 'wayfarer', pages: [{ spell: 'gust' }, { spell: 'lightorb' }] },   // (step 3a)
    tome_scorched: { name: 'A scorched primer', cover: 'scorched', pages: [{ spell: 'firebolt', dmg: 'torn' }, { dmg: 'missing' }, { spell: 'greatbolt', dmg: 'burnt' }] },
  };
  // A SCROLL: one use, no catalyst, no input — unrolled (the starting button held), aimed, fired; it burns up as the spell leaves. Carried in a stack (item kind 'scroll').
  const SCROLLS = {
    scroll_firebolt: { name: 'Scroll of firebolt', spell: 'firebolt' },
    scroll_greatbolt: { name: 'Scroll of great firebolt', spell: 'greatbolt' },
    scroll_gust: { name: 'Scroll of gust', spell: 'gust' },
    scroll_lightorb: { name: 'Scroll of light orb', spell: 'lightorb' },
  };

  // ⭐ 4c (2026-11-18, Trello #707 — kickoff §ROUND 4): MODIFIERS, a THIRD PIECE put in after a whole spell (after its tier's ups). Learnt from tomes as spells are (a page each; your
  //   own part of it as a spell's, per world, a death forgets it). ONE a cast. It costs more keys and `cdK` × the spell's cooldown. `kinds` = the spells it goes on (their `kind`).
  //   ITS PIECE, the same in the language and plain:  keys — a DOWN that opens it (a tier adds only ups, so the two never mix), YOUR OWN KEY, then its two `keys`;
  //   rune — on to the top left point and along the TOP ROW (the tier's underline is the bottom row), YOUR OWN POINT, then its `rune` stroke.
  //   follow  the caster's game turns it towards the pointer (`turn` radians a second, up to 3 × close to it; the client's dial overrides), `speedK` its speed, `lifeK` its time, `gravK` its gravity; others are sent where it is
  //   arc     a lob that comes down on the pointer (`g` px/s² its gravity, `reach` px the farthest point) — every screen works the same arc out of the cast (`arcAim`)
  //   split   at `at` seconds it becomes `n`, `fan` degrees apart, each `dmgK` of the blow · faint  drawn at `seen` of its strength on others' screens, `seenOwn` on yours
  const MODS = {
    mod_follow: { name: 'Follows the pointer', keys: [R, L], rune: [4, 3], kinds: ['bolt'], cdK: 1.5, learn: 3, turn: 16, speedK: 0.7, lifeK: 2, gravK: 0.3 },
    mod_arc:    { name: 'Arcs', keys: [U, R], rune: [6, 4, 8], kinds: ['bolt'], cdK: 1.5, learn: 3, g: 1100, reach: 560 },
    mod_split:  { name: 'Splits in three', keys: [L, R], rune: [3, 7, 5], kinds: ['bolt'], cdK: 1.5, learn: 3, n: 3, at: 0.05, fan: 10, dmgK: 0.45 },
    mod_faint:  { name: 'Faint', keys: [D, D], rune: [6, 7], kinds: ['bolt'], cdK: 1.5, learn: 3, seen: 0.22, seenOwn: 0.5 },
  };
  const isMod = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(MODS, id);
  const modOf = (id) => isMod(id) ? MODS[id] : null;
  const modFits = (mid, spell) => { const M = modOf(mid), S = SPELLS[spell] && Object.prototype.hasOwnProperty.call(SPELLS, spell) ? SPELLS[spell] : null; return !!M && !!S && !S.innate && M.kinds.indexOf(S.kind) >= 0; };
  // ⭐ (4e round 3, 2026-11-18 — the user: 'On yourself' as a shared form forced similar spells into different schools; 'the school be the thing held static and the form part simply
  //   something unique for every spell … similar spells could be similar') A SPELL'S INPUT IN THE LANGUAGE = its SCHOOL's piece · your own key · its own WORD (`word`: two keys and a
  //   stroke from the middle, unique within its school) · an up / an underline a tier. SHARED ENDINGS kept where they mean the same in every school: a BOLT ends → → (stroke middle →
  //   right), a held STREAM → ↓ (middle → bottom right) — no other word uses them. ON ANOTHER (a Touch variant): the word's FIRST mark turned → (towards them); its stroke carries on
  //   to the top right point. Similar spells look alike: grow ← ↑, shrink ← ↓. `form` stays what the spell DOES (its kind of delivery); `word` is only how it is said.
  //   Switch back: `wordOf` falls to the old form's piece when a spell has no word (none now). Plain inputs are unchanged.
  const WORDS = {
    firebolt: [[R, R], [4, 5]], greatbolt: [[R, R], [4, 5]], flamestream: [[R, D], [4, 8]],
    fireball: [[U, D], [4, 1, 5, 7, 3, 1]], kindle: [[R, U], [4, 5, 2]],
    firewall: [[L, R], [4, 6, 0]], firestrip: [[L, D], [4, 6, 8]], flamering: [[D, D], [4, 3, 1, 5]], flamepillars: [[D, U], [4, 7, 1]], heat: [[L, U], [4, 3, 0]], flameblade: [[U, R], [4, 1, 2]],   // (6b: a wall drawn up · laid down · round you · down into the ground and up, as Earth's pillar)   // (6a: a burst's diamond, as gust / freeze · right then up — a spark sent out and lifting)
    chillbolt: [[R, R], [4, 5]], freeze: [[U, D], [1, 5, 7, 3, 1]],
    icewall: [[U, U], [4, 7]],   // (7d: a wall drawn up, as the stone wall)
    raincloud: [[U, L], [4, 1, 0]], snowcloud: [[U, R], [4, 1, 2]], coldsnap: [[D, D], [4, 3, 1, 5]], blizzard: [[L, L], [4, 1, 0, 3]],   // (8b: as the thunderstorm)   // (7c: up into the sky and off to one side or the other · round you, as the flame ring)
    iceshard: [[R, R], [4, 5]], frostpath: [[L, D], [4, 6, 8]], shapewater: [[L, R], [4, 3, 5]], waterjet: [[R, D], [4, 8]], whirlpool: [[D, R], [4, 5, 8, 7]], wave: [[R, U], [4, 1, 2, 5]],   // (7b: grab and fling, as the rock chunk · the stream ending)   // (7a: a bolt, one up for its tier, as great firebolt · laid along the ground, as the fire strip)
    gust: [[U, D], [1, 5, 7, 3, 1]], feather: [[D, U], [4, 6]], feather_o: [[R, U], [4, 6, 2]],
    lightning: [[R, R], [4, 5]], calllightning: [[U, L], [4, 1, 3, 7]], thunderstorm: [[L, L], [4, 1, 0, 3]], thunderclap: [[D, D], [4, 3, 1, 5]], windshield: [[D, L], [4, 7]], windshield_o: [[R, L], [4, 7, 2]], whirlwind: [[L, U], [4, 3, 0, 1]], updraft: [[U, U], [4, 1]], balllightning: [[D, R], [4, 7, 5]], stormblade: [[U, R], [4, 1, 2]],   // (8b: round you, as the flame ring / cold snap · the on-another turned → and on to the top right)   // (8a: the bolt ending · up into the sky, then a zigzag down)
    stonewall: [[U, U], [4, 7]],
    crumble: [[L, D], [4, 6]], harden: [[L, U], [4, 0]], glassify: [[D, L], [4, 3]], coollava: [[D, R], [4, 2]], mend: [[U, L], [4, 1]], grease: [[U, R], [4, 2, 5]],
    rockchunk: [[L, R], [4, 3, 5]], soilfling: [[L, L], [4, 6, 3]], tunnelbolt: [[R, R], [4, 5]], quake: [[D, D], [4, 7, 8]],
    spikes: [[U, D], [4, 1, 5]], pillar: [[D, U], [4, 7, 1]], bridge: [[R, L], [4, 0, 2]],   // (5d: a peak ∧ · down into the ground and up · out and across)
    lift: [[L, R], [4, 2]], leap: [[U, U], [4, 1]], leap_o: [[R, U], [4, 1, 2]],
    haste: [[L, L], [3, 5]], haste_o: [[R, L], [3, 5, 2]],
    rune: [[D, L], [4, 7]], fireward: [[U, L], [4, 6]], fireward_o: [[R, L], [4, 6, 2]],
    closewounds: [[D, D], [4, 6]],
    grow: [[L, U], [4, 1]], grow_o: [[R, U], [4, 1, 2]], shrink: [[L, D], [4, 7]], shrink_o: [[R, D], [4, 7, 2]],
    double: [[D, D], [4, 6]], double_m: [[D, L], [4, 7]],
    lightorb: [[D, L], [4, 7]], lightorb_f: [[D, D], [4, 6]],
  };
  for (const id in WORDS) if (SPELLS[id]) SPELLS[id].word = { keys: WORDS[id][0], rune: WORDS[id][1] };
  SPELLS.shrink.school = 'alteration'; SPELLS.shrink_o.school = 'alteration';   // (grow and shrink one school — the user)
  const wordOf = (S) => S.word || FORMS[S.form] || { keys: [], rune: [] };
  // (step 3h, the user: "add a contents page to the master tome … the tabs should probably just be for each school and the spells should be arranged by schools") its first page
  //   is the CONTENTS (`contents`: no spell — the client lists the schools and their spells there, each a link), then the spells school by school, in the schools' order
  //   (4e round 2, the user: 'the master tome probably needs multiple pages for the contents, rather than trying to squeeze them all onto the same page') THE CONTENTS over as many
  //   pages as it needs: its lines (a school, then its spells; the modifiers last) laid into COLUMNS — a left page holds 10 under its title, a right page 13; a school's name never
  //   ends a column — `contents` = the columns, each line with the page it is on; a contents page (`contents`, `part`) is one spread, two columns
  { const T = TOMES.tome_master, rows = [], pageOf = [];
    for (const sc of Object.keys(SCHOOLS)) { const ids = Object.keys(SPELLS).filter(id => !SPELLS[id].innate && !SPELLS[id].alt && SPELLS[id].school === sc); if (!ids.length) continue; rows.push({ school: sc }); for (const id of ids) rows.push({ spell: id }); }
    rows.push({ school: 'mods' }); for (const id of Object.keys(MODS)) rows.push({ spell: id, mod: 1 });
    const CAP = [10, 13], cols = []; let cur = [];
    for (const r of rows) { const cap = CAP[cols.length % 2]; if (cur.length >= cap || (r.school && cur.length >= cap - 1)) { cols.push(cur); cur = []; } cur.push(r); }
    if (cur.length) cols.push(cur);
    const nC = Math.max(1, Math.ceil(cols.length / 2)); for (let k = 0; k < nC; k++) T.pages.push({ contents: true, part: k });
    for (const r of rows) { if (r.school) continue; r.page = T.pages.length; T.pages.push(r.mod ? { mod: r.spell } : { spell: r.spell }); }
    for (const c of cols) for (let i = 0; i < c.length; i++) if (c[i].school) { const nx = c[i + 1] || null; c[i].page = nx ? nx.page : T.pages.length - 1; }
    T.contents = cols; }
  const is = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(SPELLS, id);
  const of = (id) => is(id) ? SPELLS[id] : null;
  // ⭐ YOUR OWN VERSION (step 2 — kickoff §'against copied inputs' 1): every spell's input = the shared core + ONE PART worked out from you and this life. The SERVER makes
  //   the number `h` (from a secret it keeps, your key, your life, the spell — server `magicOwnH`) and sends it to you; `ownOf` turns it into the part, the same way here and
  //   there: a KEY put in after the school's piece, and a POINT the rune runs through after the school's stroke. null `h` = no own part (the core alone, as in step 1).
  const ownOf = (id, lang, h) => { if (h == null || !isFinite(h)) return null; if (isMod(id)) return modOwnOf(id, h); const S = of(id); if (!S || S.innate) return null; h = Math.abs(Math.floor(h));
    const R0 = runeCore(id, lang); if (!R0) return null; const a = R0.pts.slice(0, R0.parts), b = R0.pts.slice(R0.parts), ok = [];
    for (let p = 0; p < 9; p++) { if (p === a[a.length - 1] || p === b[0]) continue; const full = a.concat([p], b); if (runeNorm(full).length === runeNorm(R0.pts).length + 1) ok.push(p); }
    return { k: h & 3, p: ok.length ? ok[(h >> 2) % ok.length] : null }; };
  // (4c) A MODIFIER'S OWN PART: a key after its opening down, and a point after the top row (one that makes its stroke one point longer, as a spell's own point does)
  const modOwnOf = (mid, h) => { const M = modOf(mid); if (!M) return null; h = Math.abs(Math.floor(h)); const L0 = runeNorm([0, 2].concat(M.rune)).length, ok = [];
    for (let p = 3; p < 9; p++) { if (p === M.rune[0]) continue; if (runeNorm([0, 2, p].concat(M.rune)).length === L0 + 1) ok.push(p); }
    return { k: h & 3, p: ok.length ? ok[(h >> 2) % ok.length] : null }; };
  // (4c) a modifier's piece alone: keys (the opening down, your own key, its two) · its rune (the top row, your own point, its stroke; `own` = where your point is)
  const modKeys = (mid, own) => { const M = modOf(mid); if (!M) return null; const k = [D]; if (own && own.k != null) k.push(own.k & 3); return k.concat(M.keys); };
  const modRune = (mid, own) => { const M = modOf(mid); if (!M) return null; const pts = [0, 2]; let o = null; if (own && own.p != null) { o = 2; pts.push(own.p); } return { pts: pts.concat(M.rune), own: o }; };
  // the keys of a spell: `lang` = school + form (+ an "up" a tier), else its plain sequence; `own` (from `ownOf`) put in after the first two. (4c) `mod` = a modifier put in after
  //   it, `modOwn` its own part · a MODIFIER's id alone = its piece alone (what its page practises)
  const keysOf = (id, lang, own, mod, modOwn) => { if (isMod(id)) return modKeys(id, own); const k0 = keysCore(id, lang, own); if (!k0 || !mod) return k0; const mk = modKeys(mod, modOwn); return mk ? k0.concat(mk) : null; };
  const keysCore = (id, lang, own) => { const S = of(id); if (!S || S.innate) return null; let k;
    if (!lang) { if (!S.plain) return null; k = S.plain.keys.slice(); }
    else { k = SCHOOLS[S.school].keys.concat(wordOf(S).keys); for (let i = 0; i < (S.tier || 0); i++) k.push(U); }
    if (own && own.k != null) k.splice(2, 0, own.k & 3);
    return k; };
  // …and its rune, as ONE path through the nine points (the school's stroke, on to the form's, then one UNDERLINE a tier — bottom left to bottom right). `parts` = where the form's
  //   stroke begins (after the own point, when there is one)
  const runeCore = (id, lang) => { const S = of(id); if (!S || S.innate) return null;
    if (!lang) return S.plain ? { pts: S.plain.rune.slice(), parts: Math.min(3, S.plain.rune.length) } : null;
    const a = SCHOOLS[S.school].rune, b = wordOf(S).rune, pts = a.concat(b[0] === a[a.length - 1] ? b.slice(1) : b);
    for (let i = 0; i < (S.tier || 0); i++) pts.push(6, 8);
    return { pts, parts: a.length }; };
  const runeSpell = (id, lang, own) => { const R0 = runeCore(id, lang); if (!R0) return null;
    if (!own || own.p == null) return R0;
    return { pts: R0.pts.slice(0, R0.parts).concat([own.p], R0.pts.slice(R0.parts)), parts: R0.parts + 1, own: R0.parts }; };
  // (4c) …with a modifier's stroke after it (`mod` = where it begins, `modOwn` = your own point in it) · a modifier alone: its stroke (`parts` 2 = the top row is its opening)
  const runeOf = (id, lang, own, mod, modOwn) => {
    if (isMod(id)) { const Q = modRune(id, own); return Q ? { pts: Q.pts, parts: 2, own: Q.own != null ? Q.own : undefined } : null; }
    const R0 = runeSpell(id, lang, own); if (!R0 || !mod) return R0; const Q = modRune(mod, modOwn); if (!Q) return null;
    return Object.assign({}, R0, { pts: R0.pts.concat(Q.pts), mod: R0.pts.length, modOwn: Q.own != null ? R0.pts.length + Q.own : null }); };
  // a path through the points with every point that lies exactly between its neighbours taken out (6 → 0 passes over 3: the same line)
  const runeNorm = (pts) => { const p = []; for (const n of pts) if (!p.length || p[p.length - 1] !== n) p.push(n);
    for (let i = 1; i < p.length - 1;) { const a = p[i - 1], b = p[i], c = p[i + 1];
      if ((a % 3) + (c % 3) === 2 * (b % 3) && Math.floor(a / 3) + Math.floor(c / 3) === 2 * Math.floor(b / 3) && a !== c) p.splice(i, 1); else i++; }
    return p; };
  const castable = () => Object.keys(SPELLS).filter(id => !SPELLS[id].innate);
  // keys so far → { spell } when they are exactly a spell's (and `more` too when a longer spell also begins with them — firebolt is the start of great firebolt) ·
  //   { more: true } while some spell still begins with them · null = wrong. `ownH(id)` = that spell's own number, or null
  //   (4c) `mods` = the modifiers that may follow (each spell is tried alone, then with each that goes on it) → also `mod` (the one put in) and `moreOf` (the spells a modifier
  //   is still being put in after) · a modifier's id in `ids` = its piece alone
  const inputsOf = (ids, mods) => { const out = []; for (const id of ids || castable()) { out.push([id, null]); if (mods && !isMod(id)) for (const m of mods) if (modFits(m, id)) out.push([id, m]); } return out; };
  const ownFor = (id, lang, ownH) => ownH ? ownOf(id, lang, ownH(id)) : null;
  const matchKeys = (seq, lang, ids, ownH, mods) => { let more = false, spell = null, mod = null; const moreOf = [];
    for (const [id, md] of inputsOf(ids, mods)) { const k = keysOf(id, lang, ownFor(id, lang, ownH), md, md ? ownFor(md, lang, ownH) : null); if (!k || k.length < seq.length) continue;
      let ok = true; for (let i = 0; i < seq.length; i++) if (k[i] !== seq[i]) { ok = false; break; }
      if (!ok) continue; if (k.length === seq.length) { if (!spell) { spell = id; mod = md; } } else { more = true; if (md && moreOf.indexOf(id) < 0) moreOf.push(id); } }
    return spell ? { spell, mod, more, moreOf } : more ? { more: true, moreOf } : null; };
  // points joined so far → the same answers. (step 2) A point just passed over on the way to the next — 8 → 6 runs over 7 — is not wrong yet: the stroke is still going
  const midOf = (a, b, c) => a !== c && (a % 3) + (c % 3) === 2 * (b % 3) && Math.floor(a / 3) + Math.floor(c / 3) === 2 * Math.floor(b / 3);
  const matchRune = (pts, lang, ids, ownH, mods) => { const p = runeNorm(pts); let more = false, spell = null, mod = null; const moreOf = [];
    for (const [id, md] of inputsOf(ids, mods)) { const R0 = runeOf(id, lang, ownFor(id, lang, ownH), md, md ? ownFor(md, lang, ownH) : null); if (!R0) continue; const k = runeNorm(R0.pts); if (k.length < p.length) continue;
      let ok = true, bad = -1; for (let i = 0; i < p.length; i++) if (k[i] !== p[i]) { ok = false; bad = i; break; }
      if (!ok) { if (bad === p.length - 1 && bad > 0 && midOf(p[bad - 1], p[bad], k[bad])) { more = true; if (md && moreOf.indexOf(id) < 0) moreOf.push(id); } continue; }
      if (k.length === p.length) { if (!spell) { spell = id; mod = md; } } else { more = true; if (md && moreOf.indexOf(id) < 0) moreOf.push(id); } }
    return spell ? { spell, mod, more, moreOf } : more ? { more: true, moreOf } : null; };
  // A RUNE DRAWN FREELY (moved here from the client in step 2, so the server checks a practice the same way): a path as `n` points evenly along it, fitted to a unit box
  //   (the longer side = 1), middle at 0,0 · how far one drawn path lies from a spell's rune, on average, as a share of its size (where and how big do not matter)
  function pathFit(flat, n) {
    const m = flat.length / 2; if (m < 2) return null;
    let len = 0; const seg = [0]; for (let i = 1; i < m; i++) { len += Math.hypot(flat[i * 2] - flat[i * 2 - 2], flat[i * 2 + 1] - flat[i * 2 - 1]); seg.push(len); }
    if (len < 1e-6) return null;
    const out = []; let j = 1;
    for (let k = 0; k < n; k++) { const d = len * k / (n - 1); while (j < m - 1 && seg[j] < d) j++; const u = (d - seg[j - 1]) / Math.max(1e-9, seg[j] - seg[j - 1]);
      out.push(flat[j * 2 - 2] + (flat[j * 2] - flat[j * 2 - 2]) * u, flat[j * 2 - 1] + (flat[j * 2 + 1] - flat[j * 2 - 1]) * u); }
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (let k = 0; k < n; k++) { x0 = Math.min(x0, out[k * 2]); x1 = Math.max(x1, out[k * 2]); y0 = Math.min(y0, out[k * 2 + 1]); y1 = Math.max(y1, out[k * 2 + 1]); }
    const s = Math.max(x1 - x0, y1 - y0, 1e-6), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (let k = 0; k < n; k++) { out[k * 2] = (out[k * 2] - cx) / s; out[k * 2 + 1] = (out[k * 2 + 1] - cy) / s; }
    out.len = len; return out;
  }
  const runeDist = (fit, id, lang, own, mod, modOwn) => { const R0 = runeOf(id, lang, own, mod, modOwn); if (!R0 || !fit) return 1e9; const flat = []; for (const p of R0.pts) flat.push(p % 3, Math.floor(p / 3));
    const T = pathFit(flat, fit.length / 2); if (!T) return 1e9; let d = 0; const n = fit.length / 2; for (let k = 0; k < n; k++) d += Math.hypot(fit[k * 2] - T[k * 2], fit[k * 2 + 1] - T[k * 2 + 1]); return d / n; };
  // a cooldown in ms with this catalyst
  const cdMs = (id, cat, mod) => { const S = of(id), C = CATALYSTS[cat], M = modOf(mod); return S ? Math.round(S.cd * 1000 * (C ? C.cdK : 1) * (M ? M.cdK || 1 : 1)) : 0; };   // (4c: × a modifier's)
  // (4c) THE LOB (the arc modifier): from x, y it comes down on tx, ty — the time by how far (never under 0.45 s), the gravity the modifier's. Every screen works out the same
  const arcAim = (S, M, x, y, tx, ty) => { const dx = tx - x, dy = ty - y, g = (M && M.g) || 1100, T = Math.max(0.45, Math.min(1.8, Math.hypot(dx, dy) / Math.max(80, ((S && S.speed) || 600) * 0.75)));
    return { vx: dx / T, vy: (dy - 0.5 * g * T * T) / T, g, T, life: T + 0.6 }; };
  // (step 3a) the spell a variant belongs to (learnt with it, its own part the same): the light orb that follows → the light orb
  const baseOf = (id) => { const S = of(id); return S && S.alt && is(S.alt) ? S.alt : id; };
  const learnN = (id) => { if (isMod(id)) return Math.max(1, MODS[id].learn || 3); const S = of(baseOf(id)); return S ? Math.max(1, S.learn || (S.tier ? 5 : 3)) : 0; };
  const tomeOf = (item) => typeof item === 'string' && Object.prototype.hasOwnProperty.call(TOMES, item) ? TOMES[item] : null;
  const scrollOf = (item) => typeof item === 'string' && Object.prototype.hasOwnProperty.call(SCROLLS, item) ? SCROLLS[item] : null;
  return { SCHOOLS, FORMS, SPELLS, CATALYSTS, TOMES, SCROLLS, MODS, is, of, isMod, modOf, modFits, arcAim, ownOf, keysOf, runeOf, runeNorm, matchKeys, matchRune, pathFit, runeDist, castable, cdMs, learnN, baseOf, tomeOf, scrollOf };
});
