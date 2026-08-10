'use strict';
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// eleven others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');
// ==============================================================================================================
//  worldspike/volcano.js — THE VOLCANO AS A PLACED RECORD, AND THE RULE THAT KEEPS LAVA WHERE IT WAS PUT.
//
//  A volcano was three lines inside the cell loop: `if (kind === 'volcano' && |c - centre| < bore) lava`. That is
//  a vertical bar, and the pictures showed exactly a vertical bar — dead straight, constant width, no crater, and
//  crossed by every other void-maker in the world.
//
//  ⭐⭐ THE ONE RULE THAT MATTERS HERE IS **THE CHILL MARGIN**, and it is a rule about the WHOLE WORLD rather
//  than about volcanoes. Lava is a FLUID in this game. Anything that carves a void within a few cells of a lava
//  body has not drawn a cave next to a volcano — it has drawn a drain, and the first player to walk past watches
//  the mountain empty itself into the cave system. So instead of ordering the generators and hoping (which is
//  what "fractures must run before conduits" would be, and which breaks the moment a new generator is added),
//  every void-maker asks ONE question: is this cell within SEAL cells of lava? If it is, it writes chilled BASALT
//  instead of air. The cave still exists, it simply stops at a wall — which is what a real tunnel driven at a
//  magma body does, and it reads as a dark rim around the melt.
//  ⚠️ This is a CHOKE POINT, not a fix at each call site. That is deliberate: the previous four times this track
//  fixed something per-site, a second site was missed (the two `bucketize` calls, the two `relayPos` reshapes).
//
//  ⭐ THE OPEN CRATER IS CONTAINED BY THE SAME ARGUMENT THE UNDERGROUND POOLS WERE: the lake level RISES ONE ROW
//  AT A TIME AND KEEPS THE LAST LEVEL THAT HELD, measured against the crater's own roughened rim profile. A level
//  picked as a fraction of the crater depth would spill wherever the noise happened to cut the rim low, and a
//  spilling lava lake is a world that rearranges itself the moment anybody looks at it.
//
//  ⚠️ Everything here is keyed on the volcano RECORD's own column in cells, never on `featAt[nearest sample]`.
//  A crater whose existence toggles at a 64-column sample boundary is mistake #1 of this track for the sixth
//  time, and a crater is the worst place for it: the rim would step by tens of rows and the lake would pour out.
// ==============================================================================================================

// How much chilled rock the world guarantees between any lava body and any void. 8 cells = 64 px, thick enough
// to read as a wall at walking scale rather than as a suspiciously thin skin.
const SEAL = 8;

// The magma body. ⚠️ These are the numbers the old `depositAt` used and they are deliberately unchanged — the
// user's call was "keep it huge": a regional sheet of melt that several volcanoes tap, and the thing you hit if
// you dig far enough down anywhere near a volcanic region. Moved here only so that ONE file owns "where is lava",
// which is what makes the chill margin possible at all.
// ⚠️ 700x480 → 480x320, ON THE USER'S JUDGEMENT FROM `out/overworld_slices.png`: the chamber was a solid orange
// mass most of the world's depth tall and read as disproportionate. The brief was "smaller, but still huge and
// vast AT THE SCALE OF THE PLAYER", so the number is set against that scale rather than against the picture:
// one screen at default zoom is roughly 480 cells wide, so 960x640 cells is about two screens across and two
// and a half tall. You cannot see it all at once, which is the property that was wanted. Area is 46% of before.
const CH_HW = 480, CH_CY = -1000, CH_HH = 320;

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  ⭐⭐ THE CRYSTALLISED CORE — the chamber stops being a bag of lava and becomes somewhere to GO.
//
//  A magma chamber that is uniformly molten is a hazard and nothing else: there is no reason to approach it and
//  nothing to find if you do. Real ones are not uniform — a cooling body crystallises, and the coarse-grained
//  plutonic rock it leaves behind is where the finest crystals in the world grow, because the last of the melt
//  concentrates the water and the rare elements that ordinary rock has no room for. That is a PEGMATITE, and it
//  is where real emeralds, topaz and tourmaline come from.
//
//  ⇒ the melt becomes an ANNULUS around a solid core of granite, with pegmatite pods carrying gems towards the
//  middle of it, and one sealed gas cavity — a VUG — that nothing connects to.
//  ⭐ Every part of that is a real feature of a real pluton, which is this track's rule for content: it comes
//  from something that exists, so it hangs together without anybody deciding it should.
//
//  ⚠️ THE CORE HAS TO BE ABSENT FROM THE LAVA FIELD, not merely drawn over it. `sealed()` refuses a void
//  anywhere within SEAL of melt, so a vug drawn inside a chamber that still reports as lava is bricked back up
//  the moment it is proposed — the chill margin would eat the secret it exists to protect. So `lavaDepthAt`
//  reports the core as NOT melt, at a distance that grows inward, which keeps a chilled rind at the core's own
//  boundary (correct — that contact IS chilled) and frees the middle.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const CORE_F = 0.46;                                  // the core, as a fraction of the chamber's radius
const CORE_SCALE = Math.min(CH_HW, CH_HH) * CORE_F;
// Normalised radius within the CORE: <1 is inside it. ⚠️ Roughened on the RADIUS, not on anything else — an
// analytic ellipse reads as maths at full size, which is the objection that has now cost this track four
// features (the sky islands, the crater rim, the sea cave and the lattice shafts).
function coreQ(V, c, r, seaRow, seed) {
  const elev = seaRow - r, dxx = wdc(c - V.at);
  const rn = Math.sqrt(Math.pow(dxx / CH_HW, 2) + Math.pow((elev - CH_CY) / CH_HH, 2));
  const rough = CORE_F * (0.80 + 0.40 * fb1(seed, 951 + (V.at & 63), (c + r * 0.4) * nd(90).q, 3, nd(90).p));
  return rn / Math.max(0.05, rough);
}

