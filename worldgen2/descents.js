'use strict';
// ==============================================================================================================
//  worldspike/descents.js — THE WAY DOWN.
//
//  The world has three bands and, until now, no route between them. Every band solved reachability WITHIN
//  itself — the volcano tubes got skylights, the karst systems got an entrance shaft, the underworld got
//  provinces — and every one of them was measured and fixed. But the underworld's reach FROM THE SURFACE was
//  never anything but zero, because nothing joined them.
//
//  ⭐⭐ THE USER'S IDEA IS THE CHEAP ONE AND THE GOOD ONE: rather than scattering new entrances, take the holes
//  the surface ALREADY has — a sea cave, an undercut, a cave system's mouth — and let some of them keep going
//  down. A route that starts somewhere you can already see is a route you can find; a shaft in the middle of a
//  field is one you fall into. It also costs nothing to place, because the mouths are already records.
//
//  ⚠️ A DESCENT IS PARAMETERISED BY ROW, not by column. It is mostly vertical, so as a function of the column it
//  would be multivalued — and every wandering-passage bug on this track came from a shape whose parameter was
//  the wrong axis. By row it is single-valued by construction and cannot pinch shut.
//
//  ⚠️ And it goes through `fillColumn`'s carve gate like every other void, so the chill margin still applies: a
//  descent that runs at a magma body stops at a wall rather than opening the volcano into the cave system.
// ==============================================================================================================
const { levelRow } = require('./caves.js');
const { bandAt, rowOf } = require('./deepland.js');
// the chill margin itself — the predicate cells.js consults at its one void gate. See the note in place().
const { voidMaterial } = require('./under.js');
// what a player cannot pass through. ⚠️ DERIVED from the behaviour table, never listed — a hard-coded
// material list is a guard that stops guarding in silence, and this track has been caught holding two.
const { TABLE: MTABLE } = require('./materials.js');
// ⚠️ THE VOLCANO MODULE'S OWN ANSWER to "is this column inside a volcano", never a second copy of the
// expression — two rules disagreeing about what a number means is mistake #2 and it has cost this track eight
// instances. If the edifice's reach is ever retuned, this refusal follows it for free.
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// twelve others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');

const REACH = 5200;                        // how far sideways a descent will look for something to join

