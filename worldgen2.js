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

const { buildWorld, BIOME } = require('./worldgen2/pipeline.js');
const { prepare, fillColumn: spikeFillColumn, columnInfo, MATS, M } = require('./worldgen2/cells.js');
const { PERIOD_COLS } = require('./worldgen2/noise.js');
// ⚠️ READ-ONLY, like every other require of that directory: `worldgen2/*.js` are byte-for-byte spike copies and
// are checksummed. `skyTop`/`skyBot` are pure functions of (record, column) and are exported for exactly this.
const { skyTop, skyBot } = require('./worldgen2/sky.js');
const MG = require('./materials.js');

const CHUNK_SIDE = 64;                                  // must match worldgen.js / chunkGeom

// ══ SPIKE MATERIAL ID → GAME MATERIAL ID ══════════════════════════════════════════════════════════════════════
// ⭐ THE PORT'S ONE TRANSLATION, BUILT ONCE. The generator's modules speak in indices into `cells.js`'s `MATS`
// palette; the game speaks in the ids `materials.js` allocated. `MG.idOf` THROWS on an unknown name, and that
// is the point — the alternative is `undefined`, which stores into a `Uint8Array` as **0 = AIR**, the way
// `MAT.OIL`/`GLASS`/`ACID` twice vanished from the shipped generator and the way `ooze` would have left a hole
// in the sea floor. Building the table eagerly means an unmapped material is a loud failure at STARTUP rather
// than a quiet hole discovered in play.
// ⚠️ `MATS[0]` is air and is 0 on both sides — the single exemption, and `probe_worldgen2` M1b pins it.
const XLAT = new Uint8Array(256);
{
  const bad = [];
  MATS.forEach(([k], i) => {
    if (i === 0) return;                                 // air
    const v = MG.NAME_TO_ID[k];
    if (v === undefined) bad.push(`${i}:${k}`); else XLAT[i] = v;
  });
  if (bad.length) throw new Error('worldgen2: spike materials with no game id: ' + bad.join(', ')
    + ' — add a row to server/materials.js; an unmapped id stores as 0 = AIR.');
}
// Hits to break, by GAME id. The generated rows carry their own; the dozen built-ins the spike aliases onto
// keep the values `index.js`'s BUILTIN_STRENGTH already uses (mirrored by worldgen.js's DEF_STRENGTH).
const BUILTIN_STRENGTH = { 2: 3, 4: 2, 5: 2, 17: 2 };
const STRENGTH = new Uint8Array(256).fill(1);
STRENGTH[0] = 0;
for (const k of Object.keys(BUILTIN_STRENGTH)) STRENGTH[k] = BUILTIN_STRENGTH[k];
for (const k of Object.keys(MG.STRENGTH)) STRENGTH[k] = MG.STRENGTH[k];
// Which GAME ids flow. `bandGroundAt` has to know, because liquid is neither a floor nor headroom.
// ⚠️ DERIVED FROM THE BEHAVIOUR TABLE, NEVER LISTED — `guard.js`'s standing rule, which has already caught two
// probes holding `air || water` while eight new liquids went by.
const IS_FLUID = new Uint8Array(256);
for (const [id, def] of Object.entries(MG.DEFS)) if (def.behavior === 'fluid' || def.behavior === 'hazard') IS_FLUID[id] = 1;
for (const id of [9, 10, 11, 12, 14, 15]) IS_FLUID[id] = 1;   // the six built-in fluids (index.js TERRAIN_MATS_FLUID)

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
// The world's depth, and the room shape the Overworld uses. `OVERWORLD_DIMS` in index.js is the same numbers;
// they are repeated rather than imported because requiring index.js from here would be a cycle.
const LAYOUT_ROWS = 4096;
const LAYOUT_COLS = LAYOUT_N * LAYOUT_DX;

// How far above `columnInfo`'s ground line content can still exist — flora crowns, lake surfaces standing proud
// of their banks, rock mounds. ⚠️ NOT A GUESS: `probe_worldgen2` Part E measures the true worst gap and fails if
// it ever reaches half of this, so the margin cannot rot as the world grows taller things.
const SKY_LIFT = 256;
// A sky island's `topRow` is the top of its CORE; relief is added above it, measured at up to 141 rows on one
// island and given a 3.6× margin here. A lake stands proud of its own column's ground by up to its own depth.
// ⚠️ All three are MEASURED margins, not model extents — Part E fails if the real worst gap reaches half of
// any of them, which is what stops them rotting as the world grows taller things.
const ISLE_LIFT = 512;
const LAKE_LIFT = 256;
// Floating ice stands proud of the water line (one ninth of its thickness, by the polar-sea design), so the
// sea's cap is above SEA_ROW, not at it. Measured at 3 rows on pack ice; a berg is far thicker.
const ICE_LIFT = 128;

