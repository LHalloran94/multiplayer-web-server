'use strict';
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// eleven others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');
// ==============================================================================================================
//  worldspike/sky.js — FLOATING ISLANDS THAT CARRY A LANDSCAPE.
//
//  What was there was a LENS: an ellipse with a roughened top and a roughened keel, 26 to 72 rows thick, dressed
//  from the ground below it. Wide enough, but with no relief on it — so it read as a slab of rock with grass on,
//  and the user's note was exactly right: small islands on their own rather than places.
//
//  ⭐⭐ AN ISLAND IS NOW A SURFACE, and that one change is what makes everything else free. Give it a top row
//  per column — a lens plus its own little heightfield — and every rule already written applies to it: the
//  vertical stack (cover, soil, subsoil, rock), the DRESSING (which is why an island drifting over snow country
//  wears snow and grows conifers, with no island-specific code), the FLORA table, and even standing water, since
//  a basin in its surface can be filled by exactly the scan the volcano craters use.
//
//  ⚠️ THE CLIMATE IS THE CLIMATE AT ITS OWN ALTITUDE, not the ground's. An island a thousand rows up is colder
//  than the land under it by the same lapse rate the pipeline applies to mountains — without that, a high island
//  over a warm coast comes out palm-fringed, which is the sort of detail that makes a world feel generated.
//
//  ⚠️ And its landscape TAPERS TO NOTHING AT THE RIM. A heightfield that keeps its relief to the edge overhangs
//  the keel, so the island's own hills hang off the side into the air.
// ==============================================================================================================

// ==============================================================================================================
//  GEOMETRY. Both surfaces are pure functions of (record, column) — no coarse sample is read per cell.
// ==============================================================================================================
function islandSpan(I, dx) { return { a: I.at - I.hwPx, b: I.at + I.hwPx }; }

// ⭐⭐ ONE-ENTRY COLUMN MEMOS — see the long note on `bandAt` in deepland.js, same argument exactly.
// `skyTop` and `skyBot` are PURE FUNCTIONS OF THE COLUMN (no row appears in either) and cost three and one fBm
// stacks respectively, and `skyAt` calls them for every cell it is asked about. Held on the island record so
// two worlds in one process cannot share a memo.
function skyTop(I, c, seed) {
  if (I._tc === c) return I._tv;
  const v = skyTopRaw(I, c, seed);
  I._tc = c; I._tv = v;
  return v;
}
function skyBot(I, c, seed) {
  if (I._kc === c) return I._kv;
  const v = skyBotRaw(I, c, seed);
  I._kc = c; I._kv = v;
  return v;
}
// the top of the island at this column, in rows
function skyTopRaw(I, c, seed) {
  const t = wdc(c - I.at) / I.hwPx;
  if (Math.abs(t) >= 1) return null;
  const q = Math.max(0, 1 - t * t);
  // ⚠️ `sqrt(q)` domes the top, so the surface descends monotonically from the centre and can hold no water at
  // all — 3 tarns in 101 islands. A low exponent gives a broad flat table with a steep rim instead, which is
  // both what a floating landmass should look like and what lets its own relief cut basins into it.
  const lens = I.topRow - I.thick * Math.pow(q, 0.22) * (0.82 + 0.36 * fb1(seed, I.salt + 1, c * nd(90).q, 3, nd(90).p));
  // ⭐ ITS OWN LANDSCAPE, tapered to nothing at the rim so it cannot overhang the keel
  const land = (fb1(seed, I.salt + 3, c * nd(240).q, 3, nd(240).p) - 0.5) * I.relief
    + (fb1(seed, I.salt + 5, c * nd(62).q, 3, nd(62).p) - 0.5) * I.relief * 0.34;
  return Math.round(lens - land * Math.pow(q, 0.7));
}
// the bottom of the keel — a root of rock hanging under the island, roughened independently
function skyBotRaw(I, c, seed) {
  const t = wdc(c - I.at) / I.hwPx;
  if (Math.abs(t) >= 1) return null;
  const q = Math.max(0, 1 - t * t);
  return Math.round(I.topRow + I.keel * q * (0.55 + 0.9 * fb1(seed, I.salt + 7, c * nd(76).q, 3, nd(76).p)));
}