// ==============================================================================================================
//  PLACEMENT
// ==============================================================================================================
function prepareDescents(W, C, columnInfo, M) {
  const seed = W.o.seed, out = [];
  const seaRow = C.seaRow;
  // What a player cannot pass through, DERIVED from the behaviour table rather than listed. Two probes on this
  // track were caught holding hard-coded `water||ice||lava` lists that went on passing while eight new liquids
  // were added underneath them; a list here would rot exactly the same way.
  const BLOCKING = new Set();
  if (M) for (const k in M) { const t = MTABLE[k]; if (t && t.b === 'hazard') BLOCKING.add(M[k]); }

  // every mouth the surface already has, with the row it starts from
  const mouths = [];
  for (const V of C.voids) {
    if (V.kind !== 'notch') continue;
    const mid = (V.rTop + V.rBot) >> 1;
    mouths.push({ c: V.face[(V.face.length >> 1)] + V.inward * Math.round(V.deep * 0.6), r: mid, from: V.sub,
      entryC: V.face[(V.face.length >> 1)] });
  }
  // ⚠️ A CAVE SYSTEM'S MOUTH IS NOT WHERE ITS DESCENT STARTS — its LOWEST STOREY IS. Starting at the entrance
  // shaft, the route found that same system's bottom gallery two hundred rows down and stopped: ten descents
  // in a world, every one of them joining a cave to itself. "An existing cave extends downward" means it
  // carries on from where the cave already ends.
  for (const S of C.caves) {
    if (!S.entrance) continue;
    const mid = Math.round((S.a + S.b) / 2);
    // ⚠️ where this route MEETS THE SURFACE is the system's entrance shaft, not the storey the descent starts
    // from. Recorded because a diagnostic that frames on the descent alone cannot see the way in — which is
    // exactly what happened: two of three worlds measured 0% reachable through routes that were open.
    mouths.push({ c: mid, r: Math.round(levelRow(S, S.levels.length - 1, mid, seaRow, seed)), from: 'cave', sys: S,
      entryC: Math.round(S.a + S.entrance.x * (S.b - S.a)), srcA: S.a, srcB: S.b });
  }

  // ⭐ per-CLAUSE refusals, because a route that never places fails silently and looks exactly like a rule that
  // was never called — the answer this pipeline has needed five times now.
  const why = out.why = {};
  const no = (k) => { why[k] = (why[k] || 0) + 1; };
  // ⭐ AT LEAST ONE PER WORLD, decided here where it can be checked. Seed 99 rolled its dice ten times and lost
  // ten times (p = 0.03%, so it is luck rather than a bug — which is exactly why a guarantee and not a looser
  // threshold: a tuned probability still fails sometimes, and a world with no route into its underworld is a
  // world with a whole band nobody can reach). Same shape as the volcano entrance guarantee.
  const place = (m, forced) => {
    const salt = 9700 + ((m.c * 13) & 2047);
    if (!forced && hh(seed, salt, 0, 0) > 0.55) { no('dice'); return false; }   // not every mouth goes anywhere

    // ── what is there to join? ⭐ THE UNDERWORLD FIRST. The point of a descent is to go DOWN; a cave system
    // already has its own entrance shaft, so joining one adds a second door to a room that had one. A cave is
    // the fallback for a mouth with no open band under it.
    let target = null;
    for (let dx = 0; dx <= REACH && !target; dx += 120) {
      for (const s of [-1, 1]) {
        const cc = m.c + s * dx;
        const b = bandAt(C.deep, cc);
        if (!b.open) continue;
        const rr = rowOf(seaRow, b.ceilE) + 8;
        if (rr <= m.r + 200) continue;
        target = { c: cc, r: rr, what: 'underworld' };
        break;
      }
    }
    if (!target) {
      let best = 1e9;
      for (const S of C.caves) {
        if (S === m.sys) continue;                             // not back into the cave it came from
        const at = cl(m.c, S.a + 30, S.b - 30);
        if (Math.abs(at - m.c) > REACH) continue;
        const rr = Math.round(levelRow(S, S.levels.length - 1, at, seaRow, seed));
        if (rr <= m.r + 120) continue;
        const d = Math.abs(at - m.c) + (rr - m.r) * 0.25;
        if (d < best) { best = d; target = { c: at, r: rr, what: 'cave' }; }
      }
    }
    if (!target) { no('nothing below within reach'); return false; }

    // 🟥🟥 A DESCENT THAT RUNS INTO A VOLCANO IS CARVED AND THEN SEALED, AND NOTHING NOTICED. Measured on seed
    // 555: descent #0 left an undercut at column 337,150 and its route passed a volcano at 336,320 — 830
    // columns away. The probe read the shaft as **423 passable rows of 1,286**, blocked from row 2,371, and
    // sampling the column found 1,030 cells of BASALT with lavathick and slurry in it.
    // ⭐ THE CHILL MARGIN WAS RIGHT AND THE PLACEMENT WAS WRONG. "No void within 8 cells of lava" is the rule
    // that stops a passage opening into a conduit and draining it, so the cell pass correctly refused to carve
    // — but the descent had already been placed, counted, and reported as a route. A blocked route also
    // satisfies the "at least one per world" GUARANTEE vacuously, which is the same shape as every other
    // vacuous-pass on this track.
    // ⇒ it must be refused at placement, where it can be counted, instead of failing silently in the cells.
    //
    // 🟥 BUT NOT LIKE THIS, AND THE ATTEMPT IS KEPT AS A COMMENT BECAUSE THE REASON IS THE USEFUL PART.
    // I refused any route passing near `volcanoNear(C.volc, cc)` — the volcano module's own reach, reused
    // rather than re-derived, which was the right instinct. It fired **zero times** and changed nothing.
    // Measured: that volcano's `craterR` is 75, so `volcanoNear` reaches `75 * 1.85 + 8` = **147 columns**,
    // while the descent sits **830 columns** away and is still full of basalt, lavathick and slurry.
    // ⇒ `volcanoNear` answers "is this column in the CRATER". The question that matters here is "is there
    // MOLTEN ROCK at this column, at this depth" — a lava body reaching far outside the edifice — and no
    // existing function answers it. Reusing the wrong existing answer is its own version of mistake #2.
    // ⏭️ THE RIGHT FIX, NOT YET BUILT: ask the cell pass. `prepareRimstone` already reads cells during
    // placement and the port plan confirms that is legal (a fixed, bounded probe pattern, resolved by
    // ordering), so probing a handful of cells along the proposed route and refusing a blocked one cannot
    // disagree with the chill margin — it IS the chill margin. Costs roughly what prepareRimstone costs.
    // ⚠️ AND THIS IS A PRE-EXISTING GAP THE NEW WORLD EXPOSED, not something the ring broke: descent placement
    // has never had a rule against routing through a volcanic body. The old world simply never happened to.

    // 🟥🟥 A DESCENT MUST REACH THE SKY, AND FOR NOTCH MOUTHS IT DID NOT. Measured on the ringed world: the
    // mouth of descent #0 in seed 1234 sat at row 1543 while that column's ground was at 1512 — 31 rows
    // UNDERGROUND, in a 25-row air pocket with a 6-row rock roof over it. `descentAt` carves from `r0 - 2`, so
    // the shaft was 1,667 of 1,666 rows passable and **0 reachable**: carved perfectly, connected to nothing.
    // That is the third time this track has produced that exact signature, and the third different cause
    // (band inversion · a plant sealing the mouth · and now a buried notch).
    // ⚠️ THE MOUTH IS A NOTCH'S MIDDLE, WHICH IS INSIDE THE CLIFF BY CONSTRUCTION — `m.c` is 60% of the way in
    // from the face — so whether it opens to the outside is a property of the surface, and the surface just
    // moved everywhere. Rather than tune the notch geometry back, the route now GUARANTEES its own way in: it
    // carves from this column's own ground down to the mouth. That is the choke-point answer this design keeps
    // arriving at — one rule covering every descent source, including sources that do not exist yet.
    // ⚠️ Recorded ON THE RECORD, not read per column, because a thing must be the same from every column that
    // looks at it (mistake #3). `descentCol` tapers its wander to zero at t=0, so the entry shaft is a straight
    // bore pinned exactly where it meets the ground — the fix the volcano limbs and the switchback both needed.
    const sky = columnInfo(W, C, m.c);
    const rSky = sky ? sky.surfRow : m.r;

    const D = {
      c0: m.c, r0: m.r, c1: target.c, r1: target.r, what: target.what, from: m.from, entryC: m.entryC, srcA: m.srcA, srcB: m.srcB,
      // the row the passage OPENS at: its own mouth, or this column's ground if the mouth is buried under it
      rTop: Math.min(m.r, rSky), rSky,
      bore: 4 + Math.round(hh(seed, salt, 1, 0) * 5),
      // ⭐ a SWITCHBACK, so it is a descending passage rather than a mineshaft. A vertical pipe is not somewhere
      // you climb down, and it is the same objection that made the karst shafts drift with depth.
      zig: 70 + Math.round(hh(seed, salt, 2, 0) * 190),
      salt,
    };

    // ⭐⭐ WOULD THIS ROUTE ACTUALLY BE CARVED? ASK THE RULE THAT DECIDES, NOT A MODEL OF IT.
    // `sealed()` is the chill margin — the predicate `cells.js` uses at the one gate where a void is placed
    // (`if (sealed(...)) carve = M.basalt`). Calling it here cannot disagree with the cell pass, because it IS
    // the cell pass's own function. That is the whole argument for doing it this way.
    // 🟥 The alternative I tried first — refusing anything near `volcanoNear` — fired ZERO times: that answers
    // "is this column in the CRATER" (reach `craterR * 1.85 + 8` = 147 columns here) while the lava body that
    // actually blocked seed 555's route sat **830 columns** out. Reusing an existing answer to the WRONG
    // question is its own version of two rules disagreeing about what a number means.
    // ⚠️ WALKED ALONG `descentCol`, THE REAL CENTRE LINE, and not along a straight interpolation. There is one
    // function that says where the tube is, deliberately — three copies of that expression cost this track two
    // wrong conclusions in a single run — so the probe walks the same one the cell test will.
    // ⚠️ Reading cells (or the rules over them) DURING placement is legal and precedented: `prepareRimstone`
    // already does it, and the port plan confirms why — a FIXED, BOUNDED probe pattern defined by the record
    // alone is deterministic, unlike a flood fill whose extent varies.
    // ⚠️ Conservative in the direction that matters: refusing a route that would have been fine costs one
    // descent, and this world has tens. Letting a blocked one through is a route to nowhere that still
    // satisfies the "at least one per world" guarantee VACUOUSLY — which is exactly how this got here.
    // 🟥 AND `sealed` ALONE IS NOT THE GATE EITHER — that was the second wrong answer, and it also fired zero
    // times. Reading the gate in `cells.js` rather than guessing at it: `volcanoAt` runs FIRST, and a solid
    // return sets `carve = -1`, cancelling the descent's void outright before `sealed` is ever consulted. So
    // the thing that actually blocked seed 555 was the volcano's EDIFICE, not its chill margin. Both are asked
    // here, in the same order and with the same functions the cell pass uses.
    // 🟥🟥 AND IT WAS NEITHER OF THOSE. THE THIRD MEASUREMENT IS THE ONE THAT COUNTS: walked along the REAL
    // centre line, seed 555's route is **846 cells of lava**, 364 of slurry, 67 of hot spring and 18 of acid.
    // The passage is not blocked — it is CARVED, and then FLOODED. It runs below the water table through a hot
    // region, so `voidMaterial` fills its void with molten rock, and you cannot swim through that.
    // ⚠️ MY FIRST TALLY SAID "basalt 1,030" AND SENT ME AFTER THE VOLCANO FOR TWO WRONG FIXES. It sampled the
    // fixed column `c0` while the shaft WANDERS up to ~128 columns (`zig`), so it measured the rock BESIDE the
    // passage rather than the passage. Same instrument bug as the diagnostic that once read "granite 180" down
    // a working lava tube by sampling its unwandered centre line.
    // ⇒ ask `voidMaterial`, which is the function that decides what fills a void, at the cells the route
    // actually occupies. Same argument as before: it cannot disagree with the cell pass because it IS the cell
    // pass's own function — the two earlier candidates (`volcanoNear`, then `volcanoAt`+`sealed`) each fired
    // ZERO times, which is what a wrong predicate looks like when you bother to count.
    if (M && C.U) {
      for (let r = D.rTop; r <= D.r1; r += 8) {
        const cc = Math.round(descentCol(D, r, seed));
        const cinf = columnInfo(W, C, cc);
        if (!cinf) continue;
        if (BLOCKING.has(voidMaterial(C.U, M, cinf, r, seaRow))) { no('flooded with molten rock'); return false; }
        // 🟥🟥 AND THE SAME CLASS OF DEFECT A SECOND TIME, from the OTHER end of the world: the OCEANIC CRUST.
        // The aquiclude under the deep sea cancels any carve inside it, which is precisely its job — but a
        // descent routed under a coast crosses it and comes out perfectly carved and bricked solid. Measured:
        // `guard.js` went from 87.1% reach / 0 dead routes to 75.7% / 1 dead the moment the crust landed, and
        // 🟥 I ATTRIBUTED IT TO THE MAGMA CHAMBER because that was the change I had just made and the guard was
        // the first thing I ran after it. Re-running the guard on the PREVIOUS COMMIT showed the identical
        // failure — the crust had gone in one step earlier and I had checked it with `probe_seafloor` alone.
        // ⚠️ Same answer as the molten-rock case above and for the same reason: refuse at PLACEMENT, asking the
        // very numbers the cell pass uses (`crustD`/`crustT` off the column reader), so the two cannot disagree.
        if (cinf.crustD >= 0) {
          const dd = r - cinf.surfRow;
          if (dd >= cinf.crustD && dd < cinf.crustD + cinf.crustT) { no('through the oceanic crust'); return false; }
        }
      }
    }

    out.push(D);
    return true;
  };
  for (const m of mouths) place(m, false);
  if (!out.some(d => d.what === 'underworld')) {
    for (const m of mouths) if (place(m, true)) break;
  }
  return out;
}

