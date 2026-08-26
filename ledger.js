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
//  ── WHAT IS NOT HERE YET ──────────────────────────────────────────────────────────────────────────────────
//  Refining (materials → Prima) is the crucible, a later increment: `prima` exists and moves, but nothing
//  credits it yet except a direct grant. Dispersal on death, cairns and the conservation audit are also later.
//  The shape is here so the wire and the table do not have to change when they land.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════

const PERSIST_PREFIX = 'd:';                 // only authenticated keys reach the database
const FLUSH_MS = 2500;                       // debounce: a dig swing is many credits in a moment

class Ledger {
  constructor(db, opts) {
    this.db = db || null;
    this.holdings = new Map();               // playerKey → { prima, mats: Map<matId, n> }
    this.dirty = new Set();                  // persisted keys whose rows are behind memory
    this.flushTimer = null;
    this.flushMs = (opts && opts.flushMs) || FLUSH_MS;
    this.stats = { credits: 0, spends: 0, refused: 0, loads: 0, flushes: 0 };
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
    `);
    this._selMats = this.db.prepare('SELECT mat_id, n FROM player_holdings WHERE player_key = ?');
    this._selPrima = this.db.prepare('SELECT amount FROM player_prima WHERE player_key = ?');
    this._delMats = this.db.prepare('DELETE FROM player_holdings WHERE player_key = ?');
    this._insMat = this.db.prepare('INSERT INTO player_holdings (player_key, mat_id, n) VALUES (?, ?, ?)');
    this._upPrima = this.db.prepare('INSERT INTO player_prima (player_key, amount) VALUES (?, ?) ' +
                                    'ON CONFLICT(player_key) DO UPDATE SET amount = excluded.amount');
  }

  _persisted(key) { return !!this.db && typeof key === 'string' && key.startsWith(PERSIST_PREFIX); }

  // The in-memory record, loaded from disk on first touch. ⚠️ Loading LAZILY rather than at join keeps this
  // off the join path, which is already the most expensive thing a socket does.
  _rec(key) {
    let h = this.holdings.get(key);
    if (h) return h;
    h = { prima: 0, mats: new Map() };
    if (this._persisted(key)) {
      try {
        for (const row of this._selMats.all(key)) if (row.n > 0) h.mats.set(row.mat_id | 0, row.n | 0);
        const p = this._selPrima.get(key);
        h.prima = p ? (p.amount | 0) : 0;
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
    return { prima: h.prima, mats };
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

  // Everything this player is carrying, removed and handed back. The shape dispersal-on-death needs: the
  // ledger empties, the caller decides where the matter goes. ⭐ Returning it rather than deleting it is what
  // keeps conservation checkable — nothing here may destroy matter, only move it.
  takeAll(key) {
    const h = this._rec(key);
    const out = { prima: h.prima, mats: [] };
    for (const [m, n] of h.mats) if (n > 0) out.mats.push([m, n]);
    h.prima = 0; h.mats.clear();
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

module.exports = { Ledger, PERSIST_PREFIX };
