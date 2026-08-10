'use strict';
// ==============================================================================================================
//  worldspike/noise.js — THE NOISE PRIMITIVES, ONCE. Extracted 2026-08-09 for the periodicity work (inc 2).
//
//  🟥 THEY WERE COPIED INTO THIRTEEN FILES. Verified before extracting rather than assumed: every copy of
//  `hh`/`sm`/`n1`/`n2`/`fb1`/`fb2`/`cl`/`lp` is character-identical after normalisation, except two purely
//  cosmetic differences (`formations.js` named a local `s2` instead of `s`; `liquids.js` wrapped `cl`'s body in
//  redundant parentheses). So this extraction is output-preserving, and `probe_cost`'s checksum proves it.
//  ⚠️ Thirteen copies of one function is mistake #2 one level up — two rules that could disagree about what a
//  number means. They never did; the point is that adding a PERIOD to thirteen copies is thirteen chances to.
//
//  ⚠️⚠️ THE EXTRACTION IS NOT FREE AND THE NUMBER IS RECORDED HERE RATHER THAN DISCOVERED LATER. Measured over
//  three runs a side (medians, ms per 64x64 chunk):
//        local copies        sky 1.44 · surface 4.03 · shallow 6.01 · deep 6.41 · underworld 5.62
//        this module, no per sky 1.56 · surface 4.33 · shallow 6.21 · deep 7.01 · underworld 6.01   ~ +7%
//        this module, per    sky 1.68 · surface 4.74 · shallow 6.68 · deep 7.25 · underworld 6.18   ~ +13%
//  So ~7% is the MODULE BOUNDARY (V8 specialises a small function per call site; one shared copy serving ~200
//  sites loses that) and ~6% is the `per` branch, which is the feature's own cost and unavoidable.
//  ⇒ KEPT ANYWAY, deliberately: the ~7% buys a 338-call-site sweep against ONE definition instead of thirteen,
//  and the module split is spike SCAFFOLDING — the port lands in a single server file where these become local
//  again. ⏭️ **The port should inline them back**, and that is worth ~7% for free when it does.
//
//  ── PERIODICITY ──────────────────────────────────────────────────────────────────────────────────────────────
//  Every function takes an OPTIONAL trailing `per`: the number of LATTICE CELLS after which the field repeats.
//  `per` falsy (undefined / 0) means "not wrapped" and reproduces today's behaviour exactly, which is what makes
//  the sweep incremental — a call site that has not been converted yet still works.
//
//  🟥 FOUR THINGS THE SHIPPED GENERATOR GOT WRONG HERE FIRST, all recorded in server/worldgen.js. This file is a
//  port of the ANSWERS, not a re-derivation:
//   1. THE FREQUENCY IS QUANTISED, NOT THE PERIOD. For a field to repeat at P columns, the lattice period `q*P`
//      must be a whole number of cells. Round the PERIOD and keep the frequency and you get a field periodic at
//      `round(q*P)/q` — a different number — measured at |f(c) - f(c+P)| = 0.49 on a 0..1 field, i.e. none at
//      all, from code that reads correctly. `nfreq()` below rounds the lattice period and derives the frequency
//      BACK from it. Callers must sample at `.q` and wrap at `.p`, never at the literal they asked for.
//   2. THE WRAP GOES ON THE LATTICE, NEVER ON THE COLUMN. Folding the input (`c % P`) leaves a HARD SEAM at the
//      join — measured 4.6e-1 across it against an ordinary step of 1.1e-2 — because the interpolation either
//      side of the fold reads two unrelated lattice cells.
//   3. OCTAVE i SAMPLES AT x*2^i, SO ITS LATTICE PERIOD IS per*2^i. Getting that wrong makes the low octave
//      periodic and the high ones not: a field periodic in its shape and not in its detail.
//   4. Y IS NEVER WRAPPED. Rows are the world's DEPTH, which has two real ends (bedrock below, sky above).
//      Only the horizontal axis can be a circle. `n2` takes one period and applies it to x alone.
// ==============================================================================================================

// THE PERIOD. 524,288 columns = 4,194,304 px at 8px cells.
// ⭐ Not a choice — the ceiling. Increment 6 measured the widest world the flat cell index allows at 4,096 rows
// as 524,224 columns, so the repeat sits just past the widest world that can currently exist: unreachable, and
// therefore invisible, until the index is widened past 2^31. A field periodic at P is automatically periodic at
// 2P/4P/8P, so widening later opens a menu of wrap circumferences rather than closing one off.
// ⚠️ MUST match `server/worldgen.js`'s PERIOD_COLS, and for the same reason: the two generators address the same
// world. Not imported, because the spike deliberately does not depend on the server tree.
const PERIOD_COLS = 1 << 19;

