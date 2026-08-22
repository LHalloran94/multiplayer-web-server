'use strict';
// ==============================================================================================================
//  worldspike/cells.js — CELL SYNTHESIS: turning a coarse record into actual ground.
//
//  The coarse pipeline decides WHERE things are. This decides what they are MADE OF, one cell at a time, and it
//  is where the form/dressing split is finally testable rather than merely asserted:
//
//      FORM     the shape of the ground. Comes from the coarse heightfield plus a per-feature fine signature —
//               a mesa is terraced, a dune field is smooth crests, karst is spiky, badlands are rilled.
//      DRESSING what covers and fills it. Comes from climate, altitude, slope, depth and lithology, and knows
//               NOTHING about which landform it is sitting on.
//
//  ⭐ THE TEST: render the same landform under four climates. If it comes out convincingly Alpine, Andean,
//  Saharan and Arctic from ONE shape generator, the split works and the catalogue only has to contain forms.
//  If it does not, we would need a snow-mountain and a desert-mountain as separate features, and the content
//  cost of the whole world roughly squares.
//
//  ⚠️ MATERIALS ARE THE DELIVERABLE AS MUCH AS THE PICTURE IS. The palette below is deliberately larger than the
//  game's current one — it is the answer to "what terrain types do we actually need", arrived at by writing the
//  dressing rules and seeing what they kept wanting to reach for.
// ==============================================================================================================
const { LITH, L } = require('./pipeline.js');
const { prepareUnder, underAt, depositAt, voidMaterial } = require('./under.js');
const { prepareVolcanoes, settleVolcanoes, craterDetail, volcanoNear, volcanoAt, sealed } = require('./volcano.js');
const { prepareVoids, voidAt, voidsNear } = require('./voids.js');
const { prepareCaves, caveAt, mouthClearAt, dolineDetail, levelRow, levelBore, cavesNear } = require('./caves.js');
const { buildSpecies, drawFlora } = require('./flora.js');
const { prepareSky, skyAt, skyColumnInfo, skyNear } = require('./sky.js');
const { prepareDeep, deepAt, deepColumnInfo } = require('./deepland.js');
const { prepareFormations, formationAt, decorate, prepareRimstone, fillRimstone } = require('./formations.js');
const MINMOD = require('./minerals.js');
const { buildMinerals, mineralAt, calibrate, mineralsNear, oreBodiesNear, oreBodyAt } = MINMOD;
const { prepareDescents, descentAt, descentsNear } = require('./descents.js');
const { prepareVents, ventAt, ventsNear } = require('./vents.js');

// ⭐⭐ RIVERS CARRY NO WATER — THE USER'S DECISION, 2026-08-10, AND IT IS A DESIGN CHANGE, NOT A BUG FIX.
// A river's surface was DEFINED as the coarse ground height (`riverElevAt` = interpolated `h` minus 3), so it
// followed the terrain instead of being level. Measured over three worlds: the sea and the lakes are perfectly
// flat (0 rows of spread, 0% not level, they are filled to an ELEVATION) while 38-59% of river bodies are not
// level, the worst varying 275 rows — 2,200 px — across twelve columns. The impact crater the user photographed
// is this exactly: not a lake at all, but a river crossing a crater whose profile has a CENTRAL PEAK, so the
// coarse ground humps 406 -> 461 -> 401 and the water surface humps with it.
//
// ⭐ THEIR REASONING FOR DELETING RATHER THAN LEVELLING: a weather system is coming. Rain will generate flows
// where the terrain actually sends them, they will run once when a player first meets them and then settle, and
// that is a better river than one placed by a drainage solver and painted on at map-generation time. The parked
// "chain of level pools" cure is therefore not wanted — it would be work spent propping up the thing being
// replaced. Their words: "too many of them and they are in improper places sometimes".
//
// ⚠️ WHAT THIS DOES **NOT** REMOVE, deliberately. `isRiver` and the whole drainage solve stay exactly as they
// are: they carve the valleys (stream-power erosion is most of what makes the terrain read as terrain), and
// they are what the canyon, gorge, meander-belt and delta contracts are sited on. A dry canyon with no river in
// it is correct — the river cut it and the water has gone. Only the standing WATER is removed.
// ⚠️ The switch stays so the two can be rendered side by side; it is not expected to be turned back on.
const RIVER_WATER = process.env.RIVER_WATER === '1';

const { liquidFor, situationOf, atDepth } = require('./liquids.js');
const { TABLE: MTABLE } = require('./materials.js');
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// twelve others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');
const FAULT_LAT = nlat(620);
// How much of the pack is open LEADS. ⚠️ TUNED BY MEASUREMENT, and the first value was wrong in a way that only
// a measurement shows: 0.455 left the pack 35-44% OPEN across six seeds, which is a marginal ice zone in break-up
// rather than pack ice. Real pack is 85-95% closed, and `fb1` concentrates near 0.5 so the threshold has to sit
// well below the middle to cut only the tail. Read the open fraction back, do not reason about it.
const LEAD_T = 0.408;      // the fold/fault anchor lattice, quantised to tile the period

// ---- the palette -------------------------------------------------------------------------------------------
// name, colour, and whether it is a powder (falls), a fluid, or a plant (needs support)
const MATS = [
  ['air', '#000000'], ['water', '#2f6f9e'], ['ice', '#bcd8e6'], ['snow', '#f2f7fb'],
  ['turf', '#4f7a35'], ['loam', '#5b4636'], ['clay', '#8a6b52'], ['peat', '#3d3226'],
  ['sand', '#d8bd7e'], ['scree', '#8d8b86'], ['stone', '#6b7280'], ['granite', '#a89a92'],
  ['basalt', '#41434c'], ['limestone', '#cfc7a8'], ['sandstone', '#c8a86a'], ['shale', '#6a6a5c'],
  ['salt', '#e8e4d6'], ['wood', '#5a4028'], ['leaves', '#3f7a3a'], ['scrub', '#7d7a45'],
  ['cactus', '#4f7f52'], ['moss', '#6f8f4f'], ['lava', '#d4501e'], ['oilshale', '#3a3a42'],
  ['iron', '#8a6a5a'], ['copper', '#4f8f7a'], ['crystal', '#9fd8e8'], ['permafrost', '#93a9b4'],
  ['ash', '#6d6a66'], ['mud', '#4a3b2c'], ['gravel', '#9a9288'], ['driftwood', '#7a6a52'],
  // added by the underground design — each of these is a thing the geology rules reached for and could not name
  ['coal', '#26242a'], ['quartz', '#d8d4e4'], ['obsidian', '#1a1820'],
  // …and by the broadened catalogue: tufa/travertine at hot springs and closed-lake shores, pumice around vents
  ['tufa', '#ddd6bd'], ['pumice', '#b5aca0'],
  // …and by the FLORA pass. ⚠️ `scrub`, `moss` and `driftwood` were already declared above and NO RULE WROTE ANY
  // OF THEM — the palette had got ahead of the dressing rules, which is backwards from the principle that
  // materials are an output of writing the rules. They have niches now, and these five are the ones the new
  // species reached for and could not name.
  ['needle', '#2f5d3a'], ['frond', '#5f9e46'], ['reed', '#8a9a4a'], ['kelp', '#2f5a4a'], ['fungus', '#c0a6d0'],
  // …and by the MINERAL table. ⚠️ Fourteen at once looks extravagant, and it is the cheapest batch in the whole
  // design: a mineral is a colour plus four numbers in a table, and it is the one thing in this world a player
  // goes LOOKING for. The shapes are what cost anything, and there are seven of those for twenty-two minerals.
  ['gold', '#e8c34a'], ['silver', '#cfd6da'], ['galena', '#5a5f6b'], ['tin', '#9aa7ad'],
  ['pyrite', '#c9a33a'], ['hematite', '#8a3b30'], ['malachite', '#2f8f6a'], ['cinnabar', '#b03a3a'],
  ['sulphur', '#e0d24a'], ['amethyst', '#8f6fc0'], ['emerald', '#2fa06a'], ['diamond', '#d8f0f7'],
  ['opal', '#dcc9e0'], ['bauxite', '#b5714a'],
  // …and the FAMOUS ones, added because they are famous — the user's call, and a good one: recognising a
  // material is most of what makes finding it feel like anything. ⚠️ Each still gets a REAL association, so a
  // ruby turns up in marble and a sapphire in basalt rather than both being scattered wherever.
  ['ruby', '#c02040'], ['sapphire', '#3a6fd0'], ['jade', '#3f9b76'], ['turquoise', '#3fc0c8'],
  ['topaz', '#f0c040'], ['garnet', '#8f2b3a'], ['lapis', '#2a3a8c'], ['agate', '#c88f6a'],
  ['platinum', '#e8eef2'], ['uranium', '#7ad14a'], ['amber', '#d2761e'], ['flint', '#3a3f44'],
  ['marble', '#efeae2'],
  // …and by the LIQUID PASS. ⭐ The world had TWO liquids, water and lava, while the shipped generator it is
  // meant to replace has five — so this closes a regression rather than adding a feature. They are not a list:
  // each is a POINT in the situation space in `liquids.js`, and the placement rules never name one.
  // ⚠️ Four of these already exist in the game (brine 14, acid 12, oil 15, quicksand 10) and four do not.
  // ⚠️ CRUDE OIL IS BLACK. The game's `Oil` is COOKING oil — a yellow fluid from the level creator that coats
  // you slick — so reusing id 15 means the same id is two different substances. Flagged, not resolved: the
  // user's ruling is that colour is a placeholder, so this is a game-side design decision, not a spike one.
  ['brine', '#1f8f86'], ['acid', '#7fd41a'], ['oil', '#3d2b12'], ['tar', '#1c1712'],
  ['quicksand', '#9a7d3c'], ['slurry', '#5e4a30'], ['hotspring', '#6fd0c8'], ['lavathick', '#a63a12'],
  // …and by the OVERLOOKED batch. CORAL: the catalogue has had a Coral reef landform all along and there was
  // no coral to build it out of. SLATE / QUARTZITE / GNEISS: marble existed as 'cooked limestone' and was the
  // world's ONLY metamorphic rock, so shale — 21.9% of everything — had no cooked form.
  // ⚠️ WORKING COLOURS, and two of them were CHOSEN AGAINST THE COLLISION MEASUREMENT rather than picked by eye.
  // gneiss started at #b0a49c: dE 3.7 from granite with 8,010 contacts, the worst pair in the whole palette —
  // and a metamorphic body sits INSIDE its own parent rock by definition, so that is the one place a collision
  // is guaranteed to matter. Real gneiss is banded and pinker than its granite, so it moves that way.
  // slate started at #4a5058: dE 6.9 from galena with 1,435 contacts. Real slate is bluer and darker.
  ['coral', '#e0836f'], ['slate', '#33414f'], ['quartzite', '#e2d8cc'], ['gneiss', '#9a7f80'],
  // ⭐ ABYSSAL OOZE — the abyssal plain had the world's most distinctive floor and wore whatever the local
  // lithology happened to be. Real abyssal sediment is the shells of plankton raining down for millions of
  // years: a pale, soft, featureless blanket, and it is WHY the plain is the flattest surface on the planet.
  // Pale grey-buff, softer than clay (s: 1) because it is barely consolidated.
  ['ooze', '#cfc9b4'],
  // …and by the LIFE batch. LICHEN: the cliff fix created bare rock across the world and nothing grew on it —
  // fixing one thing made a niche nothing filled. VINE: a plant that hangs from a ceiling, which the species
  // table cannot express because every plant in it is anchored at the ground; it lives in the speleothem
  // post-pass instead, which already walks every void's roof. Roots are WOOD and need no material of their own.
  ['lichen', '#9fae86'], ['vine', '#4c8a3e'],
  // …and by the FINDABLES batch. METEORITE goes with the Impact crater landform, which the catalogue has had
  // all along with nothing associated to it. REALGAR and ORPIMENT are the two most vivid minerals that occur
  // in nature and cost a colour and four numbers each. GYPSUM was being done by generic `crystal`.
  ['meteorite', '#6b5f66'], ['gypsum', '#efe6f2'], ['fluorite', '#7ad0b0'],
  ['realgar', '#e0522c'], ['orpiment', '#f2c024'], ['conglomerate', '#a89273'],
];
const M = {}; MATS.forEach(([k], i) => { M[k] = i; });

