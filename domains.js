// server/domains.js — WHERE A SITE LANDS IN THE OVERWORLD.
// SHARED-WORLD.md §7 Phase 6 increment 6 · design in scratchpad/worldgen_redesign_proposal.md ADDENDUM 6.
// The curated head of the internet is data, and lives in domain-seed.js.
//
// A domain is a SPAWN COORDINATE, not a fenced plot: no borders, no granted land, territory is emergent. So
// "placement" is a COLUMN and a DEPTH BAND — nothing else. The exact row is not a placement decision at all; it
// is wherever the ground happens to be inside that band, resolved from the generator at join time.
//
// ⭐ IT IS AN ALLOCATION, NOT A PURE FUNCTION. The design's load-bearing rule is *page identity is permanent,
// location is revocable* — world state is keyed by identity and never by coordinate. A pure `hash(name) -> column`
// could not avoid collisions, could not honour a per-site radius, and could never move anybody. So the hash picks
// a TARGET and this records where the site actually ended up.
// ⚠️ Consequence, stated rather than discovered later: the layout depends on the ORDER sites were first placed.
// The record IS the map. Lose it and every site moves.
//
// ⭐⭐ THE WORLD CAN NEVER BE FULL. That is a requirement, not a target (user, 2026-08-04). `place()` walks a
// LADDER and only the last rung can fail, and it cannot fail while a single site exists:
//     1. the site's preferred spot, at its full radius
//     2. shrink THIS site's radius toward a floor — an unknown new site does not need a big berth
//     3. try the other DEPTH BANDS — three bands is three times the room at the same width
//     4. spread anywhere in the world at the floor radius
//     5. RECLAIM the least-recently-seen site and take its place — nothing is lost, because a site's world is
//        stored against its NAME, so it comes back somewhere else the moment anybody visits it again
// Widening the world is a genuine sixth lever and is deliberately NOT in here: it is free of data migration but
// it is a restart-time shape change, so it belongs to whoever runs the server, not to a placement call.
'use strict';
const SEEDS = require('./domain-seed');

// FNV-1a. Not for security — for a stable, well-spread 32-bit number that is the same on every machine and in
// every process, which `Math.random` and V8's string hash are not.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// The identity a site is placed BY. Location is revocable, identity is not, so this has to be stable across
// protocol changes, `www.`, trailing slashes, ports and case — otherwise the same site is two domains.
function normalizeIdentity(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // protocol
  s = s.replace(/^www\./, '');
  s = s.replace(/[/?#].*$/, '');                  // host only — a path is a PAGE, and pages get island rooms
  s = s.replace(/:\d+$/, '');                     // port
  return s;
}

// Two-label public suffixes we would otherwise mistake for a registrable domain. Deliberately a short list
// rather than a dependency: getting one wrong plants a site slightly oddly, which is cosmetic, not broken.
const TWO_LABEL_SUFFIX = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
  'co.jp', 'co.nz', 'co.za', 'com.br', 'co.in', 'com.mx', 'co.kr']);

function parentIdentity(id) {
  const parts = id.split('.');
  if (parts.length < 3) return null;
  const rest = parts.slice(1);
  if (rest.length < 2) return null;
  if (rest.length === 2 && TWO_LABEL_SUFFIX.has(rest.join('.'))) return null;
  return rest.join('.');
}

// ⭐ SHARED PLATFORMS: a subdomain of one of these is REALLY A PAGE, so it resolves to the parent outright and
// never gets a place of its own. `someone.tumblr.com` -> `tumblr.com`. Applied repeatedly, because
// `a.b.github.io` should land on github.io too.
// ⚠️ Walks the WHOLE ancestor chain and returns the SHORTEST shared-platform ancestor, not the nearest. A first
// version stepped up one level at a time and gave up as soon as the immediate parent was not a platform, so
// `a.b.someone.github.io` resolved to itself — which is exactly the case the rule exists to catch.
function resolveHost(id) {
  const chain = []; let cur = id;
  while (cur) { chain.push(cur); cur = parentIdentity(cur); }
  for (let i = chain.length - 1; i >= 0; i--) if (SEEDS.SHARED_PLATFORMS.has(chain[i])) return chain[i];
  return id;
}

