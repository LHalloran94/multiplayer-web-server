// server/domains.js — WHERE A SITE LANDS IN THE OVERWORLD.
// SHARED-WORLD.md §7 Phase 6 increment 6 · design in scratchpad/worldgen_redesign_proposal.md ADDENDUM 6.
//
// A domain is a SPAWN COORDINATE, not a fenced plot: there are no borders, no granted land, and territory is
// emergent. So "placement" is one number per site — the COLUMN it spawns at. The row is not a placement decision
// at all; it is wherever the ground happens to be at that column, resolved from the generator at join time.
// That makes this whole file one-dimensional, which is the main reason it is small.
//
// ⭐ IT IS AN ALLOCATION, NOT A PURE FUNCTION, AND THAT IS DELIBERATE.
// The design's load-bearing rule is *page identity is permanent, location is revocable* — world state is keyed by
// identity and never by coordinate, so a slot can be reclaimed and the page revived somewhere else. A pure
// `hash(name) -> column` would be tidier and would make that impossible: it could not avoid collisions, could not
// respect a per-site separation, and could never move anybody. So the hash picks a TARGET and this records where
// the site actually ended up.
// ⚠️ Consequence, stated rather than discovered later: the layout depends on the ORDER sites were first placed.
// Same set, same order, same layout — but a different order resolves collisions differently. That is fine because
// the answer is recorded, and it is exactly why it must be.
//
// ⚠️ SEPARATION AND STARTING RADIUS ARE PER-SITE AND DEFERRED (user, 2026-08-04: "we can probably sort this stuff
// out later" — a large popular site should get a bigger berth than a small one). The mechanism below already takes
// a per-site separation and honours the LARGER of the two whenever it compares a pair, so setting real numbers
// later is a policy change, not a redesign. Everything ships on one default until then.
'use strict';