// ⚠️ DERIVED FROM materials.js, NEVER LISTED. Two probes on this track were caught holding hard-coded material
// lists that would have gone on passing while quietly ignoring eight new liquids; a list here would rot the same
// way the moment a species is added.
const IS_PLANT = new Uint8Array(256), IS_LIQ = new Uint8Array(256);
MATS.forEach(([k], i) => {
  const t = MTABLE[k]; if (!t) return;
  if (t.b === 'plant') IS_PLANT[i] = 1;
  if (t.b === 'fluid' || t.b === 'hazard') IS_LIQ[i] = 1;
});

// ⭐ HOW A PLACED MOUTH IS KEPT OPEN. Switchable so the candidates could be RENDERED SIDE BY SIDE off one build
// rather than argued about — the user asked to see them before choosing, which is the right way round, and the
// picture then refuted the one that read better on paper.
//   'clear'   SHIPPING. A chimney is kept clear through whatever stands on the ground.
//             Measured: entrances open 35/55 -> 55/55, settled water unchanged at 0.0019%.
//   'none'    what shipped before: 19 of 55 entrances sealed under a canopy. Kept so the switch can be used to
//             mutation-test the rule — a guard that cannot be made to fail is not measuring anything.
//   'doline'  🟥 A DEMONSTRATOR, NOT A CANDIDATE. The ground dips into a collapse funnel at the mouth, which is
//             what a karst entrance actually is and was the more attractive of the two on paper. MEASURED, IT
//             DOES NOT WORK: 0 of 184 cells still reached, because a canopy spans a funnel just as happily as a
//             flat hole — the trees on the rim are taller than the funnel is deep. Kept, because a doline is
//             worth having for its own sake in the world-design overhaul, where it would sit ON TOP of the
//             clearing rather than instead of it.
let MOUTH = process.env.MOUTH || 'clear';
const setMouthMode = (m) => { MOUTH = m; };

const SPECIES = buildSpecies(M);
const MINERALS = calibrate(buildMinerals(M), 20260101);
const LITH_MAT = { [L.BASEMENT]: M.granite, [L.GRANITE]: M.granite, [L.BASALT]: M.basalt,
  [L.SANDSTONE]: M.sandstone, [L.LIMESTONE]: M.limestone, [L.SHALE]: M.shale, [L.EVAPORITE]: M.salt };

// ---- noise, independent again ------------------------------------------------------------------------------
// ==============================================================================================================
//  THE CLIFF RISER — and the reason it has to exist at all.
//
//  🟥🟥 THE COARSE FIELD IS ONE SAMPLE PER 64 CELLS, SO IT CANNOT MAKE A CLIFF. The steepest surface it can
//  produce is the feature's whole lift spread over one sample spacing, and `probe_signatures.js` measured
//  exactly that ceiling: Sea cliff p99 3 rows per cell, max 4. Escarpment max 5. Gorge 5. Canyon 4. Fjord 5.
//  Every landform in the catalogue whose entire point is a vertical face is capped at about a 4-in-1 slope,
//  which is a hillside. That is why the `seacliff` gallery panel is a sandy rise meeting a beach, and why sea
//  caves refused to place in five worlds running: THERE IS NO CLIFF IN THE WORLD TO CUT ONE INTO.
//
//  ⭐ So steepness is a FINE signature, like the mesa's terraces — no amount of contract tuning can produce it.
//  The riser takes the drop the coarse field spreads over a couple of hundred cells and delivers most of it
//  across ten or so, leaving a bench above and an apron below: which is what a scarp IS. Written as "put this
//  column AT the cliff profile" rather than "add some steepness", the same form the crater rule takes, so it is
//  correct at any coarse slope instead of at one.
// ==============================================================================================================
function prepareCliffs(W) {
  const seed = W.o.seed, out = [];
  for (const f of W.features) {
    if (f.type !== 'seacliff' && f.type !== 'escarp') continue;
    let at = -1, best = 0;
    // ⚠️ A SEA CLIFF IS WHERE THE LAND MEETS THE SEA, not where the feature happens to be steepest. Sited on
    // the steepest sample, the riser landed inland and the shoreline stayed a beach — sea caves went on
    // refusing with "no cliff (best drop 0)" at the waterline while the world now had a perfectly good cliff
    // two hundred cells behind it. The definition of the landform is the placement rule.
    if (f.type === 'seacliff') {
      for (let i = Math.max(1, f.a - 2); i < Math.min(W.n - 1, f.b + 2); i++) {
        if (W.h[i] * W.h[i + 1] > 0) continue;                  // no crossing of sea level here
        at = i; best = W.h[i + 1] - W.h[i - 1]; break;
      }
    }
    if (at < 0) for (let i = Math.max(1, f.a); i < Math.min(W.n - 1, f.b + 1); i++) {
      const d = W.h[i + 1] - W.h[i - 1];
      if (Math.abs(d) > Math.abs(best)) { best = d; at = i; }
    }
    if (at < 0 || Math.abs(best) < 6) continue;
    let hi = -1e9, lo = 1e9;
    for (let i = f.a; i <= f.b; i++) { if (W.h[i] > hi) hi = W.h[i]; if (W.h[i] < lo) lo = W.h[i]; }
    // a sea cliff drops to the sea, so its foot is sea level rather than the feature's own lowest sample
    if (f.type === 'seacliff') lo = Math.min(lo, -18);
    // ⚠️ The riser only REDISTRIBUTES the relief the coarse field already put there. Inventing height here
    // would break the boundary contract the layout pass measured, which is the one thing this stage must not do.
    const D = cl(hi - lo, 34, 300);
    out.push({
      at: at * W.dx, dir: best < 0 ? 1 : -1,      // dir points DOWNHILL, in cells
      D, hiElev: hi,
      riser: 3 + Math.round(hh(seed, 981, at, 0) * 6),
      reach: Math.min(260, Math.max(60, Math.round((f.b - f.a + 1) * W.dx * 0.45))),
      salt: 983 + ((at * 17) & 511),
    });
  }
  return out;
}
function cliffAt(list, c) {
  for (const K of list) if (Math.abs(wdc(c - K.at)) < K.reach + 30) return K;
  return null;
}
function cliffDetail(K, c, elevC, detail, seed) {
  // ⚠️ the face's POSITION is roughened, not its height — a dead straight edge reads as a wall built by a
  // person however much noise is added to the drop. Same objection as the crater rim and the sky islands.
  // ⚠️ the wobble must be SMALLER than the riser or it smears the face back into a slope: at 2.4x the
  // riser the cliff measured 13 rows per cell, which is 58 degrees — a scramble, not a face.
  const jit = (fb1(seed, K.salt, c * nd(19).q, 3, nd(19).p) - 0.5) * K.riser * 1.0;
  const u = wdc(c - K.at) * K.dir + jit;                    // negative on the high side
  const a = Math.abs(u);
  if (a > K.reach) return detail;
  const f = sm(cl(u / (K.riser * 2) + 0.5, 0, 1));          // 0 above the face, 1 below it
  const want = K.hiElev - K.D * f;
  const w = sm(cl((K.reach - a) / (K.reach * 0.6), 0, 1));  // blend back to the coarse ground at the edges
  return detail * (1 - 0.55 * w) + (want - elevC) * w;
}

// ==============================================================================================================
//  THE PER-COLUMN READING — everything the cell loop needs, derived once.
//  ⚠️ This is the seam the real implementation would have to keep: it must be computable from the coarse record
//  and the column alone, because that is what makes a chunk producible on its own.
// ==============================================================================================================
// ==============================================================================================================
//  DRESSING — what covers the ground. Knows the climate, the altitude and the slope, NOT the landform.
//  ⭐ EXTRACTED so a FLOATING ISLAND can be dressed by exactly the same rules as the ground it floats over. That
//  is the form/dressing split paying off in the place it was least designed for: one island generator, and the
//  one drifting over snow country wears snow, grows conifers and holds a frozen tarn — with no island-specific
//  dressing code at all. Duplicating these rules for the sky band would have been the moment the split stopped
//  being true.
// ==============================================================================================================
function dress(temp, moist, elev, sRank, inVent, kind) {
  // 🟥 BOTH OF THESE WERE INVERTED, and the symptom was unmissable once the picture existed: ALL FOUR climate
  // panels came out covered in snow, including the one at temperature 0.92. A hot climate was being given a
  // snowline of -260 rows, i.e. below sea level, so everything above the seabed was permanently white.
  const snowLine = lp(-150, 3000, cl(temp / 0.62, 0, 1));       // elevation above which snow lies year-round
  const treeLine = lp(20, 900, cl((temp - 0.06) / 0.55, 0, 1)); // …and trees stop well below it
  // 🟥 AND THE SAME MISTAKE A THIRD TIME. This was an ABSOLUTE slope threshold, and since the coarse slope field
  // runs to 0.35 on a mountainside, EVERY mountain came out fully steep: no soil, no trees, bare scree, in all
  // four climates. Percentile rank, like the feature contracts — and 0.94 rather than 0.80, because on a range
  // essentially every column is in the top 20% of slope. Real forest climbs to about 35°; CLIFFS are bare.
  const steep = cl((sRank - 0.94) / 0.05, 0, 1);                // 0 = holds soil, 1 = bare rock
  // ⚠️ THE DRESSING WAS ONE TO THREE CELLS THICK AND COULD NOT CARRY THE DIFFERENCE IT WAS SUPPOSED TO SHOW.
  const soil = Math.max(1, Math.round(lp(2, 22, moist) * (1 - 0.75 * steep) * lp(0.4, 1, cl(temp / 0.32, 0, 1))));
  const canSnow = (elev > snowLine || temp < 0.085) && !inVent;
  const canTree = elev < treeLine && temp > 0.16 && moist > 0.30 && steep < 0.92 && !canSnow && !inVent;
  let cover;                                                   // the top-most solid material
  if (inVent) cover = M.ash;
  else if (canSnow) cover = M.snow;
  else if (steep > 0.75) cover = M.scree;
  else if (kind === 'dunes' || (moist < 0.16 && temp > 0.5)) cover = M.sand;
  else if (kind === 'saltpan') cover = M.salt;
  else if (kind === 'swamp' || kind === 'oxbow') cover = M.peat;
  else if (kind === 'tufa' || kind === 'geyser') cover = M.tufa;
  else if (kind === 'moraine' || kind === 'fan') cover = M.gravel;
  // 🟥 AN IMPACT CRATER WAS WEARING ASH — volcanic dressing on a hole punched by a rock from space. Ash is
  // AIRFALL from an eruption; the only thing that falls on an impact crater is the ground it just threw up.
  // ⇒ its cover is its own EJECTA BLANKET: pulverised local rock, which this palette already calls `gravel` and
  // already uses for the other two broken-rock landforms, `moraine` and `fan`. No new material — a material
  // declared ahead of a rule is mistake #9, and this is the rule reaching for one that exists.
  // ⚠️ This is dressing knowing about a landform, which the design allows only where it is EARNED — the live
  // vent and the coral reef are the other two. An ejecta blanket is a real deposit that the climate did not put
  // there, which is the same argument. What makes the crater READABLE is still the meteorite in `oreCtx`, not
  // the cover: the landform is the clue.
  else if (kind === 'crater') cover = M.gravel;
  else if (moist > 0.30 && temp > 0.16) cover = M.turf;
  else if (temp < 0.22) cover = M.permafrost;
  else cover = M.gravel;
  return { snowLine, treeLine, steep, soil, canSnow, canTree, cover };
}

