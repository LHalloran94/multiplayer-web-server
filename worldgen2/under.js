'use strict';
// ==============================================================================================================
//  worldspike/under.js — THE UNDERGROUND, DESIGNED RATHER THAN THRESHOLDED.
//
//  What this replaces was one line: `if (fbm2(c/42, r/30) > 0.70) air`. That is not a cave system, it is a
//  sponge — and it gives every rock type, every depth and every climate the same holes. The user asked for the
//  underground to be taken as seriously as the surface, grounded in real geology: deposits, cave systems,
//  crystal caves, flooded caves.
//
//  ⭐⭐ THE ORGANISING IDEA IS THE WATER TABLE, and it earns its place several times over. It is one 1-D curve —
//  subdued topography, pinned to sea level at the coast, shallow under rainforest and hundreds of rows down
//  under desert — and from it fall out, without any further rules:
//        · a cave below it is FLOODED and one above it is dry, in the same system;
//        · a sump where a passage dips through it, which is exactly what cave divers call it;
//        · springs where it meets the ground;
//        · coastal caves flooded to sea level — cenotes and blue holes — because near the sea it IS sea level;
//        · and dry caves in deserts, wet caves in the tropics, from the climate that is already computed.
//
//  ⭐ AND CAVE FORM FOLLOWS THE ROCK, which is the form/dressing split applied one level down. Limestone
//  dissolves, so it gets galleries at old water-table levels joined by shafts. Basalt does not dissolve at all;
//  its caves are lava tubes, and only near a volcano. Everything else gets fracture voids.
//
//  ⭐ WHAT IS LEFT IN THIS FILE IS THE WATER TABLE, THE DEPOSITS AND THE FRACTURES — the three things that
//  genuinely are fields. Lava tubes went to volcano.js and karst systems to caves.js, each as placed records
//  with their own seeds, because each of those has an IDENTITY: an extent, an entrance, a connectivity you can
//  ask about. A fracture swarm has none of those; it is a property of the rock at a point, and it stays a field
//  for the same reason the others could not.
// ==============================================================================================================
const { L } = require('./pipeline.js');
const { liquidFor, atDepth } = require('./liquids.js');
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// twelve others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');
const VEIN_SHEAR = shearQ(0.55 / 26);   // the hydrothermal vein's dip, quantised (see noise.js)
const DOME_LAT = nlat(9000);            // the salt-dome anchor lattice, quantised to tile the period

// ==============================================================================================================
//  LAYOUT: the water table, and which kind of cave system each stretch of the world has.
// ==============================================================================================================
function prepareUnder(W, seaRow) {
  const n = W.n, seed = W.o.seed;
  // ── the water table, in ELEVATION (rows above sea level), then converted per column ─────────────────────────
  // Depth to water is a climate fact: metres under rainforest, hundreds of metres under desert. Then smoothed,
  // because a water table is a fluid surface and does not follow every ridge and gully of the ground above it.
  const wt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dry = 1 - W.clim.moist[i];
    const depth = lp(6, 260, dry * dry);
    wt[i] = W.h[i] - depth;
  }
  const sm1 = new Float32Array(n);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - 9); k <= Math.min(n - 1, i + 9); k++) { s += wt[k]; c++; }
      sm1[i] = s / c;
    }
    wt.set(sm1);
  }
  for (let i = 0; i < n; i++) {
    // never above the ground, and never below sea level on land — near the coast the water table IS sea level,
    // which is what floods coastal karst and makes cenotes.
    wt[i] = Math.min(wt[i], W.h[i] - 2);
    if (W.isSea[i]) wt[i] = 0;
    else wt[i] = Math.max(wt[i], 0 - 40);
    if (W.isLake[i]) { const lk = W.lakes[W.lakeId[i]]; if (lk) wt[i] = Math.max(wt[i], lk.level - 1); }
  }

  // ⭐ THE `sys` / `galleries` LAYOUT IS GONE — see caves.js. It decided per COARSE SAMPLE whether a stretch of
  // world was karst and held five gallery elevations per sample, which is the last of this track's five
  // "categorical field read per cell" defects and was left until last because it was the largest. A cave system
  // is a placed record now, with storeys that run its full width, shafts that make them one network, and an
  // entrance decided where it can be checked.
  // ⚠️ `volcCol` goes with it: the lava-tube branch that used it was retired when volcano.js took ownership.
  return { wt, seaRow };
}

