'use strict';
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  ITEMS — the things you carry that are not terrain (weapons, tools, the torch, throwables, worn gear).
//
//  ⭐⭐ AN ITEM IS A KIND PLUS A COUNT, EXACTLY LIKE A MATERIAL (user decision 2026-10-07, `weapons_ideas.md` §5
//  item 11). Two of the same item are identical: no wear, no quality, no maker, nothing loaded in it. A BETTER
//  weapon is a DIFFERENT ITEM ("Iron sword" / "Fine iron sword"), like a rarity tier with its own stats. One-of-a-
//  kind items were considered and deliberately left for later ("getting ahead of ourselves").
//  ⇒ the ledger holds `itemId → n` beside `matId → n`, and everything that moves matter (credit, spend, the death
//  scatter, a pile, a pickup) moves items the same way. No new trust machinery.
//
//  ⭐ THIS TABLE IS THE ONLY COPY. The client is SENT it (on the first `inv-sync` of a socket) rather than keeping
//  its own list — two tables of what exists is the drift this project keeps getting caught by. That is also why
//  the picture rides along here: the client draws what it is told.
//
//  ⚠️ IDS ARE STRINGS and are what gets STORED (ledger rows, pile rows). Renaming one strands everybody's copy of
//  it. Add new ids; do not rename old ones.
//
//  A torch or a sword (an item with `obj`) is the REAL object in your hand in dig mode (client 16p; the server's count rules are
//  `itemObjMove` in index.js). (The stand-in sword / torch / arrows were removed 2026-10-20; the debug panel gives real items.)
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

// The pictures, as 24×24 SVG. Drawn by the client both in the window (as markup) and on the canvas (as an image).
const SVG = {
  sword: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20.6 2.4 L21.6 3.4 L11 15 L9 13 Z" fill="#dfe5ec" stroke="#5b6472" stroke-width=".7"/>'
    + '<path d="M7 11.6 L12.4 17" stroke="#8a6a44" stroke-width="2.4" stroke-linecap="round"/>'
    + '<path d="M9.7 14.3 L4.6 19.4" stroke="#5a4028" stroke-width="2.3" stroke-linecap="round"/><circle cx="3.9" cy="20.1" r="1.4" fill="#8a6a44"/></svg>',
  torch: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="10.6" y="10.5" width="2.8" height="11" rx="1" fill="#7a5530"/>'
    + '<path d="M12 1.8c3 3.5 3.6 5.6 3.3 7.3-.3 1.6-1.6 2.9-3.3 2.9s-3-1.3-3.3-2.9C8.4 7.4 9 5.3 12 1.8z" fill="#f59e0b"/>'
    + '<path d="M12 5.8c1.4 1.7 1.7 2.8 1.5 3.7-.2.8-.8 1.4-1.5 1.4s-1.3-.6-1.5-1.4c-.2-.9.1-2 1.5-3.7z" fill="#fde68a"/></svg>',
  arrows: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g stroke-linecap="round"><path d="M4 18 L17 5" stroke="#9a7b4f" stroke-width="1.6"/><path d="M7 21 L20 8" stroke="#9a7b4f" stroke-width="1.6"/></g>'
    + '<path d="M17.6 4.4 l-4.6.6 4 4z" fill="#cbd5e1"/><path d="M20.6 7.4 l-4.6.6 4 4z" fill="#cbd5e1"/>'
    + '<path d="M4 18 l-.6-3.4 M4 18 l3.4.6 M7 21 l-.6-3.4 M7 21 l3.4.6" stroke="#f1f5f9" stroke-width="1.2"/></svg>',
};

// kind: 'weapon' | 'ammo' | 'tool' | 'light' | 'throwable' | 'worn' — what it will be once it does something.
// tier: 0 = ordinary. A better version of an item is another entry with a higher tier.
// ⭐ `make` (2026-10-08) = what making one costs, in the inventory window's Make tab: `mats` [[materialId, n], …] and
// `prima`. Checked and taken by the server (`inv-make`); the client only shows it.
// ⭐ `light`: an item of kind 'light' IS a torch to the client — it is held, burns, lights and sets things alight
// (`scratchpad/weapons_ideas.md`, the torch decisions). The stand-in torch behaves as one too, for testing.
// ⭐⭐ `obj` (2026-10-14, the user: "A torch or sword or other such item should only ever exist as an object in the world, not as a
// stack, and they shouldn't stack in the inventory. Things like ammo/arrows would be different") = the item IS a real object when it is
// out of the pouch — in a hand, lying on the ground, scattered on a death — never a pile, and one tile each in the inventory. This is
// that object's shape, the one copy of it: the client builds a hand item from it (16n `wieldGive`) and the server builds one lying on
// the ground from it (`itemObjPlace`). The shape itself lives with how the thing behaves in the hand: server/held.js (one entry per
// held look — a new held item is an entry there and a drawing in 16b).
const HELD = require('./held');
const OBJ = { sword: HELD.objOf('sword'), torch: HELD.objOf('torch') };
for (const k of ['roundshield', 'heatershield', 'buckler', 'towershield', 'kiteshield']) OBJ[k] = HELD.objOf(k);
// the melee family (server/held.js): every look with a 3D model is an object shape here
for (const k of Object.keys(HELD.LOOKS)) if (HELD.LOOKS[k].model3d) OBJ[k] = HELD.objOf(k);
// a shield's picture in a list (the window draws the real thing from its model — 16q; this is the plain fallback)
const shieldSvg = (fill, d) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="' + d + '" fill="' + fill + '" stroke="#8f98a5" stroke-width="1.4"/></svg>';
SVG.roundshield = shieldSvg('#8a5c32', 'M12 3a9 9 0 1 0 .01 0z');
SVG.heatershield = shieldSvg('#2f5ea8', 'M5 3h14v7c0 5-3.5 8.5-7 11-3.5-2.5-7-6-7-11z');
SVG.buckler = shieldSvg('#b2bac6', 'M12 6a6 6 0 1 0 .01 0z');
SVG.towershield = shieldSvg('#8a5c32', 'M6.5 2h11a1.5 1.5 0 0 1 1.5 1.5v17a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20.5v-17A1.5 1.5 0 0 1 6.5 2z');
SVG.kiteshield = shieldSvg('#962826', 'M12 2c4 0 6.5 2.5 6.5 6 0 5-3 10-6.5 14C8.5 18 5.5 13 5.5 8 5.5 4.5 8 2 12 2z');
const ITEMS = {
  torch:       { name: 'Torch',           kind: 'light',     tier: 0, svg: SVG.torch, obj: OBJ.torch, make: { mats: [[28, 1]], prima: 20 } },   // 28 = Wood
  // (2026-10-14, the user: "Prima only" — no materials until crafting is designed; the price is mine, change it here)
  // (later the same day) the real Sword IS the Arming sword of the melee family — its 3D model, not the stand-in's flat drawing. The id
  //   stays 'sword' (ids are what is stored).
  sword:       { name: 'Arming sword',    kind: 'weapon',    tier: 0, svg: SVG.sword, obj: OBJ.armingsword, make: { mats: [], prima: 60 } },
  // (2026-10-14) THE FIVE SHIELDS (all five designs, the user's pick; Prima only; the prices are mine). Kind 'weapon' for now, so they sit
  //   under the window's Weapons filter — a filter of their own is one line in 16j when wanted.
  shield_round:  { name: 'Round shield',  kind: 'weapon', tier: 0, svg: SVG.roundshield,  obj: OBJ.roundshield,  make: { mats: [], prima: 50 } },
  shield_heater: { name: 'Heater shield', kind: 'weapon', tier: 0, svg: SVG.heatershield, obj: OBJ.heatershield, make: { mats: [], prima: 60 } },
  shield_buckler:{ name: 'Buckler',       kind: 'weapon', tier: 0, svg: SVG.buckler,      obj: OBJ.buckler,      make: { mats: [], prima: 30 } },
  shield_tower:  { name: 'Tower shield',  kind: 'weapon', tier: 0, svg: SVG.towershield,  obj: OBJ.towershield,  make: { mats: [], prima: 90 } },
  shield_kite:   { name: 'Kite shield',   kind: 'weapon', tier: 0, svg: SVG.kiteshield,   obj: OBJ.kiteshield,   make: { mats: [], prima: 70 } },
};

