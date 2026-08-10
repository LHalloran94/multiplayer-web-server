'use strict';
// ⭐ THE NOISE PRIMITIVES LIVE IN ONE PLACE (noise.js). They used to be copied into this file and
// eleven others; every copy was verified character-identical before extracting. The periodic forms take an
// optional trailing lattice period — see the header there.
const { hh, hc, sm, n1, n2, fb1, fb2, cl, lp, nd, nlat, latAt, shearQ, nfreq, wrapL, wdc, PERIOD_COLS } = require('./noise.js');
// a sine phase of one radian per column, quantised to a whole number of turns per world period (see the kelp)
const SWAY_K = 2 * Math.PI * Math.round(PERIOD_COLS / (2 * Math.PI)) / PERIOD_COLS;
// ==============================================================================================================
//  worldspike/flora.js — VEGETATION AS A SPECIES TABLE.
//
//  What this replaces was one shape with a boolean: a trunk, a canopy that was a cone if it was cold and a blob
//  if it was not, and a cactus in deserts. Three plants for a world with seventeen biomes.
//
//  ⭐⭐ THE SPLIT THAT MAKES THIS CHEAP IS THE SAME ONE THE LANDFORMS USE, one level down: a species is a NICHE
//  (where it grows), a FORM (its shape), and MATERIALS (what it is made of). Those three are independent, so the
//  table can say "a palm is a bare stem with fronds at the top, in hot wet places near water" in one line, and
//  adding the twelfth species costs a line rather than a generator. The forms are shared — `blob`, `cone`,
//  `bush`, `tuft` are each used by more than one species with different materials and sizes.
//
//  ⚠️ EVERY PART IS DRAWN FROM ITS ANCHOR'S OWN GROUND, not from the column being filled. A canopy four columns
//  wide on a hillside whose base is taken from the wrong column hangs in the air at one end and is buried at the
//  other; the old code took this column's `surfRow` for every part of every neighbouring tree.
//
//  ⚠️ AND THE NICHE THRESHOLDS ARE DITHERED. A species that stops dead at moisture 0.42 draws a straight vertical
//  line across a hillside — the same objection as every hard categorical boundary on this track. A per-column
//  hash nudges each threshold, so the edge of a wood is ragged.
// ==============================================================================================================