// ==============================================================================================================
//  PLACEMENT — geometry only. The lava LEVEL needs the finished surface and so is a second pass.
// ==============================================================================================================
function prepareVolcanoes(W) {
  const seed = W.o.seed, out = [];
  for (const f of W.features) {
    if (f.type !== 'volcano') continue;
    const at = Math.round(f.at * W.dx);
    const halfW = Math.round((f.b - f.a + 1) * W.dx / 2);
    const V = {
      at, halfW, sample: f.at,
      // ⭐ THE VARIANT. Roughly two in five stand open with the lava exposed; the rest are plugged, and the
      // difference is one flag read everywhere it matters rather than two generators.
      open: hh(seed, 901, f.at, 0) < 0.42,
      // ⚠️ 0.17 of the half-width, floored at 16, gave a crater 64 cells across — a SLOT, and the picture showed
      // the conduit filling it end to end with no bowl visible at all. A crater is a landmark: about a quarter
      // of a screen to half a screen wide (a screen is roughly 480 cells at the default zoom).
      craterR: Math.round(cl(halfW * 0.28, 30, 130) * (0.8 + 0.5 * hh(seed, 903, f.at, 1))),
      // ⚠️ 9..18 gave a pipe up to 46 cells (368 px) across, which is wider than the crater's flat floor —
      // so the conduit FILLED the bowl and the lake came out as a funnel with two horns rather than a lake with
      // a shore. The conduit is the thing in the middle of the crater, not the crater.
      bore: 5 + Math.round(6 * hh(seed, 907, f.at, 3)),
      wander: 18 + 46 * hh(seed, 909, f.at, 4),
      // ⭐ COMPOSITION — the one number that decides whether this volcano's melt RUNS or CRAWLS. A basaltic
      // (low-silica) melt is thin and flows for miles; a rhyolitic one is stiff with crystals and piles into a
      // dome over its own vent. It is a property of the VOLCANO, so it is drawn here once and read off the
      // record — mistake #3 on this track is a thing that is not the same from every column it touches, and a
      // magma resampled per cell would give a lava that changed viscosity down its own conduit.
      // ⚠️ BIMODAL, not skewed. A continuous `pow(u,1.9)` put the MEAN at 0.39, which sits nearer the stiff
      // point than the runny one, so 0.68% of situations came out rhyolitic against 0.43% basaltic — the
      // opposite of "most volcanoes are basaltic". Real magma series are genuinely bimodal (basalt/rhyolite,
      // the Daly gap), so the number is drawn that way and roughly one volcano in four is a stiff one.
      silica: hh(seed, 911, f.at, 5) < 0.74
        ? 0.04 + 0.22 * hh(seed, 913, f.at, 6)
        : 0.62 + 0.36 * hh(seed, 915, f.at, 7),
      systems: [],
    };
    V.craterD = Math.round(V.craterR * (0.70 + 0.40 * hh(seed, 905, f.at, 2)));
    V.rimH = Math.round(V.craterR * 0.30);
    // ⚠️ ELEVEN CRATERS IN FIVE WORLDS CAME OUT AS THE SAME SHAPE AT DIFFERENT SCALES — a symmetric bowl with two
    // matching horns. Only the contact sheet showed it; each one alone looked fine. The bowl was ONE analytic
    // profile with a roughened radius, and a roughened radius is not enough: it is the same objection that killed
    // the lens-shaped sky islands and the sine caves. What makes real craters differ is not noise, it is that
    // they are ASYMMETRIC — one rim built higher than the other, the vent off-centre, and often one side breached
    // where lava has cut its way out.
    // ⭐ THE BREACH NEEDS NO SPECIAL CASE FOR AN OPEN VOLCANO: the lake level rises until it is contained, so a
    // breached crater simply holds a shallower lake, and a badly breached one holds none. The containment scan
    // was already the right mechanism and it pays for itself a second time here.
    V.rimA = V.rimH * (0.55 + 0.9 * hh(seed, 967, f.at, 6));
    V.rimB = V.rimH * (0.55 + 0.9 * hh(seed, 969, f.at, 7));
    V.skew = (hh(seed, 971, f.at, 8) - 0.5) * 0.44;                 // the vent sits off the middle of the bowl
    V.breach = hh(seed, 973, f.at, 9) < 0.40
      ? { dir: hh(seed, 975, f.at, 10) < 0.5 ? -1 : 1, depth: V.craterD * (0.35 + 0.6 * hh(seed, 977, f.at, 11)) }
      : null;
    // the coarse ground at the rim radius — the level the crater is cut to. Interpolated, never nearest-sample.
    // ⚠️ WRAPPED, not clamped: a volcano within a crater radius of the join reads its rim level off the sample
    // on the other side of it, which is where that ground actually is.
    const hAt = (cc) => {
      const t = cc / W.dx, ti = Math.floor(t);
      const i0 = ((ti % W.n) + W.n) % W.n, i1 = (i0 + 1) % W.n;
      return lp(W.h[i0], W.h[i1], sm(cl(t - ti, 0, 1)));
    };
    V.rimElev = (hAt(at - V.craterR) + hAt(at + V.craterR)) / 2;
    // ── BRANCH TUBES. The user's idea, and it is real: a conduit feeds lateral tubes that drain when the eruption
    // stops, leaving an empty pipe.
    // 🟥 THE FIRST VERSION MADE THEM SPOKES — n independent tubes all radiating from the axis — and the reach
    // measurement said what that is worth: 13% of the underground air connected to anywhere, and one volcano at
    // 0%. Every spoke is a separate dead end whose only junction is the axis, and the axis is exactly where the
    // chill margin plugs it. ⭐ SO A SYSTEM IS A TREE: one TRUNK that starts against the conduit wall and runs
    // out until it daylights on the flank, and LIMBS that leave the trunk part-way along and descend to
    // chambers. That is also what real tube systems do — they braid and they branch — and it means one mouth
    // makes the whole system explorable instead of one tube.
    for (const dir of [-1, 1]) {
      const s = hh(seed, 931, f.at, dir + 3) < 0.12 ? null : {
        dir,
        salt: 951 + ((f.at * 7 + (dir + 1) * 61) & 511),
        // shallow enough that a cone's flank always falls away past it — the trunk's job is to reach daylight
        depth: Math.round(70 + hh(seed, 933, f.at, dir + 9) * 190),
        slope: 0.03 + 0.11 * hh(seed, 939, f.at, dir + 17),     // tubes DESCEND away from the vent
        bore: 6 + Math.round(6 * hh(seed, 937, f.at, dir + 25)),
        len: 0, row: 0, limbs: [],
      };
      if (!s) continue;
      const nl = 1 + Math.floor(hh(seed, 943, f.at, dir + 33) * 3);
      for (let k = 0; k < nl; k++) s.limbs.push({
        t: (k + 0.35 + 0.5 * hh(seed, 945, f.at, dir * 100 + k)) / (nl + 0.4),   // where along the trunk it leaves
        slope: 0.06 + 0.34 * hh(seed, 947, f.at, dir * 100 + k + 40),
        bore: 4 + Math.round(5 * hh(seed, 949, f.at, dir * 100 + k + 80)),
        salt: 1471 + ((f.at * 11 + k * 29 + (dir + 1) * 7) & 511),
        len: 60 + Math.round(hh(seed, 953, f.at, dir * 100 + k + 120) * 200),
        x0: 0, row0: 0, chamber: null,
      });
      V.systems.push(s);
    }
    out.push(V);
  }
  return out;
}

