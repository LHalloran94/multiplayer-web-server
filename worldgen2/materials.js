'use strict';
// ==============================================================================================================
//  worldspike/materials.js — BEHAVIOUR AND STRENGTH FOR EVERY MATERIAL. The material batch's deliverable.
//
//  The palette in `cells.js` is a NAME and a COLOUR, which is all cell synthesis needs. This is everything the
//  GAME needs in order to accept one: what it does, and how hard it is to dig.
//
//  ⚠️ THE COLOUR STAYS IN cells.js AND IS NOT REPEATED HERE. Two tables that both know a material's colour is
//  mistake #2 on this track (two rules disagreeing about what a number means, four instances, all costly). This
//  file is keyed by NAME and `checkAgainst()` fails if the two lists are not the same set.
//
//  ── BEHAVIOUR ────────────────────────────────────────────────────────────────────────────────────────────────
//    solid    blocks movement, stands there.  The default.
//    powder   solid, but FALLS and piles at the angle of repose. The game already has this (server `isPowderId`,
//             hard-coded to sand and snow) — porting means it becomes a table lookup instead of `v===3||v===8`.
//    fluid    flows and levels. The liquid sim.
//    hazard   a fluid that kills on contact (lava, acid).
//    plant    ⭐ USER'S DECISION: an unsupported plant cell FALLS AS A POWDER. Cut a trunk and the canopy comes
//             down as a heap rather than vanishing. Movement is the powder CA unchanged — no new movement rule.
//
//  🟥 BUT A PLANT CANNOT USE THE POWDER **WAKE** RULE, AND THAT IS THE WHOLE DIFFICULTY. A canopy OVERHANGS —
//  that is what a canopy is — so plant cells with air underneath are not a defect to be tuned away, they are the
//  shape. Measured (`probe_materials.js`): 6.1% of all falling cells in the world have no support, and for
//  `frond` — a palm crown, which is nothing but overhang — it is 81.6%. If the generator woke plant cells the
//  way it wakes sand, every forest in the world would shed itself on the first tick.
//  ⇒ the powder ACTIVE SET is the seam, and the game already has it. `reseedChunkPowder` wakes generated grains
//  that can move; plant cells are simply never reseeded. They enter the active set only when a neighbouring cell
//  is EDITED — which is exactly the case the user asked for, someone cutting the trunk — and then fall and sleep
//  by the ordinary rule. Same movement, different wake. Nothing else in the sim has to know.
//  ⚠️ This is why `plant` stays a separate behaviour from `powder` even though they move identically.
//
//  ── STRENGTH ─────────────────────────────────────────────────────────────────────────────────────────────────
//  Hits to break, matching the game's existing scale exactly: absent/1 = one hit, up to 9, and 0 = unbreakable.
//  Today the game uses 1 (earth, sand, snow), 2 (ice, mud, drain), 3 (stone) and nothing above.
//  ⚠️ A ROCK NUMBER IS A DIG-TIME NUMBER. 22% of the world is shale and 14% is granite, so the value chosen for
//  bedrock decides how long it takes to tunnel anywhere. This table weighs in at 2.98 mean hits per cell.
//  ⚠️ AND THE COMPARISON HAS TO BE MEASURED, NOT READ OFF THE TABLE. "The shipped game is about 1.0, because
//  earth is 1 and stone is 3" is what I wrote first and it was wrong: what matters is which materials the
//  shipped generator EMITS, and it swings from 63% sand (1.20 hits/cell) to 91% stone (2.85) between seeds.
//  2.98 is at the top of the range the game already ships, not three times it.
//
//  ── FLAGS ────────────────────────────────────────────────────────────────────────────────────────────────────
//  `reactive` lists the reactions a material takes part in, in the game's existing vocabulary. Nothing here
//  invents a reaction system; it records which of the 68 join the one that already runs.
// ==============================================================================================================