// ==============================================================================================================
//  THE SPECIES TABLE.
//    temp / moist   climate window, 0..1, dithered at the edges
//    elev           elevation window in rows above sea level (trees stop below the tree line)
//    steep          how much slope it tolerates, as the same 0..1 rank the dressing uses
//    spacing        cells between anchors — this is what makes a forest dense and a savanna sparse
//    h              height range in cells
//    form           the shape rule, shared between species
//    where          'land' (default) · 'shore' (within a few rows of a water surface) · 'water' (submerged)
//                   · 'rock' (bare steep ground)
// ==============================================================================================================
function buildSpecies(M) {
  return [
    // ── forests ────────────────────────────────────────────────────────────────────────────────────────────────
    { key: 'emergent', form: 'emergent', trunk: M.wood, foliage: M.leaves, salt: 5100,
      temp: [0.56, 1], moist: [0.64, 1], elev: [0, 420], steep: 0.60, spacing: [26, 52], h: [34, 62] },
    { key: 'broadleaf', form: 'blob', trunk: M.wood, foliage: M.leaves, salt: 5200,
      temp: [0.34, 1], moist: [0.40, 1], elev: [0, 520], steep: 0.88, spacing: [7, 22], h: [11, 30] },
    { key: 'conifer', form: 'cone', trunk: M.wood, foliage: M.needle, salt: 5300,
      temp: [0.09, 0.46], moist: [0.26, 1], elev: [0, 720], steep: 0.92, spacing: [6, 17], h: [14, 36] },
    { key: 'palm', form: 'palm', trunk: M.wood, foliage: M.frond, salt: 5400,
      temp: [0.56, 1], moist: [0.16, 1], elev: [0, 140], steep: 0.6, spacing: [11, 26], h: [16, 30], where: 'shore' },
    { key: 'mangrove', form: 'mangrove', trunk: M.wood, foliage: M.leaves, salt: 5500,
      temp: [0.54, 1], moist: [0.38, 1], elev: [-8, 20], steep: 0.45, spacing: [7, 15], h: [9, 17], where: 'shore' },
    // ── low cover ──────────────────────────────────────────────────────────────────────────────────────────────
    { key: 'scrub', form: 'bush', foliage: M.scrub, salt: 5600,
      temp: [0.30, 1], moist: [0.09, 0.44], elev: [0, 700], steep: 0.94, spacing: [4, 13], h: [2, 6] },
    { key: 'heath', form: 'bush', foliage: M.moss, salt: 5700,
      temp: [0.05, 0.34], moist: [0.34, 1], elev: [0, 900], steep: 0.94, spacing: [3, 9], h: [1, 3] },
    { key: 'reed', form: 'tuft', foliage: M.reed, salt: 5800,
      temp: [0.22, 1], moist: [0.42, 1], elev: [-3, 10], steep: 0.30, spacing: [2, 5], h: [3, 9], where: 'shore' },
    { key: 'cactus', form: 'cactus', foliage: M.cactus, salt: 5900,
      temp: [0.55, 1], moist: [0, 0.20], elev: [0, 600], steep: 0.7, spacing: [16, 44], h: [4, 13] },
    // ── the specialists ────────────────────────────────────────────────────────────────────────────────────────
    { key: 'snag', form: 'snag', trunk: M.driftwood, salt: 6000,
      temp: [0, 0.36], moist: [0.16, 0.62], elev: [0, 800], steep: 0.9, spacing: [30, 90], h: [8, 22] },
    { key: 'moss', form: 'skin', foliage: M.moss, salt: 6100,
      temp: [0.10, 0.72], moist: [0.52, 1], elev: [0, 900], steep: 1, spacing: [1, 1], h: [1, 1], where: 'rock' },
    // ⭐ LICHEN — the dry/cold complement to moss, and the ONLY thing that grows on bare rock above the treeline.
    // It is here because the cliff fix created bare rock: `dress` marks steep ground and, until this session,
    // that ground was capped with six to nine cells of LOAM, so there was no bare rock in the world for anything
    // to colonise. Fixing one thing made a niche that nothing filled — which is the form/dressing split working:
    // the rock does not know it is a cliff, and the lichen does not know either, they only share a slope.
    { key: 'lichen', form: 'skin', foliage: M.lichen, salt: 6500,
      temp: [0, 0.62], moist: [0, 0.58], elev: [0, 2400], steep: 1, spacing: [1, 1], h: [1, 1], where: 'rock' },
    // ── the underworld. ⚠️ `temp` here is DEPTH and `moist` is dampness — the deep column reader addresses the
    // same two axes with different meanings, which is what lets one species table serve two worlds.
    { key: 'shroom', form: 'mushroom', trunk: M.fungus, foliage: M.fungus, salt: 6300,
      temp: [0, 0.72], moist: [0, 1], elev: [-1e9, 1e9], steep: 1, spacing: [13, 34], h: [8, 32], where: 'deep' },
    { key: 'cavemoss', form: 'bush', foliage: M.moss, salt: 6400,
      temp: [0, 0.60], moist: [0, 1], elev: [-1e9, 1e9], steep: 1, spacing: [2, 6], h: [1, 4], where: 'deep' },
    { key: 'kelp', form: 'kelp', foliage: M.kelp, salt: 6200,
      temp: [0.18, 0.86], moist: [0, 1], elev: [-90, -6], steep: 1, spacing: [3, 8], h: [10, 46], where: 'water' },
  ];
}

