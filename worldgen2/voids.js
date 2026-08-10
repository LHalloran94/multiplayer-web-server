'use strict';
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// eleven others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');
// ==============================================================================================================
//  worldspike/voids.js — OVERHANGS AS PLACED SUBTRACTIVE RECORDS.
//
//  A natural arch is rock over air over rock, which the surface rule cannot express: `columnInfo` gives each
//  column one `surfRow` and everything above it is sky. But `fillColumn` fills from `surfRow` DOWN and then
//  CARVES, and a carve that reaches the surface leaves exactly that. `probe_overhang.js` measured 1.67% of
//  columns in this world already carrying one — accidentally, wherever a cave grazes the ground. So the
//  representation was never the blocker; what was missing was a way to put one somewhere on purpose.
//
//  ⭐⭐ ALL FOUR THINGS WANTED ARE HOLES IN ROCK, NOT ROCK FLOATING IN AIR — an arch, a natural bridge, a sea
//  cave and an undercut cliff are each a void with rock above it. That is why the subtractive answer is not a
//  compromise: it is the shape of the problem. The one thing it cannot draw is a cantilever with nothing holding
//  it up in the picture, and nobody asked for one.
//
//  ⭐ AND THEY COLLAPSE TO **TWO** SHAPES, which is the return on writing them out rather than listing features:
//
//     ARCH   a hole punched through a fin, from the ground under it up to a roof. In a SIDE VIEW a natural
//            bridge is the same picture as an arch — rock spanning a gap on two legs — so it is the same record
//            sited differently: an arch stands alone, a bridge has low ground on both sides so the hole is a
//            through-route. One shape, two sitings, no second generator.
//
//     NOTCH  a void eating horizontally into a cliff FACE over a band of rows. A sea cave is a deep notch in a
//            narrow band at sea level; an undercut is a shallow notch in a taller band at a cliff's base. Again
//            one shape: the difference is two numbers, not two rules.
//
//  ⚠️ Every void here goes through `fillColumn`'s single carve gate, so the chill margin applies to it for free
//  and it floods from the water table like any other void. An arch is above the water table; a sea cave at sea
//  level is not, and near a coast the water table IS sea level — so a sea cave fills itself without being told.
// ==============================================================================================================

