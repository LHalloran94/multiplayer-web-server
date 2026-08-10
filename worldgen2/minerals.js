'use strict';
// ==============================================================================================================
//  worldspike/minerals.js — ASSOCIATION × DEPTH × RARITY, AND A SHAPE FOR EACH.
//
//  What was there was five hard-coded rules inside `depositAt`: a coal seam, an oil trap, one hydrothermal vein
//  that produced iron, copper or quartz from a hash, a salt dome and a crystal pocket. Five rules, seven
//  materials, and every one of them a special case.
//
//  ⭐⭐ THE TABLE SAYS FOUR THINGS AND THE FOUR ARE INDEPENDENT, which is what makes adding the twenty-third
//  mineral one line instead of one rule:
//
//     HOST     the rock and setting it belongs to. Hydrothermal minerals want igneous rock; bedded ones want
//              sediments; evaporites want evaporite; a placer wants river gravel. This is the part that makes a
//              region feel like it has its OWN minerals rather than the world's.
//     DEPTH    a band, in rows below the surface. Copper is shallow, silver deeper, diamond deeper still.
//     RARITY   the fraction of qualifying rock that carries it — and it MEANS that, because the thresholds are
//              CALIBRATED rather than guessed. 🟥 The first version wrote `field > 1 - rarity * k` with a k per
//              shape, and asserted in a comment that the number was comparable across shapes. It is not: a
//              2-octave value-noise field and a 3-octave one have completely different spreads, so the same
//              rarity gave emerald 3 cells in 11.7 million and, after I adjusted it by hand, gave hematite
//              8,484 per 100,000 — a third of all sandstone. Guessing a threshold against an unmeasured
//              distribution is precisely what made ten of sixteen landform contracts place nowhere, and the
//              answer here is the same one: a PERCENTILE of the field that exists. Each shape's field is
//              sampled once at startup and the threshold is read off at the (1 - rarity) quantile.
//     SHAPE    ⭐ and this is the one that changes how it PLAYS. A vein is a line you chase along a fracture; a
//              seam is a bed you follow sideways for miles; a pocket is something you stumble into; a massive
//              body is a landmark; a disseminated ore is a grade you assay rather than a thing you find; a pipe
//              is a vertical shaft of ore you can follow down; a placer is panned out of a stream bed.
//              Finding each of those is a different activity, and that is the whole argument for the field.
//
//  ⚠️ DEPTH IS MEASURED FROM THE SURFACE, not from sea level. Under a mountain the same bed is two thousand rows
//  down and under a plain it is two hundred; using elevation would put every ore at the same altitude and make
//  the mountains hollow of everything.
// ==============================================================================================================
const { L } = require('./pipeline.js');
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// twelve others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');

const IGNEOUS = [L.GRANITE, L.BASALT, L.BASEMENT];
const SEDIMENT = [L.SANDSTONE, L.SHALE, L.LIMESTONE];

// ==============================================================================================================
//  ⭐⭐ TWO WAYS TO PLACE AN ORE BODY, SWITCHABLE, SO THEY CAN BE RENDERED SIDE BY SIDE.
//
//  `ORE='field'`  (what the spike has always done) — every mineral owns a NOISE FIELD spread over the whole
//                 world, and every cell asks all 45 of them "are you here?". 34 of the 45 answer with a 2-D fBm.
//  `ORE='bodies'` — an ore body becomes a PLACED RECORD on a lattice, which is what every other feature in this
//                 design already is (volcanoes, cave systems, islands, halls, basins). A cell asks only about
//                 the bodies near it, which is almost always none.
//
//  🟥 WHY THIS EXISTS: measured, minerals are 60% of the cost of the worst chunk — 9.41 ms falls to 3.76 ms with
//  them removed — because 34 independent 2-D noise fields per cell is ~240 arithmetic operations where the whole
//  cave system is ~10. The world cannot be stored (2.1 billion cells x 17 bytes = 36 GB), so every cell is
//  recomputed as a player walks, and a chunk has a ~2 ms budget beside a 40 ms liquid tick.
//
//  ⭐ AND IT IS THE DESIGN'S OWN PRINCIPLE, not merely an optimisation: "a thing with an IDENTITY is a placed
//  record; a thing that is a property of a point stays a field". An ore body has an extent, a location and a
//  grade — you can ask where it is and how big it is — so it is a record. A DISSEMINATED grade genuinely is a
//  property of a point, and a bedded SEAM genuinely is laterally continuous for miles, so those two stay fields.
//
//  ⚠️⚠️ THE ONE RULE THAT DECIDES WHETHER THIS WORKS: A BODY MUST BE THE SAME BODY FROM EVERY COLUMN THAT
//  TOUCHES IT. Mistake #3 on this track, three instances in the flora alone — a plant whose spacing, height and
//  niche were all functions of the column DOING THE LOOKING came out with missing vertical strips and crowns
//  sliced off. So every property of a body below (whether it is real, which mineral, where its centre is, how
//  big it is, which way it leans) is a pure function of its LATTICE NODE, and nothing here may read the asking
//  column or the asking row.
// ==============================================================================================================
// ⭐⭐ THE DEFAULT IS "J" — chosen by the user 2026-08-09 off `out/ore_compare.png`, after the rejection of the
// stamp roster was re-opened and found to be a bake bug. J = ore BODIES on a lattice, original size table,
// pinch-and-swell at 0.35 with a neck every 34 cells and NO gap cut: long veins that swell and neck, which is
// both what a real vein does and a thing a player can follow. ~27% cheaper than the field mode it replaces.
let ORE_MODE = process.env.ORE || 'bodies';
const setOreMode = (m) => { ORE_MODE = m; };
const oreMode = () => ORE_MODE;
// ⚠️⚠️ ONE PREDICATE FOR "ARE ORE BODIES ON", and it exists because adding `stamps` as a third mode left TWO
// gates still reading `=== 'bodies'` — one here that decides whether the field path drops the body minerals, and
// one in cells.js that decides whether the body path runs at all. So `stamps` silently WAS `field`: it measured
// 11.82% ore against field's 11.82% and 9.79 ms against 9.43, i.e. identical to two decimal places, which is the
// only reason it was caught. A mode that is not wired looks exactly like a mode that does not help.
const oreBodiesOn = () => ORE_MODE === 'bodies' || ORE_MODE === 'stamps';

// Which shapes become records. The other four stay fields, on purpose:
//   seam          a bed that runs for miles — a record would have to be a mile long, which is not a record
//   disseminated  a GRADE, i.e. genuinely a property of a point. One hash per cell; already free.
//   pipe          already lattice-anchored (`pipeSite`) — it was the pattern all along
//   placer/blanket one cheap hash each
const BODY_SHAPES = { vein: 1, pocket: 1, massive: 1 };
// 🟥 AND THE SHAPE IS NOT THE RIGHT AXIS ON ITS OWN — THE PICTURE SAID SO. `massive` turned out to be mostly
// MARBLE, SLATE, QUARTZITE and GNEISS, the four metamorphic rocks, plus salt. A metamorphic rock mass is
// COUNTRY ROCK over a wide area: it is what you walk through, not what you look for, so by this design's own
// principle it is a property of a place and belongs in a field. Shrinking gneiss to a 30-cell lens is bad
// geology and worse gameplay, and the first render showed exactly that — window 3 went from a landscape of
// marble and crystal to 73 cells of nothing.
// ⇒ `unit: 1` on the catalogue row is a FIFTH axis beside host/depth/rarity/shape: is this a rock unit or an
// ore body? It lives in the table with the other four rather than as a list of names somewhere else.
const isBody = (m) => !!BODY_SHAPES[m.shape] && !m.unit;

// ==============================================================================================================
//  🟥🟥 ONE LATTICE PER MINERAL, AND THE FIRST VERSION'S SHARED LATTICE DELETED FOURTEEN OF THEM.
//
//  The first attempt put one body per cell of a single 96x96 lattice and chose WHICH mineral by a rarity-
//  weighted draw. Measured (`probe_ore_census`): quartz at rarity 0.075 wins against ruby at 0.0022 essentially
//  every time, so hematite, ruby, sapphire, emerald, topaz, lapis, uranium, amber, sulphur, obsidian, realgar,
//  orpiment and cinnabar came out at EXACTLY ZERO. In the field mode each mineral owns an INDEPENDENT field, so
//  a rare one still surfaces somewhere; making them compete for one slot is what destroyed them.
//
//  That is the silent-material failure this project has now been bitten by three times (MAT.OIL/GLASS/ACID
//  storing as AIR; `scree` produced by no rule; `L.EVAPORITE` assigned to no column), and it fails QUIETLY —
//  the world simply has no rubies in it and nothing says so.
//
//  ⭐ SO EACH MINERAL GETS ITS OWN LATTICE, and its spacing is DERIVED FROM ITS OWN RARITY rather than tuned:
//  a body covers about `pi * hw * hgt` cells, and `rarity` means "this fraction of qualifying rock carries it",
//  so the lattice cell that delivers that fraction has area `bodyArea / rarity`. Spacing is the square root.
//  Rarity therefore keeps EXACTLY the meaning the catalogue gives it, and it is arithmetic rather than a dial.
//  ⚠️ Which is also why this is not simply "more lattices, more cost": each node is now a handful of hashes for
//  a mineral that is already decided, instead of a scan over the whole catalogue.
// ==============================================================================================================
// ⚠️ ORE_MAXHW must cover the LARGEST `reach` any body can have, not the largest half-width — the wander and the
// roughness both push past `hw`. Asserted at the shortlist rather than trusted.
const ORE_MAXHW = 240, ORE_MAXHH = 150;
// ⭐⭐ AND THE SCAN WINDOW IS PER MINERAL, NOT GLOBAL — measured at 846 node lookups per column, 13 per cell,
// because a pocket 20 cells wide was being searched for across the 240-column window a 150-row VEIN needs.
// A mineral's own worst case is a property of its own size range and dip limit, so it is derived here from the
// same numbers the node builder uses. ⚠️ It must be an UPPER BOUND on `reach` or the shortlist clips bodies —
// the throw in `oreBodiesNear` is what proves the two agree, and it has already fired once.
function oreReachOf(m) {
  let v = m._reach;
  if (v === undefined) {
    const sz = sizeOf(m), vein = m.shape === 'vein';
    const wobMax = (vein ? 1.1 : 0.3) * 2.0;
    const dipMax = vein ? 1 : 0.35;
    v = m._reach = {
      rx: Math.ceil(sz.hw[1] * (wobMax + 1 + ENV_SLOP) + dipMax * sz.hgt[1]) + 3,
      ry: Math.ceil(sz.hgt[1] * (1 + ENV_SLOP)) + 3,
    };
  }
  return v;
}
// A global density trim, so "how much ore is in this world" stays one number that can be judged by eye without
// disturbing the RELATIVE proportions, which are what `rarity` owns. 1 = exactly what the rarities ask for.
let ORE_GAIN = +(process.env.ORE_GAIN || 1);
const setOreGain = (g) => { ORE_GAIN = g; };

