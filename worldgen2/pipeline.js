'use strict';
// ==============================================================================================================
//  worldspike/pipeline.js — THE COARSE WORLD PIPELINE, AS A STANDALONE SPIKE.
//
//  This is step 0 of the world redesign agreed 2026-08-07. It answers ONE question, cheaply, before any of the
//  expensive machinery is designed around it:
//
//      does a fields -> erosion -> drainage -> climate -> regions -> features pipeline produce a world that
//      looks COMPOSED, VARIED and LEGIBLE, rather than a noise field with things sprinkled on it?
//
//  ⚠️ NOTHING HERE TOUCHES THE SERVER, and it deliberately shares no code with `server/worldgen.js` — not even
//  the noise. This is a spike for a DIFFERENT design, and borrowing the old one's primitives is how a spike
//  quietly turns into the thing it was supposed to replace.
//
//  ⭐⭐ THE ONE STRUCTURAL FACT THAT SHAPES EVERY ALGORITHM HERE: THE GAME IS A SIDE VIEW, SO THE SURFACE IS A
//  1-D HEIGHTFIELD h(x). That is not a simplification, it is the actual dimensionality of the thing, and it
//  changes what erosion and rivers even mean:
//    · there are no dendritic river networks and no confluences — along one line there is only one path;
//    · but the concave long-profile that erosion carves IS the thing a side view shows, so 1-D erosion buys
//      more here than 2-D erosion would buy a top-down game;
//    · orographic rain shadow is a sweep along the wind direction, which in 1-D is exact rather than an
//      approximation — deserts behind mountain ranges come out for free;
//    · and the world becomes a CHAIN OF WATERSHEDS separated by divides, which is a natural region boundary
//      that nobody has to invent.
//  The whole coarse pipeline is therefore O(n log n) over ~8,000 samples. It runs in well under a second.
//
//  UNITS. `x` is a sample; one sample is DX columns of the real world (64 columns = 512 px). Elevation is in
//  ROWS relative to sea level, positive UP, because that is the unit the rest of the project thinks in.
//
//  RUN:  node scratchpad/worldspike/preview.js
// ==============================================================================================================

// ---- noise: small, self-contained, and deliberately its own -------------------------------------------------
function h1(seed, salt, x) {
  let n = (x | 0) * 374761393 + seed * 668265263 + salt * 2246822519;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t) => t * t * (3 - 2 * t);
// ══ PERIODICITY, IN SAMPLE SPACE ═══════════════════════════════════════════════════════════════════════════
// ⭐ The coarse pass is indexed by SAMPLE, and `n * dx` is exactly one PERIOD_COLS — so a field that repeats
// every `n` samples repeats every PERIOD_COLS columns. That is why the period here is simply `n` and there is
// no conversion anywhere: the two spaces were already built to line up.
// ⚠️ Same three rules as noise.js, which has the long version:
//   · quantise the FREQUENCY, not the period (`pfreq`) — rounding the period and keeping the frequency gives a
//     field periodic at some OTHER distance, which measures as no periodicity at all;
//   · wrap the LATTICE index, never the input — folding x leaves a hard seam at the join;
//   · octave o samples at x*2^o, so ITS period is per*2^o.
// `per` falsy = not wrapped, which is exactly today's behaviour and is what makes this convertible one site at
// a time.
const wrapI = (i, per) => (i >= 0 && i < per) ? i : ((i % per) + per) % per;
function vn(seed, salt, x, per) {                  // value noise, one dimension
  const i = Math.floor(x), f = x - i;
  const i0 = per ? wrapI(i, per) : i, i1 = per ? (i0 + 1 === per ? 0 : i0 + 1) : i + 1;
  return h1(seed, salt, i0) * (1 - smooth(f)) + h1(seed, salt, i1) * smooth(f);
}
function fbm(seed, salt, x, oct, gain, per) {
  let a = 1, f = 1, s = 0, n = 0;
  for (let o = 0; o < oct; o++) { s += a * vn(seed, salt + o * 71, x * f, per ? per * f : 0); n += a; a *= (gain || 0.5); f *= 2; }
  return s / n;
}
// Ridged noise — the shape that makes mountain BELTS rather than lumps. |2v-1| inverted gives sharp crests.
function ridge(seed, salt, x, oct, per) {
  let a = 1, f = 1, s = 0, n = 0;
  for (let o = 0; o < oct; o++) { s += a * (1 - Math.abs(2 * vn(seed, salt + o * 131, x * f, per ? per * f : 0) - 1)); n += a; a *= 0.5; f *= 2; }
  return s / n;
}
// ⭐ THE SAMPLE-SPACE FREQUENCY QUANTISER, and the wrapped index hash beside it.
// ⚠️ MODULE level, taking `n` explicitly, and that is not tidiness. The coarse pass is not one function —
// `computeClimate` is CALLED from inside `buildWorld` but DECLARED beside it, so a helper closed over
// `buildWorld`'s locals is a ReferenceError there and nowhere else. That is the same shape as the sliced-block
// trap that has bitten the server nine times, and it bit here on the first run. Passing `n` makes it
// unrepresentable rather than merely fixed.
// `pf(n, K)` replaces a literal `i / K`: sample at `.q`, wrap at `.p`, NEVER at the literal — see the note on
// `vn` above for why rounding the period instead of the frequency silently yields no periodicity at all.
const _pfCache = new Map();
function pf(n, K) { const k = n + ':' + K; let v = _pfCache.get(k); if (!v) { const p = Math.max(1, Math.round(n / K)); v = { p, q: p / n }; _pfCache.set(k, v); } return v; }
const wnI = (i, n) => (i % n + n) % n;
const hwI = (seed, salt, i, n) => h1(seed, salt, wnI(i, n));
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const lerp = (a, b, t) => a + (b - a) * t;

// ---- a tiny binary min-heap, for Priority-Flood --------------------------------------------------------------
// ⚠️ In 1-D with OUTLETS IN THE MIDDLE (every cell at or below sea level is an outlet) the cheap prefix-maximum
// trick for filling depressions is wrong. Priority-Flood is unambiguous and n is 8,192, so the log factor is
// not worth thinking about.
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      k[0] = lastK; v[0] = lastV; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

// ==============================================================================================================
//  LITHOLOGY — the axis the current world does not have, and the one that decides most geology.
//  Whether you get karst caves, mesas, lava tubes or granite domes is a fact about the ROCK, not the climate.
// ==============================================================================================================
const LITH = ['basement', 'granite', 'basalt', 'sandstone', 'limestone', 'shale', 'evaporite'];
const L = { BASEMENT: 0, GRANITE: 1, BASALT: 2, SANDSTONE: 3, LIMESTONE: 4, SHALE: 5, EVAPORITE: 6 };
// How fast each rock erodes, relative. Soft rock makes badlands; hard rock holds cliffs and canyon walls.
const LITH_K = [0.55, 0.6, 0.75, 1.15, 0.9, 1.7, 2.2];

// ==============================================================================================================
//  BIOMES — a Whittaker-style classification, chosen by (temperature, moisture) and then modified by relief.
//  ⚠️ These are DRESSING, in the form/dressing split: they say what covers the ground, never what shape it is.
// ==============================================================================================================
const BIOME = [
  { key: 'ocean', name: 'Ocean', col: '#1b3a5c' },
  { key: 'shelf', name: 'Continental shelf', col: '#2a5c86' },
  { key: 'lake', name: 'Lake', col: '#2f6f9e' },
  { key: 'icecap', name: 'Ice cap', col: '#e8f2f7' },
  { key: 'glacier', name: 'Glacier', col: '#bcd8e6' },
  { key: 'tundra', name: 'Tundra', col: '#8d9a86' },
  { key: 'taiga', name: 'Taiga', col: '#3f5f47' },
  { key: 'coldsteppe', name: 'Cold steppe', col: '#9a9a6e' },
  { key: 'colddesert', name: 'Cold desert', col: '#a8a292' },
  { key: 'tempforest', name: 'Temperate forest', col: '#4a7a3c' },
  { key: 'temprain', name: 'Temperate rainforest', col: '#2f6136' },
  { key: 'grassland', name: 'Grassland', col: '#8fa14e' },
  { key: 'medit', name: 'Mediterranean scrub', col: '#8b9455' },
  { key: 'savanna', name: 'Savanna', col: '#b2a355' },
  { key: 'monsoon', name: 'Monsoon forest', col: '#5f8c3a' },
  { key: 'rainforest', name: 'Tropical rainforest', col: '#256b2c' },
  { key: 'hotdesert', name: 'Hot desert', col: '#d8bd7e' },
  { key: 'scrub', name: 'Semi-arid scrub', col: '#b09a63' },
  { key: 'wetland', name: 'Wetland', col: '#5b7a5a' },
  { key: 'alpine', name: 'Alpine', col: '#9aa3a8' },
  { key: 'montane', name: 'Montane forest', col: '#3c5c40' },
  { key: 'saltflat', name: 'Salt flat', col: '#e4e0d2' },
];
const B = {}; BIOME.forEach((b, i) => { B[b.key] = i; });

