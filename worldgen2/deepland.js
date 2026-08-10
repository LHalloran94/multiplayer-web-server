'use strict';
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// eleven others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');
// ==============================================================================================================
//  worldspike/deepland.js — THE UNDERWORLD: A BURIED LANDSCAPE, NOT A ROOM.
//
//  What was there was `layoutDeep`: ellipses on a lattice, each cut and then floored flat because the bottom of
//  an ellipse is not somewhere to stand. Rooms. The user's call was the mirror of the sky-island one — instead
//  of discrete halls, a CONTINUOUS band with a floor and a ceiling, carrying its own terrain.
//
//  ⭐⭐ AND IT IS THE SAME TRICK AS THE ISLANDS, UPSIDE DOWN. An island became a surface and everything already
//  written applied to it. The underworld is TWO surfaces — a floor you walk on and a ceiling overhead — and the
//  same things follow: a vertical stack under the floor, standing water in the floor's basins found by the rise-
//  one-row scan, and vegetation, once "what grows here" is asked of depth and rock instead of of climate.
//
//  ⭐ THE BAND IS NOT CONTINUOUS EVERYWHERE, and that is the point of the `half` field: where it goes negative
//  the two surfaces cross and the band is simply solid rock. So the underworld is a chain of PROVINCES with
//  rock between them rather than one corridor running the width of the world, which is what a single open band
//  would be and would be unbearable to travel.
//
//  ⚠️ It goes through `fillColumn`'s carve gate like every other void, so the chill margin applies: where the
//  band runs into a magma body — and it does, the two overlap in elevation — it stops at a wall of chilled
//  basalt instead of draining the volcano into the underworld.
// ==============================================================================================================

const MID = -1320, SWING = 300;          // where the band sits, in elevation
const OPEN = 430;                        // how far the two surfaces can part
const MINH = 26;                         // below this the band counts as closed

// ==============================================================================================================
//  THE TWO SURFACES. Pure functions of the column — no coarse sample is read per cell, ever.
// ==============================================================================================================
// ⭐⭐ ONE-ENTRY COLUMN MEMO, AND IT IS FREE BY CONSTRUCTION. `bandAt` is a PURE FUNCTION OF THE COLUMN — there
// is no row anywhere in it — and it costs SIX fBm stacks, roughly twenty hash reads. `deepAt` calls it as its
// very first line, so it was being recomputed for every cell of every column below `C.deepTop`: 4.9% of the
// whole profile sat in this one function's noise.
// `fillColumn` walks a column top to bottom, so a single entry hits 63 times in 64. This is the same device as
// `server/worldgen.js`'s direct-mapped `surfAt` cache, and the same argument for why it is safe: a memo over a
// pure function cannot change what it caches. ⚠️ Held ON THE RECORD, so two worlds in one process cannot share
// it — a module-level memo would be exactly the cross-world contamination `probe_cost` runs two seeds to catch.
function bandAt(D, c) {
  if (D._bc === c) return D._bv;
  const v = bandAtRaw(D, c);
  D._bc = c; D._bv = v;
  return v;
}
function bandAtRaw(D, c) {
  const s = D.seed;
  const mid = MID + (fb1(s, 7001, c * nd(5200).q, 3, nd(5200).p) - 0.5) * 2 * SWING;
  // ⭐ the opening. Negative closes the band completely, which is what makes provinces.
  const half = (fb1(s, 7003, c * nd(2100).q, 3, nd(2100).p) - 0.42) * OPEN;
  // the floor has its own relief — hills, ridges and hollows, at the scale of a landscape rather than a room
  const relief = (fb1(s, 7005, c * nd(620).q, 3, nd(620).p) - 0.5) * 150 + (fb1(s, 7007, c * nd(130).q, 3, nd(130).p) - 0.5) * 42;
  // the ceiling is rougher and independent: pendants and domes, not a mirror of the floor
  const roof = (fb1(s, 7009, c * nd(380).q, 4, nd(380).p) - 0.5) * 120 + (fb1(s, 7011, c * nd(74).q, 3, nd(74).p) - 0.5) * 46;
  // 🟥🟥 `open` AND THE BAND'S ACTUAL GEOMETRY DISAGREED ABOUT ITS HEIGHT — mistake #2, and it is what put three
  // of seven sampled descent routes at 0% reachable for weeks. Openness was decided from `half * 2` alone, while
  // the ceiling and floor are `mid + half + roof` and `mid - half + relief`, so the REAL height is
  // `2*half + roof - relief`. Wherever the floor's relief happened to exceed the opening plus the roof's, the
  // band INVERTED — ceiling below floor — and still reported `open: true`, because the test never looked at
  // either term. Measured: 1.6–1.7% of all open-band columns in every seed, and descents land in them (1 of 7
  // in seed 1234, 3 of 28 in seed 555). A descent aimed at one arrives in solid rock and connects to nothing.
  // ⇒ the height is computed, then tested. `MINH` finally means what it says.
  // ⚠️ `ceilE - floorE`, because the ceiling is the HIGHER ELEVATION and `rowOf` flips the sign. Written the
  // other way round first — and it is the same axis confusion the deep reader hit once before, where elevation 0
  // was reported against lake levels that were true elevations.
  const ceilE = mid + half + roof, floorE = mid - half + relief;
  return { ceilE, floorE, open: ceilE - floorE > MINH };
}
const rowOf = (seaRow, e) => Math.round(seaRow - e);