// The mean body area for a shape, in cells — the midpoint of the size ranges below, times pi/4 for the ellipse.
// ⚠️ Kept beside the size ranges it must agree with. Two numbers describing one body is mistake #2.
const SHAPE_SIZE_BIG = {
  vein:    { hw: [3, 10], hgt: [24, 150] },
  massive: { hw: [12, 44], hgt: [8, 30] },
  pocket:  { hw: [4, 20], hgt: [3, 16] },
};
// ⭐⭐ MATCHED TO THE FIELD MODE, MEASURED — `probe_ore_size.js`, connected components of the field mode's own
// ore in a 400x260 window of the real world: **width median 5, p90 11, p99 19, max 53 · height median 10,
// p90 24, p99 46, max 75**. The table above draws veins 48-300 cells tall, i.e. 5-6x the field's *99th
// percentile* and ~25x its median — which is why the lattice panels showed ribbons crossing the whole frame
// while the field panel showed scattered blobs. That difference was never about stamping; it is this table, and
// it applies to `bodies` and `stamps` equally.
// ⚠️ Half-sizes, so these are half of the extents above. Set so the RANGE spans the measured median to about
// the p99, rather than to the max — one 75-cell body in 375 is the tail, not the subject.
// ⚠️ The lattice SPACING is derived from `meanArea`, so shrinking a body automatically packs the lattice tighter
// and the mineral keeps the share of the rock its `rarity` promises. That is why this is a one-line swap and not
// a recalibration.
const SHAPE_SIZE_MATCH = {
  vein:    { hw: [2, 7],  hgt: [6, 26] },
  massive: { hw: [5, 18], hgt: [4, 14] },
  pocket:  { hw: [3, 9],  hgt: [3, 11] },
};
let SHAPE_SIZE = (process.env.ORE_SIZE || 'big') === 'match' ? SHAPE_SIZE_MATCH : SHAPE_SIZE_BIG;
const setOreSize = (k) => applyOreSize(k === 'match' ? SHAPE_SIZE_MATCH : SHAPE_SIZE_BIG, k);
// Override just the vein length, keeping everything else — the one knob that moves a lattice world between "A's
// scatter" and "a vein you can follow". Fresh table, never a mutation of a preset.
const setOreVein = (lo, hi) => {
  const T = { vein: { hw: SHAPE_SIZE.vein.hw, hgt: [lo, hi] }, massive: SHAPE_SIZE.massive, pocket: SHAPE_SIZE.pocket };
  applyOreSize(T, 'vein' + lo + '_' + hi);
};
function applyOreSize(T, key) {
  SHAPE_SIZE = T; STAMPS = null;
  ORE_LAT_MIN = oreLatMinFor(T);
  ORE_SIZE_KEY = key;                   // bumped so memoised lattice spacings are recomputed, not served stale
}
let ORE_SIZE_KEY = process.env.ORE_SIZE || 'big';
// ⭐ PINCH-AND-SWELL — the third option, and the one that is actually how ore occurs. A real vein is not a
// ribbon of constant width: it swells into lenses and pinches almost shut between them (a geologist calls the
// lenses boudins), because the fracture it fills opened by different amounts along its length. So the vein stays
// long — which is what makes it a thing you can FOLLOW, the whole reason veins are worth having — while reading
// as a chain of pods rather than a painted stripe.
// ⚠️ A FUNCTION OF THE ROW ONLY. The moment it reads `c` the body stops being the same body seen from every
// column that touches it, which is mistake #3 in the kickoff and the bug that rule exists to prevent.
let ORE_PINCH = +(process.env.ORE_PINCH === undefined ? 1 : process.env.ORE_PINCH);
const setOrePinch = (v) => { ORE_PINCH = v ? 1 : 0; STAMPS = null; };
// How much of the half-width survives at the tightest pinch, and how long a swell-to-swell period is in cells.
let PINCH_MIN = 0.35, PINCH_LEN = 34;
// How far apart the swells are, in cells. THIS is the knob that breaks a vein up — shorter period, more necks
// along the same length. (Pinch DEPTH, measured over 0.08/0.18/0.35, barely reads at all.)
const setOrePinchLen = (v) => { PINCH_LEN = v; STAMPS = null; };
// ⭐⭐ A TRUE GAP, NOT A THIN NECK. Where the pinch falls below this the vein is ABSENT — no cells at all —
// rather than being drawn very narrow. Found necessary once the dash fix landed: making narrow necks solid also
// made them *present*, so "neck every 16" and "neck every 10" came out looking the same, a wobble in width
// rather than a chain of separate pods. Thin necks give dashes; solid necks give a ribbon; only a gap gives
// pods with clean edges. 0 = off (a continuous vein that merely varies in width).
let PINCH_CUT = 0;
const setOrePinchCut = (v) => { PINCH_CUT = v; STAMPS = null; };
// How tight the tightest pinch gets, as a fraction of the vein's half-width. Lower = the vein parts into
// separate pods; higher = it stays a continuous ribbon that merely varies.
const setOrePinchMin = (v) => { PINCH_MIN = v; STAMPS = null; };
// 🟥 AND A FLOOR IN ABSOLUTE CELLS, because a FRACTION of a half-width is not a width. A vein's `hw` goes down
// to 3, so a pinch to 0.18 of it is 0.54 of a cell — the body thins below one cell and renders as a DOTTED
// 1-cell line. It was invisible while the pinched panels were 23-38% under-dense and appeared the moment the
// densities were matched and there were more veins to see: speckle, which is exactly what `probe_worldgen` D9
// exists to keep out of the world. The pinch may narrow a vein; it may not turn it into dashes.
const PINCH_FLOOR = 1.1;
// ⭐ A MINERAL MAY OVERRIDE ITS SHAPE'S SIZE, because "some you would expect in large singular veins and others
// in small pockets" is a fact about the MINERAL, not only about the shape (user, 2026-08-08). The shape says
// what KIND of thing it is; this says how big that kind gets for this one. Absent, the shape's default stands.
const sizeOf = (m) => m.body || SHAPE_SIZE[m.shape];
// ⚠️ The lattice spacing is derived from THIS, so an override moves the spacing with it and the mineral keeps
// the share of the rock its `rarity` promises. Two numbers describing one body would be mistake #2.
const meanArea = (m) => { const s = sizeOf(m); return Math.PI * ((s.hw[0] + s.hw[1]) / 2) * ((s.hgt[0] + s.hgt[1]) / 2); };
// The envelope, shared by the node builder (which must size its reach for it) and the cell test.
// ENV_SLOP is how far past the nominal half-width the field is still allowed to place material.
const ENV_SLOP = 0.55, ENV_MAX = (1 + 0.55) * (1 + 0.55);
// At the node `env` is 1 and the threshold is easily met; at the edge only the field's own peaks survive.
const ENV_GAIN = 0.62, ENV_T = 0.68;
// Below this half-width a body stops being noise-eroded, ramping smoothly so nothing pops. 4 cells ≈ the width
// at which there is room for a noise feature across the body at all.
const ENV_SOLID_W = 4;
// ⭐⭐ HOW MUCH OF ITS ENVELOPE A BODY ACTUALLY FILLS, MEASURED — not guessed, and it has to be here or `rarity`
// silently stops meaning what the catalogue says. The lattice spacing is derived from "a body covers this many
// cells", and once the shape comes from a thresholded field rather than a solid ellipse, a body only fills part
// of its envelope. Without this correction the world came out at 5.36% ore against the field mode's 11.62% —
// i.e. every mineral at 0.46x its stated rarity, uniformly, which is exactly the kind of quiet miscalibration
// that made ten of sixteen landform contracts place nowhere.
// ⚠️ MEASURED BY `probe_ore_census` against the field mode over 1.28M cells and set so the totals agree; it is a
// property of ENV_GAIN/ENV_T and the noise's own distribution, not of any mineral, which is why it is one
// number. Re-measure it if either of those moves.
// 0.46 -> 0.32 -> 0.24 over three iterations: the relation is NOT linear, because tightening the spacing makes
// bodies of one mineral overlap and overlapping cells do not add. Converged against the field mode's own total.
// ⭐ RE-CONVERGED 0.24 -> 0.283 on 2026-08-09, when "J" became the default. Pinch-and-swell removes material
// from inside a body's envelope and the narrow-body erosion fade (`ENV_SOLID_W`) puts some back, so the number
// this constant exists to hold — ore per unit rock, matching the field mode — had moved. Measured over three
// 400x260 windows: **field 71,528 cells vs J 72,684, i.e. 1.6%**, against 17.9% before.
// ⚠️ THE CURVE IS FLAT HERE: 0.283 -> 0.300 is a 6% change in this constant for a 0.5% change in the result
// (1.6% -> 1.1%), i.e. the overlap term now dominates. Do not chase the last percent; re-converge only if the
// body SHAPE changes again, which is what actually moves it.
const ORE_FILL = 0.283;
// Per-mineral lattice spacing, memoised on the record. Clamped: below ~40 the bodies would overlap their own
// lattice cell, and above ORE_LAT_MAX a mineral becomes so sparse that a player would never meet one.
// 🟥 `ORE_LAT_MIN` IS A PROPERTY OF THE SIZE TABLE, NOT A CONSTANT — found 2026-08-09 by the matched size table
// coming out at a QUARTER of the field mode's ore. Its own justification is *"below this the bodies would
// overlap their own lattice cell"*, which is a statement about how big a body is; with bodies ~3.3x smaller
// linearly, a floor of 40 stops the lattice tightening enough to compensate and the ore simply goes missing.
// It bound 6 of 29 minerals — and they were quartz, iron, copper and crystal, i.e. the COMMON ones that carry
// most of the cells, so the loss was concentrated exactly where it is most visible.
// ⚠️ A clamp that silently swallows the thing it is clamping is the same shape as the ten landform contracts
// that placed nowhere: nothing errors, the number just quietly stops meaning what the catalogue says.
// ⭐ DERIVED FROM THE TABLE, not tabulated against it. Two hand-picked values existed (40 for the original sizes,
// 12 for the matched ones) and this rule reproduces both — 0.9 x the side of a square of the largest shape's
// mean area: original veins give 38, matched give 13. Deriving it means an INTERMEDIATE size table gets a
// sensible floor without anyone remembering to add a row, which is exactly how the constant went stale the
// first time.
const oreLatMinFor = (T) => {
  let a = 0;
  for (const k in T) { const z = T[k]; a = Math.max(a, Math.PI * ((z.hw[0] + z.hw[1]) / 2) * ((z.hgt[0] + z.hgt[1]) / 2)); }
  return Math.max(4, Math.round(0.9 * Math.sqrt(a)));
};
let ORE_LAT_MIN = oreLatMinFor((process.env.ORE_SIZE || 'big') === 'match' ? SHAPE_SIZE_MATCH : SHAPE_SIZE_BIG);
const ORE_LAT_MAX = 900;
// ⚠️ THE SPACING IS QUANTISED SO THE LATTICE TILES THE PERIOD (`nlat`) — a whole number of nodes across the
// world, so a body sitting on the join is the same body from both sides. The spacing itself moves by <0.1%;
// snapping it to a power of two instead would have moved a 900-column lattice to 512.
// ⭐ `m._latN` is the node COUNT, which is what the hash index wraps at. Stored beside the spacing so the two
// cannot drift apart — the same argument as memoising the gain and the size key below.
function oreLattice(m) {
  let s = m._lat;
  if (s === undefined) {
    const want = Math.sqrt(meanArea(m) * ORE_FILL / Math.max(1e-4, m.rarity * ORE_GAIN));
    const L = nlat(Math.max(ORE_LAT_MIN, Math.min(ORE_LAT_MAX, Math.round(want))));
    s = m._lat = L.s; m._latN = L.n; m._latL = L;
    m._latGain = ORE_GAIN; m._latSize = ORE_SIZE_KEY;
    // ⚠️ THE SIZE KEY IS MEMOISED ALONGSIDE THE GAIN, for the reason already written above the gain check: a
    // spacing computed under one size table is wrong under another, and a stale memo reading as a broken
    // mechanism is the single most repeated mistake on this track.
  } else if (m._latGain !== ORE_GAIN || m._latSize !== ORE_SIZE_KEY) {   // either moved: recompute, never serve stale
    m._lat = undefined; return oreLattice(m);
  }
  return s;
}