// ==============================================================================================================
//  THE PIPELINE
// ==============================================================================================================
function buildWorld(opts) {
  const o = Object.assign({
    seed: 1234,
    n: 8192,                 // samples across the world
    dx: 64,                  // real columns per sample  (8192 * 64 = 524,288 ~ the Overworld's width)
    steps: 400,              // landscape-evolution iterations
    climateEvery: 10,        // recompute climate (and therefore rainfall) this often
    seaLevel: 0,             // elevation origin, in rows
    upliftMax: 4.0,          // rows per step at the strongest orogen
    erodeK: 0.0016,          // stream-power coefficient
    m: 0.5, nExp: 1.0,       // stream-power exponents  E = K * A^m * S^n
    talus: 46,               // max rows of drop per sample before material slides (a coarse angle of repose)
    talusPasses: 3,
    diffuse: 0.14,           // hillslope creep — the only process that acts on a flat, so it is what kills pits
    evapK: 0.9,              // evaporation per unit of lake surface — decides which basins are CLOSED
    // ⭐⭐ ON, 2026-08-10. It was off because switching it on moved three guard numbers; all three were
    // DIAGNOSED (`probe_latitude.js`) rather than tuned away, and only one of them was the world's fault.
    //   B2 standing water 0.0019% -> 0.1091%: **98% of it was ICE, and ice is a solid.** They are ice
    //     STALACTITES — `formations.js` draws dripstone as ice in a cold cave, so every tip hangs over air by
    //     construction. The guard was counting them because of one hard-coded exception, now deleted. Liquid
    //     itself barely moved (125 -> 113 cells).
    //   B3 inversions 1 -> 20: all 20 are quicksand resting on water in small voids. USER'S RULING: *"it's fine
    //     if the quicksand generates on top of water and has to sort and settle in this instance"*. The check
    //     moved its strength to the number of DISTINCT inversion pairs rather than simply loosening.
    //   C3 lava drain 0 -> 13: real, and NOT a scale effect — one volcano in one seed. Fixed separately.
    // ⚠️ Without it the world has NO TROPICS (0.9%); with it the five climate zones come out 8-12% each.
    // `buildWorld({ latitude: 0 })` still works and `preview_latitude.js` renders both.
    latitude: 1,
    // ⭐⭐ THE WORLD'S HEIGHT — 3.8, THE USER'S CHOICE OFF `out/height_sweep.png`, 2026-08-10.
    // At 1.0 the land topped out at 651 rows against 1,900 rows of sky above sea level: 35% of the space, with
    // the sky band (elevation ~548 to ~1,736, a hard interface — `server/domains.js` places sites in it)
    // starting just above the highest peak in the world. At 3.8 peaks reach 1,865 rows and 0.39% of land stands
    // ABOVE the sky band, so mountains rise past the floating islands rather than among them.
    // ⚠️ THE CEILING IS REAL AND ONE STEP AWAY: elevation 1,900 IS row 0, the top of the world, and nothing in
    // the pipeline clamps a peak or complains. 4.4 puts 22 samples outside the world entirely. `preview_height`
    // counts that now — do not raise this without reading its "OUT OF THE WORLD" line.
    peakScale: 3.8,
    // ⚠️ THE SHAPE DIAL STAYS AT 1 — the user's decision, taken from the render, and it is not a "not yet".
    // `peakSharp` sharpens peaks by lowering everything that is not a peak, and with the sea at a fixed level
    // that DROWNS THE PLAINS: median land 212 -> 83 rows at 1.5, and the continent breaks into ranges separated
    // by open water. It is an archipelago dial, not a mountain dial. See the note at its use site.
    peakSharp: 1,
    inciseMax: 190,          // rows of valley incision at the steepest — this is what makes LOCAL relief exist
  }, opts || {});
  const { n, dx, seed } = o;
  const out = { opts: o, n, dx };

  // ⭐⭐ THE WORLD IS A RING (periodicity, increment 2). `n * dx` is exactly one PERIOD_COLS, so sample `n` IS
  // sample 0 — the array has no ends, it has a join. `wn` is how every neighbour lookup says so.
  // 🟥 WHAT THIS REPLACES WAS NOT "NOTHING", IT WAS TWO INFINITELY HIGH WALLS. `routeFlow` handed the cells past
  // either end an elevation of `Infinity`, `fillDepressions` SEEDED its priority flood from index 0 and n-1,
  // hillslope creep skipped both end cells and the talus pass skipped the last pair. So the world had two
  // artificial ridges at its edges, and 200 steps of erosion propagated their influence inward. Removing them
  // is an improvement in its own right, not merely a compatibility fix — but it does mean the land moves
  // everywhere, which is why this increment re-baselines and wants a picture.
  const wn = (i) => (i % n + n) % n;
  // 🟥 A ONE-ARGUMENT `pf(K)` AND A WRAPPED-HASH `hw(salt, i)` USED TO SIT HERE, AND LEAVING THEM IN PLACE WHILE
  // THE MODULE-LEVEL `pf(n, K)` WAS ADDED DESTROYED THE WORLD SILENTLY. The local shadowed the module one, so
  // every converted call site — written as `pf(n, 1600)` — passed **n as the divisor**: `round(n / 8192) = 1`,
  // i.e. ONE lattice cell across the whole world, i.e. every coarse field a constant. The result was 8,192
  // samples of identical elevation, entirely below sea level: no land, no relief, no coast.
  // ⚠️ AND MY CHECK MISSED IT BECAUSE THE CHECK EVALUATED THE MODULE-LEVEL FUNCTION IN ISOLATION and reported
  // the field as correct to five decimal places. It was correct — it simply was not the function the world was
  // calling. Mistake #1 in its purest form: measure the thing that SHIPS, from where it ships.

  // ── STAGE 1: THE COARSE FIELDS ──────────────────────────────────────────────────────────────────────────────
  // Continentalness decides land vs sea. Uplift decides where mountains are ALLOWED to be — and it is RIDGED and
  // low-frequency on purpose, so orogeny comes in belts with plains between them, which is how the real thing is
  // arranged. Bumpy noise gives bumpy terrain everywhere; belts give you somewhere to be.
  const cont = new Float32Array(n), uplift = new Float32Array(n), lith = new Uint8Array(n);
  const CF = pf(n, 1600), UF = pf(n, 520);   // quantised: sample at .q, wrap at .p
  for (let i = 0; i < n; i++) {
    const c = fbm(seed, 11, i * CF.q, 4, 0, CF.p) * 2 - 1;
    cont[i] = c;
    // Belts: ridged noise gated so most of the world has none. Boosted where the coast is, because subduction
    // puts ranges along continental margins (the Andes, the Cascades) rather than in the middle.
    const belt = Math.pow(clamp((ridge(seed, 23, i * UF.q, 4, UF.p) - 0.42) / 0.58, 0, 1), 1.6);
    const margin = Math.exp(-Math.pow(c / 0.22, 2));           // near the coastline
    uplift[i] = belt * (0.55 + 0.75 * margin) * fbm(seed, 37, i * pf(n, 210).q, 3, 0, pf(n, 210).p);
  }
  // Lithology: basement/granite where uplift is high and old, sediments in the basins, limestone on shallow
  // shelves, evaporite in dry closed basins (which is decided later, so this is a first guess).
  // 🟥 THRESHOLDS ON AN ABSOLUTE UPLIFT VALUE GAVE 1% GRANITE, 1% BASALT AND 1% BASEMENT — i.e. the igneous
  // rocks did not exist, and with them went every feature that needs them (volcanoes, gorges, escarpments).
  // The uplift field is ridged and gated, so almost all of it sits near zero and a cut at "u > 0.55" catches
  // nothing. Cut at QUANTILES of the actual distribution instead, so the mix is a property of the design and
  // not of whatever range the noise happened to land in.
  const uSort = Float32Array.from(uplift); uSort.sort();
  const q = (p) => uSort[Math.min(n - 1, Math.floor(p * n))];
  const uHi = q(0.93), uMid = q(0.78), uLow = q(0.55);
  for (let i = 0; i < n; i++) {
    const u = uplift[i], c = cont[i], r = hwI(seed, 91, i >> 3, n);
    let v;
    if (u > uHi) v = r < 0.45 ? L.GRANITE : (r < 0.75 ? L.BASEMENT : L.BASALT);
    else if (u > uMid) v = r < 0.4 ? L.BASALT : (r < 0.72 ? L.GRANITE : L.SANDSTONE);
    else if (u > uLow) v = r < 0.35 ? L.GRANITE : (r < 0.7 ? L.SANDSTONE : L.SHALE);
    else if (c < -0.1) v = r < 0.55 ? L.LIMESTONE : L.SHALE;
    else v = r < 0.4 ? L.SANDSTONE : (r < 0.7 ? L.SHALE : L.LIMESTONE);
    lith[i] = v;
  }

  // ── the sea floor, and where the land is ────────────────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  //  ⭐⭐ THE SEA FLOOR — A REAL DEPTH PROFILE. (Ocean phase 1, 2026-08-09.)
  //
  //  🟥 WHAT THIS REPLACES WAS ONE RAMP AND A WOBBLE. Two lines: a linear slide from -150 to -360 rows and
  //  `fbm * 30` of texture applied at the SAME amplitude everywhere. So the ocean was 360 rows deep at its
  //  deepest — against +450 of land above it and the underworld 1,300 below — it had no shelf break, no slope,
  //  no plain, and its flattest place was exactly as bumpy as its steepest.
  //
  //  ⭐ THE REAL THING IS THREE ZONES AND THEY DIFFER IN TEXTURE AS MUCH AS IN DEPTH:
  //    SHELF     gentle, shallow, and the one part of the sea this pipeline already had content for (reefs).
  //    SLOPE     the drop. Steep, and the roughest ground in the ocean — this is where canyons cut.
  //    ABYSS     a PLAIN. Abyssal plains are the flattest surfaces on the planet, flatter than any desert,
  //              because they are sediment ponded on top of whatever the crust was doing. So its texture is a
  //              quarter of the shelf's rather than equal to it, which is most of what makes it read as a plain.
  //
  //  ⚠️ THE DEPTHS ARE BOUNDED BY A MEASUREMENT, not chosen: `bandAt` sampled over three seeds puts the
  //  underworld's ceiling at worst -920 elevation (p99 -1,000, median -1,240). Everything here stays well above
  //  that on purpose — see the trench block below, which is where the margin actually matters.
  //
  //  ⭐⭐ DEEPENED 2026-08-10, THE USER'S CALL FROM THE OVERWORLD PICTURES, AND THE MARGIN IS THEIR NUMBER.
  //  Measured before moving anything, over three seeds: deepest sea -618 / -643 / -749, highest underworld
  //  ceiling -972 / -942 / -942 — so the world-wide worst-case gap was 193 rows and the ocean was using little
  //  of what it had. The user's ruling: *"I want the ocean to go deeper, especially since the deepest point
  //  affects the general depth across the whole thing, and we can live with say ~100 rows between the underworld
  //  and the deepest point, especially since we intend to add the self plugging mechanisms later on."*
  //  ⭐ THE SHELF IS DELIBERATELY NOT DEEPENED. It is the one part of the sea with content in it — reefs,
  //  lagoons, the coast — and every one of those rules is about being NEAR THE SURFACE. Deepening it would move
  //  the coastline's character for nothing; the depth the user is asking for is the abyss and the trench.
  //  ⚠️ The margin is checked PER COLUMN, not against world-wide extremes: the deepest sea and the highest
  //  cavern roof are not at the same place, so comparing the two extremes is the conservative-but-wrong number.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  const SHELF_D = 130, ABYSS_D = 690, ABYSS_MAX = 770;
  const h = new Float32Array(n), isLand = new Uint8Array(n);
  for (let i = 0; i < n; i++) isLand[i] = cont[i] > 0.02 ? 1 : 0;

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  //  ⭐⭐ WHERE THE POLES GO — CHOSEN, NOT ROLLED. (User's decision, 2026-08-09.)
  //  Earth's two cold poles are not the same kind of place: one is an OCEAN ringed by land (the Arctic — pack
  //  ice, bergs, no ground) and the other is a CONTINENT (Antarctica — an ice sheet you can stand on). That
  //  contrast is most of what makes them interesting, and a random phase throws it away: half the time you get
  //  two ocean poles, which are largely the same place twice.
  //  ⚠️ THE TWO POLES ARE EXACTLY HALF A WORLD APART BY CONSTRUCTION — that is what a great circle through both
  //  of them means — so this is a search over ONE number, the phase, not over two positions.
  //  ⇒ score every candidate: the sea pole wants to be as far from land as possible (a real Arctic basin, not a
  //  puddle), the land pole simply wants to be land. Best score wins; if no phase gives one of each, fall back
  //  to the most oceanic pole available rather than failing — a world can legitimately be nearly all ocean.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const half = n >> 1;
    let bestK = 0, bestScore = -1e9;
    for (let k = 0; k < n; k += 4) {
      const a = k, b = (k + half) % n;
      // how oceanic is `a`? distance to the nearest land, capped so the search cannot run away
      let d = 0; while (d < 900 && !isLand[(a - d + n) % n] && !isLand[(a + d) % n]) d++;
      const seaPole = isLand[a] ? -1e6 : d;
      // ⚠️ `cont > 0.02` IS THE WRONG LAND TEST HERE and it put the land pole in the sea in 2 seeds of 4. That
      // threshold is the coastline as the COARSE FIELD sees it before erosion; a sample barely over it can end
      // up below sea level once the landscape is built. So the antipode is scored on HOW continental it is, not
      // on a boundary it is sitting on top of — which also naturally prefers an interior over a beach.
      const landPole = 700 * clamp((cont[b] - 0.06) / 0.22, 0, 1);
      const score = seaPole + landPole;
      if (score > bestScore) { bestScore = score; bestK = k; }
    }
    // `u` must be 0 at column bestK, and u = i/n + phase
    o.polePhase = ((-bestK / n) % 1 + 1) % 1;
    out.poles = { sea: bestK, land: (bestK + half) % n, oceanic: bestScore };
  }
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  //  ⭐⭐ THE POLAR CAP — ONE ARCTIC PER WORLD, PLACED, OUT IN THE OPEN OCEAN. (User's decision, 2026-08-09.)
  //
  //  🟥 WHAT THIS REPLACES: cold was a NOISE FIELD and nothing else, so "cold" happened wherever the noise dipped
  //  — scattered patches, anywhere, never very cold (averaged octaves do not swing, this track's most repeated
  //  finding). There was no arctic; there were cool bits.
  //
  //  ⚠️ THE ALTERNATIVE WAS "LATITUDE" AND IT IS THE BIGGER, WORSE CHANGE. Real temperature has a global
  //  positional gradient — one cosine over the ring would give a pole and an antipode, coherent and automatically
  //  periodic. But it restructures EVERY biome, flora niche and census in the world to solve a problem the user
  //  scoped much more tightly: one arctic, in the ocean.
  //  ⇒ so it is a PLACED RECORD, like a trench or a ridge, expressed as a **cold anomaly on `clim.temp`**.
  //  ⭐⭐ AND THAT IS THE WHOLE OF THE MECHANISM: because it modifies the temperature FIELD rather than adding a
  //  new one, every rule that already reads temperature responds for free — the pack ice, the bergs, the biome
  //  classification, the flora niches, the dressing's snow line. No new machinery anywhere, and nothing else in
  //  the pipeline needs to learn that a polar region exists.
  //
  //  ⚠️ SITED AT THE MOST OCEANIC POINT IN THE WORLD, found by measuring distance to the nearest land in both
  //  directions and keeping the maximum — so it lands in open water like the Arctic rather than on a coast, and
  //  it is guaranteed to exist rather than rolled for.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  // ⚠️ THE PLACED POLAR CAP IS SUPERSEDED BY LATITUDE and must not run beside it: the pole is already the
  // coldest place in the world, and a second anomaly on top of it would drive a hole in the temperature field
  // for no reason. Kept for the latitude-off path, which is still a supported comparison.
  let chill = () => {};
  if (!o.latitude) {
    let at = -1, far = -1;
    for (let i = 0; i < n; i += 4) {
      if (isLand[wn(i)]) continue;
      let d = 1; while (d < 1200 && !isLand[wn(i - d)] && !isLand[wn(i + d)]) d++;
      if (d > far) { far = d; at = i; }
    }
    if (at >= 0 && far > 60) {
      // the cap reaches most of the way to the surrounding coasts, but never onto them
      const half = Math.min(far - 20, 300 + Math.round(hwI(seed, 110, at, n) * 420));
      const drop = 0.42 + 0.16 * hwI(seed, 111, at, n);
      // ⚠️ smoothstep SQUARED in `chill` below: a linear falloff puts the ice edge at a visible straight ramp,
      // and what makes a polar region read as one is a broad cold CORE with a quick margin, not a cone.
      out.polarCap = { at, half, drop };
      // 🟥 THE ANOMALY IS APPLIED THROUGH A CHOKE POINT AND THAT IS NOT TIDINESS — IT IS A BUG I ALREADY MADE.
      // `computeClimate` is called THREE times in this function (inside the erosion loop, after it, and again
      // after `applyFeatures` moves the ground), and each one REPLACES `clim` wholesale. Applied once at what
      // looked like the end, the cap was silently overwritten by the third call and every sea temperature came
      // back exactly as before — the cap existed as a record and had no effect on the world at all.
      // ⇒ `chill` is called immediately after every one of them, so a fourth call site cannot forget it.
      chill = (cl2) => {
        for (let k = -half; k <= half; k++) {
          const i = wn(at + k);
          const t = 1 - Math.abs(k) / (half + 1);
          cl2.temp[i] = Math.max(0, cl2.temp[i] - drop * smooth(t) * smooth(t) * (1 + 0.6 * t));
        }
      };
    }
  }

  // 🟥🟥 THE ZONE BOUNDARIES ARE QUANTILES OF THE SEA'S OWN CONTINENTALNESS, NOT ABSOLUTE CUTS — and getting
  // that wrong is THE recurring mistake on this whole track, hit for the sixth time here.
  //
  //  fBm AVERAGES ITS OCTAVES, so it does not swing: `cont` measured over five seeds runs about -0.37..+0.66 in
  //  the widest of them, and in seed 42 the MINIMUM IN THE ENTIRE WORLD is -0.157. My first cut put the abyssal
  //  plain at `c < -0.30`, which is below the world's floor in two seeds of three — the tally read
  //  `notAbyss 1024 of 1024`, i.e. the deep ocean did not exist anywhere.
  //  ⭐ AND THE SAME WAS ALREADY TRUE OF THE CODE THIS REPLACES, which nobody had noticed: its deep branch was
  //  `c < -0.35 ? -360 + ... : lerp(-150, -4, ...)`. That branch fired in essentially NO seed, so the ocean's
  //  advertised 360-row floor was never reached and the real sea bottomed out around 150 rows. The number in the
  //  source was aspirational. This is mistake #6 exactly, and the file already records the answer to it one
  //  stage up, where lithology thresholds on absolute uplift gave "1% granite, 1% basalt" and were replaced by
  //  quantiles: cut at quantiles of the distribution that EXISTS, so the mix is a property of the design.
  // ⚠️ Which also means these boundaries survive increment 2 having moved every field in the world.
  const cs = [];
  for (let i = 0; i < n; i++) if (!isLand[i]) cs.push(cont[i]);
  cs.sort((a, b) => a - b);
  const cq = (p) => cs.length ? cs[Math.min(cs.length - 1, Math.floor(p * cs.length))] : 0;
  const C_ABY = cq(0.32), C_SHELF = cq(0.68), C_LOW = cs.length ? cs[0] : -1;
  out.bathy = { abyss: C_ABY, shelf: C_SHELF, low: C_LOW, seaSamples: cs.length };
  const span = (a, b) => Math.max(1e-4, a - b);
  for (let i = 0; i < n; i++) {
    if (isLand[i]) continue;
    const c = cont[i];
    let d, tex;
    if (c > C_SHELF) {                                 // ── the shelf: the shallowest third of the sea
      d = lerp(4, SHELF_D, clamp((0.02 - c) / span(0.02, C_SHELF), 0, 1)); tex = 15;
    } else if (c > C_ABY) {                            // ── the shelf break and the continental slope
      const t = clamp((C_SHELF - c) / span(C_SHELF, C_ABY), 0, 1);
      d = lerp(SHELF_D, ABYSS_D, smooth(t));
      // roughest in the MIDDLE of the slope and tapering to nothing at both ends, so it does not leave a step
      // where it meets the shelf or the plain. This is the ground a submarine canyon will be cut into.
      tex = 12 + 34 * (1 - Math.abs(2 * t - 1));
    } else {                                           // ── the abyssal plain
      d = lerp(ABYSS_D, ABYSS_MAX, clamp((C_ABY - c) / span(C_ABY, C_LOW), 0, 1)); tex = 7;
    }
    h[i] = -d + (fbm(seed, 55, i * pf(n, 40).q, 3, 0, pf(n, 40).p) - 0.5) * 2 * tex;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  //  🟥🟥 THE LAND PROFILE IS BUILT AT THE ANALYTIC STEADY STATE, NOT GROWN FROM NOISE. THIS IS THE ONE
  //  NON-OBVIOUS DECISION IN THE FILE AND IT COST A WHOLE FAILED RUN TO FIND.
  //
  //  The first version did the textbook thing: start from noise, apply uplift, erode, repeat. In 2-D that works
  //  — drainage self-organises because streams CAPTURE each other sideways. In 1-D there is no sideways, so
  //  nothing reorganises: the run came out 69.8% LAKE AT STEP ZERO and never recovered, because a surface built
  //  from noise is a chain of closed basins and (traced) incision at their rims ran 0.06 rows/step against
  //  1.2 rows/step of uplift. Stream power is proportional to SLOPE, so a gentle barrier is almost immune to
  //  the very process that is supposed to cut it. It inflated for 400 steps instead.
  //
  //  ⭐ So impose the answer instead of waiting for it. Steady state of the stream-power law is
  //        K·A^m·S^n = U     ⇒     S = (U / (K·A^m))^(1/n)
  //  and in 1-D that integrates directly: walk inland from each coast, accumulating drainage area, and lay down
  //  the slope the law demands. It is MONOTONE by construction, so there are no accidental lakes, and it is
  //  CONCAVE by construction — steep at the head, flat at the mouth — which is the single most recognisable
  //  signature of a real river valley and exactly what a side view shows.
  //
  //  ⚠️ Lakes then have to be PUT somewhere rather than being drainage failures, which is the right way round:
  //  a rift basin is a tectonic object, not an accident. See `graben` below.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  const divide = new Uint8Array(n), toCoast = new Int32Array(n), area = new Float32Array(n);
  const masses = [];
  for (let i = 0; i < n; i++) {
    if (!isLand[i] || (i > 0 && isLand[i - 1])) continue;
    let b = i; while (b < n - 1 && isLand[b + 1]) b++;
    masses.push([i, b]);
    i = b;
  }
  for (const [a, b] of masses) {
    const w = b - a + 1;
    // Divides go where the orogen is, because that is what a mountain range IS: the thing separating two
    // drainages. A landmass with no belt gets one in the middle, jittered.
    const div = [];
    for (let i = a + 2; i <= b - 2; i++)
      if (uplift[i] > 0.28 && uplift[i] >= uplift[i - 1] && uplift[i] > uplift[i + 1]) div.push(i);
    if (!div.length) div.push(a + Math.round(w * (0.3 + 0.4 * hwI(seed, 61, a, n))));
    // Each stretch of land runs from an outlet (a coast, or the midpoint saddle between two divides) up to a
    // divide. In 1-D that is the entire drainage topology — there is exactly one path out of every cell.
    const seg = [[a, div[0], -1]];                               // [outlet-ward end, divide end, direction to sea]
    for (let k = 0; k + 1 < div.length; k++) {
      const mid = (div[k] + div[k + 1]) >> 1;
      seg.push([div[k], mid, +1], [mid, div[k + 1], -1]);
    }
    seg.push([div[div.length - 1], b, +1]);
    for (const [s0, s1, dir] of seg) {
      // Walk from the outlet up to the divide. Drainage area at a cell is everything still upstream of it, so
      // it is largest at the outlet and falls to one at the crest — which is what makes the profile concave.
      const chain = [];
      for (let i = (dir > 0 ? s1 : s0); i >= s0 && i <= s1; i += (dir > 0 ? -1 : 1)) chain.push(i);
      let acc = 0;
      for (let k = 0; k < chain.length; k++) {
        const i = chain[k];
        const A = Math.max(1, chain.length - k);                 // cells still upstream
        // 🟥 ROUGHNESS IS APPLIED TO THE SLOPE, NEVER TO THE HEIGHT, and this is the second thing that cost a
        // run. Adding +-13 rows of noise to a profile that falls 0.3 rows per sample reverses the gradient
        // everywhere, and every reversal is a closed basin: it put 39% OF ALL LAND under a lake. Perturbing the
        // slope instead cannot reverse it as long as the factor stays positive, so the profile is monotone by
        // construction however rough it looks — and varying STEEPNESS (benches, steep reaches, flats) is a
        // better model of real long-profiles than varying height was anyway.
        const rough = 0.30 + 1.70 * fbm(seed, 55 + (i & 3), i * pf(n, 21).q, 4, 0, pf(n, 21).p);
        acc += rough * (uplift[i] * 0.9 + 0.10) / (LITH_K[lith[i]] * Math.pow(A, o.m));
        h[i] = acc; area[i] = A; toCoast[i] = k;
      }
    }
    for (const d of div) divide[d] = 1;
    // Normalise the landmass to a plausible height: strong orogens make high ranges, plains stay low.
    let peak = 0, ub = 0;
    for (let i = a; i <= b; i++) { if (h[i] > peak) peak = h[i]; if (uplift[i] > ub) ub = uplift[i]; }
    // ⚠️ The exponent was 1.15, which punished every landmass that was not a maximal orogen and flattened the
    // world to 291 rows of relief — 15% of the height available, so nothing read as a mountain and half the
    // feature catalogue (fjords, glaciers, canyons, escarpments) never met its relief contract.
    // ⭐⭐ `peakScale` IS THE WORLD'S HEIGHT DIAL, and the reason it exists is that NOTHING EVER SET THE CEILING.
    // The exponent above was moved to fix LOCAL RELIEF — whether a ridge reads as a ridge — and the `1500`
    // beside it is a leftover from when the complaint was "the world is flat", not "the world is short".
    // MEASURED at scale 1: land tops out at **668 rows** over five seeds, against **1,900 rows of sky above sea
    // level**, i.e. 35% of the space available, and the sky band (elevation ~548 to ~1,736) starts just above
    // the highest peak in the world. Nothing above sea level constrains it — the underworld ceiling and the
    // ocean floor are both below.
    // ⚠️ IT IS A SCALE, NOT A TARGET, deliberately: normalising each world to a requested peak would delete the
    // difference between a mountainous world and a gentle one, which is what `ub` (the landmass's strongest
    // uplift) is there to express. Measured peak by scale: 1.0 -> 668 · 1.5 -> ~1,000 · 2.1 -> ~1,400 ·
    // 2.6 -> ~1,750.
    const target = 90 + 1500 * (o.peakScale || 1) * Math.pow(ub, 0.75) * (0.6 + 0.55 * hwI(seed, 71, a, n));
    const k = peak > 0 ? target / peak : 0;
    // ⭐⭐ `peakSharp` IS THE SECOND DIAL, AND IT IS A DIFFERENT QUESTION FROM `peakScale`. Height alone is a
    // UNIFORM VERTICAL STRETCH: the world's silhouette is unchanged and only its amplitude moves, so a smooth
    // massif becomes a bigger smooth massif. Rendered at 2.6x the tallest thing in the world came out a broad
    // dome wider than a 2,880-column frame — enormous, and not a mountain.
    // ⭐ WHAT MAKES A PEAK IS WHERE THE RELIEF SITS, so this reshapes the profile between two FIXED ends: the
    // coast stays at 6 and the summit stays at `target`, and `u^sharp` pulls everything between them DOWN.
    // Above 1 that turns a dome into a plain with a range standing out of it — steeper flanks, narrower summit,
    // more lowland. Below 1 it would give plateaus and mesas, which is why it is a dial and not a constant.
    // ⚠️ THE TWO FIXED ENDS ARE THE WHOLE SAFETY OF IT. A plain gamma on the raw height would push interior land
    // below `seaLevel` and quietly DROWN it — the shape change would read as "the continents shrank", which is
    // not what anyone asked for. Normalising against this landmass's own floor makes the coastline invariant.
    const sharp = o.peakSharp || 1;
    if (sharp !== 1) {
      let lo = Infinity;
      for (let i = a; i <= b; i++) if (h[i] < lo) lo = h[i];
      const span = peak - lo;
      for (let i = a; i <= b; i++) {
        const u = span > 0 ? (h[i] - lo) / span : 0;
        h[i] = 6 + (target - 6) * Math.pow(u, sharp);
      }
    } else {
      for (let i = a; i <= b; i++) h[i] = h[i] * k + 6;
    }
  }
  // ⭐⭐ VALLEY INCISION — the transect crosses RIDGES AND VALLEYS, not one smooth ramp.
  // 🟥 Without this the profile is a monotone slope, and measured local relief over +-6 samples came to about
  // TWENTY ROWS — while the feature contracts asked for 180 to 420. Fjords, canyons, gorges, glaciers and
  // escarpments therefore never placed anywhere in any world, and the contracts were not wrong: the terrain
  // genuinely had no relief in it. I had written thresholds for a number I never measured.
  // ⭐ And the dips this cuts are not a problem to be avoided: a transect across a real range crosses valley
  // after valley, each with a river running ACROSS the view. They become closed basins in one dimension, and
  // the water balance above turns them into exactly that — river valleys where it is wet, dry basins where it
  // is not. The same idea pays twice.
  for (let i = 0; i < n; i++) {
    if (!isLand[i]) continue;
    const steep = Math.min(1, uplift[i] * 1.9 + 0.12);
    // ⚠️ AT ONE WAVELENGTH THIS IS A COMB. A fixed 7.5-sample spacing cut a notch every 7 samples across every
    // range in the world and read as machined teeth from any distance. Real valley spacing varies with the
    // size of the catchment, so the wavelength is itself modulated — and two octaves an octave apart give big
    // valleys with side valleys in them instead of one repeated tooth.
    const wob = 18 + 26 * fbm(seed, 131, i * pf(n, 340).q, 2, 0, pf(n, 340).p);
    const v1 = Math.pow(1 - Math.abs(2 * vn(seed, 121, i / wob) - 1), 1.9);
    const v2 = Math.pow(1 - Math.abs(2 * vn(seed, 122, i / (wob * 0.34)) - 1), 2.2);
    // ⚠️ SCALED WITH THE HEIGHT, or the tall worlds come out SMOOTH. 190 rows of incision cuts a real valley
    // into a 668-row range and is a scratch on a 1,750-row one — the valleys would stop reading as valleys at
    // exactly the scale where they matter most. Incision is a proportion of the relief that exists, so it
    // travels with `peakScale` rather than being a second dial nobody remembers to move.
    // 🟥 A BASE-LEVEL CLAMP WAS TRIED HERE AND REVERTED — recorded because the reasoning was good and the
    // measurement refused it twice over. `peakSharp` drowns the land (median land 212 -> 44 rows at sharp 2.0),
    // and the obvious culprit was this line: incision scales with `peakScale`, reaching 608 rows at scale 3.2,
    // while sharpening lowers everything between the coast and the summit. "A river erodes towards base level
    // and stops there" is a real principle and limiting the cut to `h - seaLevel` is what it means.
    // 🟥 IT MADE THE DROWNING WORSE, not better — median land 44 -> 4 — because the statistic changed meaning
    // under it: columns that used to drown and be EXCLUDED from the land median now survive at elevation ~4 and
    // are counted. The number moved for a reason that had nothing to do with the mechanism.
    // 🟥 AND IT WOULD DELETE FJORDS. A valley incised below sea level and flooded is precisely how one forms,
    // and `fjord` is in the landform catalogue. A clamp that forbids it is not a fix.
    // ⇒ the drowning is `u^sharp` itself: most of a landmass's samples sit well below u = 0.5 because the
    // eroded profile is concave, so squaring crushes them to sea level. That is what the dial DOES, and the
    // answer is its range (~1.5 is usable, 2.0+ is a world of plains with spikes), not a clamp somewhere else.
    h[i] -= (v1 * 0.78 + v2 * 0.22) * steep * o.inciseMax * (o.peakScale || 1);
  }
  // ⭐ RIFT BASINS, placed rather than emergent. Real closed basins are tectonic (Baikal, the Dead Sea, the
  // Great Basin), and making them a placed object means their NUMBER is a dial instead of a symptom.
  const GRABEN_EVERY = 900;
  for (let g = GRABEN_EVERY; g < n; g += GRABEN_EVERY) {
    const at = g + Math.round((hwI(seed, 83, g, n) - 0.5) * GRABEN_EVERY * 0.7);
    if (at < 4 || at > n - 5 || !isLand[at]) continue;
    if (hwI(seed, 84, g, n) > 0.6) continue;
    const half = 6 + Math.round(hwI(seed, 85, g, n) * 26);
    const depth = 60 + hwI(seed, 86, g, n) * 220;
    for (let i = Math.max(0, at - half); i <= Math.min(n - 1, at + half); i++) {
      const t = 1 - Math.abs(i - at) / (half + 1);
      h[i] -= depth * t * t * (3 - 2 * t);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  //  ⭐⭐ OCEAN TRENCHES — the deepest places in the world, and placed by the geology that makes them.
  //
  //  A trench is not "a deep bit of sea". It is the SUBDUCTION HINGE: the line where one plate bends under
  //  another, which is why every real one has a mountain arc immediately behind it (the Andes behind the
  //  Peru-Chile trench, Japan behind its own). This pipeline already computes `uplift` and already boosts it at
  //  continental margins for exactly that reason — so the siting rule is "abyssal floor with a strong uplift
  //  belt landward of it", and the trench comes out parallel to a coast with mountains behind it without anyone
  //  saying so. Same argument as the rift basins above: placed, so the NUMBER is a dial rather than a symptom.
  //
  //  ⚠️ ASYMMETRIC, because a trench is. The INNER (landward) wall is the steep one — it is the overriding
  //  plate's edge being scraped — and the outer side rises gently over an outer swell. A symmetric V reads as a
  //  canyon, which is a different landform this catalogue will place separately.
  //
  //  🟥 THE DEPTH IS A SAFETY BUDGET AS WELL AS A LOOK, AND IT IS THE USER'S CALL: the underworld's ceiling
  //  reaches -920 at worst (measured, three seeds). A trench that meets it is a hole the SEA POURS INTO, which
  //  is a hydrology problem and not just a view. `TRENCH_FLOOR` is held 120 rows clear of the worst case ever
  //  observed and ~440 clear of the typical one — deep, deliberately not close.
  // ⚠️ A WHY-TALLY, like `layoutFeatures` has and for the same reason: this is a conjunction of four clauses and
  // any one of them can kill every site in the world. The first version placed trenches in ONE seed of three,
  // and without this the only options are to loosen all four and hope. Counted, it was a single clause.
  // ⭐ THE SEA-FLOOR FEATURES LEAVE RECORDS. The placement loops modify `h` in place and used to keep nothing,
  // which was fine while nothing else needed to know where they were — and stopped being fine the moment the
  // vent fields wanted a ridge axis to sit on. A record is `{kind, at, half}` in SAMPLES; anything wanting
  // columns multiplies by `dx`, exactly as the volcano and cliff records already do.
  const oceanFeatures = out.oceanFeatures = [];
  const trenchWhy = out.trenchWhy = { sited: 0, notAbyss: 0, noContinent: 0, noArc: 0, tooClose: 0, notFoot: 0 };
  // ⚠️ -800 → -845, 2026-08-10, and the number comes from the user's stated tolerance rather than from taste:
  // ~100 rows of rock between the deepest water in the world and the roof of the underworld. The highest
  // underworld ceiling measured over three seeds is -942, so -845 leaves 97 at the world-wide worst case and
  // more everywhere else. ⭐ Their reason for accepting a thinner floor than the old 120 is that the SELF-SEALING
  // LEAK mechanism is coming (a liquid forced through a narrow gap deposits clay), so a breach stops being
  // permanent — see the "SELF-SEALING LEAKS" section of `kickoff_port.md`. Until that ships this is the number
  // holding the ocean out of the underworld, so do not lower it further on a whim.
  const TRENCH_FLOOR = -845;
  // ⚠️ 260 → 460, AND THE REASON IS A SCALE, NOT A TASTE. With the zones at quantiles the shelf is ~1,900
  // samples over ~10 coasts and the slope ~600, so the nearest land is 200-260 samples from the FOOT of the
  // slope and much further from the middle of the plain. At 260 the tally read `noContinent` for every abyssal
  // candidate in seed 1234. ⭐ And the trench belongs at that foot anyway — a subduction trench IS the margin,
  // not a feature of the open ocean — so `nearSlope` states the real siting rule and the reach only has to be
  // generous enough to find the arc behind it.
  const TRENCH_REACH = 460;                           // how far landward the arc may be, in samples
  const TRENCH_FOOT = 90;                             // ...and how far from the foot of the slope it may sit
  const TRENCH_APART = 260;                           // minimum separation between two trenches
  const TRENCH_MAX = 10;                               // they are supposed to be rare
  // 🟥 THE FIRST VERSION PUT THE CANDIDATES ON A FIXED LATTICE — 8 points a thousand samples apart — AND THE
  // TALLY SAID `notAbyss` KILLED 6 TO 8 OF THEM IN EVERY SEED. Not a threshold problem: a sparse lattice of
  // fixed points simply does not land on the abyssal floor often enough, and no amount of loosening the other
  // three clauses would have helped. ⚠️ I had written a confident comment blaming the continent reach BEFORE
  // measuring, and it was wrong — the tally exists precisely because this file's own note says a conjunction
  // can be killed by any one clause and guessing which is how you loosen the wrong one.
  // ⇒ SCAN FOR THE SITE, exactly as `prepareCaves` finds its soluble stretches: walk the floor, test the
  // geology, and let the lattice enforce SEPARATION rather than position.
  // ⭐⭐ THE TRENCH GUARANTEE, and the shape of every guarantee added on 2026-08-10. There will be ONE world, so
  // a feature that places nowhere in it does not exist at all. The carve is factored out and called from TWO
  // places — the natural scan, and the forced fallback — because the recorded lesson on this track is that the
  // same rule written twice produces two answers that disagree. A forced trench is bit-identical in shape to a
  // natural one; the only difference is which site it was handed.
  // 🟥 IT OVERRIDES THE DICE AND THE SEPARATION, NOT THE GEOLOGY. A "subduction trench" that places anywhere is
  // a ditch. So the forced site is the world's BEST REFUSED CANDIDATE — the abyssal site that came nearest to
  // being a real margin, scored on the same three clauses that refused it — and not simply the first hole going.
  // The user's decision, in their words: a world with no subduction margin gets one anyway, and that is the cost.
  // ⭐⭐ ONE OCCUPANCY RECORD FOR THE WHOLE SEA FLOOR — the `taken` array `layoutFeatures` has had all along, which
  // the ocean never got. Each seabed loop enforced separation WITHIN its own kind and nothing enforced it
  // BETWEEN kinds, so the three loops carved over each other in sequence.
  // 🟥 MEASURED, AFTER A WRONG READ. Trenches were finishing up to 247 rows shallower than they were carved, and
  // reading the code said the unguarded talus pass (the one erosion pass with no sea-level test) was shovelling
  // material in. It is not: guarding it moved the mean loss 91 -> 88 rows. What actually does it is that EVERY
  // badly-infilled trench has a ridge or a seamount sitting on top of it — three of them at distance ZERO — and
  // a seamount adds up to 560 rows of cone. It is also nonsense geology, by this file's own argument: a trench is
  // where plates CONVERGE and a ridge is where they SPREAD, and their gates were not mutually exclusive (land
  // 300-460 samples away satisfies "no land within 300" AND "a continent within 460").
  // ⚠️ Wrap-aware, because the world is a ring and a feature near sample 0 is next to one near sample n-1.
  const claims = [];
  const claimFree = (at, half, margin) => {
    for (const c of claims) {
      let d = Math.abs(at - c.at); if (d > n / 2) d = n - d;
      if (d < half + c.half + (margin || 0)) return false;
    }
    return true;
  };
  const claim = (at, half) => claims.push({ at, half });
  let lastTr = -1e9;
  let bestRefused = null;
  const brineCands = [];
  const carveTrench = (at, dir, forced) => {
    trenchWhy.sited++; if (forced) trenchWhy.forced = (trenchWhy.forced || 0) + 1;
    const g = at;
    const floor = TRENCH_FLOOR + hwI(seed, 88, g, n) * 90;       // -800 .. -710
    const inner = 3 + Math.round(hwI(seed, 89, g, n) * 4);       // the steep landward wall, in samples
    const outer = inner + 5 + Math.round(hwI(seed, 90, g, n) * 12);
    // the trench claims its ground first, so nothing carved later can fill it in
    claim(at, outer);
    for (let k = -outer; k <= outer; k++) {
      const i = wn(at + k);
      if (isLand[i]) continue;
      // one profile, read with the steep half on the landward side
      const half = (k * dir < 0) ? inner : outer;                // k*dir<0 is the landward side
      const t = 1 - Math.min(1, Math.abs(k) / (half + 0.5));
      if (t <= 0) continue;
      const want = lerp(h[i], floor, Math.pow(t, 1.5));
      if (want < h[i]) h[i] = want;
      // the OUTER SWELL: the plate bulges up before it bends down, so the seaward rim stands slightly proud.
      if (k * dir > outer * 0.6) h[i] += 18 * (1 - t);
    }
    // ⭐⭐ A BRINE POOL — A LAKE UNDER THE SEA, and the reason it is here rather than scattered on the sea bed
    // is the user's call: place it at a named seabed feature, not by hunting for hollows. A trench floor is the
    // right host and a real one — brine ponds where salt is squeezed out of the sediment pile at a subducting
    // margin, and the trench axis is the deepest, quietest water in the world.
    // ⭐⭐ AND IT IS SETTLED BY CONSTRUCTION, WHICH IS WHY IT COSTS NOTHING. The pool is the bottom `dep` rows
    // of the trench's own V: the walls that contain it are the trench, so no containment test is needed and
    // none can disagree with the shape. There is no AIR anywhere near it — it is under the whole ocean — so the
    // "would this cell move" rule cannot fire on it, and brine (rank 2) under water (rank 4) is the RIGHT way
    // round, so the inversion rule cannot either. That is the whole reason to put it here.
    // ⚠️ The LEVEL is an elevation, so its surface is exactly flat and its shoreline is exactly where the
    // trench wall crosses the line — the same argument the sea, the lakes and the crater lake all make.
    // ⚠️ Not every trench: a brine pool needs a salty sediment pile, so it is a roll, not a guarantee.
    // 🟥 THE LEVEL IS READ OFF THE GROUND THAT WAS ACTUALLY CARVED, NOT OFF THE NOMINAL `floor`. The first
    // version used `floor + 14..40` and seed 555's pool came out with a record and ZERO CELLS — the trench
    // there never reached its nominal floor (its profile is clipped by land and by the `want < h[i]` guard), so
    // the brine level sat above the sea bed and there was no water below it to replace. That is this track's
    // recurring shape: a threshold against a quantity nobody measured, and a placed record that silently
    // produces nothing. Read from `h` immediately after the carve, it cannot disagree with the trench.
    let bhalf = Math.max(2, inner - 1), lo = 1e9;
    for (let k = -bhalf; k <= bhalf; k++) { const i = wn(at + k); if (isLand[i]) continue; if (h[i] < lo) lo = h[i]; }
    const level = lo + 12 + Math.round(hwI(seed, 92, g, n) * 26);
    // ⚠️ AND IT MUST BE CONTAINED, checked against the trench's own walls one sample outside the pool. Without
    // this a pool in a trench whose wall is lower than the brine level would spill along the sea bed — invisible
    // in a census (it is all under water either way) and wrong.
    const wallL = h[wn(at - bhalf - 1)], wallR = h[wn(at + bhalf + 1)];
    const held = lo < 1e8 && wallL > level && wallR > level;
    const brine = (held && hwI(seed, 91, g, n) < 0.62)
      ? { kind: 'brinepool', at, half: bhalf, level }
      : null;
    oceanFeatures.push({ kind: 'trench', at, half: outer, floor, forced: !!forced });
    if (brine) oceanFeatures.push(brine);
    // ⭐ EVERY trench remembers what its brine pool WOULD have been, so the guarantee below can force the
    // best-contained one without re-deriving the trench's shape from a `h` that later trenches have edited.
    else if (lo < 1e8) brineCands.push({ at, bhalf, lo, level, wall: Math.min(wallL, wallR) });
  };

  for (let at = 0; at < n; at += 8) {
    if (trenchWhy.sited >= TRENCH_MAX) break;
    if (isLand[wn(at)] || cont[wn(at)] > C_ABY) { trenchWhy.notAbyss++; continue; }    // on the abyssal floor
    // ⚠️ THE ARC HAS TO BE ON ONE SIDE, NOT NEARBY. Asking "is there uplift within N samples" would fire in the
    // middle of an ocean between two continents and put a trench with no plate to subduct under. Landward is
    // whichever side the continent is, so the side is DERIVED (from continentalness) rather than drawn.
    // ⚠️ Hoisted above the refusals so that a REFUSED site still knows how nearly it qualified — that is the
    // number the guarantee ranks on. Same cost either way; the scan was always going to run for the survivors.
    let uL = 0, uR = 0, cL = 0, cR = 0;
    for (let k = 6; k <= TRENCH_REACH; k++) {
      uL = Math.max(uL, uplift[wn(at - k)]); cL = Math.max(cL, cont[wn(at - k)]);
      uR = Math.max(uR, uplift[wn(at + k)]); cR = Math.max(cR, cont[wn(at + k)]);
    }
    const dir = (cL > cR) ? -1 : 1;                              // -1 = the land is to the left
    // the FOOT of the slope: abyssal floor with the slope still within reach on one side
    let foot = 0;
    for (let k = 1; k <= TRENCH_FOOT && !foot; k++)
      if (cont[wn(at - k)] > C_ABY || cont[wn(at + k)] > C_ABY) foot = 1;
    const arc = dir < 0 ? uL : uR, contMax = Math.max(cL, cR);
    // how nearly is this a subduction margin? Each clause contributes what fraction of itself it met, so the
    // best refused site is the one that fails by least across all three rather than the one that fails one.
    const near = (foot ? 1 : 0) + Math.min(1, contMax / 0.02) + Math.min(1, arc / 0.18);
    if (!bestRefused || near > bestRefused.near) bestRefused = { at, dir, near };
    if (at - lastTr < TRENCH_APART) { trenchWhy.tooClose++; continue; }
    if (!foot) { trenchWhy.notFoot++; continue; }
    if (contMax < 0.02) { trenchWhy.noContinent++; continue; }   // no continent: nothing to subduct under
    if (arc < 0.18) { trenchWhy.noArc++; continue; }             // no arc behind it: not a trench
    carveTrench(at, dir, false);
    lastTr = at;
  }
  if (!trenchWhy.sited && bestRefused) carveTrench(bestRefused.at, bestRefused.dir, true);
  // ⭐ THE BRINE POOL'S PREREQUISITE IS THE TRENCH, which is why this sits directly under it: the user's decision
  // was to guarantee the prerequisite too, and a brine pool cannot be forced into a world with no trench in it.
  // With a trench guaranteed above, a brine pool is now always possible, so here it is only the DICE to override.
  if (!oceanFeatures.some(f => f.kind === 'brinepool') && brineCands.length) {
    // the best-contained candidate: the most freeboard between the brine surface and the lowest trench wall
    let best = null;
    for (const c of brineCands) if (!best || c.wall - c.level > best.wall - best.level) best = c;
    // 🟥 IF EVEN THE BEST ONE SPILLS, LOWER THE SURFACE UNTIL IT DOES NOT — do not push a record anyway. A placed
    // record that produces no cells has happened twice on this track (a brine pool whose level sat above the sea
    // bed; a descent carved perfectly and connected to nothing), and it is invisible in every census.
    let level = best.level;
    if (best.wall <= level) level = best.wall - 2;
    if (level > best.lo) {
      oceanFeatures.push({ kind: 'brinepool', at: best.at, half: best.bhalf, level, forced: true });
      trenchWhy.brineForced = 1;
    } else trenchWhy.brineImpossible = 1;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  //  ⭐⭐ THE REST OF THE UNDERWATER CATALOGUE (ocean phase 2). Three landforms, each one contract and one shape,
  //  which is what the land's catalogue costs — the return on having built the placement mechanism first.
  //  ⚠️ DELIBERATELY SMALL. The land has thirty entries; the sea gets four, on the user's judgement that it will
  //  see less traffic. The point is that the ocean stops being ONE thing, not that it competes with the land.
  //  ⚠️ Every one of them carries a why-tally from the first line, because the trench cost three corrective
  //  attempts for want of one. A conjunction of clauses can be killed by any single clause and guessing which is
  //  how you loosen the wrong four.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  const oceanWhy = out.oceanWhy = {
    ridge: { sited: 0, notAbyss: 0, tooNearLand: 0, tooClose: 0, onFeature: 0 },
    seamount: { sited: 0, notSea: 0, tooShallow: 0, dice: 0, tooClose: 0, guyots: 0, onFeature: 0 },
    canyon: { sited: 0, notSlope: 0, dice: 0, tooClose: 0, headless: 0 },
  };

  // ── MID-OCEAN RIDGE ────────────────────────────────────────────────────────────────────────────────────────
  // ⭐ The opposite gate to the trench, and that is the whole of its geology: a trench is where plates CONVERGE
  // (so it needs a continent behind it), a ridge is where they SPREAD (so it belongs in open ocean, far from
  // any). Two features from one field read with the sign flipped.
  // ⚠️ THE CENTRAL RIFT IS THE POINT. A ridge without one is just a rise, and a rise in the abyssal plain is
  // indistinguishable from the plain's own relief. The axial valley — a notch cut into the crest of the swell —
  // is what makes it READ as a spreading centre, and it is also the interesting place to be.
  {
    const W_ = oceanWhy.ridge;
    let last = -1e9;
    for (let at = 0; at < n; at += 8) {
      if (W_.sited >= 5) break;
      if (isLand[wn(at)] || cont[wn(at)] > C_ABY) { W_.notAbyss++; continue; }
      // ⚠️ RAISING THE CAP DID NOTHING AND THE TALLY SAID WHY: `sited` never approached it — `tooClose` and the
      // supply of abyssal floor were binding. Separation is the honest dial here because it does not change what
      // a ridge MEANS, where loosening 'no land within 300' would (a spreading centre is defined by being far
      // from a continent). 1000 -> 420 samples.
      if (at - last < 420) { W_.tooClose++; continue; }
      let near = 0;
      for (let k = 1; k <= 300 && !near; k++) if (isLand[wn(at - k)] || isLand[wn(at + k)]) near = 1;
      if (near) { W_.tooNearLand++; continue; }
      const half = 60 + Math.round(hwI(seed, 92, at, n) * 80);
      // ⚠️ A SPREADING CENTRE CANNOT SIT ON A SUBDUCTION TRENCH. Three of five worlds had one carved exactly on
      // top of one — same sample, distance 0 — because "no land within 300" and the trench's "a continent within
      // 460" are both true of a margin 300-460 samples out.
      if (!claimFree(at, half, 8)) { W_.onFeature++; continue; }
      const rise = 190 + hwI(seed, 93, at, n) * 130;
      const rHalf = 3 + Math.round(hwI(seed, 94, at, n) * 6);          // the axial valley
      const rDeep = 90 + hwI(seed, 95, at, n) * 70;
      for (let k = -half; k <= half; k++) {
        const i = wn(at + k);
        if (isLand[i]) continue;
        const t = 1 - Math.abs(k) / (half + 1);
        h[i] += rise * smooth(t) * smooth(t);                          // a broad swell, flat-shouldered
        if (Math.abs(k) <= rHalf) h[i] -= rDeep * (1 - Math.abs(k) / (rHalf + 1));
      }
      oceanFeatures.push({ kind: 'ridge', at, half, rift: rHalf });
      claim(at, half);
      W_.sited++; last = at;
    }
  }

  // ── SEAMOUNTS AND GUYOTS ───────────────────────────────────────────────────────────────────────────────────
  // ⭐ AND THE GUYOT COMES FREE FROM THE RULE THAT MAKES ONE. A seamount is a volcanic cone on the sea floor; a
  // GUYOT is one that grew past the surface, had its top planed off by the waves, and then subsided. So the rule
  // is not two landforms — it is one cone plus "anything above wave base is cut off", which is literally the
  // process. The flat top is the evidence that it was once an island.
  {
    const W_ = oceanWhy.seamount;
    const WAVE = -14;                                   // wave base: where the sea planes a summit flat
    let last = -1e9;
    // ⭐⭐ COLLECT, THEN DECIDE, THEN CARVE — and the split is forced by the atoll guarantee rather than chosen.
    // An atoll's ring only draws where it rises ABOVE the existing ground, so once a guyot's cone is carved its
    // summit already fills that space and a ring added afterwards writes nothing at all. (That is this track's
    // "a placed record that produces no cells", which has bitten twice; here it was predictable, so the code is
    // arranged so it cannot happen rather than checked for afterwards.) So the atoll decision has to be made
    // before any carving, which means knowing every guyot in the world first.
    // ⚠️ Safe to read `h` in a collect pass: seamounts are ≥110 samples apart and at most 32 wide, so no two
    // ever overlap and no seamount can change the ground another one is sited on.
    const sites = [];
    for (let at = 0; at < n; at += 6) {
      if (sites.length >= 26) break;
      if (isLand[wn(at)] || cont[wn(at)] > C_SHELF) { W_.notSea++; continue; }
      if (h[wn(at)] > -SHELF_D) { W_.tooShallow++; continue; }         // they belong off the shelf
      if (at - last < 110) { W_.tooClose++; continue; }
      if (hwI(seed, 96, at, n) > 0.30) { W_.dice++; continue; }
      const half = 8 + Math.round(hwI(seed, 97, at, n) * 24);
      // ⚠️ NOR A VOLCANIC CONE IN A TRENCH. A seamount adds up to 560 rows, so one carved 4 samples off a trench
      // axis simply fills the trench in — which is what was happening in two of five worlds.
      if (!claimFree(at, half, 4)) { W_.onFeature++; continue; }
      const peak = h[wn(at)] + 240 + hwI(seed, 98, at, n) * 320;
      const guyot = peak > WAVE;
      const top = guyot ? WAVE - hwI(seed, 99, at, n) * 40 : peak;     // planed flat, then subsided a little
      sites.push({ at, half, peak, guyot, top, pole: poleness(wn(at), n, o) });
      claim(at, half);
      last = at;
    }
    // the atoll gate, unchanged, applied to the collected sites
    for (const s of sites) s.atoll = s.guyot && s.top > -40 && s.pole < 0.38;
    // ⭐ THE GUARANTEE: if the dice gave this world no atoll, the best guyot becomes one. It overrides the two
    // GATES (shallow enough for coral, tropical enough for coral) and nothing about what an atoll IS — the ring
    // is still a reef ring on a subsided flat-topped volcano. Picking the shallowest, most tropical guyot makes
    // the forced one the least compromised the world can offer. ⚠️ A cold-sea atoll gets the SHAPE without the
    // coral, because the cell pass gates the coral on the real temperature separately — that two-gate design was
    // deliberate and it is what makes forcing this safe.
    if (!sites.some(s => s.atoll)) {
      let best = null, bestSc = -1;
      for (const s of sites) {
        if (!s.guyot) continue;
        const sc = (s.top + 54) / 40 + (1 - Math.min(1, s.pole / 0.38));   // shallowness + tropicality
        if (sc > bestSc) { bestSc = sc; best = s; }
      }
      if (best) { best.atoll = true; best.forced = true; W_.atollForced = 1; }
      else W_.atollImpossible = 1;                                          // no guyot in the world at all
    }
    for (const S of sites) {
      const { at, half, peak, guyot, top, atoll } = S;
      // ⭐⭐ AN ATOLL IS A GUYOT WHOSE RIM KEPT GROWING, which is exactly how one forms: the volcano subsides,
      // and reef growing at its rim keeps pace with the sinking while the middle cannot, leaving a ring of reef
      // round a lagoon. So it is not a fourth landform — it is the guyot rule plus "the rim grew back up".
      // ⚠️ TROPICAL ONLY, AND DECIDED FROM LATITUDE RATHER THAN FROM TEMPERATURE, because this loop runs in
      // stage 1 and the climate does not exist until stage 4. `poleness` is positional and available here, and
      // it is the right control anyway — atolls are a tropical fact. ⭐ The cell pass ALSO gates the coral on
      // the real `ci.temp`, so a world where latitude is off (and poleness therefore does not predict warmth)
      // gets the shape without the coral rather than a reef in a cold sea. Two gates, deliberately.
      // ⚠️ Only the SHALLOW guyots: coral needs light, so a summit planed to -40 gets no reef.
      // ⚠️ MEASURED AND WIDENED ONCE: `top > -34 && poleness < 0.30` gave 1 atoll in two worlds of five and NONE
      // in the other three, which is absent rather than rare. The tally says why — the two clauses are roughly
      // independent and each halves the guyots, so 0.15 x guyots survive. Widened to a subtropical band, which
      // is truer as well: poleness 0.30 is about 27 degrees, and Bermuda's reefs are at 32.
      // (`atoll` is now decided above, before any carving — see the collect/decide/carve note.)
      // the ring's radii and its two levels, drawn ONCE PER ATOLL off the record's own column, so every column
      // of one atoll agrees about it (mistake #3 — a thing must be the same from every column it touches)
      const rimIn = 0.36 + hwI(seed, 111, at, n) * 0.12;
      const rimOut = 0.70 + hwI(seed, 112, at, n) * 0.16;
      const rimE = -2 - hwI(seed, 114, at, n) * 7;                     // the crest, awash at low water
      const lagE = rimE - 13 - hwI(seed, 115, at, n) * 17;             // a shallow lagoon, not a pit
      for (let k = -half; k <= half; k++) {
        const i = wn(at + k);
        const u = Math.abs(k) / (half + 1), t = 1 - u;
        // ⚠️ a cone, not a bell: the sides are straight-ish (a volcanic slope is an angle of repose) and only
        // the summit is rounded. `pow(t, 0.72)` reads as a cone; `smooth(t)` reads as a blister.
        const want = lerp(h[i], top, Math.pow(t, 0.72));
        if (want <= h[i]) continue;
        if (atoll && u < 0.84) {
          // ⚠️ ROUGHENED, or the ring is an analytic shape and reads as maths — mistake #5, which has cost this
          // track six features. The wobble is per SAMPLE so the ring is ragged rather than a drawn annulus.
          const u2 = u + (hwI(seed, 113, at + k, n) - 0.5) * 0.11;
          h[i] = u2 < rimIn ? lagE : (u2 < rimOut ? rimE : top);
        } else h[i] = Math.min(want, guyot ? top : 1e9);
      }
      // ⚠️ `kind` stays 'guyot' and the atoll is a FLAG on the record, so everything already reading guyots —
      // the vent hosts, the previewers, the density census — keeps working unchanged.
      oceanFeatures.push({ kind: guyot ? 'guyot' : 'seamount', at, half, atoll, top, forced: !!S.forced });
      W_.sited++; if (guyot) W_.guyots++; if (atoll) W_.atolls = (W_.atolls || 0) + 1;
    }
  }

  // ── STAGE 2+3: EROSION, DRAINAGE AND LAKES, COUPLED ─────────────────────────────────────────────────────────
  const fill = new Float32Array(n), flux = new Float32Array(n), down = new Int32Array(n);
  const rain = new Float32Array(n).fill(1);
  const order = new Int32Array(n);
  let clim = null;

  // Priority-Flood + epsilon: raise every closed depression to its outlet level, leaving a slight gradient so
  // that even a filled lake has a well-defined direction of flow.
  const EPS = 1e-4;
  function fillDepressions() {
    const seen = new Uint8Array(n), heap = new Heap();
    // 🟥 THE SEEDS USED TO INCLUDE INDEX 0 AND n-1, AND ON A RING THOSE DO NOT EXIST. The outlets of a world
    // that wraps are its SEAS and nothing else. ⚠️ Which raises the one real hazard in making this a ring: a
    // world with no cell at or below sea level would seed NOTHING, the heap would never start, `fill` would stay
    // all-zero, every column would read as a depression and the whole world would become one lake. Unlikely over
    // 8,192 samples and catastrophic when it happens, so it is answered rather than hoped about: with no sea, an
    // endorheic world drains to its own lowest point.
    let seeded = 0;
    for (let i = 0; i < n; i++) {
      if (h[i] <= o.seaLevel) { fill[i] = Math.max(h[i], o.seaLevel); seen[i] = 1; heap.push(fill[i], i); seeded++; }
    }
    if (!seeded) {
      let lo = 0; for (let i = 1; i < n; i++) if (h[i] < h[lo]) lo = i;
      fill[lo] = h[lo]; seen[lo] = 1; heap.push(fill[lo], lo);
    }
    while (heap.size) {
      const i = heap.pop();
      for (const j of [wn(i - 1), wn(i + 1)]) {
        if (seen[j]) continue;
        seen[j] = 1;
        fill[j] = Math.max(h[j], fill[i] + EPS);
        heap.push(fill[j], j);
      }
    }
  }
  function routeFlow() {
    for (let i = 0; i < n; i++) order[i] = i;
    // ⚠️ Sorted by the FILLED surface, not the raw one: on the raw surface a lake bottom has no downhill
    // neighbour at all and the accumulation silently stops there, which reads as "rivers vanish inland".
    const f = fill;
    order.sort((a, b) => f[b] - f[a]);
    for (let i = 0; i < n; i++) {
      // ⚠️ The `Infinity` sentinels are gone with the walls — on a ring both neighbours always exist.
      const li = wn(i - 1), ri = wn(i + 1);
      down[i] = (fill[li] <= fill[ri]) ? li : ri;
      if (fill[i] <= o.seaLevel) down[i] = -1;                  // the sea is the end of the line
      flux[i] = rain[i];
    }
    for (let k = 0; k < n; k++) {
      const i = order[k], d = down[i];
      if (d >= 0 && fill[d] < fill[i]) flux[d] += flux[i];
    }
  }

  // ⚠️ TRACE, not decoration. The first run of this pipeline came out 71.8% LAKE — one flat sheet over the whole
  // continental interior — and the cause was a competition between two rates (channel incision at the outlet vs
  // tectonic uplift under it) that no amount of reading the code would have settled. TRACE=1 prints it.
  const trace = !!process.env.TRACE;
  // ⭐ THE UPLIFT THE LOOP USES IS DERIVED FROM THE PROFILE, NOT CHOSEN. Having laid the land down at the
  // steady state of the stream-power law, the uplift that SUSTAINS it is whatever that law says it must be —
  // so the loop starts in balance and any drift is caused by something real: rainfall that has changed since
  // the profile was laid (the wet flank of a range erodes faster than its lee, which is why real ranges are
  // asymmetric), soft rock next to hard, or a graben that was dropped in afterwards.
  // ⚠️ Without this the loop is a second, contradictory opinion about how tall the world should be, and the
  // taller one simply wins — the previous version inflated every peak from 271 to 991 rows over 400 steps.
  fillDepressions(); routeFlow();
  const uEff = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = down[i];
    if (d < 0 || h[i] <= o.seaLevel) continue;
    const sl = Math.max(0, (fill[i] - fill[d]) / o.dx);
    uEff[i] = o.erodeK * LITH_K[lith[i]] * Math.pow(flux[i], o.m) * Math.pow(sl, o.nExp) * o.dx;
  }

  for (let s = 0; s < o.steps; s++) {
    for (let i = 0; i < n; i++) if (h[i] > o.seaLevel - 200) h[i] += uEff[i];
    fillDepressions();
    routeFlow();
    // ⭐ CLIMATE IS RECOMPUTED INSIDE THE LOOP, and it is not decoration: rainfall drives erosion, so a wet
    // windward slope erodes faster than the desert behind it. That coupling is a large part of why real ranges
    // are ASYMMETRIC, and it costs one sweep every ten steps.
    if (s % o.climateEvery === 0) {
      clim = computeClimate(h, n, seed, o); chill(clim);
      for (let i = 0; i < n; i++) rain[i] = 0.25 + 1.75 * clim.moist[i];
    }
    // stream power
    for (let i = 0; i < n; i++) {
      const d = down[i];
      if (d < 0 || h[i] <= o.seaLevel) continue;
      const slope = Math.max(0, (fill[i] - fill[d]) / o.dx);
      const e = o.erodeK * LITH_K[lith[i]] * Math.pow(flux[i], o.m) * Math.pow(slope, o.nExp) * o.dx;
      h[i] = Math.max(o.seaLevel - 40, h[i] - e);
    }
    // ⭐ HILLSLOPE DIFFUSION — soil creep. Stream power goes to ZERO on a flat, which is exactly why the first
    // version could not drain its basins; diffusion is the process that does act there, and it is what removes
    // the small pits that would otherwise each become a spurious lake. One line, and it does a lot of work.
    if (o.diffuse > 0) {
      const prev = h.slice();
      for (let i = 0; i < n; i++) if (prev[i] > o.seaLevel)      // was 1..n-1 — the ring has no cell to skip
        h[i] += o.diffuse * (prev[wn(i - 1)] - 2 * prev[i] + prev[wn(i + 1)]);
    }
    // talus / hillslope: material above the angle of repose slides. This is what turns a spiky noise field into
    // something with real slopes, and it is the cheapest realism in the whole file.
    for (let p = 0; p < o.talusPasses; p++) {
      for (let i = 0; i < n; i++) {                              // was 0..n-2 — the ring's last pair is i=n-1 <-> 0
        const j = wn(i + 1), d = h[i] - h[j];
        if (d > o.talus) { const mv = (d - o.talus) * 0.5; h[i] -= mv; h[j] += mv; }
        else if (d < -o.talus) { const mv = (-d - o.talus) * 0.5; h[i] += mv; h[j] -= mv; }
      }
    }
    if (trace && (s % 40 === 0 || s === o.steps - 1)) {
      let lk = 0, land = 0, hi2 = -1e9, worstDam = 0, wi = 0;
      for (let i = 0; i < n; i++) {
        if (h[i] > o.seaLevel) { land++; if (fill[i] > h[i] + 0.6) lk++; if (h[i] > hi2) hi2 = h[i]; }
        const d = fill[i] - h[i]; if (d > worstDam) { worstDam = d; wi = i; }
      }
      // the outlet's own budget: how fast is it cutting, and how fast is it being pushed back up?
      let inc = 0, up = 0;
      { const i = wi; let j = i; while (j > 0 && fill[j] > h[j] + 0.6) j--;      // walk to the rim
        const d = down[j]; if (d >= 0) {
          const sl = Math.max(0, (fill[j] - fill[d]) / o.dx);
          inc = o.erodeK * LITH_K[lith[j]] * Math.pow(flux[j], o.m) * Math.pow(sl, o.nExp) * o.dx;
          up = uplift[j] * o.upliftMax;
        } }
      console.log(`    step ${String(s).padStart(4)}  lake ${(100 * lk / Math.max(1, land)).toFixed(1)}% of land · peak ${hi2.toFixed(0)} · deepest impoundment ${worstDam.toFixed(0)} rows @${wi} · its rim: incision ${inc.toFixed(2)} vs uplift ${up.toFixed(2)} rows/step`);
    }
  }
  fillDepressions();
  routeFlow();
  clim = computeClimate(h, n, seed, o); chill(clim);

  // ── lakes, rivers, sea ──────────────────────────────────────────────────────────────────────────────────────
  const isSea = new Uint8Array(n), isLake = new Uint8Array(n), lakeId = new Int32Array(n).fill(-1);
  // a closed (endorheic) basin: no outlet, so everything the catchment delivers stays and evaporates. Salinity
  // reads this. Kept as its own flag rather than folded into `lith` — see the note where it is set.
  const endo = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (h[i] <= o.seaLevel) isSea[i] = 1;
    else if (fill[i] > h[i] + 0.6) isLake[i] = 1;
  }
  // 🟥 THE FIRST ENDORHEIC TEST WAS MEANINGLESS AND REPORTED "0 endorheic" FOR EVERY WORLD. It asked whether a
  // lake's outflow reaches the sea — but Priority-Flood fills every basin to its RIM by definition, so every
  // lake overflows and every lake drains. The topology can never answer this question.
  // ⭐ WHETHER A BASIN IS CLOSED IS A WATER BALANCE, not a shape: a lake is endorheic when evaporation off its
  // surface matches its inflow BEFORE the level reaches the rim. That is why the Caspian, the Dead Sea and Lake
  // Eyre are closed and the Great Lakes are not — and it means salt pans and playas appear exactly where the
  // climate is dry, which is where they belong, without a separate rule saying so.
  // ⭐⭐ TWO PHASES, AND THE SPLIT IS THE CLOSED-BASIN GUARANTEE. A salt pan and a tufa tower both require an
  // endorheic basin, and two of five worlds contained NOT ONE — so under the user's 2026-08-10 ruling those two
  // landforms simply would not exist there. Their decision was to guarantee the PREREQUISITE rather than to
  // loosen the landform ("a brine pool needs a trench, so guarantee a trench"), and a basin's closure is a water
  // balance, so "the best refused candidate" is a number this pass already computes: the basin whose evaporation
  // comes NEAREST to consuming its inflow. Promoting it needs every basin weighed before any is acted on, hence
  // phase 1 (weigh) and phase 2 (apply) instead of the single pass this used to be.
  const lakes = [], isRiverExtra = [];
  for (let i = 0; i < n; i++) {
    if (!isLake[i] || lakeId[i] >= 0) continue;
    let a = i; while (a > 0 && isLake[a - 1]) a--;
    let b = i; while (b < n - 1 && isLake[b + 1]) b++;
    const rec = { id: lakes.length, a, b, level: fill[i], rim: fill[i], endorheic: false, dry: false };
    for (let k = a; k <= b; k++) lakeId[k] = rec.id;
    // inflow: what the catchment delivers. evaporation: per unit of lake surface, driven by heat and dryness.
    // ⚠️ EVAPORATION HAS TO BE COMPARABLE TO RAINFALL OR NO BASIN EVER CLOSES. The first version used a rate of
    // ~0.45 per cell against a rainfall of ~0.95 per cell, so open water always won and the world had ZERO
    // endorheic basins. Real open-water evaporation runs several times desert rainfall and a fraction of wet
    // temperate rainfall, and it is that RATIO which decides whether you get Lake Baikal or Lake Eyre.
    // ⚠️ THE RATIO HAS TO BE REALISTIC, NOT MERELY THE RIGHT SIGN. A first pass evaporated ~0.96 per cell
    // against a rainfall of ~1.0, so open water essentially always won its catchment and the world had ZERO
    // closed basins. In a real desert, open-water evaporation runs 10-20x the local rainfall (that is why the
    // Tarim and Lake Eyre are closed); in wet temperate country it is a fraction of it (why the Great Lakes are
    // not). Squaring the dryness term gives ~17x in desert and ~1.3x in temperate, which is the right spread.
    let evapRate = 0;
    for (let k = a; k <= b; k++) evapRate += (0.3 + 2.2 * clim.temp[k]) * Math.pow(1.6 - clim.moist[k], 2);
    evapRate /= (b - a + 1);
    const inflow = Math.max(flux[a], flux[b]);
    const surface = b - a + 1;
    const evap = surface * evapRate * o.evapK;
    // ⭐⭐ OUT-OF-PLANE DRAINAGE, AND IT IS THE IDEA THAT MAKES A 1-D WORLD WORK AT ALL.
    // In one dimension a valley between two ranges is ALWAYS a closed basin — there is no third direction to
    // drain along — so filling every depression to its rim drowned 15-20% of the world. But a side view is a
    // SLICE: the Central Valley, the Po and the Ganges plain all drain laterally, and in a transect they would
    // look closed too. A river in this game does not have to run left-to-right; it can be the cross-section of
    // one flowing ACROSS the view, which is what a side-scroller shows anyway.
    // ⇒ a basin only becomes a lake if EVAPORATION CAN CONSUME ITS INFLOW. If it cannot, the surplus leaves out
    // of plane and the basin is a river valley with a floodplain, not a lake. Wet basins get rivers, dry basins
    // get salt pans, and which one you get is decided by climate rather than by an accident of the profile.
    const keep = Math.max(0, Math.min(surface, Math.floor(inflow / Math.max(1e-6, evapRate * o.evapK))));
    rec.endorheic = evap > inflow;
    rec.closure = evap / Math.max(1e-6, inflow);      // how nearly closed: >1 IS closed, and the guarantee ranks on it
    rec.keep = keep;
    lakes.push(rec);
    i = b;
  }
  // ⭐ THE GUARANTEE: if this world closed no basin at all, the nearest-miss basin is closed. It overrides the
  // THRESHOLD of the water balance and nothing else — the basin promoted is genuinely the driest, most
  // evaporation-dominated one the world has, so it is the site a closed basin would form at first if the world
  // were a little drier. It does not touch what a salt pan or a tufa tower requires.
  if (lakes.length && !lakes.some(l => l.endorheic)) {
    let best = lakes[0];
    for (const l of lakes) if (l.closure > best.closure) best = l;
    best.endorheic = true; best.forcedClosure = true;
    // ⚠️ `keep` is derived from inflow and is now inconsistent with a basin we have declared closed: left as is
    // it would keep the WHOLE basin wet (inflow exceeded evaporation, which is why it was open), and a closed
    // basin that is brim-full is exactly the through-flowing lake we just overrode. Held to the deepest fifth so
    // there is an exposed playa floor for the salt pan and the tufa to sit on — which is the point of forcing it.
    best.keep = Math.max(1, Math.round((best.b - best.a + 1) * 0.2));
  }
  for (const rec of lakes) {
    const { a, b, keep } = rec;
    const surface = b - a + 1;
    rec.dry = rec.endorheic && keep === 0;
    const idx = []; for (let k = a; k <= b; k++) idx.push(k);
    idx.sort((p, q) => h[p] - h[q]);
    if (!rec.endorheic) {
      // through-flowing: the valley floor is a floodplain with a river across it, not a sheet of water
      for (let k = a; k <= b; k++) { isLake[k] = 0; lakeId[k] = -1; }
      rec.throughFlow = true;
      // just the valley floor, not a sheet: a river crossing the view is a few cells wide, not 15% of a basin
      for (const k of idx.slice(0, Math.max(1, Math.round(surface * 0.04)))) isRiverExtra.push(k);
    } else {
      // keep the DEEPEST part; the rest is the exposed floor of a playa
      const wet = new Set(idx.slice(0, keep));
      for (let k = a; k <= b; k++) if (!wet.has(k)) { isLake[k] = 0; lakeId[k] = -1; }
      if (keep) rec.level = h[idx[Math.max(0, keep - 1)]]; else rec.level = h[idx[0]];
    }
    // ⭐⭐ A CLOSED BASIN IS A FLAG, NOT A LITHOLOGY — and the picture is what settled that.
    //
    // 🟥 `L.EVAPORITE` is declared in the enum, mapped to a material (`LITH_MAT[EVAPORITE] = M.salt`) and
    // required by the Salt pan contract (`lith: [SHALE, EVAPORITE]`), and is assigned to NO COLUMN ANYWHERE —
    // 0 of 2,700 sampled across 3 worlds. The lithology pass 300 lines above says "evaporite in dry closed
    // basins (which is decided later, so this is a first guess)" and nothing later ever decided it. So all the
    // salt in the world comes from the salt-DOME rule, the Salt pan contract can only ever match shale, and
    // nowhere in the world is salty — which is why the new brine liquid could never fire. Found by asking a
    // liquid question, which is the argument for the axis model: an axis nothing drives is VISIBLE, where a
    // missing `else` branch is not. (`rec.dry` never fires either: 0 dry lakes in 5 seeds.)
    //
    // 🟥 AND THE OBVIOUS FIX — `lith[k] = L.EVAPORITE` here — WAS WRONG, measurably and then visibly.
    // `probe_settled` went 57 → 147 (0.0019% → 0.0049%), all of it inside two endorheic lakes, and the render
    // (`out/evap_lakes.png`) showed why: a lithology is the WHOLE COLUMN, so the basin became a salt mass from
    // the surface to the basement — the salt-DOME rule keys on exactly this flag — and salt is soluble, so it
    // karsted and the lake drained out through horizontal sheets in its own bedrock. Every step of that is
    // physically correct and the result is not a lake.
    // ⇒ evaporite is a BED laid down IN a basin, not the rock the basin is cut into. The basin is recorded as a
    // flag and the salt is dressing — which is the form/dressing split, arrived at from the other direction.
    if (rec.endorheic) for (let k = a; k <= b; k++) endo[k] = 1;
  }
  const RIVER_MIN = n / 24;                                     // flux threshold for "this reads as a river"
  const isRiver = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!isSea[i] && !isLake[i] && flux[i] > RIVER_MIN) isRiver[i] = 1;
  for (const k of isRiverExtra) if (!isSea[k] && !isLake[k]) isRiver[k] = 1;   // the out-of-plane rivers

  // ⭐⭐ WHERE THE SEA IS POLAR — a QUANTILE, with an absolute ceiling. (Ocean phase 3.)
  // 🟥 The first cut was `temp < 0.20` and it produced no polar sea at all in three worlds of four: measured
  // over six seeds the sea's temperature MINIMUM ranges 0.05 to 0.28, so a fixed 0.20 is below the whole
  // distribution in most of them. Exactly the mistake the abyssal-plain cut made forty lines up, and the third
  // time this session — an absolute threshold against a field whose range nobody checked.
  // ⚠️ THE CEILING IS WHY THIS IS NOT JUST A QUANTILE. A pure quantile would declare the coldest tenth of the
  // sea 'polar' even in a world that is tropical from end to end, which is the failure mode quantiles have and
  // absolute cuts do not. Capped, a hot world correctly gets no pack ice, and every other world gets some.
  // ⭐ BACK TO AN ABSOLUTE THRESHOLD, and the reason is that the world changed under it. The quantile existed
  // because no world reliably had cold water; the placed polar cap now drives temperature to ZERO in one region
  // of every world, so an absolute cut both works and says what the user asked for — ONE arctic, in the ocean,
  // rather than the coldest tenth of the sea wherever that happens to fall.
  out.polarT = 0.20;

  // ⚠️ THE CANYONS RUN HERE, NOT UP WITH THE OTHER TWO SEA-FLOOR FEATURES, AND IT IS NOT TIDINESS.
  // Their siting rule is 'head at a river mouth', and `isRiver` does not EXIST until the line above —
  // it is a product of the drainage solve. Placed with the ridge and the seamounts the test read
  // `undefined` for every sample and the tally would have said `headless` for the whole world, which is
  // the same shape of bug as a threshold below the field's floor: a clause that cannot ever be true.
  // ⭐ Safe to cut `h` this late because erosion never touches sea columns, and a canyon only ever makes
  // a sea column deeper, so nothing downstream changes its mind about what is sea.
  // ── SUBMARINE CANYONS ──────────────────────────────────────────────────────────────────────────────────────
  // ⭐ Real ones HEAD AT A RIVER MOUTH — they are cut by sediment-laden flows coming off the land, so they start
  // where the sediment does. `isRiver` already exists, so the siting rule is a lookup rather than an invention,
  // and the canyon comes out opposite a river without anyone connecting the two.
  // ⚠️ Seen in this slice they are a NOTCH ACROSS the slope, because the world is a vertical section: a canyon
  // running down the slope crosses our plane rather than lying in it. Deepening seaward, like the real thing.
  {
    const W_ = oceanWhy.canyon;
    let last = -1e9;
    for (let at = 0; at < n; at += 4) {
      if (W_.sited >= 26) break;
      const i0 = wn(at);
      if (isLand[i0] || cont[i0] > C_SHELF || cont[i0] <= C_ABY) { W_.notSlope++; continue; }
      if (at - last < 60) { W_.tooClose++; continue; }
      // ⭐ A CANYON MAY ALSO HEAD AT A SHELF EDGE, not only at a river. The tally said `headless` killed 82-315
      // slope candidates per world — a real limit, because most of the slope is nowhere near a river mouth. And
      // the strict rule was over-specified: plenty of real submarine canyons are cut by SLOPE FAILURE at the
      // shelf break with no river above them at all. Widening it to "a river OR the coast" is truer geology as
      // well as more canyons, which is the only kind of loosening worth doing.
      let head = 0;
      // ⚠️ 90 → 320, the SAME scale mistake the trench made and caught by the same tally: the slope sits 200+
      // samples from land (shelf ~180 + slope ~60), and a river is on land, so at 90 the clause could not be
      // true anywhere and `headless` killed every candidate in five seeds of six. Real canyons do incise back
      // across the shelf to the river that feeds them, so the wider reach is the truer rule as well.
      for (let k = 1; k <= 320 && !head; k++)
        if (isRiver[wn(at - k)] || isRiver[wn(at + k)] || isLand[wn(at - k)] || isLand[wn(at + k)]) head = 1;
      if (!head) { W_.headless++; continue; }
      if (hwI(seed, 101, at, n) > 0.45) { W_.dice++; continue; }
      const half = 2 + Math.round(hwI(seed, 102, at, n) * 8);
      const cut = 70 + hwI(seed, 103, at, n) * 150;
      for (let k = -half; k <= half; k++) {
        const i = wn(at + k);
        if (isLand[i]) continue;
        const t = 1 - Math.abs(k) / (half + 1);
        h[i] -= cut * Math.pow(t, 1.4);                                // V-shaped, not U — it is a cut, not a valley
      }
      oceanFeatures.push({ kind: 'canyon', at, half });
      W_.sited++; last = at;
    }
  }


  // relief: local elevation range, which is what separates "high" from "mountainous"
  const relief = new Float32Array(n);
  const RW = 6;
  for (let i = 0; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let k = Math.max(0, i - RW); k <= Math.min(n - 1, i + RW); k++) { if (h[k] < lo) lo = h[k]; if (h[k] > hi) hi = h[k]; }
    relief[i] = hi - lo;
  }
  const slope = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = h[Math.max(0, i - 1)], b = h[Math.min(n - 1, i + 1)];
    slope[i] = Math.abs(b - a) / (2 * o.dx);
  }

  // ── STAGE 5+6: REGIONS, THEN FEATURES, THEN THE WATER AND THE REGIONS AGAIN ─────────────────────────────────
  const biome = new Uint8Array(n);
  const world = { n, dx, o, h, fill, flux, down, uplift, cont, lith, clim, isSea, isLake, isRiver, lakeId, lakes,
    endo, relief, slope, biome, isLand, seaLevel: o.seaLevel };
  const reclass = () => { for (let i = 0; i < n; i++) world.biome[i] = classify(i, world); };
  // ⚠️ RANKED BEFORE THE FIRST CLASSIFICATION, not only before the second. `classify` now expresses its
  // mountain, glacier and wetland clauses as PERCENTILES of the land distribution — the same way the feature
  // contracts twenty lines below already do — so it needs `rank` on BOTH passes. Without this the first pass
  // silently loses three biomes and `layoutFeatures` places against a biome map that disagrees with the final
  // one. (`layoutFeatures` builds `rank` lazily anyway; this just moves it one line earlier.)
  world.rank = fieldRanks(world);
  reclass();
  world.features = layoutFeatures(world);

  // ⚠️ A FEATURE THAT MOVES THE GROUND MOVES THE WATER. Applying the shapes and then leaving the old drainage in
  // place would leave rivers running along the rim of a canyon that had just been cut beside them, and salt pans
  // that are not the low point of their own basin. So the water is recomputed on the terrain that actually
  // exists — one iteration, because placement read the pre-feature fields and chasing that to a fixed point is
  // circular rather than convergent.
  world.seams = applyFeatures(world);
  fillDepressions(); routeFlow();
  clim = computeClimate(h, n, seed, o); chill(clim);
  world.clim = clim;
  for (let i = 0; i < n; i++) {
    isSea[i] = h[i] <= o.seaLevel ? 1 : 0;
    if (isSea[i]) isLake[i] = 0;
    const a = h[Math.max(0, i - 1)], b = h[Math.min(n - 1, i + 1)];
    slope[i] = Math.abs(b - a) / (2 * o.dx);
    let l2 = Infinity, h2 = -Infinity;
    for (let k = Math.max(0, i - RW); k <= Math.min(n - 1, i + RW); k++) { if (h[k] < l2) l2 = h[k]; if (h[k] > h2) h2 = h[k]; }
    relief[i] = h2 - l2;
  }
  // ⚠️ REBUILT, NOT JUST INVALIDATED. Setting this to null and leaving it made every later reader fall back to
  // its own absolute threshold — silently, because the fallback is a legal expression. Cell synthesis read
  // `steep` through that fallback and put bare scree on every mountain in the world.
  world.rank = fieldRanks(world);
  reclass();
  // ⭐⭐ THE THREE DEPTH BANDS — the one HARD INTERFACE something already built depends on. `server/domains.js`
  // places a site in `sky` (4-33% of the world's height), `surface` (34-66%) or `underground` (67-97%), and
  // each band has to contain GROUND TO STAND ON or a site placed there is not a site.
  // ⚠️ These are NOT surface features and cannot use the same layout pass: a floating island and a deep hall
  // are objects suspended in air and in rock, not modifications of a heightfield. They get their own lattices,
  // which is the one structural idea worth carrying over from the shipped generator — the code is new, the
  // pattern ("one candidate per lattice cell, bounded reach, answered from the anchor alone") is not.
  // ⭐ the latitude field is exported so a previewer can show the CAUSE beside the effect rather than
  // re-deriving it — a second copy of `poleness` in a diagnostic is exactly how this track has twice ended up
  // measuring something the world does not do.
  if (o.latitude) { world.lat = new Float32Array(n); for (let i = 0; i < n; i++) world.lat[i] = poleness(i, n, o); }
  world.sky = layoutSky(world);
  world.deep = layoutDeep(world);
  Object.assign(out, world);
  return out;
}