// ==============================================================================================================
//  PLACEMENT: find the provinces, and put standing water in the floor's basins.
// ==============================================================================================================
function prepareDeep(W, C) {
  const D = { seed: W.o.seed, seaRow: C.seaRow, lakes: [], provinces: [] };
  const wCells = W.n * W.dx;
  const STEP = 24;
  let runStart = -1;
  const prof = [];
  // ⭐⭐ THE SCAN IS A RING TOO. Starting at column 0 CUTS whatever province sits on the join into two halves and
  // computes each half's lakes against a basin it can only see part of — the same defect the coarse pass had at
  // its two ends, and the reason that pass became a ring. So: find a CLOSED column first and start there, then
  // walk one whole period. Columns past the end are left UNWRAPPED (`bandAt` is periodic, so it does not care)
  // and the ring-aware span tests below handle records that reach across.
  let c0 = 0;
  while (c0 < wCells && bandAt(D, c0).open) c0 += STEP;
  if (c0 >= wCells) c0 = 0;                 // the band is open everywhere: one province, and no join to cut
  for (let k = 0; k < wCells; k += STEP) {
    const c = c0 + k;
    const b = bandAt(D, c);
    if (b.open) { if (runStart < 0) { runStart = c; prof.length = 0; } prof.push([c, rowOf(D.seaRow, b.floorE)]); }
    else if (runStart >= 0) { closeRun(runStart, c, prof.slice()); runStart = -1; }
  }
  if (runStart >= 0) closeRun(runStart, c0 + wCells, prof.slice());

  function closeRun(a, b, p) {
    if (b - a < 400 || p.length < 8) return;
    D.provinces.push({ a, b });
    // ⭐ LAKES, by the rule this pipeline now uses in four places: rise one row at a time and keep the last
    // level that HELD. A basin in the floor of the underworld is a basin like any other.
    // ⚠️ scanned over the province only, so a lake cannot leak into the next one through the rock between them.
    let k = 1;
    while (k < p.length - 1) {
      if (!(p[k][1] > p[k - 1][1] && p[k][1] >= p[k + 1][1])) { k++; continue; }   // a local low point
      let lowK = k;
      while (lowK + 1 < p.length && p[lowK + 1][1] >= p[lowK][1]) lowK++;
      const floorRow = p[lowK][1];
      let held = floorRow, hl = lowK, hr = lowK;
      // ⚠️ 150 ROWS OF RISE DROWNS THE PROVINCE. The floor's own relief is about ±190 rows, so a lake allowed to
      // rise that far simply fills the whole undulation from one containing ridge to the next — the picture came
      // out as a flat blue sheet across every panel with 10-31% of the frame walkable. A lake is a feature OF the
      // landscape, not the landscape's water table; capped, so it sits in the deepest hollows only.
      for (let lvl = floorRow - 1; lvl > floorRow - 42; lvl--) {
        let il = -1, ir = -1;
        for (let i = lowK; i >= 0; i--) if (p[i][1] <= lvl) { il = i; break; }
        for (let i = lowK; i < p.length; i++) if (p[i][1] <= lvl) { ir = i; break; }
        if (il < 0 || ir < 0) break;
        held = lvl; hl = il; hr = ir;
      }
      const depth = floorRow - held, wide = p[hr][0] - p[hl][0];
      if (depth >= 8 && wide >= 90 && wide < (b - a) * 0.42) {
        D.lakes.push({ l: p[hl][0], r: p[hr][0], top: held + 3 });
        k = hr + 1;
      } else k = lowK + 1;
    }
  }
  return D;
}

