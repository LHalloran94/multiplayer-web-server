// ==============================================================================================================
//  wood.js — THE AXE'S LINE RULE (2026-10-31, the notch round 3 — scratchpad/kickoff_notch_3.md). Which strokes make a LINE across a tree, whether
//  it is drawn right across, where a finishing blow lands, how many it needs, and which cells it cuts.
//
//  This exact file runs in TWO places, as `held.js` does:
//    • server/index.js requires it            (the server decides a blow and the fall: `wood-blow`)
//    • the extension bundle inlines it        (build.js / dev/serve.js prepend it → `self.MWWood`; 16z's chop shows the blow at once, 16d draws
//                                              joined strokes as one line)
//  ⚠️ ONE RULE, TWO READERS — so the line you see is the line the server fells by.
//
//  A stroke: { id, x, y (world px, its middle), k (0 level, 1 upright, 2 a level one left on a stump after the fall), t (tilt, radians), b (blows) }.
//  The user's rule (their answers, 2026-10-30/31): LEVEL strokes join whatever their tilt when each is within `jy` of the next in height and they
//  touch along the trunk; a line is DRAWN ACROSS when it reaches from open air to open air at that height (at a fork it must cross the branch too —
//  it is wood at that height); a right click landing on a drawn line is a FINISHING BLOW (the whole line thickens); the tree falls after
//  max(2, ceil(its width in cells × k)) of them.
// ==============================================================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root || (typeof self !== 'undefined' ? self : globalThis)).MWWood = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  const CELL = 8;           // world px a cell
  const LEN = 8;            // a stroke's length, world px (a cell)
  const JOIN_GAP = 1.5;     // px of gap between two strokes' ends that still joins them
  const EDGE_GAP = 3;       // px from a line's end to open air that still counts as reaching it (a chop centred a little in from the edge)

  // two LEVEL strokes join: heights within `jy` (world px), touching along (middles no further apart than a stroke's length + the gap)
  function joins(a, b, jy) { return a.k === 0 && b.k === 0 && Math.abs(a.y - b.y) <= jy && Math.abs(a.x - b.x) <= LEN + JOIN_GAP; }
  // a level stroke's end (side −1 left, +1 right)
  function endOf(s, side) { const h = LEN / 2; return [s.x + side * h * Math.cos(s.t), s.y + side * h * Math.sin(s.t)]; }
  // THE LINE through stroke `s0`: every level stroke joined to it (`all` = the strokes near it) → { strokes, x0, x1 (its ends), y, across, cells }
  //   `wood(x, y)` = whether world px (x, y) is a standing tree's wood
  function lineOf(s0, all, jy, wood) {
    const L = [s0], seen = new Set([s0.id]);
    for (let i = 0; i < L.length; i++) for (const q of all) if (!seen.has(q.id) && joins(L[i], q, jy)) { seen.add(q.id); L.push(q); }
    let lo = L[0], hi = L[0], y = 0; for (const q of L) { if (q.x < lo.x) lo = q; if (q.x > hi.x) hi = q; y += q.y; }
    const a = endOf(lo, -1), b = endOf(hi, 1);
    const open = (p, dir) => { for (let d = 0; d <= EDGE_GAP; d += 0.5) if (!wood(p[0] + dir * d, p[1])) return true; return false; };
    return { strokes: L, x0: a[0], x1: b[0], y: y / L.length, across: open(a, -1) && open(b, 1), cells: Math.max(1, Math.round((b[0] - a[0]) / CELL)) };
  }
  // the DRAWN line a blow at (x, y) lands on: one of its strokes within `jy` in height and under x — or null (then the chop is a new stroke)
  function lineAt(x, y, all, jy, wood) {
    for (const s of all) { if (s.k !== 0 || Math.abs(s.y - y) > jy || Math.abs(s.x - x) > LEN / 2 + 1) continue;
      const Ln = lineOf(s, all, jy, wood); if (Ln.across) return Ln; }
    return null;
  }
  // how many finishing blows a line takes (`k` the setting)
  function need(Ln, k) { return Math.max(2, Math.ceil(Ln.cells * Math.max(0.1, +k || 1))); }
  // its blows so far (every stroke of it takes each one)
  function blows(Ln) { let b = 1e9; for (const s of Ln.strokes) b = Math.min(b, s.b | 0); return b === 1e9 ? 0 : b; }
  // the line's height at x (the stroke nearest x, along its tilt)
  function yAt(Ln, x) { let best = Ln.strokes[0], bd = 1e9; for (const s of Ln.strokes) { const d = Math.abs(s.x - x); if (d < bd) { bd = d; best = s; } } return best.y + (x - best.x) * Math.tan(best.t); }
  // THE CELLS IT CUTS → [[c, r], …]: in each column it crosses, the cells at its height there — and where its height steps to another row, the cells
  //   between too, so a walk through a tree's wood (8 neighbours) cannot slip round it diagonally (round 2's staggered cut never freed the top)
  function cutCells(Ln) {
    const out = new Map(), add = (c, r) => out.set(c + ',' + r, [c, r]); let pc = null, pr = null;
    for (let x = Ln.x0; x <= Ln.x1 + 1e-6; x += 0.5) { const c = Math.floor(x / CELL), r = Math.floor(yAt(Ln, x) / CELL); add(c, r);
      if (pr != null && r !== pr) { for (let q = Math.min(r, pr); q <= Math.max(r, pr); q++) { add(c, q); if (pc !== c) add(pc, q); } }
      pc = c; pr = r; }
    return Array.from(out.values());
  }
  return { CELL, LEN, JOIN_GAP, EDGE_GAP, joins, lineOf, lineAt, need, blows, yAt, cutCells };
});