// How deep the cover goes before the ordinary soil stack resumes. Most covers ARE a skin — turf is a skin of
// grass and that is correct. Three are not, and giving them one made the landform named after them contain
// almost none of it. `sand` and `peat` are absent here because the soil branch below already carries them down.
// ⚠️ A FUNCTION OF THE COLUMN ALONE (mistake #3), so a terrace is the same thickness from every column that
// looks at it, and the top of a tufa mound does not step at a sample boundary.
function coverDepth(ci, c, seed) {
  if (ci.cover === M.tufa) return 5 + Math.round(16 * fb1(seed, 781, c * nd(38).q, 2, nd(38).p));  // a terrace, built up in sheets
  if (ci.cover === M.permafrost) return ci.soil + 8 + Math.round(10 * fb1(seed, 783, c * nd(60).q, 2, nd(60).p));
  if (ci.cover === M.salt) return 2 + Math.round(5 * fb1(seed, 785, c * nd(44).q, 2, nd(44).p));    // a playa crust
  return 1;
}

// ⚠️ MEMOISED. Flora needs the GROUND AT A NEIGHBOURING ANCHOR — a tree three columns away sits at its own
// height, not at this one's — and the previewers ask for the same column many times over while drawing. The
// cache is cleared once the volcano records exist, because the crater changes the answer and nothing calls this
// before then.
function columnInfo(W, C, c) {
  const cache = C._ci;
  if (cache !== undefined) { const hit = cache.get(c); if (hit !== undefined) return hit; }
  const out = computeColumn(W, C, c);
  if (cache !== undefined) { if (cache.size > 8192) cache.clear(); cache.set(c, out); }
  return out;
}
// ⭐⭐ A COLUMN'S COARSE SAMPLE, WRAPPED. The coarse arrays cover exactly one period (`n * dx = PERIOD_COLS`),
// so sample `n` IS sample 0 and the lookup has a join rather than an end.
// 🟥 THIS WAS THE FIRST THING `probe_periodic` FOUND, and it is the one that would have been hardest to spot by
// reading: every coarse FIELD was made periodic, but the column→sample lookup still CLAMPED. So a column one
// period along resolved to the last sample instead of to its true partner, and the check reported the ground
// itself at a different height — `shale vs air` at the surface band, across every probe column. Making the
// fields repeat is worth nothing if the thing that reads them does not.
const wsamp = (W, i) => { const n = W.n; return (i % n + n) % n; };
function computeColumn(W, C, c) {
  const dx = W.dx, seed = W.o.seed;
  const t = c / dx, ti = Math.floor(t), i0 = wsamp(W, ti), i1 = wsamp(W, i0 + 1);
  // ⚠️ THE FRACTION COMES FROM THE UNWRAPPED t, NOT FROM `t - i0`. Once i0 is wrapped, `t - i0` is the whole
  // distance back to the start of the world — it clamps to 1 and every column in the period reads as if it sat
  // exactly on a sample. That is a silent, total loss of interpolation, and it looks like nothing at all.
  const f = sm(cl(t - ti, 0, 1));
  const gi = f < 0.5 ? i0 : i1;                                // nearest sample, for categorical fields
  const elevC = lp(W.h[i0], W.h[i1], f);
  const relief = lp(W.relief[i0], W.relief[i1], f);
  const uplift = lp(W.uplift[i0], W.uplift[i1], f);
  const slopeC = lp(W.slope[i0], W.slope[i1], f);
  const temp = lp(W.clim.temp[i0], W.clim.temp[i1], f);
  const moist = lp(W.clim.moist[i0], W.clim.moist[i1], f);
  const lith = W.lith[gi];
  const feat = C.featAt[gi] || null;

  // ── FORM: the fine shape, and the ONLY place a landform's identity touches the ground ──────────────────────
  // Amplitude tracks local relief, so flat country stays flat and a mountainside is rough — without that, fine
  // noise at a fixed amplitude makes plains look like gravel and peaks look smooth.
  const rough = cl(relief / 90, 0.12, 1) * (0.35 + 0.9 * cl(slopeC / 0.12, 0, 1));
  let detail = (fb1(seed, 401, c * nd(34).q, 4, nd(34).p) - 0.5) * 46 * rough
             + (fb1(seed, 407, c * nd(9).q, 3, nd(9).p) - 0.5) * 11 * rough;
  const baseDetail = detail;                        // the plain ground, kept for the edge blend below
  let benchy = 0;
  const kind = feat ? feat.type : null;
  if (kind === 'mesa') {
    // terraces: hard sandstone caps standing over softer beds. Snap the surface to steps, jittered per bed.
    const step = 26 + 10 * n1(seed, 411, c * nd(900).q, nd(900).p);
    const raw = elevC + detail * 0.3;
    benchy = Math.round(raw / step) * step - raw;
    detail = detail * 0.25;
  } else if (kind === 'dunes') {
    // long smooth crests with a steeper slip face, which is what makes a dune read as a dune and not a hill
    // 🟥🟥 MODULATE THE PHASE, NEVER THE WAVELENGTH. `c / λ(c)` looks like "a sine whose wavelength
    // varies", and it is not: its derivative is 1/λ − c·λ'/λ², and the second term carries the ABSOLUTE
    // world position. At c ≈ 200,000 with λ ≈ 200 that term is thirty-seven times the first, so the phase
    // raced through dozens of cycles per cell and the dune sea came out as the worst comb in the world —
    // 30.5 direction reversals per 100 columns, median step 8 rows, p99 45. It also got WORSE further east,
    // which is the tell: nothing about a dune should depend on how far from the origin it is.
    // ⚠️ Nobody had noticed. It took measuring all thirty signatures the same way, and the landform I was
    // actually looking for (hoodoos) came second.
    // ⚠️ AND THE MODULATION HAS TO BE VISIBLE AT THE SCALE OF THE FIELD. At c/2400 the phase noise barely
    // moves across a 2,600-cell dune sea, so the crests came out evenly spaced and identical: a saw, not dunes.
    // Shorter modulation for spacing, shorter still for height, and a skew so each crest has a long windward
    // slope and a short steep lee — which is the one thing that makes a dune read as a dune.
    // ⚠️ THE CARRIER IS A SINE, AND A SINE IS PERIODIC ONLY IF ITS PHASE ADVANCES A WHOLE NUMBER OF TURNS OVER
    // the world. `c / 190` does not (190 does not divide the period), so the dune sea would have arrived at the
    // join mid-crest. `nd(190).q` quantises the wavelength to 190.0006 cells, which is exactly 2,760 turns.
    const ph = c * nd(190).q + 1.15 * fb1(seed, 413, c * nd(1100).q, 2, nd(1100).p);
    const th = ph * Math.PI * 2;
    const s = Math.sin(th + 0.55 * Math.sin(th));
    detail = (Math.sign(s) * Math.pow(Math.abs(s), 0.8)) * 30 * (0.35 + 0.9 * fb1(seed, 415, c * nd(430).q, 2, nd(430).p));
  } else if (kind === 'karst') {
    // towers: a ridged field, mostly at its floor, so pinnacles rise from a flat plain.
    // ⚠️ THE WIDTH OF A TOWER IS THE NOISE'S WAVELENGTH; THE STEEPNESS OF ITS SIDES IS THE EXPONENT. Three
    // octaves at c/26 made both come from the same place, so the towers were two cells wide AND vertical —
    // 143 rows of step in a single column. One octave sets the spacing, the shaping curve sets the profile.
    //
    // 🟥 VARIANT 'A' IS THE ORIGINAL AND THE USER REJECTED IT: "too spiky and just don't look that good... in 2D
    // I think it doesn't really work". The reason is structural, not a matter of tuning. `1 - |2n - 1|` has a
    // CORNER at its maximum, and `pow(x, 1.8)` cannot remove a corner — it steepens the sides and leaves the
    // apex a point. Worse, the gate spans 0.30..1.00, so full height is reached only at the single value r = 1:
    // every tower is a needle by construction.
    // ⭐ AND THE CURE WAS ALREADY IN THIS FILE, TWELVE LINES DOWN. `hoodoo`/`arch` had exactly this bug — "the
    // arch field came out as a bed of 1,400-px nails" — and it was fixed with a SATURATING smoothstep gate: the
    // wavelength sets how WIDE a tower is, the gate width sets how STEEP its sides are, and because the gate
    // saturates, the top is FLAT. Karst never got that treatment.
    // ⭐ It is also the better geology. Karst towers are what is LEFT of a dissolved plateau, so their tops are
    // remnants of one former surface — flat, and all at about the same height — standing on a flat alluvial
    // plain. Varying peak height reads as spikes however the tips are shaped.
    // ⚠️ The roughness rides ON the gate (`g * ...`) so a flat top is not an analytic flat top — the recorded
    // objection that analytic shapes read as maths.
    // ⚠️ FOUR RULES WERE RENDERED ON ONE SCENE AND THE USER PICKED THIS ONE (`out/karst_compare.png`,
    // 2026-08-10). The other three and the variant switch are DELETED rather than left behind a flag: they are
    // in git, the comparison sheet is in `out/`, and this rule is about to be ported into the server, where four
    // dead branches are four things to carry. 95-column spacing, gate centred 0.58 and 0.10 wide, 200 rows.
    const r = 1 - Math.abs(2 * n1(seed, 417, c * nd(95).q, nd(95).p) - 1);
    const g = sm(cl((r - 0.58) / 0.10, 0, 1));
    // ⭐ THE FLANKS ARE ROUGHENED BY A HEIGHT PERTURBATION WEIGHTED TO THE FLANK, and the weight is the whole
    // trick: `4*g*(1-g)` is 1 where the gate is mid-transition and exactly 0 where it is saturated (the flat
    // top) or clamped (the plain). So the sides get ledges while the two things the saturating gate exists to
    // give are untouched.
    // 🟥 MY FIRST ATTEMPT PERTURBED THE GATE'S **INPUT** (`r + noise`) AND IT BACKFIRED VISIBLY — it grew thin
    // needle spikes, which is the exact failure the saturating gate was chosen to remove. Obvious in hindsight:
    // near the plain, `r` sits just under the threshold, so any positive nudge tips a SINGLE column over the
    // gate and that column jumps the full 200 rows. Perturbing the input moves the threshold; perturbing the
    // output moves the ground. Only the second one can be bounded.
    // ⚠️ HONEST LIMIT, measured, and the user agreed it is invisible: at 100 this shifts 9.2% of columns by at
    // most 34 rows of a 200-row tower. The flank is only ~5 columns wide, so there is no room for more than
    // about one ledge, and a heightfield cannot undercut. Craggier sides need a WIDER GATE, which trades away
    // the steepness that made this the pick. Kept because it costs one term and does break the flank line.
    const flank = 4 * g * (1 - g);
    detail = g * 200 - 8 + g * (fb1(seed, 418, c * nd(21).q, 2, nd(21).p) - 0.5) * 14
           + flank * (fb1(seed, 429, c * nd(7).q, 2, nd(7).p) - 0.5) * 100;
  } else if (kind === 'badlands') {
    // ⚠️ FOUR OCTAVES FROM c/13 PUTS THE LAST ONE AT 1.6 CELLS, i.e. white noise per cell — the panel grew a
    // fringe of one-cell spikes along its skyline that reads as fur. Badlands are RILLED: gullies you could
    // walk into, at a scale you can see. Three octaves from c/30 bottoms out at 7 cells.
    const r = 1 - Math.abs(2 * fb1(seed, 419, c * nd(30).q, 3, nd(30).p) - 1);
    detail = -Math.pow(r, 1.6) * 62 + 16;
  } else if (kind === 'hoodoo' || kind === 'arch') {
    // FINS AND BUTTES standing off a flat pediment: flat tops, steep sides, and wide enough to be places.
    // 🟥 `pow((r - 0.72) / 0.28, 0.7)` is a threshold with an INFINITE derivative just above it, driven by a
    // 2-octave field at c/11 — so the surface went from the pediment to +170 rows in two columns and the
    // "arch field" came out as a bed of 1,400-px nails. The picture was unmistakable and the numbers agreed:
    // 12.1 direction reversals per 100 columns against 0.23 for open terrain.
    // ⭐ The fix is not a gentler curve, it is SEPARATING THE TWO THINGS THE OLD RULE CONFLATED. How WIDE a
    // butte is comes from the noise's wavelength; how STEEP its sides are comes from the gate. One octave at
    // c/120 gives masses about sixty cells across, and a smoothstep gate 0.16 wide gives sides of roughly 29
    // rows per cell — near-vertical, which is what a butte is, over a width you can stand on.
    const r = 1 - Math.abs(2 * n1(seed, 421, c * nd(120).q, nd(120).p) - 1);
    const g = sm(cl((r - 0.50) / 0.16, 0, 1));
    detail = g * 125 - 8 + g * (fb1(seed, 423, c * nd(26).q, 2, nd(26).p) - 0.5) * 16;
  } else if (kind === 'moraine') {
    // hummocky ground — the unsorted rubble a glacier drops. Bumpy at one scale, flat overall.
    detail = (fb1(seed, 423, c * nd(17).q, 2, nd(17).p) - 0.5) * 52 + (fb1(seed, 425, c * nd(5).q, 2, nd(5).p) - 0.5) * 14;
  } else if (kind === 'crater') {
    // a rim and a bowl, which is one analytic shape, so it is roughened like the islands and halls were
    const rr = wdc(c - feat.at * W.dx) / Math.max(1, (feat.b - feat.a) * W.dx / 2);
    const q = Math.abs(rr);
    detail = (q < 1 ? (q > 0.72 ? 90 * (1 - Math.abs(q - 0.86) / 0.14) : -70 * (1 - q / 0.72)) : 0)
           * (0.75 + 0.5 * fb1(seed, 427, c * nd(30).q, 2, nd(30).p));
  } else if (kind === 'inselberg') {
    const q = Math.abs(wdc(c - feat.at * W.dx) / Math.max(1, (feat.b - feat.a) * W.dx / 2 + 1));
    detail = q < 1 ? Math.pow(1 - q, 0.55) * 60 * (0.8 + 0.4 * fb1(seed, 429, c * nd(22).q, 2, nd(22).p)) : 0;
  }
  // 🟥🟥 AND THE SAME THING THE CRATER NOTE BELOW WARNS ABOUT WAS TRUE OF EVERY OTHER LANDFORM. `feat` is
  // `featAt[nearest sample]`, so a feature's fine SIGNATURE switched on and off at a 64-column boundary — and a
  // signature is worth up to 200 rows (karst), 125 (hoodoo/arch), 62 (badlands). The crater was given a
  // record-keyed rule precisely because "a rim that toggled at a 64-column boundary would step by tens of rows";
  // the generic rules never got the same treatment, and nobody had measured them.
  // ⚠️ MEASURED at the sample midpoints of every feature edge, two worlds: **18 of 192 edges stepped 25+ rows,
  // worst 205 — a 1,640 px cliff** where a karst field stopped. Twin of the lithology contact fixed the same day
  // and found the same way: by asking which CATEGORICAL fields are read per coarse sample.
  // ⭐ THE BLEND IS BACK TO THE PLAIN, NOT TO ZERO. `detail` starts as the ordinary ground noise and the kind
  // rules REPLACE it, so fading it out would leave a flat strip round every landform; fading toward
  // `baseDetail` fades the landform's identity and leaves ordinary ground behind, which is what the edge of a
  // karst field or a dune sea actually looks like.
  // ⚠️ Placed AFTER the kind chain and BEFORE the crater/cliff/doline rules, because those are keyed on their
  // own records in COLUMNS and already have no sample boundary to hide.
  if (feat) {
    const cA = feat.a * dx, cB = (feat.b + 1) * dx;
    const edge = Math.min(96, Math.max(24, (cB - cA) * 0.25));
    const inFrom = Math.min(wdc(c - cA), wdc(cB - c));
    const taper = sm(cl(inFrom / edge, 0, 1));
    detail = baseDetail + (detail - baseDetail) * taper;
  }

  // ⭐ THE CRATER — the volcano's fine signature, exactly like the mesa's terraces and the dune's slip face, so
  // it costs the same as any other landform's form rule. ⚠️ Keyed on the volcano RECORD's column in cells, not
  // on `feat` (which is `featAt[nearest sample]`): a rim that toggled at a 64-column boundary would step by tens
  // of rows, and the lake level scan below would then be measuring a rim the cell loop does not draw.
  const VN = C.volc && C.volc.length ? volcanoNear(C.volc, c) : null;
  if (VN) detail = craterDetail(VN, c, elevC, detail, seed);
  const KF = C.cliffs && C.cliffs.length ? cliffAt(C.cliffs, c) : null;
  if (KF) detail = cliffDetail(KF, c, elevC, detail, seed);
  // ⭐ A COLLAPSE DOLINE is a fine signature on the heightfield exactly like the crater rim and the cliff riser,
  // so it belongs here rather than in the cell loop. ⚠️ `C.caves` is empty while the caves are being PLACED, so
  // the entrance is sited against the undepressed ground and the depression appears afterwards — which is the
  // right way round, and is why `prepare` throws the column cache away once the records exist.
  if (MOUTH === 'doline' && C.caves && C.caves.length) detail -= dolineDetail(C.caves, c, seed);

  const elev = elevC + detail + benchy;
  const surfRow = Math.round(C.seaRow - elev);

  // ── DRESSING ────────────────────────────────────────────────────────────────────────────────────────────────
  // ⚠️ A live vent is the one place dressing must know about the landform, and the picture said so: seed 1234's
  // volcano 3 had a stand of broadleaf TREES on the summit and snow in the crater. Ash, and nothing grows.
  const inVent = VN ? Math.abs(wdc(c - VN.at)) < VN.craterR * 1.35 : false;
  const sRank = W.rank ? lp(W.rank.slope[i0], W.rank.slope[i1], f) : cl(slopeC / 0.2, 0, 1);
  const D = dress(temp, moist, elev, sRank, inVent, kind);
  const { snowLine, treeLine, steep, soil, canSnow, canTree, cover } = D;

  // ── STRUCTURE: folds and faults ─────────────────────────────────────────────────────────────────────────────
  // 🟥 THE BEDS WERE NEAR-PARALLEL HORIZONTAL BANDS across whole sections, which reads as a layer cake rather
  // than as rock. Real strata are folded where the crust has been squeezed and OFFSET where it has broken, and
  // the offset is the more legible of the two: a bed that steps up across a line is instantly a fault.
  // ⭐ Folding amplitude tracks uplift, so cratons lie flat and orogens are crumpled — the structure carries the
  // same information the surface does, which is what makes the two look like the same place.
  const fold = (fb1(seed, 431, c * nd(620).q, 3, nd(620).p) - 0.5) * lp(38, 300, cl(uplift * 2.4, 0, 1))
             + (fb1(seed, 433, c * nd(170).q, 2, nd(170).p) - 0.5) * lp(10, 70, cl(uplift * 2.4, 0, 1));
  // Cumulative throw: every fault to the left of this column has displaced everything to its right. Bounded —
  // only the faults within reach are summed, which keeps it a local answer.
  // ⚠️ AN ANCHOR LATTICE MUST TILE THE PERIOD, or a perfectly periodic noise field still puts half a fault at the
  // join. `nlat` quantises the COUNT rather than the spacing, so 620 becomes 619.87 rather than 512.
  const FSTEP = FAULT_LAT.s, FWRAP = FAULT_LAT.n;
  let throwSum = 0, faultDist = 1e9;
  const nearF = Math.floor(c / FSTEP);
  for (let k = nearF - 5; k <= nearF + 1; k++) {
    const kw = wrapL(k, FWRAP);
    if (hh(seed, 811, kw, 0) > 0.55) continue;                   // not every lattice cell has a fault
    const fc = latAt(FAULT_LAT, k) + (hh(seed, 813, kw, 1) - 0.5) * FSTEP * 0.8;
    const dxf = Math.abs(c - fc);
    if (dxf < faultDist) faultDist = dxf;
    if (c > fc) throwSum += (hh(seed, 815, kw, 2) - 0.5) * lp(30, 190, cl(uplift * 2.4, 0, 1));
  }
  const bedShift = fold + throwSum;

  // ⭐ THE LIQUID SITUATION, ONCE PER COLUMN. Every liquid in the world is chosen from this — see liquids.js.
  // ⚠️ HERE, not at the point of use, for two reasons. It is per-COLUMN by nature (salinity, acidity and
  // hydrocarbon are properties of the place, not of the row), and `columnInfo` is memoised — asking at each of
  // the ~10 sites that place a liquid would recompute five noise fields per cell. `atDepth` adds the part that
  // genuinely varies with row.
  // ⚠️ `silica` is read off the VOLCANO RECORD rather than resampled, so a conduit does not change viscosity
  // down its own length (mistake #3: a thing must be the same from every column it touches).
  const nearVolc = !!(C.volc && C.volc.some(V => Math.abs(wdc(c - V.at)) < 2600));
  const sit = situationOf({ lith, moist, temp, cover, surfRow, oreCtx: { moist, temp, nearVolcano: nearVolc } },
    L, c, seed, { closed: W.endo ? W.endo[gi] === 1 : false, sandy: cover === M.sand, clayey: moist > 0.55 });
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  //  ⭐⭐ OCEANIC CRUST — and it is the AQUICLUDE, without being a thing invented to be one.
  //
  //  The user's requirement is that draining the ocean into the underworld must not be easy. The honest answer
  //  was already sitting in the geology this pipeline models and does not yet express: **the deep sea floor is
  //  not continental rock.** A shelf is drowned continent — sediments, and it keeps them. Past the shelf break
  //  the crust underneath is OCEANIC: a few tens of cells of pelagic sediment lying on massive basalt. Massive
  //  unfractured basalt is one of the real world's better aquicludes, which is why this doubles as the seal.
  //
  //  ⭐ So no new material and no new rule-shaped-like-a-wall: `basalt` is already in the palette, the shelf /
  //  slope / abyss split is already computed one stage up (`W.bathy`, quantiles of continentalness), and the
  //  outcome is a thing a player can READ — dig through the ooze under the deep ocean and you hit dark rock that
  //  goes on and on, which is exactly what is under the real one.
  //
  //  ⚠️ IT IS A BED, NOT A BASEMENT. Below it the ordinary world resumes with its ordinary ore — making the
  //  whole deep column basalt would seal it just as well and would delete every mineral under a third of the
  //  world. A discrete impermeable BED is what an aquiclude actually is.
  //  ⚠️ Thickness and top are wavy functions of the column alone (mistake #3), so it is the same bed seen from
  //  every column that looks at it, and it does not step at a coarse-sample boundary.
  //  ⏭️ THE SEAL IS GEOMETRIC HERE AND MUST BECOME MATERIAL STRENGTH AT THE PORT: in the spike nothing digs, so
  //  "hard" cannot be expressed. `server/materials.js` carries a strength per material and basalt should be
  //  among the toughest — deliberate to cut through, not impossible.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  //  ⭐⭐ THE POLAR SEA (ocean phase 3). Until now the sea knew nothing about temperature at ALL — `classify`
  //  opened with `if (isSea[i]) return shelf or ocean`, so an arctic ocean and an equatorial one were the same
  //  two entries, and the only ice anywhere at sea was a THREE-CELL SKIN. The land has had six cold biomes,
  //  glaciers and moraine fields all along; the sea had a lid.
  //
  //  Two things float here and they are different objects, not one rule with a dial:
  //    THE PACK    a sheet a metre to a few metres thick, continuous over huge distances and cut by LEADS —
  //                open lanes that crack through it. The leads are not decoration: they are how anything gets
  //                in or out, and a solid sheet from horizon to horizon is a wall, not a place.
  //    A BERG      a piece of a glacier, tens of metres thick, which is a different scale entirely.
  //
  //  ⭐ AND THE ONE NUMBER THAT MAKES BOTH READ AS ICE IS THE SAME: ice floats about ONE NINTH PROUD. So the
  //  freeboard is a ninth of the thickness and the draft is the other eight, for the sheet and the berg alike —
  //  which is why a berg standing 30 cells out of the water hangs 240 below it, and why swimming under one is a
  //  different experience from walking past it. One physical fact, two features.
  //  ⚠️ Held as ELEVATIONS (`iceTop`/`iceBot`), not thicknesses, because the fill compares elevations — and the
  //  two rules have to be able to disagree about which is thicker without a special case.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════
  let iceTop = -1e9, iceBot = 1e9;
  const POLAR = W.polarT || 0;
  if (POLAR > 0 && temp < POLAR && elev < 0) {
    const cold = cl((POLAR - temp) / Math.max(0.02, POLAR), 0, 1);
    // ⚠️ THE LEADS COME FROM A FIELD, NOT A COIN FLIP PER COLUMN. Per-column dice give a sheet with one-cell
    // holes in it, which is static, not pack ice; a low-frequency field gives lanes you can follow.
    const lead = fb1(seed, 799, c * nd(170).q, 3, nd(170).p);
    // ⭐ LEADS ARE RARE IN THE COLD CORE AND COMMON AT THE EDGE, which is not a tuning trick — it is what a
    // MARGINAL ICE ZONE is, and it is the difference between "a sheet with holes" and "pack ice that opens up
    // as you leave it". A uniform threshold gave a flat 24-34% open everywhere including the pole.
    if (lead > LEAD_T * (1 - 0.62 * cold)) {
      const th = Math.max(1, Math.round(lp(1, 70, cold * cold) * cl((lead - LEAD_T) / 0.22, 0.35, 1)));
      iceTop = 0 + th / 9; iceBot = 0 - th * 8 / 9;          // sea level is elevation 0; a ninth proud
    }
    // ── BERGS. On their own lattice, because they are calved from a glacier and arrive in ones, not as a field.
    const BL = nlat(760);
    const k = Math.round(c / BL.s), kw = wrapL(k, BL.n), bx = latAt(BL, k);
    if (hh(seed, 801, kw, 0) < 0.30 + 0.35 * cold) {
      const hw = 7 + Math.round(hh(seed, 803, kw, 1) * 46);
      const th = 22 + Math.round(hh(seed, 805, kw, 2) * 130);
      const q = Math.abs(wdc(c - bx)) / hw;
      if (q < 1) {
        // ⚠️ ROUGHENED PROFILE, not a roughened height — the objection that has cost this track five features.
        const rough = 0.78 + 0.44 * fb1(seed, 807 + (kw & 63), c * nd(11).q, 2, nd(11).p);
        const prof = Math.pow(Math.max(0, 1 - q * q), 0.42) * rough;
        if (prof > 0.02) {
          iceTop = Math.max(iceTop, th / 9 * prof);
          iceBot = Math.min(iceBot, -th * 8 / 9 * prof);
        }
      }
    }
  }
  let crustD = -1, crustT = 0;
  if (W.bathy && W.bathy.seaSamples && elev < 0 && W.cont[gi] <= W.bathy.shelf) {
    crustD = 26 + Math.round(30 * fb1(seed, 795, c * nd(240).q, 2, nd(240).p));   // pelagic sediment above it
    crustT = 70 + Math.round(40 * fb1(seed, 797, c * nd(180).q, 2, nd(180).p));
  }
  return { crustD, crustT, iceTop, iceBot,
    elev, surfRow, temp, moist, lith, feat, kind, soil, cover, steep, canSnow, canTree,
    treeLine, snowLine, relief, slope: slopeC, sample: gi, bedShift, faultDist, uplift, vent: inVent,
    sit, hot: nearVolc ? 1 : 0, silica: VN ? VN.silica : 0,
    // what the mineral table needs to know about this column, gathered once
    oreCtx: { moist, temp,
      // ⭐ AN IMPACT CRATER IS AN ASSOCIATION LIKE ANY OTHER. The catalogue has had a Crater landform all along
      // and nothing was associated with it — so the one place in the world where a unique material has a
      // guaranteed, findable home was carrying the ordinary hillside ore suite.
      crater: kind === 'crater',
      nearVolcano: !!(C.volc && C.volc.some(V => Math.abs(wdc(c - V.at)) < 2600)),
      nearRiver: W.isRiver[gi] === 1 || W.isRiver[wsamp(W, gi - 1)] === 1 || W.isRiver[wsamp(W, gi + 1)] === 1 } };
}

