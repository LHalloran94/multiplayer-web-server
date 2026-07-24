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
const MWSim = require('./avatar-sim'); // shared authoritative avatar simulation

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
const TERRAIN_CELL = 24;
const TERRAIN_COLS = Math.ceil(MWSim.C.WORLD_W / TERRAIN_CELL);
const TERRAIN_ROWS = Math.ceil(MWSim.C.WORLD_H / TERRAIN_CELL);
const roomTerrain = {}; // room → Uint8Array(TERRAIN_COLS*TERRAIN_ROWS)
const roomTerrainHp = {}; // room → Uint8Array (per-cell remaining hits for multi-hit/strength>1 mats; 0 = n/a)
function ensureTerrain(room) { return roomTerrain[room] || (roomTerrain[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS)); }
function ensureTerrainHp(room) { return roomTerrainHp[room] || (roomTerrainHp[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS)); }
// Per-cell durability lookup. Built-ins are always breakable / instant (strength 1); customs (id>=16) read their def.
const BUILTIN_STRENGTH = { 2: 3, 4: 2, 5: 2, 17: 2 };  // stone tough, ice/mud/drain middling (matches client TERRAIN_MATS); others 1
function matStrengthSrv(mats, v) { if (v < CUSTOM_MAT_MIN) return BUILTIN_STRENGTH[v] || 1; const d = mats[v]; return d ? ((d.strength | 0) || 1) : 1; }
const BUILTIN_UNBREAKABLE = new Set([7, 13]);          // built-in conveyor belts are unbreakable (matches client TERRAIN_MATS)
function matBreakableSrv(mats, v) { if (v < CUSTOM_MAT_MIN) return !BUILTIN_UNBREAKABLE.has(v); const d = mats[v]; return !d || d.breakable !== false; }
// Carve one cell with breakable/strength semantics (mirrors the client's carveCellHp). Returns true if cleared.
// `hard` (the editor Carve tool) removes any cell outright; without it (gameplay slam) the rules apply.
function carveCellSrv(grid, hp, mats, i, hard) {
  const v = grid[i]; if (!v) return false;
  if (!hard) {
    if (!matBreakableSrv(mats, v)) return false;
    const s = matStrengthSrv(mats, v);
    if (s > 1) { let h = hp[i] || s; h--; if (h > 0) { hp[i] = h; return false; } }
  }
  grid[i] = 0; hp[i] = 0; return true;
}
function rasterTerrainCircle(grid, hp, mats, wx, wy, r, val, hard) {
  const c0 = Math.max(0, Math.floor((wx - r) / TERRAIN_CELL)), c1 = Math.min(TERRAIN_COLS - 1, Math.floor((wx + r) / TERRAIN_CELL));
  const r0 = Math.max(0, Math.floor((wy - r) / TERRAIN_CELL)), r1 = Math.min(TERRAIN_ROWS - 1, Math.floor((wy + r) / TERRAIN_CELL));
  const r2 = r * r; let changed = false;
  for (let ry = r0; ry <= r1; ry++) for (let cx = c0; cx <= c1; cx++) {
    const ccx = (cx + 0.5) * TERRAIN_CELL, ccy = (ry + 0.5) * TERRAIN_CELL;
    if ((ccx - wx) * (ccx - wx) + (ccy - wy) * (ccy - wy) > r2) continue;
    const i = ry * TERRAIN_COLS + cx;
    if (val) { if (grid[i] !== val) { grid[i] = val; changed = true; } hp[i] = matStrengthSrv(mats, val); }
    else if (carveCellSrv(grid, hp, mats, i, hard)) changed = true;
  }
  return changed;
}
// Axis-aligned square fill (the manual brush; r = half-extent). Carves/paints blocky, grid-aligned terrain.
function rasterTerrainSquare(grid, hp, mats, wx, wy, r, val, hard) {
  const c0 = Math.max(0, Math.floor((wx - r) / TERRAIN_CELL)), c1 = Math.min(TERRAIN_COLS - 1, Math.floor((wx + r) / TERRAIN_CELL));
  const r0 = Math.max(0, Math.floor((wy - r) / TERRAIN_CELL)), r1 = Math.min(TERRAIN_ROWS - 1, Math.floor((wy + r) / TERRAIN_CELL));
  let changed = false;
  for (let ry = r0; ry <= r1; ry++) for (let cx = c0; cx <= c1; cx++) {
    const ccx = (cx + 0.5) * TERRAIN_CELL, ccy = (ry + 0.5) * TERRAIN_CELL;
    if (Math.abs(ccx - wx) > r || Math.abs(ccy - wy) > r) continue;
    const i = ry * TERRAIN_COLS + cx;
    if (val) { if (grid[i] !== val) { grid[i] = val; changed = true; } hp[i] = matStrengthSrv(mats, val); }
    else if (carveCellSrv(grid, hp, mats, i, hard)) changed = true;
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
const isFluidId = (v) => LIQUID_IDS.has(v);
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
const roomLiquidSrc = {};
const roomSrcAdded = {};     // room → number[LIQ_T]: units this room's sources have created, per rank (ledger)
const roomSinkEaten = {};    // room → number[LIQ_T]: units this room's sinks have destroyed, per rank (ledger)
function ensureSrcMap(room) { return roomLiquidSrc[room] || (roomLiquidSrc[room] = new Map()); }
function srcLedger(room) { return roomSrcAdded[room] || (roomSrcAdded[room] = new Array(LIQ_T).fill(0)); }
function sinkLedger(room) { return roomSinkEaten[room] || (roomSinkEaten[room] = new Array(LIQ_T).fill(0)); }
function clearLiquidSources(room) { if (roomLiquidSrc[room]) roomLiquidSrc[room].clear(); }
function dropSource(room, i) { const s = roomLiquidSrc[room]; if (s && s.delete(i) && !s.size) delete roomLiquidSrc[room]; }
function dropSourcesInRect(room, c0, r0, c1, r1) {
  const s = roomLiquidSrc[room]; if (!s || !s.size) return;
  const gone = [];
  for (const i of s.keys()) { const r = (i / TERRAIN_COLS) | 0, c = i - r * TERRAIN_COLS; if (c >= c0 && c <= c1 && r >= r0 && r <= r1) gone.push(i); }
  for (const i of gone) s.delete(i);
  if (!s.size) delete roomLiquidSrc[room];
  if (gone.length) io.to(room).emit('liquid-src', { cells: gone, on: false });
}
let LIQUID_MAX = 64;                                  // TOTAL fill units per cell (= vertical "slices"). Runtime-tunable via liquidCfg.cellCap (rescales existing liquid); MUST stay ≤255 (Uint8 arrays/wire).
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
  ledgeSpill: true,      // step 1b: liquid spills DIAGONALLY over the edge of a ledge. off = it only falls straight down + spreads on flat ground
  lateralLevel: true,    // steps 1c/1d: liquid flows SIDEWAYS to find a flat level. off = it piles up where it lands (no spreading)
  perLiquidLevel: true,  // step 2c: each liquid flattens its OWN layer across columns (heavy ends flat along the bottom)
  viscosity: false,      // per-liquid LEVEL_VISC throttle: denser liquids ooze flat slower. off = ALL liquids level at full speed
  reactions: true,       // lava+water→stone, acid dissolves terrain, water+snow→ice, oil burns, etc.
  // ONE flag for the whole "make fallSide mean what it says" rule set (it is one idea; splitting it into
  // separate toggles just produced broken half-states). On, the tag obeys three rules:
  //   BIRTH  (1b) only a spill off a REAL ledge — solid underfoot. Blocked by full LIQUID = a pool surface
  //               spreading sideways, not a fall (tagged ~74% of a settling pool).
  //   WRITE  (1a/1b) only onto AIR or a cell that is already a stream. Never onto resting pool liquid —
  //               that stamped the stream's tag onto the cell it LANDS in, which then drew sideways.
  //   CLEAR  a cell that can't fall has settled, so it is not a stream: drop the tag.
  // off = the old loose behaviour. Pure annotation either way: sd never gates mass.
  streamTag: true,
  streamMix: true,        // a ledge spill draws its liquids PROPORTIONALLY (keeps the mixture) instead of heaviest-first → the lip oscillates less. off = heaviest-first spill (alternating slugs / pulsing sub-strips)
  streamNoSort: true,     // a tagged FALLING stream does NOT density-sort with the cell below (no buoyancy in free-fall). off = a lighter liquid climbs UP a denser stream (oil rises through water) + bubbles all the way down
  streamNoSortNbr: true,  // density sort skips a NEIGHBOUR cell that is a stream (sd[j]!==0), not just the cell's own tag. Stops the buoyancy sort floating a light liquid UP-and-OUT of a streaming/draining cell (e.g. a 1-cell gap) into an adjacent pool — the "oil crosses a 1-wide gap, water doesn't" case. off = only the cell's own tag gates buoyancy (streamNoSort)
  // ── DROPLET CASCADE (the streaming rewrite). ON = a ledge spill leaves the grid as droplets that carry the liquid and
  // deposit it on landing; OFF = the original fallSide tag / stream-strip path, kept intact for in-game comparison.
  // Tunings below are the values arrived at in the bench (scratchpad/liquid-droplet-stream.html).
  // The client half has landed (16b parses 'liquid-drops' and replays the fall locally), so this is on by default.
  // Turn it off to compare against the original fallSide/stream-strip path, which is untouched underneath.
  droplets: true,
  dropUnit: 2,           // target droplet size in liquid units (of LIQUID_MAX per cell)
  dropFall: 0.4,         // constant fall speed, cells per tick
  dropSpread: 1.0,       // ceiling on the width of the band droplets appear in, in cells
  dropSpreadFlow: true,  // only reach that ceiling when the flow warrants it
  dropSpawnH: 0,         // 0 = AT the source liquid's surface (default; the line then starts exactly at the pool) · 1 = halfway down the cell diagonally below
  dropWeir: true,        // spill from the SURFACE down (the top slice of the pool, so it carries the right mixture)
  dropStratify: true,    // space a tick's droplets evenly down the fall step rather than at random
  dropLandSpread: 2,     // CAP on how many cells either side a landing may fan across
  dropTermFall: 6,       // cells of fall to reach full impact force
  dropImpactCurve: 0.8,  // shape of the force build-up
  dropSpreadRef: 10,     // impact force needed per extra cell of spread
  // Reinstates the pre-2026-07-21 landing spread, which fanned into cells with ANY liquid beneath them rather than
  // requiring real support. That is what put liquid in mid-air over a 1-cell-wide step. Kept as a toggle because it
  // may not actually be harmful now: a target with nothing under it is handed to the CASCADE instead of being filled
  // in place, so the water falls from there as droplets exactly as it would off any other edge, rather than hanging.
  dropSpreadWide: false,
  // Droplets pack into columns growing OUTWARD from the ledge (nearest first) instead of scattering at random across
  // the band, so a trickle is single-file against the edge and the stream width reads its flow directly. See
  // spawnDroplets. off = the old random-within-the-band placement.
  dropEdgeFill: true,
  // Horizontal spacing between the columns droplets pack into, as a multiple of a droplet's own width. 1 = FLUSH
  // (columns touch), which is the default; higher spreads them apart across the band. The innermost column is always
  // flush with the wall the stream fell over regardless of this.
  dropColSpace: 1,
  // ⚠️ RETRACTED, 2026-07-22. There WAS a `dropFullTarget` flag here, to let a lip keep shedding droplets when the
  // cell it spills into is BRIM-FULL rather than dropping back to grid flow — because a lip was measured refusing on
  // 42% of ticks on a one-cell step. THAT MEASUREMENT WAS WRONG: the probe scene had silted up, so the target was
  // permanently full and the "refusals" were a full box, not a step. With a drain keeping the scene in steady flow the
  // lip sheds on 100% of ticks, and the flag measured INERT on both a one-cell step (spawn cov 0.11 either way) and a
  // staircase (0.29 vs 0.31) — while causing a real regression: a settled pool on uneven ground never came to rest,
  // because the lip shed into a full cell for ever. Reverted whole. Don't re-derive it: run scenes with a DRAIN.
  // (there is no lip hysteresis any more: it was removed with the submerged-edge fix, since a spill now requires a free
  //  surface AND a target with real room, which leaves nothing for it to bridge — and it was what let a submerged cell
  //  re-arm for ever. The flag lingered afterwards as a debug checkbox nothing read.)
  streamFullClear: false, // (experimental) a brim-full cell drops its stream tag → renders as bands + re-enables density sorting (full = pool, not stream). off = full cells keep streaming / side-by-side. TRADEOFF: on makes full chutes + fat streams slice/stratify
  // LEVELLING GATE — which cells are excluded from lateral levelling (1c/1d/2c) as "still falling". The old test (canFall)
  // also counted a cell that could shed DIAGONALLY over a nearby edge, so pool cells sitting at an edge never levelled →
  // the blocky/stair surface near drops. A cell is genuinely a STREAM only if it is TAGGED (a ledge spill, carried down)
  // or has straight-down room (a vertical drop the tag never marks). 0 = old canFall · 1 = tagged-or-straight-down (fixes
  // the blocky edge; keeps waterfalls from fanning) · 2 = tagged-ONLY (experiment: simplest, but untagged vertical drops fan).
  // ⚠️ MODE 2 IS INERT WHENEVER `droplets` IS ON: the cascade deliberately never writes a fall tag, so `sd[i] !== 0` is
  // never true and NO cell is held back from lateral levelling. Measured harmless (a vertical pour stays one cell wide
  // in all six droplets × levelGate combinations — scratchpad/probe_drop_levelgate.js), but it means this dial does
  // nothing in the shipped config; use mode 1 if you want a live gate to A/B against the blocky edge.
  levelGate: 3,   // (was 2) default set to tag-only 2026-07-19: modes 0/1/2 were visually indistinguishable in-browser → canFall was NOT the blocky-edge culprit (revisit if needed)
  symLevel: true,        // 1c surface flow sheds to BOTH lower neighbours from the SAME snapshot, aimed at the 3-cell average → no per-tick direction preference + no overshoot. off = the old alternating-direction sequential scan. (NOTE: this does NOT fix the oil/water slosh — that's levelMix below.)
  levelMix: true,        // lateral leveling (1c/1d) moves the MIXTURE proportionally (moveProp) instead of skimming the lightest liquid off the top (moveTop). Skimming oil each tick oil-depletes→oil-replenishes a surface cell in a period-2 cycle = THE oil/water slosh (probe: swing 0.69→0.00). off = moveTop (skims the top, sloshes). Stratification is kept by the density sorts, not by skimming.
  sortRate: 4,           // units the density sort swaps across an interface per tick (higher = liquids separate faster; capped by the mismatch)
  tickMs: 40,            // sim interval in ms — LOWER = faster real-time flow/leveling (but more CPU + network traffic). 40 ≈ 25 ticks/s
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
  // FINE-CELL LIQUID resolution (experimental). 1 = the coarse system, UNTOUCHED. 3 = a parallel 3×3-per-cell fine liquid
  // (fineLiquidTickRoom) in SEPARATE arrays, gated ON alongside the coarse one — same multi-liquid physics, smaller cells,
  // so thin streams get a real horizontal position. Inc 1 = pipeline (flow + wire + render); reactions/sources come next.
  sub: 1,
  // FINE: use the diagonal ledge spill (1b). OFF ⇒ rely on lateral levelling (1c) moving liquid into the edge cell + it
  // falling straight down (1a) next tick — same end state, one tick slower, no diagonal/geometry rule (a diagonal gap
  // between two solids is a sealed corner anyway). Fine-only so the coarse system is unaffected.
  fineLedge: true,
  // CELL CAPACITY = the number of vertical fill "slices" a cell holds (LIQUID_MAX). Higher = smoother/finer vertical fill;
  // must stay ≤255 (Uint8). Changing it RESCALES all existing liquid (a full cell stays full) + re-broadcasts. Global
  // (coarse + fine); at 64 the coarse system is unchanged. Stratification (sortRate units/tick) is proportionally slower higher.
  cellCap: 64,
};
// DEBUG perf accounting (only touched when liquidCfg.perfLog). `emitLiquidCells` centralises the `liquid-cells` emit so we
// can size the wire payload; runLiquidTick tallies sim time + active cells and prints a rolling ~1s summary to the console.
let liqPerf = { simMs: 0, simMsMax: 0, active: 0, bytes: 0, ticks: 0 };
function emitLiquidCells(room, arr) {
  if (liquidCfg.perfLog && arr.length) liqPerf.bytes += JSON.stringify(arr).length + 24;   // +~socket.io per-message framing
  io.to(room).emit('liquid-cells', { cells: arr });
}
const LIQUID_MS = 60;                                 // legacy default (the live rate is liquidCfg.tickMs)
// (LIQUID_FLOOR_ROW is derived inside liquidTickRoom because FLOOR_TOP is declared later in the file.)
const LIQUID_MAX_ACTIVE = 80000;                      // safety cap on tracked active cells per room
const LIQUID_MAX_PER_TICK = 9000;                     // process at most this many cells/room/tick (rest carry over)
const roomLiquidActive = {};                          // room → Set<cellIndex> of liquid cells worth simulating
const roomLiquidAmt = {};                             // room → Uint8Array(cells * LIQ_T): per-rank units (the multi-liquid stack)
const roomLiquidTotal = {};                           // room → Uint8Array(cells): Σ amt cache
// FALL SIDE (per liquid cell): which edge a falling parcel spilled off — 0 none/settled · 1 hug LEFT · 2 hug RIGHT. Set
// from the spill direction on a down-diagonal, CARRIED straight down on a vertical fall, cleared on settle/empty. History
// the client render can't reconstruct from one frame → the sim owns it + broadcasts it. Pure annotation, never mass.
const roomLiquidSide = {};
const SIDE_LEFT = 1, SIDE_RIGHT = 2;
// SECONDARY STREAM LANE (dual-stream chute): a 1-wide chute fed by streams from BOTH sides can't be one fall side, so a
// cell may carry a SECOND falling stream alongside the main one — its own liquid id + amount, hugging the opposite side.
// Only used for falling stream cells (rare); it falls independently and MERGES into the pool's main stack on landing.
// DROPLETS IN FLIGHT, per room. Each carries real liquid, so this is authoritative state, not decoration. Ballistic and
// non-interacting: a droplet's whole future follows from its spawn, which is what lets the client replay it from one event.
const roomDroplets = {};     // room → array of {id,x,y,rank,amt,dist,dir,vy}
const roomDropSeq = {};      // room → id counter
const roomDropSpawns = {};   // room → spawn events queued for this tick's broadcast
// room → Map(cell → decaying measure of how hard that spot is being rained on). A Map, not a full-grid array: only a
// handful of cells are ever under a fall, but the decay has to touch every entry each tick, and sweeping all 86,400
// cells for that cost 0.18ms/tick per room with any droplet in flight. The client already models it this way.
// What each cell RECEIVED from droplets this tick (cell -> units). Cleared at the start of every droplet pass.
// Liquid that has only just landed must spend a tick as a pool before it can flow onward: droplets fly BEFORE the
// grid ticks, so without this the grid levels fresh liquid sideways in the very tick it arrives, and water is never
// seen to land and pool -- it appears in the landing cell and its neighbours simultaneously. (The `dropStart` rule
// below already says exactly this for the lip; it was simply never applied to levelling.)
const roomDropLanded = {};
const roomImpact = {};
const roomStream2Amt = {};   // room → Uint8Array(cells): units in the secondary lane (0 = none)
const roomStream2Id = {};    // room → Uint8Array(cells): the secondary lane's liquid id
// FLOW (display-twice): per-cell units that FELL INTO this cell this tick — the INCOMING STREAM's thickness, DISTINCT from the
// pooled total. Tracked PER SIDE (flowL = liquid that arrived hugging the LEFT wall, flowR = the RIGHT), because a cell can be
// fed from BOTH sides at once (a chute) and each lip/strip must match ONLY its own side's inflow, not the combined width. A
// STRAIGHT-DOWN fall (fallSide 0) contributes to NEITHER — it just pools, no incoming strip (streams are only ever side-aligned,
// never centred). Reset at the start of each cell's processing; cells above accumulate their inflow later (bottom-up). Never mass.
// Stored PER-RANK (× LIQ_T) so the incoming strip shows the SOURCE's full composition (what LEFT the source, continuous with
// the fall), not just its dominant and not the pool it lands in. Distributed by the source's proportion so a mixed stream
// keeps its mix. flowL total (strip width) = Σ of the 6 ranks.
// SATURATION (terrain reactions): absorbent solids (earth/sand) soak up adjacent water into a per-cell accumulator (0..SAT_MAX).
// Earth → Mud at saturation (cell-by-cell); saturated Sand → Quicksand once part of a wet CLUMP; Mud dries back to Earth as its
// saturation decays away from water (instant under lava). Internal only — clients see the resulting grid changes, not the value.
const roomSat = {};          // room → Uint8Array(cells): absorbed-water units per absorbent/wet solid cell
// ACID NEUTRALISATION — SATURATION model (tuned in the harness): acid SOAKS UP water (consuming it) into a per-cell dilution
// accumulator, and only once saturated (dilution ≥ acid·K) does the acid CONVERT to water — both rate-limited, so a drop can't
// clear a pool and it's never instant. Water is consumed (volume drops), which is the accepted tradeoff for "limited water".
const roomDilute = {};       // room → Float32Array(cells): water soaked into an acid cell, awaiting conversion (fractional → K can be non-integer)
function ensureDilute(room) { return roomDilute[room] || (roomDilute[room] = new Float32Array(TERRAIN_COLS * TERRAIN_ROWS)); }
const ACID_K = 1.5;          // water soaked (consumed) to saturate + convert 1 acid unit
const ACID_SOAK_TICKS = 2;   // soak 1 water into dilution every N ticks (rate ≈ 1/N ≈ 0.5/tick)
const ACID_CONVERT_TICKS = 2;// convert 1 acid → water every N ticks once saturated (rate ≈ 0.5/tick)
let liquidTickCount = 0;
let liquidQuiet = false;                              // when true, the sim runs but suppresses broadcasts (used to pre-settle at gen time)
function ensureLiquidAmt(room) { return roomLiquidAmt[room] || (roomLiquidAmt[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS * LIQ_T)); }
function ensureLiquidTotal(room) { return roomLiquidTotal[room] || (roomLiquidTotal[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS)); }
function ensureLiquidSide(room) { return roomLiquidSide[room] || (roomLiquidSide[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS)); }
// Per-cell LEVELING carry (reduced-amount density throttle): holds the SUB-UNIT remainder of each throttled leveling move so
// a fractional per-tick amount still adds up to whole units over time (see `reduce` in liquidTickRoom). Sub-unit (<1/LIQUID_MAX
// of a cell) so it's never visible; seeded with a small per-cell phase so the invisible 1-unit fine steps don't all align.
const roomLevelAcc = {};
function ensureLevelAcc(room) { if (!roomLevelAcc[room]) { const a = new Float32Array(TERRAIN_COLS * TERRAIN_ROWS); for (let i = 0; i < a.length; i++) a[i] = ((Math.imul(i, 2654435761)) >>> 0) / 4294967296; roomLevelAcc[room] = a; } return roomLevelAcc[room]; }
// ── FINE-CELL LIQUID (experimental, gated by liquidCfg.sub) — a parallel liquid grid at SUB× resolution, in SEPARATE
// arrays so the coarse system is UNTOUCHED. Same layout as the coarse arrays but sized FCOLS*FROWS. Terrain is read from
// the coarse grid via coarseOf() (map-on-read; the fine sim never writes terrain), and liquid lives only in these arrays.
const roomFineAmt = {}, roomFineTotal = {}, roomFineSide = {}, roomFineActive = {}, roomFineLevelAcc = {}, roomFineSub = {};
function ensureFineArrays(room, SUB) {
  const cells = (TERRAIN_COLS * SUB) * (TERRAIN_ROWS * SUB);
  if (roomFineSub[room] !== SUB || !roomFineAmt[room] || roomFineTotal[room].length !== cells) {
    roomFineSub[room] = SUB;
    roomFineAmt[room] = new Uint8Array(cells * LIQ_T);
    roomFineTotal[room] = new Uint8Array(cells);
    roomFineSide[room] = new Uint8Array(cells);
    const la = new Float32Array(cells); for (let i = 0; i < cells; i++) la[i] = ((Math.imul(i, 2654435761)) >>> 0) / 4294967296; roomFineLevelAcc[room] = la;
    if (!roomFineActive[room]) roomFineActive[room] = new Set();
  }
  return roomFineAmt[room];
}
function fineSet(room) { return roomFineActive[room] || (roomFineActive[room] = new Set()); }
// scratch for the flux-levelling flood fill (reused per room so the pass allocates nothing per tick)
const roomFluxSeen = {}, roomFluxStack = {};
function ensureFluxSeen(room) { return roomFluxSeen[room] || (roomFluxSeen[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS)); }
function ensureFluxStack(room) { return roomFluxStack[room] || (roomFluxStack[room] = new Int32Array(TERRAIN_COLS * TERRAIN_ROWS)); }
// `isSolid` inside liquidTickRoom is a closure over that call; the droplet functions run outside it and need their own.
const isSolidCell = (v) => v !== 0 && !isFluidId(v);
const DROP_MAX = 4000;       // hard ceiling on droplets in flight per room, so a pathological pour cannot run away
function ensureDroplets(room) { return roomDroplets[room] || (roomDroplets[room] = []); }
// A landing writes into cells outside the liquid tick, so those cells need broadcasting in the same wire format the
// main loop uses. Kept to exactly that format so the client has one parser, not two.
function dropletBroadcastCells(room, cells) {
  const amt = ensureLiquidAmt(room), grid = roomTerrain[room], sd = ensureLiquidSide(room);
  const s2a = ensureStream2Amt(room), s2i = ensureStream2Id(room), T = LIQ_T;
  if (!grid) return;
  let arr = [], n = 0;
  for (const j of cells) {
    const b = j * T; let mask = 0; for (let rk = 0; rk < T; rk++) if (amt[b + rk] > 0) mask |= (1 << rk);
    const rep = liqRepId(amt, j);
    if (!isSolidCell(grid[j]) && rep && grid[j] !== rep) { grid[j] = rep; }
    const hasS2 = s2a[j] > 0;
    arr.push(j, grid[j], (sd[j] & 0x03) | (hasS2 ? 0x80 : 0), mask);
    for (let rk = 0; rk < T; rk++) if (mask & (1 << rk)) arr.push(amt[b + rk]);
    if (hasS2) arr.push(s2a[j], s2i[j]);
    if (++n >= 8192) { emitLiquidCells(room, arr); arr = []; n = 0; }
  }
  if (n) emitLiquidCells(room, arr);
}
// SOURCE PASS — top every source cell back up. Runs BEFORE the droplets and the grid each tick, so liquid a source
// makes is ordinary pooled liquid by the time anything looks at it (it spends a tick in the cell like any other
// arrival). A source cell whose grid square has been built over with a SOLID is deleted: that is how you remove one.
// It does NOT require the cell to currently hold liquid — a fully drained source must still refill, and a drained
// cell reads as air.
function sourceTickRoom(room) {
  const src = roomLiquidSrc[room]; if (!src || !src.size) return;
  if (liquidCfg.sub > 1) return sourceTickRoomFine(room, roomFineSub[room] || liquidCfg.sub);   // fine mode: top up the fine block
  const grid = roomTerrain[room]; if (!grid) return;
  const amt = ensureLiquidAmt(room), tot = ensureLiquidTotal(room), led = srcLedger(room);
  const touched = [];
  for (const [i, s] of src) {
    if (i < 0 || i >= grid.length || isSinkId(grid[i]) || isSolidCell(grid[i])) { src.delete(i); continue; }
    const rank = s.rank | 0;
    const rate = Math.max(0, Math.min(LIQUID_MAX, (s.rate === undefined ? liquidCfg.srcRate : s.rate) | 0));
    if (!rate) continue;
    const free = LIQUID_MAX - tot[i]; if (free <= 0) continue;
    const add = free < rate ? free : rate;
    amt[i * LIQ_T + rank] += add; tot[i] += add; led[rank] += add;
    const rep = liqRepId(amt, i); if (rep && grid[i] !== rep) grid[i] = rep;
    activateLiquidCell(room, i, grid);
    touched.push(i);
  }
  if (!src.size) delete roomLiquidSrc[room];
  // Broadcast here rather than leaving it to liquidTickRoom: a source feeding a cell that is already brim-full moves
  // nothing, so the grid tick would have nothing to report and the client would never see the top-up.
  if (touched.length && !liquidQuiet) dropletBroadcastCells(room, touched);
}
function ensureImpact(room) { return roomImpact[room] || (roomImpact[room] = new Map()); }
function clearDroplets(room) { roomDroplets[room] = []; if (roomImpact[room]) roomImpact[room].clear(); }
function ensureStream2Amt(room) { return roomStream2Amt[room] || (roomStream2Amt[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS)); }
function ensureStream2Id(room) { return roomStream2Id[room] || (roomStream2Id[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS)); }
function liquidSet(room) { return roomLiquidActive[room] || (roomLiquidActive[room] = new Set()); }
function activateLiquidCell(room, i, grid) { if (i >= 0 && i < grid.length && isFluidId(grid[i])) { const s = liquidSet(room); if (s.size < LIQUID_MAX_ACTIVE) s.add(i); } }
// ---- GRANULAR POWDER (sand 3, snow 8) — SOLID cells that fall + pile like a classic falling-sand CA, distinct from the
// liquid-leveling flow. A grain moves DOWN or DOWN-DIAGONAL only (→ ~45° angle of repose / piling), NEVER sideways (so it
// piles instead of leveling flat). Meeting a liquid cell = SWAP: the grain sinks a cell and that cell's whole liquid stack
// bubbles up into the vacated cell → grains sink through liquid to the floor, mass-conserved for both. Powder cells stay
// real solids (dig / collision / render unchanged); movement broadcasts over the existing `liquid-cells` wire (it already
// carries arbitrary gridId changes — the client sets grid+hp from it). Only PLAYER edits (paint/dig) + cascades wake powder,
// so generated worlds keep their designed shape until disturbed. Validated in scratchpad/powder_sim.js (18/18, fuzz 40/40).
const isPowderId = (v) => v === 3 || v === 8;
const roomPowderActive = {};                          // room → Set<cellIndex> of powder cells that might still move
let powderTickCount = 0;                               // ticked in lockstep with the liquid sim → grains fall at the same gravity speed
function powderSet(room) { return roomPowderActive[room] || (roomPowderActive[room] = new Set()); }
// Wake powder in + just above a rect after a terrain edit: a dig removes support (grains above cascade down), a paint drops
// unsupported grains. The r0-1 margin seeds the cascade — each moving grain then wakes the one above it.
function activatePowderRect(room, grid, c0, r0, c1, r1) {
  c0 = Math.max(0, c0); r0 = Math.max(0, r0 - 1); c1 = Math.min(TERRAIN_COLS - 1, c1); r1 = Math.min(TERRAIN_ROWS - 1, r1);
  const s = powderSet(room);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const i = r * TERRAIN_COLS + c; if (isPowderId(grid[i])) s.add(i); }
  if (!s.size) delete roomPowderActive[room];
}
// SATURATION tuning (terrain reactions). SAT_MAX ≈ "a cell's worth" of water; ABSORB per absorb-tick; DRY per soil-tick when
// away from water; a saturated sand cell needs ≥ CLUMP saturated-sand/quicksand neighbours to turn (keeps beach edges dry).
const SAT_MAX = 12, SAT_ABSORB = 4, SAT_DRY = 1, SAT_CLUMP_MIN = 3;   // low SAT_MAX: earth saturates fast + absorbs little water → flow barely slowed, pre-gen lakes barely shrink
function ensureSat(room) { return roomSat[room] || (roomSat[room] = new Uint8Array(TERRAIN_COLS * TERRAIN_ROWS)); }
const roomSoilActive = {};                            // room → Set<cellIndex> of absorbent/wet solid cells worth ticking (earth/sand soaking, mud drying)
function soilSet(room) { return roomSoilActive[room] || (roomSoilActive[room] = new Set()); }
// Seed the soil set so soilTickRoom processes absorption/drying around water. Called on PAINT and at GEN (not just when a
// water cell happens to be "active") → placement + pre-generated lakes reliably + consistently start absorbing.
function seedSoilAround(room, grid, i) {
  const nn = grid.length, COLS = TERRAIN_COLS, c = i % COLS, N = [i - COLS, i + COLS, c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1];
  const g = grid[i];
  if (g === 9) { const ss = soilSet(room); for (const j of N) { if (j < 0 || j >= nn) continue; const gj = grid[j]; if (gj === 1 || gj === 3 || gj === 5) ss.add(j); } }         // water → seed absorbent neighbours
  else if (g === 1 || g === 3 || g === 5) { for (const j of N) if (j >= 0 && j < nn && grid[j] === 9) { soilSet(room).add(i); return; } }                                        // absorbent solid placed by water → seed itself
}
// Set a cell to a single full-CAP liquid `id` (paint / gen / seed). Clears the other layers.
function liqSetSingle(room, i, id) { const amt = ensureLiquidAmt(room), tot = ensureLiquidTotal(room), base = i * LIQ_T; for (let k = 0; k < LIQ_T; k++) amt[base + k] = 0; amt[base + LIQ_RANK[id]] = LIQUID_MAX; tot[i] = LIQUID_MAX; ensureStream2Amt(room)[i] = 0; ensureStream2Id(room)[i] = 0; }
function liqClearCell(room, i) { const amt = ensureLiquidAmt(room), tot = ensureLiquidTotal(room), base = i * LIQ_T; for (let k = 0; k < LIQ_T; k++) amt[base + k] = 0; tot[i] = 0; ensureLiquidSide(room)[i] = 0; ensureStream2Amt(room)[i] = 0; ensureStream2Id(room)[i] = 0; }
// Representative id (heaviest present) for grid[i], or 0 if the cell holds no liquid.
function liqRepId(amt, i) { const base = i * LIQ_T; for (let rk = 0; rk < LIQ_T; rk++) if (amt[base + rk] > 0) return LIQ_ID[rk]; return 0; }
// Wake + seed every cell in a rect after a terrain edit: a freshly PAINTED fluid becomes a full single-liquid stack, a
// CARVED-away fluid is cleared, and any surviving fluid is re-activated so it can flow.
function activateLiquidRect(room, grid, c0, r0, c1, r1) {
  if (liquidCfg.sub > 1) { fineActivateRect(room, grid, c0, r0, c1, r1); return; }   // fine mode: seed the fine grid, not the coarse one
  c0 = Math.max(0, c0); r0 = Math.max(0, r0); c1 = Math.min(TERRAIN_COLS - 1, c1); r1 = Math.min(TERRAIN_ROWS - 1, r1);
  const s = liquidSet(room), tot = ensureLiquidTotal(room), amt = ensureLiquidAmt(room);
  // Seed a painted fluid cell to a full single-liquid stack when it's empty OR its layers don't match the painted id
  // (painting a NEW liquid over an existing pool must REPLACE it — otherwise grid says brine but the layers stay water and
  // the tick syncs grid back to water: the placed liquid "turns to water" and sits inert). A same-liquid partial cell
  // (layers already match grid) is left untouched so waking around an edit doesn't reset legitimate partial fills.
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const i = r * TERRAIN_COLS + c;
    if (isFluidId(grid[i])) { if (!tot[i] || liqRepId(amt, i) !== grid[i]) liqSetSingle(room, i, grid[i]); if (s.size < LIQUID_MAX_ACTIVE) s.add(i); } else liqClearCell(room, i); }
  // seed absorption around the edit (+1 margin so painting water beside earth, OR earth beside water, both start absorbing)
  for (let r = Math.max(0, r0 - 1); r <= Math.min(TERRAIN_ROWS - 1, r1 + 1); r++) for (let c = Math.max(0, c0 - 1); c <= Math.min(TERRAIN_COLS - 1, c1 + 1); c++) seedSoilAround(room, grid, r * TERRAIN_COLS + c);
}
// After generation: every fluid grid cell becomes a full single-liquid stack + wakes (they settle in a few ticks).
function seedLiquidActivity(room) {
  const grid = roomTerrain[room]; if (!grid) return;
  const s = liquidSet(room);
  for (let i = 0; i < grid.length; i++) { if (isFluidId(grid[i])) { liqSetSingle(room, i, grid[i]); if (s.size < LIQUID_MAX_ACTIVE) s.add(i); } else liqClearCell(room, i); }
  for (let i = 0; i < grid.length; i++) if (grid[i] === 9) seedSoilAround(room, grid, i);   // pre-generated lakes absorb just like poured water (no special-casing)
  if (!s.size) delete roomLiquidActive[room];
  if (liquidCfg.sub > 1) upscaleRoomToFine(room, liquidCfg.sub);   // fine mode: hand the generated lakes to the fine grid
}
// Join replay: the full multi-liquid state as a flat list (same mask encoding as the live liquid-cells wire, side 0) for
// every cell that holds liquid. (Per-cell, not RLE — fine for the ~2k fluid cells a generated world has.)
function buildLiquidInit(room) {
  const amt = roomLiquidAmt[room], tot = roomLiquidTotal[room], grid = roomTerrain[room]; if (!amt || !tot || !grid) return [];
  const s2a = ensureStream2Amt(room), s2i = ensureStream2Id(room);
  const cells = [];
  for (let i = 0; i < tot.length; i++) { const hasS2 = s2a[i] > 0; if (tot[i] <= 0 && !hasS2) continue; const b = i * LIQ_T; let mask = 0; for (let rk = 0; rk < LIQ_T; rk++) { if (amt[b + rk] > 0) mask |= (1 << rk); } cells.push(i, grid[i], (hasS2 ? 0x80 : 0), mask); for (let rk = 0; rk < LIQ_T; rk++) if (mask & (1 << rk)) cells.push(amt[b + rk]); if (hasS2) cells.push(s2a[i], s2i[i]); }
  return cells;
}
// Each cell's total at the START of the tick. A lip may only shed what it already held: the scan is sequential and moves
// apply immediately, so without this the neighbour levels in and it leaves over the edge in the SAME tick — liquid never
// spends a tick at the lip, so the lip renders empty and its throughput is unbounded. Droplet path only, so the original
// flow is untouched when liquidCfg.droplets is off.
let dropStart = null;

