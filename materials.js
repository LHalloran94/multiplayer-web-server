// ==============================================================================================================
//  materials.js — THE GENERATOR'S MATERIALS, ids 18..89. Phase 6 world-redesign port, increment 1.
//
//  This exact file runs in TWO places, the same way `avatar-sim.js` does:
//    • server/index.js requires it            (strength, powder/plant behaviour, the reaction table's reagents)
//    • the extension bundle inlines it        (build.js prepends it → `self.MWMats`; the client's TERRAIN_MATS
//                                              is extended from it, so colour and behaviour cannot drift)
//  ⚠️ ONE TABLE, TWO READERS. The thing this file exists to prevent is the failure the world spike hit nine
//  times over: two lists that both know a material's colour/behaviour and disagree. Nothing here may be
//  re-declared on either side — extend the readers from `DEFS`, never copy rows out of it.
//
//  ── WHERE THE NUMBERS COME FROM ────────────────────────────────────────────────────────────────────────────
//  `scratchpad/worldspike/cells.js` (the palette: name + colour) and `scratchpad/worldspike/materials.js`
//  (behaviour + strength), transcribed mechanically rather than by hand. 88 spike materials; 12 already had a
//  game id, 4 more were folded into an existing id (see NAME_TO_ID), leaving these 72.
//
//  ── THE FOUR LIQUIDS THAT ARE NOT HERE, AND WHY (decided 2026-08-09) ───────────────────────────────────────
//  🟥 The spike's ten liquids deliberately SHARE the game's six density ranks, on the grounds that liquids
//  which cannot coexist in a cell can share a slot. That reasoning assumed the slot carries an identity. It
//  does not: `LIQ_ID[rank]` is how BOTH the colour and the "does this kill me" answer are recovered, and the
//  fluid id in the terrain grid is never drawn for a plain fluid. So a liquid sharing a rank IS the liquid it
//  shares with — not similar to it, identical. `tar` sat in acid's rank, which would have made every generated
//  tar seep lethal bright-green acid.
//  ⇒ tar → oil · hotspring → water · slurry → quicksand · lavathick → lava. No new ranks, no new fluid ids,
//  `LIQ_T` stays 6. The three besides tar are honest folds (a hot spring IS water). Recorded in NAME_TO_ID so
//  the generator port cannot silently re-introduce them.
//  ⏭️ Open, deferred: the game's `Oil` (15) is COOKING oil — yellow, coats you slick — and now carries crude
//  and tar as well. It wants to become black crude, which is a colour change to an EXISTING material and so
//  touches level-creator content; not this increment.
//
//  ── THE TWO MATERIALS WITH NO SYSTEM BEHIND THEM (user's call 2026-08-09) ────────────────────────────────────
//  `coal`/`oilshale`/`sulphur`/`peat` are flammable and there is no fire; `uranium` wants damage-over-time and
//  there is no such thing. They ship as ordinary diggable rock wearing flags the game ALREADY has and that cost
//  nothing — `soft` (peat: spongy) and `dusty` (coal/oil shale/sulphur/scree/ash: kick up dust underfoot).
//  Nothing here fakes a system. Fire and radiation stay unbuilt and stay written down.
// ==============================================================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root || (typeof self !== 'undefined' ? self : globalThis)).MWMats = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // Ids 18..89. The built-ins 1..17 are NOT here — they are the level creator's palette and predate this file.
  // ⚠️ THE ORDER IS THE ID. Never insert; append, and move GEN_MAT_MAX/CUSTOM_MAT_MIN with it.
  // row = [name, fill, behaviour, strength(hits), flag?]
  const ROWS = [
    ['Turf', '#4f7a35', 'solid', 1], // 18 turf
    ['Clay', '#8a6b52', 'solid', 2], // 19 clay
    ['Peat', '#3d3226', 'solid', 1, 'soft'], // 20 peat
    ['Scree', '#8d8b86', 'powder', 1, 'dusty'], // 21 scree
    ['Granite', '#a89a92', 'solid', 4], // 22 granite
    ['Basalt', '#41434c', 'solid', 4], // 23 basalt
    ['Limestone', '#cfc7a8', 'solid', 3], // 24 limestone
    ['Sandstone', '#c8a86a', 'solid', 3], // 25 sandstone
    ['Shale', '#6a6a5c', 'solid', 2], // 26 shale
    ['Salt', '#e8e4d6', 'solid', 2], // 27 salt
    ['Wood', '#5a4028', 'plant', 2], // 28 wood
    ['Leaves', '#3f7a3a', 'plant', 1], // 29 leaves
    ['Scrub', '#7d7a45', 'plant', 1], // 30 scrub
    ['Cactus', '#4f7f52', 'plant', 1], // 31 cactus
    ['Moss', '#6f8f4f', 'plant', 1], // 32 moss
    ['Oil shale', '#3a3a42', 'solid', 2, 'dusty'], // 33 oilshale
    ['Iron', '#8a6a5a', 'solid', 4], // 34 iron
    ['Copper', '#4f8f7a', 'solid', 3], // 35 copper
    ['Crystal', '#9fd8e8', 'solid', 3], // 36 crystal
    ['Permafrost', '#93a9b4', 'solid', 3], // 37 permafrost
    ['Ash', '#6d6a66', 'powder', 1, 'dusty'], // 38 ash
    ['Gravel', '#9a9288', 'solid', 1], // 39 gravel
    ['Driftwood', '#7a6a52', 'solid', 2], // 40 driftwood
    ['Coal', '#26242a', 'solid', 2, 'dusty'], // 41 coal
    ['Quartz', '#d8d4e4', 'solid', 4], // 42 quartz
    ['Obsidian', '#1a1820', 'solid', 3], // 43 obsidian
    ['Tufa', '#ddd6bd', 'solid', 2], // 44 tufa
    ['Pumice', '#b5aca0', 'solid', 1], // 45 pumice
    ['Needle', '#2f5d3a', 'plant', 1], // 46 needle
    ['Frond', '#5f9e46', 'plant', 1], // 47 frond
    ['Reed', '#8a9a4a', 'plant', 1], // 48 reed
    ['Kelp', '#2f5a4a', 'plant', 1], // 49 kelp
    ['Fungus', '#c0a6d0', 'plant', 1], // 50 fungus
    ['Gold', '#e8c34a', 'solid', 3], // 51 gold
    ['Silver', '#cfd6da', 'solid', 3], // 52 silver
    ['Galena', '#5a5f6b', 'solid', 3], // 53 galena
    ['Tin', '#9aa7ad', 'solid', 3], // 54 tin
    ['Pyrite', '#c9a33a', 'solid', 4], // 55 pyrite
    ['Hematite', '#8a3b30', 'solid', 4], // 56 hematite
    ['Malachite', '#2f8f6a', 'solid', 3], // 57 malachite
    ['Cinnabar', '#b03a3a', 'solid', 2], // 58 cinnabar
    ['Sulphur', '#e0d24a', 'solid', 1, 'dusty'], // 59 sulphur
    ['Amethyst', '#8f6fc0', 'solid', 4], // 60 amethyst
    ['Emerald', '#2fa06a', 'solid', 5], // 61 emerald
    ['Diamond', '#d8f0f7', 'solid', 6], // 62 diamond
    ['Opal', '#dcc9e0', 'solid', 3], // 63 opal
    ['Bauxite', '#b5714a', 'solid', 2], // 64 bauxite
    ['Ruby', '#c02040', 'solid', 5], // 65 ruby
    ['Sapphire', '#3a6fd0', 'solid', 5], // 66 sapphire
    ['Jade', '#3f9b76', 'solid', 4], // 67 jade
    ['Turquoise', '#3fc0c8', 'solid', 2], // 68 turquoise
    ['Topaz', '#f0c040', 'solid', 4], // 69 topaz
    ['Garnet', '#8f2b3a', 'solid', 4], // 70 garnet
    ['Lapis', '#2a3a8c', 'solid', 3], // 71 lapis
    ['Agate', '#c88f6a', 'solid', 4], // 72 agate
    ['Platinum', '#e8eef2', 'solid', 3], // 73 platinum
    ['Uranium', '#7ad14a', 'solid', 3], // 74 uranium
    ['Amber', '#d2761e', 'solid', 1], // 75 amber
    ['Flint', '#3a3f44', 'solid', 4], // 76 flint
    ['Marble', '#efeae2', 'solid', 3], // 77 marble
    ['Coral', '#e0836f', 'solid', 2], // 78 coral
    ['Slate', '#33414f', 'solid', 3], // 79 slate
    ['Quartzite', '#e2d8cc', 'solid', 5], // 80 quartzite
    ['Gneiss', '#9a7f80', 'solid', 4], // 81 gneiss
    ['Lichen', '#9fae86', 'plant', 1], // 82 lichen
    ['Vine', '#4c8a3e', 'plant', 1, 'hangs'], // 83 vine
    ['Meteorite', '#6b5f66', 'solid', 5], // 84 meteorite
    ['Gypsum', '#efe6f2', 'solid', 1], // 85 gypsum
    ['Fluorite', '#7ad0b0', 'solid', 3], // 86 fluorite
    ['Realgar', '#e0522c', 'solid', 1], // 87 realgar
    ['Orpiment', '#f2c024', 'solid', 1], // 88 orpiment
    ['Conglomerate', '#a89273', 'solid', 3], // 89 conglomerate
  ];

  const GEN_MAT_MIN = 18;
  const GEN_MAT_MAX = GEN_MAT_MIN + ROWS.length - 1;   // 89

  // ---- colour derivation ---------------------------------------------------------------------------------
  // ⭐ THE CAP, THE SHADE AND THE DEBRIS HUE ARE DERIVED, NOT LISTED. Seventy-two hand-written colour triples
  // is seventy-two chances to transcribe one wrong, and the material-DESIGN pass (the 12 look-alike pairs that
  // actually touch) will overwrite them anyway. Every material gets a coherent lit top and a matching dust for
  // free, and a designed override later is one row, not a new mechanism.
  const hx = (h) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128]; };
  const to = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const lighten = (h, f) => { const [r, g, b] = hx(h); return to(r + (255 - r) * f, g + (255 - g) * f, b + (255 - b) * f); };
  const darken = (h, f) => { const [r, g, b] = hx(h); return to(r * (1 - f), g * (1 - f), b * (1 - f)); };
  function hueSat(h) {                                   // → [hue 0..360, sat 0..100] for the carve/effect dust
    const [r, g, b] = hx(h).map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hue = 0;
    if (d > 1e-6) {
      if (mx === r) hue = ((g - b) / d) % 6; else if (mx === g) hue = (b - r) / d + 2; else hue = (r - g) / d + 4;
      hue *= 60; if (hue < 0) hue += 360;
    }
    const l = (mx + mn) / 2, sat = d < 1e-6 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return [Math.round(hue), Math.round(Math.min(1, sat) * 100)];
  }

  // ---- the defs, sparse by id ---------------------------------------------------------------------------
  // Shape matches the client's built-in TERRAIN_MATS rows exactly, so `TERRAIN_MATS[id] = DEFS[id]` is the
  // whole of the client-side install and every existing `TERRAIN_MATS[v].fill` lookup keeps working.
  const DEFS = [];
  const NAMES = {};                                       // display name → id
  const POWDER_IDS = [], PLANT_IDS = [], HANGS_IDS = [], STRENGTH = {};
  ROWS.forEach(([name, fill, behavior, strength, flag], k) => {
    const id = GEN_MAT_MIN + k;
    const def = {
      name, behavior, fill, cap: lighten(fill, 0.24), capShade: darken(fill, 0.20),
      debris: hueSat(fill), strength, gen: 1,
      hint: behavior === 'plant' ? 'Plant growth — falls if what holds it up is cut away.'
        : behavior === 'powder' ? 'Loose ' + name.toLowerCase() + ' — falls and piles up.'
          : name + ' — ' + (strength >= 5 ? 'very hard to dig.' : strength >= 3 ? 'takes a few hits to dig.' : 'digs easily.'),
    };
    if (flag === 'soft') def.soft = 1;
    if (flag === 'dusty') def.dusty = 1;
    // 🟥 A VINE IS HELD UP FROM ABOVE, and the powder rule tests the cell BELOW. Without this bit a vine has
    // air under it by definition and destroys itself on the first tick it is woken. Recorded by the spike as
    // untestable there (nothing in the spike runs a sim); the server's powder pass reads it.
    if (flag === 'hangs') { def.hangs = 1; HANGS_IDS.push(id); }
    DEFS[id] = def;
    NAMES[name] = id;
    STRENGTH[id] = strength;
    if (behavior === 'powder') POWDER_IDS.push(id);
    if (behavior === 'plant') PLANT_IDS.push(id);
  });

  // ---- the spike's name → this game's id ------------------------------------------------------------------
  // ⭐ THE PORT'S ONE LOOKUP. The generator (increment 4) emits spike names; this is the only place that turns
  // one into a number, so an unmapped name is a loud failure here rather than `undefined` stored into a
  // Uint8Array as 0 = AIR — which is exactly how OIL/GLASS/ACID silently vanished from the shipped generator
  // twice. `idOf` throws; nothing may fall back to 0.
  const ALIAS = {
    // the 12 that already existed
    loam: 1, stone: 2, sand: 3, ice: 4, mud: 5, snow: 8, water: 9, quicksand: 10, lava: 11, acid: 12, brine: 14, oil: 15,
    // the 4 folded in, because a shared density rank IS a shared identity (see the header)
    tar: 15, hotspring: 9, slurry: 10, lavathick: 11,
  };
  const NAME_TO_ID = Object.assign({}, ALIAS);
  const SPIKE_KEY = ROWS.map(([name]) => name.toLowerCase().replace(/\s+/g, ''));   // 'Oil shale' → 'oilshale'
  SPIKE_KEY.forEach((k, i) => { NAME_TO_ID[k] = GEN_MAT_MIN + i; });
  function idOf(name) {
    const v = NAME_TO_ID[name];
    if (v === undefined) throw new Error('materials.js: no game id for spike material "' + name + '"');
    return v;
  }

  return {
    ROWS, DEFS, NAMES, NAME_TO_ID, idOf, STRENGTH,
    GEN_MAT_MIN, GEN_MAT_MAX,
    POWDER_IDS, PLANT_IDS, HANGS_IDS,
    COUNT: ROWS.length,
  };
});