// One column of cells, written into `out` (length rN), for rows [r0, r0+rN).
function fillColumn(W, C, c, r0, rN, out, outBack) {
  const seed = W.o.seed;
  const ci = columnInfo(W, C, c);
  const { surfRow, lith } = ci;
  const bedMat = LITH_MAT[lith] !== undefined ? LITH_MAT[lith] : M.stone;
  // The water surface over this column, as an ELEVATION: sea level, or this lake's level, whichever is higher.
  // Rivers keep a row-based channel because they are a cross-section rather than a body.
  const lakeE = C.lakeLevelAt(c);
  let rivE = RIVER_WATER ? C.riverElevAt(c) : -1e9;             // see RIVER_WATER at the top of this file
  // 🟥🟥 NO RIVER INSIDE AN OPEN CRATER — the user found this as a brown triangle standing on a volcano.
  // `riverElevAt` returns the COARSE ground height, and a volcano's coarse ground is the smooth `lift: 300`
  // cone the feature adds; the REAL summit has a crater carved up to 140 rows into it. So the fill ran from the
  // real ground up to the un-carved cone and produced a perfect cone of liquid with its apex 72 rows above the
  // summit — SLURRY, because that is what `liquidFor` answers near a volcano. MEASURED: `isRiver` is 1 on every
  // sample across that volcano, its summit included.
  // ⭐ THE USER'S REASONING FOR DELETING IT RATHER THAN LEVELLING IT, and it is about the SIM, not the view:
  // slurry poured onto a lava lake falls, reacts on contact, and once reactions are finished would boil off or
  // skin over — a permanent cost and a permanent eyesore, for a thing that should not be there at all. A river
  // running down a volcano's FLANK is fine and is untouched; it is the crater that is refused.
  // ⚠️ This is a NARROW fix to a general defect and is written down as one: the coarse-vs-real surface gap
  // makes wedges of standing water wherever fine detail cuts below the coarse height (see the "pyramid" note in
  // `kickoff_port.md`). The general cure is rivers as a chain of LEVEL pools, which is parked.
  if (rivE > -1e8 && C.volc) {
    for (const V of C.volc) {
      if (!V.open) continue;
      if (Math.abs(wdc(c - V.at)) < V.craterR + 8) { rivE = -1e9; break; }
    }
  }
  // one surface per column: the highest body that covers it. All three are ELEVATIONS, so the comparison is
  // per cell and no coarse boundary can appear in the answer.
  let waterE = -1e9;
  if (ci.elev < 0) waterE = 0;                                 // 0 is sea level in these units
  if (lakeE > waterE) waterE = lakeE;
  if (rivE > waterE) waterE = rivE;
  const hasBody = waterE > -1e8;
  const underWater = hasBody && waterE >= ci.elev;             // nothing grows on a drowned column
  // is this column on the ABYSSAL PLAIN? A quantile of `cont` decided once in the bathymetry pass — the same
  // number the depth profile itself is built from, so the sediment and the shape cannot disagree about where
  // the plain is. (`W.bathy.abyss` is a `cont` threshold, not a depth.)
  const abyssal = !!(W.bathy && W.cont[ci.sample] <= W.bathy.abyss);
  // is this column inside an atoll's ring? The records are in SAMPLES, so the span is `half` samples either
  // side of `at`, converted here rather than at the record — one conversion, one place.
  // the brine pool's surface over this column, as an ELEVATION — -1e9 where there is none, so the comparison in
  // the fill costs one number and needs no second branch
  let brineE = -1e9;
  if (C.brine) {
    for (const B of C.brine) {
      if (Math.abs(wdc(c - B.at * W.dx)) <= (B.half + 0.5) * W.dx) { brineE = B.level; break; }
    }
  }
  let reefy = ci.kind === 'reef';
  if (!reefy && C.atolls) {
    for (const A of C.atolls) {
      if (Math.abs(wdc(c - A.at * W.dx)) <= (A.half + 1) * W.dx) { reefy = true; break; }
    }
  }

  // 🟥 A CATEGORICAL FIELD SAMPLED PER COLUMN MAKES A HARD VERTICAL WALL. Lithology was read once per column
  // from the nearest coarse sample, so where two rock types met, the contact was a dead-straight vertical line
  // 900 rows tall — a seam you could see from across the picture. A geological contact is a SURFACE: it dips,
  // it wanders, and it is rough. Jittering the lookup in BOTH axes turns the wall into a dipping, ragged
  // contact, which is what the same trick does for biome boundaries on the surface.
  // ⚠️ THE HORIZONTAL HALF OF THE JITTER IS PURE IN THE COLUMN — the same number for every row — and it was
  // evaluated once per row (measured 419 identical 3-octave fb1 calls per column). Hoisted out of the closure.
  // The VERTICAL half stays inside: it is the row term, and it is what turns a straight contact into a dipping
  // one, which is the whole point of the note below.
  const lithJitC = (fb1(seed, 491, c * nd(26).q, 3, nd(26).p) - 0.5) * 2.2;
  const lithAtRow = (r) => {
    const t = c / W.dx;
    // ⚠️ x wrapped, y NOT: the second term is the ROW, and depth has two real ends.
    const j = lithJitC + (fb1(seed, 493, r / 140, 2) - 0.5) * 2.6;
    const gj = wsamp(W, Math.round(t + j));
    return W.lith[gj];
  };

  // ⭐⭐ THE RECORD SHORTLISTS — RESOLVED ONCE PER COLUMN, WHICH IS THE WHOLE OPTIMISATION.
  // Every one of these lists used to be walked IN FULL for every cell: the gate was `C.caves.length`, i.e.
  // "does this world have any", never "can any of them reach this cell". Measured, that is 3.4-3.7 ms of a
  // 16-18 ms chunk for SEVEN descents, and `skyAt` scanning 101 islands for cells 1,100 rows underground.
  // ⚠️ OUTPUT-IDENTICAL BY CONSTRUCTION, and this is the argument: each `*Near` bound is CONSERVATIVE (never
  // narrower than its own module's per-cell test) and preserves LIST ORDER — which matters, because
  // `formationAt` and `volcanoAt` RETURN on their first match rather than accumulating. So the shortlist can
  // only ever hand the exact test fewer candidates it was going to reject anyway.
  // ⚠️ Computed per call, NOT cached on `ci`: `fillColumn` is called from inside `prepare` (by
  // `prepareRimstone`) while `C.rim` is still empty and `C.caves` has just been filled, so a cached shortlist
  // would be a stale memo — the trap this file already records against `C._ci` and the doline.
  const RCcaves = cavesNear(C.caves, c), RCdesc = descentsNear(C.descents, c);
  const RCvoids = voidsNear(C.voids, c), RCsky = skyNear(C.sky, c);
  const RCvent = C.vents && C.vents.length ? ventsNear(C.vents, c) : null;
  // ⚠️ The depth window is derived from THIS column's surface row and the rows actually asked for — `d` in the
  // cell loop is `r - surfRow`, so this is the same expression, once, over the range instead of per cell.
  const RCmin = mineralsNear(MINERALS, ci.oreCtx, r0 - ci.surfRow, r0 + rN - 1 - ci.surfRow);
  // ⭐ ORE BODIES — empty unless `ORE=bodies`, in which case the vein/pocket/massive minerals come from placed
  // records instead of from 34 per-cell noise fields. See the long note in minerals.js.
  const RCore = MINMOD.oreBodiesOn() ? oreBodiesNear(MINERALS, W, C, seed, c, r0, rN) : null;
  const VS = C.volc || [];
  for (let k = 0; k < rN; k++) {
    const r = r0 + k;
    let v = M.air;
    // ⭐⭐ EVERY VOID THIS LOOP CAN PRODUCE IS PROPOSED HERE AND RESOLVED IN ONE PLACE. Caves, fracture swarms,
    // flooded galleries and deep halls all used to write straight into `v`, which is why lava ended up with air
    // beside it: three separate generators, each of them individually right, none of them aware of the melt.
    // A per-site fix would have missed one — this track has missed the second call site four times now.
    let carve = -1;
    const d = r - surfRow;                                     // depth below the surface
    // ⚠️ ONCE per cell. This was called TWICE on the same row in the bedrock line — ten noise evaluations
    // for one answer — and the fracture rule now needs it as well, which is what made it worth noticing.
    const lr = d >= 0 ? lithAtRow(r) : lith;
    if (d >= 0) {
      // ── the vertical stack: cover, soil, subsoil, weathered rock, bedrock ────────────────────────────────
      // ⚠️ A CRATER IS NOT MADE OF SOIL, and the x3 panel showed one lined with loam and clay under a skin of ash
      // — the ordinary hillside stack, because dressing deliberately knows nothing about landforms. This is the
      // one exception the vent earns: a crater wall is airfall ash over scoria over the lavas that built it, and
      // it is also what tells a player at a glance that the hole they are standing in is a live one.
      if (ci.vent && d < 34) v = d < 3 ? M.ash : (d < 13 ? M.pumice : M.basalt);
      // ⭐⭐ A CORAL REEF IS BUILT OUT OF CORAL. The catalogue has had a "Coral reef" landform since the layout
      // pass and it places in 5 of 5 worlds — measured, it came out as limestone/shale/sandstone with TREES
      // growing on it, because dressing knows nothing about landforms and there was no coral in the palette to
      // know about. This is the second exception a landform earns after the vent, and for the same reason: a
      // reef is not a shape made of the local rock, it is a thing that GREW, and the material is the point.
      // ⚠️ Gated on the PHOTIC ZONE and on warmth, not on the feature alone — coral grows in the top few tens of
      // metres of warm water, so the reef's crest is coral and its flanks fall away into ordinary rock. That
      // gate is also what stops a reef appearing on a hilltop when the coarse lift puts one above sea level.
      // 🟥 AND THE FIRST GATE USED THE SEA **ROW** RATHER THAN WHETHER THERE IS WATER HERE, so a reef whose
      // coarse lift put it above sea level came out as a dry salmon-pink slab WITH TREES ON IT. That is
      // mistake #2 in its usual form — `C.seaRow` means "where sea level is", not "this column is submerged",
      // and the column already knows the difference as `waterE`. A reef is submerged or it is not a reef; an
      // emergent one is an island, and an island correctly grows trees.
      // ⭐ AN ATOLL IS COLOURED BY THE REEF RULE, NOT BY A COPY OF IT. Everything that makes the reef right —
      // the photic-zone gate, the warmth gate, submerged-or-it-is-an-island, the rubble/framework/limestone mix
      // — is exactly what an atoll needs, and a second copy is how two rules end up disagreeing (mistake #2).
      // So the only thing added is another way to BE a reef.
      else if (reefy && ci.temp > 0.45 && underWater
               && (C.seaRow - r) <= waterE - 2 && waterE - (C.seaRow - r) < 90
               && d < 60 + 40 * fb1(seed, 787, c * nd(70).q, 2, nd(70).p)) {
        // rubble below, living framework at the crest — and a rough edge, because a reef is not a slab
        const q = fb2(seed, 789, c * nd(9).q, r / 7, 2, nd(9).p);
        v = q > 0.30 ? M.coral : (q > 0.18 ? M.sand : M.limestone);
      }
      // ⭐⭐ ABYSSAL OOZE — the deepest, largest, most distinctive surface in the world was wearing whatever
      // lithology happened to be under it. Real abyssal sediment is plankton shells raining down for millions of
      // years, and it is the REASON the abyssal plain is the flattest place there is: the ooze ponds on top of
      // whatever the crust was doing and buries it. So this is the third exception a place earns after the vent
      // and the reef, and it is the same argument — the material IS the feature.
      // ⚠️ Gated on the ABYSSAL ZONE, which is a quantile of `cont` decided once in the bathymetry pass, not on
      // a depth in rows: an absolute depth cut would be exactly the recurring mistake this track keeps making,
      // and the zone already exists as `W.bathy.abyss` because the depth profile is built from it.
      // ⚠️ And on being submerged, for the same reason the reef is: a seamount can carry an abyssal column's
      // `cont` while standing well above the plain, and a dry buff blanket on its flank would be nonsense.
      else if (abyssal && underWater && d >= 0
               && d < 14 + 26 * fb1(seed, 641, c * nd(180).q, 2, nd(180).p)) {
        v = M.ooze;
      }
      else if (d === 0 && ci.cover === M.snow) v = M.snow;
      else if (d < 3 && ci.canSnow) v = M.snow;
      // 🟥🟥 A BARE ROCK FACE HAS NO SOIL ON IT, AND FOR THE WHOLE LIFE OF THIS FILE IT HAD SIX TO NINE CELLS OF
      // IT. `dress` sets `cover = M.scree` above a slope percentile of 0.75, and this line then said "place the
      // cover, unless it is scree" — so the steep column fell straight through to the soil branch below and was
      // capped with LOAM. Measured on seed 1234: 94 of the 104 steepest columns in the world, `soil` 6–9 cells
      // deep. `out/scree_cliffs.png` is what that looked like — a brown band running down every rock face.
      // It is also why `scree` was the ONE material in a 68-entry palette that no rule anywhere produced, which
      // is how it was found: mistake #9 (the palette gets ahead of the rules) reported by a census, and the
      // real defect underneath it was the opposite — a rule that had been written and then switched off.
      // ⇒ steep ground is bedrock with a VENEER of loose rock on it, thickest where the slope eases, and no
      // soil stack at all. `veneer` is a function of the column alone (mistake #3: a thing must be the same
      // from every column it touches, and a dressing depth read per sample is what caused four of those).
      // ⚠️ ON THE STEEPNESS, NOT ON `cover === M.scree` — and the first version of this fix made that mistake and
      // the picture caught it. `dress` picks ONE cover material and tests `canSnow` before `steep`, so a steep
      // SNOWY face never gets `cover = scree` at all: it kept the whole soil stack, and the panel showed the
      // brown band still running under the snowline on two of the three cliffs. Bareness is a property of the
      // slope; what is lying on top of it is a separate question, which is exactly the form/dressing split.
      else if (ci.steep > 0.75) {
        const veneer = Math.round(fb1(seed, 771, c * nd(19).q, 2, nd(19).p) * 4.2 - 1.1 - (ci.steep - 0.75) * 7);
        v = d < veneer ? M.scree : (LITH_MAT[lr] !== undefined ? LITH_MAT[lr] : bedMat);
      }
      // 🟥🟥 `cover` WAS A ONE-CELL SKIN FOR EVERYTHING, and for three materials that is simply the wrong shape.
      // A grass skin IS one cell. A TUFA TERRACE is a body — and `tufa` came to 9 cells in a 10-million-cell
      // census while the world contains a "Tufa towers" landform in 3 of 5 seeds and a "Hot spring field" in
      // 5 of 5. PERMAFROST is ground frozen for metres and came to 252 cells. Both were one cell of themselves
      // sitting on six of loam, which is not a terrace or frozen ground, it is a sticker.
      // ⇒ a cover has a DEPTH. Same defect as the scree cliff — a material that exists, is placed, and is given
      // no body — and found the same way, by a census asking how much of each material the world contains.
      else if (d < coverDepth(ci, c, seed)) v = ci.cover;
      else if (d < ci.soil) v = ci.cover === M.sand ? M.sand : (ci.cover === M.peat ? M.peat : M.loam);
      else if (d < ci.soil + 4 + (ci.moist > 0.6 ? 5 : 0)) v = ci.moist > 0.55 ? M.clay : (ci.cover === M.sand ? M.sand : M.loam);
      else if (d < ci.soil + 12) v = M.gravel;
      else v = LITH_MAT[lr] !== undefined ? LITH_MAT[lr] : bedMat;
      // ⭐ A LITHOLOGY IS BEDDED, NOT UNIFORM. Horizontal bands with a little dip make sedimentary rock read as
      // sedimentary — and it is what a mesa's terraces need to line up with, so the two rules agree by
      // construction rather than by tuning.
      // 🟥 THIS GATE READ THE UNJITTERED PER-COLUMN `lith` WHILE THE ROCK IT BEDS (`v`, two lines up) READS THE
      // JITTERED PER-ROW `lr`, AND THE DISAGREEMENT WAS VISIBLE FROM ACROSS THE PICTURE. The whole point of
      // `lithAtRow` is that a geological contact is a SURFACE — it dips, it wanders, it is rough — but the
      // BEDDING, which is what the eye actually reads, still switched on the nearest coarse sample. So every
      // lithology contact was a dead-straight vertical line the full height of the section.
      // ⚠️ MEASURED, on the mesa the user objected to: the contacts sat at columns 366,048 and 366,560 — both
      // exactly `sample * 64 - 32`, because `gi = f < 0.5 ? i0 : i1` flips at the sample MIDPOINT — and 128 of
      // 620 cells changed in a single column step against a median of 6. That mod-32 signature is what
      // identified it, exactly as the 64-apart columns identified the stepped lake walls before it.
      // ⭐ Reading `lr` for both makes the bedding follow the same ragged, dipping contact as the rock, so the
      // two agree by construction — which is what the comment above already claimed they did. AFTER: 11 cells.
      // ⚠️ NOT the fault throws in the same panel: those are `bedShift`, they are deliberate, and a bed that
      // steps up across a line is the most legible structure in the section. Only the CONTACT is straightened.
      const bedRock = LITH_MAT[lr] !== undefined ? LITH_MAT[lr] : bedMat;
      if (v === bedRock && (lr === L.SANDSTONE || lr === L.LIMESTONE || lr === L.SHALE)) {
        const bed = Math.floor((r + ci.bedShift) / 21);
        const q = hh(seed, 435, bed, 0);
        if (q < 0.22) v = M.shale; else if (q < 0.34) v = M.limestone; else if (q < 0.46) v = M.sandstone;
      }
      // ⭐ DEPOSITS FIRST, THEN VOIDS — the order matters and is not arbitrary. A cave cuts through whatever is
      // there, including an ore vein, and a vein exposed in a cave wall is exactly the thing worth finding.
      // Doing it the other way round would fill the caves back in with ore.
      if (C.U) {
        // ⭐ MINERALS — association x depth x rarity, with a shape each. Depth is measured from the SURFACE, so
        // the same bed is two thousand rows down under a mountain and two hundred under a plain.
        const mn = mineralAt(RCmin, ci.oreCtx, c, r, d, C.seaRow - r, lr, seed);
        if (mn >= 0) v = mn;
        if (RCore) { const ob = oreBodyAt(RCore, c, r, lr, seed); if (ob >= 0) v = ob; }
        const dep = depositAt(C.U, W, M, ci, c, r, d, seed);
        if (dep >= 0) v = dep;
        carve = underAt(C.U, W, M, ci, c, r, d, seed, lr);
        // ⭐ CAVE SYSTEMS — storeys, the shafts that join them, chambers, and the way in. A placed record, so
        // there is no coarse sample anywhere in the answer and the question "can a player reach this" has an
        // owner. Proposed like every other void, so the chill margin and the water table both apply.
        if (carve < 0 && RCcaves.length && caveAt(RCcaves, c, r, C.seaRow, seed))
          carve = voidMaterial(C.U, M, ci, r, C.seaRow);
        // ⭐ THE WAY DOWN — a sea cave, an undercut or a cave mouth that keeps going, and joins a cave system's
        // lowest storey or the underworld's ceiling. Proposed like every other void, so the chill margin still
        // stops one that runs at a magma body.
        if (carve < 0 && RCdesc.length && descentAt(RCdesc, c, r, seed))
          carve = voidMaterial(C.U, M, ci, r, C.seaRow);
        // ⭐ PLACED OVERHANGS — arches, natural bridges, sea caves, undercut cliffs. Proposed like every other
        // void, so the chill margin covers them and the water table fills them: a sea cave comes out full of sea
        // because near a coast the water table IS sea level, and voids.js never had to learn what the sea is.
        if (RCvoids.length && voidAt(RCvoids, c, r, surfRow, seed)) carve = voidMaterial(C.U, M, ci, r, C.seaRow);
      }
    }
    // ── THE OTHER TWO DEPTH BANDS ────────────────────────────────────────────────────────────────────────────
    // ⭐ A SKY ISLAND IS DRESSED BY THE CLIMATE IT FLOATS IN, which is the form/dressing split paying off in a
    // place it was never designed for: one island generator, and the one over snow country wears snow.
    // ⚠️ It is a SURFACE now rather than a lens (see sky.js), so the stack, the dressing, the flora and even a
    // tarn all apply to it through the same rules the ground uses.
    if (v === M.air && d < 0 && RCsky.length) {
      const sv = skyAt(RCsky, M, LITH_MAT, c, r, seed);
      if (sv >= 0) v = sv;
    }
    // ⭐⭐ THE UNDERWORLD — a buried landscape rather than a room. See deepland.js. Proposed through the same
    // carve gate as every other void, which is what makes the chill margin cover it: the band and the magma
    // bodies overlap in elevation, so without the gate it would drain a volcano into the underworld.
    if (d > 0 && r > C.deepTop) {
      const dv = deepAt(C.deep, M, LITH_MAT, L, lr, c, r, seed);
      if (dv === M.air || dv === M.water) carve = dv;
      else if (dv >= 0) { v = dv; carve = -1; }
    }
    // ⭐⭐ THE OCEANIC CRUST, AND IT IS APPLIED HERE FOR A REASON — AFTER EVERY VOID PROPOSAL.
    // An aquiclude with a fracture swarm through it is not an aquiclude. `underAt`'s fractures fire on BRITTLE
    // rock and basalt is the most brittle thing in the table, so had this been placed up in the material stack
    // the seal would have been drilled full of holes by the very rule its own material invites. Same argument
    // and same shape as the chill margin below: the thing that must not have a void in it cancels the carve.
    // ⚠️ It also has to sit after the minerals, or an ore body straddling the bed would be a ready-made pipe
    // through it — which is exactly the kind of second path this track has missed four times.
    if (ci.crustD >= 0 && d >= ci.crustD && d < ci.crustD + ci.crustT) { v = M.basalt; carve = -1; }
    // ⭐ HYDROTHERMAL VENTS — after the crust, because a vent field sits ON the oceanic crust and its mound is
    // cut INTO it, so the crust must have had its say first and the vent overrides it locally. ⚠️ Its chimneys
    // are drawn above the sea bed and survive only because the water fill below writes into AIR ONLY.
    if (RCvent && RCvent.length) {
      const vv = ventAt(RCvent, M, c, r, surfRow, seed);
      if (vv >= 0) { v = vv; carve = -1; }
    }
    // ══ THE VOLCANO, AND THE CHILL MARGIN ═══════════════════════════════════════════════════════════════════
    // The single gate. `sealed` is asked only when there is actually a void to place, so the whole world pays
    // nothing for it — and a volcano is 0.05% of the columns in this world.
    // ⚠️ NOT GATED ON `d >= 0`. A talus is a heap that stands ON the ground, so most of it is above the
    // surface row — gated to underground only, the whole scree slope was buried and the panel showed a few grey
    // lumps under the soil. The deep chambers are unaffected: they are hundreds of rows down either way.
    if (C.forms.length) {
      const fm = formationAt(C.forms, M, c, r, seed);
      if (fm === M.air) carve = M.air; else if (fm >= 0) { v = fm; carve = -1; }
    }
    if (VS.length) {
      const vm = volcanoAt(VS, M, c, r, C.seaRow, surfRow, seed);
      // 🟥 THE VOLCANO'S OWN TUBES GO THROUGH THE GATE TOO, and the first version exempted them because they are
      // "generated outside the margin by construction". They are not: a trunk starts at the axis and its bore
      // wanders, so it grazes the conduit wall wherever the two noises happen to agree, and 39 lava cells drained
      // into one junction. A choke point that its author's own generator walks around is not a choke point.
      if (vm === M.air) carve = M.air;
      else if (vm >= 0) { if (vm !== M.lava || d >= 0 || v === M.air) { v = vm; carve = -1; } }
      if (carve === M.air || carve === M.water || carve === M.ice) {
        if (sealed(VS, c, r, C.seaRow, surfRow, seed)) carve = M.basalt;
      }
    }
    // ⭐ THE WORLD BEFORE IT WAS HOLLOWED OUT. `v` at this exact line is the rock this column is MADE of — the
    // lithology, its cover, its ores, an island's stone — and `carve` is everything that later takes a bite out
    // of it: caves, voids, sky gaps, descents, vents, volcano tubes. So the uncarved world is not a second
    // generator or a second pass; it is this one value, read one line earlier. It is what the client draws
    // BEHIND a cave, so a hollow reads as a hollow in solid ground rather than a hole cut through to the sky.
    // ⚠️ Above the ground `v` is already air here and stays air, which is right — there is nothing behind sky.
    // The surface water body is applied AFTER the carve, so the sea backs onto air too, which is also right.
    if (outBack) outBack[k] = v;
    if (carve >= 0) v = carve;
    // ── water: every air cell at or below the body's LEVEL. Flat by construction, shoreline exactly where the
    // ground crosses the line, and no coarse-sample boundary anywhere in the answer.
    // ⚠️ ABOVE THE GROUND ONLY (`r < surfRow`). Without it this floods every cave that happens to lie below the
    // level as well — which the underground module already decides, correctly, from the water table. Filling it
    // twice from two rules put water at the mouths of caves with air beside it, and the wake count rose.
    // ⭐ AND WHICH liquid is the classifier's answer, not `M.water`. This is where a closed basin becomes a
    // brine pan and a hot-spring field becomes hot: the shoreline rule is untouched, only the substance changes.
    // ⚠️ Depth 0 — a surface body is AT the surface, so it gets none of the geothermal term. Passing `d = r -
    // surfRow` here would be negative (the water is ABOVE the ground) and would read as a chilled cell.
    if (v === M.air && hasBody && r < surfRow) {
      const elevHere = C.seaRow - r;
      // ⭐ FLOATING ICE FIRST, and it is the one thing here allowed ABOVE the water line — a floe stands a ninth
      // of itself proud, so `elevHere <= waterE` would clip exactly the part you walk on. The band is computed
      // per column in `columnInfo` (see the polar-sea note there) and is -1e9..1e9 wide, i.e. empty, anywhere
      // it does not apply, so warm seas pay one comparison.
      // ⚠️ Against `waterE`, not against sea level, so ice forms on a cold LAKE by exactly the same rule.
      if (ci.iceTop > -1e8 && elevHere <= waterE + ci.iceTop && elevHere > waterE + ci.iceBot) v = M.ice;
      // ⭐ A BRINE POOL IS A SUBSTITUTION, NOT A SECOND FILL. The shoreline, the flatness and the "only above
      // the ground" rule are all the ordinary body fill's, exactly as the salt pan and the hot spring are — the
      // only thing the pool changes is WHICH liquid, below its own level. Filling it separately would be a
      // second rule writing the same cells, which is how the "water at the mouth of a cave" bug happened.
      else if (elevHere <= waterE) {
        v = (elevHere <= brineE) ? M.brine
          : M[liquidFor(atDepth(ci.sit, 0, ci.hot, { silica: ci.silica })).key];
      }
    }
    out[k] = v;
  }

  // ⭐ SNOW LIES ON ICE — a POST-PASS over the finished column, for the same reason the speleothems are one.
  // "Put snow on the sea ice" would need the sea-ice rule to know about it; "put snow on the glaciers" would
  // need the glacier rule to as well; and a frozen lake, a berg and a rimstone pool that froze would each need
  // their own. One rule that finds every ice cell with open air above it covers all of them, including ice put
  // there by a rule written later.
  // ⚠️ THREE CONDITIONS, AND EACH ONE IS LOAD-BEARING:
  //   · air ABOVE — snow settles on an exposed surface, not on the ice under the waterline;
  //   · ice BELOW — otherwise a one-cell floe would be turned entirely into snow, and snow is a POWDER that
  //     sinks through water, so the floe would dissolve into the sea on the first tick. Capping only ice that
  //     has ice under it means the sheet is always still a sheet;
  //   · a low-frequency FIELD, not a per-column coin flip — the user asked for variation, and dice give a
  //     one-cell salt-and-pepper mess rather than drifts you can see the shape of. Same objection, and the same
  //     cure, as the pack ice's leads twenty lines above.
  // ⚠️ Two cells deep only where the field is strongly positive AND there is ice to spare, so a thin sheet is
  // never mostly snow.
  // ⚠️ COLD COLUMNS ONLY, AND THAT IS A COST DECISION AS WELL AS A CORRECTNESS ONE. This is a full extra pass
  // over the column; gating it on the climate the user actually described ("arctic and similar places") means
  // the ~90% of the world that is not cold pays one comparison. An ice cell in a temperate cave gets no snow,
  // which is also right — snow does not fall indoors.
  if (ci.temp < 0.22) {
    const sn = fb1(seed, 823, c * nd(210).q, 3, nd(210).p);
    if (sn > 0.44) {
      const deep = sn > 0.70;
      for (let k = 0; k < rN; k++) {
        if (out[k] !== M.ice) continue;
        // 🟥 `k === 0` IS THE TOP OF THIS CHUNK'S SLICE, NOT THE TOP OF THE WORLD. The first version read
        // `k > 0 && out[k-1] !== M.air`, which SKIPPED the air test entirely at k = 0 — so every 64 rows, at
        // each chunk boundary that happened to fall inside a body of ice, a row of snow was painted straight
        // through the middle of it. Reported from play as "random slices of snow in the middle of ice", and
        // visible as a clean horizontal white line across a floe. We do not know what is above row 0 of a
        // slice, so the honest answer is to place nothing; the true surface is almost never exactly there.
        if (k === 0 || out[k - 1] !== M.air) continue;                // not the top of an exposed run (and not an unknown boundary)
        if (k + 1 >= rN || out[k + 1] !== M.ice) continue;            // nothing underneath to keep it a sheet
        out[k] = M.snow;
        if (deep && k + 2 < rN && out[k + 2] === M.ice) out[k + 1] = M.snow;
        break;                                                        // the FIRST exposed ice surface only; deeper runs are inside the ice
      }
    }
  }

  // ── VEGETATION AS TERRAIN CELLS — the user's decision, and it costs nothing structurally ──────────────────
  // ⚠️ Placed AFTER the ground so it can sit on it. A tree is a trunk plus a canopy, both ordinary cells; it is
  // destructible for free and needs no object system, which is the whole reason for doing it this way.
  // ⭐ THE THREE HARD-CODED PLANTS THAT STOOD HERE ARE NOW A SPECIES TABLE — see flora.js. One shape with a
  // cold/warm boolean, plus a cactus, was three plants for a world with seventeen biomes; and every part of
  // every neighbouring tree was placed on THIS column's ground, so on a hillside a crown hung in the air at one
  // end and was buried at the other.
  // ⭐⭐ SPELEOTHEMS — a POST-PASS over the finished column, which is what makes them general: it finds every
  // run of air, whoever carved it, and decorates its ceiling and floor. The karst systems, the underworld, the
  // lava tubes, the placed overhangs and the fracture swarms all get dripstone from one rule, including voids
  // that did not exist when it was written. Same choke-point argument as the chill margin.
  decorate(out, r0, rN, c, seed, M, {
    soluble: lith === L.LIMESTONE || lith === L.EVAPORITE,
    icy: ci.temp < 0.12,
    verdant: ci.temp > 0.48 && ci.moist > 0.52,     // vines: warm and wet, at a lit ceiling
    surfRow,
  });
  // ⭐ RIMSTONE POOLS — immediately after the speleothems that build the lips, and BEFORE the flora, because the
  // pool has to see the finished floor (stalagmites included) and nothing above ground can be standing in it.
  if (C.rim.length) fillRimstone(C.rim, out, r0, rN, c, M, (v) => v === M.water || v === M.ice || IS_LIQ[v]);
  drawFlora(W, C, columnInfo, ci, c, r0, rN, out, seed, M, waterE, hasBody, SPECIES);
  // ⭐ AND THE SAME TABLE ON THE ISLANDS. One line, because an island is a surface with a climate — which is the
  // whole return on making it one instead of a lens.
  for (const I of RCsky) {
    if (Math.abs(wdc(c - I.at)) >= I.hwPx - 2) continue;
    const si = skyColumnInfo(I, ci, c, seed);
    if (!si) continue;
    // the tarn's level in the SAME virtual frame as `si.elev`, or the shore species read it against the wrong
    // zero and reeds grow on hilltops
    // ⚠️ the span test is written as two ring deltas, not as `c > l && c < r`: an island straddling the join has
    // `l` numerically greater than `r`, and the plain comparison then excludes the whole tarn.
    const tE = I.tarn && wdc(c - I.tarn.l) > 0 && wdc(c - I.tarn.r) < 0 ? I.dressElev + (I.topRow - I.tarn.top) : -1e9;
    // ⚠️ a per-COLUMN reader, not one shared object: a plant's base must be its own anchor's ground, which is
    // the bug the user caught on the surface flora and would have been repeated here verbatim.
    drawFlora(W, C, (w2, c2, a) => skyColumnInfo(I, ci, a, seed), si, c, r0, rN, out, seed, M, tE, tE > -1e8, SPECIES);
  }
  // ⭐ AND ON THE UNDERWORLD FLOOR. Same table, same forms — the deep species simply address their windows
  // against depth and dampness instead of against climate, which is what `where: 'deep'` selects.
  const di = deepColumnInfo(C.deep, ci, c, M);
  if (di && di.surfRow > r0 && di.surfRow < r0 + rN + 60) {
    let lakeE = -1e9;
    for (const lk of C.deep.lakes) if (wdc(c - lk.l) > 0 && wdc(c - lk.r) < 0) lakeE = C.seaRow - lk.top;
    drawFlora(W, C, (w2, c2, a) => deepColumnInfo(C.deep, ci, a, M), di, c, r0, rN, out, seed, M, lakeE, lakeE > -1e8, SPECIES);
  }
  // ⭐⭐ THE MOUTH LAST OF ALL. It has to run after every rule that can WRITE into the column, and flora is the
  // last of those — a clearing applied before `drawFlora` would simply be grown over again, which is exactly how
  // the defect arises. Same argument that puts the speleothem post-pass where it is.
  // ⚠️ TWO GUARDS, and they are not redundant. A plant cell is cleared wherever it is, because a plant is what
  // does the sealing. Anything else is cleared only ABOVE this column's own ground — without that, a mouth on a
  // slope would cut a trench into the hillside beside it, since the chimney is vertical and the ground is not.
  if (MOUTH === 'clear' && RCcaves.length) {
    for (let k = 0; k < rN; k++) {
      const r = r0 + k, v = out[k];
      if (v === M.air) continue;
      if (!IS_PLANT[v] && r >= surfRow) continue;
      if (mouthClearAt(RCcaves, c, r, seed)) out[k] = M.air;
    }
  }
}

