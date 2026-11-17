// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  spells.js — THE SPELL TABLE (magic step 1, 2026-11-16 — `scratchpad/kickoff_magic.md` §ROUND 3). SHARED: server/index.js requires
//  it and checks every cast against it; the client gets it inlined as `MWSpells` (extension/build.js, dev/serve.js) and reads the
//  same inputs from it — so the input you put in is the one the server would accept.
//
//  · DIRECTIONS: 0 up · 1 right · 2 down · 3 left.
//  · THE NINE POINTS of a traced rune are numbered 0–8, row by row from the top left:   0 1 2 / 3 4 5 / 6 7 8.
//  · A SPELL'S INPUT, two ways (a switch on the client, Items › Magic):
//      the LANGUAGE — its school's piece, then its form's piece, then one more "up" / an underline per tier above 0;
//      PLAIN        — a sequence and a rune of its own, sharing nothing with other spells (`plain` on the spell).
//    Both exist as direction KEYS and as a RUNE through the nine points.
//  · A CATALYST changes the cooldown (`cdK`) and the strength (`powK`), and has an INNATE ability (a spell id here, `innate: true`).
//  New spell = an entry in SPELLS + what it does on the client (16zj `MAGIC_FX`) and, if it changes the world, on the server.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MWSpells = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  const U = 0, R = 1, D = 2, L = 3;
  // name · colour · its two keys · its stroke through the nine points
  const SCHOOLS = {
    fire:       { name: 'Fire',            col: '#ff8a3c', keys: [U, U], rune: [6, 1, 8] },
    frost:      { name: 'Frost and water', col: '#7fd0ff', keys: [D, D], rune: [0, 7, 2] },
    storm:      { name: 'Storm',           col: '#c9d6ff', keys: [L, R], rune: [0, 5, 6] },
    earth:      { name: 'Earth',           col: '#c9a26a', keys: [D, U], rune: [0, 6, 8] },
    force:      { name: 'Force',           col: '#e6e6f0', keys: [R, R], rune: [3, 4, 5] },
    space:      { name: 'Space',           col: '#b08cff', keys: [R, L], rune: [2, 4, 6] },
    wards:      { name: 'Wards',           col: '#ffd86b', keys: [L, L], rune: [0, 2, 8] },
    life:       { name: 'Life',            col: '#8be28b', keys: [U, D], rune: [7, 4, 1] },
    decay:      { name: 'Decay',           col: '#a9b860', keys: [D, L], rune: [1, 3, 7] },
    alteration: { name: 'Alteration',      col: '#f0b0d0', keys: [U, R], rune: [3, 7, 5] },
    illusion:   { name: 'Illusion',        col: '#ff9be0', keys: [L, U], rune: [2, 0, 6] },
    knowing:    { name: 'Knowing',         col: '#8fe8e0', keys: [U, L], rune: [6, 2, 8] },
    voice:      { name: 'Voice',           col: '#f5f5a0', keys: [R, U], rune: [3, 1, 5] },
    summoning:  { name: 'Summoning',       col: '#e09a9a', keys: [D, R], rune: [2, 8, 6] },
    light:      { name: 'Light',           col: '#bcd8ff', keys: [L, D], rune: [0, 1, 2] },   // (step 3a: was 1 4 7 — with a form's stroke from the middle it ran back over itself, 7 → 4 → 7; no spell used it before)
  };
  // (the user, round 2: form pieces run THROUGH THE GRID'S POINTS — burst = the diamond, field = the full square, on yourself = the short diagonal)
  const FORMS = {
    bolt:    { name: 'Bolt',                 keys: [R, R], rune: [4, 5] },
    stream:  { name: 'Stream',               keys: [R, D], rune: [4, 8] },
    burst:   { name: 'Burst',                keys: [U, D], rune: [1, 5, 7, 3, 1] },
    self:    { name: 'On yourself',          keys: [D, D], rune: [4, 6] },
    placed:  { name: 'Placed',               keys: [D, L], rune: [4, 7] },
    shaping: { name: 'Shaping',              keys: [L, R], rune: [4, 2] },
    trail:   { name: 'Trail',                keys: [R, L], rune: [3, 4] },
    field:   { name: 'Field',                keys: [L, L], rune: [0, 2, 8, 6, 0] },
    touch:   { name: 'Touch',                keys: [U, U], rune: [4, 1] },
    thing:   { name: 'On a weapon or thing', keys: [U, R], rune: [0, 2] },
  };
  //  cd       seconds before it can be cast again (× the catalyst's `cdK`)
  //  stance   how the catalyst is held once the spell is prepared: 'level' = pointed at the pointer (a projectile) · 'raise' = held up
  //  tier     0 simple … — one more piece of input each, and easier to interrupt (client 16zj `magicHurt`)
  //  speed, life, grav, r   a bolt: px a second, seconds it flies, how much gravity pulls it (0–1), its radius (px)
  //  dmg      health it takes (of 10) · burn = what it hits catches fire
  //  innate   a catalyst's own ability: no input, not learnt
  //  learn    (step 2) how many times it must be put in rightly with its tome open before it is yours (this life)
  //  uses     (step 2) the reagents one cast uses up: [[item id, how many], …] (server/items.js, kind 'reagent')
  //  burnR    cells round where it lands that catch (a bolt with `burn`), default 1
  const SPELLS = {
    firebolt: { name: 'Firebolt', school: 'fire', form: 'bolt', tier: 0, cd: 2.5, stance: 'level', kind: 'bolt', learn: 3,
      speed: 760, life: 1.1, grav: 0.06, r: 3, dmg: 1.2, burn: true, plain: { keys: [U, R, R, D, R], rune: [6, 0, 4, 2, 8] } },
    // (step 2, 2026-11-17 — the user's step 0 pick: "1A for the quick low one, 1B for a bigger / stronger version") the same bolt one tier up: slower, heavier, it burns
    //   wider, and it uses up an EMBER SALT each cast
    greatbolt: { name: 'Great firebolt', school: 'fire', form: 'bolt', tier: 1, cd: 6, stance: 'level', kind: 'bolt', learn: 5, uses: [['ember_salt', 1]],
      speed: 560, life: 1.4, grav: 0.1, r: 5.5, dmg: 2.8, burn: true, burnR: 2, trailS: 1.2, plain: { keys: [U, R, R, D, R, U], rune: [6, 0, 4, 2, 8, 7] } },
    // ⭐ STEP 3a (2026-11-17, the user's step 0 picks): GUST (2B — wind seen only by what it moves: a cone from the hand that shoves bodies, loose things and liquid) and the LIGHT ORB
    //   (both 3A 'follows you' and 3B 'stays where you point', from ONE spell by a small change to its input — Light + Placed stays, Light + On yourself follows; the bluer light).
    //   `alt` = the spell it is a variant of: learnt with it, your own part shared with it (`baseOf`). `alts` = its variants (the tome's page shows them).
    //   reach  px (gust: how far it shoves; orb: how far it may be set) · cone  half its width, degrees · push  how hard (a body's speed, px a tick)
    //   secs  how long an orb lasts · pow, rr  its light: strength and reach (px) · stay  it hangs where it was set (else it follows its caster)
    gust: { name: 'Gust', school: 'storm', form: 'burst', tier: 0, cd: 3, stance: 'level', kind: 'gust', learn: 3, reach: 150, cone: 32, push: 9,
      plain: { keys: [L, L, R, U], rune: [3, 1, 5, 7] } },
    lightorb: { name: 'Light orb', school: 'light', form: 'placed', tier: 0, cd: 4, stance: 'level', kind: 'orb', learn: 3, stay: true, reach: 420, secs: 60, pow: 2, rr: 230, alts: ['lightorb_f'],
      plain: { keys: [L, D, D, L], rune: [1, 4, 7, 6] } },
    lightorb_f: { name: 'Light orb (following)', school: 'light', form: 'self', tier: 0, cd: 4, stance: 'level', kind: 'orb', alt: 'lightorb', stay: false, secs: 60, pow: 1.6, rr: 170,
      plain: { keys: [L, D, D, D], rune: [1, 4, 7, 8] } },
    // the innate abilities (step 1: one each, small)
    glow:  { name: 'Glow',  school: 'light', innate: true, cd: 1.5, kind: 'glow', secs: 20 },
    spark: { name: 'Spark', school: 'fire',  innate: true, cd: 1.5, kind: 'spark' },
  };
  //  cdK, powK   × every cooldown, × every spell's strength with it · innate = its own ability
  const CATALYSTS = {
    // (step 2b) the staff in ONE hand (something in the other) casts at `powK1`; in both, at `powK`
    staff: { cdK: 1.25, powK: 1.35, powK1: 1, innate: 'glow' },
    wand:  { cdK: 0.75, powK: 0.85, innate: 'spark' },
    orb:   { cdK: 1,    powK: 1,    innate: 'glow' },
  };

  // ⭐ STEP 2 (2026-11-17): TOMES, SCROLLS. A tome is an ITEM (server/items.js makes one per entry, kind 'tome'): its pages, each one spell, in order. A page may be
  //   DAMAGED — 'torn' (its lower half gone: the rune is lost), 'burnt' (its corner burnt: the end of the input and your own part are lost), 'missing' (torn out: a stub,
  //   nothing on it). Damage only hides writing: a torn or burnt page can still be learnt from by whoever works out what is missing; a missing page cannot.
  //   `cover` = its look (server/held.js `tome_<cover>`, `tome_<cover>_open`).
  const TOMES = {
    tome_hearth: { name: 'The hearth primer', cover: 'hearth', pages: [{ spell: 'firebolt' }, { spell: 'greatbolt' }] },
    tome_wayfarer: { name: 'The wayfarer’s primer', cover: 'wayfarer', pages: [{ spell: 'gust' }, { spell: 'lightorb' }] },   // (step 3a)
    tome_scorched: { name: 'A scorched primer', cover: 'scorched', pages: [{ spell: 'firebolt', dmg: 'torn' }, { dmg: 'missing' }, { spell: 'greatbolt', dmg: 'burnt' }] },
  };
  // A SCROLL: one use, no catalyst, no input — unrolled (the starting button held), aimed, fired; it burns up as the spell leaves. Carried in a stack (item kind 'scroll').
  const SCROLLS = {
    scroll_firebolt: { name: 'Scroll of firebolt', spell: 'firebolt' },
    scroll_greatbolt: { name: 'Scroll of great firebolt', spell: 'greatbolt' },
    scroll_gust: { name: 'Scroll of gust', spell: 'gust' },
    scroll_lightorb: { name: 'Scroll of light orb', spell: 'lightorb' },
  };

  const is = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(SPELLS, id);
  const of = (id) => is(id) ? SPELLS[id] : null;
  // ⭐ YOUR OWN VERSION (step 2 — kickoff §'against copied inputs' 1): every spell's input = the shared core + ONE PART worked out from you and this life. The SERVER makes
  //   the number `h` (from a secret it keeps, your key, your life, the spell — server `magicOwnH`) and sends it to you; `ownOf` turns it into the part, the same way here and
  //   there: a KEY put in after the school's piece, and a POINT the rune runs through after the school's stroke. null `h` = no own part (the core alone, as in step 1).
  const ownOf = (id, lang, h) => { if (h == null || !isFinite(h)) return null; const S = of(id); if (!S || S.innate) return null; h = Math.abs(Math.floor(h));
    const R0 = runeCore(id, lang); if (!R0) return null; const a = R0.pts.slice(0, R0.parts), b = R0.pts.slice(R0.parts), ok = [];
    for (let p = 0; p < 9; p++) { if (p === a[a.length - 1] || p === b[0]) continue; const full = a.concat([p], b); if (runeNorm(full).length === runeNorm(R0.pts).length + 1) ok.push(p); }
    return { k: h & 3, p: ok.length ? ok[(h >> 2) % ok.length] : null }; };
  // the keys of a spell: `lang` = school + form (+ an "up" a tier), else its plain sequence; `own` (from `ownOf`) put in after the first two
  const keysOf = (id, lang, own) => { const S = of(id); if (!S || S.innate) return null; let k;
    if (!lang) { if (!S.plain) return null; k = S.plain.keys.slice(); }
    else { k = SCHOOLS[S.school].keys.concat(FORMS[S.form].keys); for (let i = 0; i < (S.tier || 0); i++) k.push(U); }
    if (own && own.k != null) k.splice(2, 0, own.k & 3);
    return k; };
  // …and its rune, as ONE path through the nine points (the school's stroke, on to the form's, then one UNDERLINE a tier — bottom left to bottom right). `parts` = where the form's
  //   stroke begins (after the own point, when there is one)
  const runeCore = (id, lang) => { const S = of(id); if (!S || S.innate) return null;
    if (!lang) return S.plain ? { pts: S.plain.rune.slice(), parts: Math.min(3, S.plain.rune.length) } : null;
    const a = SCHOOLS[S.school].rune, b = FORMS[S.form].rune, pts = a.concat(b[0] === a[a.length - 1] ? b.slice(1) : b);
    for (let i = 0; i < (S.tier || 0); i++) pts.push(6, 8);
    return { pts, parts: a.length }; };
  const runeOf = (id, lang, own) => { const R0 = runeCore(id, lang); if (!R0) return null;
    if (!own || own.p == null) return R0;
    return { pts: R0.pts.slice(0, R0.parts).concat([own.p], R0.pts.slice(R0.parts)), parts: R0.parts + 1, own: R0.parts }; };
  // a path through the points with every point that lies exactly between its neighbours taken out (6 → 0 passes over 3: the same line)
  const runeNorm = (pts) => { const p = []; for (const n of pts) if (!p.length || p[p.length - 1] !== n) p.push(n);
    for (let i = 1; i < p.length - 1;) { const a = p[i - 1], b = p[i], c = p[i + 1];
      if ((a % 3) + (c % 3) === 2 * (b % 3) && Math.floor(a / 3) + Math.floor(c / 3) === 2 * Math.floor(b / 3) && a !== c) p.splice(i, 1); else i++; }
    return p; };
  const castable = () => Object.keys(SPELLS).filter(id => !SPELLS[id].innate);
  // keys so far → { spell } when they are exactly a spell's (and `more` too when a longer spell also begins with them — firebolt is the start of great firebolt) ·
  //   { more: true } while some spell still begins with them · null = wrong. `ownH(id)` = that spell's own number, or null
  const matchKeys = (seq, lang, ids, ownH) => { let more = false, spell = null;
    for (const id of ids || castable()) { const k = keysOf(id, lang, ownH ? ownOf(id, lang, ownH(id)) : null); if (!k || k.length < seq.length) continue;
      let ok = true; for (let i = 0; i < seq.length; i++) if (k[i] !== seq[i]) { ok = false; break; }
      if (!ok) continue; if (k.length === seq.length) spell = spell || id; else more = true; }
    return spell ? { spell, more } : more ? { more: true } : null; };
  // points joined so far → the same answers. (step 2) A point just passed over on the way to the next — 8 → 6 runs over 7 — is not wrong yet: the stroke is still going
  const midOf = (a, b, c) => a !== c && (a % 3) + (c % 3) === 2 * (b % 3) && Math.floor(a / 3) + Math.floor(c / 3) === 2 * Math.floor(b / 3);
  const matchRune = (pts, lang, ids, ownH) => { const p = runeNorm(pts); let more = false, spell = null;
    for (const id of ids || castable()) { const R0 = runeOf(id, lang, ownH ? ownOf(id, lang, ownH(id)) : null); if (!R0) continue; const k = runeNorm(R0.pts); if (k.length < p.length) continue;
      let ok = true, bad = -1; for (let i = 0; i < p.length; i++) if (k[i] !== p[i]) { ok = false; bad = i; break; }
      if (!ok) { if (bad === p.length - 1 && bad > 0 && midOf(p[bad - 1], p[bad], k[bad])) more = true; continue; }
      if (k.length === p.length) spell = spell || id; else more = true; }
    return spell ? { spell, more } : more ? { more: true } : null; };
  // A RUNE DRAWN FREELY (moved here from the client in step 2, so the server checks a practice the same way): a path as `n` points evenly along it, fitted to a unit box
  //   (the longer side = 1), middle at 0,0 · how far one drawn path lies from a spell's rune, on average, as a share of its size (where and how big do not matter)
  function pathFit(flat, n) {
    const m = flat.length / 2; if (m < 2) return null;
    let len = 0; const seg = [0]; for (let i = 1; i < m; i++) { len += Math.hypot(flat[i * 2] - flat[i * 2 - 2], flat[i * 2 + 1] - flat[i * 2 - 1]); seg.push(len); }
    if (len < 1e-6) return null;
    const out = []; let j = 1;
    for (let k = 0; k < n; k++) { const d = len * k / (n - 1); while (j < m - 1 && seg[j] < d) j++; const u = (d - seg[j - 1]) / Math.max(1e-9, seg[j] - seg[j - 1]);
      out.push(flat[j * 2 - 2] + (flat[j * 2] - flat[j * 2 - 2]) * u, flat[j * 2 - 1] + (flat[j * 2 + 1] - flat[j * 2 - 1]) * u); }
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (let k = 0; k < n; k++) { x0 = Math.min(x0, out[k * 2]); x1 = Math.max(x1, out[k * 2]); y0 = Math.min(y0, out[k * 2 + 1]); y1 = Math.max(y1, out[k * 2 + 1]); }
    const s = Math.max(x1 - x0, y1 - y0, 1e-6), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (let k = 0; k < n; k++) { out[k * 2] = (out[k * 2] - cx) / s; out[k * 2 + 1] = (out[k * 2 + 1] - cy) / s; }
    out.len = len; return out;
  }
  const runeDist = (fit, id, lang, own) => { const R0 = runeOf(id, lang, own); if (!R0 || !fit) return 1e9; const flat = []; for (const p of R0.pts) flat.push(p % 3, Math.floor(p / 3));
    const T = pathFit(flat, fit.length / 2); if (!T) return 1e9; let d = 0; const n = fit.length / 2; for (let k = 0; k < n; k++) d += Math.hypot(fit[k * 2] - T[k * 2], fit[k * 2 + 1] - T[k * 2 + 1]); return d / n; };
  // a cooldown in ms with this catalyst
  const cdMs = (id, cat) => { const S = of(id), C = CATALYSTS[cat]; return S ? Math.round(S.cd * 1000 * (C ? C.cdK : 1)) : 0; };
  // (step 3a) the spell a variant belongs to (learnt with it, its own part the same): the light orb that follows → the light orb
  const baseOf = (id) => { const S = of(id); return S && S.alt && is(S.alt) ? S.alt : id; };
  const learnN = (id) => { const S = of(baseOf(id)); return S ? Math.max(1, S.learn || (S.tier ? 5 : 3)) : 0; };
  const tomeOf = (item) => typeof item === 'string' && Object.prototype.hasOwnProperty.call(TOMES, item) ? TOMES[item] : null;
  const scrollOf = (item) => typeof item === 'string' && Object.prototype.hasOwnProperty.call(SCROLLS, item) ? SCROLLS[item] : null;
  return { SCHOOLS, FORMS, SPELLS, CATALYSTS, TOMES, SCROLLS, is, of, ownOf, keysOf, runeOf, runeNorm, matchKeys, matchRune, pathFit, runeDist, castable, cdMs, learnN, baseOf, tomeOf, scrollOf };
});