// cfg: { cols, rows, cell, spacingPx, minSpacingPx?, originCol?, marginCols?, bands?, subOffsetPx?, homePatchPx? }
function makeDomains(cfg) {
  const COLS = cfg.cols | 0, ROWS = cfg.rows | 0, CELL = cfg.cell | 0;
  const toCols = (px) => Math.max(1, Math.round(px / CELL));
  const SPACING = toCols(cfg.spacingPx);                                     // the default radius, in COLUMNS
  const MIN_SPACING = toCols(cfg.minSpacingPx == null ? cfg.spacingPx / 6 : cfg.minSpacingPx);   // rung 2's floor
  const ORIGIN = (cfg.originCol == null) ? (COLS >> 1) : (cfg.originCol | 0);
  const MARGIN = (cfg.marginCols == null) ? SPACING : (cfg.marginCols | 0);
  const LO = MARGIN, HI = COLS - 1 - MARGIN;
  // ⭐ DEPTH BANDS. The world is 4,096 rows deep and a page world is 405, so we have been using a sliver of it.
  // Three bands is three times the room at the same width, and it keeps sites within reach of each other instead
  // of stretching the world until walking between neighbours stops meaning anything.
  // ⚠️ THE TERRAIN DOES NOT SUPPORT THIS YET. Sky islands and deep chambers arrive with the generator redesign;
  // until then a site placed off the surface will find no ground in its band and the spawn falls back. Placement
  // is built first ON PURPOSE, so the generator has a shape to aim at rather than the other way round.
  const BANDS = cfg.bands || [
    { name: 'surface', r0: Math.round(ROWS * 0.34), r1: Math.round(ROWS * 0.66) },
    { name: 'sky', r0: Math.round(ROWS * 0.04), r1: Math.round(ROWS * 0.33) },
    { name: 'underground', r0: Math.round(ROWS * 0.67), r1: Math.round(ROWS * 0.97) },
  ];
  // Subdomains sit INSIDE their parent's neighbourhood, not a full radius away — `blog.example.com` is a building
  // in example.com's town, not the next town over. A patch in the middle is kept clear for the home page itself.
  const SUB_OFFSET = toCols(cfg.subOffsetPx == null ? 2560 : cfg.subOffsetPx);
  const HOME_PATCH = toCols(cfg.homePatchPx == null ? 640 : cfg.homePatchPx);

  const byId = new Map();                                   // identity -> record
  const lanes = new Map();                                  // band name -> records SORTED BY COLUMN
  for (const b of BANDS) lanes.set(b.name, []);
  let clock = 0;                                            // monotonic "last seen" counter for reclaim

  // ── CATEGORY STRETCHES: each category owns a contiguous run of the world, in the order domain-seed declares,
  // so neighbours in that list are neighbours in the world.
  // ⚠️ THE STRETCHES ARE SIZED BY DEMAND, NOT EVENLY. A first version gave every category the same width, and
  // social and shopping — which are full of weight-3 sites needing three times the radius — overflowed and walked
  // clean out of their own stretch into someone else's, putting shopping between reference and news. A category's
  // width is now the room its members actually need, which also means the layout stays sane as the list grows.
  const CATS = SEEDS.CATEGORIES;
  const seedOf = (id) => SEEDS.SEED[id] || null;
  const catSpan = new Map(), catAnchor = new Map();
  {
    const demand = new Map(CATS.map(c => [c, SPACING * 2]));   // a floor, so an empty category still exists
    for (const [name, [cat, w]] of Object.entries(SEEDS.SEED))
      if (demand.has(cat)) demand.set(cat, demand.get(cat) + SPACING * w * 2.2);   // ×2.2 = radius plus breathing room
    // ⚠️ Demand can exceed the world. A first version let the stretches sum past the available width and every
    // category beyond the middle was clamped against the world's end — which squashed several of them together
    // and put the last two on top of each other. Scale the whole layout down to fit instead.
    const total = [...demand.values()].reduce((a, b) => a + b, 0);
    const scale = Math.min(1, (HI - LO) / Math.max(1, total));
    let at = ORIGIN - Math.round(total * scale / 2);
    for (const c of CATS) {
      const w = Math.max(SPACING, Math.round(demand.get(c) * scale));
      catSpan.set(c, w); catAnchor.set(c, at + (w >> 1)); at += w;
    }
  }

  function lowerBound(arr, col) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].col < col) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // Only the two adjacent records in the same band can be too close, because each lane is sorted — so this is
  // O(log n) at any population. Different bands never constrain each other: they are thousands of pixels apart
  // vertically, which is the whole point of having them.
  // ⚠️ A pair honours the LARGER of the two radii, so a busy site pushes quiet neighbours away without every
  // quiet site having to know about it.
  // ⭐ A FAMILY HAS TWO SPACINGS: one for the outside world and a much smaller one inside itself. Without that,
  // `blog.example.com` had to clear the FULL radius from `example.com` and got shoved 30,700px away — the exact
  // "next town over" the design is trying to avoid. Members of one family (a host and its subdomains) only need
  // to clear the home patch from each other.
  // `tight` is rung 2 and beyond: under pressure a site clears only ITS OWN radius, not the larger of the pair.
  // Without it, shrinking your own berth buys nothing whenever a heavyweight is nearby — measured, rung 2 never
  // fired once and the ladder fell straight through to reclaiming sites it did not need to.
  function fits(band, col, sep, family, tight) {
    const arr = lanes.get(band); if (!arr) return false;
    const i = lowerBound(arr, col);
    for (const j of [i - 1, i]) {
      const p = arr[j];
      if (!p) continue;
      const need = (family && p.family === family) ? HOME_PATCH : (tight ? sep : Math.max(sep, p.sep));
      if (Math.abs(p.col - col) < need) return false;
    }
    return true;
  }

  const clamp = (c) => Math.max(LO, Math.min(HI, c));
  // Walk outward from a target in quarter-radius steps, alternating sides. Quarter steps rather than whole ones
  // so a site can nestle into a gap; a lattice would be invisible in play but is wrong the moment radii differ.
  function walk(band, target, sep, family, tight) {
    const t = clamp(target);
    if (fits(band, t, sep, family, tight)) return t;
    const step = Math.max(1, sep >> 2);
    for (let k = 1; k <= 65536; k++) {
      const a = clamp(t + k * step); if (a !== t && fits(band, a, sep, family, tight)) return a;
      const b = clamp(t - k * step); if (b !== t && fits(band, b, sep, family, tight)) return b;
      if (a === HI && b === LO) break;
    }
    return -1;
  }

  // Where the hash WANTS this identity, before anybody else is taken into account.
  function targetOf(id, anchorCol, seed) {
    if (anchorCol != null) {
      // Beside its parent, INSIDE the neighbourhood: past the home-page patch, then a deterministic side and
      // rank so the second and third subdomain do not aim at the same spot.
      const h = hash32(id);
      const side = (h & 1) ? 1 : -1;
      const rank = 1 + ((h >>> 1) % 3);
      return anchorCol + side * (HOME_PATCH + rank * SUB_OFFSET);
    }
    const h = hash32(id);
    if (seed) {
      // A curated site aims into its CATEGORY's stretch, so social lands beside social and shops beside shops.
      const a = catAnchor.get(seed[0]);
      if (a != null) {
        const half = Math.max(SPACING, (catSpan.get(seed[0]) || SPACING * 4) >> 1);
        return a + Math.round((h / 4294967296) * 2 * half) - half;
      }
    }
    // ⭐ Everything else aims into a band around the origin that GROWS WITH THE POPULATION, so density stays
    // roughly constant instead of the first ten sites being scattered with nobody within a day's walk.
    const n = byId.size;
    const half = Math.max(SPACING * 4, Math.round(n * SPACING * 0.75));
    return ORIGIN + Math.round((h / 4294967296) * 2 * half) - half;
  }

  // ⭐⭐ PERSISTENCE HOOKS, AND THE REGISTRY STILL KNOWS NOTHING ABOUT STORAGE. This module is pure — it has its
  // own guard and is exercised by building whole layouts in memory — so it announces the only two events that
  // change a layout and lets the host decide what to do with them. `adopt` below is the read half.
  // ⚠️ `onRelease` MATTERS AS MUCH AS `onPlace`, and it is the half that is easy to forget: rung 5 RECLAIMS a
  // dormant site's column for a new one. If only the placement were written, the victim's stale row would be
  // adopted on the next start alongside the site that took its place, and both would stand in the same column.
  const onPlace = cfg.onPlace || null, onRelease = cfg.onRelease || null;
  function insert(rec, quiet) {
    const arr = lanes.get(rec.band);
    arr.splice(lowerBound(arr, rec.col), 0, rec);
    byId.set(rec.id, rec);
    if (!quiet && onPlace) onPlace(rec);       // `quiet` = this record CAME from storage; writing it back is a no-op at best
    return rec;
  }
  function remove(rec) {
    const arr = lanes.get(rec.band); const i = arr.indexOf(rec);
    if (i >= 0) arr.splice(i, 1);
    byId.delete(rec.id);
    if (onRelease) onRelease(rec);
  }

  const api = {
    normalizeIdentity, parentIdentity, hash32, resolveHost,
    BANDS, CATEGORIES: CATS,
    cfg: { COLS, ROWS, CELL, SPACING, MIN_SPACING, ORIGIN, LO, HI, SUB_OFFSET, HOME_PATCH },
    catAnchor,

    // The identity a raw URL is placed by, AFTER shared-platform collapsing. Exposed because the caller usually
    // wants to know that `me.tumblr.com` is really `tumblr.com` before it does anything else.
    identityFor(raw) { return resolveHost(normalizeIdentity(raw)); },

    // ⭐⭐ PUT BACK A LAYOUT THAT WAS DECIDED BEFORE. This is the other half of "identity is permanent, location
    // is revocable": a location that is revocable by the DESIGN must not also be revoked by a power cut.
    // The records go in verbatim — no walk, no `fits` test, no re-hash. A stored column was legal when it was
    // written, and the world built at it is keyed by that column; re-deciding it would move the site and orphan
    // everything at the old one, which is exactly the failure this exists to stop.
    // ⚠️ VALIDATED, NOT TRUSTED, and dropped rather than clamped. A column is only meaningful against the world
    // width and band table it was decided under; if those have changed, standing somebody at a clamped
    // approximation of where they used to live is worse than placing them afresh, because it looks like it
    // worked. A dropped row simply means the next `place` decides again.
    adopt(rows) {
      let adopted = 0, dropped = 0;
      for (const r of (rows || [])) {
        const id = r && r.id;
        if (!id || byId.has(id)) { dropped++; continue; }
        const col = r.col | 0;
        if (!(col >= 0 && col < COLS) || !lanes.has(r.band)) { dropped++; continue; }
        const seed = seedOf(id);
        insert({
          id, col, band: r.band,
          sep: (r.sep | 0) > 0 ? (r.sep | 0) : SPACING,
          weight: (+r.weight > 0) ? +r.weight : (seed ? seed[1] : 1),
          rung: r.rung | 0,
          family: r.family || parentIdentity(id) || id,
          cat: r.cat || (seed ? seed[0] : null),
          seen: ++clock,
        }, true);
        adopted++;
      }
      return { adopted, dropped };
    },

    peek(raw) { return byId.get(this.identityFor(raw)) || null; },
    count() { return byId.size; },
    all() { const out = []; for (const b of BANDS) out.push(...lanes.get(b.name)); return out; },
    lane(name) { return (lanes.get(name) || []).slice(); },

    // Mark a site as still in use, so reclaim takes the genuinely dormant one.
    touch(raw) { const r = this.peek(raw); if (r) r.seen = ++clock; return !!r; },

    // ⭐⭐ THE ENTRY POINT, AND IT CANNOT RETURN NULL WHILE ANY SITE EXISTS. Idempotent: a placed site keeps its
    // spot forever, which is the whole reason world state is keyed by identity.
    place(raw, opts) {
      const id = this.identityFor(raw);
      if (!id) return null;
      const existing = byId.get(id);
      if (existing) { existing.seen = ++clock; return existing; }

      const seed = seedOf(id);
      const weight = (opts && opts.weight) || (seed ? seed[1] : 1);
      const full = Math.max(1, Math.round(((opts && opts.sepPx) ? toCols(opts.sepPx) : SPACING) * weight));
      const parent = parentIdentity(id);
      const anchor = parent ? byId.get(parent) : null;
      const home = anchor ? anchor.band : null;

      // rung 1 — the preferred spot, at the full radius, in the preferred band
      const band0 = home || (opts && opts.band) || BANDS[0].name;
      const family = parent || id;   // a host and its subdomains are ONE family — see fits()
      let col = walk(band0, targetOf(id, anchor ? anchor.col : null, seed), full, family);
      let sep = full, band = band0, rung = 1;

      // rung 2 — shrink this site's radius toward the floor
      if (col < 0) {
        for (let s = full >> 1; s >= MIN_SPACING; s >>= 1) {
          col = walk(band0, targetOf(id, anchor ? anchor.col : null, seed), s, family, true);
          if (col >= 0) { sep = s; rung = 2; break; }
        }
      }
      // rung 3 — the other depth bands
      if (col < 0) {
        for (const b of BANDS) {
          if (b.name === band0) continue;
          col = walk(b.name, targetOf(id, null, seed), Math.max(MIN_SPACING, full >> 1), family, true);
          if (col >= 0) { band = b.name; sep = Math.max(MIN_SPACING, full >> 1); rung = 3; break; }
        }
      }
      // rung 4 — anywhere at all, at the floor radius, in any band
      if (col < 0) {
        for (const b of BANDS) {
          col = walk(b.name, ORIGIN, MIN_SPACING, family, true);
          if (col >= 0) { band = b.name; sep = MIN_SPACING; rung = 4; break; }
        }
      }
      // rung 5 — ⭐ RECLAIM. Take the place of whichever site has gone longest without being seen. Its world is
      // keyed by name, not by coordinate, so nothing is lost: it returns somewhere else when somebody visits it.
      if (col < 0) {
        let victim = null;
        for (const r of byId.values()) if (!victim || r.seen < victim.seen) victim = r;
        if (victim) {
          band = victim.band; col = victim.col; sep = Math.min(full, victim.sep); rung = 5;
          victim.evicted = true;
          remove(victim);
        }
      }
      if (col < 0) return null;   // reachable only in a world with no sites and no room, which cannot happen

      return insert({ id, col, band, sep, weight, rung, family, cat: seed ? seed[0] : null, seen: ++clock });
    },

    // Location is REVOCABLE: free the slot and keep nothing. The site's world survives, keyed by identity.
    release(raw) {
      const rec = byId.get(this.identityFor(raw));
      if (!rec) return false;
      remove(rec); return true;
    },

    // World px of a placed site's spawn COLUMN, and the ROW RANGE its band allows. The exact row is decided by
    // the ground, not here.
    spawnXOf(raw) { const r = this.peek(raw); return r ? (r.col + 0.5) * CELL : null; },
    bandRowsOf(raw) {
      const r = this.peek(raw); if (!r) return null;
      return this.bandRows(r.band);
    },
    // The same answer for a band NAME, for callers that already hold a placed record and would otherwise have to
    // peek it back up by identity to get here. ⚠️ It exists so there is ONE definition of where the bands are:
    // the spawn seam briefly had its own copy of these fractions, which is two things that can drift apart.
    bandRows(name) {
      const b = BANDS.find(x => x.name === name) || BANDS[0];
      return { r0: b.r0, r1: b.r1 };
    },
  };
  return api;
}

module.exports = { makeDomains, hash32, normalizeIdentity, parentIdentity, SEEDS };
