'use strict';
// ==============================================================================================================
//  worldgen.js — CHUNK-ON-DEMAND WORLD GENERATION.  Shared-World Phase 6.
//
//  WHAT THIS IS FOR.  `generateWorld` in index.js builds an entire world up front. The Overworld cannot be built
//  up front: it is millions of pixels wide, so terrain has to be a PURE FUNCTION of (seed, column, row) that can
//  be evaluated for one 64x64 chunk in isolation, thrown away, and produced again identically later. Only PLAYER
//  EDITS are stored; everything else is recomputed.
//
//  ⭐ TWO GENERATORS, ON PURPOSE (SHARED-WORLD.md §5). `generateWorld` is UNTOUCHED and still owns page rooms —
//  it has published worlds, saved Levels and a lot of tuning resting on its exact output. This file is the second
//  generator, and since the CONTENT REDESIGN (2026-08-04) it is no longer a port of the first one: it is a
//  different world, designed rather than transcribed. The research, the rejected designs and every user decision
//  behind it are in `scratchpad/worldgen_redesign_proposal.md` + its six addenda — read that, not this header,
//  before changing what the world LOOKS like.
//
//  ⭐ WHAT MAKES A CHUNK PRODUCIBLE ALONE, in one line each:
//    · every field constant comes off ONE dedicated rng stream in ONE block, before any per-cell work exists to
//      advance it (the shipped generator draws its cave phases AFTER ~700,000 per-cell draws, which is precisely
//      why a chunk cannot be produced alone there);
//    · every per-cell draw is a POSITIONAL HASH of (seed, salt, column, row), not a stream read;
//    · every rule that needs to look at a cell it does not own looks a BOUNDED distance (the pool rule probes
//      down for a floor and up for a ceiling; mounds spill one column; volcano cones and sky islands are placed
//      on a lattice with a bounded reach). Nothing scans a whole column or a whole world.
//
//  ⭐ MEASURED (probe_worldgen Part M), and it inverted the assumption: a positional hash costs 0.77x the
//  sequential stream it replaces, and the NOISE is what generation costs. That is why `fillColumn` builds a
//  scratch column with vertical overlap at both ends — the pool rule's up/down probes become byte reads instead
//  of re-evaluations of the cave field.
//
//  ⚠️ TERRAIN ONLY. `generateWorld` also places OBJECTS (trees, sky platforms, cave props) into `roomObjects`,
//  which is a single per-room Map broadcast wholesale to every client. That does not survive an infinite world
//  and needs an object-streaming design that does not exist yet, so objects are deliberately OUT rather than
//  half-built. That is also what blocks the Jungle / Forest / Swamp / Fungal / Ruins biomes.
//
//  ⏭️ NOT DONE, DELIBERATELY, AND WORTH DOING BEFORE ANY WORLD OUTLIVES A RESTART: making the noise PERIODIC at
//  a large base column period (proposal ADDENDUM 6). It is what keeps a future horizontal WRAP free — a seamless
//  wrap needs circle-sampled noise, and switching a live world to it changes the terrain everywhere, which
//  invalidates every stored edit. It is a frequency-quantisation change, not a content one, so it is its own
//  increment; the window stays open until generated worlds persist.
// ==============================================================================================================

// The server's PRNG, verbatim. Used ONLY to derive the per-world field constants below — never per cell.
// (index.js keeps its own copy for the legacy `generateWorld`; they must stay the same function.)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ⭐ THE POSITIONAL DRAW — the one thing that makes a chunk producible in isolation. A murmur-style avalanche
// chain: each input is folded in and diffused before the next arrives, so no pair of nearby (c, r) shares
// structure. `salt` separates independent decisions AT THE SAME CELL, which is what a sequential stream got for
// free by simply advancing. Chosen over two alternatives on measured quality at equal cost (probe Part M):
// chi-square 16.3 over 16 buckets and lattice correlation < 0.004 in all three neighbour directions.
// ⚠️ A hash that correlates across neighbours is not a slow world, it is a VISIBLE STRIPE PATTERN in the ground,
// which is why the probe tests correlation and carries a deliberately-bad control hash to prove it can fail.
function h(seed, salt, x, y) {
  let a = seed | 0;
  a = Math.imul(a ^ x, 0x85EBCA6B); a ^= a >>> 13;
  a = Math.imul(a ^ y, 0xC2B2AE35); a ^= a >>> 16;
  a = Math.imul(a ^ salt, 0x27D4EB2F); a ^= a >>> 15;
  return (a >>> 0) / 4294967296;
}

// ---- salts. One per independent decision; reusing one correlates two decisions at the same cell. -------------
// ⚠️ EVERY ENTRY NEEDS ROOM AFTER IT. `fbm`/`wave`/`ridge` walk octaves at `salt + i*7`, and a per-biome field
// adds the biome on top of that, so a salt is really a RANGE. The first version put the per-biome patch fields
// at 200 + (0..96) + (0..7), which quietly overlapped the warp, volcano, overhang, second-tunnel, shaft and
// cave-width salts — six fields sharing a stream with some biome's patch field. Harmless in practice only
// because they are sampled at different frequencies, which is not a property worth relying on. Ranges now.
const SALT = {
  MAT: 101, CRUST: 102, MOUND_ON: 104, MOUND_H: 105, MOUND_N: 106,     // 100-109
  HEIGHT: 110, SURFBIO: 111, WET: 112, HEAT: 113, WETF: 114, RGN: 115, // 110-159 (HEIGHT uses +20, +40, +60)
  SPAG: 160, CHEESE: 180,                                              // 160-199
  WARPX: 220, WARPY: 221, VOLC: 230, OVH: 240, SPAG2: 260, SHAFT: 270, CAVEW: 280,   // 200-299
  ISLE_ON: 300, ISLE_SHAPE: 301, ISLE_MAT: 302,     // sky band          300-309
  HALL_ON: 310, HALL_SHAPE: 311,                    // underground band  310-319
  PATCH: 1000, PATCH_STEP: 16,                      // per biome: 1000 + index*16, octaves inside the step
};

// 🟥 A MATERIAL ID THAT IS NOT IN THIS TABLE EVALUATES TO `undefined`, AND `undefined` STORED INTO A Uint8Array
// IS ZERO — i.e. the material is silently never generated anywhere. `MAT.OIL`, `MAT.GLASS` and `MAT.ACID` were
// missing for the whole of the redesign's first two rounds, and I diagnosed it as a tuning problem ("the Oil
// Shale barely shows oil") TWICE before finding it. The failure mode is silence, so there is a loud check below.
// Ids are the client's TERRAIN_MATS ids (extension/src/16a_avatars_terrain.js).
const MAT = { EARTH: 1, STONE: 2, SAND: 3, ICE: 4, MUD: 5, SNOW: 8, WATER: 9, QUICKSAND: 10, LAVA: 11,
  ACID: 12, BRINE: 14, OIL: 15, GLASS: 16 };
for (const k of ['EARTH', 'STONE', 'SAND', 'ICE', 'SNOW', 'WATER', 'QUICKSAND', 'LAVA', 'ACID', 'BRINE', 'OIL', 'GLASS'])
  if (!MAT[k]) throw new Error('worldgen: MAT.' + k + ' is undefined — a missing id generates as AIR, silently');

// Surface biomes are small ints rather than strings — compared once per column and once per cell, and an int
// compare in the fill loop is free where a string compare is not.
const SB = { PLAINS: 0, FOREST: 1, DESERT: 2, SNOW: 3, SWAMP: 4, VOLCANIC: 5 };
const DEF_STRENGTH = { 2: 3, 4: 2, 5: 2, 17: 2 };     // matches index.js BUILTIN_STRENGTH; everything else is 1
// Which ids FLOW. Mirrors the client's `TERRAIN_MATS[v].behavior === 'fluid'` and index.js's TERRAIN_MATS_FLUID.
// ⚠️ Powders (sand, snow) are NOT fluid here: they fall and pile, so they are ground you can stand on.
const FLUID_ID = { 9: 1, 10: 1, 11: 1, 12: 1, 14: 1, 15: 1 };
const isFluid = (v) => !!FLUID_ID[v];
const CHUNK_SIDE = 64;

// ==============================================================================================================
//  NOISE.  Value noise: hash the lattice corners, smoothstep between them. Returns 0..1.
//  `abs(2*fBm-1)` is RIDGED noise — zero along a crease — and thresholding the crease gives a winding line,
//  i.e. a tunnel. That is the whole cave algorithm, and it is the same SHAPE as the sine test it replaced. The
//  sines were the problem: sum three periodic things and the caves repeat on a schedule, visibly.
// ==============================================================================================================
function vn2(seed, salt, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h(seed, salt, xi, yi), b = h(seed, salt, xi + 1, yi);
  const c = h(seed, salt, xi, yi + 1), d = h(seed, salt, xi + 1, yi + 1);
  const top = a + (b - a) * u, bot = c + (d - c) * u;
  return top + (bot - top) * v;
}
function vn1(seed, salt, x) {
  const xi = Math.floor(x), xf = x - xi;
  const u = xf * xf * (3 - 2 * xf);
  const a = h(seed, salt, xi, 0), b = h(seed, salt, xi + 1, 0);
  return a + (b - a) * u;
}
// fBm — octaves at halving amplitude, doubling frequency. Big shapes with fine detail on them.
function fbm2(seed, salt, x, y, oct) {
  let f = 1, amp = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * vn2(seed, salt + i * 7, x * f, y * f); norm += amp; f *= 2; amp *= 0.5; }
  return sum / norm;
}
function fbm1(seed, salt, x, oct) {
  let f = 1, amp = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * vn1(seed, salt + i * 7, x * f); norm += amp; f *= 2; amp *= 0.5; }
  return sum / norm;
}
// 🟥 A BIG SMOOTH SWING IS NOT WHAT fBm GIVES YOU, AND THIS COST FIVE SEPARATE ROUNDS ON THIS TRACK. Averaging
// octaves pulls the result towards its middle: a 3-octave fBm barely leaves 0.4..0.6. It silently flattened the
// layer boundaries at a +-39-row amplitude, stopped a cold world ever reaching its snow threshold, squashed the
// region field and made overhangs invisible. `wave1` keeps ONE DOMINANT OCTAVE (which spans the full range on
// its own) and adds a small second one for detail, so +-1 means +-1. Signed, -1..1.
// ⚠️ Its cousin, hit twice: a frequency so low that a whole small world sits inside ONE lattice cell.
function wave1(seed, salt, x) {
  return (vn1(seed, salt, x) * 2 - 1) * 0.78 + (vn1(seed, salt + 7, x * 2.3) * 2 - 1) * 0.22;
}
function wave2(seed, salt, x, y) {
  return (vn2(seed, salt, x, y) * 2 - 1) * 0.72 + (vn2(seed, salt + 7, x * 2.7, y * 2.7) * 2 - 1) * 0.28;
}
// ⭐ RIDGED fBm — several octaves of `1 - |noise|`, each squared to sharpen the crease. One octave of this is a
// TENT (and cubing a tent gives the sharp triangular peaks the user rejected); several octaves give a ridgeline
// with shoulders and spurs. Returns 0..1, near 1 along a ridge.
function ridge1(seed, salt, x, oct) {
  let f = 1, amp = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const v = 1 - Math.abs(vn1(seed, salt + i * 7, x * f) * 2 - 1);
    sum += amp * v * v; norm += amp; f *= 2.0; amp *= 0.40;   // ⚠️ gain 0.52 put ~50-row teeth every 22 columns
  }
  return sum / norm;
}