// ==============================================================================================================
//  DOES THIS SPECIES BELONG AT THIS COLUMN? Thresholds dithered so the edge of a stand is ragged.
// ==============================================================================================================
// ⚠️ `slack` widens every threshold. It is used for the CHEAP GATE at the top of `drawFlora` and nowhere else:
// the gate exists only to skip species that cannot possibly be near this column, so it must never be able to
// veto a plant whose anchor is a few cells away. Asked strictly, it sliced crowns off vertically at every niche
// boundary — 4,000 flips per 100,000 columns.
function fits(S, ci, c, seed, seaRow, waterE, hasBody, slack) {
  const k = slack || 0;
  const j = (salt, amp) => (hc(seed, salt, c, 0) - 0.5) * amp;
  const t = ci.temp + j(S.salt + 1, 0.10), m = ci.moist + j(S.salt + 2, 0.12);
  if (t < S.temp[0] - 0.09 * k || t > S.temp[1] + 0.09 * k) return false;
  if (m < S.moist[0] - 0.12 * k || m > S.moist[1] + 0.12 * k) return false;
  const e = ci.elev + j(S.salt + 3, 26);
  if (e < S.elev[0] - 90 * k || e > S.elev[1] + 90 * k) return false;
  if (ci.steep > S.steep + j(S.salt + 4, 0.12) + 0.25 * k) return false;
  const where = S.where || 'land';
  // ⚠️ the deep band and the surface must not leak into one another: a species declared for one is refused
  // outright in the other, whatever its climate window happens to say.
  if ((where === 'deep') !== (ci.deep === true)) return false;
  if (k) {
    if (where === 'deep') return true;
    // the loose gate stops here: vent, snow and "is this column under water" are all per-COLUMN facts, and a
    // crown may perfectly well hang over any of them
    if (where === 'land' || where === 'rock') return true;
    return hasBody ? Math.abs(waterE - ci.elev) < 150 : false;
  }
  // ⚠️ SAME FRAME. The deep reader reports the floor's TRUE elevation and the lake level is a true elevation
  // too, so the ordinary "is this column under water" test works unchanged — which is the lesson from the sky
  // islands, where two rules disagreeing about what an elevation meant cost 202 islands their vegetation.
  if (where === 'deep') return !(hasBody && waterE >= ci.elev);
  if (where === 'land') return !ci.vent && !ci.canSnow && !(hasBody && waterE >= ci.elev);
  if (where === 'rock') return ci.steep > 0.28 && !ci.canSnow && !(hasBody && waterE >= ci.elev);
  // ⚠️ `shore` and `water` are about the WATER SURFACE, not about the coarse "is this a sea sample" flag — which
  // is the fifth instance of this track's mistake #1 and was fixed for the sea and the lakes already. A reed bed
  // is where the ground crosses the water line, wherever that happens to be.
  if (!hasBody) return false;
  const depth = waterE - ci.elev;                       // >0 submerged, <0 dry ground above the water
  if (where === 'shore') return depth > -14 && depth < 6;
  return depth > 6 && depth < 96;
}

// The water surface over a column, as an elevation — needed per ANCHOR, not per viewing column.
function waterAt(C, ci, c) {
  const lakeE = C.lakeLevelAt(c), rivE = C.riverElevAt(c);
  let e = ci.elev < 0 ? 0 : -1e9;
  if (lakeE > e) e = lakeE;
  if (rivE > e) e = rivE;
  return { e, has: e > -1e8 };
}

