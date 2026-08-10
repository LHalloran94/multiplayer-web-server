'use strict';
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// eleven others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');
// ==============================================================================================================
//  worldspike/formations.js — THE FOUR FAMILIES OF UNDERGROUND FORMATION.
//
//  All four are real, and each was chosen because it comes from something the generator ALREADY knows, so it is
//  placed by geology rather than by decree:
//
//    SPELEOTHEMS          dripstone, columns, flowstone and rimstone pools. 95% of them are calcite, so they
//                         belong wherever the rock is soluble and the void is dry — which is exactly the
//                         condition the water table already answers.
//    GIANT CRYSTAL        the Naica type: selenite beams metres long, formed where mineral-rich water sat still
//                         and hot for half a million years. So: near a magma body, below the water table, and
//                         rare. All three of those are already fields in this pipeline.
//    SULPHURIC-ACID CAVE  the Lechuguilla type, dissolved from BELOW by H2S rising off oil. ⭐ The generator
//                         already places oil traps under shale caps, so these sit above the oil BY CONSTRUCTION
//                         rather than because a rule says so — which is the whole argument for grounding this
//                         in real geology instead of inventing cave types.
//    TALUS                voids among fallen boulders at the foot of a cliff. The cliff records exist already.
//
//  ⭐⭐ THE SPELEOTHEMS ARE A POST-PASS OVER THE FINISHED COLUMN, and that is what makes them general. Rather
//  than teaching every void generator to hang its own dripstone — the karst systems, the underworld, the lava
//  tubes, the placed overhangs, the fracture swarms — the column is walked once at the end, every run of air is
//  found, and its ceiling and floor are decorated. One rule, and it covers voids that did not exist when it was
//  written. It is the same choke-point argument as the chill margin.
// ==============================================================================================================

// ==============================================================================================================
//  SPELEOTHEMS — the post-pass.
//  ⚠️ A DRIPSTONE IS A CONE, so its length has to vary SMOOTHLY along the column or it comes out as a row of
//  random spikes. Lengths come from lattice anchors with a tapering profile, which is the same shape rule the
//  hoodoos needed: the WIDTH of the thing is the lattice spacing, its STEEPNESS is the taper.
// ==============================================================================================================
function tipLen(seed, salt, c, step0, maxLen) {
  // ⚠️ the dripstone lattice is quantised so it tiles the period — see `nlat` in noise.js.
  const LT = nlat(step0), step = LT.s;
  const near = Math.round(c / step);
  let best = 0;
  for (let k = -1; k <= 1; k++) {
    const kw = wrapL(near + k, LT.n);
    const a = latAt(LT, near + k) + Math.round((hh(seed, salt, kw, 0) - 0.5) * step * 0.8);
    const len = maxLen * (0.25 + 0.75 * hh(seed, salt + 1, kw, 1));
    const hw = 1 + Math.round(len * (0.20 + 0.30 * hh(seed, salt + 2, kw, 2)));
    const dx = Math.abs(c - a);
    if (dx > hw) continue;
    const v = len * Math.pow(1 - dx / (hw + 0.5), 1.5);
    if (v > best) best = v;
  }
  return Math.round(best);
}

// Walks the finished column and decorates every run of air. `solid` and `liquid` tell it what it is looking at.
// Hang a vine from every lit ceiling in this column. `surfK` is the surface in local rows; a run of air ABOVE it
// is the sky, and the same "which side of the surface am I on" rule the speleothems needed applies here.
function vines(out, r0, rN, c, seed, M, surfK, isAir) {
  const LIT = 90;                                        // rows below the surface that still count as lit
  let k = 0;
  while (k < rN) {
    if (!isAir(k)) { k++; continue; }
    const a = k; while (k < rN && isAir(k)) k++;
    const b = k - 1;
    if (a <= surfK || a > surfK + LIT) continue;         // sky above, or too deep for anything to grow
    if (a === 0 || b - a + 1 < 3) continue;              // no ceiling, or no room to hang in
    if (n1(seed, 8700, c * nd(3.5).q, nd(3.5).p) < 0.62) continue;        // a curtain is patchy, not a fringe on every cell
    const len = 1 + Math.round(Math.min(b - a - 1, 10) * n1(seed, 8710, c * nd(6).q, nd(6).p));
    for (let i = 0; i < len; i++) out[a + i] = M.vine;
  }
}

