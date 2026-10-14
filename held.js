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

  const is = (look) => typeof look === 'string' && LOOKS[look] !== undefined;
  const of = (look) => is(look) ? LOOKS[look] : null;
  // an item's object shape, as server/items.js and the wire carry it
  const objOf = (look) => { const L = LOOKS[look]; return { look, w: L.w, h: L.h, lwt: L.wt, content: L.content }; };

  return { LOOKS, is, of, objOf };
});
