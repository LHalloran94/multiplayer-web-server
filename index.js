// ============================================================================
// server/index.js — TABLE OF CONTENTS  (grep the "// ---- <name> ----" marker to jump; line numbers drift, marker text does not)
//   Setup (top → ~330):  express + socket.io + CORS init · SQLite open + ~20 CREATE TABLEs · JWT auth middleware · in-memory presence/relay maps (discordIdToSocket, leaderTabs, roomObjects, …)
//   REST endpoints:      Discord OAuth · Friends · Profile · Block · Room avatar-World spec · Private rooms · Room social signals (favourite/like/rating) · Published Worlds (gallery/publish/remix/unpublish) · Shared animation library · Groups · Follow settings & follows
//   Terrain / world:     Destructible terrain (Tier C) · Custom material registry · Avatar-world MODES (sandbox/world)
//   Published Worlds:    server-side persistence + unattended hydration (hydrateRoomFromBlob) · Persistent durability snapshot sweep
//   Shared libraries:    animation library (socket) · Generic shared libraries (emojis/sounds/templates/blocks) · Overlay THEME library
//   Realtime core:       Authoritative avatar simulation (Stage 1b, 60Hz tick — legacy 'server' transport) · Follow per-leader tab snapshots (emitTabSnapshot)
//   Totals: ~64 REST routes + ~84 socket.on handlers. Ephemeral state (cursors/sprays/drawing/chat/avatar objects) in-memory; users/friends/dm/blocks/rooms/groups/follows/published_worlds persisted in SQLite.
// ============================================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');  // content-addressing for the face-picture store (see "Face pictures")
const MWSim = require('./avatar-sim'); // shared authoritative avatar simulation
const WORLDGEN = require('./worldgen');
const WORLDGEN2 = require('./worldgen2'); // the PORTED world redesign (port inc 3-6). Ships OFF: worldCfg.gen2 // Phase 6 inc 4: chunk-on-demand world generation (the Overworld's generator)
const DOMAINS = require('./domains');   // Phase 6 inc 6: which column of the Overworld a site spawns at
const LEDGER = require('./ledger');     // the Prima economy: what each player carries, held HERE and not in a browser
const MATGEN = require('./materials');  // Phase 6 world-redesign port inc 1: the generator's materials, ids 18..89
                                        // ⚠️ ALSO INLINED INTO THE CLIENT BUNDLE by extension/build.js (as MWMats),
                                        // the same way avatar-sim.js is. One table, two readers — never copy rows out.

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Custom avatar skins, materials, sprays and drawings are sent as data-URL images; these routinely
  // exceed the 1 MB engine.io default, which would force-close the offending socket. Bump to 10 MB.
  maxHttpBufferSize: 1e7,
  // Backgrounded browser tabs throttle the heartbeat timer; transient lag/proxy hiccups delay it too.
  // The 20 s default ping timeout drops those clients (→ reconnect churn). Be more tolerant.
  pingInterval: 25000,
  pingTimeout: 60000
});

// Per-field payload guard: data-URL skins/sprays/emotes get relayed to a whole room, so one oversized
// string field is a bandwidth-amplification vector. The 10 MB connection cap above only stops truly huge
// frames; this drops/strips individual fields too big to be a legit small image (2 MB ≈ ~1.4 MB binary).
const MAX_RELAY_FIELD = 2 * 1024 * 1024;
function oversizedField(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.length > MAX_RELAY_FIELD) return true;
  return false;
}

app.use(express.json({ limit: '4mb' }));   // covers 2MB World publishes + shared-animation specs (image/GIF fills)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Chrome Private Network Access: an https page reaching http://localhost sends a preflight
  // with Access-Control-Request-Private-Network; it must be answered with this header or blocked.
  res.header('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';

// SQLite (built-in node:sqlite, Node ≥ 22.5) — mount a Railway Volume at /data and set DB_PATH=/data/db.sqlite
const { DatabaseSync } = require('node:sqlite');
const DB_PATH = process.env.DB_PATH || './db.sqlite';
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    avatar     TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS friends (
    from_id    TEXT NOT NULL,
    to_id      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (from_id, to_id)
  );
  CREATE INDEX IF NOT EXISTS idx_friends_to ON friends(to_id);
  CREATE TABLE IF NOT EXISTS dm_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_discord_id TEXT NOT NULL,
    to_discord_id   TEXT NOT NULL,
    text            TEXT NOT NULL,
    sent_at         INTEGER DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_dm_conv ON dm_messages(from_discord_id, to_discord_id);
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    joined_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (room_id, discord_id)
  );
  CREATE TABLE IF NOT EXISTS room_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    from_discord_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at INTEGER DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_room_msgs ON room_messages(room_id, sent_at);
`);
try { db.exec('ALTER TABLE users ADD COLUMN bio TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN status TEXT'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN public INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN scope TEXT'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN description TEXT'); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN follow_policy TEXT DEFAULT 'friends'`); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN follow_allowlist TEXT DEFAULT \'\''); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN browsing_visible INTEGER DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN social_links TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN beacon_url TEXT'); } catch {}
// Stage 6 Phase 2b — rooms can host an avatar World. `env_spec` = JSON { levels:[{type,name,…cfg}], nav }
// (the ordered Level list + per-Level config + nav mode; terrain/object CONTENT stays host-local in v1,
// hydrated live on entry). `kind` distinguishes a plain chat room from one with a World; `perms`/`meta`
// reserved for Phase 3 host-permissions. All nullable → existing rooms read as plain chat rooms.
try { db.exec('ALTER TABLE rooms ADD COLUMN kind TEXT'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN env_spec TEXT'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN perms TEXT'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN meta TEXT'); } catch {}
// Stage 6 Active-Room launcher — a public room may be bound to a specific page URL (the client's
// `currentURL` = hostname+pathname+search, same key the page-bound layer uses). Null = not URL-bound.
try { db.exec('ALTER TABLE rooms ADD COLUMN url TEXT'); } catch {}
// Phase 2 (hotbar): a room may carry a visual icon — either a single emoji or an image URL. Lets the
// open-rooms hotbar / list rows distinguish rooms at a glance. Null = fall back to the binding glyph.
try { db.exec('ALTER TABLE rooms ADD COLUMN icon TEXT'); } catch {}
// Friends-only rooms: not public (won't appear in public listings) but any accepted friend of the owner
// can discover (via GET /rooms/friends) and join without an explicit invite/code. friends_only=1 implies
// public=0. Saves making a private room and inviting each friend by hand.
try { db.exec('ALTER TABLE rooms ADD COLUMN friends_only INTEGER DEFAULT 0'); } catch {}
// last_active (Unix ms) — bumped on enter + on each message. Drives pruning of idle auto-provisioned Site
// rooms (owner 'system'); user-created rooms are never swept.
try { db.exec('ALTER TABLE rooms ADD COLUMN last_active INTEGER'); } catch {}
// Discord mutuals: each authed user's guild (server) ids, refreshed on login (requires the OAuth 'guilds'
// scope). Powers friend suggestions — extension users you share a Discord server with.
try { db.exec('CREATE TABLE IF NOT EXISTS user_guilds (discord_id TEXT NOT NULL, guild_id TEXT NOT NULL, PRIMARY KEY (discord_id, guild_id))'); } catch {}

// Phase 3 — room social signals. Personal favourite (private bookmark, drives the Favourites sub-tab),
// public like (one per user), and a 1–5 star rating (one vote per user; avg/count computed on read).
db.exec(`
  CREATE TABLE IF NOT EXISTS room_favourites (
    discord_id TEXT NOT NULL,
    room_id    TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (discord_id, room_id)
  );
  CREATE TABLE IF NOT EXISTS room_likes (
    discord_id TEXT NOT NULL,
    room_id    TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (discord_id, room_id)
  );
  CREATE TABLE IF NOT EXISTS room_ratings (
    discord_id TEXT NOT NULL,
    room_id    TEXT NOT NULL,
    stars      INTEGER NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (discord_id, room_id)
  );
  CREATE INDEX IF NOT EXISTS idx_room_likes_room   ON room_likes(room_id);
  CREATE INDEX IF NOT EXISTS idx_room_ratings_room ON room_ratings(room_id);
  CREATE INDEX IF NOT EXISTS idx_room_favs_user    ON room_favourites(discord_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS follows (
    follower_id  TEXT NOT NULL,
    followee_id  TEXT NOT NULL,
    created_at   INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (follower_id, followee_id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    owner_id    TEXT NOT NULL,
    open        INTEGER DEFAULT 0,
    created_at  INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id   TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    role       TEXT DEFAULT 'member',
    joined_at  INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (group_id, discord_id)
  );
  CREATE TABLE IF NOT EXISTS group_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id        TEXT NOT NULL,
    from_discord_id TEXT NOT NULL,
    text            TEXT NOT NULL,
    sent_at         INTEGER DEFAULT (unixepoch() * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_group_msgs ON group_messages(group_id, sent_at);
`);

function verifyToken(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  try { return jwt.verify(h.slice(7), JWT_SECRET); } catch { return null; }
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(code));
  return code;
}

function generateGroupCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (db.prepare('SELECT 1 FROM groups WHERE id = ?').get(code));
  return code;
}

// Phase 3 — compute a room's social aggregates (+ the caller's own state, if logged in).
function roomSocial(roomId, callerId) {
  const likes = db.prepare('SELECT COUNT(*) AS c FROM room_likes WHERE room_id = ?').get(roomId).c;
  const rt = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(stars), 0) AS s FROM room_ratings WHERE room_id = ?').get(roomId);
  const out = {
    like_count: likes,
    rating_count: rt.c,
    rating_avg: rt.c ? +(rt.s / rt.c).toFixed(2) : 0,
    favourited: false, liked: false, my_rating: 0,
  };
  if (callerId) {
    out.favourited = !!db.prepare('SELECT 1 FROM room_favourites WHERE discord_id = ? AND room_id = ?').get(callerId, roomId);
    out.liked = !!db.prepare('SELECT 1 FROM room_likes WHERE discord_id = ? AND room_id = ?').get(callerId, roomId);
    const r = db.prepare('SELECT stars FROM room_ratings WHERE discord_id = ? AND room_id = ?').get(callerId, roomId);
    out.my_rating = r ? r.stars : 0;
  }
  return out;
}

// Compact "what can non-hosts do here" summary derived from a room's perms JSON. `build` defaults to
// 'all'; any feature whose room-wide mode is 'host' is host-only. Returns { build:'all'|'host',
// restricted:[featureKey,...] } — small enough to ship inside list reads (we never leak raw per-user perms).
function roomFeatureAvail(permsStr) {
  const out = { build: 'all', restricted: [] };
  if (!permsStr) return out;
  try {
    const p = JSON.parse(permsStr);
    if (p && p.build === 'host') out.build = 'host';
    const modes = p && p.features && p.features.modes;
    if (modes && typeof modes === 'object') for (const k in modes) if (modes[k] === 'host') out.restricted.push(k);
  } catch {}
  return out;
}

// Coerce a room row that carries social subquery columns into the client-facing shape (booleans, numbers,
// parsed env_spec). Used by the list endpoints that compute aggregates inline.
function normalizeRoomSocial(r) {
  const out = {
    ...r,
    env_spec: parseEnvSpec(r.env_spec),
    like_count: r.like_count || 0,
    rating_count: r.rating_count || 0,
    rating_avg: r.rating_avg ? +(+r.rating_avg).toFixed(2) : 0,
    favourited: !!r.favourited,
    liked: !!r.liked,
    my_rating: r.my_rating || 0,
    feature_avail: roomFeatureAvail(r.perms),
  };
  delete out.perms;   // ship only the compact feature_avail, not the raw perms blob
  // Item-10 follow-up #5: live head-counts for the room listings — distinct people IN the Room now, and
  // (URL-tied rooms only) distinct people ON that page now. identityCount/roomUsers/pageUsers are defined
  // below but resolve at request time. Lets the browser show "🌐 on-page · 👤 in-room" before you join.
  out.players_now = identityCount(roomUsers['pg:' + r.id]);
  if (r.url) out.page_now = identityCount(pageUsers[r.url]);
  return out;
}

// True if a and b are accepted friends (either direction). Used to gate friends-only room access.
const _friendStmt = db.prepare(`SELECT 1 FROM friends WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) AND status='accepted'`);
function areFriends(a, b) { return a && b && a !== b && !!_friendStmt.get(a, b, b, a); }

// Coerce a published_worlds row (joined to its backing room for env_spec/perms + social subqueries) into
// the client-facing gallery shape. Shared by GET /worlds and the favourited-Worlds half of /rooms/favourites.
function mapWorldRow(r) {
  return {
    ...r, allow_remix: !!r.allow_remix, env_spec: parseEnvSpec(r.env_spec),
    players_now: (io.sockets.adapter.rooms.get('pg:' + r.room_id) || { size: 0 }).size,
    like_count: r.like_count || 0, rating_count: r.rating_count || 0,
    rating_avg: r.rating_avg ? +(+r.rating_avg).toFixed(2) : 0,
    favourited: !!r.favourited, liked: !!r.liked, my_rating: r.my_rating || 0,
    feature_avail: roomFeatureAvail(r.perms), perms: undefined,
  };
}
// SELECT column list shared by the two World reads (GET /worlds + favourited Worlds). `?` placeholders:
// favourited, liked, my_rating (each binds the caller's id). For the favourites query the favourited
// subquery is replaced by a literal `1` (the JOIN already restricts to the caller's favourites).
const WORLD_SOCIAL_COLS = `w.id, w.owner_id, w.room_id, w.name, w.author, w.description, w.thumb, w.level_count, w.allow_remix, w.durability, w.play_count, w.updated_at, r.env_spec, r.perms,
    (SELECT COUNT(*) FROM room_likes rl WHERE rl.room_id = w.room_id) as like_count,
    (SELECT COUNT(*) FROM room_ratings rr WHERE rr.room_id = w.room_id) as rating_count,
    (SELECT COALESCE(AVG(stars), 0) FROM room_ratings rr WHERE rr.room_id = w.room_id) as rating_avg,
    (SELECT 1 FROM room_likes rl2 WHERE rl2.room_id = w.room_id AND rl2.discord_id = ?) as liked,
    (SELECT stars FROM room_ratings rr2 WHERE rr2.room_id = w.room_id AND rr2.discord_id = ?) as my_rating`;

// ---- Discord OAuth endpoint ----
app.post('/auth/discord', async (req, res) => {
  const { code, redirectUri } = req.body;
  if (!code || !redirectUri) return res.status(400).json({ error: 'Missing code or redirectUri' });
  if (!DISCORD_CLIENT_SECRET) return res.status(500).json({ error: 'Auth not configured on server' });

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) return res.status(400).json({ error: tokenData.error_description || 'Token exchange failed' });

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const user = await userRes.json();
    if (!userRes.ok) return res.status(400).json({ error: 'Failed to fetch Discord profile' });

    const avatarUrl = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : null;

    // Store this user's Discord guild ids for mutual-server friend suggestions. Needs the 'guilds' scope;
    // silently skip if the token wasn't granted it (older logins) — suggestions just stay empty until re-auth.
    try {
      const gRes = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
      if (gRes.ok) {
        const guilds = await gRes.json();
        if (Array.isArray(guilds)) {
          const del = db.prepare('DELETE FROM user_guilds WHERE discord_id = ?');
          const ins = db.prepare('INSERT OR IGNORE INTO user_guilds (discord_id, guild_id) VALUES (?, ?)');
          db.transaction(() => { del.run(user.id); for (const g of guilds.slice(0, 200)) if (g && g.id) ins.run(user.id, String(g.id)); })();
        }
      }
    } catch (e) { /* guilds are best-effort */ }

    const token = jwt.sign(
      { sub: user.id, username: user.username, avatar: avatarUrl },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ jwt: token, username: user.username, avatar: avatarUrl });
  } catch (err) {
    console.error('[auth/discord]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ---- DEV LOGIN (the dev page has no Discord path) --------------------------------------------------------
// ⭐ WHY THIS EXISTS: `extension/dev/serve.js` is the fast loop for anything visual, but Discord OAuth runs
// through `chrome.identity.launchWebAuthFlow` in the extension's service worker — a surface the dev shim
// explicitly cannot replace. So the dev page was permanently logged out, which since the Prima ledger means it
// could not keep anything it collected, which makes it useless for testing the economy.
//
// 🟥 THIS IS AN AUTHENTICATION BYPASS AND IS FENCED THREE WAYS.
//   1. `MW_DEV_LOGIN=1` must be set. Absent, the route 404s exactly like any unknown path.
//   2. The request must arrive on the LOOPBACK interface.
//   3. ⭐ The identity it mints is NAMESPACED `dev:<name>` and can never collide with a Discord snowflake, which
//      are decimal digits only. So even if 1 and 2 were both defeated — say by a tunnel, which makes remote
//      traffic look local — the worst available outcome is "a stranger made themselves a throwaway account",
//      never "a stranger took over a real one". That third fence is the one that actually bounds the damage,
//      and it is why this is acceptable at all.
// ⚠️ It is NOT enabled by the restart scripts. Turn it on deliberately for a session that needs it.
if (process.env.MW_DEV_LOGIN === '1') {
  const LOOPBACK = /^(::1|::ffff:127\.|127\.)/;
  app.get('/dev/login', (req, res) => {
    const ip = String(req.socket.remoteAddress || '');
    if (!LOOPBACK.test(ip)) return res.status(404).end();
    const name = String(req.query.name || 'dev').slice(0, 24).replace(/[^A-Za-z0-9_-]/g, '') || 'dev';
    const sub = 'dev:' + name;
    db.prepare('INSERT OR REPLACE INTO users (discord_id, username, avatar, updated_at) VALUES (?, ?, ?, unixepoch())').run(sub, name, null);
    const token = jwt.sign({ sub, username: name, avatar: null }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ jwt: token, username: name, avatar: null });
  });
  console.log('⚠ MW_DEV_LOGIN is ON — GET /dev/login?name=x mints a dev:x identity for loopback callers');
}

// ---- CPU PROFILE ON DEMAND (debug) ----------------------------------------------------------------------
// ⭐ "Isn't there some way you can look at the actual computational behaviour and see what exactly is holding
// everything up?" — yes, and this is it. `GET /debug/cpu-profile?ms=20000` samples the server for that long and
// writes a V8 .cpuprofile into server/prof/; `scratchpad/read_cpuprofile.js` ranks it by SELF time.
//
// ⚠️ WHY NOT `node --cpu-prof`. That only writes the file when the process EXITS CLEANLY, and restart-server.ps1
// stops the server with `Stop-Process -Force`, which does not give it the chance. The profile came out empty
// every time and looked like a profiler problem rather than a shutdown one. Doing it in-process removes the
// question: the file is written while the server is still running.
//
// ⚠️ LOCALHOST ONLY, and deliberately not behind the JWT: a profiler is arbitrary-ish introspection, and the
// server is reachable over a public Funnel URL. Costs nothing when not profiling — the inspector session is
// created on demand and disconnected afterwards.
let _cpuProf = null;
// ⭐⭐ ONE IMPLEMENTATION, TWO WAYS IN. This used to be reachable only as a URL, and the user's answer to being
// asked to fetch one was the right one: *"I don't know how to hit the cpu-profile thing; it is better to put
// such things into the debug panel if you want me to do them."* A diagnostic that needs a terminal is a
// diagnostic that does not get taken at the moment the problem is on screen — which is the only moment it is
// worth anything. The Perf tab now has a button, and it calls exactly this.
// `done(err, file)` fires when the profile has been WRITTEN, not when it starts.
function startCpuProfile(ms, done) {
  if (_cpuProf) return done('a profile is already running', null);
  let inspector, fs2, path2;
  try { inspector = require('node:inspector'); fs2 = require('node:fs'); path2 = require('node:path'); }
  catch (e) { return done(String(e), null); }
  const session = new inspector.Session();
  try { session.connect(); } catch (e) { return done('connect: ' + e.message, null); }
  _cpuProf = session;
  session.post('Profiler.enable', () => session.post('Profiler.start', () => {
    setTimeout(() => session.post('Profiler.stop', (err, out) => {
      _cpuProf = null;
      let file = null, error = err ? String(err) : null;
      try {
        const dir = path2.join(__dirname, 'prof');
        if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
        const f = path2.join(dir, 'server-' + Date.now() + '.cpuprofile');
        if (!err) { fs2.writeFileSync(f, JSON.stringify(out.profile)); file = 'server/prof/' + path2.basename(f); }
        console.log('[prof] wrote ' + f);
      } catch (e) { error = e.message; console.log('[prof] write failed: ' + e.message); }
      try { session.disconnect(); } catch (e) {}
      done(error, file);
    }), ms);
  }));
  return null;
}
app.get('/debug/cpu-profile', (req, res) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip !== '127.0.0.1' && ip !== '::1') return res.status(403).json({ error: 'localhost only' });
  const ms = Math.max(1000, Math.min(120000, +req.query.ms || 20000));
  if (_cpuProf) return res.status(409).json({ error: 'a profile is already running' });
  startCpuProfile(ms, () => {});
  res.json({ profiling: true, ms, dir: 'server/prof' });
});

// ---- Friends endpoints ----
app.get('/friends', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(`
      SELECT u.discord_id, u.username, u.avatar, f.status,
             CASE WHEN f.from_id = ? THEN 0 ELSE 1 END as incoming
      FROM friends f
      JOIN users u ON u.discord_id = CASE WHEN f.from_id = ? THEN f.to_id ELSE f.from_id END
      WHERE f.from_id = ? OR f.to_id = ?
    `).all(user.sub, user.sub, user.sub, user.sub);
    res.json(rows.map(r => ({ ...r, incoming: !!r.incoming, online: !!discordIdToSocket[r.discord_id] })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// People you may know: extension users who share ≥1 Discord server with the caller and aren't already a
// friend / pending. Ranked by number of shared servers. Empty until both parties logged in with the
// 'guilds' scope (see /auth/discord).
app.get('/friends/suggestions', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(`
      SELECT u.discord_id, u.username, u.avatar, COUNT(DISTINCT ug2.guild_id) as shared
      FROM user_guilds ug1
      JOIN user_guilds ug2 ON ug2.guild_id = ug1.guild_id AND ug2.discord_id != ug1.discord_id
      JOIN users u ON u.discord_id = ug2.discord_id
      WHERE ug1.discord_id = ?
        AND ug2.discord_id NOT IN (
          SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END FROM friends WHERE from_id = ? OR to_id = ?
        )
      GROUP BY u.discord_id, u.username, u.avatar
      ORDER BY shared DESC, u.username ASC
      LIMIT 20
    `).all(user.sub, user.sub, user.sub, user.sub);
    res.json(rows.map(r => ({ discord_id: r.discord_id, username: r.username, avatar: r.avatar || null, shared_guilds: r.shared })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/friends/request', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { to } = req.body;
  if (!to || to === user.sub) return res.status(400).json({ error: 'Invalid' });
  try {
    const target = db.prepare('SELECT discord_id FROM users WHERE discord_id = ?').get(to);
    if (!target) return res.status(404).json({ error: 'User not found' });
    db.prepare('INSERT INTO friends (from_id, to_id) VALUES (?, ?)').run(user.sub, to);
    const targetSocket = discordIdToSocket[to];
    if (targetSocket) {
      io.to(targetSocket).emit('friend-request', {
        from: { discord_id: user.sub, username: user.username, avatar: user.avatar || null }
      });
    }
    res.json({ ok: true });
  } catch (e) {
    if (e.code && e.code.startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Already sent' });
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/friends/accept', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { from } = req.body;
  try {
    const result = db.prepare(`UPDATE friends SET status='accepted' WHERE from_id=? AND to_id=? AND status='pending'`).run(from, user.sub);
    if (!result.changes) return res.status(404).json({ error: 'Not found' });
    const fromSocket = discordIdToSocket[from];
    if (fromSocket) {
      const me = db.prepare('SELECT username, avatar FROM users WHERE discord_id = ?').get(user.sub);
      io.to(fromSocket).emit('friend-accepted', {
        by: { discord_id: user.sub, username: me?.username || user.username, avatar: me?.avatar || null }
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/friends/remove', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { other } = req.body;
  try {
    db.prepare('DELETE FROM friends WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').run(user.sub, other, other, user.sub);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ---- Profile endpoints ----
app.get('/profile/:discordId', (req, res) => {
  try {
    const row = db.prepare('SELECT discord_id, username, avatar, bio, status, social_links, beacon_url FROM users WHERE discord_id = ?').get(req.params.discordId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    let socialLinks = {};
    try { if (row.social_links) socialLinks = JSON.parse(row.social_links); } catch {}
    res.json({ ...row, social_links: socialLinks });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.put('/profile', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { bio, status, social_links } = req.body;
  const ALLOWED_KEYS = ['twitter', 'github', 'twitch', 'youtube', 'instagram'];
  let linksJson = null;
  if (social_links && typeof social_links === 'object') {
    const cleaned = {};
    for (const k of ALLOWED_KEYS) {
      if (social_links[k] && typeof social_links[k] === 'string') {
        cleaned[k] = social_links[k].trim().slice(0, 64).replace(/^@/, '');
      }
    }
    if (Object.keys(cleaned).length) linksJson = JSON.stringify(cleaned);
  }
  try {
    db.prepare('UPDATE users SET bio = ?, status = ?, social_links = ?, updated_at = unixepoch() WHERE discord_id = ?')
      .run((bio || '').slice(0, 160) || null, (status || '').slice(0, 60) || null, linksJson, user.sub);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ---- Block endpoints ----
app.get('/blocks', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(
      'SELECT b.blocked_id, u.username FROM blocks b LEFT JOIN users u ON u.discord_id = b.blocked_id WHERE b.blocker_id = ?'
    ).all(user.sub);
    res.json(rows.map(r => ({ discordId: r.blocked_id, username: r.username || null })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/blocks', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { blocked } = req.body;
  if (!blocked || blocked === user.sub) return res.status(400).json({ error: 'Invalid' });
  try {
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(user.sub, blocked);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.delete('/blocks', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const blockedId = req.query.blocked;
  if (!blockedId) return res.status(400).json({ error: 'Missing blocked param' });
  try {
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(user.sub, blockedId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ---- Room avatar-World spec (Stage 6 Phase 2b) ----
const ROOM_LEVEL_CAP = 12;                                 // max Levels in a room's World (Phase 6 cap)
const LEVEL_TYPES = new Set(['sandbox', 'life', 'stage']); // Level type tokens (life == generated; stage == host-authored)
const LEVEL_SIZES = new Set(['tiny', 'small', 'medium', 'large']);  // Phase 6 world size presets (mirror SIZE_PRESETS client-side)
// Playable WIDTH per preset (mirror of SIZE_PRESETS.w client-side; 'large' = full world). Generation is
// confined to this band (centred) + a margin so a small Level doesn't gen/save terrain it can't reach.
const SIZE_PRESET_W = { tiny: 1920, small: 3840, medium: 7680, large: MWSim.C.WORLD_W };
const SIZE_PRESET_H = { tiny: 1080, small: 1440, medium: 2160, large: MWSim.C.WORLD_H };   // mirror of SIZE_PRESETS.h client-side
const GEN_MARGIN = 1800;                              // px of decorative terrain generated beyond each wall
// env_spec stores the World's ordered Level list (type + display name) + nav mode. Terrain/object CONTENT
// stays host-local in v1 (hydrated live on entry), so the spec is public-safe metadata only.
function sanitizeEnvSpec(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.levels) || !raw.levels.length) return null;
  const levels = raw.levels.slice(0, ROOM_LEVEL_CAP).map((l, i) => {
    const out = {
      type: (l && LEVEL_TYPES.has(l.type)) ? l.type : 'sandbox',
      name: (l && typeof l.name === 'string' && l.name.trim()) ? l.name.trim().slice(0, 40) : ('Level ' + (i + 1)),
      size: (l && LEVEL_SIZES.has(l.size)) ? l.size : 'large',   // Phase 6 size preset (default = full world)
    };
    // Optional host-local content reference (Phase 2b follow-up): a pointer into the host's own
    // mw_levels store, NOT a terrain blob — members can't resolve it, so it stays public-safe metadata.
    if (l && l.src && typeof l.src.id === 'string' && l.src.id && Number.isInteger(l.src.lvl) && l.src.lvl >= 0) {
      out.src = { id: l.src.id.slice(0, 40), lvl: l.src.lvl };
    }
    // Optional saved background mode (0=Page,1=Canvas,2=Canvas-clear,3=Sky): travels in the public spec so
    // NON-host viewers of a saved Level get the right bg too (the host-local blob bg never reaches them).
    if (l && Number.isInteger(l.bg) && l.bg >= 0 && l.bg <= 3) out.bg = l.bg;
    return out;
  });
  return { levels, nav: (raw.nav === 'series') ? 'series' : 'free' };
}
function parseEnvSpec(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// ---- Private room endpoints ----
app.post('/rooms', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, description, public: isPublic, friendsOnly, scope, url, env_spec, levelLock, features, icon } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const id = generateRoomCode();
    const trimmedName = name.trim().slice(0, 40);
    const trimmedDesc = (description || '').trim().slice(0, 100) || null;
    // icon = emoji (short) OR image URL (longer); cap to keep the column small (no data: URLs).
    let roomIcon = (typeof icon === 'string' ? icon.trim() : '');
    if (/^data:/i.test(roomIcon)) roomIcon = '';        // reject inline data URLs (too big)
    roomIcon = roomIcon.slice(0, 512) || null;
    const pub = isPublic ? 1 : 0;
    // Friends-only is a non-public mode: visible/joinable to the owner's accepted friends, never listed publicly.
    const fr = (!isPublic && friendsOnly) ? 1 : 0;
    // A public room is bound to EITHER a page URL OR a site scope OR nothing (global) — mutually exclusive.
    const roomUrl = (isPublic && url) ? url.trim().slice(0, 500) : null;
    const roomScope = (isPublic && !roomUrl && scope) ? scope.trim().slice(0, 253) : null;
    const spec = sanitizeEnvSpec(env_spec);                // null = a plain chat room (no World)
    const kind = spec ? 'world' : null;
    // Phase 3: a World room sets per-Level build access at creation via `levelLock` (array of level
    // indices where building is disabled for non-owners; default = every Level buildable). The room-wide
    // `build` mode stays 'all' and the host can still flip it / grant individuals later. Stored in perms.
    let permsObj = null;
    if (spec && Array.isArray(levelLock)) {
      const lock = [...new Set(levelLock.filter(i => Number.isInteger(i) && i >= 0))];
      if (lock.length) permsObj = { build: 'all', levelLock: lock };
    }
    // Phase 4b: feature defaults chosen at creation — an array of feature keys restricted to host-only
    // before anyone joins. Hydrated lazily by getRoomFeatures() from perms.features (same shape as the
    // perms hub persists). Owner can still flip any of these later.
    if (Array.isArray(features) && features.length) {
      const feats = {};
      for (const k of features) if (FEATURE_KEYS.includes(k)) feats[k] = 'host';
      // 'build' is a Layer-2 feature stored on perms.build (not perms.features) — same as the perms hub.
      if (features.includes('build')) { permsObj = permsObj || {}; permsObj.build = 'host'; }
      if (Object.keys(feats).length) { permsObj = permsObj || {}; permsObj.features = feats; }
    }
    const perms = permsObj ? JSON.stringify(permsObj) : null;
    db.prepare('INSERT INTO rooms (id, name, owner_id, public, friends_only, scope, url, description, kind, env_spec, perms, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, trimmedName, user.sub, pub, fr, roomScope, roomUrl, trimmedDesc, kind, spec ? JSON.stringify(spec) : null, perms, roomIcon);
    db.prepare('INSERT INTO room_members (room_id, discord_id) VALUES (?, ?)').run(id, user.sub);
    res.json({ id, name: trimmedName, owner_id: user.sub, member_count: 1, public: pub, friends_only: fr, scope: roomScope, url: roomUrl, description: trimmedDesc, kind, env_spec: spec, icon: roomIcon });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Stable, collision-resistant room id derived from a hostname, so the auto-provisioned site room is a
// single canonical row per site (INSERT OR IGNORE keys off the primary id → idempotent, race-safe).
function siteRoomId(hostname) {
  let h = 5381;
  for (let i = 0; i < hostname.length; i++) h = ((h << 5) + h + hostname.charCodeAt(i)) >>> 0;
  return 'SITE' + h.toString(36).toUpperCase();
}
// Ensure the system-owned default room for `hostname` exists. Owner 'system' has no users row, so no one
// sees host/delete controls — it's undeletable and there's exactly one per site. It carries a default
// one-Level World so it behaves like any other public room (World button, avatars).
function ensureSiteRoom(hostname) {
  if (!hostname) return;
  const spec = JSON.stringify({ levels: [{ type: 'sandbox', name: 'Sandbox', size: 'large' }], nav: 'free' });
  db.prepare(`INSERT OR IGNORE INTO rooms (id, name, owner_id, public, friends_only, scope, url, description, kind, env_spec, perms, icon, last_active)
              VALUES (?, ?, 'system', 1, 0, ?, NULL, ?, NULL, ?, NULL, NULL, ?)`)
    .run(siteRoomId(hostname), hostname, hostname, 'Everyone browsing ' + hostname, spec, Date.now());
}
// Mark a room active now (bumped on enter + on each message) so idle Site rooms can be pruned by age.
function bumpRoomActive(roomId) {
  if (!roomId) return;
  try { db.prepare('UPDATE rooms SET last_active = ? WHERE id = ?').run(Date.now(), roomId); } catch {}
}
// Sweep idle auto-provisioned Site rooms (owner 'system') with no activity for SITE_ROOM_TTL_MS, plus their
// messages/members/social rows. User-created rooms are never touched.
const SITE_ROOM_TTL_MS = 60 * 24 * 60 * 60 * 1000;   // 60 days
function pruneIdleSiteRooms() {
  try {
    const cutoff = Date.now() - SITE_ROOM_TTL_MS;
    const stale = db.prepare(`SELECT id FROM rooms WHERE owner_id = 'system' AND COALESCE(last_active, 0) < ?`).all(cutoff);
    for (const { id } of stale) {
      for (const t of ['room_messages', 'room_members', 'room_favourites', 'room_likes', 'room_ratings']) {
        try { db.prepare(`DELETE FROM ${t} WHERE room_id = ?`).run(id); } catch {}
      }
      try { db.prepare('DELETE FROM rooms WHERE id = ?').run(id); } catch {}
    }
    if (stale.length) console.log('[prune] removed', stale.length, 'idle site rooms');
  } catch (e) { console.error('[prune]', e); }
}
setInterval(pruneIdleSiteRooms, 6 * 60 * 60 * 1000);   // every 6h
setTimeout(pruneIdleSiteRooms, 60 * 1000);             // once shortly after boot

app.get('/rooms/public', (req, res) => {
  const hostname = (req.query.hostname || '').trim().toLowerCase();
  const url = (req.query.url || '').trim();
  const caller = verifyToken(req);                       // optional — lets us include the caller's own state
  const me = caller ? caller.sub : '\x00';
  try {
    // Return every public room relevant to THIS page in one shot — bound to this exact URL, OR to this
    // site (scope=hostname, not URL-bound), OR global (no binding). The client buckets these into the
    // launcher's "This page" / "This site" / "Public" sub-tabs. (The default Site room isn't provisioned
    // here — it's created lazily on first ENTER via POST /rooms/site, so unused sites cost no storage.)
    const rows = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.public, r.scope, r.url, r.description, r.kind, r.env_spec, r.icon, r.perms,
             (SELECT username FROM users u WHERE u.discord_id = r.owner_id) as owner_name,
             (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) as member_count,
             (SELECT COUNT(*) FROM room_likes rl WHERE rl.room_id = r.id) as like_count,
             (SELECT COUNT(*) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_count,
             (SELECT COALESCE(AVG(stars), 0) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_avg,
             (SELECT 1 FROM room_favourites rf WHERE rf.room_id = r.id AND rf.discord_id = ?) as favourited,
             (SELECT 1 FROM room_likes rl2 WHERE rl2.room_id = r.id AND rl2.discord_id = ?) as liked,
             (SELECT stars FROM room_ratings rr2 WHERE rr2.room_id = r.id AND rr2.discord_id = ?) as my_rating
      FROM rooms r
      WHERE r.public = 1 AND (r.kind IS NULL OR r.kind != 'published') AND (
        r.url = ? OR
        (r.url IS NULL AND r.scope = ?) OR
        (r.url IS NULL AND r.scope IS NULL)
      )
      ORDER BY r.created_at DESC LIMIT 80
    `).all(me, me, me, url || '\x00', hostname || '');
    res.json(rows.map(normalizeRoomSocial));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Materialize + return this site's default room on first ENTER (create-on-enter — not on list — so unused
// sites cost no storage). Idempotent: INSERT OR IGNORE keyed on the deterministic per-hostname id.
app.post('/rooms/site', (req, res) => {
  const hostname = ((req.body && req.body.hostname) || '').trim().toLowerCase();
  if (!hostname) return res.status(400).json({ error: 'hostname required' });
  const caller = verifyToken(req);
  const me = caller ? caller.sub : '\x00';
  try {
    ensureSiteRoom(hostname);
    bumpRoomActive(siteRoomId(hostname));   // entering counts as activity → resets the idle-prune clock
    const row = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.public, r.scope, r.url, r.description, r.kind, r.env_spec, r.icon, r.perms,
             (SELECT username FROM users u WHERE u.discord_id = r.owner_id) as owner_name,
             (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) as member_count,
             (SELECT COUNT(*) FROM room_likes rl WHERE rl.room_id = r.id) as like_count,
             (SELECT COUNT(*) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_count,
             (SELECT COALESCE(AVG(stars), 0) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_avg,
             (SELECT 1 FROM room_favourites rf WHERE rf.room_id = r.id AND rf.discord_id = ?) as favourited,
             (SELECT 1 FROM room_likes rl2 WHERE rl2.room_id = r.id AND rl2.discord_id = ?) as liked,
             (SELECT stars FROM room_ratings rr2 WHERE rr2.room_id = r.id AND rr2.discord_id = ?) as my_rating
      FROM rooms r WHERE r.id = ?
    `).get(me, me, me, siteRoomId(hostname));
    if (!row) return res.status(500).json({ error: 'create failed' });
    res.json(normalizeRoomSocial(row));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// 🔥 Popular: public rooms across ALL pages/sites, ranked by who's in them RIGHT NOW. Lets you discover
// where on the web is active without visiting each URL (the binding URL/site comes back so the client
// shows where each room lives). Live counts come from the socket adapter, so we sort in JS after the query.
app.get('/rooms/popular', (req, res) => {
  const caller = verifyToken(req);                       // optional — lets us include the caller's own state
  const me = caller ? caller.sub : '\x00';
  try {
    const rows = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.scope, r.url, r.description, r.kind, r.env_spec, r.icon, r.perms,
             (SELECT username FROM users u WHERE u.discord_id = r.owner_id) as owner_name,
             (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) as member_count,
             (SELECT COUNT(*) FROM room_likes rl WHERE rl.room_id = r.id) as like_count,
             (SELECT COUNT(*) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_count,
             (SELECT COALESCE(AVG(stars), 0) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_avg,
             (SELECT 1 FROM room_favourites rf WHERE rf.room_id = r.id AND rf.discord_id = ?) as favourited,
             (SELECT 1 FROM room_likes rl2 WHERE rl2.room_id = r.id AND rl2.discord_id = ?) as liked,
             (SELECT stars FROM room_ratings rr2 WHERE rr2.room_id = r.id AND rr2.discord_id = ?) as my_rating
      FROM rooms r
      WHERE r.public = 1 AND (r.kind IS NULL OR r.kind != 'published')
      ORDER BY r.created_at DESC LIMIT 300
    `).all(me, me, me);
    const out = rows.map(normalizeRoomSocial);   // players_now/page_now attached centrally (identity-deduped)
    // Busiest first; ties broken by likes then membership. (Live presence is the headline signal.)
    out.sort((a, b) => (b.players_now - a.players_now) || (b.like_count - a.like_count) || (b.member_count - a.member_count));
    res.json(out.slice(0, 60));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/rooms', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.public, r.friends_only, r.scope, r.url, r.description, r.kind, r.env_spec, r.icon, r.perms,
             (SELECT username FROM users u WHERE u.discord_id = r.owner_id) as owner_name,
             (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) as member_count,
             (SELECT COUNT(*) FROM room_likes rl WHERE rl.room_id = r.id) as like_count,
             (SELECT COUNT(*) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_count,
             (SELECT COALESCE(AVG(stars), 0) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_avg,
             (SELECT 1 FROM room_favourites rf WHERE rf.room_id = r.id AND rf.discord_id = ?) as favourited,
             (SELECT 1 FROM room_likes rl2 WHERE rl2.room_id = r.id AND rl2.discord_id = ?) as liked,
             (SELECT stars FROM room_ratings rr2 WHERE rr2.room_id = r.id AND rr2.discord_id = ?) as my_rating
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id AND rm.discord_id = ?
      WHERE r.kind IS NULL OR r.kind != 'published'
      ORDER BY r.created_at ASC
    `).all(user.sub, user.sub, user.sub, user.sub);
    res.json(rows.map(normalizeRoomSocial));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Phase 3 — the caller's favourited rooms (full room objects, so the Favourites sub-tab can show rooms
// even when the user hasn't joined them). Same social columns as the other list reads.
app.get('/rooms/favourites', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.public, r.scope, r.url, r.description, r.kind, r.env_spec, r.icon, r.perms,
             (SELECT username FROM users u WHERE u.discord_id = r.owner_id) as owner_name,
             (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) as member_count,
             (SELECT COUNT(*) FROM room_likes rl WHERE rl.room_id = r.id) as like_count,
             (SELECT COUNT(*) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_count,
             (SELECT COALESCE(AVG(stars), 0) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_avg,
             1 as favourited,
             (SELECT 1 FROM room_likes rl2 WHERE rl2.room_id = r.id AND rl2.discord_id = ?) as liked,
             (SELECT stars FROM room_ratings rr2 WHERE rr2.room_id = r.id AND rr2.discord_id = ?) as my_rating
      FROM rooms r
      JOIN room_favourites fav ON fav.room_id = r.id AND fav.discord_id = ?
      WHERE r.kind IS NULL OR r.kind != 'published'
      ORDER BY fav.created_at DESC
    `).all(user.sub, user.sub, user.sub);
    // Favourited published Worlds (kind='published') are excluded above; fetch them in gallery shape so
    // the Faves tab can render a separate "Worlds" section alongside the "Rooms" section.
    const worlds = db.prepare(`SELECT ${WORLD_SOCIAL_COLS}, 1 as favourited
      FROM published_worlds w
      JOIN room_favourites fav ON fav.room_id = w.room_id AND fav.discord_id = ?
      LEFT JOIN rooms r ON r.id = w.room_id
      ORDER BY fav.created_at DESC`).all(user.sub, user.sub, user.sub);
    res.json({ rooms: rows.map(normalizeRoomSocial), worlds: worlds.map(mapWorldRow) });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Friends-only rooms the caller can access: ones they own, OR whose owner is an accepted friend. These
// never appear in the public listings — this is the only discovery path for them (drives the Friends sub-tab).
app.get('/rooms/friends', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(`
      SELECT r.id, r.name, r.owner_id, r.public, r.friends_only, r.scope, r.url, r.description, r.kind, r.env_spec, r.icon, r.perms,
             (SELECT username FROM users u WHERE u.discord_id = r.owner_id) as owner_name,
             (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) as member_count,
             (SELECT COUNT(*) FROM room_likes rl WHERE rl.room_id = r.id) as like_count,
             (SELECT COUNT(*) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_count,
             (SELECT COALESCE(AVG(stars), 0) FROM room_ratings rr WHERE rr.room_id = r.id) as rating_avg,
             (SELECT 1 FROM room_favourites rf WHERE rf.room_id = r.id AND rf.discord_id = ?) as favourited,
             (SELECT 1 FROM room_likes rl2 WHERE rl2.room_id = r.id AND rl2.discord_id = ?) as liked,
             (SELECT stars FROM room_ratings rr2 WHERE rr2.room_id = r.id AND rr2.discord_id = ?) as my_rating
      FROM rooms r
      WHERE r.friends_only = 1 AND (
        r.owner_id = ? OR
        r.owner_id IN (
          SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END
          FROM friends WHERE (from_id = ? OR to_id = ?) AND status='accepted'
        )
      )
      ORDER BY r.created_at DESC LIMIT 80
    `).all(user.sub, user.sub, user.sub, user.sub, user.sub, user.sub, user.sub);
    res.json(rows.map(normalizeRoomSocial));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/rooms/join', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  try {
    const room = db.prepare('SELECT id, name, owner_id, public, friends_only, scope, description, kind, env_spec, icon FROM rooms WHERE id = ?').get(code.toUpperCase().trim());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    // A friends-only room may only be joined by the owner or an accepted friend of the owner (this also
    // protects against someone guessing the code). Public/private-by-code rooms are unaffected.
    if (room.friends_only && room.owner_id !== user.sub && !areFriends(user.sub, room.owner_id)) {
      const alreadyMember = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND discord_id = ?').get(room.id, user.sub);
      if (!alreadyMember) return res.status(403).json({ error: 'friends_only' });
    }
    db.prepare('INSERT OR IGNORE INTO room_members (room_id, discord_id) VALUES (?, ?)').run(room.id, user.sub);
    const memberCount = db.prepare('SELECT COUNT(*) as c FROM room_members WHERE room_id = ?').get(room.id).c;
    res.json({ ...room, env_spec: parseEnvSpec(room.env_spec), member_count: memberCount });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/rooms/:id/leave', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  try {
    db.prepare('DELETE FROM room_members WHERE room_id = ? AND discord_id = ?').run(id, user.sub);
    const count = db.prepare('SELECT COUNT(*) as c FROM room_members WHERE room_id = ?').get(id).c;
    if (count === 0) {
      db.prepare('DELETE FROM room_messages WHERE room_id = ?').run(id);
      db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.delete('/rooms/:id', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  try {
    const room = db.prepare('SELECT owner_id FROM rooms WHERE id = ?').get(id);
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (room.owner_id !== user.sub) return res.status(403).json({ error: 'Not owner' });
    db.prepare('DELETE FROM room_messages WHERE room_id = ?').run(id);
    db.prepare('DELETE FROM room_members WHERE room_id = ?').run(id);
    db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ---- Phase 3: room social signals (favourite / like / rating) ----
// All return the room's fresh aggregates + the caller's own state via roomSocial().
function requireRoom(req, res) {
  const user = verifyToken(req);
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) { res.status(404).json({ error: 'Room not found' }); return null; }
  return user;
}

app.post('/rooms/:id/favourite', (req, res) => {
  const user = requireRoom(req, res); if (!user) return;
  try {
    db.prepare('INSERT OR IGNORE INTO room_favourites (discord_id, room_id) VALUES (?, ?)').run(user.sub, req.params.id);
    res.json(roomSocial(req.params.id, user.sub));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});
app.delete('/rooms/:id/favourite', (req, res) => {
  const user = requireRoom(req, res); if (!user) return;
  try {
    db.prepare('DELETE FROM room_favourites WHERE discord_id = ? AND room_id = ?').run(user.sub, req.params.id);
    res.json(roomSocial(req.params.id, user.sub));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/rooms/:id/like', (req, res) => {
  const user = requireRoom(req, res); if (!user) return;
  try {
    db.prepare('INSERT OR IGNORE INTO room_likes (discord_id, room_id) VALUES (?, ?)').run(user.sub, req.params.id);
    res.json(roomSocial(req.params.id, user.sub));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});
app.delete('/rooms/:id/like', (req, res) => {
  const user = requireRoom(req, res); if (!user) return;
  try {
    db.prepare('DELETE FROM room_likes WHERE discord_id = ? AND room_id = ?').run(user.sub, req.params.id);
    res.json(roomSocial(req.params.id, user.sub));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/rooms/:id/rating', (req, res) => {
  const user = requireRoom(req, res); if (!user) return;
  const stars = Math.round(Number(req.body && req.body.stars));
  if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'stars must be 1–5' });
  try {
    db.prepare('INSERT INTO room_ratings (discord_id, room_id, stars, updated_at) VALUES (?, ?, ?, unixepoch()) ON CONFLICT(discord_id, room_id) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at')
      .run(user.sub, req.params.id, stars);
    res.json(roomSocial(req.params.id, user.sub));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});
app.delete('/rooms/:id/rating', (req, res) => {
  const user = requireRoom(req, res); if (!user) return;
  try {
    db.prepare('DELETE FROM room_ratings WHERE discord_id = ? AND room_id = ?').run(user.sub, req.params.id);
    res.json(roomSocial(req.params.id, user.sub));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ---- Phase 7: published Worlds (gallery + publish/update/remix/unpublish) ----
// Publish a new World or update an existing one (re-publish). Backed by a public room (kind='published')
// that's hidden from the launcher and surfaced only in the gallery.
app.post('/worlds', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { worldId, name, description, author, content, thumb, allow_remix, durability } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const levels = validatePublishContent(content);
  if (!levels) return res.status(400).json({ error: 'Invalid World content' });
  const contentStr = JSON.stringify(levels);
  if (contentStr.length > PUBLISHED_MAX_BYTES) return res.status(413).json({ error: 'World too large to publish' });
  const trimmedName = name.trim().slice(0, 40);
  const trimmedDesc = (description || '').trim().slice(0, 200) || null;
  const trimmedAuthor = (author || '').trim().slice(0, 40) || null;
  const thumbStr = (typeof thumb === 'string' && thumb.length <= PUBLISHED_THUMB_MAX) ? thumb : null;
  const remix = allow_remix ? 1 : 0;
  const dura = (durability === 'persistent') ? 'persistent' : 'showcase';
  try {
    const existing = worldId ? db.prepare('SELECT * FROM published_worlds WHERE id = ?').get(worldId) : null;
    if (existing) {                                                  // ---- update / re-publish ----
      if (existing.owner_id !== user.sub) return res.status(403).json({ error: 'Not owner' });
      const spec = derivePubEnvSpec(levels, existing.id);
      db.prepare(`UPDATE published_worlds SET name=?, author=?, description=?, thumb=?, content=?, level_count=?, size_bytes=?, allow_remix=?, durability=?, live_state=NULL, updated_at=unixepoch() WHERE id=?`)
        .run(trimmedName, trimmedAuthor, trimmedDesc, thumbStr, contentStr, levels.length, contentStr.length, remix, dura, existing.id);
      db.prepare('UPDATE rooms SET name=?, env_spec=? WHERE id=?').run(trimmedName, JSON.stringify(spec), existing.room_id);
      return res.json({ worldId: existing.id, roomId: existing.room_id, level_count: levels.length, env_spec: spec });
    }
    // ---- new publish: enforce per-user cap, mint ids, create the backing room ----
    const count = db.prepare('SELECT COUNT(*) as c FROM published_worlds WHERE owner_id = ?').get(user.sub).c;
    if (count >= PUBLISHED_PER_USER) return res.status(409).json({ error: 'Published-World limit reached (' + PUBLISHED_PER_USER + ')' });
    const id = genWorldId();
    const roomId = generateRoomCode();
    const spec = derivePubEnvSpec(levels, id);
    db.prepare('INSERT INTO rooms (id, name, owner_id, public, kind, env_spec) VALUES (?, ?, ?, 1, \'published\', ?)').run(roomId, trimmedName, user.sub, JSON.stringify(spec));
    db.prepare('INSERT INTO room_members (room_id, discord_id) VALUES (?, ?)').run(roomId, user.sub);
    db.prepare(`INSERT INTO published_worlds (id, owner_id, room_id, name, author, description, thumb, content, level_count, size_bytes, allow_remix, durability) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, user.sub, roomId, trimmedName, trimmedAuthor, trimmedDesc, thumbStr, contentStr, levels.length, contentStr.length, remix, dura);
    res.json({ worldId: id, roomId, level_count: levels.length, env_spec: spec });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Gallery list (public): metadata only, no content blob. play_count is the lifetime enter count;
// players_now is the live presence in the backing room (its 'pg:'+roomId bucket — see resolvePresenceRoom).
app.get('/worlds', (req, res) => {
  const caller = verifyToken(req);                       // optional — lets us include the caller's own state
  const me = caller ? caller.sub : '\x00';
  try {
    // Published Worlds are backed by a public rooms row (kind='published'), so the same room_likes /
    // room_ratings / room_favourites tables (keyed by room_id) drive their social signals, and r.perms
    // drives the per-Layer "features for non-hosts" summary.
    const rows = db.prepare(`SELECT ${WORLD_SOCIAL_COLS},
        (SELECT 1 FROM room_favourites rf WHERE rf.room_id = w.room_id AND rf.discord_id = ?) as favourited
      FROM published_worlds w LEFT JOIN rooms r ON r.id = w.room_id ORDER BY w.updated_at DESC LIMIT 120`).all(me, me, me);
    res.json(rows.map(mapWorldRow));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Lifetime enter counter — public (entering a World needs no login). Best-effort; ignores unknown ids.
app.post('/worlds/:id/play', (req, res) => {
  try { db.prepare('UPDATE published_worlds SET play_count = play_count + 1 WHERE id = ?').run(req.params.id); } catch (e) {}
  res.json({ ok: true });
});

// Owner-only flag update (allow_remix / durability) without re-uploading content. Switching to Showcase
// drops any saved live_state so the World reverts to its published baseline on the next hydrate.
app.post('/worlds/:id/flags', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const w = db.prepare('SELECT owner_id FROM published_worlds WHERE id = ?').get(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.owner_id !== user.sub) return res.status(403).json({ error: 'Not owner' });
    const { allow_remix, durability } = req.body || {};
    if (allow_remix !== undefined) db.prepare('UPDATE published_worlds SET allow_remix = ? WHERE id = ?').run(allow_remix ? 1 : 0, req.params.id);
    if (durability !== undefined) {
      const dura = (durability === 'persistent') ? 'persistent' : 'showcase';
      db.prepare('UPDATE published_worlds SET durability = ?' + (dura === 'showcase' ? ', live_state = NULL' : '') + ' WHERE id = ?').run(dura, req.params.id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Full content for a remix download — gated by allow_remix unless the requester owns it.
app.get('/worlds/:id', (req, res) => {
  try {
    const w = db.prepare('SELECT * FROM published_worlds WHERE id = ?').get(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    const user = verifyToken(req);
    const isOwner = !!(user && user.sub === w.owner_id);
    if (!w.allow_remix && !isOwner) return res.status(403).json({ error: 'Remix not allowed' });
    res.json({ id: w.id, name: w.name, author: w.author, description: w.description, level_count: w.level_count,
               allow_remix: !!w.allow_remix, durability: w.durability, content: JSON.parse(w.content) });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Unpublish — owner only. Drops the content + tears down the backing room.
app.delete('/worlds/:id', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const w = db.prepare('SELECT owner_id, room_id FROM published_worlds WHERE id = ?').get(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.owner_id !== user.sub) return res.status(403).json({ error: 'Not owner' });
    db.prepare('DELETE FROM published_worlds WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM room_members WHERE room_id = ?').run(w.room_id);
    db.prepare('DELETE FROM room_messages WHERE room_id = ?').run(w.room_id);
    db.prepare('DELETE FROM rooms WHERE id = ?').run(w.room_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ---- Shared animation library (custom animated emotes) ----
// Upload or update one of the caller's shared animations. Body: { id?, title, author?, loop, segments }.
app.post('/animations', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const body = req.body || {};
  const v = validateAnimSpec(body);
  if (!v) return res.status(400).json({ error: 'Invalid animation' });
  const title = (body.title || '').trim().slice(0, 40) || 'Untitled';
  const authorName = (body.author || '').trim().slice(0, 40) || null;
  try {
    const existing = body.id ? db.prepare('SELECT author_id FROM shared_animations WHERE id = ?').get(body.id) : null;
    if (existing) {                                                  // ---- update an existing share ----
      if (existing.author_id !== user.sub) return res.status(403).json({ error: 'Not author' });
      db.prepare('UPDATE shared_animations SET title=?, author_name=?, spec=?, seg_count=?, has_image=?, size_bytes=? WHERE id=?')
        .run(title, authorName, v.spec, v.segCount, v.hasImage, v.size, body.id);
      return res.json({ id: body.id });
    }
    const count = db.prepare('SELECT COUNT(*) as c FROM shared_animations WHERE author_id = ?').get(user.sub).c;
    if (count >= SHARED_ANIM_PER_USER) return res.status(409).json({ error: 'Shared-animation limit reached (' + SHARED_ANIM_PER_USER + ')' });
    const id = genAnimId();
    db.prepare('INSERT INTO shared_animations (id, author_id, author_name, title, spec, seg_count, has_image, size_bytes) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, user.sub, authorName, title, v.spec, v.segCount, v.hasImage, v.size);
    res.json({ id });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Browse/search the library (public). Returns metadata + full spec — small enough to preview inline.
app.get('/animations', (req, res) => {
  const caller = verifyToken(req);
  const me = caller ? caller.sub : '\x00';
  const order = req.query.sort === 'popular' ? 'downloads DESC, created_at DESC' : 'created_at DESC';
  const q = (req.query.q || '').toString().trim().slice(0, 40);
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const PER = 30;
  try {
    const rows = q
      ? db.prepare('SELECT id, author_id, author_name, title, spec, seg_count, has_image, downloads, created_at FROM shared_animations WHERE title LIKE ? ORDER BY ' + order + ' LIMIT ? OFFSET ?').all('%' + q + '%', PER, page * PER)
      : db.prepare('SELECT id, author_id, author_name, title, spec, seg_count, has_image, downloads, created_at FROM shared_animations ORDER BY ' + order + ' LIMIT ? OFFSET ?').all(PER, page * PER);
    res.json(rows.map(r => ({
      id: r.id, title: r.title, author: r.author_name, mine: r.author_id === me,
      seg_count: r.seg_count, has_image: !!r.has_image, downloads: r.downloads,
      created_at: r.created_at, spec: JSON.parse(r.spec),
    })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Bump the download counter (best-effort; called when a user adds a shared animation to their local library).
app.post('/animations/:id/download', (req, res) => {
  try { db.prepare('UPDATE shared_animations SET downloads = downloads + 1 WHERE id = ?').run(req.params.id); } catch (e) {}
  res.json({ ok: true });
});

// Remove one of the caller's shared animations — author only.
app.delete('/animations/:id', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const a = db.prepare('SELECT author_id FROM shared_animations WHERE id = ?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.author_id !== user.sub) return res.status(403).json({ error: 'Not author' });
    db.prepare('DELETE FROM shared_animations WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ---- Face pictures ----
// ⭐⭐ AN APPEARANCE IS A BROADCAST, WHICH IS THE WHOLE REASON THIS TABLE EXISTS. A face is sent to every peer
// in the room whenever it changes and again every two seconds, so bytes carried inside it are bytes paid for
// over and over. Every other image in this project is fetched ON DEMAND — a custom emote when somebody presses
// the key, a shared animation when somebody browses the library — and a picture worn as a face feature is the
// same shape of thing. So the feature carries a short id, about twenty bytes, and the bytes live here.
// ⭐ CONTENT-ADDRESSED: the id IS the hash of the bytes, so the same eye pasted by twelve people is one row,
// re-pasting something already here costs no row at all, and a stored picture can be cached for ever by id
// because that id can never come to describe different bytes.
// ⚠️ THE CLIENT SHRINKS THE PICTURE BEFORE IT GETS HERE (a face feature is drawn a few dozen pixels across, so
// it is re-encoded into a small box first). This cap is the backstop for a client that did not, not the budget
// a well-behaved one aims at.
// ⭐⭐ THE BUDGET IS IN BYTES, NOT ROWS, BECAUSE BYTES ARE WHAT RUNS OUT. A row cap sounds like a limit and is
// not one: 20,000 rows at 64KB each is 1.3GB, and nothing about "20,000" says that. One number, in megabytes,
// is the thing that can actually be reasoned about — and it is the number to raise if this ever fills up.
// ⚠️ THIS IS THE ONLY PLACE THIS PROJECT HOSTS USER BYTES AT ALL. Emoji and sound libraries store links; the
// shared face library below stores drawings, which are our own format and tiny. Pictures are here because a
// PASTED image has no address to link to — there is no other way to offer paste — so the cost is bounded here
// instead, by shrinking every picture in the client first, by de-duplicating on content, and by this cap.
const FACE_IMG_BUDGET   = 64 * 1024 * 1024;   // 64MB for every face picture on this server, all users together
const FACE_IMG_MAX_BYTES = 40_000;   // length of one data: URL. A 256px WebP is well under; this is the backstop.
const FACE_IMG_PER_USER  = 60;       // how many distinct pictures one signed-in user may store
// ⚠️ FALSE BECAUSE THIS SERVER IS LOCAL. Uploading is allowed without signing in, because requiring a Discord
// login to paste an eye onto your own face would make the feature unusable on a machine nobody has logged in
// on. Flip this to true if this server is ever put on the public internet: an upload with no author has no
// handle for a takedown, which is the reason every other user-content route here demands a token.
const FACE_IMG_REQUIRE_AUTH = false;

db.exec(`CREATE TABLE IF NOT EXISTS face_images (
  id TEXT PRIMARY KEY,
  author_id TEXT,
  data TEXT NOT NULL,
  bytes INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
)`);

// Store one picture and return the id to wear. Idempotent by construction — the same bytes give the same id.
app.post('/face-images', (req, res) => {
  const user = verifyToken(req);
  if (!user && FACE_IMG_REQUIRE_AUTH) return res.status(401).json({ error: 'Unauthorized' });
  const data = (req.body && req.body.data) || '';
  // ⚠️ THE PREFIX IS CHECKED, NOT JUST THE LENGTH. This string is handed straight back to other people's
  // browsers and assigned to an <img>, so "it is an image data URL" has to be true of it, not merely likely.
  if (typeof data !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) {
    return res.status(400).json({ error: 'Not an image' });
  }
  if (data.length > FACE_IMG_MAX_BYTES) return res.status(413).json({ error: 'Picture too large' });
  try {
    const id = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
    if (db.prepare('SELECT id FROM face_images WHERE id = ?').get(id)) return res.json({ id, deduped: true });
    const used = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM face_images').get().b;
    if (used + data.length > FACE_IMG_BUDGET) return res.status(507).json({ error: 'Picture store full' });
    if (user) {
      const mine = db.prepare('SELECT COUNT(*) AS c FROM face_images WHERE author_id = ?').get(user.sub).c;
      if (mine >= FACE_IMG_PER_USER) return res.status(409).json({ error: 'Picture limit reached (' + FACE_IMG_PER_USER + ')' });
    }
    db.prepare('INSERT INTO face_images (id, author_id, data, bytes) VALUES (?,?,?,?)')
      .run(id, user ? user.sub : null, data, data.length);
    res.json({ id });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Fetch one, by the id a peer is wearing. Public: you have to be able to see the faces of people you meet.
// ⚠️ TEXT, NOT BINARY, and that is forced rather than chosen — the extension cannot reach this server from the
// page, so every response comes back through the background broker, which relays a body as TEXT. A data URL is
// a picture that survives that trip.
app.get('/face-images/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT id, data FROM face_images WHERE id = ?').get(String(req.params.id || '').slice(0, 32));
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'public, max-age=31536000, immutable');   // the id is the hash, so this can never go stale
    res.json({ id: row.id, data: row.data });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Remove one of the caller's own pictures. Anyone wearing it stops seeing it, which is the point of a takedown.
app.delete('/face-images/:id', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const row = db.prepare('SELECT author_id FROM face_images WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.author_id !== user.sub) return res.status(403).json({ error: 'Not author' });
    db.prepare('DELETE FROM face_images WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/rooms/:id/messages', (req, res) => {
  const { id } = req.params;
  try {
    const room = db.prepare('SELECT public FROM rooms WHERE id = ?').get(id);
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (!room.public) {
      const user = verifyToken(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const member = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND discord_id = ?').get(id, user.sub);
      if (!member) return res.status(403).json({ error: 'Not a member' });
    }
    const rows = db.prepare(`
      SELECT rm.id, rm.from_discord_id, u.username, rm.text, rm.sent_at
      FROM room_messages rm
      LEFT JOIN users u ON u.discord_id = rm.from_discord_id
      WHERE rm.room_id = ?
      ORDER BY rm.sent_at ASC LIMIT 100
    `).all(id);
    res.json(rows.map(r => ({ id: r.id, fromDiscordId: r.from_discord_id, username: r.username || 'Unknown', text: r.text, ts: r.sent_at })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ---- Groups endpoints ----
app.post('/groups', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, description, open } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const id = generateGroupCode();
    const trimmedName = name.trim().slice(0, 40);
    const trimmedDesc = (description || '').trim().slice(0, 100) || null;
    const isOpen = open ? 1 : 0;
    db.prepare('INSERT INTO groups (id, name, description, owner_id, open) VALUES (?, ?, ?, ?, ?)').run(id, trimmedName, trimmedDesc, user.sub, isOpen);
    db.prepare('INSERT INTO group_members (group_id, discord_id, role) VALUES (?, ?, ?)').run(id, user.sub, 'owner');
    res.json({ id, name: trimmedName, description: trimmedDesc, owner_id: user.sub, open: isOpen, member_count: 1, role: 'owner' });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/groups', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(`
      SELECT g.id, g.name, g.description, g.owner_id, g.open, gm.role,
             (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) as member_count
      FROM groups g
      JOIN group_members gm ON gm.group_id = g.id AND gm.discord_id = ?
      ORDER BY g.created_at ASC
    `).all(user.sub);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/groups/search', (req, res) => {
  const q = (req.query.q || '').trim().slice(0, 40);
  try {
    const rows = db.prepare(`
      SELECT g.id, g.name, g.description, g.open,
             (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) as member_count
      FROM groups g WHERE g.open = 1 AND g.name LIKE ?
      ORDER BY member_count DESC LIMIT 20
    `).all('%' + q + '%');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Search users by (partial) username so you can add friends without sharing a room. Returns each match's
// current friend relationship to the caller so the UI can show Add / Pending / Friends.
app.get('/users/search', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const rows = db.prepare(`
      SELECT discord_id, username, avatar,
             (SELECT status FROM friends f WHERE (f.from_id=? AND f.to_id=users.discord_id) OR (f.to_id=? AND f.from_id=users.discord_id) LIMIT 1) as friend_status,
             (SELECT from_id FROM friends f WHERE (f.from_id=? AND f.to_id=users.discord_id) OR (f.to_id=? AND f.from_id=users.discord_id) LIMIT 1) as friend_from
      FROM users
      WHERE username LIKE ? COLLATE NOCASE AND discord_id != ?
      ORDER BY (username = ? COLLATE NOCASE) DESC, LENGTH(username) ASC
      LIMIT 20
    `).all(user.sub, user.sub, user.sub, user.sub, '%' + q + '%', user.sub, q);
    res.json(rows.map(r => ({
      discord_id: r.discord_id, username: r.username, avatar: r.avatar || null,
      // 'friends' | 'pending-out' (I sent) | 'pending-in' (they sent) | null (none)
      relation: !r.friend_status ? null : (r.friend_status === 'accepted' ? 'friends' : (r.friend_from === user.sub ? 'pending-out' : 'pending-in')),
    })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/users/by-username', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const username = (req.query.username || '').trim();
  if (!username) return res.status(400).json({ error: 'Missing username' });
  try {
    const row = db.prepare('SELECT discord_id FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json({ discordId: row.discord_id });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/groups/join', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  try {
    const group = db.prepare('SELECT id, name, description, owner_id, open FROM groups WHERE id = ?').get(code.toUpperCase().trim());
    if (!group) return res.status(404).json({ error: 'Group not found' });
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, discord_id, role) VALUES (?, ?, ?)').run(group.id, user.sub, 'member');
    const memberCount = db.prepare('SELECT COUNT(*) as c FROM group_members WHERE group_id = ?').get(group.id).c;
    const role = db.prepare('SELECT role FROM group_members WHERE group_id = ? AND discord_id = ?').get(group.id, user.sub)?.role || 'member';
    res.json({ ...group, member_count: memberCount, role });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/groups/:id/leave', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  try {
    const group = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(id);
    if (!group) return res.status(404).json({ error: 'Not found' });
    if (group.owner_id === user.sub) return res.status(400).json({ error: 'Owner cannot leave — delete the group instead' });
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND discord_id = ?').run(id, user.sub);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.delete('/groups/:id', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  try {
    const group = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(id);
    if (!group) return res.status(404).json({ error: 'Not found' });
    if (group.owner_id !== user.sub) return res.status(403).json({ error: 'Not owner' });
    db.prepare('DELETE FROM group_messages WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/groups/:id/messages', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  try {
    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND discord_id = ?').get(id, user.sub);
    if (!member) return res.status(403).json({ error: 'Not a member' });
    const rows = db.prepare(`
      SELECT gm.from_discord_id, u.username, gm.text, gm.sent_at
      FROM group_messages gm
      LEFT JOIN users u ON u.discord_id = gm.from_discord_id
      WHERE gm.group_id = ? ORDER BY gm.sent_at ASC LIMIT 100
    `).all(id);
    res.json(rows.map(r => ({ fromDiscordId: r.from_discord_id, username: r.username || 'Unknown', text: r.text, ts: r.sent_at })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/groups/:id/members', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  try {
    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND discord_id = ?').get(id, user.sub);
    if (!member) return res.status(403).json({ error: 'Not a member' });
    const rows = db.prepare(`
      SELECT gm.discord_id, gm.role, u.username, u.avatar
      FROM group_members gm
      LEFT JOIN users u ON u.discord_id = gm.discord_id
      WHERE gm.group_id = ?
      ORDER BY CASE gm.role WHEN 'owner' THEN 0 ELSE 1 END, gm.joined_at ASC
    `).all(id);
    res.json(rows.map(r => ({ discordId: r.discord_id, role: r.role, username: r.username || 'Unknown', avatar: r.avatar, online: !!discordIdToSocket[r.discord_id] })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.delete('/groups/:id/members/:discordId', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { id, discordId } = req.params;
  try {
    const group = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(id);
    if (!group) return res.status(404).json({ error: 'Not found' });
    if (group.owner_id !== user.sub) return res.status(403).json({ error: 'Not owner' });
    if (discordId === user.sub) return res.status(400).json({ error: 'Cannot kick yourself' });
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND discord_id = ?').run(id, discordId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// ---- Follow settings & follows endpoints ----
app.get('/follow-settings', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const row = db.prepare('SELECT follow_policy, follow_allowlist, browsing_visible FROM users WHERE discord_id = ?').get(user.sub);
    if (!row) return res.status(404).json({ error: 'User not found' });
    const allowlistIds = (row.follow_allowlist || '').split(',').filter(Boolean);
    let allowlist = [];
    if (allowlistIds.length) {
      const placeholders = allowlistIds.map(() => '?').join(',');
      allowlist = db.prepare(`SELECT discord_id, username FROM users WHERE discord_id IN (${placeholders})`).all(...allowlistIds)
        .map(r => ({ discordId: r.discord_id, username: r.username }));
    }
    res.json({ follow_policy: row.follow_policy || 'friends', browsing_visible: !!row.browsing_visible, allowlist });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.put('/follow-settings', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { follow_policy, browsing_visible, allowlist } = req.body;
  const validPolicies = ['anyone', 'friends', 'specific', 'nobody'];
  try {
    const updates = [];
    const params = [];
    if (follow_policy !== undefined) {
      if (!validPolicies.includes(follow_policy)) return res.status(400).json({ error: 'Invalid policy' });
      updates.push('follow_policy = ?'); params.push(follow_policy);
    }
    if (browsing_visible !== undefined) {
      updates.push('browsing_visible = ?'); params.push(browsing_visible ? 1 : 0);
    }
    if (allowlist !== undefined) {
      const ids = Array.isArray(allowlist) ? allowlist.map(a => a.discordId).filter(Boolean).join(',') : '';
      updates.push('follow_allowlist = ?'); params.push(ids);
    }
    if (!updates.length) return res.json({ ok: true });
    params.push(user.sub);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE discord_id = ?`).run(...params);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.post('/follows', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { followeeDiscordId } = req.body;
  if (!followeeDiscordId || followeeDiscordId === user.sub) return res.status(400).json({ error: 'Invalid' });
  try {
    const followee = db.prepare('SELECT discord_id, follow_policy, follow_allowlist FROM users WHERE discord_id = ?').get(followeeDiscordId);
    if (!followee) return res.status(404).json({ error: 'User not found' });
    const policy = followee.follow_policy || 'friends';
    if (policy === 'nobody') return res.status(403).json({ error: 'user_blocks_follow' });
    if (policy === 'friends') {
      const friendship = db.prepare(
        `SELECT 1 FROM friends WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) AND status='accepted'`
      ).get(user.sub, followeeDiscordId, followeeDiscordId, user.sub);
      if (!friendship) return res.status(403).json({ error: 'friends_only' });
    }
    if (policy === 'specific') {
      const allowed = (followee.follow_allowlist || '').split(',').includes(user.sub);
      if (!allowed) return res.status(403).json({ error: 'not_on_allowlist' });
    }
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)').run(user.sub, followeeDiscordId);
    // Notify followee they have a new follower
    const followeeSocks = discordIdToFollowSockets[followeeDiscordId];
    if (followeeSocks) {
      const followerUser = db.prepare('SELECT username FROM users WHERE discord_id = ?').get(user.sub);
      followeeSocks.forEach(sid => io.to(sid).emit('persistent-follow-start', { followerDiscordId: user.sub, username: followerUser?.username || user.username }));
    }
    // Immediately send the followee's current tab snapshot to the new follower's tabs so
    // following takes effect right away (don't wait for the followee to next navigate).
    const followeeUser = db.prepare('SELECT username FROM users WHERE discord_id = ?').get(followeeDiscordId);
    const followerSocks = discordIdToFollowSockets[user.sub];
    if (followerSocks) followerSocks.forEach(sid => emitSnapshotToFollower(followeeDiscordId, followeeUser?.username, sid));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.delete('/follows/:followeeDiscordId', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(user.sub, req.params.followeeDiscordId);
    // Notify followee on all their tabs
    const followeeSocks = discordIdToFollowSockets[req.params.followeeDiscordId];
    if (followeeSocks) followeeSocks.forEach(sid => io.to(sid).emit('persistent-follow-end', { followerDiscordId: user.sub }));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/follows/followers', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(`
      SELECT f.follower_id, u.username, u.avatar
      FROM follows f JOIN users u ON u.discord_id = f.follower_id
      WHERE f.followee_id = ?
    `).all(user.sub);
    res.json(rows.map(r => ({ discordId: r.follower_id, username: r.username, avatar: r.avatar })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.delete('/follows/by-follower/:followerDiscordId', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { followerDiscordId } = req.params;
  try {
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(followerDiscordId, user.sub);
    const followerSocks = discordIdToFollowSockets[followerDiscordId];
    if (followerSocks) followerSocks.forEach(sid => io.to(sid).emit('follow-kicked', { followeeDiscordId: user.sub }));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/follows', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = db.prepare(`
      SELECT f.followee_id, u.username, u.avatar, u.browsing_visible
      FROM follows f JOIN users u ON u.discord_id = f.followee_id
      WHERE f.follower_id = ?
    `).all(user.sub);
    res.json(rows.map(r => ({
      discordId: r.followee_id,
      username: r.username,
      avatar: r.avatar,
      currentUrl: r.browsing_visible ? (discordIdToFullUrl[r.followee_id] || null) : null
    })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.delete('/dms', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const withId = req.query.with;
  if (!withId) return res.status(400).json({ error: 'Missing with param' });
  try {
    db.prepare('DELETE FROM dm_messages WHERE (from_discord_id=? AND to_discord_id=?) OR (from_discord_id=? AND to_discord_id=?)').run(user.sub, withId, withId, user.sub);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/dms', (req, res) => {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const withId = req.query.with;
  if (!withId) return res.status(400).json({ error: 'Missing with param' });
  try {
    const rows = db.prepare(`
      SELECT from_discord_id, text, sent_at FROM dm_messages
      WHERE (from_discord_id=? AND to_discord_id=?) OR (from_discord_id=? AND to_discord_id=?)
      ORDER BY sent_at ASC LIMIT 200
    `).all(user.sub, withId, withId, user.sub);
    res.json(rows.map(r => ({ fromDiscordId: r.from_discord_id, text: r.text, ts: r.sent_at })));
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

const roomUsers = {};       // roomId → { socketId: { username, verified, avatar, discord_id } }
// People on a PAGE regardless of which context Room they're in. Keyed by the bare URL room
// (every page socket joins that room) so we can show a page-wide headcount alongside the
// room-scoped presence (roomUsers, which follows the context Room bucket).
const pageUsers = {};       // bareUrlRoom → { socketId: { username, discord_id } }
const roomHistory = {};
const roomMsgReactions = {}; // roomId → { msgId → { emoji → [username] } }
const roomAnnotations = {};
const roomSprays = {};
const roomMedia = {};
const roomCanvases = {}; // `${roomId}:${scope}` → { strokes: Map<id,stroke>, stamps: [] }
const MAX_CANVAS_ITEMS = 200;
const roomAvatars = {}; // legacy (old position-broadcast model; kept for back-compat)
const roomAvt = {};     // room → Set<socketId> in the avatar P2P DataChannel mesh (Stage 6 pivot)
const roomObjects = {}; // room → Map<objId,obj>  (Stage 6 environment props; in-memory, persist till restart)
let objSeq = 0;
// ---- Dropped material (dig → item on the ground → inventory) ----
// One drop per dig swing, not one per cell: a 7×7 bite is a single entity carrying its composition, which is
// what keeps this affordable at Overworld scale. The server owns the LIST (so two players cannot both collect
// the same pile) but not the FALL — it resolves the resting row once, at spawn, by scanning down to the first
// solid cell, and every client animates the drop from spawn to rest itself. That means one message per drop
// for its whole life, and no per-tick position stream.
const roomDrops = {};   // room → Map<dropId, drop>   drop = { id, x, y, gy, t0, mats:[[matId,count],…], n }
let dropSeq = 0;
const MAX_DROPS_PER_ROOM = 300;    // oldest are culled first; a pile of drops is litter, not state worth keeping
const DROP_TTL_MS = 4 * 60 * 1000; // un-collected material rots away, so a dug-out area does not accumulate forever
const DROP_FALL_MAX_CELLS = 96;    // how far down the resting scan looks — bounded because the scan can FAULT PAGES IN (see dropRestY)
const MAX_OBJECTS_PER_ROOM = 150;  // Phase 6: per-Level cap on USER-placed objects (generated 'world-' scatter exempt); mirrors client OBJECT_CAP. Over-cap spawns are rejected.
const OBJ_TYPES = new Set(['platform', 'stamp', 'stroke', 'checkpoint', 'goal', 'spawn', 'portal']); // unified primitives (platform absorbs pad/ramp/conveyor/booster/fan/movplat as modifiers); checkpoint/goal/spawn/portal = non-solid flags (respawn anchor / Level exit / shared entry / paired teleporter)
const SURF_TYPES = ['ice', 'mud', 'hazard'];      // contact-property surface modifiers (Inc 10)
const clampN = (v, lo, hi, dflt) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : dflt;

// ---- Destructible terrain (Tier C) -----------------------------------------
// A coarse solidity grid per room — a raster mask at TERRAIN_CELL resolution (0 empty / 1 solid).
// Server-authoritative EXISTENCE (paint/carve ops are applied here then rebroadcast so every client
// rasterizes identically); collision response is client-local like every other Stage-6 object.
// Fixed-size (no op-log growth, no snapshot problem); synced to late joiners run-length-encoded
// (terrain is mostly empty → tiny). Cleared on the debug clear-all. Persist till restart.
// ALL-FINE (2026-07-26): terrain cell was 24px; now 8px so terrain matches the fine-liquid resolution
// (grid 640×135 → 1920×405). Reactions/dig/collision/render become fine-granular. The fine-liquid subsystem
// is now THE liquid path (ratio 1 = one liquid cell per terrain cell), gated by liquidCfg.fine (always on;
// git branch is the A/B). 1 stays as the ratio and is 1 everywhere now.
const TERRAIN_CELL = 8;
const TERRAIN_COLS = Math.ceil(MWSim.C.WORLD_W / TERRAIN_CELL);
const TERRAIN_ROWS = Math.ceil(MWSim.C.WORLD_H / TERRAIN_CELL);
// ==CELL_STORE_BLOCK_START== (the probe rigs slice this out — see the HARNESS SEAM note at the end of the block)
// ═══ PER-ROOM CELL STORE (SHARED-WORLD.md §7, Phase 2) ══════════════════════════════════════════════════════
// Every full-world per-cell array a room owns lives on ONE store object instead of in ~25 parallel `room → array`
// dictionaries (roomTerrain, roomTerrainHp, roomFineAmt, roomFineTotal, roomFineLevelAcc, roomSat, roomDilute, the
// flux scratch, the powder/soil/react/fire sets, the source map, …). The change is PURELY MECHANICAL: every field is
// still allocated lazily on first use and still cleared at exactly the point its dictionary entry used to be deleted,
// so behaviour is unchanged — the probe suite is the proof, not the intention.
// WHY: Phase 3 replaces flat full-world arrays with sparse allocation around players. Scattered across 25
// dictionaries that is a 25-site change; behind this layer it is one. It already pays for itself today — one Map
// lookup per room instead of one per array, a room's arrays allocated together (cache locality), and a single place
// that knows how big a world's grid is.
// ⚠️ `null` is the "not allocated" state where `undefined` used to be. Every consumer tests truthiness, so the two are
// interchangeable — but do not "tidy" one of those tests into `=== undefined`.
// ═══ PER-ROOM WORLD SHAPE (SHARED-WORLD.md §7, Phase 6) ═════════════════════════════════════════════════════
// A room's grid shape used to be two module constants, which is the same assumption as "there is one world".
// The Overworld is a different shape from a page room and both must be live in ONE process, so the shape is now
// a per-room fact. Declared HERE, above the cell store, because `NO_CELLS` constructs a RoomCells at module load
// and a `const` declared further down would still be in its temporal dead zone at that point.
// ⚠️ `roomDims` is keyed on the ROOM KEY ALONE, deliberately — so it can be asked without materialising a cell
// store. That distinction is the whole reason `peekCells` exists beside `cellsOf`, and under chunking it is the
// difference between probing a chunk and faulting one in.
// ⚠️ The old zero-argument `WORLD_GEOM()` was RENAMED rather than given an optional parameter. An optional room
// would let a missed call site keep working today and break silently the day a second shape exists; a rename
// turns every missed site into an immediate ReferenceError instead.
// (`CELLS_PER_WORLD` used to sit here. It was referenced by nothing — server, probes or client — a fourth
//  orphaned full-world constant of exactly the kind Phase 2 turned up three of. Deleted with this block.)
const PAGE_DIMS = Object.freeze({ cols: TERRAIN_COLS, rows: TERRAIN_ROWS });
// ⭐ THE OVERWORLD'S SHAPE (user decision, 2026-08-04 — worldgen_redesign_proposal.md ADDENDUM 6).
// DEPTH is the decided, permanent number: 4,096 rows = 32,768 px, ~364 player-heights, 0.44× Noita. It is a POWER
// OF TWO on purpose — that is what puts every Overworld geometry on the shift-and-mask paging path, at any width.
// WIDTH is NOT a decision and is deliberately not treated as one. Since increment 5 the stride is the depth, so
// widening the world appends columns and renumbers nothing: this number can be raised at any time without
// touching a single stored edit.
// ⚠️ 524,224 columns = 4,193,792 px is the WIDEST THE FLAT INDEX ALLOWS at this depth — 2,147,221,504 cells,
// just under chunkGeom's 2^31 ceiling. At the default 30,720px domain separation that is ~136 sites; at 8,192px
// it is ~512. Capacity is width ÷ separation and BOTH are dials, so neither number is a commitment.
// ⭐ It was 262,144 for one increment because a flat index above 2^31 stops being a V8 unboxed integer, and
// nobody had priced that. MEASURED (probe_domains C1): **1.01x** — the small-integer boundary is not a cost at
// all, so there was no reason to leave half the legal width on the table.
// 🟥 GOING FURTHER IS A REAL SWEEP, NOT A CONSTANT: past 2^31 cells the wire handlers' `cells[k] | 0` wraps
// (ToInt32) and `fineFluxStack` is an Int32Array OF INDICES; past 2^32 the arithmetic paging's own `i >>> K6`
// stops being exact. So the next lever is that sweep — now worth doing, since C1 says it buys real width for no
// CPU — and beyond it, not sharing one flat index space across the whole world at all.
// ⚠️ NOTHING USES THIS YET. Domain placement and turning the Overworld on are later increments; declaring the
// shape here is what lets them be about placement rather than about arithmetic, and it is what
// probe_overworld_scale checks against instead of a number copied out of a document.
const OVERWORLD_DIMS = Object.freeze({ cols: 524224, rows: 4096 });
// Rooms that are part of the Overworld rather than a page world. Populated only when `worldCfg.overworld` is on
// (increment 7), so with it off `roomDims` returns the page shape for every real room and behaviour is unchanged.
// A Set rather than a key test because the sector split (§7: N scheduling rooms over one cell store) registers
// each sector here too — one shape, many scheduling keys.
const overworldRooms = new Set();
// ⭐ ONE ROOM FOR EVERYONE. The Overworld is a single continuous world, so every page that enters it enters the
// SAME room key — which is what makes it shared at all. The page you came from decides only your spawn COLUMN.
// ⚠️ Deliberately not a valid `avatarRoomKey` output: those are 'av:<url>:<level>' and a URL cannot be '@over'.
// Nothing can collide with it by accident, and it is greppable.
const OVERWORLD_ROOM = 'av:@over:1';
// 🟥🟥 …EXCEPT FOR TEST TRAFFIC, AND THAT IS NOT TIDINESS — IT IS THE FIX FOR REAL DAMAGE.
// The e2e harnesses join as `e2e-restart-<Date.now()>.test/`, which is a bare host, which `isDomainHome` calls
// a front door, which used to land them in the room above — the one everybody plays in. `e2e_worldgen_restart`
// and `e2e_worldgen_edit` both carve `{op:'carve', r:120, hard:true}` and then pour water into the hole, and
// Overworld persistence keeps it for ever. 78 of those craters were found in the live world, each one a
// bit-identical 709-cell disc of the server's own `rasterTerrainCircle`, sitting a short walk from the user's
// own domain column because that is where the allocator puts a new site. Write-up: scratchpad/circular_voids.md.
// ⭐ A SECOND ROOM KEY IS THE WHOLE FIX. Everything that decides what a world IS — `roomDims`, `worldGeom`,
// `genCfgFor`, `gen2LayoutFor`, the seed at `_seed` — keys off the `overworldRooms` SET, not off this string,
// so the test room is the same shape, the same generator, the same layout and the same storage path. Only the
// room key differs, and the room key is what `world_chunks` and the residency sets are keyed by. So the tests
// keep testing the Overworld; they just stop testing it inside the one people live in.
// ⚠️ `.test` is reserved by RFC 6761 and can never be a real site, so this cannot capture anybody's traffic.
// ⚠️ THE STRING LIVES HERE AND THE TEST DOES NOT. `isTestIdentity` calls the domains module's identity
// normaliser, and this is inside the block the probe rigs slice into a bare `new Function`, where a module
// require does not exist — the trap this file has now hit five times. It sits beside `isDomainHome` instead.
// ⚠️ …and the guard that caught it SCANS THE SOURCE TEXT, so naming the module here in prose fails it too.
// That is why this sentence talks around it. (Same shape as `probe_relay` I3, which a comment once broke.)
const OVERWORLD_TEST_ROOM = 'av:@over-test:1';
// The Overworld's terrain seed. FIXED, unlike a page world's (which is keyed on its URL so every page differs):
// there is only one Overworld, and it has to look the same to everyone who walks into it.
const OVERWORLD_SEED = 20260805;
// 🟥 THE WORLD FLOOR IS PER ROOM, AND MISSING THAT SQUASHED THE OVERWORLD INTO THE TOP 10% OF ITSELF.
// `FLOOR_TOP` is the page world's floor — 3,168px, from the stage layout — and it was being handed to the
// Overworld's generator as well. So a 4,096-row world was generated with its bedrock at row 395: the terrain
// occupied the top tenth and the other 3,700 rows were nothing at all. It was not visible in the spawn e2e
// because "you are standing on ground" was true; the ground was just in the wrong place, ~1,700 rows above
// where `bandGroundAt` says the surface band is. Caught by comparing the spawn the server gave against what
// the generator says for the same column — one number against another, not by reading.
// ⚠️ Declared in the cell-store block, next to `overworldRooms`, because the sim tick functions that need it
// are inside the block the probe rigs slice — and those rigs define `FLOOR_TOP` in their preamble, so this
// resolves in them too and answers the page floor for every room they build. Fifth time on this boundary.
const OVERWORLD_FLOOR_TOP = OVERWORLD_DIMS.rows * TERRAIN_CELL - 72;
const roomFloorTop = (room) => overworldRooms.has(room) ? OVERWORLD_FLOOR_TOP : FLOOR_TOP;
function roomDims(room) { return overworldRooms.has(room) ? OVERWORLD_DIMS : PAGE_DIMS; }
// (The domain registry itself lives just BELOW this block — see the note at ==CELL_STORE_BLOCK_END==.)
// The terrain-resolution geometry (SUB=1) for a room, i.e. the one the fields that are not fine-grid ones use.
const worldGeom = (room) => { const d = roomDims(room); return chunkGeom(d.cols, d.rows); };
// ═══ CHUNKING (SHARED-WORLD.md §7, Phase 3) ═════════════════════════════════════════════════════════════════════
// A room's per-cell state is no longer one flat full-world typed array per field. Each field is a PagedArray: an
// array of CHUNK_SIDE² -cell PAGES, allocated on first WRITE and released on eviction. A world costs what is near
// players instead of ~15–20MB flat.
//
// ⭐ THE FLAT INDEX SPACE IS A PURE STORAGE SUBSTITUTION. Paging is resolved from the flat index (by lookup tables
// or by shifts — see chunkGeom) rather than by re-numbering cells. That is deliberate and load-bearing:
//   · the `liquid-fine-cells` / `terrain-set` wires still carry the same indices, so no client change and no
//     translation layer at the emit boundary;
//   · `golden_fine_flow.json` still compares, so TEST A2 stays a real bit-identity proof rather than a re-recording;
//   · paging is a PURE STORAGE SUBSTITUTION — same values, same order, same arithmetic — so behaviour-preservation
//     is a property of the construction, not something to be argued.
// The tables cost 2 × Uint16 per world cell ONCE FOR THE PROCESS (~3.1MB at 1920×405), shared by every room and
// every field; they are not per-room, which is what makes the trade pay from the second live world onward.
//
// ⚠️ READ vs WRITE IS A REAL DISTINCTION HERE. `rp()` reads through an unallocated page as zeros (`this.zero`, a
// shared page that must NEVER be written); `wp()` faults one in. Using `rp` where a write happens would either lose
// the write or poison every unallocated page — so read paths use `rp`/`g` and write paths use `wp`/`s`. Whole-grid
// SCANS (terrainRLE, buildFineInit, the flux flood-fill, colStillSorting) are reads, and must stay reads, or a
// single scan would fault the entire world back in and undo the phase.
const CHUNK_SIDE = 64, CHUNK_CELLS = CHUNK_SIDE * CHUNK_SIDE;   // 64×64 cells = 512×512 px at the 8px terrain cell
// Per (cols × rows) grid shape — memoised, because the fine grid can be built at SUB≠1 (the probe rigs drive SUB=3),
// which is a different index space and therefore a different set of tables.
const _chunkGeoms = new Map();
// ⭐⭐ THE INDEX IS COLUMN-MAJOR: `i = col * rows + row`. THE STRIDE IS THE WORLD'S DEPTH, NOT ITS WIDTH.
// (Phase 6 increment 5 — `scratchpad/phase6_inc5_address_space.md`, ADDENDUM 6 of the worldgen proposal.)
// It used to be `row * cols + col`, which makes the stride the very dimension the Overworld has to GROW: adding
// a column at the world's edge would renumber every cell in it. Depth is DECIDED and fixed (4,096 rows); width
// is free and now multiplies nothing. So:
//     ROW is the minor axis   →  the cell BELOW is `i + 1`,      row = i % rows
//     COL is the major axis   →  the cell to the RIGHT is `i + rows`,  col = (i / rows) | 0
// ⚠️ `(i / rows) | 0` truncates a COLUMN NUMBER, which is small, so it is exact at any world size — the same
// argument increment 1 recorded for `(i / cols) | 0` truncating a row. What is NOT safe above 2^31 is a bitwise
// op on the index ITSELF, and after this change the arithmetic mode is the only place left that does one.
//
// ⭐ TWO ADDRESSING MODES (measured by `scratchpad/probe_overworld_scale.js`).
// The lookup tables below are 4 bytes PER WORLD CELL, held for the process — fine at the page world's ~3MB,
// and the reason SHARED-WORLD §4's "world size is free" is true of the SIM and false of the STORAGE.
// So when the STRIDE (= `rows`) is a POWER OF TWO, page and offset are recovered from the flat index with
// shifts and masks and the tables are never built:
//     r = i & (rows-1)   c = i >>> K        page = (i >>> K6) * cy + ((i >>> 6) & PGM)
//     off = ((i & 63) << 6) | ((i >>> K) & 63)   ← row-major WITHIN the page; `r & 63 === i & 63`, since a
//                                                  pow2 rows ≥ 64 is a multiple of 64
// K = -1 is the "no shortcut, use the tables" sentinel, which is what a page room (405 rows) takes.
// ⚠️ Keying the shortcut on the DEPTH rather than the width is the quiet win here: the Overworld's depth is a
// power of two by decision, so EVERY Overworld shape is arithmetic-paged however wide it grows — and the
// playable width is freed from having to be a power of two at all.
// ⚠️ PAGES STAY ROW-MAJOR INTERNALLY even though the world is column-major. It costs the same two shifts, and it
// means chunk payloads, chunkHash and the client's chunk decode keep their meaning across this change.
// ⚠️ Phase 3 rejected a branch in `rp()` on principle ("the hottest read in the server"). MEASURED, it is
// affordable and mostly a win: bit-identical to the mode it dispatches to on both geometries, 7.4% CHEAPER
// than the tables on a shortcut geometry and 4.5% dearer on a page room.
function chunkGeom(cols, rows) {
  const key = cols + 'x' + rows; let g = _chunkGeoms.get(key); if (g) return g;
  const cx = Math.ceil(cols / CHUNK_SIDE), cy = Math.ceil(rows / CHUNK_SIDE), cells = cols * rows;
  // ⚠️ THE WORLD-EXTENT CEILING, ASSERTED HERE BECAUSE THIS IS THE ONE PLACE THAT KNOWS THE SHAPE (Phase 6).
  // A flat cell index is a JS number and stays exact to 2^53. What is not exact past 2^31 is a bitwise op
  // applied to the index ITSELF: the wire handlers' "cells[k] | 0", "fineFluxStack" being an Int32Array OF
  // INDICES, and the arithmetic paging below ("i >>> K6" / "i & 63", ToUint32, exact only to 2^32-1).
  // ⚠️ This is now a SOFT boundary in one further sense: V8 stores integers below 2^31 unboxed, so an index past
  // it is still exact but slower. At 4,096 rows that is 524,288 columns = 4.19M px of width. The world does not
  // break there; it gets gradually dearer — which is the difference between a ceiling and a horizon.
  // Silently wrapping WOULD corrupt terrain at a coordinate nobody would think to test, so: throw.
  if (cells > 2147483647) throw new Error(`chunkGeom: ${cols}x${rows} = ${cells} cells exceeds the 2^31 flat-index ceiling`);
  const p2 = rows >= CHUNK_SIDE && (rows & (rows - 1)) === 0;
  // ⚠️ THE Uint16 PAGE INDEX IS A PROPERTY OF THE TABLES, NOT OF THE GEOMETRY — a distinction that did not exist
  // before there were two addressing modes, and getting it wrong made a legal Overworld shape throw. `pageOf`
  // stores a page number in a Uint16, so a TABLE geometry is capped at 65,535 pages. An ARITHMETIC geometry
  // builds no tables and computes the page number as a plain JS number, so it has no such cap.
  // (A big arithmetic geometry used to be legal but not CHEAP — `PagedArray`'s directory was one slot per page per
  //  field per room. Increment 2 made it a two-level directory; an empty world now costs ~nothing. See PagedArray.)
  if (!p2 && cx * cy > 65535) throw new Error('chunkGeom: page index overflows Uint16 (' + cx * cy + ') — a table geometry this large needs a power-of-two row count');
  const K = p2 ? (Math.log2(rows) | 0) : -1, PGM = cy - 1, K6 = K + 6;
  const pageOf = p2 ? null : new Uint16Array(cells), offOf = p2 ? null : new Uint16Array(cells);
  // ⚠️ CHUNKS ARE NUMBERED DOWN-THEN-ACROSS, matching the cells: page = chunkCol * cy + chunkRow. The client's
  // chunkHashesClient() decomposes page numbers the same way and MUST agree (probe_chunking F checks it).
  if (!p2) for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    const i = c * rows + r;
    pageOf[i] = ((c / CHUNK_SIDE) | 0) * cy + ((r / CHUNK_SIDE) | 0);
    offOf[i] = (r % CHUNK_SIDE) * CHUNK_SIDE + (c % CHUNK_SIDE);
  }
  g = { cols, rows, cells, cx, cy, nPages: cx * cy, pageOf, offOf, K, PGM, K6 };
  _chunkGeoms.set(key, g); return g;
}
// The page number of a flat cell index, in whichever mode this geometry uses. Kept as a named helper for the
// COLD callers (chunk pruning); the hot accessors below inline it deliberately.
function geomPage(g, i) { return g.K >= 0 ? ((i >>> g.K6) * g.cy + ((i >>> 6) & g.PGM)) : g.pageOf[i]; }
// (col, row) → flat index, and back. The COLD/readable form; hot loops hoist `rows` and write the arithmetic
// out, exactly as they used to hoist `cols`.
function geomIdx(g, c, r) { return c * g.rows + r; }
function geomCol(g, i) { return (i / g.rows) | 0; }
function geomRow(g, i) { return i % g.rows; }
// How many pages one directory group covers (Phase 6 increment 2 — see the constructor). 256 pages is a group of
// ~3KB, and it divides the outer directory by the same factor: 425,984 pages become 1,664 outer slots per field.
// Row-major, so a group is a horizontal strip of 256 chunks — which is how players spread out along a side-scroller.
const PAGE_GRP_SH = 8, PAGE_GRP = 1 << PAGE_GRP_SH, PAGE_GRP_M = PAGE_GRP - 1;
// How many page sky-answers `skyAt` may remember before dropping the lot. Every entry is immutable (see the
// constructor), so clearing wholesale carries no correctness risk and the only reason for a bound is memory —
// 65,536 entries is far more than any set of viewports touches and costs a few MB at worst.
const SKY_MEMO_MAX = 65536;
// `stride` = values per cell (1 for everything except fineAmt, which is LIQ_T per cell).
// `seedFn` = how a freshly faulted page is initialised when its default is NOT zero (only fineLevelAcc, whose cells
// carry a per-index hash so the invisible sub-unit levelling steps do not all align). A seeded array must fault its
// page on READ too, or an untouched cell would read 0 instead of its phase — hence the branch in `g()`.
function PagedArray(geom, Ctor, stride, seedFn, room) {
  this.geom = geom; this.Ctor = Ctor; this.T = (stride | 0) || 1; this.seedFn = seedFn || null;
  this.seedEmpty = null;                          // optional: (p) => true when the seeder is CERTAIN the page is all zeros
  this._emptyP = -1; this._emptyV = false;        // one-slot memo of the last seedEmpty answer — see _miss
  // 🟥 …AND A REAL ONE BEHIND IT, because ONE SLOT IS NOT ENOUGH FOR THE SIM. The note on `skyAt` says "every
  // hot reader walks a page at a time, so one slot is enough" — true of a scan, and false of the liquid tick,
  // which walks the ACTIVE SET sorted by row and therefore hops between columns and pages on consecutive cells.
  // The slot thrashed and `pageEmpty` ran again, and `pageEmpty` loops up to 64 columns of `topLimitAt`.
  // MEASURED at **10.1% of the whole server** on a profile taken near the surface, where absent pages are sky.
  // ⭐ The answer is IMMUTABLE — "would the generator put anything in this page" depends only on the layout,
  // which is fixed for the life of the generator — so this needs no invalidation, only dropping when the
  // generator itself is swapped (`setRoomGenerator`). Capped and cleared wholesale rather than evicted: a stale
  // entry is impossible, so the only reason to bound it is memory.
  this._skyMemo = new Map();
  this._lastP = -1; this._lastA = null;           // one-slot page memo — see the note on `rp`
  // ⭐ EVICTION MUST BE TRANSPARENT TO ACCESS. An evicted chunk has no pages, so without this every read would hand
  // back the shared ZERO page and the chunk would look like EMPTY WORLD — which is exactly what it did: liquid at a
  // chunk seam saw air where solid ground was evicted and poured through it, one cell wide, and a write into an
  // evicted chunk was later clobbered by the stale blob (reported from play as invisible-but-solid terrain).
  // `room` + `ev` let a page fault restore the blob first. The flags array is referenced DIRECTLY (not looked up
  // per miss) because a miss is common — an air cell in a chunk that has never held liquid misses every read.
  this.room = room || null; this.ev = null;
  // ⭐ A TWO-LEVEL PAGE DIRECTORY (Phase 6 increment 2). `pages` used to be `new Array(nPages).fill(null)` and
  // `rev` a `Uint32Array(nPages)` — one slot per world page PER FIELD PER ROOM, whether or not anything was
  // there. At the page world that is 22KB and invisible; at 273 domains it is 43.9MB of pure null pointers for an
  // EMPTY room, and it was the last area-linear cost in the server after increments 1a/1b. Now the directory is
  // an outer array of GROUPS, each holding PAGE_GRP page pointers and allocated on first use, so an untouched
  // region of the world costs one null in the outer array. The outer arrays are area-linear at 1/PAGE_GRP, which
  // is the difference between 3.4MB and 13KB per field.
  const nG = (((geom.nPages - 1) >> PAGE_GRP_SH) | 0) + 1;
  this.dir = new Array(nG).fill(null);            // group index → Array(PAGE_GRP) of pages
  this.rdir = new Array(nG).fill(null);           // group index → Uint32Array(PAGE_GRP) of revisions (see below)
  this.zero = new Ctor(CHUNK_CELLS * this.T);     // read-through for an unallocated page — NEVER written
  this.length = geom.cells * this.T;              // exactly what the old flat array reported
  this.live = 0;                                  // pages currently faulted in (memory accounting + probes)
  // PER-CHUNK REVISION. Bumped by every wp() — i.e. at the ONE choke point every write in the server goes through,
  // which is why dirty tracking did not have to be threaded through the sim by hand. It OVER-approximates (wp() is
  // called to get a writable page, not because a byte definitely changed), which is exactly the right direction: a
  // hash may be recomputed needlessly, but it can never be served stale. Wraparound is harmless — it is only ever
  // compared for equality. Kept in `rdir` beside the pages, so it is nowhere near the hot READ path.
  // ⚠️ `epoch` is what `fill()` bumps instead of touching every revision. A whole-array fill has to make every
  // chunk's stamp change, and walking nPages to do it would put back the cost this increment removes — so the
  // epoch is ADDED to every revAt, which changes all of them at once. Stamps are only ever compared for equality.
  this.epoch = 0;
}
PagedArray.prototype._alloc = function (p) {
  const a = new this.Ctor(CHUNK_CELLS * this.T);
  if (this.seedFn) this.seedFn(a, p, this.geom, this.T);
  (this.dir[p >> PAGE_GRP_SH] || this._grp(p))[p & PAGE_GRP_M] = a; this.live++;
  this._lastP = -1;                               // a page pointer changed ⇒ the one-slot memo is void (see `rp`)
  // ⚠️ Ordering: the page is installed BEFORE the restore, and rehydrateChunk clears the evicted flag and takes the
  // blob before decoding — so the decode's own writes re-enter here and see a normal, un-evicted chunk.
  if (this.ev !== null && this.ev[p]) onChunkFault(this.room, p);
  return a;
};
// Fault in one GROUP of the directory (pages + revisions together, so the two can never disagree about existing).
PagedArray.prototype._grp = function (p) {
  const gi = p >> PAGE_GRP_SH;
  this.rdir[gi] = new Uint32Array(PAGE_GRP);
  return (this.dir[gi] = new Array(PAGE_GRP).fill(null));
};
// ⭐ THE HOTTEST READ IN THE SERVER. Two dependent DENSE loads — group, then page. MEASURED against the dense
// array it replaces (`scratchpad/probe_sparse_pages.js` B4, same scene at the far corner of a 273-domain world):
// 1.042x, i.e. 4.2% dearer, bit-identical, and the same wherever in the world you stand. The kickoff's suggested
// Map measured 1.315x — a hash lookup does not belong here — and a plain holey array measured 1.009x but is NOT
// SPARSE (Part C: 58.6MB for an empty room, worse than the dense array), which is why it is fast.
// ⭐⭐ ONE-SLOT PAGE MEMO, AND IT IS THE SAME LESSON AS `skyAt` ONE LEVEL DOWN. `rp` + `pageAt` + `peekCellAt`'s
// page lookup were ~23% of the liquid tick (per-LINE profile of the live server) — two DEPENDENT memory loads
// (group, then page) on every single cell read, which is precisely the cost Phase 3 recorded as irreducible.
// It is not irreducible, because of how the sim actually walks: a page is 64 columns × 64 rows, and both the
// lateral levelling scan and the sink/neighbour tests step along a ROW, so 63 of every 64 consecutive lookups
// ask for the page just asked for. Each field carries its own slot, so `tot`, `amt` and `grid` alternating
// within one cell's work do not evict each other.
// 🟥 ONLY A PAGE FOUND IN THE DIRECTORY IS REMEMBERED — never `_miss`'s shared zero page. Memoising that would
// mean a read after a write returned zeros, which is Phase 3's evicted-chunks-read-as-ZEROS bug rebuilt by
// hand. A remembered page is a real one, and the ONLY three places that can change a page pointer (`_alloc`,
// `dropPage`, `fill` — `_grp` only ever creates an absent group) all clear the slot.
PagedArray.prototype.rp = function (i) {
  const g = this.geom, p = g.K >= 0 ? ((i >>> g.K6) * g.cy + ((i >>> 6) & g.PGM)) : g.pageOf[i];
  if (p === this._lastP) return this._lastA;
  const d = this.dir[p >> PAGE_GRP_SH], a = d !== null && d[p & PAGE_GRP_M];
  if (a) { this._lastP = p; this._lastA = a; return a; }
  return this._miss(p);
};
// The cold half of rp, kept out of line so the hot path is just "load the page and return it".
// ⭐⭐ THE SIM MAY NOT BUILD WORLD. MEASURED, panning 4,800px above the water line in EMPTY SKY: 37,025 chunks
// produced in 35 seconds — over a thousand a second — of which 35,379 came from inside `runLiquidTick`, ~31.8s
// of the 35 spent running the world generator. A read generates a chunk; that chunk's liquid is seeded and
// woken; those cells read THEIR neighbours; more chunks. A self-sustaining cascade that manufactures its own
// work out of nothing, and the "45,000 cells waiting to move" was its symptom, not its cause.
// 🟥 PATCHING CALL SITES DID NOT WORK. Three were fixed by hand (the flow's isSolid, powder's canDisplace, three
// in reactions) and production fell but never stopped, because `fineReactTickRoom` alone has a dozen more reads
// and any new one silently reintroduces it. This is a property the SIM must have, so it is enforced in the one
// place every read passes through rather than at each of them.
// ⚠️ WHAT AN UNBUILT PAGE READS AS, AND WHY IT IS SAFE: zeros, i.e. AIR. That is the WRONG answer for anything
// deciding support — liquid would pour through unbuilt ground — which is exactly why the three solidity sites
// were converted to explicit peeks that answer UNBUILT ⇒ SOLID, and they do not come through here at all. Every
// OTHER read is a reaction predicate ("is the neighbour snow / mud / sand?"), and air is the correct fail-safe
// answer to all of them: no reaction, wait until that ground actually exists.
// ⚠️ READS ONLY. `wp()` calls `_alloc` directly and is untouched, so a reaction that genuinely fires can still
// write. Writes are rare (thousands per minute); reads are millions.
let PAGE_NO_GEN = false;
PagedArray.prototype._miss = function (p) {
  if (this.ev !== null && this.ev[p]) return this._alloc(p);       // evicted → fault it back, blob and all
  // 🟥 THE `seedEmpty` ANSWER IS MEMOISED FOR ONE PAGE, AND WITHOUT THIS THE OVERWORLD IS UNPLAYABLE.
  // `seedEmpty` asks the generator "is this whole page provably sky?" — it is not free, it evaluates the
  // surface over the page's columns. Reads of an ABSENT page come here EVERY TIME (there is no page to find in
  // the directory), so a loop reading 4,096 cells of one sky page asked the same question 4,096 times.
  // MEASURED on the live server: `sendChunkContent` reading 16 chunks took 8,632ms while producing NOTHING —
  // 132µs per cell, all of it re-deciding emptiness. That is the whole "the world is invisible" report: chunk
  // content took ~9 seconds a batch, so almost none of it arrived; it is the `connection error: timeout` in the
  // console; and repeated beacons queued more 9-second blocks until the server looked dead.
  // ⚠️ ONE SLOT IS ENOUGH because every hot reader walks a page at a time (the chunk readout, the RLE walk, the
  // sim's row scans). A page that later gets ALLOCATED never reaches here — `rp` finds it in the directory — so
  // a stale "empty" cannot outlive the emptiness it describes.
  if (this.seedFn) {
    if (PAGE_NO_GEN) return this.zero;      // the sim is running: read through, never build
    if (p === this._emptyP) return this._emptyV ? this.zero : this._alloc(p);
    const empty = !!(this.seedEmpty && this.seedEmpty(p));
    this._emptyP = p; this._emptyV = empty;
    return empty ? this.zero : this._alloc(p);
  }
  // ⭐ PHASE 6 INCREMENT 4b. A seeded array must materialise on READ too, or an untouched cell would read 0
  // instead of its seed — which for a GENERATED world means reading solid ground as air. But a world is mostly
  // SKY, and faulting 4KB of zeros for every page of it would undo increment 2's sparse storage from the other
  // side. `seedEmpty` lets the seeder answer "provably nothing here" without generating: sky costs nothing, and
  // a WRITE into it still allocates through wp() as usual. Conservative by contract — a false "empty" is
  // invisible terrain, which is the worst bug this subsystem can have. (The decision itself is memoised above.)
  return this.zero;                                               // genuinely empty → the shared zero page
};
PagedArray.prototype.wp = function (i) {
  const g = this.geom, p = g.K >= 0 ? ((i >>> g.K6) * g.cy + ((i >>> 6) & g.PGM)) : g.pageOf[i], gi = p >> PAGE_GRP_SH;
  if (this.dir[gi] === null) { this._grp(p); this.rdir[gi][p & PAGE_GRP_M]++; return this._alloc(p); }
  this.rdir[gi][p & PAGE_GRP_M]++;
  return this.dir[gi][p & PAGE_GRP_M] || this._alloc(p);
};
PagedArray.prototype.o = function (i) { const g = this.geom; return (g.K >= 0 ? (((i & 63) << 6) | ((i >>> g.K) & 63)) : g.offOf[i]) * this.T; };
PagedArray.prototype.g = function (i) { const g = this.geom; return this.rp(i)[(g.K >= 0 ? (((i & 63) << 6) | ((i >>> g.K) & 63)) : g.offOf[i]) * this.T]; };
PagedArray.prototype.s = function (i, v) { const g = this.geom; this.wp(i)[(g.K >= 0 ? (((i & 63) << 6) | ((i >>> g.K) & 63)) : g.offOf[i]) * this.T] = v; };
// `.fill(0)` on an unseeded array DROPS every page — the old flat `.fill(0)` meant "this is now empty everywhere",
// and dropping is both faster and the point of the exercise.
PagedArray.prototype.fill = function (v) {
  this.epoch++;                                   // one bump stands for "every chunk's revision changed" — see above
  this._lastP = -1; this._lastA = null;           // every page pointer is about to change (see `rp`)
  if (v === 0 && !this.seedFn) { this.dir.fill(null); this.rdir.fill(null); this.live = 0; return this; }
  // ⚠️ The non-zero branch MATERIALISES THE WHOLE WORLD and is area-linear by nature — there is no sparse way to
  // say "every cell is 7". Nothing calls it: every `.fill()` in the server is `.fill(0)` (checked 2026-08-02), and
  // the only seeded field, fineLevelAcc, is never filled. Left as a correct fallback, not a path anything takes.
  for (let p = 0; p < this.geom.nPages; p++) (this.pageAt(p) || this._alloc(p)).fill(v);
  return this;
};
PagedArray.prototype.dropPage = function (p) {
  const gi = p >> PAGE_GRP_SH; if (this.dir[gi] === null) this._grp(p);
  this.rdir[gi][p & PAGE_GRP_M]++;
  if (this.dir[gi][p & PAGE_GRP_M] !== null) { this.dir[gi][p & PAGE_GRP_M] = null; this.live--; }
  this._lastP = -1;                               // ...and so is a page that has just been evicted (see `rp`)
};
// ⭐ WHOLE-GRID SCANS GO THROUGH THIS. Iterates only the pages that EXIST, yielding (flat cell index, offset base in
// the page, page). An unallocated page holds nothing but zeros, so skipping it is exact — and it is what keeps
// terrainRLE / buildFineInit / seedLiquidActivity / rescaleAllLiquid from walking 777,600 cells of mostly nothing.
// Early-exit form of scan (mirrors TypedArray#some, which is what the flat arrays used). cb(value, flatIndex).
// ⚠️ `eachPage` is the ONE place that walks the directory in page order — `some`, `scan` and the whole-world
// sweeps all go through it rather than writing their own `for (p = 0; p < pages.length)`. That is what stops the
// directory's REPRESENTATION leaking into six call sites (Phase 6 increment 2 measured three alternatives to the
// dense array behind exactly this seam). cb(p, page); return truthy to stop early — which is what `some` needs.
// ⚠️ It walks the GROUPS THAT EXIST, not 0..nPages — which is the whole-world sweep in its time dimension, and
// measured (probe_sparse_pages D) at 0.911ms → 0.110ms for a scan of a 425,984-page world with four live pages.
PagedArray.prototype.eachPage = function (cb) {
  for (let gi = 0; gi < this.dir.length; gi++) {
    const d = this.dir[gi]; if (d === null) continue;
    for (let k = 0; k < PAGE_GRP; k++) { const a = d[k]; if (a !== null && cb((gi << PAGE_GRP_SH) | k, a)) return true; }
  }
  return false;
};
// ⚠️ Pages are numbered DOWN then ACROSS (page = chunkCol * cy + chunkRow), matching the column-major cells; the
// page's own 64×64 payload stays ROW-major (offset = lr * 64 + lc) so chunk wire payloads keep their meaning.
PagedArray.prototype.some = function (cb) {
  const g = this.geom, T = this.T, ROWS = g.rows;
  return this.eachPage((p, a) => {
    const c0 = ((p / g.cy) | 0) * CHUNK_SIDE, r0 = (p % g.cy) * CHUNK_SIDE;
    const rN = Math.min(CHUNK_SIDE, g.rows - r0), cN = Math.min(CHUNK_SIDE, g.cols - c0);
    for (let lc = 0; lc < cN; lc++) { const colBase = (c0 + lc) * ROWS + r0;
      for (let lr = 0; lr < rN; lr++) if (cb(a[(lr * CHUNK_SIDE + lc) * T], colBase + lr)) return true; }
    return false;
  });
};
PagedArray.prototype.scan = function (cb) {
  const g = this.geom, T = this.T, ROWS = g.rows;
  this.eachPage((p, a) => {
    const c0 = ((p / g.cy) | 0) * CHUNK_SIDE, r0 = (p % g.cy) * CHUNK_SIDE;
    const rN = Math.min(CHUNK_SIDE, g.rows - r0), cN = Math.min(CHUNK_SIDE, g.cols - c0);
    for (let lc = 0; lc < cN; lc++) { const colBase = (c0 + lc) * ROWS + r0;
      for (let lr = 0; lr < rN; lr++) cb(colBase + lr, (lr * CHUNK_SIDE + lc) * T, a); }
    return false;
  });
};
PagedArray.prototype.bytes = function () { return this.live * CHUNK_CELLS * this.T * this.Ctor.BYTES_PER_ELEMENT; };
// ── THE PAGE-DIRECTORY INTERFACE ── everything OUTSIDE the hot accessors reaches pages and revisions through these
// four, never through `.pages[p]` / `.rev[p]` directly. That is what makes the directory's REPRESENTATION a local
// decision (Phase 6 increment 2 measured a Map and a two-level directory against the dense array behind exactly
// this seam). The hot paths — rp/wp/g/s/o above — deliberately stay inlined and are the only sites that know.
// `wpPage` is "wp, but you already have the page number": the get-or-fault-and-bump that chunk decoding does.
// ⚠️ Shares `rp`'s slot deliberately — same question ("which array holds page p"), same answer. A `null` result
// is NOT remembered: an absent page can be allocated at any moment, and remembering "absent" is the direction
// that goes wrong silently.
PagedArray.prototype.pageAt = function (p) {
  if (p === this._lastP) return this._lastA;
  const d = this.dir[p >> PAGE_GRP_SH], a = (d !== null && d[p & PAGE_GRP_M]) || null;
  if (a) { this._lastP = p; this._lastA = a; }
  return a;
};
// Which page holds cell `i`, without touching it. The page NUMBER only — no allocation, no generator call, no
// eviction restore. Kept here rather than recomputed at call sites so the two addressing modes (arithmetic and
// table) stay the class's business, exactly as `eachPage` keeps the directory's layout its business.
// ⚠️ Its whole purpose is to let a scan ask "is there anything here?" WITHOUT the asking creating it — `rp` on an
// absent page of a generated world calls `_alloc`, which PRODUCES that chunk of the world.
PagedArray.prototype.pageOfCell = function (i) { const g = this.geom; return g.K >= 0 ? ((i >>> g.K6) * g.cy + ((i >>> 6) & g.PGM)) : g.pageOf[i]; };
// Is this page absent because nothing was ever stored there, as opposed to evicted-to-a-blob? A scan may skip the
// first (it is all zeros) but must NOT skip the second, or evicted content silently reads as empty — Phase 3's
// worst bug, and the reason this is a named test rather than `pageAt(p) === null`.
PagedArray.prototype.pageVacant = function (p) { return this.pageAt(p) === null && (this.ev === null || !this.ev[p]); };
// Is the page holding cell `i` provably SKY — absent, and the generator can say so WITHOUT generating it?
// ⭐ This is what makes "never build world from inside the sim" safe. Refusing to produce is fail-safe only if
// the refusal reads as SOLID, and reading open sky as solid would stop falling liquid dead in mid-air — which is
// the exact symptom this whole track started from. Sky is the one absent page whose contents are known for free,
// so it must be answered honestly (air) while everything else answers "unbuilt".
// ⚠️ Shares `_miss`'s one-slot memo deliberately: same question, same answer, and every hot reader walks a page
// at a time, so one slot is enough. Without it this re-evaluates the generator's surface on every single cell.
PagedArray.prototype.skyAt = function (i) {
  if (!this.seedEmpty) return false;
  const p = this.pageOfCell(i);
  if (p === this._emptyP) return this._emptyV;      // the one-slot fast path still wins whenever a reader DOES run
  let e = this._skyMemo.get(p);
  if (e === undefined) {
    e = !!this.seedEmpty(p);
    if (this._skyMemo.size >= SKY_MEMO_MAX) this._skyMemo.clear();   // safe at any moment: every entry is immutable
    this._skyMemo.set(p, e);
  }
  this._emptyP = p; this._emptyV = e;
  return e;
};
// A NON-FAULTING read: the cell's value, or -1 when nobody has produced that page yet. `.g()` would produce it,
// and there are readers for which producing is exactly the wrong answer — see the powder seeders, where a read
// of "the cell below" cascaded a chunk at a time down 64 chunks of Overworld and stalled the server.
// ⚠️ -1 means UNKNOWN and is not the same as 0 (air). A caller that treats it as air will wake or move things it
// should have left alone; every caller here tests `>= 0` first.
function peekCellAt(pa, i) {
  const g = pa.geom, p = g.K >= 0 ? ((i >>> g.K6) * g.cy + ((i >>> 6) & g.PGM)) : g.pageOf[i];
  const page = pa.pageAt(p);
  return page ? page[(g.K >= 0 ? (((i & 63) << 6) | ((i >>> g.K) & 63)) : g.offOf[i]) * pa.T] : -1;
}
PagedArray.prototype.revAt = function (p) { const r = this.rdir[p >> PAGE_GRP_SH]; return (r !== null ? r[p & PAGE_GRP_M] : 0) + this.epoch; };
PagedArray.prototype.wpPage = function (p) {
  const gi = p >> PAGE_GRP_SH; if (this.dir[gi] === null) this._grp(p);
  this.rdir[gi][p & PAGE_GRP_M]++;
  return this.dir[gi][p & PAGE_GRP_M] || this._alloc(p);
};
// ⚠️ `cols`/`rows` are the room's GRID SHAPE, copied here from `roomDims` when the store is created. They are on
// the store as well as behind `roomDims` on purpose: the sim's hot functions already hold a store, so they read
// the shape with one property load instead of a lookup. NO_CELLS has 0/0 — a caller that only PEEKED has no
// store and must ask `roomDims` rather than read a shape off the shared empty.
function RoomCells(cols, rows) {
  this.cols = cols | 0; this.rows = rows | 0;            // this room's grid shape (0/0 on the shared empty)
  this.terrain = null; this.terrainHp = null;            // solidity grid + per-cell remaining hits
  this.sat = null; this.dilute = null;                   // absorbed water in solids + water soaked into acid
  this.fineSub = 0;                                      // fine:terrain ratio these arrays were built at (1 everywhere)
  this.fineAmt = null; this.fineTotal = null;            // THE LIQUID: per-rank units per cell + cached per-cell total
  this.fineLevelAcc = null; this.fineStill = null;       // levelling carry + quiescence counters
  this.fineActive = null; this.fineReact = null; this.fineFire = null;   // Sets of cell indices
  this.fineFluxSeen = null; this.fineFluxStack = null;   // flux-levelling flood-fill scratch
  this.powderActive = null; this.soilActive = null;      // Sets of cell indices
  this.src = null;                                       // Map(cell → {rank, rate}) of liquid source cells
  this.srcAdded = null; this.sinkEaten = null;           // per-rank mass ledgers (per-room liquid state, not per-cell)
  this.chunks = null;                                    // RoomChunks: per-chunk hashes + evicted blobs + residency
}
const roomCells = new Map();          // room → RoomCells. THE registry of a room's per-cell state.
function cellsOf(room) { let s = roomCells.get(room); if (s === undefined) { const d = roomDims(room); roomCells.set(room, s = new RoomCells(d.cols, d.rows)); } return s; }
// ...and the READ-ONLY form, for callers that only want to look (does a room have terrain? is it empty?) and must not
// bring a store into existence by asking. It reads identically — every field of the shared empty is null. Under
// Phase 3 this is the difference between probing a chunk and faulting one in, so the split is worth having now.
const NO_CELLS = Object.freeze(new RoomCells());
function peekCells(room) { return roomCells.get(room) || NO_CELLS; }
// ── ACTIVITY REGISTRIES ── which rooms currently hold each kind of work, in first-touch order. These are the
// iteration sources the tick loop used to get from `for (const room in roomFineActive)`, and the budget scheduler's
// rotation depends on that order — so membership is tracked EXPLICITLY here rather than derived by scanning
// roomCells, whose order is "first room to touch any cell state" and need not be the same.
// `fineArr` = has the fine amt/total arrays; `fine` = has an active set (a room can have one without the other).
const cellRooms = { fine: new Set(), fineArr: new Set(), react: new Set(), fire: new Set(), powder: new Set(), soil: new Set(), src: new Set() };
// Dropping a collection = what `delete roomX[room]` used to mean: the room stops being iterated and the Set/Map is
// released. Never called on a room that has no store, so it does not create one.
function dropFineActive(room) { const s = roomCells.get(room); if (s) s.fineActive = null; cellRooms.fine.delete(room); }
function dropFineReact(room)  { const s = roomCells.get(room); if (s) s.fineReact = null; cellRooms.react.delete(room); }
function dropFineFire(room)   { const s = roomCells.get(room); if (s) s.fineFire = null; cellRooms.fire.delete(room); }
function dropPowderSet(room)  { const s = roomCells.get(room); if (s) s.powderActive = null; cellRooms.powder.delete(room); }
function dropSoilSet(room)    { const s = roomCells.get(room); if (s) s.soilActive = null; cellRooms.soil.delete(room); }
function dropSrcMap(room)     { const s = roomCells.get(room); if (s) s.src = null; cellRooms.src.delete(room); }
// ═══ CHUNK LIFECYCLE ════════════════════════════════════════════════════════════════════════════════════════════
// Storage became sparse above; this is what manages it — which chunks are kept live, what has changed in them, and
// how one is put away and brought back.
// ⚠️ The fields hashed/evicted here are the ones that DEFINE WHAT A CLIENT SEES. `sat`/`dilute`/`fineLevelAcc`/
// `fineStill` are internal sim scratch: they are dropped with the chunk (their default is the correct cold state)
// but deliberately NOT hashed, or a resync would churn on invisible differences.
const CHUNK_CONTENT = ['terrain', 'terrainHp', 'fineAmt', 'fineTotal'];
const CHUNK_SCRATCH = ['sat', 'dilute', 'fineLevelAcc', 'fineStill', 'fineFluxSeen'];
// ⚠️ SPARSE, for exactly the reason PagedArray's directory is (Phase 6 increment 2). These were SIX arrays of one
// slot per world page, held for the life of the room — 33 bytes per page, which at 273 domains is 13.4MB of an
// EMPTY room and 23% of its whole skeleton. Measured by `scratchpad/probe_sparse_pages.js` Part A, which found it;
// the kickoff had not named it, and sparsifying PagedArray alone would have left a quarter of the problem standing.
// A record now exists only for a chunk something has actually happened to.
function ChunkRec() {
  this.hash = 0;          // cached content hash
  this.stamp = -1;        // Σ rev of the content fields when that hash was taken (-1 = never)
  this.blob = null;       // an evicted chunk's content, compacted
  this.lastNear = 0;      // ms a player was last within the residency radius
  // An evicted chunk has NO pages, so its hash cannot be recomputed from them — it would come out as "empty" and
  // chunk-verify would then "repair" every client to empty. The hash is therefore taken BEFORE the pages are
  // dropped and served from here until the chunk comes back.
  this.evHash = 0;
  // ⭐ PHASE 6 INCREMENT 4c. A chunk of a GENERATED world that nobody has changed does not need storing at all —
  // it can be thrown away and produced again from the seed. `gen` marks an evicted chunk as "restore me by
  // regenerating, not from a blob". "Has anyone changed this?" is answered at eviction by generating the chunk
  // and comparing — the same pass that computes the stored diff — rather than by any bookkeeping kept along the
  // way. ⚠️ A revision-counting version of this shipped for a few hours and was subtly wrong; see evictChunk.
  this.gen = 0;
  this.restoring = 0;     // 4d: decoding right now — do NOT treat the page fault it causes as a first production
  // ⭐ 2026-08-06: RESIDENT BUT NOT SIMULATED. Its cells have been pruned from the work sets because nobody can
  // see it, while the chunk itself stays in memory for the whole eviction grace. Cleared by `rewakeChunk` when
  // it comes back into view. Declared here rather than assigned ad hoc so every record keeps one hidden shape.
  this.quiet = 0;
  // The content hash as of the last time this chunk was written to the database. The periodic flush compares
  // against it so an untouched chunk costs one integer comparison rather than a regenerate-and-diff.
  this.savedHash = -1;
}
const NO_CHUNK_REC = Object.freeze(new ChunkRec());   // what `peek` answers for a chunk nothing has happened to
function RoomChunks(nPages) {
  // ⚠️ `evicted` STAYS DENSE, and it is the deliberate exception. `PagedArray._miss` reads it DIRECTLY on every
  // page miss — and a miss is common, not rare: an air cell in a chunk that has never held liquid misses every
  // read. Making that a Map get would put a hash lookup on the one path the whole of Phase 3 was careful about.
  // One byte per page is 416KB for a 273-domain world, which is the trade, made knowingly.
  this.evicted = new Uint8Array(nPages);
  this.rec = new Map();                       // page → ChunkRec, created on first need
}
RoomChunks.prototype.at = function (p) { let r = this.rec.get(p); if (r === undefined) this.rec.set(p, r = new ChunkRec()); return r; };
RoomChunks.prototype.peek = function (p) { const r = this.rec.get(p); return r === undefined ? NO_CHUNK_REC : r; };
function chunksOf(room) { const s = cellsOf(room); return s.chunks || (s.chunks = new RoomChunks(worldGeom(room).nPages)); }
// CONTENT HASH of one chunk — the unit of resync. FNV-1a over the content fields, cached against the summed page
// revisions so a settled chunk is hashed once and then answered for free.
// ⚠️ Only meaningful at the all-fine ratio (SUB=1), where the terrain and liquid grids share an index space and
// therefore a chunk grid. At SUB≠1 (probe rigs only) it declines to answer rather than hashing mismatched pages.
// ⚠️ THE HASH IS OF CONTENT, NEVER OF REPRESENTATION. An absent page and a page of zeros MUST hash the same: a
// client has no idea which pages the server happens to have faulted in, and evicting then rehydrating a chunk
// changes which pages exist while changing nothing anyone can see. Getting this wrong made a round-tripped chunk
// look like a mismatch and would have had resync re-sending unchanged chunks forever (caught by probe_chunking B/C).
// Folding N zeros into FNV-1a is just multiplying by 0x01000193^N, since `h ^= 0` is a no-op — so it is one
// multiply per absent field, not a loop over 4096 zeros.
const _zeroFoldMul = new Map();
function foldZeros(h, n) {
  let m = _zeroFoldMul.get(n);
  if (m === undefined) { m = 1; for (let k = 0; k < n; k++) m = Math.imul(m, 0x01000193) >>> 0; _zeroFoldMul.set(n, m); }
  return Math.imul(h, m) >>> 0;
}
const CHUNK_CONTENT_STRIDE = { terrain: 1, terrainHp: 1, fineAmt: 0, fineTotal: 1 };   // 0 ⇒ LIQ_T (not in scope yet)
// The hash of a chunk with no pages at all, which is a CONSTANT: the loop below folds zeros for every absent
// field, and which fields are absent does not depend on `p`. Computed on first use because LIQ_T is defined below.
let _emptyChunkHash = -1;
function emptyChunkHash() {
  if (_emptyChunkHash < 0) { let h = 0x811c9dc5;
    for (const f of CHUNK_CONTENT) h = foldZeros(h, CHUNK_CELLS * (CHUNK_CONTENT_STRIDE[f] || LIQ_T));
    _emptyChunkHash = h; }
  return _emptyChunkHash;
}
function chunkHash(room, p) {
  const s = peekCells(room); if (!s.terrain || (s.fineSub || 1) !== 1) return 0;
  const ch = chunksOf(room);
  if (ch.evicted[p]) return ch.peek(p).evHash;   // pages are gone; the content is in the blob (see ChunkRec)
  let stamp = 0, any = false;
  for (const f of CHUNK_CONTENT) { const pa = s[f]; if (pa) { stamp += pa.revAt(p); if (pa.pageAt(p)) any = true; } }
  // ⚠️⚠️ AN ABSENT CHUNK ANSWERS THE CONSTANT AND IS NOT CACHED. Every whole-world sweep (roomChunkSig, chunkHashes,
  // updateSubs' first visit) asks for the hash of EVERY page, so caching the empty answer would create one record
  // per page in the world — reintroducing through the CACHE precisely the area-linear cost this increment removes.
  // The answer is identical either way: the loop below folds zeros for every absent field.
  if (!any) return emptyChunkHash();
  const r = ch.peek(p);
  if (r.stamp === stamp) return r.hash;
  let h = 0x811c9dc5;
  for (const f of CHUNK_CONTENT) {
    const pa = s[f], page = pa && pa.pageAt(p);
    if (!page) { h = foldZeros(h, CHUNK_CELLS * (CHUNK_CONTENT_STRIDE[f] || LIQ_T)); continue; }
    for (let k = 0; k < page.length; k++) { h ^= page[k]; h = Math.imul(h, 0x01000193) >>> 0; }
  }
  const w = ch.at(p); w.hash = h; w.stamp = stamp; return h;
}
function chunkHashes(room) { const n = worldGeom(room).nPages, out = new Array(n); for (let p = 0; p < n; p++) out[p] = chunkHash(room, p); return out; }
// ── EVICTION ── a chunk nobody is near is compacted into a blob and its pages released. The blob is the DELTA from
// an empty chunk (RLE for the byte grids, a sparse index→stack list for liquid), which is typically 10–100× smaller
// than the 80KB of raw pages a fully-populated chunk costs.
// ⚠️ Cells inside an evicted chunk are removed from every activity Set as well. Leaving them would keep the room in
// `cellRooms.fine` with indices whose pages no longer exist — the sim would read them back as zeros and churn.
function encodeChunk(s, p) {
  const out = { r: [], a: null };
  for (const f of ['terrain', 'terrainHp']) {                     // RLE — a chunk is mostly one material or empty
    const page = s[f] && s[f].pageAt(p);
    if (!page) { out.r.push(null); continue; }
    const runs = []; let v = page[0], n = 0;
    for (let k = 0; k < page.length; k++) { if (page[k] === v) n++; else { runs.push(v, n); v = page[k]; n = 1; } }
    runs.push(v, n); out.r.push(runs);
  }
  const amt = s.fineAmt && s.fineAmt.pageAt(p);                   // sparse — liquid occupies few cells of a chunk
  if (amt) { const a = []; for (let c = 0; c < CHUNK_CELLS; c++) { const b = c * LIQ_T; let any = 0; for (let k = 0; k < LIQ_T; k++) any |= amt[b + k];
    if (any) { a.push(c); for (let k = 0; k < LIQ_T; k++) a.push(amt[b + k]); } } out.a = a; }
  return out;
}
// 🟥 A HOOK, NOT A DIRECT CALL — the sliced-block boundary for the TENTH time on this track. `decodeChunk`
// lives inside the block `probe_chunking` and `probe_budget` slice out of this file and run in a bare
// `new Function`; `genVersion` lives outside it, beside `_genRooms`. Calling it directly was a ReferenceError
// in the rigs and nowhere else. So it is declared HERE as a no-op that reproduces the old global behaviour
// exactly, and reassigned below to the real thing — the `wireFanout` seam this file already establishes, which
// `probe_worldgen` guards as a CLASS rather than as a list of one-offs.
let genVersion = () => WORLDGEN.WORLDGEN_VERSION;
// ⚠️ `ver` is the version of the generator THIS ROOM was made by, passed in rather than read from a global.
// Two generators can now be live at once (worldgen.js and worldgen2.js), so "the current version" is not a
// property of the process — it is a property of the room. A diff is meaningless without the ground it was
// taken against, and applying one to the other generator's rock is exactly the silent corruption
// WORLDGEN_VERSION exists to make detectable.
function decodeChunk(s, p, blob, room) {
  // ⭐ 4d: a DIFF is applied ON TOP of the ground the generator just rebuilt, rather than replacing it. The
  // base is always there by the time this runs — every path into here faults the page first, and faulting a
  // page of a generated room runs the generator (see genSeedFn). ⚠️ Only the listed cells are written; the
  // rest of the page is deliberately left exactly as the generator made it.
  if (blob.d) {
    // ⚠️ LOOKED UP HERE, INSIDE `if (blob.d)`, NOT PASSED IN AS AN ARGUMENT. An argument is evaluated eagerly,
    // so it ran even for blobs with no diff — and in the probe rigs, which slice this block out and run it
    // without the module's requires, that turned a line that had never executed into a ReferenceError. The
    // original control flow reached this only when there was a diff to check, and it still does.
    if (blob.v !== genVersion(room)) return;             // taken against different ground — see WORLDGEN_VERSION
    const tp = s.terrain && s.terrain.wpPage(p), hpp = s.terrainHp && s.terrainHp.wpPage(p);
    if (tp) for (let k = 0; k < blob.d.length; k++) { tp[blob.d[k]] = blob.m[k]; if (hpp) hpp[blob.d[k]] = blob.hp[k]; }
    if (blob.a && blob.a.length && s.fineAmt && s.fineTotal) {
      const amt = s.fineAmt.wpPage(p), tot = s.fineTotal.wpPage(p);
      for (let q = 0; q < blob.a.length; q += (1 + LIQ_T)) { const c = blob.a[q], b = c * LIQ_T; let sum = 0;
        for (let k = 0; k < LIQ_T; k++) { const v = blob.a[q + 1 + k]; amt[b + k] = v; sum += v; } tot[c] = sum > 255 ? 255 : sum; }
    }
    return;
  }
  for (let fi = 0; fi < 2; fi++) {
    const runs = blob.r[fi], f = ['terrain', 'terrainHp'][fi];
    if (!runs || !s[f]) continue;
    const page = s[f].wpPage(p);
    let k = 0; for (let q = 0; q + 1 < runs.length; q += 2) { const v = runs[q], n = runs[q + 1]; for (let z = 0; z < n && k < page.length; z++) page[k++] = v; }
  }
  if (blob.a && blob.a.length && s.fineAmt && s.fineTotal) {
    const amt = s.fineAmt.wpPage(p), tot = s.fineTotal.wpPage(p);
    for (let q = 0; q < blob.a.length; q += (1 + LIQ_T)) { const c = blob.a[q], b = c * LIQ_T; let sum = 0;
      for (let k = 0; k < LIQ_T; k++) { const v = blob.a[q + 1 + k]; amt[b + k] = v; sum += v; } tot[c] = sum > 255 ? 255 : sum; }
  }
}
// Mechanism counters for on-demand production — the guards assert on THESE rather than on a wall clock, which
// is a lesson this track has now learned three times (liqRateSkips, liqK2Throttles, and here).
// ⚠️ Declared ABOVE every writer, and `genChunksDropped` is why they had to move: it is written by evictChunk,
// three thousand lines above where the other two were declared. Every writer is inside a function body so
// call-time evaluation was safe either way, but `PAGE_DIMS` and `rpOn` both taught this track that a `let`
// below its reader is a trap not worth setting.
let genLiquidSeeded = 0, genPagesProduced = 0, genChunksDropped = 0, genChunksDeltad = 0, genPowderSeeded = 0, genPowderRewoken = 0;
// ⭐ HOW MANY CELLS THE NEW LATERAL-DENSITY WAKE CONDITION WOKE, and it is here for the reason this track has
// learned three times over (`liqRateSkips`, `liqK2Throttles`, `powderRewoken`): a check that a mechanism WORKED
// is a coin flip unless something reports that the mechanism FIRED. Zero here with a two-liquid lake on screen
// means the condition is not reaching the cells, not that the world is clean.
let genFaceWoken = 0;
// Same seam as chunkDelta / drainGenLiquid / wireFanout, for the fifth time on this track: `onChunkFault` and
// `rehydrateChunk` are inside the block the probe rigs slice into a `new Function`, and the pending set this
// queues into lives with the generator three thousand lines below, outside the slice. A bare call would give a
// ReferenceError in the rigs and nowhere else. No generator ⇒ no eviction-restore to re-wake ⇒ a no-op is the
// right answer for the sliced rigs and for every hand-built room.
let queuePowderReseed = () => {};
// ⚠️ THE SAME SEAM AGAIN (twelfth instance): `restoreChunk` is inside the block the probe rigs slice into a bare
// `new Function`, and `_genPending` lives with the generator three thousand lines below, outside the slice. A
// direct reference is a ReferenceError in the rigs and nowhere else.
// ⭐ WHY A COLD-START RESTORE HAS TO QUEUE AT ALL. `rehydrateChunk` sets `restoring`, which tells the generator's
// seeder "this is a restore, not a birth — do not seed liquid", and for an IN-MEMORY eviction blob that is right:
// the blob carries the whole liquid state. A blob loaded from DISK carries a DIFF, and the ground under it has
// just been generated fresh with no liquid at all — so the generated liquid has to be seeded and the diff then
// laid over it. Without this a chunk you had edited came back after a restart with no water in it whatsoever,
// which is a bug the terrain half shipped with and nobody had noticed.
let queueGenLiquid = () => {};
// ⚠️ THE SAME NO-OP-AND-REASSIGN SEAM, for the same reason (trap #1, ninth time): `genLiquidLoose` lives with
// the generation seeders, outside the chunk-residency block the rigs slice, so a direct reference is a
// ReferenceError in them and nowhere else. Defaulting to TRUE means a sliced rig wakes everything exactly as it
// did before, so no existing guard changes meaning.
let liquidCanMove = () => true;
// ⭐ INCREMENT 4c/4d, ON THE SAME SEAM `wireFanout` AND `drainGenLiquid` USE, FOR THE SAME REASON.
// `evictChunk` lives inside the block the probe rigs slice into a `new Function`, and diffing a chunk against
// the generator needs `worldCfg` and the generator registry, both defined three thousand lines away and
// OUTSIDE the slice. Referencing them directly made every probe_chunking scenario die with a ReferenceError.
// Declared here as "no generator, so no diff", which is also the right answer for the sliced rigs and for
// every hand-built or published room: those store the chunk whole, exactly as they always did.
// Same seam again (see above): evictChunk is inside the sliced block and the generator registry is not.
// "No generator ⇒ no diff ⇒ store the whole chunk", which is exactly right for the sliced rigs and for every
// hand-built room.
let chunkDelta = () => null;
// 🟥 AND THE SAME SEAM FOR THE TRACE FLAG, WHICH IS THE 9th TIME THIS BOUNDARY HAS BEEN CROSSED BY ACCIDENT.
// Three `worldCfg.trace` tests were added to this block for the persistence work, and `worldCfg` is declared
// outside it — so `probe_chunking` has been dying with `ReferenceError: worldCfg is not defined` ever since,
// i.e. a whole guard silently not running. Nothing else notices, because the live server has `worldCfg`.
// ⚠️ DEFAULTS TO FALSE, so a sliced rig simply prints nothing — the same "the default is the right answer for
// the rigs" reasoning as `liquidCanMove` above and `chunkDelta` beside it.
let worldTrace = () => false;
// ⭐⭐ INCREMENT 4d — STORE ONLY THE CELLS THAT DIFFER FROM WHAT THE GENERATOR WOULD PRODUCE.
// 4c throws away a chunk nobody has changed. This is the other half: a chunk somebody HAS changed no longer
// stores all 4,096 cells, only the ones that differ. The rest is recomputed from the seed on the way back in.
// MEASURED (scratchpad/probe_chunk_blob.js): a whole changed chunk costs 18.5KB; the cells a player actually
// changes cost 4 bytes each, so a short tunnel is 0.47KB — **39x smaller** — and a dug-out room is 7.9x
// smaller. Break-even is past 4,700 changed cells of 4,096, i.e. it cannot lose; the fallback below is belt
// and braces rather than a real case.
// ⇒ what the server keeps becomes proportional to what players have BUILT, and to nothing else: not to world
// size, not to how far anyone has walked, not to how many chunks exist.
const _dScratchT = new Uint8Array(CHUNK_CELLS), _dScratchH = new Uint8Array(CHUNK_CELLS);
// 🟥🟥 THIS GENERATION IS THE MOST EXPENSIVE THING THE SERVER DOES PERIODICALLY, AND IT WAS UNCACHED.
// The note below used to read "it costs one generation (~0.35ms) per evicted chunk … on a sweep that runs every
// five seconds", and that number is from `server/worldgen.js`, the ROLLBACK generator — the third stale cost
// figure on this track. The live one is ~2.5ms, and the residency sweep evicts a whole traversal's worth at
// once: MEASURED at `residency sweep took 534ms — 473 resident, 215 evicted`, i.e. 215 × 2.5ms, recurring, on
// the main loop. That is the *"on a long run it gets stalled and has to catch up"* report.
// ⇒ routed through the same page cache the fault path uses (`_genMemo`), where a chunk being evicted or flushed
// has almost certainly just been produced. ⚠️ VIA A HOOK, because `_genMemo` lives outside this sliced
// cell-store block and referencing it directly is the ReferenceError that has bitten this track eight times
// (`saveChunkBlob` immediately below is a no-op-and-reassign for exactly the same reason).
let genPageCached = (gen, p, geom, t, h) => { gen.fillPage(t, h, p, geom, 1); };
function encodeChunkDelta(s, p, gen, geom) {
  const t = s.terrain && s.terrain.pageAt(p), hp = s.terrainHp && s.terrainHp.pageAt(p);
  if (!t) return null;
  _dScratchT.fill(0); _dScratchH.fill(0);
  genPageCached(gen, p, geom, _dScratchT, _dScratchH);
  // 🟥🟥 AN ABSENT HP PAGE MEANS "NOBODY HAS DUG HERE", NOT "EVERY CELL HAS ZERO HIT POINTS".
  // `terrainHp` is a SEPARATE PagedArray from `terrain` and faults in independently, so a chunk nobody has hit
  // has terrain but no hp page at all — and `pageAt` deliberately does not fault one in. Reading that absence
  // as 0 made every solid cell in every untouched chunk differ from the generator's `STRENGTH[v]`, so it was
  // stored as an edit. MEASURED on the live Overworld: of the 40 largest stored chunks, 1,997 cells had a
  // genuinely different material and 78,876 were recorded solely because of this — a ~40x storage bloat, and
  // every one of them stored `hp 0` against a generated strength of 1-4.
  // ⇒ Two consequences, and the second is the serious one. Increment 4d's promise ("what the server keeps is
  // proportional to what players BUILT") was quietly false. And 4c's "pristine = the diff is empty" could never
  // be true, so no chunk was ever thrown away — and every one came back from storage with its rock at ZERO hit
  // points, i.e. one hit from destruction.
  // ⚠️ THIS IS THE SAME MISTAKE `encodeLiquidDelta` MADE AND HAD FIXED ONE DAY EARLIER — an absent liquid page
  // read as "every generated fluid cell is empty", storing a permanent "this lake does not exist". Absence of a
  // page means UNMODIFIED in both cases; it is the generated value that stands, never zero.
  const hpAt = (k) => hp ? hp[k] : _dScratchH[k];
  // One pass to count, so the arrays are allocated at exactly the right size rather than grown.
  let n = 0;
  for (let k = 0; k < CHUNK_CELLS; k++) if (t[k] !== _dScratchT[k] || hpAt(k) !== _dScratchH[k]) n++;
  // 🟥🟥 THIS USED TO `return null`, AND null WAS READ BY `saveChunkBlob` AS "DELETE THE ROW". So a chunk the
  // player had changed 2,048 cells of had its EXISTING SAVED ROW REMOVED on eviction, and came back from the
  // seed — a clean, chunk-aligned hole in whatever they had built. REPRODUCED (scratchpad/e2e_chunk_threshold.js):
  // a 1,920-cell block stores 1,920 cells, is on disk, and then 640 more cells in the same chunk take the row
  // away entirely, while the identical block in the chunk next door keeps its row. The comment that used to sit
  // here said the branch could not be reached ("it cannot be at 4 bytes a cell against an 18.5KB blob") — it was
  // comparing against the in-MEMORY RLE blob, not against the 4-bytes-a-cell diff this actually writes, and a
  // solid 64x40 stone floor reaches it easily.
  // ⭐ THE FALLBACK IS NOW BUILT rather than promised. Past the crossover the chunk is stored WHOLE: every cell's
  // material and hit points, 2 bytes a cell = 8KB flat, which is exactly where the diff stops being cheaper.
  // ⚠️ It is the SAME in-memory shape — d/m/hp with every index listed — so `applyStoredEdit`, `decodeChunk`,
  // `pristine` and the flush need no special case at all. Only the on-disk encoding differs, and the `kind`
  // column that has always been written as 0 is what says which one a row holds.
  const whole = (n * 4 >= CHUNK_CELLS * 2) ? 1 : 0;
  if (whole) n = CHUNK_CELLS;
  const idx = new Uint16Array(n), mat = new Uint8Array(n), dmg = new Uint8Array(n);
  let w = 0;
  for (let k = 0; k < CHUNK_CELLS; k++) {
    const hv = hpAt(k);
    if (!whole && t[k] === _dScratchT[k] && hv === _dScratchH[k]) continue;
    idx[w] = k; mat[w] = t[k]; dmg[w] = hv; w++;
  }
  // The generator version travels WITH the diff. A diff only means anything alongside the ground it was taken
  // against, so when the content redesign changes the generator, a stale diff must be detectable rather than
  // quietly applied to different rock. See WORLDGEN_VERSION in worldgen.js.
  return { v: gen.version || WORLDGEN.WORLDGEN_VERSION, d: idx, m: mat, hp: dmg, a: null, whole };
}
// ⭐ SCALE COUNTER (see liqScanRows in the sim block for the reasoning). Key-deletes done pruning the work sets
// when a chunk is evicted. It MUST stay independent of |fineActive|: the version that walked the whole set made
// eviction more expensive the more there was to do, which is what turns a slow world into a stuck one.
let evictPruneOps = 0;
// ⚠️ THE PERSISTENCE HOOKS, declared INSIDE the sliced block as no-ops and reassigned below it at load. This is
// the `wireFanout` seam, and it is here because `evictChunk` / `restoreChunk` live inside the block that
// `probe_chunking` and `probe_budget` cut out and run in a bare `new Function` — where `db` does not exist. A
// direct call is a ReferenceError in the rigs and nowhere else, which is the trap this file has hit ten times.
// The no-op default is also the correct behaviour for the rigs: they test in-memory eviction, not durability.
let saveChunkBlob = () => {};
let loadChunkBlobFor = () => null;
let applyStoredEdit = () => {};
function evictChunk(room, p) {
  const s = roomCells.get(room); if (!s || !s.terrain) return false;
  const ch = chunksOf(room);
  const anyLive = CHUNK_CONTENT.some(f => s[f] && s[f].pageAt(p));
  if (!anyLive) return false;                // nothing to put away; do not mark it evicted (it has no blob)
  const rec = ch.at(p);
  rec.evHash = chunkHash(room, p);           // ⚠️ BEFORE the pages go — see ChunkRec.evHash
  // ⭐⭐ INCREMENT 4c. A chunk of a generated world that nobody has changed is not stored at all — it is thrown
  // away and produced again from the seed if it is ever needed. That is what makes memory scale with what
  // players have BUILT rather than with everywhere they have BEEN.
  // 🟥 IT IS NOT AN OPTIMISATION, IT IS A FIX. Measured (scratchpad/probe_chunk_blob.js): on generated terrain
  // the RLE blob is **1.93x the raw pages it replaces** — 16.3KB against 8.4KB — because only 5 chunks in 133
  // are uniform enough to compress, and every run costs two JS numbers where a cell costs one byte. Evicting a
  // generated chunk currently COSTS memory. RLE was chosen for hand-built worlds, which are mostly flat fills;
  // it is the wrong encoding for noisy generated ground, and the content redesign will make it noisier.
  // ⚠️ `evHash` still matters, and is still taken BEFORE the drop: an evicted chunk answers hash queries from
  // it, so the delta-persistence signature stays stable and autosave keeps skipping an unchanged world.
  // ⭐⭐ ONE GENERATE-AND-DIFF DECIDES BOTH QUESTIONS, and that replaced a revision-counting scheme that was
  // subtly and intermittently WRONG. The old test asked "has any page revision changed since the generator
  // produced this?", recording the revisions at production. But a chunk restored FROM a diff has its base
  // regenerated and the diff written on top — and the recording happened during that restore, AFTER the writes
  // that brought it back. So a chunk that had just been restored from somebody's edit looked untouched, and
  // the next eviction threw the edit away. It failed roughly one run in four, in both directions: the hole
  // filling back in, and untouched ground coming back as air.
  // The replacement has no bookkeeping to get wrong: generate the chunk, compare, and "nobody changed it" is
  // simply "the comparison found nothing". It costs one generation (~0.35ms) per evicted chunk — which the
  // diff was going to pay anyway — on a sweep that runs every five seconds.
  const _d = chunkDelta(room, p);
  // ── THE EDIT TRACE, half two: does the server think anybody has touched this chunk? ────────────────────
  // This is the OTHER way a dug hole comes back, and it is invisible from the outside: the diff comes out
  // empty, the chunk is thrown away rather than stored, and the next visit rebuilds it from the seed. If a
  // chunk somebody just dug in reports `pristine`, that is the bug, stated in one line.
  if (worldTrace()) console.log(`[trace] evict chunk ${p}: ${_d ? (_d.pristine ? 'PRISTINE — thrown away, will regenerate from the seed'
    : (_d.d ? _d.d.length : 0) + ' changed cell(s) stored') : 'no diff (not a generated room) — stored whole'}`);
  rec.gen = (_d && _d.pristine) ? 1 : 0;
  rec.blob = rec.gen ? null : (_d || encodeChunk(s, p));
  if (rec.gen) genChunksDropped++;
  // ⭐ PERSISTENCE. A chunk is evicted precisely when nobody is looking at it, and the diff has just been
  // computed anyway, so this is the seam that costs nothing extra. A pristine chunk stores NOTHING — it is
  // re-derived from the seed — which is what keeps the database proportional to what players built.
  // ⚠️ Through a hook: `saveChunkBlob` is a no-op declared below and reassigned outside this block, because the
  // probe rigs slice this block out and run it without the module's `db`. Tenth instance of that trap.
  // ⚠️ CALLED EVEN WHEN THERE IS NOTHING TO SAVE. A chunk that has gone back to being pristine — somebody filled
  // their hole in — must DROP any row it used to have, or the next restart re-applies a diff describing a hole
  // that is no longer there. The hook decides; `null` is "store nothing, and forget whatever was stored".
  // ⚠️ THE FOURTH ARGUMENT IS THE WHOLE POINT: only `_d.pristine` — the generate-and-compare finding nothing —
  // may delete the stored row. `rec.blob` here can also be `encodeChunk`'s RLE (a room with no generator, or a
  // chunk whose terrain page had already gone), which has no `.d` and used to reach the same deletion.
  saveChunkBlob(room, p, (!rec.gen && rec.blob) ? rec.blob : null, rec.gen ? 1 : 0);
  rec.savedHash = rec.evHash;                // …and it is now written, so the periodic flush can skip it
  ch.evicted[p] = 1;
  for (const f of CHUNK_CONTENT) if (s[f]) s[f].dropPage(p);
  for (const f of CHUNK_SCRATCH) if (s[f] && s[f].geom.nPages === worldGeom(room).nPages) s[f].dropPage(p);
  // Drop this chunk's cells from the work sets, and release a set that empties (same contract as dropFineActive).
  pruneChunkWork(room, p);
  return true;
}
// ⭐⭐ STOP SIMULATING A CHUNK WITHOUT PUTTING IT AWAY (2026-08-06). Eviction conflates two different things —
// "nobody can see this, stop spending CPU on it" and "nobody can see this, release its memory" — and only the
// second one needs to wait out a grace period. MEASURED (scratchpad/probe_evict_grace.js), walking a stretch of
// Overworld and then standing 20 chunks away:
//      grace 30s   queue drains at 26s   14.8 ms/tick while away   4,741KB to come back
//      grace  0s   queue drains at  4s    0.8 ms/tick while away   4,527KB to come back
// 🟥 The grace costs EIGHTEEN TIMES the CPU — 14.8ms of a 40ms tick spent on ground nobody is looking at, for
// half a minute after they leave — and buys nothing on the wire: the 4.7% between those byte figures is smaller
// than the ±3% spread within each setting. That is not a rig artefact, it is BY CONSTRUCTION since increment 3d,
// which made re-entry always re-send ("a windowed client FORGETS a chunk the moment it leaves, so 'the chunk did
// not change' now says nothing about whether the client has it"). The grace's entire purpose was to make turning
// around free; 3d removed the mechanism that made that true, and nothing re-examined the grace afterwards.
// ⇒ so split them. The work set is pruned at the FIRST sweep after a chunk leaves everyone's view; the chunk
// itself stays resident for the full grace, so coming back still needs no restore, no decode and no generation.
// ⚠️ The rewake is the whole risk, and it is the same risk `rehydrateChunk` already carries: under-waking leaves
// liquid visibly hanging until something disturbs it. So the wake is deliberately a SUPERSET (everything that
// could move) and uses the identical rule, `liquidCanMove` + `queuePowderReseed`, rather than a second one.
// ⚠️ Behaviour: liquid in an unwatched chunk stops flowing. That is not new — eviction has always done exactly
// this, 30 seconds later — and it is the same contract as the unoccupied-room deferral: a world nobody is in
// costs nothing. Flow ARRIVING from a watched neighbour still wakes these cells normally, via wakeAround.
let chunkQuietCount = 0, chunkRewakeCount = 0;   // diagnostics: how much ground has been put to sleep, and re-woken
function quiesceChunk(room, p) {
  const s = roomCells.get(room); if (!s || !s.terrain) return false;
  const ch = chunksOf(room), rec = ch.at(p);
  if (rec.quiet) return false;
  rec.quiet = 1; chunkQuietCount++;
  pruneChunkWork(room, p);
  return true;
}
// …and the other half: this chunk is in view again, so put back what can move. Nothing was lost — the cells are
// exactly as they were — so this is a WAKE, never a restore.
function rewakeChunk(room, p) {
  const ch = chunksOf(room), rec = ch.peek(p);
  if (!rec.quiet) return false;
  ch.at(p).quiet = 0; chunkRewakeCount++;
  const s = roomCells.get(room); if (!s || !s.fineTotal) return true;
  // ⚠️ `pageAt`, NOT `.g()`. A measurement or a housekeeping pass must never FAULT a page — on a generated room
  // that produces the chunk, which is the cascade that cost 31.8 seconds of tick time in empty sky. An absent
  // page means there is no liquid here to wake, which is the correct answer and a free one.
  const tp = s.fineTotal.pageAt(p), ap = s.fineAmt && s.fineAmt.pageAt(p);
  if (!tp) { queuePowderReseed(room, p); return true; }
  const geom = worldGeom(room), act = fineSet(room);
  const pc0 = ((p / geom.cy) | 0) * CHUNK_SIDE, pr0 = (p % geom.cy) * CHUNK_SIDE;
  const pcN = Math.min(CHUNK_SIDE, geom.cols - pc0), prN = Math.min(CHUNK_SIDE, geom.rows - pr0);
  for (let lr = 0; lr < prN; lr++) for (let lc = 0; lc < pcN; lc++) {
    const off = lr * CHUNK_SIDE + lc;
    if (!tp[off]) continue;                                  // no liquid in this cell
    const i = (pc0 + lc) * geom.rows + (pr0 + lr);
    let rid = 0;
    if (ap) for (let rk = 0; rk < LIQ_T; rk++) if (ap[off * LIQ_T + rk] > 0) { rid = LIQ_ID[rk]; break; }
    if (liquidCfg.genWakeAll || !rid || liquidCanMove(s.terrain, i, geom, rid)) act.add(i);
  }
  queuePowderReseed(room, p);
  return true;
}
// The prune itself, shared by eviction and quiescing — one implementation, so the two cannot drift about which
// work sets exist. (Split out 2026-08-06; the body and every comment below are unchanged.)
function pruneChunkWork(room, p) {
  const s = roomCells.get(room); if (!s) return;
  const geom = worldGeom(room);
  // 🟥 THIS WAS 19.6% OF ALL SERVER CPU — measured, not reasoned about (GET /debug/cpu-profile while panning
  // across the Overworld). It used to be `for (const i of Array.from(set)) if (geomPage(geom, i) === p) ...`:
  // a walk of the ENTIRE work set to find the handful of cells belonging to ONE chunk, five sets deep, once per
  // evicted chunk — plus an `Array.from` copy of a 200,000-element Set each time. Moving is what evicts chunks,
  // so it fired in bursts exactly when the player moved, which is when the freeze was worst.
  // ⚠️ IT GOT WORSE THE MORE THERE WAS TO DO, which is the property that turns a slow world into a stuck one:
  // cost was O(evicted chunks × |fineActive|), and `fineActive` grows to six figures in the Overworld.
  // ⭐ A CHUNK HAS EXACTLY 4,096 CELLS AND WE KNOW WHICH. So ask the SET about the chunk's cells rather than
  // asking every cell in the set about the chunk: 4,096 O(1) deletes, independent of how big the set is. The
  // set-walk is kept for the case where the set is genuinely smaller than a chunk, which is the common one in a
  // page room — this must not become a pessimisation there.
  const cy = geom.cy, pc0 = ((p / cy) | 0) * CHUNK_SIDE, pr0 = (p % cy) * CHUNK_SIDE;
  const pcN = Math.min(CHUNK_SIDE, geom.cols - pc0), prN = Math.min(CHUNK_SIDE, geom.rows - pr0);
  const pruneKeys = (del, size) => {
    if (size < CHUNK_CELLS) { evictPruneOps += size; for (const i of Array.from(del.keys ? del.keys() : del)) if (geomPage(geom, i) === p) del.delete(i); return; }
    evictPruneOps += pcN * prN;
    for (let lc = 0; lc < pcN; lc++) { const base = (pc0 + lc) * geom.rows + pr0; for (let lr = 0; lr < prN; lr++) del.delete(base + lr); }
  };
  const prune = (set, drop) => { if (!set) return; pruneKeys(set, set.size); if (!set.size) drop(room); };
  prune(s.fineActive, dropFineActive); prune(s.fineReact, dropFineReact); prune(s.fineFire, dropFineFire);
  prune(s.powderActive, dropPowderSet); prune(s.soilActive, dropSoilSet);
  if (s.src) { pruneKeys(s.src, s.src.size); if (!s.src.size) dropSrcMap(room); }
}
// ⚠️⚠️ ANYTHING THAT READS THE WHOLE WORLD MUST CALL THIS FIRST. An evicted chunk has no pages, so it reads as
// ZEROS — which would serve a joining client empty terrain and, through autosave, WRITE EMPTINESS TO THE DB for a
// persistent published world. That is data loss, and it is why eviction stayed off until this existed.
// (`chunkHash` does not need it: it serves the hash taken before the pages went. That matters — it keeps the
//  delta-persistence signature stable, so autosave SKIPS an unchanged evicted world instead of materialising it
//  every 30s and undoing eviction entirely.)
// ⚠️ It does undo eviction for the room. That is correct rather than wasteful — these callers genuinely need the
// whole world today — and the residency sweep re-evicts on its next pass. Phase 4 (interest-limited replication)
// removes the whole-world join replay that is the main caller.
function materializeRoom(room) {
  const s = roomCells.get(room); if (!s || !s.chunks) return;
  const ch = s.chunks;
  // Only chunks something has happened to have a record, so this is O(touched chunks), not O(world area).
  // ⚠️ BOTH KINDS. Increment 4c added chunks that were dropped rather than encoded, and to a whole-world reader
  // a dropped chunk is indistinguishable from empty world — which is exactly the failure Phase 3 recorded when
  // eviction first shipped (terrain replayed empty, and autosave wrote the emptiness to the database).
  // Still O(touched chunks), not O(world area): only chunks something has happened to have a record.
  for (const [p, r] of Array.from(ch.rec)) if (r.blob || r.gen) restoreChunk(room, p);
}
// ⭐ INCREMENT 4c. What a page fault does about an evicted chunk, now that there are two kinds. A chunk put
// away as a BLOB has to be decoded; a chunk that was simply dropped because it still matched the generator has
// ALREADY been rebuilt by the seed function that ran a few lines earlier in `_alloc`, so all that is left is to
// stop calling it evicted. Getting that wrong leaves `evicted[p]` set on a chunk whose pages are back, and
// `chunkHash` then keeps answering from the stale `evHash` for ever.
function onChunkFault(room, p) {
  const rec = chunksOf(room).peek(p);
  if (rec.blob) return rehydrateChunk(room, p);
  if (rec.gen) {
    // …and the moment it actually happens: this chunk is coming back from the SEED, not from anything stored.
    if (worldTrace()) console.log(`[trace] chunk ${p} faulted back in FROM THE SEED (it was thrown away as unchanged)`);
    chunksOf(room).evicted[p] = 0; rec.gen = 0; queuePowderReseed(room, p); return true;
  }
  return false;
}
// "Make sure this chunk is really here", for callers that are about to read it out. Blob → decode; dropped as
// pristine → touch one cell, which faults the page and runs the generator.
function restoreChunk(room, p) {
  const rec = chunksOf(room).peek(p);
  if (rec.blob) return rehydrateChunk(room, p);
  // ⭐ PERSISTENCE, THE READ HALF. After a restart nothing is in memory, so a chunk somebody built in comes back
  // from the database instead.
  // 🟥🟥 AND IT MUST ONLY HAPPEN WHEN WE ARE HOLDING NOTHING. The guard used to be "there is no in-memory blob",
  // on the reasoning that "a running server never touches disk on this path — the DB is the cold-start source,
  // not a second cache". That reasoning is wrong, and it was destroying player work every few minutes: a
  // RESIDENT chunk has no in-memory blob either. So every time anybody re-entered an area, `sendChunkContent`
  // called this for each chunk, found no blob, read the stored row, and laid a diff written MINUTES AGO back
  // over live pages — silently undoing everything dug or built since that row was written. Reproduced with the
  // edit trace: `carve … 25 were solid → 25 now air` immediately followed by `restore … disk HIT` and
  // `rehydrate … applying stored blob (469 diff cells)`, the same 469 as before the dig, and the hole was gone.
  // It is INTERMITTENT because it needs the row to exist and the area to be re-entered, which is why digging
  // sometimes sticks and sometimes does not, and why it always looked like generated ground coming back.
  // ⇒ the real question is "do we hold this chunk at all", which is the same test `evictChunk` asks before it
  // decides there is anything to put away. If any page is live, the live pages ARE the truth and the database
  // is a stale snapshot of them.
  // ⚠️ A hit is turned into exactly the in-memory shape `rehydrateChunk` already expects, so there is one decode
  // path rather than two that can disagree.
  const _s0 = roomCells.get(room);
  const _held = !!(_s0 && CHUNK_CONTENT.some(f => _s0[f] && _s0[f].pageAt(p)));
  if (!rec.blob && !_held) {
    const fromDisk = loadChunkBlobFor(room, p);
    if (worldTrace()) console.log(`[trace] restore chunk ${p}: nothing held, disk ${fromDisk ? 'HIT' : 'miss'}, gen=${rec.gen}, evicted=${chunksOf(room).evicted[p]}`);
    // ⚠️ A DISK BLOB IS NOT AN EVICTION BLOB. It holds a terrain DIFF and a liquid DIFF, over ground that is about
    // to be generated fresh — so unlike a restore from memory it needs the generator's own liquid seeding to run
    // first, with the stored diff applied over the top on the deferred pass. See queueGenLiquid.
    // 🟥🟥 `at(p)`, NOT the `rec` from `peek` ABOVE, AND THIS WAS SILENTLY THROWING AWAY EVERYTHING ANYBODY
    // BUILT. `peek` answers `NO_CHUNK_REC` for a chunk nothing has happened to — and that object is
    // `Object.freeze`d. This file is not in strict mode, so `rec.blob = fromDisk` on it is not an error, it is
    // a NO-OP: the row was read out of the database, assigned to a frozen shared object, and dropped on the
    // floor. `rehydrateChunk` then found no blob, applied nothing, and the chunk read as freshly generated
    // ground — so a dug-out hole came back, permanently, every time that chunk had to come from disk.
    // ⚠️ It is INTERMITTENT, which is why it survived: a chunk that already has a record for any other reason
    // (it was produced, evicted, or touched this session) gets a real, writable one from `peek` and restores
    // correctly. Only the cold path — no record, straight from the database — silently lost the edit.
    // ⚠️ `at` creates the record, which is exactly what "this chunk now has a blob" means.
    if (fromDisk) { const r2 = chunksOf(room).at(p); r2.blob = fromDisk; r2.gen = 0; const ok = rehydrateChunk(room, p); queueGenLiquid(room, p); return ok; }
  }
  if (!rec.gen) return false;
  const s = roomCells.get(room); if (!s || !s.terrain) return false;
  const g = worldGeom(room);
  s.terrain.g((((p / g.cy) | 0) * CHUNK_SIDE) * g.rows + (p % g.cy) * CHUNK_SIDE);
  return true;
}
function rehydrateChunk(room, p) {
  const s = roomCells.get(room); if (!s) return false;
  const ch = chunksOf(room), rec = ch.peek(p), blob = rec.blob;
  if (worldTrace()) console.log(`[trace] rehydrate chunk ${p}: ${blob ? 'applying stored blob (' + (blob.d ? blob.d.length + ' diff cells' : 'whole') + ')' : 'NO BLOB — nothing to apply'}`);
  if (!blob) return false;                   // (a blob implies a record, so `rec` here is never the shared empty)
  rec.blob = null; ch.evicted[p] = 0;
  // 🟥 `restoring` EXISTS BECAUSE OF A REAL BUG, and the flag ordering above is what caused it. Decoding
  // faults the page back in, and for a generated room faulting a page RUNS THE GENERATOR — which queues that
  // chunk's generated lakes for liquid seeding. But `evicted[p]` has already been cleared two lines up (it has
  // to be, or `_alloc` would recurse straight back into here), so the "is this a restore rather than a birth?"
  // test in genSeedFn saw a birth. The stored liquid would then be overwritten on the next tick by whatever
  // the generator says should be there — resurrecting a pool somebody had drained. Not reachable through
  // `_alloc` (the page is installed before the flag is cleared), but very reachable through `restoreChunk`,
  // which is what `sendChunkContent` calls.
  rec.restoring = 1;
  try { decodeChunk(s, p, blob, room); } finally { rec.restoring = 0; }
  // Liquid that comes back is WOKEN, not re-seeded: it resumes flowing from exactly the state it was put away in.
  const amt = s.fineAmt, tot = s.fineTotal;
  // 🟥 THIS WOKE EVERY LIQUID CELL IN THE CHUNK, UNCONDITIONALLY — up to 4,096 of them, for every chunk you
  // walk back into. Reported as "as I move down it jumps back up to thousands upon thousands", and that is
  // exactly what it is: cross twenty lake chunks and eighty thousand cells re-enter the queue at once.
  // ⭐ THE FIX IS A RULE THAT ALREADY EXISTS AND WAS ONLY APPLIED AT THE OTHER SITE. `seedGenChunkLiquid` used
  // to do the identical unconditional wake and was changed to `genLiquidLoose` — wake only liquid that can
  // actually MOVE (air below, a lighter fluid below, or air beside). MEASURED there at 99.5% of generated liquid
  // being already at rest. A restored lake is a lake: it should wake nothing.
  // ⚠️ Same conservative bias as the generation site: it wakes a superset of what must move, because
  // under-waking leaves liquid visibly hanging until something disturbs it, which is far worse than a little
  // extra work. And `genLiquidLoose` peeks rather than reading, so it cannot produce the chunk next door.
  if (blob.a && blob.a.length && amt && tot) { const act = fineSet(room), geom = worldGeom(room);
    for (let q = 0; q < blob.a.length; q += (1 + LIQ_T)) { const c = blob.a[q];
      const lr = (c / CHUNK_SIDE) | 0, lc = c % CHUNK_SIDE;
      const gr = (p % geom.cy) * CHUNK_SIDE + lr, gc = ((p / geom.cy) | 0) * CHUNK_SIDE + lc;
      if (gr >= geom.rows || gc >= geom.cols) continue;
      const i = gc * geom.rows + gr;
      let rid = 0; for (let rk = 0; rk < LIQ_T; rk++) if (blob.a[q + 1 + rk] > 0) { rid = LIQ_ID[rk]; break; }
      if (liquidCfg.genWakeAll || !rid || liquidCanMove(s.terrain, i, geom, rid)) act.add(i); } }
  // ...and so is POWDER, for the same reason and by a different route. See queuePowderReseed.
  queuePowderReseed(room, p);
  return true;
}
// ── HARNESS SEAM ── the probe rigs build scenes by assigning whole arrays per room (`roomTerrain[R] = new
// Uint8Array(…)`) and read them back the same way. `cellView` hands back an object with exactly that shape, backed by
// the store, so those rigs keep their scene code and their assertions verbatim — the guards go on guarding the sim
// rather than being rewritten alongside it. Nothing in the server itself uses it.
// PHASE 3: the backing fields are PagedArrays now, so the per-room value is wrapped in `flatView` — a Proxy that
// makes a paged field respond to `a[i]`, `a[i] = v`, `a.length` and `a.fill(v)` exactly as the flat array did.
// It is DELIBERATELY the slow path: only rig scene-building and rig assertions go through it, never the sim, which
// holds the PagedArray directly. Assigning a whole flat array (`roomTerrain[R] = new Uint8Array(N)`) IMPORTS it.
const _flatViews = new WeakMap();
function flatView(pa) {
  if (!(pa instanceof PagedArray)) return pa;
  let v = _flatViews.get(pa); if (v) return v;
  v = new Proxy(pa, {
    get: (t, k) => {
      if (typeof k === 'string') { const n = +k; if (n === n) return t.rp(n / t.T | 0)[t.o(n / t.T | 0) + (n % t.T)]; }
      const val = t[k]; return typeof val === 'function' ? val.bind(t) : val;
    },
    set: (t, k, val) => {
      if (typeof k === 'string') { const n = +k; if (n === n) { const c = n / t.T | 0; t.wp(c)[t.o(c) + (n % t.T)] = val; return true; } }
      t[k] = val; return true;
    },
  });
  _flatViews.set(pa, v); return v;
}
// How each per-cell field is built. One table so the `ensure*` helpers, eviction and the harness seam cannot drift
// apart on element type or stride. (`fineLevelAcc` carries a per-index phase rather than zero — see seedLevelAcc.)
function seedLevelAcc(page, p, geom, _T) {
  const cx0 = ((p / geom.cy) | 0) * CHUNK_SIDE, cy0 = (p % geom.cy) * CHUNK_SIDE;
  for (let lr = 0; lr < CHUNK_SIDE; lr++) { const gr = cy0 + lr; if (gr >= geom.rows) break;
    for (let lc = 0; lc < CHUNK_SIDE; lc++) { const gc = cx0 + lc; if (gc >= geom.cols) break;
      page[lr * CHUNK_SIDE + lc] = ((Math.imul(gc * geom.rows + gr, 2654435761)) >>> 0) / 4294967296; } }
}
function newPagedField(field, geom, room) {
  let pa = null;
  switch (field) {
    case 'terrain': case 'terrainHp': case 'sat': case 'fineTotal': case 'fineFluxSeen': pa = new PagedArray(geom, Uint8Array, 1, null, room); break;
    case 'dilute': pa = new PagedArray(geom, Float32Array, 1, null, room); break;
    case 'fineAmt': pa = new PagedArray(geom, Uint8Array, LIQ_T, null, room); break;
    case 'fineLevelAcc': pa = new PagedArray(geom, Float32Array, 1, seedLevelAcc, room); break;
    case 'fineStill': pa = new PagedArray(geom, Uint16Array, 1, null, room); break;
    default: return null;
  }
  // Only wire the evicted flags when this field is on the CHUNK GRID. A fine field built at SUB≠1 (probe rigs) has a
  // different page count, so indexing the room's flags with its page numbers would be nonsense.
  if (pa && room && geom.nPages === worldGeom(room).nPages) pa.ev = chunksOf(room).evicted;
  return pa;
}
const FINE_FIELDS = new Set(['fineAmt', 'fineTotal', 'fineLevelAcc', 'fineStill', 'fineFluxSeen']);
// Phase 6: the shape comes off the STORE, not the module constants — `s` is the room's own RoomCells.
function fieldGeom(field, s) {
  const SUB = (FINE_FIELDS.has(field) ? (s.fineSub || 1) : 1);
  return chunkGeom(s.cols * SUB, s.rows * SUB);
}
function cellView(field) {
  return new Proxy({}, {
    get: (_t, room) => (typeof room === 'string' ? flatView(cellsOf(room)[field]) : undefined),
    set: (_t, room, v) => {
      if (typeof room !== 'string') return true;
      const s = cellsOf(room);
      // A rig assigning a plain typed array IMPORTS it cell by cell (that is how the scenes are built), faulting the
      // field into existence first if it is not there yet. Only non-zero cells are written, so an empty scene costs
      // no pages — which is also what makes the rigs a fair test of the sparse path.
      if (v && v.length !== undefined && !(v instanceof PagedArray) && typeof v !== 'string') {
        const pa = (s[field] instanceof PagedArray) ? s[field].fill(0) : (s[field] = newPagedField(field, fieldGeom(field, s), room));
        if (pa) { for (let n = 0; n < v.length; n++) if (v[n]) { const c = (n / pa.T) | 0; pa.wp(c)[pa.o(c) + (n % pa.T)] = v[n]; } return true; }
      }
      s[field] = v; return true;
    },
  });
}
// ==CELL_STORE_BLOCK_END==
// ⭐ WHERE A SITE LANDS (Phase 6 increment 6). One column per site; the row is wherever the ground is there.
// See server/domains.js for the whole design — it is an ALLOCATION keyed on the page's permanent identity, not a
// pure hash, because the design's rule is "identity is permanent, LOCATION IS REVOCABLE".
// ⚠️ DELIBERATELY OUTSIDE THE CELL-STORE BLOCK ABOVE. The probe rigs slice that block into a bare `new Function`,
// so a module-level `require` referenced from inside it is a ReferenceError there and nowhere else — the same
// sliced-block boundary that has now bitten this track four times (F15). Nothing in the block needs the registry:
// `roomDims` only needs the SHAPE, and the only reader is `spawnXOf`, which is out here too.
// ⚠️ INERT TODAY: nothing places anything, because `overworldRooms` is empty and the Overworld cannot be entered.
// The registry is in memory and does not survive a restart — deliberate, and fine while the Overworld does not
// either. When it needs to persist it is one table (identity, col, sep) and `domains.all()` is the dump.
// ⚠️ THE BASE SEPARATION CAME DOWN FROM 30,720 px TO 10,240 px, AND IT WAS A MEASUREMENT THAT MOVED IT.
// 30,720 (one page-world of neighbourhood plus one of wilderness) is what §3 called generous, but the curated
// head of the internet is ~89 sites averaging weight 1.6, and at 30,720 each that demands ~4.4M px against a
// world 4.19M px wide. The categories overflowed into one another and the layout came out shuffled — social
// between reference and news — which is how it was found.
// ⭐ It is a BASE, not a flat rule: a site's radius is `spacing × weight`, so the giants still get 30,720 px
// (weight 3) while an ordinary site starts at 10,240. That is the user's own model — a high-traffic site starts
// with a bigger radius, meaning more room to scatter its arrivals, NOT a bigger claim on land. Territory is
// still never granted; it grows from activity.
const domainCfg = { spacingPx: 10240 };
// ⚠️ HOOKS, NOT `db` DIRECTLY, for the reason this file records nine times over: the persistence code lives in
// its own section far below, and a `db.prepare` evaluated up here would run before that section has decided what
// the tables are. Declared as no-ops and reassigned down there (search `domainRowWrite =`).
let domainRowWrite = () => {}, domainRowDrop = () => {};
const domains = DOMAINS.makeDomains({
  cols: OVERWORLD_DIMS.cols, rows: OVERWORLD_DIMS.rows, cell: TERRAIN_CELL, spacingPx: domainCfg.spacingPx,
  onPlace: (rec) => domainRowWrite(rec), onRelease: (rec) => domainRowDrop(rec),
});
// ⭐ AND ITS TWIN FOR `.test` HOSTS (see OVERWORLD_TEST_ROOM). Same geometry and the same ladder, so a harness
// exercises the identical allocation code — but NO persistence hooks, deliberately: a test identity is used once
// and never again, and the six dead `e2e-restart-*.test` rows that had accumulated in `domain_sites` were
// holding columns beside the player's own site. A registry that forgets on restart is the right lifetime here.
const domainsTest = DOMAINS.makeDomains({
  cols: OVERWORLD_DIMS.cols, rows: OVERWORLD_DIMS.rows, cell: TERRAIN_CELL, spacingPx: domainCfg.spacingPx,
});
// ⭐ THE PRIMA LEDGER, instantiated HERE for the same reason `domains` is: `probe_domains` B asserts that a
// module-level require is not USED inside the sliced cell-store block, because instantiating one in there is a
// ReferenceError in every rig and nowhere else — this project has hit that exact shape five times now. The
// registry above is the precedent; this sits beside it deliberately.
const ledger = new LEDGER.Ledger(db);
// A player key: `d:` for a logged-in identity (persisted across restarts), `s:` for an anonymous socket
// (ephemeral, gone when they go). ⚠️ ONE definition, because the credit path, the spend path and the wire all
// have to agree about whose balance they are touching, and a second copy of this rule is a way to pay one
// player and charge another.
function playerKeyFor(socketId) {
  const d = socketToDiscordId[socketId];
  return d ? 'd:' + d : 's:' + socketId;
}
// Where the economy applies. ⚠️ MUST MATCH THE CLIENT'S `invGated()`, which is `!!avOverworld` — the placer,
// the preview, the material picker and now the server's debit all have to agree about which world they are in,
// or the client shows a cost the server does not charge (or worse, the reverse).
function invGatedRoom(room) { return !!room && overworldRooms.has(room); }
// ⚠️ The room is PASSED, not looked up: a socket's avatar room lives in the connection closure
// (`currentAvatarRoom`) and there is no global map of it. Inventing one here would be a second source of truth
// for which room a socket is in, which is exactly the kind of drift this file keeps getting bitten by.
function sendInvSync(socket, room) {
  const snap = ledger.snapshot(playerKeyFor(socket.id));
  socket.emit('inv-sync', { prima: snap.prima, mats: snap.mats, gated: invGatedRoom(room) });
}
function ensureTerrain(room) { const s = cellsOf(room); return s.terrain || (s.terrain = newPagedField('terrain', worldGeom(room), room)); }
function ensureTerrainHp(room) { const s = cellsOf(room); return s.terrainHp || (s.terrainHp = newPagedField('terrainHp', worldGeom(room), room)); }
// Per-cell durability lookup. Built-ins are always breakable / instant (strength 1); customs (id>=16) read their def.
// ⚠️ 1..17 are the LEVEL CREATOR's built-ins and are listed here; 18..89 are the world generator's and are
// merged in from materials.js, which is the one place they are declared. Anything absent is strength 1.
const BUILTIN_STRENGTH = Object.assign({ 2: 3, 4: 2, 5: 2, 17: 2 }, MATGEN.STRENGTH);  // stone tough, ice/mud/drain middling (matches client TERRAIN_MATS); others 1
function matStrengthSrv(mats, v) { if (v < CUSTOM_MAT_MIN) return BUILTIN_STRENGTH[v] || 1; const d = mats[v]; return d ? ((d.strength | 0) || 1) : 1; }
const BUILTIN_UNBREAKABLE = new Set([7, 13]);          // built-in conveyor belts are unbreakable (matches client TERRAIN_MATS)
function matBreakableSrv(mats, v) { if (v < CUSTOM_MAT_MIN) return !BUILTIN_UNBREAKABLE.has(v); const d = mats[v]; return !d || d.breakable !== false; }
// Carve one cell with breakable/strength semantics (mirrors the client's carveCellHp). Returns true if cleared.
// `hard` (the editor Carve tool) removes any cell outright; without it (gameplay slam) the rules apply.
function carveCellSrv(grid, hp, mats, i, hard) {
  const v = grid.g(i); if (!v) return false;
  if (!hard) {
    if (!matBreakableSrv(mats, v)) return false;
    const s = matStrengthSrv(mats, v);
    if (s > 1) { let h = hp.g(i) || s; h--; if (h > 0) { hp.s(i, h); return false; } }
  }
  grid.s(i, 0); hp.s(i, 0); return true;
}
// ⭐ THESE RETURN THE NUMBER OF CELLS THEY CHANGED, NOT A BOOLEAN, and the Prima economy is why: a placement
// has to be paid for in exactly the cells it actually placed, and only the raster knows that number (a cell
// already holding this material costs nothing). 0 is falsy and any count is truthy, so every existing
// `if (raster…)` reads the same — this is a widening, not a change of meaning.
// `cap` limits how many cells a PAINT may change; the loop stops there. That is what makes "you place what you
// can afford" a property of the raster rather than a pre-flight dry run over the same cells, which would double
// the cost of the hottest edit path in the server. ⚠️ It does NOT limit carving: digging is free and always was.
function rasterTerrainCircle(grid, hp, mats, wx, wy, r, val, hard, cap) {
  const COLS = grid.geom.cols, ROWS = grid.geom.rows;                 // Phase 6: the grid carries its own shape
  const c0 = Math.max(0, Math.floor((wx - r) / TERRAIN_CELL)), c1 = Math.min(COLS - 1, Math.floor((wx + r) / TERRAIN_CELL));
  const r0 = Math.max(0, Math.floor((wy - r) / TERRAIN_CELL)), r1 = Math.min(ROWS - 1, Math.floor((wy + r) / TERRAIN_CELL));
  const r2 = r * r; let changed = 0;
  const lim = (val && cap != null) ? cap : Infinity;
  for (let ry = r0; ry <= r1; ry++) for (let cx = c0; cx <= c1; cx++) {
    if (changed >= lim) return changed;
    const ccx = (cx + 0.5) * TERRAIN_CELL, ccy = (ry + 0.5) * TERRAIN_CELL;
    if ((ccx - wx) * (ccx - wx) + (ccy - wy) * (ccy - wy) > r2) continue;
    const i = cx * ROWS + ry;
    if (val) { if (grid.g(i) !== val) { grid.s(i, val); changed++; } hp.s(i, matStrengthSrv(mats, val)); }
    else if (carveCellSrv(grid, hp, mats, i, hard)) changed++;
  }
  return changed;
}
// Axis-aligned square fill (the manual brush; r = half-extent). Carves/paints blocky, grid-aligned terrain.
function rasterTerrainSquare(grid, hp, mats, wx, wy, r, val, hard, cap) {
  const COLS = grid.geom.cols, ROWS = grid.geom.rows;                 // Phase 6: the grid carries its own shape
  const c0 = Math.max(0, Math.floor((wx - r) / TERRAIN_CELL)), c1 = Math.min(COLS - 1, Math.floor((wx + r) / TERRAIN_CELL));
  const r0 = Math.max(0, Math.floor((wy - r) / TERRAIN_CELL)), r1 = Math.min(ROWS - 1, Math.floor((wy + r) / TERRAIN_CELL));
  let changed = 0;
  const lim = (val && cap != null) ? cap : Infinity;
  for (let ry = r0; ry <= r1; ry++) for (let cx = c0; cx <= c1; cx++) {
    if (changed >= lim) return changed;
    const ccx = (cx + 0.5) * TERRAIN_CELL, ccy = (ry + 0.5) * TERRAIN_CELL;
    if (Math.abs(ccx - wx) > r || Math.abs(ccy - wy) > r) continue;
    const i = cx * ROWS + ry;
    if (val) { if (grid.g(i) !== val) { grid.s(i, val); changed++; } hp.s(i, matStrengthSrv(mats, val)); }
    else if (carveCellSrv(grid, hp, mats, i, hard)) changed++;
  }
  return changed;
}
// ---- Server-authoritative LEVELED cellular LIQUID flow ---------------------------------------------------
// Liquids ARE terrain cells (ids 9/10/11/12/14/15) with a parallel per-cell FILL LEVEL (1..LIQUID_MAX). Flow
// is MASS TRANSFER — straight down → down-diagonal → lateral equalisation — so water compresses into low
// spots, finds its level, and forms smooth (sub-cell) surfaces instead of blocky films. Broadcast as a
// `liquid-cells` diff [i, matId(0=empty), level, …]; join replay = `liquid-init` (RLE of the level array).
// Only "active" cells simulate (settled pools cost nothing). Per-liquid cadence = viscosity. Liquid never
// descends past LIQUID_FLOOR_ROW → it rests on the world's bedrock floor instead of falling through it.
const LIQUID_IDS = new Set([9, 10, 11, 12, 14, 15]);   // water, quicksand, lava, acid, brine, oil
// ⚠️ A 256-BYTE TABLE, NOT THE SET. `isFluidId` is called from inside `isSolid`, i.e. on essentially every cell
// read the sim makes, and it measured 3.5% of the liquid tick as a `Set.has` — a hash lookup to answer a
// question about a Uint8 with six true values. The set stays as the single declaration the table is built from,
// so there is still one place to add a fluid.
// ⚠️ Callers pass -1 for "unproduced page", and `Uint8Array[-1]` is `undefined` rather than a throw — the
// explicit `v >= 0` keeps the read monomorphic and says so out loud.
const LIQUID_LUT = (() => { const t = new Uint8Array(256); for (const v of LIQUID_IDS) t[v] = 1; return t; })();
const isFluidId = (v) => v >= 0 && LIQUID_LUT[v] === 1;
// ⭐ THE SAME TRICK ONE STEP FURTHER, for the two levelling row scans. Their inner loop already has the raw
// terrain byte in hand and asks `v !== 0 && !isFluidId(v)` — a compare, a table read and a negate, per step, on
// the hottest loop in the server. One table answers it in one read. Same six values, built from the same set.
// ⚠️ INDEXED BY A Uint8 ONLY. `isFluidId`'s callers may pass -1 for "unproduced page"; this table's callers must
// have checked that first, which is why it is not a drop-in replacement for `isSolidCell` everywhere.
const SOLID_LUT = (() => { const t = new Uint8Array(256); for (let v = 1; v < 256; v++) t[v] = LIQUID_LUT[v] === 1 ? 0 : 1; return t; })();
// ── INTEREST FAN-OUT HOOK (SHARED-WORLD.md §7, Phase 4) ──────────────────────────────────────────────────────────
// Every CELL-ADDRESSED world diff leaves the sim through here instead of calling `io.to(room).emit` directly, so
// interest-limiting is one reassignment outside this block rather than a change threaded through the sim.
// ⚠️ IT IS DELIBERATELY A PLAIN BROADCAST BY DEFAULT. The probe rigs slice this block into a `new Function` and see
// only what is written here, so the sim they measure still broadcasts exactly as it always did — which is what keeps
// probe_fine_identity's 500-tick bit-identity claim about the SIM rather than about the netcode wrapped around it.
// The interest layer (==INTEREST_BLOCK==, further down) reassigns this at load; probe_subscriptions tests THAT.
let wireFanout = (room, ev, payload) => io.to(room).emit(ev, payload);
// PER-TICK BATCHING (§3: "batch all of a player's incoming updates into one packet per tick"). One tick can produce
// seven or more cell diffs — powder terrain, reaction FX, reaction terrain, several liquid pages, soil — and once
// the fan-out above is per-socket rather than one `io.to(room)`, each of those is a separate write per client.
// Between these two calls the diffs are collected and delivered as ONE packet each. Same no-op-by-default trick as
// wireFanout: the sliced sim batches nothing, so the probes still see the wire they have always seen.
let beginWireBatch = () => {}, endWireBatch = () => {};
// PHASE 6 INCREMENT 4b: same seam, same reason. `runLiquidTick` drains the queue of chunks produced on demand
// since the last tick, but the real implementation lives outside this block (it needs the cell store, the fine
// arrays and the chunk records). Declared as a no-op HERE so the sliced sim still runs — probe_budget slices
// exactly this block into a `new Function`, and a bare `drainGenLiquid()` in the tick made it throw
// ReferenceError on every scenario. Reassigned at load, next to the generator it belongs to.
// ⚠️ The sliced sim therefore never produces chunks, which is correct: those probes build their scenes by hand.
let drainGenLiquid = () => 0;
// ⭐⭐ THE STORED-LIQUID WAKE, SPREAD OVER TICKS INSTEAD OF FILTERED. Same seam and same reason as the line
// above (the tenth time this boundary has mattered). See the long note in `applyStoredLiquid`.
let drainStoredWake = () => 0;
// ⚠️ Its counters are declared HERE, inside the sliced block, and not next to the implementation where they
// would read more naturally — the perf line reads them and the perf line is inside the slice. A counter on the
// wrong side of a marker is a ReferenceError in the rigs and nowhere else.
let worldLiquidWakeQueued = 0, worldLiquidWakeAdmitted = 0;
// ---- SOURCE + SINK (test/scene tooling, but real world features) ------------------------------------------------
// SINK = material id 17 ("Drain"): an ordinary SOLID block that DESTROYS liquid touching it, at liquidCfg.sinkRate
// units per tick per touching cell. Put a row of them under a pool instead of clearing it by hand.
// SOURCE = a per-cell flag on a liquid cell (roomLiquidSrc), which tops that cell back up by liquidCfg.srcRate units
// per tick. It is a flag rather than a material because the user asked for it as an OPTION on a liquid — the cell is
// ordinary water/oil/lava that happens to refill.
// ⚠️ MASS ACCOUNTING. A source CREATES mass and a sink DESTROYS it, so grid+air conservation — which the harness and
// probe_drop_mass assert, and which has already caught two real leaks — would go blind if these were untracked. Both
// therefore keep a LEDGER per liquid rank of every unit they invent/eat, so the invariant stays exact:
//     grid + air + eaten − added  ==  initial
// Anything that does not balance is still a real leak. Nothing else in the sim may touch these counters.
const LIQ_SINK_ID = 17;
const isSinkId = (v) => v === LIQ_SINK_ID;
// room → Map(cell → {rank, rate}) of source cells. The RATE is per source, not global: feeding one pool fast and
// another slowly is the whole point of having more than one. `rate` undefined falls back to liquidCfg.srcRate, which
// is now only the DEFAULT stamped on new sources.
// (roomLiquidSrc / roomSrcAdded / roomSinkEaten are `src` / `srcAdded` / `sinkEaten` on the room's cell store.)
function ensureSrcMap(room) { const s = cellsOf(room); if (!s.src) { s.src = new Map(); cellRooms.src.add(room); } return s.src; }
function srcLedger(room) { const s = cellsOf(room); return s.srcAdded || (s.srcAdded = new Array(LIQ_T).fill(0)); }
function sinkLedger(room) { const s = cellsOf(room); return s.sinkEaten || (s.sinkEaten = new Array(LIQ_T).fill(0)); }
function clearLiquidSources(room) { const s = cellsOf(room).src; if (s) s.clear(); }
function dropSource(room, i) { const s = cellsOf(room).src; if (s && s.delete(i) && !s.size) dropSrcMap(room); }
function dropSourcesInRect(room, c0, r0, c1, r1) {
  const s = cellsOf(room).src; if (!s || !s.size) return;
  const gone = [];
  const ROWS = cellsOf(room).rows;
  for (const i of s.keys()) { const c = Math.floor(i / ROWS), r = i - c * ROWS; if (c >= c0 && c <= c1 && r >= r0 && r <= r1) gone.push(i); }
  for (const i of gone) s.delete(i);
  if (!s.size) dropSrcMap(room);
  if (gone.length) io.to(room).emit('liquid-src', { cells: gone, on: false });
}
let LIQUID_MAX = 24;                                  // TOTAL fill units per cell (= vertical "slices"). Runtime-tunable via liquidCfg.cellCap (rescales existing liquid); MUST stay ≤255 (Uint8 arrays/wire).
const LIQUID_LEVEL_SCAN = 28;                         // how far a surface cell looks along its row for a lower spot to level toward (flat-settle)
// OPTION 2 — MULTI-LIQUID per cell. Each cell holds a density-sorted stack: roomLiquidAmt[i*LIQ_T + rank] = fine units of
// the liquid whose density RANK is `rank` (0 heaviest=lava … 5 lightest=oil). The slot index IS the density order, so a
// cell is ALWAYS sorted and can hold up to LIQ_T liquids at once. roomLiquidTotal[i] = Σ amt (cache). Flow (validated in
// scratchpad/multiliquid_sim2.js, 15/15): TOTAL leveling (the proven single-liquid flow run on total[i]) + composition
// advection (a fall drains the BOTTOM/heaviest, surface flow takes the TOP/lightest) + per-interface DENSITY SORT swaps +
// STREAM COHESION (a fed fall cell keeps 1 unit → continuous streams, no pool gap). grid[i] holds a REPRESENTATIVE liquid
// id (heaviest present) for collision/adjacency; the authoritative composition lives in amt. fallSide carried as before.
const LIQ_RANK = { 11: 0, 10: 1, 14: 2, 12: 3, 9: 4, 15: 5 };   // 0 heaviest→5 lightest. ACID (12) is DENSER than water (9): acid=rank 3, water=rank 4 (water floats on acid).
const LIQ_ID = [11, 10, 14, 12, 9, 15];               // rank → id
const LIQ_T = 6;                                      // layers per cell (one slot per liquid type)
// DENSITY → LEVELING SPEED (reduced-amount model). Per density rank (0 heaviest lava → 5 lightest oil): how much a liquid's
// LEVELING is slowed — leveling moves a fraction rate = 1/(1+LEVEL_VISC[rank]) of full each tick, so heavier liquids ooze flat
// slower while falls stay at gravity speed. MILD gradient (2026-07-15): surface smoothing is shelved, so values are kept low
// enough that even lava settles in a reasonable time (~2.3× water, not ~12×) → the blocky-while-leveling phase stays brief. (Tunable.)
const LEVEL_VISC = [1.5, 0.8, 0.4, 0.2, 0.1, 0];     // by rank: lava 1.5 · quicksand 0.8 · brine 0.4 · acid 0.2 · water 0.1 · oil 0
// LIQUID DEBUG CONFIG — live-tunable behaviour switches for the sim, driven by the client "Liquid Debug" menu. GLOBAL
// (affects every room/player) — it's a comparison/diagnosis tool. Each flag gates ONE feature so behaviours can be A/B'd
// to pin down bugs. Defaults below = the shipping behaviour. Mirrored to clients (for the menu) via the 'liquid-cfg' event.
const liquidCfg = {
  densitySort: true,     // steps 2/2b: heavier liquids sink below lighter → the vertical density layering within a cell. off = liquids mix, never separate
  // (ledgeSpill — step 1b, the DIAGONAL spill over a ledge — went with the fall tag on 2026-07-29; see the tombstone
  //  below. Its only consumer was the fine 1b block, so the dial had nothing left to gate.)
  lateralLevel: true,    // steps 1c/1d: liquid flows SIDEWAYS to find a flat level. off = it piles up where it lands (no spreading)
  perLiquidLevel: true,  // step 2c: each liquid flattens its OWN layer across columns (heavy ends flat along the bottom)
  viscosity: false,      // per-liquid LEVEL_VISC throttle: denser liquids ooze flat slower. off = ALL liquids level at full speed
  // (1d) surface flat-settle: sub-steps/tick it may run in ≈ its spread speed in cells/tick. 0 = uncapped (every sub-step).
  // ⭐ DEFAULT MOVED 3 → 7 on 2026-08-01. The cap of 3 was a deliberate choice, not an oversight — uncapped, the
  // leading edge sheds every sub-step and races away from the body still separating behind it, and it was rejected
  // on FEEL. WHAT CHANGED IS THE RENDERER, NOT THIS DIAL (user, who made the original call): back then `cellCap` was
  // much higher, so one cell's worth of liquid spread across ~64 tiles almost instantly and read as unnatural. With
  // the lower cell capacity AND the metaball blur, that speed now looks right. It is also the answer to §7(b)'s one
  // unaddressed finding, that liquid takes a very long time to come to rest.
  // ⚠️ WHY 8 AND NOT 0. Measured on probe_fine_identity TEST B's mixed-liquid scene (brine+water+oil in EVERY cell,
  // so they must stratify and spread at once — the interaction the cap exists for). Ticks-to-settle / rest density
  // inversions, swept over both grid ratios:
  //     flat:      1      2      3      4      5      6      7    **8**     9      0
  //     SUB=1:  248/0  169/0  151/0  147/0  149/0  139/0  131/0  137/0   127/1  127/1
  //     SUB=3:  191/2  181/0  171/0  167/5  155/3  163/0  149/5  145/0   131/1  131/1
  // **SUB=1 is the only ratio that ships** (every `ensureFineArrays` caller passes 1; reactions and chunk residency
  // both refuse to run at anything else) and it is clean and monotonic: zero inversions up to 8, then 1 from 9 on.
  // 9 is exactly `fineLevelSteps`, i.e. running in EVERY sub-step, which is where levelling finally outruns the
  // density sort and a heavier liquid is left resting above a lighter one. 9, 12 and 0 are therefore the same
  // setting in practice — an independent reproduction of Phase 0b's "saturates at 9".
  // ⚠️ SUB=3 is ERRATIC (0 at 2/3/6/8 but 5 at 4 and 7), which reads as sub-step parity rather than a threshold.
  // Do not treat 8 as robustly safe THERE; it is chosen for SUB=1, and being clean at SUB=3 is what keeps TEST B
  // passing unmodified rather than being loosened to accommodate a new default.
  // ⇒ 8 takes ~90% of the available speed-up (151 → 137 against 127 uncapped) at no correctness cost.
  fineFlatSteps: 8,
  // (1d) SURFACE FLAT-SETTLE REACH, in cells. How far 1d looks along the row for a spot at least 2 units lower
  // before nudging 1 unit toward it. 0 = LIQUID_LEVEL_SCAN (28), which is what has always shipped.
  // 🟥 28 HAS NO RECORDED DERIVATION. `git log -S` reaches its introduction (ee6f4ba, 2026-07-17) with no
  // reasoning, and it predates the fine grid — `SCAN = LIQUID_LEVEL_SCAN * SUB` exists only to hold the PHYSICAL
  // reach fixed, which at SUB=1 (the only shipping ratio) is 28 cells = 224px. Same position `tickMs` was in.
  // ⭐⭐ AND 1d IS ALMOST ENTIRELY WASTED WORK — measured, `scratchpad/probe_scan_shape.js`: 187.8M scan steps to
  // make ~17,500 moves. **99.5% of its decisions move nothing**, 92.5% of its scans walk all 28 cells and find
  // nothing (96.4% of all its steps), because 1d has no surface test and every BURIED cell in a body pays to
  // confirm it is surrounded by cells exactly like itself, on eight of the nine sub-steps.
  // ⚠️ Lowering this is a BEHAVIOUR change, not a free win — it is how far a puddle looks for a lower spot.
  // Measured share of levelling moves KEPT: reach 8 → 85.3%, 12 → 91.0%, 16 → 95.0%, 28 → 100%.
  // ⚠️ The reach table is per CELL, not per scan: both directions are always scanned and the NEARER hit wins,
  // so a shorter reach only changes an outcome when the WINNING distance exceeds it.
  fineFlatScan: 0,
  // ⭐⭐ ASK "CAN ANYTHING RECEIVE?" BEFORE SCANNING FOR SOMEWHERE TO SEND IT. Both sideways levelling branches
  // only ever move liquid into an IMMEDIATE neighbour; the row scan decides which SIDE, not where it lands. So
  // if neither neighbour can take anything, no scan result can produce a move, and the scan is dead work.
  // Exact — same outcome, not an approximation. See the block comments at (1d) and (2c).
  // ⭐⭐ A STRIP THAT RUNS OUT OF BUDGET STILL GETS ITS DESCENT, instead of getting no tick at all. Falling is
  // the cheap part of the tick and the visually glaring one — liquid stopped in MID-AIR is obviously broken,
  // liquid that levels slowly is not — and 11–30% of strip-turns were being skipped entirely under a heavy
  // pour. See the branch in liqTickSectors and FALLONLY in fineLiquidTickRoom.
  fallFirst: 1,
  flatSkip: 1,     // (1d) surface flat-settle — where the waste is: 99.5% of its decisions move nothing
  plSkip: 1,       // (2c) per-liquid levelling — weaker, 45% of its scans genuinely find a target

  // ⚠️ DEFAULT OFF since 2026-07-29. This is the BLANKET rule: a cell in a column that still holds ANY inversion may
  // not level at all. It freezes the whole column — including its free surface — until the column has finished
  // sorting, which leaves a liquid heap standing as a terraced mound (measured: the heap held its shape until t176
  // with it on vs t46 with it off, and settled 306 vs 125). And it turns out it was never doing the job: with the
  // per-EXCHANGE gate (finePerLiquidSortGate) on, a buried blob spreads 13 columns whether this is on or off; with
  // that gate off it spreads 50–58 either way. So the spread limiting is entirely the other rule's doing.
  sortBeforeLevel: false,
  reactions: true,       // lava+water→stone, acid dissolves terrain, water+snow→ice, oil burns, etc.
  // ── THE FALL TAG (`fallSide` / roomFineSide / `sd`) — DELETED 2026-07-29 (all-fine track, slice 4, the last of the
  // coarse deletion). It was one byte per cell saying "this liquid spilled off a ledge and is still falling, hugging
  // that wall", born ONLY in the 1b diagonal spill, carried down by 1a and cleared when a cell settled. Its whole
  // reason to exist was that a partial-fill cell stores a scalar with NO horizontal position, so a thin stream was
  // unrepresentable and the tag was how the renderer reconstructed one. At 8px cells the grid resolves a falling
  // stream directly, so there is nothing left to reconstruct.
  // `streamTag`, `streamMix`, `streamNoSort`, `streamNoSortNbr` and `ledgeSpill` went with it, along with the whole
  // 1b block, `SIDE_LEFT/SIDE_RIGHT`, the `roomFineSide` array and the `sd` term in `levelGate` below.
  // ⭐ WHY THAT WAS SAFE, AND IT WAS MEASURED, NOT REASONED — the tag fed three SIM gates (streamNoSort,
  // streamNoSortNbr, levelGate), so this was never a render-only cut. `scratchpad/probe_fine_tag.js` drove four
  // scenes (ledge, staircase, dual-fed chute, shaft) kept in genuine flow for 600 ticks: at shipping defaults
  // (`fineLedge:false`) the fine sim wrote ZERO tagged cell-ticks, while the `fineLedge:true` CONTROL wrote 14,995
  // over 104 cells — so the scenes really did exercise 1b and the zero was not vacuous. There were exactly two
  // non-zero write sites, `sd[j] = ns` (1b, behind fineLedge) and `sd[j] = sd[i]` (the 1a carry, which can only ever
  // propagate a zero) ⇒ the three gates were inert BY CONSTRUCTION. The user approved removing the tag and the
  // `fineLedge` route together, since the dial was the only thing that could have made the tag live again.
  // ── DROPLET CASCADE — DELETED 2026-07-29 (all-fine track, slice 1 of the coarse deletion).
  // It was the 2026-07-20 streaming rewrite: a ledge spill left the grid as droplets that carried real liquid and
  // deposited it on landing, developed over eleven bench iterations (scratchpad/liquid-droplet-stream.html, still
  // there, and the whole design log is in auto-memory project_liquid_streaming). It shipped OFF: the ALL-FINE terrain
  // move made it redundant, because at 8px cells the grid itself resolves a falling stream, which is the entire
  // problem droplets existed to solve. `droplets`, `dropUnit/Fall/Spread/SpreadFlow/SpawnH/Weir/Stratify/LandSpread/
  // TermFall/ImpactCurve/SpreadRef/SpreadWide/EdgeFill/ColSpace` all went with it, along with dropletTickRoom,
  // spawnDroplets, the `liquid-drops` wire and the client's local replay.
  // (streamFullClear — a brim-full cell drops its stream tag — was read only by the coarse sim and went with it.)
  // LEVELLING GATE — which cells are excluded from lateral levelling (1c/1d/2c) as "still falling".
  //   0 = the original `canFall`, which also counted a cell that could shed DIAGONALLY over a nearby edge, so pool
  //       cells sitting at an edge never levelled → the blocky/stair surface near drops.
  //   1 = this cell has straight-down room of its own.
  //   2 = AIRBORNE (default): straight-down room, propagated UP the column, so a whole block of liquid falling
  //       through the air is excluded while a pool beside a drop still levels.
  // ⚠️ RENUMBERED 2026-07-29 with the fall tag. Every mode used to have an `sd[i] !== 0 ||` term and there was a
  // fourth mode (tagged-ONLY) that is now the empty set; the modes below are what is left once the tag is gone, and
  // the default moved 3 → 2 with NO change in behaviour (old 3 = tagged-or-airborne = airborne once tags are always 0).
  levelGate: 2,
  symLevel: true,        // 1c surface flow sheds to BOTH lower neighbours from the SAME snapshot, aimed at the 3-cell average → no per-tick direction preference + no overshoot. off = the old alternating-direction sequential scan. (NOTE: this does NOT fix the oil/water slosh — that's levelMix below.)
  levelMix: true,        // lateral leveling (1c/1d) moves the MIXTURE proportionally (moveProp) instead of skimming the lightest liquid off the top (moveTop). Skimming oil each tick oil-depletes→oil-replenishes a surface cell in a period-2 cycle = THE oil/water slosh (probe: swing 0.69→0.00). off = moveTop (skims the top, sloshes). Stratification is kept by the density sorts, not by skimming.
  sortRate: 4,           // units the density sort swaps across an interface per tick (higher = liquids separate faster; capped by the mismatch)
  tickMs: 40,            // sim interval in ms — LOWER = faster real-time flow/leveling (but more CPU + network traffic). 40 ≈ 25 ticks/s
  // PER-TICK SIM BUDGET, as a percent of tickMs. 0 = unlimited (the old behaviour). When the rooms with
  // active liquid cannot all be ticked inside the budget, whole rooms are DEFERRED to a later tick on a
  // rotating basis, so an overloaded room makes liquid resolve more SLOWLY instead of stalling the event
  // loop for everyone. Measured motivation: ~21–26µs per active cell means one breached lake can exceed a
  // 40ms tick on its own. See SHARED-WORLD.md Phase 1 — the goal is that no single player action can
  // exceed the budget, so the server degrades instead of breaking.
  simBudgetPct: 70,
  // ── THE TWO HOLES THE §7(b) RE-DECISION MEASURED (scratchpad/probe_resolution_redecide.js, 2026-08-01).
  // That measurement closed §7(b) as "resolution is NOT the problem": the budget's SUSTAINED clamp works at
  // 8px (mean 22–26ms against a 28ms budget while tier 2 cut K 9→6→4) and cost is FLAT from 1 to 16
  // simultaneously-disturbing rooms, which is exactly the Phase 1 property. What it also found is that the
  // PEAK is bounded by nothing — and that coarsening does not fix it, so these two dials do.
  // ⚠️ BOTH SHIP OFF. They change scheduling behaviour, and the convention on this branch is that anything
  // not behaviour-preserving ships default OFF behind a live toggle. `budgetSeed`/`budgetRate` on the
  // liquid-cfg wire, plus System-tab controls. probe_budget.js guards both states.
  //
  // (1) COLD START. `roomLiqCost` is an EMA that is EMPTY on a room's first tick, and a disturbance is at
  // its LARGEST the instant a player creates it — so both the roster planner and tier 2 see est=0, decline
  // to throttle, and the room runs at full K on its worst tick. MEASURED: every mid-size overshoot landed at
  // t0 (8px 1024×384px = 60.9ms against a 28ms budget, at K=9/9). Cost per active cell is known and stable
  // (21–26µs at K=9, Phase 0), so a room with no EMA yet is estimated from `fineActive.size` instead. It is
  // a SEED only — one real tick replaces it with the measured EMA.
  budgetSeed: 1,         // ✅ ON since 2026-08-01 — see the verification note on budgetRate. 0 = old behaviour.
  cellCostUs: 23,        // µs per active cell at FULL K, the seed constant. Phase 0 measured 21–26.
  // (2) THE K=1 FLOOR. Tier 2 cuts sub-steps in proportion, but K cannot go below 1, and a room bigger than
  // the whole budget AT K=1 is bounded by nothing — the "always admit one room" rule runs it anyway.
  // MEASURED on a full-resident-band spill: 8px floored at K=1/9 and still cost 144ms/tick, i.e. 3.4× the
  // ENTIRE 40ms tick interval, sustained on 100% of ticks. 16px lands in the same place (135ms at K=2/9),
  // which is why coarsening to 16px was NOT the answer.
  // TIER 3 = WHOLE-ROOM RATE LIMITING. Such a room is ticked once every N ticks instead of every tick, N
  // chosen so its AMORTISED cost fits the budget. It keeps the invariant the whole design rests on — whole
  // rooms, never part of one — because a rate-limited room still advances all at once, just less often.
  // ⚠️ HONEST LIMIT, and it is the same one tier 1 already documents: this bounds AMORTISED cost, not
  // instantaneous. The room still costs its full ms on the tick it does run. Bounding the instant would mean
  // splitting a room across ticks, which would advance one end of a pool and not the other and would break
  // powder's lockstep — the thing this scheduler refuses to do by construction.
  // ✅ BOTH ON SINCE 2026-08-01 — VERIFIED IN-BROWSER by the user against a live server, which is the only place
  // this could be settled. They shipped off (branch convention: anything not behaviour-preserving ships off behind
  // a live toggle) and were turned on once someone had actually watched them work. What was watched, on the Perf
  // tab's sim/tick readout with a deliberately huge body of water in motion: **80–90ms with them off, 20ms avg /
  // 25ms max with them on.** The toggles stay, so this is still A/B-able live if liquid ever feels wrong.
  budgetRate: 1,         // 0 = off. Needs budgetSeed on, or a brand-new huge room has no estimate to act on.
  budgetRateMax: 8,      // cap on N, so liquid never slows so far that it reads as frozen rather than slow
  // Cost is ~linear in K (the tier-2 comment measures 18 sub-steps at ~2× 9), but NOT all the way down:
  // Phase 0's dial sweep measured fineLevelSteps 9→1 as 6.5× cheaper per unit work, not 9×. So the cost of a
  // room AT K=1 is estimated as its full-K EMA divided by this, not by K. Using K would under-estimate by
  // ~1.4× and fire tier 3 later than it should.
  budgetKGain: 6.5,
  // 🟥🟥 "TIER 2 CANNOT FIRE IN A SECTORED WORLD" WAS WRONG, AND A `kFairShare` TOGGLE BUILT ON IT LIVED HERE
  // BRIEFLY (2026-08-23) AND IS DELETED. The reasoning looked sound on the page: tier 2 asks `est > budgetMs`
  // where `est` is ONE STRIP's cost and `budgetMs` is the budget for the WHOLE tick, so a strip would have to be
  // dearer than everything the server may spend. MEASURED ON THE RUNNING SERVER it fires constantly — 25 times
  // in a 25-tick window in the mildest reading, and on 100% of the strip-turns that ran under load.
  // ⭐ THE THING NEITHER READING NOTICED: the EMA below is normalised to FULL-K cost
  // (`d = elapsed * (kFull / kUsed)`), so a strip already throttled to K=1 records ~9x what it actually spent
  // and clears the whole-tick budget easily, and keeps clearing it. The comparison is impossible on paper and
  // routine in practice.
  // ⇒ and because K bottoms out at 1 — which every loaded reading showed it pinned to — making tier 2 keener
  // buys nothing: measured 28% -> 30% of strip-turns deferred with the toggle on, i.e. no change where it
  // mattered. The staggering is the budget genuinely running out with the smooth throttle already exhausted,
  // not the smooth throttle failing to engage. Second read-only diagnosis on this track to be refuted by
  // running it; see scratchpad/kickoff_chunk_deletion.md.
  // ══ SECTORS — SCHEDULE ONE ROOM IN COLUMN STRIPS INSTEAD OF ALL AT ONCE ═══════════════════════════════════
  // 🟥 THE PROBLEM, MEASURED ON THE LIVE SERVER 2026-08-08: the budget's only tools are "defer a whole room"
  // (tier 1) and "rate-limit a whole room" (tier 3), and the Overworld is ONE room. So a flood at one end of the
  // world throttles a puddle at the other, for someone who cannot see it and is nowhere near it.
  // `probe_bystander.js` timed it: a flood in ANOTHER room costs a bystander 0.99× — nothing at all — while the
  // same flood in the SAME room costs 2.98×. The harm is scheduling, not capacity.
  //
  // ⭐ WHAT THIS IS, AND WHAT IT IS NOT. A sector is a SCHEDULING unit, never a data one: one store, one set of
  // per-cell arrays, one active set. Ticking a sector SWAPS the room's active set for just that sector's cells,
  // runs the ordinary flow, and merges whatever is still moving back. `fineLiquidTickRoom` is untouched — it
  // never learns that sectors exist, which is what keeps the hot loop out of this.
  // ⚠️ Liquid crossing a boundary needs no special handling: a cell woken outside the sector being ticked lands
  // in the same set and is bucketed to its own sector on the next tick.
  //
  // ⭐⭐ THE MECHANISM IS PER-SECTOR COST ATTRIBUTION, NOT THE PARTITIONING — isolated by mutation
  // (`probe_sectors` part E, M3). Each sector carries its own `roomLiqCost` EMA, so tier 2 throttles K on the
  // expensive sector while the cheap one keeps full K. Replacing the per-sector EMA with the room's takes the
  // bystander from 0.99× back to 1.51× and DOUBLES the CPU. A build that partitions the cell lists but keeps one
  // estimate per room gets half the benefit for all of the work.
  //
  // MEASURED (probe_sectors part E): bystander 2.37–4.30× shared → **0.97–0.99×** sectored, at **0.31–0.60× the
  // CPU** — cheaper, because the puddle settles in 240 ticks instead of ~700 and then costs nothing at all.
  // Mass is conserved exactly across a boundary and the seam is not special (per-column difference 1.40 beside
  // the boundary vs 0.96 far from it, i.e. the difference is the update ORDER, not the seam).
  //
  // ⚠️ SHIPS OFF (0), per the branch convention for anything not behaviour-preserving. At 0 every line below is
  // skipped and the scheduler is byte-for-byte what it was.
  // WIDTH: part A measured a disturbance at ~220–440 columns, so 256 is the smallest width where a typical
  // disturbance spans one or two sectors rather than being smeared over many. It is a dial; part E is how to
  // re-decide it. ⚠️ Narrower is NOT strictly better — the partition is O(active) per tick either way, but more
  // busy sectors means more per-sector tick calls, and a disturbance split across many sectors is advanced in
  // more pieces.
  // ✅ 2026-08-09 — SOURCES, CHEMISTRY, POWDER AND SOIL ARE SECTORED TOO, and a strip now takes its WHOLE turn
  // (see `liqTickSectors`), so nothing in a strip can advance while that strip's water is frozen.
  // ⭐ ON at 256. Measured on the shipped switch (probe_sectors part E): a bystander sharing a world with a big
  // spill goes from 3.06× slower to 1.05×, on 0.52× the CPU. Part A says 256 is the smallest width where a
  // typical disturbance (220–440 columns) spans only one or two strips. Live dial on the debug panel — 0 is the
  // old whole-room behaviour, and `probe_fine_identity` proves 0 is bit-identical to before this existed.
  secW: 256,
  // ══ THE REACTION PASS'S OWN LIMITS ═══════════════════════════════════════════════════════════════════════
  // 🟥 MEASURED 2026-08-05 ON THE LIVE OVERWORLD (`scratchpad/probe_overworld_settle.js`): the flow loop ran in
  // **0% of perf windows** and turning the whole-room rate limiter OFF changed nothing — but turning REACTIONS
  // off made it run in **100%**. Reactions go BEFORE the flow, walk the same active set, and had no limit of any
  // kind, so with one room they ate the entire budget and the flow loop's own hard stop then deferred every room
  // every tick, forever. That is not slow liquid, it is liquid that NEVER MOVES, and it is exactly what the
  // Overworld looked like. CLAUDE.md had already recorded "reactions are not throttled at all" from the
  // resolution re-decide; this is that bill arriving.
  // ⚠️ The perf line HID it: `fineActive` is only accumulated for a room the FLOW loop reaches, so a starved
  // room reports `active=0` while burning 187ms. A zero beside a large millisecond figure is an artefact.
  //
  // TWO limits, and they fix different things:
  //   `reactAnchorFilter` — the COST. `anchors` was every candidate plus its 4 neighbours, deduped through a
  //     Set, and at 360,000 active cells that is a ~1.8M-entry Set built every tick — to find the handful of
  //     cells that can actually react. All three phases open by requiring lava (rank 0), acid (rank 3) or water
  //     (rank 4); anything else is skipped immediately. So the filter is the union of the phases' own entry
  //     tests, applied before the Set instead of after it.
  //   `reactMaxCand` — the GUARANTEE. The filter makes the pass cheap in every world we know of, but "cheap in
  //     the worlds we measured" is not a bound. This one is: at most N candidates per room per tick, taken from
  //     a ROTATING cursor so nothing is ever permanently skipped. Without it, a world that is genuinely all
  //     lava and water would starve the flow again and we would be back here.
  reactAnchorFilter: 1,  // 0 = old behaviour (anchor every candidate + neighbours, decide inside the phases)
  reactMaxCand: 20000,   // 0 = unlimited (old behaviour). Per room per tick, from a rotating cursor.
  // ⭐⭐ Take reaction candidates ONLY from cells whose contents actually CHANGED (which the flow already seeds),
  // not additionally from every cell that might still move. See the note at the candidate list in
  // fineReactTickRoom for the measurement — five of six real scenes examined 106k–565k cells a second and fired
  // nothing. 0 = the old double source.
  reactMovedOnly: 1,
  // ⭐ 1 = the OLD behaviour: every generated liquid cell is woken on production, all ~58,000 per window, of
  // which measurement says 0.5% can move. Ships 0 (wake only what is loose) because the difference between
  // "liquid works" and "liquid is frozen" in the Overworld is exactly this. Left as a live toggle because if
  // liquid ever appears to hang where it should flow, this is the first thing to flip.
  genWakeAll: 0,
  // 🟥🟥 BACK ON, AND THE FILTER IT DISABLES IS THE ONE THAT FROZE WATER IN MID-AIR. Waking every stored cell on
  // a chunk fault-in is expensive — measured at 3,400 active cells and 32ms of a 40ms tick while a player moved
  // through ground they had built in — and filtering it by `liquidCanMove` was worth almost all of that. But it
  // left water visibly hanging in the air, TWICE: first for cells whose neighbours were in a page nobody had
  // produced yet (a peek answers -1 there and -1 fails every branch), and then again after that was fixed by
  // waking the page's three edges unconditionally. The second cause was never identified.
  // ⇒ DEFAULT 1 = the old, correct, expensive behaviour. A wrong world is not a saving.
  // ⭐ THE DECIDING EVIDENCE WAS THE USER'S, NOT A RIG'S: with this ON, leaving and re-entering unfreezes the
  // water; with it OFF the water stays frozen. That says the skipped wake IS the mechanism without needing to
  // know which cell the filter got wrong — and no harness here can see it, because a clean test world has no
  // stored player edits at all (every traversal measured 0 active cells, at every depth and every cadence).
  // ⏭️ The saving is still worth having. It needs a wake test that is correct at a page boundary rather than one
  // that treats "I cannot see the neighbour" as "it cannot move" — see the note in `applyStoredLiquid`.
  storedWakeAll: 1,
  // ⭐⭐ …AND THE HALF OF THAT SAVING THAT CANNOT BREAK ANYTHING: SPREAD THE WAKE INSTEAD OF FILTERING IT.
  // The cost above is a SPIKE, not a rate — a chunk fault-in dumps its whole stored liquid list into the active
  // set in one tick, and those cells are processed once and mostly drop straight back out. A spike is what makes
  // the budget throttle. So the wake is queued and admitted at this many cells per tick, per room, and NOTHING
  // IS EVER DROPPED: every stored cell still wakes, a tick or two later. Neither the known freeze cause nor the
  // unknown one can strand anything, because the queue asks no question about whether a cell can move.
  // 512/tick × 25Hz ≈ 12,800 cells/s, comfortably above the inflow of a player walking through built-in ground.
  // 0 = admit everything the instant the chunk faults in (the old behaviour, for an A/B).
  storedWakeRate: 512,
  // Diagnostic only, and free when off — see `storedAuditSeen`. Counts what fraction of RESTORED liquid could
  // actually move, which is what separates "it was saved mid-motion" from "the restore breaks it".
  // Does this world contain DRAIN blocks (material 17)? Off = the sim never looks for them, which is ~3% of the
  // liquid tick back in every world that has none. Armed automatically when one is painted; see `sinkOn`.
  sinks: 0,
  storedWakeAudit: 0,
  // Cross-check the fast row scan against the loop it replaces — see `liqScanMismatch`. Diagnostic; roughly
  // doubles the scan cost while on, and must report 0.
  scanVerify: 0,
  // The contiguous row walk itself. 1 = on (see `scanLevel`); 0 = the original loop, for an A/B.
  scanFast: 1,
  // ⭐ THE ACTIVE-CELL HEAT WIRE. Off by default and costs literally nothing when off (one boolean on a path that
  // already runs once every 32 ticks). Turned on by the Inspect tab's "Active-cell heat" checkbox, which is the
  // only thing that reads it — a diagnostic nobody has switched on should not be on the wire.
  heat: 0,
  // ⭐ THE STRIP-SCHEDULE WIRE, same shape and same rule as `heat` above: off by default, one boolean on a path
  // that already runs once a second, and nothing is tallied at all unless it is on (see `secNote`). Turned on by
  // the Inspect tab's "Simulation strips" checkbox.
  strips: 0,
  // ⭐⭐ NEVER SPLIT ONE BODY OF MOVING WATER ACROSS TWO SCHEDULING STRIPS — see planRoomSectors for the whole
  // argument. ON: strips joined by moving liquid at their shared edge take their turn together, so the only
  // place a rate difference could be SEEN is always in lockstep with itself. OFF restores the old per-strip
  // schedule exactly, for an A/B on the trade (a merged disturbance stutters in unison instead of tearing).
  secJoin: 1,
  // ⭐ Admit the CHEAPEST rooms first (see the note at the sort in runLiquidTick). Ships ON: it is strictly
  // fairer than pure rotation wherever more than one room is busy, the rotation is kept on top of it so nothing
  // starves, and `probe_budget`'s liveness checks are what watch that. Live toggle `budgetCheapFirst`.
  // ⚠️ It does nothing at all in a single-room world — that is the point of probe_sectors D2, and it is why
  // this is only HALF the answer to the Overworld's one-shared-room problem.
  budgetCheapFirst: 1,
  // DEBUG slow motion for AVATARS, mirrored to every client so it is a UNIVERSAL time scale rather than one
  // player's local lens. Clients run their avatar sim every Nth frame while still rendering every frame. 1 = off.
  // It rides this wire for the same reason `tickMs` does: it has to be the same for everyone or what you are
  // watching is two different worlds.
  avSlow: 1,
  // DEBUG: freeze the whole sim (liquid, droplets, powder, soil) where it stands, so behaviour can be inspected and
  // screenshotted without it moving under you. `liquid-step` then advances it a fixed number of ticks. GLOBAL, like
  // every other sim switch — it stops the world for everyone in the room, not just the person who pressed it.
  paused: false,
  perfLog: process.env.LIQ_PERF === '1',  // DEBUG: ~1×/s console line — active rooms/cells, sim ms/tick, emit KB/s. Enable via env LIQ_PERF=1 or a liquid-cfg patch (toggle-able live). Off = zero overhead.
  // FLUX LEVELLING — ⚠️ SHELVED 2026-07-20, left in behind this flag; DEFAULT OFF, do not enable by default.
  // "Global target, local transport": per-body equilibrium waterline + prefix-sum interface fluxes, moved at a
  // bounded rate between ADJACENT cells only (nothing teleports). Levelling goes O(N²) → O(N) and it is
  // genuinely much faster on paper (flat/stepped basins reach dead level; a 100-wide pool NEVER converges with
  // this off). BUT in-game it still reads wrong: the surface moves as sliding slabs rather than settling, and
  // it does not finish levelling in real terrain. Root cause of the LOOK is inherent, not a bug: moving mass
  // across a pool quickly is visible, and real water hides that in a gravity WAVE (sloshing). Making it look
  // right therefore needs surface wave dynamics (shallow-water on the height field), which is a project in its
  // own right. Today's local levelling looks fine and is only slow on very wide pools, so this is parked.
  fluxLevel: false,
  // SOURCE / SINK rates (see the block above LIQ_SINK_ID). Units per tick, of the 64 that fill a cell — so at 25 ticks/s
  // srcRate 8 refills a cell about three times a second. Both are ledgered, so they cannot hide a real mass leak.
  srcRate: 8,            // units/tick a source cell tops itself back up by
  sinkRate: 64,          // units/tick a drain block eats from each liquid cell touching it (64 = a full cell per tick)
  fluxRate: 32,         // max units crossing one column interface per tick. Higher = faster levelling, linearly (no instability window).
  // (`fine` and `sub` are gone. `fine` gated the fine sim against the coarse one, and there is no coarse one; `sub`
  //  was the fine-cells-per-terrain-cell ratio, which is 1 now that terrain is itself 8px — every ÷/×SUB² mapping
  //  helper collapses to identity at 1. roomFineSub is still carried per room and defaults to 1.)
  // (`fineLedge` — the dial that chose between the diagonal ledge spill (1b) and letting lateral levelling (1c) move
  //  liquid into the edge cell so 1a could drop it next tick — went with the fall tag. It SHIPPED OFF, so the route
  //  that survives is the one that was already running. See the fall-tag tombstone above.)
  // FINE PHYSICS SUB-STEPS: run the WHOLE fine tick this many times/tick → ALL movement (fall/spill/level/sort) K× faster,
  // recovering the speed fine cells lose to being smaller. Levelling is O(width²) so fine is ~SUB²≈9× slower than coarse →
  // K≈9 matches coarse. Local, no teleport, broadcast accumulated (wire ~unchanged). 1 = unchanged.
  fineLevelSteps: 9,
  // (1) QUIESCENCE (perf): freeze a fine cell that has NOT MOVED for fineQuiesceTicks ticks — drop it from the active set
  // so it stops being processed AND broadcast. Trims the settling wake-front + idle halo. Keys off "did it move (incl.
  // density sort) this tick", so an inverting cell is never frozen. Pure perf: only removes from the work-set, never
  // moves mass. A neighbour move re-adds it. OFF = no change.
  // ⭐⭐ ON SINCE 2026-08-06, AND THE MEASUREMENT THAT JUSTIFIES IT IS A LESSON IN ITSELF.
  // I A/B'd this lever earlier the same day, measured 2.4% → 2.8% of the queue moving, matched the recorded
  // "saves only 18%", and dismissed it. That measurement was taken while the sim was still GENERATING THE WORLD
  // from inside its own tick — a far bigger cost that masked everything behind it. With that fixed, the same
  // lever re-measured on the same 70s panning scene:
  //     work queue          150,000–210,000  →  2,000 rising to ~70,000
  //     cells moving/tick             ~500   →  1,200–3,300
  //     rooms deferred/tick        0.88–0.96 →  0 for the first 30 seconds
  // 🟥 A LEVER MEASURED BEHIND A BOTTLENECK IS MEASURED WRONG. Re-take every "we tried that, it did not help"
  // after removing whatever was dominating at the time.
  // ⚠️ It is a BEHAVIOUR change, not just a perf one: a cell that has not moved for `fineQuiesceTicks` leaves the
  // work set. It cannot strand liquid — `wake()` re-adds it the moment a neighbour moves, and `wouldSort` keeps a
  // still-inverted cell in — but the failure mode if that reasoning is wrong is liquid that stops when it should
  // not, which is the symptom this whole track is about. `liquid-cfg {fineQuiesce:0}` turns it off for an A/B.
  // 🟥 BACK OFF, 2026-08-06, SAME DAY. Reported: "with quiescence on it freezes indefinitely, with it off it
  // just does the normal, waiting-for-its-turn freeze." So the reasoning in the block above — that `wake()` and
  // `wouldSort` between them can never strand a cell — IS WRONG, and the counter-argument was handed to me and I
  // did not take it seriously enough: *"if huge numbers of cells are already not moving for 6 ticks, then there
  // will be nothing near them to move and wake them."* Exactly. Retirement is only safe if something is
  // guaranteed to wake the cell, and for the INTERIOR of a large settled-but-not-level body there is nothing
  // adjacent that will ever move again. It retires the whole body and the body never levels.
  // ⚠️ The 5x work-queue improvement it measured is real and is NOT the point: it was doing less work by not
  // doing the work. A perf win measured without checking the RESULT is not a perf win.
  fineQuiesce: false,
  fineQuiesceTicks: 6,
  // ⭐⭐ WAKE GENERATED LIQUID THAT HAS A DIFFERENT-DENSITY FLUID BESIDE IT. See `genLiquidLoose`, which is
  // where the whole argument lives. ON by default — unlike everything else on this branch, because OFF is the
  // behaviour that was reported as a bug, and because it wakes only the defect (measured: 184 cells of
  // different-rank horizontal contact against 655,112 of same-rank, over 12 windows of the live Overworld).
  // Turn it off on the wire to A/B against the old world.
  wakeDensityFace: true,
  // (2) ADAPTIVE K (perf): stop sub-stepping a room early once a sub-step moves fewer than fineAdaptPct% of its active
  // cells (it has gone quiet). A settled pool then spends ~1 sub-step, a raging pour still spends the full K. The fall
  // steps always run first (see fineConstFall) so descent is never starved. OFF = always exactly K sub-steps.
  fineAdaptiveK: false,
  fineAdaptPct: 5,
  // FALL RATE vs sub-steps: sub-steps re-run the DOWN-fall (1a/1b) too, so higher K makes liquid FALL K× faster, not just
  // level faster. ON = decouple — the fall runs fineFallSteps times/tick REGARDLESS of K (≈ coarse fall speed at SUB=3),
  // while levelling + density sort still get the full K passes. OFF = fall follows K (original). Behind a toggle to A/B.
  fineConstFall: true,
  fineFallSteps: 1,
  // MINIMUM LIQUID UNIT (fine, experimental): quantise the DOWN-fall so liquid only descends in multiples of this many
  // units — the remainder stays put (mass conserved, a thin film left on the way). Bigger unit ⇒ bigger, chunkier falling
  // slices (they connect up more) at the cost of a more stepped/periodic trickle. 1 = off (exact fall, current). Fall only
  // (1a) so POOLS keep their smooth 1/64 vertical levelling. Fine-mode only.
  fineMinUnit: 1,
  // DENSITY-SORT SUB-STEPS: the sub-steps run the density sort every pass too, so at K=9 stratification is 9× faster —
  // fast enough that the sinking/rising interface reads as instant (no visible bubbling). This caps the sort to the FIRST
  // N sub-steps/tick so it can be SLOWED independently of levelling: 1 = one sort pass/tick (slow, visible), while
  // levelling still runs the full K. 0 = follow K (sort every sub-step, current). Pairs with sortRate (units per swap).
  // ⭐ DEFAULT MOVED 1 → 0 on 2026-08-23, by the same person who chose 1. It was set to 1 so separation would be
  // slow and VISIBLE; asked again with a profile in hand they said 0 "seems to look relatively fine", so it goes
  // back to following K.
  // ⭐⭐ AND IT IS NOT ONLY A LOOKS SETTING — it is what keeps `wouldSort` alive. At 1, the sort runs in the first
  // sub-step only, so `!doSort` is true on the other eight and `wouldSort` runs on EVERY active cell on all of
  // them purely to keep still-inverted cells awake: measured at **7.7% of the liquid tick**. At 0 the sort runs
  // every sub-step, `!doSort` is never true, and that whole branch is never entered.
  // ⚠️ The 7.7% is only there when K is HIGH. Under budget pressure K falls to 1, there is one sub-step, the
  // sort runs in it, and `wouldSort` already costs nothing — so this does not help a struggling tick directly.
  // What it does is make the unthrottled cell cheaper, which is what lets tier 2 hold K HIGHER before it starts
  // cutting (`memory/feedback_the_budget_hides_cpu_wins.md`).
  fineSortSteps: 0,
  // ── (2b) DIAGONAL DENSITY SORT — how far a rising/sinking parcel travels SIDEWAYS while it separates.
  // The vertical sort (2) and the diagonal (2b) both ran on every sub-step, and 2b runs UNCONDITIONALLY with an
  // alternating direction, so at K=9 a parcel could be displaced sideways up to 9 cells in a single tick. A blob of
  // liquid dropped into a pool is therefore shredded into thin slivers strewn across many columns before it has risen
  // more than a cell or two, which is not what separating looks like.
  // GATE: the diagonal only fires when the straight-up swap did NOT — i.e. the cell below is solid, empty, or the pair
  // simply is not inverted. That is exactly the rationale the LEDGE SPILL (1b) already uses: the diagonal is a way PAST
  // an obstacle, not a second route that always runs alongside the vertical one. With clear water above, a parcel now
  // rises straight up.
  fineSortDiagGate: true,
  // ...and a cap on top, the way fineFlatSteps caps 1d: the diagonal may only run in the first N of the sort sub-steps,
  // so lateral travel is bounded to N cells/tick rather than K. 0 = follow the sort sub-steps (no cap) — deliberately
  // the default, because the right value is a feel judgement and inventing one here would just be a guess.
  fineSortDiagSteps: 0,
  // ── (2c) PER-LIQUID LEVELLING — MEASURED to be what actually spreads a parcel sideways (probe_sort_spread).
  // 2c flattens each liquid's OWN layer across columns. It scans up to LIQUID_LEVEL_SCAN cells to choose a direction
  // and runs on every one of the K sub-steps, so a 3-column blob of oil dropped into a 58-wide pool is filmed across
  // the WHOLE pool in a single tick — 216 units over 54 cells is ~4 units each, i.e. thin scattered slivers rather
  // than a blob that rises and gathers. (The diagonal sort 2b was the obvious suspect and measured an exact no-op.)
  // Two independent dials, BOTH defaulting to today's behaviour so nothing changes until they are turned down:
  //   finePerLiquidSteps — how many of the K sub-steps 2c may run in ⇒ its spread SPEED in cells/tick. 0 = all of them.
  finePerLiquidSteps: 0,
  //   finePerLiquidScan  — how far 2c looks along the row for a lower spot of its own liquid, in cells. Shorter keeps
  //   the flattening LOCAL instead of reaching across a pool. 0 = follow LIQUID_LEVEL_SCAN (28), the original reach.
  //   DEFAULT 0 (= the full 28) again: throttling the reach limited spread but also made the oil/water INTERFACE
  //   jagged, because both are the same operation (measured jaggedness 9 at reach 2 vs 1 at full reach). With the
  //   per-exchange sort gate handling the spread instead, the reach is free to stay long.
  finePerLiquidScan: 0,
  // ⭐⭐ SYMMETRIC SORT GATE for 2c. `sortBeforeLevel` stops a still-stratifying cell from levelling, but 2c is an
  // EXCHANGE and the gate only covered the cell being processed — a settled neighbour could reach in and pull a
  // parcel apart from the other side. With this on, 2c also refuses a PARTNER column that is still sorting, so
  // "nothing levels while it is still separating" is true in both directions. That is what makes a LONG reach safe:
  // a parcel keeps its shape while it sorts, then the interface flattens at full speed once it has settled.
  // ⭐⭐ THIS IS THE RULE THAT LIMITS SPREAD WHILE SORTING — measured: buried blob 13 columns with it on, 50–58 with
  // it off, and it is what lets the REACH stay long (a long reach flattens the interface; throttling the reach is what
  // made interfaces jagged). 🟥 I first measured this as near-inert and was wrong: that run predated
  // fineSortOnePerPass, and without that a sliver teleported to the surface, where it already counted as settled, so
  // this gate had nothing left to block. The two changes only work together.
  // ⭐ DEFAULT true → false on 2026-08-24, on the USER'S call and a re-measurement. Re-derived with the rebuilt
  // `probe_sort_spread` (a 3×3 oil blob buried in a 58-wide water pool):
  //     ON  — 13 columns after one tick, settled at t13
  //     OFF — 39 columns after one tick, settled at t5
  // 🟥 AND THE END STATE IS THE SAME EITHER WAY: 58 columns, the full pool. Of course it is — oil on water IS a
  // surface layer. So this gate never prevented the spread, it only slowed the TRANSIENT, and it was charging
  // 2.6× the settling time and ~1.25× the whole liquid tick to do it. The user: *"the performance savings and
  // levelling speed up is preferable to the visual benefit of not having it disperse horizontally so quickly."*
  // ⭐⭐ AND IT PAYS A SECOND TIME: `plSkip`'s one wrinkle was that skipping the branch also skipped THIS call,
  // whose answer is memoised per column and never refreshed within a sub-step. With the gate off there is no
  // such call to skip, so that optimisation becomes exactly behaviour-preserving.
  // ⚠️ If slivers-scattered-across-the-pool ever comes back, this is the first switch to try, and the reach and
  // passes dials for per-liquid levelling are the ones that bound the EXTENT rather than the rate.
  // 🟥 TURNED BACK ON FOR ONE INCREMENT ON 2026-08-24 AND REVERTED THE SAME DAY. The argument for turning it on
  // again was that the measurement behind switching it off ran with the budget OFF (K=9, settles in 5–13 ticks),
  // so "the end state is the same either way" cannot be quoted about a pour that never reaches its end state.
  // That reasoning still stands as far as it goes — and it is beside the point. The user's ruling: both of these
  // gates COST measured performance and NEITHER is a fix for the artefact being chased. The horizontal streaks
  // are separated PACKETS of falling liquid — liquid frozen in mid-air by the strip scheduler and released in
  // bursts — not a parcel filmed sideways. ⇒ fix the freeze; do not pay for a smear that is not happening.
  finePerLiquidSortGate: false,
  // ⭐⭐ …AND THE GATE ABOVE ASKS ITS QUESTION OF THE LIQUID BODY, NOT THE WHOLE COLUMN.
  // "Is my neighbour still stratifying" used to be answered over the column's ENTIRE DEPTH. In a page room that
  // is 405 rows of mild waste; in the Overworld it is 4,096, so one drop of falling water paid to scan every
  // live 64-row segment beneath itself, nine sub-steps a tick, and a pool in a cave far below could veto an
  // exchange at the surface. Measured at 17% of the entire server. An inversion is two ADJACENT liquid cells,
  // so only the contiguous run the cell sits in can matter — that run is what is walked now.
  // OFF restores the whole-column scan exactly (kept for A/B and for the golden replay).
  sortColRun: true,
  // ⭐⭐ ONE CELL PER SORT PASS. `list` is scanned BOTTOM-UP (right for falling), which let each higher cell pull the
  // same light liquid up one more cell within a single pass — so a sliver rode the whole height of a pool in one
  // sub-step and was then filmed across it by 2c, while the bulk rose at the expected rate. This makes a parcel
  // advance exactly one cell per sort pass, which is what "density-sort passes/tick" is supposed to mean.
  // ⭐ DEFAULT true → false on 2026-08-24, on the user's eye: *"it seems to look better when off… probably
  // something that looked better before the metaball was implemented."* Which is the same reason `fineFlatSteps`
  // moved 3 → 8 — the RENDERER changed underneath a dial that was tuned before it.
  // Re-measured on the same scene: 17 columns after one tick against 13, and it costs ~1.18× of the tick.
  // ⚠️ What it did was stop a sliver riding the whole height of a pool in ONE pass (the list is walked bottom-up,
  // so each higher cell pulled the same light liquid up one more). With it off the parcel reaches the surface on
  // tick 0 instead of tick 1. That is the thing to watch if instant stratification ever looks wrong.
  // 🟥 ON for one increment on 2026-08-24 and reverted the same day — see the note on `finePerLiquidSortGate`
  // above, which is the full account. This one had the user's own eyeball behind switching it off as well.
  fineSortOnePerPass: false,
  // CELL CAPACITY = the number of vertical fill "slices" a cell holds (LIQUID_MAX). Higher = smoother/finer vertical fill;
  // must stay ≤255 (Uint8). Changing it RESCALES all existing liquid (a full cell stays full) + re-broadcasts. Global
  // (coarse + fine); at 64 the coarse system is unchanged. Stratification (sortRate units/tick) is proportionally slower higher.
  cellCap: 24,
};
// DEBUG perf accounting (only touched when liquidCfg.perfLog): runLiquidTick tallies sim time + active cells and
// prints a rolling ~1s summary to the console. (emitLiquidCells, which centralised the coarse `liquid-cells` emit so
// its wire payload could be sized, went with that wire.)
let liqPerf = { simMs: 0, simMsMax: 0, pendAt: 0, idleRooms: 0, ticks: 0, fineMs: 0, fineMsMax: 0, fineActive: 0, fineBytes: 0, fineChanged: 0, deferred: 0, reactMs: 0, reactMsMax: 0, actChunks: 0, actCols: 0, pending: 0,
  chunkMs: 0, chunkMsMax: 0, kMin: 99 };   // kMin: the LOWEST K tier 2 used this window (see the note where it is set)
// Wall-clock slice the gen pre-settle may spend before handing the rest to the live sim. It is a SYNCHRONOUS stall on
// the first join, so this is a latency budget, not a quality dial — see the note in ensureWorldGenerated.
// ⭐ 0 = OFF, and that is the shipping value. Tried at 200 and the user reported prolonged lag on joining: the cost is
// PER ROOM (every page URL is its own room, so joining several at once multiplies it), the stall blocks every other
// room on the server because ensureWorldGenerated is synchronous, and the budget cannot prevent the first iteration —
// ~540ms on a fresh world — because it is only checked at the top of the loop. Generated worlds therefore settle live
// again, as they already did before this was found to be dead code. Raising this trades join latency for less on-load
// sloshing; measure with probe_gen_presettle.js before picking a value.
const PRESETTLE_MS = 0;
const LIQUID_MS = 60;                                 // legacy default (the live rate is liquidCfg.tickMs)
// (LIQUID_FLOOR_ROW is derived inside liquidTickRoom because FLOOR_TOP is declared later in the file.)
const LIQUID_MAX_ACTIVE = 80000;                      // safety cap on tracked active cells per room
const LIQUID_MAX_PER_TICK = 9000;                     // process at most this many cells/room/tick (rest carry over)
// ⭐⭐ THE PACKED SORT KEY (see the sort in `fineLiquidTickRoom`). Three fields in one double, ordered so that a
// plain ascending numeric sort reproduces the old comparator exactly: row DESCENDING · total ASCENDING · the
// cell index (flipped on alternate ticks, the lateral symmetry-breaker). The index is unique, so the key is
// unique and there are no ties left to resolve — the permutation is identical, not merely equivalent.
// 4,095 · 2^39 + 255 · 2^31 + 2^31 ≈ 2.25e15, comfortably inside 2^53, so every key is an exact integer.
// ⚠️ Every bound is CHECKED at the call site, not assumed. `_MAX` values are what the packing can hold; a room
// outside them takes the original comparator.
const SORT_IDX_MAX = 0x7fffffff;                      // the flat index cap the Overworld's width was chosen for
const SORT_TOT_MUL = 0x80000000;                      // 2^31 — one place value above the index
const SORT_TOT_MAX = 256;                             // `cap` is clamped to 255 on the liquid-cfg wire
const SORT_ROW_MUL = SORT_TOT_MUL * SORT_TOT_MAX;     // 2^39 — one place value above the total
const SORT_ROW_MAX = 4096;                            // OVERWORLD_DIMS.rows, the tallest world there is
// Reused across sub-steps and ticks: this used to be `Array.from(active)` nine times a tick, which for a busy
// room is a 20,000-element allocation per sub-step.
let _sortBuf = new Float64Array(1024);
// (roomLiquidActive / roomLiquidAmt / roomLiquidTotal — the COARSE liquid state — were deleted with liquidTickRoom
//  on 2026-07-29. The roomFine* arrays are the liquid now.)
// ── THE WHOLE STREAM-RECONSTRUCTION APPARATUS IS GONE (slices 2a/3/4, 2026-07-29). Three per-cell annotations lived
// here and all three existed for the same reason — a partial-fill cell holds a scalar with no horizontal position, so
// a thin stream had to be reconstructed from history the grid had thrown away:
//   SIDE_LEFT/SIDE_RIGHT + the fallSide tag — which wall a falling parcel hugged (see the tombstone in liquidCfg)
//   roomStream2Amt/Id — the s2 SECONDARY LANE, letting two streams share one scalar cell in a 1-wide chute
//   roomLiquidFlow*  — display-twice: per-side, per-rank inflow, so an incoming strip could be drawn over the pool
// At 8px cells the grid has enough resolution to just hold a stream, which retires all of it.
// SATURATION (terrain reactions): absorbent solids (earth/sand) soak up adjacent water into a per-cell accumulator (0..SAT_MAX).
// Earth → Mud at saturation (cell-by-cell); saturated Sand → Quicksand once part of a wet CLUMP; Mud dries back to Earth as its
// saturation decays away from water (instant under lava). Internal only — clients see the resulting grid changes, not the value.
// (`sat` on the cell store: absorbed-water units per absorbent/wet solid cell.)
// ACID NEUTRALISATION — SATURATION model (tuned in the harness): acid SOAKS UP water (consuming it) into a per-cell dilution
// accumulator, and only once saturated (dilution ≥ acid·K) does the acid CONVERT to water — both rate-limited, so a drop can't
// clear a pool and it's never instant. Water is consumed (volume drops), which is the accepted tradeoff for "limited water".
// (`dilute` on the cell store: water soaked into an acid cell, awaiting conversion — Float32 because K can be non-integer.)
function ensureDilute(room) { const s = cellsOf(room); return s.dilute || (s.dilute = newPagedField('dilute', worldGeom(room), room)); }
const ACID_K = 1.5;          // water soaked (consumed) to saturate + convert 1 acid unit
const ACID_SOAK_TICKS = 2;   // soak 1 water into dilution every N ticks (rate ≈ 1/N ≈ 0.5/tick)
const ACID_CONVERT_TICKS = 2;// convert 1 acid → water every N ticks once saturated (rate ≈ 0.5/tick)
let liquidTickCount = 0;
let liquidQuiet = false;                              // when true, the sim runs but suppresses broadcasts (used to pre-settle at gen time)
// ⭐ `roomLevelAcc` / `ensureLevelAcc` DELETED 2026-07-31. The coarse per-cell LEVELING carry: the sub-unit remainder
// of each throttled levelling move, phase-seeded so the invisible 1-unit steps did not all align. Its only consumer
// was `reduce` inside liquidTickRoom, so it went unreferenced the day the coarse sim was cut (2026-07-29) and simply
// was not noticed — a full-world Float32Array per room, allocated by nobody. The FINE sim has its own carry
// (`fineLevelAcc`), which is live and untouched. Found by the Phase 2 consolidation, which had to name every array.
// ── FINE-CELL LIQUID (experimental, gated by 1) — a parallel liquid grid at SUB× resolution, in SEPARATE
// arrays so the coarse system is UNTOUCHED. Same layout as the coarse arrays but sized FCOLS*FROWS. Terrain is read from
// the coarse grid via coarseOf() (map-on-read; the fine sim never writes terrain), and liquid lives only in these arrays.
// (roomFineAmt/Total/Active/LevelAcc/Sub + the quiescence counters are `fineAmt`/`fineTotal`/`fineActive`/
//  `fineLevelAcc`/`fineSub`/`fineStill` on the room's cell store.)
// Wipe a room's liquid outright (world clear / scene load). The coarse version of this inlined five array fills at
// each call site; there is one grid now, so it is one helper.
// ⚠️ CLEARS, never drops: the Sets stay allocated and the room stays in cellRooms, exactly as emptying the old
// dictionary entries left their keys in place.
function clearFineRoom(room) {
  const s = cellsOf(room);
  if (s.fineAmt) s.fineAmt.fill(0);
  if (s.fineTotal) s.fineTotal.fill(0);
  if (s.fineActive) s.fineActive.clear();
  if (s.fineReact) s.fineReact.clear();
  if (s.fineFire) s.fineFire.clear();
}
function ensureFineArrays(room, SUB) {
  const s = cellsOf(room);
  const cells = (s.cols * SUB) * (s.rows * SUB);                        // Phase 6: this room's shape, not the module constants
  if (s.fineSub !== SUB || !s.fineAmt || s.fineTotal.length !== cells) {
    s.fineSub = SUB;
    const geom = chunkGeom(s.cols * SUB, s.rows * SUB);
    s.fineAmt = newPagedField('fineAmt', geom, room);
    s.fineTotal = newPagedField('fineTotal', geom, room);
    cellRooms.fineArr.add(room);
    // The levelling carry's per-index phase is applied PER PAGE as it faults in (seedLevelAcc), not by writing
    // `cells` floats up front — same values at the same indices, but an untouched region costs nothing.
    s.fineLevelAcc = newPagedField('fineLevelAcc', geom, room);
    fineSet(room);
  }
  return s.fineAmt;
}
function fineSet(room) { const s = cellsOf(room); if (!s.fineActive) { s.fineActive = new Set(); cellRooms.fine.add(room); } return s.fineActive; }
// ⭐ WAKE THE NEIGHBOURS of a cell whose stack was written from OUTSIDE the tick (placement, undo, a scene load).
// The density sort is only ever driven from the UPPER cell of a pair — processing a cell compares it with the cell
// BELOW — so dropping a lighter liquid under a settled heavier one activates the wrong half: the new cell has nothing
// to sort against below it, the cell above it is not active, and NOTHING happens. Measured: 2 cells of oil placed at
// the bottom of a settled water pool sat there forever, room quiet on the very next tick, with two genuine density
// inversions left standing. That is the "stuck slices" — and because the client spawns rise/sink bubbles for any
// sliver that is inverted with a neighbour, a permanently stuck inversion means the bubbles never stop.
function fineWakeAround(room, i) {
  const s = cellsOf(room), tot = s.fineTotal, grid = s.terrain;
  if (!tot || !grid) return;
  const N = grid.length, ROWS = s.rows, r = i % ROWS, act = fineSet(room);
  for (const j of [r > 0 ? i - 1 : -1, r < ROWS - 1 ? i + 1 : -1, i - ROWS, i + ROWS]) {
    if (j < 0 || j >= N || tot.g(j) <= 0) continue;
    const v = grid.g(j); if (v !== 0 && !isFluidId(v)) continue;
    act.add(j);
  }
}
// ⭐ RE-COUPLED 2026-07-29. The terrain grid holds the fine cell's REPRESENTATIVE fluid id again, exactly as the coarse
// system always did. It was decoupled only because at SUB>1 nine fine cells shared one grid cell and no single id could
// stand for them; at the all-fine ratio one fine cell IS one grid cell, so that reason is gone. Keeping them apart
// silently broke everything that asks "what material is at this cell?" — powder displacement, soil saturation,
// collision buoyancy, the renderer, and the FX transition table — each of which had to be patched at its own call site.
// Call this for every fine cell whose stack changes; it is a no-op on a cell a real solid owns (liquid never lives
// inside one). Returns true if the grid actually changed, so callers can add it to a terrain broadcast.
function fineSyncGrid(room, i) {
  const s = cellsOf(room), grid = s.terrain, amt = s.fineAmt, tot = s.fineTotal;
  if (!grid || !amt || !tot || i < 0 || i >= grid.length) return false;
  const v = grid.g(i);
  if (v !== 0 && !isFluidId(v)) return false;          // a real solid owns this cell
  const id = tot.g(i) > 0 ? liqRepId(amt, i) : 0;
  if (v === id) return false;
  grid.s(i, id); const hp = s.terrainHp; if (hp) hp.s(i, 0);   // liquid is not diggable
  return true;
}
// Reaction amounts are FRACTIONS OF A CELL, resolved against the live capacity, so they keep meaning the same thing
// when cellCap is changed. Hard-coded unit counts were calibrated at cap 64 and silently became 2.7× stronger at 24.
const capFrac = (f) => { const v = Math.round(LIQUID_MAX * f); return v < 1 ? 1 : v; };
// Scratch for the flux-levelling flood fill (`fineFluxSeen`/`fineFluxStack` on the cell store, reused per room so the
// pass allocates nothing per tick). ⭐ The COARSE pair — `roomFluxSeen`/`roomFluxStack` + ensureFluxSeen/ensureFluxStack
// — was DELETED 2026-07-31 for the same reason as roomLevelAcc: the coarse flux pass was its only caller and went with
// liquidTickRoom on 2026-07-29, leaving two more full-world arrays nobody allocated. The fine pair below is live
// (`fineLiquidTickRoom`'s flux pass), though note flux levelling itself is SHELVED behind `liquidCfg.fluxLevel`, off.
function ensureFineFluxSeen(room, cells) { const s = cellsOf(room), a = s.fineFluxSeen; return (a && a.length === cells) ? a : (s.fineFluxSeen = newPagedField('fineFluxSeen', chunkGeom(s.cols * (s.fineSub || 1), s.rows * (s.fineSub || 1)), room)); }
// ⚠️ NOT paged: this is a flood-fill STACK, indexed by stack position, not by cell — paging it would be meaningless.
// It is only allocated when `liquidCfg.fluxLevel` is on, which is SHELVED and off by default.
// ⚠️ THE ONE PER-CELL FIELD THAT IS NOT PAGED — a flat full-world Int32Array, i.e. 4 bytes per world cell, which is
// exactly the area-linear cost Phase 6 is removing everywhere else. It costs nothing TODAY only because flux
// levelling is shelved (liquidCfg.fluxLevel default off), so this is never called. It is a stack, not a grid, so
// paging is the wrong fix — it wants to grow on demand instead. Deliberately left for whenever flux is revived.
function ensureFineFluxStack(room, cells) { const s = cellsOf(room), a = s.fineFluxStack; return (a && a.length === cells) ? a : (s.fineFluxStack = new Int32Array(cells)); }
// `isSolid` inside liquidTickRoom is a closure over that call; callers outside it need their own.
const isSolidCell = (v) => v !== 0 && !isFluidId(v);
// A coarse source writes into cells outside the liquid tick, so those cells need broadcasting in the same wire format
// the main loop uses. Kept to exactly that format so the client has one parser, not two. (Was dropletBroadcastCells —
// the landing half went with the droplet cascade; the coarse sourceTickRoom is the only caller left.)
// SOURCE PASS — top every source cell back up. Runs BEFORE the droplets and the grid each tick, so liquid a source
// makes is ordinary pooled liquid by the time anything looks at it (it spends a tick in the cell like any other
// arrival). A source cell whose grid square has been built over with a SOLID is deleted: that is how you remove one.
// It does NOT require the cell to currently hold liquid — a fully drained source must still refill, and a drained
// cell reads as air.
function sourceTickRoom(room) {
  const s = cellsOf(room), src = s.src; if (!src || !src.size) return;
  sourceTickRoomFine(room, s.fineSub || 1);
}
// ---- GRANULAR POWDER (sand 3, snow 8) — SOLID cells that fall + pile like a classic falling-sand CA, distinct from the
// liquid-leveling flow. A grain moves DOWN or DOWN-DIAGONAL only (→ ~45° angle of repose / piling), NEVER sideways (so it
// piles instead of leveling flat). Meeting a liquid cell = SWAP: the grain sinks a cell and that cell's whole liquid stack
// bubbles up into the vacated cell → grains sink through liquid to the floor, mass-conserved for both. Powder cells stay
// real solids (dig / collision / render unchanged); movement broadcasts over the existing `liquid-cells` wire (it already
// carries arbitrary gridId changes — the client sets grid+hp from it). Only PLAYER edits (paint/dig) + cascades wake powder,
// so generated worlds keep their designed shape until disturbed. Validated in scratchpad/powder_sim.js (18/18, fuzz 40/40).
// ⭐ TWO QUESTIONS, NOT ONE — and the world redesign is what forced them apart.
//   isPowderId(v)     "does this cell MOVE like a grain?"   sand · snow · scree · ash · AND EVERY PLANT
//   isPowderSeedId(v) "should generation WAKE this cell?"   sand · snow · scree · ash only
// A canopy overhangs — that is what a canopy is — so plant cells with air beneath them are the shape, not a
// defect. Measured in the spike: 6.1% of all falling cells have no support and `frond` (a palm crown, which is
// nothing but overhang) is 81.6%. Reseeding plant cells the way sand is reseeded would shed every forest in the
// world on the first tick. So plants get the same MOVEMENT and a different WAKE: they enter the active set only
// when a neighbouring cell is EDITED, which is exactly the cut-the-trunk case the user asked for.
// ⚠️ THE SLICED-BLOCK SEAM (the failure this file has hit eight times). These tables are filled for the two
// built-in powders HERE, inside the block the probe rigs compile on their own, and topped up from
// materials.js BELOW the block — the declare-a-stub-and-reassign pattern `wireFanout`/`drainGenLiquid` use.
// A rig therefore sees exactly today's behaviour (sand + snow) instead of a ReferenceError.
const POWDER_MOVE = new Uint8Array(256), POWDER_SEED = new Uint8Array(256), MAT_HANGS = new Uint8Array(256);
POWDER_MOVE[3] = POWDER_MOVE[8] = POWDER_SEED[3] = POWDER_SEED[8] = 1;
// ⭐ A THIRD KIND OF FALLING THING: A RIGID BLOCK. Sand and snow are GRAINS — they sink through water and they
// slide off a heap into a 45° pile, because that is what a heap of grains does. Ice is neither: it FLOATS, and a
// slab of it does not trickle sideways. Both consequences come off one flag, because they are one fact about the
// material (it is a rigid solid less dense than water) rather than two tunable behaviours:
//   · it never displaces a fluid, so a floe rests ON the sea instead of sinking through it — which is also what
//     makes the generator's pack ice and bergs stable without generation having to know about the sim;
//   · it does not slide diagonally, so digging under a sheet drops it straight down instead of turning it into
//     a scree slope.
// ⚠️ NOT in POWDER_SEED, deliberately. Generated ice is either a floe (which the float rule already holds up) or
// ice on solid ground, so seeding it would wake cells that cannot move — and this track has already measured
// what that costs: a chunk that settles itself stops being throw-away-able, which is what increments 4c/4d were
// built to avoid. Player edits wake it through `activatePowderRect`, which is the dig-under-it case.
const MAT_RIGID = new Uint8Array(256);
MAT_RIGID[4] = 1;                                      // ice
POWDER_MOVE[4] = 1;
const isPowderId = (v) => POWDER_MOVE[v] === 1;
const isPowderSeedId = (v) => POWDER_SEED[v] === 1;
// (`powderActive` on the cell store: Set<cellIndex> of powder cells that might still move.)
let powderTickCount = 0;                               // ticked in lockstep with the liquid sim → grains fall at the same gravity speed
function powderSet(room) { const s = cellsOf(room); if (!s.powderActive) { s.powderActive = new Set(); cellRooms.powder.add(room); } return s.powderActive; }
// Wake powder in + just above a rect after a terrain edit: a dig removes support (grains above cascade down), a paint drops
// unsupported grains. The r0-1 margin seeds the cascade — each moving grain then wakes the one above it.
function activatePowderRect(room, grid, c0, r0, c1, r1) {
  const COLS = grid.geom.cols, ROWS = grid.geom.rows;
  // …and one row BELOW as well, for materials held up from above (vine): cutting its anchor is an edit in the
  // rect, and the cell that has to fall is the one under the last cell the brush touched.
  c0 = Math.max(0, c0); r0 = Math.max(0, r0 - 1); c1 = Math.min(COLS - 1, c1); r1 = Math.min(ROWS - 1, r1 + 1);
  const s = powderSet(room);
  for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) { const i = c * ROWS + r; if (isPowderId(grid.g(i))) s.add(i); }
  if (!s.size) dropPowderSet(room);
}
// SATURATION tuning (terrain reactions). SAT_MAX ≈ "a cell's worth" of water; ABSORB per absorb-tick; DRY per soil-tick when
// away from water; a saturated sand cell needs ≥ CLUMP saturated-sand/quicksand neighbours to turn (keeps beach edges dry).
const SAT_MAX_F = 0.1875, SAT_ABSORB_F = 0.0625, SAT_DRY = 1, SAT_CLUMP_MIN = 3;   // low SAT_MAX: earth saturates fast + absorbs little water → flow barely slowed, pre-gen lakes barely shrink
function ensureSat(room) { const s = cellsOf(room); return s.sat || (s.sat = newPagedField('sat', worldGeom(room), room)); }
// (`soilActive` on the cell store: Set<cellIndex> of absorbent/wet solid cells worth ticking — earth/sand soaking, mud drying.)
function soilSet(room) { const s = cellsOf(room); if (!s.soilActive) { s.soilActive = new Set(); cellRooms.soil.add(room); } return s.soilActive; }
// Seed the soil set so soilTickRoom processes absorption/drying around water. Called on PAINT and at GEN (not just when a
// water cell happens to be "active") → placement + pre-generated lakes reliably + consistently start absorbing.
function seedSoilAround(room, grid, i) {
  const nn = grid.length, ROWS = grid.geom.rows, r = i % ROWS, N = [r > 0 ? i - 1 : -1, r < ROWS - 1 ? i + 1 : -1, i - ROWS, i + ROWS];
  // In fine mode water is not a grid id — it is rank 4 of the fine stack — so both tests below have to read the fine
  // arrays or nothing is ever seeded and the whole saturation model stays asleep.
  const st = cellsOf(room);
  const fine = (st.fineSub || 1) === 1 && st.fineAmt;
  const famt = fine ? st.fineAmt : null;
  const isWater = (j) => fine ? famt.rp(j)[famt.o(j) + 4] > 0 : grid.g(j) === 9;
  const g = grid.g(i);
  if (isWater(i)) { const ss = soilSet(room); for (const j of N) { if (j < 0 || j >= nn) continue; const gj = grid.g(j); if (gj === 1 || gj === 3 || gj === 5) ss.add(j); } }        // water → seed absorbent neighbours
  else if (g === 1 || g === 3 || g === 5) { for (const j of N) if (j >= 0 && j < nn && isWater(j)) { soilSet(room).add(i); return; } }                                            // absorbent solid placed by water → seed itself
}
// Set a cell to a single full-CAP liquid `id` (paint / gen / seed). Clears the other layers.
// Representative id (heaviest present) for grid[i], or 0 if the cell holds no liquid.
function liqRepId(amt, i) { const p = amt.rp(i), base = amt.o(i); for (let rk = 0; rk < LIQ_T; rk++) if (p[base + rk] > 0) return LIQ_ID[rk]; return 0; }
// Wake + seed every cell in a rect after a terrain edit: a freshly PAINTED fluid becomes a full single-liquid stack, a
// CARVED-away fluid is cleared, and any surviving fluid is re-activated so it can flow.
function activateLiquidRect(room, grid, c0, r0, c1, r1) { fineActivateRect(room, grid, c0, r0, c1, r1); }
// After generation: every fluid grid cell becomes a full single-liquid stack + wakes (they settle in a few ticks).
// This used to fill the COARSE arrays and then call upscaleRoomToFine to hand them over, which at the all-fine ratio
// (one liquid cell per terrain cell) was a copy from an array to an identically-shaped array. It now seeds the fine
// grid directly. Same result, and it is what let upscaleRoomToFine/downscaleRoomToCoarse go.
function seedLiquidActivity(room) {
  const s = cellsOf(room), grid = s.terrain; if (!grid) return;
  ensureFineArrays(room, 1);
  const amt = s.fineAmt, tot = s.fineTotal, act = fineSet(room);
  amt.fill(0); tot.fill(0); act.clear();
  // Only pages that exist can hold a fluid id — an unallocated terrain page is all zeros (see PagedArray.scan).
  // ⚠️ THE SAME "wake only what can move" RULE AS THE ON-DEMAND SEEDER, and it has to be the same rule or the
  // two world generators disagree about what a freshly built world costs. This is the build-it-all-up-front
  // path, so it is a page world today — where the saving is small because a page world's lakes are small — but
  // leaving one path unconditional is how the two drift.
  const _geomW = worldGeom(room);
  grid.scan((i, _o, page) => {
    const v = page[_o]; if (!isFluidId(v)) return;
    amt.wp(i)[amt.o(i) + LIQ_RANK[v]] = LIQUID_MAX; tot.s(i, LIQUID_MAX);
    if (act.size < LIQUID_MAX_ACTIVE && (liquidCfg.genWakeAll || genLiquidLoose(grid, i, _geomW, v))) act.add(i);
  });
  grid.scan((i, _o, page) => { if (page[_o] === 9) seedSoilAround(room, grid, i); });   // pre-generated lakes absorb just like poured water (no special-casing)
  if (!act.size) dropFineActive(room);
}
// ⭐ AND THE SAME FOR POWDER (user, 2026-08-05): *"powders should not be static upon generation and should
// rather fall and settle as they would once disturbed"*. Generated sand and snow used to sit exactly where the
// noise put it — including in mid-air and on slopes far past the 45° angle of repose — until a player happened
// to dig near it, at which point a hillside would collapse for no visible reason. Seeding them here means the
// world arrives at rest, and the pre-settle loop below does the settling silently before anyone can see it.
// ⚠️ ONLY GRAINS THAT COULD ACTUALLY MOVE. `powderTickRoom` drops a grain from the active set the moment it
// finds it supported, so seeding everything is CORRECT but makes the first tick walk every grain in the world —
// and a desert world is nothing but grains. A grain with something solid directly beneath it is already at rest;
// the ones worth waking are those over air or over liquid (which they sink through).
function seedPowderActivity(room) {
  const s = cellsOf(room), grid = s.terrain; if (!grid) return;
  const ROWS = grid.geom.rows;
  const set = powderSet(room);
  grid.scan((i, _o, page) => {
    if (!isPowderSeedId(page[_o])) return;              // SEED, not MOVE: never wake a plant at generation
    if ((i % ROWS) + 1 >= ROWS) return;                 // resting on the bottom row of the world
    const below = grid.g(i + 1);                        // column-major: +1 is the cell BELOW
    if (!below || isFluidId(below)) set.add(i);
  });
  genPowderSeeded += set.size;
  if (!set.size) dropPowderSet(room);
}
// Join replay: the full multi-liquid state as a flat list (same mask encoding as the live liquid-cells wire, side 0) for
// every cell that holds liquid. (Per-cell, not RLE — fine for the ~2k fluid cells a generated world has.)
// ⭐ THE COARSE `liquidTickRoom` (601 lines) WAS DELETED HERE, 2026-07-29.
// It was the original 24px-cell multi-liquid sim: density sorts, straight-down fall, the diagonal ledge spill, lateral
// and per-liquid levelling, flux levelling, reactions, sources/sinks and the stream-tag annotation. `fineLiquidTickRoom`
// below is its successor and, at the all-fine ratio, its equivalent — `probe_fine_identity` proves the fine sim
// reproduces the recorded coarse flow tick-for-tick against golden vectors in scratchpad/golden_coarse_flow.json.
// It had been DEAD AT RUNTIME since all-fine landed: runLiquidTick iterated roomLiquidActive, which fine mode never
// populated. That was measured before cutting, not assumed — scratchpad/probe_coarse_dead.js drives every real entry
// point and asserts the coarse active set stays empty, with a fine:false control proving the check can actually fail.
// GRANULAR POWDER tick (sand/snow). Falling-sand CA on grid[]: each active grain moves DOWN or DOWN-DIAGONAL only (piles at
// ~45°, never levels), swapping with a liquid it enters (grain sinks, liquid rises). Broadcasts moved cells over liquid-cells.
function powderTickRoom(room) {
  const st = cellsOf(room), grid = st.terrain, hp = st.terrainHp, active = st.powderActive;
  if (!grid || !hp || !active || !active.size) { if (active && !active.size) dropPowderSet(room); return; }
  const mats = roomMats[room] || {}, T = LIQ_T, COLS = st.cols, ROWS = st.rows, tick = powderTickCount, nn = grid.length;
  const FLOOR_ROW = Math.floor(roomFloorTop(room) / TERRAIN_CELL);   // grains may not enter the bedrock floor row (same as liquid)
  // FINE mode: liquid lives in the roomFine* arrays and the terrain grid holds SOLIDS ONLY, so `isFluidId(grid[j])`
  // never matches and a grain read a liquid cell as plain AIR — it fell straight through the pool and, worse, the
  // grid[dst]===0 branch left the fine liquid sitting INSIDE the new solid cell. Same sink-and-swap logic, fine arrays.
  ensureFineArrays(room, 1);   // the fine arrays ARE the liquid; there is no coarse fallback to degrade to
  const famt = st.fineAmt, ftot = st.fineTotal;
  // 🟥 SAND LANDING ON WATER AND STOPPING DEAD — reported from play 2026-08-05, and doubly bad as reported:
  // "if the liquid is moving the liquid flows out from underneath it and the sand floats in mid-air."
  // This read `grid.g(j) === 0`, and the comment on it said "liquid is not a grid id, so an empty grid cell
  // covers a pool too". THAT STOPPED BEING TRUE when liquid was re-coupled to the grid: `fineSyncGrid` writes
  // the fluid's id INTO the terrain grid (`grid.s(i, liqRepId(...))`), so a water cell reads 9, not 0, and a
  // grain treated an open pool as solid ground. The comment was load-bearing and stale — the code did exactly
  // what it said, and what it said had stopped being the case.
  // ⭐ THE MACHINERY WAS ALREADY THERE. `swapMove` below is written to carry a displaced pool UP into the cell
  // the grain vacates (`carried = ftot.g(dst)`, and it re-wakes the liquid around it). Powder sinking through
  // liquid was the designed behaviour all along; only this predicate refused it.
  // 🟥 THE TICK MUST NOT BUILD WORLD EITHER, AND THIS IS THE EXACT CASCADE ALREADY ON THE RECORD. The note on
  // the powder SEEDER reads: "a grain at a chunk's bottom edge produced the chunk beneath it, whose seeding
  // produced the one beneath that, to bedrock — 64 chunks deep, 8,191 wide, and the server stopped answering."
  // The seeder was changed to peek. THE TICK WAS NOT, and it is the hotter path: `canDisplace` asks "what is
  // below this grain?" of every falling grain, every tick. MEASURED at 840 chunks generated from inside the
  // powder pass over 35s, second only to reactions.
  // ⭐ UNBUILT ⇒ NOT DISPLACEABLE: a grain resting on the edge of the produced world stays put instead of
  // generating the world beneath itself to fall into. Sky is still honestly air (`skyAt`), so a grain genuinely
  // falling through open sky keeps falling.
  const genRoom = !!grid.seedFn;
  const peekG = genRoom ? (j) => { const v = peekCellAt(grid, j); return v >= 0 ? v : (grid.skyAt(j) ? 0 : -1); } : (j) => grid.g(j);
  const canDisplace = (j) => { const v = peekG(j); return v === 0 || isFluidId(v); };   // -1 (unbuilt) is neither
  // …and the same question asked on behalf of a RIGID block, which floats: air yes, fluid no. See MAT_RIGID.
  const canEnter = (gv, j) => (MAT_RIGID[gv] ? peekG(j) === 0 : canDisplace(j));
  const list = Array.from(active); active.clear();
  list.sort((a, b) => (b % ROWS) - (a % ROWS));   // bottom-up so a falling column cascades in a single pass
  const changedSet = new Set(), fineChanged = new Set();
  // wake grains above the vacated cell → column keeps falling. The cell BELOW is woken too, for the one
  // material that is held up from ABOVE (vine): removing its anchor is what makes it fall, not removing its floor.
  const wakeAround = (i) => {
    const r = i % ROWS;
    if (r < ROWS - 1) { const d = i + 1; if (d < nn && MAT_HANGS[peekG(d)]) active.add(d); }
    if (r <= 0) return;
    for (const j of [i - 1, i - ROWS - 1, i + ROWS - 1]) if (j >= 0 && j < nn && isPowderId(peekG(j))) active.add(j);
  };
  const swapMove = (src, dst) => {
    const P = grid.g(src), hpP = hp.g(src);
    {
      const ps = famt.wp(src), bs = famt.o(src), pd = famt.wp(dst), bd = famt.o(dst);   // src is solid ⇒ holds no fine liquid; dst may hold a pool
      const carried = ftot.g(dst);
      for (let k = 0; k < T; k++) { ps[bs + k] = pd[bd + k]; pd[bd + k] = 0; }   // the pool moves UP into the vacated cell
      ftot.s(src, carried); ftot.s(dst, 0);
      grid.s(dst, P); hp.s(dst, hpP); grid.s(src, 0); hp.s(src, 0);
      fineSyncGrid(room, src);                               // the pool that moved up owns this cell now
      if (carried > 0) { fineSet(room).add(src); fineChanged.add(src); fineChanged.add(dst); }
      else fineChanged.add(dst);
      const sr = src % ROWS; for (const j of [sr > 0 ? src - 1 : -1, sr < ROWS - 1 ? src + 1 : -1, src - ROWS, src + ROWS]) if (j >= 0 && j < nn && ftot.g(j) > 0) fineSet(room).add(j);
    }
    changedSet.add(src); changedSet.add(dst); active.add(dst); wakeAround(src);
    if (liquidCfg.reactions) { seedFineReactAround(room, src); seedFineReactAround(room, dst); }   // a grain landing in a pool is a new contact (snow dropped into water → ice)
  };
  for (const i of list) {
    const gv = grid.g(i);
    if (!isPowderId(gv)) continue;
    const c = (i / ROWS) | 0, r = i - c * ROWS; if (r + 1 >= FLOOR_ROW) continue;
    // 🟥 SUPPORT HAS A DIRECTION, and for one material it is UP. Everything else rests on what is beneath it;
    // a vine hangs off what is above it, so it has air below by definition and the ordinary rule would make it
    // destroy itself the first tick it was woken. The spike recorded this as a bit on the material it could not
    // test (nothing there runs a sim) — this is the sim reading it.
    if (MAT_HANGS[gv] && r > 0 && !canDisplace(i - 1)) continue;   // still hanging from something solid
    const below = i + 1;
    if (canEnter(gv, below)) { swapMove(i, below); continue; }
    if (MAT_RIGID[gv]) continue;                              // a slab falls straight down or not at all — it does not trickle into a pile
    // DIAGONAL SLIDE — the grain must be able to pass THROUGH the side cell, not just land in the target. Checking only
    // the destination let a grain squeeze between two solids that touch only at their corners: it tunnelled through a
    // sealed diagonal crack, and in a pool it slipped past the ice it had just made and froze a diagonal trail behind it.
    for (const dc of (((c + tick) & 1) ? [-1, 1] : [1, -1])) {   // parity per COLUMN — see increment 5's note in the fine tick
      const cc = c + dc; if (cc < 0 || cc >= COLS) continue;
      if (!canDisplace(i + dc * ROWS)) continue;               // side blocked → no corner-cutting
      const j = below + dc * ROWS; if (canDisplace(j)) { swapMove(i, j); break; }
    }
    // couldn't fall or slide → rests (not re-added to active)
  }
  {   // grain movement is a TERRAIN change; any pool it displaced rides the fine-liquid wire
    if (changedSet.size && !liquidQuiet) { const tc = []; for (const j of changedSet) tc.push(j, grid.g(j)); wireFanout(room, 'terrain-set', { cells: tc }); }
    if (fineChanged.size && !liquidQuiet) emitFineCells(room, Array.from(fineChanged));
  }
  if (!active.size) dropPowderSet(room);
}
// ---- SATURATION reactions: earth→mud (cell-by-cell), sand→quicksand (wet CLUMP only), mud dries→earth (instant under lava).
// Runs INDEPENDENTLY of liquid activity (mud must keep drying after every pool has settled). Cells enter roomSoilActive via
// absorption in liquidTickRoom; solid↔solid + sand→quicksand changes ride the same `liquid-cells` wire (it carries gridId).
function soilTickRoom(room) {
  const st = cellsOf(room), ss = st.soilActive; if (!ss || !ss.size) { if (ss) dropSoilSet(room); return; }
  const grid = st.terrain, hp = st.terrainHp;
  if (!grid) { dropSoilSet(room); return; }
  const sat = ensureSat(room), mats = roomMats[room] || {}, COLS = st.cols, ROWS = st.rows, nn = grid.length, T = LIQ_T;
  const SAT_MAX = capFrac(SAT_MAX_F), SAT_ABSORB = capFrac(SAT_ABSORB_F);   // fractions of a cell → they track cellCap
  // ── SAME SATURATION LOGIC, FINE DATA SOURCE. In fine mode liquid lives in the roomFine* arrays and the terrain grid
  // holds solids only, so every `grid[j] === 9` water test and every coarse amt/tot read below found nothing and the
  // whole saturation model was inert (no earth→mud, no sand→quicksand, no drying). Only the ACCESSORS change here —
  // the model itself (SAT_MAX cell-by-cell, the wet-CLUMP rule for sand, drying, lava baking) is untouched.
  ensureFineArrays(room, 1);
  const lam = st.fineAmt, ltot = st.fineTotal;
  const changedSet = new Set(), fineChanged = new Set(), terrChanged = new Set(), fx = [];
  const addFx = (i, code) => { if (fx.length < 2048) fx.push(i, code); };   // same explicit FX wire as the reaction pass
  const isWater = (j) => lam.rp(j)[lam.o(j) + 4] > 0;   // water = rank 4
  const isLava = (j) => lam.rp(j)[lam.o(j)] > 0;
  const adj = (i, id) => { const r = i % ROWS; if (r > 0 && grid.g(i - 1) === id) return true; if (r < ROWS - 1 && grid.g(i + 1) === id) return true; if (i - ROWS >= 0 && grid.g(i - ROWS) === id) return true; if (i + ROWS < nn && grid.g(i + ROWS) === id) return true; return false; };
  const adjFn = (i, fn) => { const r = i % ROWS; for (const j of [r > 0 ? i - 1 : -1, r < ROWS - 1 ? i + 1 : -1, i - ROWS, i + ROWS]) { if (j < 0 || j >= nn) continue; if (fn(j)) return true; } return false; };
  const adjWater = (i) => { const r = i % ROWS; for (const j of [r > 0 ? i - 1 : -1, r < ROWS - 1 ? i + 1 : -1, i - ROWS, i + ROWS]) { if (j < 0 || j >= nn) continue; if (isWater(j)) return j; } return -1; };
  const wakeLiq = (j) => { if (j < 0 || j >= nn || ltot.g(j) <= 0) return; fineSet(room).add(j); };
  for (const i of Array.from(ss)) {
    const v = grid.g(i);
    // ABSORPTION (pull): earth/sand draw water out of an adjacent pool into their saturation, draining it. Only pull from a
    // SETTLED pool (wj not in the active/flowing set) → absorption never fights or slows the leveling of a still-flowing pool.
    if ((v === 1 || v === 3) && sat.g(i) < SAT_MAX) {
      const wj = adjWater(i);
      if (wj >= 0) {                                     // absorb even while the pool is still flowing — SAT_MAX is small enough now that it barely dents leveling
        const wp = lam.wp(wj), wb = lam.o(wj);
        const take = Math.min(SAT_ABSORB, SAT_MAX - sat.g(i), wp[wb + 4]);   // water = rank 4
        if (take > 0) {
          sat.s(i, sat.g(i) + take); wp[wb + 4] -= take; ltot.s(wj, ltot.g(wj) - take);
          fineChanged.add(wj); fineSet(room).add(wj); if (fineSyncGrid(room, wj)) terrChanged.add(wj);
          const wr = wj % ROWS; wakeLiq(wj - ROWS); wakeLiq(wj + ROWS); if (wr > 0) wakeLiq(wj - 1); if (wr < ROWS - 1) wakeLiq(wj + 1);   // re-level: the column above falls into the drained space (no hovering slivers)
        }
      }
    }
    if (v === 1) {                                       // EARTH → MUD once it has soaked up a cell's worth of water
      if (sat.g(i) >= SAT_MAX) { grid.s(i, 5); hp.s(i, matStrengthSrv(mats, 5)); changedSet.add(i); terrChanged.add(i); addFx(i, 5); }   // mud splat   // stays tracked (mud dries later)
      else if (sat.g(i) === 0 && !adjFn(i, isWater)) ss.delete(i);
    } else if (v === 3) {                                // SAND → QUICKSAND, but only inside a wet CLUMP
      if (sat.g(i) >= SAT_MAX) {
        const c = (i / ROWS) | 0, r = i - c * ROWS; let clump = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue; const rr = r + dr, cc = c + dc; if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) continue;
          const j = cc * ROWS + rr; if (j < 0 || j >= nn) continue; const g = grid.g(j);
          if (g === 10 || (g === 3 && sat.g(j) >= SAT_MAX)) clump++;
        }
        if (clump >= SAT_CLUMP_MIN) {                    // sand becomes the QUICKSAND liquid: in fine mode that means a full fine cell, and the terrain cell empties
          { const lp = lam.wp(i), b = lam.o(i); for (let k = 0; k < T; k++) lp[b + k] = 0; lp[b + 1] = LIQUID_MAX; ltot.s(i, LIQUID_MAX); grid.s(i, 10); hp.s(i, 0); fineSet(room).add(i); fineChanged.add(i); terrChanged.add(i); }   // quicksand id back in the grid
          sat.s(i, 0); changedSet.add(i); ss.delete(i);
        }
      } else if (sat.g(i) === 0 && !adjFn(i, isWater)) ss.delete(i);
    } else if (v === 5) {                                // MUD: lava bakes it dry instantly; water keeps it wet; else it dries → earth
      if (adjFn(i, isLava)) { grid.s(i, 1); hp.s(i, matStrengthSrv(mats, 1)); sat.s(i, 0); changedSet.add(i); terrChanged.add(i); addFx(i, 4); ss.delete(i); }   // baked dry: smoke
      else if (adjFn(i, isWater)) sat.s(i, SAT_MAX);
      else { sat.s(i, sat.g(i) > SAT_DRY ? sat.g(i) - SAT_DRY : 0); if (sat.g(i) === 0) { grid.s(i, 1); hp.s(i, matStrengthSrv(mats, 1)); changedSet.add(i); terrChanged.add(i); addFx(i, 6); ss.delete(i); } }   // dried out: dust puff
    } else { sat.s(i, 0); ss.delete(i); }                 // cell dug/overwritten out from under us
  }
  // terrain conversions ride terrain-set; drained/created liquid rides the fine wire
  if (fx.length && !liquidQuiet) wireFanout(room, 'liquid-fx', { cells: fx });
  if (terrChanged.size && !liquidQuiet) { const tc = []; for (const j of terrChanged) tc.push(j, grid.g(j)); wireFanout(room, 'terrain-set', { cells: tc }); }
  if (fineChanged.size && !liquidQuiet) emitFineCells(room, Array.from(fineChanged));
  if (liquidCfg.reactions) { const rs = fineReactSet(room); for (const j of terrChanged) rs.add(j); for (const j of fineChanged) rs.add(j); }
  if (!ss.size) dropSoilSet(room);
}
// ── FINE-CELL LIQUID TICK ── the coarse multi-liquid CORE FLOW (density sorts 2/2b · straight-down 1a · ledge spill 1b ·
// lateral levelling 1c/1d · per-liquid levelling 2c · fallSide tag), reproduced at SUB× resolution in the roomFine* arrays.
// Solids are read from the coarse terrain via coarseOf() (map-on-read, no terrain mirror; NEVER writes terrain). DROPLETS,
// REACTIONS, SINKS, the secondary lane and flux levelling are OMITTED (inc 1 = pipeline; reactions come next). Honours the
// same liquidCfg flags so behaviour matches. PROVEN faithful by the harness SUB=1 identity test (fineLiquidTickRoom(room,1)
// == liquidTickRoom with droplets+reactions off, on reaction-free scenes).
function fineLiquidTickRoom(room, SUB) {
  const st = cellsOf(room);
  SUB = SUB || st.fineSub || 1;
  const grid = st.terrain, amt = st.fineAmt, tot = st.fineTotal, active = st.fineActive;
  if (!grid || !amt || !tot || !active || !active.size) { if (active && !active.size) dropFineActive(room); return; }
  const lvlAcc = st.fineLevelAcc;
  const tick = liquidTickCount, cap = LIQUID_MAX, T = LIQ_T;
  const COLS = st.cols * SUB, FROWS = st.rows * SUB, NCELL = COLS * FROWS;   // Phase 6: this room's shape (FROWS = the STRIDE — increment 5)
  const LIQUID_FLOOR_ROW = Math.floor(roomFloorTop(room) / TERRAIN_CELL) * SUB;   // liquid may not descend into/below the bedrock row (scaled to fine rows)
  const SCAN = LIQUID_LEVEL_SCAN * SUB;                                  // levelling scan reach in CELLS → scaled so PHYSICAL reach is unchanged
  const TROWS = st.rows;
  // 🟥🟥 AT SUB = 1 THIS IS THE IDENTITY FUNCTION, AND IT WAS 13.7% OF THE WHOLE LIQUID TICK — the single most
  // expensive LINE in it, measured with V8's per-line ticks against the live Overworld under real load.
  // FROWS = st.rows * SUB and TROWS = st.rows, so at SUB = 1 the body reduces to `fc * FROWS + fr`, which is `k`:
  // two divisions, a multiply and a subtract per call, to compute k from k. `isSolid` and `isSinkF` are the most
  // called functions in the server and every one of their calls went through it.
  // ⚠️ SUB = 1 is the only ratio that ships (reactions are off at any other, `fineReactTickRoom` returns early),
  // but the general form is kept and is byte-for-byte what it always was — this is a fast path, not a change.
  const coarseOf = SUB === 1 ? (k) => k
    : (k) => { const fc = (k / FROWS) | 0, fr = k - fc * FROWS; return ((fc / SUB) | 0) * TROWS + ((fr / SUB) | 0); };
  // 🟥🟥 THE SIM MUST NEVER BUILD WORLD. `.g()` PRODUCES the page it lands on, so `isSolid` — the single most
  // called function in the tick — generated a chunk (~0.9ms, synchronously) every time liquid looked at a cell
  // just outside the produced world. MEASURED: 2,239 of 3,395 chunks, 66% of ALL world generation, came from
  // inside `runLiquidTick`, ~2.0s of tick time over a 40s run, and worldgen was 33.4% of all server CPU — more
  // than the entire liquid sim. That is what a 940ms tick is.
  // ⚠️ THIS EXACT CASCADE HAS ALREADY TAKEN THE SERVER DOWN ONCE. See the note on the powder seeder: "a grain at
  // a chunk's bottom edge produced the chunk beneath it, whose seeding produced the one beneath that, to
  // bedrock — 64 chunks deep, 8,191 wide, and the server stopped answering." The SEEDERS were fixed to peek. The
  // SIM was not, and it is the hotter path by far.
  // ⭐ UNBUILT ⇒ SOLID, which is the fail-safe direction: liquid stops at the edge of the produced world instead
  // of pouring through it. That edge is always outside everyone's view (production follows visibility plus a
  // margin), and when a player goes there `sendChunkContent` produces it properly and the liquid resumes.
  // ⚠️ SKY IS THE EXCEPTION AND IT IS NOT OPTIONAL: an absent page the generator can prove is sky must read as
  // AIR, or falling liquid stops dead in mid-air over unproduced ground — the exact symptom this track began
  // with. `skyAt` answers that for free.
  // ⚠️ A room with NO generator is untouched, byte for byte: absent there really does mean empty, and `.g()` is
  // the right read. That is what keeps `probe_fine_identity` bit-identical and every page room unchanged.
  const genRoom = !!grid.seedFn;
  const isSolid = genRoom
    ? (k) => { if (k < 0 || k >= NCELL) return true; const ci = coarseOf(k); const v = peekCellAt(grid, ci);
               if (v >= 0) return v !== 0 && !isFluidId(v);
               return !grid.skyAt(ci); }                                                    // unbuilt ⇒ solid; sky ⇒ air
    : (k) => { if (k < 0 || k >= NCELL) return true; const v = grid.g(coarseOf(k)); return v !== 0 && !isFluidId(v); };
  const isSinkF = (k) => { if (k < 0 || k >= NCELL) return false; const v = genRoom ? peekCellAt(grid, coarseOf(k)) : grid.g(coarseOf(k)); return v >= 0 && isSinkId(v); };   // a fine cell whose coarse cell is a DRAIN block
  // ⭐⭐ A ROW SCAN IS A CONTIGUOUS TYPED-ARRAY WALK, AND THE PAGE LAYOUT HAS ALWAYS ALLOWED IT.
  // The two levelling scans (1d below and 2c) look up to LIQUID_LEVEL_SCAN = 28 cells along the row in EACH
  // direction, per cell, per sub-step. MEASURED on the live server: **17 of a possible 28 steps per run**, about
  // 273,000 steps a TICK between them — ~18% of the liquid tick on the per-line profile, and mostly finding
  // nothing, because a flat pool only stops the walk when it runs out of reach.
  // ⭐ `o(i)` puts the ROW in the high six bits of the page offset and the COLUMN in the low six, so consecutive
  // columns of one row are ADJACENT IN THE PAGE and the page only changes at a 64-column boundary. A 28-cell
  // scan is therefore at most two straight runs per direction instead of 28 trips through the page directory.
  // ⚠️ SUB = 1 ONLY. The walk indexes the coarse terrain with the fine index, which is what `coarseOf` reduces
  // to at 1:1 and nothing like it at any other ratio. Every other ratio keeps the original loop, which is also
  // what keeps `probe_fine_identity`'s SUB=3 scenes byte-for-byte.
  // ⚠️ An ABSENT terrain page falls back to the ordinary `isSolid` for that step, which is where the
  // unbuilt-⇒-solid and sky-⇒-air rules live. Rare (it means unproduced world beside moving liquid) and it must
  // stay rare rather than being reimplemented here — one copy of that rule, not two.
  // `liquidCfg.scanFast` = 0 restores the original per-cell loop, for an A/B. SUB != 1 always takes it.
  const ROWFAST = SUB === 1 && !!liquidCfg.scanFast;
  // The nearest column, within `reach` and in direction `sdir`, holding at least 2 less liquid than `L`.
  // Returns its DISTANCE (1..reach), or 0 for none — stopping at the world edge, at solid ground, or at anything
  // higher than `L`, exactly as the loop it replaces did.
  const scanLevel = (i, c, L, sdir, reach) => {
    let d = 1;
    while (d <= reach) {
      const cc = c + sdir * d;
      if (cc < 0 || cc >= COLS) return 0;
      const j = i + sdir * d * FROWS, lane = cc & 63;
      let n = sdir > 0 ? 64 - lane : lane + 1;                 // steps left inside this page
      const edge = sdir > 0 ? COLS - cc : cc + 1;
      if (n > edge) n = edge;
      if (n > reach - d + 1) n = reach - d + 1;
      const pT = tot.rp(j), oT = tot.o(j);
      const gp = grid.pageAt(grid.pageOfCell(j)), oG = gp ? grid.o(j) : 0;
      // ⭐ THE PRESENT-PAGE RUN IS ITS OWN LOOP. `gp` is decided ONCE per page, not re-tested per step, and the
      // two offsets walk by `sdir` instead of being recomputed as `o + sdir * k` (two multiplies a step). The
      // absent-page case keeps the original per-cell form — it means unproduced world beside moving liquid, it
      // is rare, and it must stay rare rather than being written twice.
      // ⚠️ `liqLvlSteps` is a MODULE-level counter, so `++` in here is a context-slot round trip on every step
      // of the hottest loop in the server. It is summed at the exits instead — same total, arrived at once.
      const L2 = L - 2;
      if (gp) {
        for (let k = 0, kg = oG, kt = oT; k < n; k++, kg += sdir, kt += sdir) {
          if (SOLID_LUT[gp[kg]]) { liqLvlSteps += k + 1; return 0; }
          const jl = pT[kt];
          if (jl > L) { liqLvlSteps += k + 1; return 0; }
          if (jl <= L2) { liqLvlSteps += k + 1; return d + k; }
        }
        liqLvlSteps += n;
      } else {
        for (let k = 0; k < n; k++) {
          liqLvlSteps++;
          if (isSolid(j + sdir * k * FROWS)) return 0;
          const jl = pT[oT + sdir * k];
          if (jl > L) return 0;
          if (jl <= L2) return d + k;
        }
      }
      d += n;
    }
    return 0;
  };
  // The same walk for 2c, whose comparison is the CUMULATIVE amount of ranks 0..t rather than the total.
  // `amt` holds T values per cell, so one column step is T elements rather than one.
  const scanPerLiq = (i, c, Ci, t, sdir, reach) => {
    let d = 1;
    while (d <= reach) {
      const cc = c + sdir * d;
      if (cc < 0 || cc >= COLS) return 0;
      const j = i + sdir * d * FROWS, lane = cc & 63;
      let n = sdir > 0 ? 64 - lane : lane + 1;
      const edge = sdir > 0 ? COLS - cc : cc + 1;
      if (n > edge) n = edge;
      if (n > reach - d + 1) n = reach - d + 1;
      const pA = amt.rp(j), oA = amt.o(j);
      const gp = grid.pageAt(grid.pageOfCell(j)), oG = gp ? grid.o(j) : 0;
      const Ci2 = Ci - 2, stepA = sdir * T;         // one column is T rank slots, so the walk strides by T
      if (gp) {
        for (let k = 0, kg = oG, b = oA; k < n; k++, kg += sdir, b += stepA) {
          if (SOLID_LUT[gp[kg]]) { liqPlSteps += k + 1; return 0; }
          // ⭐ THE PREFIX SUM IS MONOTONE — amounts are never negative — so once it has passed `Ci` the answer
          // is already "stop", and the remaining ranks cannot bring it back down. Exactly the same verdict, up
          // to T-1 fewer reads at an interface. The full sum is still needed for the `<= Ci-2` test, which is
          // why the break is only taken on the over case.
          let Cj = 0, over = false;
          for (let q = 0; q <= t; q++) { Cj += pA[b + q]; if (Cj > Ci) { over = true; break; } }
          if (over) { liqPlSteps += k + 1; return 0; }
          if (Cj <= Ci2) { liqPlSteps += k + 1; return d + k; }
        }
        liqPlSteps += n;
      } else {
        for (let k = 0; k < n; k++) {
          liqPlSteps++;
          if (isSolid(j + sdir * k * FROWS)) return 0;
          const b = oA + sdir * k * T;
          let Cj = 0; for (let q = 0; q <= t; q++) Cj += pA[b + q];
          if (Cj > Ci) return 0;
          if (Cj <= Ci2) return d + k;
        }
      }
      d += n;
    }
    return 0;
  };
  const sinkRate = Math.max(0, Math.min(cap, liquidCfg.sinkRate | 0)), sinkLed = sinkLedger(room);
  // ⭐⭐ DRAIN BLOCKS ARE A TEST TOOL, SO STOP LOOKING FOR THEM IN WORLDS THAT HAVE NONE.
  // The block below asks all FOUR orthogonal neighbours "are you a drain?" for every liquid cell on every
  // sub-step — four coarse-terrain reads per cell — and it measured ~3% of the liquid tick in a world that has
  // never contained one. The user, asked: *"the drains only exist to help with testing, they won't actually
  // exist in the full-game."*
  // ⇒ off by default, and ARMED AUTOMATICALLY the moment anybody paints a drain (see LIQ_SINK_ID in the
  // terrain-edit handler), so the tool still works by being used. The checkbox is the manual override for the
  // one case the auto-arm cannot see: a drain restored from a database written before this existed.
  const sinkOn = liquidCfg.sinks && sinkRate > 0;
  const changedSet = new Set(), airborneWire = new Set();   // accumulate across the physics sub-steps below; broadcast once
  // QUIESCENCE scratch (only when enabled): per-fine-cell counter of consecutive ticks the cell did NOT move. Reallocated if NCELL changed (sub switch).
  const quiesce = liquidCfg.fineQuiesce ? ((st.fineStill && st.fineStill.length === NCELL) ? st.fineStill : (st.fineStill = newPagedField('fineStill', chunkGeom(COLS, FROWS), room))) : null;
  let stepMoves = 0;   // cell-changes in the current sub-step (adaptive-K activity proxy)
  // ⚠️ ONE HASH OPERATION, NOT TWO. `if (!active.has(j)) liqQWoken++; active.add(j);` probed the set twice — the
  // first probe existed ONLY to keep a stats counter. `wake` runs four to eight times per cell that moves, so
  // that was a whole extra Set lookup per neighbour per move; the size delta says the same thing for free.
  const wake = (j) => { if (j >= 0 && j < NCELL && !isSolid(j) && tot.g(j) > 0) { const _sz = active.size; active.add(j); if (active.size !== _sz) liqQWoken++; } };
  const wakeN = (j) => { const y = j % FROWS; wake(j - FROWS); wake(j + FROWS); if (y > 0) wake(j - 1); if (y < FROWS - 1) wake(j + 1); };
  const wakeD = (j) => { wakeN(j); const y = j % FROWS; if (y > 0) { wake(j - FROWS - 1); wake(j + FROWS - 1); } if (y < FROWS - 1) { wake(j - FROWS + 1); wake(j + FROWS + 1); } };
  const mark = (j) => { changedSet.add(j); active.add(j); stepMoves++; liqQMoved++; };
  // ⚠️ PAGED ACCESS: the page + offset base are hoisted ONCE per cell and the rank loop then indexes the page flat,
  // so a rank loop costs what it always did plus one table lookup. `rp` reads through an unallocated page as zeros;
  // `wp` faults one in. When A and B share a page these are the same typed array, which is exactly as before.
  const recomp = (j) => { const p = amt.rp(j), b = amt.o(j); let s = 0; for (let k = 0; k < T; k++) s += p[b + k]; tot.s(j, s); };
  const moveBottom = (A, B, t) => { let need = t; const pa = amt.wp(A), ba = amt.o(A), pb = amt.wp(B), bb = amt.o(B); for (let rk = 0; rk < T && need > 0; rk++) { const a = pa[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; pa[ba + rk] = a - mv; pb[bb + rk] += mv; need -= mv; } const moved = t - need; if (moved) { tot.s(A, tot.g(A) - moved); tot.s(B, tot.g(B) + moved); mark(A); mark(B); } return moved; };
  const moveTop = (A, B, t) => { let need = t; const pa = amt.wp(A), ba = amt.o(A), pb = amt.wp(B), bb = amt.o(B); for (let rk = T - 1; rk >= 0 && need > 0; rk--) { const a = pa[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; pa[ba + rk] = a - mv; pb[bb + rk] += mv; need -= mv; } const moved = t - need; if (moved) { tot.s(A, tot.g(A) - moved); tot.s(B, tot.g(B) + moved); mark(A); mark(B); } return moved; };
  const moveProp = (A, B, t) => { const pa = amt.wp(A), ba = amt.o(A), pb = amt.wp(B), bb = amt.o(B), TA = tot.g(A); if (TA <= 0 || t <= 0) return 0; let need = t, moved = 0;
    for (let rk = 0; rk < T && need > 0; rk++) { const a = pa[ba + rk]; if (a <= 0) continue; let mv = Math.round(t * a / TA); if (mv > a) mv = a; if (mv > need) mv = need; if (mv <= 0) continue; pa[ba + rk] -= mv; pb[bb + rk] += mv; need -= mv; moved += mv; }
    for (let rk = 0; rk < T && need > 0; rk++) { const a = pa[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; pa[ba + rk] -= mv; pb[bb + rk] += mv; need -= mv; moved += mv; }
    if (moved) { tot.s(A, tot.g(A) - moved); tot.s(B, tot.g(B) + moved); mark(A); mark(B); } return moved; };
  const floorRank = (j) => { const p = amt.rp(j), b = amt.o(j); for (let rk = 0; rk < T; rk++) if (p[b + rk] > 0) return rk; return -1; };
  const ceilRank = (j) => { const p = amt.rp(j), b = amt.o(j); for (let rk = T - 1; rk >= 0; rk--) if (p[b + rk] > 0) return rk; return -1; };
  // ── LAVA IS NEVER MIXED WITH ANOTHER LIQUID ──────────────────────────────────────────────────────────────────────
  // Lava reacts on contact with every other liquid (fineReactTickRoom), so the two must never end up sharing a cell in
  // the first place. Without this, a falling lava parcel merges into a pool cell and the K levelling/sort sub-steps
  // smear it across several cells BEFORE the next reaction pass sees it — which is what produced a whole column of
  // stone from a small amount of lava, and stone appearing away from the interface. Blocked in BOTH directions on
  // every transfer path (1a fall · 1b spill · 1c/1d level · 2/2b sort · 2c per-liquid · flux). Guarded at the call
  // sites rather than inside moveBottom/moveTop, because those callers decrement L by the amount they ASKED to move.
  // Tied to liquidCfg.reactions: with reactions off there is nothing to react, so lava is an ordinary liquid again
  // (which is also what keeps the coarse-vs-fine identity probe honest).
  const lavaBlk = (A, B) => {
    if (!liquidCfg.reactions) return false;
    const lavaA = amt.rp(A)[amt.o(A)], lavaB = amt.rp(B)[amt.o(B)];
    const la = lavaA > 0, lb = lavaB > 0;
    if (!la && !lb) return false;
    return (la && tot.g(B) - lavaB > 0) || (lb && tot.g(A) - lavaA > 0);
  };
  // The same rule with the A side already read — `wouldSort` asks it three times for one cell. Hoisted rather
  // than closed over per cell: a closure declared inside the cell loop is an allocation per cell per sub-step,
  // which is the cost this increment is removing elsewhere.
  const lavaBlkFrom = (laA, restA, B) => {
    if (!liquidCfg.reactions) return false;
    const lavaB = amt.rp(B)[amt.o(B)], lb = lavaB > 0;
    if (!laA && !lb) return false;
    return (laA && tot.g(B) - lavaB > 0) || (lb && restA > 0);
  };
  // ⭐⭐ WOULD THE DENSITY SORT FIRE FOR THIS CELL RIGHT NOW? Mirrors (2) and (2b) below exactly, minus the per-sub-step
  // budget — used to keep a still-inverted cell in the ACTIVE SET when that budget has turned the sort off. Keep the
  // three in step: if a gate is added to (2)/(2b), add it here too, or a pair it blocks will spin in `active` forever.
  // ⚠️ `solidBelow` is passed in, not recomputed: the caller already has it, and its guard here (`canDown`) is
  // literally the same test, so `j0` is in range whenever this line is reached.
  const wouldSort = (i, r, c, solidBelow) => {
    if (!liquidCfg.densitySort) return false;
    if (r + 1 >= LIQUID_FLOOR_ROW) return false;                                      // canDown
    // ⭐ THE `i` SIDE IS READ ONCE. `floorRank(i)` pages in this cell's rank slots, and then `lavaBlk(i, ·)`
    // re-read the same page, the same offset and the same total for EACH of the three cells below — on every
    // active cell, on eight of the nine sub-steps, because `fineSortSteps` defaults to 1. Nothing between those
    // reads writes anything, so every one of them was guaranteed to return what the first did.
    // ⚠️ Reading `tot.g(i)` and `amt.rp(i)` unconditionally here is safe ONLY because both have already
    // happened — the caller took `L = tot.g(i)`, and `floorRank` took the page. On a generated room a read is
    // what PRODUCES a chunk, so "this cannot fault anything new" is the property being preserved, not speed.
    const pI = amt.rp(i), bI = amt.o(i);
    let hi = -1; for (let rk = 0; rk < T; rk++) if (pI[bI + rk] > 0) { hi = rk; break; }
    if (hi < 0) return false;
    const lavaA = pI[bI], laA = lavaA > 0, restA = tot.g(i) - lavaA;
    // 🟥 THIS WAS AN ARRAY LITERAL AND IT WAS 8.6% OF THE LIQUID TICK. `fineSortSteps` defaults to 1, so
    // `!doSort` is true on eight of the nine sub-steps and this runs on EVERY active cell on all of them —
    // allocating a three-element array and an iterator each time, purely to loop over three known values.
    // Unrolled below; identical order, identical result, no allocation. (Measured with V8's per-line ticks.)
    const j0 = i + 1, j1 = c > 0 ? i + 1 - FROWS : -1, j2 = c < COLS - 1 ? i + 1 + FROWS : -1;
    if (j0 >= 0 && j0 < NCELL && tot.g(j0) > 0 && !solidBelow && !lavaBlkFrom(laA, restA, j0) && hi < ceilRank(j0)) return true;
    if (j1 >= 0 && j1 < NCELL && tot.g(j1) > 0 && !isSolid(j1) && !lavaBlkFrom(laA, restA, j1) && hi < ceilRank(j1)) return true;
    if (j2 >= 0 && j2 < NCELL && tot.g(j2) > 0 && !isSolid(j2) && !lavaBlkFrom(laA, restA, j2) && hi < ceilRank(j2)) return true;
    return false;
  };
  // PHYSICS SUB-STEPS (fineLevelSteps): run the WHOLE fine tick K times per tick, so ALL movement (fall/spill/level/sort)
  // propagates K× faster — recovers the speed fine cells lose to being smaller. Levelling is O(width²), so a fine pool
  // (3× wider) is ~SUB²≈9× slower than coarse ⇒ K≈9 matches coarse. Local, no teleport; the broadcast accumulates across
  // sub-steps (wire ≈ unchanged — only the net change per real tick is sent). fell/fellDown/list are per sub-step.
  const FSTEPS = Math.max(1, Math.min(16, liquidCfg.fineLevelSteps | 0));
  // fineConstFall: run the DOWN-fall (1a/1b) a FIXED number of times/tick, independent of the levelling sub-steps, so a
  // higher K speeds levelling/sort WITHOUT speeding descent. OFF ⇒ FALLSTEPS = FSTEPS ⇒ doFall = doLevel every step ⇒
  // byte-identical to the original single-loop behaviour.
  const FALLSTEPS = liquidCfg.fineConstFall ? Math.max(1, Math.min(16, liquidCfg.fineFallSteps | 0)) : FSTEPS;
  // ⭐⭐ A FALL-ONLY TURN. When a strip runs out of the tick's budget it currently gets NO tick at all, so
  // anything DESCENDING in it stops dead in mid-air until its turn comes round — the user's report, and
  // measured at 11–30% of strip-turns under a heavy pour. Falling is the cheap part of the tick and the
  // visually glaring one: water stopped in mid-air is obviously broken, water that levels slowly is not.
  // ⇒ this mode runs the DESCENT and nothing else, so a starved strip still looks alive.
  // 🟥 EVERY PROCESSED CELL GOES BACK IN THE ACTIVE SET. This is the trap the file already documents three
  // times — a budget switches a branch off and the cell has nothing left to keep it alive, so `active` drains
  // and the room is dropped with the work undone, FOR EVER. Here the levelling has not happened, it has been
  // postponed, so nothing may be allowed to fall out of the set.
  const FALLONLY = !!liquidCfg._fallOnly;
  const NSTEPS = FALLONLY ? 1 : Math.max(FSTEPS, FALLSTEPS), ADAPT_PCT = Math.max(1, Math.min(50, liquidCfg.fineAdaptPct | 0));
  const MINU = Math.max(1, Math.min(cap, liquidCfg.fineMinUnit | 0));   // quantise the down-fall so falling slices are chunkier (1 = off)
  const SORTSTEPS = liquidCfg.fineSortSteps > 0 ? Math.min(FSTEPS, liquidCfg.fineSortSteps | 0) : FSTEPS;
  // (2b) DIAGONAL sort budget — capped SEPARATELY from the vertical sort, so sideways travel while separating can be
  // bounded without slowing stratification itself. 0 = follow SORTSTEPS (uncapped, the original behaviour).
  const DIAGSTEPS = liquidCfg.fineSortDiagSteps > 0 ? Math.min(SORTSTEPS, liquidCfg.fineSortDiagSteps | 0) : SORTSTEPS;
  // (2c) PER-LIQUID LEVELLING budget + reach — the measured cause of sideways spread (see liquidCfg). Both 0 = today.
  // The reach is scaled by SUB like SCAN is, so the dial means the same PHYSICAL distance at any resolution.
  const PLSTEPS = liquidCfg.finePerLiquidSteps > 0 ? Math.min(FSTEPS, liquidCfg.finePerLiquidSteps | 0) : FSTEPS;
  const PLSCAN = liquidCfg.finePerLiquidScan > 0 ? Math.min(SCAN, (liquidCfg.finePerLiquidScan | 0) * SUB) : SCAN;
  // (1d) SURFACE FLAT-SETTLE BUDGET — how many of the K sub-steps 1d may run in. 0 = every sub-step (the old
  // behaviour, kept for A/B). Front speed is ~1 cell per invocation, so this dial IS the spread speed in cells/tick.
  // ⚠️ Deliberately NOT derived from cellCap. It looked like it should be (1d moves a fixed 1 unit, and a unit is
  // 1/24 of a cell at cap 24 vs 1/64 at 64), but measurement says otherwise: front speed comes out at 9 cells/tick
  // at EVERY capacity (t10 width 70/66/63/61 for cap 64/24/12/8), because the front advances one cell per invocation
  // regardless of how much rides along. What capacity actually changes is the SETTLE time (83/51/39/25) — the
  // vertical levelling, not the horizontal reach. Deriving the budget from capacity made front speed scale WITH
  // capacity and broke the very invariant it was meant to protect.
  const FLATSTEPS = liquidCfg.fineFlatSteps > 0 ? Math.min(FSTEPS, liquidCfg.fineFlatSteps | 0) : FSTEPS;
  // (1d) reach, scaled by SUB exactly as SCAN and PLSCAN are, so the dial means the same PHYSICAL distance at
  // any resolution. 0 = SCAN, i.e. byte-for-byte what shipped before this dial existed.
  const FLATSCAN = liquidCfg.fineFlatScan > 0 ? Math.min(SCAN, (liquidCfg.fineFlatScan | 0) * SUB) : SCAN;
  // ⭐⭐ THESE TWO WERE DECLARED INSIDE THE PER-CELL LOOP, so a fresh closure object was allocated for every
  // active cell on every sub-step — order 180,000 allocations a tick, and the profile put the `roomAt`
  // declaration line alone at 4.2% of the tick body (a line that does no work at all: it is the allocation).
  // Both capture only tick-invariant state (`isSolid`, `tot`, `amt`, `cap`), so hoisting is a pure move.
  // ⚠️ `reduce` CANNOT come with them — it captures the cell's own `lf` and writes the cell's `pend`.
  const roomAt = (j) => !isSolid(j) && tot.g(j) < cap;
  const cumAt = (jj, tt) => { const pp = amt.rp(jj), bb = amt.o(jj); let s = 0; for (let k = 0; k <= tt; k++) s += pp[bb + k]; return s; };
  for (let step = 0; step < NSTEPS; step++) {
    if (!active.size) break;
    const doFall = FALLONLY || step < FALLSTEPS;    // this sub-step runs the vertical descent (1a straight-down, 1b ledge spill)
    const doLevel = !FALLONLY && step < FSTEPS;      // this sub-step runs lateral levelling (1c/1d/2c)
    const doSort = !FALLONLY && step < SORTSTEPS;    // this sub-step runs the DENSITY SORT (2/2b) — capped separately so sorting can be slowed independently of levelling
    const doSortDiag = !FALLONLY && step < DIAGSTEPS; // ...and the DIAGONAL half (2b) is capped tighter still, to bound sideways travel
    const doPerLiq = !FALLONLY && step < PLSTEPS;    // (2c) per-liquid levelling — capped separately: this IS its sideways spread speed in cells/tick
    stepMoves = 0;
    // ⭐⭐ ONE PACKED NUMBER PER CELL, SORTED AS A TYPED ARRAY. This was `Array.from(active)` followed by
    // `.sort()` with a JS comparator, and the two together measured **~5% of the whole liquid tick** — a sort
    // of every active cell, on every one of the nine sub-steps, with a comparator that took a PAGED READ
    // (`tot.g`) on every row-tie. `Array.prototype.sort` calls back into JS per comparison;
    // `Float64Array.prototype.sort` is numeric and never leaves the engine.
    // ⭐ The three keys fit one double exactly: row DESCENDING in the top bits, total ASCENDING next, and the
    // cell index last (flipped on alternate ticks, which is what the old comparator's `(tick & 1)` did — the
    // lateral symmetry-breaker). 4,095 · 2^39 + 255 · 2^31 + 2^31 is comfortably under 2^53, so every key is an
    // exact integer and equality/ordering are exact. The index makes every key unique, so there are no ties to
    // resolve differently from before: the permutation is identical, not merely equivalent.
    // ⚠️ The buffers are reused across sub-steps and ticks — allocating a 20,000-element array nine times a tick
    // was part of what this line cost.
    // ⚠️ THE PACKING HAS BOUNDS AND THEY ARE CHECKED, not assumed. They hold for every shape that ships (`cap`
    // is clamped to 255 on the wire, the tallest world is 4,096 rows, and the flat index is under 2^31 by the
    // cap increment 6 measured) — but a room that broke one would silently sort into the wrong order, which is
    // the worst kind of failure. Out of bounds falls back to the original comparator, written into the same
    // buffer so the loop below has ONE shape either way.
    const _n0 = active.size;
    if (_sortBuf.length < _n0) _sortBuf = new Float64Array(1 << (32 - Math.clz32(_n0 | 1)));
    const list = _sortBuf;
    let _flip = !(tick & 1);
    if (FROWS <= SORT_ROW_MAX && cap < SORT_TOT_MAX && NCELL <= SORT_IDX_MAX) {
      let n = 0;
      for (const i of active) { const r = i % FROWS; list[n++] = (FROWS - 1 - r) * SORT_ROW_MUL + tot.g(i) * SORT_TOT_MUL + (_flip ? SORT_IDX_MAX - i : i); }
      active.clear();
      list.subarray(0, _n0).sort();
    } else {
      const arr = Array.from(active); active.clear();
      arr.sort((a, b) => { const ra = a % FROWS, rb = b % FROWS; if (ra !== rb) return rb - ra; const la = tot.g(a), lb = tot.g(b); if (la !== lb) return la - lb; return (tick & 1) ? a - b : b - a; });
      for (let k = 0; k < _n0; k++) list[k] = arr[k];
      _flip = false;                                   // already in final order; the low bits are the index itself
    }
    const fell = new Set(), fellDown = new Set();
    // ⭐⭐ ONE CELL PER PASS (fineSortOnePerPass). `list` is sorted BOTTOM-UP, which is right for falling — a column
    // cascades in a single pass — but for the density sort it means each successively HIGHER cell pulls the same light
    // liquid up one more cell within the SAME pass, so a sliver rides the entire height of a pool in one sub-step.
    // Measured: with the sort capped to 1 pass/tick, 38 of 216 units of oil still jumped 17 rows to the surface on tick
    // one and were immediately filmed across 34 columns (they now read as "settled", so 2c levels them at full reach),
    // while the bulk rose at the expected 1 row/tick. That is the thin-slivers-spread-wide symptom.
    // A cell that has just RECEIVED lighter liquid is recorded here, and the cell above it may not swap with it again
    // this pass — so a parcel advances exactly one cell per sort pass, which is what "density-sort passes/tick" is
    // supposed to mean. Cleared every sub-step.
    const sortedTo = new Set();
    // Whether a column still holds a vertical density inversion — computed once per column per sub-step, since every
    // cell in it asks the same question (see sortingHere below).
    const colSorting = new Map();
    // 🟥 THIS WAS 46.5% OF ALL SERVER CPU IN THE OVERWORLD — measured, `server/prof` via GET /debug/cpu-profile.
    // It used to walk `for (r2 = 0; r2 + 1 < FROWS; r2++)`: the WORLD'S FULL DEPTH, once per column, once per
    // sub-step. In a page room FROWS is 405 and that is merely wasteful; in the Overworld it is 4,096, ×9
    // sub-steps ×every column holding active liquid. Cost therefore scaled with the WORLD'S HEIGHT and not with
    // the amount of water, which is why the profile was flat at ~26ms whether 130 or 380 cells were active, and
    // why the same lake that settles fine in a page room crawls here.
    // ⚠️ AND IT WAS DOING IT WITH FAULTING READS, against the rule written at the top of the paging section,
    // which names this function: *"whole-grid SCANS are reads, and must stay reads, or a single scan would fault
    // the entire world back in"*. `tot.g()` → `rp()` → `_miss()` → `_alloc()`, and on a generated world `_alloc`
    // PRODUCES that chunk. So every column with a drop of moving water was generating the world all the way down
    // beneath itself, nine times a tick — the exact opposite of what increment 4b is for.
    // ⭐ THE FIX IS A BOUND, NOT A CACHE. An inversion needs two adjacent cells that BOTH hold liquid, so only
    // pages of `fineTotal` that exist can contain one; a vacant page is all zeros and `tot.g(a2) <= 0` would
    // `continue` on every row of it anyway. Skipping it is exact rather than approximate. An EVICTED page is not
    // vacant and is still visited (see pageVacant) — skipping that one would be Phase 3's unloaded-reads-as-empty
    // bug again. Typical column: 1–2 live pages = 64–128 rows instead of 4,096.
    // ⚠️ "PAGES THAT EXIST" WAS THE WRONG BOUND, and the user caught it from the description alone: *"surely you
    // wouldn't look at cells that have ever held liquid, but which are currently holding liquid?"* Exactly right.
    // A page is allocated the first time liquid touches it and stays allocated after the water has drained away,
    // so the bound decayed as the world was played — MEASURED at 46× (probe_scale_invariants B1) once water had
    // run down a column and gone.
    // ⭐ SO: remember, per (column, page), that the segment held NO liquid — keyed on the page's REVISION, which
    // `wp()` bumps on every write. A drained segment nobody writes to again is one Map lookup forever; the moment
    // anything writes into that page the revision moves and it is rescanned. Exact, not heuristic: the cache can
    // only ever be consulted for a page whose contents have not changed since it was read.
    const CY = tot.geom.cy, emptySeg = fineEmptySegs(room);
    // ⭐⭐ BOUNDED TO THE LIQUID BODY, NOT THE COLUMN (liquidCfg.sortColRun, default ON).
    // The question this answers is "may the cell at (cc, rr) take part in a sideways exchange, or is the liquid
    // around it still stratifying". The old answer was taken over the column's ENTIRE DEPTH — 4,096 rows in the
    // Overworld — so a puddle in a cave 3,000 rows below could veto a levelling exchange at the surface, and a
    // single drop of falling water paid to scan every live 64-row segment beneath itself, nine times a tick.
    // That is the "one person's actions must never cost a player somewhere else" rule broken on the vertical
    // axis, and it was 17% of the whole server (`GET /debug/cpu-profile`, 2026-08-22).
    // ⭐ The physically meaningful region is the CONTIGUOUS run of liquid the cell belongs to: an inversion is two
    // ADJACENT liquid cells, so nothing outside the run the cell sits in can ever pair with it. Walking that run
    // is cheap where the old scan was dear — a falling parcel's run is 1-3 cells — and never worse: the run is a
    // subset of the liquid rows the old scan visited, and the segment loop disappears with it.
    // ⚠️ Not identical, deliberately: a cell whose own row holds NO liquid now answers "not sorting" (there is no
    // body there to be stratifying) where the old test would still say "yes" if anything anywhere in the column
    // was inverted. That relaxation is the point.
    // ⚠️ A run of AIR is cached too, and with its full extent, so the void above a pool is one walk not many.
    const COLRUN = !!liquidCfg.sortColRun;
    // column -> { t, b, v }: the run [t..b] that was last examined in this column this sub-step, and its answer.
    // Any row inside [t..b] reuses it; a row outside walks its own run. One entry per column is enough because a
    // column's active cells are nearly always in one body.
    const colRun = new Map();
    // "part of a liquid body": holds liquid AND is not solid — exactly the pair test's own precondition, so the
    // run is precisely the set of rows that could ever take part in an inversion here.
    const wetAt = (k) => tot.g(k) > 0 && !isSolid(k);
    // ⚠️ THE VOID WALK IS BOUNDED AND THE BODY WALK IS NOT, ON PURPOSE. A body is genuinely as tall as it is and
    // the old code paid for those rows too. A VOID is not: the partner column at a pool's edge is open air, and
    // walking it to the top of a 4,096-row world would be worse than what this replaces. 32 rows either way is
    // enough to make the cache earn its keep and costs a fixed, tiny amount.
    const VOIDRUN = 32;
    const colStillSorting = COLRUN ? (cc, rr) => {
      const e = colRun.get(cc);
      if (e !== undefined && rr >= e.t && rr <= e.b) return e.v;
      if (rr < 0 || rr >= FROWS) return false;
      const colBase = cc * FROWS;
      let t = rr, b = rr, v = false;
      if (!wetAt(colBase + rr)) {                     // a void run: no body here, so nothing is stratifying
        const lo = rr > VOIDRUN ? rr - VOIDRUN : 0, hi = Math.min(FROWS - 1, rr + VOIDRUN);
        while (t > lo && !wetAt(colBase + t - 1)) t--;
        while (b < hi && !wetAt(colBase + b + 1)) b++;
      } else {
        while (t > 0 && wetAt(colBase + t - 1)) t--;
        while (b + 1 < FROWS && wetAt(colBase + b + 1)) b++;
        // ⭐ ONE PAGED LOOKUP PER ROW, NOT TWO. The walk asked `floorRank(a2)` and then `ceilRank(a2 + 1)` — and
        // the very next row asks `floorRank` of the cell whose `ceilRank` was just taken, so every cell in the
        // run had its page resolved twice. Both ranks come out of ONE pass over the same six slots, and the
        // floor is carried down to the next row.
        // ⚠️ The `curF < 0` branch exists to keep the SET OF PAGES READ identical: the original only reached
        // `ceilRank(a2 + 1)` when the floor below was real, so a run with an empty cell in it must not prefetch.
        // On a generated room a read is what produces a chunk, so that is a correctness property, not a detail.
        let curF = floorRank(colBase + t);
        for (let r2 = t; r2 < b; r2++) {
          const nxt = colBase + r2 + 1;
          if (curF < 0) { curF = floorRank(nxt); continue; }
          const p2 = amt.rp(nxt), b2 = amt.o(nxt);
          let nf = -1, nc = -1;
          for (let rk = 0; rk < T; rk++) if (p2[b2 + rk] > 0) { if (nf < 0) nf = rk; nc = rk; }
          if (curF < nc) { v = true; break; }
          curF = nf;
        }
      }
      liqScanRows += b - t + 1;
      if (e !== undefined) { e.t = t; e.b = b; e.v = v; } else colRun.set(cc, { t, b, v });
      return v;
    } : (cc) => {
      let v = colSorting.get(cc);
      if (v !== undefined) return v;
      v = false;
      const colBase = cc * FROWS;
      outer:
      for (let cr = 0; cr < CY; cr++) {
        const r0 = cr << 6;
        if (r0 >= FROWS) break;
        const seg = colBase + r0, pg = tot.pageOfCell(seg);
        if (tot.pageVacant(pg)) continue;                    // nothing was ever stored here
        const rev = tot.revAt(pg);
        if (emptySeg.get(seg) === rev) continue;              // known empty, and unchanged since we looked
        const rN = Math.min(r0 + 64, FROWS);
        liqScanRows += rN - r0;
        let anyLiquid = false;
        for (let r2 = r0; r2 < rN; r2++) {
          const a2 = colBase + r2;
          if (tot.g(a2) > 0) anyLiquid = true;
          if (r2 + 1 >= FROWS) { if (!anyLiquid) emptySeg.set(seg, rev); break outer; }
          const b2 = a2 + 1;
          if (tot.g(a2) <= 0 || tot.g(b2) <= 0 || isSolid(a2) || isSolid(b2)) continue;
          const f = floorRank(a2); if (f >= 0 && f < ceilRank(b2)) { v = true; break outer; }
        }
        if (!anyLiquid) emptySeg.set(seg, rev);
      }
      colSorting.set(cc, v); return v;
    };
    // ⭐ START WHERE THE LAST CAPPED TICK STOPPED. Without this the deterministic sort above means the same
    // 9,000 cells win every tick and everything past the cap is starved for ever (see roomFlowCursor). The
    // slice is still walked in sorted order, so a falling column still cascades within it; the cursor only
    // moves which WINDOW of the queue gets served, which is the difference between a delay and a skip.
    // ⚠️ Only engages when the set is actually over the cap, so any room that fits — every page world — keeps
    // start = 0 and is byte-for-byte unchanged, which is what keeps the golden replay identical.
    let processed = 0;
    const _n = _n0;                                    // the buffer is reused and longer than the run — never `list.length`
    let _start = 0;
    if (_n > LIQUID_MAX_PER_TICK) { _start = (roomFlowCursor[room] | 0) % _n; roomFlowCursor[room] = (_start + LIQUID_MAX_PER_TICK) % _n; }
    else roomFlowCursor[room] = 0;
  for (let _k = 0; _k < _n; _k++) {
    const _key = list[_start + _k < _n ? _start + _k : _start + _k - _n];
    const _low = _key % SORT_TOT_MUL, i = _flip ? SORT_IDX_MAX - _low : _low;
    if (processed >= LIQUID_MAX_PER_TICK) { active.add(i); liqQCapped++; continue; }
    if (isSolid(i)) continue;
    const c = (i / FROWS) | 0, r = i - c * FROWS, canDown = r + 1 < LIQUID_FLOOR_ROW;
    let L = tot.g(i); if (L <= 0) continue;
    processed++; liqQProcessed++;
    // ⭐⭐ ONE TERRAIN READ FOR THE CELL BELOW, NOT SIX. `isSolid(i + 1)` was recomputed by (2), (1a), wouldSort,
    // roomAt (up to three times, via canFall/airborne/isStream) and belowRoom — six paged reads of a byte that
    // CANNOT change while this cell is being processed, because nothing in the liquid tick writes terrain
    // (reactions are a separate pass). What genuinely does change is `tot`, so only the solidity half is hoisted.
    // ⚠️ Every one of those call sites is already guarded by `canDown`, so the `true` here is never consulted —
    // it is the same fail-safe direction `isSolid` itself takes out of range, stated rather than relied upon.
    const solidBelow = canDown ? isSolid(i + 1) : true;
    // ---- SINK (drain block id 17): a fine cell touching a coarse drain block loses liquid, heaviest first (ledgered).
    if (sinkOn && ((r < FROWS - 1 && isSinkF(i + 1)) || (r > 0 && isSinkF(i - 1)) || (c > 0 && isSinkF(i - FROWS)) || (c < COLS - 1 && isSinkF(i + FROWS)))) {
      let need = sinkRate < L ? sinkRate : L; const sp = amt.wp(i), sb = amt.o(i);
      for (let rk = 0; rk < T && need > 0; rk++) { const a = sp[sb + rk]; if (a <= 0) continue; const mv = a < need ? a : need; sp[sb + rk] = a - mv; sinkLed[rk] += mv; need -= mv; }
      recomp(i); mark(i); wakeN(i); L = tot.g(i); if (L <= 0) continue;
    }
    // (fine pipeline: no secondary lane, reactions or droplets — inc 1)
    // SORT BEFORE LEVEL (liquidCfg.sortBeforeLevel): a cell that ACTUALLY swapped this sub-step does not also spread
    // sideways. Without it a dropped mixed blob sorts and races outward at the same time, which reads as unrealistic
    // and fires sink/rise bubble FX across the whole width at once. Set only when a swap really happened — a sort that
    // is merely BLOCKED (stream tag, lavaBlk) must not freeze levelling, or that cell would never settle at all.
    let sortedHere = false;
    // (2) density sort with the cell BELOW
    if (doSort && liquidCfg.densitySort && canDown && tot.g(i + 1) > 0 && !solidBelow && !lavaBlk(i, i + 1)
        && !(liquidCfg.fineSortOnePerPass && sortedTo.has(i + 1))) {
      const j = i + 1, hi = floorRank(i), lo = ceilRank(j);
      if (hi >= 0 && lo >= 0 && hi < lo) { const pi = amt.wp(i), bi = amt.o(i), pj = amt.wp(j), bj = amt.o(j); const k = Math.min(pi[bi + hi], pj[bj + lo], liquidCfg.sortRate); pi[bi + hi] -= k; pj[bj + hi] += k; pj[bj + lo] -= k; pi[bi + lo] += k; mark(i); mark(j); wakeD(i); wakeD(j); if (k > 0) { sortedHere = true; sortedTo.add(i); } }
    }
    // (2b) diagonal density sort — see fineSortDiagGate/fineSortDiagSteps. `sortedHere` is set by (2) directly above,
    // so gating on it means "the straight-up swap already handled this cell, don't ALSO shove it sideways".
    if (doSort && doSortDiag && liquidCfg.densitySort && canDown && !(liquidCfg.fineSortDiagGate && sortedHere))
      // ⚠️ PARITY IS PER COLUMN, NOT PER INDEX (increment 5). This alternates which side is tried first so
      // lateral flow does not bias one way; it used to read the flat index, which under row-major addressing
      // WAS the column parity (an even column count). Column-major, the same expression would alternate by
      // ROW — every cell in a row trying the same side — which is a real behaviour change and is what the
      // old-vs-new comparison in probe_addressing caught. Stated explicitly now.
      for (const dc of (((tick + c) & 1) ? [-1, 1] : [1, -1])) {
      const cc = c + dc; if (cc < 0 || cc >= COLS) continue;
      const j = i + 1 + dc * FROWS; if (isSolid(j) || tot.g(j) === 0) continue;
      if (lavaBlk(i, j)) continue;
      if (liquidCfg.fineSortOnePerPass && sortedTo.has(j)) continue;
      const hi = floorRank(i), lo = ceilRank(j);
      if (hi >= 0 && lo >= 0 && hi < lo) { const pi = amt.wp(i), bi = amt.o(i), pj = amt.wp(j), bj = amt.o(j); const k = Math.min(pi[bi + hi], pj[bj + lo], liquidCfg.sortRate); pi[bi + hi] -= k; pj[bj + hi] += k; pj[bj + lo] -= k; pi[bi + lo] += k; mark(i); mark(j); wakeD(i); wakeD(j); if (k > 0) { sortedHere = true; sortedTo.add(i); } break; }
    }
    // ⭐⭐ A CELL THAT IS STILL DENSITY-INVERTED MUST NEVER LEAVE THE ACTIVE SET.
    // `fineSortSteps` caps the sort to the first SORTSTEPS sub-steps. On every sub-step past that, an inverted pair can
    // neither sort (doSort off) nor level — levelling is gated off precisely BECAUSE its column is still sorting
    // (`sortingHere`/`colStillSorting`) — so nothing mark()s it, `active` drains to empty and the room is dropped with
    // the inversion standing FOREVER. It renders, it shows in Inspect, and the client's rise/sink bubble FX keep firing
    // at it because they key off exactly this inversion: the "stuck slice that bubbles for ever".
    // ⚠️ This is the SAME structural trap as the fineConstFall/fineFallSteps one above (a lone falling parcel freezing
    // one cell below where it was placed): a per-sub-step budget switches a branch off and the cell has nothing else
    // left to keep it alive. Whenever a new budget dial is added, ask what keeps its cells active when it is spent.
    // MEASURED: 21 stuck pairs across 500 randomised scenes at fineSortSteps 1–2, and none at the default 0 — which is
    // why this hid through 1320 earlier runs. Self-limiting: wouldSort goes false the moment the pair resolves.
    if (!FALLONLY && !doSort && wouldSort(i, r, c, solidBelow)) active.add(i);   // a fall-only turn re-adds everything anyway
    // (1a) straight down. Gated on doFall so the fall rate can be held constant regardless of the levelling sub-step
    // count (fineConstFall).
    if (doFall && canDown) { const j = i + 1; const room2 = cap - tot.g(j); if (!solidBelow && room2 > 0 && !lavaBlk(i, j)) { let t = Math.min(L, room2); if (MINU > 1) t -= t % MINU; if (t > 0) { moveBottom(i, j, t); L -= t; wakeN(i); } } }
    // density throttle (viscosity off by default → lf=1 → reduce is a pass-through)
    const cr = ceilRank(i), lf = (liquidCfg.viscosity && cr >= 0) ? 1 / (1 + LEVEL_VISC[cr]) : 1;
    let pend = false;
    // `lvlAcc` is a SEEDED paged array (per-index phase, not zero), so its page is faulted on read as well as write —
    // an untouched cell must still read its phase, exactly as the flat array's pre-seeded value did.
    const reduce = (want) => { if (want <= 0) return 0; if (lf >= 1) return want; const lp = lvlAcc.wp(i), lo = lvlAcc.o(i); lp[lo] += want * lf; let mv = lp[lo] | 0; if (mv > want) mv = want; lp[lo] -= mv; if (mv <= 0) pend = true; return mv; };
    // (1b) THE DIAGONAL LEDGE SPILL WAS HERE, and went with the fall tag on 2026-07-29 (slice 4). It was the tag's
    // ONE birth site, and it shipped disabled (`fineLedge: false`), so what runs instead is what has been running:
    // lateral levelling (1c) moves liquid into the edge cell and 1a drops it straight down the next tick — the same
    // end state one tick later, with no diagonal geometry rule (a diagonal-only gap between two solids is a sealed
    // corner anyway).
    // STILL SORTING? Evaluated with the same test the sort itself uses, AFTER it has run this sub-step. Gating on
    // "a swap happened" alone was far too weak (measured: no effect at all) — the swap resolves in sub-step 0 and the
    // cell then levels through the remaining K-1 sub-steps while its neighbours are still separating. A cell that is
    // still density-inverted with the cell below or either diagonal has NOT finished, so it must not spread yet.
    // STILL SORTING? Gated per COLUMN, not per pair. A per-pair test measured as a no-op: at K=9 sub-steps each
    // adjacent pair re-sorts within a tick, so it fired on 36 cells at t0 and 7 by t4 while levelling ran on 300+.
    // What actually takes 10+ ticks is the BODY rearranging (heavy migrating to the bottom), during which any given
    // pair is momentarily in order. So: while this column holds ANY vertical inversion it is still separating, and
    // none of its cells may spread sideways yet.
    const sortingHere = liquidCfg.sortBeforeLevel && (sortedHere || (liquidCfg.densitySort && colStillSorting(c, r)));
    // ⭐ `roomAt(i + 1)` ONCE. It was asked three times here (canFall, airborne, isStream below) and its terrain
    // half a fourth time by `belowRoom` — and nothing between these lines moves any liquid, so all four readings
    // were guaranteed equal. `tot` is still read here rather than hoisted further up, because it DOES change:
    // (1a) has just run and may have emptied the cell below.
    const rBelow = canDown && !solidBelow && tot.g(i + 1) < cap;
    const canFall = canDown && (rBelow || fell.has(i + 1) || (c > 0 && roomAt(i + 1 - FROWS)) || (c < COLS - 1 && roomAt(i + 1 + FROWS)));
    if (canFall) fell.add(i);
    const airborne = canDown && (rBelow || fellDown.has(i + 1));
    // A cell that still has room to fall must NEVER leave the active set. With fineConstFall on, the descent runs in
    // sub-step 0 only; sub-steps 1..K-1 then process an airborne cell that can neither fall (doFall off) nor level
    // (gated off for a stream), so nothing mark()s it, `active` drains to empty and the room is dropped — a lone parcel
    // freezes in mid-air exactly one cell below where it was placed. A continuous stream hid this because the cell above
    // re-wakes it every tick. Self-limiting: once it lands, roomAt(below) is false ⇒ not airborne ⇒ it settles normally.
    // ...but only while a fall is genuinely still possible. fineMinUnit quantises the descent, so a sub-unit remainder
    // can never move; keeping THAT active spins forever (it never settles, which the mitigations probe caught).
    const belowRoom = (canDown && !solidBelow) ? cap - tot.g(i + 1) : 0;
    const keepFalling = belowRoom > 0 && L > 0 && (MINU <= 1 || (L < belowRoom ? L : belowRoom) >= MINU);
    if (airborne) { fellDown.add(i); airborneWire.add(i); if (keepFalling) active.add(i); }
    // LEVELLING GATE (see liquidCfg.levelGate): 0 = canFall (counts diagonal room too) · 1 = own straight-down room ·
    // 2 = AIRBORNE, i.e. straight-down room propagated up the column. Every mode used to carry an `sd[i] !== 0 ||`
    // term as well, and there was a fourth "tagged-only" mode; both went with the fall tag.
    const isStream = liquidCfg.levelGate === 0 ? canFall
                   : liquidCfg.levelGate === 1 ? rBelow
                   : airborne;
    const shedCap = L;
    if (doLevel && !isStream && !sortingHere) {
      // ⭐ …and the same for the two SIDEWAYS neighbours, which (2c) and (1c) each ask about independently — read
      // once here rather than up with `solidBelow`, because a cell that never reaches this block (a stream, a
      // column still stratifying) must not pay for reads it will not use.
      // ⚠️ Out of range stays `true`: that is what `isSolid(-1)` already answered, and both callers rely on it.
      const jLh = c > 0 ? i - FROWS : -1, jRh = c < COLS - 1 ? i + FROWS : -1;
      const solidL = jLh >= 0 ? isSolid(jLh) : true, solidR = jRh >= 0 ? isSolid(jRh) : true;
      // (2c) per-liquid horizontal levelling (pools only). MEASURED to be what spreads a parcel sideways: it runs on
      // every sub-step and looks SCAN cells along the row, so a 3-column blob films across a whole pool in one tick.
      // PLSTEPS caps how many sub-steps it may run in (= its spread speed) and PLSCAN how far it looks; both default
      // to the original values, so this is unchanged until the dials are turned down.
      // ⚠️ `amt.o(i)` is pure arithmetic on the index, so it is hoisted; `amt.rp(i)` is NOT, because `amt.wp(i)`
      // inside the loop can fault a page in and leave a cached read page stale. One of the two is safe to lift.
      const bI2 = amt.o(i);
      // ⭐⭐ IS THERE A DIFFERENT LIQUID NEXT DOOR AT ALL? IF NOT, THIS WHOLE BRANCH IS DEAD.
      // The user's observation, and it is stronger than "wasteful" — in a body holding ONE liquid this branch
      // does not merely fail to find anything, it CANNOT act. The exchange takes rank `t` out of the neighbour
      // and pulls something LIGHTER back; with nothing lighter next door `avail` is 0 and it bails — after
      // scanning up to 56 columns and summing ranks at every one of them. Every cell. Every sub-step.
      // ⇒ `ceilRank(neighbour) > floorRank(here)` — "does either side hold anything lighter than my heaviest?"
      // — is a NECESSARY condition for every `t`, because the cheapest `t` this loop can use is my own floor
      // rank and `avail` only shrinks as `t` rises. Three short rank scans instead of the whole branch.
      // ⭐ THE CHUNK-LEVEL VERSION IS NOT NEEDED. The question "is another liquid nearby?" is answered exactly,
      // with no bookkeeping and nothing to go stale, by the two cells either side — a chunk flag would be both
      // coarser and something to keep in sync.
      // ⚠️ Shares the `plSkip` switch with the per-`t` test below, and inherits its one wrinkle: skipping means
      // not calling `colStillSorting`, whose answer is memoised per column and never refreshed within a
      // sub-step, so skipping changes WHEN that memo is filled. Bit-identical at SUB=1 over 500 ticks; SUB=3
      // settles 2 ticks later. That is why the switch exists.
      let plOn = liquidCfg.perLiquidLevel && doPerLiq;
      if (plOn && liquidCfg.plSkip) {
        const hiI = floorRank(i);
        const cL = (jLh >= 0 && !solidL) ? ceilRank(jLh) : -1, cR = (jRh >= 0 && !solidR) ? ceilRank(jRh) : -1;
        if (!(cL > hiI || cR > hiI)) plOn = false;
      }
      if (plOn) for (let t = 0; t < T - 1; t++) {
        if (amt.rp(i)[bI2 + t] <= 0) continue;
        const Ci = cumAt(i, t);
        // ⭐ THE SAME NECESSARY CONDITION AS (1d). This exchange also only ever moves into an IMMEDIATE
        // neighbour, and only when that neighbour's cumulative depth of THIS liquid is lower (`Cj >= Ci` bails
        // below). Two cumulative sums against up to 56 scanned columns.
        // ⚠️ Weaker here than for (1d): 45% of 2c's scans genuinely find a target, so this fires less often and
        // costs 2×(t+1) reads when it does not. Measured separately from `flatSkip` for exactly that reason.
        if (liquidCfg.plSkip) {
          const okL = jLh >= 0 && !solidL && cumAt(jLh, t) < Ci;
          const okR = jRh >= 0 && !solidR && cumAt(jRh, t) < Ci;
          if (!okL && !okR) continue;
        }
        let dir = 0, best = Infinity;
        for (let _si = 0; _si < 2; _si++) {
          const sdir = _si ? 1 : -1; liqPlRuns++;
          let hit = 0;
          if (ROWFAST) hit = scanPerLiq(i, c, Ci, t, sdir, PLSCAN);
          if (!ROWFAST || liquidCfg.scanVerify) {
            let slow = 0;
            for (let d = 1; d <= PLSCAN; d++) { if (!ROWFAST) liqPlSteps++; const cc = c + sdir * d; if (cc < 0 || cc >= COLS) break; const j2 = i + sdir * d * FROWS; if (isSolid(j2)) break; const Cj = cumAt(j2, t); if (Cj > Ci) break; if (Cj <= Ci - 2) { slow = d; break; } }
            if (!ROWFAST) hit = slow; else if (slow !== hit) liqScanMismatch++;
          }
          if (hit && hit < best) { best = hit; dir = sdir; }
        }
        if (dir === 0) continue;
        const j = i + dir * FROWS; if ((dir < 0 ? solidL : solidR) || lavaBlk(i, j)) continue;
        // ⭐⭐ SYMMETRIC SORT GATE. `sortingHere` stops a cell that is still stratifying from levelling — but it only
        // gates the cell being PROCESSED. 2c is an EXCHANGE, so a settled neighbour was free to reach in and pull the
        // parcel apart from the other side: measured, a 3-column blob of oil buried in a still pool was filmed across
        // 58 columns in a single tick, because the surrounding pure-water columns were not themselves sorting and so
        // were never gated. Gating the PARTNER's column too makes the rule mean what it says — nothing levels into or
        // out of a region that is still separating — which is what lets the reach stay long: a parcel keeps its shape
        // while it sorts, then the interface flattens at full reach the moment it has settled.
        // ⚠️ Deliberately NOT gated on `sortBeforeLevel`. This is a per-EXCHANGE rule and the blanket one is a
        // per-CELL rule; tying them together made it impossible to use this INSTEAD of the blanket rule, which is
        // exactly the combination worth having (the blanket rule freezes a still-sorting column out of levelling
        // entirely, which leaves unnatural terraced mounds standing until it finishes).
        if (liquidCfg.finePerLiquidSortGate && liquidCfg.densitySort && colStillSorting(c + dir, r)) continue;
        const Cj = cumAt(j, t);
        if (Cj >= Ci) continue;
        const pi = amt.wp(i), bi = amt.o(i), pj = amt.wp(j), bj = amt.o(j);
        let avail = 0; for (let k = t + 1; k < T; k++) avail += pj[bj + k];
        if (avail <= 0) continue;
        let n = (Ci - Cj) >> 1;
        if (n > pi[bi + t]) n = pi[bi + t];
        if (n > avail) n = avail;
        if (n < 1) n = 1;
        n = reduce(n);
        if (n <= 0) continue;
        pi[bi + t] -= n; pj[bj + t] += n;
        let need = n; for (let q = t + 1; q < T && need > 0; q++) { const a = pj[bj + q]; if (a <= 0) continue; const mv = a < need ? a : need; pj[bj + q] -= mv; pi[bi + q] += mv; need -= mv; }
        mark(i); mark(j); wakeD(i); wakeD(j);
      }
      const lvlMove = liquidCfg.levelMix ? moveProp : moveTop;
      // (1c) lateral equalise (symmetric)
      if (liquidCfg.lateralLevel && !liquidCfg.fluxLevel && L > 1) {
        if (liquidCfg.symLevel) {
          const jL = jLh, jR = jRh;
          const okL = jL >= 0 && !solidL && L - tot.g(jL) > 1 && !lavaBlk(i, jL);
          const okR = jR >= 0 && !solidR && L - tot.g(jR) > 1 && !lavaBlk(i, jR);
          let sum = L, cnt = 1; if (okL) { sum += tot.g(jL); cnt++; } if (okR) { sum += tot.g(jR); cnt++; }
          if (cnt > 1) {
            const avg = sum / cnt;
            let shedL = okL ? Math.min(avg - tot.g(jL), cap - tot.g(jL)) : 0;
            let shedR = okR ? Math.min(avg - tot.g(jR), cap - tot.g(jR)) : 0;
            if (shedL < 0) shedL = 0; if (shedR < 0) shedR = 0;
            const denom = shedL + shedR; let total = reduce(Math.floor(denom));
            if (total > shedCap) total = shedCap;
            if (total > 0 && denom > 0) {
              let mvL = Math.round(total * shedL / denom); if (mvL > total) mvL = total; const mvR = total - mvL;
              if (mvL > 0) { lvlMove(i, jL, mvL); L -= mvL; wakeN(i); }
              if (mvR > 0) { lvlMove(i, jR, mvR); L -= mvR; wakeN(i); }
            }
          }
        } else for (const dc of (((tick + c) & 1) ? [-1, 1] : [1, -1])) { const cc = c + dc; if (cc < 0 || cc >= COLS) continue; const j = i + dc * FROWS; if ((dc < 0 ? solidL : solidR) || lavaBlk(i, j)) continue; const nl = tot.g(j), room2 = cap - nl; if (L - nl > 1 && room2 > 0) { const mv = Math.min(reduce(Math.min((L - nl) >> 1, room2)), shedCap); if (mv > 0) { lvlMove(i, j, mv); L -= mv; wakeN(i); } } }
      }
      // (1d) surface flat-settle — capped to FLATSTEPS of the K sub-steps (see the budget above). Uncapped it runs
      // every sub-step, and because an EMPTY neighbour always counts as "lower", the leading edge of a puddle sheds
      // onward every time: the front advanced ~9 cells/tick and raced away from the body that was still separating.
      // ⭐⭐ THE SCAN CANNOT PRODUCE A MOVE UNLESS AN IMMEDIATE NEIGHBOUR CAN TAKE THE UNIT — so ask that FIRST.
      // Look at the move at the foot of this block: whatever the scan finds, up to 28 cells away, the unit only
      // ever goes into `i ± FROWS`, and only if THAT cell is both lower than this one and not already full. The
      // distance is used ONLY to choose which side. So "is either immediate neighbour lower than me and not
      // full?" is a NECESSARY condition for the entire block — and when it fails, today's code walks up to 56
      // cells and then declines to move anyway. Same outcome, two reads instead of fifty-six.
      // ⭐ WHY IT IS WORTH IT (probe_scan_shape): 99.5% of this branch's decisions move nothing, and 92.5% of
      // its scans walk the FULL reach and find nothing — 96.4% of all its steps. The reason is now obvious: a
      // saturated pool's interior cells all sit at `cap`, so no neighbour can ever receive, and every one of
      // them re-proved that on eight of the nine sub-steps.
      // ⚠️ EXACT, not an approximation — but it does skip the READS the scan would have made, and on a
      // generated room a read can fault an evicted page back in. Nothing about the water changes; what the
      // server keeps resident might. That is why it is a toggle.
      // ⚠️ A SOLID neighbour holds tot 0, which would read as "can receive"; the hoisted `solidL`/`solidR` say
      // so for free. Getting that wrong would only ever cost a scan the old code also ran, never a wrong move.
      let flatOn = liquidCfg.lateralLevel && !liquidCfg.fluxLevel && L > 0 && step < FLATSTEPS;
      if (flatOn && liquidCfg.flatSkip) {
        const vL = (jLh >= 0 && !solidL) ? tot.g(jLh) : cap, vR = (jRh >= 0 && !solidR) ? tot.g(jRh) : cap;
        if (!((vL < L && vL < cap) || (vR < L && vR < cap))) flatOn = false;
      }
      if (flatOn) {
        let dir = 0, best = Infinity;
        for (let _si = 0; _si < 2; _si++) {
          const sdir = _si ? 1 : -1; liqLvlRuns++;
          let hit = 0;
          if (ROWFAST) hit = scanLevel(i, c, L, sdir, FLATSCAN);
          if (!ROWFAST || liquidCfg.scanVerify) {
            let slow = 0;
            // ⚠️ The verify loop takes FLATSCAN too, or `scanVerify` would report a disagreement on every
            // shortened scan and stop being able to see a real one.
            for (let d = 1; d <= FLATSCAN; d++) { if (!ROWFAST) liqLvlSteps++; const cc = c + sdir * d; if (cc < 0 || cc >= COLS) break; const j = i + sdir * d * FROWS; if (isSolid(j)) break; const jl = tot.g(j); if (jl > L) break; if (jl <= L - 2) { slow = d; break; } }
            if (!ROWFAST) hit = slow; else if (slow !== hit) liqScanMismatch++;
          }
          if (hit && hit < best) { best = hit; dir = sdir; }
        }
        if (dir !== 0 && shedCap >= 1) { const j = i + dir * FROWS; if (tot.g(j) < L && tot.g(j) < cap && !lavaBlk(i, j) && reduce(1) > 0) { lvlMove(i, j, 1); L -= 1; wakeN(i); } }
      }
    }
    if (pend) active.add(i);
    if (changedSet.has(i)) wakeN(i);
    // 🟥 THE POSTPONED WORK MUST NOT BE LOST. See FALLONLY above: this cell's levelling did not happen, so it
    // has to come back next tick or it freezes exactly where it is, permanently.
    if (FALLONLY) active.add(i);
  }
  // ═══ FLUX LEVELLING (liquidCfg.fluxLevel) at fine res — "global target, LOCAL transport" (ported from the coarse sim).
  // Off by default (1c/1d handle levelling); on = per-body equilibrium waterline + prefix-sum interface fluxes moved at a
  // bounded rate BETWEEN ADJACENT cells only. Faster on wide pools; shelved for its sliding-slab look + it levels streams
  // it absorbs. Behind the same toggle so it can be A/B'd on the fine grid. No secondary lane here (fine has none).
  if (liquidCfg.fluxLevel) {
    const ROWS = FROWS, NCELL2 = COLS * ROWS, RATE = liquidCfg.fluxRate | 0;
    const lvlMove = liquidCfg.levelMix ? moveProp : moveTop;
    const seen = ensureFineFluxSeen(room, NCELL2); seen.fill(0);
    const stack = ensureFineFluxStack(room, NCELL2);
    const cFloor = new Int32Array(COLS), cTop = new Int32Array(COLS), cH = new Float64Array(COLS);
    for (let start = 0; start < NCELL2; start++) {
      if (seen.g(start) || isSolid(start) || tot.g(start) <= 0) continue;
      let sp = 0; stack[sp++] = start; seen.s(start, 1);
      let minC = COLS, maxC = -1;
      while (sp > 0) {
        const j = stack[--sp], jc = (j / ROWS) | 0;
        if (jc < minC) minC = jc; if (jc > maxC) maxC = jc;
        const jr = j - jc * ROWS;
        if (jc > 0) { const k = j - ROWS; if (!seen.g(k) && !isSolid(k) && tot.g(k) > 0) { seen.s(k, 1); stack[sp++] = k; } }
        if (jc < COLS - 1) { const k = j + ROWS; if (!seen.g(k) && !isSolid(k) && tot.g(k) > 0) { seen.s(k, 1); stack[sp++] = k; } }
        if (jr > 0) { const k = j - 1; if (!seen.g(k) && !isSolid(k) && tot.g(k) > 0) { seen.s(k, 1); stack[sp++] = k; } }
        if (jr < ROWS - 1) { const k = j + 1; if (!seen.g(k) && !isSolid(k) && tot.g(k) > 0) { seen.s(k, 1); stack[sp++] = k; } }
      }
      if (maxC <= minC) continue;
      const cols = [], part = new Uint8Array(COLS);
      for (let c = minC; c <= maxC; c++) {
        let r = -1;
        const cb = c * ROWS;
        for (let rr = ROWS - 1; rr >= 0; rr--) { const j = cb + rr; if (seen.g(j) && tot.g(j) > 0) { r = rr; break; } }
        if (r < 0) continue;
        while (r + 1 < ROWS && r + 1 < LIQUID_FLOOR_ROW && !isSolid(cb + r + 1)) r++;
        const fl = r + 1;
        let t = fl; while (t - 1 >= 0 && !isSolid(cb + t - 1) && tot.g(cb + t - 1) >= cap) t--;
        if (t - 1 >= 0 && !isSolid(cb + t - 1)) { const v = tot.g(cb + t - 1); if (v > 0 && v < cap) t--; }   // (used to also require an untagged cell; the fall tag is gone and was always 0 here)
        if (t >= fl) continue;
        let h = 0; for (let rr = t; rr < fl; rr++) h += tot.g(cb + rr);
        let cl = t; while (cl - 1 >= 0 && !isSolid(cb + cl - 1) && tot.g(cb + cl - 1) <= 0) cl--;
        cFloor[c] = fl; cTop[c] = cl; cH[c] = h; part[c] = 1; cols.push(c);
      }
      if (cols.length < 2) continue;
      const barrier = (c) => part[c] && cTop[c] > 0 && isSolid(c * ROWS + cTop[c] - 1) && cH[c] >= (cFloor[c] - cTop[c]) * cap - 1;
      const levelSegment = (a, b) => {
        let n = 0, M = 0;
        for (let c = a; c <= b; c++) if (part[c]) { n++; M += cH[c]; }
        if (n < 2) return;
        const volAt = (L) => { let v = 0; for (let c = a; c <= b; c++) if (part[c]) { const mx = (cFloor[c] - cTop[c]) * cap; let hh = (cFloor[c] - L) * cap; if (hh < 0) hh = 0; if (hh > mx) hh = mx; v += hh; } return v; };
        let loL = -1, hiL = ROWS + 1;
        for (let it = 0; it < 32; it++) { const mid = (loL + hiL) / 2; if (volAt(mid) > M) loL = mid; else hiL = mid; }
        const L = (loL + hiL) / 2;
        let run = 0;
        for (let c = a; c < b; c++) {
          if (part[c]) { const mx = (cFloor[c] - cTop[c]) * cap; let tgt = (cFloor[c] - L) * cap; if (tgt < 0) tgt = 0; if (tgt > mx) tgt = mx; run += cH[c] - tgt; }
          if (!part[c] || !part[c + 1]) continue;
          let want = run > RATE ? RATE : run < -RATE ? -RATE : run;
          if (want > -1 && want < 1) continue;
          const src = want > 0 ? c : c + 1, dst = want > 0 ? c + 1 : c;
          let need = Math.floor(Math.abs(want));
          let sr = cTop[src], dr = cFloor[dst] - 1;
          while (need > 0) {
            while (sr < cFloor[src] && (isSolid(src * ROWS + sr) || tot.g(src * ROWS + sr) <= 0)) sr++;
            if (sr >= cFloor[src]) break;
            while (dr >= cTop[dst] && (isSolid(dst * ROWS + dr) || cap - tot.g(dst * ROWS + dr) <= 0)) dr--;
            if (dr < cTop[dst] || dr < sr) break;
            const A = src * ROWS + sr, B = dst * ROWS + dr; if (A === B || lavaBlk(A, B)) break;
            const mv = Math.min(tot.g(A), cap - tot.g(B), need); if (mv <= 0) break;
            const did = lvlMove(A, B, mv); if (did <= 0) break;
            need -= did; wakeN(A); wakeN(B);
          }
        }
      };
      let segA = minC;
      for (let c = minC; c <= maxC; c++) if (barrier(c)) { if (c - 1 >= segA) levelSegment(segA, c - 1); segA = c + 1; }
      if (maxC >= segA) levelSegment(segA, maxC);
    }
  }
    // ADAPTIVE K: stop sub-stepping when this sub-step moved fewer than ADAPT_PCT% of its active cells (the room has gone
    // quiet). A dead-quiet sub-step already empties `active` and breaks above; this trims the long tail where only a
    // handful of cells are still nudging, which is where high K wastes CPU. When fineConstFall is on we first let all
    // FALLSTEPS descent passes run so falling liquid is never starved; otherwise a single sub-step is enough to gate on.
    const adaptMin = liquidCfg.fineConstFall ? FALLSTEPS : 1;
    if (liquidCfg.fineAdaptiveK && step + 1 >= adaptMin && stepMoves < Math.max(2, (list.length * ADAPT_PCT / 100) | 0)) break;
  }   // ← close the physics sub-step loop
  // Keep the grid's representative fluid id in step with every cell that moved (see fineSyncGrid).
  for (const j of changedSet) fineSyncGrid(room, j);
  if (changedSet.size && !liquidQuiet) {
    if (liquidCfg.perfLog) liqPerf.fineChanged += changedSet.size;
    // WIRE (liquid-fine-cells): sub + cols so the client can decode fine indices, then per changed cell
    // [index, repId, flags(0x40 = AIRBORNE), mask] followed by one amt per set rank bit.
    // The flags byte used to carry the fallSide tag in its low 2 bits as well; that went on 2026-07-29, and the
    // AIRBORNE bit is a different thing entirely — it comes from `airborneWire`, which the sim fills from its own
    // levelling gate, and the client's fine ribbon render + the Inspect airborne overlay both read it.
    let arr = [], cells = 0;
    const emitFine = () => { if (liquidCfg.perfLog && arr.length) liqPerf.fineBytes += JSON.stringify(arr).length + 24; wireFanout(room, 'liquid-fine-cells', { sub: SUB, cols: COLS, cells: arr }); };
    for (const j of changedSet) {
      const p = amt.rp(j), b = amt.o(j); let mask = 0; for (let rk = 0; rk < T; rk++) if (p[b + rk] > 0) mask |= (1 << rk);
      arr.push(j, liqRepId(amt, j), airborneWire.has(j) ? 0x40 : 0, mask);
      for (let rk = 0; rk < T; rk++) if (mask & (1 << rk)) arr.push(p[b + rk]);
      if (++cells >= 8192) { emitFine(); arr = []; cells = 0; }
    }
    if (cells) emitFine();
  }
  // ⭐ REACTION CANDIDATES COME FROM `changedSet`, NOT FROM `active`. These are different things and conflating them is
  // why reactions only fired while liquid was still MOVING: the sub-step loop clears `active` every sub-step and only
  // re-adds cells that moved AGAIN, and the prune below drops more — so a cell that moved early in the tick and then
  // settled is in changedSet but NOT in active. `active` means "may still move"; `changedSet` means "this cell's
  // contents changed", which is exactly when a contact can have appeared. Bounded by what we just broadcast.
  if (liquidCfg.reactions && changedSet.size) { const rs = fineReactSet(room); for (const j of changedSet) rs.add(j); }
  // QUIESCENCE: freeze (remove from `active`) a cell that has NOT MOVED for fineQuiesceTicks ticks, so it stops being
  // processed + broadcast — trims the settling wake-front + halo of woken-but-idle cells. "Moved" = in changedSet, i.e.
  // it fell, levelled, spilled, drained OR density-SORTED this tick; because an inverting cell is marked by the sort
  // every tick, it can never be frozen mid-stratification → no rest inversions. A neighbour move re-adds it via wake().
  const QT = quiesce ? Math.max(2, Math.min(60, liquidCfg.fineQuiesceTicks | 0)) : 0;
  for (const j of Array.from(active)) {
    if (j < 0 || j >= NCELL) { active.delete(j); continue; }
    if (isSolid(j) || tot.g(j) <= 0) { active.delete(j); continue; }
    // ⚠️ Quiescence's whole safety argument is "an inverting cell is marked by the sort every tick, so it can never
    // freeze mid-stratification". `fineSortOnePerPass` breaks that premise: a pair whose swap was BLOCKED this pass
    // (the cell below already received liquid) never moves, so it is absent from changedSet and was frozen while still
    // inverted — 4 rest inversions, exactly the failure quiescence was designed to avoid. Ask the sort directly.
    if (quiesce) { if (changedSet.has(j) || wouldSort(j, j % FROWS, (j / FROWS) | 0)) quiesce.s(j, 0); else { const qp = quiesce.wp(j), qo = quiesce.o(j); if (++qp[qo] >= QT) active.delete(j); } }
  }
  if (!active.size) dropFineActive(room);
}
// ══ FINE REACTIONS (all-fine terrain) ═══════════════════════════════════════════════════════════════════════════════
// In all-fine mode the liquid grid and the TERRAIN grid are the same 8px cells (SUB=1 ⇒ a fine index IS a grid index), so
// a reaction is CELL-BY-CELL and IMMEDIATE ON CONTACT: lava and water make one 8px stone cell exactly where they meet and
// never spend a tick coexisting. That is the whole point of going all-fine — the coarse-window accumulator it replaces
// ("B-i") could only ever approximate it and is deliberately NOT reintroduced. Runs BEFORE fineLiquidTickRoom, which
// consumes the active set (see the call site). Writes terrain (grid+hp) directly and broadcasts over the existing
// `terrain-set` + `liquid-fine-cells` wires — both already handled client-side, so this is a server-only change.
// (`fineReact` on the cell store: Set<fine cell> explicitly seeded for a reaction test — see seedFineReactAround.)
function fineReactSet(room) { const s = cellsOf(room); if (!s.fineReact) { s.fineReact = new Set(); cellRooms.react.add(room); } return s.fineReact; }
// ⚠️ DECLARED HERE, INSIDE ==LIQUID_SIM_BLOCK==, and not next to `liqRateSkips` where they would read more
// naturally. `liqRateSkips` sits BELOW ==LIQUID_SIM_BLOCK_END== because only `runLiquidTick` uses it; these two
// are used by `fineReactTickRoom`, which is inside. Putting them outside would be a ReferenceError in every rig
// that slices the sim and nowhere else — the SEVENTH time this exact boundary has caught something on this track.
// ⭐⭐ SCALE COUNTERS — the whole Overworld rests on "cost follows the WORK, not the WORLD", and until now nothing
// checked it. Two bugs of exactly that class shipped in one day: `colStillSorting` scanned the world's full DEPTH
// (cost ∝ world height) and `evictChunk`'s prune walked the whole work set (cost ∝ |fineActive|). Both were
// invisible to every guard, because every guard uses a page-sized world with a small disturbance — the one shape
// where "∝ world" and "∝ work" are the same number.
// ⚠️ COUNTS, NOT CLOCKS. Wall-clock thresholds on this track have twice been coin flips (probe_budget's cold
// start, probe_react_budget D2). A count is deterministic, so `probe_scale_invariants` can assert the same
// disturbance costs the same in a page-sized world and an Overworld-sized one, inside one process.
let liqScanRows = 0;          // rows visited by colStillSorting — must not grow with world height OR with use
// (column, page) segments known to hold NO liquid, keyed on the page revision they were read at. Lives on the
// cell store so it survives ticks — which is the whole point, a drained column stays drained — and is released
// with the room's other scratch when the room goes quiet.
function fineEmptySegs(room) { const s = cellsOf(room); return s.fineEmptySeg || (s.fineEmptySeg = new Map()); }
// (`evictPruneOps`, the same idea for eviction, is declared next to `evictChunk` — it is in a DIFFERENT sliced
//  block, and a counter on the wrong side of a marker is a ReferenceError in the rigs and nowhere else.)
const roomReactCursor = {};   // room → where the capped reaction pass resumes, so no cell is permanently skipped
// 🟥🟥 THE SAME THING FOR THE FLOW, WHICH HAD NEVER HAD ONE — and its absence is why Overworld liquid "freezes".
// `fineLiquidTickRoom` sorts the whole active set DETERMINISTICALLY (bottom-up) and then processes the first
// `LIQUID_MAX_PER_TICK` (9,000) of it, re-queueing the rest. Same set, same sort, same first 9,000, every tick.
// So for the flow a capped tick was not a delay, it was a PERMANENT SKIP: with 157,000 cells queued, the 148,000
// past the cap were never reached again. The reaction pass ten screens down documents exactly this hazard and
// solves it with a cursor; the flow was left without one.
// ⭐ IT EXPLAINS THE REPORT PRECISELY. The sort is by ROW DESCENDING, so cells LOW in the world go first and
// liquid HIGH in it goes last: *"if I go all the way up into the sky and place liquid, it is frozen"* — that
// liquid sorts behind every cell of the lake below and is never reached. It also explains why moving away does
// not help (one Overworld room ⇒ one shared queue) and why page worlds were fine (they never exceed 9,000
// active cells, so the cap never binds).
const roomFlowCursor = {};
let liqReactSkips = 0;        // ticks on which the reaction pass hit reactMaxCand (⇒ it is biting; see the Perf tab)
// ⚠️ A COUNT, NOT A CLOCK. `probe_react_budget` D2 first asserted "the flow moved liquid on most ticks", which
// gave 18/30 and then 6/30 for identical code — the budget scheduler is `performance.now()`-driven, so any
// threshold on its outcome is a coin flip on machine load. This track has been here before (probe_budget's
// cold-start check, fixed the same way: assert the MECHANISM, not a timing outcome). Anchors built is
// deterministic, so filtered-vs-unfiltered can be compared inside one process with no timing in it at all.
let liqReactAnchors = 0;      // anchors the reaction pass has built, ever — the thing reactAnchorFilter reduces
// ⭐ WHERE THE REACTION PASS'S TIME ACTUALLY GOES — asked directly: *"is it a specific reaction or reactions which
// are making up most of the cost?"* These three answer it as a funnel rather than by naming a reaction:
//   cand   cells taken off the active set (up to reactMaxCand)
//   seen   those PLUS their four neighbours, deduped — up to 5x cand, and every one is a Set insertion
//   anchor the survivors that actually hold lava/acid/water and can react at all
// If `seen` dwarfs `anchor`, the cost is the candidate expansion and no amount of tuning individual reactions
// touches it. If they are close, the chemistry itself is the cost and naming the reaction becomes worthwhile.
let liqReactCand = 0, liqReactSeen = 0;
// ⭐⭐ WHY IS THE WORK QUEUE NOT DRAINING? Flagged directly: *"if the share of the queue moving each tick is 3.1%,
// surely that should be screaming to us that there is an enormous performance issue."* It should, and it is.
// 29,167 cells queued while 893 move means ~97% of the queue is cells the sim looks at and does nothing with.
// The question is HOW THEY GOT IN, and there are only three doors:
//   liqQProcessed  cells the flow loop actually examined
//   liqQMoved      of those, cells that changed something
//   liqQWoken      cells added by wake/wakeN/wakeD because a NEIGHBOUR moved (most of these have nothing to do)
//   liqQCapped     cells put back untouched because the per-sub-step cap was reached
// If `woken` dominates, the sim is re-examining a huge halo around every moving cell every tick, and the fix is
// the wake rule — not the flow, not the budget, and not anything measured so far.
let liqQProcessed = 0, liqQMoved = 0, liqQWoken = 0, liqQCapped = 0;
// ⭐⭐ HOW FAR THE SIDEWAYS SCANS ACTUALLY WALK. The two levelling scans (1c/1d and 2c) look up to
// LIQUID_LEVEL_SCAN = 28 cells along the row in EACH direction, per cell, per sub-step, and the per-line
// profile puts them at ~18% of the liquid tick between them. Whether that is worth attacking depends entirely
// on the average, which nobody has ever measured: 3 steps means the reach is irrelevant and the cost is the
// loop's overhead, while 28 means it is walking the full window and finding nothing — which is what a FLAT
// pool would do, since the scan only stops early on a wall, a higher cell, or a target.
// `runs` counts one per direction attempted, so steps/runs is the mean walk length out of `reach`.
let liqLvlSteps = 0, liqLvlRuns = 0, liqPlSteps = 0, liqPlRuns = 0;
// ⭐⭐ THE FAST ROW WALK CHECKED AGAINST THE LOOP IT REPLACES (`liquidCfg.scanVerify`, off by default).
// The two guards that would normally cover a change here — `probe_fine_identity` and `probe_addressing` Part B —
// both build their scenes BY HAND, so both rooms are non-generated and NEITHER exercises the `genRoom` branch
// of `isSolid`, which is the one the Overworld ships. A bug in the fast walk's terrain half would pass both.
// So the verification is the direct one: run both, compare the answers, count disagreements. Turn it on in the
// live Overworld, pour water, and read this. It must be exactly 0.
let liqScanMismatch = 0;
// 🟥 CHUNKS GENERATED FROM INSIDE THE LIQUID TICK. A profile of aggressive panning put worldgen.js at 33.4% of
// all server CPU — more than the entire liquid sim — and the sim is one of the things that triggers it: any read
// into a chunk that has never been produced runs the generator (`rp` → `_miss` → `_alloc`), synchronously, at
// ~0.9ms a chunk. So liquid flowing to the edge of produced world generates that world MID-TICK, which is how a
// single tick reaches the 940ms the in-game readout reports. This counter separates "the sim is slow" from
// "the sim is generating the world while you watch", which are different problems with different fixes.
let liqTickGenPages = 0;
// ⚠️ AND WHICH PASS. Bracketing the whole tick said 66% of world generation happened inside it; fixing the
// liquid flow's solidity test moved the number the WRONG WAY, which means the flow was never the source. A total
// cannot say who spent it, so each pass is bracketed separately. (`drain` is `drainGenLiquid`, which runs at the
// top of the tick precisely because production defers liquid seeding to it.)
const liqGenBy = { drain: 0, src: 0, react: 0, flow: 0, powder: 0, soil: 0 };
let _genMark = 0;
const genMark = () => { _genMark = genPagesProduced; };
const genSince = (k) => { liqGenBy[k] += genPagesProduced - _genMark; _genMark = genPagesProduced; };
// ⭐⭐ …AND THE SAME BRACKETING FOR TIME, WHICH IS THE QUESTION ACTUALLY BEING ASKED. The tick reported one
// number for itself and one for chemistry, and everything else — sources, the flow, falling grains, soil — was a
// single undifferentiated remainder. "The liquid tick is 25ms" is the question restated, not an answer, and it
// is the same mistake the profiling note upstairs records: *a total cannot say who spent it*.
// ⚠️ SAME KEYS AND THE SAME CALL SITES as `genSince`, deliberately — two accountings of one sequence of passes
// that disagreed about where the boundaries were would be worse than having only one.
// ⚠️ A SECTORED room does its six passes inside `liqTickSectors`, i.e. before the top-level `msSince('flow')` is
// reached, so it brackets them there too. Without that every strip's chemistry would be charged to the flow.
const liqMsBy = { drain: 0, src: 0, react: 0, flow: 0, powder: 0, soil: 0 };
let _msMark = 0;
const msMark = () => { _msMark = performance.now(); };
const msSince = (k) => { const n = performance.now(); liqMsBy[k] += n - _msMark; _msMark = n; };
const liqReactFired = {};     // reaction FX code → how many times it has fired
// A reaction can only START when something changes, and anything that moved is already in roomFineActive — which the tick
// uses as its candidate list. What that misses is a change to a SETTLED pair (painting water beside a settled lava pool,
// digging the wall between them), so terrain edits seed the cell + its 4 neighbours explicitly.
function seedFineReactAround(room, i) {
  if (!liquidCfg.reactions) return;
  const d = roomDims(room), ROWS = d.rows, N = d.cols * ROWS; if (i < 0 || i >= N) return;
  const s = fineReactSet(room), r = i % ROWS;
  s.add(i); if (i - ROWS >= 0) s.add(i - ROWS); if (i + ROWS < N) s.add(i + ROWS);
  if (r > 0) s.add(i - 1); if (r < ROWS - 1) s.add(i + 1);
}
// THE REACTION SET, all on 8px contact, all resolving the tick they are seen. Every non-lava liquid must have an
// outcome here: lavaBlk stops lava entering their cells, so a pair with nothing to resolve it would hover against each
// other forever. Exhaustive over the six ranks — quicksand→glass, brine/acid/water→stone, oil→burns off.
//   LAVA + water/brine/acid  → STONE, in ONE 8px cell, from ANY amount of lava (no minimum: an earlier FREACT_LAVA_MIN
//     floor stopped a film paving a sheet of stone, and the user's call is that a sheet is fine).
//     ⭐ The stone takes the LOWER of the two cells (tie ⇒ the lava cell): lava dropped into a pool fills it from the
//     surface downward instead of crusting one cell ABOVE the water, which read as stone floating in mid-air.
//   LAVA + quicksand → GLASS · LAVA + oil → the oil BURNS OFF (no stone; 2e makes the fire spread)
//   LAVA + snow/ice (solid) → WATER, and the lava cools · LAVA + mud → EARTH (baked dry) · LAVA + sand → GLASS (fused)
//   WATER + snow (solid) → ICE. Ice is not snow, so it cannot chain: exactly a one-cell rime shell. Water that is ALSO
//     touching lava does not freeze — lava wins (same precedence the coarse sim had).
// Terrain conversions cost the lava that did them, which is what bounds how far a pool eats into a snow/sand field.
const FREACT_QUENCH_F = 0.375;  // fraction of a cell of the other liquid flashed off per contact when the LAVA cell crusts
const FREACT_MELT_COST_F = 0.125;  // lava spent melting one snow/ice cell
const FREACT_MELT_AMT_F = 0.625;   // water a melted snow/ice cell leaves behind (< a full cell, so it flows away rather than sitting brim-full)
const FREACT_BAKE_COST_F = 0.0625; // lava spent baking one mud cell → earth
const FREACT_FUSE_COST_F = 0.0625; // lava spent fusing one sand cell → glass
const FREACT_OIL_BURN_F = 0.09375;  // oil consumed per pass by a BURNING cell
const FREACT_FREEZE_COST_F = 0.375; // water consumed when a snow cell freezes into ice
// ⭐ SALT + WATER → BRINE. The world redesign's one new reaction (user's call 2026-08-09). The game already has
// brine as a fluid, so this is a new PAIR, not a new substance: a salt cell touching water dissolves away and
// what is left in its place is brine (rank 2, heavier than water — so it sinks under the lake that made it).
// ⚠️ BOUNDED THE SAME WAY EVERY OTHER REACTION HERE IS: a reaction is anchored on a cell that MOVED this tick
// (or one a player just edited), so a settled lake sitting against a settled salt bed does nothing at all. It
// eats into the salt only while water is actually flowing over it. That is what stops a salt dome quietly
// dissolving itself overnight, and it is why this needs no rate limiter of its own.
// ⚠️ The water pays for it, so the lake that dissolves a salt bed visibly drops as it does.
// ⚠️ SALT_ID is assigned BELOW the sliced block (see the POWDER_MOVE note). -1 until then, and -1 can never
// equal a Uint8 cell value, so a probe rig compiling this block alone simply has no salt in its world.
let SALT_ID = -1;
const FREACT_BRINE_AMT_F = 0.5;     // brine left where a dissolved salt cell was (< a full cell ⇒ it flows away)
const FREACT_DISSOLVE_COST_F = 0.375; // water consumed dissolving one salt cell
// ACID at 8px. The coarse bite was one 24px cell per 8 ticks = 3px of penetration per tick; an 8px cell eaten at the
// same cadence would only be 1px/tick, i.e. 3× slower through the same wall. Biting every 3rd tick restores the
// original physical eat-rate — the reaction is unchanged, only the cadence is re-derived for the smaller cell.
const ACID_BITE_TICKS = 3;
const FREACT_ACID_COST_F = 0.09375; // acid spent per bite
// OIL FIRE. Lava does not burn oil directly any more — it IGNITES it, and fire spreads cell to cell through the oil,
// so a slick lights from the point of contact and runs back through itself instead of quietly shrinking.
// (`fineFire` on the cell store: Set<fine cell> currently burning.)
function fineFireSet(room) { const s = cellsOf(room); if (!s.fineFire) { s.fineFire = new Set(); cellRooms.fire.add(room); } return s.fineFire; }
function fineReactTickRoom(room, SUB) {
  if (!liquidCfg.reactions) return;
  const st = cellsOf(room);
  SUB = SUB || st.fineSub || 1;
  if (SUB !== 1) return;     // reactions write TERRAIN; the two grids only share an index space at the all-fine ratio
  const grid = st.terrain, hp = st.terrainHp, amt = st.fineAmt, tot = st.fineTotal;
  if (!grid || !hp || !amt || !tot) return;
  const active = st.fineActive, seeded = st.fineReact, burning = st.fineFire;
  // ⚠️ `active` only keeps this pass alive when it is actually a candidate source — see reactMovedOnly below.
  // Leaving it in the test regardless would run the whole pass on an empty candidate list every tick a pool is
  // still settling, which is most of them.
  const _movedOnly = !!liquidCfg.reactMovedOnly;
  if ((_movedOnly || !active || !active.size) && (!seeded || !seeded.size) && (!burning || !burning.size)) { if (seeded) dropFineReact(room); return; }
  const mats = roomMats[room] || {}, T = LIQ_T, COLS = st.cols, ROWS = st.rows, N = grid.length;
  const tick = liquidTickCount, FLOOR_ROW = Math.floor(roomFloorTop(room) / TERRAIN_CELL);   // acid may not eat the bedrock row
  const act = fineSet(room), liqChanged = new Set(), terrCells = [], fx = [];
  // FX WIRE. The client used to derive reaction FX from grid TRANSITIONS on the coarse liquid-cells wire (`old === 11
  // && gid === 2` ⇒ steam, etc). In fine mode liquid is not a grid id at all, so no transition can ever match and every
  // one of those effects is unreachable. The server knows exactly which reaction fired, so it says so: [cell, code].
  const addFx = (i, code) => { liqReactFired[code] = (liqReactFired[code] || 0) + 1; if (fx.length < 4096) fx.push(i, code); };
  // 🟥 SAME RULE AS THE FLOW AND POWDER PASSES: never build world from inside the tick. MEASURED at 927 chunks
  // generated from inside the reaction pass over 35s -- the largest single source. `.g()` produces the page it
  // lands on, and these read NEIGHBOURS, so they reach one cell past the produced world by construction.
  // ⭐ -1 (unbuilt) is neither air nor a fluid nor a reagent, so every test below falls through to 'no reaction',
  // which is the fail-safe answer: chemistry waits until that ground actually exists.
  const genRoom = !!grid.seedFn;
  const gPeek = genRoom ? (j) => { const v = peekCellAt(grid, j); return v >= 0 ? v : (grid.skyAt(j) ? 0 : -1); } : (j) => grid.g(j);
  const wake = (j) => { if (j >= 0 && j < N && tot.g(j) > 0) { const v = gPeek(j); if (v === 0 || isFluidId(v)) act.add(j); } };
  const wakeN = (j) => { const r = j % ROWS; wake(j - ROWS); wake(j + ROWS); if (r > 0) wake(j - 1); if (r < ROWS - 1) wake(j + 1); };
  const recomp = (j) => { const p = amt.rp(j), b = amt.o(j); let s = 0; for (let k = 0; k < T; k++) s += p[b + k]; tot.s(j, s); };
  const clearFine = (j) => { const p = amt.wp(j), b = amt.o(j); for (let k = 0; k < T; k++) p[b + k] = 0; tot.s(j, 0); act.delete(j); liqChanged.add(j); };
  // A reaction product that is SOLID: takes the cell whole (any liquid in it goes with it) and rides the terrain wire.
  const setSolid = (j, id) => { if (tot.g(j) > 0) clearFine(j); act.delete(j); grid.s(j, id); hp.s(j, matStrengthSrv(mats, id)); terrCells.push(j, id); if (st.sat) st.sat.s(j, 0); wakeN(j); };
  // ...and one that is LIQUID: the solid is removed from terrain and the liquid appears in the same cell (in fine mode
  // terrain holds solids only, so a melt is BOTH a terrain-set to empty and a fine-liquid write).
  const setLiquid = (j, rk, units) => {
    grid.s(j, 0); hp.s(j, 0); terrCells.push(j, 0);
    const p = amt.wp(j), jb = amt.o(j); for (let k = 0; k < T; k++) p[jb + k] = 0;
    p[jb + rk] = units; tot.s(j, units);
    liqChanged.add(j); act.add(j); wakeN(j);
    const up = j - 1; if (j % ROWS > 0 && isPowderId(grid.g(up))) powderSet(room).add(up);   // grains resting on the melted cell may now fall
  };
  const spendLava = (i, cost) => { const p = amt.wp(i), b = amt.o(i); p[b] = p[b] > cost ? p[b] - cost : 0; recomp(i); liqChanged.add(i); if (tot.g(i) > 0) act.add(i); else act.delete(i); wakeN(i); return p[b]; };
  // ⭐ SOLID REACTANT ⇒ THE PRODUCT REPLACES IT IN PLACE, and the liquid partner just pays a cost. A solid cannot
  // hover, so the lower-cell rule has no work to do here — and RELOCATING the product is what produced the
  // unpredictable holes: a lava cell with sand ABOVE it turned ITSELF to glass and deleted the sand, so a 2×2 lava
  // block in sand gave a scatter of glass and gaps instead of a clean ring. The solid also stops being that solid, so
  // there is still nothing left to slide on and lay a trail (which is what consuming both was really for).
  const convertSolid = (sol, id, code) => { setSolid(sol, id); if (code) addFx(sol, code); };
  // ...and when BOTH reactants are LIQUID, the lower-cell rule still applies, so lava dropping into a pool cannot
  // leave its product hanging in mid-air above the surface.
  const combine = (a, bc, id, code) => {
    // tie-break: the cell that is a REAL solid. `grid[bc] !== 0` no longer means that — since the re-coupling a liquid
    // cell carries its own fluid id too, which silently flipped this to "whichever cell has anything in it".
    const prod = (bc === a + 1) ? bc : (a === bc + 1 ? a : (isSolidCell(grid.g(bc)) ? bc : a));
    const gone = prod === a ? bc : a;
    if (grid.g(gone) !== 0) { grid.s(gone, 0); hp.s(gone, 0); terrCells.push(gone, 0); wakeN(gone); }
    if (tot.g(gone) > 0) clearFine(gone);
    setSolid(prod, id); if (code) addFx(prod, code);
  };
  // Candidates: every cell that moved this tick, plus anything seeded by a terrain edit. The reaction is anchored on the
  // LAVA cell, which may be a candidate itself OR a settled neighbour of one (a still lava pool a stream just reached),
  // so each candidate also offers up its 4 neighbours — `done` keeps a shared lava cell from being evaluated twice.
  // ⚠️ BOUNDED, AND THE BOUND IS WHY THE OVERWORLD'S LIQUID MOVES AT ALL. See the reactAnchorFilter /
  // reactMaxCand note in liquidCfg for the measurement — unbounded, this pass starved the flow loop outright.
  // The cursor is per ROOM and advances by however many candidates were taken, so over successive ticks the
  // whole active set is covered; a capped tick is a DELAY for the cells past the cap, never a skip.
  // ⚠️ `seeded` is drained WHOLE regardless of the cap. It holds cells a terrain edit explicitly flagged for a
  // reaction test — a handful, and each one is a thing a player just did. Rationing those would make building
  // feel broken in a way rationing settled liquid does not.
  const cand = [];
  // ⭐⭐ CANDIDATES COME FROM WHAT CHANGED, NOT FROM WHAT MIGHT MOVE (liquidCfg.reactMovedOnly, ON).
  // 🟥 THE FLOW ALREADY SEEDS EVERY CHANGED CELL INTO `seeded`, and the note where it does so states the
  // principle in as many words: *"REACTION CANDIDATES COME FROM changedSet, NOT FROM active. These are different
  // things and conflating them is why reactions only fired while liquid was still MOVING."* This pass did both —
  // it drained `seeded` AND separately took up to `reactMaxCand` cells off `active` — so the correct source was
  // already there and the expensive one was piled on top of it.
  // 🟥 MEASURED ON THE RUNNING SERVER, six scenes: chemistry examined 106,000–565,000 cells a second and fired
  // ZERO reactions in five of them, for 2.4–9ms of every tick — a big pour, an oil pour mid-stratification, and
  // a scene with extra materials added. Only a scene built deliberately to react fired anything at all.
  // ⭐ `active` means "may still move"; a cell in it whose contents did not change cannot have made a new
  // contact, and if its NEIGHBOUR changed then the neighbour is in `seeded` and the ±4 expansion below reaches
  // back to it. So this is not an approximation — it is the same set of contacts, found once instead of twice.
  // ⚠️ OFF restores the old double source exactly. The check is the `fired` count on the Perf tab beside
  // `examined`: if any scene fires FEWER reactions with this on, the reasoning above is wrong somewhere.
  if (active && active.size && !_movedOnly) {
    const capN = Math.max(0, liquidCfg.reactMaxCand | 0);
    if (!capN || active.size <= capN) { for (const i of active) cand.push(i); roomReactCursor[room] = 0; }
    else {
      let start = (roomReactCursor[room] | 0) % active.size, n = 0;
      for (const i of active) { if (n++ < start) continue; cand.push(i); if (cand.length >= capN) break; }
      // Wrap: a cursor near the end takes fewer than the cap, so top up from the front rather than waste the tick.
      if (cand.length < capN) for (const i of active) { cand.push(i); if (cand.length >= capN) break; }
      roomReactCursor[room] = (start + capN) % active.size;
      liqReactSkips++;
    }
  }
  if (seeded) { for (const i of seeded) cand.push(i); seeded.clear(); }
  // ⭐ ONLY CELLS THAT CAN REACT BECOME ANCHORS. All three phases below open by requiring lava (rank 0), acid
  // (rank 3) or water (rank 4) and `continue` otherwise, so this is their own entry test hoisted ahead of the
  // dedupe Set instead of applied after it — which is the difference between a Set of every liquid cell's
  // neighbourhood and a Set of the cells that have work.
  // ⚠️ NOT byte-identical, and here is the one case: a cell that ACQUIRES lava/acid/water from a reaction fired
  // earlier in this same pass was an anchor before and is not one now, so its own follow-on reaction happens on
  // the NEXT tick instead. It cannot be lost — every producer (`setLiquid`, `setSolid`, `spendLava`, `combine`)
  // calls `act.add`/`wakeN`, so the cell is a candidate again immediately. One tick of latency on a secondary
  // chain, against a pass that otherwise does not run at all.
  const filt = !!liquidCfg.reactAnchorFilter;
  const reactive = (i) => { const p = amt.rp(i), b = amt.o(i); return p[b] > 0 || p[b + 3] > 0 || p[b + 4] > 0; };
  // 🟥 THIS ALLOCATED A FIVE-ELEMENT ARRAY PER CANDIDATE, and the candidate list runs to `reactMaxCand` = 20,000
  // per room per tick. Twenty thousand short-lived arrays a tick, twenty-five ticks a second, is both real CPU
  // and real garbage — the same shape as the two closures per cell per sub-step the flow loop was rewritten to
  // drop. The five offsets are now taken one at a time by an unrolled helper; nothing about the order or the
  // dedupe changes, so the anchor list is the same list.
  const seen = new Set(), anchors = [];
  const offer = (i) => {
    if (i < 0 || i >= N || seen.has(i)) return;
    seen.add(i); if (filt && !reactive(i)) return;
    anchors.push(i);
  };
  for (const ci of cand) {
    if (ci < 0 || ci >= N) continue;
    const cr = ci % ROWS;
    offer(ci); offer(ci - ROWS); offer(ci + ROWS);
    if (cr > 0) offer(ci - 1);
    if (cr < ROWS - 1) offer(ci + 1);
  }
  liqReactCand += cand.length; liqReactSeen += seen.size; liqReactAnchors += anchors.length;
  // ⭐ TWO PHASES, so the result cannot depend on Set iteration order. EVERY lava contact is resolved first, then the
  // water-freezing is evaluated against the state that leaves. Measured before the split: the same lava-on-snow setup
  // gave STONE in one geometry and ICE in another, purely on which cell the pass happened to reach first.
  for (const i of anchors) {
      const r = i % ROWS;                                     // ranks: lava0 quicksand1 brine2 acid3 water4 oil5
      // ⚠️ The page is re-fetched per use rather than hoisted: every cell reached here holds lava (the guard below),
      // so its page is real — but setSolid/setLiquid/spendLava run in between and it must stay obvious that these
      // read live state, not a snapshot.
      if (amt.rp(i)[amt.o(i)] <= 0) continue;
      const lavaAt = () => amt.rp(i)[amt.o(i)];
      const NB = [r < ROWS - 1 ? i + 1 : -1, r > 0 ? i - 1 : -1, i - ROWS, i + ROWS];   // BELOW first: lava resting on a pool crusts INTO it, not one cell above
      // ── (A) SOLID terrain the lava is touching. Each conversion costs lava, so a pool eats a bounded distance in.
      for (const j of NB) {
        if (lavaAt() <= 0 || j < 0 || j >= N) continue;
        const g = gPeek(j);
        if (g === 8 || g === 4) { setLiquid(j, 4, capFrac(FREACT_MELT_AMT_F)); spendLava(i, capFrac(FREACT_MELT_COST_F)); addFx(j, 1); }   // snow/ice melt → water
        else if (g === 5) { setSolid(j, 1); spendLava(i, capFrac(FREACT_BAKE_COST_F)); addFx(j, 4); }                          // mud baked dry → earth
        else if (g === 3) { convertSolid(j, 16, 3); spendLava(i, capFrac(FREACT_FUSE_COST_F)); }                                                       // sand fused → glass, BOTH consumed
      }
      if (lavaAt() <= 0) continue;                            // the lava spent itself on the terrain
      // ── (B) QUICKSAND fuses to GLASS. Checked before the quench so it wins over the generic crust.
      let qj = amt.rp(i)[amt.o(i) + 1] > 0 ? i : -1;
      if (qj < 0) for (const j of NB) { if (j >= 0 && j < N && amt.rp(j)[amt.o(j) + 1] > 0) { qj = j; break; } }
      if (qj >= 0) {
        if (qj === i) { setSolid(i, 16); addFx(i, 3); continue; }           // mixed in one cell → that cell is the glass
        combine(i, qj, 16, 3); continue;                          // both consumed
      }
      // ── (C) QUENCH → STONE. Brine, acid and water all crust lava.
      let wj = -1;
      { const pi = amt.rp(i), bi = amt.o(i); for (const rk of [2, 3, 4]) if (pi[bi + rk] > 0) { wj = i; break; } }   // mixed into this very cell counts as contact
      if (wj < 0) for (const j of NB) { if (j < 0 || j >= N || tot.g(j) <= 0) continue; const pj2 = amt.rp(j), jb = amt.o(j);
        if (pj2[jb + 2] > 0 || pj2[jb + 3] > 0 || pj2[jb + 4] > 0) { wj = j; break; } }
      if (wj >= 0) {
        const sj = (wj === i + 1) ? wj : i, pj = sj === i ? wj : i;      // the stone takes the LOWER cell; tie ⇒ the lava cell
        if (sj !== pj) {
          if (pj === i) { amt.wp(i)[amt.o(i)] = 0; recomp(i); }             // the lava went into making the stone below it
          else { let q = capFrac(FREACT_QUENCH_F); const pp = amt.wp(pj), pb = amt.o(pj);     // ...or the other liquid flashes off above the crust
            for (let rk = T - 1; rk >= 1 && q > 0; rk--) { const a = pp[pb + rk]; if (a <= 0) continue; const mv = a < q ? a : q; pp[pb + rk] = a - mv; q -= mv; }
            recomp(pj); }
          liqChanged.add(pj); if (tot.g(pj) > 0) act.add(pj); else act.delete(pj);
          wakeN(pj);
        }
        setSolid(sj, 2); addFx(sj, 1);
        continue;
      }
      // ── (D) OIL IGNITES on contact with lava. The lava is not consumed; the fire then spreads through the slick on
      // its own (see the fire phase), so a pool lights at the point of contact and runs back through itself.
      let oj = amt.rp(i)[amt.o(i) + 5] > 0 ? i : -1;
      if (oj < 0) for (const j of NB) { if (j >= 0 && j < N && amt.rp(j)[amt.o(j) + 5] > 0) { oj = j; break; } }
      if (oj >= 0) fineFireSet(room).add(oj);
  }
  // ── FIRE: every burning cell consumes its oil and lights any neighbour holding oil. Driven by its own set rather
  // than the anchors, so a slick keeps burning after everything has settled and stopped moving.
  const fire = st.fineFire;
  if (fire && fire.size) for (const i of Array.from(fire)) {
    if (i < 0 || i >= N || amt.rp(i)[amt.o(i) + 5] <= 0) { fire.delete(i); continue; }   // burnt out (or the oil moved on)
    const p = amt.wp(i), b = amt.o(i);
    const oburn = capFrac(FREACT_OIL_BURN_F); p[b + 5] = p[b + 5] > oburn ? p[b + 5] - oburn : 0;
    recomp(i); liqChanged.add(i); if (tot.g(i) > 0) act.add(i); else act.delete(i); wakeN(i);
    addFx(i, 7);                                                            // flame, every pass it is alight — not a one-shot
    if (p[b + 5] <= 0) fire.delete(i);
    const r = i % ROWS;
    for (const j of [r < ROWS - 1 ? i + 1 : -1, r > 0 ? i - 1 : -1, i - ROWS, i + ROWS])
      if (j >= 0 && j < N && amt.rp(j)[amt.o(j) + 5] > 0) fire.add(j);      // the flame front
  }
  if (fire && !fire.size) dropFineFire(room);
  // ── PHASE 2: ACID. Transferred from the coarse liquidTickRoom block, same model: SOAK adjacent water into this cell's
  // dilution (consuming it) and CONVERT acid→water once saturated; with no water to neutralise against, DISSOLVE an
  // adjacent breakable solid instead (never bedrock, never glass). Both are GRADUAL, so — like the oil burn — they do
  // not resolve their own contact in one pass and must re-seed or they stall the moment the pool settles.
  for (const i of anchors) {
    const pa = amt.rp(i), b = amt.o(i), acid = pa[b + 3];
    if (acid <= 0 || pa[b] > 0) continue;                   // (lava contact already turned this cell to stone in phase 1)
    const r = i % ROWS, NB = [r < ROWS - 1 ? i + 1 : -1, r > 0 ? i - 1 : -1, i - ROWS, i + ROWS];
    const dil = ensureDilute(room);
    let waterSrc = pa[b + 4] > 0 ? i : -1;
    if (waterSrc < 0) for (const j of NB) { if (j >= 0 && j < N && amt.rp(j)[amt.o(j) + 4] > 0) { waterSrc = j; break; } }
    if (waterSrc >= 0 || dil.g(i) >= ACID_K) {
      if (waterSrc >= 0 && (tick % ACID_SOAK_TICKS) === 0 && dil.g(i) < acid * ACID_K) {   // SOAK 1 water → dilution (consumed)
        amt.wp(waterSrc)[amt.o(waterSrc) + 4] -= 1; dil.wp(i)[dil.o(i)] += 1;
        recomp(waterSrc); liqChanged.add(waterSrc); if (tot.g(waterSrc) > 0) act.add(waterSrc); else act.delete(waterSrc); wakeN(waterSrc);
      }
      if ((tick % ACID_CONVERT_TICKS) === 0 && dil.g(i) >= ACID_K && amt.rp(i)[b + 3] >= 1) {    // CONVERT 1 saturated acid → water
        const pw = amt.wp(i), dp = dil.wp(i), dof = dil.o(i);
        pw[b + 3] -= 1; pw[b + 4] += 1; dp[dof] -= ACID_K; recomp(i); liqChanged.add(i); act.add(i); wakeN(i);
        if (pw[b + 3] <= 0) dp[dof] = 0;
      }
      const rs = fineReactSet(room); rs.add(i); if (waterSrc >= 0) rs.add(waterSrc);
    } else {                                                // nothing to neutralise with → eat an adjacent solid
      let solidJ = -1;
      for (const j of NB) { if (j < 0 || j >= N) continue; if ((j % ROWS) >= FLOOR_ROW) continue;
        const g = gPeek(j); if (g > 0 && !isFluidId(g) && hp.g(j) > 0 && g !== 16) { solidJ = j; break; } }   // never bedrock, never glass (acid-immune)
      if (solidJ >= 0) {
        fineReactSet(room).add(i);                          // gradual: keep the contact alive between bites
        if ((tick % ACID_BITE_TICKS) === 0) {
          addFx(solidJ, 8);                                   // fizz at the bite, every bite — not just the one that breaks through
          if (hp.g(solidJ) > 1) hp.s(solidJ, hp.g(solidJ) - 1);
          else { grid.s(solidJ, 0); hp.s(solidJ, 0); terrCells.push(solidJ, 0); wakeN(solidJ); seedFineReactAround(room, solidJ); }
          const abite = capFrac(FREACT_ACID_COST_F); amt.wp(i)[b + 3] = acid > abite ? acid - abite : 0;
          recomp(i); liqChanged.add(i); if (tot.g(i) > 0) act.add(i); else act.delete(i); wakeN(i);
        }
      }
    }
  }
  // ── PHASE 3: WATER. Snow contact freezes it to ICE — only water touching SNOW, and ice is not snow, so it cannot
  // chain: exactly a one-cell rime shell. Water still touching lava after phase 1 is left alone, lava wins. Water also
  // SEEDS the saturation model here (the coarse sim did this inline in its water branch, which fine mode never runs).
  for (const i of anchors) {
    const pa = amt.rp(i), b = amt.o(i);
    if (pa[b] > 0 || pa[b + 4] <= 0) continue;
    // 🟥 THIS IS THE PASS THAT RUNS FOR EVERY MOVING WATER CELL, and it allocated a four-element array and then
    // took FOUR PAGED TERRAIN READS for each one, looking for a shoreline. On a heavy pour that is tens of
    // thousands of cells a tick and the great majority of them are open water with no shore anywhere near.
    // The array is gone; the four reads are still here, and they are the next thing to look at — see the
    // reaction counters on the Perf tab, which now say how many cells were examined against how many reactions
    // actually fired. Do not guess at that ratio: read it.
    const r = i % ROWS;
    let snowJ = -1, saltJ = -1, ss = null;
    for (let n = 0; n < 4; n++) {
      const j = n === 0 ? (r < ROWS - 1 ? i + 1 : -1) : n === 1 ? (r > 0 ? i - 1 : -1) : n === 2 ? i - ROWS : i + ROWS;
      if (j < 0 || j >= N) continue;
      const g = grid.g(j);
      if (g === 8 && snowJ < 0) snowJ = j;
      if (g === SALT_ID && saltJ < 0) saltJ = j;
      if (g === 1 || g === 3 || g === 5) { if (!ss) ss = soilSet(room); ss.add(j); }   // earth/sand/mud beside water → absorb
    }
    if (snowJ < 0 && saltJ < 0) continue;
    let nearLava = false; for (const j of NB) { if (j >= 0 && j < N && amt.rp(j)[amt.o(j)] > 0) { nearLava = true; break; } }
    if (!nearLava) {
      // One reaction per water cell per tick, freeze first — same shape as the lava phase, and it keeps the
      // water's cost from being charged twice for a cell that happens to touch both snow and salt.
      if (snowJ >= 0) convertSolid(snowJ, 4, 2);                            // the snow itself becomes the ice, so nothing survives to slide on
      else setLiquid(saltJ, 2, capFrac(FREACT_BRINE_AMT_F));                // the salt cell itself becomes the brine (rank 2)
      const pw = amt.wp(i);
      let q = capFrac(snowJ >= 0 ? FREACT_FREEZE_COST_F : FREACT_DISSOLVE_COST_F);
      for (let rk = T - 1; rk >= 1 && q > 0; rk--) { const a = pw[b + rk]; if (a <= 0) continue; const mv = a < q ? a : q; pw[b + rk] = a - mv; q -= mv; }
      if (snowJ < 0) addFx(saltJ, 9);                                       // fizz where the salt went
      recomp(i); liqChanged.add(i); if (tot.g(i) > 0) act.add(i); else act.delete(i); wakeN(i);
    }   // BOTH the snow and the water become one ice cell — the snow must not survive to slide on and freeze a trail
  }
  for (const j of liqChanged) fineSyncGrid(room, j);           // a drained/created stack changes the cell's representative id
  if (liquidQuiet) return;                                    // gen pre-settle: react, but don't broadcast
  if (fx.length) wireFanout(room, 'liquid-fx', { cells: fx });
  // ORDER MATTERS now the grid carries fluid ids: a cell the reaction turned SOLID also appears in liqChanged with an
  // empty stack, and applying that after the terrain write would clear the new solid straight back to 0.
  if (liqChanged.size) {                                      // same encoding as the fine tick's own wire
    let arr = [], cells = 0;
    const flush = () => wireFanout(room, 'liquid-fine-cells', { sub: SUB, cols: COLS, cells: arr });
    for (const j of liqChanged) {
      const p = amt.rp(j), b = amt.o(j); let mask = 0; for (let rk = 0; rk < T; rk++) if (p[b + rk] > 0) mask |= (1 << rk);
      arr.push(j, liqRepId(amt, j), 0, mask);   // flags: not a tick observation, so no AIRBORNE bit (see fineWirePush)
      for (let rk = 0; rk < T; rk++) if (mask & (1 << rk)) arr.push(p[b + rk]);
      if (++cells >= 8192) { flush(); arr = []; cells = 0; }
    }
    if (cells) flush();
  }
  if (terrCells.length) wireFanout(room, 'terrain-set', { cells: terrCells });
}
// Fine-cell wire helpers. INSIDE the sim block because the sim itself now emits through them: soilTickRoom and
// powderTickRoom both write fine liquid in fine mode, so the harness has to be able to reach these too.
// Flags is 0 here on purpose: these are OUT-OF-TICK broadcasts (placement, join replay), and the AIRBORNE bit is a
// per-tick observation the sim only makes while it is running. A cell mid-flight picks its bit back up on the next tick.
function fineWirePush(room, idxList, cells) {   // append [i, repId, flags, mask, amts…] for each fine cell in idxList
  const amt = cellsOf(room).fineAmt;
  for (const i of idxList) { const p = amt.rp(i), b = amt.o(i); let mask = 0; for (let rk = 0; rk < LIQ_T; rk++) if (p[b + rk] > 0) mask |= (1 << rk); cells.push(i, liqRepId(amt, i), 0, mask); for (let rk = 0; rk < LIQ_T; rk++) if (mask & (1 << rk)) cells.push(p[b + rk]); }
}
function emitFineCells(room, idxList) {   // broadcast a set of fine cells immediately (used by placement — the tick only broadcasts what MOVED)
  const st = cellsOf(room);
  if (!idxList.length || !st.fineAmt) return;
  const SUB = st.fineSub || 1, cells = []; fineWirePush(room, idxList, cells);
  if (cells.length) wireFanout(room, 'liquid-fine-cells', { sub: SUB, cols: st.cols * SUB, cells });
}
// ==LIQUID_SIM_BLOCK_END== (test harness slices the sim to this marker)
// Restartable sim loop — the tick rate is liquidCfg.tickMs so the Liquid Debug menu can speed it up/slow it down live.
let liquidTimer = null;
let liquidStepsPending = 0;                           // ticks the debug panel has asked for while paused
// ── PER-TICK SIM BUDGET (liquidCfg.simBudgetPct; SHARED-WORLD.md Phase 1).
// `roomLiqCost` is an EMA of each room's OWN flow-pass ms. It is used to PLAN the roster before any pass
// runs, so sources, reactions, flow, powder and soil all agree on who is being skipped; a reactive
// wall-clock stop inside the flow loop is the hard guarantee if a prediction is badly wrong.
// ⚠️ WHY WHOLE ROOMS, NEVER PART OF ONE. Half-ticking a pool would advance one end and not the other, and
// it would break powder's lockstep with liquid ("consistent gravity"). Rooms never interact, so skipping
// one entirely is behaviour-preserving for the others.
// ⚠️ A DEFERRED ROOM IS SIMPLY NOT TICKED — its active Set is never read and never cleared, so nothing
// drains and no cell is stranded. That is deliberately dodging the trap this codebase has hit twice
// (a budget switches a branch off and the cell has nothing left to keep it alive → frozen mid-sort);
// skipping at ROOM granularity sidesteps it by construction rather than by another wouldSort()-style fix.
// `liqRoomCursor` rotates the starting point so the same rooms are not starved every tick.
const roomLiqCost = {};
let liqRoomCursor = 0;
// How many room-ticks tier 3 has skipped. Reported in the perf line, and it is what probe_budget asserts
// against — "did the mechanism fire?" is a fact, where "did the tick count change?" turned out to be wall-clock
// luck (the budget's hard stop is timed, so a loaded machine changes the tick count on its own).
let liqRateSkips = 0;
let liqIdleSkips = 0;         // ticks skipped because nobody was in the room at all
// ⭐⭐ THE FLOOR UNDER THE LIQUID BUDGET, and the counter that says it is doing something.
// The budget is "what the chunk drain left" — and the drain can legitimately take all of it, at which point the
// remainder is zero. Zero was then read as "no budget configured" by every downstream gate and the sim ran
// UNBOUNDED (see the long note at the calculation). A quarter of nominal is the compromise: the tiers always
// have something real to ration, and liquid never stops entirely just because somebody is exploring.
// ⚠️ DECLARED HERE, INSIDE the block `probe_budget` slices to `==LIQUID_TICK_BLOCK_END==`. A constant used by
// `runLiquidTick` but declared below that marker is a ReferenceError in the rigs and nowhere else — the
// sliced-block boundary, which has now caught this project nine times.
// 🟥 0.25 WAS TOO LOW AND THE SYMPTOM WAS "THE WATER FREEZES", not "the water is slow". The budget's tiers
// degrade in two very different ways: tier 2 lowers K (the sub-step count), which is SMOOTH — water keeps
// moving every tick, just less far. Tier 3 skips the room for whole ticks at a time, up to 1 in 8, which is
// what a player sees as freeze-jump-freeze. Tier 3 only fires when the room's cost at K=1 exceeds the budget,
// so a floor BELOW that cost hands every squeeze to tier 3; a floor above it hands the same squeeze to tier 2.
// With one shared Overworld room that difference is the whole experience — tier 3 rate-limits the ONLY room,
// so every drop of water in the world stutters together. (CLAUDE.md has warned that the tiers assume many
// rooms; this is that warning arriving.)
// ⇒ 0.6 of nominal ≈ 17ms against a measured K=1 cost of ~6-10ms, which keeps the squeeze in tier 2.
// ⚠️ It does mean drain + liquid can exceed the tick when BOTH are saturated. That is deliberate and it is the
// lesser evil: the two shares (24ms drain + 28ms liquid) never did fit in 40ms, and the old code "resolved"
// that by silently disabling the budget entirely.
const BUDGET_FLOOR_FRAC = 0.6;
// How many ticks the floor actually bit, i.e. the drain had eaten the whole nominal budget. A MECHANISM counter:
// if terrain is late and this is climbing, chunk work and liquid are fighting and neither is winning.
let liqBudgetFloored = 0;
// ⭐ "IS ANYBODY ACTUALLY IN THIS WORLD?" — the seam, not the answer.
// Measured (`e2e_containment` A2): ~45s after the last player left the Overworld, the server was still spending
// ~5ms of every tick simulating it, and the room was still flickering on and off the roster. Chunk eviction does
// eventually drain it, but only after a 30s grace, and "eventually" is not the same as "never started".
// ⚠️ A NO-OP THAT IS REASSIGNED BELOW, deliberately — the `wireFanout` idiom (F15). The real test needs
// `roomWhere` and `io`, both declared FURTHER DOWN the file, and every probe rig that slices the tick out would
// get a ReferenceError and nothing else would. Defaulting to "yes, occupied" means a sliced rig behaves exactly
// as it always did, so no existing guard changes meaning.
let roomOccupied = () => true;
// ⚠️ THE SAME NO-OP-AND-REASSIGN SEAM (F15). `PAGE_NO_GEN` lives beside `_miss` in the cell-store block, which
// the rigs that slice the TICK do not contain — a direct reference would be a ReferenceError in them and
// nowhere else. Defaulting to a no-op means a sliced rig behaves exactly as it always did.
let simNoGen = () => {};
// ⭐⭐ THE CHUNK WORK QUEUE (2026-08-08). Producing terrain used to happen SYNCHRONOUSLY inside whichever socket
// handler asked for it, in one uninterruptible turn of the event loop. Measured on the live server: one
// exploring player caused a 152ms stall and twenty caused 466ms, and a single `chunk-want` — whose list is
// CLIENT-SUPPLIED and bounded at 512 — delivered 777,600 cells in one message and stalled the loop 107.8ms with
// generation switched OFF entirely. `_miss` above already records the same shape costing 8,632ms.
// ⇒ the callers now ENQUEUE, and the tick drains up to a millisecond budget. Chunks are drained BEFORE liquid
// and liquid gets what is left, because of the asymmetry the user put plainly: terrain that has not arrived is a
// hole you fall through, while liquid a few hundred ms behind is just slow water.
// ⚠️ THE SAME F15 SEAM AGAIN, and it is load-bearing here: the real function lives in the INTEREST block, which
// the rigs that slice the TICK do not contain. A bare call would be a ReferenceError in them and nowhere else —
// which is exactly how this track has been bitten six times. Returning 0 means a sliced rig gets the old budget
// arithmetic unchanged, so no existing guard changes meaning.
let drainChunkQueue = () => 0;
// ...and the same thing for TIER 2, for the same reason, added 2026-08-02. `probe_budget`'s cold-start check
// asserted "WITH the seed, tick 0 is CHEAPER" by comparing two wall-clock readings — but the effect it is
// testing is ~1ms against several ms of run-to-run spread, so it failed about one run in five REGARDLESS of
// what the code did (measured: 1/5 on the pre-increment tree as well). That is not a guard, it is a coin flip
// wearing one's clothes. The CLAIM is "tier 2 throttled K on the room's first tick", and that is a fact.
let liqK2Throttles = 0;
// ── THE ONE ESTIMATOR. Both the roster planner and tier 2 used to read `roomLiqCost[room] || 0` directly,
// which is why an unmeasured room was treated as FREE by both at once (see liquidCfg.budgetSeed). They now
// share this, so a change to how a room is estimated cannot apply to one and not the other.
function estRoomCost(room) {
  const ema = roomLiqCost[room];
  if (ema) return ema;
  if (!liquidCfg.budgetSeed) return 0;                 // OFF ⇒ byte-for-byte the old behaviour
  const a = cellsOf(room).fineActive;
  return a && a.size ? a.size * liquidCfg.cellCostUs / 1000 : 0;
}
// Stagger for tier 3, so two rate-limited rooms do not pick the same tick and stack their spikes. Any stable
// per-room number does; this is the cheapest one that does not need state.
function roomPhase(room) { let h = 0; for (let i = 0; i < room.length; i++) h = (h * 31 + room.charCodeAt(i)) | 0; return Math.abs(h); }
// ── SECTORS: one room, scheduled in column strips ─────────────────────────────────────────────────────────────
// A room key is a URL, so the separator has to be something a URL cannot contain — written as an ESCAPE, not a
// literal, because a raw NUL byte in the source makes `grep` treat index.js as a binary file (F23).
const SEC_SEP = '\u0000';
const EMPTY_CELLS = [];        // shared stand-in for "this strip has no cells in that registry" — never written to
let liqSecTicks = 0, liqSecDeferred = 0;
let liqSecFallOnly = 0;   // of the deferred strips, how many still got their DESCENT (liquidCfg.fallFirst)
// ⭐⭐ WHICH STRIP, NOT HOW MANY. The three counters above are TOTALS, and a total cannot answer the question
// actually being asked: *"the vertical straight edge in the liquid — is it a strip boundary, with the water on
// one side being ticked and the water on the other being starved?"* That is a question about a LOCATION, so the
// tally has to carry one. room → Map(sector → [ticked, outOfTime, rateLimited, ofThoseStillFell]), reset every
// report window and drawn as an overlay by the client. Costs nothing at all unless the overlay is switched on.
// ⭐⭐ THE TWO THROTTLES ARE COUNTED SEPARATELY AND THAT SEPARATION IS THE WHOLE VALUE OF THIS THING. Lumping
// them as "starved" is what let the missing descent on the tier-3 path hide: the readout said the strip was
// being turned away and the fix for being turned away was demonstrably on, so the two facts sat next to each
// other looking consistent. They were being turned away at a DIFFERENT DOOR. A counter that cannot tell two
// mechanisms apart cannot tell you which one to fix.
const secStatus = new Map();
// ⚠️ `s` IS A SCHEDULING UNIT, NOT NECESSARILY ONE STRIP — strips joined by moving liquid take their turn as
// one (see planRoomSectors), so the column SPAN is recorded alongside the tally. Without it the overlay draws a
// merged group's tally against its lowest strip and paints the rest as idle, which is the opposite of the truth
// and would make the merge look like a bug.
const secNote = (room, s, k, lo, hi) => {
  if (!liquidCfg.strips) return;
  let m = secStatus.get(room); if (m === undefined) secStatus.set(room, m = new Map());
  let a = m.get(s); if (a === undefined) m.set(s, a = [0, 0, 0, 0, lo, hi]);
  a[k]++; a[4] = lo; a[5] = hi;
};
// room → where this room's strip ring starts next tick. See the note at the loop in `liqTickSectors`: without
// it the most expensive strip is cut by the wall-clock stop on every single tick, for ever.
const roomSecCursor = {};
// ⭐⭐ THE WORKING SET FOR ONE SECTOR'S TICK, AND IT REFUSES CELLS THAT ARE NOT ITS OWN.
// 🟥 WITHOUT THIS THE SEAM IS MEASURABLY SPECIAL. A plain Set works and mass is still conserved — but a cell
// woken ACROSS the boundary lands in the working set and is then advanced by all the REMAINING sub-steps of the
// wrong sector's tick, on top of its own sector's tick next round. Measured (probe_sectors E2c): the per-column
// difference beside a boundary was 2.55 against 1.25 elsewhere, i.e. the seam was 2.0x the far field — where a
// genuinely broken boundary (mutation M1) is 4.7x and the per-sub-step-filtered variant is ~1.5x. Diverting on
// WRITE makes it correct by construction rather than by tolerance, and costs one divide and one compare on a
// path that was already a method call.
// ⚠️ `super()` FIRST AND EMPTY, then the bounds, then the cells. `new Set(iterable)` calls `this.add` for every
// element, so handing the cells to `super` would run `add` before `this.lo` existed and divert the whole sector.
class SectorSet extends Set {
  constructor(cells, lo, hi, frows, spill) {
    super();
    this.lo = lo; this.hi = hi; this.frows = frows; this.spill = spill;
    // ⭐ THE STRIP'S BOUNDS IN CELL INDICES, NOT COLUMNS. `add` runs on every wake and every mark — the profile
    // put it at 3.8% of the liquid tick — and it was opening with a FLOAT DIVIDE (`(i / frows) | 0`) purely to
    // recover a column it then compared against two constants. Column-major addressing makes the same test two
    // integer comparisons: `c < lo ⟺ i < lo*frows` and `c > hi ⟺ i >= (hi+1)*frows`, exactly, for any i ≥ 0
    // (and negative i spills under both forms).
    this.loI = lo * frows; this.hiI = (hi + 1) * frows;
    for (const i of cells) super.add(i);
  }
  add(i) {
    if (i < this.loI || i >= this.hiI) { this.spill.push(i); return this; }   // not ours — hand it back to the room
    return super.add(i);
  }
}
// ⭐⭐ EVERY PER-CELL REGISTRY A STRIP'S TURN TOUCHES, IN ONE TABLE.
// 🟥 The failure this whole increment exists to prevent is "sectored here, whole-room there" — a strip's
// chemistry firing, or its sand falling, while its water is frozen for want of budget. That is the same failure
// tier 1 already documents at ROOM granularity ("doing it in the flow loop instead would tick a room's reactions
// without its flow"), and the only defence that does not rot is for the executor never to name a registry
// directly. Bringing a new registry into lockstep is one line here.
// ⚠️ SOURCES ARE NOT IN THIS TABLE — `src` is a Map (cell → {rank, rate}), not a Set, and the source tick
// DELETES from it. It is handled separately below, with its deletions written back.
const SEC_REGS = [
  { f: 'fineActive',   get: fineSet,      drop: dropFineActive, reg: 'fine'   },
  { f: 'fineReact',    get: fineReactSet, drop: dropFineReact,  reg: 'react'  },
  { f: 'fineFire',     get: fineFireSet,  drop: dropFineFire,   reg: 'fire'   },
  { f: 'powderActive', get: powderSet,    drop: dropPowderSet,  reg: 'powder' },
  { f: 'soilActive',   get: soilSet,      drop: dropSoilSet,    reg: 'soil'   },
];
// Bucket a room's work into column strips, and decide the order they get their turn in. Returns null when the
// room is not worth splitting, in which case the caller keeps the ordinary whole-room path.
// ⚠️ PLANNED BEFORE THE TICK'S FIRST PASS RUNS, not inside the flow loop where the split used to live. A
// sectored room now does its sources, chemistry, flow, powder and soil strip by strip, so every whole-room loop
// in the tick has to know to leave it alone BEFORE the first of them runs.
// ⭐ THE ROSTER IS THE UNION OF ALL SIX REGISTRIES, not just the flowing liquid. A strip whose only work is a
// falling grain, a seeded contact or a source must still get a turn, or that work never happens at all.
function planRoomSectors(room) {
  const st = cellsOf(room);
  const W = Math.max(1, liquidCfg.secW | 0), SUB = st.fineSub || 1, FROWS = st.rows * SUB;
  if (!FROWS) return null;
  // ONE pass per registry per tick. Column-major (increment 5), so a cell's column is `i / stride`.
  const secOf = (i) => (((i / FROWS) | 0) / W) | 0;
  const secs = new Set(), buckets = [];
  // ⭐⭐ WHICH STRIPS HAVE MOVING LIQUID TOUCHING THEIR EDGE COLUMNS. Collected in the bucketing pass that was
  // already computing the column, so it costs no extra walk over the active set — which matters, the set runs
  // to tens of thousands of cells under a pour.
  const edgeLo = new Set(), edgeHi = new Set();
  for (let di = 0; di < SEC_REGS.length; di++) {
    const d = SEC_REGS[di], s = st[d.f], m = new Map();
    if (s) for (const i of s) {
      const col = (i / FROWS) | 0, k = (col / W) | 0;
      let a = m.get(k); if (a === undefined) { m.set(k, a = []); secs.add(k); } a.push(i);
      if (di === 0) { const off = col - k * W; if (off === 0) edgeLo.add(k); else if (off === W - 1) edgeHi.add(k); }
    }
    buckets.push(m);
  }
  const srcBySec = new Map();
  if (st.src) for (const i of st.src.keys()) { const k = secOf(i); let a = srcBySec.get(k); if (a === undefined) { srcBySec.set(k, a = []); secs.add(k); } a.push(i); }
  // ⭐⭐ NEVER SPLIT ONE BODY OF MOVING WATER — THIS IS WHAT KILLS THE VERTICAL SEAM.
  // A strip boundary is a scheduling line, and a scheduling line is only VISIBLE where water crosses it: two
  // parcels of the same pool advancing at different rates is a straight vertical edge, which is exactly what was
  // reported. Water that does not cross a boundary cannot show one, however hard the strips on either side are
  // throttled. ⇒ strips joined by moving liquid at their shared edge are scheduled as ONE unit, so anything that
  // can show a seam is always in lockstep with itself, and the unit of scheduling becomes the DISTURBANCE rather
  // than the geometry.
  // ⚠️ THE TEST IS ON *ACTIVE* CELLS, AND THAT IS THE CORRECT CRITERION RATHER THAN A CHEAP APPROXIMATION OF A
  // BETTER ONE. A settled pool spanning a boundary has no active cells there, and a rate difference between two
  // things that are both stationary cannot be seen. Only moving water can show the artefact, so only moving
  // water forces a merge — which also keeps the merges as small as the picture allows.
  // ⚠️ Liquid only (registry 0). Powder and soil do not level sideways, so they have no rate-difference edge to
  // show; making them force merges would cost fairness for an artefact that cannot occur.
  // ⇒ the price is that a big connected disturbance is throttled as one, so it stutters in unison instead of
  // tearing. That is the trade, and it is deliberate: uniform slow water reads as slow water, torn water reads
  // as broken. `liquidCfg.secJoin` turns it off for an A/B.
  const gidOf = new Map();                       // sector → the id of the group it belongs to (its lowest sector)
  const gRange = new Map();                      // group id → [lowest sector, highest sector]
  const _sorted = [...secs].sort((a, b) => a - b);
  for (let n = 0; n < _sorted.length; n++) {
    const s = _sorted[n], prev = n ? _sorted[n - 1] : -2;
    const joined = liquidCfg.secJoin && s === prev + 1 && edgeHi.has(prev) && edgeLo.has(s);
    if (joined) { const g = gidOf.get(prev); gidOf.set(s, g); gRange.get(g)[1] = s; }
    else { gidOf.set(s, s); gRange.set(s, [s, s]); }
  }
  // ⚠️ ONE BUSY GROUP IS JUST THE ROOM. Splitting it buys nothing and costs a Set rebuild, and — more
  // importantly — the whole-room path carries tier 3 (whole-room rate limiting), which a single group still
  // needs. Returning null keeps that behaviour rather than reimplementing it here.
  // ⚠️ Counted on GROUPS, not sectors, now: two strips that have been merged are one unit of work, and running
  // the split path over a single group would be the same room with extra bookkeeping.
  if (gRange.size < 2) return null;
  // Re-key every registry onto the group. Small — one entry per busy strip — and it keeps the executor below
  // ignorant of the merge entirely: it iterates whatever `order` holds and asks `gRange` for the column span.
  if (gidOf.size !== gRange.size) {
    for (let n = 0; n < buckets.length; n++) {
      const m = buckets[n], out = new Map();
      for (const [s, a] of m) { const g = gidOf.get(s); const cur = out.get(g); if (cur === undefined) out.set(g, a); else for (const i of a) cur.push(i); }
      buckets[n] = out;
    }
    const outSrc = new Map();
    for (const [s, a] of srcBySec) { const g = gidOf.get(s); const cur = outSrc.get(g); if (cur === undefined) outSrc.set(g, a); else for (const i of a) cur.push(i); }
    srcBySec.clear(); for (const [g, a] of outSrc) srcBySec.set(g, a);
  }
  // CHEAPEST FIRST. Measured as the load-bearing half: rotation alone admits a sector too big for the budget,
  // which consumes all of it and defers everyone behind it (probe_sectors C1/D1).
  const cost = (k) => { let n = 0; for (const m of buckets) { const a = m.get(k); if (a) n += a.length; } return n; };
  return { W, SUB, FROWS, buckets, srcBySec, gRange, order: [...gRange.keys()].sort((a, b) => cost(a) - cost(b)) };
}
// ⭐ THE PARTITION IS A SET SWAP, NOT A PER-CELL TEST. Each registry is replaced, for the duration of one
// strip's turn, by a set holding only that strip's cells; every tick function runs exactly as it always has and
// none of them ever learns sectors exist. That is what keeps this out of the hot loops — the alternative
// (testing every cell's sector inside the sub-step drain) re-scans the whole active set once per sub-step.
// ⭐⭐ A STRIP TAKES ITS WHOLE TURN, IN THE SAME ORDER THE WHOLE-ROOM TICK USES: sources top up, chemistry runs
// on last tick's movers, water flows, chemistry runs again on the contacts the flow just made, grains fall, soil
// soaks. A strip therefore gets either all of that or none of it, and lockstep is a property of the structure
// rather than of two schedules agreeing.
function liqTickSectors(room, plan, kFull, budgetMs, tickT0, doReact, doSoil) {
  const st = cellsOf(room);
  const { W, SUB, FROWS, buckets, srcBySec, gRange, order } = plan;
  // A unit of scheduling spans one strip, or several if moving liquid joins them (see planRoomSectors). Its
  // column range comes from the plan rather than from `s * W`, which was only ever right for a single strip.
  const _lo = (s) => gRange.get(s)[0] * W;
  const _hi = (s) => gRange.get(s)[1] * W + W - 1;
  const nReg = SEC_REGS.length;
  const saved = [], leftover = [];
  for (let n = 0; n < nReg; n++) { const s = st[SEC_REGS[n].f]; saved.push(s); leftover.push([]); if (s) s.clear(); }
  const savedSrc = st.src;
  // ⭐⭐ WHERE THIS TICK'S STRIPS START. Without it the busiest strip is starved FOR EVER, and it is the exact
  // bug `liqRoomCursor` fixes for rooms and `roomFlowCursor` fixes for the cell queue — arrived a third time.
  // `order` is cheapest-first (measured, load-bearing), and the wall-clock stop below cuts the tail off. So the
  // most expensive strip is always last, always the one cut, and its cells go back on the pile — which makes it
  // MORE expensive next tick, so it sorts even later. A positive feedback loop whose end state is "the water
  // where something is actually happening never moves, while every quiet strip ticks at full rate".
  // ⇒ still cheapest-first, but the ring starts wherever the last tick ran out, so the strip that was cut goes
  // FIRST next time. Same shape as the roster's `_start = liqRoomCursor % _keys.length` immediately above.
  // ⚠️ The cursor is an INDEX into a list that is re-sorted every tick, so it is a rotation and not a promise
  // about a particular strip. That is exactly what the room-level cursor does, and it is enough: what has to be
  // impossible is one strip being last every single tick, not one strip being served in a fixed order.
  const _nSec = order.length;
  const _secStart = _nSec ? (roomSecCursor[room] | 0) % _nSec : 0;
  let _secRan = 0;
  // ⭐⭐ A STRIP THAT IS TURNED AWAY STILL GETS ITS DESCENT. A strip that gets no turn at all stops anything
  // FALLING in it dead in mid-air, and — because the freeze is released in a burst when its turn finally comes
  // round — that is also where the horizontal bands of separated falling packets come from. Falling is the cheap
  // part of a turn and the visually glaring one: water stopped in mid-air is obviously broken, water that levels
  // slowly is not.
  // 🟥🟥 THERE ARE TWO DOORS A STRIP CAN BE TURNED AWAY AT AND THIS GUARDED ONLY ONE. The wall-clock stop is
  // one; TIER 3 (a strip too expensive to fit the budget even at K=1, so it runs one tick in N) is the other,
  // and it was a bare `continue`. That is why "a starved strip still FALLS" looked like it did nothing: it was
  // working, on the door the water was not being turned away at. The strip overlay is what showed it — a strip
  // reading "took 8 · starved 17" with NOT ONE of the 17 having fallen, over a window in which the tick
  // evidently was not running out of time, since the wall-clock door was never reached at all.
  // ⇒ one function, used by both, so a third throttle cannot quietly reintroduce the same gap.
  // ⚠️ ONLY the flow pass, and only its descent — sources, chemistry, powder and soil are still skipped, or this
  // would not be a saving at all. Their cells go back untouched, exactly as before.
  // ⚠️ `fineLiquidTickRoom` puts every cell it processes back in the active set in this mode, so the postponed
  // levelling is postponed rather than lost. That is the invariant to check if liquid ever freezes with it on.
  // ⚠️ Declared OUT of the strip loop: one closure per room per tick rather than one per strip per tick, which
  // is why `s` is a parameter and not a capture.
  // 🟥 …AND THE DESCENT ITSELF HAS A CEILING, because a fall-only pass is cheap and not FREE. Granting one on
  // every turned-away strip is unbounded work: the wall-clock stop turns a strip away and then hands it a pass
  // anyway, so a tick already over its allowance can run one pass per remaining strip and go further over,
  // turning more strips away, each of which is handed a pass. Tier 3 makes that worse by adding a second door.
  // ⇒ the descent is granted only while the tick is inside TWICE its allowance; past that a strip is postponed
  // outright, exactly as it was before. The normal case is unaffected — a tier-3 skip happens long before the
  // wall clock is anywhere near — and the pathological case degrades to the old behaviour instead of spiralling.
  const _fallCeil = budgetMs ? budgetMs * 2 : 0;
  const _starve = (s, why) => {
    const _fc = buckets[0].get(s);
    if (liquidCfg.fallFirst && _fc && _fc.length && (!_fallCeil || performance.now() - tickT0 < _fallCeil)) {
      const d0 = SEC_REGS[0], lo0 = _lo(s), hi0 = _hi(s);
      const saved0 = st[d0.f];
      st[d0.f] = new SectorSet(_fc, lo0, hi0, FROWS, leftover[0]);
      liquidCfg._fallOnly = 1;
      try { fineLiquidTickRoom(room, SUB); } finally { liquidCfg._fallOnly = 0; }
      const after0 = st[d0.f]; if (after0) for (const i of after0) leftover[0].push(i);
      st[d0.f] = saved0;
      for (let n = 1; n < nReg; n++) { const a = buckets[n].get(s); if (a) for (const i of a) leftover[n].push(i); }
      liqSecFallOnly++;
      secNote(room, s, 3, lo0, hi0);
    } else {
      for (let n = 0; n < nReg; n++) { const a = buckets[n].get(s); if (a) for (const i of a) leftover[n].push(i); }
    }
    secNote(room, s, why, _lo(s), _hi(s));
  };
  for (let _sn = 0; _sn < _nSec; _sn++) {
    const s = order[(_secStart + _sn) % _nSec];
    if (budgetMs && performance.now() - tickT0 > budgetMs) {   // out of time: this strip waits for a later tick
      _starve(s, 1);
      liqSecDeferred++;
      continue;
    }
    const key = room + SEC_SEP + s, lo = _lo(s), hi = _hi(s);
    // ⭐⭐ THE PER-SECTOR EMA IS THE MECHANISM. Mutation-tested (probe_sectors part E, M3): using the ROOM's cost
    // here instead doubles the CPU — it is what lets tier 2 throttle K on the expensive strip while the cheap
    // one keeps full K, and no settle-time check can see it break (which is why E3 asserts the CPU directly).
    const fineCells = buckets[0].get(s);
    const est = roomLiqCost[key] || (liquidCfg.budgetSeed && fineCells ? fineCells.length * liquidCfg.cellCostUs / 1000 : 0);
    // ⭐⭐ TIER 3, PER STRIP. This is the whole point of the change: a strip that cannot fit the budget even at
    // K=1 runs on a fixed period instead of every tick, and NOTHING ELSE IN THE WORLD IS AFFECTED. The room-level
    // version of this deferred every strip at once, so a lake being dumped in one place froze water everywhere.
    // ⚠️ PHASED BY THE STRIP, not just by the room, so neighbouring strips take their skipped ticks on DIFFERENT
    // ticks. Phasing them together would make a wide disturbance stutter in unison, which is the symptom this is
    // fixing — it would just be a narrower version of the same bug.
    // ⚠️ `est` is the strip's own EMA, which already exists and is already what tier 2 throttles K against.
    // ⚠️ Its cells are pushed to `leftover` exactly as the out-of-time path above does, so nothing is lost and
    // they are re-bucketed next tick. NOT `continue` before that, or a skipped strip's work is dropped.
    if (budgetMs && liquidCfg.budgetRate && est > 0) {
      const k1 = est / Math.max(1, liquidCfg.budgetKGain);
      if (k1 > budgetMs) {
        const per = Math.max(2, Math.min(liquidCfg.budgetRateMax | 0 || 8, Math.ceil(k1 / budgetMs)));
        if ((liquidTickCount + roomPhase(room) + s * 7) % per !== 0) {
          // 🟥 THIS WAS A BARE `continue` AND THAT IS THE BUG. Tier 3 is the throttle that actually bites under a
          // sustained pour — the wall-clock stop only fires on the tail of a tick, but a strip whose cost is 3×
          // the budget at K=1 is turned away here two ticks in every three, for as long as the pour lasts. Its
          // water therefore stopped, including anything mid-air, and was released in a burst on the third tick:
          // exactly the "separated packets of falling liquid" reported.
          _starve(s, 2);
          liqRateSkips++;
          continue;
        }
      }
    }
    // ⭐ TIER 2. `est` is this STRIP's own EMA and it is normalised to FULL-K cost a few lines below, which is
    // why it clears a whole-tick budget so readily — see the deleted-toggle note beside `budgetKGain`.
    let kUsed = kFull;
    if (budgetMs && kFull > 1 && est > budgetMs) {
      kUsed = Math.max(1, Math.floor(kFull * budgetMs / est));
      liquidCfg.fineLevelSteps = kUsed;
    }
    if (kUsed < liqPerf.kMin) liqPerf.kMin = kUsed;
    const t0 = budgetMs ? performance.now() : 0;
    for (let n = 0; n < nReg; n++) st[SEC_REGS[n].f] = new SectorSet(buckets[n].get(s) || EMPTY_CELLS, lo, hi, FROWS, leftover[n]);
    const srcKeys = srcBySec.get(s);
    st.src = null;
    if (srcKeys && savedSrc) { const m = new Map(); for (const i of srcKeys) if (savedSrc.has(i)) m.set(i, savedSrc.get(i)); if (m.size) st.src = m; }
    // ⚠️ EACH PASS IS GUARDED ON ITS OWN SET BEING NON-EMPTY, and read LIVE rather than from the plan — the flow
    // wakes contacts the post-reaction pass then has to see. It also keeps `sourceTickRoom` unreached when a
    // strip has no sources, which matters beyond speed: `sourceTickRoomFine` lives OUTSIDE the block the probe
    // rigs slice, so calling it there would be a ReferenceError (the sliced-block boundary, eighth time).
    // ⚠️ BRACKETED HERE TOO. A sectored room does all six of its passes inside this loop, which sits BEFORE the
    // top-level `msSince('flow')` — so without this every strip's chemistry, falling sand and soil would be
    // charged to the flow, and the breakdown would say the flow is everything in exactly the case where the
    // scheduler is busiest. Same keys as the whole-room path, so the two are one accounting.
    msSince('flow');
    if (st.src && st.src.size) sourceTickRoom(room);
    msSince('src');
    if (doReact && ((st.fineActive && st.fineActive.size) || (st.fineReact && st.fineReact.size) || (st.fineFire && st.fineFire.size))) fineReactTickRoom(room, SUB);
    msSince('react');
    if (st.fineActive && st.fineActive.size) fineLiquidTickRoom(room, SUB);
    msSince('flow');
    if (doReact && ((st.fineActive && st.fineActive.size) || (st.fineReact && st.fineReact.size) || (st.fineFire && st.fineFire.size))) fineReactTickRoom(room, SUB);
    msSince('react');
    if (st.powderActive && st.powderActive.size) powderTickRoom(room);
    msSince('powder');
    if (doSoil && st.soilActive && st.soilActive.size) soilTickRoom(room);
    msSince('soil');
    // Whatever is STILL moving comes back — including cells this strip woke in a NEIGHBOUR, which is why liquid
    // crossing a boundary needs no special handling. They are bucketed to their own strip next tick.
    // ⚠️ A tick function may have called drop*(), which NULLS the field; null means empty here.
    for (let n = 0; n < nReg; n++) { const after = st[SEC_REGS[n].f]; if (after) for (const i of after) leftover[n].push(i); }
    // Sources are the one registry the tick DELETES from (a source buried by terrain removes itself), so the
    // deletions are written back to the room's real map rather than being thrown away with the strip's copy.
    if (srcKeys && savedSrc) { const m = st.src; for (const i of srcKeys) if (!m || !m.has(i)) savedSrc.delete(i); }
    st.src = savedSrc;                                  // restore before anything else can observe the swap
    if (kUsed !== kFull) { liquidCfg.fineLevelSteps = kFull; liqK2Throttles++; }
    if (budgetMs) { const d = (performance.now() - t0) * (kFull / kUsed); roomLiqCost[key] = roomLiqCost[key] ? roomLiqCost[key] * 0.7 + d * 0.3 : d; }
    liqSecTicks++; _secRan++; secNote(room, s, 0, lo, hi);
  }
  // Advance past whoever actually got a turn, so a strip that was cut off is at the head of the ring next tick.
  // `Math.max(1, …)` guarantees forward motion even on a tick where nothing ran at all.
  if (_nSec) roomSecCursor[room] = (_secStart + Math.max(1, _secRan)) % _nSec;
  // ⚠️ drop*() (called from inside the strip turns) removes the room from the registry the CALLER is iterating.
  // Put each one back if there is still work, or drop it properly if there is not.
  for (let n = 0; n < nReg; n++) {
    const d = SEC_REGS[n], rest = leftover[n];
    st[d.f] = saved[n];
    if (rest.length) { const s = st[d.f] || d.get(room); for (const i of rest) s.add(i); st[d.f] = s; }
    const s = st[d.f];
    if (s && s.size) cellRooms[d.reg].add(room); else if (s) d.drop(room);
  }
  st.src = savedSrc;
  if (savedSrc) { if (savedSrc.size) cellRooms.src.add(room); else dropSrcMap(room); }
}
const runLiquidTick = () => {
  // ⭐⭐ CHUNKS FIRST, AND BEFORE EVERY GUARD BELOW. Three reasons, all of them load-bearing:
  //  1. BEFORE `simNoGen(true)`. That flag makes a page miss return ZEROS instead of building the page (see
  //     `_miss`), which is right for the sim — it must never generate world from inside the flow loop — and
  //     catastrophic here: chunks would be delivered as solid AIR, silently, and nothing would ever correct
  //     them. This is the single easiest way to get this increment badly wrong.
  //  2. BEFORE the `paused` return, so pausing the LIQUID does not also stop the world arriving. Terrain
  //     delivery and fluid simulation are different concerns and the pause switch only ever meant the latter.
  //  3. BEFORE any active-cell Set is iterated. `sendChunkContent` calls `drainGenLiquid`, which SEEDS liquid
  //     into those Sets — the same reason the existing `drainGenLiquid()` call sits at the top rather than in
  //     the middle. Doing this later would mutate a Set the flow loop is walking.
  // ⚠️ The note on `sendChunkContent` used to read "every caller of this function is a socket handler or the
  //    beacon path, never the liquid tick". That is no longer true and the note has been corrected; what makes
  //    it safe is the POSITION, not the caller.
  // ⚠️ NO ARGUMENT, AND THAT IS THE POINT. The first version passed `interestCfg.queueMs` — and `interestCfg`
  // lives in the INTEREST block, which the rigs slicing this tick do not contain, so `probe_budget` died with
  // `ReferenceError: interestCfg is not defined` and nothing else did. Seventh time this track has hit the
  // sliced-block boundary. The seam must own its own configuration: the tick asks for a drain, and how long a
  // drain is allowed to take is a fact about the queue, not about the tick.
  const _chunkMs = drainChunkQueue();
  // FROZEN. Nothing advances — not the grid, not droplets in flight, not powder or soil — until either the pause is
  // lifted or a step is requested, so what you are looking at is exactly what the sim last produced.
  if (liquidCfg.paused) { if (liquidStepsPending <= 0) return; liquidStepsPending--; }
  const _t0 = liquidCfg.perfLog ? performance.now() : 0;
  const _genAtTickStart = genPagesProduced; genMark(); msMark();      // see liqTickGenPages: how much WORLD this tick built
  liquidTickCount++;
  // ⚠️ BUMPED HERE, NOT AT THE POWDER LOOP WHERE IT USED TO LIVE. A sectored room runs its powder inside the
  // flow loop, i.e. BEFORE that loop is reached, and `powderTickRoom` reads this counter for its symmetry
  // breaking — so leaving the bump where it was gave sectored and unsectored rooms different tick numbers in
  // the same tick. Still exactly one bump per tick, so the value every reader sees is unchanged.
  powderTickCount++;
  // ⭐ Phase 6 inc 4b. Chunks produced on demand since the last tick get their liquid HERE, before anything
  // starts iterating an active-cell Set — a page fault can happen from deep inside the flow loop, and seeding
  // writes into the very Set that loop is walking. No-op (one `.size` test) unless on-demand generation is on.
  drainGenLiquid();          // BEFORE the guard: this is the seeding pass for pages already produced
  drainStoredWake();         // …and admit a BOUNDED slice of what that seeding queued (liquidCfg.storedWakeRate)
  simNoGen(true);
  try {
  beginWireBatch();   // ⇓ everything this tick broadcasts is collected and sent as one packet per client (see the hook)
  // ── PLAN THE ROSTER. Admit rooms in rotating order until their predicted cost fills the budget; the rest
  // are deferred whole. At least one room is ALWAYS admitted, so a single room bigger than the whole budget
  // still makes progress (slowly) rather than deadlocking.
  // ⭐ LIQUID GETS WHAT THE CHUNKS LEFT. This is the priority decision, in one line: chunk work is taken off the
  // top and the liquid sim absorbs the variance, because terrain that has not arrived is a hole you fall through
  // while liquid a few hundred ms behind is just slow water.
  // ⚠️ `_chunkMs` is 0 in every rig that slices this block (the F15 seam returns 0), so the budget arithmetic
  // there is byte-for-byte what it was and no existing `probe_budget` check changes meaning.
  // 🟥🟥 AND ZERO USED TO MEAN "UNLIMITED", WHICH IS THE OPPOSITE OF WHAT IT SHOULD MEAN. This was
  // `Math.max(0, …)` and every use downstream was gated on `if (_budgetMs)` — so the moment the chunk drain spent
  // the whole nominal budget (28ms of a 40ms tick, which is exactly what it does while a player streams terrain),
  // this came out as 0, the gate read it as falsy, and the ENTIRE admission block was skipped: no tier 3, no
  // cheapest-first, no deferral. The liquid sim ran completely unbounded at the one moment it most needed
  // bounding, and it fed back — an unbounded sim blows the tick, which keeps terrain late, which keeps the drain
  // saturated, which keeps the budget at zero.
  // MEASURED FROM PLAY (the user's Net tab, three states, and it is the whole diagnosis):
  //     standing still     drain  0/24ms → budget 28ms → sim  0.03ms
  //     moving, no water   drain 28/24ms → budget  0   → sim  0.03ms  (nothing active, so it never showed)
  //     moving over water  drain 28/24ms → budget  0   → sim 93ms avg, 214ms max of a 40ms tick
  // ⇒ the two conditions have to coincide before it is visible, which is why it survived every rig here: a clean
  // test world has no liquid to simulate at the moment the drain is busy.
  // ⭐ "ENABLED" AND "HOW MUCH IS LEFT" ARE NOW SEPARATE QUESTIONS. The gate is the boolean; the number is what
  // the tiers get to spend, and it is FLOORED rather than allowed to reach zero — a true zero would defer every
  // room, which freezes water for as long as anyone is exploring. A quarter of nominal keeps it progressing while
  // still bounding it, which is the whole point of having a budget.
  // ⚠️ `_chunkMs` is 0 in every rig that slices this block (the F15 seam returns 0), so the arithmetic there is
  // byte-for-byte what it was, the floor never binds, and no existing `probe_budget` check changes meaning.
  const _budgetOn = liquidCfg.simBudgetPct > 0;
  const _budgetNominal = liquidCfg.tickMs * liquidCfg.simBudgetPct / 100;
  const _budgetMs = _budgetOn ? Math.max(_budgetNominal * BUDGET_FLOOR_FRAC, _budgetNominal - _chunkMs) : 0;
  if (_budgetOn && _budgetNominal - _chunkMs < _budgetNominal * BUDGET_FLOOR_FRAC) liqBudgetFloored++;
  const _tickT0 = _budgetOn ? performance.now() : 0;
  // ⭐ ALWAYS A SET NOW, not only when the budget is on: an UNATTENDED room is deferred whatever the budget is
  // doing, and every downstream loop already tests `_deferred`, so this reaches sources, reactions, flow, powder
  // and soil in one place rather than five.
  const _deferred = new Set();
  // ⭐⭐ NOBODY IS IN THERE. A world with no players in it must cost NOTHING — the whole point of chunking and the
  // player window. Eviction does drain it, but only after a 30s grace, so until now a world you had left carried
  // on being fully simulated for over half a minute. Deferring it here is immediate and costs one Map lookup.
  // ⚠️ Its liquid is not lost or reset: a deferred room's active set is never read and never cleared, so it
  // resumes exactly where it stopped when somebody walks back in. That is the same contract tiers 1–3 rely on.
  // ⚠️ COUNTED SEPARATELY FROM THE BUDGET'S DEFERRALS, because they mean OPPOSITE things and the readout showed
  // one number for both. "Deferred" from tier 1/3 means the sim cannot keep up — a cost problem. "Deferred"
  // because nobody is in the room means everything is working. A worried-looking `deferred/tick=1` in a test was
  // entirely this, and it sent an investigation after a starvation bug that was not there.
  let _idle = 0;
  for (const r of cellRooms.fine) if (!roomOccupied(r)) { _deferred.add(r); liqIdleSkips++; _idle++; }
  if (liquidCfg.perfLog && _idle > liqPerf.idleRooms) liqPerf.idleRooms = _idle;
  // ⭐⭐ SECTORS ARE PLANNED **BEFORE** THE ROSTER NOW, AND THAT MOVE IS THE WHOLE POINT OF THIS CHANGE.
  // Tier 3 rate-limits a room by skipping it for whole ticks. With one shared Overworld that is every drop of
  // water in the world stuttering together because somebody, somewhere, disturbed something — which is exactly
  // what a shared world must never do, and what the sector split was built to stop. The tiers could not consult
  // the plan while the plan was built after them, so a sectored room was rate-limited whole and its strips never
  // got the chance to be throttled individually.
  // ⚠️ It has to sit AFTER the unoccupied-room pass (whose deferrals are a property of the room, not the budget)
  // and BEFORE the budget roster (whose deferrals are what this replaces). That ordering is the only reason the
  // circularity resolves.
  const _secPlans = new Map();
  if (liquidCfg.secW > 0) for (const room of cellRooms.fine) {
    if (_deferred.has(room)) continue;
    const _p = planRoomSectors(room);
    if (_p) _secPlans.set(room, _p);
  }
  if (_budgetOn) {
    const _keys = [];
    for (const r of cellRooms.fine) {
      if (_deferred.has(r)) continue;
      const _a = cellsOf(r).fineActive; if (!_a || !_a.size) continue;
      // TIER 3 — rate-limit a room that cannot fit even at K=1 (see liquidCfg.budgetRate). Deferring it HERE,
      // in the roster, is what keeps sources, reactions, flow, powder and soil all skipping it together: every
      // one of those loops tests `_deferred`. Doing it in the flow loop instead would tick a room's reactions
      // without its flow. It is also NOT starvation — the room runs on a fixed period, and it is deliberately
      // taken out of `_keys` so the "always admit one room" rule below cannot drag it back in on its off ticks.
      // 🟥 …BUT NEVER FOR A SECTORED ROOM. Deferring one of those defers the ENTIRE WORLD — every strip, every
      // player, everywhere — because the Overworld is a single room. A sectored room carries its own rate
      // limiting per strip inside `liqTickSectors`, against that strip's own measured cost, so a disturbance
      // throttles the water near it and nothing else. Reported from play, and correctly: "we don't want any
      // throttles to affect the entire world; it would be insane to have one person's actions on another part
      // of the world cause lag for a player on the other side."
      if (liquidCfg.budgetRate && !_secPlans.has(r)) {
        const _k1 = estRoomCost(r) / Math.max(1, liquidCfg.budgetKGain);
        if (_k1 > _budgetMs) {
          const _per = Math.max(2, Math.min(liquidCfg.budgetRateMax | 0 || 8, Math.ceil(_k1 / _budgetMs)));
          if ((liquidTickCount + roomPhase(r)) % _per !== 0) { _deferred.add(r); liqRateSkips++; continue; }
        }
      }
      _keys.push(r);
    }
    if (_keys.length) {
      // ⭐ CHEAPEST FIRST, and it is half of the answer to the Overworld's sector problem (measured in
      // `scratchpad/probe_sectors.js`, written up in `scratchpad/phase6_liquid_sectors.md`).
      // Admitting in pure rotation means a room too big for the budget is admitted, consumes ALL of it, and
      // defers everyone behind it — the rotation then hands a cheap room only every other tick. Sorting by
      // predicted cost means a room costing ~nothing is always admitted and the expensive one takes what is
      // left, where tier 3 rate-limits it properly instead of it crowding everyone out.
      // MEASURED: a small puddle sharing the budget with a big spill settles 3.01× slow today. With the world
      // split into sectors but admitted in rotation it is still 2.38× — sectors alone barely help, which was
      // the surprise. Sectors PLUS this is 1.10×.
      // ⚠️ This does NOT help a single room, because one room cannot be sorted (probe_sectors D2). It is
      // useful on its own only where there are already several rooms — which is every page world today.
      // ⚠️ The ROTATION IS KEPT on top of the sort. Sorting alone would starve the expensive tail whenever the
      // cheap head refills the budget; the cursor still advances past whoever was admitted, so the tail keeps
      // its turn. That is what `probe_budget`'s liveness checks (part C) are watching.
      if (liquidCfg.budgetCheapFirst) _keys.sort((x, y) => estRoomCost(x) - estRoomCost(y));
      const _start = liqRoomCursor % _keys.length;
      let _acc = 0, _admitted = 0;
      for (let n = 0; n < _keys.length; n++) {
        const room = _keys[(_start + n) % _keys.length];
        const est = estRoomCost(room);
        // 🟥 …AND NEVER DEFER A SECTORED ROOM WHOLE, for the same reason tier 3 never does (see above). This was
        // the last throttle in the server that could switch off the ENTIRE WORLD at once: with a page room
        // admitted ahead of it, one `_acc + est > _budgetMs` froze every strip of the Overworld for a tick —
        // every player, everywhere — over work happening in one 256-column strip. A sectored room rations
        // itself, strip by strip, against each strip's own measured cost, and its per-strip wall-clock stop is
        // a harder bound than this estimate is. Its `est` still counts toward `_acc`, so the rooms behind it
        // are held back exactly as before.
        if (_admitted > 0 && _acc + est > _budgetMs && !_secPlans.has(room)) { _deferred.add(room); continue; }
        _acc += est; _admitted++;
      }
      liqRoomCursor = (_start + Math.max(1, _admitted)) % _keys.length;
      if ((liquidTickCount & 255) === 0) for (const r in roomLiqCost) if (!cellRooms.fine.has(r)) delete roomLiqCost[r];
    }
  }
  // ⚠️ These room loops used to be `for (… in roomFineActive)` etc. over the old dictionaries. `cellRooms.*` is the
  // same membership in the same first-touch order (see the registries in the cell-store block). Where the body can
  // drop the room it is iterating, the registry is SNAPSHOTTED and re-checked per room, which is exactly what
  // `for…in` did: V8 enumerates a cached key list but re-tests existence before yielding each key.
  // ⭐⭐ SECTORS — PLANNED HERE, BEFORE THE TICK'S FIRST PASS, AND THAT POSITION IS THE POINT.
  // A sectored room does its sources, chemistry, flow, powder and soil STRIP BY STRIP (see `liqTickSectors`), so
  // every whole-room loop below has to know to leave it alone before the first of them runs — otherwise a strip
  // the budget froze still gets its chemistry and its falling sand, which is the exact failure tier 1 documents
  // at room granularity. Every loop below therefore tests `_secPlans` alongside `_deferred`.
  // ⚠️ Only rooms with FLOWING LIQUID are candidates: `cellRooms.fine` is the registry every other one is a
  // subset of in practice, and a room reached only through `src`/`powder` keeps the whole-room path unchanged.
  // ⚠️ `secW = 0` leaves this Map empty and every path below byte-identical to what it always was —
  // `probe_fine_identity` compares 500 ticks against a golden file to prove exactly that.
  // ⚠️ BUILT ABOVE, BEFORE THE BUDGET ROSTER — see the note there. It used to be built here, which is why tier 3
  // could not consult it and rate-limited sectored rooms whole.
  const _secDoSoil = (liquidTickCount & 3) === 0;   // the soil gate, read ONCE so a strip's turn uses the same answer the whole-room loop does
  genSince('drain'); msSince('drain');
  for (const room of Array.from(cellRooms.src)) { if (!cellRooms.src.has(room)) continue; if (_deferred && _deferred.has(room)) continue; if (_secPlans.has(room)) continue; sourceTickRoom(room); }
  genSince('src'); msSince('src');   // sources top up first, so their liquid is ordinary pooled liquid to everything below
  // FINE-CELL liquid (experimental) — a parallel sim in its own arrays, ticked only when liquidCfg.fine.
  // Timed SEPARATELY from the coarse sim so the Perf tab can isolate the fine cost at various fineLevelSteps (K).
  const _fine0 = liquidCfg.perfLog ? performance.now() : 0; let _fineActive = 0;
  // FINE REACTIONS — BEFORE the flow, not after. fineLiquidTickRoom consumes roomFineActive (`Array.from(active);
  // active.clear()`) and only re-adds cells that actually MOVED, so a pair that has come to rest in contact is gone from
  // the set by the time the tick returns — running after would miss every static contact, which is most of them. Run
  // first and the set still holds everything that moved last tick, i.e. exactly the cells whose contacts are new.
  // Rooms with no active liquid still get a pass when a terrain edit seeded them.
  // ⭐ TIMED SEPARATELY FROM THE FLOW, and that separation is the whole lesson of 2026-08-05. The Perf tab
  // reported ONE "liquid/tick" figure spanning pre-reactions + flow + post-reactions, so a reaction pass eating
  // 187ms and starving the flow completely was indistinguishable from a flow costing 187ms. `active=0` next to
  // it looked like an idle room. Two numbers say in one glance what took a whole session to isolate by hand.
  const _react = () => {
    const _rt0 = liquidCfg.perfLog ? performance.now() : 0;
    const _gm = genPagesProduced; _reactInner(); liqGenBy.react += genPagesProduced - _gm; _genMark = genPagesProduced;
    // ⚠️ The chemistry runs TWICE per tick (before the flow on last tick's movers, and after it on the contacts
    // the flow just made), so this accumulates rather than replacing — and the `_msMark` is pushed forward so
    // the flow either side of it is not charged for it.
    msSince('react');
    if (liquidCfg.perfLog) { const _rd = performance.now() - _rt0; liqPerf.reactMs += _rd; if (_rd > liqPerf.reactMsMax) liqPerf.reactMsMax = _rd; }
  };
  const _reactInner = () => {
    const seenRooms = new Set();
    for (const reg of [cellRooms.fine, cellRooms.react, cellRooms.fire])   // a room may be quiet but still have a seeded contact or a burning slick
      for (const room of Array.from(reg)) { if (!reg.has(room) || seenRooms.has(room) || (_deferred && _deferred.has(room)) || _secPlans.has(room)) continue; seenRooms.add(room); fineReactTickRoom(room, cellsOf(room).fineSub || 1); }
  };
  // …and the same closing before the FIRST pass, so the budget roster and the strip planning between the sources
  // and here are charged to the flow they are scheduling rather than to the chemistry that happens to run next.
  msSince('flow');
  if (liquidCfg.reactions) _react();
  for (const room of Array.from(cellRooms.fine)) {
    if (!cellRooms.fine.has(room)) continue;
    // ⚠️ TALLIED BEFORE THE TWO `continue`s BELOW, NOT AFTER — the readout's second lie. This line sat under
    // them, so a room the budget DEFERRED contributed 0 to the "active" figure: the number went quiet exactly
    // when a room was being starved, which is the one state it exists to show. Same mistake as the `pending`
    // block above, in the same tick, fixed there and not here.
    // `peekCells`, not `cellsOf`: a measurement must never create a store for a room that has none.
    if (liquidCfg.perfLog) { const _fa = peekCells(room).fineActive; if (_fa) _fineActive += _fa.size; }
    if (_deferred && _deferred.has(room)) continue;
    // HARD STOP — the guarantee. A room cut here has already had its sources and pre-reactions run but gets
    // no flow this tick; harmless and rare (only when the EMA badly under-predicted), and adding it to
    // _deferred keeps powder in lockstep by skipping it too.
    if (_budgetMs && performance.now() - _tickT0 > _budgetMs) { _deferred.add(room); continue; }
    const _r0 = _budgetMs ? performance.now() : 0;
    // TIER 2 — a room bigger than the WHOLE budget cannot be fixed by deferring other rooms, and skipping
    // it forever would freeze it. Instead cut its sub-steps (K) in proportion: cost is ~linear in K
    // (measured — 18 sub-steps costs ~2× 9), so this bounds one room's tick while degrading it UNIFORMLY.
    // Uniform is the point: fewer sub-steps slows the whole room's liquid evenly, where processing only
    // some of its cells would advance one end of a pool and not the other.
    const _kFull = liquidCfg.fineLevelSteps;
    // ⭐⭐ SECTORS. This room is scheduled in column strips instead of all at once, and the strip's turn covers
    // its sources, chemistry, powder and soil as well as its flow — which is why the loops above and below skip
    // it. Planned before the tick's first pass; `secW = 0` leaves `_secPlans` empty and the code below is
    // exactly what it always was.
    const _plan = _secPlans.get(room);
    if (_plan) { liqTickSectors(room, _plan, _kFull, _budgetMs, _tickT0, !!liquidCfg.reactions, _secDoSoil); continue; }
    let _kUsed = _kFull;
    if (_budgetMs && _kFull > 1) {
      const est = estRoomCost(room);   // ⭐ seeded for a room with no EMA yet — its first tick is its biggest
      if (est > _budgetMs) { _kUsed = Math.max(1, Math.floor(_kFull * _budgetMs / est)); liquidCfg.fineLevelSteps = _kUsed; }
    }
    // 🟥 THE READOUT'S `K` HAS ALWAYS PRINTED THE FULL VALUE, WHICH IS THE ONE NUMBER TIER 2 CHANGES.
    // `liquidCfg.fineLevelSteps` is restored a few lines below, before the perf line is built, so a room being
    // throttled 9 -> 2 still displayed `K=9` — the dial the budget is actually turning was invisible exactly
    // when it was being turned. Same family as the dead `active(peak)` and `emit KB/s` counters.
    if (_kUsed < liqPerf.kMin) liqPerf.kMin = _kUsed;
    fineLiquidTickRoom(room, cellsOf(room).fineSub || 1);
    if (_kUsed !== _kFull) { liquidCfg.fineLevelSteps = _kFull; liqK2Throttles++; }
    // EMA is kept NORMALISED TO FULL K, so a throttled room does not report a small cost, get its K
    // restored, blow the budget again and oscillate.
    if (_budgetOn) { const _d = (performance.now() - _r0) * (_kFull / _kUsed); roomLiqCost[room] = roomLiqCost[room] ? roomLiqCost[room] * 0.7 + _d * 0.3 : _d; }
  }
  // ...and AGAIN after the flow. The pre-pass catches contacts that were already standing (the set still holds last
  // tick's movers); the post-pass catches contacts this tick's movement JUST created, in the same tick. Without it,
  // lava that lands on a partially-filled cell — which lavaBlk stops it entering — would visibly HOVER over the gap
  // for a tick before crusting. The pass is O(active) and does nothing unless lava is actually touching something.
  // 🟥🟥 `msSince('flow')` MUST CLOSE THE FLOW HERE, BEFORE THE SECOND CHEMISTRY PASS. Without it the mark was
  // still sitting where the FIRST chemistry pass left it, so `_react`'s own `msSince('react')` swallowed the
  // entire flow loop and charged it to chemistry: the breakdown read "chemistry 23.43ms (96%) · water 0.05ms
  // (0%)" while the independently-bracketed REACT line on the same panel read 9ms, 38%. Two numbers for one
  // quantity, disagreeing by 14ms, in the readout's first outing — caught because the old measurement was still
  // there to contradict it. A breakdown that cannot be cross-checked against something is worth very little.
  msSince('flow');
  if (liquidCfg.reactions) _react();
  if (liquidCfg.perfLog) { const _fdt = performance.now() - _fine0; liqPerf.fineMs += _fdt; if (_fdt > liqPerf.fineMsMax) liqPerf.fineMsMax = _fdt; if (_fineActive > liqPerf.fineActive) liqPerf.fineActive = _fineActive; }
  // ⭐ HOW MUCH LIQUID IS PENDING, AND WHERE — COUNTED FOR EVERY ROOM, DEFERRED OR NOT.
  // 🟥 Both of the readout's blind spots were the same mistake, made twice: the tallies above only run for a
  // room the flow loop REACHED, so a room that is deferred every tick reports `active=0` and no spread at all.
  // That is precisely the state worth looking at — it is what "the liquid is frozen" IS — and the readout went
  // quiet exactly then. The first version of this spread counter sat inside the flow loop too, and measuring a
  // panning player produced "no samples" for the same reason.
  // Once per report window so a pass over the active set is not on the hot path, and only when perfLog is on.
  // 🟥 THE THIRD LIE, AND THE ONE THE USER HAS BEEN READING ALL ALONG: *"waiting to move jumps between 0 and
  // thousands."* The scan below measures a LEVEL — how much is queued RIGHT NOW — and it was sampled every 32
  // ticks while the report window is `round(1000 / tickMs)` = 25 ticks at the shipping 40ms, which then reset the
  // level to zero. 25 and 32 beat against each other, so about one second in five printed `pending=0` with
  // nothing whatsoever wrong. A zero here reads as "the liquid is done"; it meant "no sample landed in this
  // window", and the two are opposites.
  // ⇒ the sample period IS the report window, so every printed line carries exactly one fresh sample…
  const _perfWin = Math.max(1, Math.round(1000 / Math.max(1, liquidCfg.tickMs | 0)));
  if ((liquidCfg.perfLog || liquidCfg.heat || liquidCfg.strips) && (liquidTickCount % _perfWin) === 0) {
    let _pend = 0, _nch = 0; const _cols = new Set();
    for (const room of cellRooms.fine) {
      const _st = peekCells(room); if (!_st.fineActive) continue;
      const _g = worldGeom(room);
      _pend += _st.fineActive.size;
      // ⭐ COUNT PER CHUNK, not just distinct chunks. "How much work is there and where" is one question, and a
      // per-chunk tally answers it in a payload small enough to send to the client every second — which is what
      // the ACTIVE-CELL HEAT overlay draws. Asked for directly: *"perhaps consider giving me some tools to help
      // diagnose it, like using tools in the inspect portion of the debug menu to see which cells are active."*
      // ⚠️ Counting CHUNKS rather than cells is the whole reason this is affordable. The active set can hold
      // hundreds of thousands of cells; there are only ever a few hundred chunks holding them, so the payload is
      // bounded by the map you can see rather than by how busy it is.
      // 🟥 COUNT COLUMNS, DO NOT MEASURE A RANGE. This used to track min and max column and report the difference
      // as "spanning M columns". That is a RANGE, not an area: two isolated cells at opposite ends of the world
      // span the whole world and occupy nothing. Measured on the live server, the old figure read
      // "24 chunks busy spanning 164,797 columns" — and it is why both the user and I believed the sim was
      // working across the entire Overworld when containment was in fact doing its job (24 busy against ~72
      // resident). A readout that reads catastrophically worse than reality sends every investigation the wrong
      // way, which is exactly what it did.
      const _cnt = new Map();
      for (const i of _st.fineActive) {
        _cols.add((i / _g.rows) | 0);
        const p = geomPage(_g, i); _cnt.set(p, (_cnt.get(p) || 0) + 1);
      }
      _nch += _cnt.size;
      if (liquidCfg.heat) {
        // Flat [chunk, count, chunk, count, …], busiest first, capped — a client only draws what is on screen
        // and an unbounded list would be the one thing this tool must not become: a cost of its own.
        const _top = [..._cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1500);
        const _flat = []; for (const [p, n] of _top) _flat.push(p, n);
        io.to(room).emit('liquid-heat', { chunks: _flat, side: CHUNK_SIDE, cy: _g.cy, total: _st.fineActive.size });
      }
      // ⭐ THE STRIP SCHEDULE, AS A PICTURE. Flat [id, took, outOfTime, rateLimited, fell, firstCol, lastCol, …]
      // over the window just ended, plus the width and sub-division needed to draw the strip grid itself.
      // Self-contained on purpose: the client must be able to draw this without the perf log also being on.
      if (liquidCfg.strips) {
        const _m = secStatus.get(room), _sf = [];
        if (_m) for (const [s, a] of _m) _sf.push(s, a[0], a[1], a[2], a[3], a[4], a[5]);
        io.to(room).emit('liquid-strips', { w: liquidCfg.secW, sub: _st.fineSub || 1, secs: _sf });
      }
    }
    secStatus.clear();   // counters, so the window starts again at zero (see the note beside liqPerf's reset)
    liqPerf.actChunks = _nch;
    liqPerf.actCols = _cols.size;      // DISTINCT columns holding active liquid — an area, comparable to a viewport
    liqPerf.pending = _pend;
    liqPerf.pendAt = liquidTickCount;  // …and the reading is STAMPED, so a stale one can say so instead of reading 0
  }
  genSince('flow'); msSince('flow');
  for (const room of Array.from(cellRooms.powder)) { if (!cellRooms.powder.has(room)) continue; if (_deferred && _deferred.has(room)) continue; if (_secPlans.has(room)) continue; powderTickRoom(room); }   // powder runs in lockstep with liquid → consistent gravity
  genSince('powder'); msSince('powder');
  if (_secDoSoil) for (const room of Array.from(cellRooms.soil)) { if (!cellRooms.soil.has(room)) continue; if (_deferred && _deferred.has(room)) continue; if (_secPlans.has(room)) continue; soilTickRoom(room); }
  if (liquidCfg.perfLog && _deferred) liqPerf.deferred += _deferred.size;
  genSince('soil'); msSince('soil');
  liqTickGenPages += genPagesProduced - _genAtTickStart;
  if (liquidCfg.perfLog) {
    const _dt = performance.now() - _t0; liqPerf.simMs += _dt; if (_dt > liqPerf.simMsMax) liqPerf.simMsMax = _dt;
    liqPerf.chunkMs += _chunkMs; if (_chunkMs > liqPerf.chunkMsMax) liqPerf.chunkMsMax = _chunkMs;
    liqPerf.ticks++;
    if (liqPerf.ticks >= Math.max(1, Math.round(1000 / liquidCfg.tickMs))) {   // ~once per real second
      const _hz = 1000 / liquidCfg.tickMs, _rooms = cellRooms.fine.size;
      // 🟥 `active` USED TO BE A DEAD COUNTER — `_active` was declared at the top of the tick and INCREMENTED
      // NOWHERE, a leftover of the deleted coarse sim, so `active(peak)` printed 0 in every state the server
      // could be in. It is not a number that was sometimes wrong; it was never right. It already cost a
      // diagnosis: the note beside the reaction breakout reads *"the `active(peak) 0` beside it read as an idle
      // room rather than as 'the flow never ran'"* — neither was true, the field was simply dead.
      // It now carries the honest whole-world total (the `pending` gauge below), under its old name because
      // e2e_room_starvation, e2e_containment and probe_liquid_bottleneck all read `.active` off this wire.
      // 🟥 `kbs` WAS COMPUTED FROM `liqPerf.bytes`, WHICH IS INCREMENTED NOWHERE IN THIS FILE. It was read here,
      // reset every window, and never written — so the "emit KB/s" on this console line AND on the client's Perf
      // tab ("broadcast N KB/s x clients = upload") read **0 in every state the server could be in**. Not a
      // number that was sometimes wrong; one that was never right. Third of its family, after `active(peak)` and
      // the `K` above. `fineBytes` IS tallied (see emitFine), and liquid diffs are what the sim broadcasts, so
      // the honest figure is that one. `liqPerf.bytes` is gone rather than left as a zero nobody can spend.
      const _stat = { rooms: _rooms, active: liqPerf.pending, avgMs: +(liqPerf.simMs / liqPerf.ticks).toFixed(2), maxMs: +liqPerf.simMsMax.toFixed(2), kbs: +(liqPerf.fineBytes * _hz / liqPerf.ticks / 1024).toFixed(1), budgetMs: liquidCfg.tickMs,
        // THE CHUNK QUEUE: ms/tick spent building terrain, chunks delivered per second, and how much is waiting.
        // `chunkQMs` against `interestCfg.queueMs` says whether the allowance is the binding constraint; a
        // `chunkQWait` that never falls says the world is arriving more slowly than players are asking for it.
        chunkQMs: +(liqPerf.chunkMs / liqPerf.ticks).toFixed(2), chunkQMaxMs: +liqPerf.chunkMsMax.toFixed(2),
        chunkQSent, chunkQDrains, chunkQDropped, chunkQStale, chunkQBudgetMs: interestCfg.queueMs, chunkQOn: interestCfg.queue ? 1 : 0,
        // ⭐ WHAT A CHUNK IS COSTING RIGHT NOW, and how often the drain still ran past its allowance despite
        // predicting. `chunkQCost` rising is the signal that the world got more expensive to generate; a
        // non-zero `chunkQOverruns` means the prediction is wrong often enough to look at.
        chunkQCost: +chunkCostMs.toFixed(2), chunkQCostHi: +chunkCostHi.toFixed(2), chunkQOverruns, liqWakeSkipped: worldLiquidWakeSkipped,
        // ⭐ THE STORED-LIQUID WAKE, as a rate and a gauge. `liqWakeAdmitted` is how many stored cells were let
        // into the active set this window (a COUNTER, so it resets); `liqWakeQueued` is how many are still
        // waiting right now (a GAUGE, so it does not). A queue that never falls means chunks are faulting in
        // faster than `storedWakeRate` admits them and the rate wants raising.
        liqWakeAdmitted: worldLiquidWakeAdmitted, liqWakeQueued: worldLiquidWakeQueued,
        chunkQWait: chunkQueueDepth(),
        // The K tier 2 actually USED this window (see kMin) — `steps` below is the configured maximum.
        stepsUsed: liqPerf.kMin,
        // SECTORS: how many sector-ticks ran and how many were deferred for want of budget. `secW` 0 = off, and
        // both counters stay at 0 — so a non-zero reading is proof the mechanism fired, not an inference from
        // an outcome (the same reason liqRateSkips and liqK2Throttles exist).
        secW: liquidCfg.secW, secTicks: liqSecTicks, secDeferred: liqSecDeferred, secFallOnly: liqSecFallOnly,
        // ⭐ THE TWO THROTTLES, AS COUNTERS, BECAUSE THE PANEL SHOWED NEITHER. `secDeferred` (above) is the one
        // that IS operating in a sectored world and it was console-only; `k2Throttles` is tier 2, whose stuck
        // `K=9` is what prompted this — a zero here with water plainly moving is the whole diagnosis in one
        // number. `rateSkips` is tier 3. Counters, so they reset per window and read as a rate.
        k2Throttles: liqK2Throttles, rateSkips: liqRateSkips,
        // LIQUID breakout: the flow tick's own ms, its wire KB/s, active-cell peak, mean changed/tick and the K
        // sub-step count — isolated from the whole-tick numbers above, which also carry powder, soil and reactions.
        steps: liquidCfg.fineLevelSteps, fineActive: liqPerf.fineActive, fineAvgMs: +(liqPerf.fineMs / liqPerf.ticks).toFixed(2), fineMaxMs: +liqPerf.fineMsMax.toFixed(2), fineKbs: +(liqPerf.fineBytes * _hz / liqPerf.ticks / 1024).toFixed(1), fineChanged: Math.round(liqPerf.fineChanged / liqPerf.ticks),
        // BUDGET: mean rooms deferred per tick. Non-zero = the budget is biting and liquid is resolving slower
        // than real time somewhere. Zero at rest is the expected state.
        deferred: +(liqPerf.deferred / liqPerf.ticks).toFixed(2), simBudgetPct: liquidCfg.simBudgetPct,
        // …of which THIS many were rooms with nobody in them, which is not the budget biting at all.
        idleRooms: liqPerf.idleRooms,
        // ⭐ REACTIONS, BROKEN OUT. Part of `fineAvgMs` above, not additional to it — the point is to see how
        // much of the "liquid" figure is chemistry rather than flow. Reactions running long is the shape that
        // starves the flow loop's hard stop; `reactSkips` says the per-tick candidate cap is biting.
        reactAvgMs: +(liqPerf.reactMs / liqPerf.ticks).toFixed(2), reactMaxMs: +liqPerf.reactMsMax.toFixed(2),
        reactSkips: liqReactSkips, budgetFloored: liqBudgetFloored,
        // the funnel: candidates → deduped neighbourhood → cells that can actually react → what fired
        reactCand: liqReactCand, reactSeen: liqReactSeen, reactAnchors: liqReactAnchors, reactFired: liqReactFired,
        // ⭐⭐ WHERE THE TICK ACTUALLY WENT, as ms per tick per pass. Sent as a plain object so a pass added later
        // appears without touching the wire. See `liqMsBy` — it is bracketed at exactly the same points as the
        // world-generation accounting, in both the whole-room and the strip-scheduled path.
        msBy: (() => { const o = {}; for (const k in liqMsBy) o[k] = +(liqMsBy[k] / liqPerf.ticks).toFixed(2); return o; })(),
        // the work-queue funnel: examined → actually did something → put back by a neighbour → put back by the cap
        qProcessed: liqQProcessed, qMoved: liqQMoved, qWoken: liqQWoken, qCapped: liqQCapped,
        // the two sideways levelling scans: mean walk length out of LIQUID_LEVEL_SCAN (see liqLvlSteps)
        lvlSteps: liqLvlSteps, lvlRuns: liqLvlRuns, plSteps: liqPlSteps, plRuns: liqPlRuns, scanMismatch: liqScanMismatch,
        tickGenPages: liqTickGenPages, genPages: genPagesProduced, genBy: liqGenBy,
        // WHERE the active liquid is. `actChunks` against the ~150 chunks one player's viewport subscribes to
        // is the whole diagnosis: similar ⇒ the sim is working on what you can see and the COST is the problem;
        // far larger ⇒ containment is the problem and tuning the cost cannot fix it.
        actChunks: liqPerf.actChunks, actCols: liqPerf.actCols, pending: liqPerf.pending,
        // ⭐⭐ WHAT IS ACCUMULATING? The user's argument, and it is a good one: *"if it can do it for several
        // windows worth of movement… then it should just be able to continue doing that indefinitely. Therefore
        // there must be some accumulated inefficiency or baggage."* A RATE problem and a GROWTH problem look
        // identical in a short run and need completely different fixes, so the growth terms are now on the wire
        // rather than being inferred: heap, the resident page count, and the per-chunk RECORDS — which are a
        // `Map` entry per chunk ever touched and, unlike the pages they describe, are **never removed**.
        ...worldGrowth(),
        // How old the reading above is, in ms. Zero every window in normal operation; non-zero means the scan
        // did not run (perfLog toggled mid-window), and the panel says "Ns old" rather than printing a zero.
        pendAgeMs: Math.max(0, (liquidTickCount - (liqPerf.pendAt || 0)) * Math.max(1, liquidCfg.tickMs | 0)) };
      console.log(`[liq-perf] rooms=${_stat.rooms} sim/tick avg=${_stat.avgMs}ms max=${_stat.maxMs}ms  emit=${_stat.kbs}KB/s` +
        (`  |  LIQUID K=${_stat.steps}${_stat.stepsUsed < _stat.steps ? '(used ' + _stat.stepsUsed + ')' : ''} active=${_stat.fineActive} liquid/tick avg=${_stat.fineAvgMs}ms max=${_stat.fineMaxMs}ms emit=${_stat.fineKbs}KB/s changed/tick=${_stat.fineChanged}`) +
        (_stat.secW ? `  |  SECTORS w=${_stat.secW} ticked=${_stat.secTicks} deferred=${_stat.secDeferred}` : '') +
        (_stat.chunkQOn ? `  |  CHUNKQ ${_stat.chunkQMs}ms/tick max=${_stat.chunkQMaxMs} of ${_stat.chunkQBudgetMs}ms · sent=${_stat.chunkQSent} · waiting ${_stat.chunkQWait.chunks} for ${_stat.chunkQWait.socks} client(s)` + (_stat.chunkQDropped ? ` · dropped=${_stat.chunkQDropped}` : '') : '') +
        (`  |  REACT avg=${_stat.reactAvgMs}ms max=${_stat.reactMaxMs}ms capped=${_stat.reactSkips}`) +
        (`  |  SPREAD pending=${_stat.pending} chunks=${_stat.actChunks} cols=${_stat.actCols}`) +
        (_stat.simBudgetPct ? `  |  BUDGET ${_stat.simBudgetPct}% deferred-rooms/tick=${_stat.deferred}` +
          (_stat.idleRooms ? ` (${_stat.idleRooms} unoccupied)` : '') +
          (liquidCfg.budgetRate ? ` tier3-skips=${liqRateSkips}` : '') + (liquidCfg.budgetSeed ? ' seed=on' : '') : '') +
        ` (×clients-in-room = server upload; budget/tick=${_stat.budgetMs}ms)`);
      io.emit('liquid-perf', _stat);                       // mirrored to the Liquid Debug panel so it's visible while testing
      // ⭐ COUNTERS RESET, GAUGES DO NOT. Everything here is a sum or a peak over the window just printed, so it
      // starts again at zero — except `pending`/`actChunks`/`actCols`, which are a snapshot of how much work is
      // queued right now. Zeroing those made "I have no reading" indistinguishable from "there is no work".
      liqPerf = { simMs: 0, simMsMax: 0, ticks: 0, fineMs: 0, fineMsMax: 0, fineActive: 0, fineBytes: 0, fineChanged: 0, deferred: 0, idleRooms: 0, reactMs: 0, reactMsMax: 0,
        chunkMs: 0, chunkMsMax: 0, kMin: liquidCfg.fineLevelSteps,   // kMin is a MINIMUM, so it resets to the ceiling
        actChunks: liqPerf.actChunks, actCols: liqPerf.actCols, pending: liqPerf.pending, pendAt: liqPerf.pendAt };
      // 🟥 …AND THESE TWO WERE NOT, WHICH MADE THEM UNREADABLE. Both were added 2026-08-22 as lifetime totals,
      // so the Net tab showed `budget floored ×945` while the drain sat at 0/24ms and nothing was being floored
      // — a number that only ever goes up cannot say whether the thing is happening NOW, which is the only
      // question either of them exists to answer. Same rule as the block above: counters reset, gauges do not.
      liqBudgetFloored = 0; chunkQOverruns = 0;
      // 🟥🟥 …AND NOR WERE THE THROTTLE COUNTERS, WHICH IS THE ONE QUESTION BEING ASKED OF THEM.
      // "Throttling should be a rare EMERGENCY thing, not something that happens almost every time liquid
      // moves" is a question about a RATE, and every number that could answer it was a lifetime total — so
      // `tier3-skips=41291` was equally consistent with "it fired hard once an hour ago" and "it is firing on
      // every tick right now". Per window, `secDeferred` against `secTicks` reads directly as "this fraction of
      // strip-turns was thrown away", which is the number to judge the throttle by.
      // ⚠️ Safe for the rigs: this whole block only runs with `perfLog` ON, and `probe_budget` explicitly turns
      // it off (it reads the same counters through the sliced module, cumulatively, and still can).
      liqRateSkips = 0; liqK2Throttles = 0; liqSecTicks = 0; liqSecDeferred = 0; liqSecFallOnly = 0; liqReactSkips = 0;
      // Same rule: the per-pass ms are a SUM over the window just reported, so they start again at zero. A
      // lifetime total here would answer "has the chemistry ever been expensive", which nobody is asking.
      for (const k in liqMsBy) liqMsBy[k] = 0;
      // 🟥 …AND SO ARE THE REACTION COUNTERS, WHICH WERE LIFETIME TOTALS ON THE WIRE. `reactCand`/`reactSeen`/
      // `reactAnchors` are what say whether the chemistry is examining a hundred thousand cells to fire nothing,
      // and as running totals since boot they could not: every one of them reads "enormous" after ten minutes
      // of play whatever is happening right now. Third time this file has had to fix exactly this.
      liqReactCand = 0; liqReactSeen = 0; liqReactAnchors = 0;
      for (const k in liqReactFired) delete liqReactFired[k];
      liqQProcessed = 0; liqQMoved = 0; liqQWoken = 0; liqQCapped = 0; worldLiquidWakeAdmitted = 0;
      liqLvlSteps = 0; liqLvlRuns = 0; liqPlSteps = 0; liqPlRuns = 0;
    }
  }
  endWireBatch();   // ⇑ one packet per client for the whole tick. AFTER the perf block so its own emit is not batched.
  } finally { simNoGen(false); }   // a throw must never leave the world un-buildable
};
function restartLiquidLoop() { if (liquidTimer) clearInterval(liquidTimer); liquidTimer = setInterval(runLiquidTick, Math.max(8, Math.min(500, liquidCfg.tickMs | 0))); }
restartLiquidLoop();
// ==LIQUID_TICK_BLOCK_END== (probe_budget.js slices to HERE — it needs runLiquidTick itself, which the
//  narrower ==LIQUID_SIM_BLOCK_END== above deliberately excludes. Stub setInterval when slicing this far.)

// ═══ CHUNK RESIDENCY (SHARED-WORLD.md §7, Phase 3) ══════════════════════════════════════════════════════════════
// Sparse allocation gets a world down to what has been TOUCHED. Residency gets it down to what is NEAR SOMEONE:
// a chunk no player has been near for a while is compacted into a blob and its pages released, and it comes back
// the moment somebody approaches. This is also Phase 1 lever 2 — a lake breached two kilometres away stops costing
// anything, because its cells are no longer in any activity set.
//
// ⚠️ ON since 2026-07-31, after the paged storage layer was verified in-browser and the two things that made
// eviction unsafe were fixed and guarded (probe_chunking G and H):
//   · every whole-world READER now calls materializeRoom first — an evicted chunk reads as zeros, so join replay
//     would have served empty terrain and autosave would have WRITTEN EMPTINESS TO THE DB;
//   · residency is keyed on the VIEWPORT, not the avatar, so cursor mode (no body, free-panned camera) and
//     zoomed-out play hold the right chunks.
// It remains the one part of Phase 3 that is not behaviour-preserving by construction — liquid inside an evicted
// chunk stops flowing until someone returns, which IS the intent (Phase 1 lever 2) but is visible. Toggle it live
// with `chunkEvict` on the liquid-cfg wire; turning it off materialises every room for an A/B.
//
// ⚠️ THE SERVER DOES NOT OTHERWISE KNOW WHERE PLAYERS ARE. The live avatar path is the P2P DataChannel mesh
// (`avt-join`), so positions never reach the server; `roomSim` — the relay — stays dormant until Phase 5. Hence the
// `avt-where` beacon below: a coarse, low-rate position, which is all residency needs and is cheap enough that it
// costs nothing when eviction is off.
// ==CHUNK_RESIDENCY_BLOCK_START== (probe_chunking slices this out — stub MWSim/io when you do)
// ⚠️ THE NO-OP-AND-REASSIGN SEAM (F15), and this is the SEVENTH time this boundary has bitten. `quiesceChunk`
// and `rewakeChunk` live with `evictChunk` in the CELL STORE block, which the rigs that slice RESIDENCY do not
// contain — a direct call is a ReferenceError in probe_chunking and nowhere else, which is exactly how it
// presented. Declared as no-ops here and reassigned just past the end marker, so a sliced rig behaves precisely
// as it did before quiescing existed and no existing check changes meaning.
let quiesceChunkH = () => false, rewakeChunkH = () => false;
const chunkCfg = {
  evict: true,         // master switch (see above); `chunkEvict` on the liquid-cfg wire toggles it live
  // Above this many per-chunk records in a room, the sweep starts dropping the ones that carry no information
  // (see the note where it does). Below it the walk is not worth doing — the whole point is that the map stays
  // small, so the prune should cost nothing in the state it exists to maintain.
  // ⚠️ ON `chunkCfg` RATHER THAN A MODULE CONSTANT, and not for tidiness: the sweep is inside the block
  // probe_chunking slices into a `new Function`, so a constant declared further down the file is a
  // ReferenceError in the rigs and nowhere else. That is the trap the `worldTrace` hook was added for one commit
  // ago — this config object is already inside the slice, so putting it here is the fix rather than a new seam.
  recPruneAt: 2048,
  margin: 2,           // chunks kept resident BEYOND the edge of what a player can see (2 ⇒ 1024px of headroom)
  // ⭐ 30,000 → 10,000 (2026-08-06). The 30s was a guess and it was made when residency still saved wire traffic.
  // It does not any more: increment 3d made re-entry re-send unconditionally, and the measurement is flat —
  // 4,741KB to come back at 30s against 4,527KB at 0s, a difference smaller than the spread within either
  // setting. Now that the WORK is released separately (see quiesce below), the only thing this timer still buys
  // is not having to restore or regenerate a chunk you turn straight back to, which is server CPU on the sweep
  // rather than anything the player waits for. 10s is two sweeps: enough to cover turning around, an eighth of
  // the memory retained for wandering. ⚠️ Not a floor — `chunkGraceMs` on the liquid-cfg wire moves it live.
  graceMs: 10000,      // how long a chunk stays resident after the last player stopped looking near it
  sweepMs: 5000,       // how often residency is recomputed
  // ⭐ SIMULATION IS RELEASED LONG BEFORE MEMORY IS (see quiesceChunk for the measurement that motivated it).
  // 0 = as soon as a sweep finds the chunk out of everyone's view, so within `sweepMs`. `chunkQuiesce` /
  // `chunkQuiesceMs` on the liquid-cfg wire; turning it off restores the old "resident ⇒ simulated" behaviour
  // exactly, which is what makes it A/B-able against the 14.8ms-vs-0.8ms figure.
  quiesce: true,
  quiesceMs: 0,
};
// avRoom → Map(socketId → the chunk rect that socket can see, plus its avatar chunk if it has a body).
// ⚠️ KEYED ON THE VIEWPORT, NOT THE AVATAR — cursor mode has no body and free-pans the camera, and zooming out
// shows more world per screen. See the beacon comment in extension/src/16e_avatars_net.js.
const roomWhere = {};
// ⭐ THE REAL ANSWER for the no-op declared next to `liqRateSkips`. Socket.io room membership is the authority —
// somebody who has joined but not yet sent a viewport beacon is still THERE, and keying only on `roomWhere`
// would leave their world frozen until their first beacon arrived. `roomWhere` is the fallback for anything that
// tracks presence without joining.
simNoGen = (on) => { PAGE_NO_GEN = !!on; };
roomOccupied = (room) => {
  const r = io.sockets.adapter.rooms.get(room);
  if (r && r.size) return true;
  const m = roomWhere[room];
  return !!(m && m.size);
};
function noteWhere(avRoom, sid, v) {
  if (!avRoom || !v) return;
  const span = CHUNK_SIDE * TERRAIN_CELL;
  const x = +v.x, y = +v.y;
  if (!isFinite(x) || !isFinite(y)) return;
  // Clamp the claimed viewport to the world. It is client-asserted and decides how much memory we hold, so a
  // client cannot ask us to make the entire world resident by claiming an enormous screen.
  // 🟥 THIS CLAMPED AGAINST THE PAGE WORLD'S SIZE ON EVERY ROOM. `MWSim.C.WORLD_W/H` are the stage constants
  // (15,360 x 3,240) — but a windowed client in the Overworld reports its WINDOW, which is 8,192 x 4,096, so the
  // height was silently cut to 3,240 and the bottom ~107 rows of the window were held and drawn but never
  // subscribed to: correct when they arrived and stale ever after. Same bug family as SIZE_PRESETS and FLOOR_TOP
  // (a page constant on the Overworld path); the room's own shape is the only right answer.
  // ⚠️ `worldGeom`, NOT `roomDims`. This block is SLICED OUT by probe_chunking (H/I), whose rig injects
  // `worldGeom` and does not know `roomDims` — the sliced-block boundary that has now bitten this track five
  // times. Same answer, and it is already a dependency of the block.
  const _g = worldGeom(avRoom);
  const w = Math.max(0, Math.min(_g.cols * TERRAIN_CELL, +v.w || 0));
  const h = Math.max(0, Math.min(_g.rows * TERRAIN_CELL, +v.h || 0));
  const m = roomWhere[avRoom] || (roomWhere[avRoom] = new Map());
  const rect = {
    cx0: Math.floor(x / span), cy0: Math.floor(y / span),
    cx1: Math.floor((x + w) / span), cy1: Math.floor((y + h) / span),
    ax: isFinite(+v.ax) ? Math.floor(+v.ax / span) : -1,
    ay: isFinite(+v.ay) ? Math.floor(+v.ay / span) : -1,
    // ⭐ …AND THE SAME POSITION IN PIXELS. `ax`/`ay` above are CHUNK coordinates, which is all interest and
    // residency ever needed, but "drop what you were carrying where you left" needs to land within a stride of
    // your feet rather than somewhere inside a 512px chunk. Client-asserted like the rest of the beacon, and
    // that is fine here: the worst a liar can do is drop their OWN belongings somewhere else.
    apx: isFinite(+v.ax) ? Math.max(0, Math.min(_g.cols * TERRAIN_CELL, +v.ax)) : -1,
    apy: isFinite(+v.ay) ? Math.max(0, Math.min(_g.rows * TERRAIN_CELL, +v.ay)) : -1,
  };
  m.set(sid, rect);
  return rect;   // Phase 4 reuses the same parsed rect for interest, so the clamp above applies to both
}
function chunkResidencySweep() {
  if (!chunkCfg.evict) return;
  const _t0 = Date.now();
  let _ev = 0, _qu = 0, _cand = 0, _pr = 0;
  const now = Date.now(), M = Math.max(0, chunkCfg.margin | 0);
  for (const room of Array.from(roomCells.keys())) {
    const s = roomCells.get(room); if (!s || !s.terrain || (s.fineSub || 1) !== 1) continue;
    const geom = worldGeom(room);              // Phase 6: per ROOM — the sweep spans rooms of different shapes
    const ch = chunksOf(room), here = roomWhere[room];
    if (here) for (const sid of Array.from(here.keys())) if (!io.sockets.sockets.has(sid)) here.delete(sid);
    // 1) mark everything anybody can SEE (plus a margin), and fault back in anything that was put away
    const mark = (x0, y0, x1, y1) => {
      for (let gy = Math.max(0, y0); gy <= Math.min(geom.cy - 1, y1); gy++)
        for (let gx = Math.max(0, x0); gx <= Math.min(geom.cx - 1, x1); gx++) {
          const p = gx * geom.cy + gy; ch.at(p).lastNear = now;
          rehydrateChunk(room, p);           // no-op unless this chunk was put away (it checks its own blob)
          rewakeChunkH(room, p);             // …and no-op unless it was QUIESCED (still resident, but not ticking)
        }
    };
    if (here) for (const v of here.values()) {
      mark(v.cx0 - M, v.cy0 - M, v.cx1 + M, v.cy1 + M);
      if (v.ax >= 0) mark(v.ax - M, v.ay - M, v.ax + M, v.ay + M);   // the body too, in case the camera lags it
    }
    // 2) evict what has been out of everyone's radius for longer than the grace period
    // ⚠️ DRIVEN BY THE PAGES THAT EXIST, not by 0..nPages (Phase 6 increment 2). The old loop asked every page in
    // the world whether it had anything to put away — 425,984 questions at 273 domains, almost all answered "no",
    // every 5 seconds. The candidates are exactly the chunks that HAVE a live page, which is what `eachPage`
    // enumerates; a chunk already evicted has no live pages and so is not a candidate, which is correct.
    // Ascending order is preserved (the union is sorted) so eviction order is unchanged.
    const cand = new Set();
    for (const f of CHUNK_CONTENT) { const pa = s[f]; if (pa) pa.eachPage((p) => { cand.add(p); return false; }); }
    _cand += cand.size;
    for (const p of Array.from(cand).sort((a, b) => a - b)) {
      const age = now - ch.peek(p).lastNear;
      if (age > chunkCfg.graceMs) { evictChunk(room, p); _ev++; continue; }
      // ⭐ NOT YET OLD ENOUGH TO PUT AWAY, BUT ALREADY TOO OLD TO SIMULATE. See quiesceChunk: the memory and the
      // CPU are two different questions and only the memory one wants a long grace. At quiesceMs = 0 this fires
      // on the first sweep after a chunk leaves everyone's view, i.e. within `sweepMs`.
      if (chunkCfg.quiesce && age > chunkCfg.quiesceMs) { quiesceChunkH(room, p); _qu++; }
    }
    // ⭐⭐ AND DROP THE RECORDS THAT CARRY NO INFORMATION. `rec` is a Map entry per chunk EVER TOUCHED and was
    // never removed — the one term on this whole track with no ceiling (measured 3,938 → 14,624 over a 500-step
    // traversal, and 6,724 → 7,923 in one session of real play).
    // ⭐ THE PROOF IS ALREADY IN THE FILE: `peek` answers `NO_CHUNK_REC` — a frozen default ChunkRec — for a
    // chunk with no record at all. So a record whose every field is still at its default is BY CONSTRUCTION
    // indistinguishable from having none, and deleting it cannot change a single answer.
    // 🟥 EXCEPT `lastNear`, WHICH IS WHY A NAIVE "all fields default" PRUNE FINDS NOTHING. `mark()` above stamps
    // it on every chunk in view — including the page-free ones (sky costs no pages, `seedEmpty` sees to that) —
    // so every chunk anybody has looked at holds a record for ever on the strength of one timestamp. Those are
    // the bulk of them: the user's session had ~334 chunks with pages against 7,923 records.
    // ⇒ `lastNear` alone is droppable PROVIDED the chunk has no pages, because the only thing that reads it is
    // the eviction test above, and that only ever considers chunks that HAVE pages. The next `mark()` recreates
    // the record with a fresh timestamp, which is the same answer.
    // ⚠️ AN EVICTED CHUNK IS NEVER TOUCHED HERE, and that is the load-bearing exclusion. `gen`, `blob` and
    // `evHash` are how a chunk with no pages comes BACK — drop them and `_miss` reads a default record, decides
    // "evicted, no blob", and restores the chunk as EMPTY. That is Phase 3's worst bug, and it is worth the
    // explicit `ch.evicted[p]` test rather than relying on `gen`/`blob` being set.
    if (ch.rec.size > (chunkCfg.recPruneAt || 2048)) {
      for (const [p, r] of ch.rec) {
        if (ch.evicted[p] || r.blob || r.gen || r.restoring || r.quiet) continue;
        if (r.hash !== 0 || r.stamp !== -1 || r.evHash !== 0 || r.savedHash !== -1) continue;
        let live = false;
        for (const f of CHUNK_CONTENT) { const pa = s[f]; if (pa && pa.pageAt(p)) { live = true; break; } }
        if (live) continue;                     // still resident: `lastNear` is deciding its eviction
        ch.rec.delete(p); _pr++;
      }
    }
  }
  // ⭐ SAME REASONING AS THE WORLD FLUSH'S LOG. This runs on the main loop, so a long sweep is felt as terrain
  // arriving late and is indistinguishable from the chunk queue being slow — which is exactly how the flush
  // hid for as long as it did. After a long traversal a whole exploration's worth of chunks falls out of grace
  // at once, so the burst is proportional to how far the player has been.
  const _ms = Date.now() - _t0;
  if (_ms > 60 || _pr) console.log(`[world] residency sweep took ${_ms}ms — ${_cand} resident, ${_ev} evicted, ${_qu} quiesced`
    + (_pr ? `, ${_pr} empty chunk record(s) pruned` : ""));
}
// ==CHUNK_RESIDENCY_BLOCK_END==
quiesceChunkH = quiesceChunk; rewakeChunkH = rewakeChunk;   // see the seam note at the block start
setInterval(chunkResidencySweep, Math.max(1000, chunkCfg.sweepMs | 0));

// ═══ INTEREST-LIMITED REPLICATION (SHARED-WORLD.md §7, Phase 4) ═════════════════════════════════════════════════
// Residency (Phase 3) decides what the SERVER holds in memory. This decides what each CLIENT is told about, which is
// a different question with a different answer: a chunk can be resident because someone else is standing on it and
// still be of no interest to you.
//
// ⚠️ THE MARGIN IS NOT EVICTION'S MARGIN. `chunkCfg.margin` (2) buys page-fault hysteresis — faulting a chunk back in
// is expensive, so it is worth holding spare ones. A replication margin only has to stay ahead of how far a camera
// can travel between two beacons, and every extra ring is bytes on the wire for every client. MEASURED
// (scratchpad/probe_interest.js): a chunk is 512px and the fastest a camera moves is MAX_VX·60·0.5s = 150px, so one
// ring is 3.4× the headroom needed — and margin 2 delivers about TWICE the bytes of margin 1 for no benefit.
//
// MEASURED SAVING, same probe, a dam break in the real 15360×3240 world replayed against scattered viewers:
// 85–92% of world-diff bytes at zoom 1. Zoomed fully out it falls to ~50%, because the world is only 6.3 chunks
// tall and a zoomed-out viewport genuinely covers half of it. Everyone crowded onto the same disturbance saves
// nothing, which is correct — that is the PLAYER cap's job, not this one's.
//
// ⚠️⚠️ WHAT MADE THIS DANGEROUS, and how it is avoided. Phase 3's worst bug was that an evicted chunk read as ZEROS,
// so "unloaded" was indistinguishable from "empty world" to every reader. Interest-limiting has exactly that shape
// on the CLIENT: a chunk it stops being told about must go STALE, never EMPTY. Two things keep that true:
//   1. THE JOIN REPLAY IS NOT INTEREST-LIMITED. `terrain-init` still sends the whole world, so the client's mirror
//      is complete from the first frame and an unsubscribed chunk is merely out of date. Local collision, the
//      minimap and `chunkHashesClient` all keep working everywhere. (Interest-limiting the join replay is a real
//      further saving, but it needs a per-chunk "unknown" state on the client first — deliberately not in Phase 4.)
//   2. RE-SUBSCRIBING REPAIRS. When a chunk leaves a socket's set its hash is remembered; when it comes back the
//      hash is compared, and if anything moved meanwhile the chunk's content is pushed over the SAME wires
//      chunk-verify already uses. A chunk is therefore only ever stale while it is out of view.
// ⚠️ AND THE THIRD SHAPE — a gate must stay in step with what it guards. The fan-out iterates the ROOM'S SOCKETS,
// not the subscription map, because a socket that has not sent a beacon yet (just joined, old client, cursor mode
// before the first frame) has no entry — and "no entry" must mean EVERYTHING, not NOTHING. Getting that backwards
// would silently freeze a joining client's world, which is the same bug wearing a different hat.
// Send the full current content of some chunks to ONE socket, over the `terrain-set` / `liquid-fine-cells` wires it
// already parses. Factored out of the `chunk-verify` handler, which is what the kickoff meant by extending
// chunk-verify into subscriptions instead of inventing a parallel wire: resync and re-subscribe are the same
// operation — "you may be out of date about these chunks, here is what they hold".
// ⚠️ IT CARRIES A `clear` LIST, AND IT HAS TO. The fine wire only ever names cells that HOLD liquid, so a repair
// built from "here is what this chunk contains" can add liquid but can never remove it — a pool that DRAINED while
// you were away would repair its terrain and leave the water behind as a phantom. That was already true of
// `chunk-verify` (a resync could not undo a disappearance), and it only went unnoticed because chunk-verify runs
// once after a reconnect; re-subscribing runs it constantly. Sending every cell instead would be ~49KB per chunk,
// so the wire says "zero these chunks first" in one number each and then names the survivors.
// ⭐ CHUNK-STREAM TRACING, off unless MW_TRACE_SUBS is set in the environment.
// ⚠️ IT EARNED ITS PLACE. The Overworld's "the world is invisible" bug took most of a session to find by
// reading, and thirty seconds once these four lines existed: they showed the beacon arriving with a correct
// rect, sixteen chunks produced in 20ms, and then EIGHT AND A HALF SECONDS in the readout that follows,
// generating nothing. No amount of staring at the code says that; one timestamp does.
// Hoisted to a const so the hot paths read a boolean rather than doing a property lookup on process.env.
const TRACE_SUBS = !!process.env.MW_TRACE_SUBS;
function sendChunkContent(sock, room, chunks) {
  if (!chunks || !chunks.length) return;
  const _T0 = TRACE_SUBS ? Date.now() : 0;
  const s = peekCells(room); if (!s.terrain) return;
  const geom = worldGeom(room), tc = [], fine = [], dmg = [], mats = roomMats[room] || {};
  // ⭐ PHASE 6 INCREMENT 4b — TWO PASSES, AND THE SPLIT IS LOAD-BEARING.
  // With on-demand production, reading a chunk's terrain is what PRODUCES it, and a freshly produced chunk's
  // liquid is deliberately seeded on a deferred pass (see genSeedFn: seeding from inside a page fault would
  // write into the active-cell Set the flow loop may be iterating). Done in one pass, this function would
  // produce the ground and then read `fineTotal` back as zero on the very same cells — the client would be
  // sent a lake bed with no lake in it, and nothing would ever correct it, because a SETTLED lake broadcasts
  // no diffs. So: produce everything first, let the deferred pass run, then read it all out.
  // ⚠️ `drainGenLiquid` is safe HERE, and what makes it safe changed on 2026-08-08. It used to be "every caller
  // of this function is a socket handler or the beacon path, NEVER the liquid tick". The chunk work queue means
  // the tick IS now a caller — so the guarantee is no longer about WHO calls it but about WHERE: the drain runs
  // at the very top of `runLiquidTick`, before `simNoGen(true)` and before any active-cell Set is iterated.
  // Seeding liquid from inside the flow loop would write into a Set that loop is walking, which is the same
  // hazard `genSeedFn` defers for. Move the drain later in the tick and this breaks. Checked, not assumed.
  for (const p of chunks) {
    restoreChunk(room, p);     // a chunk we are about to READ OUT must not be in a blob NOR dropped-as-pristine
    if (_genRooms.size) s.terrain.g(((((p / geom.cy) | 0) * CHUNK_SIDE) * geom.rows) + (p % geom.cy) * CHUNK_SIDE);
  }
  if (TRACE_SUBS) console.log('[subs] produced ' + chunks.length + ' chunks in ' + (Date.now() - _T0) + 'ms');
  drainGenLiquid();
  if (TRACE_SUBS) console.log('[subs] drained liquid at ' + (Date.now() - _T0) + 'ms, pagesProduced=' + genPagesProduced);
  for (const p of chunks) {
    const c0 = ((p / geom.cy) | 0) * CHUNK_SIDE, r0 = (p % geom.cy) * CHUNK_SIDE;
    for (let lr = 0; lr < CHUNK_SIDE && r0 + lr < geom.rows; lr++)
      for (let lc = 0; lc < CHUNK_SIDE && c0 + lc < geom.cols; lc++) {
        const i = (c0 + lc) * geom.rows + r0 + lr;
        // ⚠️ ONE PAGED READ, NOT TWO. `s.terrain.g(i)` was called here and again inside the damage test below —
        // 4,096 extra two-level page lookups per chunk, on the hottest loop in the send path, for a value that
        // cannot have changed between the two lines.
        const tv = s.terrain.g(i);
        tc.push(i, tv);
        // ⭐⭐ AND THE DAMAGE, which was never sent at all. A cell part-way through being dug carries `hp` on the
        // server and nothing on the client — the client rebuilds its own `terrainHp` from scratch, and a
        // windowed client throws that away the moment the chunk leaves the window. So the two sides' idea of
        // how much life a block has left drifted apart every time anybody walked away: the server would clear a
        // block on the swing the client thought was the first, and the block vanished without warning.
        // ⚠️ SPARSE, not a third value per cell. Damaged cells are rare — a handful per chunk against 4,096 —
        // so this is a short list where widening the main array would cost 50% of every chunk send.
        // ⚠️ ONLY CELLS THAT ARE ACTUALLY PART-DUG — `hp > 0` is not that test. The generator writes FULL hp on
        // every solid cell it makes, so "has hp" is true of nearly the whole world: the first version of this
        // put 85,025 entries on a single chunk send, roughly doubling it. Damaged means hp BELOW the material's
        // strength, which is a handful of cells wherever somebody has been swinging a pick.
        if (s.terrainHp && tv) {
          const h = s.terrainHp.g(i); if (h > 0 && h < matStrengthSrv(mats, tv)) dmg.push(i, h);
        }
        if (s.fineTotal && s.fineTotal.g(i) > 0) fine.push(i);
      }
  }
  if (TRACE_SUBS) console.log('[subs] readout done ' + chunks.length + ' chunks, ' + (tc.length / 2) + ' cells, ' + (Date.now() - _T0) + 'ms, pagesProduced=' + genPagesProduced);
  // ⭐⭐ THE BACKING SLICE — WHAT THE GROUND LOOKED LIKE BEFORE ANYTHING WAS HOLLOWED OUT OF IT.
  //  The client draws it behind every open cell, so a cave reads as a hollow in a solid world rather than a
  //  hole cut through to the sky. It can derive an answer itself from the nearest rock, and does where this is
  //  absent — but a derived answer moves when somebody builds nearby, and it cannot know what was behind a cave
  //  the GENERATOR carved, because that rock was never in the terrain at all.
  //  ⚠️ ONLY THE CELLS THAT WILL ACTUALLY BE DRAWN: uncarved rock where the terrain is now open. A solid cell's
  //  backing is behind its own body and can never be seen, and open sky has nothing behind it — so a chunk of
  //  bedrock and a chunk of sky both send NOTHING, and a pristine underground chunk sends only its caves.
  //  ⚠️ `backingPage` GENERATES rather than reading the store, so this can never fault a page in. Given that
  //  the whole of increment 4b turns on "the only faulting reader is driven by what a player can SEE", a
  //  second reader here that could materialise storage would be the one way to undo it.
  const back = [];
  if (worldCfg.backing) {
    // Same lookup `genVersion` uses, and for the same reason: two generators can be live at once, so which one
    // made this room's ground is a property of the ROOM. `worldgen.js` has no `backingPage` and simply sends
    // nothing, which leaves the client on its derived answer — a graceful degrade, not a hole.
    const g = _genRooms.get(room) || _roomGens.get(room);
    if (g && g.backingPage) {
      const bp = new Uint8Array(CHUNK_SIDE * CHUNK_SIDE);
      for (const p of chunks) {
        bp.fill(0);
        if (!g.backingPage(bp, p, geom)) continue;
        const c0 = ((p / geom.cy) | 0) * CHUNK_SIDE, r0 = (p % geom.cy) * CHUNK_SIDE;
        for (let lr = 0; lr < CHUNK_SIDE && r0 + lr < geom.rows; lr++)
          for (let lc = 0; lc < CHUNK_SIDE && c0 + lc < geom.cols; lc++) {
            const bv = bp[lr * CHUNK_SIDE + lc];
            if (!bv) continue;
            const i = (c0 + lc) * geom.rows + r0 + lr;
            if (s.terrain.g(i) === 0) back.push(i, bv);
          }
      }
    }
  }
  if (tc.length || back.length) {
    const _msg = { cells: tc };
    if (back.length) _msg.back = back;
    if (dmg.length) _msg.dmg = dmg;      // sparse [wireIndex, hpLeft, …] — see the note where it is gathered
    sock.emit('terrain-set', _msg);
  }
  const cells = []; if (fine.length) fineWirePush(room, fine, cells);
  sock.emit('liquid-fine-cells', { sub: 1, cols: geom.cols, cells, clear: chunks.slice() });
  if (TRACE_SUBS) console.log('[subs] ...emitted in ' + (Date.now() - _T0) + 'ms total');
}
// ==INTEREST_BLOCK_START== (probe_subscriptions slices this out — stub io/chunkHash/worldGeom/geomPage when you do)
const interestCfg = {
  chunks: true,        // filter cell-addressed world diffs to the chunks a socket can see
  margin: 1,           // replication rings beyond the viewport (see above — MEASURED, not guessed)
  pushPerBeacon: 16,   // chunks repaired per beacon when re-subscribing; the rest carry over to the next one
  batch: true,         // collect a whole tick's diffs into one packet per client (per-socket opt-in — see below)
  // ── THE CHUNK WORK QUEUE ────────────────────────────────────────────────────────────────────────────────────
  // ⭐ SHIPS ON, which is a deliberate departure from this branch's "anything not behaviour-preserving ships
  // OFF" convention, and the reason is that the thing it replaces is a MEASURED DEFECT rather than a candidate
  // improvement: the synchronous path stalls the event loop for 107–466ms and has already been reported from
  // play as "the world is invisible". Shipping the fix off would mean nobody ever sees it work. `queueMs = 0`
  // restores the old synchronous behaviour exactly, so it is still A/B-able live — same escape hatch, opposite
  // default.
  queue: 1,
  // Per-tick millisecond allowance. Sized from measurement, not taste: a player falling flat out demands
  // 15.5–28.4 chunks/s (`probe_chunk_demand.js`), which at the shipped generator's 0.846ms/chunk is 13–24ms per
  // SECOND — so 6ms per 40ms tick (150ms/s) carries several such players with room to spare, while costing at
  // most 6ms of the 12ms the profile showed genuinely idle. The redesign's 2.9–11.7ms/chunk is the case this
  // number exists for: it makes the queue take longer rather than making the tick take longer.
  // 🟥🟥 SIX WAS SIZED AGAINST A CHUNK COSTING 0.85ms, AND A CHUNK COSTS 20ms. That figure came from
  // `probe_worldgen_cost.js`, which measures `server/worldgen.js` — the ROLLBACK generator. The live path is
  // worldgen2 plus cells/minerals/flora/formations/voids/volcano, and `e2e_fall_latency.js` measured it on the
  // running server at **20.0 ms/chunk**: 0.3 chunks per tick, ~8 chunks/s, against a falling player's demand of
  // 41/s and a diagonal's 59/s. That is the whole of the reported *"I catch up with it and begin falling
  // through nothing"* — five to seven times too slow, which no window size can cover.
  // ⭐ AND THE SERVER WAS 42% IDLE WHILE IT HAPPENED (CPU profile taken during the fall), so this allowance was
  // the binding constraint, not the CPU. Raised with the two costs above it halved: `probe_worldgen` B5a's
  // rule is `queueMs + queueBatch × worstChunk ≤ tickMs`, and at a measured worst band of ~8ms that is
  // 12 + 16 = 28 of 40ms, leaving the liquid sim its usual room on a tick with terrain pending.
  // ⭐⭐ AND 12 WAS STILL THE BINDING CONSTRAINT — a second profile, after the two cost fixes above, showed the
  // server **71% IDLE** while a falling player waited a second for ground. The drain was spending its whole
  // allowance and then the tick sat empty for 28ms. So this is now sized to USE the tick rather than to be
  // polite in it: liquid's budget at line ~4708 is `tickMs × simBudgetPct/100 − _chunkMs`, i.e. it already
  // adapts to whatever chunks took, and chunks only take anything when a player is actually moving into new
  // world. With `queueBatch` at 1 the worst overshoot is ONE chunk (~14ms measured), so 20 + 14 = 34 of a 40ms
  // tick and liquid keeps ~8ms while streaming and its full 28ms the rest of the time.
  // ⭐ 26 SINCE 2026-08-22, and the number that forced it is the fastest travel in the game rather than the
  // fastest FALL. Cursor mode pans at `PAN_SPEED / avZoom` = 28px/frame at the zoom floor, on both axes at once
  // while diagonal — 79 chunks/s against a sustained ~86/s at 20ms, i.e. inside the noise of not keeping up, and
  // measured doing exactly that (arrival climbing 573ms → 3,100ms over 250 steps and still rising). At 26 the
  // ceiling is ~112/s. The client-side diagonal normalisation lands the same blow from the other side (79 → 56).
  // 🟥 IT WENT TO 26 AND THAT WAS OVER THE BOUND — corrected to 22 the same day. `probe_worldgen` B5a requires
  // `queueMs + queueBatch × worstChunk ≤ tickMs`, and it was passing with a 4.3× margin because it times
  // `server/worldgen.js`, the ROLLBACK generator (0.86ms mean / 1.64ms worst) rather than the worldgen2 stack
  // that actually ships (~5.8ms in a batch, ~8ms worst, measured on the running server). On the real numbers
  // 26 + 2×8 = 42ms against a 40ms tick: the property was violated while the guard printed a healthy margin.
  // ⇒ 24 + 2×8 = 40ms, exactly the tick — the most the bound allows at batch 2 and a ~8ms worst chunk. It went
  // to 22 first and play reported the queue getting deeper for it (awaiting 16 → 24), which is the 15% of
  // throughput that costs; 24 gives it back with the bound still satisfied. Throughput ~104 chunks/s against a
  // measured worst-case
  // demand of 49/s (normalised cursor diagonal at the zoom floor), so nothing is given up.
  // ⚠️ FOURTH INSTANCE of a cost figure inherited from the rollback generator on this track alone. B5a now
  // carries a companion (B5a-live) evaluated against the measured live cost.
  // ⚠️ STILL A DIAL, and still the first thing to turn if terrain lags. `queueMs = 0` remains an exact revert
  // to the synchronous path.
  queueMs: 24,
  // Chunks per `sendChunkContent` call while draining. The clock is checked after every batch, so this trades
  // packet count against how far a single batch can overshoot the allowance. ⚠️ ONE CHUNK CANNOT BE
  // INTERRUPTED, so the true overshoot bound is `queueBatch × the cost of the most expensive chunk` — which is
  // why this is small rather than `pushPerBeacon`-sized.
  // ⏭️ DROP THIS TO 2 WHEN THE WORLD REDESIGN LANDS, and do it in the same increment. `probe_worldgen` B5a
  // asserts `queueMs + queueBatch × worstChunk ≤ tickMs`; today's generator has a worst chunk of ~2ms, so 4 sits
  // at 13.9 of 40ms with 4.3× margin. The redesign's worst chunk is 7.2ms ⇒ 34.7 of 40, margin 1.18×, and a
  // single batch then costs ~29ms of a 6ms allowance, which leaves the liquid sim NOTHING on any tick with
  // terrain pending. At 2 the same generator gives 20.4ms (2.4× margin), liquid keeps ~14ms, and sustained
  // throughput is still 50 chunks/s against a measured demand of 28.4 — better on every axis, at the cost of
  // twice the packets. It is not worth changing before then: at today's ~1ms chunks both values deliver the
  // same 8 chunks per drain.
  // ⚠️ WENT 2 → 1 → 2 IN ONE SESSION, AND THE ROUND TRIP IS THE POINT. It was dropped to 1 to bound the
  // overshoot while a chunk cost ~14ms. With `_genMemo` fixed a chunk costs ~5.8ms IN A BATCH and ~9ms alone —
  // batch 1 pays `drainGenLiquid`, the restore loop and two socket emits per chunk, so it is now the more
  // expensive setting as well as the slower one. At 2 the worst overshoot is ~16ms on top of the 20ms
  // allowance, i.e. 36 of a 40ms tick, which is the bound `probe_worldgen` B5a exists to keep.
  // ⭐⭐ 2026-08-22: EVERY PARAGRAPH ABOVE IS NOW HISTORY, BECAUSE THIS IS NO LONGER THE OVERSHOOT MULTIPLIER.
  // `drainChunkQueue` sizes each batch against the time the allowance has left (`fits`), so a batch cannot run
  // past `budgetMs + one chunk` however large this is — the whole reason it was pinned small is gone. It is now
  // a MAXIMUM, not a fixed cost: at the start of a drain a cheap sky chunk allows a dozen and an expensive deep
  // one allows four, and at the end of the allowance both allow one.
  // ⇒ raised, to buy back the throughput that bounding the overshoot cost. The per-chunk overheads the note
  // above names — `drainGenLiquid`, the restore loop, two socket emits — are all per BATCH, so a bigger one is
  // cheaper per chunk. Measured on the diagonal cadence, which is the hardest one in the game.
  queueBatch: 6,
  // Hard ceiling on what one socket may have waiting. `chunk-want` takes a CLIENT-SUPPLIED list, so without
  // this a client could pin unbounded work in the queue. Dropped requests are not lost: the next beacon
  // re-derives what the socket is missing.
  queueMaxPending: 4096,
};
// Mechanism counters — read-only, carried on the cfg wire so a test can assert the queue actually FIRED rather
// than inferring it from an outcome. Same reasoning as `liqRateSkips` and `liqK2Throttles`: this track has been
// bitten repeatedly by a check that measured a result instead of a mechanism.
let chunkQSent = 0, chunkQDrains = 0, chunkQDropped = 0, chunkQCursor = 0;
// ⭐ How many queued chunks were abandoned because the client moved on before they were served. A MECHANISM
// counter, not an outcome one (the same reason liqRateSkips and liqK2Throttles exist): if this is large while
// terrain is arriving late, the queue was doing work nobody wanted any more.
let chunkQStale = 0;
// ⭐⭐ WHAT ONE CHUNK ACTUALLY COSTS, MEASURED WHILE SERVING THEM — the number the drain admits batches against.
// 🟥 THE OLD BOUND WAS A CONSTANT NOBODY RE-MEASURED, AND IT WAS MEASURED ON THE ROLLBACK GENERATOR. `queueMs`
// was set to 24 on the strength of `queueMs + queueBatch × worstChunk ≤ tickMs` with a worst chunk of "~8ms",
// which came from trace lines against `server/worldgen.js` — while `worldCfg.gen2` has been the default since
// 2026-08-10. Measured against the generator that ships, the worst chunk was **13.6ms**, so the shipped setting
// was `24 + 2×13.6 = 51ms of a 40ms tick`: on a tick with terrain pending, the liquid sim was being starved.
// `probe_worldgen2` D2 had been reporting exactly this and failing.
// ⭐ THE FIX IS NOT A SMALLER CONSTANT. A constant has to be sized for the worst chunk in the world, so it
// wastes the allowance on the ordinary ones (the median is a third of the worst). Instead the drain now ASKS
// whether the next batch fits in the time it has left, using what serving chunks has actually been costing.
// That makes the bound `queueMs + ONE chunk` instead of `queueMs + queueBatch × worstChunk`, which is both
// safer and lets the whole allowance be spent.
// ⚠️ Seeded HIGH and moved by an EMA. A cold server that guessed low would admit a full batch on its first
// drain — the one drain where nothing is JIT-warmed and chunks are at their most expensive.
let chunkCostMs = 12;
// ⭐⭐ …AND THE NUMBER THE BATCH IS ACTUALLY SIZED AGAINST, WHICH IS NOT THE MEAN. A mean is the wrong estimator
// for a bound: chunks are cheap in the sky and dear underground, so a run of sky chunks pulls the average down
// and the drain then admits a full batch just as the window reaches the ground — the one moment chunks are
// most expensive. This is a DECAYING HIGH-WATER MARK: it jumps to any expensive reading immediately and leaks
// back down slowly (~2.4s to fall from 13ms to 3ms), so it still adapts to a genuinely cheap region without
// forgetting an expensive one between one drain and the next.
// ⚠️ RESIDUAL, STATED RATHER THAN HIDDEN: this is still a PREDICTION, so a transition from cheap to expensive
// ground inside a single batch can overshoot, and `chunkQOverruns` says it still happens about once per e2e
// run (against about ten times per run when the batch was sized against the mean). The only way to make the
// bound HARD rather than likely is to make `sendChunkContent`'s produce pass interruptible — it is two passes
// today, produce-all then drain then read out, which is precisely why it cannot be stopped half way. Worth
// doing if the counter ever climbs; not worth the contract change for ~1 in 250 drains.
let chunkCostHi = 12;
const CHUNK_COST_DECAY = 0.97;  // per drain
let chunkQOverruns = 0;         // drains that ran past the TICK — the mechanism counter for the residual above
const CHUNK_COST_ALPHA = 0.15;
// The CELL-ADDRESSED wires, and how to walk one record. Anything not listed here is broadcast untouched.
// ⚠️ `liquid-src` is deliberately NOT here. It is a low-rate MARKER toggle with no re-subscribe repair path, so
// filtering it would leave a client permanently wrong about which cells are sources — cost nothing, break something.
const CELL_WIRE = {
  'terrain-set':       () => 2,
  'liquid-fx':         () => 2,
  // [i, repId, flags, mask, ...one amount per set rank bit] — see the WIRE comment in fineLiquidTickRoom.
  'liquid-fine-cells': (a, k) => { let n = 0, m = a[k + 3]; while (m) { n += m & 1; m >>= 1; } return 4 + n; },
};
// avRoom → Map(socketId → { subs: Set<chunk>, pending: Set<chunk> })
// (`mark` — the hash a chunk had when the socket left it — went with increment 3d; see updateSubs.)
const roomSubs = {};
function subsEntry(room, sid) {
  const m = roomSubs[room] || (roomSubs[room] = new Map());
  let e = m.get(sid); if (!e) m.set(sid, e = { subs: new Set(), pending: new Set() });
  return e;
}
function dropSubs(room, sid) { const m = roomSubs[room]; if (m) { m.delete(sid); if (!m.size) delete roomSubs[room]; } }
// Recompute one socket's subscription set from the viewport it just reported, and repair whatever it re-enters.
// Driven by `avt-where`, which is the same signal residency uses — and for the same reason: what has to be
// replicated is what a player can SEE. Cursor mode has no body at all, so an avatar-keyed version would send an
// entire mode's worth of players nothing.
function updateSubs(room, sid, v) {
  if (TRACE_SUBS) console.log('[subs] updateSubs room=' + room + ' chunks=' + interestCfg.chunks + ' rect=' + JSON.stringify(v));
  if (!interestCfg.chunks) return;
  const geom = worldGeom(room), M = Math.max(0, interestCfg.margin | 0);
  const fresh = !roomSubs[room] || !roomSubs[room].has(sid);
  const e = subsEntry(room, sid);
  const want = new Set();
  const add = (x0, y0, x1, y1) => {
    for (let gy = Math.max(0, y0); gy <= Math.min(geom.cy - 1, y1); gy++)
      for (let gx = Math.max(0, x0); gx <= Math.min(geom.cx - 1, x1); gx++) want.add(gx * geom.cy + gy);
  };
  add(v.cx0 - M, v.cy0 - M, v.cx1 + M, v.cy1 + M);
  if (v.ax >= 0) add(v.ax - M, v.ay - M, v.ax + M, v.ay + M);   // the body too, in case the camera lags it
  // ⚠️⚠️ EVERY CHUNK OUTSIDE THE FIRST SUBSCRIPTION IS ALREADY DRIFTING. The client's mirror is complete only at
  // the INSTANT it joins (the join replay is the whole world), and from the first diff onward anything it is not
  // subscribed to goes stale — including chunks it has NEVER been near. Without this, walking into new territory
  // handed back the world as it was at join: liquid frozen mid-flow, and a pool drawn half-current, half-stale
  // across a chunk seam. Reported from play, guarded by probe_subscriptions P. Marking the whole grid is cheap
  // because an absent page folds into the hash as ONE multiply and the results are cached against page revisions
  // (and shared with chunk-verify), so a sparse world costs almost nothing here.
  // 🟥 REPLACED THE `mark` SCHEME OUTRIGHT (Phase 6 increment 3d). It remembered each chunk's hash as the socket
  // left it and re-sent only if the hash had CHANGED by the time it came back. That was correct while every
  // client held the whole world in a flat array — "unchanged" really did mean "you still have it". Increment 3b
  // makes the client's mirror a WINDOW, and a windowed client FORGETS a chunk the moment it leaves: it zeroes the
  // slots so the wrapped-in column cannot read as its neighbour. So "the chunk did not change" now says nothing
  // about whether the client has it, and the old scheme would hand back a permanently empty region.
  // Re-entry therefore always re-sends. It costs bytes that the hash comparison used to save, which is what
  // `pushPerBeacon` is for — and it buys back three things at once:
  //   · the O(nPages) FIRST-VISIT WALK is gone (increment 2 named it as the largest of the three remaining ones),
  //   · so is the Map entry PER PAGE PER SOCKET it built, which is the one that actually bit at Overworld scale,
  //   · and `chunkHash` is no longer called on every chunk in the world every time a socket appears.
  for (const p of want) if (!e.subs.has(p)) e.pending.add(p);   // came back (or arrived): you do not have it, here it is
  e.subs = want;
  // 🟥🟥 …AND FORGET WHAT THE CLIENT HAS ALREADY WALKED AWAY FROM. `pending` was APPEND-ONLY: a chunk asked for
  // and then left behind stayed queued for ever, and because a Set drains in INSERTION order the queue served
  // the OLDEST — i.e. the most stale — requests first, while the ground under the player's feet waited at the
  // back. During fast travel most of the budget went on producing chunks the client had already discarded,
  // whose content `twSetW` then dropped on the floor (`twFromWire` returns -1 for a cell outside the window).
  // Reported from play, from the Net tab this increment added: *"awaiting 269 chunks, oldest 16.9s"* while
  // moving diagonally, rising to 413 — and the user's own reading of it was exactly right: *"if the chunks we
  // are waiting for are no longer onscreen then we probably don't want to be trying to load it."*
  // ⭐ THE BEACON IS THE AUTHORITATIVE STATEMENT OF WHAT THE CLIENT HOLDS, so `subs` is the right filter and
  // this costs one pass over a set that is only large when it is wrong. Deleting from a Set while iterating it
  // is well defined.
  // ⚠️ NOT A THROTTLE AND NOT LOSSY: a chunk dropped here is one the client is no longer subscribed to, and if
  // it comes back the `!e.subs.has(p)` line above re-adds it. Increment 3d already made re-entry unconditional
  // for exactly this reason.
  if (e.pending.size) for (const p of e.pending) if (!want.has(p)) { e.pending.delete(p); chunkQStale++; }
  // ⭐ WITH THE QUEUE ON, THE BEACON DOES NOT PRODUCE ANYTHING — it only records what this socket is owed, and
  // the tick delivers it within a budget. `e.pending` was always the queue; all that changes is who drains it.
  if (e.pending.size && !interestCfg.queue) flushPending(room, sid, e);
}
function flushPending(room, sid, e) {
  if (TRACE_SUBS) console.log('[subs] flush room=' + room + ' sid=' + sid + ' pending=' + e.pending.size);
  const sock = io.sockets.sockets.get(sid); if (!sock) return;
  const take = [];
  for (const p of e.pending) { take.push(p); if (take.length >= Math.max(1, interestCfg.pushPerBeacon | 0)) break; }
  for (const p of take) e.pending.delete(p);
  sendChunkContent(sock, room, take);
}
// ── enqueue, rather than produce ────────────────────────────────────────────────────────────────────────────
// Returns true if the request was queued. False means the queue is off (or unusable for this room), and the
// caller should do what it always did — which is what keeps `queueMs = 0` a true revert rather than a
// degradation.
// ⚠️ Falls back when `interestCfg.chunks` is off, because then `roomSubs` is not maintained at all and there is
// no `pending` set to put anything in. Queueing into a structure nobody drains is how a world goes quietly
// missing.
function queueChunks(room, sid, list) {
  if (!interestCfg.queue || !interestCfg.chunks || !list || !list.length) return false;
  const e = subsEntry(room, sid);
  const cap = Math.max(1, interestCfg.queueMaxPending | 0);
  for (const p of list) {
    if (e.pending.size >= cap) { chunkQDropped++; break; }
    e.pending.add(p);
  }
  return true;
}
// ── THE DRAIN. Called from the top of the liquid tick with a millisecond allowance.
// ⭐ ROUND-ROBIN, ONE BATCH PER SOCKET PER VISIT, with a cursor that survives across ticks. Draining one socket
// to completion before starting the next would let a player who just teleported (hundreds of chunks pending)
// starve everybody else's terrain for as long as it took — the same "one expensive participant crowds out the
// cheap ones" failure the liquid roster planner already solves with cheapest-first admission.
drainChunkQueue = function () {
  const budgetMs = interestCfg.queueMs;
  if (!interestCfg.queue || !(budgetMs > 0)) return 0;
  const t0 = performance.now();
  const jobs = [];
  for (const room in roomSubs) {
    const m = roomSubs[room]; if (!m) continue;
    for (const [sid, e] of m) if (e.pending.size) jobs.push([room, sid, e]);
  }
  if (!jobs.length) return 0;
  chunkQDrains++;
  const batch = Math.max(1, interestCfg.queueBatch | 0);
  let i = chunkQCursor % jobs.length;
  // `jobs.length * 256` is a runaway guard, not a policy — the loop's real exit is the clock or an empty queue.
  let served = 0;
  for (let guard = jobs.length * 256; guard > 0; guard--) {
    const elapsed = performance.now() - t0;
    if (elapsed >= budgetMs) break;
    let at = -1;
    for (let k = 0; k < jobs.length; k++) { const j = jobs[(i + k) % jobs.length]; if (j[2].pending.size) { at = (i + k) % jobs.length; break; } }
    if (at < 0) break;                                    // nothing left anywhere
    const room = jobs[at][0], sid = jobs[at][1], e = jobs[at][2];
    const sock = io.sockets.sockets.get(sid);
    if (!sock) { e.pending.clear(); i = at + 1; continue; }   // gone; the disconnect handler drops the entry
    // ⭐⭐ SHRINK THE BATCH, DO NOT STOP THE DRAIN. The clock was only ever checked BETWEEN batches, so a batch
    // once started ran to completion and the true overshoot was `queueBatch × the most expensive chunk` —
    // 2 × 13.6ms on top of a 24ms allowance, i.e. 51ms of a 40ms tick.
    // 🟥 THE FIRST FIX FOR THAT WAS WRONG AND MEASURABLY SO. It stopped the whole drain as soon as one more
    // chunk would not fit INSIDE the allowance — which throws away the tail of every drain, and because
    // `chunkCostMs` rises fast and falls slowly, ONE expensive chunk pinned it high and the drain then quit at
    // under half its allowance for many ticks afterwards. Measured on the diagonal cadence (the hardest one in
    // the game, and the one that reproduced the original report): arrival p90 **455ms → 1120ms**, while the
    // generator itself had got 32% cheaper. A safety bound that costs 2.5× the latency it was protecting is not
    // a safety bound, and nothing but the end-to-end harness would have said so.
    // ⭐ The allowance is spent in full, exactly as before, and the OVERSHOOT is what is bounded: take only as
    // many chunks as still fit inside `budgetMs + one chunk`. At elapsed ≈ 0 that is the full batch; at the end
    // of the allowance it is one. So the bound is `queueMs + worstChunk` whatever `queueBatch` is, and the
    // throughput is the same as the unbounded version's.
    // ⚠️ ALWAYS AT LEAST ONE. A chunk costing more than the whole allowance must still be served by some tick,
    // or the client waits for ever — a deadlock that would look exactly like the symptom this all exists to fix.
    // ⭐⭐ SIZED AGAINST THE HIGH-WATER, NOT THE MEAN, AND THE MEAN WAS MEASURED — IT OVERRUNS THE TICK.
    // A mean is the wrong estimator for a bound. Serving cached or sky chunks drives `chunkCostMs` down to
    // ~1ms while real ground costs 8-15ms, so the drain would admit a full batch and then spend 6 x 8ms = 48ms
    // of a 40ms tick. Measured, warm, batch 6, three runs a side:
    //     sized against the mean:        diagonal p90 400/465/404ms · ~10 drains per run PAST THE TICK
    //     sized against the high-water:  diagonal p90 495/405/400ms · ~1 drain per run past the tick
    // ⇒ same latency, five to ten times fewer overruns. The high-water costs nothing because it decays: in a
    // genuinely cheap region it leaks down within a couple of seconds and the batches grow again.
    // 🟥 I FIRST RECORDED THE OPPOSITE — "the high-water is 2.6x worse" — FROM A SINGLE COLD RUN. A freshly
    // restarted server holds nothing resident, so every chunk is generated and the harness measures a different
    // system: cold runs of the SAME build scattered 429/686/1105ms while warm runs of it sat at 400-465. Any
    // comparison of two builds here has to be warm-vs-warm, and this file's numbers now are.
    const _cost = Math.max(0.05, chunkCostHi);
    const fits = Math.max(1, Math.floor((budgetMs + _cost - elapsed) / _cost));
    const takeN = Math.min(batch, fits);
    const take = [];
    for (const p of e.pending) { take.push(p); if (take.length >= takeN) break; }
    for (const p of take) e.pending.delete(p);
    // ⚠️ TIMED AROUND THE ACTUAL SEND, because that is what the prediction above has to be about: production,
    // the deferred liquid drain and the readout are all inside it, and a per-chunk figure taken from anything
    // narrower would under-predict exactly on the expensive chunks.
    const b0 = performance.now();
    sendChunkContent(sock, room, take);
    const per = (performance.now() - b0) / take.length;
    // ⭐ RISE FAST, FALL SLOW. An estimate that decays quickly through a run of cheap sky chunks would admit a
    // full batch just as the window reaches the ground — which is the moment chunks are most expensive and the
    // moment the player is most likely to notice a stalled tick. Cheap readings move it gently; an expensive
    // one is believed immediately.
    chunkCostMs = per > chunkCostMs ? per : chunkCostMs + (per - chunkCostMs) * CHUNK_COST_ALPHA;
    if (per > chunkCostHi) chunkCostHi = per;           // ...the high-water rises at once; it decays below
    chunkQSent += take.length;
    served += take.length;
    i = at + 1;                                           // ...and move on, whether or not this socket has more
  }
  chunkQCursor = i;
  const spent = performance.now() - t0;
  // ⚠️ AGAINST THE TICK, NOT THE ALLOWANCE. Running slightly past `queueMs` is by design — the last batch is
  // allowed one chunk of overshoot — so counting that would report a number that is always large and means
  // nothing. What must never happen is the drain eating the whole tick, and that is what this counts.
  if (spent > liquidCfg.tickMs) chunkQOverruns++;
  chunkCostHi *= CHUNK_COST_DECAY;                      // leak back down so a cheap region is eventually noticed
  if (chunkCostHi < 0.05) chunkCostHi = 0.05;
  return spent;
};
// How much is waiting, for the readout. Cheap: the number of SOCKETS with work, not a walk of their sets.
// ⭐ THE GROWTH TERMS, IN ONE PLACE. Everything here is a number that should REACH A CEILING while a player
// travels steadily — a window's worth of pages resident, a bounded queue — except `chunkRecs`, which is a
// record per chunk ever touched and grows without bound. Watching them against arrival latency is what
// separates "the server is slow" from "the server is filling up".
// ⚠️ Cheap enough to sit on a wire that emits every few seconds: two Map `.size` reads, one `eachPage` count
// per content field, and `memoryUsage()`. It is NOT cheap enough for the tick, and is not called from one.
function worldGrowth() {
  let pages = 0, recs = 0, blobs = 0, evicted = 0;
  for (const room of roomCells.keys()) {
    const s = roomCells.get(room); if (!s) continue;
    for (const f of CHUNK_CONTENT) { const pa = s[f]; if (pa) pa.eachPage(() => { pages++; return false; }); }
    const ch = s.chunks;
    if (ch) { recs += ch.rec.size; for (const r of ch.rec.values()) { if (r.blob) blobs++; if (r.gen) evicted++; } }
  }
  const m = process.memoryUsage();
  return { growPages: pages, growRecs: recs, growBlobs: blobs, growEvicted: evicted,
    growHeapMB: +(m.heapUsed / 1048576).toFixed(1), growRssMB: +(m.rss / 1048576).toFixed(1),
    growGenMemo: _genMemo.size };
}
function chunkQueueDepth() {
  let socks = 0, chunks = 0;
  for (const room in roomSubs) { const m = roomSubs[room]; if (!m) continue; for (const e of m.values()) if (e.pending.size) { socks++; chunks += e.pending.size; } }
  return { socks, chunks };
}
// Fan a cell-addressed diff out per socket, each getting only the records inside the chunks it subscribes to.
// Cells are bucketed by chunk ONCE (O(cells)) and each socket then concatenates its own buckets (O(delivered)), so
// this is linear in what actually goes out rather than sockets × cells.
// Split one payload's cells by chunk. `null` means "this cannot be split, send it whole to everyone" — used for
// events with no cell layout, and for a fine payload whose index space is not the terrain one.
// ⚠️ The fine wire carries FINE indices, which equal terrain indices only while SUB === 1 (every caller passes 1).
// If that ever changes the bucketing would be silently wrong, so it declines rather than guesses.
// ⚠️ Takes the ROOM (Phase 6): which chunk a flat index falls in depends on the room's grid shape, and the
// payload only carries `cols` for the fine wire. Bucketing against the wrong shape would file cells under
// chunks nobody is subscribed to — a silent, per-room-shaped version of "the gate out of step with what it
// guards", which is the bug shape that has already cost this track three separate rounds.
function bucketize(room, ev, payload) {
  const step = CELL_WIRE[ev]; if (!step) return null;
  const a = payload.cells; if (!Array.isArray(a) || !a.length) return null;
  const geom = worldGeom(room);
  if (ev === 'liquid-fine-cells' && (payload.cols | 0) !== geom.cols) return null;
  const bucket = new Map();
  for (let k = 0; k < a.length;) {
    const n = step(a, k), i = a[k];
    if (i >= 0 && i < geom.cells) {
      const p = geomPage(geom, i); let b = bucket.get(p); if (!b) bucket.set(p, b = []);
      for (let q = 0; q < n; q++) b.push(a[k + q]);
    }
    k += n;
  }
  return bucket;
}
function sliceFor(payload, bucket, subs) {   // the part of a bucketed payload one subscription set is owed
  let out = null;
  for (const [p, b] of bucket) if (subs.has(p)) { if (!out) out = []; for (let q = 0; q < b.length; q++) out.push(b[q]); }
  return out && { ...payload, cells: out };
}
function interestFanout(room, ev, payload) {
  if (wireBatch) { let l = wireBatch.get(room); if (!l) wireBatch.set(room, l = []); l.push([ev, payload]); return; }
  const here = roomSubs[room];
  const bucket = interestCfg.chunks && here && here.size ? bucketize(room, ev, payload) : null;
  if (!bucket) return io.to(room).emit(ev, payload);
  const members = io.sockets.adapter.rooms.get(room); if (!members || !members.size) return;
  for (const sid of members) {
    const sock = io.sockets.sockets.get(sid); if (!sock) continue;
    const e = here.get(sid);
    if (!e) { sock.emit(ev, payload); continue; }   // ⚠️ no beacon yet ⇒ EVERYTHING (see the gate note above)
    const cut = sliceFor(payload, bucket, e.subs);
    if (cut) sock.emit(ev, cut);
  }
}
// ── PER-TICK BATCHING (§3) ────────────────────────────────────────────────────────────────────────────────────
// One tick's worth of diffs, delivered as ONE packet per client. Without it, per-socket fan-out costs a socket
// write per event per client where the old `io.to(room)` cost one write per event for the whole room — so
// interest-limiting would have traded bytes for syscalls. MEASURED (probe_interest part C): a batched packet costs
// ~10µs regardless of its size up to ~1.5KB, so the number of PACKETS is what matters, not their contents.
// ⚠️ AN OLD CLIENT MUST NOT GO DARK. A page that has not been reloaded since this shipped has no `world-batch`
// handler, and would silently stop receiving the world — which looks exactly like a frozen server. So batching is
// per-socket OPT-IN: a client says `wire-caps {batch:1}` and only then is its traffic wrapped.
let wireBatch = null;
const wireBatchOk = new Set();   // socket ids that have declared they can unwrap a batch
function flushRoomBatch(room, evs) {
  const members = io.sockets.adapter.rooms.get(room); if (!members || !members.size) return;
  const here = interestCfg.chunks ? roomSubs[room] : null;
  const buckets = (here && here.size) ? evs.map(([ev, pl]) => bucketize(room, ev, pl)) : null;
  for (const sid of members) {
    const sock = io.sockets.sockets.get(sid); if (!sock) continue;
    const e = here && here.get(sid);
    // Unsubscribed-but-known socket ⇒ its slice; unknown socket ⇒ everything (the open gate again).
    const mine = [];
    for (let n = 0; n < evs.length; n++) {
      const [ev, pl] = evs[n], bk = buckets && buckets[n];
      if (!e || !bk) { mine.push([ev, pl]); continue; }   // no subs entry, or an unsplittable event
      const cut = sliceFor(pl, bk, e.subs);
      if (cut) mine.push([ev, cut]);
    }
    if (!mine.length) continue;
    if (wireBatchOk.has(sid)) sock.emit('world-batch', { evs: mine });
    else for (const [ev, pl] of mine) sock.emit(ev, pl);
  }
}
// ==INTEREST_BLOCK_END==
// ⇓ the three lines that turn the sim's broadcasts into interest-limited, per-tick-batched fan-out
wireFanout = interestFanout;
// ⚠️ A LEFTOVER BATCH IS FLUSHED, NEVER DISCARDED. runLiquidTick's only early return is above beginWireBatch, so
// the pair is balanced on every normal path — but an exception mid-tick would leave a batch open, and simply
// overwriting it would silently drop diffs the sim had already produced. Delivering them one tick late is strictly
// better than a client whose world quietly stops matching the server's.
beginWireBatch = () => { if (wireBatch) endWireBatch(); if (interestCfg.batch) wireBatch = new Map(); };
endWireBatch = () => { const b = wireBatch; wireBatch = null; if (b) for (const [room, evs] of b) flushRoomBatch(room, evs); };

// ═══ VISIBILITY CAP — which PLAYERS you are told about (SHARED-WORLD.md §3, §7 Phase 4) ═════════════════════════
// Chunk subscriptions above bound WORLD state. This bounds PLAYER state, which is the quadratic one: §3 measured 50
// mutually-visible players at ≈49k msg/s and 200 at ≈800k, and in a page room the mesh makes it worse than that,
// because every pair is a DataChannel rather than a message.
//
// ⚠️ ~40 WAS A PLACEHOLDER AND SO WAS THE METHOD. What the measurement actually said
// (scratchpad/probe_interest.js, part C — real WebSockets carrying socket.io's own framing):
//   · ~100,000 batched sends/s on one core, essentially flat up to ~1.5KB per packet.
//   · With per-tick batching a room costs P × tickrate messages REGARDLESS of the cap, so that ceiling bounds
//     CONCURRENT PLAYERS (~1,000 at 20Hz on a fifth of a core), not the cap.
//   · The cap bounds PACKET SIZE, i.e. per-client bandwidth: 40 peers is 2965 B ⇒ 0.47 Mbit/s at 20Hz, and even
//     160 peers is only 1.9 Mbit/s.
// ⇒ **BANDWIDTH DOES NOT PICK THE NUMBER.** 40 is comfortable and so is twice that. What actually binds in a page
// room is the MESH: a peer is an RTCPeerConnection with two DataChannels, ICE and a keepalive, which is nothing
// like 74 bytes of position. So the cap here is a mesh-degree limit, and the honest position is that the exact
// value is not yet measurable from the server — it wants a browser measurement of peer-connection cost, which is
// Phase 5 territory. It is therefore CONFIGURABLE and ships OFF, with 32 as the default when switched on.
//
// ⚠️ NO MIDDLE TIER YET. §3 wants "nearest N at full rate, the rest degraded to slow updates or an aggregate".
// A page room has no relay to carry a slow tier — positions travel peer-to-peer or not at all — so this is full
// rate or nothing. The degraded tier arrives with Phase 5, which is where it can exist.
// ==PEER_CAP_BLOCK_START==
const peerCfg = {
  cap: 0,              // 0 = OFF. Ships off, like chunkCfg.evict did: turn it on after eyeballing it in-browser.
  friendRings: 6,      // ⭐ a friend counts as this many chunks CLOSER, rather than jumping the queue outright —
  followRings: 3,      //   §3 says favour friends "when they are nearby", so it is a discount, not an override.
  stickyRings: 2,      // hysteresis: someone already meshed is held slightly, or the set flaps at the boundary and
  affinityTtlMs: 60000,//   WebRTC connections are torn down and rebuilt every beacon for no reason at all
};
// discordId → { at, friends:Set, follows:Set }. One query per user per TTL instead of areFriends() per PAIR, which
// at 2Hz over 60 players would be 7,200 SQLite round-trips a second.
const _affinity = new Map();
function affinityOf(discordId) {
  if (!discordId) return null;
  const hit = _affinity.get(discordId);
  if (hit && Date.now() - hit.at < peerCfg.affinityTtlMs) return hit;
  const friends = new Set(), follows = new Set();
  try {
    for (const r of db.prepare(`SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END AS o
                                FROM friends WHERE (from_id=? OR to_id=?) AND status='accepted'`).all(discordId, discordId, discordId)) friends.add(r.o);
    for (const r of db.prepare(`SELECT followee_id AS o FROM follows WHERE follower_id=?`).all(discordId)) follows.add(r.o);
  } catch {}
  const rec = { at: Date.now(), friends, follows };
  _affinity.set(discordId, rec); return rec;
}
// Where a player IS, in chunk coordinates. The avatar point when there is a body, the middle of the viewport when
// there is not — cursor mode has no body at all and must still be placed somewhere sensible.
function anchorOf(room, sid) {
  const w = roomWhere[room] && roomWhere[room].get(sid); if (!w) return null;
  if (w.ax >= 0) return [w.ax, w.ay];
  return [(w.cx0 + w.cx1) / 2, (w.cy0 + w.cy1) / 2];
}
const roomPeers = {};   // avRoom → Map(sid → Set(peer sid)) — the set each socket is currently meshed with
// Score a candidate for `sid`. LOWER IS BETTER; it is a distance in chunks with social discounts applied.
function peerCost(room, sid, aff, cur, other) {
  const a = anchorOf(room, sid), b = anchorOf(room, other);
  // ⚠️ UNKNOWN POSITION ⇒ INCLUDE, never exclude. Someone who has not beaconed yet (just joined, or an older
  // client) has no anchor, and dropping them would make new arrivals invisible to everyone — the same "absent
  // reads as empty" mistake that Phase 3 made with evicted chunks, wearing a player's face.
  if (!a || !b) return -Infinity;
  let d = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const od = socketToDiscordId[other];
  if (aff && od) { if (aff.friends.has(od)) d -= peerCfg.friendRings; else if (aff.follows.has(od)) d -= peerCfg.followRings; }
  if (cur && cur.has(other)) d -= peerCfg.stickyRings;
  return d;
}
function peerSelect(room, sid) {
  const pool = roomAvt[room];
  if (!pool || !peerCfg.cap) return null;                                  // cap 0 ⇒ no selection at all: mesh with everyone
  const cand = [...pool].filter(o => o !== sid);
  if (cand.length <= peerCfg.cap) return new Set(cand);                    // under the cap ⇒ nothing to choose
  const aff = affinityOf(socketToDiscordId[sid]), cur = (roomPeers[room] || new Map()).get(sid);
  cand.sort((x, y) => peerCost(room, sid, aff, cur, x) - peerCost(room, sid, aff, cur, y));
  return new Set(cand.slice(0, peerCfg.cap));
}
// Recompute one socket's peer set and tell it what changed. Driven by the same beacon as everything else.
// ⚠️ THE MESH IS SYMMETRIC EVEN WHEN INTEREST IS NOT. If A wants B, A offers and B answers, so B ends up connected
// to someone outside its own selection. That is deliberate and it is the safe direction: the alternative is A
// seeing B while B cannot see A, which in a game with combat in it is worse than an extra connection.
function updatePeers(room, sid) {
  if (!peerCfg.cap) return;
  const want = peerSelect(room, sid); if (!want) return;
  const m = roomPeers[room] || (roomPeers[room] = new Map());
  const had = m.get(sid) || new Set();
  const add = [...want].filter(p => !had.has(p)), mute = [...had].filter(p => !want.has(p));
  m.set(sid, want);
  if (!add.length && !mute.length) return;
  const sock = io.sockets.sockets.get(sid); if (!sock) return;
  sock.emit('avt-peers', { add, mute });
}
function dropPeers(room, sid) {
  const m = roomPeers[room]; if (!m) return;
  m.delete(sid);
  for (const s of m.values()) s.delete(sid);
  if (!m.size) delete roomPeers[room];
}
// ==PEER_CAP_BLOCK_END==

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SERVER-RELAYED AVATARS (SHARED-WORLD.md §7 Phase 5a)
//
// ⚠️ READ THIS BEFORE ASSUMING THIS IS `roomSim` COMING BACK. IT IS NOT, AND THE DIFFERENCE IS THE
// WHOLE POINT OF THE PHASE. This relay FORWARDS positions that clients own. It does not simulate
// anybody, it does not step MWSim, and nothing here is ever reconciled against. `roomSim` — the
// Stage 1b authoritative re-sim — stays OFF and is not revived. See the Phase 5 decision box in
// SHARED-WORLD.md and the full analysis in scratchpad/phase5_analysis.md.
//
// WHY A RELAY AT ALL, when the P2P mesh works: a mesh cannot interest-limit, because peers connect to
// everyone. The Overworld needs to tell each player about a SUBSET. That is the only thing the mesh
// structurally cannot do, and it is why this exists.
//
// ⭐ WHY IT IS SAFE OVER SOCKET.IO (TCP), which is what shelved `roomSim` in 2026-06 — MEASURED, not
// assumed (scratchpad/probe_phase5_relay.js part C). A relayed position feeds the client's buffered
// INTERPOLATOR, which already renders remotes INTERP_DELAY_MS (100ms) in the past. A TCP retransmit
// costs ~1 RTT, so below ~60ms RTT a head-of-line stall lands INSIDE the buffer and is invisible:
// TCP measured identical to UDP at RTT 20 and 60 even at 5% loss. What TCP genuinely does ruin is
// RECONCILIATION of your own blob — and that is authority's problem, which this file no longer has.
// ⚠️ It degrades at RTT ~120 (a cross-region number). Transport and hosting are the same question;
// when hosting moves, re-measure and — if needed — re-point this behind `AvatarNet` at geckos.io or
// WebTransport. That wrapper exists precisely so this code does not care.
//
// ⚠️ WHY A FIXED-RATE TIMER IS ACCEPTABLE HERE WHEN A 60Hz SIM TICK WAS NOT. The same measurement
// (part A) shows one liquid tick blocks this single thread past a whole snapshot interval at ~2,911
// active cells, which ordinary play reaches. A 60Hz AUTHORITATIVE tick cannot survive that, because a
// late snapshot is a stale correction. A late FORWARD is just a packet arriving inside a 100ms buffer.
// So the relay is allowed to be jittery, and deliberately runs at 20Hz rather than 60.
// ==RELAY_BLOCK_START==
const relayCfg = {
  on: 0,          // 0 = OFF. Ships off like chunkEvict and peerCap did. Page rooms keep the P2P mesh.
                  // ⚠️ GLOBAL FOR NOW. Phase 6 makes this PER-ROOM (Overworld relayed, page rooms meshed);
                  //    the seam for that is already right — the client is told which transport to use by
                  //    the server in `avt-joined`, so the decision is server-side from day one.
  hz: 20,         // forward rate. NOT a simulation rate; nothing here steps.
  cap: 32,        // full-rate visibility cap. ⭐ UNLIKE peerCfg.cap THIS DEFAULTS ON, and the number is
                  //   measured rather than guessed: over a mesh a peer costs an RTCPeerConnection, which
                  //   is unmeasurable from the server (hence peerCfg.cap = 0). Over a relay there are no
                  //   peer connections, only messages, so the budget is per-player DOWNSTREAM bandwidth:
                  //   cap 32 = 3,059 B/packet = 0.49 Mbit/s at 20Hz. Cap 128 would be 2.93 Mbit/s, which
                  //   is not reasonable for an extension on someone's ordinary connection.
  farHz: 4,       // ⭐ §3's DEGRADED MIDDLE TIER, which Phase 4 could not build: "nearest N at full rate,
  farCap: 96,     //   the rest on slow updates". Peers ranked beyond `cap` are still sent, at farHz, up to
                  //   farCap of them. farHz 0 ⇒ no middle tier (drop them outright, Phase 4's behaviour).
};
// avRoom → Map(sid → motion payload). The LATEST position only: this is a relay, not a queue — a
// superseded position has no value and buffering them would just add latency.
const roomPos = {};
// avRoom → Map(sid → { username, fill }). ⚠️ IDENTITY IS NOT MOTION AND MUST NOT RIDE THE POSITION
// PACKET. The P2P sender puts `username` and `fill` (which can carry an imageUrl) in EVERY message at
// 50Hz — free-ish peer-to-peer, but over a relay that is server egress multiplied by the cap. So it is
// sent once at join, held here, and replayed to joiners.
const roomProfile = {};
// avRoom → Map(receiverSid → Map(peerSid → the `_q` that receiver has already been sent for that peer)).
// This is what makes the fan-out send only NEW samples; see the `take` closure in runRelayTick.
const roomAck = {};

// Rank everyone else for `sid` and split into the full-rate set and the degraded set. Reuses the Phase 4
// scoring wholesale — `peerCost` (distance in chunks, with friendship as a DISCOUNT on distance rather
// than an override, plus stickiness) and `affinityOf`'s cached lookups. Only the CONSEQUENCE differs:
// Phase 4 turned this into WebRTC offers, and here it picks who goes in the outgoing packet.
// ⚠️ `cur` is deliberately null: stickiness exists to stop a WebRTC mesh being torn down and rebuilt at
// the boundary. A relay has nothing to tear down, so holding a stale peer would be pure lag.
function relaySelect(room, sid) {
  const pool = roomAvt[room];
  if (!pool) return { near: [], far: [] };
  const cand = [...pool].filter(o => o !== sid);
  if (!relayCfg.cap || cand.length <= relayCfg.cap) return { near: cand, far: [] };
  const aff = affinityOf(socketToDiscordId[sid]);
  cand.sort((x, y) => peerCost(room, sid, aff, null, x) - peerCost(room, sid, aff, null, y));
  return {
    near: cand.slice(0, relayCfg.cap),
    far: relayCfg.farHz > 0 ? cand.slice(relayCfg.cap, relayCfg.cap + relayCfg.farCap) : [],
  };
}

let relayTimer = null, relayTickCount = 0;
function runRelayTick() {
  if (!relayCfg.on) return;
  relayTickCount++;
  const farEvery = relayCfg.farHz > 0 ? Math.max(1, Math.round(relayCfg.hz / relayCfg.farHz)) : 0;
  const sendFar = farEvery > 0 && (relayTickCount % farEvery === 0);
  for (const room of Object.keys(roomPos)) {
    const pos = roomPos[room];
    if (!pos || !pos.size) continue;
    // ⚠️ ITERATE THE ROOM'S SOCKETS, NOT `roomPos`. Bug shape #3 (a gate out of step with what it
    // guards) bit Phases 3 and 4 four separate times, always this way round. Someone who has JOINED
    // but not yet sent a position has no `roomPos` entry and must still RECEIVE — otherwise a joiner
    // sees a frozen world until they happen to move.
    const acks = roomAck[room] || (roomAck[room] = new Map());
    for (const sid of roomAvt[room] || []) {
      const sock = io.sockets.sockets.get(sid);
      if (!sock) continue;
      const sel = relaySelect(room, sid);
      const seen = acks.get(sid) || (acks.set(sid, new Map()), acks.get(sid));
      const a = [];
      // 🟥 ONLY SEND WHAT HAS CHANGED FOR THIS RECEIVER — a fix, and the reason is not bandwidth.
      // Re-sending an unchanged record every tick republishes the SAME sender timestamp 20×/second, and
      // the client pushes each one into the interpolation buffer (`av.buf.push({ t: m.t, … })`). A player
      // who has stopped sending — tabbed out, idle, or mid-disconnect — therefore floods a 90-entry buffer
      // with identical-timestamp samples, which is not a timeline the interpolator can play: `latestT`
      // stops advancing while the playhead keeps moving, so it thrashes against INTERP_RESYNC_MS.
      // ⚠️ "Changed since last tick" alone would be bug shape #1 (absent reads as empty): a receiver who
      // has never been told about a peer must still get them. Hence per-PAIR versions — no entry ⇒ send.
      const take = (other) => {
        const p = pos.get(other); if (!p) return;
        if (seen.get(other) === p._q) return;      // this receiver already has this exact sample
        seen.set(other, p._q); a.push(p);
      };
      for (const other of sel.near) take(other);
      if (sendFar) for (const other of sel.far) take(other);
      // Forget peers this receiver can no longer see, so the map cannot grow without bound as players
      // move around; they are re-sent in full the moment they come back into view.
      if (seen.size > (relayCfg.cap || 64) + relayCfg.farCap + 16) {
        const keep = new Set([...sel.near, ...sel.far]);
        for (const k of seen.keys()) if (!keep.has(k)) seen.delete(k);
      }
      if (a.length) sock.emit('avt-batch', { t: Date.now(), a });
    }
  }
}
function restartRelayLoop() {
  if (relayTimer) clearInterval(relayTimer);
  relayTimer = relayCfg.on ? setInterval(runRelayTick, Math.max(20, Math.min(500, Math.round(1000 / relayCfg.hz)))) : null;
}
// Record one socket's latest position. `id` is stamped in HERE rather than trusted from the client:
// over P2P the DataChannel identifies the sender implicitly, and a relay must not let a client label
// its packets with somebody else's id.
//
// 🟥 PASS-THROUGH, NOT A WHITELIST — AND THIS IS A FIX, NOT A STYLE CHOICE. The first version listed the
// motion fields by name, which silently dropped every field it had not been told about. `mode` was one of
// them, and `mode:'cursor'` is exactly how the client decides a peer is a cursor rather than a body
// (`av.isCursor = m.mode === 'cursor'`), so cursor-mode players came through the relay as full blobs that
// could still be punched and shoved. A relay must not know the motion schema: any field the P2P mesh
// carries has to survive it, or every future field silently breaks the same way.
// What is stripped is only what does NOT belong on a position packet: identity (`username`/`fill`, which
// go once via roomProfile — at 50Hz × the cap they would dominate egress) and a client-supplied `id`.
const RELAY_POS_DROP = new Set(['username', 'fill', 'id']);
let relaySeqCounter = 0;
function relayPos(room, sid, msg) {
  if (!room || !msg || typeof msg !== 'object') return;
  const rec = { id: sid };
  let n = 0;
  for (const k in msg) {
    if (RELAY_POS_DROP.has(k)) continue;
    if (++n > 32) break;                      // a bound, so a client cannot inflate the packet without limit
    const v = msg[k];
    const t = typeof v;
    if (t === 'number' || t === 'boolean' || v === null) rec[k] = v;
    else if (t === 'string' && v.length <= 32) rec[k] = v;   // `mode` and friends; long strings are not motion
  }
  // Monotonic per-record version, so the fan-out can tell a NEW sample from one it has already delivered.
  // NON-ENUMERABLE on purpose: the record IS the wire object, and an enumerable `_q` would be serialised
  // into every entry of every batch — pure waste, and it would quietly inflate the per-player bandwidth
  // figure the visibility cap was chosen from.
  Object.defineProperty(rec, '_q', { value: ++relaySeqCounter, enumerable: false, writable: true });
  (roomPos[room] || (roomPos[room] = new Map())).set(sid, rec);
}
function relayProfile(room, sid, msg) {
  if (!room || !msg) return;
  const m = roomProfile[room] || (roomProfile[room] = new Map());
  m.set(sid, { id: sid, username: String(msg.username || '').slice(0, 64), fill: msg.fill || null });
  return m.get(sid);
}
function dropRelay(room, sid) {
  const p = roomPos[room]; if (p) { p.delete(sid); if (!p.size) delete roomPos[room]; }
  const f = roomProfile[room]; if (f) { f.delete(sid); if (!f.size) delete roomProfile[room]; }
  // BOTH DIRECTIONS. The leaver's own ack map goes, and so does every mention of them in everyone
  // else's — otherwise a socket id that is later reused would inherit a stale "already sent" version
  // and its first samples would be silently dropped.
  const k = roomAck[room];
  if (k) { k.delete(sid); for (const m of k.values()) m.delete(sid); if (!k.size) delete roomAck[room]; }
}
// ==RELAY_BLOCK_END==
restartRelayLoop();   // no-op while relayCfg.on is 0 — no timer is created at all until it is switched on
// What the debug panel's config wire carries. `liquidCfg` alone would leave the relay switches
// console-only, which is exactly the friction this exists to remove — the panel can only show a control
// as live if the server tells it the current value. Flattened into the same object so the panel's
// existing `if (!(k in cfg)) continue` sync loop picks them up with no special-casing.
function cfgWire() {
  return Object.assign({}, liquidCfg, {
    relayOn: !!relayCfg.on, relayHz: relayCfg.hz, relayCap: relayCfg.cap,
    relayFarHz: relayCfg.farHz, relayFarCap: relayCfg.farCap,
    secTicks: liqSecTicks, secDeferred: liqSecDeferred, secFallOnly: liqSecFallOnly,
    chunkQueue: !!interestCfg.queue, chunkQueueMs: interestCfg.queueMs, chunkQueueBatch: interestCfg.queueBatch,
    chunkQStats: { sent: chunkQSent, drains: chunkQDrains, dropped: chunkQDropped },
    worldChunked: !!worldCfg.chunked, worldOnDemand: !!worldCfg.onDemand, worldOverworld: !!worldCfg.overworld,
    // 🟥 REPORTED BACK SO A TEST CAN PUT THEM BACK. `e2e_worldgen_edit` and `e2e_worldgen_restart` shorten the
    // residency and drop the replication margin to make a chunk evict inside the life of a run — and then
    // restored HARD-CODED values on the way out, which were the defaults when they were written and are not the
    // defaults now. Every run of either left this server with a 30s grace and, worse, with `worldChunked` and
    // `worldOnDemand` switched OFF, both of which ship ON. A dial the wire can set and cannot read is a dial a
    // test cannot leave the way it found it.
    chunkGraceMs: chunkCfg.graceMs, chunkMargin: chunkCfg.margin, paused: !!liquidCfg.paused,
    worldBacking: !!worldCfg.backing,
    dayCycleMin: Math.round(worldClock.cycleMs / 60000), dayOffsetMin: Math.round(worldClock.offsetMs / 60000),
    worldGen2: !!worldCfg.gen2,
    worldDropPristine: !!worldCfg.dropPristine,
    // Read-only mechanism counters, carried on the same wire so a test (or the Perf tab) can assert that the
    // thing actually FIRED rather than inferring it from an outcome. The panel's sync loop skips any key it has
    // no control for, so these are invisible there. Same reasoning as liqRateSkips and liqK2Throttles: this
    // track has been bitten three times by a check that measured a result instead of a mechanism.
    // ⚠️ `saved`/`loaded`/`liqRestored`/`flushed` are here so a test can assert the MECHANISM rather than the
    // outcome. "The hole is still there after a restart" is also true of a build that stored nothing and simply
    // regenerated a cave in the same place; the load counter is what tells the two apart. Same reasoning as
    // `liqRateSkips` and `liqK2Throttles`, which this track needed for the same reason.
    worldStats: { produced: genPagesProduced, liquidSeeded: genLiquidSeeded, powderSeeded: genPowderSeeded, powderRewoken: genPowderRewoken, faceWoken: genFaceWoken, dropped: genChunksDropped, deltad: genChunksDeltad,
      saved: worldSaved, loaded: worldLoaded, applied: worldApplied, liqRestored: worldLiquidRestored, flushes: worldFlushes, flushed: worldFlushWrites, saveErrors: worldSaveErrors,
      // `liquidCfg.storedWakeAudit` only — see the note beside these. movable/seen is the whole diagnosis.
      auditSeen: storedAuditSeen, auditMovable: storedAuditMovable, auditChunks: storedAuditChunks },
  });
}

// ── FINE-CELL LIQUID: coarse↔fine conversion + placement + wire helpers (inc 1). All outside the sim block, so the
// harness never sees them. Volume mapping: a coarse cell holds up to LIQUID_MAX units; a full coarse cell = SUB² full fine
// cells, so upscale multiplies units by SUB² and downscale divides by SUB².
function fineSetBlock(room, SUB, cc, cr, coarseAmt) {   // distribute a coarse rank-stack into the SUB×SUB fine block (heaviest at the floor, bottom-up); returns the filled fine indices
  const st = cellsOf(room), amt = st.fineAmt, tot = st.fineTotal, FROWS = st.rows * SUB, act = fineSet(room);
  const per = new Array(LIQ_T); let totalUnits = 0;
  for (let rk = 0; rk < LIQ_T; rk++) { per[rk] = coarseAmt[rk] * SUB * SUB; totalUnits += per[rk]; }
  const fx0 = cc * SUB, fy0 = cr * SUB, filled = [];
  for (let dy = 0; dy < SUB; dy++) for (let dx = 0; dx < SUB; dx++) { const i = (fx0 + dx) * FROWS + (fy0 + dy), p = amt.wp(i), b = amt.o(i); for (let k = 0; k < LIQ_T; k++) p[b + k] = 0; tot.s(i, 0); }
  let rk = 0;
  for (let dy = SUB - 1; dy >= 0 && totalUnits > 0; dy--) for (let dx = 0; dx < SUB && totalUnits > 0; dx++) {
    const i = (fx0 + dx) * FROWS + (fy0 + dy), p = amt.wp(i), b = amt.o(i); let room2 = LIQUID_MAX;
    while (room2 > 0 && totalUnits > 0) { while (rk < LIQ_T && per[rk] <= 0) rk++; if (rk >= LIQ_T) { totalUnits = 0; break; } const mv = Math.min(per[rk], room2); p[b + rk] += mv; per[rk] -= mv; room2 -= mv; totalUnits -= mv; }
    tot.s(i, LIQUID_MAX - room2); if (tot.g(i) > 0) { act.add(i); filled.push(i); }
    fineSyncGrid(room, i); fineWakeAround(room, i);
  }
  return filled;
}
function fineClearBlock(room, SUB, cc, cr) {   // clear the SUB×SUB fine block; returns the fine indices that changed
  const st = cellsOf(room), amt = st.fineAmt, tot = st.fineTotal, FROWS = st.rows * SUB, act = fineSet(room);
  const fx0 = cc * SUB, fy0 = cr * SUB, changed = [];
  for (let dy = 0; dy < SUB; dy++) for (let dx = 0; dx < SUB; dx++) { const i = (fx0 + dx) * FROWS + (fy0 + dy); if (tot.g(i) > 0) { const p = amt.wp(i), b = amt.o(i); for (let k = 0; k < LIQ_T; k++) p[b + k] = 0; tot.s(i, 0); act.delete(i); changed.push(i); fineSyncGrid(room, i); fineWakeAround(room, i); } }
  return changed;
}
function fineToCoarseCell(room, SUB, cc, cr) {   // average a fine block back down to a coarse rank-stack (÷SUB²), clamped to CAP
  const amt = cellsOf(room).fineAmt, FROWS = cellsOf(room).rows * SUB, out = new Array(LIQ_T).fill(0), fx0 = cc * SUB, fy0 = cr * SUB;
  for (let dy = 0; dy < SUB; dy++) for (let dx = 0; dx < SUB; dx++) { const i = (fx0 + dx) * FROWS + (fy0 + dy), p = amt.rp(i), b = amt.o(i); for (let k = 0; k < LIQ_T; k++) out[k] += p[b + k]; }
  const div = SUB * SUB; let ct = 0; for (let k = 0; k < LIQ_T; k++) { out[k] = Math.round(out[k] / div); ct += out[k]; }
  let ex = ct - LIQUID_MAX; for (let k = LIQ_T - 1; k >= 0 && ex > 0; k--) { const d = Math.min(out[k], ex); out[k] -= d; ex -= d; }   // trim overflow from the lightest
  return out;
}
// (upscaleRoomToFine / downscaleRoomToCoarse converted a room between the two liquid grids. With the coarse sim gone
//  there is nothing to convert to or from; seedLiquidActivity now seeds the fine grid directly.)
function buildFineInit(room) {   // join replay: every non-empty fine cell (same mask encoding)
  materializeRoom(room);         // an evicted chunk would replay as empty — see materializeRoom
  const st = cellsOf(room), tot = st.fineTotal; if (!tot) return null;
  const SUB = st.fineSub || 1, idx = []; tot.scan((i, o, page) => { if (page[o] > 0) idx.push(i); });   // only faulted pages can hold liquid
  idx.sort((a, b) => a - b);   // page order is chunk-major; the wire and the old flat scan were index-ascending
  const cells = []; fineWirePush(room, idx, cells);
  return { sub: SUB, cols: st.cols * SUB, cells };
}
function fineActivateRect(room, grid, c0, r0, c1, r1) {   // placement in fine mode: seed/clear the fine block for each painted coarse cell + broadcast
  const SUB = 1; ensureFineArrays(room, SUB);
  const COLS = grid.geom.cols, ROWS = grid.geom.rows;
  c0 = Math.max(0, c0); r0 = Math.max(0, r0); c1 = Math.min(COLS - 1, c1); r1 = Math.min(ROWS - 1, r1);
  const changed = [];
  for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) { const i = c * ROWS + r;
    if (isFluidId(grid.g(i))) { const ca = new Array(LIQ_T).fill(0); ca[LIQ_RANK[grid.g(i)]] = LIQUID_MAX; for (const x of fineSetBlock(room, SUB, c, r, ca)) changed.push(x); }
    else for (const x of fineClearBlock(room, SUB, c, r)) changed.push(x);
    seedFineReactAround(room, i);   // an edit is the only way a SETTLED pair (lava beside painted snow/water) starts reacting
  }
  // ...and the same for SATURATION. This used to sit in activateLiquidRect's coarse tail, which fine mode returns before
  // reaching — so painting water beside earth never started it absorbing. +1 margin so an edit on either side seeds.
  for (let r = Math.max(0, r0 - 1); r <= Math.min(ROWS - 1, r1 + 1); r++)
    for (let c = Math.max(0, c0 - 1); c <= Math.min(COLS - 1, c1 + 1); c++) seedSoilAround(room, grid, c * ROWS + r);
  emitFineCells(room, changed);
}
// SOURCE tick for the fine grid: each source coarse cell tops up its SUB×SUB fine block (bottom-fill) by rate·SUB² units
// of its rank per tick (rate·SUB² keeps the physical refill rate the same as the coarse source). Ledgered like the coarse one.
function sourceTickRoomFine(room, SUB) {
  const st = cellsOf(room), src = st.src; if (!src || !src.size) return;
  const grid = st.terrain; if (!grid) return;
  ensureFineArrays(room, SUB);
  const amt = st.fineAmt, tot = st.fineTotal, act = fineSet(room), led = srcLedger(room), FROWS = st.rows * SUB, cap = LIQUID_MAX, touched = new Set();
  for (const [ci, s] of src) {
    if (ci < 0 || ci >= grid.length || isSinkId(grid.g(ci)) || isSolidCell(grid.g(ci))) { src.delete(ci); continue; }
    const rank = s.rank | 0, rate = Math.max(0, Math.min(cap, (s.rate === undefined ? liquidCfg.srcRate : s.rate) | 0));
    if (!rate) continue;
    let toAdd = rate * SUB * SUB; const cc = Math.floor(ci / st.rows), cr = ci % st.rows, fx0 = cc * SUB, fy0 = cr * SUB;
    for (let dy = SUB - 1; dy >= 0 && toAdd > 0; dy--) for (let dx = 0; dx < SUB && toAdd > 0; dx++) {
      const i = (fx0 + dx) * FROWS + (fy0 + dy), free = cap - tot.g(i); if (free <= 0) continue;
      const add = free < toAdd ? free : toAdd; amt.wp(i)[amt.o(i) + rank] += add; tot.s(i, tot.g(i) + add); led[rank] += add; toAdd -= add; act.add(i); touched.add(i); fineSyncGrid(room, i);
    }
  }
  if (!src.size) dropSrcMap(room);
  if (touched.size) emitFineCells(room, Array.from(touched));
}
// Wake the fine liquid in a COARSE cell rect (after a terrain edit) so it flows into freed space — add to add, never seed
// or clear (seeding/clearing is done explicitly by placement). Grid is decoupled in fine mode, so this reads only fine state.
function fineWakeRect(room, c0, r0, c1, r1) {
  const st = cellsOf(room), tot = st.fineTotal; if (!tot) return;
  const SUB = st.fineSub || 1, FCOLS = st.cols * SUB, FROWS = st.rows * SUB, act = fineSet(room);
  const fc0 = Math.max(0, c0 * SUB), fc1 = Math.min(FCOLS - 1, (c1 + 1) * SUB - 1), fr0 = Math.max(0, r0 * SUB), fr1 = Math.min(FROWS - 1, (r1 + 1) * SUB - 1);
  for (let c = fc0; c <= fc1; c++) for (let r = fr0; r <= fr1; r++) { const i = c * FROWS + r; if (tot.g(i) > 0) act.add(i); }
}
// Rescale every room's liquid (coarse + fine) from the current LIQUID_MAX to `newCap` so a full cell stays full when the
// cell-capacity slider changes. Uint8-safe (clamped ≤255). Recomputes totals. Caller then sets LIQUID_MAX + re-broadcasts.
function rescaleAllLiquid(newCap) {
  const oldCap = LIQUID_MAX; if (newCap === oldCap || oldCap <= 0) return;
  const f = newCap / oldCap;
  // Only faulted pages hold anything to rescale — an unallocated page is all zeros and stays that way.
  const doArr = (amtArr, totArr) => { if (!amtArr || !totArr) return; amtArr.scan((i, b, page) => { let s = 0; for (let k = 0; k < LIQ_T; k++) { let v = Math.round(page[b + k] * f); if (v > 255) v = 255; page[b + k] = v; s += v; } totArr.s(i, s > 255 ? 255 : s); }); };
  for (const room of cellRooms.fineArr) { const s = cellsOf(room); doArr(s.fineAmt, s.fineTotal); }
}

const TERRAIN_MAT_MAX = 17;                           // built-in material ids 1..17 (earth/stone/sand/ice/mud/bouncy/belt→/snow/water/quicksand/lava/acid/belt←/brine/oil/glass/drain); 0 = empty
const TERRAIN_MAT_HI = 255;                          // grid is Uint8 → material ids live in 1..255
// 🟥 249 IS THE HIGHEST ID A CUSTOM BLOCK MAY BE ALLOCATED, and 255 is the reason. The client's terrain window
// reads a cell it is not holding as TW_UNKNOWN = 255 — which is a legal INDEX into TERRAIN_MATS and not a legal
// material. That was a latent bug before the window existed (an uninstalled custom mat did the same thing) and
// it threw every frame the first time the window was switched on. Allocating up to 255 would make it reachable
// by an ordinary player creating enough blocks. 250..254 are left spare on purpose.
const CUSTOM_MAT_HI = 249;
// ---- Custom material registry (Stage 6 feature A): per-room map of custom mat id → opaque appearance/property def.
// The server stores + dedups + assigns ids; it does NOT interpret the def physically (the client clones a base mat).
// ⚠️ MOVED 18 → 90 by the world-redesign port (increment 1): ids 18..89 are now the generator's 72 materials.
// Checked before moving it, because an id space is the one thing in this increment that stored data could
// depend on: `published_worlds` is EMPTY, live rooms are in-memory, and the client's saved custom-block library
// stores DEFINITIONS (name/base/colour) with no id in them — ids are allocated per room at install time. So
// nothing on disk holds a custom id and no remap is needed. If that ever stops being true, the import path at
// 16a's `CUSTOM_MAT_FLOOR` remap is where it would go.
// 255 stays reserved: it is the client's TW_UNKNOWN (a cell outside the terrain window), not a material.
const CUSTOM_MAT_MIN = MATGEN.GEN_MAT_MAX + 1, CUSTOM_MAT_CAP = 160;   // custom mat ids start at 90 (built-ins 1..17 + generator 18..89 — the client's CUSTOM_MAT_FLOOR must match); 90..249 fit 160
// ⭐ THE OTHER HALF OF THE POWDER/PLANT/SALT SEAM (see the `POWDER_MOVE` note in the liquid sim block). The
// tables are declared inside that block, knowing sand and snow on their own; materials.js tops them up here.
// scree + ash fall and are reseeded · the twelve plant materials fall but are NEVER reseeded · vine hangs.
// 🟥 IT LIVES HERE, BESIDE THE OTHER `MATGEN` WIRING, AND THAT IS THE POINT. My first attempt put it directly
// under `==LIQUID_SIM_BLOCK_END==`, which looked outside the block and is not: `probe_budget` slices to the
// WIDER `==LIQUID_TICK_BLOCK_END==` marker, so it compiled `MATGEN` into a `new Function` with no modules and
// died. That is the ninth time this exact boundary has bitten on this track. Anything referencing a required
// module belongs below EVERY block-end marker, not below the nearest one.
for (const id of MATGEN.POWDER_IDS) { POWDER_MOVE[id] = 1; POWDER_SEED[id] = 1; }
for (const id of MATGEN.PLANT_IDS) POWDER_MOVE[id] = 1;
for (const id of MATGEN.HANGS_IDS) MAT_HANGS[id] = 1;
SALT_ID = MATGEN.NAMES['Salt'];   // the salt + water → brine reaction's reagent, same seam and the same reason
const roomMats = {};                                 // room → { id: def }
function ensureMats(room) { return roomMats[room] || (roomMats[room] = {}); }

// ---- Avatar-world MODES (Sandbox vs World) ---------------------------------
// Each page (URL) hosts TWO parallel avatar worlds: 'sandbox' (blank, build freely — the
// original behavior) and 'world' (a seeded heightmap, generated once and persistent). They
// are namespaced by a distinct socket.io room + state-map key so the two never mix; the social
// layer (chat/cursors/presence) stays on the bare URL room. A client switches at will by
// re-joining the mesh under the other mode (avt-leave → avt-join {mode}).
const AVATAR_MODES = new Set(['sandbox', 'world']);   // Level TYPE tokens (generation discriminator; 'world' == "Life"). No longer part of the room key.
// Avatar-world room key is now `av:{roomId}:{levelIndex}` (Stage 6 Phase 2; was `av:{mode}:{url}`).
// For the default per-URL room, roomId IS the URL, so a Level's key + its seed lookup stay byte-stable
// across the migration. levelIndex selects a Level within a room's World ([sandbox=0, life=1] default).
function avatarRoomKey(roomId, levelIndex) { return 'av:' + roomId + ':' + (levelIndex | 0); }
// Other sockets of the SAME identity already live in an avatar room (a second tab/window entering the same
// World). Excludes the same physical tab (a same-tab navigation reconnects as a new socket with the same
// tabSession — that's a reconnect, not a genuine second instance, so it must not trip the takeover prompt).
function sameUserAvSockets(avRoom, sid) {
  const set = roomAvt[avRoom]; if (!set) return [];
  const did = socketToDiscordId[sid], uname = socketToUsername[sid], myTab = socketToTabSession[sid];
  const out = [];
  for (const other of set) {
    if (other === sid) continue;
    if (myTab && socketToTabSession[other] === myTab) continue;
    const match = did ? socketToDiscordId[other] === did
                      : (!socketToDiscordId[other] && uname && socketToUsername[other] === uname);
    if (match) out.push(other);
  }
  return out;
}
// 2b: a client may request a user-room's avatar World via `data.roomId` (a 6-char room code). We trust
// it only after an access check — member of a private room, or any public room — else fall back to the
// default per-URL room (currentRoom). Falsy/unknown id → the per-URL room. The page URL is never a valid
// `rooms.id` (it's not a generated code), so a malicious URL-as-roomId just resolves to itself.
const _avRoomLookup = db.prepare('SELECT public, owner_id FROM rooms WHERE id = ?');
const _avRoomMember = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND discord_id = ?');
// Stage 6 Phase 3 — L2 build permissions, PER-ROOM (covers every Level in the room's World). A role
// default `mode` ('all' = anyone present can build, today's behavior; 'host' = only the owner + granted
// users) plus per-user boolean overrides. Overrides are in-memory (authoritative, ephemeral, broadcast
// on change); `mode` persists in the rooms.perms JSON {build}. Page/URL rooms (no DB row) are NEVER
// restricted — they keep today's open-build behavior. Built lazily on first access from the perms column.
const _roomPermsGet = db.prepare('SELECT perms FROM rooms WHERE id = ?');
const _roomPermsSet = db.prepare('UPDATE rooms SET perms = ? WHERE id = ?');
// `locked` = Set of levelIndexes where building is disabled for non-owners (the per-Level checkbox;
// default = unlocked/buildable). Persists in perms.levelLock alongside perms.build.
const roomBuild = new Map();                          // roomId -> { mode:'all'|'host', over:Map<discordId,bool>, locked:Set<levelIndex> }
function getRoomBuild(roomId) {
  let rb = roomBuild.get(roomId);
  if (!rb) {
    let mode = 'all'; const locked = new Set();
    try { const row = _roomPermsGet.get(roomId); if (row && row.perms) { const p = JSON.parse(row.perms);
      if (p && p.build === 'host') mode = 'host';
      if (p && Array.isArray(p.levelLock)) for (const i of p.levelLock) if (Number.isInteger(i) && i >= 0) locked.add(i);
    } } catch {}
    rb = { mode, over: new Map(), locked };
    roomBuild.set(roomId, rb);
  }
  return rb;
}
function persistRoomPerms(roomId) {                   // write build mode + level locks + feature modes back to perms
  const rb = getRoomBuild(roomId);
  const rf = getRoomFeatures(roomId);
  const out = { build: rb.mode, levelLock: [...rb.locked] };
  const features = {};
  for (const k of FEATURE_KEYS) if (rf.modes[k] === 'host') features[k] = 'host';   // store only non-default (host-only)
  if (Object.keys(features).length) out.features = features;
  const featureLevelLock = {};
  for (const k of FEATURE_KEYS) { const s = rf.levelLock.get(k); if (s && s.size) featureLevelLock[k] = [...s]; }
  if (Object.keys(featureLevelLock).length) out.featureLevelLock = featureLevelLock;
  try { _roomPermsSet.run(JSON.stringify(out), roomId); } catch {}
}
function buildPermsPayload(roomId) {                  // wire shape sent to clients (over = [[did,bool],…], locked = [levelIndex,…])
  if (!roomId) return { roomId: null, mode: 'all', over: [], locked: [] };
  const rb = getRoomBuild(roomId);
  return { roomId, mode: rb.mode, over: [...rb.over.entries()], locked: [...rb.locked] };
}
function roomOwnerId(roomId) { const r = _avRoomLookup.get(roomId); return r ? r.owner_id : null; }
// Stage 6 Phase 4 — L1 feature + combat/ghost permissions, PER-ROOM, mirroring the build model. Each feature
// carries a role default `mode` ('all' = anyone, today's behavior; 'host' = only owner + granted users) plus
// per-user boolean overrides (in-memory, ephemeral, broadcast on change). Modes persist in perms.features.
// Page/URL rooms (no DB row) are NEVER restricted. Honored cooperatively client-side; chat is also hard-gated.
const FEATURE_KEYS = ['chat', 'voice', 'video', 'cursors', 'reactions', 'soundboard', 'stamps', 'annotations', 'highlights', 'drawing', 'canvas', 'combat', 'ghost'];
const MARKUP_KEYS = ['stamps', 'annotations', 'highlights', 'drawing', 'canvas'];   // legacy 'markup' fans out to these
// Per-(feature,levelIndex) locks for the Levels tab — currently combat/ghost (build has its own levelLock in roomBuild).
// A locked Level blocks that feature for non-owners while they are on that Level. Persists in perms.featureLevelLock.
const roomFeatures = new Map();                       // roomId -> { modes:{feat:'all'|'host'}, over:Map<feat,Map<did,bool>>, levelLock:Map<feat,Set<levelIndex>> }
function getRoomFeatures(roomId) {
  let rf = roomFeatures.get(roomId);
  if (!rf) {
    const modes = {}; const over = new Map(); const levelLock = new Map();
    for (const k of FEATURE_KEYS) { modes[k] = 'all'; over.set(k, new Map()); levelLock.set(k, new Set()); }
    try { const row = _roomPermsGet.get(roomId); if (row && row.perms) { const p = JSON.parse(row.perms);
      if (p && p.features) {
        for (const k of FEATURE_KEYS) if (p.features[k] === 'host') modes[k] = 'host';
        if (p.features.markup === 'host') for (const k of MARKUP_KEYS) modes[k] = 'host';   // legacy single markup perm
      }
      if (p && p.featureLevelLock) for (const k in p.featureLevelLock) if (levelLock.has(k) && Array.isArray(p.featureLevelLock[k]))
        for (const i of p.featureLevelLock[k]) if (Number.isInteger(i) && i >= 0) levelLock.get(k).add(i);
    } } catch {}
    rf = { modes, over, levelLock };
    roomFeatures.set(roomId, rf);
  }
  return rf;
}
function featurePermsPayload(roomId) {                 // wire shape sent to clients (over[feat] = [[did,bool],…], levelLock[feat] = [levelIndex,…])
  if (!roomId) return { roomId: null, modes: null, over: null, levelLock: null };   // page room → no policy (client treats as all-open)
  const rf = getRoomFeatures(roomId);
  const over = {}; const levelLock = {};
  for (const k of FEATURE_KEYS) { over[k] = [...rf.over.get(k).entries()]; levelLock[k] = [...rf.levelLock.get(k)]; }
  return { roomId, modes: { ...rf.modes }, over, levelLock };
}
function featureAllowedFor(roomId, feature, did) {     // server-side hard check (used for chat); page room → open
  if (!roomId) return true;
  if (did && roomOwnerId(roomId) === did) return true;
  const rf = getRoomFeatures(roomId);
  const o = rf.over.get(feature);
  if (o && did && o.has(did)) return o.get(did);
  return rf.modes[feature] === 'all';
}
// Combined build+feature snapshot for the Rooms-tab perms hub, where the owner may edit a room they are NOT
// currently in (so they are not in that room's presence bucket and won't receive the bucket broadcasts). This
// is echoed back to the editing socket on every owner-only setter so the hub stays live regardless of membership.
function roomPermsPayload(roomId) {
  if (!roomId) return null;
  return { roomId, build: buildPermsPayload(roomId), features: featurePermsPayload(roomId) };
}
function resolveAvRoomId(clientRoomId, currentRoom, socketId) {
  if (!clientRoomId || typeof clientRoomId !== 'string') return currentRoom;
  const room = _avRoomLookup.get(clientRoomId);
  if (!room) return currentRoom;                              // unknown id → default URL room
  if (room.public) return clientRoomId;                       // public room World: open to anyone present
  const did = socketToDiscordId[socketId];
  if (did && room.owner_id === did) return clientRoomId;      // owner always has access to their own room
  if (did && _avRoomMember.get(clientRoomId, did)) return clientRoomId;
  return currentRoom;                                         // private room, not a member → default URL room
}
// 2c: who-list/presence follows the active context Room (the portable layer). A socket's PRESENCE bucket
// is its context Room ('pg:'+roomId) when it's in one and allowed, else the bare URL room (currentRoom) —
// preserving today's exact behavior for the page-default Room. Chat/history stay on the URL room; only the
// who-list bucket diverges. resolveAvRoomId does the membership gating, so a non-member's ctxRoomId silently
// collapses to the URL room.
function resolvePresenceRoom(clientCtxRoomId, currentRoom, socketId) {
  const rid = resolveAvRoomId(clientCtxRoomId, currentRoom, socketId);
  return rid === currentRoom ? currentRoom : 'pg:' + rid;
}
// 2d: page-bound layer (cursors/sprays/highlights/annotations + reactions/drawing/scroll) is shared among
// people in the SAME context Room AND on the same URL. A socket's PAGE bucket is 'pb:'+roomId+'|'+url when
// in an allowed context Room, else the bare URL room — so the page-default Room stays byte-identical to
// today. Navigating to a new URL while locked into a Room naturally re-keys (currentRoom changes).
function resolvePageRoom(clientCtxRoomId, currentRoom, socketId) {
  const rid = resolveAvRoomId(clientCtxRoomId, currentRoom, socketId);
  return rid === currentRoom ? currentRoom : 'pb:' + rid + '|' + currentRoom;
}
const socketToAvatarRoom = {};                       // socketId → its current avatar-world room key (for cross-socket cleanup)
const worldGenerated = new Set();                    // avatarRoom keys whose 'world' terrain has been generated this server lifetime
const hydratedAvRooms = new Set();                   // avatarRoom keys the host has already auto-hydrated this server lifetime (one-shot, never re-clobber)
// A blank (un-built, un-generated) av-room: nothing for hydration to overwrite. (A 'world'/life Level
// is seed-generated on join → non-empty → skipped, which is correct: only host-saved Levels hydrate.)
function avRoomIsEmpty(avRoom) {
  const objs = roomObjects[avRoom];
  if (objs && objs.size) return false;
  const tg = peekCells(avRoom).terrain;
  if (tg && tg.some(v => v !== 0)) return false;
  return true;
}
// Indestructible ground top (= the floor platform's y). Surface terrain rests ON this.
const FLOOR_TOP = (MWSim.STAGE_LAYOUTS[0] && MWSim.STAGE_LAYOUTS[0][0]) ? MWSim.STAGE_LAYOUTS[0][0].y : MWSim.C.WORLD_H - 72;
// World-mode spawn keep-clear box (px, world coords) above the spawn surface: nobody can build
// here, so you can't be walled in / crushed on (re)spawn. Generation also flattens this footprint.
const SPAWN_CLEAR_HALF_W = 52;                       // half-width each side of the spawn x (~1.5 tiles past the 40-wide blob)
const SPAWN_CLEAR_H = 96;                             // headroom kept clear above the surface

// Per-page world SEED persists in SQLite so a 'world' regenerates IDENTICALLY after a server
// restart (generation is deterministic from the seed). Player EDITS to a world stay in-memory
// (ephemeral, clear on restart) — same durability Sandbox has always had.
db.exec('CREATE TABLE IF NOT EXISTS avatar_worlds (url TEXT PRIMARY KEY, seed INTEGER NOT NULL)');
const _getWorldSeed = db.prepare('SELECT seed FROM avatar_worlds WHERE url = ?');
const _insWorldSeed = db.prepare('INSERT OR IGNORE INTO avatar_worlds (url, seed) VALUES (?, ?)');

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  WORLD PERSISTENCE — what players have BUILT survives a restart. See `scratchpad/kickoff_persistence.md`.
//
//  Until now nothing was written at all: increment 4d's per-chunk diffs lived in `rec.blob` in memory, so every
//  restart discarded everything anybody had built in the Overworld. That became live-affecting the moment the
//  Overworld became the default.
//
//  ⭐ THE ENCODER ALREADY EXISTED AND IS NOT REBUILT HERE. `evictChunk` calls `chunkDelta`, which regenerates
//  the chunk and compares, so an untouched chunk stores NOTHING (it is re-derived from the seed) and a changed
//  one stores only the differing cells at 4 bytes each. Storage is proportional to what players have BUILT and
//  to nothing else — not world size, not distance walked. Ceiling: 8 GB for the entire Overworld hand-edited.
//  ⚠️ `ver` is PER ROW, not per database: two generators can be live at once, so "the current version" is a
//  property of the room (`genVersion`). A row whose version does not match is DROPPED on read rather than
//  applied to ground it was never cut from.
//  ⚠️ `liquid` is declared now and written by increment 2, so that half needs no migration. The design is in
//  the kickoff: diff against `seedGenChunkLiquid`, which is deterministic per chunk, so an untouched lake costs
//  nothing and only water somebody actually moved is stored.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
db.exec(`CREATE TABLE IF NOT EXISTS world_chunks (
  room    TEXT    NOT NULL,
  chunk   INTEGER NOT NULL,
  ver     INTEGER NOT NULL,
  kind    INTEGER NOT NULL,
  terrain BLOB,
  liquid  BLOB,
  updated INTEGER NOT NULL,
  PRIMARY KEY (room, chunk)
)`);
const _putChunkRow = db.prepare(`INSERT INTO world_chunks (room, chunk, ver, kind, terrain, liquid, updated)
  VALUES (?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT(room, chunk) DO UPDATE SET ver=excluded.ver, kind=excluded.kind,
    terrain=excluded.terrain, liquid=excluded.liquid, updated=excluded.updated`);
const _getChunkRow = db.prepare('SELECT ver, kind, terrain, liquid FROM world_chunks WHERE room = ? AND chunk = ?');
const _delChunkRow = db.prepare('DELETE FROM world_chunks WHERE room = ? AND chunk = ?');
const _countChunkRows = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(terrain)), 0) AS b FROM world_chunks');

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  🟥🟥 WHERE EACH SITE LIVES, ON DISK. THE ONE THING ABOVE IS MEANINGLESS WITHOUT.
//  Every chunk row above is keyed by (room, CHUNK) — an absolute column in the shared Overworld. Which column a
//  site occupies was decided by `server/domains.js`, an ALLOCATION whose result "depends on the ORDER sites were
//  first placed, which is fine BECAUSE it is recorded". It was not recorded. The registry was memory-only, on a
//  note that said so and called it "fine while the Overworld does not survive a restart either" — which stopped
//  being true the day Overworld persistence landed, and nothing brought the two together.
//  ⇒ On every restart, every site was re-allocated in whatever order sites happened to join. A site placed
//  second in one process and first in the next got a DIFFERENT COLUMN, so its terrain and liquid stayed behind
//  in the database at the old one, unreachable, while the player arrived at untouched ground. Intermittent by
//  construction: land on the same column and everything is fine, which is why it read as "liquid after a restart
//  is sometimes wrong" rather than as a placement bug.
//  ⚠️ FOUND BY TRACING THE LIVE SERVER ACROSS A RESTART, not by reading. `[persist] spawn` printed
//  `col 264794` before and `col 264474` after for the same identity; every theory before that had been about the
//  liquid encoder, which was innocent.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
db.exec(`CREATE TABLE IF NOT EXISTS domain_sites (
  id      TEXT PRIMARY KEY,
  col     INTEGER NOT NULL,
  band    TEXT    NOT NULL,
  sep     INTEGER,
  weight  REAL,
  rung    INTEGER,
  family  TEXT,
  cat     TEXT,
  placed  INTEGER NOT NULL
)`);
const _putSiteRow = db.prepare(`INSERT INTO domain_sites (id, col, band, sep, weight, rung, family, cat, placed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT(id) DO UPDATE SET col=excluded.col, band=excluded.band, sep=excluded.sep,
    weight=excluded.weight, rung=excluded.rung, family=excluded.family, cat=excluded.cat`);
const _delSiteRow = db.prepare('DELETE FROM domain_sites WHERE id = ?');
const _allSiteRows = db.prepare('SELECT id, col, band, sep, weight, rung, family, cat FROM domain_sites');
domainRowWrite = (rec) => {
  try { _putSiteRow.run(rec.id, rec.col | 0, String(rec.band), rec.sep | 0, +rec.weight || 1, rec.rung | 0, rec.family || rec.id, rec.cat || null); }
  catch (e) { console.log('domain_sites save failed: ' + e.message); }
};
// ⚠️ A RELEASE IS A DELETE, and it has to be: rung 5 takes a dormant site's column for a new arrival, and a stale
// row for the victim would be adopted next start alongside the site standing in its place.
domainRowDrop = (rec) => { try { _delSiteRow.run(rec.id); } catch (e) { /* best effort */ } };
// ⚠️ AT LOAD, BEFORE ANYTHING CAN JOIN — a site placed before the layout is read back would be allocated against
// an empty world and could take a column somebody already owns.
{
  let rows = [];
  try { rows = _allSiteRows.all(); } catch (e) { console.log('domain_sites load failed: ' + e.message); }
  const r = domains.adopt(rows);
  if (r.adopted || r.dropped) console.log(`domains: ${r.adopted} site placement(s) restored${r.dropped ? ', ' + r.dropped + ' dropped as unusable' : ''}`);
}

// ⭐ RESET, AND IT IS DELIBERATELY NOT CLICKABLE. `MW_FRESH_WORLD=1` (via `restart-server.ps1 -FreshWorld`)
// wipes every stored change at startup. The four world switches were just removed from the debug panel because
// a global control that can be hit by accident — or by a stale client default — breaks the world for everyone;
// a DESTRUCTIVE one clearly must not be one click away. A restart is already how changes are picked up, so this
// costs the user nothing and cannot be triggered by a stray click or a test harness.
// 🟥 THE WHOLE ROOM'S STORED EDITS ARE LOADED INTO MEMORY IN ONE GO, AND THAT IS NOT LAZINESS — IT IS THE ONLY
// WAY THE FAULT PATH STAYS SAFE. `applyStoredEdit` runs inside a page fault, and a page fault can arrive from
// deep inside `fineLiquidTickRoom` while it is iterating the active-cell Set. A synchronous SQLite read there
// puts disk latency on the tick.
// ⚠️ Bounded by exactly the thing the whole design is bounded by — what players have BUILT. A world with
// 10,000 changed chunks is ~20MB here, against 8GB for the entire Overworld hand-edited. If that ever stops
// being comfortable the answer is an LRU, not lazy reads on the tick.
// ⚠️ DECLARED HERE, ABOVE `wipeSavedWorlds`, NOT BESIDE THE CODE THAT USES IT. The startup wipe runs at module
// load and clears this map; with the declaration further down the file that is a TDZ ReferenceError on every
// `-FreshWorld` start. Same trap `PAGE_DIMS` set on this project once already.
const _storedChunks = new Map();                       // room → Map<chunk index, decoded blob>
// ⭐ ONE IMPLEMENTATION, TWO DOORS. The startup flag and the debug panel's button both call this, so they
// cannot drift into meaning different things — the panel forgetting to clear the in-memory index would look
// exactly like "the wipe did not work".
function wipeSavedWorlds() {
  const before = _countChunkRows.get();
  db.exec('DELETE FROM world_chunks');
  _storedChunks.clear();                                 // the in-memory mirror, or a wiped chunk still comes back
  return before;
}
if (process.env.MW_FRESH_WORLD === '1') {
  const _before = wipeSavedWorlds();
  console.log(`MW_FRESH_WORLD=1 — wiped ${_before.n} stored chunk(s), ${(_before.b / 1024).toFixed(1)}KB of edits`);
}

// A diff packs to (index u16, material u8, damage u8) per changed cell — the shape `encodeChunkDelta` already
// produces, laid out as one buffer so SQLite stores it as a BLOB rather than as JSON (which would be ~4x).
// The two on-disk encodings, and the `kind` column says which a row holds. KIND_DIFF has always been the only
// one written; KIND_WHOLE is the fallback `encodeChunkDelta` used to defer to and nobody had built.
// ⚠️ A row written before this existed has kind 0 and is a diff, which is what it has always been — no migration.
const CHUNK_KIND_DIFF = 0, CHUNK_KIND_WHOLE = 1;
function packDelta(d) {
  // WHOLE: no indices, because every cell is present in order. Materials then hit points, 2 bytes a cell.
  if (d.whole) {
    const buf = Buffer.allocUnsafe(CHUNK_CELLS * 2);
    for (let i = 0; i < CHUNK_CELLS; i++) { buf[i] = d.m[i]; buf[CHUNK_CELLS + i] = d.hp[i]; }
    return buf;
  }
  const n = d.d.length, buf = Buffer.allocUnsafe(n * 4);
  for (let i = 0; i < n; i++) { buf.writeUInt16LE(d.d[i], i * 4); buf[i * 4 + 2] = d.m[i]; buf[i * 4 + 3] = d.hp[i]; }
  return buf;
}
function unpackDelta(buf, ver, kind) {
  // ⚠️ A WHOLE row is expanded into the same d/m/hp shape a diff produces, listing every index. That is what
  // keeps `applyStoredEdit` and `decodeChunk` free of a second code path — the difference is entirely on disk.
  if (kind === CHUNK_KIND_WHOLE) {
    if (buf.length !== CHUNK_CELLS * 2) return null;    // corrupt or truncated; treated as no row at all
    const d = new Uint16Array(CHUNK_CELLS), m = new Uint8Array(CHUNK_CELLS), hp = new Uint8Array(CHUNK_CELLS);
    for (let i = 0; i < CHUNK_CELLS; i++) { d[i] = i; m[i] = buf[i]; hp[i] = buf[CHUNK_CELLS + i]; }
    return { v: ver, d, m, hp, a: null, whole: 1 };
  }
  const n = (buf.length / 4) | 0;
  const d = new Uint16Array(n), m = new Uint8Array(n), hp = new Uint8Array(n);
  for (let i = 0; i < n; i++) { d[i] = buf.readUInt16LE(i * 4); m[i] = buf[i * 4 + 2]; hp[i] = buf[i * 4 + 3]; }
  return { v: ver, d, m, hp, a: null, whole: 0 };
}
// Diagnostics; a silent persistence layer is untestable. `worldApplied` is the one that matters to a test — a
// row being READ proves nothing, a row being laid over real ground is the mechanism.
let worldSaved = 0, worldLoaded = 0, worldApplied = 0, worldSaveErrors = 0;
// ⚠️ A HOOK, for the reason recorded ten times on this track: `evictChunk` lives inside the block the probe rigs
// slice out and run in a bare `new Function`, where `_putChunkRow` does not exist. Declared as a no-op INSIDE
// that block (search `saveChunkBlob = `) and reassigned to this, below the block, at load.
function persistChunkBlob(room, p, blob, ver) {
  if (!blob || !blob.d) return;                              // pristine, or a room with no generator to diff against
  if (worldCfg.tracePersist) console.log(`[persist] write chunk ${p}: ${blob.whole ? 'WHOLE (' + CHUNK_CELLS + ' cells, 8KB)' : blob.d.length + ' terrain cell(s)'}, ${blob.liq ? (blob.liq.length / 4) + ' liquid entr(ies)' : 'no liquid diff'}`);
  try { _putChunkRow.run(room, p, ver, blob.whole ? CHUNK_KIND_WHOLE : CHUNK_KIND_DIFF, packDelta(blob), blob.liq || null); worldSaved++; }
  catch (e) { worldSaveErrors++; if (worldSaveErrors < 5) console.log('world_chunks save failed: ' + e.message); }
}
function loadChunkBlob(room, p, ver) {
  let row = null;
  try { row = _getChunkRow.get(room, p); } catch (e) { return null; }
  if (!row || !row.terrain) return null;
  // 🟥 A STALE ROW IS DELETED, NOT APPLIED. A diff is meaningless without the ground it was taken against, so a
  // version mismatch means somebody's tunnel would be cut through different rock. Dropping it loses that edit —
  // which is the correct loss, and the alternative is silent corruption.
  if (row.ver !== ver) { try { _delChunkRow.run(room, p); } catch (e) { /* best effort */ } return null; }
  worldLoaded++;
  const b = unpackDelta(Buffer.from(row.terrain), row.ver, row.kind | 0);
  if (!b) return null;
  b.liq = row.liquid ? Buffer.from(row.liquid) : null;
  return b;
}
function worldSeedFor(url) {
  const row = _getWorldSeed.get(url);
  if (row && Number.isFinite(row.seed)) return row.seed >>> 0;
  const seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  _insWorldSeed.run(url, seed);
  return seed;
}
// ---- Phase 7: published Worlds (server-side persistence + gallery + unattended hydration) ----------
// A published World stores its full content blobs (terrain RLE + objects + mats per Level) on the server,
// backed by a public `rooms` row (kind='published') so it reuses the context-room/avt-join/presence/perms
// plumbing. The room's env_spec Levels carry a server-resolvable `pub:{world,lvl}` ref so the SERVER can
// hydrate the room with no host present (7b). `content` = the Saved World's Lvl array (captureLevel shape).
db.exec(`CREATE TABLE IF NOT EXISTS published_worlds (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  name TEXT NOT NULL,
  author TEXT,
  description TEXT,
  thumb TEXT,
  content TEXT NOT NULL,
  level_count INTEGER DEFAULT 1,
  size_bytes INTEGER DEFAULT 0,
  allow_remix INTEGER DEFAULT 0,
  durability TEXT DEFAULT 'showcase',
  live_state TEXT,
  play_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
)`);
const PUBLISHED_MAX_BYTES = 2_000_000;                // content blob cap per World (~2 MB)
const PUBLISHED_PER_USER = 12;                        // how many Worlds one user may have published at once
const PUBLISHED_THUMB_MAX = 60_000;                   // thumbnail data-URI cap (chars)
function genWorldId() {
  let id;
  do { id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  while (db.prepare('SELECT 1 FROM published_worlds WHERE id = ?').get(id));
  return id;
}
// Light structural validation of a publish payload. The Lvl blobs stay opaque here (re-validated cell-by-cell
// when the server hydrates them in 7b); we just enforce the array shape, terrain grid dims, and Level count.
function validatePublishContent(levels) {
  if (!Array.isArray(levels) || !levels.length || levels.length > ROOM_LEVEL_CAP) return null;
  for (const l of levels) {
    if (!l || typeof l !== 'object' || !l.terrain || typeof l.terrain !== 'object') return null;
    // Publishing is a page-room/Level operation, so the page shape is the right yardstick here — deliberately
    // PAGE_DIMS rather than a per-room lookup, since a published World is replayed into page rooms.
    if ((l.terrain.cols | 0) !== PAGE_DIMS.cols || (l.terrain.rows | 0) !== PAGE_DIMS.rows) return null;  // foreign world size
  }
  return levels;
}
// Public, server-resolvable env_spec for a published World's backing room. Each Level points back at the
// stored content via `pub:{world,lvl}` (server hydrates from it); 'world'-type content maps to 'life'.
function derivePubEnvSpec(content, worldId) {
  const levels = content.map((l, i) => {
    const type = (l && (l.type === 'world' || l.type === 'life')) ? 'life' : 'sandbox';
    const o = { type, name: 'Level ' + (i + 1), size: 'large', pub: { world: worldId, lvl: i } };
    if (Number.isInteger(l && l.bg) && l.bg >= 0 && l.bg <= 3) o.bg = l.bg;
    return o;
  });
  return { levels, nav: 'free' };
}
// ---- Shared animation library (custom animated emotes — Stage 6 expressiveness) ----
db.exec(`CREATE TABLE IF NOT EXISTS shared_animations (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  author_name TEXT,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  seg_count INTEGER DEFAULT 1,
  has_image INTEGER DEFAULT 0,
  size_bytes INTEGER DEFAULT 0,
  downloads INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
)`);
const SHARED_ANIM_MAX_BYTES = 400_000;   // spec blob cap (allows a couple small image/GIF fills)
const SHARED_ANIM_PER_USER  = 40;        // how many animations one user may share at once
const SHARED_ANIM_SEG_CAP   = 40;        // segments per animation
const SHARED_ANIM_COMBO_CAP = 8;         // item specs per segment
function genAnimId() {
  let id;
  do { id = 'sa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  while (db.prepare('SELECT 1 FROM shared_animations WHERE id = ?').get(id));
  return id;
}
// Structural validation of a shared-animation payload {loop, segments}. Item specs stay largely opaque
// (the client re-normalizes on download); we enforce array shapes, counts, numeric knobs, size, and flag
// image fills. Returns { spec, segCount, hasImage, size } or null.
function validateAnimSpec(body) {
  if (!body || !Array.isArray(body.segments) || !body.segments.length || body.segments.length > SHARED_ANIM_SEG_CAP) return null;
  const loop = (body.loop === 'on' || body.loop === 'off' || body.loop === 'auto') ? body.loop : 'auto';
  let hasImage = 0;
  const segments = [];
  for (const s of body.segments) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.combo) || s.combo.length > SHARED_ANIM_COMBO_CAP) return null;
    const combo = [];
    for (const it of s.combo) {
      if (!it || typeof it !== 'object' || typeof it.kind !== 'string') return null;
      if (it.kind === 'image') hasImage = 1;
      combo.push(it);
    }
    const durMs = Math.max(120, Math.min(20000, Number(s.durMs) || 700));
    const speed = Math.max(0.25, Math.min(4, Number(s.speed) || 1));
    segments.push({ combo, durMs, speed });
  }
  const spec = JSON.stringify({ loop, segments });
  if (spec.length > SHARED_ANIM_MAX_BYTES) return null;
  return { spec, segCount: segments.length, hasImage, size: spec.length };
}

// ---- Generic shared libraries (emojis, sounds, Level templates, terrain blocks) ----
// Mirrors the shared_animations pattern: upload/update (author-only + per-user cap), browse/search,
// download counter, author-only delete, plus a lightweight report counter (we surface links, not host
// bytes, so takedowns rely on author-delete + reports). Emojis/sounds store links only; templates/blocks
// store a JSON content blob — the table shape is the same, the difference is entirely in validate/mapRow.
// cfg: { path, table, cols:[{name,type}], searchCol, validate(body)->{col:val}|null, mapRow(row,me), perUser }
function registerLibrary(cfg) {
  const colNames = cfg.cols.map(c => c.name);
  db.exec(`CREATE TABLE IF NOT EXISTS ${cfg.table} (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,
    author_name TEXT,
    ${cfg.cols.map(c => c.name + ' ' + c.type).join(',\n    ')},
    downloads INTEGER DEFAULT 0,
    reports INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  )`);
  // One shared like ledger for every library, keyed by (lib path, item, user) so a like is per-user and
  // toggleable. The per-row `likes` counter (above) is the denormalized total for cheap sorting/display.
  db.exec(`CREATE TABLE IF NOT EXISTS shared_likes (
    lib TEXT NOT NULL, item_id TEXT NOT NULL, user_id TEXT NOT NULL,
    PRIMARY KEY (lib, item_id, user_id)
  )`);
  // Bring existing (pre-likes / newly-added-column) tables up to the current shape — ALTER throws if the
  // column already exists, which we ignore. Covers `likes` and any col added to cfg.cols after first deploy.
  cfg.cols.forEach(c => { try { db.exec(`ALTER TABLE ${cfg.table} ADD COLUMN ${c.name} ${c.type}`); } catch (e) {} });
  try { db.exec(`ALTER TABLE ${cfg.table} ADD COLUMN likes INTEGER DEFAULT 0`); } catch (e) {}
  const searchCol = cfg.searchCol || 'name';
  function genId() {
    let id;
    do { id = cfg.table.slice(0, 2) + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    while (db.prepare(`SELECT 1 FROM ${cfg.table} WHERE id = ?`).get(id));
    return id;
  }

  app.post('/' + cfg.path, (req, res) => {
    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const body = req.body || {};
    const vals = cfg.validate(body);
    if (!vals) return res.status(400).json({ error: 'Invalid entry' });
    const authorName = (body.author || '').trim().slice(0, 40) || null;
    try {
      const existing = body.id ? db.prepare(`SELECT author_id FROM ${cfg.table} WHERE id = ?`).get(body.id) : null;
      if (existing) {                                                  // ---- update an existing share ----
        if (existing.author_id !== user.sub) return res.status(403).json({ error: 'Not author' });
        db.prepare(`UPDATE ${cfg.table} SET author_name=?, ${colNames.map(c => c + '=?').join(', ')} WHERE id=?`)
          .run(authorName, ...colNames.map(c => vals[c]), body.id);
        return res.json({ id: body.id });
      }
      const count = db.prepare(`SELECT COUNT(*) as c FROM ${cfg.table} WHERE author_id = ?`).get(user.sub).c;
      if (count >= cfg.perUser) return res.status(409).json({ error: 'Library limit reached (' + cfg.perUser + ')' });
      const id = genId();
      const cols = ['id', 'author_id', 'author_name', ...colNames];
      db.prepare(`INSERT INTO ${cfg.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(id, user.sub, authorName, ...colNames.map(c => vals[c]));
      res.json({ id });
    } catch (e) { res.status(500).json({ error: 'DB error' }); }
  });

  app.get('/' + cfg.path, (req, res) => {
    const caller = verifyToken(req);
    const me = caller ? caller.sub : '\x00';
    const order = req.query.sort === 'likes' ? 'likes DESC, downloads DESC, created_at DESC'
                : req.query.sort === 'popular' ? 'downloads DESC, created_at DESC'
                : 'created_at DESC';
    const q = (req.query.q || '').toString().trim().slice(0, 40);
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const PER = 30;
    // Optional derived-quality filter (e.g. terrain blocks: solid/liquid/hazard/bouncy/…). Facets are
    // stored as a delimited string like "|solid|breakable|". `?facet=a,b,c` AND-matches every one.
    const facets = (req.query.facet || '').toString().trim().toLowerCase().split(',')
      .map(s => s.replace(/[^a-z0-9]/g, '').slice(0, 20)).filter(Boolean).slice(0, 12);
    const where = [], params = [];
    if (q) {
      if (cfg.descCol) { where.push(`(${searchCol} LIKE ? OR ${cfg.descCol} LIKE ?)`); params.push('%' + q + '%', '%' + q + '%'); }
      else { where.push(`${searchCol} LIKE ?`); params.push('%' + q + '%'); }
    }
    if (cfg.facetCol) for (const f of facets) { where.push(`${cfg.facetCol} LIKE ?`); params.push('%|' + f + '|%'); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    try {
      const rows = db.prepare(`SELECT * FROM ${cfg.table} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, PER, page * PER);
      let liked = new Set();
      if (caller) liked = new Set(db.prepare('SELECT item_id FROM shared_likes WHERE lib = ? AND user_id = ?').all(cfg.path, me).map(x => x.item_id));
      res.json(rows.map(r => { const o = cfg.mapRow(r, me); o.likes = r.likes || 0; o.liked = liked.has(r.id); return o; }));
    } catch (e) { res.status(500).json({ error: 'DB error' }); }
  });

  // Per-user like toggle. Flips the caller's row in shared_likes and keeps the denormalized counter in
  // sync; returns the new total + whether the caller now likes it.
  app.post('/' + cfg.path + '/:id/like', (req, res) => {
    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const id = req.params.id;
    try {
      if (!db.prepare(`SELECT 1 FROM ${cfg.table} WHERE id = ?`).get(id)) return res.status(404).json({ error: 'Not found' });
      const had = db.prepare('SELECT 1 FROM shared_likes WHERE lib = ? AND item_id = ? AND user_id = ?').get(cfg.path, id, user.sub);
      let liked;
      if (had) {
        db.prepare('DELETE FROM shared_likes WHERE lib = ? AND item_id = ? AND user_id = ?').run(cfg.path, id, user.sub);
        db.prepare(`UPDATE ${cfg.table} SET likes = MAX(0, likes - 1) WHERE id = ?`).run(id);
        liked = false;
      } else {
        db.prepare('INSERT INTO shared_likes (lib, item_id, user_id) VALUES (?, ?, ?)').run(cfg.path, id, user.sub);
        db.prepare(`UPDATE ${cfg.table} SET likes = likes + 1 WHERE id = ?`).run(id);
        liked = true;
      }
      const row = db.prepare(`SELECT likes FROM ${cfg.table} WHERE id = ?`).get(id);
      res.json({ likes: row ? row.likes : 0, liked });
    } catch (e) { res.status(500).json({ error: 'DB error' }); }
  });

  app.post('/' + cfg.path + '/:id/download', (req, res) => {
    try { db.prepare(`UPDATE ${cfg.table} SET downloads = downloads + 1 WHERE id = ?`).run(req.params.id); } catch (e) {}
    res.json({ ok: true });
  });

  app.post('/' + cfg.path + '/:id/report', (req, res) => {
    try { db.prepare(`UPDATE ${cfg.table} SET reports = reports + 1 WHERE id = ?`).run(req.params.id); } catch (e) {}
    res.json({ ok: true });
  });

  app.delete('/' + cfg.path + '/:id', (req, res) => {
    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const row = db.prepare(`SELECT author_id FROM ${cfg.table} WHERE id = ?`).get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.author_id !== user.sub) return res.status(403).json({ error: 'Not author' });
      db.prepare(`DELETE FROM ${cfg.table} WHERE id = ?`).run(req.params.id);
      db.prepare('DELETE FROM shared_likes WHERE lib = ? AND item_id = ?').run(cfg.path, req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'DB error' }); }
  });
}

// Links-only: only http(s) URLs are accepted for the shared emoji/sound libraries (we store the link, not
// the bytes) — this also rejects data: URIs so local file-uploads stay local.
const LIB_URL_RE = /^https?:\/\/[^\s]{3,1500}$/i;

// Emoji/image library — custom emoji are images/GIFs; each entry is an image link + a searchable name.
registerLibrary({
  path: 'emoji-lib', table: 'shared_emojis', perUser: 60, searchCol: 'name',
  cols: [{ name: 'name', type: 'TEXT' }, { name: 'url', type: 'TEXT' }, { name: 'kind', type: 'TEXT' }, { name: 'tags', type: 'TEXT' }],
  validate(body) {
    const url = (body.url || '').toString().trim();
    if (!LIB_URL_RE.test(url)) return null;
    const name = (body.name || body.title || '').toString().trim().slice(0, 40) || 'emoji';
    const kind = /\.gif(\?|$)/i.test(url) ? 'gif' : 'image';
    const tags = (body.tags || '').toString().trim().slice(0, 120);
    return { name, url, kind, tags };
  },
  mapRow(r, me) {
    return { id: r.id, name: r.name, url: r.url, kind: r.kind, tags: r.tags, author: r.author_name, mine: r.author_id === me, downloads: r.downloads, created_at: r.created_at };
  },
});

// Soundboard library — each entry is an audio link + a short label.
registerLibrary({
  path: 'sound-lib', table: 'shared_sounds', perUser: 40, searchCol: 'label',
  cols: [{ name: 'label', type: 'TEXT' }, { name: 'url', type: 'TEXT' }, { name: 'tags', type: 'TEXT' }],
  validate(body) {
    const url = (body.url || '').toString().trim();
    if (!LIB_URL_RE.test(url)) return null;
    const label = (body.label || body.title || '').toString().trim().slice(0, 24) || 'sound';
    const tags = (body.tags || '').toString().trim().slice(0, 120);
    return { label, url, tags };
  },
  mapRow(r, me) {
    return { id: r.id, label: r.label, url: r.url, tags: r.tags, author: r.author_name, mine: r.author_id === me, downloads: r.downloads, created_at: r.created_at };
  },
});

// Layer-2 terrain-TEMPLATE library — a multi-cell terrain STAMP {name,w,h,cells} (the Select-tool
// `terrainTemplates`), stored as a JSON content blob. (Whole Worlds share via upload+Remix, not here.)
registerLibrary({
  path: 'template-lib', table: 'shared_templates', perUser: 60, searchCol: 'title', descCol: 'descr',
  cols: [{ name: 'title', type: 'TEXT' }, { name: 'descr', type: 'TEXT' }, { name: 'content', type: 'TEXT' }, { name: 'w', type: 'INTEGER' }, { name: 'h', type: 'INTEGER' }, { name: 'size_bytes', type: 'INTEGER' }],
  validate(body) {
    const title = (body.title || '').toString().trim().slice(0, 60) || 'Template';
    const descr = (body.desc || '').toString().trim().slice(0, 300);
    let t;
    try { t = typeof body.content === 'string' ? JSON.parse(body.content) : body.content; } catch (e) { return null; }
    if (!t || typeof t !== 'object') return null;
    const w = t.w | 0, h = t.h | 0;
    if (w < 1 || h < 1 || w > 400 || h > 400) return null;
    if (!Array.isArray(t.cells) || t.cells.length !== w * h) return null;
    if (!t.cells.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) return null;   // material ids
    // Optional non-terrain objects (props/markers) captured with the template, clip-relative (dx,dy).
    let objs = [];
    if (Array.isArray(t.objs)) { if (t.objs.length > 200) return null; objs = t.objs; }
    const content = JSON.stringify({ name: (t.name || title).toString().slice(0, 40), w, h, cells: t.cells, objs });
    if (content.length > 600_000) return null;
    return { title, descr, content, w, h, size_bytes: content.length };
  },
  mapRow(r, me) {
    return { id: r.id, title: r.title, desc: r.descr || '', author: r.author_name, mine: r.author_id === me, w: r.w, h: r.h, likes: r.likes || 0, downloads: r.downloads, created_at: r.created_at, content: r.content };
  },
});

// Terrain-block library — stores one custom-mat def JSON blob (fill/cap hex + behavior/skin fields),
// plus a delimited `facets` string of derived qualities so the browser can filter by Solid/Liquid/etc.
registerLibrary({
  path: 'block-lib', table: 'shared_blocks', perUser: 60, searchCol: 'name', facetCol: 'facets', descCol: 'descr',
  cols: [{ name: 'name', type: 'TEXT' }, { name: 'descr', type: 'TEXT' }, { name: 'def', type: 'TEXT' }, { name: 'facets', type: 'TEXT' }, { name: 'size_bytes', type: 'INTEGER' }],
  validate(body) {
    const name = (body.name || '').toString().trim().slice(0, 24) || 'Block';
    const descr = (body.desc || '').toString().trim().slice(0, 300);
    let def;
    try { def = typeof body.def === 'string' ? JSON.parse(body.def) : body.def; } catch (e) { return null; }
    if (!def || typeof def !== 'object') return null;
    if (!/^#[0-9a-f]{6}$/i.test(def.fill || '') || !/^#[0-9a-f]{6}$/i.test(def.cap || '')) return null;   // same shape the client stores
    const json = JSON.stringify(def);
    if (json.length > 200_000) return null;
    // Derive the searchable qualities from the def (mirrors the client's block modifiers).
    const f = [];
    if (def.behavior === 'fluid') f.push('liquid');
    else if (def.behavior === 'hazard') f.push('hazard');
    else f.push('solid');
    if (['ice', 'mud', 'snow'].includes(def.surface)) f.push(def.surface);
    if (def.bouncy) f.push('bouncy');
    if (def.conveyor) f.push('conveyor');
    if (def.breakable !== false) f.push('breakable');
    const facets = '|' + f.join('|') + '|';
    return { name, descr, def: json, facets, size_bytes: json.length };
  },
  mapRow(r, me) {
    return { id: r.id, name: r.name, desc: r.descr || '', facets: r.facets || '', author: r.author_name, mine: r.author_id === me, def: r.def, likes: r.likes || 0, downloads: r.downloads, created_at: r.created_at };
  },
});

// ---- Overlay THEME library ----
// A downloaded theme restyles the victim's overlay on EVERY site they visit, so the
// blob is strictly whitelisted here (and again on the client at apply time). Only
// known-shaped keys survive; colours must parse as colours, images must be https,
// fonts are length/char-bounded, everything else is dropped.
const THEME_COLOR_RE = /^(#[0-9a-f]{3,8}|rgb\(\s*[\d.,%\s]+\)|rgba\(\s*[\d.,%\s]+\)|hsl\(\s*[\d.,%\s]+\)|hsla\(\s*[\d.,%\s]+\)|transparent|inherit|[a-z]{3,20})$/i;
const themeColor = v => (typeof v === 'string' && v.length <= 40 && THEME_COLOR_RE.test(v.trim())) ? v.trim() : null;
const themeLen   = v => (typeof v === 'string' && /^\d{1,3}px$/.test(v.trim())) ? v.trim() : null;
const themeHttps = v => (typeof v === 'string' && /^https:\/\/[^\s"'()<>\\]{5,1000}$/i.test(v.trim())) ? v.trim() : null;
const themeFont  = v => (typeof v === 'string' && v.length <= 60 && !/[;{}<>]/.test(v)) ? v : null;
function sanitizeTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const out = { v: 1, name: (t.name || 'Theme').toString().slice(0, 40) };
  out.tokens = {};
  if (t.tokens && typeof t.tokens === 'object') {
    for (const k of Object.keys(t.tokens).slice(0, 40)) {
      if (!/^[a-zA-Z]{2,20}$/.test(k)) continue;
      const c = themeColor(t.tokens[k]) || themeFont(t.tokens[k]) || themeLen(t.tokens[k]);
      if (c) out.tokens[k] = c;
    }
  }
  out.sections = {};
  if (t.sections && typeof t.sections === 'object') {
    for (const id of Object.keys(t.sections).slice(0, 40)) {
      if (!/^mw-[a-z0-9-]{1,40}$/.test(id)) continue;
      const s = t.sections[id]; if (!s || typeof s !== 'object') continue;
      const o = {};
      const bg = themeColor(s.bg); if (bg) o.bg = bg;
      const tc = themeColor(s.text); if (tc) o.text = tc;
      const img = themeHttps(s.bgImage); if (img) o.bgImage = img;
      const f = themeFont(s.font); if (f) o.font = f;
      if (Number.isInteger(s.fontSize) && s.fontSize >= 8 && s.fontSize <= 40) o.fontSize = s.fontSize;
      if (s.bold === true) o.bold = true;
      if (s.italic === true) o.italic = true;
      if (s.underline === true) o.underline = true;
      if (Object.keys(o).length) out.sections[id] = o;
    }
  }
  out.buttons = {};
  if (t.buttons && typeof t.buttons === 'object') {
    const b = t.buttons;
    if (b.bars && typeof b.bars === 'object') {
      out.buttons.bars = {};
      for (const key of Object.keys(b.bars).slice(0, 24)) {
        if (!/^(header|tabs|features|message|banner|f:[a-z0-9]{1,20})$/.test(key)) continue;
        if (Array.isArray(b.bars[key])) out.buttons.bars[key] = b.bars[key].filter(x => typeof x === 'string' && /^[a-z0-9-]{1,30}$/.test(x)).slice(0, 40);
      }
    }
    if (Array.isArray(b.floatBars)) {
      out.buttons.floatBars = b.floatBars.filter(d => d && typeof d === 'object' && /^[a-z0-9]{1,20}$/.test(d.id || '')).slice(0, 6)
        .map(d => ({ id: d.id, leftR: Number.isFinite(d.leftR) ? Math.max(0, Math.min(1, d.leftR)) : 0.4, topR: Number.isFinite(d.topR) ? Math.max(0, Math.min(1, d.topR)) : 0.4 }));
    }
    if (b.hidden && typeof b.hidden === 'object') {
      out.buttons.hidden = {};
      for (const id of Object.keys(b.hidden).slice(0, 40)) if (/^[a-z0-9-]{1,30}$/.test(id) && b.hidden[id]) out.buttons.hidden[id] = true;
    }
    if (b.face && typeof b.face === 'object') {
      out.buttons.face = {};
      for (const id of Object.keys(b.face).slice(0, 40)) {
        if (!/^[a-z0-9-]{1,30}$/.test(id)) continue;
        const txt = b.face[id] && b.face[id].text;
        if (typeof txt === 'string' && txt.length <= 24) out.buttons.face[id] = { text: txt.replace(/[<>]/g, '') };
      }
    }
    if (b.custom && typeof b.custom === 'object') {
      out.buttons.custom = {};
      for (const id of Object.keys(b.custom).slice(0, 40)) {
        if (!/^[a-z0-9-]{1,30}$/.test(id)) continue;
        const c = b.custom[id]; if (!c || typeof c !== 'object') continue;
        const o = {};
        const r = themeLen(c.radius); if (r) o.radius = r;
        const bw = themeLen(c.bw); if (bw) o.bw = bw;
        const bc = themeColor(c.bc); if (bc) o.bc = bc;
        const bg = themeColor(c.bg); if (bg) o.bg = bg;
        const col = themeColor(c.color); if (col) o.color = col;
        if (Object.keys(o).length) out.buttons.custom[id] = o;
      }
    }
  }
  out.appearance = {};
  if (t.appearance && typeof t.appearance === 'object') {
    const a = t.appearance;
    if (typeof a.darkMode === 'boolean') out.appearance.darkMode = a.darkMode;
    if (Number.isInteger(a.compactLevel) && a.compactLevel >= 0 && a.compactLevel <= 100) out.appearance.compactLevel = a.compactLevel;
    if (a.panelOpacity && typeof a.panelOpacity === 'object') {
      const p = {};
      for (const k of ['chat', 'hud', 'banners']) if (Number.isInteger(a.panelOpacity[k]) && a.panelOpacity[k] >= 0 && a.panelOpacity[k] <= 100) p[k] = a.panelOpacity[k];
      out.appearance.panelOpacity = p;
    }
  }
  return out;
}
registerLibrary({
  path: 'theme-lib', table: 'shared_themes', perUser: 40, searchCol: 'name', descCol: 'descr', facetCol: 'facets',
  cols: [{ name: 'name', type: 'TEXT' }, { name: 'descr', type: 'TEXT' }, { name: 'content', type: 'TEXT' }, { name: 'facets', type: 'TEXT' }, { name: 'size_bytes', type: 'INTEGER' }],
  validate(body) {
    const name = (body.name || '').toString().trim().slice(0, 40) || 'Theme';
    const descr = (body.desc || '').toString().trim().slice(0, 300);
    let t;
    try { t = typeof body.content === 'string' ? JSON.parse(body.content) : body.content; } catch (e) { return null; }
    const clean = sanitizeTheme(t);
    if (!clean) return null;
    clean.name = name;
    const content = JSON.stringify(clean);
    if (content.length > 100_000) return null;
    const facets = '|' + (clean.appearance && clean.appearance.darkMode ? 'dark' : 'light') + '|';
    return { name, descr, content, facets, size_bytes: content.length };
  },
  mapRow(r, me) {
    return { id: r.id, name: r.name, desc: r.descr || '', facets: r.facets || '', author: r.author_name, mine: r.author_id === me, content: r.content, likes: r.likes || 0, downloads: r.downloads, created_at: r.created_at };
  },
});

// ---- Shared FACES: one feature, or a whole face, that somebody else can wear ----
// ⭐⭐ THIS LIBRARY HOSTS NO BYTES AT ALL, and that is the point of sharing FEATURES rather than pictures. A
// feature is a style id, a position, a size, a rotation and some colours — or, for a drawing, a list of points.
// It is our own format, it is a couple of kilobytes, it scales to any zoom, and it is the same data an
// appearance already puts on the wire. A picture feature carries its REFERENCE, never its bytes, exactly as it
// does everywhere else, so sharing a face someone made out of a pasted eye costs this table twenty characters
// and the picture store one already-existing row.
const FACE_LIB_MAX_BYTES = 40_000;   // a whole face including drawn features; a plain one is a few hundred bytes
const FACE_LIB_FEAT_CAP  = 24;       // the same cap the client's own face has (FACE_MAX)
registerLibrary({
  path: 'face-lib', table: 'shared_faces', perUser: 60, searchCol: 'title', descCol: 'descr', facetCol: 'facets',
  cols: [{ name: 'title', type: 'TEXT' }, { name: 'descr', type: 'TEXT' }, { name: 'content', type: 'TEXT' },
         { name: 'facets', type: 'TEXT' }, { name: 'feat_count', type: 'INTEGER' }, { name: 'size_bytes', type: 'INTEGER' }],
  validate(body) {
    const title = (body.title || '').toString().trim().slice(0, 40) || 'Face';
    const descr = (body.desc || '').toString().trim().slice(0, 300);
    let c;
    try { c = typeof body.content === 'string' ? JSON.parse(body.content) : body.content; } catch (e) { return null; }
    if (!c || typeof c !== 'object') return null;
    // ⭐⭐ AN EXPRESSION IS A THIRD KIND OF THING IN THIS SAME LIBRARY, not a library of its own. A face, one
    // feature and a pose are all "something somebody made that you can wear", they all want the same browse,
    // the same search, the same take-it-down button and the same per-user quota — and the facet column already
    // exists to tell them apart. A second table would have been a second copy of all of that.
    // ⚠️ IT IS THE SMALLEST THING THIS SERVER HOSTS: seven numbers and at most two short style names, about
    // sixty bytes. The cap is not about space, it is about the shape being what it claims to be.
    if (c.pose && !c.feats) {
      const p = c.pose;
      if (typeof p !== 'object') return null;
      const out = {};
      for (const k of ['e', 'b', 'a', 'f', 'm', 'c', 'w', 'gx', 'gy']) {
        if (p[k] === undefined) continue;
        if (typeof p[k] !== 'number' || !isFinite(p[k])) return null;
        out[k] = Math.max(-1, Math.min(1, p[k]));
      }
      for (const k of ['ms', 'bs']) {
        if (p[k] === undefined) continue;
        if (typeof p[k] !== 'string' || !p[k] || p[k].length > 16) return null;
        out[k] = p[k];
      }
      if (!Object.keys(out).length) return null;
      const content = JSON.stringify({ pose: out });
      return { title, descr, content, facets: '|pose|', feat_count: 0, size_bytes: content.length };
    }
    if (!Array.isArray(c.feats)) return null;
    if (!c.feats.length || c.feats.length > FACE_LIB_FEAT_CAP) return null;
    for (const f of c.feats) {
      if (!f || typeof f !== 'object' || typeof f.k !== 'string' || f.k.length > 16) return null;
      // ⭐⭐ THE ONE RULE THAT KEEPS THIS TABLE SMALL: a picture is a reference, never bytes. Without this a
      // shared face is a place to put a megabyte of base64 and call it a feature — the exact door the picture
      // store's own size cap would not be covering, because this is a different endpoint.
      if (f.src != null) {
        if (typeof f.src !== 'string' || f.src.length > 400) return null;
        if (!/^(https?:\/\/\S|i:[0-9a-f]{4,32}$)/i.test(f.src)) return null;
      }
    }
    // The client sanitises what it wears, so this does not have to understand styles — only that the blob is
    // the right shape and small. Anything it does not recognise is dropped where it lands, not here.
    const content = JSON.stringify({ feats: c.feats, paint: Array.isArray(c.paint) ? c.paint : null });
    if (content.length > FACE_LIB_MAX_BYTES) return null;
    // One face or one feature: worth knowing before you download it, and it is the obvious way to browse.
    const facets = '|' + (c.feats.length === 1 ? 'one' : 'face') + '|';
    return { title, descr, content, facets, feat_count: c.feats.length, size_bytes: content.length };
  },
  mapRow(r, me) {
    return { id: r.id, title: r.title, desc: r.descr || '', facets: r.facets || '', author: r.author_name,
      mine: r.author_id === me, content: r.content, feat_count: r.feat_count,
      likes: r.likes || 0, downloads: r.downloads, created_at: r.created_at };
  },
});

function mulberry32(a) {                              // tiny deterministic PRNG (same family the client could mirror)
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Seeded procedural WORLD generation written straight into the existing terrain grid + object map
// (the terrain/object pipelines already render + collide all of it — no new client code). The surface
// sits near MID-HEIGHT, so there's open sky above and a deep, layered, biome-varied UNDERGROUND below.
// Phases: heightmap → surface biomes (6) drive the crust → depth-layered underground fill with per-region
// veins → cave carving (winding tunnels + broad deep chambers) → surface lakes + region-specific cave
// pools → surface scatter (rock mounds, trees, sky platforms) → underground scatter (crystals, mushrooms,
// bouncy fungus/crystal platforms, treasure). Deterministic from the seed. Client fog-of-war (16d) hides
// unexplored underground until the player gets near.
const MAT = { EARTH: 1, STONE: 2, SAND: 3, ICE: 4, MUD: 5, BOUNCY: 6, SNOW: 8, WATER: 9, QUICKSAND: 10, LAVA: 11, ACID: 12, BRINE: 14, OIL: 15 };
function generateWorld(avatarRoom, seed, band) {
  const grid = ensureTerrain(avatarRoom), hp = ensureTerrainHp(avatarRoom);
  const COLS = grid.geom.cols, ROWS = grid.geom.rows;   // Phase 6: generate at THIS room's shape, not the module constants
  grid.fill(0); hp.fill(0);
  // Phase 6: confine generation to the playable band + margin (null band = full world). Terrain/scatter
  // outside [genC0, genC1] is skipped so a small Level doesn't gen (or save) ground it can't reach.
  const genC0 = band ? Math.max(0, band.c0) : 0;
  const genC1 = band ? Math.min(COLS - 1, band.c1) : COLS - 1;
  const inBand = (c) => c >= genC0 && c <= genC1;
  const rng = mulberry32(seed);
  const set = (c, r, v) => { if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return; const i = c * ROWS + r; grid.s(i, v); hp.s(i, v ? matStrengthSrv({}, v) : 0); };
  const at = (c, r) => (c < 0 || c >= COLS || r < 0 || r >= ROWS) ? 0 : grid.g(c * ROWS + r);
  const bottomRow = Math.ceil(FLOOR_TOP / TERRAIN_CELL) - 1;            // last terrain row resting on the floor
  const baseRow = Math.round(bottomRow * 0.47);                        // mean surface row ≈ mid-height (deep underground below)
  // ALL-FINE gen scale: the feature sizes below were tuned in ROWS/COLUMNS for the 24px cell. As the cell shrank to 8px
  // the grid tripled, so an absolute row-count (crust, amplitude, offset) is 3× thinner physically and a spatial
  // frequency is 3× denser. G = 24/cell (=1 at 24px → gen is IDENTICAL; =3 at 8px) restores physical feature sizes:
  // multiply row/column sizes by G, divide frequencies by G.
  const G = 24 / TERRAIN_CELL;
  const CRUST = Math.round(4 * G);                                     // biome soil crust thickness (rows)
  // Heightmap: 3 octaves, random phase + amplitude (tuned for the wide world). Amplitudes ×G, frequencies ÷G.
  const p0 = rng() * Math.PI * 2, p1 = rng() * Math.PI * 2, p2 = rng() * Math.PI * 2;
  const a0 = (7 + rng() * 7) * G, a1 = (3 + rng() * 3) * G, a2 = (1 + rng() * 2) * G;
  const heightAt = (c) => { const h = Math.sin(c * 0.016 / G + p0) * a0 + Math.sin(c * 0.05 / G + p1) * a1 + Math.sin(c * 0.12 / G + p2) * a2; const s = Math.round(baseRow - h); return s < 6 * G ? 6 * G : (s > bottomRow - 10 * G ? bottomRow - 10 * G : s); };
  // Surface biomes: a slow field over the width → 6 biomes (drives crust material + trees + surface pools). Freqs ÷G.
  const bp0 = rng() * Math.PI * 2, bp1 = rng() * Math.PI * 2, bp2 = rng() * Math.PI * 2;
  const surfBiome = (c) => { const v = Math.sin(c * 0.010 / G + bp0) + 0.5 * Math.sin(c * 0.023 / G + bp1) + 0.3 * Math.sin(c * 0.043 / G + bp2);
    if (v > 1.05) return 'snow'; if (v > 0.35) return 'forest'; if (v < -1.05) return 'volcanic'; if (v < -0.5) return 'desert'; if (v < -0.1) return 'swamp'; return 'plains'; };
  // Underground biome regions: an independent slow field → 6 depth-regions (veins, cave pool fluid, scatter). Freqs ÷G.
  const gp0 = rng() * Math.PI * 2, gp1 = rng() * Math.PI * 2;
  const ugBiome = (c) => { const v = Math.sin(c * 0.0055 / G + gp0) + 0.6 * Math.sin(c * 0.015 / G + gp1);
    if (v > 1.15) return 'frozen'; if (v > 0.4) return 'fungal'; if (v < -1.15) return 'molten'; if (v < -0.45) return 'crystal'; if (v < -0.05) return 'sandstone'; return 'caverns'; };
  const seaRow = baseRow + Math.round(6 * G);                          // valleys deeper than this flood with Water
  // Flat spawn plateau, clamped above the water line so spawn is dry + level.
  const centerCol = Math.floor((MWSim.C.WORLD_W / 2) / TERRAIN_CELL);
  const plateauHalf = Math.ceil(SPAWN_CLEAR_HALF_W / TERRAIN_CELL) + Math.round(3 * G);
  let plateauSurf = heightAt(centerCol); if (plateauSurf > seaRow - 3 * G) plateauSurf = seaRow - 3 * G; if (plateauSurf < 6 * G) plateauSurf = 6 * G;
  const surf = new Int16Array(COLS);
  for (let c = 0; c < COLS; c++) surf[c] = (Math.abs(c - centerCol) <= plateauHalf) ? plateauSurf : heightAt(c);
  const crustMat = (biome, r, s) => biome === 'desert' ? MAT.SAND : biome === 'snow' ? (r === s ? MAT.SNOW : MAT.EARTH) : biome === 'swamp' ? MAT.MUD : biome === 'volcanic' ? MAT.STONE : MAT.EARTH;
  // ---- 1. Solid fill: biome crust over a depth-layered underground (dirt → stone+veins → deep) ----
  for (let c = 0; c < COLS; c++) {
    if (!inBand(c)) continue;
    const sB = (Math.abs(c - centerCol) <= plateauHalf) ? 'plains' : surfBiome(c);
    const uB = ugBiome(c);
    const s = surf[c];
    const dirtBot = s + CRUST + Math.round(8 * G) + ((rng() * 5 * G) | 0);   // bottom of the loose-dirt band
    const deepTop = bottomRow - Math.round(14 * G) - ((rng() * 6 * G) | 0);  // top of the deep band
    for (let r = s; r <= bottomRow; r++) {
      let v;
      if (r < s + CRUST) v = crustMat(sB, r, s);                       // biome crust
      else if (r < dirtBot) v = (rng() < 0.12) ? MAT.STONE : MAT.EARTH; // dirt (occasional stone nodules)
      else if (r < deepTop) {                                          // stone band with region veins
        v = MAT.STONE; const q = rng();
        if (uB === 'frozen' && q < 0.10) v = MAT.ICE;
        else if (uB === 'crystal' && q < 0.08) v = MAT.ICE;
        else if (uB === 'fungal' && q < 0.12) v = MAT.MUD;
        else if (uB === 'sandstone' && q < 0.14) v = MAT.SAND;
        else if (q < 0.05) v = MAT.EARTH;
      } else v = (uB === 'sandstone' && rng() < 0.12) ? MAT.SAND : MAT.STONE;   // deep band
      set(c, r, v);
    }
  }
  // ---- 2. Caves: mostly NARROW winding passages with natural dead ends; occasional small chambers (deeper).
  // The `worm` field carves thin tunnels wherever it dips near a ridge line; the small extra `chamber` term
  // opens the rare wider pocket. Kept tight on purpose so the underground reads as tunnels to squeeze through,
  // not one big open void. Biome crust is left intact. ----
  const cp0 = rng() * Math.PI * 2, cp1 = rng() * Math.PI * 2, cp2 = rng() * Math.PI * 2, cp3 = rng() * Math.PI * 2, cp4 = rng() * Math.PI * 2;
  for (let c = 0; c < COLS; c++) {
    if (!inBand(c)) continue;
    const top = surf[c] + CRUST + 1;
    for (let r = top; r <= bottomRow; r++) {
      const i = c * ROWS + r; if (!grid.g(i)) continue;
      const depth = (r - top) / Math.max(1, bottomRow - top);
      const worm = Math.abs(Math.sin((c * 0.06 + r * 0.033) / G + cp0) + Math.sin((c * 0.025 - r * 0.052) / G + cp1) + Math.sin((c + r) * 0.041 / G + cp2));
      const chamber = Math.sin((c * 0.018 + r * 0.022) / G + cp3) + Math.sin((c * 0.034 - r * 0.013) / G + cp4);   // rare small pockets
      if (worm < 0.24 + depth * 0.12 || chamber > 1.86 - depth * 0.26) { grid.s(i, 0); hp.s(i, 0); }     // narrow tunnels + occasional pocket
    }
  }
  // ---- 3a. Surface lakes: flood valley air below sea level with Water ----
  for (let c = 0; c < COLS; c++) if (inBand(c) && surf[c] > seaRow) for (let r = seaRow; r < surf[c]; r++) set(c, r, MAT.WATER);
  // ---- 3b. Cave pools: shallow fluid resting on cave floors. ONE liquid per underground region (no random
  // mixing) so each area reads coherently — molten→Lava, sandstone→Quicksand, fungal→Brine, everywhere
  // else→Water. Patchy along the width via a wet field; molten always seeps at the very bottom. ----
  const wp = rng() * Math.PI * 2, wp2 = rng() * Math.PI * 2, POOL_DEPTH = Math.round(4 * G);
  const regionFluid = { molten: MAT.LAVA, sandstone: MAT.QUICKSAND, fungal: MAT.BRINE, frozen: MAT.WATER, crystal: MAT.WATER, caverns: MAT.WATER };
  for (let c = 0; c < COLS; c++) {
    if (!inBand(c)) continue;
    const uB = ugBiome(c);
    const fluid = regionFluid[uB] || MAT.WATER;
    const wet = Math.sin(c * 0.02 / G + wp) + 0.5 * Math.sin(c * 0.061 / G + wp2);
    const wetOK = uB === 'molten' ? true : wet > 0.25;                 // molten always seeps; others patchy
    const tableRow = uB === 'molten' ? bottomRow - Math.round(10 * G) : surf[c] + CRUST + Math.round(14 * G);   // no cave pools too near the surface
    if (!wetOK) continue;
    for (let r = bottomRow; r >= tableRow;) {
      if (grid.g(c * ROWS + r) !== 0) { r--; continue; }         // solid — skip
      if (at(c, r + 1) === 0 && r < bottomRow) { r--; continue; }      // open with no floor below — air, skip
      let d = 0;                                                       // fill a shallow pool up from the floor
      while (r >= tableRow && grid.g(c * ROWS + r) === 0 && d < POOL_DEPTH) { set(c, r, fluid); r--; d++; }
      while (r >= 0 && grid.g(c * ROWS + r) === 0) r--;          // skip the air gap above until the next solid
    }
  }
  // ---- 4. Objects ('world'-owned, FIFO-exempt): surface trees/rocks + sky platforms, then underground scatter ----
  if (!roomObjects[avatarRoom]) roomObjects[avatarRoom] = new Map();
  const objs = roomObjects[avatarRoom];
  const OBJ_CAP = 190;
  const clearX0 = MWSim.C.WORLD_W / 2 - SPAWN_CLEAR_HALF_W - 64, clearX1 = MWSim.C.WORLD_W / 2 + SPAWN_CLEAR_HALF_W + 64;
  const dryLand = (c) => surf[c] <= seaRow && !!grid.g(c * ROWS + surf[c]);   // solid, non-flooded surface
  const outsideSpawn = (wx) => wx < clearX0 || wx > clearX1;
  const treeFor = { plains: '🌳', forest: '🌲', desert: '🌵', snow: '🌲', swamp: '🌿', volcanic: '🪨' };
  let wn = 0;
  const addObj = (o) => { if (wn >= OBJ_CAP) return false; o.id = 'world-' + wn; o.ownerId = 'world'; o.owner = 'world'; objs.set(o.id, o); wn++; return true; };
  for (let c = Math.max(8, genC0); c < Math.min(COLS - 8, genC1); c += Math.round(6 * G)) {   // surface rock mounds (terrain); step ×G keeps physical spacing
    if (rng() > 0.10 || !dryLand(c) || !outsideSpawn((c + 0.5) * TERRAIN_CELL)) continue;
    const hgt = (1 + (rng() * 2 | 0)) * G;
    for (let k = 0; k < hgt; k++) { set(c, surf[c] - 1 - k, MAT.STONE); if (rng() > 0.5) set(c + 1, surf[c + 1] - 1 - k, MAT.STONE); }
  }
  for (let c = Math.max(5, genC0); c < Math.min(COLS - 5, genC1); c += Math.round(4 * G)) {   // surface trees (narrow solid stamps); step ×G keeps physical spacing
    if (rng() > 0.16 || !dryLand(c) || !outsideSpawn((c + 0.5) * TERRAIN_CELL)) continue;
    const h = 58 + (rng() * 28 | 0), w = Math.round(h * 0.5);
    addObj({ type: 'stamp', x: (c + 0.5) * TERRAIN_CELL, y: surf[c] * TERRAIN_CELL - h / 2,
      content: treeFor[surfBiome(c)] || '🌳', w, h, shape: 'rect', angle: 0, stretch: false, hp: 3 });
  }
  const platLo = Math.max(10, genC0), platHi = Math.min(COLS - 10, genC1);   // sky platforms (indestructible) for traversal
  const plats = platHi > platLo ? 8 + (rng() * 6 | 0) : 0;
  for (let k = 0; k < plats; k++) {
    const c = platLo + (rng() * (platHi - platLo) | 0), wx = (c + 0.5) * TERRAIN_CELL;
    const y = surf[c] * TERRAIN_CELL - (90 + rng() * 240);
    if (!outsideSpawn(wx) || y < TERRAIN_CELL * 3 * G) continue;   // ×G: keep the same physical top-margin (72px)
    addObj({ type: 'platform', x: wx, y, w: 110 + (rng() * 120 | 0), h: 16, angle: 0, spin: 0, boost: 0, updraft: 0, fanLen: 1, fanMode: 'push', fanPeriod: 2, hp: null });
  }
  // Underground scatter: props + the occasional bouncy fungus/crystal platform, resting on cave floors.
  const cryFor = { frozen: '❄️', crystal: '💎', fungal: '🍄', sandstone: '🪨', caverns: '💧', molten: '' };
  for (let c = Math.max(4, genC0); c < Math.min(COLS - 4, genC1); c += Math.round(3 * G)) {   // underground scatter; step ×G keeps physical spacing
    if (wn >= OBJ_CAP) break;
    const uB = ugBiome(c);
    for (let r = surf[c] + CRUST + Math.round(6 * G); r <= bottomRow - 1; r++) {
      const here = grid.g(c * ROWS + r), below = at(c, r + 1);
      if (here !== 0) continue;                                        // need an open cell…
      if (below === 0 || TERRAIN_MATS_FLUID(below)) continue;         // …resting on a SOLID floor (not fluid/air)
      const wx = (c + 0.5) * TERRAIN_CELL;
      if (!outsideSpawn(wx)) continue;
      if ((uB === 'fungal' || uB === 'crystal') && rng() < 0.05) {     // bouncy mushroom / crystal spring platform
        if (addObj({ type: 'platform', x: wx, y: (r + 1) * TERRAIN_CELL - 10, w: 70 + (rng() * 40 | 0), h: 16, angle: 0, spin: 0, boost: 0, updraft: 0, fanLen: 1, fanMode: 'push', fanPeriod: 2, bouncy: 1, hp: null })) break;
      } else if (rng() < 0.12) {                                       // decorative/breakable cave prop
        const emoji = cryFor[uB] || '🪨'; if (!emoji) continue;
        const sz = 30 + (rng() * 22 | 0);
        if (addObj({ type: 'stamp', x: wx, y: (r + 1) * TERRAIN_CELL - sz / 2, content: emoji, w: sz, h: sz, shape: 'rect', angle: 0, stretch: false, hp: 2 })) break;
      }
    }
  }
}
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  PHASE 6 INCREMENT 4 — THE SECOND GENERATOR (chunk-on-demand). See server/worldgen.js for the design.
//  `generateWorld` above is UNTOUCHED and still owns page rooms. This is the generator the Overworld needs,
//  because the Overworld cannot be built up front: terrain there has to be a pure function of (seed, column,
//  row) so any 64x64 chunk can be produced alone, thrown away, and produced again identically.
//  ⚠️ SHIPS OFF (`worldCfg.chunked = 0`). While it is off, not one line of world generation changes.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const worldCfg = {
  // ⭐⭐ THE REDESIGNED GENERATOR IS THE DEFAULT NOW (user, 2026-08-05: *"why do we even still have the old
  // generator? Why don't page worlds just load into the new generator version by default"*). They are right:
  // it was eyeballed and confirmed on page worlds, on-demand production was verified in-browser, and keeping
  // the old one as the default meant every page world was built by code we no longer intend to keep — while
  // the new one only ever ran when somebody remembered to tick two boxes. Two things to maintain, one of them
  // untested in normal use, which is exactly the complaint.
  // ⚠️ `generateWorld` (the legacy one) is NOT deleted, and that is deliberate rather than hedging:
  // `probe_worldgen` Part D is an A/B against it — same seed, both generators — and it is how the redesign's
  // structural stats are kept honest. It is now reachable only by explicitly unticking this.
  chunked: 1,          // 0 = generateWorld (legacy, A/B only) · 1 = worldgen.js. Applies to worlds generated from now on.
  // ⭐ Send each chunk's UNCARVED ground with its content, so the client can draw the world behind a hollow
  // from what was actually there rather than from whatever rock is nearest now. Costs one generator pass per
  // chunk sent and carries only the cells that will be drawn (uncarved rock where the terrain is now open), so
  // a chunk of solid bedrock and a chunk of sky both send nothing at all. Off = the client derives it.
  backing: 1,
  onDemand: 1,         // 4b: with `chunked`, do not build the world at all — produce each chunk when it is first read.
  // ⭐⭐ THE EDIT TRACE — a diagnostic for "I dug this out and it came back". Off by default, live-togglable on
  // the liquid-cfg wire (`worldTrace`), because the question it answers cannot be answered by reading: a dug
  // cell that reappears was either NEVER CARVED ON THE SERVER (the client and the server disagreed at edit
  // time) or CARVED AND THEN PUT BACK (the chunk was judged unchanged and regenerated from the seed). Those
  // two have identical symptoms and completely different causes.
  // It logs, per carve: the box, how many cells the server's own raster actually changed, and the hp left on
  // the cells it merely chipped. And per chunk eviction: whether the diff came out EMPTY — i.e. whether the
  // server thinks nobody has touched that chunk — which is the second cause, stated directly.
  trace: 0,
  // ⭐ A SECOND TRACE, FOR THE PERSISTENCE PATH SPECIFICALLY, AND IT IS AN ENV VAR RATHER THAN A WIRE TOGGLE
  // BECAUSE OF WHAT IT HAS TO WATCH. `trace` above is set over the socket, which is fine for a symptom you can
  // reproduce while connected — but the thing being chased here is what happens ACROSS A RESTART, and a wire
  // toggle dies with the process it was set on. `MW_TRACE_PERSIST=1` (restart-server.ps1 -TracePersist) is
  // picked up by both halves of the run.
  // It logs the four points the restart path actually goes through and nothing else: a chunk written to disk, a
  // stored terrain edit laid over freshly generated ground, a stored liquid diff applied, and — the one worth
  // having — a liquid diff being ENCODED against an absent liquid page, which writes "there is no liquid here"
  // for every generated fluid cell in the chunk.
  tracePersist: process.env.MW_TRACE_PERSIST ? 1 : 0,
  dropPristine: 1,     // 4c: evict an UNCHANGED chunk to nothing at all rather than storing a blob of it.
                       // ⚠️ Defaults ON because it only ever applies to rooms `onDemand` produced, which itself ships OFF —
                       // and where it applies, NOT doing it is measurably worse than doing it (the blob is 1.93x the pages).
  // ⭐⭐ INCREMENT 7 — THE OVERWORLD ITSELF. With this on, a 'world' join goes to ONE shared world instead of a
  // per-page one, and the page you came from decides only WHERE IN IT YOU ARRIVE. That is the whole Stage 7
  // model: identity (which page you are) is separate from location (which column you spawn at).
  // ⭐⭐ ON BY DEFAULT 2026-08-10, THE USER'S CALL, TAKEN WITH THE GAPS STATED AND ACCEPTED:
  //   · NOTHING PERSISTS — no per-chunk diff is written to disk, so a server restart discards everything
  //     anybody has built in the Overworld. This is the next thing to fix.
  //   · no objects or trees generate (blocked on an object-streaming design that does not exist)
  //   · the no-build box that protects a spawn point is off, because there are thousands of spawn points.
  // ⚠️ It IMPLIES chunked + onDemand for the Overworld room regardless of those flags: a 524,224 x 4,096 world
  // cannot be built eagerly, and `ensureWorldGenerated` reads `overworldRooms` rather than the flags for that
  // reason. Turning this on without them is not a broken combination, it is simply not a combination.
  overworld: 1,
  // ⭐⭐ PORT INCREMENT 6 — THE REDESIGNED WORLD (server/worldgen2.js). Ships OFF.
  // With this on, a world is built by the ported spike instead of worldgen.js: designed landforms, 17 biomes,
  // a layered underground, real cave mouths, karst, rimstone, sky islands, an ocean with a floor worth swimming
  // to. `probe_worldgen2` (48 checks) guards it and proves it delivers the spike's world cell for cell.
  // ⚠️ IT IMPLIES chunked + onDemand, for the same reason `overworld` does: worldgen2 has no eager whole-world
  // path and is not meant to have one.
  // ⚠️ THE FIRST JOIN INTO A gen2 ROOM BLOCKS THE SERVER FOR ~2 SECONDS while the layout pass runs
  // (buildWorld + prepare, measured at ~2.1s and ~5MB). That is plan risk R3, it is known, and it is per ROOM
  // per server lifetime. Acceptable for one Overworld; it is why page rooms keep worldgen.js.
  // ⭐⭐ ON BY DEFAULT 2026-08-10 (user's call, after eyeballing it): *"since this all seems to work, can we go
  // about making it the default and only generator"*. `worldgen.js` is NOT deleted — it stays reachable by
  // unticking this, as the rollback path the whole port was built around. Delete it once this has had real use.
  gen2: 1,
};
// ⭐⭐ THE LAYOUT IS SHARED; ONLY THE WINDOW IS PER ROOM. `buildWorld` + `prepare` cost ~1.8-2.5s and depend on
// nothing but the layout seed, so building one PER ROOM would freeze the whole server for that long every time
// anybody opened a new page — which is exactly why the plan had page rooms staying on `worldgen.js`. A room
// takes a WINDOW on a shared layout instead: the room's own seed picks where the window sits, so every page is
// still a different place, and the second room off a layout costs 0ms (measured).
// ⚠️ TWO LAYOUTS, NOT ONE, and the reason is the user's: page rooms must be a *separate instance* from the
// Overworld *"so as to not take up space inside the existing overworld"*. Sharing a layout would satisfy that
// literally (different rooms, different edits) but would put a page's ground in the Overworld's landscape.
// A second layout is ~5MB and one more build.
// ⚠️ THE OVERWORLD'S SEED IS THE WORLD. Changing it replaces the entire landscape — every region, every
// volcano, every coastline — and stored player edits are diffs against generated ground, so `WORLDGEN2_VERSION`
// must move with it or those diffs get applied to different rock and reported as restored. Bumped to 10 for
// exactly this change; the seed itself is not stamped on a diff, so the version is the only guard there is.
// 1234 chosen 2026-08-11 by comparing rendered terrain across seeds (`render_overworld_terrain.js`).
// The page layout is deliberately untouched: page rooms are a separate instance, and there is no reason to
// throw their worlds away too.
const GEN2_LAYOUT_SEED = { overworld: 1234, page: 0x0ADE0001 };
const _gen2Layouts = new Map();
function gen2LayoutFor(which) {
  const seed = GEN2_LAYOUT_SEED[which];
  let L = _gen2Layouts.get(seed);
  if (!L) {
    const t0 = Date.now();
    L = WORLDGEN2.layoutFor(seed);
    console.log(`worldgen2: built the ${which} layout in ${Date.now() - t0}ms (once per server lifetime)`);
    _gen2Layouts.set(seed, L);
  }
  return L;
}
const _roomGens = new Map();                          // avatarRoom → the generator for its seed+shape, built once
const _roomWideSurf = new Map();                      // …and its whole-world surface profile: see wideSurfFor
// Everything worldgen.js needs to know about a room, gathered in one place so there is one definition of
// "what shape and seed is this world" rather than several that can drift.
function genCfgFor(avatarRoom, seed, band) {
  const d = roomDims(avatarRoom);
  // ⭐ `overworld` decides two things and only two: the whole biome catalogue rather than a seeded selection of
  // two to four of it, and continent-sized horizontal features rather than a page-sized landscape. It is read
  // from the same `overworldRooms` set `roomDims` uses, so a room's shape and its content agree by construction.
  return { seed, cols: d.cols, rows: d.rows, cell: TERRAIN_CELL, floorTop: roomFloorTop(avatarRoom),
    overworld: overworldRooms.has(avatarRoom),
    spawnX: MWSim.C.WORLD_W / 2, spawnHalfW: SPAWN_CLEAR_HALF_W, band, strength: BUILTIN_STRENGTH };
}
function genFor(avatarRoom, seed, band) {
  let g = _roomGens.get(avatarRoom);
  if (!g) {
    const cfg = genCfgFor(avatarRoom, seed, band);
    // ⚠️ Which generator a room uses is decided ONCE, when its generator is first built, and then never
    // re-read. That is deliberate: a room's stored diffs are taken against its generator's ground, so a room
    // that changed generator mid-life would be applying tunnels to different rock. Flipping the flag affects
    // rooms created from here on — the same rule `worldChunked` already follows.
    if (worldCfg.gen2) {
      // The room's own seed still decides WHERE it lands; the layout decides what world it lands in.
      cfg.layout = gen2LayoutFor(overworldRooms.has(avatarRoom) ? 'overworld' : 'page');
      g = WORLDGEN2.makeGen2(cfg);
    } else {
      g = WORLDGEN.makeGen(cfg);
    }
    _roomGens.set(avatarRoom, g);
  }
  return g;
}
// Which generator made this room's ground, as a version number. ⚠️ NOT a global: two generators can be live at
// once, so "the current version" is a property of the ROOM. `_genRooms` holds on-demand rooms; `_roomGens` holds
// every room that has a generator at all, and a room with neither predates generation and keeps worldgen.js's.
genVersion = function (room) {
  const g = _genRooms.get(room) || _roomGens.get(room);
  return (g && g.version) || WORLDGEN.WORLDGEN_VERSION;
};
// The whole world, built one page at a time through exactly the code path a single on-demand page fault will
// take. That is deliberate: it means the eager path and the on-demand path cannot produce different worlds,
// because they are the same function called in a different order — which is the property `probe_worldgen`
// Part B asserts (page order changes nothing).
function generateWorldChunked(avatarRoom, seed, band) {
  const grid = ensureTerrain(avatarRoom), hp = ensureTerrainHp(avatarRoom);
  grid.fill(0); hp.fill(0);
  const geom = grid.geom, gen = genFor(avatarRoom, seed, band);
  const page = new Uint8Array(CHUNK_CELLS), hpPage = new Uint8Array(CHUNK_CELLS);
  for (let p = 0; p < geom.nPages; p++) {
    page.fill(0); hpPage.fill(0);
    gen.fillPage(page, hpPage, p, geom, 1);
    // Only fault a page in if the generator actually put something there — sky is most of a world, and an
    // all-air page must stay absent or increment 2's sparse storage is undone at generation time.
    let any = 0; for (let k = 0; k < CHUNK_CELLS; k++) if (page[k]) { any = 1; break; }
    if (!any) continue;
    grid.wpPage(p).set(page); hp.wpPage(p).set(hpPage);
  }
  // ⚠️ OBJECTS ARE NOT GENERATED HERE, and that is a real gap rather than an oversight: `generateWorld` also
  // places trees, sky platforms and cave props into `roomObjects`, which is one per-room Map broadcast whole to
  // every client. That does not survive an infinite world and needs an object-streaming design that does not
  // exist yet. A world made by this generator therefore has terrain but no props. Recorded, not forgotten.
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  INCREMENT 4b — ON-DEMAND GENERATION. The half that actually makes the Overworld possible: the world is never
//  built. Each chunk is produced the first time something reads it, and a chunk nobody has read does not exist.
//
//  ⭐ THE HOOK IS `PagedArray.seedFn`, WHICH ALREADY EXISTED (for fineLevelAcc's per-cell phase), and the read
//  path already did the right thing: a seeded array materialises on READ as well as write, because otherwise an
//  untouched cell reads 0 — and Phase 3 recorded exactly what that costs ("any unloaded state must be invisible
//  to READERS, or the sim silently treats unloaded as empty": liquid poured through evicted ground at chunk
//  seams). Generated-but-not-yet-produced is the same hazard wearing a different hat, and it gets the same
//  answer: reads see the ground.
//
//  ⭐ AND THE EXPOSURE IS BOUNDED BY CONSTRUCTION, which is the thing that made this safe to do at all.
//  A seedFn means "every read of an unproduced page produces it", so the question is who reads far away:
//    · the liquid sim reads only ACTIVE cells and their neighbours, which chunk residency already keeps near
//      players;
//    · `terrainRLE` (the join replay) and `chunkHash` read through `pageAt`, which does NOT fault — so they
//      see only what exists, which is exactly right for a world too big to replay;
//    · `scan`/`some`/`eachPage` walk the pages that EXIST;
//    · `sendChunkContent` reads through `.g()` and therefore DOES produce — and it is driven by chunk
//      subscriptions, i.e. by what a player can see. That is the eager path, and it needs no separate loop.
//  So nothing has to police the bound; the only whole-world readers were already non-faulting.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const _genRooms = new Map();                          // avatarRoom → generator, for rooms produced on demand
// One page of scratch shared by the terrain and hp seeders. They are two separate PagedArrays with two separate
// seed functions, but one call to `fillPage` produces both — so whichever faults first fills the pair and the
// other reads it back, halving the cost instead of generating the same chunk twice.
// 🟥🟥 THIS WAS A SINGLE SLOT, AND THE CALLER GUARANTEES IT MISSES. `sendChunkContent` is deliberately TWO
// passes — produce every chunk, drain the deferred liquid, then read it all out — so by the time the readout
// asks for chunk 1's HP page, the slot holds chunk 32's. Every HP page in a batch was therefore regenerated
// from scratch, which is the whole point of the memo defeated by the shape of its only hot caller.
// MEASURED on the live server with `MW_TRACE_SUBS` (restart-server.ps1 -Trace), a 32-chunk batch:
//     produced 32 chunks in 173ms · readout done ... 347ms      ⇐ and `pagesProduced` climbed by 32 DURING the
//                                                                  readout, i.e. the second 174ms is the same
//                                                                  32 chunks being generated a second time.
// ⚠️ It was invisible at `queueBatch = 1`, where produce-then-read-out for one page hits the slot — which is
// exactly why the single-chunk trace reads a healthy 7+1+1+1 and the batch reads 10.8ms/chunk. Do not conclude
// from the queued path that batched callers are fine: `flushPending` takes 16, `chunk-verify` 12, and the
// synchronous path takes the client's whole list.
// ⚠️ KEYED ON THE GENERATOR TOO, not just room+page: which rock a page number means is a property of the
// generator instance, and two can be live at once (worldgen + worldgen2).
// Bounded to a couple of window-fulls; 8KB a page (terrain + hp).
// ⭐ 1024 SINCE 2026-08-22, up from 192, and the number is a MEASUREMENT: the residency sweep's own log reports
// **473–641 chunks resident** during a long traversal, so a 192-entry cache was thrashing against the live
// working set. 8KB an entry (terrain + hp) ⇒ ~8MB, which is nothing beside what it saves.
const GEN_MEMO_MAX = 1024;
// ⚠️ KEYED ON THE GENERATOR, NOT THE ROOM. `encodeChunkDelta` — the eviction and flush path, and the biggest
// consumer of this cache — is handed a generator and a page and has no room in scope at all. Each room builds
// its own generator (`_roomGens`), so the generator identifies the rock just as well as the room does, and a
// WeakMap serial keeps the key a short string without pinning dead generators alive.
let _genSerial = 0;
const _genIds = new WeakMap();
const genIdOf = (g) => { let id = _genIds.get(g); if (id == null) _genIds.set(g, id = ++_genSerial); return id; };
const _genMemo = new Map();                           // "genId:p" → { t, h, fresh }
function _genMemoGet(p, gen) {
  const k = genIdOf(gen) + ':' + p, e = _genMemo.get(k);
  if (e) return e;
  const rec = { t: new Uint8Array(CHUNK_CELLS), h: new Uint8Array(CHUNK_CELLS), fresh: true };
  if (_genMemo.size >= GEN_MEMO_MAX) { const old = _genMemo.keys().next().value; _genMemo.delete(old); }
  _genMemo.set(k, rec);
  return rec;
}
// The seam `encodeChunkDelta` calls (declared as a no-op inside the cell-store block — see the note there).
// ⚠️ COPIES OUT rather than handing the cached arrays over: the caller owns its scratch buffers and the diff
// compares against them, so aliasing the cache into a caller that might write to it would corrupt every
// subsequent hit. A 4KB memcpy against a 2.5ms generation is not a trade worth thinking about.
genPageCached = (gen, p, geom, t, h) => {
  const m = _genMemoGet(p, gen);
  if (m.fresh) { gen.fillPage(m.t, m.h, p, geom, 1); m.fresh = false; }
  t.set(m.t); h.set(m.h);
};
// A room key is a URL, so the separator has to be something a URL cannot contain. Written as an ESCAPE, not
// as a literal: a raw NUL byte in the source makes grep treat index.js as a binary file, which quietly breaks
// every text search over the server.
const GEN_SEP = '\u0000';
const _genPending = new Set();                        // "room page" — produced, liquid not yet seeded (see below)
function genSeedFn(field, room) {
  return function (page, p, geom) {
    const g = _genRooms.get(room); if (!g) return;
    const memo = _genMemoGet(p, g);
    if (memo.fresh) { g.fillPage(memo.t, memo.h, p, geom, 1); memo.fresh = false; }
    page.set(field === 'terrain' ? memo.t : memo.h);
    genPagesProduced++;
    // ⭐⭐ PERSISTENCE ON A COLD START, AND THIS IS THE SEAM IT HAS TO BE. After a restart nothing is "evicted" —
    // the chunks simply do not exist — so `restoreChunk` is never reached and the ground is PRODUCED instead.
    // A stored edit therefore has to be laid over the freshly generated page here, at birth.
    // ⚠️ NO DATABASE I/O ON THIS PATH, and that is load-bearing rather than tidy: a page fault can arrive from
    // deep inside `fineLiquidTickRoom` while it iterates the active-cell Set, so a synchronous row read here
    // would put disk latency straight on the tick. The room's stored edits are loaded into memory in one go
    // (`storedFor`), and this is a Map lookup and a short write loop — nothing else.
    applyStoredEdit(room, p, page, field);
    // ⚠️ ONLY A FIRST PRODUCTION QUEUES LIQUID. An EVICTION restore also runs this seedFn — `_alloc` seeds and
    // then lets `rehydrateChunk` decode the blob over the top — and re-seeding liquid from the regenerated
    // terrain afterwards would resurrect a lake that had since drained, clobbering the restored state.
    // `evicted[p]` is precisely the "this is a restore, not a birth" flag.
    const _ch = chunksOf(room);
    if (!_ch.evicted[p] && !_ch.peek(p).restoring) _genPending.add(room + GEN_SEP + p);
  };
}
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  PERSISTENCE, WIRED. The three hooks declared as no-ops inside the cell-store block get their real bodies
//  here, OUTSIDE it — the `wireFanout` seam. `probe_worldgen` guards this as a class.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Which chunks of a room have stored edits. Loaded ONCE per room, as indices only: the hot path (a page fault,
// which can come from inside the liquid tick) must never touch the database, and the overwhelming majority of
// chunks have no row at all. The blob itself is read only for a chunk actually in this set.
const _listChunkRows = db.prepare('SELECT chunk, ver, kind, terrain, liquid FROM world_chunks WHERE room = ?');
function storedFor(room) {
  let m = _storedChunks.get(room);
  if (!m) {
    m = new Map();
    const want = genVersion(room);
    let stale = 0;
    try {
      for (const r of _listChunkRows.all(room)) {
        // 🟥 A STALE ROW IS DROPPED, NOT APPLIED. A diff is meaningless without the ground it was taken
        // against, so applying one across a generator change would cut somebody's tunnel through different
        // rock. Losing the edit is the correct loss; silent corruption is not.
        if (r.ver !== want || !r.terrain) { stale++; continue; }
        const b = unpackDelta(Buffer.from(r.terrain), r.ver, r.kind | 0);
        if (!b) { stale++; continue; }
        b.liq = r.liquid ? Buffer.from(r.liquid) : null;   // the liquid half rides the same row and the same version check
        m.set(r.chunk | 0, b);
        worldLoaded++;
      }
    } catch (e) { console.log('world_chunks load failed: ' + e.message); }
    _storedChunks.set(room, m);
    if (m.size || stale) console.log(`world persistence: ${m.size} stored chunk(s) for ${room}`
      + (stale ? `, ${stale} dropped as stale (generator version changed)` : ''));
    if (stale) { try { db.prepare('DELETE FROM world_chunks WHERE room = ? AND ver != ?').run(room, want); } catch (e) { /* best effort */ } }
  }
  return m;
}
saveChunkBlob = function (room, p, blob, pristine) {
  // ⭐ A CHUNK THAT IS BACK TO PRISTINE DROPS ITS ROW, and that is not tidiness. Fill in the hole you dug and it
  // is generated ground again — leaving the old row behind means the next restart re-applies a diff describing a
  // hole that no longer exists. "Nothing to store" has to be written down as nothing, exactly as a drained lake
  // needs an explicit empty marker rather than an absent one.
  // 🟥🟥 BUT THE TEST USED TO BE `!blob || !blob.d`, AND THAT ONE CONDITION MEANT THREE COMPLETELY DIFFERENT
  // THINGS — all of which deleted somebody's work:
  //     · the chunk really is pristine                                  ⇒ delete, correct
  //     · the diff was too big to encode (>= 2,048 changed cells)       ⇒ DELETED THE PLAYER'S BUILD
  //     · the terrain page was not resident so we could not even look   ⇒ DELETED IT ON NO EVIDENCE AT ALL
  // Reproduced end to end in scratchpad/e2e_chunk_threshold.js. The 30-second flush beside this already got it
  // right (`if (!d) continue;` — it declines to write and leaves the row alone), so the two callers of one save
  // routine disagreed about what an absent diff meant, and that disagreement was the bug.
  // ⇒ deletion is now an EXPLICIT decision by the caller, which is the only place that knows why the diff is
  // missing. No blob and no `pristine` means "I could not encode this" and the stored row is left exactly as it
  // is: a stale row loses the LATEST edits, which is bad, but it does not delete what is already safely on disk.
  if (!blob || !blob.d) {
    if (!pristine) return;
    if (storedFor(room).delete(p | 0)) { try { _delChunkRow.run(room, p); } catch (e) { /* best effort */ } }
    return;
  }
  persistChunkBlob(room, p, blob, genVersion(room));
  storedFor(room).set(p | 0, blob);                    // keep memory and disk agreeing without a re-read
};
// ⭐⭐ WRITING AT EVICTION IS NOT ENOUGH ON ITS OWN, and the gap is exactly the case anybody would test first.
// A chunk is written when it is put AWAY, which is precisely when nobody is looking at it — so the ground you
// are standing on, the hole you have just dug, is the one part of the world that has never been saved. Pull the
// plug then and you lose the most recent change you made, which is the one you would go and check for.
// ⇒ a periodic sweep of RESIDENT chunks. It is cheap because it asks the content hash first, and that hash is
// cached against the summed page revisions — so an untouched chunk costs one integer comparison, and the ~0.9ms
// regenerate-and-compare is paid only by chunks that have actually changed since they were last written.
// ⚠️ CAPPED PER PASS. A room with a lot of liquid moving can present many changed chunks at once and a flush must
// never become a stall; the remainder simply carries to the next pass.
// ⚠️ Generated rooms only. A published or hand-built room has no generator to diff against and persists through
// an entirely different path (`published_worlds`).
let worldFlushes = 0, worldFlushWrites = 0;
const WORLD_FLUSH_MS = 30000, WORLD_FLUSH_MAX = 48;
// How many chunks one periodic flush may DIFF. The real bound on the flush's cost — see worldFlush, where a
// world of pristine chunks made the write cap above unreachable. MEASURED at 64: "flush took 183ms — 64 chunks
// diffed, 0 WRITTEN", i.e. ~2.5ms a diff and all of it wasted on pristine ground. 24 keeps the hitch under ~60ms.
// ⚠️ THE TRADE IS SWEEP RATE, and it is worth stating: a chunk somebody EDITED is only persisted by the flush
// that reaches it, so a lower cap means a longer worst-case wait for an edit made in a RESIDENT chunk. Eviction
// still writes immediately, and once a pristine chunk has been examined its `savedHash` makes it free to skip
// for ever after, so the expensive sweep is a one-time cost per chunk rather than a standing one.
const WORLD_FLUSH_WORK = 24;
// 🟥🟥 THE WRITE CAP DID NOT CAP THE WORK, AND A GENERATED WORLD DEFEATS IT COMPLETELY.
// `wrote` only counts NON-PRISTINE deltas — but a freshly explored Overworld is almost entirely pristine, so
// `wrote` stayed at 0, `wrote >= cap` never tripped, and this ran `chunkDelta` on EVERY resident page. A delta
// is taken against what the generator would produce, i.e. it REGENERATES the chunk to diff it. So every 30
// seconds the server re-generated everything the player had ever walked past, synchronously, on the main loop.
// ⭐ AND IT GROWS WITH EXPLORATION, WHICH IS EXACTLY THE REPORTED SHAPE: *"it seems to get slower or have more
// trouble keeping up as you pass more terrain… maybe it's getting 'full' or overloaded or not dumping things
// fast enough."* Measured with `--long`: arrival held at ~88ms median for 80 steps, then one 6-second window
// went to 657ms median / 1810ms p90 / 2032ms worst, then recovered — a periodic stall, not a slow decline, and
// `chunkQMs` sat at 5-7ms of its 20ms allowance throughout, so the queue was idle while it happened.
// ⇒ THE CAP NOW COUNTS WORK, NOT WRITES, and a per-room CURSOR resumes where the last flush stopped so nothing
// is starved. Durability is unchanged in the only case that matters — a chunk somebody EDITED is non-pristine,
// and those are rare and get written on the flush that reaches them (plus eviction still writes immediately).
// ⚠️ `worldFlushAll` passes 1e9 and must still mean "everything, now" — it is the shutdown path. A cap that
// large disables both the work bound and the cursor, which is what `full` below preserves.
const _flushCursor = new Map();                       // room → where the last flush stopped scanning
// 🟥 …AND A CURSOR OVER THE ROOMS THEMSELVES. The work cap is shared across every room, and the room loop
// always started at the same end of `roomCells`, so the FIRST room with changed chunks could spend the whole
// budget on every flush and a room after it in insertion order would never be reached at all — its edits
// persisted only by eviction or by shutdown. Same failure the per-room chunk cursor exists to prevent, one
// level up, and it appeared the moment the cap started counting WORK instead of writes (a write cap was never
// reached on a generated world, so the loop always ran to the end and no room was ever starved).
// ⚠️ Rotated by ONE ROOM per flush rather than resumed mid-room: the per-room cursor already handles resuming,
// so this only has to decide who goes first.
let _flushRoomCursor = 0;
let worldFlushMaxMs = 0, worldFlushScanned = 0;
function worldFlush(max) {
  const cap = max || WORLD_FLUSH_MAX;
  const full = cap >= 1e9;                            // shutdown: no bound, no cursor
  const workCap = full ? Infinity : WORLD_FLUSH_WORK;
  const _t0 = Date.now();
  let wrote = 0, work = 0;
  const _rooms = Array.from(roomCells.keys());
  if (!full && _rooms.length > 1) {
    const k = _flushRoomCursor++ % _rooms.length;
    if (k) _rooms.push(..._rooms.splice(0, k));       // start one room further along than last time
  }
  for (const room of _rooms) {
    if (wrote >= cap || work >= workCap) break;
    if (!_genRooms.has(room)) continue;
    const s = roomCells.get(room); if (!s || !s.terrain || (s.fineSub || 1) !== 1) continue;
    const ch = chunksOf(room);
    // 🟥 AND THE SECOND COST, WHICH CAPPING THE DIFFS DID NOT TOUCH. Walking every page of every content field
    // to build the candidate set is O(RESIDENT PAGES) and runs on every flush — so it grows with exploration
    // exactly like the diffing did. It showed up as the work cap not helping proportionally: 64 diffs took
    // 183ms and 24 took 168ms, which is not a per-diff cost at all.
    // ⇒ THE LIST IS BUILT ONCE PER SWEEP, not once per flush, and the cursor is what says when a sweep is over.
    // A page that faults in mid-sweep waits for the next list; it is pristine ground nobody has touched, and
    // eviction writes anything real immediately, so nothing is at risk from the delay.
    let cur = full ? null : _flushCursor.get(room);
    if (!cur || cur.at >= cur.list.length) {
      const cand = new Set();
      for (const f of CHUNK_CONTENT) { const pa = s[f]; if (pa) pa.eachPage((p) => { cand.add(p); return false; }); }
      cur = { list: Array.from(cand), at: 0 };
      if (!full) _flushCursor.set(room, cur);
    }
    const list = cur.list;
    if (!list.length) continue;
    let at = full ? 0 : cur.at;
    let n = 0;
    for (; n < list.length; n++) {
      if (wrote >= cap || work >= workCap) break;
      const p = list[full ? n : at + n];
      const h = chunkHash(room, p), rec = ch.peek(p);
      if (rec.savedHash === h) continue;                 // nothing has changed here since it was last written
      // ⬇ EVERYTHING BELOW THIS LINE IS THE EXPENSIVE PART, so this is where the work is counted: `chunkDelta`
      // regenerates the chunk to diff it against the ground the generator would make.
      work++;
      const d = chunkDelta(room, p);
      ch.at(p).savedHash = h;
      // A pristine chunk stores nothing AND drops whatever it used to store (see saveChunkBlob). A null delta
      // means this room cannot be diffed at all, which is not a state to record a hash for.
      if (!d) continue;
      saveChunkBlob(room, p, d.pristine ? null : d, d.pristine ? 1 : 0);
      if (!d.pristine) wrote++;
    }
    // ⚠️ ADVANCE BY WHAT WAS ACTUALLY EXAMINED, INCLUDING THE CHEAP SKIPS. The first version advanced only on
    // the chunks it diffed, which meant a sweep over ground already recorded (every `savedHash === h` skip)
    // never moved the cursor at all and the flush restarted from the same place for ever.
    if (!full) cur.at = at + n;
  }
  worldFlushes++; worldFlushWrites += wrote; worldFlushScanned = work;
  const _ms = Date.now() - _t0;
  if (_ms > worldFlushMaxMs) worldFlushMaxMs = _ms;
  // ⭐ A STALL THIS LONG IS NOT A DETAIL AND WAS COMPLETELY SILENT. It is on the main loop, so it is felt as
  // terrain arriving late — which is indistinguishable, from a player's seat, from the chunk queue being slow.
  if (_ms > 100) console.log(`[world] flush took ${_ms}ms — ${work} chunk(s) diffed, ${wrote} written`
    + (full ? ' (full flush)' : ` (cap ${workCap})`));
  return wrote;
}
setInterval(() => { try { worldFlush(); } catch (e) { worldSaveErrors++; } }, WORLD_FLUSH_MS);
loadChunkBlobFor = function (room, p) {
  const b = storedFor(room).get(p | 0);
  return b || null;
};
// Lay a stored edit over a freshly generated page. Called from inside the page fault, once per FIELD — terrain
// carries the material, terrainHp the damage, and the one diff holds both, so each field takes its own half.
// ⭐ PURE MEMORY: a Map lookup and a short write loop. No database, no allocation, nothing that can touch the
// liquid arrays or the active-cell Set — which is the property `probe_worldgen` F7 exists to protect.
applyStoredEdit = function (room, p, page, field) {
  const blob = storedFor(room).get(p | 0);
  if (!blob || !blob.d) return;
  const src = field === 'terrain' ? blob.m : blob.hp;
  for (let k = 0; k < blob.d.length; k++) page[blob.d[k]] = src[k];
  if (field === 'terrain') {
    worldApplied++;    // the mechanism, countable: a stored edit was laid over real ground
    if (worldCfg.tracePersist) console.log(`[persist] apply terrain ${p}: ${blob.d.length} stored cell(s) over freshly generated ground`);
  }
};
// (`chunkIsPristine` and its revision bookkeeping lived here. Deleted 2026-08-04: see the note in evictChunk —
// recording "what untouched looks like" during a RESTORE recorded the restored state, so an edited chunk could
// be judged untouched and thrown away. "The diff is empty" needs no bookkeeping and cannot drift.)
// A chunk is stored as a DIFF only if there is a generator to diff it against and to rebuild it from.
// ⭐⭐ LIQUID PERSISTENCE — THE SAME TRICK AS TERRAIN, ONE LEVEL UP, AND IT IS THE WHOLE DESIGN.
// Storing a chunk's liquid raw is 28KB (six layers per cell plus a total), and liquid MOVES, so a naive scheme
// rewrites the oceans constantly. But generated liquid is RE-DERIVABLE, exactly like generated terrain: the
// seeder's fluid branch is one line — a fluid material means that rank at LIQUID_MAX, single-layer, nothing else
// — so the generated liquid of a cell is a pure function of the generated TERRAIN cell, which `encodeChunkDelta`
// has just regenerated into `_dScratchT` anyway. So store only the DIFFERENCE:
//   · an untouched lake, ocean or volcano conduit  ⇒ zero bytes
//   · a lake somebody drained                      ⇒ only the cells they emptied
//   · a pond somebody dug and filled               ⇒ only those cells
// One entry per (cell, LAYER) that differs, at 4 bytes: (index u16, rank u8, amount u8). A cell holding more
// than one liquid — which only the SIM produces, never generation — needs no special case: it simply has more
// than one entry, which is why this shape was chosen over a fixed six-byte record.
// ⭐ `rank = 0xFF` IS "THERE IS NO LIQUID HERE", and it is the entry that makes a drained lake stay drained.
// Without it, "empty" and "no entry at all" are the same thing on the wire, and every restart would refill it.
const LIQ_REMOVED = 0xFF;
function encodeLiquidDelta(s, p, genT) {
  const amt = s.fineAmt && s.fineAmt.pageAt(p);
  // 🟥 AN ABSENT LIQUID PAGE IS "NOBODY HAS SEEDED THIS YET", NOT "THE LAKE WAS DRAINED" — and encoding it as
  // the latter is permanent. `pageAt` is a PEEK: it does not fault. So a chunk whose liquid page has not been
  // allocated read `n === 0` for every cell, and every cell the GENERATOR fills therefore came out as an
  // explicit `LIQ_REMOVED` — a stored diff that says "this lake does not exist", laid over the generated ground
  // on every future restore. Caught in the live server's log (`[persist] ⚠️ chunk 256095 … over 79 generated
  // fluid cell(s)`), not by reading.
  // ⭐ The safe answer is NO DIFF AT ALL, and it does not lose a real edit: liquid seeding is DEFERRED a tick
  // (see drainGenLiquid), so an absent page means seeding has not run here — whereas a player draining a lake
  // WRITES those cells, which allocates the page. And `encodeLiquidDelta` runs before `dropPage` in
  // `evictChunk`, so the ordinary eviction path always has the page if it ever existed.
  if (!amt) {
    if (worldCfg.tracePersist) {
      let fluid = 0; for (let k = 0; k < CHUNK_CELLS; k++) if (isFluidId(genT[k])) fluid++;
      if (fluid) console.log(`[persist] chunk ${p}: no liquid page yet, over ${fluid} generated fluid cell(s) — storing NO liquid diff rather than "it is all empty"`);
    }
    return null;
  }
  const out = [];
  for (let k = 0; k < CHUNK_CELLS; k++) {
    const gv = genT[k], gFluid = isFluidId(gv), gRank = gFluid ? LIQ_RANK[gv] : -1;
    let n = 0, only = -1, onlyAmt = 0;
    if (amt) { const b = k * LIQ_T; for (let r = 0; r < LIQ_T; r++) { const v = amt[b + r]; if (v) { n++; only = r; onlyAmt = v; } } }
    // The one shape generation can produce: exactly one layer, at the terrain material's rank, brim full.
    if (gFluid ? (n === 1 && only === gRank && onlyAmt === LIQUID_MAX) : n === 0) continue;
    if (n === 0) { out.push(k & 255, k >> 8, LIQ_REMOVED, 0); continue; }
    const b = k * LIQ_T;
    for (let r = 0; r < LIQ_T; r++) { const v = amt[b + r]; if (v) out.push(k & 255, k >> 8, r, v); }
  }
  return out.length ? Buffer.from(out) : null;
}
// The trace hook declared inside the sliced cell-store block (see the note there). Reassigned here, where
// `worldCfg` actually exists, so the live server traces exactly as before and a sliced rig prints nothing.
worldTrace = () => !!worldCfg.trace;
chunkDelta = (room, p) => {
  const gen = _genRooms.get(room); if (!gen || !worldCfg.dropPristine) return null;
  const st = roomCells.get(room); if (!st || !st.terrain) return null;
  const b = encodeChunkDelta(st, p, gen, worldGeom(room));
  if (!b) return null;                                  // diff bigger than the chunk ⇒ store it whole
  // ⚠️ FIRST, AND THE ORDER IS LOAD-BEARING. `_dScratchT` is a shared scratch page that `encodeChunkDelta` has
  // just filled with what the generator WOULD produce here; anything that regenerates a page before this line
  // would silently diff the liquid against the wrong ground.
  b.liq = encodeLiquidDelta(st, p, _dScratchT);
  b.a = encodeChunk(st, p).a;                           // liquid keeps its existing SPARSE encoding IN MEMORY (whole state, not a diff)
  // ⭐ LIQUID IS NOW JUDGED BY WHAT IT HOLDS, NOT BY WHETHER A PAGE EXISTS — which closes a defect increment 4d
  // recorded and could not fix: a generated lake that had since DRAINED left an allocated-but-empty liquid page
  // and an unchanged terrain diff, so by content alone the chunk looked untouched, would be thrown away, and
  // would come back full. A liquid diff makes that difference visible, so this is a correctness fix as much as a
  // persistence one — and it also stops every ocean chunk being stored merely for being wet.
  b.pristine = b.d.length === 0 && !b.liq;
  if (!b.pristine) genChunksDeltad++;
  return b;
};
// The read half: put a stored liquid diff back. Layers of the listed cells are cleared first, so an entry list
// REPLACES those cells rather than adding to whatever generation seeded — which is what makes a 0xFF marker mean
// "empty" and a rank entry mean "exactly this".
// 🟥 THIS MUST NOT RUN INSIDE A PAGE FAULT. It writes `fineAmt`/`fineTotal` and wakes cells in the active Set, and
// a page fault can arrive from deep inside `fineLiquidTickRoom` while it is iterating that very Set — the hazard
// `probe_worldgen` F7 exists to catch. It rides the existing deferred pass (`drainGenLiquid`) instead, AFTER the
// generator's own seeding for the chunk, so the stored state wins. Reverse that order and a drained lake refills
// itself on every restart.
let worldLiquidRestored = 0;
// ⭐⭐ THE STORED-LIQUID AUDIT (`liquidCfg.storedWakeAudit`, OFF by default and free when off).
// The question it settles: *"why does saved water come back MOVING?"* — measured, arriving on a chunk a player
// has built in costs 900–1,900 active cells for ~45 seconds, while an untouched generated world costs 0.
// There are two completely different explanations and they need opposite fixes:
//   (a) THE STORED STATE IS ITSELF OUT OF EQUILIBRIUM — it was written to disk mid-motion (eviction happens 10s
//       after you leave residency; settling takes ~45s, so leaving promptly freezes the moving state onto disk
//       and it is restored, and re-saved, moving, every time anybody passes). Fix = do not store mid-motion.
//   (b) THE STORED STATE IS AT REST AND THE RESTORE BREAKS IT — generated liquid is seeded first and the stored
//       diff laid over it, and persistence is PER CHUNK while a body of water is not, so a slice saved ten
//       minutes ago can come back beside a slice saved just now. Fix = something else entirely.
// ⇒ count, over the cells `applyStoredLiquid` has just written, how many `liquidCanMove` says could move. Near
// zero with the sim still busy for 45s means (b); a large fraction means (a).
// ⚠️ This is the SAME test as the wake filter that froze water twice, used here only to COUNT. It is not being
// trusted to decide anything, which is the whole reason it is safe to use it.
let storedAuditSeen = 0, storedAuditMovable = 0, storedAuditChunks = 0;
// ⭐ How many stored-liquid cells were NOT woken because they had nowhere to go. A MECHANISM counter: if
// terrain is arriving late and this is large, the filter is doing its job and the load is elsewhere; if it is
// zero on a played-in world, the filter is not firing and something upstream changed.
let worldLiquidWakeSkipped = 0;
function applyStoredLiquid(room, p) {
  const blob = storedFor(room).get(p | 0);
  const buf = blob && blob.liq;
  // ⚠️ Traced with the REASON, not just the outcome. Every early return below looks identical from outside —
  // "the water came back wrong" — and they are four different faults.
  if (!buf || !buf.length) { if (worldCfg.tracePersist && blob) console.log(`[persist] apply liquid ${p}: the stored row has no liquid diff`); return 0; }
  const s = roomCells.get(room); if (!s || !s.fineAmt || !s.fineTotal) { if (worldCfg.tracePersist) console.log(`[persist] apply liquid ${p}: NO LIQUID FIELDS in the room`); return 0; }
  const amt = s.fineAmt.wpPage(p), tot = s.fineTotal.wpPage(p);
  if (!amt || !tot) { if (worldCfg.tracePersist) console.log(`[persist] apply liquid ${p}: could not get a writable liquid page`); return 0; }
  if (worldCfg.tracePersist) console.log(`[persist] apply liquid ${p}: ${buf.length / 4} stored entr(ies)`);
  for (let q = 0; q + 3 < buf.length; q += 4) {         // pass 1: clear every listed cell, so the entries below are the whole truth about it
    const c = buf[q] | (buf[q + 1] << 8), b = c * LIQ_T;
    for (let k = 0; k < LIQ_T; k++) amt[b + k] = 0;
    tot[c] = 0;
  }
  const geom = worldGeom(room), act = fineSet(room);
  const pc0 = ((p / geom.cy) | 0) * CHUNK_SIDE, pr0 = (p % geom.cy) * CHUNK_SIDE;
  let n = 0;
  for (let q = 0; q + 3 < buf.length; q += 4) {         // pass 2: write what was stored
    const c = buf[q] | (buf[q + 1] << 8), rk = buf[q + 2], v = buf[q + 3];
    if (rk === LIQ_REMOVED) continue;                   // an explicit "nothing here" — pass 1 already did the work
    const b = c * LIQ_T;
    amt[b + rk] = v;
    const t = tot[c] + v; tot[c] = t > 255 ? 255 : t;
    n++;
  }
  // ⚠️ WOKEN, not left to be discovered, and every listed cell — including the emptied ones, whose NEIGHBOURS may
  // now have somewhere to go.
  // 🟥🟥 …BUT ONLY THE ONES THAT CAN ACTUALLY MOVE, AND THE OLD REASONING FOR WAKING ALL OF THEM WAS MEASURED
  // WRONG. It said: "This is liquid a PLAYER moved, so unlike generated liquid it has no claim to being at rest:
  // it may have been mid-flow when the server went down. The list is short (changed cells only), so waking all
  // of it costs nothing." Two things are wrong with that.
  //  1. IT DOES NOT RUN ONCE AFTER A RESTART. It runs on EVERY chunk fault-in, for the life of the process. A
  //     player moving through ground they have edited before re-wakes all of it, every time, and the water was
  //     settled long ago.
  //  2. "THE LIST IS SHORT" IS PER CHUNK. With ~8,800 stored chunks in a played-in world and a window faulting
  //     several chunks a second, it is thousands of cells per tick.
  // Reported from play and diagnosed from the user's own Net-tab readout, which is the only reason it was found:
  // standing still the sim ran at **0.03ms with ZERO active cells**; moving, **16-32ms avg, 90ms max, of a 40ms
  // tick, with 3,408 active** — so every bit of the load was created by movement rather than by the world having
  // water in it. The chunk queue shares that tick, which is why terrain then arrived seconds late.
  // 🟥 It could not be reproduced by any harness here, because a fresh test world has NO STORED EDITS: traversals
  // at the surface AND deep underground both measured 0 active cells. The bug is proportional to how much a
  // player has built, which is exactly the thing a clean rig does not have.
  // ⭐ THE FILTER IS NOT A NEW RULE — it is `liquidCanMove`, the same one the generated-liquid seeder and
  // `rewakeChunk` already use, and it does not lose the mid-flow case it was protecting: liquid that was caught
  // mid-flow has somewhere to go, so `liquidCanMove` answers true and it wakes. What it drops is liquid with
  // nowhere to go, which is at rest by definition.
  // ⚠️ `storedWakeAll` restores the old behaviour live, for an A/B against exactly these numbers.
  // ⚠️ A page is laid out ROW-MAJOR WITHIN THE CHUNK (`lr * CHUNK_SIDE + lc`) while the world index is
  // column-major (increment 5) — hence the conversion rather than an offset.
  for (let q = 0; q + 3 < buf.length; q += 4) {
    const c = buf[q] | (buf[q + 1] << 8), rk = buf[q + 2];
    const lr = (c / CHUNK_SIDE) | 0, lc = c - lr * CHUNK_SIDE;
    if (pc0 + lc >= geom.cols || pr0 + lr >= geom.rows) continue;
    const i = (pc0 + lc) * geom.rows + (pr0 + lr);
    // An emptied cell (LIQ_REMOVED) carries no rank to test, and it is the case whose NEIGHBOURS may now have
    // somewhere to go — so it is still woken unconditionally. It is also the rare one.
    const rid = (rk === LIQ_REMOVED) ? 0 : LIQ_ID[rk];
    // 🟥🟥 …BUT ONLY FOR CELLS WHOSE NEIGHBOURS ARE IN THIS PAGE, AND THIS IS THE BUG THE FIRST VERSION SHIPPED.
    // `liquidCanMove` reads its neighbours with `peekCellAt`, which answers **-1 for a page nobody has produced
    // yet** — and -1 fails every test in it, so the cell is judged "cannot move" and left asleep.
    // For GENERATED liquid that is correct and deliberate: whatever produces the chunk below later runs the same
    // seeding pass over ITS OWN cells, and the generator guarantees the result is at rest either way.
    // For STORED liquid it is WRONG, because the pass that produces the chunk below runs over that chunk's
    // stored cells, not over this one's — so nothing ever re-asks. A player's water sitting on the bottom row of
    // a chunk, above ground that has not been produced yet, was left asleep FOR EVER.
    // ⇒ reported from play immediately, as water frozen in mid-air in vertical columns, and that is exactly what
    // it is: liquid whose support was "unknown" at the moment it was judged.
    // ⭐ The fix is precise rather than a retreat. A cell strictly INSIDE the page has its below/left/right
    // neighbours in the same page — the one we have just written — so the peek cannot answer -1 and the filter is
    // sound. Only the three edges that `liquidCanMove` actually looks across can be wrong, so only those wake
    // unconditionally: at most ~190 of a chunk's 4,096 cells, which keeps essentially all of the saving.
    // ⚠️ A page is ROW-MAJOR within the chunk while the world index is column-major, so "below" leaves the page
    // at `lr === 63` and "beside" at `lc === 0 || lc === 63`. Getting that pair the wrong way round would guard
    // the wrong edges and look exactly like this bug again.
    const _edge = (lr === CHUNK_SIDE - 1) || (lc === 0) || (lc === CHUNK_SIDE - 1);
    if (!liquidCfg.storedWakeAll && !_edge && rid && !liquidCanMove(s.terrain, i, geom, rid)) { worldLiquidWakeSkipped++; continue; }
    // ⭐⭐ SPREAD, NOT DROPPED (liquidCfg.storedWakeRate). See the note below — this is the safe half of the
    // saving, and it is the half that cannot freeze anything.
    if (liquidCfg.storedWakeAudit && rid) { storedAuditSeen++; if (liquidCanMove(s.terrain, i, geom, rid)) storedAuditMovable++; }
    if (liquidCfg.storedWakeRate > 0) { let q = _storedWakeQ.get(room); if (q === undefined) _storedWakeQ.set(room, q = new Set()); if (q.size < LIQUID_MAX_ACTIVE) q.add(i); continue; }
    if (act.size < LIQUID_MAX_ACTIVE) act.add(i);
  }
  if (liquidCfg.storedWakeAudit) storedAuditChunks++;
  worldLiquidRestored += n;
  return n;
}
// ⭐⭐ WHY THE WAKE IS RATE-LIMITED AND NOT FILTERED, AND THIS IS THE WHOLE POINT OF THE MECHANISM.
// The filter above (`storedWakeAll = 0`) is worth almost all of the cost — and it FROZE WATER IN MID-AIR TWICE.
// One cause was found (`peekCellAt` answers -1 for an unproduced page, and -1 fails every branch of
// `liquidCanMove`, so the cell is judged immovable and sleeps for ever). The second was never identified, which
// is exactly why the filter still ships OFF: a wake test that is wrong in the "cannot move" direction is not
// slow, it is BROKEN, and the failure is silent and permanent.
// ⭐ The cost, though, is not the waking. It is that a chunk fault-in dumps its entire stored liquid list into
// `active` IN ONE TICK — measured at 3,400 cells and 32ms of a 40ms tick while moving through built-in ground.
// Those cells are processed once and, if they cannot move, drop straight back out; the work is real but it is a
// SPIKE, and a spike is what makes the budget throttle. So: queue them, and admit a bounded number per tick.
// ⭐⭐ NOTHING IS EVER DROPPED, which is the entire difference from the filter. Every stored cell still wakes,
// just a tick or two later, so neither the known cause nor the unknown one can strand anything: the queue is
// drained unconditionally and asks no question about whether the cell can move.
// ⚠️ A Set, so a chunk faulting in twice does not queue its cells twice. Entries for a chunk that was evicted
// again are harmless — the flow loop's first act is `if (tot.g(i) <= 0) continue`.
// ⚠️ Inflow is a few thousand cells a second at a walking pace against a 512/tick × 25Hz = ~12,800/s drain, so
// in normal play the queue empties every tick and the only thing that changes is the peak.
const _storedWakeQ = new Map();
drainStoredWake = function () {
  const rate = liquidCfg.storedWakeRate | 0;
  if (rate <= 0 || !_storedWakeQ.size) return 0;
  let admitted = 0;
  for (const [room, q] of _storedWakeQ) {
    if (!roomCells.has(room)) { _storedWakeQ.delete(room); continue; }
    const act = fineSet(room);
    let budget = rate;
    for (const i of q) {
      if (budget-- <= 0) break;
      q.delete(i);
      if (act.size < LIQUID_MAX_ACTIVE) act.add(i);
      admitted++;
    }
    // ⚠️ `fineSet` only registers the room on the tick it CREATES the set, and `dropFineActive` de-registers a
    // room whose set has drained — so a room being re-woken from an empty set has to be put back by hand or its
    // newly admitted cells are never ticked. (The unconditional wake above has the same shape and gets away with
    // it because a chunk fault-in is always accompanied by other traffic; this path can be the only writer.)
    if (act.size) cellRooms.fine.add(room);
    if (!q.size) _storedWakeQ.delete(room);
  }
  worldLiquidWakeAdmitted += admitted;
  worldLiquidWakeQueued = 0; for (const q of _storedWakeQ.values()) worldLiquidWakeQueued += q.size;
  return admitted;
};
// Attach (or remove) the seeders for a room. Idempotent, and safe to call after the fields already exist —
// which matters because `ensureTerrain` may have run long before anybody decided this room was generated.
function setRoomGenerator(room, gen) {
  if (gen) _genRooms.set(room, gen); else _genRooms.delete(room);
  const s = roomCells.get(room); if (!s) return;
  for (const f of ['terrain', 'terrainHp']) {
    const pa = s[f]; if (!pa) continue;
    pa.seedFn = gen ? genSeedFn(f, room) : null;
    pa.seedEmpty = gen ? ((p) => gen.pageEmpty(p, pa.geom)) : null;
    // ⚠️ THE ONE THING THAT INVALIDATES THE SKY MEMO. Its entries are answers about THIS generator's layout, so
    // they survive every write, eviction and restore — and none of them survive the generator being replaced.
    pa._skyMemo.clear(); pa._emptyP = -1;
  }
}
// ⭐ LIQUID IS SEEDED ON A DEFERRED PASS, AND THAT IS NOT TIDINESS. A page fault can happen from deep inside
// `fineLiquidTickRoom`, which is iterating the room's active-cell Set; seeding writes into that same Set, and
// this track has already recorded that room/cell iteration order is load-bearing. So production writes terrain
// only, records the page, and the liquid half runs at a point where nothing is mid-iteration. The delay is at
// most one tick (40ms) and it is why `drainGenLiquid` is called from the top of the liquid tick rather than
// anywhere convenient.
// Can this freshly generated liquid cell move at all? Falls if there is air or another fluid under it; spills if
// there is air beside it. Anything else is a cell inside a body of liquid that is already at its resting level.
// 🟥 EVERY READ IS A PEEK, NEVER `.g()`. `.g()` PRODUCES the page it lands on, and the powder seeder ten lines
// below carries the scar: a grain at a chunk's bottom edge produced the chunk beneath it, whose seeding produced
// the one beneath that, all the way to bedrock — 64 chunks deep and 8,191 wide, and the server stopped
// answering. -1 means "nobody has produced that yet", and the right answer for a cell resting on it is to leave
// it asleep; whatever produces that chunk later runs this same pass over its own cells.
// 🟥🟥 "FLUID BELOW" IS NOT A REASON FOR *LIQUID* TO MOVE, AND GETTING THAT WRONG COST THE WHOLE FIX.
// The first version of this said `if (!b || isFluidId(b)) return true` — copied from the POWDER seeder ten lines
// below, where it IS right, because a grain sinks through liquid. For liquid it is nonsense: water resting on
// water is water at the bottom of a lake, which is the most at-rest thing in the world. So every cell of every
// submerged chunk woke, which is exactly what the heat overlay showed — chunks reading a flat **4,096**, every
// cell queued, in water. It is why the "wake only what can move" change delivered 10% instead of the ~40x the
// cell counts implied: in a lake it woke everything anyway.
// A liquid cell can actually move only if:
//   · there is AIR below it            — it falls;
//   · there is a LIGHTER fluid below   — it sinks past (density sorting). Same density ⇒ nothing to do;
//   · there is AIR beside it           — it spills sideways.
// ⚠️ EVERY READ IS A PEEK, NEVER `.g()`. `.g()` PRODUCES the page it lands on, and the powder seeder below
// carries the scar: a grain at a chunk's bottom edge produced the chunk beneath it, whose seeding produced the
// one beneath that, to bedrock — 64 chunks deep, 8,191 wide, and the server stopped answering. -1 means "not
// produced yet", and the right answer for a cell resting on it is to stay asleep; whatever produces that chunk
// later runs this same pass over its own cells.
function genLiquidLoose(terr, i, geom, v) {
  const rows = geom.rows, c = (i / rows) | 0, r = i - c * rows;
  if (r + 1 < rows) {
    const b = peekCellAt(terr, i + 1);
    if (b === 0) return true;                                     // air below ⇒ falls
    // LIQ_RANK is 0 = heaviest, so this cell sinks past the one below only when its rank is SMALLER.
    if (b > 0 && isFluidId(b) && LIQ_RANK[v] < LIQ_RANK[b]) return true;
  }
  // ⭐⭐ …AND A FLUID OF A DIFFERENT DENSITY BESIDE IT (2026-08-12). ⚠️ NOTE THE ASYMMETRY WITH THE TEST ABOVE:
  // BELOW, only a LIGHTER fluid is a reason to move, because a heavier one underneath is already the right way
  // up. BESIDE, ANY difference is, because side by side has no right way up at all — one of the two must go
  // under the other, and which one it is does not change that the pair is not at rest.
  // 🟥 THIS CONDITION WAS MISSING, AND IT IS THE WHOLE OF WHY THE WORLD HOLDS HARD VERTICAL WALLS BETWEEN TWO
  // LIQUIDS. Reported from play: *"different density liquids should not be sitting next to each other like
  // that, they should be sorted"*. `probe_liquid_sort.js` measured both halves rather than reading them: two
  // settled bodies meeting at a vertical face DO sort completely when their cells are awake (12 cells of
  // different-rank contact -> 0, the heavy body ending 6 rows below the light one), and do NOTHING WHATSOEVER
  // over 800 ticks when woken by this function, because not one of the three conditions above fires on them.
  // The sim was never broken; nothing ever asked it to look.
  // ⚠️ BOTH SIDES WAKE, deliberately. An exchange has two ends, and leaving one asleep makes the result depend
  // on which of the pair the seeding pass happened to reach first.
  // ⚠️ IT IS NOT A COST. A homogeneous body contains no such pair anywhere in it, so a lake pays one rank
  // comparison per cell and wakes nothing: measured over 12 windows of 384 columns × 4,096 rows of the live
  // Overworld, 655,112 cells of same-rank horizontal contact against 184 of different-rank
  // (`probe_liquid_patches.js`). What it wakes is exactly the defect and nothing else.
  // ⚠️ ON BY DEFAULT with a live toggle, rather than the branch's usual ships-off, because OFF is the reported
  // bug. `liquid-cfg {wakeDensityFace:0}` restores the old behaviour for an A/B.
  const face = liquidCfg.wakeDensityFace;
  if (c > 0) {
    const l = peekCellAt(terr, i - rows);
    if (l === 0) return true;                                     // air to the left ⇒ spills
    if (face && l > 0 && isFluidId(l) && LIQ_RANK[l] !== LIQ_RANK[v]) { genFaceWoken++; return true; }
  }
  if (c + 1 < geom.cols) {
    const rt = peekCellAt(terr, i + rows);
    if (rt === 0) return true;                                    // air to the right ⇒ spills
    if (face && rt > 0 && isFluidId(rt) && LIQ_RANK[rt] !== LIQ_RANK[v]) { genFaceWoken++; return true; }
  }
  return false;
}
function seedGenChunkLiquid(room, p) {
  const s = peekCells(room); if (!s.terrain || (s.fineSub || 1) !== 1) return;
  const page = s.terrain.pageAt(p); if (!page) return;      // dropped again before we got here — nothing to seed
  const geom = worldGeom(room);
  ensureFineArrays(room, 1);
  const amt = s.fineAmt, tot = s.fineTotal; if (!amt || !tot) return;
  const act = fineSet(room);
  const c0 = ((p / geom.cy) | 0) * CHUNK_SIDE, r0 = (p % geom.cy) * CHUNK_SIDE;
  let n = 0;
  for (let lr = 0; lr < CHUNK_SIDE && r0 + lr < geom.rows; lr++)
    for (let lc = 0; lc < CHUNK_SIDE && c0 + lc < geom.cols; lc++) {
      const v = page[lr * CHUNK_SIDE + lc];
      const i = (c0 + lc) * geom.rows + r0 + lr;
      // ⭐ POWDER RIDES THE SAME DEFERRED PASS, and for the same reason rather than for convenience: the powder
      // active set is a Set that `powderTickRoom` iterates, so writing to it from inside a page fault is the
      // identical re-entrancy hazard that put liquid seeding here (probe_worldgen F7).
      // ⚠️ `grid.g(i + 1)` may fault the chunk BELOW this one. That is bounded and intended — a grain at the
      // bottom edge of a chunk genuinely needs to know whether there is ground under it, and producing one
      // neighbour is what the pool rule's column overlap already costs on the generator side.
      if (isPowderSeedId(v)) {                                     // SEED, not MOVE — plants are never woken by generation
        if ((i % geom.rows) + 1 < geom.rows) {
          // 🟥 THIS READ MUST NOT FAULT, AND WHEN IT DID IT RAN AWAY DOWN THE WORLD. `.g()` produces the page it
          // lands on, so a grain at a chunk's BOTTOM EDGE produced the chunk beneath it — whose own powder
          // seeding then produced the one beneath THAT, and so on to bedrock. In a page room that bottoms out
          // after 7 chunks and the note here used to call it "bounded and intended". The Overworld is 64 chunks
          // deep and 8,191 wide: looking at one screen produced a column of chunks all the way down, for every
          // column on screen, and the server stopped answering. Reported from play as a crash; the error log was
          // empty, because it was a stall.
          // ⇒ Peek instead. An absent page means "nobody has produced this yet", and the right answer for a
          // grain sitting on it is to leave it asleep: whatever produces that chunk later runs the same seeding
          // over it, and `queuePowderReseed` wakes grains on every fault-in besides.
          const below = peekCellAt(s.terrain, i + 1);
          if (below >= 0 && (!below || isFluidId(below))) powderSet(room).add(i);
        }
        continue;
      }
      if (!isFluidId(v)) continue;
      amt.wp(i)[amt.o(i) + LIQ_RANK[v]] = LIQUID_MAX; tot.s(i, LIQUID_MAX);
      // ⭐⭐ WAKE ONLY LIQUID THAT CAN ACTUALLY MOVE. This line used to be an unconditional `act.add(i)`, and it
      // is the whole reason the Overworld's liquid looked frozen.
      // MEASURED (`scratchpad/probe_gen_atrest.js`, 3 seeds x 40 surface chunks): the generator emits ~58,000
      // liquid cells per terrain window and **99.5% of them are already at rest** — 11.2% of the world is
      // liquid, and only 0.5% of it has anywhere to go. Every one of them was being handed to the sim as work
      // anyway, which is where the live "47,900 cells waiting to move" came from. The flow loop then spent its
      // entire budget re-discovering that a lake is a lake.
      // ⚠️ The user asked the right question — "how would you be sure it generated settled without checking?"
      // You would not. So this checks. A check is one read per cell, ONCE; simulating is one pass per cell PER
      // TICK until it stops. That asymmetry is the entire argument.
      // ⚠️ CONSERVATIVE ON PURPOSE — it wakes a superset of what must move. Under-waking would leave liquid
      // visibly hanging until something disturbed it, which is a much worse failure than doing a little extra
      // work, so a lateral air neighbour counts as well as a fall.
      if (act.size < LIQUID_MAX_ACTIVE && (liquidCfg.genWakeAll || genLiquidLoose(s.terrain, i, geom, v))) act.add(i);
      n++;
    }
  if (!n && !act.size) dropFineActive(room);
  if (worldCfg.tracePersist) console.log(`[persist] seed liquid ${p}: ${n} generated cell(s)`);
  return n;
}
// 🟥 SAND HANGING IN MID-AIR OFF A FLOATING ISLAND. `evictChunk` PRUNES the room's work sets — it deletes every
// cell of the evicted chunk from `fineActive`, `powderActive` and the rest, which is right: a chunk with no pages
// must not be simulated, and leaving its cells in the set would fault it straight back in every tick and defeat
// eviction entirely. The other half of that bargain is that anything still MOVING has to be woken when the chunk
// comes back — and liquid was (`rehydrateChunk` re-adds every cell in the stored blob's liquid list) while powder
// was not. So a grain mid-fall in a chunk that left residency was deleted from the active set and never re-added:
// it froze exactly where it was, in a column, and stayed frozen when you walked back into view. Which is why the
// report was "it happens off-screen, or on approach" — off-screen is where eviction happens.
// ⚠️ THE FIX IS NOT "STOP PRUNING". Powder is re-DERIVED instead, because the rule for "this grain can move" is
// local and cheap — powder rests on whatever is under it, so a scan of the chunk answers it exactly. Liquid is
// not re-derivable that way, which is why IT is stored and woken rather than recomputed.
// ⚠️ And it must NOT go through the liquid path: `seedGenChunkLiquid` seeds liquid from what the GENERATOR says
// should be there, and running that on a restore resurrects a lake somebody drained (the reason `_genPending` is
// only added on a first production). Powder is safe to re-derive from restored terrain; liquid is not.
const _powderPending = new Set();
queuePowderReseed = (room, p) => { _powderPending.add(room + GEN_SEP + p); };
queueGenLiquid = (room, p) => { _genPending.add(room + GEN_SEP + p); };
liquidCanMove = genLiquidLoose;
// The powder half of the deferred pass. Deferred for the SAME re-entrancy reason as liquid, not for tidiness:
// this writes into the Set `powderTickRoom` iterates, and a page fault can arrive from inside that iteration.
function reseedChunkPowder(room, p) {
  const s = peekCells(room); if (!s.terrain) return 0;
  const page = s.terrain.pageAt(p); if (!page) return 0;    // evicted again before we got here — nothing to wake
  const geom = worldGeom(room);
  const c0 = ((p / geom.cy) | 0) * CHUNK_SIDE, r0 = (p % geom.cy) * CHUNK_SIDE;
  let n = 0;
  for (let lr = 0; lr < CHUNK_SIDE && r0 + lr < geom.rows; lr++)
    for (let lc = 0; lc < CHUNK_SIDE && c0 + lc < geom.cols; lc++) {
      if (!isPowderSeedId(page[lr * CHUNK_SIDE + lc])) continue;   // SEED, not MOVE: a re-entering forest must not shed
      const i = (c0 + lc) * geom.rows + r0 + lr;
      if ((i % geom.rows) + 1 >= geom.rows) continue;        // resting on the bottom row of the world
      // ⚠️ Same rule as seedPowderActivity: only grains that could ACTUALLY move. A grain with something solid
      // beneath it is already at rest, and waking every grain in a desert chunk would make the next powder tick
      // walk all of them.
      // 🟥 AND THE READ MUST NOT FAULT — see the note in seedGenChunkLiquid. `.g()` here produced the chunk
      // below, whose seeding produced the next one down, all the way to bedrock; 64 deep in the Overworld.
      const below = peekCellAt(s.terrain, i + 1);
      if (below >= 0 && (!below || isFluidId(below))) { powderSet(room).add(i); n++; }
    }
  return n;
}
drainGenLiquid = function () {
  let n = 0;
  if (_genPending.size) {
    const batch = Array.from(_genPending); _genPending.clear();
    for (const key of batch) {
      const cut = key.lastIndexOf(GEN_SEP);
      const room = key.slice(0, cut), p = +key.slice(cut + 1);
      if (!roomCells.has(room)) continue;
      n += seedGenChunkLiquid(room, p) || 0;
      // ⭐ AND THE STORED LIQUID GOES ON TOP, HERE, IN THIS ORDER. Seed what the generator says should be there,
      // then overwrite it with what was actually there when this chunk was last put away. Reverse the two and a
      // lake somebody drained refills itself on every restart — which is the entire correctness of the design.
      applyStoredLiquid(room, p);
    }
    genLiquidSeeded += n;
  }
  if (_powderPending.size) {
    const batch = Array.from(_powderPending); _powderPending.clear();
    for (const key of batch) {
      const cut = key.lastIndexOf(GEN_SEP);
      const room = key.slice(0, cut), p = +key.slice(cut + 1);
      if (!roomCells.has(room)) continue;
      genPowderRewoken += reseedChunkPowder(room, p);
    }
  }
  return n;
}
// True when a built-in terrain material id behaves as a fluid (Water/Quicksand/Lava/Acid/Brine/Oil).
function TERRAIN_MATS_FLUID(v) { return v === 9 || v === 10 || v === 11 || v === 12 || v === 14 || v === 15; }
// Phase 6: generation column band for a Level's size preset (null = full world). Looks up the room's
// env_spec; the page-default room (roomId = URL, no DB row) falls through to 'large' → full width.
// Resolve a Level's size preset key from the room's stored env_spec (page/URL room or missing → 'large').
function levelSizeFor(roomId, levelIndex) {
  try {
    const row = db.prepare('SELECT env_spec FROM rooms WHERE id = ?').get(roomId);
    const spec = row ? parseEnvSpec(row.env_spec) : null;
    const lvl = (spec && Array.isArray(spec.levels)) ? spec.levels[levelIndex | 0] : null;
    if (lvl && LEVEL_SIZES.has(lvl.size)) return lvl.size;
  } catch {}
  return 'large';
}
function genColBand(roomId, levelIndex) {
  const pw = SIZE_PRESET_W[levelSizeFor(roomId, levelIndex)] || MWSim.C.WORLD_W;
  if (pw >= MWSim.C.WORLD_W) return null;                               // full world → no confinement
  const half = pw / 2 + GEN_MARGIN;
  const x0 = Math.max(0, MWSim.C.WORLD_W / 2 - half), x1 = Math.min(MWSim.C.WORLD_W, MWSim.C.WORLD_W / 2 + half);
  return { c0: Math.floor(x0 / TERRAIN_CELL), c1: Math.ceil(x1 / TERRAIN_CELL) };
}
// Phase 6: the playable band rectangle (world px) for a Level — centred horizontally, anchored to the floor.
// Drives the server-side object-position clamp (belt+suspenders vs client camera/wall confinement). null = full world.
function playBand(roomId, levelIndex) {
  const size = levelSizeFor(roomId, levelIndex);
  const pw = SIZE_PRESET_W[size] || MWSim.C.WORLD_W, ph = SIZE_PRESET_H[size] || MWSim.C.WORLD_H;
  if (pw >= MWSim.C.WORLD_W && ph >= MWSim.C.WORLD_H) return null;      // full world → no confinement
  const x0 = Math.floor((MWSim.C.WORLD_W - pw) / 2);
  return { x0, x1: x0 + pw, y0: MWSim.C.WORLD_H - ph, y1: MWSim.C.WORLD_H };
}
// Clamp a world point into the playable band (no-op when band is null).
function clampToBand(band, x, y) {
  if (!band) return { x, y };
  return { x: Math.max(band.x0, Math.min(band.x1, x)), y: Math.max(band.y0, Math.min(band.y1, y)) };
}
// Ensure a 'world'-mode room has its terrain generated exactly once per server lifetime.
function ensureWorldGenerated(avatarRoom, roomId, levelIndex) {
  if (worldGenerated.has(avatarRoom)) return;
  worldGenerated.add(avatarRoom);
  // Phase 6 inc 4: which generator. `worldCfg.chunked` ships 0, so this is `generateWorld` unless switched.
  // ⭐ INCREMENT 7. The Overworld's seed is FIXED rather than keyed on a URL — there is one Overworld and it has
  // to look the same to everyone — and it has no column band, because a Level's size preset is a page-world idea
  // and the whole width is the point here.
  const _over = overworldRooms.has(avatarRoom);
  const _seed = _over ? OVERWORLD_SEED : worldSeedFor(roomId), _band = _over ? null : genColBand(roomId, levelIndex);
  // ⭐ 4b — ON DEMAND: register the generator and build NOTHING. The world comes into existence a chunk at a
  // time as it is read, which is the only way an Overworld can work. Everything below (the liquid seed, the
  // pre-settle) is about a world that already exists, so it is skipped: a chunk seeds and settles its own
  // liquid when it is produced. ⚠️ `ensureTerrain` is called FIRST so the fields exist for the seeders to be
  // attached to — `setRoomGenerator` is idempotent and can attach to fields made earlier, but there is no
  // reason to rely on that here.
  // ⚠️ THE OVERWORLD TAKES THIS BRANCH WHATEVER THE FLAGS SAY. A 524,224 x 4,096 world is 2.1 billion cells;
  // there is no eager path for it, and falling through to `generateWorld` would try to allocate one. Reading
  // `overworldRooms` rather than the two flags means "Overworld ⇒ produced on demand" is a property of the room
  // and not of whether somebody remembered to tick two other boxes.
  if (_over || (worldCfg.chunked && worldCfg.onDemand)) {
    const _t = ensureTerrain(avatarRoom), _h = ensureTerrainHp(avatarRoom);
    // 🟥 A REBUILD HAS TO EMPTY THE WORLD FIRST, AND THIS BRANCH DID NOT. On a FRESH room there is nothing to
    // clear, so the omission was invisible — but the Rebuild button runs this same function on a room that
    // already has a world in it, and on-demand production only fires for pages that DO NOT EXIST. Worse, the
    // regen handler calls `materializeRoom` immediately before this to "start from a fully resident world",
    // which guarantees every page exists. So rebuild left the old world byte for byte and produced new ground
    // ONLY in the empty sky above it, where no page had ever been allocated — and since the two generators put
    // the surface at different heights, that arrived as slabs of new terrain floating over the old world with
    // chunk-boundary edges. Reported from play as "it doesn't actually rebuild, it just adds these new
    // disconnected chunks above the surface, and the speckling all still exists".
    // ⚠️ The LIQUID has to go too. Terrain is regenerated from the seed but liquid is not — leaving the fine
    // arrays populated would float the old world's lakes in the new world's sky.
    _t.fill(0); _h.fill(0);
    const _st = cellsOf(avatarRoom);
    if (_st.fineAmt) _st.fineAmt.fill(0);
    if (_st.fineTotal) _st.fineTotal.fill(0);
    if (_st.fineActive) _st.fineActive.clear();
    if (_st.powderActive) _st.powderActive.clear();
    clearLiquidSources(avatarRoom);
    setRoomGenerator(avatarRoom, genFor(avatarRoom, _seed, _band));
    return;
  }
  if (worldCfg.chunked) generateWorldChunked(avatarRoom, _seed, _band); else generateWorld(avatarRoom, _seed, _band);
  seedLiquidActivity(avatarRoom);                    // give generated liquid its fill levels, then…
  seedPowderActivity(avatarRoom);                    // …and wake the sand and snow that is not resting on anything
  liquidQuiet = true;                                // …pre-settle it silently so joiners see it already at rest (no on-load sloshing / broadcast storm)
  // ⭐⭐ THE PRE-SETTLE HAD SILENTLY STOPPED HAPPENING. This loop tested the COARSE active set, but `seedLiquidActivity`
  // ends by calling `upscaleRoomToFine`, which hands the generated lakes to the fine grid and CLEARS
  // roomLiquidActive — so the loop broke on iteration zero and no settling ran at all. Every lake cell then went into
  // the FINE active set and settled live in front of the first player to arrive, broadcasting the whole way: exactly
  // the on-load sloshing and broadcast storm this was written to prevent.
  // Now it ticks whichever sim actually owns the liquid, in runLiquidTick's own order (REACT · FLOW · REACT) so a
  // generated lava/water contact resolves here rather than erupting on first join. Every emit path is already gated on
  // `liquidQuiet`, so none of it goes out over the wire.
  // ⚠️ AND IT MUST BE BOUNDED BY WALL CLOCK, NOT JUST ITERATIONS. ensureWorldGenerated runs SYNCHRONOUSLY on the
  // first join, so every iteration here is a stall for every room on the server. Measured on a real generated world
  // (1920×405, 13,484 fluid cells, all of them active at once): the fine tick costs ~50ms per iteration at that active
  // count and 3000 iterations DID NOT REACH REST — it would have blocked the process for ~2.5 minutes. The iteration
  // cap alone was safe before only because this loop was dead. A partial settle is strictly better than none (that is
  // today's behaviour) and the cost is capped, so spend a fixed slice and hand the rest to the live sim.
  const preSettleUntil = Date.now() + PRESETTLE_MS;
  for (let s = 0; s < 3000 && PRESETTLE_MS > 0; s++) {
    // ⚠️ The budget CANNOT stop the first iteration — this check sits at the top of the loop, so iteration 0 always
    // runs to completion before the limit is consulted, and on a fresh world that alone is ~540ms. So the loop is
    // skipped outright at 0 rather than relying on the clock, which would be a same-millisecond race.
    if (Date.now() > preSettleUntil) break;
    const _st = cellsOf(avatarRoom);
    const fact = _st.fineActive;
    const seeded = _st.fineReact, burning = _st.fineFire;
    // ⚠️ POWDER IS PART OF THE REST CONDITION NOW, not just part of the work. Without `pact` in this test the
    // loop breaks as soon as the LIQUID settles and leaves the sand mid-collapse — which is worse than never
    // having woken it, because the collapse then happens in front of the first player to arrive.
    const pact = _st.powderActive;
    if (!(fact && fact.size) && !(seeded && seeded.size) && !(burning && burning.size) && !(pact && pact.size)) break;
    liquidTickCount++;
    const SUB = _st.fineSub || 1;
    if (liquidCfg.reactions) fineReactTickRoom(avatarRoom, SUB);
    fineLiquidTickRoom(avatarRoom, SUB);
    if (liquidCfg.reactions) fineReactTickRoom(avatarRoom, SUB);
    // Powder runs in lockstep with liquid in the live tick (same gravity), so it does here too — otherwise a
    // grain sinking through water settles at a different rate before a joiner sees it than after.
    if (pact && pact.size) { powderTickCount++; powderTickRoom(avatarRoom); }
  }
  // (There used to be a pass here putting still-airborne DROPLETS back into the grid, so the cap could not leave water
  // falling on the first joiner. It went with the droplet cascade — nothing is ever in flight outside the grid now.)
  liquidQuiet = false;
  // Do NOT hard-freeze the active set. If the liquid fully settled, liquidTickRoom already cleared it. If a big field is
  // still leveling after the cap, leave it ACTIVE so the live sim finishes the job (broadcasting diffs) — the old
  // unconditional freeze left non-level pools + frozen mid-air stream slivers that never resolved once cut off mid-settle.
}
// Spawn point = world-centre column resting on the terrain SURFACE there (so a generated world
// drops you on top of the ground, not buried in it). Falls back to the floor when that column is
// empty (sandbox / un-generated). y is the feet position (top of the first solid cell).
// ⚠️ THE SPAWN COLUMN IS PER-ROOM (Phase 6 increment 6). A page room spawns you at its middle, as it always has;
// an Overworld room spawns you at the site's own column, from the domain registry. The COLUMN is the only thing
// that differs — finding the ground at that column is the same code either way, which is the whole reason
// placement is one-dimensional.
// ⚠️ Returns the spawn X IN PIXELS, not a column — because a page room's spawn is exactly `WORLD_W / 2` and
// always has been, and rounding it through a column would move it by half a cell. A 4px shift is invisible to
// look at and would still be a behaviour change on a path that is meant to be untouched.
// ⚠️ `rec` IS THE SOCKET'S OWN DOMAIN RECORD and it has to be passed in. Everywhere else in the server a spawn
// is a property of the ROOM; in the Overworld every player has their own, because the room is shared and the
// page they came from is what decides where they arrive. There is nothing about the room key to look it up
// from — `OVERWORLD_ROOM` is the same string for everybody — so it is resolved at the join and handed down.
function spawnXOf(avatarRoom, rec) {
  const d = rec || null;
  return d ? (d.col + 0.5) * TERRAIN_CELL : (MWSim.C.WORLD_W / 2);
}
// The identity an Overworld room is placed BY. `avatarRoomKey` is 'av:<roomId>:<levelIndex>' and the roomId is the
// page URL, so the identity is the middle field — normalised to a host by domains.normalizeIdentity.
// ⭐ IS THIS A SITE'S FRONT DOOR? The one test that decides Overworld-versus-island, kept beside
// `overworldIdentity` because the two are halves of the same question: this decides WHETHER you go, that one
// decides WHERE. Room keys are `hostname + pathname + search`.
// ⚠️ THE QUERY STRING IS IGNORED, DELIBERATELY. `example.com/?utm_source=twitter` is a front door wearing a
// tracking tag, and sending it to an island instead would be the friendlier failure inverted — a huge share of
// real links to home pages carry campaign parameters. The cost is that a bare-host search page
// (`google.com/?q=...`) reads as Google's front door. Judged the better trade; revisit with the middle tier.
// ⚠️ `index.html` and friends are NOT special-cased. Named here so it is a known gap rather than a surprise.
// ⭐⭐ A SITE'S FRONT DOOR IS OFTEN NOT THE BARE HOST, which is the user's report: *"if I go to x.com, the main
// home page is x.com/home, and it loads into a page-world rather than an overworld... this is undesirable"*.
// Typing `x.com` lands you on `x.com/home`; `github.com` on `/dashboard`; plenty of apps do this.
// 🟥 THE OBVIOUS LOOSENING IS WRONG: "allow one path segment" would send `youtube.com/watch`,
// `x.com/i/status/…` and `reddit.com/r/space` to the Overworld too, and those are pages, not front doors.
// ⇒ bare host, OR a single path segment that is a known APP-SHELL word. Short, readable, and extensible; the
// bare host always works, so an unknown shell word costs an island room rather than anything broken.
// ⚠️ This is a heuristic about the web, not a fact about it, and it will be wrong sometimes in both
// directions. That is why HOME_PATH_FOR exists: a per-domain override for anything the list cannot express.
const HOME_PATHS = new Set(['home', 'feed', 'dashboard', 'index', 'index.html', 'index.htm', 'index.php',
  'main', 'explore', 'timeline', 'for-you', 'foryou', 'start', 'portal', 'default.aspx']);
// Per-domain overrides, for sites whose front door is a path no general rule would guess. The value is the
// path (no leading slash) that counts AS the front door, in addition to the bare host.
const HOME_PATH_FOR = new Map([
  ['mail.google.com', 'mail/u/0'],
]);
function isDomainHome(roomKey) {
  let s = String(roomKey == null ? '' : roomKey).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');          // protocol
  s = s.replace(/^www\./, '');
  s = s.replace(/[?#].*$/, '');                          // query and hash are not a different PAGE
  if (!s) return false;                                  // an empty key is not a front door
  const slash = s.indexOf('/');
  if (slash < 0) return true;                            // bare host
  const host = s.slice(0, slash);
  const p = s.slice(slash + 1).replace(/\/+$/, '');      // path with no leading or trailing slash
  if (!p) return true;                                   // host + a single trailing slash
  const override = HOME_PATH_FOR.get(host);
  if (override && p === override) return true;
  return p.indexOf('/') < 0 && HOME_PATHS.has(p);        // ONE segment, and it is a shell word
}
// Is this front door a HARNESS rather than a site? `.test` is reserved by RFC 6761, so nothing real can be one.
// Its own Overworld — see OVERWORLD_TEST_ROOM for why, and scratchpad/circular_voids.md for what it cost.
function isTestIdentity(roomKey) {
  const id = DOMAINS.normalizeIdentity(roomKey);           // protocol, www., path, port all stripped → a bare host
  return id === 'test' || id.endsWith('.test');
}
function overworldIdentity(avatarRoom) {
  const s = String(avatarRoom);
  const a = s.indexOf(':'), b = s.lastIndexOf(':');
  return (a >= 0 && b > a) ? s.slice(a + 1, b) : s;
}
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  ONE CLOCK FOR EVERYBODY. The sky was a day/night cycle driven by each viewer's OWN wall clock, so two people
//  standing next to each other could be in daylight and midnight — which is merely odd while the sky is a
//  backdrop, and incoherent the moment the sun casts the shadows everyone is walking through.
//  ⭐ IT IS A FUNCTION OF THE WALL CLOCK, NOT A TICKING COUNTER, and that is the whole design: there is no state
//  to keep, nothing to broadcast per tick, nothing to resynchronise after a restart, and a client that joins an
//  hour later computes the same phase everyone else already has. Clients whose clocks disagree by a few seconds
//  disagree by a few seconds out of a four-hour cycle, which is nothing.
//  ⚠️ The epoch is fixed (Unix 0), not "when the server started" — otherwise every restart would jerk the world
//  back to the same time of day, which players would notice long before anybody thought to look for it.
//  ⭐ FOUR HOURS by default (user's call): short enough that anyone playing in a normal evening sees both day and
//  night, long enough that neither is over before you have done anything.
const worldClock = { cycleMs: 4 * 3600 * 1000, offsetMs: 0 };
function worldClockWire() { return { cycleMs: worldClock.cycleMs, offsetMs: worldClock.offsetMs }; }

// ⭐ A SHORT DROP, NOT A PLACEMENT FLUSH ON THE GROUND. Standing a body exactly on the surface row means any
// disagreement between the generator's idea of the surface and the cells that actually arrive puts the feet
// INSIDE rock, and a body that starts inside rock has no clean way out. Starting a few cells up costs a
// quarter-second of freefall and turns every such disagreement into a landing. `bandGroundAt` is asked for 5
// cells of clearance, so 3 cells of it is air by construction.
const SPAWN_DROP_PX = TERRAIN_CELL * 3;
function worldSpawnFor(avatarRoom, rec) {
  const x = spawnXOf(avatarRoom, rec);
  const col0 = Math.floor(x / TERRAIN_CELL);
  // ⭐ THE OVERWORLD ASKS THE GENERATOR, NOT THE GRID. Its world is mostly not produced, so scanning the stored
  // grid would either read air (and drop you through the floor) or fault in the whole column to find out — and
  // for a 4,096-row world that is 64 chunks produced to answer one question. `bandGroundAt` walks the column
  // arithmetically, produces nothing, and knows about liquid, so it will not stand you on a lava lake's bed.
  // It also honours the site's DEPTH BAND: a sky site lands on its floating island, an underground one in its
  // hall, which is the interface increment 6 built placement against.
  if (rec && overworldRooms.has(avatarRoom)) {
    const gen = _roomGens.get(avatarRoom), b = domains.bandRows(rec.band);
    if (gen && b) {
      const r = gen.bandGroundAt(col0, b.r0, b.r1, 5);
      // ⚠️ Traced with the COLUMN AND THE BAND, not just the coordinate: the two are decided by different
      // things (the registry allocates the column, the generator finds the ground in the band), so a spawn that
      // moves across a restart says nothing about WHICH of them moved unless both are on the line.
      if (worldCfg.tracePersist) console.log(`[persist] spawn ${avatarRoom}: col ${col0} band ${rec.band} → row ${r} (x ${x}, y ${Math.max(0, r * TERRAIN_CELL - SPAWN_DROP_PX)})`);
      if (r >= 0) return { x, y: Math.max(0, r * TERRAIN_CELL - SPAWN_DROP_PX) };
      // ⚠️ NO GROUND IN THE BAND IS A REAL OUTCOME, not an error — the generator guarantees ground in every band
      // at SOME column, not at every column. Falling back to the surface band is better than falling to the
      // world floor, which for a sky site would be 32,000px of freefall.
      const s = domains.bandRows('surface');
      const sr = gen.bandGroundAt(col0, s.r0, s.r1, 5);
      if (sr >= 0) return { x, y: Math.max(0, sr * TERRAIN_CELL - SPAWN_DROP_PX) };
    }
  }
  const grid = peekCells(avatarRoom).terrain;
  if (!grid) return { x, y: FLOOR_TOP };
  const COLS = grid.geom.cols, ROWS = grid.geom.rows;
  const col = Math.max(0, Math.min(COLS - 1, col0));
  for (let r = 0; r < ROWS; r++) if (grid.g(col * ROWS + r)) return { x, y: r * TERRAIN_CELL };
  return { x, y: FLOOR_TOP };
}
// Keep-clear no-build box above the spawn surface — world mode only (sandbox has no protection).
function spawnClearRect(avatarRoom) {
  if (!worldGenerated.has(avatarRoom)) return null;
  // ⏭️ THE OVERWORLD HAS NO SINGLE SPAWN, so there is no single box to keep clear — it has one spawn per placed
  // site, and protecting them means asking the domain registry for every site near the edit, not asking the room
  // for its spawn. Deliberately unprotected for now rather than protecting the WRONG place: without this, the
  // call below would resolve to a page room's centre (`WORLD_W / 2`, column 120) and fence off an arbitrary
  // patch of the shared world that is nobody's spawn. Open item on increment 7.
  if (overworldRooms.has(avatarRoom)) return null;
  const sp = worldSpawnFor(avatarRoom);
  return { x0: sp.x - SPAWN_CLEAR_HALF_W, x1: sp.x + SPAWN_CLEAR_HALF_W, y0: sp.y - SPAWN_CLEAR_H, y1: sp.y };
}
function aabbHitsClear(rect, x0, y0, x1, y1) {       // AABB overlap test (null rect = no protection)
  return !!rect && x0 < rect.x1 && x1 > rect.x0 && y0 < rect.y1 && y1 > rect.y0;
}
const MAT_HEX = /^#[0-9a-fA-F]{6}$/;
function sanitizeMatTex(raw) {                          // hand-drawn 8×8 appearance: array of 64 ('' | #rrggbb); null if blank/invalid
  if (!Array.isArray(raw) || raw.length !== 64) return null;
  const t = raw.map(c => (typeof c === 'string' && MAT_HEX.test(c)) ? c : '');
  return t.some(c => c) ? t : null;
}
function sanitizeMatImg(raw) {                          // optional http(s) image-URL skin; null if invalid (data: rejected to keep defs small for broadcast)
  if (typeof raw !== 'string') return null;
  const u = raw.trim();
  return /^https?:\/\//i.test(u) && u.length <= 1024 ? u : null;
}
function sanitizeMatDef(raw) {
  if (!raw || typeof raw !== 'object' || !MAT_HEX.test(raw.fill) || !MAT_HEX.test(raw.cap)) return null;
  return {
    name: String(raw.name || 'Custom').slice(0, 24),
    base: Math.max(0, Math.min(TERRAIN_MAT_MAX, raw.base | 0)),   // representative built-in id (cosmetic/back-compat)
    behavior: ['solid', 'fluid', 'hazard'].includes(raw.behavior) ? raw.behavior : 'solid',   // 11s class
    surface: ['none', 'ice', 'mud', 'snow'].includes(raw.surface) ? raw.surface : 'none',     // 11s solid friction group
    bouncy: raw.bouncy === true,
    conveyor: raw.conveyor > 0 ? 1 : raw.conveyor < 0 ? -1 : 0,
    dusty: raw.dusty === true,
    liquid: ['water', 'brine', 'oil', 'quicksand'].includes(raw.liquid) ? raw.liquid : 'water',
    fill: raw.fill, cap: raw.cap,
    capShade: MAT_HEX.test(raw.capShade) ? raw.capShade : raw.cap,
    breakable: raw.breakable !== false,
    strength: Math.max(1, Math.min(9, (raw.strength | 0) || 1)),   // hits to destroy (only applies when breakable)
    tex: sanitizeMatTex(raw.tex),
    img: sanitizeMatImg(raw.img),
  };
}
function matSig(d) { return d.name + '|' + d.base + '|' + d.behavior + '|' + d.surface + '|' + (d.bouncy ? 1 : 0) + '|' + d.conveyor + '|' + (d.dusty ? 1 : 0) + '|' + d.liquid + '|' + d.fill + '|' + d.cap + '|' + d.capShade + '|' + (d.breakable ? 1 : 0) + '|' + (d.strength | 0) + '|' + (d.tex ? d.tex.join('') : '') + '|' + (d.img || ''); }
function terrainRLE(grid) {                          // [value, count] runs (value = material id, 0 = empty)
  // ⚠️ EMITS ROW-MAJOR — READING LEFT-TO-RIGHT, TOP-TO-BOTTOM — AND THAT IS NOW A DELIBERATE SERIALISATION ORDER
  // RATHER THAN 'flat index order'. Increment 5 made the in-memory index COLUMN-major; this stayed row-major so every
  // blob already in `published_worlds` keeps its meaning (no migration, no re-stride, no resample) and the client's
  // rasteriser is unchanged. The two orders differ, so do not 'tidy' this into an index walk.
  // Paged: the page is resolved once per chunk-wide run instead of per cell, and an unallocated page contributes a
  // run of zeros without being faulted in — so a join replay never materialises the parts of the world nobody has
  // touched, which is the whole point of Phase 3. (A page is ROW-major internally, so a row within one is still
  // contiguous at `off + k` — which is why this walk survives the change untouched below the index itself.)
  const g = grid.geom, runs = []; let v = -1, n = 0;
  for (let r = 0; r < g.rows; r++) {
    for (let c0 = 0; c0 < g.cols;) {
      const i = c0 * g.rows + r, page = grid.pageAt(geomPage(g, i)), off = grid.o(i) / grid.T;
      const len = Math.min(CHUNK_SIDE - (off % CHUNK_SIDE), g.cols - c0);
      if (!page) { if (v === 0) n += len; else { if (n) runs.push([v, n]); v = 0; n = len; } }
      else for (let k = 0; k < len; k++) { const val = page[off + k]; if (val === v) n++; else { if (n) runs.push([v, n]); v = val; n = 1; } }
      c0 += len;
    }
  }
  if (n) runs.push([v, n]);
  return { runs };
}
const roomVoice = {};

// ---- Authoritative avatar simulation (Stage 1b) ----------------------------
// One fixed-timestep simulation per room that has active avatars. Clients send
// inputs (avatar-input); the server steps the shared MWSim and broadcasts
// authoritative snapshots (avatar-snapshot). See server/avatar-sim.js.
const roomSim = {}; // room → { platforms, avatars:{id:state}, queues:{id:[input]}, lastInput:{id}, meta:{id:{username,fill}}, tick, snapCount, interval }
const NEUTRAL_INPUT = { left: false, right: false, down: false, jump: false, grab: false, respawn: false };
const TICKS_PER_SNAPSHOT = Math.max(1, Math.round(MWSim.C.TICK_HZ / MWSim.C.SNAPSHOT_HZ));

function ensureRoomSim(room, layout) {
  let rs = roomSim[room];
  if (!rs) {
    const idx = ((layout | 0) % MWSim.STAGE_LAYOUTS.length + MWSim.STAGE_LAYOUTS.length) % MWSim.STAGE_LAYOUTS.length;
    rs = roomSim[room] = {
      platforms: MWSim.STAGE_LAYOUTS[idx], avatars: {}, queues: {}, lastInput: {}, meta: {},
      tick: 0, snapCount: 0, interval: null
    };
  }
  return rs;
}

function startRoomTick(room) {
  const rs = roomSim[room];
  if (!rs || rs.interval) return;
  const stepMs = 1000 / MWSim.C.TICK_HZ;
  rs.interval = setInterval(() => {
    const ids = Object.keys(rs.avatars);
    if (ids.length === 0) { stopRoomTick(room); return; }
    const list = ids.map(id => rs.avatars[id]);
    const byId = rs.avatars;
    // 1) Movement: process each avatar's queued inputs (one per tick, draining a
    //    backlog up to 2/tick). On an EMPTY queue we HOLD — we do NOT repeat the last
    //    input. Repeating would advance the sim past what the client predicted for that
    //    seq and force a reconciliation correction every snapshot (the mid-jump jitter).
    for (const s of list) {
      const q = rs.queues[s.id] || (rs.queues[s.id] = []);
      if (s.grabbedBy) { // pinned by the grabber; consume inputs without applying
        if (q.length) { s.lastSeq = q[q.length - 1].seq; q.length = 0; }
        continue;
      }
      const steps = q.length > 6 ? 2 : (q.length > 0 ? 1 : 0);
      for (let k = 0; k < steps; k++) {
        MWSim.stepMovement(s, q.shift(), rs.platforms);
      }
    }
    // 2) Interactions, resolved authoritatively after everyone has moved.
    MWSim.resolveGrabThrow(list, byId);
    MWSim.resolveCollisions(list, byId);
    rs.tick++;
    // 3) Broadcast a snapshot at SNAPSHOT_HZ.
    if (++rs.snapCount >= TICKS_PER_SNAPSHOT) {
      rs.snapCount = 0;
      const avatars = list.map(s => Object.assign(MWSim.snapshot(s), rs.meta[s.id] || {}));
      io.to(room).emit('avatar-snapshot', { tick: rs.tick, t: Date.now(), avatars });
    }
  }, stepMs);
}

function stopRoomTick(room) {
  const rs = roomSim[room];
  if (rs && rs.interval) { clearInterval(rs.interval); rs.interval = null; }
  delete roomSim[room];
}

function removeSimAvatar(room, id) {
  const rs = roomSim[room];
  if (!rs) return;
  const s = rs.avatars[id];
  if (s) { // release any grab relationship so partners aren't left dangling
    if (s.grabbing && rs.avatars[s.grabbing]) rs.avatars[s.grabbing].grabbedBy = null;
    if (s.grabbedBy && rs.avatars[s.grabbedBy]) rs.avatars[s.grabbedBy].grabbing = null;
  }
  delete rs.avatars[id]; delete rs.queues[id]; delete rs.lastInput[id]; delete rs.meta[id];
  io.to(room).emit('avatar-leave', { id });
  if (Object.keys(rs.avatars).length === 0) stopRoomTick(room);
}
const socketVoiceScope = {}; // socketId → voice scope ('page' uses currentRoom; else 'dm:X', 'room:X', 'group:X')
const userCurrentFullUrl = {};
const socketDmRooms = {};      // socketId → Set of DM roomIds
const socketToDiscordId = {};  // socketId → discordId
const socketToUsername = {};   // socketId → username (identity key for unverified users; dedup + avatar takeover)
const discordIdToSocket = {};       // discordId → socketId (latest socket, for DMs/invites/etc.)
const discordIdToFollowSockets = {}; // discordId → Set<socketId> (all active tabs, for followee-nav)
const discordIdToFullUrl = {}; // discordId → current full URL (active tab)
const MAX_HISTORY = 50;
const MAX_SPRAYS = 50;
const MAX_MEDIA = 30;

// ---- Follow: per-leader tab snapshots --------------------------------------
// The authoritative model for following. Each verified user's extension tabs
// register here (one socket per tab). On any change we emit a full `followee-tabs`
// snapshot to their followers, who reconcile their own tabs from it (single or
// mirror mode, decided follower-side). Replaces the old per-event followee-nav /
// followee-tab-focus relay.
const leaderTabs = {};         // discordId → Map<tabSession, url>  (all extension tabs)
const leaderActiveTab = {};    // discordId → tabSession            (the focused tab)
const socketToTabSession = {}; // socketId  → tabSession
const leaderSnapshotSeq = {};  // discordId → monotonic int (within an epoch)
const leaderEpoch = {};        // discordId → epoch token (changes each fresh browsing session)
// When a socket disconnects we wait briefly before emitting the "tab gone" snapshot.
// Same-tab navigation briefly disconnects then reconnects with the SAME tabSession; the
// debounce lets the rejoin cancel the removal, preventing a close+reopen flicker for followers.
const tabDisconnectTimers = {}; // `${discordId}:${tabSession}` → timerId
const TAB_DISCONNECT_DEBOUNCE_MS = 1000;

function broadcastPresence(room) {
  // Collapse multiple sockets of the SAME user into one who-list entry — when locked into a context Room,
  // every page you open auto-joins that Room's presence bucket, and two tabs on one page share a bucket too;
  // either way one identity = one member. Keyed by discord_id (verified) or username (unverified).
  const seen = new Set(), users = [];
  for (const u of Object.values(roomUsers[room] || {})) {
    const key = u.discord_id || ('u:' + u.username);
    if (seen.has(key)) continue;
    seen.add(key); users.push(u);
  }
  io.to(room).emit('presence', { count: users.length, users });
}

// Distinct-identity headcount of a roomUsers bucket (discord_id, or 'u:'+username). Used by the
// room-list endpoints to report live "in room" / "on page" counts. (broadcastPresence already dedups
// the who-list the same way; #4's join/left toasts dedup client-side off the presence list.)
function identityCount(bucket) {
  const seen = new Set();
  for (const u of Object.values(bucket || {})) seen.add(u.discord_id || ('u:' + u.username));
  return seen.size;
}

// Headcount of distinct identities on a page (bare URL room), independent of context Room.
function broadcastPagePresence(room) {
  const seen = new Set();
  for (const u of Object.values(pageUsers[room] || {})) {
    const key = u.discord_id || ('u:' + u.username);
    seen.add(key);
  }
  io.to(room).emit('page-presence', { count: seen.size });
}

function buildTabSnapshot(discordId, username) {
  const tabsMap = leaderTabs[discordId];
  if (!tabsMap || tabsMap.size === 0) return null;
  const tabs = [...tabsMap.entries()].map(([id, url]) => ({ id, url }));
  let activeId = leaderActiveTab[discordId];
  if (!activeId || !tabsMap.has(activeId)) activeId = tabs[tabs.length - 1].id;
  const activeUrl = tabsMap.get(activeId);
  const seq = (leaderSnapshotSeq[discordId] = (leaderSnapshotSeq[discordId] || 0) + 1);
  const epoch = leaderEpoch[discordId] || 0;
  return { leaderId: discordId, username, tabs, activeId, activeUrl, seq, epoch };
}

// Build + push the current snapshot to all of this user's followers.
function emitTabSnapshot(discordId, username) {
  const settings = db.prepare('SELECT browsing_visible FROM users WHERE discord_id = ?').get(discordId);
  if (!settings?.browsing_visible) return;
  const snap = buildTabSnapshot(discordId, username);
  if (!snap) return;
  discordIdToFullUrl[discordId] = snap.activeUrl; // keep friends-panel location in sync
  const followers = db.prepare('SELECT follower_id FROM follows WHERE followee_id = ?').all(discordId);
  followers.forEach(r => {
    const fSocks = discordIdToFollowSockets[r.follower_id];
    if (fSocks) fSocks.forEach(sid => io.to(sid).emit('followee-tabs', snap));
  });
}

// Send one followee's current snapshot to a single follower socket (resync on connect).
function emitSnapshotToFollower(followeeId, followeeUsername, socketId) {
  const settings = db.prepare('SELECT browsing_visible FROM users WHERE discord_id = ?').get(followeeId);
  if (!settings?.browsing_visible) return;
  const snap = buildTabSnapshot(followeeId, followeeUsername);
  if (snap) io.to(socketId).emit('followee-tabs', snap);
}

// Build a validated world object from a client/stored descriptor. Shared by the live `avatar-object-spawn`
// handler AND server-side published-World hydration (7b), so both apply identical clamps/validation.
// Returns the obj (anchor clamped to world bounds) or null if invalid. The CALLER handles id-dedup,
// band-clamp, spawn-clear, the object cap, and broadcast.
function buildWorldObject(type, data, id, ownerId, ownerName) {
  const WW = MWSim.C.WORLD_W, WH = MWSim.C.WORLD_H;
  let obj;
  if (type === 'stroke') {
    if (!Array.isArray(data.pts)) return null;
    const pts = [];
    for (const p of data.pts) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
      pts.push({ x: Math.max(0, Math.min(WW, p.x)), y: Math.max(0, Math.min(WH, p.y)) });
      if (pts.length >= 200) break;                       // per-stroke point cap
    }
    if (pts.length < 2) return null;
    let sx = 0, sy = 0; for (const p of pts) { sx += p.x; sy += p.y; }
    obj = { id, type, ownerId, owner: ownerName, x: sx / pts.length, y: sy / pts.length, pts,
            w: clampN(data.w, 2, 40, 8),
            color: (typeof data.color === 'string' && data.color.length <= 32) ? data.color : '#22c55e',
            hp: data.breakable === false ? null : 3 };   // indestructible when breakable:false (matches stamps/platforms)
    {                                                        // any stroke can carry a modifier (same clamps as platforms)
      const boost = clampN(data.boost, -48, 48, 0), updraft = clampN(data.updraft, 0, 30, 0);
      if (data.bouncy) obj.bouncy = 1;
      else if (boost) obj.boost = boost;
      else if (updraft) { obj.updraft = updraft; obj.fanLen = clampN(data.fanLen, 0.3, 3, 1);
        obj.fanMode = ['push', 'pull', 'pulse', 'pulsepush', 'pulsepull', 'alt'].includes(data.fanMode) ? data.fanMode : 'push';
        obj.fanPeriod = clampN(data.fanPeriod, 0.5, 6, 2); }
      if (obj.bouncy || obj.boost || obj.updraft) obj.side = (data.side === -1) ? -1 : 1;   // open-stroke active side
      if (SURF_TYPES.includes(data.surf)) obj.surf = data.surf;     // contact-property surface modifier
    }
  } else if (type === 'stamp') {
    if (typeof data.content !== 'string' || !data.content || data.content.length > 8192) return null;
    if (!isFinite(data.x) || !isFinite(data.y)) return null;
    obj = { id, type, ownerId, owner: ownerName,
            x: Math.max(0, Math.min(WW, data.x)), y: Math.max(0, Math.min(WH, data.y)),
            content: data.content, w: clampN(data.w, 24, 160, 64), h: clampN(data.h, 24, 160, 64),
            shape: (data.shape === 'ellipse' || data.shape === 'tri') ? data.shape : 'rect',
            angle: clampN(data.angle, -Math.PI, Math.PI, 0),
            stretch: data.stretch === true,               // image stamps: stretch-to-fill vs aspect-fit (default)
            hp: data.breakable === false ? null : 2 };   // indestructible when breakable:false
    if (SURF_TYPES.includes(data.surf)) obj.surf = data.surf;       // contact-property surface modifier
  } else if (type === 'checkpoint' || type === 'goal' || type === 'spawn') {
    if (!isFinite(data.x) || !isFinite(data.y)) return null;
    obj = { id, type, ownerId, owner: ownerName,
            x: Math.max(0, Math.min(WW, data.x)), y: Math.max(0, Math.min(WH, data.y)),
            angle: clampN(data.angle, -Math.PI, Math.PI, 0),   // scroll-set base rotation (round-trips like stamps)
            hp: data.breakable === false ? null : 2 };  // erasable/destructible like other props
    if (type === 'goal' && isFinite(data.target)) obj.target = Math.max(-1, Math.min(63, data.target | 0));  // series destination Level (-1 = next; Phase 5b)
  } else if (type === 'portal') {
    if (!isFinite(data.x) || !isFinite(data.y)) return null;
    obj = { id, type, ownerId, owner: ownerName,
            x: Math.max(0, Math.min(WW, data.x)), y: Math.max(0, Math.min(WH, data.y)),
            pair: (typeof data.pair === 'string' && data.pair.length <= 64) ? data.pair : id,
            entry: data.entry !== false, oneWay: data.oneWay === true,
            angle: clampN(data.angle, -Math.PI, Math.PI, 0),   // scroll-set base rotation (round-trips like stamps)
            oval: clampN(data.oval, 0, 1, 0),        // ovalness: 0 = circle → 1 = narrow (round-trips; both ends share it)
            hue: clampN(data.hue, 0, 360, 275),     // user-chosen pair colour (round-trips; both ends share it)
            hp: data.breakable === false ? null : 2 };
  } else {
    if (!isFinite(data.x) || !isFinite(data.y)) return null;
    obj = { id, type: 'platform', ownerId, owner: ownerName,
            x: Math.max(0, Math.min(WW, data.x)), y: Math.max(0, Math.min(WH, data.y)),
            w: clampN(data.w, 24, 400, 96), h: clampN(data.h, 8, 60, 16),
            angle: clampN(data.angle, -Math.PI, Math.PI, 0),
            spin: clampN(data.spin, -0.012, 0.012, 0),     // continuous rotation (rad/ms; 0 = static)
            boost: clampN(data.boost, -48, 48, 0), updraft: clampN(data.updraft, 0, 30, 0),
            fanLen: clampN(data.fanLen, 0.3, 3, 1),        // fan effective-distance multiplier (× base column height)
            fanMode: ['push', 'pull', 'pulse', 'pulsepush', 'pulsepull', 'alt'].includes(data.fanMode) ? data.fanMode : 'push',
            fanPeriod: clampN(data.fanPeriod, 0.5, 6, 2),  // pulse/alt cycle length (seconds)
            hp: data.breakable === false ? null : 2 };     // indestructible when breakable:false
    if (data.bouncy) obj.bouncy = 1;
    if (SURF_TYPES.includes(data.surf)) obj.surf = data.surf;       // contact-property surface modifier
    if (isFinite(data.topHue)) obj.topHue = clampN(data.topHue, 0, 360, 0);   // custom top-surface colour (round-trips)
    if (isFinite(data.botHue)) obj.botHue = clampN(data.botHue, 0, 360, 0);   // custom body colour (round-trips)
    if (data.pivot === 'left' || data.pivot === 'right') obj.pivot = data.pivot;   // rotate around an edge
    if (data.osc && typeof data.osc === 'object' && isFinite(data.osc.w) && isFinite(data.osc.amp)) {
      obj.osc = { w: clampN(data.osc.w, -0.25, 0.25, 0),   // oscillating rotation (sweep an arc, no full spin)
                  amp: clampN(data.osc.amp, 0, Math.PI, 0),
                  phase: clampN(data.osc.phase, 0, Math.PI * 2, 0) };
    }
    if (data.path && Array.isArray(data.path.pts) && data.path.pts.length >= 2) {
      const pts = [];
      for (const p of data.path.pts) {
        if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
        pts.push({ x: Math.max(0, Math.min(WW, p.x)), y: Math.max(0, Math.min(WH, p.y)) });
        if (pts.length >= 64) break;
      }
      if (pts.length >= 2) obj.path = { pts, loop: !!data.path.loop,
        speed: clampN(data.path.speed, 0.02, 1.2, 0.18), phase: clampN(data.path.phase, 0, 1, 0) };
    }
  }
  return obj;
}
// ---- Phase 7b: server-side hydration of a PUBLISHED World room (no host present) ----
// Twin of the client `applyLevel`: load a stored Lvl blob (terrain RLE + mats + objects) directly into the
// in-memory room state. Runs once per av-room per server lifetime, before the avt-join replay, so every
// joiner (incl. the first) gets the content. Re-runs after a restart → robust unattended rooms.
function hydrateRoomFromBlob(avRoom, blob) {
  if (!blob || !blob.terrain) return;
  const terr = blob.terrain;
  const sc = terr.cols | 0, sr = terr.rows | 0;
  if (!sc || !sr) return;
  const mats = ensureMats(avRoom);
  if (blob.mats && typeof blob.mats === 'object') {
    for (const k in blob.mats) { const d = sanitizeMatDef(blob.mats[k]); if (d) mats[k] = d; }
  }
  const grid = ensureTerrain(avRoom), hp = ensureTerrainHp(avRoom);
  grid.fill(0); hp.fill(0);
  // Decode the stored runs at their OWN resolution, then NEAREST-NEIGHBOUR resample to the current grid. Worlds saved
  // at the old 24px res (cols 640) upscale 1→3×3 into the 8px grid (1920) instead of being skipped (which would leave
  // published/persistent rooms empty AND let autosave overwrite their live_state with nothing).
  const src = new Uint8Array(sc * sr); { let i = 0; for (const run of terr.runs || []) { const v = run[0] | 0, n = run[1] | 0; for (let k = 0; k < n && i < src.length; k++, i++) src[i] = v; } }
  const srcHp = new Uint8Array(sc * sr); if (Array.isArray(terr.hpRuns)) { let j = 0; for (const run of terr.hpRuns) { const val = run[0] | 0, n = run[1] | 0; for (let k = 0; k < n && j < srcHp.length; k++, j++) srcHp[j] = val; } }
  // ⚠️ A STORED BLOB IS ROW-MAJOR (`si = row * sc + col`) and stays that way — increment 5 changed the in-memory
  // index, not the serialisation, so every published_worlds row is still valid and needs no migration.
  const COLS = grid.geom.cols, ROWS = grid.geom.rows;                   // Phase 6: resample into THIS room's shape
  for (let r = 0; r < ROWS; r++) { const rs = Math.min(sr - 1, (r * sr / ROWS) | 0);
    for (let c = 0; c < COLS; c++) { const cs = Math.min(sc - 1, (c * sc / COLS) | 0); const si = rs * sc + cs, v = src[si]; if (v) { const di = c * ROWS + r; grid.s(di, v); hp.s(di, srcHp[si] || matStrengthSrv(mats, v)); } } }
  const map = roomObjects[avRoom] || (roomObjects[avRoom] = new Map());
  let placed = 0;
  for (const src of blob.objects || []) {
    if (placed >= MAX_OBJECTS_PER_ROOM) break;
    if (!src || !OBJ_TYPES.has(src.type)) continue;
    const id = 'pub-' + (++objSeq);
    const obj = buildWorldObject(src.type, src, id, id, 'world');   // server-owned (ownerId = its own id → not user-evictable)
    if (obj) { map.set(id, obj); placed++; }
  }
}
const _roomKindSpec = db.prepare('SELECT kind, env_spec FROM rooms WHERE id = ?');
const _pubWorldGet  = db.prepare('SELECT content, durability, live_state FROM published_worlds WHERE id = ?');
// Resolve a published room+Level → the Lvl blob to hydrate from (durability-aware). null if not a published
// room or the Level has no `pub` ref. Persistent → the saved live-state for that Level, else the baseline.
function publishedHydrationFor(roomId, levelIndex) {
  let row; try { row = _roomKindSpec.get(roomId); } catch { return null; }
  if (!row || row.kind !== 'published' || !row.env_spec) return null;
  let spec; try { spec = JSON.parse(row.env_spec); } catch { return null; }
  const lvl = (spec && Array.isArray(spec.levels)) ? spec.levels[levelIndex | 0] : null;
  const pub = lvl && lvl.pub;
  if (!pub || !pub.world) return null;
  let w; try { w = _pubWorldGet.get(pub.world); } catch { return null; }
  if (!w) return null;
  const li = Number.isInteger(pub.lvl) ? pub.lvl : (levelIndex | 0);
  let content = null, live = null;
  try { content = JSON.parse(w.content); } catch { return null; }
  if (w.live_state) { try { live = JSON.parse(w.live_state); } catch {} }
  const baseBlob = (Array.isArray(content) && content[li]) || null;
  const liveBlob = (live && live[li]) || null;
  return { worldId: pub.world, durability: w.durability, blob: (w.durability === 'persistent' && liveBlob) ? liveBlob : baseBlob };
}
// One-shot hydration on avt-join. Marks the av-room as hydrated (shares `hydratedAvRooms` with the host
// path, so the owner's avt-hydrate won't double-fire). No-op for non-published rooms.
function maybeHydratePublished(avRoom, roomId, levelIndex) {
  if (hydratedAvRooms.has(avRoom)) return false;
  const h = publishedHydrationFor(roomId, levelIndex);
  if (!h) return false;
  hydratedAvRooms.add(avRoom);
  if (h.blob) hydrateRoomFromBlob(avRoom, h.blob);
  return true;
}
// ---- Phase 7b: Persistent durability — periodically snapshot a published room's live state back to the DB
// so it survives a server restart (Showcase worlds skip this and always reload the baseline). ----
function snapshotObjSrv(o) {                            // server twin of the client snapshotObj (drop ids/owner/hp; hp:null → breakable:false)
  const obj = {};
  for (const k in o) { if (k === 'id' || k === 'ownerId' || k === 'owner' || k === 'hp') continue; obj[k] = o[k]; }
  if (o.hp === null) obj.breakable = false;
  return obj;
}
// One number standing for "has ANY cell in this room changed" — a fold over the per-chunk content hashes, each of
// which is itself cached against its chunk's page revisions. A settled room therefore costs one pass over ~210
// cached u32s, not a walk of 777,600 cells. -1 = cannot answer (see the note in captureRoomBlob).
const _terrBlobCache = new Map();                       // avRoom → { sig, terrain, mats }
function roomChunkSig(avRoom) {
  const s = peekCells(avRoom); if (!s.terrain || (s.fineSub || 1) !== 1) return -1;
  const n = worldGeom(avRoom).nPages; let h = 0x811c9dc5;
  for (let p = 0; p < n; p++) { h = (h ^ chunkHash(avRoom, p)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
function captureRoomBlob(avRoom) {                      // → a Lvl blob (terrain RLE + used mats + objects), or null if empty
  materializeRoom(avRoom);   // ⚠️ an evicted chunk reads as zeros; persisting that would be silent DATA LOSS
  const grid = peekCells(avRoom).terrain, objs = roomObjects[avRoom];
  const hasTerr = grid && grid.some(v => v !== 0), hasObj = objs && objs.size;
  if (!hasTerr && !hasObj) return null;
  const g = grid || ensureTerrain(avRoom);
  // ⭐ DELTA PERSISTENCE (SHARED-WORLD.md §7, Phase 3). The terrain half is by far the expensive part of a snapshot
  // — a full-world RLE plus a scan for the custom materials it uses — and autosave runs it every 30s per persistent
  // Level whether or not anything moved. The chunk hashes answer exactly that question, so an unchanged world reuses
  // its previous encoding instead of recomputing it.
  // ⚠️ OBJECTS ARE NOT COVERED BY CHUNK HASHES (they are not cell state), so they are still rebuilt every pass —
  // ≤190 per room, cheap. Caching them off a terrain signature would silently miss an object edit.
  // ⚠️ `roomChunkSig` returns -1 when it cannot answer (no terrain yet, or SUB≠1 where the terrain and liquid grids
  // do not share a chunk grid); that bypasses the cache rather than pinning it at a constant signature forever.
  const sig = roomChunkSig(avRoom);
  let cached = _terrBlobCache.get(avRoom);
  if (sig < 0 || !cached || cached.sig !== sig) {
    const mats = {}, mm = roomMats[avRoom] || {};
    if (hasTerr) { const used = new Set(); g.scan((_i, o, page) => { const v = page[o]; if (v >= CUSTOM_MAT_MIN) used.add(v); }); for (const v of used) if (mm[v]) mats[v] = mm[v]; }
    cached = { sig, mats, terrain: { cols: g.geom.cols, rows: g.geom.rows, cell: TERRAIN_CELL, runs: terrainRLE(g).runs, hpRuns: peekCells(avRoom).terrainHp ? terrainRLE(peekCells(avRoom).terrainHp).runs : undefined } };
    if (sig >= 0) _terrBlobCache.set(avRoom, cached); else _terrBlobCache.delete(avRoom);
  }
  return {
    terrain: cached.terrain,
    mats: cached.mats,
    objects: objs ? [...objs.values()].filter(o => !(typeof o.id === 'string' && o.id.startsWith('world-'))).map(snapshotObjSrv) : [],
  };
}
const _persistentWorlds = db.prepare("SELECT id, room_id, content FROM published_worlds WHERE durability = 'persistent'");
const _setLiveState = db.prepare('UPDATE published_worlds SET live_state = ? WHERE id = ?');
const _liveStateHash = new Map();                       // worldId → last written JSON (skip unchanged writes)
function autosavePersistentWorlds() {
  let rows; try { rows = _persistentWorlds.all(); } catch { return; }
  for (const w of rows) {
    let content; try { content = JSON.parse(w.content); } catch { continue; }
    const n = Array.isArray(content) ? content.length : 0;
    const live = {}; let any = false;
    for (let li = 0; li < n; li++) { const blob = captureRoomBlob(avatarRoomKey(w.room_id, li)); if (blob) { live[li] = blob; any = true; } }
    if (!any) continue;                                  // room never visited this lifetime → don't clobber stored live-state
    const s = JSON.stringify(live);
    if (s.length > PUBLISHED_MAX_BYTES * 3) continue;    // safety bound
    if (_liveStateHash.get(w.id) === s) continue;        // nothing changed since the last write
    _liveStateHash.set(w.id, s);
    try { _setLiveState.run(s, w.id); } catch {}
  }
}
setInterval(autosavePersistentWorlds, 30000);

// ---- Dropped material: spawn / collect / expire ----
// Where does a drop come to rest? Straight down from the cell it was dug out of, to the top of the first solid
// cell. ⚠️ `grid.g()` FAULTS A PAGE IN on an on-demand room (F21 — reads are transparent to eviction), so the
// scan is deliberately short: a pile that falls a couple of chunks is already absurd, and an unbounded scan
// would let one dig over a shaft materialise a column of the world nobody is looking at.
// ⚠️ Order matters and it is not an accident: the client emits `terrain-edit` (the carve) before
// `terrain-drop`, and socket.io preserves per-socket order, so the cell the drop spawns in is already air.
function dropRestY(room, x, y) {
  const s = peekCells(room); const grid = s.terrain;
  const dims = roomDims(room);
  const c = Math.max(0, Math.min(dims.cols - 1, Math.floor(x / TERRAIN_CELL)));
  let r = Math.max(0, Math.floor(y / TERRAIN_CELL));
  if (!grid) return (Math.min(dims.rows - 1, r) + 0.5) * TERRAIN_CELL;
  const rows = dims.rows, lim = Math.min(rows - 1, r + DROP_FALL_MAX_CELLS);
  for (; r <= lim; r++) if (isSolidCell(grid.g(c * rows + r))) return (r - 0.5) * TERRAIN_CELL;   // rest ON TOP of the solid cell
  return (lim + 0.5) * TERRAIN_CELL;
}
// ⭐ WHERE A THROWN PILE COMES DOWN. `dropRestY` answers "straight down from here", which is right for a pile
// that a dig swing shook loose and wrong for one you deliberately threw. Same bounded-scan discipline and the
// same reason for it: `grid.g()` FAULTS A PAGE IN on a generated world (F21), so an unbounded arc would let one
// flick materialise a corridor of the world nobody is looking at.
// ⚠️ The step matches the client's fall constant, so the arc the client animates and the landing the server
// resolves are the same curve. They are two implementations of one motion; if they drift, a pile lands visibly
// somewhere other than where it settles.
const DROP_THROW_MAX_CELLS = 24;                      // how far sideways a throw may carry, in cells
// How long a deliberately-dropped pile refuses to be collected. Long enough that you can walk away from what
// you meant to put down, short enough that it is not a penalty. ⚠️ A DIG's pile has NO hold — instant pickup is
// the whole feel of mining, and this is the opposite gesture.
const INV_DROP_HOLD_MS = 1400;
// ⚠️ DECLARED ABOVE ITS USE, not below. `dropThrowLanding` is hoisted and this is not — a `const` read before
// its declaration is a ReferenceError, and this project has shipped that exact TDZ trap three times
// (`PAGE_DIMS`, `rpOn`, a debug-panel row). Nothing calls this during module evaluation today, which is
// precisely the kind of "true until someone moves a call" that those three were.
const DROP_FALL_A_SRV = 0.0011;                       // must equal the client's DROP_FALL_A (16b)
function dropThrowLanding(room, x, y, vx) {
  const s = peekCells(room); const grid = s.terrain;
  const dims = roomDims(room);
  if (!grid || !vx) return { x, y: dropRestY(room, x, y) };
  const maxX = DROP_THROW_MAX_CELLS * TERRAIN_CELL;
  let px = x, py = y, t = 0;
  const DT = 16;                                      // ms per step — one frame, so the curve is the client's
  for (let i = 0; i < 260; i++) {
    t += DT;
    const nx = x + vx * t, ny = y + 0.5 * DROP_FALL_A_SRV * t * t;
    if (Math.abs(nx - x) > maxX) break;
    if (ny - y > DROP_FALL_MAX_CELLS * TERRAIN_CELL) break;
    const c = Math.max(0, Math.min(dims.cols - 1, Math.floor(nx / TERRAIN_CELL)));
    const r = Math.max(0, Math.min(dims.rows - 1, Math.floor(ny / TERRAIN_CELL)));
    if (isSolidCell(grid.g(c * dims.rows + r))) return { x: px, y: (r - 0.5) * TERRAIN_CELL };
    px = nx; py = ny;
  }
  return { x: px, y: dropRestY(room, px, py) };
}
function spawnDrop(room, x, y, mats, prima, opts) {
  const map = roomDrops[room] || (roomDrops[room] = new Map());
  if (map.size >= MAX_DROPS_PER_ROOM) { const oldest = map.keys().next().value; if (oldest !== undefined) { map.delete(oldest); io.to(room).emit('drop-removed', { id: oldest }); } }
  let n = 0; for (const [, k] of mats) n += k;
  const vx = (opts && isFinite(+opts.vx)) ? Math.max(-0.6, Math.min(0.6, +opts.vx)) : 0;
  const land = vx ? dropThrowLanding(room, x, y, vx) : { x, y: dropRestY(room, x, y) };
  const d = { id: 'd' + (++dropSeq), x, y, gy: land.y, t0: Date.now(), mats, n };
  if (vx) { d.vx = vx; d.gx = land.x; }
  // 🟥 HOW LONG BEFORE ANYONE MAY TAKE IT. Without this, putting something down is instantly undone: the
  // collector runs every frame against anything within reach, and you are standing on top of what you just
  // dropped. The server holds the deadline because it owns the list; the client is TOLD the interval and stops
  // asking, so the two agree without either needing the other's clock.
  if (opts && opts.hold > 0) { d.hold = opts.hold | 0; d._np = Date.now() + (opts.hold | 0); }
  // ⭐ A PILE CAN CARRY PRIMA AS WELL AS MATERIAL. Nothing spawns one yet except a player releasing what they
  // were holding, but dispersal-on-death needs exactly this shape, and adding the field now means that
  // increment does not have to change the wire, the client decoder and the collect path all over again.
  if (prima > 0) d.prima = prima | 0;
  map.set(d.id, d);
  io.to(room).emit('drop-add', d);
  return d;
}
// ⭐⭐ EVERYTHING A PLAYER IS CARRYING, PUT BACK INTO THE WORLD. ONE primitive with three eventual callers:
// leaving with an ephemeral balance (below), DISPERSAL ON DEATH, and the dormancy rule for an absent player.
// They differ only in when they fire and how widely they scatter, so building it here makes the other two
// small — which is most of the reason it exists now rather than later.
// 🟥 IT MUST NOT DESTROY ANYTHING. `takeAll` empties the ledger and hands the contents back; if this function
// returns without spawning them, that is matter annihilated, in an economy whose entire premise is that matter
// is conserved. Hence the guard: nothing is taken until there is somewhere to put it.
function releaseHoldings(room, key, x, y) {
  if (!room || !isFinite(x) || !isFinite(y)) return null;
  const peek = ledger.snapshot(key);
  if (!peek.mats.length && !peek.prima) return null;
  const held = ledger.takeAll(key);
  // A hold on this one too: a released haul that the next passer-by hoovers up before it has visibly landed
  // reads as a bug rather than as an event.
  const d = spawnDrop(room, x, y, held.mats, held.prima, { hold: INV_DROP_HOLD_MS });
  console.log(`ledger: released ${held.mats.reduce((a, m) => a + m[1], 0)} cell(s) + ${held.prima} prima at ${x | 0},${y | 0} as ${d.id}`);
  return d;
}
// Where a socket's body was, in pixels, as of its last beacon. ⚠️ Falls back to nothing rather than to the
// world origin: dropping a haul at (0,0) because the position was unknown is worse than not dropping it, and
// the caller can then decide (today: keep it in the ledger rather than lose it).
function lastBodyPos(room, sid) {
  const m = roomWhere[room];
  const r = m && m.get(sid);
  if (!r || !(r.apx >= 0) || !(r.apy >= 0)) return null;
  return { x: r.apx, y: r.apy };
}
// Expire un-collected drops. One sweep over every room's list — the lists are capped, so this is bounded by
// (rooms × 300) and runs once a second, not per tick.
setInterval(() => {
  const cut = Date.now() - DROP_TTL_MS;
  for (const room in roomDrops) {
    const map = roomDrops[room]; const gone = [];
    for (const [id, d] of map) if (d.t0 < cut) { map.delete(id); gone.push(id); }
    if (gone.length) io.to(room).emit('drops-removed', { ids: gone });
    if (!map.size) delete roomDrops[room];
  }
}, 1000);

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUsername = null;
  let currentPresenceRoom = null; // this socket's who-list bucket: URL room by default, or 'pg:'+ctxRoomId when in a context Room
  let currentPageRoom = null;     // this socket's page-bound bucket (cursors/sprays/annotations/highlights): URL room, or 'pb:'+ctxRoomId+'|'+url in a context Room
  // Item 10: has this socket ENTERED its presence Room (joined the who-list / become visible)? For the
  // page-default Room a user browses un-entered (observes counts only) until a deliberate action; a
  // custom/locked context Room is always entered. Drives whether we add to roomUsers + announce.
  let currentEntered = false;
  let currentColor = null;        // this socket's chosen name colour — tracked separately so every roomUsers entry we (re)build (join, room-presence, ctx-room) carries it
  // ---- Liquid Debug config (GLOBAL, live-tunable sim switches driven by the client's Liquid Debug menu) ----
  socket.emit('liquid-cfg', cfgWire());                     // send current state so a joining client's menu reflects it
  socket.on('liquid-cfg-get', () => socket.emit('liquid-cfg', cfgWire()));
  // ⭐ THE PERF TAB'S "PROFILE THE SERVER" BUTTON. Same implementation as the URL (see `startCpuProfile`); the
  // point is that it can be pressed at the moment the problem is happening, by somebody who is playing rather
  // than holding a terminal. The reply carries the FILENAME, which is what makes the result findable
  // afterwards — `node scratchpad/read_cpuprofile.js <file>` ranks it.
  // ⚠️ No auth beyond being connected, exactly like every other control on that panel. It writes a file on the
  // machine the server is on and nothing else; the HTTP route keeps its localhost-only check because a URL can
  // be fetched by a page the user did not open.
  socket.on('cpu-profile', (p) => {
    const ms = Math.max(1000, Math.min(120000, (p && +p.ms) || 30000));
    socket.emit('cpu-profile-state', { running: true, ms });
    startCpuProfile(ms, (err, file) => socket.emit('cpu-profile-state', { running: false, error: err, file }));
  });
  // DEBUG single-step: advance the frozen sim by a few ticks. Only meaningful while paused; ignored otherwise, so a
  // stray press can never make the sim run fast.
  // DEBUG resync: re-send this socket the FULL liquid state for the room it is in. The client compares it against its
  // own mirror before applying, which settles "is that liquid really there, or has my copy drifted?" in one press --
  // a question that has cost a lot of guessing, because the client's droplet replay lands on the client's mirror, so
  // a stale cell there produces BOTH phantom liquid and droplets that stop early on it.
  socket.on('liquid-resync', () => {
    const room = currentAvatarRoom;
    if (!room || !peekCells(room).terrain) return;
    const fi = buildFineInit(room); if (fi) socket.emit('liquid-fine-init', { ...fi, verify: true });
  });
  // ---- LIQUID SOURCES: mark/unmark cells that keep refilling themselves. Sent by the build menu's "Source" option
  // when a liquid is painted; the same cells are sent with on:false when the option is OFF, so painting normally over
  // a source removes it. Rebroadcast so every client can draw the marker.
  socket.on('liquid-src', ({ cells, id, on, rate }) => {
    const room = currentAvatarRoom;
    if (!room || !Array.isArray(cells) || cells.length > 4096) return;
    if (!canBuild()) return;
    const grid = cellsOf(room).terrain; if (!grid) return;
    const rank = LIQ_RANK[id | 0];
    if (on && rank === undefined) return;                    // sources are built-in liquids only (custom liquids have no rank)
    const rt = rate === undefined ? undefined : Math.max(0, Math.min(64, rate | 0));
    const src = ensureSrcMap(room);
    const okCells = [];
    for (const raw of cells) {
      const i = raw | 0; if (i < 0 || i >= grid.length) continue;
      if (on) { if (isSolidCell(grid.g(i))) continue; src.set(i, { rank, rate: rt }); } else if (!src.delete(i)) continue;
      okCells.push(i);
    }
    if (!src.size) dropSrcMap(room);
    if (okCells.length) io.to(room).emit('liquid-src', { cells: okCells, on: !!on });
  });
  // Remove every source in the room at once. A source is invisible in the terrain data, so without this a stray one
  // left running in a corner of a big world is genuinely hard to find and turn off.
  socket.on('liquid-src-clear', () => {
    const room = currentAvatarRoom;
    if (!room || !canBuild()) return;
    const src = cellsOf(room).src;
    if (!src || !src.size) return;
    const cells = Array.from(src.keys());
    clearLiquidSources(room); dropSrcMap(room);
    io.to(room).emit('liquid-src', { cells, on: false });
  });
  socket.on('liquid-step', (n) => {
    if (!liquidCfg.paused) return;
    const k = Math.max(1, Math.min(120, (n | 0) || 1));
    liquidStepsPending += k;
    io.emit('liquid-stepped', k);   // clients replay the droplet fall locally, so they must step it too
  });
  // ⭐ MIRROR CHECK (diagnostic). The client only ever receives CHANGED fine cells, so ANY server-side write that does
  // not make it into a broadcast leaves the client's mirror wrong FOREVER — the cell is never mentioned again. That
  // shows up as liquid frozen in place, and (because the rise/sink bubble FX key off a density inversion between
  // MIRROR cells) as bubbles that never stop. This hands back the server's authoritative stack for a rectangle of
  // cells so the client can diff its mirror against it and say exactly which cells disagree.
  // Same flat encoding as the fine wire — [i, repId, flags, mask] + one amt per set rank — but for EVERY cell in the
  // rect, empty ones included (mask 0), because a PHANTOM (client has liquid where the server has none) is the case
  // we are hunting and it is invisible if empties are omitted.
  socket.on('liquid-mirror-check', (rect) => {
    const room = currentAvatarRoom;
    if (!room || !rect || typeof rect !== 'object') return;
    const st = cellsOf(room), amt = st.fineAmt, tot = st.fineTotal, grid = st.terrain;
    if (!amt || !tot || !grid) { socket.emit('liquid-mirror-state', { err: 'no fine state for this room' }); return; }
    const SUB = st.fineSub || 1 || 1, FCOLS = st.cols * SUB, FROWS = st.rows * SUB;
    const cl = (v, hi) => Math.max(0, Math.min(hi, v | 0));
    const c0 = cl(rect.c0, FCOLS - 1), c1 = cl(rect.c1, FCOLS - 1), r0 = cl(rect.r0, FROWS - 1), r1 = cl(rect.r1, FROWS - 1);
    if (c1 < c0 || r1 < r0) return;
    const W = c1 - c0 + 1, H = r1 - r0 + 1;
    if (W * H > 90000) { socket.emit('liquid-mirror-state', { err: 'rect too large (' + W + '×' + H + ') — zoom in' }); return; }
    const cells = [], T = LIQ_T;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = c * FROWS + r, p = amt.rp(i), b = amt.o(i);
      let mask = 0; for (let rk = 0; rk < T; rk++) if (p[b + rk] > 0) mask |= (1 << rk);
      cells.push(i, tot.g(i) > 0 ? liqRepId(amt, i) : grid.g(i), 0, mask);
      for (let rk = 0; rk < T; rk++) if (mask & (1 << rk)) cells.push(p[b + rk]);
    }
    const act = st.fineActive;
    // ⭐⭐ WHY ISN'T THIS PAIR SORTING? The mirror came back clean, so a standing inversion is really in the server's
    // state — and the sub-step loop runs 9 sort passes a tick, each guaranteed to move at least 1 unit once the swap
    // fires. So the swap is not firing, and the sim knows exactly which of its gates is stopping it. Rather than guess
    // at the geometry (10 hand-built + 1320 randomised scenes never produced one), report every gate's value for each
    // standing pair. Mirrors the conditions on step (2) in fineLiquidTickRoom verbatim — keep the two in step.
    const FROW_FLOOR = Math.floor(roomFloorTop(room) / TERRAIN_CELL) * SUB;   // per room — this mirrors the sim, so it has to move with it
    const isSolidF = (k) => { if (k < 0 || k >= FCOLS * FROWS) return true; const fc = (k / FROWS) | 0, fr = k - fc * FROWS;
      const v = grid.g(((fc / SUB) | 0) * st.rows + ((fr / SUB) | 0)); return v !== 0 && !isFluidId(v); };
    const floorRk = (j) => { const p = amt.rp(j), b = amt.o(j); for (let rk = 0; rk < T; rk++) if (p[b + rk] > 0) return rk; return -1; };
    const ceilRk = (j) => { const p = amt.rp(j), b = amt.o(j); for (let rk = T - 1; rk >= 0; rk--) if (p[b + rk] > 0) return rk; return -1; };
    const stk = (j) => { const p = amt.rp(j), b = amt.o(j), o = []; for (let rk = 0; rk < T; rk++) if (p[b + rk] > 0) o.push(rk + ':' + p[b + rk]); return '{' + o.join(' ') + '}'; };
    const lavaB = (A, B) => { if (!liquidCfg.reactions) return false; const lvA = amt.rp(A)[amt.o(A)], lvB = amt.rp(B)[amt.o(B)], la = lvA > 0, lb = lvB > 0;
      if (!la && !lb) return false; return (la && tot.g(B) - lvB > 0) || (lb && tot.g(A) - lvA > 0); };
    const stuck = []; let invTotal = 0;
    for (let r = r0; r < r1; r++) for (let c = c0; c <= c1; c++) {
      const a = c * FROWS + r, b = a + 1;
      if (tot.g(a) <= 0 || tot.g(b) <= 0) continue;
      const f = floorRk(a); if (f < 0 || f >= ceilRk(b)) continue;
      invTotal++;
      if (stuck.length >= 8) continue;
      stuck.push({
        c, r, up: stk(a), dn: stk(b),
        hi: f, lo: ceilRk(b),
        upActive: !!(act && act.has(a)), dnActive: !!(act && act.has(b)),
        upSolid: isSolidF(a), dnSolid: isSolidF(b),          // a solid grid id over a cell that still holds liquid = the sim skips it AND wake() refuses to re-add it → permanent
        gUp: grid.g(a), gDn: grid.g(b),
        canDown: r + 1 < FROW_FLOOR,                          // step (2) requires it; false near the bedrock row
        lavaBlk: lavaB(a, b),
        k: Math.min(amt.rp(a)[amt.o(a) + f], amt.rp(b)[amt.o(b) + ceilRk(b)], liquidCfg.sortRate),
      });
    }
    socket.emit('liquid-mirror-state', { sub: SUB, cols: FCOLS, c0, r0, c1, r1, cells, cap: LIQUID_MAX,
      active: act ? act.size : 0, tick: liquidTickCount, invTotal, stuck,
      cfg: { densitySort: liquidCfg.densitySort, sortRate: liquidCfg.sortRate, K: liquidCfg.fineLevelSteps,
             sortSteps: liquidCfg.fineSortSteps, reactions: liquidCfg.reactions, minUnit: liquidCfg.fineMinUnit } });
  });
  socket.on('liquid-cfg', (patch) => {
    // 🟥 THIS IS AN ALLOWLIST AND A KEY IT DOES NOT NAME IS SILENTLY DROPPED — so a NEW DIAL NEEDS THREE EDITS,
    // NOT TWO: the default in `liquidCfg`, the control in the panel, and a line here. Miss this one and the
    // symptom is a checkbox that "turns itself off again the instant you click it": the click emits, nothing
    // accepts it, and the panel's next sync from `cfgWire()` reads the unchanged value and puts the box back.
    // It reads as a UI bug and is entirely server-side. Cost a round trip on 2026-08-23.
    // ⚠️ `cfgWire()` reporting every value back is exactly what makes the omission self-correcting, and so
    // invisible. To check the whole set at once, cross-reference the keys the panel emits against this list.
    if (!patch || typeof patch !== 'object') return;
    for (const k of ['densitySort', 'sortBeforeLevel', 'lateralLevel', 'perLiquidLevel', 'viscosity', 'reactions', 'symLevel', 'levelMix', 'perfLog', 'fluxLevel', 'paused', 'fineQuiesce', 'storedWakeAll', 'fineAdaptiveK', 'fineConstFall', 'fineSortDiagGate', 'finePerLiquidSortGate', 'fineSortOnePerPass', 'wakeDensityFace', 'sortColRun', 'storedWakeAudit', 'scanVerify', 'scanFast', 'sinks']) if (k in patch) liquidCfg[k] = !!patch[k];
    if ('levelGate' in patch) liquidCfg.levelGate = Math.max(0, Math.min(2, patch.levelGate | 0));
    if ('sortRate' in patch) liquidCfg.sortRate = Math.max(1, Math.min(32, patch.sortRate | 0));
    if ('fineLevelSteps' in patch) liquidCfg.fineLevelSteps = Math.max(1, Math.min(16, patch.fineLevelSteps | 0));
    if ('fineQuiesceTicks' in patch) liquidCfg.fineQuiesceTicks = Math.max(2, Math.min(60, patch.fineQuiesceTicks | 0));
    if ('fineAdaptPct' in patch) liquidCfg.fineAdaptPct = Math.max(1, Math.min(50, patch.fineAdaptPct | 0));
    if ('fineFallSteps' in patch) liquidCfg.fineFallSteps = Math.max(1, Math.min(16, patch.fineFallSteps | 0));
    if ('fineMinUnit' in patch) liquidCfg.fineMinUnit = Math.max(1, Math.min(64, patch.fineMinUnit | 0));
    if ('fineSortSteps' in patch) liquidCfg.fineSortSteps = Math.max(0, Math.min(16, patch.fineSortSteps | 0));
    if ('fineSortDiagSteps' in patch) liquidCfg.fineSortDiagSteps = Math.max(0, Math.min(16, patch.fineSortDiagSteps | 0));
    if ('finePerLiquidSteps' in patch) liquidCfg.finePerLiquidSteps = Math.max(0, Math.min(16, patch.finePerLiquidSteps | 0));
    if ('finePerLiquidScan' in patch) liquidCfg.finePerLiquidScan = Math.max(0, Math.min(32, patch.finePerLiquidScan | 0));
    if ('fineFlatSteps' in patch) liquidCfg.fineFlatSteps = Math.max(0, Math.min(16, patch.fineFlatSteps | 0));
    if ('fineFlatScan' in patch) liquidCfg.fineFlatScan = Math.max(0, Math.min(32, patch.fineFlatScan | 0));
    if ('flatSkip' in patch) liquidCfg.flatSkip = patch.flatSkip ? 1 : 0;
    if ('fallFirst' in patch) liquidCfg.fallFirst = patch.fallFirst ? 1 : 0;
    if ('plSkip' in patch) liquidCfg.plSkip = patch.plSkip ? 1 : 0;
    // CELL CAPACITY (vertical slices). Rescale existing liquid, then re-broadcast so client mirrors match the new scale.
    if ('cellCap' in patch) { const nv = Math.max(1, Math.min(255, patch.cellCap | 0)); if (nv !== LIQUID_MAX) { rescaleAllLiquid(nv); LIQUID_MAX = nv; liquidCfg.cellCap = nv;
      for (const room of cellRooms.fineArr) { const fi = buildFineInit(room); if (fi) io.to(room).emit('liquid-fine-init', fi); }
    } }
    // (The fine/coarse gate toggle lived here. There is no coarse sim to switch to any more, so `fine` and `sub` are
    //  no longer accepted as patches — the fine grid at ratio 1 is the only liquid there is.)
    if ('fluxRate' in patch) liquidCfg.fluxRate = Math.max(1, Math.min(128, patch.fluxRate | 0));
    if ('srcRate' in patch) liquidCfg.srcRate = Math.max(0, Math.min(64, patch.srcRate | 0));
    if ('sinkRate' in patch) liquidCfg.sinkRate = Math.max(0, Math.min(64, patch.sinkRate | 0));
    if ('tickMs' in patch) { const v = Math.max(8, Math.min(500, patch.tickMs | 0)); if (v !== liquidCfg.tickMs) { liquidCfg.tickMs = v; restartLiquidLoop(); } }
    if ('simBudgetPct' in patch) liquidCfg.simBudgetPct = Math.max(0, Math.min(100, patch.simBudgetPct | 0));
    // The two §7(b) budget fixes ride the same wire as the budget itself, for the same reason chunkEvict does:
    // they have to be A/B-able live, because "is the liquid slow because of tier 3 or because it is 8px?" is
    // otherwise unanswerable from inside the game.
    if ('budgetSeed' in patch) liquidCfg.budgetSeed = patch.budgetSeed ? 1 : 0;
    if ('budgetRate' in patch) liquidCfg.budgetRate = patch.budgetRate ? 1 : 0;
    if ('cellCostUs' in patch) liquidCfg.cellCostUs = Math.max(1, Math.min(500, +patch.cellCostUs || 23));
    if ('budgetRateMax' in patch) liquidCfg.budgetRateMax = Math.max(2, Math.min(64, patch.budgetRateMax | 0));
    // 0 = the old unbounded wake; anything else is cells per tick per room. See `storedWakeRate`.
    if ('storedWakeRate' in patch) liquidCfg.storedWakeRate = Math.max(0, Math.min(20000, patch.storedWakeRate | 0));
    if ('budgetCheapFirst' in patch) liquidCfg.budgetCheapFirst = patch.budgetCheapFirst ? 1 : 0;
    // ⭐ SECTORS. A/B-able live for the same reason the budget's tiers are: "is my water slow because someone
    // else flooded a cave, or because it is just a lot of water?" is otherwise unanswerable from inside the game.
    // 0 = off, and off is byte-for-byte the old scheduler.
    if ('secW' in patch) liquidCfg.secW = Math.max(0, Math.min(65536, patch.secW | 0));
    // The two reaction-pass limits ride the same wire and for the same reason: "is the liquid frozen because of
    // the flow or because reactions ate the tick ahead of it" is otherwise unanswerable from inside the game,
    // and that is precisely the question that cost this track a session.
    if ('reactAnchorFilter' in patch) liquidCfg.reactAnchorFilter = patch.reactAnchorFilter ? 1 : 0;
    if ('reactMovedOnly' in patch) liquidCfg.reactMovedOnly = patch.reactMovedOnly ? 1 : 0;
    if ('reactMaxCand' in patch) liquidCfg.reactMaxCand = Math.max(0, Math.min(2000000, patch.reactMaxCand | 0));
    if ('genWakeAll' in patch) liquidCfg.genWakeAll = patch.genWakeAll ? 1 : 0;
    if ('heat' in patch) liquidCfg.heat = patch.heat ? 1 : 0;
    if ('strips' in patch) { liquidCfg.strips = patch.strips ? 1 : 0; if (!liquidCfg.strips) secStatus.clear(); }
    if ('secJoin' in patch) liquidCfg.secJoin = patch.secJoin ? 1 : 0;
    if ('avSlow' in patch) liquidCfg.avSlow = Math.max(1, Math.min(16, patch.avSlow | 0));   // universal avatar slow-motion (debug)
    // CHUNK RESIDENCY (Phase 3) rides the same patch wire so eviction can be A/B'd live from the console without a
    // restart — which is the whole point while it is being eyeballed. Turning it OFF materialises every room, so a
    // world that looked wrong under eviction can be compared against the same world with everything resident.
    if ('chunkEvict' in patch) {
      chunkCfg.evict = !!patch.chunkEvict;
      if (!chunkCfg.evict) for (const room of Array.from(roomCells.keys())) materializeRoom(room);
    }
    if ('chunkMargin' in patch) chunkCfg.margin = Math.max(0, Math.min(64, patch.chunkMargin | 0));
    if ('chunkGraceMs' in patch) chunkCfg.graceMs = Math.max(0, Math.min(600000, patch.chunkGraceMs | 0));
    if ('worldTrace' in patch) { worldCfg.trace = patch.worldTrace ? 1 : 0; console.log('[trace] edit tracing ' + (worldCfg.trace ? 'ON' : 'off')); }
    if ('chunkQuiesce' in patch) chunkCfg.quiesce = !!patch.chunkQuiesce;
    if ('chunkQuiesceMs' in patch) chunkCfg.quiesceMs = Math.max(0, Math.min(600000, patch.chunkQuiesceMs | 0));
    // INTEREST-LIMITED REPLICATION (Phase 4) — same reasoning as chunkEvict: it has to be A/B-able live, because
    // "is that a bug or is that just a chunk I am not subscribed to?" is otherwise unanswerable from inside the game.
    // ⚠️ TURNING IT OFF MUST REPAIR, not merely resume broadcasting. Every client with a subscription set has chunks
    // it stopped hearing about, so going back to broadcast would leave those stale FOREVER — the diffs that would
    // have fixed them have already been and gone.
    // ⚠️ REWORKED with increment 3d, which deleted the `mark` map this used to flush. Dropping `roomSubs[room]`
    // is now the repair: with re-entry always re-sending, an empty subscription set means the next beacon files
    // every chunk the socket can see as pending and pushes it. A windowed client only HAS what it can see, so
    // that is complete for it; a flat client repairs the rest as it visits, which is the same guarantee walking
    // into new territory already gives. Anything already queued still goes out first.
    if ('interestChunks' in patch) {
      const on = !!patch.interestChunks;
      if (!on && interestCfg.chunks) for (const room of Object.keys(roomSubs)) {
        for (const [sid, e] of roomSubs[room]) {
          const sock = io.sockets.sockets.get(sid);
          if (sock && e.pending.size) sendChunkContent(sock, room, [...e.pending]);
        }
        delete roomSubs[room];
      }
      interestCfg.chunks = on;
    }
    if ('interestMargin' in patch) interestCfg.margin = Math.max(0, Math.min(64, patch.interestMargin | 0));
    // ── the chunk work queue, A/B-able live for the same reason the budget's tiers are: "is terrain late because
    // the queue is too small, or because generation is too slow?" is unanswerable from inside the game otherwise.
    // ⚠️ Turning the queue OFF restores the old synchronous behaviour exactly — including its stalls. That is the
    // point of keeping the switch, not an oversight.
    if ('chunkQueue' in patch) interestCfg.queue = patch.chunkQueue ? 1 : 0;
    if ('chunkQueueMs' in patch) interestCfg.queueMs = Math.max(0, Math.min(40, +patch.chunkQueueMs || 0));
    if ('chunkQueueBatch' in patch) interestCfg.queueBatch = Math.max(1, Math.min(64, patch.chunkQueueBatch | 0));
    // VISIBILITY CAP (Phase 4). ⚠️ TURNING IT OFF MUST RE-OFFER, not merely stop selecting: every socket has peers
    //  it was told to mute, and those DataChannels are CLOSED. Going back to "everyone" without saying so would
    //  leave the mesh permanently short of exactly the connections the cap tore down.
    if ('peerCap' in patch) {
      const nv = Math.max(0, Math.min(512, patch.peerCap | 0));
      if (!nv && peerCfg.cap) for (const room of Object.keys(roomPeers)) {
        for (const [sid, had] of roomPeers[room]) {
          const sock = io.sockets.sockets.get(sid); if (!sock) continue;
          const add = [...(roomAvt[room] || [])].filter(p => p !== sid && !had.has(p));
          if (add.length) sock.emit('avt-peers', { add, mute: [] });
        }
        delete roomPeers[room];
      }
      peerCfg.cap = nv;
      if (nv) for (const room of Object.keys(roomAvt)) for (const sid of roomAvt[room]) updatePeers(room, sid);
    }
    if ('peerFriendRings' in patch) peerCfg.friendRings = Math.max(0, Math.min(999, +patch.peerFriendRings || 0));
    // SERVER-RELAYED AVATARS (Phase 5a) — same reasoning again: it has to be A/B-able live against the mesh,
    // because "is the relay worse?" is only answerable by flipping it while looking at the same world.
    // ⚠️ TOGGLING IT IS A TRANSPORT SWITCH, AND CLIENTS ARE MID-FLIGHT. A client meshes or relays according
    // to what `avt-joined` told it, so flipping this at runtime does NOT re-transport anyone already in a
    // room — they keep the transport they joined with until they re-join. That is deliberate: the
    // alternative is tearing down live WebRTC connections and re-handshaking everyone at once, which is a
    // far worse failure mode than "the change applies to the next join". Clients are asked to re-join.
    if ('relayOn' in patch) {
      const on = !!patch.relayOn;
      if (on !== !!relayCfg.on) {
        relayCfg.on = on ? 1 : 0;
        restartRelayLoop();
        // Turning it OFF drops the held state rather than leaving it to rot: every entry is a position
        // that will never be updated again, and a stale one is worse than none.
        if (!on) { for (const k of Object.keys(roomPos)) delete roomPos[k]; for (const k of Object.keys(roomProfile)) delete roomProfile[k]; for (const k of Object.keys(roomAck)) delete roomAck[k]; }
        io.emit('avt-retransport', { relay: relayCfg.on });   // client re-joins its avatar room on the new transport
      }
    }
    if ('relayHz' in patch) { relayCfg.hz = Math.max(2, Math.min(50, patch.relayHz | 0)); restartRelayLoop(); }
    if ('relayCap' in patch) relayCfg.cap = Math.max(0, Math.min(512, patch.relayCap | 0));
    if ('relayFarHz' in patch) relayCfg.farHz = Math.max(0, Math.min(50, patch.relayFarHz | 0));
    if ('relayFarCap' in patch) relayCfg.farCap = Math.max(0, Math.min(512, patch.relayFarCap | 0));
    // Batching is behaviour-preserving (same events, same order, one envelope), so unlike the two above it needs
    // no repair when toggled — the next tick simply arrives unwrapped.
    if ('interestBatch' in patch) interestCfg.batch = !!patch.interestBatch;
    // ── THE SHARED DAY LENGTH. Global on purpose: this is the one setting where a per-browser value would be
    // meaningless, since the entire point is that everybody is standing in the same afternoon. Broadcast so a
    // client that is already in the world picks up the new length without re-joining.
    if ('dayCycleMin' in patch) {
      worldClock.cycleMs = Math.max(1, Math.min(1440, patch.dayCycleMin | 0)) * 60000;
      io.emit('world-clock', worldClockWire());
    }
    // Shift the whole cycle, for landing on a particular time of day while tuning rather than waiting for it.
    if ('dayOffsetMin' in patch) { worldClock.offsetMs = (patch.dayOffsetMin | 0) * 60000; io.emit('world-clock', worldClockWire()); }
    // ── PHASE 6 INCREMENT 4: which world generator (see worldgen.js) ──────────────────────────────────────────
    // ⚠️ The switch ALONE changes nothing you can see: a world is generated once per room per server lifetime,
    // so flipping this only affects rooms generated from here on. That is on purpose — silently rebuilding
    // every live world would throw away whatever anyone had built in it.
    // (`worldChunked` / `worldOnDemand` were settable here. See the note below.)
    // ⭐ Turning the Overworld on turns the other two on with it, for the same reason `worldOnDemand` turns
    // `worldChunked` on: they are not independent choices, and a half-set combination is not a configuration
    // anybody wants. `ensureWorldGenerated` does not RELY on this (it reads `overworldRooms`), so the flags
    // agreeing is for the panel's benefit rather than the server's.
    // ⭐ ONE SWITCH, AND IT TAKES EFFECT BY ITSELF. Reported from play: *"I have to click it on in the debug,
    // along with all the other world checks, and then I have to manually close layer 2 and reopen it"* — and
    // the natural thing to click instead, Rebuild, stalled the server. Which room you are in is decided at
    // `avt-join`, so a flag flipped mid-session changes nothing until you re-join; every client is now ASKED to
    // re-join, on the same `avt-retransport` seam the relay switch already uses for the same reason.
    // ⭐ PORT INCREMENT 6 — the redesigned world. Turns chunked + onDemand on with it, for the same reason
    // `worldOnDemand` turns `worldChunked` on: worldgen2 has no eager whole-world path, so they are not
    // independent choices and a half-set combination is not a configuration anybody wants.
    // ⚠️ Takes effect for rooms generated FROM HERE ON. Press "Rebuild this world" to see it where you are.
    // 🟥 `worldGen2`, `worldOverworld`, `worldChunked` and `worldOnDemand` ARE NO LONGER SETTABLE AT RUNTIME,
    // and that is a deliberate removal rather than an oversight (user, 2026-08-10: *"since this is the default
    // now, the debug menu options shouldn't even be necessary and only really serve to confuse and potentially
    // cause problems anyway"*). They were global switches deciding, for every player at once, which generator
    // ran and which world you entered — and one of them was found sitting at the wrong value on a live server,
    // with the client's own reset map disagreeing with the server's defaults, so a reset turned the shared
    // world off for everybody. A control whose only correct setting is its default is not a control.
    // ⚠️ ROLLBACK IS NOT LOST, it is just no longer one click away: the four constants still live in
    // `worldCfg` above, and switching any of them is an edit plus a restart. That is a deliberate act.
    if ('worldDropPristine' in patch) worldCfg.dropPristine = patch.worldDropPristine ? 1 : 0;
    // ⚠️ SETTABLE, unlike the four above, and the distinction is the one that note draws: those decide WHICH
    // WORLD you are in, this decides only whether an extra payload rides along with a chunk. Flipping it
    // changes nothing already sent and nothing stored — the next chunk a socket subscribes to simply carries
    // the uncarved ground or does not — which makes it an honest A/B rather than a global mode.
    if ('worldBacking' in patch) worldCfg.backing = patch.worldBacking ? 1 : 0;
    // ⭐ WIPE EVERY STORED CHANGE — the panel's version of `restart-server.ps1 -FreshWorld`. The user asked for
    // it here; it keeps the flag's safety property by taking two clicks in the UI.
    // ⚠️ It clears the DISK and the in-memory index of what is on disk. Rooms already loaded keep whatever they
    // are holding until they are rebuilt or the server restarts — said plainly in the panel rather than implied,
    // because "I wiped it and my hole is still there" is otherwise a bug report.
    if (patch.worldWipeSaved) {
      const before = wipeSavedWorlds();
      socket.emit('liquid-cfg-note', { text: `Wiped ${before.n} stored chunk(s), ${(before.b / 1024).toFixed(1)}KB. `
        + `Worlds already loaded keep what they have until a rebuild or a restart.` });
      console.log(`world persistence: WIPED ${before.n} stored chunk(s), ${(before.b / 1024).toFixed(1)}KB (debug panel)`);
    }
    // ── and the button that makes the switch testable: rebuild THIS room's world with the current generator.
    // ⭐ Why a rebuild in place rather than "go and visit a different page": the seed is keyed on the URL, so a
    // different page is a different world, and comparing two different worlds tells you nothing. Rebuilt in
    // place, both generators draw the heightmap and biome constants as the first 11 draws off the same seed, so
    // you get the SAME LANDSCAPE with different caves, veins, pools and mounds — which is the comparison worth
    // looking at. (probe_worldgen D8/D9 assert exactly that pairing.)
    // 🟥 IT DESTROYS WHATEVER IS IN THE ROOM. Refused outright for a PUBLISHED world, where the live state is
    // snapshotted back to the database and a regenerate would be silent data loss, not a debug action.
    if (patch.worldRegen && currentAvatarRoom) {
      const _r = currentAvatarRoom;
      // 🟥 REFUSED FOR THE OVERWORLD, AND THIS IS WHAT STALLED THE SERVER IN PLAY. Everything below is
      // whole-world: `materializeRoom` restores every evicted chunk, `terrainRLE` walks the entire index space
      // (524,224 x 4,096 = 2.15 BILLION cells) and `buildFineInit` scans it again for liquid. That is fine for a
      // page room and fatal here — the server stops answering, with an empty error log, which is what "it
      // crashed" looked like from the outside. Worse, the World tab's own help text tells you to press Rebuild
      // after ticking the other switches, so it was the natural next click.
      // ⚠️ There is also nothing to rebuild INTO. A regenerate exists to A/B two generators on one seed; the
      // Overworld has one generator and one seed, and is produced on demand, so "rebuild it" has no meaning.
      if (overworldRooms.has(_r)) socket.emit('liquid-cfg-note', { text: 'Rebuild refused: the Overworld is produced on demand — there is nothing to rebuild, and doing it would read all 2.15 billion cells.' });
      else if (hydratedAvRooms.has(_r)) socket.emit('liquid-cfg-note', { text: 'Regenerate refused: this is a published world.' });
      else {
        worldGenerated.delete(_r); _roomGens.delete(_r);
        setRoomGenerator(_r, null);                         // detach the on-demand seeders before the fields are refilled
        materializeRoom(_r);                                // start from a fully resident world, not a half-evicted one
        ensureWorldGenerated(_r, currentAvRoomId, currentAvLevelIndex | 0);
        // Replay the new world to everyone standing in it — same events the join path sends.
        const _cs = cellsOf(_r), _tg = _cs.terrain;
        if (_tg) {
          io.to(_r).emit('terrain-init', { levelIndex: currentAvLevelIndex | 0, cell: TERRAIN_CELL, cols: _tg.geom.cols, rows: _tg.geom.rows,
            ...terrainRLE(_tg), hpRuns: _cs.terrainHp ? terrainRLE(_cs.terrainHp).runs : undefined });
          const _fi = buildFineInit(_r); if (_fi) io.to(_r).emit('liquid-fine-init', _fi);
          io.to(_r).emit('avatar-objects-init', { levelIndex: currentAvLevelIndex | 0, objects: roomObjects[_r] ? [...roomObjects[_r].values()] : [] });
        }
      }
    }
    io.emit('liquid-cfg', cfgWire());                       // broadcast (config is global) so every open menu stays in sync
  });
  let currentAvatarRoom = null;   // this socket's active avatar-world room key (URL + mode); set on avt-join
  let currentAvBuildRoomId = null; // Phase 3: real roomId for L2 build-perm checks (null = page/URL room → open build)
  let currentAvOwnerId = null;     // owner_id of that room (null for the page/URL room)
  let currentAvLevelIndex = 0;     // this socket's current Level index within the room's World (for per-Level locks)
  let currentAvRoomId = null;      // Phase 6 inc 4: the roomId the avatar room was keyed on (= the URL for a page room).
                                   // `currentAvBuildRoomId` is NOT this — it is null for a page room by design — and the
                                   // world SEED is keyed on the roomId, so a regenerate needs the real one.
  let currentAvBand = null;        // Phase 6: this socket's playable band rect (world px) — server-clamps object placement; null = full world
  // May this socket mutate the current avatar World? Page/URL room → always. Owner → always. A locked
  // Level blocks everyone but the owner. Else the room's per-user override, falling back to the role
  // default. Read live so grant/lock changes apply at once.
  function canBuild() {
    if (!currentAvBuildRoomId) return true;
    const did = socketToDiscordId[socket.id];
    if (did && currentAvOwnerId && did === currentAvOwnerId) return true;
    const rb = getRoomBuild(currentAvBuildRoomId);
    if (rb.locked.has(currentAvLevelIndex)) return false;          // this Level is build-locked for non-owners
    if (did && rb.over.has(did)) return rb.over.get(did);
    return rb.mode === 'all';
  }

  socket.on('join', ({ url, fullUrl, username, token, visible, tabSession, ctxRoomId, color, entered }) => {
    let verified = false;
    let avatar = null;
    let discordId = null;

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        avatar = decoded.avatar || null;
        verified = true;
        discordId = decoded.sub;
        if (!username || !username.trim()) username = decoded.username;
        // Upsert user in DB
        db.prepare('INSERT OR REPLACE INTO users (discord_id, username, avatar, updated_at) VALUES (?, ?, ?, unixepoch())').run(discordId, username, avatar);
        socketToDiscordId[socket.id] = discordId;
        discordIdToSocket[discordId] = socket.id;
        if (!discordIdToFollowSockets[discordId]) discordIdToFollowSockets[discordId] = new Set();
        discordIdToFollowSockets[discordId].add(socket.id);
        // Register this tab in the leader's tab set (drives follow snapshots).
        if (tabSession) {
          // Cancel any pending "tab gone" debounce for this session (same-tab navigation rejoining).
          const debounceKey = `${discordId}:${tabSession}`;
          clearTimeout(tabDisconnectTimers[debounceKey]);
          delete tabDisconnectTimers[debounceKey];
          socketToTabSession[socket.id] = tabSession;
          if (!leaderTabs[discordId]) {
            leaderTabs[discordId] = new Map();
            leaderEpoch[discordId] = Date.now(); // fresh browsing session → new epoch
          }
          leaderTabs[discordId].set(tabSession, fullUrl || url);
          if (visible) leaderActiveTab[discordId] = tabSession;
        }
      } catch {
        // invalid/expired token — fall through as anonymous
      }
    }

    currentRoom = url;
    currentUsername = username;
    socketToUsername[socket.id] = username;
    currentAvatarRoom = avatarRoomKey(url, 0);   // default Level 0 (sandbox) until avt-join picks a Level
    socket.join(currentRoom);
    socket.join('user:' + username);
    userCurrentFullUrl[username] = fullUrl || url;
    // 2c: presence bucket follows the context Room (membership-gated). Page-default Room → URL room (== today).
    currentPresenceRoom = resolvePresenceRoom(ctxRoomId, currentRoom, socket.id);
    if (currentPresenceRoom !== currentRoom) socket.join(currentPresenceRoom);
    if (!roomUsers[currentPresenceRoom]) roomUsers[currentPresenceRoom] = {};
    // 2d: page-bound bucket follows (context Room, url). Page-default Room → URL room (== today).
    currentPageRoom = resolvePageRoom(ctxRoomId, currentRoom, socket.id);
    if (currentPageRoom !== currentRoom) socket.join(currentPageRoom);
    // Reconnect dedup: a socket.io reconnect arrives as a NEW socket.id while the previous socket
    // can linger in presence until its server-side ping-timeout (~20s) fires `disconnect`. During
    // that window the SAME physical tab shows twice in the who-list and leaves a ghost avatar/cursor.
    // Evict any prior socket in THIS room carrying the same tabSession (same tab) so the rejoin
    // cleanly replaces it instead of waiting for the timeout. (Distinct real tabs have distinct
    // tabSessions, so this never collapses two genuine tabs.)
    if (!pageUsers[currentRoom]) pageUsers[currentRoom] = {};
    if (tabSession) {
      for (const oldSid of Object.keys(roomUsers[currentPresenceRoom])) {
        if (oldSid === socket.id || socketToTabSession[oldSid] !== tabSession) continue;
        delete roomUsers[currentPresenceRoom][oldSid];
        delete (pageUsers[currentRoom] || {})[oldSid];
        if (roomAvatars[currentRoom]) delete roomAvatars[currentRoom][oldSid];
        removeSimAvatar(currentRoom, oldSid);
        const oldAv = socketToAvatarRoom[oldSid];   // the evicted socket's avatar-world room (mode-scoped, may differ from this one)
        if (oldAv && roomAvt[oldAv] && roomAvt[oldAv].delete(oldSid)) { socket.to(oldAv).emit('avt-peer-left', { id: oldSid }); delete socketToAvatarRoom[oldSid]; }
        if (oldAv) dropRelay(oldAv, oldSid);   // Phase 5a: and stop relaying a socket that is gone
        io.to(currentPageRoom).emit('cursor-leave', { id: oldSid });
        io.to(currentRoom).emit('avatar-leave', { id: oldSid });
        const oldSock = io.sockets.sockets.get(oldSid);
        if (oldSock) oldSock.disconnect(true);   // force full cleanup of any zombie socket
      }
    }
    // Item 10: a custom/locked context Room (presence bucket diverges from the URL room) is always
    // entered; the page-default Room is entered only when the client says so (a deliberate Chat/Avatar/
    // Voice action). Un-entered = the socket observes the Room's count (it stays subscribed) but is NOT
    // in roomUsers and announces nothing — general browsing isn't broadcast.
    currentEntered = (currentPresenceRoom !== currentRoom) || !!entered;
    currentColor = color || null;
    if (currentEntered) roomUsers[currentPresenceRoom][socket.id] = { username, verified, avatar, discord_id: discordId, color: currentColor };
    pageUsers[currentRoom][socket.id] = { username, discord_id: discordId };
    if (roomHistory[currentRoom]) socket.emit('history', roomHistory[currentRoom]);
    if (roomMsgReactions[currentRoom]) socket.emit('reactions-init', roomMsgReactions[currentRoom]);
    if (roomAnnotations[currentPageRoom]) socket.emit('annotations-init', roomAnnotations[currentPageRoom]);
    if (roomSprays[currentPageRoom]) socket.emit('sprays-init', roomSprays[currentPageRoom]);
    if (roomMedia[currentRoom]) socket.emit('media-init', roomMedia[currentRoom]);
    if (roomAvatars[currentRoom]) socket.emit('avatars-init', Object.values(roomAvatars[currentRoom]));
    if (roomVoice[currentRoom] && Object.keys(roomVoice[currentRoom]).length) socket.emit('voice-init', roomVoice[currentRoom]);
    broadcastPresence(currentPresenceRoom);
    broadcastPagePresence(currentRoom);
    // Phase 4: seed the active Room's feature policy (null payload for the page-default Room = all open).
    { const fr = resolveAvRoomId(ctxRoomId, currentRoom, socket.id);
      socket.emit('feature-perms', featurePermsPayload(fr !== currentRoom ? fr : null)); }
    // #4: no "joined" chat line — peers see it via the presence diff (transient toast) + the live who-list.
    socket.to('user:' + username).emit('user-location', { url: userCurrentFullUrl[username] });

    // Friends: notify online friends + send friends list to joiner
    if (discordId) {
      try {
        const acceptedFriends = db.prepare(
          `SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END as fid
           FROM friends WHERE (from_id=? OR to_id=?) AND status='accepted'`
        ).all(discordId, discordId, discordId);
        const ownBeaconRow = db.prepare('SELECT beacon_url FROM users WHERE discord_id=?').get(discordId);
        acceptedFriends.forEach(r => {
          const fs = discordIdToSocket[r.fid];
          if (fs) io.to(fs).emit('friend-online', { discord_id: discordId, username, avatar, url: fullUrl || url, beacon_url: ownBeaconRow?.beacon_url || null });
        });
        const friendsData = db.prepare(`
          SELECT u.discord_id, u.username, u.avatar, f.status,
                 CASE WHEN f.from_id=? THEN 0 ELSE 1 END as incoming,
                 u.beacon_url
          FROM friends f
          JOIN users u ON u.discord_id = CASE WHEN f.from_id=? THEN f.to_id ELSE f.from_id END
          WHERE f.from_id=? OR f.to_id=?
        `).all(discordId, discordId, discordId, discordId)
          .map(r => ({ ...r, incoming: !!r.incoming, online: !!discordIdToSocket[r.discord_id], url: discordIdToFullUrl[r.discord_id] || null, beacon_url: r.beacon_url || null }));
        socket.emit('friends-init', friendsData);
      } catch (e) { console.error('[friends-init]', e); }

      // Private rooms
      try {
        const userRooms = db.prepare(`
          SELECT r.id, r.name, r.owner_id, r.public, r.scope, r.description, r.kind, r.env_spec,
                 (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) as member_count
          FROM rooms r
          JOIN room_members rm ON rm.room_id = r.id AND rm.discord_id = ?
          ORDER BY r.created_at ASC
        `).all(discordId);
        const getMemberIds = db.prepare('SELECT discord_id FROM room_members WHERE room_id = ?');
        socket.emit('private-rooms-init', userRooms.map(r => ({
          ...r,
          env_spec: parseEnvSpec(r.env_spec),
          memberIds: getMemberIds.all(r.id).map(m => m.discord_id)
        })));
      } catch (e) { console.error('[private-rooms-init]', e); }

      // Groups
      try {
        const userGroups = db.prepare(`
          SELECT g.id, g.name, g.description, g.owner_id, g.open, gm.role,
                 (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) as member_count
          FROM groups g
          JOIN group_members gm ON gm.group_id = g.id AND gm.discord_id = ?
          ORDER BY g.created_at ASC
        `).all(discordId);
        const getGroupMemberIds = db.prepare('SELECT discord_id FROM group_members WHERE group_id = ?');
        socket.emit('groups-init', userGroups.map(g => ({
          ...g,
          memberIds: getGroupMemberIds.all(g.id).map(m => m.discord_id)
        })));
      } catch (e) { console.error('[groups-init]', e); }

      // Follows: send this user their follow list + their followers list
      try {
        const userFollows = db.prepare(`
          SELECT f.followee_id, u.username, u.avatar
          FROM follows f JOIN users u ON u.discord_id = f.followee_id
          WHERE f.follower_id = ?
        `).all(discordId);
        socket.emit('follows-init', userFollows.map(r => ({ discordId: r.followee_id, username: r.username, avatar: r.avatar })));
        // Resync: send each followee's current tab snapshot to this newly-connected follower.
        userFollows.forEach(r => emitSnapshotToFollower(r.followee_id, r.username, socket.id));

        const myFollowersList = db.prepare(`
          SELECT f.follower_id, u.username
          FROM follows f JOIN users u ON u.discord_id = f.follower_id
          WHERE f.followee_id = ?
        `).all(discordId);
        socket.emit('followers-init', myFollowersList.map(r => ({ discordId: r.follower_id, username: r.username })));
      } catch (e) { console.error('[follows-init]', e); }

      // Follows: this user's tab set changed (new tab loaded / address-bar nav / foreground tab).
      // Push a fresh snapshot to their followers.
      try { emitTabSnapshot(discordId, username); } catch (e) { console.error('[follows-online]', e); }
    }

    console.log(`[join] ${username} (verified:${verified}) joined room: ${currentRoom}`);
  });

  socket.on('message', ({ text, username }) => {
    if (!currentRoom) return;
    const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), username, text, timestamp: Date.now() };
    if (!roomHistory[currentRoom]) roomHistory[currentRoom] = [];
    roomHistory[currentRoom].push(msg);
    if (roomHistory[currentRoom].length > MAX_HISTORY) roomHistory[currentRoom].shift();
    io.to(currentRoom).emit('message', msg);
  });

  // Live name-colour change — update this socket's presence entry and re-broadcast so peers recolour.
  socket.on('set-name-color', ({ color }) => {
    currentColor = color || null;   // remember it even while un-entered, so a later enter carries the colour
    const entry = roomUsers[currentPresenceRoom] && roomUsers[currentPresenceRoom][socket.id];
    if (!entry) return;
    entry.color = currentColor;
    broadcastPresence(currentPresenceRoom);
  });

  socket.on('msg-react', ({ msgId, emoji, username }) => {
    if (!currentRoom || !msgId || !emoji || !username) return;
    if (!roomMsgReactions[currentRoom]) roomMsgReactions[currentRoom] = {};
    const reactions = roomMsgReactions[currentRoom];
    if (!reactions[msgId]) reactions[msgId] = {};
    if (!reactions[msgId][emoji]) reactions[msgId][emoji] = [];
    const users = reactions[msgId][emoji];
    const idx = users.indexOf(username);
    if (idx === -1) users.push(username); else users.splice(idx, 1);
    if (users.length === 0) delete reactions[msgId][emoji];
    io.to(currentRoom).emit('msg-reaction-update', { msgId, emoji, users: reactions[msgId][emoji] || [] });
  });

  // 2d: page-bound layer routes to currentPageRoom (== currentRoom for the page-default Room).
  socket.on('cursor', ({ x, y, pts, scrollPct, username, scope, style }) => {
    if (!currentRoom) return;
    socket.to(currentPageRoom).emit('cursor', { x, y, pts, scrollPct, username, scope, style, id: socket.id });
  });

  socket.on('pointer-pulse', ({ x, y, username, scope }) => {
    if (!currentRoom) return;
    socket.to(currentPageRoom).emit('pointer-pulse', { x, y, username, scope });
  });

  socket.on('reaction', ({ emoji, x, y, username, source, scope }) => {
    if (!currentRoom) return;
    socket.to(currentPageRoom).emit('reaction', { emoji, x, y, username, source, scope });
  });

  socket.on('cursor-emote', ({ username, scope, spec, hold, stop }) => {
    if (!currentRoom) return;
    if (spec && oversizedField(spec.src)) return;
    socket.to(currentPageRoom).emit('cursor-emote', { username, scope, spec, hold, stop });
  });

  // Cursor blob MORPHS (transient deformations / letters that ride your cursor). spec is either
  // { kind:'deform', deform } or { kind:'text', text }; ms is the sender-chosen lifetime.
  socket.on('cursor-morph', ({ username, scope, spec, ms }) => {
    if (!currentRoom) return;
    socket.to(currentPageRoom).emit('cursor-morph', { username, scope, spec, ms });
  });

  socket.on('soundboard', ({ soundIndex, label, username, scope }) => {
    if (!currentRoom) return;
    socket.to(currentPageRoom).emit('soundboard', { soundIndex, label, username, scope });
  });

  socket.on('scroll-position', ({ username, scrollX, scrollY }) => {
    if (!currentRoom) return;
    socket.to(currentPageRoom).emit('scroll-position', { username, scrollX, scrollY });
  });

  socket.on('highlight', ({ text, username, scope }) => {
    if (!currentRoom) return;
    socket.to(currentPageRoom).emit('highlight', { text, username, scope });
  });

  socket.on('annotation-add', ({ id, selector, offsetX, offsetY, text, username, scope }) => {
    if (!currentRoom) return;
    const annotation = { id, selector, offsetX, offsetY, text, username, scope, timestamp: Date.now() };
    if (!roomAnnotations[currentPageRoom]) roomAnnotations[currentPageRoom] = [];
    if (!roomAnnotations[currentPageRoom].find(a => a.id === id)) {
      roomAnnotations[currentPageRoom].push(annotation);
    }
    io.to(currentPageRoom).emit('annotation-add', annotation);
  });

  socket.on('annotation-move', ({ id, selector, offsetX, offsetY }) => {
    if (!currentRoom) return;
    if (roomAnnotations[currentPageRoom]) {
      const ann = roomAnnotations[currentPageRoom].find(a => a.id === id);
      if (ann) { ann.selector = selector; ann.offsetX = offsetX; ann.offsetY = offsetY; }
    }
    io.to(currentPageRoom).emit('annotation-move', { id, selector, offsetX, offsetY });
  });

  socket.on('annotation-delete', ({ id }) => {
    if (!currentRoom) return;
    console.log(`[annotation-delete] id: ${id}`);
    if (roomAnnotations[currentPageRoom]) {
      roomAnnotations[currentPageRoom] = roomAnnotations[currentPageRoom].filter(a => a.id !== id);
    }
    io.to(currentPageRoom).emit('annotation-delete', { id });
  });

  socket.on('draw-start',  (data) => { if (currentRoom) socket.to(currentPageRoom).emit('draw-start',  data); });
  socket.on('draw-points', (data) => { if (currentRoom) socket.to(currentPageRoom).emit('draw-points', data); });
  socket.on('draw-end',    (data) => { if (currentRoom) socket.to(currentPageRoom).emit('draw-end',    data); });

  // ---- Shared canvas ----
  socket.on('canvas-subscribe', ({ scope }) => {
    if (!currentRoom) return;
    const key = currentRoom + ':' + (scope || 'page');
    const data = roomCanvases[key];
    socket.emit('canvas-init', {
      scope,
      strokes: data ? [...data.strokes.values()] : [],
      stamps:  data ? data.stamps : []
    });
  });

  socket.on('canvas-stroke-start', ({ id, scope, color, size, eraser, brush, opacity, x, y, shape }) => {
    if (!currentRoom) return;
    const key = currentRoom + ':' + (scope || 'page');
    if (!roomCanvases[key]) roomCanvases[key] = { strokes: new Map(), stamps: [] };
    const data = roomCanvases[key];
    if (data.strokes.size >= MAX_CANVAS_ITEMS) {
      const oldestId = data.strokes.keys().next().value;
      data.strokes.delete(oldestId);
    }
    const bru = brush || 'brush', op = opacity != null ? opacity : 100;
    const sh = (shape === 'line' || shape === 'rect' || shape === 'ellipse') ? shape : undefined;
    const stroke = { id, username: currentUsername, color, size, eraser: !!eraser, brush: bru, opacity: op, points: [{ x, y }] };
    if (sh) stroke.shape = sh;
    data.strokes.set(id, stroke);
    socket.to(currentRoom).emit('canvas-stroke-start', { id, scope, username: currentUsername, color, size, eraser: !!eraser, brush: bru, opacity: op, x, y, shape: sh });
  });

  socket.on('canvas-stroke-points', ({ id, scope, points }) => {
    if (!currentRoom) return;
    const key = currentRoom + ':' + (scope || 'page');
    const stroke = roomCanvases[key]?.strokes.get(id);
    if (stroke) stroke.points.push(...points);
    socket.to(currentRoom).emit('canvas-stroke-points', { id, scope, points });
  });

  socket.on('canvas-stroke-end', ({ id, scope }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('canvas-stroke-end', { id, scope });
  });

  socket.on('canvas-stamp', ({ id, scope, content, x, y, size }) => {
    if (!currentRoom) return;
    const key = currentRoom + ':' + (scope || 'page');
    if (!roomCanvases[key]) roomCanvases[key] = { strokes: new Map(), stamps: [] };
    const data = roomCanvases[key];
    const stamp = { id, scope, username: currentUsername, content, x, y, size };
    data.stamps.push(stamp);
    if (data.stamps.length > MAX_CANVAS_ITEMS) data.stamps.shift();
    io.to(currentRoom).emit('canvas-stamp', stamp);
  });

  socket.on('canvas-clear-mine', ({ scope }) => {
    if (!currentRoom) return;
    const key = currentRoom + ':' + (scope || 'page');
    const data = roomCanvases[key];
    if (!data) return;
    for (const [id, stroke] of data.strokes) {
      if (stroke.username === currentUsername) data.strokes.delete(id);
    }
    data.stamps = data.stamps.filter(s => s.username !== currentUsername);
    io.to(currentRoom).emit('canvas-redraw', {
      scope,
      strokes: [...data.strokes.values()],
      stamps: data.stamps
    });
  });

  socket.on('spray-add', ({ id, content, size, docX, docY, relX, relY, surface, username, scope }) => {
    if (!currentRoom) return;
    if (oversizedField(content)) return;
    const spray = { id, content, size, docX, docY, relX, relY, surface, username, scope, timestamp: Date.now() };
    if (!roomSprays[currentPageRoom]) roomSprays[currentPageRoom] = [];
    roomSprays[currentPageRoom].push(spray);
    if (roomSprays[currentPageRoom].length > MAX_SPRAYS) roomSprays[currentPageRoom].shift();
    io.to(currentPageRoom).emit('spray-add', spray);
  });

  socket.on('media-add', ({ id, url, username }) => {
    if (!currentRoom) return;
    if (oversizedField(url)) return;
    const item = { id, url, username, timestamp: Date.now() };
    if (!roomMedia[currentRoom]) roomMedia[currentRoom] = [];
    roomMedia[currentRoom].push(item);
    if (roomMedia[currentRoom].length > MAX_MEDIA) roomMedia[currentRoom].shift();
    io.to(currentRoom).emit('media-add', item);
  });

  socket.on('avatar-emote', ({ emote }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('avatar-emote', { id: socket.id, emote });
  });

  socket.on('avatar-interact', ({ type, targetId, vx, vy }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('avatar-interact', { id: socket.id, type, targetId, vx, vy });
  });

  socket.on('avatar-move', ({ x, y, t, username, facingLeft, onGround, fill }) => {
    if (!currentRoom) return;
    if (oversizedField(fill)) fill = null;   // strip an abusive skin; keep relaying the move so the avatar still updates
    if (!roomAvatars[currentRoom]) roomAvatars[currentRoom] = {};
    roomAvatars[currentRoom][socket.id] = { id: socket.id, x, y, username, facingLeft, onGround, fill };
    socket.to(currentRoom).emit('avatar-move', { id: socket.id, x, y, t, username, facingLeft, onGround, fill });
  });

  // ---- Authoritative avatar sim: client enters, streams inputs, exits ----
  socket.on('avatar-enter', ({ layout, username, fill }) => {
    if (!currentRoom) return;
    const rs = ensureRoomSim(currentRoom, layout);
    if (!rs.avatars[socket.id]) {
      rs.avatars[socket.id] = MWSim.createState(socket.id, rs.platforms);
      rs.queues[socket.id] = [];
      rs.lastInput[socket.id] = null;
    }
    rs.meta[socket.id] = { username: username || currentUsername, fill: fill || null };
    startRoomTick(currentRoom);
    // Immediately send the newcomer the current state so they see everyone.
    const list = Object.values(rs.avatars);
    socket.emit('avatar-snapshot', {
      tick: rs.tick, t: Date.now(),
      avatars: list.map(s => Object.assign(MWSim.snapshot(s), rs.meta[s.id] || {}))
    });
  });

  socket.on('avatar-input', (input) => {
    if (!currentRoom || !input) return;
    const rs = roomSim[currentRoom];
    if (!rs || !rs.avatars[socket.id]) return;
    const q = rs.queues[socket.id];
    q.push({
      seq: input.seq | 0,
      left: !!input.left, right: !!input.right, down: !!input.down,
      jump: !!input.jump, grab: !!input.grab, respawn: !!input.respawn
    });
    if (q.length > 20) q.splice(0, q.length - 20); // bound a runaway backlog
    if (input.fill && rs.meta[socket.id]) rs.meta[socket.id].fill = input.fill;
    if (input.username && rs.meta[socket.id]) rs.meta[socket.id].username = input.username;
  });

  socket.on('avatar-exit', () => {
    if (currentRoom) removeSimAvatar(currentRoom, socket.id);
  });

  // Set this player's authoritative respawn point (from touching a checkpoint flag).
  // The sim's respawn (R key / hazard) reads s.respawnX/Y; default (unset) = world spawn.
  socket.on('avatar-checkpoint', ({ x, y }) => {
    if (!currentRoom) return;
    const rs = roomSim[currentRoom];
    const s = rs && rs.avatars[socket.id];
    if (!s || !isFinite(x) || !isFinite(y)) return;
    // ⚠️ SAME CLASS as the terrain-edit clamp above: the room's own size, not the page stage's.
    const _rd = roomDims(currentAvatarRoom);
    s.respawnX = Math.max(0, Math.min(_rd.cols * TERRAIN_CELL, x));
    s.respawnY = Math.max(0, Math.min(_rd.rows * TERRAIN_CELL, y));
  });

  // ---- Avatar P2P transport signaling (Stage 6 pivot) ----
  // Thin relays for the unreliable WebRTC DataChannel mesh that carries avatar
  // positions peer-to-peer. Mirrors the voice handshake (new joiner offers to all
  // existing peers — single initiator, no glare) but is independent of voice and
  // carries no game state. Scoped to the avatar-world room = URL + MODE (sandbox/world),
  // so the two parallel worlds on a page mesh + replay independently. The presence/chat
  // layer stays on the bare URL room (currentRoom) regardless of mode.
  socket.on('avt-join', (data) => {
    if (!currentRoom) return;
    // Level TYPE drives generation/spawn (was `mode`); accept legacy `mode` from a stale old client.
    const type = (data && AVATAR_MODES.has(data.type || data.mode)) ? (data.type || data.mode) : 'sandbox';
    const roomId = resolveAvRoomId(data && data.roomId, currentRoom, socket.id);
    // Owner-of-a-real-user-room? (the URL page room has no DB row / owner → never hydrates)
    const rinfo = (roomId !== currentRoom) ? _avRoomLookup.get(roomId) : null;
    const isRoomOwner = !!(rinfo && socketToDiscordId[socket.id] && rinfo.owner_id === socketToDiscordId[socket.id]);
    // Phase 3: only a real user-room is build-permission-gated; the page/URL room (no DB row) stays open.
    currentAvBuildRoomId = rinfo ? roomId : null;
    currentAvOwnerId = rinfo ? rinfo.owner_id : null;
    // levelIndex selects the Level within the room's World; default the per-URL room's [sandbox=0, life=1].
    const levelIndex = (data && Number.isInteger(data.levelIndex) && data.levelIndex >= 0) ? data.levelIndex : (type === 'world' ? 1 : 0);
    // ⭐⭐ INCREMENT 7 — THE OVERWORLD. A 'world' join goes to ONE shared room instead of a per-page one. The page
    // is still what you ARE (it decides where you arrive, below); it is no longer where you GO.
    // ⚠️ SANDBOX LEVELS ARE NOT AFFECTED and must not be: a sandbox is a private scratch world per page, which is
    // a different thing from the shared world and stays exactly as it is.
    // ⚠️ `overworldRooms.add` happens HERE, before anything asks for the room's shape. `roomDims`, `worldGeom`
    // and `genCfgFor` all read this Set, so registering late would create page-shaped fields for an
    // Overworld-shaped world — and the fields are allocated by the first thing that touches them.
    // ⭐⭐ AND ONLY A SITE'S FRONT DOOR GOES THERE. SHARED-WORLD.md's model is two-tier and the second tier was
    // never wired: *"Entering Layer 2 from a site's HOME PAGE spawns you at its coordinates"* · *"Individual
    // pages (a Reddit post, a video, an article) are separate self-contained rooms — islands"*. Until now
    // `_isOver` was true for every 'world' join, so `reddit.com/` and `reddit.com/r/space/comments/xyz` landed
    // on the SAME column of the Overworld and no island room was ever reached. Measured before the fix: both at
    // column 324,745.
    // ⚠️ USER'S RULE, 2026-08-10, taken with the middle tier left open ON PURPOSE: **the bare host only**.
    // `reddit.com/` is the Overworld; `reddit.com/r/space` and everything deeper is its own island. The design
    // doc raises a third tier ("domain → sub-area → page") and whether a subreddit deserves its own coordinate
    // is a question to answer after playing with this, not before.
    // ⚠️ A non-URL room (a user-created Room with a DB row) is NOT the Overworld either — SHARED-WORLD.md
    // §"Non-URL rooms": *"Not part of the overworld. Continue as they are today."* It has no domain identity, so
    // placing it would allocate a column against a room id.
    // 🟥 THE RUNTIME FLAG IS GONE FROM THIS TEST, AND THAT IS THE FIX FOR A REAL BUG THE USER HIT.
    // `worldCfg.overworld` was a GLOBAL switch, so it decided for every player at once and overrode the
    // per-URL rule completely: the world you got depended on the debug panel rather than on the page you were
    // on. Worse, the client's own "reset to default" map still read `worldOverworld: false, worldGen2: false`,
    // so any reset silently switched the shared world off server-wide with nothing to show for it. Found with
    // the flag sitting at `false` on a running server and no one having deliberately set it.
    // ⇒ **which world you enter is a property of the URL, and of nothing else.** Rolling back is a one-line
    // edit here plus a restart, which is a deliberate act rather than a stray click in a debug menu.
    const _isOver = type === 'world' && !rinfo && isDomainHome(roomId);
    // ⚠️ A `.test` front door gets its OWN Overworld — same shape, same generator, separate room key and so
    // separate storage. See OVERWORLD_TEST_ROOM: the e2e harnesses were carving craters into the shared world.
    const _isTestOver = _isOver && isTestIdentity(roomId);
    const avRoom = _isOver ? (_isTestOver ? OVERWORLD_TEST_ROOM : OVERWORLD_ROOM) : avatarRoomKey(roomId, levelIndex);
    if (_isOver) overworldRooms.add(avRoom);
    // Where in the Overworld THIS socket arrives: an allocation against the page's permanent identity, which is
    // the whole of `server/domains.js`. `place` (not `peek`) because arriving is what claims a column.
    // ⚠️ PER SOCKET, NOT PER ROOM. Everywhere else `spawn` is a property of the room; in a shared world every
    // player has their own, so it cannot be read back from the room later — it is resolved once, here.
    const _overCol = _isOver ? (_isTestOver ? domainsTest : domains).place(overworldIdentity(roomId)) : null;
    // Duplicate-instance guard: if THIS identity is already live in this avatar World from another tab/window,
    // don't silently spawn a second blob. Ask the joiner to confirm a takeover (avt-dup); they re-send with
    // force:true, and we evict the other instance(s) here. (No-op at the common single-instance case.)
    const dupSockets = sameUserAvSockets(avRoom, socket.id);
    if (dupSockets.length && !(data && data.force)) { socket.emit('avt-dup', { levelIndex }); return; }
    if (dupSockets.length) {
      for (const other of dupSockets) {
        if (roomAvt[avRoom] && roomAvt[avRoom].delete(other)) socket.to(avRoom).emit('avt-peer-left', { id: other });
        dropRelay(avRoom, other);   // Phase 5a
        if (socketToAvatarRoom[other] === avRoom) delete socketToAvatarRoom[other];
        try { io.sockets.sockets.get(other)?.leave(avRoom); } catch {}
        io.to(other).emit('avt-evicted', { levelIndex });
      }
    }
    currentAvLevelIndex = levelIndex;                              // Phase 3: per-Level build lock keys on this
    currentAvRoomId = roomId;                                      // Phase 6 inc 4: the seed key, for a world regenerate
    // Phase 6: clamp this socket's object placement to the Level's band. The Overworld has no band — a Level
    // size preset is a page-world idea, and the whole width is the point.
    currentAvBand = _isOver ? null : playBand(roomId, levelIndex);
    // Leave any previous avatar room (Level switch without an explicit avt-leave).
    if (currentAvatarRoom && currentAvatarRoom !== avRoom) {
      socket.leave(currentAvatarRoom);
      if (roomAvt[currentAvatarRoom] && roomAvt[currentAvatarRoom].delete(socket.id)) socket.to(currentAvatarRoom).emit('avt-peer-left', { id: socket.id });
      dropRelay(currentAvatarRoom, socket.id);   // Phase 5a: a Level switch must not leave a ghost being relayed
    }
    currentAvatarRoom = avRoom;
    socketToAvatarRoom[socket.id] = avRoom;
    socket.join(avRoom);
    if (type === 'world') ensureWorldGenerated(avRoom, roomId, levelIndex);   // seed keyed by roomId (=URL for the default room → identical worlds), once per server lifetime; band from the Level's size preset
    // ⚠️ NOT INTO THE OVERWORLD. Hydration server-loads a PUBLISHED page world's stored content into a room;
    // doing that to the shared world would paste somebody's published page over whatever part of the Overworld
    // happened to share its coordinates, once per joiner.
    if (!_isOver) maybeHydratePublished(avRoom, roomId, levelIndex);   // Phase 7b: server-load a published World's content (no host needed); runs before the replay below
    if (!roomAvt[avRoom]) roomAvt[avRoom] = new Set();
    roomAvt[avRoom].add(socket.id);
    // Phase 4 visibility cap: who this joiner offers to. With peerCfg.cap = 0 this is every existing peer, i.e.
    // exactly what it has always been. `peerSelect` runs AFTER the add above so the pool is the real one, and it
    // filters the joiner out itself. The record is seeded here so the first beacon diffs against something real
    // rather than re-offering to everyone it just offered to.
    // ⭐ PHASE 5a — THE SERVER PICKS THE TRANSPORT, and says so here. `relay:1` tells the client to send
    // positions to us instead of meshing, and NOT to open DataChannels. That matters twice: it keeps the
    // decision server-side, which is what Phase 6 needs when the Overworld is relayed and page rooms are
    // not; and it prevents a DOUBLE-FEED, since a client that both meshed and relayed would push two
    // copies of every remote into the same `av.buf` the interpolator consumes.
    const _relayed = !!relayCfg.on;
    const _sel = _relayed ? null : peerSelect(avRoom, socket.id);
    const existingPeers = _relayed ? [] : [...(_sel || roomAvt[avRoom])].filter(id => id !== socket.id);
    if (_sel) (roomPeers[avRoom] || (roomPeers[avRoom] = new Map())).set(socket.id, new Set(existingPeers));
    // ⚠️ `dims` (Phase 6 increment 3a) — the room's WORLD SIZE IN PIXELS, decided server-side like `spawn` and
    // `relay` and delivered on the same seam. The client's terrain mirror used to derive its shape from a module
    // constant, so a second world shape was not expressible at all; it now reshapes to whatever this says.
    // `roomDims` returns the page shape for every room today, so this is the value the client already had.
    const _rd = roomDims(avRoom);
    const _spawn = (type === 'world') ? worldSpawnFor(avRoom, _overCol) : null;
    socket.emit('avt-joined', { existingPeers, mode: type, levelIndex, relay: _relayed ? 1 : 0, spawn: _spawn,
      dims: { w: _rd.cols * TERRAIN_CELL, h: _rd.rows * TERRAIN_CELL, cell: TERRAIN_CELL },
      // ⭐ WHERE YOU CAME FROM, said by the SERVER rather than re-derived on the client. The routing rule
      // (`isDomainHome` + `normalizeIdentity`) is subtle enough — shell paths, `www.`, ports, two-label public
      // suffixes — that a second copy on the client would drift, and then the badge would confidently describe
      // a decision that was not the one taken. `identity` is the part of the URL that placed you.
      origin: { url: String(roomId || ''), identity: domains.normalizeIdentity(roomId), home: _isOver ? 1 : 0 },
      // ⚠️ SAID EXPLICITLY, not inferred from `dims` being large. The client has to ignore its Level's SIZE
      // PRESET in the Overworld — a preset belongs to a page's Level, and the Overworld is entered THROUGH a
      // page, so it would otherwise fence the shared world down to whatever that page's Level 1 was set to.
      // "Is this the Overworld" is a fact the server knows; making the client guess it from a pixel count is
      // how the two ends drift apart.
      // ⭐ THE SHARED CLOCK, on the same server-decided seam as `spawn` / `dims` / `relay`. The sky (and now the
      // lighting) was per-browser; a sun that casts shadows has to be the same sun for everyone in the room.
      clock: worldClockWire(),
      overworld: _isOver ? 1 : 0 });
    // ⭐ WHAT YOU ARE CARRYING, on the same server-decided seam as `spawn` / `dims` / `clock`. The pouch was
    // browser-local until the Prima economy, so a client arrived believing whatever its own storage said; now it
    // is TOLD, on every join, and its own copy is a display of this one rather than a second source of truth.
    sendInvSync(socket, avRoom);
    // ⭐ THE GROUND UNDER THE SPAWN, ASKED FOR BEFORE THE CLIENT CAN ASK FOR IT. The client holds its body still
    // until the chunks around its spawn have arrived (see the spawn gate in 16e), so how long that hold lasts is
    // decided entirely by how soon those chunks are queued. Waiting for the first beacon costs a round trip plus
    // up to the beacon interval; queueing them here puts them at the FRONT of this socket's queue, which is
    // drained in insertion order, so they arrive before the rest of the viewport rather than somewhere inside it.
    // ⚠️ QUEUED, NOT PRODUCED. `queueChunks` hands them to the tick's drain with its own millisecond allowance —
    // generating nine chunks inline on the join path is exactly the whole-world-replay stall this join stopped
    // doing.
    if (_spawn && _isOver) {
      const _g = worldGeom(avRoom), _sc = Math.floor(_spawn.x / TERRAIN_CELL) >> 6, _sr = Math.floor(_spawn.y / TERRAIN_CELL) >> 6, _near = [];
      for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
        const gx = _sc + dc, gy = _sr + dr;
        if (gx >= 0 && gy >= 0 && gx < _g.cx && gy < _g.cy) _near.push(gx * _g.cy + gy);
      }
      if (_near.length) queueChunks(avRoom, socket.id, _near);
    }
    // Identity, once, rather than on every position packet — see roomProfile. Both directions: the joiner
    // needs everyone already here, and everyone here needs the joiner. Harmless when the relay is off (an
    // un-relayed client simply has no handler for these, and gets names off the mesh as it always has).
    if (_relayed) {
      const _pf = roomProfile[avRoom];
      if (_pf && _pf.size) socket.emit('avt-profiles', { profiles: [..._pf.values()].filter(p => p.id !== socket.id) });
    }
    // Replay the current world objects to the new joiner (late-joiner sync). `levelIndex` lets the client
    // drop a replay that arrives AFTER it has switched Levels again (rapid switching → stale cross-Level bleed).
    socket.emit('avatar-objects-init', { levelIndex, objects: roomObjects[avRoom] ? [...roomObjects[avRoom].values()] : [] });
    socket.emit('drops-init', { drops: roomDrops[avRoom] ? [...roomDrops[avRoom].values()] : [] });   // material lying on the ground (capped + TTL'd, so this list is small)
    // Replay the terrain grid (RLE) — present for any 'world' room and any 'sandbox' room with placed terrain.
    // 🟥 THE WHOLE-WORLD JOIN REPLAY IS FATAL IN THE OVERWORLD AND IS WHAT HUNG THE SERVER.
    // `terrainRLE` walks the entire index space — 524,224 x 4,096 = 2.15 BILLION cells, 33.5 million page
    // lookups — on EVERY join, and it gets worse as more of the world gets produced: measured 1 RLE run on a
    // fresh world and 32,621 after three clients had walked around in it. `materializeRoom` is worse still,
    // because it restores every evicted chunk in the room. The server stopped responding with an EMPTY error
    // log, which is what a stall looks like from outside and is exactly the "seemed to crash" from play.
    // ⭐ It is also simply unnecessary here. Phase 4's whole point was that a client is told about the chunks it
    // can SEE, and increment 4b produces those chunks on demand; `sendChunkContent` delivers terrain AND liquid
    // over the same wires the replay would have used. Measured against the live server: standing still in the
    // Overworld for three seconds delivers 122,880 cells, 111,038 of them solid, 28,874 within 96 cells of the
    // spawn. The replay was adding nothing except the stall.
    // ⚠️ `terrainHasAny` on the client is set by the incoming `terrain-set` cells (16a ~1088), NOT by
    // `terrain-init`, so skipping the replay does not leave the renderer switched off. Checked, not assumed.
    const _cs = cellsOf(avRoom), tg = _cs.terrain;
    if (!_isOver) {
      materializeRoom(avRoom);   // join replay reads the whole world — an evicted chunk would arrive empty
      if (tg) socket.emit('terrain-init', { levelIndex, cell: TERRAIN_CELL, cols: tg.geom.cols, rows: tg.geom.rows, ...terrainRLE(tg), hpRuns: _cs.terrainHp ? terrainRLE(_cs.terrainHp).runs : undefined });
      // Replay the multi-liquid stacks (layers per cell) so the joiner renders partial pools + composition correctly.
      if (tg) { const fi = buildFineInit(avRoom); if (fi && fi.cells.length) socket.emit('liquid-fine-init', fi); }
    }
    if (_cs.src && _cs.src.size) socket.emit('liquid-src', { cells: Array.from(_cs.src.keys()), on: true, init: true });   // join replay: which cells are sources (marker only; the sim owns the behaviour)
    // Replay the custom material registry so the joiner can render/paint any custom blocks already in this room.
    const mm = roomMats[avRoom];
    if (mm && Object.keys(mm).length) socket.emit('mats-init', { levelIndex, mats: mm });
    // Auto host-hydration (Phase 2b follow-up): if the room OWNER joins a still-blank Level we haven't
    // hydrated yet this server lifetime, ask their client to apply its host-local saved content. Emitted
    // LAST (after the empty replay above) so the inits can't clobber what the host is about to apply.
    // One-shot per av-room: once marked, members' live edits persist and are never re-pushed.
    if (isRoomOwner && !hydratedAvRooms.has(avRoom) && avRoomIsEmpty(avRoom)) {
      hydratedAvRooms.add(avRoom);
      socket.emit('avt-hydrate', { levelIndex });
    }
    // Phase 3: seed the joiner with this room's build permissions (page/URL room → open).
    socket.emit('build-perms', buildPermsPayload(currentAvBuildRoomId));
  });
  socket.on('avt-leave', () => {
    if (currentAvatarRoom && roomAvt[currentAvatarRoom] && roomAvt[currentAvatarRoom].delete(socket.id)) {
      socket.to(currentAvatarRoom).emit('avt-peer-left', { id: socket.id });
    }
    if (currentAvatarRoom) socket.leave(currentAvatarRoom);
    if (currentAvatarRoom && roomWhere[currentAvatarRoom]) roomWhere[currentAvatarRoom].delete(socket.id);   // Phase 3: stop holding chunks resident for someone who left
    if (currentAvatarRoom) { dropSubs(currentAvatarRoom, socket.id); dropPeers(currentAvatarRoom, socket.id); dropRelay(currentAvatarRoom, socket.id); }   // Phase 4: stop tracking what they were subscribed/meshed to · Phase 5a: and stop relaying them
    delete socketToAvatarRoom[socket.id];
  });
  // ── CHUNK RESIDENCY BEACON (SHARED-WORLD.md §7, Phase 3). A coarse, low-rate position so the server knows which
  // chunks to keep resident. Avatar positions otherwise travel P2P and never reach the server at all (see the
  // chunkCfg block). Deliberately not used for anything authoritative — it decides what is in MEMORY, nothing else,
  // so a client lying about it can only make its own world load differently.
  // Phase 4 per-tick batching is per-socket OPT-IN. A page that has not been reloaded since it shipped has no
  // `world-batch` handler and would silently stop receiving the world — indistinguishable from a dead server. So a
  // client declares what it can unwrap, and until it does its traffic is sent the old way, event by event.
  socket.on('wire-caps', (c) => { if (c && c.batch) wireBatchOk.add(socket.id); else wireBatchOk.delete(socket.id); });
  // Phase 4 rides the SAME beacon: what has to be replicated to a client and what has to be resident on the server
  // are both "what that player can see", so a second signal would only be a second thing to get out of step.
  // ⭐⭐ WHERE THE SKY STARTS, PER COLUMN — the one fact the client cannot work out for itself.
  // The client lights the world from a field clamped to the terrain window, and the honest question at the
  // field's top edge is "is there open sky above me?". Answering it from the client's own data is impossible:
  // it holds a ~1,024-row slice of a 4,096-row world, so anything above the window reads as UNKNOWN. Seeding
  // sunlight wherever the top edge merely LOOKS open is worse than wrong — it makes a sealed underground
  // chamber as bright as a meadow the moment its ceiling happens to sit above the window.
  // ⭐ The generator answers it exactly and for free. `topLimitAt(c)` is the highest row at which a column can
  // hold ANYTHING — a pure arithmetic function of the column, producing no chunks — so every row above it is
  // guaranteed empty, and "the field starts above that row" is exactly "sunlight reaches the field's top edge".
  // ⚠️ Sent only when the column range CHANGES. It is one Int16 per column, and the beacon fires twice a second.
  let skyRangeC0 = -1, skyRangeC1 = -1, skySentKeys = 0;
  // ⭐⭐ AND IT REACHES MUCH FURTHER THAN THE VIEWPORT, because a SECOND reader wants it and wants a different
  //  width. The lighting needs the surface over the screen and nothing more; the BACKDROP draws the distance from
  //  this same strip wherever it reaches (`farReal`) and from a 16-column spline everywhere else, and its stack of
  //  parallax depths reaches about 18,000px either side. So all but the nearest sliver of the picture was drawn
  //  from one height every 128 world px — enough for the shape of a range, not for a cliff, a notch or a sea stack.
  //  ⭐ IT IS NEARLY FREE, and for the reason the region strip's own note gives: `surfAt` is pure arithmetic on the
  //  column, producing no chunks and touching no storage. Widening this does NOT mean widening the terrain window
  //  — the client's exact surface comes off this wire, not out of its cell mirror — so none of the memory or
  //  chunk-traffic arguments about the window apply. It is 2 bytes a column of one message.
  //  ⚠️ WHICH IS WHY THE THROTTLE HAD TO CHANGE WITH IT. It used to resend whenever the interest rect moved by a
  //  chunk, which for a strip this wide would be 25KB every 64 columns walked. It now resends only when the rect
  //  approaches the edge of the strip the client already holds — the same hysteresis `sendRegions` uses, and for
  //  the same reason.
  const SKY_MARGIN = 2048;                // columns of exact surface either side of the interest rect
  function sendSkyRows(room, rect) {
    const gen = _roomGens.get(room);
    if (!gen || typeof gen.surfAt !== 'function') return;       // no generator (or an older one) ⇒ the client keeps its fallback
    const geom = worldGeom(room);
    const cr0 = Math.max(0, (rect.cx0 - 1) * CHUNK_SIDE), cr1 = Math.min(geom.cols - 1, (rect.cx1 + 2) * CHUNK_SIDE - 1);
    // Still holding a strip with a quarter of the margin to spare either side of what they can see? Then nothing
    // has to be sent. ⚠️ The lighting reads this too, so the test is on the RECT — what they can see — never on
    // how far they have walked.
    const keep = SKY_MARGIN >> 2;
    if (skyRangeC0 >= 0 && cr0 >= skyRangeC0 + keep && cr1 <= skyRangeC1 - keep) return;
    const c0 = Math.max(0, cr0 - SKY_MARGIN), c1 = Math.min(geom.cols - 1, cr1 + SKY_MARGIN);
    if (c0 === skyRangeC0 && c1 === skyRangeC1) return;         // …at the edge of the world it cannot grow further
    skyRangeC0 = c0; skyRangeC1 = c1;
    const n = c1 - c0 + 1;
    if (n <= 0 || n > 65536) return;
    // 🟥 THE GENERATOR HAS ITS OWN COORDINATE SPACE AND THIS IS WHERE IT BITES. A room is a WINDOW on one fixed
    // world: `generator column = originCol + room column`, `generator row = originRow + room row` (see
    // `fillPage`/`pageEmpty`, which both do exactly this conversion). The first version passed room coordinates
    // straight in and returned generator rows straight out, so every column's sky boundary was the answer for
    // some entirely different column, in the wrong row space.
    // ⭐ THAT IS WHY "THE SUN DOES NOTHING". A wrong boundary makes `r0 < skyLimit` false almost everywhere, the
    // client concludes no column is open to the sky, NO SUNLIGHT IS SEEDED AT ALL — and the whole world is then
    // lit only by the player's torch. Which is also exactly why "loss through air still affects surface light":
    // with the sun gone, every lit cell was reached by propagation through air.
    // 🟥 THE GROUND, NOT `topLimitAt`. This sent `topLimitAt` — "the highest row this column could hold anything
    // in" — and used it as "where the sky starts". Those are different questions, and the difference is exactly
    // a SKY ISLAND: `topLimitAt` deliberately lifts itself above one (that is its job, proving a page empty), so
    // every column underneath an island answered "there is no sky above me" and the ground beneath went black.
    // Found from play — the sun worked ON the islands and nowhere under them, which is the observation that
    // identifies the mechanism exactly.
    // ⭐ The right quantity is the SURFACE. The field's top edge sees the sun when it is above the ground, and
    // an island between the two is ordinary terrain: it sits inside the field and casts its shadow through the
    // occlusion sweep like anything else.
    const oc = gen.originCol | 0, orow = gen.originRow | 0;
    const surf = new Array(n);
    for (let k = 0; k < n; k++) surf[k] = Math.max(0, Math.min(geom.rows, (gen.surfAt(oc + c0 + k) | 0) - orow));
    socket.emit('world-sky', { c0, surf, sea: Math.max(0, (gen.seaRow | 0) - orow) * TERRAIN_CELL });
  }
  // ══ ⭐⭐ THE FLOATING ISLANDS, ONCE — the one thing in the world the backdrop's heightfield cannot express.
  //  Every other wire here answers a QUESTION PER COLUMN, and a column has one surface. An island has air under
  //  it, so it is not a surface at all; the backdrop needs it as a closed body with a top and a bottom, which is
  //  how `worldgen2` already holds them (see `skyIsles` there for the profile and for what `alt` means).
  //  ⚠️ NO THROTTLE AND NO INTEREST RECT, deliberately: there are about a hundred of them in the whole 4.19M-px
  //  layout, so this is a few KB sent once and it CANNOT go stale — the layout is fixed by the seed and shared
  //  by every room. That is the same argument the whole-world coarse strip is sent on.
  let islesSent = false;
  function sendIsles(room) {
    if (islesSent) return;
    const gen = _roomGens.get(room);
    if (!gen || typeof gen.skyIsles !== 'function') { islesSent = true; return; }   // page room, or an older generator
    const oc = gen.originCol | 0, orow = gen.originRow | 0;
    let list = null;
    try { list = gen.skyIsles(); } catch (e) { islesSent = true; return; }
    islesSent = true;
    if (!list || !list.length) return;
    // ⚠️ ROOM SPACE, like `world-sky`'s rows: a room is a WINDOW on the shared layout, so `c` is routinely
    // negative or past the room's own width. That is correct — the backdrop draws the country the window looks
    // out onto, and the same is already true of the wide surface strip's `c0`.
    const isles = list.map((I) => ({
      c: I.at - oc, hw: I.hw | 0,
      top: I.top.map((r) => r - orow), bot: I.bot.map((r) => r - orow),
      alt: (I.alt | 0) * TERRAIN_CELL,
    }));
    socket.emit('world-isles', { isles });
  }
  // ⭐ WHICH REGION EACH COLUMN IS IN — a SEPARATE, COARSER, MUCH WIDER strip, and all three of those words are
  // the point.
  //   COARSER: the layout samples the world every 64 columns and takes the biome from the NEAREST sample, so a
  //     region boundary can only ever fall on a 64-column line. One byte per column was 64× more data than the
  //     generator has answers for.
  //   WIDER: the client smooths the backdrop over a BLOCK of ~1,024 columns, and cannot smooth over data it has
  //     not got. At one byte per 64 columns, 1,024 entries is 65,536 columns — 524,000px of world — for 1KB.
  //   SEPARATE: it therefore has its own throttle. The surface rows follow the viewport chunk by chunk; this
  //     only needs re-sending when you have walked a quarter of the way out of the strip you already hold.
  // 🟥 THE MEASUREMENT THAT FORCED THIS. I told the user region runs were "hundreds of columns" off ONE
  // 448-column window; they walked around and said it changes far more often. `probe_region_runs.js` says the
  // median run is 704 columns — but **12% are 128 columns or less**, i.e. under 1,024px, which is less than a
  // third of a screen. Those slivers restyle the entire horizon and restyle it back, and they are what "jarring"
  // means here. Smoothing them out is a client decision; having enough data to smooth over is this.
  const REG_STEP = 64;                    // the generator's own sample spacing — finer carries no information
  const REG_SPAN = 1024;                  // entries ⇒ 65,536 columns
  // ⭐⭐ AND THE SURFACE OVER THE SAME STRETCH, WHICH IS WHAT A WORLD-DERIVED BACKDROP IS MADE OF.
  //  `world-sky` above sends one row per column, exactly, for the INTEREST RECT — about a screen plus four
  //  chunks. That is everything the lighting needs and nowhere near enough for a distant layer: a backdrop drawn
  //  at a twentieth of the camera's rate shows twenty screens of country across one screen of glass, so it runs
  //  off the end of its own data within a few hundred pixels of walking. The regions were already wide for
  //  exactly this reason; the heights were not, and that mismatch is the whole constraint.
  //  ⭐ `surfAt` is a pure arithmetic function of the column — it produces no chunks and touches no storage — so
  //  a coarse wide strip costs nothing but the samples. One every 16 columns over the region strip's own 65,536
  //  gives 4,096 entries, and it rides the SAME message so the two can never disagree about which stretch of
  //  world they describe or when it was taken.
  //  ⚠️ 16 COLUMNS = 128px IS THE RESOLUTION OF THE PICTURE, and it is a trade against the span rather than a
  //  budget: the NEAREST distant layer wants fine detail over a few screens, the furthest wants coarse detail
  //  over twenty. One strip has to serve both, so it is sampled finely enough for the near one and wide enough
  //  for the far one, and the client smooths between samples.
  const FAR_STEP = 16;
  // ══ ⭐⭐ AND A SECOND, MUCH COARSER STRIP OVER THE **WHOLE WORLD**, SENT ONCE ═══════════════════════════════
  //  Reported from play: *"the depth layers … after a certain point it just becomes completely flat; even if it
  //  had to be coarse approximations."* Exactly right, and the arithmetic says how badly. The fine strip above
  //  covers 65,536 columns — 262,144px either side of you — and a deep depth at the settings now in use asks
  //  for **hundreds of millions**: with the horizontal squash at 900% and 36 depths the furthest one holds more
  //  world than exists. Past the strip's end every column reads the same clamped value, so it draws a flat line.
  //  ⭐ THE ANSWER IS NOT A WIDER FINE STRIP, IT IS A SECOND COARSE ONE, because the two ends of this want
  //  opposite things: the near depths want detail over a few screens and the far ones want ANY shape at all over
  //  the whole world. One strip serving both is what forced the compromise in the first place.
  //  ⭐ IT NEVER CHANGES AND IS THEREFORE SENT ONCE. `surfAt` is a pure function of the seed and the column, so
  //  the whole-world profile is fixed the moment the layout is: no centre, no hysteresis, no re-sends. About
  //  4,096 samples whatever the world's width — 8KB, one time — and cached per ROOM rather than per socket,
  //  since every player in the Overworld is looking at the same world.
  //  ⚠️ THE STEP IS DERIVED FROM THE WIDTH, not fixed: a page room is a few thousand columns wide and a fixed
  //  128-column step would describe it with thirty samples.
  //  🟥🟥 AND IT SWEEPS THE WHOLE SHARED LAYOUT, NOT THE ROOM — which is the difference between this fixing the
  //  report and not. MEASURED against the running server with `e2e_wide_strip.js`: an ordinary page world is
  //  **1,920 columns, 15,360px**, and the stack at 36 depths asks its deepest one for 263 MILLION. Sweeping the
  //  ROOM gave a strip 15,360px wide — everything past it still flat, i.e. essentially the whole picture.
  //  ⭐ A page room is a WINDOW into the shared layout at `originCol`, and `surfAt` is defined across all of it,
  //  so the country beyond the room's edges is real and free to describe: the backdrop shows what the window is
  //  a window ONTO. ⚠️ `c0` is therefore in ROOM columns and is NEGATIVE for every page room — the strip starts
  //  a long way to the left of the room's own column 0.
  const WIDE_N = 4096;
  function wideSurfFor(room, gen, geom) {
    const hit = _roomWideSurf.get(room);
    if (hit) return hit;
    const oc = gen.originCol | 0, orow = gen.originRow | 0;
    const span = Math.max(geom.cols, (WORLDGEN2 && WORLDGEN2.LAYOUT_COLS) ? WORLDGEN2.LAYOUT_COLS | 0 : geom.cols);
    const step = Math.max(FAR_STEP, Math.pow(2, Math.ceil(Math.log2(Math.max(1, span / WIDE_N)))));
    const n = Math.max(2, Math.ceil(span / step));
    const rows = new Array(n);
    // ⚠️ Clamped to the LAYOUT's rows, not the room's — see the fine strip above for why that distinction is
    // the whole difference between a distant range and a flat line.
    const RLIM = (WORLDGEN2 && WORLDGEN2.LAYOUT_ROWS) ? WORLDGEN2.LAYOUT_ROWS | 0 : geom.rows;
    for (let k = 0; k < n; k++) rows[k] = Math.max(-RLIM, Math.min(RLIM, (gen.surfAt(k * step) | 0) - orow));
    const rec = { step, rows, c0: -oc };
    _roomWideSurf.set(room, rec);
    return rec;
  }
  let regCentre = null, wideSent = 0;
  function sendRegions(room, rect) {
    const gen = _roomGens.get(room);
    if (!gen || typeof gen.biomeAt !== 'function') return;   // no generator (or an older one) ⇒ one flat region
    const geom = worldGeom(room);
    const mid = Math.max(0, Math.min(geom.cols - 1, Math.round((rect.cx0 + rect.cx1) * CHUNK_SIDE / 2)));
    const half = (REG_SPAN * REG_STEP) >> 1;
    if (regCentre !== null && Math.abs(mid - regCentre) < (half >> 1)) return;
    regCentre = mid;
    const c0 = Math.max(0, Math.floor((mid - half) / REG_STEP) * REG_STEP);
    const oc = gen.originCol | 0;
    const reg = new Array(REG_SPAN);
    for (let k = 0; k < REG_SPAN; k++) reg[k] = gen.biomeAt(oc + c0 + k * REG_STEP) & 255;
    const msg = { c0, step: REG_STEP, reg };
    // The KEYS ride along once: a byte with no table is not information, and the client keeps the last set it
    // was given rather than re-reading it every beacon.
    if (gen.biomeKeys && !skySentKeys) { msg.keys = gen.biomeKeys; skySentKeys = 1; }
    // ⚠️ Room rows, like `world-sky`'s: the generator has its own row space and a strip in the wrong one would
    // put the whole distance hundreds of rows out. Same conversion, same clamp, deliberately written the same way.
    if (typeof gen.surfAt === 'function') {
      const nS = (REG_SPAN * REG_STEP / FAR_STEP) | 0;
      const orow = gen.originRow | 0, surf = new Array(nS);
      // 🟥🟥 CLAMPED TO THE LAYOUT'S ROWS, NOT TO THE ROOM'S — and this is the real cause of the flat distance a
      // page room shows, found by measuring the wire rather than by looking at the picture. A page room is 405
      // rows tall and is a WINDOW into a layout 4,096 rows deep; both strips describe tens of thousands of
      // columns, i.e. country whose ground is thousands of rows above or below anything in this room. Clamping
      // that into 0..405 pinned every distant column to the room's ceiling or its floor — 77% of the samples
      // came back equal to their neighbour, which is a flat horizon written down as data.
      // ⚠️ The rows may now be NEGATIVE (country higher than this room's top) and may exceed its bottom. That is
      // correct: they are a height relative to the room's origin, and the backdrop draws them at whatever scale
      // its depth implies. Only the room's own TERRAIN has to fit in the room.
      const RLIM = (WORLDGEN2 && WORLDGEN2.LAYOUT_ROWS) ? WORLDGEN2.LAYOUT_ROWS | 0 : geom.rows;
      for (let k = 0; k < nS; k++) surf[k] = Math.max(-RLIM, Math.min(RLIM, (gen.surfAt(oc + c0 + k * FAR_STEP) | 0) - orow));
      msg.surfStep = FAR_STEP; msg.surf = surf;
      msg.sea = Math.max(0, (gen.seaRow | 0) - orow) * TERRAIN_CELL;
      // …and the whole-world profile, once. See wideSurfFor: it cannot go stale, so it rides the first strip.
      if (!wideSent) { const w = wideSurfFor(room, gen, geom); msg.wideStep = w.step; msg.wide = w.rows; msg.wideC0 = w.c0; wideSent = 1; }
    }
    socket.emit('world-regions', msg);
  }
  // ⭐ SOMEWHERE TO GO. The Overworld is 4.19 million pixels wide and the only way in was to walk, so anything
  // that only happens at a volcano, a sky island or the bottom of a cave system was effectively untestable.
  // The generator already knows where every one of those is — `prepare` placed them and kept the records — so
  // this is a read of a list that exists rather than a search.
  // ⚠️ THE ROW COMES FROM `bandGroundAt`, NOT FROM THE RECORD. A record says where a feature IS; it does not say
  // where a body can stand, and the spawn seam already learned that the hard way. Asking the generator for a
  // floor with clearance in the right depth band is the one call that answers "somewhere I can be dropped".
  // ⚠️ Produces nothing: `bandGroundAt` walks the column arithmetically. Landing there is what produces chunks.
  const PLACE_KINDS = [
    ['volc', 'Volcano', 'surface'], ['vents', 'Vent field', 'surface'], ['forms', 'Landform', 'surface'],
    ['cliffs', 'Cliff', 'surface'], ['sky', 'Sky island', 'sky'], ['caves', 'Cave system', 'underground'],
    ['descents', 'Descent', 'underground'], ['rim', 'Rimstone pools', 'underground'], ['voids', 'Void', 'underground'],
  ];
  // A record's own sub-type where it has one, so the list says what the thing IS. `kind` is the generator's word
  // for it (voids are arches and notches, formations are crystal, sulphur and talus), and a bare "Landform 3"
  // was the user's complaint: it names the list the record came out of, not the thing you are going to see.
  const PLACE_KIND_NAMES = {
    crystal: 'Crystal formation', sulphur: 'Sulphur mound', talus: 'Talus slope',
    arch: 'Natural arch', notch: 'Notch', hoodoo: 'Hoodoos', mesa: 'Mesa', dunes: 'Dune sea', crater: 'Crater',
  };
  socket.on('world-places', (req) => {
    const room = currentAvatarRoom; if (!room) return;
    const gen = _roomGens.get(room);
    if (!gen || !gen.C || typeof gen.bandGroundAt !== 'function') { socket.emit('world-places', { places: [], regions: [] }); return; }
    const geom = worldGeom(room), places = [];
    const originCol = gen.originCol | 0;
    const regionOf = (col) => (typeof gen.biomeAt === 'function' && gen.biomeNames)
      ? (gen.biomeNames[gen.biomeAt(originCol + col)] || '') : '';
    for (const [key, label, band] of PLACE_KINDS) {
      const list = gen.C[key];
      if (!Array.isArray(list) || !list.length) continue;
      const b = domains.bandRows(band) || domains.bandRows('surface');
      const take = Math.min(6, list.length), stepN = Math.max(1, Math.floor(list.length / take));
      let n = 0;
      for (let i = 0; i < list.length && n < take; i += stepN) {
        const rec = list[i];
        // Records address the generator's own column space; the room's grid starts at `originCol`.
        const at = rec.at != null ? rec.at : (rec.entryC != null ? rec.entryC : (rec.l != null ? (rec.l + rec.r) / 2 : (rec.c0 != null ? rec.c0 : null)));
        if (at == null) continue;
        const col = Math.round(at) - originCol;
        if (col < 4 || col >= geom.cols - 4) continue;
        let r = gen.bandGroundAt(col, b.r0, b.r1, 5);
        // 🟥 THE FALLBACK IS WHY SOME ENTRIES "DO NOT MATCH THEIR LABEL". A cave system with no standable floor
        // in the UNDERGROUND band used to fall back to the surface band and still be listed as "Cave system" —
        // so the label promised a cave and the trip delivered a hillside. Landing on the surface above a cave is
        // a perfectly reasonable place to go, so it is kept and SAID: the label now carries where you will
        // actually arrive, rather than where the record lives.
        let arrived = band;
        if (r < 0) { const s = domains.bandRows('surface'); r = gen.bandGroundAt(col, s.r0, s.r1, 5); arrived = 'surface'; }
        if (r < 0) continue;
        n++;
        const kindName = (rec.kind && PLACE_KIND_NAMES[rec.kind]) || (rec.sub && PLACE_KIND_NAMES[rec.sub]) || label;
        const reg = regionOf(col);
        const suffix = (arrived !== band) ? ' — on the surface above' : '';
        places.push({
          label: kindName + ' ' + n + (reg ? ' · ' + reg : '') + suffix,
          x: (col + 0.5) * TERRAIN_CELL, y: Math.max(0, r * TERRAIN_CELL - TERRAIN_CELL * 3),
        });
      }
    }
    // ⭐ AND A SECOND LIST: GO TO A REGION. The user asked for it in as many words — *"perhaps features is the
    // wrong term, I may have meant more regions"* — and it is a different question from a feature. A feature is
    // ONE placed thing at ONE column; a region is a stretch of country, and what you want from it is somewhere
    // that looks like it, not a coordinate.
    // ⚠️ READ STRAIGHT OFF THE LAYOUT ARRAY, not through `biomeAt`. `biomeAt` resolves a column through
    // `columnInfo`, which computes the whole column; scanning the world that way would be thousands of full
    // column syntheses for a dropdown. `W.biome[i]` is the same answer already computed, one array read.
    // ⚠️ AND A RUN, NOT A SAMPLE. The nearest single sample of a biome can be a 64-column sliver — the exact
    // thing that made the backdrop flicker — so "go to tundra" would land somewhere that does not look like
    // tundra at all. Only runs of 4+ samples (256 columns) count, and you arrive at the middle of one.
    const regions = [];
    const W = gen.W;
    if (W && W.biome && W.dx && gen.biomeNames) {
      const pc = (req && req.x != null) ? Math.round(req.x / TERRAIN_CELL) : Math.round(geom.cols / 2);
      const pi = Math.round((pc + originCol) / W.dx), n = W.biome.length;
      // ⚠️ ALL the qualifying patches per region, nearest first — not just the nearest one. Half the world's
      // regions went missing from the first version of this list because their NEAREST patch happened to have
      // no standable ground: an ocean column has none by definition, and a patch that lands on a cliff face has
      // none either. One failed candidate meant the whole region was unreachable. Try the next.
      const cands = new Map();
      let i = 0;
      while (i < n) {
        const b = W.biome[i];
        let j = i; while (j + 1 < n && W.biome[j + 1] === b) j++;
        if (j - i + 1 >= 4) {                                  // 4 samples = 256 columns; smaller is a sliver
          if (!cands.has(b)) cands.set(b, []);
          cands.get(b).push({ d: Math.abs(((i + j) >> 1) - pi), mid: (i + j) >> 1, len: j - i + 1 });
        }
        i = j + 1;
      }
      const s = domains.bandRows('surface');
      for (const [b, list] of cands) {
        list.sort((a, b2) => a.d - b2.d);
        for (const rec of list.slice(0, 8)) {
          const col = rec.mid * W.dx - originCol;
          if (col < 4 || col >= geom.cols - 4) continue;
          const r = gen.bandGroundAt(col, s.r0, s.r1, 5);
          if (r < 0) continue;                                  // nowhere to stand here — try the next patch
          regions.push({
            label: (gen.biomeNames[b] || ('region ' + b)) + ' · ' + Math.round(rec.len * W.dx * TERRAIN_CELL / 1000) + 'k px wide',
            x: (col + 0.5) * TERRAIN_CELL, y: Math.max(0, r * TERRAIN_CELL - TERRAIN_CELL * 3),
            d: rec.d,
          });
          break;
        }
      }
      regions.sort((a, b2) => a.d - b2.d);   // nearest first, which is what "go there" usually means
    }
    socket.emit('world-places', { places, regions });
  });
  socket.on('avt-where', (v) => {
    if (!currentAvatarRoom) return;
    const rect = noteWhere(currentAvatarRoom, socket.id, v);
    if (rect) { updateSubs(currentAvatarRoom, socket.id, rect); try { sendSkyRows(currentAvatarRoom, rect); sendRegions(currentAvatarRoom, rect); sendIsles(currentAvatarRoom); } catch (e) { /* lighting + backdrop hints only — never break the beacon */ } }
    if (!relayCfg.on) updatePeers(currentAvatarRoom, socket.id);   // Phase 4: re-select who is worth being meshed with.
    // ⚠️ Phase 5a: NOT while relaying — there is no mesh to maintain, and `relaySelect` re-ranks from the
    // same beacon on every relay tick anyway. Emitting `avt-peers` here would tell a relayed client to
    // open WebRTC connections it must not have.
  });

  // ── PHASE 5a: THE RELAY WIRE. All three handlers are no-ops unless `relayCfg.on`, so a client that
  // starts sending these against a server with the relay off costs nothing and breaks nothing.
  // ⚠️ NOT AUTHORITATIVE. Nothing here is validated as physics, because nothing here IS physics — the
  // client owns its own blob, exactly as it does over the mesh. What IS enforced is identity: the sender's
  // id is stamped server-side (see relayPos), so a client cannot relay a packet wearing someone else's id.
  socket.on('avt-pos', (msg) => {
    if (!relayCfg.on || !currentAvatarRoom) return;
    relayPos(currentAvatarRoom, socket.id, msg);
  });
  socket.on('avt-profile', (msg) => {
    if (!relayCfg.on || !currentAvatarRoom) return;
    const p = relayProfile(currentAvatarRoom, socket.id, msg);
    if (p) socket.to(currentAvatarRoom).emit('avt-profiles', { profiles: [p] });
  });
  // One-shot directed events (Tier 2 — punch/shock/stomp/boop/spin). Sent immediately rather than batched:
  // they are rare, they are the ones that must not be late, and over the mesh they already ride a separate
  // RELIABLE channel for exactly that reason. ⚠️ Interest-filtered like positions — an event from someone
  // you cannot see is an event about a blob you do not have.
  socket.on('avt-evt', (msg) => {
    if (!relayCfg.on || !currentAvatarRoom || !msg) return;
    const out = Object.assign({}, msg, { from: socket.id });
    // A directed hit goes to its target even if the target ranked outside the sender's visible set —
    // being punched by someone you cannot see is strange, but silently dropping the hit desyncs the
    // attacker (who has already played the swing) from the target (who never gets knocked back).
    const targets = new Set(relaySelect(currentAvatarRoom, socket.id).near);
    if (msg.target && roomAvt[currentAvatarRoom] && roomAvt[currentAvatarRoom].has(msg.target)) targets.add(msg.target);
    for (const sid of targets) io.to(sid).emit('avt-evt', out);
  });
  // ── CHUNK RESYNC. The client sends the hashes it believes each chunk has; the server answers with the content of
  // the ones that disagree, over the SAME `terrain-set` / `liquid-fine-cells` wires it already parses. This is the
  // repair path for a dropped diff, and it is per-chunk rather than whole-world, which is the point of hashing.
  socket.on('chunk-verify', ({ hashes }) => {
    const room = currentAvatarRoom;
    if (!room || !Array.isArray(hashes) || !peekCells(room).terrain) return;
    const geom = worldGeom(room), mine = chunkHashes(room), bad = [];
    for (let p = 0; p < geom.nPages && p < hashes.length; p++) if ((hashes[p] >>> 0) !== mine[p]) bad.push(p);
    socket.emit('chunk-verify-result', { mismatch: bad, total: geom.nPages });
    if (queueChunks(room, socket.id, bad.slice(0, 12))) return;   // queued; the tick delivers it
    // Bounded: a badly out-of-date client repairs over several passes. The body of this used to be written out here;
    // Phase 4 needs exactly the same operation on every re-subscribe, so it moved into sendChunkContent and both
    // paths now share it (including the `clear` fix, which resync silently needed too).
    sendChunkContent(socket, room, bad.slice(0, 12));
  });
  // ── CHUNK-WANT (Phase 6 increment 3b) — "send me these chunks, now" ─────────────────────────────────────────
  // 🟥 THE WINDOWED CLIENT NEEDED THIS AND ITS ABSENCE IS WHAT MADE THE FIRST BROWSER TEST LOOK BROKEN. A window
  // that moves DISCARDS the chunks that wrapped out, and it is much larger than the viewport the subscription is
  // built from — so the chunks it drops are mostly ones the server still believes the client has, and neither
  // `updateSubs` (which only reacts to the subscription set changing) nor `chunk-verify` (bounded to twelve
  // chunks a pass, which is why the client logged "139/210 repaired" and stayed full of holes) would refill them.
  // The client knows exactly what it dropped, so it says so. Bounded generously rather than tightly: this fires
  // on a window move, not on a timer, and a half-filled world is the failure it exists to prevent.
  socket.on('chunk-want', ({ chunks }) => {
    const room = currentAvatarRoom;
    if (!room || !Array.isArray(chunks) || !chunks.length || !peekCells(room).terrain) return;
    const geom = worldGeom(room), want = [];
    for (const p of chunks) { const q = p | 0; if (q >= 0 && q < geom.nPages && !want.includes(q)) want.push(q); }
    // 🟥 THIS IS THE ONE THAT MATTERED. `chunks` is a CLIENT-SUPPLIED list, so this call site decided how much
    // uninterruptible work a single message could buy: 512 chunks, measured at 777,600 cells and a 107.8ms stall
    // with generation OFF, and seconds with it on. Queued, the same request is spread over as many ticks as it
    // needs and no single message can stall the server at all.
    if (queueChunks(room, socket.id, want.slice(0, 512))) return;
    sendChunkContent(socket, room, want.slice(0, 512));
  });
  socket.on('avt-offer',  ({ to, sdp })       => { socket.to(to).emit('avt-offer',  { from: socket.id, sdp }); });
  socket.on('avt-answer', ({ to, sdp })       => { socket.to(to).emit('avt-answer', { from: socket.id, sdp }); });
  socket.on('avt-ice',    ({ to, candidate }) => { socket.to(to).emit('avt-ice',    { from: socket.id, candidate }); });

  // ---- Avatar world objects (Stage 6) — server-authoritative existence over reliable
  // socket.io; physics response is applied locally on each client. Persist till restart.
  socket.on('avatar-object-spawn', (data) => {
    if (!currentAvatarRoom || !data || !OBJ_TYPES.has(data.type)) return;
    if (!canBuild()) return;                                // Phase 3: L2 build permission
    const type = data.type;
    // Client supplies the id (for optimistic local placement). Require it to be namespaced to
    // this socket (anti-spoof); otherwise mint a fallback. Echoing the same id back means the
    // placer's optimistic object is overwritten in place rather than duplicated.
    let id = data.id;
    if (typeof id !== 'string' || !id.startsWith(socket.id + '-')) id = socket.id + '-s' + (++objSeq);
    if (!roomObjects[currentAvatarRoom]) roomObjects[currentAvatarRoom] = new Map();
    const map = roomObjects[currentAvatarRoom];
    if (map.has(id)) return;                                // ignore duplicate spawn for an existing id
    const obj = buildWorldObject(type, data, id, socket.id, currentUsername || socket.id);   // shared with 7b hydration
    if (!obj) return;
    // Phase 6: clamp placement into the playable band (no-op at 'large'). Anti-cheat belt+suspenders — the
    // client is already confined by camera/walls; this keeps a crafted packet from landing objects in the
    // washed-out region outside the band. Clamps the anchor + any point lists (strokes, platform paths).
    if (currentAvBand) {
      const b = currentAvBand;
      const a = clampToBand(b, obj.x, obj.y); obj.x = a.x; obj.y = a.y;
      if (Array.isArray(obj.pts)) for (const p of obj.pts) { const c = clampToBand(b, p.x, p.y); p.x = c.x; p.y = c.y; }
      if (obj.path && Array.isArray(obj.path.pts)) for (const p of obj.path.pts) { const c = clampToBand(b, p.x, p.y); p.x = c.x; p.y = c.y; }
    }
    if (type !== 'checkpoint' && type !== 'goal' && type !== 'spawn' && type !== 'portal') {  // no building solids on the spawn (world mode); non-solid flags → allowed
      const clear = spawnClearRect(currentAvatarRoom);
      if (clear) {
        let bx0, by0, bx1, by1;
        if (type === 'stroke') {
          bx0 = by0 = Infinity; bx1 = by1 = -Infinity;
          for (const p of obj.pts) { if (p.x < bx0) bx0 = p.x; if (p.x > bx1) bx1 = p.x; if (p.y < by0) by0 = p.y; if (p.y > by1) by1 = p.y; }
          const pad = (obj.w || 8) / 2; bx0 -= pad; by0 -= pad; bx1 += pad; by1 += pad;
        } else { const hw = (obj.w || 0) / 2, hh = (obj.h || 0) / 2; bx0 = obj.x - hw; by0 = obj.y - hh; bx1 = obj.x + hw; by1 = obj.y + hh; }
        if (aabbHitsClear(clear, bx0, by0, bx1, by1)) return;
      }
    }
    // Phase 6: cap counts USER-placed objects only (generated 'world-' scatter is exempt — matches the
    // client's userObjectCount). REJECT at the cap rather than FIFO-evicting, so an over-cap placement fails
    // cleanly (the client already blocks + shows the hint) instead of silently deleting the oldest object.
    let userObjs = 0;
    for (const k of map.keys()) if (!(typeof k === 'string' && k.startsWith('world-'))) userObjs++;
    if (userObjs >= MAX_OBJECTS_PER_ROOM) return;
    map.set(id, obj);
    io.to(currentAvatarRoom).emit('avatar-object-add', obj);     // whole room incl. sender (authoritative id)
  });
  // Mouse-eraser removal: only the OWNER may delete their own object this way. (Physically
  // destroying anyone's object goes through avatar-object-hit, which is unrestricted.)
  socket.on('avatar-object-remove', ({ id }) => {
    if (!currentAvatarRoom || !roomObjects[currentAvatarRoom]) return;
    if (!canBuild()) return;                                // Phase 3: L2 build permission (erase is a build op)
    const obj = roomObjects[currentAvatarRoom].get(id);
    // Owner by stable username (survives reconnect/new socket.id) OR the live socket.id.
    if (!obj || !(obj.ownerId === socket.id || (obj.owner && obj.owner === currentUsername))) return;
    roomObjects[currentAvatarRoom].delete(id);
    io.to(currentAvatarRoom).emit('avatar-object-removed', { id });
  });
  // Bulk-remove all of MY own objects (the Erase tool's "Remove all mine" button). Owner-scoped,
  // like the single mouse-eraser, but in one round-trip.
  socket.on('avatar-objects-remove-mine', () => {
    if (!currentAvatarRoom || !roomObjects[currentAvatarRoom]) return;
    if (!canBuild()) return;                                // Phase 3: also wipes terrain → a build op
    const map = roomObjects[currentAvatarRoom], ids = [];
    for (const [id, o] of map) if (o.ownerId === socket.id || (o.owner && o.owner === currentUsername)) ids.push(id);
    for (const id of ids) map.delete(id);
    if (ids.length) io.to(currentAvatarRoom).emit('avatar-objects-removed', { ids });
    // Terrain is unowned (and ephemeral / all player-placed), so "Remove all" wipes the whole grid too.
    { const _cs = cellsOf(currentAvatarRoom); if (_cs.terrain) { _cs.terrain.fill(0); if (_cs.terrainHp) _cs.terrainHp.fill(0); dropPowderSet(currentAvatarRoom); clearFineRoom(currentAvatarRoom); clearLiquidSources(currentAvatarRoom); io.to(currentAvatarRoom).emit("terrain-cleared"); } }
  });
  // Debug: wipe the WHOLE environment for everyone in the room (clears all owners' objects).
  socket.on('avatar-objects-clear-all', () => {
    if (!currentAvatarRoom) return;
    if (!canBuild()) return;                                // Phase 3: full wipe → a build op
    if (roomObjects[currentAvatarRoom]) {
      const map = roomObjects[currentAvatarRoom], ids = [...map.keys()];
      map.clear();
      if (ids.length) io.to(currentAvatarRoom).emit('avatar-objects-removed', { ids });
    }
    { const _cs = cellsOf(currentAvatarRoom); if (_cs.terrain) { _cs.terrain.fill(0); if (_cs.terrainHp) _cs.terrainHp.fill(0); dropPowderSet(currentAvatarRoom); clearFineRoom(currentAvatarRoom); clearLiquidSources(currentAvatarRoom); io.to(currentAvatarRoom).emit("terrain-cleared"); } }
  });
  // Damage a destructible object (client-authoritative hit). Decrement hp; broadcast the new
  // hp, or remove it at 0. Server owns hp so concurrent hits can't double-count past zero.
  // Destructible terrain: paint/carve a circle into the room grid, then rebroadcast the op so every
  // client rasterizes it identically (client also applies optimistically). Only echoes on a real change.
  // ⭐ A CLIENT DIAGNOSTIC, PRINTED HERE. The dev page relays console errors to its own terminal, but the
  // EXTENSION has no such path — so a diagnostic only reached me if the tester happened to be on the dev page,
  // and a measurement you can only take on one of two surfaces is a measurement that will be missed. Routing it
  // over the socket the client already holds works on both.
  // Rate-limited rather than trusted: this writes to the server's stdout.
  let _logBudget = 400, _logWindow = 0;
  socket.on('client-log', (msg) => {
    const now = Date.now();
    if (now - _logWindow > 60000) { _logWindow = now; _logBudget = 400; }
    if (_logBudget-- <= 0 || typeof msg !== 'string') return;
    console.log('[client ' + socket.id.slice(0, 4) + '] ' + msg.slice(0, 4000));
  });
  // A dig turned terrain into a pile on the ground. The client says WHAT it dug (it already had to know, to
  // apply the carve optimistically); the server decides the id, the resting position and whether it exists at
  // all — which is the part that has to be authoritative, because two players must not both collect one pile.
  socket.on('terrain-drop', ({ x, y, mats }) => {
    if (!currentAvatarRoom || !canBuild()) return;
    if (!isFinite(x) || !isFinite(y) || !Array.isArray(mats) || !mats.length || mats.length > 8) return;
    const dims = roomDims(currentAvatarRoom);
    const cx = Math.max(0, Math.min(dims.cols * TERRAIN_CELL, x)), cy = Math.max(0, Math.min(dims.rows * TERRAIN_CELL, y));
    const clean = []; let total = 0;
    for (const e of mats) {
      if (!Array.isArray(e)) continue;
      const m = e[0] | 0, n = e[1] | 0;
      if (m < 1 || m > TERRAIN_MAT_HI || n < 1) continue;
      const k = Math.min(64, n); clean.push([m, k]); total += k;
    }
    if (!clean.length || total > 64) return;      // 64 = the largest brush (7×7 = 49 cells) with room to spare
    spawnDrop(currentAvatarRoom, cx, cy, clean);
  });
  // Collect a pile. The taker already holds its contents (from drop-add / drops-init), so the reply carries only
  // the id + who won it — everyone removes it, and the winner adds its own copy's materials to their inventory.
  // ⭐ PUT SOMETHING DOWN ON PURPOSE. The counterpart to picking up, and the primitive the whole "carry it home
  // and hand it to your group" half of the design rests on — you cannot give anything to anybody until you can
  // put it down. `mat` 0 means Prima; anything else is that material.
  // ⚠️ SERVER-AUTHORITATIVE LIKE EVERY OTHER LEDGER MOVE: the client asks, the server decides how much it
  // actually had, and the pile carries what was really taken. A client asking to drop a thousand diamonds it
  // does not hold spawns nothing.
  // ⚠️ `vx` is the throw, taken from the direction the player DRAGGED the stack out of the pouch. Clamped in
  // `spawnDrop`, so a client cannot fling a pile across the world; and it is only a nicety, so an absent or
  // silly value degrades to a pile at your feet rather than a rejection.
  socket.on('inv-drop', ({ mat, n, vx }) => {
    if (!currentAvatarRoom) return;
    const key = playerKeyFor(socket.id);
    const p = lastBodyPos(currentAvatarRoom, socket.id);
    if (!p) return;                                       // no idea where they are ⇒ nowhere to put it
    const id = mat | 0, want = Math.max(0, Math.min(1e9, n | 0));
    if (!want) return;
    const opts = { vx: +vx || 0, hold: INV_DROP_HOLD_MS };
    if (id === 0) {
      const have = ledger.prima(key);
      const take = Math.min(have, want);
      if (!take) return;
      ledger.grantPrima(key, -take);
      spawnDrop(currentAvatarRoom, p.x, p.y - 12, [], take, opts);
    } else {
      const took = ledger.spend(key, id, want);
      if (!took) return;
      spawnDrop(currentAvatarRoom, p.x, p.y - 12, [[id, took]], 0, opts);
    }
    sendInvSync(socket, currentAvatarRoom);
  });
  socket.on('drop-take', ({ id }) => {
    const map = currentAvatarRoom && roomDrops[currentAvatarRoom];
    if (!map || !map.has(id)) return;             // already gone — someone else got there first
    // ⚠️ ENFORCED HERE, not only on the client that dropped it. The client stops asking during the hold, which
    // is what makes it feel right; this is what makes it TRUE — otherwise a modified client picks its own
    // throw straight back up, and so does anyone else's.
    if (map.get(id)._np > Date.now()) return;
    // ⭐ CREDIT FROM THE SERVER'S OWN COPY OF THE PILE, never from the taker's claim about it. This is what
    // makes crediting safe with no new trust machinery: the drop list was ALREADY server-owned (so two players
    // could not both collect one pile), so the server already knows exactly what was in it. The client is told
    // the result; it is never asked.
    const d = map.get(id);
    map.delete(id);
    if (d && ((d.mats && d.mats.length) || d.prima > 0)) {
      const key = playerKeyFor(socket.id);
      if (d.mats && d.mats.length) ledger.credit(key, d.mats);
      if (d.prima > 0) ledger.grantPrima(key, d.prima);
      sendInvSync(socket, currentAvatarRoom);
    }
    io.to(currentAvatarRoom).emit('drop-removed', { id, by: socket.id });
  });
  socket.on('terrain-edit', ({ op, x, y, r, mat, shape, hard, keepLiq, hits }) => {
    if (!currentAvatarRoom || (op !== 'paint' && op !== 'carve')) return;
    if (!canBuild()) return;                                // Phase 3: L2 build permission
    if (!isFinite(x) || !isFinite(y) || !isFinite(r)) return;
    // 🟥🟥 THIS CLAMPED EVERY EDIT TO THE *PAGE* WORLD'S SIZE, IN EVERY ROOM. `MWSim.C.WORLD_W/H` are the
    // page stage's constants (15,360 x 3,240). In the Overworld a player stands at x ~ 2,080,000, so every
    // paint and carve was clamped to the page world's corner -- two million pixels from where they clicked.
    // The CLIENT applies the edit optimistically where you actually clicked, so it renders there and looks
    // placed; the server put it somewhere else entirely, so nothing ever moves it and no diff ever corrects
    // it. That is the whole 'I go up into the sky, place liquid, and it is frozen' report, and it is exactly
    // the 'is anything still using page-world values?' class. `sendChunkContent`'s residency clamp had the
    // same bug and was fixed; this one was missed.
    // ⚠️ `roomDims` returns { cols, rows } — CELLS, not pixels. The first version of this fix read `.w`/`.h`,
    // got undefined, and clamped every edit to NaN: paint stopped working in page worlds entirely. Caught by
    // e2e_place_liquid going 6/6 → 2/6 immediately after.
    const _ed = roomDims(currentAvatarRoom);
    const cx = Math.max(0, Math.min(_ed.cols * TERRAIN_CELL, x)), cy = Math.max(0, Math.min(_ed.rows * TERRAIN_CELL, y));
    const rr = Math.max(TERRAIN_CELL / 2, Math.min(160, r));   // floor = one fine tile's half-extent so the client's smallest (1-cell) brush isn't inflated server-side
    const m = (op === 'paint') ? (Math.min(TERRAIN_MAT_HI, Math.max(1, mat | 0)) || 1) : 0;  // material id 1..255 (carve = 0)
    const sq = shape === 'square';
    // ⭐ ARM THE DRAIN CHECK BY USING ONE. `liquidCfg.sinks` ships off because drain blocks are a test tool and
    // looking for them costs ~3% of the liquid tick in every world that has none (see `sinkOn`). Painting one
    // is the only way a drain can enter a world, so painting one is what switches the check on — the tool works
    // without anybody having to know the switch exists. Broadcast so every open debug panel agrees.
    if (op === 'paint' && (mat | 0) === LIQ_SINK_ID && !liquidCfg.sinks) { liquidCfg.sinks = 1; io.emit('liquid-cfg', cfgWire()); }
    const hd = op === 'carve' && !!hard;                 // editor Carve tool: hard delete (any block); gameplay slam stays soft
    const grid = ensureTerrain(currentAvatarRoom), hp = ensureTerrainHp(currentAvatarRoom), mats = roomMats[currentAvatarRoom] || {};
    // The sender already applied this op optimistically, so echo to OTHERS only — carve = hp decrement is
    // NOT idempotent, double-applying would desync the sender's per-cell hp from everyone else's.
    // ⚠️ `hits` — how many chips this one swing lands. A carve of a strength>1 material only DAMAGES, and the
    // client counts the same number of hits locally, so the two hp values only stay in step if the count
    // travels. Applying the raster N times is the whole implementation: one pass IS one hit per cell.
    const nHits = (op === 'carve') ? Math.max(1, Math.min(8, (hits | 0) || 1)) : 1;
    // ── THE EDIT TRACE, half one: what did the SERVER's own raster actually do with this message? ──────────
    // ⚠️ Sampled the same way the raster picks cells, so "the server disagreed about which cells are in the
    // box" cannot hide inside "the server disagreed about whether to break them".
    let _tr = null;
    if (worldCfg.trace && op === 'carve') {
      const _R = grid.geom.rows, _C = grid.geom.cols;
      _tr = { box: [], solidBefore: 0 };
      const _c0 = Math.max(0, Math.floor((cx - rr) / TERRAIN_CELL)), _c1 = Math.min(_C - 1, Math.floor((cx + rr) / TERRAIN_CELL));
      const _r0 = Math.max(0, Math.floor((cy - rr) / TERRAIN_CELL)), _r1 = Math.min(_R - 1, Math.floor((cy + rr) / TERRAIN_CELL));
      for (let ry = _r0; ry <= _r1; ry++) for (let cc = _c0; cc <= _c1; cc++) {
        const ccx = (cc + 0.5) * TERRAIN_CELL, ccy = (ry + 0.5) * TERRAIN_CELL;
        if (Math.abs(ccx - cx) > rr || Math.abs(ccy - cy) > rr) continue;
        const i = cc * _R + ry; _tr.box.push(i); if (grid.g(i)) _tr.solidBefore++;
      }
    }
    // ── THE DEBIT. In a gated room a paint is paid for out of the server's ledger, in exactly the cells it
    // actually places. ⭐ THE BRUSH IS CAPPED RATHER THAN THE STROKE REFUSED: you place what you can afford and
    // the rest simply does not appear, which is both kinder and cheaper than a pre-flight count over the same
    // cells. ⚠️ Carving is NOT charged — digging is how you earn, and it always was free.
    // ⚠️ A refused or clamped paint needs NO bespoke revert on the client. The client paints optimistically, the
    // server does not, and the existing chunk sync heals the difference — the same mechanism that made a carve
    // "appear locally then come back" when the server disagreed. That is why this is a small change.
    const _payMat = (op === 'paint' && invGatedRoom(currentAvatarRoom)) ? m : 0;
    const _payKey = _payMat ? playerKeyFor(socket.id) : null;
    let _budget = _payMat ? ledger.budget(_payKey, _payMat) : null;
    if (_payMat && _budget <= 0) return;                    // nothing to build with — the stroke does nothing
    let _did = 0;
    for (let _h = 0; _h < nHits; _h++) {
      const _n = (sq ? rasterTerrainSquare : rasterTerrainCircle)(grid, hp, mats, cx, cy, rr, m, hd, _budget);
      _did += _n;
      if (_payMat) {
        if (_n) ledger.spend(_payKey, _payMat, _n);
        _budget -= _n;
        if (_budget <= 0) break;
      }
    }
    if (_payMat && _did) sendInvSync(socket, currentAvatarRoom);
    if (_tr) {
      let cleared = 0, chipped = 0, left = [];
      for (const i of _tr.box) { const v = grid.g(i); if (!v) cleared++; else { chipped++; if (left.length < 6) left.push(v + ':hp' + hp.g(i) + '/' + matStrengthSrv(mats, v)); } }
      const _p = geomPage(grid.geom, _tr.box[0] || 0);
      console.log(`[trace] carve @${cx | 0},${cy | 0} r=${rr} ${sq ? 'square' : 'circle'} hits=${nHits} hard=${hd ? 1 : 0}`
        + ` | box ${_tr.box.length} cells, ${_tr.solidBefore} were solid → ${cleared} now air, ${chipped} still solid`
        + (left.length ? ' [' + left.join(' ') + ']' : '') + ` | chunk ${_p}`);
    }
    if (_did) {
      // Wake any liquid in/around the edit so it flows into the freed space (dig-out) or spreads (poured).
      {
        // Liquid is DECOUPLED from the grid. A fluid paint → seed the fine block + set the grid back to EMPTY
        // (no fluid-id litter → no phantom FX / "can't place" / re-seed on the next edit). Solid-over-liquid + carve clear
        // the fine block; surrounding fine liquid is only WOKEN, never re-seeded from the grid.
        ensureFineArrays(currentAvatarRoom, 1);
        const ECOLS = grid.geom.cols;
        const bc0 = Math.max(0, Math.floor((cx - rr) / TERRAIN_CELL)), bc1 = Math.min(ECOLS - 1, Math.floor((cx + rr) / TERRAIN_CELL));
        const br0 = Math.max(0, Math.floor((cy - rr) / TERRAIN_CELL)), br1 = Math.min(grid.geom.rows - 1, Math.floor((cy + rr) / TERRAIN_CELL));
        const changedFine = [];
        // 🟥 THIS READ `r * ECOLS + c` — ROW-MAJOR — AND INCREMENT 5 MADE THE FLAT INDEX COLUMN-MAJOR.
        // It is the one site in the server the sweep missed, and it is the reason painted liquid stopped working
        // in page worlds and the sandbox. The index landed on an unrelated cell, so `grid.g(i) === m` was false,
        // so the fine block was never seeded and `grid.s(i, 0)` never ran: the paint was left sitting in the
        // TERRAIN GRID as a water-coloured BLOCK. It looks like water and can never move, because the liquid sim
        // does not own it — which is exactly "I place liquid and it doesn't move at all".
        // ⚠️ Nothing caught it because it fails SILENTLY and only for PAINTED liquid: generated and pre-existing
        // liquid is seeded elsewhere and was fine, so every world loaded correctly and only new paint was dead.
        const EROWS = grid.geom.rows;
        for (let r = br0; r <= br1; r++) for (let c = bc0; c <= bc1; c++) { const i = c * EROWS + r;
          if (op === 'paint' && isFluidId(m) && grid.g(i) === m) { const ca = new Array(LIQ_T).fill(0); ca[LIQ_RANK[m]] = LIQUID_MAX; for (const x of fineSetBlock(currentAvatarRoom, 1, c, r, ca)) changedFine.push(x); grid.s(i, 0); hp.s(i, 0); }
          // `keepLiq` (the play-mode dig and the slam): remove the SOLID ground and leave the fine liquid where
          // it is. The wake below still runs, so a dig into the side of a lake sloshes it instead of deleting it.
          else if ((op === 'carve' && !keepLiq) || (op === 'paint' && isSolidCell(grid.g(i)))) for (const x of fineClearBlock(currentAvatarRoom, 1, c, r)) changedFine.push(x);
        }
        fineWakeRect(currentAvatarRoom, bc0 - 1, br0 - 1, bc1 + 1, br1 + 1);
        emitFineCells(currentAvatarRoom, changedFine);
      }
      activatePowderRect(currentAvatarRoom, grid, Math.floor((cx - rr) / TERRAIN_CELL) - 1, Math.floor((cy - rr) / TERRAIN_CELL) - 1, Math.floor((cx + rr) / TERRAIN_CELL) + 1, Math.floor((cy + rr) / TERRAIN_CELL) + 1);   // dig removes support / paint drops grains
      // `hits`/`keepLiq` ride the rebroadcast too, or every OTHER client lands a different number of chips
      // than the sender did and their hp drifts apart — the same desync, one step removed.
      socket.to(currentAvatarRoom).emit('terrain-edited', { op, x: cx, y: cy, r: rr, mat: m, shape: sq ? 'square' : undefined, hard: hd, hits: nHits, keepLiq: keepLiq ? 1 : undefined });
      // A CARVE removes any source in the dug-out area. Digging the cell out is the obvious way to get rid of a
      // source, and without this it kept refilling the hole you had just made with no way to stop it -- a source is
      // invisible in the terrain data, so there was nothing left to delete.
      if (op === 'carve') dropSourcesInRect(currentAvatarRoom, Math.floor((cx - rr) / TERRAIN_CELL), Math.floor((cy - rr) / TERRAIN_CELL), Math.floor((cx + rr) / TERRAIN_CELL), Math.floor((cy + rr) / TERRAIN_CELL));
    }
  });
  // Undo for placed terrain: restore an explicit list of cells to prior values. Flat [index, value, ...].
  // Owner-agnostic (terrain isn't owner-tracked), but bounded and rebroadcast so all clients stay in sync.
  socket.on('terrain-set', ({ cells }) => {
    if (!currentAvatarRoom || !Array.isArray(cells) || cells.length > 16384) return;
    if (!canBuild()) return;                                // Phase 3: L2 build permission
    const grid = ensureTerrain(currentAvatarRoom), hp = ensureTerrainHp(currentAvatarRoom), mats = roomMats[currentAvatarRoom] || {};
    // ⚠️ The spawn keep-clear box no longer applies to TERRAIN. Keeping the ground empty was the wrong half of
    // the problem: it stopped players building near a spawn without helping at all when the spawn point was
    // inside terrain for any of the other reasons it can be. The client settles a respawn out of the ground
    // instead, which covers every cause. It still applies to OBJECTS (below/above), because nothing settles a
    // body out of a platform.
    let changed = false;
    for (let k = 0; k + 1 < cells.length; k += 2) {
      const i = cells[k] | 0;
      const v = Math.max(0, Math.min(TERRAIN_MAT_HI, cells[k + 1] | 0));
      if (i >= 0 && i < grid.length) { if (grid.g(i) !== v) { grid.s(i, v); changed = true; } hp.s(i, v ? matStrengthSrv(mats, v) : 0); }
      // Same rule for an explicit cell write (undo / paste / a test scene): anything that is no longer the liquid it
      // was drops its source flag. Only a cell that stays a liquid keeps refilling.
      if (!isFluidId(v)) dropSource(currentAvatarRoom, i);
    }
    {
      // Route liquid placement into the FINE grid. The old inline coarse seed (below) would drop the liquid
      // into the coarse sim, which the fine renderer skips → the "placed liquid is invisible / trapped mid-air" bug.
      ensureFineArrays(currentAvatarRoom, 1); const changedFine = [];
      for (let k = 0; k + 1 < cells.length; k += 2) {
        const i = cells[k] | 0; if (i < 0 || i >= grid.length) continue;
        const SROWS = grid.geom.rows, cc = Math.floor(i / SROWS), cr = i % SROWS;
        if (isFluidId(grid.g(i))) { const ca = new Array(LIQ_T).fill(0); ca[LIQ_RANK[grid.g(i)]] = LIQUID_MAX; for (const x of fineSetBlock(currentAvatarRoom, 1, cc, cr, ca)) changedFine.push(x); hp.s(i, 0); }   // the painted fluid id STAYS in the grid (re-coupled)
        else for (const x of fineClearBlock(currentAvatarRoom, 1, cc, cr)) changedFine.push(x);   // a solid/empty coarse cell clears its fine block
        if (isPowderId(grid.g(i))) powderSet(currentAvatarRoom).add(i); const up = i - 1; if (cr > 0 && isPowderId(grid.g(up))) powderSet(currentAvatarRoom).add(up);
        seedFineReactAround(currentAvatarRoom, i);   // explicit cell write (undo/paste/scene) can put a solid next to settled liquid
      }
      emitFineCells(currentAvatarRoom, changedFine);
    }
    if (changed) wireFanout(currentAvatarRoom, 'terrain-set', { cells });   // Phase 4: a player's edit is a cell diff like any other
  });
  // Custom material registry: define a new custom mat (or match an identical existing one). Dedups by signature,
  // assigns the next free id (16..255), stores per-room + broadcasts so every client can render/paint it. Acks {id, def}.
  socket.on('mat-define', (raw, ack) => {
    if (!currentAvatarRoom) { if (typeof ack === 'function') ack(null); return; }
    if (!canBuild()) { if (typeof ack === 'function') ack(null); return; }   // Phase 3: L2 build permission
    const def = sanitizeMatDef(raw);
    if (!def) { if (typeof ack === 'function') ack(null); return; }
    const mats = ensureMats(currentAvatarRoom), sig = matSig(def);
    for (const id in mats) if (matSig(mats[id]) === sig) { if (typeof ack === 'function') ack({ id: +id, def: mats[id] }); return; }
    if (Object.keys(mats).length >= CUSTOM_MAT_CAP) { if (typeof ack === 'function') ack(null); return; }
    let id = -1;
    for (let i = CUSTOM_MAT_MIN; i <= CUSTOM_MAT_HI; i++) if (!mats[i]) { id = i; break; }
    if (id < 0) { if (typeof ack === 'function') ack(null); return; }
    mats[id] = def;
    io.to(currentAvatarRoom).emit('mat-defined', { id, def });
    if (typeof ack === 'function') ack({ id, def });
  });
  socket.on('avatar-object-hit', ({ id, dmg }) => {
    if (!currentAvatarRoom || !roomObjects[currentAvatarRoom]) return;
    const obj = roomObjects[currentAvatarRoom].get(id);
    if (!obj || typeof obj.hp !== 'number') return;
    obj.hp -= (typeof dmg === 'number' && dmg > 0) ? Math.min(dmg, 99) : 1;
    if (obj.hp <= 0) { roomObjects[currentAvatarRoom].delete(id); io.to(currentAvatarRoom).emit('avatar-object-removed', { id }); }
    else io.to(currentAvatarRoom).emit('avatar-object-update', { id, hp: obj.hp });
  });

  // Phase 3: the host manages L2 build permissions live (owner-only). `mode` is the role default and
  // persists in rooms.perms; per-user overrides are in-memory. Both broadcast to the room's presence
  // bucket ('pg:'+roomId — every member building in any Level of the room is in it) so each client
  // recomputes its own build access and the host panel re-renders. Page/URL rooms have no roomId here.
  // Rooms-tab perms hub: owner requests a snapshot of any room they own (even one they're not currently in).
  socket.on('room-perms-get', ({ roomId }) => {
    if (!roomId) return;
    const did = socketToDiscordId[socket.id];
    if (!did || roomOwnerId(roomId) !== did) return;     // owner only
    socket.emit('room-perms', roomPermsPayload(roomId));
  });
  socket.on('build-mode-set', ({ roomId, mode }) => {
    if (!roomId || (mode !== 'all' && mode !== 'host')) return;
    const did = socketToDiscordId[socket.id];
    if (!did || roomOwnerId(roomId) !== did) return;     // owner only
    const rb = getRoomBuild(roomId); rb.mode = mode;
    persistRoomPerms(roomId);                            // preserve level locks alongside the mode
    io.to('pg:' + roomId).emit('build-perms', buildPermsPayload(roomId));
    socket.emit('room-perms', roomPermsPayload(roomId));  // keep the hub live for a non-member owner
  });
  // Per-Level build lock (owner-only): the checkbox next to each Level. locked=true disables building
  // in that Level for everyone but the owner; default (absent) = buildable.
  socket.on('build-level-lock-set', ({ roomId, levelIndex, locked }) => {
    if (!roomId || !Number.isInteger(levelIndex) || levelIndex < 0) return;
    const did = socketToDiscordId[socket.id];
    if (!did || roomOwnerId(roomId) !== did) return;     // owner only
    const rb = getRoomBuild(roomId);
    if (locked) rb.locked.add(levelIndex); else rb.locked.delete(levelIndex);
    persistRoomPerms(roomId);
    io.to('pg:' + roomId).emit('build-perms', buildPermsPayload(roomId));
    socket.emit('room-perms', roomPermsPayload(roomId));
  });
  socket.on('build-perm-set', ({ roomId, target, allow }) => {
    if (!roomId || typeof target !== 'string' || !target) return;
    const did = socketToDiscordId[socket.id];
    if (!did || roomOwnerId(roomId) !== did) return;     // owner only
    if (target === did) return;                          // owner is always allowed; never override self
    const rb = getRoomBuild(roomId);
    if (allow === null || allow === undefined) rb.over.delete(target);
    else rb.over.set(target, !!allow);
    io.to('pg:' + roomId).emit('build-perms', buildPermsPayload(roomId));
    socket.emit('room-perms', roomPermsPayload(roomId));
  });
  // Phase 4: owner sets a feature's room-wide mode ('all'|'host'). Persists in perms.features.
  socket.on('feature-mode-set', ({ roomId, feature, mode }) => {
    if (!roomId || !FEATURE_KEYS.includes(feature) || (mode !== 'all' && mode !== 'host')) return;
    const did = socketToDiscordId[socket.id];
    if (!did || roomOwnerId(roomId) !== did) return;     // owner only
    getRoomFeatures(roomId).modes[feature] = mode;
    persistRoomPerms(roomId);
    io.to('pg:' + roomId).emit('feature-perms', featurePermsPayload(roomId));
    socket.emit('room-perms', roomPermsPayload(roomId));
  });
  // Phase 4: owner sets a per-user override for one feature (allow null/undefined clears it).
  socket.on('feature-perm-set', ({ roomId, feature, target, allow }) => {
    if (!roomId || !FEATURE_KEYS.includes(feature) || typeof target !== 'string' || !target) return;
    const did = socketToDiscordId[socket.id];
    if (!did || roomOwnerId(roomId) !== did) return;     // owner only
    if (target === did) return;                          // owner is always allowed; never override self
    const m = getRoomFeatures(roomId).over.get(feature);
    if (allow === null || allow === undefined) m.delete(target);
    else m.set(target, !!allow);
    io.to('pg:' + roomId).emit('feature-perms', featurePermsPayload(roomId));
    socket.emit('room-perms', roomPermsPayload(roomId));
  });
  // Phase 4-REORG: owner locks/unlocks one feature (e.g. combat/ghost) on one Level — the Levels tab.
  socket.on('feature-level-lock-set', ({ roomId, feature, levelIndex, locked }) => {
    if (!roomId || !FEATURE_KEYS.includes(feature) || !Number.isInteger(levelIndex) || levelIndex < 0) return;
    const did = socketToDiscordId[socket.id];
    if (!did || roomOwnerId(roomId) !== did) return;     // owner only
    const s = getRoomFeatures(roomId).levelLock.get(feature);
    if (locked) s.add(levelIndex); else s.delete(levelIndex);
    persistRoomPerms(roomId);
    io.to('pg:' + roomId).emit('feature-perms', featurePermsPayload(roomId));
    socket.emit('room-perms', roomPermsPayload(roomId));
  });
  // Phase 5: owner toggles the World's nav mode live ('free' | 'series'). Persists in env_spec.nav and
  // broadcasts to the room's presence bucket so every member's modeBtn/series gating updates immediately.
  socket.on('nav-set', ({ roomId, nav }) => {
    if (!roomId || (nav !== 'free' && nav !== 'series')) return;
    const did = socketToDiscordId[socket.id];
    if (!did || roomOwnerId(roomId) !== did) return;     // owner only
    const row = db.prepare('SELECT env_spec FROM rooms WHERE id = ?').get(roomId);
    if (!row) return;
    const spec = parseEnvSpec(row.env_spec);
    if (!spec) return;                                   // a plain chat room (no World) — nothing to set
    spec.nav = nav;
    db.prepare('UPDATE rooms SET env_spec = ? WHERE id = ?').run(JSON.stringify(spec), roomId);
    io.to('pg:' + roomId).emit('room-nav', { roomId, nav });
    socket.emit('room-nav', { roomId, nav });            // echo for a non-member owner editing from the hub
  });

  socket.on('voice-join', ({ username, scope }) => {
    // Resolve the scope key: 'page' uses the URL room; otherwise use as-is (dm:X, room:X, group:X)
    const voiceScope = (!scope || scope === 'page') ? currentRoom : scope;
    if (!voiceScope) return;

    // Auto-leave any existing scope if switching
    const oldScope = socketVoiceScope[socket.id];
    if (oldScope && oldScope !== voiceScope) {
      if (roomVoice[oldScope]) {
        delete roomVoice[oldScope][socket.id];
        const oldTarget = oldScope === currentRoom ? currentRoom : 'voice:' + oldScope;
        io.to(oldTarget).emit('voice-peer-left', { id: socket.id });
      }
      socket.leave('voice:' + oldScope);
    }

    socketVoiceScope[socket.id] = voiceScope;
    if (!roomVoice[voiceScope]) roomVoice[voiceScope] = {};
    const existingPeers = Object.keys(roomVoice[voiceScope]);
    roomVoice[voiceScope][socket.id] = username;
    socket.join('voice:' + voiceScope);
    socket.emit('voice-joined', { existingPeers });

    // Page-scope: broadcast to all room members (who's-here speaking indicators)
    // Other scopes: broadcast only to voice-scope members (private call)
    if (voiceScope === currentRoom) {
      io.to(currentRoom).emit('voice-peer-joined', { id: socket.id, username });
    } else {
      socket.to('voice:' + voiceScope).emit('voice-peer-joined', { id: socket.id, username });
    }
  });

  socket.on('voice-leave', () => {
    const voiceScope = socketVoiceScope[socket.id];
    if (!voiceScope) return;
    if (roomVoice[voiceScope]) {
      delete roomVoice[voiceScope][socket.id];
      const target = voiceScope === currentRoom ? currentRoom : 'voice:' + voiceScope;
      io.to(target).emit('voice-peer-left', { id: socket.id });
    }
    socket.leave('voice:' + voiceScope);
    delete socketVoiceScope[socket.id];
  });

  socket.on('voice-offer',      ({ to, sdp })       => { socket.to(to).emit('voice-offer',    { from: socket.id, sdp }); });
  socket.on('voice-answer',     ({ to, sdp })       => { socket.to(to).emit('voice-answer',   { from: socket.id, sdp }); });
  socket.on('voice-ice',        ({ to, candidate }) => { socket.to(to).emit('voice-ice',      { from: socket.id, candidate }); });
  socket.on('voice-speaking',   () => {
    const voiceScope = socketVoiceScope[socket.id];
    if (!voiceScope) return;
    const target = voiceScope === currentRoom ? currentRoom : 'voice:' + voiceScope;
    socket.to(target).emit('voice-speaking', { id: socket.id });
  });

  socket.on('dm-open', ({ to, roomId, text, toDiscordId }) => {
    if (!roomId) return;
    const senderDiscordId = socketToDiscordId[socket.id];
    if (senderDiscordId) {
      let recipientDiscordId = toDiscordId;
      if (!recipientDiscordId) {
        try { const row = db.prepare('SELECT discord_id FROM users WHERE username = ?').get(to); recipientDiscordId = row?.discord_id; } catch {}
      }
      if (recipientDiscordId) {
        try { if (db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(recipientDiscordId, senderDiscordId)) return; } catch {}
      }
    }
    socket.join(roomId);
    if (!socketDmRooms[socket.id]) socketDmRooms[socket.id] = new Set();
    socketDmRooms[socket.id].add(roomId);
    const fromDiscordId = socketToDiscordId[socket.id] || null;
    const payload = { from: currentUsername, roomId, fromDiscordId };
    if (text) {
      const ts = Date.now();
      payload.firstMessage = { text, timestamp: ts };
      if (fromDiscordId && toDiscordId) {
        try { db.prepare('INSERT INTO dm_messages (from_discord_id, to_discord_id, text, sent_at) VALUES (?,?,?,?)').run(fromDiscordId, toDiscordId, text, ts); } catch {}
      }
    }
    socket.to('user:' + to).emit('dm-incoming', payload);
  });

  socket.on('dm-join', ({ roomId }) => {
    if (!roomId) return;
    socket.join(roomId);
    if (!socketDmRooms[socket.id]) socketDmRooms[socket.id] = new Set();
    socketDmRooms[socket.id].add(roomId);
  });

  socket.on('dm-message', ({ roomId, from, text, toDiscordId }) => {
    if (!roomId || !text) return;
    const senderDiscordId = socketToDiscordId[socket.id];
    if (senderDiscordId && toDiscordId) {
      try { if (db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(toDiscordId, senderDiscordId)) return; } catch {}
    }
    const ts = Date.now();
    socket.to(roomId).emit('dm-message', { roomId, from, text, timestamp: ts });
    const fromDiscordId = socketToDiscordId[socket.id];
    if (fromDiscordId && toDiscordId) {
      try { db.prepare('INSERT INTO dm_messages (from_discord_id, to_discord_id, text, sent_at) VALUES (?,?,?,?)').run(fromDiscordId, toDiscordId, text, ts); } catch {}
    }
  });
  socket.on('room-invite', ({ toDiscordId, roomId }) => {
    const senderDiscordId = socketToDiscordId[socket.id];
    if (!senderDiscordId || !toDiscordId || !roomId) return;
    try {
      const member = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND discord_id = ?').get(roomId, senderDiscordId);
      if (!member) return;
      const room = db.prepare('SELECT name FROM rooms WHERE id = ?').get(roomId);
      if (!room) return;
      const sender = db.prepare('SELECT username FROM users WHERE discord_id = ?').get(senderDiscordId);
      const recipientSocket = discordIdToSocket[toDiscordId];
      if (recipientSocket) {
        io.to(recipientSocket).emit('room-invite', {
          roomId,
          roomName: room.name,
          fromDiscordId: senderDiscordId,
          fromUsername: sender?.username || currentUsername
        });
      }
    } catch (e) { console.error('[room-invite]', e); }
  });

  socket.on('private-room-connect', ({ roomId }) => {
    socket.join('proom:' + roomId);
  });
  socket.on('private-room-disconnect', ({ roomId }) => {
    socket.leave('proom:' + roomId);
  });
  socket.on('private-room-message', ({ roomId, text, cid }) => {
    const senderDiscordId = socketToDiscordId[socket.id];
    if (!roomId || !text) return;
    try {
      const room = db.prepare('SELECT public FROM rooms WHERE id = ?').get(roomId);
      if (!room) return;
      if (!room.public) {
        if (!senderDiscordId) return;
        const member = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND discord_id = ?').get(roomId, senderDiscordId);
        if (!member) return;
      }
      if (!featureAllowedFor(roomId, 'chat', senderDiscordId)) return;   // Phase 4: host can mute room chat (hard-gated)
      let username = currentUsername;
      if (senderDiscordId) {
        const senderUser = db.prepare('SELECT username FROM users WHERE discord_id = ?').get(senderDiscordId);
        username = senderUser?.username || currentUsername;
      }
      if (!username) return;
      const ts = Date.now();
      const info = db.prepare('INSERT INTO room_messages (room_id, from_discord_id, text, sent_at) VALUES (?, ?, ?, ?)').run(roomId, senderDiscordId || null, text.slice(0, 2000), ts);
      const msgId = Number(info.lastInsertRowid);
      bumpRoomActive(roomId);   // activity → keeps an idle Site room alive

      socket.to('proom:' + roomId).emit('private-room-message', { roomId, from: username, fromDiscordId: senderDiscordId || null, text, timestamp: ts, id: msgId });
      if (cid) socket.emit('private-room-message-ack', { cid, id: msgId });   // let the sender patch its optimistic message with the real id
    } catch (e) { console.error('[private-room-message]', e); }
  });

  // Delete YOUR OWN messages (author-only, verified by discord id / username).
  socket.on('room-msg-delete', ({ roomId, id }) => {
    const senderDiscordId = socketToDiscordId[socket.id];
    if (!roomId || id == null || !senderDiscordId) return;
    try {
      const row = db.prepare('SELECT from_discord_id FROM room_messages WHERE id = ? AND room_id = ?').get(Number(id), roomId);
      if (!row || row.from_discord_id !== senderDiscordId) return;   // only the author can delete
      db.prepare('DELETE FROM room_messages WHERE id = ?').run(Number(id));
      io.to('proom:' + roomId).emit('msg-removed', { id: Number(id) });
    } catch (e) { console.error('[room-msg-delete]', e); }
  });
  socket.on('page-msg-delete', ({ id }) => {
    if (!currentRoom || id == null) return;
    const hist = roomHistory[currentRoom];
    if (!hist) return;
    const idx = hist.findIndex(m => m.id === id && m.username === currentUsername);   // page chat: author by username
    if (idx === -1) return;
    hist.splice(idx, 1);
    io.to(currentRoom).emit('msg-removed', { id });
  });

  socket.on('group-connect',    ({ groupId }) => { socket.join('pgroup:' + groupId); });
  socket.on('group-disconnect', ({ groupId }) => { socket.leave('pgroup:' + groupId); });

  socket.on('group-message', ({ groupId, text }) => {
    const senderDiscordId = socketToDiscordId[socket.id];
    if (!groupId || !text || !senderDiscordId) return;
    try {
      const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND discord_id = ?').get(groupId, senderDiscordId);
      if (!member) return;
      const senderUser = db.prepare('SELECT username FROM users WHERE discord_id = ?').get(senderDiscordId);
      const username = senderUser?.username || currentUsername;
      if (!username) return;
      const ts = Date.now();
      db.prepare('INSERT INTO group_messages (group_id, from_discord_id, text, sent_at) VALUES (?, ?, ?, ?)').run(groupId, senderDiscordId, text.slice(0, 2000), ts);
      socket.to('pgroup:' + groupId).emit('group-message', { groupId, from: username, fromDiscordId: senderDiscordId, text, timestamp: ts });
    } catch (e) { console.error('[group-message]', e); }
  });

  socket.on('group-invite', ({ toDiscordId, groupId }) => {
    const senderDiscordId = socketToDiscordId[socket.id];
    if (!senderDiscordId || !toDiscordId || !groupId) return;
    try {
      const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND discord_id = ?').get(groupId, senderDiscordId);
      if (!member) return;
      const group = db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId);
      if (!group) return;
      const sender = db.prepare('SELECT username FROM users WHERE discord_id = ?').get(senderDiscordId);
      const recipientSocket = discordIdToSocket[toDiscordId];
      if (recipientSocket) {
        io.to(recipientSocket).emit('group-invite', {
          groupId,
          groupName: group.name,
          fromDiscordId: senderDiscordId,
          fromUsername: sender?.username || currentUsername
        });
      }
    } catch (e) { console.error('[group-invite]', e); }
  });

  socket.on('nav', ({ url, username, newTab }) => {
    if (currentRoom) socket.to(currentRoom).emit('nav', { url, username });
    // A new-tab open (ctrl/middle/shift-click) fires from the CURRENT tab but doesn't change it —
    // the new tab will register itself via its own `join`. Don't touch the current tab's URL here,
    // or the snapshot's active tab would wrongly become the new link.
    if (newTab) return;
    const dId = socketToDiscordId[socket.id];
    if (dId && url) {
      // Update this tab's URL in the leader's tab set.
      const ts = socketToTabSession[socket.id];
      if (ts && leaderTabs[dId]) leaderTabs[dId].set(ts, url);
      try {
        const fRows = db.prepare(
          `SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END as fid
           FROM friends WHERE (from_id=? OR to_id=?) AND status='accepted'`
        ).all(dId, dId, dId);
        fRows.forEach(r => {
          const fs = discordIdToSocket[r.fid];
          if (fs) io.to(fs).emit('friend-location', { discord_id: dId, url });
        });
      } catch {}
      // Push an updated tab snapshot to followers.
      try { emitTabSnapshot(dId, username); } catch {}
    }
  });
  // Leader switched to this tab — mark it active and resnapshot followers.
  socket.on('tab-focus', ({ url }) => {
    const dId = socketToDiscordId[socket.id];
    if (!dId || !url) return;
    const ts = socketToTabSession[socket.id];
    if (ts && leaderTabs[dId]) {
      leaderTabs[dId].set(ts, url); // keep this tab's URL current
      leaderActiveTab[dId] = ts;
    }
    try { emitTabSnapshot(dId, currentUsername); } catch {}
  });

  socket.on('follow-start',     ({ target })        => { if (currentRoom) socket.to(currentRoom).emit('follow-start', { target, from: currentUsername || '' }); });
  socket.on('follow-end',       ({ target })        => { if (currentRoom) socket.to(currentRoom).emit('follow-end',   { target, from: currentUsername || '' }); });

  socket.on('follow-subscribe', ({ target }) => {
    socket.join('user:' + target);
    if (userCurrentFullUrl[target]) socket.emit('user-location', { url: userCurrentFullUrl[target] });
  });
  socket.on('follow-unsubscribe', ({ target }) => { socket.leave('user:' + target); });

  socket.on('friend-beacon', ({ url }) => {
    const dId = socketToDiscordId[socket.id];
    if (!dId || !url) return;
    try {
      db.prepare('UPDATE users SET beacon_url=? WHERE discord_id=?').run(url, dId);
      const rows = db.prepare(
        `SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END as fid
         FROM friends WHERE (from_id=? OR to_id=?) AND status='accepted'`
      ).all(dId, dId, dId);
      const uname = db.prepare('SELECT username FROM users WHERE discord_id=?').get(dId)?.username || socket.username;
      rows.forEach(r => {
        const fs = discordIdToSocket[r.fid];
        if (fs) io.to(fs).emit('friend-beacon', { fromId: dId, username: uname, url });
      });
      socket.emit('friend-beacon-own', { url }); // echo own beacon back to confirm persistence
    } catch {}
  });

  socket.on('clear-beacon', () => {
    const dId = socketToDiscordId[socket.id];
    if (!dId) return;
    try {
      db.prepare('UPDATE users SET beacon_url=NULL WHERE discord_id=?').run(dId);
      const rows = db.prepare(
        `SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END as fid
         FROM friends WHERE (from_id=? OR to_id=?) AND status='accepted'`
      ).all(dId, dId, dId);
      rows.forEach(r => {
        const fs = discordIdToSocket[r.fid];
        if (fs) io.to(fs).emit('friend-beacon-cleared', { fromId: dId });
      });
    } catch {}
  });

  // 2c: the client switched its active context Room — move this socket's who-list bucket to match.
  // The bare URL socket.io room is untouched (chat/history keep flowing); presence (2c) AND the page-bound
  // layer (2d) migrate to the new context Room without a page reload.
  socket.on('ctx-room', ({ roomId, entered } = {}) => {
    if (!currentRoom) return;
    // ---- presence bucket (2c) ----
    const next = resolvePresenceRoom(roomId, currentRoom, socket.id);
    // Item 10: a custom/locked bucket is always entered; the page-default bucket is entered only when the
    // client says so (it passes its live isEntered() for the destination). Un-entered = subscribe for the
    // count but stay out of roomUsers.
    const nextEntered = (next !== currentRoom) || !!entered;
    if (next !== currentPresenceRoom) {
      const info = roomUsers[currentPresenceRoom] && roomUsers[currentPresenceRoom][socket.id];
      // leave old bucket (but never leave the bare URL room — chat/history live there)
      if (roomUsers[currentPresenceRoom]) delete roomUsers[currentPresenceRoom][socket.id];
      if (currentPresenceRoom !== currentRoom) socket.leave(currentPresenceRoom);
      broadcastPresence(currentPresenceRoom);
      // join new bucket
      currentPresenceRoom = next;
      if (next !== currentRoom) socket.join(next);
      if (!roomUsers[next]) roomUsers[next] = {};
      if (nextEntered) roomUsers[next][socket.id] = info || { username: currentUsername, verified: !!socketToDiscordId[socket.id], avatar: null, discord_id: socketToDiscordId[socket.id] || null, color: currentColor };
      currentEntered = nextEntered;
      broadcastPresence(next);
    } else if (nextEntered !== currentEntered) {
      // Same bucket, entered intent changed (e.g. explicit Leave/Enter on the page-default Room without
      // a bucket switch) — fall through to room-presence semantics inline.
      if (nextEntered) roomUsers[next][socket.id] = (roomUsers[next] && roomUsers[next][socket.id]) || { username: currentUsername, verified: !!socketToDiscordId[socket.id], avatar: null, discord_id: socketToDiscordId[socket.id] || null, color: currentColor };
      else if (roomUsers[next]) delete roomUsers[next][socket.id];
      currentEntered = nextEntered;
      broadcastPresence(next);
    }
    // ---- page-bound bucket (2d): cursors/sprays/highlights/annotations ----
    const nextPage = resolvePageRoom(roomId, currentRoom, socket.id);
    if (nextPage !== currentPageRoom) {
      // drop our cursor from the old page bucket so peers there stop tracking us
      socket.to(currentPageRoom).emit('cursor-leave', { id: socket.id });
      if (currentPageRoom !== currentRoom) socket.leave(currentPageRoom);
      currentPageRoom = nextPage;
      if (nextPage !== currentRoom) socket.join(nextPage);
      // re-seed the persistent page-bound layer for the new (Room,url) bucket (client cleared its old layer)
      if (roomAnnotations[currentPageRoom]) socket.emit('annotations-init', roomAnnotations[currentPageRoom]);
      if (roomSprays[currentPageRoom]) socket.emit('sprays-init', roomSprays[currentPageRoom]);
    }
    // ---- feature policy (Phase 4): re-seed for the new context Room (null = page room → all open) ----
    { const fr = resolveAvRoomId(roomId, currentRoom, socket.id);
      socket.emit('feature-perms', featurePermsPayload(fr !== currentRoom ? fr : null)); }
  });

  // Item 10: explicit enter/leave + tab-visibility withdraw/restore for the CURRENT presence bucket
  // (no bucket switch — that's ctx-room's job). #4: join/left no longer post chat lines; peers learn
  // from the presence diff (transient toast) + the live who-list, so `announce` is now a no-op.
  socket.on('room-presence', ({ active } = {}) => {
    if (!currentRoom || !currentPresenceRoom) return;
    if (active) {
      if (currentEntered) return;                 // already in — idempotent
      if (!roomUsers[currentPresenceRoom]) roomUsers[currentPresenceRoom] = {};
      roomUsers[currentPresenceRoom][socket.id] = { username: currentUsername, verified: !!socketToDiscordId[socket.id], avatar: null, discord_id: socketToDiscordId[socket.id] || null, color: currentColor };
      currentEntered = true;
      broadcastPresence(currentPresenceRoom);
    } else {
      if (!currentEntered) return;
      if (roomUsers[currentPresenceRoom]) delete roomUsers[currentPresenceRoom][socket.id];
      currentEntered = false;
      broadcastPresence(currentPresenceRoom);
      // Drop our live cursor/avatar from peers (stay subscribed so we still see the count).
      socket.to(currentPageRoom).emit('cursor-leave', { id: socket.id });
      socket.to(currentRoom).emit('avatar-leave', { id: socket.id });
      // #4: no "left" chat line — peers learn from the presence diff (transient toast) + the live who-list.
    }
  });

  socket.on('disconnect', () => {
    // 🟥 AN EPHEMERAL BALANCE IS PUT BACK INTO THE WORLD, NOT DELETED. Until this existed, a logged-out player
    // leaving with a full pouch simply annihilated it — a conservation leak (kickoff_prima.md §8 row 4) and,
    // much more immediately, the worst possible way to learn that you were not logged in.
    // ⚠️ ONLY for `s:` keys, and the distinction matters: a logged-in player's connection blips constantly (every
    // page navigation is a new socket), and dumping their haul on the ground each time would be a disaster. They
    // keep theirs; the dormancy rule is what eventually releases an absent player's.
    // ⚠️ If we do not know where they were, KEEP it rather than dropping it at the world origin. The holdings
    // then die with the socket as before — no worse than the old behaviour, and never wrong in a visible place.
    {
      const _key = playerKeyFor(socket.id);
      if (_key.startsWith('s:') && currentAvatarRoom) {
        const p = lastBodyPos(currentAvatarRoom, socket.id);
        if (p) try { releaseHoldings(currentAvatarRoom, _key, p.x, p.y); } catch (e) { console.log('ledger: release on leave failed: ' + e.message); }
      }
    }
    // ⚠️ ONLY THE ANONYMOUS RECORD IS DROPPED. A logged-in player's holdings stay in memory: a page navigation
    // is a new socket every single time, and re-reading from disk on each one would make the common case the
    // slow one. `forgetEphemeral` is a no-op for a `d:` key by design.
    ledger.forgetEphemeral(playerKeyFor(socket.id));
    if (currentRoom) {
      if (roomUsers[currentPresenceRoom]) delete roomUsers[currentPresenceRoom][socket.id];
      if (roomAvatars[currentRoom]) delete roomAvatars[currentRoom][socket.id];
      removeSimAvatar(currentRoom, socket.id);
      const voiceScope = socketVoiceScope[socket.id];
      if (voiceScope && roomVoice[voiceScope] && roomVoice[voiceScope][socket.id]) {
        delete roomVoice[voiceScope][socket.id];
        const voiceTarget = voiceScope === currentRoom ? currentRoom : 'voice:' + voiceScope;
        io.to(voiceTarget).emit('voice-peer-left', { id: socket.id });
        socket.leave('voice:' + voiceScope);
      }
      delete socketVoiceScope[socket.id];
      if (currentAvatarRoom && roomAvt[currentAvatarRoom] && roomAvt[currentAvatarRoom].delete(socket.id)) {
        socket.to(currentAvatarRoom).emit('avt-peer-left', { id: socket.id });
      }
      delete socketToAvatarRoom[socket.id];
      if (pageUsers[currentRoom]) delete pageUsers[currentRoom][socket.id];
      broadcastPresence(currentPresenceRoom);
      broadcastPagePresence(currentRoom);
      io.to(currentPageRoom).emit('cursor-leave', { id: socket.id });
      io.to(currentRoom).emit('avatar-leave', { id: socket.id });
    }
    // Phase 3/4 — release the residency claim and the subscription bookkeeping. OUTSIDE the `currentRoom` guard
    // above on purpose: both are keyed on the AVATAR room, which is a different key. The residency sweep prunes
    // dead sockets from roomWhere every 5s as a backstop, but roomSubs has no sweep of its own.
    if (currentAvatarRoom) {
      if (roomWhere[currentAvatarRoom]) roomWhere[currentAvatarRoom].delete(socket.id);
      dropSubs(currentAvatarRoom, socket.id);
      dropPeers(currentAvatarRoom, socket.id);
      dropRelay(currentAvatarRoom, socket.id);   // Phase 5a
    }
    wireBatchOk.delete(socket.id);
    if (socketDmRooms[socket.id]) {
      for (const roomId of socketDmRooms[socket.id]) {
        socket.to(roomId).emit('dm-user-left', { roomId, from: currentUsername });
      }
      delete socketDmRooms[socket.id];
    }
    delete socketToUsername[socket.id];
    // Friends: notify accepted friends this user went offline
    const dId = socketToDiscordId[socket.id];
    if (dId) {
      delete socketToDiscordId[socket.id];
      if (discordIdToFollowSockets[dId]) {
        discordIdToFollowSockets[dId].delete(socket.id);
        if (!discordIdToFollowSockets[dId].size) delete discordIdToFollowSockets[dId];
      }
      // Remove this tab from the leader's tab set. Debounced: same-tab navigation causes a
      // disconnect + reconnect with the same tabSession — wait briefly so the rejoin can cancel
      // the removal and avoid sending followers a spurious "tab gone" snapshot.
      const ts = socketToTabSession[socket.id];
      if (ts) {
        delete socketToTabSession[socket.id];
        const debounceKey = `${dId}:${ts}`;
        clearTimeout(tabDisconnectTimers[debounceKey]);
        tabDisconnectTimers[debounceKey] = setTimeout(() => {
          delete tabDisconnectTimers[debounceKey];
          if (!leaderTabs[dId] || !leaderTabs[dId].has(ts)) return; // already re-added by rejoin
          leaderTabs[dId].delete(ts);
          if (leaderActiveTab[dId] === ts) delete leaderActiveTab[dId];
          if (leaderTabs[dId].size === 0) { delete leaderTabs[dId]; delete leaderSnapshotSeq[dId]; delete leaderEpoch[dId]; }
          try { emitTabSnapshot(dId, currentUsername); } catch {}
        }, TAB_DISCONNECT_DEBOUNCE_MS);
      }
      if (discordIdToSocket[dId] === socket.id) {
        delete discordIdToSocket[dId];
        delete discordIdToFullUrl[dId];
        try {
          const fRows = db.prepare(
            `SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END as fid
             FROM friends WHERE (from_id=? OR to_id=?) AND status='accepted'`
          ).all(dId, dId, dId);
          fRows.forEach(r => {
            const fs = discordIdToSocket[r.fid];
            if (fs) io.to(fs).emit('friend-offline', { discord_id: dId });
          });
        } catch {}
      }
    }
    if (currentUsername) delete userCurrentFullUrl[currentUsername];
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));

// ⚠️ A BEST EFFORT, NOT THE MECHANISM. `restart-server.ps1` force-kills the process on Windows, where there is no
// signal to catch at all — so the periodic flush is what actually protects recent work, and this only helps a
// Ctrl+C or a clean stop. Uncapped on purpose: at shutdown there is no tick left to stall.
function worldFlushAll(why) {
  try { const n = worldFlush(1e9); if (n) console.log(`world persistence: flushed ${n} resident chunk(s) on ${why}`); }
  catch (e) { console.log('world flush on ' + why + ' failed: ' + e.message); }
  // ⚠️ THE LEDGER FLUSHES ON THE SAME SEAM AS THE WORLD, and it has to: its writes are debounced by seconds, so
  // a restart inside that window is a player's haul deleted. This is the same lesson the world persistence
  // already learned — eviction alone was not a sufficient write seam, because the ground you are STANDING on is
  // the one thing never saved.
  try { const n = ledger.flush(); if (n) console.log(`ledger: flushed ${n} player holding(s) on ${why}`); }
  catch (e) { console.log('ledger flush on ' + why + ' failed: ' + e.message); }
}
process.on('SIGTERM', () => {
  worldFlushAll('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
process.on('SIGINT', () => {
  worldFlushAll('SIGINT');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