// ==============================================================================================================
//  THE FORMS. Each writes into one column of `out` for a plant anchored at `a` — so a form is asked about the
//  same plant once per column the plant touches, and must agree with itself every time.
// ==============================================================================================================
function drawForm(S, M, out, r0, rN, a, base, hgt, dx, seed, ci) {
  // 🟥 A PLANT THAT GROWS IN WATER CANNOT BE WRITTEN INTO AIR-ONLY CELLS. `put` refused anything that was not
  // already air, and underwater every cell is WATER — so kelp fitted 1,097 sample columns and drew ZERO cells,
  // and the reeds and mangrove roots below the water line were silently clipped. The census said the species
  // was fine because the census asks the NICHE, and the niche was fine; only the picture disagreed.
  const wetOk = S.where === 'water' || S.where === 'shore';
  const put = (row, mat) => {
    const k = row - r0; if (k < 0 || k >= rN) return;
    if (out[k] === M.air || mat === S.trunk || (wetOk && (out[k] === M.water || out[k] === M.ice))) out[k] = mat;
  };
  const adx = Math.abs(dx);
  const wob = (fb1(seed, S.salt + 9, a * nd(7).q, 2, nd(7).p) - 0.5);

  // ⭐⭐ ROOTS — one rule for every tree, before the form switch, because a root is not a shape a species has,
  // it is what having a trunk MEANS. Trees are terrain cells in this design and they stopped dead at the
  // surface row: dig one cell under a forest and there was nothing but loam. Now a felled trunk leaves a stump
  // with roots in the ground, and tunnelling under a wood runs into them.
  // ⚠️ Written as `S.trunk`, which is the one material `put` is allowed to write over non-air — so roots go
  // into SOIL rather than being clipped, which is the same clipping bug that once drew zero kelp underwater.
  // ⚠️ Not mangroves: their prop roots are already part of the form, and stacking the two gave a thicket.
  if (S.trunk && S.form !== 'mangrove' && S.form !== 'mushroom' && hgt >= 9) {
    const spread = Math.max(1, Math.round(hgt * 0.26));
    if (adx <= spread) {
      const taper = 1 - adx / (spread + 1);
      const dep = Math.max(1, Math.round(hgt * 0.20 * taper * (0.55 + 0.9 * n1(seed, S.salt + 19, (a + dx * 3) * nd(5).q, nd(5).p))));
      for (let y = 0; y < dep; y++) {
        // the taproot is continuous; the laterals are patchy, or a tree sits on a solid wooden wedge
        if (adx === 0 || n1(seed, S.salt + 21, (a + dx * 11 + y * 7) * nd(4).q, nd(4).p) > 0.40) put(base + 1 + y, S.trunk);
      }
    }
  }

  switch (S.form) {
    case 'blob': {
      // a broadleaf: a trunk that leans a little, and a crown wider than it is tall
      const cw = Math.max(3, Math.round(hgt * 0.46));
      const lean = Math.round(wob * hgt * 0.18);
      // ⚠️ A BOLE IS NOT ONE CELL WIDE. Every tree in the world was drawn on a single-column stem, so a
      // 30-cell broadleaf came out as a lollipop on a wire. Thickness scales with height, and it TAPERS.
      const tr = hgt > 22 ? 1 : 0;
      if (adx <= tr) for (let y = 1; y <= hgt; y++) { if (adx && y > hgt * 0.75) continue; put(base - y, S.trunk); }
      if (adx > cw) return;
      const cy = base - hgt - Math.round(cw * 0.35);
      const halfH = Math.round(cw * 0.85);
      for (let y = -halfH; y <= halfH; y++) {
        const wAt = cw * Math.sqrt(Math.max(0, 1 - (y / halfH) * (y / halfH)))
          * (0.78 + 0.44 * n1(seed, S.salt + 11, (a + y * 5) * nd(4).q, nd(4).p));
        if (adx <= wAt + lean * (y < 0 ? 1 : -1) * 0.2) put(cy + y, S.foliage);
      }
      // ⭐ BRANCHES. Two or three stubs off the trunk — the difference between a tree and a lollipop, and they
      // cost one loop because the canopy is already being drawn column by column.
      if (adx > 0 && adx < cw * 0.7) for (let b = 0; b < 3; b++) {
        if (hc(seed, S.salt + 13, a, b) > 0.55) continue;
        const by = base - Math.round(hgt * lp(0.45, 0.92, b / 2));
        if (Math.sign(dx) === (hc(seed, S.salt + 17, a, b) < 0.5 ? 1 : -1) && adx < cw * 0.55)
          put(by - Math.round(adx * 0.5), S.trunk);
      }
      return;
    }
    case 'emergent': {
      // rainforest giant: a bare buttressed bole, then a crown only at the very top
      const cw = Math.max(5, Math.round(hgt * 0.30));
      const tr = hgt > 44 ? 2 : 1;
      if (adx <= tr) for (let y = 1; y <= hgt; y++) { if (adx === tr && y > hgt * 0.8) continue; put(base - y, S.trunk); }
      // buttress roots: the bole flares at the bottom, which is what says "rainforest giant" and not "tall tree"
      if (adx > tr && adx <= tr + 2) for (let y = 1; y <= Math.round(hgt * 0.12 / (adx - tr)); y++) put(base - y, S.trunk);
      if (adx > cw) return;
      const cy = base - hgt - Math.round(cw * 0.2);
      for (let y = -Math.round(cw * 0.7); y <= Math.round(cw * 0.5); y++) {
        const wAt = cw * Math.sqrt(Math.max(0, 1 - Math.pow(y / (cw * 0.7), 2)))
          * (0.8 + 0.4 * n1(seed, S.salt + 11, (a + y * 3) * nd(5).q, nd(5).p));
        if (adx <= wAt) put(cy + y, S.foliage);
      }
      return;
    }
    case 'cone': {
      const cw = Math.max(2, Math.round(hgt * 0.24));
      if (dx === 0) for (let y = 1; y <= hgt; y++) put(base - y, S.trunk);
      if (adx > cw) return;
      const top = base - hgt - Math.round(hgt * 0.12);
      const bot = base - Math.round(hgt * 0.22);
      for (let rr = top; rr <= bot; rr++) {
        const f = (rr - top) / Math.max(1, bot - top);
        const wAt = cw * Math.pow(f, 0.8) * (0.75 + 0.5 * n1(seed, S.salt + 11, (a + rr * 3) * nd(4).q, nd(4).p));
        if (adx <= wAt) put(rr, S.foliage);
      }
      return;
    }
    case 'palm': {
      // ⭐ a bare curved stem with fronds ONLY at the top — the silhouette is the whole species
      const bend = wob * hgt * 0.30;
      for (let y = 1; y <= hgt; y++) {
        const f = y / hgt;
        if (dx === Math.round(bend * f * f)) put(base - y, S.trunk);
      }
      const tipX = Math.round(bend), tipY = base - hgt;
      const fw = Math.max(5, Math.round(hgt * 0.45));
      const d2 = dx - tipX, a2 = Math.abs(d2);
      if (a2 > fw) return;
      // ⭐ FRONDS ARE STROKES, NOT A CROWN. Drawn as a blob the palm read as a broadleaf on a bare stick; a frond
      // leaves the crown almost level and DROOPS, so the silhouette is a fountain — which is the whole species.
      for (let k = 0; k < 6; k++) {
        const dir = k % 2 ? 1 : -1;
        if (a2 && Math.sign(d2) !== dir) continue;
        const len = fw * (0.5 + 0.5 * hc(seed, S.salt + 19, a, k));
        if (a2 > len) continue;
        const droop = Math.pow(a2 / Math.max(1, len), 1.8) * (fw * 0.75);
        const rise = 1 + Math.floor(k / 2) * 2;
        put(tipY - rise + Math.round(droop), S.foliage);
      }
      return;
    }
    case 'mangrove': {
      // stilt roots below, a low tangled crown above
      if (adx <= 3) for (let y = -Math.round(hgt * 0.35); y <= hgt; y++) {
        if (y < 0 && adx !== Math.round(-y * 0.7)) continue;
        if (y >= 0 && dx !== 0) continue;
        put(base - y, S.trunk);
      }
      const cw = Math.max(3, Math.round(hgt * 0.55));
      if (adx > cw) return;
      const cy = base - hgt - 1;
      for (let y = -2; y <= Math.round(cw * 0.5); y++) {
        const wAt = cw * (0.7 + 0.5 * n1(seed, S.salt + 11, (a + y * 4) * nd(4).q, nd(4).p)) * (1 - Math.abs(y) / (cw * 0.9));
        if (adx <= wAt) put(cy + y, S.foliage);
      }
      return;
    }
    case 'bush': {
      const cw = Math.max(1, Math.round(hgt * 1.5));
      if (adx > cw) return;
      const hAt = Math.round(hgt * Math.sqrt(Math.max(0, 1 - Math.pow(adx / (cw + 0.5), 2)))
        * (0.7 + 0.6 * n1(seed, S.salt + 11, a * nd(3).q, nd(3).p)));
      for (let y = 0; y < hAt; y++) put(base - 1 - y, S.foliage);
      return;
    }
    case 'tuft': {
      if (adx > 1) return;
      const hAt = Math.round(hgt * (0.5 + 0.7 * n1(seed, S.salt + 11, (a + dx * 3) * nd(2.5).q, nd(2.5).p)));
      for (let y = 0; y < hAt; y++) put(base - 1 - y, S.foliage);
      return;
    }
    case 'cactus': {
      if (adx > 2) return;
      if (dx === 0) { for (let y = 1; y <= hgt; y++) put(base - y, S.foliage); return; }
      // arms: a stub out and then up, which is what makes a saguaro a saguaro
      for (let b = 0; b < 2; b++) {
        if (hc(seed, S.salt + 21, a, b) > 0.5) continue;
        if ((dx > 0) !== (b === 0)) continue;
        const ay = base - Math.round(hgt * lp(0.45, 0.7, b));
        put(ay, S.foliage);
        if (adx === 2) for (let y = 0; y < Math.round(hgt * 0.3); y++) put(ay - y, S.foliage);
      }
      return;
    }
    case 'snag': {
      if (adx > 1) return;
      const tall = Math.round(hgt * (adx ? 0.25 : 1));
      for (let y = 1; y <= tall; y++) put(base - y, S.trunk);
      return;
    }
    case 'mushroom': {
      // ⭐ a stalk and a domed cap — the one silhouette that says "underground" without a word of explanation
      // ⚠️ A CAP HALF THE HEIGHT OF THE STALK, at five cells' spacing, is a continuous fungal CEILING — which is
      // what the first version drew once the caps started appearing at all. A mushroom has to be able to stand
      // on its own or it is not a mushroom, it is a mat.
      const cap = Math.max(2, Math.round(hgt * 0.30));
      const stalkR = hgt > 15 ? 1 : 0;
      if (adx <= stalkR) for (let y = 1; y <= hgt; y++) put(base - y, S.trunk);
      if (adx > cap) return;
      const cy = base - hgt;
      const th = Math.max(1, Math.round(cap * 0.5));
      for (let y = 0; y < th; y++) {
        const wAt = cap * Math.sqrt(Math.max(0, 1 - Math.pow(y / th, 2))) * (0.85 + 0.3 * n1(seed, S.salt + 11, (a + y * 5) * nd(4).q, nd(4).p));
        if (adx <= wAt) put(cy - y, S.foliage);
      }
      return;
    }
    case 'skin': {
      // a one-cell rind on bare rock — lichen and moss, and the only species that is a coating rather than a plant
      if (dx !== 0) return;
      if (n1(seed, S.salt + 11, a * nd(9).q, nd(9).p) < 0.42) return;
      put(base - 1, S.foliage);
      return;
    }
    case 'kelp': {
      if (adx > 1) return;
      const tall = Math.min(hgt, Math.max(2, Math.round(hgt * (0.4 + 0.8 * n1(seed, S.salt + 11, a * nd(6).q, nd(6).p)))));
      for (let y = 1; y <= tall; y++) {
        // ⚠️ THE PHASE IS THE COLUMN, so this is a sine carrier like the dune sea's and it repeats only if the
        // column advances a WHOLE number of turns over the world. `SWAY_K` is 1.0000019 rather than 1 — the last
        // unwrapped site in the spike, and the only one `probe_periodic` still had a complaint about.
        const sway = Math.round(Math.sin(y / 5 + a * SWAY_K) * 1.2);
        if (dx === sway) put(base - y, S.foliage);
      }
      return;
    }
    default: void ci; return;
  }
}