// ---- DROPLET CASCADE -----------------------------------------------------------------------------
// Spawn: the batch that just left a lip. Each rank gets its own sub-band across the fall, heaviest packed against the
// ledge so the same liquid hugs it the whole way down; droplets are spaced evenly down the distance the stream covers
// this tick so consecutive ticks tile instead of clumping into packets.
function spawnDroplets(room, i, r, c, dc, took, taken) {
  const drops = ensureDroplets(room), tot = ensureLiquidTotal(room), amt = ensureLiquidAmt(room);
  const grid = roomTerrain[room], COLS = TERRAIN_COLS, CELL = TERRAIN_CELL, T = LIQ_T, cap = LIQUID_MAX;
  // Every bail-out has to happen BEFORE the grid is touched. Removing the liquid first and then refusing to spawn is a
  // silent mass leak, and at the droplet cap it would be a large one.
  if (drops.length > DROP_MAX) return false;
  const fallPx = liquidCfg.dropFall * CELL, faceX = dc > 0 ? (c + 1) * CELL : c * CELL, dropCol = c + dc;
  // Spawn at the surface of what REMAINS here, slid toward the drop by dropSpawnH. `tot[i]` is still the PRE-spill
  // total at this point — only `amt[]` is decremented below, and the caller recomputes `tot` after we return — so the
  // spill has to be subtracted by hand. Using the pre-spill surface put droplets ~4px above the liquid actually left
  // behind, which is what made the top of a fall look detached from its source (measured in probe_drop_audit).
  const surfAfter = r + 1 - Math.max(0, tot[i] - taken) / cap;
  const syTop = Math.max(r * CELL, Math.min((r + 1) * CELL - 0.5, surfAfter * CELL));
  const sy = syTop + liquidCfg.dropSpawnH * ((r + 1.5) * CELL - syTop);
  // the band only widens to a full cell on a strong spill, and never past the column we pour into
  const autoW = CELL * Math.min(1, taken / (cap * 0.16));
  const band = liquidCfg.dropSpreadFlow ? Math.min(liquidCfg.dropSpread * CELL, autoW) : liquidCfg.dropSpread * CELL;
  const FLOOR_ROW = Math.min(TERRAIN_ROWS, Math.floor(FLOOR_TOP / TERRAIN_CELL));
  let solidY = FLOOR_ROW * CELL;
  for (let rr = r; rr < FLOOR_ROW; rr++) if (isSolidCell(grid[rr * COLS + dropCol])) { solidY = rr * CELL; break; }
  let nTotal = 0;
  for (let k = 0; k < T; k++) if (took[k] >= 1) nTotal += Math.max(1, Math.round(took[k] / liquidCfg.dropUnit));
  if (!nTotal) return false;
  for (let k = 0; k < T; k++) if (took[k] > 0) amt[i * T + k] -= took[k];   // committed: the droplets below WILL exist
  let idx = 0, cum = 0;
  const seq = roomDropSeq[room] || (roomDropSeq[room] = { n: 1 });
  const out = roomDropSpawns[room] || (roomDropSpawns[room] = []);
  // EDGE-FILL placement. Droplets pack into vertical COLUMNS that grow OUTWARD from the ledge face, nearest column
  // filled first; a new column only opens once the near ones hold their share. So a trickle is a single file hugging
  // the edge (continuous with the pool it left) and the stream WIDTH is a direct readout of the flow rate — no random
  // horizontal scatter. Ranks are emitted heaviest-first, so the heaviest liquid takes the inner columns (hugs the
  // ledge) and lighter liquids sit outside it. `dropEdgeFill` off = the old random-within-the-band placement.
  const repSide = CELL * Math.sqrt(Math.max(1, liquidCfg.dropUnit) / cap);   // nominal droplet size, for column geometry
  const ySpan0 = Math.max(repSide, Math.min(fallPx, solidY - sy - repSide));
  const perCol = Math.max(1, Math.round(ySpan0 / Math.max(2, repSide)));     // droplets that stack down one column's fall step
  const laneCols = Math.max(1, Math.floor(band / repSide) + 1);              // columns that fit in the allowed band
  const colsUsed = Math.max(1, Math.min(laneCols, Math.ceil(nTotal / perCol)));
  const perColD = Math.max(1, Math.ceil(nTotal / colsUsed));                 // droplets assigned to each column
  for (let k = 0; k < T; k++) {
    const a = took[k]; if (a < 1) continue;
    const nk = Math.max(1, Math.round(a / liquidCfg.dropUnit));
    const f0 = cum / taken, f1 = (cum + a) / taken; cum += a;
    // integer split that sums EXACTLY to `a` — each droplet takes an even share of what is left
    let left = a;
    for (let q = 0; q < nk; q++) {
      const each = Math.floor(left / (nk - q));
      left -= each;
      if (each < 1) continue;
      const side = CELL * Math.sqrt(each / cap);
      const lane = Math.max(0.1, Math.min(band, CELL - side));
      const yJit = Math.max(0, Math.min(fallPx, solidY - sy - side));
      let px, py;
      if (liquidCfg.dropEdgeFill) {
        const col = Math.min(colsUsed - 1, Math.floor(idx / perColD));       // which column out from the edge
        const vN = Math.min(perColD, nTotal - col * perColD);                // droplets actually in this column
        const vs = idx - col * perColD;                                      // slot within it
        const off = Math.min(lane, col * repSide * Math.max(0, liquidCfg.dropColSpace));   // column pitch = width × spacing; clamp to the band
        const slot = liquidCfg.dropStratify ? (vs + 0.5) / vN : Math.random();
        px = faceX + dc * (side * 0.5 + off); py = sy + slot * yJit;
      } else {
        const f = f0 + Math.random() * (f1 - f0);
        const slot = liquidCfg.dropStratify ? (idx + 0.5 + (Math.random() - 0.5) * 0.5) / nTotal : Math.random();
        px = faceX + dc * (side * 0.5 + f * lane); py = sy + slot * yJit;
      }
      idx++;
      const id = seq.n = (seq.n + 1) & 0xffff;
      drops.push({ id, x: px, y: py, rank: k, amt: each, dist: 0, dir: dc });
      // the spawn event is all a client needs: the fall is ballistic, so it replays the rest itself
      out.push(id, Math.round(px), Math.round(py), k, each, dc > 0 ? 1 : 0);
    }
  }
  return true;
}

// Impact FORCE, not just mass. Fall speed is constant, so it carries no information about how far the water dropped, and
// a splash off a one-cell step should be nothing like one off a cliff. Saturates at dropTermFall.
function dropImpactVel(dist) {
  return Math.min(1, Math.pow(Math.min(1, dist / (liquidCfg.dropTermFall * TERRAIN_CELL)), liquidCfg.dropImpactCurve));
}

