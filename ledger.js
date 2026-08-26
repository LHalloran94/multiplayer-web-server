'use strict';
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  THE PRIMA LEDGER — what each player is carrying, held by the SERVER.
//
//  🟥 THIS IS THE ONE PART OF THE ECONOMY THAT CANNOT BE CLIENT-SIDE. A client-asserted balance is forged the
//  first day someone opens devtools, and the whole design — banditry, hauling, killing for someone's haul —
//  rests on a balance meaning something. `SHARED-WORLD.md` §3 calls it non-negotiable; the inventory was in
//  `chrome.storage.local` until this file existed, which was fine for a bag of dirt and is not fine for money.
//  ⚠️ THE MATERIAL POUCH MOVES TOO, not just the Prima. Materials drop on death like everything else, so a
//  thief's claim of what they took has to be checkable against something the thief does not own.
//
//  ⭐ EVERYTHING HERE IS INTEGER. The economy's premise is that matter is CONSERVED (kickoff_prima.md §2), and
//  a conserved quantity kept in floats stops summing to itself after enough transfers. There is no rounding
//  anywhere in this file, and there must never be.
//
//  ── WHO OWNS A BALANCE ────────────────────────────────────────────────────────────────────────────────────
//  A player key is `d:<discordId>` for a logged-in player and `s:<socketId>` for an anonymous one.
//  ⭐ ONLY `d:` KEYS ARE PERSISTED, and that is a decision rather than an omission: an anonymous player has no
//  identity to persist a balance AGAINST — the next socket is a different person as far as anything here can
//  tell. So an anonymous player can dig, carry and build within a session, and holds nothing across a refresh.
//  ⚠️ It follows that "log in to keep what you find" is a real gameplay rule, and it should be SAID in the UI
//  rather than discovered by losing a haul.
//
//  ── REFINING — THE ONE PLACE PRIMA IS CREATED ─────────────────────────────────────────────────────────────
//  A player puts refinable material into a QUEUE and it dissolves at a fixed PRIMA PER SECOND (kickoff_prima.md
//  §3). Not blocks per second: value comes from rarity while digging cost comes from hardness, so a
//  blocks-per-second rate would make turf the best earner in the game. A constant value-rate throughput-caps
//  every material at once, with no extra rule.
//
//  🟥 PRIMA IS GRANTED ONLY WHEN A WHOLE CELL FINISHES, AND THAT IS NOT A SIMPLIFICATION — IT IS WHAT MAKES
//  CANCELLING SAFE. Crediting the balance a little at a time reads better, but then a player who cancels a
//  half-refined cell gets the whole cell BACK while keeping the Prima already paid for it: matter created out
//  of nothing, on demand, by anybody, in the one system whose entire premise is that matter is conserved.
//  `paid` is therefore PROGRESS, not currency — cancelling discards it, which destroys nothing because it was
//  never anything. The progress bar is what gives back the feedback that incremental crediting would have.
//
//  ⚠️ THE QUEUE IS PART OF WHAT YOU ARE CARRYING. It leaves in `takeAll` with everything else, or dying with a
//  full hopper would delete it — a leak in the same list as the ones this track exists to close.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

const PERSIST_PREFIX = 'd:';                 // only authenticated keys reach the database
const FLUSH_MS = 2500;                       // debounce: a dig swing is many credits in a moment

// ⭐⭐ THE DIGEST ITSELF, AS ONE FUNCTION, because there are now two things that own a hopper: a player (the
// slow trickle they carry) and a crucible (the fast one standing in the world). They differ in who is credited
// and how fast, and in nothing else — so the arithmetic lives here once rather than being copied and then
// diverging, which is the shape this project keeps getting caught by.
//
// 🟥 THE PROPERTY IT EXISTS TO HOLD: a cell yields EXACTLY its worth, and a part-finished cell is remembered as
// `paid` rather than credited. Prima is granted only when a whole cell completes — anything else lets a
// cancelled half-refined cell come back whole with the Prima already paid for it, which mints matter.
//
// `q` is a queue of { m: material, n: count, k?: whose }. `state.paid` is progress toward the head's current
// cell. `onCell(k, worth)` is called once per completed cell — that is where the two callers differ.
// ⚠️ `budget` is PRIMA of work, not cells. That is the §3 rule: income is capped by value per second whatever
// you feed it, so cheap material does not become the best earner.
function digestQueue(q, state, budget, worthOf, onCell, onDud) {
  let left = budget | 0, made = 0;
  while (left > 0 && q.length) {
    const head = q[0], worth = worthOf(head.m) | 0;
    // A material the table no longer prices would spin here for ever. Hand it back rather than dissolve it for
    // nothing — the caller decides where "back" is.
    if (worth <= 0) { if (onDud) onDud(head); q.shift(); state.paid = 0; continue; }
    const need = worth - state.paid;
    if (left < need) { state.paid += left; left = 0; break; }
    left -= need; state.paid = 0;
    head.n -= 1; made += worth;
    onCell(head.k, worth);
    if (head.n <= 0) q.shift();
  }
  return made;
}

