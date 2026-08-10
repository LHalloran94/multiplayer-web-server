'use strict';
// ==============================================================================================================
//  worldspike/caves.js — CAVE SYSTEMS AS PLACED RECORDS. The last home of mistake #1.
//
//  What this replaces was a FIELD: `sys[sample]` said whether a stretch of world was karst, `galleries[sample]`
//  held five level elevations per sample, and the cell loop read both. Three things follow from that and all
//  three are wrong:
//
//    · WHETHER THERE IS A CAVE AT ALL toggled at a 64-column sample boundary, because `sys` is a categorical
//      field and a categorical field cannot be interpolated. That is mistake #1 of this track, and this was its
//      last home — the biome boundaries, the lithology contacts, the water table and the river surface were all
//      fixed in earlier increments and this one was left because it was the largest.
//    · A PASSAGE HAD NO IDENTITY. `along > 0.46` decided per column whether the level was open here, so a
//      "gallery" was a string of unrelated openings that happened to lie at a similar height. Nothing connected
//      to anything; there was no cave, only cave-shaped holes.
//    · AND SO THERE WAS NO WAY IN. Nothing owned the question "can a player reach this", which is exactly the
//      defect the volcano's tube systems measured at 0-13% before they became records with a guaranteed mouth.
//
//  ⭐⭐ A SYSTEM IS A RECORD WITH A SHAPE AND AN ENTRANCE, and the whole design follows from wanting to guarantee
//  the second one. Levels run the system's full width, so a passage is a corridor you can follow rather than a
//  sequence of blobs. Shafts link adjacent levels at chosen points, so the levels form ONE network by
//  construction. And one shaft is driven from the surface to the top level, decided in the placement pass where
//  it can be checked — never hoped for in the cell loop.
//
//  ⭐ GALLERIES STILL SIT AT OLD WATER TABLES, which is the geology worth keeping from the old rule: a limestone
//  cave is dissolved along the water table, and when the land rises the passage is left dry and a new one forms
//  below it. So a system is a stack of near-horizontal storeys — which is why real cave maps look like a
//  building — and the modern water table then decides which storeys are flooded, for free.
//
//  ⚠️ Every coarse field this file needs is read ONCE, AT PLACEMENT, at the record's own endpoints. Nothing here
//  reads a sample per cell, which is the entire point.
// ==============================================================================================================
const { L } = require('./pipeline.js');
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// twelve others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');

const SOLUBLE = (l) => l === L.LIMESTONE || l === L.EVAPORITE;