// `want` is a per-COLUMN frequency (e.g. 1/26 for what used to be written `c / 26`).
// Returns { p, q }: p = lattice cells per world period (an integer), q = the frequency to actually sample at.
// ⚠️ Drift is tiny — a divisor of 26 moves by ~0.0004%.
// 🟥 THE ~30% FIGURE RECORDED ON THIS TRACK WAS ABOUT ANCHOR LATTICES, AND IT TURNED OUT NOT TO APPLY THERE
// EITHER. The reasoning was "an anchor spacing must be an INTEGER divisor of P, and P is a power of two, so
// spacings snap to powers of two" — which is true only if the spacing has to be an integer, and it does not.
// See `nlat` below: quantise the anchor COUNT and the spacing is free to be fractional, which turns a 43% move
// into a 0.08% one. Nothing in this world moves by 30% for periodicity.
function nfreq(want) {
  const p = Math.max(1, Math.round(Math.abs(want) * PERIOD_COLS));
  return { p, q: (want < 0 ? -p : p) / PERIOD_COLS };
}
// Convenience for the commonest form in this codebase, `x / K`  ⇒  `x * nd(K).q`, wrap at `nd(K).p`.
const _ndCache = new Map();
function nd(K) { let v = _ndCache.get(K); if (!v) { v = nfreq(1 / K); _ndCache.set(K, v); } return v; }

const wrapL = (i, per) => (i >= 0 && i < per) ? i : ((i % per) + per) % per;

// ⭐⭐ AN ANCHOR LATTICE THAT TILES THE PERIOD. Faults, ore bodies, salt domes, tree stands and volcanic pipes are
// all placed on a lattice of "every S columns, jittered", and a lattice that does not divide the period puts half
// an anchor at the join however periodic the noise around it is.
// 🟥 THE OBVIOUS FIX IS THE EXPENSIVE ONE. The period is a power of two, so the only INTEGER spacings that divide
// it are powers of two — snapping a 900-column spacing that way gives 512, a 43% move, and that is where this
// increment's recorded "~30%" warning comes from. Quantise the COUNT instead and let the spacing be fractional:
// 900 becomes 899.29, a 0.08% move. Exactly the same argument as `nfreq` one axis over.
//   nlat(S).s = the spacing to actually use  ·  nlat(S).n = anchors per period, an integer to wrap the index at
const _nlCache = new Map();
function nlat(S) {
  let v = _nlCache.get(S);
  if (!v) { const n = Math.max(1, Math.round(PERIOD_COLS / S)); v = { n, s: PERIOD_COLS / n }; _nlCache.set(S, v); }
  return v;
}
// ⭐ THE COLUMN OF ANCHOR `k`. Use this rather than `k * L.s`.
// 🟥 `(k + n) * s` AND `k * s + P` ARE NOT THE SAME NUMBER. The spacing is deliberately fractional, so it is not
// exact in binary, and the product's last bit drifts with k — an anchor whose position lands near a .5 boundary
// then rounds to a different column one period along. That is a world that repeats everywhere except at a
// handful of anchors, which is the worst possible failure: invisible, rare, and real. Computing from the
// WRAPPED index and adding whole periods makes it exact by construction rather than by luck.
const latAt = (L, k) => { const kw = wrapL(k, L.n); return Math.round(kw * L.s) + ((k - kw) / L.n) * PERIOD_COLS; };

// ⭐⭐ THE DISTANCE FROM A COLUMN TO A PLACED RECORD, ON A RING. `wdc(c - V.at)`.
// A volcano, a cliff, a cave, a sky island is a RECORD with a column on it, and every module asks "how far am I
// from it" as a plain subtraction. On a ring that subtraction is wrong twice over: a column one period along is
// half a million cells from every record in the world (so the world stops repeating), and a record sitting
// twenty cells from the join cannot reach the columns twenty cells the OTHER side of it (so the join grows a
// featureless band). Both are fixed by the same thing — the signed SHORTEST way round.
// ⚠️ Deliberately NOT the same mechanism as the noise wrap. There is no interpolation here to straddle the join,
// so folding the difference is correct (the same argument `hc` makes); the noise fields could not do this.
// ⚠️ The in-range fast path is not micro-optimisation: several of these sit inside the per-CELL loop, and a `%`
// there is measurable where a perfectly-predicted comparison is not.
const HALF_P = PERIOD_COLS >> 1;
const wdc = (d) => (d >= -HALF_P && d <= HALF_P) ? d
  : ((((d % PERIOD_COLS) + PERIOD_COLS + HALF_P) % PERIOD_COLS) - HALF_P);