// ==============================================================================================================
//  CELL LEVEL: is this cell a void, and if so what lines it and is it flooded?
//  Returns a material id, or -1 to leave the bedrock alone.
// ==============================================================================================================
function underAt(U, W, M, ci, c, r, d, seed, lithHere) {
  if (d <= 34) return -1;
  const seaRow = U.seaRow;
  // ── FRACTURE VOIDS: narrow, steep, and CLUSTERED ON THE FAULTS. ─────────────────────────────────────────────
  // ⭐ They used to be spread evenly through every igneous rock in the world, which is why they read as a
  // uniform speckle of dashes. Fractures are not uniform: they swarm along fault zones and are sparse between
  // them. Tying them to the same fault field that offsets the beds makes the two agree — a break in the rock and
  // a displacement of the layers are the same event, and the section shows them together.
  // ⚠️ THE ROCK IS READ PER CELL, from the same jittered lookup the bedrock material uses, not from
  // `ci.lith` — which is `W.lith[nearest sample]` and would put a dead straight vertical line 900 rows tall
  // wherever two rock types meet. That is the defect this increment exists to remove, and it was hiding here
  // too: the old code took the karst-or-fracture decision off exactly that field.
  // ⭐ Brittle rock fractures, soluble and soft rock does not — which is what keeps granite and limestone
  // looking like different places now that the categorical `sys` field is gone.
  const brittle = lithHere === L.GRANITE || lithHere === L.BASALT || lithHere === L.BASEMENT ? 1
    : (lithHere === L.SANDSTONE ? 0.55 : 0.2);
  if (brittle < 0.3) return -1;
  const near = cl(1 - (ci.faultDist || 1e9) / 260, 0, 1);
  const fr = fb2(seed, 681, c * nd(15).q, (seaRow - r) / 90, 3, nd(15).p);
  if (fr <= 0.86 - 0.10 * brittle - 0.14 * near) return -1;
  return voidMaterial(U, M, ci, r, seaRow);
}