// ==============================================================================================================
//  THE CELL ANSWER. Returns a material, or -1.
//  ⭐ DRESSED BY DEPTH AND ROCK, which is the underworld's equivalent of climate — and it is what stops the
//  whole band being one grey corridor. A limestone province has a pale rubble floor, a basalt one is black sand
//  and ash, a shale one is mud.
// ==============================================================================================================
function deepAt(D, M, LITH_MAT, L, lith, c, r, seed) {
  const b = bandAt(D, c);
  if (!b.open) return -1;
  const cr = rowOf(D.seaRow, b.ceilE), fr = rowOf(D.seaRow, b.floorE);
  if (r < cr || r > fr + 160) return -1;
  if (r < fr) {
    // the void. Standing water where a lake covers this column and the level is above this row.
    // ⚠️ ON THE RING: a lake straddling the join has `l` numerically greater than `r`, and the plain span test
    // then excludes all of it — the same fix the sky tarns and the crater lakes needed.
    for (const lk of D.lakes) if (wdc(c - lk.l) > 0 && wdc(c - lk.r) < 0 && r >= lk.top) return M.water;
    return M.air;
  }
  // ── the floor's own stack, by depth below it ────────────────────────────────────────────────────────────────
  const dd = r - fr;
  const rock = LITH_MAT[lith] !== undefined ? LITH_MAT[lith] : M.stone;
  let cover, sub;
  if (lith === L.LIMESTONE || lith === L.EVAPORITE) { cover = M.gravel; sub = M.limestone; }
  else if (lith === L.BASALT) { cover = M.ash; sub = M.basalt; }
  else if (lith === L.SHALE) { cover = M.mud; sub = M.shale; }
  else if (lith === L.SANDSTONE) { cover = M.sand; sub = M.sandstone; }
  else { cover = M.gravel; sub = rock; }
  const t = 2 + Math.round(3 * n1(seed, 7021, c * nd(34).q, nd(34).p));
  if (dd < t) return cover;
  if (dd < t + 8) return sub;
  // 🟥🟥 THIS USED TO `return rock`, AND IT STERILISED A 160-ROW BAND UNDER EVERY CAVERN IN THE WORLD.
  // `deepAt` runs AFTER the mineral pass in `fillColumn` and overwrites `v` wherever it answers, so claiming
  // every row down to `fr + 160` meant the ore, the bedding and the fracture swarms were all painted back out
  // — in exactly the place a player who has just climbed down is standing. Measured (`probe_deep_ore.js`):
  // 0.6 ore cells per thousand for rows 0-159 below the floor, then 135 per thousand from row 160. A step that
  // sharp is never geology; it is a window boundary, and the user spotted it in the picture first.
  // ⚠️ THE FIX IS TO STOP ANSWERING, NOT TO RETURN A DIFFERENT ROCK. Past its own floor stack the underworld
  // has nothing to say about the cell: it is ordinary bedrock, and the ordinary rules — lithology bedding,
  // minerals, fractures — already know what to do with it. `rock` here was a SECOND opinion about plain ground,
  // and the two disagreed by everything the ordinary path adds.
  // ⚠️ `dd < t + 8` is the real extent of what this band owns. The `fr + 160` test above is now just an
  // early-out and no longer decides anything.
  return -1;
}

// A synthetic column reading for the underworld floor, so the FLORA table can be run on it unchanged.
// ⚠️ `temp` and `moist` are not climate here — they are how the deep species' windows are addressed. Depth
// stands in for temperature (it gets hotter down) and the rock's dampness for moisture.
function deepColumnInfo(D, ci, c, M) {
  const b = bandAt(D, c);
  if (!b.open) return null;
  const fr = rowOf(D.seaRow, b.floorE);
  const depth01 = cl((-b.floorE - 700) / 1600, 0, 1);
  return { ...ci, deep: true, surfRow: fr, elev: D.seaRow - fr, temp: depth01, moist: 0.7,
    steep: 0.1, soil: 3, cover: M.gravel, canSnow: false, canTree: false, vent: false };
}

module.exports = { prepareDeep, deepAt, bandAt, deepColumnInfo, rowOf, MINH };
