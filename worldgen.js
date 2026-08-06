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
  POOL_ON: 320, POOL_SHAPE: 321,                    // anchored basins   320-329
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
// ⭐⭐ PERIODIC IN X. Every one of these takes a trailing `per` — the number of lattice cells after which the
// x axis wraps — so the field is sampled on a CIRCLE rather than a line and repeats seamlessly at that period.
// The world is narrower than one period (see PERIOD_COLS), so nothing reaches the join today; the point is that
// a horizontal world-wrap can be turned on LATER as a movement rule instead of a regeneration. Player edits are
// stored as diffs against generated ground, so changing the ground invalidates every one of them — which is
// what WORLDGEN_VERSION exists to detect, and what doing this now avoids.
// ⚠️ `per === 0` means "do not wrap" and is the escape hatch for the y axis and for tools, not a default.
// 🟥 THE WRAP GOES ON THE LATTICE CORNERS, NOT ON THE COLUMN. Folding the column (`c % P`) repeats perfectly and
// still leaves a HARD SEAM at the join, because the corner before the join and the corner after it are different
// hashes. Measured (probe_periodic_cost): step across the join 4.6e-1 folded vs 2.4e-4 wrapped, against an
// ordinary step of 1.1e-2. Wrapping the corners makes the join indistinguishable from anywhere else.
// ⚠️ The in-range test is a BRANCH, not a mask. A power-of-two period would let it be `& (per-1)` and measured
// ~3% cheaper, but a power-of-two period forces the FREQUENCY to a power of two over PERIOD_COLS, which moves
// the generator's tuned frequencies by up to 30%. The branch's frequencies move by at most 0.05%. The rig's
// run-to-run spread was wider than the gap between the two, so this is chosen on the drift, not on speed.
const wrapL = (i, per) => (i >= 0 && i < per) ? i : ((i % per) + per) % per;
function vn2(seed, salt, x, y, per) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = per ? wrapL(xi, per) : xi, x1 = per ? (x0 + 1 === per ? 0 : x0 + 1) : xi + 1;
  const a = h(seed, salt, x0, yi), b = h(seed, salt, x1, yi);
  const c = h(seed, salt, x0, yi + 1), d = h(seed, salt, x1, yi + 1);
  const top = a + (b - a) * u, bot = c + (d - c) * u;
  return top + (bot - top) * v;
}
function vn1(seed, salt, x, per) {
  const xi = Math.floor(x), xf = x - xi;
  const u = xf * xf * (3 - 2 * xf);
  const x0 = per ? wrapL(xi, per) : xi, x1 = per ? (x0 + 1 === per ? 0 : x0 + 1) : xi + 1;
  const a = h(seed, salt, x0, 0), b = h(seed, salt, x1, 0);
  return a + (b - a) * u;
}
// fBm — octaves at halving amplitude, doubling frequency. Big shapes with fine detail on them.
// ⚠️ Octave i samples at x*2^i, so ITS lattice period is per*2^i. Getting that wrong would make the low octave
// periodic and the high ones not, i.e. a field that is periodic in its shape and not in its detail.
function fbm2(seed, salt, x, y, oct, per) {
  let f = 1, amp = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * vn2(seed, salt + i * 7, x * f, y * f, per * f); norm += amp; f *= 2; amp *= 0.5; }
  return sum / norm;
}
function fbm1(seed, salt, x, oct, per) {
  let f = 1, amp = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * vn1(seed, salt + i * 7, x * f, per * f); norm += amp; f *= 2; amp *= 0.5; }
  return sum / norm;
}
// 🟥 A BIG SMOOTH SWING IS NOT WHAT fBm GIVES YOU, AND THIS COST FIVE SEPARATE ROUNDS ON THIS TRACK. Averaging
// octaves pulls the result towards its middle: a 3-octave fBm barely leaves 0.4..0.6. It silently flattened the
// layer boundaries at a +-39-row amplitude, stopped a cold world ever reaching its snow threshold, squashed the
// region field and made overhangs invisible. `wave1` keeps ONE DOMINANT OCTAVE (which spans the full range on
// its own) and adds a small second one for detail, so +-1 means +-1. Signed, -1..1.
// ⚠️ Its cousin, hit twice: a frequency so low that a whole small world sits inside ONE lattice cell.
// 🟥 THE DETAIL OCTAVES ARE AT 2.3x AND 2.7x, WHICH ARE NOT INTEGERS, AND THIS BROKE PERIODICITY IN EXACTLY THE
// WAY THE PROBE WARNS ABOUT ONE LEVEL UP. Rounding the octave's PERIOD to `round(per * 2.3)` while still scaling
// x by 2.3 means a step of one world period moves x by `per * 2.3` lattice cells — a fractional number — so the
// detail octave does not land back on the same corner and the field does not repeat. `probe_worldgen` B7 caught
// it as 204 of 1,920 cells differing a period along; nothing else would have.
// ⇒ The MULTIPLIER is derived back from the rounded period, exactly as the frequency is derived back from the
// rounded lattice period in `nfreq`. Same mistake, same fix, one level down. The multiplier moves by <1e-6.
// ⚠️ `per === 0` means "not wrapped" (tools, y-only callers), and then the literal multipliers stand.
function wave1(seed, salt, x, per) {
  const p2 = per ? Math.round(per * 2.3) : 0, m2 = per ? p2 / per : 2.3;
  return (vn1(seed, salt, x, per) * 2 - 1) * 0.78 + (vn1(seed, salt + 7, x * m2, p2) * 2 - 1) * 0.22;
}
function wave2(seed, salt, x, y, per) {
  const p2 = per ? Math.round(per * 2.7) : 0, m2 = per ? p2 / per : 2.7;
  return (vn2(seed, salt, x, y, per) * 2 - 1) * 0.72 + (vn2(seed, salt + 7, x * m2, y * 2.7, p2) * 2 - 1) * 0.28;
}
// ⭐ RIDGED fBm — several octaves of `1 - |noise|`, each squared to sharpen the crease. One octave of this is a
// TENT (and cubing a tent gives the sharp triangular peaks the user rejected); several octaves give a ridgeline
// with shoulders and spurs. Returns 0..1, near 1 along a ridge.
function ridge1(seed, salt, x, oct, per) {
  let f = 1, amp = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const v = 1 - Math.abs(vn1(seed, salt + i * 7, x * f, per * f) * 2 - 1);
    sum += amp * v * v; norm += amp; f *= 2.0; amp *= 0.40;   // ⚠️ gain 0.52 put ~50-row teeth every 22 columns
  }
  return sum / norm;
}
// ==============================================================================================================
//  THE PERIOD.  524,288 columns = 4,194,304 px.
//  ⭐ THIS IS NOT A CHOICE, IT IS THE CEILING. Increment 6 measured the widest world the flat cell index allows
//  at 4,096 rows and declared it: 524,224 columns. 2^19 is the next power of two up, so the terrain's repeat sits
//  just past the widest world that can currently exist — unreachable, and therefore invisible, until the index is
//  widened past 2^31 (which is on the agenda). A field periodic at P is automatically periodic at 2P, 4P, 8P, so
//  widening later opens a menu of wrap circumferences rather than closing one off.
//
//  ⭐ THE FREQUENCY IS WHAT GETS QUANTISED, NOT THE PERIOD, and getting that backwards is a silent failure.
//  For a field to repeat at P the lattice period `q * P` must be a whole number of lattice cells. Rounding the
//  PERIOD and keeping the frequency gives a field periodic at `round(q*P)/q` — a different number — and the
//  probe measured |f(c) - f(c+P)| = 0.49 on a 0..1 field, i.e. no periodicity whatsoever, from code that looked
//  right. So: round the period, then DERIVE the frequency back from it, and sample at that.
//  Worst drift over every frequency in this generator: 0.05%, at the very lowest one. Nothing else exceeds 0.02%.
// ==============================================================================================================
const PERIOD_COLS = 1 << 19;
// `want` is a per-COLUMN frequency. Returns the lattice period and the frequency to actually sample at.
// ⚠️ Callers must use `.q` and never the literal they asked for — that is the entire mechanism.
function nfreq(want) {
  const p = Math.max(1, Math.round(Math.abs(want) * PERIOD_COLS));
  return { p, q: (want < 0 ? -p : p) / PERIOD_COLS };
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
  { key: 'acid',     name: 'Acid Wastes',    at: [0.64, 0.56, 0.88], mat: MAT.STONE, patch: null, fluid: MAT.ACID, wet: 0.80, poolMul: 1.8,
    caves: { w: 0.056, w2: 0.044, t: 0.72 }, climateBias: -0.3 },
  { key: 'deepice',  name: 'Deep Ice',       at: [0.76, 0.06, 0.40], mat: MAT.ICE, patch: { mat: MAT.STONE, freq: 0.032, t: 0.58 }, fluid: MAT.BRINE, wet: 0.20,
    caves: { w: 0.05, w2: 0.038, t: 0.76 }, climateBias: 0.8 },
  // ⭐ GLASS IS NOT GENERATED — IT IS EARNED. Glassfields used to BE a glass patch; now it is the raw ingredients,
  // sand shot through with stone, sitting on lava. Lava fusing sand into glass is an existing reaction, so the
  // biome still becomes glassfields — but at runtime, in the shape the lava actually took, rather than in a shape
  // a noise field decided in advance. (Same reasoning that took generated MUD out: mud is a reaction product.)
  { key: 'glass',    name: 'Glassfields',    at: [0.80, 0.82, 0.24], mat: MAT.SAND, patch: { mat: MAT.STONE, freq: 0.036, t: 0.62 }, fluid: MAT.LAVA, wet: 0.30, poolMul: 1.6,
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
  // ══ PERIODICITY ═══════════════════════════════════════════════════════════════════════════════════════════
  // Every horizontal frequency in the generator, quantised so its field repeats EXACTLY at PERIOD_COLS. Named
  // and hoisted here rather than written inline, because the frequency and its lattice period have to agree and
  // a literal repeated at the call site is how they stop agreeing. Sample at `.q`, wrap at `.p` — never the
  // literal. (It also hoists ~20 divisions by G out of the per-cell loops, which is free.)
  // ⚠️ Y IS NOT WRAPPED and must not be. Rows are the world's DEPTH, which is fixed and has two ends (bedrock
  // below, vacuum above); only the x axis can ever be a circle. vn2 takes one period and applies it to x alone.
  const NQ = {
    SURFBIO: nfreq(0.0075 / G), ERO: nfreq(0.0016 * HS / G), CONT: nfreq(0.0011 * HS / G),
    MTN: nfreq(0.0075 * Math.sqrt(HS) / G), DET: nfreq(0.030 / G),
    HEAT: nfreq(0.0055 / G), WETF: nfreq(0.0070 / G), WET: nfreq(0.004 / G),
    VOLC: nfreq(0.0075 / G), CAVEW: nfreq(0.0045 / G), OVH: nfreq(0.024 / G), WARP: nfreq(0.010 / G),
    SPAG: nfreq(0.028 / G), SPAG2: nfreq(0.015 / G), CHEESE: nfreq(0.030 / G),
    ISLE_T: nfreq(0.085 / G), ISLE_B: nfreq(0.055 / G), HALL_T: nfreq(0.075 / G), HALL_B: nfreq(0.065 / G),
    POOL_B: nfreq(0.070 / G),
  };
  // Per-biome patch frequency — one per entry in BIOMES, memoised because it is read in the per-cell loop.
  const NQ_PATCH = BIOMES.map(B => B.patch ? nfreq(B.patch.freq / G) : null);
  // ⭐ THE ANCHOR LATTICES HAVE TO TILE THE PERIOD TOO, and this is the half that is easy to forget. Volcanoes,
  // islands, halls and rock mounds sit on lattices of "one candidate every N columns". A field can be perfectly
  // periodic and still show a half-volcano at the join if N does not divide the period. PERIOD_COLS is a power
  // of two, so N has to be one — which moves each spacing by up to ~30%. That is a content change and it is
  // fine: these are "how far apart should these be" numbers, not values tuned against a symptom.
  // ⚠️ Anchors are at `k * STEP` (or `moundLo + k * STEP`), so only the STEP has to divide the period — the
  // offset cancels. That is why moundLo can stay where it is.
  const pow2 = (n) => 1 << Math.max(0, Math.round(Math.log2(Math.max(1, n))));
  // ...and so do the hashes taken on a COLUMN directly, rather than through a noise field: whether an anchor is
  // real, how tall a mound is, which side of a region boundary a cell falls on. Every noise field in the world
  // can repeat perfectly and the world still not repeat, because these decide where the features ARE.
  const hc = (salt, c, y) => h(seed, salt, wrapL(c, PERIOD_COLS), y);
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
  const sbRawAt = (c) => wave1(seed, SALT.SURFBIO, c * NQ.SURFBIO.q + sOff, NQ.SURFBIO.p) * 1.15 + recipe.climate * 0.72;
  const eroAt = (c) => {
    const base = (wave1(seed, SALT.HEIGHT + 40, c * NQ.ERO.q + hOff, NQ.ERO.p) + 1) * 0.5;
    return Math.max(0, Math.min(1, base + spline(sbRawAt(c), FLAT_KNOTS)));
  };

  // ---- volcanoes: the lattice pattern doing something worth looking at ---------------------------------------
  // One candidate every VOLC_STEP columns, ~9% of them real. A cone with a crater bitten out of the top and a
  // lava conduit under it. Bounded size => a chunk asks "does any anchor within VOLC_HW of me reach me?" alone.
  const VOLC_STEP = pow2(Math.round(420 * G)), VOLC_HW = Math.round(300 * G);
  const VOLC_H = Math.round(baseRow * 0.42), VOLC_CRATER = Math.round(26 * G);
  const volcOn = (a) => hc(SALT.VOLC, a, 0) < 0.09 && a > VOLC_HW && a < cols - VOLC_HW;
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
  const volcVentAt = (c) => (volcVentAnchorAt(c) >= 0 ? 1 : 0);
  // WHICH volcano this column's conduit belongs to, or -1. Needed because the conduit's top must be decided for
  // the BAND, not per column — see `ventTopFor`.
  const volcVentAnchorAt = (c) => {
    const near = Math.round(c / VOLC_STEP), reach = Math.ceil(VOLC_HW / VOLC_STEP) + 1;
    for (let k = -reach; k <= reach; k++) {
      const a = (near + k) * VOLC_STEP;
      if (volcOn(a) && Math.abs(c - a) < VOLC_CRATER * 0.55) return a;
    }
    return -1;
  };
  // 🟥 THE CONDUIT'S TOP HAS TO BE FLAT ACROSS THE WHOLE BAND. Deciding it per column as `max(own surface,
  // neighbours')` left it a STAIRCASE — each step put one column's lava a row above its neighbour's, with the
  // neighbour's open sky beside it, and that was every wake left after the ordering fix (23 of them, all at
  // row ≈ the surface, all `side-air`, all with a vent column as the exposed neighbour).
  // ⇒ one line for the band, taken as the LOWEST ground anywhere across it plus its shoulders, so no column's
  // lava can stand above the rock beside it. Memoised per volcano: the band is ~28 columns and this is asked
  // once per column generated.
  const _vtMemo = new Map();
  const ventTopFor = (a) => {
    let v = _vtMemo.get(a);
    if (v !== undefined) return v;
    const CR = Math.ceil(VOLC_CRATER * 0.55) + 1;
    let lowest = -Infinity;
    for (let c = a - CR; c <= a + CR; c++) { const s = surfAt(c); if (s > lowest) lowest = s; }
    v = lowest + 2;
    if (_vtMemo.size > 64) _vtMemo.clear();
    _vtMemo.set(a, v);
    return v;
  };

  const heightAt = (c) => {
    const cont = wave1(seed, SALT.HEIGHT, c * NQ.CONT.q + hOff, NQ.CONT.p) + 0.24;   // biased toward land: sea is a feature
    const ero = eroAt(c);
    const land = spline(cont, CONT_SPLINE);                   // elevation above sea, as a fraction of baseRow
    // ⭐ MOUNTAINS FROM MULTI-OCTAVE RIDGED NOISE, not from one tent cubed. `1 - |noise|` is a TENT: cube it and
    // you get a single sharp spike, which is exactly the triangular peaks the user rejected. Several octaves
    // give a ridgeline with shoulders, spurs and foothills — a range rather than a traffic cone.
    const mtn = ridge1(seed, SALT.HEIGHT + 20, c * NQ.MTN.q, 3, NQ.MTN.p);   // already squared per octave
    const above = Math.max(0, Math.min(1, (land + 0.02) / 0.10));   // no mountains rising out of deep water
    const hh = (land + mtn * (1 - ero) * above * 0.46) * baseRow
      + (fbm1(seed, SALT.HEIGHT + 60, c * NQ.DET.q, 3, NQ.DET.p) - 0.5) * 2 * DETAIL_A;
    const s = Math.round(baseRow - hh) - volcanoLift(c);       // volcanoes sit on top of whatever is there
    return s < 4 * G ? 4 * G : (s > bottomRow - 10 * G ? bottomRow - 10 * G : s);
  };
  // ⭐ MEMOISED, and it earns its keep the moment anything asks about a NEIGHBOURING column. The shoreline seal
  // needs `surfAt(c ± 1)`, and a basin anchor probes five columns across its span — so the world's single most
  // expensive per-column value (continentalness + erosion + mountains + detail, each an octave stack) was being
  // recomputed three or more times for every column generated. MEASURED: putting the seal in without this took a
  // chunk from 0.901 ms to 1.331 ms.
  // ⚠️ Float64, NOT Int32. `heightAt` is not documented as integral and a typed-array store would truncate it
  // SILENTLY, changing the world rather than merely caching it. A cache that alters what it caches is the worst
  // kind of bug to go looking for.
  // Direct-mapped on the low bits: columns are generated in order, so the working set is a handful of entries.
  const _shN = 64, _shM = _shN - 1;
  const _shK = new Int32Array(_shN).fill(-1 >>> 1), _shV = new Float64Array(_shN);
  const surfAt = (c) => {
    const i = c & _shM;
    if (_shK[i] === c) return _shV[i];
    const v = heightAt(c);
    _shK[i] = c; _shV[i] = v;
    return v;
  };
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
        if (hc(SALT.CRUST + 3, c, rr) < p) k = dd < 0 ? e + 1 : e;
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
    return Math.round(base) + ((hc(SALT.CRUST, c, 0) * 4 * G) | 0);
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
    const heat = Math.max(0, Math.min(1, d * 0.72 + wave2(seed, SALT.HEAT, c * NQ.HEAT.q, rr * 0.011 / G, NQ.HEAT.p) * 0.44 + 0.14));
    const wet = Math.max(0, Math.min(1, 0.5 + wave2(seed, SALT.WETF, c * NQ.WETF.q + wOff, rr * 0.013 / G, NQ.WETF.p) * 0.62));
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
    return d > 0.935 + wave2(seed, SALT.VOLC + 5, c * NQ.VOLC.q, rr * 0.013 / G, NQ.VOLC.p) * 0.055;
  };
  let _rcq = -1, _rcache = null, _wmcache = null;
  const _bump = (cq) => { _rcq = cq; _rcache = []; _wmcache = []; };
  function regionPick(c, rr, s) {
    if (moltenAt(c, rr, s)) return MOLTEN;                    // full-resolution, so the interface is not stepped
    const cq = c & ~3, rq = rr & ~3, k = rq >> 2;
    if (cq !== _rcq) _bump(cq);
    let ri = _rcache[k];
    if (ri === undefined) ri = _rcache[k] = regionInfo(cq, rq);
    return (ri.p > 0 && hc(SALT.RGN, c, rr) < ri.p) ? ri.b : ri.a;
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
      const t = Math.max(0, Math.min(1, wave2(seed, SALT.CAVEW, cq * NQ.CAVEW.q, rq * 0.008 / G, NQ.CAVEW.p) * 0.5 + 0.5));
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
    return Math.round(wave2(seed, SALT.OVH, c * NQ.OVH.q, rr * 0.017 / G, NQ.OVH.p) * OVH * fade);
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
    if (B.patch && fbm2(seed, SALT.PATCH + k * SALT.PATCH_STEP, c * NQ_PATCH[k].q, rr * NQ_PATCH[k].q, 2, NQ_PATCH[k].p) > B.patch.t) return B.patch.mat;
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
  const SPF = NQ.SPAG.q, SP2F = NQ.SPAG2.q, CHF = NQ.CHEESE.q;
  const caveAt = (c, rr, top, s, fade, bi) => {
    const B = BIOMES[bi === undefined ? regionPick(c, rr, s) : bi];
    const cv = B.caves, boost = B.caveBoost || 1;
    let x = c, y = rr;
    if (WARP) {                                               // domain warping: look the noise up somewhere else
      x += (fbm2(seed, SALT.WARPX, c * NQ.WARP.q, rr * NQ.WARP.q, 2, NQ.WARP.p) - 0.5) * WARP * G;
      y += (fbm2(seed, SALT.WARPY, c * NQ.WARP.q, rr * NQ.WARP.q, 2, NQ.WARP.p) - 0.5) * WARP * G;
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
    if (Math.abs(2 * fbm2(seed, SALT.SPAG, x * SPF, y * SPF, 2, NQ.SPAG.p) - 1) < cv.w * g) return true;
    if (Math.abs(2 * fbm2(seed, SALT.SPAG2, x * SP2F, y * SP2F, 2, NQ.SPAG2.p) - 1) < cv.w2 * g) return true;
    // ⚠️ `boost` moves the chamber threshold ADDITIVELY. Dividing by it (the first version) took t from 0.70 to
    // 0.50 for a 1.4x boost, which is 25% of cells rather than 8% — a lever four times stronger than intended.
    return fbm2(seed, SALT.CHEESE, x * CHF, y * CHF, 3, NQ.CHEESE.p) > cv.t + 0.04 - (wm - 1) * 0.10 - (boost - 1) * 0.06 - depth * 0.05 + (1 - f) * 0.12;
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
    const w = (wave1(seed, SALT.WET, c * NQ.WET.q + wOff, NQ.WET.p) + 1) * 0.5;
    if (w >= B.wet) return null;
    return { fluid: B.fluid, depth: Math.round(POOL_DEPTH * (B.poolMul || 1)) };
  };

  // ---- surface rock mounds: the lattice template, kept ---------------------------------------------------------
  // Small, but it matters out of proportion to its size: it is the TEMPLATE for everything the world will later
  // scatter, and the only rule that writes into a column it does not own.
  const moundStep = Math.max(1, pow2(Math.round(6 * G)));
  const moundLo = Math.max(8, genC0), moundHi = Math.min(cols - 8, genC1);
  const isAnchor = (a) => a >= moundLo && a < moundHi && (a - moundLo) % moundStep === 0;
  const moundOn = (a) => hc(SALT.MOUND_ON, a, 0) <= 0.10 && surfAt(a) <= seaRow;
  const moundHgt = (a) => (1 + ((hc(SALT.MOUND_H, a, 0) * 2) | 0)) * G;
  const moundAt = (c, rr, s) => {
    const k = s - 1 - rr; if (k < 0) return false;
    if (isAnchor(c) && k < moundHgt(c) && moundOn(c)) return true;
    const a = c - 1;
    return isAnchor(a) && k < moundHgt(a) && hc(SALT.MOUND_N, a, k) > 0.5 && moundOn(a);
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
  const ISLE_STEP = Math.max(8, pow2(Math.round(160 * G)));         // one island per ~480 columns (3,840 px, ~2.5 screens)
  const ISLE_HW = Math.round(40 * G);                         // biggest half-width
  const SKY_LO = Math.round(rows * 0.06);
  const isleAnchorAt = (a) => {
    if (a < ISLE_HW || a > cols - 1 - ISLE_HW) return null;   // needs room for its own width
    const u = hc(SALT.ISLE_SHAPE, a, 1);
    const hw = Math.max(6, Math.round((0.35 + 0.65 * u) * ISLE_HW));
    const top = Math.round((3 + 5 * hc(SALT.ISLE_SHAPE, a, 2)) * G);
    const bot = Math.round(top * 2.2);
    // Below the top of the world, and clear of whatever ground is under it. A tall mountain squeezes the
    // available sky, so a candidate that cannot fit simply does not exist here — but with SKY_LO at 6% of the
    // world and the surface at ~47%, that is rare rather than routine.
    const hi = Math.min(Math.round(rows * 0.30), surfAt(a) - bot - Math.round(10 * G));
    if (hi <= SKY_LO + top) return null;
    const cy = SKY_LO + top + Math.round(hc(SALT.ISLE_ON, a, 3) * (hi - SKY_LO - top));
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
      const nT = 1 + wave1(seed, SALT.ISLE_SHAPE + 4, (c + I.a) * NQ.ISLE_T.q, NQ.ISLE_T.p) * ISLE_ROUGH;
      const nB = 1 + wave1(seed, SALT.ISLE_MAT, (c - I.a * 3) * NQ.ISLE_B.q, NQ.ISLE_B.p) * ISLE_ROUGH;
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
  const HALL_STEP = Math.max(8, pow2(Math.round(120 * G)));         // one hall per ~360 columns (2,880 px)
  const HALL_HW = Math.round(30 * G), HALL_HH = Math.round(10 * G);
  const UG_LO = Math.round(rows * 0.67), UG_HI = Math.round(rows * 0.97);
  const hallAnchorAt = (a) => {
    if (a < HALL_HW || a > cols - 1 - HALL_HW) return null;
    const hw = Math.max(6, Math.round((0.5 + 0.5 * hc(SALT.HALL_SHAPE, a, 1)) * HALL_HW));
    const hh = Math.max(4, Math.round((0.5 + 0.5 * hc(SALT.HALL_SHAPE, a, 2)) * HALL_HH));
    // Inside the deep band, and never through the bedrock floor or up into the crust.
    const lo = Math.max(UG_LO, surfAt(a) + Math.round(30 * G)) + hh;
    const hi = Math.min(UG_HI, bottomRow - Math.round(3 * G)) - hh;
    if (hi <= lo) return null;
    return { a, hw, hh, cy: lo + Math.round(hc(SALT.HALL_ON, a, 3) * (hi - lo)) };
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
      const eT = Math.round(b * (1 + wave1(seed, SALT.HALL_SHAPE + 4, (c + H.a) * NQ.HALL_T.q, NQ.HALL_T.p) * 0.40));
      const eB = Math.round(b * (1 + wave1(seed, SALT.HALL_SHAPE + 5, (c - H.a * 3) * NQ.HALL_B.q, NQ.HALL_B.p) * 0.40));
      if (eT + eB < 2) continue;
      (out || (out = [])).push({ r0: H.cy - eT, r1: H.cy + eB });
    }
    return out;
  }
  // ---- UNDERGROUND: ANCHORED BASINS. Liquid that is settled BY CONSTRUCTION. ----------------------------------
  // ⭐⭐ THE RULE THIS REPLACES DRAPED WATER OVER THE TERRAIN. "A cell is fluid when the first solid at or below
  // it is within `depth` rows" measures DOWNWARD FROM THE FLOOR, so on a sloping cave floor the surface slopes
  // with it — and the sim wakes any liquid cell with AIR BESIDE IT. Every draped pool was therefore born awake
  // along its whole surface, and levelling is diffusion. MEASURED (probe_pool_equilibrium): one 1,451-cell lake
  // costs 1.8 MILLION cell examinations to reach level; the same water placed at rest costs 24,399. Across ten
  // sampled windows, ≥82x the work. The generator decides height, biome, cave and ore as pure functions of
  // position and never simulates any of them; liquid was the one thing scattered and handed to the physics
  // engine to sort out. This brings it up to the same standard.
  //
  // ⭐ THE INVARIANT, and it is what makes the SHAPE free. Seal only BELOW the waterline, and fill EVERY open
  // cell below it inside the footprint. Then there is no air below the line inside the basin at all — so
  // "air beside" and "air below" are not avoided by choosing a good shape, they are IMPOSSIBLE, whatever shape
  // the cave field left. Above the line nothing is suppressed, so the chamber is ordinary cave and tunnels join
  // it normally. A passage may enter above the waterline; it just cannot open below it. That is also how a
  // flooded cave actually looks: you see the cavern and its mouths, and the rock underwater is solid.
  //
  // ⚠️ THE FILL LINE COMES FROM THE ANCHOR, NEVER FROM A SCAN. Derived from the terrain — "the lowest floor in
  // the basin" — two chunks could sample different amounts of it and disagree about where the water stops, and a
  // one-cell step at a chunk seam wakes for ever. Anchor hash only, so every column agrees without communicating.
  //
  // ⚠️ THE COLLAR SUPPRESSES THE CARVE, IT DOES NOT IMPORT STONE. A stamped shell of stone would ring every pool
  // in the same material and read as an object dropped into the world; restoring the cell's OWN base material
  // means the basin is walled in whatever rock the biome already puts there.
  // ⭐ THE THREE DIALS, AND THE MEASUREMENT THAT SET THEM. A first pass at one candidate per 64 columns with
  // hw 20 / hh 8 produced 0.338% liquid world-wide, of which the underground fluids were 0.031% — lava came out
  // at 0.006%, i.e. 468 cells in 7.7 million, which is not "less liquid", it is a biome that no longer exists.
  // ⚠️ SIZE BEFORE FREQUENCY, deliberately. Cost is a property of SURFACES, not of volume (one sampled window
  // held 24,072 liquid cells and woke ZERO because it was fully submerged and had no surface at all), so the
  // same water in fewer, larger bodies is cheaper than in many small ones — and it reads better besides.
  const POOL_STEP = Math.max(8, pow2(Math.round(40 * G)));    // one candidate basin per ~32 columns (256 px)
  const POOL_HW = Math.round(28 * G), POOL_HH = Math.round(14 * G);
  const POOL_COLLAR = 2;                                      // rows of rock sealing the basin below the waterline
  // ⭐ THE "LESS LIQUID" DIAL, scaled per biome by `wet`. Raised from 0.80 once basins had to FIND a hollow
  // rather than carve one: the hollow test rejects most candidates by itself, so the hash gate is no longer the
  // thing deciding how many pools exist and a low value here just removes the ones the terrain did offer.
  const POOL_CHANCE = 1.60;
  // Memoised because `poolSpanAt` asks about the same two or three anchors for all 64 columns of a chunk, and an
  // anchor costs five `surfAt` probes. Pure function of the column, so a cache cannot change what is generated.
  const _poolMemo = new Map();
  const poolAnchorAt = (a) => {
    let v = _poolMemo.get(a);
    if (v !== undefined) return v;
    v = _poolAnchor(a);
    if (_poolMemo.size > 256) _poolMemo.clear();
    _poolMemo.set(a, v);
    return v;
  };
  // ⭐⭐ THE CAVE FIELD, PROBED — "place liquids in places which are carved out which would already accommodate
  // them" (user, 2026-08-06). The previous version CARVED its own bowl, and it showed: the pools read as objects
  // stamped into the rock rather than as water that had collected somewhere.
  // 🟥 AND THE OBJECTION THAT MADE ME AUTHOR THE SHAPE IN THE FIRST PLACE WAS WRONG. I had it that reading the
  // terrain breaks chunk-independence. What breaks it is reading a VARIABLE region — a flood fill, "walk until
  // the basin ends" — because two chunks can sample different amounts of it and disagree. A FIXED, BOUNDED probe
  // pattern defined by the anchor alone is perfectly deterministic: every column that asks runs the identical
  // loop and gets the identical answer, without communicating. That distinction is the whole unlock.
  // ⚠️ And the invariant does not depend on the probe being ACCURATE. The fill rule is still "every open cell in
  // the slab, whatever is there" — the probe only decides WHERE a basin goes and WHETHER it is worth having, so
  // a probe that reads the rock slightly differently from the final generate produces a worse-placed pool, never
  // an unsettled one.
  // A cheap "is this cell open" that deliberately does NOT go through solidAt: solidAt needs colInfo, colInfo
  // needs poolSpanAt, and that is a loop. Base material plus the cave field is what "is there a hollow" means.
  const _poolCol = (c) => {
    const s = surfAt(c), crust = crustDepthAt(c, s);
    return { s, crust, sB: sbAt(c), top: s + crust + 1, carveTop: (s <= seaRow - SHORE) ? s + 1 : s + OVH + crust + 1 };
  };
  const _poolOpen = (pc, c, rr) => {
    if (rr <= pc.top || rr >= bedrockTop) return false;         // the crust and the world floor are not basin country
    const bi = regionPick(c, rr, pc.s);
    if (!baseAt(c, rr, pc.s, pc.sB, pc.crust, bi)) return true; // already air
    return rr >= pc.carveTop && !!caveAt(c, rr, pc.top, pc.s, 1, bi);
  };
  function _poolAnchor(a) {
    if (a < POOL_HW + 8 || a > cols - 1 - POOL_HW - 8) return null;
    const hw = Math.max(5, Math.round((0.45 + 0.55 * hc(SALT.POOL_SHAPE, a, 1)) * POOL_HW));
    const hh = Math.max(3, Math.round((0.45 + 0.55 * hc(SALT.POOL_SHAPE, a, 2)) * POOL_HH));
    // ⚠️ THE WATERLINE HAS TO CLEAR THE GROUND ACROSS THE WHOLE FOOTPRINT, not just at the anchor. A basin whose
    // rim pokes out of a hillside would hang water in the open air — the failure the acceptance test calls
    // `below-air`. Five probes across the span, which is bounded and identical from every column that asks.
    let deepest = 0;
    for (let k = -2; k <= 2; k++) {
      const cc = a + Math.round(k * hw / 2), ss = surfAt(cc), d = ss + crustDepthAt(cc, ss);
      if (d > deepest) deepest = d;
    }
    // ⚠️ NEVER INSIDE A DEEP HALL. Halls are the placed, habitable chambers and are deliberately dry; a basin
    // overlapping one would both flood it and drive a collar through its wall. Rejected on horizontal proximity
    // alone, which is conservative and costs one bounded lattice query.
    const lo = deepest + Math.round(10 * G);
    const hi = bottomRow - Math.round(5 * G) - hh - POOL_COLLAR - 2;
    if (hi <= lo) return null;
    // ── FIND A HOLLOW near the hashed candidate depth, instead of carving one ──────────────────────────────────
    // The probe grid is coarse on purpose: 16 columns and every second row. It decides placement, not shape, and
    // its cost is paid once per anchor for ~32 columns of world.
    const cand = lo + Math.round(hc(SALT.POOL_ON, a, 3) * (hi - lo));
    const CSTEP = Math.max(2, Math.round(hw / 8)), V = hh * 3;
    const pcs = [];
    for (let c = a - hw; c <= a + hw; c += CSTEP) pcs.push([c, _poolCol(c)]);
    const minW = Math.max(3, Math.round(pcs.length * 0.28));    // a pool needs to be WIDE, or it is a wet tunnel
    // Which rows near the candidate are open across enough of the footprint to hold a body of water?
    const r0 = Math.max(lo, cand - V), r1 = Math.min(hi, cand + V);
    let bestTop = -1, bestBot = -1, runTop = -1;
    for (let rr = r0; rr <= r1 + 1; rr += 2) {
      let w = 0;
      if (rr <= r1) for (let i = 0; i < pcs.length; i++) if (_poolOpen(pcs[i][1], pcs[i][0], rr)) w++;
      if (rr <= r1 && w >= minW) { if (runTop < 0) runTop = rr; continue; }
      if (runTop >= 0) { if (bestTop < 0 || (rr - 2 - runTop) > (bestBot - bestTop)) { bestTop = runTop; bestBot = rr - 2; } runTop = -1; }
    }
    if (bestTop < 0 || bestBot <= bestTop) return null;         // nothing here that would hold water
    // ⭐ FILL THE BOTTOM OF IT, NOT ALL OF IT. The water line sits inside the hollow so the chamber stays open
    // above the surface — which is the difference between a pool you can walk to and a sealed pocket you can
    // only find by digging. How full is hashed, so a cavern is not always half-full.
    const span = bestBot - bestTop;
    const depth = Math.max(2, Math.min(span, Math.round((0.35 + 0.45 * hc(SALT.POOL_SHAPE, a, 6)) * span)));
    const bot = bestBot, line = bot - depth + 1;
    // ⚠️ NEVER INSIDE A DEEP HALL. Halls are the placed, habitable chambers and are deliberately dry; a basin
    // overlapping one would both flood it and drive a collar through its wall.
    // ⚠️ TESTED IN BOTH AXES. A first version rejected on HORIZONTAL proximity alone, which threw away every
    // basin within ~54 columns of a hall anchor at ANY depth — a basin at row 2,000 has no quarrel with a hall
    // at row 3,500, and half the candidates in the deep half of the world were being discarded for nothing.
    const hr = Math.ceil((POOL_HW + HALL_HW) / HALL_STEP) + 1, nearH = Math.round(a / HALL_STEP);
    for (let k = -hr; k <= hr; k++) {
      const H = hallAnchorAt((nearH + k) * HALL_STEP);
      if (H && Math.abs(H.a - a) < H.hw + hw + 4 && Math.abs(H.cy - line) < H.hh + hh + Math.round(6 * G)) return null;
    }
    // ONE fluid for the whole basin, chosen at the anchor. Layered liquids are never wanted (user, 2026-08-06),
    // and picking per cell is exactly how the old rule produced lava resting on water.
    const B = BIOMES[regionPick(a, line, surfAt(a))];
    if (!B || !B.fluid) return null;
    // ⭐ THE BIOME'S OWN WETNESS IS THE DENSITY DIAL, which is what keeps "less liquid" from meaning "no character".
    // A flat chance for every anchor made the exotic fluids vanish outright — probe_worldgen D3 went to ZERO oil
    // and ZERO acid, which is the guard for the worst bug this track has recorded (a material that generates
    // nowhere fails SILENTLY). `wet` and `poolMul` already describe how much liquid a biome should hold; they
    // used to drive a per-cell flood and now they drive how many basins exist, which is the same intent applied
    // to the thing that is actually being placed.
    if (hc(SALT.POOL_ON, a, 5) > POOL_CHANCE * (B.wet || 0) * Math.min(1.6, B.poolMul || 1)) return null;
    return { a, hw, line, bot, fluid: B.fluid };
  }
  // ⭐ THE SPAN IS NOW A FLAT SLAB, and a great deal of machinery went away with the carved bowl. There is no
  // per-column depth profile, so no `poolBot`, no three-column collar lookahead (which existed because a carved
  // bowl's floor could jump four rows in one column), no core, and no air chamber — the hollow is already there
  // and the space above the water is already open. Two noise reads per covered column became none.
  function poolSpanAt(c) {
    const near = Math.round(c / POOL_STEP), reach = Math.ceil((POOL_HW + POOL_COLLAR) / POOL_STEP) + 1;
    let out = null;
    for (let k = -reach; k <= reach; k++) {
      const P = poolAnchorAt((near + k) * POOL_STEP); if (!P) continue;
      const dx = Math.abs(c - P.a);
      if (dx > P.hw + POOL_COLLAR) continue;
      // Inside the footprint the slab is filled; in the ring beyond it the slab is sealed, which is what stops
      // the water reaching open cave sideways. Below the slab, `POOL_COLLAR` rows of rock in every column.
      (out || (out = [])).push({ line: P.line, bot: P.bot, ring: dx > P.hw,
        collarTo: P.bot + POOL_COLLAR, fluid: P.fluid });
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
    // ⭐⭐ THE SHORELINE SEAL. The ocean fills [seaRow, s) — a flat top resting on the seabed, which IS settled,
    // and a column's own seabed is already protected by `carveTop`. What was not protected is the column NEXT
    // DOOR: coastal land whose surface is above sea level but which a cave carves at rows BELOW it, giving the
    // sea open air to spill into at its own waterline. MEASURED before this existed: 563 of 9,811 surface liquid
    // cells wanted to move, in 12 of 30 surface chunks.
    // So a column in or beside water is not carved between the waterline and the deepest neighbouring seabed.
    // ⚠️ Two extra `surfAt` probes per column, and only the immediate neighbours matter — a wake needs air in the
    // cell directly beside the water, so sealing one column either side of the body is sufficient and the caves
    // one column further inland are untouched.
    const sL = surfAt(c - 1), sR = surfAt(c + 1);
    const seaDeep = Math.max(s > seaRow ? s : 0, sL > seaRow ? sL : 0, sR > seaRow ? sR : 0);
    // 🟥 THE VOLCANO CONDUIT WAS NOT SEALED ON ITS SIDES, reported from play as "a massive pillar of lava trying
    // to move". The vent replaces a band of columns with LAVA from just under the surface all the way to bedrock
    // — and any cave carved into the column BESIDE it puts air next to lava, at which point the entire pillar,
    // thousands of rows of it, is awake and trying to pour sideways. It rested on bedrock and was covered above,
    // so this was the one face nobody had closed. Pre-existing, and by far the largest remaining wake source.
    return { s, sB, crust, top: s + crust + 1, vent: volcVentAt(c), drySurface, openable,
      carveTop: openable ? s + 1 : s + OVH + crust + 1, entr: crust + Math.round(10 * G),
      seaSealTo: seaDeep ? seaDeep + crust + OVH + 2 : -1,
      // …and the conduit itself does not start until it is below its NEIGHBOURS' ground as well as its own. A
      // volcano is a raised cone, so the vent column's surface is high and the ground beside it is lower — which
      // left the top of the conduit standing in open SKY with nothing at its side at all. Plugging it with the
      // cone's own rock is what makes a volcano a volcano rather than a column of lava in the air.
      ventFrom: (() => { const a = volcVentAnchorAt(c); return a >= 0 ? ventTopFor(a) : -1; })(),
      ventN: (volcVentAt(c - 1) | volcVentAt(c + 1)),
      isle: isleSpanAt(c), hall: hallSpanAt(c), pool: poolSpanAt(c) };
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
    const base = v;                                          // the uncarved material — what the collar restores
    // ⚠️ `seaSealTo`: no cave may open into the sea's body or beside it. See colInfo.
    const seaSealed = rr >= seaRow - 1 && rr <= ci.seaSealTo;
    if (v && !seaSealed && rr >= ci.carveTop && caveAt(c, rr, ci.top, s, flare, bi)) v = 0;
    if (v && ci.hall && rr > ci.top && inSpan(ci.hall, rr)) v = 0;   // a deep hall is carved out of everything
    // ⭐ ANCHORED BASINS, LAST, so the seal wins over anything that would breach it. THREE PASSES, and the order
    // is the whole correctness argument once basins are allowed to overlap.
    if (ci.pool) {
      const PL = ci.pool;
      // 1 — SEAL. The RING columns have their whole slab closed (this is what stops the water walking off
      // sideways into open cave), and every column gets `POOL_COLLAR` rows of rock beneath the slab.
      // ⚠️ Sealing runs before nothing and after everything else that carves, deliberately: with basins allowed
      // to overlap, one basin's slab must never be able to open a neighbour's wall.
      for (let i = 0; i < PL.length; i++) {
        const P = PL[i];
        if (P.ring) { if (rr >= P.line && rr <= P.collarTo) v = v || base || MAT.STONE; continue; }
        if (rr > P.bot && rr <= P.collarTo) v = v || base || MAT.STONE;
      }
      // 2 — 🟥 NO POWDER IN OR AROUND A BASIN. Reported from play: "other liquids pooled with sand as the
      // surrounding cells to keep it in, but the sand of course just fell down." The collar restores each cell's
      // OWN material so a basin is walled in native rock — and in a sand region the native rock is SAND, which
      // is a powder and falls the moment there is liquid under it. A wall that falls into the water is not a
      // wall. Two rows above the line as well, or a sand rim sinks in.
      for (let i = 0; i < PL.length; i++) {
        const P = PL[i];
        if (rr >= P.line - 2 && rr <= P.collarTo && (v === MAT.SAND || v === MAT.SNOW)) { v = MAT.STONE; break; }
      }
    }
    // ⭐⭐ THE VOLCANO CONDUIT IS APPLIED LAST, AND THE ORDER IS THE ENTIRE BUG. It used to be set immediately
    // after the cave carve — before deep halls and (now) before basins — so both of those carved straight
    // THROUGH it, leaving air gaps inside a column of lava thousands of rows tall. Diagnosed by printing the
    // waking cells rather than by reasoning about them, after two wrong guesses: they were `below-air`, INSIDE
    // the vent band, at rows 2,615 and 3,595 — the deep-hall band and a basin chamber. Nothing was wrong with
    // the seal; the conduit simply had holes punched in it afterwards.
    // ⚠️ A conduit that survives to here is continuous by construction: solid from `ventFrom` to the bedrock it
    // stands on, with lava either side of every interior cell.
    if (ci.vent && rr >= ci.ventFrom) v = MAT.LAVA;
    // …and its NEIGHBOURS are closed for its whole depth, after every carve for the same reason. The conduit's
    // top is `max(s, sL, sR) + 2` and this column is one of those three, so sealing from `s + 2` downward always
    // covers it. ⚠️ Never with a POWDER: a sand wall beside a lava column falls into it on the first tick.
    if (!v && ci.ventN && !ci.vent && rr >= s + 2)
      v = (base && base !== MAT.SAND && base !== MAT.SNOW) ? base : MAT.STONE;
    return v;
  };

  // ---- the fast form: one column of a page at a time ------------------------------------------------------------
  // ⭐ THE OVERLAP AT BOTH ENDS IS GONE (2026-08-06). It existed for the draped pool rule, which probed up to
  // POOL_MAX rows BELOW a cell to find its floor and HEAD rows ABOVE it to find its ceiling — so the scratch
  // column had to reach past the page in both directions. Anchored basins ask neither question: a cell is
  // flooded because it is inside a footprint below a line, which is decided from the anchor. The column is now
  // exactly the page, and `j` is simply `lr`.
  let _scratch = new Uint8Array(CHUNK_SIDE + 8);
  function fillColumn(c, r0, rN, out) {
    if (c < genC0 || c > genC1) { out.fill(0, 0, rN); return; }
    const ci = colInfo(c);
    const SPAN = rN;
    if (_scratch.length < SPAN) _scratch = new Uint8Array(SPAN + 8);
    const scratch = _scratch;
    // ⚠️ THE DOWNWARD OVERLAP IS FILLED LAZILY, AND IT IS WORTH 30% OF THE WHOLE GENERATOR. The pool rule may
    // probe up to POOL_MAX rows below the page, so the eager version generated 104 rows to emit 64 — a 63%
    // surcharge on every column in the world, paid so that the few air cells at the very bottom of the page
    // could look for a floor. Most columns never probe at all (solid rock, or sky). `have` is the watermark of
    // what has been computed; `at(j)` extends it on demand and is the ONLY reader below the page.
    for (let k = 0; k < rN; k++) scratch[k] = solidAt(c, r0 + k, ci);
    const s = ci.s, lake = s > seaRow;
    for (let lr = 0; lr < rN; lr++) {
      const rr = r0 + lr, j = lr;
      // 🟥🟥 NOTHING EXISTS BELOW THE WORLD'S LAST ROW, ASSERTED HERE RATHER THAN TRUSTED.
      // `solidAt` already returns 0 past `bottomRow`, but the POOL rule does not go through it: it ends with
      // `rr + k > bottomRow || at(j + k)` — "past the bottom of the world counts as solid" — which for a cell
      // that is ITSELF below the bottom is true on the first probe. So every dead row under the world flooded,
      // except where the headroom test happened to see solid ground within HEAD rows above.
      // MEASURED: exactly 1,920 liquid cells at row 404 of a 405-row world — one per column, every column —
      // sitting 8 rows BELOW the floor band the client draws, which is the reported "lava beneath the bedrock",
      // and a full-width row of permanently active lava, which is the reported lag at the bottom of the screen.
      // ⚠️ Fixed at the OUTPUT rather than in the pool rule, deliberately: this is the one place every rule's
      // result passes through, so any future rule that leaks past the floor is caught here too.
      if (rr > bottomRow) { out[lr] = 0; continue; }
      let v = scratch[j];
      if (!v) {
        // ⭐ ARCTIC ICE SHEET: in cold country the sea has a lid on it rather than an open surface, so you can
        // walk out over it — and, since ice is a breakable solid here, fall through it.
        // 🟥 `rr < s` LEFT A GAP OF AIR UNDER THE OCEAN, and it is the user's own report from an earlier session:
        // *"even lakes or oceans on the surface, which should do this easily enough, have a gap between the solid
        // terrain below them and where they seem to start off."* That session read this line, concluded the fill
        // was contiguous and went looking elsewhere. It is not contiguous: `s` is the surface LINE, but in the
        // overhang band the ground actually begins at `s + surfDisp`, up to OVH rows lower — so the sea stopped
        // short and the last row of water had air beneath it, for ever. It is the whole of what the acceptance
        // test still called `below-air` once the basins landed: 48 cells, all water, all in one chunk.
        // ⇒ fill any AIR down to the deepest the displaced ground can start. Below that the column is solid, or
        // sealed by `seaSealTo`, so this cannot run away into a cave.
        if (lake && rr >= seaRow && rr <= s + OVH) v = (ci.sB === SB.SNOW && rr < seaRow + ICE_SHEET) ? MAT.ICE : MAT.WATER;
        // ⭐ FILL EVERY OPEN CELL BELOW THE LINE, WHICH IS THE WHOLE INVARIANT. Not "the bowl", not "the core" —
        // every cell inside the footprint at or below the waterline that is not solid becomes the basin's fluid.
        // That is what leaves no air down there for a neighbour to spill into, and it is why the shape of the
        // opening can be anything the cave field drew. Above `line`, nothing: that is ordinary cave.
        else if (ci.pool) {
          for (let i = 0; i < ci.pool.length; i++) {
            const P = ci.pool[i];
            if (!P.ring && rr >= P.line && rr <= P.bot) { v = P.fluid; break; }
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
    if (rr > bottomRow) return 0;                          // see the note in fillColumn — the pool rule leaks past it
    const ci = colInfo(c), s = ci.s;
    const v = solidAt(c, rr, ci); if (v) return v;
    if (s > seaRow && rr >= seaRow && rr <= s + OVH) return (ci.sB === SB.SNOW && rr < seaRow + ICE_SHEET) ? MAT.ICE : MAT.WATER;
    // The basin flood, identical to fillColumn's — see the invariant there.
    if (ci.pool) for (let i = 0; i < ci.pool.length; i++) {
      const P = ci.pool[i];
      if (!P.ring && rr >= P.line && rr <= P.bot) return P.fluid;
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
// ⚠️ 2 -> 3: GLASS STOPPED BEING GENERATED (2026-08-05). Two biomes' patch material changed and Glassfields'
// matrix went stone -> sand, so the ground under any stored diff in those biomes is different rock.
// ⚠️ 3 -> 4: PERIODIC NOISE (2026-08-05). Every horizontal frequency is quantised so its field repeats exactly
// at PERIOD_COLS, and the volcano/island/hall/mound lattices moved to power-of-two spacings so they tile it.
// Frequencies moved by at most 0.05%; the anchor spacings by up to 30%. This is the LAST cheap moment to do it
// — the whole point is that it must not have to happen once generated worlds persist.
// 5 (2026-08-06): underground liquid moved from the draped depth rule to ANCHORED BASINS, and the shoreline is
// sealed. Different ground ⇒ every stored diff taken against version 4 is correctly refused rather than applied
// to rock it was never cut from.
const WORLDGEN_VERSION = 5;

module.exports = { makeGen, recipeFor, mulberry32, h, vn1, vn2, fbm1, fbm2, wave1, wave2, ridge1, isFluid,
  SALT, MAT, SB, BIOMES, SURFACE, MOLTEN, CHUNK_SIDE, WORLDGEN_VERSION, PERIOD_COLS, nfreq };