// ==============================================================================================================
//  THE FORM — a crater cut into the summit, in the same `detail` term every other landform's signature uses.
// ==============================================================================================================
// 🟥 THE FIRST VERSION SUBTRACTED A FIXED DEPTH AND PRODUCED NO CRATER AT ALL — and the numbers looked fine, so
// this was only caught by dumping the surface profile and reading it. The coarse volcano cone is `lift: 300` over
// a half-width of about 160 cells, so it falls **117 rows** across the crater's own radius. Digging 27 rows out
// of a slope that steep leaves a summit that is still 90 rows higher in the middle than at the rim: a spike with
// a nick in it. ⭐ A CRATER IS NOT A DEPTH, IT IS A LEVEL — it removes the top of the cone and leaves a bowl
// hanging off the rim — so the rule is written as "put this column AT the crater's profile", measured from the
// coarse elevation at the rim radius, and it is then correct at any cone steepness instead of at one.
// ⚠️ TAKES the generic detail and RETURNS it, because a crater has to suppress it as well as add to it. The
// mountainside noise is ±23 rows on ground this steep, and a 25-row bowl underneath it is not a bowl, it is a
// rough summit — the x3 crater panel showed a dome with no crater in it while every number said there was one.
// A crater is a distinct form and carries its own, smaller, roughness; the mesa's terraces damp the generic
// detail for exactly the same reason.
function craterDetail(V, c, elevC, detail, seed) {
  // ⚠️ ROUGHENED RADIUS, not a roughened height. A circle of constant radius reads as an analytic shape however
  // much noise is added to its depth — the flying-saucer objection, which has now cost this track three features.
  const jit = 1 + (fb1(seed, 911 + (V.at & 255), c * nd(23).q, 3, nd(23).p) - 0.5) * 0.34;
  const t = wdc(c - V.at) / V.craterR;                   // signed, in crater radii
  const a = Math.abs(t - V.skew) / jit;
  if (a >= 1.75) return detail;
  // rim height blends across the bowl, so the two sides differ without a seam at the vent
  const rim = lp(V.rimA, V.rimB, sm(cl((t - V.skew + 1) / 2, 0, 1)));
  const br = V.breach && (t - V.skew) * V.breach.dir > 0
    ? V.breach.depth * Math.exp(-Math.pow((a - 1.0) / 0.5, 2)) : 0;
  // ⚠️ AND ITS OWN ROUGHNESS. The generic surface detail is scaled by the COARSE slope, which a crater has just
  // flattened to nothing — so damping it left the bowl perfectly smooth. Scaled to the crater's own depth.
  const GK = nd(Math.max(3, V.craterR * 0.20));
  const grain = (fb1(seed, 979 + (V.at & 127), c * GK.q, 3, GK.p) - 0.5) * V.craterD * 0.34;
  const want = V.rimElev + rim - br - V.craterD * (1 - Math.pow(Math.min(1, a), 3.2)) + grain;
  const w = a <= 1 ? 1 : sm(1 - (a - 1) / 0.75);      // full inside the rim, blended back to the cone outside it
  return detail * (1 - 0.62 * w) + (want - elevC) * w;
}
// Which volcano, if any, this column belongs to. Distance in CELLS, from the record — never from a sample.
function volcanoNear(Vs, c) {
  for (const V of Vs) if (Math.abs(wdc(c - V.at)) < V.craterR * 1.85 + 8) return V;
  return null;
}