// ⭐ ONE definition of how tall the lip is at a column, because `decorate` draws it and `prepareRimstone` has to
// add it to the floor profile it scans. Two copies of this would be two rules disagreeing about where the floor
// is, which is mistake #2 in the place it would do the most damage — the water level is read off this number.
function damHeight(seed, c) {
  const g = fb1(seed, 8300, c * nd(26).q, 2, nd(26).p);
  return g > 0.62 ? 1 + Math.round((g - 0.62) / 0.38 * 3) : 0;
}

// ==============================================================================================================
//  ⭐⭐ RIMSTONE POOLS — THE WATER BEHIND THE LIPS. A PLACED RECORD WITH ONE FILL.
//
//  The lips have been drawn since the speleothem pass was written and the pools behind them have always been
//  DRY, recorded as an open finding for two sessions. The reason was real: standing water needs a CONTAINED
//  LEVEL, and a level is one number shared by every column of the pool, which a column-local post-pass cannot
//  know. Filling it per column put water on a one-cell plug with open passage either side, and every cell of it
//  would have moved on the first tick — `probe_settled` is a hard requirement at 0.0019%.
//
//  ⭐ WHAT MAKES IT WORK: **the lip is the container, so the pool is built FROM the lip.** Walk to each lip,
//  then walk outward from it while the floor lies below its crest; the pool ends where the rising floor reaches
//  the crest, and that end column is the wall. Containment is a property of the floor profile, exactly as it is
//  for the crater lakes, the tarns, the underground basins and the underworld lakes.
//
//  🟥 TWO EARLIER SHAPES WERE BUILT AND MEASURED AND ARE WRONG — recorded so they are not tried again.
//   1. THE RISE-ONE-ROW SCAN, which every other standing water in this world uses, is the wrong rule HERE. It
//      finds the containing rim wherever it happens to be, and a lip is 1-4 cells tall against a storey whose
//      long profile undulates by tens of rows — so the rim it kept finding was the passage's own distant rise.
//      Pools came out up to 1,776 cells wide and the render was a thin blue ribbon down the whole frame: a
//      flooded floor, not a terrace. Only the PICTURE showed it; the counts looked reasonable.
//   2. A PREDICTED FLOOR (`levelRow + levelBore`) was chosen to avoid the cost of filling every storey, with a
//      note that the fill would protect us where prediction and reality differed. IT DID NOT — `probe_settled`
//      went 55 to 66 and every survivor was one class: a pool whose far end the prediction called closed while
//      the real passage carried on. Every void generator in this file can move that floor, and the speleothems
//      themselves raise it by up to fourteen cells. The profile is read from the CELLS now (~0.6s/world).
//
//  ⚠️ A TERRACE FIELD IS A PLACE, NOT A FLOOR COVERING. Capped per world, and only on dry soluble storeys, so
//  it stays something you find rather than something the world is paved with.
// ==============================================================================================================
function prepareRimstone(W, C, levelRow, levelBore, L, fillColumn) {
  const seed = W.o.seed, out = [];
  if (!C.caves || !C.caves.length) return out;
  const seaRow = C.seaRow;
  const wtAt = (c) => C.U.wt[((Math.round(c / W.dx) % W.n) + W.n) % W.n];

  // ⚠️ soluble is a property of the ROCK the system sits in, read once per record at its own midpoint — not a
  // per-cell lookup, and not `ci.lith` sampled per column, which is mistake #4.
  const cand = C.caves.filter(S => {
    const i = Math.max(0, Math.min(W.n - 1, Math.round(S.at / W.dx)));
    return (W.lith[i] === L.LIMESTONE || W.lith[i] === L.EVAPORITE) && S.b - S.a > 200;
  });
  // deterministic pick, so the same world always has the same terraces
  cand.sort((a, b) => hh(seed, 8600, a.a, 0) - hh(seed, 8600, b.a, 0));

  for (const S of cand.slice(0, 8)) {
    const span = Math.max(1, S.b - S.a);
    for (let k = 0; k < S.levels.length; k++) {
      // ── the storey must be DRY: rimstone is deposited by water evaporating in air, and a flooded gallery
      //    grows none. The water table already answers this, so nothing here has to know what water is.
      const eMid = seaRow - levelRow(S, k, S.at, seaRow, seed);
      if (eMid < wtAt(S.at)) continue;

      // ── 🟥🟥 THE FLOOR IS READ FROM THE CELLS, NOT PREDICTED, AND THE FIRST VERSION PREDICTED IT.
      //    I used `levelRow + levelBore` (where `caveAt` puts the floor) to avoid the cost of filling every
      //    storey, and wrote down that the fill would protect us where the two disagreed. IT DID NOT.
      //    `probe_settled` went 55 to 66 and the nine survivors were all one class: a pool whose far end the
      //    PREDICTED profile said was closed by rising ground, while the real passage carried on — so the water
      //    had open air beside it. Every void generator in this file can move that floor: a fracture cutting
      //    through, a chamber, a carve refusal, and the speleothems themselves, which are drawn per column and
      //    raise the floor by up to fourteen cells.
      //    ⇒ read the run. The lip is ALREADY IN the floor here, because `decorate` has run by the time these
      //    cells are produced — so the crest is simply the floor at the lip's column, and there is no second
      //    opinion about where anything is. Containment is now checked against the ground the player stands on.
      //    ⚠️ Costs ~0.6s per world inside `prepare()`, which every previewer and the guard pays. Bounded by the
      //    8-system cap above; measured rather than assumed.
      const prof = [];
      const win = new Uint8Array(96);
      for (let c = S.a + 6; c <= S.b - 6; c++) {
        const mid = Math.round(levelRow(S, k, c, seaRow, seed));
        const top = mid - 48;
        fillColumn(W, C, c, top, 96, win);
        const km = mid - top;
        if (win[km] !== 0) { prof.push(null); continue; }           // the storey is not open air here
        let a2 = km, b2 = km;
        while (a2 > 0 && win[a2 - 1] === 0) a2--;
        while (b2 < 95 && win[b2 + 1] === 0) b2++;
        if (a2 === 0 || b2 === 95) { prof.push(null); continue; }   // the run leaves the window: not a passage
        prof.push({ c, floor: top + b2 + 1, ceil: top + a2 - 1, dam: damHeight(seed, c) });
      }

      // ── 🟥 THE FIRST VERSION USED THE RISE-ONE-ROW SCAN AND IT WAS THE WRONG RULE HERE, which only the
      //    PICTURE showed: it produced pools up to 1,776 cells wide and the render was a thin blue ribbon
      //    running the entire frame — a flooded passage floor, not a terrace. The reason is structural, not a
      //    tuning miss. That scan finds the containing rim wherever it happens to be, and a lip is one to four
      //    cells tall against a storey whose long profile undulates by tens of rows, so the rim it kept finding
      //    was the passage's own distant rise and never the lip. A gour field is a STAIRCASE: each pool is
      //    held by its own dam and ends at the next one.
      // ⇒ the dam is the container, so the dam is what the pool is built FROM. Walk to each lip, then walk
      //    outward from it while the floor lies below its crest.
      for (let i = 1; i < prof.length - 1; i++) {
        const p = prof[i];
        if (!p || !p.dam) continue;
        if (prof[i - 1] && prof[i - 1].dam >= p.dam) continue;      // only the PEAK of a lip run owns a pool
        if (prof[i + 1] && prof[i + 1].dam > p.dam) continue;
        // ⭐ the lip is already part of the floor the cells contain, so its crest IS the floor at this column.
        // Nothing here recomputes the lip's height — that would be the second opinion all over again.
        const crest = p.floor - 1;
        for (const dir of [-1, 1]) {
          let q = i + dir, last = i, deepest = 0, ok = true, closed = false;
          while (q > 0 && q < prof.length) {
            const t = prof[q];
            if (!t) { ok = false; break; }                          // the passage pinches: not contained
            // ⭐ THE ONLY WAY A POOL IS CONTAINED: the ground at the water's own row is solid. `t.floor <= crest`
            // says the neighbour's first solid row is at or above the surface, so row `top` there is rock.
            // ⚠️ The old second clause re-derived the next lip from `damHeight` — but the lip is ALREADY IN
            // `t.floor` now that the profile is read from cells, so it was subtracting the lip twice. Removed;
            // a lip up the staircase simply raises `t.floor` and is caught by the line above.
            if (t.floor <= crest) { closed = true; break; }
            // 🟥 A PIT IS NOT A POOL. If the floor falls far below the crest the water would be metres deep and
            // is almost certainly a shaft or a chamber the prediction did not know about — refuse the whole
            // pool rather than let one column of it drain. (`fillRimstone` refuses per column as a backstop,
            // but a hole in the middle of a pool leaves water with air beside it, which is a wake.)
            deepest = Math.max(deepest, t.floor - crest);
            if (deepest > 9) { ok = false; break; }
            // and the roof has to be clear of the water, or it is a flooded section rather than a pool
            if (t.ceil >= crest - 1) { ok = false; break; }
            last = q; q += dir;
            if (Math.abs(last - i) > 90) { ok = false; break; }      // a terrace, not a lake
          }
          // 🟥 AND THE WALK COULD RUN OFF THE END OF THE PROFILE WITHOUT EVER FINDING A WALL. `while (q > 0 &&
          // q < prof.length)` exits silently at the storey's edge, and the pool was emitted anyway — open at
          // one end, which is water with nothing holding it. A loop that can leave by two doors has to record
          // WHICH door it left by; only one of them means "contained".
          const wide = Math.abs(prof[last].c - p.c);
          if (!ok || !closed || wide < 6 || deepest < 1) continue;
          // ⚠️ the span EXCLUDES the lip's own column — the lip is solid there, and the pool is what stands
          // behind it.
          const l = Math.min(p.c + dir, prof[last].c), r = Math.max(p.c + dir, prof[last].c);
          const top = crest + 1;
          // 🟥🟥 POOLS CANNOT SEE EACH OTHER, AND TWO ADJACENT ONES AT DIFFERENT LEVELS SPILL. Every profile
          // here is measured against a world with NO rimstone water in it — it has to be, because `C.rim` is
          // empty while `C.rim` is being built. So pool A's water is invisible to pool B's containment walk,
          // and where two lips sit close together the walk happily ended one pool against ground that the
          // other pool had already flooded. Measured: 40 of 4,162 pool cells would move, and the dump showed
          // water at rows 1914-1917 standing directly beside water at 1918-1919 with open air between them.
          // ⇒ refuse a pool that comes within a few columns of one already placed at a DIFFERENT level. They
          // are sparse — 17 to 27 in a world — so this costs almost nothing, and it removes the interaction
          // rather than trying to resolve it, which would need a second pass over records that do not exist yet.
          if (out.some(Q => Q.k === k && Q.sys === S && l <= Q.r + 4 && r >= Q.l - 4 && Q.top !== top)) continue;
          // 🟥 DO NOT TRIM THE FAR EDGE. I tried keeping a two-column margin off it, reasoning that the water
          // tapers to nothing there and the shallowest cells are the fragile ones. It took the leak from 3 cells
          // to 145 — because THE FAR EDGE IS THE WALL. The pool ends exactly where the rising floor reaches the
          // crest, so its last column is the one whose ground holds the water in; trimming it puts the water's
          // edge back in open passage. Measured within one run of writing it, and recorded so it is not tried
          // again.
          out.push({ l, r, top, damC: p.c, crest, sys: S, k });
        }
      }
    }
  }
  return out;
}