// The passage's centre column at this row. ⭐ ONE function, used by the cell test and the diagnostic — three
// copies of "where is the tube" cost this track two wrong conclusions in a single run.
function descentCol(D, r, seed) {
  const t = cl((r - D.r0) / Math.max(1, D.r1 - D.r0), 0, 1);
  // 🟥 THE WANDER MUST FADE TO NOTHING AT BOTH ENDS. At full amplitude the switchback is ±145 cells, so the top
  // of the descent started up to 145 columns away from the cave storey it was supposed to leave — in solid
  // rock — and the bottom missed the band's ceiling the same way. Two of three worlds measured 0% reachable
  // through routes that were, on paper, placed correctly. This is the volcano limbs' junction bug exactly: a
  // passage that must MEET something has to be pinned where it meets it.
  const taper = Math.min(1, t / 0.10) * Math.min(1, (1 - t) / 0.10);
  return lp(D.c0, D.c1, sm(t))
    + ((fb1(seed, D.salt + 5, r / 150, 2) - 0.5) * D.zig
     + (fb1(seed, D.salt + 7, r / 38, 2) - 0.5) * D.zig * 0.22) * taper;
}

function descentAt(DS, c, r, seed) {
  for (const D of DS) {
    // ⚠️ `rTop`, not `r0` — see the note at the placement. A mouth buried under its own hillside gets an entry
    // shaft up to the surface, or the passage below it is unreachable and the whole route is decoration.
    if (r < (D.rTop !== undefined ? D.rTop : D.r0) - 2 || r > D.r1 + 6) continue;
    const cx = descentCol(D, r, seed);
    if (Math.abs(wdc(c - cx)) < D.bore * (0.72 + 0.56 * n1(seed, D.salt + 9, r / 44))) return true;
  }
  return false;
}