// ==============================================================================================================
//  PLACEMENT
// ==============================================================================================================
function prepareCaves(W, C, columnInfo) {
  const seed = W.o.seed, out = [];
  const surf = (c) => columnInfo(W, C, c).surfRow;
  const wtAt = (c) => C.U.wt[((Math.round(c / W.dx) % W.n) + W.n) % W.n];   // read ONCE per record, not per cell

  // ── find the soluble stretches, then space systems along them ────────────────────────────────────────────────
  // ⚠️ The rock is still read per SAMPLE here, and that is correct: this is the layout pass, and a layout pass
  // is allowed to be coarse. What it may not do is hand a coarse categorical field to the cell loop.
  // ⚠️ SIZE THE SYSTEM TO THE ROCK IT IS IN. The first version wanted a run at least 1,800 cells long and
  // then carved a 800-to-1,800-cell system out of the middle of it — and placed 0 to 2 systems in a world,
  // because although soluble rock is 20-25% of this world's SAMPLES it arrives in short runs: 68 to 83 of them,
  // the longest 2,048 cells and most between 512 and 1,536. A cave system is as long as its limestone, and the
  // limestone here is a bed a few hundred metres across, not a province.
  let i = 0;
  while (i < W.n) {
    if (!SOLUBLE(W.lith[i]) || W.isSea[i]) { i++; continue; }
    let j = i; while (j < W.n && SOLUBLE(W.lith[j]) && !W.isSea[j]) j++;
    const runA = i * W.dx, runB = j * W.dx, w = runB - runA;
    i = j;
    if (w < 340) continue;
    const nSys = Math.max(1, Math.round(w / 1500));
    for (let k = 0; k < nSys; k++) {
      const a = Math.round(runA + w * k / nSys) + 26, b = Math.round(runA + w * (k + 1) / nSys) - 26;
      if (b - a < 280) continue;
      buildSystem(a, b, 3100 + ((a * 11) & 2047));
    }
  }

  function buildSystem(a, b, salt) {
    const at = Math.round((a + b) / 2);
    // ⭐ THE STOREYS. Elevations are stored at the two ENDS and interpolated along the record, so a level is a
    // straight-ish line with its own undulation — no sample lookup anywhere in the cell test.
    const nL = 2 + Math.floor(hh(seed, salt, 3, 0) * 3);
    const gap = 55 + Math.round(hh(seed, salt, 4, 0) * 85);
    const wA = wtAt(a), wB = wtAt(b);
    // The upper storeys sit ABOVE the modern water table — the land rose, the water dropped, and the old
    // passages were left high and dry — and the rest are below it and flooded.
    // ⚠️ `top` up to 1.1 meant only ever ONE dry storey. Real karst leaves a whole stack of abandoned
    // levels above the active one; up to 2.2 lets a system be mostly dry, mostly sump, or a mix.
    const top = 0.4 + 1.8 * hh(seed, salt, 5, 0);
    const levels = [];
    for (let k = 0; k < nL; k++) {
      const off = (top - k) * gap;
      levels.push({
        e0: wA + off, e1: wB + off,
        bore: 3.5 + hh(seed, salt, 10 + k, 0) * 7,
        salt: salt + 40 + k * 7,
      });
    }
    // ⭐ SHAFTS MAKE IT ONE NETWORK. Between every adjacent pair of storeys, at least one — otherwise the system
    // is n unconnected corridors and an entrance reaches only the storey it lands on.
    const shafts = [];
    for (let k = 0; k + 1 < nL; k++) {
      const nS = 1 + Math.floor(hh(seed, salt, 60 + k, 0) * 2);
      for (let s = 0; s < nS; s++) {
        shafts.push({
          x: lp(0.12, 0.88, hh(seed, salt, 70 + k * 4 + s, 0)),
          k, bore: 2.5 + hh(seed, salt, 80 + k * 4 + s, 0) * 4,
          salt: salt + 200 + k * 11 + s * 3,
        });
      }
    }
    // ⭐ CHAMBERS: where the dissolution ran strongest you get a hall rather than a passage. Rare, and big, and
    // floored, because the bottom of an ellipse is not somewhere a player can stand.
    const chambers = [];
    const nC = Math.floor(hh(seed, salt, 90, 0) * 3);
    for (let k = 0; k < nC; k++) {
      chambers.push({
        x: lp(0.15, 0.85, hh(seed, salt, 100 + k, 0)),
        k: Math.floor(hh(seed, salt, 110 + k, 0) * nL),
        hw: 24 + Math.round(hh(seed, salt, 120 + k, 0) * 70),
        hh: 12 + Math.round(hh(seed, salt, 130 + k, 0) * 26),
        salt: salt + 300 + k * 13,
      });
    }
    const S = { a, b, at, levels, shafts, chambers, salt, entrance: null };

    // ── THE WAY IN. Driven from the surface to the TOP storey, at the column where that storey is shallowest,
    // and decided here so it can be checked. ⚠️ If the storey is very deep everywhere this is a long shaft, so
    // it is refused past a limit and the system is left sealed rather than given a mine shaft.
    let bestX = -1, bestGap = 1e9;
    for (let x = 0.05; x <= 0.95; x += 0.02) {
      const c = Math.round(lp(a, b, x));
      const g = levelRow(S, 0, c, C.seaRow, seed) - surf(c);
      if (g > 6 && g < bestGap) { bestGap = g; bestX = x; }
    }
    if (bestX >= 0 && bestGap < 260) {
      const c = Math.round(lp(a, b, bestX));
      S.entrance = { x: bestX, top: surf(c) - 1, bot: Math.round(levelRow(S, 0, c, C.seaRow, seed)),
        bore: 2.5 + hh(seed, salt, 140, 0) * 3, salt: salt + 400 };
    }
    S.entranceDepth = bestGap < 1e9 ? Math.round(bestGap) : -1;
    out.push(S);
  }

  return out;
}

