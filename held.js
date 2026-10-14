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
  //    daze        a hard blow from it leaves them dazed for a moment (a blunt weapon)
  //    cracks      a strike that meets the ground breaks the cells it hits (a hammer)
  //    nicks       its blunt blow also wounds a little — a few drops of blood (a mace's flanges, a spiked head, a hammer's beak)
  //    hitHalf     how far either side of its long axis it can hit somebody (its head's reach across: an axe, a hammer) — absent = half its box
  //    model3d     it is drawn from a 3D MODEL (client 16r, keyed by its look) rather than a flat drawing
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
      carves: true, pierces: true, sticks: true, fire: false,
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
    torch: {
      w: 31, h: 6, wt: 0.6, content: '🔥', tag: 'tc', lenDial: false,
      grip: 0.23, rest: 'upright', aimsAtRest: false, scheme: 'P',
      offTilt: { beside: 0.04, back: 0.06, raised: 0.3 },
      hurtFrom: 0.5, hurtPad: 0,                                // its upper half
      carves: false, pierces: false, sticks: false, fire: true,
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
  const shield = (model, wt, tag, extra) => {
    const depth = model.curve * Math.max(model.U, model.V), h = Math.max(6, +(depth + model.t).toFixed(2));
    return Object.assign({
      w: 2 * model.V, h, wt, content: '🛡️', tag, lenDial: false, model, shield: true,
      grip: 0.5, rest: 'upright', aimsAtRest: false, scheme: 'P', offTilt: { beside: 0, back: 0, raised: 0 },
      hurtFrom: 0, hurtPad: 0, carves: false, pierces: false, sticks: false, fire: false, strikes: false,
      raise: 'face', raiseAt: 5, icon: 1,
    }, extra || {});
  };
  LOOKS.roundshield  = shield({ U: 17, V: 17, dome: true,  t: 2.2, curve: 0.38 }, 1.2, 'rs');
  LOOKS.heatershield = shield({ U: 14, V: 20, dome: false, t: 2,   curve: 0.38 }, 1.4, 'hs');
  LOOKS.buckler      = shield({ U: 11, V: 11, dome: true,  t: 1.4, curve: 0.38 }, 0.7, 'bk');
  LOOKS.towershield  = shield({ U: 13, V: 26, dome: false, t: 2.6, curve: 0.38 }, 2.4, 'ts');
  LOOKS.kiteshield   = shield({ U: 13, V: 27, dome: false, t: 2,   curve: 0.38 }, 1.6, 'ks');

  // ── THE MELEE FAMILY (2026-10-14, plan file §5e — "build all of them at once"; looks from `scratchpad/look/items/melee/v2.html`, refined).
  //    Every one is a type with its own character, not a rarity (the user: rarity comes later with crafting and enchanting). Its model (how
  //    it looks) is client art, 16r; this is what it IS: L long, box h thick, weight, where the hand(s) go, what hurts and how.
  //    edge = carves + pierces + sticks (swords, daggers, spears, axes) · blunt = none of those, and dazes (clubs, maces, hammers).
  const weapon = (L, h, wt, grip, hurtFrom, kind, tag, extra) => Object.assign({
    w: L, h, wt, content: '🗡️', tag, lenDial: false, model3d: true,
    grip, rest: 'belt', aimsAtRest: true, scheme: null, offTilt: { beside: -0.35, back: 0.5, raised: 0.25 },
    hurtFrom, hurtPad: 0, carves: kind === 'edge', pierces: kind === 'edge', sticks: kind === 'edge', fire: false,
    daze: kind === 'blunt', icon: 1.24,
  }, extra || {});
  const two = (g2) => ({ hands: 2, grip2: g2 });
  Object.assign(LOOKS, {
    // swords
    armingsword:   weapon(66, 7, 1.0, 0.13, 0.225, 'edge', 'as'),
    longsword:     weapon(84, 7, 1.2, 0.12, 0.255, 'edge', 'ls'),
    falchion:      weapon(62, 8, 1.1, 0.12, 0.23, 'edge', 'fa', { hitHalf: 4 }),
    sabre:         weapon(70, 7, 0.9, 0.11, 0.21, 'edge', 'sa'),
    rapier:        weapon(84, 6, 0.8, 0.10, 0.17, 'edge', 'ra'),
    // greatswords (two hands)
    greatsword:    weapon(100, 8, 2.2, 0.06, 0.285, 'edge', 'gs', two(0.2)),
    claymore:      weapon(108, 8, 2.4, 0.06, 0.275, 'edge', 'cl', two(0.2)),
    flamberge:     weapon(118, 8, 2.6, 0.05, 0.26, 'edge', 'fl', two(0.2)),
    // daggers
    dagger:        weapon(30, 6, 0.5, 0.18, 0.35, 'edge', 'dg'),
    stiletto:      weapon(31, 6, 0.4, 0.18, 0.34, 'edge', 'st'),
    kris:          weapon(36, 6, 0.5, 0.16, 0.35, 'edge', 'kr'),
    // spears (one hand — the user's pick; held low on the shaft, 0.2 — the user: held "quite high up and it makes their range actually quite lacklustre")
    spear:         weapon(120, 6, 1.4, 0.20, 0.89, 'edge', 'sp'),
    wingedspear:   weapon(124, 6, 1.6, 0.20, 0.85, 'edge', 'ws'),
    trident:       weapon(122, 6, 1.7, 0.20, 0.85, 'edge', 'tr', { hitHalf: 6 }),
    // axes (they carve — the user's pick)
    handaxe:       weapon(44, 6, 1.0, 0.12, 0.76, 'edge', 'ha', { hitHalf: 7 }),
    beardedaxe:    weapon(60, 6, 1.4, 0.10, 0.70, 'edge', 'ba', { hitHalf: 8 }),
    steelaxe:      weapon(52, 6, 1.5, 0.11, 0.72, 'edge', 'sx', { hitHalf: 7 }),
    crescentaxe:   weapon(58, 6, 1.6, 0.10, 0.70, 'edge', 'cx', { hitHalf: 9 }),
    battleaxe:     weapon(64, 6, 1.8, 0.10, 0.68, 'edge', 'bx', { hitHalf: 9 }),
    greataxe:      weapon(104, 7, 2.6, 0.05, 0.80, 'edge', 'ga', Object.assign({ hitHalf: 11 }, two(0.22))),
    greatbattleaxe: weapon(110, 7, 3.0, 0.05, 0.78, 'edge', 'gb', Object.assign({ hitHalf: 12 }, two(0.2))),
    daneaxe:       weapon(118, 6, 2.2, 0.05, 0.82, 'edge', 'da', Object.assign({ hitHalf: 10 }, two(0.25))),
    executioner:   weapon(100, 7, 3.2, 0.05, 0.74, 'edge', 'ex', Object.assign({ hitHalf: 12 }, two(0.2))),
    // clubs
    club:          weapon(50, 8, 1.4, 0.12, 0.55, 'blunt', 'cb', { hitHalf: 4 }),
    spikedclub:    weapon(52, 8, 1.6, 0.12, 0.60, 'blunt', 'sc', { hitHalf: 6, nicks: true }),
    greatclub:     weapon(96, 10, 2.8, 0.05, 0.55, 'blunt', 'gc', Object.assign({ hitHalf: 6 }, two(0.2))),
    // maces and flails
    mace:          weapon(52, 7, 1.6, 0.12, 0.76, 'blunt', 'mc', { hitHalf: 6, nicks: true }),
    morningstar:   weapon(56, 7, 1.8, 0.12, 0.78, 'blunt', 'ms', { hitHalf: 7, nicks: true }),
    flail:         weapon(62, 6, 1.7, 0.12, 0.82, 'blunt', 'fs', { hitHalf: 6, nicks: true }),
    // hammers (they crack ground — the user's pick)
    warhammer:     weapon(60, 7, 1.5, 0.11, 0.82, 'blunt', 'wh', { hitHalf: 9, nicks: true, cracks: true }),
    maul:          weapon(100, 10, 3.0, 0.05, 0.85, 'blunt', 'ml', Object.assign({ hitHalf: 12, cracks: true }, two(0.2))),
    runedhammer:   weapon(106, 10, 3.2, 0.05, 0.80, 'blunt', 'rh', Object.assign({ hitHalf: 13, cracks: true }, two(0.21))),
  });

  const is = (look) => typeof look === 'string' && LOOKS[look] !== undefined;
  const of = (look) => is(look) ? LOOKS[look] : null;
  // an item's object shape, as server/items.js and the wire carry it
  const objOf = (look) => { const L = LOOKS[look]; return { look, w: L.w, h: L.h, lwt: L.wt, content: L.content }; };

  return { LOOKS, is, of, objOf };
});