// ==============================================================================================================
//  THE SECOND PASS — where the lava stands. Needs the finished surface, so it runs after `prepare`.
// ==============================================================================================================
function settleVolcanoes(Vs, W, C, columnInfo) {
  const seed = W.o.seed;
  for (const V of Vs) {
    const R = Math.round(V.craterR * 2.2) + 6;
    const cols = new Int32Array(R * 2 + 1);
    for (let k = 0; k <= R * 2; k++) cols[k] = columnInfo(W, C, V.at - R + k).surfRow;
    const mid = R;
    // the crater floor: the LOWEST ground (largest row) in the middle of the bowl.
    // 🟥 AND THE COLUMN IT IS IN, which the first version threw away — it then rose the level from the window's
    // CENTRE, and the moment the level passed the centre column's own ground the containment test was satisfied
    // by that column itself, at zero distance, in both directions at once. Reported as a lake "0 cells wide x 27
    // deep" whose level had climbed to within three rows of the summit. A sump is where the floor is lowest, not
    // where the arithmetic centre is.
    let floorRow = -1e9, midK = mid;
    const inner = Math.max(2, Math.round(V.craterR * 0.55));
    for (let k = mid - inner; k <= mid + inner; k++) if (cols[k] > floorRow) { floorRow = cols[k]; midK = k; }
    let summit = 1e9;
    for (let k = 0; k <= R * 2; k++) if (cols[k] < summit) summit = cols[k];
    V.floorRow = floorRow; V.summitRow = summit;

    // ⭐ RISE ONE ROW AT A TIME AND KEEP THE LAST LEVEL THAT HELD. Containment is a property of the rim profile,
    // and the rim is roughened, so the only honest way to find the level is to try them.
    let held = floorRow, hl = midK, hr = midK;
    for (let lvl = floorRow - 1; lvl > floorRow - V.craterD - V.rimH * 2 - 4; lvl--) {
      let kl = -1, kr = -1;
      for (let k = midK; k >= 0; k--) if (cols[k] <= lvl) { kl = k; break; }
      for (let k = midK; k <= R * 2; k++) if (cols[k] <= lvl) { kr = k; break; }
      if (kl < 0 || kr < 0) break;
      held = lvl; hl = kl; hr = kr;
    }
    // ⚠️ FREEBOARD, and it is a LOOK as much as a safety margin. Two rows filled the bowl to the brim and the x3
    // panel showed a mountain sawn in half and flooded — no shore, no rim standing over the lava, nowhere to
    // walk. A share of the bowl's own depth leaves a rim you can stand on and look down from, and it is also
    // several roundings clear of a spill, which is permanent.
    V.lakeTopRow = held + Math.max(3, Math.round(V.craterD * 0.28));
    // 🟥 AND THE LAKE'S WIDTH IS THE RIM, NOT A RADIUS — which the first picture showed in the loudest possible
    // way. Bounded by `|c - at| <= craterR * 1.6`, the lake reached past the rim onto the OUTER slope, where the
    // ground falls away below the level, so it poured down the mountainside as a rectangular slab hanging over
    // the flanks with air on three sides: 118 cells that would move on tick one. The containment scan already
    // knows exactly which two columns held the level in — those are the shore.
    V.lakeL = V.at - R + hl; V.lakeR = V.at - R + hr;
    V.lavaTopRow = V.open ? V.lakeTopRow
      : floorRow + SEAL + 16 + Math.round(hh(seed, 943, V.sample, 0) * 70);   // a plugged cone: capped in rock
    V.conduitBottomRow = C.seaRow - (CH_CY - CH_HH * 0.5);                    // merges into the melt below

    // ── how far each trunk runs: exactly as far as it takes to come out of the mountainside. ───────────────────
    for (const s of V.systems) {
      s.row = floorRow + s.depth;
      let len = 0, broke = false, closest = 1e9, closestAt = 0;
      const shallow = [];
      for (let x = V.bore + 12; x < 2600; x += 3) {
        // the tube's ACTUAL centre, wander included — see trunkRow's note
        const gap = trunkRow(s, x, seed) - trunkBore(s, x, seed)
          - columnInfo(W, C, V.at + s.dir * x).surfRow;                // how far under the ground the tube's roof is
        if (gap < closest) { closest = gap; closestAt = x; }
        if (gap <= 0) { broke = true; break; }
        if (gap < 170) shallow.push([x, gap]);
        len = x;
      }
      s.closest = Math.round(closest); s.closestAt = closestAt; s.walkShallow = shallow;
      // 🟥 THE FIRST VERSION DID NOT NOTICE THE LOOP RUNNING OUT and reported `L1107 > day` — a dead straight
      // 8,800-px pipe that never emerged, which is precisely the thing the comment beside it said not to build.
      // A `for` loop that finishes normally and one that `break`s are different answers and must be told apart.
      s.len = broke ? len + 8 : Math.round(120 + hh(seed, 955, V.sample, s.salt) * 260);
      s.daylights = broke;
      s.sky = [];
      // 🟥 THE WALK RUNS 2,600 CELLS AND THE TRUNK IS 170. Taking the skylight sites straight off the walk put
      // shafts 155 rows deep at x = 408 on a trunk that ends at 170 — a hole in the ground leading to nothing,
      // which is worse than no hole. The candidate sites are the trunk's OWN span, and not the first 30 cells of
      // it either, or a "skylight" would open into the crater floor beside the plug.
      s.shallow = s.walkShallow.filter(([x]) => x <= s.len && x > V.bore + 30);
      s.walkShallow = null;
      for (const l of s.limbs) {
        l.x0 = Math.max(V.bore + 20, Math.round(s.len * l.t));
        l.row0 = s.row + s.slope * l.x0;
        const cy = l.row0 + l.slope * l.len;
        l.chamber = {
          cx: V.at + s.dir * (l.x0 + l.len), cy,
          hw: 20 + Math.round(hh(seed, 957, V.sample, l.salt) * 48),
          hh: 14 + Math.round(hh(seed, 959, V.sample, l.salt + 1) * 26),
        };
        // ⭐ A FLAT FLOOR, for the same reason the deep halls got one: the bottom of an ellipse is not somewhere
        // a player can stand, and a chamber nobody can stand in is a hole rather than a place.
        l.chamber.floor = cy + l.chamber.hh * 0.55;
      }
    }

    // ── SKYLIGHTS, and the entrance guarantee ──────────────────────────────────────────────────────────────────
    // ⭐ A collapse hole in the roof of a lava tube is how real ones are found, and here it is what makes the
    // system meet a player at all. Placed only where the tube is genuinely shallow, so a skylight is a short
    // hole and not a mine shaft.
    // ⚠️ THE GUARANTEE IS DECIDED HERE, where it can be checked, rather than hoped for in the cell loop. Seed
    // 1234's volcano 3 had two blind trunks and a 71,000-cell tube system with NO WAY IN — measured at 0%
    // reachable, which is a landform that costs storage and gives nothing back.
    const punch = (s, x) => {
      const cx = V.at + s.dir * x;
      const top = columnInfo(W, C, cx).surfRow;
      const bot = Math.round(trunkRow(s, x, seed));
      if (bot <= top) return false;
      s.sky.push({ cx, top: top - 1, bot, bore: 3 + Math.round(hh(seed, 961, V.sample, x) * 4),
        salt: 1900 + ((V.sample * 5 + x) & 511) });
      return true;
    };
    for (const s of V.systems) {
      // ⚠️ THE SHALLOWEST SITES, not any site within 170 rows. A "skylight" 163 rows deep is 1,300 px of dead
      // straight vertical shaft — a mine, not a collapse hole, and it looked like one in the picture. Real tube
      // skylights are short: the roof falls in where the roof is thin. Sorted, and the best third is the pool.
      const pool = s.shallow.slice().sort((a, b) => a[1] - b[1]);
      if (!pool.length) continue;
      const good = pool.slice(0, Math.max(1, Math.ceil(pool.length / 3)));
      // ⚠️ AT LEAST ONE PER SYSTEM, not "nought to two". With a chance of zero, seed 1234's volcano 2 had a
      // perfectly good 131-cell trunk with three limbs and 14,000 cells of chamber that no player could ever
      // enter — sealed content still costs storage and gives nothing back.
      const want = 1 + Math.floor(hh(seed, 963, V.sample, s.salt) * 2);
      for (let k = 0; k < want; k++) punch(s, good[Math.floor(hh(seed, 965, V.sample, s.salt * 3 + k) * good.length)][0]);
    }
    if (!V.systems.some(s => s.daylights || s.sky.length)) {
      // nothing reaches the surface: drive one where the shallowest trunk comes closest, within its own span
      let best = null, bestX = 0, bestGap = 1e9;
      for (const s of V.systems) for (const [x, g] of s.shallow) if (g < bestGap) { bestGap = g; best = s; bestX = x; }
      if (best) punch(best, bestX);
    }
  }
}