// ==============================================================================================================
//  STAGE 4: CLIMATE — temperature bands along the world, and OROGRAPHIC moisture swept along the wind.
//  ⭐ In 1-D the rain-shadow model is exact rather than an approximation, and it is the single cheapest source
//  of "this place is different from that place" in the whole pipeline: one range turns the land behind it into
//  desert, which is the Atacama, the Gobi and the Great Basin all at once.
// ==============================================================================================================
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  ⭐⭐ LATITUDE — OPTIONAL, `buildWorld({ latitude: 1 })`. Built to be LOOKED AT, not switched on by decree.
//
//  ⭐ THE RING IS A GREAT CIRCLE OVER THE POLES, and that is the whole geometric idea. A 1-D world that wraps
//  cannot have "two poles and an equator" laid out like a globe's surface — but walking all the way round a
//  great circle THROUGH both poles goes pole → equator → pole → equator → home, which is exactly a ring. So
//  `cos` of one full turn over the period gives +1 at one pole, -1 at the other and 0 at the two equator
//  crossings, and it is periodic BY CONSTRUCTION rather than by quantising anything.
//  ⚠️ Phase-shifted per seed, or every world has its pole at column zero.
//
//  ⭐⭐ AND LATITUDE DRIVES THREE THINGS ON EARTH, NOT ONE — which is why this is worth more than a temperature
//  gradient. All three already exist here as noise or as a proxy:
//    TEMPERATURE   the obvious one, currently a band field with no global order at all.
//    WIND BANDS    trades, westerlies, polar easterlies — a FIXED alternating pattern with latitude, and the
//                  reason deserts sit at 30° and rainforests at the equator. Currently `windDir` is noise, so
//                  rain shadows scatter instead of organising.
//    THE DRY BELT  descending Hadley air at ±30°. The code already models it, keyed on `temp ≈ 0.74` as a PROXY
//                  for "the hot part of the world" — with latitude it becomes the positional fact it really is.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 0 at the equator, 1 at a pole.
// 🟥 A COSINE IS THE WRONG SHAPE AND THE TEMPERATURE HISTOGRAM SAID SO: median 0.20, i.e. most of the world
// polar. `|cos|` of a uniform angle is arcsine-distributed — it piles up at 0 and 1, so the world spent two
// thirds of itself above latitude 60. But on a great circle THROUGH the poles, latitude is arc distance: it
// falls linearly from the pole to the equator and rises linearly to the other pole. That is a TRIANGLE wave,
// and it is what makes latitude uniform — half the world above 45 degrees, half below, as on a real transect.
// ⚠️ The kink at the poles and equators is not an artefact; it is what crossing a pole IS.
function poleness(i, n, o) {
  const u = i / n + (o.polePhase || 0);
  return Math.abs(1 - 2 * ((((u * 2) % 1) + 1) % 1));
}
function computeClimate(h, n, seed, o) {
  const temp = new Float32Array(n), moist = new Float32Array(n), windDir = new Int8Array(n);
  // A slow band field: walking the world takes you through climate zones. Plus a lapse rate with altitude.
  const LAPSE = 1 / 900;
  for (let i = 0; i < n; i++) {
    const band = fbm(seed, 7, i * pf(n, 1300).q, 3, 0, pf(n, 1300).p);
    if (o.latitude) {
      // ⚠️ THE NOISE IS KEPT AS A WOBBLE, not replaced. A pure gradient is a ramp — it reads as a diagram, and
      // it would delete every local climate surprise the world already has. Latitude sets the ENVELOPE; the
      // band field still decides whether this particular stretch is a warm or a cool version of its latitude.
      const p = poleness(i, n, o);
      temp[i] = clamp(lerp(0.94, 0.02, p * p * (3 - 2 * p)) + (band - 0.5) * 0.30 - Math.max(0, h[i]) * LAPSE, 0, 1);
    } else {
      temp[i] = clamp(band * 1.15 - 0.07 - Math.max(0, h[i]) * LAPSE, 0, 1);
    }
    // Prevailing wind flips a few times across the world, as trade winds and westerlies do. It is what decides
    // WHICH SIDE of a range is the wet one, so it must vary or every range in the world is lit the same way.
    // ⭐ THE THREE CELLS. Trades blow one way, westerlies the other, polar easterlies back again — so which
    // side of a range is wet becomes a fact about WHERE YOU ARE, and rain shadows line up into belts.
    windDir[i] = o.latitude
      ? ((Math.floor(poleness(i, n, o) * 3) & 1) ? 1 : -1)
      : ((fbm(seed, 17, i * pf(n, 900).q, 2, 0, pf(n, 900).p) > 0.5) ? 1 : -1);
  }
  // Sweep each contiguous run of one wind direction, in that direction.
  let i = 0;
  while (i < n) {
    let j = i; while (j + 1 < n && windDir[j + 1] === windDir[i]) j++;
    const dir = windDir[i];
    const from = dir > 0 ? i : j, to = dir > 0 ? j : i;
    let H = 0.55;                                              // humidity carried by the air mass
    for (let k = from; dir > 0 ? k <= to : k >= to; k += dir) {
      const prev = k - dir;
      const hp = (prev >= 0 && prev < n) ? h[prev] : h[k];
      if (h[k] <= o.seaLevel) { H = Math.min(1, H + 0.22); moist[k] = 0.95; continue; }
      const rise = Math.max(0, h[k] - hp);
      // 🟥 THE FIRST TUNING MADE THE WHOLE WORLD A DESERT — 34% of it, with 0.6% temperate forest and 0.04%
      // rainforest — because the air dried out irreversibly a hundred cells inland. The missing term is
      // EVAPOTRANSPIRATION: over real land, most rain is recycled rather than lost, which is why continental
      // interiors are merely drier than coasts and not Martian. With recycling the equilibrium humidity is
      // ~0.65 instead of ~0.23, and a rain shadow becomes a LOCAL effect of a range rather than a one-way
      // ratchet that ends every continent in sand.
      // ⭐ TWO KINDS OF DESERT, because the real world has two and a model with only one is visibly poorer.
      //   RAIN SHADOW — a range wrings the air out, and the dryness PERSISTS because recycling scales with how
      //   wet the ground already is. Dry ground returns no water to the air, so the shadow is self-sustaining
      //   rather than recovering fifty cells downwind (which is what the previous tuning did, making every
      //   shadow too narrow to be a place).
      //   SUBTROPICAL — descending air at the hot end of the temperature band suppresses rain outright. This is
      //   the Sahara, Arabia and the Australian interior, and none of them are behind a mountain.
      // ⭐ THE HADLEY BELT, at ±30°, which is where every great desert on Earth is. Without latitude this can
      // only be approximated by "wherever it happens to be hot", which scatters the deserts.
      const descent = o.latitude
        ? Math.exp(-Math.pow((poleness(k, n, o) - 0.34) / 0.11, 2))
        : Math.exp(-Math.pow((temp[k] - 0.74) / 0.13, 2));
      const P = H * (0.012 + rise * 0.0075) * (1 - 0.88 * descent);
      // ⚠️ Recycling scales with how wet the GROUND already is, which is what makes a rain shadow persist
      // instead of healing fifty cells downwind: dry ground returns nothing to the air. It is also why the
      // Sahara sustains itself. Steeper than the first attempt, which let interiors recover far too easily.
      const recycle = 0.030 * Math.min(1, (k - dir >= 0 && k - dir < n ? moist[k - dir] : 0.4) * 1.5);
      H = clamp(H - P * 0.85 + recycle * (1 - H), 0, 1);
      moist[k] = clamp(P * 52, 0, 1);
    }
    i = j + 1;
  }
  // hot air holds more water, so the same rainfall supports less vegetation
  for (let k = 0; k < n; k++) moist[k] = clamp(moist[k] * (1.20 - 0.45 * temp[k]), 0, 1);
  return { temp, moist, windDir };
}