// ⚠️ EVERYTHING A NODE NEEDS, READ FROM THE COARSE ARRAYS. `columnInfo` is not called here and must not be: it
// costs a dozen noise fields, and a node is asked about from up to ORE_MAXHW columns away, so it would drag the
// full column reader into a neighbour's chunk. The coarse fields are exact at this resolution anyway — a body is
// tens of cells across and a coarse sample is 64.
// ⭐⭐ A DIRECT-MAPPED CACHE, NOT A Map, AND THE DIFFERENCE IS MEASURABLE. The first version used a `Map` keyed
// on (mineral, nx, ny); profiled, `oreNodeAt` plus `oreBodiesNear` came to 13% of the whole generator and almost
// all of it was Map machinery — ~480 lookups per column, each a hash of a computed key. That is increment 2's
// lesson on the server repeated exactly: a two-level DENSE directory measured 1.04-1.06x there where a `Map`
// measured 1.32-1.47x, and the note reads "a hash lookup does not belong on the hottest read in the server".
// ⚠️ A direct-mapped cache can COLLIDE — two different nodes landing on one slot — so the key is stored beside
// the value and compared. A collision costs a recompute, never a wrong answer, which is the only acceptable
// failure mode for a cache over a pure function.
const ORE_CN = 8192, ORE_CM = ORE_CN - 1;
// ⚠️⚠️ ONE DEFINITION OF "THROW THE CACHE AWAY", exported, because three previewers were each resetting a field
// by NAME (`C._oreMemo = null`) and the rename to a direct-mapped pair silently made all three no-ops — a stale
// node record served under a different gain, which is a broken measurement wearing the mask of a broken
// mechanism, the single most repeated mistake on this track. Anything that changes the mode or the gain calls
// this; nothing reaches inside.
const oreCacheClear = (C) => { C._oreK = undefined; C._oreV = undefined; C._oreWB = undefined; };
function oreNodeAt(m, mi, W, C, seed, nx, ny) {
  // ⚠️ The mineral's index is part of the key. Two minerals have different lattices, so (nx, ny) alone names
  // two different places — a cache keyed without it would serve one mineral's body as another's.
  // 🟥 THE FIRST KEY WAS `((ny * 8388608 + nx) * 64 + mi) | 0` AND IT OVERFLOWED. ny reaches ~40 at the world
  // floor, so that product passes 2^31 and `|0` WRAPS — unrelated nodes landed on the same key, the cache
  // missed almost every time AND the identity check stopped being reliable. Measured: 14.22 ms/chunk against
  // 8.84 for the Map it was supposed to beat, which is how it was caught. A cache that is slower than no cache
  // is a broken measurement waiting to be blamed on the mechanism.
  // ⭐ Mixed with `Math.imul`, which is int32 by definition, so there is nothing to overflow.
  const key = (Math.imul(nx, 73856093) ^ Math.imul(ny, 19349663) ^ Math.imul(mi + 1, 83492791)) | 0;
  let K = C._oreK;
  if (K === undefined) { K = C._oreK = new Int32Array(ORE_CN).fill(-2147483648); C._oreV = new Array(ORE_CN); }
  const i = (key ^ (key >>> 15)) & ORE_CM;
  if (K[i] === key) return C._oreV[i];
  const v = oreNodeCompute(m, mi, W, C, seed, nx, ny);
  K[i] = key; C._oreV[i] = v;
  return v;
}
function oreNodeCompute(m, mi, W, C, seed, nx, ny) {
  const S = oreLattice(m);
  const salt = 9800 + mi * 8;
  // ⭐ THE NODE'S IDENTITY IS ITS WRAPPED COLUMN INDEX; ITS POSITION IS ITS UNWRAPPED ONE. That split is the
  // whole of periodicity for a placed record: `xw` decides what the body IS (size, dip, stamp), `nx` decides
  // where it sits, and a node one period along is therefore the same body at a column one period along.
  // ⚠️ `ny` is a ROW index and is deliberately not wrapped.
  const ORE_L = m._latL, xw = wrapL(nx, ORE_L.n);
  // the body's centre: the lattice node, jittered inside its own cell so the set does not read as a grid
  const cx = latAt(ORE_L, nx) + Math.round((hh(seed, salt, xw, ny) - 0.5) * S * 0.8);
  const cy = Math.round(ny * S + (hh(seed, salt + 1, xw, ny) - 0.5) * S * 0.8);
  // ⚠️ THE OLD `cx < 0` REJECTION HAD TO GO, and it is not cosmetic: on a ring the node just left of column 0 is
  // the same node as the last one in the world, and rejecting one of the pair is exactly a world that does not
  // repeat. A negative `cx` is now an ordinary body whose right half reaches across the join.
  if (cy < 0) return null;
  // ⚠️ WRAPPED, not clamped. `cx` is an absolute column and can sit past the end of the coarse arrays; clamping
  // gave every body beyond the world the LAST sample's rock and climate — the same defect `probe_periodic`
  // found in `computeColumn`'s sample lookup, one file over.
  const gi = ((Math.round(cx / W.dx) % W.n) + W.n) % W.n;
  const surfRow = Math.round(C.seaRow - W.h[gi]);
  const d = cy - surfRow;
  if (d < 2) return null;                                        // above ground is not ore country
  // ⭐ THE FOUR AXES, UNCHANGED AND ASKED ONCE PER BODY INSTEAD OF ONCE PER CELL. This is the whole of what the
  // mineral table claims — host rock, depth band, context — and it is applied here verbatim so the two modes
  // cannot disagree about where a mineral BELONGS, only about what shape it takes when it is there.
  if (d < m.depth[0] || d > m.depth[1]) return null;
  const lith = W.lith[gi];
  const hm = hostMask(m); if (hm && !hm[lith]) return null;
  const moist = W.clim.moist[gi], temp = W.clim.temp[gi];
  const feat = C.featAt[gi];
  if (m.volcanic && !(C.volc && C.volc.some(V => Math.abs(wdc(cx - V.at)) < 2600))) return null;
  if (m.crater && !(feat && feat.type === 'crater')) return null;
  if (m.arid && moist > 0.32) return null;
  if (m.hot && !(moist > 0.6 && temp > 0.6)) return null;
  // ── SIZE ──────────────────────────────────────────────────────────────────────────────────────────────────
  // ⚠️ Ranges read from SIZE_OF, which is also what sets the lattice spacing, so "how big is a body" is stated
  // once. A mineral may override its shape's default — see the note on `body` in the catalogue.
  const u = hh(seed, salt + 4, xw, ny), u2 = hh(seed, salt + 5, xw, ny);
  const sz = sizeOf(m);
  // ⭐ THE SIZE RANGE IS WALKED WITH A CUBED ROLL, not a flat one. A flat roll makes every body a middling one;
  // real ore bodies are mostly small with the occasional large one, and it is the large one that is worth
  // finding. Same reasoning as the cave-width field being a cube.
  const hw = Math.round(sz.hw[0] + u * u * u * (sz.hw[1] - sz.hw[0]));
  const hgt = Math.round(sz.hgt[0] + u2 * u2 * u2 * (sz.hgt[1] - sz.hgt[0]));
  // ── ATTITUDE ──────────────────────────────────────────────────────────────────────────────────────────────
  // 🟥 EVERY VEIN OF A MINERAL USED TO LEAN AT EXACTLY THE SAME ANGLE. `dip` is a per-MINERAL constant in the
  // catalogue and the only variation was a mirror, so a field of quartz veins came out as a set of parallel
  // strokes with a few mirrored ones — the user spotted it in the render immediately.
  // ⭐ A vein follows a FRACTURE, and fractures in one district do share a structural trend — so the trend is a
  // slow field across the world (one noise read at the node) and each body scatters widely about it. That gives
  // both truths at once: veins in one place rub along together, and no two are parallel.
  // ⚠️ `m.dip` is kept as the mineral's OWN bias about how steeply it sits, added to the regional trend rather
  // than replacing it, so the catalogue still says something.
  // ⚠️ THE REGIONAL TREND IS A GENTLE BIAS, NOT THE ANSWER, and the first balance had it the other way round.
  // At a 2,600-column wavelength the trend is essentially CONSTANT across any window a player can see, so
  // weighting it heavily reproduced the very complaint this change exists to fix: a field of parallel strokes,
  // just leaning at a different angle from before. Shorter wavelength so it varies within a view, and most of
  // the spread now comes from the body's own draw.
  const trend = (n1(seed, 9790, cx * nd(900).q, nd(900).p) - 0.5) * 0.7;
  // ⚠️ CLAMPED, and the assertion below is what found that it had to be. A vein is a STEEPLY inclined body —
  // |dip| 1.0 is already 45 degrees off vertical — and an unclamped sum of trend, catalogue bias and jitter
  // reached 1.9, which is a nearly-flat sheet 150 rows long and a 325-column reach. The guard on ORE_MAXHW
  // threw rather than silently clipping it, which is the whole reason that check is a throw and not a comment.
  const dip = m.shape === 'vein'
    ? cl(trend + (m.dip || 0.3) * (hh(seed, salt + 6, xw, ny) - 0.5) * 2 + (hh(seed, salt + 7, xw, ny) - 0.5) * 1.7, -1, 1)
    : (hh(seed, salt + 6, xw, ny) - 0.5) * 0.7;
  // ⭐ AND THE ENVELOPE'S OWN CHARACTER VARIES PER BODY, so two veins of the same mineral are not the same
  // stroke at different angles: how far it wanders, how tight it is, and how far the noise is allowed to push
  // its outline are all drawn here.
  const wob = (m.shape === 'vein' ? 1.1 : 0.3) * (0.4 + 1.6 * hh(seed, salt + 8, xw, ny));
  const wobLen = 18 + 46 * hh(seed, salt + 9, xw, ny);           // the wavelength of that wander
  const grain = 0.7 + 1.1 * hh(seed, salt + 10, xw, ny);         // how coarse the outline noise is
  // ⚠️⚠️ THE BODY'S OWN COLUMN REACH, COMPUTED HERE AND USED BY BOTH THE SHORTLIST AND THE CELL TEST. Every
  // term that can push a cell away from the axis has to appear, or the shortlist CLIPS the body at exactly the
  // point that term takes it furthest — a straight vertical cut down the side of an ore body, the
  // conservative-bound rule broken in the one direction that is not allowed.
  const reach = Math.ceil(hw * (wob + 1.0 + ENV_SLOP) + Math.abs(dip) * hgt) + 3;
  // ── everything `stamps` mode needs, decided ONCE PER BODY so the cell test is a lookup ────────────────────
  // ⚠️ Pure functions of the node, like every other property here — a stamp chosen from the asking column would
  // be mistake #3 in its purest form, the body changing identity depending on who looked at it.
  // ⭐ Rotation is stored as its cos/sin rather than its angle, so the cell test never calls a trig function.
  // The angle carries the same regional trend the dip does, so a stamped world has the same structural grain.
  const ang = Math.atan(dip) * (m.shape === 'vein' ? 1 : 0.35) + (hh(seed, salt + 11, xw, ny) - 0.5) * 0.5;
  const fx = 1 / (0.75 + 0.5 * hh(seed, salt + 12, xw, ny));     // aspect jitter, independent per axis
  const fy = 1 / (0.75 + 0.5 * hh(seed, salt + 13, xw, ny));
  // ⚠️ The rotation and the aspect both push cells OUTSIDE the unrotated envelope, so the reach the shortlist
  // uses has to allow for them or bodies are clipped at the scan boundary — the rule that has now caught me
  // twice on this file. sqrt(2) covers any rotation of the box; the aspect divisors are at most 1/0.75.
  const rot = Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang))) + Math.min(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang)));
  const reachY = Math.ceil((hgt / 0.75) * rot) + 3;
  const fscale = m.shape === 'vein' ? 11 : (m.size || 13);
  const FQ = nfreq(1 / (fscale * grain));
  return { mat: m.mat, key: m.key, shape: m.shape, cx, cy, hw, hgt, dip, wob, wobLen, grain, host: hm,
    cls: STAMP_CLASS[m.shape], stamp: (hh(seed, salt + 14, xw, ny) * STAMP_N) | 0,
    cos: Math.cos(ang), sin: Math.sin(ang), fx, fy, reachY,
    reach: Math.max(reach, Math.ceil((hw / 0.75) * rot) + 3),
    // the mineral's own field parameters, carried onto the body so the CELL test can reproduce the noise
    // mode's texture locally rather than inventing a second description of what this mineral looks like
    fscale: fscale, foct: m.shape === 'massive' ? 3 : 2,
    // ⭐ the body's own x frequency, quantised ONCE here rather than per cell: `grain` is a float drawn per body,
    // so a shared `nd()` Map keyed on it would grow an entry per body and still cost a hash lookup per cell.
    fq: FQ.q, fp: FQ.p,
    fsalt: m.salt, salt: salt + 12 + ((xw * 31 + ny * 17) & 511) };
}