// ==============================================================================================================
//  THE LAVA FIELD — signed, in cells. Positive inside the melt; the chill margin is simply `> -SEAL`.
//  ⚠️ Signed rather than boolean on purpose: "is there lava within 8 cells" answered by probing 8 cells in every
//  direction is 289 evaluations per cell, and answered by a distance is one.
// ==============================================================================================================
// ⭐⭐ ONE FUNCTION FOR WHERE A TUBE IS, used by the placement walk, by the cell loop and by the diagnostic.
// 🟥 They were three separate expressions and it cost two wrong conclusions in one run. The placement walk used
// the UNWANDERED centre line to decide where the tube came out of the mountainside, so it stopped the trunk at a
// column where the real, wandering tube was still 15 rows inside the rock — a mouth that placement reported as
// `DAYLIGHTS` and that the world sealed shut. And the diagnostic sampled the same unwandered line, so it read
// "granite 180" down the middle of a perfectly open tube and made a working passage look broken.
function trunkRow(s, x, seed) {
  return s.row + s.slope * x + (fb1(seed, s.salt, x / 110, 2) - 0.5) * 30;
}
function trunkBore(s, x, seed) { return s.bore * (0.7 + 0.6 * n1(seed, s.salt + 1, x / 46)); }
function limbRow(l, u, seed) {
  // the wander FADES IN from the junction: a limb with independent noise starts a few cells off the trunk it is
  // supposed to leave, and a tube that misses its junction by three cells is a separate sealed pocket.
  return l.row0 + l.slope * u + (fb1(seed, l.salt, u / 90, 2) - 0.5) * 26 * Math.min(1, u / 40);
}
function limbBore(l, u, seed) { return l.bore * (0.7 + 0.6 * n1(seed, l.salt + 1, u / 40)); }