// The cell answer, applied as a post-pass over the finished column so it can see the REAL floor.
// ⚠️ WRITTEN FROM THE RUN'S ACTUAL FLOOR UPWARD, never from the level downward. That is the whole safety
// argument: however far the predicted floor was from the real one, there can never be air underneath the water.
function fillRimstone(rim, out, r0, rN, c, M, isLiq) {
  for (const P of rim) {
    // 🟥🟥 THE POOL DRAWS ITS OWN DAM, and getting this wrong is what the settled-water probe caught. The first
    // version relied on `decorate`'s column-local lip rule to be the container — and that rule has its own
    // conditions (`floorSolid && !wet && h > 8 && soluble`, offset by the stalagmite length) and is computed
    // against the ACTUAL floor while the pool's crest is predicted. Where the two disagreed the lip was simply
    // not there, and the water poured out sideways: `probe_settled` went 55 to 66, and ALL ELEVEN extra cells
    // were in one pool at one column — its dam column.
    // ⇒ mistake #2 in its purest form: two rules, one number. The container and the level it contains are one
    // fact, so one record owns both. Containment is now true BY CONSTRUCTION rather than by agreement.
    if (wdc(c - P.damC) === 0) continue;        // the lip is real ground already — nothing to add or remove
    const u = wdc(c - P.l);
    if (u < 0 || u > P.r - P.l) continue;
    const k0 = P.top - r0;
    if (k0 < 0 || k0 >= rN) continue;
    if (out[k0] !== M.air) continue;                    // the level is not in open air here — no pool
    // walk down to the floor of THIS run; refuse if the run is already wet (the water table got here first)
    let k = k0, bottom = -1;
    while (k + 1 < rN) {
      const v = out[k + 1];
      if (v === M.air) { k++; continue; }
      if (isLiq(v)) { bottom = -2; break; }             // standing on another body: leave it alone
      bottom = k; break;
    }
    if (bottom < 0) continue;                           // ran out of column, or met a liquid
    if (bottom - k0 > 12) continue;                     // a shaft, not a pool: the real floor is nowhere near
    for (let q = k0; q <= bottom; q++) out[q] = M.water;
  }
}