// ==============================================================================================================
//  STAGE 5: classification. Whittaker, with relief and water overriding.
// ==============================================================================================================
function classify(i, s) {
  // ⚠️ `relief` and `elev` are read through `s.rank` now, not raw — see the note on the mountain clauses below.
  const { h, isSea, isLake, lakes, lakeId, clim, o } = s;
  if (isSea[i]) return h[i] > o.seaLevel - 120 ? B.shelf : B.ocean;
  if (isLake[i]) {
    const lk = lakes[lakeId[i]];
    if (lk && lk.endorheic && clim.moist[i] < 0.18) return B.saltflat;
    return B.lake;
  }
  const t = clim.temp[i], w = clim.moist[i];
  // ⭐ EVERY ELEVATION AND RELIEF TEST BELOW IS A PERCENTILE OF THE LAND THAT EXISTS, read through `rank`, which
  // is what makes this function survive `peakScale` — a world 2.6x taller has the same top decile.
  const rk = s.rank;
  // 🟥🟥 THE COLD END WAS THE ONE BAND IN THIS FUNCTION THAT IGNORED MOISTURE, and with latitude switched on it
  // became the largest single biome in the world: 13.6% tundra, and MEASURED, every one of those cells was in
  // this branch with none above elevation 500 — so all of them fell through the `hh > 500` test to the same
  // answer. Meanwhile their moisture spanned the full range (quartiles 85/609/224/199). The variety was already
  // in the data and the classifier was discarding it.
  // ⭐ AND THE REAL WORLD SPLITS IT THE SAME WAY THE TEMPERATE BANDS ARE ALREADY SPLIT: an ICE SHEET needs
  // SNOWFALL to accumulate (Greenland, wet), a POLAR DESERT is the driest place on the planet (the Antarctic
  // interior), and TUNDRA is the middle. Three outcomes from a number that was already being computed.
  // ⚠️ THE THRESHOLDS ARE SET FROM THE MEASURED SPREAD OF MOISTURE INSIDE THIS BAND, not guessed: the first
  // attempt used 0.66/0.24 and left 79% of the cold zone still tundra, because the cold band's moisture
  // clusters in 0.25-0.55 and both cuts fell outside it. Four outcomes at roughly even shares instead — an ice
  // sheet where it snows, tundra, cold steppe, and a polar desert where it does not.
  if (t < 0.10) {
    // ⚠️ `hh > 500` WAS THE LAST ABSOLUTE ELEVATION THRESHOLD LEFT IN THIS FUNCTION after the glacier/alpine
    // fix, and `peakScale` is exactly the change that would have made it stop meaning anything: at scale 2.6
    // half the land clears 500 rows, so "high enough to be an ice sheet" would quietly become "not very low".
    // Same percentile treatment as its neighbours; the world's own top decile of land, whatever the world is.
    if ((rk && rk.elev[i] > 0.90) || w > 0.58) return B.icecap;
    if (w > 0.40) return B.tundra;
    if (w > 0.26) return B.coldsteppe;
    return B.colddesert;
  }
  // 🟥🟥 FOUR DECLARED BIOMES WERE PRODUCED BY NO SEED — glacier, alpine, montane and wetland — and there were
  // TWO causes wearing one symptom. `probe_regions` found them; `probe_classify` separated them.
  //   THREE OF THEM WERE MISTAKE #6, in its purest form. `hh > 700` for a glacier, against a world whose land
  //   tops out at 668.5 rows over five seeds: the clause admitted 0 of 20,204 land samples, so the branch was
  //   dead by construction. `rel > 420 && hh > 620` for alpine/montane was worse in kind — relief over 420
  //   admits 2 samples and elevation over 620 admits 3, and they are not the SAME samples, so a conjunction of
  //   two near-maximum thresholds admitted exactly nothing. Raising either one alone would have changed nothing.
  //   ⭐ THE FIX IS NOT A LOWER NUMBER, IT IS THE RIGHT KIND OF NUMBER. Twenty lines below, the feature
  //   contracts have expressed exactly these ideas as PERCENTILES OF THE LAND THAT EXISTS since the day ten of
  //   sixteen of them placed nowhere for the same reason. The `glacier` LANDFORM asks for temp [0,0.15],
  //   elev [0.75,1], relief [0.70,1]; the glacier BIOME now asks the same question, so the two cannot drift
  //   apart and neither can be invalidated by retuning the terrain's height.
  //   THE FOURTH, `wetland`, IS MISTAKE #9 AND NEEDED A RULE, NOT A THRESHOLD: it is declared in the biome list
  //   and `classify` never returned it from any branch. Its rule mirrors the `swamp` contract for the same
  //   no-two-rules-disagreeing reason — wet, flat, and with drainage arriving faster than it leaves.
  if (t < 0.16) {
    if (rk && rk.elev[i] > 0.75 && rk.relief[i] > 0.70) return B.glacier;
    return w > 0.50 ? B.taiga : (w > 0.22 ? B.tundra : B.colddesert);
  }
  if (rk && rk.relief[i] > 0.85 && rk.elev[i] > 0.75) return t < 0.45 ? B.alpine : (w > 0.45 ? B.montane : B.alpine);
  // ⚠️ AFTER the mountain test and BEFORE the Whittaker bands: a wetland is a drainage fact that overrides the
  // temperature/moisture grid, exactly as lakes and relief already override it above.
  if (rk && t >= 0.22 && rk.moist[i] > 0.70 && rk.slope[i] < 0.35 && rk.flux[i] > 0.75) return B.wetland;
  if (t < 0.22) return w > 0.35 ? B.taiga : (w > 0.16 ? B.coldsteppe : B.colddesert);
  if (t < 0.45) {
    if (w > 0.70) return B.temprain;
    if (w > 0.40) return B.tempforest;
    if (w > 0.20) return B.grassland;
    return B.coldsteppe;
  }
  if (t < 0.68) {
    if (w > 0.72) return B.temprain;
    if (w > 0.45) return B.tempforest;
    if (w > 0.26) return B.medit;
    if (w > 0.12) return B.scrub;
    return B.hotdesert;
  }
  if (w > 0.68) return B.rainforest;
  if (w > 0.44) return B.monsoon;
  if (w > 0.24) return B.savanna;
  if (w > 0.11) return B.scrub;
  return B.hotdesert;
}