// Build the per-sample lookups the column reader needs (feature at a sample, water surface at a sample).
function prepare(W, seaRow) {
  const U = prepareUnder(W, seaRow);
  const featAt = new Array(W.n).fill(null);
  for (const f of W.features) for (let i = f.a; i <= f.b; i++) featAt[i] = f;
  const C = {
    seaRow,
    U,
    // ⚠️ TWO PHASES, and the split is forced rather than stylistic. The crater's SHAPE is needed by
    // `columnInfo`, and the lava LEVEL is found by measuring the surface `columnInfo` produces — so geometry is
    // placed first, the records go into `C`, and only then can the level scan run. Doing it in one pass means
    // asking for the ground before the crater that shapes it exists.
    volc: [],
    voids: [],
    forms: [],
    descents: [],
    cliffs: prepareCliffs(W),
    caves: [],
    // ⚠️ empty while the records above are being PLACED — `prepareRimstone` itself reads columns, and a record
    // that is being built must not be visible to the reader building it. Same reason `volc`/`caves` start empty.
    rim: [],
    featAt,
    // ⭐⭐ A WATER BODY IS A LEVEL, AND MEMBERSHIP IS DECIDED PER CELL BY COMPARING TO IT.
    // 🟥 This used to ask `isSea[i]` / `isLake[i]` — flags held PER COARSE SAMPLE — so whether a column had
    // water in it at all toggled in 64-column steps. That is the same "categorical field sampled per coarse
    // cell" bug as the biome boundaries, the lithology contacts, the gallery levels and the water table, for
    // the FIFTH time on this track, and here it is the worst of the five: a step in a water surface is not
    // merely ugly, it is a body that wakes and has to level itself.
    // ⇒ the sea is simply "every air cell at or below sea level", and a lake is "every air cell at or below ITS
    // level", which makes both surfaces exactly flat by construction and puts the shoreline precisely where the
    // ground crosses the line — no sample boundary anywhere in the answer.
    // ⚠️ The lake's horizontal reach is still taken from its sample span, deliberately widened: the elevation
    // test then decides the actual edge, so the span only has to be generous rather than exact.
    lakeLevelAt(c) {
      const t = c / W.dx;
      const i0 = wsamp(W, Math.round(t));
      // 🟥🟥 MEMBERSHIP HAS TO BE PER CELL AS WELL AS THE LEVEL, and getting only half of that is what produced
      // the blocks the user photographed: rectangles of water standing in the sky, stepping in 64-column
      // stages. The level comparison was per cell, but WHETHER A COLUMN IS IN A LAKE AT ALL was still
      // `lakeId[nearest sample]`, so at every sample boundary the lake switched on or off and left a wall.
      // The offending columns came out at 210,079 / 210,144 / 210,208 — 64 apart, which is the stride, and that
      // is what identified it.
      // ⇒ a lake reaches one sample beyond its recorded span, and the ELEVATION TEST decides the shoreline:
      // beyond the true edge the ground is above the level, so no water is placed and the reach costs nothing.
      // ⚠️ ONE sample, not three. Three lets a column claim a lake it is not connected to — measured, that put
      // water in neighbouring hollows and took the wake count from 38 to 87.
      for (let dk = -1; dk <= 1; dk++) { const k = wsamp(W, i0 + dk);
        if (W.lakeId[k] < 0) continue;
        const lk = W.lakes[W.lakeId[k]];
        if (lk && !lk.dry) return lk.level;
      }
      return -1e9;
    },
    // 🟥🟥 THIS WAS THE STAIRCASE. It read `isRiver[i]` AND `h[i]` from the nearest coarse sample, so both the
    // presence of the channel and its water level were constant for 64 columns and then jumped — which is
    // exactly the stepped blue blocks in the gorge and caldera panels. Interpolated in both, so the surface is
    // continuous.
    // ⚠️ AND A SLOPING RIVER SURFACE IS STILL NOT SETTLED. Removing the steps removes the 64-column walls, but
    // water whose surface follows a gradient has air beside it at every cell and wakes anyway. A river that is
    // genuinely at rest has to be a chain of LEVEL pools with drops between them — the same treatment the
    // underground basins got, and the same argument. Left undone deliberately; noted rather than hidden.
    riverElevAt(c) {
      const t = c / W.dx;
      const ti = Math.floor(t), i0 = wsamp(W, ti), i1 = wsamp(W, i0 + 1);
      const f = t - ti;
      const w = (W.isRiver[i0] ? 1 - f : 0) + (W.isRiver[i1] ? f : 0);
      if (w < 0.5) return -1e9;
      return W.h[i0] * (1 - f) + W.h[i1] * f - 3;
    },
  };
  C.volc = prepareVolcanoes(W);
  C._ci = new Map();
  settleVolcanoes(C.volc, W, C, columnInfo);
  // ⚠️ AFTER the volcanoes, and after the surface exists: every overhang is sited on the FINISHED ground — the
  // height of a fin, the position of a cliff face — which is not knowable from the coarse field.
  // ⚠️ Resolved ONCE here rather than filtered per column: `fillColumn` asks "am I in an atoll" for every
  // column in the world, and there are 0-4 atolls, so the filter must not be inside that question.
  C.atolls = (W.oceanFeatures || []).filter(f => f.atoll);
  C.brine = (W.oceanFeatures || []).filter(f => f.kind === 'brinepool');
  C.vents = prepareVents(W, C, columnInfo);
  C.voids = prepareVoids(W, C, columnInfo);
  C.caves = prepareCaves(W, C, columnInfo);
  // 🟥 THE CACHE HOLDS THE UNDEPRESSED GROUND. A doline is a function of the cave records, so every column read
  // while the caves were being PLACED was computed before those records existed and is now wrong — and it would
  // have been served to `prepareSky`, `prepareFormations` and `prepareDescents`, which all run below this line.
  // Exactly the reason `settleVolcanoes` gets a fresh cache above. A stale memo is a broken measurement that
  // looks like a broken mechanism, which is the mistake this track makes more than any other.
  if (MOUTH === 'doline') C._ci = new Map();
  // ⚠️ LAST, because an island's tarn level is found by measuring the surface the island will draw, and its
  // climate is the ground's corrected to its own altitude — both need the finished column reader.
  C.sky = prepareSky(W, C, columnInfo, dress, M);
  C.deep = prepareDeep(W, C);
  // the cheapest possible early-out for the 80% of the world that is nowhere near the band
  C.deepTop = C.seaRow + 560;
  C.forms = prepareFormations(W, C, columnInfo, L);
  // ⚠️ LAST of all: a descent needs both ends to exist — the surface mouths (voids, caves) and the thing it
  // joins (a cave storey or the underworld ceiling).
  C.descents = prepareDescents(W, C, columnInfo, M);
  // ⚠️ AFTER the caves, because a rimstone pool sits on a cave storey and needs the system records; and it reads
  // the storey geometry through `levelRow`/`levelBore`, the same two functions `caveAt` uses, rather than a
  // second opinion about where the floor is.
  C.rim = prepareRimstone(W, C, levelRow, levelBore, L, fillColumn);
  return C;
}

module.exports = { MATS, M, fillColumn, columnInfo, prepare, dress, setMouthMode };