// One tick of flight for every droplet in a room: straight down at constant speed, swept cell by cell so nothing can
// tunnel, merged into the first thing it touches. It deposits and marks the cell ACTIVE, and the existing reaction pass
// then handles lava+water to stone, acid neutralising and the rest -- no reaction logic is duplicated here.
function dropletTickRoom(room) {
  const drops = roomDroplets[room];
  // Clear the just-landed record FIRST, before any early return. It gates levelling for one tick, so leaving stale
  // entries in it when the droplets stop permanently freezes those cells out of levelling -- the landing cell sat at
  // 45 units for ever while its neighbours held 4.
  const landedPrev = roomDropLanded[room];
  if (landedPrev && landedPrev.size) landedPrev.clear();
  if (!drops || !drops.length) return;
  const grid = roomTerrain[room]; if (!grid) { roomDroplets[room] = []; return; }
  const amt = ensureLiquidAmt(room), tot = ensureLiquidTotal(room), impact = ensureImpact(room);
  const COLS = TERRAIN_COLS, CELL = TERRAIN_CELL, T = LIQ_T, cap = LIQUID_MAX;
  // The world floor is VIRTUAL: the grid sim refuses to descend past LIQUID_FLOOR_ROW rather than there being a solid
  // there. Droplets must honour the same bound or they fall straight through the bedrock and out of the world, which
  // silently destroys liquid (caught by the fuzz mass check).
  const ROWS = Math.min(TERRAIN_ROWS, Math.floor(FLOOR_TOP / TERRAIN_CELL));
  const active = liquidSet(room), changed = new Set();
  const landed_ = roomDropLanded[room] || (roomDropLanded[room] = new Map());
  for (const [k, v] of impact) { const n = v * 0.82; if (n > 0.01) impact.set(k, n); else impact.delete(k); }
  const step = liquidCfg.dropFall * CELL;
  const sub = Math.max(1, Math.ceil(step / (CELL * 0.5)));
  const surfaceY = (rr, ci) => (rr + 1 - tot[ci] / cap) * CELL;
  const recompCell = (ci) => { const b = ci * T; let sum = 0; for (let k = 0; k < T; k++) sum += amt[b + k]; tot[ci] = sum; };
  const keep = [], spawnedHere = [];   // droplets created DURING this pass (dropSpreadWide) — merged in at the end
  for (const d of drops) {
    // CLAMPED, never skipped. A droplet always spawns inside the world, so this cannot bind — but `continue` here
    // would drop the droplet and destroy the liquid it carries, and a silent mass leak is not worth leaving armed.
    const cc = Math.min(COLS - 1, Math.max(0, Math.floor(d.x / CELL)));
    let landed = false, hit = -1;
    for (let sIdx = 0; sIdx < sub && !landed; sIdx++) {
      const ny = d.y + step / sub, rr = Math.floor(ny / CELL);
      // THE WORLD FLOOR IS A GATE, NOT A SOLID: `grid[]` is air down there and the grid sim simply refuses to descend
      // past it. So a droplet used to pass through the last legal row whenever it was empty and get discarded here —
      // destroying its liquid, and destroying precisely the first arrivals that would have formed the pool to catch
      // the rest. Measured: 98% of a cliff pour into the open bottom of the world vanished. Land on it instead, which
      // is what the grid does, and the normal landing path below deposits into row ROWS-1.
      if (rr >= ROWS) { landed = true; break; }
      if (rr < 0) { d.y = ny; d.dist += step / sub; continue; }
      const j = rr * COLS + cc;
      if (isSolidCell(grid[j])) { landed = true; break; }
      if (tot[j] > 0 && ny >= surfaceY(rr, j)) { landed = true; hit = j; break; }
      d.y = ny; d.dist += step / sub;
    }
    if (!landed) { keep.push(d); continue; }
    const rr0 = hit >= 0 ? Math.floor(hit / COLS) : Math.max(0, Math.min(ROWS - 1, Math.floor(d.y / CELL)));
    const ci0 = rr0 * COLS + cc;
    const force = impact.get(ci0) || 0;
    const radius = Math.max(0, Math.min(liquidCfg.dropLandSpread | 0, Math.floor(force / liquidCfg.dropSpreadRef)));
    // Water arriving on a surface spreads across it. Candidates fan outward along the landing row and the row below,
    // stopping at any solid (never reaching through a wall) and never into an unsupported cell (so it cannot leave
    // liquid hanging). Reach follows from the impact force, so a one-cell drop barely spreads at all.
    // REAL support only. This used to accept `tot[b] > 0` — any liquid at all beneath the target, even a single unit.
    // On a staircase whose treads are ONE CELL WIDE that is nearly always true of the cell out over the next drop, so
    // a landing fanned sideways into what is effectively mid-air, and the deposit was broadcast before the grid tick
    // could let it fall. That is the long-standing "liquid pools in mid-air", and it is why the bug tracked the WIDTH
    // of a step rather than its height: a wider tread puts solid under the cells the spread reaches.
    // Measured on a 1-cell staircase: mid-air liquid at broadcast 127 units → 0, unsupported deposits 35% → 0%, and
    // no droplet stalls as a result (zero either way). Wider treads are unchanged.
    const supported = (ci) => { const r2 = (ci / COLS) | 0; if (r2 + 1 >= ROWS) return true; const b = ci + COLS; return isSolidCell(grid[b]) || tot[b] >= cap; };
    const cands = [], airTargets = [];
    if (!isSolidCell(grid[ci0])) cands.push(ci0);
    for (let dd = 1; dd <= radius; dd++) for (const sgn of [-1, 1]) {
      const c2 = cc + sgn * dd; if (c2 < 0 || c2 >= COLS) continue;
      let blocked = false;
      for (let k = 1; k <= dd; k++) if (isSolidCell(grid[rr0 * COLS + cc + sgn * k])) { blocked = true; break; }
      if (blocked) continue;
      const sideCi = rr0 * COLS + c2;
      // dropSpreadWide: reach a neighbour even with nothing under it — but then do NOT fill it in place. An
      // unsupported target is water arriving at an edge, so it is handed straight to the cascade and falls from
      // there as droplets, exactly as it would off any other edge. That keeps the wider reach without the thing
      // that made it wrong, which was liquid being parked in the air.
      if (!isSolidCell(grid[sideCi])) {
        if (supported(sideCi)) cands.push(sideCi);
        else if (liquidCfg.dropSpreadWide) airTargets.push(sideCi);
      }
      const downCi = sideCi + COLS;
      if (rr0 + 1 < ROWS && !isSolidCell(grid[downCi]) && supported(downCi)) cands.push(downCi);
    }
    let rem = d.amt;                                            // integer units
    for (let pass = 0; pass < 4 && rem > 0; pass++) {
      const open = cands.filter((ci) => cap - tot[ci] >= 1);
      if (!open.length) break;
      const share = Math.max(1, Math.floor(rem / open.length));
      for (const ci of open) {
        if (rem <= 0) break;
        const take = Math.min(cap - tot[ci], share, rem);
        if (take >= 1) { amt[ci * T + d.rank] += take; recompCell(ci); rem -= take; changed.add(ci); active.add(ci); landed_.set(ci, (landed_.get(ci) || 0) + take); }
      }
    }
    // dropSpreadWide: whatever the supported cells could not take goes to the unsupported neighbours as NEW DROPLETS,
    // spawned at the top of that cell so they fall from there. Mass is only ever removed here by being handed to a
    // droplet that exists, so this cannot leak.
    if (rem >= 1 && airTargets.length) {
      const seq = roomDropSeq[room] || (roomDropSeq[room] = { n: 1 });
      const out = roomDropSpawns[room] || (roomDropSpawns[room] = []);
      const each = Math.floor(rem / airTargets.length);
      for (const ci of airTargets) {
        if (rem < 1) break;
        const give = Math.min(rem, Math.max(1, each));
        const r2 = (ci / COLS) | 0, c2 = ci - r2 * COLS;
        const px = (c2 + 0.5) * CELL, py = r2 * CELL + 1;
        const id = seq.n = (seq.n + 1) & 0xffff;
        spawnedHere.push({ id, x: px, y: py, rank: d.rank, amt: give, dist: d.dist, dir: c2 > cc ? 1 : -1 });   // NOT into the live drops array: it is being iterated, and for..of would walk straight into them this same tick
        out.push(id, Math.round(px), Math.round(py), d.rank, give, c2 > cc ? 1 : 0);
        rem -= give;
      }
    }
    // one cell of upward give (a filling pool does rise), then it WAITS rather than stacking a column of full cells
    if (rem > 0.001 && rr0 - 1 >= 0) {
      const ci = (rr0 - 1) * COLS + cc;
      // …but only if there is genuinely something under it. A filling pool rises because the cell below is FULL; if
      // it is not, this was just parking liquid in the air. The landing cell being full is the normal case here, so
      // this rarely refuses — it only stops the cases that were leaving a cell hanging proud of the surface.
      if (!isSolidCell(grid[ci]) && supported(ci)) { const free = cap - tot[ci]; if (free > 0.001) { const take = Math.min(free, rem); amt[ci * T + d.rank] += take; recompCell(ci); rem -= take; changed.add(ci); active.add(ci); landed_.set(ci, (landed_.get(ci) || 0) + take); } }
    }
    impact.set(ci0, force + (d.amt - rem) * dropImpactVel(d.dist));
    if (rem > 0) {
      // NOWHERE TO GO. Waking the landing cell is essential: a failed deposit used to activate nothing, so the grid went
      // quiet, nothing drained, and the droplet stalled against a full pool for ever — the world never settled.
      d.amt = rem;
      active.add(ci0); changed.add(ci0);
      if (rr0 + 1 < ROWS) active.add(ci0 + COLS);
      if (cc > 0) active.add(ci0 - 1);
      if (cc + 1 < COLS) active.add(ci0 + 1);
      d.stall = (d.stall || 0) + 1;
      if (d.stall > 40) {
        // Still homeless after a while: the level here simply has to rise. Take the first cell above with room, which is
        // where a filling pool would put it anyway, rather than leaving liquid hovering indefinitely.
        for (let rr = rr0; rr >= 0 && rem > 0; rr--) {
          const ci = rr * COLS + cc;
          if (isSolidCell(grid[ci])) break;
          const free = cap - tot[ci];
          if (free >= 1) { const take = Math.min(free, rem); amt[ci * T + d.rank] += take; recompCell(ci); rem -= take; changed.add(ci); active.add(ci); landed_.set(ci, (landed_.get(ci) || 0) + take); }
        }
        if (rem <= 0) continue;
        d.amt = rem;
      }
      keep.push(d);
    }
  }
  roomDroplets[room] = spawnedHere.length ? keep.concat(spawnedHere) : keep;
  if (changed.size) dropletBroadcastCells(room, changed);
}