// ==============================================================================================================
//  STAGE 6: FEATURE LAYOUT — placement by BOUNDARY CONTRACT.
//
//  ⭐ THE POINT OF THIS STAGE IS THE MECHANISM, NOT THE CATALOGUE. Each feature declares numeric conditions it
//  needs from its surroundings and how RIGID it is; the layout pass scores every candidate site and keeps the
//  best non-conflicting ones. Rigidity is a PARAMETER (how far the feature may bend the terrain to suit itself,
//  and how much clearance it demands), not a category — which is what makes "elastic bare terrain stitches with
//  anything, a volcano does not" fall out instead of being written down feature by feature.
//
//  ⚠️ Notice how many of these place themselves off the drainage and climate fields alone. That is the payoff
//  from doing erosion FIRST: swamps, oases, salt flats, deltas, canyons and fjords all know where they go
//  without anyone hand-placing them.
// ==============================================================================================================
// 🟥🟥 EVERY NUMERIC BAND HERE IS A PERCENTILE OF THE WORLD THAT EXISTS, NOT AN ABSOLUTE VALUE, AND THAT IS THE
// MOST TRANSFERABLE THING THE SPIKE FOUND.
// The first version used absolute numbers, and TEN OF SIXTEEN features placed nowhere in any world. The autopsy
// was the same every time: I had written thresholds against imagined quantities. Local relief was asked to
// exceed 180-420 rows when the world's MAXIMUM was 197 and its median 5.7; slope was asked for 0.35-0.5 against
// a maximum of 0.31; elevation 520 against a maximum of 452; uplift 0.45 against a maximum of 0.32.
// ⭐ `relief: [0.90, 1]` means "the top 10% of land by local relief" — which stays true after the terrain is
// retuned, cannot be silently invalidated by rescaling a field, and says what was actually meant. An absolute
// threshold is a coupling between a feature and a tuning constant somewhere else, and nothing warns you when
// that coupling breaks: the feature just quietly stops existing.
const A = [0, 1];                                            // "anything"
const FEATURES = [
  // name         width(samples) rigid   need: percentile bands, or a categorical flag
  { key: 'volcano', name: 'Volcano', w: [3, 9], rigid: 0.95, spacing: 90,
    need: { uplift: [0.94, 1], lith: [L.BASALT, L.GRANITE], sea: 0 } },
  { key: 'caldera', name: 'Caldera lake', w: [2, 5], rigid: 0.9, spacing: 260,
    need: { uplift: [0.90, 1], moist: [0.35, 1], lith: [L.BASALT], sea: 0 } },
  // ⚠️ THESE TWO PLACED NOWHERE FOR THREE RUNS, and the fix is not a looser threshold — it is that both were
  // asking for three conditions to coincide at a COASTLINE, and a coastline is a tiny fraction of the world.
  // A fjord needs cold AND steep AND coastal; a delta needs a river AND flat AND coastal. Each clause was
  // reasonable and the conjunction was almost impossible. So each keeps the clause that MAKES it what it is
  // (a fjord is glacially over-deepened, a delta is where a river meets the sea) and loosens the rest.
  { key: 'fjord', name: 'Fjord', w: [4, 12], rigid: 0.6, spacing: 70,
    need: { temp: [0, 0.34], relief: [0.55, 1], coast: 1 } },
  { key: 'delta', name: 'River delta', w: [4, 14], rigid: 0.25, spacing: 60,
    need: { nearRiver: 1, coast: 1, slope: [0, 0.85] } },
  { key: 'canyon', name: 'Canyon', w: [6, 26], rigid: 0.5, spacing: 80,
    need: { river: 1, moist: [0, 0.35], lith: [L.SANDSTONE, L.LIMESTONE, L.BASEMENT], relief: [0.75, 1] } },
  { key: 'gorge', name: 'Gorge', w: [3, 8], rigid: 0.5, spacing: 55,
    need: { river: 1, lith: [L.GRANITE, L.BASEMENT, L.BASALT], slope: [0.85, 1] } },
  { key: 'mesa', name: 'Mesa and butte field', w: [8, 30], rigid: 0.35, spacing: 90,
    need: { moist: [0, 0.30], lith: [L.SANDSTONE, L.SHALE], relief: [0.55, 0.95], elev: [0.45, 1] } },
  { key: 'badlands', name: 'Badlands', w: [6, 22], rigid: 0.2, spacing: 80,
    need: { moist: [0.02, 0.35], lith: [L.SHALE, L.EVAPORITE], relief: [0.45, 0.92] } },
  { key: 'dunes', name: 'Dune sea', w: [10, 48], rigid: 0.15, spacing: 110,
    need: { moist: [0, 0.14], slope: [0, 0.55], temp: [0.55, 1], sea: 0 } },
  { key: 'oasis', name: 'Oasis', w: [1, 3], rigid: 0.8, spacing: 40,
    need: { moist: [0, 0.18], nearWater: 1, sea: 0 } },
  { key: 'saltpan', name: 'Salt pan', w: [3, 14], rigid: 0.3, spacing: 70,
    need: { moist: [0, 0.35], endorheic: 1 } },
  { key: 'swamp', name: 'Swamp', w: [5, 20], rigid: 0.15, spacing: 70,
    need: { moist: [0.55, 1], slope: [0, 0.45], flux: [0.60, 1], temp: [0.25, 1] } },
  { key: 'karst', name: 'Karst towers', w: [5, 18], rigid: 0.45, spacing: 90,
    need: { lith: [L.LIMESTONE], moist: [0.55, 1], temp: [0.40, 1] } },
  { key: 'glacier', name: 'Valley glacier', w: [3, 10], rigid: 0.5, spacing: 60,
    need: { temp: [0, 0.15], elev: [0.75, 1], relief: [0.70, 1] } },
  { key: 'reef', name: 'Coral reef', w: [2, 8], rigid: 0.4, spacing: 60,
    need: { shelf: 1, temp: [0.62, 1] } },
  { key: 'escarp', name: 'Escarpment', w: [2, 6], rigid: 0.55, spacing: 70,
    need: { relief: [0.85, 1], lith: [L.SANDSTONE, L.BASALT, L.LIMESTONE], slope: [0.80, 1] } },
  // ── the catalogue broadened. ⭐ NOTE HOW LITTLE EACH ONE COSTS: a contract, a shape, and for four of them a
  // fine-detail signature. That is the return on having built the contract mechanism and the previewers first —
  // adding the thirtieth landform is an afternoon, which was the whole point of doing it in that order.
  { key: 'plateau', name: 'Plateau', w: [14, 44], rigid: 0.40, spacing: 100,
    need: { elev: [0.70, 1], relief: [0.20, 0.70], sea: 0 } },
  { key: 'inselberg', name: 'Inselberg', w: [2, 6], rigid: 0.85, spacing: 60,
    need: { lith: [L.GRANITE, L.BASEMENT], relief: [0, 0.40], moist: [0, 0.60], sea: 0 } },
  { key: 'hoodoo', name: 'Hoodoo field', w: [4, 14], rigid: 0.50, spacing: 70,
    need: { lith: [L.SANDSTONE], moist: [0, 0.28], relief: [0.40, 0.92] } },
  { key: 'fan', name: 'Alluvial fan', w: [6, 20], rigid: 0.25, spacing: 60,
    need: { moist: [0, 0.50], relief: [0.55, 0.96], slope: [0.30, 0.88] } },
  { key: 'moraine', name: 'Moraine field', w: [6, 22], rigid: 0.20, spacing: 60,
    need: { temp: [0, 0.26], relief: [0.30, 0.85], slope: [0, 0.65] } },
  { key: 'seacliff', name: 'Sea cliff', w: [2, 7], rigid: 0.80, spacing: 50,
    need: { coast: 1, relief: [0.55, 1], lith: [L.GRANITE, L.BASALT, L.LIMESTONE, L.SANDSTONE] } },
  { key: 'lagoon', name: 'Barrier island and lagoon', w: [5, 18], rigid: 0.35, spacing: 70,
    need: { coast: 1, slope: [0, 0.40], temp: [0.35, 1] } },
  { key: 'cenote', name: 'Sinkhole field', w: [3, 12], rigid: 0.60, spacing: 70,
    need: { lith: [L.LIMESTONE], moist: [0.35, 1] } },
  { key: 'geyser', name: 'Hot spring field', w: [3, 10], rigid: 0.55, spacing: 90,
    need: { uplift: [0.80, 1], lith: [L.BASALT, L.GRANITE], moist: [0.25, 1], sea: 0 } },
  { key: 'rift', name: 'Rift valley', w: [10, 34], rigid: 0.55, spacing: 120,
    need: { uplift: [0.50, 0.95], relief: [0.35, 0.92] } },
  { key: 'oxbow', name: 'Meander belt', w: [6, 22], rigid: 0.15, spacing: 60,
    need: { river: 1, slope: [0, 0.35], moist: [0.45, 1] } },
  { key: 'crater', name: 'Impact crater', w: [4, 16], rigid: 0.95, spacing: 400,
    need: { sea: 0, slope: [0, 0.65] } },
  { key: 'arch', name: 'Natural arches', w: [2, 8], rigid: 0.70, spacing: 90,
    need: { lith: [L.SANDSTONE], moist: [0, 0.25], relief: [0.50, 0.95] } },
  { key: 'tufa', name: 'Tufa towers', w: [2, 8], rigid: 0.60, spacing: 80,
    need: { endorheic: 1, temp: [0.35, 1] } },
];
void A;