class Ledger {
  constructor(db, opts) {
    this.db = db || null;
    this.holdings = new Map();               // playerKey → { prima, mats: Map<matId, n> }
    this.dirty = new Set();                  // persisted keys whose rows are behind memory
    this.flushTimer = null;
    this.flushMs = (opts && opts.flushMs) || FLUSH_MS;
    // What a cell of a material is worth in Prima. Injected rather than required, because the worth table
    // lives in `materials.js` alongside the generator that the numbers were measured from, and this file has
    // no business knowing what a mineral is.
    this.worthOf = (opts && opts.worthOf) || (() => 0);
    this.stats = { credits: 0, spends: 0, refused: 0, loads: 0, flushes: 0, refined: 0, primaMade: 0 };
    if (this.db) this._initDb();
  }

  _initDb() {
    // ⚠️ `n` rather than `count`: COUNT is a SQL function name and a column called `count` reads as a bug in
    // every query that touches it.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS player_holdings (
        player_key TEXT    NOT NULL,
        mat_id     INTEGER NOT NULL,
        n          INTEGER NOT NULL,
        PRIMARY KEY (player_key, mat_id)
      );
      CREATE TABLE IF NOT EXISTS player_prima (
        player_key TEXT PRIMARY KEY,
        amount     INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS player_refine (
        player_key TEXT    NOT NULL,
        seq        INTEGER NOT NULL,
        mat_id     INTEGER NOT NULL,
        n          INTEGER NOT NULL,
        paid       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_key, seq)
      );
    `);
    this._selMats = this.db.prepare('SELECT mat_id, n FROM player_holdings WHERE player_key = ?');
    this._selPrima = this.db.prepare('SELECT amount FROM player_prima WHERE player_key = ?');
    this._delMats = this.db.prepare('DELETE FROM player_holdings WHERE player_key = ?');
    this._insMat = this.db.prepare('INSERT INTO player_holdings (player_key, mat_id, n) VALUES (?, ?, ?)');
    this._upPrima = this.db.prepare('INSERT INTO player_prima (player_key, amount) VALUES (?, ?) ' +
                                    'ON CONFLICT(player_key) DO UPDATE SET amount = excluded.amount');
    // ⚠️ `seq` is what keeps the queue a QUEUE. Without an explicit order column the rows come back in
    // whatever order SQLite likes, and the head — the one thing `paid` belongs to — stops being knowable.
    this._selRefine = this.db.prepare('SELECT mat_id, n, paid FROM player_refine WHERE player_key = ? ORDER BY seq');
    this._delRefine = this.db.prepare('DELETE FROM player_refine WHERE player_key = ?');
    this._insRefine = this.db.prepare('INSERT INTO player_refine (player_key, seq, mat_id, n, paid) VALUES (?, ?, ?, ?, ?)');
  }

  _persisted(key) { return !!this.db && typeof key === 'string' && key.startsWith(PERSIST_PREFIX); }

  // The in-memory record, loaded from disk on first touch. ⚠️ Loading LAZILY rather than at join keeps this
  // off the join path, which is already the most expensive thing a socket does.
  _rec(key) {
    let h = this.holdings.get(key);
    if (h) return h;
    h = { prima: 0, mats: new Map(), refine: [], paid: 0 };
    if (this._persisted(key)) {
      try {
        for (const row of this._selMats.all(key)) if (row.n > 0) h.mats.set(row.mat_id | 0, row.n | 0);
        const p = this._selPrima.get(key);
        h.prima = p ? (p.amount | 0) : 0;
        for (const row of this._selRefine.all(key)) {
          if (row.n > 0) h.refine.push({ m: row.mat_id | 0, n: row.n | 0 });
          if (!h.refine.length) continue;
          if (h.refine.length === 1) h.paid = row.paid | 0;      // `paid` belongs to the head and only the head
        }
        this.stats.loads++;
      } catch (e) { console.error('ledger: load failed for', key, e.message); }
    }
    this.holdings.set(key, h);
    return h;
  }

  _touch(key) {
    if (!this._persisted(key)) return;
    this.dirty.add(key);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, this.flushMs);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────────────────
  prima(key) { return this._rec(key).prima; }
  countOf(key, matId) { return this._rec(key).mats.get(matId | 0) || 0; }
  // The wire shape: `{ prima, mats: [[matId, n], …] }`. An array of pairs rather than an object because the
  // client's pouch already speaks that shape and a JSON object would stringify every id.
  snapshot(key) {
    const h = this._rec(key);
    const mats = [];
    for (const [m, n] of h.mats) if (n > 0) mats.push([m, n]);
    mats.sort((a, b) => b[1] - a[1]);
    // ⚠️ `paid` and the head's worth both ride along. The client draws a progress bar out of them and must not
    // compute the worth itself: the table is the server's, and a client that disagrees about what a cell is
    // worth draws a bar that never reaches its end.
    const head = h.refine[0];
    return {
      prima: h.prima, mats,
      refine: h.refine.map(e => [e.m, e.n]),
      paid: head ? h.paid : 0,
      headWorth: head ? this.worthOf(head.m) : 0,
    };
  }
  // ⭐ WHAT YOU ARE WORTH TO A KILLER — Prima carried, plus what everything in the pouch and the hopper would
  // refine into. That is the quantity the wealth glow reads (§9): not the balance, but how much trouble you are
  // in if somebody takes you down, which is the whole reason the glow exists.
  // ⚠️ The crucible's contents are NOT in it. They are not on you, they do not drop when you die, and a glow
  // that counted them would advertise a base's holdings from its owner's body.
  carriedWorth(key) {
    const h = this._rec(key);
    let w = h.prima | 0;
    for (const [m, n] of h.mats) w += this.worthOf(m) * n;
    for (const e of h.refine) w += this.worthOf(e.m) * e.n;
    return w;
  }
  refineTotal(key) {
    const h = this._rec(key);
    let n = 0; for (const e of h.refine) n += e.n;
    return n;
  }

  // ── writes ─────────────────────────────────────────────────────────────────────────────────────────────
  // Credit a pile's contents. ⭐ The caller passes the SERVER's own copy of the drop, never the client's claim
  // of what it picked up — that is the whole reason crediting is safe here: the server already owned the drop
  // list so two players could not both collect one pile, so it already knows what was in it.
  credit(key, mats) {
    if (!mats || !mats.length) return 0;
    const h = this._rec(key);
    let total = 0;
    for (const [m, n] of mats) {
      const id = m | 0, k = n | 0;
      if (id <= 0 || k <= 0) continue;
      h.mats.set(id, (h.mats.get(id) || 0) + k);
      total += k;
    }
    if (total) { this.stats.credits++; this._touch(key); }
    return total;
  }

  // How many cells of `matId` this player may place right now. The caller CAPS the brush with it rather than
  // refusing the whole stroke, so you place what you can afford and the rest simply does not appear.
  budget(key, matId) { return this.countOf(key, matId); }

  // Spend up to `n`; returns how much was actually taken. ⚠️ Never goes negative and never throws — a debit
  // larger than the balance is a bug somewhere upstream, and silently clamping is the behaviour that keeps
  // the invariant (holdings >= 0) true no matter who calls this.
  spend(key, matId, n) {
    const id = matId | 0, want = n | 0;
    if (id <= 0 || want <= 0) return 0;
    const h = this._rec(key);
    const have = h.mats.get(id) || 0;
    const take = Math.min(have, want);
    if (take < want) this.stats.refused++;
    if (!take) return 0;
    if (take === have) h.mats.delete(id); else h.mats.set(id, have - take);
    this.stats.spends++;
    this._touch(key);
    return take;
  }

  grantPrima(key, amount) {
    const a = amount | 0;
    if (!a) return 0;
    const h = this._rec(key);
    h.prima = Math.max(0, h.prima + a);
    this._touch(key);
    return h.prima;
  }

  // ── refining ───────────────────────────────────────────────────────────────────────────────────────────
  // Move material out of the pouch and into the hopper. Returns how much actually went in — the caller asks,
  // the server decides how much they had, exactly as `spend` does.
  // ⚠️ REFUSES ANYTHING WORTH NOTHING, and that is the §3 threshold doing its job rather than a safety check:
  // bulk rock and soil have no Prima worth, so a cell of them would sit at the head of the queue for ever,
  // never completing. It is also what stops the pouch's 89 materials collapsing into one number.
  // ⭐ Merged by material rather than appended, so feeding the same stack twice makes one entry rather than a
  // list that grows for ever. Merging into the HEAD is safe because `paid` is progress toward one CELL of that
  // material and the material has not changed.
  refineAdd(key, matId, n) {
    const id = matId | 0, want = n | 0;
    if (id <= 0 || want <= 0) return 0;
    if (this.worthOf(id) <= 0) { this.stats.refused++; return 0; }
    const took = this.spend(key, id, want);
    if (!took) return 0;
    const h = this._rec(key);
    const e = h.refine.find(x => x.m === id);
    if (e) e.n += took; else h.refine.push({ m: id, n: took });
    this._touch(key);
    return took;
  }
  // Change your mind: everything of `matId` comes back out of the hopper and into the pouch.
  // 🟥 THE HEAD'S PROGRESS IS DISCARDED, AND NOTHING IS LOST BY IT. `paid` is Prima that has NOT been granted
  // (see the header): the cell is whole, it goes back whole, and the partial work simply did not happen. Had
  // the balance been credited as it went, this line would be a machine for printing matter.
  refineCancel(key, matId) {
    const id = matId | 0;
    const h = this._rec(key);
    const i = h.refine.findIndex(x => x.m === id);
    if (i < 0) return 0;
    const back = h.refine[i].n;
    h.refine.splice(i, 1);
    if (i === 0) h.paid = 0;
    h.mats.set(id, (h.mats.get(id) || 0) + back);
    this._touch(key);
    return back;
  }
  // Advance the hopper by `prima` units of work. ⭐ THE UNIT OF WORK IS PRIMA, NOT CELLS — that is the whole
  // rule: a cell takes `worth / rate` seconds, so income is capped at the rate whatever you feed it, and a
  // mountain of cheap material takes proportionally for ever.
  // Returns how much Prima was actually created, which is 0 unless a cell completed.
  refineStep(key, prima) {
    const budget = prima | 0;
    if (budget <= 0) return 0;
    const h = this._rec(key);
    if (!h.refine.length) return 0;
    const st = { paid: h.paid };
    const made = digestQueue(h.refine, st, budget, this.worthOf,
      () => { this.stats.refined++; },
      (dud) => { h.mats.set(dud.m, (h.mats.get(dud.m) || 0) + dud.n); });   // unpriced ⇒ straight back to the pouch
    h.paid = st.paid;
    if (made) { h.prima += made; this.stats.primaMade += made; }
    this._touch(key);
    return made;
  }

  // Everything this player is carrying, removed and handed back. The shape dispersal-on-death needs: the
  // ledger empties, the caller decides where the matter goes. ⭐ Returning it rather than deleting it is what
  // keeps conservation checkable — nothing here may destroy matter, only move it.
  takeAll(key) {
    const h = this._rec(key);
    const out = { prima: h.prima, mats: [] };
    const bag = new Map(h.mats);
    // 🟥 THE HOPPER LEAVES TOO. Material in the refine queue is material you are CARRYING — it is out of the
    // pouch but it has not become anything yet — so leaving it behind here would mean dying with a full hopper
    // silently deleted it. That is a leak of exactly the kind §8 lists, and it would have been invisible: the
    // pouch empties, the piles look right, and the ore that was mid-refine is simply gone.
    // ⚠️ Merged back into the material totals rather than reported separately, because what lands on the
    // ground is a pile of ore; nothing about a cairn knows that some of it was queued.
    for (const e of h.refine) if (e.n > 0) bag.set(e.m, (bag.get(e.m) || 0) + e.n);
    for (const [m, n] of bag) if (n > 0) out.mats.push([m, n]);
    h.prima = 0; h.mats.clear(); h.refine.length = 0; h.paid = 0;
    this._touch(key);
    return out;
  }

  // Drop an anonymous player's record when their socket goes. ⚠️ Persisted keys are KEPT in memory on
  // disconnect — a page navigation is a new socket every time, and re-reading from disk on each one would
  // make the common case the slow one.
  forgetEphemeral(key) {
    if (!this._persisted(key)) this.holdings.delete(key);
  }

  // ── persistence ────────────────────────────────────────────────────────────────────────────────────────
  // ⚠️ DELETE-THEN-INSERT per key, inside one transaction. An UPSERT per material would leave rows for
  // materials the player no longer has, and a stale row here is a balance that comes back from the dead.
  flush() {
    if (!this.db || !this.dirty.size) return 0;
    const keys = [...this.dirty];
    this.dirty.clear();
    let wrote = 0;
    try {
      this.db.exec('BEGIN');
      for (const key of keys) {
        const h = this.holdings.get(key);
        if (!h) continue;
        this._delMats.run(key);
        for (const [m, n] of h.mats) if (n > 0) this._insMat.run(key, m, n);
        this._upPrima.run(key, h.prima);
        // Same delete-then-insert, for the same reason: an UPSERT would leave rows for entries that have
        // finished refining, and a stale row here is ore that comes back from the dead.
        this._delRefine.run(key);
        for (let i = 0; i < h.refine.length; i++) {
          const e = h.refine[i];
          if (e.n > 0) this._insRefine.run(key, i, e.m, e.n, i === 0 ? (h.paid | 0) : 0);
        }
        wrote++;
      }
      this.db.exec('COMMIT');
      this.stats.flushes++;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (e2) {}
      for (const k of keys) this.dirty.add(k);          // put them back; the next flush retries
      console.error('ledger: flush failed', e.message);
      return 0;
    }
    return wrote;
  }
}

module.exports = { Ledger, PERSIST_PREFIX, digestQueue };