// ⭐ THE MELEE FAMILY (2026-10-14, plan file §5e): one item per weapon type, Prima only (prices mine). [id, name, look, prima]. The
//   Arming sword is the item `sword` above. Kind 'weapon' — they sit under the window's Weapons filter.
for (const [id, name, look, prima] of [
  ['longsword', 'Longsword', 'longsword', 80], ['falchion', 'Falchion', 'falchion', 60], ['sabre', 'Sabre', 'sabre', 75], ['rapier', 'Rapier', 'rapier', 90],
  ['greatsword', 'Greatsword', 'greatsword', 120], ['claymore', 'Claymore', 'claymore', 140], ['flamberge', 'Flamberge', 'flamberge', 170],
  ['dagger', 'Dagger', 'dagger', 25], ['stiletto', 'Stiletto', 'stiletto', 35], ['kris', 'Kris', 'kris', 50],
  ['spear', 'Spear', 'spear', 50], ['winged_spear', 'Winged spear', 'wingedspear', 70], ['trident', 'Trident', 'trident', 90],
  ['hand_axe', 'Hand axe', 'handaxe', 35], ['bearded_axe', 'Bearded axe', 'beardedaxe', 55], ['steel_axe', 'Steel axe', 'steelaxe', 80],
  ['crescent_axe', 'Crescent axe', 'crescentaxe', 100], ['battle_axe', 'Battle axe', 'battleaxe', 90], ['greataxe', 'Greataxe', 'greataxe', 120],
  ['great_battle_axe', 'Great battle axe', 'greatbattleaxe', 160], ['dane_axe', 'Dane axe', 'daneaxe', 110], ['executioner_axe', 'Executioner\'s axe', 'executioner', 150],
  ['club', 'Club', 'club', 15], ['spiked_club', 'Spiked club', 'spikedclub', 35], ['greatclub', 'Greatclub', 'greatclub', 45],
  ['mace', 'Flanged mace', 'mace', 60], ['morning_star', 'Morning star', 'morningstar', 75], ['flail', 'Flail', 'flail', 90],
  ['war_hammer', 'War hammer', 'warhammer', 70], ['maul', 'Maul', 'maul', 90], ['runed_hammer', 'Runed greathammer', 'runedhammer', 180],
]) ITEMS[id] = { name, kind: 'weapon', tier: 0, svg: SVG.sword, obj: OBJ[look], make: { mats: [], prima } };
// ⭐ POLEARMS (2026-10-20, plan file §5z41) — all two-handed; Prima only (prices mine)
for (const [id, name, look, prima] of [
  ['quarterstaff', 'Quarterstaff', 'quarterstaff', 30], ['pike', 'Pike', 'pike', 70], ['glaive', 'Glaive', 'glaive', 100], ['naginata', 'Naginata', 'naginata', 110],
  ['guandao', 'Guandao', 'guandao', 140], ['halberd', 'Halberd', 'halberd', 130], ['bardiche', 'Bardiche', 'bardiche', 120], ['poleaxe', 'Poleaxe', 'poleaxe', 120],
  ['lucerne_hammer', 'Lucerne hammer', 'lucerne', 130], ['bill', 'Bill', 'bill', 100], ['scythe', 'Scythe', 'scythe', 90],
]) ITEMS[id] = { name, kind: 'weapon', tier: 0, svg: SVG.sword, obj: OBJ[look], make: { mats: [], prima } };
// ⭐ BOWS (2026-10-20, plan file §5z38 piece 2) — real objects in the hands, like the melee family (server/held.js); Prima only (prices mine)
SVG.bow = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 2.5c8 3 8 16 0 19" fill="none" stroke="#8a5a32" stroke-width="2.2" stroke-linecap="round"/><path d="M6 2.5v19" stroke="#ece4cc" stroke-width=".8"/></svg>';
for (const [id, name, prima] of [['shortbow', 'Shortbow', 40], ['longbow', 'Longbow', 70], ['recurve', 'Recurve bow', 80], ['horsebow', 'Horse bow', 85],
  ['elvenbow', 'Elven bow', 160], ['ebonbow', 'Ebon bow', 170], ['bonebow', 'Bone bow', 120]]) ITEMS[id] = { name, kind: 'weapon', tier: 0, svg: SVG.bow, obj: HELD.objOf(id), make: { mats: [], prima } };
// ⭐ ARROWS — the first things that STACK in the pouch since the stand-ins went (no `obj`): a count, like a material. Their fletching is
//   their colour, as drawn on the bow and in the quiver (client 16r). Piece 3 makes one a real object once it is loosed. Kind 'ammo'.
const arrowSvg = (fl, head) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 20 L19 5" stroke="#b08a58" stroke-width="1.6" stroke-linecap="round"/>'
  + '<path d="M19 5 l-4.6.6 4 4z" fill="' + head + '"/><path d="M4 20 l.2-4.6 M4 20 l4.6-.2 M6.2 17.8 l.2-4.2 M6.2 17.8 l4.2-.2" stroke="' + fl + '" stroke-width="1.6" stroke-linecap="round"/></svg>';
for (const [id, name, fl, head, prima] of [['arrow_bodkin', 'Bodkin arrow', '#4c4844', '#8a8e96', 2], ['arrow_broad', 'Broadhead arrow', '#b6342a', '#d6dce4', 3],
  ['arrow_field', 'Field-point arrow', '#3e60a8', '#cbd5e1', 1], ['arrow_elven', 'Elven arrow', '#d6e6de', '#e2e8f0', 6]]) ITEMS[id] = { name, kind: 'ammo', tier: 0, svg: arrowSvg(fl, head), make: { mats: [], prima } };

// ⭐ THROWABLES (2026-10-21, plan file §5z54): a STACK in the pouch (a count, a pile when dropped or scattered — `stack`) that is ALSO a real object
//   once it is out (`obj`): one in your main hand at a time, and in the hand it is still counted; throwing it spends it (`itemObjMove`) and the
//   next one comes to hand (client 16p). One lying or stuck in the world: E puts it back in the pouch. Kind 'throwable'. Prima only (prices mine).
//   Piece 1: the thrown blades.
SVG.thrown = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 4 L10.6 13.4 L9.2 12 Z" fill="#dfe5ec" stroke="#5b6472" stroke-width=".6"/><path d="M9.6 12.6 L4.4 17.8" stroke="#8a6a44" stroke-width="2.2" stroke-linecap="round"/></svg>';
for (const [id, name, look, prima] of [['throwing_knife', 'Throwing knife', 'throwknife', 4], ['kunai', 'Kunai', 'kunai', 5], ['dart', 'Dart', 'dart', 2],
  ['throwing_star', 'Throwing star', 'throwstar', 3], ['javelin', 'Javelin', 'javelin', 12], ['tomahawk', 'Tomahawk', 'tomahawk', 10]])
  ITEMS[id] = { name, kind: 'throwable', tier: 0, svg: SVG.thrown, obj: HELD.objOf(look), stack: true, make: { mats: [], prima } };
// Piece 2 (2026-10-21, plan file §5z58): THE EXPLOSIVES — a fuse (`boom`) on the object, lit by right or by the throw (server/held.js `boomE`)
SVG.bomb = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="10" cy="14" r="7" fill="#34363c"/><path d="M14.5 8.5 l2-2" stroke="#34363c" stroke-width="2.6"/><path d="M16.5 6.5 q2-2 3.5-.5" fill="none" stroke="#c4ac78" stroke-width="1.2"/></svg>';
for (const [id, name, look, prima] of [['bomb', 'Bomb', 'thbomb', 15], ['dynamite', 'Dynamite', 'dynamite', 12], ['dynamite_bundle', 'Bundle of dynamite', 'dynbundle', 30],
  ['tar_ball', 'Tar ball', 'tarball', 18]])
  ITEMS[id] = { name, kind: 'throwable', tier: 0, svg: SVG.bomb, obj: Object.assign(HELD.objOf(look), { boom: HELD.LOOKS[look].boom }), stack: true, make: { mats: [], prima } };
// Piece 3 part A (2026-10-21, plan file §5z62): the PRESSURE BOMB and the FLASH-BANG — on the same fuse, each its own burst (server/held.js `burst`)
SVG.pressure = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="5" y="7" width="12" height="13" rx="3" fill="#c4a04a"/><circle cx="11" cy="13.5" r="2.4" fill="#ece8d6" stroke="#8a6a2c" stroke-width=".8"/><path d="M11 7V4M8 4h6" stroke="#6a6e76" stroke-width="1.6" stroke-linecap="round"/></svg>';
SVG.flash = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="7" y="7" width="9" height="14" rx="1.5" fill="#56623e"/><rect x="7" y="12" width="9" height="2.2" fill="#dec046"/><path d="M8.5 7V5h6v2" fill="#a8b0aa"/><circle cx="18" cy="4.5" r="1.8" fill="none" stroke="#c8ccd0" stroke-width="1"/></svg>';
// Piece 3 part B1 (2026-10-21, plan file §5z65): the MOLOTOV — breaks where it lands (server/held.js `breaks`; server `thr-break`)
SVG.molotov = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9 21h6a2 2 0 0 0 2-2v-7l-2.4-2.6V6h-3.2v3.4L9 12v7a2 2 0 0 0 0 2z" fill="#4a7a44"/><path d="M12.2 6c0-1.6 1.6-2.2 2.4-3.6" fill="none" stroke="#d8c8a6" stroke-width="1.6" stroke-linecap="round"/><path d="M14.6 2.4c.9.5 1.2 1.6.4 2.4-.4-.6-1-.8-1.5-.9.7-.3 1-.8 1.1-1.5z" fill="#ff9a2e"/></svg>';
// Piece 3 part B2 (2026-10-21, plan file §5z69): the GREASE FLASK — breaks the same way; soaks whoever it hits, greases the ground
SVG.grease = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M10.2 3.6h3.6v4.2c2.9 1 4.9 3.6 4.9 6.7 0 3.9-3 6.9-6.7 6.9s-6.7-3-6.7-6.9c0-3.1 2-5.7 4.9-6.7z" fill="#7a6a52"/><path d="M6.6 14.6c1.6-.8 3.6-.5 5.4.2s3.8.9 5.4.1c-.1 3.4-2.6 6.1-5.4 6.1s-5.4-2.6-5.4-6.4z" fill="#2a1a0c"/><rect x="9.7" y="2" width="4.6" height="2.6" rx=".8" fill="#b08a5a"/><path d="M8.6 11.6c.4-1 1.1-1.7 1.9-2.1" fill="none" stroke="#e8dcc4" stroke-width="1" stroke-linecap="round" opacity=".7"/></svg>';
// Piece 3 part C (2026-10-21, plan file §5z72): the FROST FLASK (freezes who is near, water to ice) and the SMOKE FLASK (a cloud nobody sees through)
const flaskSvg = (glass, inside, extra) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M10.2 3.6h3.6v4.2c2.9 1 4.9 3.6 4.9 6.7 0 3.9-3 6.9-6.7 6.9s-6.7-3-6.7-6.9c0-3.1 2-5.7 4.9-6.7z" fill="' + glass + '"/><path d="M6.6 14.6c1.6-.8 3.6-.5 5.4.2s3.8.9 5.4.1c-.1 3.4-2.6 6.1-5.4 6.1s-5.4-2.6-5.4-6.4z" fill="' + inside + '"/><rect x="9.7" y="2" width="4.6" height="2.6" rx=".8" fill="#b08a5a"/>' + (extra || '') + '</svg>';
SVG.frost = flaskSvg('#bfe2f6', '#e8f6ff', '<path d="M12 11.5v6M9.4 13l5.2 3M9.4 16l5.2-3" stroke="#6fb2dc" stroke-width="1" stroke-linecap="round"/>');
for (const [id, name, look, svg, prima] of [['molotov', 'Molotov', 'molotov', SVG.molotov, 12], ['grease_flask', 'Grease flask', 'greaseflask', SVG.grease, 8],
  ['frost_flask', 'Frost flask', 'frostflask', SVG.frost, 10]])
  ITEMS[id] = { name, kind: 'throwable', tier: 0, svg, obj: HELD.objOf(look), stack: true, make: { mats: [], prima } };
