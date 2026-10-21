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
for (const [id, name, look, svg, prima] of [['molotov', 'Molotov', 'molotov', SVG.molotov, 12], ['grease_flask', 'Grease flask', 'greaseflask', SVG.grease, 8]])
  ITEMS[id] = { name, kind: 'throwable', tier: 0, svg, obj: HELD.objOf(look), stack: true, make: { mats: [], prima } };
for (const [id, name, look, svg, prima] of [['pressure_bomb', 'Pressure bomb', 'canister', SVG.pressure, 14], ['flash_bang', 'Flash-bang', 'flashbang', SVG.flash, 10]])
  ITEMS[id] = { name, kind: 'throwable', tier: 0, svg, obj: Object.assign(HELD.objOf(look), { boom: HELD.LOOKS[look].boom }), stack: true, make: { mats: [], prima } };

const isItem = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(ITEMS, id);

// The wire shape of the table: [[id, { name, kind, tier, svg }], …]. Sent once per socket.
function itemDefsWire() {
  return Object.keys(ITEMS).map(id => [id, { name: ITEMS[id].name, kind: ITEMS[id].kind, tier: ITEMS[id].tier | 0, svg: ITEMS[id].svg,
    make: ITEMS[id].make || null, obj: ITEMS[id].obj || null, stack: ITEMS[id].stack ? 1 : 0 }]);
}
// is this item a real object out of the pouch (never a pile, never a stack)?
const isObjItem = (id) => isItem(id) && !!ITEMS[id].obj;
// …and one that never stacks: a torch, a sword — dropped or scattered it lies as ITSELF, one object each. A throwable (`stack`) goes into a pile.
const isLoneItem = (id) => isObjItem(id) && !ITEMS[id].stack;

module.exports = { ITEMS, isItem, isObjItem, isLoneItem, itemDefsWire };