function decorate(out, r0, rN, c, seed, M, ctx) {
  // 🟥 A RUN OF AIR ABOVE THE GROUND IS THE SKY. Without this the post-pass grew stalagmites out of the open
  // ground wherever the rock was limestone, and put rimstone pools on the surface: the settled-water probe went
  // from 58 cells that would move to 2,666, of which 2,143 were ABOVE GROUND. A rule that walks "every void in
  // the column" has to be told which side of the surface it is on.
  const surfK = ctx.surfRow - r0;
  const isAir = (k) => out[k] === M.air;
  const isLiq = (k) => out[k] === M.water || out[k] === M.ice || out[k] === M.lava;
  const soluble = ctx.soluble, icy = ctx.icy;
  // ⭐⭐ VINES BELONG HERE AND NOT IN THE SPECIES TABLE, and working out why was the useful part. Every plant in
  // `flora.js` is anchored at the GROUND and grows up; a vine hangs DOWN from a ceiling, and the species
  // machinery has no notion of a ceiling. This post-pass does — it already walks every run of air, whoever
  // carved it, and decorates the top and bottom. Same choke-point argument as the speleothems it sits beside:
  // one rule covering cave systems, the underworld, lava tubes, placed overhangs and fracture swarms, including
  // voids written after it.
  // ⚠️ NEAR THE SURFACE ONLY. A vine needs light, so it hangs at a cave MOUTH and in the roof of an arch or an
  // undercut — not 3,000 rows down, where the same rule would have festooned the entire underworld.
  if (ctx.verdant) vines(out, r0, rN, c, seed, M, surfK, isAir);
  if (!soluble && !icy) return;
  const DRIP = soluble ? M.limestone : M.ice;
  let k = 0;
  while (k < rN) {
    if (!isAir(k)) { k++; continue; }
    let a = k; while (k < rN && isAir(k)) k++;
    const b = k - 1;                                     // the run is [a, b]
    const h = b - a + 1;
    if (h < 3 || a <= surfK) continue;                   // sky, not a cave
    const ceilSolid = a > 0 && !isAir(a - 1) && !isLiq(a - 1);
    const floorSolid = b < rN - 1 && !isAir(b + 1) && !isLiq(b + 1);
    // ⚠️ ONLY IN A DRY VOID. Dripstone is deposited by water evaporating in AIR; a flooded gallery grows none,
    // which the water table already decides for us — so the check is simply "is the cell under this run liquid".
    const wet = b < rN - 1 && isLiq(b + 1);
    if (!ceilSolid && !floorSolid) continue;
    const maxL = Math.min(Math.round(h * 0.45), 14);
    if (maxL < 1) continue;
    let up = 0, down = 0;
    if (ceilSolid) down = Math.min(maxL, tipLen(seed, 8100, c, 7, maxL));
    if (floorSolid && !wet) up = Math.min(maxL, tipLen(seed, 8200, c, 9, maxL));
    // ⭐ A COLUMN, where the two meet. Free, and it is the formation people picture when they picture a cave.
    if (down + up >= h - 1 && down > 0 && up > 0) { for (let i = a; i <= b; i++) out[i] = DRIP; continue; }
    for (let i = 0; i < down; i++) out[a + i] = DRIP;
    for (let i = 0; i < up; i++) out[b - i] = DRIP;
    // ⭐ RIMSTONE — terraced lips across a passage floor.
    // ⚠️ THE LIP IS STILL DRAWN HERE, per column, and that is correct: a lip is a property of a point on the
    // floor. What is NOT here any more is the water behind it, which is a property of the POOL — see
    // `prepareRimstone` below. A dam without a pool is a dry terrace, which is what this used to produce
    // everywhere; a pool without a contained level is water that moves on the first tick, which is what a
    // column-local rule would produce. The two answers live in the two different places.
    if (floorSolid && !wet && h > 8 && soluble) {
      const dam = damHeight(seed, c);
      for (let i = 0; i < dam; i++) if (b - up - i >= a) out[b - up - i] = M.limestone;
    }
  }
}