// ⭐ BUMP THIS WHENEVER THE GENERATOR'S OUTPUT CHANGES — the same contract `worldgen.js`'s WORLDGEN_VERSION
// carries, and for the same reason: stored changes are kept as a DIFF against generated ground, so they are
// only meaningful alongside the generator that made them.
// ⚠️ 7 is the FIRST value, and it deliberately continues worldgen.js's sequence (which is at 6) rather than
// starting again at 1. The two generators stamp the SAME field on stored diffs, so overlapping numbers would
// make a gen2 diff look like valid gen1 ground — a stale-diff check that cannot tell the two apart is worse
// than none, because it would apply somebody's tunnel to entirely different rock and report success.
// 8 (2026-08-11): snow lies on exposed sea ice and glaciers, in patches, from a post-pass in cells.js.
// 9 (2026-08-11): …and that post-pass no longer paints a row of snow through the middle of a floe at every
//                 chunk boundary (it treated row 0 of a chunk SLICE as though it had air above it).
// 🟥 10 (2026-08-11): THE OVERWORLD'S LAYOUT SEED CHANGED, and that is why this is bumped even though not one
//                 line of the generator did. The seed is NOT part of a stored diff — only this version is — so
//                 a new seed silently means every saved tunnel and wall would be re-applied to entirely
//                 different rock and reported as a success. The version is the only thing standing between a
//                 seed change and that, which makes bumping it part of changing the seed rather than optional.
const WORLDGEN2_VERSION = 10;

// The signed shortest way round the ring, for "how far is this column from that record". A column one period
// along is otherwise half a million cells from every record in the world — the same `wdc` the spike applies 35
// times, needed here for the identical reason.
const HALF_P = PERIOD_COLS >> 1;
const wrapDelta = (d) => (d >= -HALF_P && d <= HALF_P) ? d
  : ((((d % PERIOD_COLS) + PERIOD_COLS + HALF_P) % PERIOD_COLS) - HALF_P);

// ── where a room-sized window sits, when nobody says ──────────────────────────────────────────────────────────
// ⚠️ SIMPLEST-THING-THAT-WORKS, deliberately, and not the page-rooms-as-windows design (which wants a
// rejection test — no bare ocean, no solid rock, no open air — and a registry recording where each site
// landed, so a page keeps its place). These two functions exist so that turning the generator on shows you
// GROUND instead of the empty sky an origin of (0,0) would frame.
// A window as wide as the world is not a window: it starts at 0 and there is nothing to choose.
function defaultOriginCol(seed, cols) {
  if (cols >= LAYOUT_COLS) return 0;
  // Different seeds land in different parts of the world, so two page rooms are two places rather than the
  // same view twice. Snapped to a chunk so a room's pages line up with the world's.
  const h = Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0;
  return (h % (LAYOUT_COLS - cols)) & ~(CHUNK_SIDE - 1);
}
// Frame on the ground at the middle of the window rather than on a fixed row: sea level is 1,900 but land
// reaches 1,865 rows above it and the sea bed is 700 below, so any constant is wrong somewhere in the world.
function defaultOriginRow(W, C, originCol, cols, rows) {
  if (rows >= LAYOUT_ROWS) return 0;
  const s = columnInfo(W, C, originCol + (cols >> 1)).surfRow;
  const want = Math.round(s - rows * 0.45);                 // ground a little below the middle, sky above it
  return Math.max(0, Math.min(LAYOUT_ROWS - rows, want)) & ~(CHUNK_SIDE - 1);
}

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
// ⭐⭐ THE LAYOUT IS SEPARABLE FROM THE WINDOW, AND THAT IS WHAT MAKES THE GENERATOR AFFORDABLE AS A DEFAULT.
// `buildWorld` + `prepare` cost ~1.8 s and depend on ONE thing: the layout seed. A room additionally has a
// window (which columns and rows of that world it shows), which costs nothing. Keeping them separate means a
// single layout can serve any number of rooms — otherwise every new page world freezes the whole server for
// 1.8 s, which is exactly why the plan had page rooms staying on `worldgen.js`.
// ⚠️ THERE IS NO CACHE IN HERE, DELIBERATELY. `makeGen2` always builds unless it is HANDED a layout, so
// `probe_worldgen2` A2 — "the same seed twice, with a different seed in between, gives the identical layout" —
// keeps testing a real build rather than being handed the same object back and passing trivially. The cache
// lives in `index.js` beside `_roomGens`, where its lifetime is a server's and not a module's.
function layoutFor(seed) {
  const t0 = Date.now();
  const W = buildWorld({ seed: seed | 0, n: LAYOUT_N, dx: LAYOUT_DX, steps: LAYOUT_STEPS });
  const t1 = Date.now();
  const C = prepare(W, SEA_ROW);
  return { seed: seed | 0, W, C, buildMs: t1 - t0, prepareMs: Date.now() - t1 };
}