// The percentile machinery, shared by the layout pass and the autopsy so they can never disagree about what a
// contract means. Every field is ranked over LAND ONLY — "the top 10% of relief" is a statement about land.
function fieldRanks(w) {
  const { n, clim, relief, slope, flux, h, uplift, isSea } = w;
  const raw = { temp: clim.temp, moist: clim.moist, relief, slope, elev: h, uplift, flux };
  const rank = {};
  for (const key of Object.keys(raw)) {
    const src = raw[key];
    const land = []; for (let i = 0; i < n; i++) if (!isSea[i]) land.push(src[i]);
    land.sort((a, b) => a - b);
    const pct = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // binary search for the value's position in the land distribution
      let lo = 0, hi2 = land.length;
      while (lo < hi2) { const mid = (lo + hi2) >> 1; if (land[mid] < src[i]) lo = mid + 1; else hi2 = mid; }
      pct[i] = land.length ? lo / land.length : 0;
    }
    rank[key] = pct;
  }
  return rank;
}

function layoutFeatures(w) {
  const { n, lith, isSea, isLake, isRiver, lakes, lakeId, h, o } = w;
  const rank = w.rank || (w.rank = fieldRanks(w));
  const taken = new Int32Array(n).fill(-1);                     // which feature owns each sample
  const out = [];
  // Site scoring: does this sample satisfy the contract, and by how much margin? Margin matters — a feature
  // placed at the very edge of what it can tolerate is the one that will look wrong.
  // ⭐ PER-CLAUSE REFUSALS. A contract that places nowhere fails SILENTLY and looks exactly like a rule that was
  // never called — the answer this pipeline has needed five times now, and the reason `descents.js` grew its own
  // `why` tally. A conjunction of five clauses can be killed by any one of them, and knowing WHICH is the whole
  // difference between loosening the right number and loosening all five.
  // ⚠️ Counting only, no behaviour: `no()` returns -1 exactly as the bare `return -1` did.
  const WHY = out.why = {};
  let whyF = null;
  const no = (k) => { const t = WHY[whyF] || (WHY[whyF] = {}); t[k] = (t[k] || 0) + 1; return -1; };
  // ⭐⭐ ONE FUNCTION, TWO MODES, and it is deliberately not two functions. The guarantee below needs "which site
  // came CLOSEST to satisfying this contract", which is the same set of clauses read with a different verdict —
  // and this track's recorded lesson is that the same rule written twice produces two answers that disagree
  // (the volcano trunk: the placement walk, the cell loop and the diagnostic each had their own copy, and it
  // cost two wrong conclusions in one run). So `soft` swaps the verdict, never the clauses.
  //   soft === null   → hard: any failed clause returns -1 and is counted in the why-tally.
  //   soft === {}     → nearest-miss: nothing returns early; `soft.d` accumulates how far outside the contract
  //                     this site is, and the guarantee takes the smallest.
  // ⚠️ A CATEGORICAL CLAUSE IS EXPENSIVE TO VIOLATE (`CAT_MISS`) and a percentile band is charged by DISTANCE.
  // That ordering is the geology: "there is no river here" is a fact about the world and "this coast is not
  // quite cold enough" is a matter of degree, so a forced fjord lands on a steep coast that is too warm rather
  // than on a cold inland cliff. The forced instance is the world's best available compromise, which is exactly
  // what the user accepted ("a world with no subduction margin gets one anyway").
  const CAT_MISS = 4;
  const fit = (f, i, soft) => {
    const nd = f.need;
    const bad = (k, amt) => { if (!soft) return no(k); soft.d += amt; return 0; };
    if (nd.sea === 0 && (isSea[i] || isLake[i])) { if (bad('sea', CAT_MISS) === -1) return -1; }
    // ⚠️ A COAST IS A ZONE, NOT A LINE. Testing only the two immediate neighbours made "coastal" true for 110
    // samples in 8,192 — so fjords and deltas, which must ALSO satisfy other clauses, could never find a site.
    // Coastal plains, estuaries and fjord mouths all extend inland; three samples is 1,536 px.
    if (nd.coast === 1) {
      let near = 0;
      for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) if (isSea[k]) near = 1;
      if (isSea[i] || !near) { if (bad('coast', CAT_MISS) === -1) return -1; }
    }
    if (nd.shelf === 1 && !(isSea[i] && h[i] > o.seaLevel - 120)) { if (bad('shelf', CAT_MISS) === -1) return -1; }
    if (nd.river === 1 && !isRiver[i]) { if (bad('river', CAT_MISS) === -1) return -1; }
    // a river MOUTH is not one cell: the delta is the reach either side of where the channel meets the sea
    if (nd.nearRiver === 1) { let ok = 0; for (let k = Math.max(0, i - 5); k <= Math.min(n - 1, i + 5); k++) if (isRiver[k]) ok = 1; if (!ok) { if (bad('nearRiver', CAT_MISS) === -1) return -1; } }
    if (nd.lith && nd.lith.indexOf(lith[i]) < 0) { if (bad('lith', CAT_MISS) === -1) return -1; }
    if (nd.endorheic === 1) { const lk = lakeId[i] >= 0 ? lakes[lakeId[i]] : null; if (!lk || !lk.endorheic) { if (bad('endorheic', CAT_MISS) === -1) return -1; } }
    // 🟥 THIS ACCEPTED A RIVER, AND RIVERS NO LONGER CARRY WATER (2026-08-10, see cells.js `RIVER_WATER`). The
    // clause is used by exactly one feature — the OASIS — and an oasis is DEFINED by its water: a palm stand
    // round a dry gravel channel is not one. Measured after the rivers were drained and before this change:
    // 5 of 14 oases across three worlds had no water anywhere near them.
    // ⚠️ This is the kind of breakage that removing a subsystem causes two steps away, and nothing would have
    // reported it — the oasis still PLACED, so the feature census stayed green. It was found by asking what
    // else read `isRiver`, which is the check worth doing whenever something is deleted.
    if (nd.nearWater === 1) {
      let near = 0;
      for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) if (isLake[k]) near = 1;
      if (!near) { if (bad('nearWater', CAT_MISS) === -1) return -1; }
    }
    // Margin matters as well as membership: a feature sitting at the very edge of what it tolerates is the one
    // that will look wrong, so a site in the middle of its band scores higher than one at the boundary.
    let score = 1;
    for (const key of ['temp', 'moist', 'relief', 'slope', 'elev', 'uplift', 'flux']) {
      const r = nd[key]; if (!r) continue;
      const v = rank[key][i];
      if (v < r[0] || v > r[1]) {
        // outside the band: charged by HOW FAR outside, in percentile points, so "a bit too warm" beats "not
        // remotely cold". Every field here is already a rank in 0..1, so the distances are commensurable.
        if (bad(key, v < r[0] ? r[0] - v : v - r[1]) === -1) return -1;
        continue;
      }
      const span = r[1] - r[0];
      const d = span > 0 ? Math.min(v - r[0], r[1] - v) / span : 1;
      score *= 0.4 + 0.6 * Math.min(1, d * 4);
    }
    return score;
  };
  // The nearest miss: the site with the smallest total shortfall. Only ever consulted when the contract admits
  // NO site in the whole world, and it scans the same samples the hard pass just scanned.
  const nearestMiss = (f) => {
    let at = -1, bestD = Infinity, bestS = 0;
    for (let i = 0; i < n; i++) {
      const soft = { d: 0 };
      const s = fit(f, i, soft);
      if (soft.d < bestD) { bestD = soft.d; at = i; bestS = s; }
    }
    return { at, score: bestS, shortfall: bestD };
  };
  // ⭐ THE PLACEMENT TALLY — the why-tally's twin, and the missing half of the same diagnosis. `WHY` explains why
  // a SAMPLE failed the contract; this explains why a feature that HAD candidate samples still placed nothing.
  // Those are different failures with opposite fixes (loosen the geology vs. override the separation), and the
  // census could not tell them apart, so the guarantee below would have had to guess which one to override.
  const PLACE = out.place = {};
  for (let fi = 0; fi < FEATURES.length; fi++) {
    const f = FEATURES[fi];
    whyF = f.key;
    const cand = [];
    for (let i = 0; i < n; i++) { const s = fit(f, i); if (s > 0) cand.push([s * (0.7 + 0.6 * h1(o.seed, 300 + fi, i)), i]); }
    cand.sort((a, b) => b[0] - a[0]);
    const P = PLACE[f.key] = { cand: cand.length, overlap: 0, spacing: 0, placed: 0, forced: 0 };
    let placed = 0, lastAt = -1e9;
    const widthAt = (i) => f.w[0] + Math.round(h1(o.seed, 400 + fi, i) * (f.w[1] - f.w[0]));
    const put = (i, sc, forced) => {
      const wid = widthAt(i);
      const A = Math.max(0, i - (wid >> 1)), Bb = Math.min(n - 1, i + (wid >> 1));
      for (let k = A; k <= Bb; k++) taken[k] = out.length;
      out.push({ type: f.key, name: f.name, at: i, a: A, b: Bb, w: wid, rigid: f.rigid, score: sc, forced: !!forced });
      placed++; P.placed++; if (forced) P.forced++;
    };
    for (const [sc, i] of cand) {
      const wid = widthAt(i);
      // ⭐ RIGIDITY IS A NUMBER: a rigid feature demands clearance proportional to how little it can bend, and
      // an elastic one is happy to sit right next to a neighbour and blend.
      const clear = Math.round(wid * (0.5 + 1.6 * f.rigid));
      const a = Math.max(0, i - (wid >> 1) - clear), b = Math.min(n - 1, i + (wid >> 1) + clear);
      let free = true;
      for (let k = a; k <= b; k++) if (taken[k] >= 0) { free = false; break; }
      if (!free) { P.overlap++; continue; }
      if (i - lastAt < f.spacing) { P.spacing++; continue; }
      put(i, sc, false);
      lastAt = i;
    }
    // ⭐⭐ THE GUARANTEE. There will be ONE world, so a feature that places nowhere in it does not exist at all —
    // the user's ruling of 2026-08-10, which supersedes the earlier "rare is correct". Same shape as the volcano
    // entrance guarantee: decided in the placement pass where it can be CHECKED, not hoped for downstream.
    // 🟥 IT OVERRIDES THE DICE AND THE SEPARATION, NOT THE GEOLOGY, and that distinction is the whole design.
    // Loosening the clauses until everything places turns a subduction trench into a ditch. So:
    //   - if candidate sites EXISTED and only clearance/spacing refused them, take the best one regardless. The
    //     contract is fully satisfied there; nothing about the feature is compromised.
    //   - only if the world contains NO site that satisfies the contract does it fall back to the NEAREST MISS,
    //     which is `softFit`: the site whose shortfall outside its bands is smallest. That is one forced instance
    //     at the best place the world has, not a permanently loosened rule for every instance.
    if (!placed) {
      let best = -1, bestSc = 0;
      for (const [sc, i] of cand) if (sc > bestSc) { bestSc = sc; best = i; }   // contract-satisfying, just crowded
      if (best < 0) { const m = nearestMiss(f); best = m.at; bestSc = m.score; P.shortfall = +m.shortfall.toFixed(3); }
      if (best >= 0) put(best, bestSc, true);
    }
  }
  out.sort((x, y) => x.at - y.at);
  return out;
}