// ==============================================================================================================
//  THE ENTRY POINT. Called once per column, after the ground exists.
// ==============================================================================================================
// ⭐⭐ HOW FAR FROM ITS OWN GROUND A PLANT CAN REACH — the envelope that lets `drawFlora` decline to think about
// a row window it cannot possibly write into. Measured against `drawForm`'s own expressions, generously:
//   UP     the worst form is a crown centred at `base - hgt - 0.35*cw` with a half-height of `0.85*cw` and
//          `cw = 0.46*hgt`, i.e. about 1.55x the height. 3x + 16 is roughly double that.
//   DOWN   only the ROOTS go below `base`, at most `round(hgt * 0.20 * 1.45)` = 0.29x the height. +8 to spare.
//   hgt    is `lp(h[0], h[1], …) * (0.7 + 0.5*dense)` with dense in 0..1, so it never exceeds `h[1] * 1.2`.
// ⚠️ CONSERVATIVE IS THE ONLY DIRECTION THAT IS SAFE. Skipping an anchor that would have written nothing is
// output-identical; skipping one that would have written is a plant with a slice missing — the exact class of
// defect the user caught three times when a plant's parameters varied with the column doing the looking.
// The margins here are ~2x what the expressions need, and `probe_cost`'s checksum is what proves it.
const extentOf = (S) => S._ext || (S._ext = (() => {
  const H = Math.ceil(S.h[1] * 1.2);
  return { up: 3 * H + 16, down: H + 8 };
})());

