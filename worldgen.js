'use strict';
// ==============================================================================================================
//  worldgen.js — CHUNK-ON-DEMAND WORLD GENERATION.  Shared-World Phase 6, increment 4.
//
//  WHAT THIS IS FOR.  `generateWorld` in index.js builds an entire world up front. The Overworld cannot be built
//  up front: it is millions of pixels wide, so terrain has to be a PURE FUNCTION of (seed, column, row) that can
//  be evaluated for one 64x64 chunk in isolation, thrown away, and produced again identically later. Only PLAYER
//  EDITS are stored; everything else is recomputed.
//
//  ⭐ TWO GENERATORS, ON PURPOSE (SHARED-WORLD.md §5). `generateWorld` is UNTOUCHED and still owns page rooms —
//  it has published worlds, saved Levels and a lot of tuning resting on its exact output. This file is the second
//  generator. It reproduces the same FEATURE VOCABULARY (heightmap, six surface biomes, six underground regions,
//  crust, veins, worm caves, surface lakes, cave pools, rock mounds) so the two can be compared side by side, but
//  it is NOT bit-identical to it and is not trying to be: the numbers differ because the randomness is drawn
//  differently, which is the entire point.
//
//  🟥 WHAT WAS ACTUALLY ENTANGLED, which is not what the plan said.  The recorded note was "cave carving, lake
//  flooding and scatter consume one sequential rng stream". Read closely, the cave and pool LOOP BODIES draw no
//  randomness at all — they are pure trigonometry. What is sequential is that their PHASE CONSTANTS (cp0..cp4,
//  wp, wp2) are drawn from a stream that the per-cell fill loop has already advanced hundreds of thousands of
//  times. Change how one cell picks its material and every cave in the world moves. So the fix is structural and
//  small: every field constant comes off ONE dedicated stream in ONE block, before anything else runs, and the
//  per-cell draws become positional hashes.
//
//  ⭐ MEASURED (scratchpad/probe_worldgen.js Part M), and it inverted the assumption:
//    · a positional hash costs 0.77x the sequential stream it replaces — CHEAPER, not dearer (~10us per chunk);
//    · the CAVE FIELD costs 32x the random draw (~409us per chunk). Generation cost is trigonometry, full stop.
//  That second number is why `fillPage` builds a SCRATCH COLUMN with vertical overlap: the cave-pool rule needs
//  to know what is up to POOL_DEPTH+1 rows BELOW each air cell, and re-running the cave field for each probe
//  would have made an underground chunk ~13x dearer. Computed once per column into a buffer, the probe is a
//  byte read and the overlap costs 13/64 = 1.2x.
//
//  ⚠️ TERRAIN ONLY. `generateWorld` also places OBJECTS (trees, sky platforms, cave props) into `roomObjects`,
//  which is a single per-room Map broadcast wholesale to every client. That does not survive an infinite world
//  and needs an object-streaming design that does not exist yet, so objects are deliberately OUT of this
//  increment rather than half-built. The hooks a later pass needs are already here: `isAnchor`/`moundOn` show
//  the pattern for anything placed on a regular lattice with a per-anchor decision, and ORE VEINS — the thing
//  the token economy actually wants — are terrain, so they land in `baseAt` with no new machinery at all.
// ==============================================================================================================

