// ==============================================================================================================
//  slope.js — THE SLOPE RULE (2026-11-08, liquid on slopes). Where the ground steps down too steeply to stand on, and the WEDGE that joins the
//  corners of those steps: which open cells it covers, its slanted line, what a point inside it meets.
//
//  This exact file runs in TWO places, as `wood.js` does:
//    • server/index.js requires it            (the liquid treats wedge cells as solid and runs down the slant)
//    • the extension bundle inlines it        (build.js / dev/serve.js prepend it → `self.MWSlope`; 16d draws the wedges and answers arrows/tools,
//                                              16ze slides you and sets your feet on the slant)
//  ⚠️ ONE RULE, TWO READERS — so the slope the water runs down is the slope you see and stand on.
//
//  Every function takes `B(c, r)`: does cell (c, r) hold you up. Each side supplies it from the same per-material KIND (`kindOfDef`) and the same
//  soft-top rule (`block`) — the client's collision test without the per-player parts (powder you are buried in). An unknown cell is ground (both
//  sides fail safe that way). `T` is the cell size in px.
//
//  The rule (the user's, feet rounds 14–16): TOO STEEP IS LOCAL — from a CORNER (a cell that holds you, open over it), the next column a STEP down
//  (lower, at most two cells), the one after no higher than that and more than two cells below the corner in all, at most five (deeper is a cliff).
//  The wedge fills the open cells in front of the riser in each of those two columns, under the line from the riser's top corner to the foot.
//  A wedge cell's CODE (one byte): 128 | 64 the riser on its right | its height in cells in that column (1–5) << 3 | which of them this is (0 the top).
// ==============================================================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root || (typeof self !== 'undefined' ? self : globalThis)).MWSlope = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // A material's KIND for the slope rule: 0 does not hold you (air, liquid, plants, hazards, object cells) · 1 ground · 2 soft ground (you settle a
  //   cell into its top: snow, mud, powders). `m` is a material row ({ behavior, sink, falls }) — the client's TERRAIN_MATS entry or materials.js DEFS.
  function kindOfDef(m) {
    if (!m) return 0;
    const solid = m.behavior === 'solid', powder = m.behavior === 'powder' || !!m.falls;
    if (!solid && !powder) return 0;
    return ((solid && !!m.sink) || m.behavior === 'powder') ? 2 : 1;
  }
  // ⚠️ The level creator's built-ins 1..17 are written out only in the client (16a TERRAIN_MATS); the server has no table of their flags. Their kinds,
  //   here once — the client checks its own table against this at start-up (16d `slopeKindCheck`) and says so in the console if they ever differ.
  //   1 Earth · 2 Stone · 3 Sand · 4 Ice · 5 Mud (sinks) · 6 Bouncy · 7 Belt → · 8 Snow (sinks) · 9 Water · 10 Quicksand · 11 Lava · 12 Acid · 13 Belt ←
  //   14 Brine · 15 Oil · 16 Glass · 17 Drain
  const BUILTIN_KIND = [0, 1, 1, 1, 1, 2, 1, 1, 2, 0, 0, 0, 0, 1, 0, 0, 1, 1];

  // does (c, r) hold you up, from `kind(c, r)` (0/1/2 as above; an unknown cell 1). A soft cell holds you unless it is the top of at least two:
  //   buried under more soft ground it blocks (the inside of a drift), and with nothing soft under it it is too thin to sink into.
  function block(kind, c, r) {
    const k = kind(c, r); if (k !== 2) return k === 1;
    return kind(c, r - 1) === 2 || kind(c, r + 1) !== 2;
  }

  // the top of column `c` near `y` (px): from the cell at `y` up to 7 cells while it holds you, else down to 7 cells for the first that does;
  //   8 cells up or down when none in reach
  function topNear(B, c, y, T) {
    const r0 = Math.floor((y - 0.5) / T);
    if (B(c, r0)) { for (let r = r0 - 1; r >= r0 - 7; r--) if (!B(c, r)) return (r + 1) * T; return y - 8 * T; }
    for (let r = r0 + 1; r <= r0 + 7; r++) if (B(c, r)) return r * T; return y + 8 * T;
  }
  // standing on the corner of column `cS`, the open side `o` (±1): the two columns past it go DOWN like a slope — the first a STEP (lower, at most two
  //   cells), the second no higher than the first, more than two cells below the corner and not more than five
  function steepDown(B, cS, o, y, T) {
    const yS = topNear(B, cS, y, T), t1 = topNear(B, cS + o, y, T), t2 = topNear(B, cS + 2 * o, y, T);
    return t1 >= yS + 0.5 && t1 - yS <= 2 * T + 0.5 && t2 >= t1 - 0.5 && t2 - yS > 2 * T + 2 && t2 - yS <= 5 * T + 0.5;
  }
  // walking up the riser in column `col`, `dir` the way you go, from ground at `y` to a step's top `stepTop`: too steep — the two columns rise more
  //   than two cells, or stood on its top the ground behind steps down too steeply (you would slide straight back off)
  function steepUp(B, col, dir, y, stepTop, T) {
    const y0 = Math.min(y, topNear(B, col - dir, y, T)); if (y0 - stepTop <= 0.5) return false;
    return y0 - Math.min(stepTop, topNear(B, col + dir, y, T)) > 2 * T + 2 || (topNear(B, col + dir, stepTop, T) <= stepTop + 0.5 && steepDown(B, col, -dir, stepTop, T));
  }

  // OPEN cell (c, r)'s wedge code (0: none), from the corners that could reach it (one column away and up to a row up; two columns away and up to five
  //   rows up). `wet(c, r0, r1)` (optional): true leaves the wedge out (round 20's rule while liquid could still sit there).
  function code(B, c, r, T, wet) {
    const corner = (cc, rr) => B(cc, rr) && !B(cc, rr - 1), whole = (cc, r0, r1) => { for (let rr = r0; rr < r1; rr++) if (!B(cc, rr)) return false; return true; };
    for (let o = -1; o <= 1; o += 2) { const sd = o < 0 ? 64 : 0;
      for (let rS = r; rS >= r - 1; rS--) { const cS = c - o; if (!corner(cS, rS) || !steepDown(B, cS, o, rS * T, T)) continue; const r1 = Math.round(topNear(B, c, rS * T, T) / T);
        if (r < r1 && whole(cS, rS, r1) && !(wet && wet(c, rS, r1))) return 128 | sd | ((r1 - rS) << 3) | (r - rS); }
      for (let rS = r; rS >= r - 5; rS--) { const cS = c - 2 * o; if (!corner(cS, rS) || !steepDown(B, cS, o, rS * T, T)) continue; const r1 = Math.round(topNear(B, cS + o, rS * T, T) / T), r2 = Math.round(topNear(B, c, rS * T, T) / T);
        if (r >= r1 && r < r2 && whole(cS + o, r1, r2) && !(wet && wet(c, r1, r2))) return 128 | sd | ((r2 - r1) << 3) | (r - r1); } }
    return 0;
  }
  // EVERY wedge cell from the corners in rows ra−5..rb, columns c0..c1: `put(c, r, code)` for each (it may be called for cells outside the rows; a cell
  //   two corners reach is put twice — keep the first). The cheap necessary conditions first (the next column open at the corner with ground within two
  //   cells, the one after open three down), `steepDown` only for what passes.
  function scan(B, c0, c1, ra, rb, T, put, wet) {
    const whole = (cc, r0, r1) => { for (let rr = r0; rr < r1; rr++) if (!B(cc, rr)) return false; return true; };
    for (let r = ra - 5; r <= rb; r++) for (let c = c0; c <= c1; c++) { if (B(c, r - 1) || !B(c, r)) continue; const yS = r * T;
      for (let o = -1; o <= 1; o += 2) {
        if (B(c + o, r) || !(B(c + o, r + 1) || B(c + o, r + 2)) || B(c + 2 * o, r) || B(c + 2 * o, r + 1) || B(c + 2 * o, r + 2) || !steepDown(B, c, o, yS, T)) continue;
        const r1 = Math.round(topNear(B, c + o, yS, T) / T), r2 = Math.round(topNear(B, c + 2 * o, yS, T) / T), sd = o < 0 ? 64 : 0;
        if (whole(c, r, r1) && !(wet && wet(c + o, r, r1))) for (let j = 0, k = r1 - r; j < k; j++) put(c + o, r + j, 128 | sd | (k << 3) | j);
        if (r2 > r1 && whole(c + o, r1, r2) && !(wet && wet(c + 2 * o, r1, r2))) for (let j = 0, k = r2 - r1; j < k; j++) put(c + 2 * o, r1 + j, 128 | sd | (k << 3) | j); } }
  }

  // a code's parts: the riser on the right (1) or left (0), the height in cells k, which cell j
  const right = (v) => (v >> 6) & 1, height = (v) => (v >> 3) & 7, which = (v) => v & 7;
  // the slanted line in cell units within the cell: its depth below the cell's top at `qx` (0..1 across); a point is INSIDE the wedge below it
  function lineQ(v, qx) { const k = (v >> 3) & 7; return k * ((v >> 6) & 1 ? 1 - qx : qx) - (v & 7); }
  function inside(v, qx, qy) { return qy > lineQ(v, qx); }
  // the cell a wedge cell takes its look (and what it is made of) from: the one under it, or the riser beside it for the higher cells of a slope
  //   taller than a cell — [c, r]
  function src(c, r, v) { const k = (v >> 3) & 7, j = v & 7; return j === k - 1 ? [c, r + 1] : [c + ((v >> 6) & 1 ? 1 : -1), r]; }
  // the way down the slant: −1 (to the left) when the riser is on the right
  const downDir = (v) => ((v >> 6) & 1) ? -1 : 1;

  return { kindOfDef, BUILTIN_KIND, block, topNear, steepDown, steepUp, code, scan, right, height, which, lineQ, inside, src, downDir };
});