function conduitAxis(V, r, seed) { return V.at + (fb1(seed, 921 + (V.at & 127), r / 260, 2) - 0.5) * V.wander; }
function conduitBore(V, r, seed) { return V.bore * (0.70 + 0.60 * n1(seed, 923 + (V.at & 127), r / 130)); }

// `top` distinguishes the two questions: the lava itself stops at its surface, but the SEAL only extends above
// the surface when the volcano is plugged. An open lake is *supposed* to have air over it — that is a free
// surface at rest, not a leak — and sealing above it would brick the crater over and undo the variant.
function lavaDepthAt(V, c, r, seaRow, seed, forSeal) {
  const elev = seaRow - r;
  let best = -1e9;
  // ── the conduit ────────────────────────────────────────────────────────────────────────────────────────────
  if (r >= V.lavaTopRow - (forSeal && !V.open ? SEAL : 0) && r <= V.conduitBottomRow + 4000) {
    const ax = conduitAxis(V, r, seed), bo = conduitBore(V, r, seed);
    let d = bo - Math.abs(wdc(c - ax));
    const topCut = r - V.lavaTopRow + 1 + (forSeal && !V.open ? SEAL : 0);
    if (topCut < d) d = topCut;
    if (d > best) best = d;
  }
  // ── the magma body ─────────────────────────────────────────────────────────────────────────────────────────
  const dxx = Math.abs(wdc(c - V.at));
  if (dxx < CH_HW * 1.4) {
    const rn = Math.sqrt(Math.pow(dxx / CH_HW, 2) + Math.pow((elev - CH_CY) / CH_HH, 2));
    const edge = 0.85 + 0.2 * n1(seed, 741, c * nd(90).q, nd(90).p);
    const q = coreQ(V, c, r, seaRow, seed);
    // ⭐ inside the core there is no melt — and the answer is a NEGATIVE distance that grows inward rather than
    // a flat "not lava", so the chill margin still holds along the core's own contact with the surrounding melt.
    const d = q < 1 ? -(1 - q) * CORE_SCALE : (edge - rn) * Math.min(CH_HW, CH_HH);
    if (d > best) best = d;
  }
  return best;
}
function lavaField(Vs, c, r, seaRow, seed, forSeal) {
  let best = -1e9;
  for (const V of Vs) { const d = lavaDepthAt(V, c, r, seaRow, seed, forSeal); if (d > best) best = d; }
  return best;
}