// (§5z73) the SMOKE BOMB — a can, on the fuse like the flash-bang (it replaced the smoke flask)
SVG.smokebomb = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="7" y="7" width="9" height="14" rx="1.5" fill="#6e7468"/><rect x="7" y="9" width="9" height="1.6" fill="#e6e4dc"/><circle cx="9.5" cy="15" r="1.1" fill="#4a4e46"/><circle cx="13.5" cy="15" r="1.1" fill="#4a4e46"/><path d="M8.5 7V5h6v2" fill="#a8b0aa"/><circle cx="18" cy="4.5" r="1.8" fill="none" stroke="#c8ccd0" stroke-width="1"/><path d="M15 4c1.5-1.8 3.5-1.4 4-3" stroke="#d6d8dc" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".8"/></svg>';
for (const [id, name, look, svg, prima] of [['pressure_bomb', 'Pressure bomb', 'canister', SVG.pressure, 14], ['flash_bang', 'Flash-bang', 'flashbang', SVG.flash, 10], ['smoke_bomb', 'Smoke bomb', 'smokebomb', SVG.smokebomb, 8]])
  ITEMS[id] = { name, kind: 'throwable', tier: 0, svg, obj: Object.assign(HELD.objOf(look), { boom: HELD.LOOKS[look].boom }), stack: true, make: { mats: [], prima } };

// Piece 4 (2026-10-22, plan file §5z76): the DODGEBALL (bounces — `lbnc` 4 of 5, a basketball's is 5) and the EGG (breaks: a splat)
SVG.dodgeball = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="#cc3830"/><path d="M3.5 12h17M12 3.5c-3 2.4-3 14.6 0 17" fill="none" stroke="#7a1c18" stroke-width="1"/><circle cx="9" cy="8.6" r="2.2" fill="#ffffff" opacity=".35"/></svg>';
SVG.egg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 3.2c3.6 0 6.2 5.6 6.2 10.2 0 4-2.8 6.6-6.2 6.6s-6.2-2.6-6.2-6.6C5.8 8.8 8.4 3.2 12 3.2z" fill="#eee2c8" stroke="#b8a684" stroke-width=".8"/><ellipse cx="10.2" cy="9" rx="1.6" ry="2.4" fill="#ffffff" opacity=".6"/></svg>';
ITEMS.dodgeball = { name: 'Dodgeball', kind: 'throwable', tier: 0, svg: SVG.dodgeball, obj: Object.assign(HELD.objOf('dodgeball'), { lbnc: 4, shape: 'ellipse' }), stack: true, make: { mats: [], prima: 4 } };
ITEMS.egg = { name: 'Egg', kind: 'throwable', tier: 0, svg: SVG.egg, obj: Object.assign(HELD.objOf('egg'), { shape: 'ellipse' }), stack: true, make: { mats: [], prima: 1 } };

// ⭐ LIGHTS, PIECE 1 (2026-10-22, plan file §5z96): the FLASHLIGHT — a real object in either hand (server/held.js `flashlight`), never runs out.
//   Kind 'light' (the window's Light filter); ⚠️ only a light WITH A FLAME is a torch (`fire` in server/held.js — `torch-ignite`, client 16k).
SVG.flashlight = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 10 L21 6.5 L22.6 11.5 L15.2 12.6 Z" fill="#fff8d0" opacity=".55"/><rect x="3" y="9.6" width="9" height="4.4" rx="1.2" fill="#4a4e58"/><path d="M12 9.2 L15.2 8.4 L15.2 15.2 L12 14.4 Z" fill="#7e8490"/><rect x="15.2" y="8.4" width=".8" height="6.8" fill="#fffce8"/><circle cx="8" cy="11.8" r=".9" fill="#24242a"/></svg>';
ITEMS.flashlight = { name: 'Flashlight', kind: 'light', tier: 0, svg: SVG.flashlight, obj: HELD.objOf('flashlight'), make: { mats: [], prima: 30 } };
// ⭐ LIGHTS, PIECE 2 (2026-10-24, plan file §5z96): the STORM LANTERN (server/held.js `lantern`) — H clips it to your belt; breaks into burning oil when thrown.
SVG.lantern = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.4 7.6 C7.4 1.6 16.6 1.6 16.6 7.6" fill="none" stroke="#5c6066" stroke-width="1.1"/><path d="M8.6 6.4h6.8l1 1.6h-8.8z" fill="#2c5438"/><path d="M9.2 8 C6.6 9.6 6.6 14.6 9.2 16.2h5.6c2.6-1.6 2.6-6.6 0-8.2z" fill="#ffd488" opacity=".9"/><path d="M12 10.4c1 1.3 1.1 2.6 0 3.6-1.1-1-1-2.3 0-3.6z" fill="#fff4d0"/><path d="M8.4 9.2v6.2M15.6 9.2v6.2M12 8v8.2" stroke="#5c6066" stroke-width=".7"/><path d="M7 16.2h10l-.6 3.2c-.2.8-.9 1.2-1.7 1.2H9.3c-.8 0-1.5-.4-1.7-1.2z" fill="#2c5438"/></svg>';
// ⭐ LIGHTS, PIECE 4 (2026-10-24, plan file §5z96): the ROAD FLARE and the GLOWSTICKS — throwables in stacks (server/held.js `flare`, `glowg`…)
SVG.flare = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g transform="rotate(-40 12 12)"><rect x="10.2" y="5" width="3.6" height="15" rx="1" fill="#bc2420"/><rect x="10.2" y="3" width="3.6" height="3" rx=".8" fill="#2c2826"/><rect x="10.2" y="9" width="3.6" height="1.2" fill="#f4e6c8" opacity=".8"/></g></svg>';
const glowSvg = (c) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g transform="rotate(-40 12 12)"><rect x="9" y="3" width="6" height="18" rx="3" fill="' + c + '" opacity=".35"/><rect x="10.6" y="4" width="2.8" height="16" rx="1.4" fill="' + c + '"/><circle cx="12" cy="2.6" r="1.1" fill="none" stroke="#c0c4cc" stroke-width=".6"/></g></svg>';
ITEMS.flare = { name: 'Road flare', kind: 'light', tier: 0, svg: SVG.flare, obj: HELD.objOf('flare'), stack: true, make: { mats: [], prima: 6 } };
for (const [id, name, look, c] of [['glowstick_green', 'Glowstick (green)', 'glowg', '#96ff6e'], ['glowstick_yellow', 'Glowstick (yellow)', 'glowy', '#ecff60'],
  ['glowstick_cyan', 'Glowstick (cyan)', 'glowc', '#6ee8ff'], ['glowstick_pink', 'Glowstick (pink)', 'glowp', '#ff78da']])
  ITEMS[id] = { name, kind: 'light', tier: 0, svg: glowSvg(c), obj: HELD.objOf(look), stack: true, make: { mats: [], prima: 3 } };