function hh(seed, salt, x, y) {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263 + salt * 2246822519 + seed * 1013904223;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
// A hash taken on a raw COLUMN rather than through a noise field — whether an anchor is real, how tall a mound
// is, which side of a boundary a cell falls on. ⚠️ Every noise field in the world can repeat perfectly and the
// world still not repeat, because these decide where the features ARE. Folding is CORRECT here (unlike #2
// above) precisely because there is no interpolation to straddle the join.
const hc = (seed, salt, c, y) => hh(seed, salt, wrapL(c, PERIOD_COLS), y);

const sm = (t) => t * t * (3 - 2 * t);

function n1(seed, salt, x, per) {
  const i = Math.floor(x), f = x - i;
  const i0 = per ? wrapL(i, per) : i, i1 = per ? (i0 + 1 === per ? 0 : i0 + 1) : i + 1;
  return hh(seed, salt, i0, 0) * (1 - sm(f)) + hh(seed, salt, i1, 0) * sm(f);
}
// ⚠️ `pery` IS THE ONE EXCEPTION TO "Y IS NEVER WRAPPED", AND IT IS NARROW. A field that is SHEARED by the
// column — `f(c/11, (elev + c*dip)/26)`, which is how a dipping ore vein is drawn — cannot repeat in x alone: one
// period along, y has slid by `P*dip/26`. The only way to close that is for y to be a circle too, and it is
// harmless here for exactly the reason PERIOD_COLS is harmless: the shear quantiser below picks a y period of
// tens of thousands of lattice cells (millions of rows), which is hundreds of times the world's own depth.
// ⇒ pass `pery` ONLY where a column term appears in y. A plain depth field must never get one.
function n2(seed, salt, x, y, per, pery) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = sm(x - xi), fy = sm(y - yi);
  const x0 = per ? wrapL(xi, per) : xi, x1 = per ? (x0 + 1 === per ? 0 : x0 + 1) : xi + 1;
  const y0 = pery ? wrapL(yi, pery) : yi, y1 = pery ? (y0 + 1 === pery ? 0 : y0 + 1) : yi + 1;
  const a = hh(seed, salt, x0, y0), b = hh(seed, salt, x1, y0), c = hh(seed, salt, x0, y1), d = hh(seed, salt, x1, y1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
// The shear quantiser. `shearQ(k)` takes the per-COLUMN rate at which a field's y argument slides (i.e. `dip/26`
// for the vein above) and returns { k, per }: the rate to actually use, and the y lattice period that makes it
// close. Same shape of answer as `nfreq` and `nlat` — quantise so the world's period is a whole number of
// lattice cells, and take the tiny change in the constant rather than a seam.
const _sqCache = new Map();
function shearQ(want) {
  let v = _sqCache.get(want);
  if (!v) {
    const per = Math.max(1, Math.round(Math.abs(want) * PERIOD_COLS));
    v = { per, k: (want < 0 ? -per : per) / PERIOD_COLS };
    _sqCache.set(want, v);
  }
  return v;
}
// ⚠️ `per * f` — see #3 in the header. `per` is an integer and f doubles, so every octave's period is an
// integer too, and the whole stack repeats together.
function fb1(seed, salt, x, oct, per) {
  let a = 1, f = 1, s = 0, t = 0;
  for (let o = 0; o < oct; o++) { s += a * n1(seed, salt + o * 37, x * f, per ? per * f : 0); t += a; a *= 0.5; f *= 2; }
  return s / t;
}
function fb2(seed, salt, x, y, oct, per, pery) {
  let a = 1, f = 1, s = 0, t = 0;
  for (let o = 0; o < oct; o++) { s += a * n2(seed, salt + o * 37, x * f, y * f, per ? per * f : 0, pery ? pery * f : 0); t += a; a *= 0.5; f *= 2; }
  return s / t;
}

const cl = (v, a, b) => v < a ? a : v > b ? b : v;
const lp = (a, b, t) => a + (b - a) * t;

module.exports = { PERIOD_COLS, nfreq, nd, nlat, latAt, shearQ, wrapL, wdc, hh, hc, sm, n1, n2, fb1, fb2, cl, lp };
