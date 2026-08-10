'use strict';
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// eleven others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');
// ==============================================================================================================
//  worldspike/liquids.js — LIQUIDS AS POINTS IN AN AXIS SPACE, not as a list.
//
//  ⭐ THE SAME MOVE THAT TURNED 17 BIOMES INTO A 3-AXIS CLIMATE SPACE. The rest of this spike arrived at 68
//  solid materials by writing dressing rules and seeing what they reached for; liquids never got that treatment
//  at all. Placement was four rules — sea level, lake level, the water table, the volcano conduit — and every
//  one of them hard-codes `water` or `lava`. Measured: the spike places TWO liquids (water 5.32%, lava 1.64%)
//  while the SHIPPED generator it is meant to replace places five (water, lava, brine, oil, quicksand, and acid
//  in its acid-wastes biome). Adding liquids to the spike is closing a regression, not adding a feature.
//
//  ── THE AXES ─────────────────────────────────────────────────────────────────────────────────────────────────
//  A SITUATION in the world has a position, and so does every liquid. The liquid a place produces is the nearest
//  point. Add a liquid by adding a point; the placement rules never change.
//
//      sal    salinity        0 rain-fed  ·  1 hypersaline
//      acid   acidity         0 neutral   ·  1 the crater lake at Kawah Ijen
//      hc     hydrocarbon     0 none      ·  1 a tar seep
//      heat   temperature     0 freezing  ·  0.5 ambient  ·  1 molten
//      silt   suspended load  0 clear     ·  1 more solid than liquid
//
//  🟥 WHY NEAREST-POINT AND NOT A CHAIN OF `if`s. A chain encodes the ANSWERS; a space encodes the QUESTION.
//  Ten of sixteen landform contracts once placed nowhere because thresholds were guessed against an unmeasured
//  distribution (mistake #6) — and the cure there was the same as here: sample the field that exists and read
//  the answer off it. `preview_liquids.js` renders the classification over the whole space, so a liquid with no
//  territory is VISIBLE rather than silently absent.
//
//  ⚠️ `heat` IS GATED, NOT MERELY WEIGHTED. Molten is not a lot of warm: without the gate, hot salty water
//  classified as lava, because in a plain Euclidean space `sal` can carry you across a phase change.
// ==============================================================================================================

// dens/visc are OUTPUTS — what the sim needs once the liquid has been chosen. `game` is the id it already has.
// ⚠️ DENSITY IS THE ORDER THINGS STACK IN and it is a real, checkable fact: oil floats on water, brine sinks
// under it. The game's multi-liquid cell is 2-deep with a density rank, so this is not decoration.
//
// ⭐⭐ `rank` IS THE PORTING CONSTRAINT, AND IT IS THE REASON THIS TABLE HAS TEN LIQUIDS AND SIX DENSITIES.
// The game's per-cell liquid stack is `fineAmt`, stride `LIQ_T = 6` — ONE SLOT PER RANK, allocated for every
// cell in the world whether or not a drop of liquid is ever in it. So a new DENSITY is not free the way a new
// solid is: it is a byte per cell of the entire Overworld, on the single widest per-cell field there is.
// Ten liquids at ten densities would take the stack from 6 to 10, a 67% increase on that field.
// ⇒ liquids SHARE a rank wherever they could not sensibly coexist in one cell, and the sharing is deliberate
// and written down rather than emergent:
//     0  lava · lavathick    two melts from the same volcano; a cell is one or the other
//     1  quicksand · slurry  both are dense sediment slurries
//     2  brine
//     3  acid · tar          both denser than water; a volcanic crater and a cold shale seep never meet
//     4  water · hotspring   hot water IS water — 1% of density is far below the granularity of a rank
//     5  oil
// ⇒ TEN LIQUIDS AT NO PER-CELL COST. `dens` is kept as the real number because it is what makes the ordering
// checkable, but the SIM only ever sees `rank`, and `probe_settled` compares ranks for the same reason.
const LIQUIDS = [
  { key: 'water', rank: 4,     sal: 0.30, acid: 0.10, hc: 0.00, heat: 0.50, silt: 0.05,
    dens: 1.00, visc: 0.00, game: 9,  note: 'the sea, lakes, rivers, the water table' },
  { key: 'brine', rank: 2,     sal: 0.95, acid: 0.10, hc: 0.00, heat: 0.50, silt: 0.05,
    dens: 1.20, visc: 0.05, game: 14, note: 'closed arid basins, evaporite, and the dense pools at the bottom of deep voids' },
  { key: 'acid', rank: 3,      sal: 0.20, acid: 0.92, hc: 0.00, heat: 0.55, silt: 0.05,
    dens: 1.05, visc: 0.02, game: 12, note: 'sulphide weathering, and volcanic crater lakes' },
  { key: 'oil', rank: 5,       sal: 0.10, acid: 0.10, hc: 0.90, heat: 0.50, silt: 0.10,
    dens: 0.87, visc: 0.25, game: 15, note: 'oil shale; FLOATS on water, which is the point of tracking density' },
  { key: 'tar', rank: 3,       sal: 0.10, acid: 0.10, hc: 1.00, heat: 0.30, silt: 0.45,
    dens: 1.02, visc: 0.88, note: 'a cold seep at the surface — barely flows, so it POOLS where oil would run' },
  { key: 'quicksand', rank: 1, sal: 0.15, acid: 0.10, hc: 0.00, heat: 0.50, silt: 0.88,
    dens: 1.60, visc: 0.55, game: 10, note: 'sand with the water table inside it' },
  { key: 'slurry', rank: 1,    sal: 0.15, acid: 0.15, hc: 0.05, heat: 0.52, silt: 0.97,
    dens: 1.45, visc: 0.72, note: 'mudpots and lahars; the game has mud only as a SOLID' },
  { key: 'hotspring', rank: 4, sal: 0.42, acid: 0.28, hc: 0.00, heat: 0.82, silt: 0.05,
    dens: 0.99, visc: 0.00, note: '⭐ geothermal water — and what DEPOSITS tufa, so the tufa and geyser landforms finally contain their substance' },
  { key: 'lava', rank: 0,      sal: 0.10, acid: 0.50, hc: 0.00, heat: 1.00, silt: 0.20,
    dens: 2.70, visc: 0.35, game: 11, note: 'basaltic — runs' },
  { key: 'lavathick', rank: 0, sal: 0.10, acid: 0.50, hc: 0.00, heat: 0.95, silt: 0.55,
    dens: 2.55, visc: 0.92, note: 'rhyolitic — crawls and piles into a dome instead of flowing' },
];
const BY = {}; for (const l of LIQUIDS) BY[l.key] = l;

