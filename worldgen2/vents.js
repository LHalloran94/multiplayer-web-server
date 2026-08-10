'use strict';
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js).
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');
// ==============================================================================================================
//  worldspike/vents.js — HYDROTHERMAL VENT FIELDS. THE REASON TO GO TO THE BOTTOM OF THE SEA.
//
//  The ocean now has shape — a shelf, a slope, a plain, trenches, ridges, seamounts, canyons — and until this
//  file it had no CONTENT: nowhere worth the swim. A vent field is the answer the real world already gives, and
//  it is the right one for three separate reasons rather than one:
//
//    · IT IS WHERE THE METAL IS. Seafloor massive sulphide is where a large share of the world's copper, zinc,
//      lead, silver and gold actually formed. So "the deepest place is the richest" is not a game balance
//      decision anyone had to take — it is what the geology says, and the mineral table already has the metals.
//    · IT HAS A SILHOUETTE. Chimneys are unmistakable: thin spires standing in a group on an otherwise flat
//      plain. Nothing else in this world looks like that, which is what makes it a landmark rather than a patch.
//    · IT HAS A PLACE TO BE. Vents sit on spreading centres and in trenches, both of which are now records —
//      so the siting rule is a lookup, and a player who learns "ridge axis" has learned something transferable.
//
//  ⚠️ NOT EVERY RIDGE HAS ONE. A field on every ridge in every world makes it scenery; the roll is what keeps it
//  a find. ⚠️ And the chimneys are drawn ABOVE the sea bed, into water — which works only because the water fill
//  in `fillColumn` writes into AIR ONLY (`v === M.air && hasBody && r < surfRow`). That is a real dependency on
//  another module's rule, so it is written down here rather than discovered later.
// ==============================================================================================================

// ⚠️ The chimney lattice is quantised so it tiles the period, like every other anchor lattice in this world.
const CHIM = nlat(11);

// ── PLACEMENT ─────────────────────────────────────────────────────────────────────────────────────────────────
function prepareVents(W, C, columnInfo) {
  const seed = W.o.seed, out = [];
  for (const F of (W.oceanFeatures || [])) {
    // ⭐ SEAMOUNTS HOST THEM TOO, and adding that is honest rather than a fudge: a large share of real
    // hydrothermal systems sit on seamounts and volcanic arcs, not only on spreading centres. It also fixes a
    // supply problem that could not be fixed at the vent end — ridges and trenches stay rare because their own
    // geology is rare (Earth has a handful of each), so a rule keyed only to them can never be common however
    // its dice are set. Seamounts are ~16 per world, so the host supply roughly quadruples.
    if (F.kind !== 'ridge' && F.kind !== 'trench' && F.kind !== 'seamount') continue;
    if (hh(seed, 7301, F.at, 0) > 0.45) continue;                 // a find, not scenery
    // on the AXIS — the rift for a ridge, the floor for a trench — jittered along it rather than placed dead
    // centre, so it is somewhere on the feature instead of at a coordinate a player could predict.
    const spread = (F.kind === 'ridge' ? Math.max(1, F.rift) : F.half * 0.5) * W.dx;
    void spread;
    const at = Math.round(F.at * W.dx + (hh(seed, 7303, F.at, 1) - 0.5) * 2 * spread);
    const ci = columnInfo(W, C, at);
    // ⚠️ Checked against the FINISHED ground, not against the record's intent: a ridge crest that ended up
    // shallow is not the deep sea and should not carry a vent field.
    if (!ci || ci.elev > -150) continue;
    out.push({
      at, kind: F.kind,
      half: 34 + Math.round(hh(seed, 7305, F.at, 2) * 78),
      salt: 7310 + ((F.at * 13) & 511),
      // how metal-rich this field is — a property of the FIELD, so one is worth more than another and it is
      // the same from every column that looks at it (mistake #3)
      grade: 0.35 + 0.6 * hh(seed, 7307, F.at, 3),
    });
  }
  return out;
}

// ⭐ THE COLUMN SHORTLIST, like every other `*Near` on this track. The bound is the cell test's own rejection.
const VENTS_EMPTY = [];
function ventsNear(list, c) {
  let out = null;
  for (const V of list) if (Math.abs(wdc(c - V.at)) <= V.half + 3) (out || (out = [])).push(V);
  return out || VENTS_EMPTY;
}

// ── THE CELL ANSWER. Returns a material, or -1. `sr` is this column's own sea bed. ────────────────────────────
function ventAt(list, M, c, r, sr, seed) {
  for (const V of list) {
    const u = wdc(c - V.at);
    if (Math.abs(u) > V.half) continue;
    const t = 1 - Math.abs(u) / (V.half + 1);                     // 1 at the middle of the field, 0 at its edge

    // ── THE CHIMNEYS, standing on the floor ──────────────────────────────────────────────────────────────────
    if (r < sr) {
      const k = Math.round(c / CHIM.s), kw = wrapL(k, CHIM.n), cx = latAt(CHIM, k);
      if (hh(seed, V.salt + 1, kw, 0) < 0.52) {
        const hw = hh(seed, V.salt + 2, kw, 1) < 0.55 ? 0 : 1;    // one to three cells across — they are SPIRES
        if (Math.abs(c - cx) <= hw) {
          // ⚠️ tapered by the field's own falloff, so the group has a profile instead of being a flat comb —
          // the same objection that made the dune sea a saw and the hoodoos a bed of nails.
          const hgt = Math.round((5 + 24 * hh(seed, V.salt + 3, kw, 2)) * (0.45 + 0.75 * t));
          if (r >= sr - hgt) {
            // the flange at the top is where the metal precipitates hardest
            const near = (sr - r) / Math.max(1, hgt);
            return hh(seed, V.salt + 4, c, r) < 0.20 + 0.35 * near * V.grade ? M.pyrite : M.basalt;
          }
        }
      }
      return -1;                                                  // open water between the chimneys
    }

    // ── THE SULPHIDE MOUND, under the floor. This is the deposit; the chimneys are the sign of it. ────────────
    const dd = r - sr;
    const deep = Math.round((30 + 90 * hh(seed, V.salt + 5, 1, 0)) * t);
    if (dd >= deep) continue;
    const f = fb2(seed, V.salt + 7, c * nd(15).q, r / 15, 2, nd(15).p);
    const gate = 0.52 - 0.20 * V.grade * (1 - dd / Math.max(1, deep));
    if (f > gate) {
      // ⚠️ the SUITE is fixed and its proportions are not a dial anyone tuned: this is the order these metals
      // actually drop out of a cooling vent fluid, commonest first. Gold is the rare one, as it should be.
      const q = hc(seed, V.salt + 9, c, r);
      if (q < 0.44) return M.pyrite;
      if (q < 0.70) return M.copper;
      if (q < 0.86) return M.sulphur;
      if (q < 0.96) return M.silver;
      return M.gold;
    }
    return M.basalt;                                              // the mound sits on fresh oceanic crust
  }
  return -1;
}

module.exports = { prepareVents, ventAt, ventsNear };