// ⭐ THE PER-COLUMN SHORTLIST — the bodies that can reach this column within the rows being generated. Same
// discipline as every other `*Near` on this track, and the reason the per-cell cost is a bounded box test.
// ⚠️ The row window is what makes it cheap: a 64-row chunk touches two or three lattice rows, not forty.
// ⭐⭐ GATHERED ONCE PER 64-COLUMN BLOCK, NOT ONCE PER COLUMN — and this is where the cost actually was.
// The lattice walk is ~480 node lookups per column; measured, the stamp roster (which makes the per-cell test
// almost free) only took the worst chunk from 7.9 to 7.6 ms, because the per-cell test was never the expensive
// part. The WALK was, and it was being repeated for all 64 columns of a chunk over a lattice that barely moves.
// ⚠️ The block is 64 columns because that is a chunk, so a chunk does the walk ONCE. The gathered list is
// widened by the block's own width, then filtered per column — filtering a short array is nothing.
// ⚠️ Keyed on (block, r0, rN) and stored on `C`, so a different row window rebuilds it. Getting that wrong
// would serve a shallow chunk's bodies to a deep one.
const ORE_BLK = 64;
function oreBodiesNear(MIN, W, C, seed, c, r0, rN) {
  const blk = Math.floor(c / ORE_BLK);
  if (C._oreWB !== blk || C._oreWR !== r0 || C._oreWN !== rN) {
    C._oreWB = blk; C._oreWR = r0; C._oreWN = rN;
    C._oreW = oreBodiesInBlock(MIN, W, C, seed, blk * ORE_BLK, r0, rN);
  }
  const W2 = C._oreW;
  if (W2.length === 0) return MIN_EMPTY;
  let out = null;
  for (let i = 0; i < W2.length; i++) { const B = W2[i]; if (c >= B.cx - B.reach && c <= B.cx + B.reach) (out || (out = [])).push(B); }
  return out || MIN_EMPTY;
}
function oreBodiesInBlock(MIN, W, C, seed, c0, r0, rN) {
  const c1 = c0 + ORE_BLK - 1;
  let out = null;
  for (let mi = 0; mi < MIN.length; mi++) {
    const m = MIN[mi];
    if (!isBody(m)) continue;
    const S = oreLattice(m);
    // ⚠️ The window is the mineral's OWN lattice. A rare mineral has a 900-column spacing, so this is usually
    // one or two nodes; a common one is tighter but its bodies are correspondingly closer together.
    const R = oreReachOf(m);
    const nx0 = Math.floor((c0 - R.rx) / S), nx1 = Math.ceil((c1 + R.rx) / S);
    const ny0 = Math.floor((r0 - R.ry) / S), ny1 = Math.ceil((r0 + rN + R.ry) / S);
    for (let nx = nx0; nx <= nx1; nx++) for (let ny = ny0; ny <= ny1; ny++) {
      const B = oreNodeAt(m, mi, W, C, seed, nx, ny);
      if (!B) continue;
      if (B.reach > R.rx) throw new Error('ore body reach ' + B.reach + ' exceeds ' + m.key + "'s scan window " + R.rx + ' — the shortlist would clip it');
      if (c1 < B.cx - B.reach || c0 > B.cx + B.reach) continue;
      (out || (out = [])).push(B);
    }
  }
  return out || EMPTY_ARR;
}
const EMPTY_ARR = [];