// ⚠️ WEIGHTS, because the axes are not equally decisive. Being hydrocarbon is nearly definitional; being a bit
// saltier is not. `heat` is handled by the gate below rather than by its weight.
// ⚠️ `heat` AT 1.0 WAS TOO LOW AND THE CLASSIFICATION MAP SHOWED IT — `hotspring` (heat 0.82) sits between
// `brine` and `acid` on the sal/acid plane, so it won a wedge of AMBIENT-temperature situations: a cold, salty,
// mildly acidic pool was being called a hot spring because it was equidistant from the other two. Temperature
// is not a tiebreak. Raised until the ambient panels contain no hot spring at all.
const W = { sal: 1.0, acid: 1.6, hc: 2.2, heat: 3.0, silt: 1.4 };
const MOLTEN = 0.90;                       // above this the answer is a lava, below it never is

// The classifier. `sit` is {sal, acid, hc, heat, silt}; returns a LIQUIDS entry.
function liquidFor(sit) {
  const molten = sit.heat >= MOLTEN;
  let best = null, bd = Infinity;
  for (const l of LIQUIDS) {
    if ((l.heat >= MOLTEN) !== molten) continue;     // the gate: a phase change is not a distance
    const d = W.sal * (l.sal - sit.sal) ** 2 + W.acid * (l.acid - sit.acid) ** 2
            + W.hc * (l.hc - sit.hc) ** 2 + W.heat * (l.heat - sit.heat) ** 2
            + W.silt * (l.silt - sit.silt) ** 2;
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}

// ==============================================================================================================
//  THE SITUATION AT A PLACE. Every input here is something the world already computes — this adds no new field
//  to the pipeline, it reads the ones that exist.
//
//  ⚠️ COMPUTED PER CELL, NOT PER COARSE SAMPLE. Mistake #4 on this track has six instances and every one was a
//  categorical field sampled per 64 columns; a liquid that changes identity at a sample boundary would be worse
//  than any of them, because a boundary between two liquids of different DENSITY is a boundary that MOVES.
//  The column part is computed once per column (`situationOf`) and the depth part per cell (`atDepth`).
// ==============================================================================================================
// hh/fb1: the same positional hash the rest of the spike uses, so a situation is reproducible from (seed, c).
// ⚠️ CALIBRATED, NOT GUESSED. `SEEP_FRAC` of columns are at or above the threshold — the fraction is the design
// decision and the threshold is read off the field that exists. These noise fields are stationary, so one pass
// at load answers it for every world. Same treatment `minerals.calibrate` gives every ore body.
const SEEP_FRAC = 0.06;
const SEEP_T = (() => {
  const N = 20000, v = new Float64Array(N);
  // ⚠️ the SAME periodic form the cell test uses, or the calibrated quantile is a threshold on a different field
  for (let i = 0; i < N; i++) v[i] = fb1(20260101, 1907, (i * 37) * nd(95).q, 2, nd(95).p);
  const a = Array.from(v).sort((x, y) => x - y);
  return a[Math.floor((1 - SEEP_FRAC) * (N - 1))];
})();

// The per-COLUMN part. `L` is the pipeline's lithology enum; `closed` is `W.endo[sample]`.
function situationOf(ci, L, c, seed, opts) {
  const o = opts || {};
  // ── SALINITY. A CLOSED BASIN has no outlet, so every dissolved thing the catchment delivers stays and
  //    concentrates — that is what makes the Dead Sea and Lake Eyre what they are, and the pipeline already
  //    decides it with a real water balance (`rec.endorheic`). Aridity multiplies it, because concentration is
  //    evaporation. The open sea is salty but NOT hypersaline, which is exactly why it stays `water`: a game
  //    where the whole ocean is brine is a different game.
  // ⚠️ NOT read off `ci.lith === L.EVAPORITE`. That was the first version, it required assigning an evaporite
  //    lithology to the basin, and doing so turned the entire column into a soluble salt mass that karsted and
  //    drained the lake through its own floor. See the note in pipeline.js where `endo` is set.
  const arid = cl((0.34 - ci.moist) / 0.34, 0, 1) * cl(ci.temp / 0.45, 0, 1);
  const closed = o.closed ? 1 : 0;
  const sal = cl(0.18 + closed * (0.34 + 0.52 * arid) + 0.20 * arid
    + 0.16 * (fb1(seed, 1901, c * nd(780).q, 2, nd(780).p) - 0.5), 0, 1);
  // ── ACIDITY. Sulphide rock weathers to sulphuric acid (this is acid mine drainage, and it is why real mine
  //    water is orange); a live volcano does it far harder, which is what a crater lake is.
  //    ⚠️ Kept as TWO terms. Volcanic acid reaches the surface — that is what a crater lake is — while acid from
  //    weathering sulphide is a FORMATION fluid and belongs underground. Merged into one number, a sulphide
  //    district turned its lakes green.
  const sulph = fb1(seed, 1903, c * nd(340).q, 2, nd(340).p);
  const acidVolc = ci.oreCtx.nearVolcano ? 0.62 : 0;
  const acidRock = 0.50 * Math.max(0, sulph - 0.62) / 0.38;
  const acid = cl(0.06 + acidVolc + acidRock, 0, 1);
  // ── HYDROCARBON. Shale is the source rock; coal country leaks too. Patchy, because a field is patchy.
  const src = (ci.lith === L.SHALE ? 1 : 0) * 0.8 + (ci.lith === L.LIMESTONE ? 0.25 : 0);
  const hc = cl(src * Math.max(0, fb1(seed, 1905, c * nd(430).q, 2, nd(430).p) - 0.50) / 0.50 * 1.5, 0, 1);
  // ⭐ A SEEP is where deep fluid reaches the SURFACE, and it is a narrow thing — a tar pit, not a coastline.
  //    Without it, `hc` applied at depth 0 turned the sea along every shale coast into crude oil.
  // 🟥 AND THE THRESHOLD WAS GUESSED (0.885 on a 2-octave fbm) — mistake #6, and it killed `tar` outright: the
  //    field's p90 is 0.748, so "> 0.885 and then some" is a fraction of a percent, and combined with needing
  //    high `hc` in the same column it never co-occurred. Read off a measured quantile now, like the minerals.
  const seep = cl((fb1(seed, 1907, c * nd(95).q, 2, nd(95).p) - SEEP_T) / 0.08, 0, 1);
  return { sal, acid, acidVolc, acidRock, hc, seep, silt: 0.05, heat: 0.5, temp: ci.temp, surfRow: ci.surfRow,
    sandy: o.sandy ? 1 : 0, clayey: o.clayey ? 1 : 0,
    // a hot spring field is the one place heat reaches the SURFACE, and it is a landform rather than a field
    spring: (ci.kind === 'geyser' || ci.kind === 'tufa') ? 1 : 0 };
}

// The per-CELL part: depth warms, a volcano warms far more, and cold climates chill the shallow subsurface.
//
// 🟥 AND `silt` HAD NOTHING DRIVING IT, WHICH IS MISTAKE #9 ONE LEVEL UP: an AXIS got ahead of the rules, the
// same way the palette used to get ahead of the dressing. `preview_liquids` PART B reported quicksand, slurry,
// tar and lavathick as "the world never produces this situation" — all four sit at high silt, and every caller
// was passing 0.05. They were not mis-tuned, they were unreachable. That is exactly why Part B exists and why
// it is a separate question from Part A: they all had plenty of territory in the cube.
//
// ⇒ silt is "how much solid is carried", and it comes from three real things:
//     LOOSE SAND      water inside unconsolidated sand IS quicksand, and sand is a near-surface material
//     GEOTHERMAL MUD  a mudpot is fine sediment kept in suspension by heat from below
//     MAGMA SILICA    a rhyolitic melt is stiff with crystals; that is what makes it pile into a dome instead
//                     of running, and it is a property of the VOLCANO, not of the place
//   plus a surface HYDROCARBON SEEP, which is thick because the light ends have evaporated out of it — the
//   difference between crude at depth and tar at the surface is not composition, it is exposure.
function atDepth(base, d, hot, opt) {
  const o = opt || {};
  // 🟥 HOW MUCH HEAT A VOLCANO DELIVERS IS A FUNCTION OF DEPTH, AND THAT BELONGS HERE. The first version took
  // `hot` straight — so every cell within 2,600 columns of a volcano read heat ≥ 1.0 and crossed the molten
  // gate, and the SEA around a volcanic coast came out as lava. Worse, `preview_liquids` had quietly written
  // its own damping (`d > 1500 ? hot : hot * 0.4`) while cells.js passed it raw: mistake #2, two rules
  // disagreeing about what a number means, and it made the previewer say the world was fine when it was not.
  // ⇒ `hot` means "how close a volcano is", full stop. What that does to a cell is decided in one place.
  // A volcano heats the deep rock around its chamber; it does not make the topsoil above it molten.
  // ⚠️ +0.30 AT THE BOTTOM WAS TOO STEEP, and raising the `heat` weight to fix a different artefact exposed it:
  // deep water sat at 0.80, which is a hot spring's own temperature (0.82), so `hotspring` went UP from 4.2% to
  // 7.3% of situations and the whole underworld's pools turned turquoise. The world is ~4,096 cells deep, which
  // is on the order of a kilometre of rock — real geothermal gradient is about 25°C/km, i.e. WARM, not hot.
  // ⇒ the deepest water reads 0.65: clearly warmer than the surface, clearly not a spring.
  const geo = cl(d / 4200, 0, 1) * 0.15;
  const volc = (hot || 0) * cl(d / 900, 0, 1) * 0.56;
  const spring = base.spring ? cl(1 - d / 260, 0, 1) * 0.34 : 0;   // …but a hot spring IS hot at the surface
  const chill = base.temp < 0.12 && d < 60 ? 0.34 : 0;
  const heat = cl(0.5 + geo + volc + spring - chill, 0, 1);
  // 🟥 CONFINEMENT. A surface water body is RAINFALL AND RUNOFF; the oil and the sulphuric acid are FORMATION
  // fluids, sealed in the rock. Applying the column's `hc` at depth 0 gave 98% of all the oil in the world as
  // ABOVE-GROUND cells — an ocean of crude along every shale coast — and the census could not see it because
  // "oil exists, 0.2% of the world" is exactly what success looks like. `out/liquids_sites.png` showed it in
  // one glance. ⇒ formation fluids ramp in with depth; they reach the surface only at a SEEP, which is narrow.
  // ⚠️ Volcanic acid is NOT confined: a crater lake is acid at the surface, and that is the whole point of it.
  const conf = cl(d / 140, 0, 1);
  const hcHere = base.hc * Math.max(conf, base.seep || 0);
  const acidHere = cl(0.06 + base.acidVolc + (base.acidRock || 0) * conf, 0, 1);
  const loose = base.sandy * cl(1 - d / 90, 0, 1) * 0.92;      // sand is a surface material; below it, rock
  const pot = (hot || 0) > 0.45 && base.clayey ? 0.95 : 0;     // a mudpot
  const weath = hcHere > 0.72 && d < 46 ? 0.55 : 0;            // weathered at the surface = tar, not oil
  const silt = cl(Math.max(base.silt, loose, pot, weath, o.silica || 0), 0, 1);
  return { sal: base.sal, acid: acidHere, hc: hcHere, heat, silt };
}

// ⏭️ KNOWN, STATED RATHER THAN TUNED AWAY — A VOID IS FILLED PER CELL, SO A TALL ONE CAN STRATIFY BACKWARDS.
// `probe_settled` finds exactly one "water over oil" in 2.9M cells, and one cell is not the point: the SHAPE of
// it is. Depth decides the liquid, so a void that spans the confinement ramp gets water in its top and oil in
// its bottom — and oil FLOATS, so that is upside down. It is rare only because few voids span d≈140 with the
// water table inside them.
// The fix is the pattern this design keeps arriving at independently: a flooded void should be a PLACED RECORD
// with one fill decided for the whole body, the way crater lakes, tarns, underworld lakes and the underground
// basins all had to become. Not done here — the liquid pass is about WHICH liquid, and this is about WHERE the
// body is, which is the same question the dry rimstone pools are still open on.
module.exports = { LIQUIDS, BY, liquidFor, situationOf, atDepth, MOLTEN, W, SEEP_T };