// ⭐ LIGHTS, PIECE 3 (2026-10-24, plan file §5z96): the LED HEADLAMP (server/held.js `headlamp`) — right puts it on your head.
SVG.headlamp = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 12.5c0-4 4-6.5 9-6.5s9 2.5 9 6.5" fill="none" stroke="#2a2c32" stroke-width="2.4" stroke-linecap="round"/><rect x="7.5" y="9.5" width="9" height="7" rx="2" fill="#3a3d46"/><circle cx="12" cy="13" r="2.4" fill="#f4f8ff"/><circle cx="12" cy="13" r="3.6" fill="#e8f0ff" opacity=".35"/></svg>';
ITEMS.headlamp = { name: 'Headlamp', kind: 'light', tier: 0, svg: SVG.headlamp, obj: HELD.objOf('headlamp'), make: { mats: [], prima: 30 } };
ITEMS.lantern = { name: 'Lantern', kind: 'light', tier: 0, svg: SVG.lantern, obj: HELD.objOf('lantern'), make: { mats: [], prima: 25 } };
// ⭐ TOOLS, PIECE 1 (2026-10-25, the tools plan `scratchpad/kickoff_tools.md` §13): the PICKAXE and the HAND PICK (server/held.js `dig`). Kind 'tool' (the
//   window's Tools filter). One material each for now (`tier` 0); the tiers come with crafting (the plan's §7).
SVG.pickaxe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 20.5 L15.6 7.4" stroke="#b08452" stroke-width="2" stroke-linecap="round"/><path d="M4.2 7.2 C9 3.6 15.4 3.2 21 6.8 C15.6 5.4 10 5.6 4.2 7.2z" fill="#7e838c" stroke="#3a3d44" stroke-width=".6"/><circle cx="15.2" cy="5.6" r="1.6" fill="#6a6e76"/></svg>';
SVG.handpick = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6.4 20.2 L14.4 9.6" stroke="#b08452" stroke-width="2" stroke-linecap="round"/><path d="M12.6 6.4 L16.4 9.2 C18.6 10.6 20.2 13 21 16 C18.4 13.8 16 12.6 13.8 11.6 L11 9.8z" fill="#7e838c" stroke="#3a3d44" stroke-width=".6"/><rect x="10.6" y="4.6" width="3.4" height="3.6" rx=".6" transform="rotate(36 12.3 6.4)" fill="#6a6e76" stroke="#3a3d44" stroke-width=".6"/></svg>';
ITEMS.pickaxe = { name: 'Pickaxe', kind: 'tool', tier: 0, svg: SVG.pickaxe, obj: HELD.objOf('pickaxe'), make: { mats: [], prima: 40 } };
ITEMS.hand_pick = { name: 'Hand pick', kind: 'tool', tier: 0, svg: SVG.handpick, obj: HELD.objOf('handpick'), make: { mats: [], prima: 25 } };
// ⭐ TOOLS, PIECE 2 (2026-10-25): the SLEDGEHAMMER and the CLUB HAMMER (server/held.js `dig` kind 'hammer')
SVG.sledge = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4.6 20.6 L14.8 9" stroke="#b08452" stroke-width="2" stroke-linecap="round"/><rect x="9.6" y="3.6" width="12" height="6.4" rx="1.4" transform="rotate(-41 15.6 6.8)" fill="#5c626e" stroke="#2e3138" stroke-width=".6"/></svg>';
SVG.clubhammer = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6.4 20.2 L14.2 10.6" stroke="#b08452" stroke-width="2.2" stroke-linecap="round"/><rect x="10.8" y="4.6" width="9" height="5.6" rx="1.2" transform="rotate(-39 15.3 7.4)" fill="#5c626e" stroke="#2e3138" stroke-width=".6"/></svg>';
ITEMS.sledgehammer = { name: 'Sledgehammer', kind: 'tool', tier: 0, svg: SVG.sledge, obj: HELD.objOf('sledgehammer'), make: { mats: [], prima: 45 } };
ITEMS.club_hammer = { name: 'Club hammer', kind: 'tool', tier: 0, svg: SVG.clubhammer, obj: HELD.objOf('clubhammer'), make: { mats: [], prima: 20 } };
// ⭐ TOOLS, PIECE 3 (2026-10-25): the CHISEL PAIRS — one item in both hands. `obj` = the hammer (the main hand's, and what lies in the world when it is put
//   down); `pair` = the chisel the off hand holds beside it. The chisel is never an item of its own: it is out only while its hammer is (server `pair` objects).
SVG.coldchisel = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3.6 20.4 L10.4 13.6" stroke="#b08452" stroke-width="2" stroke-linecap="round"/><rect x="7.6" y="9.4" width="7" height="4.6" rx="1" transform="rotate(-45 11.1 11.7)" fill="#5c626e" stroke="#2e3138" stroke-width=".6"/><path d="M13.6 3.2 L15.4 3.2 L15.4 15.4 L14.5 18.6 L13.6 15.4z" fill="#8a9099" stroke="#3a3d44" stroke-width=".5" transform="rotate(30 14.5 11)"/></svg>';
SVG.woodchisel = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3.6 20.4 L9.8 14.2" stroke="#c49a62" stroke-width="2" stroke-linecap="round"/><rect x="6.6" y="8.6" width="8.6" height="5.6" rx="1.4" transform="rotate(-45 10.9 11.4)" fill="#c8966a" stroke="#6e4a2a" stroke-width=".6"/><rect x="13.4" y="2.6" width="2.6" height="7" rx=".8" fill="#c49a62" stroke="#6e4a2a" stroke-width=".5" transform="rotate(30 14.7 11)"/><path d="M13.6 9.6 L15.8 9.6 L15.6 17.4 L13.8 17.4z" fill="#a8aeb6" stroke="#3a3d44" stroke-width=".5" transform="rotate(30 14.7 11)"/></svg>';
ITEMS.cold_chisel = { name: 'Cold chisel & club hammer', kind: 'tool', tier: 0, svg: SVG.coldchisel, obj: HELD.objOf('clubhammer'), pair: HELD.objOf('coldchisel'), make: { mats: [], prima: 30 } };
ITEMS.wood_chisel = { name: 'Wood chisel & mallet', kind: 'tool', tier: 0, svg: SVG.woodchisel, obj: HELD.objOf('mallet'), pair: HELD.objOf('woodchisel'), make: { mats: [], prima: 22 } };
// ⭐ TOOLS, PIECE 4 (2026-10-25): the SPADE and the SMALL SPADE (server/held.js `spade`)
SVG.spade = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5.2 4.2 L7.6 6.6" stroke="#b08452" stroke-width="2.2" stroke-linecap="round"/><path d="M3.6 6.2 L6.2 3.6" stroke="#b08452" stroke-width="1.8" stroke-linecap="round"/><path d="M6.8 5.8 L15.2 14.2" stroke="#b08452" stroke-width="1.9" stroke-linecap="round"/><path d="M13.6 14.4 L16.4 11.6 L21.2 16.4 C21.4 18.6 20.8 20.4 20.6 20.6 C20.4 20.8 18.6 21.4 16.4 21.2z" fill="#5c626e" stroke="#2c3038" stroke-width=".7"/></svg>';
SVG.smallspade = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 7.6 L7.6 5" stroke="#b08452" stroke-width="2" stroke-linecap="round"/><path d="M6.6 6.6 L13 13" stroke="#b08452" stroke-width="2" stroke-linecap="round"/><path d="M11.8 13.6 L13.6 11.8 L18.4 16.6 C18.6 18.2 18 19.6 17.8 19.8 C17.6 20 16.2 20.6 14.6 20.4z" fill="#5c626e" stroke="#2c3038" stroke-width=".7"/></svg>';
ITEMS.spade = { name: 'Spade', kind: 'tool', tier: 0, svg: SVG.spade, obj: HELD.objOf('spade'), make: { mats: [], prima: 30 } };
ITEMS.small_spade = { name: 'Small spade', kind: 'tool', tier: 0, svg: SVG.smallspade, obj: HELD.objOf('smallspade'), make: { mats: [], prima: 18 } };
// ⭐ TOOLS, PIECE 5 (2026-10-25): the FELLING AXE and the HATCHET (server/held.js `dig` kind 'axe'), the MATTOCK (a pick + an adze) and the PICK-HEAD AXE (an axe + a pick)
SVG.fellingaxe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4.6 20.8 L15.6 6.4" stroke="#b08452" stroke-width="2" stroke-linecap="round"/><path d="M13.4 3.4 L17.6 6.6 L16.2 8.6 C17.6 10.8 19.6 12.2 21.8 12.4 C21.8 8.6 19.8 4.8 16.4 2.4 L15.2 4.2z" fill="#7e838c" stroke="#3a3d44" stroke-width=".6" stroke-linejoin="round"/><path d="M21.8 12.4 C21.8 8.6 19.8 4.8 16.4 2.4" fill="none" stroke="#dfe3ea" stroke-width=".8"/></svg>';
SVG.hatchet = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 20.4 L14.6 9.4" stroke="#b08452" stroke-width="2.2" stroke-linecap="round"/><path d="M12.6 6.6 L16.6 9.8 L15.4 11.2 C16 13.4 17.4 15.6 19.6 16.6 C20.6 12.6 19.6 8.4 16.6 5.6 L14.2 4.8z" fill="#7e838c" stroke="#3a3d44" stroke-width=".6" stroke-linejoin="round"/><path d="M19.6 16.6 C20.6 12.6 19.6 8.4 16.6 5.6" fill="none" stroke="#dfe3ea" stroke-width=".8"/></svg>';
SVG.mattock = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 20.5 L15.6 7.4" stroke="#b08452" stroke-width="2" stroke-linecap="round"/><path d="M15.4 5.6 C18 6 20.2 6.8 21.6 8.2 C19.4 7.6 17.4 7.4 15.4 7.6z" fill="#7e838c" stroke="#3a3d44" stroke-width=".6"/><path d="M15 5.4 C11.6 3.6 7.6 3 3.6 3.6 L3.8 5 C7.6 4.8 11.4 5.6 14.4 7.2z" fill="#7e838c" stroke="#3a3d44" stroke-width=".6"/><circle cx="15.2" cy="6.4" r="1.6" fill="#6a6e76"/></svg>';
SVG.pickheadaxe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4.6 20.8 L14.8 7.2" stroke="#b08452" stroke-width="2" stroke-linecap="round"/><path d="M13 4.6 L16.6 7.4 L15.6 8.8 C16.8 10.8 18.6 12.2 20.8 12.6 C21 9 19.6 5.8 16.8 3.6 L15.4 5.2 C12.6 3.4 8.8 2.4 4.8 2.8 C8 3.6 10.8 4.6 13 6.2z" fill="#7e838c" stroke="#3a3d44" stroke-width=".6" stroke-linejoin="round"/><path d="M20.8 12.6 C21 9 19.6 5.8 16.8 3.6" fill="none" stroke="#dfe3ea" stroke-width=".8"/></svg>';
ITEMS.felling_axe = { name: 'Felling axe', kind: 'tool', tier: 0, svg: SVG.fellingaxe, obj: HELD.objOf('fellingaxe'), make: { mats: [], prima: 35 } };
ITEMS.hatchet = { name: 'Hatchet', kind: 'tool', tier: 0, svg: SVG.hatchet, obj: HELD.objOf('hatchet'), make: { mats: [], prima: 18 } };
ITEMS.mattock = { name: 'Mattock', kind: 'tool', tier: 0, svg: SVG.mattock, obj: HELD.objOf('mattock'), make: { mats: [], prima: 40 } };
ITEMS.pick_head_axe = { name: 'Pick-head axe', kind: 'tool', tier: 0, svg: SVG.pickheadaxe, obj: HELD.objOf('pickheadaxe'), make: { mats: [], prima: 40 } };
// ⭐ TOOLS, PIECE 6 (2026-10-26): the GRAPPLING HOOK on a rope (server/held.js `grapnel` — client 16za)
SVG.grapnel = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 21 C6 17 5 13 9.4 10.6" fill="none" stroke="#c8a26a" stroke-width="1.4" stroke-linecap="round"/><circle cx="10.2" cy="9.8" r="1.4" fill="none" stroke="#5b6170" stroke-width="1.1"/><path d="M11.2 8.8 L17.6 2.4" stroke="#7e838c" stroke-width="1.8" stroke-linecap="round"/><path d="M17 3 C20.4 4.4 21 7.6 18.8 9.8 M17 3 C15.6 6.4 12.4 7 10.2 4.8 M17 3 C19.2 2.2 21.6 1.6 22 3.6" fill="none" stroke="#7e838c" stroke-width="1.4" stroke-linecap="round"/></svg>';
ITEMS.grappling_hook = { name: 'Grappling hook', kind: 'tool', tier: 0, svg: SVG.grapnel, obj: HELD.objOf('grapnel'), make: { mats: [], prima: 25 } };
// ⭐ TOOLS, PIECE 7 (2026-11-03): the GRAPPLE LAUNCHER (server/held.js `launcher` — client 16zc)
SVG.launcher = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="6.5" width="17" height="4.4" rx="1" fill="#5c626e"/><rect x="20" y="7.3" width="2.4" height="2.8" rx=".6" fill="#7e838c"/><path d="M4.4 10.9 H9.4 L8 15 L7.4 20 H3.6 L3.4 18.4 L4.8 15 Z" fill="#26262a"/><path d="M9.2 10.9 L9.6 13 C10.2 14.6 13.4 14.6 14 13 L14.2 10.9" fill="none" stroke="#b8c0cc" stroke-width="1"/><path d="M11.2 10.9 L11.9 12.8" stroke="#e2e8f0" stroke-width="1"/><circle cx="17.6" cy="12.2" r="2.4" fill="#7e8490"/><circle cx="17.6" cy="12.2" r=".9" fill="#3a3e48"/></svg>';
ITEMS.grapple_launcher = { name: 'Grapple launcher', kind: 'tool', tier: 0, svg: SVG.launcher, obj: HELD.objOf('launcher'), make: { mats: [], prima: 40 } };
// ⭐ TOOLS, PIECE 8 (2026-11-03): the WOODEN BUCKET (server/held.js `woodbucket` — client 16zd). What it holds is not part of the item: see `vesselRows` in index.js
SVG.woodbucket = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 9.5 C5 2.5 19 2.5 19 9.5" fill="none" stroke="#b29a6e" stroke-width="1.3"/><path d="M4.2 9.5 H19.8 L18 21 H6 Z" fill="#96683e"/><path d="M8.2 9.5 L9 21 M12 9.5 V21 M15.8 9.5 L15 21" stroke="#6a4626" stroke-width=".8"/><path d="M4.6 12 H19.4 M5.4 18 H18.6" stroke="#767a82" stroke-width="1.4"/></svg>';
ITEMS.wood_bucket = { name: 'Wooden bucket', kind: 'tool', tier: 0, svg: SVG.woodbucket, obj: HELD.objOf('woodbucket'), make: { mats: [], prima: 15 } };
// (increment 2) the STEEL PAIL and the two glass FLASKS. (2026-11-03, the user: "just not have any stacking of such things at all") None of them stacks: each is its own thing, with what is in it (server `vesselRows`)
SVG.steelpail = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 9.5 C5 2.5 19 2.5 19 9.5" fill="none" stroke="#c6ccd2" stroke-width="1"/><rect x="10" y="2.6" width="4" height="1.5" rx=".7" fill="#8e6236"/><path d="M4.2 9.5 H19.8 L18 21 H6 Z" fill="#a0a8ac"/><path d="M4.9 13 H19.1 M5.5 17 H18.5" stroke="#ced4d6" stroke-width="1.1"/></svg>';
SVG.roundflask = flaskSvg('#cfe6f2', '#6fb2dc');
SVG.bottleflask = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M10.4 4h3.2v4.2c1.9.8 3 2.3 3 4.3V20a1.5 1.5 0 0 1-1.5 1.5H8.9A1.5 1.5 0 0 1 7.4 20v-7.5c0-2 1.1-3.5 3-4.3z" fill="#cfe6f2"/><path d="M7.4 14h9.2v6a1.5 1.5 0 0 1-1.5 1.5H8.9A1.5 1.5 0 0 1 7.4 20z" fill="#6fb2dc"/><rect x="9.9" y="2" width="4.2" height="2.6" rx=".8" fill="#b08a5a"/></svg>';
ITEMS.steel_pail = { name: 'Steel pail', kind: 'tool', tier: 0, svg: SVG.steelpail, obj: HELD.objOf('steelpail'), make: { mats: [], prima: 30 } };
ITEMS.round_flask = { name: 'Round flask', kind: 'throwable', tier: 0, svg: SVG.roundflask, obj: HELD.objOf('roundflask'), make: { mats: [], prima: 8 } };
ITEMS.glass_bottle = { name: 'Glass bottle', kind: 'throwable', tier: 0, svg: SVG.bottleflask, obj: HELD.objOf('bottleflask'), make: { mats: [], prima: 10 } };
// ⭐⭐ WORN GEAR (2026-11-12, `scratchpad/kickoff_worn_gear.md`): FIVE SLOTS — head, body, hands, feet, back (capes) (the user). A piece of gear is an
//   ordinary item (a kind plus a count, it drops on death like everything else) with `slot` = where it is worn. Wearing one points a slot at it;
//   the count stays in the pouch (server `worn-set`, ledger `worn`). No `obj`: gear is never held, and dropped it lies in a pile.
//   These five are the first set, to try the slots: their pictures here only; how each looks on the body comes next (drawn in 3D, from scratch).
// (2026-11-15, kickoff_gear_function.md step 3) a SIXTH slot, the EYES: glasses, sunglasses, a monocle, goggles — in the list after the head (the strip's order).
const WORN_SLOTS = ['head', 'eyes', 'body', 'hands', 'feet', 'back'];
const MET = 'fill="#b8c0cc" stroke="#5b6472" stroke-width=".8"';
SVG.ironhelmet = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 16c0-5.6 3.6-10 8-10s8 4.4 8 10v3H4z" ' + MET + '/><rect x="6" y="12.6" width="12" height="1.8" rx=".5" fill="#2a2e36"/><path d="M12 6.2v5.6M12 15v4" stroke="#8f98a5" stroke-width=".8"/></svg>';
SVG.ironbreastplate = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 4h3c.6 1.6 1.7 2.4 3 2.4S14.4 5.6 15 4h3l2.4 4-2.4 2v8c-1.8 1.6-3.8 2.4-6 2.4S7.8 19.6 6 18v-8L3.6 8z" ' + MET + '/><path d="M12 7.2v12.6" stroke="#8f98a5" stroke-width=".8"/></svg>';
SVG.irongauntlets = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.4 18.4v-4.6l-1.9-3.4c-.5-1 .9-1.8 1.6-.9L9 12V5.6c0-1.2 1.8-1.2 1.8 0V11V4.6c0-1.2 1.8-1.2 1.8 0V11V5.2c0-1.2 1.8-1.2 1.8 0V11.2V7.2c0-1.2 1.8-1.2 1.8 0v7.4c0 2.2-1.4 3.8-3.6 3.8z" ' + MET + '/><rect x="6.6" y="18" width="9.8" height="3.4" rx=".8" fill="#8f98a5" stroke="#5b6472" stroke-width=".8"/></svg>';
SVG.ironboots = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7 3h6.4v9.6l5.8 2.4c1 .4 1.6 1.4 1.6 2.5V20H4.6v-6.6L7 12z" ' + MET + '/><path d="M4.6 17.6h16.2M7 8h6.4" stroke="#5b6472" stroke-width=".9"/></svg>';
SVG.clothcape = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8 3h8l1.2 2.2C19.4 10.4 20.4 15 20.6 21H3.4C3.6 15 4.6 10.4 6.8 5.2z" fill="#8a2a2a" stroke="#4a1414" stroke-width=".8"/><path d="M9.6 9l-1.4 11M14.4 9l1.4 11" stroke="#6e1f1f" stroke-width=".8"/><path d="M8 3.2c1 1.4 2.4 2 4 2s3-.6 4-2" fill="none" stroke="#d4a537" stroke-width="1.3"/></svg>';
ITEMS.iron_helmet = { name: 'Iron helmet', kind: 'worn', slot: 'head', mat: 'plate', wt: 4, tier: 0, svg: SVG.ironhelmet, bars: ['eyes'], make: { mats: [], prima: 60 } };   // (bars: no eyewear under a closed helmet — the user, 2026-11-15)
ITEMS.iron_breastplate = { name: 'Iron breastplate', kind: 'worn', slot: 'body', mat: 'plate', wt: 10, tier: 0, svg: SVG.ironbreastplate, make: { mats: [], prima: 120 } };
ITEMS.iron_gauntlets = { name: 'Iron gauntlets', kind: 'worn', slot: 'hands', mat: 'plate', wt: 2, tier: 0, svg: SVG.irongauntlets, make: { mats: [], prima: 50 } };
ITEMS.iron_boots = { name: 'Iron boots', kind: 'worn', slot: 'feet', mat: 'plate', wt: 3, tier: 0, svg: SVG.ironboots, make: { mats: [], prima: 50 } };
ITEMS.cloth_cape = { name: 'Cloth cape', kind: 'worn', slot: 'back', mat: 'linen', wt: 1, tier: 0, svg: SVG.clothcape, make: { mats: [], prima: 40 } };
// (2026-11-12, `scratchpad/kickoff_worn_build.md`) the first clothes: drawn on the body in 3D (client 16zf `WORN_LOOK`), every top on the same lowest neckline
const LINEN = 'fill="#c9b48a" stroke="#6f5c3c" stroke-width=".8"';
SVG.linenshirt = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8.6 3.6c.8 1.8 2 2.6 3.4 2.6s2.6-.8 3.4-2.6l4.4 2.6-1.6 4.4-1.8-.6V20.4H7.6V10l-1.8.6-1.6-4.4z" ' + LINEN + '/><path d="M11 7.4l2 1.4M13 7.4l-2 1.4M11 9.4l2 1.4M13 9.4l-2 1.4" stroke="#b39462" stroke-width=".7"/><path d="M7.6 15.4h8.8" stroke="#b39462" stroke-width="1.2"/></svg>';
SVG.linentunic = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8.6 3.2c.8 1.8 2 2.6 3.4 2.6s2.6-.8 3.4-2.6l4.4 2.6-1.6 4.4-1.8-.6v3.8l2.2 7.4H5.4l2.2-7.4V9.6l-1.8.6-1.6-4.4z" ' + LINEN + '/><path d="M7.6 13.4h8.8" stroke="#b39462" stroke-width="1.3"/><path d="M10 14l-.8 6.6M14 14l.8 6.6" stroke="#8f7a55" stroke-width=".6"/></svg>';
SVG.blueroberobe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8.6 2.8c.8 1.8 2 2.6 3.4 2.6s2.6-.8 3.4-2.6l4 2.4-1.4 4-1.6-.5L18.8 21.2H5.2L7.6 8.7 6 9.2l-1.4-4z" fill="#2f3f8f" stroke="#d6ab45" stroke-width=".8"/><path d="M11 5.6h2l.9 15.6h-3.8z" fill="#e6dcc0" stroke="#d6ab45" stroke-width=".6"/><path d="M8 12.6h8" stroke="#d6ab45" stroke-width="1"/></svg>';
SVG.wizardhat = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9 15.6c.4-4.2 1.6-8 3.6-10.4 1.6-1.8 4-2.4 6-1.2-2.2.2-3.6 1.6-4.4 3.8-.8 2.4-1.2 5-1.2 7.8z" fill="#2f3f8f" stroke="#1a2458" stroke-width=".8"/><ellipse cx="12" cy="16.8" rx="9.6" ry="2.6" fill="#2f3f8f" stroke="#1a2458" stroke-width=".8"/><path d="M8.8 15.4c2 .8 4.4.8 6.4 0" stroke="#d6ab45" stroke-width="1.3" fill="none"/></svg>';
SVG.leathershoes = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3.6 16.2c0-3.2 2.4-5.6 6-6.2l3.4 2.8 4.4.8c2.2.4 3.4 1.6 3.4 3v1.2H3.6z" fill="#6b4528" stroke="#3f2817" stroke-width=".8"/><path d="M3.2 17.8h17.6v1.6H3.2z" fill="#2c2119"/><path d="M9.6 10.4l1.4 4.6" stroke="#3f2817" stroke-width="1.1"/><circle cx="11.2" cy="15.2" r=".7" fill="#d6ab45"/></svg>';
ITEMS.linen_shirt = { name: 'Linen shirt', kind: 'worn', slot: 'body', mat: 'linen', wt: 0.5, tier: 0, svg: SVG.linenshirt, make: { mats: [], prima: 20 } };
ITEMS.linen_tunic = { name: 'Linen tunic', kind: 'worn', slot: 'body', mat: 'linen', wt: 1, tier: 0, svg: SVG.linentunic, make: { mats: [], prima: 25 } };
ITEMS.blue_robe = { name: 'Blue robe', kind: 'worn', slot: 'body', mat: 'linen', wt: 2, tier: 0, svg: SVG.blueroberobe, make: { mats: [], prima: 40 } };
ITEMS.wizard_hat = { name: 'Wizard hat', kind: 'worn', slot: 'head', mat: 'linen', wt: 0.5, tier: 0, svg: SVG.wizardhat, make: { mats: [], prima: 30 } };
ITEMS.leather_shoes = { name: 'Leather shoes', kind: 'worn', slot: 'feet', mat: 'leather', wt: 1, tier: 0, svg: SVG.leathershoes, make: { mats: [], prima: 15 } };
// ⭐ THE EYES SLOT (2026-11-15, the user's picks off `scratchpad/look/gear/eyes_styles/options.html` — all seven). `mat: 'glass'`; `eyes`: which eyes it covers
//   (the body's −1 / +1 side; a monocle one); `prot` (optional, any piece): the item's OWN protection in % by kind of hit, over its material's (the user: kinds of armour
//   may have their own stats). An edged hit on a covered eye never goes in: it lands as a weaker blow and cracks the lens (client 16zi). Drawn: client 16zf `WORN_LOOK`.
const GLS = (frame, lens, extra) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' + (extra || '') + frame + lens + '</svg>';
SVG.roundspectacles = GLS('<path d="M2.4 10.6l2-1.2M21.6 10.6l-2-1.2M10.2 12.2c1-1 2.6-1 3.6 0" fill="none" stroke="#3c3e46" stroke-width="1"/>', '<circle cx="7" cy="13" r="3.6" fill="#dbe9f5" fill-opacity=".45" stroke="#3c3e46" stroke-width="1"/><circle cx="17" cy="13" r="3.6" fill="#dbe9f5" fill-opacity=".45" stroke="#3c3e46" stroke-width="1"/>');
SVG.squareglasses = GLS('<path d="M2 10.4l1.6-.6M22 10.4l-1.6-.6M10.4 11.8c1-.7 2.2-.7 3.2 0" fill="none" stroke="#5c341e" stroke-width="1.4"/>', '<rect x="2.6" y="9.6" width="7.8" height="6.4" rx="1.4" fill="#dbe9f5" fill-opacity=".45" stroke="#5c341e" stroke-width="1.6"/><rect x="13.6" y="9.6" width="7.8" height="6.4" rx="1.4" fill="#dbe9f5" fill-opacity=".45" stroke="#5c341e" stroke-width="1.6"/>');
SVG.sunglasses = GLS('<path d="M10.4 11.4c1-.6 2.2-.6 3.2 0" fill="none" stroke="#18181c" stroke-width="1.6"/>', '<path d="M2.2 9.4h8.4v3.2c0 2.2-1.6 3.6-4 3.6s-4.4-1.6-4.4-4z" fill="#1e2228" stroke="#18181c" stroke-width="1.4"/><path d="M13.4 9.4h8.4v2.8c0 2.4-2 4-4.4 4s-4-1.4-4-3.6z" fill="#1e2228" stroke="#18181c" stroke-width="1.4"/><path d="M4 10.8l2.6 0" stroke="#7f8a99" stroke-width=".8"/>');
SVG.monocle = GLS('<path d="M15.6 15.4c-1 3-3.8 4.6-6.6 5.2" fill="none" stroke="#c8a046" stroke-width=".9" stroke-dasharray="1 .8"/>', '<circle cx="14" cy="10" r="5.2" fill="#dbe9f5" fill-opacity=".45" stroke="#c8a046" stroke-width="1.4"/>');
SVG.brassgoggles = GLS('<path d="M10.6 12.6h2.8" stroke="#c8a046" stroke-width="1.4"/>', '<circle cx="6.6" cy="12.6" r="4.2" fill="#e6aa50" fill-opacity=".7" stroke="#c8a046" stroke-width="1.8"/><circle cx="17.4" cy="12.6" r="4.2" fill="#e6aa50" fill-opacity=".7" stroke="#c8a046" stroke-width="1.8"/>', '<path d="M1 11.4h3M20 11.4h3" stroke="#70482a" stroke-width="2.6"/>');
SVG.divinggoggles = GLS('', '<rect x="3.2" y="8.4" width="17.6" height="8" rx="3.6" fill="#78c8c8" fill-opacity=".6" stroke="#28241f" stroke-width="1.8"/>', '<path d="M1 12.4h3M20 12.4h3" stroke="#28241f" stroke-width="2.4"/>');
SVG.snowgoggles = GLS('<path d="M5 12h4.2M14.8 12H19" stroke="#2a221a" stroke-width="1.2" stroke-linecap="round"/>', '', '<path d="M1 12h2.6M20.4 12H23" stroke="#43291a" stroke-width="1"/><path d="M3 9.6c6-1.6 12-1.6 18 0v4.6c-6 1.6-12 1.6-18 0z" fill="#e2d6ba" stroke="#9c8f74" stroke-width=".9"/>');
// ⭐⭐ MANY STYLES (2026-11-15, the user's picks off `scratchpad/look/gear/eyes_styles/options.html`: everything but the hoods, re-rendered first). Drawn by client 16zf
//   `WORN_LOOK` (a colour or tier VARIANT is its base piece's name + '~variant', recoloured); skirts and capes by 16zg. `tier: 1` = tier 2 (better made: client 16zi
//   `gearProtOf` +15% protection, 30% slower wear). `mat: 'mail'` a new material (16zi's dials). `deco: 1` protects nothing and stops no blade (the circlet).
const RC = (svg, map) => { let o = svg; for (const [a, b] of Object.entries(map)) o = o.split(a).join(b); return o; };
const SV = (inner) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' + inner + '</svg>';
const LEA = 'fill="#70482a" stroke="#43291a" stroke-width=".8"', POL = 'fill="#dfe5ee" stroke="#8a6a2a" stroke-width=".8"';
const DYE = { red: ['#a3302f', '#641d1d'], green: ['#41703c', '#274524'], white: ['#e6e1d6', '#9c988e'], black: ['#2a2a30', '#111114'], brown: ['#7a5638', '#4f3824'], purple: ['#603480', '#3a1e50'], blue: ['#2f3f8f', '#1a2458'] };
SVG.leathercap = SV('<path d="M4 17c0-6 3.6-11 8-11s8 5 8 11v1.6H4z" ' + LEA + '/><path d="M12 6.2v11.6M4.4 15.6h15.2" stroke="#43291a" stroke-width=".9" fill="none"/>');
SVG.kettlehat = SV('<path d="M6.4 13.6c0-4.4 2.5-7.6 5.6-7.6s5.6 3.2 5.6 7.6z" fill="#b8c0cc" stroke="#5b6472" stroke-width=".8"/><path d="M1.6 15.4c2.8-2 17.6-2 20.8 0-3.4 2-17.6 2-20.8 0z" fill="#9aa3b0" stroke="#5b6472" stroke-width=".8"/><path d="M12 6.2v7.2" stroke="#e8ecf2" stroke-width=".8"/>');
SVG.strawhat = SV('<path d="M7 13.4c0-4 2.2-6.8 5-6.8s5 2.8 5 6.8z" fill="#d6b86c" stroke="#8f7436" stroke-width=".8"/><path d="M1 15.2c3-2.2 19-2.2 22 0-3.4 2.2-18.6 2.2-22 0z" fill="#d6b86c" stroke="#8f7436" stroke-width=".8"/><path d="M7.2 12.4c3 .8 6.6.8 9.6 0" stroke="#a3302f" stroke-width="1.4" fill="none"/>');
SVG.goldcirclet = SV('<ellipse cx="12" cy="13" rx="9" ry="3.6" fill="none" stroke="#d6ab45" stroke-width="1.8"/><path d="M12 7.6l1.6 2.6-1.6 2.2-1.6-2.2z" fill="#b41e32" stroke="#d6ab45" stroke-width=".7"/>');
SVG.steelhelmet = RC(SVG.ironhelmet, { '#b8c0cc': '#dfe5ee', '#5b6472': '#8a6a2a', '#8f98a5': '#c8a046' }).replace('</svg>', '<path d="M12 6c2-3.4 5-4 7-3.2-2.6.4-4.6 1.8-5.6 4.2" fill="#b02c34" stroke="#701c22" stroke-width=".6"/></svg>');
SVG.leatherjerkin = SV('<path d="M8.6 3.6c.8 1.8 2 2.6 3.4 2.6s2.6-.8 3.4-2.6l4.4 2.6-1.6 4.4-1.8-.6V20.4H7.6V10l-1.8.6-1.6-4.4z" ' + LEA + '/><path d="M11 7.4l2 1.4M13 7.4l-2 1.4M11 9.4l2 1.4M13 9.4l-2 1.4" stroke="#43291a" stroke-width=".7"/><path d="M7.6 15.4h8.8" stroke="#43291a" stroke-width="1.4"/><rect x="11" y="14.6" width="2" height="1.6" fill="#c8a046"/>');
SVG.studdedleather = SVG.leatherjerkin.replace('</svg>', [[9, 12], [15, 12], [9, 18], [15, 18], [12, 18.6], [9.4, 9], [14.6, 9]].map(([x, y]) => '<circle cx="' + x + '" cy="' + y + '" r=".75" fill="#d9dee6"/>').join('') + '</svg>');
SVG.paddedgambeson = SV('<path d="M8.4 3.4c.8 1.8 2.2 2.6 3.6 2.6s2.8-.8 3.6-2.6l4.4 2.6-1.6 4.4-1.8-.6V20.6H7.4V10l-1.8.6-1.6-4.4z" fill="#c8b894" stroke="#7c6c4c" stroke-width=".8"/><path d="M9.4 7.6v13M12 7v13.6M14.6 7.6v13" stroke="#97845f" stroke-width=".8"/><path d="M8.6 3.6c1 2.2 2.2 3 3.4 3s2.4-.8 3.4-3" stroke="#97845f" stroke-width="1.4" fill="none"/>');
SVG.mailshirt = SV('<path d="M8.6 3.6c.8 1.8 2 2.6 3.4 2.6s2.6-.8 3.4-2.6l4.4 2.6-1.6 4.4-1.8-.6V20.4H7.6V10l-1.8.6-1.6-4.4z" fill="#959ba6" stroke="#4d525a" stroke-width=".8"/>' + [8, 10.4, 12.8, 15.2, 17.6].map((y, j) => [8.6, 10.6, 12.6, 14.6].map(x => '<circle cx="' + (x + (j % 2) * 1) + '" cy="' + y + '" r=".75" fill="none" stroke="#d2d7de" stroke-width=".45"/>').join('')).join(''));
SVG.steelbreastplate = RC(SVG.ironbreastplate, { '#b8c0cc': '#dfe5ee', '#5b6472': '#8a6a2a', '#8f98a5': '#c8a046' });
const shirtOf = (c) => RC(SVG.linenshirt, { '#c9b48a': DYE[c][0], '#6f5c3c': DYE[c][1] }), tunicOf = (c) => RC(SVG.linentunic, { '#c9b48a': DYE[c][0], '#6f5c3c': DYE[c][1], '#8f7a55': DYE[c][1] });
const robeOf = (c) => RC(SVG.blueroberobe, { '#2f3f8f': DYE[c][0] }), hatOf = (c) => RC(SVG.wizardhat, { '#2f3f8f': DYE[c][0], '#1a2458': DYE[c][1] }), capeOf = (c) => RC(SVG.clothcape, { '#8a2a2a': DYE[c][0], '#4a1414': DYE[c][1], '#6e1f1f': DYE[c][1] });
const glovesOf = (f, st) => RC(SVG.irongauntlets, { '#b8c0cc': f, '#5b6472': st, '#8f98a5': st });
SVG.leathergloves = glovesOf('#6b4528', '#3f2817'); SVG.woolgloves = glovesOf('#ddd4c2', '#9c9282'); SVG.steelgauntlets = glovesOf('#dfe5ee', '#8a6a2a');
SVG.leatherboots = RC(SVG.ironboots, { '#b8c0cc': '#70482a', '#5b6472': '#43291a' });
SVG.furboots = RC(SVG.ironboots, { '#b8c0cc': '#7a5638', '#5b6472': '#4f3824' }).replace('</svg>', '<rect x="6" y="2.4" width="8.4" height="3.6" rx="1.6" fill="#d8d0bf" stroke="#9c9282" stroke-width=".6"/></svg>');
SVG.slippers = RC(SVG.leathershoes, { '#6b4528': '#a3302f', '#3f2817': '#641d1d', '#2c2119': '#d6ab45' });
SVG.steelboots = RC(SVG.ironboots, { '#b8c0cc': '#dfe5ee', '#5b6472': '#8a6a2a' });
SVG.shortmantle = SV('<path d="M5 6.6C7 4.2 9.4 3.4 12 3.4s5 .8 7 3.2l1.4 7.4c-2.6 1.4-5.4 2-8.4 2s-5.8-.6-8.4-2z" fill="#8a2a2a" stroke="#4a1414" stroke-width=".8"/><path d="M8 4.4c1 1.2 2.4 1.8 4 1.8s3-.6 4-1.8" fill="none" stroke="#d4a537" stroke-width="1.2"/>');
SVG.furcloak = RC(SVG.clothcape, { '#8a2a2a': '#4f3824', '#4a1414': '#2e2015', '#6e1f1f': '#3c2a1b', '#d4a537': '#d8d0bf' }).replace('stroke-width="1.3"', 'stroke-width="2.6"');
const W_ = (slot, mat, wt, tier, name, svg, prima, extra) => Object.assign({ name, kind: 'worn', slot, mat, wt, tier, svg, make: { mats: [], prima } }, extra || {});
Object.assign(ITEMS, {
  leather_cap: W_('head', 'leather', 1, 0, 'Leather cap', SVG.leathercap, 25),
  kettle_hat: W_('head', 'plate', 3, 0, 'Kettle hat', SVG.kettlehat, 50),
  straw_hat: W_('head', 'linen', 0.3, 0, 'Straw hat', SVG.strawhat, 10),
  gold_circlet: W_('head', 'plate', 0.2, 0, 'Gold circlet', SVG.goldcirclet, 120, { deco: 1 }),
  steel_helmet: W_('head', 'plate', 4, 1, 'Steel helmet', SVG.steelhelmet, 110, { bars: ['eyes'] }),
  red_wizard_hat: W_('head', 'linen', 0.5, 0, 'Red wizard hat', hatOf('red'), 30),
  black_wizard_hat: W_('head', 'linen', 0.5, 0, 'Black wizard hat', hatOf('black'), 30),
  leather_jerkin: W_('body', 'leather', 4, 0, 'Leather jerkin', SVG.leatherjerkin, 60),
  studded_leather: W_('body', 'leather', 5, 1, 'Studded leather', SVG.studdedleather, 95),
  padded_gambeson: W_('body', 'padded', 4, 0, 'Padded gambeson', SVG.paddedgambeson, 60),
  mail_shirt: W_('body', 'mail', 8, 0, 'Mail shirt', SVG.mailshirt, 100),
  steel_breastplate: W_('body', 'plate', 10, 1, 'Steel breastplate', SVG.steelbreastplate, 200),
  red_shirt: W_('body', 'linen', 0.5, 0, 'Red shirt', shirtOf('red'), 20), green_shirt: W_('body', 'linen', 0.5, 0, 'Green shirt', shirtOf('green'), 20),
  white_shirt: W_('body', 'linen', 0.5, 0, 'White shirt', shirtOf('white'), 20), black_shirt: W_('body', 'linen', 0.5, 0, 'Black shirt', shirtOf('black'), 20),
  green_tunic: W_('body', 'linen', 1, 0, 'Green tunic', tunicOf('green'), 25), brown_tunic: W_('body', 'linen', 1, 0, 'Brown tunic', tunicOf('brown'), 25), red_tunic: W_('body', 'linen', 1, 0, 'Red tunic', tunicOf('red'), 25),
  red_robe: W_('body', 'linen', 2, 0, 'Red robe', robeOf('red'), 40), white_robe: W_('body', 'linen', 2, 0, 'White robe', robeOf('white'), 40),
  black_robe: W_('body', 'linen', 2, 0, 'Black robe', robeOf('black'), 40), purple_robe: W_('body', 'linen', 2, 0, 'Purple robe', robeOf('purple'), 40),
  leather_gloves: W_('hands', 'leather', 0.5, 0, 'Leather gloves', SVG.leathergloves, 15), wool_gloves: W_('hands', 'linen', 0.3, 0, 'Wool gloves', SVG.woolgloves, 10),
  steel_gauntlets: W_('hands', 'plate', 2, 1, 'Steel gauntlets', SVG.steelgauntlets, 90),
  leather_boots: W_('feet', 'leather', 1.5, 0, 'Leather boots', SVG.leatherboots, 25), fur_boots: W_('feet', 'padded', 1.5, 0, 'Fur boots', SVG.furboots, 30),
  slippers: W_('feet', 'linen', 0.3, 0, 'Slippers', SVG.slippers, 10), steel_boots: W_('feet', 'plate', 3, 1, 'Steel boots', SVG.steelboots, 90),
  green_cape: W_('back', 'linen', 1, 0, 'Green cape', capeOf('green'), 40), blue_cape: W_('back', 'linen', 1, 0, 'Blue cape', capeOf('blue'), 40),
  black_cape: W_('back', 'linen', 1, 0, 'Black cape', capeOf('black'), 40), white_cape: W_('back', 'linen', 1, 0, 'White cape', capeOf('white'), 40),
  short_mantle: W_('back', 'linen', 0.6, 0, 'Short mantle', SVG.shortmantle, 30), fur_cloak: W_('back', 'padded', 2.5, 0, 'Fur cloak', SVG.furcloak, 70),
});
const EYEWEAR = { mat: 'glass', kind: 'worn', slot: 'eyes', tier: 0 };
const GOGGLE_PROT = { cut: 40, pierce: 30, blunt: 25 };   // (goggles: thick glass in a cup, as leather)
ITEMS.round_spectacles = Object.assign({ name: 'Round spectacles', wt: 0.05, eyes: [-1, 1], svg: SVG.roundspectacles, make: { mats: [], prima: 15 } }, EYEWEAR);
ITEMS.square_glasses = Object.assign({ name: 'Square glasses', wt: 0.1, eyes: [-1, 1], svg: SVG.squareglasses, make: { mats: [], prima: 15 } }, EYEWEAR);
ITEMS.sunglasses = Object.assign({ name: 'Sunglasses', wt: 0.1, eyes: [-1, 1], svg: SVG.sunglasses, make: { mats: [], prima: 20 } }, EYEWEAR);
ITEMS.monocle = Object.assign({ name: 'Monocle', wt: 0.05, eyes: [1], svg: SVG.monocle, make: { mats: [], prima: 25 } }, EYEWEAR);
ITEMS.brass_goggles = Object.assign({ name: 'Brass goggles', wt: 0.4, eyes: [-1, 1], prot: GOGGLE_PROT, svg: SVG.brassgoggles, make: { mats: [], prima: 30 } }, EYEWEAR);
ITEMS.diving_goggles = Object.assign({ name: 'Diving goggles', wt: 0.4, eyes: [-1, 1], prot: GOGGLE_PROT, svg: SVG.divinggoggles, make: { mats: [], prima: 30 } }, EYEWEAR);
ITEMS.snow_goggles = Object.assign({ name: 'Snow goggles', wt: 0.2, eyes: [-1, 1], prot: GOGGLE_PROT, svg: SVG.snowgoggles, make: { mats: [], prima: 20 } }, EYEWEAR);