// FNV-1a. Not for security — for a stable, well-spread 32-bit number that is the same on every machine and in
// every process, which `Math.random` and V8's string hash are not.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// The identity a site is placed BY. Location is revocable, identity is not, so this has to be stable across
// protocol changes, `www.`, trailing slashes and case — otherwise the same site is two domains.
function normalizeIdentity(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // protocol
  s = s.replace(/^www\./, '');
  s = s.replace(/[/?#].*$/, '');                  // host only — a path is a page, not a site
  s = s.replace(/:\d+$/, '');                     // port
  return s;
}

// ⭐ RELATED SUBDOMAINS PLANT NEAR THEIR PARENT (ADDENDUM 6). `blog.example.com` -> `example.com`; a bare
// `example.com` has no parent. Deliberately naive about public suffixes: getting `co.uk` wrong plants a site a
// little further from its neighbours than intended, which is a cosmetic miss, not a broken world — and a real
// suffix list is a dependency this does not need yet.
function parentIdentity(id) {
  const parts = id.split('.');
  if (parts.length < 3) return null;
  const rest = parts.slice(1);
  if (rest.length < 2) return null;
  // Two-label public suffixes we would otherwise mistake for a registrable domain.
  const TWO = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.nz', 'co.za', 'com.br']);
  if (rest.length === 2 && TWO.has(rest.join('.'))) return null;
  return rest.join('.');
}

// cfg: { cols, rows, cell, spacingPx, originCol?, marginCols?, minHalfSpanPx?, densityPx? }
function makeDomains(cfg) {
  const COLS = cfg.cols | 0, CELL = cfg.cell | 0;
  const SPACING = Math.max(1, Math.round((cfg.spacingPx | 0) / CELL));          // default separation, in COLUMNS
  // The world grows at BOTH edges, so the origin is its middle rather than column 0.
  const ORIGIN = (cfg.originCol == null) ? (COLS >> 1) : (cfg.originCol | 0);
  const MARGIN = (cfg.marginCols == null) ? SPACING : (cfg.marginCols | 0);     // keep clear of the world's ends
  const LO = MARGIN, HI = COLS - 1 - MARGIN;
  // ⭐ THE BAND THE HASH AIMS INTO GROWS WITH THE POPULATION, so occupancy density stays roughly constant instead
  // of the first ten sites being scattered across the whole declared width with nobody within a day's walk. This
  // is §3's "popularity = density, not footprint" applied to the world as a whole rather than to one site.
  const MIN_HALF = Math.max(SPACING, Math.round((cfg.minHalfSpanPx == null ? cfg.spacingPx * 4 : cfg.minHalfSpanPx) / CELL));
  const DENSITY = (cfg.densityPx == null) ? 0.75 : (cfg.densityPx);             // band half-span per placed site, in SPACINGs

  const byId = new Map();      // identity -> { id, col, sep }
  const placed = [];           // the same records, kept SORTED BY COLUMN so a separation test is a binary search

  function lowerBound(col) {   // first index with placed[i].col >= col
    let lo = 0, hi = placed.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (placed[mid].col < col) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // Is `col` far enough from every neighbour? Only the two adjacent records can be too close, because the array
  // is sorted — so this is O(log n), not O(n), and stays that way at any population.
  // ⚠️ The pair test uses the LARGER of the two separations, which is what makes a per-site radius work later:
  // a big site pushes small neighbours away without every small site having to know about it.
  function fits(col, sep) {
    const i = lowerBound(col);
    for (const j of [i - 1, i]) {
      const p = placed[j];
      if (!p) continue;
      if (Math.abs(p.col - col) < Math.max(sep, p.sep)) return false;
    }
    return true;
  }

  // Where the hash WANTS this identity, before anybody else is taken into account.
  function targetOf(id, anchorCol) {
    if (anchorCol != null) {
      // ⭐ Planted beside its parent: ONE separation away, on a side the hash picks. Deliberately the CLOSEST
      // legal spot rather than a spread of ranks — the walk pushes the second and third subdomain outward by
      // itself, and it does so minimally, which is the whole point. An earlier version aimed 1-3 separations out
      // and measured NO TIGHTER than not having a parent at all: the guard caught it, and it is why A5 compares
      // against the parentless spread instead of just asserting "near".
      return anchorCol + ((hash32(id) & 1) ? SPACING : -SPACING);
    }
    const half = Math.max(MIN_HALF, Math.round(placed.length * SPACING * DENSITY));
    const h = hash32(id);
    // h/2^32 in [0,1) -> [-half, +half]
    return ORIGIN + Math.round((h / 4294967296) * 2 * half) - half;
  }

  // The walk. Outward from the target in alternating directions, in quarter-separation steps so a site can nestle
  // into a gap rather than only ever landing on a lattice — the lattice would be invisible in play, but a
  // per-site separation makes it wrong as soon as the radii differ.
  const STEP = Math.max(1, SPACING >> 2);
  function findSlot(target, sep) {
    const clamp = (c) => Math.max(LO, Math.min(HI, c));
    const t = clamp(target);
    if (fits(t, sep)) return t;
    // Bounded so a pathological configuration cannot spin: at 4 steps per separation, this reaches
    // 4,096 separations either way, which is far past any width this world will have.
    for (let k = 1; k <= 16384; k++) {
      const a = clamp(t + k * STEP); if (a !== t && fits(a, sep)) return a;
      const b = clamp(t - k * STEP); if (b !== t && fits(b, sep)) return b;
      if (a === HI && b === LO) break;               // both ends reached and nothing fitted
    }
    return -1;                                        // the world is full at this separation — caller decides
  }

  return {
    normalizeIdentity, parentIdentity, hash32,
    cfg: { COLS, CELL, SPACING, ORIGIN, LO, HI, STEP, MIN_HALF, DENSITY },

    // Already placed? (No side effects — this is the read the join path wants when it must not allocate.)
    peek(raw) { return byId.get(normalizeIdentity(raw)) || null; },
    count() { return placed.length; },
    all() { return placed.slice(); },

    // ⭐ THE ENTRY POINT. Idempotent: a site that has been placed keeps its column forever, which is the whole
    // reason world state is keyed by identity. Returns null only if the world is genuinely full.
    place(raw, sepPx) {
      const id = normalizeIdentity(raw);
      if (!id) return null;
      const existing = byId.get(id);
      if (existing) return existing;
      const sep = Math.max(1, Math.round((sepPx == null ? cfg.spacingPx : sepPx) / CELL));
      // Aim beside the parent site if it is already here; otherwise let the hash choose.
      const parent = parentIdentity(id);
      const anchor = parent ? byId.get(parent) : null;
      const col = findSlot(targetOf(id, anchor ? anchor.col : null), sep);
      if (col < 0) return null;
      const rec = { id, col, sep };
      byId.set(id, rec);
      placed.splice(lowerBound(col), 0, rec);
      return rec;
    },

    // Location is REVOCABLE: free the slot, keep nothing. The site's world state is keyed by identity, so it
    // survives this and comes back somewhere else on the next `place`.
    release(raw) {
      const id = normalizeIdentity(raw);
      const rec = byId.get(id);
      if (!rec) return false;
      byId.delete(id);
      const i = placed.indexOf(rec);
      if (i >= 0) placed.splice(i, 1);
      return true;
    },

    // World px of a placed site's spawn COLUMN. The row is not decided here — see the note at the top.
    spawnXOf(raw) { const r = this.peek(raw); return r ? (r.col + 0.5) * CELL : null; },
  };
}

module.exports = { makeDomains, hash32, normalizeIdentity, parentIdentity };