// The cell answer for the body mode. ⚠️ `lith` is still tested PER CELL, because `lithAtRow` jitters the rock
// contact in both axes — a body straddling a contact is cut off by it, which is what a real ore body does.
// ==============================================================================================================
//  ⭐⭐ THE STAMP ROSTER — `ORE='stamps'`. The user's proposal, and it is the right shape of answer.
//
//  THE OBSERVATION: the noise is only ever asked one question — "is this cell inside the body?" — and the answer
//  for a body of a given shape is the SAME PICTURE every time. So draw that picture once and look it up.
//
//  ⭐ AND THE SHAPES ARE BAKED FROM THE NOISE ITSELF, which is what makes this not a downgrade: each stamp is
//  produced by exactly the envelope-plus-fBm rule the `bodies` mode evaluates per cell, run once into a bitmap
//  at startup. The organic branching, swelling and splitting is preserved because it is literally the same
//  algorithm — only the arithmetic moves from the inner loop to a table.
//
//  ⭐⭐ ROSTER SIZE COSTS MEMORY, NOT TIME, which is the answer to "the larger the roster the less obvious the
//  repetition". 128 stamps and 8 stamps cost exactly the same per cell: one bounds test and one array read.
//  128 stamps at 96x96 is 1.1 MB, built once for the PROCESS (from a fixed seed, not the world's), so a second
//  world pays nothing at all.
//
//  ⚠️ AND THE REPETITION IS BROKEN FOUR WAYS BEFORE THE ROSTER EVEN MATTERS: each body picks its stamp, its
//  horizontal and vertical flip, its aspect ratio and its rotation independently. 128 stamps x 4 flips x a
//  continuous scale and angle is not a set anyone will read as a repeat — and if it ever is, the fix is a bigger
//  roster, which is free.
// ==============================================================================================================
const STAMP_N = +(process.env.STAMP_N || 128);
// 🟥🟥 THE NEEDLES WERE A SQUARE BITMAP STRETCHED 13:1, NOT A LIMITATION OF STAMPING. Diagnosed 2026-08-09 by
// rendering the three modes and looking, after the user pointed out that the rejection had never been examined
// and that there is no reason a stamp cannot reproduce the field's blobs. They were right, and there are two
// compounding causes, both in the BAKE rather than in the idea:
//
//  1. ⭐ THE GRID WAS SQUARE AND THE BODIES ARE NOT. Every stamp was 96x96 with a CIRCULAR envelope, then mapped
//     onto a body of `hw` x `hgt`. A vein is hw 3-10 by hgt 24-150, so those 96 columns were squeezed onto ~13
//     cells (7.4x MINIFICATION) while the 96 rows were stretched over ~174 (1.8x magnification). Point-sampled,
//     a 7x minification collapses each output column onto one 1px slice of the stamp, and the 1.8x stretch then
//     draws that slice out long. That is the needle, exactly.
//  2. ⭐ THE BAKED NOISE WAS ISOTROPIC AND THE FIELD MODE'S IS NOT. `mineralAt`'s vein case is
//     `fb2(seed, salt, c / 11, elev / 26, 2)` — features 11 cells wide and 26 tall. The bake used one `fs` for
//     both axes, so even before the stretch it was not drawing the same shape the field mode draws.
//
// ⇒ EACH CLASS NOW BAKES ON A GRID MEASURED IN CELLS, at the geometric mean of its own size range, using the
// field mode's own per-axis feature scales. Scale at the cell test is then ~1 on both axes for a typical body
// and the sampling is no longer minifying, so the shapes survive. Fine detail below one cell is still not
// drawn — but it was never visible; it was the thing that was aliasing.
// ⚠️ Sized at the GEOMETRIC mean, not the arithmetic one: `vein.hgt` spans [24,150] and the arithmetic mean (87)
// sits close to the top, which would leave every small vein minifying — the bad direction. Magnification is
// merely blocky and despeckle absorbs it; minification is what produced the artefact.
const gmean = (a, b) => Math.round(Math.sqrt(a * b));
const STAMP_SEED = 20260808;                      // fixed: the roster is not a property of any one world
let STAMPS = null;                                // [class][index] -> Uint8Array(W*H) at that class's own dims
let STAMP_DIMS = null;                            // [class] -> [W, H], in CELLS (set by buildStamps)
const STAMP_CLASS = { vein: 0, pocket: 1, massive: 2 };
// ⭐ A 3x3 MAJORITY VOTE, twice. Removes lone pixels and fills lone holes, which is what makes an edge read as
// an edge rather than as sparkle. ⚠️ Run at BAKE time, so it costs nothing per cell — the whole argument for a
// roster is that expensive smoothing becomes free once the shape is a table.
function despeckle(m, W, H) {
  let a = m;
  for (let pass = 0; pass < 2; pass++) {
    const b = new Uint8Array(a.length);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += a[(y + dy) * W + x + dx];
      b[y * W + x] = n >= 5 ? 1 : 0;                       // majority of the 9
    }
    a = b;
  }
  return a;
}
function buildStamps() {
  if (STAMPS) return STAMPS;
  STAMPS = [[], [], []];
  // Per class, the generation parameters that give it its character. A vein is long, narrow and wandering; a
  // pocket is round and lobed; a massive body is broad and blocky. ⚠️ These are the SAME numbers the per-cell
  // form uses, so a stamp is not a second opinion about what a vein looks like.
  // 🟥 THE FIRST ROSTER SPECKLED, and the user saw it immediately: "the stamps don't look particularly good,
  // ideally they would just look like the blobs in the original noise field". It is MINIFICATION ALIASING — a
  // 96px stamp carrying ~9 noise features across it, point-sampled onto a body only 8-20 cells wide, so every
  // read lands on a different lobe and the edge dissolves into sparkle.
  // ⭐ TWO FIXES, both free because they happen once at bake time rather than per cell:
  //   1. COARSER LOBES (`fs` roughly doubled). An ore blob is a few lobes, not a fractal — and the field mode's
  //      blobs are smooth at cell scale, which is exactly what we are trying to reproduce. Fine detail that
  //      cannot survive the scale it is drawn at is not detail, it is noise.
  //   2. A DESPECKLE PASS below, which removes isolated pixels and fills isolated holes.
  // ⭐ `fsx`/`fsy` are the FIELD MODE's own feature scales, in cells, copied from `mineralAt`: a vein is
  // `fb2(…, c / 11, elev / 26, 2)`, a pocket and a massive body use `m.size` (default 13) with the massive one
  // stretched by /0.7 vertically. A stamp is meant to be the same picture cached, so it must be drawn with the
  // same numbers — using one isotropic `fs` was a second description of what a vein looks like, which is
  // mistake #2 in the kickoff.
  const CLS = [
    { sz: SHAPE_SIZE.vein,    fsx: 11, fsy: 26,   oct: 2, wob: 1.1, wl: 26 },
    { sz: SHAPE_SIZE.massive, fsx: 13, fsy: 18.6, oct: 3, wob: 0.3, wl: 22 },
    { sz: SHAPE_SIZE.pocket,  fsx: 13, fsy: 13,   oct: 2, wob: 0.3, wl: 30 },
  ];
  STAMP_DIMS = CLS.map((P) => [Math.max(8, 2 * gmean(P.sz.hw[0], P.sz.hw[1])), Math.max(8, 2 * gmean(P.sz.hgt[0], P.sz.hgt[1]))]);
  for (let k = 0; k < 3; k++) {
    const P = CLS[k], W = STAMP_DIMS[k][0], H = STAMP_DIMS[k][1], HW = W >> 1, HH = H >> 1;
    for (let s = 0; s < STAMP_N; s++) {
      const m = new Uint8Array(W * H);
      const salt = 400 + k * 4096 + s * 13;
      // each stamp gets its own wander, grain and envelope aspect, so the roster itself is varied
      const grain = 0.7 + 1.1 * hh(STAMP_SEED, salt, 1, 0);
      const wobA = P.wob * (0.4 + 1.6 * hh(STAMP_SEED, salt, 2, 0));
      const wobL = P.wl * (0.6 + 1.2 * hh(STAMP_SEED, salt, 3, 0));
      for (let y = 0; y < H; y++) {
        const dy = y - HH;
        // ⚠️ The wander is a displacement in CELLS across the body's width, so it scales with HW (the half
        // WIDTH) — not with a single half-size, which on a tall stamp would swing a vein clean out of its own
        // envelope. Its wavelength is in cells down the body, so it is not rescaled at all.
        const wander = (n1(STAMP_SEED, salt + 5, dy / wobL) - 0.5) * HW * wobA * 0.9
                     + (n1(STAMP_SEED, salt + 6, dy / (wobL * 0.3)) - 0.5) * HW * wobA * 0.3;
        // PINCH-AND-SWELL, baked. Same rule as the per-cell path, in stamp rows rather than world rows — a
        // stamp row IS a cell row now that the grid is cell-proportioned, which is what makes the two agree.
        let ph = HW, cut = 0;
        if (ORE_PINCH && k === 0) {
          const pf = PINCH_MIN + (1 - PINCH_MIN) * n1(STAMP_SEED, salt + 7, y / PINCH_LEN);
          if (PINCH_CUT && pf < PINCH_CUT) cut = 1; else ph = Math.max(PINCH_FLOOR, HW * pf);
        }
        if (cut) continue;
        for (let x = 0; x < W; x++) {
          const px = (x - HW) - wander;
          const q2 = (px / ph) * (px / ph) + (dy / HH) * (dy / HH);   // the envelope is the body's ELLIPSE now
          if (q2 > ENV_MAX) continue;
          const env = 1 - Math.sqrt(q2) * Math.min(1, ph / ENV_SOLID_W);   // same narrow-body rule as the cell test
          const f = fb2(STAMP_SEED, salt + 40, x / P.fsx / grain, y / P.fsy / grain, P.oct);
          if (f + env * ENV_GAIN > ENV_T) m[y * W + x] = 1;
        }
      }
      STAMPS[k].push(despeckle(m, W, H));
    }
  }
  return STAMPS;
}

// The cell answer for `stamps` mode. ⚠️ Everything expensive is PER BODY and already on the record: the stamp,
// its flips, and the cos/sin of its rotation. Per cell this is ten arithmetic operations and one array read,
// against roughly fifty for a two-octave fBm.
function oreStampAt(bodies, c, r, lith) {
  const R = buildStamps();
  for (let i = 0; i < bodies.length; i++) {
    const B = bodies[i];
    const dy0 = r - B.cy;
    if (dy0 < -B.reachY || dy0 > B.reachY) continue;
    if (B.host && !B.host[lith]) continue;
    const dx0 = c - B.cx;
    // rotate into the stamp's frame (cos/sin precomputed on the record), then scale to the stamp's half-size
    const px = dx0 * B.cos + dy0 * B.sin, py = -dx0 * B.sin + dy0 * B.cos;
    // ⚠️ Per-class dims — the stamp is no longer square (see the note on the roster). The body's half-size still
    // maps onto the stamp's half-size, so a body at the class's typical size samples it at about 1:1.
    const D = STAMP_DIMS[B.cls], W = D[0], H = D[1], HW = W >> 1, HH = H >> 1;
    const sx = (px / B.hw) * B.fx * HW + HW;
    if (sx < 0 || sx >= W) continue;
    const sy = (py / B.hgt) * B.fy * HH + HH;
    if (sy < 0 || sy >= H) continue;
    if (R[B.cls][B.stamp][(sy | 0) * W + (sx | 0)]) return B.mat;
  }
  return -1;
}

function oreBodyAt(bodies, c, r, lith, seed) {
  if (ORE_MODE === 'stamps') return oreStampAt(bodies, c, r, lith);
  for (let i = 0; i < bodies.length; i++) {
    const B = bodies[i];
    const dy = r - B.cy;
    if (dy < -B.hgt - 2 || dy > B.hgt + 2) continue;              // cheap box reject before any noise
    if (B.host && !B.host[lith]) continue;
    // ⭐ THE AXIS WANDERS — a vein follows a fracture, not an ellipse. ⚠️ A function of the ROW ONLY: the moment
    // it reads `c` the body stops being the same body from every column that touches it, which is mistake #3.
    // Its amplitude and wavelength are per BODY (`wob`, `wobLen`), so two veins of one mineral snake differently.
    const wander = (n1(seed, B.salt + 5, r / B.wobLen) - 0.5) * B.hw * B.wob * 2.2
                 + (n1(seed, B.salt + 6, r / (B.wobLen * 0.3)) - 0.5) * B.hw * B.wob * 0.7;
    // PINCH-AND-SWELL: the half-width itself varies down the body. Row-only, like the wander above.
    let hw = B.hw;
    if (ORE_PINCH && B.shape === 'vein') {
      const pf = PINCH_MIN + (1 - PINCH_MIN) * n1(seed, B.salt + 7, r / PINCH_LEN);
      if (PINCH_CUT && pf < PINCH_CUT) continue;                 // the vein has pinched right out here
      hw = Math.max(PINCH_FLOOR, B.hw * pf);
    }
    const px = (c - B.cx) - dy * B.dip - wander;
    if (Math.abs(px) > hw * (1 + ENV_SLOP)) continue;
    // ⭐⭐ THE SHAPE COMES BACK FROM THE MINERAL'S OWN NOISE FIELD, and this is the answer to the real objection.
    //
    // The lattice fixed the COST and the rarity fixed the MIX, but a body was still an ellipse with a wobble —
    // and the user's judgement was that the noise field's variability was the thing worth keeping: bodies that
    // branch, swell, pinch and split, and differ from one another in kind rather than only in size and angle.
    // A parametric outline cannot do that; a thresholded field does it for free, which is exactly why the field
    // mode looked right.
    //
    // ⇒ the ENVELOPE decides where a body may be (that is the lattice's job, and it is what makes this cheap);
    // the FIELD decides what it looks like inside. `env` is 1 at the node and 0 at the envelope edge, and it is
    // ADDED to the field before thresholding — so at the heart of a body the threshold is easily met and the ore
    // is solid, and towards the edge only the field's own high ground survives, which is what makes the outline
    // ragged, lobed and occasionally split into two.
    //
    // ⚠️ THE COST IS BOUNDED BY THE ENVELOPE, WHICH IS THE WHOLE POINT. This is the same fbm the field mode ran
    // at EVERY cell for EVERY mineral; here it runs only for a cell that is already inside some body's box,
    // which is a small percentage of the world and never more than a handful of minerals deep.
    const q2 = (px / hw) * (px / hw) + (dy / B.hgt) * (dy / B.hgt);
    if (q2 > ENV_MAX) continue;
    // 🟥 THE DASHES: A NARROW BODY IS ALL RIM. `env` is 1 on the axis and 0 at the envelope, and the fill
    // threshold is `ENV_T − env × ENV_GAIN` — so the middle of a body is solid and its edge is eroded down to
    // the noise's peaks. That is right for a body 20 cells wide and wrong for one 2 cells wide, where a single
    // cell off-axis is already at q2 ≈ 0.8 and being eroded: the vein comes apart into a dotted line.
    // ⇒ THE EROSION FADES OUT AS A BODY GETS TOO NARROW TO CARRY IT. Same principle the stamp bake already
    // records: detail that cannot survive the scale it is drawn at is not detail, it is noise.
    // ⚠️ Keyed on the PINCHED half-width, not the body's nominal one — the whole point is that the neck is the
    // part that was breaking up, and the neck is exactly where `hw` is smallest.
    const env = 1 - Math.sqrt(q2) * Math.min(1, hw / ENV_SOLID_W);
    // the mineral's own field, at its own scale, sheared by this body's dip so the texture leans with it
    // ⭐ THE SAME EARLY-OUT AS THE FIELD MODE, and it applies for the same reason: the only question asked of
    // this fBm is whether it clears a threshold. Here the threshold moves per cell (`ENV_T - env * ENV_GAIN`,
    // i.e. easy at the body's centre and hard at its rim) — which changes nothing, because the bound is
    // evaluated against whatever the threshold happens to be. Exact, so the bodies do not move.
    const need = ENV_T - env * ENV_GAIN;
    // ⭐ THE SHEAR IS MEASURED FROM THE BODY, NOT FROM COLUMN ZERO. `c * B.dip` in the y argument makes the
    // texture depend on how far the body is from the world's origin, so it could not repeat — and it was also
    // mistake #3 in miniature (a body that looks different depending on where in the world it happens to sit).
    // `wdc(c - B.cx)` is the same shear anchored on the body's own axis, which is what it always meant.
    const sy = (r + wdc(c - B.cx) * B.dip) / (B.fscale * 2.4) / B.grain;
    if (ORE_EARLY) { if (fb2Above(seed, B.fsalt, c * B.fq, sy, B.foct, need, B.fp)) return B.mat; continue; }
    const f = fb2(seed, B.fsalt, c * B.fq, sy, B.foct, B.fp);
    if (f > need) return B.mat;
  }
  return -1;
}