// The row of storey k at column c. ⭐ ONE function, used by the placement pass, the cell test and the diagnostic —
// the volcano's tubes cost two wrong conclusions in one run by having three copies of this.
function levelRow(S, k, c, seaRow, seed) {
  const L2 = S.levels[k];
  const t = cl(wdc(c - S.a) / Math.max(1, S.b - S.a), 0, 1);
  // ⚠️ Three scales of undulation, because with one the storeys came out as ruled lines. A palaeo water
  // table IS near-horizontal, which is the whole reason the storeys stack — but "near-horizontal" over a
  // thousand cells still rises and falls, and at a straight 34-row wobble the picture read as a mine.
  const e = lp(L2.e0, L2.e1, t)
    + (fb1(seed, L2.salt + 6, c * nd(1300).q, 2, nd(1300).p) - 0.5) * 46
    + (fb1(seed, L2.salt, c * nd(380).q, 2, nd(380).p) - 0.5) * 30
    + (fb1(seed, L2.salt + 3, c * nd(95).q, 2, nd(95).p) - 0.5) * 9;
  return seaRow - e;
}
// ⭐ ONE definition of where the entrance shaft is at a given row, because it is now asked by three callers —
// the cell test, the clearing post-pass and the diagnostics. Three copies of "where is the tube" cost this track
// two wrong conclusions in a single run on the volcano limbs.
function entranceOff(S, r, seed) {
  const E = S.entrance;
  // ⚠️ a shaft DRIFTS as it descends; a pipe at a fixed column reads as architecture.
  return E.x * Math.max(1, S.b - S.a) + (fb1(seed, E.salt, r / 38, 2) - 0.5) * 16;
}
// ⭐ THE OFFSET IS THE PRIMITIVE AND THE COLUMN IS DERIVED FROM IT, not the other way round: every cell test
// asks "how far am I from the shaft", and on a ring that has to be measured from the system's own origin.
function entranceCol(S, r, seed) { return S.a + entranceOff(S, r, seed); }

// ==============================================================================================================
//  🟥 THE MOUTH GETS OVERGROWN. Measured across three worlds: 19 of 55 placed entrances are SEALED, and the lids
//  are 81 cells of vegetation to 5 of soil. The shaft itself is carved perfectly — a clean ten-wide tube — and
//  then `drawFlora`, which runs as a post-pass over the finished column and writes into any air cell, closes a
//  canopy over the hole. `surfRow` is derived from the coarse elevation and knows nothing about carving, so the
//  plant is anchored exactly where the shaft comes out.
//
//  This is mistake #8 read from the other side. That one said a rule walking every void must know which side of
//  the surface it is on; this says a rule DRESSING the surface must know when the surface has a hole in it.
//
//  ⭐ A CHOKE POINT, not a per-site fix: one rule at the end of the column covering every placed mouth, so an
//  opening invented later is covered by it too — the same argument as the chill margin and the speleothem pass.
// ==============================================================================================================
const CLEAR_H = 40;                        // how far above the mouth the chimney is kept clear, in rows

// True if this cell is inside the clear space a mouth needs.
// 🟥 THE FIRST VERSION ONLY COVERED THE ROWS **ABOVE** `E.top`, on the reasoning that the shaft below it is
// `caveAt`'s business and a second rule there would be a duplicate. The picture said otherwise: the mouth was
// still sealed, and the row dump showed why — `caveAt` carves `E.top` to air and then `drawFlora` WRITES INTO
// IT, because a plant anchored at `surfRow` starts exactly there. The shaft's own top row was the lid.
// ⇒ the rule is "a plant may not stand in a placed mouth", which covers the shaft's whole extent, not just the
// sky above it. Reasoning about which rule owns a row was the mistake; the cells decide it.
function mouthClearAt(systems, c, r, seed) {
  for (const S of systems) {
    const E = S.entrance;
    if (!E) continue;
    if (r < E.top - CLEAR_H || r > E.bot) continue;
    const u = wdc(c - S.a), span0 = Math.max(1, S.b - S.a);
    if (u < -40 || u > span0 + 40) continue;
    // ⚠️ the chimney FLARES towards the sky rather than being a drilled cylinder — a constant-width hole through
    // a canopy reads as a pipe, which is mistake #5, and a real mouth is wider where it is open.
    const t = Math.max(0, (E.top - r) / CLEAR_H);
    const w = E.bore * (1 + 0.7 * t);
    if (Math.abs(u - entranceOff(S, r, seed)) < w) return true;
  }
  return false;
}

// ==============================================================================================================
//  THE ALTERNATIVE SHAPE — A COLLAPSE DOLINE. Instead of keeping a chimney clear through the dressing, the
//  GROUND ITSELF dips into a funnel at the mouth, which is what a karst entrance actually is: the roof of the
//  top storey fell in and the surface sagged after it. It is a `detail` term on the heightfield, exactly like
//  `craterDetail` and `cliffDetail`, so it costs what any other landform's fine signature costs.
//  ⚠️ It does NOT on its own guarantee the mouth stays open — a canopy can close over a funnel just as happily
//  as over a flat hole if the funnel is narrow relative to the trees. Measured, not assumed.
// ==============================================================================================================
function dolineDetail(systems, c, seed) {
  let drop = 0;
  for (const S of systems) {
    const E = S.entrance;
    if (!E) continue;
    const cxOff = E.x * Math.max(1, S.b - S.a);
    // ⚠️ radius and depth are properties of the RECORD, not of the column doing the looking (mistake #3).
    const R = 34 + hh(seed, S.salt + 501, 0, 0) * 46;
    const dep = 12 + hh(seed, S.salt + 503, 1, 0) * 20;
    const q = Math.abs(wdc(c - S.a) - cxOff) / R;
    if (q >= 1) continue;
    // a cosine bowl, roughened on the RIM position rather than on the depth — a bowl with noise added to its
    // depth is still a bowl, which is the objection that killed the analytic sky islands and the crater rim.
    const rough = 0.82 + 0.36 * fb1(seed, S.salt + 505, c * nd(21).q, 2, nd(21).p);
    const qq = Math.min(1, q / rough);
    drop = Math.max(drop, dep * 0.5 * (1 + Math.cos(Math.PI * qq)));
  }
  return drop;
}