// The server's PRNG, verbatim. Used ONLY to derive the per-world field constants below — never per cell.
// (index.js keeps its own copy for the legacy `generateWorld`; they must stay the same function.)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ⭐ THE POSITIONAL DRAW — the one thing that makes a chunk producible in isolation. A murmur-style avalanche
// chain: each input is folded in and diffused before the next arrives, so no pair of nearby (c, r) shares
// structure. `salt` separates independent decisions AT THE SAME CELL, which is what a sequential stream got for
// free by simply advancing. Chosen over two alternatives on measured quality at equal cost (probe Part M):
// chi-square 16.3 over 16 buckets and lattice correlation < 0.004 in all three neighbour directions.
// ⚠️ A hash that correlates across neighbours is not a slow world, it is a VISIBLE STRIPE PATTERN in the ground,
// which is why the probe tests correlation and carries a deliberately-bad control hash to prove it can fail.
function h(seed, salt, x, y) {
  let a = seed | 0;
  a = Math.imul(a ^ x, 0x85EBCA6B); a ^= a >>> 13;
  a = Math.imul(a ^ y, 0xC2B2AE35); a ^= a >>> 16;
  a = Math.imul(a ^ salt, 0x27D4EB2F); a ^= a >>> 15;
  return (a >>> 0) / 4294967296;
}
// Salts. One per independent decision — reusing a salt makes two decisions at a cell perfectly correlated.
const SALT = { MAT: 1, DIRT: 2, DEEP: 3, MOUND_ON: 4, MOUND_H: 5, MOUND_N: 6 };

const MAT = { EARTH: 1, STONE: 2, SAND: 3, ICE: 4, MUD: 5, SNOW: 8, WATER: 9, QUICKSAND: 10, LAVA: 11, BRINE: 14 };
// Biomes are small ints rather than the strings `generateWorld` uses — they are compared once per column and
// once per cell, and an int compare in the fill loop is free where a string compare is not.
const SB = { PLAINS: 0, FOREST: 1, DESERT: 2, SNOW: 3, SWAMP: 4, VOLCANIC: 5 };
const UB = { CAVERNS: 0, FROZEN: 1, FUNGAL: 2, MOLTEN: 3, CRYSTAL: 4, SANDSTONE: 5 };
// ONE liquid per underground region, so each area reads coherently (same table as generateWorld's regionFluid).
const REGION_FLUID = [MAT.WATER, MAT.WATER, MAT.BRINE, MAT.LAVA, MAT.WATER, MAT.QUICKSAND];
const DEF_STRENGTH = { 2: 3, 4: 2, 5: 2, 17: 2 };     // matches index.js BUILTIN_STRENGTH; everything else is 1
const TAU = Math.PI * 2;
const CHUNK_SIDE = 64;