// ==============================================================================================================
//  THE TABLE. `rarity` is the fraction of qualifying rock that carries it — so it is comparable across shapes,
//  which a per-shape threshold would not be.
// ==============================================================================================================
function buildMinerals(M) {
  return [
    // ── bedded, in sediments: the things you follow sideways ────────────────────────────────────────────────
    { key: 'coal', mat: M.coal, host: [L.SHALE, L.SANDSTONE], depth: [60, 900], shape: 'seam',
      rarity: 0.42, period: 145, thick: 2.2, salt: 9100 },
    { key: 'oilshale', mat: M.oilshale, host: [L.SHALE], depth: [110, 1400], shape: 'seam',
      rarity: 0.20, period: 240, thick: 7, arch: 1, salt: 9110 },
    { key: 'opal', mat: M.opal, host: [L.SANDSTONE], depth: [40, 400], shape: 'seam', arid: 1,
      rarity: 0.10, period: 90, thick: 1.6, salt: 9120 },
    { key: 'hematite', mat: M.hematite, host: [L.SANDSTONE, L.SHALE], depth: [200, 1800], shape: 'massive',
      rarity: 0.020, size: 46, salt: 9130 },
    { key: 'pyrite', mat: M.pyrite, host: [L.SHALE], depth: [40, 1600], shape: 'disseminated',
      rarity: 0.010, salt: 9140 },
    // ── hydrothermal veins, in igneous rock: the lines you chase ────────────────────────────────────────────
    { key: 'quartz', mat: M.quartz, host: IGNEOUS, depth: [80, 2200], shape: 'vein',
      rarity: 0.075, dip: 0.55, salt: 9200 },
    { key: 'iron', mat: M.iron, host: IGNEOUS, depth: [100, 2200], shape: 'vein',
      rarity: 0.060, dip: 0.40, salt: 9210 },
    { key: 'copper', mat: M.copper, host: [L.GRANITE, L.BASALT], depth: [100, 1900], shape: 'vein',
      rarity: 0.045, dip: 0.70, salt: 9220 },
    { key: 'tin', mat: M.tin, host: [L.GRANITE], depth: [300, 2400], shape: 'vein',
      rarity: 0.022, dip: 0.85, salt: 9230 },
    { key: 'silver', mat: M.silver, host: [L.GRANITE, L.BASEMENT], depth: [400, 2600], shape: 'vein',
      rarity: 0.020, dip: 0.30, salt: 9240 },
    { key: 'gold', mat: M.gold, host: [L.GRANITE, L.BASEMENT], depth: [500, 2800], shape: 'vein',
      rarity: 0.006, dip: 0.62, salt: 9250 },
    { key: 'galena', mat: M.galena, host: [L.LIMESTONE, L.SHALE], depth: [300, 2000], shape: 'vein',
      rarity: 0.028, dip: 0.18, salt: 9260 },
    // ── pockets: the things you stumble into ────────────────────────────────────────────────────────────────
    { key: 'amethyst', mat: M.amethyst, host: [L.BASALT], depth: [200, 1600], shape: 'pocket',
      rarity: 0.008, size: 26, salt: 9300 },
    { key: 'emerald', mat: M.emerald, host: [L.GRANITE], depth: [700, 2800], shape: 'pocket',
      rarity: 0.0025, size: 18, salt: 9310 },
    { key: 'crystal', mat: M.crystal, host: [L.LIMESTONE], depth: [130, 2200], shape: 'pocket',
      rarity: 0.030, size: 30, salt: 9320 },
    { key: 'cinnabar', mat: M.cinnabar, host: IGNEOUS, depth: [100, 1000], shape: 'pocket', volcanic: 1,
      rarity: 0.006, size: 20, salt: 9330 },
    { key: 'sulphur', mat: M.sulphur, host: IGNEOUS.concat(SEDIMENT), depth: [50, 1200], shape: 'pocket', volcanic: 1,
      rarity: 0.010, size: 24, salt: 9340 },
    // ── the odd shapes ──────────────────────────────────────────────────────────────────────────────────────
    // ⭐ A KIMBERLITE IS A PIPE: a near-vertical carrot of ore from very deep, and the only shape in the table
    // you follow DOWN rather than along. It is also the rarest thing in the world, which is the point.
    { key: 'diamond', mat: M.diamond, host: [L.BASEMENT, L.GRANITE], depth: [1500, 3200], shape: 'pipe',
      rarity: 0.0015, salt: 9400 },
    { key: 'salt', mat: M.salt, unit: 1, host: [L.EVAPORITE], depth: [90, 2000], shape: 'massive',
      rarity: 0.22, size: 90, salt: 9410 },
    // ⭐ BAUXITE IS A CLIMATE ORE — it is what tropical rain leaves behind after it has dissolved everything
    // else out of the rock. So it is a BLANKET a few cells under the surface, and only in the wet tropics: the
    // one mineral in the table placed by the climate field rather than by the rock.
    { key: 'bauxite', mat: M.bauxite, host: SEDIMENT.concat(IGNEOUS), depth: [6, 70], shape: 'blanket',
      rarity: 0.30, hot: 1, salt: 9420 },
    // ⭐ MALACHITE IS THE WEATHERED CAP OF A COPPER VEIN — so it is placed by the SAME field, shallower. Two
    // minerals from one structure, which is how the real thing works and is why the table has an `over` clause.
    { key: 'malachite', mat: M.malachite, host: [L.GRANITE, L.BASALT], depth: [20, 150], shape: 'vein',
      rarity: 0.10, dip: 0.70, salt: 9220 },
    // ── THE FAMOUS ONES. ⭐ Added because they are famous, which is a real design reason: half of what makes
    // finding something feel like anything is recognising it. Each still declares a genuine association, so
    // they land where they belong rather than being sprinkled.
    // ⚠️ RUBY AND SAPPHIRE ARE THE SAME MINERAL — corundum — and the difference is what else is in it. That is
    // why they get different HOSTS rather than different rarities: ruby comes out of metamorphosed limestone,
    // sapphire out of basalt, which is exactly where the two are found.
    { key: 'ruby', mat: M.ruby, host: [L.LIMESTONE, L.BASEMENT], depth: [900, 2800], shape: 'pocket',
      rarity: 0.0022, size: 16, salt: 9500 },
    { key: 'sapphire', mat: M.sapphire, host: [L.BASALT, L.BASEMENT], depth: [700, 2600], shape: 'pocket',
      rarity: 0.0022, size: 16, salt: 9510 },
    { key: 'topaz', mat: M.topaz, host: [L.GRANITE], depth: [600, 2600], shape: 'pocket',
      rarity: 0.0035, size: 18, salt: 9520 },
    { key: 'lapis', mat: M.lapis, host: [L.LIMESTONE], depth: [600, 2400], shape: 'pocket',
      rarity: 0.0018, size: 18, salt: 9530 },
    { key: 'agate', mat: M.agate, host: [L.BASALT], depth: [150, 1400], shape: 'pocket',
      rarity: 0.010, size: 22, salt: 9540 },
    { key: 'uranium', mat: M.uranium, host: [L.GRANITE], depth: [800, 3000], shape: 'pocket',
      rarity: 0.0030, size: 20, salt: 9550 },
    // ⭐ AMBER IS FOSSIL RESIN, so it belongs in the same coal-bearing beds the coal seams are in — one more
    // mineral that comes from something the generator already places rather than from a new rule.
    { key: 'amber', mat: M.amber, host: [L.SHALE, L.SANDSTONE], depth: [60, 700], shape: 'pocket',
      rarity: 0.0030, size: 14, salt: 9560 },
    { key: 'jade', mat: M.jade, host: [L.BASEMENT], depth: [400, 2400], shape: 'vein',
      rarity: 0.009, dip: 0.25, salt: 9570 },
    { key: 'platinum', mat: M.platinum, host: [L.BASEMENT], depth: [1200, 3200], shape: 'vein',
      rarity: 0.0015, dip: 0.45, salt: 9580 },
    // ⭐ TURQUOISE IS A SECOND WEATHERED CAP, like malachite: it forms over copper, in ARID country, near the
    // surface. Same structure, a different climate — which is the table doing what it was built for.
    { key: 'turquoise', mat: M.turquoise, host: [L.GRANITE, L.BASALT, L.SANDSTONE], depth: [20, 200],
      shape: 'vein', rarity: 0.030, dip: 0.70, arid: 1, salt: 9220 },
    { key: 'garnet', mat: M.garnet, host: [L.BASEMENT], depth: [200, 2600], shape: 'disseminated',
      rarity: 0.0022, salt: 9590 },
    // ⭐ FLINT IS NODULES IN CHALK — bands of them, which is a seam with a very short period. It is also the
    // first material anybody ever made a tool out of, which is reason enough.
    { key: 'flint', mat: M.flint, host: [L.LIMESTONE], depth: [10, 320], shape: 'seam',
      rarity: 0.26, period: 42, thick: 1.1, salt: 9600 },
    // ⭐ MARBLE IS LIMESTONE THAT HAS BEEN COOKED — so it is a massive body deep in limestone country.
    { key: 'marble', mat: M.marble, unit: 1, host: [L.LIMESTONE], depth: [300, 2600], shape: 'massive',
      rarity: 0.030, size: 70, salt: 9610 },
    // ⭐⭐ …AND THE OTHER THREE, which were missing and should not have been. Marble existed alone, so the world
    // had exactly one metamorphic rock and it happened to be the one made from the third-commonest sediment.
    // SHALE IS 21.9% OF THE WORLD — the single most common material in it — and had no cooked form at all.
    // Each of these is one table row riding machinery that already exists (association x depth x rarity x
    // shape), which is what makes the gap worth closing rather than a reason it was left open.
    // ⚠️ DEEPER AND RARER THAN MARBLE, and deliberately so: metamorphism needs heat and pressure, so a
    // metamorphic body is a thing you find by going DOWN. Slate is shallowest (it is the lowest grade there is,
    // which is why roofs are made of it), gneiss the deepest.
    { key: 'slate', mat: M.slate, unit: 1, host: [L.SHALE], depth: [400, 2800], shape: 'massive',
      rarity: 0.032, size: 78, salt: 9612 },
    { key: 'quartzite', mat: M.quartzite, unit: 1, host: [L.SANDSTONE], depth: [500, 3000], shape: 'massive',
      rarity: 0.022, size: 62, salt: 9614 },
    { key: 'gneiss', mat: M.gneiss, unit: 1, host: [L.GRANITE, L.BASEMENT], depth: [900, 3600], shape: 'massive',
      rarity: 0.030, size: 90, salt: 9616 },
    // ⭐ OBSIDIAN is lava that cooled too fast to crystallise, so it belongs at the margins of volcanic rock —
    // and it was DECLARED IN THE PALETTE WITH NO RULE WRITING IT, which is the smell this design keeps finding.
    { key: 'obsidian', mat: M.obsidian, host: [L.BASALT], depth: [30, 900], shape: 'pocket', volcanic: 1,
      rarity: 0.014, size: 18, salt: 9620 },
    // ⭐ AND A PLACER: gold panned out of a stream bed, not dug out of rock. Shallow, in gravel, near a river.
    { key: 'goldplacer', mat: M.gold, host: null, depth: [1, 26], shape: 'placer',
      rarity: 0.10, salt: 9430 },
    // ══ THE FINDABLES BATCH ═══════════════════════════════════════════════════════════════════════════════════
    // ⭐⭐ METEORIC IRON, at the IMPACT CRATER landform — which the catalogue has had all along with nothing
    // associated to it. This is the cheapest kind of content there is: a material that exists in exactly one
    // kind of place, so finding the place IS finding the material, and the place is already generated and
    // already recognisable from a distance. Shallow, because an impactor does not bury itself deeply.
    // ⚠️ RARITY 0.16 WAS FAR TOO HIGH AND THE PICTURE SAID SO: the pocket filled the crater's whole near-surface
    // and the panel showed a peak MADE of meteorite. It is a thing you find IN a crater, not what the crater is
    // built from — and a rarity is a fraction of the host, so a rarity that is fine world-wide is enormous once
    // it is confined to 0.05% of the columns.
    { key: 'meteorite', mat: M.meteorite, host: null, depth: [2, 90], shape: 'pocket', crater: 1,
      rarity: 0.035, size: 11, salt: 9700 },
    // ⭐ GYPSUM/SELENITE — an evaporite mineral, so it wants dry country. The world's biggest crystals are these
    // (Naica), which is why it is worth separating from the generic `crystal` that has been doing its job.
    { key: 'gypsum', mat: M.gypsum, host: SEDIMENT, depth: [60, 1400], shape: 'seam', arid: 1,
      rarity: 0.16, period: 210, thick: 6, salt: 9710 },
    // ⭐ FLUORITE — the classic hydrothermal gangue mineral, so it rides the same veins the metals do, and it is
    // purple and green, which is the point of it.
    { key: 'fluorite', mat: M.fluorite, host: [L.LIMESTONE, L.GRANITE], depth: [150, 1800], shape: 'vein',
      rarity: 0.016, dip: 0.34, salt: 9720 },
    // ⭐ REALGAR and ORPIMENT — arsenic sulphides, deposited by hot springs, and the two most VIVID minerals that
    // occur in nature: scarlet and canary yellow. Real association (they are what the Yellowstone terraces
    // stain), genuinely shallow, and they cost a colour and four numbers each.
    { key: 'realgar', mat: M.realgar, host: SEDIMENT.concat(IGNEOUS), depth: [10, 500], shape: 'pocket', volcanic: 1,
      rarity: 0.008, size: 15, salt: 9730 },
    { key: 'orpiment', mat: M.orpiment, host: SEDIMENT.concat(IGNEOUS), depth: [10, 500], shape: 'pocket', volcanic: 1,
      rarity: 0.008, size: 13, salt: 9740 },
    // ⭐ CONGLOMERATE — cemented gravel, i.e. an old riverbed turned to stone. A BED, so a seam, and it belongs
    // in sandstone country because that is what it grades into.
    { key: 'conglomerate', mat: M.conglomerate, host: [L.SANDSTONE, L.SHALE], depth: [40, 1600], shape: 'seam',
      rarity: 0.14, period: 260, thick: 7, salt: 9750 },
  ];
}