// ⭐⭐ WHY DID THIS FEATURE NOT PLACE? Ten of sixteen features placed NOWHERE in the first three runs, and the
// reason turned out to be the same one every time: I had written contract thresholds against numbers I had
// never measured (local relief, which I guessed at 180-420 and which was actually ~20). A feature that places
// nowhere fails SILENTLY, exactly like a material that generates nowhere — so the diagnosis has to be a
// per-CLAUSE report, not a total. This is the same shape as `poolStats` counting refusals by reason.
function contractReport(W) {
  const { n, clim, lith, uplift, relief, slope, flux, h, isSea, isLake, isRiver, lakes, lakeId, o } = W;
  const rank = W.rank || (W.rank = fieldRanks(W));
  const val = { temp: (i) => rank.temp[i], moist: (i) => rank.moist[i], relief: (i) => rank.relief[i],
    slope: (i) => rank.slope[i], elev: (i) => rank.elev[i], uplift: (i) => rank.uplift[i], flux: (i) => rank.flux[i] };
  const raw = { temp: clim.temp, moist: clim.moist, relief, slope, elev: h, uplift, flux };
  const out = [];
  for (const f of FEATURES) {
    const rows = [];
    let survivors = new Uint8Array(n).fill(1);
    const note = (label, test) => {
      let pass = 0, both = 0;
      for (let i = 0; i < n; i++) { const t = test(i) ? 1 : 0; if (t) pass++; if (t && survivors[i]) both++; survivors[i] = survivors[i] && t ? 1 : 0; }
      rows.push([label, pass, both]);
    };
    const nd = f.need;
    if (nd.sea === 0) note('not water', (i) => !isSea[i] && !isLake[i]);
    if (nd.coast === 1) note('coastal', (i) => !isSea[i] && (isSea[Math.max(0, i - 1)] || isSea[Math.min(n - 1, i + 1)]));
    if (nd.shelf === 1) note('shelf', (i) => isSea[i] && h[i] > o.seaLevel - 120);
    if (nd.river === 1) note('river', (i) => !!isRiver[i]);
    if (nd.nearRiver === 1) note('near river', (i) => { for (let k = Math.max(0, i - 5); k <= Math.min(n - 1, i + 5); k++) if (isRiver[k]) return true; return false; });
    if (nd.lith) note('lith ' + nd.lith.map(l => LITH[l]).join('/'), (i) => nd.lith.indexOf(lith[i]) >= 0);
    if (nd.endorheic === 1) note('endorheic', (i) => { const lk = lakeId[i] >= 0 ? lakes[lakeId[i]] : null; return !!(lk && lk.endorheic); });
    if (nd.nearWater === 1) note('near water', (i) => { for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) if (isLake[k] || isRiver[k]) return true; return false; });
    for (const key of ['temp', 'moist', 'relief', 'slope', 'elev', 'uplift', 'flux'])
      if (nd[key]) note(`${key} pct ${nd[key][0]}..${nd[key][1]}`, (i) => val[key](i) >= nd[key][0] && val[key](i) <= nd[key][1]);
    let alive = 0; for (let i = 0; i < n; i++) alive += survivors[i];
    out.push({ key: f.key, name: f.name, rows, alive });
  }
  // the RAW distributions, so the terrain itself can still be judged (percentile contracts always "fit", so
  // they can no longer tell you the world has gone flat — that has to be watched separately)
  const stats = {};
  for (const key of Object.keys(raw)) {
    const a = []; for (let i = 0; i < W.n; i++) if (!isSea[i]) a.push(raw[key][i]);
    a.sort((x, y) => x - y);
    const p = (q) => a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : 0;
    stats[key] = { p10: p(0.10), p50: p(0.50), p90: p(0.90), p99: p(0.99), max: a.length ? a[a.length - 1] : 0 };
  }
  return { out, stats };
}