function liquidTickRoom(room) {
  if (liquidCfg.droplets) { const t0 = roomLiquidTotal[room]; dropStart = t0 ? Float32Array.from(t0) : null; } else dropStart = null;
  const grid = roomTerrain[room], hp = roomTerrainHp[room], active = roomLiquidActive[room];
  const amt = roomLiquidAmt[room], tot = roomLiquidTotal[room];
  if (!grid || !amt || !tot || !active || !active.size) { if (active && !active.size) delete roomLiquidActive[room]; return; }
  const sd = ensureLiquidSide(room), s2a = ensureStream2Amt(room), s2i = ensureStream2Id(room), lvlAcc = ensureLevelAcc(room);
  const mats = roomMats[room] || {}, tick = liquidTickCount, cap = LIQUID_MAX, T = LIQ_T, COLS = TERRAIN_COLS;
  const LIQUID_FLOOR_ROW = Math.floor(FLOOR_TOP / TERRAIN_CELL);   // liquid may not descend into this row or below (bedrock)
  const isSolid = (v) => v !== 0 && !isFluidId(v);
  const sinkRate = Math.max(0, Math.min(LIQUID_MAX, liquidCfg.sinkRate | 0)), sinkLed = sinkLedger(room);
  const list = Array.from(active); active.clear();
  // bottom-up (row descending) + emptiest-first within a row (see history) → primed edges, position-independent.
  list.sort((a, b) => { const ra = (a / COLS) | 0, rb = (b / COLS) | 0; if (ra !== rb) return rb - ra; const la = tot[a], lb = tot[b]; if (la !== lb) return la - lb; return (tick & 1) ? a - b : b - a; });
  const changedSet = new Set();
  // Units each cell received from droplets THIS tick. A cell may not pass on liquid that has only just landed in it:
  // it has to be water sitting in the cell for a tick first. Without this the landing and the spreading happen in the
  // same tick and you never see it pool -- it appears in the landing cell and both neighbours at once.
  const justLanded = (liquidCfg.droplets && roomDropLanded[room]) ? roomDropLanded[room] : null;
  const spillSide = new Map();   // cell → the fall side spilled onto it THIS tick; a spill from the OTHER side routes into the SECONDARY lane (dual-stream chute)
  const neutralizedThisTick = new Set();   // acid cells that turned (partly) to water THIS tick — other acid must not chain off that fresh water in the same tick (else a whole blob neutralises instantly)
  const fell = new Set();   // cells determined FALLING this tick (propagates up a full stream column, since we process bottom-up) → they don't level laterally
  // STRAIGHT-DOWN-only variant of `fell`, and the difference is the whole point. `fell` also counts a cell that could
  // shed DIAGONALLY, which is true of any pool cell sitting next to a drop — that over-catching is what froze edge
  // cells out of levelling and gave the blocky/stair surface. `fellDown` propagates only through straight-down room,
  // so it means "this cell is part of a column that is genuinely airborne": a falling block is entirely in it, and a
  // settled pool (bottom cell resting on solid, everything above brim-full and going nowhere) is entirely out of it.
  const fellDown = new Set();
  const tagCleared = new Set();   // cells that dropped a stale fallSide tag this tick — broadcast-only (merged into changedSet AFTER the loop, so it never wakes neighbours)
  const wake = (j) => { if (j >= 0 && j < grid.length && !isSolid(grid[j]) && tot[j] > 0) active.add(j); };
  const wakeN = (j) => { const x = j % COLS; wake(j - COLS); wake(j + COLS); if (x > 0) wake(j - 1); if (x < COLS - 1) wake(j + 1); };
  const wakeD = (j) => { wakeN(j); const x = j % COLS; if (x > 0) { wake(j - COLS - 1); wake(j + COLS - 1); } if (x < COLS - 1) { wake(j - COLS + 1); wake(j + COLS + 1); } };   // 8-neighbourhood (density swaps propagate diagonally through a block)
  const mark = (j) => { changedSet.add(j); active.add(j); };
  const recomp = (j) => { let s = 0, b = j * T; for (let k = 0; k < T; k++) s += amt[b + k]; tot[j] = s; };
  // move `t` units A→B taking from A's BOTTOM (heaviest) — a fall
  const moveBottom = (A, B, t) => { let need = t; const ba = A * T, bb = B * T; for (let rk = 0; rk < T && need > 0; rk++) { const a = amt[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; amt[ba + rk] = a - mv; amt[bb + rk] += mv; need -= mv; } const moved = t - need; if (moved) { tot[A] -= moved; tot[B] += moved; mark(A); mark(B); } return moved; };
  // remove `t` units of a SINGLE rank from A's stack (nearest to `wantRk`, else its heaviest) — feeds the secondary lane, which is single-liquid. Returns [movedUnits, rankTaken].
  const takeRank = (A, t, wantRk) => { const ba = A * T; let rk = (wantRk != null && amt[ba + wantRk] > 0) ? wantRk : floorRank(A); if (rk < 0) return [0, -1]; const a = amt[ba + rk], mv = a < t ? a : t; if (mv > 0) { amt[ba + rk] = a - mv; tot[A] -= mv; mark(A); } return [mv, rk]; };
  // move `t` units A→B taking from A's TOP (lightest) — surface flow
  const moveTop = (A, B, t) => { let need = t; const ba = A * T, bb = B * T; for (let rk = T - 1; rk >= 0 && need > 0; rk--) { const a = amt[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; amt[ba + rk] = a - mv; amt[bb + rk] += mv; need -= mv; } const moved = t - need; if (moved) { tot[A] -= moved; tot[B] += moved; mark(A); mark(B); } return moved; };
  // move `t` units A→B taking every rank in PROPORTION to its share of A — a spill/fall keeps its MIXTURE instead of
  // shedding heaviest-first (moveBottom), which is what makes a ledge lip oscillate water-rich/oil-rich every tick and sends
  // period-2 slugs down the stream. Used only at the ledge spill under liquidCfg.streamMix; pools keep moveBottom (stratify).
  const moveProp = (A, B, t) => { const ba = A * T, bb = B * T, TA = tot[A]; if (TA <= 0 || t <= 0) return 0; let need = t, moved = 0;
    for (let rk = 0; rk < T && need > 0; rk++) { const a = amt[ba + rk]; if (a <= 0) continue; let mv = Math.round(t * a / TA); if (mv > a) mv = a; if (mv > need) mv = need; if (mv <= 0) continue; amt[ba + rk] -= mv; amt[bb + rk] += mv; need -= mv; moved += mv; }
    for (let rk = 0; rk < T && need > 0; rk++) { const a = amt[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; amt[ba + rk] -= mv; amt[bb + rk] += mv; need -= mv; moved += mv; }   // rounding remainder, heaviest-first
    if (moved) { tot[A] -= moved; tot[B] += moved; mark(A); mark(B); } return moved; };
  const floorRank = (j) => { const b = j * T; for (let rk = 0; rk < T; rk++) if (amt[b + rk] > 0) return rk; return -1; };
  const ceilRank = (j) => { const b = j * T; for (let rk = T - 1; rk >= 0; rk--) if (amt[b + rk] > 0) return rk; return -1; };
  // FLOW (display-twice): record that `t` units fell INTO cell j on `side` (1 hug-left / 2 hug-right; 0 straight-down → ignored,
  // straight falls just pool, no side-aligned strip). j is below/diagonally-below i → it was reset at the start of ITS
  // processing earlier this bottom-up tick, so this accumulates the current tick's inflow. Pure annotation, never mass.
  let processed = 0;
  for (const i of list) {
    if (processed >= LIQUID_MAX_PER_TICK) { active.add(i); continue; }
    if (isSolid(grid[i])) continue;
    const r = (i / COLS) | 0, c = i - r * COLS, canDown = r + 1 < LIQUID_FLOOR_ROW;
    // SECONDARY LANE (dual-stream chute): fall it straight down independently of the main stream; when it can't fall
    // further (solid or a full pool below), MERGE it into this cell's main stack so it joins the pool. Runs even when the
    // cell has no main liquid (a lone secondary stream), so it's handled before the L<=0 skip below.
    if (s2a[i] > 0) {
      const belowI = i + COLS;
      // fall straight down the secondary lane while there's shared-cap room below (keeps it a continuous stream)
      const roomBelow = (canDown && !isSolid(grid[belowI]) && (s2a[belowI] === 0 || s2i[belowI] === s2i[i])) ? (cap - tot[belowI] - s2a[belowI]) : 0;
      if (roomBelow > 0) { const mv = s2a[i] < roomBelow ? s2a[i] : roomBelow; s2a[belowI] += mv; s2i[belowI] = s2i[i]; s2a[i] -= mv; if (s2a[i] === 0) s2i[i] = 0; mark(i); mark(belowI);}   // secondary lane hugs the side OPPOSITE the main
      // remainder (can't fall = landed on a pool/solid) merges into THIS cell's main stack — combined cap guarantees it fits
      if (s2a[i] > 0) { const rk = LIQ_RANK[s2i[i]]; if (rk !== undefined) { const add = (cap - tot[i]) < s2a[i] ? (cap - tot[i]) : s2a[i]; if (add > 0) { amt[i * T + rk] += add; tot[i] += add; s2a[i] -= add; if (s2a[i] === 0) s2i[i] = 0; mark(i); wakeN(i); } } if (s2a[i] > 0) active.add(i); }
    }
    let L = tot[i]; if (L <= 0) continue;
    // ---- SINK (drain block, id 17) — destroy liquid touching a drain, heaviest first (it is the bottom of the stack
    // that is in contact). Ledgered into roomSinkEaten so grid+air conservation stays checkable: eaten units are
    // accounted for, not merely missing. Neighbours are woken so the pool keeps feeding the drain instead of settling.
    if (sinkRate > 0 && (isSinkId(grid[i + COLS]) || isSinkId(grid[i - COLS]) || (c > 0 && isSinkId(grid[i - 1])) || (c < COLS - 1 && isSinkId(grid[i + 1])))) {
      let need = sinkRate < L ? sinkRate : L;
      const sb = i * T;
      for (let rk = 0; rk < T && need > 0; rk++) { const a = amt[sb + rk]; if (a <= 0) continue; const mv = a < need ? a : need; amt[sb + rk] = a - mv; sinkLed[rk] += mv; need -= mv; }
      recomp(i); mark(i); wakeN(i);
      L = tot[i]; if (L <= 0) continue;
    }
    // LAND-THEN-POOL. Units a droplet put into this cell THIS tick. Droplets fly before the grid ticks, so without
    // this the cell passes fresh liquid straight on -- sideways via levelling, or back over the edge via the spill --
    // in the very tick it arrived, and water is never seen to land and pool. Declared here because BOTH the spill
    // (1b, below) and the levelling (1c/1d, further down) need it; keeping it next to only one of them is exactly how
    // this rule ended up half-applied twice.
    const freshHere = justLanded ? (justLanded.get(i) || 0) : 0;
    processed++;
    const base = i * T, lava = amt[base + 0], acid = amt[base + 3], water = amt[base + 4], oil = amt[base + 5];   // ranks: lava0 quicksand1 brine2 ACID3 WATER4 oil5
    // ---- REACTIONS (layer-aware; consume mass by design; client derives steam/fire/fizz FX from the transitions) ----
    if (liquidCfg.reactions && (lava > 0 || oil > 0 || acid > 0 || water > 0)) {
      const L4 = c > 0 ? i - 1 : -1, R4 = c < COLS - 1 ? i + 1 : -1, U4 = i - COLS, D4 = i + COLS, nn = grid.length;
      const nbrRank = (rank) => { for (const j of [D4, L4, R4, U4]) if (j >= 0 && j < nn && amt[j * T + rank] > 0) return j; return -1; };
      const nbrGrid = (id) => { for (const j of [D4, L4, R4, U4]) if (j >= 0 && j < nn && grid[j] === id) return j; return -1; };   // adjacent SOLID cell of material `id`
      if (lava > 0) {                                   // LAVA + WATER → STONE (same cell, or lava beside water)
        const wj = water > 0 ? i : nbrRank(4);   // water is rank 4
        if (wj >= 0) {
          if (Math.random() < 0.5) {
            grid[i] = 2; hp[i] = matStrengthSrv(mats, 2); for (let k = 0; k < T; k++) amt[base + k] = 0; tot[i] = 0; sd[i] = 0; changedSet.add(i);   // crust to stone
            if (wj !== i) { const wb = wj * T + 3, nl = amt[wb] - 20; amt[wb] = nl > 0 ? nl : 0; recomp(wj); mark(wj); }
            continue;                                    // this cell is now stone → done
          }
          active.add(i);
        }
        // LAVA melts adjacent SNOW → Water (and the lava cools a little). The fresh water beside lava may then crust it to stone next tick.
        const snj = nbrGrid(8);
        if (snj >= 0 && Math.random() < 0.5) {
          const sb = snj * T; for (let k = 0; k < T; k++) amt[sb + k] = 0; amt[sb + 4] = 40; tot[snj] = 40; sd[snj] = 0; s2a[snj] = 0; s2i[snj] = 0;   // water = rank 4
          grid[snj] = 9; changedSet.add(snj); active.add(snj); wakeN(snj);
          const nl = lava - 8; amt[base + 0] = nl > 0 ? nl : 0; recomp(i); L = tot[i]; mark(i);
          if (L <= 0) continue;
        }
        // LAVA bakes adjacent MUD → Earth (dries it out).
        const mdj = nbrGrid(5);
        if (mdj >= 0 && Math.random() < 0.5) {
          grid[mdj] = 1; hp[mdj] = matStrengthSrv(mats, 1); if (roomSat[room]) roomSat[room][mdj] = 0; changedSet.add(mdj);
          const nl = lava - 4; amt[base + 0] = nl > 0 ? nl : 0; recomp(i); L = tot[i]; mark(i);
          if (L <= 0) continue;
        }
        // LAVA fuses adjacent SAND → Glass.
        const sgj = nbrGrid(3);
        if (sgj >= 0 && Math.random() < 0.5) {
          grid[sgj] = 16; hp[sgj] = matStrengthSrv(mats, 16); if (roomSat[room]) roomSat[room][sgj] = 0; changedSet.add(sgj);
          const nl = lava - 4; amt[base + 0] = nl > 0 ? nl : 0; recomp(i); L = tot[i]; mark(i);
          if (L <= 0) continue;
        }
        // LAVA fuses QUICKSAND → Glass (mixed in this cell, or an adjacent quicksand cell).
        const qj = amt[base + 1] > 0 ? i : nbrRank(1);
        if (qj >= 0 && Math.random() < 0.5) {
          const qb = qj * T; for (let k = 0; k < T; k++) amt[qb + k] = 0; tot[qj] = 0; sd[qj] = 0; s2a[qj] = 0; s2i[qj] = 0;
          grid[qj] = 16; hp[qj] = matStrengthSrv(mats, 16); if (roomSat[room]) roomSat[room][qj] = 0; changedSet.add(qj);
          if (qj === i) continue;                          // the lava cell itself fused → done
          const nl = lava - 6; amt[base + 0] = nl > 0 ? nl : 0; recomp(i); L = tot[i]; mark(i);
          if (L <= 0) continue;
        }
      }
      if (oil > 0) {                                    // OIL + LAVA → burns off (gradual → the client draws flame on lava-adjacent oil)
        if (lava > 0 || nbrRank(0) >= 0) {
          const nl = oil - 6; amt[base + 5] = nl > 0 ? nl : 0; recomp(i); L = tot[i]; mark(i);
          const oj = nbrRank(5); if (oj >= 0) active.add(oj);
          if (amt[base + 5] > 0) active.add(i); else continue;
        }
      }
      if (acid > 0) {
        // ACID — SATURATION neutralise: SOAK water (consuming it) into this cell's dilution, and once saturated CONVERT acid→water,
        // both rate-gated (see ACID_* consts). If there's NO water to react with, DISSOLVE an adjacent breakable solid instead.
        const dil = ensureDilute(room);   // ranks: water = 4, acid = 3
        let waterSrc = amt[base + 4] > 0 ? i : -1;        // in-cell water first, else an adjacent liquid cell holding water
        if (waterSrc < 0) for (const j of [D4, L4, R4, U4]) { if (j >= 0 && j < nn && isFluidId(grid[j]) && amt[j * T + 4] > 0) { waterSrc = j; break; } }
        if (waterSrc >= 0 || dil[i] >= ACID_K) {          // can soak, or is saturated enough to convert (else fall through to dissolving / idle)
          if (waterSrc >= 0 && (tick % ACID_SOAK_TICKS) === 0 && dil[i] < acid * ACID_K) {   // SOAK 1 water → dilution (consumed)
            amt[waterSrc * T + 4] -= 1; dil[i] += 1;
            if (waterSrc !== i) { recomp(waterSrc); mark(waterSrc); wakeN(waterSrc); } else recomp(i);
          }
          if ((tick % ACID_CONVERT_TICKS) === 0 && dil[i] >= ACID_K && amt[base + 3] >= 1) {   // CONVERT 1 saturated acid → water
            amt[base + 3] -= 1; amt[base + 4] += 1; dil[i] -= ACID_K; recomp(i); mark(i); wakeN(i);
            if (amt[base + 3] <= 0) dil[i] = 0;            // fully neutralised → drop leftover dilution
          }
          L = tot[i]; active.add(i);                       // reaction in progress → keep simulating
        } else {                                         // no liquid to neutralise with → dissolve an adjacent solid instead
          let solidJ = -1;
          for (const j of [D4, L4, R4, U4]) { if (j < 0 || j >= nn) continue; if ((j / COLS | 0) >= LIQUID_FLOOR_ROW) continue; if (isSolid(grid[j]) && hp[j] > 0 && grid[j] !== 16) { solidJ = j; break; } }   // never eats bedrock or Glass (acid-immune)
          if (solidJ >= 0) {
            active.add(i);                                // keep working every tick regardless of whether the acid can flow
            if ((tick & 7) === 0) {                       // SLOW bite (~1/8 ticks) → time to spread between bites
              if (hp[solidJ] > 1) hp[solidJ] -= 1; else { grid[solidJ] = 0; hp[solidJ] = 0; changedSet.add(solidJ); wakeN(solidJ); active.add(solidJ); }
              const na = acid - 6; amt[base + 3] = na > 0 ? na : 0; recomp(i); L = tot[i]; mark(i);   // acid = rank 3
              if (L <= 0) continue;
            }
          }
        }
      }
      if (water > 0 && lava === 0 && (tick & 3) === 0) {   // WATER freezes to ICE where it touches Snow (cold). Lava-adjacent water melts/crusts instead, so it wins.
        if (nbrGrid(8) >= 0 && Math.random() < 0.35) {
          for (let k = 0; k < T; k++) amt[base + k] = 0; tot[i] = 0; sd[i] = 0; s2a[i] = 0; s2i[i] = 0;
          grid[i] = 4; hp[i] = matStrengthSrv(mats, 4); changedSet.add(i);
          continue;                                      // this cell is now ice → done
        }
      }
      if (water > 0) {                                    // SEED (ungated): flag adjacent absorbent solids for the soil tick, which PULLS water into them once the pool has settled
        const ss = soilSet(room);
        for (const j of [D4, L4, R4, U4]) { if (j < 0 || j >= nn) continue; const g = grid[j]; if (g === 1 || g === 3 || g === 5) ss.add(j); }
      }
    }
    if (L <= 0) continue;
    // FULL CELL DROPS ITS TAG (experimental, user idea). A brim-full cell is packed, not really "streaming", so treat it as a
    // pool: clear the tag → it renders as flush bands AND (because the no-buoyancy gate below keys off the tag) its density
    // sort re-enables, so a full mixed cell stratifies instead of holding unmixed side-by-side. Cleared BEFORE the sort so it
    // takes effect this tick. TRADEOFF: a genuinely full falling stream / full chute also reverts to bands+stratify (may
    // slice / may flicker if the cell above re-tags it next tick). Toggle streamFullClear to compare.
    if (liquidCfg.streamTag && liquidCfg.streamFullClear && sd[i] !== 0 && tot[i] >= cap) { sd[i] = 0; tagCleared.add(i); }
    // NO BUOYANCY IN FREE-FALL. A tagged FALLING stream cell must not density-sort with the cell below: otherwise a lighter
    // liquid in the pool it pours into climbs UP the stream cell by cell (oil rises through a falling water column, reaching
    // the top, and the render draws sink/rise bubbles the whole way down — the reported bug). Gated on the sd tag (a reliable
    // stream signal), NOT canFall — canFall catches settling pool cells too and gating THOSE broke pool stratification before.
    // A resting pool (sd===0) still sorts normally, so layering is untouched.
    const noSortStream = liquidCfg.streamNoSort && liquidCfg.streamTag && sd[i] !== 0;
    // NO BUOYANCY OUT OF A STREAMING NEIGHBOUR. The gate above only checks THIS cell's tag, but the buoyancy sort can be
    // driven by an UNTAGGED pool cell reaching into a tagged/streaming neighbour and lifting its light liquid up-and-out
    // (measured: a light liquid crosses a 1-wide gap by floating out of the draining hole into the adjacent pool; the
    // dense one falls cleanly and does not). Also skipping the sort when the PARTNER cell j is a stream stops that. A
    // resting pool has sd===0 everywhere, so normal stratification/composition levelling is untouched.
    const noSortNbr = liquidCfg.streamNoSortNbr && liquidCfg.streamTag;
    // (2) DENSITY sort with the cell BELOW: heaviest-above heavier than lightest-below → swap 1 unit (heavy sinks)
    if (liquidCfg.densitySort && !noSortStream && canDown && tot[i + COLS] > 0 && !isSolid(grid[i + COLS]) && !(noSortNbr && sd[i + COLS] !== 0)) {
      const j = i + COLS, hi = floorRank(i), lo = ceilRank(j);
      if (hi >= 0 && lo >= 0 && hi < lo) { const k = Math.min(amt[i * T + hi], amt[j * T + lo], liquidCfg.sortRate); amt[i * T + hi] -= k; amt[j * T + hi] += k; amt[j * T + lo] -= k; amt[i * T + lo] += k; mark(i); mark(j); wakeD(i); wakeD(j); }
    }
    // (2b) DIAGONAL density sort — my heaviest sinks into a DIAGONALLY-below cell that holds something lighter, and its
    // lighter rises to me. This is what levels COMPOSITION horizontally: a dense liquid spreads along the bottom across
    // columns (flows under an adjacent lighter one to find its level) instead of standing beside it in a blocky strip.
    // Heavy drops a row → density-weighted PE strictly down → monotone, terminates.
    if (liquidCfg.densitySort && !noSortStream && canDown) for (const dc of (((tick + i) & 1) ? [-1, 1] : [1, -1])) {
      const cc = c + dc; if (cc < 0 || cc >= COLS) continue;
      const j = i + COLS + dc; if (isSolid(grid[j]) || tot[j] === 0) continue;
      if (noSortNbr && sd[j] !== 0) continue;   // don't buoy a light liquid up-and-out of a streaming neighbour (the 1-wide gap crossing)
      const hi = floorRank(i), lo = ceilRank(j);
      if (hi >= 0 && lo >= 0 && hi < lo) { const k = Math.min(amt[i * T + hi], amt[j * T + lo], liquidCfg.sortRate); amt[i * T + hi] -= k; amt[j * T + hi] += k; amt[j * T + lo] -= k; amt[i * T + lo] += k; mark(i); mark(j); wakeD(i); wakeD(j); break; }
    }
    // (Horizontal composition leveling is handled column-integrated AFTER this per-cell loop — see the COLUMN SWAP pass.
    //  A per-cell horizontal move is PE-neutral (same row) so it can only shuffle, never settle; the column pass moves a
    //  heavy unit from the taller-heavy column and a light unit back, which is total-preserving + strictly PE-decreasing.)
    // (1) TOTAL flow — proven single-liquid leveling on total[i], composition advected + STREAM COHESION
    // 1a straight down. (`cohesion` -- a fed falling cell held 1 unit back to keep a stream continuous -- was DELETED
    // 2026-07-22: measured to buy nothing on steady pours or four trickle rates, while shredding a falling block into
    // partial rows, since every cell in a falling block has liquid above it. The cascade carries ledge spills now.)
    // The tag CARRY rides along with the liquid — but only onto AIR or a cell that is already a stream. Writing it onto a cell
    // that already holds untagged (resting) liquid stamped the stream's tag onto the pool cell it LANDS in, so that cell drew
    // as a sideways strip instead of filling bottom-up with the incoming stream in its empty top ("cell = both"). It's exactly
    // one cell — the landing cell — and it's only tagged WHILE liquid pours into it, so a tags-at-rest check can't see it.
    if (canDown) { const j = i + COLS; const room = cap - tot[j] - s2a[j]; if (!isSolid(grid[j]) && room > 0) { const t = Math.min(L, room); if (t > 0) { const wasAirJ = tot[j] === 0; moveBottom(i, j, t);
      // TAG CARRY. streamTag off = the old unconditional copy. On: only PROPAGATE a real tag (sd[i]!==0 — never clobber a good
      // tag with 0, which happens when an untagged mouth cell falls into a chute cell the side-spill already tagged), and only
      // INTO a cell that is air OR itself falling (fell.has(j) — j is straight below, processed already this bottom-up tick).
      // Not into settled liquid: that stamped the tag onto the POOL cell a stream lands in (the landing-cell sideways bug).
      // The tag exists only for the OLD stream render. With the cascade on nothing should ever carry one, so it is not
      // written at all — a stale tag made the client draw phantom strips and kept the old code paths half-alive.
      if (liquidCfg.droplets) { /* no tag under the cascade */ }
      else if (!liquidCfg.streamTag) sd[j] = sd[i]; else if (sd[i] !== 0 && (wasAirJ || fell.has(j))) sd[j] = sd[i];
      L -= t; wakeN(i); } } }   // side = the carried fall side (0 straight-down → no strip)
    // DENSITY THROTTLE (reduced-amount). Streaming DOWN A SURFACE — the diagonal spill 1b (here) and the lateral leveling
    // 1c/1d (below) — moves a reduced amount per tick for denser liquids (rate lf = 1/(1+LEVEL_VISC[surface rank])), so a
    // dense liquid oozes DOWN A SLOPE at ~the same speed it spreads SIDEWAYS instead of racing down 1b-fast and heaping up at
    // each terrace where it can only clear 1c-slow. Free-fall 1a stays UNGATED — gravity is uniform in open air. `reduce(want)`
    // returns the throttled integer to move (carrying the sub-unit fraction in lvlAcc) and flags `pend` when it rounds to 0.
    const cr = ceilRank(i), lf = (liquidCfg.viscosity && cr >= 0) ? 1 / (1 + LEVEL_VISC[cr]) : 1;   // lf=1 ⇒ `reduce` is a pass-through (full-speed leveling for every liquid)
    let pend = false;
    const reduce = (want) => { if (want <= 0) return 0; if (lf >= 1) return want; lvlAcc[i] += want * lf; let mv = lvlAcc[i] | 0; if (mv > want) mv = want; lvlAcc[i] -= mv; if (mv <= 0) pend = true; return mv; };
    // 1b down-diagonals — ONLY when straight-down is BLOCKED (below solid or full) → a genuine spill over a ledge / down a
    // slope (moving against a surface), so it's density-throttled like leveling. If straight-down has room the cell is a
    // free-falling stream (1a handles it): do NOT spread it diagonally (that fanned streams into a pyramid).
    if (liquidCfg.ledgeSpill && L > 0 && canDown && (isSolid(grid[i + COLS]) || tot[i + COLS] >= cap)) for (const dc of (((tick + i) & 1) ? [-1, 1] : [1, -1])) { if (L <= 0) break; const cc = c + dc; if (cc < 0 || cc >= COLS) continue; const j = i + COLS + dc; if (isSolid(grid[j])) continue;
      // MID-AIR SPILL GUARD. 1b fires when straight-down is blocked by a SOLID *or* by FULL LIQUID. Only the first is a
      // ledge; the second exists for a pool spreading sideways across its own surface. But a BLOCK OF LIQUID FALLING
      // THROUGH THE AIR also has full liquid below it, so this spilled diagonally into open air and left liquid hanging
      // there — the long-standing "placed liquid spreads out in mid-air" bug, and its odd signature (a 4x4 fans on the
      // 1st and 3rd rows, a 5x5 on the 2nd and 4th) falls straight out of which rows still hold a full cell beneath
      // them on a given tick. Measured: 268 mid-air 1b moves while one 4x4 block fell, every one with tot[below] = 64.
      // So when the block below is LIQUID rather than solid, the target must have something under it. A pool surface
      // passes (the pool continues beneath the target); mid-air does not. Real ledges are untouched.
      if (!isSolid(grid[i + COLS])) {
        const jb = j + COLS;
        const jSupported = ((j / COLS) | 0) + 1 >= LIQUID_FLOOR_ROW || isSolid(grid[jb]) || tot[jb] > 0;
        if (!jSupported) continue;
      }
      const ns = dc > 0 ? SIDE_LEFT : SIDE_RIGHT, ps = spillSide.get(j), srcId = liqRepId(amt, i);
      const jc2 = j % COLS, chute = (jc2 === 0 || isSolid(grid[j - 1])) && (jc2 === COLS - 1 || isSolid(grid[j + 1]));   // a 1-wide channel (both horizontal neighbours solid) — only there do two spills become two lanes; a wide pool just mixes (else spurious lanes never drain)
      if (!liquidCfg.droplets && chute && ps !== undefined && ps !== ns && srcId && (s2a[j] === 0 || s2i[j] === srcId)) {   // a SECOND stream from the OTHER side → secondary lane; the two lanes SHARE the cell's width (main+secondary ≤ cap) so it drains cleanly (two fat streams just each go thinner)
        const room2 = cap - tot[j] - s2a[j], want = reduce(L < room2 ? L : room2); if (want > 0) { const [mv] = takeRank(i, want, LIQ_RANK[srcId]); if (mv > 0) { s2a[j] += mv; s2i[j] = srcId; L -= mv; mark(j); wakeN(i); } }   // secondary route (chute): side ns, ledge-gated
      // LEDGE GATE on the tag. 1b fires when straight-down is blocked by SOLID *or* by FULL LIQUID — and only the first is a
      // ledge. The second is ordinary liquid spreading sideways across a POOL SURFACE, which happens all over any settling
      // pool, so tagging it made `sd` mean "moved diagonally-down recently" rather than "spilled off an edge". Harmless while
      // the render also demanded room below (pool cells fail that), but the moment the render TRUSTS the tag those cells all
      // draw as sideways-filling strips: a plain no-ledge basin peaked at 197 of 266 cells tagged mid-settle (0 with the gate).
      // Note `spillSide.set` stays UNCONDITIONAL — it routes the dual-stream chute lane, which is MASS. Only sd is gated, so
      // physics is untouched (dam-break 728 ticks / 266 cells either way).
      } else if (liquidCfg.droplets && isSolid(grid[i + COLS]) && (r === 0 || tot[i - COLS] <= 0) && tot[j] + s2a[j] < cap) {
        // ── DROPLET CASCADE ── a real ledge (solid underfoot), so the liquid LEAVES THE GRID here and falls as droplets
        // that carry it. Nothing is tagged, nothing streams through cells: water in flight simply isn't in the grid.
        // A brim-full target has nothing to fall into, so that stays grid flow — unless this lip was shedding droplets a
        // moment ago, in which case it keeps doing so rather than flickering between the two modes every few ticks.
        {
          // INTEGER units throughout: roomLiquidAmt is a Uint8Array, so anything fractional is truncated on write and
          // silently destroyed. (Measured: 3571 of 4220 units vanished before this was made integer-safe.)
          // Fresh droplet liquid may not be shed straight back over the edge either. `dropStart` is snapshotted at the
          // START of liquidTickRoom, which runs AFTER dropletTickRoom has deposited, so it INCLUDES what just landed.
          // On a 1-cell-wide tread that is the entire flow, so the tread shed everything the moment it arrived and
          // never held anything — the reported "droplets never pool on 1-cell steps". Same land-then-pool rule as
          // levelling; it was applied there and missed here.
          const startHere = dropStart[i] === undefined ? L : dropStart[i];
          const budget = Math.floor(Math.min(L, Math.max(0, startHere - freshHere)));
          if (budget >= 1) {
            const took = new Int32Array(T);
            let taken = 0, left = budget;
            // From the SURFACE down by default: the spill is the top slice of the pool, so it carries whatever liquids
            // that slice spans in exactly the right ratio — the mixture falls out of the physics, not a separate rule.
            for (let n = 0; n < T && left >= 1; n++) {
              const rk = liquidCfg.dropWeir ? T - 1 - n : n;
              const q = Math.min(amt[i * T + rk], left);
              if (q >= 1) { took[rk] = q; taken += q; left -= q; }
            }
            if (taken >= 1 && spawnDroplets(room, i, r, c, dc, took, taken)) {
              recomp(i); L = tot[i]; mark(i);
              if (L <= 0) break;
              continue;
            }
          }
        }
      } else if (tot[j] + s2a[j] < cap) { const t = reduce(Math.min(L, cap - tot[j] - s2a[j]));
        // BIRTH gate: a REAL ledge underfoot (1b also fires when full LIQUID blocks straight-down — a pool surface spreading
        // sideways, not a fall), AND landing in air OR a cell that is itself falling (fell.has(j) — the target is diagonally
        // below, already processed this bottom-up tick). Admitting a falling cell that already holds untagged liquid is what
        // lets a tag reach a chute fed from the side, where the mouth fills level-then-down (untagged) before the spill tags it.
        // `spillSide.set` stays UNCONDITIONAL — it routes the dual-stream chute lane (MASS); only sd (annotation) is gated.
        const tagOk = !liquidCfg.droplets && (!liquidCfg.streamTag || (isSolid(grid[i + COLS]) && (tot[j] === 0 || fell.has(j))));
        // streamMix: a ledge spill draws PROPORTIONALLY (moveProp) so the lip keeps its mixture instead of shedding heaviest
        // -first — that heaviest-first shedding is what makes the lip oscillate period-2 and sends alternating water/oil slugs
        // down the stream (visible now as pulsing sub-strip widths). Pools are untouched: this is only the ledge-spill path.
        // flow only on a GENUINE ledge fall (solid under the source) — NOT pool-surface spreading (full liquid below), which
        // also fires 1b and would paint spurious incoming strips all over a settling pool surface (matches the tag's gate).
        if (t > 0) { (liquidCfg.streamMix ? moveProp : moveBottom)(i, j, t); if (tagOk) sd[j] = ns; spillSide.set(j, ns); L -= t; wakeN(i); } }
    }
    // A FALLING stream must NOT level laterally, or it fans out into a pyramid as it falls. A cell "can fall" if the cell
    // below (or a diagonal-below) has ROOM (not solid, not full) — note: room, NOT empty, because a falling stream's below
    // holds the CONTINUING stream, so an empty-only test wrongly registered streams as settled. Lateral leveling (1c) +
    // flat-settle (1d) apply only to cells that can't fall — settled/pool cells. Streams just fall (1a/1b).
    const roomAt = (j) => !isSolid(grid[j]) && tot[j] < cap;
    // "falling" = this cell can still descend: room straight/diagonally below, OR the cell DIRECTLY below is itself
    // falling (this propagates up an entire full-to-the-brim stream column — we process bottom-up, so the below cell was
    // already decided). A falling cell never levels laterally, so a stream stays a narrow column instead of fanning.
    const canFall = canDown && (roomAt(i + COLS) || fell.has(i + COLS) || (c > 0 && roomAt(i + COLS - 1)) || (c < COLS - 1 && roomAt(i + COLS + 1)));
    if (canFall) fell.add(i);
    // AIRBORNE = straight-down room, or the cell directly below is itself airborne. No diagonal term, so a pool cell
    // beside a drop is NOT airborne and still levels; a block of liquid falling through open air IS, top to bottom,
    // even though every cell in it has a brim-full cell underneath.
    const airborne = canDown && (roomAt(i + COLS) || fellDown.has(i + COLS));
    if (airborne) fellDown.add(i);
    // (2c) PER-LIQUID horizontal leveling (POOLS ONLY — streams/mid-air fall via 1a/1b and are excluded by !canFall).
    // The density sorts (2)/(2b) only erode a dense pile's EDGES (a heavy unit surrounded by the same heavy can't sink),
    // so a tall pre-mixed pile leaves diagonal BANDS. This levels each DENSE liquid's own surface so it flows from a tall
    // column to a short one like water finding its level — WITHOUT disturbing the denser layers below (user idea 2: settle
    // densest-first over the floor of what's denser). For rank t (densest→lightest, skipping the lightest = the total,
    // handled by 1c/1d), compare the cumulative depth C_t = Σ_{k≤t} along the row; if this cell's is higher, nudge 1 unit
    // of rank t toward the nearest lower-C_t neighbour and swap a lighter unit back. TOTAL-PRESERVING (the total-flow sees
    // nothing to undo), DIRECTIONAL by surface height (PE drops), scan for global reach, deadband to stop jitter. This is
    // what makes different-density liquids never rest adjacent (user idea 1) — the heavy ends flat along the bottom.
    // LATERAL LEVELING (pools only) — the sideways spread + flat-settle, density-throttled by the same `reduce` as 1b above
    // (defined before 1b since streaming down a surface shares the throttle). 2c/1c/1d all move a reduced amount per tick.
    // LEVELLING GATE. A cell is excluded from levelling only if it is genuinely a STREAM. The old gate (!canFall) also froze
    // pool cells that could shed DIAGONALLY over a nearby edge → the blocky/stair surface. isStream: TAGGED (a ledge spill,
    // carried down) OR straight-down room (a vertical drop the tag never marks). levelGate 0=old canFall · 1=tag-or-straight ·
    // 2=tag-only. The DIAGONAL room that used to over-catch edge pools is gone from modes 1/2. (Tag read AFTER the clear below.)
    if (!canFall) {
      // STREAM TAG CLEAR. `sd` (fallSide) is meant to mean "this liquid spilled off an edge and hasn't landed yet" — it is
      // born ONLY on a ledge spill (1b) and carried down by 1a. But it only ever CLEARED when a cell became the TARGET of
      // someone else's lateral move (the sd[j]=0 in 1c/1d) or when it emptied — and a BRIM-FULL settled cell gets NEITHER
      // (nothing can laterally move INTO a full cell, and it never empties), so it kept a stale tag forever. That's why the
      // render can't trust the tag alone and has to AND in a room-below test — which then misfires on a brim-full stream and
      // draws it as flush horizontal bands (the horizontal-slices bug). A cell that can't fall is settled/pooling, so it is
      // by definition not a stream: drop the tag here, the other half of "carry it until it lands".
      // Guarded on sd[i] !== 0 so it fires ONCE per cell (a no-op re-broadcast every tick would never let the room go quiet).
      // Collected in its OWN set, merged into changedSet only for the post-loop broadcast: mark() would re-activate the cell
      // (settled pools would never go quiet) and even a bare changedSet.add would trip the `changedSet.has(i) → wakeN(i)` at
      // the foot of this loop, perturbing activation order (it shifted DAM-BREAK by 2 ticks). PURE ANNOTATION: sd never gates
      // mass anywhere in this tick, so with the wake ripple avoided this cannot touch how pools flow, settle or stratify.
      if (liquidCfg.streamTag && sd[i] !== 0) { sd[i] = 0; tagCleared.add(i); }
    }
    // LEVELLING runs on NON-STREAM (settled/pool) cells. isStream read AFTER the tag clear so a just-settled cell can level this
    // tick. Mode 0 = old canFall (identical to before). Modes 1/2 drop the diagonal-below room that froze edge pools.
    // Mode 3 (default) = AIRBORNE, the propagating straight-down test. Modes 1 and 2 both fail on a falling BLOCK of liquid:
    // mode 2 keys off the tag, which the droplet cascade never writes, and mode 1 asks for straight-down ROOM, which a block
    // never has because the cell under it is another full cell of the same block. So under the cascade nothing was held back
    // and a placed block levelled itself sideways in mid-air. Mode 3 propagates the way `fell` does, without the diagonal
    // term that over-caught pool edges — so a falling block is excluded top to bottom and a pool beside a drop still levels.
    const isStream = liquidCfg.levelGate === 0 ? canFall
                   : liquidCfg.levelGate === 3 ? (sd[i] !== 0 || airborne)
                   : liquidCfg.levelGate === 2 ? (sd[i] !== 0)
                   : (sd[i] !== 0 || (canDown && roomAt(i + COLS)));
    // How much of this cell may move on THIS tick: everything except what a droplet just put here.
    const shedCap = freshHere > 0 ? Math.max(0, L - freshHere) : L;
    if (!isStream) {
      // (2c) PER-LIQUID horizontal leveling: level each dense layer's own surface over the floor of what's denser (heavy ends
      // flat along the bottom) without disturbing the layers below. Cumulative depth C_t=Σ_{k≤t}; nudge rank t toward the
      // nearest strictly-lower-C_t neighbour, swap the nearest lighter back (total-preserving). Throttled by `reduce` too.
      const cumAt = (jj, tt) => { let s = 0; const bb = jj * T; for (let k = 0; k <= tt; k++) s += amt[bb + k]; return s; };
      if (liquidCfg.perLiquidLevel) for (let t = 0; t < T - 1; t++) {
        if (amt[i * T + t] <= 0) continue;                 // no rank-t here to shed (a lighter/absent layer)
        const Ci = cumAt(i, t);
        let dir = 0, best = Infinity;
        for (const sdir of [-1, 1]) for (let d = 1; d <= LIQUID_LEVEL_SCAN; d++) { const cc = c + sdir * d; if (cc < 0 || cc >= COLS) break; const j2 = i + sdir * d; if (isSolid(grid[j2])) break; const Cj = cumAt(j2, t); if (Cj > Ci) break; if (Cj <= Ci - 2) { if (d < best) { best = d; dir = sdir; } break; } }
        if (dir === 0) continue;
        const j = i + dir; if (isSolid(grid[j])) continue;
        const Cj = cumAt(j, t);
        if (Cj >= Ci) continue;                            // adjacent must be STRICTLY lower — a deficit propagates as a clean wave
        let avail = 0; for (let k = t + 1; k < T; k++) avail += amt[j * T + k];   // lighter mass at j available to swap back
        if (avail <= 0) continue;
        // BULK amount (was a fixed 1-unit nudge). A SUBMERGED layer has no other leveling path — 1c/1d only ever read tot[],
        // which a lighter layer resting on top holds flat, so they see nothing to do and 2c alone must flatten the interface.
        // At 1 unit/tick that crawled: a 1-cell step (64 units) took ≥64 ticks to erase and propagated column by column, ~8×
        // slower than the identical step at a free surface. Shed HALF the cumulative-depth difference instead, exactly as 1c
        // does on totals — halving ⇒ no overshoot ⇒ still monotone + terminating. The floor of 1 keeps the old polish nudge
        // for the last few units (a pure halving floors to 0 early and rests ~½-cell rough).
        let n = (Ci - Cj) >> 1;
        if (n > amt[i * T + t]) n = amt[i * T + t];
        if (n > avail) n = avail;
        if (n < 1) n = 1;
        n = reduce(n);                                     // density throttle (carried this tick)
        if (n <= 0) continue;
        amt[i * T + t] -= n; amt[j * T + t] += n;          // rank t → j
        let need = n; for (let q = t + 1; q < T && need > 0; q++) { const a = amt[j * T + q]; if (a <= 0) continue; const mv = a < need ? a : need; amt[j * T + q] -= mv; amt[i * T + q] += mv; need -= mv; }   // NEAREST lighter j → i (total-preserving)
        mark(i); mark(j); wakeD(i); wakeD(j);
      }
      // levelMix: move the MIXTURE (moveProp) instead of skimming the lightest off the top (moveTop). Skimming oil each tick is
      // the oil/water slosh pump; moving the mixture keeps a surface cell's ratio steady (the density sorts still re-stratify).
      const lvlMove = liquidCfg.levelMix ? moveProp : moveTop;
      // 1c lateral equalise — surface flow. SYMMETRIC (symLevel): shed to BOTH lower
      // neighbours from the SAME pre-shed snapshot, aimed at the 3-cell AVERAGE. No per-tick direction preference (the old
      // `(tick+i)&1` order + sequential `L -=` made whichever side went FIRST take more → the period-2 water/oil slosh that
      // streams replay as chunks) and no overshoot (two lower neighbours can't drain a cell below them: each lands on the avg).
      // fluxLevel takes over 1c/1d entirely (it solves the same job globally) — running both would double-move.
      if (liquidCfg.lateralLevel && !liquidCfg.fluxLevel && L > 1) {
        if (liquidCfg.symLevel) {
          const jL = c > 0 ? i - 1 : -1, jR = c < COLS - 1 ? i + 1 : -1;
          const okL = jL >= 0 && !isSolid(grid[jL]) && L - tot[jL] > 1;   // a strictly-lower non-solid neighbour that can receive
          const okR = jR >= 0 && !isSolid(grid[jR]) && L - tot[jR] > 1;
          let sum = L, cnt = 1; if (okL) { sum += tot[jL]; cnt++; } if (okR) { sum += tot[jR]; cnt++; }
          if (cnt > 1) {
            const avg = sum / cnt;
            let shedL = okL ? Math.min(avg - tot[jL], cap - tot[jL] - s2a[jL]) : 0;   // bring each lower neighbour UP to the avg (capped by its room)
            let shedR = okR ? Math.min(avg - tot[jR], cap - tot[jR] - s2a[jR]) : 0;
            if (shedL < 0) shedL = 0; if (shedR < 0) shedR = 0;
            const denom = shedL + shedR; let total = reduce(Math.floor(denom));   // throttle the TOTAL once (reduce carries a per-cell accumulator)
            if (total > shedCap) total = shedCap;                       // fresh droplet liquid waits a tick
            if (total > 0 && denom > 0) {
              let mvL = Math.round(total * shedL / denom); if (mvL > total) mvL = total; const mvR = total - mvL;   // split by deficit; sum stays = total (conserved)
              if (mvL > 0) { lvlMove(i, jL, mvL); sd[jL] = 0; L -= mvL; wakeN(i); }
              if (mvR > 0) { lvlMove(i, jR, mvR); sd[jR] = 0; L -= mvR; wakeN(i); }
            }
          }
        } else for (const dc of (((tick + i) & 1) ? [-1, 1] : [1, -1])) { const cc = c + dc; if (cc < 0 || cc >= COLS) continue; const j = i + dc; if (isSolid(grid[j])) continue; const nl = tot[j], room2 = cap - nl - s2a[j]; if (L - nl > 1 && room2 > 0) { const mv = Math.min(reduce(Math.min((L - nl) >> 1, room2)), shedCap); if (mv > 0) { lvlMove(i, j, mv); sd[j] = 0; L -= mv; wakeN(i); } } }
      }
      // 1d surface FLAT-SETTLE — nudge toward the nearest strictly-lower reachable spot in the row; throttled REDUCED-AMOUNT
      if (liquidCfg.lateralLevel && !liquidCfg.fluxLevel && L > 0) {
        let dir = 0, best = Infinity;
        for (const sdir of [-1, 1]) for (let d = 1; d <= LIQUID_LEVEL_SCAN; d++) { const cc = c + sdir * d; if (cc < 0 || cc >= COLS) break; const j = i + sdir * d; if (isSolid(grid[j])) break; const jl = tot[j]; if (jl > L) break; if (jl <= L - 2) { if (d < best) { best = d; dir = sdir; } break; } }
        if (dir !== 0 && shedCap >= 1) { const j = i + dir; if (tot[j] < L && tot[j] + s2a[j] < cap && reduce(1) > 0) { lvlMove(i, j, 1); sd[j] = 0; L -= 1; wakeN(i); } }
      }
    }
    if (pend) active.add(i);                               // throttled diagonal spill OR leveling still owed this tick → revisit
    if (changedSet.has(i)) wakeN(i);
  }
  // ═══ FLUX LEVELLING (liquidCfg.fluxLevel) — "global target, LOCAL transport" ═══════════════════════════
  // The default 1c/1d levelling is pure local diffusion: a cell only knows its neighbours, so "which way is
  // downhill" has to spread one cell per tick and a pool of width N takes O(N²) ticks to flatten.
  // Here we instead (a) flood-fill each connected body, (b) solve its equilibrium waterline, (c) take the
  // RUNNING SUM of (columnHeight − target) across the body's columns — that prefix sum IS exactly how much
  // water must cross each column interface — and (d) move at most `fluxRate` units across each interface,
  // BETWEEN ADJACENT CELLS ONLY. Transport stays local and continuous (nothing teleports, mass moves cell to
  // cell through the existing moveProp/moveTop), but every interface already knows the correct direction and
  // amount, so convergence is O(N). Measured on the probe (scratchpad/probe_scalar_leveling.js):
  // N=42 1344→258 · N=60 3071→425 · N=90 8294→707 · N=120 15581→1029 ticks (5×→15×, and the win grows with N).
  // Only the SETTLED run of each column (water resting on its floor) takes part, so falling streams are
  // untouched and keep rendering as streams. Off by default → straight A/B against today's levelling.
  if (liquidCfg.fluxLevel) {
    const ROWS = TERRAIN_ROWS, NCELL = COLS * ROWS, RATE = liquidCfg.fluxRate | 0;
    const lvlMove = liquidCfg.levelMix ? moveProp : moveTop;
    const seen = ensureFluxSeen(room); seen.fill(0);
    const stack = ensureFluxStack(room);
    const cFloor = new Int32Array(COLS), cTop = new Int32Array(COLS), cH = new Float64Array(COLS);
    for (let start = 0; start < NCELL; start++) {
      if (seen[start] || isSolid(grid[start]) || tot[start] <= 0) continue;
      let sp = 0; stack[sp++] = start; seen[start] = 1;
      let minC = COLS, maxC = -1;
      while (sp > 0) {                                        // flood the connected body (4-way, through liquid)
        const j = stack[--sp], jc = j % COLS;
        if (jc < minC) minC = jc; if (jc > maxC) maxC = jc;
        const jr = (j / COLS) | 0;
        if (jc > 0) { const k = j - 1; if (!seen[k] && !isSolid(grid[k]) && tot[k] > 0) { seen[k] = 1; stack[sp++] = k; } }
        if (jc < COLS - 1) { const k = j + 1; if (!seen[k] && !isSolid(grid[k]) && tot[k] > 0) { seen[k] = 1; stack[sp++] = k; } }
        if (jr > 0) { const k = j - COLS; if (!seen[k] && !isSolid(grid[k]) && tot[k] > 0) { seen[k] = 1; stack[sp++] = k; } }
        if (jr < ROWS - 1) { const k = j + COLS; if (!seen[k] && !isSolid(grid[k]) && tot[k] > 0) { seen[k] = 1; stack[sp++] = k; } }
      }
      if (maxC <= minC) continue;                             // single column → nothing to level across
      // A 4-connected body always occupies a CONTIGUOUS column range (you cannot reach column c+2 without
      // passing through c+1), so walk minC..maxC and record which columns actually PARTICIPATE (have settled
      // water). Non-participants — a column the body only passes through as a falling stream, say — are kept
      // in the chain and simply pass the running flux along. Previously they were dropped and the chain was
      // reset at each hole, which split one pool into segments that each levelled to their OWN waterline:
      // that is the "doesn't level completely" seen on real terrain (flat test basins never hit it).
      const cols = [], part = new Uint8Array(COLS);
      for (let c = minC; c <= maxC; c++) {                    // per column: floor, settled run, headroom
        let r = -1;                                           // lowest body row in this column
        for (let rr = ROWS - 1; rr >= 0; rr--) { const j = rr * COLS + c; if (seen[j] && tot[j] > 0) { r = rr; break; } }
        if (r < 0) continue;
        while (r + 1 < ROWS && r + 1 < LIQUID_FLOOR_ROW && !isSolid(grid[(r + 1) * COLS + c])) r++;
        const fl = r + 1;
        // SETTLED RUN = the block of FULL cells resting on the floor, plus AT MOST ONE partial surface cell.
        // A landing stream is contiguous with the pool it feeds, so a naive "walk up while there's liquid"
        // climbs the whole falling column and the flux pass fans it sideways (PYRAMID spread 1 → 18 cols).
        // A falling column is a run of PARTIAL cells, so stopping at the first non-full cell excludes it.
        // (The stream tag can't be used for this: it is only born on a diagonal spill, so a straight-down
        // pour carries no tag at all.)
        let t = fl; while (t - 1 >= 0 && !isSolid(grid[(t - 1) * COLS + c]) && tot[(t - 1) * COLS + c] >= cap) t--;
        if (t - 1 >= 0 && !isSolid(grid[(t - 1) * COLS + c])) {                      // one partial surface cell
          const v = tot[(t - 1) * COLS + c];
          if (v > 0 && v < cap && sd[(t - 1) * COLS + c] === 0) t--;
        }
        if (t >= fl) continue;                                                        // nothing actually resting here
        let h = 0; for (let rr = t; rr < fl; rr++) h += tot[rr * COLS + c];
        let cl = t; while (cl - 1 >= 0 && !isSolid(grid[(cl - 1) * COLS + c]) && tot[(cl - 1) * COLS + c] <= 0) cl--;
        cFloor[c] = fl; cTop[c] = cl; cH[c] = h; part[c] = 1; cols.push(c);
      }
      if (cols.length < 2) continue;
      // BARRIER SPLIT. This sim has no upward transport — liquid only falls, spills and flows sideways. So a
      // body joined ONLY through a submerged, ceiling-capped channel (two basins linked under a rock, a U-tube)
      // can never actually equalise: water would have to climb the far side. Solving one waterline across such
      // a body demands transport that can never happen, so the flux pushes at the barrier FOREVER — a permanent
      // futile conveyor that both stalls short of level and shows as liquid endlessly sliding over the surface.
      // A column that is full to a SOLID ceiling is exactly that barrier, so cut the body there and level each
      // reachable stretch on its own. (Levelling across such a channel needs real pressure, which is a separate
      // piece of work — note that today's non-flux levelling cannot do it either.)
      const barrier = (c) => part[c] && cTop[c] > 0 && isSolid(grid[(cTop[c] - 1) * COLS + c]) && cH[c] >= (cFloor[c] - cTop[c]) * cap - 1;
      const levelSegment = (a, b) => {
        let n = 0, M = 0;
        for (let c = a; c <= b; c++) if (part[c]) { n++; M += cH[c]; }
        if (n < 2) return;
        const volAt = (L) => { let v = 0; for (let c = a; c <= b; c++) if (part[c]) { const mx = (cFloor[c] - cTop[c]) * cap; let hh = (cFloor[c] - L) * cap; if (hh < 0) hh = 0; if (hh > mx) hh = mx; v += hh; } return v; };
        let loL = -1, hiL = ROWS + 1;                         // binary-search the equilibrium waterline
        for (let it = 0; it < 32; it++) { const mid = (loL + hiL) / 2; if (volAt(mid) > M) loL = mid; else hiL = mid; }
        const L = (loL + hiL) / 2;
        let run = 0;
        for (let c = a; c < b; c++) {                         // walk the whole stretch; the run is never reset
          if (part[c]) {
            const mx = (cFloor[c] - cTop[c]) * cap;
            let tgt = (cFloor[c] - L) * cap; if (tgt < 0) tgt = 0; if (tgt > mx) tgt = mx;
            run += cH[c] - tgt;
          }
          if (!part[c] || !part[c + 1]) continue;             // can't transport here yet — but the run carries on
          let want = run > RATE ? RATE : run < -RATE ? -RATE : run;
          if (want > -1 && want < 1) continue;                // deadband → a level pool goes quiet (no endless churn)
        const src = want > 0 ? c : c + 1, dst = want > 0 ? c + 1 : c;
        // Take from the SOURCE's surface and deliver at the DESTINATION's surface — i.e. water runs over the
        // top from the higher column into the lower one. Delivering at the source's ROW instead would drop
        // water into unsupported cells in the neighbour, scattering mid-air liquid across the pool
        // (that fanned PYRAMID's falling-cell spread out to 17 columns).
        let need = Math.floor(Math.abs(want));
        let sr = cTop[src], dr = cFloor[dst] - 1;
        while (need > 0) {
          while (sr < cFloor[src] && (isSolid(grid[sr * COLS + src]) || tot[sr * COLS + src] <= 0)) sr++;
          if (sr >= cFloor[src]) break;
          while (dr >= cTop[dst] && (isSolid(grid[dr * COLS + dst]) || cap - tot[dr * COLS + dst] - s2a[dr * COLS + dst] <= 0)) dr--;
          if (dr < cTop[dst] || dr < sr) break;                 // no room left, or it would mean lifting water uphill
          const a = sr * COLS + src, b = dr * COLS + dst; if (a === b) break;
          const mv = Math.min(tot[a], cap - tot[b] - s2a[b], need); if (mv <= 0) break;
          const did = lvlMove(a, b, mv); if (did <= 0) break;
          sd[b] = 0; need -= did; wakeN(a); wakeN(b);
        }
        }
      };
      // Cut the body's column range at barriers; each reachable stretch levels on its own waterline.
      let segA = minC;
      for (let c = minC; c <= maxC; c++) if (barrier(c)) { if (c - 1 >= segA) levelSegment(segA, c - 1); segA = c + 1; }
      if (maxC >= segA) levelSegment(segA, maxC);
    }
  }
  for (const j of tagCleared) changedSet.add(j);   // annotation-only changes join the broadcast here — too late to wake anything
  // sync grid[i]/hp to the representative (heaviest present) for every changed liquid cell (reaction-produced solids kept)
  for (const j of changedSet) {
    if (isSolid(grid[j])) continue;
    const rep = liqRepId(amt, j);
    if (rep === 0) { if (s2a[j] > 0) { grid[j] = s2i[j]; hp[j] = 0; } else { if (isFluidId(grid[j])) { grid[j] = 0; hp[j] = 0; } sd[j] = 0; } }   // lone secondary stream → show its liquid
    else if (grid[j] !== rep) { grid[j] = rep; hp[j] = matStrengthSrv(mats, rep); }
  }
  // Wake settled POWDER above a cell that just emptied or turned to liquid (support drained/dissolved out from under it → it falls/sinks).
  for (const j of changedSet) { const up = j - COLS; if (up >= 0 && isPowderId(grid[up]) && (grid[j] === 0 || isFluidId(grid[j]))) powderSet(room).add(up); }
  if (changedSet.size && !liquidQuiet) {
    // WIRE per changed cell: [index, gridId, fallSide, mask] then one amt for each set bit of `mask` (rank order). mask
    // is a 6-bit set of which density ranks are present → compact (a single-liquid cell is 5 values). Chunked at cell
    // boundaries. gridId carries reaction-produced solids (e.g. stone) the client can't derive from the amounts.
    // Side byte: low 2 bits = fallSide (0/1/2). 0x80 = secondary lane [amt,id] follows the mask amts.
    // (0x40/0x20 per-side FLOW bytes were removed 2026-07-20: the client stopped rendering from per-tick flow
    //  when display-twice was rebuilt off the stream tag, so they were pure bandwidth.)
    let arr = [], cells = 0;
    for (const j of changedSet) {
      const b = j * T; let mask = 0; for (let rk = 0; rk < T; rk++) if (amt[b + rk] > 0) mask |= (1 << rk);
      const hasS2 = s2a[j] > 0;
      // 0x40 = the sim classed this cell AIRBORNE this tick (it will not level sideways). Pure annotation for the
      // Inspect overlay — nothing reads it back. It is the distinction behind most of the bugs found here, and it is
      // invisible on screen: the mid-air spread was entirely cells being on the wrong side of it.
      arr.push(j, grid[j], (sd[j] & 0x03) | (hasS2 ? 0x80 : 0) | (fellDown.has(j) ? 0x40 : 0), mask);
      for (let rk = 0; rk < T; rk++) if (mask & (1 << rk)) arr.push(amt[b + rk]);
      if (hasS2) arr.push(s2a[j], s2i[j]);
      if (++cells >= 8192) { emitLiquidCells(room, arr); arr = []; cells = 0; }
    }
    if (cells) emitLiquidCells(room, arr);
  }
  // DROPLET SPAWNS. Six numbers each: id, x, y, rank, amt*4, dirRight. Everything after the spawn is ballistic, so this
  // is the entire cost of a droplet on the wire -- the client falls it from here without another byte.
  const spawns = roomDropSpawns[room];
  if (spawns && spawns.length) { io.to(room).emit('liquid-drops', spawns); roomDropSpawns[room] = []; }
  // prune woken cells that aren't liquid (neighbour-wakes can add solids/empties)
  for (const j of Array.from(active)) { if (j < 0 || j >= grid.length) { active.delete(j); continue; } if (isSolid(grid[j]) || (tot[j] <= 0 && s2a[j] <= 0)) active.delete(j); }
  if (!active.size) delete roomLiquidActive[room];
}
// GRANULAR POWDER tick (sand/snow). Falling-sand CA on grid[]: each active grain moves DOWN or DOWN-DIAGONAL only (piles at
// ~45°, never levels), swapping with a liquid it enters (grain sinks, liquid rises). Broadcasts moved cells over liquid-cells.
function powderTickRoom(room) {
  const grid = roomTerrain[room], hp = roomTerrainHp[room], active = roomPowderActive[room];
  if (!grid || !hp || !active || !active.size) { if (active && !active.size) delete roomPowderActive[room]; return; }
  const amt = ensureLiquidAmt(room), tot = ensureLiquidTotal(room), sd = ensureLiquidSide(room), s2a = ensureStream2Amt(room), s2i = ensureStream2Id(room);
  const mats = roomMats[room] || {}, T = LIQ_T, COLS = TERRAIN_COLS, tick = powderTickCount, nn = grid.length;
  const FLOOR_ROW = Math.floor(FLOOR_TOP / TERRAIN_CELL);   // grains may not enter the bedrock floor row (same as liquid)
  const canDisplace = (j) => grid[j] === 0 || isFluidId(grid[j]);   // empty or liquid → a grain can fall into it
  const list = Array.from(active); active.clear();
  list.sort((a, b) => ((b / COLS) | 0) - ((a / COLS) | 0));   // bottom-up so a falling column cascades in a single pass
  const changedSet = new Set();
  const wakeAround = (i) => { const c = i % COLS; for (const j of [i - COLS, c > 0 ? i - COLS - 1 : -1, c < COLS - 1 ? i - COLS + 1 : -1]) if (j >= 0 && isPowderId(grid[j])) active.add(j); };   // wake grains above the vacated cell → column keeps falling
  const swapMove = (src, dst) => {
    const P = grid[src], hpP = hp[src];
    if (grid[dst] === 0) { grid[dst] = P; hp[dst] = hpP; grid[src] = 0; hp[src] = 0; }
    else {   // dst holds liquid → SWAP its whole stack up into src; the grain sinks into dst (mass-conserved for both)
      const bs = src * T, bd = dst * T;
      for (let k = 0; k < T; k++) { amt[bs + k] = amt[bd + k]; amt[bd + k] = 0; }   // src was solid (amt 0) → move dst's stack up, clear dst
      tot[src] = tot[dst]; tot[dst] = 0;
      sd[src] = 0; s2a[src] = 0; s2i[src] = 0; sd[dst] = 0; s2a[dst] = 0; s2i[dst] = 0;   // secondary lanes never live at a settling interface (negligible)
      grid[dst] = P; hp[dst] = hpP;
      grid[src] = liqRepId(amt, src); hp[src] = 0;
      activateLiquidCell(room, src, grid);   // the displaced liquid, now above, may need to flow/settle
      const sc = src % COLS; for (const j of [src - COLS, src + COLS, sc > 0 ? src - 1 : -1, sc < COLS - 1 ? src + 1 : -1]) if (j >= 0 && j < nn && isFluidId(grid[j]) && tot[j] > 0) liquidSet(room).add(j);
    }
    changedSet.add(src); changedSet.add(dst); active.add(dst); wakeAround(src);
  };
  for (const i of list) {
    if (!isPowderId(grid[i])) continue;
    const r = (i / COLS) | 0, c = i - r * COLS; if (r + 1 >= FLOOR_ROW) continue;
    const below = i + COLS;
    if (canDisplace(below)) { swapMove(i, below); continue; }
    for (const dc of (((i + tick) & 1) ? [-1, 1] : [1, -1])) { const cc = c + dc; if (cc < 0 || cc >= COLS) continue; const j = below + dc; if (canDisplace(j)) { swapMove(i, j); break; } }
    // couldn't fall or slide → rests (not re-added to active)
  }
  if (changedSet.size) {   // same wire encoding as liquidTickRoom: [i, gridId, side(|0x80 if s2), mask] + one amt per set rank + [s2amt,s2id]
    let arr = [], cells = 0;
    for (const j of changedSet) {
      const b = j * T; let mask = 0; for (let rk = 0; rk < T; rk++) if (amt[b + rk] > 0) mask |= (1 << rk);
      const hasS2 = s2a[j] > 0;
      arr.push(j, grid[j], sd[j] | (hasS2 ? 0x80 : 0), mask);
      for (let rk = 0; rk < T; rk++) if (mask & (1 << rk)) arr.push(amt[b + rk]);
      if (hasS2) arr.push(s2a[j], s2i[j]);
      if (++cells >= 8192) { emitLiquidCells(room, arr); arr = []; cells = 0; }
    }
    if (cells) emitLiquidCells(room, arr);
  }
  if (!active.size) delete roomPowderActive[room];
}
// ---- SATURATION reactions: earth→mud (cell-by-cell), sand→quicksand (wet CLUMP only), mud dries→earth (instant under lava).
// Runs INDEPENDENTLY of liquid activity (mud must keep drying after every pool has settled). Cells enter roomSoilActive via
// absorption in liquidTickRoom; solid↔solid + sand→quicksand changes ride the same `liquid-cells` wire (it carries gridId).
function soilTickRoom(room) {
  const ss = roomSoilActive[room]; if (!ss || !ss.size) { if (ss) delete roomSoilActive[room]; return; }
  const grid = roomTerrain[room], hp = roomTerrainHp[room];
  if (!grid) { delete roomSoilActive[room]; return; }
  const sat = ensureSat(room), mats = roomMats[room] || {}, COLS = TERRAIN_COLS, nn = grid.length, T = LIQ_T;
  const lam = ensureLiquidAmt(room), ltot = ensureLiquidTotal(room), sd = ensureLiquidSide(room);
  const changedSet = new Set();
  const adj = (i, id) => { const c = i % COLS; if (i - COLS >= 0 && grid[i - COLS] === id) return true; if (i + COLS < nn && grid[i + COLS] === id) return true; if (c > 0 && grid[i - 1] === id) return true; if (c < COLS - 1 && grid[i + 1] === id) return true; return false; };
  const adjWater = (i) => { const c = i % COLS; for (const j of [i - COLS, i + COLS, c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1]) { if (j < 0 || j >= nn) continue; if (grid[j] === 9 && lam[j * T + 4] > 0) return j; } return -1; };   // water = rank 4
  const wakeLiq = (j) => { if (j >= 0 && j < nn && isFluidId(grid[j]) && ltot[j] > 0) liquidSet(room).add(j); };
  for (const i of Array.from(ss)) {
    const v = grid[i];
    // ABSORPTION (pull): earth/sand draw water out of an adjacent pool into their saturation, draining it. Only pull from a
    // SETTLED pool (wj not in the active/flowing set) → absorption never fights or slows the leveling of a still-flowing pool.
    if ((v === 1 || v === 3) && sat[i] < SAT_MAX) {
      const wj = adjWater(i);
      if (wj >= 0) {                                     // absorb even while the pool is still flowing — SAT_MAX is small enough now that it barely dents leveling
        const take = Math.min(SAT_ABSORB, SAT_MAX - sat[i], lam[wj * T + 4]);   // water = rank 4
        if (take > 0) {
          sat[i] += take; lam[wj * T + 4] -= take; ltot[wj] -= take; if (ltot[wj] <= 0) { grid[wj] = 0; sd[wj] = 0; }
          changedSet.add(wj); activateLiquidCell(room, wj, grid);
          const wc = wj % COLS; wakeLiq(wj - COLS); wakeLiq(wj + COLS); if (wc > 0) wakeLiq(wj - 1); if (wc < COLS - 1) wakeLiq(wj + 1);   // re-level: the column above falls into the drained space (no hovering slivers)
        }
      }
    }
    if (v === 1) {                                       // EARTH → MUD once it has soaked up a cell's worth of water
      if (sat[i] >= SAT_MAX) { grid[i] = 5; hp[i] = matStrengthSrv(mats, 5); changedSet.add(i); }   // stays tracked (mud dries later)
      else if (sat[i] === 0 && !adj(i, 9)) ss.delete(i);
    } else if (v === 3) {                                // SAND → QUICKSAND, but only inside a wet CLUMP
      if (sat[i] >= SAT_MAX) {
        const r = (i / COLS) | 0, c = i - r * COLS; let clump = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue; const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || cc >= COLS) continue;
          const j = rr * COLS + cc; if (j < 0 || j >= nn) continue; const g = grid[j];
          if (g === 10 || (g === 3 && sat[j] >= SAT_MAX)) clump++;
        }
        if (clump >= SAT_CLUMP_MIN) { grid[i] = 10; liqSetSingle(room, i, 10); activateLiquidCell(room, i, grid); sat[i] = 0; changedSet.add(i); ss.delete(i); }
      } else if (sat[i] === 0 && !adj(i, 9)) ss.delete(i);
    } else if (v === 5) {                                // MUD: lava bakes it dry instantly; water keeps it wet; else it dries → earth
      if (adj(i, 11)) { grid[i] = 1; hp[i] = matStrengthSrv(mats, 1); sat[i] = 0; changedSet.add(i); ss.delete(i); }
      else if (adj(i, 9)) sat[i] = SAT_MAX;
      else { sat[i] = sat[i] > SAT_DRY ? sat[i] - SAT_DRY : 0; if (sat[i] === 0) { grid[i] = 1; hp[i] = matStrengthSrv(mats, 1); changedSet.add(i); ss.delete(i); } }
    } else { sat[i] = 0; ss.delete(i); }                 // cell dug/overwritten out from under us
  }
  if (changedSet.size && !liquidQuiet) {                 // same compact liquid-cells encoding as liquidTickRoom (solids → mask 0; quicksand/drained-water carry their stack)
    const s2a = ensureStream2Amt(room), s2i = ensureStream2Id(room);
    let arr = [], cells = 0;
    for (const j of changedSet) {
      const b = j * T; let mask = 0; for (let rk = 0; rk < T; rk++) if (lam[b + rk] > 0) mask |= (1 << rk);
      const hasS2 = s2a[j] > 0;
      arr.push(j, grid[j], sd[j] | (hasS2 ? 0x80 : 0), mask);
      for (let rk = 0; rk < T; rk++) if (mask & (1 << rk)) arr.push(lam[b + rk]);
      if (hasS2) arr.push(s2a[j], s2i[j]);
      if (++cells >= 8192) { emitLiquidCells(room, arr); arr = []; cells = 0; }
    }
    if (cells) emitLiquidCells(room, arr);
  }
  if (!ss.size) delete roomSoilActive[room];
}
// ── FINE-CELL LIQUID TICK ── the coarse multi-liquid CORE FLOW (density sorts 2/2b · straight-down 1a · ledge spill 1b ·
// lateral levelling 1c/1d · per-liquid levelling 2c · fallSide tag), reproduced at SUB× resolution in the roomFine* arrays.
// Solids are read from the coarse terrain via coarseOf() (map-on-read, no terrain mirror; NEVER writes terrain). DROPLETS,
// REACTIONS, SINKS, the secondary lane and flux levelling are OMITTED (inc 1 = pipeline; reactions come next). Honours the
// same liquidCfg flags so behaviour matches. PROVEN faithful by the harness SUB=1 identity test (fineLiquidTickRoom(room,1)
// == liquidTickRoom with droplets+reactions off, on reaction-free scenes).
function fineLiquidTickRoom(room, SUB) {
  SUB = SUB || roomFineSub[room] || 3;
  const grid = roomTerrain[room], amt = roomFineAmt[room], tot = roomFineTotal[room], active = roomFineActive[room];
  if (!grid || !amt || !tot || !active || !active.size) { if (active && !active.size) delete roomFineActive[room]; return; }
  const sd = roomFineSide[room], lvlAcc = roomFineLevelAcc[room];
  const tick = liquidTickCount, cap = LIQUID_MAX, T = LIQ_T;
  const COLS = TERRAIN_COLS * SUB, NCELL = COLS * (TERRAIN_ROWS * SUB);
  const LIQUID_FLOOR_ROW = Math.floor(FLOOR_TOP / TERRAIN_CELL) * SUB;   // liquid may not descend into/below the bedrock row (scaled to fine rows)
  const SCAN = LIQUID_LEVEL_SCAN * SUB;                                  // levelling scan reach in CELLS → scaled so PHYSICAL reach is unchanged
  const coarseOf = (k) => { const fr = (k / COLS) | 0, fc = k - fr * COLS; return ((fr / SUB) | 0) * TERRAIN_COLS + ((fc / SUB) | 0); };
  const isSolid = (k) => { if (k < 0 || k >= NCELL) return true; const v = grid[coarseOf(k)]; return v !== 0 && !isFluidId(v); };   // fine solid = the coarse terrain cell it sits in
  const isSinkF = (k) => { if (k < 0 || k >= NCELL) return false; return isSinkId(grid[coarseOf(k)]); };   // a fine cell whose coarse cell is a DRAIN block
  const sinkRate = Math.max(0, Math.min(cap, liquidCfg.sinkRate | 0)), sinkLed = sinkLedger(room);
  const list = Array.from(active); active.clear();
  list.sort((a, b) => { const ra = (a / COLS) | 0, rb = (b / COLS) | 0; if (ra !== rb) return rb - ra; const la = tot[a], lb = tot[b]; if (la !== lb) return la - lb; return (tick & 1) ? a - b : b - a; });
  const changedSet = new Set(), tagCleared = new Set(), fell = new Set(), fellDown = new Set();
  const wake = (j) => { if (j >= 0 && j < NCELL && !isSolid(j) && tot[j] > 0) active.add(j); };
  const wakeN = (j) => { const x = j % COLS; wake(j - COLS); wake(j + COLS); if (x > 0) wake(j - 1); if (x < COLS - 1) wake(j + 1); };
  const wakeD = (j) => { wakeN(j); const x = j % COLS; if (x > 0) { wake(j - COLS - 1); wake(j + COLS - 1); } if (x < COLS - 1) { wake(j - COLS + 1); wake(j + COLS + 1); } };
  const mark = (j) => { changedSet.add(j); active.add(j); };
  const recomp = (j) => { let s = 0, b = j * T; for (let k = 0; k < T; k++) s += amt[b + k]; tot[j] = s; };
  const moveBottom = (A, B, t) => { let need = t; const ba = A * T, bb = B * T; for (let rk = 0; rk < T && need > 0; rk++) { const a = amt[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; amt[ba + rk] = a - mv; amt[bb + rk] += mv; need -= mv; } const moved = t - need; if (moved) { tot[A] -= moved; tot[B] += moved; mark(A); mark(B); } return moved; };
  const moveTop = (A, B, t) => { let need = t; const ba = A * T, bb = B * T; for (let rk = T - 1; rk >= 0 && need > 0; rk--) { const a = amt[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; amt[ba + rk] = a - mv; amt[bb + rk] += mv; need -= mv; } const moved = t - need; if (moved) { tot[A] -= moved; tot[B] += moved; mark(A); mark(B); } return moved; };
  const moveProp = (A, B, t) => { const ba = A * T, bb = B * T, TA = tot[A]; if (TA <= 0 || t <= 0) return 0; let need = t, moved = 0;
    for (let rk = 0; rk < T && need > 0; rk++) { const a = amt[ba + rk]; if (a <= 0) continue; let mv = Math.round(t * a / TA); if (mv > a) mv = a; if (mv > need) mv = need; if (mv <= 0) continue; amt[ba + rk] -= mv; amt[bb + rk] += mv; need -= mv; moved += mv; }
    for (let rk = 0; rk < T && need > 0; rk++) { const a = amt[ba + rk]; if (a <= 0) continue; const mv = a < need ? a : need; amt[ba + rk] -= mv; amt[bb + rk] += mv; need -= mv; moved += mv; }
    if (moved) { tot[A] -= moved; tot[B] += moved; mark(A); mark(B); } return moved; };
  const floorRank = (j) => { const b = j * T; for (let rk = 0; rk < T; rk++) if (amt[b + rk] > 0) return rk; return -1; };
  const ceilRank = (j) => { const b = j * T; for (let rk = T - 1; rk >= 0; rk--) if (amt[b + rk] > 0) return rk; return -1; };
  let processed = 0;
  for (const i of list) {
    if (processed >= LIQUID_MAX_PER_TICK) { active.add(i); continue; }
    if (isSolid(i)) continue;
    const r = (i / COLS) | 0, c = i - r * COLS, canDown = r + 1 < LIQUID_FLOOR_ROW;
    let L = tot[i]; if (L <= 0) continue;
    processed++;
    // ---- SINK (drain block id 17): a fine cell touching a coarse drain block loses liquid, heaviest first (ledgered).
    if (sinkRate > 0 && (isSinkF(i + COLS) || isSinkF(i - COLS) || (c > 0 && isSinkF(i - 1)) || (c < COLS - 1 && isSinkF(i + 1)))) {
      let need = sinkRate < L ? sinkRate : L; const sb = i * T;
      for (let rk = 0; rk < T && need > 0; rk++) { const a = amt[sb + rk]; if (a <= 0) continue; const mv = a < need ? a : need; amt[sb + rk] = a - mv; sinkLed[rk] += mv; need -= mv; }
      recomp(i); mark(i); wakeN(i); L = tot[i]; if (L <= 0) continue;
    }
    // (fine pipeline: no secondary lane, reactions or droplets — inc 1)
    const noSortStream = liquidCfg.streamNoSort && liquidCfg.streamTag && sd[i] !== 0;
    const noSortNbr = liquidCfg.streamNoSortNbr && liquidCfg.streamTag;
    // (2) density sort with the cell BELOW
    if (liquidCfg.densitySort && !noSortStream && canDown && tot[i + COLS] > 0 && !isSolid(i + COLS) && !(noSortNbr && sd[i + COLS] !== 0)) {
      const j = i + COLS, hi = floorRank(i), lo = ceilRank(j);
      if (hi >= 0 && lo >= 0 && hi < lo) { const k = Math.min(amt[i * T + hi], amt[j * T + lo], liquidCfg.sortRate); amt[i * T + hi] -= k; amt[j * T + hi] += k; amt[j * T + lo] -= k; amt[i * T + lo] += k; mark(i); mark(j); wakeD(i); wakeD(j); }
    }
    // (2b) diagonal density sort
    if (liquidCfg.densitySort && !noSortStream && canDown) for (const dc of (((tick + i) & 1) ? [-1, 1] : [1, -1])) {
      const cc = c + dc; if (cc < 0 || cc >= COLS) continue;
      const j = i + COLS + dc; if (isSolid(j) || tot[j] === 0) continue;
      if (noSortNbr && sd[j] !== 0) continue;
      const hi = floorRank(i), lo = ceilRank(j);
      if (hi >= 0 && lo >= 0 && hi < lo) { const k = Math.min(amt[i * T + hi], amt[j * T + lo], liquidCfg.sortRate); amt[i * T + hi] -= k; amt[j * T + hi] += k; amt[j * T + lo] -= k; amt[i * T + lo] += k; mark(i); mark(j); wakeD(i); wakeD(j); break; }
    }
    // (1a) straight down (tag carried only onto air / an already-falling cell)
    if (canDown) { const j = i + COLS; const room2 = cap - tot[j]; if (!isSolid(j) && room2 > 0) { const t = Math.min(L, room2); if (t > 0) { const wasAirJ = tot[j] === 0; moveBottom(i, j, t); if (liquidCfg.streamTag && sd[i] !== 0 && (wasAirJ || fell.has(j))) sd[j] = sd[i]; L -= t; wakeN(i); } } }
    // density throttle (viscosity off by default → lf=1 → reduce is a pass-through)
    const cr = ceilRank(i), lf = (liquidCfg.viscosity && cr >= 0) ? 1 / (1 + LEVEL_VISC[cr]) : 1;
    let pend = false;
    const reduce = (want) => { if (want <= 0) return 0; if (lf >= 1) return want; lvlAcc[i] += want * lf; let mv = lvlAcc[i] | 0; if (mv > want) mv = want; lvlAcc[i] -= mv; if (mv <= 0) pend = true; return mv; };
    // (1b) ledge spill — plain (no chute/secondary-lane, no droplet cascade), with the mid-air support guard. Gated on
    // fineLedge: OFF ⇒ skip it and let 1c move liquid into the edge cell + 1a drop it (same result, one tick slower).
    if (liquidCfg.ledgeSpill && liquidCfg.fineLedge && L > 0 && canDown && (isSolid(i + COLS) || tot[i + COLS] >= cap)) for (const dc of (((tick + i) & 1) ? [-1, 1] : [1, -1])) { if (L <= 0) break; const cc = c + dc; if (cc < 0 || cc >= COLS) continue; const j = i + COLS + dc; if (isSolid(j)) continue;
      if (!isSolid(i + COLS)) { const jb = j + COLS; const jSupported = ((j / COLS) | 0) + 1 >= LIQUID_FLOOR_ROW || isSolid(jb) || tot[jb] > 0; if (!jSupported) continue; }
      if (tot[j] < cap) { const t = reduce(Math.min(L, cap - tot[j])); const ns = dc > 0 ? SIDE_LEFT : SIDE_RIGHT;
        const tagOk = !liquidCfg.streamTag || (isSolid(i + COLS) && (tot[j] === 0 || fell.has(j)));
        if (t > 0) { (liquidCfg.streamMix ? moveProp : moveBottom)(i, j, t); if (tagOk) sd[j] = ns; L -= t; wakeN(i); } }
    }
    const roomAt = (j) => !isSolid(j) && tot[j] < cap;
    const canFall = canDown && (roomAt(i + COLS) || fell.has(i + COLS) || (c > 0 && roomAt(i + COLS - 1)) || (c < COLS - 1 && roomAt(i + COLS + 1)));
    if (canFall) fell.add(i);
    const airborne = canDown && (roomAt(i + COLS) || fellDown.has(i + COLS));
    if (airborne) fellDown.add(i);
    if (!canFall) { if (liquidCfg.streamTag && sd[i] !== 0) { sd[i] = 0; tagCleared.add(i); } }
    const isStream = liquidCfg.levelGate === 0 ? canFall
                   : liquidCfg.levelGate === 3 ? (sd[i] !== 0 || airborne)
                   : liquidCfg.levelGate === 2 ? (sd[i] !== 0)
                   : (sd[i] !== 0 || (canDown && roomAt(i + COLS)));
    const shedCap = L;
    if (!isStream) {
      const cumAt = (jj, tt) => { let s = 0; const bb = jj * T; for (let k = 0; k <= tt; k++) s += amt[bb + k]; return s; };
      // (2c) per-liquid horizontal levelling (pools only)
      if (liquidCfg.perLiquidLevel) for (let t = 0; t < T - 1; t++) {
        if (amt[i * T + t] <= 0) continue;
        const Ci = cumAt(i, t);
        let dir = 0, best = Infinity;
        for (const sdir of [-1, 1]) for (let d = 1; d <= SCAN; d++) { const cc = c + sdir * d; if (cc < 0 || cc >= COLS) break; const j2 = i + sdir * d; if (isSolid(j2)) break; const Cj = cumAt(j2, t); if (Cj > Ci) break; if (Cj <= Ci - 2) { if (d < best) { best = d; dir = sdir; } break; } }
        if (dir === 0) continue;
        const j = i + dir; if (isSolid(j)) continue;
        const Cj = cumAt(j, t);
        if (Cj >= Ci) continue;
        let avail = 0; for (let k = t + 1; k < T; k++) avail += amt[j * T + k];
        if (avail <= 0) continue;
        let n = (Ci - Cj) >> 1;
        if (n > amt[i * T + t]) n = amt[i * T + t];
        if (n > avail) n = avail;
        if (n < 1) n = 1;
        n = reduce(n);
        if (n <= 0) continue;
        amt[i * T + t] -= n; amt[j * T + t] += n;
        let need = n; for (let q = t + 1; q < T && need > 0; q++) { const a = amt[j * T + q]; if (a <= 0) continue; const mv = a < need ? a : need; amt[j * T + q] -= mv; amt[i * T + q] += mv; need -= mv; }
        mark(i); mark(j); wakeD(i); wakeD(j);
      }
      const lvlMove = liquidCfg.levelMix ? moveProp : moveTop;
      // (1c) lateral equalise (symmetric)
      if (liquidCfg.lateralLevel && !liquidCfg.fluxLevel && L > 1) {
        if (liquidCfg.symLevel) {
          const jL = c > 0 ? i - 1 : -1, jR = c < COLS - 1 ? i + 1 : -1;
          const okL = jL >= 0 && !isSolid(jL) && L - tot[jL] > 1;
          const okR = jR >= 0 && !isSolid(jR) && L - tot[jR] > 1;
          let sum = L, cnt = 1; if (okL) { sum += tot[jL]; cnt++; } if (okR) { sum += tot[jR]; cnt++; }
          if (cnt > 1) {
            const avg = sum / cnt;
            let shedL = okL ? Math.min(avg - tot[jL], cap - tot[jL]) : 0;
            let shedR = okR ? Math.min(avg - tot[jR], cap - tot[jR]) : 0;
            if (shedL < 0) shedL = 0; if (shedR < 0) shedR = 0;
            const denom = shedL + shedR; let total = reduce(Math.floor(denom));
            if (total > shedCap) total = shedCap;
            if (total > 0 && denom > 0) {
              let mvL = Math.round(total * shedL / denom); if (mvL > total) mvL = total; const mvR = total - mvL;
              if (mvL > 0) { lvlMove(i, jL, mvL); sd[jL] = 0; L -= mvL; wakeN(i); }
              if (mvR > 0) { lvlMove(i, jR, mvR); sd[jR] = 0; L -= mvR; wakeN(i); }
            }
          }
        } else for (const dc of (((tick + i) & 1) ? [-1, 1] : [1, -1])) { const cc = c + dc; if (cc < 0 || cc >= COLS) continue; const j = i + dc; if (isSolid(j)) continue; const nl = tot[j], room2 = cap - nl; if (L - nl > 1 && room2 > 0) { const mv = Math.min(reduce(Math.min((L - nl) >> 1, room2)), shedCap); if (mv > 0) { lvlMove(i, j, mv); sd[j] = 0; L -= mv; wakeN(i); } } }
      }
      // (1d) surface flat-settle
      if (liquidCfg.lateralLevel && !liquidCfg.fluxLevel && L > 0) {
        let dir = 0, best = Infinity;
        for (const sdir of [-1, 1]) for (let d = 1; d <= SCAN; d++) { const cc = c + sdir * d; if (cc < 0 || cc >= COLS) break; const j = i + sdir * d; if (isSolid(j)) break; const jl = tot[j]; if (jl > L) break; if (jl <= L - 2) { if (d < best) { best = d; dir = sdir; } break; } }
        if (dir !== 0 && shedCap >= 1) { const j = i + dir; if (tot[j] < L && tot[j] < cap && reduce(1) > 0) { lvlMove(i, j, 1); sd[j] = 0; L -= 1; wakeN(i); } }
      }
    }
    if (pend) active.add(i);
    if (changedSet.has(i)) wakeN(i);
  }
  for (const j of tagCleared) changedSet.add(j);
  if (changedSet.size && !liquidQuiet) {
    // WIRE (liquid-fine-cells): sub + cols so the client can decode fine indices, then per changed cell
    // [index, repId, side(low2=fallSide, 0x40=airborne), mask] followed by one amt per set rank bit.
    let arr = [], cells = 0;
    for (const j of changedSet) {
      const b = j * T; let mask = 0; for (let rk = 0; rk < T; rk++) if (amt[b + rk] > 0) mask |= (1 << rk);
      arr.push(j, liqRepId(amt, j), (sd[j] & 0x03) | (fellDown.has(j) ? 0x40 : 0), mask);
      for (let rk = 0; rk < T; rk++) if (mask & (1 << rk)) arr.push(amt[b + rk]);
      if (++cells >= 8192) { io.to(room).emit('liquid-fine-cells', { sub: SUB, cols: COLS, cells: arr }); arr = []; cells = 0; }
    }
    if (cells) io.to(room).emit('liquid-fine-cells', { sub: SUB, cols: COLS, cells: arr });
  }
  for (const j of Array.from(active)) { if (j < 0 || j >= NCELL) { active.delete(j); continue; } if (isSolid(j) || tot[j] <= 0) active.delete(j); }
  if (!active.size) delete roomFineActive[room];
}
// ==LIQUID_SIM_BLOCK_END== (test harness slices the sim to this marker)
// Restartable sim loop — the tick rate is liquidCfg.tickMs so the Liquid Debug menu can speed it up/slow it down live.
let liquidTimer = null;
let liquidStepsPending = 0;                           // ticks the debug panel has asked for while paused
const runLiquidTick = () => {
  // FROZEN. Nothing advances — not the grid, not droplets in flight, not powder or soil — until either the pause is
  // lifted or a step is requested, so what you are looking at is exactly what the sim last produced.
  if (liquidCfg.paused) { if (liquidStepsPending <= 0) return; liquidStepsPending--; }
  const _t0 = liquidCfg.perfLog ? performance.now() : 0; let _active = 0;
  liquidTickCount++;
  // Droplets fly BEFORE the grid ticks, so a droplet is broadcast at the position it spawned at rather than already a
  // fall-step below it, and so liquid that lands cannot also leave the cell in the same tick.
  for (const room in roomLiquidSrc) sourceTickRoom(room);   // sources top up first, so their liquid is ordinary pooled liquid to everything below
  if (liquidCfg.droplets) for (const room in roomDroplets) dropletTickRoom(room);
  for (const room in roomLiquidActive) { if (liquidCfg.perfLog) _active += roomLiquidActive[room].size; liquidTickRoom(room); }
  // FINE-CELL liquid (experimental) — a parallel sim in its own arrays, ticked only when liquidCfg.sub > 1
  if (liquidCfg.sub > 1) for (const room in roomFineActive) { if (liquidCfg.perfLog) _active += roomFineActive[room].size; fineLiquidTickRoom(room, roomFineSub[room] || liquidCfg.sub); }
  powderTickCount++; for (const room in roomPowderActive) powderTickRoom(room);   // powder runs in lockstep with liquid → consistent gravity
  if ((liquidTickCount & 3) === 0) for (const room in roomSoilActive) soilTickRoom(room);
  if (liquidCfg.perfLog) {
    const _dt = performance.now() - _t0; liqPerf.simMs += _dt; if (_dt > liqPerf.simMsMax) liqPerf.simMsMax = _dt;
    if (_active > liqPerf.active) liqPerf.active = _active; liqPerf.ticks++;
    if (liqPerf.ticks >= Math.max(1, Math.round(1000 / liquidCfg.tickMs))) {   // ~once per real second
      const _hz = 1000 / liquidCfg.tickMs, _rooms = Object.keys(roomLiquidActive).length;
      const _stat = { rooms: _rooms, active: liqPerf.active, avgMs: +(liqPerf.simMs / liqPerf.ticks).toFixed(2), maxMs: +liqPerf.simMsMax.toFixed(2), kbs: +(liqPerf.bytes * _hz / liqPerf.ticks / 1024).toFixed(1), budgetMs: liquidCfg.tickMs };
      console.log(`[liq-perf] rooms=${_stat.rooms} active(peak)=${_stat.active} sim/tick avg=${_stat.avgMs}ms max=${_stat.maxMs}ms  emit=${_stat.kbs}KB/s (×clients-in-room = server upload; budget/tick=${_stat.budgetMs}ms)`);
      io.emit('liquid-perf', _stat);                       // mirrored to the Liquid Debug panel so it's visible while testing
      liqPerf = { simMs: 0, simMsMax: 0, active: 0, bytes: 0, ticks: 0 };
    }
  }
};
function restartLiquidLoop() { if (liquidTimer) clearInterval(liquidTimer); liquidTimer = setInterval(runLiquidTick, Math.max(8, Math.min(500, liquidCfg.tickMs | 0))); }
restartLiquidLoop();

// ── FINE-CELL LIQUID: coarse↔fine conversion + placement + wire helpers (inc 1). All outside the sim block, so the
// harness never sees them. Volume mapping: a coarse cell holds up to LIQUID_MAX units; a full coarse cell = SUB² full fine
// cells, so upscale multiplies units by SUB² and downscale divides by SUB².
function fineSetBlock(room, SUB, cc, cr, coarseAmt) {   // distribute a coarse rank-stack into the SUB×SUB fine block (heaviest at the floor, bottom-up); returns the filled fine indices
  const amt = roomFineAmt[room], tot = roomFineTotal[room], FCOLS = TERRAIN_COLS * SUB, act = fineSet(room);
  const per = new Array(LIQ_T); let totalUnits = 0;
  for (let rk = 0; rk < LIQ_T; rk++) { per[rk] = coarseAmt[rk] * SUB * SUB; totalUnits += per[rk]; }
  const fx0 = cc * SUB, fy0 = cr * SUB, filled = [];
  for (let dy = 0; dy < SUB; dy++) for (let dx = 0; dx < SUB; dx++) { const i = (fy0 + dy) * FCOLS + (fx0 + dx), b = i * LIQ_T; for (let k = 0; k < LIQ_T; k++) amt[b + k] = 0; tot[i] = 0; }
  let rk = 0;
  for (let dy = SUB - 1; dy >= 0 && totalUnits > 0; dy--) for (let dx = 0; dx < SUB && totalUnits > 0; dx++) {
    const i = (fy0 + dy) * FCOLS + (fx0 + dx), b = i * LIQ_T; let room2 = LIQUID_MAX;
    while (room2 > 0 && totalUnits > 0) { while (rk < LIQ_T && per[rk] <= 0) rk++; if (rk >= LIQ_T) { totalUnits = 0; break; } const mv = Math.min(per[rk], room2); amt[b + rk] += mv; per[rk] -= mv; room2 -= mv; totalUnits -= mv; }
    tot[i] = LIQUID_MAX - room2; if (tot[i] > 0) { act.add(i); filled.push(i); }
  }
  return filled;
}
function fineClearBlock(room, SUB, cc, cr) {   // clear the SUB×SUB fine block; returns the fine indices that changed
  const amt = roomFineAmt[room], tot = roomFineTotal[room], sd = roomFineSide[room], FCOLS = TERRAIN_COLS * SUB, act = fineSet(room);
  const fx0 = cc * SUB, fy0 = cr * SUB, changed = [];
  for (let dy = 0; dy < SUB; dy++) for (let dx = 0; dx < SUB; dx++) { const i = (fy0 + dy) * FCOLS + (fx0 + dx), b = i * LIQ_T; if (tot[i] > 0 || sd[i]) { for (let k = 0; k < LIQ_T; k++) amt[b + k] = 0; tot[i] = 0; sd[i] = 0; act.delete(i); changed.push(i); } }
  return changed;
}
function fineToCoarseCell(room, SUB, cc, cr) {   // average a fine block back down to a coarse rank-stack (÷SUB²), clamped to CAP
  const amt = roomFineAmt[room], FCOLS = TERRAIN_COLS * SUB, out = new Array(LIQ_T).fill(0), fx0 = cc * SUB, fy0 = cr * SUB;
  for (let dy = 0; dy < SUB; dy++) for (let dx = 0; dx < SUB; dx++) { const b = ((fy0 + dy) * FCOLS + (fx0 + dx)) * LIQ_T; for (let k = 0; k < LIQ_T; k++) out[k] += amt[b + k]; }
  const div = SUB * SUB; let ct = 0; for (let k = 0; k < LIQ_T; k++) { out[k] = Math.round(out[k] / div); ct += out[k]; }
  let ex = ct - LIQUID_MAX; for (let k = LIQ_T - 1; k >= 0 && ex > 0; k--) { const d = Math.min(out[k], ex); out[k] -= d; ex -= d; }   // trim overflow from the lightest
  return out;
}
function upscaleRoomToFine(room, SUB) {   // convert this room's coarse liquid into the fine grid; coarse liquid is then cleared (fine owns it)
  ensureFineArrays(room, SUB);
  roomFineAmt[room].fill(0); roomFineTotal[room].fill(0); roomFineSide[room].fill(0); fineSet(room).clear();
  const camt = roomLiquidAmt[room], ctot = roomLiquidTotal[room];
  if (camt && ctot) for (let i = 0; i < ctot.length; i++) { if (ctot[i] <= 0) continue; const cc = i % TERRAIN_COLS, cr = (i / TERRAIN_COLS) | 0, ca = new Array(LIQ_T), b = i * LIQ_T; for (let k = 0; k < LIQ_T; k++) ca[k] = camt[b + k]; fineSetBlock(room, SUB, cc, cr, ca); }
  if (camt) camt.fill(0); if (ctot) ctot.fill(0); if (roomLiquidActive[room]) roomLiquidActive[room].clear();
}
function downscaleRoomToCoarse(room, SUB) {   // convert the fine grid back into coarse liquid; fine is then cleared
  const grid = roomTerrain[room]; if (!grid || !roomFineTotal[room]) return;
  const amt = ensureLiquidAmt(room), tot = ensureLiquidTotal(room), s = liquidSet(room);
  amt.fill(0); tot.fill(0); s.clear();
  for (let cr = 0; cr < TERRAIN_ROWS; cr++) for (let cc = 0; cc < TERRAIN_COLS; cc++) {
    const out = fineToCoarseCell(room, SUB, cc, cr); let ct = 0; for (let k = 0; k < LIQ_T; k++) ct += out[k];
    if (ct > 0) { const i = cr * TERRAIN_COLS + cc, b = i * LIQ_T; for (let k = 0; k < LIQ_T; k++) amt[b + k] = out[k]; tot[i] = ct; grid[i] = liqRepId(amt, i); if (s.size < LIQUID_MAX_ACTIVE) s.add(i); }
  }
  roomFineAmt[room].fill(0); roomFineTotal[room].fill(0); roomFineSide[room].fill(0); fineSet(room).clear();
}
function fineWirePush(room, idxList, cells) {   // append [i, repId, side, mask, amts…] for each fine cell in idxList
  const amt = roomFineAmt[room], sd = roomFineSide[room];
  for (const i of idxList) { const b = i * LIQ_T; let mask = 0; for (let rk = 0; rk < LIQ_T; rk++) if (amt[b + rk] > 0) mask |= (1 << rk); cells.push(i, liqRepId(amt, i), (sd[i] & 3), mask); for (let rk = 0; rk < LIQ_T; rk++) if (mask & (1 << rk)) cells.push(amt[b + rk]); }
}
function emitFineCells(room, idxList) {   // broadcast a set of fine cells immediately (used by placement — the tick only broadcasts what MOVED)
  if (!idxList.length || !roomFineAmt[room]) return;
  const SUB = roomFineSub[room] || liquidCfg.sub, cells = []; fineWirePush(room, idxList, cells);
  if (cells.length) io.to(room).emit('liquid-fine-cells', { sub: SUB, cols: TERRAIN_COLS * SUB, cells });
}
function buildFineInit(room) {   // join replay: every non-empty fine cell (same mask encoding)
  const tot = roomFineTotal[room]; if (!tot) return null;
  const SUB = roomFineSub[room] || liquidCfg.sub, idx = []; for (let i = 0; i < tot.length; i++) if (tot[i] > 0) idx.push(i);
  const cells = []; fineWirePush(room, idx, cells);
  return { sub: SUB, cols: TERRAIN_COLS * SUB, cells };
}
function fineActivateRect(room, grid, c0, r0, c1, r1) {   // placement in fine mode: seed/clear the fine block for each painted coarse cell + broadcast
  const SUB = liquidCfg.sub; ensureFineArrays(room, SUB);
  c0 = Math.max(0, c0); r0 = Math.max(0, r0); c1 = Math.min(TERRAIN_COLS - 1, c1); r1 = Math.min(TERRAIN_ROWS - 1, r1);
  const changed = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const i = r * TERRAIN_COLS + c;
    if (isFluidId(grid[i])) { const ca = new Array(LIQ_T).fill(0); ca[LIQ_RANK[grid[i]]] = LIQUID_MAX; for (const x of fineSetBlock(room, SUB, c, r, ca)) changed.push(x); }
    else for (const x of fineClearBlock(room, SUB, c, r)) changed.push(x);
  }
  emitFineCells(room, changed);
}
// SOURCE tick for the fine grid: each source coarse cell tops up its SUB×SUB fine block (bottom-fill) by rate·SUB² units
// of its rank per tick (rate·SUB² keeps the physical refill rate the same as the coarse source). Ledgered like the coarse one.
function sourceTickRoomFine(room, SUB) {
  const src = roomLiquidSrc[room]; if (!src || !src.size) return;
  const grid = roomTerrain[room]; if (!grid) return;
  ensureFineArrays(room, SUB);
  const amt = roomFineAmt[room], tot = roomFineTotal[room], act = fineSet(room), led = srcLedger(room), FCOLS = TERRAIN_COLS * SUB, cap = LIQUID_MAX, touched = new Set();
  for (const [ci, s] of src) {
    if (ci < 0 || ci >= grid.length || isSinkId(grid[ci]) || isSolidCell(grid[ci])) { src.delete(ci); continue; }
    const rank = s.rank | 0, rate = Math.max(0, Math.min(cap, (s.rate === undefined ? liquidCfg.srcRate : s.rate) | 0));
    if (!rate) continue;
    let toAdd = rate * SUB * SUB; const cc = ci % TERRAIN_COLS, cr = (ci / TERRAIN_COLS) | 0, fx0 = cc * SUB, fy0 = cr * SUB;
    for (let dy = SUB - 1; dy >= 0 && toAdd > 0; dy--) for (let dx = 0; dx < SUB && toAdd > 0; dx++) {
      const i = (fy0 + dy) * FCOLS + (fx0 + dx), free = cap - tot[i]; if (free <= 0) continue;
      const add = free < toAdd ? free : toAdd; amt[i * LIQ_T + rank] += add; tot[i] += add; led[rank] += add; toAdd -= add; act.add(i); touched.add(i);
    }
  }
  if (!src.size) delete roomLiquidSrc[room];
  if (touched.size) emitFineCells(room, Array.from(touched));
}
// Rescale every room's liquid (coarse + fine) from the current LIQUID_MAX to `newCap` so a full cell stays full when the
// cell-capacity slider changes. Uint8-safe (clamped ≤255). Recomputes totals. Caller then sets LIQUID_MAX + re-broadcasts.
function rescaleAllLiquid(newCap) {
  const oldCap = LIQUID_MAX; if (newCap === oldCap || oldCap <= 0) return;
  const f = newCap / oldCap;
  const doArr = (amtArr, totArr) => { if (!amtArr || !totArr) return; for (let i = 0; i < totArr.length; i++) { const b = i * LIQ_T; let s = 0; for (let k = 0; k < LIQ_T; k++) { let v = Math.round(amtArr[b + k] * f); if (v > 255) v = 255; amtArr[b + k] = v; s += v; } totArr[i] = s > 255 ? 255 : s; } };
  for (const room in roomLiquidAmt) doArr(roomLiquidAmt[room], roomLiquidTotal[room]);
  for (const room in roomFineAmt) doArr(roomFineAmt[room], roomFineTotal[room]);
}

const TERRAIN_MAT_MAX = 17;                           // built-in material ids 1..17 (earth/stone/sand/ice/mud/bouncy/belt→/snow/water/quicksand/lava/acid/belt←/brine/oil/glass/drain); 0 = empty
const TERRAIN_MAT_HI = 255;                          // grid is Uint8 → custom material ids live in 16..255
// ---- Custom material registry (Stage 6 feature A): per-room map of custom mat id → opaque appearance/property def.
// The server stores + dedups + assigns ids; it does NOT interpret the def physically (the client clones a base mat).
const CUSTOM_MAT_MIN = 18, CUSTOM_MAT_CAP = 200;     // custom mat ids start at 18 (built-ins 1..17: Glass=16, Drain=17 — the client's CUSTOM_MAT_FLOOR must match); up to 200 custom mats per room
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
  const tg = roomTerrain[avRoom];
  if (tg) { for (let i = 0; i < tg.length; i++) if (tg[i]) return false; }
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
    if ((l.terrain.cols | 0) !== TERRAIN_COLS || (l.terrain.rows | 0) !== TERRAIN_ROWS) return null;  // foreign world size
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
  grid.fill(0); hp.fill(0);
  // Phase 6: confine generation to the playable band + margin (null band = full world). Terrain/scatter
  // outside [genC0, genC1] is skipped so a small Level doesn't gen (or save) ground it can't reach.
  const genC0 = band ? Math.max(0, band.c0) : 0;
  const genC1 = band ? Math.min(TERRAIN_COLS - 1, band.c1) : TERRAIN_COLS - 1;
  const inBand = (c) => c >= genC0 && c <= genC1;
  const rng = mulberry32(seed);
  const set = (c, r, v) => { if (c < 0 || c >= TERRAIN_COLS || r < 0 || r >= TERRAIN_ROWS) return; const i = r * TERRAIN_COLS + c; grid[i] = v; hp[i] = v ? matStrengthSrv({}, v) : 0; };
  const at = (c, r) => (c < 0 || c >= TERRAIN_COLS || r < 0 || r >= TERRAIN_ROWS) ? 0 : grid[r * TERRAIN_COLS + c];
  const bottomRow = Math.ceil(FLOOR_TOP / TERRAIN_CELL) - 1;            // last terrain row resting on the floor
  const baseRow = Math.round(bottomRow * 0.47);                        // mean surface row ≈ mid-height (deep underground below)
  const CRUST = 4;                                                     // biome soil crust thickness (rows)
  // Heightmap: 3 octaves, random phase + amplitude (tuned for the wide world).
  const p0 = rng() * Math.PI * 2, p1 = rng() * Math.PI * 2, p2 = rng() * Math.PI * 2;
  const a0 = 7 + rng() * 7, a1 = 3 + rng() * 3, a2 = 1 + rng() * 2;
  const heightAt = (c) => { const h = Math.sin(c * 0.016 + p0) * a0 + Math.sin(c * 0.05 + p1) * a1 + Math.sin(c * 0.12 + p2) * a2; const s = Math.round(baseRow - h); return s < 6 ? 6 : (s > bottomRow - 10 ? bottomRow - 10 : s); };
  // Surface biomes: a slow field over the width → 6 biomes (drives crust material + trees + surface pools).
  const bp0 = rng() * Math.PI * 2, bp1 = rng() * Math.PI * 2, bp2 = rng() * Math.PI * 2;
  const surfBiome = (c) => { const v = Math.sin(c * 0.010 + bp0) + 0.5 * Math.sin(c * 0.023 + bp1) + 0.3 * Math.sin(c * 0.043 + bp2);
    if (v > 1.05) return 'snow'; if (v > 0.35) return 'forest'; if (v < -1.05) return 'volcanic'; if (v < -0.5) return 'desert'; if (v < -0.1) return 'swamp'; return 'plains'; };
  // Underground biome regions: an independent slow field → 6 depth-regions (veins, cave pool fluid, scatter).
  const gp0 = rng() * Math.PI * 2, gp1 = rng() * Math.PI * 2;
  const ugBiome = (c) => { const v = Math.sin(c * 0.0055 + gp0) + 0.6 * Math.sin(c * 0.015 + gp1);
    if (v > 1.15) return 'frozen'; if (v > 0.4) return 'fungal'; if (v < -1.15) return 'molten'; if (v < -0.45) return 'crystal'; if (v < -0.05) return 'sandstone'; return 'caverns'; };
  const seaRow = baseRow + 6;                                          // valleys deeper than this flood with Water
  // Flat spawn plateau, clamped above the water line so spawn is dry + level.
  const centerCol = Math.floor((MWSim.C.WORLD_W / 2) / TERRAIN_CELL);
  const plateauHalf = Math.ceil(SPAWN_CLEAR_HALF_W / TERRAIN_CELL) + 3;
  let plateauSurf = heightAt(centerCol); if (plateauSurf > seaRow - 3) plateauSurf = seaRow - 3; if (plateauSurf < 6) plateauSurf = 6;
  const surf = new Int16Array(TERRAIN_COLS);
  for (let c = 0; c < TERRAIN_COLS; c++) surf[c] = (Math.abs(c - centerCol) <= plateauHalf) ? plateauSurf : heightAt(c);
  const crustMat = (biome, r, s) => biome === 'desert' ? MAT.SAND : biome === 'snow' ? (r === s ? MAT.SNOW : MAT.EARTH) : biome === 'swamp' ? MAT.MUD : biome === 'volcanic' ? MAT.STONE : MAT.EARTH;
  // ---- 1. Solid fill: biome crust over a depth-layered underground (dirt → stone+veins → deep) ----
  for (let c = 0; c < TERRAIN_COLS; c++) {
    if (!inBand(c)) continue;
    const sB = (Math.abs(c - centerCol) <= plateauHalf) ? 'plains' : surfBiome(c);
    const uB = ugBiome(c);
    const s = surf[c];
    const dirtBot = s + CRUST + 8 + ((rng() * 5) | 0);                 // bottom of the loose-dirt band
    const deepTop = bottomRow - 14 - ((rng() * 6) | 0);               // top of the deep band
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
  for (let c = 0; c < TERRAIN_COLS; c++) {
    if (!inBand(c)) continue;
    const top = surf[c] + CRUST + 1;
    for (let r = top; r <= bottomRow; r++) {
      const i = r * TERRAIN_COLS + c; if (!grid[i]) continue;
      const depth = (r - top) / Math.max(1, bottomRow - top);
      const worm = Math.abs(Math.sin(c * 0.06 + r * 0.033 + cp0) + Math.sin(c * 0.025 - r * 0.052 + cp1) + Math.sin((c + r) * 0.041 + cp2));
      const chamber = Math.sin(c * 0.018 + r * 0.022 + cp3) + Math.sin(c * 0.034 - r * 0.013 + cp4);   // rare small pockets
      if (worm < 0.24 + depth * 0.12 || chamber > 1.86 - depth * 0.26) { grid[i] = 0; hp[i] = 0; }     // narrow tunnels + occasional pocket
    }
  }
  // ---- 3a. Surface lakes: flood valley air below sea level with Water ----
  for (let c = 0; c < TERRAIN_COLS; c++) if (inBand(c) && surf[c] > seaRow) for (let r = seaRow; r < surf[c]; r++) set(c, r, MAT.WATER);
  // ---- 3b. Cave pools: shallow fluid resting on cave floors. ONE liquid per underground region (no random
  // mixing) so each area reads coherently — molten→Lava, sandstone→Quicksand, fungal→Brine, everywhere
  // else→Water. Patchy along the width via a wet field; molten always seeps at the very bottom. ----
  const wp = rng() * Math.PI * 2, wp2 = rng() * Math.PI * 2, POOL_DEPTH = 4;
  const regionFluid = { molten: MAT.LAVA, sandstone: MAT.QUICKSAND, fungal: MAT.BRINE, frozen: MAT.WATER, crystal: MAT.WATER, caverns: MAT.WATER };
  for (let c = 0; c < TERRAIN_COLS; c++) {
    if (!inBand(c)) continue;
    const uB = ugBiome(c);
    const fluid = regionFluid[uB] || MAT.WATER;
    const wet = Math.sin(c * 0.02 + wp) + 0.5 * Math.sin(c * 0.061 + wp2);
    const wetOK = uB === 'molten' ? true : wet > 0.25;                 // molten always seeps; others patchy
    const tableRow = uB === 'molten' ? bottomRow - 10 : surf[c] + CRUST + 14;   // no cave pools too near the surface
    if (!wetOK) continue;
    for (let r = bottomRow; r >= tableRow;) {
      if (grid[r * TERRAIN_COLS + c] !== 0) { r--; continue; }         // solid — skip
      if (at(c, r + 1) === 0 && r < bottomRow) { r--; continue; }      // open with no floor below — air, skip
      let d = 0;                                                       // fill a shallow pool up from the floor
      while (r >= tableRow && grid[r * TERRAIN_COLS + c] === 0 && d < POOL_DEPTH) { set(c, r, fluid); r--; d++; }
      while (r >= 0 && grid[r * TERRAIN_COLS + c] === 0) r--;          // skip the air gap above until the next solid
    }
  }
  // ---- 4. Objects ('world'-owned, FIFO-exempt): surface trees/rocks + sky platforms, then underground scatter ----
  if (!roomObjects[avatarRoom]) roomObjects[avatarRoom] = new Map();
  const objs = roomObjects[avatarRoom];
  const OBJ_CAP = 190;
  const clearX0 = MWSim.C.WORLD_W / 2 - SPAWN_CLEAR_HALF_W - 64, clearX1 = MWSim.C.WORLD_W / 2 + SPAWN_CLEAR_HALF_W + 64;
  const dryLand = (c) => surf[c] <= seaRow && !!grid[surf[c] * TERRAIN_COLS + c];   // solid, non-flooded surface
  const outsideSpawn = (wx) => wx < clearX0 || wx > clearX1;
  const treeFor = { plains: '🌳', forest: '🌲', desert: '🌵', snow: '🌲', swamp: '🌿', volcanic: '🪨' };
  let wn = 0;
  const addObj = (o) => { if (wn >= OBJ_CAP) return false; o.id = 'world-' + wn; o.ownerId = 'world'; o.owner = 'world'; objs.set(o.id, o); wn++; return true; };
  for (let c = Math.max(8, genC0); c < Math.min(TERRAIN_COLS - 8, genC1); c += 6) {   // surface rock mounds (terrain)
    if (rng() > 0.10 || !dryLand(c) || !outsideSpawn((c + 0.5) * TERRAIN_CELL)) continue;
    const hgt = 1 + (rng() * 2 | 0);
    for (let k = 0; k < hgt; k++) { set(c, surf[c] - 1 - k, MAT.STONE); if (rng() > 0.5) set(c + 1, surf[c + 1] - 1 - k, MAT.STONE); }
  }
  for (let c = Math.max(5, genC0); c < Math.min(TERRAIN_COLS - 5, genC1); c += 4) {   // surface trees (narrow solid stamps)
    if (rng() > 0.16 || !dryLand(c) || !outsideSpawn((c + 0.5) * TERRAIN_CELL)) continue;
    const h = 58 + (rng() * 28 | 0), w = Math.round(h * 0.5);
    addObj({ type: 'stamp', x: (c + 0.5) * TERRAIN_CELL, y: surf[c] * TERRAIN_CELL - h / 2,
      content: treeFor[surfBiome(c)] || '🌳', w, h, shape: 'rect', angle: 0, stretch: false, hp: 3 });
  }
  const platLo = Math.max(10, genC0), platHi = Math.min(TERRAIN_COLS - 10, genC1);   // sky platforms (indestructible) for traversal
  const plats = platHi > platLo ? 8 + (rng() * 6 | 0) : 0;
  for (let k = 0; k < plats; k++) {
    const c = platLo + (rng() * (platHi - platLo) | 0), wx = (c + 0.5) * TERRAIN_CELL;
    const y = surf[c] * TERRAIN_CELL - (90 + rng() * 240);
    if (!outsideSpawn(wx) || y < TERRAIN_CELL * 3) continue;
    addObj({ type: 'platform', x: wx, y, w: 110 + (rng() * 120 | 0), h: 16, angle: 0, spin: 0, boost: 0, updraft: 0, fanLen: 1, fanMode: 'push', fanPeriod: 2, hp: null });
  }
  // Underground scatter: props + the occasional bouncy fungus/crystal platform, resting on cave floors.
  const cryFor = { frozen: '❄️', crystal: '💎', fungal: '🍄', sandstone: '🪨', caverns: '💧', molten: '' };
  for (let c = Math.max(4, genC0); c < Math.min(TERRAIN_COLS - 4, genC1); c += 3) {
    if (wn >= OBJ_CAP) break;
    const uB = ugBiome(c);
    for (let r = surf[c] + CRUST + 6; r <= bottomRow - 1; r++) {
      const here = grid[r * TERRAIN_COLS + c], below = at(c, r + 1);
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
  generateWorld(avatarRoom, worldSeedFor(roomId), genColBand(roomId, levelIndex));
  seedLiquidActivity(avatarRoom);                    // give generated liquid its fill levels, then…
  liquidQuiet = true;                                // …pre-settle it silently so joiners see it already at rest (no on-load sloshing / broadcast storm)
  // Droplets must fly during the pre-settle too, or gen-time ledge spills leave mass airborne that suddenly rains down
  // the moment the first player arrives. The loop also has to keep going while droplets are still in the air, since a
  // room can have zero ACTIVE CELLS while all its moving liquid is mid-fall.
  for (let s = 0; s < 3000; s++) {
    const act = roomLiquidActive[avatarRoom], air = roomDroplets[avatarRoom];
    if (!(act && act.size) && !(air && air.length)) break;
    liquidTickCount++;
    if (liquidCfg.droplets) dropletTickRoom(avatarRoom);
    liquidTickRoom(avatarRoom);
  }
  // Anything still airborne after the cap is put back into the grid where it is, rather than being left to fall on the
  // first joiner. Deposits downward from its own cell so it lands somewhere it could actually have reached.
  const air = roomDroplets[avatarRoom];
  if (air && air.length) {
    const amt = ensureLiquidAmt(avatarRoom), tot = ensureLiquidTotal(avatarRoom), grid = roomTerrain[avatarRoom];
    const FLOOR_ROW = Math.min(TERRAIN_ROWS, Math.floor(FLOOR_TOP / TERRAIN_CELL));
    for (const d of air) {
      let rem = d.amt, cc = Math.floor(d.x / TERRAIN_CELL), rr = Math.floor(d.y / TERRAIN_CELL);
      if (cc < 0 || cc >= TERRAIN_COLS) continue;
      for (; rr < FLOOR_ROW && rem > 0; rr++) {
        const ci = rr * TERRAIN_COLS + cc;
        if (isSolidCell(grid[ci])) break;
        const free = LIQUID_MAX - tot[ci];
        if (free >= 1) { const take = Math.min(free, rem); amt[ci * LIQ_T + d.rank] += take; tot[ci] += take; rem -= take; activateLiquidCell(avatarRoom, ci, grid); }
      }
    }
    roomDroplets[avatarRoom] = [];
  }
  roomDropSpawns[avatarRoom] = [];                   // gen-time spawns are never broadcast — the world starts at rest
  liquidQuiet = false;
  // Do NOT hard-freeze the active set. If the liquid fully settled, liquidTickRoom already cleared it. If a big field is
  // still leveling after the cap, leave it ACTIVE so the live sim finishes the job (broadcasting diffs) — the old
  // unconditional freeze left non-level pools + frozen mid-air stream slivers that never resolved once cut off mid-settle.
}
// Spawn point = world-centre column resting on the terrain SURFACE there (so a generated world
// drops you on top of the ground, not buried in it). Falls back to the floor when that column is
// empty (sandbox / un-generated). y is the feet position (top of the first solid cell).
function worldSpawnFor(avatarRoom) {
  const x = MWSim.C.WORLD_W / 2;
  const grid = roomTerrain[avatarRoom];
  if (!grid) return { x, y: FLOOR_TOP };
  const col = Math.max(0, Math.min(TERRAIN_COLS - 1, Math.floor(x / TERRAIN_CELL)));
  for (let r = 0; r < TERRAIN_ROWS; r++) if (grid[r * TERRAIN_COLS + col]) return { x, y: r * TERRAIN_CELL };
  return { x, y: FLOOR_TOP };
}
// Keep-clear no-build box above the spawn surface — world mode only (sandbox has no protection).
function spawnClearRect(avatarRoom) {
  if (!worldGenerated.has(avatarRoom)) return null;
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
  const runs = []; let v = grid[0], n = 0;
  for (let i = 0; i < grid.length; i++) { if (grid[i] === v) n++; else { runs.push([v, n]); v = grid[i]; n = 1; } }
  runs.push([v, n]);
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
  if ((terr.cols | 0) !== TERRAIN_COLS || (terr.rows | 0) !== TERRAIN_ROWS) return;   // foreign world size — skip
  const mats = ensureMats(avRoom);
  if (blob.mats && typeof blob.mats === 'object') {
    for (const k in blob.mats) { const d = sanitizeMatDef(blob.mats[k]); if (d) mats[k] = d; }
  }
  const grid = ensureTerrain(avRoom), hp = ensureTerrainHp(avRoom);
  grid.fill(0); hp.fill(0);
  let i = 0;
  for (const run of terr.runs || []) {
    const v = run[0] | 0, n = run[1] | 0;
    for (let k = 0; k < n && i < grid.length; k++, i++) { if (v) { grid[i] = v; hp[i] = matStrengthSrv(mats, v); } }
  }
  if (Array.isArray(terr.hpRuns)) {                       // preserve partial damage where present
    let j = 0;
    for (const run of terr.hpRuns) { const val = run[0] | 0, n = run[1] | 0; for (let k = 0; k < n && j < hp.length; k++, j++) if (grid[j] && val) hp[j] = val; }
  }
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
function captureRoomBlob(avRoom) {                      // → a Lvl blob (terrain RLE + used mats + objects), or null if empty
  const grid = roomTerrain[avRoom], objs = roomObjects[avRoom];
  const hasTerr = grid && grid.some(v => v), hasObj = objs && objs.size;
  if (!hasTerr && !hasObj) return null;
  const g = grid || ensureTerrain(avRoom);
  const mats = {}, mm = roomMats[avRoom] || {};
  if (hasTerr) { const used = new Set(); for (let i = 0; i < g.length; i++) { const v = g[i]; if (v >= CUSTOM_MAT_MIN) used.add(v); } for (const v of used) if (mm[v]) mats[v] = mm[v]; }
  return {
    terrain: { cols: TERRAIN_COLS, rows: TERRAIN_ROWS, cell: TERRAIN_CELL, runs: terrainRLE(g).runs, hpRuns: roomTerrainHp[avRoom] ? terrainRLE(roomTerrainHp[avRoom]).runs : undefined },
    mats,
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
  socket.emit('liquid-cfg', liquidCfg);                     // send current state so a joining client's menu reflects it
  socket.on('liquid-cfg-get', () => socket.emit('liquid-cfg', liquidCfg));
  // DEBUG single-step: advance the frozen sim by a few ticks. Only meaningful while paused; ignored otherwise, so a
  // stray press can never make the sim run fast.
  // DEBUG resync: re-send this socket the FULL liquid state for the room it is in. The client compares it against its
  // own mirror before applying, which settles "is that liquid really there, or has my copy drifted?" in one press --
  // a question that has cost a lot of guessing, because the client's droplet replay lands on the client's mirror, so
  // a stale cell there produces BOTH phantom liquid and droplets that stop early on it.
  socket.on('liquid-resync', () => {
    const room = currentAvatarRoom;
    if (!room || !roomTerrain[room] || !roomLiquidTotal[room]) return;
    socket.emit('liquid-init', { cells: buildLiquidInit(room), verify: true });
    if (liquidCfg.sub > 1) { const fi = buildFineInit(room); if (fi) socket.emit('liquid-fine-init', fi); }
  });
  // ---- LIQUID SOURCES: mark/unmark cells that keep refilling themselves. Sent by the build menu's "Source" option
  // when a liquid is painted; the same cells are sent with on:false when the option is OFF, so painting normally over
  // a source removes it. Rebroadcast so every client can draw the marker.
  socket.on('liquid-src', ({ cells, id, on, rate }) => {
    const room = currentAvatarRoom;
    if (!room || !Array.isArray(cells) || cells.length > 4096) return;
    if (!canBuild()) return;
    const grid = roomTerrain[room]; if (!grid) return;
    const rank = LIQ_RANK[id | 0];
    if (on && rank === undefined) return;                    // sources are built-in liquids only (custom liquids have no rank)
    const rt = rate === undefined ? undefined : Math.max(0, Math.min(64, rate | 0));
    const src = ensureSrcMap(room);
    const okCells = [];
    for (const raw of cells) {
      const i = raw | 0; if (i < 0 || i >= grid.length) continue;
      if (on) { if (isSolidCell(grid[i])) continue; src.set(i, { rank, rate: rt }); } else if (!src.delete(i)) continue;
      okCells.push(i);
    }
    if (!src.size) delete roomLiquidSrc[room];
    if (okCells.length) io.to(room).emit('liquid-src', { cells: okCells, on: !!on });
  });
  // Remove every source in the room at once. A source is invisible in the terrain data, so without this a stray one
  // left running in a corner of a big world is genuinely hard to find and turn off.
  socket.on('liquid-src-clear', () => {
    const room = currentAvatarRoom;
    if (!room || !canBuild()) return;
    const src = roomLiquidSrc[room];
    if (!src || !src.size) return;
    const cells = Array.from(src.keys());
    clearLiquidSources(room); delete roomLiquidSrc[room];
    io.to(room).emit('liquid-src', { cells, on: false });
  });
  socket.on('liquid-step', (n) => {
    if (!liquidCfg.paused) return;
    const k = Math.max(1, Math.min(120, (n | 0) || 1));
    liquidStepsPending += k;
    io.emit('liquid-stepped', k);   // clients replay the droplet fall locally, so they must step it too
  });
  socket.on('liquid-cfg', (patch) => {
    if (!patch || typeof patch !== 'object') return;
    for (const k of ['densitySort', 'ledgeSpill', 'lateralLevel', 'perLiquidLevel', 'viscosity', 'reactions', 'streamTag', 'streamMix', 'streamNoSort', 'streamNoSortNbr', 'streamFullClear', 'symLevel', 'levelMix', 'perfLog', 'fluxLevel', 'droplets', 'dropWeir', 'dropStratify', 'dropSpreadFlow', 'dropSpreadWide', 'dropEdgeFill', 'paused', 'fineLedge']) if (k in patch) liquidCfg[k] = !!patch[k];
    if ('levelGate' in patch) liquidCfg.levelGate = Math.max(0, Math.min(3, patch.levelGate | 0));
    if ('sortRate' in patch) liquidCfg.sortRate = Math.max(1, Math.min(32, patch.sortRate | 0));
    // CELL CAPACITY (vertical slices). Rescale existing liquid, then re-broadcast so client mirrors match the new scale.
    if ('cellCap' in patch) { const nv = Math.max(8, Math.min(255, patch.cellCap | 0)); if (nv !== LIQUID_MAX) { rescaleAllLiquid(nv); LIQUID_MAX = nv; liquidCfg.cellCap = nv;
      for (const room in roomLiquidTotal) io.to(room).emit('liquid-init', { cells: buildLiquidInit(room) });
      if (liquidCfg.sub > 1) for (const room in roomFineTotal) { const fi = buildFineInit(room); if (fi) io.to(room).emit('liquid-fine-init', fi); }
    } }
    // FINE-CELL resolution toggle. On change, CONVERT every room's liquid between the coarse and fine grids and push a
    // fresh init so the picture carries over. sub ∈ {1,3} for now (1 = coarse untouched, 3 = fine 3×3).
    if ('sub' in patch) { const nv = (patch.sub | 0) === 3 ? 3 : 1; if (nv !== liquidCfg.sub) { const old = liquidCfg.sub; liquidCfg.sub = nv;
      if (nv > 1) { for (const room in roomLiquidTotal) { upscaleRoomToFine(room, nv); const fi = buildFineInit(room); if (fi) io.to(room).emit('liquid-fine-init', fi); } }
      else { for (const room in roomFineTotal) { downscaleRoomToCoarse(room, old); io.to(room).emit('liquid-init', { cells: buildLiquidInit(room) }); io.to(room).emit('liquid-fine-init', { sub: 1, cols: TERRAIN_COLS, cells: [] }); } }
    } }
    // droplet-cascade tunings (numeric); clamped so a bad value can't wedge the sim
    const dnum = { dropUnit: [1, 16], dropFall: [0.05, 4], dropSpawnH: [0, 1], dropSpread: [0.1, 1], dropColSpace: [0, 4],
                   dropLandSpread: [0, 5], dropTermFall: [1, 16], dropSpreadRef: [2, 40], dropImpactCurve: [0.2, 3] };
    for (const k in dnum) if (k in patch) { const v = +patch[k]; if (!isNaN(v)) liquidCfg[k] = Math.max(dnum[k][0], Math.min(dnum[k][1], v)); }
    if ('fluxRate' in patch) liquidCfg.fluxRate = Math.max(1, Math.min(128, patch.fluxRate | 0));
    if ('srcRate' in patch) liquidCfg.srcRate = Math.max(0, Math.min(64, patch.srcRate | 0));
    if ('sinkRate' in patch) liquidCfg.sinkRate = Math.max(0, Math.min(64, patch.sinkRate | 0));
    if ('tickMs' in patch) { const v = Math.max(8, Math.min(500, patch.tickMs | 0)); if (v !== liquidCfg.tickMs) { liquidCfg.tickMs = v; restartLiquidLoop(); } }
    io.emit('liquid-cfg', liquidCfg);                       // broadcast (config is global) so every open menu stays in sync
  });
  let currentAvatarRoom = null;   // this socket's active avatar-world room key (URL + mode); set on avt-join
  let currentAvBuildRoomId = null; // Phase 3: real roomId for L2 build-perm checks (null = page/URL room → open build)
  let currentAvOwnerId = null;     // owner_id of that room (null for the page/URL room)
  let currentAvLevelIndex = 0;     // this socket's current Level index within the room's World (for per-Level locks)
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
    s.respawnX = Math.max(0, Math.min(MWSim.C.WORLD_W, x));
    s.respawnY = Math.max(0, Math.min(MWSim.C.WORLD_H, y));
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
    const avRoom = avatarRoomKey(roomId, levelIndex);
    // Duplicate-instance guard: if THIS identity is already live in this avatar World from another tab/window,
    // don't silently spawn a second blob. Ask the joiner to confirm a takeover (avt-dup); they re-send with
    // force:true, and we evict the other instance(s) here. (No-op at the common single-instance case.)
    const dupSockets = sameUserAvSockets(avRoom, socket.id);
    if (dupSockets.length && !(data && data.force)) { socket.emit('avt-dup', { levelIndex }); return; }
    if (dupSockets.length) {
      for (const other of dupSockets) {
        if (roomAvt[avRoom] && roomAvt[avRoom].delete(other)) socket.to(avRoom).emit('avt-peer-left', { id: other });
        if (socketToAvatarRoom[other] === avRoom) delete socketToAvatarRoom[other];
        try { io.sockets.sockets.get(other)?.leave(avRoom); } catch {}
        io.to(other).emit('avt-evicted', { levelIndex });
      }
    }
    currentAvLevelIndex = levelIndex;                              // Phase 3: per-Level build lock keys on this
    currentAvBand = playBand(roomId, levelIndex);                  // Phase 6: clamp this socket's object placement to the Level's band
    // Leave any previous avatar room (Level switch without an explicit avt-leave).
    if (currentAvatarRoom && currentAvatarRoom !== avRoom) {
      socket.leave(currentAvatarRoom);
      if (roomAvt[currentAvatarRoom] && roomAvt[currentAvatarRoom].delete(socket.id)) socket.to(currentAvatarRoom).emit('avt-peer-left', { id: socket.id });
    }
    currentAvatarRoom = avRoom;
    socketToAvatarRoom[socket.id] = avRoom;
    socket.join(avRoom);
    if (type === 'world') ensureWorldGenerated(avRoom, roomId, levelIndex);   // seed keyed by roomId (=URL for the default room → identical worlds), once per server lifetime; band from the Level's size preset
    maybeHydratePublished(avRoom, roomId, levelIndex);   // Phase 7b: server-load a published World's content (no host needed); runs before the replay below
    if (!roomAvt[avRoom]) roomAvt[avRoom] = new Set();
    const existingPeers = [...roomAvt[avRoom]];
    roomAvt[avRoom].add(socket.id);
    socket.emit('avt-joined', { existingPeers, mode: type, levelIndex, spawn: (type === 'world') ? worldSpawnFor(avRoom) : null });
    // Replay the current world objects to the new joiner (late-joiner sync). `levelIndex` lets the client
    // drop a replay that arrives AFTER it has switched Levels again (rapid switching → stale cross-Level bleed).
    socket.emit('avatar-objects-init', { levelIndex, objects: roomObjects[avRoom] ? [...roomObjects[avRoom].values()] : [] });
    // Replay the terrain grid (RLE) — present for any 'world' room and any 'sandbox' room with placed terrain.
    const tg = roomTerrain[avRoom];
    if (tg) socket.emit('terrain-init', { levelIndex, cell: TERRAIN_CELL, cols: TERRAIN_COLS, rows: TERRAIN_ROWS, ...terrainRLE(tg), hpRuns: roomTerrainHp[avRoom] ? terrainRLE(roomTerrainHp[avRoom]).runs : undefined });
    // Replay the multi-liquid stacks (layers per cell) so the joiner renders partial pools + composition correctly.
    if (tg && roomLiquidTotal[avRoom]) { const cells = buildLiquidInit(avRoom); if (cells.length) socket.emit('liquid-init', { levelIndex, cells }); }
    if (tg && liquidCfg.sub > 1) { const fi = buildFineInit(avRoom); if (fi && fi.cells.length) socket.emit('liquid-fine-init', fi); }
    if (roomLiquidSrc[avRoom] && roomLiquidSrc[avRoom].size) socket.emit('liquid-src', { cells: Array.from(roomLiquidSrc[avRoom].keys()), on: true, init: true });   // join replay: which cells are sources (marker only; the sim owns the behaviour)
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
    delete socketToAvatarRoom[socket.id];
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
    if (roomTerrain[currentAvatarRoom]) { roomTerrain[currentAvatarRoom].fill(0); if (roomTerrainHp[currentAvatarRoom]) roomTerrainHp[currentAvatarRoom].fill(0); delete roomLiquidActive[currentAvatarRoom]; delete roomPowderActive[currentAvatarRoom]; if (roomLiquidAmt[currentAvatarRoom]) roomLiquidAmt[currentAvatarRoom].fill(0); if (roomLiquidTotal[currentAvatarRoom]) roomLiquidTotal[currentAvatarRoom].fill(0); if (roomLiquidSide[currentAvatarRoom]) roomLiquidSide[currentAvatarRoom].fill(0); if (roomStream2Amt[currentAvatarRoom]) roomStream2Amt[currentAvatarRoom].fill(0); if (roomStream2Id[currentAvatarRoom]) roomStream2Id[currentAvatarRoom].fill(0); clearDroplets(currentAvatarRoom); clearLiquidSources(currentAvatarRoom); io.to(currentAvatarRoom).emit("terrain-cleared"); }
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
    if (roomTerrain[currentAvatarRoom]) { roomTerrain[currentAvatarRoom].fill(0); if (roomTerrainHp[currentAvatarRoom]) roomTerrainHp[currentAvatarRoom].fill(0); delete roomLiquidActive[currentAvatarRoom]; delete roomPowderActive[currentAvatarRoom]; if (roomLiquidAmt[currentAvatarRoom]) roomLiquidAmt[currentAvatarRoom].fill(0); if (roomLiquidTotal[currentAvatarRoom]) roomLiquidTotal[currentAvatarRoom].fill(0); if (roomLiquidSide[currentAvatarRoom]) roomLiquidSide[currentAvatarRoom].fill(0); if (roomStream2Amt[currentAvatarRoom]) roomStream2Amt[currentAvatarRoom].fill(0); if (roomStream2Id[currentAvatarRoom]) roomStream2Id[currentAvatarRoom].fill(0); clearDroplets(currentAvatarRoom); clearLiquidSources(currentAvatarRoom); io.to(currentAvatarRoom).emit("terrain-cleared"); }
  });
  // Damage a destructible object (client-authoritative hit). Decrement hp; broadcast the new
  // hp, or remove it at 0. Server owns hp so concurrent hits can't double-count past zero.
  // Destructible terrain: paint/carve a circle into the room grid, then rebroadcast the op so every
  // client rasterizes it identically (client also applies optimistically). Only echoes on a real change.
  socket.on('terrain-edit', ({ op, x, y, r, mat, shape, hard }) => {
    if (!currentAvatarRoom || (op !== 'paint' && op !== 'carve')) return;
    if (!canBuild()) return;                                // Phase 3: L2 build permission
    if (!isFinite(x) || !isFinite(y) || !isFinite(r)) return;
    const cx = Math.max(0, Math.min(MWSim.C.WORLD_W, x)), cy = Math.max(0, Math.min(MWSim.C.WORLD_H, y));
    const rr = Math.max(8, Math.min(160, r));
    const m = (op === 'paint') ? (Math.min(TERRAIN_MAT_HI, Math.max(1, mat | 0)) || 1) : 0;  // material id 1..255 (carve = 0)
    const sq = shape === 'square';
    const hd = op === 'carve' && !!hard;                 // editor Carve tool: hard delete (any block); gameplay slam stays soft
    if (op === 'paint' && aabbHitsClear(spawnClearRect(currentAvatarRoom), cx - rr, cy - rr, cx + rr, cy + rr)) return; // no building on the spawn (world mode)
    const grid = ensureTerrain(currentAvatarRoom), hp = ensureTerrainHp(currentAvatarRoom), mats = roomMats[currentAvatarRoom] || {};
    // The sender already applied this op optimistically, so echo to OTHERS only — carve = hp decrement is
    // NOT idempotent, double-applying would desync the sender's per-cell hp from everyone else's.
    if ((sq ? rasterTerrainSquare : rasterTerrainCircle)(grid, hp, mats, cx, cy, rr, m, hd)) {
      // Wake any liquid in/around the edit so it flows into the freed space (dig-out) or spreads (poured).
      activateLiquidRect(currentAvatarRoom, grid, Math.floor((cx - rr) / TERRAIN_CELL) - 1, Math.floor((cy - rr) / TERRAIN_CELL) - 1, Math.floor((cx + rr) / TERRAIN_CELL) + 1, Math.floor((cy + rr) / TERRAIN_CELL) + 1);
      activatePowderRect(currentAvatarRoom, grid, Math.floor((cx - rr) / TERRAIN_CELL) - 1, Math.floor((cy - rr) / TERRAIN_CELL) - 1, Math.floor((cx + rr) / TERRAIN_CELL) + 1, Math.floor((cy + rr) / TERRAIN_CELL) + 1);   // dig removes support / paint drops grains
      socket.to(currentAvatarRoom).emit('terrain-edited', { op, x: cx, y: cy, r: rr, mat: m, shape: sq ? 'square' : undefined, hard: hd });
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
    const clear = spawnClearRect(currentAvatarRoom);     // null in sandbox; clamps any spawn-box fill back to empty (kept consistent on rebroadcast)
    let changed = false;
    for (let k = 0; k + 1 < cells.length; k += 2) {
      const i = cells[k] | 0;
      let v = Math.max(0, Math.min(TERRAIN_MAT_HI, cells[k + 1] | 0));
      if (v && clear) {
        const cc = (i % TERRAIN_COLS + 0.5) * TERRAIN_CELL, cr = (Math.floor(i / TERRAIN_COLS) + 0.5) * TERRAIN_CELL;
        if (aabbHitsClear(clear, cc, cr, cc, cr)) { v = 0; cells[k + 1] = 0; }
      }
      if (i >= 0 && i < grid.length) { if (grid[i] !== v) { grid[i] = v; changed = true; } hp[i] = v ? matStrengthSrv(mats, v) : 0; }
      // Same rule for an explicit cell write (undo / paste / a test scene): anything that is no longer the liquid it
      // was drops its source flag. Only a cell that stays a liquid keeps refilling.
      if (!isFluidId(v)) dropSource(currentAvatarRoom, i);
    }
    const tot = ensureLiquidTotal(currentAvatarRoom), lam = ensureLiquidAmt(currentAvatarRoom);    // keep the multi-liquid stacks in step with placed/cleared cells, then wake
    for (let k = 0; k + 1 < cells.length; k += 2) {
      const i = cells[k] | 0; if (i < 0 || i >= grid.length) continue;
      if (isFluidId(grid[i])) { if (!tot[i] || liqRepId(lam, i) !== grid[i]) liqSetSingle(currentAvatarRoom, i, grid[i]); activateLiquidCell(currentAvatarRoom, i, grid); } else liqClearCell(currentAvatarRoom, i);
      const up = i - TERRAIN_COLS; if (up >= 0 && isFluidId(grid[up])) activateLiquidCell(currentAvatarRoom, up, grid);
      if (isPowderId(grid[i])) powderSet(currentAvatarRoom).add(i); if (up >= 0 && isPowderId(grid[up])) powderSet(currentAvatarRoom).add(up);   // placed/undone powder + grains above a cleared cell may fall
    }
    if (changed) io.to(currentAvatarRoom).emit('terrain-set', { cells });
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
    for (let i = CUSTOM_MAT_MIN; i <= TERRAIN_MAT_HI; i++) if (!mats[i]) { id = i; break; }
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

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