// ==============================================================================================================
//  CALIBRATION — turn each `rarity` into a threshold on its own field's measured distribution.
//  ⚠️ Sampled over the field, not over the world: these noise fields are stationary, so where they are sampled
//  does not matter, and doing it this way costs one pass at startup instead of one per world.
// ==============================================================================================================
function calibrate(MIN, seed) {
  const N = 6000;
  for (const m of MIN) {
    if (m.shape !== 'vein' && m.shape !== 'pocket' && m.shape !== 'massive' && m.shape !== 'blanket') continue;
    const vals = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const c = (hh(seed, m.salt + 91, i, 0) * 400000) | 0;
      const elev = -200 - hh(seed, m.salt + 92, i, 1) * 2400;
      // ⚠️ THE SAME PERIODIC FORMS THE CELL TEST USES. A threshold calibrated against a slightly different field
      // is a rarity that does not mean what the catalogue says — the stale-constant trap this file already
      // records twice.
      if (m.shape === 'vein') vals[i] = fb2(seed, m.salt, c * veinX(m).q, elev / 26 + c * veinShear(m).k, 2, veinX(m).p, veinShear(m).per);
      else if (m.shape === 'pocket') vals[i] = fb2(seed, m.salt, c * nd(m.size).q, elev / m.size, 2, nd(m.size).p);
      else if (m.shape === 'massive') vals[i] = fb2(seed, m.salt, c * nd(m.size).q, elev / (m.size * 0.7), 3, nd(m.size).p);
      else vals[i] = n2(seed, m.salt, c * nd(220).q, elev / 40, nd(220).p);
    }
    const a = Array.from(vals).sort((x, y) => x - y);
    m.thr = a[Math.min(N - 1, Math.floor((1 - m.rarity) * N))];
  }
  return MIN;
}

// ==============================================================================================================
//  ⭐ THE PIPE LATTICE, IN ONE PLACE — because a probe has to be able to FIND one.
//
//  🟥 A pipe is ~8 sites in a 524,288-column world, each ~30 columns wide: 0.046% of the world. Any evenly
//  strided census steps over every one of them, and `probe_materials.js` duly reported `diamond` as NEVER
//  PRODUCED — twice, at two different sample depths — while a dense scan of these sites finds 9,000–30,000
//  diamond cells per world. Mistake #1 on this track, and mistake #6's sibling: a rarity is not a coverage.
//  ⇒ the lattice is exported so a probe enumerates the SAME sites the generator uses. Re-deriving them in the
//  probe would be mistake #2 (two rules disagreeing about what a number means) waiting to happen.
// ==============================================================================================================
// ⚠️ QUANTISED so the pipe lattice tiles the period exactly — 26,000 becomes 26,214.4 (20 pipes per world).
// A lattice that does not tile puts half a diamond pipe at the join, and this one is the sparsest in the world,
// so a broken site is also the hardest to notice.
const PIPE_LAT = nlat(26000), PIPE_STEP = PIPE_LAT.s;
function pipeSite(m, seed, near) {
  const nw = wrapL(near, PIPE_LAT.n);
  if (hh(seed, m.salt, nw, 0) > m.rarity * 240) return null;
  return {
    near,
    cx: latAt(PIPE_LAT, near) + (hh(seed, m.salt + 1, nw, 1) - 0.5) * PIPE_STEP * 0.8,
    top: -900 - hh(seed, m.salt + 2, nw, 2) * 700,
  };
}
// every sparse-lattice site in a world of `width` columns, as {key, mat, cx, top}
function sparseSites(MIN, seed, width) {
  const out = [];
  for (const m of MIN) {
    if (m.shape !== 'pipe') continue;
    for (let near = 0; near <= Math.ceil(width / PIPE_STEP); near++) {
      const s = pipeSite(m, seed, near);
      if (s && s.cx >= 0 && s.cx < width) out.push({ key: m.key, mat: m.mat, cx: Math.round(s.cx), top: Math.round(s.top) });
    }
  }
  return out;
}

// ==============================================================================================================
//  THE CELL ANSWER.
// ==============================================================================================================
// ⭐ HOST AS A LOOKUP, NOT A SCAN. `m.host.indexOf(lith)` is a linear search inside a linear search over 35
// minerals, run for every cell in the world — and `mineralAt` was 11.8% of the whole profile. The mask is
// built lazily on the record itself, so it cannot fall out of step with `host` the way a parallel table would.
// ⚠️ `host: null` means "any rock" and must stay that way; a mask of all-zero would mean the opposite.
const hostMask = (m) => {
  let k = m._hostMask;
  if (k === undefined) {
    k = m._hostMask = m.host ? new Uint8Array(16) : null;
    if (k) for (const L of m.host) k[L] = 1;
  }
  return k;
};