// b = behaviour · s = strength (hits) · note = why, in one line · game = the id it already has, if any
const TABLE = {
  // ── fluids ───────────────────────────────────────────────────────────────────────────────────────────────────
  // ⭐ EVERY ONE OF THESE IS A POINT IN `liquids.js`'s SITUATION SPACE — density and viscosity live there,
  // because they are what the SIM needs, and nothing here should be a second copy of them.
  water:      { b: 'fluid',  s: 0, game: 9,  react: 'freezes to ice by snow; wets loam to mud, sand to quicksand; dissolves salt to brine' },
  lava:       { b: 'hazard', s: 0, game: 11, react: 'melts snow and ice; bakes mud to loam; fuses sand to glass' },
  brine:      { b: 'fluid',  s: 0, game: 14, note: 'closed basins — DENSER than water, so it sits underneath it' },
  acid:       { b: 'hazard', s: 0, game: 12, note: 'sulphide weathering and crater lakes' },
  oil:        { b: 'fluid',  s: 0, game: 15, note: 'LESS dense than water, so it floats on it — the reason density is tracked' },
  quicksand:  { b: 'fluid',  s: 0, game: 10, note: 'sand with the water table in it' },
  tar:        { b: 'fluid',  s: 0, note: '🟥 NEW GAME FLUID: a cold surface seep; barely flows, so it pools where oil would run' },
  slurry:     { b: 'fluid',  s: 0, note: '🟥 NEW GAME FLUID: mudpots and lahars — the game has mud only as a SOLID' },
  hotspring:  { b: 'fluid',  s: 0, note: '🟥 NEW GAME FLUID: geothermal water, and what DEPOSITS tufa' },
  lavathick:  { b: 'hazard', s: 0, note: '🟥 NEW GAME FLUID: a rhyolitic melt — piles into a dome instead of flowing' },

  // ── powders: they fall and pile ──────────────────────────────────────────────────────────────────────────────
  // ⚠️ DELIBERATELY A SHORT LIST. Every powder cell whose run bottoms out on air will move on first touch, and
  // the game already measured what that costs: 56.5% of all sand in the shipped Overworld sits over air, 17.9%
  // of chunks contain at least one grain that would fall, and a chunk that settles itself stops being
  // throw-away-able (incs 4c/4d). Promoting `gravel` — the subsoil layer under every hillside, 0.39% of the
  // world and present in half of all surface columns — would multiply that by a large factor for no visible gain.
  sand:       { b: 'powder', s: 1, game: 3,  react: 'lava fuses it to glass; water makes quicksand' },
  snow:       { b: 'powder', s: 1, game: 8,  react: 'lava melts it to water; water freezes it to ice' },
  ash:        { b: 'powder', s: 1, note: 'airfall out of a vent — the one new powder; 0.01% of the world, all of it in craters' },

  // ── loose ground ─────────────────────────────────────────────────────────────────────────────────────────────
  loam:       { b: 'solid',  s: 1, game: 1,  react: 'water wets it to mud' },
  turf:       { b: 'solid',  s: 1, note: 'the living skin over loam' },
  peat:       { b: 'solid',  s: 1, note: 'soft, waterlogged; flammable in a world with fire, which this is not' },
  clay:       { b: 'solid',  s: 2, note: 'sticky, like the game\'s mud' },
  mud:        { b: 'solid',  s: 2, game: 5,  react: 'dries back to loam; lava bakes it' },
  gravel:     { b: 'solid',  s: 1, note: 'subsoil and moraine cover — NOT a powder, see the note above' },
  scree:      { b: 'powder', s: 1, note: 'a dusting on steep ground, and the whole body of every talus at a cliff foot' },
  permafrost: { b: 'solid',  s: 3, note: 'ground frozen solid — harder than the loam it is made of' },

  // ── rock ─────────────────────────────────────────────────────────────────────────────────────────────────────
  // ⚠️ `stone` PRODUCING ZERO CELLS IS THE GOOD OUTCOME, not a gap. It is `LITH_MAT`'s fallback — what a column
  // gets when its lithology has no material — so a count of 0 says every lithology in the world is named. It is
  // in the palette because the game already has it as id 2, not because the generator reaches for it.
  stone:      { b: 'solid',  s: 3, game: 2,  fallback: 1, note: 'the LITH_MAT default; 0 cells means the default never fires' },
  shale:      { b: 'solid',  s: 2, note: '22% of the world — the single biggest dig-time term' },
  sandstone:  { b: 'solid',  s: 3 },
  limestone:  { b: 'solid',  s: 3 },
  // ── metamorphic: rock that has been cooked. Harder than what it was made from, which is the point of it. ────
  marble:     { b: 'solid',  s: 3, note: 'cooked limestone' },
  slate:      { b: 'solid',  s: 3, note: 'cooked shale — shale is 21.9% of the world and had no metamorphic form at all' },
  quartzite:  { b: 'solid',  s: 5, note: 'cooked sandstone; one of the hardest rocks there is' },
  gneiss:     { b: 'solid',  s: 4, note: 'cooked granite, from the deepest band' },
  coral:      { b: 'solid',  s: 2, note: 'a reef is GROWN, not dressed — brittle, and the Coral reef landform had none of it' },
  ooze:       { b: 'solid',  s: 1, note: 'abyssal sediment: plankton shells raining down for millions of years. Barely consolidated, hence s:1 — the softest solid in the table, and the reason the abyssal plain is the flattest surface anywhere' },
  granite:    { b: 'solid',  s: 4 },
  basalt:     { b: 'solid',  s: 4 },
  obsidian:   { b: 'solid',  s: 3, note: 'hard but brittle — hard rock strength would misdescribe volcanic glass' },
  pumice:     { b: 'solid',  s: 1, note: 'froth; the lightest rock there is' },
  tufa:       { b: 'solid',  s: 2, note: 'spring-deposited crust' },
  salt:       { b: 'solid',  s: 2, react: '⭐ PROPOSED NEW: water dissolves it to BRINE, which the game already has as a fluid' },
  ice:        { b: 'solid',  s: 2, game: 4,  react: 'lava melts it to water' },
  oilshale:   { b: 'solid',  s: 2, note: '🟥 A ROCK, NOT THE GAME\'S `oil` FLUID — see probe_materials\' alias warning' },
  coal:       { b: 'solid',  s: 2, note: 'flammable in a world with fire, which this is not' },
  flint:      { b: 'solid',  s: 4, note: 'nodules in chalk and limestone' },
  quartz:     { b: 'solid',  s: 4 },
  crystal:    { b: 'solid',  s: 3, note: 'the chamber linings, not a gem' },
  bauxite:    { b: 'solid',  s: 2, note: 'a tropical weathering blanket' },
  sulphur:    { b: 'solid',  s: 1, note: 'Mohs 2 — genuinely soft; crumbles' },

  // ── ores: metal in rock ──────────────────────────────────────────────────────────────────────────────────────
  iron:       { b: 'solid',  s: 4 },
  copper:     { b: 'solid',  s: 3 },
  gold:       { b: 'solid',  s: 3, note: 'soft metal, easy once found — the difficulty is finding it' },
  silver:     { b: 'solid',  s: 3 },
  platinum:   { b: 'solid',  s: 3 },
  tin:        { b: 'solid',  s: 3 },
  galena:     { b: 'solid',  s: 3, note: 'lead ore' },
  hematite:   { b: 'solid',  s: 4, note: 'iron ore' },
  pyrite:     { b: 'solid',  s: 4, note: 'fool\'s gold — the colour clash with gold is the POINT, do not merge' },
  malachite:  { b: 'solid',  s: 3, note: 'copper ore' },
  cinnabar:   { b: 'solid',  s: 2, note: 'mercury ore' },
  uranium:    { b: 'solid',  s: 3, note: 'a hazard behaviour would want damage-over-time, which the game has no notion of; solid for now' },

  meteorite:  { b: 'solid',  s: 5, note: 'nickel-iron from the sky; only at an impact crater, so the LANDFORM is the clue' },
  gypsum:     { b: 'solid',  s: 1, note: 'Mohs 2 — you can scratch it with a fingernail; the biggest crystals on earth are these' },
  fluorite:   { b: 'solid',  s: 3, note: 'hydrothermal gangue — purple and green, and it rides the same veins as the metals' },
  realgar:    { b: 'solid',  s: 1, note: 'scarlet arsenic sulphide, deposited by hot springs' },
  orpiment:   { b: 'solid',  s: 1, note: 'canary-yellow arsenic sulphide; realgar weathers into it' },
  conglomerate:{b: 'solid',  s: 3, note: 'cemented gravel — an old riverbed turned to stone' },

  // ── gems: the reward, so they are the hardest things in the world ────────────────────────────────────────────
  diamond:    { b: 'solid',  s: 6, note: 'the hardest thing there is, and the rarest — 8 pipes in a world' },
  ruby:       { b: 'solid',  s: 5 },
  sapphire:   { b: 'solid',  s: 5 },
  emerald:    { b: 'solid',  s: 5 },
  topaz:      { b: 'solid',  s: 4 },
  garnet:     { b: 'solid',  s: 4 },
  jade:       { b: 'solid',  s: 4, note: 'famously TOUGH rather than hard' },
  agate:      { b: 'solid',  s: 4 },
  amethyst:   { b: 'solid',  s: 4 },
  opal:       { b: 'solid',  s: 3, note: 'soft and full of water' },
  lapis:      { b: 'solid',  s: 3 },
  turquoise:  { b: 'solid',  s: 2, note: 'soft enough to scratch' },
  amber:      { b: 'solid',  s: 1, note: 'fossil resin — barely a mineral' },

  // ── plants: SOLID BUT SUPPORTED. The one new behaviour. ──────────────────────────────────────────────────────
  wood:       { b: 'plant',  s: 2, note: 'the trunk — what everything above it hangs from' },
  leaves:     { b: 'plant',  s: 1 },
  needle:     { b: 'plant',  s: 1, note: 'conifer canopy' },
  frond:      { b: 'plant',  s: 1, note: 'palm and tree-fern canopy' },
  scrub:      { b: 'plant',  s: 1 },
  moss:       { b: 'plant',  s: 1 },
  reed:       { b: 'plant',  s: 1 },
  kelp:       { b: 'plant',  s: 1, note: 'grows UP from the seabed under water' },
  cactus:     { b: 'plant',  s: 1 },
  fungus:     { b: 'plant',  s: 1, note: 'the underworld\'s giant mushrooms — a 3-cell stalk under a 19-cell cap' },
  lichen:     { b: 'plant',  s: 1, note: 'a one-cell rind on bare rock — the only thing that grows above the treeline' },
  // 🟥 A VINE HANGS, AND THAT CONTRADICTS THE PLANT RULE AS CHOSEN. 'an unsupported plant cell falls' tests the
  // cell BELOW; a vine has air below it by definition and would destroy itself on the first tick. The support
  // DIRECTION has to be a property of the material — one bit, `hangs` — and the game's rule has to read it.
  // Recorded here rather than worked around, because the spike cannot test it: nothing here runs a sim.
  vine:       { b: 'plant',  s: 1, hangs: 1, note: 'hangs from a lit ceiling — supported from ABOVE, not below' },
    driftwood:  { b: 'solid',  s: 2, note: 'NOT a plant — it is dead wood LYING on a beach, it is not held up by anything' },
};

const BEHAVIOURS = ['solid', 'powder', 'fluid', 'hazard', 'plant'];

// 🟥 THE CHECK THAT STOPS THE TWO LISTS DRIFTING. Mistake #9 on this track is "the palette gets ahead of the
// rules"; this is its mirror — a behaviour table getting ahead of, or behind, the palette.
function checkAgainst(MATS) {
  const pal = new Set(MATS.map(([k]) => k).filter(k => k !== 'air'));
  const tab = new Set(Object.keys(TABLE));
  const missing = [...pal].filter(k => !tab.has(k));       // in the palette, no behaviour
  const extra = [...tab].filter(k => !pal.has(k));         // a behaviour for a material that does not exist
  const bad = Object.entries(TABLE).filter(([, v]) => BEHAVIOURS.indexOf(v.b) < 0).map(([k]) => k);
  return { missing, extra, bad, ok: !missing.length && !extra.length && !bad.length };
}

module.exports = { TABLE, BEHAVIOURS, checkAgainst };