// ==============================================================================================================
//  THE BIOME CATALOGUE.  A biome is a RECORD — a table you edit, not code you read.
//
//  🟥 THERE IS NO LAYER STACK. The first design was six horizontal bands with three provinces each; the user
//  replaced it: *"rather than defined layers, it should just be more varied, while still remaining continuous
//  and appropriate"*. So this is ONE FLAT CATALOGUE, and every biome states where it belongs in a three-axis
//  CLIMATE SPACE. A cell takes the NEAREST biome (Minecraft's multi-noise model).
//
//     at: [ depth, heat, wet ]      each 0..1
//     depth  0 at the surface, 1 at the world floor. Weighted highest, so "belongs deep" still means something —
//            but it is a PREFERENCE, not a partition.
//     heat   ⭐ = depth x 0.72 + noise. Deep is hot BY DEFAULT, so the molten floor is a CONSEQUENCE rather than
//            a rule — and the noise means cold pockets exist deep down and hot ground near the surface.
//     wet    pure noise. How much liquid pools, and which biomes can exist there at all.
//
//  ⭐ Everything that existed to fake irregularity is gone with the bands — no boundary rows, no wavy-boundary
//  field, no blend band, no province mechanism. Boundaries are irregular BY CONSTRUCTION when the fields are.
//
//  `fluid`  the liquid that pools in its caves.  `wet` how much of it pools (0..1, higher = wetter).
//  `caves`  w / w2 tunnel widths (bigger = wider), t chamber threshold (LOWER = more and bigger chambers).
//  `patch`  an optional SECOND material in LARGE COHERENT PATCHES. ⚠️ NOT the per-cell speckle that was cut —
//           that was salt-and-pepper at ~10% of cells; these are metres-wide bodies, and they only exist where
//           being made of two things is the biome's whole point.
//  ⚠️ THE CAVE THRESHOLDS ARE MEASURED, NOT GUESSED (`scratchpad/worldgen_tune.js`). The first pass guessed and
//  produced a world that was 33% tunnel and 25% chamber, i.e. mostly hole.
// ==============================================================================================================
const BIOMES = [
  // ---- shallow ------------------------------------------------------------------------------------------------
  { key: 'rootbed',  name: 'Rootbed',        at: [0.08, 0.22, 0.55], mat: MAT.EARTH, patch: null, fluid: MAT.WATER, wet: 0.30, poolMul: 1.4,
    caves: { w: 0.062, w2: 0.045, t: 0.7 }, climateBias: 0.05 },
  { key: 'cobble',   name: 'Cobblefield',    at: [0.14, 0.30, 0.32], mat: MAT.EARTH, patch: { mat: MAT.STONE, freq: 0.055, t: 0.56 }, fluid: MAT.WATER, wet: 0.18,
    caves: { w: 0.055, w2: 0.04, t: 0.72 }, climateBias: 0.05 },
  { key: 'sinkhole', name: 'Sinkholes',      at: [0.06, 0.34, 0.42], mat: MAT.EARTH, patch: null, fluid: MAT.WATER, wet: 0.35, caveBoost: 1.4,
    caves: { w: 0.068, w2: 0.052, t: 0.68 }, climateBias: 0.0 },
  { key: 'dunes',    name: 'Buried Dunes',   at: [0.18, 0.58, 0.10], mat: MAT.SAND, patch: null, fluid: MAT.QUICKSAND, wet: 0.10, caveBoost: 0.6,
    caves: { w: 0.04, w2: 0.028, t: 0.8 }, climateBias: -0.55 },
  // ---- middle -------------------------------------------------------------------------------------------------
  { key: 'dripstone', name: 'Dripstone',     at: [0.38, 0.28, 0.92], mat: MAT.STONE, patch: { mat: MAT.EARTH, freq: 0.040, t: 0.64 }, fluid: MAT.WATER, wet: 0.90, poolMul: 2.6,
    caves: { w: 0.06, w2: 0.048, t: 0.62 }, climateBias: 0.15 },
  { key: 'karst',    name: 'Karst',          at: [0.34, 0.36, 0.62], mat: MAT.STONE, patch: null, fluid: MAT.WATER, wet: 0.45, poolMul: 1.6,
    caves: { w: 0.07, w2: 0.055, t: 0.8 }, climateBias: 0.05 },
  { key: 'drylands', name: 'Drylands',       at: [0.44, 0.46, 0.14], mat: MAT.STONE, patch: null, fluid: MAT.WATER, wet: 0.02, caveBoost: 0.75,
    caves: { w: 0.042, w2: 0.03, t: 0.82 }, climateBias: -0.2 },
  { key: 'sinking',  name: 'Sinking Sands',  at: [0.36, 0.60, 0.72], mat: MAT.SAND, patch: null, fluid: MAT.QUICKSAND, wet: 0.85, poolMul: 2.0,
    caves: { w: 0.046, w2: 0.034, t: 0.76 }, climateBias: -0.5 },
  { key: 'glacier',  name: 'Glacier',        at: [0.42, 0.10, 0.38], mat: MAT.ICE, patch: { mat: MAT.STONE, freq: 0.035, t: 0.62 }, fluid: MAT.BRINE, wet: 0.15,
    caves: { w: 0.055, w2: 0.042, t: 0.74 }, climateBias: 0.85 },
  { key: 'snowpack', name: 'Snowpack',       at: [0.30, 0.06, 0.30], mat: MAT.SNOW, patch: { mat: MAT.ICE, freq: 0.040, t: 0.60 }, fluid: MAT.BRINE, wet: 0.10, caveBoost: 0.6,
    caves: { w: 0.044, w2: 0.032, t: 0.78 }, climateBias: 0.9 },
  { key: 'brine',    name: 'Brine Cellars',  at: [0.50, 0.16, 0.95], mat: MAT.STONE, patch: { mat: MAT.ICE, freq: 0.038, t: 0.66 }, fluid: MAT.BRINE, wet: 0.95, poolMul: 2.4,
    caves: { w: 0.058, w2: 0.046, t: 0.66 }, climateBias: 0.6 },
  // ---- deep ---------------------------------------------------------------------------------------------------
  { key: 'granite',  name: 'Granite',        at: [0.70, 0.48, 0.22], mat: MAT.STONE, patch: { mat: MAT.EARTH, freq: 0.030, t: 0.72 }, fluid: MAT.WATER, wet: 0.06, caveBoost: 0.8,
    caves: { w: 0.048, w2: 0.036, t: 0.78 }, climateBias: -0.1 },
  { key: 'shale',    name: 'Oil Shale',      at: [0.72, 0.62, 0.74], mat: MAT.STONE, patch: { mat: MAT.EARTH, freq: 0.045, t: 0.68 }, fluid: MAT.OIL, wet: 0.85, poolMul: 2.2,
    caves: { w: 0.056, w2: 0.044, t: 0.7 }, climateBias: -0.25 },
  { key: 'acid',     name: 'Acid Wastes',    at: [0.64, 0.56, 0.88], mat: MAT.STONE, patch: { mat: MAT.GLASS, freq: 0.042, t: 0.70 }, fluid: MAT.ACID, wet: 0.80, poolMul: 1.8,
    caves: { w: 0.056, w2: 0.044, t: 0.72 }, climateBias: -0.3 },
  { key: 'deepice',  name: 'Deep Ice',       at: [0.76, 0.06, 0.40], mat: MAT.ICE, patch: { mat: MAT.STONE, freq: 0.032, t: 0.58 }, fluid: MAT.BRINE, wet: 0.20,
    caves: { w: 0.05, w2: 0.038, t: 0.76 }, climateBias: 0.8 },
  { key: 'glass',    name: 'Glassfields',    at: [0.80, 0.82, 0.24], mat: MAT.STONE, patch: { mat: MAT.GLASS, freq: 0.036, t: 0.62 }, fluid: MAT.LAVA, wet: 0.30, poolMul: 1.6,
    caves: { w: 0.056, w2: 0.044, t: 0.68 }, climateBias: -0.7 },
  // ---- the floor ----------------------------------------------------------------------------------------------
  { key: 'molten',   name: 'Molten Depths',  at: [0.99, 0.99, 0.55], mat: MAT.STONE, patch: null, fluid: MAT.LAVA, wet: 0.85, poolMul: 2.6, floor: true,
    caves: { w: 0.062, w2: 0.05, t: 0.62 }, climateBias: -0.85 },
];
const MOLTEN = BIOMES.findIndex(b => b.floor);
// How much each axis counts when finding the nearest biome. Depth counts most — "belongs deep" is the strongest
// statement a biome makes about itself — but it is a preference now, not a partition.
const AX_D = 2.4, AX_H = 1.0, AX_W = 1.0;