// ⭐ MECHANISM COUNTERS, off by default. "34 minerals threshold their own noise at every cell" was the premise
// the early-out mask was proposed on, and it had never been counted — the gates above each noise call reject
// most of them. Counting first is the difference between optimising the cost and optimising my idea of it.
const oreStats = { cells: 0, gated: 0, noise: 0, hit: 0 };
let ORE_EARLY = +(process.env.ORE_EARLY === undefined ? 1 : process.env.ORE_EARLY);
const setOreEarly = (v) => { ORE_EARLY = v ? 1 : 0; };
let ORE_COUNT = 0;
const setOreCount = (v) => { ORE_COUNT = v ? 1 : 0; };
const getOreStats = () => Object.assign({ oct: oreOct, octFull: oreOctFull }, oreStats);
const resetOreStats = () => { oreStats.cells = 0; oreStats.gated = 0; oreStats.noise = 0; oreStats.hit = 0; oreOct = 0; oreOctFull = 0; };
// ⭐⭐ THE EARLY-OUT. `fb2` averages `oct` octaves of value noise and the caller only ever asks ONE question of
// the answer — "is it over this threshold?" — so most of the octaves need never be computed. After each octave
// the value is bounded: what is already accumulated (`s`) plus the most the remaining weight could add (`rem`,
// since n2 is in [0,1)) above, and `s` alone below. As soon as either bound lands on one side of the threshold
// the answer is settled and the rest of the octaves cannot change it.
// ⭐ THIS IS EXACT, NOT APPROXIMATE, and that is the whole point of choosing it: it returns bit-identical
// answers to the full evaluation, so the world does not move by one cell. An "is there ore near here" mask
// keyed on a coarse field would have been cheaper still and would have changed where ore is, which is the one
// thing the field mode is being kept FOR.
// ⚠️ The comparison is `> thr` on `s / t`, so it is done as `s > thr * t` — dividing first would reintroduce
// the division this exists to avoid and, worse, would not be the same comparison in floating point.
let oreOct = 0, oreOctFull = 0;      // octaves actually computed vs. what the full evaluation would have cost
// ⚠️ `per`/`pery` mirror `fb2`'s exactly — this is the same field with an early exit, so if it did not take the
// periods it would be a SECOND opinion about where the ore is, and the two modes would disagree at the join.
function fb2Above(seed, salt, x, y, oct, thr, per, pery) {
  let a = 1, rem = 0;
  for (let o = 0; o < oct; o++) { rem += a; a *= 0.5; }
  const need = thr * rem;
  a = 1;
  let f = 1, s = 0;
  for (let o = 0; o < oct; o++) {
    s += a * n2(seed, salt + o * 37, x * f, y * f, per ? per * f : 0, pery ? pery * f : 0);
    rem -= a;
    if (ORE_COUNT) oreOct++;
    if (s + rem <= need) return false;        // even all-ones from here cannot reach the threshold
    if (s > need) return true;                // even all-zeros from here cannot lose it
    a *= 0.5; f *= 2;
  }
  return s > need;
}
// ⭐ THE VEIN FIELD'S TWO PERIODIC CONSTANTS, MEMOISED ON THE MINERAL. `nd(11)` is shared, but the shear is a
// function of the mineral's own `dip`, so it is cached per record rather than through the shared Map.
const veinX = () => nd(11);
const veinShear = (m) => (m._vsh || (m._vsh = shearQ(m.dip / 26)));
function mineralAt(MIN, ctx, c, r, d, elev, lith, seed) {
  if (ORE_COUNT) oreStats.cells++;
  for (const m of MIN) {
    if (d < m.depth[0] || d > m.depth[1]) continue;
    const hm = hostMask(m);
    if (hm && !hm[lith]) continue;
    if (m.volcanic && !ctx.nearVolcano) continue;
    if (m.crater && !ctx.crater) continue;
    if (m.arid && ctx.moist > 0.32) continue;
    if (m.hot && !(ctx.moist > 0.6 && ctx.temp > 0.6)) continue;
    if (m.shape === 'placer' && !ctx.nearRiver) continue;
    if (ORE_COUNT) { oreStats.gated++; if (m.shape === 'vein' || m.shape === 'pocket' || m.shape === 'massive') { oreStats.noise++; oreOctFull += m.shape === 'massive' ? 3 : 2; } }

    switch (m.shape) {
      case 'seam': {
        // a bed: near-horizontal, thin, and it goes on for miles. ⚠️ the wobble is what stops it being a ruled
        // line across the whole world, and it is the same wobble the mesa terraces use so the two agree.
        const wob = n1(seed, m.salt, c * nd(420).q, nd(420).p) * 60;
        const k = Math.round((elev + wob) / m.period);
        if (hh(seed, m.salt + 1, k, 0) > m.rarity) continue;      // k is a ROW band — no wrap, depth has two ends
        if (m.arch && n1(seed, m.salt + 2, c * nd(520).q, nd(520).p) < 0.60) continue;
        if (Math.abs(elev + wob - k * m.period) < m.thick) return m.mat;
        continue;
      }
      case 'vein': {
        // a ribbon following a fracture, steeply inclined. `dip` is the gradient, so different minerals in the
        // same rock cross each other instead of running parallel.
        // ⚠️ THE SHEARED AXIS IS THE ONE PLACE Y HAS TO WRAP TOO — see `shearQ` in noise.js. `veinX`/`veinY`
        // memoise the two quantised constants on the record so this stays one multiply per cell.
        const VX = veinX(m), VY = veinShear(m);
        const vy = elev / 26 + c * VY.k;
        if (ORE_EARLY) { if (fb2Above(seed, m.salt, c * VX.q, vy, 2, m.thr, VX.p, VY.per)) return m.mat; continue; }
        const v = fb2(seed, m.salt, c * VX.q, vy, 2, VX.p, VY.per);
        if (v > m.thr) return m.mat;
        continue;
      }
      case 'pocket': {
        const S = nd(m.size);
        if (ORE_EARLY) { if (fb2Above(seed, m.salt, c * S.q, elev / m.size, 2, m.thr, S.p)) return m.mat; continue; }
        const g = fb2(seed, m.salt, c * S.q, elev / m.size, 2, S.p);
        if (g > m.thr) return m.mat;
        continue;
      }
      case 'massive': {
        const S = nd(m.size);
        if (ORE_EARLY) { if (fb2Above(seed, m.salt, c * S.q, elev / (m.size * 0.7), 3, m.thr, S.p)) return m.mat; continue; }
        const g = fb2(seed, m.salt, c * S.q, elev / (m.size * 0.7), 3, S.p);
        if (g > m.thr) return m.mat;
        continue;
      }
      case 'disseminated': {
        // not a body at all — a grade. Scattered specks over a wide zone, which you assay rather than find.
        if (hc(seed, m.salt, c, r) < m.rarity) return m.mat;
        continue;
      }
      case 'pipe': {
        // ⭐ a near-vertical carrot, on a very sparse lattice, that narrows as it rises
        const s = pipeSite(m, seed, Math.round(c / PIPE_LAT.s));
        if (!s || elev > s.top) continue;
        const wid = 6 + 26 * cl((s.top - elev) / 1400, 0, 1);
        if (Math.abs(wdc(c - s.cx)) < wid * (0.7 + 0.5 * n1(seed, m.salt + 3, elev / 90))) return m.mat;
        continue;
      }
      case 'blanket': {
        const S = nd(220);
        const g = n2(seed, m.salt, c * S.q, elev / 40, S.p);
        if (g > m.thr) return m.mat;
        continue;
      }
      case 'placer': {
        if (hc(seed, m.salt, c, r) < m.rarity * 0.06) return m.mat;
        continue;
      }
      default: continue;
    }
  }
  return -1;
}

// ⭐⭐ THE COLUMN SHORTLIST — see the long note in descents.js. Five of `mineralAt`'s seven rejections read
// `ctx`, which is `ci.oreCtx` and is therefore constant down a whole column: whether this column is near a
// volcano, in a crater, arid, hot, or beside a river. They were being re-asked for every cell.
// ⚠️ ORDER IS PRESERVED, and it has to be: `mineralAt` RETURNS on its first match, so a shortlist that
// reordered the minerals would change which one wins where two overlap.
// ⭐⭐ AND THE DEPTH BAND, WHICH IS THE BIGGER HALF. `d` is per row — but `d = r - surfRow` and `surfRow` is
// FIXED for the column, so a 64-row chunk spans a known 64-wide window of depth, and a mineral whose band does
// not intersect it cannot appear anywhere in this column. The bands are narrow and specific (meteorite 2..90,
// realgar 10..500, coal 60..900, iron 100..2200), so deep down almost the whole catalogue drops out: at row
// 3,600 the window is d ~ 1,700..1,764 and only the few deepest minerals survive.
// ⚠️ THE CALLER PASSES THE WINDOW; THIS DOES NOT GUESS IT. Handing it `surfRow` and letting it work out the
// rows would be a second copy of "how deep is this cell", which is the mistake the shortlists exist to avoid.
// ⚠️ Conservative, as every bound here is: `depth[1] >= dLo && depth[0] <= dHi` is INTERSECTION, so a mineral
// is kept if any part of its band is in range, and `mineralAt`'s exact `d < depth[0] || d > depth[1]` still
// decides each cell.
// ⚠️ `lith` (host) is deliberately still NOT hoisted — `lithAtRow` jitters the lookup in BOTH axes, so it is a
// genuinely per-row fact and hoisting it would be this very bug upside down.
function mineralsNear(MIN, ctx, dLo, dHi) {
  let out = null;
  const bodies = oreBodiesOn();
  for (const m of MIN) {
    // ⚠️ In `bodies` mode the vein/pocket/massive minerals are placed records and must NOT also be fields, or
    // every one of them would appear twice — once as a body and once as the noise it used to be.
    if (bodies && isBody(m)) continue;
    if (m.depth[1] < dLo || m.depth[0] > dHi) continue;
    if (m.volcanic && !ctx.nearVolcano) continue;
    if (m.crater && !ctx.crater) continue;
    if (m.arid && ctx.moist > 0.32) continue;
    if (m.hot && !(ctx.moist > 0.6 && ctx.temp > 0.6)) continue;
    if (m.shape === 'placer' && !ctx.nearRiver) continue;
    (out || (out = [])).push(m);
  }
  return out || MIN_EMPTY;
}
const MIN_EMPTY = [];

module.exports = { buildMinerals, mineralAt, calibrate, sparseSites, PIPE_STEP, mineralsNear,
  setOreMode, oreMode, oreBodiesOn, setOreGain, setOreSize, setOrePinch, setOreCount, getOreStats, resetOreStats, setOreEarly, setOreVein, setOrePinchMin, setOrePinchLen, setOrePinchCut, oreCacheClear, oreBodiesNear, oreBodyAt, BODY_SHAPES, isBody, oreLattice, sizeOf, oreReachOf };
