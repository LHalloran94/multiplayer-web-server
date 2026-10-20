// ==============================================================================================================
//  held.js — THE THINGS YOU HOLD IN YOUR HAND, AND HOW EACH ONE BEHAVES. One entry per held thing, keyed by its
//  LOOK (the object's `look`: 'sword', 'torch', …).
//
//  This exact file runs in TWO places, the same way `materials.js` and `avatar-sim.js` do:
//    • server/index.js requires it            (which looks are held things, which stick where they land, which burn)
//    • the extension bundle inlines it        (build.js / dev/serve.js prepend it → `self.MWHeld`; the wielding code
//                                              in 16n/16m/16o/16p/16k reads every difference between items from here)
//  ⚠️ ONE TABLE, TWO READERS — nothing here may be re-declared on either side.
//
//  ⭐⭐ WHY IT EXISTS (the user, 2026-10-14, `scratchpad/kickoff_held_items_plan.md` §5): before any new item, the sword's
//  and the torch's differences were moved out of the code ("is this the torch?" checks, about a dozen of them) and into
//  this list, WITH NO CHANGE IN PLAY, so that a new item is mostly a new entry here. Every held item uses one family of
//  controls (scheme P); an entry says which of its actions this item has and how big, heavy and where-held it is.
//  What is NOT here, because it is art rather than a setting: how an item is DRAWN (16b `drawStampLook`, one branch per
//  look) and its flame (16k). A new item needs a drawing there and an entry here.
//  ⚠️ The object physics' main step is close to V8's size limit (`scratchpad/probe_bytecode_size.js`): new behaviour for
//  an item should be a setting the existing code reads, not another branch inside that step.
//
//  Items in the pouch (server/items.js) point at an entry here for their shape (`objOf`), so a sword's size is written
//  once whether it came out of a pouch or from the debug panel's give-me button.
// ==============================================================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root || (typeof self !== 'undefined' ? self : globalThis)).MWHeld = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ── WHAT EACH SETTING MEANS ──────────────────────────────────────────────────────────────────────────────
  //  Its shape (the object made when it is out of the pouch):
  //    w, h        length end to end, and thickness (px)
  //    wt          its weight (the object's `lwt`): how hard it is to swing and how hard it hits
  //    content     the emoji stamp it falls back to where it has no drawing
  //    tag         two letters in the id of one made for your hand (`<you>-<tag>…`)
  //    lenDial     the debug panel's give-me copy takes its length from the Weapons tab's sword-length dial instead of `w`
  //  How it is held:
  //    grip        where the hand closes on it, as a fraction of its length from the butt end
  //    rest        where it sits when you are not using it: 'belt' = in front of you at the belt, point up and forward ·
  //                'upright' = upright beside you
  //    aimsAtRest  its tip follows the pointer with no button held (in the schemes that are "always in hand") — false: it
  //                rests until left is held
  //    scheme      null = the Weapons tab's scheme picker decides its buttons · 'P' = always scheme P
  //    offTilt     how far it leans in the OFF hand at each of that hand's rest poses (Items tab → The off hand →
  //                "Where the off-hand item rests"): beside / back / raised, in radians, towards the way you face
  //  What it does:
  //    hurtFrom, hurtPad   where the part that can hurt begins: this fraction of its length from the butt end, plus this
  //                fraction of its thickness (the sword: the crossguard's far face — "I can stab with the handle" was a fault)
  //    carves      left held carves along the path the point is drawn
  //    pierces     it has an edge and a point: a stab or slash goes INTO a body (wounds, blood, held in them), into soft
  //                ground (and glances off hard), and it can plunge downward. Without it a hit is a club's: knocked back in full
  //    sticks      thrown, it sticks in ground / objects / people, and bounces off what it cannot stick in
  //    fire        it carries a flame: lit, it burns what it touches, gives light, goes out, sets a hit player alight
  //    strikes     false = no stab and no swing on its buttons (a shield) — absent = it strikes
  //    raise       'face' = while held to the pointer it sits between you and the pointer, `raiseAt` px clear of your body, its face
  //                turned to the pointer (a shield) — absent = its TIP goes on the pointer (a sword, a torch)
  //    shield, model   a shield, and the curved board it is drawn from (see the shields below)
  //    hands, grip2    hands 2 = it takes BOTH hands (the off hand is put away while it is out, and it cannot go in the off hand);
  //                grip2 = where the second hand closes on it (a fraction of its length, like `grip`)
  //    twoFree     held in BOTH hands (at `grip2`) while the other hand is empty, in one otherwise — it can go in the off hand (a spear)
  //    stabBack    how far a QUICK stab draws back before it drives in (px) — absent = the Weapons tab's dial (a spear's is longer)
  //    spin        right SPINS it round your hand instead of stabbing (the flail — its head on its chain does the hitting)
  //    daze        a hard blow from it leaves them dazed for a moment (a blunt weapon)
  //    cracks      a strike that meets the ground breaks the cells it hits (a hammer)
  //    nicks       its blunt blow also wounds a little — a few drops of blood (a mace's flanges, a spiked head, a hammer's beak)
  //    hitHalf     how far either side of its long axis it can hit somebody (its head's reach across: an axe, a hammer) — absent = half its box
  //    pole        a POLEARM (2026-10-20, plan file §5z41): rests upright, butt on the ground (`rest: 'pole'`); its swing turns about the
  //                point between its hands (16s `armAt`)
  //    both        what BOTH BUTTONS do instead of the carve / heavy blow (16n `wieldPButtonNew`, 16s): 'hook' = a swing with the hook that
  //                pulls a shield or held weapon it catches aside · 'butt' = a swing with the OTHER end · 'hammer' = a swing with the
  //                hammer face on its back. They strike blunt (the hammer face, the hook). `hookBack` = the hook is on its BACK
  //    ends        2 = both ENDS strike (the quarterstaff): a swing asked for just as the last one lands is swung with the other end, and
  //                the next such with the first again (16s `sw3ChainGo`) (2026-10-20, plan file §5z44)
  //    back        a DIFFERENT HEAD ON ITS BACK (a hook, a hammer face, a beak, a spike): the mouse wheel turns it round to lead with that
  //                head, and its swings then strike with it, blunt (16n `wieldWheel`, 16q `shieldFacing`). Others: the wheel spins it in the hand
  //    inFrom      how much of it can be IN somebody, from this fraction of its length to its point — absent = its blade (`hurtFrom`). The
  //                pike: its shaft too, ahead of the front hand — run onto it, it goes right through them (16o `woundChord`, §5z46)
  //    brace       crouched with it, you are planted and anybody who runs onto its point is hurt by their own speed (the pike, 16n)
  //    model3d     it is drawn from a 3D MODEL (client 16r, keyed by its look) rather than a flat drawing
  //    mat         what the part that meets things is MADE of: 'steel' · 'iron' · 'wood' (2026-10-20, plan file §5z38). A clash sounds
  //                and throws sparks or chips by it — wood in it = a thud and chips, metal on metal = a ring and sparks (16n
  //                `wieldClashMat`). Nothing burns by it yet.
  //  Its pictures:
  //    icon        how big its drawing is in an inventory tile (1 = the tile's width)
  //    pieces(w,h) what it collides with when it meets another held item, in its own frame (middle at 0,0, the point
  //                towards +x): x0, y0, x1, y1, half-width — five numbers a piece. It follows the drawing's own numbers.
  //                Without it the item is one rounded bar.
  const LOOKS = {
    sword: {
      w: 64, h: 8, wt: 1, content: '🗡️', tag: 'sw', lenDial: true,
      grip: 0.1, rest: 'belt', aimsAtRest: true, scheme: null,
      offTilt: { beside: -0.35, back: 0.5, raised: 0.25 },
      hurtFrom: 0.2, hurtPad: 0.3,
      carves: true, pierces: true, sticks: true, fire: false, mat: 'steel',
      icon: 1.24,
      pieces(w, h) {                                            // (16b `drawStampLook`'s own numbers)
        const x0 = -w / 2, x1 = w / 2, gx = x0 + w * 0.2, bh = Math.max(1.5, h * 0.62), r = bh / 2;
        return [x0 + h * 0.3, 0, x0 + h * 0.3, 0, h * 0.42,         // the pommel
                x0 + h * 0.3, 0, gx - h * 0.3, 0, h * 0.3,          // the grip
                gx, -h * 0.85, gx, h * 0.85, h * 0.3,               // the crossguard (h × 0.6 wide, h × 2.3 tall)
                gx + h * 0.3, 0, x1 - bh - r * 0.2, 0, r,           // the blade, as far as it is full width
                x1 - bh * 0.5, 0, x1 - bh * 0.5, 0, r * 0.5,        // …half-way down its taper
                x1 - bh * 0.25, 0, x1 - 0.5, 0, 0.5];               // …and its point
      },
    },
    // the torch is the hotbar torch's size (the user: "the same size as the other torch"): 16k's drawn torch is 0.36 of a
    //   body radius of handle below the hand, a radius of stick above it, and 0.2 more of wrapped head = 1.56 radii = 31px
    //   (2026-10-19, the user: "we scaled down weapons but I'm not sure if we ever scaled down shields or torches") — 0.6 of that, as the melee family
    torch: {
      w: 19, h: 3.6, wt: 0.6, content: '🔥', tag: 'tc', lenDial: false,
      grip: 0.23, rest: 'upright', aimsAtRest: false, scheme: 'P',
      offTilt: { beside: 0.04, back: 0.06, raised: 0.3 },
      hurtFrom: 0.5, hurtPad: 0,                                // its upper half
      carves: false, pierces: false, sticks: false, fire: true, mat: 'wood',
      icon: 0.92,
      pieces(w, h) {
        const x0 = -w / 2, x1 = w / 2, st = h * 0.667, hl = h * 1.067, hw = h * 1.133;
        return [x0 + st / 2, 0, x1 - st, 0, st / 2,                 // the stick
                x1 - hl / 2, 0, x1 - hl / 2, 0, Math.min(hl, hw) / 2];   // the wrapped head
      },
    },
  };

  // (no prototype, so `LOOKS[look]` is a plain read that cannot find 'constructor' and friends — the client asks it per object per frame)
  Object.setPrototypeOf(LOOKS, null);
  // ── SHIELDS (2026-10-14, `scratchpad/kickoff_held_items_plan.md` §5b — the user picked the "well curved, seen side-on (0°)" version of
  //    all five designs from `scratchpad/look/items/shield/side.html`). A shield is a curved board seen from the side: `model` is that
  //    board (U = half its width across the face, V = half its height, `dome` = curved both ways rather than side to side, t = its
  //    thickness, curve = how far its middle stands forward as a fraction of its larger half-size) — the client draws it from this
  //    model (16q) and the object's box is worked out from it here, so the two cannot disagree.
  //    Its LONG AXIS is its height: at rest it is upright (rest 'upright', angle −90°), its FACE towards the way its holder faces
  //    (the drawing flips with them). Held in its middle (grip 0.5).
  //    raise 'face' = while the button that works it is held (right on its own in the off hand, left in the main hand) it goes between
  //    you and the pointer, `raiseAt` px clear of your body, its FACE turned to the pointer. strikes false = no stab and no swing.
  //    It blocks by being a solid thing in the way: held items stop dead against it, and things thrown at you hit it.
  //    (2026-10-19, the user: "perhaps the issue is that shields are too big, since we scaled down weapons but I'm not sure if we ever scaled
  //    down shields or torches") — made at `SHIELD_K` of the model's size, as the melee family is at `MELEE_K` (the model and its paint stay
  //    in board px; the client draws it at w / 2V of them).
  const SHIELD_K = 0.6;
  const shield = (model, wt, tag, extra) => {
    const depth = model.curve * Math.max(model.U, model.V), h = Math.max(3.6, +((depth + model.t) * SHIELD_K).toFixed(2));
    return Object.assign({
      w: +(2 * model.V * SHIELD_K).toFixed(2), h, wt, content: '🛡️', tag, lenDial: false, model, shield: true,
      grip: 0.5, rest: 'upright', aimsAtRest: false, scheme: 'P', offTilt: { beside: 0, back: 0, raised: 0 },
      hurtFrom: 0, hurtPad: 0, carves: false, pierces: false, sticks: false, fire: false, strikes: false,
      raise: 'face', raiseAt: 5, icon: 1, mat: 'wood',
    }, extra || {});
  };
  LOOKS.roundshield  = shield({ U: 17, V: 17, dome: true,  t: 2.2, curve: 0.24 }, 1.2, 'rs');
  LOOKS.heatershield = shield({ U: 14, V: 20, dome: false, t: 2,   curve: 0.24 }, 1.4, 'hs');
  LOOKS.buckler      = shield({ U: 11, V: 11, dome: true,  t: 1.4, curve: 0.24 }, 0.7, 'bk', { mat: 'steel' });
  LOOKS.towershield  = shield({ U: 13, V: 26, dome: false, t: 2.6, curve: 0.24 }, 2.4, 'ts');
  LOOKS.kiteshield   = shield({ U: 13, V: 27, dome: false, t: 2,   curve: 0.24 }, 1.6, 'ks');

  // ── THE MELEE FAMILY (2026-10-14, plan file §5e — "build all of them at once"; looks from `scratchpad/look/items/melee/v2.html`, refined).
  //    Every one is a type with its own character, not a rarity (the user: rarity comes later with crafting and enchanting). Its model (how
  //    it looks) is client art, 16r; this is what it IS: L long, box h thick, weight, where the hand(s) go, what hurts and how.
  //    edge = carves + pierces + sticks (swords, daggers, spears, axes) · blunt = none of those, and dazes (clubs, maces, hammers).
  //  ⭐ THEIR SIZE (2026-10-15, plan file §5m/§5t — the user, after trying the test dial in play: "we'll definitely change the weapon size down
  //    to 0.6x"): every number below is written at the size the models were designed at, and made at `MELEE_K` of it — length, thickness,
  //    and the two settings measured in px (`hitHalf`, `stabBack`). Grips and `hurtFrom` are fractions, and the weight is unchanged.
  const MELEE_K = 0.6;
  const weapon = (L, h, wt, grip, hurtFrom, kind, tag, extra) => {
    const S = Object.assign({
      w: Math.round(L * MELEE_K), h: +(h * MELEE_K).toFixed(2), wt, content: '🗡️', tag, lenDial: false, model3d: true,
      grip, rest: 'belt', aimsAtRest: true, scheme: null, offTilt: { beside: -0.35, back: 0.5, raised: 0.25 },
      hurtFrom, hurtPad: 0, carves: kind === 'edge', pierces: kind === 'edge', sticks: kind === 'edge', fire: false,
      daze: kind === 'blunt', icon: 1.24,
      // (2026-10-20) what it is made of where it strikes: blades steel, the blunt heads iron (clubs say wood)
      mat: kind === 'edge' ? 'steel' : 'iron',
      // (2026-10-15) what RIGHT does with the off hand free: 'stab' (a blade with a point) or 'chop' (axes and every blunt weapon — the swing,
      //   never a stab; the user: "axes … hammers, and clubs, and any other weapons which are more blunt force than stabbing"). 16n `wieldPButton`.
      right: kind === 'blunt' ? 'chop' : 'stab',
      // (2026-10-15) the MARK a blunt blow leaves on skin (16o `woundBruiseDraw`): 'rod' two bands with a pale strip between · 'face' the
      //   hammer face's square · 'flange' a row of short bars · 'spikes' punctures · none = a plain bruise
      mark: null,
      // (2026-10-15) a CHARGED swing that cuts somebody goes INTO them for a moment before it carries on, and leaves an open wound (16n
      //   `wieldHits` → `stopUntil`; 16o `cleave`) — axes and the greatswords (the user: "axes and similar bladed weapons should … cleave")
      cleaves: false,
    }, extra || {});
    if (S.hitHalf) S.hitHalf = +(S.hitHalf * MELEE_K).toFixed(2);
    if (S.stabBack) S.stabBack = +(S.stabBack * MELEE_K).toFixed(2);
    return S;
  };
  const two = (g2) => ({ hands: 2, grip2: g2 });
  Object.assign(LOOKS, {
    // swords
    armingsword:   weapon(66, 7, 1.0, 0.13, 0.225, 'edge', 'as'),
    longsword:     weapon(84, 7, 1.2, 0.12, 0.255, 'edge', 'ls'),
    falchion:      weapon(62, 8, 1.1, 0.12, 0.23, 'edge', 'fa', { hitHalf: 4 }),
    sabre:         weapon(70, 7, 0.9, 0.11, 0.21, 'edge', 'sa'),
    rapier:        weapon(84, 6, 0.8, 0.10, 0.17, 'edge', 'ra'),
    // greatswords (two hands)
    greatsword:    weapon(100, 8, 2.2, 0.06, 0.285, 'edge', 'gs', Object.assign({ cleaves: true }, two(0.2))),
    claymore:      weapon(108, 8, 2.4, 0.06, 0.275, 'edge', 'cl', Object.assign({ cleaves: true }, two(0.2))),
    flamberge:     weapon(118, 8, 2.6, 0.05, 0.26, 'edge', 'fl', Object.assign({ cleaves: true }, two(0.2))),
    // daggers
    dagger:        weapon(30, 6, 0.5, 0.18, 0.35, 'edge', 'dg'),
    stiletto:      weapon(31, 6, 0.4, 0.18, 0.34, 'edge', 'st'),
    kris:          weapon(36, 6, 0.5, 0.16, 0.35, 'edge', 'kr'),
    // spears (one hand — the user's pick; held low on the shaft, 0.2 — the user: held "quite high up and it makes their range actually quite lacklustre")
    //   …and both hands on it while the other hand is free (the user, 2026-10-14), the second further up the shaft; a quick stab draws back further
    spear:         weapon(120, 6, 1.4, 0.20, 0.89, 'edge', 'sp', { twoFree: true, grip2: 0.42, stabBack: 26 }),
    wingedspear:   weapon(124, 6, 1.6, 0.20, 0.85, 'edge', 'ws', { twoFree: true, grip2: 0.42, stabBack: 26 }),
    trident:       weapon(122, 6, 1.7, 0.20, 0.85, 'edge', 'tr', { hitHalf: 6, twoFree: true, grip2: 0.42, stabBack: 26 }),
    // axes (they carve — the user's pick)
    handaxe:       weapon(44, 6, 1.0, 0.12, 0.76, 'edge', 'ha', { right: 'chop', cleaves: true, hitHalf: 7 }),
    beardedaxe:    weapon(60, 6, 1.4, 0.10, 0.70, 'edge', 'ba', { right: 'chop', cleaves: true, hitHalf: 8 }),
    steelaxe:      weapon(52, 6, 1.5, 0.11, 0.72, 'edge', 'sx', { right: 'chop', cleaves: true, hitHalf: 7, back: true }),
    crescentaxe:   weapon(58, 6, 1.6, 0.10, 0.70, 'edge', 'cx', { right: 'chop', cleaves: true, hitHalf: 9 }),
    battleaxe:     weapon(64, 6, 1.8, 0.10, 0.68, 'edge', 'bx', { right: 'chop', cleaves: true, hitHalf: 9 }),
    greataxe:      weapon(104, 7, 2.6, 0.05, 0.80, 'edge', 'ga', Object.assign({ right: 'chop', cleaves: true, hitHalf: 11, back: true }, two(0.22))),
    greatbattleaxe: weapon(110, 7, 3.0, 0.05, 0.78, 'edge', 'gb', Object.assign({ right: 'chop', cleaves: true, hitHalf: 12 }, two(0.2))),
    daneaxe:       weapon(118, 6, 2.2, 0.05, 0.82, 'edge', 'da', Object.assign({ right: 'chop', cleaves: true, hitHalf: 10 }, two(0.25))),
    executioner:   weapon(100, 7, 3.2, 0.05, 0.74, 'edge', 'ex', Object.assign({ right: 'chop', cleaves: true, hitHalf: 12 }, two(0.2))),
    // clubs
    club:          weapon(50, 8, 1.4, 0.12, 0.55, 'blunt', 'cb', { hitHalf: 4, mark: 'rod', mat: 'wood' }),
    spikedclub:    weapon(52, 8, 1.6, 0.12, 0.60, 'blunt', 'sc', { hitHalf: 6, nicks: true, mark: 'spikes', mat: 'wood' }),
    greatclub:     weapon(96, 10, 2.8, 0.05, 0.55, 'blunt', 'gc', Object.assign({ hitHalf: 6, mark: 'rod', mat: 'wood' }, two(0.2))),
    // maces and flails
    mace:          weapon(52, 7, 1.6, 0.12, 0.76, 'blunt', 'mc', { hitHalf: 6, nicks: true, mark: 'flange' }),
    morningstar:   weapon(56, 7, 1.8, 0.12, 0.78, 'blunt', 'ms', { hitHalf: 7, nicks: true, mark: 'spikes' }),
    flail:         weapon(62, 6, 1.7, 0.12, 0.82, 'blunt', 'fs', { hitHalf: 6, nicks: true, spin: true, mark: 'spikes' }),   // (spin: right whirls it — no stab; 2026-10-15)
    // hammers (they crack ground — the user's pick)
    warhammer:     weapon(60, 7, 1.5, 0.11, 0.82, 'blunt', 'wh', { hitHalf: 9, nicks: true, cracks: true, mark: 'face', back: true }),
    maul:          weapon(100, 10, 3.0, 0.05, 0.85, 'blunt', 'ml', Object.assign({ hitHalf: 12, cracks: true, mark: 'face' }, two(0.2))),
    runedhammer:   weapon(106, 10, 3.2, 0.05, 0.80, 'blunt', 'rh', Object.assign({ hitHalf: 13, cracks: true, mark: 'face' }, two(0.21))),
  });
  // ── POLEARMS (2026-10-20, plan file §5z41 — the user picked all eleven; looks `scratchpad/look/items/polearms/index.html`). ALWAYS BOTH
  //    HANDS (the user's pick). `pole` = a long two-handed weapon: it rests upright with its butt on the ground (`rest: 'pole'`, 16n
  //    `wieldRestPose`) and its swing turns about a point between the hands (16s `armAt`, Weapons → "Polearms swing about a point between
  //    the hands"). Grips are where the model's wraps are. Round 2 (§5z43): `both` (the hook on halberd, bill, Lucerne hammer · the
  //    staff's other end · the poleaxe's hammer face), `brace` (the pike), `pullCut` (the scythe).
  const pole = (g2, extra) => Object.assign({ pole: true, rest: 'pole' }, two(g2), extra || {});
  Object.assign(LOOKS, {
    quarterstaff:  weapon(150, 5, 1.6, 0.30, 0.82, 'blunt', 'qs', pole(0.56, { hitHalf: 3, mark: 'rod', mat: 'wood', right: 'stab', ends: 2 })),
    pike:          weapon(230, 4, 2.2, 0.12, 0.95, 'edge', 'pk', pole(0.34, { hitHalf: 2, stabBack: 30, brace: true, inFrom: 0.42 })),
    glaive:        weapon(136, 6, 2.2, 0.10, 0.80, 'edge', 'gv', pole(0.38, { hitHalf: 5, cleaves: true })),
    naginata:      weapon(132, 6, 1.8, 0.10, 0.74, 'edge', 'ng', pole(0.40, { hitHalf: 4 })),
    guandao:       weapon(128, 7, 2.8, 0.12, 0.78, 'edge', 'gd', pole(0.42, { hitHalf: 10, cleaves: true })),
    halberd:       weapon(136, 7, 2.6, 0.10, 0.79, 'edge', 'hd', pole(0.38, { hitHalf: 15, cleaves: true, both: 'hook', hookBack: true, back: true })),
    bardiche:      weapon(128, 7, 2.8, 0.08, 0.57, 'edge', 'bd', pole(0.36, { hitHalf: 16, cleaves: true })),
    poleaxe:       weapon(112, 7, 2.4, 0.10, 0.82, 'edge', 'px', pole(0.40, { hitHalf: 12, cleaves: true, both: 'hammer', back: true })),
    // (blunt, but its long top spike stabs and pierces — a puncture, not a cut)
    lucerne:       weapon(130, 7, 2.6, 0.10, 0.80, 'blunt', 'lh', pole(0.38, { hitHalf: 12, right: 'stab', pierces: true, nicks: true, cracks: true, mark: 'spikes', both: 'hook', hookBack: true, back: true })),
    bill:          weapon(136, 7, 2.4, 0.10, 0.72, 'edge', 'bi', pole(0.38, { hitHalf: 16, cleaves: true, both: 'hook', back: true })),
    // (no point to stab with: right swings it, both buttons are the heavy blow)
    scythe:        weapon(130, 6, 2.0, 0.08, 0.92, 'edge', 'sy', pole(0.46, { hitHalf: 30, right: 'chop' })),
  });

  // ── BOWS (2026-10-20, plan file §5z38 piece 2 — looks agreed in four rounds of renders, `scratchpad/look/items/bow/index.html`; the models
  //    are client art, 16r `WM`, ported from `scratchpad/make_bow_renders.js`). Its LONG AXIS is the stave, tip to tip; held in its middle.
  //    The bow is in the OFF hand and the MAIN hand works the string (the user's words): both hands while it is out (`hands: 2`). Its own
  //    buttons (client 16w): left held draws, let go looses, right nocks an arrow / lets the string down, the wheel picks the arrow.
  //    Out, it is held up turned to the pointer; H = low by your side (`rest: 'low'`). It strikes nothing and cuts nothing.
  //    `bow` = its model's name in 16r. Made at BOW_K of the melee family's size (the user: "a little too big") — the Weapons tab's
  //    "Bows — …" → "Bow size (×)" is a test dial on top, and the arrows scale with the bow.
  const BOW_K = 0.8;
  // (2026-10-20, piece 3 played — the user: "Different bows could have different draw times and different reach, as well as the force the arrow is
  //   shot at … some tradeoff between the force/reach and the draw time, so a lighter bow draws faster but shoots less far and is less powerful.
  //   However, some of the rarer bows could be good in both areas") — `drawMs` (to full draw) and `power` (× the arrow's speed and its hurt)
  const bowE = (L, wt, tag, drawMs, power) => ({ drawMs, power, w: Math.round(L * MELEE_K * BOW_K), h: 3, wt, content: '🏹', tag, lenDial: false, model3d: true, bow: true,
    grip: 0.5, rest: 'low', aimsAtRest: true, scheme: 'P', offTilt: { beside: 0, back: 0, raised: 0 }, hands: 2,
    hurtFrom: 1, hurtPad: 0, carves: false, pierces: false, sticks: false, fire: false, strikes: false, mat: 'wood', icon: 1.15 });
  Object.assign(LOOKS, {
    // (light and quick → heavy and slow; the two rare ones, elven and ebon, are quick AND strong)
    shortbow: bowE(84, 0.6, 'sb', 600, 0.75), horsebow: bowE(82, 0.6, 'hb', 650, 0.85), recurve: bowE(96, 0.7, 'rc', 800, 0.95),
    bonebow: bowE(90, 0.8, 'nb', 900, 1.05), longbow: bowE(118, 0.8, 'lb', 1150, 1.15),
    elvenbow: bowE(104, 0.6, 'eb', 650, 1.12), ebonbow: bowE(94, 0.8, 'ob', 750, 1.18),
  });
  // (…and the size of an ARROW at the bow's own scale — client 16w draws them nocked and in the quiver)
  const ARROW_W = Math.round(60 * MELEE_K * BOW_K);
  // ⭐ ARROWS (2026-10-20, plan file §5z38 piece 3): in the pouch a stack (server/items.js, kind 'ammo'); LOOSED, a real object with one of these
  //   looks — it flies point first, sticks where a thrown blade would, wounds, is stopped by a shield, and E puts it back in your pouch. It is
  //   never taken into a hand (`arrow`). Its model is 16r's, keyed by the same id.
  //   (the user: "The different arrow types could also have an effect on damage/reach/fly speed") — `speedK` × its speed, `gravK` × how hard it
  //   falls, `dmgK` × its hurt: a field point is the plain one, a bodkin flies a little truer, a broadhead hurts most but drops, an elven one flies
  //   fast and flat
  //   (arrows round 3, the user: "the arrow wounds are larger than the actual arrow … the different arrows should create different wounds based on
  //   their tips … no larger than the tip and should match the shape") — `cut` = [how wide its head is, in the model's units of a 60-long arrow
  //   (16r `arrowParts`), 1 = a round point that PUNCTURES · 0 = a flat blade that leaves a SLIT as wide as it] — 16o sizes the wound from it
  const arrowE = (tag, speedK, gravK, dmgK, cut) => ({ speedK, gravK, dmgK, cut, w: ARROW_W, h: 2, wt: 0.3, content: '➵', tag, lenDial: false, model3d: true, arrow: true,
    grip: 0.08, rest: 'belt', aimsAtRest: false, scheme: 'P', offTilt: { beside: 0, back: 0, raised: 0 },
    hurtFrom: 0.85, hurtPad: 0, carves: false, pierces: true, sticks: true, fire: false, strikes: false, mat: 'wood', icon: 1.1 });
  Object.assign(LOOKS, { arrow_bodkin: arrowE('ab', 1.06, 0.9, 1, [1.8, 1]), arrow_broad: arrowE('ar', 0.93, 1.2, 1.35, [5.2, 0]), arrow_field: arrowE('af', 1, 1, 0.8, [1.56, 1]), arrow_elven: arrowE('ae', 1.12, 0.75, 1.15, [3.4, 0]) });

  // ⭐ THROWABLES (2026-10-21, plan file §5z54 — the user's pick after polearms; looks agreed over two rounds, `scratchpad/look/items/throwables/`).
  //    A STACK in the pouch (server/items.js `stack`) with ONE in your main hand as the real object: throwing it spends it, and the next one comes
  //    to hand. Their buttons (client 16x): LEFT held winds up an overarm throw (longer = harder and flatter), let go throws · MIDDLE = an underarm
  //    lob · RIGHT = the thing's own move (a blade stabs or chops, as a dagger does), or cancels a wind-up.
  //    `throwable` = one of these · `thrDmg` = what it does when it goes IN somebody (light things hurt little by weight × speed) ·
  //    `spinFly` = it turns end over end in flight (rad a step) instead of flying point first — it sticks when its head end leads ·
  //    `stickAny` = any point of it sticks (a star: it spins flat, every point is a point).
  //    Piece 1 = the thrown blades: they fly, stick, wound and bleed as a thrown sword does, and E puts one lying or stuck back in the pouch.
  const thrown = (L, h, wt, grip, hurtFrom, tag, extra) => weapon(L, h, wt, grip, hurtFrom, 'edge', tag, Object.assign({ throwable: true, carves: false, icon: 1.1 }, extra || {}));
  Object.assign(LOOKS, {
    //    `thrK` = how fast and far it is thrown, 1 = as fast as anything can be (another weapon's comes from its weight — client 16m `carryThrowWf`) ·
    //    `thrGk` = how much it drops in flight, × the throw's gravity (light throwing things nearly flat — 16m `carryThrowG`) (§5z55).
    //    `right: 'chop'` on a throwable = right SWINGS it as an axe swings (the tomahawk — the user: "swinging them like an axe, not a poke").
    throwknife: thrown(24, 4, 0.35, 0.2, 0.36, 'tk', { thrDmg: 3, thrK: 1, thrGk: 0.4 }),
    kunai:      thrown(27, 5, 0.45, 0.25, 0.41, 'ku', { thrDmg: 4, thrK: 0.95, thrGk: 0.5 }),
    dart:       thrown(19, 3, 0.15, 0.48, 0.62, 'dr', { thrDmg: 2, thrK: 1, thrGk: 0.35 }),
    throwstar:  thrown(15, 15, 0.25, 0.5, 0, 'xs', { thrDmg: 2, thrK: 1, thrGk: 0.35, stickAny: true, hitHalf: 7 }),
    javelin:    thrown(100, 4, 1.1, 0.45, 0.88, 'jv', { thrDmg: 6, thrK: 0.9, thrGk: 0.6 }),
    tomahawk:   thrown(38, 6, 0.7, 0.16, 0.76, 'tm', { thrDmg: 5, thrK: 0.8, thrGk: 0.75, spinFly: 0.42, right: 'chop', hitHalf: 6, cleaves: true }),
  });
  // ⭐ THROWABLES, PIECE 2: EXPLOSIVES (2026-10-21, plan file §5z58 — the user's picks: the bomb, the PLAIN dynamite, the normal bundle, the TAR BALL).
  //    The Level bomb's own machinery (client 16b `bombBlast`, server `armBomb`): the object carries a FUSE (`boom`, seconds — what makes anything go
  //    up), RIGHT lights it in your hand (held too long it goes off there), and one thrown unlit is lit as it leaves your hand. When the fuse is done
  //    everybody's screen blasts it where it is; the one who lit it digs the hole; the server takes the spent object away.
  //    `blastR` = how far the blast reaches (px) · `blastF` = how hard it throws you · `dig` = the hole, × the blast's reach · `sticky` = it sticks
  //    to whatever it hits — rock, a crate, a person (on them, not in them) — and goes off there.
  //    They are blunt to hold (right is the fuse, not a strike) and heavier than the blades, so they fly in a rounder arc.
  const boomE = (L, h, wt, grip, tag, boom, blastR, blastF, dig, extra) => weapon(L, h, wt, grip, 1, 'blunt', tag, Object.assign({ throwable: true, boom, blastR, blastF, dig,
    daze: false, right: 'light', icon: 1.1, mat: 'iron' }, extra || {}));
  Object.assign(LOOKS, {
    thbomb:    boomE(22, 14, 0.9, 0.3, 'bm', 3.0, 95, 18, 0.5, { thrK: 0.8, thrGk: 0.9 }),
    dynamite:  boomE(26, 5, 0.6, 0.35, 'dy', 2.5, 70, 11, 0.8, { thrK: 0.9, thrGk: 0.75, mat: 'wood' }),
    dynbundle: boomE(27, 9, 1.4, 0.35, 'db', 3.5, 140, 28, 0.6, { thrK: 0.65, thrGk: 1.0, mat: 'wood' }),
    tarball:   boomE(21, 13, 0.8, 0.3, 'tb', 2.5, 80, 15, 0.45, { thrK: 0.8, thrGk: 0.9, sticky: true, sticks: true, stickAny: true, mat: 'wood' }),
  });
  const is = (look) => typeof look === 'string' && LOOKS[look] !== undefined;
  const of = (look) => is(look) ? LOOKS[look] : null;
  // an item's object shape, as server/items.js and the wire carry it
  const objOf = (look) => { const L = LOOKS[look]; return { look, w: L.w, h: L.h, lwt: L.wt, content: L.content }; };

  // ⭐ YOUR HANDS' SIZE (2026-10-15, plan file §5t — the user: "the hand size down to 0.65x"), as a fraction of what they were drawn at, holding
  //   anything — here so every screen draws everybody's hands the same. The Weapons tab's "Hand size (×)" is a test dial on top of it.
  const HAND_K = 0.65;

  return { LOOKS, is, of, objOf, HAND_K, MELEE_K, BOW_K, ARROW_W };
});