// ==============================================================================================================
//  makeGen(cfg) — everything a world is, derived from its seed. Cheap: a few dozen draws and no allocation
//  proportional to world size, so it is fine to build one per room and hold it for the room's lifetime.
//
//  cfg: { seed, cols, rows, cell, floorTop, surfaceFrac?, spawnX?, spawnHalfW?, band?, strength? }
//    spawnX  — world px to flatten a landing plateau around, or null for none (the Overworld has one plateau
//              per DOMAIN, which is increment 5's job; a page room has exactly one, at the middle).
//    band    — {c0, c1} column limits, matching generateWorld's Level-size confinement; null = the whole width.
// ==============================================================================================================
function makeGen(cfg) {
  const seed = cfg.seed | 0;
  const cols = cfg.cols | 0, rows = cfg.rows | 0;
  const CELL = cfg.cell || 8;
  // Feature sizes were tuned in rows/columns for a 24px cell; G restores physical sizes at any cell size
  // (multiply row/column counts by G, divide spatial frequencies by G). Same convention as generateWorld.
  const G = 24 / CELL;
  const floorTop = (cfg.floorTop != null) ? cfg.floorTop : (rows * CELL - 72);
  const bottomRow = Math.min(rows - 1, Math.ceil(floorTop / CELL) - 1);   // last terrain row resting on the floor
  const baseRow = Math.round(bottomRow * (cfg.surfaceFrac != null ? cfg.surfaceFrac : 0.47));
  const CRUST = Math.round(4 * G);
  const POOL_DEPTH = Math.round(4 * G);
  const strTab = cfg.strength || DEF_STRENGTH;
  const strengthOf = (v) => strTab[v] || 1;

  // ⭐⭐ THE FIX FOR CHUNK-INDEPENDENCE, AND IT IS THIS BLOCK.  Every field constant in the world comes off ONE
  // dedicated stream, drawn HERE, before any per-cell work exists to advance it. In `generateWorld` the cave
  // phases are drawn after the fill loop has made ~700,000 draws and the pool phases after that again, so the
  // caves depend on the material of every cell before them — which is precisely why a chunk cannot be produced
  // alone there. Order matters (it defines the world for a seed) but nothing outside this block may draw.
  const r = mulberry32(seed);
  const p0 = r() * TAU, p1 = r() * TAU, p2 = r() * TAU;                    // heightmap phases
  const a0 = (7 + r() * 7) * G, a1 = (3 + r() * 3) * G, a2 = (1 + r() * 2) * G;   // heightmap amplitudes
  const bp0 = r() * TAU, bp1 = r() * TAU, bp2 = r() * TAU;                // surface-biome field
  const gp0 = r() * TAU, gp1 = r() * TAU;                                 // underground-region field
  const cp0 = r() * TAU, cp1 = r() * TAU, cp2 = r() * TAU, cp3 = r() * TAU, cp4 = r() * TAU;   // cave fields
  const wp = r() * TAU, wp2 = r() * TAU;                                  // cave-pool wetness field

  const seaRow = baseRow + Math.round(6 * G);                             // valleys deeper than this flood
  const genC0 = cfg.band ? Math.max(0, cfg.band.c0) : 0;
  const genC1 = cfg.band ? Math.min(cols - 1, cfg.band.c1) : cols - 1;

  // ---- pure fields of the column ----------------------------------------------------------------------------
  const heightAt = (c) => {
    const hh = Math.sin(c * 0.016 / G + p0) * a0 + Math.sin(c * 0.05 / G + p1) * a1 + Math.sin(c * 0.12 / G + p2) * a2;
    const s = Math.round(baseRow - hh);
    return s < 6 * G ? 6 * G : (s > bottomRow - 10 * G ? bottomRow - 10 * G : s);
  };
  const surfBiomeAt = (c) => {
    const v = Math.sin(c * 0.010 / G + bp0) + 0.5 * Math.sin(c * 0.023 / G + bp1) + 0.3 * Math.sin(c * 0.043 / G + bp2);
    if (v > 1.05) return SB.SNOW; if (v > 0.35) return SB.FOREST; if (v < -1.05) return SB.VOLCANIC;
    if (v < -0.5) return SB.DESERT; if (v < -0.1) return SB.SWAMP; return SB.PLAINS;
  };
  const ugBiomeAt = (c) => {
    const v = Math.sin(c * 0.0055 / G + gp0) + 0.6 * Math.sin(c * 0.015 / G + gp1);
    if (v > 1.15) return UB.FROZEN; if (v > 0.4) return UB.FUNGAL; if (v < -1.15) return UB.MOLTEN;
    if (v < -0.45) return UB.CRYSTAL; if (v < -0.05) return UB.SANDSTONE; return UB.CAVERNS;
  };
  // Flat landing plateau, clamped above the water line so a spawn is dry and level.
  const centerCol = (cfg.spawnX != null) ? Math.floor(cfg.spawnX / CELL) : -1;
  const plateauHalf = Math.ceil((cfg.spawnHalfW || 52) / CELL) + Math.round(3 * G);
  let plateauSurf = 0;
  if (centerCol >= 0) {
    plateauSurf = heightAt(centerCol);
    if (plateauSurf > seaRow - 3 * G) plateauSurf = seaRow - 3 * G;
    if (plateauSurf < 6 * G) plateauSurf = 6 * G;
  }
  const onPlateau = (c) => centerCol >= 0 && Math.abs(c - centerCol) <= plateauHalf;
  const surfAt = (c) => onPlateau(c) ? plateauSurf : heightAt(c);
  const sbAt = (c) => onPlateau(c) ? SB.PLAINS : surfBiomeAt(c);
  const dirtBotAt = (c, s) => s + CRUST + Math.round(8 * G) + ((h(seed, SALT.DIRT, c, 0) * 5 * G) | 0);
  const deepTopAt = (c) => bottomRow - Math.round(14 * G) - ((h(seed, SALT.DEEP, c, 0) * 6 * G) | 0);
  const crustMat = (sB, rr, s) => sB === SB.DESERT ? MAT.SAND : sB === SB.SNOW ? (rr === s ? MAT.SNOW : MAT.EARTH)
    : sB === SB.SWAMP ? MAT.MUD : sB === SB.VOLCANIC ? MAT.STONE : MAT.EARTH;

  // ---- 1. solid fill: biome crust over a depth-layered underground (dirt -> stone+veins -> deep) -------------
  // ⚠️ ONE draw per cell, exactly as generateWorld makes one `rng()` per row whichever branch it takes — so the
  // three bands share `q` and the material statistics are unchanged. This is where ORE VEINS will go.
  const baseAt = (c, rr, s, sB, uB, dirtBot, deepTop) => {
    if (rr < s || rr > bottomRow) return 0;
    if (rr < s + CRUST) return crustMat(sB, rr, s);
    const q = h(seed, SALT.MAT, c, rr);
    if (rr < dirtBot) return q < 0.12 ? MAT.STONE : MAT.EARTH;
    if (rr < deepTop) {
      if (uB === UB.FROZEN && q < 0.10) return MAT.ICE;
      if (uB === UB.CRYSTAL && q < 0.08) return MAT.ICE;
      if (uB === UB.FUNGAL && q < 0.12) return MAT.MUD;
      if (uB === UB.SANDSTONE && q < 0.14) return MAT.SAND;
      if (q < 0.05) return MAT.EARTH;
      return MAT.STONE;
    }
    return (uB === UB.SANDSTONE && q < 0.12) ? MAT.SAND : MAT.STONE;
  };
  // ---- 2. caves: narrow winding tunnels, plus the occasional wider pocket deeper down ------------------------
  // Pure trigonometry — no randomness at all, which is why caves were never the hard part. THE most expensive
  // thing in the file (five Math.sin per cell, 32x the random draw), so the `worm` test short-circuits.
  const caveAt = (c, rr, top) => {
    const depth = (rr - top) / Math.max(1, bottomRow - top);
    const worm = Math.abs(Math.sin((c * 0.06 + rr * 0.033) / G + cp0) + Math.sin((c * 0.025 - rr * 0.052) / G + cp1) + Math.sin((c + rr) * 0.041 / G + cp2));
    if (worm < 0.24 + depth * 0.12) return true;
    return Math.sin((c * 0.018 + rr * 0.022) / G + cp3) + Math.sin((c * 0.034 - rr * 0.013) / G + cp4) > 1.86 - depth * 0.26;
  };
  // ---- 4. surface rock mounds ------------------------------------------------------------------------------
  // Kept because it is the TEMPLATE for everything the world will later scatter: a regular lattice of anchor
  // columns, a per-anchor "is there one here", a per-anchor size, and a spill into the NEXT column — the last
  // being the reason a chunk generator has to be able to ask about a cell it does not own.
  const moundStep = Math.max(1, Math.round(6 * G));
  const moundLo = Math.max(8, genC0), moundHi = Math.min(cols - 8, genC1);
  const isAnchor = (a) => a >= moundLo && a < moundHi && (a - moundLo) % moundStep === 0;
  const outsideSpawn = (c) => centerCol < 0 || Math.abs((c + 0.5) * CELL - (centerCol + 0.5) * CELL) > (cfg.spawnHalfW || 52) + 64;
  const moundOn = (a) => h(seed, SALT.MOUND_ON, a, 0) <= 0.10 && surfAt(a) <= seaRow && outsideSpawn(a);
  const moundHgt = (a) => (1 + ((h(seed, SALT.MOUND_H, a, 0) * 2) | 0)) * G;
  // `s` is THIS column's surface — both the anchor's own stamp and the neighbour spill are drawn against the
  // surface of the column being written, which is what generateWorld's `set(c + 1, surf[c + 1] - 1 - k)` does.
  const moundAt = (c, rr, s) => {
    const k = s - 1 - rr; if (k < 0) return false;
    if (isAnchor(c) && k < moundHgt(c) && moundOn(c)) return true;
    const a = c - 1;
    return isAnchor(a) && k < moundHgt(a) && h(seed, SALT.MOUND_N, a, k) > 0.5 && moundOn(a);
  };

  // ---- 3b. cave pools --------------------------------------------------------------------------------------
  // ⭐ REFORMULATED FROM A COLUMN SCAN INTO A LOCAL RULE, and that is what makes pools chunk-independent.
  // generateWorld walks each column from the world floor upward, and every time it finds air resting on solid
  // it fills POOL_DEPTH cells and then skips the air gap above. That is a sequential scan over a full column —
  // 1,664 rows in the Overworld — so a 64-row chunk could not produce it alone. Written the other way round it
  // is entirely local: a cell is pool fluid exactly when the first solid at or below it is within POOL_DEPTH.
  // (Equivalence is not argued, it is asserted — probe Part C runs the original scan and this rule over the
  // same columns and compares every cell.)
  const poolCfgAt = (c, s, uB) => {
    const wet = Math.sin(c * 0.02 / G + wp) + 0.5 * Math.sin(c * 0.061 / G + wp2);
    return {
      on: uB === UB.MOLTEN ? true : wet > 0.25,                            // molten always seeps; others patchy
      fluid: REGION_FLUID[uB] || MAT.WATER,
      tableRow: uB === UB.MOLTEN ? bottomRow - Math.round(10 * G) : s + CRUST + Math.round(14 * G),
    };
  };

  // ---- the readable, slow, one-cell-at-a-time form ----------------------------------------------------------
  // Not used by fillPage — it re-derives the whole column for every cell. It exists because it is the OBVIOUS
  // implementation, and Part A asserts the fast path agrees with it cell for cell across a whole world. A fast
  // path with no slow twin to check it against is a fast path nobody can prove.
  function matAt(c, rr) {
    if (c < genC0 || c > genC1 || c < 0 || c >= cols || rr < 0 || rr >= rows) return 0;
    const s = surfAt(c), sB = sbAt(c), uB = ugBiomeAt(c);
    const dirtBot = dirtBotAt(c, s), deepTop = deepTopAt(c), top = s + CRUST + 1;
    const carved = (rw) => { const v = baseAt(c, rw, s, sB, uB, dirtBot, deepTop); return (v && rw >= top && caveAt(c, rw, top)) ? 0 : v; };
    const v = carved(rr); if (v) return v;
    if (s > seaRow && rr >= seaRow && rr < s) return MAT.WATER;            // 3a surface lake
    const pc = poolCfgAt(c, s, uB);
    if (pc.on && rr >= pc.tableRow && rr <= bottomRow) {
      for (let k = 1; k <= POOL_DEPTH; k++) { const rw = rr + k; if (rw > bottomRow || carved(rw)) return pc.fluid; }
    }
    if (rr < s && moundAt(c, rr, s)) return MAT.STONE;
    return 0;
  }

  // ---- the fast form: one 64x64 page ------------------------------------------------------------------------
  // Column-major so every per-column value is derived once for 64 cells, with a SCRATCH COLUMN carrying
  // POOL_DEPTH+1 rows of overlap past the bottom of the page so the pool probe reads a byte instead of
  // re-running the cave field. `page` may be strided (T values per cell); `hpPage` may be null.
  let scratch = new Uint8Array(CHUNK_SIDE + POOL_DEPTH + 2);
  function fillPage(page, hpPage, p, geom, T) {
    const stride = (T | 0) || 1;
    const c0 = (p % geom.cx) * CHUNK_SIDE, r0 = ((p / geom.cx) | 0) * CHUNK_SIDE;
    const rN = Math.min(CHUNK_SIDE, geom.rows - r0), cN = Math.min(CHUNK_SIDE, geom.cols - c0);
    if (rN <= 0 || cN <= 0) return;
    const SPAN = rN + POOL_DEPTH + 1;
    if (scratch.length < SPAN) scratch = new Uint8Array(SPAN);
    for (let lc = 0; lc < cN; lc++) {
      const c = c0 + lc;
      if (c < genC0 || c > genC1) continue;
      const s = surfAt(c), sB = sbAt(c), uB = ugBiomeAt(c);
      const dirtBot = dirtBotAt(c, s), deepTop = deepTopAt(c), top = s + CRUST + 1;
      for (let k = 0; k < SPAN; k++) {
        const rr = r0 + k;
        let v = baseAt(c, rr, s, sB, uB, dirtBot, deepTop);
        if (v && rr >= top && caveAt(c, rr, top)) v = 0;
        scratch[k] = v;
      }
      const pc = poolCfgAt(c, s, uB);
      const lake = s > seaRow;
      for (let lr = 0; lr < rN; lr++) {
        const rr = r0 + lr;
        let v = scratch[lr];
        if (!v) {
          if (lake && rr >= seaRow && rr < s) v = MAT.WATER;
          else if (pc.on && rr >= pc.tableRow && rr <= bottomRow) {
            for (let k = 1; k <= POOL_DEPTH; k++) { if (r0 + lr + k > bottomRow || scratch[lr + k]) { v = pc.fluid; break; } }
          }
          if (!v && rr < s && moundAt(c, rr, s)) v = MAT.STONE;
        }
        if (v) { const o = lr * CHUNK_SIDE + lc; page[o * stride] = v; if (hpPage) hpPage[o] = strengthOf(v); }
      }
    }
  }

  // ⭐ "IS THIS PAGE PROVABLY EMPTY?" — asked BEFORE a page is allocated, so open sky costs nothing at all.
  // Half a page world and much more of a tall Overworld is sky; without this, reading one cell of it would
  // fault in 4KB of zeros and undo increment 2's sparse storage from the other direction.
  // ⚠️ DELIBERATELY CONSERVATIVE — it may only ever answer "empty" when that is certain, because a false
  // "empty" is invisible terrain. Three things can put content above the ground line, so all three are
  // allowed for: surface lakes fill DOWN FROM `seaRow`, rock mounds stack up to `2*G` rows ABOVE the surface,
  // and the world floor is at `bottomRow`. Costs 64 `surfAt` calls (~3 sines each) against a 4KB allocation
  // plus a full page generation, so it pays for itself many times over.
  function pageEmpty(p, geom) {
    const c0 = (p % geom.cx) * CHUNK_SIDE, r0 = ((p / geom.cx) | 0) * CHUNK_SIDE;
    const rN = Math.min(CHUNK_SIDE, geom.rows - r0), cN = Math.min(CHUNK_SIDE, geom.cols - c0);
    if (rN <= 0 || cN <= 0) return true;
    if (r0 > bottomRow) return true;                       // below the bedrock floor — nothing is generated there
    if (c0 > genC1 || c0 + cN - 1 < genC0) return true;    // outside the generated column band
    let top = Infinity;
    for (let lc = 0; lc < cN; lc++) {
      const c = c0 + lc; if (c < genC0 || c > genC1) continue;
      const s = surfAt(c);
      const t = Math.min(s - 2 * G, s > seaRow ? seaRow : Infinity);   // mounds above the surface, lakes from seaRow
      if (t < top) top = t;
    }
    return r0 + rN - 1 < top;                              // the whole page sits above anything that could exist
  }

  return {
    cols, rows, cell: CELL, seed, G, bottomRow, baseRow, seaRow, CRUST, POOL_DEPTH, genC0, genC1,
    surfAt, sbAt, ugBiomeAt, baseAt, caveAt, poolCfgAt, moundAt, dirtBotAt, deepTopAt, strengthOf,
    matAt, fillPage, pageEmpty,
  };
}

module.exports = { makeGen, mulberry32, h, SALT, MAT, SB, UB, REGION_FLUID, CHUNK_SIDE };