// ==============================================================================================================
//  THE PLACED CHAMBERS — crystal, sulphuric and talus. Records, so each has an extent and can be counted.
// ==============================================================================================================
function prepareFormations(W, C, columnInfo, L) {
  const seed = W.o.seed, out = [];
  const seaRow = C.seaRow;

  // ── GIANT CRYSTAL CHAMBERS. Near a magma body, below the water table, and rare — all three already known.
  // ⚠️ Offset well clear of the melt, or the chill margin (correctly) turns the whole chamber into basalt.
  for (const V of C.volc) {
    if (hh(seed, 8400, V.sample, 0) > 0.55) continue;
    const side = hh(seed, 8401, V.sample, 1) < 0.5 ? -1 : 1;
    const at = V.at + side * (760 + Math.round(hh(seed, 8402, V.sample, 2) * 420));
    const elev = -620 - Math.round(hh(seed, 8403, V.sample, 3) * 420);
    out.push({ kind: 'crystal', at, cy: seaRow - elev,
      hw: 40 + Math.round(hh(seed, 8404, V.sample, 4) * 70),
      hh: 22 + Math.round(hh(seed, 8405, V.sample, 5) * 34),
      salt: 8410 + (V.sample & 511) });
  }

  // ── SULPHURIC-ACID CAVES. ⭐ Sited on the oil rule's OWN geometry — shale, deep, in an anticline — so they sit
  // above the traps the generator already places instead of being scattered near them.
  for (let i = 40; i < W.n - 40; i += 23) {
    if (W.lith[i] !== L.SHALE || W.isSea[i]) continue;
    const c = i * W.dx;
    const arch = n1(seed, 711, c * nd(520).q, nd(520).p);   // the same field depositAt uses for the trap
    if (arch <= 0.72) continue;
    if (hh(seed, 8500, i, 0) > 0.30) continue;
    const bed = Math.round((0 + arch * 90) / 240) * 240 - arch * 90;
    void bed;
    const ci = columnInfo(W, C, c);
    const elev = seaRow - (ci.surfRow + 150 + Math.round(hh(seed, 8501, i, 1) * 190));
    out.push({ kind: 'sulphur', at: c, cy: seaRow - elev,
      hw: 50 + Math.round(hh(seed, 8502, i, 2) * 90),
      hh: 16 + Math.round(hh(seed, 8503, i, 3) * 26),
      salt: 8510 + (i & 511) });
  }

  // ── TALUS. Voids among fallen boulders at the foot of a cliff — and the cliff records already exist.
  // ⚠️ A TALUS IS A HEAP AGAINST A CLIFF, not an ellipse buried in rock. It sits ON the ground, its top slopes
  // away from the face at the angle of repose, and it is made of BOULDERS with gaps — the first version was a
  // smooth lens with diagonal stripes through it, which read as a humbug.
  for (const K of (C.cliffs || [])) {
    if (hh(seed, 8600, K.at, 0) > 0.6) continue;
    const foot = K.at + K.dir * (K.riser * 2 + 6);
    const hw = 30 + Math.round(hh(seed, 8601, K.at, 1) * 60);
    const high = 20 + Math.round(hh(seed, 8602, K.at, 2) * 34);
    const prof = [];
    for (let x = 0; x <= hw; x += 4) prof.push(columnInfo(W, C, foot + K.dir * x).surfRow);
    out.push({ kind: 'talus', at: foot, dir: K.dir, hw, high, prof, salt: 8610 + (K.at & 511) });
  }
  return out;
}