function drawFlora(W, C, columnInfo, ci, c, r0, rN, out, seed, M, waterE, hasBody, SPECIES) {
  const rEnd = r0 + rN;
  for (const S of SPECIES) {
    // ⭐ THE ROW-WINDOW EARLY-OUT. A plant is anchored at its own column's ground; if this chunk's rows are far
    // enough below that ground (or far enough above it) no cell of it can land here. Measured at 12% of the
    // whole base cell loop 300 rows underground, where nothing grows at all: without this, every underground
    // chunk walks all 15 species, resolves every anchor's climate and asks `fits` twice per anchor, to draw
    // nothing. The test is per ANCHOR rather than per call, because each anchor's base is its own column's
    // surface and those differ across a hillside.
    const ext = extentOf(S);
    // 🟥🟥 A PLANT MUST BE THE SAME PLANT FROM EVERY COLUMN IT TOUCHES, and three of its parameters were
    // functions of the column DOING THE LOOKING. Measured over 100,000 columns: the spacing changed 183 to
    // 1,449 times (so the anchor lattice shifted and a tree drawn in one column was absent from the next — a
    // missing vertical strip); the height of a FIXED tree changed up to 1,348 times (so its crown was a
    // different shape from each side — leaves left hanging in mid-air); and the niche gate flipped 4,000+
    // times, and where it flipped NO plant was drawn at all, slicing crowns off vertically.
    // ⭐ THE LATTICE IS NOW FIXED and density is a per-anchor KEEP PROBABILITY instead. Same look — a rainforest
    // dense, a savanna sparse — but the anchor set cannot move, because it no longer depends on anything that
    // varies along the ground.
    if (!fits(S, ci, c, seed, C.seaRow, waterE, hasBody, 1)) continue;
    // ⚠️ THE ANCHOR LATTICE HAS TO TILE THE PERIOD, like every other lattice in the world — otherwise a forest
    // is a different forest at the join. `nlat` gives a whole number of stands across the world at the cost of a
    // fractional spacing, so the loop counts LATTICE CELLS and rounds each anchor to a column: anchor k+n is
    // exactly anchor k one period along, which is the property that matters.
    const SL = nlat(Math.max(1, S.spacing[0])), sp = SL.s;
    const reach = Math.max(2, Math.round(S.h[1] * 0.75));
    // ⚠️ the start is the lattice cell BELOW `c - reach`, exactly as the old `Math.floor(...)*sp` was: the extra
    // anchor is harmless and dropping it would clip the left edge of every crown.
    for (let ki = Math.floor((c - reach) / sp); ; ki++) {
      const a = latAt(SL, ki);
      if (a > c + reach) break;
      const ca = a === c ? ci : columnInfo(W, C, a);
      if (!ca) continue;                                         // off the end of a floating island
      // ⚠️ BEFORE `fits`, not after — `fits` is the expensive half and it is a pure predicate, so reordering two
      // pure `continue` guards cannot change what is drawn. This is what makes the saving worth having.
      if (ca.surfRow + ext.down < r0 || ca.surfRow - ext.up >= rEnd) continue;
      // 🟥 `waterAt` MEANS "IS THIS SURFACE COLUMN UNDER THE SEA", and it decides that from `elev < 0`. On the
      // underworld floor, 1,500 rows below sea level, that is true of EVERY column — so every anchor except the
      // one directly under the cell being filled was refused as drowned, and a giant fungus came out as a
      // one-cell stalk with no cap at all: the only column that ever drew it was its own.
      // ⚠️ Third time this session that two rules disagreed about what an elevation MEANS (the sky islands lost
      // all their vegetation to it, then the deep lakes). Bands that carry their own water pass it in.
      const wa = (a === c || ca.sky || ca.deep) ? { e: waterE, has: hasBody } : waterAt(C, ca, a);
      if (!fits(S, ca, a, seed, C.seaRow, wa.e, wa.has, 0)) continue;
      const dense = cl((ca.moist - S.moist[0]) / Math.max(0.01, S.moist[1] - S.moist[0]), 0, 1);
      const want = lp(S.spacing[1], S.spacing[0], dense);        // the spacing this climate wants
      if (hc(seed, S.salt, a, 0) >= (sp / want) * 0.86) continue;
      // ⚠️ THE PLANT'S BASE IS ITS OWN COLUMN'S GROUND. On a hillside a canopy drawn from this column's surface
      // hangs in the air at one end of the crown and is buried at the other, which is what the old code did.
      const base = ca.surfRow;                                   // kelp roots on the seabed, which IS the surface
      const hgt = Math.round(lp(S.h[0], S.h[1], hc(seed, S.salt + 5, a, 1)) * (0.7 + 0.5 * dense));
      if (hgt < 1) continue;
      drawForm(S, M, out, r0, rN, a, base, hgt, c - a, seed, ca);
    }
  }
}

module.exports = { buildSpecies, drawFlora, fits, waterAt };