// ==============================================================================================================
//  THE CELL ANSWER. Returns a material id, or -1 for "not mine".
//  `above` is true for cells above the ground surface (the crater lake lives there); `surfRow` is this column's.
// ==============================================================================================================
// ⭐⭐ WHAT IS IN THE CORE. Returns a material, or -1 for "not mine".
// ⚠️ THE GEM SUITE IS PER VOLCANO, not per cell. A pegmatite carries the elements its own melt happened to
// concentrate, so one body is an emerald body and another is a topaz body — which is what makes finding a
// second one worth doing. Drawn from the record's column, so every cell of one core agrees about it (mistake #3).
const GEMS = ['emerald', 'ruby', 'sapphire', 'topaz', 'opal', 'amethyst', 'garnet', 'lapis', 'jade', 'diamond'];
function coreAt(V, M, c, r, seaRow, seed) {
  const q = coreQ(V, c, r, seaRow, seed);
  if (q >= 1) return -1;
  const salt = 953 + (V.at & 127);
  // ── THE SEALED VUG. A gas cavity the melt left behind, with nothing leading to it: the only way in is to dig.
  // ⚠️ Its centre is a hashed offset INSIDE the core rather than the core's own centre, so it is not where a
  // player would first guess, and two volcanoes do not hide it in the same place.
  const elev = seaRow - r, dxx = wdc(c - V.at);
  const vx = V.at + (hh(seed, salt, 1, 0) - 0.5) * CH_HW * CORE_F * 1.1;
  const vy = CH_CY + (hh(seed, salt, 2, 0) - 0.5) * CH_HH * CORE_F * 1.1;
  const vhw = 16 + Math.round(hh(seed, salt, 3, 0) * 16), vhh = 10 + Math.round(hh(seed, salt, 4, 0) * 10);
  const vq = Math.sqrt(Math.pow(wdc(c - vx) / vhw, 2) + Math.pow((elev - vy) / vhh, 2))
    / (0.78 + 0.44 * fb1(seed, salt + 5, (c + r * 0.5) * nd(19).q, 3, nd(19).p));
  if (vq < 1) {
    // lined, not filled: a crystal rind on the wall and open space inside, which is what a vug IS
    if (vq > 0.80) return M.crystal;
    return M.air;
  }
  void dxx;
  // ── THE PEGMATITE PODS. Towards the middle, because that is where the last melt — and its rare elements —
  // ends up. Lobed rather than round, from the same kind of thresholded field the ore bodies use.
  const f = fb2(seed, salt + 9, c * nd(26).q, elev / 34, 2, nd(26).p);
  const inner = 1 - q;                                          // 0 at the core's edge, 1 at its centre
  if (f + inner * 0.55 > 0.86) {
    const g = hh(seed, salt + 11, 7, 0);
    const key = GEMS[(g * GEMS.length) | 0];
    // ⚠️ a pod is mostly its host pegmatite with gems IN it — a solid mass of emerald is treasure, not geology,
    // and it would also make the rarest materials in the world the most abundant thing in the picture.
    const spot = hh(seed, salt + 13, c, r);
    if (spot < 0.16 && M[key] !== undefined) return M[key];
    return M.quartz;                                            // pegmatite reads as coarse white quartz
  }
  return M.granite;
}