function makeGen2(cfg) {
  const seed = (cfg && cfg.seed) | 0;
  // `seed` decides the WINDOW; `layout.seed` decides the WORLD. They are the same number when nobody separates
  // them, which is what keeps a plain `makeGen2({ seed })` behaving exactly as it did before.
  const L = (cfg && cfg.layout) ? cfg.layout : layoutFor(seed);
  const W = L.W, C = L.C;
  const t0 = Date.now(), t1 = t0 + (L.buildMs || 0), t2 = t1 + (L.prepareMs || 0);
  // ══ THE WINDOW ══════════════════════════════════════════════════════════════════════════════════════════════
  // ⭐ A ROOM IS A WINDOW ON THE LAYOUT, and the offsets are the whole of it (user decision, 2026-08-10 — see
  // kickoff_port.md). The Overworld is the window at (0, 0) covering the full 4,096 rows, so this changes
  // nothing today. It exists now because the alternative — assuming a room starts at world column 0 — is baked
  // into every call site and reopening it later is a sweep.
  // ⚠️ THE ROW OFFSET IS AS NECESSARY AS THE COLUMN ONE, and that was not obvious: a page room is 405 rows of a
  // 4,096-row world, so a window has to be placed VERTICALLY too or it shows nothing but sky.
  const rows = (cfg && cfg.rows) ? cfg.rows | 0 : LAYOUT_ROWS;
  const cols = (cfg && cfg.cols) ? cfg.cols | 0 : LAYOUT_COLS;
  // 🟥 A WINDOW WITH NO DEFAULTS SHOWS SKY, and that would have been the first thing anybody saw. A page room
  // is 405 rows of a 4,096-row world, so an origin of (0,0) frames the top-left corner — which is empty air
  // 1,500 rows above the ground. Both defaults exist so that turning this on gives you a place rather than a
  // void; NEITHER is the page-rooms-as-windows design, which needs a rejection test (no bare ocean, no solid
  // rock, no open air) and a registry recording where each site landed. This is the simplest thing that makes
  // the generator viewable, and it is labelled as such.
  const originCol = (cfg && cfg.originCol != null) ? cfg.originCol | 0 : defaultOriginCol(seed, cols);
  const originRow = (cfg && cfg.originRow != null) ? cfg.originRow | 0
    : defaultOriginRow(W, C, originCol, cols, rows);

  // ── the cell queries. ABSOLUTE WORLD COORDINATES, always. ───────────────────────────────────────────────────
  // `out` receives GAME material ids. The spike writes its own palette indices and they are translated in place
  // — one extra pass over 64 bytes, against a column that costs microseconds to synthesise.
  function fillColumn(c, r0, rN, out, outBack) {
    spikeFillColumn(W, C, c, r0, rN, out, outBack);
    for (let k = 0; k < rN; k++) { const v = out[k]; if (v) out[k] = XLAT[v]; }
    if (outBack) for (let k = 0; k < rN; k++) { const v = outBack[k]; if (v) outBack[k] = XLAT[v]; }
  }
  const _one = new Uint8Array(1);
  function matAt(c, rr) { fillColumn(c, rr, 1, _one); return _one[0]; }
  function strengthOf(v) { return STRENGTH[v]; }

  // ── one 64x64 page of the ROOM ──────────────────────────────────────────────────────────────────────────────
  // Page indexing is `worldgen.js`'s exactly — chunks numbered down-then-across (increment 5's column-major
  // address space), `page` optionally strided, `hpPage` optionally null. Copied in shape deliberately: the two
  // generators are read by the same `_alloc`/`fillPage` seam in index.js and must not differ about what page
  // `p` means.
  // ── 🟥🟥 EVERY CHUNK USED TO BE GENERATED TWICE, AND THIS CACHE IS WHY IT NO LONGER IS ──────────────────────
  // `sendChunkContent` produces a chunk's terrain by faulting the page in (→ `fillPage`) and then, separately,
  // calls `backingPage` for the uncarved rock behind it. But `fillColumn` fills BOTH outputs in ONE pass — so
  // the second call was recomputing the entire column to keep the output the first call had declined to ask
  // for, and throwing away the one it already had.
  // MEASURED (`probe_gen_column_cost.js`, four depth bands, Overworld shape): asking for the backing as well
  // costs **1.15×** the terrain-only call, while doing it as a second pass costs **1.87×**. A chunk's
  // generation goes **9.67ms → 5.16ms**.
  // ⚠️ IT IS A CACHE, NOT A MEMO OF ONE, and the structure of the caller is the reason. `sendChunkContent` is
  // deliberately TWO passes — produce every chunk, drain the deferred liquid, then read it all out — so by the
  // time `backingPage` is asked for the first chunk, `fillPage` has moved on to the last. A single-slot memo
  // (the trick `_genMemo` uses for terrain-and-hp, which ARE produced together) would miss almost every time.
  // ⚠️ AND IT PAYS OFF TWICE. `backingPage` runs on every chunk SENT, not just every chunk produced — so a
  // client re-entering ground the server already holds was paying a full regeneration per chunk for terrain
  // that never left memory. That is the window-churn case, i.e. the common one.
  // ⚠️ Per GENERATOR (it lives in makeGen2's closure), because the page number means different rock in
  // different rooms. Bounded by eviction to the oldest key; 4KB a page, so the cap is the memory budget.
  const BACK_CACHE_MAX = 256;                      // ≈1MB per generator — two windows' worth of chunks
  const _backCache = new Map();                    // page → Uint8Array(4096) of uncarved rock
  function _backCacheSet(p, buf) {
    if (_backCache.size >= BACK_CACHE_MAX) { const k = _backCache.keys().next().value; _backCache.delete(k); }
    _backCache.set(p, buf);
  }
  const _colBuf = new Uint8Array(CHUNK_SIDE), _colBack = new Uint8Array(CHUNK_SIDE);
  function fillPage(page, hpPage, p, geom, T) {
    const stride = (T | 0) || 1;
    const c0 = ((p / geom.cy) | 0) * CHUNK_SIDE, r0 = (p % geom.cy) * CHUNK_SIDE;
    const rN = Math.min(CHUNK_SIDE, geom.rows - r0), cN = Math.min(CHUNK_SIDE, geom.cols - c0);
    if (rN <= 0 || cN <= 0) return;
    const col = _colBuf, bcol = _colBack;
    const back = new Uint8Array(CHUNK_SIDE * CHUNK_SIDE);
    for (let lc = 0; lc < cN; lc++) {
      bcol.fill(0);
      fillColumn(originCol + c0 + lc, originRow + r0, rN, col, bcol);
      for (let lr = 0; lr < rN; lr++) {
        const v = col[lr], o = lr * CHUNK_SIDE + lc;
        if (v) { page[o * stride] = v; if (hpPage) hpPage[o] = STRENGTH[v]; }
        back[o] = bcol[lr];
      }
    }
    _backCacheSet(p, back);
  }

  // ── ONE 64x64 PAGE OF THE **UNCARVED** WORLD ────────────────────────────────────────────────────────────────
  //  The rock this page is made of, before caves, voids, descents, vents and volcano tubes were cut out of it —
  //  which is what the client draws behind a hollow. Same page indexing and same column loop as `fillPage`; the
  //  only difference is which of the two arrays `fillColumn` fills gets kept.
  //  ⚠️ It GENERATES, it does not READ THE STORE — so it can never fault a page in and can never materialise
  //  storage, however many chunks are asked for. That is the property `sendChunkContent` relies on.
  //  ⚠️ And it answers about the world as GENERATED, so a cave a player dug is not in it. That is the point:
  //  what is behind your tunnel is the ground you dug through, and the client fills that half in itself.
  const _backBuf = new Uint8Array(CHUNK_SIDE), _backCol = new Uint8Array(CHUNK_SIDE);
  function backingPage(out, p, geom) {
    const c0 = ((p / geom.cy) | 0) * CHUNK_SIDE, r0 = (p % geom.cy) * CHUNK_SIDE;
    const rN = Math.min(CHUNK_SIDE, geom.rows - r0), cN = Math.min(CHUNK_SIDE, geom.cols - c0);
    if (rN <= 0 || cN <= 0) return false;
    // ⭐ `fillPage` already computed this in the same pass it made the terrain — see the cache note above.
    // The generate-it-again path below is kept, and is still correct: it is what answers for a chunk this
    // generator has never produced (a page restored from disk, or one that fell out of the cache).
    const hit = _backCache.get(p);
    if (hit) { out.set(hit); return true; }
    for (let lc = 0; lc < cN; lc++) {
      _backBuf.fill(0); _backCol.fill(0);
      fillColumn(originCol + c0 + lc, originRow + r0, rN, _backCol, _backBuf);
      for (let lr = 0; lr < rN; lr++) out[lr * CHUNK_SIDE + lc] = _backBuf[lr];
    }
    return true;
  }

  // ── "is this page provably empty?" ──────────────────────────────────────────────────────────────────────────
  // 🟥🟥 THE ONE PLACE A MISTAKE HERE IS **INVISIBLE TERRAIN**. Answering "empty" means the page is never
  // allocated, so whatever was there is never stored and the client renders air the player then collides with.
  // It may therefore only ever say "empty" when that is CERTAIN, and every source of content above the plain
  // ground line has to be allowed for.
  // 🟥🟥 THE FIRST VERSION OF THIS WAS WRONG AND THE BRUTE-FORCE CHECK FOUND IT: **62 of 1,154 pages it called
  // empty actually had content in them.** I wrote "I am not enumerating the sources and trusting the list"
  // directly above the code that did exactly that. Two sources were missing, and neither was a margin problem —
  // no amount of widening `SKY_LIFT` would have fixed either:
  //   1. **THE SEA.** Water fills every open cell from row `SEA_ROW` (1900) DOWN to the sea bed at ~2,600. A
  //      whole page of ocean sits 350+ rows above the ground line the ground-line test was measuring from.
  //      ⭐ `worldgen.js` already had this exact clause and I did not carry it across: an ocean column is capped
  //      at the water line, not at its own sea bed.
  //   2. **A SKY ISLAND'S `topRow` IS NOT ITS TOP.** Column 14208's island runs rows 842..1021 while its record
  //      says `topRow` 983 — the true top is **141 rows higher**, because relief is added above the core. Using
  //      the record's own number as the extent was the mistake.
  // ⇒ both now carry a MEASURED margin rather than a modelled extent, and `probe_worldgen2` Part E asserts the
  // real worst gap never reaches half of either. The final safety net is Part B's brute force, which generates
  // every page it was told is empty and fails on a single non-zero cell — the only check here that cannot be
  // fooled by my model of the world being wrong, which it demonstrably was.
  function pageEmpty(p, geom) {
    const c0 = ((p / geom.cy) | 0) * CHUNK_SIDE, r0 = (p % geom.cy) * CHUNK_SIDE;
    const rN = Math.min(CHUNK_SIDE, geom.rows - r0), cN = Math.min(CHUNK_SIDE, geom.cols - c0);
    if (rN <= 0 || cN <= 0) return true;
    const r1 = originRow + r0 + rN - 1;
    if (r1 < 0) return true;
    let top = Infinity;
    for (let lc = 0; lc < cN; lc++) { const t = topLimitAt(originCol + c0 + lc); if (t < top) top = t; }
    return r1 < top;
  }

  // ⭐ THE PER-COLUMN LIMIT, EXPOSED — the highest row at which this column can hold anything. `pageEmpty` is
  // nothing but the minimum of this over its columns, so there is ONE definition and Part E can measure the
  // shipped rule directly against the real topmost cell instead of against a proxy for it.
  // 🟥 THAT MATTERS: Part E's first form measured "how far above `surfRow` is the topmost cell", which on an
  // ocean column is the SEA — a thing a different clause already handles — so it reported 775 rows of breach
  // against a rule that was fine, and would have sent me to widen the wrong constant. Measure what ships.
  // ⭐ WHERE THE GROUND ACTUALLY IS, which is a different question from `topLimitAt`'s "where could ANYTHING
  // be" — and confusing the two broke the lighting in a way only play could show. `topLimitAt` deliberately
  // lifts itself above sky islands, lakes and flora, because its job is to prove a page EMPTY. Used as "where
  // the sky starts", that makes every column under a floating island answer "there is no sky above me", and the
  // ground beneath one goes black. Named in this file's interface comment from the start; never implemented.
  function surfAt(c) { return columnInfo(W, C, c).surfRow; }
  // ⭐ WHICH REGION IS THIS COLUMN IN — the one fact the client has never been told, and the reason the backdrop
  // is the same picture in a rainforest and on an ice cap. The generator classifies every coarse sample into one
  // of `BIOME`'s entries from temperature, moisture and relief; `columnInfo` already resolves a column to its
  // sample, so this is a lookup and not a computation, and it rides the memoised column cache like `surfAt`.
  // ⚠️ A REGION IS DRESSING, NOT FORM. It says what covers the ground, never what shape the ground is — so it is
  // exactly the right thing to hang a BACKDROP off, and exactly the wrong thing to hang terrain off.
  function biomeAt(c) { const gi = columnInfo(W, C, c).sample; return (W.biome && gi >= 0) ? (W.biome[gi] | 0) : 0; }
  function topLimitAt(c) {
    const s = columnInfo(W, C, c).surfRow;
    // ground, plus whatever stands on it (flora crowns, mounds).
    let t = s - SKY_LIFT;
    // where the ground is below the sea, everything between the two is ocean.
    // 🟥 AND THE SEA IS NOT THE HIGHEST THING IN AN OCEAN COLUMN. Pack ice and bergs FLOAT — one ninth proud by
    // design — so ice stands ABOVE the water line: measured at row 1897 against a sea line of 1900. Capping at
    // `SEA_ROW` exactly left that ice outside the limit, and B5 missed it only because 64-row page alignment
    // happened to put the ice and the water line in the same page. Luck, not correctness.
    if (s > SEA_ROW) t = Math.min(t, SEA_ROW - ICE_LIFT);
    // a lake stands ABOVE its own column's ground by definition, and a mountain lake's surface is above the sea
    // line, so neither clause above covers it.
    const lakeE = C.lakeLevelAt(c);
    if (lakeE > -1e8) t = Math.min(t, SEA_ROW - lakeE - LAKE_LIFT);
    // Floating islands sit in what would otherwise be provably empty sky. Bounded record list, so the columns
    // are exact; the vertical extent is not, hence ISLE_LIFT.
    for (let i = 0; i < C.sky.length; i++) {
      const isle = C.sky[i];
      if (Math.abs(wrapDelta(c - isle.at)) > isle.hwPx + 2) continue;
      const it = isle.topRow - ISLE_LIFT;
      if (it < t) t = it;
    }
    return t;
  }

  // ══ ⭐⭐ THE FLOATING ISLANDS AS A SHORT LIST — for the client's BACKDROP, which cannot draw them any other way.
  //  The distance is a HEIGHTFIELD renderer: one surface row per column, filled from that line down to the bottom
  //  of the screen. A floating island has air UNDERNEATH it, which a heightfield cannot express at all — fill from
  //  its top and you paint a column of rock all the way down to the ground. So the backdrop needs them as
  //  discrete CLOSED BODIES, with a top and a bottom, and that is already exactly how they are held here.
  //  ⭐ THE WHOLE WORLD, IN ONE MESSAGE, ONCE. There are about a hundred of them across 4.19M px, so this is a few
  //  KB, and it cannot go stale: the layout is fixed by the seed and shared by every room. Same argument as the
  //  whole-world coarse surface strip, and the same reason it needs no interest management.
  //  ⚠️ `alt` IS THE ALTITUDE TO COLOUR IT AT, AND IT IS DELIBERATELY NOT ITS REAL HEIGHT. `prepareSky` dresses an
  //  island at a third of its height above the ground, capped, because at their true altitude 83 of 101 came out
  //  under snow — a monotonous white band, the opposite of "floating versions of different landscapes". The
  //  backdrop must colour them at the same virtual altitude or it will paint every one of them white, for exactly
  //  the same reason and with exactly the same complaint.
  //  ⚠️ ROWS AND COLUMNS ARE THE GENERATOR'S OWN, absolute. `index.js` shifts them into room space, the way it
  //  already does for `surfAt` and `seaRow`.
  // ⚠️ 32, NOT 20, AND IT WAS THE FIRST RENDER THAT SAID SO: an island is up to ~1,800 columns across and carries
  // its own relief, so 20 samples is one every 700px and the drawn top came out as sawteeth.
  const ISLE_PROF = 32;
  function skyIsles() {
    const seed = W.o.seed, out = [];
    for (let i = 0; i < C.sky.length; i++) {
      const I = C.sky[i];
      const top = new Array(ISLE_PROF), bot = new Array(ISLE_PROF);
      // ⚠️ STRICTLY INSIDE THE RIM: both profiles answer null at |t| >= 1, and a body has to close.
      for (let k = 0; k < ISLE_PROF; k++) {
        const t = (k / (ISLE_PROF - 1)) * 2 - 1;
        const c = I.at + Math.round(t * (I.hwPx - 2));
        top[k] = skyTop(I, c, seed) | 0;
        bot[k] = skyBot(I, c, seed) | 0;
      }
      out.push({ at: I.at, hw: I.hwPx, top, bot, alt: Math.max(0, Math.round(I.dressElev)) });
    }
    return out;
  }

  // ── "where can somebody stand in this row range?" ────────────────────────────────────────────────────────────
  // The query domain placement asks. Absolute world coordinates; walks at most (r1 - r0) rows of ONE column.
  // 🟥 It reads the FINISHED column, not pre-liquid ground — otherwise it reports the floor of a lava lake as
  // somewhere to stand and counts the water above a lake bed as headroom. Same bug worldgen.js records fixing.
  function bandGroundAt(c, r0, r1, clear) {
    const need = clear == null ? 5 : clear;               // 5 cells = the 40x40px player blob, exactly
    const lo = Math.max(0, r0 | 0), hi = Math.min(LAYOUT_ROWS - 1, r1 | 0);
    const n = hi - lo + 1; if (n <= 0) return -1;
    const buf = new Uint8Array(n);
    fillColumn(c, lo, n, buf);
    let air = 0;
    for (let k = 0; k < n; k++) {
      const v = buf[k];
      if (!v) { air++; continue; }
      if (!IS_FLUID[v] && air >= need) return lo + k;      // solid floor, clear space above
      air = 0;                                             // liquid is neither a floor nor headroom
    }
    return -1;
  }

  return {
    seed, W, C,
    layoutSeed: L.seed,
    version: WORLDGEN2_VERSION,
    seaRow: SEA_ROW, rows, cols: LAYOUT_COLS, cell: 8, bottomRow: LAYOUT_ROWS - 1,
    originCol, originRow,
    periodCols: PERIOD_COLS,
    layout: { n: LAYOUT_N, dx: LAYOUT_DX, steps: LAYOUT_STEPS },
    env: activeEnvSwitches(),
    buildMs: t1 - t0, prepareMs: t2 - t1, ms: t2 - t0,
    // the surface `index.js` actually consumes — measured, not assumed: `fillPage` (3 call sites),
    // `pageEmpty` (1, via `PagedArray.seedEmpty`) and `bandGroundAt` (2, the spawn seam). The rest are here
    // because the probes and previewers need them.
    fillPage, backingPage, pageEmpty, topLimitAt, surfAt, biomeAt, bandGroundAt, fillColumn, matAt, strengthOf, skyIsles,
    // The region names, so the wire can carry a byte and the client can still say what it means. ONE list, two
    // readers — the rule this whole port exists to keep.
    biomeKeys: BIOME.map(b => b.key), biomeNames: BIOME.map(b => b.name),
    XLAT, STRENGTH, IS_FLUID, SKY_LIFT,
  };
}

// ⭐ The record lists `prepare` places, named in one place so a probe does not have to hold its own copy of the
// list and go stale when a seventeenth kind of record is added. Order is `prepare`'s own placement order.
const RECORD_LISTS = ['volc', 'vents', 'voids', 'caves', 'sky', 'deep', 'forms', 'descents', 'rim', 'cliffs'];

module.exports = { makeGen2, layoutFor, PERIOD_COLS, SEA_ROW, LAYOUT_N, LAYOUT_DX, LAYOUT_STEPS, RECORD_LISTS,
  LAYOUT_ROWS, LAYOUT_COLS, CHUNK_SIDE, WORLDGEN2_VERSION, SKY_LIFT, ISLE_LIFT, LAKE_LIFT, ICE_LIFT, XLAT, STRENGTH, IS_FLUID,
  ENV_SWITCHES, activeEnvSwitches, MATS, M };