// ==============================================================================================================
//  DEPOSITS — placed by the geology that makes them, not by one noise field.
//  ⭐ Each of these is somewhere a player has a REASON to go, which is the point of designing them rather than
//  scattering them: a coal seam is a bed you follow, a vein is a line you chase, an oil trap is under a cap.
// ==============================================================================================================
function depositAt(U, W, M, ci, c, r, d, seed) {
  const i = ci.sample, lith = ci.lith, elev = U.seaRow - r;
  if (d < 24) return -1;

  // COAL: a bedded seam in sedimentary rock — thin, flat, and it goes on for miles. Follow it.
  if ((lith === L.SHALE || lith === L.SANDSTONE) && d > 60) {
    const seam = Math.round((elev + n1(seed, 701, c * nd(400).q, nd(400).p) * 60) / 145);
    const at = seam * 145 - n1(seed, 701, c * nd(400).q, nd(400).p) * 60;
    if (Math.abs(elev - at) < 2.2 && hh(seed, 703, seam, 0) < 0.45) return M.coal;
  }
  // OIL: a porous bed sealed under an impermeable shale cap, which is what a trap IS. Only in the anticlines —
  // the local highs of the bed — because that is where it collects.
  if (lith === L.SHALE && d > 110) {
    const arch = n1(seed, 711, c * nd(520).q, nd(520).p);
    const bed = Math.round((elev + arch * 90) / 240) * 240 - arch * 90;
    if (elev < bed && elev > bed - 16 && arch > 0.60) return M.oilshale;
  }
  // HYDROTHERMAL VEINS: along fractures, near igneous rock. Narrow, steeply inclined, and worth chasing.
  if (lith === L.GRANITE || lith === L.BASALT || lith === L.BASEMENT) {
    // ⚠️ the y argument carries a COLUMN term (the vein's dip), so this is one of the three sheared fields in
    // the world and needs a y period as well as an x one — see `shearQ` in noise.js.
    const vein = fb2(seed, 721, c * nd(11).q, elev / 26 + c * VEIN_SHEAR.k, 2, nd(11).p, VEIN_SHEAR.per);
    if (vein > 0.815) {
      const q = hh(seed, 723, wrapL(c >> 5, PERIOD_COLS >> 5), elev >> 5 | 0);
      return q < 0.34 ? M.iron : (q < 0.62 ? M.copper : M.quartz);
    }
  }
  // SALT DOME: evaporite is buoyant and rises in a plug through everything above it. Unmistakable in section.
  if (d > 90) {
    // ⚠️ the salt-dome lattice is quantised so it tiles the period (9,000 -> 8,996.4, 58 domes per world).
    const dk = Math.round(c / DOME_LAT.s), dw = wrapL(dk, DOME_LAT.n);
    const domeC = latAt(DOME_LAT, dk) + (hh(seed, 731, dw, 0) - 0.5) * 5000;
    if (W.lith[i] === L.EVAPORITE || hh(seed, 733, dw, 1) < 0.30) {
      const dxx = Math.abs(wdc(c - domeC)), top = 300 + hh(seed, 735, dw, 2) * 500;
      const wdt = 120 + 90 * n1(seed, 737, elev / 200);
      if (dxx < wdt && elev < -top + 900 && elev > -1600) return M.salt;
    }
  }
  // MAGMA CHAMBER: moved to volcano.js, unchanged in size and shape. ⭐ Not a tidy-up — it is what makes the
  // chill margin possible. As long as one generator could place lava and another could place a void with no
  // shared notion of where the melt is, the two could only be reconciled by ordering them, and ordering is a
  // rule you have to remember every time a generator is added. ONE file owns "where is lava" now, and every
  // void-maker in `fillColumn` asks it the same question.
  // GEODE / CRYSTAL CHAMBER: rare, in limestone, and lined rather than filled — the thing worth finding.
  if (lith === L.LIMESTONE && d > 130) {
    const g = fb2(seed, 751, c * nd(40).q, elev / 40, 2, nd(40).p);
    if (g > 0.845) return M.crystal;
  }
  return -1;
}

// ⭐ WHAT A VOID IS FULL OF, for anything that carves one. Exported so the placed-void layer floods from the
// same water table rather than carrying its own idea of where the water is — which is how a sea cave comes out
// full of sea without voids.js knowing that the sea exists.
// ⭐ AND IT IS THE CHOKE POINT WHERE A VOID'S LIQUID IS DECIDED, so making it ask the classifier gives every
// void-maker in the world — caves, descents, arches, sea caves, fracture swarms, the underworld — its liquid
// variety at once, including the ones written after this. Same argument as the chill margin and the speleothem
// post-pass: one rule covering generators that did not exist when it was written.
// ⚠️ ICE IS DECIDED FIRST AND SEPARATELY. It is a PHASE, not a liquid: a frozen pool is a solid, so it is not a
// point in the liquid space and must not be reachable by being "cold water".
function voidMaterial(U, M, ci, r, seaRow) {
  if (seaRow - r >= U.wt[ci.sample]) return M.air;
  if (ci.temp < 0.10 && r - ci.surfRow < 60) return M.ice;
  const l = liquidFor(atDepth(ci.sit, r - ci.surfRow, ci.hot, { silica: ci.silica }));
  return M[l.key];
}

module.exports = { prepareUnder, underAt, depositAt, voidMaterial };