function volcanoAt(Vs, M, c, r, seaRow, surfRow, seed) {
  for (const V of Vs) {
    if (Math.abs(wdc(c - V.at)) > Math.max(CH_HW * 1.4, V.halfW * 2.2)) continue;
    // ⭐ THE CORE FIRST — it is solid ground inside what used to be all melt, so it must answer before the lava
    // test that would otherwise claim the same cells.
    if (r >= surfRow) { const cm = coreAt(V, M, c, r, seaRow, seed); if (cm >= 0) return cm; }
    // ── the crater lake: every AIR cell inside the bowl at or below the level. Flat by construction, and the
    // shoreline is exactly where the bowl wall crosses the line — the same argument as the sea and the lakes.
    if (V.open && r < surfRow && r >= V.lavaTopRow && wdc(c - V.lakeL) > 0 && wdc(c - V.lakeR) < 0) return M.lava;
    // 🟥 `r <= surfRow` HERE CAPPED EVERY MOUTH WITH EXACTLY ONE CELL OF GROUND. `surfRow` is the topmost SOLID
    // row, so skipping it meant a tube that reached daylight, and a skylight punched deliberately to open one,
    // both stopped one cell short and stayed sealed. It survived because it is invisible at every scale: the
    // placement pass says DAYLIGHTS, the picture shows a tube running to the surface, and only the flood fill
    // disagrees — volcano 1 read "1,006-cell trunk, DAYLIGHTS, 0% reachable" for three runs.
    // ⚠️ The volcano may therefore write at the surface row; above it (`r < surfRow`) is already open air and is
    // the crater lake's business, handled above.
    if (r < surfRow) continue;
    const d = lavaDepthAt(V, c, r, seaRow, seed, false);
    if (d > 0) return M.lava;
    // ── the tube systems: AIR, and always outside the chill margin because the margin is applied to them too.
    // A trunk aimed at the axis therefore arrives at a wall of basalt with the live conduit behind it.
    for (const s of V.systems) {
      const x = wdc(c - V.at) * s.dir;
      if (x < 0) continue;
      if (x <= s.len && Math.abs(r - trunkRow(s, x, seed)) < trunkBore(s, x, seed)) return M.air;
      // ⭐ SKYLIGHTS. A real lava tube is found by its collapse holes, and they are the reason a tube system is
      // explorable at all: without one, a tube that fails to reach the flank is a sealed pipe nobody meets. Also
      // the guarantee — every volcano gets at least one way in, decided in the placement pass where it can be
      // checked, not hoped for here.
      // ⚠️ the shaft DRIFTS with depth. A pipe at a fixed column is a ruler-straight line and reads as drilled;
      // it is the same objection as the karst shafts, which were rectangles hundreds of rows tall until their
      // centre became a function of depth.
      for (const k of s.sky) {
        if (r < k.top || r > k.bot) continue;
        const dr = k.cx + (fb1(seed, k.salt, r / 34, 2) - 0.5) * 13;
        if (Math.abs(wdc(c - dr)) < k.bore) return M.air;
      }
      for (const l of s.limbs) {
        if (x >= l.x0 && x <= l.x0 + l.len) {
          const u = x - l.x0;
          if (Math.abs(r - limbRow(l, u, seed)) < limbBore(l, u, seed)) return M.air;
        }
        const ch = l.chamber;
        const q = Math.sqrt(Math.pow(wdc(c - ch.cx) / ch.hw, 2) + Math.pow((r - ch.cy) / ch.hh, 2));
        if (q < 1.3) {
          const rough = 0.72 + 0.5 * fb1(seed, l.salt + 2, (c + r * 0.3) * nd(30).q, 3, nd(30).p);
          if (q < rough) return r >= ch.floor + (fb1(seed, l.salt + 3, c * nd(60).q, 2, nd(60).p) - 0.5) * 5 ? M.basalt : M.air;
        }
      }
    }
  }
  return -1;
}

// Is a void forbidden here? True inside the chill margin of any lava body — and, separately, in the few cells
// directly under an open crater's lake, whose floor is the ground surface rather than the lava field.
function sealed(Vs, c, r, seaRow, surfRow, seed) {
  if (lavaField(Vs, c, r, seaRow, seed, true) > -SEAL) return true;
  for (const V of Vs) {
    if (!V.open) continue;
    if (wdc(c - V.lakeL) <= 0 || wdc(c - V.lakeR) >= 0) continue;
    // 🟥🟥 `r > surfRow` LEFT EXACTLY ONE ROW UNPROTECTED — THE ONE THE LAKE STANDS ON — and it is the whole of
    // the lava drain that switching latitude on exposed (13 cells, one volcano, one seed, 12 of them falling
    // straight down). The two rules meet here and neither owns the row: the crater lake fills `r < surfRow`
    // (strictly ABOVE the ground) and this margin protected `r > surfRow` (strictly BELOW it), so the surface
    // row itself belonged to neither, and a tube or a skylight — which are allowed to write AT `surfRow`, on
    // purpose, so they can daylight — punched air directly under the lake's bottom cell.
    // ⚠️ It does NOT undo the daylighting fix twenty lines above. This clause only fires INSIDE an open
    // crater's lake span, and a skylight that daylights into a lava lake is a hole in the bottom of a lake, not
    // a way in. Everywhere else on the flank the tube still reaches the surface row and opens.
    // ⚠️ And it is latitude-independent — the seed that shows it is in the default set either way. Latitude
    // moved the ground under this volcano by a row or two, which is all it took.
    if (surfRow >= V.lavaTopRow && r >= surfRow && r <= surfRow + SEAL) return true;
  }
  return false;
}

module.exports = { SEAL, prepareVolcanoes, settleVolcanoes, craterDetail, volcanoNear, volcanoAt, sealed,
  lavaField, trunkRow, trunkBore };
