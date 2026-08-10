'use strict';
// ==============================================================================================================
//  server/worldgen2.js — THE WORLD REDESIGN, ON THE SERVER. **INERT: nothing in index.js requires this file.**
//
//  Port increment 3 (plan: `replicated-enchanting-bumblebee.md` §5). This increment moves the **LAYOUT PASS**
//  across and nothing else: `buildWorld` + `prepare` run once, inside `makeGen2`, before any cell exists.
//  The cell-synthesis interface (`fillColumn`/`fillPage`/`pageEmpty`/`matAt`/`bandGroundAt`/`surfAt`) that
//  `index.js` actually calls is **increment 4** and is deliberately NOT exposed here yet.
//
//  ── WHY THERE IS A DIRECTORY BESIDE THIS FILE ────────────────────────────────────────────────────────────────
//  `worldgen2/` holds the spike's sixteen modules copied across **byte for byte**. Not one line was retyped.
//  The two mechanical-translation slips this track has actually suffered — a greedy `sed` that rewrote the
//  second call on a line and silently left the first, and a record `push` that landed in the neighbouring loop —
//  were both invisible to reading and were caught only by comparing a count against a second count. A verbatim
//  copy removes the whole class: `probe_worldgen2.js` Part A checks the sixteen checksums against
//  `scratchpad/worldspike/`, so "the server builds the world the spike was judged on" is proved rather than
//  argued. When the spike changes, re-copy and the checksums move together.
//  ⇒ **Do not hand-edit `worldgen2/*.js`.** Edit the spike, re-copy, re-run the probe.
//
//  ── SIBLING, NEVER A REFACTOR ────────────────────────────────────────────────────────────────────────────────
//  `worldgen.js` is untouched and still generates every world. This is the same precedent `worldgen.js` itself
//  set against `generateWorld`: a rollback path for the duration of a port, not something to keep. It gets
//  deleted once the new generator is proven in play.
// ==============================================================================================================

const { buildWorld } = require('./worldgen2/pipeline.js');
const { prepare, MATS, M } = require('./worldgen2/cells.js');
const { PERIOD_COLS } = require('./worldgen2/noise.js');

// ══ THE LAYOUT'S FIXED EXTENT ═════════════════════════════════════════════════════════════════════════════════
// ⭐ The layout covers **exactly one period** and never the room's `cols`. A narrower or wider room is a WINDOW
// on the same world, which is what buys `probe_worldgen` B4 ("widening the world does not move existing
// terrain") for free and what makes periodicity reachable at all. `n * dx` must BE `PERIOD_COLS`; asserted
// below rather than trusted, because the two numbers live in different files.
const LAYOUT_N = 8192;      // coarse samples across the world
const LAYOUT_DX = 64;       // real columns per sample
// ⚠️ `steps: 200`, not `buildWorld`'s own default of 400. 200 is what every previewer, `guard.js`, `probe_cost`,
// `probe_features`, `probe_periodic` and `probe_seafloor` use — i.e. it is the world the user has actually
// looked at and the world all 40 guard checks are baselined against. The 400 default is a leftover.
const LAYOUT_STEPS = 200;

// Sea level, in rows from the top of the world. `guard.js` and `deepland.js`'s band geometry are both written
// against this number; the Overworld is `OVERWORLD_DIMS`' 4,096 rows deep (index.js), so sea sits a little
// under halfway and the sky band is the 1,900 rows above it.
const SEA_ROW = 1900;

if (LAYOUT_N * LAYOUT_DX !== PERIOD_COLS) {
  throw new Error(`worldgen2: layout width ${LAYOUT_N * LAYOUT_DX} != PERIOD_COLS ${PERIOD_COLS} — the world `
    + `would not repeat at its own period, which is the one thing increment 2 bought.`);
}

// ══ THE ENVIRONMENT SWITCHES ══════════════════════════════════════════════════════════════════════════════════
// ⚠️ The spike modules read `process.env` at load time (ore mode/gain/size/pinch/early, cave-mouth mode, river
// water). Those are its mutation-test switches — `guard.js`'s built-in mutation test IS `RIVER_WATER=1`, and
// increment 5 needs `MOUTH=none` to make a check fail — so they are kept verbatim and must not be deleted.
// The hazard they carry on a SERVER is that a stray variable in the process environment silently changes what
// the world is, which no "same seed twice" check can see (both builds would be in the same process).
// ⇒ every switch is listed here with its shipping default and reported on the generator, so a probe can assert
// a default process is a default world. This reads the environment; it does not change anything.
const ENV_SWITCHES = [
  ['ORE', 'bodies'], ['ORE_GAIN', '1'], ['ORE_SIZE', 'big'], ['ORE_PINCH', '1'], ['ORE_EARLY', '1'],
  ['STAMP_N', '128'], ['MOUTH', 'clear'], ['RIVER_WATER', '0'], ['TRACE', ''],
];
function activeEnvSwitches() {
  const on = [];
  for (const [k, def] of ENV_SWITCHES) {
    const v = process.env[k];
    if (v === undefined || v === '') { if (def !== '' && v === '') on.push(`${k}=`); continue; }
    if (String(v) !== def) on.push(`${k}=${v}`);
  }
  return on;
}

// ==============================================================================================================
//  makeGen2(cfg) — the layout for one seed.
//
//  cfg: { seed, ...the rest of `makeGen`'s config }. **Only `seed` is read.** Geometry (`cols`/`rows`/`cell`/
//  `band`/`floorTop`) is deliberately ignored: the layout is always one full period, and a room is a window on
//  it. Increment 4 is where geometry starts to matter, because that is where cells get produced.
//
//  ⚠️ COST, and it is plan risk R3 — `buildWorld` ~570 ms + `prepare` ~2,016 ms + ~5.2 MB, per generator.
//  `_roomGens` in index.js builds one generator per room, inside a join. That is fine for ONE Overworld paid
//  once and is not fine per page room, which is why page rooms keep `worldgen.js`. `buildMs`/`prepareMs`/`ms`
//  are reported on the returned object so the number is measured on the real path rather than quoted from here.
// ==============================================================================================================
function makeGen2(cfg) {
  const seed = (cfg && cfg.seed) | 0;
  const t0 = Date.now();
  const W = buildWorld({ seed, n: LAYOUT_N, dx: LAYOUT_DX, steps: LAYOUT_STEPS });
  const t1 = Date.now();
  const C = prepare(W, SEA_ROW);
  const t2 = Date.now();
  return {
    seed, W, C,
    seaRow: SEA_ROW,
    periodCols: PERIOD_COLS,
    layout: { n: LAYOUT_N, dx: LAYOUT_DX, steps: LAYOUT_STEPS },
    env: activeEnvSwitches(),
    buildMs: t1 - t0, prepareMs: t2 - t1, ms: t2 - t0,
    // ⏭️ INCREMENT 4 adds the interface `index.js` calls — the same object shape `worldgen.js`'s `makeGen`
    // returns, so `genFor`/`genCfgFor` need no changes at all. Nothing is exposed until it is guarded.
  };
}

// ⭐ The record lists `prepare` places, named in one place so a probe does not have to hold its own copy of the
// list and go stale when a seventeenth kind of record is added. Order is `prepare`'s own placement order.
const RECORD_LISTS = ['volc', 'vents', 'voids', 'caves', 'sky', 'deep', 'forms', 'descents', 'rim', 'cliffs'];

module.exports = { makeGen2, PERIOD_COLS, SEA_ROW, LAYOUT_N, LAYOUT_DX, LAYOUT_STEPS, RECORD_LISTS,
  ENV_SWITCHES, activeEnvSwitches, MATS, M };