// ⭐⭐ THE COLUMN SHORTLIST — which descents can possibly reach column `c`, asked ONCE PER COLUMN.
// `descentAt` rejects on the ROW and never on the column, so the full list was walked for every cell in the
// world: measured at 3.4-3.7 ms of a 16-18 ms chunk for SEVEN records, and 10.4% of the whole profile, because
// each survivor costs `descentCol` (two fBm stacks) plus another noise read. This is the per-column resolution
// `server/worldgen.js`'s `colInfo` already does for isles/halls/pools, and is why that generator is 1.8 ms.
//
// ⚠️⚠️ THE BOUND IS CONSERVATIVE AND MUST STAY THAT WAY, and that is the whole correctness argument: it is
// allowed to admit a descent that cannot reach `c`, because `descentAt` still applies its exact test to
// everything the shortlist hands it. It is NOT allowed to reject one that can. So every term is taken at its
// extreme, not at its typical value.
//   descentCol  = lp(c0, c1, ...) ± (zig*0.5 + zig*0.22*0.5) * taper,  taper <= 1,  fb1 in 0..1
//   the test's own half-width = bore * (0.72 + 0.56 * n1),  n1 in 0..1  =>  at most bore * 1.28
// ⚠️ It lives HERE, beside the test it has to agree with. A bound in cells.js and a test in descents.js is two
// rules and one number — mistake #2, eight instances on this track.
const descentReach = (D) => D.zig * 0.61 + D.bore * 1.28 + 2;      // +2 for rounding, free
function descentsNear(DS, c) {
  let out = null;
  for (const D of DS) {
    const lo = Math.min(D.c0, D.c1) - descentReach(D), hi = Math.max(D.c0, D.c1) + descentReach(D);
    const u = wdc(c - lo);
    if (u >= 0 && u <= hi - lo) (out || (out = [])).push(D);
  }
  return out || EMPTY;
}
const EMPTY = [];

module.exports = { prepareDescents, descentAt, descentCol, descentsNear };