// ---- surface biomes. Crust depth is PER BIOME (the "deeper snow" ask) rather than one global number. ---------
// ⚠️ `crust` is in this file's 24px-cell units, like every other feature size — multiply by G for rows. At the
// shipped 8px cell G is 3, so 4 -> 12 rows (what ships today) and snow's 12 -> 36 rows ≈ 290px of snow to sink
// into.  🟥 THE SURFACE DUNE RIPPLE IS GONE (user: "too spiky basically"). A high-frequency ridged term added to
// a heightmap gives spikes, not dunes — a real dune has a shallow windward face and a steep slip face, which is
// an ASYMMETRIC shape a symmetric noise cannot make. Deserts are simply flat.
// ⭐ `flat` is what makes the surface VARIED rather than uniformly mountainous: it is added to the erosion field,
// and erosion is what suppresses mountains. Without it the whole world was mountain range.
const SURFACE = [
  { key: 'plains',   name: 'Plains',   crust: 4.0,  mat: MAT.EARTH, flat: 0.34 },
  { key: 'forest',   name: 'Forest',   crust: 4.6,  mat: MAT.EARTH, flat: 0.12 },
  { key: 'desert',   name: 'Desert',   crust: 7.0,  mat: MAT.SAND,  flat: 0.30 },
  { key: 'snow',     name: 'Tundra',   crust: 12.0, mat: MAT.SNOW,  flat: 0.36 },
  { key: 'swamp',    name: 'Marsh',    crust: 4.6,  mat: MAT.EARTH, flat: 0.44 },   // no MUD — that is a reaction product now
  { key: 'volcanic', name: 'Volcanic', crust: 3.4,  mat: MAT.STONE, flat: -0.26 },
];

// ==============================================================================================================
//  THE RECIPE — how a world arranges the catalogue.
//  ⭐ USER DECISION: a page world is not a squashed Overworld and not a truncated one. It is BUILT FROM ONE OR
//  SEVERAL BIOMES chosen off its own seed, so pages differ from each other instead of every page being the same
//  world. The Overworld is the one world that uses the whole catalogue.
// ==============================================================================================================
function recipeFor(seed, overworld) {
  if (overworld) return { picks: BIOMES.map((_, i) => i), climate: 0 };
  const r = mulberry32((seed ^ 0x9E3779B9) | 0);
  r(); r();                                                   // warm-up; mulberry32's first draw tracks the seed
  const roll = r();
  const n = roll < 0.30 ? 2 : roll < 0.80 ? 3 : 4;
  const pool = BIOMES.map((_, i) => i);
  const picks = [];
  for (let k = 0; k < n; k++) picks.push(pool.splice((r() * pool.length) | 0, 1)[0]);
  if (!picks.includes(MOLTEN) && r() < 0.45) picks.push(MOLTEN);   // a floor of consequence, some of the time
  picks.sort((a, b) => a - b);
  // ⭐ The surface should agree with what is under it: a page built from Deep Ice gets a cold sky, one built from
  // the Molten Depths gets a volcanic one. Otherwise a page reads as a lid bolted onto an unrelated basement.
  const bias = picks.reduce((s, i) => s + (BIOMES[i].climateBias || 0), 0) / picks.length;
  return { picks, climate: Math.max(-1, Math.min(1, bias + (r() * 2 - 1) * 0.45)) };
}