// ==============================================================================================================
//  THE BOUNDARY CONTRACT, ACTUALLY APPLIED — the part that decides whether stitching works.
//
//  Placement alone only says a feature MAY go here. The contract is about what happens at its EDGE, and this is
//  where the elastic/rigid distinction stops being a label and does some work:
//
//    lift    how far it moves the ground at its centre, in rows. A volcano piles up; a canyon cuts down.
//    flat    how strongly it pulls the ground toward its own mean — a dune sea and a salt pan are defined by
//            flatness, and imposing THAT is more of what they are than any elevation change.
//    grain   short-wavelength texture it adds (badlands rills, karst towers, dune crests).
//    rigid   drives BOTH the width of the blend and how completely the feature overrides what was there.
//
//  ⭐ A RIGID FEATURE HAS A NARROW, HARD EDGE AND A WIDE EXCLUSION ZONE; AN ELASTIC ONE HAS A LONG SOFT EDGE AND
//  NEEDS NO CLEARANCE. That single number therefore produces "bare rolling terrain stitches with anything, a
//  volcano does not" without anyone writing an adjacency table — which was the whole claim being tested.
//
//  ⚠️ Applied AFTER placement and BEFORE drainage is recomputed, because a feature that moves the ground moves
//  the water too: a volcano diverts a river, a canyon captures one, a salt pan has to actually be the low point
//  of its basin. Placing on the pre-feature terrain and then re-running the water is one iteration of a loop
//  that in principle never terminates; one is enough and the alternative is circular.
// ==============================================================================================================
const SHAPE = {
  volcano: { lift: 300, flat: 0.15, grain: 0, prof: 'cone' },
  caldera: { lift: 210, flat: 0.20, grain: 0, prof: 'caldera' },
  fjord: { lift: -300, flat: 0.10, grain: 0, prof: 'notch' },
  delta: { lift: -25, flat: 0.90, grain: 0, prof: 'plateau' },
  canyon: { lift: -170, flat: 0.25, grain: 6, prof: 'notch' },
  gorge: { lift: -200, flat: 0.10, grain: 4, prof: 'notch' },
  mesa: { lift: 55, flat: 0.85, grain: 18, prof: 'plateau' },
  badlands: { lift: -20, flat: 0.30, grain: 42, prof: 'plateau' },
  dunes: { lift: 30, flat: 0.78, grain: 22, prof: 'plateau' },
  oasis: { lift: -18, flat: 0.70, grain: 0, prof: 'notch' },
  saltpan: { lift: -14, flat: 0.96, grain: 0, prof: 'plateau' },
  swamp: { lift: -10, flat: 0.92, grain: 0, prof: 'plateau' },
  karst: { lift: 45, flat: 0.35, grain: 60, prof: 'plateau' },
  glacier: { lift: -70, flat: 0.55, grain: 0, prof: 'notch' },
  reef: { lift: 45, flat: 0.50, grain: 8, prof: 'plateau' },
  escarp: { lift: 90, flat: 0.30, grain: 0, prof: 'step' },
  plateau: { lift: 45, flat: 0.92, grain: 6, prof: 'plateau' },
  inselberg: { lift: 200, flat: 0.10, grain: 0, prof: 'cone' },
  hoodoo: { lift: 30, flat: 0.45, grain: 58, prof: 'plateau' },
  fan: { lift: -18, flat: 0.75, grain: 8, prof: 'step' },
  moraine: { lift: 26, flat: 0.30, grain: 34, prof: 'plateau' },
  seacliff: { lift: 70, flat: 0.20, grain: 0, prof: 'step' },
  lagoon: { lift: -34, flat: 0.90, grain: 6, prof: 'plateau' },
  cenote: { lift: -14, flat: 0.60, grain: 24, prof: 'plateau' },
  geyser: { lift: 14, flat: 0.70, grain: 12, prof: 'plateau' },
  rift: { lift: -170, flat: 0.40, grain: 14, prof: 'notch' },
  oxbow: { lift: -14, flat: 0.95, grain: 0, prof: 'plateau' },
  crater: { lift: -95, flat: 0.20, grain: 0, prof: 'caldera' },
  arch: { lift: 40, flat: 0.40, grain: 44, prof: 'plateau' },
  tufa: { lift: 34, flat: 0.30, grain: 48, prof: 'plateau' },
};
// The influence profile across the feature. t runs -1..1 over the body, and |t| > 1 is the blend skirt.
function profileAt(kind, t, rigid) {
  const a = Math.abs(t);
  // The skirt: a rigid feature's influence falls away fast (a hard edge); an elastic one's trails off.
  const skirt = a <= 1 ? 1 : Math.max(0, 1 - (a - 1) / (1 + 3.2 * (1 - rigid)));
  const s = skirt * skirt * (3 - 2 * skirt);
  if (a > 1) return { w: s, k: 0 };
  switch (kind) {
    case 'cone': return { w: 1, k: Math.pow(1 - a, 1.5) };
    case 'caldera': return { w: 1, k: Math.pow(1 - a, 1.4) - 1.35 * Math.exp(-Math.pow(a / 0.34, 2)) };
    case 'notch': return { w: 1, k: Math.pow(Math.cos(a * Math.PI / 2), 0.75) };
    // 🟥 THESE TWO WERE LINEAR RAMPS AND THEY READ AS WALLS. `min(1, (1-a)*4)` goes from nothing to everything
    // across the outer quarter of the body — on a six-sample feature that is one and a half samples, i.e. a
    // cliff, and a plateau came out as a rectangle sitting on the landscape. Smoothstepped, and over a third of
    // the body rather than a quarter, so the shoulder is a shoulder.
    case 'plateau': return { w: 1, k: smooth(Math.min(1, (1 - a) * 3)) };
    case 'step': return { w: 1, k: t < 0 ? 0 : smooth(Math.min(1, t * 2.2)) };
    default: return { w: 1, k: 1 - a };
  }
}
function applyFeatures(W) {
  const { n, h, o } = W;
  const base = Float32Array.from(h);
  const acc = new Float32Array(n), wsum = new Float32Array(n);
  const flatW = new Float32Array(n), flatTo = new Float32Array(n);
  for (const f of W.features) {
    const S = SHAPE[f.type]; if (!S) continue;
    const half = Math.max(1, (f.b - f.a) / 2 + 0.5), mid = (f.a + f.b) / 2;
    const skirtN = Math.ceil(half * (1 + 3.2 * (1 - f.rigid)));
    // the mean the feature flattens TOWARD is its own body's mean, so it sits in the landscape it found
    let m = 0, c = 0;
    for (let i = f.a; i <= f.b; i++) { m += base[i]; c++; }
    m = c ? m / c : 0;
    f.meanElev = m;
    for (let i = Math.max(0, Math.round(mid - half - skirtN)); i <= Math.min(n - 1, Math.round(mid + half + skirtN)); i++) {
      // ⚠️ THE EDGE ITSELF IS PERTURBED, not just softened. A feature whose influence ends at exactly the same
      // fraction in every column has a straight boundary, and a straight boundary is visible however smooth the
      // ramp across it is — the same objection that killed the analytic lens shapes on the shipped generator.
      const t = (i - mid) / half + (vn(o.seed, 950 + (f.at & 1023), i / 6.5) - 0.5) * 0.13;
      const { w, k } = profileAt(S.prof, t, f.rigid);
      if (w <= 0) continue;
      const g = S.grain ? (vn(o.seed, 900 + f.at, i / 2.6) - 0.5) * 2 * S.grain * Math.max(0, k) : 0;
      acc[i] += w * (S.lift * k + g); wsum[i] += w;
      const fl = w * S.flat * Math.max(0, Math.min(1, k * 1.4));
      if (fl > flatW[i]) { flatW[i] = fl; flatTo[i] = m + S.lift * k * 0.35; }
    }
  }
  for (let i = 0; i < n; i++) {
    if (wsum[i] > 0) h[i] = base[i] + acc[i] / Math.max(1, wsum[i]);
    if (flatW[i] > 0) h[i] = lerp(h[i], flatTo[i], Math.min(0.95, flatW[i]));
  }
  // ⭐ THE SEAM MEASUREMENT — the actual test of whether stitching works, and the reason this returns a number.
  // A feature that drops a cliff at its own boundary has not stitched, it has been pasted. Compared against the
  // steepest slopes the natural terrain already makes, because a join no worse than an ordinary mountainside is
  // not a seam — it is terrain.
  let natural = 0;
  const nat = [];
  for (let i = 1; i < n - 1; i++) nat.push(Math.abs(base[i + 1] - base[i]));
  nat.sort((a, b) => a - b); natural = nat[Math.floor(nat.length * 0.995)] || 1;
  // ⚠️ MEASURED ON THE MODIFICATION, AT THE OUTER EDGE OF THE SKIRT — not on the finished ground at the body
  // edge, which the first version did and which conflates two different things. An escarpment is SUPPOSED to
  // drop a cliff inside itself; that is what an escarpment is. The question a contract answers is narrower:
  // where the feature's influence runs out, does it meet untouched terrain smoothly, or is there a step?
  // So: the gradient of (h - base), sampled where the influence reaches zero.
  const mod = new Float32Array(n);
  for (let i = 0; i < n; i++) mod[i] = h[i] - base[i];
  let worst = 0, over = 0, edges = 0;
  for (const f of W.features) {
    const half = Math.max(1, (f.b - f.a) / 2 + 0.5), mid = (f.a + f.b) / 2;
    const skirtN = Math.ceil(half * (1 + 3.2 * (1 - f.rigid)));
    for (const e of [Math.round(mid - half - skirtN), Math.round(mid + half + skirtN)]) {
      if (e <= 0 || e >= n - 1) continue;
      edges++;
      const d = Math.max(Math.abs(mod[e] - mod[e - 1]), Math.abs(mod[e + 1] - mod[e]));
      if (d > worst) worst = d;
      if (d > natural) over++;
    }
  }
  return { natural, worst, over, edges };
}

// ==============================================================================================================
//  SKY AND DEEP — the two bands the surface layout cannot reach.
//  ⭐ ONE CANDIDATE PER LATTICE CELL IS REAL, not a coin flip per anchor. A coin flip gives an EXPECTED density
//  and no guarantee, so a site could be placed in a band with nothing within a day's walk. Guaranteeing one per
//  cell puts a hard BOUND on how far anything has to travel to find its band's ground; variety comes from size
//  and position, both hashed. (Minecraft's spacing/separation rule, and the shipped generator's too.)
//  ⚠️ Elevations here are derived from the band fractions rather than typed in, so if the world's height budget
//  moves, the bands move with it instead of quietly drifting out of the range domains.js is asking about.
// ==============================================================================================================
const BAND = { skyLo: 0.04, skyHi: 0.33, ugLo: 0.67, ugHi: 0.97 };

function layoutSky(W) {
  const { n, o } = W;
  const rows = 4096, seaRow = Math.round(rows * 0.47);           // the shape cell synthesis renders into
  const eHi = seaRow - rows * BAND.skyLo, eLo = seaRow - rows * BAND.skyHi;
  // ⚠️ THE SPACING IS SET BY WHAT domains.js NEEDS, NOT BY TASTE. Sites are placed ~30,720 px apart, so a band
  // whose ground comes one per 97,000 px leaves whole runs of sites with nowhere to stand — measured at 190
  // samples: an 11% hit rate and a 507,000 px gap, about sixteen consecutive sites. The lattice is the dial.
  const STEP = 80, out = [];
  for (let a = STEP; a < n - STEP; a += STEP) {
    const j = Math.round((h1(o.seed, 861, a) - 0.5) * STEP * 0.7);
    const i = Math.max(2, Math.min(n - 3, a + j));
    // ⚠️ 4-20 samples wide by 26-72 rows thick is a LENS, not a place: an aspect ratio of 1:15 with no relief
    // on top, which is why the sky band read as slabs of rock with grass on. Wider still, and much thicker, so
    // there is room for a landscape and a keel — see sky.js.
    const hw = 7 + Math.round(h1(o.seed, 863, a) * 26);
    const top = 60 + Math.round(h1(o.seed, 865, a) * 120), bot = Math.round(top * 1.5);
    // clear of the ground beneath it — a peak squeezes the available sky, and a candidate that cannot fit
    // simply does not exist here rather than being jammed into the mountain.
    let ground = -Infinity;
    for (let k = Math.max(0, i - hw); k <= Math.min(n - 1, i + hw); k++) if (W.h[k] > ground) ground = W.h[k];
    const lo = Math.max(eLo, ground + 120) + bot, hi = eHi - top;
    if (hi <= lo) continue;
    const cy = lo + h1(o.seed, 867, a) * (hi - lo);
    out.push({ a: i, hw, top, bot, cy, seed: (a * 2654435761) >>> 0 });
  }
  return out;
}

function layoutDeep(W) {
  const { n, o } = W;
  const rows = 4096, seaRow = Math.round(rows * 0.47);
  const eHi = seaRow - rows * BAND.ugLo, eLo = seaRow - rows * BAND.ugHi;
  const STEP = 60, out = [];
  for (let a = STEP; a < n - STEP; a += STEP) {
    const j = Math.round((h1(o.seed, 871, a) - 0.5) * STEP * 0.7);
    const i = Math.max(2, Math.min(n - 3, a + j));
    const hw = 5 + Math.round(h1(o.seed, 873, a) * 22);
    const hh2 = 14 + Math.round(h1(o.seed, 875, a) * 34);
    const lo = eLo + hh2, hi = Math.min(eHi, W.h[i] - 300) - hh2;
    if (hi <= lo) continue;
    const cy = lo + h1(o.seed, 877, a) * (hi - lo);
    // ⚠️ A HALL HAS A FLOOR. The point of the band is somewhere to STAND, so the lower part of the chamber is
    // filled flat rather than left as the bottom of an ellipse — you cannot stand on the inside of a curve.
    out.push({ a: i, hw, hh: hh2, cy, floor: cy - hh2 * (0.45 + 0.25 * h1(o.seed, 879, a)), seed: (a * 40503) >>> 0 });
  }
  return out;
}

module.exports = { buildWorld, BIOME, B, LITH, L, FEATURES, contractReport, applyFeatures, SHAPE, BAND };