// ==============================================================================================================
//  PLACEMENT. Runs after the surface exists, because every one of these is sited on the FINISHED ground — the
//  height of a fin, the position of a cliff face — not on the coarse field. Same two-phase split as the volcano.
// ==============================================================================================================
function prepareVoids(W, C, columnInfo) {
  const seed = W.o.seed, out = [];
  const surf = (c) => columnInfo(W, C, c).surfRow;
  // ⭐ WHY DID NOTHING PLACE? The same answer this pipeline already learned for the feature contracts: a rule
  // that refuses everywhere fails SILENTLY and looks identical to a rule that was never called, so the
  // diagnosis has to be a per-CLAUSE tally rather than a total. Sea caves placed 0 in five worlds and this is
  // what found the clause.
  const why = out.why = {};
  const no = (k) => { why[k] = (why[k] || 0) + 1; };

  for (const f of W.features) {
    const c0 = f.a * W.dx, c1 = (f.b + 1) * W.dx;
    if (f.type === 'arch' || f.type === 'hoodoo') placeArches(f, c0, c1);
    else if (f.type === 'seacliff') placeNotches(f, c0, c1, 'seacave');
    else if (f.type === 'escarp' || f.type === 'canyon' || f.type === 'gorge') placeNotches(f, c0, c1, 'undercut');
  }

  // ── ARCHES ──────────────────────────────────────────────────────────────────────────────────────────────────
  // ⚠️ The fin is found by MEASURING the finished ground, not by re-deriving the feature's fine signature. Two
  // copies of a shape rule drift apart, and this track has already paid for that once this session (the tube
  // placement walk and the tube itself disagreeing about where the tube was).
  function placeArches(f, c0, c1) {
    // the pediment the fins stand on: the ground the feature would have without them
    const prof = [];
    for (let c = c0; c < c1; c++) prof.push(surf(c));
    const sorted = prof.slice().sort((a, b) => a - b);
    const base = sorted[Math.floor(sorted.length * 0.80)];         // the flat ground, not the spikes
    let last = -1e9;
    for (let i = 2; i < prof.length - 2; i++) {
      const c = c0 + i;
      if (c - last < 90) continue;                                 // rare and deliberate: never two in a row
      const height = base - prof[i];
      if (height < 34) { no('arch: fin too short'); continue; }
      if (prof[i] > prof[i - 1] || prof[i] > prof[i + 1]) continue; // must be the fin's own crest
      // how wide is this fin at half its height?
      let l = i, r = i;
      while (l > 0 && base - prof[l] > height * 0.4) l--;
      while (r < prof.length - 1 && base - prof[r] > height * 0.4) r++;
      const halfW = (r - l) / 2;
      if (halfW < 9 || halfW > 70) { no('arch: fin width ' + Math.round(halfW)); continue; }
      const salt = 2100 + ((c * 13) & 1023);
      const roof = 5 + Math.round(hh(seed, salt, 1, 0) * 11);
      // 🟥 CAP IT AGAINST THE FIN IT IS CUT FROM. Once the hoodoo signature was fixed the fins went from two
      // cells wide to sixty, `halfW` went with them, and an arch "span 100 rise 97 roof 16" hollowed a
      // 125-row butte out to a thin shell. An arch is a hole in a fin; past about half the fin it stops being
      // one and becomes a ruin. Legs at least 14 cells, and no more than half the height.
      const span = Math.min(Math.round(halfW * 0.60), Math.round(halfW) - 14);
      if (span < 8) { no('arch: legs too thin'); continue; }
      const rise = Math.min(Math.round(height * 0.5), height - roof - 6,
        Math.round(span * (0.9 + 0.7 * hh(seed, salt, 2, 0))));
      if (rise < 10) { no('arch: no room to rise'); continue; }
      // ⚠️ ARCH AND NATURAL BRIDGE ARE THE SAME RECORD AND, IN A SIDE VIEW, THE SAME PICTURE. I recorded a
      // `bridge` flag meaning "the ground beyond both legs is low" and it fired on 20 of 28, because the ground
      // beyond an arch's legs IS the pediment the arch stands on — the test was true by construction. A
      // distinction that cannot fail is not a distinction; dropped rather than tuned into looking useful.
      out.push({ kind: 'arch', at: c, span, floorRow: base, rise, roof, salt });
      last = c;
    }
  }

  // ── NOTCHES: sea caves and undercuts ────────────────────────────────────────────────────────────────────────
  // 🟥 THE FIRST VERSION ASKED ONLY "IS THERE GROUND AT THIS HEIGHT SOMEWHERE IN THE FEATURE", which on a gentle
  // slope is true at every height and hundreds of columns apart from one row to the next. The notch then smeared
  // sideways and came out as a 200-cell horizontal crack running across the picture — a hairline, not a hollow.
  // ⭐ A NOTCH NEEDS A FACE, so the placement now FINDS the cliff (the steepest stretch in the feature), hangs
  // the band on it, and REFUSES if the face wanders more than the notch is deep. Refusing is the right answer
  // here: an undercut with nothing to undercut is not a smaller undercut, it is a defect.
  function placeNotches(f, c0, c1, kind) {
    const salt = 2600 + ((Math.round((c0 + c1) / 2) * 7) & 1023);
    // ⚠️ NO DICE FOR SEA CAVES. There are only one to four sea cliffs in a world and the physical checks
    // already refuse most of them; a further 45% coin flip on top took the count to 2 across seven worlds, i.e.
    // most players would never meet one. Rarity that comes from the terrain is a fact about the world; rarity
    // stacked on top of it with a hash is just a lower number.
    if (kind !== 'seacave' && hh(seed, salt, 0, 0) > 0.55) { no(kind + ': dice'); return; }
    // ⚠️ WHERE THE CLIFF IS depends on which notch this is, and conflating the two placed no sea caves at all.
    // An undercut belongs at the steepest place in the feature; a SEA CAVE belongs at the WATERLINE, because
    // that is what cuts it. Asking for the steepest stretch to also happen to straddle sea level is a
    // conjunction, and this catalogue has been bitten by conjunctions before — the fjord and the delta each
    // placed nowhere for three runs for exactly this reason.
    let cliffC = -1, drop = 0;
    if (kind === 'seacave') {
      for (let c = c0 + 6; c < c1 - 6; c++) {
        if ((surf(c) - C.seaRow) * (surf(c + 1) - C.seaRow) > 0) continue;   // not the shoreline
        const d = surf(c + 6) - surf(c - 6);
        if (Math.abs(d) > Math.abs(drop)) { drop = d; cliffC = c; }
      }
    } else {
      for (let c = c0 + 6; c < c1 - 6; c += 2) {
        const d = surf(c + 6) - surf(c - 6);
        if (Math.abs(d) > Math.abs(drop)) { drop = d; cliffC = c; }
      }
    }
    if (cliffC < 0 || Math.abs(drop) < 12) { no(kind + `: no cliff (best drop ${Math.round(drop)})`); return; }
    const inward = drop > 0 ? -1 : 1;                              // the rock is on the higher side
    const deep = kind === 'seacave' ? 26 + Math.round(hh(seed, salt, 3, 0) * 54)
                                    : 8 + Math.round(hh(seed, salt, 3, 0) * 18);

    // ⚠️ THE FACE, ROW BY ROW, measured off the finished ground and searched only NEAR the cliff — and SMOOTHED,
    // because a per-row nearest-column lookup is the same "field read per sample" mistake one axis over:
    // unsmoothed it makes the notch a flight of one-cell steps instead of a hollow.
    const rA = kind === 'seacave' ? C.seaRow - 46 : surf(cliffC) - 90;
    const rB = kind === 'seacave' ? C.seaRow + 36 : surf(cliffC) + 90;
    const nR = rB - rA + 1;
    const face = new Int32Array(nR).fill(-1);
    const wLo = Math.max(c0 - 60, cliffC - 160), wHi = Math.min(c1 + 60, cliffC + 160);
    // 🟥 "THE COLUMN WHOSE SURFACE IS NEAREST THIS ROW" BREAKS ON EXACTLY THE CLIFFS THIS WANTS. Once the
    // riser existed and the face dropped twenty rows per cell, the surface SKIPS rows — no column has its
    // surface within six rows of most of the band — so every row came back invalid and the sea cave refused
    // with "face misses the waterline" against a face that was finally there. It is the steepness that broke
    // the reader, which is the second time this session a fix has moved the failure into its own measurement.
    // ⭐ The face is not the nearest surface, it is WHERE THE ROCK STARTS: scanning in from the open side, the
    // first column whose ground reaches this row. Exact at any steepness, and cheaper.
    for (let k = 0; k < nR; k++) {
      const r = rA + k;
      let found = -1;
      if (inward === 1) { for (let c = wLo; c < wHi; c++) if (surf(c) <= r) { found = c; break; } }
      else { for (let c = wHi - 1; c >= wLo; c--) if (surf(c) <= r) { found = c; break; } }
      face[k] = found;
    }
    const sm2 = Int32Array.from(face);
    for (let k = 0; k < nR; k++) {                                 // smooth over the VALID rows only
      if (face[k] < 0) continue;
      let a = 0, n = 0;
      for (let j = Math.max(0, k - 4); j <= Math.min(nR - 1, k + 4); j++) if (face[j] >= 0) { a += face[j]; n++; }
      sm2[k] = Math.round(a / n);
    }
    // 🟥 THE BAND WAS CHOSEN FIRST AND THE FACE MEASURED AFTERWARDS, so a 24-to-70-row band hung off a steep
    // stretch only twelve cells tall and ran out into gentle ground at both ends. It refused with "face wanders
    // 51" … "face wanders 144" — correctly, but for a reason that was mine rather than the world's.
    // ⭐ FIT THE BAND TO THE FACE INSTEAD: the longest run of rows over which the face leans away by less than
    // the notch is deep. That is exactly the condition for the roof to project over the floor, i.e. for the
    // thing to be an overhang at all — so the band comes from the definition rather than from a guess, and the
    // measured ceiling on it (this world's steepest ordinary ground is about 2.5 rows per cell) stops being a
    // silent refusal and becomes the size of the feature.
    const tol = Math.max(6, Math.round(deep * 0.8));
    let bI = 0, bJ = -1;
    for (let i = 0; i < nR; i++) {
      if (sm2[i] < 0) continue;
      let lo2 = sm2[i], hi2 = sm2[i], j = i;
      while (j + 1 < nR && sm2[j + 1] >= 0) {
        const v = sm2[j + 1];
        if (Math.max(hi2, v) - Math.min(lo2, v) > tol) break;
        lo2 = Math.min(lo2, v); hi2 = Math.max(hi2, v); j++;
      }
      if (j - i > bJ - bI) { bI = i; bJ = j; }
      i = j;
    }
    const minBand = kind === 'seacave' ? 10 : 14;
    if (bJ - bI + 1 < minBand) { no(kind + `: no face (best run ${bJ - bI + 1} rows)`); return; }
    // a sea cave is cut BY the sea, so its band has to contain the waterline …
    if (kind === 'seacave' && (rA + bI > C.seaRow - 4 || rA + bJ < C.seaRow + 2)) {
      no('seacave: face misses the waterline'); return;
    }
    // … and there has to BE sea on the open side. ⚠️ One came out as a sealed lens inside a hill: the coarse
    // field crossed sea level at that sample, but the finished ground with the riser and its noise did not, so
    // the "sea cave" was a pocket of air in dry rock with no water anywhere in the frame.
    if (kind === 'seacave') {
      const fc = sm2[(bI + bJ) >> 1];
      if (surf(fc - inward * 30) < C.seaRow + 3) { no('seacave: no sea on the open side'); return; }
    }
    const rTop = rA + bI, rBot = rA + bJ;
    const band = sm2.slice(bI, bJ + 1);
    let lo = 1e9, hi = -1e9;
    for (const v of band) { if (v < lo) lo = v; if (v > hi) hi = v; }
    out.push({ kind: 'notch', sub: kind, rTop, rBot, deep, inward, face: band, salt,
      lo: lo - deep - 4, hi: hi + deep + 4 });
  }

  return out;
}