function levelBore(S, k, c, seed) {
  const L2 = S.levels[k];
  return L2.bore * (0.55 + 0.9 * n1(seed, L2.salt + 5, c * nd(210).q, nd(210).p));
}

// ==============================================================================================================
//  THE CELL TEST. True if this cell is inside the system. Material is the caller's business, so the water table
//  floods a storey without this file knowing what water is — the same seam the placed overhangs use.
// ==============================================================================================================
function caveAt(systems, c, r, seaRow, seed) {
  for (const S of systems) {
    const span = Math.max(1, S.b - S.a), u = wdc(c - S.a);
    if (u < -40 || u > span + 40) continue;
    // ── the storeys ──────────────────────────────────────────────────────────────────────────────────────────
    for (let k = 0; k < S.levels.length; k++) {
      if (u < 0 || u > span) break;
      if (Math.abs(r - levelRow(S, k, c, seaRow, seed)) < levelBore(S, k, c, seed)) return true;
    }
    // ── the shafts that join them ────────────────────────────────────────────────────────────────────────────
    for (const sh of S.shafts) {
      const cxOff = sh.x * span;
      // ⚠️ a shaft DRIFTS as it descends. A pipe at a fixed column is a rectangle hundreds of rows tall, which
      // is what the old rule drew and what made the karst read as architecture.
      const dr = cxOff + (fb1(seed, sh.salt, r / 46, 2) - 0.5) * 34;
      if (Math.abs(u - dr) >= sh.bore) continue;
      const rA = levelRow(S, sh.k, c, seaRow, seed), rB = levelRow(S, sh.k + 1, c, seaRow, seed);
      if (r >= Math.min(rA, rB) - 2 && r <= Math.max(rA, rB) + 2) return true;
    }
    // ── the way in ───────────────────────────────────────────────────────────────────────────────────────────
    const E = S.entrance;
    if (E && Math.abs(u - entranceOff(S, r, seed)) < E.bore && r >= E.top && r <= E.bot + 2) return true;
    // ── chambers ─────────────────────────────────────────────────────────────────────────────────────────────
    for (const ch of S.chambers) {
      const cxOff = ch.x * span;
      if (Math.abs(u - cxOff) > ch.hw * 1.4) continue;
      const cy = levelRow(S, ch.k, S.a + Math.round(cxOff), seaRow, seed);
      const q = Math.sqrt(Math.pow((u - cxOff) / ch.hw, 2) + Math.pow((r - cy) / ch.hh, 2));
      const rough = 0.72 + 0.5 * fb1(seed, ch.salt, (c + r * 0.35) * nd(34).q, 3, nd(34).p);
      if (q < rough && r < cy + ch.hh * 0.55 + (fb1(seed, ch.salt + 2, c * nd(55).q, 2, nd(55).p) - 0.5) * 5) return true;
    }
  }
  return false;
}

// ⭐ THE COLUMN SHORTLIST — see the long note in descents.js. `caveAt` and `mouthClearAt` share ONE column
// rejection (`c < S.a - 40 || c > S.b + 40`), so they share one shortlist, and the bound here is that same
// expression rather than a second opinion about it.
// ⚠️ `mouthClearAt` additionally offsets by `entranceCol`, which wanders by up to 8 either way inside `S.a..S.b`
// — well inside the ±40 the systems already carry, so the shared bound stays conservative for both.
const CAVE_PAD = 40;
function cavesNear(systems, c) {
  let out = null;
  for (const S of systems) { const u = wdc(c - S.a); if (u >= -CAVE_PAD && u <= Math.max(1, S.b - S.a) + CAVE_PAD) (out || (out = [])).push(S); }
  return out || CAVES_EMPTY;
}
const CAVES_EMPTY = [];

module.exports = { prepareCaves, caveAt, levelRow, levelBore, entranceCol, mouthClearAt, dolineDetail, CLEAR_H,
  cavesNear };