const isItem = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(ITEMS, id);

// The wire shape of the table: [[id, { name, kind, tier, svg }], …]. Sent once per socket.
function itemDefsWire() {
  return Object.keys(ITEMS).map(id => [id, { name: ITEMS[id].name, kind: ITEMS[id].kind, tier: ITEMS[id].tier | 0, svg: ITEMS[id].svg,
    make: ITEMS[id].make || null, obj: ITEMS[id].obj || null, pair: ITEMS[id].pair || null, stack: ITEMS[id].stack ? 1 : 0, slot: ITEMS[id].slot || null, mat: ITEMS[id].mat || null, wt: ITEMS[id].wt || 0,
    bars: ITEMS[id].bars || null, eyes: ITEMS[id].eyes || null, prot: ITEMS[id].prot || null, deco: ITEMS[id].deco ? 1 : 0 }]);
}
// (worn gear, 2026-11-13 — client 16zi) `mat`: what a piece is made of ('plate' | 'mail' | 'leather' | 'padded' | 'linen' | 'glass' — what it stops is the client's dials,
//   Avatar › 'Worn gear: what it does'); `wt`: its weight (only what you WEAR counts: the full iron set ≈ 19)
// (worn gear) the slot an item is worn in, or null
// (worn gear, 2026-11-15) the slots an item keeps empty while it is worn (the iron helmet: no eyewear) — [] for most
const wornBars = (id) => (isItem(id) && Array.isArray(ITEMS[id].bars) ? ITEMS[id].bars : []);
const wornSlotOf = (id) => isItem(id) && ITEMS[id].kind === 'worn' && WORN_SLOTS.includes(ITEMS[id].slot) ? ITEMS[id].slot : null;
// is this item a real object out of the pouch (never a pile, never a stack)?
const isObjItem = (id) => isItem(id) && !!ITEMS[id].obj;
// …and one that never stacks: a torch, a sword — dropped or scattered it lies as ITSELF, one object each. A throwable (`stack`) goes into a pile.
const isLoneItem = (id) => isObjItem(id) && !ITEMS[id].stack;

module.exports = { ITEMS, isItem, isObjItem, isLoneItem, itemDefsWire, WORN_SLOTS, wornSlotOf, wornBars };