// ==============================================================================================================
//  THE CELL TEST. Returns true if this cell should be carved out. Material is decided by the caller, which is
//  what lets a sea cave flood from the water table without this file knowing anything about water.
// ==============================================================================================================
function voidAt(Vs, c, r, surfRow, seed) {
  for (const V of Vs) {
    if (V.kind === 'arch') {
      const span = V.span * (1 + (fb1(seed, V.salt + 5, r / 26, 2) - 0.5) * 0.24);
      const dx = wdc(c - V.at);
      if (Math.abs(dx) >= span) continue;
      const q = 1 - (dx / span) * (dx / span);
      // the opening is an arc springing from the ground under the fin, roughened on its underside
      const open = V.floorRow - V.rise * Math.sqrt(Math.max(0, q)) * (0.82 + 0.36 * fb1(seed, V.salt + 6, c * nd(19).q, 3, nd(19).p));
      const top = Math.max(surfRow + V.roof, open);
      const floor = V.floorRow + (fb1(seed, V.salt + 7, c * nd(40).q, 2, nd(40).p) - 0.5) * 5;
      if (r >= top && r < floor) return true;
    } else {
      if (r < V.rTop || r > V.rBot) continue;
      const uo = wdc(c - V.lo);
      if (uo < 0 || uo > V.hi - V.lo) continue;
      const k = r - V.rTop, nR = V.rBot - V.rTop;
      const d = (V.lo + uo - V.face[k]) * V.inward;
      if (d < 0) continue;                                         // that is the open side, already air
      // deepest in the middle of the band, closing to nothing at top and bottom — a wave-cut hollow, not a slot.
      // ⚠️ A TENT PROFILE DRAWS A TRIANGLE, and the picture showed exactly a triangle: two straight edges
      // meeting at a point, which reads as maths at any size. An ellipse has no straight edge anywhere.
      const t = 1 - Math.pow(k / nR * 2 - 1, 2);
      const dep = V.deep * Math.sqrt(cl(t, 0, 1)) * (0.7 + 0.6 * fb1(seed, V.salt + 8, r / 15, 2));
      if (d < dep) return true;
    }
  }
  return false;
}

// ⭐ THE COLUMN SHORTLIST — see the long note in descents.js.
// ⚠️ CONSERVATIVE, per kind, because the two kinds reject on completely different things:
//   arch   `|c - V.at| >= span`, and `span = V.span * (1 + (fb1 - 0.5) * 0.24)` with fb1 in 0..1, so the widest
//          it can ever be is `V.span * 1.12`. Using `V.span` itself would be a NARROWER bound than the test —
//          which is the one direction that is not allowed, and would delete the outer 12% of every arch.
//   notch  `c < V.lo || c > V.hi`, which is already exact.
function voidsNear(Vs, c) {
  let out = null;
  for (const V of Vs) {
    const uo = wdc(c - V.lo);
    const hit = V.kind === 'arch' ? Math.abs(wdc(c - V.at)) < V.span * 1.12 + 2 : (uo >= -1 && uo <= V.hi - V.lo + 1);
    if (hit) (out || (out = [])).push(V);
  }
  return out || VOIDS_EMPTY;
}
const VOIDS_EMPTY = [];

module.exports = { prepareVoids, voidAt, voidsNear };
