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
  // (step 3h, the user: "add a contents page to the master tome … the tabs should probably just be for each school and the spells should be arranged by schools") its first page
  //   is the CONTENTS (`contents`: no spell — the client lists the schools and their spells there, each a link), then the spells school by school, in the schools' order
  TOMES.tome_master.pages.push({ contents: true });
  for (const sc of Object.keys(SCHOOLS)) for (const id of Object.keys(SPELLS)) if (!SPELLS[id].innate && !SPELLS[id].alt && SPELLS[id].school === sc) TOMES.tome_master.pages.push({ spell: id });
  for (const id of Object.keys(MODS)) TOMES.tome_master.pages.push({ mod: id });   // (4c) the modifiers after the spells, a page each
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
    else { k = SCHOOLS[S.school].keys.concat(FORMS[S.form].keys); for (let i = 0; i < (S.tier || 0); i++) k.push(U); }
    if (own && own.k != null) k.splice(2, 0, own.k & 3);
    return k; };
  // …and its rune, as ONE path through the nine points (the school's stroke, on to the form's, then one UNDERLINE a tier — bottom left to bottom right). `parts` = where the form's
  //   stroke begins (after the own point, when there is one)
  const runeCore = (id, lang) => { const S = of(id); if (!S || S.innate) return null;
    if (!lang) return S.plain ? { pts: S.plain.rune.slice(), parts: Math.min(3, S.plain.rune.length) } : null;
    const a = SCHOOLS[S.school].rune, b = FORMS[S.form].rune, pts = a.concat(b[0] === a[a.length - 1] ? b.slice(1) : b);
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