// ==============================================================================================================
//  PLACEMENT — a second pass, because the tarn's level is found by measuring the surface the island will draw.
// ==============================================================================================================
function prepareSky(W, C, columnInfo, dressFn, M) {
  const seed = W.o.seed, out = [];
  for (const S of (W.sky || [])) {
    const at = Math.round(S.a * W.dx), hwPx = Math.max(120, Math.round(S.hw * W.dx));
    const salt = 6500 + ((S.a * 29) & 1023);
    const I = {
      at, hwPx, salt,
      topRow: C.seaRow - S.cy,                       // the lens's own top, before its landscape
      thick: S.top, keel: S.bot,
      relief: Math.round(lp(28, 150, hh(seed, salt, 2, 0)) * cl(hwPx / 900, 0.45, 1.6)),
      sample: ((Math.round(at / W.dx) % W.n) + W.n) % W.n,
      tarn: null,
    };
    // the climate this island actually sits in: the ground's, corrected to its own altitude
    const g = columnInfo(W, C, at);
    const islandElev = C.seaRow - I.topRow;
    // ⚠️ AT THE PIPELINE'S OWN LAPSE RATE (1/900) EVERY ISLAND IS ARCTIC. That rate is tuned for ground, whose
    // elevation reaches about 450 rows; the sky band runs to 1,700, so the same rate costs up to 1.9 of
    // temperature and the whole band came out uniformly frozen. Gentler, and capped, so the band VARIES —
    // which is the point of dressing islands from climate at all.
    I.temp = cl(g.temp - Math.min(0.45, Math.max(0, islandElev - g.elev) / 2200), 0, 1);
    I.moist = cl(g.moist * 0.92 + 0.05, 0, 1);      // a little wetter: it is in the cloud layer
    I.elev = islandElev;
    I.lith = g.lith;

    // ⭐ A TARN. The surface has hollows, so it can hold water — found by the same rule the crater lakes and the
    // underground pools use: rise one row at a time and keep the last level that HELD. Nothing else in the
    // pipeline had to change for a floating island to have a lake on it.
    const step = Math.max(1, Math.round(hwPx / 160));
    const prof = [];
    for (let c = at - hwPx + 2; c <= at + hwPx - 2; c += step) prof.push([c, skyTop(I, c, seed)]);
    let lowK = 0;
    for (let k = 1; k < prof.length; k++) if (prof[k][1] > prof[lowK][1]) lowK = k;
    const floorRow = prof[lowK][1];
    let held = floorRow, hl = lowK, hr = lowK;
    for (let lvl = floorRow - 1; lvl > floorRow - 90; lvl--) {
      let kl = -1, kr = -1;
      for (let k = lowK; k >= 0; k--) if (prof[k][1] <= lvl) { kl = k; break; }
      for (let k = lowK; k < prof.length; k++) if (prof[k][1] <= lvl) { kr = k; break; }
      if (kl < 0 || kr < 0) break;
      held = lvl; hl = kl; hr = kr;
    }
    const depth = floorRow - held, wide = prof[hr][0] - prof[hl][0];
    if (depth >= 5 && wide >= 24) {
      I.tarn = { top: held + 2, l: prof[hl][0], r: prof[hr][0], depth: depth - 2 };
    }
    // dressing, from the island's OWN climate and altitude — the same function the ground uses
    // ⚠️ AND THE SNOW LINE IS ASKED ABOUT A VIRTUAL ALTITUDE, not the true one. Dressed at its real height, 83
    // of 101 islands came out under snow — physically defensible (they ARE a mile up) and a monotonous white
    // band, which is the opposite of "floating versions of different landscapes". They float; they are not
    // bound to the lapse structure. A third of the height above the ground, capped, gives a highland climate
    // instead of an arctic one and lets the band vary, which is the whole point of dressing them from climate.
    I.dressElev = g.elev + Math.min(500, Math.max(0, islandElev - g.elev) * 0.35);
    I.dress = dressFn(I.temp, I.moist, I.dressElev, 0.35, false, null);
    out.push(I);
  }
  void M; void islandSpan;
  return out;
}

// ==============================================================================================================
//  THE CELL ANSWER. Returns a material, or -1.
// ==============================================================================================================
function skyAt(islands, M, LITH_MAT, c, r, seed) {
  for (const I of islands) {
    if (Math.abs(wdc(c - I.at)) >= I.hwPx) continue;
    const top = skyTop(I, c, seed);
    if (top === null) continue;
    // standing water in the island's own basin, above its ground
    if (I.tarn && r < top && r >= I.tarn.top && wdc(c - I.tarn.l) > 0 && wdc(c - I.tarn.r) < 0) {
      return I.dress.canSnow ? M.ice : M.water;
    }
    if (r < top) continue;
    const bot = skyBot(I, c, seed);
    if (bot === null || r > bot) continue;
    const dd = r - top, D = I.dress;
    if (dd < 1 && D.canSnow) return M.snow;
    if (dd < 3 && D.canSnow) return M.snow;
    if (dd < 1) return D.cover;
    if (dd < D.soil) return D.cover === M.sand ? M.sand : (D.cover === M.peat ? M.peat : M.loam);
    if (dd < D.soil + 5) return I.moist > 0.55 ? M.clay : M.loam;
    if (dd < D.soil + 12) return M.gravel;
    return LITH_MAT[I.lith] !== undefined ? LITH_MAT[I.lith] : M.stone;
  }
  return -1;
}

// A synthetic column reading for an island, so the FLORA table can be run on it unchanged.
function skyColumnInfo(I, ci, c, seed) {
  const top = skyTop(I, c, seed);
  if (top === null) return null;
  const D = I.dress;
  // 🟥 THE ELEVATION HANDED TO FLORA MUST BE THE SAME VIRTUAL ONE THE DRESSING USED. Given the island's TRUE
  // height, every species' elevation window failed — the windows are written for ground, which tops out around
  // 450 rows, and the sky band runs to 1,700 — so 202 islands grew not one plant while the dressing happily
  // called them turf. Two rules disagreeing about what "how high is this" means, which is the same shape as the
  // three flora bugs the user spotted.
  return { ...ci, sky: true, surfRow: top, elev: I.dressElev + (I.topRow - top), temp: I.temp, moist: I.moist,
    steep: D.steep, soil: D.soil, cover: D.cover, canSnow: D.canSnow, canTree: D.canTree, vent: false };
}

// ⭐ THE COLUMN SHORTLIST — see the long note in descents.js. This is the list that costs most in the profile
// despite islands being far from the commonest record: there are ~101 of them, and `skyAt` is asked for every
// AIR cell above the surface row — which, over an ocean, includes cells 300 rows below sea level.
// ⚠️ The bound is `skyAt`'s own rejection (`|c - I.at| >= I.hwPx`), widened by 2. The per-column flora loop in
// cells.js uses `I.hwPx - 2`, i.e. a strictly TIGHTER test, so this shortlist is conservative for it too.
function skyNear(islands, c) {
  let out = null;
  for (const I of islands) if (Math.abs(wdc(c - I.at)) < I.hwPx + 2) (out || (out = [])).push(I);
  return out || SKY_EMPTY;
}
const SKY_EMPTY = [];

module.exports = { prepareSky, skyAt, skyTop, skyBot, skyColumnInfo, skyNear };