// The cell answer for a placed chamber. Returns a material, or -1.
function formationAt(F, M, c, r, seed) {
  for (const f of F) {
    if (f.kind === 'talus') {
      // a wedge standing on the ground, its top at the angle of repose
      const x = wdc(c - f.at) * f.dir;
      if (x < 0 || x > f.hw) continue;
      const g = f.prof[Math.min(f.prof.length - 1, Math.round(x / 4))];
      const top = Math.round(g - f.high * Math.pow(1 - x / f.hw, 1.25)
        - (fb1(seed, f.salt + 9, c * nd(17).q, 2, nd(17).p) - 0.5) * 8);
      if (r < top || r > g + 6) continue;
      // ⭐ BOULDERS, on a lattice coarse enough to BE boulders. `(c + r * 1.7)` is a linear combination, so it
      // draws diagonal BANDS — which is exactly what the picture showed. A 2-D field at a boulder's own scale
      // gives lumps with gaps between them, which is what a scree slope is.
      // ⭐ AND A TALUS IS MADE OF SCREE, which is what the word means. It emitted generic `stone` — so the one
      // place in the world that is literally a scree slope was built out of something else, while `scree` was
      // the single material in a 68-entry palette that no rule produced. The veneer on a cliff FACE is a
      // dusting (74% of steep columns get none, correctly — loose rock does not sit on a vertical face); the
      // real body of it has always been down here at the foot.
      const q = fb2(seed, f.salt + 7, c * nd(6.5).q, r / 6.5, 2, nd(6.5).p);
      return q > 0.47 ? M.scree : M.air;
    }
    const dx = wdc(c - f.at), dy = r - f.cy;
    if (Math.abs(dx) > f.hw * 1.5 || Math.abs(dy) > f.hh * 1.8) continue;
    const q = Math.sqrt(Math.pow(dx / f.hw, 2) + Math.pow(dy / f.hh, 2));
    // ⚠️ A ROUGHNESS OF ±0.2 ON AN ELLIPSE STILL READS AS AN ELLIPSE. Two scales, and enough amplitude that the
    // outline is genuinely irregular — the same objection that killed the lens-shaped sky islands, the analytic
    // crater rim and the tent-shaped sea cave, now for the third kind of shape.
    const rough = 0.72 + 0.62 * fb2(seed, f.salt, (c + f.cy) * nd(44).q, r / 30, 2, nd(44).p)
      + 0.20 * fb2(seed, f.salt + 1, c * nd(13).q, r / 11, 2, nd(13).p);
    if (q >= rough) continue;
    if (f.kind === 'crystal') {
      // ⭐ BEAMS AT THEIR OWN ANGLES. Three periodic families made a regular lattice — a decorated egg. Real
      // selenite is a handful of enormous prisms crossing at whatever angle they grew, so each one is its own
      // line segment with its own thickness and length.
      const n = 5 + Math.floor(hh(seed, f.salt + 2, 0, 0) * 6);
      for (let k = 0; k < n; k++) {
        const th = hh(seed, f.salt + 3, k, 0) * Math.PI;
        const ca2 = Math.cos(th), sa = Math.sin(th);
        const ox = (hh(seed, f.salt + 4, k, 1) - 0.5) * 1.6 * f.hw;
        const oy = (hh(seed, f.salt + 5, k, 2) - 0.5) * 1.6 * f.hh;
        const px = dx - ox, py = (dy - oy) * (f.hw / f.hh);       // work in a circular frame
        const along = px * ca2 + py * sa, across = -px * sa + py * ca2;
        const half = 1.4 + 2.6 * hh(seed, f.salt + 6, k, 3);
        const len = f.hw * (0.35 + 0.6 * hh(seed, f.salt + 7, k, 4));
        if (Math.abs(along) > len) continue;
        // a prism TAPERS to a point, which is what makes it a crystal and not a rod
        if (Math.abs(across) < half * (1 - Math.pow(Math.abs(along) / len, 2.4))) return M.crystal;
      }
      return M.air;
    }
    // ── sulphuric: dissolved from BELOW, so the floor is the ragged part and the walls carry gypsum crusts
    if (q > rough - 0.20 && dy > -f.hh * 0.2) return M.salt;
    if (fb2(seed, f.salt + 5, c * nd(9).q, r / 7, 3, nd(9).p) > 0.72) return M.salt;
    return M.air;
  }
  return -1;
}

module.exports = { prepareFormations, formationAt, decorate, prepareRimstone, fillRimstone, damHeight };
