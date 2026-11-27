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
    // (2026-11-23, the user: blood its own school, after Decay) the last free pair of keys; its stroke passes through no other point on the way (2 → 3 → 7), and no
    //   school starts 2 → 3. ⚠️ a TRAIL form after it would fold back (7 → 3) — no Blood spell is a trail
    blood:      { name: 'Blood',           col: '#b3121f', keys: [R, D], rune: [2, 3, 7] },
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
    lightorb_f: { name: 'Light orb (following)', school: 'light', form: 'self', aim: 'self', reach: 240, tier: 0, cd: 4, stance: 'level', kind: 'orb', alt: 'lightorb', stay: false, secs: 60, pow: 1.6, rr: 170,
      plain: { keys: [L, D, D, D], rune: [1, 4, 7, 8] } },
    // ⭐ STEP 20a (2026-11-27, kickoff §'STEP 20') LIGHT — CARRIED BY A PROJECTILE where it acts on others (the user: spells on others should fly and HIT, to be dodged or blocked):
    //   FLASH, a bolt (`lux` 'flash'): an orb of light flies straight (no drop) and BURSTS where you pointed (`fuse`: at the pointer, no further than `reach`), on rock or on a body
    //   first. Whoever is within `R` px and LOOKING at it, with nothing solid between, is whited out and dazed as by a flash-bang (16x's whiteout); facing away a glare; the dummy
    //   too; its caster spared (Debug › Move 'Try illusions and Knowing on yourself' flashes them). No bang, no ear ring: light only.
    //   DARKNESS, a bolt (`lux` 'dark'): a mote of dark LOBBED onto the pointer (`lob`); where it lands (or at the pointer in the air) a ball of darkness `R` cells round
    //   stays `secs` s: every light inside shines at `dim` of itself (flames burn on); from outside it is black — nothing inside is seen, names neither; inside you see `see`
    //   cells round you (`soft` the edge). Drawn over the picture (16zj `magicSenseScreen`), so every room. Two a caster.
    //   DAYLIGHT, a bolt (`lux` 'sun'; round 2, the user: a projectile, so modifiers work on it): a small sun flies to the pointer (`fuse`) through bodies (`thru`), short of rock,
    //   and hangs there `secs` s — a big warm light (`pow`, `rr` as the light orb's) that lights the dark and the underground round it as day. Three a caster (a split's three).
    flash: { name: 'Flash', school: 'light', form: 'bolt', tier: 0, cd: 8, stance: 'level', kind: 'bolt', lux: 'flash', fuse: true, learn: 3, reach: 460, speed: 820, life: 0.75, grav: 0, r: 4,
      dmg: 0, R: 300, fx: '#eef4ff', plain: { keys: [L, D, U, R, R], rune: [1, 4, 2, 5, 7] } },
    darkness: { name: 'Darkness', school: 'light', form: 'placed', tier: 1, cd: 20, stance: 'level', kind: 'bolt', lux: 'dark', lob: true, lobG: 1100, learn: 5, reach: 400, speed: 520, life: 1.6,
      grav: 0.35, r: 5, dmg: 0, secs: 15, R: 14, see: 2, soft: 2, dim: 0.12, fx: '#3a3450', plain: { keys: [L, D, R, D, D], rune: [1, 4, 3, 7, 6] } },
    daylight: { name: 'Daylight', school: 'light', form: 'placed', tier: 1, cd: 30, stance: 'level', kind: 'bolt', lux: 'sun', fuse: true, thru: true, learn: 5, reach: 420, speed: 420, life: 1.2, grav: 0, r: 5, dmg: 0,
      secs: 30, pow: 5, rr: 720, fx: '#fff1c8',
      plain: { keys: [L, D, U, U, U], rune: [1, 4, 0, 3, 6] } },
    // ⭐ STEP 20b (2026-11-27) LIGHT THAT HURTS. SUNBOLT, a bolt (`glare`): a fast straight dart of white-gold light, no drop, a small blow; the face it strikes is dazzled (16x's
    //   glare, no daze); the dummy screws its eyes shut. Modifiers as every bolt. SUNBEAM, kind 'beam', HELD (`chanS` s at most, you stand still): a beam from the catalyst's tip;
    //   its FRONT travels out at `speed` px/s to `reach`, stopped by rock (not by liquid — light goes through water); it TURNS towards the pointer no faster than `turn`
    //   radians a second, so it can be stepped out of. A body in it (half width `hw`): `dmg` every `every` s, each its own game, and a glare if they face it; the caster's game
    //   the dummy. Where its front meets ice or snow it melts it (server `magicHeatTick` along the beam, `magic-beam-melt`).
    sunbolt: { name: 'Sunbolt', school: 'light', form: 'bolt', tier: 0, cd: 3, stance: 'level', kind: 'bolt', learn: 3, speed: 1150, life: 0.45, grav: 0, r: 3, dmg: 1, glare: true, fx: '#fff1c8',
      plain: { keys: [L, D, R, R, R], rune: [1, 4, 2, 5, 8] } },
    sunbeam: { name: 'Sunbeam', school: 'light', form: 'stream', tier: 1, cd: 10, stance: 'level', kind: 'beam', learn: 5, chan: true, chanS: 4, reach: 320, speed: 900, turn: 30, hw: 4,   // (20c round 2, the user: it must keep up with the pointer — `turn` was 2.2)
      dmg: 0.4, every: 0.5, fx: '#fff1c8', plain: { keys: [L, D, R, R, D], rune: [1, 4, 5, 7, 8] } },
    // ⭐ STEP 20c (2026-11-27) LIGHT FOR SHOW — each that acts somewhere a PROJECTILE (the user: modifiers as widely as they can go):
    //   FIREWORKS, a bolt (`lux` 'fw'): a rocket of light trailing sparks to the pointer (`fuse`); it BURSTS into a shell of coloured sparks (its colours from its id, the same on
    //     every screen), a brief light in its colour. Harmless. Variant A DISPLAY (kind 'display', HELD `chanS` s): a rocket every `every` s up along your aim, each bursting
    //     on its own (every screen from the same aim and seed — nothing for the server).
    //   RAINBOW (kind 'rainbow'; round 2, the user: drawn by the player, not an arch made for them — purely visual spells should let players express themselves): HELD up to
    //     `chanS` s — a ribbon of rainbow is painted along wherever the pointer goes (within `reach` of you, at most `pts` points); let go, it stays `secs` s, then fades.
    //   BEACON, a bolt (`lux` 'beacon', through bodies): where it ends (round 2, the user: out of the nearest ground UNDER it, ≤ `down` cells) a column of light stands `secs` s, up to the rock above it; whoever is within `screens` screens of it and
    //     cannot see it gets an arrow at the edge of their view. Three a caster.
    //   SNUFF, a bolt (`lux` 'snuff'): a dart of shadow; where it ends every light within `R` px goes out — a torch's flame, a lantern, a headlamp, a flashlight (16k
    //     `torch-out`), a light orb, a daylight's sun. Flares and glowsticks burn on (they are never put out).
    fireworks: { name: 'Fireworks', school: 'light', form: 'bolt', tier: 0, cd: 3, stance: 'level', kind: 'bolt', lux: 'fw', fuse: true, learn: 3, reach: 480, speed: 620, life: 0.9, grav: 0.03, r: 3,
      dmg: 0, alts: ['display'], fx: '#ffd0f0', plain: { keys: [L, D, U, U, L], rune: [1, 4, 0, 3, 7] } },
    display: { name: 'Fireworks (a display)', school: 'light', form: 'stream', tier: 0, cd: 10, stance: 'level', kind: 'display', alt: 'fireworks', chan: true, chanS: 6, every: 0.4, reach: 380,
      fx: '#ffd0f0', plain: { keys: [L, D, U, U, D], rune: [1, 4, 3, 7, 5] } },
    rainbow: { name: 'Rainbow', school: 'light', form: 'stream', tier: 0, cd: 10, stance: 'level', kind: 'rainbow', learn: 3, chan: true, chanS: 8, reach: 480, secs: 20, pts: 240, wide: 16, fx: '#ffe08a',
      plain: { keys: [L, D, L, U, R], rune: [1, 4, 3, 0, 1] } },
    beacon: { name: 'Beacon', school: 'light', form: 'placed', tier: 0, cd: 20, stance: 'level', kind: 'bolt', lux: 'beacon', fuse: true, thru: true, learn: 3, reach: 420, speed: 650, life: 0.8,
      grav: 0, r: 4, dmg: 0, secs: 60, screens: 3, down: 80, fx: '#bcd8ff', plain: { keys: [L, D, D, U, U], rune: [1, 4, 6, 3, 0] } },
    snuff: { name: 'Snuff', school: 'light', form: 'bolt', tier: 0, cd: 6, stance: 'level', kind: 'bolt', lux: 'snuff', fuse: true, learn: 3, reach: 420, speed: 760, life: 0.7, grav: 0, r: 3,
      dmg: 0, R: 24, fx: '#5a4a7a', plain: { keys: [L, D, R, U, D], rune: [1, 4, 5, 7, 3] } },
    // ⭐ STEP 20d (2026-11-27) PAINTING SPELLS (the user: purely visual spells should let players express themselves — paint with the pointer). Kind 'paint', HELD (`chanS` s):
    //   what is painted follows the pointer (within `reach` of you; every screen gets the points through 'magic-aim'), stays `secs` s after let go, then fades. While held,
    //   (round 2, the user: both buttons are held, so not the wheel) the DIRECTION KEYS (you stand still anyway): the light brush and the wash — left / right the hue (24),
    //   up / down lighter / darker (5 tones, near-white to deep); stamps — left / right the shape, up / down the colour. The catalyst's tip shows the colour. By `brush`:
    //   line      LIGHT BRUSH: a glowing line in your colour (a few small lights along it)
    //   sparkler  SPARKLER: sparks fizz off the pointer and fall (nothing stays)
    //   aurora    AURORA: a rippling curtain of green-to-violet light hung down from your stroke
    //   stamps    STAR STAMPS: a glowing shape set every `gap` px along your stroke — the wheel picks star / heart / moon / diamond / flower; their colours run on from yours
    //   wash      COLOUR WASH (Illusion — the Light school has no two-key word left: an illusion of colour, only drawn): a soft tint of your colour sprayed onto what is under
    //             the pointer (lit rock takes the colour, the dark stays dark), fading over `secs` s from let go (round 2: 30). The brush and the wash are not drawn over bodies.
    lightbrush: { name: 'Light brush', school: 'light', form: 'stream', tier: 0, cd: 2, stance: 'level', kind: 'paint', brush: 'line', learn: 3, chan: true, chanS: 30, reach: 480, secs: 30, pts: 2000,
      fx: '#bcd8ff', plain: { keys: [L, D, R, L, L], rune: [1, 4, 3, 7, 8] } },
    sparkler: { name: 'Sparkler', school: 'light', form: 'stream', tier: 0, cd: 2, stance: 'level', kind: 'paint', brush: 'sparkler', learn: 3, chan: true, chanS: 10, reach: 480, secs: 0, pts: 0,
      fx: '#ffe6a8', plain: { keys: [L, D, R, D, U], rune: [1, 4, 5, 8, 7] } },
    aurora: { name: 'Aurora', school: 'light', form: 'stream', tier: 0, cd: 6, stance: 'level', kind: 'paint', brush: 'aurora', learn: 3, chan: true, chanS: 10, reach: 480, secs: 30, pts: 240,
      fx: '#8af0c0', plain: { keys: [L, D, L, L, U], rune: [1, 4, 6, 7, 3] } },
    stamps: { name: 'Star stamps', school: 'light', form: 'stream', tier: 0, cd: 2, stance: 'level', kind: 'paint', brush: 'stamps', learn: 3, chan: true, chanS: 10, reach: 480, secs: 30, pts: 60, gap: 30,
      fx: '#ffe08a', plain: { keys: [L, D, U, D, U], rune: [1, 4, 8, 7, 6] } },
    colourwash: { name: 'Colour wash', school: 'illusion', form: 'stream', tier: 0, cd: 4, stance: 'level', kind: 'paint', brush: 'wash', learn: 3, chan: true, chanS: 30, reach: 480, secs: 30, pts: 900,
      fx: '#ff9be0', plain: { keys: [L, U, D, R, R], rune: [2, 0, 4, 8, 7] } },
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
    closewounds: { name: 'Close wounds', school: 'life', form: 'self', tier: 0, cd: 10, stance: 'raise', kind: 'heal', learn: 3, hp: 3, closeMs: 700, gap: 350, ms: 2600, aim: 'self', reach: 240,
      plain: { keys: [U, D, U, D], rune: [7, 4, 1, 0] } },
    // ⭐ STEP 12a (2026-11-22, kickoff §'STEP 12') LIFE — HEALING: close wounds ON ANOTHER (its Touch variant: the player nearest the pointer, `reach` px; their own game heals
    //   itself) · CURE (kind 'cure', + on another): ends burning, the chill's slow, a daze, being frozen in — `ms` its leaves' spiral · HEALING GROVE (kind 'grove'): plants spring
    //   up along the ground under the point, `wide` cells across, `secs` s; every body standing in it heals `hp` health every `every` s; `most` a caster (the oldest goes)
    cure: { name: 'Cure', school: 'life', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'cure', learn: 3, ms: 1400, aim: 'self', reach: 240,
      plain: { keys: [L, U, D, R, U], rune: [8, 6, 4, 0, 1] } },
    grove: { name: 'Healing grove', school: 'life', form: 'placed', tier: 1, cd: 25, stance: 'level', kind: 'grove', learn: 5, reach: 360, secs: 12, wide: 14, every: 2, hp: 1, most: 2,
      plain: { keys: [D, U, R, D, L], rune: [6, 7, 3, 1, 2] } },
    // ⭐ STEP 12b (2026-11-22, kickoff §'STEP 12') LIFE — HOLDING AND GUARDING: ENTANGLE (a bolt that is a SEED, `seed`: no blow; LOBBED onto the pointer, `lob` — every screen
    //   the same arc, `lobG` its gravity; where it lands roots burst out `R` px round and hold every body there `holdS` s at most (walk and jump, not turn, punch or cast), each
    //   fresh movement key `press` s off, fire frees; the roots stay `snareS` s and catch each body that walks in, once) · THORN HEDGE (kind 'hedge'): brambles `wide` × `high`
    //   cells on the ground under the point, `secs` s; anyone in it but its caster slowed × `slowK` and scratched `dmg` health every `every` s; any fire burns it away in `burnS` s ·
    //   BARKSKIN (kind 'bark'): `secs` s — harm × `hurtK`, fire × `fireK`, your pace × `moveK`
    // (12b round 2, the user: roots over a much larger piece of ground; the hedge a seed you shoot that grows out over a wide area; the caster caught and scratched too)
    //   `seed` = what grows where it lands ('roots' / 'hedge') · the hedge grows out from where it landed to `wide` cells across over `growMs`
    entangle: { name: 'Entangle', school: 'life', form: 'bolt', tier: 0, cd: 8, stance: 'level', kind: 'bolt', seed: 'roots', lob: true, lobG: 1100, learn: 3, reach: 400, speed: 520, life: 1.6, grav: 0.4, r: 3, dmg: 0,
      R: 72, holdS: 2, press: 0.3, snareS: 6, plain: { keys: [D, D, U, L, R], rune: [7, 8, 4, 3, 0] } },
    thorns: { name: 'Thorn hedge', school: 'life', form: 'bolt', tier: 0, cd: 12, stance: 'level', kind: 'bolt', seed: 'hedge', lob: true, lobG: 1100, learn: 3, reach: 400, speed: 520, life: 1.6, grav: 0.4, r: 3.5, dmg: 0,
      secs: 30, wide: 30, high: 4, growMs: 1500, slowK: 0.5, thornDmg: 0.25, every: 0.5, burnS: 2, most: 2, plain: { keys: [R, D, D, U, L], rune: [3, 6, 8, 5, 1] } },
    // ⭐ STEP 12c (2026-11-23, kickoff §'STEP 12') LIFE — GROWING: VINE (kind 'vine'): a rope that is a vine, grown DOWN from the first rock at most `up` cells above the
    //   pointer, at most `len` cells long (to just over the ground under it), `secs` s, `most` a caster — climbed, swung on and burnt as a rope · GROW A TREE (kind 'tree'):
    //   one of the world's own trees (its kind from the plants round it) `hmin`–`hmax` cells tall out of the ground under the point over `growMs`; real plant cells that go
    //   back after `secs` s (a cut one gives nothing); after `fruitS` s `fruits` glowing fruits hang under its crown, each healing `fruitHeal` half-hearts · REGROW THE LAND
    //   (kind 'regrow'): in a generated world, every plant cell the world grew within `R` cells of the point that is open air now comes back, out from the point over `growMs`
    //   (round 2, the user) the vine longer, and pointed at the GROUND: tied into it, along it to the nearer edge within `edge` cells, and down over it · regrow goes on along
    //   each plant it brings back (up a whole tree), at most `spread` cells out, `cap` cells · the tree's trunk thicker, no roots, its fruit falling when its leaf is cut away
    // (12c round 3, the user: the swing vine, and 'improve the range of it') reach 520, the rock up to 60 cells over the point · SWING VINE (`swing`, a variant): from the rock
    //   the pointer is against (or over it) straight to your hands — you are holding it as it lands, to swing on; `secs` s
    vine: { name: 'Vine', school: 'life', form: 'placed', tier: 0, cd: 6, stance: 'level', kind: 'vine', learn: 3, reach: 520, up: 60, len: 40, edge: 14, secs: 180, most: 3, alts: ['vine_s'],
      plain: { keys: [U, U, D, D, R], rune: [1, 2, 4, 8, 6] } },
    vine_s: { name: 'Swing vine', school: 'life', form: 'placed', tier: 0, cd: 4, stance: 'level', kind: 'vine', alt: 'vine', swing: true, reach: 520, up: 60, secs: 60, most: 3,
      plain: { keys: [U, U, D, L, R], rune: [1, 2, 5, 7, 6] } },
    tree: { name: 'Grow a tree', school: 'life', form: 'placed', tier: 1, cd: 30, stance: 'level', kind: 'tree', learn: 5, reach: 300, hmin: 12, hmax: 20, growMs: 3000, secs: 300, fruitS: 20, fruits: 3, fruitHeal: 2, most: 2,
      plain: { keys: [D, R, U, U, L], rune: [7, 6, 3, 4, 2] } },
    regrow: { name: 'Regrow the land', school: 'life', form: 'placed', tier: 1, cd: 30, stance: 'level', kind: 'regrow', learn: 5, reach: 300, R: 15, growMs: 2000,
      plain: { keys: [R, U, L, D, D], rune: [5, 4, 0, 1, 7] } },
    barkskin: { name: 'Barkskin', school: 'life', form: 'self', aim: 'self', reach: 240, tier: 1, cd: 20, stance: 'raise', kind: 'bark', learn: 5, secs: 30, hurtK: 0.5, fireK: 1.5, moveK: 0.85,
      plain: { keys: [L, D, U, U, R], rune: [5, 8, 7, 3, 0] } },
    lift: { name: 'Lift and throw', school: 'force', form: 'shaping', tier: 0, cd: 3, stance: 'level', kind: 'lift', learn: 3, reach: 320, secs: 10, pull: 0.16, vmax: 11, throwV: 12,
      plain: { keys: [R, R, U, L], rune: [3, 4, 5, 2] } },
    double: { name: 'A double of you', school: 'illusion', form: 'self', tier: 1, cd: 12, stance: 'raise', kind: 'double', learn: 5, secs: 60, secsWalk: 6, walk: 150, jump: 420, alts: ['double_m'],
      plain: { keys: [L, U, R, D, D], rune: [2, 0, 6, 7, 8] } },
    // ⭐ 4b (2026-11-18, Trello #711): THE MIRROR DOUBLE — the double's variant (one mark changed, as the light orb's: On yourself → Placed; plain: the last key up). It comes out
    //   on you and moves with YOUR movement LEFT ↔ RIGHT SWAPPED (jumps as they are) while you move freely — never steered; it bursts as the double does; `secs`.
    //   mirror  moves as your mirror image (client 16zj `magicDoubleSimStep`)
    double_m: { name: 'A mirror double', school: 'illusion', form: 'placed', tier: 1, cd: 12, stance: 'raise', kind: 'double', alt: 'double', mirror: true, secs: 60,
      plain: { keys: [L, U, R, D, U], rune: [2, 0, 6, 7, 4] } },
    // ⭐ 16a (2026-11-25, kickoff §'STEP 16 — ILLUSION') HIDING. Kind 'ill' = a state on a BODY that only changes how it is DRAWN (the server keeps who has which, for those who
    //   arrive later — 'magic-ill'); `ill` names it. The pointer rule: on whoever the pointer is on, yourself by default.
    //   unseen   not drawn at all on anybody else's screen (a faint bend of the light where it moves); ends when its keeper strikes, casts, uses a thing or is hurt
    //   cham     the body fades into what is behind it while still (`stillK`), patchy when it moves (`moveK`); a blow does not end it
    //   guise    drawn as a THING: the thing under the pointer when cast (you take its look), else one that suits the spot; on another body `secsOther` s; ends as unseen
    //   veil     (kind) a THING unseen — loose or held — `secs` s; a weapon shows itself at its first blow
    //   hidefield (kind) a dome `R` px about the point: every body inside it is unseen from outside it (tier 1, not 2: a tier-2 rune's two underlines fold back over each other)
    unseen: { name: 'Unseen', school: 'illusion', form: 'self', aim: 'self', reach: 240, tier: 1, cd: 25, stance: 'raise', kind: 'ill', ill: 'unseen', secs: 20, learn: 5, fx: '#ff9be0',
      plain: { keys: [L, U, D, U, L], rune: [2, 4, 7, 3, 0] } },
    chameleon: { name: 'Chameleon', school: 'illusion', form: 'self', aim: 'self', reach: 240, tier: 0, cd: 15, stance: 'raise', kind: 'ill', ill: 'cham', secs: 40, learn: 3, stillK: 0.12, moveK: 0.55, fx: '#b0e090',
      plain: { keys: [L, L, U, D, R], rune: [0, 4, 7, 5, 2] } },
    guise: { name: 'Guise of a thing', school: 'illusion', form: 'self', aim: 'self', reach: 240, tier: 1, cd: 20, stance: 'raise', kind: 'ill', ill: 'guise', secs: 60, secsOther: 5, learn: 5, fx: '#e0b080',
      plain: { keys: [L, U, L, D, R], rune: [2, 1, 4, 7, 6] } },
    veil: { name: 'Veil a thing', school: 'illusion', form: 'thing', tier: 1, cd: 15, stance: 'level', kind: 'veil', secs: 60, reach: 320, learn: 5,
      plain: { keys: [U, L, D, L, U], rune: [0, 3, 4, 5, 8] } },
    hiding: { name: 'Veil of hiding', school: 'illusion', form: 'field', tier: 1, cd: 40, stance: 'raise', kind: 'hidefield', secs: 10, R: 150, reach: 420, learn: 5,
      plain: { keys: [L, U, R, U, L, D], rune: [3, 0, 1, 5, 8, 7] } },
    // ⭐ 16b (2026-11-26, kickoff §'16b — READING FOR THE BUILD') FALSE SELVES. All tier 1: a tier-2 rune in the language ends with the underline drawn twice (6 8 6 8) and folds
    //   back over itself whatever the word is — no spell is tier 2 yet (mirror images, fake death and mislead were proposed at 2).
    //   disg     drawn with another's look (colour, face and eyes, gear) and their name on the in-world nameplate only (2026-11-26 round 2: their eyes too); the pointer on a body = theirs, on
    //            nobody = a made-up stranger · `swap` (two faces): you and the one nearest the pointer swap looks
    //   imgs     `n` copies of you drawn by every screen, trailing you and swapping places; a blow through one pops it; your bolts are fired again from each, harmless
    //   disp     drawn a body `off` widths to one side (your things and name with it); every hit still tests your real body
    //   fakedeath (kind) a real-looking death on every screen, then unseen `secs` s; a false pile of your gear, gone when touched (`pileS` s at most)
    //   mislead  (the double's kind) your double walks on in your place (`secsWalk` s) while you are unseen `secs` s
    disguise: { name: 'Disguise', school: 'illusion', form: 'self', aim: 'self', reach: 240, tier: 1, cd: 20, stance: 'raise', kind: 'ill', ill: 'disg', secs: 60, learn: 5, fx: '#ff9be0', alts: ['twofaces'],
      plain: { keys: [L, U, U, D, R], rune: [2, 4, 0, 3, 7] } },
    twofaces: { name: 'Two faces', school: 'illusion', form: 'touch', aim: 'pick', reach: 240, tier: 1, cd: 25, stance: 'level', kind: 'ill', ill: 'disg', swap: true, alt: 'disguise', secs: 30, learn: 5, fx: '#ff9be0',
      plain: { keys: [L, U, U, R, U], rune: [2, 4, 0, 3, 5] } },
    images: { name: 'Mirror images', school: 'illusion', form: 'self', aim: 'self', reach: 240, tier: 1, cd: 30, stance: 'raise', kind: 'ill', ill: 'imgs', n: 3, secs: 20, swapS: 2.4, learn: 5, fx: '#ff9be0',
      plain: { keys: [L, R, L, R, U], rune: [1, 3, 5, 7, 4] } },
    displace: { name: 'Displacement', school: 'illusion', form: 'self', aim: 'self', reach: 240, tier: 1, cd: 20, stance: 'raise', kind: 'ill', ill: 'disp', off: 1.15, secs: 15, learn: 5, fx: '#ff9be0',
      plain: { keys: [L, U, R, R, D], rune: [2, 0, 8, 5] } },
    fakedeath: { name: 'Fake your death', school: 'illusion', form: 'self', tier: 1, cd: 45, stance: 'raise', kind: 'fakedeath', secs: 8, pileS: 60, learn: 5,
      plain: { keys: [L, D, D, R, D], rune: [1, 6, 8, 2] } },
    mislead: { name: 'Mislead', school: 'illusion', form: 'self', tier: 1, cd: 35, stance: 'raise', kind: 'double', mislead: true, secs: 10, secsWalk: 8, walk: 150, jump: 420, learn: 5,
      plain: { keys: [L, U, R, R, U], rune: [0, 4, 6, 8, 5] } },
    // ⭐ 16c (2026-11-26) FALSE THINGS — all tier 1 (a tier-2 rune folds). Placed illusions: only what is DRAWN changes; the physics and the server keep the truth;
    //   touched, one shows itself to that viewer only.
    //   falseterr  a box of cells drawn per viewer · `fake` 'wall' — RISES TO FILL THE GAP under the point (round 2, the user): floor to ceiling, at most `maxH` cells, or across
    //              a shaft (a false floor), at most `maxW`; no gap: `bh` cells tall; `bw` cells thick; drawn as the rock beside it by the terrain's own drawing, and solid to
    //              the light of every screen · 'hide' (round 2, the user — in place of the false opening) UNSEEN ROCK: the rock within `R` cells of the point unseen
    //              (what is behind it shows, the light passes) until a body touches it — then it comes back, with a sweep of light
    //   phantom    (shaping, held) the thing under the pointer: a copy of it on your pointer while held (the wheel turns it), set where you let go for `secs` s; not solid
    //   (round 2, the user: the mirages do not look or work well — LEFT OUT for now; their drawing is parked in 16zj §'STEP 16c', kind 'mirage')
    falsewall: { name: 'False wall', school: 'illusion', form: 'placed', tier: 1, cd: 20, stance: 'level', kind: 'falseterr', fake: 'wall', bw: 3, bh: 8, maxH: 16, maxW: 24, secs: 60, reach: 320, learn: 5, fx: '#ff9be0',
      plain: { keys: [L, U, D, D, L], rune: [2, 0, 4, 6, 3] } },
    hiderock: { name: 'Unseen rock', school: 'illusion', form: 'placed', tier: 1, cd: 20, stance: 'level', kind: 'falseterr', fake: 'hide', R: 4, secs: 60, reach: 320, learn: 5, fx: '#ff9be0',
      plain: { keys: [L, U, R, R, L], rune: [2, 0, 4, 5, 8] } },
    phantom: { name: 'Phantom thing', school: 'illusion', form: 'shaping', tier: 1, cd: 15, stance: 'level', kind: 'phantom', chan: true, chanS: 10, secs: 60, reach: 320, learn: 5, fx: '#ff9be0',
      plain: { keys: [L, U, L, D, U], rune: [2, 0, 3, 4, 1] } },
    // ⭐ 16d (2026-11-26) OTHERS' SENSES — kind 'sense', `sense` which. Drawn and felt only on the screen of the one it is on (the server keeps no state: each is short);
    //   every screen shows a small sign on that body. Ended by time or a dispel.
    //   spray    a fan `reach` px, `cone` degrees each side, from the hand: every body it crosses (clear of rock) has its screen flooded with colour `secs` s
    //   shroud   on another: their sight closes in to `R` cells past their body (dark by `soft` cells more), for `secs` s
    //   phant    on another: two copies of the caster (round 2: one each side) about them that only they see, firing false bolts every `every` s; a blow through one pops it
    //   bew      on another: left and right swapped for `secs` s
    colourspray: { name: 'Colour spray', school: 'illusion', form: 'burst', tier: 0, cd: 8, stance: 'level', kind: 'sense', sense: 'spray', reach: 150, cone: 28, ms: 420, secs: 3, learn: 3, fx: '#ff9be0',
      plain: { keys: [U, R, L, U, R], rune: [7, 4, 2, 1, 0] } },
    shroud: { name: 'Shroud', school: 'illusion', form: 'touch', tier: 1, cd: 20, stance: 'level', kind: 'sense', sense: 'shroud', other: true, reach: 260, secs: 8, R: 4, soft: 4, learn: 5, fx: '#9a7ab8',
      plain: { keys: [U, D, L, D, R], rune: [0, 4, 8, 7, 3] } },
    phantasms: { name: 'Phantasms', school: 'illusion', form: 'touch', tier: 1, cd: 25, stance: 'level', kind: 'sense', sense: 'phant', other: true, reach: 260, secs: 8, n: 2, every: 1.4, learn: 5, fx: '#ff9be0',
      plain: { keys: [U, L, R, D, D], rune: [3, 4, 2, 8, 6] } },
    bewilder: { name: 'Bewilder', school: 'illusion', form: 'touch', tier: 0, cd: 12, stance: 'level', kind: 'sense', sense: 'bew', other: true, reach: 260, secs: 3, learn: 3, fx: '#c8a8ff',
      plain: { keys: [U, R, R, L, U], rune: [5, 1, 3, 7, 5] } },
    // ⭐ 16e (2026-11-26) MINDS — kind 'mind', `mind` which; on another player (their own game feels it; the state rides 'magic-ill', so arrivals and dispel know it), the dummy
    //   (signs only), or one of the creator's ENEMIES (the server's `enemyTarget` reads `E.mind`; `secsEnemy`). All tier 1.
    //   fear   moving towards the caster `towardK`, away `awayK`; the caster looms on their screen; violet wisps · an enemy runs from the caster
    //   calm   no punch, swing, throw or harmful spell at others (block, move, spells on yourself are fine) · an enemy sees nobody
    //   charm  fear reversed (towards quick, away slow) — their blows on the caster do nothing, a blow FROM the caster ends it — a rose thread chest → caster ·
    //          an enemy follows the caster and goes for others, never the caster
    fear: { name: 'Fear', school: 'illusion', form: 'touch', tier: 1, cd: 20, stance: 'level', kind: 'mind', mind: 'fear', other: true, reach: 260, secs: 6, secsEnemy: 10, towardK: 0.35, awayK: 1.3, learn: 5, fx: '#a070e0',
      plain: { keys: [L, D, R, U, L], rune: [1, 4, 3, 6, 7] } },
    calm: { name: 'Calm', school: 'illusion', form: 'touch', tier: 1, cd: 20, stance: 'level', kind: 'mind', mind: 'calm', other: true, reach: 260, secs: 6, secsEnemy: 12, learn: 5, fx: '#9fd8ff',
      plain: { keys: [R, L, R, D, U], rune: [2, 1, 0, 3, 7] } },
    charm: { name: 'Charm', school: 'illusion', form: 'touch', tier: 1, cd: 30, stance: 'level', kind: 'mind', mind: 'charm', other: true, reach: 260, secs: 8, secsEnemy: 20, towardK: 1.3, awayK: 0.35, learn: 5, fx: '#ff7aa8',
      plain: { keys: [U, R, U, L, D], rune: [3, 0, 4, 2, 5] } },
    // ⭐ STEP 17a (2026-11-26, kickoff §'STEP 17 — KNOWING') TRUE SIGHT — kind 'know', `know` which. On yourself, or (aimed, as cure) the body under the pointer: for `secs` s
    //   that body's own screen draws the TRUTH — every illusion (bodies, things, false ground, copies, doubles, piles) as if none were cast, each marked with teal glints;
    //   runes and alarms shown whole; colour spray and shroud lifted off it, phantasms faint; a thread from anyone under a mind spell to its caster. Every screen sees the
    //   body's eyes glow teal (the state rides 'magic-ill', k 'truesight', so arrivals see it and a dispel ends it). Client 16zj §'STEP 17a'.
    truesight: { name: 'True sight', school: 'knowing', form: 'self', aim: 'self', reach: 240, tier: 1, cd: 30, stance: 'raise', kind: 'know', know: 'truesight', secs: 20, learn: 5, fx: '#8fe8e0',
      plain: { keys: [U, L, U, U, R], rune: [6, 1, 3, 4, 5] } },
    // ⭐ STEP 17b (2026-11-26) THROUGH THE STONE — kind 'stone': for `secs` s, round you to `R` cells (a ring sweeps out over `sweepMs`, and closes in over the last `closeMs`),
    //   rock does not stop your sight and the dark is lifted: the world as it is under the light, laid back over the darkness faint and teal (the caster's screen only —
    //   16zj `magicStone*`, on the GRAPHICS CARD by the canvas's own copies; the sight test round you says 'seen' so the bodies there are drawn). Every screen: the ring.
    throughstone: { name: 'Through the stone', school: 'knowing', form: 'self', tier: 1, cd: 15, stance: 'raise', kind: 'stone', secs: 6, R: 40, sweepMs: 650, closeMs: 900, learn: 5, fx: '#8fe8e0',
      plain: { keys: [D, D, R, U, L], rune: [0, 4, 8, 5, 3] } },
    // ⭐ STEP 17b SEEK — kind 'seek', `seek` what: a pulse goes out `R` cells over `sweepMs`; what it passes lights up over the dark for `secs` s (ore in its colour, liquid
    //   in its colour, a living body's heartbeat — through rock and through an illusion), small arrows at the screen's edge for those off it, dots on the minimap. The
    //   caster's game alone, a scan of the cells it holds (PROCESSOR, sparse) — every find within reach, nearest first up to `most`. ONE pulse (round 5, the user): what it catches lingers `linger` s from the moment it is reached, then fades.
    //   Every screen: the pulse. Water and life are variants on ore's page.
    seek: { name: 'Seek ore', school: 'knowing', form: 'self', tier: 0, cd: 10, stance: 'raise', kind: 'seek', seek: 'ore', secs: 5, linger: 4, R: 80, sweepMs: 900, most: 600, learn: 3, fx: '#e8c878', alts: ['seek_w', 'seek_l'],
      plain: { keys: [L, L, D, U, R], rune: [5, 1, 3, 7, 6] } },
    seek_w: { name: 'Seek water', school: 'knowing', form: 'self', tier: 0, cd: 10, stance: 'raise', kind: 'seek', seek: 'liq', alt: 'seek', secs: 5, linger: 4, R: 80, sweepMs: 900, most: 400, fx: '#7fc8ff',
      plain: { keys: [L, L, D, D, R], rune: [5, 1, 3, 7, 8] } },
    seek_l: { name: 'Seek life', school: 'knowing', form: 'self', tier: 0, cd: 10, stance: 'raise', kind: 'seek', seek: 'life', alt: 'seek', secs: 5, linger: 4, R: 80, sweepMs: 900, fx: '#ff8a8a',
      plain: { keys: [L, L, D, U, U], rune: [5, 1, 3, 6, 7] } },
    // ⭐ STEP 17c (2026-11-26) FAR EYE — kind 'fareye': a glass eye opens at the catalyst's tip and stays `secs` s (round 2, the user: not held — it goes on by itself till it
    //   runs out or the cast button is pressed again); meanwhile the movement keys fly it (`speed` px/s, ↑ / Space up), your body standing still; the camera, your sight and
    //   your own light go with it; open space only (it slips through a one-cell gap); no further than `reach` px from you. Every screen sees it and a faint thread back to
    //   its caster (its place on 'magic-eye', the end on 'magic-eye-end'). PROCESSOR: one point moved a step.
    fareye: { name: 'Far eye', school: 'knowing', form: 'placed', tier: 1, cd: 20, stance: 'raise', kind: 'fareye', secs: 30, reach: 960, speed: 320, r: 3.5, learn: 5, fx: '#8fe8e0',
      plain: { keys: [R, U, L, U, R], rune: [8, 3, 1, 5, 0] } },
    // ⭐ STEP 17c SEEKER'S MARK — kind 'seekmark', on another (a player, your dummy, one of the creator's enemies): for `secs` s a teal eye sigil over them on every screen;
    //   to its caster it shows through rock, the dark and illusions, with an arrow and the distance at the screen's edge and a ring on the minimap; the server tells the
    //   caster where a marked player is when their game is not sent them ('magic-where'). Dispel takes it off.
    seekmark: { name: "Seeker's mark", school: 'knowing', form: 'touch', tier: 0, cd: 20, stance: 'level', kind: 'seekmark', other: true, reach: 260, secs: 60, learn: 3, fx: '#8fe8e0',
      plain: { keys: [U, R, R, D, L], rune: [7, 3, 0, 1, 5] } },
    // ⭐ STEP 17d (2026-11-26) READ — kind 'know', `know` 'reading' (17a's state, on 'magic-ill'): for `secs` s (round 2, the user: 30) whatever your pointer is on gets a small card of the tome's
    //   runes that resolve into words — a body's real name (through a disguise), health, the spells on it, what it wears and its condition; a thing's numbers (weight, reach,
    //   a blow, what it digs, protection, a scroll's spell, a tome's pages, the spells a reagent feeds); a mimic named; a cell's material, hardness and worth. The inventory's
    //   details pane shows the same lines. Your own screen only (others see your eyes glow). Client 16zj §'STEP 17d'.
    read: { name: 'Read', school: 'knowing', form: 'self', tier: 0, cd: 10, stance: 'raise', kind: 'know', know: 'reading', secs: 30, learn: 3, fx: '#8fe8e0',
      plain: { keys: [R, D, L, D, R], rune: [0, 2, 3, 5, 8] } },
    // ⭐ STEP 17d FORESIGHT — kind 'know', `know` 'foresight': for `secs` s (round 2, the user: 30) every flying thing (spell bolts, thrown rock, arrows, thrown things, boulders, the creator's
    //   enemies' shots) shows its path ahead as teal motes, to where it lands (≤ `ahead` s of its flight).
    foresight: { name: 'Foresight', school: 'knowing', form: 'self', tier: 1, cd: 20, stance: 'raise', kind: 'know', know: 'foresight', secs: 30, ahead: 3, learn: 5, fx: '#8fe8e0',
      plain: { keys: [U, R, R, D, D], rune: [3, 1, 5, 8, 7] } },
    // ⭐ STEP 17d THE WAY OUT — kind 'know', `know` 'wayout': for `secs` s teal motes drift along the open path from you to the nearest open sky — or to your Space mark if
    //   you have one — searched round you (`R` × `Rv` cells) and redone each second as you move.
    wayout: { name: 'The way out', school: 'knowing', form: 'self', tier: 0, cd: 15, stance: 'raise', kind: 'know', know: 'wayout', secs: 20, R: 160, Rv: 120, learn: 3, fx: '#8fe8e0',
      plain: { keys: [D, L, U, U, R], rune: [8, 7, 3, 0, 1] } },
    // ⭐⭐ STEP 19 (2026-11-27) SUMMONING — the user: the creatures (summon skeleton + its variants, the familiar, raise the dead) HELD until the enemies are reworked.
    //   BOUND TOOL (kind 'bound') — the real tool's 3D model made of pink light in your main hand, its rules: by what you point at, a pick (rock), a spade (loose ground,
    //   earth) or an axe (wood) — the two-handed one when your OTHER hand is empty, else the one-handed one (`looks` = every look the server may make). (round 2, the user)
    //   It lasts until you switch away: on no number, choosing anything else puts it away and it is gone; out of your hand (let go, thrown, knocked out) it is gone; nobody else
    //   can take it. One cast's worth a caster. BOUND BLADE + its variants (round 2: the real 3D weapons, not the old test sword) — `looks` [one-handed, two-handed]:
    //   a sword, an axe, a spear / polearm, a mace / hammer; BOUND SWORD AND SHIELD: the arming sword + a heater shield in the off hand (`offLooks`; what was there put away).
    //   SPIRIT STEP (kind 'step') — a slab of pink spirit-stone `wide` cells long, `thick` deep, where you point (short of rock, in the air too), grown out both ways from the point into open
    //   cells only, `secs` s; solid to everything; its cells are glass (`mat`) under the drawn look, made matter that goes (`tkind` 'spirit': no rubble, nothing when dug).
    boundtool: { name: 'Bound tool', school: 'summoning', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'bound', learn: 3, fx: '#e09a9a',
      looks: ['handpick', 'smallspade', 'hatchet', 'pickaxe', 'spade', 'fellingaxe'],
      plain: { keys: [D, R, U, L, U], rune: [2, 8, 7, 3, 0] } },
    boundblade: { name: 'Bound blade', school: 'summoning', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'bound', learn: 3, weapon: 'sword', fx: '#e09a9a',
      alts: ['boundaxe', 'boundspear', 'boundmace', 'boundshield', 'boundbow'], looks: ['armingsword', 'greatsword'],
      plain: { keys: [D, R, U, R, U], rune: [2, 8, 4, 1, 0] } },
    boundaxe: { name: 'Bound axe', school: 'summoning', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'bound', alt: 'boundblade', weapon: 'axe', fx: '#e09a9a',
      looks: ['beardedaxe', 'greataxe'], plain: { keys: [D, R, U, R, L], rune: [2, 8, 4, 0, 3] } },
    boundspear: { name: 'Bound spear', school: 'summoning', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'bound', alt: 'boundblade', weapon: 'spear', fx: '#e09a9a',
      looks: ['spear', 'halberd'], plain: { keys: [D, R, U, U, U], rune: [2, 8, 4, 1, 2] } },
    boundmace: { name: 'Bound mace', school: 'summoning', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'bound', alt: 'boundblade', weapon: 'mace', fx: '#e09a9a',
      looks: ['mace', 'maul'], plain: { keys: [D, R, U, D, D], rune: [2, 8, 4, 3, 6] } },
    boundshield: { name: 'Bound sword and shield', school: 'summoning', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'bound', alt: 'boundblade', weapon: 'shield', fx: '#e09a9a',
      looks: ['armingsword'], offLooks: ['heatershield'], plain: { keys: [D, R, R, U, L], rune: [2, 8, 7, 4, 3] } },
    // (round 5, the user) BOUND BOW: a longbow of light (both hands, as every bow); it nocks ARROWS OF LIGHT without end — none from the pouch, never an item, gone `arrowS` s
    //   after they are loosed (client 16w `bowKind` / `bowShoot` `bndArrow`, server 'avatar-object-spawn')
    boundbow: { name: 'Bound bow', school: 'summoning', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'bound', alt: 'boundblade', weapon: 'bow', fx: '#e09a9a', arrowS: 4,
      looks: ['longbow'], plain: { keys: [D, R, L, L, U], rune: [2, 8, 4, 6, 3] } },
    spiritstep: { name: 'Spirit step', school: 'summoning', form: 'placed', tier: 0, cd: 6, stance: 'level', kind: 'step', learn: 3, reach: 320, secs: 20, wide: 10, thick: 2, rowMs: 30,
      crumbleMs: 70, crackS: 0, mat: 16, tkind: 'spirit', fx: '#e09a9a',
      plain: { keys: [R, D, L, R, R], rune: [6, 7, 8, 5, 4] } },
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
    leap: { name: 'Leap', school: 'force', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'boon', pw: 'boots', secs: 20, learn: 3, aim: 'self', reach: 240, plain: { keys: [R, U, U, D, R], rune: [6, 4, 2, 5, 8] } },
    feather: { name: 'Feather fall', school: 'storm', form: 'self', tier: 0, cd: 8, stance: 'raise', kind: 'boon', pw: 'feather', secs: 20, learn: 3, aim: 'self', reach: 240, plain: { keys: [L, R, D, D, U], rune: [0, 4, 8, 7, 6] } },
    haste: { name: 'Haste', school: 'space', form: 'self', tier: 0, cd: 10, stance: 'raise', kind: 'boon', pw: 'speed', secs: 15, learn: 3, aim: 'self', reach: 240, plain: { keys: [R, R, R, D, L], rune: [3, 5, 2, 0, 1] } },
    // ⭐ STEP 10a (2026-11-21) SPACE: BLINK (kind 'blink') — to the free spot nearest the pointer, at most `blinkR` px from your middle and in sight (the caster's game finds it:
    //   client 16zj `magicBlinkSpot`; the server holds it to `reach` px from the hand); your speed kept. PASS THROUGH (kind 'pass') — through at most `cells` cells of rock met within `near` cells of
    //   you, the way the pointer points (8 ways) to the first place your body fits (16zj `magicPassSpot`); carried there over a time set by how far.
    blink: { name: 'Blink', school: 'space', form: 'placed', tier: 0, cd: 5, stance: 'level', kind: 'blink', learn: 3, reach: 540, blinkR: 480, fx: '#b08cff',
      plain: { keys: [U, U, L, U, R], rune: [4, 1, 8, 0, 7] } },
    passthrough: { name: 'Pass through', school: 'space', form: 'placed', tier: 0, cd: 8, stance: 'level', kind: 'pass', learn: 3, reach: 380, cells: 16, near: 12, fx: '#b08cff',
      plain: { keys: [U, U, D, D, L], rune: [7, 6, 0, 3, 1] } },
    // ⭐ STEP 10b (2026-11-21) SPACE: MARK (kind 'mark') — a sigil where you stand, one a player, `secs` s (the server's `_magicMarks`); its variant RECALL (kind 'recall',
    //   HELD `chanS` s): held to the end you go to your mark. REWIND YOURSELF (kind 'rewind', HELD up to `chanS` s; round 2): back along your path — `backPerS` s further back for each
    //   second held, at most `backMax` s, counted from when you began casting; run back over `runMs0` + `runPxMs` × its length ms (round 3, slower)
    //   — or, LIVE (a client switch, the default since round 4), carried back while held at the client slider's speed (× how fast you went), held up to `chanS` s.
    mark: { name: 'Mark', school: 'space', form: 'placed', tier: 0, cd: 2, stance: 'raise', kind: 'mark', learn: 3, secs: 600, alts: ['recall'], fx: '#b08cff',
      plain: { keys: [L, D, U, R, D], rune: [3, 2, 7, 5, 6] } },
    recall: { name: 'Recall', school: 'space', form: 'stream', tier: 1, cd: 20, stance: 'raise', kind: 'recall', alt: 'mark', chan: true, chanS: 1.5, fx: '#b08cff',
      plain: { keys: [L, D, U, R, U], rune: [3, 2, 7, 5, 8] } },
    rewind: { name: 'Rewind yourself', school: 'space', form: 'stream', tier: 1, cd: 15, stance: 'raise', kind: 'rewind', learn: 5, alts: ['rewind_o'], chan: true, chanS: 40, backPerS: 4, backMax: 20, runMs0: 700, runPxMs: 1.1, runMin: 800, runMax: 3000, fx: '#b08cff',
      plain: { keys: [R, R, L, L, U], rune: [8, 2, 0, 1, 6] } },
    // (10c round 2, the user: swap's range 'increased massively' 320 → 1200; call back's 800 → 1600)
    // ⭐ STEP 10c (2026-11-21) SPACE: SWAP (kind 'swap') — you and the loose thing / player nearest the pointer within `reach` change places. CALL BACK (kind 'callback') —
    //   the last thing that left your hands, within `reach`, flies back to your hand at up to `speed` px a tick (through rock by folding). REWIND A THING (kind 'rewindobj',
    //   rewind's variant, HELD, live): the thing nearest the pointer within `reach` runs back along its own path, at most `backMax` s.
    swap: { name: 'Swap', school: 'space', form: 'touch', tier: 1, cd: 10, stance: 'level', kind: 'swap', learn: 5, reach: 1200, fx: '#b08cff',
      plain: { keys: [R, R, L, D, R], rune: [6, 5, 3, 2, 0] } },
    callback: { name: 'Call back', school: 'space', form: 'shaping', tier: 0, cd: 3, stance: 'raise', kind: 'callback', learn: 3, reach: 1600, speed: 16, fx: '#b08cff',
      plain: { keys: [D, R, U, L, R], rune: [3, 0, 8, 2, 5] } },
    rewind_o: { name: 'Rewind a thing', school: 'space', form: 'touch', tier: 1, cd: 10, stance: 'level', kind: 'rewindobj', alt: 'rewind', chan: true, chanS: 40, reach: 320, backMax: 20, fx: '#b08cff',
      plain: { keys: [R, R, L, L, R], rune: [8, 2, 0, 1, 4] } },
    // ⭐ STEP 10d (2026-11-21) SPACE: DOORWAYS (kind 'doorway') — two casts set two doorways (each at most `reach` px from you, the second at most `pair` px from the first),
    //   open together `secs` s: you, loose things, arrows and bolts go in one and out of the other keeping their speed; liquid flows through, `flow` cells' worth a tick
    //   (server `_magicDoors`). The first's cooldown is short — the full one starts with the second.
    doorways: { name: 'Doorways', school: 'space', form: 'placed', tier: 1, cd: 20, stance: 'level', kind: 'doorway', learn: 5, reach: 400, pair: 1500, secs: 30, flow: 6, fx: '#b08cff',
      plain: { keys: [D, D, L, U, R], rune: [3, 5, 6, 2, 1] } },
    // ⭐ STEP 10e (2026-11-22) SPACE: POCKET (kind 'pocket') — empty: the loose thing nearest the pointer within `reach` folds away into nothing over `foldMs` (the server keeps it,
    //   one a player — `_magicPockets`); full: cast again and it unfolds where you point (within `reach`, where it fits), in the world it came from. You die: it falls out there.
    pocket: { name: 'Pocket', school: 'space', form: 'touch', tier: 1, cd: 6, stance: 'level', kind: 'pocket', learn: 5, reach: 320, foldMs: 450, fx: '#b08cff',
      plain: { keys: [L, L, D, L, R], rune: [5, 7, 4, 3, 6] } },
    grow: { name: 'Grow', school: 'alteration', form: 'self', tier: 1, cd: 12, stance: 'raise', kind: 'boon', pw: 'mega', secs: 15, learn: 5, aim: 'self', reach: 240, plain: { keys: [U, L, U, R, U], rune: [7, 3, 1, 5, 7] } },
    // ⭐ STEP 15a (2026-11-24) ALTERATION — boons through the pickups' own grant (16a `powerGrant`), each with its look on every screen (16zj §'STEP 15a'):
    //   STONE SKIN (+ on another): the powerup 'stone' — nothing hurts or moves you, slow, a low jump, you sink; granite grows up the skin (the position packet's
    //   `PW_STONE_SPELL_BIT` tells a spell's stone from a pickup's) · FINS: swim faster, the water's lift off (stay at any depth), less drag · NIGHT EYES: your own view's
    //   darkness lifted to a cold grey-green (the light's floor, on the card), glowing slit eyes on your face for everybody else
    stoneskin: { name: 'Stone skin', school: 'alteration', form: 'self', tier: 1, cd: 25, stance: 'raise', kind: 'boon', pw: 'stone', secs: 15, learn: 5, aim: 'self', reach: 240, fx: '#a8a49a', plain: { keys: [D, D, U, D, D], rune: [1, 0, 3, 6, 8] } },
    fins: { name: 'Fins', school: 'alteration', form: 'self', tier: 0, cd: 15, stance: 'raise', kind: 'boon', pw: 'fins', secs: 30, aim: 'self', reach: 240, learn: 3, fx: '#5fc8c0', plain: { keys: [L, R, L, R, D], rune: [3, 1, 5, 8, 6] } },
    nighteyes: { name: 'Night eyes', school: 'alteration', form: 'self', tier: 0, cd: 15, stance: 'raise', kind: 'boon', pw: 'nighteyes', secs: 30, aim: 'self', reach: 240, learn: 3, fx: '#c8f070', plain: { keys: [U, L, R, U, U], rune: [6, 0, 4, 8, 2] } },
    // ⭐ STEP 15b (2026-11-24, kickoff §'STEP 15 — ALTERATION') GASEOUS FORM (boon 'gas', `secs` s: a drifting mist the size of the smallest body — it squeezes through gaps, floats on the
    //   movement keys, is not solid to anybody, nothing in its hands; if it ends where the body does not fit, you are CRUSHED) · RUBBER BODY (boon 'rubber': you bounce off the ground
    //   and walls — hold down to land soft — blows throw you `knockK` further and hurt `hurtK`) · PETRIFY (a bolt: whom it hits is stone where they stand for at most `holdS` s,
    //   each fresh movement key `press` s off, a blow breaks it — the stasis hold, client 16zj) · JELLY (on another, boon 'jelly': a wobbling see-through jelly, slower, no casting,
    //   striking or using). Client 16zj §'STEP 15b'.
    gaseous: { name: 'Gaseous form', school: 'alteration', form: 'self', tier: 1, cd: 20, stance: 'raise', kind: 'boon', pw: 'gas', secs: 15, aim: 'self', reach: 240, warnS: 3, high: 72, learn: 5, fx: '#c8d4e0', plain: { keys: [U, U, L, R, U], rune: [0, 7, 3, 5, 1] } },
    rubber: { name: 'Rubber body', school: 'alteration', form: 'self', tier: 0, cd: 15, stance: 'raise', kind: 'boon', pw: 'rubber', secs: 15, aim: 'self', reach: 240, learn: 3, knockK: 1.6, hurtK: 0.5, fx: '#e8508a', plain: { keys: [D, U, D, U, R], rune: [7, 1, 8, 2, 5] } },
    petrify: { name: 'Petrify', school: 'alteration', form: 'bolt', tier: 1, cd: 10, stance: 'level', kind: 'bolt', petrify: true, aim: 'me', holdS: 6, press: 0.3, learn: 5, speed: 560, life: 1.2, grav: 0.08, r: 3.5, dmg: 0, fx: '#a8a49a', plain: { keys: [R, D, D, R, D], rune: [3, 4, 7, 8, 6] } },
    jelly: { name: 'Jelly', school: 'alteration', form: 'touch', tier: 1, cd: 15, stance: 'level', kind: 'boon', pw: 'jelly', secs: 8, aim: 'pick', reach: 240, learn: 5, fx: '#7ee08a', plain: { keys: [L, R, L, D, R], rune: [2, 4, 6, 8, 5] } },
    // ⭐ STEP 15c (2026-11-25, kickoff §'STEP 15 — ALTERATION') SPIDER CLIMB (boon 'spider', `secs` s: you cling to rock walls and ceilings — toward a wall climbs it, down climbs
    //   down, the away key lets go, Space wall-jumps; on a ceiling left / right crawl, down drops; the rule is the shared sim's `climbStep`; eight legs on every screen) · MEND GEAR
    //   (kind 'mendgear': every piece the body has back to full condition at once, char and rust gone, its cuts, dents and cracks knitting shut over `ms` ms — a band of light up
    //   each worn piece on every screen; the wearer's own game sets the condition). Client 16zj §'STEP 15c'.
    spider: { name: 'Spider climb', school: 'alteration', form: 'self', tier: 1, cd: 20, stance: 'raise', kind: 'boon', pw: 'spider', secs: 20, aim: 'self', reach: 240, learn: 5, fx: '#8a6ab8', plain: { keys: [R, U, R, U, L], rune: [8, 4, 0, 3, 6, 7] } },
    mendgear: { name: 'Mend gear', school: 'alteration', form: 'touch', tier: 0, cd: 12, stance: 'level', kind: 'mendgear', aim: 'self', reach: 240, learn: 3, ms: 1600, fx: '#f0d890', plain: { keys: [D, R, U, R, D], rune: [3, 7, 5, 1, 2] } },
    shrink: { name: 'Shrink', school: 'decay', form: 'self', tier: 1, cd: 12, stance: 'raise', kind: 'boon', pw: 'mini', secs: 15, learn: 5, aim: 'self', reach: 240, plain: { keys: [D, R, D, L, D], rune: [1, 5, 7, 3, 4] } },
    // ⭐ STEP 13a (2026-11-23, kickoff §'STEP 13') DECAY — POISON. POISONED (a body's own game: `poison` s, `poisonDmg` health every `poisonEvery` s; cure ends it; the others told to draw it).
    //   VENOM BOLT (kind 'bolt' + `poison`): a dripping glob that flies until it hits something (round 2, the user: it vanished — `life` 8); what it hits is poisoned. POISON CLOUD (kind 'pcloud', placed): a cloud spreading out from the point over `grow` s, as a gas, to `wide` cells across, `high` cells deep (round 2: taller, wider), on the ground under
    //   the point, following each column's ground; every body in it poisoned (`poisonS` s, kept up while in it); FIRE in it (any fire lit there, a burning body) sets it off — a flash, `boomDmg`
    //   and alight. SPORE PODS (kind 'spores', placed): mushrooms on the ground, armed after `armS` s; a body (not its caster's, but the dummy) within `trip` px bursts them: a small cloud
    //   (`puffW` cells, `puffS` s) and `poisonS` s of poison to bodies within `R`. PLAGUE (kind 'plague', on another): sick `secs` s (`dmg` every `every` s); every second it is passed to
    //   any body within `spreadR` px; once it ends, `immuneS` s before it can be caught again.
    venombolt: { name: 'Venom bolt', school: 'decay', form: 'bolt', tier: 0, cd: 3, stance: 'level', kind: 'bolt', learn: 3, speed: 520, life: 8, grav: 0.14, r: 3.5, dmg: 0.25, poison: 8, poisonDmg: 0.25, poisonEvery: 1,
      plain: { keys: [D, L, D, R, R], rune: [1, 3, 7, 8, 5] } },
    pcloud: { name: 'Poison cloud', school: 'decay', form: 'placed', tier: 1, cd: 18, stance: 'level', kind: 'pcloud', learn: 5, reach: 360, secs: 10, wide: 22, high: 7, grow: 1.8, most: 2, poisonS: 3, boomDmg: 1,
      plain: { keys: [D, D, L, R, L], rune: [3, 6, 7, 8, 5] } },
    spores: { name: 'Spore pods', school: 'decay', form: 'placed', tier: 0, cd: 8, stance: 'level', kind: 'spores', learn: 3, reach: 360, secs: 90, most: 3, armS: 1.2, trip: 22, R: 44, puffW: 7, puffS: 4, poisonS: 6,
      plain: { keys: [D, U, D, U, R], rune: [6, 3, 7, 5, 8] } },
    plague: { name: 'Plague', school: 'decay', form: 'touch', tier: 1, cd: 20, stance: 'level', kind: 'plague', learn: 5, other: true, reach: 240, secs: 15, dmg: 0.25, every: 2, spreadR: 44, immuneS: 20,
      plain: { keys: [R, L, D, L, R], rune: [8, 3, 2, 6, 1] } },
    // ⭐ STEP 13b (2026-11-23, kickoff §'STEP 13') DECAY — WITHERING. CURSE OF WEAKNESS (kind 'curse', on another): `secs` s — the blows they land on others do `weakK` (each victim's game
    //   halves a blow from a cursed striker, 16e `pvpHurt`), their natural healing stops; dispel ends it, cure does not. WITHER (kind 'wither', on another): `secs` s aged — greyed, dry
    //   cracked skin, ash falling off them, `slowK` their pace; cure and dispel end it. BONE SPEAR (kind 'bolt' + `bone`): a shard of bone flying until it hits. (round 3, the user: simpler,
    //   'stabs into the other player like an arrow', with its own use) It STICKS IN whom it hits for `lodgeS` s, bleeding them `bleed` a second, a wound where it went in; with rock
    //   within `pinR` × their radius behind them along its line it goes on through and PINS them to it for `pinS` s (each fresh movement key −0.3 s), a wound where it came out
    //   too. In rock it sticks and crumbles after `stuckS` s.
    // ⭐ STEP 13c (2026-11-23) DECAY — ROT. ROT (kind 'rot', placed): mould creeps out from the point over `ms` ms to `R` cells: WOOD turns to PEAT (crumbly, a spade digs it) and
    //   PLANTS wither away — for good, as digging is. RUST (kind 'rust', on another): their worn METAL pieces (plate, mail) rust — each one's condition × `rustK` (it comes back
    //   as worn gear does); rust flakes peel off them on every screen. (The bone spear: taken out, 2026-11-23 — its code in 16zj stays, unused.)
    //   (round 2, the user: 'the rot range should be bigger' — 8 → 14 cells; leaves it left hanging in mid-air rot away too)
    //   WEATHERING (kind 'weather', placed — the plan's 'crumble'; the user picked the weathering kind, as Earth's 'Rock to sand' is the instant one): cracks creep through the
    //   rock round the point over `ms` ms (wear, as a pick's, softer rock faster, faces open to the air faster still), and the weakest pieces on its faces break away as rubble.
    rot: { name: 'Rot', school: 'decay', form: 'placed', tier: 0, cd: 10, stance: 'level', kind: 'rot', learn: 3, reach: 360, R: 14, ms: 3000,
      plain: { keys: [D, R, D, R, L], rune: [7, 4, 6, 8, 5] } },
    weather: { name: 'Weathering', school: 'decay', form: 'placed', tier: 0, cd: 14, stance: 'level', kind: 'weather', learn: 4, reach: 360, R: 7, ms: 5000, steps: 14, crack: 6, breakW: 50, loose: 14, weakL: 1.05,
      plain: { keys: [D, D, R, L, D], rune: [1, 4, 7, 3, 5] } },
    rust: { name: 'Rust', school: 'decay', form: 'touch', tier: 0, cd: 10, stance: 'level', kind: 'rust', learn: 3, other: true, reach: 260, rustK: 0.5,
      plain: { keys: [R, D, U, U, L], rune: [2, 5, 4, 7, 6] } },
    curse: { name: 'Curse of weakness', school: 'decay', form: 'touch', tier: 1, cd: 20, stance: 'level', kind: 'curse', learn: 5, other: true, reach: 260, secs: 20, weakK: 0.5,
      plain: { keys: [R, U, L, D, U], rune: [6, 4, 2, 1, 0] } },
    wither: { name: 'Wither', school: 'decay', form: 'touch', tier: 0, cd: 12, stance: 'level', kind: 'wither', learn: 3, other: true, reach: 260, secs: 10, slowK: 0.65,
      plain: { keys: [D, D, U, R, D], rune: [0, 3, 7, 5, 2] } },
    // ⭐ STEP 14a (2026-11-23, kickoff §'STEP 13' plan line 'STEP 14 BLOOD') BLOOD — its own school. Blood is the wound system's DRAWN blood (client 16o: its colours by the look
    //   picked, its drops and stains) — there is no blood liquid. `cost` = health (half-hearts, of 10) its caster's own game takes as it is cast, never below 1 (with 1 left: refused).
    //   BLOOD BOLT (kind 'bolt' + `blood`): while prepared, drops are pulled out of your body into an orb at the catalyst; it flies trailing drops that splatter where they land.
    //   LIFE DRAIN (kind 'drain', HELD — `chan`, `chanS` at most — on another): their blood pulled out of them in arcing streams of drops into you; their own game takes `dmg`
    //   every `every` s and yours gains as much; it breaks once they are past `reach` + `slack` px or out of sight. TRANSFUSION (kind 'transfuse', on another): your blood streams
    //   into them over `ms` — `cost` off you, `hp` back to them (their own game).
    bloodbolt: { name: 'Blood bolt', school: 'blood', form: 'bolt', tier: 0, cd: 3, stance: 'level', kind: 'bolt', blood: true, cost: 2, learn: 3, speed: 620, life: 3, grav: 0.1, r: 4, dmg: 2.5,
      plain: { keys: [R, D, R, R, U], rune: [2, 3, 7, 5, 1] } },
    lifedrain: { name: 'Life drain', school: 'blood', form: 'stream', tier: 1, cd: 12, stance: 'level', kind: 'drain', learn: 5, other: true, chan: true, chanS: 5, reach: 260, slack: 60, dmg: 0.5, every: 0.5,
      fx: '#b3121f', plain: { keys: [R, D, L, L, U], rune: [8, 5, 3, 7, 1] } },
    transfusion: { name: 'Transfusion', school: 'blood', form: 'touch', tier: 0, cd: 10, stance: 'level', kind: 'transfuse', learn: 3, other: true, reach: 240, cost: 2, hp: 2, ms: 1400,
      plain: { keys: [R, D, U, R, R], rune: [6, 3, 1, 5, 2] } },
    // ⭐ STEP 14b (2026-11-23) BLOOD — HAEMORRHAGE (kind 'haem', on another): `secs` s their open wounds pour (none open: `cuts` cuts open first); their own game takes `dmg` every
    //   `every` s, `moveK` × as often while they move; cure or close wounds stops it. BLOOD BOIL (kind 'boil', on another): their blood heats for `ms` (flushed, bubbling in the skin,
    //   steaming), then bursts in red mist — `dmg` off them. LEECHES (kind 'bolt' + `leech`): a knot of `n` leeches flies; where it strikes a body they latch on for `secs` s and
    //   feed — `feed` off them and to its caster every `every` s, a trickle of drops running between; cure knocks them off.
    haemorrhage: { name: 'Haemorrhage', school: 'blood', form: 'touch', tier: 1, cd: 16, stance: 'level', kind: 'haem', learn: 5, other: true, reach: 260, secs: 8, dmg: 0.25, every: 1, moveK: 2, cuts: 2,
      plain: { keys: [R, D, L, U, L], rune: [2, 3, 7, 4, 0] } },
    bloodboil: { name: 'Blood boil', school: 'blood', form: 'touch', tier: 1, cd: 14, stance: 'level', kind: 'boil', learn: 5, other: true, reach: 260, ms: 1400, dmg: 2.5,
      plain: { keys: [R, D, U, U, R], rune: [8, 5, 1, 3, 7] } },
    leeches: { name: 'Leeches', school: 'blood', form: 'bolt', tier: 0, cd: 10, stance: 'level', kind: 'bolt', leech: true, learn: 3, speed: 460, life: 3, grav: 0.3, r: 3.5, dmg: 0.25, n: 3, secs: 10, feed: 0.25, every: 1,
      plain: { keys: [R, D, R, U, U], rune: [6, 7, 4, 5, 2] } },
    // ⭐ STEP 14c (2026-11-23) BLOOD — BLOOD SHIELD (kind 'bshield', on yourself): `cost` off you, a hardened crimson shell soaking the next `hp` half-hearts of harm for `secs` s (the
    //   ward skin's soak, client 16zj `magicWardSoak`). BLOOD SPIKES (a lobbed glob — kind 'bolt' + `seed` 'bspikes', round 3, the user: 'some projectile so that it can land somewhere definitive and then spread from there'):
    //   where it lands crimson spikes burst up along the ground `wide` cells, out from that spot each way; a body standing on one is cut, bleeds, takes `dmg` and is tossed (`toss`); they melt after `secs` s. BLOOD GRIP (kind 'grip', HELD, on another):
    //   a rope of blood HOLDS them where they are (round 2, the user: hold, not pull) for at most `holdS` s, each fresh movement key they press `press` s off; it breaks past `reach` + `slack` or out of sight. BLOOD WHIP (kind 'whip', HELD): `cost` off you,
    //   a lash of your blood `len` px long trailing the pointer; its tip cuts whom it whips (`dmg`, each body at most every `gap` s).
    bloodshield: { name: 'Blood shield', school: 'blood', form: 'self', aim: 'self', reach: 240, tier: 1, cd: 20, stance: 'raise', kind: 'bshield', learn: 5, cost: 2, hp: 3, secs: 20,
      plain: { keys: [R, D, D, D, U], rune: [2, 3, 6, 7, 4] } },
    bloodspikes: { name: 'Blood spikes', school: 'blood', form: 'placed', tier: 1, cd: 10, stance: 'level', kind: 'bolt', seed: 'bspikes', lob: true, lobG: 1100, learn: 5, reach: 400, speed: 520, life: 1.8, grav: 0.4, r: 3.5, dmg: 0, wide: 10, spikeDmg: 1.5, toss: 6, secs: 2.2,
      plain: { keys: [R, D, D, L, R], rune: [0, 3, 7, 8, 5] } },
    bloodgrip: { name: 'Blood grip', school: 'blood', form: 'stream', tier: 1, cd: 12, stance: 'level', kind: 'grip', learn: 5, other: true, chan: true, chanS: 10, reach: 280, slack: 60, holdS: 10, press: 0.6,
      fx: '#b3121f', plain: { keys: [R, D, L, L, L], rune: [8, 7, 3, 1, 2] } },
    bloodwhip: { name: 'Blood whip', school: 'blood', form: 'stream', tier: 0, cd: 6, stance: 'level', kind: 'whip', learn: 3, chan: true, chanS: 5, cost: 1, len: 100, dmg: 1, gap: 0.45,
      fx: '#b3121f', plain: { keys: [R, D, R, L, R], rune: [6, 4, 2, 1, 3] } },
    fireward: { name: 'Fire ward', school: 'wards', form: 'self', tier: 0, cd: 10, stance: 'raise', kind: 'boon', pw: 'fireproof', secs: 20, learn: 3, aim: 'self', reach: 240, plain: { keys: [L, D, R, U, U], rune: [0, 6, 8, 2, 4] } },
    // ⭐ STEP 11a (2026-11-22) WARDS: WARD SKIN (kind 'wardskin', on yourself; its Touch variant on another) — a lattice of gold light over the body soaks the next `hp` half-hearts
    //   of harm of any kind for `secs` s (each game its own body: 16e `hurtMe`; the dummy's on its caster's machine). MIRROR WARD (kind 'mirror', on yourself, `secs` s — 11a round 2, the user: about 10 s): spell
    //   bolts, arrows, thrown things and ice shards that come within `R` px of your body turn back the way they came, now yours (catch's hand-off).
    wardskin: { name: 'Ward skin', school: 'wards', form: 'self', tier: 0, cd: 12, stance: 'raise', kind: 'wardskin', secs: 20, hp: 4, learn: 3, aim: 'self', reach: 240, fx: '#ffd86b',
      plain: { keys: [L, U, U, R, D], rune: [0, 2, 5, 4, 7] } },
    mirror: { name: 'Mirror ward', school: 'wards', form: 'self', aim: 'self', reach: 240, tier: 1, cd: 14, stance: 'raise', kind: 'mirror', secs: 10, R: 18, minV: 3, learn: 5, fx: '#ffd86b',
      plain: { keys: [R, D, L, U, R], rune: [2, 0, 3, 5, 8] } },
    // ⭐ STEP 11b (2026-11-22; round 3, the user: the wall had no purpose of its own — 'I like the ward line option') WARDS: WARD LINE (kind 'wardline') — a line of light where
    //   you point, from rock to rock (at most `high` cells), `secs` s: no other player crosses it (each game stops its own body at it; the test dummy too); you, things,
    //   liquid and spells pass. WARD DOME (kind 'warddome', its own spell — the user) — HELD: it grows from `Rmin` to `Rmax` px over `chargeS` s held, set on let-go; a
    //   half-sphere of gold light where its caster's feet were (or, by its caster's switch, a sphere about their middle), resting on the ground under it, `secs` s; bodies walk
    //   through it, what flies into it from outside is stopped.
    wardline: { name: 'Ward line', school: 'wards', form: 'placed', tier: 0, cd: 12, stance: 'level', kind: 'wardline', learn: 3, reach: 300, secs: 30, high: 16, fx: '#ffd86b',
      plain: { keys: [D, U, L, R, U], rune: [1, 7, 6, 8, 2] } },
    warddome: { name: 'Ward dome', school: 'wards', form: 'placed', tier: 1, cd: 20, stance: 'level', kind: 'warddome', learn: 5, reach: 320, chan: true, chanS: 2.5, chargeS: 2.5, Rmin: 56, Rmax: 140, secs: 10, fx: '#ffd86b',
      plain: { keys: [D, R, U, L, L], rune: [1, 7, 6, 8, 5] } },
    // ⭐ STEP 11c (2026-11-22) WARDS AGAINST MAGIC: NULL CIRCLE (kind 'nullc') — a ring of gold glyphs on the ground where you point, `R` px round (18 cells across), and a faint
    //   dome of upright light lines over it, `secs` s: no spell is cast from inside it, its caster's too (the server refuses), a held spell inside ends, a spell bolt fizzles at
    //   its edge; arrows and thrown things pass (the ward dome stops everything flying). DISPEL (kind 'dispel') — a gold ring sweeping out from the pointer to `R` px in `ms`:
    //   every spell effect it reaches ends, each popping into gold motes; the cells a spell made for a time go back early. Not a pocketed thing.
    //   (11c round 3, the user: held to grow as the ward sphere, and bigger — it should stop casting over a large area) the null circle is HELD: from `Rmin` to `Rmax` px over
    //   `chargeS` s, set (and only then at work) on let-go. (round 4, the user: the circle should not stop spells coming in from outside — that is the ward dome's) only
    //   casting inside it is stopped. THE WARD DOME is cast AT THE POINTER (within `reach`): on a body there (yours, another's, the dummy) about its middle, else about the point.
    nullcircle: { name: 'Null circle', school: 'wards', form: 'placed', tier: 1, cd: 10, stance: 'level', kind: 'nullc', learn: 5, reach: 320, secs: 60, chan: true, chanS: 3, chargeS: 3, Rmin: 96, Rmax: 240, fx: '#ffd86b',
      plain: { keys: [U, D, R, L, D], rune: [6, 8, 5, 3, 0] } },
    // ⭐ STEP 11d (2026-11-22) WARDS ON PLACES AND THINGS: ALARM (kind 'alarm') — a small gold eye sigil on the ground where you point (faint to others, as the warding rune),
    //   `most` a caster, `secs` s, awake after `armS` s: another player, the test dummy or a loose thing crossing it — a chime for its owner wherever they are, an arrow at the
    //   edge of their screen and a ping on the minimap; the sigil flares on every screen. SEAL (kind 'seal') — rings of gold glyphs turning round a loose thing or a placed
    //   object, `secs` s: nobody else's magic moves it, nothing breaks it, nobody else picks it up; bodies still push it.
    //   (11d round 2, the user) THE ALARM floats where you point, an orb with an eye, an hour; it goes off when anybody or anything comes within `R` px in sight of it; it can be
    //   BROKEN (a spell, a blow, a swing, a thing thrown through it), which sets it off its own way. THE NULL CIRCLE: one a caster (a new one ends the old), `cd` 10.
    alarm: { name: 'Alarm', school: 'wards', form: 'placed', tier: 0, cd: 4, stance: 'level', kind: 'alarm', learn: 3, reach: 300, secs: 3600, most: 3, armS: 1, R: 90, fx: '#ffd86b',
      plain: { keys: [U, R, D, U, L], rune: [3, 1, 5, 4, 6] } },
    seal: { name: 'Seal', school: 'wards', form: 'touch', tier: 0, cd: 8, stance: 'level', kind: 'seal', learn: 3, reach: 320, secs: 120, fx: '#ffd86b',
      plain: { keys: [D, L, U, R, R], rune: [7, 3, 1, 5, 2] } },
    dispel: { name: 'Dispel', school: 'wards', form: 'placed', tier: 1, cd: 15, stance: 'level', kind: 'dispel', learn: 5, reach: 320, R: 120, ms: 450, fx: '#ffd86b',
      plain: { keys: [R, U, D, L, U], rune: [8, 4, 0, 1, 2] } },
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
    pillar: { name: 'Rising pillar', school: 'earth', form: 'self', aim: 'self', reach: 240, tier: 0, cd: 8, stance: 'raise', kind: 'pillar', learn: 3, wide: 3, high: 16, rowMs: 90, waitN: 12, secs: 30, crackS: 0, crumbleMs: 90, sink: true,
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
    flamering: { name: 'Flame ring', school: 'fire', form: 'self', aim: 'self', reach: 240, tier: 0, cd: 14, stance: 'raise', kind: 'firering', learn: 3, secs: 12, n: 5, orbit: 1.9, turnS: 1.5, fr: 6,
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
    flameblade: { name: 'Flaming weapon', school: 'fire', form: 'self', aim: 'self', reach: 240, tier: 1, cd: 20, stance: 'raise', kind: 'flameblade', learn: 5, secs: 30,
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
    windshield: { name: 'Wind shield', school: 'storm', form: 'self', tier: 0, cd: 14, stance: 'raise', kind: 'windshield', learn: 3, secs: 12, R: 44, k: 24, aim: 'self', reach: 240, fx: '#dfe8f0',
      plain: { keys: [L, R, D, L, U], rune: [0, 5, 7, 3, 1] } },
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
    stormblade: { name: 'Lightning weapon', school: 'storm', form: 'self', aim: 'self', reach: 240, tier: 1, cd: 20, stance: 'raise', kind: 'stormblade', learn: 5, secs: 30, dmg: 1, stunMs: 300, metalHurtK: 1.5,
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
    // ⭐ STEP 9a (2026-11-21, kickoff §'STEP 9') FORCE: PUSH and its variant PULL (one mark changed), kind 'push'. A LENS OF BENT AIR travels down a narrow cone (`cone`° each side)
    //   from the hand to `reach` px in `ms` (PULL `toward`: it forms out at the far end and sweeps IN to the hand), stopped by rock. What it passes: a player thrown away from the
    //   caster (`push`, a body's speed px a tick; their keys blank for `stunMs` so it carries) — PULL: tugged so they land `stop` px in front of the caster; within `knockR` px of
    //   the hand, what is in their hands knocked out (PULL: it flies to the caster's feet); loose things × `looseK`; the liquid in the cone flung; the surface's powder in it flies
    //   (`grains` at most — server `magicPushPowder`).
    push: { name: 'Push', school: 'force', form: 'burst', tier: 0, cd: 4, stance: 'level', kind: 'push', learn: 3, reach: 260, cone: 18, ms: 260, push: 11, stunMs: 220, looseK: 1.4, knockR: 100, grains: 24, alts: ['pull'], fx: '#e6e6f0',
      plain: { keys: [R, R, D, U, R], rune: [3, 4, 8, 2, 5] } },
    pull: { name: 'Pull', school: 'force', form: 'burst', tier: 0, cd: 4, stance: 'level', kind: 'push', alt: 'push', toward: 1, reach: 260, cone: 18, ms: 320, push: 11, stop: 34, looseK: 1.4, knockR: 100, grains: 24, fx: '#e6e6f0',
      plain: { keys: [R, R, D, U, L], rune: [3, 4, 8, 2, 1] } },
    // ⭐ STEP 9b (2026-11-21) FORCE: HEAVY and its variant WEIGHTLESS (`light`), kind 'weight' — on the loose thing or player nearest the pointer within `reach` px (yourself too),
    //   `secs` s: a thing's weight / float / fall (client 16b `lbMagicWt`), a player's power 'heavy' / 'light' (their own game). LEVITATE (+ on another): a boon, the power
    //   'levitate' (client 16zj `magicBodyForce`: hovering, at most 6 cells over the ground under you).
    heavy: { name: 'Heavy', school: 'force', form: 'touch', tier: 0, cd: 8, stance: 'level', kind: 'weight', learn: 3, reach: 260, secs: 10, alts: ['weightless'], fx: '#9a7ef0',
      plain: { keys: [R, D, L, D, D], rune: [3, 7, 6, 4, 8] } },
    weightless: { name: 'Weightless', school: 'force', form: 'touch', tier: 0, cd: 8, stance: 'level', kind: 'weight', alt: 'heavy', light: 1, reach: 260, secs: 10, fx: '#ece8ff',
      plain: { keys: [R, D, L, D, U], rune: [3, 7, 6, 4, 0] } },
    levitate: { name: 'Levitate', school: 'force', form: 'self', tier: 0, cd: 12, stance: 'raise', kind: 'boon', pw: 'levitate', secs: 20, learn: 3, aim: 'self', reach: 240,
      plain: { keys: [R, U, D, U, R], rune: [5, 7, 3, 1, 2] } },
    // ⭐ STEP 9c (2026-11-21) FORCE: STASIS (kind 'stasis', on the loose thing or player nearest the pointer within `reach`, never yourself): a thing stops dead for `secs` s, the
    //   blows it takes stored and given all at once at the end (client 16b `lbStasis`); a player held at most `holdS` s, each fresh movement key `press` s off, a blow breaks it.
    //   BARRAGE (kind 'barrage', held ≤ `chanS` s): up to `n` loose things within `grab` px orbit you (`orbit` px, `spin` rad/s; driven `pull`, `vmax`); let go, they fly at the
    //   pointer `gapMs` apart at `throwV` (px a tick), each a thrown thing.
    stasis: { name: 'Stasis', school: 'force', form: 'placed', tier: 1, cd: 12, stance: 'level', kind: 'stasis', learn: 5, reach: 300, secs: 5, holdS: 1.5, press: 0.3, fx: '#e6e6f0',
      plain: { keys: [R, L, D, R, U], rune: [3, 5, 1, 7, 6] } },
    barrage: { name: 'Barrage', school: 'force', form: 'stream', tier: 1, cd: 14, stance: 'level', kind: 'barrage', learn: 5, chan: true, chanS: 8, grab: 140, n: 6, orbit: 46, spin: 4.5, pull: 0.5, vmax: 22,
      throwV: 18, gapMs: 120, fx: '#e6e6f0', plain: { keys: [R, U, L, D, R], rune: [5, 4, 0, 6, 8] } },
    // ⭐ STEP 9d (2026-11-21) FORCE: CATCH (kind 'catch', held ≤ `chanS` s): (round 2) a SHELL of bent air — part of a sphere `r` px round the staff's tip, `half`° each way from its pole (the flat disc `dist` px out behind a switch): arrows, thrown things, ice
    //   shards and spell bolts flying into it (at least `minV` px a frame) STOP and hang in it, `most` at a time, slowly turning; let go, they are flung at the pointer as yours
    //   (things at `throwV`, bolts at their own speed); any other end drops them (a bolt fizzles).
    catch: { name: 'Catch', school: 'force', form: 'stream', tier: 0, cd: 8, stance: 'level', kind: 'catch', learn: 3, chan: true, chanS: 15, dist: 30, r: 46, half: 60, most: 6, minV: 3, throwV: 18, fx: '#e6e6f0',
      plain: { keys: [R, D, R, U, D], rune: [5, 3, 7, 1, 4] } },
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
  //   own part of it as a spell's, per world, a death forgets it). It costs more keys and `cdK` × the spell's cooldown.
  //   ITS PIECE (⭐ 21 M2, 2026-11-27 — the user: modifiers need not open with a down, each FAMILY its own opening as schools have, FOUR keys): keys — its family's two (`MOD_OPEN`,
  //   never starting with an up: a tier adds ups, so the two never mix), then its own two `keys`; rune — its family's stroke, then its own `rune` stroke. NO OWN PART (the spell
  //   in front of it carries yours — a copied modifier is nothing without it). A spell grows by ONE key (a tier, a word's third key) and a piece is FOUR, so a spell + pieces can
  //   never read as a longer spell + pieces. Was (4c–M1): a down, your own key, its two; the top row, your own point, its stroke.
  //   follow  the caster's game turns it towards the pointer (`turn` radians a second, up to 3 × close to it; the client's dial overrides), `speedK` its speed, `lifeK` its time, `gravK` its gravity; others are sent where it is
  //   arc     a lob that comes down on the pointer (`g` px/s² its gravity, `reach` px the farthest point) — every screen works the same arc out of the cast (`arcAim`)
  //   split   at `at` seconds it becomes `n`, `fan` degrees apart, each `dmgK` of the blow (a SHOT's pieces each land `shotK` of its size) · faint  drawn at `seen` of its strength on others' screens, `seenOwn` on yours
  // ⭐⭐ STEP 21 M1 (2026-11-27, kickoff §'STEP 21' — the user: modifiers as WIDELY as they make sense, STACKING as many compatible ones as you like, and the table of what cannot go
  //   together must know the modifiers STILL TO COME): any number of pieces after the spell (up to `MOD_MAX`), in ANY ORDER; the cooldown × every piece's `cdK`.
  //   fits   the ways of DELIVERY it goes on (`delivOf`): 'fly' a thing that flies and ends (a bolt; a SHOT — freeze, the walls, Earth's changes, the tunnelling bolt, the fire
  //          walls) · 'thrown' a real thing flown (the ice shard, a ball of water, a chunk of ground) · 'held' a held spell (stream, beam, jet) · 'placed' made where you point ·
  //          'round' round you · 'self' on yourself · 'touch' on the one nearest the pointer · 'paint' painted with the pointer
  //   group  at most ONE of each group in a cast: 'path' what steers it · 'fall' what pulls it down · 'size' · 'pace' its speed · 'wall' what it does at rock · 'body' what it
  //          does at a body · 'wait' what holds it back before it goes
  //   clash  further ones it never goes with · rep  how many times it may be put in (each one more of it; 1 = once) · hit  only on a bolt that stops at bodies
  //   A spell's `noMods` = ones that would mean nothing on it (the tunnelling bolt goes through rock already).
  const MODS = {
    mod_follow: { name: 'Follows the pointer', keys: [R, L], rune: [2, 4], fits: ['fly'], group: ['path'], clash: ['mod_heavy'], cdK: 1.5, learn: 3, turn: 16, speedK: 0.7, lifeK: 3.5, gravK: 0.3 },   // (21 M1 round 2, the user: it ran out too soon — lifeK 2 → 3.5: a firebolt follows ~3.7 s)
    mod_arc:    { name: 'Arcs', keys: [U, R], rune: [2, 5], fits: ['fly'], group: ['path', 'fall'], noPiece: 1, cdK: 1.5, learn: 3, g: 1100, reach: 560 },
    mod_split:  { name: 'Splits in three', keys: [L, R], rune: [6, 5], fits: ['fly'], noPiece: 1, cdK: 1.5, learn: 3, n: 3, at: 0.05, fan: 10, dmgK: 0.45, shotK: 0.6 },
    mod_faint:  { name: 'Faint', keys: [D, D], rune: [0, 5], fits: ['fly'], cdK: 1.25, learn: 3, seen: 0.22, seenOwn: 0.5 },
    // ⭐ M2 (2026-11-27 — the user's four):
    //   bounce   off rock (and a level's floor) up to `n` times, `keep` of its speed each time, its time × `lifeK`; a lobbed wall / fire wall bounces on the ground before it stands
    //   thru     through up to `cells` cells of rock, then as ever (a lobbed wall or fire wall would come down inside the ground — `noLob`)
    //   delay    it waits `secs` where it was cast, then goes (put in again: longer — up to `rep`); placed spells and spells round you take it LATER (`later`)
    //   cluster  where it ends it bursts into `n` small pieces over `fan` degrees, back the way it came (up, in the air): each `speedK` of its speed, `life` s, `dmgK` of the blow
    //            at `powK` of its strength; a shot's pieces land `shotK` of its size
    mod_bounce:  { name: 'Bounces', keys: [U, D], rune: [0, 5], fits: ['fly'], later: ['thrown'], group: ['wall'], cdK: 1.5, learn: 3, n: 3, keep: 0.75, lifeK: 1.6 },
    mod_thru:    { name: 'Through walls', keys: [R, R], rune: [2, 4], fits: ['fly'], group: ['wall'], noLob: 1, cdK: 2, learn: 3, cells: 10 },
    mod_delay:   { name: 'Delayed', keys: [D, D], rune: [2, 4], fits: ['fly'], later: ['placed', 'round'], group: ['wait'], rep: 3, cdK: 1.25, learn: 3, secs: 2.5 },   // (M2 round 3, the user: a bit longer — 1.5 → 2.5 s a piece)
    mod_cluster: { name: 'Cluster', keys: [U, D], rune: [7, 5], fits: ['fly'], maker: 1, cdK: 1.5, learn: 3, n: 5, fan: 150, speedK: 0.55, life: 0.45, dmgK: 0.5, powK: 0.6, shotK: 0.4 },
  };
  // (21 M1) THE MODIFIERS TO COME — no keys, no page, not castable: only the rules (`modFits`, `modClash`, `modsOk`) know them, so what is built now already leaves room for them
  const MOD_PLAN = {
    mod_bigger:    { name: 'Bigger', fits: ['fly', 'thrown', 'held', 'placed', 'round'], group: ['size'], rep: 2, cdK: 1.5 },
    mod_smaller:   { name: 'Smaller', fits: ['fly', 'thrown', 'held', 'placed', 'round'], group: ['size'], rep: 2, cdK: 1.2 },
    mod_pierce:    { name: 'Pierces', fits: ['fly'], group: ['body'], hit: 1, cdK: 1.5 },
    mod_chain:     { name: 'Chains', fits: ['fly'], group: ['body'], hit: 1, cdK: 2 },
    mod_explode:   { name: 'Bursts on hitting', fits: ['fly'], group: ['body'], hit: 1, cdK: 1.5 },
    mod_homing:    { name: 'Homing', fits: ['fly'], group: ['path'], clash: ['mod_heavy'], cdK: 2 },
    mod_boomerang: { name: 'Comes back', fits: ['fly', 'thrown'], group: ['path'], cdK: 1.5 },
    mod_orbit:     { name: 'Circles you', fits: ['fly'], group: ['path', 'wait'], clash: ['mod_wavy'], cdK: 1.5 },
    mod_wavy:      { name: 'Wavy', fits: ['fly'], cdK: 1.25 },
    mod_faster:    { name: 'Faster', fits: ['fly', 'thrown'], group: ['pace'], rep: 2, cdK: 1.25 },
    mod_slower:    { name: 'Slower', fits: ['fly'], group: ['pace'], rep: 2, cdK: 1.25 },
    mod_accel:     { name: 'Speeds up', fits: ['fly'], group: ['pace'], cdK: 1.25 },
    mod_heavy:     { name: 'Heavy', fits: ['fly', 'thrown'], group: ['fall'], cdK: 1.25 },
    mod_weightless: { name: 'Weightless', fits: ['fly', 'thrown'], group: ['fall'], cdK: 1.25 },
    mod_trail:     { name: 'Leaves a trail', fits: ['fly'], cdK: 1.5 },
    mod_hang:      { name: 'Hangs, then flies', fits: ['fly'], group: ['wait'], cdK: 1.25 },
    mod_double:    { name: 'Twice', fits: ['fly'], cdK: 1.75 },
    mod_trigger:   { name: 'Casts the next where it lands', fits: ['fly', 'placed'], cdK: 1.5 },
    mod_lasting:   { name: 'Lasts longer', fits: ['fly', 'thrown', 'held', 'placed', 'round', 'self'], rep: 2, cdK: 1.5 },   // (21 M1 round 3, the user: a firebolt flies longer before it fizzles — with follows, longer steered)
  };
  const MOD_MAX = 6;   // (21 M1) the most pieces a cast takes — the input time and the cooldowns are the real limit; this only stops nonsense (M3: in ONE GENERATION)
  const MOD_TOTAL = 40;   // (21 M3) …and in the whole cast, any number of generations (the user: no limit — the input itself limits it; this only stops nonsense)
  const isMod = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(MODS, id);
  const modOf = (id) => isMod(id) ? MODS[id] : null;
  const modAny = (id) => isMod(id) ? MODS[id] : (typeof id === 'string' && Object.prototype.hasOwnProperty.call(MOD_PLAN, id) ? MOD_PLAN[id] : null);
  const modList = (m) => Array.isArray(m) ? m : (m ? [m] : []);
  // (21 M1 round 2, the user: the modifiers told apart on the rings by what they do) each one's FAMILY — its colour where its marks are drawn and on its page (16zj `MAGIC_MOD_FAMS`):
  //   path steering it · many more of it · seen how it is seen · wait holding it back · size · pace its speed · fall its weight · wall at rock · body at a body · more anything else
  const MOD_FAM = { mod_follow: 'path', mod_arc: 'path', mod_homing: 'path', mod_boomerang: 'path', mod_orbit: 'path', mod_wavy: 'path', mod_split: 'many', mod_cluster: 'many', mod_double: 'many',
    mod_faint: 'seen', mod_delay: 'wait', mod_hang: 'wait', mod_bigger: 'size', mod_smaller: 'size', mod_faster: 'pace', mod_slower: 'pace', mod_accel: 'pace', mod_heavy: 'fall', mod_weightless: 'fall',
    mod_bounce: 'wall', mod_thru: 'wall', mod_pierce: 'body', mod_chain: 'body', mod_explode: 'body', mod_trail: 'more', mod_trigger: 'more', mod_lasting: 'more' };
  for (const id in MOD_FAM) { const M = modAny(id); if (M) M.fam = MOD_FAM[id]; }
  // ⭐ (21 M2) EACH FAMILY'S OPENING — two keys (never an up first) and a stroke across the grid, as a school's: steering → ↑ up and away · more of it ← → spread · how it is seen
  //   ← ← · holding back ↓ ← · size → ← · speed → → · weight ↓ ↓ · at rock ↓ → · at a body → ↓ · anything else ↓ ↑. The STROKES (one straight line each, starting only on 1 or 3 or 4: every other point
  //   either lies straight on from some spell's last line (it would merge into it) or turns one spell's rune into another's — cool lava + 5 = grease, firebolt + 7 = great firebolt) and the modifiers' own were FOUND BY A SEARCH: no piece goes back over its own line, none where one piece runs into the next, every piece
  //   its own path (`scratchpad/probe_mod_stack.js` checks; a new modifier's stroke must keep it so)
  const MOD_OPEN = { path: { keys: [R, U], rune: [3, 1] }, many: { keys: [L, R], rune: [3, 2] }, seen: { keys: [L, L], rune: [1, 6] }, wait: { keys: [D, L], rune: [3, 8] },
    size: { keys: [R, L], rune: [1, 4] }, pace: { keys: [R, R], rune: [1, 5] }, fall: { keys: [D, D], rune: [1, 8] }, wall: { keys: [D, R], rune: [1, 3] }, body: { keys: [R, D], rune: [3, 7] },
    more: { keys: [D, U], rune: [3, 5] } };
  // (21 M1) HOW A SPELL IS DELIVERED (what `fits` means) — by its kind and form
  const SHOT_KINDS = ['freeze', 'wall', 'change', 'tunnel', 'firewall'], THROWN_KINDS = ['shard', 'waterball', 'chunk'], PAINT_KINDS = ['paint', 'rainbow'];
  const isShot = (S) => !!S && SHOT_KINDS.indexOf(S.kind) >= 0 && S.speed > 0;
  const delivOf = (S) => { if (!S || S.innate) return null; if (S.kind === 'bolt' || isShot(S)) return 'fly'; if (THROWN_KINDS.indexOf(S.kind) >= 0) return 'thrown';
    if (PAINT_KINDS.indexOf(S.kind) >= 0) return 'paint'; if (S.chan) return 'held'; if (S.form === 'touch') return 'touch'; if (S.form === 'burst' || S.aim === 'self') return 'round';
    if (S.form === 'self') return 'self'; return 'placed'; };
  const modFits = (mid, spell) => { const M = modAny(mid), S = SPELLS[spell] && Object.prototype.hasOwnProperty.call(SPELLS, spell) ? SPELLS[spell] : null; if (!M || !S || S.innate) return false;
    if (M.fits.indexOf(delivOf(S)) < 0 || (S.noMods && S.noMods.indexOf(mid) >= 0)) return false;
    if (M.noLob && (S.kind === 'wall' || S.kind === 'firewall')) return false;   // (21 M2) through walls: not a stone or ember that must come down on the ground
    return !(M.hit && (S.kind !== 'bolt' || S.thru)); };
  // two modifiers that never go together: one of the same group, or named in a `clash` (either way round). The same one twice is a repeat (`rep`), not a clash
  const modClash = (a, b) => { if (a === b) return false; const A = modAny(a), B = modAny(b); if (!A || !B) return true;
    if ((A.clash || []).indexOf(b) >= 0 || (B.clash || []).indexOf(a) >= 0) return true; for (const g of A.group || []) if ((B.group || []).indexOf(g) >= 0) return true; return false; };
  // ⭐ (21 M3, 2026-11-28 — the user: the ORDER matters) THE GENERATIONS of a cast: read left to right, a modifier shapes what it comes after; one that MAKES new things (`maker`:
  //   the cluster; later the triggers that chain the next spell) ends a generation — everything after it shapes what it makes, everything before it the one that made them.
  //   Nothing carries over unless put in again (bounce · cluster · bounce: both bounce). Split is a COPY (at the launch: the spell itself in three), not a maker. No limit on
  //   how many generations. → [[…the spell's], [after the 1st maker…], …]
  const modGens = (list) => { const g = [[]]; for (const q of list || []) { g[g.length - 1].push(q); const M = modAny(q); if (M && M.maker) g.push([]); } return g; };
  // a list of modifiers on a spell, generation by generation: each fits (a later generation is PIECES — they fly; not one that needs the spell's own aim, `noPiece`), none put
  //   in more often than its `rep`, no two that clash, no more than `MOD_MAX` — WITHIN its generation (the same one may come again after a maker); no more than `most` (and
  //   `MOD_TOTAL`) in all
  const modsOk = (spell, list, most) => { if (!Array.isArray(list) || list.length > Math.min(MOD_TOTAL, most || MOD_TOTAL)) return false; const G = modGens(list);
    for (let gi = 0; gi < G.length; gi++) { const L = G[gi], n = {}; if (L.length > MOD_MAX) return false;
      for (let i = 0; i < L.length; i++) { const id = L[i], M = modAny(id); if (!M || !modFits(id, spell) || (gi > 0 && (M.noPiece || M.fits.indexOf('fly') < 0))) return false;
        n[id] = (n[id] || 0) + 1; if (n[id] > (M.rep || 1)) return false; for (let j = 0; j < i; j++) if (modClash(id, L[j])) return false; } }
    return true; };
  // every way the modifiers in `mods` may follow a spell, in every order, up to `most` long (with none first) — for reading a rune drawn freely
  const modSeqs = (spell, mods, most) => { const out = [[]], lim = Math.min(MOD_TOTAL, most || MOD_TOTAL), go = (cur) => { if (cur.length >= lim) return;
    for (const md of mods || []) { const nx = cur.concat([md]); if (!modsOk(spell, nx, lim)) continue; out.push(nx); go(nx); } }; go([]); return out; };
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
    gust: [[U, D], [1, 5, 7, 3, 1]], feather: [[D, U], [4, 6]],
    lightning: [[R, R], [4, 5]], calllightning: [[U, L], [4, 1, 3, 7]], thunderstorm: [[L, L], [4, 1, 0, 3]], thunderclap: [[D, D], [4, 3, 1, 5]], windshield: [[D, L], [4, 7]], whirlwind: [[L, U], [4, 3, 0, 1]], updraft: [[U, U], [4, 1]], balllightning: [[D, R], [4, 7, 5]], stormblade: [[U, R], [4, 1, 2]],   // (8b: round you, as the flame ring / cold snap · the on-another turned → and on to the top right)   // (8a: the bolt ending · up into the sky, then a zigzag down)
    stonewall: [[U, U], [4, 7]],
    crumble: [[L, D], [4, 6]], harden: [[L, U], [4, 0]], glassify: [[D, L], [4, 3]], coollava: [[D, R], [4, 2]], mend: [[U, L], [4, 1]], grease: [[U, R], [4, 2, 5]],
    rockchunk: [[L, R], [4, 3, 5]], soilfling: [[L, L], [4, 6, 3]], tunnelbolt: [[R, R], [4, 5]], quake: [[D, D], [4, 7, 8]],
    spikes: [[U, D], [4, 1, 5]], pillar: [[D, U], [4, 7, 1]], bridge: [[R, L], [4, 0, 2]],   // (5d: a peak ∧ · down into the ground and up · out and across)
    lift: [[L, R], [4, 2]], leap: [[U, U], [4, 1]],
    push: [[R, R], [4, 5]], pull: [[R, L], [4, 3]],
    heavy: [[L, D], [4, 6, 7]], weightless: [[L, U], [4, 0, 1]], levitate: [[U, D], [4, 7, 1]], stasis: [[D, L], [4, 8, 2]], barrage: [[D, D], [4, 0, 2, 5]], catch: [[D, R], [4, 8, 6]],   // (9b: pressed down / lifted, mirrored, as grow and shrink · up off the ground, as the rising pillar)   // (9a: sent at the pointer, the bolt ending · the same line back towards you)
    haste: [[L, L], [3, 5]],
    // (10a) Space's stroke runs straight through the middle (2 → 4 → 6), so no word may go 4 → 2 (it would fold into the school's line): blink up, out and up · straight up
    blink: [[U, R], [4, 5, 2]], passthrough: [[U, U], [4, 1]],
    // (10b) set down · and back up out of it, mirrored · back and up, a hook turned back
    mark: [[D, D], [4, 7, 6]], recall: [[D, U], [4, 7, 8]], rewind: [[L, U], [4, 3, 0]],
    // (10c) this side for that side · back and down into the hand · rewind's, its first mark turned → and on to the top right
    swap: [[L, R], [4, 3, 5]], callback: [[L, D], [4, 5, 3]], rewind_o: [[R, U], [4, 3, 0, 2]],
    // (10d) a door's outline: up its side, along the bottom, up the other side
    doorways: [[U, D], [4, 0, 6, 8, 2]],
    // (10e) down into it and away — folded into a corner
    pocket: [[D, R], [4, 8, 6]],
    rune: [[D, L], [4, 7]], fireward: [[U, L], [4, 6]],
    // (11a) raised over you · the on-another's one more mark to the top right · back the way it came
    wardskin: [[U, U], [4, 1]], mirror: [[L, R], [4, 3, 5]],
    // (11b) a line stood up · round you, as the flame ring
    wardline: [[D, U], [4, 7, 1]], warddome: [[D, D], [4, 3, 1, 5]],
    // (11c) a ring on the ground · a slash through the middle
    nullcircle: [[R, D], [4, 5, 7, 3]], dispel: [[D, R], [4, 2, 6]],
    // (11d) a flag raised · a hook closed round it
    alarm: [[U, R], [4, 5, 1]], seal: [[L, D], [4, 3, 7]],
    // (12a) close wounds as before · on another, its first mark turned → and on to the top right · cure lifted off you (and on another) · the grove: down to the ground, along it and up
    closewounds: [[D, D], [4, 6]], cure: [[U, L], [4, 0]], grove: [[D, R], [4, 8, 6, 3]],
    // (12b) entangle round and up · the thorn hedge out along and down · barkskin raised over you, as the ward skin's keys
    entangle: [[L, U], [4, 3, 1]], thorns: [[L, D], [4, 5, 8]], barkskin: [[U, U], [4, 3, 0]],
    // (12c) the vine up to the rock, then hanging down · the tree into the soil, then straight up · regrow out and up
    vine: [[U, D], [4, 2, 8]], tree: [[D, U], [4, 8, 2]], regrow: [[U, R], [4, 5, 2]],
    // (12c round 3) the swing vine: up to the rock, then swinging down to the side
    vine_s: [[D, L], [4, 2, 6]],
    grow: [[L, U], [4, 1]], shrink: [[L, D], [4, 7]],
    // (15a) stone closing over you, from the top down the side (on another: and across to them) · fins: the stroke side to side, a fin's curve · night eyes: up to the eyes, across them
    stoneskin: [[D, D], [4, 0, 3]], fins: [[R, L], [4, 3, 0]], nighteyes: [[U, U], [4, 0, 2]], gaseous: [[U, L], [4, 1, 0]], rubber: [[D, U], [4, 7, 8]], petrify: [[R, D], [4, 5, 8]], jelly: [[L, R], [4, 3, 6]],
    // (15c) spider climb: along to the wall and up it (a tier up) · mend gear: a stitch down and across, drawn shut
    spider: [[R, U], [4, 1, 2]], mendgear: [[D, R], [4, 6, 3]],
    // (13a) the venom bolt, the bolt ending · the cloud down and rolling out low · the pods down into the soil and up out of it · plague, its first mark → (towards them) and spreading out
    venombolt: [[R, R], [4, 5]], pcloud: [[D, L], [4, 3, 6]], spores: [[D, U], [4, 8, 5]], plague: [[R, L], [4, 3, 2]],
    // (13b) the curse laid over them, on to the top right · wither pulled down, then up and off to them · the bone spear, the bolt ending (a tier up: as great firebolt)
    curse: [[R, U], [4, 0, 2]], wither: [[R, U], [4, 8, 2]],
    // (13c) rot spreading down and along the ground · rust laid straight on them, to the top right
    rot: [[D, R], [4, 6, 8]], rust: [[R, D], [4, 2]],
    // (13c round 2) weathering: cracks running up through the rock and off to the side
    weather: [[D, D], [4, 1, 2]],
    // (14a) blood: the bolt as every bolt · the drain reached out, then drawn back down to you (a tier up: the underline) · the transfusion up and over to them
    bloodbolt: [[R, R], [4, 5]], lifedrain: [[L, D], [4, 3, 6]], transfusion: [[U, R], [4, 1, 2]],
    // (14b) haemorrhage: out to them and up, opened · blood boil: rising straight up · leeches: out and up onto them
    haemorrhage: [[L, U], [4, 0, 1]], bloodboil: [[U, U], [4, 1]], leeches: [[R, U], [4, 2]],
    // (14c) the shield laid down round you · spikes down into the ground and up · the grip reached out and drawn back · the whip cracked out and up
    bloodshield: [[D, D], [4, 6]], bloodspikes: [[D, U], [4, 0, 5]], bloodgrip: [[L, L], [4, 0, 2]], bloodwhip: [[R, L], [4, 8, 2]],
    double: [[D, D], [4, 6]], double_m: [[D, L], [4, 7]],
    // (16a) unseen: up over you and away · chameleon: out to the side and back down into it · the guise: down into a box · the veil drawn over the thing and down · the dome up round its side and over
    unseen: [[U, D], [4, 0, 1]], chameleon: [[L, L], [4, 3, 6]], guise: [[D, R], [4, 8, 5]], veil: [[R, U], [4, 2, 1]], hiding: [[L, D], [4, 3, 0, 1]],
    // (16b) disguise: a mask pulled up and over · two faces: the same turned → to them, on to the top right · mirror images: out, up over you and down the other side ·
    //   displacement: stepped aside and up · fake death: falling to the ground and toppled back · mislead: off and on, away from where you were
    disguise: [[U, L], [4, 1, 0]], twofaces: [[R, L], [4, 1, 2]], images: [[L, R], [4, 3, 1, 5]], displace: [[U, R], [4, 5, 2]], fakedeath: [[D, U], [4, 7, 3]], mislead: [[U, U], [4, 2, 5]],
    // (16c) the false wall: down to the ground and up its face · unseen rock: pushed in and up through it · the phantom thing: out to the thing and drawn back along the top
    falsewall: [[R, D], [4, 8, 2]], hiderock: [[R, R], [4, 5, 1]], phantom: [[R, U, L], [4, 2, 0]],
    // (16d) colour spray: fanned out across the top · shroud: drawn down and round them · phantasms: figures stood round you, down, along, up and across · bewilder: round the head
    // (16e) fear: shrinking back up and away · calm: smoothed across the top and laid down · charm: drawn in to you, a heart
    fear: [[L, D, R], [4, 5, 2, 1, 3]], calm: [[R, L, R], [4, 0, 2, 5, 3]], charm: [[U, R, D], [4, 1, 0, 3, 7, 5, 2]],
    colourspray: [[L, U], [4, 5, 2, 1, 0]], shroud: [[D, R, L], [4, 5, 8, 7, 3]], phantasms: [[D, L, D], [4, 7, 6, 3, 5]], bewilder: [[U, L, R], [4, 1, 5, 7, 3]],
    // (17a) true sight: up to the eyes
    truesight: [[U, U], [4, 1]],
    // (17b) through the stone: down into it and out the far side · seek: spread out over the top; water: along the bottom; life: back across the top
    throughstone: [[D, U], [4, 7, 2]], seek: [[L, R], [4, 0, 2]], seek_w: [[L, D], [4, 6, 8]], seek_l: [[L, U], [4, 2, 0]],
    // (17c) the far eye: sent up and away over the top · the mark: laid on them, its first mark turned → and on to the top right
    fareye: [[U, R], [4, 1, 2]], seekmark: [[R, U], [4, 5, 2]],
    // (17d) read: along a line and down the page · foresight: back, up over the top and down ahead to where it lands · the way out: down into the dark, then up and out
    read: [[R, D], [4, 5, 8]], foresight: [[R, R], [4, 3, 1, 5]], wayout: [[U, L], [4, 7, 3, 0]],
    // (19) the bound tool: down to the hand and up the haft · the blade as the flaming weapon's (up and along) · the spirit step: down to it, then along it
    // (19 round 2) the weapons: up into the hand, then — the axe's head back · the spear straight on, then out · the mace's head down · the shield across before you
    boundtool: [[D, U], [4, 8, 2]], boundblade: [[U, R], [4, 1, 2]], spiritstep: [[D, R], [4, 7, 8]],
    boundaxe: [[U, L], [4, 1, 0]], boundspear: [[U, U], [4, 1, 5]], boundmace: [[U, D], [4, 1, 3]], boundshield: [[R, U], [4, 5, 2]],
    // (19 round 5) the bow: drawn back along its curve
    boundbow: [[D, D], [4, 3, 6]],
    lightorb: [[D, L], [4, 7]], lightorb_f: [[D, D], [4, 6]],
    flash: [[U, R], [4, 1, 2]], darkness: [[L, D], [4, 3, 6]], daylight: [[U, U], [4, 1]], sunbolt: [[R, R], [4, 5]], sunbeam: [[R, D], [4, 8]],   // (20b: the shared bolt and stream endings)
    fireworks: [[U, L], [4, 1, 0]], display: [[L, U], [4, 3, 0]], rainbow: [[L, R], [4, 3, 1, 5]], beacon: [[D, U], [4, 0, 1]], snuff: [[D, R], [4, 0, 3]],
    lightbrush: [[R, U], [4, 1, 5, 8]], sparkler: [[U, D], [4, 3, 7]], aurora: [[L, L], [4, 1, 3]], stamps: [[R, L], [4, 3, 1, 0]], colourwash: [[D, U, D], [4, 7, 8, 5]],   // (20d: the last four two-key words of Light; the wash in Illusion)   // (20c: up and off · its variant the other way round · an arch over · down, then up · in and out; strokes off the middle no other Light word starts with)   // (20a: up and out, a burst · down into the dark · straight up, a sun)
  };
  for (const id in WORDS) if (SPELLS[id]) SPELLS[id].word = { keys: WORDS[id][0], rune: WORDS[id][1] };
  SPELLS.shrink.school = 'alteration';   // (grow and shrink one school — the user)
  SPELLS.tunnelbolt.noMods = ['mod_thru'];   // (21 M1) it bores through rock already
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
  const modOwnOf = (mid, h) => { if (MOD_OWN_OFF) return null; const M = modOf(mid); if (!M) return null; h = Math.abs(Math.floor(h)); const L0 = runeNorm([0, 2].concat(M.rune)).length, ok = [];
    for (let p = 3; p < 9; p++) { if (p === M.rune[0]) continue; if (runeNorm([0, 2, p].concat(M.rune)).length === L0 + 1) ok.push(p); }
    return { k: h & 3, p: ok.length ? ok[(h >> 2) % ok.length] : null }; };
  // (4c) a modifier's piece alone: keys (the opening down, your own key, its two) · its rune (the top row, your own point, its stroke; `own` = where your point is)
  //   (21 M2) the family's opening + its own two, no own part (`MOD_OWN_OFF`; the old opening kept behind it for a switch back)
  const MOD_OWN_OFF = true;
  const modKeys = (mid, own) => { const M = modOf(mid); if (!M) return null; const F = M.fam && MOD_OPEN[M.fam]; if (MOD_OWN_OFF && F) return F.keys.concat(M.keys);
    const k = [D]; if (own && own.k != null) k.push(own.k & 3); return k.concat(M.keys); };
  const modRune = (mid, own) => { const M = modOf(mid); if (!M) return null; const F = M.fam && MOD_OPEN[M.fam]; if (MOD_OWN_OFF && F) return { pts: F.rune.concat(M.rune), own: null };
    const pts = [0, 2]; let o = null; if (own && own.p != null) { o = 2; pts.push(own.p); } return { pts: pts.concat(M.rune), own: o }; };
  // the keys of a spell: `lang` = school + form (+ an "up" a tier), else its plain sequence; `own` (from `ownOf`) put in after the first two. (4c) `mod` = a modifier put in after
  //   it, `modOwn` its own part · a MODIFIER's id alone = its piece alone (what its page practises)
  //   (21 M1) `mod` may be a LIST (each piece after the last), `modOwn` then the list of their own parts
  const keysOf = (id, lang, own, mod, modOwn) => { if (isMod(id)) return modKeys(id, own); const k0 = keysCore(id, lang, own), ms = modList(mod); if (!k0 || !ms.length) return k0;
    const mo = Array.isArray(modOwn) ? modOwn : [modOwn]; let k = k0; for (let i = 0; i < ms.length; i++) { const mk = modKeys(ms[i], mo[i] || null); if (!mk) return null; k = k.concat(mk); } return k; };
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
    const R0 = runeSpell(id, lang, own), ms = modList(mod); if (!R0 || !ms.length) return R0; const mo = Array.isArray(modOwn) ? modOwn : [modOwn];
    let pts = R0.pts, first = null; const at = [];   // (21 M1) one stroke after another; `mods` = where each begins
    for (let i = 0; i < ms.length; i++) { const Q = modRune(ms[i], mo[i] || null); if (!Q) return null; at.push(pts.length); if (i === 0) first = Q.own != null ? pts.length + Q.own : null; pts = pts.concat(Q.pts); }
    return Object.assign({}, R0, { pts, mod: at[0], modOwn: first, mods: at }); };
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
  const ownFor = (id, lang, ownH) => ownH ? ownOf(id, lang, ownH(id)) : null;
  // points joined so far → the same answers. (step 2) A point just passed over on the way to the next — 8 → 6 runs over 7 — is not wrong yet: the stroke is still going
  const midOf = (a, b, c) => a !== c && (a % 3) + (c % 3) === 2 * (b % 3) && Math.floor(a / 3) + Math.floor(c / 3) === 2 * Math.floor(b / 3);
  // ⭐ (21 M1) STACKING: one reader for keys and runes. Each spell's own input first; once it is all there, what follows is read as modifier PIECES, one after another, in any
  //   order — each one that fits, may be added (`modsOk`), and the input so far still agrees with — so the reading is a short walk, never every combination.
  //   → { spell, mods (the list put in), mod (the first, as before), more, moreOf } · { more, moreOf } · null. `most` = how many pieces at most (the panel's switch: 1)
  //   (a rune: the input and each whole input normalised, `runeNorm`; the last point of a piece may be passed over by the next piece's line, so a piece is gone on into when
  //   all of it but its last point agrees)
  const matchIn = (rune) => (seq, lang, ids, ownH, mods, most) => {
    const have = rune ? runeNorm(seq) : seq, enc = rune ? runeNorm : (q) => q; let more = false, spell = null, got = null; const moreOf = [];
    const cmp = (want) => { if (want.length < have.length) return null; for (let i = 0; i < have.length; i++) if (want[i] !== have[i]) return rune && i === have.length - 1 && i > 0 && midOf(have[i - 1], have[i], want[i]) ? 'part' : null; return want.length === have.length ? 'full' : 'part'; };
    const lead = (want) => { const n = want.length - 1; if (have.length <= n) return false; for (let i = 0; i < n; i++) if (have[i] !== want[i]) return false; return true; };
    const canMore = (id, list) => (mods || []).some(md => modsOk(id, list.concat([md]), most));
    const noteMore = (id) => { more = true; if (moreOf.indexOf(id) < 0) moreOf.push(id); };
    const walk = (id, raw, list) => { for (const md of mods) { const nl = list.concat([md]); if (!modsOk(id, nl, most)) continue; const mo = ownFor(md, lang, ownH);
      const pc = rune ? (modRune(md, mo) || {}).pts : modKeys(md, mo); if (!pc) continue; const r2 = raw.concat(pc), want = enc(r2), c = cmp(want);
      if (c === 'full') { if (!spell) { spell = id; got = nl; } if (canMore(id, nl)) noteMore(id); } else if (c === 'part') noteMore(id); else if (lead(want)) walk(id, r2, nl); } };
    for (const id of ids || castable()) { const own = ownFor(id, lang, ownH), base = rune ? (runeOf(id, lang, own) || {}).pts : keysOf(id, lang, own); if (!base) continue;
      const want = enc(base), c = cmp(want), mm = !!mods && mods.length > 0 && !isMod(id);
      if (c === 'full') { if (!spell) { spell = id; got = []; } if (mm && canMore(id, [])) noteMore(id); }
      else if (c === 'part') more = true;
      else if (mm && lead(want)) walk(id, base, []); }
    return spell ? { spell, mods: got, mod: got[0] || null, more, moreOf } : more ? { more: true, moreOf } : null; };
  // keys so far → { spell } when they are exactly a spell's (and `more` too when a longer spell also begins with them — firebolt is the start of great firebolt) ·
  //   { more: true } while some spell still begins with them · null = wrong. `ownH(id)` = that spell's own number, or null · (4c) `mods` = the modifiers that may follow ·
  //   a modifier's id in `ids` = its piece alone
  const matchKeys = matchIn(false);
  const matchRune = matchIn(true);
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
  const cdMs = (id, cat, mod) => { const S = of(id), C = CATALYSTS[cat]; if (!S) return 0; let k = 1; for (const m of modList(mod)) { const M = modOf(m); if (M) k *= M.cdK || 1; }   // (4c: × a modifier's; 21 M1: × every one put in)
    return Math.round(S.cd * 1000 * (C ? C.cdK : 1) * k); };
  // (4c) THE LOB (the arc modifier): from x, y it comes down on tx, ty — the time by how far (never under 0.45 s), the gravity the modifier's. Every screen works out the same
  const arcAim = (S, M, x, y, tx, ty) => { const dx = tx - x, dy = ty - y, g = (M && M.g) || 1100, T = Math.max(0.45, Math.min(1.8, Math.hypot(dx, dy) / Math.max(80, ((S && S.speed) || 600) * 0.75)));
    return { vx: dx / T, vy: (dy - 0.5 * g * T * T) / T, g, T, life: T + 0.6 }; };
  // (step 3a) the spell a variant belongs to (learnt with it, its own part the same): the light orb that follows → the light orb
  const baseOf = (id) => { const S = of(id); return S && S.alt && is(S.alt) ? S.alt : id; };
  const learnN = (id) => { if (isMod(id)) return Math.max(1, MODS[id].learn || 3); const S = of(baseOf(id)); return S ? Math.max(1, S.learn || (S.tier ? 5 : 3)) : 0; };
  const tomeOf = (item) => typeof item === 'string' && Object.prototype.hasOwnProperty.call(TOMES, item) ? TOMES[item] : null;
  const scrollOf = (item) => typeof item === 'string' && Object.prototype.hasOwnProperty.call(SCROLLS, item) ? SCROLLS[item] : null;
  return { SCHOOLS, FORMS, SPELLS, CATALYSTS, TOMES, SCROLLS, MODS, MOD_PLAN, MOD_MAX, MOD_TOTAL, MOD_OPEN, modGens, is, of, isMod, modOf, modAny, modFits, modClash, modsOk, modSeqs, modList, delivOf, isShot, arcAim, ownOf, keysOf, runeOf, runeNorm, matchKeys, matchRune, pathFit, runeDist, castable, cdMs, learnN, baseOf, tomeOf, scrollOf };
});