// ==============================================================================================================
//  makeGen(cfg) — everything a world is, derived from its seed. Cheap: a few dozen draws and no allocation
//  proportional to world size, so it is fine to build one per room and hold it for the room's lifetime.
//
//  cfg: { seed, cols, rows, cell, floorTop, surfaceFrac?, band?, strength?, overworld?, warp?, caveMul?, recipe? }
//    band     — {c0, c1} column limits, matching generateWorld's Level-size confinement; null = the whole width.
//    overworld— the whole catalogue and continent-sized horizontal features, rather than a seeded selection.
//    warp     — domain-warping strength (0 = off). The 2.43x dial; built so it can be judged, not guessed.
//  ⚠️ `spawnX`/`spawnHalfW` are accepted and IGNORED. The spawn plateau is gone (user: it "ruins continuity and
//  immersion"), so the generator no longer carves a flat stump into the ground for anybody.
// ==============================================================================================================
function makeGen(cfg) {
  const seed = cfg.seed | 0;
  const cols = cfg.cols | 0, rows = cfg.rows | 0;
  const CELL = cfg.cell || 8;
  // Feature sizes were tuned in rows/columns for a 24px cell; G restores physical sizes at any cell size
  // (multiply row/column counts by G, divide spatial frequencies by G). Same convention as generateWorld.
  const G = 24 / CELL;
  const WARP = cfg.warp || 0;
  const CMUL = cfg.caveMul || 1.0;                            // overall cave-width dial (connectivity sweep knob)
  const floorTop = (cfg.floorTop != null) ? cfg.floorTop : (rows * CELL - 72);
  const bottomRow = Math.min(rows - 1, Math.ceil(floorTop / CELL) - 1);   // last terrain row resting on the floor
  const baseRow = Math.round(bottomRow * (cfg.surfaceFrac != null ? cfg.surfaceFrac : 0.47));
  const POOL_DEPTH = Math.round(4 * G);
  const POOL_MAX = Math.round(4 * G * 2.6);                   // the deepest any biome fills — sets the column overlap
  const ICE_SHEET = Math.round(2.5 * G);                      // how thick the frozen lid on a polar sea is
  const HEAD = Math.round(2.5 * G);                           // ceiling clearance a cell needs before it floods
  // Solid rows at the very bottom of the world — see the note in `solidAt`. Deep enough that a player digging
  // into it still meets ground rather than the drawn floor band immediately.
  const BEDROCK = Math.max(2, Math.round(1.5 * G));
  const bedrockTop = Math.max(1, bottomRow - BEDROCK + 1);
  const strTab = cfg.strength || DEF_STRENGTH;
  const strengthOf = (v) => strTab[v] || 1;

  // ⭐⭐ THE FIX FOR CHUNK-INDEPENDENCE, AND IT IS THIS BLOCK. Every field constant in the world comes off ONE
  // dedicated stream, drawn HERE, before any per-cell work exists to advance it. Order matters (it defines the
  // world for a seed) but nothing outside this block may draw. `probe_worldgen` E8 asserts that structurally.
  const r = mulberry32(seed);
  const p0 = r() * Math.PI * 2, p1 = r() * Math.PI * 2, p2 = r() * Math.PI * 2;
  const a0 = (7 + r() * 7) * G, a1 = (3 + r() * 3) * G, a2 = (1 + r() * 2) * G;
  const hOff = r() * 1000, sOff = r() * 1000, wOff = r() * 1000;
  void p0; void p1; void p2; void a0; void a1; void a2;       // reserved: kept so the stream's shape is stable

  const recipe = cfg.recipe || recipeFor(seed, !!cfg.overworld);
  const picks = recipe.picks;
  const picksHasMolten = picks.includes(MOLTEN);
  const seaRow = baseRow;   // ⭐ sea level IS the elevation origin; the continentalness spline is measured from it
  const genC0 = cfg.band ? Math.max(0, cfg.band.c0) : 0;
  const genC1 = cfg.band ? Math.min(cols - 1, cfg.band.c1) : cols - 1;

  // ============================================================================================================
  //  THE SURFACE — three fields multiplied together, after Minecraft's continentalness / erosion / peaks-and-
  //  valleys. The old surface was a sum of three sines with about +-60 rows of relief: rolling hills and nothing
  //  else. Total relief is now ~814 rows = 9 screens.
  //    cont  very low frequency. Highlands versus lowlands.
  //    ero   how FLAT the ground is here. High = plains, low = mountains.
  //    pv    ridged noise — mountains, multiplied by (1 - ero) so they only exist where erosion is low.
  //  ⭐ All three are functions of the COLUMN, so the per-column hoist survives completely: dramatic terrain is
  //  as cheap as flat terrain. Only the overhang term varies in both axes, and it is confined to a band.
  //  ⚠️ RELIEF IS A FRACTION OF THE AVAILABLE SKY, not an absolute row count. Fixed amplitudes tuned for the
  //  Overworld drove a 405-row page world to 68% solid with peaks jammed against row 12.
  //  🟥 TERRACING IS GONE (user: "doesn't look natural at all"). Snapping a heightmap to steps makes stairs, and
  //  jittering the snap makes irregular stairs. Cliffs come from the 2D surface-density band instead — one
  //  mechanism for cliffs AND overhangs, not two.
  // ============================================================================================================
  const DETAIL_A = Math.round(baseRow * 0.018) + 2;
  // (continentalness, elevation as a fraction of baseRow). Negative = sea floor. ⭐ The FLAT SHELF either side of
  // zero is what produces coastlines, beaches and shallow seas instead of land that occasionally dips under.
  const CONT_SPLINE = [[-1.00, -0.32], [-0.62, -0.23], [-0.34, -0.07], [-0.16, 0.010], [0.06, 0.045],
                       [0.30, 0.13], [0.62, 0.28], [1.00, 0.40]];
  function spline(x, pts) {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) {
      const x0 = pts[i - 1][0], y0 = pts[i - 1][1], x1 = pts[i][0], y1 = pts[i][1], t = (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * (t * t * (3 - 2 * t));
    }
    return pts[pts.length - 1][1];
  }
  // ⚠️ CONTINENTAL FREQUENCIES DO NOT FIT IN A PAGE WORLD. Tuned for millions of columns, they put a whole page
  // world (1,920 columns) inside ONE lattice cell — a single smooth swell with no coast and no range. Small
  // worlds compress the horizontal scale so a page gets a whole landscape.
  const HS = cfg.overworld ? 1 : 6;
  // 🟥 THIS SPLINE IS WHY THE SURFACE NO LONGER STEPS IN VERTICAL SLICES. `SURFACE[biome].flat` is a STEP
  // function — the moment the thresholded biome index changed, flatness jumped by up to 0.7, erosion jumped, the
  // mountain term jumped, and the ground moved tens of rows in ONE COLUMN. Flatness is now splined along the
  // CONTINUOUS field that decides the biome, using each biome's band centre as a knot: the material still
  // switches at a threshold, but the LANDFORM varies smoothly through it.
  const FLAT_KNOTS = [[-1.60, -0.26], [-0.75, 0.30], [-0.28, 0.44], [0.09, 0.34], [0.56, 0.12], [1.40, 0.36]];
  const CRUST_KNOTS = [[-1.60, 3.4], [-0.75, 7.0], [-0.28, 4.6], [0.09, 4.0], [0.56, 4.6], [1.40, 12.0]];
  // Surface biome from one noise field, shifted by the world's `climate` so different pages have different
  // dominant weather. The raw field is exposed as well as the thresholded biome, because the landform has to
  // vary continuously through a biome edge even though the material does not.
  const sbRawAt = (c) => wave1(seed, SALT.SURFBIO, c * 0.0075 / G + sOff) * 1.15 + recipe.climate * 0.72;
  const eroAt = (c) => {
    const base = (wave1(seed, SALT.HEIGHT + 40, c * 0.0016 * HS / G + hOff) + 1) * 0.5;
    return Math.max(0, Math.min(1, base + spline(sbRawAt(c), FLAT_KNOTS)));
  };

  // ---- volcanoes: the lattice pattern doing something worth looking at ---------------------------------------
  // One candidate every VOLC_STEP columns, ~9% of them real. A cone with a crater bitten out of the top and a
  // lava conduit under it. Bounded size => a chunk asks "does any anchor within VOLC_HW of me reach me?" alone.
  const VOLC_STEP = Math.round(420 * G), VOLC_HW = Math.round(300 * G);
  const VOLC_H = Math.round(baseRow * 0.42), VOLC_CRATER = Math.round(26 * G);
  const volcOn = (a) => h(seed, SALT.VOLC, a, 0) < 0.09 && a > VOLC_HW && a < cols - VOLC_HW;
  // 🟥 THIS USED TO LOOK AT ONE ANCHOR — the nearest — so halfway between two the answer switched, and since the
  // cone is half-width 900 against a 1,260 spacing it had NOT decayed to zero by then: the surface dropped ~29
  // rows in a single column. Every candidate whose cone can reach `c` is considered and the tallest wins, which
  // is continuous, and lets two volcanoes overlap into a range instead of clipping each other.
  function volcanoLift(c) {
    const near = Math.round(c / VOLC_STEP), reach = Math.ceil(VOLC_HW / VOLC_STEP) + 1;
    let lift = 0;
    for (let k = -reach; k <= reach; k++) {
      const a = (near + k) * VOLC_STEP; if (!volcOn(a)) continue;
      const d = Math.abs(c - a); if (d >= VOLC_HW) continue;
      const t = 1 - d / VOLC_HW;
      let L = VOLC_H * t * t;                                 // a cone, steeper near the top
      if (d < VOLC_CRATER) L -= (1 - d / VOLC_CRATER) * 30 * G;   // bite the crater out of the summit
      if (L > lift) lift = L;
    }
    return Math.round(lift);
  }
  // ⭐ THE CONDUIT RUNS ALL THE WAY DOWN TO THE MAGMA (user, 2026-08-04). It used to stop at an arbitrary depth,
  // leaving a volcano plumbed into nothing; it now reaches the world floor, so every volcano is physically
  // connected to the molten layer that feeds it — and is a route down for a player brave enough.
  const volcVentAt = (c) => {
    const near = Math.round(c / VOLC_STEP), reach = Math.ceil(VOLC_HW / VOLC_STEP) + 1;
    for (let k = -reach; k <= reach; k++) {
      const a = (near + k) * VOLC_STEP;
      if (volcOn(a) && Math.abs(c - a) < VOLC_CRATER * 0.55) return 1;
    }
    return 0;
  };

  const heightAt = (c) => {
    const cont = wave1(seed, SALT.HEIGHT, c * 0.0011 * HS / G + hOff) + 0.24;   // biased toward land: sea is a feature
    const ero = eroAt(c);
    const land = spline(cont, CONT_SPLINE);                   // elevation above sea, as a fraction of baseRow
    // ⭐ MOUNTAINS FROM MULTI-OCTAVE RIDGED NOISE, not from one tent cubed. `1 - |noise|` is a TENT: cube it and
    // you get a single sharp spike, which is exactly the triangular peaks the user rejected. Several octaves
    // give a ridgeline with shoulders, spurs and foothills — a range rather than a traffic cone.
    const mtn = ridge1(seed, SALT.HEIGHT + 20, c * 0.0075 * Math.sqrt(HS) / G, 3);   // already squared per octave
    const above = Math.max(0, Math.min(1, (land + 0.02) / 0.10));   // no mountains rising out of deep water
    const hh = (land + mtn * (1 - ero) * above * 0.46) * baseRow
      + (fbm1(seed, SALT.HEIGHT + 60, c * 0.030 / G, 3) - 0.5) * 2 * DETAIL_A;
    const s = Math.round(baseRow - hh) - volcanoLift(c);       // volcanoes sit on top of whatever is there
    return s < 4 * G ? 4 * G : (s > bottomRow - 10 * G ? bottomRow - 10 * G : s);
  };
  const surfAt = (c) => heightAt(c);
  // ⭐ ALTITUDE OVERRIDES CLIMATE. Above the snow line the crust is snow whatever the biome says, and above the
  // ice line it is bare ice — so a mountain rising out of a desert still gets a white cap. Terraria has no
  // equivalent (its biomes are horizontal only); this is the one place the two axes genuinely interact.
  const snowLine = baseRow - Math.round(baseRow * 0.34), iceLine = baseRow - Math.round(baseRow * 0.58);

  const surfBiomeAt = (c) => {
    const v = sbRawAt(c);                                     // climate BIASES the mix, it does not replace it
    if (v > 0.85) return SB.SNOW; if (v > 0.28) return SB.FOREST; if (v < -1.05) return SB.VOLCANIC;
    if (v < -0.45) return SB.DESERT; if (v < -0.10) return SB.SWAMP; return SB.PLAINS;
  };
  const sbAt = (c) => surfBiomeAt(c);
  // 🟥 THE OTHER HALF OF THE VERTICAL SEAM: even with the height fixed, the crust MATERIAL still changed on a
  // razor-straight vertical line (earth | sand | snow), because a threshold on a column-only field flips every
  // cell in that column together, top to bottom. ⭐ Fixed with a DITHER rolled per CELL near the threshold, so
  // the two crusts interleave over tens of columns AND the seam breaks up vertically.
  // ⚠️ The roll takes the ROW as well as the column — keying it on the column alone reproduces the exact bug.
  const SB_EDGES = [-1.05, -0.45, -0.10, 0.28, 0.85];         // v ascending: volcanic desert swamp plains forest snow
  const SB_ORDER = [SB.VOLCANIC, SB.DESERT, SB.SWAMP, SB.PLAINS, SB.FOREST, SB.SNOW];
  const SB_SOFT = 0.16;
  const sbBlendAt = (c, rr) => {
    const v = sbRawAt(c);
    let k = 0; while (k < SB_EDGES.length && v > SB_EDGES[k]) k++;
    for (let e = 0; e < SB_EDGES.length; e++) {
      const dd = v - SB_EDGES[e];
      if (Math.abs(dd) < SB_SOFT) {
        const p = 0.5 * (1 - Math.abs(dd) / SB_SOFT);
        if (h(seed, SALT.CRUST + 3, c, rr) < p) k = dd < 0 ? e + 1 : e;
        break;
      }
    }
    return SB_ORDER[Math.max(0, Math.min(SB_ORDER.length - 1, k))];
  };
  const crustMatAt = (c, rr, s) => s < iceLine ? MAT.ICE : s < snowLine ? MAT.SNOW : SURFACE[sbBlendAt(c, rr)].mat;
  // Crust DEPTH is splined along the same continuous field, for the reason the landform was: a table lookup on a
  // thresholded index is a step, and a step in crust depth is another seam.
  const crustDepthAt = (c, s) => {
    const base = (s < snowLine ? 10.0 : spline(sbRawAt(c), CRUST_KNOTS)) * G;
    return Math.round(base) + ((h(seed, SALT.CRUST, c, 0) * 4 * G) | 0);
  };

  // ============================================================================================================
  //  THE REGION AT A CELL — three climate axes, nearest biome wins.
  //  ⭐ SAMPLED ONCE PER 4x4 BLOCK. Regions are hundreds of cells across, so quantising to 4 is invisible and it
  //  takes back most of the cost of the two axes that vary in both directions (the measured 1.43x). The DITHER
  //  at a boundary is still per cell, so the 4x4 blocks never show as blocks.
  //  🟥 THE QUANTISED LOOKUP MUST NOT DEPEND ON THE COLUMN THAT ASKED. The obvious memo — key on (c & ~3, r & ~3)
  //  but pass the ASKING column's surface row — makes the answer depend on which of the four columns was
  //  generated first, which is order-dependence, which is the one property this whole file exists to have. So
  //  the depth axis is measured from the surface of the QUANTISED column, and the lookup is a pure function of
  //  (c & ~3, r & ~3). Part B is what would catch a regression here.
  // ============================================================================================================
  const RGN_SOFT = 0.030;                                     // how close two biomes must be to interleave
  let _sqC = -1, _sqV = 0;                                    // 1-entry memo for surfAt of a quantised column
  const surfQ = (cq) => { if (cq !== _sqC) { _sqC = cq; _sqV = surfAt(cq); } return _sqV; };
  function climAt(c, rr, s) {
    const span = Math.max(1, bottomRow - s);
    const d = Math.max(0, Math.min(1, (rr - s) / span));
    // ⭐ Heat rises with depth BY DEFAULT, so the molten floor is a consequence rather than a rule — but the
    // noise term means cold pockets exist deep down and hot ground exists near the surface.
    const heat = Math.max(0, Math.min(1, d * 0.72 + wave2(seed, SALT.HEAT, c * 0.0055 / G, rr * 0.011 / G) * 0.44 + 0.14));
    const wet = Math.max(0, Math.min(1, 0.5 + wave2(seed, SALT.WETF, c * 0.0070 / G + wOff, rr * 0.013 / G) * 0.62));
    return { d, heat, wet };
  }
  // Returns { a, b, p } — best biome, runner-up, and the probability a cell defects to the runner-up.
  function regionInfo(cq, rq) {
    const cl = climAt(cq, rq, surfQ(cq));
    let best = -1, bd = Infinity, second = -1, sd = Infinity;
    for (let i = 0; i < picks.length; i++) {
      const B = BIOMES[picks[i]], a = B.at;
      const dd = (cl.d - a[0]) * (cl.d - a[0]) * AX_D + (cl.heat - a[1]) * (cl.heat - a[1]) * AX_H
        + (cl.wet - a[2]) * (cl.wet - a[2]) * AX_W;
      if (dd < bd) { second = best; sd = bd; best = picks[i]; bd = dd; }
      else if (dd < sd) { second = picks[i]; sd = dd; }
    }
    if (second < 0) return { a: best, b: best, p: 0 };
    const margin = Math.sqrt(sd) - Math.sqrt(bd);
    return { a: best, b: second, p: margin < RGN_SOFT ? 0.5 * (1 - margin / RGN_SOFT) : 0 };
  }
  // The molten floor: the one place depth still overrules the climate, and the one the user kept.
  // 🟥 TWO FAILED ATTEMPTS AT THIS BOUNDARY, and the user diagnosed the second correctly: *"column-wise noise is
  // not an appropriate fix to poor vertical blending between interfaces."*
  //   1st: a probability fade over 7% of the world's depth — ~120 rows of two materials randomly interleaved,
  //        which reads as a band of STATIC, not as a boundary.
  //   2nd: the threshold displaced by a function of the COLUMN — which can only ever be a wavy HORIZONTAL LINE.
  // ⭐ It is now a 2D DENSITY TEST, the same device that gives the surface its overhangs, so molten rock reaches
  // up in tongues and pockets of cooler ground hang down into it. No dither: an irregular surface needs none.
  // ⚠️ Evaluated at FULL resolution, not through the 4x4 lookup, or the interface becomes a staircase.
  // ⚠️ The `0.88` pre-test is a PERFORMANCE GUARD, not a rule: the wave term is bounded by +-0.055, so no cell
  // shallower than 0.88 of the way down can possibly pass, and skipping the two noise reads for those cells is
  // output-identical. Without it this ran on every cell of the world including the sky, which is 8 hashes each.
  const moltenAt = (c, rr, s) => {
    if (!picksHasMolten) return false;
    const span = Math.max(1, bottomRow - s);
    if (rr - s < span * 0.88) return false;
    const d = (rr - s) / span;
    return d > 0.935 + wave2(seed, SALT.VOLC + 5, c * 0.0075 / G, rr * 0.013 / G) * 0.055;
  };
  let _rcq = -1, _rcache = null, _wmcache = null;
  const _bump = (cq) => { _rcq = cq; _rcache = []; _wmcache = []; };
  function regionPick(c, rr, s) {
    if (moltenAt(c, rr, s)) return MOLTEN;                    // full-resolution, so the interface is not stepped
    const cq = c & ~3, rq = rr & ~3, k = rq >> 2;
    if (cq !== _rcq) _bump(cq);
    let ri = _rcache[k];
    if (ri === undefined) ri = _rcache[k] = regionInfo(cq, rq);
    return (ri.p > 0 && h(seed, SALT.RGN, c, rr) < ri.p) ? ri.b : ri.a;
  }
  // ⭐ CAVE-WIDTH MODULATION, on the SAME 4x4 grid as the climate and for the same reason. `wm` is a slow field —
  // its lattice cells are ~660 columns by ~375 rows — and sampling it per cell was measured at 19% of every hash
  // read the generator makes, to resolve detail it does not have. Quantising it to 4 cells is invisible; it only
  // moves a threshold, and the threshold's own noise is per cell.
  const wmAt = (c, rr) => {
    const cq = c & ~3, rq = rr & ~3, k = rq >> 2;
    if (cq !== _rcq) _bump(cq);
    let w = _wmcache[k];
    if (w === undefined) {
      const t = Math.max(0, Math.min(1, wave2(seed, SALT.CAVEW, cq * 0.0045 / G, rq * 0.008 / G) * 0.5 + 0.5));
      w = _wmcache[k] = 0.52 + 1.45 * t * t * t;
    }
    return w;
  };

  // ---- solid fill ---------------------------------------------------------------------------------------------
  // ⚠️ NO PER-CELL SPECKLE ANYWHERE. The shipped generator sprinkles ~10-14% of deep cells with a contrasting
  // material; that clutter is what reads as gold/diamond litter and it is gone. Where a biome is made of two
  // materials they are LARGE COHERENT PATCHES from a low-frequency noise, because that is the biome's
  // definition, not decoration.
  // ⭐ ONE MECHANISM FOR BOTH CLIFFS AND OVERHANGS. A heightmap cannot make an overhang by construction: one
  // surface row per column means the ground can never lean out over itself. So near the surface, solidity comes
  // from a field varying in BOTH axes. Where it changes quickly with the column you get a near-vertical face —
  // a cliff; where it changes quickly with the ROW, the face leans out — an overhang. The displacement fades to
  // zero at the bottom of the band so it does not tear where the band ends.
  const OVH = Math.round(baseRow * 0.052), OVH_BAND = Math.round(baseRow * 0.16);
  const surfDisp = (c, rr, s) => {
    const t = (rr - s) / OVH_BAND;
    const fade = t <= 0 ? 1 : t >= 1 ? 0 : (1 - t) * (1 - t);
    return Math.round(wave2(seed, SALT.OVH, c * 0.024 / G, rr * 0.017 / G) * OVH * fade);
  };
  // `bi` is the biome index if the caller already has it — `solidAt` looks it up once and hands it to both
  // `baseAt` and `caveAt`, which halves the region lookups (each one costs the molten density test plus a
  // dither hash). Omitted, it is looked up here, so the function still works standalone.
  const baseAt = (c, rr, s, sB, crust, bi) => {
    if (rr > bottomRow) return 0;
    // ⚠️ EARLY OUT FOR SKY, and it is worth more than it looks. `surfDisp` is two noise reads and the branch
    // below ran it for EVERY row above the surface, i.e. for the ~1,000 rows of empty sky in an Overworld
    // column. The displacement is bounded by +-OVH, so anything above `s - OVH` is certainly air.
    if (rr < s - OVH) return 0;
    if (rr < s + OVH_BAND) {                                  // the surface band: cliffs and overhangs live here
      const sEff = s + surfDisp(c, rr, s);
      if (rr < sEff) return 0;
      if (rr < sEff + crust) return crustMatAt(c, rr, s);
    } else if (rr < s) return 0;
    if (rr < s + crust) return crustMatAt(c, rr, s);
    const k = bi === undefined ? regionPick(c, rr, s) : bi;
    const B = BIOMES[k];
    // ⚠️ Keyed on the biome INDEX, not on `at[0] * 97`. That expression was FRACTIONAL, and a fractional salt is
    // silently truncated inside `h` (`a ^ salt` coerces to int32) — so the spacing between two biomes' patch
    // fields was neither what it looked like nor under anyone's control.
    if (B.patch && fbm2(seed, SALT.PATCH + k * SALT.PATCH_STEP, c * B.patch.freq / G, rr * B.patch.freq / G, 2) > B.patch.t) return B.patch.mat;
    return B.mat;
  };

  // ---- caves: two ridged tunnel fields plus a chamber field ---------------------------------------------------
  //  SPAGHETTI  abs(2*fBm-1) < w      — ridged noise. Zero along a crease => a winding line => a tunnel.
  //  CHEESE     fBm > t               — plain noise thresholded high => large open chambers.
  //  Air if any fires. Per-biome thresholds are what make each region's caves LOOK different without changing a
  //  single material.
  //  🟥 TUNNELS USED TO STOP DEAD AT EVERY BIOME BOUNDARY, and that is why the world felt disconnected: the noise
  //  salt was `SPAG + biome`, so each biome had its OWN, UNRELATED tunnel network. ⭐ There is now ONE global
  //  tunnel field and one global chamber field at fixed frequencies; a biome only changes the THRESHOLDS. A
  //  tunnel runs continuously across the whole world and merely gets roomier or tighter as it passes through.
  //  ⭐ And there are TWO tunnel fields at different scales, so the networks CROSS and every crossing is a
  //  junction. Connectivity comes from intersecting two networks, not from making one network fatter.
  //  ⭐ CONNECTIVITY IS A PERCOLATION TRANSITION, NOT A DIAL (measured, `worldgen_passability.js`): below a
  //  width threshold the underground is isolated pockets, above it one system, and crossing it costs roughly a
  //  DOUBLING of carved volume (24% -> 40% air, which looks like swiss cheese). We sit deliberately below it.
  //  🟥 AND WE DO NOT TRY TO CROSS IT. Two attempts at a dedicated vertical passage have now been rejected — an
  //  anisotropic noise field (a curtain of near-vertical slots across the whole world) and a lattice-anchored
  //  shaft (unnatural, and a second mechanism papering over a fault in the first: the caves were already
  //  running up to the ground and an entrance fade was pinching them shut, see CAVE MOUTHS). Both are deleted
  //  rather than left switched off, because dead code that describes itself as the right idea is a trap.
  //  ⭐ The answer the user gave instead: **terrain is destructible, so "unreachable" means "you have to mine",
  //  and not everything should be reachable.** The way in is a real cave mouth, and beyond that a pickaxe.
  const SPF = 0.028 / G, SP2F = 0.015 / G, CHF = 0.030 / G;
  const caveAt = (c, rr, top, s, fade, bi) => {
    const B = BIOMES[bi === undefined ? regionPick(c, rr, s) : bi];
    const cv = B.caves, boost = B.caveBoost || 1;
    let x = c, y = rr;
    if (WARP) {                                               // domain warping: look the noise up somewhere else
      x += (fbm2(seed, SALT.WARPX, c * 0.010 / G, rr * 0.010 / G, 2) - 0.5) * WARP * G;
      y += (fbm2(seed, SALT.WARPY, c * 0.010 / G, rr * 0.010 / G, 2) - 0.5) * WARP * G;
    }
    const depth = (rr - top) / Math.max(1, bottomRow - top);
    // ⚠️ `fade` is now always 1 from `solidAt` — the entrance fade is gone (see CAVE MOUTHS). The parameter is
    // kept because the sweep harnesses drive it, and because a future "this biome's tunnels taper" would use it.
    const f = fade == null ? 1 : fade;
    // ⭐ WIDTH IS MODULATED, not uniform. A single width makes every tunnel the same size, and raising it to get
    // the occasional big cavern makes EVERY cavern big. The field is a slow 2D one cubed, so it sits low almost
    // everywhere and only rarely swings high: most of the world is tight passages, and the wide galleries are
    // the exception they should be.
    const wm = wmAt(c, rr);
    const g = boost * f * CMUL * wm * (1 + depth * 0.35);
    if (Math.abs(2 * fbm2(seed, SALT.SPAG, x * SPF, y * SPF, 2) - 1) < cv.w * g) return true;
    if (Math.abs(2 * fbm2(seed, SALT.SPAG2, x * SP2F, y * SP2F, 2) - 1) < cv.w2 * g) return true;
    // ⚠️ `boost` moves the chamber threshold ADDITIVELY. Dividing by it (the first version) took t from 0.70 to
    // 0.50 for a 1.4x boost, which is 25% of cells rather than 8% — a lever four times stronger than intended.
    return fbm2(seed, SALT.CHEESE, x * CHF, y * CHF, 3) > cv.t + 0.04 - (wm - 1) * 0.10 - (boost - 1) * 0.06 - depth * 0.05 + (1 - f) * 0.12;
  };

  // ---- pools: a purely LOCAL rule, which is what makes them chunk-independent ---------------------------------
  // A cell is fluid when the first solid at or below it is within `depth` rows. generateWorld instead walks each
  // column up from the world floor, which a 64-row chunk cannot do.
  // 🟥 BUT THAT RULE ALONE DOES NOT MAKE POOLS — applied to a whole region it fills every winding tunnel, and the
  // first picture came out as a NET OF COLOURED WIRES tracing every cave in the world. A pool needs a place wide
  // enough to be a pool, so there is a second, UPWARD test: the ceiling must be at least HEAD rows above. Thin
  // tunnels stay dry; chambers flood their floors. Still a bounded peek, so still chunk-local.
  // ⚠️ There is no water TABLE any more. It existed to stop a whole horizontal band flooding uniformly; with the
  // bands gone, a wet biome is itself a localised blob decided by the `wet` climate axis, so the spatial
  // structure comes from the region map.
  const poolCfgAt = (c, rr, s) => {
    const B = BIOMES[regionPick(c, rr, s)];
    if (!B.wet) return null;
    const w = (wave1(seed, SALT.WET, c * 0.004 / G + wOff) + 1) * 0.5;
    if (w >= B.wet) return null;
    return { fluid: B.fluid, depth: Math.round(POOL_DEPTH * (B.poolMul || 1)) };
  };

  // ---- surface rock mounds: the lattice template, kept ---------------------------------------------------------
  // Small, but it matters out of proportion to its size: it is the TEMPLATE for everything the world will later
  // scatter, and the only rule that writes into a column it does not own.
  const moundStep = Math.max(1, Math.round(6 * G));
  const moundLo = Math.max(8, genC0), moundHi = Math.min(cols - 8, genC1);
  const isAnchor = (a) => a >= moundLo && a < moundHi && (a - moundLo) % moundStep === 0;
  const moundOn = (a) => h(seed, SALT.MOUND_ON, a, 0) <= 0.10 && surfAt(a) <= seaRow;
  const moundHgt = (a) => (1 + ((h(seed, SALT.MOUND_H, a, 0) * 2) | 0)) * G;
  const moundAt = (c, rr, s) => {
    const k = s - 1 - rr; if (k < 0) return false;
    if (isAnchor(c) && k < moundHgt(c) && moundOn(c)) return true;
    const a = c - 1;
    return isAnchor(a) && k < moundHgt(a) && h(seed, SALT.MOUND_N, a, k) > 0.5 && moundOn(a);
  };

  // ============================================================================================================
  //  THE THREE DEPTH BANDS — the one HARD INTERFACE this redesign has to meet.
  //
  //  `server/domains.js` places a site in one of three bands: `sky` (rows 4%-33% of the world), `surface`
  //  (34%-66%) and `underground` (67%-97%). Three bands is three times the room at the same width, and it is
  //  what keeps sites within walking distance of each other instead of stretching the world sideways until
  //  neighbours stop meaning anything. Placement was built FIRST, on purpose, so the generator had a shape to
  //  aim at — and until now a site placed off the surface found NO GROUND AT ALL in its band.
  //
  //  ⭐ BOTH FEATURES ARE ON A LATTICE WITH A BOUNDED REACH, which is the pattern the volcano cones and the rock
  //  mounds already use and the only pattern that survives chunk-on-demand: a column asks "which anchors within
  //  my reach exist, and how far do they extend into me?" and answers alone, in O(1).
  //
  //  ⭐ AND ONE CANDIDATE PER LATTICE CELL IS REAL — Minecraft's spacing/separation rule, not a coin flip per
  //  anchor. A coin flip gives an EXPECTED density and no guarantee, so a site could be placed in a band with
  //  nothing within a day's walk. Guaranteeing one per lattice cell puts a hard bound on how far placement (or
  //  a player) has to walk to find its band's ground. Variety comes from SIZE and POSITION, both hashed.
  // ============================================================================================================
  // ---- SKY: floating islands. Also the answer to "there is a lot of empty sky", which is ~a third of the world.
  const ISLE_STEP = Math.max(8, Math.round(160 * G));         // one island per ~480 columns (3,840 px, ~2.5 screens)
  const ISLE_HW = Math.round(40 * G);                         // biggest half-width
  const SKY_LO = Math.round(rows * 0.06);
  const isleAnchorAt = (a) => {
    if (a < ISLE_HW || a > cols - 1 - ISLE_HW) return null;   // needs room for its own width
    const u = h(seed, SALT.ISLE_SHAPE, a, 1);
    const hw = Math.max(6, Math.round((0.35 + 0.65 * u) * ISLE_HW));
    const top = Math.round((3 + 5 * h(seed, SALT.ISLE_SHAPE, a, 2)) * G);
    const bot = Math.round(top * 2.2);
    // Below the top of the world, and clear of whatever ground is under it. A tall mountain squeezes the
    // available sky, so a candidate that cannot fit simply does not exist here — but with SKY_LO at 6% of the
    // world and the surface at ~47%, that is rare rather than routine.
    const hi = Math.min(Math.round(rows * 0.30), surfAt(a) - bot - Math.round(10 * G));
    if (hi <= SKY_LO + top) return null;
    const cy = SKY_LO + top + Math.round(h(seed, SALT.ISLE_ON, a, 3) * (hi - SKY_LO - top));
    // The anchor's OWN surface biome decides the skin, so an island is one place rather than a stripe of three.
    const sb = surfBiomeAt(a);
    return { a, hw, top, bot, cy, skin: Math.round(3 * G), mat: SURFACE[sb].mat };
  };
  // The rows an island occupies IN THIS COLUMN. A lens: a shallow dome on top and a longer keel below, which is
  // what makes it read as a floating island rather than as a floating pill.
  // 🟥 AND THEN ROUGHENED, BECAUSE THE FIRST RENDER LOOKED LIKE FLYING SAUCERS. A lens is an analytic shape, and
  // an analytic shape drawn at full size reads as maths — the same objection that killed the terracing, the
  // triangular peaks, the dune ripple and the wavy-line molten boundary on this track. Each edge is scaled by
  // its own 1D noise along the column, salted per anchor, so the silhouette is ragged and the two edges are
  // ragged independently. Two noise reads per column of island, not per cell.
  const ISLE_ROUGH = 0.42;
  function isleSpanAt(c) {
    const near = Math.round(c / ISLE_STEP), reach = Math.ceil(ISLE_HW / ISLE_STEP) + 1;
    let out = null;
    for (let k = -reach; k <= reach; k++) {
      const I = isleAnchorAt((near + k) * ISLE_STEP); if (!I) continue;
      const dx = Math.abs(c - I.a); if (dx >= I.hw) continue;
      const q = 1 - (dx / I.hw) * (dx / I.hw), kk = Math.sqrt(q);
      const nT = 1 + wave1(seed, SALT.ISLE_SHAPE + 4, (c + I.a) * 0.085 / G) * ISLE_ROUGH;
      const nB = 1 + wave1(seed, SALT.ISLE_MAT, (c - I.a * 3) * 0.055 / G) * ISLE_ROUGH;
      const r0 = I.cy - Math.round(I.top * kk * nT), r1 = I.cy + Math.round(I.bot * q * nB);
      if (r1 < r0) continue;
      (out || (out = [])).push({ r0, r1, skin: I.skin, mat: I.mat });
    }
    return out;
  }
  // ---- UNDERGROUND: deep halls. Big open chambers, guaranteed, in the deep band.
  // ⚠️ DELIBERATELY DRY — the pool rule is suppressed inside one. Ordinary cheese chambers still flood, and that
  // is most of them; these are the placed, habitable ones, and a site whose spawn lands in a lava lake is not a
  // site. It also gives the band its own identity: the big halls are the ones that are not full of something.
  const HALL_STEP = Math.max(8, Math.round(120 * G));         // one hall per ~360 columns (2,880 px)
  const HALL_HW = Math.round(30 * G), HALL_HH = Math.round(10 * G);
  const UG_LO = Math.round(rows * 0.67), UG_HI = Math.round(rows * 0.97);
  const hallAnchorAt = (a) => {
    if (a < HALL_HW || a > cols - 1 - HALL_HW) return null;
    const hw = Math.max(6, Math.round((0.5 + 0.5 * h(seed, SALT.HALL_SHAPE, a, 1)) * HALL_HW));
    const hh = Math.max(4, Math.round((0.5 + 0.5 * h(seed, SALT.HALL_SHAPE, a, 2)) * HALL_HH));
    // Inside the deep band, and never through the bedrock floor or up into the crust.
    const lo = Math.max(UG_LO, surfAt(a) + Math.round(30 * G)) + hh;
    const hi = Math.min(UG_HI, bottomRow - Math.round(3 * G)) - hh;
    if (hi <= lo) return null;
    return { a, hw, hh, cy: lo + Math.round(h(seed, SALT.HALL_ON, a, 3) * (hi - lo)) };
  };
  function hallSpanAt(c) {
    const near = Math.round(c / HALL_STEP), reach = Math.ceil(HALL_HW / HALL_STEP) + 1;
    let out = null;
    for (let k = -reach; k <= reach; k++) {
      const H = hallAnchorAt((near + k) * HALL_STEP); if (!H) continue;
      const dx = Math.abs(c - H.a); if (dx >= H.hw) continue;
      // Roughened for the same reason the islands are: a clean ellipse in the middle of a noise-carved cave
      // system reads as a bubble somebody stamped there. Top and bottom are perturbed independently.
      const b = H.hh * Math.sqrt(1 - (dx / H.hw) * (dx / H.hw));
      const eT = Math.round(b * (1 + wave1(seed, SALT.HALL_SHAPE + 4, (c + H.a) * 0.075 / G) * 0.40));
      const eB = Math.round(b * (1 + wave1(seed, SALT.HALL_SHAPE + 5, (c - H.a * 3) * 0.065 / G) * 0.40));
      if (eT + eB < 2) continue;
      (out || (out = [])).push({ r0: H.cy - eT, r1: H.cy + eB });
    }
    return out;
  }
  // 🟥 LATTICE-ANCHORED SHAFTS WERE BUILT HERE AND REMOVED (user, 2026-08-05): *"the wandering vertical shafts
  // are not really good, in that they seem unnatural, and moreover, I think that the reason that the underground
  // seemed unreachable might be because in general basically all of the tunnels seem to stop before breaking
  // through to the surface, so it probably makes more sense to fix that than to add specific tunnels."*
  // They were right, and the diagnosis is the important part: a shaft is a SECOND mechanism papering over a
  // fault in the FIRST one. The caves already ran up to the ground — they were being pinched shut by an
  // entrance fade a few rows before they got there, so the world had a lid on it and the fix was to take the
  // lid off, not to drill through it. See `carveTop` / `CAVE_MOUTHS` below.
  // ⭐ The two things worth keeping from the attempt are written down rather than in code:
  //   · connectivity cannot be bought by WIDENING — cave width x1.25 carves 2.8x the air to move an Overworld
  //     domain from 2% to 8.9% reachable, i.e. swiss cheese that still fails;
  //   · and it does not have to be bought at all. **Terrain is destructible, so "unreachable" means "you have
  //     to mine", and not everything should be reachable** (user, same message).

  const inSpan = (spans, rr) => { if (!spans) return false; for (let i = 0; i < spans.length; i++) if (rr >= spans[i].r0 && rr <= spans[i].r1) return true; return false; };
  const isleMatAt = (spans, rr) => {
    if (!spans) return 0;
    for (let i = 0; i < spans.length; i++) { const q = spans[i];
      if (rr >= q.r0 && rr <= q.r1) return rr < q.r0 + q.skin ? q.mat : MAT.STONE; }
    return 0;
  };

  // ---- the per-column pieces the fill loops share -------------------------------------------------------------
  // ⭐⭐ CAVE MOUTHS — THE THING THAT MAKES THE UNDERGROUND REACHABLE, AND IT IS A DELETION.
  //
  // History, because the shape of the mistake matters. First the caves started strictly BELOW the crust, so
  // every tunnel that ran up to the ground was sealed under a lid of earth and there was no way in at all
  // (this is still what the legacy `generateWorld` does, and is exactly what the user described seeing).
  // Then they were allowed to carve from the surface down, but with the threshold FADED to 0.70 over the top
  // ~66 rows so that "only a strong tunnel actually breaks out". A ridged tunnel's width is proportional to
  // its threshold, so a fade does not select strong tunnels — **it narrows every tunnel to nothing exactly
  // where it would have opened.** The lid was still there, drawn differently. I then built lattice shafts to
  // drill through the lid I had left in place.
  //
  // ⇒ THE FADE IS GONE. On land that is safely above sea level a tunnel keeps its full width right up to the
  // surface and opens where it opens.
  //
  // ⚠️ THE ONE RULE THAT STAYS, AND WHY IT IS AN ELEVATION MARGIN RATHER THAN "NOT UNDERWATER": an opening
  // below or near the waterline would let the sea pour in and drain, and whether a given cave drains is a
  // GLOBAL question (which cave connects to which) that a chunk cannot answer alone. So the whole question is
  // avoided rather than answered — a column only gets mouths if its ground stands SHORE rows clear of sea
  // level, which also keeps mouths off beaches, where a storm surge of a lake would find them.
  // Below that, carving still starts under the crust, so coastlines and seabeds keep their lid.
  //
  // 🟥 AND DELETING THE FADE WAS NOT ENOUGH — MEASURED, WHICH IS THE ONLY REASON I FOUND OUT. With the fade
  // gone, a page world still had **one 2-column mouth** in it (seed 19), because the width profile narrows
  // toward the surface for two independent reasons that had nothing to do with the fade:
  //   · `g` carries `(1 + depth * 0.35)`, so a tunnel at the surface is 26% narrower than the same tunnel at
  //     the floor — caves are *designed* to open out with depth;
  //   · the width-modulation field is a cube, so it sits near its floor (~0.52) almost everywhere.
  // A tunnel two cells wide is not a mouth: the player is five cells.
  // ⭐ So the entrance band gets a FLARE — the exact opposite of the fade, and the physically right one, since
  // weathering widens a cave mouth rather than pinching it. Full strength at the ground line, tapering to
  // nothing by `entr` rows down, so it makes doorways without hollowing the crust.
  const MOUTH_GAIN = 2.2;
  const SHORE = Math.round(4 * G);
  const colInfo = (c) => {
    const s = surfAt(c), sB = sbAt(c), crust = crustDepthAt(c, s);
    const drySurface = s <= seaRow;
    const openable = s <= seaRow - SHORE;
    // 🟥 `s + crust + 1` IS NOT "BELOW THE CRUST", and C10 caught it. In the overhang band the ground starts at
    // `s + surfDisp`, which can be OVH rows LOWER than `s` — so the crust sits lower too, and carving from
    // `s + crust + 1` cuts straight through it. On a seabed that is a hole in the ocean floor. The seal has to
    // clear the deepest the displaced crust can reach, which is `s + OVH + crust`.
    return { s, sB, crust, top: s + crust + 1, vent: volcVentAt(c), drySurface, openable,
      carveTop: openable ? s + 1 : s + OVH + crust + 1, entr: crust + Math.round(10 * G),
      isle: isleSpanAt(c), hall: hallSpanAt(c) };
  };
  // The solid (post-carve) material at one cell of a column whose per-column values are already in hand.
  // ⚠️ The region is looked up ONCE here and handed to both `baseAt` and `caveAt`. They used to look it up
  // independently, which doubled the molten density test and the boundary dither on every solid cell.
  const solidAt = (c, rr, ci) => {
    const s = ci.s;
    if (rr < 0 || rr > bottomRow) return 0;
    // ⭐⭐ THE WORLD'S FLOOR IS REAL GROUND NOW, and this is a fix rather than decoration.
    // "Bedrock" in this codebase was never a material: it is a RULE (`LIQUID_FLOOR_ROW` — liquid may not descend
    // past it) plus a band the client DRAWS from `FLOOR_TOP` downward. The generator's deepest row sits one row
    // above that band, so the bottom of the world was open ground held up by a rule — and the pool rule treats
    // "past the bottom of the world" as solid, so it filled that row wherever the biome was wet.
    // 🟥 MEASURED on seed 42: 626 of 1920 columns had LAVA in the very bottom row. That is a world-spanning
    // sheet at slightly different heights, and this sim is recorded as taking >100s to level a HALF-SCREEN
    // spill — so it never settles, stays permanently active, and everything else queues behind it.
    // ⚠️ Returned BEFORE anything can carve or flood it: caves, the volcano conduit, deep halls and the pool
    // rule all run below this line, and any one of them punching through the floor puts the hole back.
    if (rr >= bedrockTop) return MAT.STONE;
    // A floating island is the one thing that exists ABOVE the ground line, so it is tested before the sky
    // early-out — and before the sea fill, so an island in a low-lying stretch stands proud of the water
    // rather than being submerged by it.
    if (ci.isle && rr < s) { const iv = isleMatAt(ci.isle, rr); if (iv) return iv; }
    if (rr < s - OVH) return 0;                              // sky — nothing below can reach up here
    const bi = (rr >= s + ci.crust) ? regionPick(c, rr, s) : undefined;
    let v = baseAt(c, rr, s, ci.sB, ci.crust, bi);
    // The entrance FLARE — see CAVE MOUTHS above. > 1 near the ground line on land that may open, 1 elsewhere.
    const d = rr - s;
    const flare = (!ci.openable || d >= ci.entr) ? 1 : 1 + (MOUTH_GAIN - 1) * (1 - Math.max(0, d) / ci.entr);
    if (v && rr >= ci.carveTop && caveAt(c, rr, ci.top, s, flare, bi)) v = 0;
    if (ci.vent && rr >= s + 2) v = MAT.LAVA;                // the volcano conduit, straight through everything
    if (v && ci.hall && rr > ci.top && inSpan(ci.hall, rr)) v = 0;   // a deep hall is carved out of everything
    return v;
  };

  // ---- the fast form: one column of a page at a time ------------------------------------------------------------
  // The scratch column carries overlap at BOTH ends — POOL_MAX rows below (to find the floor) and HEAD rows above
  // (to find the ceiling) — so both pool probes are byte reads rather than re-evaluations of the cave field,
  // which measured 32x the random draw. Local index j corresponds to world row r0 - HEAD + j.
  let _scratch = new Uint8Array(CHUNK_SIDE + 2 * (POOL_MAX + HEAD) + 8);
  function fillColumn(c, r0, rN, out) {
    if (c < genC0 || c > genC1) { out.fill(0, 0, rN); return; }
    const ci = colInfo(c);
    const SPAN = HEAD + rN + POOL_MAX + 1;
    if (_scratch.length < SPAN) _scratch = new Uint8Array(SPAN + 8);
    const scratch = _scratch;
    // ⚠️ THE DOWNWARD OVERLAP IS FILLED LAZILY, AND IT IS WORTH 30% OF THE WHOLE GENERATOR. The pool rule may
    // probe up to POOL_MAX rows below the page, so the eager version generated 104 rows to emit 64 — a 63%
    // surcharge on every column in the world, paid so that the few air cells at the very bottom of the page
    // could look for a floor. Most columns never probe at all (solid rock, or sky). `have` is the watermark of
    // what has been computed; `at(j)` extends it on demand and is the ONLY reader below the page.
    let have = HEAD + rN;
    for (let k = 0; k < have; k++) scratch[k] = solidAt(c, r0 - HEAD + k, ci);
    const at = (j) => { while (have <= j) { scratch[have] = solidAt(c, r0 - HEAD + have, ci); have++; } return scratch[j]; };
    const s = ci.s, lake = s > seaRow;
    for (let lr = 0; lr < rN; lr++) {
      const rr = r0 + lr, j = HEAD + lr;
      let v = scratch[j];
      if (!v) {
        // ⭐ ARCTIC ICE SHEET: in cold country the sea has a lid on it rather than an open surface, so you can
        // walk out over it — and, since ice is a breakable solid here, fall through it.
        if (lake && rr >= seaRow && rr < s) v = (ci.sB === SB.SNOW && rr < seaRow + ICE_SHEET) ? MAT.ICE : MAT.WATER;
        else if (rr > ci.top) {
          let head = true;
          for (let k = 1; k <= HEAD; k++) if (scratch[j - k]) { head = false; break; }
          if (head && !inSpan(ci.hall, rr)) {                 // deep halls stay dry — see the depth-band block
            const fl = poolCfgAt(c, rr, s);
            if (fl) for (let k = 1; k <= fl.depth; k++) { if (rr + k > bottomRow || at(j + k)) { v = fl.fluid; break; } }
          }
        }
        if (!v && rr < s && moundAt(c, rr, s)) v = MAT.STONE;
      }
      out[lr] = v;
    }
  }

  // ---- the readable, slow, one-cell-at-a-time form -------------------------------------------------------------
  // Not used by fillPage — it re-derives everything for every cell. It exists because it is the OBVIOUS
  // implementation, and Part A asserts the fast path agrees with it cell for cell across a whole world. A fast
  // path with no slow twin to check it against is a fast path nobody can prove.
  function matAt(c, rr) {
    if (c < genC0 || c > genC1 || c < 0 || c >= cols || rr < 0 || rr >= rows) return 0;
    const ci = colInfo(c), s = ci.s;
    const v = solidAt(c, rr, ci); if (v) return v;
    if (s > seaRow && rr >= seaRow && rr < s) return (ci.sB === SB.SNOW && rr < seaRow + ICE_SHEET) ? MAT.ICE : MAT.WATER;
    if (rr > ci.top) {
      let head = true;
      for (let k = 1; k <= HEAD; k++) if (solidAt(c, rr - k, ci)) { head = false; break; }
      if (head && !inSpan(ci.hall, rr)) {
        const fl = poolCfgAt(c, rr, s);
        if (fl) for (let k = 1; k <= fl.depth; k++) { if (rr + k > bottomRow || solidAt(c, rr + k, ci)) return fl.fluid; }
      }
    }
    if (rr < s && moundAt(c, rr, s)) return MAT.STONE;
    return 0;
  }

  // ---- one 64x64 page ------------------------------------------------------------------------------------------
  // `page` may be strided (T values per cell); `hpPage` may be null.
  let _colBuf = new Uint8Array(CHUNK_SIDE);
  function fillPage(page, hpPage, p, geom, T) {
    const stride = (T | 0) || 1;
    // Chunks are numbered down-then-across (page = chunkCol * cy + chunkRow) — see chunkGeom, increment 5.
    const c0 = ((p / geom.cy) | 0) * CHUNK_SIDE, r0 = (p % geom.cy) * CHUNK_SIDE;
    const rN = Math.min(CHUNK_SIDE, geom.rows - r0), cN = Math.min(CHUNK_SIDE, geom.cols - c0);
    if (rN <= 0 || cN <= 0) return;
    const col = _colBuf;
    for (let lc = 0; lc < cN; lc++) {
      const c = c0 + lc;
      if (c < genC0 || c > genC1) continue;
      fillColumn(c, r0, rN, col);
      for (let lr = 0; lr < rN; lr++) {
        const v = col[lr];
        if (v) { const o = lr * CHUNK_SIDE + lc; page[o * stride] = v; if (hpPage) hpPage[o] = strengthOf(v); }
      }
    }
  }

  // ⭐ "IS THIS PAGE PROVABLY EMPTY?" — asked BEFORE a page is allocated, so open sky costs nothing at all.
  // Half a page world and much more of a tall Overworld is sky; without this, reading one cell of it would fault
  // in 4KB of zeros and undo increment 2's sparse storage from the other direction.
  // ⚠️ DELIBERATELY CONSERVATIVE — it may only ever answer "empty" when that is certain, because a false "empty"
  // is INVISIBLE TERRAIN. Everything that can put content above the plain ground line is allowed for here, and
  // adding a feature that reaches higher without updating this is the way to break it:
  //   · the overhang band displaces the surface UP by up to OVH rows,
  //   · rock mounds stack up to 2*G rows above the surface,
  //   · surface lakes fill DOWN FROM seaRow,
  //   · 🟥 FLOATING ISLANDS, which sit in what used to be provably-empty sky. Adding a feature that reaches
  //     higher than the ground line WITHOUT updating this function is how you get invisible solid terrain: the
  //     page is never allocated, so the island is never stored, and the client renders air the player collides
  //     with. Islands are on a bounded lattice, so the test is exact rather than conservative.
  function pageEmpty(p, geom) {
    const c0 = ((p / geom.cy) | 0) * CHUNK_SIDE, r0 = (p % geom.cy) * CHUNK_SIDE;
    const rN = Math.min(CHUNK_SIDE, geom.rows - r0), cN = Math.min(CHUNK_SIDE, geom.cols - c0);
    if (rN <= 0 || cN <= 0) return true;
    if (r0 > bottomRow) return true;                       // below the bedrock floor — nothing is generated there
    if (c0 > genC1 || c0 + cN - 1 < genC0) return true;    // outside the generated column band
    const r1 = r0 + rN - 1, lift = Math.max(OVH, Math.round(2 * G)) + 1;
    let top = Infinity;
    for (let lc = 0; lc < cN; lc++) {
      const c = c0 + lc; if (c < genC0 || c > genC1) continue;
      const s = surfAt(c);
      const t = Math.min(s - lift, s > seaRow ? seaRow : Infinity);
      if (t < top) top = t;
      const isle = isleSpanAt(c);
      if (isle) for (let i = 0; i < isle.length; i++) if (isle[i].r1 >= r0 && isle[i].r0 <= r1) return false;
    }
    return r1 < top;                                       // the whole page sits above anything that could exist
  }

  // ⭐ THE QUERY DOMAIN PLACEMENT ACTUALLY ASKS: "at this column, where in this row range can somebody stand?"
  // Returns the row of the first cell you could land on with `clear` rows of clear air above it, or -1.
  // ⚠️ It exists so the spawn seam asks the GENERATOR rather than scanning the stored grid: an Overworld's grid
  // is mostly not produced, and scanning it would either read air (wrong) or fault in the whole column (worse).
  // Bounded by construction — it walks at most (r1 - r0) rows of ONE column and produces nothing.
  // 🟥 IT READS THE FINISHED COLUMN, NOT THE PRE-POOL GROUND. The first version called `solidAt`, which is the
  // world BEFORE liquid is placed — so it happily reported the floor of a lava lake as somewhere to stand, and
  // counted the water above a lake bed as headroom. `fillColumn` is the world as it actually ships.
  function bandGroundAt(c, r0, r1, clear) {
    if (c < genC0 || c > genC1) return -1;
    const need = clear == null ? 5 : clear;                // 5 cells = the 40x40px player blob, exactly
    const lo = Math.max(0, r0 | 0), hi = Math.min(bottomRow, r1 | 0);
    const n = hi - lo + 1; if (n <= 0) return -1;
    const buf = new Uint8Array(n);
    fillColumn(c, lo, n, buf);
    let air = 0;
    for (let k = 0; k < n; k++) {
      const v = buf[k];
      if (!v) { air++; continue; }
      if (!isFluid(v) && air >= need) return lo + k;        // solid floor, clear space above
      air = 0;                                             // liquid is neither a floor nor headroom
    }
    return -1;
  }

  // Biome index at a cell, for the region-view picture. -1 above ground, -2..-7 for the six surface biomes.
  function regionAt(c, rr) {
    const s = surfAt(c); if (rr < s) return -1;
    const crust = crustDepthAt(c, s);
    if (rr < s + crust) return -2 - sbAt(c);
    return regionPick(c, rr, s);                           // dithered, so the picture shows what ships
  }

  return {
    cols, rows, cell: CELL, seed, G, bottomRow, baseRow, seaRow, genC0, genC1, picks, recipe,
    POOL_DEPTH, POOL_MAX, HEAD, ICE_SHEET, snowLine, iceLine, BIOMES, SURFACE,
    surfAt, sbAt, sbRawAt, crustDepthAt, baseAt, caveAt, moundAt, poolCfgAt, volcVentAt,
    regionAt, regionPick, climAt, colInfo, solidAt, strengthOf,
    isleSpanAt, hallSpanAt, bandGroundAt, HALL_STEP, SHORE, OVH, OVH_BAND, MOUTH_GAIN,
    fillColumn, matAt, fillPage, pageEmpty,
  };
}

// ⭐ BUMP THIS WHENEVER THE GENERATOR'S OUTPUT CHANGES.
// Stored changes are kept as a DIFF against generated ground, so they are only meaningful alongside the
// generator that made them: change a cave threshold and every stored tunnel is suddenly cut through different
// rock. The version travels with each stored diff so a mismatch is DETECTABLE rather than silent.
// ⚠️ 1 -> 2: THE CONTENT REDESIGN (2026-08-04). Nothing about this world is the previous one — different
// surface, different caves, different regions, different materials. Every diff stored against version 1 is now
// correctly refused.
const WORLDGEN_VERSION = 2;

module.exports = { makeGen, recipeFor, mulberry32, h, vn1, vn2, fbm1, fbm2, wave1, wave2, ridge1, isFluid,
  SALT, MAT, SB, BIOMES, SURFACE, MOLTEN, CHUNK_SIDE, WORLDGEN_VERSION };
